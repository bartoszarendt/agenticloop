---
name: verification-evidence
description: Use before claiming any work state -- done, fixed, passing, green, complete, mergeable -- in an implementation or revision summary, review comment, audit, or closeout, and when reading someone else's claim. Defines the identify-run-read-verify gate and the evidence each claim requires.
metadata:
  area: engineering-discipline
  side_effects: writes-tmp
  credentials: none
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

## Required evidence

| Claim | Required evidence | Not sufficient |
|---|---|---|
| Tests pass | Final output with counts and exit success | "ran earlier" |
| Lint/typecheck clean | Summary showing no errors | partial unrelated run |
| Service works | Smoke command and output | "config looks right" |
| Bug fixed | Original symptom re-run and now passing | "changed relevant code" |
| Test guards behavior | Failing RED run from [[tdd-implementation]] | green-only run |

## Long-running or timed-out checks

Before running a required or cited check, inspect the task record and any
delegation Operating facts for linked verification decisions. If a linked
verification decision applies, follow its execution strategy unless it is stale
or contradicted by current evidence.

If a check times out or is unexpectedly expensive:

- record the exact command,
- the timeout used,
- the observed duration if known,
- the host timeout ceiling if known,
- any partial relevant output,
- whether the check was required,
- and whether the next strategy should be background, focused, split, or CI.

Do not rerun the same foreground command just to rediscover a known timeout. If
the required check cannot be completed under the host limits, report the gap
honestly under `## Known Gaps`, `## Process Observations`, `blocked`, or
`needs_context` as appropriate. Treat a materially worse duration than a prior
decision as a possible regression signal, not just a reason to raise the timeout.
If the behavior constrains future tasks, the engineer may create a `proposed`
verification decision directly when the evidence is current and
decision-worthy. The proposed decision must cite the exact command,
timeout/duration facts, host limit when known, selected execution strategy, and
revisit trigger. If write ownership is unsafe (for example in an unclear
parallel lane), record the candidate in Process Observations or status return
for maintainer capture.

## Event Logging

Event logging is optional and off by default. When `event_logging: enabled`,
resolve the command and honor the disabled/non-blocking rules in
[[event-logging]] before writing events.

When a required or cited verification command completes, emit `check.run` with the task id, role,
short summary, outcome, a `command:<...>` reference, and small structured `--data-json` when the
fields are known.

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

Log unrelated or known failures as `failure` or `blocked` with the matching
triage flag set to `true`; do not hide them as clean `success`. A triaged
check is still an imperfect check and must be reported separately from clean
passes.

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
- Fatigue is being mistaken for proof.
