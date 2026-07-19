# Event Logging

Agentic Loop can record compact JSONL workflow-gate events for local audit and
summary generation. Event logging is **disabled by default**.

## Enabling

Enable it in `.agenticloop/project.md`:

```yaml
event_logging: enabled
```

`event_logging_command` can stay blank; agents test `npx agenticloop --help`
once when logging is enabled.

## Commands

```text
npx agenticloop event-logging <event> [options]      Append/validate/audit/report workflow-gate events
```

Writes require `--task` and `--summary`. `validate`, `audit`, and `report`
inspect existing logs without writing.

## What events contain

Event logs are local JSONL files under `.agenticloop/logs/`. They should
contain short workflow-gate summaries only -- never raw prompts, raw assistant
messages, token streams, terminal dumps, secrets, or host telemetry.

## Relationship to completion summaries

Per-task completion summaries are always written inline into
`.agenticloop/tasks/<TASK-ID>.md` (the `## Scope Completed` section),
regardless of whether event logging is enabled. There is no separate
`.agenticloop/summaries/` directory; closeout is a verify-and-mark gate that
confirms those inline summaries and posts a status marker.
