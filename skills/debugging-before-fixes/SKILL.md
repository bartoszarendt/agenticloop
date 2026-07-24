---
name: debugging-before-fixes
description: Use the moment a required check, test, build, or runtime behavior fails or surprises – before proposing or applying any fix, including on every needs_revision iteration that involves a defect. Defines feedback-loop-first debugging, root-cause phases, calibrated hypotheses, tagged debug instrumentation, confirmed root-cause reporting, and the stop rule after 3 failed fix attempts.
metadata:
  area: engineering-discipline
  side_effects: writes-tmp
  credentials: none
  runs_scripts: optional
---

# Debugging before fixes

No fix without a root cause first. Patching symptoms burns review iterations and often adds a second bug. Guess-and-check thrashing is how tasks end blocked or review-exhausted under [[blocked-state]].

## Step 1: build the feedback loop

Before investigating or fixing, stand up a fast, deterministic, agent-runnable loop that reproduces the failure on demand. Reach for the highest item on this list that actually reproduces the failure:

1. A failing unit, integration, or browser test.
2. The targeted command from the task record's Required Checks.
3. A `curl` or API smoke call against the dev stack.
4. A small CLI or script run against a checked-in fixture.
5. Replaying a captured payload, request, or log line through the failing code.
6. A throwaway harness in `.agenticloop/tmp/` that calls the failing unit directly.
7. A fuzz or property loop when the triggering input is unknown.
8. `git bisect` or a differential loop when a previously passing behavior regressed.

Prefer the cheapest deterministic loop that still fails for the real reason. Capture the exact command: it becomes RED proof for [[tdd-implementation]] and evidence for [[verification-evidence]].

## Phase 2: investigate

- Read the entire error message and stack trace.
- Run the Step 1 loop and watch the real failure.
- Diff what changed.
- Trace the bad value or state back to where it originates.

## Phase 3: compare

Find code in this repo that does the same kind of thing and works. Read the reference fully, then list concrete differences between it and the broken path.

## Phase 4: hypothesize and test

Calibrate effort to the failure:

- If the output fully explains a trivial error, fix it directly.
- If the failure is non-obvious, not fully explained, or already survived one fix attempt, write 3-5 ranked falsifiable hypotheses before changing code.

Put each hypothesis in this form:

```text
If X is the cause, then observing or changing Y should produce Z.
```

Test hypotheses in rank order with the smallest observation or change that discriminates. Wrong hypotheses are reverted and recorded as ruled out.

## Phase 5: fix

Lock the root cause in with a failing test or failing check, apply one fix, then run the full Required Checks fresh.

The implementation summary must state the confirmed root cause. A bugfix summary that cannot name the cause is a symptom patch.

## Tagged debug instrumentation

Temporary logging, prints, dumps, or asserts added while debugging must use a `[DEBUG-<tag>]` prefix:

```text
log.warning("[DEBUG-fetch] payload=%r", payload)
```

Before claiming completion, scan the changed runtime files for `[DEBUG-` and show the clean result. Scope the scan to files touched by the task. The marker convention appears in docs and [[review-and-accept]], so a repo-wide scan will find legitimate documentation references.

No debug marker may survive into the implementation artifact.

## Stop rule

After failed fix attempts exhaust the attempt budget (default 3, or the task record's `attempt_budget`; see Attempt Budget in `agenticloop/AGENTIC_LOOP.md`), stop fixing. The problem is likely a wrong assumption, contract gap, or architecture conflict.

- Before a GitHub PR exists on GitHub-backed work, post a `needs_context` request through [[blocked-state]].
- For files-backed work, record the same `needs_context` state in the task file through [[blocked-state]].
- During review, raise the issue in the revision summary.
- If genuinely stuck, record a blocked state.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Quick fix now, root cause later" | Later rarely comes; the symptom returns in review. |
| "Just try changing X and see" | That is a hypothesis. State it, test it minimally, and revert it if wrong. |
| "It's a small bug, no need for process" | Investigation is minutes; thrashing costs an iteration. |
| "One more attempt" | After multiple failed attempts, the next guess is usually wrong too. |
| "These logs are temporary" | Untagged temporary logs are the ones that ship. |

## Red flags

- Fixing before a reproduction loop exists.
- Editing code before reading the whole error.
- Two changes in flight for one failure.
- You cannot state the hypothesis your change is testing.
- A bugfix summary cannot name the confirmed root cause.
- A `[DEBUG-...]` marker is still in the diff.