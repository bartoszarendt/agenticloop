# Changelog

## 0.1.0 (Unreleased)

### Added
- Generated-artifact ownership manifest (`.agenticloop/generated-artifacts.json`).
- Collision-safe adapter generation preflight (`src/adapter-output-plan.js`).
- Task lifecycle transition enforcement (draft cannot jump to accepted/closed).
- Acceptance gate requiring `review_status: accepted`, `implementation_artifact`, `## Scope Completed`, and `## Evidence` before accept/close.
- Markdown link validator (integrated into `agenticloop validate`).
- Manifest recording after each adapter generation.
- Contract tests for supported adapter status.

### Changed
- **Breaking:** `draft` tasks must now go through `agent-ready` before `in-progress`.
- Codex marketplace writes now fail closed on malformed JSON instead of silently replacing it.
- Codex legacy skill removal now requires a strong marker or exact generated structure; name-only heuristics removed.
- Claude agent removal now scans all `.claude/agents/*.md` files for the generated marker (supports custom roleBindings filenames).
- Claude settings permissions are now reversibly reconciled during removal.
- `plugins/agenticloop` removal now checks for unknown content before deleting.
- Dry-run removal now reports the same planned file actions as real removal.
- `removeAgenticLoopMarketplaceEntry` preserves malformed marketplace JSON byte-for-byte.

### Fixed
- Duplicated "Required downstream tooling..." bullet in `.dev/PLAN.md`.
- Active Phases now lists partial/deferred/approved-only work; Completed only lists finished work.
- `PLAN-PHASE-07.md` no longer calls Claude plugin packaging "experimental".
- `docs/codex-setup.md` smoke protocol is now explicitly optional/advisory.
- Remaining "live delegation tests still pending" moved to Active Phases.

### Removed
- Unused config role fields: `responsibilities`, `canEditImplementationFiles`, `canEditDocs`.
- Broken installed `AGENTIC_LOOP.md` link to `docs/workflow-examples.md`.
