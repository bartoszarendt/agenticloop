/**
 * Shared adapter generation orchestrator.
 *
 * Routes every generation entry point (init, setup, generate, generate all,
 * update) through the transactional plan/preflight/execute service.
 */

import { validateSharedAgenticLoopPluginCompatibility } from './adapter-plugin-compatibility.js';
import { executeGenerationPlan, resolveOutputDir, computeOutputRoot, preflightPlan, formatCollisions } from './generation-transaction.js';
import { planOpencodeArtifacts } from './adapters/opencode.js';
import { planCodexArtifacts } from './adapters/codex.js';
import { planClaudeCodeArtifacts } from './adapters/claude-code.js';
import { planCopilotArtifacts } from './adapters/copilot.js';
import { planCursorArtifacts } from './adapters/cursor.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

const PLANNERS = {
  opencode: planOpencodeArtifacts,
  codex: planCodexArtifacts,
  'claude-code': planClaudeCodeArtifacts,
  copilot: planCopilotArtifacts,
  cursor: planCursorArtifacts,
};

/**
 * @typedef {Object} GenerationOptions
 * @property {string} target
 * @property {string} [assetSourceRoot] Repository root used to read canonical
 * adapter source assets when the target's planned assets are not yet on disk.
 * @property {object} alConfig
 * @property {string|string[]} [adapter]
 * @property {string} [outputDirOpt]
 * @property {boolean} [forceGenerated]
 * @property {boolean} [runPluginChecks]
 * @property {Array<{relPath: string, content: string}>} [extraWrites]
 * @property {string} [manifestRelPath]
 * @property {boolean} [avoidUnchangedWrites]
 * @property {boolean} [excludeGitignoreActions]
 * @property {(context: { targetRoot: string, plan: object, manifestRelPath: string }) => string[]|{errors?: string[], warnings?: string[]}} [beforeMutation]
 */

/**
 * @typedef {Object} GenerationOutcome
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {string[]} files
 * @property {string[]} adapters
 * @property {string} outputDir
 */

/**
 * Compute the canonical adapter generation plan without writing. Composes the
 * per-adapter planners, plugin compatibility checks, and the generation
 * transaction preflight so lifecycle planning can render and preflight the
 * exact actions that `executeGenerationPlan` would apply.
 *
 * @param {GenerationOptions} options
 * @returns {{ ok: boolean, errors: string[], plan?: object, preflight?: object, adapters: string[], outputDir: string }}
 */
export function planAdapterArtifacts(options) {
  const { target, alConfig, adapter, outputDirOpt, forceGenerated = false, runPluginChecks = true } = options;
  const assetSourceRoot = options.assetSourceRoot ?? target;

  const outputDir = resolveOutputDir(target, outputDirOpt);
  const outputRoot = computeOutputRoot(target, outputDir);

  const adapterList = Array.isArray(adapter) ? adapter : [adapter];
  const expanded = adapterList.includes('all') ? [...IMPLEMENTED_ADAPTERS] : /** @type {string[]} */ (adapterList.filter(Boolean));

  const preflightErrors = [];
  if (runPluginChecks && expanded.some(a => a === 'codex' || a === 'cursor' || expanded.includes('all'))) {
    preflightErrors.push(...validateSharedAgenticLoopPluginCompatibility(alConfig));
  }
  if (preflightErrors.length > 0) {
    return { ok: false, errors: preflightErrors, adapters: expanded, outputDir };
  }

  const allActions = [];
  const allFiles = [];
  const adaptersWithPlans = [];

  for (const adapterName of expanded) {
    const planner = PLANNERS[adapterName];
    if (!planner) {
      return { ok: false, errors: [`Unknown adapter: ${adapterName}`], adapters: expanded, outputDir };
    }
    try {
      const plan = planner(alConfig, assetSourceRoot, outputDir);
      const actions = options.excludeGitignoreActions
        ? plan.actions.filter(action => action.type !== 'gitignore-append')
        : plan.actions;
      allActions.push(...actions);
      allFiles.push(...plan.files.filter(file => actions.some(action => action.relPath === file)));
      adaptersWithPlans.push(adapterName);
    } catch (error) {
      return {
        ok: false,
        errors: [`Failed to plan ${adapterName} artifacts: ${error instanceof Error ? error.message : String(error)}`],
        adapters: expanded,
        outputDir,
      };
    }
  }

  const plan = {
    outputRoot,
    actions: allActions,
    files: allFiles,
    adapters: adaptersWithPlans,
  };

  const preflight = preflightPlan(target, plan, forceGenerated, { manifestRelPath: options.manifestRelPath });
  return { ok: true, errors: [], plan, preflight, adapters: adaptersWithPlans, outputDir };
}

/**
 * Plan and execute adapter generation for one or more adapters transactionally.
 *
 * For 'all', computes the complete plan across all five adapters before
 * performing any writes. If any adapter has a blocked path, performs zero
 * adapter-output writes.
 *
 * @param {GenerationOptions} options
 * @returns {GenerationOutcome}
 */
export function generateAdapterArtifacts(options) {
  const { target, forceGenerated = false, extraWrites } = options;
  const planned = planAdapterArtifacts(options);
  if (!planned.ok) {
    return { ok: false, errors: planned.errors, files: [], adapters: planned.adapters, outputDir: planned.outputDir };
  }

  // Execute transactionally. The transaction boundary validates fully resolved
  // action, stale-cleanup, and extra-write destinations so .github/workflows/
  // remains user-owned even when a custom output directory is requested.
  const result = executeGenerationPlan(target, planned.plan, {
    forceGenerated,
    extraWrites,
    manifestRelPath: options.manifestRelPath,
    avoidUnchangedWrites: options.avoidUnchangedWrites,
    beforeMutation: options.beforeMutation,
  });

  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings ?? [],
    files: result.ok ? planned.plan.files : [],
    adapters: planned.adapters,
    outputDir: planned.outputDir,
  };
}

/**
 * Preflight only (no writes). Useful for dry-run or pre-checks.
 *
 * @param {string} target
 * @param {object} plan
 * @param {boolean} forceGenerated
 * @returns {{ blocked: Array, allClear: boolean, lines: string[] }}
 */
export function preflightGenerationPlan(target, plan, forceGenerated) {
  const result = preflightPlan(target, plan, forceGenerated);
  return {
    blocked: result.blocked,
    allClear: result.allClear,
    lines: formatCollisions(result.collisions),
  };
}

export { IMPLEMENTED_ADAPTERS };
