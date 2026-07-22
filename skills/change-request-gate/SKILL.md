---
name: change-request-gate
description: "Use when a task is classified `type: change-request` because it changes a locked architecture, process, plan, or repository decision. Defines the docs-first approval gate that must pass before implementation and how files-backed or GitHub-backed task records are held blocked until then."
metadata:
  area: failure-handling
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: none
---

# Change-request gate

A change-request task cannot go straight to implementation. In files-backed task records this is
typically `type: change-request`; in GitHub-backed task records it is typically the
`type:change-request` label. It changes a locked decision, so the decision must be reviewed as
documentation before code follows it.

Optional supervision does not alter this gate. Its model and kernel may record a
block or request the operator, but may not approve the docs-only change, change
the locked decision, or route around the human approval marker.

## Gate

1. The maintainer drafts or updates the affected durable docs. Use [[decision-capture]] when the decision should be tracked under `.agenticloop/decisions/`. Use an ADR only when the decision earns one.
2. The docs-only change is reviewed by a human.
3. A human marks the task approved in the active backend.
4. Implementation proceeds through [[task-record-contract]] and [[review-and-accept]].

Until approval is present, hold the task in [[blocked-state]] with category `contract`.

## Backend projections

### Neutral rule

- Classify the task record as a change request before implementation starts.
- Hold the task in blocked or contract state until human approval is durably recorded.
- Human-authored work enters the loop only after the task record is clearly marked ready for the
  agent roles that will continue it.

### GitHub projection

- Classify with the configured `type:change-request` label.
- Record approval with the configured `approved` label.
- Until approval exists, keep the task blocked under [[blocked-state]] with category `contract`.
- A human-authored issue enters the loop only when it carries `agent-ready` and the configured
  grouping label when the project uses grouping.

### Files projection

- Classify the task file with frontmatter such as `type: change-request`.
- Record approval with frontmatter such as `approved: true` after the human approves the docs-only
  change.
- Until approval exists, keep the task file in `status: blocked` with `block_category: contract`
  and explain the hold under `## Comments` or a blocker section.
- A human-authored task file enters the loop only when it is no longer draft, the scope is
  complete, and `status: agent-ready` is set. If it is a change request, the approval gate still
  applies before implementation.

## When an ADR earns its place

Write or update an ADR only when the decision is:

- hard to reverse,
- surprising without context,
- the result of a real tradeoff.

Keep ADRs short. A single clear paragraph explaining the decision and why is acceptable.

## Human-authored work entering the loop

For GitHub-backed work, a human-authored issue enters the loop only when it carries both:

- `agent-ready`,
- the configured grouping label when the project uses grouping (for example `phase:1` under `grouping_profile: phase`).

Without `agent-ready`, it remains human backlog. Adopted issues are folded into
the planned task queue or configured group unless a human explicitly
reprioritizes them.

For files-backed work, a human-authored task file enters the loop only when the file is complete
enough for implementation, carries `status: agent-ready`, and records `approved: true` when the
task is a change request.

This gate is the standing rule "update the durable decision first" turned into an enforceable workflow.

If the approved change updates an accepted locked decision, supersede the old decision record through [[decision-capture]] instead of silently rewriting history.
