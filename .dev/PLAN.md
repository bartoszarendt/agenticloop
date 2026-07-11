# Agentic Loop Implementation Plan

## Purpose

This plan describes the forward path for Agentic Loop as a simple, portable, Markdown-first workflow toolkit for AI agents.

Agentic Loop should make existing agents more reliable by giving them reusable skills, role boundaries, and a repeatable implementation loop. It should not become a heavy controller, a prompt dump, or a registry before the core workflow is easy to understand and adopt.

## Product Direction

Locked direction:

- Markdown is the product surface. Skills and workflow docs must be useful without a custom runtime.
- The loop is core. Users need a recognizable start path and clear role responsibilities.
- `agents/` is the canonical source for host-neutral role definitions.
- `backends/` is the canonical source for task backend projection docs.
- Host support is adapter-oriented. All five implemented adapters (OpenCode, Claude Code, Codex, Copilot, and Cursor) are supported.
- `skills/` remains the single canonical skill source.
- The default backend is files (local Markdown task records). GitHub issues and pull requests are an optional projection. (Superseded: GitHub was the durable default before Phase 07.)
- Required downstream tooling should become Node-based and runnable through `npx`. Python, PowerShell, and Bash must not become required user-facing dependencies.
- Bash or PowerShell wrappers may exist later as optional conveniences only; they are not the cross-platform product contract.
- Registry, evals, traces, and trust metadata are future horizons, not MVP scope.

## Non-Goals

- No deterministic autonomous controller.
- No required Bash-only, PowerShell-only, or Python-only scripts.
- No checked-in host-specific copies of skills.
- No checked-in host-specific copies of role definitions.
- No duplicated GitHub/files workflow trees.
- No public generated reference docs as the user-facing product surface.
- No marketplace or registry build-out before the core loop proves useful.
- No raw agent transcripts in documentation.
- No downstream product code in this repository.

## Active Phases

### Phase 17 — Unified Work-Unit Summary Contract
**Status:** approved (2026-06-22)
**Goal:** replace three divergent summary templates with one scope-parameterized work-unit summary contract.

### Phase 19 — Proof Pressure and Output Refs (Track 2)
**Status:** Track 2 deferred (Track 1 landed 2026-06-27)
**Goal:** strengthen task proof, scope evidence, and slice-sizing language.

### Phase 20 — Adoption Map and Context Discipline (Remainder)
**Status:** remainder proposed (T-02, T-09, T-10 implemented 2026-06-27);
context-discipline refined 2026-07-10 to permit bounded, task-scoped
implementation discovery within a default bound while keeping the normative
context set closed (see Phase 25).
**Goal:** improve adoption map and context-discipline for delegated agents.

### Phase 25 — Review Provenance and Contract Consolidation
**Status:** complete (2026-07-10; follow-up audit passed 2026-07-11)
**Goal:** record how each review was performed and gate acceptance on independent
review when required; make bounded implementation discovery explicit without
weakening context discipline; reduce duplicated runtime contract material by
extracting a canonical `event-logging` skill and giving the delegation status
template a single owner; and add unknown role-key warnings plus per-adapter
generated adapter payload-size regression protection (not exact active prompt size).

**Scope**
- Bounded implementation discovery in `AGENTIC_LOOP.md` Context Read Discipline.
- Artifact-bound review provenance and GitHub review audit, with files-backed
  `reviewed_artifact` enforcement and PR-head markers.
- Canonical `skills/event-logging/SKILL.md`; boilerplate deduplicated across
  roles, skills, methodology, and backends.
- Single-owner delegation status template in `role-delegation`.
- Warn-only unknown `roles.<role>` key validation; generated adapter payload-size and
  contract-ownership regression tests.

**Acceptance**
- `npx agenticloop validate` passes; `npm test` passes.
- Same-session fallback acceptance remains legal unless independent review is
  required; files-backed independent-human review requires a present recorded
  reference, while GitHub audit resolves its review reference via the REST API.
- Independent-human accepted audits require an `APPROVED` current-head review by
  a different explicit GitHub `User`; `needs_revision` audits require a
  `CHANGES_REQUESTED` current-head review by the same constraints.
- Marker fields and the attribution trailer use the same filtered live body; quoted
  markers and trailers inside fenced code blocks, blockquotes, or indented code are
  ignored.
- Follow-up (2026-07-11): markers are discovered from both PR issue comments and
  PR review bodies; GraphQL review bodies are kept separate from normalized REST
  human-review evidence; language-tagged Markdown fences are recognized.


### Phase 21 — Concurrency And Subagent Liveness
**Status:** partially implemented (2026-06-23)
**Goal:** keep Agentic Loop serial by default with narrow explicit parallel exceptions.

### Phase 24 — Evidence-Driven Loop Improvement (Track 2)
**Status:** Track 2 deferred (Track 1 implemented 2026-06-27)
**Goal:** let Agentic Loop turn recurring process friction into reviewed, auditable improvement proposals.

## Completed Phases

### Phase 01 — Documentation and Positioning Reset
**Status:** done (2026-06-15)
**Goal:** make the repository understandable as a Markdown-first workflow toolkit and remove stale controller/runtime language.

### Phase 02 — Backend-Neutral Task Records
**Status:** done (2026-06-15)
**Goal:** separate the workflow vocabulary from GitHub so the same loop can work with GitHub or local files.

### Phase 03 — OpenCode Smoke Test
**Status:** done (2026-06-15)
**Goal:** run the current Markdown-first loop once in a real target project before building CLI automation.

### Phase 04 — Minimal Node CLI
**Status:** CLI scaffold complete (2026-06-15); guardrail hardening landed (2026-06-17)
**Goal:** replace maintenance-only Python/PowerShell entry points with a small cross-platform CLI for setup and validation.

### Phase 05 — Host Adapter Expansion
**Status:** done (2026-07-10). All five implemented adapters are supported.
**Goal:** make Agentic Loop installable or usable in selected agent hosts without duplicating skill source.

### Phase 06 — Quality Horizon
**Status:** done (2026-06-16)
**Goal:** add quality evidence only after the core loop and setup path are stable.

### Phase 07 — Distribution Readiness
**Status:** done (2026-06-16)
**Goal:** make Agentic Loop ready to install and use from normal target projects.

### Phase 08 — Files-First Simplification
**Status:** done (2026-06-16)
**Goal:** make the default Agentic Loop workflow Markdown-first and files-first.

### Phase 09 — Task-First Project Shape
**Status:** done (2026-06-16)
**Goal:** remove the remaining phase-specific assumptions from Agentic Loop and make the task record the only required workflow atom.

### Phase 10 — Codex Adapter Validation
**Status:** done (2026-07-10)
**Goal:** Codex adapter is now supported. Automated validation covers generation, configuration, and smoke protocol documentation.

### Phase 11 — Host-Skill Surface Unification
**Status:** done (2026-06-19)
**Goal:** keep many canonical skills as the source of truth, but expose each host's generated skill surface as one public activation skill plus internal procedure copies.

### Phase 12 — Copilot Adapter
**Status:** done (2026-07-10)
**Goal:** GitHub Copilot adapter is now supported with first-class generation, validation, and smoke protocol documentation.

### Phase 13 — Target Layout and Template Source Unification
**Status:** implemented (2026-06-21)
**Goal:** separate target-owned workflow state from toolkit-owned canonical source.

### Phase 14 — Toolkit Source at Repository Root
**Status:** complete (2026-06-24). Implemented atomically with Phase 15.
**Goal:** make the toolkit repository legible as a published package. Canonical source at root; installer maps into `agenticloop/` namespace in targets.

### Phase 15 — Memory Source and Config Naming Cleanup
**Status:** complete (2026-06-24). Implemented atomically with Phase 14.
**Goal:** make the repository layout explain the product categories directly. `memory/`, `config.json`, `agenticloop.template.json`.

### Phase 16 — Decision Discovery Without Indexes
**Status:** done (2026-06-22)
**Goal:** remove the decision-only index in favor of contextual decision discovery.

### Phase 18 — Guided Setup and Model Onboarding
**Status:** done (2026-06-22)
**Goal:** make onboarding a new target repository friendly, inspectable, and recoverable.

### Phase 22 — Field-Finding Remediation
**Status:** complete (2026-06-24)
**Goal:** harden the toolkit against path confusion, summary omissions, backend-inappropriate actions, and stale generated artifacts.

### Phase 23 — Summary Store Removal, Closeout Simplification, Plan Role Demotion
**Status:** complete (2026-06-24)
**Goal:** make per-task inline summary the single summary surface; turn closeout into verify-and-mark gate; park loop-retrospective.

---

## Phase Template

Use this template when drafting a new phase:

```markdown
### Phase N — \<Title>

**Status:** planned | in progress | done (\<date>)
**Goal:** \<one or two sentences on the outcome>

**Scope**
- \<bullet of in-scope work>

**Out of scope / guardrails**
- \<bullet>

**Acceptance**
- \<verifiable criterion>
```
