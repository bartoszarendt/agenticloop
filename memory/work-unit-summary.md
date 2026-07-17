---
summary_unit: task
scope_ref: T-001
status: complete
---

# Task Completion Summary

This is the canonical shape for the completion summary recorded **inline** in a
task record (the `## Scope Completed` section and those that follow). There is
no separate summaries store; the task record is the durable summary.

## Scope Completed
State what was completed and how the outcome satisfies the task scope.

## Artifacts
List the files changed, branches, commits, PRs, or other implementation artifacts
and why each one mattered.
## Evidence

List every required check with fresh output from the final state. Include RED
evidence for new behavior when applicable. Prefer concise verdict lines and the
relevant excerpts that prove the claim; do not paste full terminal dumps. The
agent must still read the full command output before claiming success. Use
event-log `refs` and small `data` for structured facts; do not create a separate
parseable receipt block. Output refs remain a deferred future policy; do not
create or rely on them now. When the task record has a ## Proof Pressure section,
record the final-proof and likely-misfire evidence here.

## Deviations
Explain every meaningful scope or plan deviation from the task record or group
plan.

## Process Observations
Optional. Record review churn, blockers, setup issues, or workflow friction.
Reference `## Verification Attempts` for timeout observations; do not duplicate
history or create a decision here.

## Known Gaps
List accepted limitations, deferred concerns, or unresolved issues that remain
after the final state.

## Follow-Ups
List follow-up task ids, issues, or summaries created during the work.

## Trace

Optional. Include when event logging is enabled and workflow-gate events exist.

- **Task Record**: task id, file path, issue number, or pull request link
- **Backend**: files or github
- **Roles Invoked**: orchestrator, maintainer, engineer, and any bounded fallback
- **Artifacts**: branch, commit range, patch, diff, issue, or pull request reference
- **Checks Run**: exact commands run on the final state
- **Decisions**: durable decisions made during the task
- **Blockers**: blocked categories and how they were resolved
- **Deviations**: scope or plan deviations with justification
- **Follow-Ups**: follow-up task ids, issues, or summaries created
- **Privacy Notes**: anything that should not be published further
