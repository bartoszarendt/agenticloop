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
- Required downstream tooling should become Node-based and runnable through `npx`. Python, PowerShell, and Bash must not become required user-facing dependencies.

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

_Currently proposed or in-progress. Implemented phases are listed under Completed._

## Completed Phases

### Phase 01 — Documentation and Positioning Reset
**Status:** done (2026-06-15)
**Goal:** make the repository understandable as a Markdown-first workflow toolkit and remove stale controller/runtime language.
See [PLAN-PHASE-01.md](./PLAN-PHASE-01.md) for full task breakdown.

### Phase 02 — Backend-Neutral Task Records
**Status:** done (2026-06-15)
**Goal:** separate the workflow vocabulary from GitHub so the same loop can work with GitHub or local files.
See [PLAN-PHASE-02.md](./PLAN-PHASE-02.md) for full task breakdown.

### Phase 03 — OpenCode Smoke Test
**Status:** done (2026-06-15)
**Goal:** run the current Markdown-first loop once in a real target project before building CLI automation.
See [PLAN-PHASE-03.md](./PLAN-PHASE-03.md) for full task breakdown.

### Phase 04 — Minimal Node CLI
**Status:** CLI scaffold complete (2026-06-15). Guardrail hardening landed (2026-06-17). Live delegation tests still pending.
**Goal:** replace maintenance-only Python/PowerShell entry points with a small cross-platform CLI for setup and validation.
See [PLAN-PHASE-04.md](./PLAN-PHASE-04.md) for full task breakdown.

### Phase 05 — Host Adapter Expansion
**Status:** done (2026-07-10). All five implemented adapters are supported.
**Goal:** make Agentic Loop installable or usable in selected agent hosts without duplicating skill source.
See [PLAN-PHASE-05.md](./PLAN-PHASE-05.md) for full task breakdown.

### Phase 06 — Quality Horizon
**Status:** done (2026-06-16)
**Goal:** add quality evidence only after the core loop and setup path are stable.
See [PLAN-PHASE-06.md](./PLAN-PHASE-06.md) for full task breakdown.

### Phase 07 — Distribution Readiness
**Status:** done (2026-06-16)
**Goal:** make Agentic Loop ready to install and use from normal target projects.
See [PLAN-PHASE-07.md](./PLAN-PHASE-07.md) for full task breakdown.

### Phase 08 — Files-First Simplification
**Status:** done (2026-06-16)
**Goal:** make the default Agentic Loop workflow Markdown-first and files-first.
See [PLAN-PHASE-08.md](./PLAN-PHASE-08.md) for full task breakdown.

### Phase 09 — Task-First Project Shape
**Status:** done (2026-06-16)
**Goal:** remove the remaining phase-specific assumptions from Agentic Loop and make the task record the only required workflow atom.
See [PLAN-PHASE-09.md](./PLAN-PHASE-09.md) for full task breakdown.

### Phase 10 — Codex Adapter Validation
**Status:** done (2026-07-10)
**Goal:** Codex adapter is now supported. Automated validation covers generation, configuration, and smoke protocol documentation.
See [PLAN-PHASE-10.md](./PLAN-PHASE-10.md) for full task breakdown.

### Phase 11 — Host-Skill Surface Unification
**Status:** done (2026-06-19)
**Goal:** keep many canonical skills as the source of truth, but expose each host's generated skill surface as one public activation skill plus internal procedure copies.
See [PLAN-PHASE-11.md](./PLAN-PHASE-11.md) for full task breakdown.

### Phase 12 — Copilot Adapter
**Status:** done (2026-07-10)
**Goal:** GitHub Copilot adapter is now supported with first-class generation, validation, and smoke protocol documentation.
See [PLAN-PHASE-12.md](./PLAN-PHASE-12.md) for full task breakdown.

### Phase 13 — Target Layout and Template Source Unification
**Status:** implemented (2026-06-21)
**Goal:** separate target-owned workflow state from toolkit-owned canonical source.
See [PLAN-PHASE-13.md](./PLAN-PHASE-13.md) for full task breakdown.

### Phase 14 — Toolkit Source at Repository Root
**Status:** complete (2026-06-24). Implemented atomically with Phase 15.
**Goal:** make the toolkit repository legible as a published package. Canonical source at root; installer maps into `agenticloop/` namespace in targets.
See [PLAN-PHASE-14.md](./PLAN-PHASE-14.md) for full task breakdown.

### Phase 15 — Memory Source and Config Naming Cleanup
**Status:** complete (2026-06-24). Implemented atomically with Phase 14.
**Goal:** make the repository layout explain the product categories directly. `memory/`, `config.json`, `agenticloop.template.json`.
See [PLAN-PHASE-15.md](./PLAN-PHASE-15.md) for full task breakdown.

### Phase 16 — Decision Discovery Without Indexes
**Status:** done (2026-06-22)
**Goal:** remove the decision-only index in favor of contextual decision discovery.
See [PLAN-PHASE-16.md](./PLAN-PHASE-16.md) for full task breakdown.

### Phase 17 — Unified Work-Unit Summary Contract
**Status:** approved (2026-06-22)
**Goal:** replace three divergent summary templates with one scope-parameterized work-unit summary contract.
See [PLAN-PHASE-17.md](./PLAN-PHASE-17.md) for full task breakdown.

### Phase 18 — Guided Setup and Model Onboarding
**Status:** done (2026-06-22)
**Goal:** make onboarding a new target repository friendly, inspectable, and recoverable.
See [PLAN-PHASE-18.md](./PLAN-PHASE-18.md) for full task breakdown.

### Phase 19 — Proof Pressure and Output Refs
**Status:** Track 1 landed (2026-06-27). Track 2 deferred.
**Goal:** strengthen task proof, scope evidence, and slice-sizing language.
See [PLAN-PHASE-19.md](./PLAN-PHASE-19.md) for full task breakdown.

### Phase 20 — Adoption Map and Context Discipline
**Status:** T-02, T-09, T-10 implemented (2026-06-27). Remainder proposed.
**Goal:** improve adoption map and context-discipline for delegated agents.
See [PLAN-PHASE-20.md](./PLAN-PHASE-20.md) for full task breakdown.

### Phase 21 — Concurrency And Subagent Liveness
**Status:** partially implemented (2026-06-23)
**Goal:** keep Agentic Loop serial by default with narrow explicit parallel exceptions.
See [PLAN-PHASE-21.md](./PLAN-PHASE-21.md) for full task breakdown.

### Phase 22 — Field-Finding Remediation
**Status:** complete (2026-06-24)
**Goal:** harden the toolkit against path confusion, summary omissions, backend-inappropriate actions, and stale generated artifacts.
See [PLAN-PHASE-22.md](./PLAN-PHASE-22.md) for full task breakdown.

### Phase 23 — Summary Store Removal, Closeout Simplification, Plan Role Demotion
**Status:** complete (2026-06-24)
**Goal:** make per-task inline summary the single summary surface; turn closeout into verify-and-mark gate; park loop-retrospective.
See [PLAN-PHASE-23.md](./PLAN-PHASE-23.md) for full task breakdown.

### Phase 24 — Evidence-Driven Loop Improvement
**Status:** Track 1 implemented (2026-06-27). Track 2 deferred.
**Goal:** let Agentic Loop turn recurring process friction into reviewed, auditable improvement proposals.
See [PLAN-PHASE-24.md](./PLAN-PHASE-24.md) for full task breakdown.

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
