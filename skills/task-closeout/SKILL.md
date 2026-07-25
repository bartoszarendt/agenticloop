---
name: task-closeout
description: Use when preparing pre-certification closeout once covered tasks are accepted, running the final closeout gate once the resulting candidate is integrated or frozen and certified, finishing a human-identified work unit in a flat project, or cleaning up an accepted worktree after integration. Defines conditional source-plan synchronization, what final closeout inspects, the durable status marker it posts, the work-unit certification gate, and the human approval gate for grouped projects. Final closeout is a verify-and-mark gate; it does not write a separate summary file.
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

If the remaining request is cleanup of an accepted, integrated worktree, follow
the worktree cleanup lifecycle and human checkpoint in
`agenticloop/AGENTIC_LOOP.md`.
Cleanup does not replace closeout evidence or reopen accepted implementation.

Run closeout:

- for each configured group when `.agenticloop/project.md` says `group_closeout: true`, or
- when a human-identified task set or work unit finishes, including in flat projects.

Closeout has two ordered parts. **Closeout preparation** may begin once covered
tasks are accepted; it performs only the conditional source-plan synchronization
below so that any permitted plan edit can be included in the final candidate.
The **final closeout gate** runs after that resulting candidate is integrated or
frozen and, when enabled, certified. It is a verify-and-mark gate and does not
produce a separate summary artifact. The durable record is the per-task inline
summary plus the backend (task files or GitHub issues/PRs); final closeout
confirms that record is complete and posts a status marker.

### Conditional source-plan progress synchronization

This section is the canonical procedure for source-plan progress synchronization
during closeout preparation. It is deliberately conditional: closing a task does
not authorize inventing a plan status convention or rewriting a target-owned
plan.

1. Resolve `documents.plan` from `.agenticloop/project.md`. If no selected plan
   exists, record no plan mutation and continue closeout normally.
2. Read only the selected plan's explicit instructions for maintaining progress
   or status, plus the task/work-unit source references that could map the
   completed work to one plan entry. Do not infer instructions from a plan's
   heading shape, prose tone, or unrelated checklist.
3. Mutate the plan only when its explicit instructions define the allowed
   progress/status update, one relevant entry maps unambiguously to the closing
   work unit, and repository rules allow the mutation. Never invent a checkbox,
   percentage, status vocabulary, completion convention, or plan structure.
4. Route this narrow plan edit to the single-writer Maintainer/closeout lane,
   never an Engineer implementation lane. Preserve unrelated target-owned plan
   content. If the requested state is already correct, make no rewrite.
5. Record the plan path, affected section or item, previous state, new state,
   and covered task IDs in the closeout evidence or note. This evidence makes a
   rerun idempotent: it must neither duplicate the entry nor reapply an already
   correct state.

If a plan explicitly requires progress maintenance but mapping, authority, or the
write itself is ambiguous, prohibited, or fails, do not publish
`AGENT_CLOSEOUT_STATUS: complete`. Use `follow_up_required`, `needs_context`, or
`blocked` according to the existing routing rules. A selected plan with no
explicit progress-update instruction is not a closeout failure and receives no
invented mutation.

#### Certification ordering

A plan edit changes the candidate artifact. Complete the permitted plan update
and integrate it before the final candidate freeze. Then bind or refresh the
audit baseline to that exact resulting artifact, run the final Auditor gate, and
publish the closeout marker only after the certificate is current. Never edit a
repository plan after certification without refreshing the candidate baseline and
certification; the earlier exact-artifact certificate is stale.

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
- canonical current final-state evidence plus any exceptional append-only
  verification-attempt history and final maintainer triage for every timed-out
  attempt,
- proof pressure fields when present and the evidence that satisfies them,
- known limitations and follow-up recommendations,
- documentation changes,
- blocked or needs_context events from [[blocked-state]],
- repeated review failures,
- optional local event log entries emitted at workflow gates when event logging is enabled.

When closing a task, the maintainer may fill the optional `## Outcome` section
with the structured fields; it is not required for routine clean tasks. The
`## Outcome` section becomes conditionally required at closeout when any of
these happened: review_rounds > 1, failed or triaged checks,
blocked/needs_context state, scope drift, stale evidence, human intervention,
predicted medium/high context overflow risk, context pressure encountered, or
follow-ups. Include `context_pressure_encountered: true|false` when the task had
medium/high context overflow risk or actually hit context pressure. The
`review_result` field in `## Outcome` is the final closeout classification for
the task record, distinct from the per-review `review.result` field used in
event-log entries.

If the task's first full Lens 2/Lens 3 assessment occurred only after its review
budget was reached or exceeded, include that timing as a calibration observation
when useful. It is not a closeout gate or required field.

Do not copy raw agent exchanges into docs. Use task records, implementation artifacts, command output, and reviewed comments as sources of truth.

An exceptional verification episode that does not end in a pass or final
non-blocker maintainer triage blocks closeout completion. Keep the marker at
`follow_up_required`, or retain a blocked state, until the maintainer records a
resolving pass or final non-blocker triage under [[verification-evidence]].

Do not require a routine successful final-head attempt entry when canonical
current evidence is complete. Preserve old exceptional attempts on their actual
artifacts, and ensure no active retry, unresolved blocker, or pending timeout
triage is hidden before closeout.

For every recorded check episode, verify that its latest attempt passed or has
final non-blocker maintainer triage. A latest failed, blocked, or timed-out
attempt without final triage, or any latest attempt triaged as a blocker, blocks
closeout.

### GitHub acceptance verification

For a GitHub-backed group or work unit, verify that every included implementation
pull request was accepted before publishing the closeout marker. When GitHub is
available, run the read-only composite gate against each final PR:

```text
npx agenticloop github-ready --pr <number>
```

See the Pre-Merge Readiness Gate in `agenticloop/backends/github.md`. A missing
acceptance or a current `needs_revision` result blocks `AGENT_CLOSEOUT_STATUS:
complete`; use `follow_up_required` until it is resolved.

When event logging is enabled, run the existing strict event audit
(`npx agenticloop event-logging audit --task <id>`) for each task, or record a
truthful missed-event process gap in the closeout note. Never fabricate missing
historical events to make an audit pass.

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

### Work-unit certification gate

Work-unit audit is enabled by default. Unless `.agenticloop/project.md` explicitly
records `work_unit_audit: disabled`, closeout cannot publish
`AGENT_CLOSEOUT_STATUS: complete` without a current audit certificate for the
exact work unit. Enforce it with:

```text
npx agenticloop audit gate <work-unit-or-audit-id>
```

Complete requires exactly one current audit record whose `audit_state` is
`certified`, whose `latest_verdict` is `certified` or
`certified_with_accepted_limitations`, whose `certified_artifact` and
`certified_covered_tasks` still match the candidate baseline, whose last
completed run is bound to that same artifact, task set, and verdict, with no
unresolved blocking finding and typed human or existing accepted-decision
authority for every accepted limitation. The entire record must validate. A
stale, invalid, missing, awaiting-human, blocked, or non-certifying audit keeps
the marker at
`follow_up_required`. The full gate, budget, and remediation routing are owned by
[[work-unit-audit]].

When `work_unit_audit: disabled` is explicitly recorded, bypass this gate,
preserve any existing audit history, do not claim the work unit is certified, and
state the opt-out visibly in the closeout note.

## Closeout marker

Post or record exactly one status marker:

```text
AGENT_CLOSEOUT_STATUS: complete
AGENT_CLOSEOUT_STATUS: follow_up_required
```

If gaps remain, create or link follow-up task records and use `follow_up_required` until they are resolved or explicitly deferred by a human.

The complete marker's evidence/note includes the conditional plan-sync record
when a plan was selected and updated. Do not publish it until the post-sync audit
certificate is current.

If the work unit spans multiple task records, record the marker once for the
work unit, citing the task ids it covers.

**GitHub projection**: post the marker as a comment on the last task issue or PR
in the work unit (or on the tracking issue when one exists), citing the covered
task ids. End with [[github-attribution]].

**Files projection**: append the marker and a dated note to the last accepted
task record in the work unit (under `## Comments`), citing the covered task ids.

## Event Logging

Event logging is optional and off by default. When `event_logging: enabled`,
resolve the command and honor the disabled/non-blocking rules in
[[event-logging]] before writing events.

The local `.agenticloop/logs/<TASK-ID>.jsonl` event logs are default input for
the optional `## Trace` section of `agenticloop/memory/work-unit-summary.md`
when workflow-gate events exist. Use them to confirm sequence, checks,
decisions, and blockers.

### Feature-adoption telemetry (closeout)

When event logging is enabled and the task carried feature telemetry (see the
feature-adoption telemetry guidance in `agenticloop/agents/maintainer.md`),
mirror the closeout calibration fields into the `task.closed` event `data` so adoption stays
auditable from logs without reading the backend. The durable record is still the
`## Outcome` section of the task record; these are a log-native copy, not a
replacement.

Add to `task.closed --data-json`:

- `feature_telemetry_version: 1`
- `review_rounds`: the final closeout review-round count.
- the task's materialized `review_budget` when present. The feature report
  classifies it as an override only when it differs from the effective project
  or built-in review policy.
- `review_budget_exceeded: true|false` when the review budget was reached or
  exceeded.
- `context_overflow_risk` when it was set on the task, and
  `context_pressure_encountered: true|false` whenever context risk was set or
  pressure actually occurred.

Keep these to scalar verdicts. `agenticloop event-logging report --features`
derives review-round churn from existing `review.result` events even when this
telemetry is absent, and warns for a context-risk task whose closeout omits
`context_pressure_encountered`.

Do not copy raw transcripts, host runtime dumps, or full tool output into the task record.

## Group gate

When the project uses grouping, the next configured group does not begin until a
human explicitly approves it.

## See also

Turning recurring process friction into durable improvements is a separate,
optional, human-invoked step. It is not part of this gate; see [[loop-retrospective]].
