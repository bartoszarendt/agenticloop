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
the current artifact revision, and posts exactly one review marker:

```text
AGENT_REVIEW_STATUS: accepted
```

or

```text
AGENT_REVIEW_STATUS: needs_revision
```

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
