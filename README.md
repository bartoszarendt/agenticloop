# Agentic Loop

> Graph engineering for AI coding agents – binding every state change, evidence requirement, and authorization boundary to durable artifacts so multi-hour work stays coherent – in a Markdown-first overlay that gives your agent the process a good engineering team already has.

AI coding agents are useful, but they are unreliable at sustained software work. They drift scope, skip verification, repeat failing approaches, and lose context between sessions. The problem is not that the models are not smart enough. The problem is that they lack process: a clear task contract, role boundaries, verification rules, and durable project memory.

Agentic Loop adds that layer. It installs as a lightweight, removable overlay in an existing project and never rewrites your target-owned documents: your `README.md`, implementation plan, and architecture docs stay untouched. (The one clearly marked, removable exception is described in [Repository-rules activation guidance](#repository-rules-activation-guidance).) It gives agents the scaffolding they need to stay in scope, produce evidence, and respect review gates.

![Version: 0.4.5](https://img.shields.io/badge/version-0.4.5-blue)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- Enable after the first public npm publish:
[![npm version](https://img.shields.io/npm/v/agenticloop.svg)](https://www.npmjs.com/package/agenticloop)
-->

## Graph engineering

Prompt engineering shapes a single response. Context engineering shapes what the model sees. **Graph engineering** shapes what may happen next: which states the agent may enter, which transitions are legal, what evidence and authority each edge requires, when to stop and escalate, and who must independently review work before it counts as done.

Most agent failures – scope drift, evidence-free "done", unbounded retries, reviewing your own work – arise when workflow structure is absent or unguarded. Agentic Loop makes workflow graph engineering practical: an installable Markdown overlay whose typed states, guarded transitions, durable artifacts, parallel branches, remediation paths, audit, and closeout prevent these failures by binding every state change and role handoff to evidence and authority.

## Why this exists

After watching AI coding agents work on real projects, the same workflow graph failures keep showing up:

- **Unguarded transitions**: the agent enters a new state (implementation, review, closeout) without proving it has the evidence or authority that state requires.
- **Broken edges**: handoffs between roles carry no durable record of what was delivered, by whom, and with what assurance – so the next role has no proof of chain.
- **Lost provenance**: who approved what, when, and under what conditions disappears into chat; decisions and corrections evaporate without durable traces.
- **Authority leaks**: the same agent plans, implements, reviews, and accepts its own work because there is nothing that enforces separation of concerns.
- **Evidence gaps**: transitions happen on claims, not proof – the agent says work is done without fresh evidence bound to that state change.
- **Host lock-in**: workflow instructions get written in one agent host's format and are useless in another.

These are process failures, not model failures – and they are exactly what the guarded workflow graph is engineered to prevent, in a form portable across hosts without duplicating everything.

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

Parallel scope is deliberately separate from expected writes: broad `allowed_paths`
does not by itself prove a collision. Structured `owned_paths` enables disjoint
lanes, while a Maintainer-classified managed join can reconcile only exact,
additive shared operations into a separately verified and fully reviewed join
artifact. [Downstream adoption](docs/downstream-adoption.md#parallel-write-ownership-and-managed-joins)
has the user-facing guide; merge remains human-controlled.

## What it gives your agent

| Capability | What it does |
|---|---|
| **Task records** | Define scope, out-of-scope boundaries, acceptance criteria, required checks, expected files, implementation notes, and review state. |
| **Role boundaries** | Split work across orchestrator, maintainer, engineer, and auditor roles with explicit edit and acceptance boundaries per role. |
| **Guarded workflow graph** | Allow state changes only through evidence-bound transitions with explicit authority, provenance, readiness, and safe-repair diagnostics. |
| **Activation and return assurance** | Bind dispatch to an operator-confirmed or host-signed activation and grade role returns honestly as session-reported or host-receipted. |
| **Work-unit audit** | Certify a finished work unit against its exact integrated baseline before closeout, with findings routed through ordinary remediation. On by default; an explicit `work_unit_audit: disabled` is the human opt-out. |
| **Mechanical closeout** | Prepare and revalidate a digest-bound packet before recording one current marker, with correction history, candidate-drift checks, and files/GitHub parity. |
| **Parallel worktree lanes** | Run independent engineer lanes concurrently in guarded repo-internal `git worktree`s, with guard checks, lane-state preservation, and safe bulk cleanup after acceptance. |
| **Canonical skills** | Provide focused procedures for task creation, TDD, debugging, verification evidence, review, blocked states, decision capture, attribution, and closeout. |
| **Decision records** | Preserve durable project decisions under `.agenticloop/decisions/` so future agent sessions do not rediscover or contradict them. |
| **Audit certificates** | Record work-unit certification state and append-only audit history under `.agenticloop/audits/`, bound to an exact artifact and covered-task set. |
| **Files-first backend** | Store task records as local Markdown files under `.agenticloop/tasks/` by default. No GitHub setup required. |
| **GitHub backend** | Optionally project task records to GitHub issues and implementation artifacts to pull requests. |
| **Cost-quality routing** | Configure different model and reasoning settings per role, so cheap coordinator work does not consume the same model budget as high-judgment review. |
| **Host adapters** | Generate host-native shims for OpenCode, Claude Code, Codex, GitHub Copilot, and Cursor from one canonical Markdown source. |
| **Optional event logs** | Record compact JSONL workflow-gate events for local audit and summary generation without storing raw transcripts. |

## The workflow graph

```text
Request
  |
  v
Task contract --> operator activation --> guarded dispatch
                                          |
                                          v
                    +--------------- Implementation
                    |                     |
                    | needs_revision      v
                    +------------------ Review <--- fresh verification
                                          |
                                          | accepted
                                          v
                                   Work-unit audit
                                    |           |
                           findings |           | certified
                                    v           v
                               Remediation   Closeout --> next task

Any gate -- missing authority, context, or evidence --> blocked/needs_context
          -- repaired evidence ---------------------> re-enter that gate
```

Every meaningful edge is guarded by current evidence and produces or verifies a durable artifact. Nothing important should live only in chat.

## Why long runs don't fall apart

A loose chat session degrades as it grows: context evaporates, failed attempts repeat, and "done" gets cheaper the longer the session runs. The guarded workflow graph is engineered so that multi-hour runs on complex tasks stay stable:

- **Attempt budgets.** Repeating an equivalent action that produces no new evidence hits a hard budget (task `attempt_budget`, then project `default_attempt_budget`, then built-in `5`). When it is exhausted, the agent stops repeating and records a blocked or needs-context state instead of thrashing.
- **Review round checkpoints.** A task that keeps failing review is bounded separately: after five `needs_revision` rounds by default, the orchestrator must classify the cause and route one targeted revision. This is a checkpoint threshold, not a review cap.
- **Blocked states, not guesses.** When progress requires a human decision or missing context, the agent records a durable blocked state naming what it needs. The loop resumes when the blocker is cleared.
- **Verification learning.** Observed check behavior – slow suites, flaky commands, timeouts – is recorded as durable operating facts, so later tasks and sessions do not rediscover it.
- **Everything durable.** Task records, evidence, review outcomes, and decisions live in files, not chat. A run survives session death: a fresh session reads the task record and continues where the last one stopped.

The result in practice: inside an authorized work unit, the agent works autonomously for hours on a complex task – and when it finally needs you, it is because it hit a boundary that is genuinely yours to decide.

## What a run looks like

A typical files-backed run, condensed:

1. You start with a bare `/agenticloop`. The agent orients itself: it reads the project map and configured docs, reports where the project stands, and proposes the next task.
2. You approve. The maintainer creates `.agenticloop/tasks/T-014.md` with scope, out of scope, acceptance criteria, and required checks.
3. In your own terminal, outside the agent session, you run `npx agenticloop activate T-014` and confirm the exact contract and work-unit binding.
4. Guarded dispatch revalidates that binding. The engineer implements the smallest useful slice, runs the required checks fresh, and returns evidence against the dispatched artifact.
5. The maintainer verifies the return and reviews through task compliance, engineering quality, and necessity/coherence, accepting or requesting a bounded revision.
6. A separate auditor certifies the exact integrated candidate. Mechanical closeout revalidates the certificate, covered tasks, plan synchronization, and candidate before recording completion.

An implementation plan in the repository is all it needs: bare activation finds the plan, proposes the next task from it, and the loop handles it once you approve. To route directly to a known work unit instead, pass it: `/agenticloop T-014` or a one-line task description.

[docs/workflow-examples.md](docs/workflow-examples.md) walks through the full loop, including the GitHub-backed variant and review markers.

## Quick start

### Requirements

- Node.js `>=22`
- An AI coding agent host that can read project files
- OpenCode or Claude Code for the most validated path today

### Install the overlay

Run this in the root of a target project. Install from the public GitHub repository:

```text
npm install --save-dev github:bartoszarendt/agenticloop
npx agenticloop setup
```

For a one-off run without keeping a dependency:

```text
npm exec --yes --package=github:bartoszarendt/agenticloop -- agenticloop setup
```

`setup` is the recommended one-command onboarding path: it detects the
project, collects your decisions, shows one complete plan, and asks before
the first mutation. It scaffolds a fresh target or repairs a partial one,
and it is idempotent — running it twice changes nothing the second time.

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

### Inspect and validate

Inspect onboarding state any time without changing files:

```text
npx agenticloop doctor
```

Preview exactly what setup or init would do, without writing anything:

```text
npx agenticloop setup --dry-run
npx agenticloop init --dry-run
```

Then validate:

```text
npx agenticloop validate
```

Prefer a deterministic, non-guided scaffold? `agenticloop init` is the
advanced files-only path; add a host directly with
`npx agenticloop init --adapter <host>`. You can also confirm
`.agenticloop/project.md` manually (set `setup_status: confirmed` after
reviewing the backend) or ask your agent to run the `setup-agenticloop`
skill. See [docs/cli-reference.md](docs/cli-reference.md) for the full CLI
contract, including dry-run, JSON plans, and exit statuses.

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

Agentic Loop does not run automatically. You explicitly start it from the agent host when you want the agent to enter the supervised workflow. This session-level start is routing intent; it is not dispatch authority by itself.

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

### Authorize dispatch

Every shipped host can start and coordinate Agentic Loop, but none can currently
produce a cryptographically authenticated activation capture inside the agent
session. Authorize existing tasks once from your own interactive terminal:

```text
npx agenticloop activate T-014 T-015
```

The command prints the exact tasks, task-contract digests, repository, work
unit, and resulting assurance, then requires typed confirmation. It refuses CI
and non-interactive use and deliberately has no `--yes` option. Existing tasks
and projects do not need to be recreated or rewritten.

Agentic Loop reports two independent assurance dimensions:

| Dimension | Standard | Hardened |
|---|---|---|
| Activation | `operator_confirmed` | `host_signed` |
| Role return | `session_reported` | `host_receipt` |

Standard mode is usable on every shipped host, but `operator_confirmed` and
`session_reported` are not cryptographic proof of an in-session producer's
identity. Hardened mode requires a protected host integration and fails closed
without it. Repository configuration may request hardened mode but cannot lower
an operator-pinned policy. See [Host adapters](docs/host-adapters.md) and the
[CLI reference](docs/cli-reference.md) for provisioning, revocation, and status.

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

The active backend is selected in `.agenticloop/project.md`. The GitHub
backend optionally narrows task-contract trust with
`trusted_task_contract_actors`; see [backends/github.md](backends/github.md).

## What it is not

Agentic Loop is intentionally narrow. It is not:

- a deterministic autonomous controller or self-running pipeline;
- an agent runtime, SDK, or framework;
- a replacement for your existing project docs;
- a marketplace, registry, or centralized trust service;
- a telemetry collector or raw transcript store;
- a way to bypass human approval for merge, release, destructive cleanup, or locked project decisions.

The human stays at the authorization boundary. The agent handles routine workflow steps inside an authorized work unit.

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

Authorized at the boundary, autonomous inside it. The human authorizes work units and holds dispatch authority; inside one, the agent advances through guarded state transitions on its own – implement, verify, request review, revise, close out. It stops for human direction before leaving scope, merging, releasing, publishing, destructive cleanup, or changing locked decisions. The human owns the authorization boundaries; the guarded graph owns everything between them.

### Portable across hosts

One canonical Markdown source generates host-native shims for OpenCode, Claude Code, Codex, Copilot, and Cursor. You do not maintain separate workflow instructions for each host.

## CLI reference

```text
npx agenticloop init [--adapter <host>]              Scaffold overlay (files-only without --adapter)
npx agenticloop setup [--adapter <host>] [--event-logging <enabled|disabled>]
                                                       Guided onboarding: confirm setup, choose local event logging, pick adapter, configure models
npx agenticloop doctor                               Show setup checklist and adapter state; writes nothing
npx agenticloop update [--adapter <host>]            Refresh toolkit assets and existing adapter output
npx agenticloop upgrade                              Compatibility alias for update
npx agenticloop validate                             Validate skills, config, links, and host setup
npx agenticloop status                               Show configured adapters, artifacts, and next steps
npx agenticloop activate <task-id...>                Interactively authorize existing tasks for dispatch
npx agenticloop activation status                    Inspect activation authority
npx agenticloop activation revoke <grant-id>         Revoke one activation grant
npx agenticloop activation provision-key             Provision operator activation material
npx agenticloop host-trust status                    Inspect protected host trust
npx agenticloop host-trust register [options]        Register a protected host public key
npx agenticloop github-preflight --pr <number>       Verify a GitHub PR body carries final-state evidence
npx agenticloop github-ready --pr <number>           Read-only pre-merge gate: evidence preflight + review audit
npx agenticloop task-body <fetch|lint|apply|set-field|transition|establish-baseline|authorize-correction>
                                                        Guarded GitHub task-record transaction and trusted contract records
npx agenticloop commit-attribution check --task <id>  Validate prospective or HEAD commit attribution
npx agenticloop task list [--status <s>] [--json]    List files-backed task records
npx agenticloop task lint [<task-id>] [--json]       Lint task frontmatter and lifecycle state
npx agenticloop task new <title> --scaffold          Create a new task scaffold
npx agenticloop task status <id> <status>            Change task lifecycle status
npx agenticloop task prepare-decomposition [options] Bind a current ready-set decomposition
npx agenticloop task prepare-dispatch <id> [options] Revalidate authority and prepare a role handoff
npx agenticloop task verify-return <id> [options]    Verify the returned artifact and assurance
npx agenticloop audit <new|baseline|report|status|gate|lint|resolve>
                                                       Manage exact-candidate work-unit certification
npx agenticloop closeout <prepare|status|record>      Revalidate and record mechanical closeout
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

Event logging is **disabled by default** and stores only compact workflow-gate summaries, never raw transcripts. Enable it through the numbered choice in interactive setup, with `agenticloop setup --event-logging enabled`, or with `event_logging: enabled` in `.agenticloop/project.md`; see [docs/event-logging.md](docs/event-logging.md) for the event commands and audit workflow. Per-task completion summaries are always written inline into the task record's `## Scope Completed` section; there is no separate summaries directory.

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
or **auditor** as ordinary bounded subagents. Standalone delegation of either
role does not activate Agentic Loop and creates no workflow state:

- **Standalone engineer** needs no task ID or task record. Full Agentic Loop
  engineer mode is selected only by explicit activation or a named durable task
  record.
- **Standalone auditor** is read-only and needs no task ID, audit ID, audit
  record, or audit packet. It returns concise, evidence-backed, explicitly
  non-certifying findings: it issues no Agentic Loop audit verdict and does not
  satisfy the formal work-unit audit gate. Full Agentic Loop auditor mode is
  selected only by explicit activation, or by an explicit request to certify or
  re-audit a tracked work unit against an Agentic Loop audit record or packet -
  and work-unit certification always requires a fresh, packet-bound Auditor
  invocation.

See [`AGENTIC_LOOP.md`](AGENTIC_LOOP.md), [`agents/engineer.md`](agents/engineer.md),
and [`agents/auditor.md`](agents/auditor.md).

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
| [docs/cli-reference.md](docs/cli-reference.md) | CLI contract: commands, dry-run, JSON plans, exit statuses, capabilities. |
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

Version 0.4.5. The guarded workflow graph, files and GitHub backends, Node CLI, validation, overlay management, universal operator-confirmed activation, cross-platform execution evidence, protected return-receipt replay, handoff preflight across both backends, bounded derived-evidence refresh, atomic files-backed readiness planning and apply, standard assurance path, and all five host adapters (OpenCode, Claude Code, Codex, Copilot, and Cursor) are supported and ready for use. Hardened host-signed activation and host-receipted returns require a protected host integration; no shipped adapter currently provides that boundary.

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

The CLI is written in JavaScript as ES modules and targets Node.js `>=22`.

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
