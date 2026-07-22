/**
 * agenticloop CLI router.
 *
 * Commands:
 *   agenticloop init [--target <dir>] [--adapter <host>]
 *   agenticloop update [--target <dir>] [--adapter <host>] [--force-generated]
 *   agenticloop upgrade [--target <dir>] [--adapter <host>]
 *   agenticloop remove [--target <dir>] [--dry-run|--yes]
 *   agenticloop validate [--target <dir>]
 *   agenticloop github-preflight --pr <number> [--issue <number>] [--repo <owner/name>] [--json]
 *   agenticloop github-ready --pr <number> [--issue <number>] [--repo <owner/name>] [--json]
 *   agenticloop event-logging <event_type> [--target <dir>] [--summary <text>] [--task <id>]
 *   agenticloop event-logging validate [--target <dir>] [--output <file>]
 *   agenticloop event-logging audit --task <id> [--target <dir>] [--require a,b,c]
 *   agenticloop event-logging report [--task <id>] [--features] [--target <dir>]
 *   agenticloop task list [--status <s>] [--json] [--target <dir>]
 *   agenticloop task lint [<task-id>] [--json] [--target <dir>]
 *   agenticloop task new <title> [--id <id>] [--target <dir>]
 *   agenticloop task status <id> <status> [--note <text>] [--block-category <category>] [--target <dir>]
 *   agenticloop worktree add <task-id> <branch> [--from <ref>] [--target <dir>]
 *   agenticloop worktree guard [--fix] [--all|<path>] [--target <dir>]
 *   agenticloop worktree list [--target <dir>] [--json]
 *   agenticloop worktree remove <task-id|path> [--target <dir>] [--dry-run|--yes] [--force] [--json]
 *   agenticloop worktree cleanup [--target <dir>] [--dry-run|--yes] [--json]
 *   agenticloop worktree resolve-state <task-id|path> [--target <dir>] [--strategy <strategy>] [--dry-run|--yes] [--json]
 *   agenticloop worktree prune [--target <dir>] [--dry-run|--yes] [--json]
 *   agenticloop bootstrap-labels [--repo <r>] [--dry-run] [--group <g>] [--task-id <id>] [--force]
 *   agenticloop generate opencode     [--target <dir>] [--output-dir <dir>] [--force-generated]
 *   agenticloop generate codex        [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate claude-code  [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate copilot      [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate cursor       [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate all          [--target <dir>] [--output-dir <dir>]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { parseArgs, warnUnknownOptions } from './cli-args.js';
import { createIo } from './cli-io.js';
import { init } from './init.js';
import { bootstrapLabels } from './bootstrap-labels.js';
import {
  OPENCODE_AGENT_RELATIVE_PATHS,
  OPENCODE_COMMAND_RELATIVE_PATH,
} from './adapters/opencode.js';
import {
  generatedCopilotArtifactsPresent,
} from './adapters/copilot.js';
import {
  generatedCursorArtifactsPresent,
} from './adapters/cursor.js';
import { validateSharedAgenticLoopPluginCompatibility } from './adapter-plugin-compatibility.js';
import { generateAdapterArtifacts } from './adapter-generation.js';
import { deepMerge, loadAgenticLoopConfig } from './json.js';
import { loadProjectMap } from './project-map.js';
import { resolveTaskBackend } from './task-backend.js';
import { cmdTask } from './task-cli.js';
import {
  configureModels,
  parseModelMutations,
  detectHost,
  validateHost,
  createPrompts,
  promptModelSettings,
  promptModelSettingsInteractive,
} from './configure-models.js';
import { printAdapterDiscovery, printDoctor } from './adapter-discovery.js';
import { setup } from './setup.js';
import { removeAgenticLoop } from './remove.js';
import { applyGuidance, checkGuidance, removeGuidance } from './guidance.js';
import { preserveExistingAdapterModelSettings } from './adapter-model-preservation.js';
import {
  appendEventLog,
  auditTaskEventLog,
  buildEvent,
  DEFAULT_LOG_DIR,
  reportEventLogs,
  reportTaskEventLog,
  STRICT_AUDIT_EVENT_TYPES,
  VALID_EVENT_TYPES,
  resolveEventLogPath,
  resolveLogDirectory,
  validateNewEvent,
  validateEventLogFile,
  validateEventLogs,
} from './event-logging.js';
import { runValidation } from './validate-runner.js';
import { validateLinks, formatLinkErrors } from './link-validator.js';
import { runPreflight, PreflightError } from './github-preflight.js';
import { runGitHubReviewAudit, GitHubReviewAuditError } from './github-review-audit.js';
import { runGitHubReady, formatGitHubReadyReport, GitHubReadyError } from './github-ready.js';
import {
  cleanupAgenticLoopWorktrees,
  createAgenticLoopWorktree,
  formatResolveStateResult,
  formatWorktreeCleanupResult,
  formatWorktreeGuardResult,
  formatWorktreeList,
  formatWorktreePruneResult,
  formatWorktreeRemoveResult,
  guardAgenticLoopWorktrees,
  listAgenticLoopWorktrees,
  pruneAgenticLoopWorktrees,
  removeAgenticLoopWorktree,
  resolveAgenticLoopStateConflicts,
} from './worktree.js';

const DEFAULT_LOG_DIR_DISPLAY = DEFAULT_LOG_DIR.replaceAll('\\', '/');
const TASK_EVENT_LOG_PATH_DISPLAY = `${DEFAULT_LOG_DIR_DISPLAY}/<task-id>.jsonl`;
const DEFAULT_EVENT_LOG_GLOB_DISPLAY = `${DEFAULT_LOG_DIR_DISPLAY}/*.jsonl`;

function parseRequiredEventTypesOption(value) {
  if (value === undefined) {
    return {
      requiredEventTypes: STRICT_AUDIT_EVENT_TYPES,
      explicitRequire: false,
      errors: [],
    };
  }

  const requiredEventTypes = [...new Set(String(value).split(',').map(entry => entry.trim()).filter(Boolean))];
  if (requiredEventTypes.length === 0) {
    return {
      requiredEventTypes: [],
      explicitRequire: true,
      errors: ['--require must include at least one event type'],
    };
  }

  const invalid = requiredEventTypes.filter(eventType => !VALID_EVENT_TYPES.has(eventType));
  if (invalid.length > 0) {
    return {
      requiredEventTypes,
      explicitRequire: true,
      errors: [`--require contains unknown event type(s): ${invalid.join(', ')}`],
    };
  }

  return {
    requiredEventTypes,
    explicitRequire: true,
    errors: [],
  };
}

function formatSummaryList(values) {
  return values.length > 0 ? values.join(', ') : 'none';
}

const TASK_ID_LIST_LIMIT = 5;

function formatTaskIdList(taskIds) {
  if (taskIds.length === 0) return 'none';
  const shown = taskIds.slice(0, TASK_ID_LIST_LIMIT);
  const remainder = taskIds.length - shown.length;
  return remainder > 0 ? `${shown.join(', ')} (+${remainder} more)` : shown.join(', ');
}

function formatCountSummary(entries) {
  return entries.length > 0 ? entries.map(entry => `${entry.value}=${entry.count}`).join(', ') : 'none';
}

function formatRefSummary(entries) {
  return entries.length > 0 ? entries.map(entry => `${entry.ref}=${entry.count}`).join(', ') : 'none';
}

function printProvenanceQualityMetric(label, metric, io) {
  const count = metric?.count ?? 0;
  const tasks = metric?.tasks ?? [];
  io.out(`    ${label}: ${count} (${formatTaskIdList(tasks)})`);
}

const CHURN_DETAIL_LIMIT = 15;

function printFeatureReport(result, commandLabel, io) {
  const f = result.features;
  io.out();
  io.out(`agenticloop ${commandLabel} report --features`);
  io.out('='.repeat(50));
  io.out(`  directory: ${result.directory}`);
  io.out(`  tasks scanned: ${f.tasksScanned}`);
  io.out(`  tasks with feature telemetry: ${f.tasksWithTelemetry}`);

  if (result.missingLogs) {
    io.out();
    io.out('  No event log files found.');
    io.out();
    return;
  }

  io.out();
  io.out('  review budget / churn (derived from review.result, data.review_round, closeout review_rounds):');
  io.out(`    max derived review rounds: ${f.reviewRounds.maxDerivedReviewRounds}`);
  io.out(`    tasks with review churn: ${f.reviewRounds.churnTasks.length}`);
  io.out(
    `    tasks over review budget: ${f.reviewRounds.tasksOverBudget.length} (${formatTaskIdList(f.reviewRounds.tasksOverBudget)})`
  );
  const overBudgetChurn = f.reviewRounds.churnTasks
    .filter(task => task.overBudget)
    .sort((a, b) => b.derivedReviewRounds - a.derivedReviewRounds || String(a.taskId).localeCompare(String(b.taskId)));
  if (overBudgetChurn.length > 0) {
    io.out('    over-budget detail (highest rounds first):');
    for (const task of overBudgetChurn.slice(0, CHURN_DETAIL_LIMIT)) {
      const budget = `${task.reviewBudget}${task.reviewBudgetIsDefault ? ' (default)' : ''}`;
      io.out(
        `      - ${task.taskId}: rounds=${task.derivedReviewRounds} needs_revision=${task.needsRevisionCount} accepted=${task.acceptedCount} budget=${budget}`
      );
    }
    if (overBudgetChurn.length > CHURN_DETAIL_LIMIT) {
      io.out(`      (+${overBudgetChurn.length - CHURN_DETAIL_LIMIT} more over budget)`);
    }
  }

  io.out();
  const m = f.minimalism;
  io.out(
    `  minimalism (telemetry tasks): none=${m.none}, lite=${m.lite}, full=${m.full}, ultra=${m.ultra}, missing=${m.missing}, other=${m.other}`
  );
  io.out(`  minimalism triggers: ${formatCountSummary(f.minimalismTriggers.map(entry => ({ value: entry.trigger, count: entry.count })))}`);
  io.out(
    `  non-default attempt budgets: ${f.budgets.nonDefaultAttempt.length} (${formatTaskIdList(f.budgets.nonDefaultAttempt.map(entry => `${entry.taskId}=${entry.attemptBudget}`))})`
  );
  io.out(
    `  non-default review budgets: ${f.budgets.nonDefaultReview.length} (${formatTaskIdList(f.budgets.nonDefaultReview.map(entry => `${entry.taskId}=${entry.reviewBudget}`))})`
  );
  io.out(
    `  context overflow risk: medium=${f.contextOverflowRisk.medium}, high=${f.contextOverflowRisk.high} (tasks: ${formatTaskIdList(f.contextOverflowRisk.tasks)})`
  );
  io.out(
    `  context pressure: true=${f.contextPressure.true}, false=${f.contextPressure.false}, missing-for-risk-tasks=${f.contextPressure.missingForRiskTasks.length} (${formatTaskIdList(f.contextPressure.missingForRiskTasks)})`
  );

  io.out();
  const oc = f.omissionCandidates;
  io.out('  context-risk omission candidates (heuristic; candidates, not misses):');
  io.out(
    `    pressure hit but no risk predicted (higher confidence): ${oc.contextRiskPressureNoPredict.length} (${formatTaskIdList(oc.contextRiskPressureNoPredict)})`
  );
  io.out(
    `    reached/exceeded review budget but no risk predicted (lower confidence): ${oc.contextRiskOverBudgetNoPredict.length} (${formatTaskIdList(oc.contextRiskOverBudgetNoPredict.map(entry => entry.taskId))})`
  );

  io.out();
  const fx = f.maintainerFixup;
  io.out('  maintainer review fixup (from maintainer_fixup: true events; a fallback review mode alone is not a fixup):');
  io.out(`    maintainer_fixup: true events (event count, not proven-deduplicated episodes): ${fx.episodeCount}`);
  io.out(`    tasks with a fixup event: ${fx.tasksWithFixup.length} (${formatTaskIdList(fx.tasksWithFixup)})`);
  io.out(`    tasks with more than one fixup event (multiple-episode anomaly): ${fx.tasksWithMultipleFixups.length} (${formatTaskIdList(fx.tasksWithMultipleFixups)})`);

  io.out();
  if (f.warnings.length === 0) {
    io.out('  feature telemetry warnings: none');
  } else {
    io.out('  feature telemetry warnings:');
    for (const warning of f.warnings) io.warn(`    WARN: ${warning}`);
  }
  io.out();
}

function inferCheckRunOutcome(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  if (data.blocked === true || data.status === 'blocked') return 'blocked';

  const exitCode = typeof data.exit_code === 'number' ? data.exit_code : null;
  if (exitCode !== null) return exitCode === 0 ? 'success' : 'failure';

  const failed = typeof data.failed === 'number' ? data.failed : null;
  if (failed !== null && failed > 0) return 'failure';
  if (failed === 0 && typeof data.passed === 'number' && data.passed > 0) return 'success';

  return null;
}

function normalizeEventOutcomeOption(eventType, outcome) {
  if (eventType === 'task.started' && outcome === 'required') {
    return {
      outcome: undefined,
      warnings: [
        "`--outcome required` is not a task.started outcome; recording the default outcome 'unknown'",
      ],
    };
  }

  return { outcome, warnings: [] };
}

function inferEventHost(target, explicitHost) {
  if (typeof explicitHost === 'string' && explicitHost.trim()) {
    return explicitHost.trim();
  }

  const detected = detectHost(target);
  if (detected.length === 1) return detected[0];

  return undefined;
}

function usage(io) {
  const write = io ? io.out : console.log;
  write(`
agenticloop <command> [options]

Commands:
  init                  Scaffold Agentic Loop overlay in a target directory.
  setup                 Guided onboarding: project setup, adapter selection, model config.
  update                Refresh Agentic Loop-owned assets and existing adapter output.
  upgrade               Compatibility alias for update.
  remove                Remove Agentic Loop assets from a target directory.
  guidance              Manage the repository-rules activation-guidance block (apply, check, remove).
  validate              Validate skills, config, links, and host setup.
  github-preflight      Pre-review gate: verify a GitHub PR body carries final-state
                        evidence for every required check, tied to the current head.
  github-review-audit   Verify artifact-bound GitHub review provenance for a PR.
  github-ready          Read-only pre-merge gate: run the evidence preflight and the
                        review audit together and report one merge-readiness verdict.
  doctor                Show setup checklist, adapter state, and next commands.
  task                  Manage files-backed task records (list, lint, new, status).
  worktree              Manage guarded Agentic Loop Git worktrees (add, guard, list, remove, cleanup, resolve-state, prune).
  event-logging         Write events (bare event type), validate, audit, or report optional durable workflow event logs.
  event                 Compatibility alias for event-logging.
  configure models      Set per-host role model settings in agenticloop.json.
  status                Show configured adapters, generated artifacts, and next steps.
  bootstrap-labels      Create required GitHub labels in a target repo.
  generate opencode     Generate Agentic Loop OpenCode agents and command.
  generate codex        Generate Codex adapter artifacts.
  generate claude-code  Generate Claude Code adapter artifacts.
  generate copilot      Generate GitHub Copilot adapter artifacts.
  generate cursor       Generate Cursor adapter artifacts.
  generate all          Generate every implemented adapter artifact.

Options (init):
  --target <dir>        Target directory (default: current directory).
  --adapter <host>      Scaffold and generate output for one host: opencode, codex, claude-code, copilot, cursor, all.
  --opencode            Compatibility alias for --adapter opencode.
  --setup               Prompt for model settings after scaffolding (requires one concrete --adapter).
  --no-agents-guidance  Skip installing the repository-rules activation-guidance block.

Options (setup):
  --target <dir>        Target directory (default: current directory).
  --adapter <host>      Preselect adapter: opencode, codex, claude-code, copilot, cursor, all.
  --yes                 Non-interactive mode: skip interactive prompts (requires --adapter).

Options (github-preflight):
  --pr <number>         Pull request number to check. Required.
  --issue <number>      Linked task issue number (default: inferred from PR closing references).
  --repo <owner/name>   Target repository (default: gh-resolved current repo).
  --json                Emit machine-readable JSON instead of human-readable output.

Options (github-review-audit):
  --pr <number>         Pull request number to audit. Required.
  --issue <number>      Linked task issue number (default: inferred from PR closing references).
  --repo <owner/name>   Target repository (default: gh-resolved current repo).
  --expect-status <accepted|needs_revision>
                        Expected review status (default: accepted). For
                        accepted, an independent_human review must be an
                        APPROVED current-head native GitHub review. For
                        needs_revision, it must be a CHANGES_REQUESTED
                        current-head native GitHub review.
  --json                Emit machine-readable JSON instead of human-readable output.

Options (github-ready):
  --pr <number>         Pull request number to check. Required.
  --issue <number>      Linked task issue number (default: inferred from PR closing references).
  --repo <owner/name>   Target repository (default: gh-resolved current repo).
  --json                Emit machine-readable JSON instead of human-readable output.
                        Read-only: runs github-preflight and github-review-audit and
                        requires both (and their PR head/linked issue) to agree. It never
                        merges, comments, or edits GitHub state.

Options (doctor):
  --target <dir>        Directory to inspect (default: current directory).

Options (worktree add):
  --target <dir>        Git repository root or working tree (default: current directory).
  --from <ref>          Start point for a new branch (default: HEAD).

Options (worktree guard):
  --target <dir>        Git repository root or working tree (default: current directory).
  --fix                 Write missing non-interactive Git guard config.
  --all                 Check or fix every Agentic Loop worktree under .agenticloop/worktrees/.

Options (worktree list):
  --target <dir>        Git repository root or working tree (default: current directory).
  --json                Emit machine-readable JSON instead of human-readable output.

Options (worktree remove):
  --target <dir>        Git repository root or working tree (default: current directory).
  --dry-run             Print what would happen without making changes.
  --yes                 Remove the worktree and preserve lane-local state.
  --force               Allow removing a dirty worktree (single worktree only).
  --json                Emit machine-readable JSON instead of human-readable output.

Options (worktree cleanup):
  --target <dir>        Git repository root or working tree (default: current directory).
  --dry-run             Print what would happen without making changes.
  --yes                 Remove standard worktrees classified as safe to remove.
  --json                Emit machine-readable JSON instead of human-readable output.

Options (worktree resolve-state):
  --target <dir>        Git repository root or working tree (default: current directory).
  --dry-run             Print what would happen without making changes (default).
  --yes                 Resolve conflicts and update root state files.
  --strategy <strategy> Strategy for resolving conflicts: prefer-root, prefer-worktree, union-jsonl.
  --json                Emit machine-readable JSON instead of human-readable output.

Options (worktree prune):
  --target <dir>        Git repository root or working tree (default: current directory).
  --dry-run             Print prunable registrations without removing them.
  --yes                 Run git worktree prune to remove stale registrations.
  --json                Emit machine-readable JSON instead of human-readable output.

Options (update):
  --target <dir>        Target directory (default: current directory).
   --adapter <host>      Generate or refresh one adapter. 'all' means every implemented adapter.
                         Without this, existing generated artifacts are refreshed.
                         Existing adapter model settings are backfilled into
                         agenticloop.json when missing before regeneration.
   --force-generated     Refresh only a modified artifact already proven owned by Agentic Loop.

Options (remove):
  --target <dir>        Target directory (default: current directory).
  --dry-run             Print files/directories that would be removed.
  --yes                 Actually remove files/directories.
  --include-state       Also remove target-owned .agenticloop/ state.

Options (guidance apply | guidance check | guidance remove):
  --target <dir>        Target directory (default: current directory).
  --force               apply: refresh a modified owned block or adopt an unowned
                        marker block. remove: remove a modified owned block.
                        Never adopts or overwrites an unowned block without this flag.

Options (validate):
  --target <dir>        Directory containing agenticloop.json (default: current).
  --adapter <host>      Force validation of a specific adapter (opencode, codex, claude-code, copilot, cursor).
                        May be passed multiple times.

Options (event-logging <event_type>):
  --target <dir>        Target directory (default: current directory).
  --output <file>       Event log path override (default: <target>/${TASK_EVENT_LOG_PATH_DISPLAY};
                         --task <id> is required unless --output <file> is supplied).
  --task <id>           Task id associated with the event. Required for default output.
  --role <role>         Role: orchestrator, maintainer, engineer, human, unknown.
  --summary <text>      Required short event summary.
  --outcome <value>     Outcome: success, failure, blocked, needs_context, accepted, needs_revision, unknown.
  --backend <name>      Backend: files, github, unknown.
  --host <name>         Host label (default: unknown; inferred when exactly one generated adapter is detected). Inferred host is a heuristic, not proof of the actual runtime host; use --host when accuracy matters.
  --trace-id <uuid>     Trace id used to correlate related events.
  --parent-event-id <uuid>  Parent event id when this event extends an earlier gate.
  --ref <value>         Reference string; may be passed multiple times.
  --data-json <json>    Small JSON object with structured metadata.

Options (event-logging validate):
  --target <dir>        Target directory (default: current directory).
  --output <file>       Event log path override (default: validate every <target>/${DEFAULT_EVENT_LOG_GLOB_DISPLAY}).

Options (event-logging audit):
  --target <dir>        Target directory (default: current directory).
  --task <id>           Task id to audit. Required.
  --require <a,b,c>     Override the strict-audit required event types.

Options (event-logging report):
  --target <dir>        Target directory (default: current directory).
  --task <id>           Optional task id for a per-task report from <target>/${TASK_EVENT_LOG_PATH_DISPLAY}.
                        Omit for a read-only aggregate report over <target>/${DEFAULT_EVENT_LOG_GLOB_DISPLAY}.
  --features            Print a feature-adoption telemetry report (minimalism, effort
                        budgets, context-overflow risk, and derived review-round churn)
                        over the aggregate logs instead of the full aggregate report.

Options (task list):
  --target <dir>        Target directory (default: current directory).
  --status <status>     Filter by task status.
  --json                Emit machine-readable JSON instead of a table.

Options (task lint):
  --target <dir>        Target directory (default: current directory).
  --json                Emit machine-readable JSON.

Options (task new):
  --target <dir>        Target directory (default: current directory).
  --id <id>             Explicit task id. Omit to allocate the next default T-### id.

Options (task status):
  --target <dir>        Target directory (default: current directory).
  --note <text>         Append a dated line under ## Comments.
  --block-category <c>  Required when setting status to blocked.
  --json                Emit machine-readable JSON.

Options (configure models):
  --target <dir>        Directory containing agenticloop.json (default: current).
  --adapter <host>      Host adapter to configure (opencode, codex, claude-code, copilot, cursor).
  --role <role>         Logical role to configure (orchestrator, maintainer, engineer).
  --model <id>          Host-specific model identifier or alias.
  --reasoning-effort <value>  Reasoning effort for hosts that support it (opencode, codex).
  --profile recommended   Fill missing fields from the Codex recommended profile without replacing explicit settings.

Options (status):
  --target <dir>        Directory containing agenticloop.json (default: current).

Options (bootstrap-labels):
  --repo <owner/repo>   Target GitHub repository.
  --dry-run             Print gh commands without running them.
  --group <id>          Also create a grouping label.
  --task-id <id>        Also create a task:<id> label.
  --force               Run even when the active task backend is not github.

Options (generate opencode):
  --target <dir>        Directory containing agenticloop.json (default: current).
   --output-dir <dir>    Output directory (default: <target>).
   --force-generated     Refresh only a modified artifact already proven owned by Agentic Loop.

Options (generate codex | generate claude-code | generate copilot | generate cursor | generate all):
  --target <dir>        Directory containing agenticloop.json (default: current).
   --output-dir <dir>    Output directory (default: <target>).
   --force-generated     Refresh only a modified artifact already proven owned by Agentic Loop.
  `.trim());
}

const VALID_ADAPTER_TARGETS = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all']);

function normalizeAdapterTargets(adapterOpt) {
  if (!adapterOpt) return { adapters: [], errors: [] };
  const raw = Array.isArray(adapterOpt) ? adapterOpt : [adapterOpt];
  const errors = [];
  for (const adapter of raw) {
    if (!VALID_ADAPTER_TARGETS.has(adapter)) {
      errors.push(`Unknown adapter '${adapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`);
    }
  }
  if (errors.length > 0) return { adapters: [], errors };
  if (raw.includes('all')) return { adapters: ['all'], errors: [] };
  return { adapters: raw, errors: [] };
}

function detectGeneratedAdapterTargets(target) {
  const adapters = [];
  const opencodePresent = Object.values(OPENCODE_AGENT_RELATIVE_PATHS)
    .some(relPath => existsSync(join(target, relPath))) || existsSync(join(target, OPENCODE_COMMAND_RELATIVE_PATH));
  if (opencodePresent) adapters.push('opencode');
  if (
    existsSync(join(target, '.codex', 'agents')) ||
    existsSync(join(target, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json')) ||
    existsSync(join(target, '.codex-plugin', 'plugin.json'))
  ) {
    adapters.push('codex');
  }
  if (existsSync(join(target, '.claude', 'agents'))) {
    adapters.push('claude-code');
  }
  if (generatedCopilotArtifactsPresent(target).length > 0) {
    adapters.push('copilot');
  }
  if (generatedCursorArtifactsPresent(target).length > 0) {
    adapters.push('cursor');
  }
  return adapters;
}

function validateAdapterGenerationPreflight(sub, alConfig) {
  return validateAdapterListGenerationPreflight([sub], alConfig);
}

function validateAdapterListGenerationPreflight(adapters, alConfig) {
  if (adapters.some(adapter => ['codex', 'cursor', 'all'].includes(adapter))) {
    return validateSharedAgenticLoopPluginCompatibility(alConfig);
  }
  return [];
}

function printPreservationResult(preservation) {
  for (const w of preservation.warnings) console.warn(`  WARN: ${w}`);
  for (const e of preservation.errors) console.error(`  ERROR: ${e}`);
  for (const u of preservation.updated) console.log(`  preserved: ${u}`);
}

function shouldPreserveExistingModels(preserveExistingModels, outputDir, target) {
  return preserveExistingModels && resolve(outputDir) === resolve(target);
}

async function generateAdapterTarget(sub, { opts, target, alConfig, preserveExistingModels = true }) {
  const forceGenerated = Boolean(opts.forceGenerated);
  const outputDir = resolveOutputDir(opts, target);

  let effectiveConfig = alConfig;
  let preservation;
  if (shouldPreserveExistingModels(preserveExistingModels, outputDir, target)) {
    const adapterList = sub === 'all'
      ? ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']
      : (Array.isArray(sub) ? sub : [sub]);
    preservation = preserveExistingAdapterModelSettings(target, adapterList, { write: false });
    if (preservation.errors.length > 0) {
      for (const e of preservation.errors) console.error(`  ERROR: ${e}`);
      process.exitCode = 1;
      return;
    }
    if (preservation.updated.length > 0) effectiveConfig = deepMerge(effectiveConfig, preservation.config);
  }

  const result = generateAdapterArtifacts({
    target,
    alConfig: effectiveConfig,
    adapter: sub,
    outputDirOpt: opts.outputDir,
    forceGenerated,
    extraWrites: preservation?.content ? [{ relPath: 'agenticloop.json', content: preservation.content }] : undefined,
  });

  if (!result.ok) {
    for (const error of result.errors) console.error(`  ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }

  // Print preservation messages only after successful commit (Defect 14).
  if (preservation) printPreservationResult(preservation);
  // Print stale warnings from the transaction.
  for (const warning of result.errors) console.warn(`  WARN: ${warning}`);

  console.log(`Generated ${result.files.length} artifact(s) under ${result.outputDir}:`);
  for (const file of result.files) console.log(`  ${file}`);
}

async function cmdInit(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'adapter', 'setup', 'opencode', 'updateAssets', 'agentsGuidance', 'noAgentsGuidance'], 'init');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const setup = Boolean(opts.setup);
  const guidanceEnabled = !opts.noAgentsGuidance && opts.agentsGuidance !== false;
  const installationExisted = existsSync(join(target, 'agenticloop')) ||
    existsSync(join(target, '.agenticloop', 'project.md')) ||
    existsSync(join(target, '.agenticloop', 'generated-artifacts.json'));

  if (opts.updateAssets) {
    console.error("init --update-assets has been removed. Use 'agenticloop update' instead.");
    process.exitCode = 1;
    return;
  }

  if (setup) {
    console.log('  Hint: agenticloop setup provides a guided onboarding experience.');
    console.log(`  Try: npx agenticloop setup${adapter ? ` --adapter ${adapter}` : ''}`);
    console.log();
  }

  if (setup && !adapter) {
    console.error('--setup requires --adapter <host>');
    usage();
    process.exitCode = 1;
    return;
  }
  if (setup && adapter === 'all') {
    console.error('--setup requires one concrete adapter: opencode, codex, claude-code, copilot, or cursor');
    process.exitCode = 1;
    return;
  }

  const { errors: initErrors } = await init({
    target,
    opencode: Boolean(opts.opencode),
    adapter,
  });

  const errors = [...initErrors];

  // New installation: install the repository-rules activation-guidance block by
  // default. --no-agents-guidance opts out. The block is informational and does
  // not activate Agentic Loop.
  if (errors.length === 0 && guidanceEnabled) {
    const configResult = loadOptionalAlConfig(target);
    if (configResult.error) {
      console.error(`  ERROR: ${configResult.error}`);
      errors.push(configResult.error);
    } else {
      const priorGuidance = checkGuidance(target, { alConfig: configResult.config });
      // Repeat init follows the same no-silent-enrollment rule as update/setup.
      if (!installationExisted || priorGuidance.owned === true) {
        const guidance = applyGuidance(target, { alConfig: configResult.config, refreshOnly: installationExisted });
        if (guidance.changed) {
          console.log(`  guidance: ${guidance.action} in ${guidance.relPath}`);
        } else if (guidance.status === 'current') {
          console.log(`  guidance: already current in ${guidance.relPath}`);
        }
        for (const warning of guidance.warnings) console.warn(`  WARN: ${warning}`);
        if (!guidance.ok) errors.push(guidance.message);
      }
    }
  }

  if (setup && errors.length === 0 && adapter && adapter !== 'all') {
    const alConfig = loadAlConfigOrExit(target);
    if (alConfig) {
      const roles = Object.keys(alConfig.roles ?? {});
      const prompts = createPrompts();
      try {
        const mutations = await promptModelSettings(roles, adapter, prompts);
        const cfgResult = configureModels(target, { adapter, mutations });
        for (const w of cfgResult.warnings) console.warn(`  WARN: ${w}`);
        for (const e of cfgResult.errors) console.error(`  ERROR: ${e}`);
        for (const u of cfgResult.updated) console.log(`  updated: ${u}`);
        if (cfgResult.errors.length === 0 && cfgResult.updated.length > 0) {
          await cmdGenerate([adapter, '--target', target]);
        } else if (cfgResult.updated.length === 0) {
          console.log('  No model settings provided; skipping adapter generation.');
        }
        errors.push(...cfgResult.errors);
      } finally {
        prompts.close();
      }
    }
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdUpdate(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'adapter', 'forceGenerated'], 'update');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const configResult = loadOptionalAlConfig(target);
  if (configResult.error) {
    console.error(`  ERROR: ${configResult.error}`);
    process.exitCode = 1;
    return;
  }
  const guidanceConfig = configResult.config;
  // Determine whether this installation already owns a guidance block BEFORE any
  // asset refresh, so a file created during this command cannot be mistaken for
  // prior ownership. Existing installations are never silently enrolled.
  const guidanceOwnedBeforeUpdate = checkGuidance(target, { alConfig: guidanceConfig }).owned === true;
  const { adapters: requestedAdapters, errors: adapterErrors } = normalizeAdapterTargets(opts.adapter);

  for (const e of adapterErrors) console.error(e);
  if (adapterErrors.length > 0) {
    process.exitCode = 1;
    return;
  }

  // Detect adapters and load config before refreshing toolkit assets (Defect 13).
  // This ensures adapter preflight failures don't leave partially updated targets.
  const adapters = requestedAdapters.length > 0
    ? requestedAdapters
    : detectGeneratedAdapterTargets(target);

  if (adapters.length === 0) {
    // Still run init to refresh assets, but no adapter output needed.
    const { errors: initErrors } = await init({ target, refreshAssets: true });
    if (initErrors.length > 0) { process.exitCode = 1; return; }
    refreshOwnedGuidance(target, guidanceOwnedBeforeUpdate, guidanceConfig);
    console.log('  No existing generated adapter artifacts found.');
    console.log("  Use 'agenticloop update --adapter <host>' to generate a specific adapter.");
    process.exitCode = 0;
    return;
  }

  if (adapters.includes('all')) {
    console.log('  --adapter all selected: generating every implemented adapter artifact.');
  }

  // Load config and run adapter preflight before modifying any files.
  const alConfig = loadAlConfigOrExit(target);
  if (!alConfig) return;

  const preflightErrors = validateAdapterListGenerationPreflight(adapters, alConfig);
  if (preflightErrors.length > 0) {
    for (const error of preflightErrors) console.error(error);
    process.exitCode = 1;
    return;
  }

  // Now safe to refresh toolkit assets and regenerate.
  const { errors: initErrors } = await init({
    target,
    refreshAssets: true,
  });

  if (initErrors.length > 0) {
    process.exitCode = 1;
    return;
  }

  await generateAdapterTarget(adapters.includes('all') ? 'all' : adapters, {
    opts: { forceGenerated: Boolean(opts.forceGenerated) },
    target,
    alConfig,
    preserveExistingModels: true,
  });

  refreshOwnedGuidance(target, guidanceOwnedBeforeUpdate, alConfig);
}

// Existing-installation update refreshes only an already-owned, unchanged
// guidance block. It never enrolls a target that has no owned block and never
// adopts an unowned manual marker block.
function refreshOwnedGuidance(target, ownedBeforeUpdate, alConfig = null) {
  if (!ownedBeforeUpdate) return;
  const guidance = applyGuidance(target, { alConfig, refreshOnly: true });
  if (guidance.changed) {
    console.log(`  guidance: ${guidance.action} in ${guidance.relPath}`);
  }
  for (const warning of guidance.warnings) console.warn(`  WARN: ${warning}`);
  if (!guidance.ok && guidance.warnings.length === 0) {
    console.warn(`  WARN: ${guidance.message}`);
  }
}

async function cmdRemove(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'dryRun', 'yes', 'includeState'], 'remove');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const dryRun = Boolean(opts.dryRun);
  const yes = Boolean(opts.yes);
  const includeState = Boolean(opts.includeState);

  if (!dryRun && !yes) {
    console.error("Refusing to remove without confirmation. Run 'agenticloop remove --dry-run' first, then 'agenticloop remove --yes'.");
    process.exitCode = 1;
    return;
  }

  const { removed, released = [], skipped, errors, cleanupErrors = [] } = removeAgenticLoop({ target, dryRun, includeState });

  console.log();
  console.log('agenticloop remove');
  console.log('='.repeat(50));
  if (dryRun) console.log('  (dry run - no changes will be made)');

  if (removed.length === 0 && released.length === 0 && skipped.length === 0 && errors.length === 0) {
    console.log('  No Agentic Loop assets found.');
  }

  const prefix = dryRun ? 'would remove' : 'removed';
  for (const f of removed) console.log(`  ${prefix}: ${f}`);
  for (const f of released) console.log(`  ${dryRun ? 'would release' : 'released'}: ${f}`);
  for (const f of skipped) console.log(`  skipped: ${f}`);
  for (const e of errors) console.error(`  ERROR: ${e}`);
  for (const e of cleanupErrors) console.error(`  CLEANUP ERROR: ${e}`);
  console.log();

  process.exitCode = errors.length > 0 || cleanupErrors.length > 0 ? 1 : 0;
}

function loadOptionalAlConfig(target) {
  const alCfgPath = join(target, 'agenticloop.json');
  if (!existsSync(alCfgPath)) return { config: null, error: null };
  try {
    return { config: loadAgenticLoopConfig(alCfgPath), error: null };
  } catch (error) {
    return { config: null, error: `agenticloop.json is malformed: ${error.message}` };
  }
}

function guidanceStatusLabel(status) {
  switch (status) {
    case 'current': return 'current and owned';
    case 'stale': return 'stale and refreshable';
    case 'modified': return 'owned block modified';
    case 'manual': return 'manual/unowned marker block';
    case 'malformed': return 'malformed markers';
    case 'unsafe-path': return 'unsafe rules path';
    case 'malformed-manifest': return 'malformed ownership manifest';
    case 'path-mismatch': return 'owned guidance at a previous rules path';
    case 'multiple-owned': return 'multiple owned guidance entries';
    case 'absent': return 'absent';
    default: return status;
  }
}

async function cmdGuidance(args) {
  const sub = args[0];
  if (!sub || !['apply', 'check', 'remove'].includes(sub)) {
    console.error('guidance requires a subcommand: apply | check | remove');
    process.exitCode = 1;
    return;
  }
  const { opts } = parseArgs(args.slice(1));
  warnUnknownOptions(opts, ['target', 'force'], `guidance ${sub}`);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const configResult = loadOptionalAlConfig(target);
  if (configResult.error) {
    console.error(`  ERROR: ${configResult.error}`);
    process.exitCode = 1;
    return;
  }
  const alConfig = configResult.config;
  const force = Boolean(opts.force);

  console.log();
  console.log(`agenticloop guidance ${sub}`);
  console.log('='.repeat(50));

  if (sub === 'check') {
    const result = checkGuidance(target, { alConfig });
    console.log(`  rules document: ${result.relPath ?? '(unresolved)'}`);
    console.log(`  status: ${guidanceStatusLabel(result.status)}`);
    console.log(`  ${result.message}`);
    console.log();
    process.exitCode = ['unsafe-path', 'malformed', 'malformed-manifest', 'path-mismatch', 'multiple-owned'].includes(result.status) ? 1 : 0;
    return;
  }

  const result = sub === 'apply'
    ? applyGuidance(target, { alConfig, force })
    : removeGuidance(target, { alConfig, force });

  console.log(`  rules document: ${result.relPath ?? '(unresolved)'}`);
  console.log(`  ${result.action}: ${result.message}`);
  for (const warning of result.warnings) console.warn(`  WARN: ${warning}`);
  console.log();
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdValidate(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'adapter', 'links'], 'validate');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const forcedAdapters = Array.isArray(opts.adapter) ? opts.adapter : (opts.adapter ? [opts.adapter] : []);
  const result = runValidation(target, { adapters: forcedAdapters });

  if (result.totalErrors > 0) {
    process.exitCode = 1;
  }
}

async function cmdGithubPreflight(args) {
  const { opts } = parseArgs(args);
  const asJson = Boolean(opts.json);

  if (!opts.pr) {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, errors: ['--pr <number> is required'] }));
    } else {
      console.error('github-preflight requires --pr <number>');
    }
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = runPreflight({ pr: opts.pr, issue: opts.issue, repo: opts.repo });
  } catch (error) {
    if (error instanceof PreflightError) {
      if (asJson) {
        console.log(JSON.stringify({ ok: false, errors: [error.message] }));
      } else {
        console.error(`github-preflight failed: ${error.message}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (asJson) {
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  console.log();
  console.log('agenticloop github-preflight');
  console.log('='.repeat(50));
  console.log(`  PR: #${result.pr}`);
  console.log(`  issue: ${result.issue !== null ? `#${result.issue}` : 'none'}`);
  console.log(`  current head: ${result.headRefOid || 'unknown'}`);
  console.log(`  required checks: ${result.requiredChecks.length}`);
  console.log(`  matched evidence: ${result.evidenceMatches.length}`);

  if (result.statusSubstitutions.length > 0) {
    console.log('  status-check substitutions:');
    for (const sub of result.statusSubstitutions) {
      console.log(`    - '${sub.check}' satisfied by status check '${sub.statusCheck}'`);
    }
  } else {
    console.log('  status-check substitutions: none');
  }

  for (const warning of result.warnings) console.warn(`  WARN: ${warning}`);

  if (result.ok) {
    console.log('  preflight passed');
    console.log();
    process.exitCode = 0;
    return;
  }

  console.log('  preflight FAILED:');
  for (const error of result.errors) console.error(`    ERROR: ${error}`);
  console.log();
  process.exitCode = 1;
}

async function cmdGithubReviewAudit(args) {
  const { opts } = parseArgs(args);
  const asJson = Boolean(opts.json);
  if (!opts.pr) {
    const error = '--pr <number> is required';
    if (asJson) console.log(JSON.stringify({ ok: false, errors: [error] }));
    else console.error(`github-review-audit requires ${error}`);
    process.exitCode = 1;
    return;
  }
  const expectedStatus = opts.expectStatus ?? 'accepted';
  let result;
  try {
    result = runGitHubReviewAudit({ pr: opts.pr, issue: opts.issue, repo: opts.repo, expectedStatus });
  } catch (error) {
    if (!(error instanceof GitHubReviewAuditError)) throw error;
    if (asJson) console.log(JSON.stringify({ ok: false, errors: [error.message] }));
    else console.error(`github-review-audit failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(result));
  } else {
    console.log();
    console.log('agenticloop github-review-audit');
    console.log('='.repeat(50));
    console.log(`  PR: #${result.pr}`);
    console.log(`  issue: ${result.issue === null ? 'none' : `#${result.issue}`}`);
    console.log(`  current head: ${result.headRefOid || 'unknown'}`);
    console.log(`  independent review required: ${result.independentReviewRequired}`);
    console.log(`  expected status: ${result.expectedStatus}`);
    if (result.outcome) console.log(`  outcome: ${result.outcome.status} via ${result.outcome.mode}`);
    if (result.ok) {
      console.log(`  provenance valid: yes`);
      console.log(`  acceptance ready: ${result.acceptanceReady ? 'yes' : 'no'}`);
      if (result.expectedStatus === 'needs_revision') {
        console.log('  review audit passed (needs_revision confirmed)');
      } else {
        console.log('  review provenance passed');
      }
    } else {
      console.log(`  provenance valid: ${result.provenanceValid ? 'yes' : 'no'}`);
      console.log(`  acceptance ready: ${result.acceptanceReady ? 'yes' : 'no'}`);
      for (const error of result.errors) console.error(`    ERROR: ${error}`);
    }
    console.log();
  }
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdGithubReady(args) {
  const { opts } = parseArgs(args);
  const asJson = Boolean(opts.json);
  if (!opts.pr) {
    if (asJson) console.log(JSON.stringify({ ok: false, readyForMerge: false, errors: ['--pr <number> is required'] }));
    else console.error('github-ready requires --pr <number>');
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = runGitHubReady({ pr: opts.pr, issue: opts.issue, repo: opts.repo });
  } catch (error) {
    if (!(error instanceof GitHubReadyError)) throw error;
    if (asJson) console.log(JSON.stringify({ ok: false, readyForMerge: false, errors: [error.message] }));
    else console.error(`github-ready failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const { summary, errors } = formatGitHubReadyReport(result);
  console.log();
  for (const line of summary) console.log(line);
  for (const error of errors) console.error(`    ERROR: ${error}`);
  console.log();
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdEvent(args, commandLabel = 'event-logging', io = createIo()) {
  const sub = args[0];

  if (!sub) {
    io.err(`${commandLabel} requires an event type, 'validate', 'audit', or 'report'`);
    usage(io);
    return 1;
  }

  if (sub === '--help' || sub === '-h') {
    io.out(`${commandLabel} [event_type|validate|audit|report] [options]`);
    io.out();
    io.out('Subcommands:');
    io.out('  validate              Validate event log files.');
    io.out('  audit                 Audit task event logs for required events.');
    io.out('  report                Generate a per-task or aggregate report from event logs.');
    io.out('                        Add --features for a feature-adoption telemetry report.');
    io.out();
    io.out('Write path (bare event type):');
    io.out(`  ${commandLabel} <event_type> --summary "..." [options]`);
    io.out();
    io.out('  event_type is a positional — one of:');
    for (const t of VALID_EVENT_TYPES) io.out(`    ${t}`);
    io.out();
    io.out('Write options:');
    io.out('  --summary <text>      Required. Event description.');
    io.out('  --outcome <outcome>   Event outcome.');
    io.out('  --role <role>         Role associated with the event.');
    io.out('  --backend <backend>   Storage backend (files, github).');
    io.out('  --task <id>           Task identifier.');
    io.out('  --trace-id <id>       Trace identifier.');
    io.out('  --parent-event-id <id> Parent event identifier.');
    io.out('  --refs <a,b,...>      Comma-separated list of references.');
    io.out('  --data-json <json>    JSON event data payload.');
    io.out();
    return 0;
  }

  const { opts } = parseArgs(args.slice(1));
  const target = opts.target ? resolve(io.cwd, opts.target) : io.cwd;

  if (sub === 'validate') {
    warnUnknownOptions(opts, ['target', 'output'], `${commandLabel} validate`, io);
    const eventLogDirectory = resolveLogDirectory(target);
    const pathResult = opts.output ? resolveEventLogPath(target, opts.output) : null;
    const eventLogPath = pathResult?.path ?? null;
    const pathWarnings = pathResult?.warnings ?? [];
    const result = opts.output
      ? validateEventLogFile(eventLogPath, { target })
      : validateEventLogs(target);

    io.out();
    io.out(`agenticloop ${commandLabel} validate`);
    io.out('='.repeat(50));
    if (opts.output) io.out(`  event log: ${eventLogPath}`);
    else io.out(`  directory: ${eventLogDirectory}`);
    for (const warning of pathWarnings) io.warn(`  WARN: ${warning}`);
    if (!result.exists) {
      io.out('  No event logs found.');
      io.out();
      return 0;
    }
    for (const error of result.errors) io.err(`  ERROR: ${error}`);
    for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);
    if (result.errors.length === 0 && result.warnings.length === 0 && pathWarnings.length === 0) {
      if (opts.output) {
        io.out(`  OK: ${result.eventCount} event(s) validated`);
      } else {
        io.out(`  OK: ${result.fileCount} file(s), ${result.eventCount} event(s) validated`);
      }
    } else {
      if (!opts.output) io.out(`  files: ${result.fileCount}`);
      io.out(`  events: ${result.eventCount}`);
    }
    io.out();
    return result.errors.length > 0 ? 1 : 0;
  }

  if (sub === 'audit') {
    warnUnknownOptions(opts, ['target', 'task', 'require'], `${commandLabel} audit`, io);
    if (!opts.task) {
      io.err('--task is required for event log audit');
      return 1;
    }

    const requireResult = parseRequiredEventTypesOption(opts.require);
    for (const error of requireResult.errors) io.err(error);
    if (requireResult.errors.length > 0) {
      return 1;
    }

    let result;
    try {
      result = auditTaskEventLog({
        target,
        taskId: opts.task,
        requiredEventTypes: requireResult.requiredEventTypes,
        explicitRequire: requireResult.explicitRequire,
      });
    } catch (error) {
      io.err(error.message);
      return 1;
    }

    io.out();
    io.out(`agenticloop ${commandLabel} audit`);
    io.out('='.repeat(50));
    io.out(`  task: ${result.taskId}`);
    io.out(`  event log: ${result.path}`);
    io.out(`  event_logging: ${result.eventLogging}`);
    io.out(`  required events: ${result.requiredEventTypes.join(', ')}`);

    if (result.skipped) {
      io.out('  Event logging is disabled in .agenticloop/project.md; skipping strict audit.');
      io.out();
      return 0;
    }

    if (result.durableClosure) {
      const status = result.durableClosure.satisfied
        ? 'yes'
        : `no (${result.durableClosure.reason})`;
      io.out(`  durable task.closed: ${status}`);
    }

    if (!result.enabled && result.explicitRequire) {
      io.out('  Event logging is disabled in .agenticloop/project.md, but explicit --require requested an audit.');
    }

    for (const error of result.errors) io.err(`  ERROR: ${error}`);
    for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);

    if (result.errors.length === 0) {
      io.out(`  OK: ${result.eventCount} event(s) validated for strict audit`);
    } else {
      io.out(`  events: ${result.eventCount}`);
    }

    io.out();
    return result.errors.length > 0 ? 1 : 0;
  }

  if (sub === 'report') {
    warnUnknownOptions(opts, ['target', 'task', 'features'], `${commandLabel} report`, io);
    if (opts.features) {
      let result;
      try {
        result = reportEventLogs({ target });
      } catch (error) {
        io.err(`Failed to generate feature telemetry report: ${error.message}`);
        return 1;
      }
      printFeatureReport(result, commandLabel, io);
      return 0;
    }

    if (opts.task) {
      let result;
      try {
        result = reportTaskEventLog({ target, taskId: opts.task });
      } catch (error) {
        io.err(error.message);
        return 1;
      }

      io.out();
      io.out(`agenticloop ${commandLabel} report`);
      io.out('='.repeat(50));
      io.out(`  task: ${result.taskId}`);
      io.out(`  event log: ${result.path}`);
      io.out(`  events: ${result.eventCount}`);
      io.out(`  first event: ${result.firstEventTimestamp ?? 'none'}`);
      io.out(`  last event: ${result.lastEventTimestamp ?? 'none'}`);
      io.out(`  trace duration: ${result.traceDuration}`);
      io.out(`  strict audit present: ${formatSummaryList(result.strictAudit.presentEventTypes)}`);
      io.out(`  strict audit missing: ${formatSummaryList(result.strictAudit.missingEventTypes)}`);
      const durableClosureStatus = result.strictAudit.durableClosure.satisfied
        ? 'yes'
        : `no (${result.strictAudit.durableClosure.reason})`;
      io.out(`  durable task.closed: ${durableClosureStatus}`);
      io.out(
        `  check.run counts: success=${result.checkRunCounts.success}, failure=${result.checkRunCounts.failure}, blocked=${result.checkRunCounts.blocked}`
      );
      io.out(
        `  review.result counts: accepted=${result.reviewResultCounts.accepted}, needs_revision=${result.reviewResultCounts.needs_revision}`
      );
      io.out(`  review rounds: ${formatSummaryList(result.reviewRounds)}`);
      io.out(`  role.invoked targets: ${formatCountSummary(result.roleInvoked.targetRoleCounts)}`);
      io.out(`  delegation modes: ${formatCountSummary(result.roleInvoked.delegationModeCounts)}`);
      io.out(`  fallback count: ${result.roleInvoked.fallbackCount}`);
      const tpq = result.provenanceQuality;
      io.out('  provenance quality (telemetry; historical events labeled, not rewritten):');
      io.out(`    role.invoked missing target_role=${tpq.roleInvokedMissingTargetRole}, missing delegation_mode=${tpq.roleInvokedMissingDelegationMode}, missing/non-boolean fallback=${tpq.roleInvokedMissingFallback}`);
      io.out(`    fallback without cause=${tpq.roleInvokedFallbackWithoutCause}, inconsistent mode/fallback=${tpq.roleInvokedInconsistentModeFallback}`);
      io.out(`    non-orchestrator emitter=${tpq.roleInvokedNonOrchestrator}, self-invocation=${tpq.roleInvokedSelfInvocation}`);
      io.out(`    review.result missing review_mode=${tpq.reviewResultMissingReviewMode}, non-maintainer emitter=${tpq.reviewResultNonMaintainer}, maintainer review rounds without correlated delegation/continuation=${tpq.reviewRoundsWithoutBacking}`);
      io.out(`    maintainer_fixup: true events=${tpq.maintainerFixupEvents}${tpq.multipleFixupEpisodes ? ' (multiple-episode anomaly)' : ''}`);
      io.out(`  refs summary: ${formatRefSummary(result.refsSummary)}`);

      io.out('  accepted imperfect checks (not clean success):');
      if (result.acceptedImperfectChecks.length === 0) {
        io.out('    none');
      } else {
        for (const check of result.acceptedImperfectChecks) {
          const details = [];
          if (check.command) details.push(`command=${check.command}`);
          const triage = [];
          if (check.triaged_unrelated) triage.push('triaged_unrelated');
          if (check.accepted_known_failure) triage.push('accepted_known_failure');
          if (triage.length > 0) details.push(`triage=${triage.join(',')}`);
          details.push(`refs=${check.refs.length > 0 ? check.refs.join(', ') : 'none'}`);
          io.out(`    - ${check.outcome}: ${check.summary} (${details.join('; ')})`);
        }
      }

      io.out('  failed/blocked checks:');
      if (result.failedOrBlockedChecks.length === 0) {
        io.out('    none');
      } else {
        for (const check of result.failedOrBlockedChecks) {
          const details = [];
          if (check.command) details.push(`command=${check.command}`);
          details.push(`refs=${check.refs.length > 0 ? check.refs.join(', ') : 'none'}`);
          io.out(`    - ${check.outcome}: ${check.summary} (${details.join('; ')})`);
        }
      }

      for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);
      io.out();
      return 0;
    }

    let result;
    try {
      result = reportEventLogs({ target });
    } catch (error) {
      io.err(`Failed to generate aggregate event log report: ${error.message}`);
      return 1;
    }

    io.out();
    io.out(`agenticloop ${commandLabel} report`);
    io.out('='.repeat(50));
    io.out(`  directory: ${result.directory}`);
    io.out(`  files scanned: ${result.filesScanned}`);
    io.out(`  valid task logs: ${result.validTaskLogCount}`);
    io.out(`  invalid logs: ${result.invalidLogCount}`);
    io.out(`  empty logs: ${result.emptyLogCount}`);
    io.out();

    if (result.missingLogs) {
      io.out('  No event log files found.');
      io.out();
      return 0;
    }

    io.out(`  strict audit: pass=${result.strictAuditPassCount}, fail=${result.strictAuditFailCount}`);
    io.out(
      `  durable task.closed: satisfied=${result.durableClosureSatisfied}, missing=${result.durableClosureMissing}, failing=${result.durableClosureFailing}`
    );
    io.out(
      `  check.run totals: success=${result.totalCheckOutcomes.success}, failure=${result.totalCheckOutcomes.failure}, blocked=${result.totalCheckOutcomes.blocked}`
    );
    io.out(
      `  review.result totals: accepted=${result.totalReviewOutcomes.accepted}, needs_revision=${result.totalReviewOutcomes.needs_revision}`
    );
    io.out(`  role.invoked targets: ${formatCountSummary(result.totalRoleInvokedTargets)}`);
    io.out(`  delegation modes: ${formatCountSummary(result.totalDelegationModes)}`);
    io.out(`  fallback count: ${result.totalFallbackCount}`);
    io.out(`  tasks with review churn: ${result.tasksWithReviewChurn.length} (${formatTaskIdList(result.tasksWithReviewChurn)})`);
    io.out(`  tasks missing role.invoked: ${result.tasksWithMissingRoleInvoked.length} (${formatTaskIdList(result.tasksWithMissingRoleInvoked)})`);
    io.out(`  tasks missing task.started: ${result.tasksWithMissingTaskStarted.length} (${formatTaskIdList(result.tasksWithMissingTaskStarted)})`);
    io.out(`  tasks missing review.result: ${result.tasksWithMissingReviewResult.length} (${formatTaskIdList(result.tasksWithMissingReviewResult)})`);
    io.out(`  tasks missing task.closed: ${result.tasksWithMissingTaskClosed.length} (${formatTaskIdList(result.tasksWithMissingTaskClosed)})`);
    io.out(`  events with host=unknown: ${result.hostUnknownEvents.length}`);
    io.out();

    const pq = result.provenanceQuality;
    io.out('  delegation/review provenance quality (telemetry; historical events are labeled, not rewritten):');
    printProvenanceQualityMetric('role.invoked missing target_role', pq.roleInvokedMissingTargetRole, io);
    printProvenanceQualityMetric('role.invoked missing delegation_mode', pq.roleInvokedMissingDelegationMode, io);
    printProvenanceQualityMetric('role.invoked missing/non-boolean fallback', pq.roleInvokedMissingFallback, io);
    printProvenanceQualityMetric('fallback mode without structured cause', pq.roleInvokedFallbackWithoutCause, io);
    printProvenanceQualityMetric('inconsistent mode/fallback combination', pq.roleInvokedInconsistentModeFallback, io);
    printProvenanceQualityMetric('role.invoked emitted by non-orchestrator', pq.roleInvokedNonOrchestrator, io);
    printProvenanceQualityMetric('self-invocation (emitter == target)', pq.roleInvokedSelfInvocation, io);
    printProvenanceQualityMetric('review.result missing review_mode', pq.reviewResultMissingReviewMode, io);
    printProvenanceQualityMetric('review.result emitted by non-maintainer', pq.reviewResultNonMaintainer, io);
    printProvenanceQualityMetric('maintainer review rounds without correlated delegation or continuation', pq.reviewRoundsWithoutBacking, io);
    const fixup = result.features.maintainerFixup;
    io.out(`    maintainer_fixup: true events (event count, not proven-deduplicated episodes): ${fixup.episodeCount}`);
    io.out(`    tasks with a fixup event: ${fixup.tasksWithFixup.length} (${formatTaskIdList(fixup.tasksWithFixup)})`);
    io.out(`    tasks with more than one fixup event (multiple-episode anomaly): ${fixup.tasksWithMultipleFixups.length} (${formatTaskIdList(fixup.tasksWithMultipleFixups)})`);
    io.out();

    io.out('  per-task summary:');
    io.out(
      `    ${'task id'.padEnd(12)} ${'events'.padEnd(7)} ${'missing strict'.padEnd(15)} ${'closure'.padEnd(10)} ${'review rounds'.padEnd(14)} ${'checks (s/f/b)'.padEnd(16)} host quality`
    );
    for (const task of result.tasks) {
      const missing = task.strictAudit.missingEventTypes.join(', ') || 'none';
      const closure = task.strictAudit.durableClosure.satisfied ? 'satisfied' : 'missing/failing';
      const rounds = task.reviewRounds.join(', ') || 'none';
      const checks = `${task.checkRunCounts.success}/${task.checkRunCounts.failure}/${task.checkRunCounts.blocked}`;
      const hostQuality = result.hostUnknownEvents.some(entry =>
        entry.taskId === task.taskId || entry.inferredTaskId === task.taskId
      ) ? 'unknown present' : 'ok';
      io.out(
        `    ${String(task.taskId).padEnd(12)} ${String(task.eventCount).padEnd(7)} ${missing.padEnd(15)} ${closure.padEnd(10)} ${rounds.padEnd(14)} ${checks.padEnd(16)} ${hostQuality}`
      );
    }

    if (result.invalidLogs.length > 0) {
      io.out();
      io.out('  invalid logs:');
      for (const invalid of result.invalidLogs) {
        io.out(`    - ${invalid.displayPath} (${invalid.eventCount} events)`);
        for (const error of invalid.errors) io.err(`      ERROR: ${error}`);
        for (const warning of invalid.warnings) io.warn(`      WARN: ${warning}`);
      }
    }

    if (result.emptyLogs.length > 0) {
      io.out();
      io.out('  empty logs:');
      for (const empty of result.emptyLogs) {
        io.out(`    - ${empty.displayPath} (${empty.eventCount} events)`);
        for (const warning of empty.warnings) io.warn(`      WARN: ${warning}`);
      }
    }

    if (result.hostUnknownEvents.length > 0) {
      io.out();
      io.out('  host=unknown events:');
      for (const entry of result.hostUnknownEvents) {
        io.out(`    - ${entry.file} line ${entry.line} (${entry.taskId})`);
      }
    }

    for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);
    io.out();
    return 0;
  }

  warnUnknownOptions(
    opts,
    ['target', 'summary', 'outcome', 'role', 'backend', 'task', 'traceId', 'parentEventId', 'ref', 'refs', 'dataJson', 'output', 'host'],
    `${commandLabel} ${sub}`,
    io
  );

  if (opts.refs !== undefined) {
    const refs = String(opts.refs).split(',').map(ref => ref.trim()).filter(Boolean);
    const existing = Array.isArray(opts.ref) ? opts.ref : (opts.ref ? [opts.ref] : []);
    opts.ref = [...existing, ...refs];
  }

  if (!opts.summary) {
    io.err('--summary is required for event writes');
    return 1;
  }

  let data = {};
  if (opts.dataJson !== undefined) {
    try {
      data = JSON.parse(opts.dataJson);
    } catch (error) {
      io.err(`--data-json must be valid JSON: ${error.message}`);
      return 1;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      io.err('--data-json must decode to a JSON object');
      return 1;
    }
  }

  const backendResolution = resolveTaskBackend(target);
  for (const warning of backendResolution.warnings) io.warn(`  WARN: ${warning}`);
  const defaultBackend = backendResolution.backend === 'files' || backendResolution.backend === 'github'
    ? backendResolution.backend
    : 'unknown';
  const outcomeOption = normalizeEventOutcomeOption(sub, opts.outcome);
  for (const warning of outcomeOption.warnings) io.warn(`  WARN: ${warning}`);

  const event = buildEvent({
    target,
    eventType: sub,
    task: opts.task,
    role: opts.role,
    summary: opts.summary,
    outcome: outcomeOption.outcome ?? (sub === 'check.run' ? inferCheckRunOutcome(data) : undefined),
    backend: opts.backend ?? defaultBackend,
    host: inferEventHost(target, opts.host),
    traceId: opts.traceId,
    parentEventId: opts.parentEventId,
    refs: opts.ref,
    data,
  });

  const validation = validateNewEvent(event, { target });
  for (const error of validation.errors) io.err(`  ERROR: ${error}`);
  for (const warning of validation.warnings) io.warn(`  WARN: ${warning}`);

  if (validation.errors.length > 0) {
    return 1;
  }

  let pathResult;
  try {
    pathResult = resolveEventLogPath(target, opts.output, event.task_id);
  } catch (error) {
    io.err(error.message);
    return 1;
  }

  const { path: eventLogPath, warnings: pathWarnings } = pathResult;
  for (const warning of pathWarnings) io.warn(`  WARN: ${warning}`);

  appendEventLog({ target, output: opts.output, event, path: eventLogPath });
  io.out(`Appended event '${event.event_type}' to ${eventLogPath}`);
  io.out(`  event_id: ${event.event_id}`);
  io.out(`  trace_id: ${event.trace_id}`);
  return 0;
}

async function cmdConfigureModels(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'adapter', 'role', 'model', 'reasoningEffort', 'profile'], 'configure models');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  let adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const profile = Array.isArray(opts.profile) ? opts.profile[0] : opts.profile;

  if (!adapter) {
    const detected = detectHost(target);
    if (detected.length === 1) {
      adapter = detected[0];
      console.log(`Detected host: ${adapter}`);
    } else if (detected.length > 1) {
        console.error(`Multiple hosts detected (${detected.join(', ')}). Use --adapter <host> with one of: opencode, codex, claude-code, copilot, cursor.`);
        process.exitCode = 1;
        return;
      } else {
        console.error('No host detected. Use --adapter <host> with one of: opencode, codex, claude-code, copilot, cursor.');
        process.exitCode = 1;
        return;
      }
  }

  const hostError = validateHost(adapter);
  if (hostError) {
    console.error(hostError);
    process.exitCode = 1;
    return;
  }

  const mutationFlags = new Set(['--role', '--model', '--reasoning-effort']);
  if (profile !== undefined) {
    if (args.some(arg => mutationFlags.has(arg))) {
      console.error('--profile recommended cannot be combined with --role, --model, or --reasoning-effort.');
      process.exitCode = 1;
      return;
    }

    const { errors, warnings, updated, preserved } = configureModels(target, { adapter, profile });
    for (const w of warnings) console.warn(`  WARN: ${w}`);
    for (const e of errors) console.error(`  ERROR: ${e}`);
    for (const u of updated) console.log(`  added: ${u}`);
    for (const p of preserved) console.log(`  kept: ${p}`);

    if (errors.length === 0 && updated.length > 0) {
      console.log();
      console.log(`Run 'agenticloop generate ${adapter}' to refresh adapter artifacts.`);
    }
    process.exitCode = errors.length > 0 ? 1 : 0;
    return;
  }

  let mutations = parseModelMutations(args);

  if (mutations.length === 0) {
    const alConfig = loadAlConfigOrExit(
      target,
      `agenticloop.json not found. Run agenticloop init --adapter <host> first to enable adapter model configuration.`
    );
    if (!alConfig) {
      process.exitCode = 1;
      return;
    }
    const roles = Object.keys(alConfig.roles ?? {});
    const currentSettings = alConfig.adapters?.[adapter]?.roleSettings ?? {};
    const prompts = createPrompts();
    try {
      const { mutations: picked, cancelled } = await promptModelSettingsInteractive(
        roles, adapter, prompts, currentSettings, { discoverModels: true }
      );
      if (cancelled) {
        console.log('Model configuration cancelled.');
        process.exitCode = 0;
        return;
      }
      mutations = picked;
    } finally {
      prompts.close();
    }
  }

  if (mutations.length === 0) {
    console.log('No model settings provided; nothing to write.');
    process.exitCode = 0;
    return;
  }

  const { errors, warnings, updated } = configureModels(target, { adapter, mutations });

  for (const w of warnings) console.warn(`  WARN: ${w}`);
  for (const e of errors) console.error(`  ERROR: ${e}`);
  for (const u of updated) console.log(`  updated: ${u}`);

  if (errors.length === 0 && updated.length > 0) {
    console.log();
    console.log(`Run 'agenticloop generate ${adapter}' to refresh adapter artifacts.`);
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdSetup(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'adapter', 'yes', 'nonInteractive', 'agentsGuidance', 'noAgentsGuidance'], 'setup');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const nonInteractive = Boolean(opts.yes) || Boolean(opts.nonInteractive);
  const agentsGuidance = !opts.noAgentsGuidance && opts.agentsGuidance !== false;

  if (adapter) {
    const validAdapters = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all']);
    if (!validAdapters.has(adapter)) {
      console.error(`Unknown adapter '${adapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`);
      process.exitCode = 1;
      return;
    }
  }

  const { errors } = await setup({
    target,
    adapter,
    nonInteractive,
    agentsGuidance,
  });

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdDoctor(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target'], 'doctor');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  printDoctor(target);
}

async function cmdStatus(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target'], 'status');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  printAdapterDiscovery(target);
  console.log('Task state: run "agenticloop task list" to inspect files-backed task records.');
}

async function cmdWorktree(args) {
  const sub = args[0];
  if (!sub) {
    console.error('worktree requires a subcommand: add | guard | list | remove | cleanup | resolve-state | prune');
    process.exitCode = 1;
    return;
  }

  try {
    if (sub === 'add') {
      const { opts, positional } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'from'], 'worktree add');
      const [taskId, branch] = positional;
      if (!taskId || !branch || positional.length !== 2) {
        console.error('Usage: agenticloop worktree add <task-id> <branch> [--from <ref>] [--target <dir>]');
        process.exitCode = 1;
        return;
      }
      if (opts.from === true) {
        console.error('--from requires a ref value');
        process.exitCode = 1;
        return;
      }
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const result = createAgenticLoopWorktree({
        target,
        taskId,
        branch,
        from: opts.from,
      });
      console.log('Created Agentic Loop worktree:');
      console.log(`  path: ${result.path}`);
      console.log(`  branch: ${result.branch}`);
      console.log(`  from: ${result.from ?? '(existing branch)'}`);
      console.log(`  git guard: ${result.guard?.ok ? 'configured' : result.guard === null ? 'session environment required' : 'missing'}`);
      if (result.ignored) {
        console.log('  ignored: .agenticloop/worktrees/');
      }
      process.exitCode = 0;
      return;
    }

    if (sub === 'guard') {
      const { opts, positional } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'fix', 'all'], 'worktree guard');
      if (positional.length > 1) {
        console.error('Usage: agenticloop worktree guard [--fix] [--all|<path>] [--target <dir>]');
        process.exitCode = 1;
        return;
      }
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const result = guardAgenticLoopWorktrees({
        target,
        path: positional[0],
        all: Boolean(opts.all),
        fix: Boolean(opts.fix),
      });
      console.log(formatWorktreeGuardResult(result));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (sub === 'list') {
      const { opts } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'json'], 'worktree list');
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const asJson = Boolean(opts.json);
      const records = listAgenticLoopWorktrees(target);
      if (asJson) {
        console.log(JSON.stringify(records, null, 2));
      } else {
        console.log(formatWorktreeList(records));
      }
      process.exitCode = 0;
      return;
    }

    if (sub === 'remove') {
      const { opts, positional } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'dryRun', 'yes', 'force', 'json'], 'worktree remove');
      const identifier = positional[0];
      if (!identifier) {
        console.error('Usage: agenticloop worktree remove <task-id|path> [--target <dir>] [--dry-run|--yes] [--force] [--json]');
        process.exitCode = 1;
        return;
      }
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (!dryRun && !yes) {
        console.error("worktree remove requires either --dry-run or --yes");
        process.exitCode = 1;
        return;
      }
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const result = removeAgenticLoopWorktree({
        target,
        identifier,
        dryRun,
        yes,
        force: Boolean(opts.force),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatWorktreeRemoveResult(result, { dryRun }));
      }
      process.exitCode = result.errors.length > 0 ? 1 : 0;
      return;
    }

    if (sub === 'cleanup') {
      const { opts } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'dryRun', 'yes', 'json'], 'worktree cleanup');
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (!dryRun && !yes) {
        console.error("worktree cleanup requires either --dry-run or --yes");
        process.exitCode = 1;
        return;
      }
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const result = cleanupAgenticLoopWorktrees({
        target,
        dryRun,
        yes,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatWorktreeCleanupResult(result));
      }
      process.exitCode = result.errors.length > 0 ? 1 : 0;
      return;
    }

    if (sub === 'resolve-state') {
      const { opts, positional } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'strategy', 'dryRun', 'yes', 'json'], 'worktree resolve-state');
      const identifier = positional[0];
      if (!identifier) {
        console.error('Usage: agenticloop worktree resolve-state <task-id|path> [--target <dir>] [--strategy <strategy>] [--dry-run|--yes] [--json]');
        process.exitCode = 1;
        return;
      }
      const dryRun = !Boolean(opts.yes);
      const yes = Boolean(opts.yes);
      if (opts.dryRun && yes) {
        console.error('worktree resolve-state accepts either --dry-run or --yes, not both');
        process.exitCode = 1;
        return;
      }
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const result = resolveAgenticLoopStateConflicts({
        target,
        identifier,
        strategy: opts.strategy,
        dryRun,
        yes,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatResolveStateResult(result));
      }
      process.exitCode = result.errors.length > 0 ? 1 : 0;
      return;
    }

    if (sub === 'prune') {
      const { opts } = parseArgs(args.slice(1));
      warnUnknownOptions(opts, ['target', 'dryRun', 'yes', 'json'], 'worktree prune');
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (!dryRun && !yes) {
        console.error("worktree prune requires either --dry-run or --yes");
        process.exitCode = 1;
        return;
      }
      const target = opts.target && opts.target !== true ? resolve(opts.target) : process.cwd();
      const result = pruneAgenticLoopWorktrees({
        target,
        dryRun,
        yes,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatWorktreePruneResult(result));
      }
      process.exitCode = result.errors.length > 0 ? 1 : 0;
      return;
    }

    console.error(`Unknown worktree subcommand: ${sub}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function cmdBootstrapLabels(args) {
  const { opts } = parseArgs(args);
  warnUnknownOptions(opts, ['target', 'repo', 'dryRun', 'group', 'taskId', 'force'], 'bootstrap-labels');
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const projectMap = loadProjectMap(target)?.config ?? null;

  let alConfig = null;
  const alCfgPath = join(target, 'agenticloop.json');
  if (existsSync(alCfgPath)) {
    try {
      alConfig = loadAgenticLoopConfig(alCfgPath);
    } catch (e) {
      console.error(`Failed to load agenticloop.json: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // bootstrap-labels is a GitHub-backend-only setup step. Guard against running
  // it accidentally against a files-backed project, where it would create
  // GitHub labels the workflow never uses.
  const backendResolution = resolveTaskBackend(target);
  for (const warning of backendResolution.warnings) console.warn(`  WARN: ${warning}`);
  if (backendResolution.backend !== 'github' && !opts.force) {
    console.error(
      `Active task backend is '${backendResolution.backend}', not 'github'. ` +
      `bootstrap-labels creates GitHub labels and is only used by the github backend.\n` +
      `Set task_backend: github in .agenticloop/project.md, or pass --force to run anyway.`
    );
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log('agenticloop bootstrap-labels');
  console.log('='.repeat(50));
  if (opts.dryRun) console.log('  (dry run - no changes will be made)');

  const results = bootstrapLabels(alConfig, {
    repo: opts.repo,
    dryRun: Boolean(opts.dryRun),
    group: opts.group,
    taskId: opts.taskId,
    projectMap,
  });
  if (results.some(result => result.action === 'error')) {
    process.exitCode = 1;
  }
  console.log();
}

function loadAlConfigOrExit(target, hint = '') {
  const alCfgPath = join(target, 'agenticloop.json');
  if (!existsSync(alCfgPath)) {
    const msg = hint
      ? hint
      : `agenticloop.json not found. Run agenticloop init --adapter <host> first to create advanced adapter config.`;
    console.error(msg);
    process.exitCode = 1;
    return null;
  }
  try {
    return loadAgenticLoopConfig(alCfgPath);
  } catch (e) {
    console.error(`Failed to parse agenticloop.json: ${e.message}`);
    process.exitCode = 1;
    return null;
  }
}

function resolveOutputDir(opts, target) {
  if (opts.outputDir) {
    return isAbsolute(opts.outputDir) ? opts.outputDir : join(target, opts.outputDir);
  }
  return target;
}

async function cmdGenerate(subArgs) {
  const sub = subArgs[0];
  if (!sub) {
    console.error('generate requires a host target: opencode | codex | claude-code | copilot | cursor | all');
    process.exitCode = 1;
    return;
  }
  const { opts } = parseArgs(subArgs.slice(1));
  warnUnknownOptions(opts, ['target', 'outputDir', 'output', 'forceGenerated'], `generate ${sub}`);
  const target = opts.target ? resolve(opts.target) : process.cwd();

  const alConfig = loadAlConfigOrExit(target);
  if (!alConfig) return;
  await generateAdapterTarget(sub, { opts, target, alConfig, preserveExistingModels: true });
}

// --- entry ------------------------------------------------------------------

/**
 * Route a parsed argv to the matching command handler and return a numeric exit
 * code. Importing this module no longer executes anything; the binary calls
 * `runCli` (src/cli-main.js), which delegates here with an injected io context.
 *
 * Commands already migrated to the injectable-io contract (task, event) return
 * their own exit code and never touch global `process.exitCode`. Remaining
 * legacy handlers still communicate via `process.exitCode`; `dispatchLegacy`
 * snapshots and restores it so a call never leaves global state mutated.
 *
 * @param {string[]} argv  Arguments after the node/bin prefix.
 * @param {ReturnType<import('./cli-io.js').createIo>} [io]
 * @returns {Promise<number>} exit code
 */
export async function dispatch(argv, io = createIo()) {
  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case 'task':
      return await cmdTask(rest, io);
    case 'event-logging':
      return await cmdEvent(rest, 'event-logging', io);
    case 'event':
      return await cmdEvent(rest, 'event', io);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      usage(io);
      return 0;
    default:
      return await dispatchLegacy(command, rest);
  }
}

async function dispatchLegacy(command, rest) {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    switch (command) {
      case 'init':
        await cmdInit(rest);
        break;
      case 'setup':
        await cmdSetup(rest);
        break;
      case 'update':
        await cmdUpdate(rest);
        break;
      case 'upgrade':
        await cmdUpdate(rest);
        break;
      case 'remove':
        await cmdRemove(rest);
        break;
      case 'guidance':
        await cmdGuidance(rest);
        break;
      case 'validate':
        await cmdValidate(rest);
        break;
      case 'github-preflight':
        await cmdGithubPreflight(rest);
        break;
      case 'github-review-audit':
        await cmdGithubReviewAudit(rest);
        break;
      case 'github-ready':
        await cmdGithubReady(rest);
        break;
      case 'doctor':
        await cmdDoctor(rest);
        break;
      case 'worktree':
        await cmdWorktree(rest);
        break;
      case 'configure':
        if (rest[0] === 'models') {
          await cmdConfigureModels(rest.slice(1));
        } else {
          console.error(`Unknown configure subcommand: ${rest[0]}`);
          usage();
          process.exitCode = 1;
        }
        break;
      case 'status':
        await cmdStatus(rest);
        break;
      case 'bootstrap-labels':
        await cmdBootstrapLabels(rest);
        break;
      case 'generate':
        await cmdGenerate(rest);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exitCode = 1;
    }
    return process.exitCode ?? 0;
  } finally {
    process.exitCode = previousExitCode;
  }
}
