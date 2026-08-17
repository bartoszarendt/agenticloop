# Files Task Backend

Status: supported default.

The files backend stores task records as local Markdown files. It is the
default backend for Agentic Loop projects. No GitHub repository, account, or
labels are required.

Everything the backend needs lives locally. Implementation artifacts are a local
branch, commit, range, patch, or diff reference recorded in the task file; task
state, evidence, and review all live in the task file and in Git. Files-backend
validation and task operations never call `gh` or make GitHub network requests,
even when a GitHub remote and an authenticated GitHub CLI are available.

The backend is selected by `.agenticloop/project.md` `task_backend: files` (the
default). A GitHub remote does not change the backend; only `task_backend: github`
enables GitHub issue/PR behavior. Files-backend agents must not open PRs, close
issues, or merge branches as part of the workflow. After files-backed acceptance,
integration/publish/PR/merge is a separate human decision outside normal
files-backend task automation, unless the project explicitly switches to the
GitHub backend.

The files backend is not an autonomous runner. It is a storage projection for
the same Agentic Loop roles, skills, and review gates.

## Shared transition contract

Files projects the complete backend-neutral `agenticloop.transition-contract`
defined in `agenticloop/AGENTIC_LOOP.md`. Its executable definition is internal
to the installed Agentic Loop npm package and is not copied into the target.
Task-file frontmatter is authoritative for the
durable task lifecycle status, append-only task-contract history is authoritative
for contract readiness, and the backend-neutral audit record and closeout marker
retain their own facts. A task status does not replace a current blocked-return
receipt, review-entry receipt, audit state, or terminal closeout marker.

The files projection has no labels. Its task history and optional event log are
authoritative only for the typed records they carry; ordinary prose remains
advisory. Apply the shared freshness, terminal ordering, Markdown preservation,
and audit-budget rules before adding a files mutation mechanism. Carrier absence
uses typed applicability (`applicable: false`, `carrier: null`), never prose.

Files defines the shared semantics for projection reconciliation. Its
observations declare labels as `not_applicable` with a null carrier identity, no
value, no evidence state, and no observation time - an absent carrier, not
missing evidence. Every other fact is observed and compared exactly as on
GitHub, so equivalent normalized facts reach one shared verdict.

A files parallel-scan inventory enumerates the configured task-file surface and
preserves each member's exact carrier path and content digest. A candidate
record that cannot be read or parsed stays an inventory member carrying its
error evidence; it is never dropped, and its presence makes inventory
completeness fail closed.

`agenticloop.files-task-directory.v1` is the authoritative files enumerator. It
lists the configured task directory itself and issues the typed
`agenticloop.task-inventory-enumeration` receipt that inventory completeness is
derived from, so no caller can assert a complete task surface. The read-only
`task prepare-decomposition` command is the production producer built on it: it
enumerates, scans, validates the emitted record with the same validator dispatch
uses, and prints the committable decomposition source as canonical JSON without
mutating anything.

Before a current-schema dispatch, the files boundary re-enumerates the
configured task-file directory and compares its exact membership and content
digests with the bound scan, and revalidates the scan's bound readiness context -
the base inventory identity and the dependency-status evidence - for the whole
ready set. A new, omitted, unreadable, or changed task, or a changed base or
dependency status, makes the scan stale and refuses dispatch.

## Dispatch and return

The ordinary files handoff starts with `task prepare-dispatch <id> --host <host>
--role engineer --output <packet-path> --json`; guarded role start consumes and
revalidates it through `task status <id> in-progress --dispatch-packet
<packet-path>`. `task prepare-dispatch <id> --input <dispatch-input.json>` is an
advanced compatibility route, while `task prepare-dispatch <id> --packet
<packet.json> --role engineer` is the matching receive-side revalidator. An
optional `--host-trust-store` can assert, but cannot select, the target's
pre-registered path under the fixed operator registry. They
refetch task/Git facts, rerun readiness from its exact base/dependency sources,
and reread decomposition from an unmodified committed source whose last change
has canonical Maintainer attribution. "Unmodified" is Git's verdict, so the
path's own `.gitattributes` eol rules and any clean filter apply, and the
content the verifier consumes is the committed blob rather than the host's
checked-out spelling: an ordinary Windows CRLF checkout is not drift. A worktree
difference, a staged-only difference, an `assume-unchanged` or `skip-worktree`
bit, and a target that is not the repository root are all refused. The committed decomposition persists its
own revalidation selectors: the base as an exact `git-tree:<oid>` identity and
each dependency snapshot as the semantic `source` identity plus a confined
target-relative `sourceRef` artifact path. Inline readiness results or decomposition
authority strings cannot authorize dispatch. Missing, malformed, stale, changed,
or contradictory evidence blocks before a digest-bound packet is emitted or
accepted. The packet is transient handoff data, not task state.

Run `task handoff-preflight <id> --json` before packet assembly to see one
combined prerequisite result, including the lifecycle gate role start will
apply: a task is dispatchable only from a status that legally reaches
`in-progress`, so a `draft` task is refused here with its Maintainer-owned
`task status <id> agent-ready` repair rather than at delegation. That repair is
rendered from one structured plan shared by every refusal site: it names the
read-only command that supplies the current digest, one primary command, and at
most one identified alternative, and it never offers the mutually exclusive
`--base` and `--base-paths` inside one command.
If its derived observations are stale, write a
plan with `--repair-plan <path>` and apply it explicitly with
`task refresh-handoff-evidence <id> --plan <path> --yes`. The refresh writes only
derived evidence under `.agenticloop/handoffs/derived-evidence/`, the
decomposition provenance under `.agenticloop/decompositions/`, and at most one
bound dependency snapshot (the path named by the decomposition's
`scan.readinessContext.dependencies.sourceRef`); it never touches task contracts,
activation, human decisions, review dispositions, acceptance, closeout, or
product files. It refetches after the atomic write and emits the cooperative
Maintainer `Task:`/`Agent:` trailer block when a durable update is required.
Refreshing the dependency snapshot renews the observation *window*, not the
observation: the Maintainer-recorded statuses are carried forward unchanged and
only `observedAt` is re-stamped (resetting the `maxAgeSeconds` window). The
refresh checks that every declared dependency has a recorded status; it does not
re-observe dependency state, so the Maintainer stays responsible for those
statuses being currently true.

The Engineer creates required-check evidence with `task check-evidence-init`,
updates it with `task check-evidence-update`, and derives the raw return with
`task prepare-return`. The receiver runs `task verify-return <id> --packet
<packet-path> --return <return-path> --from-current-repository` before `task
review-prepare <id>` or review. All these artifact paths are target-relative.
Do not inspect artifact internals, hand-author JSON or digests, or replace a
return with host status, messages, opaque handles, or cancellation observations;
host cancellation/status alone does not establish cancellation. A cancellation
claim requires the Agentic Loop-controlled observation documented in
docs/cli-reference.md (`--cancellation-evidence` on both `prepare-return` and
`verify-return`); without it the outcome is unknown, not cancelled or complete.
A passed command check is proved only by the closed schema-v3 CLI execution
artifact it references; new check records must carry that evidence, while
artifact-free legacy records verify under the documented reduced-assurance
compatibility rule. Schema-v2 evidence and its digest domain are typed
incompatible with v3 and must be regenerated.

The receiving role verifies the packet before mutation and returns raw
`agenticloop.role-return` JSON. `task verify-return --from-current-repository`
derives the branch, three-head topology, changed paths, commit range, and trailer
attribution from Git; it never accepts caller-supplied path classification. A
path outside `.agenticloop/` is product. The exact task carrier is a workflow
path only when its receipt lineage is current; active dispatch/evidence receipts
and validated workflow audits are workflow evidence; scratch paths and unknown
`.agenticloop/` paths fail closed. A product path changed after the declared
`productHead` also fails stale. The resulting product/workflow sets, checks, and
canonical `Task:`/`Agent:` trailers are compared with the raw return.

Standard mode accepts an explicitly `session_reported`, freshly revalidated raw
return at reduced/unverified assurance. Hardened mode, or any effective
`host_receipt` requirement, requires the appropriate packet-bound Ed25519
producer receipt and protected host-issued execution receipt. The producer receipt
binds the target repository, packet, invocation, return, liveness, adapter/key
identity, and evidence digest. The verifier receives only the packet-bound public
key from the fixed host-owned operator registry; it never reads a shared secret,
repository-local trust file, or caller-selected alternative store. Trust-registry,
binding, replay, invalid, missing, target-mismatched, or caller-edited required
receipts fail closed.
Invalid wire returns retain the packet's producer route.
`implementation_ready_for_review` is a non-authoritative outcome, not completion.

The carrier is not restored after `in-progress`. `task evidence` is the bounded
Engineer-owned files mutation path: artifact, summary/check, and outcome evidence
each require the exact `currentCarrierDigest`, preserve `taskContractDigest`, and
write a versioned receipt under `.agenticloop/handoffs/task-mutations/`. The
receipt chain starts at `.agenticloop/handoffs/dispatch/`; a carrier edit without
that continuous chain is refused at return and review. Task carriers and canonical
workflow records are workflow paths, never implementation deviations. After a
verified return, `task review-prepare <id>` writes a files review-entry receipt
only when its one command-local carrier snapshot remains current.

New files-backed tasks materialize `attempt_budget` from project
`default_attempt_budget`, then built-in `5`. A task-specific override is an
explicit task-record edit made before work begins; the files `task new` command
does not accept a budget override option. The field is the hard stop for
equivalent no-progress attempts; existing stored task values remain authoritative.

## Parallel Write Lanes

Concurrency safety is governed by mutation, not by role. Files-backed task
records, event logs, and scratch files are local mutable state that can collide
across parallel lanes just like implementation files. Load [[parallel-delegation]]
for the Parallel Opportunity Scan, lane definitions, plan fields, liveness,
join behavior, and the full backend-specific parallel write rules.

Files-backend deltas:

- Read-only parallel discovery is allowed when bounded by fixed artifacts and no
  lane mutates repository files or task records.
- In a Git repository, each parallel write lane needs its own repo-internal
  worktree, local branch, owned task file or explicitly owned workflow file,
  recorded implementation/workflow artifact, lease, and join condition.
- Parallel coordination/review lanes must own distinct task files or workflow
  artifacts and must not share event-log targets, group state, status markers,
  closeout files, scratch outputs, or other local append/update targets.
- Cross-lane findings are routed through lane status returns and recorded in
  the concurrency plan or coordination output; the join condition stays
  incomplete while any routed finding lacks a recipient disposition or any
  deferred finding lacks recorded non-blocking limitation/follow-up triage.
- Integration of parallel files-backed lanes is serial; merge remains serial.
  When the concurrency plan requires combined-state proof, an explicitly planned
  integration rehearsal may compose a disposable candidate from the verified
  base plus lane artifacts in the intended order and record integrated evidence
  bound to that exact candidate. The rehearsal is not final integration: it
  publishes nothing, and merge or publish after acceptance remains a human
  decision. When the eventual merged tree differs from the rehearsed candidate,
  the rehearsal evidence is stale and the required checks rerun.
- A managed join is one dedicated files-backed join task, branch, and exact
  commit/range artifact. It records its exact base, ordered lane artifacts,
  reconciliation revision when any, final artifact, integrated evidence, fresh
  three-lens review identity, and stale trigger. Each lane records the exact
  `integrated_by` join artifact after validated integration. A changed promoted
  or landed tree makes the evidence and review stale; actual merge remains a
  separate human-authorized action.
- Non-Git targets do not allow parallel write lanes. Run all write work serially;
  read-only parallel discovery is still allowed.

## Summary and Trace

Task summaries live inline in the task file. There is no separate
`.agenticloop/summaries/` directory; the task record is the durable summary.

The completion summary belongs in the task file as the `## Scope Completed` (or
legacy `## Implementation Summary`) section. Update it in place as
implementation progresses. Every accepted or closed task must have a non-empty
inline task summary with `summary_unit: task`, using
`agenticloop/memory/work-unit-summary.md` as the canonical shape. Include the
optional `## Trace` section when workflow-gate events exist. This is a summary,
not a raw transcript.

`## Evidence` should list concise verdict lines and relevant output excerpts for
every required check on the final state. The agent must still read the full
command output before claiming success. Use event-log `refs` and small `data`
for structured facts; do not create a separate parseable receipt block. Output
refs remain a deferred future policy; do not create or rely on them now.

The target project's `## Verification Operating Facts` section in
`.agenticloop/project.md` is the maintainer-owned mutable current profile. The
task file's `## Verification Attempts` section is separate append-only,
exceptional execution history: the engineer appends failed, timed-out, blocked,
retried, escalated, or otherwise triaged attempts and bounded foreground
predictions, and the maintainer appends triage. Routine first-pass successes stay
only in current final-state evidence (and `check.run` when enabled). Use the
exact shapes and retry procedure in [[verification-evidence]]; do not replace an
existing task attempt with summary prose or project facts.

Closeout does not write a separate summary file. When a human-identified task
set or configured group finishes, closeout verifies the inline task summaries
are complete and records a status marker (see [[task-closeout]]).

Event logging is disabled by default. When `.agenticloop/project.md` has
`event_logging: enabled`, the local `.agenticloop/logs/<TASK-ID>.jsonl` event
log may help confirm workflow gates, checks, decisions, and blockers. The task
file remains the authoritative durable record. Command resolution and the
disabled/non-blocking rules are owned by [[event-logging]].

Use backend-specific values inside the canonical template. Keep the summary
concise. Cite command output, file paths, and task ids. Do not copy raw agent
exchanges.

## Storage Model

```text
.agenticloop/
  tasks/
    <TASK-ID>.md
```

| Agentic Loop object | Files projection |
|---|---|
| Task record | `.agenticloop/tasks/<TASK-ID>.md` |
| Task ID | File name and frontmatter field |
| Grouping | Optional frontmatter/body field when the project uses grouping |
| Implementation artifact | Branch, commit range, patch, or local diff reference |
| Evidence | Current implementation summary (refreshable) plus exceptional append-only history when an episode exists |
| Verification profile | Current `## Verification Operating Facts` in `.agenticloop/project.md` |
| Verification attempts | Append-only `## Verification Attempts` in the task file |
| Review status | Frontmatter field plus review section |
| Blocked state | Frontmatter field plus blocker section |
| Completion summary | Inline `## Scope Completed` section in the task file |

## Task IDs

Default task IDs use the `T-<number>` pattern with at least three digits.

Valid default examples:

```text
T-001
T-002
T-120
```

Projects that choose grouping may override this. For example, a project with
`grouping_profile: phase` may use `P1-01` if its `task_id_regex` allows it.

The default regex is `^T-\d{3,}$`. Override `task_id_regex` in
`.agenticloop/project.md` only when the target project uses a different naming
convention.

The registry regex in `agenticloop/config.json` bounds detection candidates
only; the enforced per-project convention is `task_id_regex` in
`.agenticloop/project.md` (default `^T-\d{3,}$`). An ID valid under the registry
regex is not necessarily valid for the project.

## Task File Shape

Use Markdown frontmatter for mechanical state and body sections for
human-readable detail. Use `agenticloop/memory/task-record.md` as the
canonical shape. It includes the required `## Completion Summary Template` and
`## Reviewer Checklist` sections that every durable task record must carry.

`## Expected Files or Areas` is the task's current human-readable scope map. The
optional frontmatter field `allowed_paths` is the structured scope map: a YAML
list of repo-relative glob-like path patterns. Forward slashes are canonical;
absolute paths and `..` traversal are not allowed. Directory entries ending in
`/` match everything beneath that directory. Simple glob support covers `*`,
`**`, and `?`. The compatibility alias `expected_files` is accepted when
`allowed_paths` is absent.

When `allowed_paths` is present, `agenticloop validate` performs a warn-only
mechanical check that changed files in the working tree match at least one
allowed pattern. Out-of-scope changed files surface as warnings; reviewers still
enforce unexpected files through `## Deviations`. The structured field
complements the human-readable section; it does not replace it.

Optional frontmatter conventions:

- `type: change-request` for locked-decision changes that require the docs-first approval gate.
- `approved: true` after a human approves a files-backed change request.
- `block_category: <category>` while the task is blocked.
- `context_overflow_risk: medium|high` plus optional `context_note` when one
  engineer execution needs tighter active-context discipline.
- `review_mode: <mode>` records how the current review was performed; required
  when `review_status` is set.
- `reviewed_artifact: <artifact>` is the exact current implementation artifact
  reviewed for `review_status`.
- `independent_review_required: true` before implementation when acceptance must
  not use same-session `single_agent_fallback`.
- `human_review_ref: <reference>` a recorded human review/confirmation reference,
  required when `review_mode: independent_human`. Files validation checks
  presence only; external verification is performed by the GitHub audit when
  applicable.

## Operations

### Trusted task-contract records

The carrier is `.agenticloop/task-contract-history/<task-id>.jsonl`, verified
against first-parent committed Git history. `task establish-baseline` and
`task authorize-correction` only append; a record becomes trusted only after a
separate commit, its Git author matching the record actor, validated by the
shared digest-linked validator.

Append-only verification walks the first-parent commits touching the history
path from introduction to HEAD:

- The path must be clean at HEAD: staged or unstaged changes are rejected,
  and a history that existed but is absent at HEAD is a rejected committed
  deletion.
- Every successive committed blob must be an exact byte-prefix extension of
  the previous blob. Rewriting, replacing, truncating, or reordering a
  committed line fails; the appended suffix must consist only of complete
  newline-terminated JSONL records.
- Each appended line is bound to the commit that introduced it: commit SHA,
  path, line/record index, Git author, and commit timestamp. When a merge
  touches the path, the first-parent merge commit is the introducing carrier
  and its author is the bound author.
- A record actor matches its introducing commit when, after trimming and
  case-folding, it equals the Git author name (`%an`) or the full
  `Name <email>` identity.

This is committed Git provenance — evidence of which commit introduced a
line — not authenticated identity or signed authorship. The latest commit
touching the file is never treated as provenance for every line.

The mutable task file cannot authorize its own dispatched contract. For a new
task or transition to `agent-ready`, store a versioned
`agenticloop.task-contract-record` in the append-only task-history projection
that is committed separately from the task-file edit. Its stable carrier id is
the committed history artifact (`commit:<full-sha>:<path>:<line>`), and its verified
author is the introducing commit's author as checked by the repository's normal
review/commit provenance. It records task id, digest, authority, actor,
timestamp, and affected artifact. A correction record additionally records
prior/resulting digest, changed fields with old/new values, and reason. Body
markers may cache record references only. Historical baseline-less task files
warn until their next material contract edit or readiness transition; do not
synthesize past records.

`task authorize-correction <id> --expect-prior-digest <digest> --reason <text>
--authority <kind:reference> --actor <git-author>` loads and validates the
committed trusted chain, requires its terminal digest to equal
`--expect-prior-digest`, computes the current task file's projection and
exact canonical changed fields, validates the correction prospectively
against the chain, and appends it. The correction becomes trusted only after
a separate commit. `task establish-baseline` refuses to create a second
baseline when trusted history already contains one.

### CLI Support

The files backend remains Markdown-first; the CLI is a convenience and
consistency layer, not a required runtime. Agents may still edit files directly.

Operation mapping:

- Create a non-activated Markdown scaffold: `agenticloop task new <title>
  --scaffold [--id <id>]`.
- Authorize one or more existing tasks for dispatch: `agenticloop activate
  <task-id...>` or `agenticloop activate --work-unit <id>`. This is the
  universal path; it needs no host plugin, requires an interactive operator
  confirmation, and never rewrites a task record.
- Create an activation-bound task directly from a supported host-produced v2
  capture: `agenticloop task new <title> --activation-input <capture.json>
  [--host-trust-store <derived-path>] [--id <id>]`. No shipped adapter provides
  that supported capture path; it requires a registered protected host adapter.
- Read task record: open `.agenticloop/tasks/<TASK-ID>.md` directly.
- List task records: `agenticloop task list [--status <status>] [--json]`.
- Update status: `agenticloop task status <id> <status> [--note <text>]`.
- Mark needs context or blocked: `agenticloop task status <id> needs_context
  --note <text>` or `agenticloop task status <id> blocked --block-category
  <category> --note <text>`.
- Lint task records: `agenticloop task lint [<task-id>] [--json]`.
- Establish a contract baseline: `agenticloop task establish-baseline <id>
  --actor <git-author> --authority <kind:reference>`, then commit separately.
- Authorize a contract correction: `agenticloop task authorize-correction <id>
  --expect-prior-digest <digest> --reason <text> --authority <kind:reference>
  --actor <git-author>`, then commit separately.

### Create Task Record

`task new` is intentionally fail closed. A v2 capture binds a unique capture
ID, the intended task ID, the canonical target repository, capture/expiry
timestamps, the operator and normalized activation digests, and the host key.
The CLI resolves an automatic `T-###` ID before verifying the capture; a
conflict or mismatch fails before authoring.

A scaffold task has no activation authority and cannot be dispatched in that
state. It does not have to be recreated: run `agenticloop activate <task-id>`
in an interactive terminal and it becomes eligible for dispatch with
`operator_confirmed` assurance. Activation records live under
`.agenticloop/activations/` and are authenticated against an operator key held
outside the repository, so a hand-authored record in the target cannot
self-authorize. Dispatch resolves a current legacy host-signed capture first,
then a current task activation binding, then blocks.

Successful return verification records live under
`.agenticloop/returns/verifications/` and are workflow evidence, never
implementation output. Closeout revalidates their packet authority and retained
host receipts. Revocation authority is the external create-only operator
tombstone; a target-local revocation is only a mirror.

Create `.agenticloop/tasks/<TASK-ID>.md` using `agenticloop/memory/task-record.md`.
Do not leave placeholder sections.

### Incremental task-set creation

Files-backed task creation is a per-task workflow gate. Large task sets should
not be written as one oversized patch. Materialize durable task records one at a
time by default, or in a bounded batch of at most 3 simple records when the tasks
are similar and low-risk. Checkpoint and commit each record or batch at the
task-creation gate when the target project follows that discipline. If
materialization is interrupted, resume from the existing task files and the first
missing or invalid task id instead of regenerating the whole set.

### Read Task Record

Read frontmatter for mechanical state and the body sections for scope,
evidence, comments, and review history.

### List By Grouping And Status

List files under `.agenticloop/tasks/` and filter by status plus any optional
grouping field the project uses.

### Update Status

Update the `status` frontmatter field and append a dated note under
`## Comments` when the reason matters.

Recommended statuses:

```text
draft
agent-ready
in-progress
needs_context
blocked
needs_revision
accepted
closed
```

### Mark Needs Context

Set:

```yaml
status: needs_context
```

Append a comment explaining what is missing and who can answer. Include
`context_reason: context_overflow` when context pressure caused the pause.

### Mark Blocked

Set:

```yaml
status: blocked
block_category: <category>
```

Append a blocker section with what was tried, why progress stopped, and the
action needed to resume.

### Change-Request Classification And Approval

For files-backed locked-decision changes, record classification and approval in frontmatter:

```yaml
type: change-request
approved: true
```

Until approval exists, keep the task blocked with `block_category: contract` and explain the
hold in the task file.

### Attach Implementation Evidence

Publish or refresh the one current implementation summary in the task file.
Include fresh command output from the final state. If the refresh corrects a
previously published claim, evidence block, check result, or artifact reference,
append a dated entry to `## Revision Log` or `## Comments` before updating the
summary.

### Record Verification Attempts

For an exceptional required or cited check, replace the canonical empty state in
`## Verification Attempts` on its first record, then append new entries under
the matching `### RC-N` heading only. Routine first-pass passes remain in the
current summary and need no attempt entry. Preserve every earlier attempt,
foreground-escalation prediction, and maintainer triage verbatim, including the
artifact on which it ran. The exact entry shapes, retry limit, and final-triage
rules are owned by [[verification-evidence]].

Do not update `.agenticloop/project.md` from an engineer attempt. The maintainer
may update the profile's current `VF-...` fact after final triage; that mutable
profile never replaces the task's append-only evidence.

### Link Implementation Artifact

Record the implementation artifact in frontmatter. Mirror it in the implementation summary when
helpful:

```yaml
implementation_artifact: branch:<name>
```

Other valid references include `commit:<sha>`, `range:<base>..<head>`, a patch
path (`patch:<path>`), or a documented local-diff reference (`local-diff:<ref>`)
if the project records a checked-out local diff. The `## Revision Resolution`
matrix accepts these exact files artifact forms in `[ref: ...]`; branch and patch
casing is preserved and compared exactly, while hex SHAs are canonicalized to
lowercase. Patch and local-diff identifiers are also case-sensitive.

For a managed join, use an exact
`range:<full-40-sha>..<full-40-sha>` for the dedicated join task so
artifact-bound ownership validation has both identities. Record lane
`integrated_by: commit:<full-40-sha>` or
`range:<full-40-sha>..<full-40-sha>` only
after the final candidate, integrated checks, and review are valid. This field
is provenance, not merge authorization.

### Record Review Status

Set `review_status`, copy `implementation_artifact` to `reviewed_artifact`, record
`review_mode`, and append the maintainer review
section.

```yaml
review_status: accepted
reviewed_artifact: commit:abc123
review_mode: host_subagent
```

When `implementation_artifact` changes, clear or replace all mutable current
review fields: `review_status`, `review_mode`, `reviewed_artifact`, and
`human_review_ref` when applicable. The append-only review sections preserve
earlier rounds. See [[review-and-accept]] for shared review semantics; files
validation mechanically requires the two artifact fields to match exactly.

For a record-only Lens 1 correction, do not claim same-artifact reuse merely
because the implementation diff looks unchanged. If updating the durable task
record changes `implementation_artifact`, prior conclusions are stale unless the
existing exact-match rule already proves identity. Do not add a content-hash or
equivalence mechanism.

A review outcome entry in `## Review History` may declare
`- Classification: implementation_changing` or `- Classification: record_only`;
absence defaults to `implementation_changing`. Only consecutive valid
implementation-changing `needs_revision` outcomes sustaining the same active
finding IDs trigger the no-progress guard. The first typed `needs_revision`
outcome after a legacy missing-findings review allocates IDs from `F-1` and
forms the typed baseline.

### Maintainer Review Fixup (files projection)

[[review-and-accept]] owns the eligibility gate and full procedure. Files-specific
projection:

- Apply the fixup to the current recorded local artifact (branch, commit, range, or
  patch); do not create a PR, merge, or no-review exception through this path.
- Attribute maintainer-authored commits with the `Task: <TASK-ID>` and
  `Agent: maintainer` trailers.
- Update `implementation_artifact` to the resulting artifact and clear or replace
  the stale mutable review fields.
- Append the fixup disclosure to the append-only review history, and append a dated
  `## Revision Log` or `## Comments` entry before refreshing any previously
  published summary, evidence claim, check result, or artifact reference.
- Rerun every required final-state check and refresh the current implementation
  summary and `## Evidence` for the new artifact.
- Set `reviewed_artifact` to exactly the resulting `implementation_artifact` and
  accept only after a fresh three-lens review round, with `review_mode: single_agent_fallback`.
- Use `closed` only after integration, as before.

### Review Round Checkpoint

When `needs_revision` rounds reach the task's `review_budget` (default 5 unless
materialized from project policy otherwise), the
orchestrator must record a durable checkpoint before routing the next revision.
For files-backed, append review outcomes and the checkpoint to the one
append-only `## Review History` section. The checkpoint entry itself is:

<!-- agenticloop:canonical-checkpoint files -->
```text
### Review Round Checkpoint

- Direction: targeted_revision
- Cause: implementation_defect
- Review count: 5
- Artifact: commit:abc123
- Target: F-2: refresh the local verification evidence
- Review role carrier: agenticloop.review-role-carrier/v1
- Role ID: orchestrator
- Actor account: orchestrator
```

The checkpoint schema requires:
- `direction`: one of `targeted_revision`, `needs_context`, or `blocked`
- `cause`: one of `implementation_defect`, `evidence_drift`,
  `task_contract_ambiguity`, `scope_pollution`, `reviewer_engineer_disagreement`,
  or `external_blocker`
- `review_count`: the current number of durable `needs_revision` outcomes
- `artifact`: the latest reviewed artifact
- `target`: required when direction is `targeted_revision`
- `reference`: required when direction is `needs_context` or `blocked`
- `orchestrator`: required; files checkpoints, repairs, and no-progress
  legacy carriers declare `Orchestrator: orchestrator`; new carriers declare
  `Review role carrier: agenticloop.review-role-carrier/v1`, immutable
  `Role ID: orchestrator`, and a distinct field namespace for `Actor account`.
  The raw account may legitimately be `orchestrator`; writers require supplied
  attribution and never invent a local account. Legacy role tokens remain
  readable only in their historical role spelling and do not grant authority to
  arbitrary values.

A `targeted_revision` checkpoint authorizes exactly one next revision. If that
revision receives another `needs_revision`, a new current checkpoint is required.
The budget is never reset and an old checkpoint cannot be replayed. Reject
missing, stale, malformed, or reused checkpoint authorization.

Files task validation and `task status needs_revision -> in-progress` reject an
over-budget next revision without a current checkpoint. The checkpoint binds
reviewed artifact A and authorizes one next revision B; it does not reset the
review budget.

When prior `needs_revision` outcomes have recorded finding IDs, a
`## Revision Resolution` section with exactly one bullet entry per finding is required
before re-review. Each bullet entry must have a disposition of `resolved`, `disputed`,
or `blocked` with current evidence.

### Close Or Accept Task

Set:

```yaml
status: accepted
```

Only after scope, quality, evidence, and follow-up triage pass review. Use
`closed` after the implementation artifact is merged or otherwise integrated.

### Run Closeout

Closeout is a verify-and-mark gate; it does not write a separate summary file.
When a human-identified task set or configured group finishes, confirm each
task's inline `## Scope Completed` summary and evidence are complete, then record
the closeout status marker through `closeout prepare` then `closeout record` on
the last accepted task record (see [[task-closeout]]). The files projection
appends a new superseding correction marker rather than erasing history; retrying
an exact current digest is idempotent. Packets are transient and may be written
only below `.agenticloop/tmp/`.

Before the final audit freeze, the single-writer Maintainer closeout lane follows
the conditional selected-plan progress procedure in [[task-closeout]]. Record its
path, affected item, state transition, and covered task IDs in the closeout note.
If it changes the repository, refresh the candidate baseline and certification
before publishing `AGENT_CLOSEOUT_STATUS: complete`.

## Review Preparation And Recovery

The files `## Revision Resolution` matrix contains only the immediately prior
valid `needs_revision` finding IDs. Prior rounds stay append-only in
`## Review History`. Resolved entries bind their structured files artifact
reference; do not duplicate an identity in prose. Stable IDs are task-history
scoped: sustained IDs remain, omitted or withdrawn IDs retire permanently, and
new IDs use the next unused number without validator semantic inference.

Append `### Review Round Checkpoint Repair` only for one bounded trusted-role
equivalent repair of a named malformed checkpoint. It records the source,
original role, reason, and mechanically derivable corrected fields; it cannot
change authority-bearing direction/cause/target, artifact, count, or outcomes,
and it never becomes a checkpoint itself.

`Corrected fields` names only mechanically repairable fields. The canonical
versioned names are:

- `review_count` and `artifact`, derived from authenticated ordered history;
- `actor_account`, derivable **only** from the authenticated GitHub author of
  the repaired source. Files-backed history has no authenticated source, so a
  real files actor identity is not derivable and the checkpoint must be
  reissued rather than repaired. The legacy files `Orchestrator: orchestrator`
  value is the fixed trusted-role spelling rather than an account, so restoring
  it stays a contract-fixed repair;
- `role_id`, fixed by the carrier type's immutable role contract
  (`orchestrator` for checkpoints);
- `review_role_carrier`, fixed by the one supported carrier version.

The legacy `orchestrator` spelling remains parseable for existing history and
normalizes to `actor_account`; newly emitted repairs write the canonical
versioned names. Repairs stay append-only, are restricted to the original
authenticated author, may happen at most once per source, and are refused once a
later review outcome has consumed the source. Append `### No Progress Disposition`
for repeated stable findings using `targeted_revision`, `split_task`,
`contract_decision`, or `blocked`, bound to the exact sustained finding IDs plus
the required target/reference; it stays distinct from checkpoint direction and
cannot authorize a parent revision except the documented targeted path.

Typed required checks keep proof kind separate from satisfaction source, and
manual/contract-proof checks require the canonical structured per-observation
records owned by the verification-evidence skill.

## Current State and History Discipline

Files-backed task records use a hybrid model: some fields are mutable current
state and some sections are append-only history. The frontmatter fields and the
current implementation summary are the mutable surface; the comments and
revision-log sections grow append-only.

### Mutable current state

These may be updated in place to reflect the latest truth:

- YAML frontmatter fields: `status`, `review_status`, `implementation_artifact`,
  `block_category`, `type`, `approved`, and other mechanical state.
- The one current `## Scope Completed` (or legacy `## Implementation Summary`)
  section. This section may be refreshed to match the latest artifact and
  evidence.

### Append-only history

These sections grow over the life of the task and must not be rewritten or
truncated:

- `## Comments` – dated notes on status changes, context, and decisions.
- `## Revision Log` – dated entries recording corrections to previously
  published claims, evidence, artifact references, or check results.
- `## Verification Attempts` – per-`RC-N` attempt, prediction, and triage
  history. Append entries only; do not rewrite a prior record.
- Blocker sections added while the task is blocked.
- `## Review History` – append-only numbered review outcomes and checkpoints.

### Correction rule

If an agent changes a previously published claim, evidence block, check result,
status justification, or artifact reference in the current implementation
summary, it must append a dated entry to `## Revision Log` or `## Comments`
before refreshing the current summary. The entry must name what changed and why.
Silent correction of published claims is a review blocker.

### Durability rule

`.agenticloop/tasks/*.md` task records are durable tracked state by default.
They should be committed at workflow gates: task creation, evidence publication,
review result, revision, and acceptance or closure.

`.agenticloop/tmp/` and `.agenticloop/logs/` remain local or ignored unless a
target project explicitly chooses otherwise. Event logs (`.jsonl`) are gitignored
by default.

### Review implication

Review must inspect untracked files with
`git status --short --untracked-files=all` and must not rely solely on
`git diff HEAD`, which misses untracked task files.

Untracked `.agenticloop/tasks/*.md` files are a review blocker unless the
project explicitly records a local-only exception in `.agenticloop/project.md`
or the task file itself.
