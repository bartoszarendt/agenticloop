---
name: work-unit-audit
description: Use when every task in a work unit is accepted and the whole unit must be certified by the auditor before closeout, when routing a non-certifying audit report into remediation tasks, or when a re-audit is required because remediation changed the audited artifact. Defines the audit packet, the six audit perspectives, findings, verdicts, the separate audit budget, and the closeout certification gate.
metadata:
  area: work-unit-audit
  side_effects: writes-files
  credentials: none
  runs_scripts: optional
---

# Work-unit audit

Task review proves each task was done correctly. Work-unit audit answers the
question no task review asks: does the *combined* result achieve the work unit's
intended outcome as a complete, coherent, sufficiently verified system?

Individually accepted tasks can still leave missing cross-task behavior, an
incomplete product outcome, conflicting configuration, duplicate mechanisms,
code and docs that disagree, unnecessary combined complexity, integrated
regressions, or task-level evidence that never proved the final combined state.

Work-unit audit is **enabled by default**. Unless a human explicitly records
`work_unit_audit: disabled` in `.agenticloop/project.md`, work-unit closeout
cannot publish `AGENT_CLOSEOUT_STATUS: complete` without a current certificate.

## 1. Preconditions

Do not start an audit until all of the following hold:

- every covered task is `accepted` or `closed` under the configured backend;
- the covered artifacts are integrated or composed into one exact candidate;
- the candidate is frozen: a commit SHA or another immutable revision reference;
- final integrated verification evidence exists for that exact candidate;
- an Auditor model is configured at `adapters.<host>.roleSettings.auditor`.

If auditing is enabled and no Auditor model is configured, that is a blocking
setup condition. Report it and stop. Never substitute the Maintainer model.

Integration rehearsal and audit are different steps. Engineer-owned integration
rehearsal remains the pre-integration composition proof. The audit runs *after*
the exact candidate is integrated or frozen.

## 2. Audit packet

Each invocation receives only bounded durable context:

- the original work-unit goal and its durable source reference;
- the observable completion oracle;
- the confirmed development stage;
- the exact work-unit identity;
- the exact covered task IDs;
- task outcomes and inline completion summaries;
- relevant accepted decision records;
- the exact candidate artifact;
- final integrated verification evidence;
- known limitations and accepted follow-ups, with their authority references;
- bounded repository-discovery rules.

Never pass raw transcripts, full implementation conversations, or host runtime
dumps.

Create the record only with concrete packet inputs:

```text
npx agenticloop audit new --work-unit phase:4 \
  --covered-tasks T-041,T-042 --artifact commit:abc123 \
  --goal "<outcome and durable source>" \
  --completion-oracle "<observable completion>" \
  --evidence "<integrated evidence for commit:abc123>"
```

The CLI rejects missing goal, oracle, or evidence. The validator also rejects
instructional placeholder text, so a placeholder packet cannot be certified.

If the goal, completion oracle, baseline, or covered-task boundary is too
ambiguous to audit, the Auditor returns `needs_human_decision` and does not
invent the intended outcome.

## 3. Exact-baseline freezing

An audit binds to one exact artifact and one exact covered-task set. Record both
in the audit record:

```yaml
candidate_artifact: commit:abc123
covered_tasks:
  - T-041
  - T-042
```

Certification is current only when both hold:

```text
certified_artifact      == candidate_artifact
certified_covered_tasks == covered_tasks     (after canonical ordering)
```

Any relevant candidate change, any covered-task addition or removal, any change
to group membership, and any reopened covered task invalidates certification.
Reordering an otherwise identical task set does not.

## 4. Fresh invocation

Every audit and re-audit is a fresh, separate Auditor invocation. Allowed
invocation modes are `host_subagent` and `explicit_agent_invocation`.
`single_agent_fallback` is rejected: a same-session continuation re-reads its own
conclusions and is not an independent audit.

Each run records a unique invocation reference. A reused reference fails
validation. Never record the model id or reasoning effort in the audit record;
those stay adapter configuration.

An invocation that fails without producing a report does not consume
`audit_budget`. Repeated equivalent invocation failures stay bounded by the
ordinary Attempt Budget in `agenticloop/AGENTIC_LOOP.md`.

## 5. Six perspectives, one execution

One Auditor performs all six perspectives in one execution and returns one
consolidated report. These are perspectives inside one audit, not separate
roles, agents, models, events, votes, or budgets.

1. **Outcome** - does the integrated result achieve the intended user, product,
   or operational outcome?
2. **Completeness** - are material requirements, behavior, documentation,
   migration, or operational steps missing?
3. **Integration and coherence** - do all task outputs work together without
   conflict, duplication, incompatible assumptions, or a second source of truth?
4. **Engineering quality** - is the combined solution appropriately simple,
   maintainable, and suitable for the confirmed development stage?
5. **Verification** - does the evidence prove the exact integrated candidate,
   rather than only proving individual tasks?
6. **Risk** - are there combined-state regressions, security issues, destructive
   failure modes, compatibility problems, data risks, or release and operational
   gaps?

Evaluate quality, verification, and risk at work-unit altitude. Do not re-review
an accepted task implementation merely because a different local choice was
available.

The Auditor may inspect evidence and run safe, bounded, non-publishing checks
against the frozen candidate. It never repairs a failure. Missing or inadequate
evidence becomes a finding routed to normal remediation.

## 6. Finding shape

Every finding carries:

```text
### A-01

- Severity: critical | high | medium | low
- Blocking: true | false
- Claim: concise problem statement
- Evidence refs: exact task/artifact/file/check references
- Consequence: concrete result if left unresolved
- Required outcome: observable result required for closure
- Verification required: exact evidence needed after remediation
```

## 7. Verdicts

Exactly one verdict per report:

- `certified`
- `certified_with_accepted_limitations`
- `needs_remediation`
- `needs_human_decision`

Rules:

- `certified` requires no open blocking findings.
- `certified_with_accepted_limitations` requires an existing human or
  accepted-decision authority reference for every retained limitation. Use
  `human: <identity>` for direct human authority or a `D-...` reference to an
  existing accepted decision record; arbitrary prose and Auditor self-authority
  are invalid.
- The Auditor may recommend accepting a new limitation but cannot accept one. A
  newly proposed limitation without authority returns `needs_human_decision`.
- `needs_human_decision` moves the record to `audit_state: awaiting_human`.
  No further report can be appended until the human direction is recorded:

```text
npx agenticloop audit resolve <AUD-ID> \
  --authority "human: <identity>" \
  --note "<decision and direction for remediation or re-audit>"
```

- After resolution, refresh the audit packet or baseline as needed and use a
  fresh Auditor invocation. The extra run is deliberate: the authority context
  changed. Resolution itself never certifies the work unit.
- The Maintainer may reject a finding with counter-evidence, but the finding
  stays unresolved until a fresh Auditor accepts that disposition or a human
  resolves the authority conflict.

## 8. Report persistence

The Auditor never needs implementation-write permission to produce a durable
report:

1. The Auditor returns a structured report to the orchestrator.
2. The orchestrator (or a human) persists it mechanically:

```text
npx agenticloop audit report <AUD-ID> --verdict <verdict> \
  --invocation-mode host_subagent --invocation-ref <unique-ref> \
  --assessment "<one paragraph>" --evidence "<checks run>" \
  --finding-json '<json array>'
```

Persistence appends one history entry and rewrites the derived certification
fields. It never edits an earlier history entry and never alters the report's
substantive findings. Where the host supports path or operation restrictions,
enforce the Auditor's read-only posture mechanically as well as in the prompt.

## 9. Remediation routing

For `needs_remediation`, or after a `needs_human_decision` verdict has been
resolved:

1. The orchestrator routes the report to the maintainer.
2. The maintainer gives each blocking finding one disposition: ordinary
   remediation task, change request, human decision, rejected with
   counter-evidence, previously accepted limitation, or non-blocking follow-up.
3. The engineer implements ordinary remediation tasks under [[tdd-implementation]]
   and [[verification-evidence]].
4. The maintainer reviews and accepts them normally under [[review-and-accept]].
5. The exact remediation result is integrated.

Remediation tasks are ordinary task records with their own `attempt_budget` and
`review_budget`. They reference the audit ID and the finding IDs they close.
Remediation never consumes `audit_budget`.

## 10. Re-audit

After remediation is accepted and integrated:

```text
npx agenticloop audit baseline <AUD-ID> --artifact commit:<new-sha> \
  --covered-tasks T-041,T-042,T-055 \
  --evidence "<integrated evidence for the new candidate>"
```

This refreshes the candidate artifact and covered-task boundary and clears any
stale certification. History is preserved: replacing the baseline never resets
the budget, and replacing the audit record is not an accepted way to reset it
either.

Then invoke a fresh Auditor and append the new report to the same audit record.

## 11. Audit budget

`audit_budget` defaults to `5` and is independent of `attempt_budget` and
`review_budget`, which default to `3`. Five is deliberate: it bounds an expensive
work-unit assurance loop while still allowing the initial audit plus several
remediation and re-audit cycles before mandatory human intervention.

- Count only completed substantive reports, derived from `## Audit History`.
- Count both certifying and non-certifying reports, but stop immediately after
  certification.
- Invocation failures without a report do not consume it.
- Remediation work does not consume it.
- Baseline replacement does not reset history.

After five non-certifying reports, set `audit_state: blocked` with
`audit_blocked_reason: audit_budget_exhausted` and keep `latest_verdict` at the
fifth Auditor's actual verdict. Budget exhaustion is a workflow stop, not an
Auditor verdict: never manufacture `needs_human_decision` merely because the
budget ran out. If the fifth verdict actually is `needs_human_decision`, keep
the record in `awaiting_human` until `audit resolve`; after resolution the
exhausted-budget block remains. A sixth report requires all applicable
resolution and a recorded human-approved override:

```text
npx agenticloop audit override <AUD-ID> --budget 7 --authority "human: <name>"
```

The CLI enforces append-only history operationally and validation checks internal
history consistency. That is not a claim of tamper-proof enforcement against
arbitrary manual Git history rewriting.

## 12. Closeout certification

When `work_unit_audit` resolves to `enabled`, work-unit closeout may publish
`AGENT_CLOSEOUT_STATUS: complete` only when all of these hold:

- exactly one current audit record exists for the work unit;
- covered-task membership is exact;
- all covered implementation and remediation tasks are accepted and integrated;
- `latest_verdict` is `certified` or `certified_with_accepted_limitations`;
- `audit_state` is `certified`;
- `certified_artifact` equals `candidate_artifact`;
- `certified_covered_tasks` equals `covered_tasks`;
- the last completed run's artifact, covered-task set, and verdict match the
  current certification fields;
- no blocking finding is unresolved;
- every accepted limitation has typed human authority or an existing accepted
  decision reference;
- fresh final-state evidence exists for the exact candidate.
- the complete audit record passes structural validation.

Enforce the gate mechanically:

```text
npx agenticloop audit gate <work-unit-or-audit-id>
```

Use `audit status` for diagnostics. Do not replace `audit gate` with a manual
frontmatter inspection.

Otherwise keep the marker at `follow_up_required`, or retain the appropriate
incomplete, blocked, or needs-context state. Publish one final closeout marker
for the work unit, not one marker per audit run. See [[task-closeout]].

When `work_unit_audit` is explicitly `disabled`, closeout bypasses this gate,
preserves any existing audit history, does not claim the work unit is certified,
and states the opt-out visibly in the closeout evidence.

## Work-unit identity

Grouped projects reuse the existing grouping semantics from
`.agenticloop/project.md`:

```text
phase:4
milestone:M2
epic:payments
custom:<group-id>
```

Flat projects require an explicit human-named unit, `work-unit:<name>`, plus
explicit covered task IDs. When durable group membership cannot be derived
reliably for a backend, require explicit covered tasks rather than guessing.

## Out of scope

Multi-model auditing, reviewer panels, voting, synthesis, provider diversity, and
primary/secondary Auditor slots are deliberately deferred. One work unit, one
Auditor, one model, one report per run.
