/** Clone-local adapter hydration built on the shared adapter planner and transaction. */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { planAdapterArtifacts, generateAdapterArtifacts, IMPLEMENTED_ADAPTERS } from './adapter-generation.js';
import { deepMerge, loadAgenticLoopConfig, loadJsonFile } from './json.js';
import { isPackageSourceRepositoryRoot, resolveToolkitAssetLayout } from './layout.js';
import { LOCAL_GENERATED_ARTIFACTS_PATH, loadManifest, resolveManagedPath } from './generated-artifacts.js';
import { WORKFLOW_ROLE_IDS } from './workflow-roles.js';

export const LOCAL_CONFIG_RELATIVE_PATH = '.agenticloop/local/config.json';
export const HYDRATION_PLAN_SCHEMA_VERSION = 1;

const ROLE_FIELDS = Object.freeze({
  opencode: new Set(['model', 'reasoningEffort', 'variant', 'reasoningEffortDefault']),
  codex: new Set(['model', 'reasoningEffort', 'variant', 'reasoningEffortDefault']),
  'claude-code': new Set(['model', 'permissionMode']),
  copilot: new Set(['model']),
  cursor: new Set(['model']),
});

function assertObject(value, source, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid local configuration at ${source}: ${path} must be an object`);
  }
}

export function validateLocalHydrationConfig(value, source = LOCAL_CONFIG_RELATIVE_PATH) {
  assertObject(value, source, 'document');
  for (const key of Object.keys(value)) {
    if (key !== 'adapters') throw new Error(`Invalid local configuration at ${source}: unknown field '${key}'`);
  }
  if (value.adapters === undefined) return {};
  assertObject(value.adapters, source, 'adapters');
  const result = { adapters: {} };
  for (const [host, adapterConfig] of Object.entries(value.adapters)) {
    if (!IMPLEMENTED_ADAPTERS.includes(host)) {
      throw new Error(`Invalid local configuration at ${source}: unknown adapter '${host}'`);
    }
    assertObject(adapterConfig, source, `adapters.${host}`);
    for (const key of Object.keys(adapterConfig)) {
      if (key !== 'roleSettings') {
        throw new Error(`Invalid local configuration at ${source}: adapters.${host}.${key} is not allowed`);
      }
    }
    assertObject(adapterConfig.roleSettings, source, `adapters.${host}.roleSettings`);
    const roleSettings = {};
    for (const [role, settings] of Object.entries(adapterConfig.roleSettings)) {
      if (!WORKFLOW_ROLE_IDS.includes(role)) {
        throw new Error(`Invalid local configuration at ${source}: unknown role '${role}' for ${host}`);
      }
      assertObject(settings, source, `adapters.${host}.roleSettings.${role}`);
      const allowed = ROLE_FIELDS[host];
      const clean = {};
      for (const [field, fieldValue] of Object.entries(settings)) {
        if (!allowed.has(field)) {
          throw new Error(`Invalid local configuration at ${source}: adapters.${host}.roleSettings.${role}.${field} is not allowed`);
        }
        if (field === 'reasoningEffortDefault') {
          if (typeof fieldValue !== 'boolean') throw new Error(`Invalid local configuration at ${source}: ${field} must be boolean`);
        } else if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
          throw new Error(`Invalid local configuration at ${source}: ${field} must be a non-empty string`);
        }
        clean[field] = fieldValue;
      }
      roleSettings[role] = clean;
    }
    result.adapters[host] = { roleSettings };
  }
  return result;
}

export function loadHydrationConfig(target) {
  const packageSource = isPackageSourceRepositoryRoot(target);
  const trackedPath = packageSource ? join(target, 'config.json') : join(target, 'agenticloop.json');
  if (!existsSync(trackedPath)) {
    throw new Error(`Tracked configuration not found at ${trackedPath}`);
  }
  let tracked;
  try {
    tracked = packageSource ? loadJsonFile(trackedPath) : loadAgenticLoopConfig(trackedPath);
  } catch (error) {
    throw new Error(`Invalid tracked configuration at ${trackedPath}: ${error.message}`);
  }

  const localPath = join(target, ...LOCAL_CONFIG_RELATIVE_PATH.split('/'));
  if (!existsSync(localPath)) return { config: tracked, trackedPath, localPath, localApplied: false };
  let rawLocal;
  try {
    rawLocal = JSON.parse(readFileSync(localPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid local configuration at ${LOCAL_CONFIG_RELATIVE_PATH}: ${error.message}`);
  }
  const local = validateLocalHydrationConfig(rawLocal);
  return { config: deepMerge(tracked, local), trackedPath, localPath, localApplied: true };
}

function git(target, args) {
  return spawnSync('git', args, { cwd: target, encoding: 'utf8', windowsHide: true });
}

function isConfirmedNonGitDirectory(probe) {
  return probe.status === 128 && /not a git repository/i.test(probe.stderr ?? '');
}

function gitProbeError(probe) {
  if (probe.error) return probe.error.message;
  const stderr = probe.stderr?.trim();
  if (stderr) return stderr;
  return `git exited with status ${probe.status ?? 'unknown'}`;
}

function gitCleanlinessPlan(target, relPaths) {
  const probe = git(target, ['rev-parse', '--is-inside-work-tree']);
  if (probe.status === 0 && probe.stdout?.trim() !== 'true') {
    return {
      warnings: [],
      blockers: ['Unable to verify Git cleanliness for hydration: target is not a Git worktree.'],
    };
  }
  if (isConfirmedNonGitDirectory(probe)) {
    return {
      warnings: ['Target is not a Git worktree; hydration is allowed, but tracked-tree cleanliness cannot be verified.'],
      blockers: [],
    };
  }
  if (probe.status !== 0) {
    return {
      warnings: [],
      blockers: [`Unable to verify Git cleanliness for hydration: ${gitProbeError(probe)}`],
    };
  }
  const blockers = [];
  for (const relPath of [...new Set(relPaths)].sort()) {
    resolveManagedPath(target, '.', relPath);
    const tracked = git(target, ['ls-files', '--error-unmatch', '--', relPath]);
    if (tracked.status === 0) {
      blockers.push(`Hydration destination '${relPath}' is tracked. Remove it from the tracked tree before hydrating.`);
      continue;
    }
    const ignored = git(target, ['check-ignore', '--no-index', '-q', '--', relPath]);
    if (ignored.status !== 0) {
      blockers.push(`Hydration destination '${relPath}' is not ignored. Add a precise .gitignore rule with 'agenticloop update --repository-only', commit it, and retry.`);
    }
  }
  return { warnings: [], blockers };
}

function hydrationDestinationPaths(target, generationPlan, manifestRelPath = LOCAL_GENERATED_ARTIFACTS_PATH) {
  const paths = [
    ...generationPlan.actions
      .filter(action => action.relPath && action.type !== 'clear-owned-directory')
      .map(action => action.relPath),
    manifestRelPath,
  ];
  let manifest;
  try {
    manifest = loadManifest(target, manifestRelPath);
  } catch {
    // Generation preflight reports malformed ownership manifests as blockers.
    return paths;
  }
  const clearRoots = generationPlan.actions
    .filter(action => action.type === 'clear-owned-directory')
    .map(action => ({ adapter: action.adapter, relPath: action.relPath }));
  for (const entry of manifest?.entries ?? []) {
    if (entry.kind !== 'file' || entry.outputRoot !== generationPlan.outputRoot) continue;
    if (clearRoots.some(root =>
      root.adapter === entry.adapter &&
      (entry.relPath === root.relPath || entry.relPath.startsWith(`${root.relPath}/`))
    )) paths.push(entry.relPath);
  }
  return paths;
}

function localOnlyPlan(plan) {
  const forbidden = new Set(['agenticloop.json', 'AGENTS.md', '.gitignore']);
  const actions = plan.actions.filter(action => action.type !== 'gitignore-append');
  const blockers = actions
    .filter(action => forbidden.has(action.relPath))
    .map(action => `Hydration planner attempted forbidden repository mutation '${action.relPath}'.`);
  return {
    ...plan,
    actions,
    files: [...new Set(actions.filter(action => action.relPath).map(action => action.relPath))],
    blockers,
  };
}

export function planHydration({ target, adapter, forceGenerated = false }) {
  if (!IMPLEMENTED_ADAPTERS.includes(adapter)) {
    return { schemaVersion: HYDRATION_PLAN_SCHEMA_VERSION, command: 'hydrate', adapter, actions: [], blockers: [`Unknown adapter '${adapter}'.`], warnings: [] };
  }
  let loaded;
  try {
    loaded = loadHydrationConfig(target);
  } catch (error) {
    return { schemaVersion: HYDRATION_PLAN_SCHEMA_VERSION, command: 'hydrate', adapter, actions: [], blockers: [error.message], warnings: [] };
  }
  const layout = resolveToolkitAssetLayout(target);
  if (layout.kind === 'absent') {
    return { schemaVersion: HYDRATION_PLAN_SCHEMA_VERSION, command: 'hydrate', adapter, actions: [], blockers: ['Canonical Agentic Loop assets are not installed in this target.'], warnings: [] };
  }
  const planned = planAdapterArtifacts({
    target,
    assetSourceRoot: target,
    alConfig: loaded.config,
    adapter,
    forceGenerated,
    manifestRelPath: LOCAL_GENERATED_ARTIFACTS_PATH,
    excludeGitignoreActions: true,
  });
  if (!planned.ok) {
    return { schemaVersion: HYDRATION_PLAN_SCHEMA_VERSION, command: 'hydrate', adapter, actions: [], blockers: planned.errors, warnings: [] };
  }
  const generationPlan = localOnlyPlan(planned.plan);
  const cleanliness = gitCleanlinessPlan(target, hydrationDestinationPaths(target, generationPlan));
  const collisionBlockers = planned.preflight.blocked.map(item => `BLOCKED ${item.relPath}: ${item.message}`);
  const statuses = new Map(planned.preflight.collisions.map(item => [item.relPath, item.status]));
  return {
    schemaVersion: HYDRATION_PLAN_SCHEMA_VERSION,
    command: 'hydrate',
    adapter,
    manifestPath: LOCAL_GENERATED_ARTIFACTS_PATH,
    localConfigPath: LOCAL_CONFIG_RELATIVE_PATH,
    localConfigApplied: loaded.localApplied,
    actions: generationPlan.actions.filter(action => action.relPath && action.type !== 'clear-owned-directory').map(action => ({
      kind: action.type,
      path: action.relPath,
      status: statuses.get(action.relPath) ?? 'planned',
    })),
    blockers: [...generationPlan.blockers, ...collisionBlockers, ...cleanliness.blockers],
    warnings: cleanliness.warnings,
    generationPlan,
    effectiveConfig: loaded.config,
  };
}

export function applyHydration({ target, adapter, forceGenerated = false, plan }) {
  const hydrationPlan = plan ?? planHydration({ target, adapter, forceGenerated });
  if (hydrationPlan.blockers.length > 0) {
    return { ok: false, errors: hydrationPlan.blockers, files: [], plan: hydrationPlan };
  }
  const result = generateAdapterArtifacts({
    target,
    assetSourceRoot: target,
    alConfig: hydrationPlan.effectiveConfig,
    adapter,
    forceGenerated,
    manifestRelPath: LOCAL_GENERATED_ARTIFACTS_PATH,
    avoidUnchangedWrites: true,
    excludeGitignoreActions: true,
    // Recheck after the transaction has prepared its current plan and directly
    // before its first mutation, narrowing plan/apply races with Git state.
    beforeMutation: ({ plan: currentGenerationPlan, manifestRelPath }) => {
      const cleanliness = gitCleanlinessPlan(target, hydrationDestinationPaths(target, currentGenerationPlan, manifestRelPath));
      return { errors: cleanliness.blockers, warnings: cleanliness.warnings };
    },
  });
  return { ...result, plan: hydrationPlan };
}
