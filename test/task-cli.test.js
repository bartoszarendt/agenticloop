import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-task-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

function assertOk(result) {
  assert.equal(result.status, 0, `expected pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  assertOk(run(['init', '--target', target]));
  return target;
}

function taskPath(target, taskId) {
  return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
}

function writeAcceptedTask(target, taskId, extraFrontmatter = '') {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(taskPath(target, taskId), `---
task_id: ${taskId}
status: accepted
backend: files
implementation_artifact: commit:abc123
review_status: needs_revision
${extraFrontmatter}---

# ${taskId} - Accepted

## Task
Ship the accepted behavior.

## Source Documents Reviewed
- README.md

## Current State
The task is complete.

## Scope
Document the accepted behavior.

## Out of Scope
No extra changes.

## Acceptance Criteria
- Accepted.

## Required Checks
- npm test

## Expected Files or Areas
- src/

## Implementation Notes
Implemented.

## Completion Summary Template
Use the summary below.

## Reviewer Checklist
- [x] Reviewed.

## Scope Completed
Implemented the scoped task.

## Artifacts
- commit:abc123

## Evidence
- npm test passed.

## Deviations
- none

## Process Observations
- none

## Known Gaps
- none

## Follow-Ups
- none

## Outcome

## Comments

## Revision Log
2026-07-07: Revision was requested before acceptance.
`, 'utf-8');
}

describe('task CLI', () => {
  it('creates, lists, lints, and updates a files-backed task', () => {
    const target = makeTarget('happy');

    const created = run(['task', 'new', 'Add CLI support', '--target', target]);
    assertOk(created);
    assert.match(created.stdout, /Created \.agenticloop\/tasks\/T-001\.md/);
    assert.ok(existsSync(taskPath(target, 'T-001')));

    const list = run(['task', 'list', '--target', target]);
    assertOk(list);
    assert.match(list.stdout, /T-001/);
    assert.match(list.stdout, /agent-ready/);

    const lint = run(['task', 'lint', 'T-001', '--target', target]);
    assertOk(lint);
    assert.match(lint.stdout, /T-001\.md: ok/);

    const status = run(['task', 'status', 'T-001', 'in-progress', '--note', 'Started implementation', '--target', target]);
    assertOk(status);
    const content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    assert.match(content, /^status: in-progress$/m);
    assert.match(content, /Started implementation/);
  });

  it('allocates the next default id after gaps', () => {
    const target = makeTarget('gaps');
    assertOk(run(['task', 'new', 'First', '--id', 'T-001', '--target', target]));
    assertOk(run(['task', 'new', 'Third', '--id', 'T-003', '--target', target]));

    const result = run(['task', 'new', 'Fourth', '--target', target, '--json']);
    assertOk(result);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.task_id, 'T-004');
    assert.ok(existsSync(taskPath(target, 'T-004')));
  });

  it('refuses to overwrite an existing task file', () => {
    const target = makeTarget('overwrite');
    assertOk(run(['task', 'new', 'Original', '--target', target]));

    const result = run(['task', 'new', 'Duplicate', '--id', 'T-001', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  });

  it('refuses files task operations when the active backend is github', () => {
    const target = makeTarget('github-guard');
    const projectPath = join(target, '.agenticloop', 'project.md');
    const content = readFileSync(projectPath, 'utf-8').replace('task_backend: files', 'task_backend: github');
    writeFileSync(projectPath, content, 'utf-8');

    const result = run(['task', 'list', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports the files backend only/);
  });

  it('requires block category for blocked status and lint catches missing block_category', () => {
    const target = makeTarget('blocked');
    assertOk(run(['task', 'new', 'Blocked task', '--target', target]));

    const blocked = run(['task', 'status', 'T-001', 'blocked', '--target', target]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /requires --block-category/);

    let content = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    content = content.replace(/^status: agent-ready$/m, 'status: blocked');
    writeFileSync(taskPath(target, 'T-001'), content, 'utf-8');
    const lint = run(['task', 'lint', 'T-001', '--target', target]);
    assert.notEqual(lint.status, 0);
    assert.match(lint.stdout, /missing required frontmatter field 'block_category'/);
  });

  it('warns when accepted churn signals have empty Outcome', () => {
    const target = makeTarget('outcome-warning');
    writeAcceptedTask(target, 'T-010');

    const result = run(['task', 'lint', 'T-010', '--target', target, '--json']);
    assertOk(result);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload[0].errors.length, 0);
    assert.ok(payload[0].warnings.some(w => w.includes("empty '## Outcome' section")));
  });

  it('warns but continues when a task subcommand receives an unknown option', () => {
    const target = makeTarget('unknown-option');
    assertOk(run(['task', 'new', 'Warn on unknown option', '--target', target]));

    const result = run(['task', 'list', '--target', target, '--bogus']);

    assertOk(result);
    assert.match(result.stderr, /WARN: task list ignoring unknown option\(s\): --bogus/);
    assert.match(result.stdout, /T-001/);
  });
});
