---
name: task-closeout
description: Use when every task in a configured group is accepted and integrated or closed according to the configured backend, or when a human-identified work unit finishes in a flat project. Defines what closeout inspects, when it runs, the durable status marker it posts, and the human approval gate for grouped projects. Closeout is a verify-and-mark gate; it does not write a separate summary file.
metadata:
  area: task-closeout
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: none
---

# Task closeout

Closeout confirms that the relevant task set is actually complete, records
durable evidence, and turns repeated process friction into follow-up work or
skill improvements.

Run closeout:

- for each configured group when `.agenticloop/project.md` says `group_closeout: true`, or
- when a human-identified task set or work unit finishes, including in flat projects.

Closeout is a verify-and-mark gate. It does not produce a separate summary
artifact. The durable record is the per-task inline summary plus the backend
(task files or GitHub issues/PRs); closeout confirms that record is complete and
posts a status marker.

Every accepted or closed task must have a filled inline task summary in the task
record using the work-unit summary section shape with `summary_unit: task`. For
files backend this is the `## Scope Completed` and related sections inside
`.agenticloop/tasks/<TASK-ID>.md`. There is no separate `.agenticloop/summaries/`
directory.

## Inspect

Review:

- all relevant task records,
- all pull requests or implementation artifacts,
- for GitHub-backed normal implementation tasks, the task issue state and the
  merged PR closing relationship,
- acceptance criteria and required checks,
- known limitations and follow-up recommendations,
- documentation changes,
- blocked or needs_context events from [[blocked-state]],
- repeated review failures,
- optional local event log entries emitted at workflow gates when event logging is enabled.

Do not copy raw agent exchanges into docs. Use task records, implementation artifacts, command output, and reviewed comments as sources of truth.

### GitHub issue closure check

For GitHub-backed normal implementation tasks, closeout is incomplete until each
task issue is actually closed. A merged pull request, local `task.closed` event,
or issue mention in the PR body is not enough by itself.

Verify the state with GitHub data, for example:

```text
gh pr view <pr> --json number,mergedAt,closingIssuesReferences
gh issue view <issue> --json number,state,closedByPullRequestsReferences
```

If a PR was merged without closing the issue, close the issue with a comment
linking the merged PR and record the missing closing-keyword process gap in the
closeout marker note. If the issue cannot be corrected, use `AGENT_CLOSEOUT_STATUS:
follow_up_required`.

## Closeout marker

Post or record exactly one status marker:

```text
AGENT_CLOSEOUT_STATUS: complete
AGENT_CLOSEOUT_STATUS: follow_up_required
```

If gaps remain, create or link follow-up task records and use `follow_up_required` until they are resolved or explicitly deferred by a human.

If the work unit spans multiple task records, record the marker once for the
work unit, citing the task ids it covers.

**GitHub projection**: post the marker as a comment on the last task issue or PR
in the work unit (or on the tracking issue when one exists), citing the covered
task ids. End with [[github-attribution]].

**Files projection**: append the marker and a dated note to the last accepted
task record in the work unit (under `## Comments`), citing the covered task ids.

## Event Logging

If `.agenticloop/project.md` has `event_logging: enabled`, resolve the event
logging command before writing the event: use a non-empty
`event_logging_command`, or run `npx agenticloop --help` once and use
`npx agenticloop` only if it succeeds. Do not attempt event logging when
`event_logging` is disabled, and do not block the workflow if no working
command is available.

The local `.agenticloop/logs/<TASK-ID>.jsonl` event logs are default input for
the optional `## Trace` section of `agenticloop/memory/work-unit-summary.md`
when workflow-gate events exist. Use them to confirm sequence, checks,
decisions, and blockers.

Do not copy raw transcripts, host runtime dumps, or full tool output into the task record.

## Group gate

When the project uses grouping, the next configured group does not begin until a
human explicitly approves it.

## See also

Turning recurring process friction into durable improvements is a separate,
optional, human-invoked step. It is not part of this gate; see [[loop-retrospective]].
