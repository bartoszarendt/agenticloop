---
name: event-logging
description: Use when a role needs to emit an Agentic Loop workflow-gate event (role.invoked, task.created, task.started, check.run, review.started, review.result, decision.recorded, blocked, needs_context, task.closed, summary.published) and must resolve the event logging command, write concise event entries, or confirm that event logging is disabled or unavailable. Owns the command-resolution recipe, the disabled/non-blocking rules, and the event data conventions.
metadata:
  area: event-logging
  side_effects: writes-files
  credentials: none
  runs_scripts: optional
---

# Event logging

Event logging is optional and disabled by default. It writes local
workflow-gate events to `.agenticloop/logs/<TASK-ID>.jsonl` through the Node CLI.
`agenticloop/AGENTIC_LOOP.md` owns why event logging exists, the event taxonomy,
and which lifecycle gates emit which events. This skill owns the operational
procedure: resolving the command, honoring the disabled and non-blocking rules,
and keeping entries concise.

## When event logging is off

Read `.agenticloop/project.md` before writing any event. Agents must not attempt
CLI event logging unless it says `event_logging: enabled`. When event logging is
disabled, do nothing: writing events is a no-op, and skipping them is not a
process gap.

## Resolving the command

When `event_logging: enabled`, resolve the event logging command once per host
session before the first event write:

1. If `event_logging_command` is non-empty, use that command.
2. If `event_logging_command` is blank or omitted, run `npx agenticloop --help`
   once. If it succeeds, use `npx agenticloop`.
3. If no working event logging command is available, do not repeatedly retry and
   do not block the workflow. Record a truthful process gap in the task record,
   review, or closeout marker note, then continue.

After resolution, event writes use:

```text
<resolved-command> event-logging <event_type> --task <TASK-ID> --role <role> --summary "<short fact>"
```

`agenticloop event` remains a compatibility alias, but new instructions should
use `event-logging`. Default writes target `.agenticloop/logs/<TASK-ID>.jsonl`
via `--task <TASK-ID>`; use `--output <file>` only for tests or an explicit local
exception. Add `--outcome` only for event types that require it.

Unavailable logging is always non-blocking: never fail, pause, or loop a task
because event logging could not run.

## Required and recommended fields

Every event needs `--task <TASK-ID>` (when a task is known), `--role`, and a
short `--summary`. Events in the same target that share a `task_id` derive the
same deterministic `trace_id` unless `--trace-id` is supplied. Use `refs` for
identifiers (`github:issue:<n>`, `github:pr:<n>`, `commit:<sha>`, `branch:<name>`,
`task-file:<path>`, `command:<command>`) and `--data-json` for small structured
context.

When event logging is enabled, a completed or reviewed task ending with zero
required gate events is non-conformant. Do not backfill missed events as if they
happened on time; record the miss as a process gap instead.

## Keep entries small

Entries are summaries, not transcripts. Do not write raw prompts, raw assistant
text, full tool output, transcript payloads, token streams, per-turn telemetry,
or host runtime exports. Keep `data` small, structured, and non-transcript.
Command evidence belongs in the durable task artifact, not the event log; the
event carries concise verdict facts and references only.

## Command safety

When an event summary or data value contains Markdown or shell-significant
characters, avoid inlining it through fragile shell quoting. Prefer the safe
payload mechanism named by the backend or delegation prompt, keep scratch under
`.agenticloop/tmp/`, and use relative forward-slash paths.
