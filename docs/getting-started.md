# Getting Started

Agentic Loop is a Markdown-first workflow toolkit. You can use the core loop
without installing a runtime: give your agent the repository rules, the
methodology, and the relevant skills.

The default task backend is files. No GitHub account, repository, or labels are
required for normal operation.

## Quick Start

Run in an existing project directory:

```text
npx agenticloop init
```

This creates:

```text
agenticloop/                   toolkit-owned canonical source
.agenticloop/project.md        project map (starts unconfirmed; backend, naming, grouping, typed docs, optional backend evidence notes)
.agenticloop/decisions/        decision records
.agenticloop/tasks/            task record files (completion summaries live inline)
.agenticloop/tmp/              gitignored scratch directory
```

No adapter config file is created. No GitHub setup is needed.

`agenticloop/` is toolkit-owned source refreshed by `agenticloop update`.
`.agenticloop/` is target-owned state. Host-native output such as `.opencode/`
or `.claude/` is generated shim material.

Path convention: toolkit-owned canonical assets (agents, skills, backends) live
under `agenticloop/` (no dot). Target-owned state (project map, tasks,
summaries, decisions, logs, tmp) lives under `.agenticloop/` (with dot). Never
reference `.agenticloop/agents/`, `.agenticloop/skills/`, or
`.agenticloop/backends/`; those paths do not exist.

Decision records live under `.agenticloop/decisions/`. They are separate from
task records and summaries and are used only for durable project decisions that
constrain future work.

## Guided Setup

For a guided onboarding experience that walks through project detection,
adapter selection, and model configuration:

```text
npx agenticloop setup
```

Setup detects your project state, confirms the project map, lets you choose
a host adapter, configure role models, and generates artifacts in one pass.
It is resumable and safe to rerun.

To check onboarding progress without changing files:

```text
npx agenticloop doctor
```

For host-native adapter setup without the guided flow, run:

```text
npx agenticloop init --adapter opencode
npx agenticloop init --adapter codex
npx agenticloop init --adapter claude-code
npx agenticloop init --adapter copilot
npx agenticloop init --adapter cursor
```

Adapter init additionally creates `agenticloop.json`,
`agenticloop/config.json`, and artifacts for the selected host. Use
`--adapter all` only when you intentionally want every implemented host adapter,
including experimental adapters.

For Claude Code, `init --adapter claude-code` is the repo-local Mode B adapter:
it generates `.claude/commands/agenticloop.md`, `.claude/agents/`, and one public
`.claude/skills/agenticloop/SKILL.md` with internal
`references/skills/<name>/reference.md` procedure copies, plus
`.claude/settings.local.json` by default.
That local settings file is gitignored automatically. If you want one shared
Claude Code install across many target projects, use the separate root plugin
packaging flow in [docs/claude-code-setup.md](claude-code-setup.md).

For Copilot, `init --adapter copilot` is experimental. It generates
`.github/agents/*.agent.md`, one public `.github/skills/agenticloop/SKILL.md`
with internal `references/skills/<name>/reference.md` procedure copies and
backend references, plus `.github/prompts/agenticloop.prompt.md` for Copilot
IDE prompt-file surfaces. In Copilot CLI, activation is explicit with
`/agenticloop`. It does not generate `.github/copilot-instructions.md`.

For Cursor, `init --adapter cursor` is experimental. It generates
`.cursor/agents/*.md` plus one public `.cursor/skills/agenticloop/SKILL.md`
with internal `references/skills/<name>/reference.md` procedure copies and
backend references. Activation is explicit with `/agenticloop`. It does not
generate `.cursor/rules/` by default.

To refresh an existing overlay after upgrading the package:

```text
npx agenticloop update
```

`update` preserves target-owned `.agenticloop/project.md`, task records,
summaries, decisions, logs, and `.agenticloop/tmp/`, leaves existing
`agenticloop.json` alone, and refreshes adapter output that already exists. For OpenCode,
update regenerates the repo-local `.opencode/agents/*.md` files and
`.opencode/commands/agenticloop.md`. User-owned `opencode.jsonc` is ignored.
Use `update
--adapter <host>` to generate or refresh one specific host. To remove the
overlay, preview first and then confirm:

```text
npx agenticloop remove --dry-run
npx agenticloop remove --yes
npx agenticloop remove --yes --include-state
```

## Adoption Modes

Agentic Loop supports two adoption paths.

### New project or template mode

Use this when starting a project from scratch or when the target project does
not yet have its own `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, or architecture
docs.

Run `npx agenticloop init`. The generated `.agenticloop/project.md` starts with
`setup_status: unconfirmed`.

Before the first non-trivial task, either:

- ask the agent to run or route `setup-agenticloop`, or
- manually confirm the defaults by updating the setup fields in `.agenticloop/project.md` after reviewing the backend choice.

Recommended additions that `init` does not create (target-owned):

```text
AGENTS.md
IMPLEMENTATION_PLAN.md
README.md
```

### Existing project or overlay mode

Use this when the target project already has `AGENTS.md`,
`IMPLEMENTATION_PLAN.md`, architecture docs, or other project contract docs.
Agentic Loop adds its process files beside the existing docs without
overwriting them.

Run `npx agenticloop init` in the target project root. Init skips existing
protected docs and adds only Agentic Loop-owned assets.

If source document names are non-standard, or if the repo may already have a
durable GitHub issue/PR workflow, use the setup skill to record confirmed typed
selections and backend review in `.agenticloop/project.md`:

```text
Use the setup-agenticloop skill to map the source documents for this project.
```

If the target project already uses the conventional document names and keeps the
files backend, still confirm the project map only after reviewing whether the
repo already shows durable GitHub workflow evidence.

## Configuration

### Files-first (default)

`.agenticloop/project.md` is the primary project configuration. Edit its
frontmatter to record setup confirmation, typed document selections, task ID
pattern, backend choice, or optional grouping:

```yaml
---
setup_status: unconfirmed
setup_confirmed_at: ""
setup_confirmed_by: ""
task_backend: files
task_id_pattern: "T-<number>"
task_id_regex: "^T-\\d{3,}$"
task_file_template: ".agenticloop/tasks/{taskId}.md"
grouping_profile: flat
# documents:
#   plan: "ROADMAP.md"
---
```

Default task IDs use `T-001`, `T-002`, and similar neutral numbering. Projects
that choose grouping may override this. For example, a phase-grouped project
may set `task_id_pattern: "P<phase>-<number>"` and a matching regex.
Setting `grouping_profile: phase` alone does not switch task IDs.

Document roles are typed: `rules`, `plan`, `overview`, `process`, `spec`,
`design`, `context`, and `history`.

Agents use the typed selections from `.agenticloop/project.md`. When a role is
not selected, they use the bounded candidate names from the canonical registry.
They do not scan the whole repository at runtime.

`setup_status: unconfirmed` means the project map still needs review.
`setup_status: confirmed` means the document selections, task naming, grouping,
and backend choice have been reviewed for this target project.

`backend_confirmed_at`, `backend_confirmed_by`, and `backend_evidence_summary`
are optional frontmatter notes for the bounded backend-evidence review.

To confirm defaults manually, update the setup fields in the same file. Example:

```yaml
---
setup_status: confirmed
setup_confirmed_at: "2026-06-16"
setup_confirmed_by: "maintainer"
task_backend: files
task_id_pattern: "T-<number>"
task_id_regex: "^T-\\d{3,}$"
task_file_template: ".agenticloop/tasks/{taskId}.md"
grouping_profile: flat
---
```

### Advanced adapter config (optional)

`agenticloop.json` is adapter/tooling config for host-native integrations. It
is created only by `agenticloop init --adapter <host>` and is never created by
plain init. `.agenticloop/project.md` `task_backend` selects the active
backend. Keep backend behavior overrides under `backends.github.*` and
`backends.files.*` in `agenticloop.json`; those settings do not select the
backend.

Agentic Loop-owned adapter config uses strict JSON: `agenticloop.json`,
`agenticloop/config.json`, and `agenticloop/skills/agenticloop-tests.json`. Agentic Loop does
not own `opencode.jsonc`.

Do not put model IDs or workflow configuration in `.agenticloop/project.md`;
those belong in `agenticloop.json` under `adapters.<host>.roleSettings`.

Top-level `taskBackend` in `agenticloop.json` is legacy compatibility for
older targets and should be removed when `.agenticloop/project.md` exists.

`agenticloop/config.json` is toolkit-owned structural defaults, created alongside
`agenticloop.json` when using the adapter path.

## First Run

1. Run `npx agenticloop init` to scaffold the toolkit.
2. Run `npx agenticloop setup` for guided onboarding: project detection,
   confirmation, adapter selection, model configuration, and artifact generation.
   Setup requires explicit "yes" confirmation before writing project map values.
3. Run `npx agenticloop doctor` to inspect setup state without changing files.
4. If source document names are non-standard, the setup flow detects and proposes
   overrides; you can also edit `.agenticloop/project.md` directly.
5. If the repo has durable GitHub evidence (remote, workflows, issue templates),
   setup proposes `task_backend: github`. Review before confirming, or record an
   explicit files-backend exception.
6. If using GitHub, set `task_backend: github` in `.agenticloop/project.md` and run `npx agenticloop bootstrap-labels`.
7. Run `npx agenticloop validate` to verify the setup.
8. Start the host agent. For OpenCode, run
   `/agenticloop [task-id or task description]`. For Codex, run
   `$agenticloop [task-id or task description]`; `/skills` can also select
   `Agentic Loop`, but Codex does not use a repo-local `/agenticloop` slash
   command. For Claude Code, run `/agenticloop` in repo-local Mode B or
   `/agenticloop:start` in plugin Mode A. For Copilot CLI, run `/agenticloop`;
   in Copilot IDE prompt-file surfaces, use the generated `agenticloop` prompt
   file. For Cursor, invoke `/agenticloop` in Cursor Agent chat. For other
   hosts, ask it to use Agentic Loop.

Recommended prompt for hosts without command activation:

```text
Use Agentic Loop. Read .agenticloop/project.md for task_backend, task naming,
grouping rules, and typed document selections. If setup_status is unconfirmed,
route setup-agenticloop or confirm the defaults before selecting the first
task. Then identify the next task and create the task record before
implementation.
```

## How Roles Work

Roles live in `agenticloop/agents/`. They define who does what:

- `orchestrator` coordinates the loop
- `maintainer` owns task records, review, acceptance, and closeout
- `engineer` implements one scoped task record at a time

Host adapters bind their native agent, mode, command, or prompt mechanism to
these role files.

## How Skills Work

Each skill is a directory with a `SKILL.md` file. The frontmatter description
tells the agent when the skill applies. The body gives the process and
verification rules.

Do not load every skill into context at once. Load or invoke the skill that
matches the current task:

- task scoping: `task-record-contract`
- implementation: `tdd-implementation`
- failing checks: `debugging-before-fixes`
- evidence: `verification-evidence`
- review: `review-and-accept`
- blocked state: `blocked-state`
- process changes: `change-request-gate`
- closeout: `task-closeout`
- initial project setup: `setup-agenticloop`

Target-project domain skills may also be used when they are visible to the host
and their triggers apply. Agentic Loop skills remain authoritative for task
records, evidence, review, blocked state, and closeout.

## Task Backends

Backend projection docs live in `agenticloop/backends/`. They explain how the same
task-record operations map to local files or GitHub.

The files backend is the supported default for new projects with no durable
GitHub task-workflow evidence. See `agenticloop/backends/files.md`.

Files-backed task records keep durable state in the task file itself. In practice,
that means frontmatter such as `status`, `implementation_artifact`,
`review_status`, and, for change requests, `type: change-request` plus
`approved: true` after human approval.

GitHub issues and pull requests are an optional projection for projects that
explicitly choose `task_backend: github`. See `agenticloop/backends/github.md`.

### Event logging

Event logging is disabled by default. Enable it in `.agenticloop/project.md`
with `event_logging: enabled`. `event_logging_command` can stay blank; agents
test `npx agenticloop --help` once when enabled and use `npx agenticloop` if
that check succeeds.

### Task completion summaries

Per-task completion summaries are always required. They are written into
`.agenticloop/tasks/<TASK-ID>.md` as the `## Scope Completed` or legacy
`## Implementation Summary` section. This applies to all projects regardless of
grouping profile.

There is no separate `.agenticloop/summaries/` directory. The completion summary
is the inline `## Scope Completed` section in each task record. Closeout is a
verify-and-mark gate that confirms those inline summaries are complete and posts
a status marker; it does not write a separate summary file.

## Host Guides

See [docs/host-adapters.md](host-adapters.md) for the host adapter status table
and [docs/workflow-examples.md](workflow-examples.md) for a concrete software
delivery example.

- [OpenCode setup](opencode-setup.md) - supported.
- [Codex setup](codex-setup.md) - experimental.
- [Claude Code setup](claude-code-setup.md) - supported.
- [Copilot setup](copilot-setup.md) - experimental.
- [Cursor setup](cursor-setup.md) - experimental.
