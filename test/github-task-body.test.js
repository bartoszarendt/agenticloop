import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyGitHubTaskBody,
  lintGitHubTaskBody,
  summarizeTaskBodyChanges,
  taskBodyDigest,
} from '../src/github-task-body.js';
import {
  renderTaskContractBaselineMarker,
  renderTaskContractCorrectionMarker,
  createTaskContractBaselineRecord,
  createTaskContractCorrectionRecord,
  taskContractDigest,
  validateTaskContractBaseline,
} from '../src/task-contract-baseline.js';
import { runCliInProcess } from './helpers/run-cli.js';

function taskBody({ title = 'Draft task', status = 'draft' } = {}) {
  return [
    '---',
    'task_id: T-101',
    `status: ${status}`,
    'backend: github',
    'attempt_budget: 5',
    'review_budget: 5',
    'allowed_paths:',
    '  - src/**',
    'intended_creations:',
    '  - src/new.js',
    '---',
    '',
    `# T-101 - ${title}`,
    '',
    '## Task', 'Implement the guarded task body operation.', '',
    '## Source Documents Reviewed', '- `README.md`', '',
    '## Current State', 'Task body updates were unguarded.', '',
    '## Scope', 'Guard task body updates.', '',
    '## Out of Scope', 'Do not update pull request bodies.', '',
    '## Acceptance Criteria', '- The body is validated before publication.', '',
    '## Required Checks', '- `npm test`', '',
    '## Expected Files or Areas', '- src/', '',
    '## Implementation Notes', 'Keep the operation transactional.', '',
    '## Completion Summary Template', 'Summarize the result.', '',
    '## Reviewer Checklist', '- [ ] Validate the candidate.', '',
    '[[agent: maintainer]]',
  ].join('\n');
}

function issueRunner(state, { mutate } = {}) {
  return (_command, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([state.comments ?? []]) };
    if (args[0] !== 'issue') return { status: 1, stderr: 'unexpected command' };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 31, body: state.body }) };
    if (args[1] === 'edit') {
      state.edits++;
      const path = args[args.indexOf('--body-file') + 1];
      state.body = mutate ? mutate(readFileSync(path, 'utf8'), state.edits) : readFileSync(path, 'utf8');
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: 'unexpected issue action' };
  };
}

describe('task-contract digest markers', () => {
  it('canonicalizes line endings but preserves meaningful Markdown indentation', () => {
    const original = taskBody();
    const digest = taskContractDigest(original).digest;
    assert.equal(digest, taskContractDigest(original.replaceAll('\n', '\r\n')).digest);
    assert.notEqual(
      taskContractDigest(original.replace('## Scope\nGuard task body updates.', '## Scope\n- parent\n  - nested')).digest,
      taskContractDigest(original.replace('## Scope\nGuard task body updates.', '## Scope\n- parent\n    - nested')).digest,
    );
  });

  it('requires independently verified baseline and correction records for new lifecycle transitions', () => {
    const original = taskBody();
    const digest = taskContractDigest(original).digest;
    const carrier = { id: '100', kind: 'github_issue_comment', url: 'https://example.test/comment/100', author: 'maintainer', authorAssociation: 'MEMBER', createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z', bodyDigest: 'sha256:carrier-body', verifiedAuthority: true, edited: false };
    const baselineRecord = createTaskContractBaselineRecord({
      recordId: 'github-comment:100', taskId: 'T-101', digest, projection: taskContractDigest(original).projection,
      authority: 'maintainer:dispatch', actor: 'maintainer', timestamp: '2026-01-02T03:04:05.000Z', affectedArtifact: 'issue:31',
    });
    baselineRecord.carrier = carrier;

    const cachedMarker = original.replace('[[agent: maintainer]]', `${renderTaskContractBaselineMarker({ digest, recordId: baselineRecord.recordId })}\n\n[[agent: maintainer]]`);
    assert.equal(validateTaskContractBaseline(cachedMarker, { lifecycle: 'new' }).ok, false, 'body marker alone is not authority');
    assert.equal(validateTaskContractBaseline(cachedMarker, { lifecycle: 'new', trustedRecords: [baselineRecord] }).ok, true);

    const changed = cachedMarker.replace('Guard task body updates.', 'Guard all task-record updates.');
    const newDigest = taskContractDigest(changed).digest;
    const correctionRecord = createTaskContractCorrectionRecord({
      recordId: 'github-comment:101', carrier: { ...carrier, id: 'github-comment:101' }, taskId: 'T-101',
      priorDigest: digest,
      resultingDigest: newDigest,
      priorProjection: taskContractDigest(original).projection,
      resultingProjection: taskContractDigest(changed).projection,
      changes: [{ field: 'scope', oldValue: 'Guard task body updates.', newValue: 'Guard all task-record updates.' }],
      reason: 'Clarify the accepted implementation scope.',
      authority: 'maintainer: task refinement', actor: 'maintainer', affectedArtifact: 'issue:31', timestamp: '2026-01-02T03:05:05.000Z',
    });
    correctionRecord.carrier = { ...carrier, id: '101', url: 'https://example.test/comment/101' };
    const corrected = changed.replace('[[agent: maintainer]]', `${renderTaskContractCorrectionMarker({
      priorDigest: digest, resultingDigest: newDigest, reason: 'Cache only.', classification: 'directly_connected', authority: 'maintainer: task refinement', recordId: correctionRecord.recordId,
    })}\n\n[[agent: maintainer]]`);
    assert.equal(validateTaskContractBaseline(corrected, { lifecycle: 'new', trustedRecords: [baselineRecord, correctionRecord] }).ok, true);
    const tampered = corrected.replace(newDigest, digest);
    assert.equal(validateTaskContractBaseline(tampered, { lifecycle: 'new', trustedRecords: [baselineRecord, correctionRecord] }).ok, true, 'marker cache cannot replace trusted authority');
  });
});

describe('transactional GitHub task-body application', () => {
  it('exercises fetch, lint, and dry-run apply through the offline CLI runner', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-cli-'));
    try {
      const state = { body: taskBody(), edits: 0 };
      const runner = issueRunner(state);
      const file = join(directory, 'issue-31.md');
      const fetched = await runCliInProcess(['task-body', 'fetch', '--issue', '31', '--output', file, '--json'], {
        cwd: directory,
        ghCommandRunner: runner,
      });
      assert.equal(fetched.status, 0, fetched.stderr);
      assert.equal(JSON.parse(fetched.stdout).digest, taskBodyDigest(state.body));
      assert.equal(readFileSync(file, 'utf8'), state.body);

      const linted = await runCliInProcess(['task-body', 'lint', '--issue', '31', '--body-file', file, '--json'], {
        cwd: directory,
        ghCommandRunner: runner,
      });
      assert.equal(linted.status, 0, linted.stderr);
      assert.equal(JSON.parse(linted.stdout).ok, true);

      writeFileSync(file, taskBody({ title: 'Updated task' }), 'utf8');
      const preview = await runCliInProcess([
        'task-body', 'apply', '--issue', '31', '--body-file', file,
        '--expect-digest', taskBodyDigest(state.body), '--dry-run', '--json',
      ], { cwd: directory, ghCommandRunner: runner });
      assert.equal(preview.status, 0, preview.stderr);
      assert.equal(JSON.parse(preview.stdout).dryRun, true);
      assert.equal(state.edits, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed candidates before publishing', () => {
    const state = { body: taskBody(), edits: 0 };
    const result = applyGitHubTaskBody({
      issue: 31,
      body: '---\ntask_id: T-101',
      expectDigest: taskBodyDigest(state.body),
      yes: true,
      commandRunner: issueRunner(state),
    });
    assert.equal(result.ok, false);
    assert.equal(state.edits, 0);
  });

  it('rejects BOM-bearing candidates before publishing', () => {
    const state = { body: taskBody(), edits: 0 };
    assert.throws(() => applyGitHubTaskBody({
      issue: 31,
      body: `\uFEFF${taskBody()}`,
      expectDigest: taskBodyDigest(state.body),
      yes: true,
      commandRunner: issueRunner(state),
    }), /UTF-8 BOM/);
    assert.equal(state.edits, 0);
  });

  it('rejects stale expected digests without publishing', () => {
    const state = { body: taskBody(), edits: 0 };
    const result = applyGitHubTaskBody({
      issue: 31,
      body: taskBody({ title: 'Updated task' }),
      expectDigest: taskBodyDigest('stale'),
      yes: true,
      commandRunner: issueRunner(state),
    });
    assert.equal(result.stale, true);
    assert.equal(state.edits, 0);
  });

  it('dry-runs deterministically without publishing', () => {
    const state = { body: taskBody(), edits: 0 };
    const result = applyGitHubTaskBody({
      issue: 31,
      body: taskBody({ title: 'Updated task' }),
      expectDigest: taskBodyDigest(state.body),
      dryRun: true,
      commandRunner: issueRunner(state),
    });
    assert.equal(result.ok, true);
    assert.match(result.diff, /--- remote issue body/);
    assert.match(result.diff, /@@ -\d+,\d+ \+\d+,\d+ @@/);
    const summary = summarizeTaskBodyChanges(state.body, taskBody({ title: 'Updated task' }));
    assert.deepEqual(summary.frontmatterFields, []);
    assert.deepEqual(summary.addedSections, []);
    assert.deepEqual(summary.removedSections, []);
    assert.equal(state.edits, 0);
  });

  it('does not overwrite concurrent remote changes and retains recovery files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-'));
    try {
      const state = { body: taskBody(), edits: 0 };
      const result = applyGitHubTaskBody({
        issue: 31,
        body: taskBody({ title: 'Updated task' }),
        expectDigest: taskBodyDigest(state.body),
        yes: true,
        commandRunner: issueRunner(state, { mutate: () => `${taskBody()}\nconcurrent writer` }),
        recoveryDir: directory,
      });
      assert.equal(result.ok, false);
      assert.equal(result.rollback.attempted, false);
      assert.equal(state.edits, 1);
      assert.ok(existsSync(result.recovery.originalPath));
      assert.ok(existsSync(result.recovery.candidatePath));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects post-write content that differs from the validated candidate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-'));
    try {
      const state = { body: taskBody(), edits: 0 };
      const result = applyGitHubTaskBody({
        issue: 31,
        body: taskBody({ title: 'Updated task' }),
        expectDigest: taskBodyDigest(state.body),
        yes: true,
        commandRunner: issueRunner(state, { mutate: body => body.replace('Updated task', 'server rewrite') }),
        recoveryDir: directory,
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /does not match validated candidate/);
      assert.equal(result.rollback.attempted, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back only after a fresh lease confirms the exact invalid candidate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-'));
    try {
      const state = { body: taskBody(), edits: 0 };
      let lintCalls = 0;
      const result = applyGitHubTaskBody({
        issue: 31,
        body: taskBody({ title: 'Updated task' }),
        expectDigest: taskBodyDigest(state.body),
        yes: true,
        commandRunner: issueRunner(state),
        recoveryDir: directory,
        lint: () => ({ ok: ++lintCalls !== 2, errors: ['forced post-write validation failure'] }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.rollback.attempted, true);
      assert.equal(result.rollback.restored, true);
      assert.equal(state.body, taskBody());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an exact BOM-bearing fetch and creates a separately labelled sanitization candidate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-bom-'));
    try {
      const state = { body: `\uFEFF${taskBody()}`, edits: 0 };
      const output = join(directory, 'issue-31.md');
      const result = await runCliInProcess(['task-body', 'fetch', '--issue', '31', '--output', output, '--json'], { cwd: directory, ghCommandRunner: issueRunner(state) });
      const json = JSON.parse(result.stdout);
      assert.equal(readFileSync(output, 'utf8'), state.body);
      assert.equal(readFileSync(json.sanitizedOutput, 'utf8'), taskBody());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for an agent-ready transition without an authoritative base inventory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-transition-'));
    try {
      const state = { body: taskBody(), edits: 0 };
      const result = await runCliInProcess([
        'task-body', 'transition', '--issue', '31', '--status', 'agent-ready',
        '--expect-digest', taskBodyDigest(state.body), '--dry-run', '--json',
      ], { cwd: directory, ghCommandRunner: issueRunner(state) });
      assert.equal(result.status, 2);
      assert.match(result.stdout, /--base <ref>|--base-paths/i);
      assert.equal(state.edits, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains successful recovery artifacts by default and can clean them after verified success', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-task-body-success-'));
    try {
      const state = { body: taskBody(), edits: 0 };
      const retained = applyGitHubTaskBody({ issue: 31, body: taskBody({ title: 'Updated task' }), expectDigest: taskBodyDigest(state.body), yes: true, commandRunner: issueRunner(state), recoveryDir: directory });
      assert.equal(retained.ok, true);
      assert.equal(retained.recovery.retained, true);
      assert.ok(existsSync(retained.recovery.originalPath));
      const state2 = { body: taskBody(), edits: 0 };
      const cleaned = applyGitHubTaskBody({ issue: 31, body: taskBody({ title: 'Updated task' }), expectDigest: taskBodyDigest(state2.body), yes: true, commandRunner: issueRunner(state2), recoveryDir: directory, retainRecovery: false });
      assert.equal(cleaned.ok, true);
      assert.equal(cleaned.recovery.retained, false);
      assert.equal(existsSync(cleaned.recovery.originalPath), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lints complete valid candidates without requiring live GitHub', () => {
    const result = lintGitHubTaskBody({ issue: 31, body: taskBody() });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});
