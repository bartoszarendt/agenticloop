# Task Backends

A task backend stores and updates Agentic Loop task records. It does not define
a separate workflow.

The shared workflow lives in:

- `agenticloop/AGENTIC_LOOP.md`
- `agenticloop/agents/`
- `agenticloop/skills/`

Backend docs define only the projection from shared task-record operations to a
storage mechanism.

Each projection keeps one mutable current implementation summary/evidence surface
for the exact artifact under review. Append-only verification-attempt carriers
are exceptional execution history: use them for failed, timed-out, blocked,
retried, escalated, or triaged checks, not as a duplicate record of every routine
successful final-state check. See [[verification-evidence]] for the shared rule.

## Backends

| Backend | Status | Projection |
|---|---|---|
| [files](files.md) | Supported default | Local Markdown files under `.agenticloop/tasks/` |
| [github](github.md) | Optional projection | GitHub issues, labels, comments, pull requests |

## Operation Contract

Every backend must describe how to:

1. Create a task record.
2. Read a task record.
3. List task records by optional grouping and status.
4. Update task status.
5. Mark `needs_context`.
6. Mark `blocked`.
7. Attach implementation evidence.
8. Record exceptional verification-attempt history when required.
9. Link the implementation artifact.
10. Record review status.
11. Close or accept the task.
12. Run closeout (verify inline summaries and post the status marker) when closeout applies.

Skills and roles should use backend-neutral language first. Backend-specific
commands belong in the backend projection doc.

## Configuration

The active backend is set in `.agenticloop/project.md` frontmatter:

```yaml
task_backend: files
```

The default is `files`. Set `task_backend: github` to use GitHub issues and
pull requests as the task projection.

`agenticloop.json` is adapter/tooling config. Keep backend behavior settings
under `backends.github.*` and `backends.files.*`; those configure projection
paths, labels, and similar behavior, but they do not select the active backend.

If an older target still has top-level `taskBackend` in `agenticloop.json`,
treat it as legacy compatibility only. Remove it once `.agenticloop/project.md`
exists.

## Migrating Between Backends

Migrating a task record from one backend to another is a storage projection
change, not a workflow change. The task-record content, roles, and skills stay
the same.

### GitHub issue -> local task file

1. Create `.agenticloop/tasks/<TASK-ID>.md` using `agenticloop/memory/task-record.md` and the projection rules in `agenticloop/backends/files.md`.
2. Copy and map all task-record fields:
   - Issue title prefix -> `task_id` frontmatter and file heading.
   - Grouping label (when present) -> optional grouping/frontmatter fields.
   - Issue label state (`agent-ready`, `blocked`, `approved`) -> `status` frontmatter.
   - `blocked` label + `AGENT_BLOCK_CATEGORY` comment -> `block_category` frontmatter + blocker section.
   - Issue body sections (Scope, Acceptance Criteria, and so on) -> corresponding Markdown sections in the task file.
   - Implementation evidence (PR body, or a non-duplicate implementation summary comment) -> current implementation summary section (refreshable; see files.md correction rule).
   - PR closing keyword, or documented no-close exception -> `implementation_artifact: branch:<name>` frontmatter.
   - Review marker comments -> `review_status` frontmatter + appended review section.
   - Known limitations and follow-up data -> preserved in the task file body.
   - Issue/PR numbers and GitHub URLs -> recorded in a `## Provenance` section for traceability.
3. Set `backend: files` in frontmatter.
4. Update `task_backend` in `.agenticloop/project.md` to `files`.
5. Close the original GitHub issue with a comment linking to the new task file path.

### Local task file -> GitHub issue

1. Create a GitHub issue with the task body using `agenticloop/memory/task-record.md` and the projection rules in `agenticloop/backends/github.md`.
2. Map fields back:
   - `task_id` -> issue title prefix and `task:<TASK-ID>` label.
   - Optional grouping -> the configured grouping label when the project uses grouping.
   - `status` -> corresponding labels (`agent-ready`, `blocked`, `approved`).
   - `block_category` + blocker section -> `blocked` label + `AGENT_TASK_STATUS: blocked` / `AGENT_BLOCK_CATEGORY:` comment.
   - Body sections -> issue body sections.
   - Current implementation summary -> PR body for normal implementation artifacts, or one implementation summary comment on the issue when no editable PR body exists.
   - `implementation_artifact` -> pull request linked with a closing keyword unless a no-close exception is recorded.
   - `review_status` -> review marker comment.
   - Known limitations and follow-ups -> preserved in issue body or follow-up task records.
   - Provenance note -> note linking back to the local file path and any commit range.
3. Apply `agent-ready`, task, and optional grouping labels; mark `approved` if the file had that status.
4. Update `task_backend` in `.agenticloop/project.md` to `github`.
5. Archive or remove the local task file, or keep it as a historical reference under `## Provenance`.

### What migration preserves

Migration must carry over:

- task id, scope, out of scope, acceptance criteria, required checks, expected files/areas
- optional grouping, source references, and applicable project skills
- status, blocker category and context, context-round history
- review status and review detail
- implementation evidence and implementation artifact link
- closeout and follow-up data
- attribution and provenance where available

Fields that have no equivalent in the target backend (for example a GitHub issue
number when moving to files) are recorded in a `## Provenance` section so the
audit trail is not lost.

### Cross-backend surface mapping

The two backends project the same task-record surfaces onto different storage.
This mapping is a migration and orientation aid; neither backend depends on the
other at runtime.

| Files backend | GitHub backend |
|---|---|
| Frontmatter fields | Labels, PR status, issue state |
| Current implementation summary | PR body |
| `## Revision Log`, `## Comments` | PR/issue comments, timeline |
| Maintainer review sections | PR review comments |
| Git commits of the task file | Git commits of the PR |
