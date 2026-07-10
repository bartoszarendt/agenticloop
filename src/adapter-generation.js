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
 * @property {object} alConfig
 * @property {string|string[]} [adapter]
 * @property {string} [outputDirOpt]
 * @property {boolean} [forceGenerated]
 * @property {boolean} [runPluginChecks]
 * @property {Array<{relPath: string, content: string}>} [extraWrites]
 */

/**
 * @typedef {Object} GenerationOutcome
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {string[]} files
 * @property {string[]} adapters
 * @property {string} outputDir
 */

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
  const { target, alConfig, adapter, outputDirOpt, forceGenerated = false, runPluginChecks = true, extraWrites } = options;

  const outputDir = resolveOutputDir(target, outputDirOpt);
  const outputRoot = computeOutputRoot(target, outputDir);

  const adapterList = Array.isArray(adapter) ? adapter : [adapter];
  const expanded = adapterList.includes('all') ? [...IMPLEMENTED_ADAPTERS] : /** @type {string[]} */ (adapterList.filter(Boolean));

  // Plugin/config compatibility checks.
  const preflightErrors = [];
  if (runPluginChecks && expanded.some(a => a === 'codex' || a === 'cursor' || expanded.includes('all'))) {
    preflightErrors.push(...validateSharedAgenticLoopPluginCompatibility(alConfig));
  }
  if (preflightErrors.length > 0) {
    return { ok: false, errors: preflightErrors, files: [], adapters: expanded, outputDir };
  }

  // Compute the complete plan across all requested adapters.
  const allActions = [];
  const allFiles = [];
  const adaptersWithPlans = [];

  for (const adapterName of expanded) {
    const planner = PLANNERS[adapterName];
    if (!planner) {
      return { ok: false, errors: [`Unknown adapter: ${adapterName}`], files: [], adapters: expanded, outputDir };
    }
    try {
      const plan = planner(alConfig, target, outputDir);
      allActions.push(...plan.actions);
      allFiles.push(...plan.files);
      adaptersWithPlans.push(adapterName);
    } catch (error) {
      return {
        ok: false,
        errors: [`Failed to plan ${adapterName} artifacts: ${error instanceof Error ? error.message : String(error)}`],
        files: [],
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

  // Execute transactionally.
  const result = executeGenerationPlan(target, plan, { forceGenerated, extraWrites });

  return {
    ok: result.ok,
    errors: result.errors,
    files: result.ok ? allFiles : [],
    adapters: adaptersWithPlans,
    outputDir,
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
