import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { runCliInProcess } from './helpers/run-cli.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-event-validate-cli-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function makeTarget(name) {
  return mkdtempSync(join(tmpBase, `${name}-`));
}

function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

function assertOk(result) {
  assert.equal(
    result.status,
    0,
    `expected command to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function writeValidTaskRecord(target, taskId = 'T-001') {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(
    join(target, '.agenticloop', 'tasks', `${taskId}.md`),
    `---
task_id: ${taskId}
status: agent-ready
backend: files
implementation_artifact:
review_status:
---

# ${taskId} - Sample Task

## Task
Implement the scoped sample change.

## Source Documents Reviewed
- README.md

## Current State
The target starts from a clean scaffold.

## Scope
Add the requested workflow behavior only.

## Out of Scope
Do not add unrelated tooling changes.

## Acceptance Criteria
- The requested behavior is implemented.

## Required Checks
- Run the documented validation command for the final state.

## Expected Files or Areas
- .agenticloop/tasks/${taskId}.md

## Implementation Notes
Keep the change narrow and reversible.

## Completion Summary Template
Document the implementation summary, files changed, tests and checks run, results, known limitations, deviations, and follow-up recommendations.

## Reviewer Checklist
- [ ] Scope verified against the listed source documents.
- [ ] Required checks were run on the final state.
- [ ] Durable evidence was recorded in the task record.
`,
    'utf-8'
  );
}

describe('agenticloop validate event-log integration', () => {
  it('validate passes when no event logs exist and validates an existing event log', async () => {
    const withoutLogs = makeTarget('no-event-logs');
    assertOk(runBin(['init', '--target', withoutLogs]));

    const noLogsResult = runBin(['validate', '--target', withoutLogs]);
    assertOk(noLogsResult);
    assert.doesNotMatch(noLogsResult.stdout, /Event Logs/);

    const withLogs = makeTarget('with-event-logs');
    assertOk(runBin(['init', '--target', withLogs]));
    writeValidTaskRecord(withLogs);
    assertOk(await runCliInProcess([
      'event', 'task.created',
      '--target', withLogs,
      '--task', 'T-001',
      '--role', 'maintainer',
      '--summary', 'Created files task record',
    ]));

    const withLogsResult = runBin(['validate', '--target', withLogs]);
    assertOk(withLogsResult);
    assert.match(withLogsResult.stdout, /Event Logs - OK/);
    assert.ok(withLogsResult.stdout.includes(join(withLogs, '.agenticloop', 'logs')));
  });

  it('agenticloop validate checks every default event log file', async () => {
    const target = makeTarget('all-logs');
    assertOk(runBin(['init', '--target', target]));
    writeValidTaskRecord(target);

    assertOk(await runCliInProcess([
      'event', 'task.created',
      '--target', target,
      '--task', 'T-001',
      '--role', 'maintainer',
      '--summary', 'Created files task record',
    ]));
    assertOk(await runCliInProcess([
      'event', 'decision.recorded',
      '--target', target,
      '--output', join(target, '.agenticloop', 'logs', 'manual.jsonl'),
      '--role', 'maintainer',
      '--summary', 'Recorded setup decision',
    ]));

    const result = runBin(['validate', '--target', target]);
    assertOk(result);
    assert.match(result.stdout, /OK: 2 file\(s\), 2 event\(s\) validated/);
  });
});
