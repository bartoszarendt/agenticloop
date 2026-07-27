---
improvement_id: I-YYYY-MM-DD-001
status: proposed
date: YYYY-MM-DD
supersedes: []
related_tasks: []
source_refs: []
target_surface: skill-procedure
target_path: agenticloop/skills/<name>/SKILL.md
risk_level: medium
requires_change_request: true
---

# I-YYYY-MM-DD-001: Short Proposal Title

`target_surface` must use the allowlist validated by the toolkit
(`skill-trigger`, `skill-procedure`, `reviewer-checklist`, `task-template`,
`event-logging-guidance`, `adapter-guidance`, `role-definition`,
`core-methodology`, `permission-policy`, `decision-record`).

## Failure pattern
The recurring pattern observed across multiple tasks. One directly evidenced
required-gate bypass, fabrication, or material misordering is also sufficient;
ordinary one-off inconvenience is not.

## Evidence
- <audit-id>: specific audit evidence.
- <erroneous-marker-or-carrier-ref>: the associated gate-bypass evidence.

Every `source_refs` entry must resolve against live durable state when the
proposal is created or linted: an audit ID or run, a task ID, a decision ID, a
recorded closeout marker digest, or another proposal ID. A chat-only claim or a
reference to a nonexistent artifact fails validation before any file is
created; references are recorded exactly and never silently rewritten.

## Inferred mechanism
Why the agent erred – the agent-side cause, separate from what happened.

## Proposed change
The exact, minimal change to the single target surface. Prefer replacing
unclear instructions over appending text.

## Expected behavioral effect
What should change in agent behavior.

## Regression risks
What could get worse, and for which task types.

## Candidate patch
Optional diff when safe.

## Validation plan
How to confirm the change helps (e.g. `node bin/agenticloop.js validate`,
activation-corpus cases, a synthetic task).

## Rollback
How to revert if it causes problems.
