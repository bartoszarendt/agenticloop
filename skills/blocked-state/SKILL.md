---
name: blocked-state
description: Use when an agent or the loop hits a wall it cannot clear on its own – provider outage, rate limit, missing credentials, an impossible or contradictory task, review deadlock, merge conflict, no implementation artifact produced, or an exhausted attempt budget / self-loop with no progress – and must record a durable, resumable pause. Defines needs_context, blocked markers, task-file status updates, block categories, and how the task resumes.
metadata:
  area: failure-handling
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: none
---

# Blocked state

The loop must fail loudly and durably, never silently. A blocked task is not a failed task; it is a paused task with enough evidence for a human or later agent to resume.

For ownership when a gate fails, follow the canonical **Gate Ownership And
Dispatched Contract** section in `agenticloop/AGENTIC_LOOP.md`: a failing gate
routes work but does not transfer another role's mutation authority.

Use backend-neutral language first:

- **task record**: the durable record for the work,
- **GitHub projection**: issue labels and comments when the backend is GitHub,
- **files projection**: local Markdown task fields when the backend is local files.

The default backend is files. Read `.agenticloop/project.md` for `task_backend` before
recording a blocked state. For GitHub-backed work, state markers count only when they
start a line and appear in comments authored by the loop's GitHub account. The
`[[agent: ...]]` trailer from [[github-attribution]] helps identify the role, but it is
cooperative text, not security.

For files-backed operations, follow `agenticloop/backends/files.md` for task-file shape and frontmatter
conventions.

## Transient vs durable

- **Transient**: provider outage, rate limit, flaky network, temporary `gh` failure. Retry once or wait if the retry is cheap and safe. If it keeps failing, record a block.
- **Durable**: credentials missing, task contradiction, merge conflict, review deadlock, missing human decision, or unavailable external dependency. Record a block immediately.
- **Ambiguity**: if the task record is incomplete but the maintainer can fix it, use `needs_context` instead of blocked.

Before routing a blocked handoff, use the read-only
`npx agenticloop task handoff-preflight <id> --json` result. It reports the
disposition owner and one safe repair without treating activation as operator
authorization. A stale derived observation may use the explicit
`task refresh-handoff-evidence <id> --plan <path> --yes` path; it cannot repair a
protected task contract, human decision, review disposition, or product file.

## needs_context

Use `needs_context` when the engineer cannot proceed because the task record is
ambiguous, incomplete, or contradictory, but no locked decision needs to change.
Also use it when unexpected context expansion would exceed the task record's
bounds and the maintainer can split or tighten the task.

### Neutral rule

Ask numbered, specific questions. Each question must include:

1. what was already checked,
2. the recommended answer or default path,
3. the missing evidence if no recommendation is possible,
4. who can answer.

If the task record was defective, the maintainer also amends it. After two context rounds on the same task, use blocked category `contract` instead of continuing to ask questions.

### GitHub projection

Post an issue comment containing:

```text
AGENT_TASK_STATUS: needs_context
```

When context pressure caused the pause, also include:

```text
AGENT_CONTEXT_REASON: context_overflow
```

The maintainer answers in one comment ending with:

```text
AGENT_CONTEXT_STATUS: provided
```

### Files projection

Update task-file frontmatter:

```yaml
status: needs_context
```

Then append dated notes or questions under `## Comments` or a dedicated blocker section. Record:

- what was checked,
- what answer is needed,
- who can answer,
- the recommended default when one exists,
- `context_reason: context_overflow` when context pressure caused the pause.

## Event Logging

Event logging is optional and off by default. When `event_logging: enabled`,
resolve the command and honor the disabled/non-blocking rules in
[[event-logging]] before writing events.

After writing the durable backend state, emit `needs_context` or `blocked` with the same task id
and a short reason. Put only small structured facts, such as `block_category`, into event data.

Do not paste full issue comments, prompts, chat text, or logs into the event log.

## Block a task

### Neutral rule

State what blocks the task, what was tried, what answer or action is needed, and who can clear
it.

### GitHub projection

Mark the task two ways:

1. Add the `blocked` label.
2. Post a comment containing:

   ```text
   AGENT_TASK_STATUS: blocked
   AGENT_BLOCK_CATEGORY: <category>
   ```

End with the attribution trailer from [[github-attribution]].

### Files projection

Update task-file frontmatter:

```yaml
status: blocked
block_category: <category>
```

Append dated notes under `## Comments` or a blocker section. Record:

- what was checked,
- what was tried,
- what answer or external action is needed,
- who can answer or unblock it.

## Categories

| Category | Meaning |
|---|---|
| `transient` | A retryable failure persisted after a reasonable retry. |
| `credentials` | Auth, token, provider, or permission is missing or invalid. |
| `contract` | The task record is impossible, contradictory, missing key information, or waiting on approval through [[change-request-gate]]. |
| `review-exhausted` | Review rounds are no longer making progress. |
| `review-unknown` | A review did not produce a clear accepted or needs_revision result. |
| `merge-conflict` | The implementation artifact cannot be merged cleanly. |
| `ci-failure` | Required remote checks are failing or incomplete. |
| `no-artifact` | Implementation ran but produced no reviewable artifact and no better marker. |
| `no-progress` | The attempt budget or self-loop guard tripped: repeated equivalent attempts, or a restated intended next action never performed, with no new progress. |

## Engineer escape hatch

The engineer must not create an empty pull request or placeholder artifact just to keep the loop moving. If the work cannot be completed, record `needs_context` or `blocked` with evidence. If the task record itself is defective, update it through [[task-record-contract]].

## Resume

Resume only after the underlying blocker is cleared and the task record reflects the decision.

A normal resume retains the producing `roleId` from the exact blocked
`agenticloop.role-return`. Run the resume through `task verify-return` /
`role_return_receive`; do not mutate or persist first. Changing owner requires a
closed version 2 redelegation authority bound to the return ID/digest, consumed
packet, producer/target roles, issuer, resume transition/preconditions,
issue/expiry times, and invalidators. Its Ed25519 signature must verify against
the exact authority ID/kind/key/issuer and current revocations in the fixed
operator trust store. A semantic digest is integrity evidence, not issuer
authority. Never infer transfer from comments, labels, trailers,
caller-supplied producer strings, or who edits next.

Before destructive, scope-changing, or host-state repair, require a fresh closed
version 2 `agenticloop.human-disposition` record at that same import edge. It
must bind the exact blocked return and requested recovery class, identity,
scope/host state, human actor, durable authority reference, reason,
issue/expiry times, resulting owner/transition, and invalidation conditions.
The signature must verify against the fixed operator-pinned human authority.
Missing, unsigned, self-minted, revoked, stale, future-dated, cross-return,
wrong-recovery, malformed, or unrelated dispositions remain blocked. Attribute
the override to the human actor under `human_authority`; never fabricate a
workflow-role attribution for human work.

**GitHub projection**:

- remove the `blocked` label,
- add `approved` if the block was a change-request approval gate,
- ask the orchestrator to continue from the task record.

Do not continue an issue that still carries the configured blocked marker unless a human explicitly instructs you to inspect it.

**Files projection**:

- update `status` and clear `block_category` in frontmatter,
- add `approved: true` if the block was a change-request approval gate,
- append a dated resume note under `## Comments`,
- ask the orchestrator to continue from the task file.
