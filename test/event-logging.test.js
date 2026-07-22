import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  auditTaskEventLog,
  appendEventLog,
  buildEvent,
  loadEvents,
  reportEventLogs,
  reportTaskEventLog,
  resolveEventLogPath,
  STRICT_AUDIT_EVENT_TYPES,
  validateEvent,
  validateNewEvent,
  validateEventLogFile,
  validateEventLogs,
  RUN_SCOPED_EVENT_TYPES,
  SUPERVISION_LOG_SUBDIR,
  VALID_EVENT_SCOPES,
} from '../src/event-logging.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-event-logging-test-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

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

function writeTaskRecord(target, taskId = 'T-001') {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'tasks', `${taskId}.md`), `# ${taskId}\n`, 'utf-8');
}

function appendAuditEvents(target, taskId, eventTypes = STRICT_AUDIT_EVENT_TYPES) {
  const definitions = {
    'role.invoked': {
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer',
    },
    'task.started': {
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started scoped implementation',
    },
    'check.run': {
      eventType: 'check.run',
      role: 'engineer',
      summary: 'npm test passed',
      outcome: 'success',
    },
    'review.result': {
      eventType: 'review.result',
      role: 'maintainer',
      summary: 'Accepted implementation',
      outcome: 'accepted',
    },
    'task.closed': {
      eventType: 'task.closed',
      role: 'maintainer',
      summary: 'Closed task',
      outcome: 'success',
    },
  };

  for (const eventType of eventTypes) {
    // These fixtures simulate stored/historical logs; bypass strict producer
    // validation so incomplete-by-new-rules role.invoked/review.result events
    // can be written to exercise the read side.
    appendEventLog({
      target,
      historical: true,
      event: buildEvent({
        target,
        task: taskId,
        ...definitions[eventType],
      }),
    });
  }
}

function appendFixtureEvent(target, taskId, definition) {
  appendEventLog({
    target,
    historical: true,
    event: buildEvent({
      target,
      task: taskId,
      backend: definition.backend,
      host: definition.host,
      occurredAt: definition.occurredAt,
      eventType: definition.eventType,
      role: definition.role,
      summary: definition.summary,
      outcome: definition.outcome,
      refs: definition.refs,
      data: definition.data,
    }),
  });
}

describe('event logging module', () => {
  it('accepts compact supervision control-plane events without permitting transcript data', () => {
    const event = buildEvent({
      eventType: 'supervision.permission_decided',
      role: 'supervisor',
      summary: 'Approved one exact registered permission',
      outcome: 'success',
      data: { request_id: 'req-1', lane_id: 'lane-1', decision: 'once' },
    });
    assert.deepEqual(validateEvent(event).errors, []);
    const leaked = { ...event, data: { ...event.data, prompt: 'not allowed' } };
    assert.ok(validateEvent(leaked).errors.some(error => error.includes('privacy-sensitive')));
  });

  it('buildEvent populates required fields and defaults', () => {
    const event = buildEvent(
      {
        eventType: 'task.started',
        summary: 'Started implementation task',
      },
      new Date('2026-06-17T10:11:12.000Z')
    );

    assert.equal(event.schema_version, 1);
    assert.match(event.event_id, UUID_PATTERN);
    assert.equal(event.occurred_at, '2026-06-17T10:11:12.000Z');
    assert.match(event.trace_id, UUID_PATTERN);
    assert.equal(event.parent_event_id, null);
    assert.equal(event.task_id, null);
    assert.equal(event.backend, 'unknown');
    assert.equal(event.host, 'unknown');
    assert.equal(event.role, 'unknown');
    assert.equal(event.event_type, 'task.started');
    assert.equal(event.summary, 'Started implementation task');
    assert.equal(event.outcome, 'unknown');
    assert.deepEqual(event.refs, []);
    assert.deepEqual(event.data, {});
  });

  it('appendEventLog writes .agenticloop/logs/T-001.jsonl by default', () => {
    const target = makeTarget('append-task-scoped');
    const event = buildEvent({ task: 'T-001', eventType: 'task.started', summary: 'Started task record work' });

    const filePath = appendEventLog({ target, event });

    assert.equal(resolveEventLogPath(target, undefined, 'T-001').path, filePath);
    assert.equal(filePath, eventLogPath(target, 'T-001.jsonl'));
    assert.ok(existsSync(filePath));
    const events = loadEvents(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, 'T-001');
  });

  it('appendEventLog fails without a task for default output', () => {
    const target = makeTarget('append-missing-task');
    const event = buildEvent({ eventType: 'task.created', summary: 'Created task record' });

    assert.throws(
      () => appendEventLog({ target, event }),
      /--task is required for default event logging output/
    );
  });

  it('explicit output allows no-task events', () => {
    const target = makeTarget('append-explicit-output');
    const output = eventLogPath(target, 'manual.jsonl');
    const event = buildEvent({ eventType: 'decision.recorded', summary: 'Recorded setup decision' });

    const filePath = appendEventLog({ target, output, event });

    assert.equal(filePath, output);
    assert.ok(existsSync(filePath));
    const events = loadEvents(filePath);
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, null);
  });

  it('derives the same trace id for the same target and task', () => {
    const target = makeTarget('same-task-trace');

    const first = buildEvent({
      target,
      task: 'T-001',
      eventType: 'task.started',
      summary: 'Started scoped work',
    });
    const second = buildEvent({
      target,
      task: 'T-001',
      eventType: 'check.run',
      summary: 'Ran focused checks',
      outcome: 'success',
    });

    assert.match(first.trace_id, UUID_PATTERN);
    assert.equal(first.trace_id, second.trace_id);
  });

  it('derives different trace ids for different tasks in the same target', () => {
    const target = makeTarget('different-task-trace');

    const first = buildEvent({
      target,
      task: 'T-001',
      eventType: 'task.started',
      summary: 'Started first task',
    });
    const second = buildEvent({
      target,
      task: 'T-002',
      eventType: 'task.started',
      summary: 'Started second task',
    });

    assert.notEqual(first.trace_id, second.trace_id);
  });

  it('keeps an explicit trace id override', () => {
    const explicitTraceId = '123e4567-e89b-12d3-a456-426614174000';
    const event = buildEvent({
      target: makeTarget('explicit-trace'),
      task: 'T-001',
      eventType: 'task.started',
      summary: 'Started scoped work',
      traceId: explicitTraceId,
    });

    assert.equal(event.trace_id, explicitTraceId);
  });

  it('keeps random trace ids when no task id is present', () => {
    const first = buildEvent({ eventType: 'task.started', summary: 'Started scoped work' });
    const second = buildEvent({ eventType: 'task.started', summary: 'Started scoped work' });

    assert.notEqual(first.trace_id, second.trace_id);
  });

  it('repeat writes append multiple JSONL lines', () => {
    const target = makeTarget('append-repeat');
    const filePath = eventLogPath(target, 'T-001.jsonl');

    appendEventLog({
      target,
      event: buildEvent({ task: 'T-001', eventType: 'task.created', summary: 'Created task' }),
    });
    appendEventLog({
      target,
      event: buildEvent({ task: 'T-001', eventType: 'task.started', summary: 'Started task' }),
    });

    const lines = readFileSync(filePath, 'utf-8').trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    const events = loadEvents(filePath);
    assert.deepEqual(events.map(event => event.event_type), ['task.created', 'task.started']);
  });

  it('invalid event type fails validation', () => {
    const result = validateEvent(buildEvent({ eventType: 'not.a.real.event', summary: 'Bad event' }));

    assert.ok(result.errors.some(error => error.includes('event_type must be one of')));
  });

  it('invalid role and outcome fail validation', () => {
    const result = validateEvent(buildEvent({
      eventType: 'task.updated',
      summary: 'Updated task record',
      role: 'reviewer',
      outcome: 'great',
    }));

    assert.ok(result.errors.some(error => error.includes('role must be one of')));
    assert.ok(result.errors.some(error => error.includes('outcome must be one of')));
  });

  it('enforces review.result outcome compatibility', () => {
    const missingOutcome = validateEvent(buildEvent({
      eventType: 'review.result',
      summary: 'Recorded maintainer decision',
    }));
    const accepted = validateEvent(buildEvent({
      eventType: 'review.result',
      summary: 'Accepted implementation',
      outcome: 'accepted',
    }));

    assert.ok(missingOutcome.errors.includes("event_type 'review.result' requires outcome accepted or needs_revision"));
    assert.deepEqual(accepted.errors, []);
  });

  it('enforces allowed outcomes for other event types', () => {
    const invalidCreated = validateEvent(buildEvent({
      eventType: 'task.created',
      summary: 'Created task record',
      outcome: 'accepted',
    }));

    assert.ok(invalidCreated.errors.includes("event_type 'task.created' requires outcome unknown or success"));

    for (const outcome of ['success', 'failure', 'blocked']) {
      const result = validateEvent(buildEvent({
        eventType: 'check.run',
        summary: `Recorded ${outcome} check run`,
        outcome,
      }));

      assert.deepEqual(result.errors, [], `expected check.run ${outcome} to pass`);
    }
  });

  it('warns instead of failing for short transcript-like summaries', () => {
    const result = validateEvent(buildEvent({
      eventType: 'task.updated',
      summary: 'system: scoped summary\nuser: confirm updated task record',
    }));

    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.includes('summary looks like a transcript or raw tool dump'));
  });

  it('still fails transcript-like data payloads', () => {
    const repeatedTranscript = `${'transcript excerpt\n```text\nscoped detail\n```\n'.repeat(120)}final note`;
    const result = validateEvent(buildEvent({
      eventType: 'decision.recorded',
      summary: 'Recorded scoped decision',
      data: {
        excerpt: repeatedTranscript,
      },
    }));

    assert.ok(result.errors.includes('data looks like a transcript or raw tool dump'));
  });

  it('privacy-blocked fields fail validation', () => {
    const event = buildEvent({
      eventType: 'decision.recorded',
      summary: 'Recorded backend decision',
      data: {
        messages: ['raw transcript content'],
      },
    });
    event.prompt = 'raw prompt text';

    const result = validateEvent(event);

    assert.ok(result.errors.some(error => error.includes("banned top-level key 'prompt'")));
    assert.ok(result.errors.some(error => error.includes("data contains banned privacy-sensitive key 'data.messages'")));
  });

  it('warns when no explicit task backend is configured and the local task file is missing', () => {
    const target = makeTarget('missing-task-default-backend');

    const result = validateEvent(
      buildEvent({
        task: 'T-001',
        eventType: 'task.started',
        summary: 'Started scoped work',
      }),
      { target }
    );

    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(warning => warning.includes("has no local files task record")));
  });

  it('does not require a local task file when an unconfigured target event references a GitHub task', () => {
    const target = makeTarget('github-ref-default-backend');

    const result = validateEvent(
      buildEvent({
        task: 'T-001',
        eventType: 'task.started',
        role: 'engineer',
        summary: 'Started scoped work',
        refs: ['github:issue:42'],
      }),
      { target }
    );

    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.some(warning => warning.includes("has no local files task record")), false);
  });

  it('warns (not errors) for missing local task files when the files backend is explicit', () => {
    const target = makeTarget('missing-task-files-backend');
    writeProjectMap(target, { taskBackend: 'files' });

    const result = validateEvent(
      buildEvent({
        task: 'T-001',
        backend: 'files',
        eventType: 'task.started',
        role: 'engineer',
        summary: 'Started scoped work',
      }),
      { target }
    );

    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(w => w.includes("has no local files task record")));
  });

  it('does not warn when the github backend is explicit and no local task file exists', () => {
    const target = makeTarget('missing-task-github-backend');
    writeProjectMap(target, { taskBackend: 'github' });

    const result = validateEvent(
      buildEvent({
        task: 'T-001',
        backend: 'github',
        eventType: 'task.started',
        role: 'engineer',
        summary: 'Started scoped work',
      }),
      { target }
    );

    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.some(warning => warning.includes("has no local files task record")), false);
  });

  it('still validates event shape normally on the github backend', () => {
    const target = makeTarget('github-backend-shape-validation');
    writeProjectMap(target, { taskBackend: 'github' });

    const result = validateEvent(
      buildEvent({
        task: 'T-001',
        backend: 'github',
        eventType: 'check.run',
        role: 'engineer',
        summary: 'Ran verification command',
      }),
      { target }
    );

    assert.ok(result.errors.includes("event_type 'check.run' requires outcome success, failure, or blocked"));
    assert.equal(result.warnings.some(warning => warning.includes("has no local files task record")), false);
  });

  it('rejects unsafe task ids before resolving a default event log path', () => {
    const target = makeTarget('unsafe-task-id');

    assert.throws(
      () => resolveEventLogPath(target, undefined, '../escape'),
      /not safe for event log filenames/
    );
  });

  it('validateEventLogs validates every JSONL file in the default log directory', () => {
    const target = makeTarget('validate-directory');
    const taskPath = eventLogPath(target, 'T-001.jsonl');
    const manualPath = eventLogPath(target, 'manual.jsonl');

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), '# T-001\n', 'utf-8');
    writeFileSync(taskPath, `${JSON.stringify(buildEvent({ task: 'T-001', eventType: 'task.updated', summary: 'Updated task record' }))}\n`, 'utf-8');
    writeFileSync(manualPath, 'not json\n', 'utf-8');

    const result = validateEventLogs(target);

    assert.equal(result.exists, true);
    assert.equal(result.fileCount, 2);
    assert.equal(result.eventCount, 1);
    assert.ok(result.errors.some(error => error.includes('.agenticloop/logs/manual.jsonl line 1: invalid JSON')));
  });

  it('malformed JSONL fails validation with event log wording', () => {
    const target = makeTarget('malformed-event-log');
    const filePath = eventLogPath(target, 'manual.jsonl');
    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(filePath, '{"schema_version":1}\nnot json\n', 'utf-8');

    const result = validateEventLogFile(filePath, { target });

    assert.ok(result.errors.some(error => error.includes('.agenticloop/logs/manual.jsonl line 2: invalid JSON')));
  });

  it('auditTaskEventLog passes when required event types are present', () => {
    const target = makeTarget('audit-pass');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001');

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.eventCount, STRICT_AUDIT_EVENT_TYPES.length);
    assert.deepEqual(result.missingEventTypes, []);
  });

  it('auditTaskEventLog fails when logging is enabled and no log exists for the task', () => {
    const target = makeTarget('audit-missing-log');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('Missing task event log')));
  });

  it('auditTaskEventLog fails when a required event type is missing', () => {
    const target = makeTarget('audit-missing-type');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(
      target,
      'T-001',
      STRICT_AUDIT_EVENT_TYPES.filter(eventType => eventType !== 'task.closed')
    );

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingEventTypes, ['task.closed']);
    assert.ok(result.errors.some(error => error.includes('Missing required event types: task.closed')));
  });

  it('auditTaskEventLog reports disabled logging without failure by default', () => {
    const target = makeTarget('audit-disabled-default');
    writeProjectMap(target, { eventLogging: 'disabled' });

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.eventLogging, 'disabled');
  });

  it('auditTaskEventLog with explicit require still checks a disabled project log', () => {
    const target = makeTarget('audit-disabled-explicit');
    writeProjectMap(target, { eventLogging: 'disabled' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001', ['role.invoked']);

    const result = auditTaskEventLog({
      target,
      taskId: 'T-001',
      requiredEventTypes: ['role.invoked'],
      explicitRequire: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.enabled, false);
    assert.equal(result.eventCount, 1);
  });

  it('reportTaskEventLog summarizes a complete trace with checks, reviews, delegation, and refs', () => {
    const target = makeTarget('report-complete-trace');
    writeProjectMap(target, { taskBackend: 'github', eventLogging: 'enabled' });

    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:00:00.000Z',
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer implementation',
      refs: ['github:issue:42', 'branch:T-001-feature'],
      data: {
        target_role: 'engineer',
        delegation_mode: 'host_subagent',
        fallback: false,
        adapter: 'opencode',
        model: 'gpt-5.4',
        reason: 'Implementation ready',
      },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:01:00.000Z',
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started scoped implementation',
      refs: ['github:issue:42'],
      data: {},
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:02:00.000Z',
      eventType: 'check.run',
      role: 'engineer',
      summary: 'npm test passed',
      outcome: 'success',
      refs: ['command:npm test', 'github:pr:9'],
      data: { command: 'npm test', exit_code: 0, passed: 128, failed: 0, skipped: 2, duration_ms: 15000, attempt: 1 },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:03:00.000Z',
      eventType: 'check.run',
      role: 'engineer',
      summary: 'npm run lint failed',
      outcome: 'failure',
      refs: ['command:npm run lint', 'github:pr:9'],
      data: { command: 'npm run lint', exit_code: 1, passed: 0, failed: 3, skipped: 0, duration_ms: 8000, attempt: 1 },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:04:00.000Z',
      eventType: 'review.started',
      role: 'maintainer',
      summary: 'Started maintainer review',
      refs: ['github:pr:9'],
      data: { review_round: 1, artifact_revision: 'abc123', pr_head: 'abc123' },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:05:00.000Z',
      eventType: 'review.result',
      role: 'maintainer',
      summary: 'Requested revision on the first pass',
      outcome: 'needs_revision',
      refs: ['github:pr:9'],
      data: { review_round: 1, artifact_revision: 'abc123', pr_head: 'abc123' },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:06:00.000Z',
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Started fallback maintainer review pass',
      refs: ['github:pr:9'],
      data: {
        target_role: 'maintainer',
        delegation_mode: 'single_agent_fallback',
        fallback: true,
        adapter: 'opencode',
        reason: 'Review tool unavailable',
      },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:07:00.000Z',
      eventType: 'check.run',
      role: 'engineer',
      summary: 'Smoke check blocked on staging secret',
      outcome: 'blocked',
      refs: ['command:npm run smoke', 'github:pr:9'],
      data: { command: 'npm run smoke', exit_code: 1, passed: 0, failed: 0, skipped: 1, duration_ms: 5000, attempt: 2 },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:10:00.000Z',
      eventType: 'review.result',
      role: 'maintainer',
      summary: 'Accepted implementation',
      outcome: 'accepted',
      refs: ['github:pr:9', 'commit:def456'],
      data: { review_round: 2, artifact_revision: 'def456', pr_head: 'def456' },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:12:00.000Z',
      eventType: 'task.closed',
      role: 'maintainer',
      summary: 'Closed task after accepted review',
      outcome: 'success',
      refs: ['github:issue:42', 'github:pr:9'],
      data: {},
    });

    const report = reportTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(report.eventCount, 10);
    assert.equal(report.firstEventTimestamp, '2026-06-17T10:00:00.000Z');
    assert.equal(report.lastEventTimestamp, '2026-06-17T10:12:00.000Z');
    assert.equal(report.traceDuration, '12m');
    assert.deepEqual(report.strictAudit.missingEventTypes, []);
    assert.equal(report.checkRunCounts.success, 1);
    assert.equal(report.checkRunCounts.failure, 1);
    assert.equal(report.checkRunCounts.blocked, 1);
    assert.deepEqual(
      report.failedOrBlockedChecks.map(check => ({ outcome: check.outcome, summary: check.summary })),
      [
        { outcome: 'failure', summary: 'npm run lint failed' },
        { outcome: 'blocked', summary: 'Smoke check blocked on staging secret' },
      ]
    );
    assert.deepEqual(report.reviewResultCounts, { accepted: 1, needs_revision: 1 });
    assert.deepEqual(report.reviewRounds, ['1', '2']);
    assert.deepEqual(report.roleInvoked.targetRoleCounts, [
      { value: 'engineer', count: 1 },
      { value: 'maintainer', count: 1 },
    ]);
    assert.deepEqual(report.roleInvoked.delegationModeCounts, [
      { value: 'host_subagent', count: 1 },
      { value: 'single_agent_fallback', count: 1 },
    ]);
    assert.equal(report.roleInvoked.fallbackCount, 1);
    assert.deepEqual(report.refsSummary.slice(0, 3), [
      { ref: 'github:pr:9', count: 8 },
      { ref: 'github:issue:42', count: 3 },
      { ref: 'branch:T-001-feature', count: 1 },
    ]);
  });

  it('reportTaskEventLog identifies missing strict-audit events from existing minimal logs', () => {
    const target = makeTarget('report-missing-strict-events');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');
    appendFixtureEvent(target, 'T-001', {
      occurredAt: '2026-06-17T11:00:00.000Z',
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started scoped implementation',
      refs: [],
      data: {},
    });
    appendFixtureEvent(target, 'T-001', {
      occurredAt: '2026-06-17T11:05:00.000Z',
      eventType: 'review.result',
      role: 'maintainer',
      summary: 'Accepted implementation',
      outcome: 'accepted',
      refs: [],
      data: {},
    });

    const report = reportTaskEventLog({ target, taskId: 'T-001' });

    assert.deepEqual(report.strictAudit.presentEventTypes, ['task.started', 'review.result']);
    assert.deepEqual(report.strictAudit.missingEventTypes, ['role.invoked', 'check.run', 'task.closed']);
    assert.deepEqual(report.reviewRounds, []);
    assert.equal(report.roleInvoked.fallbackCount, 0);
  });

  it('reportTaskEventLog fails for a missing task log', () => {
    const target = makeTarget('report-missing-log');

    assert.throws(
      () => reportTaskEventLog({ target, taskId: 'T-404' }),
      /Missing task event log: \.agenticloop\/logs\/T-404\.jsonl/
    );
  });

  it('auditTaskEventLog fails when task.closed is only engineer/success', () => {
    const target = makeTarget('audit-engineer-closure');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001');
    appendFixtureEvent(target, 'T-001', {
      backend: 'files',
      eventType: 'task.closed',
      role: 'engineer',
      summary: 'Engineer marked revision complete',
      outcome: 'success',
      refs: [],
      data: {},
    });

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('Durable task.closed not satisfied')));
    assert.equal(result.durableClosure.satisfied, false);
    assert.ok(result.durableClosure.reason.includes('role was engineer'));
  });

  it('auditTaskEventLog fails for github backend when durable task.closed lacks issue or PR ref', () => {
    const target = makeTarget('audit-github-missing-pr');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });

    appendAuditEvents(target, 'T-001');
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      eventType: 'task.closed',
      role: 'maintainer',
      summary: 'Closed task',
      outcome: 'success',
      refs: ['github:issue:42'],
      data: {},
    });

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('Durable task.closed not satisfied')));
    assert.equal(result.durableClosure.satisfied, false);
    assert.ok(result.durableClosure.reason.includes('missing github:pr ref'));
  });

  it('auditTaskEventLog passes for github backend with maintainer or orchestrator task.closed plus refs', () => {
    for (const role of ['maintainer', 'orchestrator']) {
      const target = makeTarget(`audit-github-closure-${role}`);
      writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });

      appendAuditEvents(target, 'T-001');
      appendFixtureEvent(target, 'T-001', {
        backend: 'github',
        eventType: 'task.closed',
        role,
        summary: 'Closed task',
        outcome: 'success',
        refs: ['github:issue:42', 'github:pr:9'],
        data: {},
      });

      const result = auditTaskEventLog({ target, taskId: 'T-001' });

      assert.equal(result.ok, true, `expected ${role} closure to pass`);
      assert.equal(result.durableClosure.satisfied, true);
    }
  });

  it('auditTaskEventLog tolerates comma-joined legacy refs', () => {
    const target = makeTarget('audit-comma-refs');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });

    appendAuditEvents(target, 'T-001');
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      eventType: 'task.closed',
      role: 'maintainer',
      summary: 'Closed task',
      outcome: 'success',
      refs: ['github:issue:42, github:pr:9'],
      data: {},
    });

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, true);
    assert.equal(result.durableClosure.satisfied, true);
  });

  it('auditTaskEventLog passes for files backend with maintainer/orchestrator success task.closed without github refs', () => {
    const target = makeTarget('audit-files-closure');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001');

    const result = auditTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(result.ok, true);
    assert.equal(result.durableClosure.satisfied, true);
  });

  it('custom --require audits that omit task.closed do not enforce durable closure', () => {
    const target = makeTarget('audit-custom-no-closure');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001', ['role.invoked', 'task.started', 'check.run', 'review.result']);
    appendFixtureEvent(target, 'T-001', {
      backend: 'files',
      eventType: 'task.closed',
      role: 'engineer',
      summary: 'Engineer revision complete',
      outcome: 'success',
      refs: [],
      data: {},
    });

    const result = auditTaskEventLog({
      target,
      taskId: 'T-001',
      requiredEventTypes: ['role.invoked', 'task.started', 'check.run', 'review.result'],
      explicitRequire: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.durableClosure, undefined);
  });

  it('reportTaskEventLog returns durable closure status and accepted imperfect check data', () => {
    const target = makeTarget('report-accepted-imperfect');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });

    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:00:00.000Z',
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer',
      refs: ['github:issue:42'],
      data: {},
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:01:00.000Z',
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started implementation',
      refs: ['github:issue:42'],
      data: {},
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:02:00.000Z',
      eventType: 'check.run',
      role: 'engineer',
      summary: 'Unrelated flaky test failed',
      outcome: 'failure',
      refs: ['command:npm test', 'github:pr:9'],
      data: { command: 'npm test', exit_code: 1, passed: 127, failed: 1, triaged_unrelated: true, required: true },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:03:00.000Z',
      eventType: 'check.run',
      role: 'engineer',
      summary: 'Known pre-existing lint failure',
      outcome: 'failure',
      refs: ['command:npm run lint', 'github:pr:9'],
      data: { command: 'npm run lint', exit_code: 1, accepted_known_failure: true },
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:04:00.000Z',
      eventType: 'review.result',
      role: 'maintainer',
      summary: 'Accepted implementation',
      outcome: 'accepted',
      refs: ['github:pr:9'],
      data: {},
    });
    appendFixtureEvent(target, 'T-001', {
      backend: 'github',
      occurredAt: '2026-06-17T10:05:00.000Z',
      eventType: 'task.closed',
      role: 'maintainer',
      summary: 'Closed task',
      outcome: 'success',
      refs: ['github:issue:42', 'github:pr:9'],
      data: {},
    });

    const report = reportTaskEventLog({ target, taskId: 'T-001' });

    assert.equal(report.strictAudit.durableClosure.satisfied, true);
    assert.equal(report.checkRunCounts.failure, 2);
    assert.equal(report.failedOrBlockedChecks.length, 0);
    assert.equal(report.acceptedImperfectChecks.length, 2);
    assert.deepEqual(
      report.acceptedImperfectChecks.map(check => ({
        summary: check.summary,
        triaged_unrelated: check.triaged_unrelated,
        accepted_known_failure: check.accepted_known_failure,
        required: check.required,
      })),
      [
        { summary: 'Unrelated flaky test failed', triaged_unrelated: true, accepted_known_failure: false, required: true },
        { summary: 'Known pre-existing lint failure', triaged_unrelated: false, accepted_known_failure: true, required: false },
      ]
    );
  });
});

describe('reportEventLogs aggregate', () => {
  it('summarizes a complete passing task log', () => {
    const target = makeTarget('aggregate-complete-pass');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001');

    const result = reportEventLogs({ target });

    assert.equal(result.filesScanned, 1);
    assert.equal(result.validTaskLogCount, 1);
    assert.equal(result.invalidLogCount, 0);
    assert.equal(result.strictAuditPassCount, 1);
    assert.equal(result.strictAuditFailCount, 0);
    assert.equal(result.durableClosureSatisfied, 1);
    assert.equal(result.durableClosureMissing, 0);
    assert.equal(result.durableClosureFailing, 0);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].taskId, 'T-001');
    assert.equal(result.tasks[0].eventCount, STRICT_AUDIT_EVENT_TYPES.length);
  });

  it('flags incomplete historical logs missing strict-audit events', () => {
    const target = makeTarget('aggregate-incomplete');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendFixtureEvent(target, 'T-001', {
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started implementation',
    });
    appendFixtureEvent(target, 'T-001', {
      eventType: 'review.result',
      role: 'maintainer',
      summary: 'Accepted implementation',
      outcome: 'accepted',
    });

    const result = reportEventLogs({ target });

    assert.equal(result.filesScanned, 1);
    assert.equal(result.validTaskLogCount, 1);
    assert.equal(result.strictAuditPassCount, 0);
    assert.equal(result.strictAuditFailCount, 1);
    assert.deepEqual(result.tasksWithMissingRoleInvoked, ['T-001']);
    assert.deepEqual(result.tasksWithMissingTaskClosed, ['T-001']);
  });

  it('surfaces accepted imperfect checks separately from failed/blocked checks', () => {
    const target = makeTarget('aggregate-accepted-imperfect');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001', ['role.invoked', 'task.started', 'review.result', 'task.closed']);
    appendFixtureEvent(target, 'T-001', {
      eventType: 'check.run',
      role: 'engineer',
      summary: 'Unrelated flaky test failed',
      outcome: 'failure',
      data: { command: 'npm test', triaged_unrelated: true, required: true },
    });
    appendFixtureEvent(target, 'T-001', {
      eventType: 'check.run',
      role: 'engineer',
      summary: 'Known pre-existing lint failure',
      outcome: 'failure',
      data: { command: 'npm run lint', accepted_known_failure: true },
    });

    const result = reportEventLogs({ target });

    assert.equal(result.filesScanned, 1);
    assert.equal(result.totalCheckOutcomes.failure, 2);
    assert.equal(result.tasks[0].acceptedImperfectChecks.length, 2);
    assert.equal(result.tasks[0].failedOrBlockedChecks.length, 0);
  });

  it('collects invalid and malformed logs without failing the whole aggregate', () => {
    const target = makeTarget('aggregate-invalid-log');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001');

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'manual.jsonl'), 'not json\n', 'utf-8');

    const result = reportEventLogs({ target });

    assert.equal(result.filesScanned, 2);
    assert.equal(result.validTaskLogCount, 1);
    assert.equal(result.invalidLogCount, 1);
    assert.equal(result.emptyLogCount, 0);
    assert.equal(result.invalidLogs.length, 1);
    assert.equal(result.emptyLogs.length, 0);
    assert.ok(result.invalidLogs[0].errors.some(error => error.includes('invalid JSON')));
  });

  it('reports empty logs separately from malformed logs', () => {
    const target = makeTarget('aggregate-empty-log');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    appendAuditEvents(target, 'T-001');

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'empty.jsonl'), '', 'utf-8');
    writeFileSync(join(target, '.agenticloop', 'logs', 'manual.jsonl'), 'not json\n', 'utf-8');

    const result = reportEventLogs({ target });

    assert.equal(result.filesScanned, 3);
    assert.equal(result.validTaskLogCount, 1);
    assert.equal(result.invalidLogCount, 1);
    assert.equal(result.emptyLogCount, 1);
    assert.equal(result.invalidLogs.length, 1);
    assert.equal(result.emptyLogs.length, 1);
    assert.equal(result.emptyLogs[0].displayPath, '.agenticloop/logs/empty.jsonl');
    assert.ok(result.warnings.some(warning => warning.includes('empty.jsonl: event log has zero events')));
  });

  it('rolls up aggregate delegation mode totals and fallback count', () => {
    const target = makeTarget('aggregate-delegation-rollups');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });

    appendFixtureEvent(target, 'T-001', {
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer',
      data: { target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false },
    });
    appendFixtureEvent(target, 'T-001', {
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started T-001',
    });
    appendFixtureEvent(target, 'T-001', {
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Fallback review',
      data: { target_role: 'maintainer', delegation_mode: 'single_agent_fallback', fallback: true },
    });

    appendFixtureEvent(target, 'T-002', {
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer for T-002',
      data: { target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false },
    });
    appendFixtureEvent(target, 'T-002', {
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started T-002',
    });

    const result = reportEventLogs({ target });

    assert.equal(result.validTaskLogCount, 2);
    assert.deepEqual(result.totalRoleInvokedTargets, [
      { value: 'engineer', count: 2 },
      { value: 'maintainer', count: 1 },
    ]);
    assert.deepEqual(result.totalDelegationModes, [
      { value: 'host_subagent', count: 2 },
      { value: 'single_agent_fallback', count: 1 },
    ]);
    assert.equal(result.totalFallbackCount, 1);
  });

  it('uses parsed line numbers for host=unknown events', () => {
    const target = makeTarget('aggregate-host-unknown-line');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(target, '.opencode', 'agents', 'orchestrator.md'), '# orchestrator\n', 'utf-8');

    appendFixtureEvent(target, 'T-001', {
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started T-001',
      host: 'opencode',
    });
    appendFixtureEvent(target, 'T-001', {
      eventType: 'check.run',
      role: 'engineer',
      summary: 'Check passed',
      outcome: 'success',
      host: 'unknown',
    });

    const result = reportEventLogs({ target });

    assert.equal(result.hostUnknownEvents.length, 1);
    assert.equal(result.hostUnknownEvents[0].taskId, 'T-001');
    assert.equal(result.hostUnknownEvents[0].line, 2);
    assert.equal(result.hostUnknownEvents[0].inferredTaskId, 'T-001');
    assert.equal(result.hostUnknownEvents[0].eventTaskId, 'T-001');
  });

  it('surfaces host=unknown events as telemetry-quality warnings', () => {
    const target = makeTarget('aggregate-host-unknown');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'files' });
    writeTaskRecord(target, 'T-001');
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(target, '.opencode', 'agents', 'orchestrator.md'), '# orchestrator\n', 'utf-8');
    appendFixtureEvent(target, 'T-001', {
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer',
      host: 'unknown',
    });
    appendFixtureEvent(target, 'T-001', {
      eventType: 'task.started',
      role: 'engineer',
      summary: 'Started implementation',
      host: 'opencode',
    });

    const result = reportEventLogs({ target });

    assert.equal(result.hostUnknownEvents.length, 1);
    assert.equal(result.hostUnknownEvents[0].taskId, 'T-001');
  });
});

describe('feature-adoption telemetry', () => {
  it('derives review rounds from review.result events without new producer data', () => {
    const target = makeTarget('features-derive');
    // A P23-16-like case: three review.result events -> three derived rounds.
    appendFixtureEvent(target, 'P23-16', {
      eventType: 'review.result', role: 'maintainer', summary: 'Round 1', outcome: 'needs_revision',
    });
    appendFixtureEvent(target, 'P23-16', {
      eventType: 'review.result', role: 'maintainer', summary: 'Round 2', outcome: 'needs_revision',
    });
    appendFixtureEvent(target, 'P23-16', {
      eventType: 'review.result', role: 'maintainer', summary: 'Round 3', outcome: 'accepted',
    });

    const { features } = reportEventLogs({ target });
    const task = features.reviewRounds.churnTasks.find(entry => entry.taskId === 'P23-16');
    assert.ok(task, 'P23-16 should be a churn task');
    assert.equal(task.derivedReviewRounds, 3);
    assert.equal(task.needsRevisionCount, 2);
    assert.equal(task.acceptedCount, 1);
    assert.equal(features.tasksWithTelemetry, 0, 'no emitted telemetry present');
  });

  it('reports tasks above the default review budget', () => {
    const target = makeTarget('features-over-budget');
    for (let i = 0; i < 4; i += 1) {
      appendFixtureEvent(target, 'P12-01', {
        eventType: 'review.result', role: 'maintainer', summary: `Round ${i + 1}`, outcome: 'needs_revision',
      });
    }
    appendFixtureEvent(target, 'P12-01', {
      eventType: 'review.result', role: 'maintainer', summary: 'Accepted', outcome: 'accepted',
    });

    const { features } = reportEventLogs({ target });
    assert.ok(features.reviewRounds.tasksOverBudget.includes('P12-01'));
    assert.equal(features.reviewRounds.maxDerivedReviewRounds, 5);
  });

  it('does not warn on historical logs without telemetry', () => {
    const target = makeTarget('features-historical');
    appendAuditEvents(target, 'T-001');
    const { features } = reportEventLogs({ target });
    assert.deepEqual(features.warnings, []);
    // Default single-round audit task is not over budget.
    assert.deepEqual(features.reviewRounds.tasksOverBudget, []);
  });

  it('aggregates emitted minimalism, triggers, budgets, and context risk', () => {
    const target = makeTarget('features-aggregate');
    appendFixtureEvent(target, 'P23-16', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created integration sweep',
      data: {
        feature_telemetry_version: 1,
        minimalism: 'none',
        minimalism_trigger: 'verification-sweep',
        review_budget: 5,
        context_overflow_risk: 'medium',
        context_note: 'Broad integration; focused checks then final gate.',
      },
    });
    appendFixtureEvent(target, 'P23-16', {
      eventType: 'review.result', role: 'maintainer', summary: 'Round 1', outcome: 'accepted',
    });
    appendFixtureEvent(target, 'P23-16', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: {
        feature_telemetry_version: 1,
        review_rounds: 1,
        review_budget: 5,
        review_budget_exceeded: false,
        context_overflow_risk: 'medium',
        context_pressure_encountered: false,
      },
    });

    const { features } = reportEventLogs({ target });
    assert.equal(features.tasksWithTelemetry, 1);
    assert.equal(features.minimalism.none, 1);
    assert.deepEqual(features.minimalismTriggers, [{ trigger: 'verification-sweep', count: 1 }]);
    assert.deepEqual(features.budgets.nonDefaultReview, [{ taskId: 'P23-16', reviewBudget: 5 }]);
    assert.equal(features.contextOverflowRisk.medium, 1);
    assert.deepEqual(features.contextOverflowRisk.tasks, ['P23-16']);
    assert.equal(features.contextPressure.false, 1);
    assert.deepEqual(features.contextPressure.missingForRiskTasks, []);
    assert.deepEqual(features.warnings, []);
  });

  it('consumes the closeout review_rounds total when review.result events are sparse', () => {
    const target = makeTarget('features-review-rounds-plural');
    appendFixtureEvent(target, 'P30-01', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default' },
    });
    appendFixtureEvent(target, 'P30-01', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, review_rounds: 5 },
    });

    const { features } = reportEventLogs({ target });
    assert.equal(features.reviewRounds.maxDerivedReviewRounds, 5);
    assert.ok(features.reviewRounds.tasksOverBudget.includes('P30-01'));
    // Over budget with no review_budget_exceeded recorded -> warns (missing).
    assert.ok(features.warnings.some(warning => warning.includes('P30-01') && warning.includes('missing')));
  });

  it('warns when an over-budget task records review_budget_exceeded: false', () => {
    const target = makeTarget('features-exceeded-false');
    appendFixtureEvent(target, 'P30-02', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default' },
    });
    appendFixtureEvent(target, 'P30-02', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, review_rounds: 6, review_budget_exceeded: false },
    });

    const { features } = reportEventLogs({ target });
    assert.ok(features.warnings.some(warning => warning.includes('P30-02') && warning.includes('false, not true')));
  });

  it('warns when review_budget_exceeded: true contradicts within-budget derived rounds', () => {
    const target = makeTarget('features-exceeded-inverse');
    appendFixtureEvent(target, 'P30-03', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default' },
    });
    appendFixtureEvent(target, 'P30-03', {
      eventType: 'review.result', role: 'maintainer', summary: 'Accepted', outcome: 'accepted',
    });
    appendFixtureEvent(target, 'P30-03', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, review_rounds: 1, review_budget_exceeded: true },
    });

    const { features } = reportEventLogs({ target });
    assert.ok(!features.reviewRounds.tasksOverBudget.includes('P30-03'));
    assert.ok(features.warnings.some(warning => warning.includes('P30-03') && warning.includes('within budget')));
  });

  it('warns when a context-risk telemetry task omits context_pressure_encountered', () => {
    const target = makeTarget('features-missing-pressure');
    appendFixtureEvent(target, 'P23-20', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created risky task',
      data: {
        feature_telemetry_version: 1,
        minimalism: 'none',
        minimalism_trigger: 'cross-cutting',
        context_overflow_risk: 'high',
        context_note: 'Large surface.',
      },
    });
    appendFixtureEvent(target, 'P23-20', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed',
      outcome: 'success', data: { feature_telemetry_version: 1 },
    });

    const { features } = reportEventLogs({ target });
    assert.equal(features.contextPressure.missingForRiskTasks.length, 1);
    assert.ok(features.warnings.some(warning => warning.includes('P23-20') && warning.includes('context_pressure_encountered')));
  });

  it('validateEvent warns when a telemetry task.created omits minimalism', () => {
    const result = validateEvent(buildEvent({
      task: 'P23-30', eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: { feature_telemetry_version: 1 },
    }));
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(warning => warning.includes('missing minimalism')));
  });

  it('validateEvent does not require minimalism when telemetry marker is absent', () => {
    const result = validateEvent(buildEvent({
      task: 'P23-31', eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: {},
    }));
    assert.deepEqual(result.errors, []);
    assert.ok(!result.warnings.some(warning => warning.includes('minimalism')));
  });

  it('validateEvent warns on a dump-like context_note but still accepts telemetry keys', () => {
    const longNote = `system: ${'x'.repeat(400)}\nassistant: ${'y'.repeat(400)}`;
    const result = validateEvent(buildEvent({
      task: 'P23-32', eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: { feature_telemetry_version: 1, minimalism: 'none', context_note: longNote },
    }));
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(warning => warning.includes('context_note')));
  });

  it('still blocks banned privacy keys inside telemetry data', () => {
    const result = validateEvent(buildEvent({
      task: 'P23-33', eventType: 'task.created', role: 'maintainer', summary: 'Created task',
      data: { feature_telemetry_version: 1, minimalism: 'none', prompt: 'leaked prompt text' },
    }));
    assert.ok(result.errors.some(error => error.includes("banned privacy-sensitive key 'data.prompt'")));
  });

  it('flags Rule 1: telemetry task hit context pressure with no risk predicted', () => {
    const target = makeTarget('omission-rule1');
    appendFixtureEvent(target, 'P40-01', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default' },
    });
    appendFixtureEvent(target, 'P40-01', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, context_pressure_encountered: true },
    });
    const { features } = reportEventLogs({ target });
    assert.deepEqual(features.omissionCandidates.contextRiskPressureNoPredict, ['P40-01']);
    assert.deepEqual(features.omissionCandidates.contextRiskOverBudgetNoPredict, []);
    assert.deepEqual(features.warnings, []); // candidate, not a warning
  });

  it('does not flag Rule 1 when risk was predicted', () => {
    const target = makeTarget('omission-rule1-predicted');
    appendFixtureEvent(target, 'P40-02', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'cross-cutting', context_overflow_risk: 'medium', context_note: 'broad' },
    });
    appendFixtureEvent(target, 'P40-02', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, context_overflow_risk: 'medium', context_pressure_encountered: true },
    });
    const { features } = reportEventLogs({ target });
    assert.deepEqual(features.omissionCandidates.contextRiskPressureNoPredict, []);
  });

  it('flags Rule 2: reached/exceeded budget, no risk, no confirmed pressure', () => {
    const target = makeTarget('omission-rule2');
    appendFixtureEvent(target, 'P40-03', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default' },
    });
    appendFixtureEvent(target, 'P40-03', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, review_rounds: 6 },
    });
    const { features } = reportEventLogs({ target });
    assert.equal(features.omissionCandidates.contextRiskOverBudgetNoPredict.length, 1);
    assert.equal(features.omissionCandidates.contextRiskOverBudgetNoPredict[0].taskId, 'P40-03');
    assert.deepEqual(features.omissionCandidates.contextRiskPressureNoPredict, []);
  });

  it('Rule 1 owns a task over budget that also hit pressure (no double-listing)', () => {
    const target = makeTarget('omission-rule1-owns');
    appendFixtureEvent(target, 'P40-04', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created',
      data: { feature_telemetry_version: 1, minimalism: 'none', minimalism_trigger: 'ordinary-default' },
    });
    appendFixtureEvent(target, 'P40-04', {
      eventType: 'task.closed', role: 'maintainer', summary: 'Closed', outcome: 'success',
      data: { feature_telemetry_version: 1, review_rounds: 6, context_pressure_encountered: true },
    });
    const { features } = reportEventLogs({ target });
    assert.deepEqual(features.omissionCandidates.contextRiskPressureNoPredict, ['P40-04']);
    assert.deepEqual(features.omissionCandidates.contextRiskOverBudgetNoPredict, []);
  });

  it('does not flag omission candidates on historical non-telemetry logs', () => {
    const target = makeTarget('omission-historical');
    for (let i = 0; i < 5; i += 1) {
      appendFixtureEvent(target, 'P40-05', {
        eventType: 'review.result', role: 'maintainer', summary: `Round ${i + 1}`, outcome: 'needs_revision',
      });
    }
    const { features } = reportEventLogs({ target });
    assert.ok(features.reviewRounds.tasksOverBudget.includes('P40-05')); // over budget, but...
    assert.deepEqual(features.omissionCandidates.contextRiskPressureNoPredict, []);
    assert.deepEqual(features.omissionCandidates.contextRiskOverBudgetNoPredict, []); // forward-gated
  });
});

// ---------------------------------------------------------------------------
// Strict producer validation for newly written events
// ---------------------------------------------------------------------------

function roleInvokedEvent(data, overrides = {}) {
  return buildEvent({
    task: 'T-001',
    eventType: 'role.invoked',
    role: overrides.role ?? 'orchestrator',
    summary: overrides.summary ?? 'Delegated role',
    data,
  });
}

describe('strict producer validation: role.invoked', () => {
  it('accepts a complete host_subagent delegation (scenario 1)', () => {
    const result = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false,
    }));
    assert.deepEqual(result.errors, []);
  });

  it('accepts a complete explicit_agent_invocation delegation (scenario 2)', () => {
    const result = validateNewEvent(roleInvokedEvent({
      target_role: 'maintainer', delegation_mode: 'explicit_agent_invocation', fallback: false,
    }));
    assert.deepEqual(result.errors, []);
  });

  it('accepts fallback with mechanism_absent (scenario 3)', () => {
    const result = validateNewEvent(roleInvokedEvent({
      target_role: 'maintainer', delegation_mode: 'single_agent_fallback', fallback: true,
      fallback_cause: 'mechanism_absent', reason: 'No subagent/task/agent mechanism in this host',
    }));
    assert.deepEqual(result.errors, []);
  });

  it('accepts fallback with invocation_failed (scenario 4)', () => {
    const result = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', delegation_mode: 'single_agent_fallback', fallback: true,
      fallback_cause: 'invocation_failed', reason: 'subagent_type=engineer returned a spawn error',
    }));
    assert.deepEqual(result.errors, []);
  });

  it('rejects fallback justified only by "re-review requested" (scenario 5)', () => {
    const result = validateNewEvent(roleInvokedEvent({
      target_role: 'maintainer', delegation_mode: 'single_agent_fallback', fallback: true,
      reason: 'Round-2 re-review requested',
    }));
    assert.ok(result.errors.some(e => e.includes('fallback_cause')));
  });

  it('rejects a maintainer self-invocation (scenario 6)', () => {
    const result = validateNewEvent(roleInvokedEvent({
      target_role: 'maintainer', delegation_mode: 'single_agent_fallback', fallback: true,
      fallback_cause: 'mechanism_absent', reason: 'no mechanism',
    }, { role: 'maintainer' }));
    assert.ok(result.errors.some(e => e.includes('must be emitted by the orchestrator')));
  });

  it('rejects missing target_role, mode, or boolean fallback (scenario 7)', () => {
    const missingTarget = validateNewEvent(roleInvokedEvent({
      delegation_mode: 'host_subagent', fallback: false,
    }));
    assert.ok(missingTarget.errors.some(e => e.includes('data.target_role')));

    const missingMode = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', fallback: false,
    }));
    assert.ok(missingMode.errors.some(e => e.includes('data.delegation_mode')));

    const missingFallback = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', delegation_mode: 'host_subagent',
    }));
    assert.ok(missingFallback.errors.some(e => e.includes('boolean data.fallback')));
  });

  it('rejects a non-fallback mode that carries fallback: true or a cause', () => {
    const badFallbackFlag = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', delegation_mode: 'host_subagent', fallback: true,
    }));
    assert.ok(badFallbackFlag.errors.some(e => e.includes('requires data.fallback: false')));

    const strayCause = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false, fallback_cause: 'mechanism_absent',
    }));
    assert.ok(strayCause.errors.some(e => e.includes('must not carry data.fallback_cause')));
  });

  it('rejects an unknown target_role or delegation_mode', () => {
    const badTarget = validateNewEvent(roleInvokedEvent({
      target_role: 'reviewer', delegation_mode: 'host_subagent', fallback: false,
    }));
    assert.ok(badTarget.errors.some(e => e.includes('target_role must be one of')));

    const badMode = validateNewEvent(roleInvokedEvent({
      target_role: 'engineer', delegation_mode: 'bot_delegation', fallback: false,
    }));
    assert.ok(badMode.errors.some(e => e.includes('delegation_mode must be one of')));
  });
});

describe('strict producer validation: review.result', () => {
  function reviewResultEvent(data, overrides = {}) {
    return buildEvent({
      task: 'T-001', eventType: 'review.result',
      role: overrides.role ?? 'maintainer',
      summary: overrides.summary ?? 'Recorded review',
      outcome: overrides.outcome ?? 'accepted',
      data,
    });
  }

  it('accepts a complete review.result', () => {
    const result = validateNewEvent(reviewResultEvent({ review_round: 1, review_mode: 'host_subagent' }));
    assert.deepEqual(result.errors, []);
  });

  it('requires review_mode and review_round', () => {
    const noMode = validateNewEvent(reviewResultEvent({ review_round: 1 }));
    assert.ok(noMode.errors.some(e => e.includes('data.review_mode')));
    const noRound = validateNewEvent(reviewResultEvent({ review_mode: 'host_subagent' }));
    assert.ok(noRound.errors.some(e => e.includes('data.review_round')));
  });

  it('accepts a direct continuation carrying continuation_reason (scenario 9)', () => {
    const result = validateNewEvent(reviewResultEvent({
      review_round: 2, review_mode: 'single_agent_fallback',
      continuation_reason: 'human continued the active maintainer session',
    }));
    assert.deepEqual(result.errors, []);
  });

  it('rejects an empty continuation_reason when present', () => {
    const result = validateNewEvent(reviewResultEvent({
      review_round: 2, review_mode: 'single_agent_fallback', continuation_reason: '   ',
    }));
    assert.ok(result.errors.some(e => e.includes('continuation_reason must be a non-empty string')));
  });

  it('allows maintainer_fixup: true only for a maintainer single_agent_fallback result', () => {
    const ok = validateNewEvent(reviewResultEvent({
      review_round: 1, review_mode: 'single_agent_fallback', maintainer_fixup: true,
    }));
    assert.deepEqual(ok.errors, []);

    const wrongMode = validateNewEvent(reviewResultEvent({
      review_round: 1, review_mode: 'host_subagent', maintainer_fixup: true,
    }));
    assert.ok(wrongMode.errors.some(e => e.includes("requires review_mode 'single_agent_fallback'")));

    const wrongRole = validateNewEvent(reviewResultEvent({
      review_round: 1, review_mode: 'single_agent_fallback', maintainer_fixup: true,
    }, { role: 'engineer' }));
    assert.ok(wrongRole.errors.some(e => e.includes('must be emitted by the maintainer')));

    const nonBool = validateNewEvent(reviewResultEvent({
      review_round: 1, review_mode: 'single_agent_fallback', maintainer_fixup: 'yes',
    }));
    assert.ok(nonBool.errors.some(e => e.includes('maintainer_fixup must be a boolean')));
  });

  it('does not require maintainer_fixup on ordinary reviews', () => {
    const result = validateNewEvent(reviewResultEvent({ review_round: 1, review_mode: 'host_subagent' }));
    assert.deepEqual(result.errors, []);
  });

  it('requires every newly produced review.result to be emitted by the maintainer', () => {
    const result = validateNewEvent(reviewResultEvent(
      { review_round: 1, review_mode: 'host_subagent' },
      { role: 'engineer' }
    ));
    assert.ok(result.errors.some(e => e.includes('must be emitted by the maintainer')));
  });
});

describe('appendEventLog producer guard', () => {
  it('refuses to append an invalid new role.invoked (scenario 7)', () => {
    const target = makeTarget('producer-guard-invalid');
    assert.throws(
      () => appendEventLog({
        target,
        event: buildEvent({ task: 'T-001', eventType: 'role.invoked', role: 'orchestrator', summary: 'Bad delegation', data: {} }),
      }),
      /Refusing to append invalid event/
    );
  });

  it('appends a complete new role.invoked through the producer guard', () => {
    const target = makeTarget('producer-guard-valid');
    const filePath = appendEventLog({
      target,
      event: buildEvent({
        task: 'T-001', eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated engineer',
        data: { target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false },
      }),
    });
    assert.equal(loadEvents(filePath).length, 1);
  });

  it('historical: true bypasses the producer guard for stored-log simulation (scenario 8)', () => {
    const target = makeTarget('producer-guard-historical');
    const filePath = appendEventLog({
      target,
      historical: true,
      event: buildEvent({ task: 'T-001', eventType: 'role.invoked', role: 'maintainer', summary: 'Legacy self-invocation', data: { target_role: 'maintainer', delegation_mode: 'single_agent_fallback', reason: 'Round-2 re-review requested' } }),
    });
    // The historical event is still readable and shape-valid.
    const events = loadEvents(filePath);
    assert.equal(events.length, 1);
    assert.deepEqual(validateEvent(events[0]).errors, []);
  });
});

describe('provenance-quality telemetry (historical logs are labeled, not rewritten)', () => {
  it('counts incomplete and self-invoked historical role.invoked events (scenario 8)', () => {
    const target = makeTarget('provenance-quality-incomplete');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });
    // A P20-02/PR-129-style legacy self-invocation with no fallback flag/cause.
    appendFixtureEvent(target, 'P20-02', {
      backend: 'github', eventType: 'role.invoked', role: 'maintainer',
      summary: 'Maintainer began round-2 PR re-review',
      refs: ['github:issue:109', 'github:pr:129'],
      data: { target_role: 'maintainer', delegation_mode: 'single_agent_fallback', reason: 'Round-2 re-review requested' },
    });

    const report = reportTaskEventLog({ target, taskId: 'P20-02' });
    const pq = report.provenanceQuality;
    assert.equal(pq.roleInvokedNonOrchestrator, 1);
    assert.equal(pq.roleInvokedSelfInvocation, 1);
    assert.equal(pq.roleInvokedMissingFallback, 1);
    assert.equal(pq.roleInvokedFallbackWithoutCause, 1);
    assert.equal(pq.roleInvokedInconsistentModeFallback, 1);

    const aggregate = reportEventLogs({ target });
    assert.equal(aggregate.provenanceQuality.roleInvokedSelfInvocation.count, 1);
    assert.deepEqual(aggregate.provenanceQuality.roleInvokedSelfInvocation.tasks, ['P20-02']);
    assert.equal(aggregate.provenanceQuality.roleInvokedNonOrchestrator.count, 1);
  });

  it('counts review rounds without delegation or continuation, and review_mode gaps', () => {
    const target = makeTarget('provenance-quality-review');
    // Two review results, no maintainer delegation, no continuation reason.
    appendFixtureEvent(target, 'T-050', {
      eventType: 'review.result', role: 'maintainer', summary: 'Round 1', outcome: 'needs_revision',
      data: { review_round: 1 },
    });
    appendFixtureEvent(target, 'T-050', {
      eventType: 'review.result', role: 'maintainer', summary: 'Round 2', outcome: 'accepted',
      data: { review_round: 2, review_mode: 'single_agent_fallback' },
    });

    const report = reportTaskEventLog({ target, taskId: 'T-050' });
    assert.equal(report.provenanceQuality.reviewResultMissingReviewMode, 1);
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 2);
  });

  it('a direct continuation with continuation_reason is not counted as unbacked', () => {
    const target = makeTarget('provenance-quality-continuation');
    appendFixtureEvent(target, 'T-051', {
      eventType: 'review.result', role: 'maintainer', summary: 'Continued review', outcome: 'accepted',
      data: { review_round: 1, review_mode: 'single_agent_fallback', continuation_reason: 'human continued the session' },
    });
    const report = reportTaskEventLog({ target, taskId: 'T-051' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 0);
  });

  it('does not flag a complete host_subagent delegation + backed review', () => {
    const target = makeTarget('provenance-quality-clean');
    appendFixtureEvent(target, 'T-052', {
      eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated maintainer review',
      data: { target_role: 'maintainer', delegation_mode: 'host_subagent', fallback: false },
    });
    appendFixtureEvent(target, 'T-052', {
      eventType: 'review.result', role: 'maintainer', summary: 'Accepted', outcome: 'accepted',
      data: { review_round: 1, review_mode: 'host_subagent' },
    });
    const report = reportTaskEventLog({ target, taskId: 'T-052' });
    const pq = report.provenanceQuality;
    assert.equal(pq.roleInvokedNonOrchestrator, 0);
    assert.equal(pq.roleInvokedSelfInvocation, 0);
    assert.equal(pq.reviewResultMissingReviewMode, 0);
    assert.equal(pq.reviewRoundsWithoutBacking, 0);
  });
});

describe('per-review backing correlation (no aggregate subtraction)', () => {
  function maintainerInvocation(extraData = {}) {
    return {
      eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated maintainer review',
      data: { target_role: 'maintainer', delegation_mode: 'host_subagent', fallback: false, ...extraData },
    };
  }

  function reviewResult(round, extraData = {}) {
    return {
      eventType: 'review.result', role: 'maintainer', summary: `Round ${round}`, outcome: 'accepted',
      data: { review_round: round, review_mode: 'host_subagent', ...extraData },
    };
  }

  it('two review rounds with only one invocation and no continuation report one gap', () => {
    const target = makeTarget('backing-one-invocation');
    appendFixtureEvent(target, 'T-070', maintainerInvocation());
    appendFixtureEvent(target, 'T-070', reviewResult(1));
    appendFixtureEvent(target, 'T-070', reviewResult(2));
    const report = reportTaskEventLog({ target, taskId: 'T-070' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 1);
  });

  it('a second round with a continuation reason is not a second gap', () => {
    const target = makeTarget('backing-continuation');
    appendFixtureEvent(target, 'T-071', maintainerInvocation());
    appendFixtureEvent(target, 'T-071', reviewResult(1));
    appendFixtureEvent(target, 'T-071', reviewResult(2, {
      review_mode: 'single_agent_fallback',
      continuation_reason: 'human continued the active maintainer session',
    }));
    const report = reportTaskEventLog({ target, taskId: 'T-071' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 0);
  });

  it('an unrelated planning invocation before a review does not satisfy that review', () => {
    const target = makeTarget('backing-planning');
    // Maintainer invoked for planning: the delegation is followed by
    // task.created before any review starts, so it is planning-scoped.
    appendFixtureEvent(target, 'T-072', maintainerInvocation());
    appendFixtureEvent(target, 'T-072', {
      eventType: 'task.created', role: 'maintainer', summary: 'Created task record',
    });
    appendFixtureEvent(target, 'T-072', reviewResult(1));
    const report = reportTaskEventLog({ target, taskId: 'T-072' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 1);
  });

  it('an earlier-round leftover invocation does not mask a later unbacked round', () => {
    const target = makeTarget('backing-earlier-round');
    // Two invocations before round 1 (e.g. one retried), none before round 2.
    appendFixtureEvent(target, 'T-073', maintainerInvocation());
    appendFixtureEvent(target, 'T-073', maintainerInvocation());
    appendFixtureEvent(target, 'T-073', reviewResult(1));
    appendFixtureEvent(target, 'T-073', reviewResult(2));
    const report = reportTaskEventLog({ target, taskId: 'T-073' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 1);
  });

  it('an invocation with a matching review_round backs the review; a mismatch does not', () => {
    const matching = makeTarget('backing-round-match');
    appendFixtureEvent(matching, 'T-074', maintainerInvocation({ review_round: 2 }));
    appendFixtureEvent(matching, 'T-074', reviewResult(2));
    assert.equal(
      reportTaskEventLog({ target: matching, taskId: 'T-074' }).provenanceQuality.reviewRoundsWithoutBacking,
      0
    );

    const mismatched = makeTarget('backing-round-mismatch');
    appendFixtureEvent(mismatched, 'T-075', maintainerInvocation({ review_round: 1 }));
    appendFixtureEvent(mismatched, 'T-075', reviewResult(2));
    assert.equal(
      reportTaskEventLog({ target: mismatched, taskId: 'T-075' }).provenanceQuality.reviewRoundsWithoutBacking,
      1
    );
  });

  it('one invocation cannot back multiple review rounds even with matching rounds absent', () => {
    const target = makeTarget('backing-consumed');
    appendFixtureEvent(target, 'T-076', maintainerInvocation());
    appendFixtureEvent(target, 'T-076', reviewResult(1));
    appendFixtureEvent(target, 'T-076', reviewResult(2));
    appendFixtureEvent(target, 'T-076', reviewResult(3));
    const report = reportTaskEventLog({ target, taskId: 'T-076' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 2);
  });

  it('a review.started between invocation and result keeps the round association', () => {
    const target = makeTarget('backing-review-started');
    appendFixtureEvent(target, 'T-077', maintainerInvocation());
    appendFixtureEvent(target, 'T-077', {
      eventType: 'review.started', role: 'maintainer', summary: 'Started round 1',
      data: { review_round: 1, review_mode: 'host_subagent' },
    });
    appendFixtureEvent(target, 'T-077', reviewResult(1));
    const report = reportTaskEventLog({ target, taskId: 'T-077' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 0);
  });

  it('out-of-order or malformed historical events remain reportable without crashing', () => {
    const target = makeTarget('backing-malformed');
    // Result before its invocation, malformed round values, and missing data.
    appendFixtureEvent(target, 'T-078', reviewResult('not-a-number'));
    appendFixtureEvent(target, 'T-078', maintainerInvocation({ review_round: 'also-bad' }));
    appendFixtureEvent(target, 'T-078', {
      eventType: 'review.result', role: 'unknown', summary: 'No data', outcome: 'accepted',
    });
    const report = reportTaskEventLog({ target, taskId: 'T-078' });
    // The first result precedes any invocation (1 gap); the later invocation
    // backs the second result (round values unreadable -> compatible).
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 1);
    assert.equal(report.provenanceQuality.reviewResultNonMaintainer, 1);
  });

  it('does not count a non-maintainer historical review.result as an unbacked maintainer review', () => {
    const target = makeTarget('backing-non-maintainer');
    appendFixtureEvent(target, 'T-079', {
      eventType: 'review.result', role: 'engineer', summary: 'Malformed historical result', outcome: 'accepted',
      data: { review_round: 1, review_mode: 'host_subagent' },
    });
    const report = reportTaskEventLog({ target, taskId: 'T-079' });
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 0);
    assert.equal(report.provenanceQuality.reviewResultNonMaintainer, 1);

    const aggregate = reportEventLogs({ target });
    assert.equal(aggregate.provenanceQuality.reviewResultNonMaintainer.count, 1);
    assert.deepEqual(aggregate.provenanceQuality.reviewResultNonMaintainer.tasks, ['T-079']);
  });
});

describe('historical fallback boolean classification uses strict type semantics', () => {
  const cases = [
    { name: 'boolean true', fallback: true, missing: 0 },
    { name: 'boolean false', fallback: false, missing: 0 },
    { name: 'missing field', fallback: undefined, missing: 1 },
    { name: 'null', fallback: null, missing: 1 },
    { name: 'string "true"', fallback: 'true', missing: 1 },
    { name: 'string "false"', fallback: 'false', missing: 1 },
    { name: 'number 1', fallback: 1, missing: 1 },
    { name: 'array', fallback: [true], missing: 1 },
    { name: 'object', fallback: { value: true }, missing: 1 },
  ];

  for (const { name, fallback, missing } of cases) {
    it(`counts ${name} as ${missing === 1 ? 'missing/non-boolean' : 'a valid boolean'}`, () => {
      const target = makeTarget(`fallback-type-${name.replace(/[^a-z0-9]+/gi, '-')}`);
      const data = { target_role: 'engineer', delegation_mode: 'host_subagent' };
      if (fallback !== undefined) data.fallback = fallback;
      appendFixtureEvent(target, 'T-080', {
        eventType: 'role.invoked', role: 'orchestrator', summary: 'Historical delegation', data,
      });
      const report = reportTaskEventLog({ target, taskId: 'T-080' });
      assert.equal(report.provenanceQuality.roleInvokedMissingFallback, missing);
    });
  }

  it('historical string booleans are reported, and the log remains readable', () => {
    const target = makeTarget('fallback-string-readable');
    appendFixtureEvent(target, 'T-081', {
      eventType: 'role.invoked', role: 'orchestrator', summary: 'Legacy string boolean',
      data: { target_role: 'engineer', delegation_mode: 'host_subagent', fallback: 'true' },
    });
    const report = reportTaskEventLog({ target, taskId: 'T-081' });
    assert.equal(report.eventCount, 1);
    assert.equal(report.provenanceQuality.roleInvokedMissingFallback, 1);
  });
});

describe('Maintainer Review Fixup telemetry', () => {
  it('counts fixup episodes and affected tasks in report --features', () => {
    const target = makeTarget('fixup-features');
    appendFixtureEvent(target, 'T-060', {
      eventType: 'review.result', role: 'maintainer', summary: 'Accepted after fixup', outcome: 'accepted',
      data: { review_round: 1, review_mode: 'single_agent_fallback', maintainer_fixup: true },
    });
    // A second task with two fixup episodes (durable but unusual; telemetry flags it).
    appendFixtureEvent(target, 'T-061', {
      eventType: 'review.result', role: 'maintainer', summary: 'Fixup A', outcome: 'accepted',
      data: { review_round: 1, review_mode: 'single_agent_fallback', maintainer_fixup: true },
    });
    appendFixtureEvent(target, 'T-061', {
      eventType: 'review.result', role: 'maintainer', summary: 'Fixup B', outcome: 'accepted',
      data: { review_round: 2, review_mode: 'single_agent_fallback', maintainer_fixup: true },
    });

    const { features } = reportEventLogs({ target });
    assert.equal(features.maintainerFixup.episodeCount, 3);
    assert.deepEqual(features.maintainerFixup.tasksWithFixup, ['T-060', 'T-061']);
    assert.deepEqual(features.maintainerFixup.tasksWithMultipleFixups, ['T-061']);
  });

  it('a fallback review mode without maintainer_fixup is not counted as a fixup', () => {
    const target = makeTarget('fixup-not-a-fixup');
    appendFixtureEvent(target, 'T-062', {
      eventType: 'review.result', role: 'maintainer', summary: 'Same-session accept', outcome: 'accepted',
      data: { review_round: 1, review_mode: 'single_agent_fallback' },
    });
    const { features } = reportEventLogs({ target });
    assert.equal(features.maintainerFixup.episodeCount, 0);
    assert.deepEqual(features.maintainerFixup.tasksWithFixup, []);
  });
});

describe('PR-129 regression sequence (delegated re-review, no spurious fallback)', () => {
  // Synthetic fixture; no external PR or network.
  it('round 2 re-delegates through host_subagent and does not record single_agent_fallback', () => {
    const target = makeTarget('pr129-delegated');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });
    // Round 1 delegated through host_subagent.
    appendFixtureEvent(target, 'PR-129', {
      backend: 'github', eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated round-1 review',
      refs: ['github:pr:129'], data: { target_role: 'maintainer', delegation_mode: 'host_subagent', fallback: false },
    });
    appendFixtureEvent(target, 'PR-129', {
      backend: 'github', eventType: 'review.result', role: 'maintainer', summary: 'Round 1 needs revision', outcome: 'needs_revision',
      refs: ['github:pr:129'], data: { review_round: 1, review_mode: 'host_subagent' },
    });
    // Engineer revision.
    appendFixtureEvent(target, 'PR-129', {
      backend: 'github', eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated revision',
      refs: ['github:pr:129'], data: { target_role: 'engineer', delegation_mode: 'host_subagent', fallback: false },
    });
    // Host subagent remains available; round 2 delegates to a host subagent again.
    appendFixtureEvent(target, 'PR-129', {
      backend: 'github', eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated round-2 review',
      refs: ['github:pr:129'], data: { target_role: 'maintainer', delegation_mode: 'host_subagent', fallback: false },
    });
    appendFixtureEvent(target, 'PR-129', {
      backend: 'github', eventType: 'review.result', role: 'maintainer', summary: 'Round 2 accepted', outcome: 'accepted',
      refs: ['github:pr:129'], data: { review_round: 2, review_mode: 'host_subagent' },
    });

    const report = reportTaskEventLog({ target, taskId: 'PR-129' });
    assert.deepEqual(report.roleInvoked.delegationModeCounts, [{ value: 'host_subagent', count: 3 }]);
    assert.equal(report.roleInvoked.fallbackCount, 0);
    // Every round is backed by a delegation; no telemetry gaps.
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 0);
    assert.equal(report.provenanceQuality.roleInvokedInconsistentModeFallback, 0);

    // A new round-2 role.invoked recording single_agent_fallback only because it
    // is a re-review is rejected by the producer path.
    const spurious = validateNewEvent(buildEvent({
      task: 'PR-129', eventType: 'role.invoked', role: 'orchestrator', summary: 'Round-2 re-review',
      data: { target_role: 'maintainer', delegation_mode: 'single_agent_fallback', fallback: true, reason: 'Round-2 re-review requested' },
    }));
    assert.ok(spurious.errors.some(e => e.includes('fallback_cause')));
  });

  it('a direct-human continuation variant uses same-session review provenance without a delegation claim', () => {
    const target = makeTarget('pr129-continuation');
    writeProjectMap(target, { eventLogging: 'enabled', taskBackend: 'github' });
    // Round 1 delegated through host_subagent.
    appendFixtureEvent(target, 'PR-129B', {
      backend: 'github', eventType: 'role.invoked', role: 'orchestrator', summary: 'Delegated round-1 review',
      refs: ['github:pr:129'], data: { target_role: 'maintainer', delegation_mode: 'host_subagent', fallback: false },
    });
    appendFixtureEvent(target, 'PR-129B', {
      backend: 'github', eventType: 'review.result', role: 'maintainer', summary: 'Round 1 needs revision', outcome: 'needs_revision',
      refs: ['github:pr:129'], data: { review_round: 1, review_mode: 'host_subagent' },
    });
    // Human directly continues the active maintainer session for round 2: no new
    // role.invoked, a continuation_reason, and same-session review mode.
    appendFixtureEvent(target, 'PR-129B', {
      backend: 'github', eventType: 'review.result', role: 'maintainer', summary: 'Round 2 accepted (continued)', outcome: 'accepted',
      refs: ['github:pr:129'],
      data: { review_round: 2, review_mode: 'single_agent_fallback', continuation_reason: 'human continued the active maintainer review session' },
    });

    const report = reportTaskEventLog({ target, taskId: 'PR-129B' });
    // Exactly one role.invoked (round 1), no fallback delegation recorded.
    assert.equal(report.roleInvoked.total, 1);
    assert.equal(report.roleInvoked.fallbackCount, 0);
    // The continuation review does not read as an unbacked round.
    assert.equal(report.provenanceQuality.reviewRoundsWithoutBacking, 0);
  });
});

describe('run-scoped supervision control-plane events', () => {
  it('keeps ordinary task events unchanged and validates the run-scoped extension', () => {
    const target = makeTarget('run-scope');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');

    const taskEvent = buildEvent({ target, task: 'T-001', host: 'opencode', role: 'controller', eventType: 'supervision.registered', summary: 'lane registered', outcome: 'success' });
    assert.equal('scope' in taskEvent, false, 'task events keep their historical shape');
    assert.equal('run_id' in taskEvent, false);
    assert.deepEqual(validateEvent(taskEvent, { target }).errors, []);

    const runEvent = buildEvent({ target, scope: 'run', run_id: 'sup-run-1', host: 'opencode', role: 'controller', eventType: 'supervision.terminated', summary: 'controller stopped', outcome: 'success' });
    assert.equal(runEvent.scope, 'run');
    assert.equal(runEvent.run_id, 'sup-run-1');
    assert.equal(runEvent.task_id, null);
    assert.deepEqual(validateEvent(runEvent, { target }).errors, []);
    assert.ok(VALID_EVENT_SCOPES.has('run'));
  });

  it('rejects a malformed or unapproved run-scoped event', () => {
    const target = makeTarget('run-scope-invalid');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');
    const base = { target, scope: 'run', run_id: 'sup-run-1', host: 'opencode', role: 'controller', eventType: 'supervision.terminated', summary: 'stopped', outcome: 'success' };

    assert.ok(validateEvent({ ...buildEvent(base), run_id: '' }, { target }).errors.some(error => error.includes('run_id')));
    assert.ok(validateEvent({ ...buildEvent(base), task_id: 'T-001' }, { target }).errors.some(error => error.includes('must not carry a task_id')));
    assert.ok(validateEvent({ ...buildEvent(base), event_type: 'task.closed' }, { target }).errors.some(error => error.includes('approved control-plane event_type')));
    assert.ok(validateEvent({ ...buildEvent(base), role: 'engineer' }, { target }).errors.some(error => error.includes('controller, supervisor, or operator provenance')));
    assert.ok(validateEvent({ ...buildEvent(base), scope: 'workspace' }, { target }).errors.some(error => error.includes('scope must be one of')));
    const taskScoped = buildEvent({ target, task: 'T-001', host: 'opencode', role: 'controller', eventType: 'supervision.registered', summary: 's', outcome: 'success' });
    assert.ok(validateEvent({ ...taskScoped, run_id: 'sup-run-1' }, { target }).errors.some(error => error.includes('only supported on run-scoped events')));
    assert.ok(RUN_SCOPED_EVENT_TYPES.has('supervision.root_replaced'));
  });

  it('appends and validates a run-scoped log alongside task logs', () => {
    const target = makeTarget('run-scope-append');
    writeProjectMap(target, { eventLogging: 'enabled' });
    writeTaskRecord(target, 'T-001');
    const runLogPath = join(target, '.agenticloop', 'logs', SUPERVISION_LOG_SUBDIR, 'sup-run-1.jsonl');

    appendEventLog({
      target,
      path: runLogPath,
      event: buildEvent({ target, scope: 'run', run_id: 'sup-run-1', host: 'opencode', role: 'controller', eventType: 'supervision.registered', summary: 'root registered', outcome: 'success' }),
    });
    appendEventLog({
      target,
      event: buildEvent({ target, task: 'T-001', host: 'opencode', role: 'controller', eventType: 'supervision.reconciled', summary: 'artifact verified', outcome: 'success' }),
    });

    assert.deepEqual(validateEventLogFile(runLogPath, { target }).errors, []);
    assert.equal(loadEvents(runLogPath).length, 1);
    const aggregate = validateEventLogs(target);
    assert.deepEqual(aggregate.errors, []);
    assert.equal(aggregate.fileCount, 2, 'validation covers both the task log and the run-scoped supervision log');
    assert.ok(aggregate.files.some(file => file.includes(SUPERVISION_LOG_SUBDIR)));
  });

  it('refuses to append a run-scoped event that fails producer validation', () => {
    const target = makeTarget('run-scope-refuse');
    writeProjectMap(target, { eventLogging: 'enabled' });
    const runLogPath = join(target, '.agenticloop', 'logs', SUPERVISION_LOG_SUBDIR, 'sup-run-2.jsonl');
    assert.throws(
      () => appendEventLog({
        target,
        path: runLogPath,
        event: buildEvent({ target, scope: 'run', run_id: 'sup-run-2', host: 'opencode', role: 'engineer', eventType: 'supervision.terminated', summary: 'stopped', outcome: 'success' }),
      }),
      /Refusing to append invalid event/
    );
    assert.equal(existsSync(runLogPath), false);
  });
});
