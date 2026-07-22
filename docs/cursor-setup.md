# Cursor Setup

Status: supported.

The Cursor adapter stays repo-local and explicit-activation first. It renders
from the same canonical source as the other hosts:

- `agenticloop/commands/start.md`
- `agenticloop/agents/<role>.md`
- `agenticloop/skills/<name>/SKILL.md`
- `agenticloop/backends/<name>.md`
- `agenticloop.json` / `agenticloop/config.json`

It uses Cursor-native skills and subagents, but it does not generate always-on
Cursor rules or session hooks by default.

## Generate the adapter

From the target project root:

```text
npx agenticloop init --adapter cursor
```

or, if the overlay already exists:

```text
npx agenticloop generate cursor
```

This writes or refreshes:

| Path | Purpose |
|---|---|
| `.cursor/agents/<role>.md` | Generated Cursor subagents for `orchestrator`, `maintainer`, and `engineer`. |
| `.cursor/skills/agenticloop/SKILL.md` | One public Agentic Loop skill for explicit Cursor activation. |
| `.cursor/skills/agenticloop/references/skills/<name>/reference.md` | Internal Agentic Loop procedure references copied from canonical skills without exposing extra public skills. |
| `.cursor/skills/agenticloop/references/backends/*.md` | Copied backend projection references. |

The adapter does not generate `.cursor/rules/` by default.

## Activation

Cursor activation is explicit:

- open Cursor Agent chat in the target project
- invoke `/agenticloop`
- invoke `/agenticloop stop` to deactivate the current Agentic Loop conversation
  safely; it checkpoints unfinished work without closeout, commits, pushes,
  merges, or worktree cleanup, and `/agenticloop <task or context>` resumes
- let the active Cursor session stay the coordinator/orchestrator

The generated public skill tells Cursor to:

1. read `.agenticloop/project.md` first
2. route unconfirmed setup through the internal `setup-agenticloop` reference
3. read `agenticloop/AGENTIC_LOOP.md` and canonical role contracts under `agenticloop/agents/`
4. create or refine the durable task record before implementation
5. keep coordinator edits bounded
6. delegate maintainer and engineer work through generated Cursor subagents where supported

## Public skill shape

Cursor exposes one clean public Agentic Loop skill surface:

- Public skill directory: `.cursor/skills/agenticloop/`
- Public skill name: `agenticloop`
- Explicit activation guard: `disable-model-invocation: true`
- Internal procedures: `references/skills/<name>/reference.md`
- Backend references: `references/backends/README.md`, `files.md`, and `github.md`

No extra public `.cursor/skills/<name>/SKILL.md` copies are generated for each
canonical Agentic Loop procedure.

## Cursor subagents

Cursor subagents live under `.cursor/agents/*.md` and keep canonical role
contracts as the source of truth.

Each generated subagent includes:

- `name`
- `description`
- `model` (`inherit` by default, or the configured model)
- `readonly: true` for `orchestrator`
- `readonly: false` for `maintainer` and `engineer`

The agent body adds Cursor-aware methodology wiring:

- identify the canonical role source file
- read `.agenticloop/project.md`
- follow `agenticloop/AGENTIC_LOOP.md`
- point required skills to `.cursor/skills/agenticloop/references/skills/...`
- point backend docs to `.cursor/skills/agenticloop/references/backends/...`
- preserve the canonical role contract body

The generated orchestrator instructions require the active Cursor session to
stay the coordinator/orchestrator, delegate maintainer-owned work through the
Cursor subagent `maintainer`, delegate engineer-owned work through the Cursor
subagent `engineer`, and record a bounded fallback reason through
`role-delegation` when true Cursor subagent delegation is unavailable.

Cursor may expose multiple subagents, but Agentic Loop is serial by default.
For an authorized multi-task unit with 2 or more ready task records, the
orchestrator performs a Parallel Opportunity Scan before defaulting to serial;
bounded eligible batches may use up to 3 implementation lanes, and choosing
serial after eligible candidates exist requires a recorded concrete reason.
The orchestrator should not start parallel maintainer or engineer subagents
unless it records the concurrency plan, collision criteria, lease, and join
condition required by `agenticloop/AGENTIC_LOOP.md` and
`agenticloop/skills/role-delegation/SKILL.md`. Long-running parallelism has
stronger observability requirements than short bounded join-based batches.
Parallel write lanes that mutate
repository files require a separate `git worktree` and branch per lane; a branch
alone is not sufficient in a shared checkout. The lease progress checkpoint is a
return-to-orchestrator checkpoint cadence, not an async heartbeat, unless the
host exposes running-subagent status.

Launch Cursor sessions that run Agentic Loop with non-interactive Git
environment variables (`GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GH_EDITOR=true`, `GH_PAGER=cat`,
`GH_PROMPT_DISABLED=1`) as described in
[Host Adapters](host-adapters.md#non-interactive-git-environment). This prevents
unattended lanes from blocking on `COMMIT_EDITMSG`, interactive rebase todo
files, pagers, PR prompts, or credential prompts.

## What this MVP does not generate

These Cursor customization surfaces remain user or team-owned:

- `.cursor/rules/`
- Cursor session hooks
- a tracked root `.cursor-plugin/` in this toolkit repo

That is intentional. Agentic Loop stays explicit instead of always-on.

## Model settings and role bindings

Cursor model identifiers are read from:

```json
{
  "adapters": {
    "cursor": {
      "roleSettings": {
        "orchestrator": { "model": "<cursor-orchestrator-model>" },
        "maintainer": { "model": "<cursor-maintainer-model>" },
        "engineer": { "model": "<cursor-engineer-model>" }
      }
    }
  }
}
```

Cursor does not use `reasoningEffort` in this MVP. If you run
`agenticloop configure models --adapter cursor`, it records only `model`.

When configuring interactively, the model picker tries `agent models` to
discover models available to the current Cursor account. If the command is
unavailable, it falls back to the bundled catalog and custom entry. Override
the command with `AGENTICLOOP_CURSOR_COMMAND`.

Optional role-to-agent filename bindings live at:

```json
{
  "adapters": {
    "cursor": {
      "roleBindings": {
        "maintainer": { "agent": "al-maintainer" },
        "engineer": { "agent": "al-engineer" }
      }
    }
  }
}
```

That changes generated `.cursor/agents/<name>.md` filenames and the role names
referenced in the public skill.

## Optional plugin packaging

Repo-local `.cursor/` output is the MVP.

Optional generated plugin packaging can be enabled later with:

```json
{
  "adapters": {
    "cursor": {
      "plugin": {
        "enabled": true
      }
    }
  }
}
```

When enabled, Agentic Loop also generates `plugins/agenticloop/.cursor-plugin/`
plus plugin-local `skills/agenticloop/` and `agents/`. The plugin distribution
is optional and disabled by default.

## Validation

Validate Cursor output with:

```text
npx agenticloop validate --adapter cursor
```

Cursor validation checks:

- generated `.cursor/agents/*.md` files exist for each configured role
- agent frontmatter name, description, readonly, and configured model match expectations
- one public `.cursor/skills/agenticloop/SKILL.md` exists
- the public skill keeps explicit `/agenticloop` activation with `disable-model-invocation: true`
- required internal references exist and do not contain nested discoverable `SKILL.md`
- backend references exist
- optional plugin mode, when enabled or present, uses the same single-public-skill shape

## Smoke Protocol

Use this protocol to verify a Cursor deployment end-to-end:

1. `/agenticloop` activates the generated public skill correctly.
2. The active Cursor session stays the coordinator/orchestrator.
3. Maintainer and engineer work is routed through real Cursor subagents where available.
4. The public skill and internal reference paths load correctly in the live Cursor surface.
5. Bounded fallback behavior is truthful and usable when delegation is absent.
