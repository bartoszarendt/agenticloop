---
task_id: T-001
status: agent-ready
backend: files
implementation_artifact:
review_status:
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
- Exact command(s) the engineer must run on the final state.
- Include linked verification decisions when a check has a known non-obvious execution strategy.

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

## Concurrency Plan
Optional. Required only when the orchestrator allows parallel delegation for
this task or task batch. Name each lane id, lane type (read-only,
implementation, or coordination/review), role, read/write mode, owned backend
objects, worktree path and branch for file-mutating write lanes, implementation
or workflow artifact, allowed files or areas, shared collision risks (including
shared generated files, lockfiles, schemas, APIs, external state, labels,
comments, status markers, closeout state, event logs, and group state), lease
checkpoint cadence, stop condition, and join condition.

## Parallel Safety

Required when the task belongs to an authorized multi-task work unit, so the
orchestrator's Parallel Opportunity Scan can classify the task. It complements
`## Expected Files or Areas` and `allowed_paths`; it does not replace them.

- Owned paths:
- Shared or generated files:
- Schema/API/lockfile risk:
- Backend objects owned:
- Dependency edges:
- Parallel eligibility: eligible | blocked | unknown
- Reason:

If code/collision eligibility is unknown and 2 or more ready tasks could
otherwise run in parallel, the maintainer resolves it with one bounded read-only
discovery pass before returning. If still unknown, state what stayed unknown and
recommend serial. Host/lane capability unknowns stay with the orchestrator.

## Completion Summary Template

Use `agenticloop/memory/work-unit-summary.md` as the canonical section shape
(set `summary_unit: task` for a single task). Add task-specific expectations
here so the engineer knows what evidence to publish.

## Reviewer Checklist

- [ ] Task scope matches the source documents reviewed for this task.
- [ ] Unexpected files are justified in `## Deviations From Plan`.
- [ ] Required checks were rerun on the final state with fresh output.
- [ ] If `## Proof Pressure` is present, completion oracle, final proof, and likely misfire were checked.
- [ ] The durable task record includes the current implementation summary.
- [ ] The implementation artifact is linked to the task record.
- [ ] If parallel delegation was used, the concurrency plan was followed and the join condition was met.
- [ ] For GitHub-backed normal implementation tasks, the PR body includes `Closes #<issue-number>`.
- [ ] Known limitations are triaged as accepted, deferred, or follow-up work.
- [ ] No secrets, generated caches, or runtime artifacts were committed.

## Outcome

Optional for routine clean tasks. Conditionally required at closeout when any
of these happened: review_rounds > 1, failed or triaged checks,
blocked/needs_context state, scope drift, stale evidence, human intervention,
or follow-ups. Reuses the existing X-02 fields; do not add a new schema.

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
