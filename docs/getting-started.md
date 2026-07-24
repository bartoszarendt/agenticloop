# Getting Started

Agentic Loop is a Markdown-first workflow toolkit. You can use the core loop
without installing a runtime: give your agent the repository rules, the
methodology, and the relevant skills.

The default task backend is files. No GitHub account, repository, or labels are
required for normal operation. GitHub coordination is an explicit opt-in: an
existing GitHub remote, CI workflows, or issue templates never opt a project
into the GitHub task backend on their own.

## Quick Start

Run in an existing project directory:

```text
npx agenticloop init
```

This creates:

```text
agenticloop/                   toolkit-owned canonical source
.agenticloop/project.md        project map (starts with an unconfirmed human-controlled stage; implementation-lane ceiling, backend, naming, grouping, typed docs, optional evidence notes)
.agenticloop/decisions/        decision records
.agenticloop/improvements/     improvement proposals (created on first proposal)
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
whether to enable local event logging, select a host adapter, configure role
models, and generate artifacts in one pass. It is resumable and safe to
rerun.

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
`--adapter all` to generate artifacts for every supported host adapter.

Fresh Codex setup writes this opinionated target-owned cost/quality profile:

| Role | Model | Reasoning effort |
|---|---|---|
| orchestrator | `gpt-5.6-luna` | `xhigh` |
| maintainer | `gpt-5.6-terra` | `xhigh` |
| engineer | `gpt-5.6-terra` | `high` |
| auditor | `gpt-5.6-sol` | `high` |

Explicit `agenticloop.json` values override these defaults. To adopt only
missing fields in an existing Codex installation, run:

```text
npx agenticloop configure models --adapter codex --profile recommended
```

The profile reports added fields and preserved explicit fields, and does not
regenerate artifacts. Run `npx agenticloop generate codex` afterward when needed.

For Claude Code, `init --adapter claude-code` is the repo-local Mode B adapter:
it generates `.claude/commands/agenticloop.md`, `.claude/agents/`, and one public
`.claude/skills/agenticloop/SKILL.md` with internal
`references/skills/<name>/reference.md` procedure copies, plus
`.claude/settings.local.json` by default.
That local settings file is gitignored automatically. If you want one shared
Claude Code install across many target projects, use the separate root plugin
packaging flow in [docs/claude-code-setup.md](claude-code-setup.md).

For Copilot, `init --adapter copilot` generates
`.github/agents/*.agent.md`, one public `.github/skills/agenticloop/SKILL.md`
with internal `references/skills/<name>/reference.md` procedure copies and
backend references, plus `.github/prompts/agenticloop.prompt.md` for Copilot
IDE prompt-file surfaces. In Copilot CLI, activation is explicit with
`/agenticloop`. It does not generate `.github/copilot-instructions.md`.

For Cursor, `init --adapter cursor` generates
`.cursor/agents/*.md` plus one public `.cursor/skills/agenticloop/SKILL.md`
with internal `references/skills/<name>/reference.md` procedure copies and
backend references. Activation is explicit with `/agenticloop`. It does not
generate `.cursor/rules/` by default.

To refresh an existing overlay after upgrading the package:

```text
npx agenticloop update
```

`init` and `setup` also install one clearly marked, manifest-owned
activation-guidance block into your repository-rules document (resolved as the
explicit `documents.rules` selection, else the first existing `AGENTS.md` /
`CLAUDE.md` / `GEMINI.md`, else a newly created `AGENTS.md`). Installing Agentic
Loop does not activate the methodology; the block just states that boundary.
Opt out with `--no-agents-guidance`, inspect with `agenticloop guidance check`,
and remove with `agenticloop guidance remove`. Only the region between the
markers and separators inserted with it is owned; the rest of the file stays
target-owned byte-for-byte. `guidance remove --force` removes only an edited
managed region, never surrounding target content. If the configured rules path
changes, check reports the existing owned path and update does not add a second
block.

`update` preserves target-owned `.agenticloop/project.md`, task records,
summaries, decisions, logs, and `.agenticloop/tmp/`, leaves existing
`agenticloop.json` alone, refreshes adapter output that already exists, and
refreshes an activation-guidance block it already owns (without enrolling an
installation that has none or overwriting a modified block). For OpenCode,
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

Removal is transactional. If final quarantine cleanup cannot complete after a
successful removal, the command reports the cleanup error without restoring
already committed output and leaves its `.agenticloop-remove-*` journal in the
target root. Remove that journal only after confirming the committed removal is
the intended final state.

If rollback itself cannot restore every path, the command reports that rollback
is incomplete and retains the quarantine journal instead of deleting recovery
data. Its `transaction.json` maps original target paths to the remaining backup
files. Resolve the reported filesystem obstruction and recover those paths from
the journal before removing it; an incomplete rollback is not a completed
removal.

## Stop the Loop

Use `stop` as the exact activation argument to deactivate Agentic Loop for this
conversation: `/agenticloop stop` in OpenCode, Claude Code repo-local, Copilot
CLI, and Cursor; `$agenticloop stop` in Codex; and `/agenticloop:stop` in the
Claude Code plugin. Stop safely checkpoints unfinished work without changing its
status merely because the user stopped, and does not commit, push, close tasks,
merge, or clean up worktrees. Resume with the normal host activation command and
a task or context argument. It is separate from host exit, host terminal stop,
task closeout, and worktree cleanup; see [Host Adapters](host-adapters.md#stop-agentic-loop).

## Adoption Modes

Agentic Loop supports two adoption paths.

### New project or template mode

Use this when starting a project from scratch or when the target project does
not yet have its own `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, or architecture
docs.

Run `npx agenticloop init`. The generated `.agenticloop/project.md` starts with
`setup_status: unconfirmed` and `development_stage: unconfirmed`.

Before the first non-trivial task, either:

- ask the agent to run or route `setup-agenticloop`, or
- manually confirm the defaults by updating the setup fields in `.agenticloop/project.md` after reviewing the backend choice and selecting one human-confirmed development stage.

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

When upgrading a project whose map is already confirmed but has no
`development_stage`, validation intentionally stops normal task work. Run
`npx agenticloop setup` interactively and confirm the one-time stage migration.
The migration preserves the existing project-map body and does not silently
change document selections, backend, naming, or grouping values. A missing
`max_parallel_implementation_lanes` field inherits the default `5` ceiling.

## Configuration

### Files-first (default)

`.agenticloop/project.md` is the primary project configuration. Edit its
frontmatter to record setup confirmation, a human-confirmed development stage,
implementation-lane ceiling, typed document selections, task ID pattern, backend
choice, optional grouping, or optional process planning
conventions:

```yaml
---
setup_status: unconfirmed
setup_confirmed_at: ""
setup_confirmed_by: ""
development_stage: unconfirmed
max_parallel_implementation_lanes: 5
task_backend: files
task_id_pattern: "T-<number>"
task_id_regex: "^T-\\d{3,}$"
task_file_template: ".agenticloop/tasks/{taskId}.md"
grouping_profile: flat
# engineer_context_window_tokens: 256000
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
`setup_status: confirmed` requires a human-confirmed `development_stage` of
`greenfield`, `expansion`, `stabilization`, or `maintenance`; it means the
document selections, task naming, grouping, backend choice, and stage have been
reviewed for this target project. Setup can propose a stage from bounded evidence
but cannot persist it before human confirmation. A later stage transition uses a
repeat interactive profile update and also requires human confirmation.

`max_parallel_implementation_lanes` defaults to `5`. It is a ceiling only for
otherwise eligible implementation lanes, not a total live-agent budget or a
target; review, coordination, and integration lanes use their own rules.

`backend_confirmed_at`, `backend_confirmed_by`, and `backend_evidence_summary`
are optional frontmatter notes for the bounded backend-evidence review.

Setup asks for the task backend with a numbered choice:

```text
Task backend:
  1. Files - local task records (default)
  2. GitHub - issues, labels, comments, and PR coordination
Choice [1]:
```

Blank input keeps the files default for a new installation, and the same
selector is offered during the interactive profile update for confirmed
projects, where blank input keeps the existing backend. GitHub hosting
evidence (a GitHub remote, existing CI workflows, issue templates) is shown
as informational evidence only and never selects the GitHub backend by itself;
GitHub task coordination always requires the explicit `2` selection.

Event logging is local, optional, and disabled by default
(`event_logging: disabled`). It is independent of the task backend: enabling
local event logging does not select the GitHub backend, and choosing the
GitHub backend does not enable event logging.

Interactive setup asks with a numbered choice:

```text
Event logging:
  1. Disabled - do not record workflow events (default)
  2. Enabled - write local task-scoped JSONL logs under .agenticloop/logs/
Choice [1]:
```

Blank input selects disabled for a new installation and retains the current
setting when setup is rerun. Automated setup can pass
`--event-logging enabled` or `--event-logging disabled`; when the option is
omitted in non-interactive mode, setup retains the current setting. This choice
does not create a log file immediately and does not change
`event_logging_command`.

`engineer_context_window_tokens` is optional. Set it only when the engineer
model's active context window is known and task sizing should use that value
instead of the generic examples in Agentic Loop.

### Verification operating facts

The project-map body also holds `## Verification Operating Facts`: maintainer-
owned, current cross-task facts such as a known host timeout for `npm test` and
the reversible strategy to use instead. They are not routine test history or
decision records. Exceptional per-task runs belong in `## Verification Attempts`
in the task record; a timed-out foreground run must be recorded before a retry or
handoff. Routine first-pass success stays in current final-state evidence. See
`agenticloop/skills/verification-evidence/SKILL.md` for the canonical entry and
one bounded-escalation rule.

### Project operating facts

The project-map body also holds `## Project Operating Facts`: the maintainer-
owned profile for current, mutable, non-binding project-wide operating knowledge.
Each fact is one compact bullet with a stable `PF-...` identifier, a durable
source reference, and a "Revisit when" trigger. Detailed workflows still live in
normal project documentation; a fact provides a compact current fact or a pointer
to that documentation. Binding conventions and policies route to decision records
instead, and fact capture is optional and non-blocking.

New installations receive the empty section from the scaffold. Existing
`.agenticloop/project.md` files are target-owned and are never overwritten;
`agenticloop init`, refresh, and ordinary update do not rewrite the project map,
so an existing project without the section stays valid and a maintainer can add
the section on the first approved capture. See the Project Operating Facts section
in `agenticloop/AGENTIC_LOOP.md` for the recognition test and routing ladder.

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

Do not put model IDs, provider names, or reasoning effort settings in
`.agenticloop/project.md`; those belong in `agenticloop.json` under
`adapters.<host>.roleSettings`.

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
   setup shows it as informational evidence only; the files backend stays the
   default. Select GitHub explicitly in the numbered backend prompt if the
   project wants GitHub coordination.
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
Use Agentic Loop. Read .agenticloop/project.md for development_stage,
max_parallel_implementation_lanes, task_backend, task naming, grouping rules,
and typed document selections. If setup_status is unconfirmed or the stage is
not human-confirmed, route setup-agenticloop or confirm the profile before
selecting the first task. Then identify the next task and create the task record before
implementation.
```

## How Roles Work

Roles live in `agenticloop/agents/`. They define who does what:

- `orchestrator` coordinates the loop
- `maintainer` owns task records, review, acceptance, and closeout
- `engineer` implements one scoped task record at a time
- `auditor` certifies a finished work unit against its exact integrated baseline

Host adapters bind their native agent, mode, command, or prompt mechanism to
these role files.

Auditor has its own model slot at `adapters.<host>.roleSettings.auditor`. The
maintainer model is never silently reused for it, because the audit exists to be
independent of the authority that accepted the work.

## Work-Unit Audit

Work-unit audit is enabled by default, including when `.agenticloop/project.md`
omits the key:

```yaml
work_unit_audit: enabled
```

With it enabled, work-unit closeout cannot publish
`AGENT_CLOSEOUT_STATUS: complete` without a current audit certificate for the
exact work unit. Certificates live under `.agenticloop/audits/<AUD-ID>.md` and
are target-owned certification state, not task records.

Typical cycle:

```text
npx agenticloop audit new --work-unit phase:4 \
  --covered-tasks T-041,T-042 --artifact commit:abc123 \
  --goal "<outcome and source>" \
  --completion-oracle "<observable completion>" \
  --evidence "<integrated evidence for commit:abc123>"
npx agenticloop audit report AUD-001 --verdict needs_remediation \
  --invocation-mode host_subagent --invocation-ref <unique-ref> \
  --assessment "<one paragraph>" --evidence "<checks run>" \
  --finding-json '<json array>'
# remediation runs as ordinary tasks, then:
npx agenticloop audit baseline AUD-001 --artifact commit:def456 \
  --covered-tasks T-041,T-042,T-055 \
  --evidence "<integrated evidence for commit:def456>"
npx agenticloop audit report AUD-001 --verdict certified \
  --invocation-mode explicit_agent_invocation --invocation-ref <new-ref> ...
npx agenticloop audit gate AUD-001
```

`audit status` remains available for diagnostics. `audit gate` is the
fail-closed closeout check. A `needs_human_decision` verdict requires a separate
recorded resolution before another Auditor report:

```text
npx agenticloop audit resolve AUD-001 \
  --authority "human: <identity>" --note "<decision and direction>"
```

`audit_budget` defaults to 5 and is separate from the default-3 `attempt_budget`
and `review_budget`. After five non-certifying reports the record blocks for
human direction; a sixth requires
`npx agenticloop audit override AUD-001 --budget <n> --authority "human: <identity>"`.

To opt out, a human sets `work_unit_audit: disabled` in
`.agenticloop/project.md`. That bypasses the gate, preserves any audit history,
and never claims the work unit is certified. Re-enabling restores the gate and
again requires a current certificate.

The full procedure lives in `agenticloop/skills/work-unit-audit/SKILL.md`.

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
- work-unit certification: `work-unit-audit`
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
- [Codex setup](codex-setup.md) - supported.
- [Claude Code setup](claude-code-setup.md) - supported.
- [Copilot setup](copilot-setup.md) - supported.
- [Cursor setup](cursor-setup.md) - supported.
