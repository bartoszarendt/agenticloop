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

Event logging is optional and off by default. When enabled, follow
[[event-logging]]: emit `task.created` for a new record and `task.updated` after
material scope, criteria, check, or backend-linkage changes. Use the task id and
a concise gate fact; never copy the task body or chat into the log.

## Required sections

Use `agenticloop/memory/task-record.md` as the canonical task-record shape.
It defines the ordered required sections and the optional `Proof Pressure`,
`Concurrency Plan`, `Parallel Safety`, `Grouping`, `Source Reference`,
`Applicable Project Skills`, and `Outcome` sections. New records also include
the `## Verification Attempts` section with the canonical empty state from
[[verification-evidence]]. Historical records without that optional learning
section remain readable.

The `## Outcome` section is optional for routine clean tasks, maintainer-filled
at closeout. It becomes conditionally required when any of these happened:
review_rounds > 1, failed or triaged checks, blocked/needs_context state, scope
drift, stale evidence, human intervention, predicted medium/high context
overflow risk, context pressure encountered, or follow-ups. It never replaces
acceptance criteria or proof pressure.

## Proof pressure

Use optional `## Proof Pressure` when long-running or ambiguous work could pass
locally while missing the owner's outcome. Every field must be concrete:

- **Completion Oracle**: observable signal checked during work.
- **Final Proof Required**: exact evidence required for completion.
- **Likely Misfire**: how local criteria could pass while the real intent fails.

Proof pressure complements acceptance criteria; it does not replace scope,
out-of-scope boundaries, or required checks.

## Right-sizing before task creation

Decide whether the source item is one implementation task or a task set. Broad
authorization does not make a phase, group, milestone, or epic one task record;
use the sizing and authorized-work-unit rules in `agenticloop/AGENTIC_LOOP.md`.

Decompose into multiple task records when any of these are true:

- it has more than one independently verifiable deliverable;
- acceptance criteria would require several unrelated proof paths or review
  decisions;
- `Expected Files or Areas` would name several disjoint modules, layers, or
  user-facing surfaces;
- the source plan describes phase, milestone, epic, or roadmap-altitude work
  rather than one focused change;
- one slice can be implemented, checked, reviewed, or reverted without the rest;
- estimated engineer context load would likely exceed the safe single-task
  ceiling even though the item has one deliverable.

Preserve `Source Reference`; use `Grouping` when configured. Split one level
deep into task records, not a subtask model. If human judgment is needed, return
`needs_context` with the proposed split instead of creating an oversized task.

## Materializing a task set

Materialize durable records incrementally: one per write/checkpoint by default,
at most 3 similar low-risk records per batch, and one-at-a-time for 10 or more.

Before writing full records, produce or retain a compact decomposition inventory
per task: task id, title, one-line scope, source reference, dependency edges,
expected owned files/areas, initial parallel eligibility, and context overflow
risk when medium or high.

After each batch, validate completeness, emit enabled events, checkpoint, and
commit files-backend task artifacts when project policy requires it. Resume at
the first missing or invalid record; never regenerate the set.

The fix for large task sets is smaller writes, not thinner task records. Do not
replace concrete required sections with placeholders or generic checklists to
make a batch fit.

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

Scope, criteria, checks, summary expectations, reviewer items, and any proof
pressure must be concrete at creation. Otherwise use [[blocked-state]]
`needs_context` instead of writing a vague record.

## Completion summary template

Every record includes a non-empty `## Completion Summary Template` using
`agenticloop/memory/work-unit-summary.md` with `summary_unit: task`. State the
task-specific evidence expected; headings without content are placeholders.

## Reviewer checklist

Every task record must include a non-empty `## Reviewer Checklist` section at creation time.
The maintainer writes checklist items specific to this task. Minimum required items:

- [ ] Task scope verified against source documents listed in "Source Documents Reviewed".
- [ ] Out-of-scope files: any files touched outside "Expected Files or Areas" are justified.
- [ ] Required checks run on the final state with concise verdict lines or relevant excerpts.
- [ ] Every exceptional verification episode ends in a pass or final non-blocker
  maintainer triage; none remains failed, blocked, timed out, `pending`, or
  triaged as a blocker at acceptance.
- [ ] If `## Proof Pressure` is present, completion oracle, final proof, and likely misfire were checked.
- [ ] Backend canonical current-summary location updated with implementation summary: task file for files-backed work; PR body for normal GitHub-backed work; documented exception location for approved no-PR/no-edit cases.
- [ ] Implementation artifact linked to the task record.
- [ ] Parallel delegation followed its plan and join condition: coupling recorded, coupled work reconciled, findings disposed, deferred findings triaged non-blocking or kept join-blocking, and integrated evidence bound to the exact combined candidate.
- [ ] GitHub-backed normal implementation tasks: PR body includes `Closes #<issue-number>`.
- [ ] Known limitations triaged: each one folded back, filed as follow-up, or explicitly dismissed.
- [ ] No secrets, generated caches, or runtime artifacts committed.

Add items for non-obvious criteria, boundaries, and project constraints; a
generic checklist reused across tasks is incomplete when task-specific risks
exist.

## Required Checks

Required Checks name the proving command or check the engineer must run on the
final state. The maintainer may reference a verification decision when a
required check has a known non-obvious execution strategy.

Example:

- [RC-1] `npm test`; see `.agenticloop/decisions/D-YYYY-MM-DD-001.md` for execution strategy.

Each Required Check must be concrete enough that an engineer's implementation
evidence can map back to it one-to-one. For GitHub-backed work the pre-review
gate (`npx agenticloop github-preflight --pr <number>`) matches each check to a
PR-body `## Evidence` entry. Prefix new checks with a unique `[RC-N]` id and
repeat it in evidence; legacy checks match by normalized text. Wording must
still name a specific command or manual check, not a vague aspiration.
Avoid bundling several distinct proofs into one bullet;
a generic "tests pass" line cannot stand in for multiple distinct required
checks.

Required Checks still name the proving command or check. Prefer accepted
decisions for binding execution strategy. Proposed verification decisions may
be referenced as current evidence-backed guidance when no accepted decision
exists, but the task record should state that the linked decision is
`proposed`. A decision link explains how to run it safely; it does not remove
the requirement unless the task explicitly changes the check.

## Verification attempts

For a new task record, place `## Verification Attempts` immediately after
`## Required Checks` with the exact empty state defined by
[[verification-evidence]]. Replace that empty state only when a required or
cited check has an exceptional episode: failure, timeout, blocked run, retry,
escalation, strategy change, maintainer triage, or a resolving attempt. Routine
first-pass success remains in current final-state evidence and needs no attempt
entry. The engineer appends attempts and any bounded foreground prediction; the
maintainer appends final triage. Do not use `## Process Observations`, a decision
record, or the current project profile as a substitute for an existing task's
attempt history.

Relevant `VF-...` facts in `.agenticloop/project.md` may be linked from a
required check as current operating context. The maintainer owns fact updates;
a fact or delegation observation does not approve a strategy. The exact shapes,
retry rule, and triage classifications are owned by [[verification-evidence]].

## Expected files or areas

The expected files or areas section is the task's human-readable scope map. It names the files, modules, commands, tests, and docs the engineer is expected to inspect or touch.

The optional frontmatter field `allowed_paths` is the structured scope map. It accepts a YAML list of repo-relative glob-like path patterns. Forward slashes are canonical. Absolute paths and `..` traversal are not allowed. Directory entries may end with `/` and mean everything beneath that directory. Exact file paths match that file. Simple glob support is enough for now: `*`, `**`, and `?`. The compatibility alias `expected_files` is accepted when `allowed_paths` is absent.

When `allowed_paths` is present, `agenticloop validate` performs a warn-only mechanical check that changed files in the working tree match at least one allowed pattern. Out-of-scope changed files surface as warnings; reviewers still enforce unexpected files through `## Deviations From Plan`. The structured field does not replace the human-readable `## Expected Files or Areas` section.

If implementation changes an unexpected file, the implementation summary must explain why. Review treats unexplained unexpected files as a scope issue under [[review-and-accept]].
Bundling an incidental toolkit, dependency, or asset-refresh change into a task that does not require it is the same scope violation. If a refresh is genuinely needed, it is its own task and its own artifact.

## Context overflow risk

Context overflow risk estimates whether one engineer execution can stay within
the model's active context window with safety headroom. It is not a precise token
count, billing estimate, or license to relax scope.

Use cheap sizing signals already needed for task creation: breadth of expected
files or areas, known input size, likely tool output, required discovery,
debug/revision risk, and whether one surface is unusually large. Do not perform
a separate repository scan or file-content measurement pass just to estimate
context. Tokenize known input mechanically when a cheap tokenizer is available;
otherwise store only the risk verdict.

Use `.agenticloop/project.md` `engineer_context_window_tokens` when present, or
the engineer model's known active context window otherwise. Do not target the
full window. Reserve roughly 25-35% for role prompts, task record text,
tool-output surprises, review feedback, and final summary. Scale the ladder from
the active context window `W`: below about `0.25 * W` is normally low when
uncertainty is low; `0.25-0.55 * W` is medium when it changes engineer context
discipline; `0.55-0.75 * W` is high and should be tightened or split unless
justified; above `0.75 * W` should decompose; above `0.85 * W` must not be
delegated as one engineer task. For a 256k window, those cutoffs are roughly
60k, 140k, 190k, and 220k.

Record `context_overflow_risk: medium` or `high` only when it changes behavior.
Add a one-line `context_note` for medium or high risk. Omit the fields for
ordinary low-risk tasks; do not write `context_overflow_risk: low`. Medium risk
is an engineer context-discipline signal. High risk is an orchestrator split or
tightening signal unless the task record gives a concrete reason one engineer
execution can stay within safe active-context headroom. A medium or high verdict
tells the engineer to summarize or return `needs_context` if unexpected
discovery would expand beyond the task record.

At closeout, record `context_pressure_encountered: true|false` in `## Outcome`
when the task had medium/high risk or actually hit context pressure. This
calibrates the estimate without storing raw prompts, token streams, or tool
output.

## Implementation notes

`## Implementation Notes` records constraints, sequencing, or migration notes.
For nontrivial or churn-prone work, the maintainer may also include an optional
numbered, file-level stepped plan (`N. <action> -- file: <path>`). The engineer
reads it as a strong prior, verifies assumptions, and records divergence under
`## Deviations From Plan` rather than following stale steps.

Keep the plan DRY: reference `## Expected Files or Areas`, `## Required Checks`,
and `## Proof Pressure` for files, checks, and escalation signals; do not
restate them. Add stale-assumption triggers that tell the engineer when to return
`needs_context` instead of continuing.

## Concurrency plan

Use `## Concurrency Plan` for every current Parallel Opportunity Scan. With fewer
than two ready tasks, record the truthful `not currently eligible` result and a
rescan trigger; with two or more ready tasks, record the full scan before any
implementation delegation. Do not duplicate one scan in every task. When the
orchestrator authorizes parallel delegation, the same section also names each
lane's id, type (read-only, implementation, or
coordination/review), role, read/write mode, owned backend objects, worktree
path and branch, artifact, allowed files or areas, and shared collision risks
(including test/fixture/snapshot/shared-helper ownership), plus lease
checkpoint cadence, stop condition, and join condition. The plan also records
the knowledge-coupling classification per lane pair (with the two-wave pattern
when coupled), the finding-routing procedure and recipient dispositions, the
verification topology for each planned check, the integration-rehearsal
trigger and owner (or the recorded reason it is omitted), the intended
artifact composition order, and the rerun/invalidation trigger for stale
integrated evidence. The join condition covers finding dispositions and
required integrated evidence. [[parallel-delegation]] owns the field meanings
and operational rules, including the durable scan fields: work unit, ready-set
snapshot, source proposals considered, configured maximum implementation lanes,
candidate lanes, mutation and knowledge independence, decision scope, shared
design questions, backend/worktree ownership, host/liveness capability,
verification/integration implications, decision, independent rationale, and
rescan trigger.

## Parallel Safety

Add `## Parallel Safety` when the task belongs to an authorized multi-task work
unit; the maintainer fills it during decomposition so the orchestrator's
Parallel Opportunity Scan can classify the task. It complements `## Expected
Files or Areas` and the `allowed_paths` frontmatter; it does not replace them.

Fields:

- **Owned paths**: the paths this task expects to own for writes.
- **Shared or generated files**: bundler/codegen output, fixtures, snapshots that
  other tasks might also touch.
- **Test/fixture/snapshot/shared-helper surfaces**: test modules, fixtures,
  snapshots, generated expectations, and shared validation helpers; writable
  collision surfaces exactly like production files.
- **Schema/API/lockfile risk**: schema, API ordering, or lockfile collisions.
- **Backend objects owned**: task file(s), GitHub issue/PR, labels, or other
  records the lane mutates.
- **Dependency edges**: other tasks in the unit that must finish first.
- **Decision scope**: the lane-local design decisions this task may make.
- **Shared design questions**: design decisions affecting multiple lanes, with
  their maintainer or serial-reconciliation owner. Resolve these before parallel
  implementation writes or use the two-wave read-only diagnosis pattern.
- **Shared assumptions/invariants**: behavioral facts, contracts, or
  verification interpretations sibling tasks rely on.
- **Discoveries that could affect other tasks**: likely findings that would
  invalidate a sibling lane's assumptions, plan, implementation, or
  verification interpretation.
- **Parallel eligibility**: `eligible`, `blocked`, or `unknown` – the
  mutation-collision verdict.
- **Knowledge coupling**: `independent`, `coupled`, or `unknown` – the
  knowledge verdict. `coupled` work uses the two-wave pattern in
  [[parallel-delegation]]. Parallel writes require `eligible` plus
  `independent`; separate worktrees never convert coupled or unknown tasks
  into independent tasks.
- **Reason**: the concrete basis for both verdicts; when either is `unknown`,
  name what a bounded discovery step would resolve.

When either verdict is `unknown` and 2 or more ready tasks could otherwise run
in parallel, the maintainer runs one bounded read-only discovery pass before
returning; if a verdict stays unknown, state what stayed unknown and recommend
serial. Host/lane capability unknowns stay with the orchestrator.

A standalone single task outside a multi-task unit may omit the section.

## Bug tasks

Bug task records must include reproduction status:

- **Confirmed**: exact command, input, observed failure, and wrong output or stack trace.
- **Not reproducible**: what was tried and what happened.
- **Insufficient information**: what evidence is missing.

A bugfix without a confirmed or explicitly investigated reproduction starts from [[debugging-before-fixes]], not from a speculative patch.

## Frontmatter fields

Task-file frontmatter carries machine-readable current state. Required fields:
`task_id`, `status`, `backend`. Optional fields include `implementation_artifact`,
`review_status`, `reviewed_artifact`, `review_mode`, `independent_review_required`, `human_review_ref`,
`allowed_paths`, `minimalism`, `attempt_budget`, `review_budget`,
`context_overflow_risk`, and `context_note`. Review provenance fields are owned
by [[review-and-accept]]. Select `independent_review_required: true` before
implementation when required by task assurance or project policy.

### minimalism

The optional `minimalism` field selects the Ponytail minimalism discipline for
maintainer and engineer roles. Allowed values: `none`, `lite`, `full`, `ultra`.

- Omitted or `none`: Ponytail is not activated by the task record.
- `lite`: build what was asked, then briefly mention the lazier alternative.
- `full`: enforce the minimalism ladder within accepted task scope.
- `ultra`: aggressively challenge unnecessary work; may recommend descoping.

Maintainer auto-selection may choose at most `full`. `ultra` requires explicit
human request or authorization because it may recommend descoping.

This is a discipline knob, not a scope reducer. Minimalism must never weaken
task scope, acceptance criteria, out-of-scope boundaries, required checks, proof
pressure, TDD, verification evidence, review, blocked-state, change-request
gates, security, trust-boundary validation, accessibility basics, or explicit
human requirements. It is procedural enforcement; there is no `minimalism`
validator.

### effort bounds

The optional `attempt_budget` and `review_budget` fields tune the process
ceilings that already exist in `agenticloop/AGENTIC_LOOP.md`. They are process
bounds, not scope reducers.

- `attempt_budget`: overrides the default-3 shared Attempt Budget for equivalent
  no-progress attempts. Default is `3` when omitted.
- `review_budget`: the number of `needs_revision` rounds allowed before the
  Review Round Checkpoint runs. Default is `3` when omitted (the checkpoint runs
  before a fourth revision).

Direction matters. Lower these to save effort on cheap or low-risk tasks;
raising either above its default needs a concrete recorded reason, because a
higher ceiling means more churn, not more assurance. They bound only the
default-3 guards: they never loosen the deliberately-tighter no-progress guards
(empty-result command, recorded-setup-gap, the "maintainer is needed" stop, and
the self-loop guard), which get no extra attempts regardless of these fields.

When a budget is reached or is likely to be exceeded, the role returns status
(`needs_context` or `blocked` via [[blocked-state]]) instead of starting another
discovery, review, or revision pass. Effort bounds never override acceptance
criteria, required checks, proof pressure, or review.

It is procedural enforcement; there is no `attempt_budget`/`review_budget`
validator.

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