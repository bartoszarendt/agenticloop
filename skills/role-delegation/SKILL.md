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
| Plan scope, acceptance criteria | maintainer |
| Implement scoped work | engineer |
| Revise after review feedback | engineer |
| Review implementation artifacts | maintainer |
| Accept or request revision | maintainer |
| Closeout and retrospective | maintainer |

The orchestrator does not create task records, implement, review, or accept.

## Host Delegation Mechanism

Real delegation means the host starts a separate role, task, or subagent execution and the
invocation accepts a role, agent, type, mode, or `subagent_type` argument. Prose describing what a
role would do is not delegation.

Host delegation includes any mechanism with that shape, for example:

- `task(subagent_type="maintainer")`,
- `task(subagent_type="engineer")`,
- an OpenCode Task-tool subagent invocation,
- explicit `@maintainer` or `@engineer` invocation.

OpenCode examples are examples, not the definition.

## Delegation Capability Check

Before using single-agent fallback, the orchestrator must explicitly check whether the host exposes
any real delegation mechanism for the requested role.

- If a host task, subagent, role, agent, type, mode, or `subagent_type` mechanism exists for
  maintainer or engineer, fallback is not allowed for that role.
- If delegation is absent, record how that was verified.
- If delegation is available but the concrete attempt fails, record the failed mechanism and the
  failure reason before considering fallback.
- Include the capability check result in the orchestrator's delegation output.

For OpenCode:

- use Task-tool subagent invocation, or
- use explicit `@maintainer` or `@engineer` invocation to create a visible subagent session.

## Concurrency Policy

Delegation is serial by default. Multiple subagents do not permit parallel
loops.

Parallel delegation is legal only after the orchestrator records the
concurrency plan required by `agenticloop/AGENTIC_LOOP.md`: lanes, roles,
read/write mode, branches or worktrees, allowed files or areas, possible shared
resources, liveness checkpoint cadence, stop condition, and join condition. If any
collision criterion is unknown, run serially.

For GitHub-backed parallel implementation, each task uses its own branch and
pull request. No batch pull request may merge until every lane has returned,
maintainer review is complete, cross-branch risk is checked, and the human
approves merge order.

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

Recommended `role.invoked` data fields:

- `target_role`
- `delegation_mode`: `host_subagent`, `explicit_agent_invocation`, or `single_agent_fallback`
- `fallback`: boolean
- `adapter`
- `model` only when explicitly known from adapter config
- `reason`

Example host delegation event:

```text
npx agenticloop event-logging role.invoked --task T-001 --role orchestrator --summary "Delegated engineer implementation" --ref "github:issue:42" --data-json '{"target_role":"engineer","delegation_mode":"host_subagent","fallback":false,"adapter":"opencode","model":"<model-id>","reason":"Task record is ready for implementation"}'
```

Example fallback event:

```text
npx agenticloop event-logging role.invoked --task T-001 --role orchestrator --summary "Started fallback maintainer review pass" --ref "task-file:.agenticloop/tasks/T-001.md" --data-json '{"target_role":"maintainer","delegation_mode":"single_agent_fallback","fallback":true,"adapter":"opencode","reason":"Host review delegation is unavailable after an explicit capability check"}'
```

## Single-Agent Fallback

Single-agent fallback is legal only after the delegation capability check shows that no real host
delegation exists for the requested role, or after a concrete delegation attempt fails.

If fallback is allowed, the current agent may explicitly assume the requested role for one bounded
role step only when the host and human allow it.

When using this fallback:

- announce it in output,
- record the capability-check result and fallback reason,
- follow the assumed role's boundaries and required skills,
- stop at the assumed role's normal stop condition,
- bound the fallback to that one role step,
- emit `role.invoked` when event logging is enabled,
- do not claim host delegation happened.

This fallback must be an explicit role assumption, not prose about what the
other role would do.

If neither host delegation nor single-agent role assumption is allowed by the
host or human, use [[blocked-state]] with category `contract` and stop.

## Review Round Checkpoint

The orchestrator counts `needs_revision` rounds per task. Before routing a fourth
revision on the same task, run the Review Round Checkpoint in `agenticloop/AGENTIC_LOOP.md`:
classify the churn cause, then route one targeted revision plan that names the cause
or record `needs_context` or `blocked` with [[blocked-state]]. Do not route an
undirected fourth revision.

## Delegation Prompt Shape

When invoking a role, the orchestrator prompt must include:

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

An issue comment with implementation evidence is not the implementation artifact for normal
GitHub-backed code or documentation changes. It is supporting evidence for the pull request.
The task is not terminally complete until the PR is reviewed, accepted, and merged or otherwise
closed through an explicit backend exception.

For automated work, the pull request path applies to docs, configuration, workflow, and
infrastructure changes as well as runtime code. Human-authored repository maintenance may
remain outside Agentic Loop when the human intentionally handles it, but automated roles must
not use that as permission to commit task work directly to the default or integration branch.
A no-PR exception for agent-authored GitHub-backed work must be human-approved and recorded in
the task record before implementation starts.

A task branch has one terminal merge path. If its pull request has already been merged by
merge commit, squash, or rebase, do not merge the same task branch again as a second path for
the same work. Stop for human direction if the branch state is unclear.

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

- Orchestrator output describes what a role "will do" without invoking it.
- Orchestrator narrates what maintainer or engineer would do instead of using host delegation or an explicit fallback role assumption.
- Single-agent fallback used without a recorded delegation capability check.
- A host task or subagent tool exists for maintainer or engineer but was not used.
- Delegation output says unknown after the agent has already started role work.
- Maintainer or engineer work appears inline in an orchestrator message.
- Parallel subagents were started without a recorded concurrency plan and join condition.
- Parallel write lanes share a branch, worktree, implementation artifact, task record, or mutable files without an explicit serial join.
- A long-running or parallel delegated role has no lease, observable-step checkpoint cadence, no-progress budget, or stop condition.
- Task record exists only as a local file when `task_backend: github` is set.
- GitHub-backed implementation is delegated without branch, commit, push, and PR expectations.
- Maintainer review is delegated as an issue-comment review instead of a PR diff review.
- Orchestrator treats an accepted issue comment as task completion before the PR is reviewed.
- Agent-authored task work is committed directly to the default or integration branch.
- Files-backed task record is left in `draft` when implementation or review delegation starts.
- Files-backed implementation delegation does not require `implementation_artifact` to be updated.
- Files-backed implementation summary exists only in chat and not in the task file.
- Files-backed implementation summary was silently rewritten without a dated correction entry.
- Files-backed task record is untracked at review time and no local-only exception was recorded.
- Files-backed review delegation leaves `review_status` unset or stale after review.
- A fourth revision is routed on one task without running the Review Round Checkpoint.
- Docs, configuration, workflow, or infrastructure changes are treated as exempt from the
  GitHub branch and PR path merely because they are "not code."
- A task branch is merged again after the linked pull request was already merged for the same
  work.
- A pull request from a GitHub-backed parallel batch is merged before every lane returned,
  maintainer review completed, cross-branch conflict and ordering risk was checked, and the
  human approved merge order.
- Human checkpoint was skipped before implementation or merge.
- Human approval was requested for a routine step inside an authorized work unit, such as
  asking whether to proceed to maintainer review once the implementation artifact is ready.
- Human approved merge but agent started a new task first.
- Sequential actions were presented as numbered alternatives.
- Agent interpreted a numeric choice without restating the chosen action.
- Backend used differs from `task_backend` in `.agenticloop/project.md` without an explicit exception.
- Delegation prompt is missing scope, out of scope, or stop condition.
