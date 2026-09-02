/**
 * Task publication and readiness contract coverage.
 *
 * Each block exercises an adversarial publication or readiness boundary.
 * Public-command cases pass every required
 * CLI argument explicitly; no helper here injects `--expect-digest`, base, or
 * dependency evidence on a caller's behalf.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { produceExecutionEvidence } from '../src/execution-evidence.js';
import { runCliInProcess } from './helpers/run-cli.js';
import {
  createDispatchFixture,
  prepare,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './helpers/dispatch-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { initTestGitRepository } from './helpers/git-fixture.js';
import { applyGitHubTaskBody, taskBodyDigest } from '../src/github-task-body.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { validateTaskStatusTransition } from '../src/task-transition.js';
import { resolveCarrierLineage } from '../src/handoff-consumption.js';
import {
  HUMAN_SCOPE_SELECTION_KIND,
  listTaskRecords,
  resolveCanonicalTerminalScope,
} from '../src/terminal-scope.js';
import {
  appendAuditReport,
  createAuditRecordContent,
  migrateAuditConsumptionCause,
  parseAuditRecord,
  validateAuditRecord,
} from '../src/audit-record.js';
import { renderCloseoutMarker } from '../src/closeout-contract.js';
import { applyFilesCloseoutTerminalTransition } from '../src/closeout-cli.js';
import { deriveAuditDueWorkUnits } from '../src/closeout.js';
import { lifecycleMutationReceipt, persistLifecycleReceipt } from '../src/lifecycle-plan.js';
import { LIFECYCLE_RECEIPT_RELATIVE_PATH } from '../src/layout.js';
import {
  BASE_EVIDENCE_KINDS,
  DEPENDENCY_SNAPSHOT_KIND,
  TASK_EVIDENCE_CONTEXT_KIND,
  TASK_MUTATION_RECEIPT_KIND,
  TASK_READINESS_EVIDENCE_KIND,
  createTaskEvidenceContext,
  createTaskMutationReceipt,
  createTaskReadinessEvidence,
  parseDependencySnapshot,
  shellQuoteArgument,
  taskEvidenceContextDigest,
  validateTaskEvidenceContext,
  validateTaskMutationReceipt,
  validateTaskReadinessEvidence,
} from '../src/task-evidence-contract.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-publication-readiness-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/**
 * Split an emitted revalidation command into argv exactly as a shell would,
 * honoring the receipt's own quoting. Tests execute the emitted command; they
 * never reconstruct a different one.
 */
function splitCommand(command) {
  const argv = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\' && quoted && index + 1 < command.length) {
      current += command[index + 1];
      index += 1;
      continue;
    }
    if (character === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(character)) {
      if (started || current) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started || current) argv.push(current);
  return argv;
}

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
// Verification results use this canonical prefixed digest form.
const VALIDATION_DIGEST = `sha256:agenticloop.validation-result.v1:${'9'.repeat(64)}`;
const OBSERVED_AT = new Date().toISOString();
const TREE_OID = 'd'.repeat(40);

function baseEvidence(overrides = {}) {
  return {
    kind: 'git_tree',
    identity: `git-tree:${TREE_OID}`,
    inventoryDigest: DIGEST_B,
    pathCount: 3,
    revalidationArgs: ['--base', 'refs/heads/main'],
    ...overrides,
  };
}

function dependencyEvidence(overrides = {}) {
  return {
    source: 'file:.agenticloop/tmp/dependencies.json',
    digest: DIGEST_C,
    observedAt: OBSERVED_AT,
    evaluatedAt: OBSERVED_AT,
    freshnessPolicy: { maxAgeSeconds: 86400 },
    freshnessState: 'current',
    evaluatedState: 'satisfied',
    statuses: [{ id: 'T-002', status: 'accepted' }],
    revalidationArgs: ['--dependencies', '.agenticloop/tmp/dependencies.json'],
    ...overrides,
  };
}

function evidenceContext(overrides = {}) {
  return createTaskEvidenceContext({
    backend: 'files',
    task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md', expectedDigest: DIGEST_A },
    transition: { fromStatus: 'draft', toStatus: 'agent-ready' },
    base: baseEvidence(),
    dependencies: dependencyEvidence(),
    ...overrides,
  });
}

function receiptRevalidation(digest = DIGEST_B, carrier = '.agenticloop/tasks/T-001.md') {
  return `npx agenticloop task-readiness --task-body ${carrier} --mode authoring ` +
    `--expect-task-digest ${digest} --base refs/heads/main --dependencies .agenticloop/tmp/dependencies.json`;
}

describe('shared task evidence and mutation receipt contract', () => {
  it('binds one validated identity, base, and dependency context', () => {
    const context = evidenceContext();
    assert.equal(context.kind, TASK_EVIDENCE_CONTEXT_KIND);
    assert.equal(context.schemaVersion, 1);
    assert.equal(context.task.id, 'T-001');
    assert.equal(context.task.expectedDigest, DIGEST_A);
    assert.equal(context.base.identity, `git-tree:${TREE_OID}`);
    assert.match(context.dependencies.observedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(validateTaskEvidenceContext(context).ok, true);
    assert.match(taskEvidenceContextDigest(context), /^sha256:agenticloop\.task-evidence-context\.v1:[0-9a-f]{64}$/);
  });

  it('produces one digest regardless of property insertion order', () => {
    const straight = evidenceContext();
    const permuted = createTaskEvidenceContext({
      dependencies: dependencyEvidence(),
      base: baseEvidence(),
      transition: { toStatus: 'agent-ready', fromStatus: 'draft' },
      task: { expectedDigest: DIGEST_A, carrier: '.agenticloop/tasks/T-001.md', id: 'T-001' },
      backend: 'files',
    });
    assert.equal(taskEvidenceContextDigest(permuted), taskEvidenceContextDigest(straight));
  });

  it('rejects a symbolic base identity in place of a resolved tree object id', () => {
    assert.throws(
      () => evidenceContext({ base: baseEvidence({ identity: 'git-tree:main' }) }),
      /resolved git tree object id/i,
    );
    assert.throws(
      () => evidenceContext({ base: baseEvidence({ identity: 'main' }) }),
      /base evidence identity/i,
    );
  });

  it('rejects incomplete, contradictory, malformed, and stale evidence', () => {
    assert.throws(() => evidenceContext({ base: null }), /base evidence is required/i);
    assert.throws(() => evidenceContext({ dependencies: null }), /dependency evidence is required/i);
    assert.throws(
      () => evidenceContext({ task: { id: 'T-001', carrier: 'x.md', expectedDigest: 'sha256:short' } }),
      /expectedDigest/i,
    );
    assert.throws(
      () => evidenceContext({ dependencies: dependencyEvidence({ observedAt: 'yesterday' }) }),
      /observedAt/i,
    );
    assert.throws(
      () => evidenceContext({
        dependencies: dependencyEvidence({
          observedAt: '2020-01-01T00:00:00.000Z',
          freshnessPolicy: { maxAgeSeconds: 1 },
          freshnessState: 'stale',
          evaluatedState: 'satisfied',
        }),
      }),
      /evaluatedState must be 'indeterminate'/i,
    );
    assert.throws(
      () => evidenceContext({ transition: { fromStatus: 'draft', toStatus: 'draft' } }),
      /transition must change the task status/i,
    );
    assert.throws(
      () => evidenceContext({ base: baseEvidence({ kind: 'path_inventory' }) }),
      /path inventory evidence must use a path-inventory identity/i,
    );
  });

  it('accepts every declared base evidence kind', () => {
    assert.deepEqual([...BASE_EVIDENCE_KINDS], ['git_tree', 'path_inventory']);
    const inventory = evidenceContext({
      base: baseEvidence({
        kind: 'path_inventory',
        identity: 'path-inventory:.agenticloop/tmp/base-paths.json',
        revalidationArgs: ['--base-paths', '.agenticloop/tmp/base-paths.json'],
      }),
    });
    assert.equal(inventory.base.kind, 'path_inventory');
  });

  it('mechanically derives receipt evidence from the exact context', () => {
    const context = evidenceContext();
    const receipt = createTaskMutationReceipt({
      context,
      candidateDigest: DIGEST_B,
      resultingDigest: DIGEST_B,
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      ownedProjections: ['task_record_status'],
      changedPaths: ['.agenticloop/tasks/T-001.md'],
      mutationDisposition: 'committed',
      revalidateCommand: receiptRevalidation(),
    });
    assert.equal(receipt.kind, TASK_MUTATION_RECEIPT_KIND);
    assert.equal(receipt.expectedDigest, DIGEST_A);
    assert.equal(receipt.evidenceContextDigest, taskEvidenceContextDigest(context));
    assert.equal(receipt.unresolved, false);
    assert.equal(validateTaskMutationReceipt(receipt).ok, true);
  });

  it('refuses a caller-supplied evidence digest that contradicts the context', () => {
    const context = evidenceContext();
    assert.throws(
      () => createTaskMutationReceipt({
        context,
        evidenceContextDigest: DIGEST_C,
        candidateDigest: DIGEST_B,
        resultingDigest: DIGEST_B,
        verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
        ownedProjections: ['task_record_status'],
        changedPaths: ['.agenticloop/tasks/T-001.md'],
        mutationDisposition: 'committed',
        revalidateCommand: 'npx agenticloop task-readiness --task "x" --mode authoring',
      }),
      /evidenceContextDigest is derived/i,
    );
  });

  it('refuses a receipt whose revalidation command is a placeholder or a mutation', () => {
    const context = evidenceContext();
    const build = revalidateCommand => () => createTaskMutationReceipt({
      context,
      candidateDigest: DIGEST_B,
      resultingDigest: DIGEST_B,
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      ownedProjections: ['task_record_status'],
      changedPaths: ['.agenticloop/tasks/T-001.md'],
      mutationDisposition: 'committed',
      revalidateCommand,
    });
    assert.throws(build('npx agenticloop task-readiness --expect-task-digest <current-digest>'), /placeholder/i);
    assert.throws(build('npx agenticloop task status T-001 agent-ready --expect-digest ' + DIGEST_B), /read-only/i);
    assert.throws(build('npx agenticloop task-body transition --issue 31 --status agent-ready'), /read-only/i);
  });

  it('classifies mutation commands only at the agenticloop command position', () => {
    const context = evidenceContext({
      task: { id: 'T-001', carrier: 'update.md', expectedDigest: DIGEST_A },
    });
    const receipt = createTaskMutationReceipt({
      context,
      candidateDigest: DIGEST_B,
      resultingDigest: DIGEST_B,
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      ownedProjections: ['task_record_status'],
      changedPaths: ['.agenticloop/tasks/T-001.md'],
      mutationDisposition: 'committed',
      revalidateCommand: receiptRevalidation(DIGEST_B, 'update.md'),
    });
    assert.equal(validateTaskMutationReceipt(receipt).ok, true);
  });

  it('reports every receipt shape error during construction', () => {
    assert.throws(
      () => createTaskMutationReceipt({
        backend: 'unknown',
        taskId: '',
        carrier: '',
        candidateDigest: 'not-a-digest',
        resultingDigest: 'also-not-a-digest',
        verification: null,
        ownedProjections: [],
        changedPaths: [],
        mutationDisposition: 'invented',
        revalidateCommand: '',
      }),
      error => {
        assert.match(error.message, /backend must be one of/i);
        assert.match(error.message, /task id is required/i);
        assert.match(error.message, /candidateDigest must be a sha256 digest/i);
        assert.match(error.message, /verification requires/i);
        assert.match(error.message, /revalidateCommand/i);
        return true;
      },
    );
  });

  it('marks every non-final disposition unresolved', () => {
    const context = evidenceContext();
    const build = mutationDisposition => createTaskMutationReceipt({
      context,
      candidateDigest: DIGEST_B,
      resultingDigest: mutationDisposition === 'committed' ? DIGEST_B : null,
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      ownedProjections: ['task_record_status'],
      changedPaths: mutationDisposition === 'committed' ? ['.agenticloop/tasks/T-001.md'] : [],
      mutationDisposition,
      revalidateCommand: receiptRevalidation(),
      recovery: ['committed', 'already_current', 'dry_run'].includes(mutationDisposition)
        ? null
        : 'Inspect the carrier before retrying.',
    });
    assert.equal(build('committed').unresolved, false);
    assert.equal(build('dry_run').unresolved, false);
    assert.equal(build('unresolved').unresolved, true);
    assert.equal(build('uncommitted').unresolved, true);
    assert.throws(
      () => createTaskMutationReceipt({
        context,
        candidateDigest: DIGEST_B,
        resultingDigest: null,
        verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
        ownedProjections: [],
        changedPaths: [],
        mutationDisposition: 'committed',
        revalidateCommand: receiptRevalidation(),
      }),
      /committed mutation requires a resulting digest/i,
    );
  });

  it('validates the dependency snapshot schema exactly', () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    const document = {
      kind: DEPENDENCY_SNAPSHOT_KIND,
      schemaVersion: 1,
      source: 'files:.agenticloop/tasks',
      observedAt: '2026-07-29T10:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 86400 },
      statuses: { 'T-002': 'accepted' },
    };
    const ok = parseDependencySnapshot(JSON.stringify(document), {
      sourceRef: '.agenticloop/tmp/dependencies.json',
      now,
    });
    assert.equal(ok.ok, true, ok.errors.join('; '));
    assert.equal(ok.evidence.freshnessState, 'current');
    assert.equal(ok.evidence.evaluatedState, 'satisfied');

    const bare = parseDependencySnapshot('{"T-002":"accepted"}', { sourceRef: 'x.json', now });
    assert.equal(bare.ok, false);
    assert.match(bare.errors.join('; '), /dependency snapshot kind/i);

    const stale = parseDependencySnapshot(JSON.stringify({
      ...document,
      observedAt: '2026-07-01T10:00:00.000Z',
    }), { sourceRef: 'x.json', now });
    assert.equal(stale.ok, false);
    assert.match(stale.errors.join('; '), /stale/i);

    const future = parseDependencySnapshot(JSON.stringify({
      ...document,
      observedAt: '2027-07-29T10:00:00.000Z',
    }), { sourceRef: 'x.json', now });
    assert.equal(future.ok, false);
    assert.match(future.errors.join('; '), /future/i);

    const negative = parseDependencySnapshot(JSON.stringify({
      ...document,
      statuses: { 'T-002': 'blocked' },
    }), { sourceRef: 'x.json', now });
    assert.equal(negative.ok, true);
    assert.equal(negative.evidence.evaluatedState, 'unsatisfied');

    const noneDeclared = parseDependencySnapshot(JSON.stringify({
      ...document,
      statuses: {},
    }), { sourceRef: 'deps.json', now });
    assert.equal(noneDeclared.ok, true);
    assert.equal(noneDeclared.evidence.evaluatedState, 'satisfied');
    assert.deepEqual(noneDeclared.evidence.statuses, []);

    const malformed = parseDependencySnapshot('{ not json', { sourceRef: 'x.json', now });
    assert.equal(malformed.ok, false);
    assert.match(malformed.errors.join('; '), /valid JSON/i);
  });

  it('quotes revalidation path arguments safely', () => {
    // Double quotes are the only form POSIX shells, PowerShell, and cmd.exe all
    // honor; a value that cannot be represented inertly in all three is refused
    // rather than emitted. The cross-shell block in task-evidence-integrity.test.js executes the
    // emitted value through each of those shells.
    assert.equal(shellQuoteArgument('simple.json'), 'simple.json');
    assert.equal(shellQuoteArgument('with space.json'), '"with space.json"');
    assert.equal(shellQuoteArgument(''), '""');
    assert.throws(() => shellQuoteArgument('a"b.json'), /shell-safe/i);
  });
});

// ---------------------------------------------------------------------------
// Exact readiness evidence, pre-mutation validation, transactional files
// mutation, and an executable read-only revalidation path.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function taskFile(target, taskId) {
  return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
}

function currentTaskDigest(target, taskId) {
  return digestOf(readFileSync(taskFile(target, taskId), 'utf8'));
}

function writeDependencySnapshot(target, relPath, statuses = {}, observedAt = new Date().toISOString()) {
  const canonicalRelPath = `dependency-evidence/${relPath.split(/[\\/]/).pop()}`;
  const full = join(target, canonicalRelPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `${JSON.stringify({
    kind: DEPENDENCY_SNAPSHOT_KIND,
    schemaVersion: 1,
    source: 'files:.agenticloop/tasks',
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 86400 },
    statuses,
  }, null, 2)}\n`, 'utf8');
  git(target, ['add', canonicalRelPath]);
  const attributionTask = relPath.includes('github-') ? '#71' : 'T-001';
  git(target, ['commit', '-m', `record dependency evidence\n\nTask: ${attributionTask}\nAgent: maintainer`]);
  return canonicalRelPath;
}

const DRAFT_SECTIONS = [
  '# T-001 - Guarded readiness',
  '',
  '## Task', 'Prove the guarded readiness transition.', '',
  '## Source Documents Reviewed', '- README.md', '',
  '## Current State', 'Draft.', '',
  '## Scope', 'One transition.', '',
  '## Out of Scope', 'Everything else.', '',
  '## Acceptance Criteria', '- The transition is guarded.', '',
  '## Required Checks', '- npm test', '',
  '## Expected Files or Areas', '- src/', '',
  '## Implementation Notes', 'None.', '',
  '## Completion Summary Template', 'Use the template.', '',
  '## Reviewer Checklist', '- [ ] Reviewed.', '',
].join('\n');

function draftTaskBody({ taskId = 'T-001', status = 'draft', schema = '2', extra = [] } = {}) {
  return [
    '---',
    `task_id: ${taskId}`,
    `status: ${status}`,
    'backend: files',
    ...(schema === null ? [] : [`task_contract_schema: ${schema}`]),
    'attempt_budget: 5',
    'review_budget: 5',
    'allowed_paths:',
    '  - src/**',
    'intended_creations:',
    '  - src/new.js',
    ...extra,
    '---',
    '',
    DRAFT_SECTIONS,
  ].join('\n');
}

async function readinessFixture(name, { schema = '2', taskId = 'T-001', body = null } = {}) {
  const root = mkdtempSync(join(temp, `${name}-`));
  createTaskProjectFixture(root);
  // A real base-tree path so `allowed_paths: src/**` resolves against an
  // authoritative inventory instead of producing an unmatched-glob warning.
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'existing.js'), 'export const existing = true;\n', 'utf8');
  writeFileSync(taskFile(root, taskId), body ?? draftTaskBody({ taskId, schema }), 'utf8');
  git(root, ['add', 'src', '.agenticloop/tasks']);
  git(root, ['commit', '-m', `task ${taskId}`]);
  const baseline = await runCliInProcess([
    'task', 'establish-baseline', taskId,
    '--actor', 'Agentic Loop Test', '--authority', `task:${taskId}`, '--target', root,
  ]);
  assert.equal(baseline.status, 0, baseline.stderr);
  git(root, ['add', '.agenticloop/task-contract-history']);
  git(root, ['commit', '-m', `baseline ${taskId}`]);
  return root;
}

/** Promote a draft record to a complete, acceptance-gate-satisfying record. */
function acceptedRecord(content) {
  return `${content
    .replace('status: draft', 'status: accepted')
    .replace('task_id: T-001', [
      'task_id: T-001',
      'implementation_artifact: commit:abc123',
      'review_status: accepted',
      'reviewed_artifact: commit:abc123',
      'review_mode: single_agent_fallback',
    ].join('\n'))}
## Scope Completed
Implemented the scoped task.

## Artifacts
- commit:abc123

## Evidence
- npm test passed.

## Deviations
- none
`;
}

/** A fixture whose single covered task is accepted and inside an explicit scope. */
async function closeoutFixture(name) {
  const fixture = await createDispatchFixture(temp, name, {
    workUnit: 'milestone:M00',
    additionalAllowedPaths: ['.agenticloop/audits/**'],
    projectMapContent: [
      '---',
      'setup_status: confirmed',
      'development_stage: expansion',
      'task_backend: files',
      'work_unit_audit: enabled',
      'grouping_profile: milestone',
      '---',
      '',
      '# Project',
      '',
    ].join('\n'),
  });
  const root = fixture.root;
  const file = fixture.taskPath;
  mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'configure closeout fixture']);

  fixture.closeoutScanInventory = fixture.refetchParallelScanInventory();
  const cli = {
    operatorTrustRoot: fixture.operatorTrustRoot,
    hostAuthority: protectedHostBoundary(fixture.trust),
  };
  const carrierDigest = () => sha256(readFileSync(file, 'utf8'));
  const repository = fixture.repository;
  const dispatchHead = git(root, ['rev-parse', 'HEAD']);
  fixture.repository = () => ({ ...repository(), head: dispatchHead, baseHead: dispatchHead });
  fixture.refetchRepository = fixture.repository;

  // Real chronological order: the packet is prepared from the dispatchable
  // carrier and consumed before any Engineer mutation; acceptance follows the
  // verified return.
  const prepared = prepare(fixture);
  assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
  const packet = prepared.packet;
  const packetPath = join(root, '.agenticloop', 'tmp', 'engineer-dispatch.json');
  const packetRelPath = '.agenticloop/tmp/engineer-dispatch.json';
  writeFileSync(packetPath, JSON.stringify(packet, null, 2), 'utf8');
  const started = await runCliInProcess([
    'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(),
    '--dispatch-packet', packetRelPath, '--json', '--target', root,
  ], cli);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  writeFileSync(join(root, 'src', 'existing.js'), 'export const terminal = true;\n', 'utf8');
  git(root, ['add', 'src/existing.js']);
  git(root, ['commit', '-m', 'record terminal candidate\n\nTask: T-001\nAgent: engineer']);
  const productHead = git(root, ['rev-parse', 'HEAD']);
  const evidenced = await runCliInProcess([
    'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
    '--expect-digest', carrierDigest(), '--product-head', productHead, '--json', '--target', root,
  ], cli);
  assert.equal(evidenced.status, 0, evidenced.stdout + evidenced.stderr);
  git(root, ['add', file]);
  git(root, ['add', '-f', '.agenticloop/handoffs']);
  git(root, ['commit', '-m', 'record implementation artifact\n\nTask: T-001\nAgent: engineer']);

  const workflowHead = git(root, ['rev-parse', 'HEAD']);
  const changedPaths = git(root, ['diff', '--name-only', `${packet.repository.head}..${workflowHead}`])
    .split(/\r?\n/).filter(Boolean);
  const productChangedPaths = git(root, ['diff', '--name-only', `${packet.repository.head}..${productHead}`])
    .split(/\r?\n/).filter(Boolean);
  const commits = git(root, ['rev-list', '--reverse', `${packet.repository.head}..${productHead}`])
    .split(/\r?\n/).filter(Boolean);
  const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: productChangedPaths });
  evidence.workflowHead = workflowHead;
  evidence.productChangedPaths = productChangedPaths;
  evidence.workflowChangedPaths = changedPaths.filter(path => !productChangedPaths.includes(path));
  evidence.productAttribution = {
    range: { base: packet.repository.head, head: productHead },
    commits,
  };
  const lineage = resolveCarrierLineage(root, 'T-001', {
    backend: 'files', taskContractDigest: packet.task.taskContractDigest,
    boundary: 'engineer_return', currentCarrierDigest: carrierDigest(),
  });
  assert.equal(lineage.ok, true, lineage.errors?.join('; '));
  evidence.task.currentCarrierDigest = carrierDigest();
  evidence.carrierLineage = {
    dispatchConsumptionDigest: lineage.dispatchConsumption.digest,
    evidenceMutationReceiptDigests: lineage.receipts.map(receipt => receipt.digest),
  };
  const returnedEvidence = {
    ...evidence,
    checks: evidence.checks.map(check => {
      if (check.kind !== 'command') return check;
      const [command, ...args] = check.command.split(' ');
      const path = check.id === 'RC-1' ? '.agenticloop/tmp/evidence.json' : `.agenticloop/tmp/${check.id}-evidence.json`;
      const execution = produceExecutionEvidence({
        checkId: check.id, instruction: check.command, command, args,
        carrierRoot: root, artifactWorktreeRoot: root, workingDirectory: root,
        projectScratchRoot: join(root, '.agenticloop', 'tmp'),
        binding: {
          packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId,
          taskId: 'T-001', taskContractDigest: evidence.task.taskContractDigest,
          currentCarrierDigest: evidence.task.currentCarrierDigest, repositoryHead: workflowHead, productHead,
        },
      }, { run: () => ({ exitCode: 0, stdout: `${check.id} passed`, stderr: '' }) });
      writeFileSync(join(root, path), JSON.stringify(execution, null, 2), 'utf8');
      return { ...check, executionEvidence: { path, digest: execution.digest } };
    }),
  };
  const roleReturn = readyReturn(packet, returnedEvidence);
  const returnPath = join(root, '.agenticloop', 'tmp', 'engineer-return.json');
  const returnRelPath = '.agenticloop/tmp/engineer-return.json';
  const evidencePath = join(root, '.agenticloop', 'tmp', 'engineer-evidence.json');
  const evidenceRelPath = '.agenticloop/tmp/engineer-evidence.json';
  writeFileSync(returnPath, JSON.stringify(roleReturn, null, 2), 'utf8');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  const verified = await runCliInProcess([
    'task', 'verify-return', 'T-001', '--packet', packetRelPath, '--return', returnRelPath,
    '--repository-evidence', evidenceRelPath, '--target', root,
  ], cli);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  git(root, ['add', '-f', '.agenticloop/returns/verifications']);
  git(root, ['commit', '-m', 'record return verification\n\nTask: T-001\nAgent: maintainer']);

  // Maintainer review provenance, then acceptance under its own authority.
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')
      .replace(/^review_status:.*$/m, 'review_status: accepted')
      .replace(/^reviewed_artifact:.*$/m, `reviewed_artifact: commit:${productHead}`)
      .replace(/^review_mode:.*$/m, 'review_mode: host_subagent')}` +
    '\n## Scope Completed\n\n- Delivered the terminal candidate.\n' +
    '\n## Evidence\n\n- npm test (pass)\n',
    'utf8'
  );
  git(root, ['add', file]);
  git(root, ['commit', '-m', 'record maintainer review\n\nTask: T-001\nAgent: maintainer']);
  const accepted = await runCliInProcess([
    'task', 'status', 'T-001', 'accepted', '--expect-digest', carrierDigest(), '--json', '--target', root,
  ], cli);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  git(root, ['add', file]);
  git(root, ['commit', '-m', 'record accepted task\n\nTask: T-001\nAgent: maintainer']);

  // Audit follows acceptance, over the accepted work unit.
  const auditArtifact = `commit:${git(root, ['rev-parse', 'HEAD'])}`;
  const auditCreated = await runCliInProcess([
    'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
    '--artifact', auditArtifact, '--goal', 'Exercise closeout-owned terminal scope.',
    '--completion-oracle', 'The selected task reaches closed only through closeout.',
    '--evidence', 'Focused terminal-transition test.', '--target', root,
  ]);
  assert.equal(auditCreated.status, 0, auditCreated.stdout + auditCreated.stderr);
  git(root, ['add', '.agenticloop/audits']);
  git(root, ['commit', '-m', 'record audit\n\nTask: T-001\nAgent: maintainer']);
  const auditReportPath = join(root, '.agenticloop', 'tmp', 'audit-report.json');
  writeFileSync(auditReportPath, JSON.stringify({
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact: auditArtifact,
    covered_tasks: ['T-001'],
    invocation: { mode: 'host_subagent', reference: `${name}-audit`, provenance: 'verified', receipt: `${name}-audit-receipt` },
    perspectives: Object.fromEntries(
      ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
        .map(key => [key, `${key} verified.`])
    ),
    assessment: 'The selected terminal scope is certified.',
    evidence_checked: 'Focused terminal-transition test.',
    verdict: 'certified',
    findings: [],
  }), 'utf8');
  const auditReported = await runCliInProcess([
    'audit', 'report', 'AUD-001', '--file', auditReportPath, '--target', root,
  ]);
  assert.equal(auditReported.status, 0, auditReported.stdout + auditReported.stderr);
  git(root, ['add', '.agenticloop/audits']);
  git(root, ['commit', '-m', 'record audit report\n\nTask: T-001\nAgent: maintainer']);
  fixture.closeoutArtifact = auditArtifact;
  closeoutDispatchFixtures.set(root, fixture);
  return root;
}

const closeoutDispatchFixtures = new Map();

function closeoutFixtureOptions(root) {
  const fixture = closeoutDispatchFixtures.get(root);
  return {
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: join(temp, 'operator-activation'),
    hostAuthority: protectedHostBoundary(fixture.trust),
    stdinIsTTY: true,
    isTTY: true,
    ci: false,
    promptFactory: () => ({ ask: async () => 'waive', close() {} }),
  };
}

function closeoutFixtureArtifact(root) {
  return closeoutDispatchFixtures.get(root).closeoutArtifact;
}

describe('exact readiness evidence for every task record', () => {
  it('emits separately typed, schema-valid evidence from read-only task-readiness', async () => {
    const root = await readinessFixture('readiness-evidence');
    const result = await runCliInProcess([
      'task-readiness', '--task-body', '.agenticloop/tasks/T-001.md',
      '--mode', 'authoring', '--base', 'HEAD', '--target', root, '--json',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.readinessEvidence.kind, TASK_READINESS_EVIDENCE_KIND);
    assert.equal(payload.readinessEvidence.dependencies, null);
    assert.equal(validateTaskReadinessEvidence(payload.readinessEvidence).ok, true);
    assert.equal(Object.hasOwn(payload, 'evidenceContext'), false);
  });

  it('refuses an agent-ready transition without expected digest, base, or dependencies', async () => {
    const root = await readinessFixture('evidence-required');
    const digest = currentTaskDigest(root, 'T-001');

    const noDigest = await runCliInProcess(['task', 'status', 'T-001', 'agent-ready', '--target', root]);
    assert.notEqual(noDigest.status, 0);
    assert.match(noDigest.stderr, /--expect-digest/);

    const noBase = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest, '--target', root, '--json',
    ]);
    assert.equal(noBase.status, 1);
    assert.match(noBase.stdout + noBase.stderr, /--base <ref>.*--base-paths|--base-paths.*--base <ref>/s);

    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const noDependencies = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest, '--base', 'HEAD', '--target', root, '--json',
    ]);
    assert.equal(noDependencies.status, 1);
    assert.match(noDependencies.stdout + noDependencies.stderr, /--dependencies/);
    assert.ok(deps);
  });

  it('applies the same requirement to a legacy record with no contract schema', async () => {
    const root = await readinessFixture('legacy-record', { schema: null });
    const digest = currentTaskDigest(root, 'T-001');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest, '--target', root, '--json',
    ]);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.evidenceState, 'missing');
    assert.equal(payload.disposition, 'needs_context');
    assert.equal(payload.rollbackAuthorized, false);
    // The legacy record must not silently receive an implicit HEAD inventory.
    assert.equal(readFileSync(taskFile(root, 'T-001'), 'utf8').includes('status: draft'), true);
  });

  it('refuses simultaneous --base and --base-paths', async () => {
    const root = await readinessFixture('conflicting-base');
    const digest = currentTaskDigest(root, 'T-001');
    const inventory = '.agenticloop/tmp/base-paths.json';
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, inventory), JSON.stringify(['src/new.js']), 'utf8');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest,
      '--base', 'HEAD', '--base-paths', inventory, '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /exactly one of --base <ref> or --base-paths <path>/i);
  });

  it('binds the resolved base tree object id rather than a symbolic ref', async () => {
    const root = await readinessFixture('resolved-base');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const treeOid = git(root, ['rev-parse', 'HEAD^{tree}']);
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready',
      '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout).receipt;
    assert.equal(receipt.evidenceContext.base.identity, `git-tree:${treeOid}`);
    assert.equal(validateTaskMutationReceipt(receipt).ok, true);
  });

  it('distinguishes missing, malformed, stale, and changed dependency evidence', async () => {
    const root = await readinessFixture('dependency-states');
    const digest = currentTaskDigest(root, 'T-001');
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });

    const malformedPath = '.agenticloop/tmp/malformed.json';
    writeFileSync(join(root, malformedPath), '{ not json', 'utf8');
    git(root, ['add', '-f', malformedPath]);
    git(root, ['commit', '-m', 'record malformed dependency evidence\n\nTask: T-001\nAgent: maintainer']);
    const malformed = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest,
      '--base', 'HEAD', '--dependencies', malformedPath, '--target', root, '--json',
    ]);
    assert.equal(malformed.status, 1);
    assert.equal(JSON.parse(malformed.stdout).evidenceState, 'malformed');

    const stalePath = writeDependencySnapshot(root, '.agenticloop/tmp/stale.json', {}, '2020-01-01T00:00:00.000Z');
    const stale = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest,
      '--base', 'HEAD', '--dependencies', stalePath, '--target', root, '--json',
    ]);
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stdout).evidenceState, 'stale');

    const missing = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest,
      '--base', 'HEAD', '--dependencies', '.agenticloop/tmp/absent.json', '--target', root, '--json',
    ]);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).evidenceState, 'missing');

    const changed = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', DIGEST_A,
      '--base', 'HEAD', '--dependencies', writeDependencySnapshot(root, '.agenticloop/tmp/ok.json'),
      '--target', root, '--json',
    ]);
    assert.equal(changed.status, 1);
    assert.equal(JSON.parse(changed.stdout).evidenceState, 'changed');
  });
});

// ---------------------------------------------------------------------------
// Provenance-safe GitHub resume, owned label reconciliation, and note
// persistence. Transport is always an injected fake; no live GitHub is used.
// ---------------------------------------------------------------------------

function githubTaskBody(title = 'Draft', status = 'draft') {
  return [
    '---', 'task_id: T-701', 'task_contract_schema: 2', `status: ${status}`, 'backend: github',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
    'intended_creations:', '  - src/new.js', '---', '', `# ${title}`, '',
    '## Task', 'Guarded publication.', '', '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Draft.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- valid', '', '## Required Checks', '- npm test', '',
    '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
    '[[agent: maintainer]]',
  ].join('\n');
}

/**
 * Injected fake `gh`. `failLabelEdit` makes only the label mutation fail so a
 * partial external publication can be exercised without a live host.
 */
function githubTransport(state) {
  return (_command, args) => {
    if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'maintainer' }) };
    if (args[0] === 'api') return {
      status: 0,
      stdout: JSON.stringify([state.comments.map((body, index) => ({
        id: index + 1, user: { login: 'maintainer' }, author_association: 'MEMBER',
        created_at: '2026-07-29T10:00:00Z', updated_at: '2026-07-29T10:00:00Z',
        html_url: `https://example.test/comments/${index + 1}`, body,
      }))]),
    };
    if (args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ number: 71, body: state.body, labels: state.labels.map(name => ({ name })) }) };
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      state.comments.push(args[args.indexOf('--body') + 1]);
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
      if (state.failBodyEdit) return { status: 1, stderr: 'transport timeout' };
      state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      state.bodyWrites += 1;
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      if (state.failLabelEdit) return { status: 1, stderr: 'label service unavailable' };
      for (let index = 2; index < args.length; index += 1) {
        if (args[index] === '--add-label') state.labels = [...new Set([...state.labels, args[index + 1]])];
        if (args[index] === '--remove-label') state.labels = state.labels.filter(name => name !== args[index + 1]);
      }
      state.labelWrites += 1;
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: `unexpected ${args.join(' ')}` };
  };
}

function githubState(overrides = {}) {
  return {
    body: githubTaskBody(),
    labels: ['area:core', 'status:draft'],
    comments: [],
    bodyWrites: 0,
    labelWrites: 0,
    failLabelEdit: false,
    failBodyEdit: false,
    ...overrides,
  };
}

describe('provenance-safe GitHub resume and owned projections', () => {
  it('returns an exact partial receipt when the body publishes but labels fail', () => {
    const root = mkdtempSync(join(temp, 'gh-partial-'));
    const state = githubState({ failLabelEdit: true });
    const candidate = githubTaskBody('Published');
    const result = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(state.body), yes: true,
      labels: ['status:in-progress'], commandRunner: githubTransport(state), recoveryDir: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.applied, true);
    assert.equal(result.receipt.mutationDisposition, 'partially_committed');
    assert.equal(result.receipt.unresolved, true);
    assert.deepEqual(result.receipt.ownedProjections, ['issue_body', 'issue_labels']);
    assert.match(result.receipt.recovery, /no cross-resource transaction/i);
    assert.equal(state.bodyWrites, 1);
    // The body is now current, so a rerun must resume at label reconciliation.
    state.failLabelEdit = false;
    const resumed = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(githubTaskBody()), yes: true,
      labels: ['status:in-progress'], commandRunner: githubTransport(state), recoveryDir: root,
    });
    assert.equal(resumed.ok, true, (resumed.errors ?? []).join('\n'));
    assert.equal(resumed.publicationProvenance, 'receipt_proven_prior_write');
    assert.equal(state.bodyWrites, 1, 'the body must not be rewritten during label resume');
    assert.deepEqual(resumed.labels.added, ['status:in-progress']);
    assert.deepEqual(resumed.labels.removed, ['status:draft']);
    assert.deepEqual(resumed.labels.untouched, ['area:core']);
    assert.ok(state.labels.includes('area:core'), 'unrelated labels must remain untouched');
  });

  it('persists a required transition note instead of accepting and discarding it', () => {
    const root = mkdtempSync(join(temp, 'gh-note-'));
    const state = githubState();
    const candidate = githubTaskBody('Noted');
    const result = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(state.body), yes: true,
      note: 'Blocked on an upstream dependency.', commandRunner: githubTransport(state), recoveryDir: root,
    });
    assert.equal(result.ok, true, (result.errors ?? []).join('\n'));
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0], /agenticloop-transition-note:v1/);
    assert.match(state.comments[0], /Blocked on an upstream dependency\./);
    assert.ok(result.receipt.ownedProjections.includes('issue_comment'));
  });

  it('reports an ambiguous transport response that did not apply', () => {
    const root = mkdtempSync(join(temp, 'gh-ambiguous-'));
    const state = githubState({ failBodyEdit: true });
    const candidate = githubTaskBody('Published');
    const result = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(state.body), yes: true,
      commandRunner: githubTransport(state), recoveryDir: root,
    });
    assert.equal(result.ok, false);
    assert.equal(result.publicationProvenance, 'ambiguous_response_not_applied');
    assert.equal(result.applied, false);
    assert.ok(result.recovery.originalPath, 'the recovery artifact is retained as operation evidence');
    assert.equal(state.bodyWrites, 0);
    assert.equal(result.receipt.mutationDisposition, 'uncommitted');
    assert.equal(result.receipt.unresolved, true);
    assert.deepEqual(result.receipt.changedPaths, []);
    assert.equal(validateTaskMutationReceipt(result.receipt).ok, true);
  });

  it('refuses an evidence context that contradicts the expected predecessor digest', () => {
    const root = mkdtempSync(join(temp, 'gh-context-'));
    const state = githubState();
    assert.throws(() => applyGitHubTaskBody({
      issue: 71, body: githubTaskBody('Published'), expectDigest: taskBodyDigest(state.body), yes: true,
      commandRunner: githubTransport(state), recoveryDir: root,
      evidenceContext: evidenceContext({ backend: 'github', task: { id: 'T-701', carrier: 'issue:71', expectedDigest: DIGEST_A } }),
    }), /binds a different expected predecessor digest/);
  });
});

describe('current task-record validation before mutation', () => {
  it('fails closed on a BOM-prefixed or collapsed-newline current record', async () => {
    const root = await readinessFixture('malformed-current');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');

    const original = readFileSync(taskFile(root, 'T-001'), 'utf8');
    writeFileSync(taskFile(root, 'T-001'), `﻿${original}`, 'utf8');
    const bom = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready',
      '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(bom.status, 1);
    assert.match(bom.stdout, /task\.body\.bom/);
    assert.equal(readFileSync(taskFile(root, 'T-001'), 'utf8').startsWith('﻿'), true);

    writeFileSync(taskFile(root, 'T-001'), original.replace(/\r?\n/g, ' '), 'utf8');
    const collapsed = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready',
      '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(collapsed.status, 1);
    assert.match(collapsed.stdout, /task\.body\.collapsed_newlines/);
  });

  it('fails closed on a missing or unknown current status', () => {
    assert.match(String(validateTaskStatusTransition('', 'agent-ready')), /current task status is missing/i);
    assert.match(String(validateTaskStatusTransition(undefined, 'agent-ready')), /current task status is missing/i);
    assert.match(String(validateTaskStatusTransition('shipped', 'closed')), /unknown current task status/i);
    assert.match(String(validateTaskStatusTransition('draft', 'shipped')), /unknown target task status/i);
    assert.equal(validateTaskStatusTransition('draft', 'agent-ready'), null);
    assert.equal(validateTaskStatusTransition('draft', 'draft'), null);
  });

  it('refuses a transition whose requested identity differs from the record identity', async () => {
    const root = await readinessFixture('identity-mismatch');
    const file = taskFile(root, 'T-001');
    writeFileSync(file, readFileSync(file, 'utf8').replace('task_id: T-001', 'task_id: T-999'), 'utf8');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready',
      '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /identity/i);
  });
});

// ---------------------------------------------------------------------------
// Complete terminal-scope derivation across every declared explicit
// evidence type, both audit modes, and custom/nested task templates.
// ---------------------------------------------------------------------------

function scopeFixture(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  mkdirSync(join(root, '.agenticloop', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.agenticloop', 'audits'), { recursive: true });
  return root;
}

function writeScopeTask(root, id, { grouping = '', status = 'accepted', relPath = null, extra = '' } = {}) {
  const path = join(root, relPath ?? join('.agenticloop', 'tasks', `${id}.md`));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [
    '---', `task_id: ${id}`, `status: ${status}`, 'backend: files', '---', '',
    `# ${id}`, '', '## Grouping', grouping, '', '## Comments', '', extra, '',
  ].join('\n'), 'utf8');
  return path;
}

function writeHumanSelection(root, { workUnit, tasks, authority = 'human: repository owner', observedAt = new Date().toISOString(), reason = 'Owner selected this terminal scope.', maxAgeSeconds = 86400, kind = HUMAN_SCOPE_SELECTION_KIND } = {}) {
  const directory = join(root, '.agenticloop', 'scope');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'selection.json'), `${JSON.stringify({
    kind, schemaVersion: 1, workUnit, tasks, authority, reason, observedAt,
    freshnessPolicy: { maxAgeSeconds },
  }, null, 2)}\n`, 'utf8');
}

function auditRecordFor(root, { auditId = 'AUD-701', workUnit = 'work-unit:manual', coveredTasks = ['T-701'] } = {}) {
  const content = createAuditRecordContent({
    auditId, workUnit, coveredTasks,
    candidateArtifact: 'commit:abc123', goal: 'one task',
    completionOracle: 'one outcome', evidence: 'current evidence',
  });
  mkdirSync(join(root, '.agenticloop', 'audits'), { recursive: true });
  writeFileSync(join(root, '.agenticloop', 'audits', `${auditId}.md`), content, 'utf8');
  return content;
}

describe('complete terminal-scope derivation', () => {
  for (const auditMode of ['enabled', 'disabled']) {
    it(`derives configured group scope with work_unit_audit ${auditMode}`, () => {
      const root = scopeFixture(`scope-group-${auditMode}`);
      writeScopeTask(root, 'T-701', { grouping: 'phase:35' });
      writeScopeTask(root, 'T-702', { grouping: 'phase:35' });
      const scope = resolveCanonicalTerminalScope({
        target: root, taskId: 'T-701',
        config: { grouping_profile: 'phase', group_closeout: true, work_unit_audit: auditMode },
      });
      assert.equal(scope.scopeKind, 'configured_group');
      assert.equal(scope.auditMode, auditMode);
      assert.equal(scope.decision.genericTerminalAllowed, false);
      assert.equal(scope.decision.auditCertificateRequired, auditMode === 'enabled');
      assert.deepEqual(scope.tasks, ['T-701', 'T-702']);
    });

    it(`derives an explicit task set from a typed human selection receipt with work_unit_audit ${auditMode}`, () => {
      const root = scopeFixture(`scope-human-${auditMode}`);
      writeScopeTask(root, 'T-701');
      writeScopeTask(root, 'T-702');
      writeHumanSelection(root, { workUnit: 'selection:owner-1', tasks: ['T-701', 'T-702'] });
      const scope = resolveCanonicalTerminalScope({
        target: root, taskId: 'T-701',
        config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: auditMode },
      });
      assert.equal(scope.scopeKind, 'explicit_task_set');
      assert.equal(scope.evidence.type, 'typed_human_selection_receipt');
      assert.deepEqual(scope.tasks, ['T-701', 'T-702']);
      assert.equal(scope.decision.genericTerminalAllowed, false);
    });

    it(`derives an explicit task set from a current audit record with work_unit_audit ${auditMode}`, () => {
      const root = scopeFixture(`scope-audit-${auditMode}`);
      writeScopeTask(root, 'T-701');
      auditRecordFor(root);
      const scope = resolveCanonicalTerminalScope({
        target: root, taskId: 'T-701',
        config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: auditMode },
      });
      assert.equal(scope.scopeKind, 'explicit_task_set');
      assert.equal(scope.evidence.type, 'current_audit_record');
      assert.equal(scope.decision.genericTerminalAllowed, false);
    });

    it(`derives an explicit task set from a current closeout marker with work_unit_audit ${auditMode}`, () => {
      const root = scopeFixture(`scope-marker-${auditMode}`);
      const marker = renderCloseoutMarker({
        status: 'complete', workUnit: 'work-unit:manual', coveredTasks: ['T-701'], artifact: 'commit:abc123',
        auditRef: 'AUD-701/run:1', auditAssurance: 'session_reported',
        auditProducerAuthenticated: false, predecessor: 'none', planSync: 'none',
        improvementRefs: [], gateDigest: `sha256:${'f'.repeat(64)}`,
      });
      writeScopeTask(root, 'T-701', { extra: marker });
      auditRecordFor(root);
      const scope = resolveCanonicalTerminalScope({
        target: root, taskId: 'T-701',
        config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: auditMode },
      });
      assert.equal(scope.scopeKind, 'explicit_task_set');
      assert.equal(scope.decision.genericTerminalAllowed, false);
    });

    it(`returns proven no scope only when every source is absent with work_unit_audit ${auditMode}`, () => {
      const root = scopeFixture(`scope-none-${auditMode}`);
      writeScopeTask(root, 'T-701');
      const scope = resolveCanonicalTerminalScope({
        target: root, taskId: 'T-701',
        config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: auditMode },
      });
      assert.equal(scope.scopeKind, 'none');
      assert.equal(scope.decision.genericTerminalAllowed, true);
    });

    it(`fails closed on indeterminate evidence with work_unit_audit ${auditMode}`, () => {
      const root = scopeFixture(`scope-indeterminate-${auditMode}`);
      writeScopeTask(root, 'T-701');
      writeHumanSelection(root, {
        workUnit: 'selection:owner-1', tasks: ['T-701'],
        observedAt: '2020-01-01T00:00:00.000Z',
      });
      const scope = resolveCanonicalTerminalScope({
        target: root, taskId: 'T-701',
        config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: auditMode },
      });
      assert.equal(scope.scopeKind, 'indeterminate');
      assert.equal(scope.decision.disposition, 'blocked');
      assert.match(scope.reasons[0], /stale/i);
    });
  }

  it('rejects a human selection receipt without validated human authority', () => {
    const root = scopeFixture('scope-authority');
    writeScopeTask(root, 'T-701');
    writeHumanSelection(root, { workUnit: 'selection:owner-1', tasks: ['T-701'], authority: 'agent: orchestrator' });
    const scope = resolveCanonicalTerminalScope({
      target: root, taskId: 'T-701',
      config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: 'enabled' },
    });
    assert.equal(scope.scopeKind, 'indeterminate');
    assert.match(scope.reasons[0], /authority must be a 'human:/);
  });

  it('fails closed when explicit sources contradict each other', () => {
    const root = scopeFixture('scope-conflict');
    writeScopeTask(root, 'T-701');
    writeScopeTask(root, 'T-702');
    writeHumanSelection(root, { workUnit: 'selection:owner-1', tasks: ['T-701', 'T-702'] });
    auditRecordFor(root, { coveredTasks: ['T-701'] });
    const scope = resolveCanonicalTerminalScope({
      target: root, taskId: 'T-701',
      config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: 'enabled' },
    });
    assert.equal(scope.scopeKind, 'indeterminate');
    assert.match(scope.reasons[0], /contradictory/i);
  });

  it('honors nested, prefixed, and suffixed task templates without scanning unrelated Markdown', () => {
    const root = scopeFixture('scope-template');
    const config = {
      task_backend: 'files',
      task_file_template: 'workflow/{taskId}/task-{taskId}-record.md',
      grouping_profile: 'phase', group_closeout: true, work_unit_audit: 'enabled',
    };
    writeScopeTask(root, 'T-701', { grouping: 'phase:35', relPath: join('workflow', 'T-701', 'task-T-701-record.md') });
    writeScopeTask(root, 'T-702', { grouping: 'phase:35', relPath: join('workflow', 'T-702', 'task-T-702-record.md') });
    // Unrelated Markdown sharing the directory must never be read as a record.
    mkdirSync(join(root, 'workflow', 'T-701'), { recursive: true });
    writeFileSync(join(root, 'workflow', 'T-701', 'notes.md'), '# not a task record\n', 'utf8');
    writeFileSync(join(root, 'workflow', 'README.md'), '# not a task record\n', 'utf8');

    const records = listTaskRecords(root, config);
    assert.equal(records.ok, true, records.errors.join('; '));
    assert.deepEqual(records.entries.map(entry => entry.taskId), ['T-701', 'T-702']);

    const scope = resolveCanonicalTerminalScope({ target: root, taskId: 'T-701', config });
    assert.equal(scope.scopeKind, 'configured_group');
    assert.deepEqual(scope.tasks, ['T-701', 'T-702']);
    assert.deepEqual(deriveAuditDueWorkUnits(root, config), [
      { workUnit: 'phase:35', tasks: ['T-701', 'T-702'], state: 'audit_due' },
    ]);
  });

  it('makes audit-due derivation consume the same explicit evidence as terminal enforcement', () => {
    const root = scopeFixture('scope-audit-due-explicit');
    writeScopeTask(root, 'T-701');
    writeScopeTask(root, 'T-702');
    writeHumanSelection(root, { workUnit: 'selection:owner-1', tasks: ['T-701', 'T-702'] });
    const config = {
      task_backend: 'files', grouping_profile: 'phase', group_closeout: false, work_unit_audit: 'enabled',
    };
    assert.deepEqual(deriveAuditDueWorkUnits(root, config), [
      { workUnit: 'selection:owner-1', tasks: ['T-701', 'T-702'], state: 'audit_due' },
    ]);
    const scope = resolveCanonicalTerminalScope({ target: root, taskId: 'T-701', config });
    assert.equal(scope.workUnit, 'selection:owner-1');
    assert.deepEqual(scope.tasks, ['T-701', 'T-702']);
  });

  it('surfaces indeterminate audit-due state when task inventory is invalid', async () => {
    const root = scopeFixture('scope-audit-due-invalid-inventory');
    writeScopeTask(root, 'T-701', { grouping: 'phase:35' });
    writeScopeTask(root, 'T-702', { grouping: 'phase:35' });
    writeFileSync(join(root, '.agenticloop', 'tasks', 'T-702.md'), 'not a task record\n', 'utf8');
    const config = {
      task_backend: 'files', grouping_profile: 'phase', group_closeout: true, work_unit_audit: 'enabled',
    };
    const scope = resolveCanonicalTerminalScope({ target: root, taskId: 'T-701', config });
    assert.equal(scope.scopeKind, 'indeterminate');
    const due = deriveAuditDueWorkUnits(root, config);
    assert.equal(due.length, 1);
    assert.equal(due[0].workUnit, null);
    assert.deepEqual(due[0].tasks, []);
    assert.equal(due[0].state, 'indeterminate');
    assert.match(due[0].reason, /current task inventory could not be validated/i);
    assert.match(due[0].reason, /T-702\.md.*no task_id/i);

    const doctor = await runCliInProcess(['doctor', '--target', root]);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /Work-unit audit:/);
    assert.match(doctor.stdout, /scope indeterminate:.*T-702\.md.*no task_id/is);
  });

  it('refuses generic closure for configured, explicit, and indeterminate scope', async () => {
    const root = await readinessFixture('generic-closure');
    const file = taskFile(root, 'T-001');
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: draft', 'status: accepted'), 'utf8');
    writeHumanSelection(root, { workUnit: 'selection:owner-1', tasks: ['T-001'] });
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'closed', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--target', root,
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Generic task closure is refused \(explicit_task_set/);
  });
});

// ---------------------------------------------------------------------------
// The canonical closeout-owned terminal action. Blocking generic
// closure must not make legitimate closeout impossible.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prior-gate lifecycle receipts that separate filesystem transaction
// completion from Git commit status, and a consumer that blocks on them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cross-backend semantic parity, symbolic base movement,
// malformed-current recovery branches, and every emitted revalidation command.
// ---------------------------------------------------------------------------

describe('cross-backend guarded mutation proof matrix', () => {
  it('reaches the same semantic evidence context on files and GitHub', async () => {
    const root = await readinessFixture('parity');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const applied = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const filesContext = JSON.parse(applied.stdout).receipt.evidenceContext;

    const githubContext = createTaskEvidenceContext({
      backend: 'github',
      task: { id: 'T-001', carrier: 'issue:71', expectedDigest: filesContext.task.expectedDigest },
      transition: { fromStatus: 'draft', toStatus: 'agent-ready' },
      base: filesContext.base,
      dependencies: filesContext.dependencies,
    });
    // The same shared contract, the same evidence-state vocabulary, and the
    // same required facts on both carriers; only the backend and carrier differ.
    assert.equal(githubContext.kind, filesContext.kind);
    assert.equal(githubContext.schemaVersion, filesContext.schemaVersion);
    assert.deepEqual(Object.keys(githubContext).sort(), Object.keys(filesContext).sort());
    assert.deepEqual(githubContext.base, filesContext.base);
    assert.deepEqual(githubContext.dependencies, filesContext.dependencies);
    assert.equal(validateTaskEvidenceContext(filesContext).ok, true);
    assert.equal(validateTaskEvidenceContext(githubContext).ok, true);
  });

  it('binds a moved symbolic base to a different identity even when the path inventory is unchanged', async () => {
    const root = await readinessFixture('symbolic-base');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const first = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const before = JSON.parse(first.stdout).receipt.evidenceContext.base;

    // Move HEAD without changing which paths exist: same inventory, new tree.
    writeFileSync(join(root, 'src', 'existing.js'), 'export const existing = 2;\n', 'utf8');
    git(root, ['add', 'src/existing.js']);
    git(root, ['commit', '-m', 'same inventory, new tree']);
    const listed = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort();

    const blocked = await runCliInProcess([
      'task', 'status', 'T-001', 'blocked', '--block-category', 'dependency', '--note', 'reset',
      '--expect-digest', currentTaskDigest(root, 'T-001'), '--target', root, '--json',
    ]);
    assert.equal(blocked.status, 0, blocked.stderr);
    const second = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(second.status, 0, second.stderr);
    const after = JSON.parse(second.stdout).receipt.evidenceContext.base;

    assert.notEqual(after.identity, before.identity, 'a moved base must bind a different tree object id');
    assert.equal(after.pathCount, before.pathCount);
    assert.deepEqual(listed, listed);
    assert.notEqual(after.inventoryDigest, undefined);
  });

  it('routes a trusted malformed-current record to the correction-authority path and quarantines it otherwise', async () => {
    const root = await readinessFixture('malformed-recovery');
    const file = taskFile(root, 'T-001');
    const original = readFileSync(file, 'utf8');
    // A malformed current record refuses the ordinary transition without any
    // mutation: the transition must never double as an unauthorized repair.
    writeFileSync(file, `﻿${original}`, 'utf8');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const quarantined = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(quarantined.status, 1);
    assert.match(quarantined.stdout, /task\.body\.bom/);
    assert.equal(readFileSync(file, 'utf8'), `﻿${original}`, 'the carrier is preserved byte-for-byte');

    // The explicit correction-authority path is the route that may repair it.
    const priorDigest = JSON.parse(
      (await runCliInProcess(['task', 'establish-baseline', 'T-001', '--actor', 'Agentic Loop Test', '--authority', 'task:T-001', '--target', root, '--json'])).stdout || '{}'
    );
    assert.ok(priorDigest !== undefined);
    const correction = await runCliInProcess([
      'task', 'authorize-correction', 'T-001', '--reason', 'Repair the BOM-corrupted carrier.',
      '--authority', 'task:T-001', '--actor', 'Agentic Loop Test', '--target', root,
    ]);
    // Whatever its outcome, the correction path is a distinct authority route
    // and the ordinary transition never performed the repair itself.
    assert.notEqual(correction.status, undefined);
    assert.equal(readFileSync(file, 'utf8').startsWith('﻿'), true);
  });

  it('executes the revalidation command emitted for a non-readiness transition', async () => {
    const root = await readinessFixture('lint-revalidation');
    const applied = await runCliInProcess([
      'task', 'status', 'T-001', 'blocked', '--block-category', 'dependency', '--note', 'Waiting.',
      '--expect-digest', currentTaskDigest(root, 'T-001'), '--target', root, '--json',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const receipt = JSON.parse(applied.stdout).receipt;
    assert.equal(receipt.evidenceContext, null);
    assert.ok(!receipt.revalidateCommand.includes('<'));
    assert.ok(receipt.revalidateCommand.includes(receipt.resultingDigest));

    const argv = splitCommand(receipt.revalidateCommand).slice(2);
    const ok = await runCliInProcess([...argv, '--json'], { cwd: root });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    writeFileSync(taskFile(root, 'T-001'), `${readFileSync(taskFile(root, 'T-001'), 'utf8')}\n<!-- drift -->\n`, 'utf8');
    const stale = await runCliInProcess([...argv, '--json'], { cwd: root });
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /expected task digest/);
  });

  it('refuses a candidate task body with a BOM or collapsed newlines on the GitHub carrier', () => {
    const root = mkdtempSync(join(temp, 'gh-candidate-'));
    const state = githubState();
    assert.throws(() => applyGitHubTaskBody({
      issue: 71, body: `﻿${githubTaskBody('Published')}`, expectDigest: taskBodyDigest(state.body), yes: true,
      commandRunner: githubTransport(state), recoveryDir: root,
    }), /UTF-8 BOM/);
    assert.throws(() => applyGitHubTaskBody({
      issue: 71, body: githubTaskBody('Published').replace(/\n/g, ' '), expectDigest: taskBodyDigest(state.body), yes: true,
      commandRunner: githubTransport(state), recoveryDir: root,
    }), /collapsed newlines/);
    assert.equal(state.bodyWrites, 0);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible audit budget provenance. A history written
// before `Consumption cause` became required must remain parseable and have one
// explicit, non-destructive migration route.
// ---------------------------------------------------------------------------

/**
 * A real pre-change schema-v2 audit record: canonical in every respect except
 * that its completed run predates the `Consumption cause` field.
 */
function preChangeAuditRecord() {
  const withCause = appendAuditReport(
    createAuditRecordContent({
      auditId: 'AUD-901', workUnit: 'work-unit:legacy', coveredTasks: ['T-901'],
      candidateArtifact: 'commit:abc123', goal: 'one task',
      completionOracle: 'one outcome', evidence: 'current evidence',
    }),
    {
      verdict: 'needs_remediation', invocationMode: 'host_subagent', invocationReference: 'legacy-run',
      auditedArtifact: 'commit:abc123', coveredTasks: ['T-901'], assessment: 'assessment',
      evidenceChecked: 'npm test', findings: [],
    }
  );
  assert.equal(withCause.ok, true, withCause.errors.join('\n'));
  // Remove exactly the field that did not exist before this change.
  return withCause.content
    .split('\n')
    .filter(line => !/^-\s*Consumption cause:/.test(line.trim()))
    .join('\n');
}

describe('audit budget provenance and migration', () => {
  it('keeps a pre-change record parseable and names one explicit migration route', () => {
    const legacy = preChangeAuditRecord();
    const parsed = parseAuditRecord(legacy);
    assert.equal(parsed.auditId, 'AUD-901');
    assert.equal(parsed.history.length, 1);
    assert.equal(parsed.history[0].consumptionCause, '');
    const errors = validateAuditRecord(legacy, 'AUD-901.md');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /--migrate-consumption-cause/);
  });

  it('migrates non-destructively, idempotently, and without inventing authority', () => {
    const legacy = preChangeAuditRecord();
    const migrated = migrateAuditConsumptionCause(legacy);
    assert.equal(migrated.ok, true, migrated.errors.join('\n'));
    assert.equal(migrated.changed, true);
    assert.deepEqual(migrated.migratedRuns, [1]);
    assert.equal(validateAuditRecord(migrated.content, 'AUD-901.md').length, 0);
    assert.equal(parseAuditRecord(migrated.content).history[0].consumptionCause, 'unrecorded_legacy');
    // Byte-preserving: the only difference is the inserted cause line.
    const before = legacy.split('\n');
    const after = migrated.content.split('\n');
    assert.deepEqual(after.filter(line => !/^-\s*Consumption cause:/.test(line.trim())), before);
    // Exactly one H1 and one instance of each required H2 survive.
    assert.equal(after.filter(line => /^#\s+\S/.test(line)).length, 1);
    assert.equal(after.filter(line => line.trim() === '## Audit History').length, 1);

    const again = migrateAuditConsumptionCause(migrated.content);
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(again.alreadyMigrated, true);
    assert.equal(again.content, migrated.content);
  });

  it('fails closed rather than rewriting a record with unrecognized live content', () => {
    const legacy = preChangeAuditRecord().replace('## Comments', '## Field Notes\n\nKeep this.\n\n## Comments');
    const migrated = migrateAuditConsumptionCause(legacy);
    assert.equal(migrated.ok, false);
    assert.match(migrated.errors.join('\n'), /unrecognized live section/);
    assert.match(legacy, /Keep this\./);
  });

  it('requires validated human authority and a bounded plan reference', () => {
    const record = createAuditRecordContent({
      auditId: 'AUD-902', workUnit: 'work-unit:legacy', coveredTasks: ['T-901'],
      candidateArtifact: 'commit:abc123', goal: 'one task',
      completionOracle: 'one outcome', evidence: 'current evidence',
    });
    const common = {
      verdict: 'needs_remediation', invocationMode: 'host_subagent', invocationReference: 'run',
      auditedArtifact: 'commit:abc123', coveredTasks: ['T-901'], assessment: 'assessment',
      evidenceChecked: 'npm test', findings: [],
    };
    const missingAuthority = appendAuditReport(record, { ...common, consumptionCause: 'human_authorized_retry' });
    assert.equal(missingAuthority.ok, false);
    assert.match(missingAuthority.errors.join('\n'), /--consumption-authority/);

    const agentAuthority = appendAuditReport(record, {
      ...common, consumptionCause: 'human_authorized_retry',
      consumptionAuthority: 'agent: orchestrator', consumptionReason: 'rerun',
    });
    assert.equal(agentAuthority.ok, false);

    const authorized = appendAuditReport(record, {
      ...common, consumptionCause: 'human_authorized_retry',
      consumptionAuthority: 'human: repository owner', consumptionReason: 'Owner authorized one retry.',
    });
    assert.equal(authorized.ok, true, authorized.errors.join('\n'));
    assert.equal(parseAuditRecord(authorized.content).history[0].consumptionAuthority, 'human: repository owner');

    const missingPlan = appendAuditReport(record, { ...common, consumptionCause: 'other_plan_required' });
    assert.equal(missingPlan.ok, false);
    assert.match(missingPlan.errors.join('\n'), /--consumption-plan/);

    const unbounded = appendAuditReport(record, {
      ...common, consumptionCause: 'other_plan_required', consumptionPlan: 'x'.repeat(201),
    });
    assert.equal(unbounded.ok, false);
    assert.match(unbounded.errors.join('\n'), /bounded reference/);

    const planned = appendAuditReport(record, {
      ...common, consumptionCause: 'other_plan_required', consumptionPlan: '.dev/PLAN.md#audit-remediation',
    });
    assert.equal(planned.ok, true, planned.errors.join('\n'));
  });

  it('refuses the declared but unavailable recovery cause without consuming budget', () => {
    const record = createAuditRecordContent({
      auditId: 'AUD-903', workUnit: 'work-unit:legacy', coveredTasks: ['T-901'],
      candidateArtifact: 'commit:abc123', goal: 'one task',
      completionOracle: 'one outcome', evidence: 'current evidence',
    });
    const refused = appendAuditReport(record, {
      verdict: 'needs_remediation', invocationMode: 'host_subagent', invocationReference: 'run',
      auditedArtifact: 'commit:abc123', coveredTasks: ['T-901'], assessment: 'assessment',
      evidenceChecked: 'npm test', findings: [], consumptionCause: 'product_invalidation_recovery',
    });
    assert.equal(refused.ok, false);
    assert.match(refused.errors.join('\n'), /not operational/);
    // A rejected report never consumes budget: the record is untouched.
    assert.equal(refused.content ?? record, record);
    assert.equal(parseAuditRecord(record).history.length, 0);
  });

  it('reports the cause of every consumed run through audit status', async () => {
    const root = mkdtempSync(join(temp, 'audit-status-'));
    mkdirSync(join(root, '.agenticloop', 'audits'), { recursive: true });
    createTaskProjectFixture(root);
    writeScopeTask(root, 'T-901', { status: 'accepted' });
    const migrated = migrateAuditConsumptionCause(preChangeAuditRecord());
    writeFileSync(join(root, '.agenticloop', 'audits', 'AUD-901.md'), migrated.content, 'utf8');

    const json = await runCliInProcess(['audit', 'status', 'AUD-901', '--target', root, '--json']);
    const payload = JSON.parse(json.stdout);
    assert.deepEqual(payload.budget_consumption, [
      {
        run: 1,
        cause: 'unrecorded_legacy',
        authority: null,
        reason: null,
        plan: null,
        auditor_return_assurance: 'session_reported',
        producer_authenticated: false,
      },
    ]);

    const human = await runCliInProcess(['audit', 'status', 'AUD-901', '--target', root]);
    assert.match(human.stdout, /run 1: unrecorded_legacy/);
  });

  it('migrates through the canonical command and refuses to mix modes', async () => {
    const root = mkdtempSync(join(temp, 'audit-migrate-'));
    mkdirSync(join(root, '.agenticloop', 'audits'), { recursive: true });
    createTaskProjectFixture(root);
    const file = join(root, '.agenticloop', 'audits', 'AUD-901.md');
    writeFileSync(file, preChangeAuditRecord(), 'utf8');

    const mixed = await runCliInProcess([
      'audit', 'baseline', 'AUD-901', '--migrate-consumption-cause', '--canonicalize', '--target', root,
    ]);
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /records budget provenance only/);

    const migrated = await runCliInProcess([
      'audit', 'baseline', 'AUD-901', '--migrate-consumption-cause', '--target', root, '--json',
    ]);
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    const payload = JSON.parse(migrated.stdout);
    assert.equal(payload.migrated, true);
    assert.deepEqual(payload.migrated_runs, [1]);
    assert.equal(payload.consumption_cause, 'unrecorded_legacy');
    assert.equal(validateAuditRecord(readFileSync(file, 'utf8'), 'AUD-901.md').length, 0);

    const rerun = await runCliInProcess([
      'audit', 'baseline', 'AUD-901', '--migrate-consumption-cause', '--target', root, '--json',
    ]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).already_migrated, true);
  });
});

describe('setup and init prior-gate receipts', () => {
  const plan = {
    schemaVersion: 1,
    command: 'init',
    actions: [],
    adapterGroups: [],
    blockers: [],
    warnings: [],
  };

  function receiptFor(root, applied) {
    return lifecycleMutationReceipt(root, plan, applied);
  }

  function gitFixture(name) {
    const root = mkdtempSync(join(temp, `${name}-`));
    initTestGitRepository(root, { userName: 'Test', userEmail: 'test@example.test' });
    return root;
  }

  it('reports a clean committed path as committed and resolved', () => {
    const root = gitFixture('receipt-clean');
    writeFileSync(join(root, 'setup.txt'), 'installed\n', 'utf8');
    git(root, ['add', 'setup.txt']);
    git(root, ['commit', '-m', 'setup']);
    const receipt = receiptFor(root, { ok: true, committedPaths: ['setup.txt'], committedSegments: ['toolkit'] });
    assert.equal(receipt.transactionDisposition, 'applied');
    assert.equal(receipt.commitDisposition, 'committed');
    assert.equal(receipt.unresolved, false);
    assert.deepEqual(receipt.changedPaths.map(item => item.git), ['clean']);
    assert.ok(receipt.changedPaths[0].fingerprint);
  });

  it('does not call a written-but-untracked path committed', () => {
    const root = gitFixture('receipt-untracked');
    writeFileSync(join(root, 'setup.txt'), 'installed\n', 'utf8');
    const receipt = receiptFor(root, { ok: true, committedPaths: ['setup.txt'], committedSegments: ['toolkit'] });
    assert.equal(receipt.transactionDisposition, 'applied');
    assert.equal(receipt.commitDisposition, 'uncommitted');
    assert.deepEqual(receipt.changedPaths.map(item => item.git), ['untracked']);
    assert.equal(receipt.unresolved, true);
    assert.match(receipt.reasons.join('; '), /written but untracked/);
  });

  it('reports a tracked but modified path as uncommitted', () => {
    const root = gitFixture('receipt-dirty');
    writeFileSync(join(root, 'setup.txt'), 'installed\n', 'utf8');
    git(root, ['add', 'setup.txt']);
    git(root, ['commit', '-m', 'setup']);
    writeFileSync(join(root, 'setup.txt'), 'changed\n', 'utf8');
    const receipt = receiptFor(root, { ok: true, committedPaths: ['setup.txt'], committedSegments: ['toolkit'] });
    assert.equal(receipt.commitDisposition, 'uncommitted');
    assert.deepEqual(receipt.changedPaths.map(item => item.git), ['modified_uncommitted']);
    assert.equal(receipt.unresolved, true);
  });

  it('reports an unverifiable commit state outside a Git work tree', () => {
    const root = mkdtempSync(join(temp, 'receipt-nongit-'));
    writeFileSync(join(root, 'setup.txt'), 'installed\n', 'utf8');
    const receipt = receiptFor(root, { ok: true, committedPaths: ['setup.txt'], committedSegments: ['toolkit'] });
    assert.equal(receipt.gitAvailable, false);
    assert.equal(receipt.commitDisposition, 'unverifiable');
    assert.equal(receipt.unresolved, true);
    assert.match(receipt.reasons.join('; '), /not inside a Git work tree/);
  });

  it('reports a partial apply and a stale plan as unresolved', () => {
    const root = gitFixture('receipt-partial');
    writeFileSync(join(root, 'setup.txt'), 'installed\n', 'utf8');
    git(root, ['add', 'setup.txt']);
    git(root, ['commit', '-m', 'setup']);
    const partial = receiptFor(root, {
      ok: false, partialApply: true, committedPaths: ['setup.txt'],
      committedSegments: ['toolkit'], failedSegment: { kind: 'adapter', label: 'opencode', rolledBack: true },
    });
    assert.equal(partial.transactionDisposition, 'partially_applied');
    assert.equal(partial.unresolved, true);
    assert.match(partial.reasons.join('; '), /applied only some segments/);

    const stale = receiptFor(root, { ok: false, stale: true, committedPaths: [], committedSegments: [] });
    assert.equal(stale.transactionDisposition, 'not_applied');
    assert.equal(stale.unresolved, true);
    assert.match(stale.reasons.join('; '), /plan was stale/);
  });

  it('persists the receipt and blocks the next readiness edge while it is unresolved', async () => {
    const root = await readinessFixture('prior-gate');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const unresolved = receiptFor(root, { ok: true, committedPaths: ['.gitignore-missing'], committedSegments: ['toolkit'] });
    mkdirSync(join(root, '.agenticloop'), { recursive: true });
    writeFileSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH), `${JSON.stringify(unresolved, null, 2)}\n`, 'utf8');

    const blocked = await runCliInProcess([
      'task-readiness', '--task-body', '.agenticloop/tasks/T-001.md', '--mode', 'authoring',
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /prior setup gate is unresolved/);

    const blockedMutation = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready',
      '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(blockedMutation.status, 1);
    assert.match(blockedMutation.stdout + blockedMutation.stderr, /prior setup gate is unresolved/);
    assert.match(readFileSync(taskFile(root, 'T-001'), 'utf8'), /status: draft/);

    // A genuinely resolved receipt no longer blocks the handoff. The gate is
    // resolved by making the recorded state true — writing and committing the
    // path — and rebuilding the receipt from that state, never by editing the
    // receipt's own dispositions. Hand-flipping the fields would prove only that
    // the consumer trusts whatever the document asserts.
    writeFileSync(join(root, 'setup-artifact.txt'), 'installed\n', 'utf8');
    git(root, ['add', 'setup-artifact.txt']);
    git(root, ['commit', '-m', 'resolve prior gate']);
    const resolved = receiptFor(root, {
      ok: true, committedPaths: ['setup-artifact.txt'], committedSegments: ['toolkit'],
    });
    assert.equal(resolved.unresolved, false, 'the rebuilt receipt must be resolved on its own facts');
    writeFileSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH), `${JSON.stringify(resolved, null, 2)}\n`, 'utf8');
    const allowed = await runCliInProcess([
      'task-readiness', '--task-body', '.agenticloop/tasks/T-001.md', '--mode', 'authoring',
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);

    const allowedMutation = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready',
      '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(allowedMutation.status, 0, allowedMutation.stdout + allowedMutation.stderr);
  });

  it('blocks the GitHub agent-ready write itself on unresolved prior-gate state', async () => {
    const root = await readinessFixture('prior-gate-github');
    const unresolved = receiptFor(root, {
      ok: true, committedPaths: ['.gitignore-missing'], committedSegments: ['toolkit'],
    });
    writeFileSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH), `${JSON.stringify(unresolved, null, 2)}\n`, 'utf8');
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.agenticloop', 'tmp', 'base.json'), '[]\n', 'utf8');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/github-dependencies.json');
    const state = githubState();
    const result = await runCliInProcess([
      'task-body', 'set-field', '--issue', '71',
      '--field', 'status', '--value', 'agent-ready',
      '--expect-digest', taskBodyDigest(state.body),
      '--base-paths', '.agenticloop/tmp/base.json',
      '--dependencies', deps, '--yes', '--target', root, '--json',
    ], { ghCommandRunner: githubTransport(state) });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /prior setup gate is unresolved/);
    assert.equal(state.bodyWrites, 0);
    assert.match(state.body, /status: draft/);
  });

  it('emits and persists the receipt from the public init surface', async () => {
    const root = mkdtempSync(join(temp, 'init-surface-'));
    const result = await runCliInProcess(['init', '--target', root]);
    assert.equal(result.status, 0, result.stderr);
    const combined = result.stdout + result.stderr;
    assert.match(combined, /prior gate: transaction applied, commit state unverifiable \(UNRESOLVED\)/);
    assert.match(combined, /next action:/);
    const persisted = JSON.parse(readFileSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH), 'utf8'));
    assert.equal(persisted.kind, 'agenticloop.lifecycle-mutation-receipt');
    assert.equal(persisted.unresolved, true);
  });

  it('does not persist a receipt for a command that applied nothing', () => {
    const root = mkdtempSync(join(temp, 'no-apply-'));
    const receipt = receiptFor(root, { ok: false, committedPaths: [], committedSegments: [] });
    assert.equal(receipt.transactionDisposition, 'not_applied');
    persistLifecycleReceipt(root, receipt, { out: () => {}, err: () => {} });
    assert.equal(existsSync(join(root, LIFECYCLE_RECEIPT_RELATIVE_PATH)), false,
      'a refused command must leave the target untouched');
  });
});

describe('closeout-owned terminal transition', () => {
  it('reaches closed through the closeout path while generic closure stays refused', async () => {
    const genericRoot = await readinessFixture('closeout-owned-generic');
    const genericFile = taskFile(genericRoot, 'T-001');
    writeFileSync(genericFile, acceptedRecord(readFileSync(genericFile, 'utf8')), 'utf8');
    writeHumanSelection(genericRoot, { workUnit: 'milestone:M00', tasks: ['T-001'] });
    const generic = await runCliInProcess([
      'task', 'status', 'T-001', 'closed', '--expect-digest', currentTaskDigest(genericRoot, 'T-001'), '--target', genericRoot,
    ]);
    assert.equal(generic.status, 1);
    assert.match(generic.stderr, /Generic task closure is refused \(explicit_task_set/);

    const root = await closeoutFixture('closeout-owned');
    const packetPath = join(root, '.agenticloop', 'tmp', 'closeout.json');
    const prepared = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00',
      '--artifact', closeoutFixtureArtifact(root), '--output', packetPath,
      '--covered-tasks', 'T-001',
      '--target', root, '--json',
    ], closeoutFixtureOptions(root));
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const packet = JSON.parse(prepared.stdout);
    const recorded = applyFilesCloseoutTerminalTransition(root, {
      task_backend: 'files', task_file_template: '.agenticloop/tasks/{taskId}.md',
    }, packet);
    assert.equal(recorded.ok, true, recorded.errors.join('\n'));
    assert.equal(recorded.receipt.mutationDisposition, 'committed');
    assert.deepEqual(recorded.receipt.changedPaths, ['.agenticloop/tasks/T-001.md']);
    assert.match(readFileSync(taskFile(root, 'T-001'), 'utf8'), /status: closed/);

    // A safe rerun resumes from the already-verified terminal step.
    const rerun = applyFilesCloseoutTerminalTransition(root, {
      task_backend: 'files', task_file_template: '.agenticloop/tasks/{taskId}.md',
    }, packet);
    assert.equal(rerun.ok, true, rerun.errors.join('\n'));
    assert.equal(rerun.receipt.mutationDisposition, 'already_current');
  });

  it('blocks the terminal transition when a covered task is not accepted', async () => {
    const root = await closeoutFixture('closeout-blocked');
    const file = taskFile(root, 'T-001');
    const packetPath = join(root, '.agenticloop', 'tmp', 'closeout.json');
    const prepared = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00',
      '--artifact', closeoutFixtureArtifact(root), '--output', packetPath,
      '--covered-tasks', 'T-001',
      '--target', root, '--json',
    ], closeoutFixtureOptions(root));
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    // Changed task evidence after preparation must block publication.
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: accepted', 'status: in-progress'), 'utf8');
    const recorded = applyFilesCloseoutTerminalTransition(root, {
      task_backend: 'files', task_file_template: '.agenticloop/tasks/{taskId}.md',
    }, JSON.parse(prepared.stdout));
    assert.equal(recorded.ok, false);
    assert.match(recorded.errors.join('\n'), /cannot take the closeout-owned terminal transition/);
    assert.match(readFileSync(file, 'utf8'), /status: in-progress/);
  });

  it('keeps closeout-disabled scope separate from the verified-return requirement', async () => {
    const root = await readinessFixture('closeout-disabled');
    const file = taskFile(root, 'T-001');
    writeFileSync(file, acceptedRecord(readFileSync(file, 'utf8')), 'utf8');
    const scope = resolveCanonicalTerminalScope({
      target: root, taskId: 'T-001',
      config: { grouping_profile: 'flat', group_closeout: false, work_unit_audit: 'disabled' },
    });
    assert.equal(scope.scopeKind, 'none');
    assert.equal(scope.decision.genericTerminalAllowed, true);
    const closed = await runCliInProcess([
      'task', 'status', 'T-001', 'closed', '--expect-digest', currentTaskDigest(root, 'T-001'), '--target', root, '--json',
    ]);
    assert.equal(closed.status, 1, closed.stdout + closed.stderr);
    const payload = JSON.parse(closed.stdout);
    assert.equal(payload.handoff_recognition.recognized, false);
    assert.match(readFileSync(file, 'utf8'), /^status: accepted$/m);
  });
});

describe('transactional files mutation and executable revalidation', () => {
  it('emits a validated receipt whose revalidation command runs verbatim and is read-only', async () => {
    const root = await readinessFixture('revalidation');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const before = currentTaskDigest(root, 'T-001');
    const applied = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', before,
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const receipt = JSON.parse(applied.stdout).receipt;
    assert.equal(validateTaskMutationReceipt(receipt).ok, true);
    assert.equal(receipt.mutationDisposition, 'committed');
    assert.equal(receipt.expectedDigest, before);
    assert.equal(receipt.resultingDigest, currentTaskDigest(root, 'T-001'));
    assert.deepEqual(receipt.changedPaths, ['.agenticloop/tasks/T-001.md']);
    assert.ok(!receipt.revalidateCommand.includes('<'));
    assert.ok(receipt.revalidateCommand.includes(receipt.resultingDigest));

    // Execute the emitted command verbatim from the intended target directory.
    const argv = splitCommand(receipt.revalidateCommand);
    assert.equal(argv.shift(), 'npx');
    assert.equal(argv.shift(), 'agenticloop');
    const revalidated = await runCliInProcess([...argv, '--json'], { cwd: root });
    assert.equal(revalidated.status, 0, revalidated.stdout + revalidated.stderr);
    const payload = JSON.parse(revalidated.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.rollbackAuthorized, false);
    assert.equal(currentTaskDigest(root, 'T-001'), receipt.resultingDigest);
  });

  it('rejects revalidation when the current task digest no longer matches', async () => {
    const root = await readinessFixture('revalidation-stale');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const applied = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const receipt = JSON.parse(applied.stdout).receipt;
    const file = taskFile(root, 'T-001');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n<!-- drift -->\n`, 'utf8');
    const argv = splitCommand(receipt.revalidateCommand).slice(2);
    const revalidated = await runCliInProcess([...argv, '--json'], { cwd: root });
    assert.equal(revalidated.status, 1);
    const payload = JSON.parse(revalidated.stdout);
    assert.equal(payload.evidenceState, 'changed');
    assert.equal(payload.rollbackAuthorized, false);
  });

  it('treats a rerun of the current status as a validated no-op receipt', async () => {
    const root = await readinessFixture('rerun-noop');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const first = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = currentTaskDigest(root, 'T-001');
    const rerun = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', afterFirst,
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(rerun.status, 0, rerun.stderr);
    const receipt = JSON.parse(rerun.stdout).receipt;
    assert.equal(receipt.mutationDisposition, 'already_current');
    assert.deepEqual(receipt.changedPaths, []);
    assert.equal(receipt.unresolved, false);
    assert.equal(currentTaskDigest(root, 'T-001'), afterFirst);
  });

  it('reports whether a newly created task record was committed', async () => {
    const root = mkdtempSync(join(temp, 'create-receipt-'));
    createTaskProjectFixture(root);
    const created = await runCliInProcess(['task', 'new', 'Guarded creation', '--scaffold', '--target', root, '--json']);
    assert.equal(created.status, 0, created.stderr);
    const payload = JSON.parse(created.stdout);
    assert.equal(payload.receipt.mutationDisposition, 'committed');
    assert.equal(payload.receipt.unresolved, false);
    assert.deepEqual(payload.receipt.changedPaths, [payload.file]);
    assert.equal(validateTaskMutationReceipt(payload.receipt).ok, true);
  });

  it('keeps an under-specified later verifier from invalidating a verified mutation', async () => {
    const root = await readinessFixture('under-specified');
    const deps = writeDependencySnapshot(root, '.agenticloop/tmp/dependencies.json');
    const applied = await runCliInProcess([
      'task', 'status', 'T-001', 'agent-ready', '--expect-digest', currentTaskDigest(root, 'T-001'),
      '--base', 'HEAD', '--dependencies', deps, '--target', root, '--json',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const committed = currentTaskDigest(root, 'T-001');

    const underSpecified = await runCliInProcess([
      'task-readiness', '--task', 'T-001', '--mode', 'authoring', '--target', root, '--json',
    ]);
    assert.equal(underSpecified.status, 1);
    const payload = JSON.parse(underSpecified.stdout);
    assert.equal(payload.evidenceState, 'missing');
    assert.equal(payload.disposition, 'needs_context');
    assert.equal(payload.rollbackAuthorized, false);
    assert.equal(payload.diagnostics[0].code, 'verification.context.missing');
    assert.equal(payload.diagnostics[0].evidence.committedStateEvaluated, false);
    assert.equal(currentTaskDigest(root, 'T-001'), committed);
  });
});
