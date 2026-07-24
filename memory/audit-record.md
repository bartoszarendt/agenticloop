---
audit_id: AUD-001
work_unit: phase:1
audit_state: active
human_resolution_ref:
covered_tasks:
  - T-001
candidate_artifact: commit:0000000
certified_artifact:
certified_covered_tasks: []
latest_verdict:
audit_budget: 5
---

# AUD-001: Work-Unit Audit

Canonical shape for a work-unit audit certificate under `.agenticloop/audits/`.
One record per work unit. This store holds certification state and append-only
Auditor report history; it does not duplicate per-task completion summaries,
which stay inline in each task record.

Never record a model id, reasoning effort, provider, or a mutable round counter
here. Those are adapter configuration; the run number is derived from
`## Audit History`.

## Work Unit Goal

State the original intended outcome of the work unit and cite its durable source
reference (plan item, spec section, issue, or decision record).

## Completion Oracle

State the observable result that proves the work unit achieved its goal.

## Covered Tasks

List the exact task IDs inside the audit boundary, one per line. This must match
`covered_tasks` in the frontmatter.

- T-001

## Frozen Baseline

Record the exact integrated candidate submitted for audit (for example
`commit:<sha>` or an immutable revision reference) and the development stage the
audit was performed under.

## Evidence Available

List the final integrated verification evidence bound to the frozen baseline:
exact commands, results, and where they are recorded.

## Accepted Decisions

List the accepted decision records relevant to this work unit, or `none`.

## Known Limitations

List known limitations and accepted follow-ups carried into the audit, or
`none`. Every retained limitation needs an `Authority:` reference naming the
human or accepted decision that accepted it.

## Audit History

Append one entry per completed substantive Auditor report. Never edit or remove
an earlier entry. The run count is derived from the number of entries here.

Entry shape:

```markdown
### Run 1

- Invocation reference: 9f1c2c8e-2c53-4c0b-9a2f-4c2b9f9c2a11
- Invocation mode: host_subagent
- Audited artifact: commit:0000000
- Covered tasks: T-001
- Verdict: needs_remediation
- Assessment: consolidated assessment across all six audit perspectives.
- Findings: A-01
- Evidence checked: npm test (pass), npx agenticloop validate (pass)
```

No audit runs are currently recorded.

## Consolidated Findings

One entry per open finding from the latest report. Remove an entry only when a
fresh Auditor accepts its disposition or a human resolves it.

Finding shape:

```markdown
### A-01

- Severity: high
- Blocking: true
- Claim: concise problem statement.
- Evidence refs: exact task/artifact/file/check references.
- Consequence: concrete result if it is left unresolved.
- Required outcome: observable result required for closure.
- Verification required: exact evidence needed after remediation.
```

No findings are currently open.

## Remediation Tasks

List remediation task IDs created for blocking findings, with the finding IDs
they close, or `none`.

## Final Certification

Record the effective certification: certified artifact, certified covered tasks,
verdict, and the authority reference for every retained limitation. Keep the
canonical empty-state sentence until a certifying report exists.

This work unit is not currently certified.

## Comments

- When a report returns `needs_human_decision`, the CLI sets
  `audit_state: awaiting_human`. Record the separate human direction with
  `agenticloop audit resolve`; do not edit `human_resolution_ref` manually.
- YYYY-MM-DD: notes about the audit lifecycle.
