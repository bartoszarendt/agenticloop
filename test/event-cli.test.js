import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-event-cli-test-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

function assertOk(result) {
  assert.equal(
    result.status,
    0,
    `expected command to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function makeTarget(name) {
  return mkdtempSync(join(tmpBase, `${name}-`));
}

function eventLogPath(target, fileName) {
  return join(target, '.agenticloop', 'logs', fileName);
}

function writeProjectMap(target, { eventLogging = 'disabled', taskBackend = 'files' } = {}) {
  mkdirSync(join(target, '.agenticloop'), { recursive: true });
  writeFileSync(
    join(target, '.agenticloop', 'project.md'),
    [
      '---',
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      `task_backend: ${taskBackend}`,
      `event_logging: ${eventLogging}`,
      'event_logging_command: ""',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
      '---',
      '# Project Map',
    ].join('\n'),
    'utf-8'
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

function appendAuditFixtureEvents(target, taskId, eventTypes = ['role.invoked', 'task.started', 'check.run', 'review.result', 'task.closed']) {
  const definitions = {
    'role.invoked': ['event', 'role.invoked', '--target', target, '--task', taskId, '--role', 'orchestrator', '--summary', 'Delegated engineer'],
    'task.started': ['event', 'task.started', '--target', target, '--task', taskId, '--role', 'engineer', '--summary', 'Started scoped implementation'],
    'check.run': ['event', 'check.run', '--target', target, '--task', taskId, '--role', 'engineer', '--summary', 'npm test passed', '--outcome', 'success'],
    'review.result': ['event', 'review.result', '--target', target, '--task', taskId, '--role', 'maintainer', '--summary', 'Accepted implementation', '--outcome', 'accepted'],
    'task.closed': ['event', 'task.closed', '--target', target, '--task', taskId, '--role', 'maintainer', '--summary', 'Closed task', '--outcome', 'success'],
  };

  for (const eventType of eventTypes) {
    assertOk(run(definitions[eventType]));
  }
}

describe('event CLI', () => {
  it('event-logging appends and validates the default task-scoped event log', () => {
    const target = makeTarget('event-logging-alias');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event-logging',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started scoped implementation',
    ]));

    const filePath = eventLogPath(target, 'T-001.jsonl');
    assert.ok(existsSync(filePath));
    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    assert.equal(event.event_type, 'task.started');

    const result = run(['event-logging', 'validate', '--target', target]);
    assertOk(result);
    assert.match(result.stdout, /agenticloop event-logging validate/);
    assert.match(result.stdout, /OK: 1 file\(s\), 1 event\(s\) validated/);
  });

  it('treats task.started --outcome required as the default unknown outcome', () => {
    const target = makeTarget('task-started-required-outcome');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    const result = run([
      'event',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--outcome',
      'required',
      '--summary',
      'Started scoped implementation',
    ]);

    assertOk(result);
    assert.match(result.stderr, /--outcome required.*default outcome 'unknown'/);

    const event = JSON.parse(readFileSync(eventLogPath(target, 'T-001.jsonl'), 'utf-8').trim());
    assert.equal(event.event_type, 'task.started');
    assert.equal(event.outcome, 'unknown');
  });

  it('fails default event writes when --task is missing', () => {
    const target = makeTarget('missing-task-default-output');

    const result = run([
      'event',
      'decision.recorded',
      '--target',
      target,
      '--role',
      'maintainer',
      '--summary',
      'Recorded setup decision',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--task is required for default event logging output/);
  });

  it('allows no-task events when --output is supplied', () => {
    const target = makeTarget('manual-event-log');
    const output = eventLogPath(target, 'manual.jsonl');

    assertOk(run([
      'event',
      'decision.recorded',
      '--target',
      target,
      '--output',
      output,
      '--role',
      'maintainer',
      '--summary',
      'Recorded setup decision',
    ]));

    assert.ok(existsSync(output));
    const event = JSON.parse(readFileSync(output, 'utf-8').trim());
    assert.equal(event.event_type, 'decision.recorded');
    assert.equal(event.task_id, null);
  });

  it('writes github-backed task events without requiring a local task file', () => {
    const target = makeTarget('github-no-local-task-file');
    writeProjectMap(target, { taskBackend: 'github' });

    const result = run([
      'event',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started scoped implementation',
    ]);

    assertOk(result);
    assert.doesNotMatch(result.stderr, /no local files task record/);
    assert.ok(existsSync(eventLogPath(target, 'T-001.jsonl')));
  });

  it('writes files-backed task events with a warning when the task file does not exist', () => {
    const target = makeTarget('files-no-local-task-file');
    writeProjectMap(target, { taskBackend: 'files' });

    const result = run([
      'event',
      'role.invoked',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'orchestrator',
      '--summary',
      'Delegated engineer',
      '--backend',
      'files',
    ]);

    assertOk(result);
    assert.match(result.stderr, /no local files task record/);
    assert.ok(existsSync(eventLogPath(target, 'T-001.jsonl')));
  });

  it('surfaces unsupported task backend warnings on event writes', () => {
    const target = makeTarget('unsupported-backend-warning');
    writeProjectMap(target, { taskBackend: 'jira' });

    const result = run([
      'event-logging',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started scoped task',
    ]);

    assertOk(result);
    assert.match(result.stderr, /Unsupported task backend 'jira'/);
  });

  it('writes task-scoped events with the same derived trace id', () => {
    const target = makeTarget('append-events');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event',
      'task.created',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Created files task record',
    ]));
    assertOk(run([
      'event',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'npm test passed',
      '--outcome',
      'success',
      '--ref',
      'command:npm test',
    ]));

    const filePath = eventLogPath(target, 'T-001.jsonl');
    assert.ok(existsSync(filePath));
    const lines = readFileSync(filePath, 'utf-8').trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.event_type, 'task.created');
    assert.equal(second.event_type, 'check.run');
    assert.equal(first.trace_id, second.trace_id);
  });

  it('writes different tasks to different event log files', () => {
    const target = makeTarget('different-task-files');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');
    writeValidTaskRecord(target, 'T-002');

    assertOk(run([
      'event',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started first task',
    ]));
    assertOk(run([
      'event',
      'task.started',
      '--target',
      target,
      '--task',
      'T-002',
      '--role',
      'engineer',
      '--summary',
      'Started second task',
    ]));

    const firstPath = eventLogPath(target, 'T-001.jsonl');
    const secondPath = eventLogPath(target, 'T-002.jsonl');
    assert.ok(existsSync(firstPath));
    assert.ok(existsSync(secondPath));
    assert.equal(JSON.parse(readFileSync(firstPath, 'utf-8').trim()).task_id, 'T-001');
    assert.equal(JSON.parse(readFileSync(secondPath, 'utf-8').trim()).task_id, 'T-002');
  });

  it('rejects invalid event types', () => {
    const target = makeTarget('invalid-event-type');
    const result = run(['event', 'not.real', '--target', target, '--summary', 'Bad event']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /event_type must be one of/);
  });

  it('rejects privacy-blocked data payloads', () => {
    const target = makeTarget('privacy-payload');
    const result = run([
      'event',
      'decision.recorded',
      '--target',
      target,
      '--summary',
      'Kept files backend',
      '--data-json',
      '{"messages":[{"role":"user","content":"secret"}]}',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /banned privacy-sensitive key 'data\.messages'/);
  });

  it('rejects review.result when outcome is omitted', () => {
    const target = makeTarget('review-result-missing-outcome');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    const result = run([
      'event',
      'review.result',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Recorded maintainer decision',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /event_type 'review\.result' requires outcome accepted or needs_revision/);
  });

  it('accepts review.result with outcome accepted', () => {
    const target = makeTarget('review-result-accepted');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    const result = run([
      'event',
      'review.result',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Accepted implementation',
      '--outcome',
      'accepted',
    ]);

    assertOk(result);
    const filePath = eventLogPath(target, 'T-001.jsonl');
    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    assert.equal(event.event_type, 'review.result');
    assert.equal(event.outcome, 'accepted');
  });

  it('rejects incompatible task.created outcomes', () => {
    const target = makeTarget('task-created-accepted');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    const result = run([
      'event',
      'task.created',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Created task record',
      '--outcome',
      'accepted',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /event_type 'task\.created' requires outcome unknown or success/);
  });

  it('accepts check.run with success, failure, and blocked outcomes', () => {
    const target = makeTarget('check-run-outcomes');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    for (const outcome of ['success', 'failure', 'blocked']) {
      assertOk(run([
        'event',
        'check.run',
        '--target',
        target,
        '--task',
        'T-001',
        '--role',
        'engineer',
        '--summary',
        `Recorded ${outcome} check run`,
        '--outcome',
        outcome,
      ]));
    }

    const filePath = eventLogPath(target, 'T-001.jsonl');
    const entries = readFileSync(filePath, 'utf-8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => entry.outcome), ['success', 'failure', 'blocked']);
  });

  it('infers check.run outcome from structured exit_code data when outcome is omitted', () => {
    const target = makeTarget('check-run-inferred-outcome');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    const result = run([
      'event',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'npm test passed',
      '--ref',
      'command:npm test',
      '--data-json',
      JSON.stringify({ command: 'npm test', exit_code: 0, passed: 12, failed: 0, skipped: 0 }),
    ]);

    assertOk(result);
    const filePath = eventLogPath(target, 'T-001.jsonl');
    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    assert.equal(event.event_type, 'check.run');
    assert.equal(event.outcome, 'success');
  });

  it('warns on short transcript-like summaries but still writes the event', () => {
    const target = makeTarget('transcript-summary-warning');
    const output = eventLogPath(target, 'manual.jsonl');
    const result = run([
      'event',
      'task.updated',
      '--target',
      target,
      '--output',
      output,
      '--summary',
      'system: scoped note\nuser: confirm updated task record',
    ]);

    assertOk(result);
    assert.match(result.stderr, /summary looks like a transcript or raw tool dump/);
    assert.ok(existsSync(output));
    const event = JSON.parse(readFileSync(output, 'utf-8').trim());
    assert.equal(event.summary, 'system: scoped note\nuser: confirm updated task record');
  });

  it('event-logging validate checks every JSONL file in the default log directory', () => {
    const target = makeTarget('validate-all-logs');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started scoped implementation',
    ]));
    assertOk(run([
      'event',
      'decision.recorded',
      '--target',
      target,
      '--output',
      eventLogPath(target, 'manual.jsonl'),
      '--role',
      'maintainer',
      '--summary',
      'Recorded setup decision',
    ]));

    const result = run(['event-logging', 'validate', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /OK: 2 file\(s\), 2 event\(s\) validated/);
  });

  it('event validate passes when no event logs exist', () => {
    const target = makeTarget('missing-event-logs');
    const result = run(['event', 'validate', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /No event logs found/);
  });

  it('validate passes when no event logs exist and validates an existing event log', () => {
    const withoutLogs = makeTarget('validate-no-event-logs');
    assertOk(run(['init', '--target', withoutLogs]));

    const noLogsResult = run(['validate', '--target', withoutLogs]);
    assertOk(noLogsResult);
    assert.doesNotMatch(noLogsResult.stdout, /Event Logs/);

    const withLogs = makeTarget('validate-with-event-logs');
    assertOk(run(['init', '--target', withLogs]));
    writeValidTaskRecord(withLogs, 'T-001');
    assertOk(run([
      'event',
      'task.created',
      '--target',
      withLogs,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Created files task record',
    ]));

    const withLogsResult = run(['validate', '--target', withLogs]);
    assertOk(withLogsResult);
    assert.match(withLogsResult.stdout, /Event Logs - OK/);
    assert.ok(withLogsResult.stdout.includes(join(withLogs, '.agenticloop', 'logs')));
  });

  it('agenticloop validate checks every default event log file', () => {
    const target = makeTarget('validate-command-all-logs');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event',
      'task.created',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Created files task record',
    ]));
    assertOk(run([
      'event',
      'decision.recorded',
      '--target',
      target,
      '--output',
      eventLogPath(target, 'manual.jsonl'),
      '--role',
      'maintainer',
      '--summary',
      'Recorded setup decision',
    ]));

    const result = run(['validate', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /OK: 2 file\(s\), 2 event\(s\) validated/);
  });

  it('rejects unsafe task ids before creating out-of-directory event log paths', () => {
    const target = makeTarget('unsafe-task-id');
    const result = run([
      'event',
      'task.started',
      '--target',
      target,
      '--task',
      '../escape',
      '--role',
      'engineer',
      '--summary',
      'Attempted unsafe task id',
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not safe for event log filenames/);
    assert.ok(!existsSync(join(target, '.agenticloop', 'logs', 'escape.jsonl')));
  });

  it('event-logging audit passes when required event types are present', () => {
    const target = makeTarget('audit-pass');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeValidTaskRecord(target, 'T-001');
    appendAuditFixtureEvents(target, 'T-001');

    const result = run(['event-logging', 'audit', '--target', target, '--task', 'T-001']);

    assertOk(result);
    assert.match(result.stdout, /agenticloop event-logging audit/);
    assert.match(result.stdout, /OK: 5 event\(s\) validated for strict audit/);
  });

  it('event-logging audit fails when enabled and no log exists for the task', () => {
    const target = makeTarget('audit-missing-log');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeValidTaskRecord(target, 'T-001');

    const result = run(['event-logging', 'audit', '--target', target, '--task', 'T-001']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing task event log/);
  });

  it('event-logging audit fails when a required event type is missing', () => {
    const target = makeTarget('audit-missing-type');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeValidTaskRecord(target, 'T-001');
    appendAuditFixtureEvents(target, 'T-001', ['role.invoked', 'task.started', 'check.run', 'review.result']);

    const result = run(['event-logging', 'audit', '--target', target, '--task', 'T-001']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required event types: task\.closed/);
  });

  it('event-logging audit reports disabled logging without failure by default', () => {
    const target = makeTarget('audit-disabled-default');
    writeProjectMap(target, { eventLogging: 'disabled' });

    const result = run(['event-logging', 'audit', '--target', target, '--task', 'T-001']);

    assertOk(result);
    assert.match(result.stdout, /event_logging: disabled/);
    assert.match(result.stdout, /skipping strict audit/);
  });

  it('event-logging audit with explicit --require still checks a disabled project log', () => {
    const target = makeTarget('audit-disabled-explicit');
    writeProjectMap(target, { eventLogging: 'disabled' });
    writeValidTaskRecord(target, 'T-001');
    appendAuditFixtureEvents(target, 'T-001', ['role.invoked']);

    const result = run([
      'event-logging',
      'audit',
      '--target',
      target,
      '--task',
      'T-001',
      '--require',
      'role.invoked',
    ]);

    assertOk(result);
    assert.match(result.stdout, /explicit --require requested an audit/);
    assert.match(result.stdout, /OK: 1 event\(s\) validated for strict audit/);
  });

  it('event-logging report summarizes checks, reviews, delegation, and refs from an existing task log', () => {
    const target = makeTarget('report-complete-trace');
    writeProjectMap(target, { taskBackend: 'github', eventLogging: 'enabled' });

    assertOk(run([
      'event-logging',
      'role.invoked',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'orchestrator',
      '--summary',
      'Delegated engineer implementation',
      '--ref',
      'github:issue:42',
      '--ref',
      'github:pr:17',
      '--data-json',
      JSON.stringify({
        target_role: 'engineer',
        delegation_mode: 'host_subagent',
        fallback: false,
        adapter: 'opencode',
        model: 'gpt-5.4',
        reason: 'Implementation ready',
      }),
    ]));
    assertOk(run([
      'event-logging',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started scoped implementation',
      '--ref',
      'github:issue:42',
    ]));
    assertOk(run([
      'event-logging',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'npm test passed',
      '--outcome',
      'success',
      '--ref',
      'command:npm test',
      '--ref',
      'github:pr:17',
      '--data-json',
      JSON.stringify({ command: 'npm test', exit_code: 0, passed: 128, failed: 0, skipped: 2, duration_ms: 15000, attempt: 1 }),
    ]));
    assertOk(run([
      'event-logging',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'npm run lint failed',
      '--outcome',
      'failure',
      '--ref',
      'command:npm run lint',
      '--ref',
      'github:pr:17',
      '--data-json',
      JSON.stringify({ command: 'npm run lint', exit_code: 1, passed: 0, failed: 3, skipped: 0, duration_ms: 8000, attempt: 1 }),
    ]));
    assertOk(run([
      'event-logging',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Smoke check blocked on staging secret',
      '--outcome',
      'blocked',
      '--ref',
      'command:npm run smoke',
      '--ref',
      'github:pr:17',
      '--data-json',
      JSON.stringify({ command: 'npm run smoke', exit_code: 1, passed: 0, failed: 0, skipped: 1, duration_ms: 5000, attempt: 2 }),
    ]));
    assertOk(run([
      'event-logging',
      'review.result',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Requested revision on the first pass',
      '--outcome',
      'needs_revision',
      '--ref',
      'github:pr:17',
      '--data-json',
      JSON.stringify({ review_round: 1, artifact_revision: 'abc123', pr_head: 'abc123' }),
    ]));
    assertOk(run([
      'event-logging',
      'role.invoked',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'orchestrator',
      '--summary',
      'Started fallback maintainer review pass',
      '--ref',
      'github:pr:17',
      '--data-json',
      JSON.stringify({
        target_role: 'maintainer',
        delegation_mode: 'single_agent_fallback',
        fallback: true,
        adapter: 'opencode',
        reason: 'Review tool unavailable',
      }),
    ]));
    assertOk(run([
      'event-logging',
      'review.result',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Accepted implementation',
      '--outcome',
      'accepted',
      '--ref',
      'github:pr:17',
      '--ref',
      'commit:def456',
      '--data-json',
      JSON.stringify({ review_round: 2, artifact_revision: 'def456', pr_head: 'def456' }),
    ]));
    assertOk(run([
      'event-logging',
      'task.closed',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Closed task after accepted review',
      '--outcome',
      'success',
      '--ref',
      'github:issue:42',
      '--ref',
      'github:pr:17',
    ]));

    const result = run(['event-logging', 'report', '--target', target, '--task', 'T-001']);

    assertOk(result);
    assert.match(result.stdout, /agenticloop event-logging report/);
    assert.match(result.stdout, /strict audit missing: none/);
    assert.match(result.stdout, /check\.run counts: success=1, failure=1, blocked=1/);
    assert.match(result.stdout, /review\.result counts: accepted=1, needs_revision=1/);
    assert.match(result.stdout, /review rounds: 1, 2/);
    assert.match(result.stdout, /role\.invoked targets: engineer=1, maintainer=1/);
    assert.match(result.stdout, /delegation modes: host_subagent=1, single_agent_fallback=1/);
    assert.match(result.stdout, /fallback count: 1/);
    assert.match(result.stdout, /failure: npm run lint failed/);
    assert.match(result.stdout, /blocked: Smoke check blocked on staging secret/);
    assert.match(result.stdout, /refs summary: .*github:pr:17=8/);
  });

  it('event-logging audit prints a clear durable task.closed error', () => {
    const target = makeTarget('audit-durable-closure-error');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeValidTaskRecord(target, 'T-001');
    appendAuditFixtureEvents(target, 'T-001', ['role.invoked', 'task.started', 'check.run', 'review.result']);
    assertOk(run([
      'event-logging',
      'task.closed',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Engineer marked revision complete',
      '--outcome',
      'success',
    ]));

    const result = run(['event-logging', 'audit', '--target', target, '--task', 'T-001']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Durable task\.closed not satisfied/);
    assert.match(result.stderr, /role was engineer/);
  });

  it('event-logging report prints durable task.closed status', () => {
    const passing = makeTarget('report-durable-closure-yes');
    writeProjectMap(passing, { eventLogging: 'enabled', taskBackend: 'github' });
    appendAuditFixtureEvents(passing, 'T-001', ['role.invoked', 'task.started', 'check.run', 'review.result']);
    assertOk(run([
      'event-logging',
      'task.closed',
      '--target',
      passing,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Closed task',
      '--outcome',
      'success',
      '--ref',
      'github:issue:42',
      '--ref',
      'github:pr:17',
    ]));

    const passingResult = run(['event-logging', 'report', '--target', passing, '--task', 'T-001']);
    assertOk(passingResult);
    assert.match(passingResult.stdout, /durable task\.closed: yes/);

    const failing = makeTarget('report-durable-closure-no');
    writeProjectMap(failing, { eventLogging: 'enabled', taskBackend: 'github' });
    appendAuditFixtureEvents(failing, 'T-002', ['role.invoked', 'task.started', 'check.run', 'review.result']);
    assertOk(run([
      'event-logging',
      'task.closed',
      '--target',
      failing,
      '--task',
      'T-002',
      '--role',
      'maintainer',
      '--summary',
      'Closed task missing PR ref',
      '--outcome',
      'success',
      '--ref',
      'github:issue:42',
    ]));

    const failingResult = run(['event-logging', 'report', '--target', failing, '--task', 'T-002']);
    assertOk(failingResult);
    assert.match(failingResult.stdout, /durable task\.closed: no \(/);
    assert.match(failingResult.stdout, /missing github:pr ref/);
  });

  it('event-logging report prints accepted imperfect checks separately', () => {
    const target = makeTarget('report-accepted-imperfect-cli');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event-logging',
      'role.invoked',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'orchestrator',
      '--summary',
      'Delegated engineer',
    ]));
    assertOk(run([
      'event-logging',
      'task.started',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Started implementation',
    ]));
    assertOk(run([
      'event-logging',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Flaky unrelated test failed',
      '--outcome',
      'failure',
      '--ref',
      'command:npm test',
      '--data-json',
      JSON.stringify({ command: 'npm test', exit_code: 1, passed: 10, failed: 1, triaged_unrelated: true, required: true }),
    ]));
    assertOk(run([
      'event-logging',
      'check.run',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'engineer',
      '--summary',
      'Known pre-existing lint failure',
      '--outcome',
      'failure',
      '--ref',
      'command:npm run lint',
      '--data-json',
      JSON.stringify({ command: 'npm run lint', exit_code: 1, accepted_known_failure: true }),
    ]));
    assertOk(run([
      'event-logging',
      'review.result',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Accepted implementation',
      '--outcome',
      'accepted',
    ]));
    assertOk(run([
      'event-logging',
      'task.closed',
      '--target',
      target,
      '--task',
      'T-001',
      '--role',
      'maintainer',
      '--summary',
      'Closed task',
      '--outcome',
      'success',
    ]));

    const result = run(['event-logging', 'report', '--target', target, '--task', 'T-001']);

    assertOk(result);
    assert.match(result.stdout, /accepted imperfect checks \(not clean success\):/);
    assert.match(result.stdout, /triaged_unrelated/);
    assert.match(result.stdout, /accepted_known_failure/);
    assert.doesNotMatch(result.stdout, /failed\/blocked checks:[\s\S]*Flaky unrelated test failed/);
    assert.doesNotMatch(result.stdout, /failed\/blocked checks:[\s\S]*Known pre-existing lint failure/);
  });

  it('event-logging report fails when the task log is missing', () => {
    const target = makeTarget('report-missing-log');

    const result = run(['event-logging', 'report', '--target', target, '--task', 'T-404']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing task event log: \.agenticloop\/logs\/T-404\.jsonl/);
  });
});

describe('event-logging host inference', () => {
  it('infers host from a single generated adapter marker when --host is omitted', () => {
    const target = makeTarget('host-inference-single');
    assertOk(run(['init', '--target', target]));
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(target, '.opencode', 'agents', 'orchestrator.md'), '# orchestrator\n', 'utf-8');
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event-logging', 'task.started', '--target', target, '--task', 'T-001', '--role', 'engineer', '--summary', 'Started task',
    ]));

    const event = JSON.parse(readFileSync(eventLogPath(target, 'T-001.jsonl'), 'utf-8').trim());
    assert.equal(event.host, 'opencode');
  });

  it('preserves explicit --host over inferred adapter', () => {
    const target = makeTarget('host-explicit-wins');
    assertOk(run(['init', '--target', target]));
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(target, '.opencode', 'agents', 'orchestrator.md'), '# orchestrator\n', 'utf-8');
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event-logging', 'task.started', '--target', target, '--task', 'T-001', '--role', 'engineer', '--host', 'custom-host', '--summary', 'Started task',
    ]));

    const event = JSON.parse(readFileSync(eventLogPath(target, 'T-001.jsonl'), 'utf-8').trim());
    assert.equal(event.host, 'custom-host');
  });

  it('records host unknown when adapter detection is ambiguous', () => {
    const target = makeTarget('host-inference-ambiguous');
    assertOk(run(['init', '--target', target]));
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(target, '.opencode', 'agents', 'orchestrator.md'), '# orchestrator\n', 'utf-8');
    mkdirSync(join(target, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(target, '.claude', 'agents', 'maintainer.md'), '# maintainer\n', 'utf-8');
    writeValidTaskRecord(target, 'T-001');

    assertOk(run([
      'event-logging', 'task.started', '--target', target, '--task', 'T-001', '--role', 'engineer', '--summary', 'Started task',
    ]));

    const event = JSON.parse(readFileSync(eventLogPath(target, 'T-001.jsonl'), 'utf-8').trim());
    assert.equal(event.host, 'unknown');
  });
});

describe('event-logging aggregate report', () => {
  it('reports across task logs and survives malformed and empty logs', () => {
    const target = makeTarget('aggregate-report-cli');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');
    writeValidTaskRecord(target, 'T-002');

    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(target, '.opencode', 'agents', 'orchestrator.md'), '# orchestrator\n', 'utf-8');
    appendAuditFixtureEvents(target, 'T-001');

    assertOk(run(['event-logging', 'task.started', '--target', target, '--task', 'T-002', '--role', 'engineer', '--summary', 'Started T-002']));
    assertOk(run(['event-logging', 'review.result', '--target', target, '--task', 'T-002', '--role', 'maintainer', '--outcome', 'accepted', '--summary', 'Accepted T-002']));

    assertOk(run(['event-logging', 'task.started', '--target', target, '--task', 'T-003', '--role', 'engineer', '--host', 'unknown', '--summary', 'Unknown host event']));

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'broken.jsonl'), 'not json\n', 'utf-8');
    writeFileSync(join(target, '.agenticloop', 'logs', 'empty.jsonl'), '', 'utf-8');

    const result = run(['event-logging', 'report', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /agenticloop event-logging report/);
    assert.match(result.stdout, /files scanned: 5/);
    assert.match(result.stdout, /valid task logs: 3/);
    assert.match(result.stdout, /invalid logs: 1/);
    assert.match(result.stdout, /empty logs: 1/);
    assert.match(result.stdout, /strict audit: pass=1, fail=2/);
    assert.match(result.stdout, /events with host=unknown: 1/);
    assert.match(result.stdout, /invalid logs:/);
    assert.match(result.stdout, /empty logs:/);
    assert.match(result.stdout, /host=unknown events:/);
    assert.match(result.stdout, /T-001/);
    assert.match(result.stdout, /T-002/);
    assert.match(result.stdout, /T-003/);
  });

  it('prints aggregate delegation, fallback, and affected task ids', () => {
    const target = makeTarget('aggregate-delegation-cli');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');
    writeValidTaskRecord(target, 'T-002');

    assertOk(run([
      'event-logging', 'role.invoked', '--target', target, '--task', 'T-001', '--role', 'orchestrator',
      '--summary', 'Delegated engineer', '--data-json',
      JSON.stringify({ target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false }),
    ]));
    assertOk(run(['event-logging', 'task.started', '--target', target, '--task', 'T-001', '--role', 'engineer', '--summary', 'Started T-001']));
    assertOk(run([
      'event-logging', 'role.invoked', '--target', target, '--task', 'T-001', '--role', 'orchestrator',
      '--summary', 'Fallback maintainer', '--data-json',
      JSON.stringify({ target_role: 'maintainer', delegation_mode: 'single_agent_fallback', fallback: true }),
    ]));
    assertOk(run([
      'event-logging', 'task.closed', '--target', target, '--task', 'T-001', '--role', 'maintainer',
      '--outcome', 'success', '--summary', 'Closed T-001',
    ]));

    assertOk(run(['event-logging', 'task.started', '--target', target, '--task', 'T-002', '--role', 'engineer', '--summary', 'Started T-002']));

    const result = run(['event-logging', 'report', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /role\.invoked targets: engineer=1, maintainer=1/);
    assert.match(result.stdout, /delegation modes: host_subagent=1, single_agent_fallback=1/);
    assert.match(result.stdout, /fallback count: 1/);
    assert.match(result.stdout, /tasks missing task\.closed: 1 \(T-002\)/);
  });

  it('marks mixed-task log rows when host unknown is attached to event task ids', () => {
    const target = makeTarget('aggregate-mixed-task-host-quality');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');
    writeValidTaskRecord(target, 'T-002');
    const mixedLog = eventLogPath(target, 'mixed.jsonl');

    assertOk(run([
      'event-logging', 'task.started', '--target', target, '--task', 'T-001', '--role', 'engineer',
      '--host', 'unknown', '--summary', 'Started T-001', '--output', mixedLog,
    ]));
    assertOk(run([
      'event-logging', 'task.started', '--target', target, '--task', 'T-002', '--role', 'engineer',
      '--host', 'unknown', '--summary', 'Started T-002', '--output', mixedLog,
    ]));

    const result = run(['event-logging', 'report', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /events with host=unknown: 2/);
    assert.match(result.stdout, /mixed\s+2\s+role\.invoked, check\.run, review\.result, task\.closed\s+missing\/failing\s+none\s+0\/0\/0\s+unknown present/);
  });

  it('handles aggregate report errors cleanly', () => {
    const target = makeTarget('aggregate-report-error');
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs'), 'not a directory', 'utf-8');

    const result = run(['event-logging', 'report', '--target', target]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to generate aggregate event log report/);
    assert.doesNotMatch(result.stderr, /\s+at\s+/);
  });

  it('keeps per-task report backward compatible', () => {
    const target = makeTarget('aggregate-report-per-task-compat');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'T-001');
    appendAuditFixtureEvents(target, 'T-001');

    const result = run(['event-logging', 'report', '--target', target, '--task', 'T-001']);

    assertOk(result);
    assert.match(result.stdout, /task: T-001/);
    assert.match(result.stdout, /strict audit missing: none/);
  });

  it('event-logging report --features works over existing review.result logs', () => {
    const target = makeTarget('report-features-historical');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'P23-16');
    // Three review.result events -> three derived review rounds, no producer telemetry.
    for (let i = 0; i < 2; i += 1) {
      assertOk(run(['event', 'review.result', '--target', target, '--task', 'P23-16', '--role', 'maintainer', '--summary', `Round ${i + 1}`, '--outcome', 'needs_revision']));
    }
    assertOk(run(['event', 'review.result', '--target', target, '--task', 'P23-16', '--role', 'maintainer', '--summary', 'Accepted', '--outcome', 'accepted']));

    const result = run(['event-logging', 'report', '--features', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /report --features/);
    assert.match(result.stdout, /max derived review rounds: 3/);
    assert.match(result.stdout, /tasks with feature telemetry: 0/);
    assert.match(result.stdout, /feature telemetry warnings: none/);
  });

  it('event-logging report --features surfaces emitted telemetry', () => {
    const target = makeTarget('report-features-telemetry');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'P23-16');
    assertOk(run([
      'event', 'task.created', '--target', target, '--task', 'P23-16', '--role', 'maintainer',
      '--summary', 'Created integration sweep',
      '--data-json', JSON.stringify({
        feature_telemetry_version: 1,
        minimalism: 'none',
        minimalism_trigger: 'verification-sweep',
        context_overflow_risk: 'medium',
        context_note: 'Broad integration; focused checks then final gate.',
      }),
    ]));

    const result = run(['event-logging', 'report', '--features', '--target', target]);

    assertOk(result);
    assert.match(result.stdout, /tasks with feature telemetry: 1/);
    assert.match(result.stdout, /minimalism \(telemetry tasks\): none=1/);
    assert.match(result.stdout, /verification-sweep=1/);
    assert.match(result.stdout, /context overflow risk: medium=1/);
  });

  it('event-logging report --features prints context-risk omission candidates', () => {
    const target = makeTarget('report-features-omission');
    assertOk(run(['init', '--target', target]));
    writeValidTaskRecord(target, 'P40-10');
    assertOk(run([
      'event', 'task.created', '--target', target, '--task', 'P40-10', '--role', 'maintainer',
      '--summary', 'Created', '--data-json', JSON.stringify({
        feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default',
      }),
    ]));
    assertOk(run([
      'event', 'task.closed', '--target', target, '--task', 'P40-10', '--role', 'maintainer',
      '--summary', 'Closed', '--outcome', 'success', '--data-json', JSON.stringify({
        feature_telemetry_version: 1, context_pressure_encountered: true,
      }),
    ]));
    const result = run(['event-logging', 'report', '--features', '--target', target]);
    assertOk(result);
    assert.match(result.stdout, /context-risk omission candidates/);
    assert.match(result.stdout, /pressure hit but no risk predicted \(higher confidence\): 1 \(P40-10\)/);
  });
});
