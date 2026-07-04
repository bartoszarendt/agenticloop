# Copilot Setup

Status: experimental.

Agentic Loop now has an experimental GitHub Copilot adapter that renders from
the same canonical source as the other hosts:

- `agenticloop/commands/start.md`
- `agenticloop/agents/<role>.md`
- `agenticloop/skills/<name>/SKILL.md`
- `agenticloop/backends/<name>.md`
- `agenticloop.json` / `agenticloop/config.json`

The current MVP uses GitHub Copilot custom agents, one explicit public skill
surface for `/agenticloop`, and one IDE prompt-file fallback. It does not
generate always-on repository instructions.

## Generate the adapter

From the target project root:

```text
npx agenticloop init --adapter copilot
```

or, if the overlay already exists:

```text
npx agenticloop generate copilot
```

This writes or refreshes:

| Path | Purpose |
|---|---|
| `.github/agents/<role>.agent.md` | Generated Copilot custom agents for `orchestrator`, `maintainer`, and `engineer`. |
| `.github/skills/agenticloop/SKILL.md` | One public Agentic Loop skill for explicit Copilot CLI `/agenticloop` activation. |
| `.github/skills/agenticloop/references/skills/<name>/reference.md` | Internal Agentic Loop procedure references copied from canonical skills without exposing extra public skills. |
| `.github/skills/agenticloop/references/backends/*.md` | Copied backend projection references. |
| `.github/prompts/agenticloop.prompt.md` | IDE prompt-file fallback bound to the orchestrator custom agent. |

The adapter does not generate `.github/copilot-instructions.md`.

## Activation

Copilot activation is explicit.

- In Copilot CLI, invoke `/agenticloop [task-id or task description]`.
- The generated public skill sets `user-invocable: true` and
  `disable-model-invocation: true`, so Copilot can expose `/agenticloop` while
  ordinary chat does not auto-enter Agentic Loop.
- In Copilot IDE surfaces that support `.github/prompts/*.prompt.md`, use the
  generated `agenticloop` prompt file as the fallback activation surface.
- The prompt file binds activation to the orchestrator Copilot custom agent and
  tells Copilot to read `.agenticloop/project.md` first, follow
  `.github/skills/agenticloop/SKILL.md`, and create or refine the durable task
  record before implementation.

Prompt files are not a github.com surface today, so IDE prompt-file activation
still needs live validation before the adapter can move beyond `experimental`.

## Public skill shape

Copilot exposes one clean public Agentic Loop skill surface:

- Public skill directory: `.github/skills/agenticloop/`
- Public skill name: `agenticloop`
- Public skill activation: `/agenticloop` in Copilot CLI
- Explicit-only guard: `disable-model-invocation: true`
- Internal procedures: `references/skills/<name>/reference.md`
- Backend references: `references/backends/README.md`, `files.md`, and
  `github.md`

No extra public `.github/skills/<name>/SKILL.md` copies are generated for each
canonical Agentic Loop procedure.

## Custom agents

Copilot custom agents live under `.github/agents/*.agent.md` and keep canonical
role contracts as the source of truth.

Each generated custom agent includes:

- `name`
- `description`
- `tools`
- orchestrator `agents: [maintainer, engineer]` allow-list
- `model` when configured
- orchestrator `user-invocable: true`
- orchestrator `disable-model-invocation: true`
- worker `user-invocable: false`
- worker `disable-model-invocation: false`

The invocation split is intentional:

- the orchestrator stays manually selectable and is protected from being used as
  a subagent by other agents
- maintainer and engineer stay hidden from the normal picker but remain callable
  as worker subagents for orchestrator routing

The agent body adds Copilot-aware methodology wiring:

- identify the canonical role source file
- read `.agenticloop/project.md`
- follow `agenticloop/AGENTIC_LOOP.md`
- point required skills to `.github/skills/agenticloop/references/skills/...`
- keep the canonical role contract body

The generated orchestrator instructions require the active Copilot session to
stay the coordinator/orchestrator, route maintainer-owned work through the
Copilot custom agent `maintainer`, route engineer-owned work through the
Copilot custom agent `engineer`, require real custom-agent, subagent, or
handoff delegation where available, and record bounded fallback through
`role-delegation` when delegation is unavailable.

Copilot may expose multiple callable agents, but Agentic Loop is serial by
default. For an authorized multi-task unit with 2 or more ready task records, the
orchestrator performs a Parallel Opportunity Scan before defaulting to serial;
bounded eligible batches may use up to 3 implementation lanes, and choosing
serial after eligible candidates exist requires a recorded concrete reason. The
orchestrator should not start parallel maintainer or engineer
agents unless it records the concurrency plan, collision criteria, lease, and
join condition required by `agenticloop/AGENTIC_LOOP.md` and
`agenticloop/skills/role-delegation/SKILL.md`. Long-running parallelism has
stronger observability requirements than short bounded join-based batches.
Parallel write lanes that mutate
repository files require a separate `git worktree` and branch per lane; a branch
alone is not sufficient in a shared checkout. The lease progress checkpoint is a
return-to-orchestrator checkpoint cadence, not an async heartbeat, unless the
host exposes running-agent status.

Launch Copilot sessions that run Agentic Loop with non-interactive Git
environment variables (`GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GH_EDITOR=true`, `GH_PAGER=cat`,
`GH_PROMPT_DISABLED=1`) as described in
[Host Adapters](host-adapters.md#non-interactive-git-environment). This prevents
unattended lanes from blocking on `COMMIT_EDITMSG`, interactive rebase todo
files, pagers, PR prompts, or credential prompts.

## What this MVP does not generate

These Copilot customization surfaces remain user or team-owned:

- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`

That is intentional. The MVP keeps Agentic Loop activation explicit instead of
always-on.

## Model settings and role bindings

Copilot model identifiers are read from:

```json
{
  "adapters": {
    "copilot": {
      "roleSettings": {
        "orchestrator": { "model": "<copilot-orchestrator-model>" },
        "maintainer": { "model": "<copilot-maintainer-model>" },
        "engineer": { "model": "<copilot-engineer-model>" }
      }
    }
  }
}
```

Copilot does not use `reasoningEffort` in this MVP. If you run
`agenticloop configure models --adapter copilot`, it records only `model`.

Optional role-to-agent filename bindings live at:

```json
{
  "adapters": {
    "copilot": {
      "roleBindings": {
        "maintainer": { "agent": "al-maintainer" },
        "engineer": { "agent": "al-engineer" }
      }
    }
  }
}
```

That changes generated `.github/agents/<name>.agent.md` filenames and the role
names referenced in the public skill and prompt file.

## Validation

Validate Copilot output with:

```text
npx agenticloop validate --adapter copilot
```

Copilot validation checks:

- generated `.github/agents/*.agent.md` files exist for each configured role
- agent frontmatter name, description, and configured model match expectations
- orchestrator references the maintainer and engineer custom agents
- required skills are referenced by `.github/skills/agenticloop/references/skills/<name>/reference.md`
- one public `.github/skills/agenticloop/SKILL.md` exists
- the public skill keeps explicit `/agenticloop` activation with
  `user-invocable: true` and `disable-model-invocation: true`
- internal references exist and do not contain nested discoverable `SKILL.md`
- backend references exist
- `.github/prompts/agenticloop.prompt.md` exists and binds IDE prompt-file
  activation to the orchestrator custom agent
- `.github/copilot-instructions.md` is not required

## Remaining live-validation gate

Copilot stays `experimental` until a real Copilot session documents that:

1. The generated public skill activates correctly as `/agenticloop` in Copilot
   CLI.
2. The generated `agenticloop` prompt activates correctly in live Copilot IDE
   prompt-file surfaces.
3. The prompt-file `agent` binding reaches the generated orchestrator agent.
4. Maintainer and engineer work is routed through real Copilot custom-agent,
   subagent, or handoff delegation where available.
5. The public skill and internal reference paths load correctly in the live
   Copilot surface.
6. Bounded fallback behavior is truthful and usable when delegation is absent.
