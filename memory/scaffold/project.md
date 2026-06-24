---
task_backend: files
event_logging: disabled
event_logging_command: ""
task_id_pattern: "T-<number>"
task_id_regex: "^T-\d{3,}$"
task_file_template: ".agenticloop/tasks/{taskId}.md"
grouping_profile: flat
group_closeout: false
setup_status: unconfirmed
setup_confirmed_at: ""
setup_confirmed_by: ""

# Optional backend confirmation notes. Use these when setup reviews bounded
# backend evidence or when files is kept as an explicit exception.
# backend_confirmed_at: "2026-06-16"
# backend_confirmed_by: "maintainer"
# backend_evidence_summary: "No durable GitHub task workflow evidence found; files backend confirmed."

# Optional typed document selections. Leave commented when the target project
# uses conventional names or when a role is not relevant.
# documents:
#   rules: "AGENTS.md"
#   plan: "PLAN.md"
#   overview: "README.md"
#   process: "agenticloop/AGENTIC_LOOP.md"
#   spec: "docs/spec.md"
#   design: "docs/architecture.md"
#   context: "docs/context.md"
#   history: "CHANGELOG.md"
#
# Optional grouping examples:
# grouping_profile: phase
# task_id_pattern: "P<phase>-<number>"
# task_id_regex: "^P\d+-\d{2,}$"
# group_heading_regex: "^##\s+(?:\S+\s+)?Phase\s+(?<groupId>\d+(?:\.\d+)?)\b"
# group_closeout: true
#
# grouping_profile: custom
# grouping_term: "Sprint"
# group_heading_regex: "^##\s+Sprint\s+(?<groupId>[^\s]+)\b"
# group_closeout: true
---

# Agentic Loop Project Map

This file is target-owned. Edit it to record task naming, optional grouping,
backend choice, and typed source-document selections for this project. Do not
put model IDs here; those belong in `agenticloop.json` under
`adapters.<host>.roleSettings`, created by `agenticloop init --adapter <host>`.

## Setup State

- `setup_status: unconfirmed` means this project map has not been reviewed yet.
- On the first non-trivial run, confirm the default conventions here or write
  the typed selections this target project needs.
- `setup_status: confirmed` means document selections, task naming, grouping,
  and backend choice have been reviewed for this target project, including any
  explicit files-backend exception.
- `setup_confirmed_at` should be a `YYYY-MM-DD` date.
- `setup_confirmed_by` should name the human or role that confirmed the setup.
- `backend_confirmed_at`, `backend_confirmed_by`, and
  `backend_evidence_summary` are optional durable notes for bounded backend
  evidence review.

## Conventions

Agentic Loop uses convention-first document lookup. If a typed document role is
not selected in the frontmatter above, the toolkit checks the bounded candidate
names from the canonical document-role registry in `agenticloop/config.json`.

Default primary document selections:

| Role | Conventional path |
|---|---|
| Rules | AGENTS.md |
| Overview | README.md |
| Process | agenticloop/AGENTIC_LOOP.md |

Optional task-source and reference roles include `plan`, `spec`, `design`,
`context`, and `history`. Select them only when the target project has a
document that should be treated as a source for non-trivial tasks. `plan` is
auto-detected from `IMPLEMENTATION_PLAN.md`, `PLAN.md`, or `ROADMAP.md` when
present; projects without a standing plan document simply leave it unset.

## Source Documents

Use typed document roles so agents know what a document is for:

- `rules`: repository rules and constraints.
- `plan`: roadmap, implementation plan, or ordered work list.
- `overview`: project identity and quick orientation.
- `process`: Agentic Loop methodology overlay.
- `spec`: requirements or product specification.
- `design`: architecture or design contract.
- `context`: target-owned domain context, product vocabulary, or task-start context.
- `history`: changelog, migration notes, or other read-only reference.

Agents do not scan the whole repository at runtime. They use the selected
roles here and the bounded candidate list from the canonical registry.

## Naming

The default task ID shape is neutral and flat-project friendly:

- T-001  (valid)
- T-002  (valid)
- T-01   (invalid: fewer than three digits)
- P1-01  (only valid if this project chooses a phase-style task_id_regex)

`task_id_regex` defines the machine-readable form. Update it only when the
target project uses a different naming convention.

Phase-style task IDs are optional. Use them only when the target project
chooses `grouping_profile: phase` and wants IDs such as `P1-01`. Setting
`grouping_profile: phase` alone does not change task IDs.

## Grouping

`grouping_profile` controls whether the project groups tasks:

- `flat`: no grouping required; task is the only required workflow atom.
- `phase`: optional phase grouping.
- `milestone`: optional milestone grouping.
- `epic`: optional epic grouping.
- `custom`: a project-defined grouping term and heading regex.

For `custom`, set all three:

- `grouping_term`
- `group_heading_regex`
- `group_closeout`

Grouped projects may use `## Grouping` and `## Source Reference` in task
records. Flat projects do not need either section.

## Task Records

Task records are Markdown files under `.agenticloop/tasks/`. Each file is named
after its task ID (for example `.agenticloop/tasks/T-001.md`). The files
backend is durable local storage; no GitHub repository is required.

Use `agenticloop/memory/task-record.md` as the canonical task-record shape.
It defines the required section order, optional sections, and summary/review
handoff structure.

No placeholder text (TBD, as needed, etc., similar to previous task, to be filled,
to be filled during review) is permitted in any durable task record.

Each accepted task carries its completion summary inline, in the task record
itself, using the work-unit summary section shape. There is no separate
summaries directory.

## Backend

The default backend is files. Task records live as Markdown files locally. No GitHub
account, repository, or labels are required for a new project with no durable GitHub
task-workflow evidence.

If the target project already shows durable GitHub issue/PR workflow evidence, review
that evidence during setup before keeping or switching the backend. When files is kept
despite that evidence, record the explicit exception in setup confirmation or in
`backend_evidence_summary`.

To switch to the GitHub backend, update task_backend: github in the frontmatter above
and follow `agenticloop/backends/github.md` for task record, label, and pull request conventions.

## Event Logging

Event logging is optional and disabled by default.

- Disabled projects should not attempt event logging.
- Enabled projects require a working CLI command.
- If `event_logging_command` is blank or omitted, agents test `npx agenticloop --help` once and use `npx agenticloop` only if that check succeeds.
- If no working command is available, agents record a truthful process gap in the task record, review, or closeout marker note and continue.
- Set an explicit command when a target host needs one, for example `event_logging_command: "agenticloop"`
- For local toolkit development before npm publish, use `event_logging_command: "node bin/agenticloop.js"`.

Default event logs are task-scoped JSONL files under `.agenticloop/logs/`, such as
`.agenticloop/logs/T-001.jsonl`. Default event writes require `--task <TASK-ID>`.
Use `--output <file>` only for tests or an explicit local exception.

## Optional GitHub Projection

GitHub issues and pull requests are an optional projection for projects that already
use GitHub. To enable the GitHub backend:

1. Set task_backend: github in the frontmatter above.
2. Run agenticloop bootstrap-labels to create the required labels in your repository.
   The command is safe to re-run and reports existing labels as ok.
3. Follow `agenticloop/backends/github.md` for task record and projection conventions.

Host adapter generation (.opencode/agents/*.md, Codex agents, Claude Code agents)
requires agenticloop.json. Create it with agenticloop init --adapter <host>.
Keep the active backend in task_backend above; use agenticloop.json only for
adapter settings and optional backends.* behavior overrides.

Agentic Loop-owned adapter config uses strict JSON. Agentic Loop does not own
opencode.jsonc.
