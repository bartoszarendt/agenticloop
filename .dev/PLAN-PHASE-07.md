## Phase 07 — Distribution Readiness

**Status:** complete as of 2026-06-16.

**Goal:** make Agentic Loop ready to install and use from normal target projects without turning it into a deterministic controller, duplicating host-specific source, or shipping this repository's own maintenance contracts as downstream project files.

See [PLAN.md](./PLAN.md) for the main implementation plan and phase references.

Reference findings:

- The hyphenated npm package name is unavailable. The public package uses the available unscoped name `agenticloop`; the installed CLI command, config filenames, generated comments, and task directories also use the `agenticloop` name. GitHub repository URLs use `bartoszarendt/agenticloop`.
- Distribution should include publish metadata, provenance, release readiness checks, interactive setup, host/editor profiles, and model configuration UX. Heavier MCP/tool marketplace surfaces are not the right default for Agentic Loop.
- Agentic Loop should keep Node/npx as the required cross-platform install path; any shell scripts must remain optional thin wrappers, not a second installer contract.
- Independent review feedback was useful on config hygiene, glossary distribution, and setup UX. Codex and Claude Code project-local manifests are already generated adapter artifacts, but marketplace packaging is not yet an active supported surface.

| Task | Status | Description |
|---|---|---|
| G-01 | Done | Rename the public surface to `agenticloop`: npm package, CLI binary, generated comments, config files (`agenticloop.json`, `agenticloop.base.json`), task directories (`.agenticloop/`), plugin manifest names, docs examples, and GitHub repository URL (`bartoszarendt/agenticloop`). |
| G-02 | Done | Add publish-grade package metadata: `license`, `repository`, `homepage`, `bugs`, `keywords`, `packageManager`, and `publishConfig` with public access and npm provenance. Add a tracked `LICENSE`. |
| G-03 | Done | Revisit the npm `files` allowlist so the package includes all user-facing setup docs needed by README links, especially `docs/getting-started.md`, setup guides, host adapter docs, skill anatomy, workflow examples, and registry-horizon. Keep toolkit-internal plans and scratch files excluded. |
| G-04 | Done | Add CI for distribution readiness: `npm test`, `node bin/agenticloop.js validate`, and `npm pack --dry-run`. Add a release workflow only after package metadata and naming are final; prefer npm trusted publishing/provenance. |
| G-04 correction | Done | CI was marked Done on 2026-06-16, but no workflow was ever committed; restored on 2026-07-07. |
| G-05 | Done | Split public target config from this repository's own working config. `agenticloop init` must not ship project-specific or unverified model IDs such as this repo's current role settings. Use a clean target template with empty settings, explicit placeholders, or values collected by setup. |
| G-06 | Done | Remove root `CONTEXT.md` from the active toolkit contract. Keep stable Agentic Loop vocabulary in `docs/glossary.md`, and keep `documents.required.context` optional/remappable for target projects that have a separate context file. |
| G-07 | Done | Generalize `agenticloop init --opencode` into `agenticloop init --adapter <opencode|codex|claude-code|all>`, with `--opencode` retained only as a compatibility alias if useful. Init should scaffold canonical assets and generate selected adapter output in one pass. |
| G-08 | Done | Add model setup UX: `agenticloop configure models --adapter <host>` prompts for model and reasoning effort per logical role when run without `--role/--model`; `agenticloop init --setup --adapter <host>` scaffolds, prompts, writes settings, and regenerates adapter output. Host detection is advisory (looks for `.opencode/agents/*.md` or `.opencode/commands/agenticloop.md`, `.codex/agents/`, optional `plugins/agenticloop/.codex-plugin/`, legacy `.codex-plugin/`, and `.claude/agents/`). Non-interactive `--role/--model` flags remain available for CI. |
| G-09 | Done | Add adapter discovery via `agenticloop status` and validation output. Reports configured adapters, present artifacts, unset models, and the next command. Optional configured adapters with no generated artifacts do not produce misleading "all complete" text; required adapters drive generate/configure recommendations; fully resolved required adapters recommend `agenticloop validate`. |
| G-10 | Done | Add a clear docs section distinguishing target-owned files, toolkit-owned refreshable assets, and generated host artifacts. Explicitly state that target projects keep their own `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, `README.md`, and architecture docs; Agentic Loop overlays them rather than replacing them. |
| G-11 | Done | Decide whether to add optional shell installers. If added, `install.sh` and `install.ps1` must be thin wrappers around the Node CLI and must not copy assets or generate host config through an independent code path. |
| G-12 | Done | Claude Code supports two install modes. Root `.claude-plugin/` packaging is tracked for Mode A plugin installs, while repo-local Mode B generation stays under `.claude/commands/agenticloop.md`, `.claude/agents/`, and `.claude/skills/agenticloop/`. `.claude-plugin/` is not generated into target repos. |

Verification note: the old hyphenated npm name is unavailable, so `agenticloop` is the only public command surface for this toolkit. Repository URLs use `bartoszarendt/agenticloop`.

Acceptance criteria:

- A new downstream user can install from npm with `npx agenticloop ...` and run the CLI binary as `agenticloop`.
- The npm package tarball contains every user-facing doc linked from README and no toolkit-internal roadmap, raw transcripts, generated caches, or scratch files.
- `agenticloop init` never overwrites target-owned project docs and does not seed target config with this repository's private model choices.
- A target project can choose at least one host adapter during init and get the generated host artifacts without hand-copying prompts or model fields.
- Model identifiers and reasoning effort remain adapter-local settings, collected through setup or explicitly edited in target config; canonical `agents/` remain host-neutral and model-free.
- The glossary and source-document vocabulary are available to downstream agents through `docs/glossary.md` without requiring a toolkit-owned root context file.
- Public docs explain the difference between toolkit-owned refreshable assets, target-owned docs/config, and generated host output.
- CI verifies tests, validation, and package contents before release.
- Claude Code plugin packaging is a controlled surface at the toolkit root; repo-local Claude Code adapter output remains separate and does not generate `.claude-plugin/` into target repos.
