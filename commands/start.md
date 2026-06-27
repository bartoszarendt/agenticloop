---
description: "Operate in Agentic Loop mode: create or refine the durable task record, route maintainer and engineer roles, verify evidence, and close out according to the project backend."
argument-hint: "[task-id or task description]"
disable-model-invocation: true
---

Path convention: toolkit source (`AGENTIC_LOOP.md`, `agents/`, `skills/`,
`backends/`) lives under `agenticloop/` (no leading dot). Target project state
(`project.md`, `tasks/`, `decisions/`, `improvements/`) lives under `.agenticloop/` (leading
dot). `.agenticloop/agents`, `.agenticloop/skills`, and
`.agenticloop/backends` are invalid paths -- canonical assets are always
under `agenticloop/` without the dot.

Read `.agenticloop/project.md` first. If `setup_status` is `unconfirmed`,
route `agenticloop/skills/setup-agenticloop/SKILL.md` or confirm the defaults before
selecting or creating the first task.

Then read `agenticloop/AGENTIC_LOOP.md` and the canonical role contracts in `agenticloop/agents/`.
Keep the main session as the coordinator: it reads the selected project config
and process docs, routes task authoring, review, acceptance, and closeout
through the maintainer role, routes scoped implementation and revision work
through the engineer role, and should not directly edit implementation files
unless the human explicitly asks. Respect the Advance Authorization Boundary,
blocked-state handling, decision records, event logging rules, and configured
group approval gates.

Agentic Loop is serial by default. Do not run parallel maintainer or engineer
delegations unless the orchestrator records a concurrency plan and join
condition. Long-running or parallel role work must include a lease:
observable-step checkpoint cadence, no-progress budget, status-return stop
condition, and any relevant milestone or duration.

Create or refine the durable task record before any implementation.

If no task ID or task description is provided:
1. Read `.agenticloop/project.md` and configured primary documents (rules,
   overview, process), plus any selected task-source documents (`plan`, `spec`,
   `design`, `context`) relevant to the work.
2. Check `setup_status`; if unconfirmed, route setup or confirmation first.
3. Inspect the active backend for candidate task records:
   - if `github`, look for open `agent-ready` issues when GitHub access works;
   - if `files`, look under the configured task directory.
4. Summarize current project and task state.
5. If exactly one open or ready task exists, propose it as the default candidate
   but do not silently start implementation unless the user clearly authorized
   that work unit.
6. If no open tasks exist, identify the likely next work item from the plan. If
   it is a phase, group, milestone, epic, or multi-deliverable item, report that
   it needs maintainer decomposition into task records. Do not create records
   without confirmation.
7. If GitHub is unreachable during bare orientation, still provide local project
   orientation from files and report GitHub as unavailable for task operations.
   Do not treat connector failure alone as proof of missing credentials.
8. Ask the human to select a task or provide a task description.

Requested task or context: `$ARGUMENTS`
