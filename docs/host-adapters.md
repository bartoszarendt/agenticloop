# Host Adapters

Agentic Loop is host-neutral. The canonical role, skill, and backend source stays
in `agenticloop/agents/`, `agenticloop/skills/`, and `agenticloop/backends/`. A host adapter renders that source
into host-native artifacts (for example `.opencode/agents/*.md`,
`.codex/agents/*.toml`, `.claude/agents/*.md` plus
`.claude/settings.local.json` by default, `.github/agents/*.agent.md`, or
`.cursor/agents/*.md`).

Host-native output is generated shim material. The shim directories are not the
source of truth.

Adapters are status-bearing in `agenticloop.json` so downstream projects can
see what is supported and what is reserved.

Agentic Loop-owned adapter settings use strict JSON (`agenticloop.json` and
`agenticloop/config.json`).

## Setup

Use `npx agenticloop setup` for guided adapter selection and model
configuration. Use `npx agenticloop doctor` to inspect adapter state without
mutating files. For manual setup, use `npx agenticloop init --adapter <host>`
followed by `npx agenticloop configure models --adapter <host>`.

The interactive model picker offers catalog models, custom model IDs, keep
current, skip, and cancel options. Custom model IDs are first-class for
private deployments, local providers, and preview models. When configuring
interactively, Agentic Loop tries host-native model discovery where a safe
noninteractive list command exists:

- OpenCode: `opencode models` lists provider/model identifiers.
- Cursor: `agent models` lists `id - label` entries for the current account.
- Codex: `codex debug models` prints JSON model metadata.

Claude Code and Copilot do not have a safe noninteractive model-list command,
so their interactive pickers use the bundled catalog and custom entry only.

Discovery is best-effort and non-fatal. If a command is missing or fails, the
picker falls back silently to the bundled catalog. Override the discovery
command via environment variables `AGENTICLOOP_OPENCODE_COMMAND`,
`AGENTICLOOP_CURSOR_COMMAND`, or `AGENTICLOOP_CODEX_COMMAND`.

The bundled catalog is a convenience fallback with source and freshness
metadata; it may become stale and is never treated as a complete current
source of truth.

## Non-Interactive Git Environment

Launch Agentic Loop host sessions with Git editor, pager, and terminal prompts
neutralized so unattended lanes fail or accept prepared messages instead of
hanging on VS Code, Vim, a pager, or credential input. Include GitHub CLI prompt
guards when the project uses the GitHub backend:

```powershell
$env:GIT_EDITOR = 'true'
$env:GIT_SEQUENCE_EDITOR = 'true'
$env:GIT_PAGER = 'cat'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GH_EDITOR = 'true'
$env:GH_PAGER = 'cat'
$env:GH_PROMPT_DISABLED = '1'
```

The same values can be set in Bash with `export`. These environment variables
override the user's global Git and GitHub CLI editor and pager only for the
launched session. Agents should still use explicit-message, file-backed, and
no-pager commands, but the environment is the backstop when a conflict
continuation, PR command, or read command would otherwise open an interactive
surface.

Use `npx agenticloop worktree add <task-id> <branch> [--from <ref>]` for
delegated write lanes. It creates `.agenticloop/worktrees/<task-id>`, ignores the
worktree parent through `.git/info/exclude`, and writes worktree-scoped Git guard
config. Use `npx agenticloop worktree guard --fix --all` to repair existing
Agentic Loop worktrees, `npx agenticloop worktree list` to inspect all registered
worktrees, and `npx agenticloop doctor` to report missing guards.

Worktrees have a lifecycle. After a task is accepted and integrated, run
`npx agenticloop worktree cleanup --dry-run` to preview which standard
`.agenticloop/worktrees/*` lanes are safe to remove. Cleanup is destructive
filesystem cleanup and requires `--dry-run` first, then `--yes`. It keeps open
pull requests, locked worktrees, worktrees with blocking dirty source or shared
`.agenticloop` state, external or detached worktrees, and lanes with active task
state. Task-specific lane-local `.agenticloop` state is flat only (`logs`,
`tasks`, `summaries`, and `decisions` files directly under `.agenticloop/<dir>/`);
it is preserved before removal and does not by itself block cleanup. Nested or
shared `.agenticloop` files are not lane-local and dirty shared state blocks
cleanup. Git worktree removal may be forced internally only after preservation
succeeds. For `.jsonl` lane-local files, preservation is safe when the root file
already contains every lane line (a root superset). If lane-local preservation
conflicts with existing root state, use `npx agenticloop worktree resolve-state
<task-id|path> --strategy <prefer-root|prefer-worktree|union-jsonl> --yes`
(default `--dry-run`) to resolve before cleanup: `prefer-root` copies the root
file into the lane, `prefer-worktree` copies the lane file into the root, and
`union-jsonl` computes a root-first max-count multiset union and writes the
result to both files. resolve-state never removes worktrees or branches. Shared `.agenticloop` files are not preserved.
Project-root bare coordinator repos are supported. Branch deletion is not part
of v1 cleanup. External or detached worktrees require explicit review and are
never bulk-removed. Use `npx agenticloop worktree remove <task-id|path> --yes`
for single-worktree removal with lane-local state preservation, or
`npx agenticloop worktree prune --dry-run` to inspect stale Git registrations.

| Host | Status | Adapter output | Generation command |
|---|---|---|---|
| OpenCode | supported | `.opencode/agents/*.md` plus `.opencode/commands/agenticloop.md` | `agenticloop generate opencode` |
| Codex | supported | `.codex/agents/*.toml`, `.agents/skills/agenticloop/SKILL.md`, `.agents/skills/agenticloop/agents/openai.yaml`, `.agents/skills/agenticloop/references/skills/<name>/reference.md`, optional `plugins/agenticloop/.codex-plugin/plugin.json` | `agenticloop generate codex` |
| Claude Code | supported | Mode A: tracked root `.claude-plugin/` packaging (activation command and role agents, with no copied plugin skill payloads). Mode B: generated `.claude/commands/agenticloop.md`, `.claude/agents/*.md`, one public `.claude/skills/agenticloop/SKILL.md` with internal `references/skills/<name>/reference.md`, and `.claude/settings.local.json` by default | `agenticloop generate claude-code` (Mode B) |
| Copilot | supported | `.github/agents/*.agent.md`, one public `.github/skills/agenticloop/SKILL.md` with internal `references/skills/<name>/reference.md`, `.github/skills/agenticloop/references/backends/*.md`, and `.github/prompts/agenticloop.prompt.md` | `agenticloop generate copilot` |
| Cursor | supported | `.cursor/agents/*.md`, one public `.cursor/skills/agenticloop/SKILL.md` with internal `references/skills/<name>/reference.md` and backend references under `.cursor/skills/agenticloop/references/backends/*.md` | `agenticloop generate cursor` |

## Unified Host-Skill Surface

Agentic Loop keeps many canonical skills as the source of truth, but it exposes
them to hosts as a single public activation skill plus internal procedure
references:

- Canonical source: `agenticloop/skills/<name>/SKILL.md` (multiple skills, never edited by
  adapters).
- Generated public surface: exactly one discoverable `agenticloop/SKILL.md` per
  host that renders generated skills (Codex, Claude Code Mode B, Copilot, and
  Cursor).
- Internal procedures: `references/skills/<name>/reference.md` copies of each
  canonical skill. They are renamed from `SKILL.md` to `reference.md` so the
  host skill picker does not treat every internal procedure as a separate public
  skill. No discoverable `SKILL.md` files exist under `references/`.

This keeps a single clean entry point in each generated skill surface while
still shipping the full procedure set. OpenCode and Claude Code Mode A are
command-first and do not render a generated skill surface: their prompts point
at the canonical `agenticloop/skills/<name>/SKILL.md` files by explicit path instead.

`.agents/skills` is a shared agent-skills location used by Codex (and visible to
OpenCode in the same target), so it must not contain per-procedure Agentic Loop
skills. Only the single public `.agents/skills/agenticloop/SKILL.md` is
discoverable there; everything else lives under its `references/`. OpenCode's
supported Agentic Loop entry point remains `/agenticloop`.

`.github/skills` is a shared Copilot customization location, so the Copilot
adapter also keeps exactly one public `.github/skills/agenticloop/SKILL.md`
skill. Internal procedures live under `.github/skills/agenticloop/references/`
as `reference.md` copies instead of separate public skills.

`.cursor/skills` is a shared Cursor customization location, so the Cursor
adapter also keeps exactly one public `.cursor/skills/agenticloop/SKILL.md`
skill. Internal procedures live under `.cursor/skills/agenticloop/references/`
as `reference.md` copies instead of separate public skills. The Cursor MVP does
not generate `.cursor/rules/` or always-on hooks by default.

## Adapter Status

The `adapters.<host>.status` field in `agenticloop/config.json` is the durable
record of how much an adapter is trusted.

- `supported` - implemented, documented, and covered by automated generation and validation.
- `placeholder` - reserved name with no generator yet. Avoid referencing it in
  target-owned config until the generator exists.

Ordinary automated tests, validation commands, and packaging checks remain
release requirements for all supported adapters.

## Loop-Guard Capabilities

Prompt-level liveness rules reduce loop risk, but host runtime controls are the
model-independent guard. Prefer host adapters and operating modes that can
surface running role status, stream subagent output, cancel a runaway role, and
enforce max steps, max tokens, or timeout limits.

When a host cannot provide cancellation or running-subagent status, treat
long-running parallel delegation as unsupported. Short bounded parallel batches
may still run on such a host when every lane has a clear expected artifact, a
stop condition, an observable-step lease, a no-progress budget, and a join
condition. If even bounded join-based parallelism is unverifiable, use bounded
serial delegation instead, and require each role prompt to include an
observable-step checkpoint cadence, no-progress budget, and status-return stop
condition.

## Concurrency Guidance

Serial execution is the default safety floor, not a preference. For an authorized
multi-task unit with 2 or more ready task records, the orchestrator performs a
Parallel Opportunity Scan before defaulting to serial (see
`agenticloop/AGENTIC_LOOP.md`). Bounded eligible batches may use up to 3
implementation lanes by default; choosing serial after eligible candidates exist
requires a recorded concrete reason. Long-running parallelism carries stronger
observability requirements (live status/cancellation or strict bounded leases)
than short bounded join-based batches.

## Per-Host Role Settings

Model identifiers and aliases are host/provider specific. They do not live in
the portable role files under `agenticloop/agents/`. Use
`adapters.<host>.roleSettings.<role>.model` to express the same logical role
with a different concrete model on each host. OpenCode and Codex also support
`adapters.<host>.roleSettings.<role>.reasoningEffort`; Claude Code supports
`model` and `permissionMode` there; Copilot and Cursor currently support
`model` only.
Codex supports `minimal`, `low`, `medium`, `high`, and `xhigh` for
`reasoningEffort`.

Adapter-local role settings are the supported configuration surface. The
shared resolver still tolerates older configs that put model fields under
`roles.<role>`, but new target configs should not do that. Logical roles stay
host-neutral; concrete model choices live under the host adapter.

## Generation Commands

```text
npx agenticloop generate opencode     # .opencode/agents/*.md plus .opencode/commands/agenticloop.md
npx agenticloop generate codex        # directory of artifacts
npx agenticloop generate claude-code  # directory of artifacts
npx agenticloop generate copilot      # .github/agents/*.agent.md plus .github/skills/agenticloop/ and .github/prompts/agenticloop.prompt.md
npx agenticloop generate cursor       # .cursor/agents/*.md plus .cursor/skills/agenticloop/
npx agenticloop generate all          # every implemented adapter
```

Each command accepts:

- `--target <dir>` - directory containing `agenticloop.json` (default: cwd)
- `--output-dir <dir>` - output directory

`generate all` writes every adapter that has a generator in this package.
Use a single-host generation command when you only want one host's artifacts
in a target project.

For package upgrades, `npx agenticloop update` refreshes toolkit-owned copied
assets and refreshes adapter output that already exists. For OpenCode, that
means regenerating the repo-local `.opencode/agents/*.md` files and
`.opencode/commands/agenticloop.md`. User-owned `opencode.jsonc` is ignored.
Use `npx agenticloop update --adapter <host>` to generate or refresh one
specific host. Use `npx agenticloop update --adapter all` to generate or refresh every
implemented adapter artifact.
`agenticloop upgrade` is a compatibility alias for `agenticloop update`.

## OpenCode Activation

OpenCode is explicitly activated by command. After generating the adapter, run
`/agenticloop [task-id or task description]` from the target project root.
Normal OpenCode prompts stay outside Agentic Loop mode until that command is
invoked.

## Codex Activation

Codex MVP support is repo-local and skill-first.

- Generate the adapter, then start Agentic Loop in Codex with
  `$agenticloop [task-id or task description]`.
- The same public skill also appears in `/skills` as `Agentic Loop`.
- Codex does not use a repo-local `/agenticloop` slash command for this
  adapter. Deprecated custom prompts can create personal slash commands under
  `~/.codex/prompts`, but they are user-local and are not the target-project
  contract.
- Codex exposes one clean public skill surface at `.agents/skills/agenticloop/`.
  Internal Agentic Loop procedures are packaged under `references/skills/` so
  the normal Codex skill picker stays clean.
- The main Codex session stays the coordinator/orchestrator. Role work is routed
  through the generated custom agents under `.codex/agents/`, especially
  `maintainer` and `engineer`.
- Optional plugin distribution is separate from repo-local use. Set
  `adapters.codex.plugin.enabled: true` only when you intentionally want
  generated `plugins/agenticloop/` packaging plus
  `.agents/plugins/marketplace.json`.

## Claude Code Modes

Claude Code has two distinct install paths:

- Mode A plugin packaging lives at the toolkit root in `.claude-plugin/`. Its
  public surface is the activation command (`agenticloop/commands/start.md`, invoked as
  `/agenticloop:start`) and the canonical role agents under `agenticloop/agents/`. It does
  not copy canonical skills into `.claude-plugin/`, and it does not register
  every canonical `agenticloop/skills/` entry as a separate public plugin skill.
- Mode B is the repo-local adapter generated by `agenticloop generate
  claude-code`, which emits `.claude/commands/agenticloop.md`,
  `.claude/agents/`, one public `.claude/skills/agenticloop/SKILL.md` with
  internal `references/skills/<name>/reference.md` procedure copies, and
  `.claude/settings.local.json` into the target project by default.

Mode B defaults maintainer and engineer subagents to
`permissionMode: acceptEdits` so edit auto-accept is scoped to Agentic Loop
worker subagents rather than the whole repository. It also writes the built-in
`agenticloop` permissions profile to `.claude/settings.local.json` by default.
That profile is intentionally broad enough for normal Agentic Loop work,
including common `git`, `gh`, `npm`, `npx`, `pytest`, `ruff`, and `alembic`
commands for both Bash and PowerShell. The local settings file is recommended
because the broader rules stay machine-local and are normally untracked.

Teams that intentionally want shared Claude Code settings may set
`adapters.claude-code.permissions.scope: "project"`, which writes
`.claude/settings.json` instead. Agentic Loop does not set project-wide
`permissions.defaultMode` unless the target explicitly configures
`adapters.claude-code.permissions.defaultMode`.

Claude Code is explicitly activated by command: use `/agenticloop:start` for
Mode A and `/agenticloop` for Mode B. It does not rely on hooks or a managed
`CLAUDE.md` block.

Mode B detection keys on `.claude/agents/`. Validation expects the repo-local
command at `.claude/commands/agenticloop.md` plus the generated skill namespace
when Claude Code adapter output is present. A root `.claude-plugin/` directory
is Mode A packaging, not repo-local adapter output.

Before refresh, update inspects existing adapter output for model choices and
backfills any missing values into
`agenticloop.json` under `adapters.<host>.roleSettings.<role>`. This preserves
target-local model choices from:

- `.opencode/agents/*.md` frontmatter `model` and `variant`
- `.codex/agents/*.toml` `model` and `model_reasoning_effort`
- `.claude/agents/*.md` frontmatter `model`
- `.github/agents/*.agent.md` frontmatter `model`
- `.cursor/agents/*.md` frontmatter `model`

Explicit values already present in `agenticloop.json` are not overwritten.
New model edits should still be made in `agenticloop.json` or with
`agenticloop configure models`.
Claude Code `permissionMode` is generated from adapter config defaults and is
not backfilled from generated `.claude/agents/*.md` files.

## Copilot Activation

Copilot support is repo-local.

- Generate the adapter, then activate Agentic Loop in Copilot CLI with
  `/agenticloop [task-id or task description]`.
- The generated public skill at `.github/skills/agenticloop/SKILL.md` is the
  Copilot CLI slash surface. It is `user-invocable: true` and
  `disable-model-invocation: true`, so Agentic Loop stays explicit and does not
  auto-trigger during ordinary Copilot work.
- In Copilot IDE surfaces that support `.github/prompts/*.prompt.md`, use the
  generated `agenticloop` prompt file as the IDE prompt-file fallback. That
  prompt binds activation to the generated Copilot custom agent for the
  orchestrator role.
- Generated Copilot custom agents live under `.github/agents/*.agent.md` and are
  rendered from canonical `agenticloop/agents/*.md` plus Copilot-specific delegation wiring.
  The orchestrator is the user-selectable entry agent; maintainer and engineer
  are generated as subagent-only workers.
- Generated Copilot skills live under `.github/skills/agenticloop/` as one public
  `SKILL.md` plus internal `reference.md` procedure copies and backend
  references.
- `.github/copilot-instructions.md` is intentionally not generated. Treat it, and
  any `.github/instructions/*.instructions.md` files, as user or team-owned
  customization surfaces.
- `generate all` includes Copilot because it is implemented.

## Cursor Activation

Cursor support is repo-local.

- Generate the adapter, then invoke `/agenticloop` in Cursor Agent chat.
- Cursor exposes one clean public skill surface at
  `.cursor/skills/agenticloop/`.
- Generated Cursor subagents live under `.cursor/agents/*.md` and are rendered
  from canonical `agenticloop/agents/*.md` plus Cursor-specific delegation and
  boundary wiring.
- The active Cursor session stays the coordinator/orchestrator. Maintainer and
  engineer role work is delegated through the generated Cursor subagents where
  supported.
- The Cursor MVP does not generate `.cursor/rules/` or session hooks. Activation
  stays explicit.

## Validation

`npx agenticloop validate` is adapter-aware. It validates an adapter's
output only when:

- the adapter output file or directory is present, OR
- the adapter is marked `enabled: true` or `required: true`, OR
- the user passes `--adapter <host>` to force validation.

This means a target project can use a subset of adapters without seeing
errors for the rest. It also means neither a tracked root `opencode.jsonc` nor
generated `.opencode/` output is required just because `adapters.opencode`
exists in the base config.

Additional validations:

- Generated OpenCode artifacts are checked for a `Generated by Agentic Loop`
  banner. Missing banners produce a warning.
- Files-backend task records that claim an agent opened a PR or merged a branch
  produce an error. PR/merge behavior requires `task_backend: github`.
- Task files under `.agenticloop/` are scanned for dotted toolkit path
  references (e.g. `.agenticloop/agents/`). Those paths are invalid;
  canonical toolkit assets live under `agenticloop/` (no dot).

## Project-Skill Collision Safety

Agentic Loop keeps generated skills distinct from target-owned project skills,
but the mechanism is host-specific:

- Codex repo-local activation uses one discoverable public skill at
  `.agents/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.agents/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.
- Claude Code repo-local activation uses one discoverable public skill at
  `.claude/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.claude/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.
- Copilot repo-local activation uses one discoverable public skill at
  `.github/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.github/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.
- Cursor repo-local activation uses one discoverable public skill at
  `.cursor/skills/agenticloop/SKILL.md`. Internal procedures live under
  `.cursor/skills/agenticloop/references/skills/` as `reference.md` files, not
  discoverable `SKILL.md` copies.

Collision rule:

- target-owned project skills outside the Codex `.agents/skills/agenticloop/`
  directory, outside the Claude Code `agenticloop/` generated subdirectory, and
  outside the Copilot `.github/skills/agenticloop/` generated subdirectory are
  left alone
- generated Codex `agenticloop/` files, stale legacy Codex `agenticloop-*`
  directories, Claude Code files inside `.claude/skills/agenticloop/`, and
  Copilot files inside `.github/skills/agenticloop/`,
  `.github/prompts/agenticloop.prompt.md`, and generated
  `.github/agents/*.agent.md`, plus Cursor files inside
  `.cursor/skills/agenticloop/` and generated `.cursor/agents/*.md`, are
  treated as generated output and may be
  regenerated

## Registry and Marketplace

A registry, marketplace, or package index is not an active target. See
[docs/registry-horizon.md](registry-horizon.md) for the deferral decision and
evidence gates.

## Why Generated Output Lives Outside `.agenticloop/tmp/`

`.agenticloop/tmp/` is the toolkit's verification scratch area. For target projects,
generated host artifacts should live at the host's expected location
(`.opencode/`, `.codex/`, `.claude/`, `.github/`, `.cursor/`, etc.) so
the host can discover them without extra configuration.

For toolkit-level verification, generate into a throwaway directory under
`.agenticloop/tmp/` so the artifacts do not collide with downstream target
generation paths.
