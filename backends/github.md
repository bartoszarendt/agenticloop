# GitHub Task Backend

Status: optional projection.

The GitHub backend stores task records as GitHub issues and implementation
artifacts as pull requests. It is an optional projection enabled only when
`.agenticloop/project.md` sets `task_backend: github`. A GitHub remote alone
does not activate this backend. The default backend is files; see
`agenticloop/backends/files.md`.

For agent-authored task work, GitHub-backed means issue, task branch, pull
request, review, and merge. Direct commits to the default or integration branch
are not valid automated implementation artifacts unless a human approves and
records a no-PR exception before implementation starts.

## GitHub-Specific Configuration

GitHub-only label and branch config lives under `backends.github` in
`agenticloop.json`:

| Key | Purpose |
|---|---|
| `titlePrefixRegex` | Extracts the task ID prefix from an issue or PR title. The default supports multi-segment IDs such as `P7-01`, `P6-FU-1`, `P3-10-FU-1`, `P2-FU-A10`, `CI-01`, and `FOUND-001`. |
| `groupLabelTemplate` | Optional override for grouping labels. When omitted, Agentic Loop uses the current grouping profile default. |
| `taskLabelTemplate` | Template for the task label (for example `task:{taskId}`). |
| `labels.agentReady` | Label marking a task record ready for the engineer. |
| `labels.blocked` | Label marking a blocked task. |
| `labels.approved` | Label marking an approved change-request task. |
| `labels.typeImpl` | Label for a normal implementation task. |
| `labels.typeChangeRequest` | Label for a locked-decision change task. |

Grouping-profile defaults live under `groupingProfiles.<profile>` in
`agenticloop/config.json`. Backend-neutral naming (task ID regex, task file
template, grouping profile) stays in `.agenticloop/project.md`.

## Storage Model

| Agentic Loop object | GitHub projection |
|---|---|
| Task record | Issue |
| Task ID | Issue title prefix and `task:<TASK-ID>` label |
| Grouping | Optional grouping label such as `phase:1` when the project uses grouping |
| Implementation artifact | Pull request linked to the issue by a recognized closing keyword |
| Evidence | PR body for normal implementation evidence; comments for status markers, later evidence updates, and documented exceptions |
| Review status | Review comment marker |
| Blocked state | Issue label plus status marker comment |
| Completion summary | Inline in the PR body (per task) |
| Closeout | Status marker comment citing the covered task ids |

## Operations

### Create Task Record

Create one GitHub issue per implementation task before implementation starts.
The issue body uses `agenticloop/memory/task-record.md`.

Creating the GitHub issue is required, not optional. Implementation must not
start until the issue exists as the durable task record. If the issue cannot be
created (missing labels, auth unavailable), the maintainer must stop and record
the blocker using [[blocked-state]] rather than silently continuing with a
local files trace.

The issue body must contain the full task-record contract from
[[task-record-contract]], including a non-placeholder `## Completion Summary
Template` and a non-placeholder `## Reviewer Checklist`. Labels indicate state
but do not substitute for complete issue content.

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

Apply the configured task label and, when the project uses grouping, the
configured grouping label. Use `agent-ready` only after the maintainer confirms
the record is complete enough for implementation.

### Read Task Record

Read the issue body, labels, linked pull requests, and comments. When deriving
state from comments, prefer the latest valid marker from the configured loop
identity and use attribution trailers as cooperative role hints.

### List By Grouping And Status

List open issues by status labels such as `agent-ready`, `blocked`, `approved`,
or project-specific equivalents configured in `agenticloop.json`, plus the
optional grouping label when the project uses grouping.

### Update Status

Use labels for coarse state and comments for durable status evidence.

Common labels:

```text
agent-ready
blocked
approved
type:impl
type:change-request
task:<TASK-ID>
```

When the project uses grouping, add the configured grouping label as well. For
example, a phase-grouped project may use `phase:1`.

### Mark Needs Context

Post a comment containing:

```text
AGENT_TASK_STATUS: needs_context
```

State what is missing and who can answer.

### Mark Blocked

Apply the `blocked` label and post a comment containing:

```text
AGENT_TASK_STATUS: blocked
AGENT_BLOCK_CATEGORY: <category>
```

Follow [[blocked-state]] for categories and resume rules.

### Attach Implementation Evidence

Publish implementation evidence in exactly one durable place. For a normal
implementation task with a pull request, include the implementation summary in
the pull request body. Include fresh command output from the final state.

Maintainer review comments verify the artifact under review; they do not replace
the engineer's PR-body implementation summary or evidence. If the PR body is
missing required implementation evidence, the reviewer must request revision
rather than supplying that evidence in the review comment.

Do not post a separate issue or pull request comment that duplicates the
current pull request body. If evidence must be corrected after the pull request
exists, update the pull request body when possible. Use a separate issue or
pull request comment only for a later evidence update, a documented no-PR
exception, or a backend limitation that prevents updating the pull request body.
When using a separate comment for mutable evidence, edit the latest
agent-authored implementation evidence comment instead of adding an equivalent
new comment.

### Link Implementation Artifact

Open one pull request per normal implementation task. Include the
implementation summary and a recognized GitHub closing keyword for the task
issue in the PR body:

```text
Closes #<issue-number>
```

Use the real task issue number. For normal implementation tasks, omitting the
closing keyword is a linkage defect even if the pull request title, body, or
comments mention the issue. Skip the closing keyword only when the task record
contains an explicit no-PR or no-close backend exception approved before
implementation.

An issue comment with implementation evidence is not a substitute for the pull
request. If a task is intentionally completed without a PR, the task record and
summary must state the explicit exception and why no reviewable PR artifact
exists.

Automated work must not treat docs, configuration, workflow, or infrastructure
changes as exempt from the pull request path. Human-authored repository
maintenance may remain outside Agentic Loop when the human intentionally
handles it, but once a task is delegated to an agent role, the GitHub backend
requires a task branch and pull request unless the task record already contains
a human-approved no-PR exception.

A task branch has one terminal merge path. After the pull request is merged by
merge commit, squash, or rebase, do not also merge the same task branch into the
default branch as a second path for the same work. If the branch state is
unclear, stop for human direction instead of creating a criss-cross history.

### Parallel Write Lanes

Concurrency safety is governed by mutation, not by role. See the lane
definitions and backend-specific rules in `agenticloop/AGENTIC_LOOP.md`.

For an authorized multi-task unit with 2 or more ready issues, the orchestrator
runs the Parallel Opportunity Scan in `agenticloop/AGENTIC_LOOP.md` before
defaulting to serial. A bounded parallel batch defaults to a maximum of 3
implementation lanes. Review and integration (merge) remain serial after the
join. Choosing serial execution after eligible candidates exist requires a
recorded concrete reason (dependency edge, shared generated file or lockfile,
schema/API ordering, shared external state, or a host that cannot bound or
surface parallel lanes); "parallel is complex" is not a reason.

**Implementation lanes.** Each parallel implementation lane requires its own
`git worktree`, its own task branch, its own GitHub issue, its own pull request,
disjoint expected files or areas, and no shared generated files, lockfiles,
schema, API, or external-state collision. A branch alone is not sufficient when
multiple agents share one checkout. Copying selected touched files into a
temporary folder is not valid isolation. Create each lane worktree at a
repo-internal path (`git worktree add .agenticloop/worktrees/<task-id>
<branch>`), never as a `../sibling` outside the repository root -- an external
worktree falls outside the host's workspace sandbox and triggers an
access-prompt that stalls autonomous runs. See Worktree placement in
`agenticloop/AGENTIC_LOOP.md`.

**Coordination/review lanes.** Parallel maintainer or orchestrator lanes that
mutate GitHub backend state -- issues, PRs, labels, review comments, status
markers, closeout markers, or event logs -- may run only when each lane owns
distinct backend objects (for example, distinct issues or distinct PR review
targets) and the concurrency plan proves that no shared labels, comments, status
markers, closeout state, event logs, or group state collide. If lanes must touch
the same issue, PR, or label set, run them serially.

**Merge barrier.** Do not merge any pull request from a parallel batch into the
default or integration branch until every parallel lane has returned, maintainer
review is complete for every implementation artifact, cross-branch conflict and
ordering risk has been checked, and the human approves the merge order. If a pull
request can safely merge without waiting for the other lanes, treat it as an
ordinary independent task instead of part of a parallel batch.

**Join behavior.** Missing pushed branch or missing PR at join time is a
failed or blocked lane, not a pending lane. The orchestrator must not wait
indefinitely.

### Record Review Status

Post exactly one valid review marker in the maintainer review:

```text
AGENT_REVIEW_STATUS: accepted
AGENT_REVIEW_STATUS: needs_revision
```

A later valid marker supersedes an earlier one.

For status comments that are meant to be mutable, prefer editing the latest
agent-authored marker comment instead of adding another equivalent marker. For
pull request reviews, fetch existing reviews and the current head revision
before posting. If the latest valid agent-authored marker already records the
same outcome for the same pull request head, do not submit another review.
If a review submission command returns ambiguous output, fetch reviews before
retrying; retry only when no valid marker with the intended outcome was
accepted.

### Close Or Accept Task

Accept only after scope, quality, evidence, and follow-up triage pass review of
the linked pull request. Before acceptance or merge, verify that the pull
request body resolves to the expected closing issue reference, for example with
`gh pr view <pr> --json closingIssuesReferences`. If the task issue is absent
from that field, update the pull request body or request revision before
accepting.

Close through the merged pull request. After merge, verify that the task issue
is closed before emitting `task.closed` or treating the task as durably closed.
If a pull request was already merged without closing the issue, close the issue
with an explicit comment linking the merged pull request and record the missing
closing-keyword process gap in the review, task record, or closeout marker note.
Use an explicit close comment without a PR only for a documented no-PR backend
exception.

### Record Outcome

For GitHub-backed tasks, record the optional `## Outcome` section in a
maintainer closeout issue comment by default. Update the issue body with the
`## Outcome` content only before the issue is closed when practical. Do not put
`## Outcome` in the pull request body; the PR body remains the implementation
summary source, not the Outcome source.

When `## Outcome` is conditionally required (review rounds > 1, failed or
triaged checks, blocked/needs_context state, scope drift, stale evidence, human
intervention, or follow-ups), the maintainer must post it as a durable issue
comment before or during closeout.

### Run Closeout

Closeout is a verify-and-mark gate; it does not publish a separate summary
artifact. When a human-identified task set or configured group finishes, confirm
each task's inline PR-body summary and evidence are complete, then post the
closeout status marker as a comment on the last task issue or PR in the work unit
(or on the tracking issue when one exists), citing the covered task ids:

```text
AGENT_CLOSEOUT_STATUS: complete
AGENT_CLOSEOUT_STATUS: follow_up_required
```

## Bootstrap Labels (GitHub-Only First Run Setup)

This section applies only when `task_backend: github` is configured. If using
the files backend (the default), skip this section.

GitHub labels must exist before the loop can apply them to issues. Label
bootstrap is first-run setup for GitHub-backed projects, not optional workflow
decoration.

Run these commands from the target repository root:

```text
gh label create agent-ready --description "Agentic Loop task record ready for implementation" --color 0E8A16
gh label create blocked --description "Agentic Loop task is blocked" --color B60205
gh label create approved --description "Agentic Loop change request approved" --color 5319E7
gh label create type:impl --description "Agentic Loop implementation task" --color 1D76DB
gh label create type:change-request --description "Agentic Loop locked-decision change request" --color FBCA04
```

Task labels are created per task. Group labels are created only when the
project uses grouping. Generic example:

```text
gh label create group:sprint-1 --description "Agentic Loop group sprint-1" --color C2E0C6
gh label create task:T-001 --description "Agentic Loop task T-001" --color E4E669
```

Explicit phase-profile example:

```text
gh label create phase:1 --description "Agentic Loop Phase 1" --color C2E0C6
gh label create task:P1-01 --description "Agentic Loop task P1-01" --color E4E669
```

These commands are safe to run against any target repository where you have
write access. They do not assume a specific remote URL.

`agenticloop bootstrap-labels` is idempotent. Missing labels are created and
existing labels are reported as ok rather than treated as a loop failure.

## Summary and Trace

The per-task completion summary lives inline in the PR body (or the issue when a
no-PR exception applies). There is no separate summary artifact. Use
`agenticloop/memory/work-unit-summary.md` with `summary_unit: task` as the
canonical shape, and include the optional `## Trace` section when workflow-gate
events exist. This is a summary, not a raw transcript.

`## Evidence` should list concise verdict lines and relevant output excerpts for
every required check on the final state. The agent must still read the full
command output before claiming success. Use event-log `refs` and small `data`
for structured facts; do not create a separate parseable receipt block. Output
refs remain a deferred future policy; do not create or rely on them now.

When `.agenticloop/project.md` has `event_logging: enabled`, the local
`.agenticloop/logs/<TASK-ID>.jsonl` event log may help confirm workflow gates
alongside the issue and pull request artifacts. The GitHub issue and PR remain
the authoritative durable records.

Use GitHub-specific values inside the canonical template. Keep the summary
concise. Cite command output, issue/PR numbers, and task ids. Do not copy raw
agent exchanges.

## Command Safety

When posting structured GitHub bodies, write the Markdown body to a temporary
file under the target project's gitignored `.agenticloop/tmp/` directory and pass it with
`gh ... --body-file <path>`. Use the relative, forward-slash path
(`.agenticloop/tmp/<name>.md`) for both the write and the `--body-file`
argument; do not pass an absolute Windows backslash path, which POSIX shells
collapse into a junk filename in the repository root. Avoid heredocs,
here-strings, and long inline
`--body` strings. This is required for Markdown bodies that contain backticks,
because inline shell arguments can execute backtick code spans before `gh`
receives the body. End agent-authored GitHub bodies with the attribution
trailer from [[github-attribution]], then remove the temporary body file after
posting.

Example temporary file content at `.agenticloop/tmp/review-body.md`:

```md
## Review Status
Verdict: needs_revision

## Evidence Checked
- `gh issue view 42 --json number,title,body,labels --jq .body`
- `gh pr diff 123`

AGENT_REVIEW_STATUS: needs_revision

[[agent: maintainer]]
```

Post it with:

```text
gh pr review 123 --comment --body-file .agenticloop/tmp/review-body.md
```

Use the same temporary-file pattern with `gh issue comment` and
`gh pr comment`.
When using `gh ... --json`, extract the needed fields with `--jq` before
quoting evidence. `Evidence Checked` should list commands, refs, and concise
facts, not raw JSON payloads. `Evidence Checked` records what the reviewer
inspected. It is review evidence, not implementation evidence.
