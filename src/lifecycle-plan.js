// @ts-check
/**
 * Lifecycle plan schema, validation, rendering, and apply.
 *
 * One lifecycle action vocabulary covers toolkit/state/config/guidance work
 * for init and setup: create, update, merge, remove, skip, blocked. Every
 * action carries a normalized target-relative path, an ownership/category,
 * a reason, and deterministic execution data. Plans are pure data: they are
 * computed without writes, rendered for humans or as one versioned JSON
 * document, preflighted as a whole, and applied through the generic
 * filesystem mutation kernel (`fs-mutation-kernel.js`). Adapter actions are
 * composed from the canonical adapter planners and the generation
 * transaction; the lifecycle planner never reimplements adapter collision or
 * ownership rules.
 *
 * This module has `// @ts-check` because the repository TypeScript config
 * checks `src/**` with `checkJs: false`; the plan contract wants real type
 * coverage. Plan-specific JSDoc types live here beside the runtime validator.
 * `src/types.js` remains the home for types shared outside this domain.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSafeRelativePath,
  executeMutationBatch,
  fingerprintTargetPath,
} from './fs-mutation-kernel.js';
import { executeGenerationPlan } from './generation-transaction.js';

export const LIFECYCLE_PLAN_SCHEMA_VERSION = 1;

/** @typedef {'create'|'update'|'merge'|'remove'|'skip'|'blocked'} LifecycleActionKind */
/** @typedef {'toolkit'|'state'|'config'|'gitignore'|'legacy'|'guidance'|'adapter'} LifecycleActionCategory */
/** @typedef {'agenticloop-owned'|'target-owned'|'shared'|'generated'} LifecycleOwnership */

/**
 * @typedef {Object} LifecycleExecDescriptor
 * @property {'rename'|'project-map'|'guidance'} type
 * @property {string} [from]         rename: target-relative source path
 * @property {string} [to]           rename: target-relative destination path
 * @property {string|null} [fromBaseHash] rename: source state fingerprint
 * @property {string|null} [toBaseHash]   rename: destination state fingerprint
 * @property {Object<string, *>} [values]  project-map: values to write
 * @property {boolean} [refreshOnly] guidance: refresh an existing owned block only
 */

/**
 * @typedef {Object} LifecycleAction
 * @property {LifecycleActionKind} kind
 * @property {string} path          Target-relative path (forward slashes).
 * @property {LifecycleActionCategory} category
 * @property {LifecycleOwnership} ownership
 * @property {string} reason        Why this action is in the plan.
 * @property {string} [content]     Deterministic content for create/update/merge.
 * @property {boolean} [directory]  True for directory creation or explicit
 *   non-recursive empty-directory removal.
 * @property {string|null} [baseHash]  sha256 of the pre-state file bytes at plan
 *   time (null = file was absent). Used by stale-plan re-preflight.
 * @property {string} [display]     Human/legacy result-list entry for this action.
 * @property {LifecycleExecDescriptor} [exec]  Special executor descriptor for
 *   merge kinds that own their write path (for example { type: 'guidance', ... }).
 */

/**
 * @typedef {Object} LifecycleAdapterGroup
 * @property {string[]} adapters
 * @property {string} outputRoot
 * @property {Object[]} actions     Canonical generation-plan actions.
 * @property {string[]} files       Canonical generation-plan file list.
 * @property {Array<{relPath: string, message: string}>} blocked
 */

/**
 * @typedef {Object} LifecyclePlan
 * @property {number} schemaVersion  Always LIFECYCLE_PLAN_SCHEMA_VERSION.
 * @property {'init'|'setup'} command
 * @property {LifecycleAction[]} actions
 * @property {LifecycleAdapterGroup[]} adapterGroups
 * @property {string[]} blockers     Plan-level blockers; non-empty fails apply.
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} LifecycleApplyResult
 * @property {boolean} ok
 * @property {boolean} stale        True when re-preflight found changed state.
 * @property {boolean} partialApply True when one or more segments committed
 *   before a later segment failed, or when the failed segment could not
 *   confirm its own rollback. Committed segments are NOT globally rolled
 *   back; a fully rolled-back failed segment leaves repairable partial state.
 * @property {string[]} errors
 * @property {string[]} rollbackErrors
 * @property {string[]} created
 * @property {string[]} updated
 * @property {string[]} removed
 * @property {string[]} skipped
 * @property {string[]} merged
 * @property {string[]} blocked
 * @property {string[]} adapterFiles
 * @property {string[]} warnings
 * @property {string[]} committedSegments  Display labels of segments that
 *   committed before any failure (empty on full success is implied by ok=true;
 *   populated when partialApply=true).
 * @property {{ kind: string, label: string, rolledBack: boolean } | null} failedSegment
 *   The segment that failed and was internally rolled back, or null.
 */

const ACTION_KINDS = new Set(['create', 'update', 'merge', 'remove', 'skip', 'blocked']);
const ACTION_CATEGORIES = new Set(['toolkit', 'state', 'config', 'gitignore', 'legacy', 'guidance', 'adapter']);
const ACTION_OWNERSHIPS = new Set(['agenticloop-owned', 'target-owned', 'shared', 'generated']);
const ACTION_FIELDS = new Set(['kind', 'path', 'category', 'ownership', 'reason', 'content', 'directory', 'baseHash', 'display', 'exec']);
const PLAN_FIELDS = new Set(['schemaVersion', 'command', 'actions', 'adapterGroups', 'blockers', 'warnings']);
const ADAPTER_GROUP_FIELDS = new Set(['adapters', 'outputRoot', 'actions', 'files', 'blocked']);
const EXEC_TYPES = new Set(['rename', 'project-map', 'guidance']);

/** @param {string} message @returns {never} */
function fail(message) {
  throw new TypeError(`invalid lifecycle plan: ${message}`);
}

/**
 * Validate one exec descriptor. Rejects unknown exec types and required-field
 * violations so a malformed lifecycle plan cannot reach the kernel.
 * @param {LifecycleAction} action @param {number} index */
function validateExec(action, index) {
  const exec = action.exec;
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) {
    fail(`action ${index} has a non-object exec`);
  }
  if (!EXEC_TYPES.has(exec.type)) {
    fail(`action ${index} has unknown exec type '${exec.type}'`);
  }
  // Every exec descriptor must name its own target-relative path safely.
  // The action path itself is validated by the canonical validator below.
  if (exec.type === 'rename') {
    if (typeof exec.from !== 'string' || typeof exec.to !== 'string') {
      fail(`action ${index} rename exec needs string 'from' and 'to'`);
    }
    if (action.path !== exec.to) {
      fail(`action ${index} rename exec 'to' must match the action path`);
    }
    if (typeof exec.fromBaseHash !== 'string') {
      fail(`action ${index} rename exec needs string 'fromBaseHash'`);
    }
    if (exec.toBaseHash !== null && typeof exec.toBaseHash !== 'string') {
      fail(`action ${index} rename exec needs string-or-null 'toBaseHash'`);
    }
    for (const candidate of [exec.from, exec.to]) {
      try {
        assertSafeRelativePath(/** @type {string} */ (candidate));
      } catch (error) {
        fail(`action ${index} rename exec path is unsafe: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (exec.type === 'project-map') {
    if (!exec.values || typeof exec.values !== 'object' || Array.isArray(exec.values)) {
      fail(`action ${index} project-map exec needs an object 'values'`);
    }
  } else if (exec.type === 'guidance') {
    if (exec.refreshOnly !== undefined && typeof exec.refreshOnly !== 'boolean') {
      fail(`action ${index} guidance exec 'refreshOnly' must be boolean when present`);
    }
  }
}

/** @param {LifecycleAction} action @param {number} index */
function validateAction(action, index) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail(`action ${index} is not an object`);
  for (const field of Object.keys(action)) {
    if (!ACTION_FIELDS.has(field)) fail(`action ${index} has unknown field '${field}'`);
  }
  if (!ACTION_KINDS.has(action.kind)) fail(`action ${index} has unknown kind '${action.kind}'`);
  if (typeof action.path !== 'string' || action.path.length === 0) fail(`action ${index} has no target-relative path`);
  // Reuse the kernel's one canonical target-relative path validator so
  // lifecycle and kernel path validation can never drift apart.
  try {
    assertSafeRelativePath(action.path);
  } catch (error) {
    fail(`action ${index} has unsafe path '${action.path}' (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!ACTION_CATEGORIES.has(action.category)) fail(`action ${index} has unknown category '${action.category}'`);
  if (!ACTION_OWNERSHIPS.has(action.ownership)) fail(`action ${index} has unknown ownership '${action.ownership}'`);
  if (typeof action.reason !== 'string' || action.reason.length === 0) fail(`action ${index} has no reason`);
  if ((action.kind === 'create' || action.kind === 'update') && !action.directory && typeof action.content !== 'string') {
    fail(`action ${index} (${action.kind} ${action.path}) has no deterministic content`);
  }
  if (action.exec !== undefined) validateExec(action, index);
}

/**
 * Validate a runtime or JSON-decoded lifecycle plan. Rejects unknown schema
 * versions, unknown fields, and unknown action kinds. Throws TypeError on the
 * first violation; returns the plan unchanged on success.
 *
 * @param {LifecyclePlan} plan
 * @returns {LifecyclePlan}
 */
export function validateLifecyclePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('plan is not an object');
  for (const field of Object.keys(plan)) {
    if (!PLAN_FIELDS.has(field)) fail(`unknown plan field '${field}'`);
  }
  if (plan.schemaVersion !== LIFECYCLE_PLAN_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${String(plan.schemaVersion)} (expected ${LIFECYCLE_PLAN_SCHEMA_VERSION})`);
  }
  if (plan.command !== 'init' && plan.command !== 'setup') fail(`unknown command '${plan.command}'`);
  if (!Array.isArray(plan.actions)) fail('actions is not an array');
  plan.actions.forEach(validateAction);
  if (!Array.isArray(plan.adapterGroups)) fail('adapterGroups is not an array');
  plan.adapterGroups.forEach((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) fail(`adapter group ${index} is not an object`);
    for (const field of Object.keys(group)) {
      if (!ADAPTER_GROUP_FIELDS.has(field)) fail(`adapter group ${index} has unknown field '${field}'`);
    }
    if (!Array.isArray(group.adapters) || !Array.isArray(group.actions) || !Array.isArray(group.files)) {
      fail(`adapter group ${index} is malformed`);
    }
  });
  if (!Array.isArray(plan.blockers)) fail('blockers is not an array');
  if (!Array.isArray(plan.warnings)) fail('warnings is not an array');
  return plan;
}

/** Serialize a plan to the stable, versioned JSON document form. */
/** @param {LifecyclePlan} plan */
export function lifecyclePlanToJson(plan) {
  const valid = validateLifecyclePlan(plan);
  return JSON.stringify(valid, null, 2);
}

/** Parse and validate a JSON plan document. Throws TypeError when invalid. */
/** @param {string} text */
export function lifecyclePlanFromJson(text) {
  return validateLifecyclePlan(JSON.parse(text));
}

/** Aggregate action counts by kind. */
/** @param {LifecyclePlan} plan */
export function lifecyclePlanCounts(plan) {
  const counts = { create: 0, update: 0, merge: 0, remove: 0, skip: 0, blocked: 0, adapter: 0 };
  for (const action of plan.actions) counts[action.kind] += 1;
  for (const group of plan.adapterGroups) {
    counts.adapter += group.files.length;
    counts.blocked += group.blocked.length;
  }
  return counts;
}

/** @param {string|Buffer} content */
function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** @param {string} path */
function hashFileOrNull(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return hashContent(readFileSync(path));
}

/**
 * Re-preflight a plan against current target state. Any drift between plan
 * time and apply time fails safely before the first write.
 *
 * @param {string} target
 * @param {LifecyclePlan} plan
 * @returns {string[]} stale descriptions (empty when the plan still matches)
 */
export function preflightLifecyclePlan(target, plan) {
  const stale = [];
  for (const action of plan.actions) {
    if (action.kind === 'skip' || action.kind === 'blocked') continue;
    const fullPath = join(target, action.path);
    if (action.exec) {
      if (action.exec.type === 'rename') {
        try {
          const fromState = fingerprintTargetPath(target, /** @type {string} */ (action.exec.from));
          const toState = fingerprintTargetPath(target, /** @type {string} */ (action.exec.to));
          if (fromState !== action.exec.fromBaseHash) {
            stale.push(`planned rename source '${action.exec.from}' changed since the plan was computed`);
          }
          if (toState !== action.exec.toBaseHash) {
            stale.push(`planned rename destination '${action.exec.to}' changed since the plan was computed`);
          }
        } catch (error) {
          stale.push(error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (action.baseHash !== undefined && hashFileOrNull(fullPath) !== action.baseHash) {
        stale.push(`planned merge '${action.path}' changed since the plan was computed`);
      }
      continue;
    }
    if (action.kind === 'create') {
      if (existsSync(fullPath) && action.baseHash === null) {
        stale.push(`planned create '${action.path}' already exists`);
      }
      continue;
    }
    if (action.kind === 'update' || action.kind === 'merge' || action.kind === 'remove') {
      let currentHash;
      try {
        currentHash = action.directory
          ? fingerprintTargetPath(target, action.path)
          : hashFileOrNull(fullPath);
      } catch (error) {
        stale.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (currentHash !== (action.baseHash ?? null)) {
        stale.push(`planned ${action.kind} '${action.path}' changed since the plan was computed`);
      }
    }
  }
  return stale;
}

/** All plan-level and adapter-group blockers as display strings. */
/** @param {LifecyclePlan} plan */
export function lifecyclePlanBlockers(plan) {
  const blockers = [...plan.blockers];
  for (const group of plan.adapterGroups) {
    for (const blocked of group.blocked) {
      blockers.push(`BLOCKED ${blocked.relPath}: ${blocked.message}`);
    }
  }
  return blockers;
}

/**
 * Apply a validated lifecycle plan under the cross-segment contract:
 *
 *   - Each built-in lifecycle segment is atomic (a generic kernel batch, an
 *     exec descriptor, or one adapter generation transaction). An injected
 *     executor that cannot prove rollback is reported as unconfirmed.
 *   - The complete plan is preflighted before the first mutation (blockers,
 *     adapter collisions, and stale-plan drift all fail closed up front).
 *   - Execution is fail-stop: the first failed segment stops the apply.
 *   - Previously committed segments are NOT globally rolled back; their
 *     effects remain. This keeps partial state consistent and repairable by
 *     rerunning setup or init, which recomputes an idempotent plan over the
 *     partial state.
 *   - A built-in failed segment is rolled back internally (the kernel restores
 *     the segment's own pre-state), and the result reports rollback errors for
 *     that segment separately from the primary error.
 *   - The result identifies committed segments, the failed segment, whether
 *     partial application occurred, primary errors, and rollback errors.
 *
 * @param {string} target
 * @param {LifecyclePlan} plan
 * @param {Object} [options]
 * @param {(action: LifecycleAction, applyTarget: string) => {
 *   ok: boolean,
 *   errors?: string[],
 *   warnings?: string[],
 *   rollbackErrors?: string[],
 *   changed?: boolean,
 *   display?: string,
 *   stale?: boolean,
 *   rolledBack?: boolean
 * }} [options.execHandler]
 *   Executes `action.exec` descriptors (guidance, project-map writes).
 * @returns {LifecycleApplyResult}
 */
export function applyLifecyclePlan(target, plan, options = {}) {
  /** @type {LifecycleApplyResult} */
  const result = {
    ok: false,
    stale: false,
    partialApply: false,
    errors: [],
    rollbackErrors: [],
    created: [],
    updated: [],
    removed: [],
    skipped: [],
    merged: [],
    blocked: [],
    adapterFiles: [],
    warnings: [...plan.warnings],
    committedSegments: [],
    failedSegment: null,
  };

  try {
    validateLifecyclePlan(plan);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  if (plan.blockers.length > 0) {
    result.errors.push(...plan.blockers);
    result.blocked.push(...plan.actions.filter(a => a.kind === 'blocked').map(a => a.display ?? a.path));
    return result;
  }

  // Full-plan preflight: adapter-group collisions stop every write, including
  // scaffold actions, before the first mutation.
  const adapterBlocked = plan.adapterGroups.flatMap(group => group.blocked);
  if (adapterBlocked.length > 0) {
    result.errors.push(...adapterBlocked.map(blocked => `BLOCKED ${blocked.relPath}: ${blocked.message}`));
    return result;
  }

  const stale = preflightLifecyclePlan(target, plan);
  if (stale.length > 0) {
    result.stale = true;
    result.errors.push(
      'Target state changed since the plan was computed; re-run with a fresh plan.',
      ...stale
    );
    return result;
  }

  // Build ordered segments in plan order: consecutive generic actions form
  // one kernel batch; exec actions run individually at their plan position.
  // Adapter groups run last through the canonical generation transaction.
  const mutating = plan.actions.filter(action => action.kind !== 'skip' && action.kind !== 'blocked');
  /** @type {Array<{type: 'batch'|'exec', actions: LifecycleAction[], label: string, adapterGroup?: LifecycleAdapterGroup}>} */
  const segments = [];
  for (const action of mutating) {
    if (action.exec) {
      segments.push({ type: 'exec', actions: [action], label: action.display ?? action.path });
    } else {
      const last = segments[segments.length - 1];
      if (last && last.type === 'batch') last.actions.push(action);
      else segments.push({ type: 'batch', actions: [action], label: `${action.kind} ${action.path}` });
    }
  }
  for (const group of plan.adapterGroups) {
    segments.push({
      type: 'exec',
      actions: [],
      label: `adapter generation: ${group.adapters.join(', ')}`,
      adapterGroup: group,
    });
  }

  for (const segment of segments) {
    if (segment.type === 'batch') {
      /** @type {Array<{type: string, path: string, content?: string}>} */
      const mutations = [];
      for (const action of segment.actions) {
        // Mutations use target-relative paths; the kernel resolves and
        // validates each through its canonical validator.
        if (action.kind === 'remove') {
          mutations.push({
            type: action.directory ? 'rmdir-empty' : 'remove',
            path: action.path,
          });
        } else if (action.directory) {
          mutations.push({ type: 'mkdir', path: action.path });
        } else {
          mutations.push({ type: 'write', path: action.path, content: action.content });
        }
      }
      const batchResult = executeMutationBatch(target, mutations);
      if (!batchResult.ok) {
        const rolledBack = batchResult.rollbackErrors.length === 0;
        result.partialApply = result.committedSegments.length > 0 || !rolledBack;
        result.failedSegment = { kind: 'batch', label: segment.label, rolledBack };
        result.errors.push(...batchResult.errors);
        result.rollbackErrors.push(...batchResult.rollbackErrors);
        return result;
      }
      for (const action of segment.actions) {
        const display = action.display ?? action.path;
        if (action.kind === 'create') result.created.push(display);
        else if (action.kind === 'update') result.updated.push(display);
        else if (action.kind === 'merge') result.merged.push(display);
        else if (action.kind === 'remove') result.removed.push(display);
      }
      result.committedSegments.push(segment.label);
      continue;
    }

    // Exec segment (or adapter group).
    if (segment.adapterGroup) {
      const group = segment.adapterGroup;
      const generation = executeGenerationPlan(target, {
        outputRoot: group.outputRoot,
        actions: group.actions,
        files: group.files,
        adapters: group.adapters,
      });
      if (!generation.ok) {
        const rolledBack = (generation.rollbackErrors ?? []).length === 0;
        result.partialApply = result.committedSegments.length > 0 || !rolledBack;
        result.failedSegment = { kind: 'adapter', label: segment.label, rolledBack };
        result.errors.push(...generation.errors);
        result.rollbackErrors.push(...(generation.rollbackErrors ?? []));
        return result;
      }
      result.warnings.push(...generation.errors);
      result.adapterFiles.push(...group.files);
      result.committedSegments.push(segment.label);
      continue;
    }

    const action = segment.actions[0];
    if (!options.execHandler) {
      result.partialApply = result.committedSegments.length > 0;
      result.failedSegment = { kind: 'exec', label: segment.label, rolledBack: true };
      result.errors.push(`no executor registered for '${action.path}'`);
      return result;
    }
    let execResult;
    try {
      execResult = options.execHandler(action, target);
    } catch (error) {
      execResult = {
        ok: false,
        rolledBack: false,
        errors: [error instanceof Error ? error.message : String(error)],
        rollbackErrors: [],
      };
    }
    for (const warning of execResult.warnings ?? []) result.warnings.push(warning);
    if (!execResult.ok) {
      const rolledBack = execResult.rolledBack === true;
      result.partialApply = result.committedSegments.length > 0 || !rolledBack;
      result.failedSegment = { kind: 'exec', label: segment.label, rolledBack };
      result.stale = execResult.stale === true;
      result.errors.push(...(execResult.errors ?? [`failed to apply '${action.path}'`]));
      result.rollbackErrors.push(...(execResult.rollbackErrors ?? []));
      return result;
    }
    if (execResult.changed) {
      result.merged.push(execResult.display ?? action.display ?? action.path);
    }
    result.committedSegments.push(segment.label);
  }

  for (const action of plan.actions) {
    if (action.kind === 'skip') result.skipped.push(action.display ?? action.path);
  }

  result.ok = true;
  return result;
}

/**
 * Human diagnostics for a failed apply under the cross-segment contract:
 * which segments committed (and were kept), which segment failed, whether
 * its rollback was confirmed, whether partial application occurred, and the
 * rerun-repair hint. Empty for successful or pre-mutation failures.
 *
 * @param {LifecycleApplyResult} applied
 * @returns {string[]}
 */
export function formatPartialApplyDiagnostics(applied) {
  if (applied.ok || !applied.failedSegment) return [];
  const lines = [];
  if (applied.partialApply) {
    lines.push(`  Partial application: ${applied.committedSegments.length} segment(s) committed and were kept (not globally rolled back):`);
    for (const label of applied.committedSegments) lines.push(`    committed: ${label}`);
  }
  if (applied.failedSegment.rolledBack) {
    lines.push(`  Failed segment '${applied.failedSegment.label}' was rolled back internally; no later segment ran.`);
    lines.push('  The target is in a consistent partial state; re-run agenticloop setup or init to repair it.');
  } else {
    lines.push(`  Failed segment '${applied.failedSegment.label}' could not confirm a complete rollback; no later segment ran.`);
    lines.push('  Inspect the reported rollback errors and target state before re-running agenticloop setup or init.');
  }
  return lines;
}

/**
 * Render a plan as concise human text. Individual paths appear only when
 * `verbose` is set; the default shows step and mutation summaries.
 *
 * @param {LifecyclePlan} plan
 * @param {Object} [options]
 * @param {boolean} [options.verbose]
 * @param {boolean} [options.dryRun]
 * @returns {string[]}
 */
export function renderLifecyclePlan(plan, options = {}) {
  const counts = lifecyclePlanCounts(plan);
  const lines = [];
  lines.push(options.dryRun ? 'Plan (dry run - no changes will be made):' : 'Plan:');
  if (counts.create > 0) lines.push(`  Create  ${counts.create} file(s)/dir(s)`);
  if (counts.update > 0) lines.push(`  Update  ${counts.update}`);
  if (counts.merge > 0) lines.push(`  Merge   ${counts.merge}`);
  if (counts.remove > 0) lines.push(`  Remove  ${counts.remove}`);
  if (counts.adapter > 0) lines.push(`  Generate ${counts.adapter} adapter artifact(s)`);
  if (counts.skip > 0) lines.push(`  Keep    ${counts.skip} existing`);
  if (plan.blockers.length > 0 || counts.blocked > 0) {
    lines.push(`  Blocked ${plan.blockers.length + counts.blocked}`);
  }
  if (options.verbose) {
    lines.push('');
    for (const action of plan.actions) {
      lines.push(`  ${action.kind.padEnd(8)}${action.path}  (${action.reason})`);
    }
    for (const group of plan.adapterGroups) {
      for (const file of group.files) lines.push(`  generate ${file}`);
      for (const blocked of group.blocked) lines.push(`  blocked  ${blocked.relPath}: ${blocked.message}`);
    }
  }
  for (const blocker of plan.blockers) lines.push(`  BLOCKED: ${blocker}`);
  return lines;
}

/** Recursive file walk used by lifecycle planners (bundled source inputs). */
/**
 * @param {string} rootDir
 * @param {string} [relBase]
 * @returns {Array<{fullPath: string, relPath: string}>}
 */
export function walkFiles(rootDir, relBase = '') {
  /** @type {Array<{fullPath: string, relPath: string}>} */
  const entries = [];
  if (!existsSync(rootDir)) return entries;
  for (const entry of readdirSync(rootDir).sort()) {
    const fullPath = join(rootDir, entry);
    const relPath = relBase ? `${relBase}/${entry}` : entry;
    if (statSync(fullPath).isDirectory()) {
      entries.push(...walkFiles(fullPath, relPath));
    } else {
      entries.push({ fullPath, relPath });
    }
  }
  return entries;
}

export { hashContent, hashFileOrNull };
