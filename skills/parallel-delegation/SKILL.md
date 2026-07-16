---
name: parallel-delegation
description: Use when an authorized multi-task work unit has 2 or more ready task records and the orchestrator must decide serial versus parallel execution, or when planning, reviewing, joining, or troubleshooting parallel lanes, leases, backend-specific parallel writes, bounded delegation liveness, knowledge coupling between lanes, cross-lane finding routing, verification topology across base/lane/integrated/merged trees, or a non-publishing integration rehearsal.
metadata:
  area: orchestration
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: optional
---

# Parallel Delegation

This is the trigger-loaded parallel-lane law. Worktree lifecycle and Git rules
remain in `agenticloop/AGENTIC_LOOP.md`.

## Parallel Opportunity Scan

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
- **Test and validation surfaces** -- writable tests, fixtures, snapshots,
  generated expectations, and shared validation helpers.
- **Backend objects owned** -- task file(s), GitHub issue/PR, or other backend
  records the lane mutates.
- **Shared/generated files** -- bundlers, codegen output, fixtures, snapshots.
- **Lockfiles** -- dependency manifests and lockfiles.
- **Schemas/APIs** -- shared schema or API ordering dependencies.
- **External state** -- databases, services, deployment targets, shared fixtures.
- **Labels/comments/event logs/group state** -- shared coordination surfaces.
- **Shared assumptions and invariants** -- facts about behavior, formats,
  contracts, or verification interpretation that sibling tasks rely on.
- **Discoveries that could affect other tasks** -- likely findings whose
  appearance in one lane would invalidate another lane's assumptions, plan,
  implementation, or verification interpretation.
- **Knowledge coupling** -- the maintainer-recorded classification
  `independent | coupled | unknown` from `## Parallel Safety`; see Knowledge
  Eligibility below.
- **Host parallel capability** -- whether the host can stream, cancel, or
  surface subagent status, or enforce bounded leases, and whether it can inject
  a message into a running lane.

Decision after the scan:

- If 2 or more tasks are independent on both dimensions (no dependency edge
  between them, knowledge classification `independent`) and the collision
  criteria are **known and disjoint**, prefer a bounded parallel batch over
  serial execution.
- **Default maximum parallel implementation lanes: 3.** Use fewer when fewer
  independent ready tasks exist or the host cannot safely sustain three lanes.
  Only exceed 3 when project config or an explicit human instruction raises the
  limit.
- If tasks are mutation-disjoint but knowledge-coupled, use the two-wave
  pattern (parallel read-only diagnosis, reconciliation, then serial or
  re-planned implementation) instead of parallel implementation writes.
- Serial execution is allowed only with a concrete recorded reason: dependency,
  collision, unresolved coupling, or host limitation. Complexity or overhead
  alone is not a sufficient serial reason.

Review is a new coordination phase. Reuse the scan evidence, but separately
authorize parallel review only for distinct artifacts and backend objects with
no shared state or comparison/order requirement. Review writes require an
extended concurrency plan; integration and merge remain serial. Every parallel
write lane still needs its own worktree/branch, owned backend object, lease,
join condition, and any GitHub merge barrier.

Durable review outcomes wait for the implementation join. An authorized early
read-only pass cannot update durable review state; after a full or explicit
partial join, confirm its findings against the current revision or review again.

## Knowledge Eligibility

Mutation independence is necessary but not sufficient. The maintainer also
classifies knowledge coupling per task in `## Parallel Safety` as
`independent`, `coupled`, or `unknown`:

- **independent** -- no likely discovery in one lane can invalidate another
  lane's assumptions, plan, implementation, or verification interpretation.
  Parallel writes may proceed when every mutation and host-safety rule also
  passes.
- **coupled** -- the tasks share assumptions, invariants, contracts, or
  verification interpretations that a discovery in one lane could change.
  Parallel implementation writes are not allowed as-planned. Use the two-wave
  pattern below.
- **unknown** -- the maintainer cannot yet tell. Use the existing
  one-bounded-discovery-pass rule from the scan, then classify as independent
  or coupled. If uncertainty remains after that pass, run serially and record
  what stayed unknown.

Separate worktrees isolate mutation only. They never convert coupled or unknown
tasks into independent tasks: two lanes that write disjoint files but share a
behavioral assumption are still coupled.

### Two-wave pattern for coupled work

When the classification is `coupled`:

1. **Wave 1 -- bounded parallel read-only diagnosis.** Run the affected lanes
   as read-only diagnosis lanes with fixed artifacts, leases, and explicit
   cross-lane finding declarations. No lane writes implementation files.
2. **Reconciliation at the join.** The orchestrator collects the diagnosis
   findings, routes relevant ones, obtains dispositions, and the maintainer
   reconciles them into resolved assumptions, an amended task record, or a
   re-scoped plan before any implementation write begins.
3. **Wave 2 -- implementation.** Implement serially, or run a newly justified
   parallel implementation plan whose knowledge classification is now
   `independent` with a recorded reason. The wave-2 plan must restate the
   resolved assumptions each lane now relies on.

If a finding must be consumed before implementation can safely continue, the
two-wave pattern (or serial execution) is mandatory: do not start parallel
implementation writes and hope to route the finding mid-flight.

## Cross-Lane Findings

Every parallel lane declares cross-lane findings at each configured lease
checkpoint and at its final return. A lane with nothing relevant explicitly
returns:

```text
Cross-lane findings: none
```

Otherwise the lane returns one or more structured findings:

- **Finding id** -- stable within the batch (for example `B1-F2`).
- **Fact or invariant** -- the discovered fact, stated as a claim another lane
  could apply or revalidate against.
- **Evidence reference** -- the durable pointer backing the claim (task-file
  section, PR, commit, check output location).
- **Affected lane ids, or `none`** -- lanes whose assumptions, plan,
  implementation, or verification interpretation the finding could change.
- **Requested response** -- `apply` (adopt the fact and continue) or
  `revalidate` (recheck assumptions, plan, or evidence against the fact).

Orchestrator routing duties:

1. Collect checkpoint and join findings from every lane return.
2. Determine whether each finding is relevant to another lane. Route only
   findings with declared cross-lane relevance; ordinary lane-local debugging
   detail stays in that lane's status or task summary and is not routed.
3. Route each relevant finding through the recipient lane's next delegation or
   resume prompt (the `Routed findings:` field in [[role-delegation]]).
4. Require the recipient to record exactly one disposition per routed finding:
   - `applied`
   - `already satisfied`
   - `rejected` with evidence
   - `deferred` with a reason
5. Keep the batch join incomplete while any routed finding lacks a disposition.

A disposition records handling; it does not by itself make the finding
non-blocking. `deferred` completes the join only after maintainer/orchestrator
triage records that the finding does not invalidate current scope, correctness,
safety, acceptance, or integrated evidence and classifies it as an accepted
limitation or follow-up. Otherwise the finding blocks the join and routes to
revision or [[blocked-state]].

Do not create a findings ledger or a shared mutable findings file. Findings
live in lane status returns and are recorded in the existing concurrency plan
or coordination output, which remains the single-writer durable surface. The
orchestrator must not edit a task file currently owned by an active write lane;
record routing before resuming the lanes on an orchestrator-owned coordination
surface, or serially after the relevant lanes have stopped and returned their
artifacts.

Host honesty: when the host cannot inject a message into a running agent, do
not pretend otherwise. Route at the next checkpoint or at the join. When a
finding must be consumed before implementation continues, use the two-wave
pattern or serialize the affected work instead of relying on asynchronous
delivery the host cannot perform.


## Lane Types

- **Read-only lane**: inspects fixed artifacts and returns findings.
- **Write lane**: mutates project or durable workflow state.
- **Implementation lane**: engineer write lane for target project files.
- **Coordination/review lane**: maintainer/orchestrator write lane for task,
  review, backend, closeout, or event state.

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
- the knowledge-coupling classification (`independent | coupled | unknown`) for
  each lane pair, with the two-wave pattern recorded when any pair is coupled,
- the checkpoint and join finding-routing procedure: how cross-lane findings
  are declared, routed, and answered, and the rule that the join is incomplete
  while any routed finding lacks a disposition,
- the verification topology for every planned check: stable check id, exact
  command, purpose, owner, target artifact revision or tree, relevant
  environment/toolchain assumptions, execution phase (`baseline`, `lane-final`,
  `integrated`, or `post-merge`), reuse eligibility, and rerun trigger,
- the integration-rehearsal trigger and owner when combined-state proof is
  required, or the recorded reason it is omitted,
- the intended artifact composition order for integration,
- the rerun/invalidation trigger that makes earlier integrated or rehearsal
  evidence stale,
- liveness checkpoint cadence and stop condition for each delegated lane,
- join condition before durable review outcome, acceptance, merge, or closeout,
  covering finding dispositions and required integrated evidence.

Safe parallel work is limited to:

- **Read-only discovery** against fixed artifacts. No VCS isolation is required
  when no lane writes to the repository.
- **Parallel write lanes** with real VCS isolation and disjoint ownership. Every
  write lane that mutates repository files requires its own `git worktree` and
  branch. A branch in a shared checkout or a copied-file directory is not
  isolation because worktree and index state still collide.

Additionally, parallel write lanes must have disjoint allowed files or areas, no
shared generated files or lockfiles, no schema or API ordering dependency, no
shared external state, and no overlapping task-record or backend-object updates.

## Test And Validation Surfaces

Test files, fixtures, snapshots, generated expectations, and shared validation
helpers are writable collision surfaces exactly like production files.

If two lanes need to edit the same test module or shared validation helper,
they are not parallel-write eligible unless the work is explicitly:

- combined into one lane,
- performed as parallel read-only diagnosis followed by serial writes,
- implemented as explicitly stacked branches with a recorded dependency and
  order, or
- deferred to an exclusively owned serial integration task.

A lane that discovers mid-flight that it must touch a test module or shared
helper owned by another lane stops and returns status instead of writing.

**Unknown collision criteria must not start write lanes.** When missing
information is the only blocker for 2 or more parallel candidates, run one
bounded read-only discovery step first. Maintainer owns code/collision unknowns;
orchestrator owns host, worktree, lease, stop, and join unknowns. After
discovery, decide:

- a parallel batch with a recorded concurrency plan, when the criteria came back
  known and disjoint, or
- serial execution with a concrete disqualifying reason.

If uncertainty remains after bounded discovery, run serial and record it; do
not repeat discovery.

Before mutating repository files in a parallel write lane, the delegated role
must verify the assigned worktree path and branch, and check
`git status --short --untracked-files=all` for clean or expected state. If the
worktree or branch is wrong, dirty unexpectedly, or a collision appears, the
role must return status or a blocker instead of continuing.

## Backend-Specific Parallel Write Rules

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

## Join Behavior

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

The join is also incomplete while a routed finding lacks a disposition, a
`deferred` finding lacks the required non-blocking triage, or required
integrated evidence is missing or stale. Artifact presence alone is not a
successful join.

## Verification Topology

Every check in a parallel concurrency plan is classified by the tree it runs
against. A lane green result is evidence about one exact lane head only; it is
not evidence about the batch.

- **baseline** -- runs once against the verified shared base tree. Establishes
  pre-existing failures and starting state. May be referenced by all lanes only
  under the strict reuse conditions below.
- **lane-final** -- runs against one exact lane head or tree. Must be fresh
  after that lane's final relevant edit, per [[verification-evidence]]. Cannot
  be reused as final proof for another lane.
- **integrated** -- runs against the composed candidate tree at join. Required
  when knowledge coupling, adjacent behavior, shared invariants, or
  ordering/composition risk exists; optional for demonstrably disjoint lanes
  only with a recorded reason in the concurrency plan.
- **post-merge** -- runs against the actual merged tree when it differs from
  the rehearsed candidate. Conflict resolution, ordering, or content
  differences between the rehearsed candidate and the real merge invalidate the
  earlier integrated evidence.

For every planned check, the concurrency plan records: stable check id, exact
command, purpose, owner, target artifact revision or tree, relevant
environment/toolchain assumptions, execution phase, reuse eligibility, and
rerun trigger.

Evidence identity is not command plus branch name. It is the exact clean
artifact tree or immutable revision, the exact command, and the relevant
dependency/toolchain/environment state. The same command on different branch
heads is different evidence.

Baseline reuse is allowed only when all of the following hold:

- the base tree is identical and clean,
- the command is identical,
- relevant dependency/toolchain/environment state is materially identical,
- the prior result and sufficient output are accessible,
- the reused result is used only to establish baseline state.

Baseline reuse never satisfies a lane-final, integrated, review, acceptance, or
post-merge final-state claim. One verified base run may establish baseline
state for multiple lanes when the identity conditions hold; it still proves
nothing about any lane head or combined tree. An accepted verification decision
may change execution strategy (focused, split, background, CI) but must not
silently convert stale evidence into fresh evidence.

## Integration Rehearsal

Integration rehearsal is the risk-triggered combined-state proof for a parallel
batch. Individually green coupled branches are not proof the composition works.

Trigger: the concurrency plan authorizes a rehearsal when knowledge coupling,
adjacent behavior, shared invariants, or ordering/composition risk makes
lane-final evidence insufficient. The trigger scales with risk: a demonstrably
disjoint batch may omit the rehearsal with a recorded reason; a coupled batch
with composition risk may not. Not every parallel batch needs an expensive
full-suite rehearsal -- a small coupled batch may rehearse with only the
affected shared suite.

Definition and rules:

- It runs serially after all expected implementation artifacts have returned.
- It runs in a dedicated engineer integration-verification lane or an
  equivalent engineer-owned step explicitly assigned by the orchestrator. It is
  not orchestrator-inline implementation work.
- It uses a disposable, non-published candidate composed from the verified base
  plus the lane artifacts in the intended order recorded in the concurrency
  plan.
- It must not update the protected default or integration branch.
- It must not push, publish, open or merge a pull request, accept work, or
  bypass the human merge checkpoint.
- It must be explicitly named and authorized in the concurrency plan, with its
  owner, trigger, and intended composition order.
- When composition is clean, run the affected shared suite, and the full suite
  when risk warrants.
- Record the exact combined tree or commit, artifact order, commands, and
  results as integrated evidence bound to that candidate.
- If composition produces conflicts requiring semantic judgment, do not
  silently resolve them in the rehearsal. Return a conflict/ordering result and
  route revisions to the owning task branches.
- If the eventual real merged tree differs from the rehearsed candidate, the
  integrated evidence is stale and the required checks rerun (post-merge
  phase).
- Actual merge remains a human-approved operation. An integration rehearsal is
  never merge authorization, and a successful rehearsal never merges, pushes,
  publishes, or accepts anything by itself.

Rehearsal liveness: the rehearsal lane gets a lease like any other delegation
-- an observable-step checkpoint cadence, a no-progress budget, and a stop
condition. Its expected artifact is the rehearsal result: the exact combined
tree/commit, the composition order, the commands run, their verdicts, and any
conflict/ordering outcome. A rehearsal lane that cannot produce that artifact
returns status or a blocker; the orchestrator classifies the missing rehearsal
result as a failed or blocked lane at join instead of treating the batch as
verified.

Backend-neutral: the rehearsal procedure above is identical across backends.
Backend projections only change where the durable records live -- see
`agenticloop/backends/files.md` and `agenticloop/backends/github.md` for the
concise backend-specific statements. The full procedure is not restated there.


## Delegation Liveness

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
