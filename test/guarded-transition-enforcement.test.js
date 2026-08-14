/**
 * Guarded task-transition enforcement coverage.
 *
 * Adversarial regressions for evidence validation, transition gates, closeout
 * resume, publication provenance, and revalidation safety. Public-command cases
 * pass every required argument explicitly.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCliInProcess } from './helpers/run-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import {
  createDispatchFixture,
  git,
  prepare,
  producerBinding,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { receiveRoleReturn } from '../src/dispatch-envelope.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../src/handoff-consumption.js';
import { createReturnVerification, writeReturnVerification } from '../src/return-verification.js';
import { applyGitHubTaskBody, taskBodyDigest } from '../src/github-task-body.js';
import { readLifecycleReceipt } from '../src/lifecycle-plan.js';
import { LIFECYCLE_RECEIPT_RELATIVE_PATH } from '../src/layout.js';
import { resolveCanonicalTerminalScope } from '../src/terminal-scope.js';
import { renderCloseoutMarker } from '../src/closeout-contract.js';
import { createTaskContractBaselineRecord, renderTaskContractRecord, taskContractDigest } from '../src/task-contract-baseline.js';
import {
  createTaskEvidenceContext,
  createTaskMutationReceipt,
  createTaskReadinessEvidence,
  shellQuoteArgument,
  validateTaskEvidenceContext,
  validateTaskMutationReceipt,
} from '../src/task-evidence-contract.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-transition-enforcement-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
// Verification results use this canonical prefixed digest form.
const VALIDATION_DIGEST = `sha256:agenticloop.validation-result.v1:${'9'.repeat(64)}`;
const DIGEST_D = `sha256:${'e'.repeat(64)}`;
const TREE_OID = 'd'.repeat(40);

function baseEvidence() {
  return {
    kind: 'git_tree',
    identity: `git-tree:${TREE_OID}`,
    inventoryDigest: DIGEST_B,
    pathCount: 3,
    revalidationArgs: ['--base', 'refs/heads/main'],
  };
}

function dependencyEvidence() {
  return {
    source: 'file:.agenticloop/tmp/dependencies.json',
    digest: DIGEST_C,
    observedAt: new Date().toISOString(),
    evaluatedAt: new Date().toISOString(),
    freshnessPolicy: { maxAgeSeconds: 86400 },
    freshnessState: 'current',
    evaluatedState: 'satisfied',
    statuses: [{ id: 'T-002', status: 'accepted' }],
    revalidationArgs: ['--dependencies', '.agenticloop/tmp/dependencies.json'],
  };
}

function validContext() {
  return createTaskEvidenceContext({
    backend: 'files',
    task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md', expectedDigest: DIGEST_A },
    transition: { fromStatus: 'draft', toStatus: 'agent-ready' },
    base: baseEvidence(),
    dependencies: dependencyEvidence(),
  });
}

// ---------------------------------------------------------------------------
// Validators must enforce exactly what builders enforce.
// ---------------------------------------------------------------------------

describe('persisted evidence and receipt validation is symmetric with construction', () => {
  it('rejects an evidence context carrying no task id or carrier', async () => {
    const context = { ...validContext(), task: { expectedDigest: DIGEST_A } };
    const result = validateTaskEvidenceContext(context);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /task id/i);
  });

  it('rejects an evidence context with no transition', async () => {
    const context = { ...validContext() };
    delete context.transition;
    const result = validateTaskEvidenceContext(context);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /transition/i);
  });

  it('rejects an evidence context whose transition does not change status', async () => {
    const context = { ...validContext(), transition: { fromStatus: 'draft', toStatus: 'draft' } };
    assert.equal(validateTaskEvidenceContext(context).ok, false);
  });

  it('rejects a structurally invalid committed receipt that reports success', async () => {
    const receipt = {
      kind: 'agenticloop.task-mutation-receipt',
      schemaVersion: 1,
      backend: 'files',
      task: null,
      expectedDigest: 'not-a-digest',
      candidateDigest: 42,
      resultingDigest: null,
      evidenceContext: null,
      evidenceContextDigest: null,
      verification: null,
      ownedProjections: 'not-an-array',
      changedPaths: [{ nope: true }],
      mutationDisposition: 'committed',
      unresolved: false,
      recovery: null,
      revalidateCommand: 'npx agenticloop task lint T-1 --expect-task-digest ' + DIGEST_A,
    };
    const result = validateTaskMutationReceipt(receipt);
    assert.equal(result.ok, false, 'a receipt this malformed must never validate');
    const joined = result.errors.join('; ');
    for (const expected of [/task/i, /candidateDigest/i, /verification/i, /changedPaths/i, /ownedProjections/i]) {
      assert.match(joined, expected);
    }
  });

  it('rejects a committed receipt with no resulting digest', async () => {
    const receipt = {
      kind: 'agenticloop.task-mutation-receipt',
      schemaVersion: 1,
      backend: 'files',
      task: { id: 'T-1', carrier: 'x.md' },
      expectedDigest: DIGEST_A,
      candidateDigest: DIGEST_B,
      resultingDigest: null,
      evidenceContext: null,
      evidenceContextDigest: null,
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      ownedProjections: [],
      changedPaths: ['x.md'],
      mutationDisposition: 'committed',
      unresolved: false,
      recovery: null,
      revalidateCommand: `npx agenticloop task lint T-1 --expect-task-digest ${DIGEST_A}`,
    };
    const result = validateTaskMutationReceipt(receipt);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /resulting digest/i);
  });

  it('rejects an unresolved receipt with no recovery instruction', async () => {
    const receipt = {
      kind: 'agenticloop.task-mutation-receipt',
      schemaVersion: 1,
      backend: 'files',
      task: { id: 'T-1', carrier: 'x.md' },
      expectedDigest: DIGEST_A,
      candidateDigest: DIGEST_B,
      resultingDigest: null,
      evidenceContext: null,
      evidenceContextDigest: null,
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      ownedProjections: [],
      changedPaths: [],
      mutationDisposition: 'unresolved',
      unresolved: true,
      recovery: null,
      revalidateCommand: `npx agenticloop task lint T-1 --expect-task-digest ${DIGEST_A}`,
    };
    const result = validateTaskMutationReceipt(receipt);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /recovery/i);
  });

  it('still accepts every receipt the builder produces', async () => {
    const context = validContext();
    const receipt = createTaskMutationReceipt({
      context,
      candidateDigest: DIGEST_B,
      resultingDigest: DIGEST_D,
      mutationDisposition: 'committed',
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      changedPaths: ['.agenticloop/tasks/T-001.md'],
      revalidateCommand: `npx agenticloop task-readiness --task-body .agenticloop/tasks/T-001.md --mode authoring --expect-task-digest ${DIGEST_D} --base refs/heads/main --dependencies .agenticloop/tmp/dependencies.json`,
    });
    assert.equal(validateTaskMutationReceipt(receipt).ok, true);
  });
});

// ---------------------------------------------------------------------------
// Transition gates belong to the write, not to one subcommand.
// ---------------------------------------------------------------------------

describe('every GitHub task-body status change passes the transition gates', () => {
  const body = (status, title = 'Draft') => [
    '---', 'task_id: T-901', 'task_contract_schema: 2', `status: ${status}`, 'backend: github',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
    'intended_creations:', '  - src/new.js', '---', '', `# ${title}`, '',
    '## Task', 'Guarded publication.', '', '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Draft.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- valid', '', '## Required Checks', '- npm test', '',
    '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
    '[[agent: maintainer]]',
  ].join('\n');

  function transport(state) {
    return (_command, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]) };
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 91, body: state.body, labels: [] }) };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        state.bodyWrites += 1;
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'issue' && args[1] === 'comment') return { status: 0, stdout: '' };
      if (args[0] === 'issue' && args[1] === 'edit') return { status: 0, stdout: '' };
      return { status: 1, stderr: `unexpected ${args.join(' ')}` };
    };
  }

  it('set-field refuses an illegal status change instead of writing it', async () => {
    const state = { body: body('draft'), bodyWrites: 0 };
    const result = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91',
      '--field', 'status', '--value', 'closed',
      '--expect-digest', taskBodyDigest(state.body), '--yes',
    ], { ghCommandRunner: transport(state) });
    assert.notEqual(result.status, 0, 'an illegal status change through set-field must fail');
    assert.equal(state.bodyWrites, 0, 'nothing may be written for a refused transition');
  });

  it('reads trusted GitHub closeout markers from comments before generic closure', async () => {
    const target = mkdtempSync(join(temp, 'github-marker-scope-'));
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: confirmed',
      'development_stage: expansion',
      'task_backend: github',
      'work_unit_audit: disabled',
      'grouping_profile: flat',
      'group_closeout: false',
      '---',
      '',
      '# Project',
      '',
    ].join('\n'));
    const state = { body: body('accepted'), bodyWrites: 0 };
    const marker = renderCloseoutMarker({
      status: 'complete',
      workUnit: 'selection:review',
      artifact: `commit:${TREE_OID}`,
      auditRef: 'none',
      predecessor: 'none',
      planSync: 'none',
      improvementRefs: [],
      gateDigest: DIGEST_A,
    });
    const comment = {
      id: 1,
      user: { login: 'loop' },
      author_association: 'MEMBER',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      html_url: 'https://example.test/comments/1',
      body: marker,
    };
    const runner = (_command, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop' }) };
      if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[comment]]) };
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 91, body: state.body, labels: [] }) };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        state.bodyWrites += 1;
        return { status: 0, stdout: '' };
      }
      return { status: 1, stderr: `unexpected ${args.join(' ')}` };
    };
    const result = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91',
      '--field', 'status', '--value', 'closed',
      '--expect-digest', taskBodyDigest(state.body), '--yes', '--target', target,
    ], { ghCommandRunner: runner });
    assert.equal(result.status, 1);
    assert.match(`${result.stderr}${result.stdout}`, /Generic task closure is refused/);
    assert.equal(state.bodyWrites, 0);
    assert.match(state.body, /status: accepted/);
  });

  it('set-field refuses agent-ready without base and dependency evidence', async () => {
    const state = { body: body('draft'), bodyWrites: 0 };
    const result = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91',
      '--field', 'status', '--value', 'agent-ready',
      '--expect-digest', taskBodyDigest(state.body), '--yes',
    ], { ghCommandRunner: transport(state) });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /--base|--dependencies/);
    assert.equal(state.bodyWrites, 0);
  });

  it('set-field still allows a non-status field', async () => {
    const state = { body: body('draft'), bodyWrites: 0 };
    const result = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91',
      '--field', 'attempt_budget', '--value', '7',
      '--expect-digest', taskBodyDigest(state.body), '--dry-run',
    ], { ghCommandRunner: transport(state) });
    assert.equal(result.status, 0, `${result.stderr}`);
  });

  it('apply refuses a candidate whose status changed illegally', async () => {
    const state = { body: body('draft'), bodyWrites: 0 };
    const candidate = join(temp, 'candidate-closed.md');
    writeFileSync(candidate, body('closed', 'Closed'));
    const result = await runCliInProcess([
      'task-body', 'apply', '--issue', '91', '--body-file', candidate,
      '--expect-digest', taskBodyDigest(state.body), '--yes',
    ], { ghCommandRunner: transport(state) });
    assert.notEqual(result.status, 0, 'apply must not launder an illegal status change');
    assert.equal(state.bodyWrites, 0);
  });

  it('apply still allows a candidate that leaves status unchanged', async () => {
    const state = { body: body('draft'), bodyWrites: 0 };
    const candidate = join(temp, 'candidate-same.md');
    writeFileSync(candidate, body('draft', 'Edited'));
    const result = await runCliInProcess([
      'task-body', 'apply', '--issue', '91', '--body-file', candidate,
      '--expect-digest', taskBodyDigest(state.body), '--dry-run',
    ], { ghCommandRunner: transport(state) });
    assert.equal(result.status, 0, `${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Prior-gate receipts are verified, not merely recognized.
// ---------------------------------------------------------------------------

describe('prior-gate receipts are verified on read', () => {
  it('refuses a minimal hand-written document that only carries kind and unresolved', async () => {
    const target = mkdtempSync(join(temp, 'gate-min-'));
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(
      join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH),
      JSON.stringify({ kind: 'agenticloop.lifecycle-mutation-receipt', unresolved: false })
    );
    const read = readLifecycleReceipt(target);
    assert.equal(read.state, 'malformed', 'an unverified stub must not read as a resolved prior gate');
  });

  it('refuses a receipt from an unknown schema version', async () => {
    const target = mkdtempSync(join(temp, 'gate-schema-'));
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH), JSON.stringify({
      kind: 'agenticloop.lifecycle-mutation-receipt', schemaVersion: 99, unresolved: false,
      command: 'init', planDigest: DIGEST_A, transactionDisposition: 'applied',
      commitDisposition: 'committed', gitAvailable: true, changedPaths: [],
      committedSegments: [], failedSegment: null, stale: false, reasons: [],
      nextAction: 'none', revalidateCommand: 'npx agenticloop init --dry-run',
    }));
    assert.equal(readLifecycleReceipt(target).state, 'malformed');
  });

  it('refuses a receipt whose unresolved flag contradicts its own dispositions', async () => {
    const target = mkdtempSync(join(temp, 'gate-contra-'));
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH), JSON.stringify({
      kind: 'agenticloop.lifecycle-mutation-receipt', schemaVersion: 2, unresolved: false,
      command: 'init', planDigest: DIGEST_A, transactionDisposition: 'partially_applied',
      commitDisposition: 'uncommitted', gitAvailable: true, changedPaths: [],
      committedSegments: [], failedSegment: null, stale: false, reasons: [],
      nextAction: 'none', revalidateCommand: 'npx agenticloop init --dry-run',
    }));
    const read = readLifecycleReceipt(target);
    assert.equal(read.state, 'malformed');
    assert.match(read.error, /contradict/i);
  });

  it('reports drift when a recorded path no longer matches its fingerprint', async () => {
    const target = mkdtempSync(join(temp, 'gate-drift-'));
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(join(target, 'tracked.md'), 'original\n');
    writeFileSync(join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH), JSON.stringify({
      kind: 'agenticloop.lifecycle-mutation-receipt', schemaVersion: 2, unresolved: false,
      command: 'init', planDigest: DIGEST_A, transactionDisposition: 'applied',
      commitDisposition: 'committed', gitAvailable: true,
      changedPaths: [{ path: 'tracked.md', fingerprint: DIGEST_A, transaction: 'applied', git: 'clean' }],
      committedSegments: [], failedSegment: null, stale: false, reasons: [],
      nextAction: 'none', revalidateCommand: 'npx agenticloop init --dry-run',
    }));
    const read = readLifecycleReceipt(target);
    assert.equal(read.state, 'present');
    assert.ok(read.drift.length > 0, 'a changed recorded path must be reported as drift');
  });

  it('blocks task-readiness on a prior gate that cannot be verified', async () => {
    const target = mkdtempSync(join(temp, 'gate-readiness-'));
    createTaskProjectFixture(target);
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), [
      '---', 'task_id: T-001', 'task_contract_schema: 2', 'status: draft', 'backend: files',
      'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
      'intended_creations:', '  - src/new.js', '---', '', '# Draft', '',
      '## Task', 'Readiness.', '', '## Source Documents Reviewed', '- README.md', '',
      '## Current State', 'Draft.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
      '## Acceptance Criteria', '- valid', '', '## Required Checks', '- [RC-1] command: `npm test`', '',
      '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
      '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
      '[[agent: maintainer]]', '',
    ].join('\n'));
    writeFileSync(
      join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH),
      JSON.stringify({ kind: 'agenticloop.lifecycle-mutation-receipt', unresolved: false })
    );
    const result = await runCliInProcess(['task-readiness', '--target', target, '--task', 'T-001']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /prior[- ]gate|lifecycle/i);
  });
});

// ---------------------------------------------------------------------------
// A published marker is not a completed closeout.
// ---------------------------------------------------------------------------

describe('GitHub closeout resumes the terminal transition after publication', () => {
  it('does not report success while a covered task is still accepted', async () => {
    const taskId = 'P35-09';
    const projectMap = [
      '---', 'setup_status: confirmed', 'development_stage: expansion', 'task_backend: github',
      'work_unit_audit: disabled', 'grouping_profile: milestone', 'task_id_regex: "^P\\d+-\\d{2,}$"',
      '---', '', '# Project', '',
    ].join('\n');
    const fixture = await createDispatchFixture(temp, 'gh-closeout-resume', {
      taskIds: [taskId], workUnit: 'milestone:M00',
    });
    const target = fixture.root;
    writeFileSync(join(target, '.agenticloop', 'project.md'), projectMap, 'utf8');
    git(target, ['add', '.agenticloop/project.md']);
    git(target, ['commit', '-m', 'configure mocked GitHub closeout']);
    const repository = fixture.repository;
    const dispatchHead = git(target, ['rev-parse', 'HEAD']);
    fixture.repository = () => ({ ...repository(), head: dispatchHead, baseHead: dispatchHead });
    fixture.refetchRepository = fixture.repository;

    const carrier = {
      body: readFileSync(fixture.taskPath, 'utf8')
        .replace(/^status: .*$/m, 'status: accepted')
        .replace(/^backend: .*$/m, 'backend: github')
        .replace(/\s*$/, '\n\n[[agent: maintainer]]\n'),
    };
    const issues = [{
      number: 1, state: 'CLOSED', title: '', body: carrier.body, labels: [],
      url: 'https://example.test/1', updatedAt: 'now',
    }];
    const comments = [];
    const baselineContract = taskContractDigest(carrier.body);
    const baseline = {
      id: 420, html_url: 'https://example.test/comments/420',
      user: { login: 'loop' }, author_association: 'MEMBER',
      created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z',
      body: renderTaskContractRecord(createTaskContractBaselineRecord({
        recordId: 'task-contract-record:00000000-0000-4000-8000-000000000009',
        taskId, digest: baselineContract.digest, projection: baselineContract.projection,
        authority: `policy:${taskId}`, actor: 'loop', timestamp: '2026-08-10T00:00:00.000Z',
        affectedArtifact: 'issue:1',
      })),
    };
    let full = git(target, ['rev-parse', 'HEAD']);
    const mergedPr = {
      number: 5, state: 'MERGED', mergedAt: '2026-07-27T12:00:00Z',
      mergeCommit: { oid: full }, headRefOid: full, reviewDecision: 'APPROVED',
      reviews: [], closingIssuesReferences: [{ number: 1 }],
    };
    // The terminal body write is refused on the first record run only.
    const state = { failBodyEdit: true, bodyWrites: 0, returnPr: null };
    const runner = (command, args) => {
      if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return { status: 0, stdout: JSON.stringify({ closedByPullRequestsReferences: [{ number: 5 }] }), stderr: '' };
      }
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[baseline]]), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && String(args[args.indexOf('--json') + 1] ?? '').includes('body')) {
        return { status: 0, stdout: JSON.stringify({ number: 1, body: carrier.body }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments, updatedAt: 'now' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify(Number(args[2]) === 6 ? state.returnPr : mergedPr), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        comments.push({ id: comments.length + 1, author: { login: 'loop' }, body: args[args.indexOf('--body') + 1] });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        if (state.failBodyEdit) return { status: 1, stdout: '', stderr: 'transport refused the terminal write' };
        carrier.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        issues[0].body = carrier.body;
        state.bodyWrites += 1;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };

    const snapshot = {
      ...fixture.snapshot(), backend: 'github', carrier: 'issue:1', body: carrier.body,
      digest: taskBodyDigest(carrier.body),
    };
    const readiness = {
      ...fixture.readiness,
      evidence: createTaskReadinessEvidence({
        ...fixture.readiness.evidence,
        backend: 'github', task: { id: taskId, carrier: 'issue:1', expectedDigest: snapshot.digest },
      }),
    };
    const githubFixture = {
      ...fixture,
      refetchTask: () => snapshot,
      readiness,
      refetchReadiness: () => readiness,
      assignment: {
        ...fixture.assignment,
        canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'],
      },
    };
    const dispatched = prepare(githubFixture);
    assert.equal(dispatched.ok, true, dispatched.validation.errors?.join('\n'));
    const packet = dispatched.packet;
    const recognition = recognizeHandoff({
      transition: 'role_start',
      expectation: {
        backend: 'github', taskId, roleId: 'engineer',
        taskContractDigest: packet.task.contractDigest, carrierDigest: packet.task.digest,
        packetId: packet.packetId, packetDigest: packet.digest,
        workUnitIdentity: packet.decomposition.workUnitId, artifactHead: packet.repository.head,
        worktreeRoot: packet.repository.worktree, minimumActivationAssurance: 'operator_confirmed',
      },
      preparedDispatch: packet,
      validatePreparedDispatch: fixtureDispatchValidator(fixture),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
    const consumption = createDispatchConsumption({ backend: 'github', taskId, recognition });
    const consumptionPath = join(target, dispatchConsumptionRelativePath(consumption));
    mkdirSync(join(consumptionPath, '..'), { recursive: true });
    writeFileSync(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');

    writeFileSync(join(target, 'src', 'existing.js'), 'export const current = "github-return";\n', 'utf8');
    git(target, ['add', 'src/existing.js']);
    git(target, ['commit', '-m', `record GitHub return\n\nTask: ${taskId}\nAgent: engineer`]);
    full = git(target, ['rev-parse', 'HEAD']);
    mergedPr.mergeCommit.oid = full;
    mergedPr.headRefOid = full;
    const pr = { state: 'open', number: 6, url: 'https://example.test/pull/6' };
    const evidence = repositoryEvidence(packet, { head: full, pr });
    evidence.branch = packet.assignment.branch;
    evidence.productAttribution = { range: { base: packet.repository.head, head: full }, commits: [full] };
    state.returnPr = { number: 6, state: 'OPEN', url: pr.url, headRefOid: full, headRefName: evidence.branch };
    const roleReturn = readyReturn(packet, evidence);
    const binding = producerBinding(fixture.trust, packet, roleReturn, evidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet, refetchTask: () => snapshot,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: binding.producerReceipt,
      resolveTrustedAdapter: binding.resolveTrustedAdapter,
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
    const verification = createReturnVerification({
      target, packet, roleReturn, repositoryEvidence: evidence,
      producerReceipt: binding.producerReceipt, received,
      requiredCheckEvidenceAssurance: 'unverified',
    });
    const stored = writeReturnVerification(target, verification);
    assert.equal(stored.ok, true, stored.errors.join('\n'));

    // The return truthfully records the still-open review PR.  Historical
    // closeout begins after integration, so its refetch must see that same PR,
    // URL, branch, and head as merged with complete merge metadata.
    state.returnPr = {
      number: 6, state: 'MERGED', mergedAt: '2026-08-10T01:00:00Z',
      mergeCommit: { oid: full }, url: pr.url,
      headRefOid: full, headRefName: evidence.branch,
    };

    const options = {
      ghCommandRunner: runner,
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };

    const packetPath = join(target, '.agenticloop', 'tmp', 'github-packet.json');
    const prepared = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', taskId,
      '--artifact', `commit:${full}`, '--output', packetPath, '--target', target,
    ], options);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);

    // Run 1: the marker publishes, then the terminal transition fails.
    const first = await runCliInProcess([
      'closeout', 'record', '--packet', packetPath, '--yes', '--target', target,
    ], options);
    assert.notEqual(first.status, 0, 'a failed terminal transition must not report success');
    assert.equal(comments.length, 1, 'the marker published exactly once');
    assert.match(carrier.body, /status: accepted/);

    // Run 2: the marker is already current; the rerun must finish the operation
    // rather than mistake publication for completion.
    state.failBodyEdit = false;
    const second = await runCliInProcess([
      'closeout', 'record', '--packet', packetPath, '--yes', '--target', target,
    ], options);
    assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
    assert.match(carrier.body, /status: "?closed"?/, 'the rerun must complete the terminal transition');
    assert.equal(comments.length, 1, 'the rerun must not republish the marker');
  });
});

// ---------------------------------------------------------------------------
// A marker that declares no covered set proves no covered set.
// ---------------------------------------------------------------------------

describe('closeout-marker scope never invents a covered task set', () => {
  const marker = renderCloseoutMarker({
    workUnit: 'selection:reviewer-1',
    gateDigest: DIGEST_A,
    status: 'complete',
    auditRef: null,
    planSync: null,
    improvementRefs: [],
    artifact: 'none',
  });

  const coveredBody = (id) => [
    '---', `task_id: ${id}`, 'task_contract_schema: 2', 'status: accepted', 'backend: files',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
    'intended_creations:', '  - src/new.js', '---', '', `# ${id}`, '',
    '## Task', 'Covered.', '', '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Accepted.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- valid', '', '## Required Checks', '- npm test', '',
    '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
    '[[agent: maintainer]]', '', marker, '',
  ].join('\n');

  it('never derives contradictory singleton scopes for one work unit', async () => {
    const target = mkdtempSync(join(temp, 'marker-scope-'));
    createTaskProjectFixture(target);
    for (const id of ['T-1', 'T-2']) {
      writeFileSync(join(target, '.agenticloop', 'tasks', `${id}.md`), coveredBody(id));
    }
    const derived = ['T-1', 'T-2'].map(id => resolveCanonicalTerminalScope({
      target, config: {}, taskId: id, taskBody: coveredBody(id), inventoryComplete: true,
    }));
    for (const [index, scope] of derived.entries()) {
      assert.notEqual(
        scope.scopeKind,
        'explicit_task_set',
        `a marker with no declared covered set must not yield an explicit task set (task ${index + 1})`
      );
      assert.equal(scope.decision.genericTerminalAllowed, false);
    }
    assert.match(derived[0].reasons.join('; '), /covered task set|covered set/i);
  });

  it('ignores a superseded marker in favour of the current one', async () => {
    const target = mkdtempSync(join(temp, 'marker-superseded-'));
    createTaskProjectFixture(target);
    const superseding = renderCloseoutMarker({
      workUnit: 'selection:reviewer-2',
      gateDigest: DIGEST_B,
      status: 'complete',
      auditRef: null,
      planSync: null,
      improvementRefs: [],
      artifact: 'none',
      supersedes: DIGEST_A,
    });
    const body = `${coveredBody('T-1')}\n\n${superseding}\n`;
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-1.md'), body);
    const scope = resolveCanonicalTerminalScope({
      target, config: {}, taskId: 'T-1', taskBody: body, inventoryComplete: true,
    });
    assert.equal(scope.decision.genericTerminalAllowed, false);
    assert.match(
      scope.reasons.join('; '),
      /selection:reviewer-2/,
      'the retired marker must not be the one consumed'
    );
  });
});

// ---------------------------------------------------------------------------
// A retained attempt artifact is not proof of a write.
// ---------------------------------------------------------------------------

describe('publication provenance requires evidence of a write, not an attempt', () => {
  const body = (title) => [
    '---', 'task_id: T-701', 'task_contract_schema: 2', 'status: draft', 'backend: github',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
    'intended_creations:', '  - src/new.js', '---', '', `# ${title}`, '',
    '## Task', 'Guarded publication.', '', '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Draft.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- valid', '', '## Required Checks', '- npm test', '',
    '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
    '[[agent: maintainer]]',
  ].join('\n');

  function transport(state) {
    return (_command, args) => {
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]) };
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 71, body: state.body, labels: [] }) };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        if (state.failBodyEdit) return { status: 1, stderr: 'transport refused' };
        state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        state.bodyWrites += 1;
        return { status: 0, stdout: '' };
      }
      return { status: 1, stderr: `unexpected ${args.join(' ')}` };
    };
  }

  it('does not attribute a later external write to a confirmed-failed attempt', async () => {
    const recoveryDir = mkdtempSync(join(temp, 'recovery-'));
    const original = body('Draft');
    const candidate = body('Published');

    // Attempt 1: the transport fails and the refetch proves the write did not apply.
    const state = { body: original, bodyWrites: 0, failBodyEdit: true };
    const failed = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    assert.equal(failed.publicationProvenance, 'ambiguous_response_not_applied');
    assert.equal(failed.applied, false);

    // An external actor then writes exactly the candidate bytes.
    state.body = candidate;
    state.failBodyEdit = false;

    const retried = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      commandRunner: transport(state), recoveryDir,
    });
    assert.notEqual(
      retried.publicationProvenance,
      'receipt_proven_prior_write',
      'an attempt proven not to have applied must never later prove publication'
    );
    assert.equal(retried.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Emitted revalidation commands are shell-safe.
// ---------------------------------------------------------------------------

describe('emitted revalidation arguments cannot carry shell expansion', () => {
  it('never emits an active expansion for a hostile value', async () => {
    for (const hostile of ['$(whoami)', '`whoami`', '${HOME}', 'a"b', "a'b"]) {
      assert.throws(
        () => shellQuoteArgument(hostile),
        /shell-safe/i,
        `emitting ${hostile} verbatim would be executable`
      );
    }
  });

  // Double quotes, not single: single quotes quote nothing in cmd.exe. See the
  // Cross-shell block in task-evidence-integrity.test.js, which executes the emitted value.
  it('quotes ordinary values without introducing expansion characters', async () => {
    assert.equal(shellQuoteArgument('simple.json'), 'simple.json');
    assert.equal(shellQuoteArgument('with space.json'), '"with space.json"');
    assert.equal(shellQuoteArgument(''), '""');
    assert.equal(shellQuoteArgument('.agenticloop/tmp/dep-1.json'), '.agenticloop/tmp/dep-1.json');
  });

  it('refuses a receipt whose revalidation command carries an expansion', async () => {
    assert.throws(() => createTaskMutationReceipt({
      backend: 'files',
      taskId: 'T-1',
      carrier: 'x.md',
      candidateDigest: DIGEST_B,
      resultingDigest: DIGEST_D,
      mutationDisposition: 'committed',
      verification: { resultKind: 'agenticloop.validation-result', digest: VALIDATION_DIGEST },
      changedPaths: ['x.md'],
      revalidateCommand: `npx agenticloop task lint "$(whoami)" --expect-task-digest ${DIGEST_D}`,
    }), /read-only|expansion/i);
  });
});
