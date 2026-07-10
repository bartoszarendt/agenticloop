# Agentic Loop

> A Markdown-first workflow toolkit that gives AI coding agents a repeatable engineering loop instead of a loose chat session.

AI coding agents are useful, but they are unreliable at sustained software work. They drift scope, skip verification, repeat failing approaches, and lose context between sessions. The problem is not that the models are not smart enough. The problem is that they lack process: a clear task contract, role boundaries, verification rules, and durable project memory.

Agentic Loop adds that layer. It installs as a lightweight overlay in an existing project -- your `README.md`, `AGENTS.md`, implementation plan, and architecture docs stay untouched. It gives agents the scaffolding they need to stay in scope, produce evidence, and respect review gates.

![Version: 0.1.0](https://img.shields.io/badge/version-0.1.0-blue)
![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- Enable after the first public npm publish:
[![npm version](https://img.shields.io/npm/v/agenticloop.svg)](https://www.npmjs.com/package/agenticloop)
-->

## Why this exists

After watching AI coding agents work on real projects, a few failure patterns keep showing up:

- **Scope drift**: the agent expands the task or bundles unrelated changes because nothing tells it where the boundary is.
- **Evidence-free completion**: the agent claims work is done without running fresh checks against the final state.
- **Unbounded retries**: the agent repeats the same failing approach because there is no rule that says stop and escalate.
- **Role confusion**: the same agent plans, implements, and reviews its own work -- which is the equivalent of grading your own exam.
- **Lost context**: useful decisions disappear when the chat session ends because nothing durable was written down.
- **Host lock-in**: workflow instructions get written in one agent host's format and are useless in another.

These are process failures. The models are capable enough. What is missing is a portable engineering loop that gives agents clear task records, role boundaries, verification rules, and durable project memory -- and that works across hosts without duplicating everything.

## Who this is for

This toolkit makes sense if you already use AI coding agents for real software work and you want more reliable outcomes. Specifically:

- You use OpenCode, Claude Code, Codex, Copilot, or Cursor for non-trivial development tasks.
- You want the agent to stay in scope, produce evidence, and stop at review gates instead of silently finishing work and moving on.
- You are comfortable with Markdown and a small CLI overlay in your project.
- You want to route expensive model reasoning to the places where it actually changes the outcome -- review, acceptance, quality gates -- and use cheaper models for coordination.

It probably does not make sense if you only use agents for one-shot questions or throwaway scripts, if you want a fully autonomous pipeline with no human in the loop, or if you are looking for a hosted SaaS platform rather than project-local tooling.

## What it gives your agent

| Capability | What it does |
|---|---|
| **Task records** | Define scope, out-of-scope boundaries, acceptance criteria, required checks, expected files, implementation notes, and review state. |
| **Role boundaries** | Split work across orchestrator, maintainer, and engineer roles so the same agent does not silently plan, implement, and accept its own work. |
| **Cost-quality routing** | Configure different model and reasoning settings per role, so cheap coordinator work does not consume the same model budget as high-judgment review. |
| **Canonical skills** | Provide focused procedures for task creation, TDD, debugging, verification evidence, review, blocked states, decision capture, attribution, and closeout. |
| **Files-first backend** | Store task records as local Markdown files under `.agenticloop/tasks/` by default. No GitHub setup required. |
| **GitHub backend** | Optionally project task records to GitHub issues and implementation artifacts to pull requests. |
| **Decision records** | Preserve durable project decisions under `.agenticloop/decisions/` so future agent sessions do not rediscover or contradict them. |
| **Optional event logs** | Record compact JSONL workflow-gate events for local audit and summary generation without storing raw transcripts. |
| **Worktree lifecycle** | Create guarded repo-internal `git worktree` lanes, inspect guard state, list/remove/prune worktrees, and run safe bulk cleanup after acceptance. |
| **Host adapters** | Generate host-native shims for OpenCode, Claude Code, Codex, GitHub Copilot, and Cursor from one canonical Markdown source. |

## The core loop

```text
Request
  ↓
Task record
  - scope
  - out of scope
  - acceptance criteria
  - required checks
  - expected files or areas
  ↓
Implementation
  - smallest useful slice
  - TDD when applicable
  ↓
Verification
  - required checks
  - fresh evidence from final state
  ↓
Review
  - pass 1: task compliance
  - pass 2: code and documentation quality
  ↓
Revision or acceptance
  ↓
Closeout (verify-and-mark gate)
  - per-task completion summary always required, inline in the task record
  - closeout confirms the inline summaries are complete and posts a status
    marker; it does not write a separate summary file
```

Every meaningful state change should produce a durable artifact. Nothing important should live only in chat.

Agentic Loop builds on **prompt chaining** -- splitting a task into a sequence of prompts where one step's output feeds the next -- and hardens it for software delivery. Each step hands off a durable, reviewable artifact (a task record, verification evidence, a review result) instead of loose chat text, and the work moves through role boundaries and stop conditions rather than a straight line.

## Quick start

### Requirements

- Node.js `>=20`
- An AI coding agent host that can read project files
- OpenCode or Claude Code for the most validated path today

### Install the overlay

Run this in the root of a target project. Install from the public GitHub repository:

```text
npm install --save-dev github:bartoszarendt/agenticloop
npx agenticloop init
```

For a one-off run without keeping a dependency:

```text
npm exec --yes --package=github:bartoszarendt/agenticloop -- agenticloop init
```

This creates a files-first Agentic Loop overlay:

```text
target-project/
  agenticloop/                 toolkit-owned process assets
    AGENTIC_LOOP.md
    agents/
    backends/
    skills/
    commands/
    memory/
    config.json
    agenticloop.template.json
    manifest.json

  .agenticloop/                target-owned durable workflow state
    project.md
    tasks/
    decisions/
    improvements/ (created on first proposal)
    logs/
    tmp/
```

### Confirm setup

Plain `init` is files-only: it does not create adapter config, and it leaves the
project map at `setup_status: unconfirmed`. Run guided setup to confirm the
project map, choose a host adapter, and configure per-role models in one pass:

```text
npx agenticloop setup
```

`setup` is resumable and requires explicit confirmation before writing project
map values. Inspect onboarding state any time without changing files:

```text
npx agenticloop doctor
```

Then validate:

```text
npx agenticloop validate
```

Prefer to skip guided setup? Confirm `.agenticloop/project.md` manually
(set `setup_status: confirmed` after reviewing the backend) or ask your agent to
run the `setup-agenticloop` skill, then add an adapter with
`npx agenticloop init --adapter <host>`.

## Add a host adapter

Agentic Loop is host-neutral. The canonical source stays in Markdown, and adapters generate host-native artifacts. Guided `setup` already includes adapter selection; the explicit commands below add or regenerate a specific host directly.

```text
npx agenticloop init --adapter opencode
npx agenticloop init --adapter claude-code
npx agenticloop init --adapter codex
npx agenticloop init --adapter copilot
npx agenticloop init --adapter cursor
```

Use `--adapter all` to generate artifacts for every supported host adapter.

## Start Agentic Loop

Agentic Loop does not run automatically. You explicitly activate it from the agent host when you want the agent to enter the supervised loop.

The activation argument is optional.

Run Agentic Loop with no argument when you want the agent to orient itself in the repository first:

```text
/agenticloop
```

In orientation mode, the agent should read `.agenticloop/project.md`, check setup state, inspect configured project documents, look for existing task records, summarize the current project/task state, and ask which task to take next.

Add a task ID or task description when you want to route directly to a known work unit:

```text
/agenticloop T-001
/agenticloop "Create a task record for adding password reset validation, then implement only the scoped change with tests."
```

Host-specific activation surfaces differ:

| Host | Status | Activation |
|---|---|---|
| OpenCode | Supported | `/agenticloop` or `/agenticloop <task-id or task description>` |
| Claude Code | Supported | Repo-local: `/agenticloop`; plugin: `/agenticloop:start` |
| Codex | Supported | `$agenticloop` or `$agenticloop <task-id or task description>` |
| GitHub Copilot | Supported | Copilot CLI: `/agenticloop`; IDE prompt files: generated `agenticloop` prompt |
| Cursor | Supported | `/agenticloop` or `/agenticloop <task-id or task description>` |

See [docs/host-adapters.md](docs/host-adapters.md) for the full adapter matrix and generated file shapes.

## Cost-quality routing by role

Different roles need different intelligence. Cheap, fast orchestration is appropriate only for serial single-task coordination with clear scope; parallel scans, lease design, backend selection, and authorization-boundary judgment need strong reasoning. The practical savings usually come from splitting implementation and review: use a capable coding model for engineer work, and reserve the strongest reasoning you can justify for maintainer scope, review, and acceptance decisions.

Adapter-local role settings live under `adapters.<host>.roleSettings.<role>` in `agenticloop.json`. OpenCode and Codex support role-specific reasoning effort. Claude Code supports role-specific model and permission mode. Copilot and Cursor currently support role-specific model selection.

`agenticloop.json` is created only by `agenticloop setup` or `agenticloop init --adapter <host>`; plain `init` is files-only and never writes it. Claude Code Mode B defaults the maintainer and engineer subagents to `acceptEdits` and writes a broad permissions profile to a gitignored `.claude/settings.local.json`; review [docs/host-adapters.md](docs/host-adapters.md) before sharing settings project-wide.

Example shape:

```json
{
  "adapters": {
    "opencode": {
      "roleSettings": {
        "orchestrator": {
          "model": "<cheap-fast-coordinator-model>",
          "reasoningEffort": "low"
        },
        "maintainer": {
          "model": "<best-review-and-reasoning-model>",
          "reasoningEffort": "high"
        },
        "engineer": {
          "model": "<strong-coding-model>",
          "reasoningEffort": "medium"
        }
      }
    }
  }
}
```

Use host-specific model identifiers and aliases. In hosts or providers where the provider is encoded in the model identifier, this also becomes provider routing in practice.

## What happens with bare activation

Activation syntax is host-specific (`/agenticloop`, `$agenticloop`, or the generated Copilot IDE prompt file — see the table above); the behavior below is the same on every host.

A bare activation is the safest way to start in a new or unfamiliar repository. The agent should not immediately implement work just because it found something interesting.

Expected behavior:

1. Read `.agenticloop/project.md`.
2. If setup is unconfirmed, route setup confirmation first.
3. Read configured primary project documents (rules, overview, process) plus any selected task-source docs (plan, spec, design, context).
4. Inspect the active backend for existing candidate tasks.
5. Summarize current project and task state.
6. If exactly one open or ready task exists, propose it as the default candidate.
7. If no open tasks exist, identify a likely next task from the plan.
8. Ask the human to select a task or provide a task description.

The agent should not silently start implementation unless the human has clearly authorized that work unit.

## Task backends

Agentic Loop supports two task-record backends.

| Backend | Status | Storage | Use when |
|---|---|---|---|
| Files | Default | `.agenticloop/tasks/<TASK-ID>.md` | You want the lowest-friction local workflow with no external dependency. |
| GitHub | Optional | GitHub issues and pull requests | Your project already uses GitHub issues and PRs as durable implementation artifacts. |

The active backend is selected in `.agenticloop/project.md`.

## What it is not

Agentic Loop is intentionally narrow. It is not:

- a deterministic autonomous controller or self-running pipeline;
- an agent runtime, SDK, or framework;
- a replacement for your existing project docs;
- a marketplace, registry, or centralized trust service;
- a telemetry collector or raw transcript store;
- a way to bypass human approval for merge, release, destructive cleanup, or locked project decisions.

The human stays in the loop for authorization boundaries. The agent handles routine workflow steps inside an authorized work unit.

## Design principles

These are the choices that shape the toolkit. They are not aspirational -- they are reflected in what is built and what was intentionally left out.

### Markdown is the product surface

The methodology, roles, skills, backend projections, and templates are all Markdown. The CLI handles install, validation, updates, and adapter generation, but the process itself is readable and auditable without tooling.

### Overlay, not replacement

Agentic Loop installs beside your existing project docs. It does not overwrite your plan, architecture docs, or repository rules. Your project stays yours.

### Files first

Local Markdown task records are the default. GitHub issues and PRs are an optional projection. You should not need a GitHub account to run a disciplined agent workflow.

### Evidence over claims

A task is not complete because the agent says so. Completion requires fresh verification evidence from the final state -- test output, lint results, build status, changed file lists. The evidence lives in the task record, not in chat.

### Supervised, not autonomous

The agent can advance through routine lifecycle steps inside an authorized work unit. It stops for human direction before leaving scope, merging, releasing, publishing, destructive cleanup, or changing locked decisions. The human owns the authorization boundaries.

### Portable across hosts

One canonical Markdown source generates host-native shims for OpenCode, Claude Code, Codex, Copilot, and Cursor. You do not maintain separate workflow instructions for each host.

## CLI reference

```text
npx agenticloop init [--adapter <host>]              Scaffold overlay (files-only without --adapter)
npx agenticloop setup [--adapter <host>]             Guided onboarding: confirm setup, pick adapter, configure models
npx agenticloop doctor                               Show setup checklist and adapter state; writes nothing
npx agenticloop update [--adapter <host>]            Refresh toolkit assets and existing adapter output
npx agenticloop upgrade                              Compatibility alias for update
npx agenticloop validate                             Validate skills, config, links, and host setup
npx agenticloop status                               Show configured adapters, artifacts, and next steps
npx agenticloop github-preflight --pr <number>       Verify a GitHub PR body carries final-state evidence
npx agenticloop task list [--status <s>] [--json]    List files-backed task records
npx agenticloop task lint [<task-id>] [--json]       Lint task frontmatter and lifecycle state
npx agenticloop task new <title> [--id <id>]         Create a new task record
npx agenticloop task status <id> <status>            Change task lifecycle status
npx agenticloop worktree add <task-id> <branch>      Create guarded repo-internal lane worktree
npx agenticloop worktree guard [--fix] [--all]       Check or repair non-interactive Git guard config
npx agenticloop worktree list [--json]               List all registered worktrees
npx agenticloop worktree remove <id|path> --dry-run  Preview worktree removal
npx agenticloop worktree remove <id|path> --yes      Remove a standard worktree and preserve lane state
npx agenticloop worktree cleanup --dry-run           Preview bulk cleanup of merged/integrated lanes
npx agenticloop worktree cleanup --yes               Remove merged standard worktrees after confirmation
npx agenticloop worktree resolve-state <id|path>     Resolve lane-local state preservation conflicts
npx agenticloop worktree prune --dry-run             Preview stale worktree registrations
npx agenticloop worktree prune --yes                 Remove stale worktree registrations
npx agenticloop generate <host|all>                  Generate host adapter artifacts
npx agenticloop configure models --adapter <host>    Configure per-role models (requires agenticloop.json)
npx agenticloop bootstrap-labels                     Create GitHub labels via the gh CLI (needs gh auth + repo)
npx agenticloop event-logging <event> [options]      Append/validate/audit/report optional workflow-gate events
npx agenticloop remove --dry-run                     Preview overlay removal
npx agenticloop remove --yes                         Remove toolkit assets and generated shims
npx agenticloop remove --yes --include-state         Also remove target-owned `.agenticloop/` state
```

Lane-local state that cleanup can preserve is flat only (`logs`, `tasks`,
`summaries` (legacy; preserved for migration only -- current projects do not
create a summaries directory), and `decisions` files directly under
`.agenticloop/<dir>/`). Nested or shared `.agenticloop` files are treated as
blocking dirty state. For `.jsonl`
files, preservation is safe when the root file already contains every lane line
(a root superset). If preservation conflicts with existing root state, use
`worktree resolve-state` with `--strategy prefer-root` (copy root into lane),
`--strategy prefer-worktree` (copy lane into root), or `--strategy union-jsonl`
(root-first max-count multiset union written to both files) before running
cleanup. `union-jsonl` is the recommended lossless strategy for JSONL log
conflicts. resolve-state does not remove worktrees or branches.

Event logging is **disabled by default**. Enable it in `.agenticloop/project.md` with `event_logging: enabled`. `event_logging_command` can stay blank; agents test `npx agenticloop --help` once when enabled. Writes require `--task` and `--summary`; `validate`/`audit`/`report` inspect existing logs. Per-task completion summaries are always written inline into `.agenticloop/tasks/<TASK-ID>.md` (the `## Scope Completed` section). There is no separate `.agenticloop/summaries/` directory; closeout is a verify-and-mark gate that confirms those inline summaries and posts a status marker.

Normal downstream use does not require Python, PowerShell, Bash scripts, API keys, or framework setup for the toolkit itself.

## Repository layout

This source repository authors the canonical toolkit assets at the root:

```text
.                             package root (npm package: agenticloop)
  AGENTIC_LOOP.md             core methodology
  agents/                     orchestrator, maintainer, engineer role definitions
  backends/                   files and GitHub backend projection docs
  skills/                     canonical workflow skills
  commands/                   host command templates
  memory/                     task, summary, and decision record templates
  docs/                       setup and adapter documentation
  src/                        Node CLI internals
  bin/                        CLI entry point
  test/                       Node test suite
  config.json                 toolkit defaults
  agenticloop.template.json   target config template
  manifest.json               layout and ownership metadata
```

In target projects, `agenticloop/` is toolkit-owned and refreshable.
`.agenticloop/` is target-owned workflow state and should not be overwritten by
updates. Canonical toolkit assets (agents, skills, backends) always live under
`agenticloop/` (no dot). `.agenticloop/agents/`, `.agenticloop/skills/`, and
`.agenticloop/backends/` are invalid paths.

## Documentation

| Document | Purpose |
|---|---|
| [AGENTIC_LOOP.md](AGENTIC_LOOP.md) | Full methodology and workflow contract. |
| [docs/getting-started.md](docs/getting-started.md) | Setup and first-run path. |
| [docs/downstream-adoption.md](docs/downstream-adoption.md) | How the overlay model works in existing projects. |
| [docs/host-adapters.md](docs/host-adapters.md) | Adapter support table and generation behavior. |
| [docs/skill-anatomy.md](docs/skill-anatomy.md) | Skill authoring contract and expectations. |
| [docs/workflow-examples.md](docs/workflow-examples.md) | Project-agnostic workflow examples. |
| [docs/registry-horizon.md](docs/registry-horizon.md) | Why registry and marketplace work is deferred. |
| [docs/opencode-setup.md](docs/opencode-setup.md) | OpenCode setup. |
| [docs/claude-code-setup.md](docs/claude-code-setup.md) | Claude Code setup. |
| [docs/codex-setup.md](docs/codex-setup.md) | Codex setup. |
| [docs/copilot-setup.md](docs/copilot-setup.md) | GitHub Copilot setup. |
| [docs/cursor-setup.md](docs/cursor-setup.md) | Cursor setup. |

## Status

Version 0.1.0. The methodology, files backend, Node CLI, validation, overlay management, and all five host adapters (OpenCode, Claude Code, Codex, Copilot, and Cursor) are supported and ready for use.

Registry, marketplace, and centralized services are intentionally deferred -- see [docs/registry-horizon.md](docs/registry-horizon.md) for the reasoning and the evidence gates that would need to pass before revisiting.

## Development

Run the test suite:

```text
npm test
```

Run the compact test reporter:

```text
npm run test:dot
```

Validate toolkit assets:

```text
npx agenticloop validate
```

The CLI is written in JavaScript as ES modules and targets Node.js `>=20`.

## Contributing

Contributions are welcome, especially around:

- documentation clarity;
- adapter smoke testing;
- workflow examples;
- validation coverage;
- host-specific setup gaps;
- real-world adoption reports.

Before opening a large pull request, open an issue describing the proposed change. Agentic Loop is a methodology project, so changes to task records, role boundaries, backend behavior, or approval gates should be discussed before implementation.

Before submitting a pull request, run:

```text
npm test
npx agenticloop validate
```

Do not commit generated caches, local runtime artifacts, downstream product code, secrets, or raw agent transcripts.

## Security and privacy

Agentic Loop stores durable workflow state in project files. Optional event logs are local JSONL files and should contain short workflow-gate summaries, not raw prompts, raw assistant messages, token streams, terminal dumps, secrets, or host telemetry.

Do not use Agentic Loop to bypass repository permissions, human review, release approval, or project security policy.

## License

MIT. See [LICENSE](LICENSE).

## Maintainer

Maintained by Bartosz Arendt.
