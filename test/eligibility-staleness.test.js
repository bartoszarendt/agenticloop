import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createDispatchFixture,
  filesScanInventory,
  prepare,
  sha256,
} from './helpers/dispatch-fixture.js';
import { git } from './helpers/git-fixture.js';
import {
  createTaskInventoryEnumeration,
  normalizeFilesTaskInventory,
  validateParallelScanInventoryBinding,
} from '../src/parallel-scan.js';
import { taskContractDigest } from '../src/task-contract-baseline.js';

let temp;

beforeEach(() => { temp = mkdtempSync(join(tmpdir(), 'elig-stale-')); });
afterEach(() => { rmSync(temp, { recursive: true, force: true }); });

/**
 * Build a modified inventory that has the same membership but different
 * carrier content for the dispatched task.
 */
function modifiedInventory(fixture, modifiedBody, taskId = 'T-001') {
  const entries = [{ carrier: `.agenticloop/tasks/${taskId}.md`, content: modifiedBody, readError: null }];
  return filesScanInventory('files:.agenticloop/tasks', entries);
}

describe('eligibility-aware inventory staleness', () => {
  it('A4.1: prose-only carrier drift does not stale dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'prose-drift');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');

    // Append prose that does NOT touch frontmatter contract fields.
    const proseAppend = '\n\n## Comments\n\nReviewed by human on 2026-08-15. No issues found.\n';
    const modifiedBody = originalBody + proseAppend;

    // Verify contract digest is unchanged.
    const originalContract = taskContractDigest(originalBody);
    const modifiedContract = taskContractDigest(modifiedBody);
    assert.equal(originalContract.ok, true);
    assert.equal(modifiedContract.ok, true);
    assert.equal(originalContract.digest, modifiedContract.digest, 'contract digest must be unchanged for prose-only edit');

    // Build a modified inventory with the prose-appended body but same membership.
    const currentInventory = modifiedInventory(fixture, modifiedBody);

    const prepared = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, true, `dispatch must succeed for prose-only drift: ${prepared.validation?.errors?.join('; ')}`);

    // The packet's task carrier digest comes from the refetched snapshot (original
    // file on disk), not from the inventory override. The dispatch succeeds
    // because the eligibility projection matched despite the carrier-byte drift.
    const originalCarrierDigest = sha256(originalBody);
    assert.equal(prepared.packet.task.dispatchCarrierDigest, originalCarrierDigest);
  });

  it('A4.2: status change still fails dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'status-drift');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');

    // Change status from agent-ready to in-progress.
    const modifiedBody = originalBody.replace('status: agent-ready', 'status: in-progress');
    assert.notEqual(modifiedBody, originalBody, 'status replacement must succeed');

    const currentInventory = modifiedInventory(fixture, modifiedBody);

    const prepared = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, false, 'dispatch must fail for status change');
    const errorText = prepared.validation?.errors?.join('; ') ?? '';
    assert.match(errorText, /eligibility|stale|carrier drift/i, `error must mention eligibility or stale: ${errorText}`);
  });

  it('A4.3: scope change still fails dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'scope-drift');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');

    // Change allowed_paths. This changes the contract digest.
    const modifiedBody = originalBody.replace('  - src/**', '  - src/**\n  - lib/**');

    const currentInventory = modifiedInventory(fixture, modifiedBody);

    const prepared = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, false, 'dispatch must fail for scope change');
    const errorText = prepared.validation?.errors?.join('; ') ?? '';
    assert.match(errorText, /eligibility|stale|carrier drift/i, `error must mention eligibility or stale: ${errorText}`);
  });

  it('A4.4: membership change still fails dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'membership-drift');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');

    // Add a new task to the inventory (membership change).
    const body2 = readFileSync(join(fixture.root, 'agenticloop', 'memory', 'task-record.md'), 'utf8')
      .replaceAll('T-001', 'T-002')
      .replace('allowed_paths: []', 'allowed_paths:\n  - lib/**');
    const currentInventory = normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries: [
        { carrier: '.agenticloop/tasks/T-001.md', content: originalBody, readError: null },
        { carrier: '.agenticloop/tasks/T-002.md', content: body2, readError: null },
      ],
      complete: true,
    });

    const prepared = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, false, 'dispatch must fail for membership change');
    const errorText = prepared.validation?.errors?.join('; ') ?? '';
    assert.match(errorText, /membership/i, `error must mention membership: ${errorText}`);
  });

  it('A4.5: no-recheck callers are unchanged (drift still fails)', () => {
    const scan = {
      workUnit: { id: 'test-wu', backend: 'files' },
      inventory: {
        id: 'files:tasks',
        complete: true,
        enumeration: null,
        memberCount: 1,
        members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, revision: null, state: 'readable', transport: null }],
        digest: `sha256:agenticloop.parallel-scan.v2:${'a'.repeat(64)}`,
      },
      eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: null, declaredDependencies: [] }],
    };
    const currentInventory = normalizeFilesTaskInventory({
      inventoryId: 'files:tasks',
      entries: [{ carrier: '.agenticloop/tasks/T-001.md', content: 'different content', readError: null }],
      complete: true,
    });

    const result = validateParallelScanInventoryBinding(scan, currentInventory);
    assert.equal(result.ok, false, 'without recheck, carrier drift must fail');
    assert.ok(result.errors.some(e => e.includes('digest changed')), 'error must mention digest change');
    assert.equal(result.proseDriftAccepted, false);
  });
});

describe('F5: old-shape eligibility entries fail closed', () => {
  it('scan without declaredDependencies fails recheck', async () => {
    const fixture = await createDispatchFixture(temp, 'old-shape');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');
    const proseAppend = '\n\n## Comments\n\nReviewed by human.\n';
    const modifiedBody = originalBody + proseAppend;

    const decomposition = fixture.decomposition;
    const oldShapeScan = {
      ...decomposition.scan,
      eligibility: decomposition.scan.eligibility.map(e => ({
        taskId: e.taskId,
        eligibility: e.eligibility,
      })),
    };

    const currentInventory = modifiedInventory(fixture, modifiedBody);

    const result = validateParallelScanInventoryBinding(oldShapeScan, currentInventory, {
      eligibilityRecheck: {
        taskId: 'T-001',
        backend: 'files',
        currentContractDigest: taskContractDigest(originalBody).digest,
        runGit: fixture.runGit,
        baseEvidence: fixture.readiness.evidence.base,
        dependencyEvidence: fixture.readiness.evidence.dependencies,
      },
    });
    assert.equal(result.ok, false, 'old-shape scan must fail recheck');
    assert.ok(result.errors.some(e => e.includes('digest changed') || e.includes('carrier drift')),
      `error must mention digest or carrier drift: ${result.errors.join('; ')}`);
    assert.equal(result.proseDriftAccepted, false);
  });
});

describe('regression: material drift detection via re-derivation', () => {
  it('R1: dependency drift fails dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'dep-drift');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');

    const modifiedBody = originalBody.replace(
      'status: agent-ready',
      'status: agent-ready\ndepends_on:\n  - T-002'
    );
    assert.notEqual(modifiedBody, originalBody, 'depends_on insertion must succeed');

    const currentInventory = filesScanInventory('files:.agenticloop/tasks', [
      { carrier: '.agenticloop/tasks/T-001.md', content: modifiedBody, readError: null },
    ]);

    const prepared = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, false, 'dispatch must fail for dependency drift');
  });

  it('R2: sibling status drift fails dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'sibling-drift', { taskIds: ['T-001', 'T-002'] });
    const body1 = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');
    const body2 = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-002.md'), 'utf8');
    const modifiedBody2 = body2.replace('status: agent-ready', 'status: done');

    const currentInventory = filesScanInventory('files:.agenticloop/tasks', [
      { carrier: '.agenticloop/tasks/T-001.md', content: body1, readError: null },
      { carrier: '.agenticloop/tasks/T-002.md', content: modifiedBody2, readError: null },
    ]);

    const primary = fixture.taskFixtures.get('T-001');
    const prepared = prepare(primary, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, false, 'dispatch must fail for sibling status drift');
    const errorText = prepared.validation?.errors?.join('; ') ?? '';
    assert.match(errorText, /eligibility|stale|carrier drift/i,
      `error must mention drift: ${errorText}`);
  });

  it('R3: knowledge coupling drift fails dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'coupling-drift');
    const originalBody = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');

    const modifiedBody = originalBody.replace(
      '- Knowledge coupling: independent | coupled | unknown',
      '- **Knowledge coupling**: coupled'
    );
    assert.notEqual(modifiedBody, originalBody, 'coupling replacement must succeed');

    const currentInventory = modifiedInventory(fixture, modifiedBody);

    const prepared = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(prepared.ok, false, 'dispatch must fail for coupling drift');
  });
});
