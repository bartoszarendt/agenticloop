# Agentic Loop Methodology

Agentic Loop is a supervised implementation workflow for AI coding agents. It
turns a vague request into a durable task record, a scoped implementation,
evidence, review, and closeout.

The methodology is host-neutral. All five implemented host adapters — OpenCode,
Codex, Claude Code, GitHub Copilot, and Cursor — are supported. The workflow
should read naturally in any agent that can follow Markdown instructions and
load skills.

## Activation Boundary

Full Agentic Loop operation requires explicit activation. Discovering the
installed toolkit or reading this document does not activate the methodology.

Activate the full loop — adopt the roles, create or continue a durable task
record, run backend operations, worktrees, event logging, review, and closeout
— only when at least one of these is true:

- The user explicitly asks to use Agentic Loop.
- The user invokes the host's Agentic Loop activation command, prompt, or skill.
- The user explicitly asks to implement, continue, review, accept, or close a
  tracked Agentic Loop work unit.

The following do not activate the methodology: merely discovering `agenticloop/`,
reading this document, mentioning a task ID without operational intent, or asking
for status, orientation, explanation, or discussion. For that ordinary work,
follow the target repository's rules document directly. Reading this document to
answer a question about the methodology is expected and allowed; adopting it as
the current process is not.

**Standalone engineer delegation is not activation.** The main agent may invoke
the generated engineer as an ordinary bounded subagent for a normal engineering
subtask. Standalone engineer use requires no activation, task ID, or task record
and creates no Agentic Loop workflow state. See the Glossary entries for
**Activation** and **Standalone engineer**.

## Deactivation Boundary

`stop` is the host-neutral Agentic Loop deactivation term. It deactivates the
methodology only for the current conversation; it does not exit the host,
terminate unrelated host terminals, close a task, or clean up worktrees. The
canonical stop contract is `agenticloop/commands/stop.md`.

On stop, authorize no new Agentic Loop work or role spawning. Inspect active
delegations, background work, and lanes; safely interrupt Agentic Loop work only
when the host exposes that control, otherwise report it without waiting
indefinitely. Preserve material unfinished progress with a concise dated task
record checkpoint when needed, including the last completed action, current
artifact or branch/worktree, verification already run, and next concrete action.
Leave the durable task status unchanged unless an independent blocker exists; a
voluntary stop is not `blocked` or `needs_context`.

Stop never implies acceptance, closeout, commit, push, merge, branch deletion,
or worktree cleanup. After a stop summary, later user messages do not resume the
methodology automatically: the user must invoke the normal explicit activation
surface again.

## Core Objects

| Object | Meaning |
|---|---|
| Agent role | A host-neutral role definition in `agenticloop/agents/<role>.md`. |
| Skill | A focused procedure in `agenticloop/skills/<name>/SKILL.md`. |
| Decision record | A tracked Markdown record for a durable project decision that constrains future work. |
| Task record | The durable record for one unit of work. Stored as a local Markdown file by default; GitHub issues are an optional projection. |
| Task backend | The configured storage projection for task records. Backend docs live in `agenticloop/backends/`. |
| Event log | An optional local JSONL log of explicit workflow-gate events written through the Node CLI when a project enables event logging. |
| Grouping | An optional task bucket such as a phase, milestone, epic, or custom group. |
| Summary | The completion summary for a task, written inline in the task record (the `## Scope Completed` section, or the PR body for GitHub-backed work). There is no separate summaries store; closeout verifies these inline summaries and posts a status marker rather than publishing a new file. |
| Pull request | The reviewable implementation artifact for GitHub-backed work. |

## Glossary

Stable Agentic Loop vocabulary lives in this installed process document so
target projects do not need toolkit-root `docs/` files at runtime.

- **Agentic Loop**: the supervised workflow methodology in this repository.
- **Activation**: the point at which the full methodology becomes the current
  process. Activation is explicit only: the user asks to use Agentic Loop,
  invokes the host activation surface, or asks to implement, continue, review,
  accept, or close a tracked work unit. Installation, discovery, reading the
  methodology, or mentioning a task ID for discussion does not activate it.
- **Deactivation**: current-conversation termination of Agentic Loop requested
  with the exact `stop` argument. It checkpoints unfinished work safely without
  changing task status solely because the user stopped. Reactivation is explicit.
- **Standalone engineer**: the generated engineer invoked as an ordinary bounded
  subagent without activating Agentic Loop. Standalone delegation takes its scope
  from the parent request and repository rules, requires no task ID or task
  record, and creates no Agentic Loop task records, events, worktrees, review, or
  closeout state. See `agenticloop/agents/engineer.md` for the two engineer modes.
- **Agent role**: a host-neutral role definition installed under
  `agenticloop/agents/<role>.md`.
- **Skill**: a focused procedure installed under
  `agenticloop/skills/<name>/SKILL.md`.
- **Workflow**: a sequence of skills and gates used to complete a kind of work.
- **Task record**: the durable record for one unit of work. Local Markdown task
  files are the default; GitHub issues are an optional projection.
- **Task backend**: the configured storage projection for task records.
- **Backend projection**: a backend-specific mapping from shared task-record
  operations to storage commands or file edits.
- **Task ID**: the durable identifier used in task records, branches, pull
  requests, and commit trailers. Default example: `T-001`.
- **Grouping**: an optional task bucket such as a phase, milestone, epic, or
  custom group.
- **Phase**: one possible grouping profile.
- **Orchestrator**: the coordination role that drives the task lifecycle and
  delegates work.
- **Maintainer**: the planning and review role that writes task records,
  reviews implementation artifacts, triages follow-ups, and owns closeout.
- **Engineer**: the scoped implementation role that changes files, runs checks,
  and publishes evidence.
- **Required checks**: exact commands or manual checks that must be run before a
  task can be accepted.
- **Verification operating fact**: a current, maintainer-owned execution fact in
  `.agenticloop/project.md` about a project-wide check, identified as `VF-...`.
  It records observed behavior and a current strategy; it is not by itself a
  policy decision.
- **Project Operating Fact**: a current, mutable, maintainer-owned, source-linked,
  non-binding, project-wide operating fact in `.agenticloop/project.md`,
  identified as `PF-...`. It records reusable project operating reality; it is
  not a decision and does not by itself constrain future work. See the Project
  Operating Facts section for the full definition.
- **Proof pressure**: the optional task-record practice of naming a completion
  oracle, final proof required, and likely misfire to keep work aligned with the
  owner's outcome. Proof pressure complements acceptance criteria; it does not
  replace them.
- **Maintainer Review Fixup**: a bounded Pass 2 review exception in which the
  maintainer applies one fully understood quality correction to the artifact
  under review, refreshes final-state evidence, re-reviews, and accepts without
  an engineer revision handoff. Eligibility, procedure, and provenance are owned
  by [[review-and-accept]]. A successful fixup is part of the current review
  round, not a `needs_revision` round; independent-review tasks are ineligible.
- **Needs context**: a task state used when the task record is ambiguous or
  incomplete and can be corrected by the maintainer.
- **Blocked task**: a durable paused state requiring human action or external
  change.
- **Change request**: a task that changes a locked architecture, process, or
  repository decision and must pass an approval gate before implementation.
- **Mutation independence**: the parallel-eligibility dimension in which lanes
  do not collide in writable files, test and validation surfaces, backend
  objects, generated state, schemas, APIs, external state, or other durable
  state.
- **Knowledge independence**: the parallel-eligibility dimension in which no
  likely discovery in one lane can invalidate another lane's assumptions, plan,
  implementation, or verification interpretation. Classified per task as
  `independent`, `coupled`, or `unknown`; parallel write execution requires
  both mutation and knowledge independence.
- **Cross-lane finding**: a fact or invariant discovered in one parallel lane
  that is relevant to another lane, declared at a lease checkpoint or final
  return, routed by the orchestrator, and answered by the recipient with one
  disposition (`applied`, `already satisfied`, `rejected`, or `deferred`).
- **Verification topology**: the classification of a planned check as
  `baseline`, `lane-final`, `integrated`, or `post-merge`, together with the
  evidence-identity rule that a check result binds to the exact artifact tree
  or immutable revision, exact command, and relevant environment state it ran
  against.
- **Integration rehearsal**: a serial, engineer-owned, non-publishing
  combined-state proof step that runs planned checks against a disposable
  candidate composed from the verified base plus lane artifacts in the intended
  order. It is not a merge and grants no merge, push, publish, or acceptance
  authority.
- **Decision record**: a tracked Markdown record for a durable project decision
  that constrains future work. It is separate from task records.
- **Summary**: the completion summary for a task, recorded inline in the task
  record using `agenticloop/memory/work-unit-summary.md` (`summary_unit: task`).
  There is no separate summaries store; closeout verifies the inline summaries
  and posts a status marker.
- **Project skill**: a target-project, host-visible skill used for
  domain-specific procedures.
- **Host adapter**: documentation or tooling that lets a host use the same
  canonical roles, skills, and backend projections.
- **Local files backend**: supported default backend that stores task records
  under `.agenticloop/tasks/`.
- **GitHub backend**: optional backend that stores task records as GitHub issues
  and implementation artifacts as pull requests.
- **Toolkit-owned source**: canonical Agentic Loop package assets installed
  under `agenticloop/` in target repos.
- **Target-owned state**: durable project records under `.agenticloop/`.

## Directory Layout

An installed target repo has **two sibling directories that differ only by a
leading dot**. Conflating them is the most common path mistake — read the dot
before constructing any path.

| Path | Leading dot | Owner | Read/write | Holds |
| --- | --- | --- | --- | --- |
| `agenticloop/` | no | toolkit | read-only | `AGENTIC_LOOP.md`, `agents/`, `skills/`, `backends/`, `commands/`, `memory/`, `config.json` |
| `.agenticloop/` | yes | target project | read/write | `project.md`, `tasks/`, `decisions/`, `improvements/` (created on first proposal), `logs/`, `tmp/` |

The process doc is `agenticloop/AGENTIC_LOOP.md` (no dot) and the role files are
`agenticloop/agents/<role>.md` (no dot). Project state such as
`.agenticloop/project.md` and `.agenticloop/tasks/` is under the dotted
directory. Reading `.agenticloop/project.md` does not mean the process doc or
agents live beside it — those are under `agenticloop/`. When in doubt, list the
repository root and confirm which directory exists before guessing a sibling.

## Roles

Agentic Loop uses three logical roles. A host may implement these as agents,
modes, prompts, commands, or explicit human instructions.

The canonical role definitions live in `agenticloop/agents/`:

- `agenticloop/agents/orchestrator.md`
- `agenticloop/agents/maintainer.md`
- `agenticloop/agents/engineer.md`

Host adapters should bind to those role files rather than defining separate
role contracts.

## Source Documents

At the start of a non-trivial task, read `.agenticloop/project.md` for
`task_backend`, task naming, optional grouping settings, typed document
selections, and relevant current verification operating facts and Project
Operating Facts.

Document roles are:

- `rules`
- `plan`
- `overview`
- `process`
- `spec`
- `design`
- `context`
- `history`

If a role is selected in `.agenticloop/project.md`, use that path. If it is not
selected, use the bounded candidate names from the canonical document-role
registry in `agenticloop/config.json`. Do not scan the whole repository at
runtime.

The `context` document role is for target-owned domain context, product
vocabulary, or task-start context. It is not required for Agentic Loop's own
glossary.

## Context Read Discipline

Agents work from a closed normative context set, extend it only through bounded
task-scoped implementation discovery, and never load arbitrary repository
material. This section is the canonical owner of that cross-cutting rule; role
and skill files reference it rather than restating it.

### Normative context (closed)

The normative context set is:

- repository rules and the project map (`.agenticloop/project.md`) for backend, naming, grouping, and selected source documents,
- the current task record,
- the selected source documents listed in `.agenticloop/project.md` or the task record,
- decision records explicitly linked from those sources,
- the backend projection doc in `agenticloop/backends/` that matches `task_backend`.

This set is closed. Do not add a document to it unless the task record, project
map, or a human explicitly names that file.

### Bounded implementation discovery (permitted by default)

Implementation and review still need to see how code fits together. The
following task-scoped discovery is permitted by default, without a new
authorization, when it stays tied to the current task:

- available repository indexing or language-aware symbol, reference, and
  caller/callee lookup,
- exact identifier or known-path search,
- focused test discovery for the code under change,
- relevant version-control history for the touched files,
- directly connected schemas, generated consumers, configuration, callers, or
  tests reached from the above.

A previously unnamed caller or test found this way may be inspected and, when
necessary to satisfy the existing task scope, changed with a recorded deviation.

Default operational bound for one task:

- one bounded discovery pass,
- at most six previously unnamed paths or symbol bodies opened from discovery,
- symbol-level or relevant-range inspection before loading a whole file.

Normal reads already named by the task record or project map do not count
against this bound.

### Arbitrary context loading (prohibited)

These remain prohibited:

- broad repository dumps or scanning the whole tree at runtime to "find relevant files",
- indiscriminate full-file loading when a symbol or range is enough,
- unrelated documentation or logs,
- repeated exploratory scans without progress.

Do not treat `.agenticloop/logs/` as ambient context; read logs only through
explicit event-log audit or report commands, or when a task-scoped need is
stated in the task record or by the human. Do not treat `.agenticloop/tmp/` as
source context; it is scratch space only.

### Recording and escalation

Use the existing implementation-summary `## Deviations` section to record
discovery when it changes expected files or areas, exposes an unexpected
dependency, requires an implementation-plan deviation, or materially affects
review scope. Do not add a new mandatory task section for discovery.

Return `needs_context` when discovery exceeds the default bound, crosses into a
materially new product or architecture domain, contradicts task scope,
out-of-scope rules, or an accepted decision, or shows that completing the task
requires a broader contract. A directly connected discovered caller or test does
not by itself require `needs_context`; a material scope expansion still uses the
existing contract-change path.

## First-Run Bootstrap

At the start of the first non-trivial Agentic Loop task, read
`.agenticloop/project.md` before creating or selecting the first task.

If `setup_status` is `unconfirmed`, route setup or confirmation before
continuing. Confirmation may either record typed selections or explicitly accept
the default document, task naming, grouping, and backend conventions.

If no legal writer or delegation path is available for that confirmation, use
`blocked-state` with category `contract` and stop.

Do not repeatedly rescan or re-report the same setup gap once it has been
recorded.

## Advance Authorization Boundary

This boundary applies to every role, not only the orchestrator.

### Authorized Work Units

Authorization attaches to a bounded work unit, not to each workflow step. A work
unit may be one task, a task set, a phase/group, or another explicitly scoped
piece of work. Its scope is whatever the human named; if scope is ambiguous,
clarify before expanding (that is a checkpoint, not a license to continue).
Authorizing a phase, group, milestone, epic, or task set does not collapse that
unit into one task record. Before implementation starts, decompose it into
right-sized implementation task records unless the maintainer can show that the
whole unit is one independently verifiable task.

Right-sized means one independently verifiable task at a time by default, the
smallest useful implementation slice. When a human authorizes a larger bounded
run, prefer the largest safe useful slice that remains bounded, reversible, and
independently verifiable as one task. A phase, group, milestone, epic, or task
set authorization is not permission to create one oversized task record; task
sets still decompose into ordinary task records using the configured backend
and task ID convention.

Right-sized also accounts for active-context headroom. A task that is one
deliverable but likely cannot fit inside one engineer execution with safety
headroom is still too large; split it or tighten the expected files, checks, and
discovery bounds before implementation.

A work unit may authorize a whole task set, but materializing durable task
records for that set is incremental. Decomposition can be one planning pass;
full task records should be written in bounded chunks of one record by default,
or at most three simple records per batch, and checkpointed so an interruption
resumes from the first missing or invalid task.

When a human authorizes a work unit to run, continue, or finish, Agentic Loop
performs the routine lifecycle steps that unit needs under the configured
backend -- selecting included tasks, creating or updating task records,
delegating roles, implementing, recording evidence, updating implementation
artifacts, reviewing, revising, accepting, closing tasks, and running configured
closeout -- without a per-step approval prompt. These steps are routine inside
an authorized unit; only the hard checkpoints below interrupt them.

The loop continues until the unit reaches acceptance (plus configured closeout)
or hits a hard checkpoint. It stops short only when blocked -- see Attempt
Budget and [[blocked-state]].

### Serial Default And Parallel Exceptions

Agentic Loop is serial by default. One orchestrator should have one active
delegated role step for a task, and one mutable implementation artifact in one
worktree at a time. Do not launch parallel maintainer or engineer sessions just
because the host supports multiple subagents.

Concurrency safety is governed by mutation, not by role. A maintainer lane that
updates task records, GitHub issues, review comments, labels, or event logs can
collide with another lane just as easily as two engineer lanes if they share a
checkout, task record, GitHub issue/PR/comment stream, label set, event log,
branch, generated file, lockfile, schema, API surface, or other durable state.

Serial-by-default is a safety floor, not a preference for serial execution. When
a human authorizes a bounded multi-task unit, the orchestrator must actively look
for safe bounded parallelism before defaulting to serial. The default is not
"serial unless forced parallel"; it is "scan first, then choose."

#### Parallel Delegation Summary

Serial is the safety floor, but it is not a reason to skip analysis. When an
authorized multi-task work unit has 2 or more ready task records, the
orchestrator must load [[parallel-delegation]] and complete the Parallel
Opportunity Scan before choosing serial execution.

A bounded parallel batch is preferred when 2 or more ready tasks are independent
on both eligibility dimensions and collision criteria are known and disjoint.
Default maximum parallel implementation lanes: 3. Use fewer when fewer safe lanes
exist or the host cannot sustain three; exceed 3 only when project config or
explicit human instruction raises the limit.

Every parallel write lane needs its own owned backend objects, allowed files or
areas, implementation or workflow artifact, lease, and join condition. Every
write lane that mutates repository files also needs its own repo-internal
worktree and branch. Unknown collision criteria never start write lanes; run one
bounded read-only discovery pass when parallel work is otherwise plausible, then
record either a parallel plan or a concrete serial reason.

The concurrency plan must name lane id/type, role, read/write mode, owned backend
objects, worktree path and branch for file-mutating lanes, artifact,
allowed files/areas, collision risks, knowledge-coupling classification,
liveness cadence, stop condition, and join condition. Backend-specific write
rules, join behavior, and delegation liveness requirements live in
[[parallel-delegation]].

**Mutation independence and knowledge independence.** Parallel write execution
requires both. Mutation independence means lanes do not collide in writable
files, test and validation surfaces, backend objects, generated state, schemas,
APIs, external state, or other durable state. Knowledge independence means no
likely discovery in one lane can invalidate another lane's assumptions, plan,
implementation, or verification interpretation. Each task records a knowledge
classification of `independent`, `coupled`, or `unknown`: `independent` lanes may
run in parallel when every mutation and host-safety rule also passes; `coupled`
work uses the two-wave pattern (bounded parallel read-only diagnosis, findings
reconciliation at the join, then serial implementation or a newly justified
parallel plan); `unknown` uses the existing one-bounded-discovery-pass rule and
falls back to serial when uncertainty remains. Separate worktrees isolate
mutation; they never convert coupled or unknown tasks into independent tasks.

**Cross-lane findings.** At each lease checkpoint and final lane return, every
lane declares cross-lane findings or explicitly returns `Cross-lane findings:
none`. A finding names a fact or invariant, its evidence, the affected lanes (or
`none`), and a requested response (`apply` or `revalidate`). The orchestrator
routes a relevant finding to each affected lane, and the recipient must record
one disposition -- `applied`, `already satisfied`, `rejected` with evidence, or
`deferred` with a reason. A batch join is incomplete while any routed finding
lacks a disposition. A deferred finding remains join-blocking until
maintainer/orchestrator triage records that it cannot invalidate current scope,
correctness, safety, acceptance, or integrated evidence and classifies it as an
accepted limitation or follow-up. Findings live in lane status returns and the
concurrency plan or coordination output; there is no shared findings ledger.

**Verification topology.** Parallel check plans classify each check as
`baseline` (once against the verified shared base), `lane-final` (fresh against
one exact lane head after its final relevant edit), `integrated` (against the
composed candidate tree at join), or `post-merge` (against the actual merged
tree). Evidence identity is the exact artifact tree or immutable revision plus
the exact command plus relevant dependency/toolchain/environment state -- the
same command on different branch heads is different evidence. A verified
baseline may be referenced across lanes only under strict artifact and
environment identity and only to establish baseline state; it never satisfies a
lane-final, integrated, review, acceptance, or post-merge final-state claim.

**Integration rehearsal.** When knowledge coupling, adjacent behavior, shared
invariants, or ordering/composition risk makes individually green lane evidence
insufficient, the plan authorizes a risk-triggered integration rehearsal: a
serial, engineer-owned step that composes a disposable non-published candidate
from the verified base plus the lane artifacts in the intended order and runs
the affected checks against it. The rehearsal never updates the protected
default or integration branch, never pushes, publishes, merges, or accepts work,
and never bypasses the human merge checkpoint. It returns a conflict/ordering
result for owning task branches to revise rather than silently resolving
semantic conflicts. If the eventual real merged tree differs from the rehearsed
candidate, integrated evidence is stale and the required checks rerun.
Demonstrably disjoint batches may omit the rehearsal with a recorded reason.
Rehearsal details live in [[parallel-delegation]].

**Worktree placement.** Create each lane worktree with `npx agenticloop worktree
add <task-id> <branch> [--from <ref>]`. The command creates the worktree at
`.agenticloop/worktrees/<task-id>`, adds the worktree parent to the repository's
local Git exclude file, and installs worktree-scoped non-interactive Git config.
Do not create ordinary lane worktrees with raw `git worktree add`, and do not
create them as `../sibling` directories outside the root. A worktree outside the
repository root falls outside the host's workspace sandbox and triggers an
external-directory access prompt that stalls autonomous runs. If a target's
recursive tooling (test runners, linters, bundlers) forces a human-approved
external worktree exception, record the exception before delegation and
immediately run `npx agenticloop worktree guard --fix <path>` on that worktree.

**Worktree lifecycle.** After a task is accepted and its implementation artifact
is integrated, the lane worktree can be removed. Use `npx agenticloop worktree
cleanup --dry-run` to preview which standard `.agenticloop/worktrees/*` lanes are
safe to remove, then `npx agenticloop worktree cleanup --yes` to remove them.
Cleanup is destructive filesystem cleanup and requires the dry-run/yes
confirmation pattern. In dry-run JSON output, `wouldRemove` lists the planned
removals; no worktrees are deleted. It keeps open pull requests, locked worktrees, worktrees
with blocking dirty source or shared `.agenticloop` state, external or detached
worktrees, and lanes with active task state. Task-specific lane-local
`.agenticloop` state is flat only (`logs`, `tasks`, `summaries` (legacy;
preserved for migration only -- current projects do not create a summaries
directory), and `decisions` files directly under `.agenticloop/<dir>/`); it is
preserved before removal and does not by itself block cleanup. Nested or shared `.agenticloop` files are not
lane-local and dirty shared state blocks cleanup. Git worktree removal may be
forced internally only after preservation succeeds. For `.jsonl` lane-local
files, preservation is safe when the root file already contains every lane line
(a root superset), using a line-multiset check so repeated lines are not
collapsed. If lane-local preservation conflicts with existing root state, use
`npx agenticloop worktree resolve-state <task-id|path> --strategy
<prefer-root|prefer-worktree|union-jsonl> --yes` (default `--dry-run`) to
resolve before cleanup: `prefer-root` copies the root file into the lane,
`prefer-worktree` copies the lane file into the root, and `union-jsonl` computes
a root-first max-count multiset union of both files and writes the result to
both. `union-jsonl` is the recommended lossless strategy for JSONL log conflicts.
resolve-state never removes worktrees or branches. Shared `.agenticloop` files are not preserved. Project-root bare
coordinator repos (a `.git` directory inside the project root) are supported for
list, guard, add, and cleanup. Branch deletion is not part of v1 cleanup.
External or detached worktrees require explicit review; use `npx agenticloop
worktree remove <task-id|path> --yes` for single-worktree removal with lane-local
state preservation. `npx agenticloop worktree prune --dry-run` inspects stale Git
worktree registrations without touching real checkouts.

**Non-interactive Git.** Agentic Loop runs must not depend on a human closing a
Git editor, pager, or credential prompt. The host session or delegated lane
environment should set `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GH_EDITOR=true`, `GH_PAGER=cat`, and
`GH_PROMPT_DISABLED=1` before running Git or `gh`. `npx agenticloop worktree add`
enforces the Git config guard for delegated worktrees; use `npx agenticloop
worktree guard --fix --all` to repair existing Agentic Loop worktrees and
`npx agenticloop doctor` to report drift. The coordinator/main checkout is not
repaired by worktree guard so the user's interactive editor remains intact; it
must be protected by the session environment before coordinator Git or `gh`
commands run. Agents must use file-backed or
explicit-message forms such as `git commit -m` or `git commit -F`, `git merge
--no-edit`, `git --no-pager ...`, `gh pr create --title ... --body-file ...`, and
`git -c core.editor=true -c sequence.editor=true rebase --continue` when
continuing a resolved rebase. Do not run `git rebase -i`, bare `git commit`,
`git tag -a`, `git config --edit`, `gh pr create --editor`, or any other
editor-backed command in unattended lane work. If Git or `gh` is already waiting
on an editor or prompt, close/abort the operation and return status instead of
leaving the lane blocked.

`credential.interactive=false` is written for Git versions that support it. The
session-level `GIT_TERMINAL_PROMPT=0` guard remains required for older Git
versions and for coordinator/main-checkout credential prompts.

Parallel write-lane collision rules, backend-specific write rules, join behavior, and
delegation liveness details live in [[parallel-delegation]]. Load that skill
before planning or reviewing parallel lanes or joins.

Stop for human direction before:

- leaving the authorized work unit -- including starting any task, group, or
  phase outside it,
- merge, release, irreversible external publication, or destructive cleanup
  (including deleting branches),
- changing a locked process, architecture, backend, or product decision, or
  invoking a backend exception.

Standing authorization must be identifiable from one of these sources:

- the latest human message
- an active human instruction in the current session
- a durable task record, project map, or repository rule that explicitly grants
  the role permission to advance

If the authorization source cannot be named, treat it as absent.

Absent that authorization, treat the request as answer-and-stop: do only the
work needed to respond, report the result with evidence, state any uncertainty,
and stop. Requests that ask for information or a limited action -- checking
status, listing artifacts, inspecting history, explaining behavior, diagnosing a
failure, comparing options, or answering a question -- carry their own natural
stop condition and do not by themselves authorize any action above.

Discovering a possible next action is not authorization to take it. Report it as
a possible next action and let the human, or a standing authorization, decide.

## Command Output Discipline

A zero exit status is success. Empty output from a successful list, search, or
status command means "no matching results" unless the command documentation or
surrounding evidence says otherwise. Retry only when there is a concrete error,
an ambiguous exit state, or contradictory evidence. Do not repeat an equivalent
command just because the result is empty.

## Attempt Budget

Repeating an action that makes no progress is the most common loop failure.
Bound it with a shared attempt budget.

The default budget is 3, or the task record's `attempt_budget` when it sets one.
An attempt counts against the budget when it is equivalent to a previous one --
the same command, check, fix, delegation, or report against the same target --
and yields no new evidence or change in task state. A restated intended next
action that is not performed also counts as an attempt: deliberation that never
becomes an action is the same loop as a repeated action that never changes
state.

Progress is what resets the count: an observable new fact, a durable state
change, a backend update, an artifact change, a status return, or a blocker
record. Pure reasoning, restating intent, or re-verifying the same known fact is
not progress. A `blocked`, `needs_context`, or `complete` status return is
progress, because it changes loop state even when no artifact changed.

When the budget is exhausted, stop repeating. Record `needs_context` if the task
record can be amended, or `blocked` if a human decision is required, and report
what was tried. Do not spend the next turn on the same equivalent attempt.

This default of 3 governs repeated fix attempts in [[debugging-before-fixes]]
and a sustained-and-disputed review item in [[review-and-accept]]. Some guards
are deliberately tighter than the default: the empty-result command rule above,
the recorded-setup-gap rule, and the "maintainer is needed" stop in the
orchestrator do not get repeated attempts at all. The self-loop guard is also
tighter -- if a role states the same intended next action twice without
performing it, it stops deliberating on the second restatement and either
performs the action or records `blocked` category `no-progress`.

After producing an artifact that satisfies the current evidence, do not re-decide
or re-verify it unless new contradictory evidence appears. Take the next external
action or return status.

## Review Round Checkpoint

The attempt budget counts equivalent attempts and resets on new evidence, so a
task that fails review repeatedly with a different finding each round never
trips it. Bound that churn separately.

After 3 `needs_revision` rounds on one task -- or after the task record's
`review_budget` when it sets one -- the orchestrator pauses before routing the
next revision and classifies the churn cause:

- implementation defect -- the code is genuinely not done;
- evidence drift -- the code is fine but the durable summary cites a stale head;
- task-contract ambiguity -- acceptance criteria are underspecified;
- scope pollution -- unrelated changes entered the artifact;
- reviewer/engineer disagreement -- a sustained-and-disputed item;
- external blocker -- a dependency outside the task.

The orchestrator records the classification, then either routes a single
targeted revision plan that names the specific cause, or records
`needs_context` or `blocked` using [[blocked-state]] when a contract change or
human decision is required. A fourth undirected "try again" revision is not
allowed.

## Task Record Contract

Use `agenticloop/memory/task-record.md` as the canonical task-record shape.
It defines the ordered required sections, the optional sections, the completion
summary template handoff, and the reviewer checklist seed items.

No placeholders. Scope, acceptance criteria, and required checks must be
concrete enough to verify.

`Out of Scope` is mandatory. It prevents the agent from expanding the task
while implementing.

`Applicable Project Skills` is optional. Maintainer may record visible,
host-exposed target-project skills that are relevant to this task's domain.
Those project skills may be used for domain-specific procedures, but Agentic
Loop skills remain authoritative for task records, evidence, review,
blocked-state handling, and closeout.

`Proof Pressure` is optional. For ambiguous or long-running work, the maintainer
may require a concrete `Completion Oracle`, `Final Proof Required`, and `Likely
Misfire`. These fields help the engineer stay aligned with the owner's outcome
and help the reviewer verify that local success is real success. They complement
acceptance criteria; they do not replace scope, out-of-scope boundaries, or
required checks.

`## Outcome` is optional for routine clean tasks. It becomes conditionally
required at closeout when any of the following happened: review rounds > 1,
failed or triaged checks, blocked/needs_context state, scope drift, stale
evidence, human intervention, predicted medium/high context overflow risk,
context pressure encountered, or follow-ups. The section uses the task-record
Outcome fields, including `context_pressure_encountered`, for later pattern
mining.

## Verification Learning

`## Verification Operating Facts` in `.agenticloop/project.md` is the one
current, mutable, maintainer-owned profile for project-wide check behavior. It
uses the canonical `### VF-...` entries and fields in
[[verification-evidence]]. A fact records observed command behavior and the
current operational strategy; update or replace it when evidence changes rather
than accumulating competing facts for the same command.

`## Verification Attempts` in a task record is append-only per-check evidence.
New task records start with its canonical empty state. When a required or cited
check times out, the engineer appends the attempt; the maintainer later appends
the final triage. An `accepted` or `closed` task cannot retain a timed-out
attempt with missing or `pending` triage. The exact attempt, foreground
prediction, and triage shapes, retry limits, and event procedure are owned by
[[verification-evidence]]. Backend placement and append-only behavior are owned
by the matching backend projection.

## Project Operating Facts

`## Project Operating Facts` in `.agenticloop/project.md` is the one current,
mutable, maintainer-owned profile for lightweight project-wide operating
knowledge. A Project Operating Fact is current, mutable, maintainer-owned,
source-linked, non-binding, and project-wide. It records an operating reality
worth reusing; it is not a policy decision and does not by itself constrain
future work. This section is the canonical owner of the full definition; role
and skill files carry concise responsibilities and refer here rather than
restating it.

Project Operating Facts follow the Verification Operating Facts profile as a
precedent, not its verification-specific schema. Each fact is one compact bullet
with a stable `PF-...` identifier, a concise statement of current project
behavior or operating reality, a durable source reference, and a concrete
"Revisit when" trigger. Sources may include a task record, issue or PR, commit,
durable Markdown document, or directly relevant canonical source file. A fact
may wrap across physical lines but remains one logical bullet.

### Recognition test

Treat knowledge as a Project Operating Fact candidate only when all of these
hold:

1. it is likely to matter beyond the current task;
2. it describes current project-wide operating reality rather than one attempt;
3. it is not already recorded in an appropriate durable source, or is important
   enough to warrant a compact project-map pointer;
4. reconstructing it later would be costly, error-prone, or likely to lead to
   the wrong operational choice;
5. it is supported by identifiable evidence;
6. it is non-binding; otherwise it belongs in a decision record.

Use "not already explicit or cheaply discoverable" rather than "non-derivable":
a fact may be technically recoverable from several files while still being
expensive or error-prone to reconstruct.

### Routing

Route reusable knowledge to one durable destination. This is routing, not a
linear promotion sequence; a detailed runbook and a compact project-map pointer
may coexist.

| Knowledge type | Durable destination |
|---|---|
| Temporary observation or task-specific evidence | Current task record |
| Detailed command sequence, setup procedure, or operator runbook | Relevant project documentation |
| Compact pointer to an important runbook | Project Operating Facts |
| Current, non-binding project-wide operating fact | Project Operating Facts |
| Binding convention, policy, architecture, security, quality, or release rule | Proposed/accepted decision record |
| Repeated Agentic Loop process friction | Human-invoked retrospective or improvement artifact |
| Personal preference spanning repositories | Host memory outside Agentic Loop |

Keep detailed runbooks in normal project documentation; a fact may link to one
instead of duplicating it. Promote a fact to a decision record when it
constrains future implementation, architecture, security, quality, release
behavior, or accepted project conventions -- see [[decision-capture]]. A project
fact may cite a decision, but a fact is not approval.

### Ownership and updates

The maintainer owns this profile. Keep one active entry per fact; update or
remove a stale fact rather than accumulating contradictory entries; keep entries
compact. Never store secrets, credentials, raw transcripts, prompt logs, full
tool output, personal data, temporary debugging observations, or speculative
conclusions. Do not use a project fact to impose binding policy.

When recording the first fact, replace the canonical empty-state sentence,
`No project-wide operating facts are currently recorded.` When removing the
last fact, restore that sentence. Never retain the empty-state sentence beside
active `PF-...` entries.

### Capture at a natural checkpoint

When work reveals a supported Project Operating Fact candidate, report it at the
next natural checkpoint. If recording it is already within the authorized work,
the maintainer may update the profile. Otherwise, offer one concrete destination
and ask whether to preserve it. Consolidate and deduplicate multiple candidates
before offering; do not interrupt implementation for a candidate unless it
affects current correctness or another active lane; do not ask again after the
human declines; and do not silently expand task scope to write unrelated
documentation or shared workflow state. Declining or deferring capture does not
by itself block task acceptance or closeout.

### Existing targets and parallel writes

The section is optional and Markdown-first. Its absence in an existing project
map is valid; add `## Project Operating Facts` when the first fact is approved,
and never overwrite a target-owned project map to insert it. `.agenticloop/project.md`
is shared mutable state: engineer implementation lanes do not append or edit
Project Operating Facts and always return candidates. A maintainer-owned
coordination lane may mutate the profile only when the concurrency plan grants
it explicit exclusive ownership of `.agenticloop/project.md` and proves no
collision. Otherwise, sibling-affecting candidates use cross-lane findings and
one serial maintainer-owned join step applies approved facts. See
[[parallel-delegation]].

## Task Backends

The active task backend defines where task records live. Read `task_backend`
from `.agenticloop/project.md` frontmatter. The default is `files`.

Backend projection docs live in `agenticloop/backends/`:

- `agenticloop/backends/files.md` maps task records to local Markdown files under `.agenticloop/`.
- `agenticloop/backends/github.md` maps task records to GitHub issues, labels, comments, and pull requests.

## Event Logging

Event logging is optional. Agents must not attempt CLI event logging unless
`.agenticloop/project.md` says `event_logging: enabled`.

When event logging is enabled, zero events for a completed or reviewed task is
non-conformant.

The operational procedure -- resolving the command (including the one-time
CLI-help fallback check), the disabled and non-blocking rules, the
concise-summary and small-`data` rules, and command safety -- is owned by the
[[event-logging]] skill. This section owns why event logging exists, the event
taxonomy, and which lifecycle gates emit which events. Events default to
`.agenticloop/logs/<TASK-ID>.jsonl` via `--task <TASK-ID>`.

Do not backfill missed normal gate events as if they happened on time. If an
agent discovers that events were missed, record the miss as a process gap in
the task record, review, or retrospective. If the CLI supports a suitable
truthful event, use a concise `task.updated` or `blocked` or `needs_context`
only when that event is actually true. Do not fabricate the missing sequence.

For strict audit, the minimal required event set is:

- `role.invoked`
- `task.started`
- `check.run` for each required or cited verification command
- `review.result`
- `task.closed` when the task is closed

A durable `task.closed` event must have `outcome: success` and role
`maintainer` or `orchestrator`. For GitHub-backed tasks it must also include
both `github:issue:<number>` and `github:pr:<number>` refs, or document an
exception in `data.closure_exception` (for example a no-PR or manual-close
exception with a non-empty `reason`). Files-backed tasks do not require GitHub
refs. The audit treats the last `task.closed` event as the final satisfying
closure event, so a later non-durable engineer revision-complete marker fails
strict audit.

Use event logging for these recommended default gates:

- `task.created` when a durable task record is created.
- `task.updated` when task scope, acceptance criteria, required checks, backend
  linkage, or review state materially changes.
- `task.started` when implementation or revision work begins.
- `role.invoked` when orchestrator delegates to a role or starts a fallback role
  assumption.
- `check.run` after each required or cited verification command.
- `review.started` when maintainer review begins.
- `review.result` when review is recorded as accepted or needs_revision.
- `decision.recorded` when a tracked Markdown decision record is created or updated.
- `blocked` or `needs_context` when work cannot continue.
- `task.closed` when the task is durably closed.
- `summary.published` when the closeout status marker is posted.

When events in the same target share a `task_id`, the CLI derives the same
deterministic `trace_id` automatically unless `--trace-id` is supplied.

Do not record every chat turn. Do not write raw prompts, raw assistant text,
full tool output, transcript payloads, or host runtime exports. Keep entries to
short summaries, references, and small structured data only.

Keep the top-level event schema unchanged. Use `refs` and `data` for small,
structured context only.

Recommended `refs` values:

- `github:issue:<number>`
- `github:pr:<number>`
- `commit:<sha>`
- `branch:<name>`
- `task-file:<path>`
- `command:<command>`

Recommended `data` conventions:

- `check.run`: `command`, `exit_code`, `passed`, `failed`, `skipped`,
  `duration_ms`, `timeout_ms`, `timed_out`, `host_timeout_limit_ms`,
  `execution_strategy`, `attempt`, `required`, `triaged_unrelated`,
  `accepted_known_failure`
- `role.invoked`: `target_role` (`maintainer` or `engineer`), `delegation_mode`
  (`host_subagent`, `explicit_agent_invocation`, or `single_agent_fallback`), a
  boolean `fallback`, `adapter`, `model` only when explicitly known from adapter
  config, and `reason`. For `single_agent_fallback` also record `fallback: true`,
  a structured `fallback_cause` (`mechanism_absent` or `invocation_failed`), and a
  non-empty `reason`; non-fallback modes use `fallback: false` and no fallback
  cause. The orchestrator emits `role.invoked`; a role never emits a
  self-invocation targeting itself.
- `review.started` and `review.result`: the maintainer is the top-level event
  `role`; data carries `review_round`, `review_mode` (a valid
  review mode), `artifact_revision`, `pr_head`. Add `continuation_reason` when a
  direct same-session continuation records the review without a corresponding
  `role.invoked`. Add `maintainer_fixup: true` only on a maintainer
  `review.result` with `review_mode: single_agent_fallback` when a Maintainer
  Review Fixup was applied; a fallback review mode alone does not imply a fixup.

Newly produced `role.invoked` and `review.result` events pass strict producer
validation before they are written: `role.invoked` requires `target_role`,
`delegation_mode`, and a boolean `fallback` (plus `fallback_cause` and a
non-empty `reason` for `single_agent_fallback`); `review.result` requires
`review_round`, a valid `review_mode`, and top-level role `maintainer`. Historical logs that predate these
conventions are read and reported, never rewritten or backfilled.

`check.run` triage fields:

- `required`: true when the check is a required gate for this task.
- `triaged_unrelated`: true when the failure or blocked result is unrelated to
  the task change and accepted as such.
- `accepted_known_failure`: true when the failure is a pre-existing known
  failure and accepted for this task.

A triaged unrelated or known failure must still be logged with its real outcome
(usually `failure` or `blocked`), not rewritten as a clean `success`. The triage
fields let reports distinguish an accepted imperfect check from an untriaged
failure.

`execution_strategy` values are small strings such as `foreground`,
`background`, `focused`, `split`, or `ci`. Use `execution_strategy` to record
how a check was run when the strategy is material to interpreting its outcome
or duration. A timed-out or expensive check should be logged with its real
outcome and the chosen strategy, not hidden as success.

`data` must stay small, structured, and non-transcript. Do not copy prompts,
responses, full tool output, token streams, per-turn telemetry, or raw host
exports into it.

Use `npx agenticloop event-logging validate` to validate the local event logs
when needed. Use `npx agenticloop event-logging audit --task <TASK-ID>` for a
strict task-scoped audit of the minimal required events. Use `npx agenticloop
event-logging report --task <TASK-ID>` for a local read-side summary of one
task log. Use `npx agenticloop event-logging report` (without `--task`) for a
read-only aggregate summary across every `.agenticloop/logs/*.jsonl` file;
the aggregate surfaces strict-audit gaps, durable-closure gaps, review churn,
check outcomes, delegation/fallback counts, delegation/review provenance-quality
gaps (incomplete or inconsistent `role.invoked`, self-invocation, non-orchestrator
emitters, `review.result` missing `review_mode` or emitted by a non-maintainer,
and maintainer review rounds with neither correlated delegation evidence nor a
continuation reason -- each review round is
matched per-review against a preceding unconsumed maintainer invocation for that
step, never estimated by aggregate subtraction), `maintainer_fixup: true` event
counts (reported as event counts, with more than one per task flagged as a
multiple-episode anomaly), invalid or empty logs, and
`host=unknown` events as telemetry-quality warnings rather than workflow failures.
Historical incomplete events are labeled legacy/unknown, never inferred or
backfilled. Reporting
stays local; it does not upload data or require producers to add new event keys
before it is useful. Add `--features` to that aggregate command for a
feature-adoption view: minimalism levels and triggers, non-default effort
budgets, medium/high context-overflow risk, context-pressure calibration
coverage, review-round churn against budget, and context-risk omission
candidates (telemetry tasks that hit context pressure or reached/exceeded review
budget without a predicted context_overflow_risk), reported as heuristic
candidates rather than warnings. The review-round dimension is
derived from existing `review.result` events, so it works on historical logs;
the knob dimensions read the optional `task.created`/`task.closed` telemetry
fields when present. `npx agenticloop validate` also validates every default
`.agenticloop/logs/*.jsonl` file when present, and -- when
`event_logging: enabled` is recorded -- cross-checks each files-backed task
record's durable `## Maintainer Review Fixup` subsection against that task's
`maintainer_fixup: true` review events, reporting historical mismatches and
multiple-episode anomalies as warnings. Only an event with the matching task id,
role `maintainer`, and `review_mode: single_agent_fallback` satisfies that
cross-check; malformed historical flags are reported separately. A
`review_mode: single_agent_fallback` alone is never counted as a fixup; only the
durable subsection and the explicit
event flag are.

## Decision Records

Decision records are short tracked Markdown files for durable project decisions
that constrain future work. Store them under:

```text
.agenticloop/decisions/
  D-2026-06-17-001.md
```

Rules:

- At task start, read `.agenticloop/project.md`, the current task record, and
  selected source documents. Read decision records only when they are
  explicitly linked from the task record, project map, selected source
  documents, or directly named by the user.
- If a task depends on an unlinked historical decision, add the durable link
  to the nearest source while working.
- Decision records live under `.agenticloop/decisions/`.
- No decision index is maintained.
- Record decisions that constrain future work, especially process,
  architecture, backend, role, quality, security, release, product direction,
  or accepted project conventions. Accepted project conventions and other
  binding prescriptions remain decisions and still require decision governance;
  a current, non-binding Project Operating Fact is not a decision. Promote a
  fact only when it becomes binding.
- Any role may create a new `status: proposed` decision record when it
  directly discovers evidence that constrains future work. Proposed records
  must include provenance fields (`proposed_at`, `proposed_by_role`,
  `proposed_by`) and source references (`source_refs`).
- Verification is a narrower exception: the engineer records a timeout or
  expensive-check observation through [[verification-evidence]], and the
  maintainer may use a verification decision only after final triage and a
  current `VF-...` fact establish a policy-level promotion.
- Findings discovered during parallel work follow a promotion threshold. A
  lane-local observation stays in that lane's status return or task summary. A
  finding relevant only to the current batch is routed and disposed under the
  cross-lane finding rules. A durable technical invariant that constrains
  future work beyond the batch may become a `status: proposed` decision record
  with provenance and a source link; the maintainer resolves it under the
  existing acceptance rules, and future work retrieves it through existing
  source-linked decision discovery. Nothing in parallel work auto-promotes a
  finding into a decision record, a skill, or this methodology.
- Maintainer owns acceptance, rejection, supersession, and edits to accepted
  decisions. Human confirmation or an approved `type:change-request` remains
  required for `accepted`.
- Decision status is one of `proposed`, `accepted`, `rejected`, or
  `superseded`.
- Do not silently rewrite an `accepted` decision to change its meaning. Create
  a new record and mark the old one `superseded`.
- Accepted decisions remain protected by the existing change-request rules.
- A role working in a parallel lane may create a new uniquely named
  `proposed` record, but must not edit an existing decision record unless the
  concurrency plan grants exclusive ownership.
- `decision.recorded` may be emitted by the role that created a `proposed`
  decision record. Maintainer emits `decision.recorded` when resolving,
  accepting, rejecting, or superseding a decision. The event log is an audit
  signal, not the source of truth.
- Changing an accepted locked process, architecture, backend, or project
  decision must use [[change-request-gate]] before implementation.

Verification observations first belong in the task's append-only attempt history
and, when they affect repeated project work, in the mutable verification-fact
profile. A verification decision is narrower: the maintainer may use
[[decision-capture]] only to promote an already-recorded, policy-level profile
observation into a durable decision that needs the normal acceptance gate. A
timeout alone is not a decision and does not authorize a role to approve a new
strategy. Decisions cite the fact and task evidence; raw timing output remains in
the attempt history or event log.

## Default Backend: Files

Task records are Markdown files under `.agenticloop/tasks/`. The default task ID
shape is neutral and flat-project friendly.

Valid default task IDs: `T-001`, `T-002`, `T-120`.

```text
.agenticloop/
  decisions/
    D-2026-06-17-001.md
  improvements/ (created on first proposal)
    I-2026-06-17-001.md
  tasks/
    T-001.md
    T-002.md
```

No GitHub repository is required for files-backed work.

Projects that choose a grouping profile may still use group-shaped task IDs such
as `P1-01`, but that is optional project config, not the universal default.

The registry regex in `agenticloop/config.json` bounds detection candidates
only; the enforced per-project convention is `task_id_regex` in
`.agenticloop/project.md` (default `^T-\d{3,}$`). An ID valid under the registry
regex is not necessarily valid for the project.

## Optional Backend: GitHub

When `task_backend: github` is set in `.agenticloop/project.md`, use one GitHub
issue and one pull request per implementation task:

1. Maintainer creates or refines the issue.
2. Engineer creates a branch and implements the issue scope.
3. Engineer runs checks and opens a pull request.
4. Engineer publishes the implementation summary in one durable place. For a
   normal implementation PR, use the PR body and include a GitHub closing
   keyword for the task issue, normally `Closes #<issue-number>`. Do not also
   post the same summary as an issue or PR comment.
5. Maintainer reviews the PR against the issue, checking existing review
   markers for the current PR head before posting a new marker. For normal
   GitHub-backed implementation tasks, the maintainer must treat a missing
   recognized closing keyword as a linkage defect before acceptance.
6. Engineer revises until accepted, unless the current review qualifies for a
   bounded Maintainer Review Fixup under [[review-and-accept]].
7. Human approves merge when appropriate.
8. Issue closes through the merged PR. The task is not durably closed until
   GitHub shows the task issue closed, not merely because a local event was
   written or the PR was merged.

For automated work, this path applies to code, docs, configuration, workflow,
and infrastructure changes alike. Once a task is delegated to an agent role in a
GitHub-backed project, the agent must not commit task work directly to the
default or integration branch. Create or use a task branch, publish the branch,
and review the pull request diff.

A task branch has one terminal merge path. After its pull request is merged by
merge commit, squash, or rebase, do not also merge the same task branch into the
default branch as a second path for the same work.

Human-authored repository maintenance may happen outside Agentic Loop when the
human intentionally handles it that way. Do not treat that exception as
permission for agent-authored task work to bypass the issue, branch, PR, review,
and merge path. A no-PR exception for agent-authored work must be approved by a
human and recorded in the task record before implementation starts.

Use labels such as `agent-ready`, `blocked`, `approved`, `type:impl`,
`type:change-request`, and `task:<TASK-ID>`. If the project uses grouping,
apply the configured grouping label as well. For example, a project with
`grouping_profile: phase` may use `phase:1`.

Bootstrap labels with `agenticloop bootstrap-labels` before creating the first
GitHub task record. See `agenticloop/backends/github.md` for the full label and branch
conventions.

## Implementation Loop

For each task:

1. Confirm the task record is complete.
2. Identify expected files, commands, and risks.
3. For behavior changes, create a failing test or failing check first.
4. Implement the smallest useful slice by default.
5. Summarize or return `needs_context` when unexpected context expansion exceeds
   the task record's bounds.
6. Run the focused check.
7. Run the required checks.
8. Publish the implementation summary with evidence in the backend's canonical
   location.
9. Request review.

For a timeout, unexpectedly expensive check, or retry, load
[[verification-evidence]] before choosing how to run it again. Do not treat an
unchanged rerun as a new verification plan.

The default sizing is one independently verifiable task at a time, the smallest
useful implementation slice. When a human authorizes a larger bounded run,
prefer the largest safe useful slice that remains bounded, reversible, and
independently verifiable as one task. Authorizing a phase, group, milestone, or
task set is not permission to create one oversized task record; broad work items
still decompose into ordinary task records.

Implementation summaries use `agenticloop/memory/work-unit-summary.md` with
`summary_unit: task`. `Evidence` must include fresh output from the final state.
Claims without evidence are not enough.

The evidence contract covers changed files and artifacts under `## Artifacts`,
commands, statuses, and concise final-state output under `## Evidence`,
unexpected scope changes under `## Deviations`, blockers, risks, and process
friction under `## Process Observations` or `## Known Gaps`, follow-up task ids
under `## Follow-Ups`, and optional event-log-derived facts under `## Trace`.
Prefer concise verdict lines and relevant output excerpts over full terminal
dumps, while still reading full command output before claiming success. Output
refs remain a deferred future policy; do not create or rely on them now.

## Scratch and Temporary Files

Scratch and temporary files must stay inside the target project's `.agenticloop/tmp/`
directory, which should be gitignored. The path includes the slash separator
between `.agenticloop` and `tmp`; never create root-level lookalikes such as
`.agenticlooptmp/`, `.agenticloop-tmp/`, `agenticlooptmp/`, or
`agenticloop-tmp/`. If the directory is absent, create `.agenticloop/tmp/`.
Do not write temporary files to the system temp directory, user profile, host
runtime directories, or the repository root.

Always refer to scratch paths with the **relative, forward-slash** form
(`.agenticloop/tmp/<name>.md`). Do not build an absolute Windows path with
backslashes and pass it to a shell command: POSIX shells (including the Git Bash
used by some hosts) consume `\` as an escape character, so a path like
`C:\repo\.agenticloop\tmp\body.md` collapses into a single junk filename in the
repository root (`C:repo.agenticlooptmpbody.md`). A relative forward-slash path
works on every host and avoids this corruption.

Prefer a temporary Markdown file under the target project's `.agenticloop/tmp/` directory
for GitHub issue, pull request, and comment bodies, then pass it with
`gh ... --body-file <path>`. Avoid heredocs, here-strings, and long inline
`--body` arguments for structured Markdown. Remove the temporary body file
after posting, and mention it in evidence only when it affects reproducibility.

## Review Loop

Review happens in two passes.

Pass 1: task compliance.

- Diff matches scope.
- Out-of-scope work is absent or justified.
- Acceptance criteria are met.
- Required checks were run on the final state.
- Timed-out verification attempts have final maintainer triage; no required
  check retains `pending` triage.
- New behavior has RED-to-GREEN or equivalent evidence.
- Locked process or architecture decisions did not change accidentally.

Pass 2: code and documentation quality.

- Design is appropriate for the task.
- Names, errors, and boundaries are clear.
- Docs changed when commands, configuration, or user-visible behavior changed.
- No secrets, caches, dumps, or raw transcripts were committed.
- Known limitations and follow-ups are triaged.

If either pass fails, request revision. If review feedback is disputed, resolve
the dispute with evidence rather than repeated assertion.

When Pass 1 is already clean and a Pass 2 finding is minor and fully understood,
the maintainer may apply one bounded **Maintainer Review Fixup** instead of
requesting an engineer revision: it corrects the finding on the artifact under
review, refreshes final-state evidence, re-runs both passes against the result,
and accepts with `review_mode: single_agent_fallback`. A successful fixup is part
of the current review round and does not create a `needs_revision` round.
Independent-review tasks are ineligible, and any finding that expands, becomes
uncertain, or exceeds one coherent edit packet returns to the normal engineer
revision path. Merge, integration, issue closure, and closeout gates are
unchanged. All eligibility and procedure live in [[review-and-accept]].

Every review outcome records its mode and the exact artifact revision reviewed.
Final acceptance requires current, non-stale provenance. Tasks requiring
independent review cannot be accepted through same-session fallback. See
[[review-and-accept]] and [[task-record-contract]].

## Blocked and Needs Context

Use `needs_context` when the task record is incomplete but the maintainer can
answer or amend it, or when unexpected context expansion means the task must be
split or tightened before implementation can continue.

Use `blocked` when progress requires a human decision, missing credentials,
unavailable services, merge conflict resolution, or another external action.

For files-backed work, record durable state in the task file:

- `status: needs_context` plus dated questions or notes under `## Comments` when
  the maintainer can answer. Use `context_reason: context_overflow` in the note
  when context pressure caused the pause,
- `status: blocked` plus `block_category: <category>` and a blocker section when
  an external action or human decision is required.

For GitHub-backed work, `needs_context` is a task-record comment containing
`AGENT_TASK_STATUS: needs_context`. Add
`AGENT_CONTEXT_REASON: context_overflow` when context pressure caused the pause.

GitHub-backed blocked tasks carry both:

- the `blocked` label
- a comment containing `AGENT_TASK_STATUS: blocked` and `AGENT_BLOCK_CATEGORY: <category>`

The loop resumes only after the blocker is cleared and the durable task record
reflects the decision.

## Change-Request Gate

A `type:change-request` task changes a locked decision: process, architecture,
task rules, or other durable project contract.

Required gate:

1. Maintainer drafts or updates the relevant docs, decision record, or ADR.
2. Human reviews and approves the docs-only change.
3. The task receives the configured approval marker.
4. Implementation can proceed.

For files-backed work, represent that state in task-file frontmatter, typically
with `type: change-request`, `approved: true` after approval, and
`status: blocked` plus `block_category: contract` until approval exists.

For GitHub-backed work, use the configured `type:change-request` and
`approved` labels.

Do not implement a locked-decision change before approval.

## Attribution

When multiple roles use one GitHub identity, each agent-authored issue, PR, or
comment ends with:

```text
[[agent: maintainer]]
```

Use the actual role name. Commit messages for agent-authored commits include:

```text
Task: T-001
Agent: engineer
```

Attribution is cooperative, not cryptographic. It helps humans and later agents
understand who produced which artifact.

## Closeout

When a project's configured grouping says closeout is enabled, the maintainer
runs closeout after all tasks in the current group are accepted and integrated or closed
according to the configured backend. In flat projects, closeout runs when a
human-identified task set or work unit finishes.

Closeout is a verify-and-mark gate. It does not write a separate summary
artifact: the durable record is the per-task inline summary (the `## Scope
Completed` section in each task file, or the PR body for GitHub-backed work) plus
the backend. Closeout confirms that record is complete and posts a status marker.

Closeout checks:

- all relevant task records
- all implementation artifacts, including merged PRs for GitHub-backed work
- for GitHub-backed work, each normal merged implementation PR closed its task
  issue, or any exception/manual correction is recorded
- acceptance criteria
- required checks
- final triage for timed-out verification attempts
- documentation changes
- known gaps
- follow-up task records
- repeated process failures worth turning into skill updates

Post exactly one closeout status marker (`AGENT_CLOSEOUT_STATUS: complete` or
`follow_up_required`). For files-backed work, append it to the last accepted task
record under `## Comments`; for GitHub-backed work, post it as a comment on the
last task issue or PR in the work unit. Cite the covered task ids.

Do not copy raw agent transcripts into repo docs. Keep raw discussion in task
records and implementation artifacts; summarize only durable decisions,
evidence, and follow-ups.

The per-task inline summary uses `agenticloop/memory/work-unit-summary.md` with
`summary_unit: task` as the canonical shape. When event logging is enabled and
task-scoped event logs exist, the local event log should help assemble the
optional `## Trace` section, but task records and implementation artifacts remain
the primary sources of truth.

When the project uses grouping and a human wants to move to the next group,
pause for approval before that transition.

## Skills

Use the canonical skills in `agenticloop/skills/` when their trigger applies. The most
important skills are:

- `task-record-contract`
- `tdd-implementation`
- `debugging-before-fixes`
- `verification-evidence`
- `review-and-accept`
- `blocked-state`
- `change-request-gate`
- `decision-capture`
- `task-closeout`
- `github-attribution`

Skills are workflows, not background reading. Follow the procedure and
verification steps when a skill applies.

For definitions of Agentic Loop terms, see the Glossary section in this file.
