---
name: tdd-implementation
description: Use when implementing any code change for a task – new behavior, a bugfix, or a revision after review – before writing the production code. Defines the failing-test-first cycle, public-seam testing, vertical slices, scaffold and infra handling, and counters to common excuses for tests-after-code.
metadata:
  area: engineering-discipline
  side_effects: writes-files
  credentials: none
  runs_scripts: optional
---

# TDD implementation

No production code without a failing test or failing check first when behavior changes. A test written after the code passes immediately and proves little: it never demonstrated that it can catch the missing behavior.

## The cycle

1. **RED**: write one minimal test or check for the next required behavior from the task record.
2. **Verify RED**: run it and confirm it fails for the expected reason.
3. **GREEN**: write the smallest production change that passes.
4. **Verify GREEN**: run the focused check, then the task's Required Checks.
5. **REFACTOR**: clean names and duplication while everything is green.

Keep the RED output. The implementation summary needs it under [[verification-evidence]].

For bugfixes, RED is the reproduction of the bug. For review revisions, RED covers the gap identified by [[review-and-accept]].

If production code already exists before its test, temporarily disable or revert the behavior, watch the new test fail, then restore the behavior. Otherwise the test is unverified.

## Test through a public seam

Use the highest useful public interface that exercises the behavior:

- service or repository method,
- API route,
- CLI command,
- rendered component,
- user-facing workflow.

Assert observable behavior, not private helper calls or internal fields. Prefer real collaborators over mocks where practical.

## Vertical slices

Do not write a batch of imagined tests and then a batch of implementation. Run one behavior at a time:

```text
RED -> GREEN -> REFACTOR
RED -> GREEN -> REFACTOR
```

Horizontal slicing hides which behavior is actually being built and encourages brittle tests.

## Scaffold and infra tasks

Some tasks have no unit-testable behavior. The principle still applies through the Required Checks:

- config validation,
- lint/typecheck,
- smoke command,
- migration dry run,
- package/build command.

If a task is genuinely unverifiable, say so under Known Limitations. Do not write fake tests just to satisfy a checklist.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Too simple to break" | Simple code breaks. The test is cheaper than the review bounce. |
| "I'll add tests after" | Tests-after prove what the code does, not what it should do. |
| "I ran it manually" | Manual checks disappear on the next edit. |
| "The code is already written" | Disable it, watch the test fail, restore it. |
| "No time" | A missed regression costs more than a focused RED check. |

## Red flags

- Production code exists and no failing test or check ever covered it.
- A new test passed on its first run and nobody explained why.
- The RED output is missing from the summary.
- Tests assert private implementation instead of behavior.
- A batch of failing tests exists ahead of implementation.

## See also

- [[verification-evidence]]
- [[review-and-accept]]
- [[ponytail]] when the task record sets `minimalism: lite|full|ultra` or the user explicitly asks for YAGNI/minimalism, while still preserving RED-GREEN-REFACTOR and required evidence.
- [[frontend-design-quality]] when the behavior under test is a UI component or screen.