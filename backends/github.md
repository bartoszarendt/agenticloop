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

## Shared transition contract

GitHub projects the complete backend-neutral `agenticloop.transition-contract`
defined in `agenticloop/AGENTIC_LOOP.md`. Its executable definition is internal
to the installed Agentic Loop npm package and is not copied into the target. The
issue body carries durable task lifecycle
status and verified immutable task-contract comments carry contract readiness.
Labels are authoritative only for label presence; comments and review bodies are
authoritative only for their typed records. Neither a label nor free-form comment
can substitute for a current blocked-return receipt, exact-head review-entry
receipt, audit record, or closeout marker.

Apply the shared freshness, terminal ordering, Markdown preservation, and
audit-budget rules before adding GitHub publication or reconciliation mechanics.

## Dispatch and return

GitHub is a transport projection of the shared single-role dispatch packet and
return contract. It may supply issue/PR facts through an injected or live
transport, but it does not define an alternate readiness, packet, task, or
attribution source of truth. A return remains raw role-produced wire data and is
rejected/routed to its producer when packet, task, head, paths, checks, trailers,
or refetched PR facts do not match current projected evidence. Injected transport
fixtures must invoke their transport and prove the same shared semantic verdict as
files; no live GitHub call is required for that proof.

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
| Evidence | PR body for normal implementation evidence; comments and PR review bodies for status markers, later evidence updates, and documented exceptions |
| Verification profile | Current `## Verification Operating Facts` in `.agenticloop/project.md` |
| Verification attempts | Optional marked, append-only task-issue history for an exceptional check episode; at most one carrier per check id when one exists |
| Review status | Review comment or PR review body marker |
| Blocked state | Issue label plus status marker comment |
| Completion summary | Inline in the PR body (per task) |
| Closeout | Status marker comment or PR review body citing the covered task ids |

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

Newly authored issues must materialize the effective `attempt_budget`: an
explicit task value wins, otherwise use project `default_attempt_budget`, then
built-in `5`. GitHub preflight rejects duplicate or invalid attempt-budget
frontmatter. Existing issue values remain authoritative; an older issue with no
field resolves policy without being rewritten.

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

The issue-body frontmatter may also include `context_overflow_risk: medium|high`
and optional `context_note` when one engineer execution needs tighter
active-context discipline.

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

Add `AGENT_CONTEXT_REASON: context_overflow` when context pressure caused the
pause. State what is missing and who can answer.

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

### Record Verification Attempts

Verification attempt history belongs on the **task issue**, not in the PR body
or an unmarked comment, but it is exceptional execution history rather than a
per-check mirror of PR-body evidence. Do not create a marked comment for a
routine first-pass success; record that result in the current PR-body evidence
and, when enabled, the `check.run` event. Create a carrier when a check fails,
times out, is blocked, needs a retry, escalation, strategy change, maintainer
triage, or a later resolution of an already recorded episode.

For an exceptional check id, create exactly one agent-authored, editable comment
with exactly one marker and exactly one matching check section:

```text
<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->

## Verification Attempts

### RC-1
```

Append the canonical attempt, foreground-prediction, and maintainer-triage
subsections from [[verification-evidence]] to that same marked comment. Do not
post a second marked comment for the same check id, put multiple markers in one
comment, or change, delete, or reorder an earlier entry. Before appending, fetch
the existing marked comment for that `RC-N`; ambiguous posting requires fetching
comments before retrying. The comment is an editable carrier for append-only
history, so the updater appends and retains prior text rather than replacing the
history. Keep every attempt bound to the PR head on which it actually ran; an old
resolved carrier is not rewritten to the latest head and does not need a duplicate
routine final-head pass when the PR body has complete current-head evidence. Keep
the final [[github-attribution]] role trailer.

The maintainer may update the separate current `VF-...` profile in
`.agenticloop/project.md` only after final triage. The profile does not replace
the issue-comment attempt history or approve a strategy by itself.

### Pre-Review Evidence Gate

Before requesting maintainer review on a GitHub-backed implementation pull
request, run the mechanical pre-review gate from the target repository root:

```text
npx agenticloop github-preflight --pr <number>
```

Options:

- `--issue <number>` when the linked task issue cannot be inferred from the
  pull request's closing issue references.
- `--repo <owner/name>` to target a specific repository.
- `--json` for machine-readable output.

The gate uses `gh` and fails clearly when `gh` is missing, unauthenticated, or
returns incomplete data. It fetches the pull request (`number`, `body`,
`headRefOid`, `files`, `closingIssuesReferences`, `statusCheckRollup`) and the
linked issue (`number`, `body`, `title`) plus all issue-comment pages, then
checks that:

- the issue has a non-empty `## Required Checks` section;
- the pull request body has a non-empty `## Evidence` section;
- the pull request body carries a `Current PR head: <sha>` marker that matches
  the current `headRefOid` (a stale or missing marker fails);
- every required check has acceptable PR-body evidence, or an unambiguous
  successful status check that matches it;
- any existing paginated marked attempts are live, authenticated, attributed,
  valid, within retry limits, and locally referenced; no attempt comment is
  required for a routine first-pass success;
  `github-ready` also requires final timeout triage.

This gate does not change `agenticloop validate`. Normal validation performs
GitHub label checks only when the active backend is `github`; files-backed
validation makes no GitHub CLI or network calls. The preflight is a separate,
opt-in GitHub-backed command that fetches pull request and issue data.

Expected PR `## Evidence` shape:

```md
## Evidence
Current PR head: <headRefOid>

- Required check: [RC-1] `npm test`
  Verdict: passed
  Evidence: 128 passing, 0 failing (exit 0)
- Required check: [RC-2] `npm run lint`
  Verdict: passed
  Evidence: no errors reported
```

Prefer the exact required-check text from the issue's `## Required Checks` so
each entry maps to a required check. For an ID-less typed check, the evidence
label may omit recognized kind/source/observation annotations while retaining
the same semantic text and exact command identity. Two ID-less checks that
reduce to the same semantic text are invalid until the Maintainer assigns
distinct `RC-N` ids. `Verdict` is one of `passed`, `failed`, `blocked`, or `not
run`; `not run` is not final-state evidence. For command checks, give a
command/verdict/output excerpt or rely on a matching successful status check.
For manual checks, give a verdict and a concise evidence note; a successful CI
status check never satisfies a manual check.

Only checks written as a backtick command (for example `` `npm test` ``) are
eligible for status-check substitution. A check written as prose is treated as
a manual check and always requires explicit PR-body evidence.
When a command check declares observations, those observations require
structured PR-body records and disable status-check substitution. Required-check
contracts are validated before either satisfaction path: invalid kinds or
sources, command proofs without an exact backticked command, status-check
satisfaction on non-command proofs, and observations with no structured
PR-body observation source are Maintainer-owned task-policy failures.

An empty `statusCheckRollup` means there is no CI substitute. Empty status
checks are not evidence and never satisfy a missing check. A status check
supports a required command only when it is attached to the current head,
completed successfully (conclusion `SUCCESS`; `NEUTRAL`, `SKIPPED`, and
in-progress runs do not count), and its name matches the required command
exactly after normalization. A status check named `test` does not satisfy a
required command `` `npm test -- focused-case` ``. When the match is not exact
or more than one status check matches, supply explicit PR-body evidence instead.

Because any push to the pull request branch changes `headRefOid`, it
invalidates prior PR-body evidence. Rerun the required checks against the new
head and update the `## Evidence` section (including the `Current PR head`
marker) before requesting review again.

Current PR-body evidence must match the final head even when an old resolved
exceptional attempt carrier names an earlier head. That carrier remains valid
history if it is structurally valid, attributed, internally consistent, and has
final timeout triage where required. A missing final-head entry in such history
is not itself a Lens 1 blocker.

When current PR-body evidence reports `failed` or `blocked`, the required check
must have a stable `RC-N` id and the task issue must contain its matching marked
exceptional-history carrier. Preflight rejects the exceptional verdict when that
carrier is absent. For terminal work, the latest attempt in each carrier must
pass or have final non-blocker maintainer triage; an active failed, blocked, or
timed-out attempt and blocker triage prevent readiness.

#### Exact-head preflight additions

The preflight gate also validates:

- **Exact head**: `Current PR head` must be a full 40-character SHA equal to
  `headRefOid`. Short prefixes, stale full hashes, and missing markers fail.
- **Scope/deviations**: When the linked task has structured `allowed_paths` (or
  `expected_files`), every PR file is matched against the patterns. Each
  non-matching file must appear as an exact repo-relative path in `## Deviations`
  with a non-empty reason.
- **Summary shape**: The PR body must contain all six canonical headings:
  `## Scope Completed`, `## Artifacts`, `## Evidence`, `## Deviations`,
  `## Known Gaps`, and `## Follow-Ups`. The first three are substantive; the
  latter three may explicitly say `None`.
- **Attribution**: When cooperative attribution can be mechanically established
  (body role trailer + commit trailers), the `Task:` and `Agent:` trailers must
  agree with the linked task and body role. The expected task value is the
  issue frontmatter `task_id` when non-empty, otherwise `#<issue-number>` for a
  legacy issue. Use one final `[[agent: engineer]]`, `[[agent: maintainer]]`,
  or `[[agent: orchestrator]]`
  body trailer and the matching `Task: <resolved task id>` / `Agent: <role>`
  commit pair. Human-authored commits are not rejected merely because attribution
  cannot be established.
- **Checkpoint enforcement**: When there are `needs_revision` review outcomes at
  or beyond the budget boundary, a current, non-stale checkpoint must be present
  in the PR comments.
- **Resolution matrix**: When prior `needs_revision` outcomes have recorded
  finding IDs, the PR body must contain a `## Revision Resolution` section with
  exactly one bullet entry per finding.

Structured failure categories: `head_identity`, `summary_shape`,
`scope_deviations`, `attribution`, `evidence`, `checks`, `review_checkpoint`,
`revision_resolution`, `review_provenance`, `other`.
JSON output retains the compatible string `errors` and `warnings` arrays and
also provides `diagnostics` / `warningDiagnostics` entries. Repairable
resolution diagnostics include `expectedShape`, `expectedValues`, and
`requiredFindingIds`.

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

Managed-batch lane PRs are the explicit narrow exception: they remain lane
evidence artifacts and link their own issue with a non-closing reference such as
`Refs #<issue-number>`. The dedicated join task has its own issue, branch, and
PR. Its PR carries the integrated evidence and closing references for the join
issue and every lane issue. Run preflight/readiness with the join issue supplied
explicitly when multiple closing references exist. After the join PR lands, each
lane task records the exact `integrated_by: pr:<number>@<full-40-sha>` join
artifact; close any
still-open lane PR with that truthful disposition. Do not hide reconciliation in
an arbitrary lane PR or rely on GitHub indirect-merge behavior.
The field lives in the canonical lane issue frontmatter. Cleanup resolves the
issue by its exact `task_id`; a local files-backend mirror is never authoritative.

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

Concurrency safety is governed by mutation, not by role. Load
[[parallel-delegation]] for the Parallel Opportunity Scan, lane definitions, plan
fields, liveness, join behavior, and the full backend-specific parallel write
rules.

GitHub-backend deltas:

- Each parallel implementation lane requires its own repo-internal worktree,
  task branch, GitHub issue, pull request, lease, join condition, and merge
  barrier. Its structured exclusive `owned_paths` must be disjoint from other
  lanes unless a complete Maintainer-classified managed-join plan authorizes
  every exact shared operation. One pull request per implementation task, as
  before.
- Parallel coordination/review lanes may mutate GitHub backend state only when
  each lane owns distinct backend objects, such as distinct issues or distinct
  PR review targets. Shared issues, PRs, labels, comments, status markers,
  closeout state, event logs, or group state require serial work.
- Cross-lane findings are routed through lane status returns and recorded in
  the concurrency plan or coordination output; the join condition stays
  incomplete while any routed finding lacks a recipient disposition or any
  deferred finding lacks recorded non-blocking limitation/follow-up triage.
- Do not merge any pull request from a parallel batch into the default or
  integration branch until every lane has returned, maintainer review is
  complete for every implementation artifact, cross-branch conflict and ordering
  risk has been checked, and the human approves the merge order.
- When the concurrency plan requires combined-state proof, an integration
  rehearsal composes a disposable non-published candidate (for example a
  temporary local integration branch or throwaway worktree) and records
  integrated evidence bound to that exact candidate. The rehearsal never
  pushes, publishes, opens or merges a pull request, and never updates the
  protected default or integration branch. When the actual merged composition
  differs from the rehearsed candidate, the rehearsal evidence is stale and the
  required checks rerun against the merged tree.
- Missing pushed branch, missing PR, or missing expected backend update at join
  time is a failed or blocked lane, not a pending lane.
- A managed join uses a dedicated join issue, branch, and PR rather than mutating
  a lane PR. The join PR owns exact final-head integrated evidence and fresh
  review. Lane PRs use non-closing task references; the join PR closes its own
  and every lane issue after human-authorized landing. Worktree cleanup may remove
  a closed lane PR worktree only when its recorded exact `integrated_by` join
  artifact is validated as landed, independent of merge strategy or ancestry.

### Record Review Status

Post exactly one valid review marker in a maintainer review comment or a PR review
body, and record the review provenance alongside it:

<!-- agenticloop:canonical-review-marker accepted -->
```text
AGENT_REVIEW_STATUS: accepted
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0

[[agent: maintainer]]
```

<!-- agenticloop:canonical-review-marker needs_revision -->
```text
AGENT_REVIEW_STATUS: needs_revision
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
AGENT_REVIEW_FINDINGS: F-1, F-2

[[agent: maintainer]]
```

`AGENT_REVIEW_ARTIFACT` is the full current PR head SHA. A review may declare
`AGENT_REVIEW_CLASSIFICATION: implementation_changing` or `record_only`;
absence defaults to `implementation_changing`. Only consecutive valid
implementation-changing `needs_revision` outcomes sustaining the same active
finding IDs trigger the no-progress guard; record-only corrections, stale
reviews, accepted outcomes, withdrawn or retired findings, and new-only finding
sets never do. A legacy `needs_revision` review whose findings field is missing
(accepted only for an old artifact) establishes no IDs; the first typed outcome
after it allocates IDs from `F-1`. The audit discovers loop
markers from both PR issue comments and PR review bodies. The linked task issue
expresses the independent-review requirement through canonical YAML frontmatter
`independent_review_required: true`; the explicit `AGENT_INDEPENDENT_REVIEW_REQUIRED: true`
marker in the issue body remains a supported compatibility form. Use one form,
set it before implementation, and treat later changes as a visible task-contract
change. The audit reads either representation; conflicting representations (or a
malformed value or duplicate markers) fail closed. For `independent_human`, add
`AGENT_HUMAN_REVIEW_REF: <GitHub-review-url-or-id>`; the audit resolves it against
live native GitHub reviews from the GitHub REST API (`/repos/{owner}/{repo}/pulls/{pr}/reviews`).
GraphQL PR review bodies are used only as marker sources; normalized REST reviews
are used only as independent-human evidence. The REST response is normalized into
an internal shape with stable review URL/ID, state, commit binding, and author
identity. Only an explicit GitHub `User` author type counts as a human; a login
ending in `[bot]` is treated as a bot indicator regardless of the declared type.
Missing identity, state, URL/ID, or commit binding fails conservatively. Quoted
or example markers and attribution trailers inside fenced code blocks,
blockquotes, or indented code are ignored during marker parsing.

Run `npx agenticloop github-review-audit --pr <number> [--repo <owner/name>]`
before final acceptance or merge. The default audit expects an accepted outcome
on the current head; use `--expect-status needs_revision` to audit a revision
request. Use `--expect-artifact <full-40-character-sha>` to verify that the
current PR head matches the originally dispatched artifact; this prevents a
review dispatched at artifact A from being accepted when the PR head has moved
to artifact B. When a local review workspace is supplied, add
`--workspace <path>` with `--expect-artifact`; the audit fails unless that
workspace's `git rev-parse HEAD` is the same exact SHA. The audit verifies:

- loop markers are discovered from both PR issue comments and PR review bodies;
- marker authorship matches the authenticated loop GitHub account;
- the maintainer attribution trailer is present on the same filtered live body as the markers;
- the issue is one of the PR's closing references;
- independent-human evidence is resolved separately from marker discovery through the REST reviews endpoint;
- independent-human reviews are current-head reviews by a different explicit `User`;
- accepted independent-human outcomes require an `APPROVED` review state;
- `needs_revision` independent-human outcomes require a `CHANGES_REQUESTED` review state.

See [[review-and-accept]] for shared semantics.

When a Lens 1 correction is record-only and leaves this SHA exactly unchanged,
the maintainer may reuse a prior full Lens 2/Lens 3 assessment by citing the
prior review reference and stating that the artifact is unchanged in the new
durable review body. The accepting review must contain or clearly incorporate
those final conclusions. A new PR head invalidates prior Lens 2/Lens 3
conclusions for acceptance and requires a fresh full review. Existing
`github-review-audit` markers and `github-ready` behavior remain unchanged.

#### Maintainer Review Fixup (GitHub projection)

[[review-and-accept]] owns the eligibility gate and full procedure. GitHub-specific
projection:

- Apply the fixup on the existing task branch and pull request; never commit to the
  default or integration branch and never invoke a no-PR or no-review exception.
- Before editing, create one attributed, editable PR comment as the durable fixup record and retain
  its URL or id. Record the base PR head there, then update that same comment with the resulting PR
  head, final evidence verdicts, accepted markers, and maintainer attribution; do not post a second
  fixup record.
- Attribute maintainer-authored commits with the `Task: <TASK-ID>` and
  `Agent: maintainer` trailers.
- Pushing the fixup changes `headRefOid` and invalidates prior head-bound evidence.
  Rerun the required checks and update the PR body's `Current PR head` and
  `## Evidence` for the new head.
- After refreshing the PR body, run `npx agenticloop github-preflight --pr <number>` against the
  final head, then complete the fresh three-lens review round.
- Post the accepted review markers against the final head in the durable fixup comment with
  `AGENT_REVIEW_MODE: single_agent_fallback`. Do not add any new fixup marker.
- Only after the accepted markers are durable, run the final-head review audit or composite gate:
  `npx agenticloop github-review-audit --pr <number>` or
  `npx agenticloop github-ready --pr <number>`. `github-ready` remains a post-acceptance,
  pre-merge gate.
- The GitHub issue still closes through the merged pull request, or through the
  existing documented correction path if closure linkage failed. A fixup does not
  itself authorize merge; the human merge checkpoint is unchanged.

For status comments that are meant to be mutable, prefer editing the latest
agent-authored marker comment instead of adding another equivalent marker. For
pull request reviews, fetch existing reviews and the current head revision
before posting. If the latest valid agent-authored marker already records the
same outcome for the same pull request head, do not submit another review.
If a review submission command returns ambiguous output, fetch reviews before
retrying; retry only when no valid marker with the intended outcome was
accepted.

### Pre-Merge Readiness Gate

Before merging a normal GitHub-backed implementation pull request, run the
read-only composite gate from the target repository root:

```text
npx agenticloop github-ready --pr <number>
```

It runs the evidence preflight and the review audit together and returns one
merge-readiness verdict, so the orchestrator does not have to remember and
sequence `github-preflight` and `github-review-audit` separately. It accepts the
same `--issue`, `--repo`, and `--json` options. It is strictly read-only: it
never merges, comments, edits issues, or otherwise mutates GitHub. It requires
both component checks to pass and to agree on the PR head and linked issue, and
it fails closed when they disagree.

Do not merge unless `github-ready` exits successfully. Automatic within-group
merge authorization only removes a human prompt; it never removes the evidence,
review, or acceptance requirements. A current `needs_revision` result, a missing
review, a stale review artifact, or a failed independent-review requirement
always blocks merge. The original `github-preflight` (pre-review) and
`github-review-audit` (provenance) commands remain available for their narrower
purposes.

### Review Round Checkpoint

When `needs_revision` rounds reach the task's `review_budget` (default 5 unless
materialized from project policy otherwise), the
orchestrator must record a durable checkpoint before routing the next revision.
For GitHub, append the checkpoint to the PR conversation with Orchestrator
attribution:

<!-- agenticloop:canonical-checkpoint github -->
```text
<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->

## Review Round Checkpoint

- Direction: targeted_revision
- Cause: implementation_defect
- Review count: 5
- Artifact: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
- Target: F-2: refresh the current-head verification evidence
- Orchestrator: orchestrator-bot

[[agent: orchestrator]]
```

The checkpoint schema requires:
- `direction`: one of `targeted_revision`, `needs_context`, or `blocked`
- `cause`: one of `implementation_defect`, `evidence_drift`,
  `task_contract_ambiguity`, `scope_pollution`, `reviewer_engineer_disagreement`,
  or `external_blocker`
- `review_count`: the current number of durable `needs_revision` outcomes
- `artifact`: a full 40-character commit SHA matching the latest reviewed artifact
- `target`: required when direction is `targeted_revision`
- `reference`: required when direction is `needs_context` or `blocked`
- `orchestrator`: required and must match the authenticated comment author

`github-preflight` separately paginates PR conversation comments and review
bodies, while linked issue comments remain verification-attempt history. It
validates that an over-budget changed artifact has a current, non-stale
checkpoint authorization bound to the immediately preceding reviewed artifact.
Missing, stale, malformed, untrusted, or replayed checkpoints fail preflight.
The checkpoint does not reset the review budget; it authorizes exactly one
targeted A-to-B next step.

`github-preflight` also validates the revision resolution matrix when there are
prior `needs_revision` outcomes with recorded finding IDs. Every prior finding
must have exactly one bullet entry in the `## Revision Resolution` section with a
disposition of `resolved`, `disputed`, or `blocked` and current evidence.

### Close Or Accept Task

Accept only after scope, quality, evidence, and follow-up triage pass review of
the linked pull request. Before acceptance or merge, verify that the pull
request body resolves to the expected closing issue reference, for example with
`gh pr view <pr> --json closingIssuesReferences`. If the task issue is absent
from that field, update the pull request body or request revision before
accepting.

For every timed-out attempt in a marked verification-attempt comment, final
maintainer triage must be present and not `pending`. Missing or pending timeout
triage blocks acceptance and closure. No active retry, pending timeout triage,
or unresolved blocker may be hidden in attempt history. The absence of a
final-head entry from an older resolved carrier is not a blocker when canonical
current-head PR-body evidence is complete.

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
intervention, predicted medium/high context overflow risk, context pressure
encountered, or follow-ups), the maintainer must post it as a durable issue
comment before or during closeout.

### Run Closeout

Closeout is a verify-and-mark gate; it does not publish a separate summary
artifact. When a human-identified task set or configured group finishes, confirm
each task's inline PR-body summary and evidence are complete, then post the
closeout status marker through `closeout prepare` then `closeout record` as a
comment on the resolved covered-task issue carrier, citing the covered task ids:

```text
AGENT_CLOSEOUT_STATUS: complete
AGENT_CLOSEOUT_STATUS: follow_up_required
```

An exceptional verification episode that does not end in a pass or final
non-blocker maintainer triage blocks `AGENT_CLOSEOUT_STATUS: complete`.

The adapter inventories open and closed issues with configured task identity
rules, requires one trusted authenticated Agentic Loop account for marker
publication, and treats only that account's current non-fenced marker as
idempotent. It retains historical comments and posts a superseding correction
instead of editing history away. Immediately before the one remote mutation it
re-fetches task inventory, carrier comments, and marker resolution. GitHub cannot
make that cross-resource recheck atomic; a residual remote TOCTOU window remains
visible in command output.

Task identity is globally unique across open and closed issues: duplicate or
contradictory carriers fail validation, `github-ready`, audit, and closeout
with every conflicting issue number, and an incomplete inventory is an explicit
`inventory_incomplete` state, never a partial pass. Terminal closeout also
proves the pull-request lifecycle for every covered task: one review-accepted,
merged PR that carries the closing relationship to the correct issue and lands
the certified candidate merge artifact. A merely closed issue without that
relationship cannot complete, and a merged PR closing the wrong issue cannot
complete. Each command fetches one issue-inventory snapshot and reuses it for
every evaluator; only the intentional final pre-mutation refresh reads again.

Before the final audit freeze, route conditional selected-plan progress
synchronization to the single-writer Maintainer closeout lane under
[[task-closeout]]. Include its evidence in the issue or PR closeout comment. A
plan edit changes the candidate, so final-head evidence, the audit baseline, and
certification must be refreshed before the complete marker is posted.

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
every required check on the final state, and include a `Current PR head: <sha>`
marker tied to the current `headRefOid` so the evidence is verifiably fresh. The
agent must still read the full command output before claiming success. Run
`npx agenticloop github-preflight --pr <number>` to confirm this section maps to
the issue's `## Required Checks` before requesting review. Use event-log `refs` and small `data`
for structured facts; do not create a separate parseable receipt block. Output
refs remain a deferred future policy; do not create or rely on them now.

When `.agenticloop/project.md` has `event_logging: enabled`, the local
`.agenticloop/logs/<TASK-ID>.jsonl` event log may help confirm workflow gates
alongside the issue and pull request artifacts. The GitHub issue and PR remain
the authoritative durable records.

Use GitHub-specific values inside the canonical template. Keep the summary
concise. Cite command output, issue/PR numbers, and task ids. Do not copy raw
agent exchanges.

## Task-Record Body Transaction And Recovery

Maintainer owns GitHub task-record body edits. Orchestrator may inspect a failed
gate read-only, but must not repair task frontmatter, scope, readiness, or
baseline fields inline. Use the guarded command family:

```text
npx agenticloop task-body fetch --issue <n> --output .agenticloop/tmp/issue-<n>.md
npx agenticloop task-body lint --issue <n> --body-file .agenticloop/tmp/issue-<n>.md
npx agenticloop task-body apply --issue <n> --body-file .agenticloop/tmp/issue-<n>.md --expect-digest <digest> --dry-run
npx agenticloop task-body apply --issue <n> --body-file .agenticloop/tmp/issue-<n>.md --expect-digest <digest> --yes
```

Use `set-field` for one field, `transition --status agent-ready` with `--base`
or `--base-paths` for readiness, and full-body `apply` only for recovery or a
reviewed compound edit. `fetch` preserves a BOM exactly and emits a separately
labelled sanitized candidate. `lint` validates the contract record chain.
`apply` checks the digest before and after publication. Recovery names include a
digest, timestamp, and operation id; success retains and reports them by default.
Rollback needs a fresh exact-candidate lease and never overwrites concurrent
state. Results carry a unified diff and changed-field/section summary.

### Trusted task-contract records

REST/GraphQL comments share one immutable carrier model. Every carrier is
classified into exactly one authority state before any record is promoted:

- `trusted_immutable`: trusted repository association (OWNER, MEMBER, or
  COLLABORATOR), allowlist accepted, required metadata complete, unedited.
  Only these carriers promote records.
- `trusted_but_invalid`: the carrier is eligible, but its record payload is
  malformed or violates the record contract. This is fatal for validation.
- `edited_authority`: an otherwise trusted authority whose comment was edited.
  The carrier is rejected but not fatal; a chain whose only baseline carrier
  is edited fails naturally as missing/invalid.
- `untrusted_association`: the author is not OWNER, MEMBER, or COLLABORATOR.
  Non-authoritative noise: recorded as a structured rejected-carrier
  diagnostic, never a chain failure, and a duplicate record ID on such a
  carrier cannot invalidate a trusted record.
- `not_allowlisted`: trusted association, but the configured
  `trusted_task_contract_actors` allowlist excludes the author. Also
  non-authoritative noise.
- `incomplete_carrier`: the backend response lacks metadata needed to decide
  authority (including a missing stable comment id or URL). Fails safely as
  an adapter/provenance error.

A trusted GitHub carrier requires a stable comment id and URL. Login
comparison is case-insensitive while the canonical display casing is
preserved. Two independent guards reject edited carriers: the normalizer
marks them non-authoritative, and the record validator rejects any record
whose carrier reports `edited: true`, even alongside self-asserted
`verifiedAuthority: true`. Embedded/self-attested carrier data inside a
record payload is always ignored; trust comes only from the independently
fetched carrier. Author must match `--actor` and the authenticated publisher;
allowlists narrow collaborator trust. Duplicate, fork, orphan, cycle, and
replay checks run on promoted trusted records only. Refetch requires one
valid carrier, unchanged body, and digest chain. Schema 2 requires a
baseline. Mutable RECORD markers are forbidden.

The body cannot authorize its baseline. Before a new task or `agent-ready`
transition, `establish-baseline` posts and refetches a separate verified-author
`agenticloop.task-contract-record` comment with carrier id, actor, authority,
timestamp, task id, digest, and artifact. `authorize-correction` records prior/
resulting digest, old/new fields, reason, authority, actor, artifact, timestamp,
and carrier id before body apply. Markers only cache record references. Historical
baseline-less records warn until a material edit or readiness transition; never
invent authority from an in-body role claim.

Trusted actors are configured once in `.agenticloop/project.md` as
`trusted_task_contract_actors`: a non-empty list of GitHub logins, validated
for empty entries, case-insensitive duplicates, and malformed login shapes.
The deprecated `github_trusted_actors` alias is honored everywhere with a
deprecation warning. Without an allowlist, OWNER, MEMBER, and COLLABORATOR
associations remain trusted and every resolver invocation emits an explicit
compatibility warning.

Offline lint (`task-body lint --offline [--trusted-records <snapshot>]`)
validates payload syntax and graph consistency only. Snapshot records are
asserted inputs, not verified live carriers: the result envelope reports
`contextMode: "offline"`, `lintValid`, `graphConsistent`,
`provenanceVerified: false`, and `publicationReady: false`, and its exit
status reflects lint validity only. Offline lint never satisfies an
authority-dependent readiness or publication gate, even when snapshot data
fabricates `verifiedAuthority: true`.

Recovery from an edited or invalid authority carrier: preserve the rejected
carrier; never edit a comment to repair a record. Publish a new versioned
record (baseline or correction) through `task-body` on a fresh immutable
carrier, refetch, and validate the completed chain. An edited sole baseline
carrier leaves the chain without a baseline until a replacement baseline
record is published.

After a post-write structural regression, stop all automated writes. Preserve
the invalid live body, pre-write body, candidate, digests, and exact failed
validation. Do not reconstruct a record from memory, terminal excerpts, or
partial prose. Route recovery to Maintainer, recover from a known-good source or
GitHub edit history, lint offline, compare against both the invalid live body and
the dispatched baseline, publish through `task-body`, refetch, validate, and
record the repair/correction visibly. Then rerun downstream scaffold, lint,
attribution, preflight, and review preparation against the resulting artifact.
If a published write makes task identity, frontmatter, or required sections
disappear, this circuit breaker remains in effect until Maintainer completes that
recovery; do not issue another automated body write.

## Already-Pushed Metadata Repair

Metadata-only repair of an already-pushed task branch is an exceptional
Engineer-owned repair. The attribution CLI remains read-only. A malformed trailer
is a deterministic repair failure: the owning Engineer may repair it only when
all conditions below pass; otherwise it is blocked pending the missing authority
or safety condition. `Agent:` identifies content ownership, never the mechanical
repair operator.

1. Confirm the current role is Engineer or an explicitly authorized repair operator.
2. Confirm the task branch is exclusively owned.
3. Confirm the worktree is clean.
4. Confirm the exact local branch and remote ref.
5. Fetch and record the expected old remote SHA.
6. Reject default, integration, protected, shared, and active-review-lease branches.
7. Build the corrected complete message in a file.
8. Run `commit-attribution check --message-file <path>`.
9. Amend explicitly with `git commit --amend -F <path>`.
10. Run the HEAD-based attribution check.
11. Push only with `git push --force-with-lease=<ref>:<expected-old-sha> <remote> <branch>:<ref>`.
12. Refetch and verify the resulting remote SHA.
13. Invalidate and rerun artifact-bound checks, snapshots, preflight, and review preparation.
14. Record the metadata rewrite durably.

The durable attribution-repair record must include original SHA, resulting SHA,
branch/ref, content-owner role, repair operator, reason, authority, timestamp,
invalidated evidence, and rerun evidence. Never use unrestricted force push or
an automatic amend command.

## Review Preparation And Recovery

Before a first or repaired PR-body write, render `pr-body scaffold --pr <n>
--output <body.md>` after the final implementation push and required checks
(optionally with `--snapshot-output <context.snapshot.json>`), replace every
`REPLACE` placeholder in the Markdown draft, and lint the local body with
`pr-body lint --pr <n> --body-file <body.md>` (live read-only context) or
`pr-body lint --snapshot <context.snapshot.json> --body-file <body.md>`
(offline, zero network access). The Engineer edits Markdown only; the CLI owns
the versioned `agenticloop.pr-body-context` snapshot with materialized
task/decision inventories, so preparation-input JSON is never hand-authored
(the legacy `pr-body lint --input <evaluation-input.json>` path is deprecated
but unchanged). Publication is an explicit user-controlled body write, followed
by live `github-preflight`; `github-review-prepare` runs only after that and
evaluates published live state, never an unpublished local draft. A push after
scaffolding invalidates the packet: rerun the required checks and
re-scaffold/revalidate against the new head. A resolved matrix entry binds the
current head with its structured `[ref: commit:<full-sha>]`; `sha:<full-sha>` and
a bare full SHA are accepted on input, while a legacy prose-only exact current
SHA receives a migration diagnostic. The current matrix contains exactly the
latest valid `needs_revision` finding IDs; prior outcomes stay append-only
review history. Sustained IDs are retained, omitted/withdrawn IDs retire
permanently, and new IDs allocate monotonically without CLI semantic inference.

Typed required checks keep proof kind (`command`, `manual`, `contract_proof`)
separate from satisfaction source (`pr_body`, `status_check`,
`manual_observation`, `automated_observation`); the evidence entry's kind comes
from its own shape, and manual/contract-proof checks require the canonical
structured per-observation records owned by the verification-evidence skill.
Stable IDs never replace an exact declared command identity, and any declared
observation records remain mandatory even when an exact status check succeeds.

Never delete a trusted malformed checkpoint. The same authenticated Orchestrator
may post one bounded `AGENTIC_LOOP_REVIEW_CHECKPOINT_REPAIR` carrier naming the
exact source, original author, mechanically derivable corrected fields, and
reason. It cannot alter direction, cause, target, artifact, count, outcome, or
authority, and it is excluded from checkpoint selection and outcome counts.
Use `github-checkpoint repair-plan` to render it; it never posts the carrier.

Two consecutive valid implementation-changing reviews sustaining the same
stable finding require a distinct `AGENTIC_LOOP_NO_PROGRESS` no-progress
disposition (`targeted_revision`, `split_task`, `contract_decision`, or
`blocked`) bound to the exact sustained finding IDs plus the required
target/reference. It is not a checkpoint and does not change
`checkpoint_direction`; an over-budget targeted revision still also needs the
ordinary single-use checkpoint.

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
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
AGENT_REVIEW_FINDINGS: F-1

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

## Activation boundary

Activation capture is a host boundary, not an issue-body claim. A supported v2
capture must be signed for the exact intended task ID, canonical target
repository, capture ID, and expiry before task authoring. Repository input,
issue prose, labels, comments, and model-authored JSON cannot supply or upgrade
that authority. All shipped adapters currently declare capture `unsupported`,
so no shipped configuration provides a live supported dispatch path.
