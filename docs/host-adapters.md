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

Fresh Codex setup writes an opinionated target-owned profile: `gpt-5.6-luna`
with `xhigh` for orchestrator, `gpt-5.6-terra` with `xhigh` for maintainer,
`gpt-5.6-terra` with `high` for engineer, and `gpt-5.6-sol` with `high` for
auditor. These are setup defaults, not canonical role contracts. Auditor always
gets its own explicit slot; the maintainer model is never silently copied into
it, because the audit exists to be independent of the authority that accepted the
work. Existing explicit fields remain untouched; apply the
same missing-only profile deliberately with:

```text
npx agenticloop configure models --adapter codex --profile recommended
```

The command reports added and preserved fields and does not regenerate output.

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

## Stop Agentic Loop

`stop` is an exact activation argument that deactivates Agentic Loop in the
current conversation and safely checkpoints unfinished work. It is not task
closeout, worktree cleanup, host exit, or a request to terminate a host process.

| Host | Stop invocation | Resume invocation |
|---|---|---|
| OpenCode | `/agenticloop stop` | `/agenticloop <task or context>` |
| Claude Code repo-local | `/agenticloop stop` | `/agenticloop <task or context>` |
| Claude Code plugin | `/agenticloop:stop` | `/agenticloop:start <task or context>` |
| Codex | `$agenticloop stop` | `$agenticloop <task or context>` |
| Copilot CLI | `/agenticloop stop` | `/agenticloop <task or context>` |
| Cursor | `/agenticloop stop` | `/agenticloop <task or context>` |

The stop contract first stops new Agentic Loop work and new role spawning, then
inspects active subagents, background work, and worktree lanes. It uses safe
host interruption controls when available and otherwise reports still-running
activity without waiting indefinitely. When progress is not durable, it appends
a concise dated checkpoint to the active task record but keeps the task status
unchanged unless an independent blocker exists. A voluntary stop is neither
`blocked` nor `needs_context`.

Stop never automatically accepts, closes, commits, pushes, merges, deletes a
branch, or removes a worktree. Codex `/stop` is a separate built-in control for
background terminals, and `/exit` or `/quit` exits the host rather than Agentic
Loop. Use the dedicated task closeout and worktree cleanup commands only when
their normal authorization rules are satisfied.

## Adapter Status

The `adapters.<host>.status` field in `agenticloop/config.json` records adapter
availability.

- `supported` -- implemented, documented, and available for generation.
- `placeholder` -- reserved name with no generator yet. Avoid referencing it in
  target-owned config until the generator exists.

All five implemented adapters – OpenCode, Codex, Claude Code, Copilot, and
Cursor – are supported. Tests, validation commands, and packaging checks remain
development and release quality checks.

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

Serial execution is the default safety floor, not a preference. Every authorized
multi-task unit receives a current Parallel Opportunity Scan after decomposition
(see `agenticloop/AGENTIC_LOOP.md`); fewer than two ready tasks still produce a
truthful not-currently-eligible result and rescan trigger. Bounded eligible
batches may use at most the target project's configured implementation-lane
maximum (default five). It is a ceiling, not a target or total-agent budget, and
does not automatically apply to review, coordination, or integration lanes.
Choosing serial after eligible candidates exist requires a recorded concrete
reason. Long-running parallelism carries stronger observability requirements
(live status/cancellation or strict bounded leases) than short bounded join-based
batches.

## Per-Host Role Settings

Model identifiers and aliases are host/provider specific. They do not live in
the portable role files under `agenticloop/agents/`. Use
`adapters.<host>.roleSettings.<role>.model` to express the same logical role
with a different concrete model on each host. OpenCode and Codex also support
`adapters.<host>.roleSettings.<role>.reasoningEffort`; Claude Code supports
`model` and `permissionMode` there; Copilot and Cursor currently support
`model` only.
Codex supports `minimal`, `low`, `medium`, `high`, and `xhigh` for
`reasoningEffort`. OpenCode supports `low`, `medium`, `high`, `xhigh`, and
`max` (provider/model-dependent; `minimal` is not offered), plus a `Default`
choice that omits or removes the setting so generated agent Markdown omits
`variant`.

Adapter-local role settings are the supported configuration surface. The
shared resolver still tolerates older configs that put model fields under
`roles.<role>`, but new target configs should not do that. Logical roles stay
host-neutral; concrete model choices live under the host adapter.

The orchestrator should use a model reliable at multi-step instruction
following, state tracking, tool routing, and stop-condition enforcement. It does
not need to be the strongest coding model, but avoid using a lightweight model
that frequently drops workflow state during long task sets. When uncertain,
prefer the strongest general reasoning model available for orchestration. This
guidance is provider-neutral: reasoning-effort labels are not comparable across
providers, and Agentic Loop does not rank or gate specific models.

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

Generation refuses to overwrite a changed generated artifact by default. Use
`--force-generated` only to refresh an artifact whose manifest proves Agentic
Loop owns it; it never overrides user-owned files or malformed shared config.
It also never overrides a modified cross-adapter transfer: Codex-to-Cursor and
Cursor-to-Codex plugin switching is atomic only when every transferred file is
an exact, unmodified owned output.
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
  `maintainer`, `engineer`, and `auditor`.
- Optional plugin distribution is separate from repo-local use. Set
  `adapters.codex.plugin.enabled: true` only when you intentionally want
  generated `plugins/agenticloop/` packaging plus
  `.agents/plugins/marketplace.json`.
- Codex and Cursor plugin modes cannot be enabled together because they share
  `plugins/agenticloop/`. A single `generate all` or update can switch the
  enabled host atomically when the prior generated files are unchanged;
  `--force-generated` does not weaken that transfer safety check.

## Claude Code Modes

Claude Code has two distinct install paths:

- Mode A plugin packaging lives at the toolkit root in `.claude-plugin/`. Its
  public surfaces are `agenticloop/commands/start.md` (`/agenticloop:start`) and
  `agenticloop/commands/stop.md` (`/agenticloop:stop`), plus the canonical role agents under `agenticloop/agents/`. It does
  not copy canonical skills into `.claude-plugin/`, and it does not register
  every canonical `agenticloop/skills/` entry as a separate public plugin skill.
- Mode B is the repo-local adapter generated by `agenticloop generate
  claude-code`, which emits `.claude/commands/agenticloop.md`,
  `.claude/agents/`, one public `.claude/skills/agenticloop/SKILL.md` with
  internal `references/skills/<name>/reference.md` procedure copies, and
  `.claude/settings.local.json` into the target project by default.

Mode B defaults maintainer and engineer subagents to
`permissionMode: acceptEdits` so edit auto-accept is scoped to Agentic Loop
worker subagents rather than the whole repository. The auditor subagent defaults
to `permissionMode: plan`, Claude Code's supported non-editing mode, so its
read-only audit posture is enforced mechanically. It also writes the built-in
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
Mode A and `/agenticloop` for Mode B. Use `/agenticloop:stop` for Mode A or
`/agenticloop stop` for Mode B to deactivate the loop. It does not rely on hooks, and it never
uses `CLAUDE.md` as an activation mechanism. If Agentic Loop's repository-rules
resolver selects `CLAUDE.md` as the rules document, that file may still carry the
one informational activation-boundary guidance block (see
[Repository-rules activation guidance](#repository-rules-activation-guidance));
that block is informational only and does not activate the methodology.

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
  The orchestrator is the user-selectable entry agent; maintainer, engineer, and
  auditor are generated as subagent-only workers. The auditor is generated
  without the `edit` tool.
- Generated Copilot skills live under `.github/skills/agenticloop/` as one public
  `SKILL.md` plus internal `reference.md` procedure copies and backend
  references.
- `.github/copilot-instructions.md` is intentionally not generated. Treat it, and
  any `.github/instructions/*.instructions.md` files, as user or team-owned
  customization surfaces.
- `generate all` includes Copilot because it is implemented.

## Repository-rules activation guidance

Independent of any host adapter, `init` and `setup` install one clearly marked,
manifest-owned activation-guidance block into the selected repository-rules
document. The rules document is resolved with a guidance-specific precedence:

1. an explicit `documents.rules` selection in `.agenticloop/project.md`;
2. an explicitly configured target-project `documents.rules` path, when the file
   exists;
3. the first existing candidate from the rules document-role registry
   (`AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`);
4. `AGENTS.md` as the default path to create when no rules document exists.

Non-Markdown destinations, paths outside the repository, and paths that cross a
symlink or junction are rejected. Only the region between `<!-- AGENTICLOOP_START -->`
and `<!-- AGENTICLOOP_END -->` is owned; everything else in the file is
target-owned and preserved byte-for-byte. A modified owned block or an unowned
manual marker block is preserved and reported rather than overwritten or adopted.
`update` refreshes only a block Agentic Loop already owns and never enrolls an
existing installation that has no owned block. Opt out with
`--no-agents-guidance`, inspect with `agenticloop guidance check`, and remove with
`agenticloop guidance remove`. Because the block is informational, it does not
activate the methodology. `guidance remove --force` removes only the managed
marker region from an edited file. A configured rules-path change is reported as
ownership drift; update does not silently add a second block at the new path.

## Cursor Activation

Cursor support is repo-local.

- Generate the adapter, then invoke `/agenticloop` in Cursor Agent chat.
- Cursor exposes one clean public skill surface at
  `.cursor/skills/agenticloop/`.
- Generated Cursor subagents live under `.cursor/agents/*.md` and are rendered
  from canonical `agenticloop/agents/*.md` plus Cursor-specific delegation and
  boundary wiring.
- The active Cursor session stays the coordinator/orchestrator. Maintainer,
  engineer, and auditor role work is delegated through the generated Cursor
  subagents where supported. The auditor subagent is generated with
  `readonly: true`.
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

## Project State and Activation Boundaries

Generated role bodies embed the canonical role contracts, so they carry the
standing recognition behavior for durable project state – including the Project
Operating Facts responsibilities – without any adapter-specific template edits.

Activated Agentic Loop roles read the live `.agenticloop/project.md` (its
`## Verification Operating Facts` and `## Project Operating Facts` profiles
included) before acting. Because that project map is target-owned mutable state,
build-time embedding of its contents into generated adapters would become stale
and must not be used; adapters point roles at the live file by path.

Ordinary sessions outside Agentic Loop activation are not required to load
Agentic Loop project state. Do not add "read `.agenticloop/project.md` at every
session start" to global host instructions. Host-specific ambient memory remains
outside the core methodology.

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