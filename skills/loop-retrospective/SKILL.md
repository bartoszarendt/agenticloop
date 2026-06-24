---
name: loop-retrospective
description: Parked, human-invoked skill. Use when a human explicitly asks for a retrospective that turns repeated agent-process friction into durable improvements. Converts repeated blocked categories, check failures, review iterations, or recurring follow-up topics drawn from event logs into skill updates, docs entries, or follow-up task records. Not part of the closeout gate.
metadata:
  area: process-improvement
  status: parked
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: none
---

# Loop retrospective

Loop retrospectives turn observed friction into durable process improvements. The output is never private memory; every retained lesson becomes reviewed text in the repo or a task record a later agent can discover.

This skill is **parked and optional**. It is not part of [[task-closeout]] and does not gate it. Run it only when a human explicitly asks for a retrospective, and only when there is enough recorded signal to work from. Its primary inputs are the local event logs and blocked/needs_context events — not task completion summaries, which are written for a different purpose. Until event logging matures into routine use, this skill will usually have nothing durable to act on; that is expected.

## Workflow

1. **Gather signals.** Read the local `.agenticloop/logs/<TASK-ID>.jsonl` event log entries (when event logging is enabled and files exist), blocked and needs_context events, recorded block categories, review-result events across rounds, and recurring follow-up task topics. Do not reconstruct friction from task completion summaries or copy raw agent exchanges into docs.
2. **Find recurring patterns.** Treat repeated check failures, repeated block categories, repeated review rounds, and repeated follow-up themes as candidates. Do not turn one-off noise into new process.
3. **Choose one durable artifact per pattern.**
   - Update a skill when the pattern is a recurring agent behavior or rationalization.
   - Add a docs entry when the pattern is a durable out-of-scope decision, known limitation, or operational note.
   - File a follow-up task record when the pattern requires implementation or human decision.
4. **Keep provenance visible.** Cite grouping ids when relevant, task ids, artifact references, and command evidence. Do not promote interpretation into fact without evidence.

## Anti-pattern

Wrong:

```text
Agents struggled with reviews again. Remember to be more careful next time.
```

Right:

```text
Three related tasks had missing final check output. Add a rationalization row to [[verification-evidence]] countering "the log is too long to paste", and cite the affected task ids in the closeout comment.
```

## Checklist

- Repeated patterns were separated from isolated task noise.
- Every retained pattern became one reviewed artifact: skill row, docs entry, or follow-up task record.
- Each artifact cites task-record, artifact, or command evidence.
- No private memory store or raw transcript dump was used.

## See also

- [[task-closeout]]
- [[blocked-state]]
- [[verification-evidence]]
- [[debugging-before-fixes]]
