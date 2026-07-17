# Workflow Examples

Agentic Loop is a Markdown-first workflow toolkit. The examples below are
project-agnostic: they show how a target project can run a small software
delivery loop without replacing that project's own contract docs.

## Small Software-Delivery Loop

### 1. Scaffold or refresh the overlay

```text
npx agenticloop init
npx agenticloop update
```

`init` creates `agenticloop/AGENTIC_LOOP.md`, `.agenticloop/project.md`,
`.agenticloop/decisions/`, `.agenticloop/improvements/`, `.agenticloop/tasks/`,
`agenticloop/agents/`, `agenticloop/backends/`, `agenticloop/skills/`, and `.agenticloop/tmp/`. It does not overwrite an
existing `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, or architecture doc. Decision
records under `.agenticloop/decisions/` stay separate from task records and are
used only for durable project decisions. `.agenticloop/improvements/` is created
on first proposal, not by init. To also generate a host adapter
config, add `--adapter opencode` (or `codex`, `claude-code`).
`update` refreshes Agentic Loop-owned assets and regenerates existing adapter
artifacts without replacing target-owned config.

### 2. Validate setup

```text
npx agenticloop validate
```

### 3. Optional: bootstrap GitHub labels

Skip this step when using the default files backend.

```text
npx agenticloop bootstrap-labels --dry-run
npx agenticloop bootstrap-labels --repo owner/repo --task-id T-001
```

If the project uses grouping, add `--group <id>`. Explicit phase-profile
example:

```text
npx agenticloop bootstrap-labels --repo owner/repo --group 1 --task-id P1-01
```

### 4. Generate the OpenCode adapter

```text
npx agenticloop generate opencode
```

### 5. Start the host

```text
opencode
```

### 6. Start Agentic Loop in OpenCode

```text
/agenticloop [task-id or task description]
```

### 7. Task-record creation and delegation check

The orchestrator first reports whether a real host delegation mechanism exists
for maintainer. It then delegates to the maintainer, or records why a bounded
one-step fallback is being used. The maintainer creates the durable task
record:

- For files: create `.agenticloop/tasks/<TASK-ID>.md` and keep durable state such as
  `status`, `implementation_artifact`, and `review_status` in frontmatter.
- For GitHub: create an issue using the task-record template from `[[task-record-contract]]`.

Stop for human approval before implementation.

### 8. Engineer implementation

After approval, the orchestrator delegates to the engineer. The engineer:

1. Confirms scope, out of scope, acceptance criteria, and required checks.
2. Uses `[[tdd-implementation]]` for behavior changes.
3. Uses `[[debugging-before-fixes]]` if a check fails.
4. Runs required checks fresh.
5. Publishes the implementation artifact required by the task record.
6. Publishes the implementation summary with evidence in the backend's canonical location.
7. Emits required gate events when event logging is enabled.

For files-backed work, the implementation artifact and review outcome stay in the task file. For
GitHub-backed work, they project to the linked PR and review markers.

### 9. Maintainer review

The orchestrator routes the implementation artifact to the maintainer. The
maintainer uses `[[review-and-accept]]`, checks for an existing review marker on
the current artifact revision, and posts exactly one review outcome plus its
provenance (`review_mode`):

```text
AGENT_REVIEW_STATUS: accepted
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>
```

or

```text
AGENT_REVIEW_STATUS: needs_revision
AGENT_REVIEW_MODE: host_subagent
AGENT_REVIEW_ARTIFACT: <full-pr-head-sha>
```

The examples above are fenced only for documentation. A live marker must be posted
outside any fenced code block, blockquote, or indented code so the audit discovers
it; markers inside such regions are treated as quoted examples, not live state.

For files-backed work the same values are set in task-file frontmatter
(`review_status` and `review_mode`).

### 10. Closeout

The maintainer runs `[[task-closeout]]`, a verify-and-mark gate. It confirms the
inline `## Scope Completed` summary and evidence in each task record are
complete, then posts an `AGENT_CLOSEOUT_STATUS` marker citing the covered task
ids. In grouped projects this happens at group boundaries; in flat projects it
runs when a human-identified task set finishes. Closeout does not write a
separate summary file.

When useful, include the optional `## Trace` section in the inline task summary
following the shape in `agenticloop/memory/work-unit-summary.md`.

When event logging is enabled and the task is complete, run a strict audit:

```text
npx agenticloop event-logging audit --task T-001
```

## Bounded implementation discovery

The context set an agent starts from is closed: the project map, the task record,
the selected source documents, linked decisions, and the active backend
projection. Agents do not expand that normative set on their own.

They may still discover how code fits together while implementing. Task-scoped
discovery -- available repository indexing or language-aware symbol/reference
and caller/callee lookup, exact identifier or known-path search, focused test
discovery, relevant version-control history, and directly connected schemas,
generated consumers, callers, or tests -- is permitted by default,
bounded to one discovery pass and at most six previously unnamed paths or symbol
bodies. A caller or test found this way can be inspected and, when needed to
satisfy the task, changed with a recorded deviation. Broad repository dumps and
indiscriminate full-file loading remain prohibited. Discovery that exceeds the
bound, crosses into a new domain, or contradicts the task scope routes to
`needs_context`. See Context Read Discipline in `agenticloop/AGENTIC_LOOP.md`.

## Review provenance and independent review

Every recorded review outcome carries a `review_mode` describing how it was
performed:

- `host_subagent` -- a separate host subagent reviewed it;
- `explicit_agent_invocation` -- a separately invoked review agent;
- `single_agent_fallback` -- same-session review by the acting agent;
- `independent_human` -- a durable human review or confirmation.

### Delegation fallback vs review fallback

`single_agent_fallback` names two different things; keep them apart:

- **Delegation fallback** (`delegation_mode: single_agent_fallback` on
  `role.invoked`) means real role delegation was unavailable or a concrete attempt
  failed. It requires a structured `fallback_cause` (`mechanism_absent` or
  `invocation_failed`) and a reason. A new review round is never a fallback cause.
- **Review fallback** (`review_mode: single_agent_fallback`) means the review
  happened in the acting session and is not independent. It is legal for ordinary
  tasks even when the role was delegated for real.

A fallback review mode does not prove a Maintainer Review Fixup. Only the durable
`## Maintainer Review Fixup` subsection plus `Task:`/`Agent: maintainer` commit
attribution identify a fixup. Only a fixup whose resulting artifact is the
current head forces the current review into fallback mode; a superseded
historical fixup still counts toward the one-episode-per-task limit but a later
genuinely delegated re-review of a newer revision may record `host_subagent`
(see the review-and-accept skill). On GitHub that count includes fixup disclosures
from replacement PRs cross-referenced by the same task issue, not only comments
on the PR currently under audit. Ordinary tasks may use same-session review;
independent-review tasks may not be accepted that way. A human who directly
continues an already-active maintainer session records a concise
`continuation_reason` on the review telemetry rather than a failed delegation
attempt, and still cannot accept an independent-review task.

When surfacing the review mode to a human, prefer explicit wording over the bare
word "fallback", for example:

```text
Review execution: same session (review_mode: single_agent_fallback)
```

Keep the machine value for compatibility, but do not present "fallback" without
this context.

Ordinary tasks can be accepted through an honestly recorded
`single_agent_fallback`. Set `independent_review_required: true` on the task
record before implementation for higher-assurance work -- security or
authorization boundaries; secrets, credentials, or permissions; destructive or
irreversible data operations; production or release controls; or public API and
schema migrations. When that flag is set, acceptance cannot rest on same-session
fallback: use `host_subagent`, `explicit_agent_invocation`, or `independent_human`.
`independent_human` must include a recorded reference (`human_review_ref` for the
files backend, where presence is checked procedurally) or a GitHub review/approval
reference resolved by the GitHub audit, not merely a supervising human in the
session. The audit discovers markers from both PR issue comments and PR review
bodies; independent-human evidence is resolved separately through the GitHub REST
reviews endpoint. The audit fetches and normalizes live native reviews; only an
explicit GitHub `User` identity counts as human, the review must be bound to the
current PR head, and the required review state is outcome-sensitive (`APPROVED` for
accepted, `CHANGES_REQUESTED` for needs_revision). Missing or malformed review data
fails conservatively.
