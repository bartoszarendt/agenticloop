# Agentic Loop

> Loop engineering for AI coding agents – shaping the whole run, not one prompt – in a Markdown-first overlay that gives your agent a task contract, role boundaries, verification rules, and durable memory: the process a good engineering team already has.

AI coding agents are useful, but they are unreliable at sustained software work. They drift scope, skip verification, repeat failing approaches, and lose context between sessions. The problem is not that the models are not smart enough. The problem is that they lack process: a clear task contract, role boundaries, verification rules, and durable project memory.

Agentic Loop adds that layer. It installs as a lightweight, removable overlay in an existing project and never rewrites your target-owned documents: your `README.md`, implementation plan, and architecture docs stay untouched. (The one clearly marked, removable exception is described in [Repository-rules activation guidance](#repository-rules-activation-guidance).) It gives agents the scaffolding they need to stay in scope, produce evidence, and respect review gates.

![Version: 0.3.0](https://img.shields.io/badge/version-0.3.0-blue)
![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- Enable after the first public npm publish:
[![npm version](https://img.shields.io/npm/v/agenticloop.svg)](https://www.npmjs.com/package/agenticloop)
-->

## Loop engineering

Prompt engineering shapes a single response. Context engineering shapes what the model sees. **Loop engineering** shapes the whole run: which states the agent moves through, what durable artifact each state must produce, when verification happens, when to stop and escalate, and who reviews work before it counts as done.

Most agent failures – scope drift, evidence-free "done", unbounded retries, reviewing your own work – are loop failures, not model failures. Agentic Loop is loop engineering made practical: an installable Markdown overlay that defines the states, gates, and artifacts so the loop holds for hours of complex work instead of unraveling after a few exchanges. Under the hood this is prompt chaining hardened for software delivery: each step hands off a durable, reviewable artifact – a task record, verification evidence, a review result – instead of loose chat text.

## Why this exists

After watching AI coding agents work on real projects, the same loop failures keep showing up:

- **Scope drift**: the agent expands the task or bundles unrelated changes because nothing tells it where the boundary is.
- **Evidence-free completion**: the agent claims work is done without running fresh checks against the final state.
- **Unbounded retries**: the agent repeats the same failing approach because there is no rule that says stop and escalate.
- **Role confusion**: the same agent plans, implements, and reviews its own work – which is the equivalent of grading your own exam.
- **Lost context**: useful decisions disappear when the chat session ends because nothing durable was written down.
- **Host lock-in**: workflow instructions get written in one agent host's format and are useless in another.

These are process failures, not model failures – and they are exactly what the loop is engineered to prevent, in a form portable across hosts without duplicating everything.

## Who this is for

This toolkit makes sense if you already use AI coding agents for real software work and you want more reliable outcomes. Specifically:

- You use OpenCode, Claude Code, Codex, Copilot, or Cursor for non-trivial development tasks.
- You want the agent to stay in scope, produce evidence, and stop at review gates instead of silently finishing work and moving on.
- You are comfortable with Markdown and a small CLI overlay in your project.
- You want to route expensive model reasoning to the places where it actually changes the outcome – review, acceptance, quality gates – and use cheaper models for coordination.

It probably does not make sense if you only use agents for one-shot questions or throwaway scripts, if you want a fully autonomous pipeline with no human in the loop, or if you are looking for a hosted SaaS platform rather than project-local tooling.

## The team

Agentic Loop organizes agent work into a disciplined engineering team with four roles, four boundaries:

| Role | What it does | What it never does |
|---|---|---|
| **Orchestrator** | Plans routing, delegates work, coordinates serial and parallel lanes, tracks progress. | Edit implementation files, act as final reviewer, or accept tasks. |
| **Engineer** | Implements the smallest useful slice, test-first when applicable, and publishes fresh verification evidence. | Expand scope or accept its own work. |
| **Maintainer** | Creates and right-sizes task records, reviews through task compliance, engineering quality, and necessity/coherence lenses, accepts or requests revisions, owns decisions and closeout. | Accept work without fresh final-state evidence. |
| **Auditor** | Independently certifies the finished work unit as a whole – outcome, completeness, integration, quality, verification, risk – against the exact integrated baseline. | Implement, accept tasks, expand scope, or accept a limitation or risk for you. |

No role grades its own exam. Task review proves each task was done correctly;
the auditor answers the question no task review asks – does the combined result
actually work, and is it proven? Findings route back through ordinary maintainer
and engineer remediation, and a fresh auditor re-audits the new baseline. When ready tasks are independent, the orchestrator can run up to the configured implementation-lane maximum (default five) in parallel, each in its own guarded repo-internal `git worktree`, after a current Parallel Opportunity Scan. The limit is a ceiling, not a total-agent budget or an eligibility grant. In practice it feels like having a well-organized development team at your fingertips: a coordinator, parallel implementers, and a demanding reviewer – each with its own model budget (see [Cost-quality routing by role](#cost-quality-routing-by-role)).

## What it gives your agent

| Capability | What it does |
|---|---|
| **Task records** | Define scope, out-of-scope boundaries, acceptance criteria, required checks, expected files, implementation notes, and review state. |
| **Role boundaries** | Split work across orchestrator, maintainer, engineer, and auditor roles with explicit edit and acceptance boundaries per role. |
| **Work-unit audit** | Certify a finished work unit against its exact integrated baseline before closeout, with findings routed through ordinary remediation. On by default; an explicit `work_unit_audit: disabled` is the human opt-out. |
| **Parallel worktree lanes** | Run independent engineer lanes concurrently in guarded repo-internal `git worktree`s, with guard checks, lane-state preservation, and safe bulk cleanup after acceptance. |
| **Canonical skills** | Provide focused procedures for task creation, TDD, debugging, verification evidence, review, blocked states, decision capture, attribution, and closeout. |
| **Decision records** | Preserve durable project decisions under `.agenticloop/decisions/` so future agent sessions do not rediscover or contradict them. |
| **Audit certificates** | Record work-unit certification state and append-only audit history under `.agenticloop/audits/`, bound to an exact artifact and covered-task set. |
| **Files-first backend** | Store task records as local Markdown files under `.agenticloop/tasks/` by default. No GitHub setup required. |
| **GitHub backend** | Optionally project task records to GitHub issues and implementation artifacts to pull requests. |
| **Cost-quality routing** | Configure different model and reasoning settings per role, so cheap coordinator work does not consume the same model budget as high-judgment review. |
| **Host adapters** | Generate host-native shims for OpenCode, Claude Code, Codex, GitHub Copilot, and Cursor from one canonical Markdown source. |
| **Optional event logs** | Record compact JSONL workflow-gate events for local audit and summary generation without storing raw transcripts. |

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
Implementation  ◄─────────────┐
  - smallest useful slice     │
  - TDD when applicable       │
  ↓                           │
Verification                  │
  - required checks           │
  - fresh evidence from       │
    the final state           │
  ↓                           │
Review                        │
  - lens 1: task compliance   │
  - lens 2: engineering       │
    quality                   │
  - lens 3: necessity and     │
    coherence                 │
  ↓                           │
  needs revision ─────────────┘
  ↓ accepted
Closeout
  - confirm the task record's inline
    completion summary, mark done
  ↓
Next task → new task record, top of the loop
```

Every meaningful state change should produce a durable artifact. Nothing important should live only in chat.

## Why long runs don't fall apart

A loose chat session degrades as it grows: context evaporates, failed attempts repeat, and "done" gets cheaper the longer the session runs. The loop is engineered so that multi-hour runs on complex tasks stay stable:

- **Attempt budgets.** Repeating an equivalent action that produces no new evidence hits a hard budget (default 3). When it is exhausted, the agent stops repeating and records a blocked or needs-context state instead of thrashing.
- **Review round checkpoints.** A task that keeps failing review is bounded separately: after three `needs_revision` rounds the orchestrator must classify the cause and route one targeted revision. A fourth undirected "try again" is not allowed.
- **Blocked states, not guesses.** When progress requires a human decision or missing context, the agent records a durable blocked state naming what it needs. The loop resumes when the blocker is cleared.
- **Verification learning.** Observed check behavior – slow suites, flaky commands, timeouts – is recorded as durable operating facts, so later tasks and sessions do not rediscover it.
- **Everything durable.** Task records, evidence, review outcomes, and decisions live in files, not chat. A run survives session death: a fresh session reads the task record and continues where the last one stopped.

The result in practice: inside an authorized work unit, the agent works autonomously for hours on a complex task – and when it finally needs you, it is because it hit a boundary that is genuinely yours to decide.

## What a run looks like

A typical files-backed run, condensed:

1. You activate with a bare `/agenticloop`. The agent orients itself: it reads the project map and configured docs, reports what the project is and where it currently stands, and proposes the next task – from open task records, or straight from your implementation plan.
2. You approve. The maintainer creates `.agenticloop/tasks/T-014.md` with scope, out of scope, acceptance criteria, and required checks.
3. The engineer implements the smallest useful slice test-first, runs the required checks fresh, and publishes the implementation summary with evidence into the task record.
4. The maintainer reviews in one ordered three-lens round – task compliance, engineering quality, then necessity and coherence – and accepts or requests revisions with concrete findings.
5. Closeout confirms the inline completion summary and marks the task done. You review a durable record, not a chat scroll.

An implementation plan in the repository is all it needs: bare activation finds the plan, proposes the next task from it, and the loop handles it once you approve. To route directly to a known work unit instead, pass it: `/agenticloop T-014` or a one-line task description.

[docs/workflow-examples.md](docs/workflow-examples.md) walks through the full loop, including the GitHub-backed variant and review markers.

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

## Stop Agentic Loop

Stopping deactivates Agentic Loop only for the current conversation. It safely
checkpoints unfinished work when needed; it does not accept or close a task,
commit, push, merge, or clean up a worktree.

`stop` takes no task ID or other arguments: it must be the exact and only
activation argument. The task or context forms below are separate resume
invocations.

| Host | Stop | Resume (separate invocation) |
|---|---|---|
| OpenCode | `/agenticloop stop` | `/agenticloop <task or context>` |
| Claude Code repo-local | `/agenticloop stop` | `/agenticloop <task or context>` |
| Claude Code plugin | `/agenticloop:stop` | `/agenticloop:start <task or context>` |
| Codex | `$agenticloop stop` | `$agenticloop <task or context>` |
| Copilot CLI | `/agenticloop stop` | `/agenticloop <task or context>` |
| Cursor | `/agenticloop stop` | `/agenticloop <task or context>` |

This is not host exit (`/exit` or `/quit`), Codex's built-in `/stop` terminal
control, task closeout, or worktree cleanup. See [Host Adapters](docs/host-adapters.md#stop-agentic-loop).

## Cost-quality routing by role

This is [the team](#the-team) with a budget attached: a cheap coordinator, a capable implementer, and the strongest reviewer you can justify. Different roles need different intelligence. Cheap, fast orchestration is appropriate only for serial single-task coordination with clear scope; parallel scans, lease design, backend selection, and authorization-boundary judgment need strong reasoning. The practical savings usually come from splitting implementation and review: use a capable coding model for engineer work, and reserve the strongest reasoning you can justify for maintainer scope, review, and acceptance decisions.

Adapter-local role settings live under `adapters.<host>.roleSettings.<role>` in `agenticloop.json`. OpenCode and Codex support role-specific reasoning effort. Claude Code supports role-specific model and permission mode. Copilot and Cursor currently support role-specific model selection.

Fresh Codex setup uses an opinionated cost/quality profile in target-owned
`agenticloop.json`: orchestrator `gpt-5.6-luna` with `xhigh`, maintainer
`gpt-5.6-terra` with `xhigh`, engineer `gpt-5.6-terra` with `high`, and auditor
`gpt-5.6-sol` with `high`. Auditor has its own slot: the maintainer model is
never silently reused for it, because the audit exists to be independent of the
authority that accepted the work.
Explicit target settings always win. Existing installations can fill only missing
Codex fields with `npx agenticloop configure models --adapter codex --profile recommended`.

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
        },
        "auditor": {
          "model": "<best-assurance-and-reasoning-model>",
          "reasoningEffort": "high"
        }
      }
    }
  }
}
```

Use host-specific model identifiers and aliases. In hosts or providers where the provider is encoded in the model identifier, this also becomes provider routing in practice.

## What happens with bare activation

Activation syntax is host-specific (`/agenticloop`, `$agenticloop`, or the generated Copilot IDE prompt file – see the table above); the behavior is the same on every host. A bare activation is the safest way to start in a new or unfamiliar repository: the agent orients itself first. It reads `.agenticloop/project.md` (routing setup confirmation first if setup is unconfirmed), reads the configured project documents, inspects the active backend for candidate tasks, and summarizes the current project and task state. If exactly one open task exists it proposes it as the default candidate; if none exist it identifies a likely next task from the plan. Then it stops and asks you to select a work unit – it does not silently start implementation unless the human has clearly authorized that work unit. The normative step list lives in [AGENTIC_LOOP.md](AGENTIC_LOOP.md).

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

These are the choices that shape the toolkit. They are not aspirational – they are reflected in what is built and what was intentionally left out.

### Markdown is the product surface

The methodology, roles, skills, backend projections, and templates are all Markdown. The CLI handles install, validation, updates, and adapter generation, but the process itself is readable and auditable without tooling.

### Overlay, not replacement

Agentic Loop installs beside your existing project docs. It does not overwrite your plan, architecture docs, or repository rules. Your project stays yours.

### Files first

Local Markdown task records are the default. GitHub issues and PRs are an optional projection. You should not need a GitHub account to run a disciplined agent workflow.

### Evidence over claims

A task is not complete because the agent says so. Completion requires fresh verification evidence from the final state – test output, lint results, build status, changed file lists. The evidence lives in the task record, not in chat.

### Supervised autonomy

Autonomous inside the boundary, supervised at the boundary. The human authorizes work units; inside one, the agent advances through the full lifecycle on its own – implement, verify, request review, revise, close out. It stops for human direction before leaving scope, merging, releasing, publishing, destructive cleanup, or changing locked decisions. The human owns the authorization boundaries; the loop owns everything between them.

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
npx agenticloop github-ready --pr <number>           Read-only pre-merge gate: evidence preflight + review audit
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
npx agenticloop guidance check                       Report the repository-rules activation-guidance block status
npx agenticloop guidance apply                       Create/append/refresh the activation-guidance block (idempotent)
npx agenticloop guidance remove                      Remove the owned activation-guidance block
npx agenticloop remove --dry-run                     Preview overlay removal
npx agenticloop remove --yes                         Remove toolkit assets and generated shims
npx agenticloop remove --yes --include-state         Also remove target-owned `.agenticloop/` state
```

Worktree `remove` and `cleanup` preserve task-specific lane-local `.agenticloop` state before removal. See [docs/worktrees.md](docs/worktrees.md) for what counts as lane-local state, when preservation conflicts block cleanup, and the `resolve-state` strategies.

Event logging is **disabled by default** and stores only compact workflow-gate summaries, never raw transcripts. Enable it with `event_logging: enabled` in `.agenticloop/project.md`; see [docs/event-logging.md](docs/event-logging.md) for the event commands and audit workflow. Per-task completion summaries are always written inline into the task record's `## Scope Completed` section; there is no separate summaries directory.

Normal downstream use does not require Python, PowerShell, Bash scripts, API keys, or framework setup for the toolkit itself.

## Repository-rules activation guidance

Installing Agentic Loop does not activate the methodology. To make that boundary
explicit to agents, `init` and `setup` add one clearly marked, manifest-owned
block to your selected repository-rules document (resolved as the explicit
`documents.rules` selection, else the first existing `AGENTS.md` / `CLAUDE.md` /
`GEMINI.md`, else a newly created `AGENTS.md`):

```md
<!-- AGENTICLOOP_START -->
## Agentic Loop
...
<!-- AGENTICLOOP_END -->
```

Guarantees:

- Agentic Loop never replaces target-owned repository contract documents. Only
  the region between the two markers is owned; everything outside stays yours,
  byte-for-byte.
- A user-modified owned block is preserved and reported, never silently
  overwritten. An unowned marker block you wrote yourself is never adopted
  automatically.
- Existing installations are not silently enrolled: `update` only refreshes a
  block it already owns, and repeat `init`/`setup` follows the same policy.
- Opt out with `--no-agents-guidance` on `init`/`setup`, or remove a managed
  block later with `agenticloop guidance remove` (which deletes an
  Agentic-Loop-created file only when nothing but the block remains).
- `guidance remove --force` removes an edited managed marker region only; it
  never replaces or truncates content outside that region. If the configured
  rules path changes while a block is owned elsewhere, `guidance check` reports
  the drift and automatic refresh does not create a second block.

The block also states that the main agent may invoke the generated **engineer**
as an ordinary bounded subagent. That **standalone engineer** delegation does not
activate Agentic Loop and needs no task ID or task record; full Agentic Loop
engineer mode is selected only by explicit activation or a named durable task
record. See [`AGENTIC_LOOP.md`](AGENTIC_LOOP.md) and
[`agents/engineer.md`](agents/engineer.md).

## Repository layout

This source repository authors the canonical toolkit assets at the root:

```text
.                             package root (npm package: agenticloop)
  AGENTIC_LOOP.md             core methodology
  agents/                     orchestrator, maintainer, engineer, auditor role definitions
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
| [docs/worktrees.md](docs/worktrees.md) | Worktree lanes, lane-state preservation, and cleanup. |
| [docs/event-logging.md](docs/event-logging.md) | Optional workflow-gate event logging. |
| [docs/registry-horizon.md](docs/registry-horizon.md) | Why registry and marketplace work is deferred. |
| [docs/opencode-setup.md](docs/opencode-setup.md) | OpenCode setup. |
| [docs/claude-code-setup.md](docs/claude-code-setup.md) | Claude Code setup. |
| [docs/codex-setup.md](docs/codex-setup.md) | Codex setup. |
| [docs/copilot-setup.md](docs/copilot-setup.md) | GitHub Copilot setup. |
| [docs/cursor-setup.md](docs/cursor-setup.md) | Cursor setup. |

## Status

Version 0.3.0. The methodology, files backend, Node CLI, validation, overlay management, and all five host adapters (OpenCode, Claude Code, Codex, Copilot, and Cursor) are supported and ready for use.

Registry, marketplace, and centralized services are intentionally deferred – see [docs/registry-horizon.md](docs/registry-horizon.md) for the reasoning and the evidence gates that would need to pass before revisiting.

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