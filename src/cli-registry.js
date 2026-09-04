/**
 * Declarative strict command registry for the agenticloop CLI.
 *
 * This module is the single source of truth for:
 *   - the command and subcommand tree (including compatibility aliases);
 *   - option names, types, repeatability, aliases, and enum values;
 *   - positional argument shapes;
 *   - help text for the root, every command, and every subcommand;
 *   - package-backed version output.
 *
 * Parsing uses node:util.parseArgs with strict validation. A thin
 * normalization layer maps kebab-case CLI option names to the camelCase keys
 * handlers consume. `--no-agents-guidance` is registered as its own literal
 * Boolean option (the package supports Node releases before
 * util.parseArgs({ allowNegative }) existed, so negative-option synthesis is
 * never assumed).
 *
 * Unknown commands/options, missing values, and invalid enum values raise
 * CliUsageError (exit 2) before any command handler executes. Unknown names
 * suggest a close valid spelling when one exists.
 *
 * Positional shapes are enforced centrally by `parseCommandArgs`: a command
 * without a `positionals` declaration accepts zero operands, required
 * positionals must be present, optional positionals may be omitted,
 * non-variadic declarations enforce maximum arity, and a variadic positional
 * must be the final declaration.
 *
 * Semantic required-option validation (for example `--pr` on the github
 * commands) remains handler-owned: those handlers emit their own JSON error
 * contracts, so the registry intentionally carries no option-level `required`
 * metadata that would imply central enforcement.
 */

import { parseArgs as utilParseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { CliUsageError } from './cli-io.js';
import { DEFAULT_AUDIT_BUDGET } from './layout.js';
import { WORKFLOW_ROLE_IDS } from './workflow-roles.js';
import { COMMIT_MESSAGE_CLASS_LIST } from './commit-attribution.js';

const ADAPTER_HOSTS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
const ADAPTER_TARGETS = [...ADAPTER_HOSTS, 'all'];
const WORKFLOW_ROLE_LIST = WORKFLOW_ROLE_IDS.join(', ');

function opt(name, type, description, extra = {}) {
  return { name, type, description, ...extra };
}

const targetOption = (description = 'Target directory (default: current directory).') =>
  opt('target', 'string', description);
const hostTrustStoreOption = opt(
  'host-trust-store',
  'string',
  "Absolute assertion of this target's pre-registered store under the host-owned operator trust root. It cannot select an arbitrary external trust file."
);
const jsonOption = opt('json', 'boolean', 'Emit machine-readable JSON instead of human-readable output.');
const dryRunOption = opt('dry-run', 'boolean', 'Print the plan without making changes.');
const yesOption = opt('yes', 'boolean', 'Confirm the mutating action.');
const adapterOption = (description, extra = {}) =>
  opt('adapter', 'string', description, { multiple: true, ...extra });
const agentsGuidanceOptions = [
  opt('agents-guidance', 'string', 'Install the repository-rules activation-guidance block: on or off.', { enum: ['on', 'off'] }),
  opt('no-agents-guidance', 'boolean', 'Skip installing the repository-rules activation-guidance block.'),
];
const verboseOption = opt('verbose', 'boolean', 'Print individual paths and detailed evidence.');

export const COMMAND_REGISTRY = {
  init: {
    summary: 'Advanced files-only or direct adapter scaffold.',
    usage: 'agenticloop init [--target <dir>] [--adapter <host>] [--dry-run] [--json]',
    receiptRevalidation: 'requires-dry-run',
    options: [
      targetOption(),
      adapterOption('Scaffold and generate output for one host: opencode, codex, claude-code, copilot, cursor, all.', { enum: ADAPTER_TARGETS }),
      opt('opencode', 'boolean', 'Compatibility alias for --adapter opencode.'),
      opt('setup', 'boolean', 'Deprecated: prompt for model settings after scaffolding (requires one concrete --adapter). Use agenticloop setup instead.'),
      opt('update-assets', 'boolean', 'Removed. Use agenticloop update instead.'),
      ...agentsGuidanceOptions,
      dryRunOption,
      jsonOption,
      verboseOption,
    ],
  },
  setup: {
    summary: 'Recommended guided onboarding; scaffolds or repairs as needed.',
    usage: 'agenticloop setup [--target <dir>] [--adapter <host>] [--non-interactive] [--dry-run] [--json]',
    receiptRevalidation: 'requires-dry-run',
    options: [
      targetOption(),
      adapterOption('Preselect adapter: opencode, codex, claude-code, copilot, cursor, all.', { enum: ADAPTER_TARGETS }),
      opt('non-interactive', 'boolean', 'Non-interactive mode: skip interactive prompts (requires --adapter).'),
      opt('yes', 'boolean', 'Compatibility alias for --non-interactive on setup.'),
      opt('event-logging', 'string', 'Event logging mode: enabled or disabled. Interactive setup prompts when omitted; non-interactive setup preserves the existing value (a missing setting defaults to disabled).', { enum: ['enabled', 'disabled'] }),
      ...agentsGuidanceOptions,
      dryRunOption,
      jsonOption,
      verboseOption,
    ],
  },
  update: {
    summary: 'Refresh Agentic Loop-owned assets and existing adapter output.',
    aliases: ['upgrade'],
    usage: 'agenticloop update [--target <dir>] [--repository-only [--dry-run] [--json] | --adapter <host>] [--force-generated]',
    options: [
      targetOption(),
      opt('repository-only', 'boolean', 'Refresh portable repository assets and deterministic migrations without inspecting or generating clone-local host artifacts.'),
      adapterOption("Generate or refresh one adapter. 'all' means every implemented adapter. Without this, existing generated artifacts are refreshed. Existing adapter model settings are backfilled into agenticloop.json when missing before regeneration."),
      opt('force-generated', 'boolean', 'Refresh only a modified artifact already proven owned by Agentic Loop.'),
      dryRunOption,
      jsonOption,
      verboseOption,
    ],
  },
  hydrate: {
    summary: 'Generate one clone-local host integration without changing tracked repository files.',
    usage: 'agenticloop hydrate --adapter <host> [--target <dir>] [--dry-run] [--json] [--force-generated]',
    options: [
      targetOption('Repository to hydrate (default: current directory).'),
      adapterOption('One explicit host: opencode, codex, claude-code, copilot, or cursor.', { enum: ADAPTER_HOSTS }),
      dryRunOption,
      jsonOption,
      opt('force-generated', 'boolean', 'Refresh only a modified artifact already proven owned by the clone-local ownership manifest.'),
    ],
  },
  remove: {
    summary: 'Remove Agentic Loop assets from a target directory.',
    usage: 'agenticloop remove [--target <dir>] [--dry-run|--yes] [--include-state]',
    options: [
      targetOption(),
      dryRunOption,
      yesOption,
      opt('include-state', 'boolean', 'Also remove target-owned .agenticloop/ state.'),
    ],
  },
  guidance: {
    summary: 'Manage the repository-rules activation-guidance block (apply, check, remove).',
    usage: 'agenticloop guidance <apply|check|remove> [--target <dir>] [--force]',
    subcommands: {
      apply: {
        summary: 'Apply or refresh the activation-guidance block.',
        options: [
          targetOption(),
          opt('force', 'boolean', 'Refresh a modified owned block or adopt an unowned marker block.'),
        ],
      },
      check: {
        summary: 'Report activation-guidance block status without changes.',
        options: [targetOption()],
      },
      remove: {
        summary: 'Remove the activation-guidance block.',
        options: [
          targetOption(),
          opt('force', 'boolean', 'Remove a modified owned block.'),
        ],
      },
    },
  },
  validate: {
    summary: 'Validate skills, config, links, and host setup.',
    usage: 'agenticloop validate [--target <dir>] [--adapter <host>]',
    options: [
      targetOption('Directory containing agenticloop.json (default: current).'),
      adapterOption('Force validation of a specific adapter (opencode, codex, claude-code, copilot, cursor). May be passed multiple times.', { enum: ADAPTER_HOSTS }),
      opt('links', 'boolean', 'Accepted for compatibility; link validation runs as part of validate.'),
    ],
  },
  'github-preflight': {
    summary: 'Pre-review gate: verify a GitHub PR body carries final-state evidence for every required check, tied to the current head.',
    usage: 'agenticloop github-preflight --pr <number> [--issue <number>] [--repo <owner/name>] [--json]',
    options: [
      opt('pr', 'string', 'Pull request number to check. Required.'),
      opt('issue', 'string', 'Linked task issue number (default: inferred from PR closing references).'),
      opt('repo', 'string', 'Target repository (default: gh-resolved current repo).'),
      jsonOption,
    ],
  },
  'github-review-audit': {
    summary: 'Verify artifact-bound GitHub review provenance for a PR.',
    usage: 'agenticloop github-review-audit --pr <number> [--issue <number>] [--repo <owner/name>] [--expect-status <accepted|needs_revision>] [--expect-artifact <sha>] [--workspace <path>] [--json]',
    options: [
      opt('pr', 'string', 'Pull request number to audit. Required.'),
      opt('issue', 'string', 'Linked task issue number (default: inferred from PR closing references).'),
      opt('repo', 'string', 'Target repository (default: gh-resolved current repo).'),
      opt('expect-status', 'string', 'Expected review status (default: accepted).', { enum: ['accepted', 'needs_revision'] }),
      opt('expect-artifact', 'string', 'Expected dispatched artifact: a complete Git object identity in the repository object format. When provided, the current PR head must equal this identity.'),
      opt('workspace', 'string', 'Optional local review workspace. Requires --expect-artifact and must resolve to that exact Git HEAD.'),
      jsonOption,
    ],
  },
  'github-ready': {
    summary: 'Read-only pre-merge gate: run the evidence preflight and the review audit together and report one merge-readiness verdict.',
    usage: 'agenticloop github-ready --pr <number> [--issue <number>] [--repo <owner/name>] [--json]',
    options: [
      opt('pr', 'string', 'Pull request number to check. Required.'),
      opt('issue', 'string', 'Linked task issue number (default: inferred from PR closing references).'),
      opt('repo', 'string', 'Target repository (default: gh-resolved current repo).'),
      jsonOption,
    ],
  },
  'pr-body': {
    summary: 'Scaffold a canonical PR body and lint a local candidate body against live or snapshotted evaluation context.',
    usage: 'agenticloop pr-body <scaffold|lint> [options]',
    details: [
      'Closed-loop authoring workflow (read-only with respect to GitHub):',
      '  1. finish the implementation, push, and run the required final checks;',
      '  2. npx agenticloop pr-body scaffold --pr <n> --output <body.md> [--snapshot-output <context.snapshot.json>]',
      '  3. edit the Markdown body (replace every REPLACE placeholder);',
      '  4. npx agenticloop pr-body lint --pr <n> --body-file <body.md>            (live context)',
      '     npx agenticloop pr-body lint --snapshot <context.snapshot.json> --body-file <body.md>   (offline)',
      '  5. publish explicitly (gh pr edit <n> --body-file <body.md>), then run github-preflight and github-review-prepare.',
      'Compatibility only: pr-body lint --input <evaluation-input.json> reads a complete legacy serialized input, is deprecated, and never checks live state.',
      'Lint modes are mutually exclusive. --issue and --repo belong to live --pr mode only; snapshot mode performs zero network access.',
      'Lint results expose contextMode (live|snapshot|legacy), repository/PR/issue/head/base provenance, evaluated-state flags, and an exact repair-aligned next command.',
      'Exit statuses: 0 successful scaffold or publication-ready lint; 1 file/format/context/lint/gate failure; 2 invalid option shape.',
      'github-review-prepare evaluates published live state only; it is never the unpublished-draft linter.',
    ],
    subcommands: {
      scaffold: {
        summary: 'Read GitHub data and render a local PR-body scaffold (and optional context snapshot) without writing GitHub.',
        usage: 'agenticloop pr-body scaffold --pr <number> [--issue <number>] [--repo <owner/name>] [--output <path>] [--snapshot-output <path>] [--json]',
        options: [
          opt('pr', 'string', 'Pull request number. Required.'),
          opt('issue', 'string', 'Linked task issue number override.'),
          opt('repo', 'string', 'Target repository.'),
          opt('output', 'string', 'Optional local output path; stdout when omitted.'),
          opt('snapshot-output', 'string', 'Optional offline context snapshot path; serializes the complete loaded evaluation context with materialized task/decision inventories.', { valueName: 'path' }),
          jsonOption,
        ],
        details: [
          'Run scaffold only after the final implementation push and required checks: the captured head and context are exact.',
          'Both --output and --snapshot-output are written atomically; missing parent directories are created.',
          'The scaffold is intentionally incomplete. Output reports the exact next lint command:',
          '  npx agenticloop pr-body lint --pr <n> --body-file <path>',
          '  npx agenticloop pr-body lint --snapshot <path> --body-file <path>',
          'A push after scaffolding invalidates the authoring packet: rerun required checks and re-scaffold/revalidate against the new head.',
          'After an explicit publish (gh pr edit <n> --body-file <path>), run npx agenticloop github-preflight --pr <n> and then npx agenticloop github-review-prepare --pr <n>.',
          'Exit statuses: 0 scaffold written; 1 GitHub context load failure; 2 invalid usage.',
        ],
      },
      lint: {
        summary: 'Lint a local candidate PR-body Markdown file against live context (--pr) or a CLI-authored snapshot (--snapshot); never writes GitHub.',
        usage: 'agenticloop pr-body lint (--pr <number> [--issue <number>] [--repo <owner/name>] | --snapshot <path>) --body-file <path> [--json]',
        options: [
          opt('pr', 'string', 'Live mode: pull request number supplying the evaluation context. Requires --body-file.'),
          opt('issue', 'string', 'Linked task issue number override (live mode).'),
          opt('repo', 'string', 'Target repository (live mode).'),
          opt('body-file', 'string', 'Candidate PR-body Markdown file. Required for --pr and --snapshot modes.', { valueName: 'path' }),
          opt('snapshot', 'string', 'Offline mode: CLI-authored agenticloop.pr-body-context snapshot from scaffold --snapshot-output. Requires --body-file; performs zero network access.', { valueName: 'path' }),
          opt('input', 'string', 'Deprecated compatibility mode: complete serialized preparation-input JSON document (body read from prData.body). Cannot be combined with --pr, --snapshot, --body-file, --issue, or --repo.', { valueName: 'path' }),
          jsonOption,
        ],
        details: [
          'Modes are mutually exclusive. Live and snapshot lint replace only the in-memory candidate body with --body-file, fix evaluation mode to review, and run the shared preparation evaluator.',
          '--issue and --repo are valid only with live --pr mode; they are rejected with --snapshot and deprecated --input.',
          'Live mode loads current GitHub context read-only and injects live task/decision reference resolvers. Snapshot mode performs no network access and uses the materialized inventories captured by scaffold.',
          'Results report contextMode (live|snapshot|legacy), repository/PR/issue/head/base provenance, inputComplete, bodyLintEvaluated, gateEvaluated, lintReady, gatePassed, and publicationReady. Incomplete context is never an evaluated gate.',
          'Snapshot readiness is bound to the complete captured context; publish explicitly (gh pr edit <n> --body-file <path>), then run npx agenticloop github-preflight --pr <n>.',
          'Exit statuses: 0 publication-ready lint; 1 file/format/completeness/lint/gate failure; 2 invalid option shape.',
        ],
      },
    },
  },
  'task-readiness': {
    summary: 'Read-only readiness check for files, GitHub, or supplied task input with explicit base-tree intent.',
    usage: 'agenticloop task-readiness (--task <id>|--issue <n>|--task-body <path>) (--base <ref>|--base-paths <path>) --mode <authoring|review> [--expect-task-digest <digest>] [--dependencies <path>] [--json]',
    receiptRevalidation: 'read-only',
    options: [
      targetOption(),
      opt('task', 'string', 'Files-backend task id resolved through the configured task_file_template.'),
      opt('issue', 'string', 'GitHub task issue number.'),
      opt('task-body', 'string', 'Task Markdown file, relative to the target.'),
      opt('base', 'string', 'Git ref or tree used for an explicit path inventory.'),
      opt('base-paths', 'string', 'JSON path inventory file for offline evaluation.'),
      opt('mode', 'string', 'Explicit readiness mode.', { enum: ['authoring', 'review'] }),
      opt('expect-task-digest', 'string', 'Exact SHA-256 digest the task carrier must still hold. Also re-evaluates the trusted contract chain.'),
      opt('dependencies', 'string', 'Exact JSON dependency-status snapshot document.'),
      jsonOption,
    ],
  },
  'task-body': {
    summary: 'Guarded GitHub task-record body fetch, lint, and transactional apply.',
    usage: 'agenticloop task-body <fetch|lint|apply|set-field|evidence|establish-baseline|authorize-correction|transition> --issue <number> [options]',
    details: [
      'Closed-loop task-record editing:',
      '  1. task-body fetch --issue <n> --output .agenticloop/tmp/issue-<n>.md',
      '  2. edit the local body, then task-body lint --issue <n> --body-file <path>',
      '  3. task-body apply --issue <n> --body-file <path> --expect-digest <fetch digest> --dry-run',
      '  4. inspect the diff, then repeat apply with --yes.',
      'Apply refetches immediately before and after one exact body write. It retains recovery files when verification fails and never overwrites concurrent remote state.',
    ],
    subcommands: {
      fetch: {
        summary: 'Fetch an issue body to an atomically written UTF-8 Markdown file.',
        usage: 'agenticloop task-body fetch --issue <number> --output <path> [--repo <owner/name>] [--json]',
        options: [opt('issue', 'string', 'GitHub task issue number. Required.'), opt('output', 'string', 'Local Markdown output file. Required.'), opt('repo', 'string', 'Target repository.'), jsonOption],
      },
      lint: {
        summary: 'Live-context lint by default; use --offline only when GitHub provenance is intentionally unavailable.',
        usage: 'agenticloop task-body lint --issue <number> --body-file <path> [--offline --trusted-records <snapshot.json>] [--base <ref>] [--base-paths <path>] [--expect-task-digest <digest>] [--json]',
        receiptRevalidation: 'read-only',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('body-file', 'string', 'Local task-body Markdown candidate. Required.'), opt('offline', 'boolean', 'Do not fetch live GitHub body or carrier provenance.'), opt('trusted-records', 'string', 'Validated offline carrier snapshot JSON.'), opt('base', 'string', 'Optional Git base ref for authoring readiness.'), opt('base-paths', 'string', 'Optional JSON base-tree path inventory.'), opt('expect-task-digest', 'string', 'Exact SHA-256 digest the live issue body must still hold. Read-only.'), opt('dependencies', 'string', 'Exact JSON dependency-status snapshot document.'), jsonOption],
      },
      apply: {
        summary: 'Publish one linted issue-body candidate only after an optimistic digest check.',
        usage: 'agenticloop task-body apply --issue <number> --body-file <path> --expect-digest <digest> (--dry-run|--yes) [--note <text>] [--repo <owner/name>] [--base <ref>] [--base-paths <path>] [--json]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('body-file', 'string', 'Local linted task-body Markdown candidate. Required.'), opt('expect-digest', 'string', 'Exact digest printed by task-body fetch. Required.'), opt('repo', 'string', 'Target repository.'), opt('note', 'string', 'Transition note. Allowed only when the candidate changes status; required for blocked or needs_context and persisted as an identified issue comment.'), opt('base', 'string', 'Optional Git base ref for authoring readiness.'), opt('base-paths', 'string', 'Optional JSON base-tree path inventory.'), opt('dependencies', 'string', 'Exact JSON dependency-status snapshot required when the candidate becomes agent-ready.'), dryRunOption, yesOption, jsonOption],
      },
      'set-field': {
        summary: 'Set one top-level task frontmatter field through the guarded apply transaction.',
        usage: 'agenticloop task-body set-field --issue <number> --field <name> --value <text> --expect-digest <digest> (--dry-run|--yes) [--dispatch-packet <path>] [--note <text>] [options]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('field', 'string', 'Top-level frontmatter field. Required.'), opt('value', 'string', 'One-line field value. Required.'), opt('expect-digest', 'string', 'Exact digest printed by task-body fetch. Required.'), opt('repo', 'string', 'Target repository.'), opt('note', 'string', 'Transition note. Allowed only when the field mutation changes status; required for blocked or needs_context and persisted as an identified issue comment.'), opt('base', 'string', 'Optional Git base ref.'), opt('base-paths', 'string', 'Optional JSON base-tree path inventory.'), opt('dependencies', 'string', 'Exact JSON dependency-status snapshot required when status becomes agent-ready.'), opt('dispatch-packet', 'string', 'Canonical task prepare-dispatch packet JSON required when the current carrier is in-progress and a protected integration field is changed. Path is target-relative and confined.'), dryRunOption, yesOption, jsonOption],
      },
      evidence: {
        summary: 'Record one bounded Engineer evidence mutation and its durable carrier-lineage receipt.',
        usage: 'agenticloop task-body evidence --issue <number> --class <class> --expect-digest <digest> (--dry-run|--yes) [--product-head <sha> | --summary <text> --check-evidence <text> | --outcome <implementation_ready_for_review|implementation_blocked>] [--repo <owner/name>] [--json]',
        options: [
          targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'),
          opt('class', 'string', 'Engineer evidence class. Required.', { enum: ['implementation_artifact_evidence', 'implementation_summary_evidence', 'implementation_outcome_evidence'] }),
          opt('expect-digest', 'string', 'Exact current GitHub task-body digest. Required.'),
          opt('product-head', 'string', 'Exact current local product HEAD for implementation_artifact_evidence.'),
          opt('summary', 'string', 'Engineer implementation summary for implementation_summary_evidence.'),
          opt('check-evidence', 'string', 'Required-check evidence for implementation_summary_evidence.'),
          opt('outcome', 'string', 'Non-authoritative Engineer outcome for implementation_outcome_evidence.', { enum: ['implementation_ready_for_review', 'implementation_blocked'] }),
          opt('repo', 'string', 'Target repository.'), dryRunOption, yesOption, jsonOption,
        ],
      },
      transition: {
        summary: 'Transition a task status through one guarded field mutation.',
        usage: 'agenticloop task-body transition --issue <number> --status <status> --expect-digest <digest> (--dry-run|--yes) [--dispatch-packet <path>] [--base <ref>|--base-paths <path>] [--dependencies <path>] [--label <name>] [options]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('status', 'string', 'Target status. Required.'), opt('expect-digest', 'string', 'Exact digest printed by task-body fetch. Required.'), opt('repo', 'string', 'Target repository.'), opt('note', 'string', 'Explanatory note. Required for blocked or needs_context; an in-progress note requests a new role start and requires a fresh dispatch packet.'), opt('base', 'string', 'Explicit Git base required for agent-ready; no default branch is selected.'), opt('base-paths', 'string', 'Explicit JSON base-tree path inventory required for agent-ready.'), opt('dependencies', 'string', 'Exact JSON dependency-status snapshot required for agent-ready.'), opt('dispatch-packet', 'string', 'Canonical "task prepare-dispatch" packet JSON. Required for every requested role start, including already-current in-progress; missing, stale, malformed, or consumed packets are refused without mutation.'), opt('label', 'string', 'Owned status label to reconcile after the body write. Repeatable.', { multiple: true }), dryRunOption, yesOption, jsonOption],
      },
      'establish-baseline': {
        summary: 'Create a separately carried trusted task-contract baseline record.',
        usage: 'agenticloop task-body establish-baseline --issue <number> --expect-digest <digest> --authority <ref> --actor <login> (--dry-run|--yes) [options]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('expect-digest', 'string', 'Exact current task-body digest. Required.'), opt('authority', 'string', 'Authorization reference. Required.'), opt('actor', 'string', 'Verified Maintainer login. Required.'), opt('repo', 'string', 'Target repository.'), dryRunOption, yesOption, jsonOption],
      },
      'authorize-correction': {
        summary: 'Create a separately carried trusted task-contract correction record for one candidate.',
        usage: 'agenticloop task-body authorize-correction --issue <number> --body-file <path> --expect-digest <digest> --reason <text> --authority <ref> --actor <login> (--dry-run|--yes) [options]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('body-file', 'string', 'Candidate task body. Required.'), opt('expect-digest', 'string', 'Exact current task-body digest. Required.'), opt('reason', 'string', 'Correction reason. Required.'), opt('authority', 'string', 'Authorization reference. Required.'), opt('actor', 'string', 'Verified Maintainer login. Required.'), opt('repo', 'string', 'Target repository.'), dryRunOption, yesOption, jsonOption],
      },
    },
  },
  'commit-attribution': {
    summary: 'Read-only Engineer commit-trailer validation and canonical repair guidance.',
    usage: 'agenticloop commit-attribution check --task <id> [--role <orchestrator|maintainer|engineer|auditor>] [--commit <ref>] [--message-file <path>] [--json]',
    subcommands: {
      check: {
        summary: 'Check Task/Agent trailers without amending, committing, pushing, or force-pushing.',
        options: [targetOption(), opt('task', 'string', 'Expected task id. Required.'), opt('role', 'string', 'Expected canonical workflow role.', { enum: ['orchestrator', 'maintainer', 'engineer', 'auditor'] }), opt('commit', 'string', 'Commit ref (default: HEAD).'), opt('message-file', 'string', 'Read a commit message from a local file.'), jsonOption],
      },
      'repair-record-render': {
        summary: 'Validate and render a durable attribution-repair record without mutating Git.',
        options: [targetOption(), opt('record', 'string', 'Input JSON repair record. Required.'), opt('output', 'string', 'Optional rendered output file.'), jsonOption],
      },
      'repair-record-lint': {
        summary: 'Read-only lint for a durable attribution-repair record JSON file.',
        options: [targetOption(), opt('record', 'string', 'Input JSON repair record. Required.'), jsonOption],
      },
    },
  },
  'github-checkpoint': {
    summary: 'Read-only checkpoint rendering and bounded checkpoint-repair planning.',
    usage: 'agenticloop github-checkpoint <render|repair-plan> --pr <number> [options]',
    subcommands: {
      render: {
        summary: 'Render a checkpoint from authenticated ordered history; never post it.',
        options: [opt('pr', 'string', 'Pull request number. Required.'), opt('issue', 'string', 'Linked task issue number override.'), opt('repo', 'string', 'Target repository.'), opt('direction', 'string', 'Checkpoint direction.', { enum: ['targeted_revision', 'needs_context', 'blocked'] }), opt('cause', 'string', 'Checkpoint cause.'), opt('target', 'string', 'Required target for targeted_revision.'), opt('reference', 'string', 'Required reference for needs_context or blocked.'), jsonOption],
      },
      'repair-plan': {
        summary: 'Validate and render one bounded same-author repair carrier; never post it.',
        options: [opt('pr', 'string', 'Pull request number. Required.'), opt('source', 'string', 'Exact malformed comment or review id. Required.'), opt('issue', 'string', 'Linked task issue number override.'), opt('repo', 'string', 'Target repository.'), jsonOption],
      },
    },
  },
  'github-review-prepare': {
    summary: 'Fail-closed read-only preparation with a mandatory, exact-head review-entry receipt.',
    usage: 'agenticloop github-review-prepare --pr <number> [--issue <number>] [--repo <owner/name>] [--workspace <path>] [--packet <path>] [--target <dir>] [--json]',
    options: [targetOption(), opt('pr', 'string', 'Pull request number. Required.'), opt('issue', 'string', 'Linked task issue number override.'), opt('repo', 'string', 'Target repository.'), opt('workspace', 'string', 'Optional workspace that must resolve to the final dispatched head.'), opt('packet', 'string', 'Revalidate a previously emitted packet and its mandatory receipt against complete current PR/task state before dispatch (read-only).'), jsonOption],
  },
  doctor: {
    summary: 'Read-only diagnosis: setup checklist, adapter state, and next commands.',
    usage: 'agenticloop doctor [--target <dir>]',
    options: [targetOption('Directory to inspect (default: current directory).')],
  },
  status: {
    summary: 'Show configured adapters or a deterministic lifecycle orientation snapshot.',
    usage: 'agenticloop status [--target <dir>] [--json]',
    options: [targetOption('Directory containing agenticloop.json (default: current).'), jsonOption],
  },
  activate: {
    summary: 'Authorize existing tasks for dispatch through an explicit interactive operator confirmation.',
    usage: 'agenticloop activate <task-id...> | --work-unit <id> [--expires-in-hours <n>] [--repo <owner/name>] [--dry-run] [--json] [--target <dir>]',
    positionals: [{ name: 'task-id', required: false, variadic: true }],
    details: [
      'The universal, host-neutral activation path. It needs no host plugin and never rewrites a task body:',
      'existing task ids, frontmatter, history, and decomposition state are preserved.',
      '',
      '  npx agenticloop activate T-016 T-017',
      '  npx agenticloop activate --work-unit <work-unit-id>',
      '',
      'The command prints the exact tasks, carriers, contract digests, repository, work unit, and resulting',
      'assurance, then requires the operator to type an explicit confirmation. It refuses non-interactive',
      'invocation and under CI: there is deliberately no --yes flag, because that would let an agent mint',
      'this assurance grade silently.',
      '',
      'Resulting activation assurance is operator_confirmed: procedural, local-user assurance signed with a',
      'key held outside the target repository. It is not equivalent to an isolated host signer and does not',
      'resist arbitrary code running as the same OS user. Hardened mode still requires host_signed activation.',
      '',
      'A work-unit activation derives child bindings only from current committed Maintainer-attributed',
      'decomposition evidence, and only for canonical ready-set members.',
      '',
      'Exit statuses: 0 activation written, dry run, or operator cancellation; 1 refusal or write failure; 2 invalid usage.',
    ],
    options: [
      targetOption(),
      opt('work-unit', 'string', 'Activate the canonical ready set of one work unit from its committed decomposition source. Mutually exclusive with explicit task ids.'),
      opt('expires-in-hours', 'string', 'Grant lifetime in hours (default: 12, maximum: 168).'),
      opt('repo', 'string', 'GitHub repository in owner/name form. Defaults to the authenticated current repository for the GitHub backend.'),
      dryRunOption,
      jsonOption,
    ],
  },
  activation: {
    summary: 'Inspect, revoke, and provision durable activation authority.',
    usage: 'agenticloop activation <status|revoke|provision-key> [options]',
    subcommands: {
      status: {
        summary: 'Report every stored task activation binding, its usability against current state, and the effective policy.',
        usage: 'agenticloop activation status [<task-id>] [--repo <owner/name>] [--host-trust-store <expected-path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'task-id', required: false }],
        options: [targetOption(), opt('repo', 'string', 'GitHub repository in owner/name form.'), hostTrustStoreOption, jsonOption],
      },
      revoke: {
        summary: 'Revoke one activation grant. Every task binding derived from it is refused by dispatch.',
        usage: 'agenticloop activation revoke <grant-id> [--reason <text>] [--json] [--target <dir>]',
        positionals: [{ name: 'grant-id', required: true }],
        options: [targetOption(), opt('reason', 'string', 'Human-readable revocation reason.'), jsonOption],
      },
      'provision-key': {
        summary: 'Create the operator activation confirmation key for this target, outside the repository. Idempotent.',
        usage: 'agenticloop activation provision-key [--json] [--target <dir>]',
        details: [
          'Activation provisions this key lazily on first use, so running it separately is optional.',
          'The private key is stored under a per-user root derived from the canonical repository identity and',
          'is never written into the target repository. POSIX hosts get 0700/0600 owner-only permissions;',
          'Windows inherits the parent profile ACL, which the toolkit reports rather than claims to enforce.',
        ],
        options: [targetOption(), jsonOption],
      },
      'identity-status': {
        summary: 'Report the current repository authority identity and any operator state left under a superseded spelling. Read-only.',
        usage: 'agenticloop activation identity-status [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        details: [
          'Operator activation keys and external revocation tombstones are addressed by a digest of the target',
          'repository identity, so a change to how that identity is derived relocates existing records.',
          'This command reports the current identity, every superseded spelling that still holds operator state,',
          'and whether a migration is available, already applied, or blocked by conflicting keys.',
        ],
        options: [targetOption(), jsonOption],
      },
      'migrate-identity': {
        summary: 'Copy operator activation key material forward from a superseded repository identity. Idempotent.',
        usage: 'agenticloop activation migrate-identity [--json] [--target <dir>]',
        details: [
          'Copies exactly one superseded operator activation key to the current identity, verifies that the copy',
          'loads as this repository key, and writes a receipt outside the target repository. Superseded key files',
          'and revocation tombstones are preserved, never deleted.',
          '',
          'Revocation tombstones need no migration: deny evidence is always read as the union of the current and',
          'superseded registries, and any unreadable record in any of them fails the read closed.',
          '',
          'When more than one superseded key claims this repository, the command refuses and reports both, because',
          'choosing which operator identity survives is not a decision the toolkit may make.',
          '',
          'Exit statuses: 0 migrated, already current, or nothing to migrate; 1 conflict or write failure.',
        ],
        options: [targetOption(), jsonOption],
      },
    },
  },
  'host-trust': {
    summary: 'Inspect and provision the operator-held host adapter trust store for hardened activation and returns.',
    usage: 'agenticloop host-trust <status|register|rotate|revoke> [options]',
    details: [
      'The store lives outside the target repository, at a path derived from the canonical repository identity.',
      'It pins the public half of a host adapter Ed25519 key plus the exact capabilities that adapter is trusted for.',
      '',
      'There is deliberately no command that signs an activation capture or a return receipt with the protected',
      'host key. The toolkit never holds that key; an isolated signer does. A registered supported capability is',
      'usable only through an authenticated out-of-process host boundary.',
    ],
    subcommands: {
      status: {
        summary: 'Report the pinned adapters, authorities, and effective activation policy. Read-only.',
        usage: 'agenticloop host-trust status [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        options: [targetOption(), jsonOption],
      },
      register: {
        summary: 'Pin a new host adapter public key and its capabilities.',
        usage: 'agenticloop host-trust register <adapter-id> --key-id <id> --public-key <base64-or-path> [--activation-capture <supported|unsupported>] [--return-receipt <supported|unsupported>] [--dry-run] [--json] [--target <dir>]',
        positionals: [{ name: 'adapter-id', required: true }],
        options: [
          targetOption(),
          opt('key-id', 'string', 'Operator-chosen key identity. Required.'),
          opt('public-key', 'string', 'Base64 SPKI DER Ed25519 public key, or a path to a file containing one. A private key is refused.'),
          opt('activation-capture', 'string', "Capability state for parser-owned activation capture (default: unsupported).", { enum: ['supported', 'unsupported'] }),
          opt('return-receipt', 'string', 'Capability state for authenticated host return receipts (default: unsupported).', { enum: ['supported', 'unsupported'] }),
          dryRunOption,
          jsonOption,
        ],
      },
      rotate: {
        summary: 'Replace the pinned key and capabilities of an already-registered adapter.',
        usage: 'agenticloop host-trust rotate <adapter-id> --key-id <id> --public-key <base64-or-path> [--activation-capture <supported|unsupported>] [--return-receipt <supported|unsupported>] [--dry-run] [--json] [--target <dir>]',
        positionals: [{ name: 'adapter-id', required: true }],
        options: [
          targetOption(),
          opt('key-id', 'string', 'New operator-chosen key identity. Required.'),
          opt('public-key', 'string', 'New base64 SPKI DER Ed25519 public key, or a path to a file containing one.'),
          opt('activation-capture', 'string', 'Capability state for parser-owned activation capture (default: unsupported).', { enum: ['supported', 'unsupported'] }),
          opt('return-receipt', 'string', 'Capability state for authenticated host return receipts (default: unsupported).', { enum: ['supported', 'unsupported'] }),
          dryRunOption,
          jsonOption,
        ],
      },
      revoke: {
        summary: 'Remove a pinned adapter. Every capture and receipt signed by its key then fails authentication.',
        usage: 'agenticloop host-trust revoke <adapter-id> [--dry-run] [--json] [--target <dir>]',
        positionals: [{ name: 'adapter-id', required: true }],
        options: [targetOption(), dryRunOption, jsonOption],
      },
    },
  },
  task: {
    summary: 'Manage files-backed task records and canonical handoff preparation.',
    usage: 'agenticloop task <list|show|lint|new|materialize|establish-baseline|authorize-correction|prepare-decomposition|prepare-dispatch|role-start|handoff-preflight|refresh-handoff-receipt|refresh-handoff-evidence|commit-message|attempt-status|abandon-attempt|adopt-historical|readiness-plan|readiness-apply|measure|explain|prepare-return|verify-return|check-evidence-init|check-evidence-show|check-evidence-update|evidence|review-prepare|status> [options]',
    subcommands: {
      list: {
        summary: 'List task records.',
        usage: 'agenticloop task list [--status <s>] [--json] [--target <dir>]',
        options: [
          targetOption(),
          opt('status', 'string', 'Filter by task status.'),
          jsonOption,
        ],
      },
      show: {
        summary: 'Read one task record without mutation.',
        usage: 'agenticloop task show <id> [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), jsonOption],
      },
      lint: {
        summary: 'Lint task records.',
        usage: 'agenticloop task lint [<task-id>] [--expect-task-digest <digest>] [--base <ref> | --base-paths <path>] [--dependencies <path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'task-id', required: false }],
        options: [
          targetOption(),
          opt('expect-task-digest', 'string', 'Exact SHA-256 digest the named task record must still hold. Read-only.'),
          opt('base', 'string', 'Optional exact authoring-readiness base ref; requires a named task and --dependencies.'),
          opt('base-paths', 'string', 'Optional exact authoring-readiness base inventory; requires a named task and --dependencies.'),
          opt('dependencies', 'string', 'Optional exact committed dependency snapshot for shared authoring-readiness diagnostics.'),
          jsonOption,
        ],
      },
      new: {
        summary: 'Create a task record.',
        usage: 'agenticloop task new <title> (--activation-input <capture.json> [--host-trust-store <expected-path>] | --scaffold) [--id <id>] [--target <dir>]',
        positionals: [{ name: 'title', required: true, variadic: true }],
        options: [
          targetOption(),
          opt('id', 'string', 'Explicit task id. Omit to allocate the next default T-### id.'),
          opt('activation-input', 'string', 'Host-signed activation-capture artifact. Only a supported and verified capture from the fixed operator trust registry can authorize creation; no shipped adapter qualifies.'),
          hostTrustStoreOption,
          opt('scaffold', 'boolean', 'Create generic non-activated task scaffolding. Before dispatch, activate the existing task with agenticloop activate; a protected host adapter is optional unless hardened policy requires host_signed assurance.'),
          jsonOption,
        ],
      },
      materialize: {
        summary: 'Deterministically materialize one canonical draft task from one unambiguous source work package plus Maintainer-owned judgment.',
        usage: 'agenticloop task materialize <id> --source <plan.json> --package <package-id> --judgment <judgment.json> --yes [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('source', 'string', 'Target-relative source plan JSON with sourceRevision and workPackages.'),
          opt('package', 'string', 'Exact work-package id; ambiguous or missing selection is refused.'),
          opt('judgment', 'string', 'Target-relative Maintainer judgment JSON for scope, state, files, parallel safety, notes, criteria, and checks.'),
          yesOption,
          jsonOption,
        ],
      },
      'readiness-plan': {
        summary: 'Report the complete ordered readiness sequence for one task or one bounded work-unit task set. Read-only; writes nothing.',
        usage: 'agenticloop task readiness-plan (<id> | --tasks <first-id> [more-id ...]) [--actor <git-author>] [--authority <kind:reference>] [--work-unit <id>] [--base <ref> | --base-paths <path>] [--dependencies <path> | --dependencies-by-task <map.json>] [--max-age-seconds <n>] [--route <route>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: false, variadic: true }],
        options: [
          targetOption(),
          opt('tasks', 'string', 'Start an explicit bounded task set; subsequent task ids are operands and must be in canonical lexical order.'),
          opt('actor', 'string', 'Expected committed Git author. Required for an applicable plan; never fabricated.'),
          opt('authority', 'string', 'Durable authorization reference as <kind>:<reference>. Required for an applicable plan; never fabricated.'),
          opt('work-unit', 'string', 'Durable work-unit identity such as milestone:M2. Required for an applicable plan; a per-task fallback is refused.'),
          opt('base', 'string', 'Base ref resolved to its exact immutable tree identity. Mutually exclusive with --base-paths.'),
          opt('base-paths', 'string', 'Target-relative JSON path inventory used as base evidence. Mutually exclusive with --base.'),
          opt('dependencies', 'string', 'Exact committed Maintainer-attributed dependency-status snapshot. Required for an applicable plan.'),
          opt('dependencies-by-task', 'string', 'Target-relative JSON object mapping each selected task id to its exact committed dependency snapshot.'),
          opt('max-age-seconds', 'string', 'Override the decomposition freshness policy bound by the plan.'),
          opt('route', 'string', 'Decomposition route bound by the plan. Defaults to serial.'),
          opt('rescan-trigger', 'string', 'Override the semantic rescan trigger bound by the plan.'),
          jsonOption,
        ],
      },
      'readiness-apply': {
        summary: 'Settle one reviewed task or an indivisible work-unit readiness plan as a single transaction and at most one Maintainer-attributed commit. One armed member refuses the whole work unit; partial apply is unsupported. Never activates.',
        usage: 'agenticloop task readiness-apply [<compatible-id>] --plan <path> (--dry-run | --yes) [--json] [--target <dir>]',
        receiptRevalidation: 'read-only-before-explicit-apply',
        positionals: [{ name: 'id', required: false }],
        options: [
          targetOption(),
          opt('plan', 'string', 'Target-relative executable readiness plan JSON produced by task readiness-plan. Required.'),
          dryRunOption,
          yesOption,
          jsonOption,
        ],
      },
      measure: {
        summary: 'Report bounded, derived operational measurement for one task. Read-only; nothing is stored.',
        usage: 'agenticloop task measure <id> [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), jsonOption],
      },
      explain: {
        summary: 'Explain bounded current task facts and action verdicts. Read-only; grants no authority and writes nothing.',
        usage: 'agenticloop task explain <id> [--action <action-id>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('action', 'string', 'Limit the explanation to one stable action id.'),
          jsonOption,
        ],
      },
      'adopt-historical': {
        summary: 'Record a truthful reduced-assurance terminal adoption for work that predates the canonical lifecycle.',
        usage: 'agenticloop task adopt-historical <id> --artifact <commit> --integration <kind:reference> --integration-commit <commit> --audit <kind:reference> --authority <kind:reference> --reason <text> --missing <class> [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('artifact', 'string', 'Exact accepted implementation commit. Required.'),
          opt('integration', 'string', 'Integration identity as <git_merge|git_branch_containment|pull_request>:<reference>. Required.'),
          opt('integration-commit', 'string', 'Exact commit proving the artifact landed. Required.'),
          opt('audit', 'string', 'Independent audit reference in <kind>:<reference> form. Required.'),
          opt('authority', 'string', 'Durable human adoption authority in <kind>:<reference> form. Required.'),
          opt('reason', 'string', 'Why canonical execution evidence does not exist. Required and recorded verbatim.'),
          opt('missing', 'string', 'One evidence class this task genuinely lacks. Repeatable and required.', { multiple: true }),
          jsonOption,
        ],
      },
      'abandon-attempt': {
        summary: 'Explicitly discard one live execution attempt so a new dispatch packet may be minted.',
        usage: 'agenticloop task abandon-attempt <id> --attempt <attempt-id> --disposition <type> --reason <text> --authority <kind:reference> [--actor-role <role>] [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('attempt', 'string', 'Exact live execution attempt identity reported by the conservation refusal. Required.'),
          opt('disposition', 'string', 'abandoned, superseded_before_work, tooling_failed, or superseded_by_maintainer_repair. Defaults to abandoned.'),
          opt('actor-role', 'string', 'Authoring role. Required as maintainer for Maintainer-repair supersession.'),
          opt('reason', 'string', 'Why the attempt cannot reach a canonical return. Required and recorded verbatim.'),
          opt('authority', 'string', 'Durable authorization reference in <kind>:<reference> form. Required.'),
          jsonOption,
        ],
      },
      'record-tooling-failure': {
        summary: 'Persist one bounded tooling-failure observation and evaluate the identical-failure retry bound.',
        usage: 'agenticloop task record-tooling-failure <id> --attempt <attempt-id> --input <path> [--budget <n>] [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('attempt', 'string', 'Exact execution attempt identity. Required.'),
          opt('input', 'string', 'Target-relative closed tooling-failure JSON input. Required.'),
          opt('budget', 'string', 'Maximum identical failure observations; default 2 means the first permits one retry and the second stops.'),
          jsonOption,
        ],
      },
      'commit-message': {
        summary: 'Write a canonically trailered commit message file for one workflow commit class. Never commits.',
        usage: 'agenticloop task commit-message <id> --class <commit-class> --subject <text> --output <path> [--body <text> | --body-file <path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        details: [
          'The commit class decides the attributed role; the emitted file always ends with one final contiguous',
          'Task/Agent trailer block. Commit it with git commit -F <path>: repeated -m arguments insert a blank line',
          'between every paragraph and produce a message the attribution grammar rejects.',
        ],
        options: [
          targetOption(),
          opt('class', 'string', 'Canonical workflow commit class. Required; it decides the attributed role.', { enum: [...COMMIT_MESSAGE_CLASS_LIST] }),
          opt('subject', 'string', 'Single-line commit subject. Required.'),
          opt('body', 'string', 'Optional commit body paragraph.'),
          opt('body-file', 'string', 'Optional target-relative file whose contents become the commit body.'),
          opt('output', 'string', 'Target-relative message file to write atomically. Required.'),
          jsonOption,
        ],
      },
      'prepare-product-commit': {
        summary: 'Derive exact task-owned product paths after work and write the canonical product commit message.',
        usage: 'agenticloop task prepare-product-commit <id> --packet <path> --subject <text> --message-output <path> [--json] [--target <dir>]',
        receiptRevalidation: 'read-only-except-message-file',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(), opt('packet', 'string', 'Consumed Engineer packet. Required.'),
          opt('subject', 'string', 'Canonical product commit subject. Required.'),
          opt('message-output', 'string', 'Target-relative commit message output under project scratch. Required.'),
          jsonOption,
        ],
      },
      'attempt-status': {
        summary: 'Report the execution attempts recorded for one task and whether a new packet may be minted.',
        usage: 'agenticloop task attempt-status <id> [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), jsonOption],
      },
      'establish-baseline': {
        summary: 'Append a files-backend baseline payload; it becomes trusted only after a separate commit.',
        usage: 'agenticloop task establish-baseline <id> --actor <git-author> --authority <kind:reference> [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('actor', 'string', 'Expected committed Git author. Required.'), opt('authority', 'string', 'Durable authorization reference. Required.'), jsonOption],
      },
      'authorize-correction': {
        summary: 'Append a files-backend correction payload against the committed trusted chain; it becomes trusted only after a separate commit.',
        usage: 'agenticloop task authorize-correction <id> --expect-prior-digest <digest> --reason <text> --authority <kind:reference> --actor <git-author> [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('expect-prior-digest', 'string', 'Terminal digest of the committed trusted chain. Required.', { valueName: 'digest' }),
          opt('reason', 'string', 'Human-readable correction reason. Required.'),
          opt('authority', 'string', 'Durable authorization reference. Required.'),
          opt('actor', 'string', 'Expected committed Git author. Required.'),
          jsonOption,
        ],
      },
      'prepare-decomposition': {
        summary: 'Enumerate the task surface, run the parallel scan, and emit a committable decomposition source. Read-only without --output; mutating with --output.',
        usage: 'agenticloop task prepare-decomposition <id> --work-unit <id> --source-ref <path> --source-revision <ref> (--base <ref> | --base-paths <path>) --dependencies <path> [--repo <owner/name>] [--route <serial|parallel>] [--observed-at <instant>] [--max-age-seconds <n>] [--rescan-trigger <text>] [--output <path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only-without-output',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('work-unit', 'string', 'Exact bounded work-unit identity the scan covers. Required.'),
          opt('source-ref', 'string', 'Safe repository-relative path the emitted decomposition source will be committed to. Required.'),
          opt('source-revision', 'string', 'Exact decomposition source revision (for example git-commit:<sha>). Required.'),
          opt('base', 'string', 'Explicit Git base whose resolved tree supplies the base-path inventory.'),
          opt('base-paths', 'string', 'Explicit JSON base-tree inventory. Mutually exclusive with --base.'),
          opt('dependencies', 'string', 'Committed Maintainer-attributed dependency-status snapshot bound to the ready set. Required.'),
          opt('repo', 'string', 'GitHub repository in owner/name form. Defaults to the authenticated current repository for the GitHub backend.'),
          opt('route', 'string', 'Requested route. A parallel route requires the scan to place the task in a candidate pair.', { enum: ['serial', 'parallel'] }),
          opt('observed-at', 'string', 'ISO-8601 UTC observation instant. Defaults to now.'),
          opt('max-age-seconds', 'string', 'Freshness policy for the observation. Bounded by the trusted maximum.'),
          opt('rescan-trigger', 'string', 'Concrete condition that invalidates this scan.'),
          opt('output', 'string', 'Target-relative path to atomically write the decomposition source JSON. When omitted, the source is emitted to stdout only (read-only mode).'),
          jsonOption,
        ],
      },
      'prepare-dispatch': {
        summary: 'Refetch and bind one backend-selected role dispatch without mutating the task.',
        usage: 'agenticloop task prepare-dispatch <id> (--host <host> --role engineer | --input <dispatch-input.json> | --packet <packet.json> --role engineer) [--output <path>] [--repo <owner/name>] [--host-trust-store <expected-path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('host', 'string', 'Canonical generated host identity used to derive the Engineer assignment from current durable facts. Required for the ordinary no-input producer.'), opt('output', 'string', 'Optional packet output path. With --json, stdout is a closed success result and this path holds the exact packet artifact. Input/output paths are target-relative and must remain inside the selected target.'), opt('input', 'string', 'Advanced compatibility input for projects where durable source selectors are unavailable. Its route is validated normally; it may not override refetched durable authority. Path is target-relative and must remain inside the selected target.'), opt('packet', 'string', 'Existing dispatch packet to revalidate read-only before receiver mutation. Path is target-relative and must remain inside the selected target.'), opt('role', 'string', 'Immutable receiving role required for ordinary and --packet routes. The advanced --input compatibility route preserves its existing no-host invocation.', { enum: ['engineer'] }), opt('return-adapter', 'string', 'Exact authenticated protected-boundary adapter to bind for host role-return receipts. Required when several eligible adapters exist; hardened mode requires one.'), opt('prior-receipts', 'string', 'JSON array of prior-gate or setup task-mutation receipts that must be resolved and undrifted before dispatch. Path is target-relative and must remain inside the selected target.'), opt('repo', 'string', 'GitHub repository in owner/name form. Defaults to the authenticated current repository for the GitHub backend.'), hostTrustStoreOption, jsonOption],
      },
      'role-start': {
        summary: 'Atomically combine files-backend role start (in-progress transition), dispatch consumption, and required-check evidence initialization into one guarded transaction.',
        usage: 'agenticloop task role-start <id> --packet <packet.json> [--check-evidence-output .agenticloop/tmp/<id>-checks.json] [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        details: [
          'Files-backend only. The canonical single-command entry point for Engineer delegation:',
          '  1. validates the dispatch packet against current target, repository, task contract, and policy;',
          '  2. transitions the task carrier to in-progress with a recognized role start;',
          '  3. records the dispatch consumption and retires superseded attempts;',
          '  4. initializes required-check evidence scaffolding from the packet inventory.',
          '',
          'All four steps are one atomic guarded transaction.',
          'The caller must not pass --expect-digest; it is derived from the packet.',
          '',
          'Partial failure returns a typed receipt with exact recovery guidance and',
          'never implies success. An exact idempotent retry (all bound state identical)',
          'reports already_current; a retry with any changed bound state fails closed.',
          '',
          'Returns an executable nextSequence for evidence updates, return preparation,',
          'and verification. For the GitHub backend, use task-body transition and',
          'task check-evidence-init independently.',
          '',
          'Exit statuses: 0 role start committed or already_current; 1 refusal or write failure; 2 invalid usage.',
        ],
        options: [
          targetOption(),
          opt('packet', 'string', 'Canonical dispatch packet produced by task prepare-dispatch. Required. Path is target-relative and confined.'),
          opt('check-evidence-output', 'string', 'Optional mutable aggregate path under .agenticloop/tmp/. Defaults to .agenticloop/tmp/<id>-checks.json; destinations outside scratch are refused.'),
          hostTrustStoreOption,
          jsonOption,
        ],
      },
      'handoff-preflight': {
        summary: 'Read-only pre-delegation prerequisite check: report every ordinary prerequisite and one safe repair before dispatch packet assembly.',
        usage: 'agenticloop task handoff-preflight <id> [--host <host>] [--host-trust-store <expected-path>] [--return-adapter <id>] [--repair-plan <path>] [--output <path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('host', 'string', 'Canonical generated host identity for host-role capability resolution. Required when multiple adapter hosts are configured.'), hostTrustStoreOption, opt('return-adapter', 'string', 'Exact authenticated protected-boundary adapter to bind for host role-return receipts. Required when several eligible adapters exist; hardened mode requires one.'), opt('repair-plan', 'string', 'Write a bounded derived-evidence refresh plan to this target-relative path.'), opt('output', 'string', 'Write the preflight result JSON to this target-relative path. Atomic write; directory is created if needed.'), jsonOption],
      },
      'refresh-handoff-evidence': {
        summary: 'Compatibility alias for refresh-handoff-receipt.',
        usage: 'agenticloop task refresh-handoff-evidence <id> --plan <path> --yes [--host-trust-store <expected-path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only-before-explicit-apply',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), hostTrustStoreOption, opt('plan', 'string', 'Target-relative handoff refresh plan JSON. Required.'), yesOption, jsonOption],
      },
      'refresh-handoff-receipt': {
        summary: 'Write one current, digest-bound handoff receipt and report its pending-commit state.',
        usage: 'agenticloop task refresh-handoff-receipt <id> --plan <path> --yes [--host-trust-store <expected-path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only-before-explicit-apply',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), hostTrustStoreOption, opt('plan', 'string', 'Target-relative handoff refresh plan JSON. Required.'), yesOption, jsonOption],
      },
      'prepare-return': {
        summary: 'Engineer-only producer: derive a raw implementation-ready or cancellation-blocked role return from current files/Git facts.',
        usage: 'agenticloop task prepare-return <id> --packet <packet.json> --check-evidence <path> --output <path> (--outcome implementation_ready_for_review | --outcome implementation_blocked --blocker-category cancellation_requested --cancellation-evidence <path>) [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('packet', 'string', 'Authentic consumed dispatch packet. Return preparation requires its exact current consumption and carrier lineage before deriving any return fact. Path is target-relative and must remain inside the selected target.'), opt('check-evidence', 'string', 'Canonical required-check evidence JSON created by the check-evidence commands. Path is target-relative and must remain inside the selected target.'), opt('outcome', 'string', 'implementation_ready_for_review derives the ordinary Engineer return; implementation_blocked is supported only for an evidence-bound cancellation claim.', { enum: ['implementation_ready_for_review', 'implementation_blocked'] }), opt('blocker-category', 'string', 'Blocked-return category. This producer supports only cancellation_requested, which requires --cancellation-evidence.'), opt('cancellation-evidence', 'string', 'Agentic Loop-controlled cancellation observation bound to the consumed packet invocation. Required for a cancellation-blocked return; never inferred from host state. Path is target-relative and must remain inside the selected target.'), opt('output', 'string', 'Raw role-return JSON output path, written atomically. With --json stdout is a closed success result; this path holds the exact artifact. Path is target-relative and must remain inside the selected target.'), jsonOption],
      },
      'verify-return': {
        summary: 'Role-return verifier and protected authenticated execution-receipt persistence route.',
        usage: 'agenticloop task verify-return <id> --packet <packet.json> --return <role-return.json> [--from-current-repository | --repository-evidence <evidence.json>] [--producer-receipt <receipt.json> --execution-receipt <receipt.json>] [--cancellation-evidence <path>] [--repo <owner/name>] [--exceptional-verification <request.json> --exceptional-receipt <receipt.json> | --resume-owner <role-id> --redelegation-authority <authority.json> | --recovery-request <recovery.json> --human-disposition <disposition.json> --human-disposition-authority <authority-id> --human-disposition-key-id <key-id>] [--host-trust-store <expected-path>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('packet', 'string', 'Dispatch packet consumed by the raw role return. Required. Path is target-relative and must remain inside the selected target.'),
          opt('return', 'string', 'Raw role-return JSON wire artifact. Required. Path is target-relative and must remain inside the selected target.'),
          opt('from-current-repository', 'boolean', 'Files backend: independently rederive repository evidence from current Git/task facts. Mutually exclusive with --repository-evidence.'),
          opt('repository-evidence', 'string', 'Advanced repository evidence input refetched and revalidated at the return boundary. Path is target-relative and must remain inside the selected target.'),
          opt('cancellation-evidence', 'string', 'Agentic Loop-controlled cancellation observation required when the role return claims a cancellation-blocked outcome; rejected otherwise. Path is target-relative and must remain inside the selected target.'),
          opt('repo', 'string', 'GitHub repository in owner/name form. Defaults to the authenticated current repository for the GitHub backend.'),
           opt('producer-receipt', 'string', 'Ed25519 host-adapter receipt verified against the packet-bound adapter/key from the fixed operator trust registry. Required when the effective policy minimum is host_receipt; omit in standard mode for an explicitly session_reported return. Path is target-relative and confined.'),
           opt('execution-receipt', 'string', 'Protected host-issued execution receipt. Its selector is target-relative and confined; the public CLI verifies it through the external protected host trust boundary and never accepts signing material or self-attestation.'),
          opt('exceptional-verification', 'string', 'Closed exceptional-verification request bound to this exact authenticated role return and dispatch packet. Path is target-relative and confined.'),
          opt('exceptional-receipt', 'string', 'Pinned host receipt authenticating the exact exceptional-verification payload. Required with --exceptional-verification. Path is target-relative and confined.'),
          opt('resume-owner', 'string', `Requested owner for a blocked result. Defaults to the authenticated producer and requires exact redelegation authority when changed. Default registry: ${WORKFLOW_ROLE_LIST}; target workflowRoles extensions are accepted after config validation.`),
          opt('redelegation-authority', 'string', 'Signed blocked-result redelegation JSON verified against a schemaVersion 2 operator trust authority. Path is target-relative and confined.'),
          opt('recovery-request', 'string', 'Exact destructive, scope-changing, or host-state recovery request JSON. Path is target-relative and confined.'),
          opt('human-disposition', 'string', 'Signed human-disposition JSON authorizing the exact recovery request. Path is target-relative and confined.'),
          opt('human-disposition-authority', 'string', 'Expected operator-pinned authorityId for --human-disposition. Required with that record.'),
          opt('human-disposition-key-id', 'string', 'Expected operator-pinned keyId for --human-disposition. Required with that record.'),
          hostTrustStoreOption,
          jsonOption,
        ],
      },
      'check-evidence-init': {
        summary: 'Create canonical not-run evidence scaffolding from a dispatch packet.',
        usage: 'agenticloop task check-evidence-init <id> --packet <packet.json> [--output .agenticloop/tmp/<id>-checks.json] [--expect-existing-digest <sha256>] [--supersession-authority <kind:ref>] [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('packet', 'string', 'Dispatch packet path, target-relative and confined to the selected target.'), opt('output', 'string', 'Optional mutable aggregate path under .agenticloop/tmp/. Defaults to .agenticloop/tmp/<id>-checks.json and is never committed.'), opt('expect-existing-digest', 'string', 'Exact sha256 digest required to replace a different existing scaffold.'), opt('supersession-authority', 'string', 'Typed Maintainer authority <kind:reference> required with replacement.'), jsonOption],
      },
      'check-evidence-show': {
        summary: 'Validate and print canonical required-check evidence for a dispatch packet.',
        usage: 'agenticloop task check-evidence-show <id> --packet <packet.json> [--input .agenticloop/tmp/<id>-checks.json] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('packet', 'string', 'Dispatch packet path, target-relative and confined to the selected target.'), opt('input', 'string', 'Optional mutable aggregate under .agenticloop/tmp/. Defaults to .agenticloop/tmp/<id>-checks.json; tracked aggregates are refused.'), jsonOption],
      },
      'check-evidence-update': {
        summary: 'Atomically update one packet-required check observation.',
        usage: 'agenticloop task check-evidence-update <id> --packet <packet.json> [--input .agenticloop/tmp/<id>-checks.json] [--output .agenticloop/tmp/<id>-checks.json] --check RC-N --outcome <passed|failed|blocked|not_run> --evidence <text> [--exit-code <n>] [--execution-output .agenticloop/checks/<id>/<check>.execution.json] [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), opt('packet', 'string', 'Dispatch packet path, target-relative and confined to the selected target.'), opt('input', 'string', 'Optional existing mutable aggregate under .agenticloop/tmp/. Defaults to .agenticloop/tmp/<id>-checks.json.'), opt('output', 'string', 'Optional updated mutable aggregate under .agenticloop/tmp/. Defaults to .agenticloop/tmp/<id>-checks.json and is never committed.'), opt('check', 'string', 'Packet required-check id to update. Required.'), opt('outcome', 'string', 'Observed check outcome. Required.', { enum: ['passed', 'failed', 'blocked', 'not_run'] }), opt('evidence', 'string', 'Bounded observation evidence. Required.'), opt('exit-code', 'string', 'Command check exit code; required for non-passing command observations.'), opt('execution-output', 'string', 'Optional exact immutable artifact path .agenticloop/checks/<task-id>/<check-id>.execution.json. It defaults there; the CLI executes the packet command as inert argv at the target root with a five-minute timeout.'), jsonOption],
      },
      evidence: {
        summary: 'Record one bounded role-owned task-evidence mutation through the carrier lineage.',
        usage: 'agenticloop task evidence <id> --class <implementation_artifact_evidence|implementation_summary_evidence|implementation_outcome_evidence|structured_task_evidence> --expect-digest <digest> [--input <path>] [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [
          targetOption(),
          opt('class', 'string', 'Closed task evidence mutation class. Required.', { enum: ['implementation_artifact_evidence', 'implementation_summary_evidence', 'implementation_outcome_evidence', 'structured_task_evidence'] }),
          opt('expect-digest', 'string', 'Exact currentCarrierDigest before mutation. Required.'),
          opt('product-head', 'string', 'Exact current product Git head. Required for implementation_artifact_evidence.'),
          opt('summary', 'string', 'Engineer implementation summary. Required for implementation_summary_evidence.'),
          opt('check-evidence', 'string', 'Bounded required-check evidence summary. Required for implementation_summary_evidence.'),
          opt('outcome', 'string', 'Non-authoritative Engineer outcome. Required for implementation_outcome_evidence.', { enum: ['implementation_ready_for_review', 'implementation_blocked'] }),
          opt('input', 'string', 'Target-relative closed structured task-evidence JSON. Required for structured_task_evidence.'),
          jsonOption,
        ],
      },
      'review-prepare': {
        summary: 'Prepare one files-backed review entry from a current verified return and carrier lineage.',
        usage: 'agenticloop task review-prepare <id> [--json] [--target <dir>]',
        positionals: [{ name: 'id', required: true }],
        options: [targetOption(), jsonOption],
      },
      status: {
        summary: 'Update task status.',
        usage: 'agenticloop task status <id> <status> --expect-digest <digest> [--dispatch-packet <path>] [--note <text>] [--base <ref>] [--base-paths <path>] [--dependencies <path>] [--block-category <category>] [--target <dir>]',
        positionals: [{ name: 'id', required: true }, { name: 'status', required: true }],
        options: [
          targetOption(),
          opt('expect-digest', 'string', 'Exact SHA-256 digest of the current task record. Required before mutation.'),
          opt('dispatch-packet', 'string', 'Canonical "task prepare-dispatch" packet JSON. Required for every requested role start, including already-current in-progress; missing, stale, malformed, or consumed packets are refused without mutation.'),
          opt('note', 'string', 'Append a dated line under ## Comments. With in-progress this requests a new role start and requires a fresh dispatch packet.'),
          opt('block-category', 'string', 'Required when setting status to blocked.'),
          opt('base', 'string', 'Explicit Git base required for agent-ready; no default branch is selected.'),
          opt('base-paths', 'string', 'Explicit JSON base-tree inventory required for agent-ready.'),
          opt('dependencies', 'string', 'Exact JSON dependency-status snapshot required for agent-ready.'),
          opt('accept', 'boolean', 'Accepted for compatibility.'),
          jsonOption,
        ],
      },
    },
  },
  audit: {
    summary: 'Manage work-unit audit certificates (new, repair-structure, baseline, report, status, gate, lint, disposition, override, resolve).',
    usage: 'agenticloop audit <new|repair-structure|baseline|report|status|gate|lint|disposition|override|resolve> [options]',
    subcommands: {
      new: {
        summary: 'Create an audit record.',
        usage: 'agenticloop audit new --work-unit <id> --covered-tasks <ids> --artifact <ref> --goal <text> --completion-oracle <text> --evidence <text> [--budget <n>] [--target <dir>]',
        options: [
          targetOption(),
          opt('work-unit', 'string', 'Canonical work-unit identity (phase:4, milestone:M2, epic:x, custom:x, work-unit:x). Required.'),
          opt('covered-tasks', 'string', 'Comma-separated exact covered task ids. Required.'),
          opt('artifact', 'string', 'Exact frozen candidate artifact (commit:<sha>; resolved to the full SHA). Required.'),
          opt('budget', 'string', `Explicit audit budget override (otherwise project default_audit_budget, then built-in ${DEFAULT_AUDIT_BUDGET}).`),
          opt('goal', 'string', 'Concrete work-unit goal statement. Required.'),
          opt('completion-oracle', 'string', 'Observable completion oracle. Required.'),
          opt('evidence', 'string', 'Integrated evidence for the candidate. The CLI adds the structural artifact binding. Required.'),
          jsonOption,
        ],
      },
      'repair-structure': {
        summary: 'Safely repair duplicate or missing canonical audit titles.',
        usage: 'agenticloop audit repair-structure <audit-id|work-unit> [--json] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [targetOption(), jsonOption],
      },
      baseline: {
        summary: 'Rebaseline an audit record after remediation.',
        usage: 'agenticloop audit baseline <audit-id|work-unit> [--artifact <ref>] [--covered-tasks <ids>] [--canonicalize] --evidence <text> [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('artifact', 'string', 'New exact candidate artifact after remediation was integrated (resolved to the full SHA).'),
          opt('covered-tasks', 'string', 'New exact covered task ids. Stale certification is cleared; history is preserved.'),
          opt('canonicalize', 'boolean', 'Migrate a legacy audit record: resolves the existing candidate to its full identity, upgrades the schema, preserves history, clears stale certification. Mutually exclusive with --artifact/--covered-tasks.'),
          opt('migrate-consumption-cause', 'boolean', "Record 'unrecorded_legacy' budget provenance for history entries written before Consumption cause became required. Byte-preserving and idempotent; never invents human authority."),
          opt('evidence', 'string', 'Refreshed integrated evidence bound to the candidate. Required.'),
          jsonOption,
        ],
      },
      report: {
        summary: 'Append one consolidated Auditor report.',
        usage: 'agenticloop audit report <audit-id|work-unit> (--file <path> | --stdin | legacy inline options) [--cause <cause>] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('file', 'string', 'Read one complete auditor_report_v1 JSON document from a path (persists all six perspective bodies losslessly).'),
          opt('stdin', 'boolean', 'Read one complete auditor_report_v1 JSON document from stdin.'),
          opt('verdict', 'string', '[legacy inline] certified, certified_with_accepted_limitations, needs_remediation, needs_human_decision.'),
          opt('invocation-mode', 'string', '[legacy inline] host_subagent or explicit_agent_invocation. A same-session fallback is rejected.'),
          opt('invocation-ref', 'string', '[legacy inline] Unique reference for this Auditor invocation. Reuse is rejected.'),
          opt('artifact', 'string', '[legacy inline] Audited artifact; must equal the frozen candidate.'),
          opt('assessment', 'string', '[legacy inline] One consolidated assessment across all six perspectives.'),
          opt('evidence', 'string', '[legacy inline] Bounded evidence actually checked.'),
          opt('finding-json', 'string', '[legacy inline] JSON array of findings (id, severity, blocking, claim, evidenceRefs, consequence, requiredOutcome, verificationRequired). Recorded as legacy_inline_v1.'),
          opt('cause', 'string', 'Budget-consumption provenance: substantive_audit (default), human_authorized_retry, or other_plan_required. product_invalidation_recovery is declared but unavailable.'),
          opt('consumption-authority', 'string', "Required for --cause human_authorized_retry: a 'human:<identity>' authority reference."),
          opt('consumption-reason', 'string', 'Required for --cause human_authorized_retry: why the human authorized this retry.'),
          opt('consumption-plan', 'string', 'Required for --cause other_plan_required: a bounded plan or reference (max 200 characters).'),
          jsonOption,
        ],
      },
      status: {
        summary: 'Diagnostic audit certification status.',
        usage: 'agenticloop audit status [<audit-id|work-unit>] [--json] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: false }],
        options: [targetOption(), jsonOption],
      },
      gate: {
        summary: 'Fail-closed exact-candidate and exact-task-inventory certification check.',
        usage: 'agenticloop audit gate <audit-id|work-unit> --candidate <artifact> --covered-tasks <ids> [--json] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [targetOption(), opt('candidate', 'string', 'Exact canonical candidate being considered for closeout.'), opt('covered-tasks', 'string', 'Exact comma-separated closeout task inventory.'), jsonOption],
      },
      lint: {
        summary: 'Validate audit records.',
        usage: 'agenticloop audit lint [<audit-id|work-unit>] [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        positionals: [{ name: 'audit-id|work-unit', required: false }],
        options: [targetOption(), jsonOption],
      },
      disposition: {
        summary: 'Record a typed disposition for one run-qualified finding.',
        usage: 'agenticloop audit disposition <audit-id|work-unit> --run <n> --finding <A-0x> --type <type> [--ref <ref>] [--note <text>] [--authority <ref>] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('run', 'string', 'Report run number that produced the finding. Required.'),
          opt('finding', 'string', 'Finding id (A-0x) from that run. Required.'),
          opt('type', 'string', 'remediation_task, change_request, human_decision, accepted_limitation, follow_up, rejected_with_counter_evidence, or no_action. Required.'),
          opt('ref', 'string', 'Durable reference (task id, improvement id, decision id, or URL).'),
          opt('note', 'string', 'Bounded single-line reason. Required for no_action.'),
          opt('authority', 'string', 'Maintainer or human provenance. Required for no_action.'),
          jsonOption,
        ],
      },
      override: {
        summary: 'Increase an audit budget with recorded authority.',
        usage: 'agenticloop audit override <audit-id|work-unit> --budget <n> --authority <ref> [--note <text>] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('budget', 'string', 'New audit budget; must increase the current value.'),
          opt('authority', 'string', 'Recorded authority as "human: <identity>". Required.'),
          opt('note', 'string', 'Optional note appended under ## Comments.'),
          jsonOption,
        ],
      },
      resolve: {
        summary: 'Record a human decision for a blocked audit.',
        usage: 'agenticloop audit resolve <audit-id|work-unit> --authority <ref> --note <text> [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('authority', 'string', 'Recorded authority as "human: <identity>". Required.'),
          opt('note', 'string', 'Human decision and direction for the next audit. Required.'),
          jsonOption,
        ],
      },
    },
  },
  closeout: {
    summary: 'Composite work-unit closeout gate (prepare, status, record).',
    usage: 'agenticloop closeout <prepare|status|record> [options]',
    subcommands: {
      prepare: {
        summary: 'Read-only composite closeout evaluation; emits one versioned packet.',
        usage: 'agenticloop closeout prepare --work-unit <id> --artifact <commit:full-sha> [--covered-tasks <ids>] [--output <path>] [--plan-sync <disposition>] [--json] [--target <dir>]',
        options: [
          targetOption(),
          opt('work-unit', 'string', 'Canonical work-unit identity (phase:4, milestone:M2, epic:x, custom:x, work-unit:x). Required.'),
          opt('artifact', 'string', 'Independent exact candidate artifact (commit:<full-sha>). Required; never derived from the audit certificate.'),
          opt('covered-tasks', 'string', 'Explicit exact covered-task boundary when live backend membership cannot be derived.'),
          opt('output', 'string', 'Packet output path under .agenticloop/tmp/. The packet is transient transport.'),
          opt('plan-sync', 'string', 'Plan-sync disposition: not_required, synced, or skipped. An omitted disposition is never sufficient when a source plan applies.'),
          opt('plan-ref', 'string', 'Exact plan reference for --plan-sync synced (defaults to the selected documents.plan).'),
          opt('plan-revision', 'string', 'Expected plan revision (sha256:<content-hash>) for --plan-sync synced; verified against the live plan.'),
          opt('improvement-ref', 'string', 'Improvement proposal id recording a serious process incident. Repeatable.', { multiple: true }),
          opt('repo', 'string', 'GitHub repository override (owner/name) for the github backend.'),
          opt('legacy-unactivated', 'boolean', 'Standard-mode compatibility only: use or interactively create a short-lived signed waiver for an exact pre-activation work unit. Makes no activation claim.'),
          opt('legacy-reason', 'string', 'Reason this exact work unit predates activation assurance. Required when creating a compatibility waiver.'),
          jsonOption,
        ],
      },
      status: {
        summary: 'Resolve the current closeout marker and verify its provenance digest.',
        usage: 'agenticloop closeout status --work-unit <id> [--json] [--target <dir>]',
        receiptRevalidation: 'read-only',
        options: [
          targetOption(),
          opt('work-unit', 'string', 'Canonical work-unit identity. Required.'),
          opt('covered-tasks', 'string', 'Explicit covered-task boundary when membership cannot be derived.'),
          opt('repo', 'string', 'GitHub repository override (owner/name) for the github backend.'),
          jsonOption,
        ],
      },
      record: {
        summary: 'Transactionally publish the marker from a closeout packet.',
        usage: 'agenticloop closeout record --packet <path> (--dry-run | --yes) [--json] [--target <dir>]',
        options: [
          targetOption(),
          opt('packet', 'string', 'Closeout packet path from closeout prepare. Required.'),
          opt('repo', 'string', 'GitHub repository override (owner/name) for the github backend.'),
          opt('dry-run', 'boolean', 'Revalidate and show the exact intended carrier and marker; no mutation.'),
          opt('yes', 'boolean', 'Apply the marker publication after live revalidation.'),
          jsonOption,
        ],
      },
    },
  },
  improvement: {
    summary: 'Bounded improvement-proposal capture and sanitized toolkit escalation export.',
    usage: 'agenticloop improvement <new|lint|status|propose-toolkit-escalation> [options]',
    subcommands: {
      new: {
        summary: 'Create one validated improvement proposal.',
        usage: 'agenticloop improvement new --title <text> --target-surface <surface> --target-path <path> --risk-level <level> [--source-ref <ref>]... [--failure-pattern <text>] [--evidence <text>] [--proposed-change <text>] [--target <dir>]',
        options: [
          targetOption(),
          opt('title', 'string', 'Short proposal title. Required.'),
          opt('source-ref', 'string', 'Durable evidence reference (audit id, marker ref, task id). Repeatable.', { multiple: true }),
          opt('target-surface', 'string', 'One of the canonical target surfaces (e.g. core-methodology, skill-procedure). Required.'),
          opt('target-path', 'string', 'Path of the proposed target surface. Required.'),
          opt('risk-level', 'string', 'low, medium, or high. High risk mechanically sets requires_change_request: true. Required.'),
          opt('failure-pattern', 'string', 'Observed failure pattern (defaults to a serious-incident placeholder referencing the source refs).'),
          opt('evidence', 'string', 'Direct evidence for the incident.'),
          opt('proposed-change', 'string', 'The exact minimal change to the single target surface.'),
          jsonOption,
        ],
      },
      lint: {
        summary: 'Validate improvement proposals against the canonical template rules.',
        usage: 'agenticloop improvement lint [<improvement-id>] [--json] [--target <dir>]',
        positionals: [{ name: 'improvement-id', required: false }],
        options: [targetOption(), jsonOption],
      },
      status: {
        summary: 'List improvement proposals and their statuses.',
        usage: 'agenticloop improvement status [--json] [--target <dir>]',
        options: [targetOption(), jsonOption],
      },
      'propose-toolkit-escalation': {
        summary: 'Export a closed sanitized proposal for human-controlled transfer to a toolkit repository; never imports it.',
        usage: 'agenticloop improvement propose-toolkit-escalation --input <facts.json> --toolkit-repository <identity> --output <target-relative.json> --yes [--json] [--target <dir>]',
        options: [
          targetOption(),
          opt('input', 'string', 'Target-relative closed facts JSON to sanitize.'),
          opt('toolkit-repository', 'string', 'Operator-asserted receiving toolkit repository identity.'),
          opt('output', 'string', 'Target-relative proposal output. Outside-target writes are refused.'),
          yesOption,
          jsonOption,
        ],
      },
    },
  },
  worktree: {
    summary: 'Manage guarded Agentic Loop Git worktrees (add, guard, list, remove, cleanup, resolve-state, prune).',
    usage: 'agenticloop worktree <add|guard|list|remove|cleanup|resolve-state|prune> [options]',
    subcommands: {
      add: {
        summary: 'Create a guarded worktree for a task.',
        usage: 'agenticloop worktree add <task-id> <branch> [--from <ref>] [--target <dir>]',
        positionals: [{ name: 'task-id', required: true }, { name: 'branch', required: true }],
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          opt('from', 'string', 'Start point for a new branch (default: HEAD).'),
        ],
      },
      guard: {
        summary: 'Check or fix Git guard configuration.',
        usage: 'agenticloop worktree guard [--fix] [--all|<path>] [--target <dir>]',
        positionals: [{ name: 'path', required: false }],
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          opt('fix', 'boolean', 'Write missing non-interactive Git guard config.'),
          opt('all', 'boolean', 'Check or fix every Agentic Loop worktree under .agenticloop/worktrees/.'),
        ],
      },
      list: {
        summary: 'List registered Agentic Loop worktrees.',
        usage: 'agenticloop worktree list [--target <dir>] [--json]',
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          jsonOption,
        ],
      },
      remove: {
        summary: 'Remove a worktree and preserve lane-local state.',
        usage: 'agenticloop worktree remove <task-id|path> [--target <dir>] [--dry-run|--yes] [--force] [--json]',
        positionals: [{ name: 'task-id|path', required: true }],
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          dryRunOption,
          yesOption,
          opt('force', 'boolean', 'Allow removing a dirty worktree (single worktree only).'),
          jsonOption,
        ],
      },
      cleanup: {
        summary: 'Remove standard worktrees classified as safe to remove.',
        usage: 'agenticloop worktree cleanup [--target <dir>] [--dry-run|--yes] [--json]',
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          dryRunOption,
          yesOption,
          jsonOption,
        ],
      },
      'resolve-state': {
        summary: 'Resolve root/worktree state conflicts.',
        usage: 'agenticloop worktree resolve-state <task-id|path> [--target <dir>] [--strategy <strategy>] [--dry-run|--yes] [--json]',
        positionals: [{ name: 'task-id|path', required: true }],
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          opt('strategy', 'string', 'Strategy for resolving conflicts: prefer-root, prefer-worktree, union-jsonl.', { enum: ['prefer-root', 'prefer-worktree', 'union-jsonl'] }),
          dryRunOption,
          yesOption,
          jsonOption,
        ],
      },
      prune: {
        summary: 'Remove stale worktree registrations.',
        usage: 'agenticloop worktree prune [--target <dir>] [--dry-run|--yes] [--json]',
        options: [
          targetOption('Git repository root or working tree (default: current directory).'),
          dryRunOption,
          yesOption,
          jsonOption,
        ],
      },
    },
  },
  'event-logging': {
    summary: 'Write events (bare event type), validate, audit, or report optional durable workflow event logs.',
    aliases: ['event'],
    usage: 'agenticloop event-logging <event_type|validate|audit|report> [options]',
    subcommands: {
      validate: {
        summary: 'Validate event log files.',
        usage: 'agenticloop event-logging validate [--target <dir>] [--output <file>]',
        options: [
          targetOption(),
          opt('output', 'string', 'Event log path override (default: validate every <target>/.agenticloop/logs/*.jsonl).'),
        ],
      },
      audit: {
        summary: 'Audit task event logs for required events.',
        usage: 'agenticloop event-logging audit --task <id> [--target <dir>] [--require a,b,c]',
        options: [
          targetOption(),
          opt('task', 'string', 'Task id to audit. Required.'),
          opt('require', 'string', 'Override the strict-audit required event types.'),
        ],
      },
      report: {
        summary: 'Generate a per-task or aggregate report from event logs.',
        usage: 'agenticloop event-logging report [--task <id>] [--features] [--target <dir>]',
        options: [
          targetOption(),
          opt('task', 'string', 'Optional task id for a per-task report. Omit for a read-only aggregate report.'),
          opt('features', 'boolean', 'Print a feature-adoption telemetry report instead of the full aggregate report.'),
        ],
      },
    },
    // Bare event types are dynamic subcommands validated against VALID_EVENT_TYPES.
    eventTypeOptions: [
      targetOption(),
      opt('output', 'string', 'Event log path override (default: <target>/.agenticloop/logs/<task-id>.jsonl; --task <id> is required unless --output <file> is supplied).'),
      opt('task', 'string', 'Task id associated with the event. Required for default output.'),
      opt('role', 'string', `Role: ${WORKFLOW_ROLE_LIST}, human, unknown.`),
      opt('summary', 'string', 'Required short event summary.'),
      opt('outcome', 'string', 'Outcome: success, failure, blocked, needs_context, accepted, needs_revision, unknown.'),
      opt('backend', 'string', 'Backend: files, github, unknown.'),
      opt('host', 'string', 'Host label (default: unknown; inferred when exactly one generated adapter is detected).'),
      opt('trace-id', 'string', 'Trace id used to correlate related events.'),
      opt('parent-event-id', 'string', 'Parent event id when this event extends an earlier gate.'),
      opt('ref', 'string', 'Reference string; may be passed multiple times.', { multiple: true }),
      opt('refs', 'string', 'Comma-separated list of references (merged into --ref).'),
      opt('data-json', 'string', 'Small JSON object with structured metadata.'),
    ],
  },
  configure: {
    summary: 'Configure Agentic Loop integrations.',
    usage: 'agenticloop configure <models> [options]',
    subcommands: {
      models: {
        summary: 'Set per-host role model settings in agenticloop.json.',
        usage: 'agenticloop configure models --adapter <host> [--role <role> --model <id> [--reasoning-effort <value>]] [--profile recommended] [--target <dir>]',
        options: [
          targetOption('Directory containing agenticloop.json (default: current).'),
          adapterOption('Host adapter to configure (opencode, codex, claude-code, copilot, cursor).', { enum: ADAPTER_HOSTS }),
          opt('role', 'string', `Logical role to configure (${WORKFLOW_ROLE_LIST}).`, { enum: WORKFLOW_ROLE_IDS }),
          opt('model', 'string', 'Host-specific model identifier or alias.'),
          opt('reasoning-effort', 'string', 'Reasoning effort for hosts that support it (opencode, codex).'),
          opt('profile', 'string', 'Fill missing fields from the Codex recommended profile without replacing explicit settings.', { enum: ['recommended'] }),
        ],
      },
      'import-generated-models': {
        summary: 'Explicitly import missing model settings from one generated host into agenticloop.json.',
        usage: 'agenticloop configure import-generated-models --adapter <host> [--target <dir>] (--dry-run|--yes) [--json]',
        options: [
          targetOption('Directory containing agenticloop.json (default: current).'),
          adapterOption('One explicit generated host to inspect.', { enum: ADAPTER_HOSTS }),
          dryRunOption,
          yesOption,
          jsonOption,
        ],
      },
    },
  },
  'bootstrap-labels': {
    summary: 'Create required GitHub labels in a target repo.',
    usage: 'agenticloop bootstrap-labels [--repo <owner/repo>] [--dry-run] [--group <id>] [--task-id <id>] [--force] [--target <dir>]',
    options: [
      targetOption(),
      opt('repo', 'string', 'Target GitHub repository.'),
      dryRunOption,
      opt('group', 'string', 'Also create a grouping label.'),
      opt('task-id', 'string', 'Also create a task:<id> label.'),
      opt('force', 'boolean', 'Run even when the active task backend is not github.'),
    ],
  },
  generate: {
    summary: 'Generate host adapter artifacts.',
    usage: 'agenticloop generate <opencode|codex|claude-code|copilot|cursor|all> [--target <dir>] [--output-dir <dir>] [--force-generated]',
    subcommands: Object.fromEntries(
      [...ADAPTER_TARGETS].map(host => [host, {
        summary: host === 'all' ? 'Generate every implemented adapter artifact.' : `Generate ${host} adapter artifacts.`,
        usage: `agenticloop generate ${host} [--target <dir>] [--output-dir <dir>] [--force-generated]`,
        options: [
          targetOption('Directory containing agenticloop.json (default: current).'),
          opt('output-dir', 'string', 'Output directory (default: <target>).'),
          opt('output', 'string', 'Accepted for compatibility; use --output-dir.'),
          opt('force-generated', 'boolean', 'Refresh only a modified artifact already proven owned by Agentic Loop.'),
        ],
      }])
    ),
  },
};

/** Top-level command names, with aliases resolving to their canonical command. */
const COMMAND_ALIASES = new Map();
for (const [name, spec] of Object.entries(COMMAND_REGISTRY)) {
  for (const alias of spec.aliases ?? []) {
    COMMAND_ALIASES.set(alias, name);
  }
}

export function resolveCommandName(name) {
  if (COMMAND_REGISTRY[name]) return name;
  return COMMAND_ALIASES.get(name) ?? null;
}

export function resolveSubcommand(commandName, subName) {
  const spec = COMMAND_REGISTRY[commandName];
  if (!spec?.subcommands) return null;
  return spec.subcommands[subName] ?? null;
}

/**
 * Decide whether parsed Agentic Loop argv names a canonical command leaf that
 * is explicitly safe to execute as mutation-receipt revalidation.
 *
 * Unmarked commands, unknown subcommands, dynamic event types, invalid option
 * shapes, and mutating commands all fail closed. Lifecycle commands are safe
 * only when their canonical registry entry requires and receives --dry-run.
 */
export function isReceiptRevalidationArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const commandName = resolveCommandName(argv[0]);
  if (!commandName) return false;
  const command = COMMAND_REGISTRY[commandName];
  let leaf = command;
  let args = argv.slice(1);
  let label = commandName;
  if (command.subcommands) {
    const subName = args[0];
    leaf = resolveSubcommand(commandName, subName);
    if (!leaf) return false;
    args = args.slice(1);
    label = `${commandName} ${subName}`;
  } else if (command.eventTypeOptions) {
    return false;
  }
  try {
    const parsed = parseCommandArgs(label, leaf, args);
    if (leaf.receiptRevalidation === 'read-only') return true;
    if (leaf.receiptRevalidation === 'read-only-without-output') return parsed.opts.output === undefined;
    if (leaf.receiptRevalidation === 'requires-dry-run') return parsed.opts.dryRun === true;
    return false;
  } catch {
    return false;
  }
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return matrix[a.length][b.length];
}

export function suggestName(name, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.floor(String(best ?? '').length / 3));
  return bestDistance <= threshold ? best : null;
}

export function toCamelCaseKey(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Enforce the declared positional shape centrally. Commands without a
 * `positionals` declaration accept zero operands; required positionals must
 * be present; optional positionals may be omitted; non-variadic declarations
 * enforce maximum arity; a variadic positional must be the final declaration.
 * Violations raise CliUsageError (exit 2) before any handler runs.
 */
function enforcePositionalShape(label, spec, positionals) {
  const declared = spec.positionals ?? [];
  const variadicIndex = declared.findIndex(positional => positional.variadic === true);
  if (variadicIndex !== -1 && variadicIndex !== declared.length - 1) {
    throw new Error(`${label}: invalid positional declaration (a variadic positional must be the final declaration)`);
  }
  const variadic = declared.length > 0 && declared[declared.length - 1].variadic === true;
  const requiredCount = declared.filter(positional => positional.required === true).length;
  const maxCount = variadic ? Infinity : declared.length;
  if (positionals.length < requiredCount) {
    const missing = declared[positionals.length];
    throw new CliUsageError(
      `${label}: missing required <${missing.name}>.`,
      { hint: shapeHint(label, spec) }
    );
  }
  if (positionals.length > maxCount) {
    const unexpected = positionals[maxCount];
    throw new CliUsageError(
      declared.length === 0
        ? `${label} does not accept operands; unexpected operand '${unexpected}'.`
        : `${label}: unexpected operand '${unexpected}'.`,
      { hint: helpHint(label) }
    );
  }
}

/**
 * Strictly parse args for one command or subcommand spec.
 *
 * @param {string} label   Display label used in error messages (e.g. "task new").
 * @param {object} spec    Registry spec with `options` and optional `positionals`.
 * @param {string[]} args  Arguments after the command/subcommand token.
 * @returns {{ opts: object, positional: string[] }}
 */
export function parseCommandArgs(label, spec, args) {
  const options = {};
  for (const option of spec.options ?? []) {
    options[option.name] = { type: option.type, multiple: option.multiple === true };
  }
  let parsed;
  try {
    parsed = utilParseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw usageErrorFromParseFailure(label, spec, error);
  }

  const opts = {};
  for (const option of spec.options ?? []) {
    const value = parsed.values[option.name];
    if (value === undefined) continue;
    opts[toCamelCaseKey(option.name)] = value;
  }

  for (const option of spec.options ?? []) {
    if (!option.enum) continue;
    const key = toCamelCaseKey(option.name);
    const value = opts[key];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (!option.enum.includes(entry)) {
        throw new CliUsageError(
          `Invalid --${option.name} value '${entry}'. Use: ${option.enum.join(', ')}.`,
          { hint: helpHint(label) }
        );
      }
    }
  }

  enforcePositionalShape(label, spec, parsed.positionals);

  return { opts, positional: parsed.positionals };
}

function helpHint(label) {
  return `Run "agenticloop help ${label}" for usage.`;
}

/**
 * Carry the command's own shape into the refusal that reports it broken.
 *
 * Two usage mistakes recurred in the field across separate role sessions - a
 * missing positional `<id>`, and an option that does not exist - and both
 * refusals answered with a pointer to another command instead of the shape the
 * caller had just got wrong. A refusal that names the accepted operands and
 * options at the point of use costs one line and removes the round trip.
 */
function shapeHint(label, spec) {
  const parts = [];
  const declared = spec.positionals ?? [];
  parts.push(declared.length === 0
    ? 'Accepts no operands.'
    : `Operands: ${declared.map(item => `<${item.name}>${item.required ? '' : ' (optional)'}${item.variadic ? '...' : ''}`).join(' ')}.`);
  const options = (spec.options ?? []).map(option => `--${option.name}`);
  if (options.length > 0) parts.push(`Options: ${options.join(', ')}.`);
  if (spec.usage) parts.push(`Usage: ${spec.usage}`);
  parts.push(helpHint(label));
  return parts.join(' ');
}

function usageErrorFromParseFailure(label, spec, error) {
  const message = String(error.message ?? error);
  const unknownMatch = message.match(/Unknown option '(-[^']+)'/);
  if (unknownMatch) {
    const token = unknownMatch[1];
    let suggestion = null;
    if (token.startsWith('--')) {
      suggestion = suggestName(
        token.slice(2),
        (spec.options ?? []).map(option => option.name)
      );
    }
    const text = suggestion
      ? `${label}: unknown option '${token}'. Did you mean '--${suggestion}'?`
      : `${label}: unknown option '${token}'.`;
    return new CliUsageError(text, {
      hint: shapeHint(label, spec), safeToRetry: true, mutationOccurred: false, canonicalUsage: spec.usage ?? null,
    });
  }
  return new CliUsageError(`${label}: ${message}`, {
    hint: shapeHint(label, spec), safeToRetry: true, mutationOccurred: false, canonicalUsage: spec.usage ?? null,
  });
}

/** True when argv requests help at any level (before an explicit `--`). */
export function findHelpRequest(args) {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

let cachedVersion = null;
export function packageVersion() {
  if (cachedVersion === null) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}

// --- help rendering ----------------------------------------------------------

function formatOptionsBlock(options) {
  const lines = [];
  let width = 0;
  const entries = (options ?? []).map(option => {
    const valueName = option.type === 'string' ? ` <${option.valueName ?? defaultValueName(option.name)}>` : '';
    const label = `--${option.name}${valueName}`;
    width = Math.max(width, label.length);
    return { label, description: option.description ?? '' };
  });
  for (const { label, description } of entries) {
    lines.push(`  ${label.padEnd(width + 2)}${description}`);
  }
  return lines.join('\n');
}

function defaultValueName(name) {
  const custom = {
    target: 'dir', adapter: 'host', 'output-dir': 'dir', output: 'file',
    'event-logging': 'mode', 'expect-status': 'accepted|needs_revision',
  };
  return custom[name] ?? 'value';
}

/** One command (or subcommand) help screen. */
export function renderCommandHelp(commandPath) {
  const [commandName, subName] = commandPath.split(' ');
  const spec = COMMAND_REGISTRY[commandName];
  if (!spec) return null;
  const sub = subName ? spec.subcommands?.[subName] : null;
  const leaf = sub ?? spec;
  const label = commandPath;
  const lines = [];
  lines.push(leaf.usage ?? `agenticloop ${label}`);
  lines.push('');
  lines.push(spec.summary && sub ? sub.summary : spec.summary);
  if (!sub && spec.subcommands) {
    lines.push('');
    lines.push('Subcommands:');
    for (const [name, subSpec] of Object.entries(spec.subcommands)) {
      lines.push(`  ${name.padEnd(16)}${subSpec.summary}`);
    }
    if (commandName === 'event-logging') {
      lines.push(`  <event_type>     ${'Write one workflow event (see agenticloop help event-logging for the event-type list).'}`);
    }
  }
  if (leaf.options?.length > 0) {
    lines.push('');
    lines.push(`Options (${label}):`);
    lines.push(formatOptionsBlock(leaf.options));
  }
  if (leaf.details?.length > 0) {
    lines.push('');
    for (const line of leaf.details) lines.push(line);
  }
  if (commandName === 'event-logging' && !sub) {
    lines.push('');
    lines.push('Options (event-logging <event_type>):');
    lines.push(formatOptionsBlock(spec.eventTypeOptions));
  }
  if (commandName === 'init' && !sub) {
    lines.push('');
    lines.push('Note: --setup is deprecated; use "agenticloop setup" for guided onboarding.');
  }
  if (commandName === 'setup' && !sub) {
    lines.push('');
    lines.push('Note: --yes is a compatibility alias for --non-interactive on setup. Other');
    lines.push('commands (for example remove) use --yes to confirm a mutating action.');
  }
  return lines.join('\n');
}

/** Short first-use screen for bare `agenticloop` invocation. */
export function renderFirstUse() {
  return `
Agentic Loop
Add a durable workflow overlay for AI coding agents.

Get started:
  agenticloop setup      Guided setup (recommended)
  agenticloop doctor     Inspect this project without changing it
  agenticloop init       Advanced files-only scaffold

Run "agenticloop help" for all commands.
  `.trim();
}

/** Complete command catalog for `agenticloop help`. */
export function renderFullHelp() {
  const lines = [];
  lines.push('agenticloop <command> [options]');
  lines.push('');
  lines.push('Global options:');
  lines.push('  --debug              Print internal stack details for this invocation. May appear before or after command options.');
  lines.push('');
  lines.push('Environment:');
  lines.push('  AGENTICLOOP_DEBUG=1  Enable the same internal stack details as --debug.');
  lines.push('');
  lines.push('Get started:');
  lines.push('  setup                 Recommended guided onboarding; scaffolds or repairs as needed.');
  lines.push('  doctor                Read-only diagnosis and next steps.');
  lines.push('');
  lines.push('Commands:');
  for (const [name, spec] of Object.entries(COMMAND_REGISTRY)) {
    lines.push(`  ${name.padEnd(Math.max(20, name.length + 1))}${spec.summary}`);
    for (const alias of spec.aliases ?? []) {
      lines.push(`  ${alias.padEnd(Math.max(20, alias.length + 1))}Compatibility alias for ${name}.`);
    }
  }
  lines.push('  help'.padEnd(21) + 'Show this help, or "agenticloop help <command>" for one command.');
  lines.push('  version'.padEnd(21) + 'Show the installed agenticloop version.');
  lines.push('');
  for (const [name, spec] of Object.entries(COMMAND_REGISTRY)) {
    if (spec.subcommands) {
      for (const [subName, subSpec] of Object.entries(spec.subcommands)) {
        lines.push(`Options (${name} ${subName}):`);
        lines.push(formatOptionsBlock(subSpec.options));
        lines.push('');
      }
      if (name === 'event-logging') {
        lines.push('Options (event-logging <event_type>):');
        lines.push(formatOptionsBlock(spec.eventTypeOptions));
        lines.push('');
      }
    } else {
      lines.push(`Options (${name}):`);
      lines.push(formatOptionsBlock(spec.options));
      lines.push('');
    }
  }
  lines.push('Exit statuses:');
  lines.push('  0    success, safe no-op, displayed help/version, or cancellation before apply');
  lines.push('  1    operational, configuration, validation, or apply failure');
  lines.push('  2    invalid command-line usage');
  lines.push('  130  user interruption (SIGINT / abort)');
  return lines.join('\n').trim();
}
