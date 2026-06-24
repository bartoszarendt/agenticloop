# Downstream Adoption

## Purpose

This document describes how Agentic Loop is used as an overlay in an existing
target project. The overlay model lets a target project adopt the Agentic Loop
workflow without replacing its own documentation, implementation plan, or
architecture contracts.

## Overlay Model

Agentic Loop overlays a target project. The target project keeps its
authoritative docs intact. Agentic Loop adds a thin set of process files beside
them.

Ownership model:

- `agenticloop/` is toolkit-owned canonical source refreshed by `agenticloop update`.
- `.agenticloop/` is target-owned workflow state and durable records.
- Host folders such as `.opencode/`, `.codex/`, `.agents/`, `.claude/`, `.github/`, `.cursor/`, and `plugins/agenticloop/` are generated shims.

Path convention: canonical toolkit assets (agents, skills, backends) always
live under `agenticloop/` (no dot). Target-owned state (project map, tasks,
summaries, decisions, logs, tmp) lives under `.agenticloop/` (with dot).
`.agenticloop/agents/`, `.agenticloop/skills/`, and `.agenticloop/backends/`
are invalid paths and should never be referenced.

## Files Agentic Loop Adds

```text
agenticloop/                     toolkit-owned canonical source
.agenticloop/
  project.md                     project map (target-owned)
  decisions/                     decision records
  logs/
    <TASK-ID>.jsonl              optional task-scoped durable event log
  tasks/                         local task record files (completion summaries inline)
  tmp/                           scratch space (gitignored)
```

`agenticloop/AGENTIC_LOOP.md` is the primary portable process file.

`.agenticloop/project.md` is target-owned and is created once by
`agenticloop init`. It starts with `setup_status: unconfirmed` and is never
overwritten by `agenticloop update`. Edit it to record setup confirmation, typed
document selections, backend choice, task naming, and optional grouping. Do
not put model IDs here.

`.agenticloop/decisions/` holds target-owned decision records for durable
project decisions that constrain future work. Keep those records short and
separate from task records, summaries, and raw transcripts.

`agenticloop.json` and `agenticloop/config.json` are adapter/tooling config.
They are created only by `agenticloop init --adapter <host>` and are not part
of plain init. `.agenticloop/project.md` `task_backend` selects the active
backend. `agenticloop.json` keeps adapter settings and backend behavior
settings under `backends.*`; it does not select the active backend.

Agentic Loop-owned adapter config uses strict JSON. Agentic Loop does not own
`opencode.jsonc`.

Event logging is optional. `.agenticloop/project.md` stores the project intent:

- `event_logging: disabled` means agents should not attempt CLI event logging.
- `event_logging: enabled` means task-scoped event logs may be written under
  `.agenticloop/logs/<TASK-ID>.jsonl`.
- `event_logging_command` may override the CLI command.
- When `event_logging_command` is blank or omitted, agents test
  `npx agenticloop --help` once and use `npx agenticloop` only if that check
  succeeds.
- If no working command is available, agents record a truthful process gap in
  the task record, review, or closeout marker note and continue.
- Set an explicit command when a target host needs one, for example
  `event_logging_command: "agenticloop"` or
  `event_logging_command: "node /path/to/agenticloop/bin/agenticloop.js"`.

These local, host-neutral event logs supplement task records and summary work,
but they do not replace the configured task backend and they are not TUI
collectors, transcript importers, or host runtime stores.

If an older target still has top-level `taskBackend` in `agenticloop.json`,
treat it as legacy compatibility and remove it once `.agenticloop/project.md`
exists.

## Documentation and Asset Ownership

### Target-owned docs and config

These files are the target project's durable contracts. Agentic Loop reads
them, references them in prompts, and never replaces them:

```text
AGENTS.md
IMPLEMENTATION_PLAN.md
ARCHITECTURE_PLAN.md or ARCHITECTURE.md
README.md
.agenticloop/project.md
agenticloop.json
```

### Toolkit-owned refreshable assets

These assets are maintained by the Agentic Loop toolkit and can be refreshed in
a target repo with `agenticloop update`:

```text
agenticloop/
```

The canonical tree includes `agenticloop/AGENTIC_LOOP.md`, `agenticloop/agents/`,
`agenticloop/backends/`, `agenticloop/skills/`, `agenticloop/memory/`,
`agenticloop/commands/`, `agenticloop/config.json`, and `agenticloop/manifest.json`.

To remove the overlay from a target project, preview the cleanup first:

```text
npx agenticloop remove --dry-run
npx agenticloop remove --yes
npx agenticloop remove --yes --include-state
```

Default removal deletes toolkit-owned source, generated adapter artifacts, and
Agentic Loop config from the target directory while preserving `.agenticloop/`
records. Use `--include-state` only when you intentionally want to remove the
target-owned state as well.

## First-Run Confirmation

`.agenticloop/project.md` remains the single source of truth for setup state and
project-map selections. Do not add a separate status file.

After `agenticloop init`, confirm the project map in one of two ways:

1. Ask the agent to run or route `setup-agenticloop`. That skill scans only the
   bounded candidate document list once, gathers bounded backend evidence once,
   and records the confirmed result.
2. Manually review `.agenticloop/project.md` and change the setup fields to
   `setup_status: confirmed`, a `YYYY-MM-DD` `setup_confirmed_at` value, and a
   `setup_confirmed_by` value after reviewing the backend choice.

If the target project uses the conventional document names and default files
backend, you can still confirm the defaults manually. Deterministic CLI
discovery is not required. Do not keep `files` silently when the target repo
already has durable GitHub issue, label, or PR workflow evidence; record an
explicit files-backend exception instead.

### Generated host artifacts

These files are produced by `agenticloop generate <host>` from canonical
sources and `agenticloop.json`. They are generated shims, not canonical
source:

```text
.opencode/agents/orchestrator.md
.opencode/agents/maintainer.md
.opencode/agents/engineer.md
.opencode/commands/agenticloop.md
.codex/agents/*.toml
.agents/skills/agenticloop/SKILL.md
.agents/skills/agenticloop/agents/openai.yaml
.agents/skills/agenticloop/references/skills/<name>/reference.md
plugins/agenticloop/.codex-plugin/plugin.json      optional Codex plugin distribution
plugins/agenticloop/skills/agenticloop/SKILL.md
plugins/agenticloop/skills/agenticloop/agents/openai.yaml
plugins/agenticloop/skills/agenticloop/references/skills/<name>/reference.md
.agents/plugins/marketplace.json                   optional Codex plugin marketplace entry
.claude/commands/agenticloop.md
.claude/agents/*.md
.claude/skills/agenticloop/SKILL.md
.claude/skills/agenticloop/references/skills/<name>/reference.md
.claude/settings.local.json
.github/agents/*.agent.md
.github/skills/agenticloop/SKILL.md
.github/skills/agenticloop/references/skills/<name>/reference.md
.github/skills/agenticloop/references/backends/*.md
.github/prompts/agenticloop.prompt.md
.cursor/agents/*.md
.cursor/skills/agenticloop/SKILL.md
.cursor/skills/agenticloop/references/skills/<name>/reference.md
.cursor/skills/agenticloop/references/backends/*.md
```

OpenCode is command-activated in this shape: after generating the adapter, run
`/agenticloop [task-id or task description]` in OpenCode to enter Agentic Loop
mode for that task.

If Codex output is also generated in the same target, OpenCode may also see
`.agents/skills/agenticloop/SKILL.md`. Agentic Loop's supported OpenCode entry
point still remains `/agenticloop`.

Generate only the host a target project actually uses. Plain
`agenticloop update` refreshes existing host output; it does not create new
host artifacts unless you pass `--adapter <host>`. For OpenCode, update
regenerates `.opencode/agents/*.md` and `.opencode/commands/agenticloop.md`.
User-owned `opencode.jsonc` is left alone. `--adapter all` is an explicit request for every
implemented host adapter, including experimental ones.

Codex repo-local activation is skill-first: use `$agenticloop` or select
`Agentic Loop` from `/skills` in Codex after generating the repo-local adapter.
Codex exposes only that one public Agentic Loop skill; the rest of the toolkit's
procedures are packaged as internal `reference.md` files so the skill picker
stays clean.

Claude Code also has a separate Mode A plugin install path at the toolkit root
via `.claude-plugin/`, but that packaging is not generated into target
projects. Repo-local Claude Code adapter output is `.claude/commands/agenticloop.md`,
`.claude/agents/`, `.claude/skills/agenticloop/`, and
`.claude/settings.local.json` by default. Targets may set `scope: "project"`
to write shared `.claude/settings.json` instead.

Copilot repo-local output is experimental. It uses `.github/agents/*.agent.md`,
`.github/skills/agenticloop/`, and `.github/prompts/agenticloop.prompt.md`.
Activation is explicit with `/agenticloop` in Copilot CLI; the prompt file is
only the fallback for Copilot IDE prompt-file surfaces. It does not generate
`.github/copilot-instructions.md`; that file remains user-owned.

Cursor repo-local output is experimental. It uses `.cursor/agents/*.md` and
`.cursor/skills/agenticloop/`. Activation is explicit with `/agenticloop`, and
the adapter does not generate `.cursor/rules/` by default.

Generated skill surfaces stay in explicit Agentic Loop-owned namespaces so they
do not claim the host's entire project skill path. Each host that renders a
skill exposes exactly one public `agenticloop/SKILL.md` plus internal
`reference.md` procedure copies:

```text
.agents/skills/agenticloop/SKILL.md
.agents/skills/agenticloop/references/skills/<name>/reference.md
.claude/skills/agenticloop/SKILL.md
.claude/skills/agenticloop/references/skills/<name>/reference.md
.github/skills/agenticloop/SKILL.md
.github/skills/agenticloop/references/skills/<name>/reference.md
.cursor/skills/agenticloop/SKILL.md
.cursor/skills/agenticloop/references/skills/<name>/reference.md
```

## Convention-First Document Lookup

Agentic Loop uses typed document roles:

- `rules`
- `plan`
- `overview`
- `process`
- `spec`
- `design`
- `context`
- `history`

Agents read the selected roles from `.agenticloop/project.md`. When a role is
not selected, they use the bounded candidate names from the canonical registry
in `agenticloop/config.json`. They do not scan the whole repository at runtime.

Example project-map override:

```yaml
---
setup_status: confirmed
setup_confirmed_at: "2026-06-16"
setup_confirmed_by: "maintainer"
documents:
  plan: "ROADMAP.md"
  design: "docs/architecture.md"
---
```

## Task Record Projection

The target project's implementation plan remains the roadmap source. Do not
rewrite or port the target plan into Agentic Loop format unless a human
explicitly asks.

The maintainer reads the target plan and creates Agentic Loop task records that
reference plan sections. Task records live under `.agenticloop/tasks/<TASK-ID>.md`
by default. Neutral task IDs such as `T-001` are the default. Files-backed task
records keep durable state in the task file itself, including frontmatter such
as `status`, `implementation_artifact`, and `review_status`.

When `task_backend: github` is configured, task records also live as GitHub
issues. See `agenticloop/backends/github.md` for the full projection.

## Project Skills

Target projects may already expose their own host-visible skills. Those project
skills are valid for domain-specific procedures when their triggers apply.
Agentic Loop does not claim ownership of those target skill directories, and it
does not validate them as canonical Agentic Loop skills unless they live under
the configured Agentic Loop-owned `skills.sourceDirectory`.

Maintainer may record relevant visible project skills in the task record under
`## Applicable Project Skills`.

## GitHub Backend First Run (Optional)

The GitHub backend is optional. Skip this section when using the files backend.

If `task_backend: github` is set in `.agenticloop/project.md`, GitHub labels
must exist before task records can be created:

```text
npx agenticloop bootstrap-labels
```

Add `--dry-run` to preview the commands. The command is safe to re-run; existing
labels are reported as ok. Use `--group <id>` only when the project uses grouping:

```text
npx agenticloop bootstrap-labels --group sprint-1 --task-id T-001
```

Explicit phase-profile example:

```text
npx agenticloop bootstrap-labels --group 1 --task-id P1-01
```
