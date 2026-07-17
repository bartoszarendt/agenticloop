# Files Task Backend

Status: supported default.

The files backend stores task records as local Markdown files. It is the
default backend for Agentic Loop projects. No GitHub repository, account, or
labels are required.

Everything the backend needs lives locally. Implementation artifacts are a local
branch, commit, range, patch, or diff reference recorded in the task file; task
state, evidence, and review all live in the task file and in Git. Files-backend
validation and task operations never call `gh` or make GitHub network requests,
even when a GitHub remote and an authenticated GitHub CLI are available.

The backend is selected by `.agenticloop/project.md` `task_backend: files` (the
default). A GitHub remote does not change the backend; only `task_backend: github`
enables GitHub issue/PR behavior. Files-backend agents must not open PRs, close
issues, or merge branches as part of the workflow. After files-backed acceptance,
integration/publish/PR/merge is a separate human decision outside normal
files-backend task automation, unless the project explicitly switches to the
GitHub backend.

The files backend is not an autonomous runner. It is a storage projection for
the same Agentic Loop roles, skills, and review gates.

## Parallel Write Lanes

Concurrency safety is governed by mutation, not by role. Files-backed task
records, event logs, and scratch files are local mutable state that can collide
across parallel lanes just like implementation files. Load [[parallel-delegation]]
for the Parallel Opportunity Scan, lane definitions, plan fields, liveness,
join behavior, and the full backend-specific parallel write rules.

Files-backend deltas:

- Read-only parallel discovery is allowed when bounded by fixed artifacts and no
  lane mutates repository files or task records.
- In a Git repository, each parallel write lane needs its own repo-internal
  worktree, local branch, owned task file or explicitly owned workflow file,
  recorded implementation/workflow artifact, lease, and join condition.
- Parallel coordination/review lanes must own distinct task files or workflow
  artifacts and must not share event-log targets, group state, status markers,
  closeout files, scratch outputs, or other local append/update targets.
- Cross-lane findings are routed through lane status returns and recorded in
  the concurrency plan or coordination output; the join condition stays
  incomplete while any routed finding lacks a recipient disposition or any
  deferred finding lacks recorded non-blocking limitation/follow-up triage.
- Integration of parallel files-backed lanes is serial; merge remains serial.
  When the concurrency plan requires combined-state proof, an explicitly planned
  integration rehearsal may compose a disposable candidate from the verified
  base plus lane artifacts in the intended order and record integrated evidence
  bound to that exact candidate. The rehearsal is not final integration: it
  publishes nothing, and merge or publish after acceptance remains a human
  decision. When the eventual merged tree differs from the rehearsed candidate,
  the rehearsal evidence is stale and the required checks rerun.
- Non-Git targets do not allow parallel write lanes. Run all write work serially;
  read-only parallel discovery is still allowed.

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

`## Evidence` should list concise verdict lines and relevant output excerpts for
every required check on the final state. The agent must still read the full
command output before claiming success. Use event-log `refs` and small `data`
for structured facts; do not create a separate parseable receipt block. Output
refs remain a deferred future policy; do not create or rely on them now.

The target project's `## Verification Operating Facts` section in
`.agenticloop/project.md` is the maintainer-owned mutable current profile. The
task file's `## Verification Attempts` section is separate append-only history:
the engineer appends attempts and bounded foreground predictions, and the
maintainer appends triage. Use the exact shapes and retry procedure in
[[verification-evidence]]; do not replace task attempts with summary prose or
project facts.

Closeout does not write a separate summary file. When a human-identified task
set or configured group finishes, closeout verifies the inline task summaries
are complete and records a status marker (see [[task-closeout]]).

Event logging is disabled by default. When `.agenticloop/project.md` has
`event_logging: enabled`, the local `.agenticloop/logs/<TASK-ID>.jsonl` event
log may help confirm workflow gates, checks, decisions, and blockers. The task
file remains the authoritative durable record. Command resolution and the
disabled/non-blocking rules are owned by [[event-logging]].

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
| Verification profile | Current `## Verification Operating Facts` in `.agenticloop/project.md` |
| Verification attempts | Append-only `## Verification Attempts` in the task file |
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

The registry regex in `agenticloop/config.json` bounds detection candidates
only; the enforced per-project convention is `task_id_regex` in
`.agenticloop/project.md` (default `^T-\d{3,}$`). An ID valid under the registry
regex is not necessarily valid for the project.

## Task File Shape

Use Markdown frontmatter for mechanical state and body sections for
human-readable detail. Use `agenticloop/memory/task-record.md` as the
canonical shape. It includes the required `## Completion Summary Template` and
`## Reviewer Checklist` sections that every durable task record must carry.

`## Expected Files or Areas` is the task's current human-readable scope map. The
optional frontmatter field `allowed_paths` is the structured scope map: a YAML
list of repo-relative glob-like path patterns. Forward slashes are canonical;
absolute paths and `..` traversal are not allowed. Directory entries ending in
`/` match everything beneath that directory. Simple glob support covers `*`,
`**`, and `?`. The compatibility alias `expected_files` is accepted when
`allowed_paths` is absent.

When `allowed_paths` is present, `agenticloop validate` performs a warn-only
mechanical check that changed files in the working tree match at least one
allowed pattern. Out-of-scope changed files surface as warnings; reviewers still
enforce unexpected files through `## Deviations`. The structured field
complements the human-readable section; it does not replace it.

Optional frontmatter conventions:

- `type: change-request` for locked-decision changes that require the docs-first approval gate.
- `approved: true` after a human approves a files-backed change request.
- `block_category: <category>` while the task is blocked.
- `context_overflow_risk: medium|high` plus optional `context_note` when one
  engineer execution needs tighter active-context discipline.
- `review_mode: <mode>` records how the current review was performed; required
  when `review_status` is set.
- `reviewed_artifact: <artifact>` is the exact current implementation artifact
  reviewed for `review_status`.
- `independent_review_required: true` before implementation when acceptance must
  not use same-session `single_agent_fallback`.
- `human_review_ref: <reference>` a recorded human review/confirmation reference,
  required when `review_mode: independent_human`. Files validation checks
  presence only; external verification is performed by the GitHub audit when
  applicable.

## Operations

### CLI Support

The files backend remains Markdown-first; the CLI is a convenience and
consistency layer, not a required runtime. Agents may still edit files directly.

Operation mapping:

- Create task record: `agenticloop task new <title> [--id <id>]`.
- Read task record: open `.agenticloop/tasks/<TASK-ID>.md` directly.
- List task records: `agenticloop task list [--status <status>] [--json]`.
- Update status: `agenticloop task status <id> <status> [--note <text>]`.
- Mark needs context or blocked: `agenticloop task status <id> needs_context
  --note <text>` or `agenticloop task status <id> blocked --block-category
  <category> --note <text>`.
- Lint task records: `agenticloop task lint [<task-id>] [--json]`.

### Create Task Record

Create `.agenticloop/tasks/<TASK-ID>.md` using `agenticloop/memory/task-record.md`.
Do not leave placeholder sections.

### Incremental task-set creation

Files-backed task creation is a per-task workflow gate. Large task sets should
not be written as one oversized patch. Materialize durable task records one at a
time by default, or in a bounded batch of at most 3 simple records when the tasks
are similar and low-risk. Checkpoint and commit each record or batch at the
task-creation gate when the target project follows that discipline. If
materialization is interrupted, resume from the existing task files and the first
missing or invalid task id instead of regenerating the whole set.

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

Append a comment explaining what is missing and who can answer. Include
`context_reason: context_overflow` when context pressure caused the pause.

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

### Record Verification Attempts

For a required or cited check, replace the canonical empty state in
`## Verification Attempts` on its first record, then append new entries under
the matching `### RC-N` heading only. Preserve every earlier attempt,
foreground-escalation prediction, and maintainer triage verbatim. The exact
entry shapes, retry limit, and final-triage rules are owned by
[[verification-evidence]].

Do not update `.agenticloop/project.md` from an engineer attempt. The maintainer
may update the profile's current `VF-...` fact after final triage; that mutable
profile never replaces the task's append-only evidence.

### Link Implementation Artifact

Record the implementation artifact in frontmatter. Mirror it in the implementation summary when
helpful:

```yaml
implementation_artifact: branch:<name>
```

Other valid references include `commit:<sha>`, `range:<base>..<head>`, or a
patch path if the project uses patch files.

### Record Review Status

Set `review_status`, copy `implementation_artifact` to `reviewed_artifact`, record
`review_mode`, and append the maintainer review
section.

```yaml
review_status: accepted
reviewed_artifact: commit:abc123
review_mode: host_subagent
```

When `implementation_artifact` changes, clear or replace all mutable current
review fields: `review_status`, `review_mode`, `reviewed_artifact`, and
`human_review_ref` when applicable. The append-only review sections preserve
earlier rounds. See [[review-and-accept]] for shared review semantics; files
validation mechanically requires the two artifact fields to match exactly.

### Maintainer Review Fixup (files projection)

[[review-and-accept]] owns the eligibility gate and full procedure. Files-specific
projection:

- Apply the fixup to the current recorded local artifact (branch, commit, range, or
  patch); do not create a PR, merge, or no-review exception through this path.
- Attribute maintainer-authored commits with the `Task: <TASK-ID>` and
  `Agent: maintainer` trailers.
- Update `implementation_artifact` to the resulting artifact and clear or replace
  the stale mutable review fields.
- Append the fixup disclosure to the append-only review history, and append a dated
  `## Revision Log` or `## Comments` entry before refreshing any previously
  published summary, evidence claim, check result, or artifact reference.
- Rerun every required final-state check and refresh the current implementation
  summary and `## Evidence` for the new artifact.
- Set `reviewed_artifact` to exactly the resulting `implementation_artifact` and
  accept only after a fresh two-pass review, with `review_mode: single_agent_fallback`.
- Use `closed` only after integration, as before.

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
state and some sections are append-only history. The frontmatter fields and the
current implementation summary are the mutable surface; the comments and
revision-log sections grow append-only.

### Mutable current state

These may be updated in place to reflect the latest truth:

- YAML frontmatter fields: `status`, `review_status`, `implementation_artifact`,
  `block_category`, `type`, `approved`, and other mechanical state.
- The one current `## Scope Completed` (or legacy `## Implementation Summary`)
  section. This section may be refreshed to match the latest artifact and
  evidence.

### Append-only history

These sections grow over the life of the task and must not be rewritten or
truncated:

- `## Comments` -- dated notes on status changes, context, and decisions.
- `## Revision Log` -- dated entries recording corrections to previously
  published claims, evidence, artifact references, or check results.
- `## Verification Attempts` -- per-`RC-N` attempt, prediction, and triage
  history. Append entries only; do not rewrite a prior record.
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
