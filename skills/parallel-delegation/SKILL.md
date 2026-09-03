---
name: parallel-delegation
description: Use when an authorized multi-task work unit needs its required current Parallel Opportunity Scan, especially when 2 or more ready independent tasks may parallelize, or the orchestrator must decide serial versus parallel execution, or when planning, reviewing, joining, troubleshooting, or boundedly reconciling parallel lanes, leases, structured write ownership, classified managed joins, distinct shared exports or package scripts, backend-specific writes, knowledge coupling, cross-lane finding disposition, semantic conflict between lane artifacts, verification topology, integration rehearsal, or the human merge checkpoint.
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

**Trigger.** Every authorized multi-task work unit receives one current scan per
meaningful readiness snapshot. Source plans are inputs only, never scan results
or parallel authorization.

Before ordering work, Orchestrator records the scan in canonical `## Concurrency
Plan`, an authorized task-record surface, or single-writer output, never every
task or a shared mutable ledger. Maintainer supplies per-task code/collision and
joinability classifications through `## Parallel Safety`; Orchestrator verifies
task, artifact, host, liveness, and join inputs and routes the decision without
originating or overriding semantic/code classification.

**Decide inventory completeness before ready count:**

1. incomplete inventory or decomposition -> `incomplete`; never an eligibility
   answer, however few tasks are visible. Repair the evidence and rescan.
2. complete inventory, zero ready tasks -> `no_eligible_work`.
3. complete inventory, one ready task or no valid candidate pair ->
   `not_currently_eligible`, recorded as `not currently eligible - <n> ready
   task(s)` plus a rescan trigger.
4. only complete, fresh, fully accounted inventory -> `parallel_candidates`;
   then assess below.

Rescan when inventory membership or enumeration coverage, task carrier digests,
base or dependency evidence, ready membership, task scope or ownership, shared
design assumptions, base artifact, host capability, backend collision state, or
a cross-lane finding changes.

**Producing the scan.** Run the read-only
`npx agenticloop task prepare-decomposition <task-id> --work-unit <id>
--source-ref <path> --source-revision <ref> (--base <ref> | --base-paths <path>)
--dependencies <path>`. It enumerates the configured task surface itself,
issues a typed enumeration receipt, validates the emitted record with the same
validator dispatch uses, and prints the committable decomposition source as
canonical JSON. It mutates nothing: redirect its output to `--source-ref` and
commit that file with canonical Maintainer attribution. Producer, persister, and
freshness rules come from the canonical transition fact definitions.

For each ready task, the scan must cover:

- **Dependency edges** - which other tasks must finish first.
- **Scope and write ownership** - `Expected Files or Areas` and `allowed_paths`
  are the broad scope/deviation map; machine-readable `owned_paths` is the
  expected exclusive write projection, and `shared_mutations` names any exact
  shared file and predicted operation.
- **Test and validation surfaces** - writable tests, fixtures, snapshots,
  generated expectations, and shared validation helpers.
- **Backend objects owned** - task file(s), GitHub issue/PR, or other backend
  records the lane mutates.
- **Shared/generated files** - bundlers, codegen output, fixtures, snapshots.
- **Lockfiles** - dependency manifests and lockfiles.
- **Schemas/APIs** - shared schema or API ordering dependencies.
- **External state** - databases, services, deployment targets, shared fixtures.
- **Labels/comments/event logs/group state** - shared coordination surfaces.
- **Shared assumptions and invariants** - facts about behavior, formats,
  contracts, or verification interpretation that sibling tasks rely on.
- **Discoveries that could affect other tasks** - likely findings whose
  appearance in one lane would invalidate another lane's assumptions, plan,
  implementation, or verification interpretation.
- **Knowledge coupling** - the maintainer-recorded classification
  `independent | coupled | unknown` from `## Parallel Safety`; see Knowledge
  Eligibility below.
- **Host parallel capability** - whether the host can stream, cancel, or
  surface subagent status, or enforce bounded leases, and whether it can inject
  a message into a running lane.

The durable scan result contains:

```text
### Parallel Opportunity Scan

- Work unit:
- Inventory identity and digest:
- Inventory completeness: complete | incomplete
- Decomposition source, revision, and state: complete | incomplete
- Ready-set snapshot:
- Excluded tasks (task, reason code, evidence):
- Source proposals considered:
- Configured maximum implementation lanes:
- Candidate lanes:
- Mutation independence:
- Knowledge independence:
- Coupling blockers:
- Decision scope:
- Shared design questions:
- Backend/worktree ownership:
- Host and liveness capability:
- Verification/integration implications:
- Observed at and freshness policy:
- Decision: parallel <lane ids> | serial | not currently eligible | incomplete
- Independent rationale:
- Rescan trigger:
```

The executable contract for this shape is `agenticloop.parallel-scan` schema
version `3` (see the parallel-scan provenance section of
`agenticloop/AGENTIC_LOOP.md`). Every discovered inventory member is accounted
for exactly once, as ready or as an explicit exclusion with a stable reason
code. Exclusion reason codes are `record_unreadable`, `record_malformed`,
`identity_ambiguous`, `lifecycle_terminal`, `dependency_unresolved`, and
`not_ready`.

Schema version 3 binds a canonical dependency context per inventory task. Each
declared dependency is resolved from that task's committed snapshot or from the
authoritative carrier identity/status in the same inventory. External
dependencies require explicit committed evidence. The complete per-task context
is scan-digest and freshness bound, so changing any member's relevant evidence
stales the work-unit scan. Version 2 scans used the initiating task's map for
every member and must be regenerated; single-task version 3 scans retain the
same CLI workflow.

Inventory completeness is derived from the authoritative enumerator's typed
receipt, never declared. An unreadable, malformed, duplicate, or ambiguous task
record stays an inventory member and makes completeness fail closed; a truncated
inventory or a stale observation is incomplete.

Before dispatch, refetch the authoritative backend inventory and the scan's
bound readiness context rather than reusing the authored scan input. Inventory
identity, membership, and carrier digests, plus the bound base and dependency
evidence, must still match. Treat any omitted, new, unreadable, or changed task -
or a changed base or dependency status - as stale scan evidence and rescan before
assigning a lane.

The orchestrator records which source proposals it considered, accepts, narrows,
reorders, or rejects each after current-state reassessment, and states its own
rationale. A copied proposal conclusion is not a valid scan.

Decision after the scan:

- If 2 or more tasks are independent on both dimensions (no dependency edge
  between them, knowledge classification `independent`) and structured ownership
  is **known and disjoint**, prefer a bounded parallel batch over serial
  execution. A Maintainer-classified `managed_join` is the one bounded exception
  for exact additive shared operations; allowed-path overlap alone is neither a
  collision nor a managed-join classification.
- **Configured maximum parallel implementation lanes:** read
  `max_parallel_implementation_lanes` from `.agenticloop/project.md` (default
  `5`). It applies only to implementation lanes and is a ceiling, never a target
  or total-live-agent budget. Effective lane count is the minimum of this value,
  ready mutation-independent and knowledge-independent tasks, and host-supported
  bounded lanes. Review, coordination, and integration lanes do not inherit it.
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

- **independent** – no likely discovery in one lane can invalidate another
  lane's assumptions, plan, implementation, or verification interpretation.
  Parallel writes may proceed when every mutation and host-safety rule also
  passes.
- **coupled** – the tasks share assumptions, invariants, contracts, or
  verification interpretations that a discovery in one lane could change.
  Parallel implementation writes are not allowed as-planned. Use the two-wave
  pattern below.
- **unknown** – the maintainer cannot yet tell. Use the existing
  one-bounded-discovery-pass rule from the scan, then classify as independent
  or coupled. If uncertainty remains after that pass, run serially and record
  what stayed unknown.

Separate worktrees isolate mutation only. They never convert coupled or unknown
tasks into independent tasks: two lanes that write disjoint files but share a
behavioral assumption are still coupled.

### Two-wave pattern for coupled work

When the classification is `coupled`:

1. **Wave 1 – bounded parallel read-only diagnosis.** Run the affected lanes
   as read-only diagnosis lanes with fixed artifacts, leases, and explicit
   cross-lane finding declarations. No lane writes implementation files.
2. **Reconciliation at the join.** The orchestrator collects the diagnosis
   findings, routes relevant ones, obtains dispositions, and the maintainer
   reconciles them into resolved assumptions, an amended task record, or a
   re-scoped plan before any implementation write begins.
3. **Wave 2 – implementation.** Implement serially, or run a newly justified
   parallel implementation plan whose knowledge classification is now
   `independent` with a recorded reason. The wave-2 plan must restate the
   resolved assumptions each lane now relies on.

If a finding must be consumed before implementation can safely continue, the
two-wave pattern (or serial execution) is mandatory: do not start parallel
implementation writes and hope to route the finding mid-flight.

## Project Operating Facts In Parallel Lanes

`.agenticloop/project.md`, including its `## Project Operating Facts` profile, is
shared mutable state. Engineer implementation lanes do not append or edit Project
Operating Facts and always return candidates. A maintainer-owned coordination
lane may mutate the profile only when the concurrency plan grants it explicit
exclusive ownership of `.agenticloop/project.md` and proves no collision.
Otherwise, a candidate that affects a sibling lane's assumptions uses the
cross-lane finding route below, a non-sibling-affecting candidate stays a process
observation or status item, and one serial maintainer-owned join step applies
approved facts. See the Project Operating Facts section in
`agenticloop/AGENTIC_LOOP.md`.

## Cross-Lane Findings

Every lane declares cross-lane findings at each lease checkpoint and final
return. With nothing relevant, return:

```text
Cross-lane findings: none
```

Otherwise the lane returns one or more structured findings:

- **Finding id** – stable within the batch (for example `B1-F2`).
- **Fact or invariant** - a claim another lane can apply or revalidate.
- **Evidence reference** - its durable task section, PR, commit, or check output.
- **Affected lane ids, or `none`** - whose work or interpretation could change.
- **Requested response** - `apply` or `revalidate`.

Orchestrator routing duties:

1. Collect checkpoint and join findings from every lane return.
2. Route declared cross-lane relevance only; lane-local debugging stays in that
   lane's status/task summary.
3. Route each relevant finding through the recipient lane's next delegation or
   resume prompt (the `Routed findings:` field in [[role-delegation]]).
4. Require the recipient to record exactly one disposition per routed finding:
   - `applied`
   - `already satisfied`
   - `rejected` with evidence
   - `deferred` with a reason
5. Keep the batch join incomplete while any routed finding lacks a disposition.

A disposition records handling; it does not by itself make the finding
non-blocking. `deferred` completes the join only after Maintainer records that
the finding does not invalidate current scope, correctness,
safety, acceptance, or integrated evidence and classifies it as an accepted
limitation or follow-up. Otherwise the finding blocks the join and routes to
revision or [[blocked-state]].

Do not create a findings ledger or a shared mutable findings file. Findings live
in lane returns and the existing single-writer durable surface. Orchestrator
never edits a task file owned by an active write lane; record routing on its own
coordination surface before resume, or serially after lanes return.

If the host cannot inject a message into a running agent, do not pretend
otherwise. Route at checkpoint/join; findings required before more writes force
two-wave or serial work.


## Lane Types

- **Read-only lane**: inspects fixed artifacts and returns findings.
- **Write lane**: mutates project or durable workflow state.
- **Implementation lane**: engineer write lane for target project files.
- **Coordination/review lane**: a single-owner Maintainer lane for semantic
  task/review disposition, or an Orchestrator lane for routing and orchestration
  state. Orchestrator verifies a Maintainer disposition; it does not decide one.

Parallel delegation is allowed only after the orchestrator records a
concurrency plan in the task record or coordination output. The plan must name:

- lane id and lane type,
- role invoked for each lane,
- read-only or write mode for each lane,
- owned backend objects for each lane,
- worktree path and branch for each write lane that mutates repository files,
- implementation or workflow artifact for each write lane,
- allowed files or areas plus structured exclusive `owned_paths` for each lane,
- every exact `shared_mutations` path and per-lane predicted operation, if any,
- per-task eligibility (`eligible | blocked | unknown`) and each candidate
  pair's relation (`disjoint | managed_join | blocked | unknown`),
- decision scope for each lane and the shared design questions that remain with
  the maintainer or a serial reconciliation step,
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
- for managed join only: Maintainer's operation classification, the dedicated
  backend-neutral join task/owner, exact lane base/head artifacts, named conflict
  paths, its existing attempt budget and lease, mandatory integrated checks, and
  escalation route,
- the rerun/invalidation trigger that makes earlier integrated or rehearsal
  evidence stale,
- liveness checkpoint cadence and stop condition for each delegated lane,
- join condition before durable review outcome, acceptance, merge, or closeout,
  covering finding dispositions and required integrated evidence.

Shared design questions must be resolved by the maintainer or a serial
reconciliation step before parallel implementation writes. Alternatively, use
the two-wave read-only diagnosis and reconciliation pattern. Disjoint files do
not imply independent design authority, and a lane-local design choice must stay
within its recorded decision scope.

Safe parallel work is limited to:

- **Read-only discovery** against fixed artifacts. No VCS isolation is required
  when no lane writes to the repository.
- **Parallel write lanes** with real VCS isolation and disjoint ownership. Every
  write lane that mutates repository files requires its own `git worktree` and
  branch. A branch in a shared checkout or a copied-file directory is not
  isolation because worktree and index state still collide.

Additionally, parallel write lanes must have disjoint structured `owned_paths`,
unless this skill's explicit managed-join law classifies their exact shared
operations; no shared generated files or lockfiles, no schema or API ordering
dependency, no shared external state, and no overlapping task-record or
backend-object updates. `allowed_paths` remains the broad scope/deviation map
and cannot by itself produce a collision verdict.

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

The only parallel exception is a Maintainer-classified managed join under the
next section. It does not make a test/helper file generally mergeable: each lane
must still declare an exact file and one supported additive operation.

A lane that discovers mid-flight that it must touch a test module or shared
helper owned by another lane stops and returns status instead of writing.

**Unknown collision criteria must not start write lanes.** When missing
information is the only blocker for 2 or more parallel candidates, run one
bounded read-only discovery step first. Maintainer owns code/collision unknowns;
orchestrator owns host, worktree, lease, stop, and join unknowns. After
discovery, decide:

- a parallel batch with a recorded concurrency plan, when the criteria came back
  known and disjoint;
- a Maintainer-classified `managed_join` when discovery proves every exact
  shared operation and the complete join plan satisfies the law below; or
- serial execution with a concrete disqualifying reason.

If uncertainty remains after bounded discovery, run serial and record it; do
not repeat discovery.

Before mutating repository files in a parallel write lane, the delegated role
must verify the assigned worktree path and branch, and check
`git status --short --untracked-files=all` for clean or expected state. If the
worktree or branch is wrong, dirty unexpectedly, or a collision appears, the
role must return status or a blocker instead of continuing.

## Backend-Specific Parallel Write Rules

**GitHub backend (`task_backend: github`) – implementation lanes.** Each
parallel implementation lane requires:

- its own `git worktree` at a repo-internal path (see Worktree placement),
- its own task branch,
- its own GitHub issue (task record),
- its own pull request,
- disjoint structured `owned_paths`, or a valid managed-join plan for an exact
  classified shared mutation,
- no shared generated files, lockfiles, schema, API, or external-state
  collision,
- a lease with observable-step checkpoint cadence, stop condition, and
  no-progress budget,
- a join condition before durable review outcome, acceptance, merge, or closeout,
- a merge barrier (see below).

**GitHub backend – coordination/review lanes.** Parallel maintainer or
orchestrator lanes that mutate GitHub backend state (issues, PRs, labels,
review comments, status markers, closeout markers, event logs) may run only
when each lane owns distinct backend objects – for example, distinct issues or
distinct PR review targets – and the concurrency plan proves that no shared
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
- disjoint structured `owned_paths`, or a valid managed-join plan for an exact
  classified shared mutation,
- a lease,
- a join condition.

**Files backend – coordination/review lanes.** Parallel files-backed
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

- **baseline** – runs once against the verified shared base tree. Establishes
  pre-existing failures and starting state. May be referenced by all lanes only
  under the strict reuse conditions below.
- **lane-final** – runs against one exact lane head or tree. Must be fresh
  after that lane's final relevant edit, per [[verification-evidence]]. Cannot
  be reused as final proof for another lane.
- **integrated** – runs against the composed candidate tree at join. Required
  when knowledge coupling, adjacent behavior, shared invariants, or
  ordering/composition risk exists; optional for demonstrably disjoint lanes
  only with a recorded reason in the concurrency plan.
- **post-merge** – runs against the actual merged tree when it differs from
  the rehearsed candidate. Conflict resolution, ordering, or content
  differences between the rehearsed candidate and the real merge invalidate the
  earlier integrated evidence.

For every planned check, the concurrency plan records: stable check id, exact
command, purpose, owner, target artifact revision or tree, relevant
environment/toolchain assumptions, execution phase, reuse eligibility, and
rerun trigger.

Evidence identity is the exact clean artifact tree or immutable revision,
command, and relevant dependency/toolchain/environment state, not command plus
branch. The same command on different branch heads is different evidence.

Baseline reuse is allowed only when all of the following hold:

- the base tree is identical and clean,
- the command is identical,
- relevant dependency/toolchain/environment state is materially identical,
- the prior result and sufficient output are accessible,
- the reused result is used only to establish baseline state.

Baseline reuse never satisfies a lane-final, integrated, review, acceptance, or
post-merge final-state claim. One verified base run may establish baseline state
for multiple lanes under these identity conditions but proves no lane or
combined tree. Strategy may change; stale evidence never becomes fresh silently.

## Integration Rehearsal

Integration rehearsal is the risk-triggered combined-state proof for a parallel
batch. Individually green coupled branches are not proof the composition works.

Trigger: the concurrency plan authorizes a rehearsal when knowledge coupling,
adjacent behavior, shared invariants, or ordering/composition risk makes
lane-final evidence insufficient. The trigger scales with risk: a demonstrably
disjoint batch may omit the rehearsal with a recorded reason; a coupled batch
with composition risk may not. Not every parallel batch needs an expensive
full-suite rehearsal – a small coupled batch may rehearse with only the
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
- an observable-step checkpoint cadence, a no-progress budget, and a stop
condition. Its expected artifact is the rehearsal result: the exact combined
tree/commit, the composition order, the commands run, their verdicts, and any
conflict/ordering outcome. A rehearsal lane that cannot produce that artifact
returns status or a blocker; the orchestrator classifies the missing rehearsal
result as a failed or blocked lane at join instead of treating the batch as
verified.

Backend-neutral: the rehearsal procedure above is identical across backends.
Backend projections only change where the durable records live – see
`agenticloop/backends/files.md` and `agenticloop/backends/github.md` for the
concise backend-specific statements. The full procedure is not restated there.

## Managed Join

A managed join is an opt-in bounded exception to disjoint mutation ownership,
not a second workflow or project-wide switch. Ordinary worktree, lease, finding,
evidence, review, and human merge barriers still apply.

### Classification and authorization

Each task remains `eligible`, `blocked`, or `unknown`; each pair is `disjoint`,
`managed_join`, `blocked`, or `unknown`. Maintainer alone classifies code/collision joinability
and operation; Orchestrator verifies the supplied required inputs, host/liveness/join facts,
records and routes without overriding it. `disjoint` means structured `owned_paths` are
mechanically disjoint. Broad `allowed_paths` overlap never proves collision;
unknown/malformed ownership gets one bounded read-only pass, then serial if still
unknown. Never start speculative writes.

`managed_join` requires all of the following before writes begin:

- lanes are `eligible`, dependency- and knowledge-independent, with no exclusive
  overlap;
- every overlap is an exact `shared_mutations` file, never a glob, with distinct
  supported additive operations; and
- Maintainer records commutativity, ordered exact base/head lane artifacts,
  dedicated join task/owner, its existing attempt budget/lease, conflict paths,
  integrated checks, escalation, and invalidation for artifact, operation, or
  order change.

Only distinct named exports and `package.json#scripts` keys are mechanically
classified. Same export/key, dependency selection, ordering/coupling, or an
unclassified operation is `blocked`/`unknown`.
Lockfiles, migrations, generated state, competing definitions, semantic/external/coordination
state, task/project records, event logs, scratch, and group/status/closeout state are ineligible;
use a combined, stacked, or serial task.

### Artifact-bound lane return

Each lane returns exact base/head artifacts and derives its diff from that range
or the exact GitHub PR file list, never an ambient working tree. Changes outside
exclusive ownership or declared shared operations, missing identity/diff, or a
new overlap stop the lane. Artifact, operation, or order changes invalidate
classification/evidence; a changed promoted or landed tree also invalidates
evidence and review.

A changed shared file also requires exact base/head content proof. A file-list
match alone is insufficient: `add_json_key` proves that only the absent declared
`scripts.<key>` was added, and `add_export` proves an additive export line for
only the declared symbol with no removed or rewritten content. GitHub reads the
shared file at the immutable PR base and head SHAs. Any other content change
stops the lane.

### Dedicated join task and bounded reconciliation

The join is a dedicated backend-neutral task, never a hidden lane merge: record
its owner, base, ordered lanes, reconciliation revision, final artifact,
integrated evidence/review identity, and staleness triggers. Clean composition
still runs mandatory integrated checks on the exact candidate.

Only after all lanes return may Orchestrator explicitly delegate Engineer
reconciliation of Maintainer-pre-classified mechanical operations. The packet
names join/base/lane artifacts, order, permitted operations and exact conflict
paths, checks, existing join-task attempt budget/lease, and stop. Engineer edits
only those paths, records exact result/resolution diff, and reruns integrated
checks after the final edit. Use existing `task`, `role`, `check.run`, and
`review` events: no reconciliation event, role, or budget.

Ambiguous, semantic, architectural, scope/contract-expanding, exhausted, or
check-failing work stops: route code ambiguity to Maintainer, contract change to
change-request/human authority, and lane defects to owners. Engineer never
chooses design, publishes, accepts, merges, or edits unrelated content. After
green final checks, Maintainer runs a fresh full ordered Lens 1, Lens 2, and Lens 3 review
on the exact join artifact; files bind `reviewed_artifact == implementation_artifact`,
GitHub markers bind exact join head, and human promotion/merge remains separate.


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

Each prompt selects exactly one cadence: return after every record, or return
after each explicit batch of N records. Contradictory combinations are invalid.
Also bind an unexpected-tooling diagnostic budget. At exhaustion the lane
returns `tooling_failure`, `needs_context`, or the applicable blocked category
with the failing command, child exit/structured result, attempted repairs, and
untouched remaining work. A completed host tool envelope without a successful
child exit is a failure observation, not progress.

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

If host limitations make even bounded join-based parallelism unverifiable – the
orchestrator cannot confirm lane artifacts at join – run serial and record the
host limitation as the concrete reason.
