# Agentic Loop Methodology

Agentic Loop is a supervised implementation workflow for AI coding agents. It
turns a vague request into a durable task record, a scoped implementation,
evidence, review, and closeout.

The methodology is host-neutral. OpenCode is the first supported host, but the
workflow should read naturally in any agent that can follow Markdown
instructions and load skills.

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
- **Proof pressure**: the optional task-record practice of naming a completion
  oracle, final proof required, and likely misfire to keep work aligned with the
  owner's outcome. Proof pressure complements acceptance criteria; it does not
  replace them.
- **Needs context**: a task state used when the task record is ambiguous or
  incomplete and can be corrected by the maintainer.
- **Blocked task**: a durable paused state requiring human action or external
  change.
- **Change request**: a task that changes a locked architecture, process, or
  repository decision and must pass an approval gate before implementation.
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
| `.agenticloop/` | yes | target project | read/write | `project.md`, `tasks/`, `decisions/`, `logs/`, `tmp/` |

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
`task_backend`, task naming, optional grouping settings, and typed document
selections.

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
- join condition before review, acceptance, merge, or closeout.

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
If any collision criterion is unknown, run serially.

Before mutating repository files in a parallel write lane, the delegated role
must verify the assigned worktree path and branch, and check
`git status --short --untracked-files=all` for clean or expected state. If the
worktree or branch is wrong, dirty unexpectedly, or a collision appears, the
role must return status or a blocker instead of continuing.

### Backend-Specific Parallel Write Rules

**GitHub backend (`task_backend: github`) -- implementation lanes.** Each
parallel implementation lane requires:

- its own `git worktree`,
- its own task branch,
- its own GitHub issue (task record),
- its own pull request,
- disjoint expected files or areas,
- no shared generated files, lockfiles, schema, API, or external-state
  collision,
- a lease with observable-step checkpoint cadence, stop condition, and
  no-progress budget,
- a join condition before review, acceptance, merge, or closeout,
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

- its own `git worktree`,
- its own local branch,
- its own `.agenticloop/tasks/<TASK-ID>.md` task file or explicitly owned
  workflow file(s),
- its implementation or workflow artifact recorded as `branch:<name>` plus
  `commit:<sha>` or `range:<base>..<head>` in the task file (patch is a
  fallback, not the preferred form),
- disjoint expected files or areas,
- a lease,
- a join condition.

Integration of parallel files-backed lanes is serial: review and merge happen
one lane at a time after all lanes return.

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

If the host cannot stream, cancel, or otherwise surface subagent status while a
role is running, do not start long-running parallel delegation. Use bounded
serial delegation whose stop condition returns control to the orchestrator.

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

The default budget is 3. An attempt counts against the budget when it is
equivalent to a previous one -- the same command, check, fix, delegation, or
report against the same target -- and yields no new evidence or change in task
state. A restated intended next action that is not performed also counts as an
attempt: deliberation that never becomes an action is the same loop as a
repeated action that never changes state.

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

After 3 `needs_revision` rounds on one task, the orchestrator pauses before
routing a fourth revision and classifies the churn cause:

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

When event logging is enabled, resolve the command before the first event write
in the current host session:

1. If `event_logging_command` is non-empty, use that command.
2. If `event_logging_command` is blank or omitted, run `npx agenticloop --help`
   once. If it succeeds, use `npx agenticloop`.
3. If no working event logging command is available, do not repeatedly retry
   and do not block the workflow. Record a truthful process gap in the task
   record, review, or closeout marker note, then continue.

After resolution, event writes use:

```text
<resolved-command> event-logging <event_type>
```

`agenticloop event` remains a compatibility alias, but new instructions should
use `event-logging`.

The default event log directory is:

```text
.agenticloop/logs/
  <TASK-ID>.jsonl
```

Default event writes require `--task <TASK-ID>`. Use `--output <file>` only
for tests or an explicit local exception.

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
  `duration_ms`, `attempt`
- `role.invoked`: `target_role`, `delegation_mode`
  (`host_subagent`, `explicit_agent_invocation`, or `single_agent_fallback`),
  `fallback`, `adapter`, `model` only when explicitly known from adapter
  config, and `reason`
- `review.started` and `review.result`: `review_round`, `artifact_revision`,
  `pr_head`

`data` must stay small, structured, and non-transcript. Do not copy prompts,
responses, full tool output, token streams, per-turn telemetry, or raw host
exports into it.

Use `npx agenticloop event-logging validate` to validate the local event logs
when needed. Use `npx agenticloop event-logging audit --task <TASK-ID>` for a
strict task-scoped audit of the minimal required events. Use `npx agenticloop
event-logging report --task <TASK-ID>` for a local read-side summary derived
from the existing log file. Reporting stays local; it does not upload data or
require producers to add new event keys before it is useful. `npx agenticloop
validate` also validates every default `.agenticloop/logs/*.jsonl` file when
present.

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
  or accepted project conventions.
- The orchestrator may detect candidate decisions, but the maintainer owns
  writing and updating decision records.
- Decision status is one of `proposed`, `accepted`, `rejected`, or
  `superseded`.
- An agent may create a `proposed` record. `accepted` requires explicit human
  confirmation or an approved `type:change-request`.
- Do not silently rewrite an `accepted` decision to change its meaning. Create
  a new record and mark the old one `superseded`.
- After creating or updating the tracked Markdown decision, emit
  `decision.recorded`. The event log is an audit signal, not the source of
  truth.
- Changing an accepted locked process, architecture, backend, or project
  decision must use [[change-request-gate]] before implementation.

## Default Backend: Files

Task records are Markdown files under `.agenticloop/tasks/`. The default task ID
shape is neutral and flat-project friendly.

Valid default task IDs: `T-001`, `T-002`, `T-120`.

```text
.agenticloop/
  decisions/
    D-2026-06-17-001.md
  tasks/
    T-001.md
    T-002.md
```

No GitHub repository is required for files-backed work.

Projects that choose a grouping profile may still use group-shaped task IDs such
as `P1-01`, but that is optional project config, not the universal default.

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
6. Engineer revises until accepted.
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
5. Run the focused check.
6. Run the required checks.
7. Publish the implementation summary with evidence in the backend's canonical
   location.
8. Request review.

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

## Blocked and Needs Context

Use `needs_context` when the task record is incomplete but the maintainer can
answer or amend it.

Use `blocked` when progress requires a human decision, missing credentials,
unavailable services, merge conflict resolution, or another external action.

For files-backed work, record durable state in the task file:

- `status: needs_context` plus dated questions or notes under `## Comments` when
  the maintainer can answer,
- `status: blocked` plus `block_category: <category>` and a blocker section when
  an external action or human decision is required.

For GitHub-backed work, `needs_context` is a task-record comment containing
`AGENT_TASK_STATUS: needs_context`.

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

For a concrete end-to-end example, see
[docs/workflow-examples.md](docs/workflow-examples.md).

For definitions of Agentic Loop terms, see the Glossary section in this file.
