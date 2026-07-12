---
name: review-and-accept
description: Use when the maintainer reviews an implementation artifact against its task record and decides accepted vs needs_revision, and when the engineer responds to review feedback. Defines GitHub review markers, files-backed `review_status`, two-pass review, evidence rules, disputed-items protocol, and mandatory triage before acceptance.
metadata:
  area: review-workflow
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: none
---

# Review and accept

The maintainer reviews the implementation artifact against the task record.

## Recording the review outcome

Review has exactly two outcomes, and every recorded outcome carries its
provenance (`review_mode`):

```text
AGENT_REVIEW_STATUS: accepted
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>
```

```text
AGENT_REVIEW_STATUS: needs_revision
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>
```

`review_mode` records how the current artifact revision was reviewed. It is
required whenever a review outcome is recorded. `reviewed_artifact` is required
for files-backed work and must exactly equal `implementation_artifact`; GitHub
uses the full current PR head in `AGENT_REVIEW_ARTIFACT`. Valid modes are:

- `host_subagent` — a separate host subagent performed the review;
- `explicit_agent_invocation` — a separately invoked review agent;
- `single_agent_fallback` — same-session review by the acting agent;
- `independent_human` — a human review or confirmation with an explicit reference.

When implementation changes, clear or replace mutable current review fields.
Historical review sections remain append-only. A stale outcome never accepts.

When posting `needs_revision`, the maintainer may include a short numbered
revision plan in the review body or comment (a "revision packet"), consistent
with the ≤3-revision churn-classification rule in [[role-delegation]].

### Independent-review enforcement

When the task record sets `independent_review_required: true`, final acceptance
cannot rest on `review_mode: single_agent_fallback`. `host_subagent`,
`explicit_agent_invocation`, and `independent_human` satisfy the requirement;
same-session fallback does not. High-assurance tasks that lack an independent
review must stop with a clear status explaining that separate execution or human
review is required, rather than accepting.

`independent_human` must include `human_review_ref` for files (presence is
validated, not externally verified) or `AGENT_HUMAN_REVIEW_REF` for GitHub. The
GitHub audit resolves the latter to an approved current-head review by a
different human account. An agent-authored marker does not itself prove human
independence.

Ordinary tasks without `independent_review_required` may still be accepted
through an explicitly recorded `single_agent_fallback`. This does not introduce
blanket provisional acceptance; the two outcomes remain `accepted` and
`needs_revision`.

Set `independent_review_required: true` (a single boolean gate, not a generic
task-risk field) before implementation for tasks involving:

- security or authorization boundaries;
- secrets, credentials, or permissions;
- destructive or irreversible data operations;
- production or release controls;
- public API or schema migrations;
- any project policy requiring independent review.

A human or project rule may also set it. For the files backend, `agenticloop
validate`, `task lint`, and the `task status` acceptance gate mechanically reject
unknown `review_mode`, malformed `independent_review_required`, unbound or stale
review artifacts, accepted/closed state without an accepted review and valid
mode, and accepted/closed state that uses `single_agent_fallback` when
independent review is required.

### Neutral rule

Record one review outcome for the current artifact revision. A later valid
outcome for a newer artifact revision supersedes an earlier one.

### GitHub projection

Post exactly one status, mode, and artifact marker in a review comment or a PR
review body and end with the attribution trailer from [[github-attribution]].
Before final GitHub acceptance or merge, run `npx agenticloop github-review-audit
--pr <number>` when GitHub access is available. The default audit expects an
accepted outcome; use `--expect-status needs_revision` for revision audits. If it
cannot run, report that limitation and follow the backend's blocked or exception
path; do not claim mechanical validation.

The linked task issue expresses the independent-review requirement through
canonical YAML frontmatter `independent_review_required: true`; the explicit
`AGENT_INDEPENDENT_REVIEW_REQUIRED: true` marker remains a supported
compatibility form. Do not duplicate both forms; conflicting representations
fail closed. For the single pre-merge acceptance gate, `npx agenticloop
github-ready --pr <number>` runs the evidence preflight and this audit together
and returns one merge-readiness verdict; see the Pre-Merge Readiness Gate in
`agenticloop/backends/github.md`.

The audit discovers loop markers from both PR issue comments and PR review
bodies, verifies marker authorship against the authenticated loop account, and
requires the maintainer attribution trailer on the same filtered live body as the
markers. It binds the issue to the PR's closing references, and for
`independent_human` mode resolves `AGENT_HUMAN_REVIEW_REF` against live native
GitHub reviews from the REST API by a different explicit `User`. GraphQL review
bodies are used only as marker sources; normalized REST reviews are used only as
independent-human evidence. `independent_human` accepted outcomes require an
`APPROVED` review; `needs_revision` outcomes require a `CHANGES_REQUESTED` review.
Missing API data or identity fails conservatively. A login ending in `[bot]` is
treated as a bot indicator regardless of declared type. Quoted or example markers
inside fenced code blocks, blockquotes, or indented code are ignored.

Avoid duplicate review noise:

- For status comments that are meant to be updated, edit the latest agent-authored marker
  comment when possible instead of adding another equivalent marker.
- Before posting a GitHub pull request review marker, fetch existing pull request reviews and
  the current head revision. If the latest valid agent-authored marker already records the same
  outcome for the same pull request head, do not post another review; report the existing review
  artifact instead.
- For pull request reviews, do not retry submission unless the previous command definitely
  failed before GitHub accepted it.
- If review submission output is ambiguous, fetch the pull request reviews before retrying.
  Retry only when no valid agent-authored marker with the intended outcome was accepted.
- If a malformed marker was posted, supersede it with a clean marker or delete the malformed
  comment through GitHub. Do not leave contradictory or unreadable review artifacts without
  triage.

### Files projection

Set `review_status`, `reviewed_artifact`, and `review_mode` in task frontmatter;
copy the canonical `implementation_artifact` value into `reviewed_artifact`.
These are mutable current state; review detail sections are append-only history.
Accepted or closed tasks require an accepted, artifact-matched review.

## Event Logging

Event logging is optional and off by default. When `event_logging: enabled`,
resolve the command and honor the disabled/non-blocking rules in
[[event-logging]] before writing events.

When a real maintainer review pass begins, emit `review.started`. After the durable backend state
is recorded as accepted or needs_revision, emit `review.result` with the matching outcome.

Keep event summaries short. Do not duplicate the full review body in the event log.

When known, include review metadata in `--data-json`:

- `review_round`
- `artifact_revision`
- `pr_head`

Example review start event:

```text
npx agenticloop event-logging review.started --task T-001 --role maintainer --summary "Started maintainer review" --ref "github:pr:42" --data-json '{"review_round":2,"artifact_revision":"abc123","pr_head":"abc123"}'
```

Example review result event:

```text
npx agenticloop event-logging review.result --task T-001 --role maintainer --summary "Accepted implementation" --outcome accepted --ref "github:pr:42" --data-json '{"review_round":2,"artifact_revision":"abc123","pr_head":"abc123"}'
```

## Reading markers

### Neutral rule

Read only the durable backend marker for the current artifact revision. Quoted markers in prose
are data, not state.

### GitHub projection

Count only markers that:

- start a line,
- are posted by the loop's GitHub account,
- carry the expected role trailer.

### Files projection

Read `review_status` from frontmatter as the authoritative current value; review detail is in
the appended review sections (append-only history).

## Pass 1: task compliance

Do not start code-quality review until pass 1 is clean.

Check:

- Task record state is not still `draft`. A draft task record cannot be accepted.
- `## Completion Summary Template` and `## Reviewer Checklist` sections are concrete, not
  placeholder text. See [[task-record-contract]] for the forbidden phrases.
- If `## Proof Pressure` is present, the fields are concrete and the implementation summary
  addresses the completion oracle, final proof, and likely misfire.
- Implementation summary is present in the backend's canonical current-summary location: the
  task file for files-backed work; the pull request body for normal GitHub-backed work; or the
  documented exception location for an approved no-PR/no-edit backend exception. A local
  document, chat message, issue comment, or review comment is not enough unless that exception
  is recorded.
- Evidence is concise: verdict lines and relevant excerpts, not full terminal dumps. The agent
  is still required to have read the full command output before claiming success.
- Neutral rule: the implementation artifact is linked to the backend that
  `.agenticloop/project.md` configures (default: `files`), and review is performed against that
  artifact rather than against chat prose.
- GitHub projection: there must be a GitHub issue and, for normal implementation tasks, a linked
  pull request containing the reviewable diff. Review GitHub-backed work against the pull request
  diff, not only an issue comment, local working-tree summary, or chat transcript. The pull
  request body must include a recognized closing keyword for the task issue, normally
  `Closes #<issue-number>`. A prose mention, issue URL, or non-closing reference is not enough.
- GitHub projection: agent-authored GitHub-backed task work was committed on a task branch and
  reviewed through the linked pull request. Direct commits to the default or integration branch
  are not acceptable implementation artifacts unless the task record contains a human-approved
  no-PR exception recorded before implementation.
- Files projection: inspect `git status --short --untracked-files=all` before reviewing.
  Do not rely on `git diff HEAD` alone because it misses untracked task files. Untracked
  `.agenticloop/tasks/*.md` files are a review blocker unless the project explicitly records a
  local-only exception.
- Files projection: review files-backed work against the artifact named in the task file,
  typically `implementation_artifact` plus the current implementation summary. A chat summary or
  an unstated local diff is not enough. If the task file cites a commit or range, inspect that
  local git state; if it cites a patch or diff file, inspect that recorded artifact.
- Files projection: if a revision changed a previously published claim, evidence block, check
  result, or artifact reference in the implementation summary but no dated `## Revision Log` or
  `## Comments` entry records the correction, mark `needs_revision`. Silent rewrite of published
  claims is a review blocker. See `agenticloop/backends/files.md` for the correction rule.
- The diff matches the task scope from [[task-record-contract]].
- Changed files match `Expected Files or Areas`, or deviations are justified.
- The claimed file action matches the actual git state:
  - task said "add" but `git status` shows file was already tracked -- this is an update,
    not an addition, and must be triaged before acceptance,
  - task said "create" but file was deleted or renamed,
  - "only file changed" claim ignores untracked overlay or runtime files that also changed.
  Classify unexplained action mismatches as `needs_revision` unless the implementation
  summary explicitly triages them as accepted scope corrections.
- Every acceptance criterion is demonstrably met.
- Required checks were run on the final state with concise verdict lines or relevant excerpts, per [[verification-evidence]].
- New behavior has RED-to-GREEN or equivalent evidence, per [[tdd-implementation]].
- Bugfixes state the confirmed root cause or explicitly explain why no root cause could be isolated, per [[debugging-before-fixes]].
- No locked process or architecture decision changed without [[change-request-gate]].

The maintainer verifies the engineer's implementation summary and evidence; the maintainer does
not author missing implementation evidence during acceptance. A reviewer-run command may support
the review's `Evidence Checked`, but it does not satisfy missing or incomplete engineer evidence
in the backend's canonical implementation-summary location.

Do not accept if:

- task record status is still `draft`,
- implementation summary or required evidence is missing from the backend's canonical
  current-summary location,
- normal GitHub-backed work has missing or incomplete PR-body implementation summary/evidence,
  even if the reviewer can reproduce checks locally,
- `## Proof Pressure` is present but missing concrete fields or missing final-proof/misfire evidence,
- backend reference is missing or wrong (for example no task file artifact for files-backed work,
  or no GitHub issue or linked PR when `task_backend: github` is set for a normal implementation task),
- a normal GitHub-backed implementation PR lacks a recognized closing keyword for the task issue,
- the review artifact is only an issue comment and no explicit no-PR backend exception exists,
- agent-authored task work was committed directly to the default or integration branch without
  a pre-recorded no-PR exception,
- a claimed "add new file" actually replaced a tracked file without explicit triage,
- "only file changed" is contradicted by untracked files in git status,
- `## Completion Summary Template` or `## Reviewer Checklist` contains placeholder text
  (`TBD`, `to be filled`, `to be filled during review`, or empty body),
- files-backed `.agenticloop/tasks/*.md` is untracked and no explicit local-only exception
  exists,
- a revision corrected a previously published claim, evidence, or artifact reference without a
  dated `## Revision Log` or `## Comments` entry recording the correction,
- `review_status` is stale for the current implementation artifact.

If pass 1 fails, post `needs_revision` without padding the review with optional style feedback.

## Pass 2: quality

Check:

- Documentation changed when commands, configuration, environment variables, or user-visible behavior changed.
- No secrets, generated caches, database dumps, raw crawl outputs, or browser artifacts were committed.
- No scratch or temporary files were written outside the target project's gitignored `.agenticloop/tmp/`
  directory. Temporary files under `.agenticloop/tmp/` were removed unless intentionally retained with a
  reason in the implementation summary.
- No out-of-scope features were added.
- No incidental toolkit, tooling, dependency, or asset-refresh changes were bundled into a
  task that did not require them. An unrelated refresh inside the artifact is an out-of-scope
  deviation even when it looks routine.
- No temporary debug instrumentation remains in changed runtime files.
- Naming, boundaries, error handling, and duplication are appropriate for the task.

Quality findings must be concrete and grounded in files or behavior.

## Re-review handoff (engineer)

Before requesting re-review after a revision, the engineer confirms the durable
artifact matches the current state.

### Neutral rule

Do not hand back for review until all hold:

- Required checks were rerun after the last edit and their fresh output is in the durable
  artifact, not a prior round's output.
- Stale `Known Limitations` from earlier artifact revisions were removed or reclassified against
  the current state.
- Any file outside `Expected Files or Areas` is triaged under `Deviations From Plan`, not left
  for the reviewer to discover.

### GitHub projection

- Run or inspect the pre-review gate `npx agenticloop github-preflight --pr <pr>`
  before acceptance. A failing preflight (missing, incomplete, or stale PR-body
  evidence, a head mismatch, or a missing closing issue reference) is
  `needs_revision`; do not author the missing evidence during review.
- The current PR head commit matches the commit the implementation summary cites
  (`gh pr view <pr> --json headRefOid`). See [[verification-evidence]].
- `Files Changed` in the implementation summary matches the actual PR file list
  (`gh pr view <pr> --json files --jq '.files[].path'`).
- The task issue appears in the pull request's closing issue references
  (`gh pr view <pr> --json closingIssuesReferences`). If it does not, the pull
  request body must be fixed before acceptance.
- Any earlier accepted or needs_revision marker for an older PR head is treated as stale state,
  not proof for the current head.

### Files projection

- Confirm the task file path from `.agenticloop/project.md` `task_file_template` before editing
  or requesting re-review.
- If the current implementation artifact is committed, cite the current local final state with
  `git rev-parse HEAD`.
- If the task file records a base/head range or equivalent local artifact, use
  `git diff --name-only <base>...HEAD` or `git diff --stat <base>...HEAD` against the recorded
  base or range when relevant.
- `Files Changed` in the implementation summary matches the actual local artifact named by the
  task file.
- `implementation_artifact` is set in task-file frontmatter, or is otherwise clearly recorded in
  the task file when the project has an approved exception.
- `review_status` in the task file is not stale for the current implementation artifact.
  `review_status` is mutable current state; a stale value for a newer artifact is a blocker.

A re-review request that fails any item is a revision defect. The maintainer returns
`needs_revision` on the handoff itself and does not re-run full code review until the
handoff is clean.

## Disputed items

Review items are claims, not orders. Before implementing a review item, the engineer verifies it against the codebase.

If a review item is wrong or conflicts with the task record, the engineer lists it under `Disputed Items` in the revision summary with evidence.

The next review must explicitly sustain or withdraw each disputed item. If sustained-and-disputed review rounds exhaust the attempt budget (default 3, or the task record's `attempt_budget`; see Attempt Budget in `agenticloop/AGENTIC_LOOP.md`), use [[blocked-state]] so a human can decide.

Distinct from a single sustained-and-disputed item: once `needs_revision` rounds on one task reach the task record's `review_budget` (default 3) -- regardless of whether the findings repeat -- the orchestrator runs the Review Round Checkpoint in `agenticloop/AGENTIC_LOOP.md` before routing any further revision.

## Mandatory triage before accepting

Before posting `accepted`, triage every `Known Limitation` and `Follow-Up Recommendation` from the implementation summary:

1. Fold it back into the task and request revision.
2. File a follow-up task record.
3. Dismiss it with a short reason.

Acceptance without triage is incomplete.
