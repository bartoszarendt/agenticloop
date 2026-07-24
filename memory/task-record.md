---
task_id: T-001
status: agent-ready
backend: files
implementation_artifact:
review_status:
reviewed_artifact:
review_mode:
# reviewed_artifact: exact value copied from implementation_artifact for the
# current review outcome. Required whenever review_status is set.
# review_mode: see [[review-and-accept]].
# independent_review_required: set true before implementation when final
# acceptance must not use same-session single_agent_fallback (security or
# authorization boundaries; secrets, credentials, or permissions; destructive or
# irreversible data operations; production or release controls; public API or
# schema migrations; or any project policy requiring independent review).
# independent_review_required: true
# human_review_ref: recorded reference required when review_mode is
# independent_human; files validation checks presence only. The GitHub audit
# verifies the referenced review is approved, on the current head, and by a
# different human account.
# human_review_ref:
# Minimalism discipline: none | lite | full | ultra.
# Omitted or none means no task-record-selected Ponytail.
# lite/full activate Ponytail for maintainer/engineer roles.
# Maintainer auto-selection may choose at most full.
# ultra requires explicit human request.
minimalism: none
# Effort bounds: process ceilings, not scope reducers. Omit to keep defaults.
# attempt_budget tunes the default-3 equivalent-attempt guard; review_budget is
# the needs_revision round count allowed before the churn checkpoint. Lower them
# to save effort on cheap/low-risk tasks; raising above the default needs a
# concrete reason. They never loosen the deliberately-tighter no-progress guards.
attempt_budget: 3
review_budget: 3
# Context overflow risk: stored values are medium | high. Omit for ordinary
# low-risk tasks; do not write "low". Add context_note only when medium/high
# changes delegation or stop behavior.
# context_overflow_risk:
# context_note:
# Structured scope map: repo-relative glob patterns for mechanical changed-file
# validation. Examples: ["src/example.js", "test/example.test.js", "docs/"].
# Leave empty or omit to rely on the human-readable `## Expected Files or Areas`
# section and reviewer enforcement through `## Deviations From Plan`.
allowed_paths: []
---

# T-001 - Short Task Title

## Task
State the exact outcome the engineer must produce.

## Source Documents Reviewed
- `AGENTS.md` - repository rules
- `README.md` - target overview
- selected task-source docs when the project has them (e.g. `IMPLEMENTATION_PLAN.md`, a spec, or a design doc)

## Current State
Describe the starting behavior, constraints, and known gaps.

## Scope
List the required changes.

## Out of Scope
Name nearby work that must not be bundled into this task.

## Acceptance Criteria
- One observable outcome per bullet.

## Required Checks
- [RC-1] Exact command the engineer must run on the final state.
- [RC-2] Additional command or specific manual check when independently required.

Use one stable `[RC-N]` id per bullet. Include linked verification decisions
when a check has a known non-obvious execution strategy.

## Verification Attempts

No verification attempts are currently recorded.

## Proof Pressure

Optional. Maintainer may require this section for ambiguous or long-running work.
If present, each field must be concrete.

- **Completion Oracle**: standing observable signal used during work to keep the
  task aligned with the owner's outcome.
- **Final Proof Required**: evidence required before closeout/review can claim
  completion.
- **Likely Misfire**: how the agent could satisfy local criteria while missing
  the owner's real intent.

## Expected Files or Areas
- Name the files, modules, commands, docs, and tests likely to change.

## Implementation Notes
- Record important constraints, sequencing, or migration notes.
- For nontrivial or churn-prone work, the maintainer may include an optional
  numbered, file-level stepped plan here (`N. <action> -- file: <path>`). The
  engineer treats this plan as a strong prior, verifies assumptions, and records
  any divergence under `## Deviations From Plan` (or returns `needs_context` via
  `blocked-state`) instead of following stale steps. One-line or obvious fixes
  should omit the plan.
- Keep the plan DRY: reference `## Expected Files or Areas`, `## Required Checks`,
  and `## Proof Pressure` for files, checks, and escalation signals; do not
  restate them.

## Concurrency Plan
Required for the current Parallel Opportunity Scan of every authorized multi-task
work unit. Keep one scan in the task-record or coordination surface rather than
duplicating it into every task. With fewer than two ready tasks, record `Decision:
not currently eligible - <n> ready task(s)` and its rescan trigger. With two or
more ready tasks, record:

### Parallel Opportunity Scan

- Work unit:
- Ready-set snapshot:
- Source proposals considered:
- Configured maximum implementation lanes:
- Candidate lanes:
- Mutation independence:
- Knowledge independence:
- Decision scope:
- Shared design questions:
- Backend/worktree ownership:
- Host and liveness capability:
- Verification/integration implications:
- Decision: parallel <lane ids> | serial | not currently eligible
- Independent rationale:
- Rescan trigger:

When parallel delegation is authorized, also name each lane id, lane type (read-only,
implementation, or coordination/review), role, read/write mode, owned backend
objects, worktree path and branch for file-mutating write lanes, implementation
or workflow artifact, allowed files or areas, shared collision risks (including
shared generated files, lockfiles, schemas, APIs, external state, labels,
comments, status markers, closeout state, event logs, and group state), and
test/fixture/snapshot/shared-helper ownership. Also record:

- the knowledge-coupling classification (`independent | coupled | unknown`)
  for each lane pair, and the two-wave pattern when any pair is coupled;
- the checkpoint and join finding-routing procedure: cross-lane findings are
  declared at each lease checkpoint and final return (or `Cross-lane findings:
  none`), the orchestrator routes relevant findings, and each recipient records
  one disposition (`applied`, `already satisfied`, `rejected` with evidence, or
  `deferred` with a reason);
- the verification topology for every planned check: stable check id, exact
  command, purpose, owner, target artifact revision or tree, relevant
  environment/toolchain assumptions, execution phase (`baseline`, `lane-final`,
  `integrated`, `post-merge`), reuse eligibility, and rerun trigger;
- the integration-rehearsal trigger and owner when combined-state proof is
  required, or the recorded reason it is omitted;
- the intended artifact composition order;
- the rerun/invalidation trigger that makes earlier integrated or rehearsal
  evidence stale;
- lease checkpoint cadence, stop condition, and join condition. The join
  condition covers finding dispositions and required integrated evidence before
  durable review outcome, acceptance, merge, or closeout.

## Parallel Safety

Required when the task belongs to an authorized multi-task work unit, so the
orchestrator's Parallel Opportunity Scan can classify the task. It complements
`## Expected Files or Areas` and `allowed_paths`; it does not replace them.

- Owned paths:
- Shared or generated files:
- Test/fixture/snapshot/shared-helper surfaces:
- Schema/API/lockfile risk:
- Backend objects owned:
- Dependency edges:
- Decision scope:
- Shared design questions:
- Shared assumptions/invariants:
- Discoveries that could affect other tasks:
- Parallel eligibility: eligible | blocked | unknown
- Knowledge coupling: independent | coupled | unknown
- Reason:

`Parallel eligibility` is the mutation-collision verdict. `Knowledge coupling`
is the separate knowledge verdict: `independent` when no likely discovery in
one lane can invalidate a sibling lane's assumptions, plan, implementation, or
verification interpretation; `coupled` when shared assumptions mean the
two-wave pattern (parallel diagnosis, reconciliation, then serial or re-planned
implementation) applies; `unknown` when the maintainer cannot yet tell. Parallel
write execution requires `eligible` plus `independent`. Separate worktrees
never convert coupled or unknown tasks into independent tasks.

Shared design questions belong to the maintainer or a serial reconciliation step,
not two independent engineers. Resolve them before parallel implementation writes
or use the two-wave read-only diagnosis and reconciliation pattern. Disjoint
files do not imply independent design authority.

If code/collision eligibility or knowledge coupling is unknown and 2 or more
ready tasks could otherwise run in parallel, the maintainer resolves it with one
bounded read-only discovery pass before returning. If still unknown, state what
stayed unknown and recommend serial. Host/lane capability unknowns stay with
the orchestrator.

## Completion Summary Template

Use `agenticloop/memory/work-unit-summary.md` as the canonical section shape
(set `summary_unit: task` for a single task). Add task-specific expectations
here so the engineer knows what evidence to publish.

## Reviewer Checklist

- [ ] Task scope matches the source documents reviewed for this task.
- [ ] Unexpected files are justified in `## Deviations From Plan`.
- [ ] Required checks were rerun on the final state with fresh output.
- [ ] Every exceptional verification episode ends in a pass or final non-blocker
  maintainer triage; none remains failed, blocked, timed out, `pending`, or
  triaged as a blocker at acceptance.
- [ ] If `## Proof Pressure` is present, completion oracle, final proof, and likely misfire were checked.
- [ ] If `context_overflow_risk: medium|high` was set or context pressure was encountered, `## Outcome` records `context_pressure_encountered: true|false`.
- [ ] The durable task record includes the current implementation summary.
- [ ] The implementation artifact is linked to the task record.
- [ ] If parallel delegation was used, the concurrency plan was followed and the join condition was met.
- [ ] For every multi-task work unit, the current Parallel Opportunity Scan has a durable result and rescan trigger; source proposals were independently reassessed.
- [ ] If parallel delegation was used, the knowledge-coupling classification was recorded, and coupled work used the two-wave reconciliation before implementation continued.
- [ ] If cross-lane findings were routed, every routed finding has a recorded recipient disposition.
- [ ] Every deferred cross-lane finding was triaged as non-blocking and accepted/follow-up; otherwise it still blocks the join.
- [ ] If integrated evidence was required, it binds to the exact combined candidate (tree/commit, order, commands), and a changed final composition invalidated and reran stale rehearsal evidence.
- [ ] For GitHub-backed normal implementation tasks, the PR body includes `Closes #<issue-number>`.
- [ ] Known limitations are triaged as accepted, deferred, or follow-up work.
- [ ] No secrets, generated caches, or runtime artifacts were committed.

## Outcome

Optional for routine clean tasks. Conditionally required at closeout when any
of these happened: review_rounds > 1, failed or triaged checks,
blocked/needs_context state, scope drift, stale evidence, human intervention,
predicted medium/high context overflow risk, context pressure encountered, or
follow-ups.

Maintainer-filled at closeout. Records structured signal for later
loop-improvement pattern mining.

`review_result` here is the final closeout classification for the task record;
it is different from the per-review event-log field `review.result` emitted
during review events.

- **review_rounds**: integer count of review iterations.
- **review_result**: `accepted` | `accepted_with_followups` | `rejected`.
- **blocked**: `true` | `false`.
- **block_category**: one of the `blocked-state` categories, or `none`.
- **required_checks_all_passed**: `true` | `false`.
- **scope_drift_detected**: `true` | `false`.
- **stale_evidence_detected**: `true` | `false`.
- **human_intervention_required**: `true` | `false`.
- **context_pressure_encountered**: `true` | `false`.

## Comments

## Revision Log
Optional. Add dated entries when correcting previously published claims,
evidence, check results, or artifact references in the implementation summary.

## Grouping
Optional when the target project uses grouping.

## Source Reference
Optional pointer to the plan row, issue, or document anchor that created this task.

## Applicable Project Skills
Optional list of host-visible target-project skills relevant to this task.