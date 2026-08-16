/**
 * Handoff-preflight tests for the GitHub backend.
 *
 * Covers: GitHub issue snapshot creation via #NUMBER and T-NNN (label)
 * resolution, malformed frontmatter, legacy issue-number identity, task
 * identity mismatch, gh CLI failure, gh auth failure, no-mutation guarantee,
 * and basic downstream pipeline shape (readiness, decomposition, repository).
 *
 * The `gh` CLI is mocked throughout; no network calls are made.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { evaluateHandoffPreflight } from '../src/handoff-preflight.js';

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-preflight-gh-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  createTaskProjectFixture(target);
  return target;
}

/**
 * Build a valid GitHub task-record body.
 *
 * @param {object} opts
 * @param {string} [opts.taskId]      frontmatter task_id value
 * @param {string} [opts.status]      frontmatter status
 * @param {boolean} [opts.malformed]  return content without any frontmatter
 * @param {boolean} [opts.noFront]    return content with no frontmatter at all (absent)
 */
function makeGitHubBody({ taskId, status = 'agent-ready', malformed = false, noFront = false } = {}) {
  if (malformed) {
    return 'completely invalid content without frontmatter\n';
  }
  if (noFront) {
    return `# Legacy Issue\n\nSome body without any frontmatter.\n`;
  }
  const taskIdLine = taskId ? `task_id: ${taskId}\n` : '';
  return `---
${taskIdLine}status: ${status}
backend: github
allowed_paths:
  - "src/**"
intended_creations: []
task_contract_schema: 2
---

# ${taskId ?? 'Task'} - Test Task

## Task
Implement the feature.

## Source Documents Reviewed
- README.md

## Current State
Ready for implementation.

## Scope
src/** only.

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

[[agent: maintainer]]
`;
}

/**
 * Build a mock gh command runner that knows about a map of issue bodies.
 *
 * Supports:
 *   gh issue view <number> --json body,number
 *   gh issue list --label task:<taskId> --json number --limit 1
 *
 * @param {Record<number, string>} issueBodies  issue number → body text
 */
function makeGhRunner(issueBodies) {
  return (_command, args) => {
    // gh issue view NUMBER --json body,number
    if (args[0] === 'issue' && args[1] === 'view') {
      const number = Number(args[2]);
      const body = issueBodies[number];
      if (body !== undefined) {
        return { status: 0, stdout: JSON.stringify({ number, body }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `issue #${number} not found` };
    }
    // gh issue list --label task:<taskId> --json number --limit 1
    if (args[0] === 'issue' && args[1] === 'list') {
      const labelIdx = args.indexOf('--label');
      if (labelIdx !== -1 && args[labelIdx + 1]) {
        const label = args[labelIdx + 1];
        const searchTaskId = label.replace(/^task:/, '');
        for (const [number, body] of Object.entries(issueBodies)) {
          if (body.includes(`task_id: ${searchTaskId}`)) {
            return { status: 0, stdout: JSON.stringify([{ number: Number(number) }]), stderr: '' };
          }
        }
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
  };
}

describe('handoff-preflight-github', () => {
  it('creates a valid snapshot for a GitHub issue with #NUMBER format', () => {
    const target = makeTarget('gh-number');
    // Body has task_id matching the issue-number identity (#42)
    const body = makeGitHubBody({ taskId: '#42' });
    const ghRunner = makeGhRunner({ 42: body });

    const result = evaluateHandoffPreflight({
      target, taskId: '#42', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    // The snapshot should be created successfully; downstream errors (activation,
    // decomposition) are expected because no local activation/decomposition exists.
    assert.equal(result.backend, 'github');
    assert.equal(result.taskId, '#42');
    assert.equal(result.carrier, 'issue:42');
    assert.ok(result.carrierDigest.startsWith('sha256:'), 'carrier digest should be sha256');
    assert.ok(result.contractDigest.startsWith('sha256:v1:'), 'contract digest should be sha256:v1');
    assert.notEqual(result.carrierDigest, result.contractDigest, 'carrier and contract digests must be distinct');
    assert.equal(result.kind, 'agenticloop.handoff-preflight');
    assert.equal(result.schemaVersion, 1);
    // Snapshot is created but blocked by activation/decomposition
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1, 'should have at least activation or decomposition error');
  });

  it('creates a valid snapshot for T-NNN format via label resolution', () => {
    const target = makeTarget('gh-label');
    const body = makeGitHubBody({ taskId: 'T-002' });
    const ghRunner = makeGhRunner({ 101: body });

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-002', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    // Snapshot should be created via label resolution
    assert.equal(result.backend, 'github');
    assert.equal(result.taskId, 'T-002');
    assert.equal(result.carrier, 'issue:101');
    assert.ok(result.carrierDigest.startsWith('sha256:'));
    assert.ok(result.contractDigest.startsWith('sha256:v1:'));
    // Downstream errors expected
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('activation') || e.includes('decomposition')),
      `expected activation/decomposition error, got: ${JSON.stringify(result.errors)}`);
  });

  it('reports malformed frontmatter', () => {
    const target = makeTarget('gh-malformed');
    const body = makeGitHubBody({ malformed: true });
    const ghRunner = makeGhRunner({ 50: body });

    const result = evaluateHandoffPreflight({
      target, taskId: '#50', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 1, `expected at least 1 error, got ${result.errors.length}`);
    assert.ok(
      result.errors.some(e => e.includes('malformed') || e.includes('invalid') || e.includes('contract')),
      `expected malformed/contract error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('resolves legacy issue-number identity (no frontmatter at all)', () => {
    const target = makeTarget('gh-legacy');
    // Body with NO frontmatter (frontmatter state = 'absent')
    const body = makeGitHubBody({ noFront: true });
    const ghRunner = makeGhRunner({ 77: body });

    const result = evaluateHandoffPreflight({
      target, taskId: '#77', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    // For a body with no frontmatter, taskContractDigest returns ok:false,
    // so the preflight reports a contract error. This is correct — a GitHub
    // issue without frontmatter cannot serve as a valid task record.
    assert.equal(result.backend, 'github');
    assert.equal(result.taskId, '#77');
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('contract') || e.includes('malformed') || e.includes('invalid')),
      `expected contract error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('reports task identity mismatch', () => {
    const target = makeTarget('gh-mismatch');
    // Issue body has task_id: T-001 but we request #42
    const body = makeGitHubBody({ taskId: 'T-001' });
    const ghRunner = makeGhRunner({ 42: body });

    const result = evaluateHandoffPreflight({
      target, taskId: '#42', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('identity_mismatch') || e.includes('does not match')),
      `expected identity mismatch error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('reports gh CLI failure gracefully', () => {
    const target = makeTarget('gh-cli-fail');
    const ghRunner = () => { throw new Error("failed to run 'gh': ENOENT"); };

    const result = evaluateHandoffPreflight({
      target, taskId: '#99', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('GitHub') || e.includes('gh') || e.includes('failed')),
      `expected gh CLI error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('reports gh auth failure gracefully', () => {
    const target = makeTarget('gh-auth');
    const ghRunner = (_cmd, args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 1, stdout: '', stderr: 'gh: not logged in. Run gh auth login to authenticate.' };
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    };

    const result = evaluateHandoffPreflight({
      target, taskId: '#88', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('auth') || e.includes('authenticated') || e.includes('gh')),
      `expected auth error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('reports error when issue body is empty/null', () => {
    const target = makeTarget('gh-empty');
    const ghRunner = (_cmd, args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 60, body: null }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    };

    const result = evaluateHandoffPreflight({
      target, taskId: '#60', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('no readable body') || e.includes('absent')),
      `expected body error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('reports error when label resolution returns no match', () => {
    const target = makeTarget('gh-no-label');
    // No issues in the runner → label search returns empty
    const ghRunner = makeGhRunner({});

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-999', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('could not be resolved') || e.includes('issue number')),
      `expected resolution error, got: ${JSON.stringify(result.errors)}`
    );
  });

  it('does not mutate the target', () => {
    const target = makeTarget('gh-no-mutate');
    const body = makeGitHubBody({ taskId: '#42' });
    const ghRunner = makeGhRunner({ 42: body });

    const headBefore = git(target, ['rev-parse', 'HEAD']);
    const statusBefore = git(target, ['status', '--porcelain', '--untracked-files=all']);

    evaluateHandoffPreflight({
      target, taskId: '#42', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    const headAfter = git(target, ['rev-parse', 'HEAD']);
    const statusAfter = git(target, ['status', '--porcelain', '--untracked-files=all']);

    assert.equal(headBefore, headAfter, 'HEAD must not change');
    assert.equal(statusBefore, statusAfter, 'working tree must not change');
  });

  it('produces the correct domain shape for a GitHub snapshot', () => {
    const target = makeTarget('gh-shape');
    const body = makeGitHubBody({ taskId: 'T-020' });
    const ghRunner = makeGhRunner({ 42: body });

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-020', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
    });

    // Verify the full domain shape is present
    assert.equal(result.backend, 'github');
    assert.equal(result.taskId, 'T-020');
    assert.equal(result.carrier, 'issue:42');
    assert.ok(result.carrierDigest);
    assert.ok(result.contractDigest);
    // Readiness is evaluated from local .agenticloop/ state
    assert.ok(result.readiness !== undefined, 'readiness should be present in the result');
    // Decomposition is null because no decomposition source exists
    assert.equal(result.decomposition, null);
    // Repository state is evaluated from local git
    assert.ok(result.repository, 'repository state should be present');
    assert.ok(result.repository.head, 'repository should have HEAD');
    // Clean state is evaluated
    assert.ok(typeof result.cleanState === 'string', 'cleanState should be a string');
    // Return adapter is evaluated
    assert.ok(result.returnAdapter, 'returnAdapter should be present');
    // Sibling worktrees are evaluated
    assert.ok(Array.isArray(result.siblingCollisions), 'siblingCollisions should be an array');
    assert.ok(Array.isArray(result.siblingWorktrees), 'siblingWorktrees should be an array');
    // Activation is null because no activation capture exists
    assert.equal(result.activation, null);
    assert.equal(result.operatorAuthorization, 'missing');
  });

  it('produces deterministic output for the same GitHub snapshot', () => {
    const target = makeTarget('gh-deterministic');
    const body = makeGitHubBody({ taskId: 'T-030' });
    const ghRunner = makeGhRunner({ 42: body });
    const now = new Date().toISOString();

    const result1 = evaluateHandoffPreflight({
      target, taskId: 'T-030', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
      now,
    });

    const result2 = evaluateHandoffPreflight({
      target, taskId: 'T-030', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
      now,
    });

    assert.equal(result1.ok, result2.ok);
    assert.equal(result1.backend, result2.backend);
    assert.equal(result1.carrier, result2.carrier);
    assert.equal(result1.carrierDigest, result2.carrierDigest);
    assert.equal(result1.contractDigest, result2.contractDigest);
    assert.equal(result1.taskId, result2.taskId);
  });

  it('evaluates downstream readiness from local .agenticloop/ for GitHub snapshot', () => {
    const target = makeTarget('gh-readiness');
    const body = makeGitHubBody({ taskId: 'T-040' });
    const ghRunner = makeGhRunner({ 42: body });
    const now = new Date().toISOString();

    // Write a task file locally so readiness can evaluate scope patterns
    // (readiness reads from local .agenticloop/ even for GitHub backend)
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-040.md'), body, 'utf8');
    git(target, ['add', '.agenticloop/tasks']);
    git(target, ['commit', '-m', 'add task for readiness']);

    const result = evaluateHandoffPreflight({
      target, taskId: 'T-040', backend: 'github',
      projectConfig: {},
      io: { ghCommandRunner: ghRunner },
      now,
    });

    assert.ok(result.readiness, 'readiness should be evaluated');
    assert.equal(result.readiness.ok, true, `readiness should pass, got errors: ${JSON.stringify(result.readiness.errors)}`);
    // dependencyAge.evaluatedAt is only set when a dependency snapshot exists;
    // here it is 'missing' because no decomposition source was created.
    assert.equal(result.dependencyAge.state, 'missing');
  });
});
