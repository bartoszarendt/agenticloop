# .agenticloop/ -- Target-Owned Workflow State

This directory is **target-owned mutable workflow state**. It is created by
`agenticloop init` and belongs to the target project, not the toolkit.

## Path Convention

Two sibling directories exist at the repository root. They differ only by a
leading dot. Confusing them is the most common agent path mistake.

| Directory | Leading dot | Owner | Contents |
|---|---|---|---|
| `agenticloop/` | no | toolkit (read-only) | `AGENTIC_LOOP.md`, `agents/`, `skills/`, `backends/`, `commands/`, `memory/`, `config.json` |
| `.agenticloop/` | yes | target project (read/write) | `project.md`, `tasks/`, `decisions/`, `improvements/` (created on first proposal), `logs/`, `tmp/` |

## What Lives Here

- `project.md` -- project map: backend choice, task naming, grouping, document selections.
- `tasks/` -- files-backed task records (e.g. `tasks/T-001.md`). Each accepted
  task carries its completion summary inline; there is no separate summaries directory.
- `decisions/` -- durable decision records.
- `logs/` -- optional JSONL event logs (gitignored by default).
- `tmp/` -- scratch files (gitignored).

## Invalid Paths

The following paths do not exist and must never be used:

- `.agenticloop/agents/` -- canonical roles are at `agenticloop/agents/`.
- `.agenticloop/skills/` -- canonical skills are at `agenticloop/skills/`.
- `.agenticloop/backends/` -- canonical backend docs are at `agenticloop/backends/`.
- `.agenticloop/AGENTIC_LOOP.md` -- the process doc is at `agenticloop/AGENTIC_LOOP.md`.

When referencing toolkit source, always use the non-dotted `agenticloop/` prefix.
When referencing project state, always use the dotted `.agenticloop/` prefix.
