/**
 * Handoff-preflight tests.
 *
 * Covers: positive path, typed evidence states, exact schema keys, distinct
 * carrier/contract digests, activation usability, disposition owner,
 * first-safe-repair command semantics, readiness/dependency, decomposition
 * dispatchability, capability/return-adapter, clean-state warnings, sibling
 * collision relevance, human/JSON parity, deterministic output, malformed
 * input, missing/unknown failures, and no mutation.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { evaluateHandoffPreflight } from '../src/handoff-preflight.js';
import { canonicalJson } from '../src/canonical-json.js';
import { createDispatchFixture } from './helpers/dispatch-fixture.js';
import { createTestHostTrust, protectedHostBoundary, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import { signHostPayload, hostTrustBoundarySignaturePayload, HOST_TRUST_BOUNDARY_RESPONSE_KIND, HOST_TRUST_BOUNDARY_SCHEMA_VERSION } from '../src/host-trust.js';
import { createDecompositionProvenance } from '../src/dispatch-envelope.js';
import { createTaskInventoryEnumeration, evaluateParallelScan, normalizeFilesTaskInventory } from '../src/parallel-scan.js';
import { parseDependencySnapshot, dependencyStatusMap } from '../src/task-evidence-contract.js';

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-preflight-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function activationDigest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  createTaskProjectFixture(target);
  return target;
}

function taskPath(target, taskId) {
  return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
}

function writeTask(target, taskId, { status = 'agent-ready', withActivation = false, malformed = false, depends_on = null, emptyScope = false } = {}) {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  if (malformed) {
    writeFileSync(taskPath(target, taskId), 'completely invalid content without frontmatter\n', 'utf8');
    return;
  }
  const activationLines = withActivation
    ? `activation_input_digest: ${activationDigest(taskId)}\nactivation_capture_ref: activation-grants/${taskId}.md\n`
    : '';
  const scopeLines = emptyScope
    ? 'allowed_paths: []\n'
    : 'allowed_paths:\n  - "src/**"\n  - "docs/**"\n';
  writeFileSync(taskPath(target, taskId), `---
task_id: ${taskId}
status: ${status}
backend: files
${scopeLines}intended_creations:
  - "src/output.txt"
${activationLines}${depends_on ? `depends_on:\n${depends_on.map(d => `  - "${d}"`).join('\n')}\n` : ''}task_contract_schema: 2
---

# ${taskId} - Test Task

## Task
Implement the feature.

## Source Documents Reviewed
- README.md

## Current State
Ready for implementation.

## Scope
src/** and docs/** only.

## Out of Scope
Everything else.

## Acceptance Criteria
- [ ] Feature works

## Expected Files or Areas
- src/output.txt

## Implementation Notes
Proceed incrementally.

## Required Checks
- [RC-1] command: \`npm test\`

## Completion Summary Template
- Summarize what changed and why.

## Reviewer Checklist
- [ ] Acceptance criteria are met.
`, 'utf8');

}

function makeDecompositionSource(target, taskId, { depSnapshot: depSnapshotOverride, depSourceRef: depSourceRefOverride } = {}) {
  const dir = join(target, '.agenticloop', 'decompositions');
  mkdirSync(dir, { recursive: true });
  const sourceRef = `.agenticloop/decompositions/${taskId}.json`;
  const depSourceRef = depSourceRefOverride ?? `.agenticloop/decompositions/${taskId}.dependencies.json`;
  const baseTree = spawnSyncOutput(target, ['rev-parse', 'HEAD^{tree}']);
  const observedAt = new Date().toISOString();

  const depSnapshot = depSnapshotOverride ?? {
    kind: 'agenticloop.dependency-snapshot',
    schemaVersion: 1,
    source: 'files:.agenticloop/tasks',
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    statuses: {},
  };
  const depSnapshotJson = canonicalJson(depSnapshot);
  writeFileSync(join(target, depSourceRef), `${depSnapshotJson}\n`, 'utf8');
  const parsedDep = parseDependencySnapshot(depSnapshotJson, { sourceRef: depSourceRef, now: Date.parse(observedAt) });
  if (!parsedDep.ok) throw new Error(`dep snapshot failed: ${parsedDep.errors.join('; ')}`);

  const taskBody = readFileSync(taskPath(target, taskId), 'utf8');
  const basePaths = spawnSyncOutput(target, ['ls-tree', '-r', '--name-only', baseTree])
    .split(/\r?\n/).filter(Boolean);
  const inventoryEntries = [{
    carrier: `.agenticloop/tasks/${taskId}.md`,
    content: taskBody,
    readError: null,
  }];
  const scanned = evaluateParallelScan({
    workUnit: { id: `work-unit:${taskId}`, backend: 'files' },
    inventory: normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries: inventoryEntries,
      complete: true,
      enumeration: createTaskInventoryEnumeration({
        backend: 'files',
        inventoryId: 'files:.agenticloop/tasks',
        observedAt,
        discovered: 1,
        returned: 1,
      }),
    }),
    decomposition: {
      source: 'task-decomposition',
      sourceRef,
      revision: `git-commit:test`,
      declaredCompleteness: 'complete',
      attribution: 'maintainer',
      state: 'complete',
    },
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    basePaths,
    dependencies: dependencyStatusMap(parsedDep.evidence),
    readinessContext: {
      base: {
        kind: 'git_tree',
        identity: `git-tree:${baseTree}`,
        inventoryDigest: sha256(canonicalJson([...basePaths].sort())),
        pathCount: basePaths.length,
        revalidationArgs: ['--base', baseTree],
      },
      dependencies: parsedDep.evidence,
    },
    rescanTrigger: 'test-rescan',
  });
  if (!scanned.ok) throw new Error(`scan failed: ${scanned.result.errors.join('; ')}`);

  const decomposition = createDecompositionProvenance({
    taskId,
    scan: scanned.scan,
    route: 'serial',
    sourceRef,
  });

  writeFileSync(join(target, sourceRef), `${canonicalJson(decomposition)}\n`, 'utf8');
  return sourceRef;
}

function spawnSyncOutput(target, args) {
  return String(spawnSync('git', args, { cwd: target, encoding: 'utf8' }).stdout ?? '').trim();
}

function assertPreflight(result, { expectOk = true, expectErrors } = {}) {
  if (expectOk) {
    assert.equal(result.ok, true, `expected ok=true, got errors: ${JSON.stringify(result.errors)}`);
  } else {
    assert.equal(result.ok, false, `expected ok=false`);
  }
  if (expectErrors !== undefined) {
    assert.equal(result.errors.length, expectErrors,
      `expected ${expectErrors} errors, got ${result.errors.length}: ${JSON.stringify(result.errors)}`);
  }
}

const EXPECTED_DOMAIN_KEYS = [
  'activation',
  'backend',
  'carrier',
  'carrierDigest',
  'cleanState',
  'cleanStateAdvisory',
  'command',
  'contractDigest',
  'debugReference',
  'decomposition',
  'degradedEnforcementReports',
  'dependencyAge',
  'diagnostics',
  'disposition',
  'dispositionOwner',
  'errors',
  'evidenceState',
  'failureCategories',
  'firstSafeRepair',
  'hostRoleCapability',
  'kind',
  'lifecycle',
  'ok',
  'operatorAuthorization',
  'readiness',
  'repository',
  'returnAdapter',
  'rollbackAuthorized',
  'schemaVersion',
  'siblingCollisions',
  'siblingWorktrees',
  'taskId',
  'warnings',
  'warningDiagnostics',
];

describe('handoff-preflight', () => {
  it('produces a closed, deterministic schema with exact keys', () => {
    const target = makeTarget('schema');
    writeTask(target, 'T-001');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-001\n\nTask: T-001\nAgent: maintainer']);
    const now = new Date().toISOString();

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-001', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });

    assert.equal(result.kind, 'agenticloop.handoff-preflight');
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.command, 'task handoff-preflight');
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.evidenceState, 'string');
    assert.equal(typeof result.disposition, 'string');
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.diagnostics));
    assert.ok(Array.isArray(result.warningDiagnostics));
    assert.deepEqual(Object.keys(result).sort(), EXPECTED_DOMAIN_KEYS.sort());

    const again = evaluateHandoffPreflight({
      target, taskId: 'T-001', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });
    assert.equal(canonicalJson(result), canonicalJson(again));
  });

  it('reports a positive, fully activated task as ready', () => {
    const target = makeTarget('positive');
    writeTask(target, 'T-002', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-002\n\nTask: T-002\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-002');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-002\n\nTask: T-002\nAgent: maintainer']);
    const now = new Date().toISOString();

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-002', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });

    assertPreflight(result, { expectOk: true, expectErrors: 0 });
    assert.equal(result.disposition, 'proceed');
    assert.equal(result.evidenceState, 'current');
    assert.equal(result.taskId, 'T-002');
    assert.equal(result.backend, 'files');
    assert.equal(result.carrier, '.agenticloop/tasks/T-002.md');
    assert.ok(result.carrierDigest.startsWith('sha256:'), 'carrier digest should be sha256');
    assert.ok(result.contractDigest.startsWith('sha256:v1:'), 'contract digest should be sha256:v1');
    assert.notEqual(result.carrierDigest, result.contractDigest, 'carrier and contract digests must be distinct');
    assert.ok(result.activation, 'activation should be present');
    assert.equal(result.activation.source, 'legacy_task_capture');
    assert.equal(result.activation.assurance, 'host_signed');
    assert.equal(result.activation.usability, 'usable');
    assert.equal(result.operatorAuthorization, 'authorized');
    assert.ok(result.readiness, 'readiness should be evaluated');
    assert.equal(result.readiness.ok, true, 'readiness should pass');
    assert.equal(result.dependencyAge.evaluatedAt, now);
    assert.ok(result.decomposition, 'decomposition should be present');
    assert.equal(result.decomposition.dispatchCompatible, true);
    assert.equal(result.cleanState, 'clean');
    assert.deepEqual(result.siblingCollisions, []);
    assert.ok(Array.isArray(result.degradedEnforcementReports));
    assert.ok(result.degradedEnforcementReports.length > 0, 'default opencode declaration should report degraded enforcements');
    for (const report of result.degradedEnforcementReports) {
      assert.ok(report.host, 'report should have host');
      assert.ok(report.roleId, 'report should have roleId');
      assert.ok(report.action, 'report should have action');
      assert.ok(report.enforcement, 'report should have enforcement');
    }
    assert.equal(result.firstSafeRepair, null);
    assert.equal(result.dispositionOwner, null);
  });

  it('reports a task without activation as blocked with typed evidence', () => {
    const target = makeTarget('no-activation');
    writeTask(target, 'T-003');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-003\n\nTask: T-003\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-003');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-003\n\nTask: T-003\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-003', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'missing');
    assert.equal(result.disposition, 'blocked');
    assert.equal(result.operatorAuthorization, 'missing');
    assert.ok(result.diagnostics[0].code.includes('activation') || result.diagnostics[0].code.includes('capture'), `expected activation code, got ${result.diagnostics[0].code}`);
    assert.equal(result.diagnostics[0].evidence.state, 'missing');
    assert.equal(result.dispositionOwner, 'engineer'); // activation.capture.missing -> repair_evidence -> engineer
    assert.ok(result.firstSafeRepair, 'first safe repair should be present');
    assert.equal(result.firstSafeRepair, `npx agenticloop activate T-003`, 'first safe repair should be the exact executable command');
    assert.ok(!result.firstSafeRepair.endsWith('.'), 'first safe repair should not be a prose sentence with a trailing period');
    assert.equal(result.activation, null, 'activation should be null when absent');
  });

  it('reports missing task record with maintainer disposition owner', () => {
    const target = makeTarget('missing-task');

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-999', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'missing');
    assert.equal(result.disposition, 'blocked');
    assert.equal(result.dispositionOwner, 'maintainer');
    assert.ok(result.errors.some(e => e.includes('not found')), `expected 'not found' error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.firstSafeRepair, 'first safe repair should be present');
    assert.equal(result.operatorAuthorization, 'unknown');
    assert.equal(result.activation, null);
  });

  it('reports malformed task record with maintainer disposition owner', () => {
    const target = makeTarget('malformed');
    writeTask(target, 'T-004', { malformed: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'malformed task\n\nTask: T-004\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-004', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'malformed');
    assert.equal(result.dispositionOwner, 'maintainer');
    assert.ok(result.errors.some(e => e.includes('malformed') || e.includes('invalid')), `expected malformed error, got: ${JSON.stringify(result.errors)}`);
  });

  it('reports missing decomposition with engineer disposition owner', () => {
    const target = makeTarget('no-decomposition');
    writeTask(target, 'T-005', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-005\n\nTask: T-005\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-005', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'missing');
    assert.equal(result.dispositionOwner, 'engineer');
    assert.ok(result.diagnostics[0].code.includes('decomposition'), `expected decomposition code, got ${result.diagnostics[0].code}`);
    assert.ok(result.firstSafeRepair, 'first safe repair should be present');
    assert.ok(result.firstSafeRepair.includes('prepare-decomposition'), 'first safe repair should mention prepare-decomposition');
  });

  it('reports malformed decomposition with negative evidence', () => {
    const target = makeTarget('malformed-decomposition');
    writeTask(target, 'T-006', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-006\n\nTask: T-006\nAgent: maintainer']);
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'decompositions', 'T-006.json'), 'not valid json', 'utf8');

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-006', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'malformed');
    assert.equal(result.dispositionOwner, 'engineer');
    assert.ok(result.diagnostics[0].code.includes('decomposition'), `expected decomposition code, got ${result.diagnostics[0].code}`);
  });

  it('reports an invalid decomposition source as not dispatchable', () => {
    const target = makeTarget('invalid-decomposition');
    writeTask(target, 'T-007', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-007\n\nTask: T-007\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-007');
    // Rewrite decomposition to be stale/incomplete by removing authority and members
    const path = join(target, '.agenticloop', 'decompositions', 'T-007.json');
    const bad = JSON.parse(readFileSync(path, 'utf8'));
    bad.authority = 'engineer';
    bad.scan.inventory.members = [];
    bad.scan.inventory.complete = false;
    bad.scan.decomposition.state = 'incomplete';
    writeFileSync(path, `${canonicalJson(bad)}\n`, 'utf8');

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-007', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false });
    assert.ok(result.errors.length >= 1, `expected at least 1 error, got ${result.errors.length}`);
    assert.ok(['negative', 'malformed'].includes(result.evidenceState),
      `expected negative or malformed evidenceState, got ${result.evidenceState}`);
    assert.equal(result.dispositionOwner, 'engineer');
    assert.ok(result.decomposition, 'decomposition should be reported');
    assert.equal(result.decomposition.dispatchCompatible, false);
    assert.ok(result.diagnostics.some(d => d.code.includes('decomposition')), `expected decomposition code, got ${result.diagnostics.map(d => d.code).join(', ')}`);
  });

  it('fails closed for unknown backend', () => {
    const target = makeTarget('unknown-backend');
    writeTask(target, 'T-008');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-008\n\nTask: T-008\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-008', backend: 'unknown',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'negative');
    assert.equal(result.dispositionOwner, 'engineer');
    assert.ok(result.errors.some(e => e.includes('unsupported') || e.includes('backend')), `expected backend error, got: ${JSON.stringify(result.errors)}`);
    assert.equal(result.activation, null);
    assert.equal(result.readiness, null);
    assert.equal(result.decomposition, null);
  });

  it('fails closed for GitHub backend', () => {
    const target = makeTarget('github-backend');
    writeTask(target, 'T-009');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-009\n\nTask: T-009\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-009', backend: 'github',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    // GitHub backend now attempts real resolution; without a ghCommandRunner,
    // it falls back to defaultGhCommandRunner which fails (gh not available),
    // producing a 'missing' evidence state.
    assert.equal(result.evidenceState, 'missing');
    assert.ok(result.errors.some(e => e.includes('GitHub') || e.includes('gh') || e.includes('issue number') || e.includes('could not be resolved')),
      `expected GitHub resolution error, got: ${JSON.stringify(result.errors)}`);
  });

  it('reports distinct carrier and contract digests', () => {
    const target = makeTarget('digest-distinct');
    writeTask(target, 'T-010');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-010\n\nTask: T-010\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-010', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.ok(result.carrierDigest, 'carrier digest should be present');
    assert.ok(result.contractDigest, 'contract digest should be present');
    assert.notEqual(result.carrierDigest, result.contractDigest,
      'carrier digest (full file hash) must differ from contract digest (frontmatter-only)');
    assert.ok(result.carrierDigest.startsWith('sha256:'), 'carrier digest should be sha256');
    assert.ok(result.contractDigest.startsWith('sha256:v1:'), 'contract digest should be sha256:v1');
  });

  it('reports clean state', () => {
    const target = makeTarget('clean');
    writeTask(target, 'T-011');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-011\n\nTask: T-011\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-011', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.cleanState, 'clean');
    assert.ok(result.warnings.every(w => /scope glob/.test(w)), `unexpected non-glob warnings: ${JSON.stringify(result.warnings)}`);
  });

  it('reports dirty clean state as a warning', () => {
    const target = makeTarget('dirty');
    writeTask(target, 'T-012');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-012\n\nTask: T-012\nAgent: maintainer']);
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src', 'dirty.txt'), 'dirty', 'utf8');

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-012', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.cleanState, 'dirty');
    assert.ok(result.warnings.length > 0, 'dirty state should produce warnings');
  });

  it('reports return-adapter resolution', () => {
    const target = makeTarget('return-adapter');
    writeTask(target, 'T-013');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-013\n\nTask: T-013\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-013', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.ok(result.returnAdapter, 'returnAdapter should be present');
    assert.equal(result.returnAdapter.state, 'none_required');
    assert.ok(Array.isArray(result.returnAdapter.adapters));
  });

  it('warns on ambiguous return-adapter in standard mode', () => {
    const target = makeTarget('return-ambiguous');
    writeTask(target, 'T-050');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-050\n\nTask: T-050\nAgent: maintainer']);

    const trustA = createTestHostTrust({ target, adapterId: 'test.adapter.alpha.v1', keyId: 'alpha-key' });
    const trustB = createTestHostTrust({ target, adapterId: 'test.adapter.beta.v1', keyId: 'beta-key' });
    const operatorRoot = join(tmpDir, 'return-ambiguous-operator-trust');
    const document = {
      kind: 'agenticloop.host-trust',
      schemaVersion: 1,
      target: { repositoryIdentity: trustA.repositoryIdentity },
      adapters: [...trustA.document.adapters, ...trustB.document.adapters],
    };
    writeHostTrustStore(operatorRoot, { target, document });

    const trustByAdapterId = { 'test.adapter.alpha.v1': trustA, 'test.adapter.beta.v1': trustB };
    const hostAuthority = challenge => {
      const responses = [];
      for (const adapterId of challenge.supportedAdapterIds ?? []) {
        const trust = trustByAdapterId[adapterId];
        if (!trust) continue;
        const response = {
          kind: HOST_TRUST_BOUNDARY_RESPONSE_KIND,
          schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
          adapterId: trust.adapterId,
          keyId: trust.keyId,
          challengeNonce: challenge.nonce,
          signature: null,
        };
        response.signature = signHostPayload(hostTrustBoundarySignaturePayload(challenge, response), trust.privateKey);
        responses.push(response);
      }
      return responses;
    };

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-050', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: { operatorTrustRoot: operatorRoot, hostAuthority },
    });

    const warning = result.warningDiagnostics.find(d => d.code === 'return.assurance.ambiguous');
    assert.ok(warning, 'should have a return.assurance.ambiguous warning');
    assert.match(warning.message, /test\.adapter\.alpha\.v1/);
    assert.match(warning.message, /test\.adapter\.beta\.v1/);
    assert.equal(result.returnAdapter.state, 'resolved');
    assert.ok(result.returnAdapter.adapter, 'resolved adapter should be listed');
    assert.equal(typeof result.returnAdapter.adapter.adapterId, 'string');
    assert.deepEqual(result.returnAdapter.adapters.sort(), ['test.adapter.alpha.v1', 'test.adapter.beta.v1']);
  });

  // Two eligible return adapters pinned in an operator trust store, so
  // selection is exercised against a real ambiguous set.
  function twoAdapterEnv(name, taskId, { hardened = false } = {}) {
    const target = makeTarget(name);
    if (hardened) {
      writeFileSync(join(target, 'agenticloop.json'), `${JSON.stringify({ activation: { mode: 'hardened' } })}\n`, 'utf8');
    }
    writeTask(target, taskId);
    git(target, ['add', '.']);
    git(target, ['commit', '-m', `task ${taskId}\n\nTask: ${taskId}\nAgent: maintainer`]);

    const trustA = createTestHostTrust({ target, adapterId: 'test.adapter.alpha.v1', keyId: 'alpha-key' });
    const trustB = createTestHostTrust({ target, adapterId: 'test.adapter.beta.v1', keyId: 'beta-key' });
    const operatorRoot = join(tmpDir, `${name}-operator-trust`);
    const document = {
      kind: 'agenticloop.host-trust',
      schemaVersion: 1,
      target: { repositoryIdentity: trustA.repositoryIdentity },
      adapters: [...trustA.document.adapters, ...trustB.document.adapters],
    };
    writeHostTrustStore(operatorRoot, { target, document });

    const trustByAdapterId = { 'test.adapter.alpha.v1': trustA, 'test.adapter.beta.v1': trustB };
    const hostAuthority = challenge => {
      const responses = [];
      for (const adapterId of challenge.supportedAdapterIds ?? []) {
        const trust = trustByAdapterId[adapterId];
        if (!trust) continue;
        const response = {
          kind: HOST_TRUST_BOUNDARY_RESPONSE_KIND,
          schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
          adapterId: trust.adapterId,
          keyId: trust.keyId,
          challengeNonce: challenge.nonce,
          signature: null,
        };
        response.signature = signHostPayload(hostTrustBoundarySignaturePayload(challenge, response), trust.privateKey);
        responses.push(response);
      }
      return responses;
    };
    return { target, taskId, io: { operatorTrustRoot: operatorRoot, hostAuthority } };
  }

  it('honors an explicit --return-adapter selection and suppresses the standard ambiguity warning', () => {
    const env = twoAdapterEnv('return-select', 'T-051');
    const result = evaluateHandoffPreflight({
      target: env.target, taskId: env.taskId, backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: env.io,
      returnAdapter: 'test.adapter.beta.v1',
    });
    assert.equal(result.returnAdapter.state, 'resolved');
    assert.equal(result.returnAdapter.adapter.adapterId, 'test.adapter.beta.v1');
    assert.deepEqual(result.returnAdapter.adapters.sort(), ['test.adapter.alpha.v1', 'test.adapter.beta.v1']);
    assert.equal(
      result.warningDiagnostics.find(d => d.code === 'return.assurance.ambiguous'),
      undefined,
      'an explicit selection must suppress the standard ambiguity warning'
    );
  });

  it('rejects an unknown --return-adapter with a typed insufficient error listing eligible ids', () => {
    const env = twoAdapterEnv('return-unknown', 'T-052');
    const result = evaluateHandoffPreflight({
      target: env.target, taskId: env.taskId, backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: env.io,
      returnAdapter: 'test.adapter.gamma.v1',
    });
    assert.equal(result.returnAdapter.state, 'unmatched');
    const error = result.diagnostics.find(d => d.code === 'return.assurance.insufficient');
    assert.ok(error, 'unknown selection must produce a typed return.assurance.insufficient error');
    assert.match(error.message, /test\.adapter\.alpha\.v1/);
    assert.match(error.message, /test\.adapter\.beta\.v1/);
    assert.equal(error.evidence.state, 'negative');
  });

  it('lets an explicit --return-adapter satisfy hardened mode without the ambiguity error', () => {
    const env = twoAdapterEnv('return-hardened', 'T-053', { hardened: true });
    const result = evaluateHandoffPreflight({
      target: env.target, taskId: env.taskId, backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: env.io,
      returnAdapter: 'test.adapter.alpha.v1',
    });
    assert.equal(result.returnAdapter.state, 'resolved');
    assert.equal(result.returnAdapter.adapter.adapterId, 'test.adapter.alpha.v1');
    assert.equal(
      result.diagnostics.find(d => d.code === 'return.assurance.insufficient'),
      undefined,
      'a valid explicit selection must suppress the hardened ambiguity error'
    );
  });

  it('reports host-role capability without throwing', () => {
    const target = makeTarget('capability');
    writeTask(target, 'T-014');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-014\n\nTask: T-014\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-014', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.ok(result.hostRoleCapability, 'hostRoleCapability should be present for the default host');
    assert.equal(result.hostRoleCapability.host, 'opencode');
    assert.equal(result.hostRoleCapability.roleId, 'engineer');
    assert.ok(result.hostRoleCapability.declaration, 'hostRoleCapability.declaration should be present');
    assert.equal(result.hostRoleCapability.declaration.roleId, 'engineer');
  });

  it('reports host ambiguity when multiple adapter hosts are configured', () => {
    const target = makeTarget('host-ambiguous');
    writeFileSync(
      join(target, 'agenticloop.json'),
      `${JSON.stringify({ adapters: { opencode: {}, 'claude-code': {} } })}\n`,
      'utf8'
    );
    writeTask(target, 'T-014b');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-014b\n\nTask: T-014b\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-014b', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    const ambiguous = result.diagnostics.find(d => /host is ambiguous/.test(d.message));
    assert.ok(ambiguous, 'two configured adapter hosts must be reported as ambiguous');
    assert.match(ambiguous.message, /opencode/);
    assert.match(ambiguous.message, /claude-code/);
    assert.equal(result.hostRoleCapability, null, 'no host is selected while the choice is ambiguous');
  });

  it('resolves the canonical default host and never reports ambiguity with zero configured adapters', () => {
    // The shippable inventory is always every supported host; that universe must
    // not be treated as an ambiguous operator selection. Zero configured adapters
    // resolves deterministically to the canonical default without a host error.
    const target = makeTarget('host-default');
    writeTask(target, 'T-014c');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-014c\n\nTask: T-014c\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-014c', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.hostRoleCapability?.host, 'opencode');
    assert.equal(
      result.diagnostics.find(d => /host is ambiguous/.test(d.message)),
      undefined,
      'the shippable host universe must not trigger a false ambiguity error'
    );
  });

  it('reports relevant sibling collisions only', () => {
    const target = makeTarget('sibling-relevant');
    writeTask(target, 'T-015');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-015\n\nTask: T-015\nAgent: maintainer']);

    // Create a sibling worktree with a dirty file outside task scope
    git(target, ['branch', 'other-task']);
    git(target, ['worktree', 'add', '.agenticloop/worktrees/OTHER', 'other-task']);
    const sibling = join(target, '.agenticloop', 'worktrees', 'OTHER');
    mkdirSync(join(sibling, 'other'), { recursive: true });
    writeFileSync(join(sibling, 'other', 'dirty.txt'), 'dirty', 'utf8');

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-015', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.ok(Array.isArray(result.siblingCollisions), 'siblingCollisions should be an array');
    assert.deepEqual(result.siblingCollisions, [], 'non-overlapping dirty files should not be reported');

    // Now create a dirty file in the sibling that overlaps the task scope
    mkdirSync(join(sibling, 'src'), { recursive: true });
    writeFileSync(join(sibling, 'src', 'overlap.txt'), 'overlap', 'utf8');

    const resultWithOverlap = evaluateHandoffPreflight({
      target, taskId: 'T-015', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(resultWithOverlap.siblingCollisions.length, 1, 'overlapping dirty file should be reported');
    assert.equal(resultWithOverlap.siblingCollisions[0].taskId, 'OTHER');
    assert.ok(resultWithOverlap.siblingCollisions[0].overlappingPaths.includes('src/overlap.txt'));

    git(target, ['worktree', 'remove', '-f', '.agenticloop/worktrees/OTHER']);
    git(target, ['branch', '-D', 'other-task']);
  });

  it('reports siblingWorktrees for no-scope tasks and non-standard siblings', () => {
    const target = makeTarget('sibling-worktrees');
    writeTask(target, 'T-060', { emptyScope: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-060\n\nTask: T-060\nAgent: maintainer']);

    const now = new Date().toISOString();
    const result = evaluateHandoffPreflight({
      target, taskId: 'T-060', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });

    assert.ok(Array.isArray(result.siblingWorktrees), 'siblingWorktrees should be an array');
    assert.equal(result.siblingCollisions.length, 0, 'no-scope task should have no collisions');
    // The main worktree is the current one and is skipped, so with no other
    // worktrees there should be no entries. Create an external one next.

    const externalBranch = 'external-branch-T060';
    const externalPath = join(tmpDir, 'external-wt-T060');
    git(target, ['worktree', 'add', '-b', externalBranch, externalPath]);

    const resultWithExternal = evaluateHandoffPreflight({
      target, taskId: 'T-060', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });

    assert.ok(Array.isArray(resultWithExternal.siblingWorktrees), 'siblingWorktrees should be an array');
    const externalEntry = resultWithExternal.siblingWorktrees.find(
      e => e.reason && e.reason.includes('non-standard sibling worktree')
    );
    assert.ok(externalEntry, 'should have a non-standard sibling worktree entry');
    assert.ok(externalEntry.reason.includes('external'), `reason should mention external location, got: ${externalEntry.reason}`);

    // Clean up external worktree
    git(target, ['worktree', 'remove', '--force', externalPath]);
    git(target, ['branch', '-D', externalBranch]);
  });

  it('does not mutate the target', () => {
    const target = makeTarget('no-mutation');
    writeTask(target, 'T-016');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-016\n\nTask: T-016\nAgent: maintainer']);

    const headBefore = spawnSyncOutput(target, ['rev-parse', 'HEAD']);
    const statusBefore = spawnSyncOutput(target, ['status', '--porcelain', '--untracked-files=all']);

    evaluateHandoffPreflight({
      target, taskId: 'T-016', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    const headAfter = spawnSyncOutput(target, ['rev-parse', 'HEAD']);
    const statusAfter = spawnSyncOutput(target, ['status', '--porcelain', '--untracked-files=all']);

    assert.equal(headBefore, headAfter, 'HEAD must not change');
    assert.equal(statusBefore, statusAfter, 'working tree must not change');
  });

  it('produces identical JSON and human verdicts via CLI', async () => {
    const target = makeTarget('cli-parity');
    writeTask(target, 'T-017', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-017\n\nTask: T-017\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-017');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-017\n\nTask: T-017\nAgent: maintainer']);

    const jsonRun = await runCliInProcess(['task', 'handoff-preflight', 'T-017', '--json'], { cwd: target });
    assert.equal(jsonRun.status, 0, `json run should succeed\nstderr:\n${jsonRun.stderr}`);
    let jsonResult;
    assert.doesNotThrow(() => { jsonResult = JSON.parse(jsonRun.stdout); }, 'JSON output should be valid');
    assert.equal(jsonResult.kind, 'agenticloop.handoff-preflight');
    assert.equal(jsonResult.ok, true);
    assert.equal(jsonResult.taskId, 'T-017');
    assert.equal(jsonResult.activation.usability, 'usable');
    assert.equal(jsonResult.firstSafeRepair, null);

    const humanRun = await runCliInProcess(['task', 'handoff-preflight', 'T-017'], { cwd: target });
    assert.equal(humanRun.status, 0, `human run should succeed\nstderr:\n${humanRun.stderr}`);
    assert.match(humanRun.stdout, /READY/);
    assert.match(humanRun.stdout, /T-017/);
    assert.match(humanRun.stdout, /activation usability: usable/);

    // A blocked task also emits JSON with a failure status and repair command
    const blockedRun = await runCliInProcess(['task', 'handoff-preflight', 'T-018', '--json'], { cwd: target });
    assert.equal(blockedRun.status, 1, 'blocked task should exit non-zero');
    let blockedJson;
    assert.doesNotThrow(() => { blockedJson = JSON.parse(blockedRun.stdout); }, 'blocked JSON output should be valid');
    assert.equal(blockedJson.ok, false);
    assert.equal(blockedJson.taskId, 'T-018');
    assert.ok(blockedJson.firstSafeRepair, 'blocked JSON should include first safe repair');
  });

  it('evaluates sections independently and reports multiple prerequisite failures', () => {
    const target = makeTarget('multiple-failures');
    writeTask(target, 'T-020');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-020\n\nTask: T-020\nAgent: maintainer']);
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'decompositions', 'T-020.json'), 'not valid json', 'utf8');

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-020', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assertPreflight(result, { expectOk: false, expectErrors: 2 });
    const codes = result.diagnostics.map(d => d.code);
    assert.ok(codes.some(c => c.includes('activation')), `expected activation code, got ${codes.join(', ')}`);
    assert.ok(codes.some(c => c.includes('decomposition')), `expected decomposition code, got ${codes.join(', ')}`);
  });

  it('sets productBase to the current base tree and emits concrete decomposition repair commands', () => {
    const target = makeTarget('product-base');
    writeTask(target, 'T-021', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-021\n\nTask: T-021\nAgent: maintainer']);
    const head = spawnSyncOutput(target, ['rev-parse', 'HEAD']);
    const baseTree = spawnSyncOutput(target, ['rev-parse', 'HEAD^{tree}']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-021', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.repository.productBase, baseTree);
    assert.ok(result.firstSafeRepair.includes('prepare-decomposition'), result.firstSafeRepair);
    assert.ok(!result.firstSafeRepair.includes('<'), `firstSafeRepair should not contain placeholders: ${result.firstSafeRepair}`);
    assert.ok(result.firstSafeRepair.includes('--work-unit work-unit:T-021'), result.firstSafeRepair);
    assert.ok(result.firstSafeRepair.includes('--source-ref .agenticloop/decompositions/T-021.json'), result.firstSafeRepair);
    assert.ok(result.firstSafeRepair.includes(`--source-revision ${head}`), result.firstSafeRepair);
    assert.ok(result.firstSafeRepair.includes(`--base ${result.repository.baseTree}`), result.firstSafeRepair);
    assert.ok(result.firstSafeRepair.includes('--dependencies .agenticloop/decompositions/T-021.dependencies.json'), result.firstSafeRepair);
  });

  it('marks dependencyAge as observed when readiness is evaluated and missing otherwise', () => {
    const target = makeTarget('dependency-age');
    writeTask(target, 'T-022', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-022\n\nTask: T-022\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-022');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-022\n\nTask: T-022\nAgent: maintainer']);
    const now = new Date().toISOString();

    const ready = evaluateHandoffPreflight({
      target, taskId: 'T-022', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.dependencyAge.state, 'observed');
    assert.equal(ready.dependencyAge.evaluatedAt, now);

    const missing = evaluateHandoffPreflight({
      target, taskId: 'T-023', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.dependencyAge.state, 'missing');
    assert.equal(missing.dependencyAge.evaluatedAt, null);
  });

  it('reports dependencyAge observed for a valid dependency snapshot', () => {
    const target = makeTarget('dep-valid');
    writeTask(target, 'T-030', { withActivation: true, depends_on: ['T-029'] });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-030\n\nTask: T-030\nAgent: maintainer']);

    const observedAt = new Date().toISOString();
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot',
      schemaVersion: 1,
      source: 'files:.agenticloop/tasks',
      observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-029': 'accepted' },
    };
    makeDecompositionSource(target, 'T-030', { depSnapshot });
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-030\n\nTask: T-030\nAgent: maintainer']);
    const now = new Date().toISOString();

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-030', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
      now,
    });

    assertPreflight(result, { expectOk: true, expectErrors: 0 });
    assert.equal(result.dependencyAge.state, 'observed');
    assert.equal(result.dependencyAge.observedAt, observedAt);
    assert.equal(result.dependencyAge.maxAgeSeconds, 3600);
  });

  it('reports dependencyAge stale for an expired dependency snapshot', () => {
    const target = makeTarget('dep-stale');
    writeTask(target, 'T-032', { withActivation: true, depends_on: ['T-031'] });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-032\n\nTask: T-032\nAgent: maintainer']);

    const validObservedAt = new Date().toISOString();
    const validSnapshot = {
      kind: 'agenticloop.dependency-snapshot',
      schemaVersion: 1,
      source: 'files:.agenticloop/tasks',
      observedAt: validObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-031': 'accepted' },
    };
    makeDecompositionSource(target, 'T-032', { depSnapshot: validSnapshot });
    const depPath = join(target, '.agenticloop', 'decompositions', 'T-032.dependencies.json');
    const staleDep = {
      kind: 'agenticloop.dependency-snapshot',
      schemaVersion: 1,
      source: 'files:.agenticloop/tasks',
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 60 },
      statuses: { 'T-031': 'accepted' },
    };
    writeFileSync(depPath, `${canonicalJson(staleDep)}\n`, 'utf8');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-032\n\nTask: T-032\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-032', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.dependencyAge.state, 'stale');
  });

  it('reports dependencyAge missing when snapshot file does not exist', () => {
    const target = makeTarget('dep-missing');
    writeTask(target, 'T-034', { withActivation: true, depends_on: ['T-033'] });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-034\n\nTask: T-034\nAgent: maintainer']);

    const validObservedAt = new Date().toISOString();
    const validSnapshot = {
      kind: 'agenticloop.dependency-snapshot',
      schemaVersion: 1,
      source: 'files:.agenticloop/tasks',
      observedAt: validObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-033': 'accepted' },
    };
    makeDecompositionSource(target, 'T-034', { depSnapshot: validSnapshot });
    const depPath = join(target, '.agenticloop', 'decompositions', 'T-034.dependencies.json');
    rmSync(depPath, { force: true });
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-034\n\nTask: T-034\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-034', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.dependencyAge.state, 'missing');
  });

  it('preflight and dispatch agree on readiness for a real fixture', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'preflight-dispatch-agreement');
    const hostBoundary = protectedHostBoundary(fixture.trust);
    const commonOptions = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: hostBoundary,
    };

    const preflightResult = await runCliInProcess([
      'task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json', '--target', fixture.root,
    ], commonOptions);
    const preflight = JSON.parse(preflightResult.stdout);

    const dispatchResult = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer', '--json', '--target', fixture.root,
    ], commonOptions);
    const dispatch = JSON.parse(dispatchResult.stdout);

    const preflightOk = preflight.ok === true;
    const dispatchOk = dispatchResult.status === 0;
    assert.equal(preflightOk, dispatchOk,
      `preflight ok=${preflightOk} must agree with dispatch ok=${dispatchOk}`);
    if (!preflightOk && !dispatchOk) {
      const preflightCode = preflight.diagnostics?.[0]?.code ?? '';
      const dispatchCode = dispatch.diagnostics?.[0]?.code ?? '';
      const preflightMsg = preflight.diagnostics?.[0]?.message ?? '';
      const dispatchMsg = dispatch.diagnostics?.[0]?.message ?? '';
      const shareRootCause = preflightCode === dispatchCode ||
        preflightMsg.split(';')[0] === dispatchMsg.split(';')[0] ||
        (preflightCode.includes('activation') && dispatchCode.includes('activation')) ||
        (preflightCode.includes('decomposition') && dispatchCode.includes('decomposition'));
      assert.ok(shareRootCause,
        `both blocked but root causes differ: preflight=${preflightCode} dispatch=${dispatchCode}`);
    }
  });

  it('emits capability.resolution.failed warning when host-role capability resolution throws', () => {
    const target = makeTarget('cap-resolution-failed');
    writeTask(target, 'T-040');
    writeFileSync(join(target, 'agenticloop.json'), JSON.stringify({
      adapters: {
        'claude-code': {
          roleSettings: {
            engineer: { permissionMode: 'totally-invalid-mode' },
          },
        },
      },
    }), 'utf8');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-040\n\nTask: T-040\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-040', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    const warning = result.warningDiagnostics.find(d => d.code === 'capability.resolution.failed');
    assert.ok(warning, 'expected capability.resolution.failed warning diagnostic');
    assert.equal(warning.level, 'warning');
  });

  it('writes result to --output path atomically', async () => {
    const target = makeTarget('output-json');
    writeTask(target, 'T-050', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-050\n\nTask: T-050\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-050');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-050\n\nTask: T-050\nAgent: maintainer']);

    const run = await runCliInProcess(['task', 'handoff-preflight', 'T-050', '--output', 'preflight.json'], { cwd: target });
    assert.equal(run.status, 0, `--output run should succeed\nstderr:\n${run.stderr}`);

    const outputPath = join(target, 'preflight.json');
    assert.ok(existsSync(outputPath), 'output file should exist');
    const written = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(written.kind, 'agenticloop.handoff-preflight');
    assert.equal(written.ok, true);
    assert.equal(written.taskId, 'T-050');
  });

  it('writes result to --output with --json without double-printing', async () => {
    const target = makeTarget('output-json-flag');
    writeTask(target, 'T-051', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-051\n\nTask: T-051\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-051');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-051\n\nTask: T-051\nAgent: maintainer']);

    const run = await runCliInProcess(['task', 'handoff-preflight', 'T-051', '--output', 'out/preflight.json', '--json'], { cwd: target });
    assert.equal(run.status, 0, `--output --json run should succeed\nstderr:\n${run.stderr}`);

    // File should exist (nested directory created)
    const outputPath = join(target, 'out', 'preflight.json');
    assert.ok(existsSync(outputPath), 'output file should exist in nested directory');
    const written = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(written.kind, 'agenticloop.handoff-preflight');
    assert.equal(written.taskId, 'T-051');

    // Stdout should also have JSON
    let stdoutJson;
    assert.doesNotThrow(() => { stdoutJson = JSON.parse(run.stdout); }, 'stdout should be valid JSON');
    assert.equal(stdoutJson.taskId, 'T-051');
  });

  it('rejects --output with an escaping path', async () => {
    const target = makeTarget('output-escape');
    writeTask(target, 'T-052', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-052\n\nTask: T-052\nAgent: maintainer']);

    const run = await runCliInProcess(['task', 'handoff-preflight', 'T-052', '--output', '../escape.json'], { cwd: target });
    assert.equal(run.status, 1, 'escaping --output path should fail');
    assert.match(run.stderr, /output|target/i);
  });

  it('generates a valid repair plan for a blocked preflight via --repair-plan', async () => {
    const target = makeTarget('repair-plan-blocked');
    // T-003 is blocked (no activation)
    writeTask(target, 'T-003');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-003\n\nTask: T-003\nAgent: maintainer']);

    const run = await runCliInProcess(['task', 'handoff-preflight', 'T-003', '--repair-plan', 'repair.json', '--json'], { cwd: target });
    assert.equal(run.status, 1, 'blocked preflight should exit non-zero');
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.taskId, 'T-003');
    // The repair plan should be attached to the JSON output
    assert.ok(result.refreshPlan, 'refreshPlan should be present in JSON output');
    assert.ok(result.refreshPlanPath, 'refreshPlanPath should be present in JSON output');
    assert.equal(result.refreshPlan.kind, 'agenticloop.handoff-evidence-refresh-plan');
    assert.equal(result.refreshPlan.taskId, 'T-003');
    // The plan file should be written
    const planPath = join(target, 'repair.json');
    assert.ok(existsSync(planPath), 'repair plan file should exist');
    const planContent = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(planContent.kind, 'agenticloop.handoff-evidence-refresh-plan');
    assert.ok(Array.isArray(planContent.categories), 'plan should have categories');
  });

  it('generates a repair plan for a ready preflight via --repair-plan', async () => {
    const target = makeTarget('repair-plan-ready');
    writeTask(target, 'T-060', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-060\n\nTask: T-060\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-060');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-060\n\nTask: T-060\nAgent: maintainer']);

    const run = await runCliInProcess(['task', 'handoff-preflight', 'T-060', '--repair-plan', 'plan/refresh.json', '--json'], { cwd: target });
    assert.equal(run.status, 0, `ready preflight should succeed\nstderr:\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.ok(result.refreshPlan, 'refreshPlan should be present even for ready preflight');
    assert.equal(result.refreshPlan.kind, 'agenticloop.handoff-evidence-refresh-plan');
    assert.ok(result.refreshPlanPath, 'refreshPlanPath should be present');
    // Nested directory should be created
    const planPath = join(target, 'plan', 'refresh.json');
    assert.ok(existsSync(planPath), 'plan file should exist in nested directory');
    const planContent = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(planContent.kind, 'agenticloop.handoff-evidence-refresh-plan');
    assert.equal(planContent.taskId, 'T-060');
    assert.ok(Array.isArray(planContent.categories), 'plan should have categories array');
    assert.equal(planContent.categories.length, 4, 'plan should have 4 categories');
  });

  it('writes repair plan to --output path when both --repair-plan and --output are set', async () => {
    const target = makeTarget('repair-plan-output');
    writeTask(target, 'T-061', { withActivation: true });
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-061\n\nTask: T-061\nAgent: maintainer']);
    makeDecompositionSource(target, 'T-061');
    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-061\n\nTask: T-061\nAgent: maintainer']);

    const run = await runCliInProcess([
      'task', 'handoff-preflight', 'T-061',
      '--repair-plan', 'repair.json',
      '--output', 'preflight-result.json',
      '--json',
    ], { cwd: target });
    assert.equal(run.status, 0, `combined run should succeed\nstderr:\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.ok(result.refreshPlan, 'refreshPlan should be in stdout JSON');
    // Both files should exist
    assert.ok(existsSync(join(target, 'repair.json')), 'repair plan file should exist');
    assert.ok(existsSync(join(target, 'preflight-result.json')), 'output file should exist');
    const outputContent = JSON.parse(readFileSync(join(target, 'preflight-result.json'), 'utf8'));
    assert.ok(outputContent.refreshPlan, 'output file should include refreshPlan');
    assert.ok(outputContent.refreshPlanPath, 'output file should include refreshPlanPath');
  });

  it('generates a repair plan with --repair-plan without --json', async () => {
    const target = makeTarget('repair-plan-human');
    writeTask(target, 'T-062');
    git(target, ['add', '.']);
    git(target, ['commit', '-m', 'task T-062\n\nTask: T-062\nAgent: maintainer']);

    const run = await runCliInProcess(['task', 'handoff-preflight', 'T-062', '--repair-plan', 'repair.json'], { cwd: target });
    assert.equal(run.status, 1, 'blocked task should exit non-zero');
    // Human output should mention the refresh plan path
    assert.match(run.stdout, /refresh plan/);
    // Plan file should still be written
    const planPath = join(target, 'repair.json');
    assert.ok(existsSync(planPath), 'repair plan file should exist even without --json');
    const planContent = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(planContent.kind, 'agenticloop.handoff-evidence-refresh-plan');
  });
});
