# Agentic Loop Methodology

## Executable Review Preparation

Use `pr-body scaffold/lint -> github-preflight -> github-review-prepare ->
Maintainer review -> github-review-audit -> github-ready`. The Engineer authors
the PR body in Markdown: after the final implementation push and required
checks, `pr-body scaffold` renders the local draft (and an optional versioned
offline context snapshot with materialized task/decision inventories), and
`pr-body lint` evaluates the local draft against live read-only context
(`--pr --body-file`) or the CLI-authored snapshot (`--snapshot --body-file`)
before any explicit body write. Preparation is
read-only and dispatches only a schema-valid, PR-bound, exact-head `ok === true`
packet, and `github-review-prepare` evaluates published live state only; it is
never the unpublished-draft linter. Status checks never substitute declared
observation records, and stable
IDs never substitute the exact declared command. The current matrix holds only
prior active IDs and structured resolved references; history is append-only.
Same-author checkpoint repair is bounded and no-progress remains separate from
checkpoint direction and the global review budget.

## Gate Ownership And Dispatched Contract

A failing gate is a typed routing decision, never authorization for the
Orchestrator to perform another role's repair. The Orchestrator may re-delegate
to the diagnostic owner, escalate when named human authority is required, or
stop at the applicable hard checkpoint. It must not edit Engineer-owned PR
bodies or implementation commits, or Maintainer-owned task records, while a
valid delegation path exists.

When a task becomes `agent-ready` or implementation starts, its scope and
out-of-scope sections, `allowed_paths`, `intended_creations`, acceptance
criteria, required checks, independent-review requirement, and relevant locked
decision references form the dispatched contract baseline. The Maintainer
records it before dispatch in a separately verifiable carrier naming authority,
author, actor, time, and artifact. The body may cache it but never authorizes it.
Historical missing data warns; never invent history.

An `agent-ready` transition carries one validated evidence context through
pre-write and post-write validation: exact task identity, expected predecessor
digest, a resolved base tree object id (never a symbolic branch name) with its
canonical inventory digest, and a dependency snapshot naming its source, digest,
observation time, freshness policy, and evaluated state. Every record requires
that context, including records with no contract schema; nothing is defaulted
from a branch or an inferred dependency state.

The guarded receipt is mechanically derived from that exact context. It binds
the expected, candidate, and resulting digests, the evidence-context digest, the
verification-result identity, each owned projection's attempted and
verified-complete state, changed paths, the mutation disposition, and one safe
read-only revalidation command carrying the actual
resulting digest. A revalidation argument is emitted only when one spelling is
inert and byte-exact across POSIX shells, PowerShell, and `cmd.exe`; otherwise
the command is refused rather than weakened. The canonical CLI registry must
also mark the exact command leaf as receipt-safe; unmarked commands, dynamic
event types, option-dependent writers, and unknown forms fail closed. Lifecycle
commands qualify only with their registered `--dry-run` mode. A `rolled_back`
receipt is resolved only when its closed rollback evidence proves the
predecessor digest was restored exactly, the receipt resulting digest names that
same predecessor, and changed paths are empty.

Files mutations apply through the shared filesystem mutation kernel: identity
is compared immediately before the write, the exact resulting bytes are
refetched and revalidated, and a post-write mismatch returns an unresolved
receipt naming the changed paths and a safe recovery rather than an error
string. A candidate and its conditional-write digest are derived from the same
source bytes; a second planning read cannot bless a candidate derived from stale
content. A later read without the evidence context is
`verification_context_missing`, not proof that the committed transition is
invalid, and never authority for a rollback or compensating transition.

A malformed, ambiguous, or unknown current record cannot authorize a mutation.
An ordinary transition never doubles as a repair: recovery uses the explicit
correction-authority path, and insufficient authority quarantines the carrier
without mutation or dispatch.

Carrier trust is explicit, not inferred from payload content. Untrusted or
excluded carriers are ignored noise; an edited authority carrier is rejected
without poisoning the chain; a malformed record on a trusted carrier is fatal;
missing carrier metadata fails safely as an adapter error. A legacy task that
materially changes its contract, and any task entering `agent-ready`, requires
a trusted baseline chain first; steady-state historical tasks only warn.
Runtime diagnostics report facts (level, code, category, repair kind,
escalation kind, evidence) and never choose a workflow role: role ownership
is bound once from role capability declarations and derived only at the
CLI/workflow presentation boundary. `agenticloop validate` checks those
declarations. A complete installed legacy role set with no capability fields
temporarily uses bundled bindings with a migration warning; partial,
conflicting, or unknown declarations fail validation.


An unmatched implementation path is either an exact Engineer-authored PR
`## Deviations` entry with a non-empty reason when it remains within accepted
intent, or `needs_context` followed by a visible Maintainer correction. Never
widen `allowed_paths` after the fact merely to describe the current diff. A
correction records old value, new value, reason, authority, and affected
artifact; a hidden scope or task-contract correction blocks review. Detailed
carrier, readiness, and recovery rules live in [[task-record-contract]] and the
selected backend document.

Agentic Loop is a supervised implementation workflow for AI coding agents. It
turns a vague request into a durable task record, a scoped implementation,
evidence, review, and closeout.

The methodology is host-neutral. All five implemented host adapters - OpenCode,
Codex, Claude Code, GitHub Copilot, and Cursor - are supported. The workflow
should read naturally in any agent that can follow Markdown instructions and
load skills.

## Shared Transition Contract

Every backend projection uses the versioned `agenticloop.transition-contract`
schema. Its executable definition is an internal module bundled with the
Agentic Loop CLI at package path `src/transition-contract.js`; it is not copied
into target projects. This section is the installed, human-readable methodology
contract. It is a fact and authority contract, not a scheduler, controller, or
alternate task store.

### Workflow role identity

Workflow roles are declared by one canonical registry. Each registry entry has:

| Field | Meaning |
| --- | --- |
| `roleId` | Immutable lowercase machine identity used in durable records, filenames, ownership references, provenance, dispatch, and return packets. |
| `defaultLabel` | Mutable human-readable display label. It is not authority and may be renamed or replaced by a localized renderer. |
| `escalationPrecedence` | Unique positive integer used for deterministic escalation-owner selection. Lower values take priority; ties are invalid. Array position and alphabetical order are not authority. |

The current registry is:

| `roleId` | `defaultLabel` | `escalationPrecedence` | Capability source |
| --- | --- | --- | --- |
| `orchestrator` | `Orchestrator` | `10` | `agents/orchestrator.md` frontmatter |
| `maintainer` | `Maintainer` | `20` | `agents/maintainer.md` frontmatter |
| `engineer` | `Engineer` | `30` | `agents/engineer.md` frontmatter |
| `auditor` | `Auditor` | `40` | `agents/auditor.md` frontmatter |

The closed role-identity policy is:

| Policy field | Value |
| --- | --- |
| `durableIdentity` | `roleId` |
| `labelUsage` | `display_only` |
| `semanticDigestExcludedField` | `defaultLabel` |
| `capabilitySource` | `agents/<roleId>.md frontmatter` |
| `roleIdRename` | `versioned_alias_or_explicit_migration_required` |

Capabilities are mutable role metadata and do not define role identity.
Executable owner fields always contain `roleId`, never `defaultLabel`. Generated
prose may resolve a label at presentation time, but changing a label must not
change durable identity, ownership, precedence, filenames, or projection
semantics.

Display-bearing backend projections may carry `defaultLabel` for renderers and
therefore may differ textually after a label rename. The canonical semantic
projection used for authority comparisons and digest input mechanically removes
the policy's `semanticDigestExcludedField`, which is `defaultLabel`. A
label-only rename must produce an identical semantic projection.

A `roleId` is never renamed in place because commit trailers and append-only
task, event, review, and audit history may already contain it. A replacement
requires a versioned alias or explicit migration that preserves old identities.
Adding a role is a deliberate registry extension with a unique ID and
precedence, a matching `agents/<roleId>.md` capability source, config
projection, adapter support or declared degradation, and contract tests.
Target-local additions are not registry extensions and fail validation. Preserve
useful custom agents as host-only helpers outside the managed
`agenticloop/agents/` namespace until a versioned extension provides the full
contract and migration support.

Capitalized field names such as `Maintainer:` and `Orchestrator:` in existing
review carriers are legacy protocol tokens, not display labels. They remain
stable until a separately versioned carrier migration introduces neutral
role-ID fields and backward-compatible parsing.

### Envelope and evidence

A serialized transition envelope is self-identifying with kind
`agenticloop.transition-envelope` and schema version `1`. It carries these
independently meaningful field groups:

| Field | Meaning |
| --- | --- |
| `kind` | Constant transition-envelope identity. |
| `schemaVersion` | Positive envelope schema version. |
| `transition` | Stable transition identity, source identity, and expected predecessor. |
| `artifact` | Exact task, candidate, branch, commit, range, or PR-head identity the transition consumes or produces. |
| `digest` | `sha256:<canonicalization>:<64-lowercase-hex>` over `agenticloop.transition-projection.v1` canonical projected content, never display text. |
| `provenance` | Producer, carrier, authority, and invocation facts; asserted provenance is labelled as asserted. |
| `freshness` | Exact identities compared, the observation time, and the invalidation condition. |
| `validation` | Typed result with diagnostics and evidence state. A result does not choose a repair owner. |
| `disposition` | One of `proceed`, `blocked`, `needs_context`, `rejected`, `superseded`, `exception_requested`, `exception_accepted`, or `exception_rejected`. |

The required-field list is a closed, order-insensitive inventory, not a
serialization sequence. Missing, duplicate, and unknown required-field entries
are invalid. Public validation results use kind
`agenticloop.validation-result`, schema version `1`, and the canonical serializer
in `src/result-envelope.js`. It recursively sorts object keys and sorts the
schema-declared set-like arrays (`errors`, `warnings`, `diagnostics`,
`warningDiagnostics`, and `failureCategories`) by exact UTF-16 code-unit order
of their canonical JSON representation before SHA-256. Semantically ordered
arrays retain their declared order. Equivalent set permutations therefore
serialize and digest identically across locales and hosts; incidental
object-property or set-array insertion order carries no authority.

Every required evidence input is classified as exactly one of `current`,
`missing`, `malformed`, `stale`, `negative`, or `changed`. `missing` means no
adequate input was supplied; `negative` means supplied, valid evidence proves
the required condition is false. `malformed`, `stale`, and `changed` also do
not mean negative. A verifier that lacks required context reports
`missing`/`verification_context_missing`; it does not invalidate a previously
verified write or authorize rollback or a compensating mutation. Public results
state `rollbackAuthorized: false`.

One canonical function maps a failed evidence state to its disposition, and
every public failure producer - gate presentation, review-entry resume packets,
and command-failure normalization - derives its disposition from it. A packet
therefore cannot report one evidence state beside a disposition that means
something else:

| Evidence state | Disposition |
| --- | --- |
| `missing` | `needs_context` |
| `malformed` | `rejected` |
| `stale` | `superseded` |
| `changed` | `superseded` |
| `negative` | `blocked` |

When several diagnostics declare states, one state is selected under the fixed
precedence `missing`, `malformed`, `stale`, `negative`, `changed`, so a root
cause is named rather than an incidental first entry. The selected state is the
single state carried by the packet's `evidence.state`, its embedded validation
`evidenceState`, that validation's `disposition`, the retained diagnostic
evidence state, and the accompanying first safe repair and resumable transition.

`ok: true` states that a request was authenticated and validly routed; it does
not by itself grant the next transition. A successful result normally uses
`proceed`. The one bounded exception is the successful non-terminal disposition
inventory `exception_requested`: the transition contract names it the refusal
disposition of the `exceptional_verification` authority rule, so a valid
exceptional request is reported as `ok: true` with disposition
`exception_requested`. No exception has been accepted or rejected, completion
stays false, and no implementation, task-mutation, acceptance, or closeout
authority is granted. `exception_accepted` and `exception_rejected` remain
distinct future authority edges owned by the named disposition owner. A failed
result may use neither `proceed` nor a successful non-terminal disposition.

Machine vocabulary inventories are closed:

- Evidence states: `current`, `missing`, `malformed`, `stale`, `negative`, `changed`.
- Dispositions: `proceed`, `blocked`, `needs_context`, `rejected`, `superseded`, `exception_requested`, `exception_accepted`, `exception_rejected`.
- Successful non-terminal dispositions: `exception_requested`.
- Return kinds: `agenticloop.role-return`, `agenticloop.exceptional-verification`.
- Liveness entries: `delegationLiveness`, `lease`, `cancellation`, `managedJoin`, `reviewNoMutation`, `rollback`.

### Activation assurance

Activation authority is graded on two independent dimensions. Neither is ever
silently upgraded, and neither substitutes for the other.

Activation assurance - how the authorization to work on a task was obtained:

| Grade | Meaning |
| --- | --- |
| `host_signed` | Parser/host-owned activation capture authenticated by an isolated signer registered in the operator trust store. |
| `operator_confirmed` | Explicit local operator confirmation of the exact task/work-unit state, authored by the CLI and signed with an operator key held outside the target repository. |
| absent | Scaffold or unactivated. Dispatch stays blocked. This is not a grade. |

Return assurance - how a role result's producer was established:

| Grade | Meaning |
| --- | --- |
| `host_receipt` | Authenticated host handoff receipt proving the observed producer role. |
| `session_reported` | Schema-valid role result reported through the coordinating session and revalidated against refetched repository evidence, with **no** authenticated host producer proof. |

Two overall modes combine them:

| Mode | Minimum activation | Minimum return |
| --- | --- | --- |
| `standard` | `operator_confirmed` | `session_reported` |
| `hardened` | `host_signed` | `host_receipt` |

`operator_confirmed` is procedural, local-user assurance: a human at an
interactive terminal on this machine saw the exact task set, carriers, and
contract digests and typed a confirmation. It is not equivalent to an isolated
host signer and does not resist arbitrary hostile code running as the same OS
user. No surface may describe it, or a `session_reported` return, as
cryptographically host-authenticated.

Effective policy resolves from two sources. An operator pin held outside the
target repository sets a floor; the target's own `agenticloop.json` may only
raise it. Hardened policy therefore never rests on model-writable repository
configuration alone, and an agent editing target configuration cannot relax an
operator's floor. A malformed pin or a malformed repository request fails closed
at `hardened`.

Both dimensions travel together through dispatch packets, validation results,
return results, audit records, closeout results, and human-readable output.

Closeout accepts return evidence only for its exact work unit, task contract,
and activation authority. For that tuple the latest successfully verified
observation is the current terminal return; older observations remain history,
and equal-time competing observations fail closed. Files and GitHub returns
both rederive the exact returned commit range and require its head to remain an
ancestor of the current checkout, allowing later contract-preserving workflow
commits without accepting rebased-away work. GitHub also refetches the live PR
identity before an observation can remain current.

Activation and return adapters are independent. A declared capability is repair
guidance, not evidence that a capture or receipt occurred.

#### Durable activation records

`agenticloop.activation-grant` (schema version `1`) and
`agenticloop.task-activation-binding` (schema version `1`) are durable
target-owned records under `.agenticloop/activations/`. They are evidence
dispatch consumes later, so they never live in `.agenticloop/tmp/`.

A grant names its canonical grant ID, repository identity, backend, scope
(an exact task set, one work unit, or a captured request), operator-intent
digest where applicable, assurance, producer and channel, issue and expiry
instants, revocation identity and state, the confirmation or host evidence, an
authentication signature, and its canonical semantic digest.

A binding names its canonical binding ID, the grant ID and grant digest,
repository identity, backend, task ID and carrier, the **exact current
task-contract digest**, its derivation (direct operator confirmation, direct
protected-host binding, or committed decomposition membership), the committed
decomposition source reference and digest when derived, inherited assurance,
issue and expiry instants, an authentication signature, and its canonical
semantic digest.

Signatures are verified against a key held outside the target repository. A
hand-authored grant inside the repository therefore cannot self-authorize, even
when every field and digest is internally self-consistent. Unknown fields,
unknown assurance values, contradictory derivations, stale task-contract
digests, expiry, revocation, and cross-repository reuse all fail closed.

A work-unit grant derives a child binding only from current committed
decomposition evidence: canonical work-unit match, Maintainer attribution, the
exact committed source reference and digest, a complete authoritative inventory,
membership in the canonical `readyTaskIds`, the exact child task-contract digest,
current freshness, and a bounded grant expiry. One work-unit activation is never
unlimited authorization for arbitrary future tasks.

Existing `activation_input_digest` and `activation_capture_ref` task frontmatter
remain valid legacy provenance. Grant records are an alternate authorized
source, not a forced rewrite: existing tasks and projects never need recreation.

Dispatch packet schema version `8` carries the complete signed grant and task
binding in `activationBinding`; its packet digest is integrity, not
authentication. Preparation, pre-mutation revalidation, return import, and
closeout revalidate signatures, repository/backend/carrier/task-contract
binding, expiry, decomposition, effective policy, and external revocation state.
Authentic packet versions `2` through `5` are typed stale.

Successful returns are persisted as `agenticloop.return-verification` version
`4` under `.agenticloop/returns/verifications/`. Every non-v4 record is a typed
incompatibility, including released schema v2 and interim schema v3. Those
records remain historical evidence but cannot be relabelled, migrated, or
consumed as current; safely resume with freshly produced current evidence. Closeout derives return
assurance only from these observed records and reauthenticates retained host
receipts. Missing activation or return evidence is below both mode minimums.
Genuinely pre-activation work has one explicit, interactive, standard-only
`closeout prepare --legacy-unactivated` signed waiver path; the exact-work-unit
waiver explicitly makes no activation claim. Revocation is externally
authoritative through repository-specific create-only tombstones under the
operator activation root, so deleting target-local state cannot restore a grant.

### Identity chain

The operator's expected request digest is the root of request-integrity proof.
A model-authored restatement is advisory text and cannot prove the original
operator input.

| Boundary | Authoritative identity and owner | Required evidence and freshness | Permitted disposition / absent or invalid evidence |
| --- | --- | --- | --- |
| `operator_request` | Operator-supplied expected SHA-256 | Digest of the exact authorized UTF-8 request; fixed for the activation attempt | Supported/missing is `needs_context`; model prose cannot substitute. |
| `activation_input` | Adapter-issued parser-capture receipt and normalized-input digest | A target-scoped Ed25519 public key in the fixed host-owned operator registry pins the canonical checkout and adapter/key. The signed capture binds exact UTF-8 bytes, target identity, their digest, and comparison to the operator digest before task authoring. Prompt text, model-created JSON, repository-local trust data, and caller-selected alternative stores are never evidence. | Supported/verified proceeds; mismatch is rejected and unsupported capture is blocked before mutation. |
| `authored_task` | Task ID and trusted contract digest; owner is typed by the boundary | Current durable task record plus trusted baseline/correction chain; digest equals material task projection | `proceed`, `needs_context`, or `rejected`; quarantine mutation and dispatch until repaired by the boundary owner. |
| `dispatch` | Preparation-packet ID and task digest; owner is typed by the boundary | Refetched task digest, base/dependency evidence, role, and capability references | `proceed`, `blocked`, `needs_context`, or `rejected`; do not dispatch an under-specified packet. |
| `role_return` | Producing-role return ID and consumed packet digest | Schema-valid role return naming its producer and exact artifact or blocker evidence | `proceed`, `blocked`, `needs_context`, or `rejected`; reject and re-route invalid returns to the producing role. |
| `review` | Review-entry receipt and reviewed artifact; owner is typed by the boundary | Passing exact-head receipt plus durable verdict; reviewed artifact remains current | `proceed`, `blocked`, `rejected`, or `superseded`; prose cannot publish review-ready or acceptance. |
| `audit` | Audit ID, run, and frozen candidate; owner is typed by the boundary | Fresh schema-valid report persisted unchanged; candidate and covered set still match | `proceed`, `blocked`, `exception_requested`, or `rejected`; invalid reports return to the owning role. |
| `terminal_closeout` | Closeout packet and marker digest; owner is typed by the boundary | Current closeout gate packet and provenanced marker against current candidate/carriers | `proceed`, `blocked`, `superseded`, or `rejected`; changed inputs make the marker stale and require reprepare. |

### Single-role dispatch and return

One implementation handoff uses `agenticloop.role-preparation`, schema version
`8`, defined in the bundled `src/dispatch-envelope.js` module. It is a read-only
handoff artifact, not a controller, lane-result store, task mutation, or shared
durable-state import. Its canonical digest is
`sha256:agenticloop.role-preparation.v8:<64-lowercase-hex>` and it binds the
current task/contract/activation identities, both assurance dimensions, freshly
evaluated readiness and base/dependency sources, committed Maintainer-attributed
decomposition evidence, scoped checks, immutable role and invocation IDs, canonical
references, the selected host, exact closed host-role capability declaration,
and canonical degraded-enforcement report inventory, branch/worktree,
attribution, liveness, and
cancellation. Any bound input changing stales the packet. The receiver verifies
its ID, digest, role, and current bindings before its first mutation.

Before assembling that packet, `task handoff-preflight <task-id> --json` is the
single read-only prerequisite report. It keeps carrier and protected-contract
digests distinct, resolves current activation authorization without prompting,
reports dispatch-bound decomposition and active/sibling worktree evidence, and
names one safe repair owner and command. A derived-only refresh plan may be
applied explicitly through `task refresh-handoff-evidence`; it cannot alter
protected task fields, human decisions, review dispositions, acceptance,
closeout, or product files.
Schema versions 2, 3, 4, and 5 are recognized as authentic prior evidence and
rejected as `dispatch.packet.stale`; regenerate the packet as version 7 rather
than reinterpreting or repairing an earlier version in place. Version 4 is not
migrated: its decomposition field carries the version 1 caller-asserted
completeness token, and no migration can supply the scan proof version 6
requires. Version 5 is not migrated either: it predates the assurance
dimensions, so it can neither state its activation grade nor carry an activation
grant binding.
An otherwise-current version 7 packet carrying the exact former version 3
degraded-enforcement report set is likewise rejected as
`dispatch.packet.stale` only after its original digest and complete
projected-current semantics validate. It is never migrated or accepted in
place, and malformed v3 lookalikes remain malformed.

Exactly one activation model is bound per packet:

- `activation` carries the legacy host-signed `agenticloop.activation-capture`
  (schema version `2`) and `activationBinding` is `null`; or
- `activationBinding` carries `agenticloop.activation-binding` (schema version
  `1`), a constant-size projection of a durable `agenticloop.activation-grant`
  plus `agenticloop.task-activation-binding` pair, and `activation` is `null`.

`assurance` is `agenticloop.dispatch-assurance` (schema version `1`). It states
both dimensions, the effective mode and its policy source, the minimums that
mode requires, and the verbatim honest limitation text for each grade. See
[Activation assurance](#activation-assurance).

Decomposition provenance is `agenticloop.decomposition-provenance`, schema
version `2`. Version 1 declared completeness as a caller-supplied token beside a
visible ready set; version 2 replaces that with a full validated
`agenticloop.parallel-scan` record, so completeness and ready membership are
derived from evidence rather than asserted. Authentic version 1 records are
recognized and returned as typed stale with regeneration guidance; a malformed
version 1 lookalike stays malformed and is never promoted into the trusted prior
class.

The committed decomposition source carries the whole scan record, because that
record is the proof. The packet carries `agenticloop.decomposition-binding`,
schema version `1`: a constant-size projection naming the source reference and
digest, the scan and inventory digests, derived inventory completeness, the scan
conclusion, ready count, route, and freshness. Packet size therefore does not
grow with the size of the work unit, and every dispatch refetches and
revalidates the committed source the binding names before mutation. A current
schema dispatch also re-enumerates the authoritative backend task inventory and
requires its identity, membership, and carrier digests to equal the scan. A
committed source cannot hide an omitted or newly authored task behind its own
`complete` field.

The single-role execution result is `agenticloop.role-return`, schema version
`4`, with digest `sha256:agenticloop.role-return.v4:<64-lowercase-hex>`. It
binds a unique return ID, immutable producer, exact packet ID/digest, backend and
task digest, exact branch/worktree and full 40- or 64-character base/head, changed paths,
structured checks, actual contiguous commit-range attribution, PR state,
blocker/resumption facts, and freshness invalidators. Its transition disposition
uses the canonical vocabulary: a successful Engineer result is
`disposition: proceed` plus the separate non-authoritative
`implementation_ready_for_review` outcome with `completion: false`; it is never
review-entry evidence or completion. Raw wire returns are schema-validated and
compared with refetched task, Git, check, and backend transport evidence plus an
authenticated host-adapter producer receipt. The host receipt is bound to the
exact target repository, packet-selected adapter/key, invocation, packet, return,
liveness, and repository-evidence digest and is authenticated with an
operator-pinned Ed25519 public key from the fixed host-owned registry outside the
target repository. A malformed,
stale, replayed, abbreviated, mismatched, repository-self-attested, or manually
reconstructed return is a typed rejection routed only to its producer.

A passed command check is proved only by the closed
`agenticloop.execution-evidence` schema version `3` artifact produced by the
public CLI. It binds the exact parsed required-check argv, packet and invocation,
task and carrier digests, repository and product heads, target paths, strict
timing, actual child exit code, and filtered output. Check prose or a claimed
zero exit code cannot substitute for this artifact. Schema-v2 evidence and its
digest domain are typed incompatible with v3 and must be regenerated, never
relabeled or re-digested.
The receipt records the producer role observed by the host boundary; it is not
derived from the packet assignment or return claim. That observed role must
match both. Commit attribution is reconstructed from durable full identities
and one final contiguous `Task: <resolved task id>` / `Agent: <immutable role
id>` pair, but those cooperative trailers cannot repair a producer mismatch.

#### Ordinary public handoff sequence

The ordinary public handoff uses CLI-authored artifacts, in this order:

1. The Orchestrator runs `npx agenticloop task prepare-dispatch <id> --host
   <host> --role engineer --output <packet-path> --json`.
2. Guarded role start consumes and revalidates that packet through `task status
   <id> in-progress --dispatch-packet <packet-path>`.
3. The Engineer uses `task check-evidence-init` and `task check-evidence-update`
   for packet-required checks, then derives the raw return with `task
   prepare-return`.
4. The receiving boundary runs `task verify-return <id> --packet <packet-path>
   --return <return-path> --from-current-repository`; only verified evidence
   proceeds to review preparation and review.

`--input`, `--output`, `--packet`, `--return`, and check-evidence paths are
target-relative, resolving below the selected target (the caller's current
directory unless `--target` selects another target). Do not inspect artifact
internals, hand-author JSON or digests, or substitute host status, messages,
opaque handles, or cancellation observations for a return. Host
cancellation/status alone does not establish cancellation.

### Canonical handoff recognition

Publishing `task prepare-dispatch` and `task verify-return` is not the same as
requiring them. A handoff mechanism is authoritative only where it is actually
consumed, so one shared host-neutral seam - `agenticloop.handoff-recognition`,
 schema version `2`, defined in the bundled `src/handoff-recognition.js` module -
decides whether presented evidence may authorize a protected lifecycle
transition. Files and GitHub supply the same normalized evidence and receive the
same verdict; installed host adapters project that verdict and never define
their own.

The protected transitions form a closed inventory. `role_start` requires a fresh
canonical prepared dispatch. `review_entry`, `acceptance`, `integration`, and
`closeout` each require a canonical verified return. Recognition binds the exact
task, dispatch packet, `taskContractDigest`, `dispatchCarrierDigest`,
`currentCarrierDigest`, `productBaseHead`, `productHead`, and
worktree, role, return schema, and assurance result; a supplied expectation the
evidence does not satisfy is a refusal, never a warning. Every expectation is
assembled from durable state and current operator policy, never read back out of
the evidence under judgement, and the packet itself is checked by the same
canonical validator `prepare-dispatch` and `verify-return` run - a digest that
matches its own projection proves internal consistency and nothing more.
`createPreparedDispatchValidation` therefore produces an unkeyed,
exact-packet-bound validation-result record: its digest detects alteration and
packet substitution but does not authenticate the validator or prove canonical
origin. `recognizeHandoff` is a trusted in-process evaluator, not a standalone
authority boundary. Authoritative files and GitHub commands rerun
`canonicalDispatchValidator` over the complete current packet before mutation;
no public CLI option accepts a caller-authored validation receipt. Persisted
receipts or verdicts crossing a process or trust boundary are rederived from
their underlying prepared dispatch or verified return.

All five transitions are consumed today: `task status`
and `task-body transition` decide the role start on the files and GitHub
carriers through one shared path; review preparation emits neither a reviewer
packet nor a lifecycle-bearing receipt without a recognized verified return;
files/GitHub acceptance and GitHub `integrated_by` mutation consume the same
chain; and closeout refuses completion the same way. The files role-start write
atomically records a closed, digest-bound dispatch-consumption record. GitHub
records the same receipt after the guarded remote edit; cross-transport atomic
recovery remains part of the lifecycle-mutation transaction work.

Refusals stay distinct rather than collapsing into one "invalid" state:
`handoff.evidence.missing`, `.malformed`, `.stale`, `.replayed`, `.mismatched`,
`.unsupported`, and `.unauthenticated`, plus
`handoff.transition.unsupported` and `handoff.expectation.malformed`.
`.replayed` is backed by the durable dispatch-consumption inventory under
`.agenticloop/handoffs/dispatch/`; a packet already consumed by either carrier
cannot start the role again. Role start also reruns the complete canonical
current-state dispatch verifier immediately before mutation, so task,
readiness, repository head/worktree, decomposition, inventory, activation, or
operator-policy drift supersedes the packet. Later transitions bind the return
to the exact consumption record and enforce a 24-hour transition-use freshness
ceiling in addition to canonical live return revalidation. That ceiling is an
immutable v1 recognition policy, not an operator-configurable setting. A verdict
that recognizes a handoff carries no diagnostics, reports evidence state
`current` and disposition `proceed`, and names the grade it consumed; the two
grade ladders never mix, so only `host_signed` activation or a `host_receipt`
return is authenticated recognition.

Agentic Loop cannot prevent a host or operator from invoking a role by hand.
Such an invocation, a model-authored return, and any narration of either remain
observable evidence graded exactly `session_reported`, recorded with
`authoritative: false`. A claimed higher grade is normalized back and the claim
is reported rather than honored. `agenticloop task status <id> in-progress`
requires `--dispatch-packet <path>` for an authoritative status mutation: with a
fresh binding packet the role start is recognized and its single-use
consumption is recorded; without one, with a replay, or with a packet that is no
longer current, the transition is refused with no durable lifecycle change.
Raw host observations remain reportable as `session_reported`; they are not a
route to `in-progress` state.

Requesting target status `in-progress` always requests a new role start, even
when the carrier already holds that status. Recognition runs before deciding
whether the carrier write is a validated no-op, and the fresh packet is consumed
exactly once. Supplying a note with that request is part of the new start and
does not create a note-only bypass; it therefore also requires a fresh packet.

### Carrier lineage and identity

Activation, operator authorization, and readiness are distinct gates. Activation
names the eligible workflow/session scope; the operator-confirmed task binding
names the work permitted now; readiness proves that exact task may start from its
current baseline, dependency, decomposition, and carrier evidence. A broader
activation never expands the exact task authorization, and neither replaces
readiness.

The protected `taskContractDigest` is immutable throughout an Engineer run.
`dispatchCarrierDigest` records the exact carrier consumed at role start, while
`currentCarrierDigest` may change only through the durable chain beginning with
the dispatch-consumption receipt and continuing through closed Engineer evidence
mutation classes. The current files path is: recognized `role_start_status`, then
zero or more `implementation_artifact_evidence`,
`implementation_summary_evidence`, or `implementation_outcome_evidence`
receipts. Scope, allowed paths, required checks, dependencies, activation, and
work-unit membership are protected contract fields, not Engineer evidence.

`productBaseHead` is the packet-bound start point, `productHead` is the returned
implementation artifact, `workflowHead` includes permitted workflow-only
evidence commits, and `candidateHead` remains null until a later candidate cycle.
Product paths, workflow paths, task carriers, and scratch paths are classified
separately. A new `## Deviations` entry cannot retrospectively authorize an
already-created product path: only scope bound into the packet before that work
can do so. Unknown or scratch paths fail closed.

For files-backed work, the Engineer records bounded evidence through the guarded
public command family before returning: `task evidence <id> --class ...
--expect-digest ...`. It writes the carrier and its receipt atomically and
refetches the resulting chain. After public `task verify-return` persists the
verified return, `task review-prepare <id>` consumes one command-local carrier
snapshot. If that carrier changes before the receipt write, review preparation
returns a typed changed/retry result and writes no review-entry state.

### Lifecycle and source of truth

#### Lifecycle claims

Free-form progress text is advisory and never completion authority. The derived
`implementation_ready_for_review` and `closeout_complete` claims additionally
require a recognized canonical handoff for their own protected transition:
without one the claim is not weakened or annotated, it is simply not made.
Claims are authoritative only under this exact evidence mapping:

| Claim | Authoritative evidence | Producer / evidence authority / work owner | Exact binding and invalidation | Without current valid evidence |
| --- | --- | --- | --- | --- |
| `implementation_blocked` | `structured_blocked_return` | Producing workflow role / same role or explicitly redelegated owner | Consumed transition ID/digest plus current blocker; invalidated by transition, evidence, or precondition change | `needs_context` |
| `implementation_ready_for_review` | `exact_head_review_entry_receipt` | Review-preparation gate / review-preparation gate / Engineer | Mandatory closed receipt for one final complete task/PR snapshot: full artifact identity, task and contract digests, checks/evidence, attribution, history, policy, and workspace; invalidated by any bound input change | `blocked` |
| `review_changes_requested` | `durable_review_changes_result` | Maintainer / Maintainer | Exact reviewed artifact and finding set; invalidated by artifact or carrier change | `rejected` |
| `review_accepted` | `durable_review_acceptance_result` | Maintainer / Maintainer | Exact current reviewed artifact; invalidated by artifact or acceptance-evidence change | `blocked` |
| `closeout_complete` | `current_closeout_marker_and_gate_receipt` | Canonical closeout path / Maintainer | Exact candidate, covered tasks, current packet-bound marker, and successful `closeout_owned_accepted_to_closed` receipt; invalidated by any bound input change | `blocked` |

An authoritative source owns only the fact in its row; task status, runtime
blocking, labels, comments, audit state, and closeout are not synonyms.

#### Source-of-truth facts

| Fact | Canonical source and owner | Files / GitHub projection carrier | Freshness | Authority |
| --- | --- | --- | --- | --- |
| `contract_readiness` | Trusted task-contract baseline; Maintainer | Append-only task-contract history / verified immutable task-contract comment | Current material task digest | Authoritative |
| `runtime_blocked_state` | Current structured blocked result; producing role | Role-return receipt referenced by task history / issue or review carrier | Current transition and unsatisfied preconditions | Authoritative for resumption only |
| `task_lifecycle_status` | Durable task-record lifecycle status; Maintainer producer, task-contract store persister | Task-file frontmatter / task-issue body frontmatter | Current record digest and trusted chain for material transitions | Authoritative |
| `labels` | Backend label set; backend projection | No files carrier (`applicable: false`, `carrier: null`) / issue labels | Refetched after owner reconciliation | Authoritative only for label presence |
| `comments` | Typed comment or history carrier; its producer | Append-only task history or enabled event log / issue comments and review bodies | Carrier identity, trust, and bound artifact when required | Authoritative only for the typed record it carries |
| `review_readiness` | Exact-head review-entry receipt; review-preparation gate | Exact implementation artifact receipt / exact PR-head packet | Artifact equals current artifact or head | Authoritative |
| `review_verdict` | Maintainer review result | Review fields plus history / trusted current-head review marker | Verdict binds current reviewed artifact | Authoritative |
| `audit_state` | Audit record and append-only report history; Auditor produces, audit CLI persists | `.agenticloop/audits/<audit-id>.md` / same backend-neutral audit record | Candidate and covered set equal certification boundary | Authoritative |
| `terminal_closeout` | Current provenanced closeout marker; canonical closeout path produces, Maintainer owns | Resolved task-carrier marker / trusted closeout comment or review body | Gate digest, candidate, tasks, and predecessor are current | Authoritative |

Each projection identifies itself with `projectionBackend`, retains
`supportedBackends` as the definition inventory, and selects each fact's
`carrierApplicability`. Files and GitHub preserve every other shared semantic
section.

#### Projection reconciliation

Observed carrier facts are compared through `agenticloop.projection-observation`
schema version `1`, and the comparison result is
`agenticloop.projection-reconciliation` schema version `1`. An observation binds
one canonical fact on one carrier: fact ID, backend, carrier applicability and
identity, the normalized value plus its
`sha256:agenticloop.projection-observation.v1:<64-lowercase-hex>` digest,
evidence state, producer/persister and typed-record authority, observation time,
invalidators, state provenance, and a provenance source reference. Transport
detail (issue numbers, URLs, revisions) travels in a separate `transport` field
that is excluded from the value digest, so an equivalent files and GitHub fact
digests identically.

For every applicable non-missing authoritative fact, producer and persister must
equal the owners in the canonical transition fact definition, the carrier must
hold a typed record, and current evidence must carry a non-null canonical value.

Construction and validation are separate. Building an observation may fill
fields in; validating a *serialized* observation may not. A record that arrives
from a carrier, a file, or another tool is held to the exact emitted shape -
every field present, no unknown fields, the canonical kind and schema version,
the closed carrier/authority/value shapes, and a `valueDigest` equal to the
digest recomputed from its own canonical value. Reconciliation validates
supplied records rather than repairing them, so a missing kind, an absent schema
version, a tampered digest, or a value edited under a retained digest is a
finding, not something the evaluator quietly fixes.

##### Required observation coverage

The required fact set for a backend is every fact that backend actually
projects. Authority-sensitive conclusions require all of them:

- zero observations stay `missing` / `needs_context`;
- one observation cannot make an authority-sensitive conclusion available while
  other required applicable facts are absent;
- each missing applicable fact produces an explicit `evidence.missing`
  diagnostic and is listed in `missingRequiredFacts`;
- a non-applicable carrier stays `not_applicable` and is never counted missing;
- partial reconciliation is still represented - each observed fact keeps its
  exact relation - but the authority-sensitive conclusion stays `blocked` until
  the required fact set is present.

Duplicate-carrier detection runs after applicability, so two non-applicable null
identities are never reported as one colliding carrier.

A carrier the backend does not project is `not_applicable`, never `missing`: the
files backend has no label carrier, and an observation that claims one is
rejected. Comparison is bounded by the canonical fact definitions plus one
closed cross-fact invariant inventory; any difference no invariant covers is two
distinct facts, not a contradiction. `agent-ready` contract state beside a
current structured runtime blocker is valid. A label proves label presence only.
A comment carrier is authoritative only for the typed record it carries, and
untyped prose is advisory. Stale review or closeout evidence is superseded, not
silently current and not automatically drift. Genuine drift is two current
authoritative carriers of one fact reporting different values, or a current
closeout marker reporting a closed unit while the authoritative task carrier is
non-terminal.

Each reconciliation reports a per-fact row naming that fact's canonical
producer, persister, authority, canonical source, and freshness rule - all read
from the transition fact definitions, never restated independently - plus its
relation, evidence state, state provenance, value digest, and observation count.
It also reports the evaluated invariants, the exact contradictions found, the
facts carrying unexplained drift, the required and missing required fact sets,
and whether authority-sensitive conclusions are `available` or `blocked`.
Contradictions, unexplained drift, invalid observations, and missing required
facts all block them. A load-time guard requires every fact ID named by a
cross-fact invariant to exist in the canonical fact inventory, so a contract
rename cannot leave an invariant silently comparing a fact that no longer
exists. The `verdictDigest` covers only the backend-neutral outcome, so files
and GitHub reach one shared verdict over equivalent normalized facts while each
keeps its own carrier applicability.

##### PR state is not a fact

There is no `pr_state` fact and none is needed. A pull request contributes two
canonical facts - `review_readiness` and `review_verdict`, each bound to its
exact reviewed artifact - and everything else about the PR (its number, URL,
open/closed state, head ref) is transport. Transport travels in the observation's
`transport` field, outside the semantic value digest, which is precisely what
lets a files-backed and a GitHub-backed unit reach the same verdict for the same
review facts. Adding a `pr_state` fact would make a transport detail an
authority-bearing semantic fact and would have no files-backend counterpart.

#### Parallel-scan provenance

A Parallel Opportunity Scan produces `agenticloop.parallel-scan` schema version
`1`, digested in the `agenticloop.parallel-scan.v1` domain with a separate
backend-neutral `agenticloop.parallel-scan-semantics.v1` digest. The record binds
the exact bounded work-unit identity and backend; the inventory ID, its digest,
and every member's task identity, carrier, digest, revision, and readability
state; the decomposition source, reference, revision, attribution, and derived
`complete | incomplete` state; the observation time, freshness policy, and closed
invalidator inventory; the ready task IDs; every excluded task with a stable
reason code, evidence state, evidence reference, and carrier digest; per-task
parallel eligibility and knowledge coupling with exact blockers; the pairwise
mutation relation and candidate pairs; the conclusion and rescan trigger.

Exclusion reason codes are `record_unreadable`, `record_malformed`,
`identity_ambiguous`, `lifecycle_terminal`, `dependency_unresolved`, and
`not_ready`. Conclusions are `parallel_candidates`, `not_currently_eligible`,
`no_eligible_work`, and `incomplete`. Scan invalidators are
`inventory_membership`, `inventory_enumeration_coverage`, `task_carrier_digest`,
`base_inventory_identity`, `dependency_status`, `ownership_declaration`,
`knowledge_coupling`, `decomposition_source_revision`, and
`observation_freshness`.

##### Authoritative inventory completeness

Completeness is never a caller assertion. The record's inventory carries a typed
`agenticloop.task-inventory-enumeration` version `1` receipt issued by the
authoritative enumerator - `agenticloop.files-task-directory.v1` or
`agenticloop.github-task-issue-inventory.v1` - naming the backend, the exact
inventory identity, the observation instant, the bounded coverage
(`discovered`, `returned`, `pageCount`, `truncated`, `cursor`), and a
`exhaustive | truncated | unknown` completion. An inventory is complete only
when its caller declared the exact boolean `true` **and** an exhaustive receipt
covers that exact surface with that exact member count. `null`, `0`, `''`, a
non-empty string, an object, and an omitted flag are never complete, and a
truncated or cursor-bearing enumeration is never exhaustive. A truncated,
invalid, unreadable, ambiguous, or caller-authored subset therefore cannot
produce `no_eligible_work`, `not_currently_eligible`, or `parallel_candidates`.

An issue whose transport identity is itself invalid is retained as unreadable
inventory evidence rather than dropped: a discarded carrier is an invisible
task, which is exactly the failure this contract prevents.

##### Bound readiness context

`basePaths` and dependency statuses change which tasks are ready without
changing a single task carrier digest, so the record binds a closed
`readinessContext`: the base evidence kind, identity, inventory digest, and path
count; the dependency evidence source, digest, observation time, freshness and
evaluated states, status count, and status digest; the observation time and
freshness policy; and a digest over all three. Base and dependency evidence use
the existing task-evidence contracts, not a second schema. Changing either
changes the scan identity, `dependency_status` has an exact evidence identity to
invalidate, and dispatch refetches and revalidates the bound context for the
whole ready set - so an unchanged task carrier digest cannot hide a changed
dependency status.

##### Conclusion order

Completeness is decided before ready count:

1. inventory or decomposition incomplete -> `incomplete`;
2. complete inventory with zero ready tasks -> `no_eligible_work`;
3. complete inventory with one ready task, or no valid candidate pair ->
   `not_currently_eligible` with the exact ready count and a concrete rescan
   trigger;
4. only a complete, fresh, fully accounted inventory can reach
   `parallel_candidates`.

Every discovered inventory member is accounted for exactly once, as ready or as
an explicit exclusion. An unreadable, malformed, duplicate, or ambiguous record
stays an inventory member and makes completeness fail closed; it never becomes
an invisible task. Parallel candidacy requires current readiness, resolved dependencies,
eligible structured ownership, a pairwise `disjoint` or valid `managed_join`
relation, and `independent` knowledge coupling; `coupled` uses the two-wave
rule and `unknown` stays non-eligible once the bounded discovery allowance is
spent. Set-like inventories and pair ordering are canonicalized, so a shuffled
listing produces the same scan identity while any changed bound input does not.
The record and every nested object use closed schemas. Pair evidence covers
every unordered ready-task pair exactly once, and `candidatePairs` equals only
the pairs classified `disjoint` or `managed_join`; recomputing a digest cannot
make a nonexistent task or an unclassified pair eligible.

The scan is read-only and deterministic. It validates and derives; it does not
decompose work or choose a solution, and it reuses the existing readiness,
ownership, eligibility, and pair-classification rules rather than restating
them.

##### Producer, parity, and freshness

`npx agenticloop task prepare-decomposition <task-id> --work-unit <id>
--source-ref <path> --source-revision <ref> (--base <ref> | --base-paths <path>)
--dependencies <path> [--route serial|parallel] [--observed-at <instant>]
[--max-age-seconds <n>] [--rescan-trigger <text>] [--repo <owner/name>]` is the
production path. It
lives inside the existing `task` command family, enumerates the configured task
surface itself, evaluates the scan, validates the emitted record with the same
validator its consumers run, constructs and validates the decomposition
provenance, and prints the committable source as deterministic canonical JSON.
It performs no task, Git, filesystem, GitHub, or lifecycle mutation, and returns
canonical `agenticloop.validation-result` diagnostics on failure. The inventory
enumerator is selected from `.agenticloop/project.md`. Files retain the exact
configured-directory enumeration. GitHub uses the injected read-only command
runner, follows every issue page, excludes only explicit pull-request carriers,
and records exact discovered/returned counts, page count, truncation, and any
unresolved cursor before shared normalization. Invalid issue identities remain
evidence. Dispatch repeats the same authoritative backend enumeration and
compares membership, carrier digests, readiness context, and decomposition
binding before mutation.

Construction and validation agree by contract: the evaluator runs the closed
validator on the record it just built and refuses to return a successful scan
for a record its consumers would reject. Every collection field -
`readyTaskIds`, `excluded`, `eligibility`, `knowledgeCoupling`,
`couplingBlockers`, `pairs`, `candidatePairs`, `invalidatedBy`, and inventory
members - must be an explicit array; a wrong-typed collection is a schema
violation, never coerced to an empty list that then re-digests as consistent.
Both validators are total over arbitrary JSON-compatible input and return
errors rather than throwing.

One canonical instant format - `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, UTC, second or
exactly-millisecond precision - is parsed by one parser shared by scan
construction, scan-record validation, decomposition validation, and dispatch, so
no layer accepts a timestamp another layer rejects. A timestamp more than five
seconds in the future is a future observation, not clock jitter, and is refused.
Freshness policies are bounded by a trusted maximum of 86,400 seconds rather
than any positive safe integer. Decomposition provenance restates the scan's own
`observedAt` and freshness policy exactly; both are derived from the bound scan
rather than accepted as producer inputs, so a caller cannot widen, narrow, or
otherwise rebind the policy the scan was observed under. Construction and
validation take an injectable clock.

`review_readiness` is carried by the review-entry receipt at schema version `3`,
digested in the `agenticloop.review-entry-receipt.v3` domain. The digest domain
is derived from the schema version so the two cannot drift. Older digest domains
are recognized as stale legacy evidence for diagnostics only; they never
authorize the v3 review-entry or dispatch boundary and are never silently
reinterpreted as v3. The receipt is deeply closed: required checks, evidence,
and review history are semantic digest snapshots, attribution trailers are
exact, and the complete canonical validation result is embedded and
digest-bound.

The schema-v3 preparation packet has its own whole-packet digest and one exact
immutable read-only lease. Structural and digest validation proves only that
the packet and receipt are complete, internally consistent, and
digest-consistent; it
proves nothing about current repository state. Only the current-state verifier,
which refetches the complete PR/task state, re-evaluates preflight, revalidates
the whole receipt, and reruns workspace identity verification at the recorded
path, may claim authoritative dispatch readiness.

A durable review carrier's versioned actor account is the authenticated source
identity that published it, not a self-asserted label; it is compared under the
backend's documented login normalization and preserved verbatim. The Maintainer
attribution trailer must be the final live nonblank line of its carrier.

Every repository-bound identity in the review path - review packet, review-entry
receipt, PR head, workspace head, expected artifact, review marker, commit
inventory, and Maintainer fixup base/result artifacts - uses one canonical
complete Git object identity rule that supports both repository object formats
(40-character SHA-1 and 64-character SHA-256). Abbreviated and uppercase
identities are rejected, and a single repository-bound claim never mixes the two
formats.

### Authority boundaries

#### Authority actions

| Action | Sole authority | Required evidence | Refusal when absent |
| --- | --- | --- | --- |
| `request_and_activation_identity` | Operator plus parser-controlled adapter | Expected digest and normalized-input receipt | Report unsupported or mismatch; do not trust a model restatement. |
| `blocked_result_resumption` | Producing role or explicitly redelegated owner | Current blocked result, resume transition, and preconditions | Block remains non-transferable. |
| `exceptional_verification` | Capability-derived disposition owner | Authenticated producer request bound to the consumed dispatch packet, failed/unavailable check, evidence, proposed disposition, and next transition | `exception_requested`; no implicit substitute or completion. |
| `destructive_or_scope_changing_recovery` | Human authority | Typed human disposition bound to exact blocked result and recovery | Human authority required. |
| `terminal_closeout` | Maintainer using `task_terminal_closeout` / `closeout_owned_accepted_to_closed` | Current closeout packet and passed closeout gate | Closeout gate required. |

The exceptional-verification disposition owner is **derived**, never claimed.
The boundary builds a trusted effective host-role capability inventory from the
selected host, the effective target configuration, the effective workflow-role
registry, and the canonical role policies, then revalidates that inventory
against the effective registry before selecting an owner. Exactly one role with
an allowed `task_workflow_mutate` binding is eligible; zero or multiple eligible
owners fail closed, as does a registry the inventory does not cover. The
request's `dispositionAuthority.roleId` must equal that derived owner, so a
role - canonical or a validly configured extension role - cannot select itself.
Capability inventories arriving through untrusted request or wire data are
ignored; only trusted invocation options carry an inventory, and that inventory
is validated before use. The derived disposition owner stays distinct from the
authenticated producer.

### Terminal and Markdown rules

Closeout scope is evidence-derived independently from `work_unit_audit`:

- `configured_group` requires `group_closeout: true` and current, valid exact
  grouping membership.
- `explicit_task_set` requires durable, current, authority-backed evidence that
  names the exact tasks: a typed human-selection receipt, current audit record,
  or current closeout marker/receipt.
- `none` requires proof that no configured group scope and no explicit durable
  scope evidence exists.
- `indeterminate` means relevant configuration, membership, authority, or scope
  evidence is missing, malformed, stale, or contradictory. It fails closed and
  never authorizes generic closure.

`work_unit_audit` maps independently to audit mode `enabled` or `disabled`.
Enabled mode requires a current audit certificate inside an established scope;
disabled mode does not, but closeout ownership remains.

#### Terminal variants

| Scope case | Scope source | Audit certificate | Generic `accepted -> closed` | Terminal owner/action |
| --- | --- | --- | --- | --- |
| `configured_group_audit_enabled` | Phase/custom grouping, `group_closeout: true`, current membership | Required | Forbidden | Boundary owner via `closeout_owned_accepted_to_closed` |
| `configured_group_audit_disabled` | Phase/custom grouping, `group_closeout: true`, current membership | Not required | Forbidden | Boundary owner via `closeout_owned_accepted_to_closed` |
| `explicit_task_set_audit_enabled` | Flat or other profile with current explicit durable selection | Required | Forbidden | Boundary owner via `closeout_owned_accepted_to_closed` |
| `explicit_task_set_audit_disabled` | Flat or other profile with current explicit durable selection | Not required | Forbidden | Boundary owner via `closeout_owned_accepted_to_closed` |
| `no_scope_audit_enabled` | Phase/custom `group_closeout: false`, or flat with no explicit selection | Not required | Allowed | Existing `generic_accepted_to_closed` |
| `no_scope_audit_disabled` | Phase/custom `group_closeout: false`, or flat with no explicit selection | Not required | Allowed | Existing `generic_accepted_to_closed` |
| `indeterminate_audit_enabled` | Missing, malformed, stale, or contradictory scope facts | Not applicable | Forbidden | `blocked`; no terminal action until scope repair and re-derivation |
| `indeterminate_audit_disabled` | Missing, malformed, stale, or contradictory scope facts | Not applicable | Forbidden | `blocked`; no terminal action until scope repair and re-derivation |

The canonical ordering inside closeout scope is: review accepted; integration or
exact candidate freeze; current audit gate when required; `closeout prepare`;
`closeout record`; then the closeout-owned terminal action. The runtime canonical
scope resolver feeds both generic terminal enforcement and audit-due derivation.
An unreadable or invalid task inventory is preserved as an indeterminate
audit-due result; it is never converted to an empty list that could disagree with
terminal enforcement.
Generic files-task closure remains valid only for a resolver-proven `none` scope,
which is returned only after proving that configured group scope and every
explicit durable scope source are absent. Explicit scope comes from any of the
three declared carriers - a typed human-selection receipt, a current validated
audit record, or a current closeout marker or receipt. Freshness is
carrier-specific: human selection uses `observedAt` with its maximum-age policy;
a marker is the supersession-resolved current marker on the current carrier
digest; an audit record is the exact current validated durable record bound to
its candidate artifact and covered tasks, without a separate time expiry. A
marker with `audit: none` has no configured-group fallback because configured
grouping is already resolved authoritatively before explicit marker evaluation.
Established
configured or explicit scope and every `indeterminate` result refuse direct
closure; the latter reports `blocked` with `repair_and_rederive_scope`.
`isTerminalTaskTransition()` recognizes the allowed post-certification content
delta but does not itself execute the closeout-owned transition.

Because generic closure is refused for every established scope, the terminal
transition stays reachable through closeout itself: after a fresh valid packet
and all required gates, `closeout record` performs
`closeout_owned_accepted_to_closed` over the exact covered task set. The files
backend uses one guarded transaction and emits an exact receipt; GitHub uses
guarded per-carrier transitions and reports partial external progress rather
than claiming cross-resource atomicity. Safe reruns resume from already verified
terminal steps, including a rerun that finds the marker already published: a
published marker is not a completed closeout, so the rerun finishes the covered
transitions rather than reporting success while tasks remain `accepted`.

Every prior lifecycle gate returns its own receipt. `init`, `setup`, and
`update` persist one to the target-owned workflow state and report it, keeping
filesystem transaction completion separate from Git commit status: a path
written to disk but untracked is untracked, never committed. Unresolved
prior-gate state blocks the next authoritative readiness edge. The receipt is
verified on every read rather than recognized: its fields are validated, its
recorded paths are re-fingerprinted, and its commit disposition is re-derived
from current Git state rather than read back. Committing the paths it lists
resolves the gate; a path leaving the index un-resolves it even though its bytes
never changed. Editing the receipt resolves nothing.

A carrier, candidate, covered task, or marker input changed after recording
closeout makes the marker `stale`; it does not erase history or trigger an
unexplained rebaseline. Reprepare from current state, then record a superseding
marker through closeout.

Mutable Markdown records follow one canonical rendering rule:

- Current-schema records have exactly one canonical H1 and exactly one of each
  required heading; optional headings occur zero or one time unless the schema
  declares them append-only.
- A semantic rewrite must preserve every unrecognized live block byte-for-byte
  and in relative order, or fail closed before mutation when that proof is not
  possible.
- Repeating an unchanged semantic rewrite yields byte-identical canonical
  content.
- A legacy record receives current-only sections or shape changes only through
  an explicit migration naming source schema, target schema, authority, and
  preserved-content proof. Silent legacy upgrade is forbidden.

### Audit budget and state provenance

A fresh schema-valid substantive Auditor report carries the closed producer
identity `{ roleId: "auditor" }` and the canonical digest of its complete
normalized payload. The audit CLI persists that payload losslessly; its visible
invocation provenance and embedded JSON provenance must agree. In `standard`
mode a distinct, receipt-free Auditor invocation is graded `session_reported`
with `Producer authenticated: false`. In `hardened` mode the exact same report
must carry a verified protected-host receipt and is graded `host_receipt` with
`Producer authenticated: true`. A fresh schema-valid report that meets the
effective policy consumes one audit run and records its cause. An unavailable
invocation, rejected or malformed report, policy-insufficient return, or
report-validation failure returns a typed Auditor-owned resume/redelegation
result and consumes neither audit budget nor recovery allowance; the ordinary
attempt budget still bounds equivalent failures. Explicit `legacy_inline_v1`
reports remain historical compatibility data; they do not establish a fresh
wire-format Auditor return.

One bounded `product_invalidation_recovery` allowance is declared per audit
record, with required `typed_cause`, `invalidation_reference`,
`affected_prior_run`, and `maintainer_recorded_cause`. Its availability is
`declared_not_operational` and enforcement is `unavailable`: current audit
history counts every completed substantive report, and exhausted budgets require
the existing human-approved override. Agents must not claim or attempt a
non-consuming recovery until guarded audit support exists. A second declared
recovery would still require explicit human override. Auditor findings never use
the allowance.

Every observed state is classified as `product_state` (the project artifact),
`workflow_state` (durable task, review, audit, or closeout record),
`host_local_state` (host-created or local runtime state with recorded
provenance), or `unexplained_drift`. Unexplained drift blocks authority-sensitive
mutation until classified. This rule is host-neutral; no host-specific exception
exists.

### Capabilities, liveness, and returns

Canonical role capabilities remain in the role declarations and their owning
skills/backends. The runtime vocabulary covers implementation mutation,
task/workflow mutation, role dispatch, result production/import, blocked-result
resumption/redelegation, human-authorized exceptional recovery, and terminal
closeout. Role identity, role policy, and host enforcement are separate: none
of those capabilities becomes a role identity.

Every shipped host and every canonical role has one closed
`agenticloop.host-role-capability` version 1 declaration. Its action bindings
partition the complete action inventory into `allowed`, `denied`, and
`requires_human_disposition`; missing, duplicate, unknown, contradictory, or
incomplete declarations fail closed. Generated adapters render
`defaultLabel` from the role registry but retain `roleId` in filenames,
configuration, attribution, packet authority, and declaration digests.

A generated packet binds the exact selected host-role declaration and the
canonical set of its advisory/unavailable action reports; it does not copy whole
workflow procedures. Generated role prompts carry only a readable summary,
schema version, declaration digest, and deterministic sidecar path. The full
canonical bytes live once in
`.agenticloop/host-role-capabilities/<host>.json`; generation and validation
recompute the declaration and sidecar digests so prompt or sidecar drift fails
closed. A host reports each requested capability as `enforced`,
`advisory`, or `unavailable`. `enforced` means every shipped host tool path
capable of the action is mechanically constrained. OpenCode `permission.edit:
deny` does not constrain retained `bash`, and Copilot withholding `edit` does
not constrain retained `execute`, so their Orchestrator/Auditor implementation
denials are advisory. Codex remains advisory because generated custom-agent
TOML has no per-agent write restriction. Claude Code `permissionMode: plan` and
Cursor `readonly: true` are the generated whole-agent mechanical restrictions
for Orchestrator/Auditor. Maintainer implementation denial remains advisory on
every host because legitimate workflow mutation must remain reachable.

Advisory or unavailable enforcement emits a closed
`agenticloop.degraded-enforcement-report` version 4 record with diagnostic code
`capability.enforcement.degraded`, the degraded action and capability, and the
declaration digest. The next authoritative boundary, limitation, and
deterministic recovery route are properties of the capability declaration, so
the report pins that declaration by digest instead of restating its text: every
consumer that holds a report also holds the declaration it names, and repeating
those fields once per degraded action only enlarged the dispatch packet. `task
prepare-dispatch` binds the canonical reports into the packet, resolves the
declaration facts from the bound declaration, and emits the repair-policy
warnings unchanged. `task verify-return` / `role_return_receive` runs
canonical packet validation, including report/declaration compatibility, at the
receive edge before accepting the return. There is no second nominal report
check counted as an independent enforcement layer; contradictory or fabricated
reports fail at that canonical boundary. Native
host restriction, authenticated Agentic Loop authority checks, and arbitrary
external writes are separate boundaries. Agentic Loop does not claim it can
prevent external or human writes outside host control.

`lease` remains the accepted external term during migration and is interpreted
as a `delegation_liveness_window`: an observable-step cadence, expiry, and stop
condition that grants no mutation authority. `managed_join` remains the existing
bounded relation with a dedicated task/artifact and exact evidence; an execution
plan is an artifact of that relation, not a new `managed_join_plan` synonym. Use
`cancellation_boundary`, `review_no_mutation_window`, and
`digest_guarded_rollback` precisely. None is a lock or authority transfer.

A blocked role return has kind `agenticloop.role-return`, schema version `4`,
and separately declares required fields plus constant `disposition: blocked`.
Its fields include return ID, producing role, consumed transition ID/digest,
blocker category/evidence, resume owner/transition, and resume preconditions. An exceptional-verification return has kind
`agenticloop.exceptional-verification`, schema version `1`, and includes request
ID, producing role, transition ID, exact failed/unavailable check, evidence,
proposed disposition, disposition authority, and next resumable transition. The
host receipt authenticates the exact request digest. The authenticated producer
and capability-derived disposition owner remain separate; requesting an
exception is non-terminal and cannot accept or complete work. Neither packet
authorizes another role to repair, accept, or reconstruct it.
A normal resume remains owned by the authenticated return's producing `roleId`.
The `task verify-return` / `role_return_receive` import edge runs this check
before any transition, persistence, repair, or host-state change. Changing
owner requires one closed `agenticloop.blocked-result-redelegation` version 2
authority bound to the exact return ID/digest, consumed packet, producer,
target role, issuer, issue/expiry times, and invalidators. Its semantic digest
proves record integrity, not authorization. Authorization requires an Ed25519
signature verified against the exact authority ID, kind, key, issuer, target
repository, and current revocations in the fixed operator trust store's closed
schemaVersion 2 `authorities` inventory. Comments, labels, trailers,
caller-supplied producer strings, self-minted keys, or the identity of the next
editor do not transfer ownership.

The public CLI does not expose a switch that promotes a supported adapter or
authority store. A supported host integration must inject the protected
host-trust boundary into the in-process I/O context after authenticating its own
capture/receipt channel; ordinary CLI calls remain fail closed. The canonical
`scripts/sign-blocked-authority.mjs` helper constructs and signs redelegation
and human-disposition records from JSON requests using the same serializers as
verification. It reads a private key from an operator-controlled path, writes a
new output file only, and never includes private key bytes in records or output.

Destructive, scope-changing, or host-state recovery from a blocked result
requires one closed, operator-pinned, Ed25519-signed
`agenticloop.human-disposition` version 2 record at the same import edge. It
binds the exact blocked return and requested recovery identity/class/scope/host
state, human actor and durable authority reference, reason, issue/expiry times,
resulting owner/transition, and invalidation conditions. Missing, unsigned,
self-minted, malformed, stale, future-dated, revoked, cross-return, or
wrong-recovery records remain blocked. A host without trusted provenance
reports the operation unsupported/degraded and does not continue. Authorized
human work remains attributed to `human_actor` under `human_authority`; it
never fabricates a workflow-role attribution.

Receipt authentication precedes receipt-controlled semantic classification.
Verification performs only closed structural parsing and trusted adapter/key
selection before verifying the signature over canonical bytes. Producer role,
target, packet/return binding, liveness, and other semantic checks run only
after that authentication. A forged producer role therefore produces the
generic authentication failure, while an authentically signed wrong producer
produces `role_return.producer_mismatch`.

Dispatch packet schema version 6 is current. It carries the constant-size
decomposition binding, the complete signed activation grant and task binding,
both assurance dimensions, and an independent nullable return adapter. Packet
versions 2 through 5 remain authentic historical evidence but receive typed
`dispatch.packet.stale` upgrade guidance and are never accepted as current.
The shipped host-receipt baseline was schema version 1; an authentic version 1
receipt receives typed `role_return.receipt_stale` reissue guidance. Malformed
inputs do not become legacy packets or receipts merely by carrying an old
version number.

Request capture is independent from capability enforcement. Before task
authoring, the selected adapter implementation derives
`captureCapability: supported|unsupported` and computes
`integrity: verified|missing|mismatch` from its own receipt fields. A supported
verified parser-normalized payload digest matching the operator expected SHA-256
may proceed. Supported missing is `needs_context`; supported mismatch is
`rejected`; unsupported is `blocked` and never claims original-input proof. A
serialized capture is revalidated for every cross-field relation; unknown fields,
unknown adapter identities, duplicate identities, and contradictory states fail
closed. Model-authored prose, a restated prompt, or a model-created JSON file is
advisory only. No degraded continuation or human acceptance substitute exists for
this boundary.

## Activation Boundary

Full Agentic Loop operation requires explicit activation. Discovering the
installed toolkit or reading this document does not activate the methodology.

Activate the full loop – adopt the roles, create or continue a durable task
record, run backend operations, worktrees, event logging, review, and closeout
– only when at least one of these is true:

- The user explicitly asks to use Agentic Loop.
- The user invokes the host's Agentic Loop activation command, prompt, or skill.
- The user explicitly asks to implement, continue, review, accept, close, audit,
  certify, or re-audit a tracked Agentic Loop work unit.

The following do not activate the methodology: merely discovering `agenticloop/`,
reading this document, mentioning a task ID without operational intent, or asking
for status, orientation, explanation, or discussion. For that ordinary work,
follow the target repository's rules document directly. Reading this document to
answer a question about the methodology is expected and allowed; adopting it as
the current process is not.

**Standalone engineer and auditor delegation is not activation.** The main agent
may invoke the generated engineer as an ordinary bounded subagent for a normal
engineering subtask, and the generated auditor as an ordinary bounded read-only
subagent for a normal assessment. Standalone use of either role requires no
activation, task ID, task record, audit ID, audit record, or audit packet, and
creates no Agentic Loop workflow state. A standalone auditor assessment certifies
nothing: it cannot satisfy work-unit auditing, certification, or closeout, which
require a fresh, packet-bound Agentic Loop Auditor invocation. See the Glossary
entries for **Activation**, **Standalone engineer**, and **Standalone auditor**.

## Deactivation Boundary

`stop` is the host-neutral Agentic Loop deactivation term. It deactivates the
methodology only for the current conversation; it does not exit the host,
terminate unrelated host terminals, close a task, or clean up worktrees. The
canonical stop contract is `agenticloop/commands/stop.md`.

On stop, authorize no new Agentic Loop work or role spawning. Inspect active
delegations, background work, and lanes; safely interrupt Agentic Loop work only
when the host exposes that control, otherwise report it without waiting
indefinitely. Preserve material unfinished progress with a concise dated task
record checkpoint when needed, including the last completed action, current
artifact or branch/worktree, verification already run, and next concrete action.
Leave the durable task status unchanged unless an independent blocker exists; a
voluntary stop is not `blocked` or `needs_context`.

Stop never implies acceptance, closeout, commit, push, merge, branch deletion,
or worktree cleanup. After a stop summary, later user messages do not resume the
methodology automatically: the user must invoke the normal explicit activation
surface again.

## Core Objects

| Object | Meaning |
|---|---|
| Agent role | A host-neutral role definition in `agenticloop/agents/<role>.md`. |
| Skill | A focused procedure in `agenticloop/skills/<name>/SKILL.md`. |
| Decision record | A tracked Markdown record for a durable project decision that constrains future work. |
| Audit record | A tracked Markdown certificate for one work unit under `.agenticloop/audits/`. Holds the exact certified baseline and append-only Auditor report history. Separate from task records and decision records. |
| Task record | The durable record for one unit of work. Stored as a local Markdown file by default; GitHub issues are an optional projection. |
| Task backend | The configured storage projection for task records. Backend docs live in `agenticloop/backends/`. |
| Event log | An optional local JSONL log of explicit workflow-gate events written through the Node CLI when a project enables event logging. |
| Grouping | An optional task bucket such as a phase, milestone, epic, or custom group. |
| Summary | The completion summary for a task, written inline in the task record (the `## Scope Completed` section, or the PR body for GitHub-backed work). There is no separate summaries store; closeout verifies these inline summaries and posts a status marker rather than publishing a new file. |
| Pull request | The reviewable implementation artifact for GitHub-backed work. |

## Glossary

Stable Agentic Loop vocabulary lives in this installed process document so
target projects do not need toolkit-root `docs/` files at runtime.

- **Agentic Loop**: the supervised workflow methodology in this repository.
- **Activation**: the point at which the full methodology becomes the current
  process. Activation is explicit only: the user asks to use Agentic Loop,
  invokes the host activation surface, or asks to implement, continue, review,
  accept, close, audit, certify, or re-audit a tracked work unit. Installation,
  discovery, reading the methodology, or mentioning a task ID for discussion does
  not activate it.
- **Deactivation**: current-conversation termination of Agentic Loop requested
  with the exact `stop` argument. It checkpoints unfinished work safely without
  changing task status solely because the user stopped. Reactivation is explicit.
- **Standalone engineer**: the generated engineer invoked as an ordinary bounded
  subagent without activating Agentic Loop. Standalone delegation takes its scope
  from the parent request and repository rules, requires no task ID or task
  record, and creates no Agentic Loop task records, events, worktrees, review, or
  closeout state. See `agenticloop/agents/engineer.md` for the two engineer modes.
- **Standalone auditor**: the generated auditor invoked as an ordinary bounded
  read-only subagent without activating Agentic Loop. It assesses whatever scope
  the parent request names, requires no task ID, audit ID, audit record, audit
  packet, work unit, covered-task set, or frozen candidate, and creates no
  Agentic Loop workflow state. It is explicitly non-certifying: it issues no
  Agentic Loop audit verdict and never satisfies work-unit auditing,
  certification, or closeout. See `agenticloop/agents/auditor.md` for the two
  auditor modes.
- **Agent role**: a host-neutral role definition installed under
  `agenticloop/agents/<role>.md`.
- **Skill**: a focused procedure installed under
  `agenticloop/skills/<name>/SKILL.md`.
- **Workflow**: a sequence of skills and gates used to complete a kind of work.
- **Task record**: the durable record for one unit of work. Local Markdown task
  files are the default; GitHub issues are an optional projection.
- **Task backend**: the configured storage projection for task records.
- **Backend projection**: a backend-specific mapping from shared task-record
  operations to storage commands or file edits.
- **Task ID**: the durable identifier used in task records, branches, pull
  requests, and commit trailers. Default example: `T-001`.
- **Grouping**: an optional task bucket such as a phase, milestone, epic, or
  custom group.
- **Phase**: one possible grouping profile.
- **Orchestrator**: the coordination role that drives the task lifecycle and
  delegates work.
- **Maintainer**: the planning and review role that writes task records,
  reviews implementation artifacts, triages follow-ups, and owns closeout.
- **Engineer**: the scoped implementation role that changes files, runs checks,
  and publishes evidence.
- **Auditor**: the read-only assurance role. In Agentic Loop certification mode
  it evaluates a completed work unit as a whole and certifies or rejects the
  exact integrated baseline; that certification has its own model slot and
  requires a fresh, packet-bound invocation every time, bound to the exact frozen
  candidate and covered-task set. Delegated standalone it performs an ordinary
  bounded non-certifying assessment instead (see **Standalone auditor**). In both
  modes it implements nothing, accepts no task, and accepts no limitation or
  risk.
- **Work unit**: the certification boundary for an audit. In grouped projects it
  reuses the configured grouping (`phase:4`, `milestone:M2`, `epic:payments`,
  `custom:<id>`); flat projects name it explicitly as `work-unit:<name>` with an
  explicit covered-task list.
- **Audit record**: the durable work-unit certificate under
  `.agenticloop/audits/<AUD-ID>.md`. It holds the covered-task boundary, the
  candidate and certified artifacts, the latest Auditor verdict, and append-only
  report history. It is not a task record and not a task summary.
- **Candidate artifact**: the exact frozen integrated artifact submitted for
  audit. **Certified artifact** is the artifact an effective certification
  covers; certification is current only while the two are equal and the
  covered-task sets match.
- **Audit verdict**: one of `certified`, `certified_with_accepted_limitations`,
  `needs_remediation`, or `needs_human_decision`. The last of these moves the
  record to `audit_state: awaiting_human` until a separate human resolution is
  recorded. Budget exhaustion is a workflow stop, never a manufactured verdict.
- **Audit budget**: the separate default-3 bound on completed substantive Auditor
  reports for one work unit, independent of `attempt_budget` and `review_budget`.
- **Required checks**: exact commands or manual checks that must be run before a
  task can be accepted.
- **Verification operating fact**: a current, maintainer-owned execution fact in
  `.agenticloop/project.md` about a project-wide check, identified as `VF-...`.
  It records observed behavior and a current strategy; it is not by itself a
  policy decision.
- **Project Operating Fact**: a current, mutable, maintainer-owned, source-linked,
  non-binding, project-wide operating fact in `.agenticloop/project.md`,
  identified as `PF-...`. It records reusable project operating reality; it is
  not a decision and does not by itself constrain future work. See the Project
  Operating Facts section for the full definition.
- **Proof pressure**: the optional task-record practice of naming a completion
  oracle, final proof required, and likely misfire to keep work aligned with the
  owner's outcome. Proof pressure complements acceptance criteria; it does not
  replace them.
- **Maintainer Review Fixup**: a bounded Lens 2 or Lens 3 review exception in which the
  maintainer applies one fully understood quality correction to the artifact
  under review, refreshes final-state evidence, re-reviews, and accepts without
  an engineer revision handoff. Eligibility, procedure, and provenance are owned
  by [[review-and-accept]]. A successful fixup is part of the current review
  round, not a `needs_revision` round; independent-review tasks are ineligible.
- **Needs context**: a task state used when the task record is ambiguous or
  incomplete and can be corrected by the maintainer.
- **Blocked task**: a durable paused state requiring human action or external
  change.
- **Change request**: a task that changes a locked architecture, process, or
  repository decision and must pass an approval gate before implementation.
- **Mutation independence**: the parallel-eligibility dimension in which lanes
  do not collide in writable files, test and validation surfaces, backend
  objects, generated state, schemas, APIs, external state, or other durable
  state.
- **Knowledge independence**: the parallel-eligibility dimension in which no
  likely discovery in one lane can invalidate another lane's assumptions, plan,
  implementation, or verification interpretation. Classified per task as
  `independent`, `coupled`, or `unknown`; parallel write execution requires
   both mutation and knowledge independence.
- **Development stage**: the human-confirmed project posture in
  `.agenticloop/project.md`: `greenfield`, `expansion`, `stabilization`, or
  `maintenance`. It guides task shaping and coherence review but never overrides
  safety, authorization, evidence, review, or accepted-decision rules.
- **Cross-lane finding**: a fact or invariant discovered in one parallel lane
  that is relevant to another lane, declared at a lease checkpoint or final
  return, routed by the orchestrator, and answered by the recipient with one
  disposition (`applied`, `already satisfied`, `rejected`, or `deferred`).
- **Verification topology**: the classification of a planned check as
  `baseline`, `lane-final`, `integrated`, or `post-merge`, together with the
  evidence-identity rule that a check result binds to the exact artifact tree
  or immutable revision, exact command, and relevant environment state it ran
  against.
- **Integration rehearsal**: a serial, engineer-owned, non-publishing
  combined-state proof step that runs planned checks against a disposable
  candidate composed from the verified base plus lane artifacts in the intended
  order. It is not a merge and grants no merge, push, publish, or acceptance
  authority.
- **Managed join**: the `parallel-delegation` skill's bounded exception for a
  Maintainer-classified pair of exact additive shared mutations. It has a
  dedicated join task/artifact, exact artifact-bound integrated evidence, and a
  fresh three-lens review; it never authorizes merge or semantic conflict choice.
- **Decision record**: a tracked Markdown record for a durable project decision
  that constrains future work. It is separate from task records.
- **Summary**: the completion summary for a task, recorded inline in the task
  record using `agenticloop/memory/work-unit-summary.md` (`summary_unit: task`).
  There is no separate summaries store; closeout verifies the inline summaries
  and posts a status marker.
- **Project skill**: a target-project, host-visible skill used for
  domain-specific procedures.
- **Host adapter**: documentation or tooling that lets a host use the same
  canonical roles, skills, and backend projections.
- **Local files backend**: supported default backend that stores task records
  under `.agenticloop/tasks/`.
- **GitHub backend**: optional backend that stores task records as GitHub issues
  and implementation artifacts as pull requests.
- **Toolkit-owned source**: canonical Agentic Loop package assets installed
  under `agenticloop/` in target repos.
- **Target-owned state**: durable project records under `.agenticloop/`.

## Directory Layout

An installed target repo has **two sibling directories that differ only by a
leading dot**. Conflating them is the most common path mistake – read the dot
before constructing any path.

| Path | Leading dot | Owner | Read/write | Holds |
| --- | --- | --- | --- | --- |
| `agenticloop/` | no | toolkit | read-only | `AGENTIC_LOOP.md`, `agents/`, `skills/`, `backends/`, `commands/`, `memory/`, `config.json` |
| `.agenticloop/` | yes | target project | read/write | `project.md`, `tasks/`, `decisions/`, `audits/`, `improvements/` (created on first proposal), `logs/`, `tmp/` |

The process doc is `agenticloop/AGENTIC_LOOP.md` (no dot) and the role files are
`agenticloop/agents/<role>.md` (no dot). Project state such as
`.agenticloop/project.md` and `.agenticloop/tasks/` is under the dotted
directory. Reading `.agenticloop/project.md` does not mean the process doc or
agents live beside it – those are under `agenticloop/`. When in doubt, list the
repository root and confirm which directory exists before guessing a sibling.

## Roles

Agentic Loop uses four logical roles. A host may implement these as agents,
modes, prompts, commands, or explicit human instructions.

The canonical role definitions live in `agenticloop/agents/`:

- `agenticloop/agents/orchestrator.md`
- `agenticloop/agents/maintainer.md`
- `agenticloop/agents/engineer.md`
- `agenticloop/agents/auditor.md`

| Role | Owns | Cannot |
|---|---|---|
| Orchestrator | Lifecycle coordination and delegation | Implement, review, accept |
| Maintainer | Task records, review, acceptance, closeout | Implement outside one bounded review fixup |
| Engineer | Scoped implementation and evidence | Accept its own work |
| Auditor | Work-unit certification | Implement, accept tasks, expand scope, accept risk |

Auditor is a separate role rather than a maintainer mode because it needs its own
model slot, a fresh invocation identity, non-substitutability with the authority
that accepted the work, and a distinct read-only boundary. See the Work-Unit
Audit section below.

Host adapters should bind to those role files rather than defining separate
role contracts.

## Source Documents

At the start of a non-trivial task, read `.agenticloop/project.md` for
`development_stage`, `default_attempt_budget`, `default_review_budget`, `default_audit_budget`,
`max_parallel_implementation_lanes`, `task_backend`, task naming, optional
grouping settings, typed document selections, and relevant current verification
operating facts and Project Operating Facts.

Document roles are:

- `rules`
- `plan`
- `overview`
- `process`
- `spec`
- `design`
- `context`
- `history`

If a role is selected in `.agenticloop/project.md`, use that path. If it is not
selected, use the bounded candidate names from the canonical document-role
registry in `agenticloop/config.json`. Do not scan the whole repository at
runtime.

The `context` document role is for target-owned domain context, product
vocabulary, or task-start context. It is not required for Agentic Loop's own
glossary.

## Development Stage

`development_stage` is a required, human-controlled behavioral prior. Confirmed
setup requires exactly one of `greenfield`, `expansion`, `stabilization`, or
`maintenance`; a fresh unconfirmed scaffold may use `unconfirmed`. Missing,
unconfirmed, or unknown stage on confirmed setup is a setup blocker. Route an
existing confirmed project missing a stage through the one-time interactive
profile migration. Agents may propose a transition with bounded evidence, but
must not persist or apply one; later transitions require another explicit human
confirmation through the profile-update path.

Stage is subordinate to, in order: safety, authorization, verification, and
independent-review invariants; explicit human instructions, repository rules,
accepted decisions, and the current task contract; then the stage; then generic
Agentic Loop heuristics. It never weakens task scope, TDD, debugging, required
checks, evidence, security, accessibility, validation, review provenance,
independent review, decision governance, or the change-request gate. Stage and
Ponytail minimalism are independent dimensions.

- `greenfield`: establish a coherent foundation; allow bounded internal core
  reshaping and reject hypothetical compatibility layers or extension points.
- `expansion`: grow capability without fragmentation; extend or correct shared
  core mechanisms instead of creating parallel ones.
- `stabilization`: converge behavior, retire temporary paths, reduce duplication,
  tighten interfaces, and avoid gratuitous churn.
- `maintenance`: preserve documented compatibility and operational safety through
  bounded root-cause fixes, explicit migrations, and minimal blast radius.

Maintainers use the stage to shape task boundaries, expected core areas, and
compatibility posture. Engineers use it only within authorized scope and return
`needs_context` when the coherent solution needs a material out-of-scope core or
contract change. Reviewers use it in Lens 3, never to waive Lens 1 evidence.

## Context Read Discipline

Agents work from a closed normative context set, extend it only through bounded
task-scoped implementation discovery, and never load arbitrary repository
material. This section is the canonical owner of that cross-cutting rule; role
and skill files reference it rather than restating it.

### Normative context (closed)

The normative context set is:

- repository rules and the project map (`.agenticloop/project.md`) for backend, naming, grouping, and selected source documents,
- the current task record,
- the selected source documents listed in `.agenticloop/project.md` or the task record,
- decision records explicitly linked from those sources,
- the backend projection doc in `agenticloop/backends/` that matches `task_backend`.

This set is closed. Do not add a document to it unless the task record, project
map, or a human explicitly names that file.

### Bounded implementation discovery (permitted by default)

Implementation and review still need to see how code fits together. The
following task-scoped discovery is permitted by default, without a new
authorization, when it stays tied to the current task:

- available repository indexing or language-aware symbol, reference, and
  caller/callee lookup,
- exact identifier or known-path search,
- focused test discovery for the code under change,
- relevant version-control history for the touched files,
- directly connected schemas, generated consumers, configuration, callers, or
  tests reached from the above.

A previously unnamed caller or test found this way may be inspected and, when
necessary to satisfy the existing task scope, changed with a recorded deviation.

Default operational bound for one task:

- one bounded discovery pass,
- at most six previously unnamed paths or symbol bodies opened from discovery,
- symbol-level or relevant-range inspection before loading a whole file.

Normal reads already named by the task record or project map do not count
against this bound.

### Arbitrary context loading (prohibited)

These remain prohibited:

- broad repository dumps or scanning the whole tree at runtime to "find relevant files",
- indiscriminate full-file loading when a symbol or range is enough,
- unrelated documentation or logs,
- repeated exploratory scans without progress.

Do not treat `.agenticloop/logs/` as ambient context; read logs only through
explicit event-log audit or report commands, or when a task-scoped need is
stated in the task record or by the human. Do not treat `.agenticloop/tmp/` as
source context; it is scratch space only.

### Recording and escalation

Use the existing implementation-summary `## Deviations` section to record
discovery when it changes expected files or areas, exposes an unexpected
dependency, requires an implementation-plan deviation, or materially affects
review scope. Do not add a new mandatory task section for discovery.

Return `needs_context` when discovery exceeds the default bound, crosses into a
materially new product or architecture domain, contradicts task scope,
out-of-scope rules, or an accepted decision, or shows that completing the task
requires a broader contract. A directly connected discovered caller or test does
not by itself require `needs_context`; a material scope expansion still uses the
existing contract-change path.

## First-Run Bootstrap

At the start of the first non-trivial Agentic Loop task, read
`.agenticloop/project.md` before creating or selecting the first task.

If `setup_status` is `unconfirmed`, or confirmed setup has no valid
human-confirmed `development_stage`, route interactive setup or profile
confirmation before continuing. Confirmation may either record typed selections
or explicitly accept the default document, task naming, grouping, backend, and
development-stage conventions.

If no legal writer or delegation path is available for that confirmation, use
`blocked-state` with category `contract` and stop.

Do not repeatedly rescan or re-report the same setup gap once it has been
recorded.

## Advance Authorization Boundary

This boundary applies to every role, not only the orchestrator.

### Authorized Work Units

Authorization attaches to a bounded work unit, not to each workflow step. A work
unit may be one task, a task set, a phase/group, or another explicitly scoped
piece of work. Its scope is whatever the human named; if scope is ambiguous,
clarify before expanding (that is a checkpoint, not a license to continue).
Authorizing a phase, group, milestone, epic, or task set does not collapse that
unit into one task record. Before implementation starts, decompose it into
right-sized implementation task records unless the maintainer can show that the
whole unit is one independently verifiable task.

Right-sized means one independently verifiable task at a time by default, the
smallest useful implementation slice. When a human authorizes a larger bounded
run, prefer the largest safe useful slice that remains bounded, reversible, and
independently verifiable as one task. A phase, group, milestone, epic, or task
set authorization is not permission to create one oversized task record; task
sets still decompose into ordinary task records using the configured backend
and task ID convention.

Right-sized also accounts for active-context headroom. A task that is one
deliverable but likely cannot fit inside one engineer execution with safety
headroom is still too large; split it or tighten the expected files, checks, and
discovery bounds before implementation.

A work unit may authorize a whole task set, but materializing durable task
records for that set is incremental. Decomposition can be one planning pass;
full task records should be written in bounded chunks of one record by default,
or at most three simple records per batch, and checkpointed so an interruption
resumes from the first missing or invalid task.

When a human authorizes a work unit to run, continue, or finish, Agentic Loop
performs the routine lifecycle steps that unit needs under the configured
backend – selecting included tasks, creating or updating task records,
delegating roles, implementing, recording evidence, updating implementation
artifacts, reviewing, revising, accepting, closing tasks, and running configured
closeout – without a per-step approval prompt. These steps are routine inside
an authorized unit; only the hard checkpoints below interrupt them.

The loop continues until the unit reaches acceptance (plus configured closeout)
or hits a hard checkpoint. It stops short only when blocked – see Attempt
Budget and [[blocked-state]].

### Serial Default And Parallel Exceptions

Agentic Loop is serial by default. One orchestrator should have one active
delegated role step for a task, and one mutable implementation artifact in one
worktree at a time. Do not launch parallel maintainer or engineer sessions just
because the host supports multiple subagents.

Concurrency safety is governed by mutation, not by role. A maintainer lane that
updates task records, GitHub issues, review comments, labels, or event logs can
collide with another lane just as easily as two engineer lanes if they share a
checkout, task record, GitHub issue/PR/comment stream, label set, event log,
branch, generated file, lockfile, schema, API surface, or other durable state.

Serial-by-default is a safety floor, not a preference for serial execution. When
a human authorizes a bounded multi-task unit, the orchestrator must actively look
for safe bounded parallelism before defaulting to serial. The default is not
"serial unless forced parallel"; it is "scan first, then choose."

#### Parallel Delegation Summary

Serial is the safety floor, but it is not a reason to skip analysis. Every
authorized multi-task work unit receives a current Parallel Opportunity Scan
after decomposition.

Read inventory completeness before ready count, always in this order:

1. inventory or decomposition incomplete -> `incomplete`; repair the evidence
   and rescan. This is never reported as an eligibility answer.
2. complete inventory, zero ready tasks -> `no_eligible_work`.
3. complete inventory, one ready task or no valid candidate pair ->
   `not_currently_eligible`, with the exact ready count and a rescan trigger.
4. only a complete, fresh, fully accounted inventory can produce
   `parallel_candidates`.

With two or more ready tasks over a complete inventory, the orchestrator loads
[[parallel-delegation]] and completes the full scan before choosing serial
execution.

A bounded parallel batch is preferred when 2 or more ready tasks are independent
on both eligibility dimensions and collision criteria are known and disjoint.
`max_parallel_implementation_lanes` defaults to `5` and is a ceiling only for
implementation lanes, never a total live-agent budget or an eligibility grant.
The effective lane count is the minimum of the configured maximum, ready
mutation-independent and knowledge-independent tasks, and host-supported bounded
lanes. Review, coordination, and integration lanes use their separate ownership
rules and do not inherit this value.

Every parallel write lane needs its own owned backend objects, broad allowed
scope/deviation map, structured expected-write ownership, implementation or
workflow artifact, lease, and join condition. `allowed_paths` overlap is not a
mutation verdict: `owned_paths` and exact `shared_mutations` drive it. Every
write lane that mutates repository files also needs its own repo-internal
worktree and branch. Unknown collision criteria never start write lanes; run one
bounded read-only discovery pass when parallel work is otherwise plausible, then
record either a parallel plan or a concrete serial reason.

The concurrency plan must name lane id/type, role, read/write mode, owned backend
objects, worktree path and branch for file-mutating lanes, artifact,
allowed files/areas, collision risks, knowledge-coupling classification,
liveness cadence, stop condition, and join condition. Backend-specific write
rules, join behavior, and delegation liveness requirements live in
[[parallel-delegation]]. It also records decision scope and shared design
questions. A shared question is resolved by the maintainer or a serial
reconciliation step before parallel implementation writes, or by the two-wave
read-only diagnosis and reconciliation pattern; disjoint files alone do not
grant independent design authority.

**Mutation independence and knowledge independence.** Parallel write execution
requires both. Mutation independence means lanes do not collide in writable
files, test and validation surfaces, backend objects, generated state, schemas,
APIs, external state, or other durable state. Knowledge independence means no
likely discovery in one lane can invalidate another lane's assumptions, plan,
implementation, or verification interpretation. Each task records a knowledge
classification of `independent`, `coupled`, or `unknown`: `independent` lanes may
run in parallel when every mutation and host-safety rule also passes; `coupled`
work uses the two-wave pattern (bounded parallel read-only diagnosis, findings
reconciliation at the join, then serial implementation or a newly justified
parallel plan); `unknown` uses the existing one-bounded-discovery-pass rule and
falls back to serial when uncertainty remains. Separate worktrees isolate
mutation; they never convert coupled or unknown tasks into independent tasks.

**Cross-lane findings.** At each lease checkpoint and final lane return, every
lane declares cross-lane findings or explicitly returns `Cross-lane findings:
none`. A finding names a fact or invariant, its evidence, the affected lanes (or
`none`), and a requested response (`apply` or `revalidate`). The orchestrator
routes a relevant finding to each affected lane, and the recipient must record
one disposition – `applied`, `already satisfied`, `rejected` with evidence, or
`deferred` with a reason. A batch join is incomplete while any routed finding
lacks a disposition. A deferred finding remains join-blocking until
Maintainer disposition records that it cannot invalidate current scope,
correctness, safety, acceptance, or integrated evidence and classifies it as an
accepted limitation or follow-up. Findings live in lane status returns and the
concurrency plan or coordination output; there is no shared findings ledger.

**Verification topology.** Parallel check plans classify each check as
`baseline` (once against the verified shared base), `lane-final` (fresh against
one exact lane head after its final relevant edit), `integrated` (against the
composed candidate tree at join), or `post-merge` (against the actual merged
tree). Evidence identity is the exact artifact tree or immutable revision plus
the exact command plus relevant dependency/toolchain/environment state – the
same command on different branch heads is different evidence. A verified
baseline may be referenced across lanes only under strict artifact and
environment identity and only to establish baseline state; it never satisfies a
lane-final, integrated, review, acceptance, or post-merge final-state claim.

**Managed join.** A pair may be `disjoint`, `managed_join`, `blocked`, or
`unknown` while each task remains `eligible`, `blocked`, or `unknown`. Only the
Maintainer classifies exact additive shared operations; Orchestrator verifies
inputs, host/liveness/join facts, records the decision, and routes results. A
managed join requires dependency and knowledge independence, an exact operation
plan, dedicated join task, exact lane artifacts, integrated checks, and fresh
full review of the exact final artifact. Artifact, operation, order, promotion,
or landed-tree changes make classification, evidence, and review stale. Full
procedure, bounded Engineer reconciliation, and escalation live in
[[parallel-delegation]].

**Integration rehearsal.** When knowledge coupling, adjacent behavior, shared
invariants, or ordering/composition risk makes individually green lane evidence
insufficient, the plan authorizes a risk-triggered integration rehearsal: a
serial, engineer-owned step that composes a disposable non-published candidate
from the verified base plus the lane artifacts in the intended order and runs
the affected checks against it. The rehearsal never updates the protected
default or integration branch, never pushes, publishes, merges, or accepts work,
and never bypasses the human merge checkpoint. It returns a conflict/ordering
result for owning task branches to revise rather than silently resolving
semantic conflicts. If the eventual real merged tree differs from the rehearsed
candidate, integrated evidence is stale and the required checks rerun.
Demonstrably disjoint batches may omit the rehearsal with a recorded reason.
Rehearsal details live in [[parallel-delegation]].

**Worktree placement.** Create each lane worktree with `npx agenticloop worktree
add <task-id> <branch> [--from <ref>]`. The command creates the worktree at
`.agenticloop/worktrees/<task-id>`, adds the worktree parent to the repository's
local Git exclude file, and installs worktree-scoped non-interactive Git config.
Do not create ordinary lane worktrees with raw `git worktree add`, and do not
create them as `../sibling` directories outside the root. A worktree outside the
repository root falls outside the host's workspace sandbox and triggers an
external-directory access prompt that stalls autonomous runs. If a target's
recursive tooling (test runners, linters, bundlers) forces a human-approved
external worktree exception, record the exception before delegation and
immediately run `npx agenticloop worktree guard --fix <path>` on that worktree.

**Worktree lifecycle.** After a task is accepted and its implementation artifact
is integrated, the lane worktree can be removed. Use `npx agenticloop worktree
cleanup --dry-run` to preview which standard `.agenticloop/worktrees/*` lanes are
safe to remove, then `npx agenticloop worktree cleanup --yes` to remove them.
Cleanup is destructive filesystem cleanup and requires the dry-run/yes
confirmation pattern. In dry-run JSON output, `wouldRemove` lists the planned
removals; no worktrees are deleted. It keeps open pull requests, locked worktrees, worktrees
with blocking dirty source or shared `.agenticloop` state, external or detached
worktrees, and lanes with active task state. Task-specific lane-local
`.agenticloop` state is flat only (`logs`, `tasks`, `summaries` (legacy;
preserved for migration only – current projects do not create a summaries
directory), and `decisions` files directly under `.agenticloop/<dir>/`); it is
preserved before removal and does not by itself block cleanup. Nested or shared `.agenticloop` files are not
lane-local and dirty shared state blocks cleanup. Git worktree removal may be
forced internally only after preservation succeeds. For `.jsonl` lane-local
files, preservation is safe when the root file already contains every lane line
(a root superset), using a line-multiset check so repeated lines are not
collapsed. If lane-local preservation conflicts with existing root state, use
`npx agenticloop worktree resolve-state <task-id|path> --strategy
<prefer-root|prefer-worktree|union-jsonl> --yes` (default `--dry-run`) to
resolve before cleanup: `prefer-root` copies the root file into the lane,
`prefer-worktree` copies the lane file into the root, and `union-jsonl` computes
a root-first max-count multiset union of both files and writes the result to
both. `union-jsonl` is the recommended lossless strategy for JSONL log conflicts.
resolve-state never removes worktrees or branches. Shared `.agenticloop` files are not preserved. Project-root bare
coordinator repos (a `.git` directory inside the project root) are supported for
list, guard, add, and cleanup. Branch deletion is not part of v1 cleanup.
External or detached worktrees require explicit review; use `npx agenticloop
worktree remove <task-id|path> --yes` for single-worktree removal with lane-local
state preservation. `npx agenticloop worktree prune --dry-run` inspects stale Git
worktree registrations without touching real checkouts.

**Non-interactive Git.** Agentic Loop runs must not depend on a human closing a
Git editor, pager, or credential prompt. The host session or delegated lane
environment should set `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`,
`GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `GH_EDITOR=true`, `GH_PAGER=cat`, and
`GH_PROMPT_DISABLED=1` before running Git or `gh`. `npx agenticloop worktree add`
enforces the Git config guard for delegated worktrees; use `npx agenticloop
worktree guard --fix --all` to repair existing Agentic Loop worktrees and
`npx agenticloop doctor` to report drift. The coordinator/main checkout is not
repaired by worktree guard so the user's interactive editor remains intact; it
must be protected by the session environment before coordinator Git or `gh`
commands run. Agents must use file-backed or
explicit-message forms such as `git commit -m` or `git commit -F`, `git merge
--no-edit`, `git --no-pager ...`, `gh pr create --title ... --body-file ...`, and
`git -c core.editor=true -c sequence.editor=true rebase --continue` when
continuing a resolved rebase. Do not run `git rebase -i`, bare `git commit`,
`git tag -a`, `git config --edit`, `gh pr create --editor`, or any other
editor-backed command in unattended lane work. If Git or `gh` is already waiting
on an editor or prompt, close/abort the operation and return status instead of
leaving the lane blocked.

`credential.interactive=false` is written for Git versions that support it. The
session-level `GIT_TERMINAL_PROMPT=0` guard remains required for older Git
versions and for coordinator/main-checkout credential prompts.

Parallel write-lane collision rules, backend-specific write rules, join behavior, and
delegation liveness details live in [[parallel-delegation]]. Load that skill
before planning or reviewing parallel lanes or joins.

Stop for human direction before:

- leaving the authorized work unit – including starting any task, group, or
  phase outside it,
- merge, release, irreversible external publication, or destructive cleanup
  (including deleting branches),
- changing a locked process, architecture, backend, or product decision, or
  invoking a backend exception.

Standing authorization must be identifiable from one of these sources:

- the latest human message
- an active human instruction in the current session
- a durable task record, project map, or repository rule that explicitly grants
  the role permission to advance

If the authorization source cannot be named, treat it as absent.

Absent that authorization, treat the request as answer-and-stop: do only the
work needed to respond, report the result with evidence, state any uncertainty,
and stop. Requests that ask for information or a limited action – checking
status, listing artifacts, inspecting history, explaining behavior, diagnosing a
failure, comparing options, or answering a question – carry their own natural
stop condition and do not by themselves authorize any action above.

Discovering a possible next action is not authorization to take it. Report it as
a possible next action and let the human, or a standing authorization, decide.

## Command Output Discipline

A zero exit status is success. Empty output from a successful list, search, or
status command means "no matching results" unless the command documentation or
surrounding evidence says otherwise. Retry only when there is a concrete error,
an ambiguous exit state, or contradictory evidence. Do not repeat an equivalent
command just because the result is empty.

## Attempt Budget

Repeating an action that makes no progress is the most common loop failure.
Bound it with a shared attempt budget.

The precedence is task `attempt_budget`, then project `default_attempt_budget`,
then built-in `5`. New task records materialize their effective value; existing
records retain their stored budget, including historical values. A missing legacy
task field resolves the project default and then built-in `5` without rewriting
the record.
An attempt counts against the budget when it is equivalent to a previous one –
the same command, check, fix, delegation, or report against the same target –
and yields no new evidence or change in task state. A restated intended next
action that is not performed also counts as an attempt: deliberation that never
becomes an action is the same loop as a repeated action that never changes
state.

Progress is what resets the count: an observable new fact, a durable state
change, a backend update, an artifact change, a status return, or a blocker
record. Pure reasoning, restating intent, or re-verifying the same known fact is
not progress. A `blocked`, `needs_context`, or `complete` status return is
progress, because it changes loop state even when no artifact changed.

When the budget is exhausted, stop repeating. Record `needs_context` if the task
record can be amended, or `blocked` if a human decision is required, and report
what was tried. Do not spend the next turn on the same equivalent attempt.

This default of 5 governs repeated fix attempts in [[debugging-before-fixes]]
and a sustained-and-disputed review item in [[review-and-accept]]. Some guards
are deliberately tighter than the default: the empty-result command rule above,
the recorded-setup-gap rule, and the "maintainer is needed" stop in the
orchestrator do not get repeated attempts at all. The self-loop guard is also
tighter – if a role states the same intended next action twice without
performing it, it stops deliberating on the second restatement and either
performs the action or records `blocked` category `no-progress`.

After producing an artifact that satisfies the current evidence, do not re-decide
or re-verify it unless new contradictory evidence appears. Take the next external
action or return status.

## Work-Unit Audit

Task review proves each task was done correctly. Work-unit audit answers a
question no task review asks: does the *combined* result achieve the work unit's
intended outcome as a complete, coherent, sufficiently verified system?

Work-unit audit is **enabled by default**, including when
`.agenticloop/project.md` omits the key. Only an explicit human-controlled
`work_unit_audit: disabled` bypasses the closeout certification gate, and opting
out never certifies anything. The full procedure - preconditions, audit packet,
six perspectives, findings, verdicts, remediation routing, re-audit, budget, and
the closeout gate - is owned by [[work-unit-audit]].

```text
covered tasks accepted
-> perform any required conditional source-plan synchronization
-> integrate or freeze the exact resulting candidate artifact
-> invoke a fresh Auditor
-> Auditor returns one consolidated report
-> certified?
   yes -> closeout may complete
   no  -> Maintainer dispositions each blocking finding
          -> Engineer implements remediation tasks
          -> Maintainer reviews and accepts them
          -> remediation is integrated; baseline and evidence refresh
          -> invoke a fresh Auditor
```

The Auditor evaluates six perspectives in one execution - outcome, completeness,
integration and coherence, engineering quality, verification, and risk - and
returns one report. These are perspectives inside one audit, not separate roles,
models, events, votes, or budgets. Multi-model auditing, panels, voting, and
synthesis are deliberately deferred.

The Auditor is read-only with respect to implementation, tests, configuration,
product documentation, commits, branches, pull requests, task acceptance, product
decisions, and risk acceptance. It may inspect the repository, the frozen
candidate, task records, decisions, and evidence, and run bounded non-publishing
verification. Where a host supports path or operation restrictions, that posture
is enforced mechanically as well as by prompt.

The Auditor returns a structured report and never edits files. The orchestrator
or `npx agenticloop audit report ...` persists it into the audit record without
altering the substantive findings. Persistence validates the input and the
fully rendered record before writing; malformed finding fields, stale baselines,
or structurally invalid packets are rejected.

A fresh report resolves Auditor-return assurance under the same effective policy
minimum as other role returns. In `standard` mode, an honestly receipt-free
return from a fresh, separate Auditor invocation is accepted as
`session_reported`; the audit record states `Producer authenticated: false`, and
no output may describe the Auditor identity as host-authenticated. The exact work
unit, candidate, covered tasks, invocation reference and mode, normalized report
digest, and freshly revalidated repository state remain bound to the run.

In `hardened` mode, the shipped production Auditor-return verifier remains
required through the protected host I/O seam. Its closed schema-version-1
Ed25519 receipt binds immutable producer `auditor`, the pinned adapter/key,
canonical target repository, invocation reference and mode, work unit, exact
candidate, canonical covered-task inventory, substantive report digest, receipt
identity, and issue/expiry instants. Closed shape and signature validation
precede semantic and freshness checks. A supported host wrapper imports the
packaged verifier, answers its fresh exact-context loader challenge with the
pinned adapter's Ed25519 key over a host-controlled IPC or protected OS-handle
boundary, and injects that verifier. A boolean callback, environment assertion,
opaque receipt, replayed challenge response, or Orchestrator reconstruction
grants no authority.

Both grades are persisted in audit schema version 3 and carried through the
audit gate, closeout packet, and final closeout marker. Closeout enforces the
current effective minimum: a later hardened policy therefore refuses an earlier
`session_reported` certification until a fresh protected Auditor return is
recorded. `single_agent_fallback` remains invalid in both modes. Standard mode
can require and record a distinct invocation reference, but it cannot
cryptographically prove the producing identity; that limitation is explicit.

A `needs_human_decision` report moves the record to
`audit_state: awaiting_human`. Another Auditor report is inadmissible until a
human records direction with:

```text
npx agenticloop audit resolve <AUD-ID> \
  --authority "human: <identity>" --note "<decision and direction>"
```

Resolution does not certify the work unit; it permits the next fresh Auditor
invocation. Closeout enforces the complete certificate with
`npx agenticloop audit gate <work-unit-or-audit-id>`. `audit status` is
diagnostic and does not replace that closeout gate.

Existing Engineer-owned integration rehearsal remains the pre-integration
composition proof. Audit runs after the exact candidate is integrated or frozen.
When the selected plan explicitly requires a permitted progress update, the
Maintainer performs it through [[task-closeout]] before that final freeze; a plan
edit after certification makes the certificate stale until baseline and audit are
refreshed.

Remediation uses ordinary Maintainer, Engineer, review, evidence, and
change-request rules. Remediation tasks carry their own `attempt_budget` and
`review_budget` and reference the audit ID and finding IDs.

### Audit Budget

`audit_budget` defaults to `3` unless a new audit record materializes an explicit
`--budget` or project `default_audit_budget` value. It is separate from the
default-5 `attempt_budget` and the default-5 Review Round Checkpoint threshold.

The budget counts completed substantive reports, derived from the audit record's
append-only history. An invocation that failed without producing a report does
not consume it; rejected or malformed reports and report-validation failures
also do not consume it. Repeated equivalent failures stay bounded by the Attempt
Budget above. Remediation work does not consume it, and replacing the baseline or
the audit record does not reset it. The shared transition contract declares one
bounded `product_invalidation_recovery` allowance per audit record, but marks it
`declared_not_operational`: current executable behavior counts every completed
substantive report. Agents cannot use a non-consuming recovery until guarded
audit support exists; an exhausted budget requires the existing human override.

After three non-certifying reports the audit record moves to
`audit_state: blocked` with reason `audit_budget_exhausted` while preserving the
third Auditor's actual verdict. If that actual verdict is
`needs_human_decision`, `audit_state: awaiting_human` takes precedence until the
human direction is recorded; resolution then exposes the still-exhausted budget
as the ordinary `audit_budget_exhausted` block. Budget exhaustion is a workflow
stop, not a verdict: never manufacture `needs_human_decision` because the budget
ran out. A fourth report requires every applicable human-decision resolution and
a recorded human-approved budget override.

### Supervised execution compatibility

Work-unit audit does not depend on supervised execution being enabled or
available. Where a supervisor exists, the Auditor is another observable and
recoverable role session: a supervisor may recover or replace a failed Auditor
session operationally, but it cannot issue or alter a verdict, a replacement that
produced no report does not consume `audit_budget`, and supervisor,
session-replacement, and wakeup budgets stay separate from it. Fresh-invocation
and exact-baseline requirements are unchanged.

## Review Round Checkpoint

The attempt budget counts equivalent attempts and resets on new evidence, so a
task that fails review repeatedly with a different finding each round never
trips it. Bound that churn separately.

After 5 valid `needs_revision` rounds on one task – or after the task record's
materialized positive-integer `review_budget` – the orchestrator pauses before
routing the next revision and asks Maintainer to classify the churn cause. The
task field takes precedence over project `default_review_budget`, which takes
precedence over the built-in `5`. This is a checkpoint threshold, not an absolute
maximum number of reviews:

- implementation defect – the code is genuinely not done;
- evidence drift – the code is fine but the durable summary cites a stale head;
- task-contract ambiguity – acceptance criteria are underspecified;
- scope pollution – unrelated changes entered the artifact;
- reviewer/engineer disagreement – a sustained-and-disputed item;
- external blocker – a dependency outside the task.

Orchestrator records Maintainer's disposition as a durable checkpoint bound to
the current review count and latest reviewed artifact, then either routes a single
targeted revision plan that names the specific cause, or records
`needs_context` or `blocked` using [[blocked-state]] when a contract change or
human decision is required. After five counted outcomes, the next undirected
"try again" revision is not allowed.

### Durable checkpoint record

The checkpoint uses one of three directions:

- `targeted_revision` – authorizes exactly one next revision with a named cause;
- `needs_context` – a contract or context change is required before proceeding;
- `blocked` – a human or external decision is required.

For GitHub, append the checkpoint to the PR conversation:

<!-- agenticloop:canonical-checkpoint github -->
```text
<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->

## Review Round Checkpoint

- Direction: targeted_revision
- Cause: implementation_defect
- Review count: 5
- Artifact: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
- Target: F-2: refresh the current-head verification evidence
- Review role carrier: agenticloop.review-role-carrier/v1
- Role ID: orchestrator
- Actor account: orchestrator-bot

[[agent: orchestrator]]
```

The direction is one of `targeted_revision`, `needs_context`, or `blocked`; the
cause is one of `implementation_defect`, `evidence_drift`,
`task_contract_ambiguity`, `scope_pollution`, `reviewer_engineer_disagreement`,
or `external_blocker`. `targeted_revision` requires `Target`; `needs_context`
and `blocked` require `Reference` instead.

For files-backed, append the same semantic fields under
`## Review History` / `### Review Round Checkpoint`, without the GitHub HTML
marker. Its `Artifact` is the canonical `implementation_artifact` reference
(for example `commit:abc123`) and its `Orchestrator` field is required.

A `targeted_revision` checkpoint binds review artifact A and authorizes exactly
one following Engineer revision B; A must not equal B. If B receives any later
review outcome, the old checkpoint is consumed. Another `needs_revision` requires
a new checkpoint bound to B and the new cumulative count.
The budget is never reset and an old checkpoint cannot be replayed. Reject
missing, stale, malformed, or reused checkpoint authorization.

`github-preflight` is the fail-closed backstop before any over-budget PR returns
to review. Files task validation/status provides the equivalent backstop.

## Task Record Contract

Use `agenticloop/memory/task-record.md` as the canonical task-record shape.
It defines the ordered required sections, the optional sections, the completion
summary template handoff, and the reviewer checklist seed items.

No placeholders. Scope, acceptance criteria, and required checks must be
concrete enough to verify.

`Out of Scope` is mandatory. It prevents the agent from expanding the task
while implementing.

`Applicable Project Skills` is optional. Maintainer may record visible,
host-exposed target-project skills that are relevant to this task's domain.
Those project skills may be used for domain-specific procedures, but Agentic
Loop skills remain authoritative for task records, evidence, review,
blocked-state handling, and closeout.

`Proof Pressure` is optional. For ambiguous or long-running work, the maintainer
may require a concrete `Completion Oracle`, `Final Proof Required`, and `Likely
Misfire`. These fields help the engineer stay aligned with the owner's outcome
and help the reviewer verify that local success is real success. They complement
acceptance criteria; they do not replace scope, out-of-scope boundaries, or
required checks.

`## Outcome` is optional for routine clean tasks. It becomes conditionally
required at closeout when any of the following happened: review rounds > 1,
failed or triaged checks, blocked/needs_context state, scope drift, stale
evidence, human intervention, predicted medium/high context overflow risk,
context pressure encountered, or follow-ups. The section uses the task-record
Outcome fields, including `context_pressure_encountered`, for later pattern
mining.

## Verification Learning

`## Verification Operating Facts` in `.agenticloop/project.md` is the one
current, mutable, maintainer-owned profile for project-wide check behavior. It
uses the canonical `### VF-...` entries and fields in
[[verification-evidence]]. A fact records observed command behavior and the
current operational strategy; update or replace it when evidence changes rather
than accumulating competing facts for the same command.

Current final-state evidence and verification-attempt history serve different
purposes. The current implementation summary is the mutable, canonical evidence
surface for the exact artifact now under review. It lists every required check
and its final-state verdict. GitHub projects keep that surface in the PR body;
files-backed projects keep it in the current task summary under their existing
exact-artifact rules.

`## Verification Attempts` is exceptional, append-only execution history, not a
second mandatory copy of routine successful final-state results. New task
records start with its canonical empty state. Create or append an attempt episode
when a required or cited check fails, times out, is blocked, needs a retry,
foreground escalation, strategy change, or maintainer triage, or when a later
attempt resolves an already recorded episode. A routine first-pass success stays
in current evidence and, when event logging is enabled, its existing `check.run`
event. An `accepted` or `closed` task cannot retain a timed-out attempt with
missing or `pending` triage. Attempts retain the exact artifact on which they
ran; never rewrite old attempts to a newer artifact merely because current
evidence moved. The exact attempt, foreground prediction, triage shapes, retry
limits, and event procedure are owned by [[verification-evidence]]. Backend
placement and append-only behavior are owned by the matching backend projection.

Acceptance requires canonical current evidence for the final implementation
artifact and valid, attributed, internally consistent exceptional history where
it exists. A pending timeout triage, active retry, or unresolved blocker cannot
be hidden. The absence of a final-artifact entry in an old resolved attempt
carrier is not itself a Lens 1 blocker when current final-state evidence is
complete.

For `accepted` or `closed` work, the latest recorded attempt in an exceptional
per-check episode must either pass or carry final maintainer triage. A latest
`failed`, `blocked`, or `timed_out` attempt without final triage remains active;
a latest attempt triaged as `blocker` remains unresolved. Both block terminal
state. GitHub current evidence that reports `failed` or `blocked` must use a
stable `RC-N` id and have the matching marked exceptional-history carrier.

## Project Operating Facts

`## Project Operating Facts` in `.agenticloop/project.md` is the one current,
mutable, maintainer-owned profile for lightweight project-wide operating
knowledge. A Project Operating Fact is current, mutable, maintainer-owned,
source-linked, non-binding, and project-wide. It records an operating reality
worth reusing; it is not a policy decision and does not by itself constrain
future work. This section is the canonical owner of the full definition; role
and skill files carry concise responsibilities and refer here rather than
restating it.

Project Operating Facts follow the Verification Operating Facts profile as a
precedent, not its verification-specific schema. Each fact is one compact bullet
with a stable `PF-...` identifier, a concise statement of current project
behavior or operating reality, a durable source reference, and a concrete
"Revisit when" trigger. Sources may include a task record, issue or PR, commit,
durable Markdown document, or directly relevant canonical source file. A fact
may wrap across physical lines but remains one logical bullet.

### Recognition test

Treat knowledge as a Project Operating Fact candidate only when all of these
hold:

1. it is likely to matter beyond the current task;
2. it describes current project-wide operating reality rather than one attempt;
3. it is not already recorded in an appropriate durable source, or is important
   enough to warrant a compact project-map pointer;
4. reconstructing it later would be costly, error-prone, or likely to lead to
   the wrong operational choice;
5. it is supported by identifiable evidence;
6. it is non-binding; otherwise it belongs in a decision record.

Use "not already explicit or cheaply discoverable" rather than "non-derivable":
a fact may be technically recoverable from several files while still being
expensive or error-prone to reconstruct.

### Routing

Route reusable knowledge to one durable destination. This is routing, not a
linear promotion sequence; a detailed runbook and a compact project-map pointer
may coexist.

| Knowledge type | Durable destination |
|---|---|
| Temporary observation or task-specific evidence | Current task record |
| Detailed command sequence, setup procedure, or operator runbook | Relevant project documentation |
| Compact pointer to an important runbook | Project Operating Facts |
| Current, non-binding project-wide operating fact | Project Operating Facts |
| Binding convention, policy, architecture, security, quality, or release rule | Proposed/accepted decision record |
| Repeated Agentic Loop process friction | Human-invoked retrospective or improvement artifact |
| Personal preference spanning repositories | Host memory outside Agentic Loop |

Keep detailed runbooks in normal project documentation; a fact may link to one
instead of duplicating it. Promote a fact to a decision record when it
constrains future implementation, architecture, security, quality, release
behavior, or accepted project conventions – see [[decision-capture]]. A project
fact may cite a decision, but a fact is not approval.

### Ownership and updates

The maintainer owns this profile. Keep one active entry per fact; update or
remove a stale fact rather than accumulating contradictory entries; keep entries
compact. Never store secrets, credentials, raw transcripts, prompt logs, full
tool output, personal data, temporary debugging observations, or speculative
conclusions. Do not use a project fact to impose binding policy.

When recording the first fact, replace the canonical empty-state sentence,
`No project-wide operating facts are currently recorded.` When removing the
last fact, restore that sentence. Never retain the empty-state sentence beside
active `PF-...` entries.

### Capture at a natural checkpoint

When work reveals a supported Project Operating Fact candidate, report it at the
next natural checkpoint. If recording it is already within the authorized work,
the maintainer may update the profile. Otherwise, offer one concrete destination
and ask whether to preserve it. Consolidate and deduplicate multiple candidates
before offering; do not interrupt implementation for a candidate unless it
affects current correctness or another active lane; do not ask again after the
human declines; and do not silently expand task scope to write unrelated
documentation or shared workflow state. Declining or deferring capture does not
by itself block task acceptance or closeout.

### Existing targets and parallel writes

The section is optional and Markdown-first. Its absence in an existing project
map is valid; add `## Project Operating Facts` when the first fact is approved,
and never overwrite a target-owned project map to insert it. `.agenticloop/project.md`
is shared mutable state: engineer implementation lanes do not append or edit
Project Operating Facts and always return candidates. A maintainer-owned
coordination lane may mutate the profile only when the concurrency plan grants
it explicit exclusive ownership of `.agenticloop/project.md` and proves no
collision. Otherwise, sibling-affecting candidates use cross-lane findings and
one serial maintainer-owned join step applies approved facts. See
[[parallel-delegation]].

## Task Backends

The active task backend defines where task records live. Read `task_backend`
from `.agenticloop/project.md` frontmatter. The default is `files`.

Backend projection docs live in `agenticloop/backends/`:

- `agenticloop/backends/files.md` maps task records to local Markdown files under `.agenticloop/`.
- `agenticloop/backends/github.md` maps task records to GitHub issues, labels, comments, and pull requests.

## Event Logging

Event logging is optional. Agents must not attempt CLI event logging unless
`.agenticloop/project.md` says `event_logging: enabled`.

When event logging is enabled, zero events for a completed or reviewed task is
non-conformant.

The operational procedure – resolving the command (including the one-time
CLI-help fallback check), the disabled and non-blocking rules, the
concise-summary and small-`data` rules, and command safety – is owned by the
[[event-logging]] skill. This section owns why event logging exists, the event
taxonomy, and which lifecycle gates emit which events. Events default to
`.agenticloop/logs/<TASK-ID>.jsonl` via `--task <TASK-ID>`.

Do not backfill missed normal gate events as if they happened on time. If an
agent discovers that events were missed, record the miss as a process gap in
the task record, review, or retrospective. If the CLI supports a suitable
truthful event, use a concise `task.updated` or `blocked` or `needs_context`
only when that event is actually true. Do not fabricate the missing sequence.

For strict audit, the minimal required event set is:

- `role.invoked`
- `task.started`
- `check.run` for each required or cited verification command
- `review.result`
- `task.closed` when the task is closed

A durable `task.closed` event must have `outcome: success` and role
`maintainer` or `orchestrator`. For GitHub-backed tasks it must also include
both `github:issue:<number>` and `github:pr:<number>` refs, or document an
exception in `data.closure_exception` (for example a no-PR or manual-close
exception with a non-empty `reason`). Files-backed tasks do not require GitHub
refs. The audit treats the last `task.closed` event as the final satisfying
closure event, so a later non-durable engineer revision-complete marker fails
strict audit.

Use event logging for these recommended default gates:

- `task.created` when a durable task record is created.
- `task.updated` when task scope, acceptance criteria, required checks, backend
  linkage, or review state materially changes.
- `task.started` when implementation or revision work begins.
- `role.invoked` when orchestrator delegates to a role or starts a fallback role
  assumption.
- `check.run` after each required or cited verification command.
- `review.started` when maintainer review begins.
- `review.result` when review is recorded as accepted or needs_revision.
- `decision.recorded` when a tracked Markdown decision record is created or updated.
- `blocked` or `needs_context` when work cannot continue.
- `task.closed` when the task is durably closed.
- `summary.published` when the closeout status marker is posted.

When events in the same target share a `task_id`, the CLI derives the same
deterministic `trace_id` automatically unless `--trace-id` is supplied.

Do not record every chat turn. Do not write raw prompts, raw assistant text,
full tool output, transcript payloads, or host runtime exports. Keep entries to
short summaries, references, and small structured data only.

Keep the top-level event schema unchanged. Use `refs` and `data` for small,
structured context only.

Recommended `refs` values:

- `github:issue:<number>`
- `github:pr:<number>`
- `commit:<sha>`
- `branch:<name>`
- `task-file:<path>`
- `command:<command>`

Recommended `data` conventions:

- `check.run`: `command`, `exit_code`, `passed`, `failed`, `skipped`,
  `duration_ms`, `timeout_ms`, `timed_out`, `host_timeout_limit_ms`,
  `execution_strategy`, `attempt`, `required`, `triaged_unrelated`,
  `accepted_known_failure`
- `role.invoked`: `target_role` (`maintainer` or `engineer`), `delegation_mode`
  (`host_subagent`, `explicit_agent_invocation`, or `single_agent_fallback`), a
  boolean `fallback`, `adapter`, `model` only when explicitly known from adapter
  config, and `reason`. For `single_agent_fallback` also record `fallback: true`,
  a structured `fallback_cause` (`mechanism_absent` or `invocation_failed`), and a
  non-empty `reason`; non-fallback modes use `fallback: false` and no fallback
  cause. The orchestrator emits `role.invoked`; a role never emits a
  self-invocation targeting itself.
- `review.started` and `review.result`: the maintainer is the top-level event
  `role`; data carries `review_round`, `review_mode` (a valid
  review mode), `artifact_revision`, `pr_head`. Add `continuation_reason` when a
  direct same-session continuation records the review without a corresponding
  `role.invoked`. Add `maintainer_fixup: true` only on a maintainer
  `review.result` with `review_mode: single_agent_fallback` when a Maintainer
  Review Fixup was applied; a fallback review mode alone does not imply a fixup.

Newly produced `role.invoked` and `review.result` events pass strict producer
validation before they are written: `role.invoked` requires `target_role`,
`delegation_mode`, and a boolean `fallback` (plus `fallback_cause` and a
non-empty `reason` for `single_agent_fallback`); `review.result` requires
`review_round`, a valid `review_mode`, and top-level role `maintainer`. Historical logs that predate these
conventions are read and reported, never rewritten or backfilled.

`check.run` triage fields:

- `required`: true when the check is a required gate for this task.
- `triaged_unrelated`: true when the failure or blocked result is unrelated to
  the task change and accepted as such.
- `accepted_known_failure`: true when the failure is a pre-existing known
  failure and accepted for this task.

A triaged unrelated or known failure must still be logged with its real outcome
(usually `failure` or `blocked`), not rewritten as a clean `success`. The triage
fields let reports distinguish an accepted imperfect check from an untriaged
failure.

`execution_strategy` values are small strings such as `foreground`,
`background`, `focused`, `split`, or `ci`. Use `execution_strategy` to record
how a check was run when the strategy is material to interpreting its outcome
or duration. A timed-out or expensive check should be logged with its real
outcome and the chosen strategy, not hidden as success.

`data` must stay small, structured, and non-transcript. Do not copy prompts,
responses, full tool output, token streams, per-turn telemetry, or raw host
exports into it.

Use `npx agenticloop event-logging validate` to validate the local event logs
when needed. Use `npx agenticloop event-logging audit --task <TASK-ID>` for a
strict task-scoped audit of the minimal required events. Use `npx agenticloop
event-logging report --task <TASK-ID>` for a local read-side summary of one
task log. Use `npx agenticloop event-logging report` (without `--task`) for a
read-only aggregate summary across every `.agenticloop/logs/*.jsonl` file;
the aggregate surfaces strict-audit gaps, durable-closure gaps, review churn,
check outcomes, delegation/fallback counts, delegation/review provenance-quality
gaps (incomplete or inconsistent `role.invoked`, self-invocation, non-orchestrator
emitters, `review.result` missing `review_mode` or emitted by a non-maintainer,
and maintainer review rounds with neither correlated delegation evidence nor a
continuation reason – each review round is
matched per-review against a preceding unconsumed maintainer invocation for that
step, never estimated by aggregate subtraction), `maintainer_fixup: true` event
counts (reported as event counts, with more than one per task flagged as a
multiple-episode anomaly), invalid or empty logs, and
`host=unknown` events as telemetry-quality warnings rather than workflow failures.
Historical incomplete events are labeled legacy/unknown, never inferred or
backfilled. Reporting
stays local; it does not upload data or require producers to add new event keys
before it is useful. Add `--features` to that aggregate command for a
feature-adoption view: minimalism levels and triggers, non-default effort
budgets, medium/high context-overflow risk, context-pressure calibration
coverage, review-round churn against budget, and context-risk omission
candidates (telemetry tasks that hit context pressure or reached/exceeded review
budget without a predicted context_overflow_risk), reported as heuristic
candidates rather than warnings. The review-round dimension is
derived from existing `review.result` events, so it works on historical logs;
the knob dimensions read the optional `task.created`/`task.closed` telemetry
fields when present. `npx agenticloop validate` also validates every default
`.agenticloop/logs/*.jsonl` file when present, and – when
`event_logging: enabled` is recorded – cross-checks each files-backed task
record's durable `## Maintainer Review Fixup` subsection against that task's
`maintainer_fixup: true` review events, reporting historical mismatches and
multiple-episode anomalies as warnings. Only an event with the matching task id,
role `maintainer`, and `review_mode: single_agent_fallback` satisfies that
cross-check; malformed historical flags are reported separately. A
`review_mode: single_agent_fallback` alone is never counted as a fixup; only the
durable subsection and the explicit
event flag are.

## Decision Records

Decision records are short tracked Markdown files for durable project decisions
that constrain future work. Store them under:

```text
.agenticloop/decisions/
  D-2026-06-17-001.md
```

Rules:

- At task start, read `.agenticloop/project.md`, the current task record, and
  selected source documents. Read decision records only when they are
  explicitly linked from the task record, project map, selected source
  documents, or directly named by the user.
- If a task depends on an unlinked historical decision, add the durable link
  to the nearest source while working.
- Decision records live under `.agenticloop/decisions/`.
- No decision index is maintained.
- Record decisions that constrain future work, especially process,
  architecture, backend, role, quality, security, release, product direction,
  or accepted project conventions. Accepted project conventions and other
  binding prescriptions remain decisions and still require decision governance;
  a current, non-binding Project Operating Fact is not a decision. Promote a
  fact only when it becomes binding.
- Any role may create a new `status: proposed` decision record when it
  directly discovers evidence that constrains future work. Proposed records
  must include provenance fields (`proposed_at`, `proposed_by_role`,
  `proposed_by`) and source references (`source_refs`).
- Verification is a narrower exception: the engineer records a timeout or
  expensive-check observation through [[verification-evidence]], and the
  maintainer may use a verification decision only after final triage and a
  current `VF-...` fact establish a policy-level promotion.
- Findings discovered during parallel work follow a promotion threshold. A
  lane-local observation stays in that lane's status return or task summary. A
  finding relevant only to the current batch is routed and disposed under the
  cross-lane finding rules. A durable technical invariant that constrains
  future work beyond the batch may become a `status: proposed` decision record
  with provenance and a source link; the maintainer resolves it under the
  existing acceptance rules, and future work retrieves it through existing
  source-linked decision discovery. Nothing in parallel work auto-promotes a
  finding into a decision record, a skill, or this methodology.
- Maintainer owns acceptance, rejection, supersession, and edits to accepted
  decisions. Human confirmation or an approved `type:change-request` remains
  required for `accepted`.
- Decision status is one of `proposed`, `accepted`, `rejected`, or
  `superseded`.
- Do not silently rewrite an `accepted` decision to change its meaning. Create
  a new record and mark the old one `superseded`.
- Accepted decisions remain protected by the existing change-request rules.
- A role working in a parallel lane may create a new uniquely named
  `proposed` record, but must not edit an existing decision record unless the
  concurrency plan grants exclusive ownership.
- `decision.recorded` may be emitted by the role that created a `proposed`
  decision record. Maintainer emits `decision.recorded` when resolving,
  accepting, rejecting, or superseding a decision. The event log is an audit
  signal, not the source of truth.
- Changing an accepted locked process, architecture, backend, or project
  decision must use [[change-request-gate]] before implementation.

Verification observations first belong in the task's append-only attempt history
and, when they affect repeated project work, in the mutable verification-fact
profile. A verification decision is narrower: the maintainer may use
[[decision-capture]] only to promote an already-recorded, policy-level profile
observation into a durable decision that needs the normal acceptance gate. A
timeout alone is not a decision and does not authorize a role to approve a new
strategy. Decisions cite the fact and task evidence; raw timing output remains in
the attempt history or event log.

## Default Backend: Files

Task records are Markdown files under `.agenticloop/tasks/`. The default task ID
shape is neutral and flat-project friendly.

Valid default task IDs: `T-001`, `T-002`, `T-120`.

```text
.agenticloop/
  decisions/
    D-2026-06-17-001.md
  improvements/ (created on first proposal)
    I-2026-06-17-001.md
  tasks/
    T-001.md
    T-002.md
```

No GitHub repository is required for files-backed work.

Projects that choose a grouping profile may still use group-shaped task IDs such
as `P1-01`, but that is optional project config, not the universal default.

The registry regex in `agenticloop/config.json` bounds detection candidates
only; the enforced per-project convention is `task_id_regex` in
`.agenticloop/project.md` (default `^T-\d{3,}$`). An ID valid under the registry
regex is not necessarily valid for the project.

## Optional Backend: GitHub

When `task_backend: github` is set in `.agenticloop/project.md`, use one GitHub
issue and one pull request per implementation task:

1. Maintainer creates or refines the issue.
2. Engineer creates a branch and implements the issue scope.
3. Engineer runs checks and opens a pull request.
4. Engineer publishes the implementation summary in one durable place. For a
   normal implementation PR, use the PR body and include a GitHub closing
   keyword for the task issue, normally `Closes #<issue-number>`. Do not also
   post the same summary as an issue or PR comment.
5. Maintainer reviews the PR against the issue, checking existing review
   markers for the current PR head before posting a new marker. For normal
   GitHub-backed implementation tasks, the maintainer must treat a missing
   recognized closing keyword as a linkage defect before acceptance.
6. Engineer revises until accepted, unless the current review qualifies for a
   bounded Maintainer Review Fixup under [[review-and-accept]].
7. Human approves merge when appropriate.
8. Issue closes through the merged PR. The task is not durably closed until
   GitHub shows the task issue closed, not merely because a local event was
   written or the PR was merged.

Before applying the `agent-ready` label, the Maintainer runs
`task-readiness --mode authoring` with the current base-tree inventory, resolves
or explicitly dispositions every warning, and records the dispatched contract
baseline. This is an executable authoring gate, not optional advice.

For automated work, this path applies to code, docs, configuration, workflow,
and infrastructure changes alike. Once a task is delegated to an agent role in a
GitHub-backed project, the agent must not commit task work directly to the
default or integration branch. Create or use a task branch, publish the branch,
and review the pull request diff.

A task branch has one terminal merge path. After its pull request is merged by
merge commit, squash, or rebase, do not also merge the same task branch into the
default branch as a second path for the same work.

Human-authored repository maintenance may happen outside Agentic Loop when the
human intentionally handles it that way. Do not treat that exception as
permission for agent-authored task work to bypass the issue, branch, PR, review,
and merge path. A no-PR exception for agent-authored work must be approved by a
human and recorded in the task record before implementation starts.

Use labels such as `agent-ready`, `blocked`, `approved`, `type:impl`,
`type:change-request`, and `task:<TASK-ID>`. If the project uses grouping,
apply the configured grouping label as well. For example, a project with
`grouping_profile: phase` may use `phase:1`.

Bootstrap labels with `agenticloop bootstrap-labels` before creating the first
GitHub task record. See `agenticloop/backends/github.md` for the full label and branch
conventions.

## Implementation Loop

For each task:

1. Confirm the task record is complete.
2. Identify expected files, commands, and risks.
3. For behavior changes, create a failing test or failing check first.
4. Implement the smallest useful slice by default.
5. Summarize or return `needs_context` when unexpected context expansion exceeds
   the task record's bounds.
6. Run the focused check.
7. Run the required checks.
8. Publish the implementation summary with evidence in the backend's canonical
   location.
9. Request review.

For a timeout, unexpectedly expensive check, or retry, load
[[verification-evidence]] before choosing how to run it again. Do not treat an
unchanged rerun as a new verification plan.

The default sizing is one independently verifiable task at a time, the smallest
useful implementation slice. When a human authorizes a larger bounded run,
prefer the largest safe useful slice that remains bounded, reversible, and
independently verifiable as one task. Authorizing a phase, group, milestone, or
task set is not permission to create one oversized task record; broad work items
still decompose into ordinary task records.

Implementation summaries use `agenticloop/memory/work-unit-summary.md` with
`summary_unit: task`. `Evidence` must include fresh output from the final state.
Claims without evidence are not enough.

The evidence contract covers changed files and artifacts under `## Artifacts`,
commands, statuses, and concise final-state output under `## Evidence`,
unexpected scope changes under `## Deviations`, blockers, risks, and process
friction under `## Process Observations` or `## Known Gaps`, follow-up task ids
under `## Follow-Ups`, and optional event-log-derived facts under `## Trace`.
Prefer concise verdict lines and relevant output excerpts over full terminal
dumps, while still reading full command output before claiming success. Output
refs remain a deferred future policy; do not create or rely on them now.

## Scratch and Temporary Files

Scratch and temporary files must stay inside the target project's `.agenticloop/tmp/`
directory, which should be gitignored. The path includes the slash separator
between `.agenticloop` and `tmp`; never create root-level lookalikes such as
`.agenticlooptmp/`, `.agenticloop-tmp/`, `agenticlooptmp/`, or
`agenticloop-tmp/`. If the directory is absent, create `.agenticloop/tmp/`.
Do not write temporary files to the system temp directory, user profile, host
runtime directories, or the repository root.

Always refer to scratch paths with the **relative, forward-slash** form
(`.agenticloop/tmp/<name>.md`). Do not build an absolute Windows path with
backslashes and pass it to a shell command: POSIX shells (including the Git Bash
used by some hosts) consume `\` as an escape character, so a path like
`C:\repo\.agenticloop\tmp\body.md` collapses into a single junk filename in the
repository root (`C:repo.agenticlooptmpbody.md`). A relative forward-slash path
works on every host and avoids this corruption.

Prefer a temporary Markdown file under the target project's `.agenticloop/tmp/` directory
for GitHub issue, pull request, and comment bodies, then pass it with
`gh ... --body-file <path>`. Avoid heredocs, here-strings, and long inline
`--body` arguments for structured Markdown. Remove the temporary body file
after posting, and mention it in evidence only when it affects reproducibility.

## Review Loop

A **full review** has three ordered lenses in one review turn, one combined
durable review body, one `review.started`, and one `review.result`:

1. **Lens 1: Task Compliance**
2. **Lens 2: Engineering Quality**
3. **Lens 3: Necessity and Coherence**

A **revision review** is narrower: it runs Lens 1 plus a bounded Structural
Risk Sweep only when Lens 1 finds that the requested correction changes the
implementation artifact. It is not a new review mode, agent, event pair, or
per-lens routing mechanism. Same-turn lenses are not independent review and
never satisfy `independent_review_required`; existing `review_mode` values
remain unchanged.

Lens 1: task compliance.

- Diff matches scope.
- Out-of-scope work is absent or justified.
- Acceptance criteria are met.
- Required checks were run on the final state.
- Every exceptional verification episode ends in a pass or final non-blocker
  maintainer triage; no required check remains failed, blocked, timed out,
  `pending`, or triaged as a blocker.
- New behavior has RED-to-GREEN or equivalent evidence.
- Locked process or architecture decisions did not change accidentally.

Lens 2: engineering quality.

- Design is appropriate for the task.
- Names, errors, and boundaries are clear.
- Docs changed when commands, configuration, or user-visible behavior changed.
- No secrets, caches, dumps, or raw transcripts were committed.
- Known limitations and follow-ups are triaged.

Lens 3: necessity and coherence. In a full review, run it after Lens 2. Check
whether every new abstraction, dependency, file,
framework, extension point, or compatibility layer is required by accepted
scope; existing project/platform/standard-library/installed-dependency capability
could satisfy it; the root cause is fixed rather than patched in callers; a
parallel mechanism avoids a bounded core correction; the core change is
appropriate for the confirmed development stage; limitations have clear upgrade
triggers; and simplification preserves correctness, clarity, validation, error
handling, security, accessibility, and evidence.

Lens 3 blocks only concrete artifact costs: unused or speculative abstractions,
unnecessary dependencies, hypothetical scaffolding, task-introduced dead code,
duplicate mechanisms, a smaller safer authorized root fix displaced by
patch-in-every-caller workarounds, compatibility layers without a real contract,
stage-inappropriate churn, or stage-inappropriate refusal to correct core code.
It does not block style preferences, theoretically shorter alternatives without
material benefit, removal of accepted requirements, broad redesign outside the
task, unrelated cleanup, or speculative optimization. An observation that would
change accepted scope, an accepted decision, or a public contract routes through
[[change-request-gate]], a follow-up, or a new task; Lens 3 does not relitigate
the accepted task contract. Ponytail remains opt-in; Lens 3 is always active and
only additionally checks Ponytail intensity and `ponytail:` limitations when the
task explicitly activates Ponytail.

When Lens 1 finds any concrete problem, enumerate every concrete Lens 1 finding
and classify the requested revision in plain Markdown:

- `implementation-changing` when correction requires changing source, tests,
  dependencies, generated contract artifacts, implementation configuration, or
  another part of the reviewed implementation artifact;
- `record-only` only when the task contract is valid and concrete, the exact
  implementation artifact and diff are technically reviewable, correction is
  limited to records or evidence presentation, no implementation artifact change
  is requested, and missing evidence does not prevent meaningful engineering
  assessment.

Both classifications return `needs_revision`; Lens 1 always gates acceptance.
For `implementation-changing`, run the Structural Risk Sweep when the artifact
is available and reviewable, put every concrete sweep finding in the same
revision packet, and explicitly defer full Lens 2 and Lens 3 because the
implementation will move. If meaningful inspection is impossible, state why the
sweep could not run. A sweep is early hazard detection, not a clean or complete
Lens 2 or Lens 3 verdict.

For `record-only`, complete the full ordered Lens 2 and Lens 3 assessment in the
same durable review body, bound to the exact implementation artifact. Combine
their findings with Lens 1 corrections in one revision packet. The task remains
`needs_revision` until Lens 1 is corrected and all ordinary acceptance gates
pass.

### Structural Risk Sweep

The bounded Structural Risk Sweep looks only for concrete, artifact-grounded
hazards that become more expensive after implementation revision:

- unnecessary dependencies, files, abstractions, frameworks, or extension
  points;
- duplicate mechanisms or second sources of truth;
- tests of helpers, mocks, or parallel paths rather than public or production
  paths;
- out-of-scope work, secrets, dumps, generated caches, raw outputs, scratch
  files, or debug instrumentation;
- patch-in-every-caller workarounds where an authorized root correction is
  smaller and safer;
- obvious stage-inappropriate structural churn.

Findings must be concrete and actionable. Do not add speculative style advice
or theoretical alternatives without material benefit, and do not call a concrete
sweep finding non-blocking merely because it came from the sweep. Put it in
`Required Revisions` with normal severity. A clean sweep does not imply Lens 2
or Lens 3 is clean. While Lens 1 is unclean, no Lens 1 or sweep finding is
eligible for a Maintainer Review Fixup.

### Artifact-bound re-review

When the implementation artifact is exactly unchanged, revalidate Lens 1.
Previously completed full Lens 2 and Lens 3 assessments may be reused only when
the new durable review body cites the prior review reference, says the artifact
is unchanged, and contains or clearly incorporates the final Lens 2 and Lens 3
conclusions. This supports record-only PR-body or issue-comment corrections that
leave the PR head unchanged.

When the implementation artifact changed, prior Lens 2 and Lens 3 conclusions
are stale for acceptance. Run a fresh full review against the new exact artifact;
the investigation may focus on the delta, but its verdict covers the complete
artifact. Files-backed work retains its exact artifact-match rule: a task-record
edit that changes the recorded implementation artifact makes prior assessments
stale unless existing backend rules already prove exact identity. Do not invent a
content-hash or equivalence mechanism.

Final acceptance always requires Lens 1, Lens 2, and Lens 3 conclusions for the
exact accepted artifact, whether a same-artifact review incorporates a cited
prior full assessment or a changed artifact receives a fresh one. If review
feedback is disputed, resolve the dispute with evidence rather than repeated
assertion.

When Lens 1 is clean and one Lens 2 or Lens 3 finding is minor and fully
understood, the maintainer may apply one bounded **Maintainer Review Fixup**
instead of requesting an engineer revision. The lenses share one fixup episode
per task; after the fixup, rerun all three against the resulting artifact and
accept only with `review_mode: single_agent_fallback`. Independent-review tasks
are ineligible, and any finding that expands, becomes uncertain, or exceeds one
coherent edit packet returns to the normal engineer revision path. Merge,
integration, issue closure, and closeout gates are unchanged. All eligibility and
procedure live in [[review-and-accept]].

Every review outcome records its mode and the exact artifact revision reviewed.
Final acceptance requires current, non-stale provenance. Tasks requiring
independent review cannot be accepted through same-session fallback. See
[[review-and-accept]] and [[task-record-contract]].

If the first full Lens 2 and Lens 3 assessment occurs only after the review
budget has been reached or exceeded, Maintainer should mention that timing in
review or closeout observations as a calibration signal. The Review Round
Checkpoint remains the required authorization gate for another implementation
revision at that boundary.

## Blocked and Needs Context

Use `needs_context` when the task record is incomplete but the maintainer can
answer or amend it, or when unexpected context expansion means the task must be
split or tightened before implementation can continue.

Use `blocked` when progress requires a human decision, missing credentials,
unavailable services, merge conflict resolution, or another external action.

For files-backed work, record durable state in the task file:

- `status: needs_context` plus dated questions or notes under `## Comments` when
  the maintainer can answer. Use `context_reason: context_overflow` in the note
  when context pressure caused the pause,
- `status: blocked` plus `block_category: <category>` and a blocker section when
  an external action or human decision is required.

For GitHub-backed work, `needs_context` is a task-record comment containing
`AGENT_TASK_STATUS: needs_context`. Add
`AGENT_CONTEXT_REASON: context_overflow` when context pressure caused the pause.

GitHub-backed blocked tasks carry both:

- the `blocked` label
- a comment containing `AGENT_TASK_STATUS: blocked` and `AGENT_BLOCK_CATEGORY: <category>`

The loop resumes only after the blocker is cleared and the durable task record
reflects the decision.

## Change-Request Gate

A `type:change-request` task changes a locked decision: process, architecture,
task rules, or other durable project contract.

Required gate:

1. Maintainer drafts or updates the relevant docs, decision record, or ADR.
2. Human reviews and approves the docs-only change.
3. The task receives the configured approval marker.
4. Implementation can proceed.

For files-backed work, represent that state in task-file frontmatter, typically
with `type: change-request`, `approved: true` after approval, and
`status: blocked` plus `block_category: contract` until approval exists.

For GitHub-backed work, use the configured `type:change-request` and
`approved` labels.

Do not implement a locked-decision change before approval.

## Attribution

When multiple roles use one GitHub identity, each agent-authored issue, PR, or
comment ends with:

```text
[[agent: maintainer]]
```

Use the actual role name. Commit messages for agent-authored commits include:

```text
Task: T-001
Agent: engineer
```

Attribution is cooperative, not cryptographic. It helps humans and later agents
understand who produced which artifact.

For a prospective commit, write the complete message to
`.agenticloop/tmp/<task>-commit-message.txt`, end it with one contiguous
`Task:`/`Agent:` block, run `commit-attribution check --task <id> --message-file
<path>`, commit with `git commit -F <path>`, then run the HEAD-based check before
pushing. `Agent:` names the role responsible for the committed content, not a
mechanical repair operator. Do not compose the trailers as separate `-m`
paragraphs. The GitHub backend owns the narrow already-pushed metadata-repair
exception and its durable repair record.

## Closeout

When a project's configured grouping says closeout is enabled, closeout
preparation may begin after all tasks in the current group are accepted. It
performs only the conditional source-plan synchronization owned by
[[task-closeout]], then that permitted update is integrated or frozen with the
resulting candidate before final audit. The maintainer runs the final closeout
gate after the resulting candidate is integrated or frozen and certified, or
closed according to the configured backend. In flat projects, the same ordered
preparation and final gate apply when a human-identified task set or work unit
finishes.

Final closeout is a verify-and-mark gate. It does not write a separate summary
artifact: the durable record is the per-task inline summary (the `## Scope
Completed` section in each task file, or the PR body for GitHub-backed work) plus
the backend. Final closeout confirms that record is complete and posts a status
marker.

When `work_unit_audit` resolves to `enabled` (the default, including when the key
is absent), closeout cannot publish `AGENT_CLOSEOUT_STATUS: complete` without a
current work-unit certificate: exactly one audit record for the exact work unit,
`audit_state: certified`, a certifying `latest_verdict`, `certified_artifact`
equal to `candidate_artifact`, `certified_covered_tasks` equal to
`covered_tasks`, a last completed Auditor run whose artifact, covered-task set,
and verdict match those certification fields, no unresolved blocking finding,
a typed human or existing accepted-decision authority reference for every
accepted limitation, and fresh final-state evidence for the exact candidate.
The record must also pass structural validation. A missing, invalid, stale,
awaiting-human, blocked, or non-certifying audit keeps the marker at
`follow_up_required`. Publish one final marker for the work unit, not one per
audit run. See the Work-Unit Audit section and [[work-unit-audit]].

An explicit `work_unit_audit: disabled` bypasses that gate only for a
non-audit completion: it still requires an exact candidate and every other
closeout gate, records `audit_opt_out: true` with `audit: null`, and never calls
the result certification.

Use `closeout prepare` then `closeout record --packet ... --yes`. Preparation
emits a versioned packet with `publishable`, `completion_eligible`,
`recommended_status`, structured reasons, and a reconstructable digest. Exit 0
from prepare means only completion eligibility; exit 1 may still emit a truthful
packet. Record rebuilds live facts before mutation and compares the packet's
candidate, tasks, carrier revision, audit identity/run/verdict, gates,
dispositions, plan sync, improvements, predecessor set, and derived state. A
files-backend retry of the exact applied packet is idempotent: when the packet
digest is already the one current marker and no other live fact changed, record
returns success without rewriting the marker.

Plan synchronization is mechanical: when a selected source plan applies, an
omitted `--plan-sync` is never completion-eligible; `not_required` is the
explicit opt-out; `synced` cites and verifies the exact plan reference and
content revision. After certification only specifically validated workflow
deltas survive: the bound audit record, the exact marker mutation, a covered-task
`accepted -> closed` terminal transition, an append-only schema-valid closeout
event in an applicable event log, an exact valid referenced improvement
proposal, and transient scratch activity. Every other changed, dirty, untracked,
or renamed path is product drift.

The only marker states are `complete`, `follow_up_required`, `needs_context`, and
`blocked`. One current marker is required. New markers include schema, work unit,
artifact, audit reference, predecessor, plan-sync disposition, improvement refs,
and gate digest. A correction appends a new marker that supersedes exact prior
marker references; old history remains visible. Legacy unprovenanced markers are
recognizable but never valid completion. A packet is transient under
`.agenticloop/tmp/`; status reconstructs the digest from durable state after it is
deleted.

Closeout checks:

- all relevant task records
- all implementation artifacts, including merged PRs for GitHub-backed work
- for GitHub-backed work, each normal merged implementation PR closed its task
  issue, or any exception/manual correction is recorded
- acceptance criteria
- required checks
- resolution of every exceptional verification episode by a pass or final
  non-blocker maintainer triage
- documentation changes
- known gaps
- follow-up task records
- repeated process failures worth turning into skill updates

Post exactly one closeout status marker. For files-backed work, append it to the last accepted task
record under `## Comments`; for GitHub-backed work, post it as a comment on the
last task issue or PR in the work unit. Cite the covered task ids.

Do not copy raw agent transcripts into repo docs. Keep raw discussion in task
records and implementation artifacts; summarize only durable decisions,
evidence, and follow-ups.

The per-task inline summary uses `agenticloop/memory/work-unit-summary.md` with
`summary_unit: task` as the canonical shape. When event logging is enabled and
task-scoped event logs exist, the local event log should help assemble the
optional `## Trace` section, but task records and implementation artifacts remain
the primary sources of truth.

When the project uses grouping and a human wants to move to the next group,
pause for approval before that transition.

## Skills

Use the canonical skills in `agenticloop/skills/` when their trigger applies. The most
important skills are:

- `task-record-contract`
- `tdd-implementation`
- `debugging-before-fixes`
- `verification-evidence`
- `review-and-accept`
- `blocked-state`
- `change-request-gate`
- `decision-capture`
- `work-unit-audit`
- `task-closeout`
- `github-attribution`

Skills are workflows, not background reading. Follow the procedure and
verification steps when a skill applies.

For definitions of Agentic Loop terms, see the Glossary section in this file.
