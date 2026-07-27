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

const ADAPTER_HOSTS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
const ADAPTER_TARGETS = [...ADAPTER_HOSTS, 'all'];

function opt(name, type, description, extra = {}) {
  return { name, type, description, ...extra };
}

const targetOption = (description = 'Target directory (default: current directory).') =>
  opt('target', 'string', description);
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
    usage: 'agenticloop update [--target <dir>] [--adapter <host>] [--force-generated]',
    options: [
      targetOption(),
      adapterOption("Generate or refresh one adapter. 'all' means every implemented adapter. Without this, existing generated artifacts are refreshed. Existing adapter model settings are backfilled into agenticloop.json when missing before regeneration."),
      opt('force-generated', 'boolean', 'Refresh only a modified artifact already proven owned by Agentic Loop.'),
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
      opt('expect-artifact', 'string', 'Expected dispatched artifact: a full 40-character commit SHA. When provided, the current PR head must equal this SHA.'),
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
    usage: 'agenticloop task-readiness (--task <id>|--issue <n>|--task-body <path>) (--base <ref>|--base-paths <path>) --mode <authoring|review> [--json]',
    options: [
      targetOption(),
      opt('task', 'string', 'Files-backend task id.'),
      opt('issue', 'string', 'GitHub task issue number.'),
      opt('task-body', 'string', 'Offline task Markdown file.'),
      opt('base', 'string', 'Git ref or tree used for an explicit path inventory.'),
      opt('base-paths', 'string', 'JSON path inventory file for offline evaluation.'),
      opt('mode', 'string', 'Explicit readiness mode.', { enum: ['authoring', 'review'] }),
      opt('dependencies', 'string', 'Optional JSON mapping of declared dependency ids to status.'),
      jsonOption,
    ],
  },
  'task-body': {
    summary: 'Guarded GitHub task-record body fetch, lint, and transactional apply.',
    usage: 'agenticloop task-body <fetch|lint|apply|set-field|establish-baseline|authorize-correction|transition> --issue <number> [options]',
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
        usage: 'agenticloop task-body lint --issue <number> --body-file <path> [--offline --trusted-records <snapshot.json>] [--base <ref>] [--base-paths <path>] [--json]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('body-file', 'string', 'Local task-body Markdown candidate. Required.'), opt('offline', 'boolean', 'Do not fetch live GitHub body or carrier provenance.'), opt('trusted-records', 'string', 'Validated offline carrier snapshot JSON.'), opt('base', 'string', 'Optional Git base ref for authoring readiness.'), opt('base-paths', 'string', 'Optional JSON base-tree path inventory.'), jsonOption],
      },
      apply: {
        summary: 'Publish one linted issue-body candidate only after an optimistic digest check.',
        usage: 'agenticloop task-body apply --issue <number> --body-file <path> --expect-digest <digest> (--dry-run|--yes) [--repo <owner/name>] [--base <ref>] [--base-paths <path>] [--json]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('body-file', 'string', 'Local linted task-body Markdown candidate. Required.'), opt('expect-digest', 'string', 'Exact digest printed by task-body fetch. Required.'), opt('repo', 'string', 'Target repository.'), opt('base', 'string', 'Optional Git base ref for authoring readiness.'), opt('base-paths', 'string', 'Optional JSON base-tree path inventory.'), dryRunOption, yesOption, jsonOption],
      },
      'set-field': {
        summary: 'Set one top-level task frontmatter field through the guarded apply transaction.',
        usage: 'agenticloop task-body set-field --issue <number> --field <name> --value <text> --expect-digest <digest> (--dry-run|--yes) [options]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('field', 'string', 'Top-level frontmatter field. Required.'), opt('value', 'string', 'One-line field value. Required.'), opt('expect-digest', 'string', 'Exact digest printed by task-body fetch. Required.'), opt('repo', 'string', 'Target repository.'), opt('base', 'string', 'Optional Git base ref.'), opt('base-paths', 'string', 'Optional JSON base-tree path inventory.'), dryRunOption, yesOption, jsonOption],
      },
      transition: {
        summary: 'Transition a task status through one guarded field mutation.',
        usage: 'agenticloop task-body transition --issue <number> --status <status> --expect-digest <digest> (--dry-run|--yes) [--base <ref>|--base-paths <path>] [options]',
        options: [targetOption(), opt('issue', 'string', 'GitHub task issue number. Required.'), opt('status', 'string', 'Target status. Required.'), opt('expect-digest', 'string', 'Exact digest printed by task-body fetch. Required.'), opt('repo', 'string', 'Target repository.'), opt('base', 'string', 'Git base ref required for agent-ready transition.'), opt('base-paths', 'string', 'JSON base-tree path inventory required for agent-ready transition.'), dryRunOption, yesOption, jsonOption],
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
    usage: 'agenticloop commit-attribution check --task <id> [--commit <ref>] [--message-file <path>] [--json]',
    subcommands: {
      check: {
        summary: 'Check Task/Agent trailers without amending, committing, pushing, or force-pushing.',
        options: [targetOption(), opt('task', 'string', 'Expected task id. Required.'), opt('commit', 'string', 'Commit ref (default: HEAD).'), opt('message-file', 'string', 'Read a commit message from a local file.'), jsonOption],
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
    summary: 'Fail-closed exact-head, read-only Maintainer delegation preparation.',
    usage: 'agenticloop github-review-prepare --pr <number> [--issue <number>] [--repo <owner/name>] [--workspace <path>] [--packet <path>] [--json]',
    options: [opt('pr', 'string', 'Pull request number. Required.'), opt('issue', 'string', 'Linked task issue number override.'), opt('repo', 'string', 'Target repository.'), opt('workspace', 'string', 'Optional workspace that must resolve to the exact dispatched head.'), opt('packet', 'string', 'Verify a previously emitted preparation packet file against the current head before dispatch (read-only).'), jsonOption],
  },
  doctor: {
    summary: 'Read-only diagnosis: setup checklist, adapter state, and next commands.',
    usage: 'agenticloop doctor [--target <dir>]',
    options: [targetOption('Directory to inspect (default: current directory).')],
  },
  status: {
    summary: 'Show configured adapters, generated artifacts, and next steps.',
    usage: 'agenticloop status [--target <dir>]',
    options: [targetOption('Directory containing agenticloop.json (default: current).')],
  },
  task: {
    summary: 'Manage files-backed task records (list, lint, new, establish-baseline, authorize-correction, status).',
    usage: 'agenticloop task <list|lint|new|establish-baseline|authorize-correction|status> [options]',
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
      lint: {
        summary: 'Lint task records.',
        usage: 'agenticloop task lint [<task-id>] [--json] [--target <dir>]',
        positionals: [{ name: 'task-id', required: false }],
        options: [targetOption(), jsonOption],
      },
      new: {
        summary: 'Create a task record.',
        usage: 'agenticloop task new <title> [--id <id>] [--target <dir>]',
        positionals: [{ name: 'title', required: true, variadic: true }],
        options: [
          targetOption(),
          opt('id', 'string', 'Explicit task id. Omit to allocate the next default T-### id.'),
          jsonOption,
        ],
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
      status: {
        summary: 'Update task status.',
        usage: 'agenticloop task status <id> <status> [--note <text>] [--block-category <category>] [--target <dir>]',
        positionals: [{ name: 'id', required: true }, { name: 'status', required: true }],
        options: [
          targetOption(),
          opt('note', 'string', 'Append a dated line under ## Comments.'),
          opt('block-category', 'string', 'Required when setting status to blocked.'),
          opt('accept', 'boolean', 'Accepted for compatibility.'),
          jsonOption,
        ],
      },
    },
  },
  audit: {
    summary: 'Manage work-unit audit certificates (new, baseline, report, status, gate, lint, disposition, override, resolve).',
    usage: 'agenticloop audit <new|baseline|report|status|gate|lint|disposition|override|resolve> [options]',
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
      baseline: {
        summary: 'Rebaseline an audit record after remediation.',
        usage: 'agenticloop audit baseline <audit-id|work-unit> [--artifact <ref>] [--covered-tasks <ids>] [--canonicalize] --evidence <text> [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('artifact', 'string', 'New exact candidate artifact after remediation was integrated (resolved to the full SHA).'),
          opt('covered-tasks', 'string', 'New exact covered task ids. Stale certification is cleared; history is preserved.'),
          opt('canonicalize', 'boolean', 'Migrate a legacy audit record: resolves the existing candidate to its full identity, upgrades the schema, preserves history, clears stale certification. Mutually exclusive with --artifact/--covered-tasks.'),
          opt('evidence', 'string', 'Refreshed integrated evidence bound to the candidate. Required.'),
          jsonOption,
        ],
      },
      report: {
        summary: 'Append one consolidated Auditor report.',
        usage: 'agenticloop audit report <audit-id|work-unit> (--file <path> | --stdin | legacy inline options) [--target <dir>]',
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
        summary: 'Fail-closed closeout certification check.',
        usage: 'agenticloop audit gate <audit-id|work-unit> [--json] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [targetOption(), jsonOption],
      },
      lint: {
        summary: 'Validate audit records.',
        usage: 'agenticloop audit lint [<audit-id|work-unit>] [--json] [--target <dir>]',
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
        usage: 'agenticloop closeout prepare --work-unit <id> [--artifact <ref>] [--output <path>] [--plan-sync <disposition>] [--json] [--target <dir>]',
        options: [
          targetOption(),
          opt('work-unit', 'string', 'Canonical work-unit identity (phase:4, milestone:M2, epic:x, custom:x, work-unit:x). Required.'),
          opt('artifact', 'string', 'Exact candidate artifact (commit:<sha>). Defaults to the certified candidate.'),
          opt('covered-tasks', 'string', 'Explicit covered-task boundary when membership cannot be derived (flat projects without an audit record).'),
          opt('output', 'string', 'Packet output path under .agenticloop/tmp/. The packet is transient transport.'),
          opt('plan-sync', 'string', 'Plan-sync disposition: not_required, synced, or skipped. An omitted disposition is never sufficient when a source plan applies.'),
          opt('plan-ref', 'string', 'Exact plan reference for --plan-sync synced (defaults to the selected documents.plan).'),
          opt('plan-revision', 'string', 'Expected plan revision (sha256:<content-hash>) for --plan-sync synced; verified against the live plan.'),
          opt('improvement-ref', 'string', 'Improvement proposal id recording a serious process incident. Repeatable.', { multiple: true }),
          opt('repo', 'string', 'GitHub repository override (owner/name) for the github backend.'),
          jsonOption,
        ],
      },
      status: {
        summary: 'Resolve the current closeout marker and verify its provenance digest.',
        usage: 'agenticloop closeout status --work-unit <id> [--json] [--target <dir>]',
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
    summary: 'Bounded improvement-proposal capture (new, lint, status).',
    usage: 'agenticloop improvement <new|lint|status> [options]',
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
      opt('role', 'string', 'Role: orchestrator, maintainer, engineer, auditor, human, unknown.'),
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
          opt('role', 'string', 'Logical role to configure (orchestrator, maintainer, engineer, auditor).'),
          opt('model', 'string', 'Host-specific model identifier or alias.'),
          opt('reasoning-effort', 'string', 'Reasoning effort for hosts that support it (opencode, codex).'),
          opt('profile', 'string', 'Fill missing fields from the Codex recommended profile without replacing explicit settings.', { enum: ['recommended'] }),
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
      { hint: helpHint(label) }
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
    return new CliUsageError(text, { hint: helpHint(label) });
  }
  return new CliUsageError(`${label}: ${message}`, { hint: helpHint(label) });
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
