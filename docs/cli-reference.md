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
| `task` | Files-backed task records (`list`, `lint`, `new`, `status`) |
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
acceptance. For a dispatched review, add `--expect-artifact <full-sha>` to
require that both the PR head and review marker still match the dispatched
artifact. If a local review checkout is supplied, add `--workspace <path>` as
well; it requires `--expect-artifact` and rejects a workspace whose Git HEAD
does not match that exact SHA.

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
Maintainer packet only when `result.ok === true` for the exact current full head;
a matching head never overrides a failed result. Failed preparation routes every
deterministic diagnostic to Engineer, Orchestrator, Maintainer, or human
authority and does not invoke a reviewer. Any push invalidates the packet.

`github-review-audit` is post-review provenance validation. `github-ready` is
the post-acceptance, pre-merge composite and reuses the same preflight evaluator.
Before dispatch, a previously emitted packet can be re-verified with
`github-review-prepare --pr <n> --packet <path>`: the command refetches the
current head read-only and rejects stale, missing, malformed, or mismatched
packets. Before that refetch it validates the packet type/version, requested PR,
task identity, review mode, independent-review consistency, preflight success
digest, workspace shape, and exact internal head bindings. Malformed JSON or an
invalid packet schema fails locally without contacting GitHub. Preparation
itself also refetches the head immediately before emitting a packet, so a head
that moves during preparation yields only a stale-head diagnostic. None of
these commands posts, edits, requests review, accepts, merges, amends, pushes,
or force-pushes.

Every review-preparation gate supports `--json`. Normal, usage, loader, and operational
failures use a versioned envelope with diagnostics, categories, ownership, and a
first safe repair; human output is rendered from the same result.

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
npx agenticloop task-body transition --issue <n> --status agent-ready --expect-digest <digest> --base <base-ref> --dry-run
npx agenticloop task-body establish-baseline --issue <n> --expect-digest <digest> --authority <ref> --actor <login> --dry-run
npx agenticloop task-body authorize-correction --issue <n> --body-file <candidate.md> --expect-digest <digest> --reason <text> --authority <ref> --actor <login> --dry-run
```

Repeat any dry run with `--yes` only after inspecting its patch plan. The first
two commands make one bounded body change through the same lint/refetch/expected
digest transaction. The latter two create and refetch a separate verified
task-contract record carrier; body markers are only caches. An `agent-ready`
transition fails closed without a base tree inventory.

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
format requires all six perspectives and every finding field (`id`, `severity`,
`blocking`, `claim`, `evidenceRefs`, `consequence`, `requiredOutcome`, and
`verificationRequired`). Unknown fields fail rather than being dropped. A host
receipt is `verified` only when an available host verifier validates it; otherwise
the durable provenance is `asserted`.

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
