# Files Task Backend

Status: supported default.

The files backend stores task records as local Markdown files. It is the
default backend for Agentic Loop projects. No GitHub repository, account, or
labels are required.

A GitHub remote does not select the GitHub backend. Only `.agenticloop/project.md`
`task_backend: github` enables GitHub issue/PR behavior. For `task_backend: files`,
implementation artifacts are local branch, commit, range, patch, or diff references
recorded in the task file. Files backend agents must not open PRs, close issues, or
merge branches as part of the workflow. After files-backed acceptance,
integration/publish/PR/merge is a separate human decision outside normal files-backend
task automation, unless the project explicitly switches to the GitHub backend.

The files backend is not an autonomous runner. It is a storage projection for
the same Agentic Loop roles, skills, and review gates.

## Parallel Write Lanes

Concurrency safety is governed by mutation, not by role. Files-backed task
records, event logs, and scratch files are local mutable state that can collide
across parallel lanes just like implementation files. See the lane definitions
and backend-specific rules in `agenticloop/AGENTIC_LOOP.md`.

**Read-only parallel discovery** is allowed when bounded by fixed artifacts and
no lane mutates repository files or task records.

**Write lanes in a Git repository.** Each parallel write lane -- whether it
mutates implementation files, task records, or other tracked state -- requires:

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

A branch alone is not sufficient when multiple agents share one checkout.
Copying selected touched files into a temporary folder is not valid isolation.

Integration of parallel files-backed lanes is serial: review and merge happen
one lane at a time after all lanes return.

**Non-Git targets.** Parallel write lanes are not allowed when the target is
not a Git repository. Run all write work serially. Read-only parallel discovery
is still allowed.

**Join behavior.** Missing local commit or range at join time is a failed or
blocked lane. Missing expected task-record update or workflow artifact is
likewise a failure. The orchestrator must not wait indefinitely.

## Summary and Trace

Task summaries live inline in the task file. There is no separate
`.agenticloop/summaries/` directory; the task record is the durable summary.

The completion summary belongs in the task file as the `## Scope Completed` (or
legacy `## Implementation Summary`) section. Update it in place as
implementation progresses. Every accepted or closed task must have a non-empty
inline task summary with `summary_unit: task`, using
`agenticloop/memory/work-unit-summary.md` as the canonical shape. Include the
optional `## Trace` section when workflow-gate events exist. This is a summary,
not a raw transcript.

Closeout does not write a separate summary file. When a human-identified task
set or configured group finishes, closeout verifies the inline task summaries
are complete and records a status marker (see [[task-closeout]]).

Event logging is disabled by default. When `.agenticloop/project.md` has
`event_logging: enabled`, the local `.agenticloop/logs/<TASK-ID>.jsonl` event
log may help confirm workflow gates, checks, decisions, and blockers. The task
file remains the authoritative durable record. `event_logging_command` can stay
blank; agents test `npx agenticloop --help` once when enabled.

Use backend-specific values inside the canonical template. Keep the summary
concise. Cite command output, file paths, and task ids. Do not copy raw agent
exchanges.

## Storage Model

```text
.agenticloop/
  tasks/
    <TASK-ID>.md
```

| Agentic Loop object | Files projection |
|---|---|
| Task record | `.agenticloop/tasks/<TASK-ID>.md` |
| Task ID | File name and frontmatter field |
| Grouping | Optional frontmatter/body field when the project uses grouping |
| Implementation artifact | Branch, commit range, patch, or local diff reference |
| Evidence | Current implementation summary (refreshable) plus append-only history sections |
| Review status | Frontmatter field plus review section |
| Blocked state | Frontmatter field plus blocker section |
| Completion summary | Inline `## Scope Completed` section in the task file |

## Task IDs

Default task IDs use the `T-<number>` pattern with at least three digits.

Valid default examples:

```text
T-001
T-002
T-120
```

Projects that choose grouping may override this. For example, a project with
`grouping_profile: phase` may use `P1-01` if its `task_id_regex` allows it.

The default regex is `^T-\d{3,}$`. Override `task_id_regex` in
`.agenticloop/project.md` only when the target project uses a different naming
convention.

## Task File Shape

Use Markdown frontmatter for mechanical state and body sections for
human-readable detail. Use `agenticloop/memory/task-record.md` as the
canonical shape. It includes the required `## Completion Summary Template` and
`## Reviewer Checklist` sections that every durable task record must carry.

Optional frontmatter conventions:

- `type: change-request` for locked-decision changes that require the docs-first approval gate.
- `approved: true` after a human approves a files-backed change request.
- `block_category: <category>` while the task is blocked.

## Operations

### Create Task Record

Create `.agenticloop/tasks/<TASK-ID>.md` using `agenticloop/memory/task-record.md`.
Do not leave placeholder sections.

### Read Task Record

Read frontmatter for mechanical state and the body sections for scope,
evidence, comments, and review history.

### List By Grouping And Status

List files under `.agenticloop/tasks/` and filter by status plus any optional
grouping field the project uses.

### Update Status

Update the `status` frontmatter field and append a dated note under
`## Comments` when the reason matters.

Recommended statuses:

```text
draft
agent-ready
in-progress
needs_context
blocked
needs_revision
accepted
closed
```

### Mark Needs Context

Set:

```yaml
status: needs_context
```

Append a comment explaining what is missing and who can answer.

### Mark Blocked

Set:

```yaml
status: blocked
block_category: <category>
```

Append a blocker section with what was tried, why progress stopped, and the
action needed to resume.

### Change-Request Classification And Approval

For files-backed locked-decision changes, record classification and approval in frontmatter:

```yaml
type: change-request
approved: true
```

Until approval exists, keep the task blocked with `block_category: contract` and explain the
hold in the task file.

### Attach Implementation Evidence

Publish or refresh the one current implementation summary in the task file.
Include fresh command output from the final state. If the refresh corrects a
previously published claim, evidence block, check result, or artifact reference,
append a dated entry to `## Revision Log` or `## Comments` before updating the
summary.

### Link Implementation Artifact

Record the implementation artifact in frontmatter. Mirror it in the implementation summary when
helpful:

```yaml
implementation_artifact: branch:<name>
```

Other valid references include `commit:<sha>`, `range:<base>..<head>`, or a
patch path if the project uses patch files.

### Record Review Status

Set `review_status` and append the maintainer review section.

```yaml
review_status: accepted
review_status: needs_revision
```

`review_status` should reflect the current implementation artifact, not a stale earlier revision.

### Close Or Accept Task

Set:

```yaml
status: accepted
```

Only after scope, quality, evidence, and follow-up triage pass review. Use
`closed` after the implementation artifact is merged or otherwise integrated.

### Run Closeout

Closeout is a verify-and-mark gate; it does not write a separate summary file.
When a human-identified task set or configured group finishes, confirm each
task's inline `## Scope Completed` summary and evidence are complete, then record
the closeout status marker on the last accepted task record (see
[[task-closeout]]).

## Current State and History Discipline

Files-backed task records use a hybrid model: some fields are mutable current
state and some sections are append-only history. This mirrors the GitHub
projection where the PR body and labels are the current surface while comments
and timeline are the history.

### Mutable current state

These may be updated in place to reflect the latest truth:

- YAML frontmatter fields: `status`, `review_status`, `implementation_artifact`,
  `block_category`, `type`, `approved`, and other mechanical state.
- The one current `## Implementation Summary` (or `## Scope Completed` when
  using the unified work-unit summary shape). This section may be refreshed to
  match the latest artifact and evidence.

### Append-only history

These sections grow over the life of the task and must not be rewritten or
truncated:

- `## Comments` -- dated notes on status changes, context, and decisions.
- `## Revision Log` -- dated entries recording corrections to previously
  published claims, evidence, artifact references, or check results.
- Blocker sections added while the task is blocked.
- Maintainer review sections appended per review round.

### Correction rule

If an agent changes a previously published claim, evidence block, check result,
status justification, or artifact reference in the current implementation
summary, it must append a dated entry to `## Revision Log` or `## Comments`
before refreshing the current summary. The entry must name what changed and why.
Silent correction of published claims is a review blocker.

### Durability rule

`.agenticloop/tasks/*.md` task records are durable tracked state by default.
They should be committed at workflow gates: task creation, evidence publication,
review result, revision, and acceptance or closure.

`.agenticloop/tmp/` and `.agenticloop/logs/` remain local or ignored unless a
target project explicitly chooses otherwise. Event logs (`.jsonl`) are gitignored
by default.

### Review implication

Review must inspect untracked files with
`git status --short --untracked-files=all` and must not rely solely on
`git diff HEAD`, which misses untracked task files.

Untracked `.agenticloop/tasks/*.md` files are a review blocker unless the
project explicitly records a local-only exception in `.agenticloop/project.md`
or the task file itself.

### GitHub analogy

| Files backend | GitHub backend |
|---|---|
| Frontmatter fields | Labels, PR status, issue state |
| Current implementation summary | PR body |
| `## Revision Log`, `## Comments` | PR/issue comments, timeline |
| Maintainer review sections | PR review comments |
| Git commits of the task file | Git commits of the PR |
