# Agentic Loop CLI Reference

The shipped contract for the `agenticloop` command line: command hierarchy,
setup versus init, interactive and non-interactive behavior, dry-run and JSON
plans, stdout/stderr rules, exit statuses, capability behavior, and
compatibility aliases.

For onboarding walkthroughs see [Getting Started](./getting-started.md). For
host-specific setup see [Host Adapters](./host-adapters.md).

## Command hierarchy and help

```text
agenticloop setup      Recommended guided onboarding; scaffolds or repairs as needed
agenticloop init       Advanced files-only or direct adapter scaffolding
agenticloop doctor     Read-only diagnosis and next steps
agenticloop update     Refresh an existing installation
```

All commands:

| Command | Purpose |
|---|---|
| `setup` | Guided onboarding: detect, review, choose, plan, apply, verify |
| `init` | Deterministic scaffold: toolkit source, target state, optional adapter |
| `update` (alias `upgrade`) | Refresh toolkit-owned assets and regenerate adapters |
| `doctor` | Read-only setup checklist, adapter state, next steps |
| `status` | Configured adapters, generated artifacts, next steps |
| `validate` | Validate skills, config, links, role-capability bindings, and host setup |
| `remove` | Remove Agentic Loop assets (`--dry-run` or `--yes` required) |
| `guidance` | Manage the activation-guidance block (`apply`, `check`, `remove`) |
| `generate` | Generate adapter artifacts (`opencode`, `codex`, `claude-code`, `copilot`, `cursor`, `all`) |
| `configure models` | Set per-host role model settings in `agenticloop.json` |
| `task` | Files-backed task records (`list`, `lint`, `new`, `prepare-dispatch`, `verify-return`, `status`) |
| `audit` | Work-unit audit certificates (`new`, `baseline`, `report`, `status`, `gate`, `lint`, `override`, `resolve`) |
| `closeout` | Composite closeout packets (`prepare`, `status`, `record`) |
| `improvement` | Bounded improvement proposals (`new`, `lint`, `status`) |
| `worktree` | Guarded worktrees (`add`, `guard`, `list`, `remove`, `cleanup`, `resolve-state`, `prune`) |
| `event-logging` (alias `event`) | Write, validate, audit, and report workflow event logs |
| `github-preflight` | Pre-review evidence gate for a GitHub PR |
| `github-review-audit` | Artifact-bound review provenance for a PR |
| `github-ready` | Read-only merge-readiness verdict |
| `pr-body scaffold` / `pr-body lint` | Scaffold a canonical body (plus optional offline context snapshot) and lint a local candidate body against live or snapshotted context |
| `task-readiness` | Read-only explicit base-tree, path-intent, and dependency readiness check |
| `task-body fetch` / `lint` / `apply` | Guarded GitHub task-record body fetch, validation, dry-run diff, and transactional publication |
| `commit-attribution check` | Read-only Engineer trailer check with repair guidance only |
| `github-checkpoint render` / `repair-plan` | Render a checkpoint or one bounded append-only repair carrier without posting |
| `github-review-prepare` | Fail-closed exact-head Maintainer delegation packet |
| `bootstrap-labels` | Create required GitHub labels |

Help conventions:

- `agenticloop` with no command prints a short first-use screen.
- `agenticloop help` (or `--help`, `-h`) prints the complete catalog.
- `agenticloop help <command> [subcommand]` is equivalent to
  `<command> --help` (and `<command> <subcommand> --help`). Help is always
  safe: it never invokes a command handler and never mutates a target.
- `agenticloop --version` (or `version`) prints the installed version.
- Unknown commands and options fail with exit status `2` and suggest a close
  valid spelling when one exists.
- Commands declare their positional shape. A command without declared
  positionals (for example `init`, `setup`, `update`, `validate`, `doctor`,
  `status`, `generate <host>`) accepts zero operands; required positionals
  must be present; optional positionals may be omitted; extra operands fail
  with exit status `2` before any handler or mutation runs. `--` still
  terminates option parsing, but the resulting operands must satisfy the
  declared shape, and Boolean flags never consume a following token.

## Setup versus init

Use `setup` for onboarding and repair. It detects the project, collects
decisions, shows one complete plan, asks before the first mutation, applies
the plan, and offers validation. It always composes the idempotent init plan,
so it repairs empty, current, legacy, partial, and inverse-partial targets
without overwriting target-owned content. Running setup twice produces zero
second-run mutations.

Use `init` when you want the deterministic, non-guided scaffold: files-only
(`agenticloop init`) or direct adapter scaffolding
(`agenticloop init --adapter <host>`). Both share the same planner, ownership
checks, output renderer, and executor as guided setup.

## Interactive and non-interactive behavior

Interactive setup follows six steps: **Detect, Review, Choose, Plan, Apply,
Verify**. Detection and model discovery are read-only. No file is created or
changed before the final apply confirmation. Blank input takes the displayed
default; invalid input explains the valid choices and reprompts; "Files only"
and "Skip adapter setup" are one explicit "No host integration" choice.

Non-interactive setup runs with `--non-interactive` (preferred) or `--yes`
(compatibility alias) and requires `--adapter <host>`. Neither spelling
invents or confirms missing human-controlled project-profile values: a fresh
non-interactive setup against an unconfirmed project map fails closed.

Note that `--yes` has a different, confirmation-oriented meaning on commands
such as `remove` and `worktree remove` (it authorizes a mutating action).
Convergence on one meaning is deferred to a later compatibility phase.

## Dry-run and JSON plans

`init --dry-run` and `setup --dry-run` execute the real planner and perform
zero writes — no `.gitignore`, guidance, config, manifest, state, directory,
or generated-shim changes. They succeed against readable, read-only targets.
Interactive setup dry-run may collect choices but never applies.

`--dry-run --json` is non-interactive. It succeeds only when an existing
confirmed profile or explicit flags provide every human-controlled decision.
Stdout contains exactly one stable, versioned JSON plan document
(`"schemaVersion": 1`) with normalized `create`, `update`, `merge`, `remove`,
`skip`, and `blocked` actions; diagnostics go to stderr. A dry-run with
blockers exits `1` and includes the blockers; a malformed invocation exits
`2`. When target state changes between plan and apply, apply re-preflights
and fails safely instead of applying a stale assumption.

Init's activation-guidance mutation is part of the plan, so `init --dry-run`
(human and JSON) shows the exact `AGENTS.md` guidance action normal init
would apply, and normal init performs no mutation absent from its plan.
`--no-agents-guidance` (or `--agents-guidance off`) excludes the action from
the plan.

## Plan application and failure semantics

Setup and init apply one preflighted lifecycle plan built from ordered
segments (scaffold batches, merge executors such as guidance, and adapter
generation). The contract is **per-segment, fail-stop, and
rerun-repairable** — not globally atomic:

- The complete plan is preflighted before the first mutation (blockers,
  adapter collisions, and stale-plan drift all fail closed up front). Legacy
  renames fingerprint both their source and destination.
- Each built-in segment is atomic: a failed segment is rolled back internally
  and its pre-state is restored (file bytes are restored exactly, stale empty
  directories are recreated, and only transaction-created directories are
  removed).
- Execution stops at the first failed segment; no later segment runs.
- Previously committed segments are **not** globally rolled back. The target
  is left in a consistent partial state that is repaired by rerunning
  `agenticloop setup` or `agenticloop init`, which recomputes an idempotent
  plan over the partial state (a clean rerun plans zero mutations).
- Failures identify the committed segments, the failed segment, whether
  partial application occurred, the primary errors, and any rollback errors
  inside the failed segment. If an executor cannot confirm its rollback, the
  diagnostic says so explicitly and asks the user to inspect the target
  instead of claiming that the segment was restored.

## stdout and stderr

- Human results go to stdout; warnings and errors go to stderr.
- In JSON mode, stdout contains exactly one machine-readable document;
  prompts and progress are disabled and diagnostics use stderr.
- Default setup/init output reports step and mutation summaries. Individual
  planned/applied paths and detailed detection evidence require `--verbose`.

## GitHub review audit

Use `agenticloop github-review-audit --pr <number>` to validate the current
artifact-bound review outcome for a pull request. Add
`--expect-status needs_revision` when validating a revision request instead of
acceptance. For a dispatched review, add
`--expect-artifact <complete-git-object-identity>` to require that both the PR
head and review marker still match the dispatched artifact. If a local review
checkout is supplied, add `--workspace <path>` as well; it requires
`--expect-artifact` and rejects a workspace whose Git HEAD does not match that
exact identity.

Every identity on this path uses the one canonical complete Git object identity
rule: a lowercase 40-character SHA-1 or 64-character SHA-256 object id.
Abbreviated and uppercase identities are rejected, and a single
repository-bound claim - PR head, workspace head, expected artifact, review
marker artifact, commit inventory, and Maintainer fixup base/result artifacts -
must use one object format throughout.

The audit also binds versioned marker attribution to its authenticated source:
`AGENT_REVIEW_ACTOR_ACCOUNT` must equal the authenticated GitHub login that
published the carrier (compared case-insensitively, preserved verbatim), and
`[[agent: maintainer]]` must be the final live nonblank line of the carrier.

## Review preparation lifecycle

Use this read-only lifecycle for GitHub-backed work:

```text
pr-body scaffold/lint -> github-preflight -> github-review-prepare
-> Maintainer review -> github-review-audit -> github-ready
```

`pr-body scaffold --pr <n> [--output <path>] [--snapshot-output <path>]` reads
current GitHub state read-only and renders a deliberately incomplete local
body. Run it only after the final implementation push and required checks: the
captured head and context are exact, and a later push invalidates the authoring
packet (rerun the checks and re-scaffold/revalidate rather than refreshing
markers). Both outputs are written atomically and missing parent directories
are created. Exit 0 means the scaffold was generated successfully; the result
is `generated: true` with `lintReady: false` and `gatePassed: false`, so it is
never reported as publication-ready. Output reports both written paths and the
exact next lint command.

Replace every `REPLACE` field in the Markdown draft, then lint the local body
before publishing through one of three mutually exclusive modes:

- Live (primary): `pr-body lint --pr <n> --body-file <path>` loads the same
  live read-only context as preflight, replaces only the in-memory candidate
  body with the local file, injects the live task/decision reference resolvers,
  and never writes GitHub.
- Offline: `pr-body lint --snapshot <path> --body-file <path>` performs zero
  network access against a CLI-authored
  `agenticloop.pr-body-context` snapshot (`snapshotSchemaVersion: 1`, capture
  time, repository, PR, issue, head, base, fixed review mode, the complete
  nested preparation input, and materialized task/decision reference
  inventories). Snapshot kind, version, provenance, and internal identity are
  validated; the nested remote `prData.body` is context-only and is always
  replaced by `--body-file`. Snapshot success is bound to the complete captured
  context, not to later live state.
- Compatibility (deprecated): `pr-body lint --input <evaluation-input.json>`
  retains its serialized preparation-input JSON semantics, emits a deprecation
  diagnostic in human output, `warnings`, and `warningDiagnostics`, and rejects
  Markdown with a targeted Engineer-owned error. It never checks live state and
  cannot be combined with `--pr`, `--snapshot`, `--body-file`, `--issue`, or
  `--repo`. The live-only `--issue` and `--repo` options are also rejected with
  `--snapshot`.

Live and snapshot lint fix evaluation `mode: review` and share the same
evaluator, so equivalent context and body produce equivalent results. Lint
rejects an incomplete input category instead of silently skipping evidence,
history, attribution, status, base-tree, or reference checks, and incomplete
context is reported as `inputComplete: false` with `gateEvaluated: false`
rather than as a failed semantic gate. Lint is structural, not a placeholder
grep: it validates the required sections, the exact current-head marker and
implementation artifact, every required check with an allowed kind/source and a
final verdict, substantive structured observation evidence, current resolution
entries, and the final Engineer attribution. Results report `contextMode`
(`live`, `snapshot`, or `legacy`), repository/PR/issue/head/base provenance,
`inputComplete`, `bodyLintEvaluated`, `gateEvaluated`, `lintReady`,
  `gatePassed`, and `publicationReady`, plus merged errors, warnings,
  diagnostics, error-only failure categories, owner routing, first safe repair,
  and an exact repair-aligned PR-body-scoped `nextCommand` when one is
  mechanically known. Conflicting or missing mode options exit `2`; missing
  files, malformed JSON, wrong snapshot kind/version, provenance mismatches,
  incomplete input, stale evidence, and failed lint/gates exit `1`; a
  publication-ready lint exits `0`.

After a publication-ready lint, publish explicitly (for example
`gh pr edit <n> --body-file <path>`), then run live `github-preflight` and
`github-review-prepare`. `github-review-prepare` evaluates published live
state; it is never the unpublished-draft linter.

Required-check task policy is validated before either PR-body or status-check
satisfaction. Invalid kinds or sources, command proofs without an exact
backticked command, status-check satisfaction for a non-command proof, and
status-check-only observation contracts are routed to the Maintainer.

The `scaffolded` field reports canonical scaffold shape/provenance (including
the distinctive Changed Paths section); it does not mean the body remains
incomplete. Use `lintReady` and `publicationReady` for readiness.

`github-preflight` remains the low-level live evidence gate. Run
`github-review-prepare --pr <n>` only after it passes. Preparation emits a
schema-v3 Maintainer packet only when `result.ok === true` for one final complete
snapshot. The packet requires a closed, digest-bound review-entry receipt for
that task, contract, checks, review history, attribution, workspace, and exact
head, plus an exact immutable read-only lease and whole-packet digest; a
matching head never overrides a failed result. Failed preparation emits
a typed resume packet routed to the capability-derived diagnostic owner and does
not invoke a reviewer. Any bound input change invalidates the packet.

`github-review-audit` is post-review provenance validation. `github-ready` is
the post-acceptance, pre-merge composite and reuses the same preflight evaluator.

Packet checking has two distinct levels, and only one of them proves current
repository state:

- **Structural and digest validation** proves the packet is a complete
  closed-schema packet whose embedded review-entry receipt is a complete
  digest-consistent
  schema-v3 receipt with a valid `agenticloop.review-entry-receipt.v3` digest,
  and that no duplicated outer field contradicts that receipt: PR, task, exact
  head, task-contract digest and baseline, review mode,
  `independentReviewRequired`, required-check count, evidence-match count,
  current finding IDs derived from the receipt's durable review history, and the
  workspace head when a workspace is present. It performs no refetch, so it does
  **not** prove the packet is current. A fabricated receipt that only echoes a
  matching head and task is rejected here.
- **Current-state verification** with
  `github-review-prepare --pr <n> --packet <path>` is the authoritative
  pre-dispatch consumer. It applies the structural check, refetches the complete
  current PR/task state, re-evaluates preflight, revalidates the complete
  receipt against that state, compares the evaluated head with the current head,
  and rejects stale, missing, malformed, fabricated, and self-contradictory
  packets. When the packet records a workspace, this level also reruns Git
  identity verification at that exact path and rejects path or HEAD
  substitution. Only this level may claim current dispatch readiness.

Malformed JSON or an invalid packet schema fails locally without contacting
GitHub. Preparation
itself also evaluates workspace and independent-review policy from the final
snapshot then compares its evaluated head with the immediately refetched head,
so a head that moves during preparation yields only a stale-head diagnostic that
names both compared identities. None of
these commands posts, edits, requests review, accepts, merges, amends, pushes,
or force-pushes.

Every review-preparation gate supports `--json`. Normal, usage, loader, and operational
failures use a versioned envelope with diagnostics, categories, ownership, and a
first safe repair; human output is rendered from the same result.

## Activation and implementation dispatch

All five shipped generators (OpenCode, Claude Code, Codex, Copilot, and Cursor)
fill the shared activation slots with a stable adapter ID and the typed
capability `unsupported`. Their request text is model-visible and does not
establish a lossless parser-owned byte artifact. Generated activation surfaces
therefore contain no `$ARGUMENTS`, `$1`, or `$2` capture claims, never ask a
model to create capture JSON, and block before activation-bound task authoring.
No shipped configuration currently provides a supported live dispatch path.
This is an intentional fail-closed state, not successful live-host support.

An adapter with a future proven parser-owned capture producer may issue a verified
receipt to task creation:

```text
npx agenticloop task new "Title" --activation-input .agenticloop/tmp/activation-capture.json [--host-trust-store <expected-registered-path>]
```

The v2 receipt has a unique canonical capture ID, signed intended task ID,
canonical target repository, capture and expiry timestamps, closed adapter/key
identity, derived capability, and operator/normalized proof digests. The CLI
resolves the prospective task ID before validation and requires the signed ID
to match. Expired, future-dated, cross-task, cross-repository, tampered, and v1
supported captures fail before mutation. Caller-authored capability, integrity,
or payload JSON cannot authorize task creation. A verified task records both
`activation_input_digest` and `activation_capture_ref`.

A capture is freshness-bound, not single-use. The same exact capture may be
revalidated for its signed task and repository while its time window remains
current. It never authorizes another task, repository, or payload. Expiry does
not permit silent renewal or rebinding; a future supported host integration
must produce a fresh capture and activation-bound task.

The CLI derives the only permitted store path from the target's canonical real
path and the fixed per-user registry root
`~/.agenticloop/host-trust/`. The optional absolute `--host-trust-store` value
asserts that derived path; it cannot select an arbitrary external file. The
store is target-scoped registry metadata. A missing derived store safely yields
the shipped unsupported inventory; an existing malformed store remains an
error. A well-formed store that declares a `supported` capture or return
capability is typed negative/blocked unsupported-boundary evidence, not
malformed input: the public and delegated in-process CLI rejects every such
registry. Neither a callback, environment
value, CLI option, nor same-user writable filesystem path can promote one. A
future supported integration requires authenticated host-controlled IPC, OS
isolation, or an equivalent boundary outside the delegated process. A
repository-local
`.agenticloop/host-trust.json` is ordinary untrusted data and cannot authorize a
capture, packet, or return.

For ordinary non-activated Markdown scaffolding only, use `task new <title>
--scaffold`. This route creates no verified activation binding and cannot
authorize Agentic Loop dispatch in that state. The toolkit does not claim a
durable non-upgrade property. Unless a separately authorized binding conversion
is implemented, create a fresh activation-bound task when implementation
handoff is required.

New task contracts declare required checks with stable identities and explicit
kinds:

```text
- [RC-1] command: `npm test`
- [RC-2] manual: Inspect the generated adapter output.
```

The `## Required Checks` section is machine-parsed: it may contain only blank
lines and canonical bullets. Any other prose is rejected rather than ignored.
Command returns carry the same ID/kind/command, evidence, outcome, and an
integer exit code. Manual returns carry the same ID/kind/instruction, evidence,
and outcome with `exitCode: null`. Matching is order-insensitive by RC ID.

Prepare one exact Engineer handoff without task mutation:

```text
npx agenticloop task prepare-dispatch T-001 --input .agenticloop/tmp/dispatch-input.json [--host-trust-store <expected-registered-path>] --json
```

The input supplies verified activation capture, selected role/worktree facts,
and only the source selectors from prior readiness/decomposition evidence.
Caller-authored readiness results and decomposition claims are ignored. The
command reruns readiness from the exact Git tree and dependency snapshot, reads
decomposition from its committed `sourceRef`, and requires the source commit to
carry canonical `Task:` and `Agent: maintainer` attribution before emitting a versioned
`agenticloop.role-preparation` packet only when every binding is current. The
current packet is schema version 4 and binds the selected host, the exact closed
Engineer capability declaration and digest, and the canonical derived
degraded-enforcement report inventory. The real shipped baseline was schema
version 2. Authentic version 2 packets, and authentic transitional version 3
packets, fail with typed `dispatch.packet.stale`; regenerate them as version 4
instead of repairing them in place. Merely setting an old version number on
malformed input does not classify it as a legacy packet. A missing, malformed, non-canonical, or
implementation-denying declaration fails before dispatch.
The
Engineer revalidates it with `task prepare-dispatch T-001 --packet <packet.json>
--role engineer [--host-trust-store <expected-registered-path>]` before
mutation. A scaffold made with `task new --scaffold` has no verified activation
identity and cannot dispatch in that state; use a fresh activation-bound task
unless a separately authorized conversion is implemented.

A raw return is checked with the exact repository evidence and an authenticated
host-adapter receipt:

```text
npx agenticloop task verify-return T-001 --packet packet.json --return role-return.json [--repository-evidence repository-evidence.json] [--producer-receipt producer-receipt.json] [--resume-owner <role-id> --redelegation-authority redelegation.json | --recovery-request recovery.json --human-disposition disposition.json --human-disposition-authority <authority-id> --human-disposition-key-id <key-id>] [--host-trust-store <expected-registered-path>] --json
```

The CLI never receives a signing secret. The operator registry contains only
Ed25519 public keys and scopes them to one canonical target checkout. A host or
OS policy must keep that fixed registry non-writable by agents; the CLI rejects
caller-selected alternative stores. The
receipt binds its target repository, adapter/key identity, invocation ID, packet,
return, host-observed producer role, liveness, and canonical repository evidence
digest. Receipt-controlled semantic fields are evaluated only after the pinned
key verifies the signature over canonical bytes. A forged `producerRole`
therefore yields generic authentication failure; an authentically signed wrong
producer yields `role_return.producer_mismatch`. After authentication, the
observed producer must match both packet assignment and return claim;
cooperative `Task:`/`Agent:` trailers cannot repair a mismatch. The files
verifier also reconstructs the current branch, head, changed paths, durable
commit range, and canonical attribution from Git and rejects dirty tracked or
untracked in-scope state. Missing, stale, or invalid authentication blocks
rather than trusting Orchestrator assertions. The shipped receipt baseline,
schema version 1, receives typed `role_return.receipt_stale` reissue guidance
only when its complete canonical bytes authenticate. A successful result uses
`disposition: proceed` plus a separate non-completion implementation outcome; it
is never review-entry evidence or completion.

For a blocked return, omitting `--resume-owner` retains the authenticated
producer role. A different owner requires `--redelegation-authority`; the
version 2 record must be signed by the exact pinned Orchestrator/human authority
and bind the current return, packet, producer, target owner, issuer, issue and
expiry times, and invalidators. Destructive, scope-changing, and host-state
recovery instead uses `--recovery-request` plus a version 2
`--human-disposition` signed by the pinned human authority, with the authority
and key selected explicitly by `--human-disposition-authority` and
`--human-disposition-key-id`. The import edge
validates these records before persistence, repair, transition, or host-state
change and preserves human attribution. Labels, trailers, producer strings,
record digests, or public keys carried by a record cannot grant authority.

The ordinary CLI still refuses a trust store with supported dynamic adapters.
A supported host integration reaches verification only through the protected
in-process host-authority seam, which approves the exact target, derived trust
path, and supported adapter IDs after authenticating its own host-controlled
capture/receipt boundary. No public flag enables that seam. Use
`scripts/sign-blocked-authority.mjs` to create signed redelegation or human
disposition records with the canonical serializers; the request shapes and
safe key-handling procedure are documented in
[Host Adapters](./host-adapters.md#constructing-signed-blocked-authority-records).

The packet also carries the canonical version 3 degraded-enforcement report set.
`prepare-dispatch` emits `capability.enforcement.degraded` warnings through the
repair policy, and `verify-return` performs the canonical
packet/report/declaration check at the receive edge. A duplicate
post-validation report branch is not counted as another enforcement layer.
Malformed, contradictory, or declaration-drifted reports fail closed. The
report names the deterministic recovery route. This is an
Agentic Loop evidence boundary, not a claim that arbitrary external writes are
prevented.

See [Host Adapters](./host-adapters.md#operator-trust-stores) for the external
store format, key rotation, and failure behavior. Every shipped adapter remains
unsupported for activation capture and cannot be upgraded by this option.

## Task-body editing and attribution

For a GitHub task record, use the closed loop below instead of editing an issue
body inline:

```text
npx agenticloop task-body fetch --issue <n> --output .agenticloop/tmp/issue-<n>.md
npx agenticloop task-body lint --issue <n> --body-file .agenticloop/tmp/issue-<n>.md
npx agenticloop task-body apply --issue <n> --body-file .agenticloop/tmp/issue-<n>.md --expect-digest <digest> --dry-run
npx agenticloop task-body apply --issue <n> --body-file .agenticloop/tmp/issue-<n>.md --expect-digest <digest> --yes
```

Routine edits avoid a whole-body rewrite:

```text
npx agenticloop task-body set-field --issue <n> --field review_budget --value 3 --expect-digest <digest> --dry-run
npx agenticloop task-body transition --issue <n> --status agent-ready --expect-digest <digest> --base <base-ref> --dependencies <dependency-snapshot.json> --dry-run
npx agenticloop task-body establish-baseline --issue <n> --expect-digest <digest> --authority <ref> --actor <login> --dry-run
npx agenticloop task-body authorize-correction --issue <n> --body-file <candidate.md> --expect-digest <digest> --reason <text> --authority <ref> --actor <login> --dry-run
```

Repeat any dry run with `--yes` only after inspecting its patch plan. The first
two commands make one bounded body change through the same lint/refetch/expected
digest transaction. Agent-ready additionally binds the explicit base and
dependency snapshot into its receipt; neither can be defaulted. The latter two
create and refetch a separate verified task-contract record carrier; body
markers are only caches. An `agent-ready` transition fails closed without a base
tree inventory.

The transition gates belong to the write, not to the `transition` subcommand.
Whenever a candidate's `status` differs from the fetched remote status — through
`transition`, through `set-field --field status`, or through an `apply` whose
body-file carries a different status — the same contract applies: the change must
be a legal transition, `agent-ready` requires the explicit base and dependency
snapshot, and `closed` must pass the terminal-scope decision. There is no
subcommand that reaches a protected status change unguarded. `set-field` and
`apply` therefore accept `--dependencies` whenever their candidate becomes
`agent-ready`. They also accept `--note` for a real status change. A note is
rejected for a non-status update rather than silently discarded.

A transition may also reconcile the projections it owns. `--note <text>` is
persisted as an identified issue comment rather than accepted and discarded, and repeated
`--label <name>` values are reconciled after a verified body write: every
requested label is added, superseded labels inside the owned `status:` namespace
are removed, and every unrelated label is left untouched. GitHub provides no
cross-resource transaction, so a body success with a failed label or comment
step returns an exact partial receipt whose per-projection `owned`, `attempted`,
and `complete` facts let a rerun resume only the remaining projections without
rewriting the body. The comment identity is a deterministic marker over the
repository/issue, predecessor and candidate digests, and normalized note. The
comment is complete only after an exact-body refetch from the authenticated
publisher and a trusted actor/association. A copied marker, foreign author, or
altered note body is not proof. An ambiguous post that landed is therefore
recovered without a duplicate, while an untrusted pre-seeded marker cannot
suppress publication. A genuine body no-op never invents a historical
transition comment.

Resume is provenance-typed. When the remote body already equals the candidate,
the result distinguishes a genuinely current no-op (expected, candidate, and
current all agree), a receipt-proven prior write, an ambiguous transport response
recovered from that same operation evidence, and an unattributed matching
external write. The last is never reported as proven publication: it returns a
non-authoritative result requiring refetch and reconciliation.

An ambiguous transport response whose refetch proves the candidate was not
applied returns an `uncommitted` mutation receipt with no changed paths and an
explicit recovery instruction. The attempted write is therefore represented by
the same receipt contract as successful, partial, and resumed outcomes.

A receipt-proven prior write requires a retained recovery artifact whose recorded
outcome is `applied` — written after a refetch observed the candidate bytes on
the carrier, and bound to that artifact's own operation id. The artifact files
alone are not enough: they are written before the transport call, so an operation
whose refetch confirmed the write did not apply leaves them behind too. Such an
artifact stays `not_applied` and never attributes a later matching body to this
toolkit. An operation that ends before its refetch stays `attempted` and proves
nothing either, and an outcome marker that is malformed or names a different
operation reads as no proof at all. Outcome markers use schema version 1 and
the closed field set `kind`, `schemaVersion`, `operationId`, `outcome`, and
`observedAt`; a missing, extra, mistyped, or invalid field is malformed.

`fetch` preserves a live leading BOM exactly and writes a separately labelled
sanitized candidate. `apply` refuses the BOM-bearing candidate, stale remote
bodies, and post-write digest/contract mismatches. It reports a unified diff and
structured change summary. Recovery paths are unique; verified success retains
them by default and failure retains them for evidence. Do not delete recovery
artifacts until their reported policy permits it.

`task-body lint` fetches the live issue body and comments by default so it can
validate lifecycle transitions and trusted carriers. `--offline` explicitly
reports unavailable live provenance; optional `--trusted-records <snapshot>`
must contain validated carrier data and never claims live verification. The
offline JSON envelope reports `contextMode: "offline"`, `lintValid`,
`graphConsistent`, `provenanceVerified: false`, and `publicationReady: false`;
the exit status reflects lint validity only, and offline lint never satisfies
an authority-dependent readiness or publication gate.

GitHub task-contract trust is configured in `.agenticloop/project.md` with
`trusted_task_contract_actors` (see `agenticloop/backends/github.md`). The
deprecated `github_trusted_actors` alias is honored with a warning.

Files-backed current tasks use `task_contract_schema: 2`. Run
`task establish-baseline <id> --actor <git-author> --authority <kind:reference>`
and commit the task history artifact separately before moving to `agent-ready`.
A material contract change after the baseline uses
`task authorize-correction <id> --expect-prior-digest <digest> --reason <text>
--authority <kind:reference> --actor <git-author>`, also committed separately.
Files history is verified append-only against first-parent Git history with
per-record commit provenance (see `agenticloop/backends/files.md`).

Every supported task mutation returns a versioned
`agenticloop.task-mutation-receipt` that binds the task identity, the expected
predecessor digest, the candidate and resulting digests, the exact evidence
context and its derived digest, the verification-result identity, owned
projections with their attempted and verified-complete state, changed paths, the
mutation disposition, rollback facts when compensation was proven, and one copyable
read-only revalidation command. A command is receipt-safe only when its exact
canonical registry leaf is explicitly marked for revalidation; all unmarked,
dynamic, unknown, or option-dependent forms fail closed. `init` and `setup`
qualify only with `--dry-run`. A `rolled_back` receipt additionally requires
closed rollback evidence whose predecessor and resulting digests exactly match
the receipt, with zero changed paths. Obtain a files task's current digest from
`task lint <id> --json`, then pass it to status:

```text
npx agenticloop task status T-001 in-progress --expect-digest sha256:<digest>
```

`--expect-digest` is required for every task-status transition, including
records with no `task_contract_schema`. An `agent-ready` transition additionally
requires exactly one of `--base <ref>` or `--base-paths <inventory.json>`, plus
`--dependencies <snapshot.json>`. Supplying both base forms is refused. The CLI
never selects `HEAD`, a default branch, or a dependency disposition on the
author's behalf, and it resolves `--base <ref>` to that ref's exact Git tree
object id so a later branch move cannot redefine the recorded baseline.

The dependency snapshot is a validated document, not a bare status map:

```json
{
  "kind": "agenticloop.dependency-snapshot",
  "schemaVersion": 1,
  "source": "files:.agenticloop/tasks",
  "observedAt": "2026-07-29T10:00:00.000Z",
  "freshnessPolicy": { "maxAgeSeconds": 86400 },
  "statuses": { "T-002": "accepted" }
}
```

An explicit empty `"statuses": {}` is a positive declaration that the task has
no dependencies and evaluates as satisfied. It is not equivalent to omitting
the dependency snapshot: every guarded `agent-ready` mutation still requires
the versioned snapshot, source identity, observation time, and freshness policy.

Missing, malformed, stale, and changed evidence stay distinct: a snapshot older
than its own freshness policy is `stale`, an unparseable one is `malformed`, an
absent one is `missing`, and a superseded `--expect-digest` is `changed`.

Receipt revalidation is read-only and executable verbatim from the target
directory. A readiness transition emits a `task-readiness` command carrying the
resulting digest and the exact base and dependency inputs; a non-readiness
transition emits the lint verifier bound to the resulting digest:

Arguments that need quoting are emitted only when one double-quoted spelling is
both inert and byte-exact in POSIX shells, PowerShell, and `cmd.exe`. Values with
quotes, backticks, dollar/percent/exclamation expansion, a trailing backslash,
doubled backslashes, CR, LF, or a backslash-newline pair are refused rather than emitted.
An otherwise-safe value containing one interior backslash is double quoted
because an unquoted POSIX shell would consume the backslash as an escape.

```text
npx agenticloop task-readiness --task-body <carrier> --mode authoring --expect-task-digest sha256:<digest> --base <tree-oid> --dependencies <snapshot.json>
npx agenticloop task lint T-001 --expect-task-digest sha256:<digest>
npx agenticloop task-body lint --issue <n> --expect-task-digest sha256:<digest>
```

The rendered command is presentation only; receipt validation parses its
restricted inert argv, unwraps supported `agenticloop`, `.cmd`, local-bin,
`node bin/agenticloop.js`, `npx`, and `pnpm exec` launchers, and rejects a
recognized mutation regardless of launcher spelling.

`task-readiness --expect-task-digest` also re-evaluates the trusted
task-contract chain, so revalidating an already-`agent-ready` task is never
confirmed on scope and dependency facts alone. A later verifier run without the
exact base and dependency inputs reports missing context; it must not treat the
committed record as invalid or compensate by rolling it back.

The read-only command emits `agenticloop.task-readiness-evidence`, a separately
validated summary that may record `dependencies: null`. It does not claim the
mutation-only `agenticloop.task-evidence-context` kind because a read-only
evaluation has no authoritative predecessor-to-successor transition. Guarded
mutations continue to carry the complete mutation evidence context in their
receipts.

Generic `accepted -> closed` is allowed only when the canonical terminal-scope
resolver proves `none`. Configured group scope, explicit durable task-set scope,
and indeterminate scope refuse generic closure. Explicit scope is derived from
any of three durable carriers: a typed human-selection receipt under
`.agenticloop/scope/*.json`, a current validated audit record, or a provenanced
closeout marker on the task carrier. Carrier freshness is deliberately distinct:
human selection uses `observedAt` and its `maxAgeSeconds`; a closeout marker uses
the supersession-resolved current marker plus the current carrier digest; an audit
record uses its exact current validated durable record and its bound
artifact/candidate and covered-task facts. Audit records do not claim a separate
wall-clock expiry. Conflicting, stale, malformed, or incomplete evidence is
`indeterminate` and blocks every terminal action until it is repaired and
re-derived.

Audit-due diagnostics preserve the same uncertainty. If the task inventory is
unreadable or invalid, `doctor` reports an indeterminate audit scope with the
inventory reason; it never turns that failure into an empty "nothing due" list.

A typed human-selection receipt looks like:

```json
{
  "kind": "agenticloop.human-scope-selection",
  "schemaVersion": 1,
  "workUnit": "selection:owner-1",
  "tasks": ["T-001", "T-002"],
  "authority": "human: repository owner",
  "reason": "Owner selected this terminal scope.",
  "observedAt": "2026-07-29T10:00:00.000Z",
  "freshnessPolicy": { "maxAgeSeconds": 86400 }
}
```

The terminal transition for an established scope is closeout-owned. After
`closeout record` publishes a completion-eligible marker, it transitions the
exact covered task set from `accepted` to `closed`: the files backend uses one
guarded filesystem transaction, and GitHub uses guarded per-carrier transitions
that report partial external progress rather than claiming cross-resource
atomicity. A safe rerun resumes from already verified terminal steps.

Publishing the marker is not the whole operation. A rerun that finds this exact
packet's marker already current resumes at the terminal transition instead of
reporting success, so a first run that published and then failed partway through
the covered transitions can be finished.

The rerun compares the canonical closeout provenance projection — the same
projection the packet digest is computed over, so it cannot omit a fact the
digest depends on. Marker publication changes nothing in it: carrier revisions
are computed with marker blocks normalized out, so a substantive carrier edit
after publication still fails closed as a stale packet. Only `predecessor_marker`
is exempted, and only when the live value is this packet's own digest — the
marker the operation provably published.

`init`, `setup`, and `update` emit and persist a prior-gate
`agenticloop.lifecycle-mutation-receipt` to
`.agenticloop/lifecycle-receipt.json`. It separates two facts a prior gate must
never conflate: `transactionDisposition` reports whether the filesystem
transaction completed, and `commitDisposition` reports whether those exact paths
are durably committed. A path written to disk but untracked is reported as
untracked, never as committed. `unresolved: true` whenever required setup state
remains uncommitted, untracked, partially applied, stale, or unverifiable, and
`task-readiness` refuses to build a readiness claim on an unresolved prior gate.
Both files and GitHub mutations also refuse to grant `agent-ready` under the
same condition; the check belongs to the authoritative handoff write, not only
to its read-only diagnostic.

The receipt is unauthenticated JSON in the working tree, so it is verified rather
than recognized on every read. Its schema version and every consumed field are
checked, and `unresolved` must follow from the two dispositions recorded beside
it. Each recorded path is then re-fingerprinted, and the commit disposition the
consumer reads is re-derived from current per-path Git state rather than read
back from the document.

Re-deriving is what makes the gate correct in both directions. Committing the
listed paths resolves it, exactly as the receipt's own next action offers. A path
that leaves the index — `git rm --cached` changes no bytes at all — un-resolves
it. Content that no longer matches what the transaction applied is reported as
drift and blocks the handoff. Editing the receipt to say `unresolved: false`
resolves nothing; changing the state it describes does.

Attribution rewrite records are read-only CLI surfaces:

```text
npx agenticloop commit-attribution repair-record-render --record repair.json --output record.json
npx agenticloop commit-attribution repair-record-lint --record record.json
```

They render and validate provenance only; they never amend, push, force-push,
or publish a record.

Before committing GitHub-backed work, use a message file and one contiguous
final trailer block:

```text
npx agenticloop commit-attribution check --task T-001 --message-file .agenticloop/tmp/T-001-commit-message.txt
git commit -F .agenticloop/tmp/T-001-commit-message.txt
npx agenticloop commit-attribution check --task T-001
```

Push only after both checks pass. Separate `git commit -m` paragraphs for
`Task:` and `Agent:` fail prospective validation.

## Workflow budgets

`task new` materializes `attempt_budget` from target
`default_attempt_budget`, then built-in `5`. A task-specific override is a
subsequent task-record edit made before work begins; `task new` has no budget
override option. The field is the hard limit for equivalent no-progress
attempts. The command also materializes `review_budget` from the target
project's `default_review_budget`, then the built-in `5`; this is a Review Round
Checkpoint threshold, not a review cap. `audit new --budget <n>` is an explicit override;
without it, the command materializes `default_audit_budget`, then the built-in
`3`. Existing task and audit records keep their stored values.

## Audit report and closeout

The Auditor emits exactly one `auditor_report_v1` JSON object described in
`agenticloop/agents/auditor.md`. Persist it without rewriting its findings:

```text
npx agenticloop audit report AUD-001 --file .agenticloop/tmp/AUD-001-run-1.json
Get-Content -Raw '.agenticloop/tmp/AUD-001-run-1.json' |
  npx agenticloop audit report AUD-001 --stdin
```

`--file`, `--stdin`, and legacy inline fields are mutually exclusive. The wire
format requires the closed producer `{ "roleId": "auditor" }`, all six
perspectives, and every finding field (`id`, `severity`,
`blocking`, `claim`, `evidenceRefs`, `consequence`, `requiredOutcome`, and
`verificationRequired`). Unknown fields fail rather than being dropped. A host
receipt is `verified` only when an available host verifier validates the exact
canonical digest of the complete normalized report, including producer,
invocation, artifact, covered tasks, verdict, findings, perspectives, evidence,
and assessment. A fresh authoritative Auditor return without that verification is
rejected and returned to Auditor without consuming budget. Legacy inline reports
remain explicitly `legacy_inline_v1`; they cannot certify a fresh Auditor return.
Visible and embedded report provenance must agree.

Each accepted audit report records a budget-consumption cause. Use
`--cause substantive_audit` (the default), `human_authorized_retry`, or
`other_plan_required`. `human_authorized_retry` additionally requires
`--consumption-authority "human:<identity>"` and `--consumption-reason <text>`;
`other_plan_required` requires a bounded `--consumption-plan <reference>` of at
most 200 characters. Declared product-invalidation recovery remains unavailable
and is refused before any budget is consumed; it requires the existing human
budget override. A rejected or malformed report never consumes budget.

`audit status` lists the cause of every consumed run in both human and `--json`
output, so an exhausted budget always carries provenance.

An audit history written before `Consumption cause` became required stays
parseable and has exactly one explicit, non-destructive migration route:

```text
npx agenticloop audit baseline <audit-id> --migrate-consumption-cause
```

It records `unrecorded_legacy` for each affected run, preserving every other
byte. That cause states honestly that the cause was never captured; it never
asserts a substantive audit and never invents human authority. The migration is
idempotent, fails closed on unrecognized live content, and cannot be combined
with `--canonicalize`, `--artifact`, `--covered-tasks`, or `--evidence`.

Audit baseline/report rewrites preserve recognized structure canonically and
fail before mutation when an unrecognized live section cannot be proven
lossless. JSON mutation results carry an exact before/after receipt and
post-write revalidation route.

Closeout is two-stage and packets are restricted to `.agenticloop/tmp/`:

```text
npx agenticloop closeout prepare --work-unit milestone:M00 \
  --artifact commit:<full-sha> --output .agenticloop/tmp/milestone-M00-closeout.json
npx agenticloop closeout record --packet .agenticloop/tmp/milestone-M00-closeout.json --dry-run
npx agenticloop closeout record --packet .agenticloop/tmp/milestone-M00-closeout.json --yes
```

`prepare` exit 0 means `completion_eligible: true`; exit 1 emits a truthful
non-complete or unevaluable packet. `status` exits 0 only for one current,
reconstructable `complete` marker. `record` exits 0 for a current applied or
idempotent marker, including a truthful non-complete correction and a
same-packet retry whose exact digest is already the one current marker.
Packets expose `publishable`, `completion_eligible`, `recommended_status`,
and structured reasons. Marker states are `complete`, `follow_up_required`,
`needs_context`, and `blocked`; corrections supersede exact prior references
without deleting history.

Plan synchronization is mechanical. When a selected source plan
(`documents.plan`) applies, an omitted `--plan-sync` never completes:
`--plan-sync not_required` is the explicit visible opt-out, and
`--plan-sync synced [--plan-ref <path>] [--plan-revision sha256:<hash>]`
verifies that the plan exists, that its task table covers the work items past
`planned`/`in-progress`, and binds the exact plan content revision into the
packet digest. Unrelated Markdown tables may precede the task table, but the
selected plan must resolve inside the target repository. A plan edit after
certification stales the packet and marker.

`--improvement-ref <id>` must name an existing, valid improvement proposal
(`improvement lint` clean) that relates to the work unit. Improvement
`--source-ref` values must resolve against live durable state: audit IDs and
runs, task IDs, decision IDs, closeout marker digests, or proposal IDs;
fabricated references fail before any file is created.

After certification only specifically validated workflow deltas survive: the
bound audit record, the exact marker mutation, a covered-task
`accepted -> closed` terminal transition, an append-only schema-valid
`task.closed` event whose task ID and `files` backend match the applicable
event-log path and whose event ID is unique, an exact valid referenced
proposal whose source references resolve against the same command-local live
state, and transient `.agenticloop/tmp/` activity. Everything else is product
drift. GitHub closeout additionally proves, per covered task, one merged PR
whose current aggregate review decision is approved, that closes the correct
issue, and that lands the certified candidate; historical approvals never
override a current change request. `github-ready` fails closed when the linked
issue is not the unique carrier of its task identity across open and closed
issues.

## Global diagnostics

`--debug` is a global flag accepted in flag position by every command. It prints
internal stack details for unexpected failures; normal output keeps those
details behind a stable debug reference. Set `AGENTICLOOP_DEBUG=1` for the same
behavior in automation. Do not publish debug output without reviewing it for
paths, environment details, or other sensitive operational context.

## Exit statuses

| Status | Meaning |
|---|---|
| `0` | Success, safe no-op, displayed help/version, or explicit cancellation before apply |
| `1` | Operational, configuration, generation, validation, or apply failure |
| `2` | Invalid command-line usage (unknown option/command, missing or invalid value) |
| `130` | User interruption propagated through the CLI cancellation contract |

Scripts may continue to treat any nonzero status as failure. Strict parsing
and the `1` → `2` usage-status split are deliberate compatibility changes;
see `CHANGELOG.md`.

## Verbosity, color, CI, and non-TTY behavior

- `--verbose` changes detail, never behavior.
- Color is semantic, optional, auto-detected, and respects `NO_COLOR`. Words
  and exit statuses remain authoritative; color never replaces them.
- Progress indicators appear only for genuinely slow operations and are
  disabled for non-TTY, CI, JSON, and redirected output.
- TTY, non-TTY, CI, and redirected output are all plain, grep-able text.

## Compatibility aliases and deprecations

| Form | Status |
|---|---|
| `setup --yes` | Retained compatibility alias for `setup --non-interactive` (preferred) |
| `upgrade` | Alias for `update` |
| `event` | Alias for `event-logging` |
| `init --opencode` | Alias for `init --adapter opencode` |
| `init --setup` | **Deprecated**; use `agenticloop setup --adapter <host>`. Behavior unchanged during the deprecation window |
| `pr-body lint --input <evaluation-input.json>` | **Deprecated** compatibility mode for complete serialized preparation input. Use `pr-body lint --pr <n> --body-file <path>` live or `pr-body lint --snapshot <path> --body-file <path>` offline; removal requires a separately approved breaking release |
| `init --update-assets` | Removed; use `agenticloop update` |
| `--no-agents-guidance` | Opt out of the activation-guidance block (literal option on init/setup) |

Strict-parsing compatibility changes (unknown options fail, Boolean flags do
not consume following tokens, command-local `-h` prints help, usage failures
exit `2`) are recorded in `CHANGELOG.md`.
