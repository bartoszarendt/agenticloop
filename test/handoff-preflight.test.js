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
import { canonicalJson, canonicalSha256 } from '../src/canonical-json.js';

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

function writeTask(target, taskId, { status = 'agent-ready', withActivation = false, malformed = false, depends_on = null } = {}) {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  if (malformed) {
    writeFileSync(taskPath(target, taskId), 'completely invalid content without frontmatter\n', 'utf8');
    return;
  }
  const activationLines = withActivation
    ? `activation_input_digest: ${activationDigest(taskId)}\nactivation_capture_ref: activation-grants/${taskId}.md\n`
    : '';
  writeFileSync(taskPath(target, taskId), `---
task_id: ${taskId}
status: ${status}
backend: files
allowed_paths:
  - "src/**"
  - "docs/**"
intended_creations:
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

function makeDecompositionSource(target, taskId) {
  const dir = join(target, '.agenticloop', 'decompositions');
  mkdirSync(dir, { recursive: true });
  const sourceRef = `.agenticloop/decompositions/${taskId}.json`;
  const baseTree = spawnSyncOutput(target, ['rev-parse', 'HEAD^{tree}']);

  const decomposition = {
    kind: 'agenticloop.decomposition-provenance',
    schemaVersion: 2,
    taskId,
    authority: 'maintainer',
    source: 'task-decomposition',
    route: 'serial',
    scan: {
      kind: 'agenticloop.parallel-scan',
      schemaVersion: 2,
      workUnit: { id: `work-unit:${taskId}`, backend: 'files' },
      inventory: {
        source: 'files:.agenticloop/tasks',
        enumeration: {
          inventoryId: 'files:.agenticloop/tasks',
          observedAt: new Date().toISOString(),
          discovered: 1,
          returned: 1,
          pageCount: 1,
          truncated: false,
          cursor: null,
        },
        members: [{
          carrier: `.agenticloop/tasks/${taskId}.md`,
          taskId,
          status: 'agent-ready',
          backend: 'files',
          digest: sha256(readFileSync(taskPath(target, taskId), 'utf8')),
          eligibility: 'eligible',
        }],
        complete: true,
      },
      excluded: [],
      readyTaskIds: [taskId],
      candidatePairs: [],
      conclusion: 'serial_only',
      decomposition: {
        state: 'complete',
        readySetDigest: sha256(canonicalJson({ readyTaskIds: [taskId] })),
      },
      readinessContext: {
        base: { kind: 'git_tree', identity: `git-tree:${baseTree}` },
        dependencies: null,
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      rescanTrigger: 'test-rescan',
      joinPlans: {},
      laneArtifacts: {},
    },
    observedAt: new Date().toISOString(),
    freshnessPolicy: { maxAgeSeconds: 3600 },
    sourceRef,
    sourceDigest: null,
  };
  const { sourceDigest: _ignored, ...rest } = decomposition;
  decomposition.sourceDigest = `sha256:${canonicalSha256(rest)}`;

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
  'ok',
  'operatorAuthorization',
  'readiness',
  'repository',
  'returnAdapter',
  'rollbackAuthorized',
  'schemaVersion',
  'siblingCollisions',
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

    assertPreflight(result, { expectOk: false, expectErrors: 1 });
    assert.equal(result.evidenceState, 'negative');
    assert.equal(result.dispositionOwner, 'engineer');
    assert.ok(result.decomposition, 'decomposition should be reported');
    assert.equal(result.decomposition.dispatchCompatible, false);
    assert.ok(result.diagnostics[0].code.includes('decomposition'), `expected decomposition code, got ${result.diagnostics[0].code}`);
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
    assert.equal(result.evidenceState, 'negative');
    assert.equal(result.dispositionOwner, 'engineer');
    assert.ok(result.errors.some(e => e.includes('GitHub') || e.includes('not yet supported')), `expected GitHub error, got: ${JSON.stringify(result.errors)}`);
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
      source: 'test-scan',
      observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-029': 'accepted' },
    };
    const depRef = `.agenticloop/decompositions/T-030.dependencies.json`;
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, depRef), `${canonicalJson(depSnapshot)}\n`, 'utf8');

    const decomDir = join(target, '.agenticloop', 'decompositions');
    mkdirSync(decomDir, { recursive: true });
    const baseTree = spawnSyncOutput(target, ['rev-parse', 'HEAD^{tree}']);
    const decomposition = {
      kind: 'agenticloop.decomposition-provenance',
      schemaVersion: 2,
      taskId: 'T-030',
      authority: 'maintainer',
      source: 'task-decomposition',
      route: 'serial',
      scan: {
        kind: 'agenticloop.parallel-scan',
        schemaVersion: 2,
        workUnit: { id: 'work-unit:T-030', backend: 'files' },
        inventory: {
          source: 'files:.agenticloop/tasks',
          enumeration: {
            inventoryId: 'files:.agenticloop/tasks',
            observedAt: new Date().toISOString(),
            discovered: 1,
            returned: 1,
            pageCount: 1,
            truncated: false,
            cursor: null,
          },
          members: [{
            carrier: '.agenticloop/tasks/T-030.md',
            taskId: 'T-030',
            status: 'agent-ready',
            backend: 'files',
            digest: sha256(readFileSync(taskPath(target, 'T-030'), 'utf8')),
            eligibility: 'eligible',
          }],
          complete: true,
        },
        excluded: [],
        readyTaskIds: ['T-030'],
        candidatePairs: [],
        conclusion: 'serial_only',
        decomposition: {
          state: 'complete',
          readySetDigest: sha256(canonicalJson({ readyTaskIds: ['T-030'] })),
        },
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${baseTree}` },
          dependencies: { sourceRef: depRef },
        },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        rescanTrigger: 'test-rescan',
        joinPlans: {},
        laneArtifacts: {},
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: `.agenticloop/decompositions/T-030.json`,
      sourceDigest: null,
    };
    const { sourceDigest: _ignored, ...rest } = decomposition;
    decomposition.sourceDigest = `sha256:${canonicalSha256(rest)}`;
    writeFileSync(join(target, decomposition.sourceRef), `${canonicalJson(decomposition)}\n`, 'utf8');

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

    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot',
      schemaVersion: 1,
      source: 'test-scan',
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 60 },
      statuses: { 'T-031': 'accepted' },
    };
    const depRef = `.agenticloop/decompositions/T-032.dependencies.json`;
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, depRef), `${canonicalJson(depSnapshot)}\n`, 'utf8');

    const decomDir = join(target, '.agenticloop', 'decompositions');
    mkdirSync(decomDir, { recursive: true });
    const baseTree = spawnSyncOutput(target, ['rev-parse', 'HEAD^{tree}']);
    const decomposition = {
      kind: 'agenticloop.decomposition-provenance',
      schemaVersion: 2,
      taskId: 'T-032',
      authority: 'maintainer',
      source: 'task-decomposition',
      route: 'serial',
      scan: {
        kind: 'agenticloop.parallel-scan',
        schemaVersion: 2,
        workUnit: { id: 'work-unit:T-032', backend: 'files' },
        inventory: {
          source: 'files:.agenticloop/tasks',
          enumeration: {
            inventoryId: 'files:.agenticloop/tasks',
            observedAt: new Date().toISOString(),
            discovered: 1,
            returned: 1,
            pageCount: 1,
            truncated: false,
            cursor: null,
          },
          members: [{
            carrier: '.agenticloop/tasks/T-032.md',
            taskId: 'T-032',
            status: 'agent-ready',
            backend: 'files',
            digest: sha256(readFileSync(taskPath(target, 'T-032'), 'utf8')),
            eligibility: 'eligible',
          }],
          complete: true,
        },
        excluded: [],
        readyTaskIds: ['T-032'],
        candidatePairs: [],
        conclusion: 'serial_only',
        decomposition: {
          state: 'complete',
          readySetDigest: sha256(canonicalJson({ readyTaskIds: ['T-032'] })),
        },
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${baseTree}` },
          dependencies: { sourceRef: depRef },
        },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        rescanTrigger: 'test-rescan',
        joinPlans: {},
        laneArtifacts: {},
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: `.agenticloop/decompositions/T-032.json`,
      sourceDigest: null,
    };
    const { sourceDigest: _ignored, ...rest } = decomposition;
    decomposition.sourceDigest = `sha256:${canonicalSha256(rest)}`;
    writeFileSync(join(target, decomposition.sourceRef), `${canonicalJson(decomposition)}\n`, 'utf8');

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

    const depRef = `.agenticloop/decompositions/T-034.dependencies.json`;
    const decomDir = join(target, '.agenticloop', 'decompositions');
    mkdirSync(decomDir, { recursive: true });
    const baseTree = spawnSyncOutput(target, ['rev-parse', 'HEAD^{tree}']);
    const decomposition = {
      kind: 'agenticloop.decomposition-provenance',
      schemaVersion: 2,
      taskId: 'T-034',
      authority: 'maintainer',
      source: 'task-decomposition',
      route: 'serial',
      scan: {
        kind: 'agenticloop.parallel-scan',
        schemaVersion: 2,
        workUnit: { id: 'work-unit:T-034', backend: 'files' },
        inventory: {
          source: 'files:.agenticloop/tasks',
          enumeration: {
            inventoryId: 'files:.agenticloop/tasks',
            observedAt: new Date().toISOString(),
            discovered: 1,
            returned: 1,
            pageCount: 1,
            truncated: false,
            cursor: null,
          },
          members: [{
            carrier: '.agenticloop/tasks/T-034.md',
            taskId: 'T-034',
            status: 'agent-ready',
            backend: 'files',
            digest: sha256(readFileSync(taskPath(target, 'T-034'), 'utf8')),
            eligibility: 'eligible',
          }],
          complete: true,
        },
        excluded: [],
        readyTaskIds: ['T-034'],
        candidatePairs: [],
        conclusion: 'serial_only',
        decomposition: {
          state: 'complete',
          readySetDigest: sha256(canonicalJson({ readyTaskIds: ['T-034'] })),
        },
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${baseTree}` },
          dependencies: { sourceRef: depRef },
        },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        rescanTrigger: 'test-rescan',
        joinPlans: {},
        laneArtifacts: {},
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: `.agenticloop/decompositions/T-034.json`,
      sourceDigest: null,
    };
    const { sourceDigest: _ignored, ...rest } = decomposition;
    decomposition.sourceDigest = `sha256:${canonicalSha256(rest)}`;
    writeFileSync(join(target, decomposition.sourceRef), `${canonicalJson(decomposition)}\n`, 'utf8');

    git(target, ['add', '.agenticloop/decompositions']);
    git(target, ['commit', '-m', 'decomposition T-034\n\nTask: T-034\nAgent: maintainer']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-034', backend: 'files',
      projectConfig: { task_file_template: '.agenticloop/tasks/{taskId}.md' },
      io: {},
    });

    assert.equal(result.dependencyAge.state, 'missing');
  });
});
