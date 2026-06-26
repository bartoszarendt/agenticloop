# AGENTS.md

## Purpose

This file defines repository-wide rules for Agentic Loop itself.

Agentic Loop is a reusable, Markdown-first workflow toolkit for downstream repositories. It is maintained manually as normal repository work. Do not run Agentic Loop as an autonomous loop against itself.

## Source of Truth

Use these files as the durable repository contract:

1. [README.md](README.md)
2. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
3. [AGENTIC_LOOP.md](AGENTIC_LOOP.md)
4. [docs/glossary.md](docs/glossary.md)
5. [agents/](agents/)
6. [skills/](skills/)
7. [backends/](backends/)

The `docs/` directory is the user-facing setup and authoring surface. Keep it practical and adoption-oriented.

Repository layout ownership:

- The toolkit repo authors canonical source at the repository root (`AGENTIC_LOOP.md`, `agents/`, `skills/`, `backends/`, `commands/`, `memory/`, `config.json`, `agenticloop.template.json`, `manifest.json`).
- The installer assembles that source into `agenticloop/` inside target projects.
- `.agenticloop/` is target-owned workflow state.
- Host folders are generated shims and must not become tracked canonical source.

## Repository Scope

Agentic Loop contains reusable process assets only:

- host-neutral skills,
- host-neutral role definitions,
- task backend projection docs,
- workflow methodology,
- host setup documentation,
- validation and setup helpers.

Do not add downstream product code, application stacks, database migrations, seed data, generated caches, runtime artifacts, or raw agent transcripts.

## Core Rules

- Keep the toolkit project-agnostic. Use "target project" language unless a file is explicitly an example.
- Phase M's "no permanent split / dogfood the same tree" rule is superseded. Keep authored package source at the repository root and keep installed target paths under `agenticloop/`.
- Keep `agents/` as the single canonical role source in this repo.
- Keep `skills/` as the single canonical skill source in this repo.
- Keep `backends/` as task-record storage projection docs in this repo, not duplicated workflows.
- Do not duplicate skill payloads into adapter-specific directories as tracked source material.
- Do not duplicate role prompts into adapter-specific directories as tracked source material.
- Keep downstream setup Markdown-first. Required future automation should be cross-platform and `npx`-based.
- Treat Python, PowerShell, and Bash scripts as repository-maintenance or host-specific helpers, not the downstream product contract.
- Keep docs ASCII unless there is a clear reason otherwise.

## Validation Expectations

Normal downstream validation uses the Node CLI:

```text
npx agenticloop validate
```

After editing any skill, run the same command. It validates frontmatter, cross-links, OpenCode prompt references, config consistency, and task-record content without requiring a tracked generated docs snapshot.

```text
npm test
```

runs the full Node test suite, which covers skill validation, strict JSON config loading, OpenCode markdown adapter validation, init behavior, and bootstrap-labels dry-run.

## Documentation Rules

- Keep the README focused on identity, quick start, and documentation links.
- Keep setup instructions under `docs/*-setup.md` and `docs/getting-started.md`.
- Keep role definitions under `agents/` in this repo and under `agenticloop/agents/` in generated targets.
- Keep backend projection rules under `backends/` in this repo and under `agenticloop/backends/` in generated targets.
- Keep skill authoring rules in `docs/skill-anatomy.md`.
- Keep operational workflow rules in `AGENTIC_LOOP.md` and `skills/` in this repo, preserving target-facing `agenticloop/...` references inside installed assets.
- Do not keep historical cleanup plans in active docs; use git history for that.

## Change Hygiene

- Keep changes scoped to the current task.
- Do not revert user changes unless explicitly asked.
- Do not commit secrets, local session stores, temporary outputs, generated caches, or runtime logs.
- Keep scratch files inside `.agenticloop/tmp/` when a temporary file is genuinely required.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
