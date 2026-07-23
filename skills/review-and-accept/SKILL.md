---
name: review-and-accept
description: Use when the maintainer reviews an implementation artifact against its task record and decides accepted vs needs_revision, and when the engineer responds to review feedback. Defines GitHub review markers, files-backed `review_status`, ordered three-lens review, evidence rules, disputed-items protocol, and mandatory triage before acceptance.
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

### Fixup eligibility verdict line

Every `needs_revision` outcome includes exactly one concise verdict line stating
why a Maintainer Review Fixup was not applied, and every applied fixup states it:

```text
Maintainer Review Fixup: ineligible — Lens 1 not clean
```

Use a more specific reason when one applies, for example:

```text
Maintainer Review Fixup: ineligible — requires changed tests
Maintainer Review Fixup: ineligible — independent review required
Maintainer Review Fixup: ineligible — outside allowed paths
Maintainer Review Fixup: ineligible — earlier fixup episode already exists
```

When an eligible fixup is applied, record:

```text
Maintainer Review Fixup: applied — <short concrete finding>
```

The verdict line is explanatory and does not replace the durable
`## Maintainer Review Fixup` subsection. It never loosens the eligibility gate:
Lens 1 findings, new or changed tests, and independent-review tasks stay
ineligible, and at most one fixup episode is allowed per task. Older review bodies
that predate this convention are warned, not hard-failed; newly generated review
instructions require the line. A record-only review that completed Lens 2/Lens 3
does not authorize a fixup or acceptance while Lens 1 remains unclean. Structural
Risk Sweep findings are likewise fixup-ineligible while Lens 1 is unclean.

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
`needs_revision`. Three same-turn lenses are still one review turn and never
satisfy `independent_review_required`.

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

When a real maintainer review round begins, emit one `review.started`. After the
durable backend state is recorded as accepted or needs_revision, emit one
`review.result` with the matching outcome. Do not add per-lens event fields or
per-lens model routing.

Keep event summaries short. Do not duplicate the full review body in the event log.

Strict producer validation requires every new `review.result` event to use
top-level `--role maintainer` and its `--data-json` to include:

- `review_round`
- `review_mode` (a valid review mode)

Optional, recommended metadata for `review.started` and `review.result`:

- `artifact_revision`
- `pr_head`
- `continuation_reason` (must be non-empty when present; record it when a human
  directly continues an active maintainer session without a new `role.invoked`)
- `maintainer_fixup: true` (boolean; only on a maintainer `review.result` with
  `review_mode: single_agent_fallback` when a Maintainer Review Fixup was applied)

Example review start event:

```text
npx agenticloop event-logging review.started --task T-001 --role maintainer --summary "Started maintainer review" --ref "github:pr:42" --data-json '{"review_round":2,"review_mode":"host_subagent","artifact_revision":"abc123","pr_head":"abc123"}'
```

Example review result event:

```text
npx agenticloop event-logging review.result --task T-001 --role maintainer --summary "Accepted implementation" --outcome accepted --ref "github:pr:42" --data-json '{"review_round":2,"review_mode":"host_subagent","artifact_revision":"abc123","pr_head":"abc123"}'
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

## Review depth and Lens 1: Task Compliance

A **full review** runs Lens 1, Lens 2, and Lens 3 in order in one maintainer
turn and one combined durable review body. A **revision review** runs Lens 1 plus
a bounded Structural Risk Sweep only when Lens 1 requires an implementation
change and a full quality/coherence review would target a moving artifact. These
are review depths, not new review modes: preserve one `review.started`, one
`review.result`, and the existing review provenance for every maintainer review.

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
- Every timed-out `## Verification Attempts` entry has final maintainer triage;
  a missing triage or `Classification: pending` is a Lens 1 blocker for
  `accepted` or `closed` work.
- New behavior has RED-to-GREEN or equivalent evidence, per [[tdd-implementation]].
- Bugfixes state the confirmed root cause or explicitly explain why no root cause could be isolated, per [[debugging-before-fixes]].
- No locked process or architecture decision changed without [[change-request-gate]].

The maintainer verifies the engineer's implementation summary and evidence; the maintainer does
not author missing implementation evidence during acceptance. A reviewer-run command may support
the review's `Evidence Checked`, but it does not satisfy missing or incomplete engineer evidence
in the backend's canonical implementation-summary location. The one narrow exception is a
`## Maintainer Review Fixup` (below): after the maintainer applies its own eligible fixup it may
refresh the final-state evidence for the artifact it just changed. That exception never lets a
reviewer repair evidence that was already missing or incomplete at the engineer handoff -- a
finding of missing summary, evidence, linkage, or acceptance work is not fixup-eligible and stays
`needs_revision`.

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
- an exceptional verification episode does not end in a pass or final
  non-blocker maintainer triage,
- `review_status` is stale for the current implementation artifact.

When Lens 1 finds a problem, enumerate every concrete Lens 1 finding before
classifying the requested revision in plain Markdown. Do not add a task field or
event field solely for this classification.

### Decision flow after Lens 1

1. Complete Lens 1 and list all concrete findings.
2. Classify the requested revision as `implementation-changing` or `record-only`.
3. Issue one consolidated `needs_revision` packet containing every Lens 1 finding
   and every applicable later finding. Lens 1 remains unclean and blocks
   acceptance in both branches.

Use `implementation-changing` when satisfying the packet requires source, test,
dependency, generated contract artifact, implementation configuration, or any
other reviewed implementation-artifact change. Do not issue clean or complete
Lens 2 or Lens 3 verdicts. Run the Structural Risk Sweep when the diff is
available and reviewable; add every concrete finding to `Required Revisions` with
normal severity. State under both Lens 2 and Lens 3 that full assessment is
deferred because implementation revision is pending. If the artifact cannot be
meaningfully inspected, state why the sweep could not run. The later changed
artifact requires a fresh full review before acceptance.

Use `record-only` only when all of these hold:

- the task contract is valid and sufficiently concrete;
- the exact implementation artifact and diff are available and technically
  reviewable;
- the correction changes only backend records such as a PR body, issue comment,
  task metadata, evidence presentation, review linkage, or bookkeeping;
- no source, test, dependency, generated artifact, or implementation
  configuration change is requested;
- missing evidence does not prevent meaningful engineering assessment.

For `record-only`, keep the overall verdict `needs_revision`, but run full Lens
2 and Lens 3 in the same review and bind both conclusions to the exact
implementation artifact. Combine Lens 1 corrections and any Lens 2/Lens 3
findings in one revision packet. Do not accept until Lens 1 is corrected and all
ordinary acceptance gates pass.

### Structural Risk Sweep

The sweep is bounded early detection, not a partial Lens 2 or Lens 3 verdict. It
looks only for concrete, artifact-grounded hazards that become costly after a
revision:

- unnecessary dependencies, files, abstractions, frameworks, or extension points;
- duplicate mechanisms or second sources of truth;
- tests that validate a helper, mock, or parallel path rather than the public or
  production path;
- out-of-scope work, secrets, database dumps, generated caches, raw outputs,
  scratch files, or debug instrumentation;
- patch-in-every-caller workarounds where an authorized root correction is
  smaller and safer;
- obvious stage-inappropriate structural churn.

Do not add speculative style advice or theoretical alternatives without material
benefit. A clean sweep does not imply Lens 2 or Lens 3 is clean. Do not label a
concrete sweep finding non-blocking solely because it came from the sweep. Add it
to `Required Revisions` with normal severity. Sweep findings are never eligible
for a Maintainer Review Fixup while Lens 1 remains unclean.

### Artifact-bound re-review

For the same exact implementation artifact, revalidate Lens 1. A previously
completed full Lens 2/Lens 3 assessment may be reused only when the new durable
review body cites the prior review reference, explicitly says the artifact is
unchanged, and contains or clearly incorporates the final Lens 2/Lens 3
conclusions. A GitHub PR-body or issue-comment correction may use this path only
when it leaves the PR head SHA unchanged.

For a new implementation artifact, previous Lens 2/Lens 3 conclusions are stale
for acceptance. Run a fresh ordered full review against the new exact artifact.
Reviewers may focus investigation on the delta, but the verdict covers the whole
artifact. Files-backed work keeps its exact `implementation_artifact ==
reviewed_artifact` validation: when a task-record edit changes recorded artifact
identity, do not reuse prior assessment unless the existing backend rules already
prove exact identity. Do not add a content-hash or equivalence mechanism.

Acceptance always requires final Lens 1, Lens 2, and Lens 3 conclusions for the
exact accepted artifact. A same-artifact accepting review may incorporate cited
prior full conclusions; a changed artifact must receive fresh full conclusions.

### Review body examples

Implementation-changing `needs_revision`:

```md
## Review Status
Verdict: needs_revision
Revision classification: implementation-changing

## Lens 1: Task Compliance
- `app.openapi()` still serves the framework default instead of the required
  deterministic schema implemented by this task.

## Structural Risk Sweep
- `src/adapter.js` adds an unused framework wrapper outside task scope.

## Lens 2: Engineering Quality
Deferred -- full assessment deferred because implementation revision is pending.

## Lens 3: Necessity and Coherence
Deferred -- full assessment deferred because implementation revision is pending.

## Required Revisions
1. Wire the deterministic schema through the public `app.openapi()` path and
   refresh final-state evidence for the resulting artifact.
2. Remove or justify the out-of-scope wrapper.

Maintainer Review Fixup: ineligible -- Lens 1 not clean
AGENT_REVIEW_STATUS: needs_revision
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>

[[agent: maintainer]]
```

Record-only `needs_revision` with full Lens 2/Lens 3:

```md
## Review Status
Verdict: needs_revision
Revision classification: record-only

## Lens 1: Task Compliance
- PR body omits the required `Current PR head` marker.

## Lens 2: Engineering Quality
Verdict: clean for artifact `<full-pr-head-sha>`.

## Lens 3: Necessity and Coherence
Verdict: clean for artifact `<full-pr-head-sha>`.

## Required Revisions
1. Restore the current-head marker and complete current PR-body evidence.

Maintainer Review Fixup: ineligible -- Lens 1 not clean
AGENT_REVIEW_STATUS: needs_revision
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>

[[agent: maintainer]]
```

Acceptance after a record-only correction on an unchanged artifact:

```md
## Review Status
Verdict: accepted

## Lens 1: Task Compliance
Current PR-body evidence is complete for `<full-pr-head-sha>`.

## Lens 2: Engineering Quality
Reused from review `<review-reference>`: clean. Artifact is unchanged:
`<full-pr-head-sha>`.

## Lens 3: Necessity and Coherence
Reused from review `<review-reference>`: clean. Artifact is unchanged:
`<full-pr-head-sha>`.

AGENT_REVIEW_STATUS: accepted
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>

[[agent: maintainer]]
```

Acceptance after a changed artifact:

```md
## Review Status
Verdict: accepted

## Lens 1: Task Compliance
Freshly reviewed for `<new-full-pr-head-sha>`.

## Lens 2: Engineering Quality
Fresh full assessment for `<new-full-pr-head-sha>`: clean.

## Lens 3: Necessity and Coherence
Fresh full assessment for `<new-full-pr-head-sha>`: clean.

AGENT_REVIEW_STATUS: accepted
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <new-full-pr-head-sha>

[[agent: maintainer]]
```

## Lens 2: Engineering Quality

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

## Lens 3: Necessity and Coherence

In a full review, after Lens 2 has run, assess the implementation, not a
replacement task contract:

- Is every new abstraction, dependency, file, framework, extension point, and
  compatibility layer required by accepted current scope?
- Could existing project capability, the platform, standard library, or an
  installed dependency satisfy the need?
- Does the change fix the root cause instead of patching symptoms in callers?
- Did a parallel mechanism appear because changing the shared core looked risky?
- Is the amount of core change appropriate for the confirmed `development_stage`?
- Are deliberate limitations and concrete upgrade triggers clear where needed?
- Does simplification preserve correctness, clarity, validation, error handling,
  security, accessibility, and required evidence?

Block only concrete, artifact-grounded problems: unused or speculative
abstractions, unnecessary dependencies, hypothetical scaffolding, task-introduced
dead code, duplicate mechanisms, a patch-in-every-caller workaround when a
bounded authorized root fix is smaller and safer, compatibility layers with no
real compatibility contract, stage-inappropriate architectural churn, or
stage-inappropriate refusal to correct core code. State the file, behavior, or
demonstrable cost.

Do not block style preference, a theoretically shorter alternative without
material benefit, removal of an accepted requirement, broad redesign outside the
task, unrelated historical cleanup, or speculative future optimization. Route an
observation that changes accepted scope, an accepted decision, or a public
contract through [[change-request-gate]], a follow-up, or a new task. Lens 3 does
not relitigate the accepted task contract.

Ponytail remains opt-in through explicit human request or task `minimalism`.
Lens 3 works when minimalism is omitted or `none`; when Ponytail is active, it
also verifies the selected intensity and required `ponytail:` limitation markers.
Development stage does not activate or map to Ponytail.

## Maintainer Review Fixup

A Maintainer Review Fixup is one bounded edit packet the maintainer applies during an active
implementation review to correct a single fully understood Lens 2 or Lens 3 finding, refresh final-state
evidence, re-review the resulting artifact, and accept it without an engineer revision handoff.
This skill solely owns the procedure. It is not general implementation authority; other docs only
reference or project it, and maintainers otherwise do not edit implementation files.

### Eligibility gate

A fixup may begin only when every condition holds. When any is uncertain, fail closed and route
the finding to the engineer through the normal revision path.

1. Lens 1 task compliance is already clean: the task record is valid; scope and acceptance
    criteria are satisfied; the implementation artifact and backend linkage are valid; the
    canonical implementation summary exists; and required implementation evidence exists and is
    current for the pre-fix artifact. A finding that the summary, evidence, linkage, or acceptance
    work is missing is not fixup-eligible and stays `needs_revision`. This excludes every
    Structural Risk Sweep finding while Lens 1 is unclean, even when a record-only review has
    completed Lens 2 and Lens 3.
2. `independent_review_required` is not `true`.
3. The task does not belong to a category that should have required independent review: security
   or authorization boundaries; secrets, credentials, or permissions; destructive or irreversible
   data operations; production or release controls; public API or schema migrations; or any
   project policy requiring independent review. A fixup must never compensate for a missing
   `independent_review_required: true` classification.
4. Before editing, the maintainer can state the concrete finding, the exact intended correction,
   the expected files or areas, and the verification that will prove the correction.
5. The correction stays within existing task scope; stays within `Expected Files or Areas` or the
   structured `allowed_paths`; adds no new file; adds or changes no dependency; changes no public
   API, schema, migration, security boundary, permission model, release control, or destructive
   behavior; changes no task contract, acceptance criteria, or locked decision; introduces no
   behavior beyond the already accepted task outcome; and is not a disputed review item.
6. Existing required checks adequately cover the correction. If a new or changed test is required,
   the finding is not eligible and goes to the engineer. Test deletion is never an eligible fixup.
7. The maintainer has exclusive ownership of the current branch, worktree, task record, and
   backend objects. The branch/worktree is clean apart from known task state, and for GitHub the
   branch is not the default or integration branch.
8. At most one fixup episode is allowed per task. Inspect the review history for an earlier fixup
   before using the path; if one exists, route the finding to the engineer.

There is no mechanical line-count or file-count threshold. A small diff is only a heuristic
because semantic risk matters more than size. The normative bound is one fully understood finding
and one coherent edit packet.

### Procedure

1. Complete Lens 1 successfully.
2. During Lens 2 or Lens 3, identify one concrete eligible finding. Lens 2 and
   Lens 3 share this one fixup episode; neither receives a second budget.
3. Evaluate and record the eligibility decision before editing.
4. Record the pre-fix artifact: the current PR head SHA for GitHub, or the current
   `implementation_artifact` for files.
5. Start one durable `## Maintainer Review Fixup` record with the finding, rationale, base
   artifact, correction, affected files, and planned verification. Follow the backend projection
   for its mutable surface: update the same GitHub PR comment, or append result fields without
   rewriting the files-backed plan.
6. Apply the correction to the existing implementation artifact -- the current task branch and
   pull request for GitHub, or the current local branch/commit/range/patch for files. Never commit
   to a default or integration branch, and never create a no-PR or no-review exception through this
   feature.
7. Attribute maintainer-authored commits with the existing trailers:

   ```text
   Task: <TASK-ID>
   Agent: maintainer
   ```

8. Treat any earlier review outcome as stale once the artifact changes: replace or clear the
   mutable current review state, preserve append-only prior review history, and bind the final
   outcome only to the resulting artifact.
9. Rerun the focused verification and every required final-state check. When event logging is
   enabled, emit `check.run` with role `maintainer` per [[verification-evidence]].
10. Refresh the canonical implementation summary and evidence for the new artifact. This narrow
    exception lets the maintainer publish fresh evidence it produced after its own fixup; it is not
    permission to fabricate or reconstruct missing engineer evidence, and missing evidence as the
    original finding is not fixup-eligible. For GitHub, update the PR body's `Current PR head` and
    required-check evidence so the GitHub gates can validate the new head. For
    files, follow the correction-entry rule before refreshing any previously published summary,
    evidence claim, check result, or artifact reference.
11. For GitHub, run `npx agenticloop github-preflight --pr <number>` only after publishing
    final-head PR evidence. Failure follows the handoff path below.
12. Complete a fresh Lens 1, Lens 2, and Lens 3 against the post-fix artifact.
13. If accepted, append the resulting artifact, files, check verdicts, and outcome to the durable
    record; record `review_status: accepted`, the exact `reviewed_artifact`, and
    `review_mode: single_agent_fallback`. For GitHub, add the accepted markers to the same comment.
14. `single_agent_fallback` is required because the maintainer authored part of the exact final
    artifact it accepted, even when the orchestrator originally invoked that maintainer through a
    real `host_subagent`.
15. Keep role invocation and review provenance distinct: a `role.invoked` event may record
    delegation mode `host_subagent` when true, while the final review outcome uses
    `single_agent_fallback` after a self-authored fixup.
16. For GitHub, run `github-review-audit` or `github-ready` after the accepted markers are durable.
    `github-ready` remains post-acceptance and pre-merge.
17. When event logging is enabled, use existing event types and optional free-form `data` such as
    `{"maintainer_fixup": true, "base_artifact": "<before>", "fixup_artifact": "<after>"}`. Do not
    add a new top-level event type or event schema.

### Durable disclosure shape

Record the fixup under the existing heading with these standardized fields so the
disclosure parses deterministically. Keep it live Markdown (not fenced) in the
review body or files-backed task record:

```text
## Maintainer Review Fixup

- Finding:
- Eligibility decision:
- Base artifact:
- Correction:
- Affected files:
- Planned verification:
- Verification result:
- Resulting artifact:
```

All eight fields are mandatory and must be non-empty; `Planned verification` and
`Verification result` are both required, and a duplicated field label is
rejected rather than silently merged. Base artifact and resulting artifact must
differ, and for GitHub each must normalize (bare SHA or a `commit:`/`sha:`
prefix) to a full 40-character commit SHA. At most one such subsection may exist
per task, counting both current and superseded episodes.

For GitHub, the one-episode count is task-wide across replacement pull requests:
when the current PR contains a fixup candidate, the review audit reads the linked
task issue's same-repository PR cross-reference history and includes fixup
subsections from those PRs. If that history cannot be loaded, the audit fails
closed rather than silently treating the current PR as the task's whole history.

A fixup episode is *current* when its resulting artifact equals the exact
current artifact: the current PR head for GitHub, or the final
`reviewed_artifact`/`implementation_artifact` for files. A current episode binds
the current review: the accepted marker must review that same resulting artifact
with `single_agent_fallback`, and the commits in the base-to-resulting fixup
range must carry the `Task:`/`Agent: maintainer` trailers -- an unrelated commit
elsewhere in the PR does not satisfy attribution, and missing or malformed
GitHub commit data fails closed. A *historical* episode -- one whose resulting
artifact was superseded by a later engineer revision -- still counts toward the
one-episode limit but does not force the current review mode; a later genuinely
delegated re-review of the new head may record `host_subagent`.

Files-backed fixup records additionally require a non-empty final `## Evidence`
section that references the resulting artifact. `## Scope Completed` alone is
not evidence; the enforced guarantee is the recorded evidence/artifact
association, since a static record cannot prove when evidence was produced.
Files-backed validation and the GitHub review audit detect this subsection
(ignoring examples inside fenced or otherwise non-live Markdown) and enforce
these invariants. When event logging is enabled, `agenticloop validate` also
cross-checks the durable subsection against `maintainer_fixup: true` review
events and reports mismatches or multiple-episode anomalies as warnings. A
corresponding event must carry the same task id, role `maintainer`, and
`review_mode: single_agent_fallback`; a malformed historical flag is reported but
does not satisfy the durable evidence cross-check.

### Provenance

A self-accepted fixup uses the existing `review_mode: single_agent_fallback`. Do not add a new
review mode, a fixup marker, a fixup frontmatter field, or a task-record fixup-permission knob.
The existing provenance system already permits `single_agent_fallback` for ordinary tasks, rejects
it when `independent_review_required: true`, requires `reviewed_artifact` to equal the current
implementation artifact, and (for GitHub) requires the marker to reference the exact current PR
head. Disclosure is carried by the durable `## Maintainer Review Fixup` subsection and the commit
attribution, not by new machine fields.

### Round counting

A successful fixup is part of the current review round. Emit or record one `review.started` for
the review, apply and disclose the fixup, and emit or record the final `review.result: accepted`.
Do not count a successful fixup as a `needs_revision` round, and do not emit an engineer
`role.invoked` event, because no engineer was invoked.

### Failure and handoff

Stop the fixup and route to the engineer through the normal revision path if its scope expands;
root-cause or implementation uncertainty appears; an unexpected file or subsystem becomes
involved; a required check fails for a reason not already explained by the planned correction;
another substantive implementation edit would be needed; or a second fixup episode appears
necessary. On failure, do not silently erase or rewrite history: record the truthful current
artifact and evidence, post or record `needs_revision`, and hand the task to the engineer.

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

A re-review request that fails any item is a Lens 1 revision defect. The
maintainer returns `needs_revision` on the handoff itself. Classify it under the
Lens 1 decision flow: when it is record-only and the exact implementation
artifact remains available and meaningfully reviewable, complete full Lens 2/Lens
3 in that same review; otherwise use the implementation-changing revision review
and its Structural Risk Sweep. Do not accept until the handoff is clean.

## Disputed items

Review items are claims, not orders. Before implementing a review item, the engineer verifies it against the codebase.

If a review item is wrong or conflicts with the task record, the engineer lists it under `Disputed Items` in the revision summary with evidence.

The next review must explicitly sustain or withdraw each disputed item. If sustained-and-disputed review rounds exhaust the attempt budget (default 3, or the task record's `attempt_budget`; see Attempt Budget in `agenticloop/AGENTIC_LOOP.md`), use [[blocked-state]] so a human can decide.

Distinct from a single sustained-and-disputed item: once `needs_revision` rounds on one task reach the task record's `review_budget` (default 3) -- regardless of whether the findings repeat -- the orchestrator runs the Review Round Checkpoint in `agenticloop/AGENTIC_LOOP.md` before routing any further revision.

## Mandatory triage before accepting

Before posting `accepted`, ensure every exceptional verification episode in the
append-only history under [[verification-evidence]] ends in a pass or final
non-blocker maintainer triage. The maintainer may classify triage as `one_off`,
`project_fact`, `decision`, `follow_up`, or `blocker`, but may not leave it
missing or `pending`, and `blocker` cannot close the episode. A `project_fact` may update the
current profile; a `decision` is only a policy-level promotion of an existing
fact through [[decision-capture]].

Also triage every `Known Limitation` and `Follow-Up Recommendation` from the
implementation summary:

1. Fold it back into the task and request revision.
2. File a follow-up task record.
3. Dismiss it with a short reason.

Acceptance without triage is incomplete.
