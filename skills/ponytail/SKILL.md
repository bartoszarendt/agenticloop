---
name: ponytail
description: Use when the current role is maintainer or engineer and the user explicitly asks for ponytail, lazy mode, YAGNI, simplest solution, minimal solution, do less, shortest path, or minimalist implementation discipline. Do not use for orchestrator coordination or instead of Agentic Loop task-record, TDD, evidence, review, blocked-state, or change-request gates.
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

## When to use

- Only when the current role is maintainer or engineer.
- Only when the user explicitly asks for ponytail, lazy mode, YAGNI, the simplest solution, the minimal solution, the shortest path, or similar minimalist discipline.
- Use it to reduce over-building inside accepted scope, not to argue away required work after the fact.
- Default intensity is `full`.

## Intensity

- `lite`: build what was asked, then briefly mention the lazier alternative.
- `full` (default): enforce the ladder within the accepted task scope and ship the shortest working solution.
- `ultra`: aggressively challenge unnecessary work, but only through the allowed Agentic Loop gates. Ultra may recommend descoping. Ultra must not silently drop any task-record criterion. If a criterion seems unnecessary, route it through [[change-request-gate]] when it changes a locked decision, or [[blocked-state]] with `needs_context` when the task record needs human clarification.

## Minimalism ladder

Stop at the first rung that satisfies the task record:

1. Does this need to exist at all?
2. Can stdlib do it?
3. Can native platform features do it?
4. Can an already-installed dependency do it?
5. Can deletion solve it?
6. Can one line solve it?
7. Otherwise write the minimum code that satisfies the task record.

Take the highest valid rung and move on. Do not turn the ladder into a research project.

When you deliberately stop short of a fuller solution, leave a short comment at the simplification naming its ceiling and the upgrade path, for example `// single-process only; swap for a queue if this needs to fan out`. This keeps the shortcut auditable at [[review-and-accept]] instead of looking like an oversight.

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
3. Walk the ladder quickly. Prefer deletion, existing platform capability, or already-present tools over new code.
4. If code is still needed, write the minimum change that satisfies the accepted scope.
5. If behavior changes, still follow [[tdd-implementation]]. Ponytail changes the implementation strategy, not the RED-GREEN-REFACTOR obligation.
6. Before any done or green claim, attach fresh output through [[verification-evidence]].
7. Hand review and acceptance back through [[review-and-accept]].
8. If the laziest valid path conflicts with a locked decision or unclear task record, stop and use [[change-request-gate]] or [[blocked-state]] instead of freelancing a scope change.

Maintainer use is similar: keep task shaping, review findings, and follow-up recommendations as small as the accepted criteria allow, without weakening those criteria.

## Red flags

- Adding a new dependency before checking stdlib, native features, or already-installed dependencies.
- Creating abstractions, scaffolding, or extra files for hypothetical future work.
- A deliberate simplification with no comment naming its ceiling and upgrade path, leaving reviewers unable to tell intent from oversight.
- Reaching for the clever construct where a boring, obvious one reads the same and survives the 3am page.
- Treating `ultra` as permission to silently drop acceptance criteria or required checks.
- Calling something complete without the evidence required by [[verification-evidence]].
- Using Ponytail to bypass review, blocked-state handling, or a locked-decision gate.

## See also

- [[tdd-implementation]]
- [[verification-evidence]]
- [[review-and-accept]]
- [[blocked-state]]
- [[change-request-gate]]

## Sources

- Adapted from the MIT-licensed upstream Ponytail skill: https://github.com/DietrichGebert/ponytail
