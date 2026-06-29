---
name: task-record-contract
description: Use when creating, updating, or reading the task record for a single implementation task. Covers required task sections, no-placeholder rules, files-first task-file frontmatter, work-unit summary template, implementation artifact linkage, and safe GitHub projection posting practices. Backend projections are documented in agenticloop/backends/.
metadata:
  area: task-records
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: none
---

# Task record contract

A task record is the durable contract for one implementation task. The engineer must be able to work from the task record without guessing.

If the current role is orchestrator, route task-record creation or refinement through
[[role-delegation]] instead of writing the task record directly.

Task records are stored in the configured backend:

- **Files projection**: one Markdown file at `.agenticloop/tasks/<TASK-ID>.md`. See `agenticloop/backends/files.md`.
- **GitHub projection**: one GitHub issue per task when the project explicitly uses `task_backend: github`. See `agenticloop/backends/github.md`.

## Event Logging

If `.agenticloop/project.md` has `event_logging: enabled`, resolve the event
logging command before writing the event: use a non-empty
`event_logging_command`, or run `npx agenticloop --help` once and use
`npx agenticloop` only if it succeeds. Do not attempt event logging when
`event_logging` is disabled, and do not block the workflow if no working
command is available.

After creating a new durable task record, emit `task.created`. After materially updating an
existing task record's scope, acceptance criteria, required checks, or backend linkage, emit
`task.updated`.

Use the resolved command with `event-logging <event_type> --task <TASK-ID> --role maintainer --summary "<short fact>"`.
For normal task-scoped events, `--task <TASK-ID>` is enough to correlate related entries in one
target; the CLI derives the shared trace id unless you intentionally override it with `--trace-id`.
Record only the gate fact. Do not copy the full task body, issue body, or chat text into the
event log.

## Required sections

Use `agenticloop/memory/task-record.md` as the canonical task-record shape.
It defines the ordered required sections and the optional `Proof Pressure`,
`Grouping`, `Source Reference`, `Applicable Project Skills`, `Concurrency
Plan`, and `Outcome` sections.

The `## Outcome` section is optional for routine clean tasks, maintainer-filled
at closeout. It becomes conditionally required when any of these happened:
review_rounds > 1, failed or triaged checks, blocked/needs_context state, scope
drift, stale evidence, human intervention, or follow-ups. It reuses the existing
X-02 fields; do not add a new schema. It never replaces acceptance criteria or
proof pressure.

## Proof pressure

The optional `## Proof Pressure` section helps keep long-running or ambiguous
work aligned with the owner's real intent. The maintainer may require it when a
task is large, vague, or easy to satisfy locally while missing the actual goal.
If present, every field must be concrete.

- **Completion Oracle**: the standing observable signal the engineer checks
  during work to confirm the task is still aimed at the owner's outcome. Example:
  "The new CLI command prints the expected summary row and exits 0 on the
  fixture input."
- **Final Proof Required**: the exact evidence closeout/review needs before it
  can claim completion. Example: "A passing `npm test` run plus a diff showing
  the parser rejects the previously accepted invalid input."
- **Likely Misfire**: a concrete scenario where the agent could meet acceptance
  criteria and pass checks while still failing the owner's intent. Example:
  "The command accepts the fixture but silently drops fields for all other
  inputs."

Proof pressure complements acceptance criteria; it does not replace scope,
out-of-scope boundaries, or required checks.

## Right-sizing before task creation

Before creating or refining a task record from a source plan item, decide whether
the item is one implementation task or a task set. A human may authorize a whole
phase, group, milestone, epic, or broad work item, but that authorization does
not make the whole unit one task record.

The default sizing is one independently verifiable task at a time, the smallest
useful implementation slice. When a human authorizes a larger bounded run,
prefer the largest safe useful slice that remains bounded, reversible, and
independently verifiable as one task. Phase, group, milestone, or epic
authorization is not permission to create one oversized task record; task sets
still decompose into ordinary task records using the configured backend and task
ID convention.

A work item must be decomposed into multiple task records when any of these are
true:

- it has more than one independently verifiable deliverable;
- acceptance criteria would require several unrelated proof paths or review
  decisions;
- `Expected Files or Areas` would name several disjoint modules, layers, or
  user-facing surfaces;
- the source plan describes phase, milestone, epic, or roadmap-altitude work
  rather than one focused change;
- one slice can be implemented, checked, reviewed, or reverted without the rest.

When decomposition is needed, create ordinary task records using the configured
backend and task ID convention. Preserve the source plan item in `Source
Reference`, and use `Grouping` when the project map has a grouping profile. Keep
the split one level deep: phase or broad item to task records. Do not create a
separate subtask model.

If the maintainer cannot decide the split without human judgment, post
`needs_context` with the proposed task list and stop instead of creating one
oversized task record. If the work item is genuinely one implementation task,
the task record's scope, expected files, acceptance criteria, and required
checks must make that clear.

## No placeholders

The following are forbidden in any durable task record:

- `TBD`
- `as needed`
- `etc.`
- `similar to previous task`
- `to be filled`
- `to be filled during review`
- empty `## Completion Summary Template` body
- empty `## Reviewer Checklist` body
- empty or placeholder `## Proof Pressure` field when that section is present

Scope, acceptance criteria, required checks, the completion summary template, and the reviewer
checklist must all be concrete at task creation time. A placeholder in any of these sections is
a task-record defect, not a detail to fill in later. If `## Proof Pressure` is present, its
fields must also be concrete.

If the maintainer cannot fill a concrete completion template or reviewer checklist at creation
time, it must post `needs_context` using [[blocked-state]] instead of creating a vague record.

## Completion summary template

Every task record must include a non-empty `## Completion Summary Template` section at
creation time. The maintainer fills in the expected structure so the engineer knows exactly
what to produce. Use `agenticloop/memory/work-unit-summary.md` with `summary_unit: task`
for the canonical summary shape.

Each section must contain at least a one-line description of what is expected, not a generic
placeholder. Example: "Tests and Checks Run: final-state `python -m pytest tests/ -q` verdict
with counts, must show all tests passing." Copying section headings without content is a
placeholder violation.

## Reviewer checklist

Every task record must include a non-empty `## Reviewer Checklist` section at creation time.
The maintainer writes checklist items specific to this task. Minimum required items:

- [ ] Task scope verified against source documents listed in "Source Documents Reviewed".
- [ ] Out-of-scope files: any files touched outside "Expected Files or Areas" are justified.
- [ ] Required checks run on the final state with concise verdict lines or relevant excerpts.
- [ ] If `## Proof Pressure` is present, completion oracle, final proof, and likely misfire were checked.
- [ ] Backend canonical current-summary location updated with implementation summary: task file for files-backed work; PR body for normal GitHub-backed work; documented exception location for approved no-PR/no-edit cases.
- [ ] Implementation artifact linked to the task record.
- [ ] Parallel delegation, if used, followed the recorded concurrency plan and join condition.
- [ ] GitHub-backed normal implementation tasks: PR body includes `Closes #<issue-number>`.
- [ ] Known limitations triaged: each one folded back, filed as follow-up, or explicitly dismissed.
- [ ] No secrets, generated caches, or runtime artifacts committed.

Task-specific items must be added for any non-obvious acceptance criterion, unusual scope
boundary, or project-specific constraint the engineer must satisfy.

A reviewer checklist that is identical across multiple tasks or consists only of generic items
must be reviewed for whether task-specific items were omitted.

## Required Checks

Required Checks name the proving command or check the engineer must run on the
final state. The maintainer may reference a verification decision when a
required check has a known non-obvious execution strategy.

Example:

- `npm test`; see `.agenticloop/decisions/D-YYYY-MM-DD-001.md` for execution strategy.

Required Checks still name the proving command or check. Prefer accepted
decisions for binding execution strategy. Proposed verification decisions may
be referenced as current evidence-backed guidance when no accepted decision
exists, but the task record should state that the linked decision is
`proposed`. A decision link explains how to run it safely; it does not remove
the requirement unless the task explicitly changes the check.

## Expected files or areas

The expected files or areas section is the task's human-readable scope map. It names the files, modules, commands, tests, and docs the engineer is expected to inspect or touch.

The optional frontmatter field `allowed_paths` is the structured scope map. It accepts a YAML list of repo-relative glob-like path patterns. Forward slashes are canonical. Absolute paths and `..` traversal are not allowed. Directory entries may end with `/` and mean everything beneath that directory. Exact file paths match that file. Simple glob support is enough for now: `*`, `**`, and `?`. The compatibility alias `expected_files` is accepted when `allowed_paths` is absent.

When `allowed_paths` is present, `agenticloop validate` performs a warn-only mechanical check that changed files in the working tree match at least one allowed pattern. Out-of-scope changed files surface as warnings; reviewers still enforce unexpected files through `## Deviations From Plan`. The structured field does not replace the human-readable `## Expected Files or Areas` section.

If implementation changes an unexpected file, the implementation summary must explain why. Review treats unexplained unexpected files as a scope issue under [[review-and-accept]].
Bundling an incidental toolkit, dependency, or asset-refresh change into a task that does not require it is the same scope violation. If a refresh is genuinely needed, it is its own task and its own artifact.

## Concurrency plan

Add `## Concurrency Plan` when the orchestrator authorizes parallel delegation.
The plan names each lane id, lane type (read-only, implementation, or
coordination/review), role, read/write mode, owned backend objects, worktree
path and branch for file-mutating write lanes, implementation or workflow
artifact, allowed files or areas, shared collision risks (including shared
generated files, lockfiles, schemas, APIs, external state, labels, comments,
status markers, closeout state, event logs, and group state), lease checkpoint
cadence, stop condition, and join condition. If no parallel delegation is
planned, omit the section or state that work is serial.

## Parallel Safety

Add `## Parallel Safety` when the task belongs to an authorized multi-task work
unit. The maintainer fills it during decomposition so the orchestrator's Parallel
Opportunity Scan (see `agenticloop/AGENTIC_LOOP.md`) can classify the task without
re-deriving it. This section complements `## Expected Files or Areas` and the
`allowed_paths` frontmatter; it does not replace either one.

Fields:

- **Owned paths**: the paths this task expects to own for writes.
- **Shared or generated files**: bundler/codegen output, fixtures, snapshots that
  other tasks might also touch.
- **Schema/API/lockfile risk**: schema, API ordering, or lockfile collisions.
- **Backend objects owned**: task file(s), GitHub issue/PR, labels, or other
  records the lane mutates.
- **Dependency edges**: other tasks in the unit that must finish first.
- **Parallel eligibility**: `eligible`, `blocked`, or `unknown`.
- **Reason**: the concrete basis for the eligibility verdict; when `unknown`,
  name the missing information a bounded read-only discovery step would resolve.

A standalone single task outside a multi-task unit may omit the section.

## Bug tasks

Bug task records must include reproduction status:

- **Confirmed**: exact command, input, observed failure, and wrong output or stack trace.
- **Not reproducible**: what was tried and what happened.
- **Insufficient information**: what evidence is missing.

A bugfix without a confirmed or explicitly investigated reproduction starts from [[debugging-before-fixes]], not from a speculative patch.

## Backend enforcement

Before creating a task record, read `.agenticloop/project.md` for the `task_backend`
value and task naming convention. If `.agenticloop/project.md` is absent, the default
backend is `files`.

If `task_backend` is `files` (the default):

- The local Markdown task file is the durable task record.
- Default task IDs use `T-<number>` format (for example `T-001`) unless the project map
  specifies a different pattern.
- Keep machine-readable task state in frontmatter, including `task_id`, `status`, `backend`,
  and `implementation_artifact` once implementation exists.

If `task_backend` is `github`:

- A GitHub issue is the durable task record. Create it before implementation starts.
- Agent-authored task work must use a task branch and pull request. Do not commit automated
  implementation work directly to the default or integration branch.
- A local file under `.agenticloop/tasks/` may mirror or supplement the GitHub issue, but
  cannot silently replace it.
- If required labels are missing, the maintainer must either bootstrap them using the
  commands in `agenticloop/backends/github.md`, request human action, or mark `needs_context` with
  [[blocked-state]].
- A files-only task record while `task_backend: github` is set is an exception. It must be explicitly
  labeled as an exception in the task file with a short reason (for example GitHub auth
  unavailable, labels not bootstrapped, human-approved fallback). Silence is not an
  acceptable exception.

## GitHub projection: labels and title

For GitHub-backed work, apply the configured labels and title format described in `agenticloop/backends/github.md`:

- issue title starts with the task id, such as `T-001 Add setup docs`;
- apply the configured grouping label when the project uses grouping (for example `phase:1` under `grouping_profile: phase`);
- apply the configured task label (for example `task:<TASK-ID>`);
- apply `type:impl` for normal implementation or `type:change-request` for locked-decision changes.

`type:change-request` must pass [[change-request-gate]] before implementation.

## Implementation summary

After implementation, the engineer publishes one current implementation summary using
`agenticloop/memory/work-unit-summary.md` with `summary_unit: task`. Every accepted
or closed task must have this filled inline summary; it is not optional.

`Evidence` includes fresh final-state command evidence for every required check, plus RED evidence for new behavior when applicable. See [[verification-evidence]] and [[tdd-implementation]].

For files-backed work, publish or refresh the one current implementation summary in the task
file (`.agenticloop/tasks/<TASK-ID>.md`) and keep `implementation_artifact` current in
frontmatter. Do not post implementation progress only in chat; the task file is the durable
record. The current summary may be updated to reflect the latest artifact and evidence. Do
not silently rewrite previous claims:
if the refresh corrects earlier evidence, artifact references, check results, or behavior
claims, append a dated correction entry to `## Revision Log` or `## Comments` before
refreshing.

For GitHub-backed work, put the current implementation summary in the pull request body by
default. Do not also post the same summary as an issue or pull request comment. If evidence
changes after the pull request exists, update the pull request body when possible; otherwise
edit the latest agent-authored implementation evidence comment or add one comment only when no
editable evidence location exists. GitHub comments and timeline provide the append-only history.

Docs, configuration, workflow, and infrastructure changes are not exempt from this rule when
they are agent-authored task work. Human-authored maintenance can stay outside the loop when
the human intentionally handles it. For files-backed work, an automated role still needs the
task file plus a recorded `implementation_artifact`. For GitHub-backed work, an automated role
needs a task issue, branch, pull request, and review unless a human-approved no-PR exception is
recorded before implementation.

Declare every deviation from the task record. Hidden correction of failed checks, skipped
checks, artifact references, behavior claims, or scope changes is a review blocker.

## Files-backed current state and history

Files-backed task records use a hybrid model. See `agenticloop/backends/files.md` for the full
discipline. In summary:

- Frontmatter fields (`status`, `review_status`, `implementation_artifact`, and others) are
  mutable current state and may be updated in place.
- The one current implementation summary (the `## Scope Completed` or `## Implementation
  Summary` section) may be refreshed to match the latest artifact.
- `## Comments`, `## Revision Log`, blocker sections, and maintainer review rounds are
  append-only history and must not be rewritten or truncated.
- If refreshing the current summary changes a previously published claim, evidence, or artifact
  reference, append a dated `## Revision Log` or `## Comments` entry first.

## Implementation artifact linkage

Link the implementation artifact to the task record using the backend projection:

- **Files**: set `implementation_artifact` in task-file frontmatter (for example `branch:<name>`, `commit:<sha>`, or `range:<base>..<head>`) and publish or refresh the current implementation summary in the task file.
- **GitHub**: open one pull request per normal implementation task. The PR body includes
  the implementation summary and `Closes #<issue-number>` for the task issue. This links
  the PR to the issue and closes the task when merged. A prose issue mention or plain
  issue URL is not enough for normal GitHub-backed implementation tasks.

For GitHub-backed tasks, an issue comment with implementation evidence is not enough by itself.
It supports review, but the reviewable implementation artifact is the pull request diff. If a
task intentionally has no PR, the task record and implementation summary must state the explicit
backend exception and why review can proceed without one.

## Safe posting

For GitHub-backed work, post issue, PR, and comment bodies through a temporary
Markdown file and `gh ... --body-file <path>`, not heredocs, here-strings, or a
single inline `--body` argument. End every body with the attribution trailer
from [[github-attribution]].

Write temporary body files under the target project's gitignored `.agenticloop/tmp/`
directory and remove them after posting. The canonical path is `.agenticloop/tmp/`
(with the slash separator); never create `.agenticlooptmp/`, `.agenticloop-tmp/`,
or other root-level lookalikes. Do not write task bodies, patches, evidence
dumps, or other scratch files to the system temp directory, user profile, host
runtime directories, or repository root.
