---
name: verification-evidence
description: Use before claiming any work state -- done, fixed, passing, green, complete, mergeable -- and whenever a required or cited check times out, is unexpectedly expensive, or needs a retry. Defines the identify-run-read-verify gate, timeout evidence and retry records, and the baseline/lane-final/integrated/post-merge verification topology with evidence-identity and reuse rules.
metadata:
  area: engineering-discipline
  side_effects: writes-backend
  credentials: backend-dependent
  runs_scripts: optional
---

# Verification evidence

Evidence before claims, always. A success claim without a fresh run behind it is misreporting, not optimism.

## The gate

Before any "done", "fixed", "passing", "green", or "complete" claim:

1. **Identify** the command or check that proves the claim.
2. **Run** it fresh after the last edit.
3. **Read** the full output and exit code.
4. **Verify** that the output supports the claim.
5. **Attach** the relevant evidence to the task record, implementation summary, review, or closeout.

Skipping a step and claiming anyway is a blocking defect.

## Evidence style

Prefer concise verdict lines and the relevant excerpts that prove the claim over
pasting full terminal dumps. The agent must still read the full command output
before claiming success; the summary that is attached can be compact. Use the
existing inline work-unit summary sections (`## Artifacts`, `## Evidence`, `##
Deviations`, `## Process Observations`, `## Known Gaps`, `## Follow-Ups`, and
optional `## Trace`) and event-log `refs`/`data` for structured facts. Do not
create a second parseable receipt block. Output refs remain a deferred policy;
do not create or rely on them now.

## Current evidence and exceptional history

Current final-state evidence and verification-attempt history are separate.
Record every required check's final-state verdict in the canonical current
implementation summary for the exact artifact under review. For GitHub-backed
work, the mutable PR body is the canonical current-head `## Evidence` surface;
for files-backed work, retain the current task-summary location and its existing
exact-artifact rule.

Verification-attempt history is exceptional execution history, not a second
mandatory copy of routine successful final-state results. Do not create an
attempt carrier for a routine first-pass success. Put that success in current
evidence and, when event logging is enabled, in the `check.run` event. Start or
append exceptional history only for a failed, timed-out, blocked, retried,
escalated, strategy-changed, or maintainer-triaged check, or for a later attempt
that resolves an existing exceptional episode.

For `accepted` or `closed` work, the latest attempt in each recorded exceptional
episode must either pass or have final maintainer triage. A latest `failed`,
`blocked`, or `timed_out` attempt without final triage is still active. Triage
classified as `blocker` remains unresolved and blocks terminal state; another
classification may close the episode when its required durable reference and
reason are valid. For GitHub, current evidence with verdict `failed` or `blocked`
must use a stable `RC-N` id and have the matching marked attempt carrier.

## Required evidence

| Claim | Required evidence | Not sufficient |
|---|---|---|
| Tests pass | Final output with counts and exit success | "ran earlier" |
| Lint/typecheck clean | Summary showing no errors | partial unrelated run |
| Service works | Smoke command and output | "config looks right" |
| Bug fixed | Original symptom re-run and now passing | "changed relevant code" |
| Test guards behavior | Failing RED run from [[tdd-implementation]] | green-only run |

## Timeout, retry, and learning procedure

This skill owns this procedure.

### Before a run

1. Identify its `[RC-N]` id, exact command, required status, and artifact/tree.
2. Read relevant current `VF-...` facts and linked accepted decisions. Facts and
   delegation observations are references, not strategy approval.
3. Use concrete evidence for `foreground`, `background`, `focused`, `split`, or
   `ci` and a bounded timeout. With no fact, run the ordinary proving check once.
4. Read full output and record the result before claiming or retrying.

### Project verification profile

The maintainer owns the one mutable profile in `.agenticloop/project.md`. New
projects use this exact empty state:

```text
## Verification Operating Facts

No project-wide verification operating facts are currently recorded.
```

Use one active fact per exact command:

```text
## Verification Operating Facts

### VF-full-suite

- Command: `npm test`
- Last outcome: timed_out
- Observed duration ms: 180000 | unknown | none
- Timeout ms: 180000 | unknown | none
- Host timeout ceiling ms: 180000 | unknown | none
- Strategy: foreground | background | focused | split | ci
- Updated: YYYY-MM-DD
- Source: <task evidence, event, issue/PR, commit, or durable Markdown reference>
- Revisit when: <concrete trigger>
- Decision: none | <D-id or .agenticloop/decisions/<id>.md>
```

Allowed `Last outcome` values are `passed`, `failed`, `timed_out`, and
`blocked`. Do not add routine successful check results to this profile.

Facts are current state; task attempts remain evidence. Only policy-level
conclusions use [[decision-capture]].

Use a concrete durable `Source` value, not descriptive prose. Accepted shapes
are the configured task id (for example `P25-17`), `task:<TASK-ID>`,
`event:<uuid>`, `issue:#42`, `pr:42`, `github:issue:42`, `github:pr:42`,
`commit:<sha>`, an HTTP(S) URL, or a Markdown path with an optional anchor such
as `docs/testing.md#fast-unit-tests`.

### Append-only exceptional attempt history

New task records use this exact empty state:

```text
## Verification Attempts

No verification attempts are currently recorded.
```

Create one `### RC-N` subsection only when that check has an exceptional episode,
then append only. Never rewrite, reorder, or delete earlier entries. Timestamps
are ISO-8601 UTC. Once an episode exists, append each retry and any resolving
pass that explains the episode; do not overwrite a timeout or failed attempt with
the later result.

```text
## Verification Attempts

### RC-1

#### Attempt 1

- Artifact: <exact tree, commit, PR head, range, or patch reference>
- Command: <exact command>
- Strategy: foreground | background | focused | split | ci
- Timeout ms: <positive integer | unknown | none>
- Outcome: passed | failed | timed_out | blocked
- Duration ms: <positive integer | unknown | none>
- Required: true | false
- Partial evidence: <concise observed output or state>
- Proposed next strategy: none | foreground | background | focused | split | ci
- Candidate classification: one_off | project_fact | decision | follow_up | blocker
- Recorded by: engineer
- Recorded at: YYYY-MM-DDTHH:MM:SSZ
```

For a timeout, `Candidate classification` is required but is not final triage or
approval. It may be omitted otherwise. Use a new number for every new run.

Only one foreground escalation is allowed for the same command and artifact.
Append this prediction after the timeout and before the retry; its timeout must
cover the bounded window and match the retry.

```text
#### Foreground escalation prediction for attempt 2

- Based on attempt: 1
- Evidence: <concrete comparable timing or progress evidence>
- Predicted completion window ms: <positive-min>-<positive-max>
- Chosen timeout ms: <positive integer at least the upper bound>
- Recorded by: engineer
- Recorded at: YYYY-MM-DDTHH:MM:SSZ
```

The maintainer appends triage. `pending` is allowed only while active; accepted
or closed work cannot retain an exceptional episode whose latest attempt is
failed, blocked, or timed out without final non-blocker triage.

```text
#### Triage for attempt 1

- Classification: pending | one_off | project_fact | decision | follow_up | blocker
- Reference: none | <VF-id | decision path/id | task/issue | blocker reference>
- Reason: <required for one_off; concise rationale when useful>
- Triaged by: maintainer
- Triaged at: YYYY-MM-DDTHH:MM:SSZ
```

`project_fact` references a `VF-...` fact, `decision` a decision, `follow_up` a
task or issue, and `blocker` a durable blocker. `one_off` needs a concrete
reason. The maintainer finalizes classification and updates the profile; only a
policy-level fact uses [[decision-capture]].

### Retry rule

Append and emit the real timeout before retrying. Do not rerun unchanged. Change
strategy on evidence, make the one bounded escalation above, or return
`blocked`/`needs_context`. If it times out, no further foreground escalation is
allowed. A worse duration is a regression signal, not automatic timeout growth.
When a retry resolves an already recorded exceptional episode, append that result
to the same history carrier with the artifact on which it actually ran. A later
unrelated implementation commit does not require a duplicate routine pass in an
old carrier and never changes its recorded artifact.

## Event Logging

Event logging is optional and off by default. When `event_logging: enabled`,
resolve the command and honor the disabled/non-blocking rules in
[[event-logging]] before writing events.

After each required or cited command, emit `check.run` with task, role, real
outcome, `command:<...>`, and known small data. Append an attempt only when the
run begins or continues an exceptional episode. The event is an audit copy, not
the canonical final evidence and never a substitute for current implementation
evidence or append-only history where one exists.

Recommended `check.run` data fields:

- `command`
- `exit_code`
- `passed`
- `failed`
- `skipped`
- `duration_ms`
- `timeout_ms`
- `timed_out`
- `host_timeout_limit_ms`
- `execution_strategy`
- `attempt`
- `pr_head`: for GitHub-backed work, the PR head commit the check ran against,
  so the check is bound to the reviewed revision.
- `required`: true when the check is a required gate for this task.
- `triaged_unrelated`: true when the failure is unrelated to the task change and
  accepted as such.
- `accepted_known_failure`: true when the failure is a pre-existing known
  failure and accepted for this task.
- `candidate_classification`: timeout candidate, when recorded.

Log unrelated or known failures as `failure` or `blocked`, never clean
`success`. For a timeout retain actual limit, strategy, duration, known host
ceiling, and attempt number; a planned retry is not a pass.

Example success event:

```text
npx agenticloop event-logging check.run --task T-001 --role engineer --summary "npm test passed" --outcome success --ref "command:npm test" --ref "github:pr:42" --data-json '{"command":"npm test","exit_code":0,"passed":128,"failed":0,"skipped":2,"duration_ms":15320,"attempt":1}'
```

Example blocked event:

```text
npx agenticloop event-logging check.run --task T-001 --role engineer --summary "Smoke check blocked on missing staging secret" --outcome blocked --ref "command:npm run smoke" --data-json '{"command":"npm run smoke","exit_code":1,"passed":0,"failed":0,"skipped":1,"duration_ms":4120,"attempt":2}'
```

For normal task-scoped checks, `--task <TASK-ID>` is enough to correlate the event with the rest of
the task trace in that target. Use `--trace-id` only when you intentionally need a different trace.

Keep raw command output in the task record, implementation summary, review, or closeout artifact.
Do not paste the full output into the event log.

## GitHub evidence hygiene

When reading GitHub state with `gh ... --json`, extract the specific fields needed before
quoting or summarizing them. Prefer `--jq` over pasting raw JSON into Markdown:

```text
gh issue view 42 --json body --jq .body
gh pr view 123 --json files --jq '.files[].path'
```

For pull request scope evidence, prefer `gh pr view --json files`, `gh pr diff`, or
`git diff main...HEAD -- <paths>` over local workspace-only evidence. `git status --short`
is useful for checking the local working tree, but it is not by itself proof of the PR diff
and can include unrelated dirty files.

## Final state

Backend-neutral rule: "final state" means the exact implementation artifact the task record says
is being reviewed now, not an earlier commit, branch state, patch, or summary draft.

### GitHub or pull-request final state

For pull-request-backed work, final state means the current pull request head commit
(`headRefOid`), not any earlier revision. Establish it before citing evidence:

```text
gh pr view <pr> --json headRefOid --jq .headRefOid
```

Any commit pushed to the branch invalidates prior work-unit summary or PR-body
check evidence. A check result counts as final-state evidence only when the command
was run against the current head commit. If a commit lands after the cited run, the
evidence is stale: rerun the check on the new head, or restate the claim as a known
limitation, before requesting review.

The PR-body `## Evidence` section must record the current head explicitly with a
`Current PR head: <headRefOid>` marker, so the evidence is mechanically tied to
the revision under review. For engineer-owned `check.run` events, include the
`pr_head` field (or equivalent) so the recorded check is bound to the head it ran
against. When a required check has a stable `[RC-N]` id, repeat that id after
`Required check:` in the PR evidence entry. Wrapped Markdown continuation lines
are allowed. For GitHub-backed work, run `npx agenticloop github-preflight --pr
<number>` before requesting review; it fails when the `## Evidence` section is
missing, incomplete, or cites a head other than the current `headRefOid`.

Marked issue-comment carriers, when an exceptional episode exists, remain
append-only history. Keep each attempt bound to its actual PR head, retain final
timeout triage, and append resolution when it belongs to that episode. Do not
rewrite an old attempt to the latest PR head or require it to duplicate a routine
final-head success when the current PR-body evidence is complete.

### Files final state

For files-backed work, final state means the recorded implementation artifact in the task file,
normally one of these shapes:

- `commit:<sha>`
- `range:<base>..<head>`
- `branch:<name>` plus the current `HEAD`
- an explicit patch or local diff reference when the task allows that form

Useful files-backed evidence commands include:

```text
git rev-parse HEAD
git status --short
git diff --name-only <base>...HEAD
git diff --stat <base>...HEAD
```

If the task file cites a commit, range, branch, patch, or diff that no longer matches the local
state, the evidence is stale until the task file and implementation summary are brought back into
sync.

## Verification topology and evidence identity

In parallel or multi-artifact work, every planned check is classified by the
tree it runs against:

- **baseline** -- once against the verified shared base tree; establishes
  pre-existing failures and starting state.
- **lane-final** -- against one exact lane head or tree, fresh after that
  lane's final relevant edit. It proves that lane only.
- **integrated** -- against the composed candidate tree at join; required when
  knowledge coupling, adjacent behavior, shared invariants, or
  ordering/composition risk exists.
- **post-merge** -- against the actual merged tree when it differs from the
  rehearsed candidate.

Evidence identity is not command plus branch name. A check result binds to the
exact clean artifact tree or immutable revision, the exact command, and the
relevant dependency/toolchain/environment state. The same command on different
branch heads is different evidence; a green lane-final run on lane A proves
nothing about lane B or about the composed tree.

Baseline reuse is narrow. A verified base run may be referenced across lanes
only when the base tree is identical and clean, the command is identical,
relevant dependency/toolchain/environment state is materially identical, the
prior result and sufficient output are accessible, and the result is used only
to establish baseline state. Baseline evidence can never prove a lane-final,
integrated, review, acceptance, or post-merge final-state claim.

Lane-final checks remain fresh after the final relevant edit, per the gate
above. Integrated proof binds to the exact combined candidate (tree/commit,
composition order, commands); when the eventual real merged tree differs from
the rehearsed candidate, the integrated evidence is stale and the required
checks rerun. An accepted verification decision may change execution strategy
(focused, split, background, CI); it must not silently convert stale evidence
into fresh evidence.


## Role responsibilities

- **Engineer**: include evidence in the `Evidence` section from [[task-record-contract]].
- **Maintainer**: never accept a claim without output. If evidence is missing, use [[review-and-accept]] to request revision.
- **Orchestrator**: treat "checks reported green" as valid only when the report includes actual output.

## Red flags

- "Should work", "probably works", or "seems right".
- The run predates the latest edit.
- PR-body or work-unit summary evidence predates the current PR head commit.
- Task-file summary cites an older local state than the current implementation artifact.
- Local `implementation_artifact` references are stale, missing, or contradicted by local git state.
- A Required Check is unrun, red, skipped, or unread.
- A summary says "all green" without the verdict lines.
- One lane's green run is cited as proof for another lane or for the composed tree.
- A baseline run is cited to satisfy a lane-final, integrated, or post-merge claim.
- Rehearsal evidence is cited after the real merged tree diverged from the rehearsed candidate.
- Fatigue is being mistaken for proof.
