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
 *   agenticloop audit new --work-unit <id> --covered-tasks <ids> --artifact <ref> --goal <text> --completion-oracle <text> --evidence <text> [--budget <n>] [--target <dir>]
 *   agenticloop audit baseline <audit-id|work-unit> [--artifact <ref>] [--covered-tasks <ids>] --evidence <text> [--target <dir>]
 *   agenticloop audit report <audit-id|work-unit> --verdict <v> --invocation-mode <m> --invocation-ref <id> ...
 *   agenticloop audit status [<audit-id|work-unit>] [--json] [--target <dir>]
 *   agenticloop audit gate <audit-id|work-unit> [--json] [--target <dir>]
 *   agenticloop audit lint [<audit-id|work-unit>] [--json] [--target <dir>]
 *   agenticloop audit override <audit-id|work-unit> --budget <n> --authority <ref> [--target <dir>]
 *   agenticloop audit resolve <audit-id|work-unit> --authority <ref> --note <text> [--target <dir>]
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

import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { createIo, resolveCliTarget, CliUsageError, EXIT_USAGE } from './cli-io.js';
import {
  COMMAND_REGISTRY,
  findHelpRequest,
  packageVersion,
  parseCommandArgs,
  renderCommandHelp,
  renderFirstUse,
  renderFullHelp,
  resolveCommandName,
  suggestName,
} from './cli-registry.js';
import { lifecyclePlanBlockers } from './lifecycle-plan.js';
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
import { cmdAudit } from './audit-cli.js';
import {
  configureModels,
  parseModelMutations,
  detectHost,
  validateHost,
  promptModelSettings,
  promptModelSettingsInteractive,
} from './configure-models.js';
import { printAdapterDiscovery, printDoctor } from './adapter-discovery.js';
import { setup } from './setup.js';
import { removeAgenticLoop } from './remove.js';
import { applyGuidance, checkGuidance, removeGuidance } from './guidance.js';
import { preserveExistingAdapterModelSettings } from './adapter-model-preservation.js';
import { reconcileTargetAdapterConfig } from './setup-generate.js';
import {
  appendEventLog,
  auditTaskEventLog,
  buildEvent,
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

function printPreservationResult(preservation, io) {
  for (const w of preservation.warnings) io.warn(`  WARN: ${w}`);
  for (const e of preservation.errors) io.err(`  ERROR: ${e}`);
  for (const u of preservation.updated) io.out(`  preserved: ${u}`);
}

function shouldPreserveExistingModels(preserveExistingModels, outputDir, target) {
  return preserveExistingModels && resolve(outputDir) === resolve(target);
}

async function generateAdapterTarget(sub, { opts, target, alConfig, preserveExistingModels = true }, io) {
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
      for (const e of preservation.errors) io.err(`  ERROR: ${e}`);
      return 1;
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
    for (const error of result.errors) io.err(`  ERROR: ${error}`);
    return 1;
  }

  // Print preservation messages only after successful commit (Defect 14).
  if (preservation) printPreservationResult(preservation, io);
  // Print stale warnings from the transaction.
  for (const warning of result.errors) io.warn(`  WARN: ${warning}`);

  io.out(`Generated ${result.files.length} artifact(s) under ${result.outputDir}:`);
  for (const file of result.files) io.out(`  ${file}`);
  return 0;
}

async function cmdInit(args, io) {
  const { opts } = parseCommandArgs('init', COMMAND_REGISTRY.init, args);
  const target = resolveCliTarget(io, opts.target);
  const adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const setup = Boolean(opts.setup);
  const guidanceEnabled = !opts.noAgentsGuidance && opts.agentsGuidance !== 'off' && opts.agentsGuidance !== false;

  if (opts.updateAssets) {
    io.err("init --update-assets has been removed. Use 'agenticloop update' instead.");
    return 1;
  }

  if (setup) {
    io.warn('  DEPRECATED: init --setup is deprecated and will be removed in a later release.');
    io.out('  Hint: agenticloop setup provides a guided onboarding experience.');
    io.out(`  Try: npx agenticloop setup${adapter ? ` --adapter ${adapter}` : ''}`);
    io.out();
  }

  if (setup && !adapter) {
    io.err('--setup requires --adapter <host>');
    io.err('Run "agenticloop help init" for usage.');
    return EXIT_USAGE;
  }
  if (setup && adapter === 'all') {
    io.err('--setup requires one concrete adapter: opencode, codex, claude-code, copilot, or cursor');
    return EXIT_USAGE;
  }

  const { errors: initErrors, plan: initPlanResult } = await init({
    target,
    opencode: Boolean(opts.opencode),
    adapter,
    io,
    dryRun: Boolean(opts.dryRun),
    json: Boolean(opts.json),
    verbose: Boolean(opts.verbose),
    agentsGuidance: guidanceEnabled,
  });

  if (opts.dryRun || opts.json) {
    return lifecyclePlanBlockers(initPlanResult ?? { blockers: ['init plan unavailable'], adapterGroups: [] }).length > 0 ? 1 : 0;
  }

  const errors = [...initErrors];

  if (setup && errors.length === 0 && adapter && adapter !== 'all') {
    const alConfig = loadAlConfigOrNull(target, '', io);
    if (alConfig) {
      const roles = Object.keys(alConfig.roles ?? {});
      const prompts = io.createPrompts();
      try {
        const mutations = await promptModelSettings(roles, adapter, prompts);
        const cfgResult = configureModels(target, { adapter, mutations });
        for (const w of cfgResult.warnings) io.warn(`  WARN: ${w}`);
        for (const e of cfgResult.errors) io.err(`  ERROR: ${e}`);
        for (const u of cfgResult.updated) io.out(`  updated: ${u}`);
        if (cfgResult.errors.length === 0 && cfgResult.updated.length > 0) {
          errors.push(...await cmdGenerate([adapter, '--target', target], io) === 0 ? [] : ['adapter generation failed']);
        } else if (cfgResult.updated.length === 0) {
          io.out('  No model settings provided; skipping adapter generation.');
        }
        errors.push(...cfgResult.errors);
      } finally {
        prompts.close();
      }
    } else {
      errors.push('agenticloop.json not found after init');
    }
  }

  return errors.length > 0 ? 1 : 0;
}


async function cmdUpdate(args, io) {
  const { opts } = parseCommandArgs('update', COMMAND_REGISTRY.update, args);
  const target = resolveCliTarget(io, opts.target);
  const configResult = loadOptionalAlConfig(target);
  if (configResult.error) {
    io.err(`  ERROR: ${configResult.error}`);
    return 1;
  }
  const guidanceConfig = configResult.config;
  // Determine whether this installation already owns a guidance block BEFORE any
  // asset refresh, so a file created during this command cannot be mistaken for
  // prior ownership. Existing installations are never silently enrolled.
  const guidanceOwnedBeforeUpdate = checkGuidance(target, { alConfig: guidanceConfig }).owned === true;
  const { adapters: requestedAdapters, errors: adapterErrors } = normalizeAdapterTargets(opts.adapter);

  for (const e of adapterErrors) io.err(e);
  if (adapterErrors.length > 0) {
    return EXIT_USAGE;
  }

  // Detect adapters before refreshing toolkit assets (Defect 13).
  const adapters = requestedAdapters.length > 0
    ? requestedAdapters
    : detectGeneratedAdapterTargets(target);

  if (adapters.length === 0) {
    // Still run init to refresh assets, but no adapter output needed. Guidance
    // stays with the warning-only refreshOwnedGuidance path below, so the init
    // plan excludes it (no double apply, no fatal refresh on blocked refresh).
    const { errors: initErrors } = await init({ target, refreshAssets: true, io, agentsGuidance: false });
    if (initErrors.length > 0) { return 1; }
    refreshOwnedGuidance(target, guidanceOwnedBeforeUpdate, guidanceConfig, io);
    io.out('  No existing generated adapter artifacts found.');
    io.out("  Use 'agenticloop update --adapter <host>' to generate a specific adapter.");
    return 0;
  }

  if (adapters.includes('all')) {
    io.out('  --adapter all selected: generating every implemented adapter artifact.');
  }

  // Preserve settings recoverable from existing generated artifacts before
  // any refresh or regeneration touches them.
  const preservation = preserveExistingAdapterModelSettings(target, adapters);
  for (const w of preservation.warnings) io.warn(`  WARN: ${w}`);
  if (preservation.errors.length > 0) {
    for (const e of preservation.errors) io.err(`  ERROR: ${e}`);
    return 1;
  }
  for (const u of preservation.updated) io.out(`  preserved: ${u}`);

  // Refresh canonical toolkit assets, then reload the effective configuration
  // so preflight and generation never use a pre-refresh config object.
  // Guidance is excluded from the init plan: update refreshes an owned block
  // through refreshOwnedGuidance with warning-only semantics.
  const { errors: initErrors } = await init({
    target,
    refreshAssets: true,
    io,
    agentsGuidance: false,
  });

  if (initErrors.length > 0) {
    return 1;
  }

  let alConfig = loadAlConfigOrNull(target, '', io);
  if (!alConfig) return 1;

  // Reconcile the selected adapter configuration against the refreshed
  // canonical roles (for example, adding a missing auditor role slot) without
  // disturbing existing target-owned settings.
  const reconcileHosts = adapters.includes('all')
    ? ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']
    : adapters;
  const reconciliation = reconcileTargetAdapterConfig(target, reconcileHosts);
  if (reconciliation.error) {
    io.err(`  ERROR: ${reconciliation.error}`);
    return 1;
  }
  for (const p of reconciliation.added) io.out(`  reconciled: ${p}`);

  if (reconciliation.wrote) {
    alConfig = loadAlConfigOrNull(target, '', io);
    if (!alConfig) return 1;
  }

  // Run adapter preflight against the refreshed, reconciled configuration.
  const preflightErrors = validateAdapterListGenerationPreflight(adapters, alConfig);
  if (preflightErrors.length > 0) {
    for (const error of preflightErrors) io.err(error);
    return 1;
  }

  const generateCode = await generateAdapterTarget(adapters.includes('all') ? 'all' : adapters, {
    opts: { forceGenerated: Boolean(opts.forceGenerated) },
    target,
    alConfig,
    preserveExistingModels: true,
  }, io);

  if (generateCode !== 0) return generateCode;

  refreshOwnedGuidance(target, guidanceOwnedBeforeUpdate, alConfig, io);
  return 0;
}

// Existing-installation update refreshes only an already-owned, unchanged
// guidance block. It never enrolls a target that has no owned block and never
// adopts an unowned manual marker block.
function refreshOwnedGuidance(target, ownedBeforeUpdate, alConfig = null, io) {
  if (!ownedBeforeUpdate) return;
  const guidance = applyGuidance(target, { alConfig, refreshOnly: true });
  if (guidance.changed) {
    io.out(`  guidance: ${guidance.action} in ${guidance.relPath}`);
  }
  for (const warning of guidance.warnings) io.warn(`  WARN: ${warning}`);
  if (!guidance.ok && guidance.warnings.length === 0) {
    io.warn(`  WARN: ${guidance.message}`);
  }
}

async function cmdRemove(args, io) {
  const { opts } = parseCommandArgs('remove', COMMAND_REGISTRY.remove, args);
  const target = resolveCliTarget(io, opts.target);
  const dryRun = Boolean(opts.dryRun);
  const yes = Boolean(opts.yes);
  const includeState = Boolean(opts.includeState);

  if (!dryRun && !yes) {
    io.err("Refusing to remove without confirmation. Run 'agenticloop remove --dry-run' first, then 'agenticloop remove --yes'.");
    return EXIT_USAGE;
  }

  const { removed, released = [], skipped, errors, cleanupErrors = [] } = removeAgenticLoop({ target, dryRun, includeState });

  io.out();
  io.out('agenticloop remove');
  io.out('='.repeat(50));
  if (dryRun) io.out('  (dry run - no changes will be made)');

  if (removed.length === 0 && released.length === 0 && skipped.length === 0 && errors.length === 0) {
    io.out('  No Agentic Loop assets found.');
  }

  const prefix = dryRun ? 'would remove' : 'removed';
  for (const f of removed) io.out(`  ${prefix}: ${f}`);
  for (const f of released) io.out(`  ${dryRun ? 'would release' : 'released'}: ${f}`);
  for (const f of skipped) io.out(`  skipped: ${f}`);
  for (const e of errors) io.err(`  ERROR: ${e}`);
  for (const e of cleanupErrors) io.err(`  CLEANUP ERROR: ${e}`);
  io.out();

  return errors.length > 0 || cleanupErrors.length > 0 ? 1 : 0;
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

async function cmdGuidance(args, io) {
  const sub = args[0];
  if (!sub || !COMMAND_REGISTRY.guidance.subcommands[sub]) {
    const suggestion = sub ? suggestName(sub, Object.keys(COMMAND_REGISTRY.guidance.subcommands)) : null;
    io.err(suggestion
      ? `guidance: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'guidance requires a subcommand: apply | check | remove');
    return EXIT_USAGE;
  }
  const { opts } = parseCommandArgs(`guidance ${sub}`, COMMAND_REGISTRY.guidance.subcommands[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  const configResult = loadOptionalAlConfig(target);
  if (configResult.error) {
    io.err(`  ERROR: ${configResult.error}`);
    return 1;
  }
  const alConfig = configResult.config;
  const force = Boolean(opts.force);

  io.out();
  io.out(`agenticloop guidance ${sub}`);
  io.out('='.repeat(50));

  if (sub === 'check') {
    const result = checkGuidance(target, { alConfig });
    io.out(`  rules document: ${result.relPath ?? '(unresolved)'}`);
    io.out(`  status: ${guidanceStatusLabel(result.status)}`);
    io.out(`  ${result.message}`);
    io.out();
    return ['unsafe-path', 'malformed', 'malformed-manifest', 'path-mismatch', 'multiple-owned'].includes(result.status) ? 1 : 0;
  }

  const result = sub === 'apply'
    ? applyGuidance(target, { alConfig, force })
    : removeGuidance(target, { alConfig, force });

  io.out(`  rules document: ${result.relPath ?? '(unresolved)'}`);
  io.out(`  ${result.action}: ${result.message}`);
  for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);
  io.out();
  return result.ok ? 0 : 1;
}

async function cmdValidate(args, io) {
  const { opts } = parseCommandArgs('validate', COMMAND_REGISTRY.validate, args);
  const target = resolveCliTarget(io, opts.target);
  const forcedAdapters = Array.isArray(opts.adapter) ? opts.adapter : (opts.adapter ? [opts.adapter] : []);
  const result = runValidation(target, { adapters: forcedAdapters, output: io.stdout });

  return result.totalErrors > 0 ? 1 : 0;
}

async function cmdGithubPreflight(args, io) {
  const { opts } = parseCommandArgs('github-preflight', COMMAND_REGISTRY['github-preflight'], args);
  const asJson = Boolean(opts.json);

  if (!opts.pr) {
    if (asJson) {
      io.out(JSON.stringify({ ok: false, errors: ['--pr <number> is required'] }));
    } else {
      io.err('github-preflight requires --pr <number>');
    }
    return EXIT_USAGE;
  }

  let result;
  try {
    result = runPreflight({ pr: opts.pr, issue: opts.issue, repo: opts.repo });
  } catch (error) {
    if (error instanceof PreflightError) {
      if (asJson) {
        io.out(JSON.stringify({ ok: false, errors: [error.message] }));
      } else {
        io.err(`github-preflight failed: ${error.message}`);
      }
      return 1;
    }
    throw error;
  }

  if (asJson) {
    io.out(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  io.out();
  io.out('agenticloop github-preflight');
  io.out('='.repeat(50));
  io.out(`  PR: #${result.pr}`);
  io.out(`  issue: ${result.issue !== null ? `#${result.issue}` : 'none'}`);
  io.out(`  current head: ${result.headRefOid || 'unknown'}`);
  io.out(`  required checks: ${result.requiredChecks.length}`);
  io.out(`  matched evidence: ${result.evidenceMatches.length}`);

  if (result.statusSubstitutions.length > 0) {
    io.out('  status-check substitutions:');
    for (const sub of result.statusSubstitutions) {
      io.out(`    - '${sub.check}' satisfied by status check '${sub.statusCheck}'`);
    }
  } else {
    io.out('  status-check substitutions: none');
  }

  for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);

  if (result.ok) {
    io.out('  preflight passed');
    io.out();
    return 0;
  }

  io.out('  preflight FAILED:');
  for (const error of result.errors) io.err(`    ERROR: ${error}`);
  io.out();
  return 1;
}

async function cmdGithubReviewAudit(args, io) {
  const { opts } = parseCommandArgs('github-review-audit', COMMAND_REGISTRY['github-review-audit'], args);
  const asJson = Boolean(opts.json);
  if (!opts.pr) {
    const error = '--pr <number> is required';
    if (asJson) io.out(JSON.stringify({ ok: false, errors: [error] }));
    else io.err(`github-review-audit requires ${error}`);
    return EXIT_USAGE;
  }
  const expectedStatus = opts.expectStatus ?? 'accepted';
  const expectedArtifact = opts.expectArtifact ?? undefined;
  let result;
  try {
    result = runGitHubReviewAudit({ pr: opts.pr, issue: opts.issue, repo: opts.repo, expectedStatus, expectedArtifact, workspace: opts.workspace });
  } catch (error) {
    if (!(error instanceof GitHubReviewAuditError)) throw error;
    if (asJson) io.out(JSON.stringify({ ok: false, errors: [error.message] }));
    else io.err(`github-review-audit failed: ${error.message}`);
    return 1;
  }
  if (asJson) {
    io.out(JSON.stringify(result));
  } else {
    io.out();
    io.out('agenticloop github-review-audit');
    io.out('='.repeat(50));
    io.out(`  PR: #${result.pr}`);
    io.out(`  issue: ${result.issue === null ? 'none' : `#${result.issue}`}`);
    io.out(`  current head: ${result.headRefOid || 'unknown'}`);
    io.out(`  independent review required: ${result.independentReviewRequired}`);
    io.out(`  expected status: ${result.expectedStatus}`);
    if (result.expectedArtifact) io.out(`  expected artifact: ${result.expectedArtifact}`);
    if (result.reviewWorkspace?.provided) io.out(`  review workspace: ${result.reviewWorkspace.workspace} (${result.reviewWorkspace.head})`);
    if (result.outcome) io.out(`  outcome: ${result.outcome.status} via ${result.outcome.mode}`);
    if (result.ok) {
      io.out(`  provenance valid: yes`);
      io.out(`  acceptance ready: ${result.acceptanceReady ? 'yes' : 'no'}`);
      if (result.expectedStatus === 'needs_revision') {
        io.out('  review audit passed (needs_revision confirmed)');
      } else {
        io.out('  review provenance passed');
      }
    } else {
      io.out(`  provenance valid: ${result.provenanceValid ? 'yes' : 'no'}`);
      io.out(`  acceptance ready: ${result.acceptanceReady ? 'yes' : 'no'}`);
      for (const error of result.errors) io.err(`    ERROR: ${error}`);
    }
    io.out();
  }
  return result.ok ? 0 : 1;
}

async function cmdGithubReady(args, io) {
  const { opts } = parseCommandArgs('github-ready', COMMAND_REGISTRY['github-ready'], args);
  const asJson = Boolean(opts.json);
  if (!opts.pr) {
    if (asJson) io.out(JSON.stringify({ ok: false, readyForMerge: false, errors: ['--pr <number> is required'] }));
    else io.err('github-ready requires --pr <number>');
    return EXIT_USAGE;
  }

  let result;
  try {
    result = runGitHubReady({ pr: opts.pr, issue: opts.issue, repo: opts.repo });
  } catch (error) {
    if (!(error instanceof GitHubReadyError)) throw error;
    if (asJson) io.out(JSON.stringify({ ok: false, readyForMerge: false, errors: [error.message] }));
    else io.err(`github-ready failed: ${error.message}`);
    return 1;
  }

  if (asJson) {
    io.out(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  const { summary, errors } = formatGitHubReadyReport(result);
  io.out();
  for (const line of summary) io.out(line);
  for (const error of errors) io.err(`    ERROR: ${error}`);
  io.out();
  return result.ok ? 0 : 1;
}

async function cmdEvent(args, commandLabel = 'event-logging', io = createIo()) {
  const sub = args[0];

  if (!sub) {
    io.err(`${commandLabel} requires an event type, 'validate', 'audit', or 'report'`);
    io.err(`Run "agenticloop help ${commandLabel}" for usage.`);
    return EXIT_USAGE;
  }

  if (sub === '--help' || sub === '-h') {
    io.out(renderCommandHelp('event-logging'));
    io.out();
    io.out('  event_type is a positional — one of:');
    for (const t of VALID_EVENT_TYPES) io.out(`    ${t}`);
    io.out();
    return 0;
  }

  if (sub === 'validate') {
    const { opts } = parseCommandArgs(`${commandLabel} validate`, COMMAND_REGISTRY['event-logging'].subcommands.validate, args.slice(1));
    const target = resolveCliTarget(io, opts.target);
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
    const { opts } = parseCommandArgs(`${commandLabel} audit`, COMMAND_REGISTRY['event-logging'].subcommands.audit, args.slice(1));
    const target = resolveCliTarget(io, opts.target);
    if (!opts.task) {
      io.err('--task is required for event log audit');
      return EXIT_USAGE;
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
    const { opts } = parseCommandArgs(`${commandLabel} report`, COMMAND_REGISTRY['event-logging'].subcommands.report, args.slice(1));
    const target = resolveCliTarget(io, opts.target);
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

  if (!VALID_EVENT_TYPES.has(sub)) {
    const suggestion = suggestName(sub, [...VALID_EVENT_TYPES, 'validate', 'audit', 'report']);
    io.err(suggestion
      ? `${commandLabel}: unknown event type or subcommand '${sub}'. Did you mean '${suggestion}'?`
      : `${commandLabel}: unknown event type or subcommand '${sub}'.`);
    io.err(`Run "agenticloop help ${commandLabel}" for usage.`);
    return EXIT_USAGE;
  }

  const { opts } = parseCommandArgs(
    `${commandLabel} ${sub}`,
    { options: COMMAND_REGISTRY['event-logging'].eventTypeOptions },
    args.slice(1)
  );
  const target = resolveCliTarget(io, opts.target);

  if (opts.refs !== undefined) {
    const refs = String(opts.refs).split(',').map(ref => ref.trim()).filter(Boolean);
    const existing = Array.isArray(opts.ref) ? opts.ref : (opts.ref ? [opts.ref] : []);
    opts.ref = [...existing, ...refs];
  }

  if (!opts.summary) {
    io.err('--summary is required for event writes');
    return EXIT_USAGE;
  }

  let data = {};
  if (opts.dataJson !== undefined) {
    try {
      data = JSON.parse(opts.dataJson);
    } catch (error) {
      io.err(`--data-json must be valid JSON: ${error.message}`);
      return EXIT_USAGE;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      io.err('--data-json must decode to a JSON object');
      return EXIT_USAGE;
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

async function cmdConfigureModels(args, io) {
  const { opts } = parseCommandArgs('configure models', COMMAND_REGISTRY.configure.subcommands.models, args);
  const target = resolveCliTarget(io, opts.target);
  let adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const profile = Array.isArray(opts.profile) ? opts.profile[0] : opts.profile;

  if (!adapter) {
    const detected = detectHost(target);
    if (detected.length === 1) {
      adapter = detected[0];
      io.out(`Detected host: ${adapter}`);
    } else if (detected.length > 1) {
        io.err(`Multiple hosts detected (${detected.join(', ')}). Use --adapter <host> with one of: opencode, codex, claude-code, copilot, cursor.`);
        return EXIT_USAGE;
      } else {
        io.err('No host detected. Use --adapter <host> with one of: opencode, codex, claude-code, copilot, cursor.');
        return EXIT_USAGE;
      }
  }

  const hostError = validateHost(adapter);
  if (hostError) {
    io.err(hostError);
    return EXIT_USAGE;
  }

  const mutationFlags = new Set(['--role', '--model', '--reasoning-effort']);
  if (profile !== undefined) {
    if (args.some(arg => mutationFlags.has(arg))) {
      io.err('--profile recommended cannot be combined with --role, --model, or --reasoning-effort.');
      return EXIT_USAGE;
    }

    const { errors, warnings, updated, preserved } = configureModels(target, { adapter, profile });
    for (const w of warnings) io.warn(`  WARN: ${w}`);
    for (const e of errors) io.err(`  ERROR: ${e}`);
    for (const u of updated) io.out(`  added: ${u}`);
    for (const p of preserved) io.out(`  kept: ${p}`);

    if (errors.length === 0 && updated.length > 0) {
      io.out();
      io.out(`Run 'agenticloop generate ${adapter}' to refresh adapter artifacts.`);
    }
    return errors.length > 0 ? 1 : 0;
  }

  let mutations = parseModelMutations(args);

  if (mutations.length === 0) {
    const alConfig = loadAlConfigOrNull(
      target,
      `agenticloop.json not found. Run agenticloop init --adapter <host> first to enable adapter model configuration.`,
      io
    );
    if (!alConfig) {
      return 1;
    }
    const roles = Object.keys(alConfig.roles ?? {});
    const currentSettings = alConfig.adapters?.[adapter]?.roleSettings ?? {};
    const prompts = io.createPrompts();
    try {
      const { mutations: picked, cancelled } = await promptModelSettingsInteractive(
        roles, adapter, prompts, currentSettings, { discoverModels: true }
      );
      if (cancelled) {
        io.out('Model configuration cancelled.');
        return 0;
      }
      mutations = picked;
    } finally {
      prompts.close();
    }
  }

  if (mutations.length === 0) {
    io.out('No model settings provided; nothing to write.');
    return 0;
  }

  const { errors, warnings, updated } = configureModels(target, { adapter, mutations });

  for (const w of warnings) io.warn(`  WARN: ${w}`);
  for (const e of errors) io.err(`  ERROR: ${e}`);
  for (const u of updated) io.out(`  updated: ${u}`);

  if (errors.length === 0 && updated.length > 0) {
    io.out();
    io.out(`Run 'agenticloop generate ${adapter}' to refresh adapter artifacts.`);
  }

  return errors.length > 0 ? 1 : 0;
}

async function cmdSetup(args, io) {
  const { opts } = parseCommandArgs('setup', COMMAND_REGISTRY.setup, args);
  const target = resolveCliTarget(io, opts.target);
  const adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const nonInteractive = Boolean(opts.yes) || Boolean(opts.nonInteractive);
  const eventLogging = opts.eventLogging;
  const agentsGuidance = !opts.noAgentsGuidance && opts.agentsGuidance !== 'off' && opts.agentsGuidance !== false;

  if (adapter) {
    const validAdapters = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all']);
    if (!validAdapters.has(adapter)) {
      const suggestion = suggestName(adapter, [...validAdapters]);
      io.err(suggestion
        ? `Unknown adapter '${adapter}'. Did you mean '${suggestion}'?`
        : `Unknown adapter '${adapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`);
      return EXIT_USAGE;
    }
  }

  if (nonInteractive && !adapter) {
    io.err('Non-interactive setup requires --adapter <host>.');
    return EXIT_USAGE;
  }

  const { errors } = await setup({
    target,
    adapter,
    nonInteractive,
    eventLogging,
    agentsGuidance,
    io,
    dryRun: Boolean(opts.dryRun),
    json: Boolean(opts.json),
    verbose: Boolean(opts.verbose),
  });

  return errors.length > 0 ? 1 : 0;
}

async function cmdDoctor(args, io) {
  const { opts } = parseCommandArgs('doctor', COMMAND_REGISTRY.doctor, args);
  const target = resolveCliTarget(io, opts.target);
  printDoctor(target, io);
  return 0;
}

async function cmdStatus(args, io) {
  const { opts } = parseCommandArgs('status', COMMAND_REGISTRY.status, args);
  const target = resolveCliTarget(io, opts.target);
  printAdapterDiscovery(target, io);
  io.out('Task state: run "agenticloop task list" to inspect files-backed task records.');
  return 0;
}

async function cmdWorktree(args, io) {
  const sub = args[0];
  const WORKTREE_SUBCOMMANDS = COMMAND_REGISTRY.worktree.subcommands;
  if (!sub || !WORKTREE_SUBCOMMANDS[sub]) {
    const suggestion = sub ? suggestName(sub, Object.keys(WORKTREE_SUBCOMMANDS)) : null;
    io.err(suggestion
      ? `worktree: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'worktree requires a subcommand: add | guard | list | remove | cleanup | resolve-state | prune');
    return EXIT_USAGE;
  }

  try {
    if (sub === 'add') {
      const { opts, positional } = parseCommandArgs('worktree add', WORKTREE_SUBCOMMANDS.add, args.slice(1));
      const [taskId, branch] = positional;
      if (!taskId || !branch || positional.length !== 2) {
        io.err('Usage: agenticloop worktree add <task-id> <branch> [--from <ref>] [--target <dir>]');
        return EXIT_USAGE;
      }
      const target = resolveCliTarget(io, opts.target);
      const result = createAgenticLoopWorktree({
        target,
        taskId,
        branch,
        from: opts.from,
      });
      io.out('Created Agentic Loop worktree:');
      io.out(`  path: ${result.path}`);
      io.out(`  branch: ${result.branch}`);
      io.out(`  from: ${result.from ?? '(existing branch)'}`);
      io.out(`  git guard: ${result.guard?.ok ? 'configured' : result.guard === null ? 'session environment required' : 'missing'}`);
      if (result.ignored) {
        io.out('  ignored: .agenticloop/worktrees/');
      }
      return 0;
    }

    if (sub === 'guard') {
      const { opts, positional } = parseCommandArgs('worktree guard', WORKTREE_SUBCOMMANDS.guard, args.slice(1));
      if (positional.length > 1) {
        io.err('Usage: agenticloop worktree guard [--fix] [--all|<path>] [--target <dir>]');
        return EXIT_USAGE;
      }
      const target = resolveCliTarget(io, opts.target);
      const result = guardAgenticLoopWorktrees({
        target,
        path: positional[0],
        all: Boolean(opts.all),
        fix: Boolean(opts.fix),
      });
      io.out(formatWorktreeGuardResult(result));
      return result.ok ? 0 : 1;
    }

    if (sub === 'list') {
      const { opts } = parseCommandArgs('worktree list', WORKTREE_SUBCOMMANDS.list, args.slice(1));
      const target = resolveCliTarget(io, opts.target);
      const asJson = Boolean(opts.json);
      const records = listAgenticLoopWorktrees(target);
      if (asJson) {
        io.out(JSON.stringify(records, null, 2));
      } else {
        io.out(formatWorktreeList(records));
      }
      return 0;
    }

    if (sub === 'remove') {
      const { opts, positional } = parseCommandArgs('worktree remove', WORKTREE_SUBCOMMANDS.remove, args.slice(1));
      const identifier = positional[0];
      if (!identifier) {
        io.err('Usage: agenticloop worktree remove <task-id|path> [--target <dir>] [--dry-run|--yes] [--force] [--json]');
        return EXIT_USAGE;
      }
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (!dryRun && !yes) {
        io.err("worktree remove requires either --dry-run or --yes");
        return EXIT_USAGE;
      }
      const target = resolveCliTarget(io, opts.target);
      const result = removeAgenticLoopWorktree({
        target,
        identifier,
        dryRun,
        yes,
        force: Boolean(opts.force),
      });
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatWorktreeRemoveResult(result, { dryRun }));
      }
      return result.errors.length > 0 ? 1 : 0;
    }

    if (sub === 'cleanup') {
      const { opts } = parseCommandArgs('worktree cleanup', WORKTREE_SUBCOMMANDS.cleanup, args.slice(1));
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (!dryRun && !yes) {
        io.err("worktree cleanup requires either --dry-run or --yes");
        return EXIT_USAGE;
      }
      const target = resolveCliTarget(io, opts.target);
      const result = cleanupAgenticLoopWorktrees({
        target,
        dryRun,
        yes,
      });
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatWorktreeCleanupResult(result));
      }
      return result.errors.length > 0 ? 1 : 0;
    }

    if (sub === 'resolve-state') {
      const { opts, positional } = parseCommandArgs('worktree resolve-state', WORKTREE_SUBCOMMANDS['resolve-state'], args.slice(1));
      const identifier = positional[0];
      if (!identifier) {
        io.err('Usage: agenticloop worktree resolve-state <task-id|path> [--target <dir>] [--strategy <strategy>] [--dry-run|--yes] [--json]');
        return EXIT_USAGE;
      }
      const dryRun = !Boolean(opts.yes);
      const yes = Boolean(opts.yes);
      if (opts.dryRun && yes) {
        io.err('worktree resolve-state accepts either --dry-run or --yes, not both');
        return EXIT_USAGE;
      }
      const target = resolveCliTarget(io, opts.target);
      const result = resolveAgenticLoopStateConflicts({
        target,
        identifier,
        strategy: opts.strategy,
        dryRun,
        yes,
      });
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatResolveStateResult(result));
      }
      return result.errors.length > 0 ? 1 : 0;
    }

    if (sub === 'prune') {
      const { opts } = parseCommandArgs('worktree prune', WORKTREE_SUBCOMMANDS.prune, args.slice(1));
      const dryRun = Boolean(opts.dryRun);
      const yes = Boolean(opts.yes);
      if (!dryRun && !yes) {
        io.err("worktree prune requires either --dry-run or --yes");
        return EXIT_USAGE;
      }
      const target = resolveCliTarget(io, opts.target);
      const result = pruneAgenticLoopWorktrees({
        target,
        dryRun,
        yes,
      });
      if (opts.json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        io.out(formatWorktreePruneResult(result));
      }
      return result.errors.length > 0 ? 1 : 0;
    }

    io.err(`Unknown worktree subcommand: ${sub}`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    io.err(error.message);
    return 1;
  }
}

async function cmdBootstrapLabels(args, io) {
  const { opts } = parseCommandArgs('bootstrap-labels', COMMAND_REGISTRY['bootstrap-labels'], args);
  const target = resolveCliTarget(io, opts.target);
  const projectMap = loadProjectMap(target)?.config ?? null;

  let alConfig = null;
  const alCfgPath = join(target, 'agenticloop.json');
  if (existsSync(alCfgPath)) {
    try {
      alConfig = loadAgenticLoopConfig(alCfgPath);
    } catch (e) {
      io.err(`Failed to load agenticloop.json: ${e.message}`);
      return 1;
    }
  }

  // bootstrap-labels is a GitHub-backend-only setup step. Guard against running
  // it accidentally against a files-backed project, where it would create
  // GitHub labels the workflow never uses.
  const backendResolution = resolveTaskBackend(target);
  for (const warning of backendResolution.warnings) io.warn(`  WARN: ${warning}`);
  if (backendResolution.backend !== 'github' && !opts.force) {
    io.err(
      `Active task backend is '${backendResolution.backend}', not 'github'. ` +
      `bootstrap-labels creates GitHub labels and is only used by the github backend.\n` +
      `Set task_backend: github in .agenticloop/project.md, or pass --force to run anyway.`
    );
    return 1;
  }

  io.out();
  io.out('agenticloop bootstrap-labels');
  io.out('='.repeat(50));
  if (opts.dryRun) io.out('  (dry run - no changes will be made)');

  const results = bootstrapLabels(alConfig, {
    repo: opts.repo,
    dryRun: Boolean(opts.dryRun),
    group: opts.group,
    taskId: opts.taskId,
    projectMap,
    io,
  });
  const failed = results.some(result => result.action === 'error');
  io.out();
  return failed ? 1 : 0;
}

function loadAlConfigOrNull(target, hint = '', io) {
  const alCfgPath = join(target, 'agenticloop.json');
  if (!existsSync(alCfgPath)) {
    const msg = hint
      ? hint
      : `agenticloop.json not found. Run agenticloop init --adapter <host> first to create advanced adapter config.`;
    io.err(msg);
    return null;
  }
  try {
    return loadAgenticLoopConfig(alCfgPath);
  } catch (e) {
    io.err(`Failed to parse agenticloop.json: ${e.message}`);
    return null;
  }
}

function resolveOutputDir(opts, target) {
  if (opts.outputDir) {
    return isAbsolute(opts.outputDir) ? opts.outputDir : join(target, opts.outputDir);
  }
  return target;
}

async function cmdGenerate(subArgs, io) {
  const sub = subArgs[0];
  const generateSpec = sub ? COMMAND_REGISTRY.generate.subcommands[sub] : null;
  if (!generateSpec) {
    const suggestion = sub ? suggestName(sub, Object.keys(COMMAND_REGISTRY.generate.subcommands)) : null;
    io.err(suggestion
      ? `generate: unknown host '${sub}'. Did you mean '${suggestion}'?`
      : 'generate requires a host target: opencode | codex | claude-code | copilot | cursor | all');
    return EXIT_USAGE;
  }
  const { opts } = parseCommandArgs(`generate ${sub}`, generateSpec, subArgs.slice(1));
  const target = resolveCliTarget(io, opts.target);

  const alConfig = loadAlConfigOrNull(target, '', io);
  if (!alConfig) return 1;
  return await generateAdapterTarget(sub, { opts, target, alConfig, preserveExistingModels: true }, io);
}

// --- entry ------------------------------------------------------------------

const COMMAND_HANDLERS = {
  init: cmdInit,
  setup: cmdSetup,
  update: cmdUpdate,
  remove: cmdRemove,
  guidance: cmdGuidance,
  validate: cmdValidate,
  'github-preflight': cmdGithubPreflight,
  'github-review-audit': cmdGithubReviewAudit,
  'github-ready': cmdGithubReady,
  doctor: cmdDoctor,
  status: cmdStatus,
  worktree: cmdWorktree,
  'bootstrap-labels': cmdBootstrapLabels,
  generate: cmdGenerate,
};

function printHelpFor(path, io) {
  const text = renderCommandHelp(path);
  if (text === null) {
    io.out(renderFullHelp());
    return;
  }
  io.out(text);
  if (path === 'event-logging') {
    io.out();
    io.out('  event_type is a positional — one of:');
    for (const t of VALID_EVENT_TYPES) io.out(`    ${t}`);
  }
}

/**
 * Route a parsed argv to the matching command handler and return a numeric
 * exit code. Every command runs in-process through the injected-io contract:
 * handlers receive `io` and return numeric exit codes; no handler touches
 * global `process.exitCode`, raw console, or a subprocess bridge.
 *
 * Exit statuses: 0 success/help/version/cancelled, 1 operational failure,
 * 2 invalid CLI usage (CliUsageError), 130 interruption (CliAbortError).
 *
 * @param {string[]} argv  Arguments after the node/bin prefix.
 * @param {ReturnType<import('./cli-io.js').createIo>} [io]
 * @returns {Promise<number>} exit code
 */
export async function dispatch(argv, io = createIo()) {
  const command = argv[0];

  if (command === undefined) {
    io.out(renderFirstUse());
    return 0;
  }

  if (command === '--version' || command === 'version') {
    io.out(`agenticloop ${packageVersion()}`);
    return 0;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    const target = command === 'help' ? argv[1] : argv[1];
    if (!target) {
      io.out(renderFullHelp());
      return 0;
    }
    const canonical = resolveCommandName(target);
    if (!canonical) {
      const suggestion = suggestName(target, allCommandNames());
      throw new CliUsageError(
        suggestion
          ? `Unknown command: ${target}. Did you mean '${suggestion}'?`
          : `Unknown command: ${target}.`,
        { hint: 'Run "agenticloop help" for all commands.' }
      );
    }
    const sub = argv[2];
    const path = sub && COMMAND_REGISTRY[canonical].subcommands?.[sub]
      ? `${canonical} ${sub}`
      : canonical;
    printHelpFor(path, io);
    return 0;
  }

  const canonical = resolveCommandName(command);
  if (!canonical) {
    const suggestion = suggestName(command, allCommandNames());
    throw new CliUsageError(
      suggestion
        ? `Unknown command: ${command}. Did you mean '${suggestion}'?`
        : `Unknown command: ${command}.`,
      { hint: 'Run "agenticloop help" for all commands.' }
    );
  }

  const rest = argv.slice(1);
  const spec = COMMAND_REGISTRY[canonical];

  // Command-local and subcommand-local help is safe: it never reaches a
  // handler and therefore can never mutate a target.
  if (findHelpRequest(rest)) {
    const sub = spec.subcommands && rest[0] && spec.subcommands[rest[0]] ? rest[0] : null;
    printHelpFor(sub ? `${canonical} ${sub}` : canonical, io);
    return 0;
  }

  switch (canonical) {
    case 'task':
      return await cmdTask(rest, io);
    case 'audit':
      return await cmdAudit(rest, io);
    case 'event-logging':
      return await cmdEvent(rest, command === 'event' ? 'event' : 'event-logging', io);
    case 'configure':
      if (rest[0] === 'models') {
        return await cmdConfigureModels(rest.slice(1), io);
      }
      throw new CliUsageError(
        rest[0]
          ? `Unknown configure subcommand: ${rest[0]}`
          : 'configure requires a subcommand: models',
        { hint: 'Run "agenticloop help configure" for usage.' }
      );
    default:
      return await COMMAND_HANDLERS[canonical](rest, io);
  }
}

function allCommandNames() {
  const names = [...Object.keys(COMMAND_REGISTRY)];
  for (const spec of Object.values(COMMAND_REGISTRY)) {
    names.push(...(spec.aliases ?? []));
  }
  return names;
}
