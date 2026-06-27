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
