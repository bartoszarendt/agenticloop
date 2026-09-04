/**
 * Task mutation boundary and resilience coverage.
 *
 * These cases intentionally exercise carrier recovery, cross-process contract
 * parsing, shell rendering, and conditional writes through their public seams.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyGitHubTaskBody, taskBodyDigest } from '../src/github-task-body.js';
import {
  createTaskEvidenceContext,
  createTaskMutationReceipt,
  shellQuoteArgument,
  validateTaskEvidenceContext,
  validateTaskMutationReceipt,
} from '../src/task-evidence-contract.js';
import { executeMutationBatch } from '../src/fs-mutation-kernel.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { applyFilesCloseoutTerminalTransition } from '../src/closeout-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { lifecycleMutationReceipt } from '../src/lifecycle-plan.js';
import { LIFECYCLE_RECEIPT_RELATIVE_PATH } from '../src/layout.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-mutation-boundaries-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

const digest = character => `sha256:${character.repeat(64)}`;
const verification = {
  resultKind: 'agenticloop.validation-result',
  digest: `sha256:agenticloop.validation-result.v1:${'9'.repeat(64)}`,
};

function projection(receiptValue, name) {
  return receiptValue.projections.find(item => item.name === name);
}

function body(status = 'draft', title = 'Draft') {
  return [
    '---', 'task_id: T-901', `status: ${status}`, 'backend: github',
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

function context() {
  return createTaskEvidenceContext({
    backend: 'files',
    task: { id: 'T-901', carrier: '.agenticloop/tasks/T-901.md', expectedDigest: digest('a') },
    transition: { fromStatus: 'draft', toStatus: 'agent-ready' },
    base: {
      kind: 'git_tree', identity: `git-tree:${'b'.repeat(40)}`,
      inventoryDigest: digest('c'), pathCount: 1, revalidationArgs: ['--base', 'main'],
    },
    dependencies: {
      source: 'file:dependencies.json', digest: digest('d'), observedAt: new Date().toISOString(),
      evaluatedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 86400 }, freshnessState: 'current', evaluatedState: 'satisfied',
      statuses: [], revalidationArgs: ['--dependencies', 'dependencies.json'],
    },
  });
}

function receipt(overrides = {}) {
  return createTaskMutationReceipt({
    context: context(), candidateDigest: digest('e'), resultingDigest: digest('f'),
    verification, changedPaths: ['.agenticloop/tasks/T-901.md'], mutationDisposition: 'committed',
    revalidateCommand: `npx agenticloop task-readiness --task-body .agenticloop/tasks/T-901.md --mode authoring --expect-task-digest ${digest('f')} --base main --dependencies dependencies.json`,
    ...overrides,
  });
}

function runner(state) {
  return (_command, args) => {
    if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: state.publisher ?? 'maintainer' }) };
    if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([state.comments]) };
    if (args[0] === 'issue' && args[1] === 'view') {
      if (args.includes('labels')) return { status: 0, stdout: JSON.stringify({ labels: state.labels ?? [] }) };
      return { status: 0, stdout: JSON.stringify({ number: 91, body: state.body }) };
    }
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
      state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      state.bodyWrites += 1;
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      state.labelAttempts = (state.labelAttempts ?? 0) + 1;
      if (state.failLabels) return { status: 1, stderr: 'labels refused' };
      for (let index = 2; index < args.length; index += 1) {
        if (args[index] === '--add-label') state.labels = [...new Set([...(state.labels ?? []), args[index + 1]])];
        if (args[index] === '--remove-label') state.labels = (state.labels ?? []).filter(label => label !== args[index + 1]);
      }
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      state.commentAttempts += 1;
      const text = args[args.indexOf('--body') + 1];
      if (state.landThenFail && state.commentAttempts === 1) {
        state.comments.push({ id: 1, user: { login: 'maintainer' }, author_association: 'MEMBER', created_at: '2026-07-29T10:00:00Z', updated_at: '2026-07-29T10:00:00Z', html_url: 'https://example.test/comments/1', body: text });
        return { status: 1, stderr: 'ambiguous transport failure' };
      }
      if (state.failComment) return { status: 1, stderr: 'comment refused' };
      state.comments.push({ id: state.comments.length + 1, user: { login: 'maintainer' }, author_association: 'MEMBER', created_at: '2026-07-29T10:00:00Z', updated_at: '2026-07-29T10:00:00Z', html_url: `https://example.test/comments/${state.comments.length + 1}`, body: text });
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: `unexpected ${args.join(' ')}` };
  };
}

describe('resumable GitHub task-body projections', () => {
  it('resumes a failed note without rewriting the already verified body', () => {
    const original = body();
    const candidate = body('blocked', 'Blocked');
    const state = { body: original, bodyWrites: 0, comments: [], commentAttempts: 0, failComment: true };
    const options = {
      issue: 91, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      note: 'waiting for dependency', commandRunner: runner(state), recoveryDir: join(temp, 'note-resume'),
    };
    const first = applyGitHubTaskBody(options);
    assert.equal(first.ok, false);
    assert.equal(first.receipt.mutationDisposition, 'partially_committed');
    assert.equal(projection(first.receipt, 'issue_body').complete, true);
    assert.equal(projection(first.receipt, 'issue_comment').complete, false);
    state.failComment = false;
    const second = applyGitHubTaskBody(options);
    assert.equal(second.ok, true, second.errors?.join('\n'));
    assert.equal(state.bodyWrites, 1);
    assert.equal(state.comments.length, 1);
    assert.equal(projection(second.receipt, 'issue_comment').complete, true);
  });

  it('does not duplicate a note when GitHub accepted it before an ambiguous failure', () => {
    const original = body();
    const candidate = body('blocked', 'Blocked');
    const state = { body: original, bodyWrites: 0, comments: [], commentAttempts: 0, landThenFail: true };
    const options = {
      issue: 91, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      note: 'waiting for dependency', commandRunner: runner(state), recoveryDir: join(temp, 'note-ambiguous'),
    };
    const first = applyGitHubTaskBody(options);
    assert.equal(first.ok, true, first.errors?.join('\n'));
    const second = applyGitHubTaskBody(options);
    assert.equal(second.ok, true, second.errors?.join('\n'));
    assert.equal(state.bodyWrites, 1);
    assert.equal(state.commentAttempts, 1);
    assert.equal(state.comments.length, 1);
  });

  it('resumes both incomplete projections and records their exact final state', () => {
    const original = body();
    const candidate = body('blocked', 'Blocked');
    const state = {
      body: original, bodyWrites: 0, comments: [], commentAttempts: 0, labels: ['status:draft'],
      failComment: true, failLabels: true,
    };
    const options = {
      issue: 91, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      note: 'waiting for dependency', labels: ['status:blocked'], commandRunner: runner(state),
      recoveryDir: join(temp, 'both-resume'),
    };
    const first = applyGitHubTaskBody(options);
    assert.equal(first.ok, false);
    assert.equal(projection(first.receipt, 'issue_body').complete, true);
    assert.equal(projection(first.receipt, 'issue_comment').complete, false);
    assert.equal(projection(first.receipt, 'issue_labels').complete, false);
    state.failComment = false;
    state.failLabels = false;
    const second = applyGitHubTaskBody(options);
    assert.equal(second.ok, true, second.errors?.join('\n'));
    assert.equal(state.bodyWrites, 1);
    assert.equal(projection(second.receipt, 'issue_comment').complete, true);
    assert.equal(projection(second.receipt, 'issue_labels').complete, true);
    assert.equal(validateTaskMutationReceipt(second.receipt).ok, true);
  });

  it('does not duplicate a verified comment when only labels need resume', () => {
    const original = body();
    const candidate = body('blocked', 'Blocked');
    const state = {
      body: original, bodyWrites: 0, comments: [], commentAttempts: 0, labels: ['status:draft'],
      failLabels: true,
    };
    const options = {
      issue: 91, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      note: 'waiting for dependency', labels: ['status:blocked'], commandRunner: runner(state),
      recoveryDir: join(temp, 'labels-resume'),
    };
    assert.equal(applyGitHubTaskBody(options).ok, false);
    state.failLabels = false;
    const second = applyGitHubTaskBody(options);
    assert.equal(second.ok, true, second.errors?.join('\n'));
    assert.equal(state.bodyWrites, 1);
    assert.equal(state.commentAttempts, 1);
  });

  it('does not publish a transition note for an unattributed matching body', () => {
    const original = body();
    const candidate = body('blocked', 'Blocked');
    const state = { body: candidate, bodyWrites: 0, comments: [], commentAttempts: 0 };
    const result = applyGitHubTaskBody({
      issue: 91, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      note: 'waiting for dependency', commandRunner: runner(state), recoveryDir: join(temp, 'unattributed'),
    });
    assert.equal(result.nonAuthoritative, true);
    assert.equal(state.commentAttempts, 0);
  });

  it('ignores a foreign or inexact copy of the deterministic transition note', () => {
    const original = body();
    const candidate = body('blocked', 'Blocked');
    const source = { body: original, bodyWrites: 0, comments: [], commentAttempts: 0 };
    const options = {
      issue: 91, body: candidate, expectDigest: taskBodyDigest(original), yes: true,
      note: 'waiting for dependency', commandRunner: runner(source), recoveryDir: join(temp, 'trusted-note-source'),
    };
    assert.equal(applyGitHubTaskBody(options).ok, true);
    const rendered = source.comments[0].body;

    for (const [name, seeded] of [
      ['foreign', { ...source.comments[0], id: 41, user: { login: 'attacker' }, body: rendered }],
      ['wrong-text', { ...source.comments[0], id: 42, body: `${rendered}\nextra copied text` }],
    ]) {
      const state = { body: original, bodyWrites: 0, comments: [seeded], commentAttempts: 0 };
      const result = applyGitHubTaskBody({
        ...options, commandRunner: runner(state), recoveryDir: join(temp, `trusted-note-${name}`),
      });
      assert.equal(result.ok, true, result.errors?.join('\n'));
      assert.equal(state.commentAttempts, 1, name);
      assert.equal(state.comments.length, 2, name);
      assert.equal(state.comments[1].user.login, 'maintainer', name);
    }
  });
});

describe('closed evidence contracts and inert revalidation commands', () => {
  it('rejects unknown top-level and nested context fields', () => {
    const honest = context();
    for (const candidate of [
      { ...honest, extra: true },
      { ...honest, task: { ...honest.task, extra: true } },
      { ...honest, transition: { ...honest.transition, extra: true } },
      { ...honest, base: { ...honest.base, extra: true } },
      { ...honest, dependencies: { ...honest.dependencies, extra: true } },
    ]) assert.equal(validateTaskEvidenceContext(candidate).ok, false);
  });

  it('rejects unknown receipt, task, verification, and projection fields', () => {
    const honest = receipt();
    for (const candidate of [
      { ...honest, extra: true },
      { ...honest, task: { ...honest.task, extra: true } },
      { ...honest, verification: { ...honest.verification, extra: true } },
      { ...honest, projections: { ...honest.projections, extra: true } },
    ]) assert.equal(validateTaskMutationReceipt(candidate).ok, false);
    assert.throws(() => receipt({ verification: { ...verification, extra: true } }), /unknown fields/i);
    assert.throws(() => receipt({ projections: [{ name: 'issue_body', owned: true, attempted: true, complete: true, extra: true }] }), /unknown fields/i);
  });

  it('refuses CR/LF and every known launcher spelling of a mutation', () => {
    for (const value of ['line\nnext', 'line\rnext']) assert.throws(() => shellQuoteArgument(value), /CR|LF|newline/i);
    for (const command of [
      `node bin/agenticloop.js task status T-901 draft --expect-digest ${digest('f')}`,
      `./node_modules/.bin/agenticloop task status T-901 draft --expect-digest ${digest('f')}`,
      `npx -y agenticloop task status T-901 draft --expect-digest ${digest('f')}`,
      `agenticloop.cmd task status T-901 draft --expect-digest ${digest('f')}`,
      `pnpm exec agenticloop closeout record --packet packet.json`,
      'agenticloop worktree remove T-901 --yes',
      'agenticloop configure models --adapter codex --profile recommended',
      'agenticloop task-body fetch --issue 1 --output task.md',
      'agenticloop commit-attribution repair-record-render --record repair.json --output repair.md',
      'agenticloop pr-body scaffold --pr 1 --output pr.md',
      'agenticloop event-logging task.created --task T-901 --summary created',
      'agenticloop task explain T-901 --json',
    ]) {
      assert.throws(() => receipt({ revalidateCommand: command }), /read-only|mutation/i, command);
    }
  });

  it('accepts only registry-declared read-only command leaves and preserves a safe interior backslash', () => {
    const path = 'dir\\task.md';
    assert.equal(shellQuoteArgument(path), '"dir\\task.md"');
    assert.doesNotThrow(() => receipt({
      context: null,
      backend: 'files',
      taskId: path,
      carrier: path,
      expectedDigest: digest('a'),
      revalidateCommand: `npx agenticloop task lint ${shellQuoteArgument(path)} --expect-task-digest ${digest('f')}`,
    }));
    assert.throws(() => receipt({ revalidateCommand: 'npx agenticloop init --dry-run' }), /exactly bind/i);
    assert.throws(() => receipt({ revalidateCommand: 'npx agenticloop init' }), /read-only/i);
    assert.throws(() => receipt({ revalidateCommand: 'npx agenticloop status' }), /read-only/i);
  });

  it('requires rolled_back receipts to bind exact closed restoration evidence', () => {
    const honest = receipt({
      resultingDigest: digest('a'),
      changedPaths: [],
      mutationDisposition: 'rolled_back',
      rollback: {
        attempted: true, restored: true, expectedDigest: digest('a'),
        resultingDigest: digest('a'), reason: 'exact predecessor restored',
      },
      revalidateCommand: `npx agenticloop task-readiness --task-body .agenticloop/tasks/T-901.md --mode authoring --expect-task-digest ${digest('a')} --base main --dependencies dependencies.json`,
    });
    assert.equal(validateTaskMutationReceipt(honest).ok, true);
    for (const candidate of [
      { ...honest, rollback: null },
      { ...honest, resultingDigest: null },
      { ...honest, expectedDigest: digest('b'), resultingDigest: digest('b') },
      { ...honest, rollback: { ...honest.rollback, expectedDigest: digest('b'), resultingDigest: digest('b') } },
      { ...honest, changedPaths: ['task.md'] },
    ]) {
      assert.equal(validateTaskMutationReceipt(candidate).ok, false);
    }
    assert.throws(() => receipt({
      rollback: {
        attempted: true, restored: true, expectedDigest: digest('a'),
        resultingDigest: digest('a'), reason: 'incompatible disposition',
      },
    }), /cannot carry rollback evidence/i);
  });
});

describe('conditional filesystem mutation writes', () => {
  it('refuses drift observed by a pre-write hook before writing any covered carrier', () => {
    const target = mkdtempSync(join(temp, 'conditional-write-'));
    writeFileSync(join(target, 'first.md'), 'first\n');
    writeFileSync(join(target, 'second.md'), 'second\n');
    const result = executeMutationBatch(target, [
      { type: 'write', path: 'first.md', content: 'first candidate\n', expectedDigest: `sha256:${digestBytes('first\n')}`, expectedKind: 'file' },
      { type: 'write', path: 'second.md', content: 'second candidate\n', expectedDigest: `sha256:${digestBytes('second\n')}`, expectedKind: 'file' },
    ], {
      beforeWrite: () => writeFileSync(join(target, 'second.md'), 'concurrent\n'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.equal(readFileSync(join(target, 'first.md'), 'utf8'), 'first\n');
    assert.equal(readFileSync(join(target, 'second.md'), 'utf8'), 'concurrent\n');
  });

  it('keeps every covered closeout carrier untouched when one changes before the batch boundary', () => {
    const target = mkdtempSync(join(temp, 'closeout-conditional-'));
    createTaskProjectFixture(target);
    const config = { task_file_template: '.agenticloop/tasks/{taskId}.md' };
    for (const id of ['T-901', 'T-902']) {
      writeFileSync(join(target, '.agenticloop', 'tasks', `${id}.md`), body('accepted', id).replace('backend: github', 'backend: files').replace('task_id: T-901', `task_id: ${id}`), 'utf8');
    }
    const result = applyFilesCloseoutTerminalTransition(target, config, {
      work_unit: 'selection:review', digest: digest('a'), covered_tasks: ['T-901', 'T-902'],
    }, {
      err: () => {},
      fsMutationOptions: {
        beforeWrite: () => writeFileSync(join(target, '.agenticloop', 'tasks', 'T-902.md'), `${body('accepted', 'T-902').replace('backend: github', 'backend: files').replace('task_id: T-901', 'task_id: T-902')}\nconcurrent\n`, 'utf8'),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.receipt.mutationDisposition, 'uncommitted');
    assert.deepEqual(result.receipt.changedPaths, []);
    assert.match(readFileSync(join(target, '.agenticloop', 'tasks', 'T-901.md'), 'utf8'), /status: accepted/);
    assert.match(readFileSync(join(target, '.agenticloop', 'tasks', 'T-902.md'), 'utf8'), /concurrent/);
  });

  it('binds the closeout precondition to the exact bytes used to derive the candidate', () => {
    const target = mkdtempSync(join(temp, 'closeout-source-bytes-'));
    createTaskProjectFixture(target);
    const config = { task_file_template: '.agenticloop/tasks/{taskId}.md' };
    const taskPath = join(target, '.agenticloop', 'tasks', 'T-901.md');
    const original = body('accepted', 'T-901')
      .replace('backend: github', 'backend: files');
    const concurrent = original.replace('Draft.', 'Concurrent edit.');
    writeFileSync(taskPath, original, 'utf8');
    let changed = false;
    const result = applyFilesCloseoutTerminalTransition(target, config, {
      work_unit: 'selection:source-bytes', digest: digest('a'), covered_tasks: ['T-901'],
    }, {
      err: () => {},
      fsMutationOptions: {
        afterCarrierRead: () => {
          if (!changed) writeFileSync(taskPath, concurrent, 'utf8');
          changed = true;
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.receipt.mutationDisposition, 'uncommitted');
    assert.deepEqual(result.receipt.changedPaths, []);
    assert.equal(readFileSync(taskPath, 'utf8'), concurrent);
  });
});

describe('task-body transition note surfaces', () => {
  it('accepts and persists --note for guarded set-field and apply status changes', async () => {
    const setState = { body: body(), bodyWrites: 0, comments: [], commentAttempts: 0 };
    const setResult = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91', '--field', 'status', '--value', 'blocked',
      '--expect-digest', taskBodyDigest(setState.body), '--note', 'waiting for dependency', '--yes', '--json',
    ], { ghCommandRunner: runner(setState), cwd: temp });
    assert.equal(setResult.status, 0, setResult.stderr);
    assert.equal(setState.bodyWrites, 1);
    assert.equal(setState.comments.length, 1);

    const applyState = { body: body(), bodyWrites: 0, comments: [], commentAttempts: 0 };
    const candidate = join(temp, 'apply-blocked.md');
    writeFileSync(candidate, body('blocked', 'Blocked'), 'utf8');
    const applyResult = await runCliInProcess([
      'task-body', 'apply', '--issue', '91', '--body-file', candidate,
      '--expect-digest', taskBodyDigest(applyState.body), '--note', 'waiting for dependency', '--yes', '--json',
    ], { ghCommandRunner: runner(applyState), cwd: temp });
    assert.equal(applyResult.status, 0, applyResult.stderr);
    assert.equal(applyState.bodyWrites, 1);
    assert.equal(applyState.comments.length, 1);
  });

  it('rejects blocked status changes without a note and does not discard a non-status note', async () => {
    const state = { body: body(), bodyWrites: 0, comments: [], commentAttempts: 0 };
    const missing = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91', '--field', 'status', '--value', 'blocked',
      '--expect-digest', taskBodyDigest(state.body), '--yes', '--json',
    ], { ghCommandRunner: runner(state), cwd: temp });
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /requires --note/i);
    const discarded = await runCliInProcess([
      'task-body', 'set-field', '--issue', '91', '--field', 'attempt_budget', '--value', '6',
      '--expect-digest', taskBodyDigest(state.body), '--note', 'not a transition', '--yes', '--json',
    ], { ghCommandRunner: runner(state), cwd: temp });
    assert.equal(discarded.status, 2);
    assert.equal(state.bodyWrites, 0);
  });
});

describe('task-body public-error envelope', () => {
  function dependencySnapshot(observedAt) {
    return JSON.stringify({
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1, source: 'test:dependencies', observedAt,
      freshnessPolicy: { maxAgeSeconds: 60 }, statuses: {},
    });
  }

  async function statusChange(target, state, dependencyPath) {
    return runCliInProcess([
      'task-body', 'set-field', '--issue', '91', '--field', 'status', '--value', 'agent-ready',
      '--expect-digest', taskBodyDigest(state.body), '--base-paths', '.agenticloop/tmp/base.json',
      '--dependencies', dependencyPath, '--yes', '--target', target, '--json',
    ], { ghCommandRunner: runner(state), cwd: target });
  }

  it('keeps malformed, stale, and unresolved public failures in the precise task-body envelope', async () => {
    const cases = [
      {
        name: 'malformed',
        setup: target => writeFileSync(join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH), '{ invalid', 'utf8'),
        dependency: dependencySnapshot(new Date().toISOString()), code: 'verification.context.malformed',
      },
      {
        name: 'stale',
        setup: () => {}, dependency: dependencySnapshot('2020-01-01T00:00:00.000Z'), code: 'verification.context.stale',
      },
      {
        name: 'unresolved',
        setup: target => {
          const receiptValue = lifecycleMutationReceipt(target,
            { command: 'init', actions: [], adapterGroups: [], blockers: [], warnings: [], schemaVersion: 1 },
            { ok: true, committedPaths: ['missing.txt'], committedSegments: ['toolkit'] });
          writeFileSync(join(target, LIFECYCLE_RECEIPT_RELATIVE_PATH), `${JSON.stringify(receiptValue)}\n`, 'utf8');
        },
        dependency: dependencySnapshot(new Date().toISOString()), code: 'evidence.negative',
      },
    ];
    for (const item of cases) {
      const target = mkdtempSync(join(temp, `public-${item.name}-`));
      createTaskProjectFixture(target);
      mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
      writeFileSync(join(target, '.agenticloop', 'tmp', 'base.json'), '[]\n', 'utf8');
      mkdirSync(join(target, 'dependency-evidence'), { recursive: true });
      const dependencyPath = 'dependency-evidence/deps.json';
      writeFileSync(join(target, dependencyPath), item.dependency, 'utf8');
      let gitResult = spawnSync('git', ['-C', target, 'add', dependencyPath], { encoding: 'utf8' });
      assert.equal(gitResult.status, 0, gitResult.stderr);
      gitResult = spawnSync('git', [
        '-C', target, 'commit', '-m',
        'record dependency evidence\n\nTask: #91\nAgent: maintainer',
      ], { encoding: 'utf8' });
      assert.equal(gitResult.status, 0, gitResult.stderr);
      item.setup(target);
      const state = { body: body(), bodyWrites: 0, comments: [], commentAttempts: 0 };
      const result = await statusChange(target, state, dependencyPath);
      assert.equal(result.status, 1, item.name);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.command, 'task-body set-field', item.name);
      assert.equal(envelope.diagnostics[0].code, item.code, item.name);
      assert.ok(envelope.firstSafeRepair, item.name);
      assert.equal(state.bodyWrites, 0, item.name);
    }
  });
});

function digestBytes(value) {
  return (awaitableHash(value));
}

function awaitableHash(value) {
  // Kept local so the expected value is computed from exact UTF-8 bytes.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
