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
| `status` | Configured adapters, generated artifacts, next steps, or a closed lifecycle orientation snapshot with `--json` |
| `validate` | Validate skills, config, links, role-capability bindings, and host setup |
| `remove` | Remove Agentic Loop assets (`--dry-run` or `--yes` required) |
| `guidance` | Manage the activation-guidance block (`apply`, `check`, `remove`) |
| `generate` | Generate adapter artifacts (`opencode`, `codex`, `claude-code`, `copilot`, `cursor`, `all`) |
| `configure models` | Set per-host role model settings in `agenticloop.json` |
| `task` | Task records and lifecycle preparation (`list`, `lint`, `new`, `establish-baseline`, `authorize-correction`, `prepare-decomposition`, `prepare-dispatch`, `handoff-preflight`, `refresh-handoff-evidence`, `prepare-return`, `verify-return`, `check-evidence-init`, `check-evidence-show`, `check-evidence-update`, `evidence`, `review-prepare`, `status`) |
| `audit` | Work-unit audit certificates (`new`, `baseline`, `report`, `status`, `gate`, `lint`, `repair-structure`, `disposition`, `override`, `resolve`) |
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
| `commit-attribution check` | Read-only role-aware trailer check with repair guidance only |
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

## `status --json` lifecycle orientation

`npx agenticloop status --json [--target <dir>]` emits one deterministic,
read-only, closed lifecycle-orientation snapshot. It is an orientation and
dispatch recommendation, not a mutation, activation grant, or proof that a host
execution occurred. The current schema is
`agenticloop.lifecycle-orientation` version `2`; unknown, missing, or extra
fields make the snapshot invalid.

For an otherwise clean files target with no task records, the shape is:

```json
{
  "kind": "agenticloop.lifecycle-orientation",
  "schemaVersion": 2,
  "state": "no_work",
  "target": "<absolute target path>",
  "backend": "files",
  "roots": { "carrier": ".agenticloop/tasks", "artifact": ".", "working": "<path>" },
  "activationScope": {
    "source": ".agenticloop/activations", "state": "current", "scopes": [], "errors": []
  },
  "operatorAuthorizedSet": {
    "source": "canonical_activation_resolution", "state": "current", "bindings": [], "errors": []
  },
  "adapters": { "adapters": [], "nextSteps": [] },
  "candidates": [],
  "excluded": [],
  "tasks": [],
  "diagnostics": [],
  "legalNextAction": { "type": "no_action", "taskId": null, "command": null }
}
```

The complete closed schema is:

- Top-level fields are exactly `kind`, `schemaVersion`, `state`, `target`,
  `backend`, `roots`, `activationScope`, `operatorAuthorizedSet`, `adapters`,
  `candidates`, `excluded`, `tasks`, `diagnostics`, and `legalNextAction`.
  `state` is `incomplete`, `no_work`, `one_candidate`, or
  `multiple_candidates`; `backend` is `files` or `github`.
- `roots` is exactly `{ carrier, artifact, working }`. `carrier` is a nonempty
  string; `artifact` is a string or `null`; `working` is a nonempty string for
  the top-level root and may be `null` on a task root.
- Each `tasks` and `candidates` entry is exactly `{ taskId, carrier, status,
  state, reasons, baseline, lint, activationProvenance, operatorAuthorization,
  roots, dependencies }`. `taskId` and `status` are strings or `null`; `carrier`
  is nonempty; `state` is `current` or `incomplete`; `reasons` is a string array;
  and `dependencies` is an array of `{ id, disposition }` nonempty-string pairs.
  `baseline` is exactly `{ state, digest, trustedRecordCount, errors }` with
  state `current`, `invalid`, or `unavailable`, a string-or-null digest, a
  nonnegative safe-integer trusted-record count, and string-array errors.
  `lint` is exactly `{ state, rootDiagnostics, errors }` with the same state
  vocabulary and string arrays. `activationProvenance` is exactly `{ state,
  inputDigest, captureRef }` with state `declared` or `missing` and
  string-or-null input digest and capture reference.
- `operatorAuthorization` is exactly `{ state, bindingId, grantId, provenance,
  errors }`. Its state is one of `present`, `missing`, `malformed`, `expired`,
  `revoked`, `stale`, `mismatched`, or `unauthenticated`; identifiers are
  strings or `null`, and errors are strings. A non-null `provenance` is exactly
  `{ repositoryIdentity, assurance, issuedAt, expiresAt, source, derivation,
  scope }`, where all fields other than `scope` are nonempty strings, assurance
  is `operator_confirmed` or `host_signed`, source is `activation_grant`, and
  scope is exactly one of `{ type: "exact_tasks", taskIds, workUnitId: null,
  operatorIntentDigest: null }` with nonempty unique sorted task-id strings,
  `{ type: "work_unit", taskIds: null, workUnitId, operatorIntentDigest: null
  }` with a nonempty work-unit id, or `{ type: "captured_request", taskIds:
  null, workUnitId: null, operatorIntentDigest }` with a nonempty intent digest.
- `activationScope` is exactly `{ source, state, scopes, errors }`, with source
  `.agenticloop/activations`, state `current` or `invalid`, and sorted `scopes`
  entries exactly `{ grantId, repositoryIdentity, assurance, scope }`.
  `operatorAuthorizedSet` is exactly `{ source, state, bindings, errors }`,
  with source `canonical_activation_resolution`, state `current` or `invalid`,
  and task-sorted bindings exactly `{ taskId, bindingId, grantId,
  repositoryIdentity, assurance, issuedAt, expiresAt, provenance }`; their
  provenance is exactly `{ source, derivation, scope }` and must agree with the
  corresponding task authorization.
- `adapters` is exactly `{ adapters, nextSteps }`. Each adapter is exactly
  `{ host, status, enabled, required, present, missingModelRoles }`, where the
  first two fields are strings, the next two are booleans, and the final two are
  string arrays. `nextSteps` is a string array. `diagnostics` is a string array.
  `excluded` has one entry for every non-candidate task and each entry is exactly
  `{ taskId, carrier, reason }`, with a string-or-null task id and nonempty
  carrier and reason strings.
- `legalNextAction` is exactly `{ type, taskId, command }`. It is
  `repair_lifecycle_context` with no task id, `no_action` with no task id and a
  null command, `prepare_dispatch` with a task id and an Engineer-role command,
  or `select_task` with no task id. Every legal action other than `no_action`
  has a nonempty command. For example, one current authorized `agent-ready`
  task yields `prepare_dispatch` and a command shaped as `agenticloop task
  prepare-dispatch <task-id> --host <host> --role engineer`.

The assurance model is intentionally narrow. `activationScope.scopes` reports
the authenticated grant's declared breadth, while
`operatorAuthorizedSet.bindings` reports only current, exact task authorization
resolved through the canonical activation policy. A broad grant scope is never
itself dispatch authorization. `present` therefore requires a current,
authenticated binding for the exact repository, backend, task, carrier, and
contract digest under effective policy. The snapshot exposes provenance and
diagnostics so callers can repair context, but it does not promote raw store
records, adapter capability, a digest, or a status message into authority.

## Handoff preflight and derived refresh

Use `npx agenticloop task handoff-preflight <task-id> --json` for one read-only
pre-delegation verdict. It reports the task carrier and protected contract as
separate identities, lifecycle dispatchability, current activation
authorization, readiness and decomposition evidence, host capability,
return-adapter resolution, active worktree state, relevant sibling collisions,
the disposition owner, and one safe repair command. Add
`--repair-plan <target-relative-path>` to write a
bounded plan for derived evidence only. Add `--host <host>` to evaluate a
specific host adapter, `--return-adapter <id>` to select a return adapter, and
`--output <path>` to write the result to a file.

### One preflight is the complete list of blockers

Preflight holds one property, and it is the reason to run it at all:

> A preflight that passes over a set of facts cannot be refused by packet
> preparation, prepared-packet validation, or role start over those same
> unchanged facts.

Activation is the one exception the property permits: preflight may report a
green result whose only outstanding item is the external operator action. Every
other prerequisite is reported here or it is a defect.

The property is enforced the only way it can be — by evaluating the same
dimensions with the same authorities, then checking the pair of verdicts over a
matrix of single-dimension mutations. Concretely:

| Dimension | Shared authority |
| --- | --- |
| Lifecycle | `evaluateDispatchableLifecycle`, derived from the legal-transition table |
| Relevant clean state | `evaluateDispatchCleanState` |
| Trusted contract baseline | committed append-only history from `loadFilesTaskContractRecords` |
| Committed decomposition | `validateDecomposition` |
| Work-unit membership | `validateParallelScanInventoryBinding` over a freshly enumerated inventory |

A dirty relevant checkout is an **error**, not an advisory: preflight and
`prepare-dispatch` call the same clean-state evaluator, so reporting it as a
warning here while refusing it there produced a green preflight and a blocked
dispatch over identical facts. Transient output under `.agenticloop/tmp/` and
operator-owned state are excluded by that evaluator at both boundaries, so
scratch never self-blocks the next gate; durable uncommitted evidence still
fails closed and has to be committed by the Maintainer first.

Preflight is permitted to refuse *earlier* than a later boundary would. The
property is one-directional: it forbids the false green, not the early refusal.

The `lifecycle` field answers one question preflight, packet preparation, and
role start all have to agree on: may this task begin an execution attempt right
now? The rule is derived from the single legal-transition authority rather than
restated, so a task is dispatchable exactly when its status can legally reach
`in-progress` — `agent-ready`, `in-progress`, `needs_revision`, `blocked`, or
`needs_context`. A `draft` task is refused here, with the Maintainer-owned
`task status <id> agent-ready` repair, instead of reaching a role start and
failing there as an illegal transition. An absent or unrecognized status is
reported as missing or malformed evidence, never as a negative answer.

Every lifecycle repair is rendered from one structured plan rather than
assembled as a string at each refusal site, so preflight, packet preparation,
prepared-packet validation, and role start cannot print different advice for the
same fact. The plan names the read-only command that supplies the current digest
(`task lint <id> --json`), one primary command whose declared placeholders are
the only tokens to replace, and — where the choice is genuinely the operator's —
one identified alternative with the condition that selects it. `--base` and
`--base-paths` are mutually exclusive, so they are never offered inside a single
command. Statuses with no safe forward move receive a statement of what is true
and no command at all.

One asymmetry is deliberate and temporary: `task prepare-dispatch` currently
refuses only the statuses that have **not yet** reached an execution attempt.
The terminal statuses `accepted` and `closed` are refused by preflight but still
accepted by the packet constructor, so a caller that skips preflight can mint a
packet for finished work. Run `task handoff-preflight` before packet assembly.

Apply a plan explicitly with:

```text
npx agenticloop task refresh-handoff-evidence <task-id> --plan <path> --yes --json
```

The apply path is compare-before-write, atomic, and refetch-validated. Its write
surface is bounded to derived evidence under `.agenticloop/handoffs/derived-evidence/`,
the decomposition provenance under `.agenticloop/decompositions/`, and at most
one bound dependency snapshot — the exact path named by the decomposition's
`scan.readinessContext.dependencies.sourceRef`. It cannot change task contracts,
activation, human decisions, review dispositions, acceptance, closeout, or
product files. A durable Maintainer update is cooperative and must use the
emitted final trailer block; it does not authenticate the producer.

The dependency-observation category renews the observation *window*, not the
observation: it carries the Maintainer-recorded statuses forward unchanged and
re-stamps `observedAt`, resetting the `maxAgeSeconds` freshness window. It
verifies only that every declared dependency has a recorded status; it does not
re-observe dependency state, so the Maintainer remains responsible for those
statuses still being currently true.

#### Why the freshness window differs by backend

`task prepare-decomposition` chooses its default `maxAgeSeconds` by asking one
question: **can a dependency status change without producing an observable
repository event?**

| Backend | Default | Why |
| --- | --- | --- |
| `files` | 86,400s (the trusted maximum) | No. Dependency statuses are task records inside the repository, and the scan already binds inventory membership, each carrier digest, the protected contract, the base tree, and the dependency snapshot's provenance. A real change breaks a binding and is refused semantically at preflight and at dispatch, so the clock is only a backstop. |
| `github` | 3,600s | Yes. Issue state lives outside the repository and can change with no local event, so nothing local would notice. There the clock is the only mechanism and stays short. |

`--max-age-seconds` overrides either default, and a window an observation
already declared is part of that evidence: changing the default never
retroactively widens an existing observation.

The previous flat 3,600-second default applied the GitHub answer to both
backends. On a files route it measured how long the Engineer session took rather
than whether the evidence was stale, so any run over an hour expired before it
could produce a return — with nothing having changed.

The bound set is the status set for **declared** dependencies. A status recorded
for a task this one does not depend on is not a material change, and does not
invalidate readiness. Over-invalidation is a defect in the same way a false
green is.

`commit-attribution check` accepts `--role orchestrator|maintainer|engineer|auditor`.
The role is validated against the canonical registry and the final contiguous
`Task:`/`Agent:` trailer parser is shared with decomposition verification. The
`Agent:` trailer value must be the exact lowercase canonical `roleId` (the
immutable lowercase machine identity); capitalized spellings such as
`Agent: Engineer` are rejected as a wrong trailer. This is a deliberate
tightening over 0.4.1, which lowercased the trailer before comparing.

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
snapshot and a current verified Engineer return is bound to the exact durable
dispatch consumption. No return chain means no packet and no lifecycle-bearing
receipt. The packet requires a closed, digest-bound review-entry receipt for
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
  re-recognizes the current stored return against its consumed dispatch,
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
model to create capture JSON, and never grant activation from inside a session.
This is an intentional fail-closed state and it does not change.

### `agenticloop activate`

The universal, host-neutral activation path. No host plugin, no host
integration, and no change to any existing task:

```text
npx agenticloop activate T-016 T-017
npx agenticloop activate --work-unit phase:4
npx agenticloop activate T-016 --dry-run
```

The command prints the exact tasks, carriers, contract digests, repository, work
unit, and resulting assurance, then requires you to type `activate` to confirm.
It **refuses non-interactive invocation and refuses to run under CI**, and there
is deliberately no `--yes`: a flag that let an agent mint this grade silently
would erase the only thing separating it from an unsigned repository file.

Options: `--work-unit <id>` (mutually exclusive with explicit task ids),
`--expires-in-hours <n>` (default 12, maximum 168), `--repo <owner/name>` for
the GitHub backend, `--dry-run`, `--json`, `--target <dir>`.

Exit statuses: 0 on activation, dry run, or operator cancellation; 1 on refusal
or write failure; 2 on invalid usage.

Both backends are supported through their canonical identity and digest loaders.
Nothing rewrites a task body: task ids, frontmatter, history, and decomposition
state are preserved, so **existing tasks and projects never need recreation.**

A work-unit activation derives child bindings only from current committed
Maintainer-attributed decomposition evidence, and only for canonical ready-set
members. For existing tasks without suitable decomposition evidence, name the
task ids directly.

Records are written as one transaction under `.agenticloop/activations/`:
either the grant and every binding land, or none do and the versioned mutation
receipt says so. A failed multi-task activation therefore produces no partial
authority.

### Owner routing

Every typed failure returns to the role that owns the repair, and the routing is
*derived* rather than declared at each site: `REPAIR_POLICY` maps a diagnostic
code to a repair kind, and `agents/*.md` frontmatter binds each repair kind to
exactly one primary owner. Evaluators report facts and never name a role.

The boundary that matters in practice is that an Engineer cannot be handed
Maintainer-owned work from inside its own run. These categories always route to
the Maintainer: `task_contract` (lifecycle, baseline, record structure),
`task_identity`, `task_policy`, `path_intent` (scope and base inventory),
`generated_paths`, `parallel_scan` (decomposition and its inventory),
`review_checkpoint`, `review_provenance`, and `review_audit`.

Decomposition is in that list because `task prepare-decomposition` is
Maintainer-owned authoring and its committed source must carry Maintainer
attribution to be accepted — so an Engineer regenerating it inside its own run
could never produce a source that dispatch would take.

Two adjacent repair kinds read alike and are deliberately split:
`repair_attribution_trailer` is the Engineer fixing its own commit trailer;
`repair_task_attribution` is Maintainer-owned task-record provenance.

A second, independent layer backs this up: `ROLE_ALLOWED_ACTIONS` withholds the
`task_workflow_mutate` action class from the Engineer entirely, so even a
misrouted repair cannot be carried out. Human-authority escalations resolve to
the human boundary and never to an agent role.

### Historical adoption

```text
npx agenticloop task adopt-historical <task-id>   --artifact <commit> --integration <kind:reference> --integration-commit <commit>   --audit <kind:reference> --authority <kind:reference> --reason <text>   --missing <class> [--missing <class>...] [--json]
```

Some accepted, integrated, auditable work predates dispatch packets and verified
returns. It cannot satisfy normal closeout, and there are only three ways to
respond: re-waive the missing evidence (which devalues normal closeout for every
task), synthesize it (which is the one thing the evidence model exists to
prevent), or give that work its own terminal result that says exactly what it
is. This is the third.

**An adoption is not a closeout.** It reaches `historical_adoption_accepted`
with assurance `historical_reduced` — a status distinct from every canonical
lifecycle status, and a grade below every canonical one — so a reader can tell
the difference without consulting a second record. Files and GitHub project the
identical verdict, including `canonicalClosure: false`.

It requires, in place of the evidence it lacks:

| Input | Why |
| --- | --- |
| the exact **current** task contract | the thing adopted is the thing on disk now |
| `--artifact` | an accepted implementation commit, as a real Git object |
| `--integration` / `--integration-commit` | proof the artifact actually landed |
| `--audit` | an independent audit naming that exact artifact |
| `--authority` / `--reason` | reduced assurance is a decision a person makes |
| `--missing` | every evidence class this task genuinely lacks |

`--missing` accepts only recognized classes — `dispatch_packet`,
`dispatch_consumption`, `carrier_mutation_lineage`, `verified_return`,
`host_return_receipt`, `activation_grant` — and at least one is required: a task
missing nothing belongs in normal closeout. The record has nowhere to put a
packet, consumption, return, receipt, or activation, so none can be smuggled in,
and a task that already has dispatch consumption evidence is refused outright
rather than downgraded.

Normal closeout is unchanged for every task that entered the canonical
lifecycle.

### Execution attempts and packet conservation

```text
npx agenticloop task attempt-status <task-id> [--json]
npx agenticloop task abandon-attempt <task-id> --attempt <attempt-id> --reason <text> --authority <kind:reference> [--json]
```

A dispatch packet is not a ticket that can be reissued. It is the evidence that
one execution attempt started from one product base, and once an Engineer has
mutated anything under it, that packet is the only thing that can still explain
what the mutation was relative to.

So a consumed packet **reaches a canonical return or is explicitly abandoned**.
`task prepare-dispatch` applies the rule before minting a new packet:

| State | New packet |
| --- | --- |
| No attempt has been consumed | permitted |
| A live attempt exists and has recorded no Engineer mutation | permitted — nothing was built against the old base |
| A live attempt exists and has recorded Engineer mutations | **refused** |
| The previous attempt was explicitly abandoned | permitted, with the abandoned attempt still on record |

Re-validating an existing packet with `task prepare-dispatch <id> --packet
<path>` is never refused by this rule: that is how a live attempt proves itself.

The attempt identity is derived from the consumption that started it — its
packet, invocation, and product base — rather than minted alongside it, so it
cannot drift from the evidence it names. Two consumptions that share a packet id
but not a product base are **not** the same attempt, which is exactly why a
packet minted after product work can never be read as proof of the original
base.

`attempt-status` lists every attempt with its packet, product base, consumption
instant, state, and — for abandoned attempts — the stated reason and authority.
It exits non-zero when a new packet is not permitted.

`abandon-attempt` is the explicit escape, and the refusal names it verbatim. It
requires a stated `--reason` and a durable `--authority` reference: discarding
execution evidence is an operator decision, so it is recorded as one. It refuses
an attempt that is not recorded or is already closed, and it never deletes the
abandoned attempt or its evidence.

Unreadable consumption, abandonment, or carrier-mutation evidence fails closed.
"I cannot read this abandonment" is never treated as "there is no abandonment",
because that direction silently re-enables the reminting the rule prevents.

### `agenticloop activation`

```text
npx agenticloop activation status [<task-id>] [--json]
npx agenticloop activation revoke <grant-id> [--reason <text>] [--json]
npx agenticloop activation provision-key [--json]
npx agenticloop activation identity-status [--json]
npx agenticloop activation migrate-identity [--json]
```

`status` reports every stored binding, whether it is still usable against
current task state, and the effective policy with its source. `revoke` creates
an externally authoritative repository-specific create-only tombstone; every binding derived from that grant is then refused
by dispatch. `provision-key` creates the external operator confirmation key
explicitly; `activate` provisions it lazily, so running it separately is
optional.

#### Repository authority identity and migration

Operator activation keys and external revocation tombstones live outside the
target repository, addressed by a digest of the target's **repository authority
identity**. That derivation is versioned, because changing it relocates every
existing record:

| Version | Derivation |
| --- | --- |
| v1 | `file:` plus the host's resolved path, separators normalized, host letter case preserved |
| v2 (current) | v1 plus Windows case folding, so `C:\Apps\Repo` and `c:\apps\repo` are one identity |

On POSIX the two versions agree and nothing below applies.

`identity-status` is read-only. It reports the current identity and digest, the
state of the current operator key, and every superseded spelling that still
holds operator state:

```text
npx agenticloop activation identity-status
Repository authority identity v2: file:c:/apps/example
  digest:            2f1c...e90a
  operator key:      missing
  disposition:       migration_available
  superseded:        file:C:/apps/example [key present, 2 revocation(s)]
    digest:          9b74...31cd
    revocations:     C:\Users\you\.agenticloop\operator-activation\revocations\9b74...31cd
```

Both output modes report the digest of every identity, current and superseded,
because that digest is the directory name the manual revocation repair below
needs. `--json` adds `digest` and `revocationDirectory` to each entry of
`supersededIdentities`.

`migrate-identity` copies exactly one superseded operator key forward, verifies
that the copy loads as this repository's key, and writes a receipt under
`~/.agenticloop/operator-activation/migrations/`. Superseded key files and
revocation tombstones are **preserved, never deleted**, and rerunning the
command is a no-op.

A successful migration reports the state it **produced**, not the state it read:
`currentKeyState` becomes `present` and `currentKeyId` names the migrated key.
The replaced state is still reported, under `priorKeyState` and `priorKeyId`,
alongside `migratedFrom`. A rerun reports `already_migrated` with the same
current key.

Revocation tombstones need no migration at all: external deny evidence is always
read as the fail-closed union of the current and superseded registries, so a
revoked grant stays revoked whether or not a migration was ever run.

Any unreadable record, or any non-`.json` entry, in **any** of those registries
fails the whole read closed for that repository, which blocks activation until
it is resolved. `migrate-identity` deliberately does not touch revocations, so
the repair is to inspect
`~/.agenticloop/operator-activation/revocations/<identity-digest>/` directly.
`identity-status` reports each superseded identity's digest and tombstone count
so the affected directory can be located.

When more than one superseded key claims the same repository, both commands
report `conflict` and refuse. Choosing which operator identity survives is an
operator decision, so nothing is written; remove or rename the keys you do not
want to keep and rerun.

`activate` and `provision-key` refuse to mint a fresh identity while superseded
operator material exists, and name `migrate-identity` as the repair. Silently
provisioning there would look like ordinary first-time setup while orphaning the
operator's real key and every deny tombstone bound to it.

#### Activation refusals offer every scope you have

Every activation refusal renders from one shared plan, so the same facts never
produce different advice at different boundaries. It offers, in order:

1. the exact task — `npx agenticloop activate <task-id>`;
2. the current ready set as **one** confirmation, when there is more than one
   ready task — `npx agenticloop activate T-018 T-019 T-020`;
3. the canonical work unit, when a durable one is bound —
   `npx agenticloop activate --work-unit milestone:M2`.

A "batch" of one is not offered, and a synthesized `work-unit:<task-id>`
fallback is never offered as a work unit: it is identical in effect to the
exact-task command while implying broader coverage.

Surfacing the batch options reduces how often a human is interrupted. It never
reduces what a human has to see: every command is the interactive operator path,
there is no `--yes`, and a task-list or work-unit authorization covers exactly
the scope bound at confirmation — tasks added afterwards need a new one.

#### Expiry is not retroactive

Expiry means *this authority may not start new work*. It has never meant *the
work it already started never happened*.

- A grant that has expired cannot authorize a new dispatch.
- Closeout evaluates the grant as of the **consumption instant** when a packet
  was consumed for the task, so an execution that outlives its window does not
  retroactively lose the authority it had when it began. The reported
  `evaluatedAt` states which instant was used.
- **Revocation is not expiry.** It is matched by grant identity and is
  time-independent, so a revoked grant still fails at the consumption instant.
- Pinning to a past instant can only narrow: a grant issued after an attempt
  started does not retroactively authorize it.

### Assurance grades

| Dimension | Grade | Meaning |
| --- | --- | --- |
| Activation | `host_signed` | Parser/host-owned capture authenticated by an isolated signer. |
| Activation | `operator_confirmed` | Explicit local operator confirmation of exact task state. |
| Return | `host_receipt` | Authenticated host handoff receipt proving the producer role. |
| Return | `session_reported` | Schema-valid, revalidated role result with no authenticated producer proof. |

`standard` mode requires at least `operator_confirmed` activation and permits
`session_reported` returns. `hardened` mode requires `host_signed` and
`host_receipt`. Repository configuration (`agenticloop.json` `activation.mode`)
may raise the minimum but never lowers the external operator pin at
`~/.agenticloop/operator-activation/<target-sha256>.policy.json`.

`operator_confirmed` is procedural, local-user assurance. It is not equivalent
to an isolated host signer and does not resist arbitrary code running as the
same OS user. No command output describes it, or a `session_reported` return, as
cryptographically host-authenticated.

### `agenticloop host-trust`

```text
npx agenticloop host-trust status [--json]
npx agenticloop host-trust register <adapter-id> --key-id <id> --public-key <base64-or-path> \
    [--activation-capture supported] [--return-receipt supported] [--dry-run]
npx agenticloop host-trust rotate <adapter-id> --key-id <id> --public-key <base64-or-path> [--dry-run]
npx agenticloop host-trust revoke <adapter-id> [--dry-run]
```

Bounded provisioning for the external operator trust store that makes hardened
mode possible. Registration accepts only a **public** key; a private key is
refused rather than stored. There is deliberately no command that signs an
activation capture or a return receipt with the protected host key.

### Legacy host-signed captures

An adapter with a proven parser-owned capture producer may issue a verified
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
registry. Neither a boolean callback, environment
value, CLI option, nor same-user writable filesystem path can promote one. The
packaged protected-host seam requires a fresh nonce-bound Ed25519 challenge
response over authenticated host-controlled IPC, an inherited protected OS
handle, OS isolation, or an equivalent boundary outside the delegated process. A
repository-local
`.agenticloop/host-trust.json` is ordinary untrusted data and cannot authorize a
capture, packet, or return.

For ordinary non-activated Markdown scaffolding, use `task new <title>
--scaffold`. A scaffold task carries no activation authority and cannot be
dispatched in that state. It does not have to be recreated: run
`npx agenticloop activate <task-id>` and it becomes eligible for dispatch with
`operator_confirmed` assurance.

Dispatch resolves activation in one fixed order: a current valid legacy
host-signed task capture, then a current valid task activation binding, then
blocked. An existing activation-bound project therefore behaves exactly as
before, with no change to any task record.

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
npx agenticloop task prepare-dispatch T-001 --host opencode --role engineer --output .agenticloop/tmp/dispatch.json --json
```

Produce the committed decomposition source first with `task
prepare-decomposition`. The command selects files or GitHub from
`.agenticloop/project.md`; GitHub may use `--repo <owner/name>` and follows the
complete issue pagination through the injected read-only transport. Both
backends emit the same shared scan semantics and an exact enumeration receipt.
Dispatch refetches that authoritative inventory before mutation.

Both preparation subcommands validate `task_backend` before they select an
enumerator or a transport. An unsupported value is refused with a single typed
`verification.context.malformed` diagnostic as the root cause; no inventory is
enumerated and no GitHub call is made. `--repo` names a GitHub repository, so
supplying it while `task_backend: files` is configured is a usage error rather
than a silently ignored flag.

The ordinary producer derives the Engineer assignment and safe existing durable
facts; it does not require hand-authored dispatch input. `--input` remains an
advanced compatibility route for projects where durable source selectors are
unavailable; it is validated normally and may not override refetched durable
authority. Input and output paths are relative to the selected target and must
remain inside it.

The committed decomposition source persists the exact dispatch revalidation
selectors. Its scan binds the base as an exact `git-tree:<oid>` identity and
each dependency snapshot twice: the semantic `source` identity the snapshot
declares about itself (for example `files:.agenticloop/tasks`) and the
target-relative `sourceRef` artifact path used to reopen that exact snapshot.
The selector is confined like every committed source: no absolute or
drive-qualified paths, no backslashes, no `.`/`..` segments, no symlink
traversal, and no resolution outside the repository. The committed scan is
schema version 2. A genuine schema-version-1 scan or decomposition cannot
supply the selector and fails with typed regeneration guidance; repair it by
re-running `task prepare-decomposition <id> --work-unit <id> --source-ref
<path> --source-revision <ref> --base <ref-or-tree> --dependencies <path>` with
the same inputs rather than editing the record. The command reruns readiness
from the exact Git tree and dependency snapshot, reads
decomposition from its committed `sourceRef`, and requires the source commit to
carry canonical `Task:` and `Agent: maintainer` attribution before emitting a versioned
`agenticloop.role-preparation` packet only when every binding is current. The
current packet is schema version 7 and binds the selected host, the exact closed
Engineer capability declaration and digest, and the canonical derived
degraded-enforcement report inventory plus a constant-size decomposition binding
to the committed scan source. The real shipped baseline was schema
version 2. Authentic versions 2 through 6 fail with typed
`dispatch.packet.stale`; regenerate them as version 7
instead of repairing them in place. Merely setting an old version number on
malformed input does not classify it as a legacy packet. A missing, malformed, non-canonical, or
implementation-denying declaration fails before dispatch.
An otherwise-current schema-v6 packet carrying the exact former version 3
degraded-report set is also classified as typed `dispatch.packet.stale` only
after its original digest and complete projected-current semantics validate;
regenerate it rather than accepting or rewriting it. A malformed v3 lookalike
remains malformed.
The
Engineer revalidates it with `task prepare-dispatch T-001 --packet <packet.json>
--role engineer [--host-trust-store <expected-registered-path>]` before
mutation. A scaffold made with `task new --scaffold` has no verified activation
identity and cannot dispatch in that state; activate the existing task with
`npx agenticloop activate <task-id>` before dispatch.

Packet v7 names `taskContractDigest` separately from the immutable historical
`dispatchCarrierDigest`; it embeds the complete signed grant and binding and independently binds a
nullable return adapter (`--return-adapter <adapter-id>`). Packet digests are
integrity only. The in-process prepared-dispatch validation result is likewise
an unkeyed, exact-packet/result-bound integrity record: it detects alteration and
substitution but does not authenticate the validator or prove canonical origin.
Public files and GitHub mutation commands accept the prepared-dispatch packet,
not a validation-receipt option, and rerun the complete current
`canonicalDispatchValidator` immediately before mutation. A persisted receipt
or verdict crossing a process or trust boundary must be rederived from its
underlying packet or verified return. `task verify-return` persists observed schema-v4
`agenticloop.return-verification` evidence under `.agenticloop/returns/verifications/`;
every non-v4 record is a fail-closed typed incompatibility, including released
schema v2 and interim schema v3. Those records remain historical evidence but
cannot be relabelled, migrated, or consumed as current; safely resume with
freshly produced current evidence.
Closeout revalidates current records and never treats a
registered capability as proof an event happened. Standard plugin-free operation
uses `operator_confirmed` activation and freshly revalidated `session_reported`
returns. Optional protected host integration is required for `host_signed`
activation and `host_receipt` returns. Missing evidence fails both modes.
Return evidence is bound to the exact work unit as well as the task, contract,
and activation authority. When several successful observations exist for that
same tuple, the latest verified observation is current; older observations are
history and an equal-time conflict fails closed. GitHub verification and
closeout refetch the live PR identity. Git rederives the exact returned commit
range and requires its head to remain an ancestor of the current checkout, so
later contract-preserving workflow commits do not erase valid return evidence.

For a files-backed Engineer return, construct closed check evidence and derive
the raw return from current task/Git facts:

```text
npx agenticloop task check-evidence-init T-001 --packet .agenticloop/tmp/dispatch.json --output .agenticloop/tmp/checks.json --json
npx agenticloop task check-evidence-update T-001 --packet .agenticloop/tmp/dispatch.json --input .agenticloop/tmp/checks.json --output .agenticloop/tmp/checks.json --check RC-1 --outcome passed --evidence "npm test passed" --execution-output .agenticloop/tmp/rc-1.execution.json --json
npx agenticloop task prepare-return T-001 --packet .agenticloop/tmp/dispatch.json --check-evidence .agenticloop/tmp/checks.json --outcome implementation_ready_for_review --output .agenticloop/tmp/return.json --json
npx agenticloop task verify-return T-001 --packet .agenticloop/tmp/dispatch.json --return .agenticloop/tmp/return.json --from-current-repository --json
```

Cancellation is evidence-bound and never inferred. No shipped public runtime
currently has a protected, non-agent-callable Agentic Loop cancellation receipt
producer, so `prepare-return` and `verify-return` refuse a positive
`cancellation_requested` claim. A structural
`agenticloop.cancellation-provenance` JSON record is not authority and cannot
be promoted by its digest or by host status:

```text
npx agenticloop task prepare-return T-001 --packet .agenticloop/tmp/dispatch.json --check-evidence .agenticloop/tmp/checks.json --outcome implementation_blocked --blocker-category cancellation_requested --cancellation-evidence .agenticloop/tmp/cancellation.json --output .agenticloop/tmp/return.json --json
npx agenticloop task verify-return T-001 --packet .agenticloop/tmp/dispatch.json --return .agenticloop/tmp/return.json --from-current-repository --cancellation-evidence .agenticloop/tmp/cancellation.json --json
```

Host idle/completed/terminated state, stop reasons, messages, timestamps, and
unkeyed digests are never consulted. Until a pinned protected receipt producer
exists, record the outcome as unknown/needs-context and obtain the required host
integration rather than claim cancellation. The future receipt must bind the
exact logical invocation, request, packet, task, controller, observed result,
strict UTC request/observation times, freshness, and replay policy.

A verified return authorizes reuse for a fixed window. The version 1
return-use freshness policy is exactly 86,400 seconds (24 hours). Omitting the
`return_use_freshness` project configuration selects that stable default; a
declared policy must match the closed version-1 shape and value exactly, and
missing, malformed, old, future, or extended policies fail closed.
The 86,400-second value is the only supported value for policy version 1. A
future tunable policy requires a new policy version or a separately authorized
contract change.

All public artifact paths are relative to the selected target, must remain
inside it, and must name regular files rather than links. A `passed` command
check requires `--execution-output`: the CLI itself parses the exact required
command as inert argv (no shell), runs it at the target root with a five-minute
timeout, and writes target-confined schema-v3
`agenticloop.execution-evidence` JSON with the actual argv, child exit code,
and output. A caller-supplied execution artifact or `--outcome passed
--exit-code 0` cannot prove execution. Manual, failed, blocked, and not-run
observations retain their existing bounded observation form.

On Windows, the runner resolves `.cmd` and `.bat` shims on `PATH` (preferring
them over an extensionless shim such as `npm`) and invokes the resolved shim
through `cmd.exe /d /s /c` with reviewed argument quoting. This wrapper support
does not permit shell syntax in a required-check command; the required command
is still parsed as inert argv and shell metacharacters are rejected.
At role start, the current dispatch is revalidated through the live canonical
dispatch boundary before its single-use consumption. `prepare-return` is
Engineer-owned and read-only: it authenticates that packet and requires the
matching already-consumed invocation and current carrier lineage. Host admission,
task status, and free-form messages cannot substitute for its derived return. The ordinary
files verifier uses `--from-current-repository` to rederive evidence
independently from current Git and task facts; `--repository-evidence <path>` remains advanced compatibility,
and the two options are mutually exclusive. `--from-current-repository` is
files-only: on the GitHub backend it is refused with a typed usage error
before any refetch, because caller-independent rederivation requires the local
trusted checkout.

A passed command check in a files-backed return is proved by the closed
schema-v3 `agenticloop.execution-evidence` artifact, never by exit-code prose.
Schema-v2 execution evidence and its digest domain are typed incompatible and
must be regenerated rather than relabeled or re-digested.
Current packets bind required-check evidence contract v2 into their semantic
digest: every command check carries `executionEvidence`; a passed check carries
its `{ path, digest }` artifact reference and every non-passed check carries
`null`. Both the return producer and `verify-return` revalidate the artifact
against the exact packet, invocation, task, carrier, repository, and product
identities it binds. Removing this property is malformed, not legacy
compatibility. Packets authenticated as schema 7 or older are typed stale and
must be regenerated; they cannot authorize a current return or protected
transition.
`closeout prepare --legacy-unactivated --legacy-reason <text>` is the interactive,
standard-only, exact-work-unit compatibility exception. New waivers name only
missing activation evidence. An authentic, unexpired schema-v1 waiver that also
contains the retired `return_evidence_absent` scope is verified against its
original signed fields, then projected to activation-only behavior with
`compatibility.waiver_scope_retired`; dispatch consumption and canonical
verified-return evidence remain mandatory. Both JSON and human-readable
closeout preparation expose that diagnostic, while the assurance report retains
the unchanged signed source record as `compatibility_waiver`. It never hides revoked,
stale, malformed, conflicting, mismatched, or cryptographically invalid evidence,
and hardened mode rejects it.

`task verify-return` authenticates the raw return, independently derives or
checks repository evidence, and persists the closed
`agenticloop.return-verification` schema-v4 record. Every non-v4 verification
record is fail-closed typed incompatible lifecycle evidence, including released
schema v2 and interim schema v3. It remains historical evidence but cannot be
edited, relabelled, migrated, or consumed as current; safely resume with a fresh
current packet, check evidence, raw return, and verification.
Standard mode permits an explicitly `session_reported`, freshly revalidated
return at reduced/unverified assurance. For `host_receipt` assurance, the
packet-bound producer receipt and protected host-issued execution receipt are
required as applicable:

```text
npx agenticloop task verify-return T-001 --packet packet.json --return role-return.json [--from-current-repository | --repository-evidence repository-evidence.json] [--producer-receipt producer-receipt.json --execution-receipt execution-receipt.json] [--cancellation-evidence cancellation.json] [--repo <owner/name>] [--resume-owner <role-id> --redelegation-authority redelegation.json | --recovery-request recovery.json --human-disposition disposition.json --human-disposition-authority <authority-id> --human-disposition-key-id <key-id>] [--host-trust-store <expected-registered-path>] --json
```

For a files-backed Engineer run, retain the role-start carrier and record only
bounded evidence mutations before constructing the raw return:

```text
npx agenticloop task evidence T-001 --class implementation_artifact_evidence --expect-digest <currentCarrierDigest> --product-head <productHead> --json
npx agenticloop task evidence T-001 --class implementation_summary_evidence --expect-digest <currentCarrierDigest> --summary <text> --check-evidence <text> --json
npx agenticloop task evidence T-001 --class implementation_outcome_evidence --expect-digest <currentCarrierDigest> --outcome implementation_ready_for_review --json
npx agenticloop task review-prepare T-001 --json
```

`task evidence` atomically writes the task carrier and a versioned receipt under
`.agenticloop/handoffs/task-mutations/`. It refuses an unreceipted carrier,
protected contract drift, or any class outside artifact, summary, and outcome
evidence. The chain binds `taskContractDigest`, `dispatchCarrierDigest`, and the
resulting `currentCarrierDigest`. Raw returns and repository evidence name
`productBaseHead`, `productHead`, `workflowHead`, `candidateHead`, separate
product/workflow paths, and exact chain references. `task review-prepare` uses
one command-local carrier snapshot and writes no review receipt when it changes.

`task review-prepare --json` also emits two revision-routing fields,
`findingResolutionMatrix` and `matrixDecision`. Both are `null` on a first
review: the matrix is scaffolded only on a revision round, once the review record
carries a `needs_revision` outcome (an `AGENT_REVIEW_FINDINGS` result). When
populated, `matrixDecision.maintainerFixupEligible` is `true` only when every
finding in the round is `record-only`; that routes a record-only correction to
the Maintainer without consuming an Engineer revision round, while any
implementation-changing finding routes to the Engineer. Classification is
currently derived per revision round, not per finding: the round's single
classification is mapped onto every finding id and the disposition is uniform
across the round. The `contract-changing` class exists in the schema but is
currently unreachable — the review record permits only `implementation_changing`
and `record_only`, and a protected-contract change is blocked separately by the
`protectedContractUnchanged` check, never routed through the matrix. Per-finding
classification is a known limitation, not yet implemented.

The CLI never receives signing material. The operator registry contains only
Ed25519 public keys and scopes them to one canonical target checkout. A host or
OS policy must keep that fixed registry non-writable by agents; the CLI rejects
caller-selected alternative stores. The producer-receipt and execution-receipt
selectors are target-relative and confined. The producer receipt binds its target
repository, adapter/key identity, invocation ID, packet, return, host-observed
producer role, liveness, and canonical repository evidence digest.
Receipt-controlled semantic fields are evaluated only after the pinned key
verifies the signature over canonical bytes. A forged `producerRole` therefore
yields generic authentication failure; an authentically signed wrong producer
yields `role_return.producer_mismatch`. After authentication, the observed
producer must match both packet assignment and return claim; cooperative
`Task:`/`Agent:` trailers cannot repair a mismatch. The protected host-issued
execution receipt is verified through the external protected host boundary, not
by CLI-held signing material or self-attestation. Its replay binding is prepared
and committed by the protected replay authority, then revalidated as current on
later verification; a missing, replayed, stale, or invalid required receipt
blocks rather than trusting Orchestrator assertions. The CLI supplies no fallback
replay ledger: a real protected host integration must retain durable replay state
across process restarts. In-memory replay authorities are test fixtures only.
The files verifier also
reconstructs the current branch, head, changed paths, durable commit range, and
canonical attribution from Git and rejects dirty tracked or untracked in-scope
state. The GitHub verifier additionally refetches the live PR number, state, URL,
branch, and head; a closed or changed PR is stale. The shipped receipt baseline,
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

The packet also carries the canonical version 4 degraded-enforcement report set.
`prepare-dispatch` emits `capability.enforcement.degraded` warnings through the
repair policy, and `verify-return` performs the canonical
packet/report/declaration check at the receive edge. A duplicate
post-validation report branch is not counted as another enforcement layer.
Malformed, contradictory, or declaration-drifted reports fail closed. The
report pins the declaration that supplies the deterministic recovery route. This is an
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

During a recognized Engineer run, use the bounded evidence command rather than a
generic task-body edit:

```text
npx agenticloop task-body evidence --issue <n> --class implementation_artifact_evidence --expect-digest <digest> --product-head <productHead> --dry-run
npx agenticloop task-body evidence --issue <n> --class implementation_summary_evidence --expect-digest <digest> --summary <text> --check-evidence <text> --dry-run
npx agenticloop task-body evidence --issue <n> --class implementation_outcome_evidence --expect-digest <digest> --outcome implementation_ready_for_review --dry-run
```

It consumes the current local GitHub dispatch-consumption generation and writes
the resulting carrier-mutation receipt after refetching the exact issue body.
Only artifact, summary/check, and non-authoritative outcome evidence are
permitted; a protected contract change or an unreceipted carrier change is
refused. Repeat a valid dry run with `--yes`.

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
rejected for a non-status update rather than silently discarded, except that an
already-current `in-progress` request is explicitly a new role start rather than
a note-only update and requires a fresh dispatch packet.

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
`--dependencies <snapshot.json>`. Supplying both base forms is refused.

An `in-progress` transition is the role start, and it accepts
`--dispatch-packet <packet.json>` naming a canonical `task prepare-dispatch`
result. With a packet that binds the current task, contract generation, carrier
digest, and Engineer role, the start is recognized and the JSON payload carries
the closed `agenticloop.handoff-recognition` verdict and records a durable
single-use dispatch consumption. Without a packet, with a consumed packet, or
with a packet that does not bind, the transition is refused, typed `handoff.*`
diagnostics are reported, and the task record is left unchanged. The complete
current-state `task prepare-dispatch --packet` verifier is rerun immediately
before mutation, including task, readiness, repository, decomposition,
inventory, activation, and current operator policy; a recomputed digest or a
packet made stale by a later repository-head change does not pass.

The requested target status defines the role-start boundary. Requesting
`in-progress` when the carrier already says `in-progress` still requires fresh
recognition and consumes the packet exactly once before returning a validated
no-op. Adding `--note` makes the note part of that new start; there is no
note-only route that can claim a role start. The 24-hour verified-return
transition-use ceiling is immutable v1 policy, not operator configurable.

`agenticloop task-body transition --issue <n> --status in-progress` is the same
boundary on the GitHub carrier and accepts the same `--dispatch-packet` option
with the same fail-closed outcomes. A refusal happens before any issue edit. The CLI
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
npx agenticloop commit-attribution check --task T-001 --role maintainer --commit HEAD
```

Push only after both checks pass. Separate `git commit -m` paragraphs for
`Task:` and `Agent:` fail prospective validation.
Role-aware attribution is cooperative evidence, not producer authentication;
Git author identity, workflow role, operator authority, and verifier identity
remain separate.

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
and assessment. In `standard` mode a distinct invocation may omit the receipt;
the accepted run is graded `session_reported` and records
`Producer authenticated: false`. In `hardened` mode that return is below policy
and is returned to Auditor without consuming budget; a verified protected-host
receipt is required and produces `host_receipt` with
`Producer authenticated: true`. Same-session audit remains invalid in both
modes. Legacy inline reports remain explicitly `legacy_inline_v1`; they do not
establish a fresh wire-format Auditor return. Visible and embedded report
provenance must agree.

Audit schema version 3 persists the observed Auditor-return grade and producer
authentication state on every run. Audit gate output, closeout packet schema
version 2, and closeout marker schema version 2 carry those values and enforce
the effective minimum again at closeout. Canonicalizing a version 2 wire-format
run derives the grade conservatively from its existing provenance and receipt;
older or inline history does not gain fresh-return authority through migration.

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
