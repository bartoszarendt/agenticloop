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
    usage: 'agenticloop github-review-audit --pr <number> [--issue <number>] [--repo <owner/name>] [--expect-status <accepted|needs_revision>] [--json]',
    options: [
      opt('pr', 'string', 'Pull request number to audit. Required.'),
      opt('issue', 'string', 'Linked task issue number (default: inferred from PR closing references).'),
      opt('repo', 'string', 'Target repository (default: gh-resolved current repo).'),
      opt('expect-status', 'string', 'Expected review status (default: accepted).', { enum: ['accepted', 'needs_revision'] }),
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
    summary: 'Manage files-backed task records (list, lint, new, status).',
    usage: 'agenticloop task <list|lint|new|status> [options]',
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
    summary: 'Manage work-unit audit certificates (new, baseline, report, status, gate, lint, override, resolve).',
    usage: 'agenticloop audit <new|baseline|report|status|gate|lint|override|resolve> [options]',
    subcommands: {
      new: {
        summary: 'Create an audit record.',
        usage: 'agenticloop audit new --work-unit <id> --covered-tasks <ids> --artifact <ref> --goal <text> --completion-oracle <text> --evidence <text> [--budget <n>] [--target <dir>]',
        options: [
          targetOption(),
          opt('work-unit', 'string', 'Canonical work-unit identity (phase:4, milestone:M2, epic:x, custom:x, work-unit:x). Required.'),
          opt('covered-tasks', 'string', 'Comma-separated exact covered task ids. Required.'),
          opt('artifact', 'string', 'Exact frozen candidate artifact (e.g. commit:<sha>). Required.'),
          opt('budget', 'string', `Audit budget (default: ${DEFAULT_AUDIT_BUDGET}; separate from attempt/review budgets).`),
          opt('goal', 'string', 'Concrete work-unit goal statement. Required.'),
          opt('completion-oracle', 'string', 'Observable completion oracle. Required.'),
          opt('evidence', 'string', 'Integrated evidence bound to the frozen candidate. Required.'),
          jsonOption,
        ],
      },
      baseline: {
        summary: 'Rebaseline an audit record after remediation.',
        usage: 'agenticloop audit baseline <audit-id|work-unit> [--artifact <ref>] [--covered-tasks <ids>] --evidence <text> [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('artifact', 'string', 'New exact candidate artifact after remediation was integrated.'),
          opt('covered-tasks', 'string', 'New exact covered task ids. Stale certification is cleared; history is preserved.'),
          opt('evidence', 'string', 'Refreshed integrated evidence bound to the candidate. Required.'),
          jsonOption,
        ],
      },
      report: {
        summary: 'Append one consolidated Auditor report.',
        usage: 'agenticloop audit report <audit-id|work-unit> --verdict <v> --invocation-mode <m> --invocation-ref <id> [--artifact <ref>] [--assessment <text>] [--evidence <text>] [--finding-json <json>] [--target <dir>]',
        positionals: [{ name: 'audit-id|work-unit', required: true }],
        options: [
          targetOption(),
          opt('verdict', 'string', 'certified, certified_with_accepted_limitations, needs_remediation, needs_human_decision.'),
          opt('invocation-mode', 'string', 'host_subagent or explicit_agent_invocation. A same-session fallback is rejected.'),
          opt('invocation-ref', 'string', 'Unique reference for this Auditor invocation. Reuse is rejected.'),
          opt('artifact', 'string', 'Audited artifact; must equal the frozen candidate.'),
          opt('assessment', 'string', 'One consolidated assessment across all six perspectives.'),
          opt('evidence', 'string', 'Bounded evidence actually checked.'),
          opt('finding-json', 'string', 'JSON array of findings (id, severity, blocking, claim, evidenceRefs, consequence, requiredOutcome, verificationRequired).'),
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
    lines.push(`  ${name.padEnd(20)}${spec.summary}`);
    for (const alias of spec.aliases ?? []) {
      lines.push(`  ${alias.padEnd(20)}Compatibility alias for ${name}.`);
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
