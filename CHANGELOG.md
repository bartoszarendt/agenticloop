# Changelog

## 0.1.0 (Unreleased)

### Added
- Maintainer Review Fixup: a bounded Pass 2 review exception that lets a
  reviewing maintainer correct one fully understood quality finding on the
  artifact under review, refresh final-state evidence, re-review, and accept
  without an engineer revision handoff. Pass 1 must already be clean; the bound is
  one fully understood finding and one coherent edit packet, not a line count. A
  successful fixup stays inside the current review round and does not consume a
  `needs_revision` round; any expanded, uncertain, or failed finding routes back
  to the engineer. It fails closed for independent-review tasks and cannot repair
  summary, evidence, linkage, or acceptance work that was already missing at the
  engineer handoff. Self-accepted fixups use the existing
  `review_mode: single_agent_fallback` (truthful because the maintainer authored
  part of the exact accepted artifact) with disclosure through a durable
  `## Maintainer Review Fixup` review subsection and `Task:`/`Agent: maintainer`
  commit trailers -- no new review mode, marker, frontmatter field, or task-record
  knob. Merge, integration, issue closure, closeout, and cleanup gates are
  unchanged. `skills/review-and-accept/SKILL.md` owns the procedure; the
  methodology, roles, delegation, and backend docs reference or project it.

- `github-ready` composite pre-merge gate: `npx agenticloop github-ready --pr
  <number> [--issue <number>] [--repo <owner/name>] [--json]` runs the evidence
  preflight and the review audit together and returns one merge-readiness
  verdict, so the orchestrator has a single read-only command to run before
  merging a GitHub-backed implementation PR. It reuses the existing functions
  in-process, never mutates GitHub, requires both checks to pass, and fails
  closed when they disagree on the PR head or linked issue. The original
  `github-preflight` and `github-review-audit` commands remain available.
- Independent-review requirement now reads canonical YAML frontmatter
  `independent_review_required: true|false` from the linked GitHub task issue, in
  addition to the compatibility `AGENT_INDEPENDENT_REVIEW_REQUIRED: true` marker.
  Both share the files-backend boolean parser. Conflicting representations, a
  malformed YAML value, or malformed/duplicate markers fail closed. Quoted or
  example markers inside fenced code, blockquotes, or indented code stay ignored.
- Orchestrator model guidance: a provider-neutral note in `docs/host-adapters.md`
  recommends an orchestration model reliable at multi-step instruction following,
  state tracking, tool routing, and stop-condition enforcement, without naming or
  ranking specific models.
- Activation boundary and standalone engineer: `AGENTIC_LOOP.md` now states that
  installing, discovering, or reading the methodology does not activate it — full
  operation requires explicit activation. The canonical `engineer` role is
  restructured into two modes (standalone and Agentic Loop); the main agent may
  invoke the generated engineer as an ordinary bounded subagent with no task ID,
  task record, or Agentic Loop bookkeeping. Generated engineer surfaces for all
  five hosts and the Codex public skill body carry the same boundary.
- Repository-rules activation guidance: `init`/`setup` install one clearly
  marked, manifest-owned, removable guidance block into the resolved
  repository-rules document (`AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, created as
  `AGENTS.md` when absent). New `agenticloop guidance apply|check|remove`
  commands and an `--no-agents-guidance` install flag. Everything outside the
  markers stays target-owned; modified owned blocks and unowned manual blocks are
  preserved, not overwritten or adopted; `update` never enrolls an existing
   installation that has no owned block. The ownership manifest gains schema
   version 4 with a host-neutral `core` owner and a `marker-block` entry kind
   (v3 manifests migrate automatically; existing adapter entries are unchanged).
   Marker-block entries record generated separators so apply/remove restores an
   existing rules document byte-for-byte; forced removal removes only the edited
   marker region and never truncates surrounding target-owned content. Configured
   rules paths are used consistently by lifecycle and guidance commands; path
   drift is reported and never silently creates a duplicate block.

- Regression coverage for review markers posted in PR review bodies (GraphQL `reviews`)
  and for language-tagged Markdown fences.
- Tool-neutral bounded implementation discovery: `AGENTIC_LOOP.md` Context Read Discipline now
  distinguishes the closed normative context set, permitted task-scoped discovery
  (available indexing or language-aware symbol/reference/caller/test lookup within a default bound of one pass and
  at most six previously unnamed paths/symbols), and still-prohibited arbitrary
  repository loading. Excess or contract-changing discovery routes to `needs_context`.
- Artifact-bound review provenance: `review_mode` (`host_subagent`, `explicit_agent_invocation`,
  `single_agent_fallback`, `independent_human`) plus `independent_review_required`
  `reviewed_artifact`, and `human_review_ref` task fields, enforced by
  `agenticloop validate`, `task lint`, and the `task status` acceptance gate.
  GitHub markers bind to the PR head and `github-review-audit` rejects stale or
  malformed provenance. Same-session fallback remains legal unless independent
  review is required.
- `github-review-audit --expect-status <accepted|needs_revision>` separates
  provenance validity from acceptance readiness. Default audit fails for
  `needs_revision` outcomes; use `--expect-status needs_revision` for revision
  audits. Result JSON includes `provenanceValid`, `acceptanceReady`, and
  `expectedStatus` fields.
- Marker author verification: the audit matches the marker author's GitHub
  identity against the authenticated loop account. Trailer-only spoofing fails.
- Strengthened independent-human verification: `independent_human` mode now
  requires an approved GitHub review on the current PR head by a different human
  account. Missing author type fails conservatively.
- Strict issue binding: `github-review-audit` requires the selected issue to be
  one of the PR's closing references. `--issue` cannot point to an unrelated
  issue.
- Quoted/example marker filtering: markers inside fenced code blocks,
  blockquotes, and indented code are ignored during parsing.
- Files provenance reverse consistency: `review_mode`, `reviewed_artifact`, and
  `human_review_ref` cannot be set without `review_status`; `human_review_ref`
  requires `independent_human` mode.
- REST review fetch and normalization for `independent_human` GitHub audits: the audit
  fetches live reviews from `GET /repos/{owner}/{repo}/pulls/{pr}/reviews`, flattens
  paginated pages, and normalizes records into a stable internal shape with URL/ID,
  state, commit binding, and author identity.
- Outcome-sensitive human review state: `independent_human` accepted audits require an
  `APPROVED` current-head review; `needs_revision` audits require a `CHANGES_REQUESTED`
  current-head review.
- Markdown-consistent fence parsing for quoted-marker filtering: closing fences must use
  the same character and be at least as long as the opening fence; four-space-indented
  fences are treated as indented code.
- Canonical `event-logging` skill owning command resolution (including the
  one-time CLI-help fallback), the disabled/non-blocking rules, and event data
  conventions.
- Warn-only validation for unknown `roles.<role>` configuration keys (loading
  stays permissive; may become errors in a future major version).
- Generated adapter payload-size regression protection for every supported adapter
  (`test/adapter-payload-size.test.js`). It measures generated artifacts, not exact
  active model prompt context.
- Contract-ownership regression test (`test/contract-ownership.test.js`) pinning
  single-owner invariants for the event-logging recipe, the delegation status
  template, and the bounded-discovery rule.
- Generated-artifact ownership manifest (`.agenticloop/generated-artifacts.json`).
- Collision-safe adapter generation preflight (`src/adapter-output-plan.js`).
- Task lifecycle transition enforcement (draft cannot jump to accepted/closed).
- Acceptance gate requiring `review_status: accepted`, `implementation_artifact`, `## Scope Completed`, and `## Evidence` before accept/close.
- Markdown link validator (integrated into `agenticloop validate`).
- Manifest recording after each adapter generation.
- Contract tests for supported adapter status.

### Changed
- Startup guidance: the orchestrator confirms `npx agenticloop validate` reports
  no errors before implementation begins; warnings are triaged but only errors
  block startup, and validation is not rerun every task unless config or toolkit
  assets change.
- Closeout guidance: for a GitHub-backed group, the maintainer verifies every
  included PR was accepted (via `github-ready`) before publishing the closeout
  marker; missing acceptance or a current `needs_revision` blocks
  `AGENT_CLOSEOUT_STATUS: complete`. Missing historical events are never
  fabricated.
- The removed `.agenticloop/project.md` legacy fields (`summary_template` and
  peers) now produce an actionable validation error saying the field should be
  removed and that task summaries live inline in the task record.
- Direct callers of `evaluateGitHubReviewAudit` must pass normalized REST human reviews
  through the `humanReviews` parameter; `prData.reviews` is no longer used as human-review
  evidence.
- Event-logging command-resolution boilerplate is deduplicated from roles, skills,
  the methodology, and backends into the canonical `event-logging` skill; they now
  reference it via `[[event-logging]]`.
- The delegation status template now has a single owner (`role-delegation`); the
  verbatim copy was removed from `agents/orchestrator.md`.
- Accepted/closed files-backed tasks now require `review_status: accepted` plus a
  valid `review_mode`; the acceptance gate blocks `single_agent_fallback` when
  `independent_review_required: true`.
- **Breaking:** `draft` tasks must now go through `agent-ready` before `in-progress`.
- Codex marketplace writes now fail closed on malformed JSON instead of silently replacing it.
- Codex legacy skill removal now requires a strong marker or exact generated structure; name-only heuristics removed.
- Claude agent removal now scans all `.claude/agents/*.md` files for the generated marker (supports custom roleBindings filenames).
- Claude settings permissions are now reversibly reconciled during removal.
- `plugins/agenticloop` removal now checks for unknown content before deleting.
- Dry-run removal now reports the same planned file actions as real removal.
- `removeAgenticLoopMarketplaceEntry` preserves malformed marketplace JSON byte-for-byte.
- Independent-human verification now requires an explicit GitHub `User` author type; unknown
  types, missing type, and logins ending in `[bot]` fail conservatively.
- The maintainer attribution trailer is now checked against the same filtered live body
  used for marker parsing, so fenced/quoted/blockquoted trailers cannot satisfy attribution.

### Fixed
- `github-review-audit` now discovers review markers from both PR issue comments and PR review bodies.
- GraphQL PR review bodies are kept separate from normalized REST human-review evidence;
  `evaluateGitHubReviewAudit` accepts a dedicated `humanReviews` input and `prData.reviews`
  is reserved for GraphQL marker sources.
- `gh pr view --json` now requests the `reviews` field so PR review bodies are available
  for marker discovery.
- Language-tagged Markdown fences (` ```text `, ` ```json `, `~~~text`, and similar) are now
  recognized and their contents are filtered from live marker parsing.
- Fence indentation now accepts only zero to three literal ASCII spaces; tabs and
  Unicode whitespace cannot be misclassified as opening or closing delimiters.
- Duplicated "Required downstream tooling..." bullet in `.dev/PLAN.md`.
- Active Phases now lists partial/deferred/approved-only work; Completed only lists finished work.
- `PLAN-PHASE-07.md` no longer calls Claude plugin packaging "experimental".
- `docs/codex-setup.md` smoke protocol is now explicitly optional/advisory.
- Remaining "live delegation tests still pending" moved to Active Phases.

### Removed
- Unused config role fields: `responsibilities`, `canEditImplementationFiles`, `canEditDocs`.
- Broken installed `AGENTIC_LOOP.md` link to `docs/workflow-examples.md`.
