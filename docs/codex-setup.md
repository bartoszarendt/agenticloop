# Codex Setup

Status: experimental.

Codex support is usable as a repo-local Codex TUI workflow, but it stays
`experimental` until the updated live smoke path is rerun in a real target
project after the latest hardening fixes.

The Codex adapter renders from the same canonical sources as the other hosts:

- `agenticloop/commands/start.md`
- `agenticloop/agents/<role>.md`
- `agenticloop/skills/<name>/SKILL.md`
- `agenticloop/backends/<name>.md`
- `agenticloop.json` / `agenticloop/config.json` (strict JSON)

Repo-local Codex mode is the MVP. Plugin distribution is optional.

## Repo-Local Lifecycle

Generate the adapter from the target project root:

```text
npx agenticloop generate codex
```

This writes or refreshes:

| Path | Purpose |
|---|---|
| `.codex/agents/<role>.toml` | Generated Codex custom agents for `orchestrator`, `maintainer`, and `engineer`. |
| `.agents/skills/agenticloop/SKILL.md` | One public repo-local Codex activation skill. |
| `.agents/skills/agenticloop/agents/openai.yaml` | Codex UI metadata so `/skills` shows `Agentic Loop`. |
| `.agents/skills/agenticloop/references/skills/<name>/reference.md` | Internal Agentic Loop procedure references copied from canonical skills without exposing extra discoverable Codex skills. |

Start Agentic Loop in Codex directly with:

```text
$agenticloop [task-id or task description]
```

You can also open `/skills` and select `Agentic Loop`, but `$agenticloop ...`
is the faster path. This adapter does not generate a repo-local `/agenticloop`
slash command for Codex. Codex custom prompts can create personal slash
commands under `~/.codex/prompts`, but that surface is deprecated,
user-local, and not suitable as the target-project contract.

## Public Skill Shape

Codex now exposes one clean public skill surface instead of a long list of
`agenticloop-*` entries.

- Public skill directory: `.agents/skills/agenticloop/`
- Public skill name: `agenticloop`
- Display name in Codex UI: `Agentic Loop`
- Default prompt in Codex UI: `Operate in Agentic Loop mode: create or refine the durable task record, route maintainer and engineer roles, verify evidence, and close out according to the project backend.`

The public skill is still rendered from the canonical `agenticloop/commands/start.md`
contract, but the Codex adapter adds host-specific guidance:

1. read `.agenticloop/project.md` first
2. route setup confirmation through the internal `setup-agenticloop` reference
   when `setup_status` is `unconfirmed`
3. read `agenticloop/AGENTIC_LOOP.md` and canonical role contracts under `agenticloop/agents/`
4. create or refine the durable task record before implementation
5. keep the main Codex session as the coordinator/orchestrator
6. spawn the generated Codex custom agents for maintainer and engineer role work
7. use plain-message-only delegation prompts for Codex custom-agent spawn
8. avoid direct coordinator edits to implementation files unless the human
   explicitly asks

The rest of Agentic Loop's procedures are packaged under
`.agents/skills/agenticloop/references/skills/` as internal `reference.md`
files. That keeps the normal Codex skill picker clean while still giving the
generated skill and agents stable file paths for required procedures such as:

- `references/skills/role-delegation/reference.md`
- `references/skills/task-record-contract/reference.md`
- `references/skills/setup-agenticloop/reference.md`
- `references/skills/blocked-state/reference.md`

No discoverable `agenticloop-start` or `agenticloop-<skill>` skill copies are
generated anymore. If those legacy directories still exist in a target repo,
regenerate Codex output and remove the stale copies.

## Custom Agents

Codex custom agents live under `.codex/agents/` and keep the canonical role
contracts as the source of truth.

Each generated TOML includes:

- `name`
- `description`
- `developer_instructions`
- `model` when configured
- `model_reasoning_effort` only when Codex has an explicit supported value

`developer_instructions` add Codex-aware methodology wiring:

- identify the canonical role source file
- point the agent to `.agenticloop/project.md`
- point the agent to `agenticloop/AGENTIC_LOOP.md`
- point required skills to internal reference paths under
  `.agents/skills/agenticloop/references/skills/...`
- preserve the canonical role contract body

### Codex Delegation Contract

The generated orchestrator instructions explicitly require this Codex-specific
delegation behavior:

- spawn `maintainer` and `engineer` custom agents using one plain-message prompt
  payload only
- do not mix a plain message payload and structured items in one spawn request
- if the first spawn attempt fails with a schema error about message/items,
  retry once with plain-message-only
- if custom-agent delegation is still unavailable after that retry, record a
  bounded fallback reason and continue according to the internal
  `role-delegation` reference

This addresses the first live Codex smoke failure where a mixed message/items
spawn attempt was rejected.

Codex may expose multiple custom agents, but Agentic Loop is serial by default.
The orchestrator should not start parallel maintainer or engineer agents unless
it records the concurrency plan, collision criteria, lease, and join condition
required by `agenticloop/AGENTIC_LOOP.md` and
`agenticloop/skills/role-delegation/SKILL.md`. Parallel write lanes that mutate
repository files require a separate `git worktree` and branch per lane; a branch
alone is not sufficient in a shared checkout. The lease progress checkpoint is a
return-to-orchestrator checkpoint cadence, not an async heartbeat, unless the
host exposes running-agent status.

## Event Logging in Codex

Codex follows the same command-resolution rule as other hosts, but generated
instructions make the preflight explicit because Codex target shells can vary.

- If `.agenticloop/project.md` has `event_logging: disabled`, do not log.
- If `event_logging: enabled`, use a non-empty `event_logging_command`.
- If `event_logging_command` is blank or omitted, run
  `npx agenticloop --help` once and use `npx agenticloop` only if that check
  succeeds.
- If no working event logging command is available, do not block the workflow.
  Record a truthful process gap in the task record or closeout marker note, then
  continue.
- If an event logging command fails because the executable is missing, do not
  retry repeatedly and do not block delegation.

If a Codex target needs an explicit command, set one of these in
`.agenticloop/project.md`:

```yaml
event_logging_command: "agenticloop"
```

or:

```yaml
event_logging_command: "node /path/to/agenticloop/bin/agenticloop.js"
```

## Optional Plugin Distribution

Repo-local Codex use does not require plugin installation.

If a target project intentionally wants a generated plugin root as a separate
distribution artifact, enable it in `agenticloop.json`:

```json
{
  "adapters": {
    "codex": {
      "plugin": {
        "enabled": true
      }
    }
  }
}
```

Then regenerate:

```text
npx agenticloop generate codex
```

Optional plugin mode adds:

| Path | Purpose |
|---|---|
| `plugins/agenticloop/.codex-plugin/plugin.json` | Minimal plugin-root manifest with `name`, `version`, `description`, and `skills: "./skills/"`. |
| `plugins/agenticloop/skills/agenticloop/SKILL.md` | Plugin-packaged public Codex skill. |
| `plugins/agenticloop/skills/agenticloop/agents/openai.yaml` | Plugin-packaged Codex UI metadata. |
| `plugins/agenticloop/skills/agenticloop/references/skills/<name>/reference.md` | Plugin-packaged internal procedure references. |
| `.agents/plugins/marketplace.json` | Local marketplace entry pointing to `./plugins/agenticloop`. |

Plugin mode uses the same single-public-skill-plus-references shape as the
repo-local layout.

## Per-Host Model Settings

Codex model identifiers and reasoning effort are read from
`adapters.codex.roleSettings.<role>` in `agenticloop.json`.

```json
{
  "adapters": {
    "codex": {
      "roleSettings": {
        "orchestrator": { "model": "<codex-orchestrator-model>", "reasoningEffort": "high" },
        "maintainer":   { "model": "<codex-maintainer-model>", "reasoningEffort": "medium" },
        "engineer":     { "model": "<codex-engineer-model>", "reasoningEffort": "high" }
      }
    }
  }
}
```

Use the Codex model id directly, without the old `codex-cli/` prefix. Existing
`codex-cli/<model>` settings are normalized during generation for compatibility,
but targets should update their config to the bare model id so generated TOML
matches Codex's custom-agent schema.

Codex supports these explicit reasoning-effort values:

- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

Do not put Codex model fields in canonical `agenticloop/agents/*.md`.

When configuring interactively, the model picker tries the experimental
`codex debug models` command to discover models available to the current
Codex account. If the command is unavailable or returns invalid JSON, it
falls back to the bundled catalog and custom entry. Override the command with
`AGENTICLOOP_CODEX_COMMAND`.

## Validation

Validate Codex output with:

```text
npx agenticloop validate --adapter codex
```

Codex validation checks:

- repo-local public `agenticloop` skill exists
- generated `agents/openai.yaml` exists and exposes `Agentic Loop`
- required internal references exist under `references/skills/`
- generated `.codex/agents/<role>.toml` files exist for each configured role
- orchestrator TOML includes the plain-message-only delegation contract
- Codex instructions resolve event logging commands with a one-time
  `npx agenticloop --help` check when no command is configured
- Codex instructions treat event logging as non-blocking when no working
  command is available
- generated TOML and internal references do not contain the legacy unverified
  `npx agenticloop` event-logging fallback wording
- legacy discoverable `.agents/skills/agenticloop-start/` and
  `.agents/skills/agenticloop-<skill>/` output is absent
- generated TOML does not use unsupported Codex reasoning effort values such as
  `auto`
- generated TOML model fields match configured Codex role settings after
  compatibility normalization, and do not contain the old `codex-cli/` prefix
- plugin mode, when present or enabled, uses the same single-skill shape under
  `plugins/agenticloop/`

Validation is tolerant of unrelated target-owned Codex config outside those
generated paths.

## Manual Codex TUI Smoke Protocol

This is still the required live validation step before Codex can move beyond
`experimental`:

1. In a real target project, run `npx agenticloop init --adapter codex` or
   `npx agenticloop generate codex` after setup.
2. Open Codex in that target project root.
3. Run `$agenticloop <task-id or scoped task description>` or select
   `Agentic Loop` from `/skills`.
4. Confirm Codex discovers the one public skill plus the generated custom
   agents.
5. Confirm the main session stays the coordinator/orchestrator.
6. Confirm maintainer-owned work is delegated through the `maintainer` custom
   agent and engineer-owned work is delegated through the `engineer` custom
   agent when explicitly required by the workflow.
7. Confirm each spawned custom-agent banner shows the configured Codex model
   and reasoning effort for that role.
8. Confirm the plain-message-only spawn contract avoids the previous
   message/items schema failure.
9. Confirm event logging uses the configured command, or checks
   `npx agenticloop --help` once before using `npx agenticloop` when no command
   is configured.
10. Confirm event logging records a truthful process gap and continues when no
   working event logging command is available.
11. Record the smoke result in a durable task record and update this guide.

Until that rerun is completed in a real Codex TUI session, keep this adapter
status at `experimental`.
