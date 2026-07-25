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
| `validate` | Validate skills, config, links, and host setup |
| `remove` | Remove Agentic Loop assets (`--dry-run` or `--yes` required) |
| `guidance` | Manage the activation-guidance block (`apply`, `check`, `remove`) |
| `generate` | Generate adapter artifacts (`opencode`, `codex`, `claude-code`, `copilot`, `cursor`, `all`) |
| `configure models` | Set per-host role model settings in `agenticloop.json` |
| `task` | Files-backed task records (`list`, `lint`, `new`, `status`) |
| `audit` | Work-unit audit certificates (`new`, `baseline`, `report`, `status`, `gate`, `lint`, `override`, `resolve`) |
| `worktree` | Guarded worktrees (`add`, `guard`, `list`, `remove`, `cleanup`, `resolve-state`, `prune`) |
| `event-logging` (alias `event`) | Write, validate, audit, and report workflow event logs |
| `github-preflight` | Pre-review evidence gate for a GitHub PR |
| `github-review-audit` | Artifact-bound review provenance for a PR |
| `github-ready` | Read-only merge-readiness verdict |
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
| `init --update-assets` | Removed; use `agenticloop update` |
| `--no-agents-guidance` | Opt out of the activation-guidance block (literal option on init/setup) |

Strict-parsing compatibility changes (unknown options fail, Boolean flags do
not consume following tokens, command-local `-h` prints help, usage failures
exit `2`) are recorded in `CHANGELOG.md`.
