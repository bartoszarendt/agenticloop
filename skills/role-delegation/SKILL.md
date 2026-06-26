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

The orchestrator coordinates; it does not implement, plan task records, or perform final review.
Delegation is only complete when the designated role actually executes the work -- not when the
orchestrator describes the work in prose.

## Advance Authorization

Delegation is a state-changing action under the Advance Authorization Boundary in
`agenticloop/AGENTIC_LOOP.md`. Delegate only when an explicit instruction or a standing
authorization to advance is present and the authorization source can be named.

Authorization attaches to a work unit, not to each step. When a human authorizes
a work unit to run, continue, or finish, the routine lifecycle steps inside it --
including the delegations for implementation, review, and revision -- are covered
without a per-transition approval prompt, per the Authorized Work Units boundary
in `agenticloop/AGENTIC_LOOP.md`.

Do not delegate merely because a bounded request reveals an available next step.
Status checks, artifact inventories, history inspection, explanations,
diagnostics, comparisons, and direct questions end when their requested answer
has been reported. Report the next step as a possible next action and stop unless
the human has authorized advancing the loop.

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
| Implement scoped work | engineer |
| Revise after review feedback | engineer |
| Review implementation artifacts | maintainer |
| Accept or request revision | maintainer |
| Closeout and retrospective | maintainer |

The orchestrator does not create task records, implement, review, or accept.

## Slice sizing

Default: one independently verifiable task, the smallest useful slice. For a
human-authorized larger bounded run, prefer the largest safe useful slice that
remains bounded, reversible, and independently verifiable as one task. Broad
authorization is not permission to create one oversized task record; task sets
still decompose into ordinary task records.

## Host Delegation Mechanism

Real delegation means the host starts a separate role, task, or subagent execution and the
invocation accepts a role, agent, type, mode, or `subagent_type` argument. Prose describing what a
role would do is not delegation.

Host delegation examples include a task or subagent call that names the
maintainer or engineer role, an explicit named-agent invocation that creates a
separate role session, or a host handoff that returns a separate role artifact.
Adapter docs may name concrete syntax. The canonical rule is separate role
execution, not prose.

## Delegation Capability Check

Before using single-agent fallback, the orchestrator must explicitly check whether the host exposes
any real delegation mechanism for the requested role.

- If a host task, subagent, role, agent, type, mode, or `subagent_type` mechanism exists for
  maintainer or engineer, fallback is not allowed for that role.
- If delegation is absent, record how that was verified.
- If delegation is available but the concrete attempt fails, record the failed mechanism and the
  failure reason before considering fallback.
- Include the capability check result in the orchestrator's delegation output.

## Concurrency Policy

Delegation is serial by default. Concurrency safety is governed by mutation,
not by role. See `agenticloop/AGENTIC_LOOP.md` for lane definitions, backend
rules, and join behavior.

Parallel delegation requires a recorded concurrency plan: lane id, lane type,
role, read/write mode, owned backend objects, worktree path and branch for
file-mutating write lanes, artifact, allowed files/areas, shared collision
risks, liveness cadence, stop condition, and join condition. If any collision
criterion is unknown, run serially.

File-mutating write lanes in Git repos require a separate `git worktree` and
branch per lane. GitHub implementation lanes also require own issue and PR. No
batch PR may merge until every lane has returned, maintainer review is
complete, cross-branch risk is checked, and the human approves merge order.
Parallel coordination/review lanes must own distinct backend objects with no
shared mutable state. Files-backed non-Git parallel write lanes are not
allowed.

Invalid patterns: write lanes sharing a checkout, branch-only isolation in a
shared checkout, copied-file pseudo-worktrees, GitHub implementation without
own worktree/branch/issue/PR, parallel lanes updating the same issue/PR/task
record/closeout/event-log/label stream/group state.

## Event Logging

If `.agenticloop/project.md` has `event_logging: enabled`, resolve the event
logging command before writing the event: use a non-empty
`event_logging_command`, or run `npx agenticloop --help` once and use
`npx agenticloop` only if it succeeds. Do not attempt event logging when
`event_logging` is disabled, and do not block the workflow if no working
command is available.

After a maintainer or engineer role is actually invoked, emit `role.invoked`. If a bounded
single-agent fallback role assumption begins instead of host delegation, emit the same event with
a summary that states the fallback explicitly.

Do not emit `role.invoked` for hypothetical routing prose. Record only real role execution.

Recommended `role.invoked` data fields: `target_role`, `delegation_mode`
(`host_subagent`, `explicit_agent_invocation`, or `single_agent_fallback`),
`fallback` (boolean), `adapter`, `model` (only when known), `reason`.

Example:

```text
npx agenticloop event-logging role.invoked --task T-001 --role orchestrator --summary "Delegated engineer implementation" --ref "github:issue:42" --data-json '{"target_role":"engineer","delegation_mode":"host_subagent","fallback":false}'
```

## Single-Agent Fallback

Single-agent fallback is legal only after the delegation capability check shows no real host
delegation exists for the requested role, or after a concrete delegation attempt fails. If allowed,
the current agent may explicitly assume the requested role for one bounded role step only.

When using this fallback:

- announce it in output,
- record the capability-check result and fallback reason,
- follow the assumed role's boundaries and required skills,
- stop at the assumed role's normal stop condition,
- bound the fallback to that one role step,
- emit `role.invoked` when event logging is enabled,
- do not claim host delegation happened.

If neither host delegation nor single-agent role assumption is allowed, use [[blocked-state]] with category `contract` and stop.

## Review Round Checkpoint

The orchestrator counts `needs_revision` rounds per task. Before routing a fourth
revision on the same task, run the Review Round Checkpoint in `agenticloop/AGENTIC_LOOP.md`:
classify the churn cause, then route one targeted revision plan that names the cause
or record `needs_context` or `blocked` with [[blocked-state]]. Do not route an
undirected fourth revision.

## Delegation Prompt Shape

When invoking a role, orchestrator prompts must include:

```text
Role:              maintainer | engineer
Task ID:           <task-id from project task convention, or "pending decomposition" before task records exist>
Backend:           <task_backend from .agenticloop/project.md; default is 'files'>
Source docs:       <list of files the role must read before acting>
Scope:             <what the role should do>
Out of scope:      <what the role must not do>
Expected output:   <what the role should produce>
Stop condition:    <when the role must stop and return to orchestrator or human>
Concurrency:       serial, or <parallel batch id plus non-collision basis>
Lease:             <observable-step checkpoint cadence, no-progress budget, and any relevant max duration or milestone>
```

Do not omit scope, out of scope, expected output, or stop condition. An incomplete delegation
prompt produces incomplete role output.

For long-running or parallel work, the lease is required. Without host-enforced
wall-clock cancellation, include a return-after-N-observable-steps checkpoint.
Return status when the lease expires, no-progress budget is exhausted,
branch/worktree is wrong, a collision appears, or the stop condition is reached.
If the host cannot stream, cancel, or surface subagent status, use bounded
serial delegation. Status returns include `STATUS` (`in_progress`, `complete`,
`needs_context`, or `blocked`), task id, branch/worktree when relevant, files
touched, latest evidence, next step, and stop reason.

## GitHub Backend Delegation

When `task_backend` is `github`, the orchestrator must make the pull request path explicit in
delegation prompts.

Engineer implementation or revision delegation must include:

- create or use a task branch,
- verify the worktree is not on the default or integration branch before
  committing agent-authored task work,
- commit the scoped changes with the configured task id in the message,
- push the branch when publishing is authorized,
- open or update a pull request linked to the task issue,
- include `Closes #<issue-number>` in the pull request body for normal
  GitHub-backed implementation tasks,
- put the current implementation evidence in the pull request body and do not duplicate it
  in a separate issue or PR comment,
- return the issue URL and PR URL to the orchestrator.

Maintainer review delegation must include:

- review the pull request diff against the task issue,
- verify the PR is linked to the issue by a recognized closing keyword,
- reject acceptance if no PR exists for a GitHub-backed implementation task,
- reject acceptance if a normal implementation PR lacks a closing issue
  reference for the task issue,
- fetch existing PR reviews before posting and skip submission when the latest valid
  agent-authored marker already records the same outcome for the current PR head,
- post the review marker only after checking the PR artifact.

An issue comment with evidence is supporting evidence, not the implementation
artifact. The task is not complete until the PR is reviewed, accepted, and
merged or closed through an explicit backend exception.

The pull request path applies to all automated work including docs,
configuration, and infrastructure. A no-PR exception must be human-approved and
recorded before implementation. A task branch has one terminal merge path; do
not merge it again after the PR is already merged.

## Files Backend Delegation

When `task_backend` is `files`, the orchestrator must make the local task-file path and recorded
implementation artifact explicit in delegation prompts.

Engineer implementation or revision delegation must include:

- read the task file before editing,
- implement only the scoped change from that task file,
- update `implementation_artifact` in task-file frontmatter,
- publish or refresh the one current implementation summary with fresh verification evidence,
- append a dated correction entry to `## Revision Log` or `## Comments` before refreshing
  if earlier task-file claims, evidence, or artifact references changed,
- ensure files-backed task-record updates are tracked (committed at workflow gates) or
  report an explicit local-only exception,
- return the task file path and artifact reference to the orchestrator.

Maintainer review delegation must include:

- run or inspect `git status --short --untracked-files=all` before reviewing,
- reject untracked `.agenticloop/tasks/*.md` unless explicitly excepted,
- review the recorded artifact or diff against the task file,
- verify a `## Revision Log` or `## Comments` correction entry exists when prior claims
  changed in the current summary,
- update `review_status` in frontmatter,
- append the maintainer review section to the task file,
- reject acceptance if `implementation_artifact` or final verification evidence is missing.

## Human Checkpoint Rules

Authorization covers a whole work unit, not each step. Stop and wait for a human decision
only at the hard checkpoints in the Authorized Work Units boundary in `agenticloop/AGENTIC_LOOP.md`:

- leaving the authorized work unit, including starting a task, group, or phase outside it
  (when the human only asked to create or refine a task record, proceeding to implementation
  is leaving that scope -- confirm first),
- merge, release, irreversible external publication, or destructive cleanup including
  deleting branches,
- changing a locked process, architecture, backend, or product decision, or invoking a
  backend exception.

Commits, pushes, and task-file updates inside the authorized unit are routine, not checkpoints;
this includes routing from task-record creation to implementation to review to revision. The task
branch and implementation pull request apply only under `task_backend: github`; under
`task_backend: files` any PR, publish, or merge stays a human decision.

When a backend mismatch is detected (configured backend differs from the backend used for the
task record), or when agents cannot resolve a blocker, stop via [[blocked-state]] rather than
treating it as a checkpoint.

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
- Concurrency: <serial | parallel plan reference and join condition>
- Lease: <none | observable-step checkpoint cadence, no-progress budget, and stop condition>
- Fallback: <none | single-agent role assumption as maintainer | single-agent role assumption as engineer>
- Consequence: <none | fallback limited to one role step and boundary enforcement relies on explicit self-policing until return>
- Task record reference: <issue URL | file path | "none -- gap recorded">
## Waiting On
## Next Human Decision
```

If host delegation was not used, explain why and what that means for role boundary enforcement.
If fallback role assumption was used, say so explicitly. Do not omit the delegation field.

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
- Parallel role work starts without a concurrency plan, lease, stop condition, and join condition;
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
- A fourth revision is routed on one task without running the Review Round Checkpoint.
- A human checkpoint is skipped before implementation or merge, requested for a routine in-scope
  step, or ignored after merge approval while the agent starts a new task first.
- Sequential actions are presented as numbered alternatives, or a numeric choice is acted on without
  restating the chosen action.
- Backend used differs from `task_backend` in `.agenticloop/project.md` without an explicit exception.
- Delegation prompt is missing scope, out of scope, or stop condition.
