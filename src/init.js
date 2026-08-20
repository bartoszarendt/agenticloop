/**
 * agenticloop init - scaffold Agentic Loop overlay in a target directory.
 *
 * Plain init creates:
 *   agenticloop/, .agenticloop/project.md, .agenticloop/tasks/,
 *   .agenticloop/decisions/, .agenticloop/logs/, .agenticloop/tmp/
 *
 * Plain init does NOT create:
 *   agenticloop.json,
 *   .opencode/, .codex/, plugins/agenticloop/, .claude/, .github/, .cursor/
 *
 * --adapter <host> additionally creates:
 *   agenticloop.json and host adapter artifacts
 *
 * Never overwrites:
 *   AGENTS.md, IMPLEMENTATION_PLAN.md, ARCHITECTURE*.md, README.md,
 *   .agenticloop/project.md (target-owned; never overwritten by refreshes)
 *
 * init is one composed plan/apply path: `planInit` (src/init-plan.js) computes
 * the idempotent lifecycle plan without writes, and `applyLifecyclePlan`
 * executes it through the generic filesystem mutation kernel. `--dry-run`
 * renders the exact plan with zero writes; the default human output is a
 * concise summary, with per-path detail behind `verbose`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createIo } from './cli-io.js';
import {
  applyLifecyclePlan,
  formatPartialApplyDiagnostics,
  lifecyclePlanCounts,
  lifecycleMutationReceipt,
  lifecyclePlanToJson,
  renderLifecyclePlan,
} from './lifecycle-plan.js';
import { planInit } from './init-plan.js';
import { detectSetupState, nextStepsFromState } from './setup-state.js';
import { executeGuidanceLifecycleAction } from './guidance.js';
import { executeRenameMutation } from './fs-mutation-kernel.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all'];

function emptyResult() {
  return { created: [], skipped: [], warnings: [], errors: [], migrated: [], removed: [] };
}

/**
 * Execute lifecycle `exec` descriptors owned by init: legacy canonical-asset
 * moves. The descriptor was planned from a read-only ownership inspection;
 * the move preserves rename semantics.
 */
export function initExecHandler(action, target) {
  if (action.exec?.type === 'rename') {
    const renamed = executeRenameMutation(target, {
      from: action.exec.from,
      to: action.exec.to,
      fromBaseHash: action.exec.fromBaseHash,
      toBaseHash: action.exec.toBaseHash,
    });
    return { ...renamed, display: action.display };
  }
  if (action.exec?.type === 'guidance') {
    return executeGuidanceLifecycleAction(action, target);
  }
  return {
    ok: false,
    rolledBack: true,
    errors: [`init cannot execute '${action.exec?.type}' for ${action.path}`],
  };
}

/**
 * Run agenticloop init.
 *
 * @param {object} options
 * @param {string} [options.target=process.cwd()] Target directory to scaffold.
 * @param {boolean} [options.refreshAssets=false] Overwrite existing toolkit-owned assets.
 * @param {boolean} [options.opencode=false] Compatibility alias; equivalent to adapter: 'opencode'.
 * @param {string} [options.adapter] Adapter to generate: opencode | codex | claude-code | copilot | cursor | all.
 * @param {object} [options.io] Injected I/O context (defaults to process streams).
 * @param {boolean} [options.dryRun=false] Compute and render the plan without writing.
 * @param {boolean} [options.json=false] Render the plan as one JSON document on stdout.
 * @param {boolean} [options.verbose=false] Print individual planned/applied paths.
 * @param {boolean} [options.agentsGuidance=true] Plan the AGENTS.md activation-guidance action.
 * @param {boolean} [options.repositoryOnly=false] Refresh portable repository assets without adapter or workflow-state generation.
 * @returns {Promise<{ created: string[], skipped: string[], warnings: string[], errors: string[], migrated: string[], removed: string[], plan?: object }>}
 */
export async function init(options = {}) {
  const {
    target = process.cwd(),
    refreshAssets = false,
    opencode: opencodeAlias = false,
    adapter: adapterOption,
    io = createIo(),
    dryRun = false,
    json = false,
    verbose = false,
    agentsGuidance = true,
    repositoryOnly = false,
  } = options;

  let selectedAdapter = adapterOption;
  if (opencodeAlias && !selectedAdapter) {
    selectedAdapter = 'opencode';
  }
  if (selectedAdapter && !IMPLEMENTED_ADAPTERS.includes(selectedAdapter)) {
    return {
      ...emptyResult(),
      errors: [`Unknown adapter '${selectedAdapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`],
    };
  }

  const plan = planInit({ target, adapter: selectedAdapter ?? null, refreshAssets, agentsGuidance, repositoryOnly });

  // --json is a machine-readable plan contract: it always implies dry-run so
  // stdout carries exactly one versioned document and nothing mutates.
  const effectiveDryRun = dryRun || json;

  if (effectiveDryRun) {
    if (json) {
      io.out(lifecyclePlanToJson(plan));
    } else {
      for (const line of renderLifecyclePlan(plan, { verbose, dryRun: true })) io.out(line);
      for (const warning of plan.warnings) io.warn(`  WARN: ${warning}`);
    }
    return { ...emptyResult(), plan };
  }

  const applied = applyLifecyclePlan(target, plan, { execHandler: initExecHandler });
  const mutationReceipt = lifecycleMutationReceipt(target, plan, applied);

  const result = emptyResult();
  result.created.push(...applied.created, ...applied.updated);
  result.removed.push(...applied.removed);
  result.skipped.push(...applied.skipped);
  result.warnings.push(...applied.warnings);
  result.errors.push(...applied.errors);
  for (const action of plan.actions) {
    if (action.category !== 'legacy') continue;
    if (action.kind === 'remove' && applied.removed.includes(action.display ?? action.path)) {
      result.created.push(action.display);
    }
    if (action.exec?.type === 'rename' && applied.merged.includes(action.display)) {
      result.migrated.push(action.display);
    }
  }
  // v2 config migration display routes to migrated for compatibility.
  for (const entry of applied.updated) {
    if (entry.startsWith('agenticloop.json: extends rewritten')) {
      result.migrated.push(entry);
      result.created.splice(result.created.indexOf(entry), 1);
    }
  }
  result.created.push(...applied.adapterFiles);

  // Default output is a concise summary; paths require --verbose.
  const counts = lifecyclePlanCounts(plan);
  io.out();
  if (verbose) {
    for (const entry of result.migrated) io.out(`  migrated: ${entry}`);
    for (const entry of result.removed) io.out(`  removed:  ${entry}`);
    for (const entry of result.created) io.out(`  created:  ${entry}`);
    for (const entry of applied.merged) io.out(`  merged:   ${entry}`);
    for (const entry of result.skipped) io.out(`  skipped (exists): ${entry}`);
  } else {
    io.out(repositoryOnly ? 'Agentic Loop repository update applied' : 'Agentic Loop initialized');
    io.out(`  Created  ${counts.create + counts.adapter}`);
    io.out(`  Updated  ${counts.update}`);
    io.out(`  Skipped  ${counts.skip}`);
    io.out(`  Blocked  ${plan.blockers.length + counts.blocked}`);
    // Merge-segment outcomes (guidance, .gitignore) stay visible in the
    // concise summary; they carry their own descriptive display text.
    for (const entry of applied.merged) io.out(`  ${entry}`);
  }
  for (const warning of result.warnings) io.warn(`  WARN: ${warning}`);
  for (const error of result.errors) io.err(`  ERROR: ${error}`);
  for (const rollbackError of applied.rollbackErrors) io.err(`  ROLLBACK ERROR: ${rollbackError}`);
  for (const line of formatPartialApplyDiagnostics(applied)) io.err(line);

  const refreshableSkipped = result.skipped.filter(
    entry =>
      entry !== 'agenticloop.json' &&
      entry !== '.agenticloop/project.md'
  );
  if (!json && verbose && refreshableSkipped.length > 0) {
    io.out();
    io.out("  To update existing Agentic Loop-owned assets, run: agenticloop update");
  }

  if (result.errors.length === 0) {
    const setupState = repositoryOnly ? null : detectSetupState(target);
    const steps = setupState ? nextStepsFromState(setupState) : [];

    if (!selectedAdapter && !refreshAssets && !json) {
      io.out();
      io.out('  Files backend is ready.');
      io.out('  Task records go under .agenticloop/tasks/<TASK-ID>.md (e.g. T-001.md).');
      io.out('  Scratch files belong under .agenticloop/tmp/.');
      io.out('  Toolkit source is under agenticloop/.');
    }

    if (selectedAdapter && selectedAdapter !== 'opencode' && verbose) {
      io.out();
      io.out(`  Adapter output generated for: ${selectedAdapter}`);
    }

    if (!json) {
      if (setupState && setupState.setupStatus !== 'confirmed') {
        io.out();
        io.out('  Project setup: needed.');
        io.out('  Next: npx agenticloop setup');
      } else if (steps.length > 0) {
        io.out();
        io.out('  Next:');
        for (const step of steps) io.out(`    ${step}`);
      }
    }
  }
  io.out();

  return { ...result, plan, mutationReceipt };
}

export { planInit };
