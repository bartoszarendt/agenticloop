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
evidence for new behavior when applicable.

## Deviations
Explain every meaningful scope or plan deviation from the task record or group
plan.

## Process Observations
Optional. Record repeated review churn, blocker patterns, setup issues, or
workflow friction worth addressing.

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
