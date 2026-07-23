---
name: role-delegation
description: Use when the orchestrator starts or resumes a task loop, routes first-run project-map confirmation, creates a task record handoff, hands off implementation, routes review, or runs closeout. Ensures real host delegation happens when available, or an explicit bounded single-agent role assumption is used when it is not, while files-backed and GitHub-backed delegation rules plus human checkpoints are followed.
metadata:
  area: orchestration
  side_effects: writes-tmp
  credentials: none
  runs_scripts: none
---

# Role delegation

The orchestrator coordinates; it doesn't implement, plan task records, or perform final review.
Delegation completes only when the designated role executes the work, not when the
orchestrator describes it.

## Advance Authorization

Delegation is state-changing under the Advance Authorization Boundary in
`agenticloop/AGENTIC_LOOP.md`. Delegate only when explicit instruction or standing
authorization to advance is present and the source can be named.

Authorization attaches to a work unit, not each step. Routine lifecycle steps
inside it -- implementation, review, and revision delegations -- are covered
without per-transition approval.

Do not delegate merely because a bounded request reveals a next step. Status
checks, inventories, explanations, diagnostics, and direct questions end once
answered; report the next step and stop unless the human authorized advancing.

## When to Use

Apply this skill when the orchestrator:

- starts or resumes a task loop (identifying the current task, optional grouping context, or next step),
- routes first-run project-map setup or confirmation through [[setup-agenticloop]] when setup is still unconfirmed,
- hands off task-record creation or refinement to maintainer,
- hands off implementation or revision work to engineer,
- routes an implementation artifact back to maintainer for review,
- routes a revision to engineer based on review feedback,
- runs closeout or records a human checkpoint decision.

## Delegation Rules

| What the orchestrator does | Role that owns it |
|---|---|
| Identify phase, task, backend | orchestrator |
| Decide whether a source work item is one task or a task set | maintainer |
| Set up or confirm project map | maintainer |
| Create or refine task records | maintainer |
| Plan scope, acceptance criteria, proof pressure when needed | maintainer |
| Classify per-task parallel safety and resolve code/collision unknowns | maintainer |
| Validate host/lane capability, record concurrency plan, and delegate lanes | orchestrator |
| Implement scoped work | engineer |
| Revise after review feedback | engineer |
| Record a timed-out check attempt and return its observation | engineer |
| Final-triage a timeout and update the current verification-fact profile | maintainer |
| Apply one bounded Maintainer Review Fixup during an active eligible review | maintainer |
| Review implementation artifacts | maintainer |
| Accept or request revision | maintainer |
| Closeout and retrospective | maintainer |

The orchestrator does not create task records, implement, review, or accept.

Scoped implementation and ordinary revision remain engineer-owned. The single
exception is a bounded Maintainer Review Fixup: during an active eligible review
the maintainer already executing the review may apply one fully understood
correction under [[review-and-accept]] and accept the result. A successful fixup
requires no engineer invocation and is not a `needs_revision` round; an
unsuccessful, ineligible, expanded, or independent-review finding returns to the
normal engineer handoff. No extra single-agent role-assumption ceremony is
needed beyond the maintainer's existing execution -- the delegation-mode of the
role invocation and the final `review_mode` are distinct, so a maintainer invoked
via `host_subagent` still records `single_agent_fallback` when it accepts its own
fixup.

## Slice sizing

Default: one independently verifiable task, the smallest useful slice. For a
larger authorized bounded run, prefer the largest safe slice that stays bounded,
reversible, and independently verifiable. Broad authorization isn't permission to
create one oversized record; task sets still decompose.

## Host Delegation Mechanism

Real delegation starts a separate role, task, named-agent, or subagent execution
for maintainer or engineer. Describing that role's actions in prose is not
delegation.

## Delegation Capability Check

Before single-agent fallback, explicitly check for a host task, subagent, role,
agent, type, mode, or `subagent_type` mechanism. If one exists, use it. Otherwise
record how absence was verified, or the attempted mechanism and failure reason,
in the delegation output.

## Concurrency Policy

Delegation is serial by default. Mutation governs concurrency safety, and
knowledge coupling governs it alongside mutation: parallel write execution
requires mutation independence plus knowledge independence. Every authorized
multi-task unit carries a current Parallel Opportunity Scan after decomposition:
with fewer than two ready tasks it records not-currently-eligible status and a
rescan trigger; with two or more it loads [[parallel-delegation]] before routing
implementation work. Planning, reviewing, and joining parallel lanes also load
that skill.

Role-delegation keeps the delegation prompt contract: the `Concurrency:` line is
required for delegated work and must be either `serial -- reason: <concrete
blocker>` or `parallel batch <id> -- lanes: <n>/<configured maximum>; join:
<condition>`. The
`Lease:` line carries observable-step checkpoint cadence, no-progress budget,
and any relevant duration or milestone. Parallel plans, backend-specific lane
rules, join behavior, and parallel liveness details live in [[parallel-delegation]].

## Event Logging

Event logging is off by default. When enabled, follow [[event-logging]] and emit
`role.invoked` only after real maintainer/engineer execution or bounded fallback
begins, never for hypothetical routing. The orchestrator is the emitter: top-level
`role` is `orchestrator`, and a maintainer or engineer must not emit a
self-invocation event targeting itself. Record `target_role`, `delegation_mode`
(`host_subagent`, `explicit_agent_invocation`, or `single_agent_fallback`), a
boolean `fallback`, `adapter`, known `model`, and `reason` as applicable. For
`single_agent_fallback`, also record `fallback: true`, a structured
`fallback_cause` (`mechanism_absent` or `invocation_failed`), and a non-empty
`reason`. Non-fallback modes record `fallback: false` and no fallback cause. The
strict producer path rejects a new `role.invoked` that violates these rules.

## Two Meanings of single_agent_fallback

Keep the delegation mode and the review mode distinct:

- `delegation_mode: single_agent_fallback` on `role.invoked` means real role
  delegation was unavailable or a concrete attempt failed. It requires a
  structured `fallback_cause` and reason.
- `review_mode: single_agent_fallback` on the review means the review happened in
  the acting session and is not independent. It is legal for ordinary tasks even
  when the role was delegated for real (for example a self-accepted Maintainer
  Review Fixup by a `host_subagent` maintainer).

A `review_mode: single_agent_fallback` does not by itself prove a delegation
failure or a fixup; only the durable fixup subsection and maintainer attribution
identify a fixup.

## Single-Agent Fallback

Single-agent fallback is legal only when the delegation capability check found no
relevant mechanism (`fallback_cause: mechanism_absent`), or a named mechanism was
attempted and concretely failed (`fallback_cause: invocation_failed`). A request
such as "re-review round 2" is not a fallback cause. If allowed, the current agent
may assume the requested role for one bounded role step only.

When using fallback:

- announce it in output and record the capability-check result, `fallback_cause`, and reason,
- follow the assumed role's boundaries and required skills,
- stop at the role's normal stop condition, bounded to that one role step,
- emit `role.invoked` with `fallback: true`, the `fallback_cause`, and the reason when event logging is enabled,
- do not claim host delegation happened.

If neither host delegation nor single-agent role assumption is allowed, use [[blocked-state]] with category `contract` and stop.

## Re-Review and Continuation

Every orchestrator-routed implementation or review role step receives a fresh
delegation decision, and every orchestrator-routed re-review round passes through
delegation routing again. When host delegation is available, the orchestrator uses
it for the new round instead of continuing the prior maintainer session for
convenience. A new review round is not a reason to record
`delegation_mode: single_agent_fallback`.

A human may directly continue an already-active maintainer session for ordinary
tasks, but that continuation:

- is not a new role invocation, so it emits no new `role.invoked`;
- does not satisfy an independent-review requirement;
- must not be represented as a failed delegation attempt;
- records a concise `continuation_reason` on `review.started` and/or
  `review.result` and uses `review_mode: single_agent_fallback`;
- stops with a clear status instead of accepting when the task record requires
  independent review.

A successful Maintainer Review Fixup does not alter the original role invocation's
delegation mode; the final fixup review still uses
`review_mode: single_agent_fallback`.

## Review Round Checkpoint

The orchestrator counts `needs_revision` rounds per task. Before the revision
that would exceed the task record's `review_budget` (default 3, so before a
fourth revision), run the Review Round Checkpoint in `agenticloop/AGENTIC_LOOP.md`:
classify the churn cause, then route one targeted revision plan naming the cause,
or record `needs_context` or `blocked` with [[blocked-state]]. Do not route an
undirected fourth revision.

## Delegation Prompt Shape

When invoking a role, orchestrator prompts must include:

```text
Role:              maintainer | engineer
Task ID:           <task-id from project task convention, or "pending decomposition" before task records exist>
Backend:           <task_backend from .agenticloop/project.md; default is 'files'>
Delegation mode:   host_subagent | explicit_agent_invocation | single_agent_fallback
Fallback cause:    mechanism_absent | invocation_failed   (required only for single_agent_fallback)
Fallback reason:   <mechanism checked and its concrete result>   (required only for single_agent_fallback)
Source docs:       <closed list of files the role must read before acting; no expansion without explicit exception>
Operating facts:   <required for host_subagent and explicit_agent_invocation only; omit for single_agent_fallback>
  Scratch directory:   <path>
  Event logging:       <disabled | resolved command | unavailable with reason>
  Payload mechanism:   <doc pointer (e.g. `agenticloop/backends/github.md` Command Safety) | none>
  Adapter constraints: <host constraints | none>
  Verification observations: <relevant VF ids and task-attempt refs; accepted/proposed decision links if any; or none> (facts only; no strategy approval)
Scope:             <what the role should do>
Out of scope:      <what the role must not do>
Expected output:   <what the role should produce>
Routed findings:   none | <finding ids with fact, evidence ref, and required disposition per finding>
Parallel scan:     `completed - <durable reference>` | `not currently eligible - <reason and rescan trigger>` (required for multi-task implementation delegation)
Stop condition:    <when the role must stop and return to orchestrator or human>
Budgets:           <omit when all defaults/low; else `minimalism=<lite|full|ultra>; attempt_budget=<n>; review_budget=<n>; context_overflow_risk=<medium|high>` for non-default task-record constraints>
Concurrency:       `serial -- reason: <concrete blocker>`, or `parallel batch <id> -- lanes: <n>/<configured maximum>; join: <condition>`
Lease:             <observable-step checkpoint cadence, no-progress budget, and any relevant max duration or milestone>
```

`Delegation mode` is always required and names the exact mechanism used. `Fallback
cause` and `Fallback reason` are required only for `single_agent_fallback`: the
cause is `mechanism_absent` (the capability check found no relevant mechanism) or
`invocation_failed` (a named mechanism was attempted and concretely failed), and
the reason states the mechanism checked and its concrete result. "Re-review
requested" or "round 2" is never a fallback cause. Non-fallback modes omit both
fallback fields. The receiving role uses the supplied `Delegation mode` when it
records review provenance and event data; `Operating facts` remains required for
real delegation but never substitutes for the explicit mode.

Do not omit scope, out of scope, expected output, stop condition, Delegation mode,
or Operating facts for real delegation. Use explicit `none` for inapplicable fields. The payload mechanism is a doc pointer or `none`, never a copied command recipe.

`Routed findings:` lists each cross-lane finding id, fact/invariant, evidence,
and required disposition; use `none` for parallel lanes without findings. The
recipient returns `applied`, `already satisfied`, `rejected` with evidence, or
`deferred` with a reason and effect on correctness, safety, acceptance, and
evidence. Deferral remains join-blocking pending non-blocking limitation or
follow-up triage. Do not overload `Operating facts` with raw findings.

For every multi-task implementation delegation, `Parallel scan:` is required.
The `completed` form points to the current durable scan; the
`not currently eligible` form names the truthful reason and rescan trigger. A
source plan or maintainer recommendation does not substitute for this line. Do
not delegate multi-task implementation work with the field missing.

`Budgets:` propagates non-default task-record minimalism, effort budgets, and
medium/high context risk; omit it for defaults/low. At a budget or unexpected
context expansion, summarize and return status. High context risk normally
requires split-or-tighten. Host tool-call counters are not delegation budgets
unless recorded in `Lease:` or `Stop condition:`; hard host limits return status
with concrete unknowns rather than reduced quality or guesses.


## Context Read Discipline

`Source docs` are the closed normative set. The role may also read the task
record, project map for backend/document selection, matching backend projection,
and files explicitly named by the human or task record. Engineer reads stepped
`## Implementation Notes` first; the orchestrator points to, rather than copies,
that plan.

Follow the canonical Context Read Discipline in
`agenticloop/AGENTIC_LOOP.md`. Bounded task-scoped implementation discovery is
permitted; ambient logs and vague related-file scans are not. Expansion beyond
that bound, or a material scope change, returns `needs_context` (or `blocked`).

If an Operating fact is wrong, record the gap in the task record, review, or status return and continue from the canonical document. Do not silently re-probe the same fact in a loop.

In Operating facts, list only relevant verification observations: current
`VF-...` ids, task-attempt references, and linked decision references, or
`none`. Distinguish accepted decisions (binding) from proposed decisions
(non-binding), but never present an observation as strategy approval. If stale,
record the gap; do not re-probe. Surface any promotion candidate to maintainer.

Long-running or parallel work requires a lease. Without host cancellation, use a
return-after-N-observable-steps checkpoint. Return status when the lease expires,
no-progress budget is exhausted, branch/worktree is wrong, a collision appears,
or the stop condition is reached. For parallel-specific liveness, host
streaming/cancel limits, and join-based batch rules, load [[parallel-delegation]].
Status returns include `STATUS`, task id, branch/worktree, files touched,
evidence, next step, and stop reason.

Parallel returns also include findings or `Cross-lane findings: none`, routed
finding dispositions, verification phase and exact tested artifact/tree, and
any rehearsal result. Route live only when the host supports injection;
otherwise use the next checkpoint/resume and never claim asynchronous delivery
the host cannot perform. Findings required before more writes force the
two-wave pattern or serialization.

## GitHub Backend Delegation

When `task_backend` is `github`, make the pull request path explicit in delegation prompts.

Engineer implementation or revision delegation must include:

- create or use a task branch,
- verify the worktree is not on the default or integration branch before committing,
- commit the scoped changes with the configured task id in the message,
- push the branch when publishing is authorized,
- open or update a pull request linked to the task issue,
- include `Closes #<issue-number>` in the pull request body for normal tasks,
- put current implementation evidence in the PR body; don't duplicate it in a separate issue or PR comment,
- return the issue and PR URLs to the orchestrator.

Maintainer review delegation must include:

- review the pull request diff against the task issue,
- complete Lens 1, classify any Lens 1 revision as `implementation-changing` or
  `record-only`, and return one consolidated revision packet;
- run the Structural Risk Sweep and defer full Lens 2/Lens 3 only for a
  reviewable implementation-changing revision; complete full Lens 2/Lens 3 for a
  record-only revision on the unchanged exact artifact;
- verify the PR is linked to the issue by a recognized closing keyword,
- reject acceptance if no PR exists for a GitHub-backed implementation task,
- reject acceptance if a normal implementation PR lacks a closing issue
  reference for the task issue,
- fetch existing PR reviews before posting and skip submission when the latest valid
  agent-authored marker already records the same outcome for the current PR head,
- post the review marker only after checking the PR artifact,
- may apply one bounded Maintainer Review Fixup per [[review-and-accept]] on the
  existing task branch and PR, then rerun checks, refresh the PR-body head evidence,
  and accept the resulting head with `AGENT_REVIEW_MODE: single_agent_fallback`.

An issue comment with evidence is supporting evidence, not the artifact. The
task is not complete until the PR is reviewed, accepted, and merged or closed
through a backend exception.

The PR path applies to all automated work including docs, config, and
infrastructure. A no-PR exception must be human-approved and recorded before
implementation. A task branch has one terminal merge path; do not merge it again
after the PR is merged.

## Files Backend Delegation

When `task_backend` is `files`, make the local task-file path and recorded implementation artifact explicit in delegation prompts.

Engineer implementation or revision delegation must include:

- read the task file before editing,
- implement only the scoped change from that task file,
- update `implementation_artifact` in task-file frontmatter,
- publish or refresh the one current implementation summary with fresh verification evidence,
- append a dated correction entry before refreshing if prior claims, evidence, or artifact references changed,
- ensure files-backed task-record updates are tracked or report a local-only exception,
- return the task file path and artifact reference to the orchestrator.

Maintainer review delegation must include:

- run or inspect `git status --short --untracked-files=all` before reviewing,
- complete Lens 1, classify any Lens 1 revision as `implementation-changing` or
  `record-only`, and return one consolidated revision packet;
- run the Structural Risk Sweep and defer full Lens 2/Lens 3 only for a
  reviewable implementation-changing revision; complete full Lens 2/Lens 3 for a
  record-only revision only when the existing exact-artifact rule permits it;
- reject untracked `.agenticloop/tasks/*.md` unless explicitly excepted,
- review the recorded artifact or diff against the task file,
- verify a `## Revision Log` or `## Comments` correction entry exists when prior claims
  changed in the current summary,
- update `review_status` in frontmatter,
- append the maintainer review section to the task file,
- reject acceptance if `implementation_artifact` or final verification evidence is missing,
- may apply one bounded Maintainer Review Fixup per [[review-and-accept]] on the
  current local artifact, then update `implementation_artifact`, refresh evidence
  under the correction-entry rule, set `reviewed_artifact` to the resulting
  artifact, and accept with `review_mode: single_agent_fallback`.

## Human Checkpoint Rules

Authorization covers the work unit. Stop only at hard checkpoints in the
Authorized Work Units boundary in `agenticloop/AGENTIC_LOOP.md`:

- leaving the authorized work unit, including starting a task, group, or phase outside it
  (task-record-only authorization does not include implementation),
- merge, release, irreversible external publication, or destructive cleanup including
  deleting branches,
- changing a locked process, architecture, backend, or product decision, or invoking a
  backend exception.

In-scope commits, pushes, task-file updates, and lifecycle routing are routine.
The task branch/PR path applies only to GitHub backend; with files backend, PR,
publish, and merge remain human decisions.

Backend mismatch or unresolved agent blockers route to [[blocked-state]], not a
checkpoint.

### Checkpoint Presentation

- Present one concrete human decision at a time when the action is high risk.
- State the exact action that will happen after approval, for example: `If you confirm, I will
  merge PR #171 into main.`
- Do not number sequential steps as if they were exclusive options.
- If multiple options are presented, make them mutually exclusive and name the exact command or
  action for each.
- If the human replies with a selected action, restate the chosen action and perform it before
  starting unrelated work.
- After merge approval and merge execution, the next gate is to confirm merged state,
  verify the GitHub task issue is closed for GitHub-backed tasks, emit or record
  task closure when applicable, run closeout if configured, then ask before starting
  a new task unless the human explicitly approved continuing.

## Backend Enforcement

Before any task-record operation:

1. Read `.agenticloop/project.md` and record the `task_backend` value. The default is
   `files` when the file is absent or the key is not set.
2. If the selected source item is not clearly one independently verifiable implementation
   task, delegate maintainer decomposition before creating implementation records.
3. Use the matching projection in `agenticloop/backends/` for all task-record operations.
4. If `task_backend` is `github`, require the maintainer to create a GitHub issue before
   implementation starts. A files-only task record while `task_backend: github` is set is an
   exception that must be explicitly declared and explained.
5. If the backend is misconfigured, labels are missing, or auth is unavailable, stop and
   record the gap using [[blocked-state]] rather than silently falling back to another
   backend.

## Orchestrator Output Requirements

Every orchestrator update must include:

```md
## Current Task
## Delegation
- Role invoked: <role name>
- Host delegation check: <tool/mechanism found and used | verified absent by ... | attempted and failed with ...>
- Host delegation used: <yes | no>
- Concurrency: <`serial -- reason: <concrete blocker>` | `parallel batch <id> -- lanes: <n>/<configured maximum>; join: <condition>`>
- Parallel scan: <`completed - <durable reference>` | `not currently eligible - <reason and rescan trigger>` for multi-task implementation>
- Lease: <none | observable-step checkpoint cadence, no-progress budget, and stop condition>
- Fallback: <none | single-agent role assumption as maintainer | single-agent role assumption as engineer>
- Consequence: <none | fallback limited to one role step and boundary enforcement relies on explicit self-policing until return>
- Task record reference: <issue URL | file path | "none -- gap recorded">
## Waiting On
## Next Human Decision
```

If host delegation wasn't used, explain why and the role-boundary impact. Do not
omit the delegation field.

## Before Handing Back

- Latest human instruction was honored.
- Real delegation was used, or fallback has a recorded capability check and reason.
- If `event_logging: enabled`, required gate events for completed steps were emitted or a missed-event process gap was recorded.
- Backend artifact matches `.agenticloop/project.md` (`files` task file or GitHub issue or PR).
- Current state and next human decision are explicit.

## Red Flags

- Role work is narrated instead of invoked, fallback lacks a capability check, delegation output
  stays unknown after work starts, or maintainer/engineer work appears inline in orchestrator output.
- An available host task, subagent, or named-agent mechanism for maintainer or engineer is skipped
  without a recorded failure.
- A multi-task unit lacks a current Parallel Opportunity Scan result, a multi-task
  implementation delegation omits `Parallel scan:`, or serial is chosen with no
  concrete reason and rescan trigger.
- Parallel role work starts without a concurrency plan, lease, stop condition, or join condition;
  write lanes share checkout, branch, worktree, artifact, task record, or mutable files; or a copied
  directory is used as a pseudo-worktree.
- Parallel coordination lanes mutate the same issue, PR, task record, closeout marker, event log,
  label/status stream, or group state.
- Orchestrator waits indefinitely for a lane whose expected artifact is missing at join.
- GitHub-backed work uses a local-only task record, direct default-branch commits, missing
  branch/commit/push/PR expectations, issue-comment review instead of PR diff review, or an accepted
  issue comment as task completion.
- GitHub docs, configuration, workflow, or infrastructure changes bypass the branch/PR path because
  they are "not code"; a task branch is merged twice; or a parallel-batch PR merges before all lanes
  return, review completes, cross-branch risk is checked, and human merge order is approved.
- Files-backed work starts from a draft task record, lacks `implementation_artifact` or an inline
  task-file summary, silently rewrites evidence without a dated correction, leaves the task record
  untracked without exception, or leaves `review_status` unset or stale.
- A revision beyond the task record's `review_budget` (default 3, i.e. a fourth) is routed on one task without running the Review Round Checkpoint.
- A human checkpoint is skipped before implementation or merge, requested for a routine in-scope
  step, or ignored after merge approval while the agent starts a new task first.
- Sequential actions are presented as numbered alternatives, or a numeric choice is acted on without
  restating the chosen action.
- Backend used differs from `task_backend` in `.agenticloop/project.md` without an explicit exception.
- Delegation prompt is missing scope, out of scope, or stop condition.
- Real host delegation omits Operating facts, omits explicit `none`, or copies backend recipes instead of pointing to docs.
