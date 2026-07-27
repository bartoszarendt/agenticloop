---
audit_schema_version: 2
audit_id: AUD-001
work_unit: phase:1
audit_state: active
human_resolution_ref:
covered_tasks:
  - T-001
candidate_artifact: commit:0000000000000000000000000000000000000000
certified_artifact:
certified_covered_tasks: []
latest_verdict:
audit_budget: 3
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

`agenticloop audit report` mechanically appends one entry per completed
substantive Auditor report. Never hand-edit or remove an earlier entry; the run
count is derived from the number of entries here. The following is a recovery
shape for understanding parser diagnostics, not an instruction to author audit
history directly.

Entry shape:

<!-- agenticloop:canonical-audit-run -->
```markdown
### Run 1

- Invocation reference: 9f1c2c8e-2c53-4c0b-9a2f-4c2b9f9c2a11
- Invocation mode: host_subagent
- Invocation provenance: asserted
- Audited artifact: commit:0000000000000000000000000000000000000000
- Covered tasks: T-001
- Verdict: needs_remediation
- Assessment: consolidated assessment across all six audit perspectives.
- Findings: A-01
- Evidence checked: npm test (pass), npx agenticloop validate (pass)
- Report format: legacy_inline_v1
```

A wire-format run (`Report format: auditor_report_v1`) additionally persists
the complete normalized report - all six perspective bodies, invocation
provenance, and every finding field - as a fenced JSON payload inside the run
block, so the durable record reparses losslessly. `verified` provenance means a
host verifier checked the role, work unit, artifact, task set, reference, and
receipt. Without that capability, receipt claims are stored as `asserted`; they
are never described as verified. Invocation references and receipts are globally
unique across audit records.

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

## Finding Dispositions

One typed, run-qualified, append-only disposition per finding, recorded with
`agenticloop audit disposition`. A disposition never changes blocking status,
never certifies the work unit, and never consumes `audit_budget`.

`remediation_task`, `change_request`, `human_decision`, `accepted_limitation`,
and `follow_up` require a durable `Ref`. `rejected_with_counter_evidence`
requires a counter-evidence reference and note. `no_action` requires a reason
and Maintainer or human authority. Missing ownership is never defaulted.

Disposition shape:

```markdown
### Run 1 / A-01

- Type: follow_up
- Ref: T-002
- Note: bounded reason or ownership note.
- Authority: maintainer
- Date: 2026-07-27
```

No finding dispositions are currently recorded.

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
