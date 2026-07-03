---
name: ponytail
description: Use when the current role is maintainer or engineer and either the human explicitly asks for ponytail, lazy mode, YAGNI, simplest solution, minimal solution, do less, shortest path, or minimalist implementation discipline, or the active task record sets minimalism: lite, minimalism: full, or minimalism: ultra, or the minimalism level is being selected during task creation. The task-record minimalism field selects Ponytail intensity. Omitted or minimalism: none does not activate Ponytail. Do not use for orchestrator coordination or instead of Agentic Loop task-record, TDD, evidence, review, blocked-state, or change-request gates.
metadata:
  area: engineering-discipline
  side_effects: writes-files
  credentials: none
  runs_scripts: optional
---

# Ponytail

## Purpose

Ponytail is an opt-in minimalism discipline for maintainer and engineer work. It pushes for the least code, fewest files, and smallest accepted change that still satisfies the current task record.

Lazy means efficient, not careless. The cost being avoided is the over-engineered codebase and the 3am page for behavior nobody needed. Prefer boring over clever: clever is what someone has to decode under pressure later.

Ponytail is necessity-driven reduction, not clever terseness. Do not pick a flimsier algorithm just because it is shorter. Boring, correct, readable code beats clever one-liners. Minimalism must not remove validation, error handling that prevents data loss, security, accessibility, required checks, or explicit requirements.

## When to use

- Only when the current role is maintainer or engineer.
- When the human explicitly asks for ponytail, lazy mode, YAGNI, the simplest solution, the minimal solution, the shortest path, or similar minimalist discipline; **or** when the active task record sets `minimalism: lite`, `minimalism: full`, or `minimalism: ultra`; **or** when the maintainer is selecting the task-record `minimalism` level during task creation.
- Task-record `minimalism` selects intensity: `lite`, `full`, or `ultra` as set in the task record. Omitted or `minimalism: none` does not activate Ponytail.
- `ultra` from a task record is valid only with explicit human request or authorization. Maintainers must not auto-select `ultra`.
- Use it to reduce over-building inside accepted scope, not to argue away required work after the fact.
- Default intensity is `full`.

## Intensity

- `lite`: build what was asked, then briefly mention the lazier alternative.
- `full` (default): enforce the ladder within the accepted task scope and ship the shortest working solution.
- `ultra`: aggressively challenge unnecessary work or accumulated complexity, but only through the allowed Agentic Loop gates. Ultra may recommend descoping or push back on incidental complexity that has crept in. Ultra must not silently drop any task-record criterion. If a criterion seems unnecessary, route it through [[change-request-gate]] when it changes a locked decision, or [[blocked-state]] with `needs_context` when the task record needs human clarification. Ultra never bypasses task-record criteria; it questions whether the criteria serve the accepted outcome.

## Minimalism ladder

First understand the problem. Read the task record, identify the exact requirement, and confirm the acceptance criteria. The ladder runs after understanding the problem, not instead of it.

Then stop at the first rung that satisfies the task record:

1. Does this need to exist? If not, skip it or delete it inside accepted scope.
2. Does it already exist in this codebase? Reuse the helper, pattern, type, component, command, or convention already present.
3. Can the standard library do it?
4. Can a native platform feature do it?
5. Can an already-installed dependency do it?
6. Can one line solve it?
7. Otherwise write the minimum code that satisfies the accepted task record.

Take the highest valid rung and move on. Do not turn the ladder into a research project.

### Root-cause bug fixes

A bug report names a symptom. Before touching a shared function, inspect relevant callers. The Ponytail fix is usually the smallest shared or root-cause fix, not one guard in every caller. A tiny patch in the wrong place is not minimalism; it is a second bug.

### Auditable simplifications

When you deliberately stop short of a fuller solution, leave a comment using the native syntax plus `ponytail:` to name the ceiling and the upgrade trigger:

```
// ponytail: single-process only; use a queue if fan-out becomes required
# ponytail: O(n^2) scan is fine under current input size; replace with indexed lookup if this path becomes hot
```

The comment names the ceiling and upgrade trigger. This makes simplifications auditable during review and gives Agentic Loop a Markdown-native debt ledger via grep, without adding a separate tracking command.

Do not leave a simplification without this marker. A deliberate shortcut with no marker looks like an oversight at review time.

## Examples

### Native platform over dependency

A task asks for a date picker. Before pulling in a date-picker library, check the platform:

```html
<!-- ponytail: native input covers current requirements; add a library only if custom formatting or range selection becomes required -->
<input type="date" />
```

The native `<input type="date">` handles validation, keyboard access, and mobile affordances. A library is justified only when the task record requires capabilities the native input cannot provide.

### Existing codebase helper over new abstraction

A task needs to format a relative timestamp. Before writing a new utility, check if the codebase already has one:

```js
// Reuse existing formatRelativeTime helper from utils/time.js
import { formatRelativeTime } from '../utils/time';
```

If the helper exists and covers the requirement, use it. If it is close but not exact, extend the existing helper rather than creating a parallel one. Only write a new utility when the existing one cannot be extended without breaking its current callers.

## Guardrails

Ponytail never overrides:

- task record scope,
- acceptance criteria,
- out-of-scope boundaries,
- [[tdd-implementation]] or required checks,
- [[verification-evidence]],
- maintainer review through [[review-and-accept]],
- [[blocked-state]] handling,
- [[change-request-gate]],
- security,
- input validation at trust boundaries,
- accessibility basics,
- explicit human requirements.

## Process

1. Read the current task record and identify the exact requirement being worked.
2. Pick the current intensity. Default to `full` unless the user explicitly asks for a lighter (`lite`) or more aggressive (`ultra`) stance.
3. Understand the problem first, then walk the ladder quickly. Prefer reuse, existing platform capability, or already-present tools over new code.
4. For bug reports, inspect callers before touching a shared function. Fix at the root cause.
5. If code is still needed, write the minimum change that satisfies the accepted scope.
6. If behavior changes, still follow [[tdd-implementation]]. Ponytail changes the implementation strategy, not the RED-GREEN-REFACTOR obligation.
7. Before any done or green claim, attach fresh output through [[verification-evidence]].
8. Hand review and acceptance back through [[review-and-accept]].
9. If the laziest valid path conflicts with a locked decision or unclear task record, stop and use [[change-request-gate]] or [[blocked-state]] instead of freelancing a scope change.

Maintainer use is similar: keep task shaping, review findings, and follow-up recommendations as small as the accepted criteria allow, without weakening those criteria.

## Red flags

- Adding a new dependency before checking stdlib, native features, or already-installed dependencies.
- Creating abstractions, scaffolding, or extra files for hypothetical future work.
- A deliberate simplification with no `ponytail:` comment naming its ceiling and upgrade path, leaving reviewers unable to tell intent from oversight.
- Reaching for the clever construct where a boring, obvious one reads the same and survives the 3am page.
- Picking a flimsier algorithm just because it is shorter.
- Treating `ultra` as permission to silently drop acceptance criteria or required checks.
- Calling something complete without the evidence required by [[verification-evidence]].
- Using Ponytail to bypass review, blocked-state handling, or a locked-decision gate.
- Patching a symptom in every caller instead of fixing the root cause in the shared function.

## Boundaries

This Agentic Loop skill intentionally does **not** port:

- upstream Ponytail slash commands,
- upstream Ponytail hooks,
- upstream Ponytail MCP server,
- upstream env-var or config mode persistence,
- upstream statusline behavior,
- upstream benchmark/gain scoreboard,
- upstream always-on session mode,
- the upstream "code first, <=3-line explanation" output rule.

Agentic Loop uses task-record `minimalism` for auditable per-task activation and Agentic Loop's evidence and review summaries override terse-output rules. Ponytail discipline applies only when the task record or human explicitly opts in, not as a permanent session mode.

## See also

- [[tdd-implementation]]
- [[verification-evidence]]
- [[review-and-accept]]
- [[blocked-state]]
- [[change-request-gate]]

## Sources

- Adapted from the MIT-licensed upstream Ponytail skill: https://github.com/DietrichGebert/ponytail
