---
name: parallel-delegation
description: Use when an authorized multi-task work unit has 2 or more ready task records and the orchestrator must decide serial versus parallel execution, or when planning, reviewing, joining, or troubleshooting parallel lanes, leases, backend-specific parallel writes, or bounded delegation liveness.
metadata:
  area: orchestration
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: optional
---

# Parallel Delegation

This skill contains the trigger-loaded parallel-lane law. Worktree placement,
worktree lifecycle, and non-interactive Git rules remain in
agenticloop/AGENTIC_LOOP.md because they also apply to serial worktree cleanup
and ordinary delegated Git work.

#### Parallel Opportunity Scan

**Trigger.** Any authorized work unit (phase, group, milestone, epic, task set,
or other bounded multi-task unit) that has 2 or more ready task records.

Before selecting an execution order, the orchestrator must complete this scan.
The maintainer supplies per-task code/collision classifications through
`## Parallel Safety`; the orchestrator uses those classifications as primary
input, adds host/lane capability checks, and records the final parallel or
serial decision. Do not jump straight to serial delegation for a multi-task unit
without this scan.

For each ready task, the scan must cover:

- **Dependency edges** -- which other tasks must finish first.
- **Expected files or owned paths** -- the task's scope map (`Expected Files or
  Areas` plus `allowed_paths`).
- **Backend objects owned** -- task file(s), GitHub issue/PR, or other backend
  records the lane mutates.
- **Shared/generated files** -- bundlers, codegen output, fixtures, snapshots.
- **Lockfiles** -- dependency manifests and lockfiles.
- **Schemas/APIs** -- shared schema or API ordering dependencies.
- **External state** -- databases, services, deployment targets, shared fixtures.
- **Labels/comments/event logs/group state** -- shared coordination surfaces.
- **Host parallel capability** -- whether the host can stream, cancel, or
  surface subagent status, or enforce bounded leases.

Decision after the scan:

- If 2 or more tasks are independent (no dependency edge between them) and the
  collision criteria are **known and disjoint**, prefer a bounded parallel batch
  over serial execution.
- **Default maximum parallel implementation lanes: 3.** Use fewer when fewer
  independent ready tasks exist or the host cannot safely sustain three lanes.
  Only exceed 3 when project config or an explicit human instruction raises the
  limit.
- Serial execution remains valid, but only with a concrete recorded reason --
  for example a real dependency edge, a shared generated file or lockfile, a
  schema/API ordering requirement, shared external state, or a host that cannot
  surface or bound parallel lanes.
- "Parallel coordination is complex" or "parallel has overhead" is **not** a
  sufficient serial reason. Name a concrete collision or host limitation, or run
  the bounded parallel batch.

After the implementation join, review is a new coordination/review phase. A
parallel implementation plan does not automatically authorize parallel review
lanes, but the same scan evidence should be reused. When 2 or more review-ready
artifacts have distinct review targets, distinct backend objects, no shared
labels, comments, status markers, event logs, or group state, and no need to
compare, join, or order artifacts during review, prefer a bounded parallel
review batch. Serial review after eligible review candidates exist requires a
concrete recorded reason; do not serialize review just because integration and
merge are serial. Posting review markers, updating `review_status`, changing
labels, and emitting events are coordination/review writes, so the orchestrator
must record or extend the concurrency plan for those review lanes. Integration
and merge remain serial after review unless a specific case is shown safe to
parallelize. The hard safety rules below are not relaxed by the scan: every
parallel write lane still requires its own worktree/branch, its own owned
PR/issue or task file, a join condition, a lease, and (for GitHub batches) a
merge barrier.

Durable review outcomes (`accepted` or `needs_revision`) wait for the
implementation batch join. A plan may authorize an earlier read-only review pass
against a completed lane's fixed artifact, but that pass must not post the
durable review marker, update review status, accept the task, or close the task
until the implementation join has succeeded or the orchestrator has recorded an
explicit partial-join decision that classifies every unfinished lane as failed or
blocked. After the join, the maintainer must either confirm the earlier
read-only findings still apply to the current artifact revision before posting a
durable outcome, or run a fresh review.

#### Lane Types

- **Read-only lane**: inspects fixed artifacts and returns findings. No VCS
  isolation is required.
- **Write lane**: may mutate repository files, task records, GitHub issues, PRs,
  labels, comments, local event logs, branches, generated artifacts, or other
  durable workflow or project state.
- **Implementation lane**: a write lane that changes target project files.
  Normally belongs to engineer.
- **Coordination/review lane**: a write lane that changes task records, GitHub
  issue/PR metadata, review comments, labels, closeout summaries, event logs,
  or other workflow state. Normally belongs to maintainer or orchestrator.

Parallel delegation is allowed only after the orchestrator records a
concurrency plan in the task record or coordination output. The plan must name:

- lane id and lane type,
- role invoked for each lane,
- read-only or write mode for each lane,
- owned backend objects for each lane,
- worktree path and branch for each write lane that mutates repository files,
- implementation or workflow artifact for each write lane,
- allowed files or areas for each lane,
- shared files, generated files, lockfiles, schemas, APIs, and external state
  that could collide,
- liveness checkpoint cadence and stop condition for each delegated lane,
- join condition before durable review outcome, acceptance, merge, or closeout.

Safe parallel work is limited to:

- **Read-only discovery** against fixed artifacts. No VCS isolation is required
  when no lane writes to the repository.
- **Parallel write lanes** with real VCS isolation and disjoint ownership. Every
  write lane that mutates repository files requires its own `git worktree` and
  its own branch. A branch alone is not sufficient when multiple agents share
  one checkout, because unstaged changes, uncommitted edits, and index state in
  a shared working tree are invisible to other lanes and create silent
  collisions. Copying selected touched files into a temporary folder is not
  valid isolation and must not be used as a substitute for a real worktree.

Additionally, parallel write lanes must have disjoint allowed files or areas, no
shared generated files or lockfiles, no schema or API ordering dependency, no
shared external state, and no overlapping task-record or backend-object updates.

**Unknown collision criteria.** Unknown collision criteria must not start write
lanes -- never open parallel write lanes on guesswork. But unknown is not an
automatic verdict of serial when the work unit has 2 or more ready candidates and
the only blocker is missing information. In that case, run a bounded read-only
discovery step first -- exactly one pass -- before deciding. Route
code/collision unknowns (dependency edges, owned paths, shared/generated files,
lockfiles, schemas/APIs, and external state) to the maintainer unless the
maintainer already returned a bounded discovery result. Resolve coordination/host
unknowns (host parallel capability, worktree availability, leases, stop
conditions, and join conditions) in the orchestrator. Use this discovery pass
only when parallel work is otherwise
plausible: 2 or more ready candidates, no known hard dependency edge, and the
unknown fact is the only blocker. After discovery, decide one of:

- a parallel batch with a recorded concurrency plan, when the criteria came back
  known and disjoint, or
- serial execution with a concrete disqualifying reason.

If uncertainty remains after bounded discovery, run serial and record what stayed
unknown. Do not loop discovery indefinitely; one bounded discovery pass then a
decision.

Before mutating repository files in a parallel write lane, the delegated role
must verify the assigned worktree path and branch, and check
`git status --short --untracked-files=all` for clean or expected state. If the
worktree or branch is wrong, dirty unexpectedly, or a collision appears, the
role must return status or a blocker instead of continuing.

### Backend-Specific Parallel Write Rules

**GitHub backend (`task_backend: github`) -- implementation lanes.** Each
parallel implementation lane requires:

- its own `git worktree` at a repo-internal path (see Worktree placement),
- its own task branch,
- its own GitHub issue (task record),
- its own pull request,
- disjoint expected files or areas,
- no shared generated files, lockfiles, schema, API, or external-state
  collision,
- a lease with observable-step checkpoint cadence, stop condition, and
  no-progress budget,
- a join condition before durable review outcome, acceptance, merge, or closeout,
- a merge barrier (see below).

**GitHub backend -- coordination/review lanes.** Parallel maintainer or
orchestrator lanes that mutate GitHub backend state (issues, PRs, labels,
review comments, status markers, closeout markers, event logs) may run only
when each lane owns distinct backend objects -- for example, distinct issues or
distinct PR review targets -- and the concurrency plan proves that no shared
labels, comments, status markers, closeout state, event logs, or group state
collide. If lanes must touch the same issue, PR, or label set, run them
serially.

**GitHub merge barrier.** No pull request in a parallel batch is merged into the
default or integration branch until every parallel lane has returned, maintainer
review is complete, cross-branch conflict and ordering risk has been checked, and
the human approves the merge order. If a pull request is safe to merge
independently, do not model it as part of a parallel batch.

**Files backend (`task_backend: files`) in a Git repository.** Each parallel
write lane requires:

- its own `git worktree` at a repo-internal path (see Worktree placement),
- its own local branch,
- its own `.agenticloop/tasks/<TASK-ID>.md` task file or explicitly owned
  workflow file(s),
- its implementation or workflow artifact recorded as `branch:<name>` plus
  `commit:<sha>` or `range:<base>..<head>` in the task file (patch is a
  fallback, not the preferred form),
- disjoint expected files or areas,
- a lease,
- a join condition.

**Files backend -- coordination/review lanes.** Parallel files-backed
coordination/review lanes that mutate task files, workflow files, event logs,
status markers, closeout summaries, scratch outputs, or other local state are
files-backed write lanes. They require the worktree, branch, owned task file or
workflow file, lease, and join-condition isolation above. Each lane must own
distinct task files or workflow artifacts, and no lane may share an event-log
target, group state, status marker, closeout file, scratch output, or other
append/update target. If the review writes must touch shared local state, run
review serially or defer that write to a single serial integration/closeout lane.

Integration of parallel files-backed lanes is serial. After the implementation
join, prefer bounded parallel coordination/review lanes under the files-backend
coordination/review lane rules above when there is no comparison, joining, or
ordering requirement during review. Otherwise review happens one lane at a time
after all lanes return. Merge remains serial.

**Files backend without Git.** Parallel write lanes are not allowed. Run all
write work serially. Read-only parallel discovery is still allowed when bounded
by fixed artifacts.

### Join Behavior

The orchestrator must not wait indefinitely for a lane that cannot produce its
expected artifact. At join time, missing expected artifacts are classified as
failed or blocked lanes, not pending lanes:

- GitHub implementation lane: missing pushed branch or missing PR.
- Files implementation lane: missing local commit or range.
- Coordination/review lane: missing expected task-record update, review marker,
  or status marker.

A lane that cannot produce its artifact must return status or a blocker. The
orchestrator records the failure, classifies the join outcome, and reports it
to the human instead of spinning.

### Delegation Liveness

Every delegation prompt has a stop condition. Long-running or parallel
delegations must also have a lease: a host-enforced duration or milestone when
relevant, an observable-step checkpoint cadence, and a no-progress budget. The
delegated role returns status instead of continuing indefinitely when the lease
expires, the no-progress budget is exhausted, the branch or worktree is wrong, a
collision is discovered, or the stop condition is reached.

The progress checkpoint cadence is a return-to-orchestrator cadence, not an
async heartbeat, unless the host explicitly surfaces running-subagent status.
Wall-clock duration is cooperative unless the host enforces it; prefer concrete
observable-step counts, milestones, and no-progress budgets for model-followed
leases. An observable step is a tool call, backend operation, artifact update,
verification check, status return, or blocker record; private reasoning is not a
step. A lease is not a hard kill switch for a runaway subagent.

Observability requirements scale with lane duration, and do not disqualify all
parallelism by themselves:

- **Long-running parallel delegation** requires live status and cancellation, or
  strictly bounded leases. If the host cannot stream, cancel, or otherwise
  surface subagent status while a role is running, do not start long-running
  parallel delegation. Use bounded serial delegation whose stop condition returns
  control to the orchestrator.
- **Short bounded parallel batches** may run without live streaming when every
  lane has a clear expected artifact, a stop condition, an observable-step lease,
  a no-progress budget, and a join condition. A host that cannot stream live
  status does not, on its own, forbid a short bounded join-based batch.

If host limitations make even bounded join-based parallelism unverifiable -- the
orchestrator cannot confirm lane artifacts at join -- run serial and record the
host limitation as the concrete reason.
