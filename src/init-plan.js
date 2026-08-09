/**
 * Pure, no-write init planner.
 *
 * Computes the exact lifecycle plan `init()` would apply: legacy-asset
 * migration, toolkit source copy/refresh, target-state memory scaffold,
 * adapter config, adapter artifact generation (composed from the canonical
 * adapter planners and the generation transaction), and .gitignore scratch
 * entries. The planner reads the target and bundled source but never writes,
 * so `init --dry-run`, guided setup composition, and repair classification all
 * share one idempotent plan.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LIFECYCLE_PLAN_SCHEMA_VERSION,
  hashContent,
  hashFileOrNull,
  walkFiles,
} from './lifecycle-plan.js';
import { fingerprintTargetPath } from './fs-mutation-kernel.js';
import {
  CONFIG_RELATIVE_PATH,
  INSTALLED_TOOLKIT_ROOT_DIRECTORY,
  MEMORY_SCAFFOLD_RELATIVE_PATH,
  PACKAGE_SOURCE_RELATIVE_PATHS,
  SCRATCH_DIRECTORY_RELATIVE_PATH,
  ACTIVATIONS_DIRECTORY_RELATIVE_PATH,
  ACTIVATIONS_GITIGNORE_PATTERNS,
  RETURN_VERIFICATIONS_DIRECTORY_RELATIVE_PATH,
  RETURN_VERIFICATIONS_GITIGNORE_PATTERNS,
  CLOSEOUT_WAIVERS_DIRECTORY_RELATIVE_PATH,
  CLOSEOUT_WAIVERS_GITIGNORE_PATTERNS,
  SCRATCH_GITIGNORE_PATTERNS,
  WORKTREES_DIRECTORY_RELATIVE_PATH,
  WORKTREES_GITIGNORE_PATTERNS,
  TARGET_STATE_DIRECTORY,
  TARGET_CONFIG_TEMPLATE_RELATIVE_PATH,
  TOOLKIT_SOURCE_RELATIVE_PATHS,
  V2_BASE_CONFIG_RELATIVE_PATH,
  bundledToolkitPath,
  isPackageSourceRepositoryRoot,
} from './layout.js';
import { exactPathMatch, inspectLegacyCanonicalAssets } from './layout-migration.js';
import { ensureAdapterRoleSettings, getDefaultRoleSettings } from './adapter-role-defaults.js';
import { deepMerge, loadJsonFile } from './json.js';
import { planAdapterArtifacts } from './adapter-generation.js';
import {
  checkGuidance,
  guidanceLifecycleAction,
  loadGuidanceAlConfig,
} from './guidance.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
const TARGET_CFG_TEMPLATE = bundledToolkitPath(TARGET_CONFIG_TEMPLATE_RELATIVE_PATH);
const MEMORY_SCAFFOLD = bundledToolkitPath(MEMORY_SCAFFOLD_RELATIVE_PATH);

const MANAGED_GITIGNORE_ENTRIES = Object.freeze([
  { dir: SCRATCH_DIRECTORY_RELATIVE_PATH, patterns: SCRATCH_GITIGNORE_PATTERNS },
  { dir: WORKTREES_DIRECTORY_RELATIVE_PATH, patterns: WORKTREES_GITIGNORE_PATTERNS },
  { dir: ACTIVATIONS_DIRECTORY_RELATIVE_PATH, patterns: ACTIVATIONS_GITIGNORE_PATTERNS },
  { dir: RETURN_VERIFICATIONS_DIRECTORY_RELATIVE_PATH, patterns: RETURN_VERIFICATIONS_GITIGNORE_PATTERNS },
  { dir: CLOSEOUT_WAIVERS_DIRECTORY_RELATIVE_PATH, patterns: CLOSEOUT_WAIVERS_GITIGNORE_PATTERNS },
]);

function createPlan(command) {
  return {
    schemaVersion: LIFECYCLE_PLAN_SCHEMA_VERSION,
    command,
    actions: [],
    adapterGroups: [],
    blockers: [],
    warnings: [],
  };
}

function selectedAdapterHosts(selectedAdapter) {
  if (selectedAdapter === 'all') return IMPLEMENTED_ADAPTERS;
  return [selectedAdapter];
}

function renderAdapterEntry(host, indent = '    ') {
  const entry = JSON.stringify({ roleSettings: getDefaultRoleSettings(host) }, null, 2)
    .replace(/\n/g, `\n${indent}`);
  return `${indent}"${host}": ${entry}`;
}

/** Pure render of the target config for the selected adapter (no writes). */
export function renderTargetConfigForAdapter(selectedAdapter) {
  const template = readFileSync(TARGET_CFG_TEMPLATE, 'utf-8');
  const entries = selectedAdapterHosts(selectedAdapter)
    .map(host => renderAdapterEntry(host))
    .join(',\n');
  const adapterBlockPattern = /  "adapters": \{[\s\S]*?\r?\n  \}\r?\n\}\s*$/;
  if (!adapterBlockPattern.test(template)) {
    throw new Error('Could not render selected adapter into target config template');
  }
  return template.replace(
    adapterBlockPattern,
    `  "adapters": {\n${entries}\n  }\n}\n`
  );
}

function planLegacyAssetActions(target, plan) {
  for (const asset of inspectLegacyCanonicalAssets(target)) {
    const legacyFullPath = join(target, asset.legacyPath);
    const currentFullPath = join(target, asset.currentPath);
    if (!asset.owned) {
      plan.warnings.push(
        `Preserving legacy root asset '${asset.legacyPath}' because ${asset.reason}.`
      );
      continue;
    }
    if (existsSync(currentFullPath)) {
      if (exactPathMatch(legacyFullPath, currentFullPath)) {
        if (statSync(legacyFullPath).isDirectory()) {
          for (const fileEntry of walkFiles(legacyFullPath, asset.legacyPath)) {
            plan.actions.push({
              kind: 'remove',
              path: fileEntry.relPath,
              category: 'toolkit',
              ownership: 'agenticloop-owned',
              reason: 'file under duplicate legacy root asset',
              baseHash: hashFileOrNull(fileEntry.fullPath),
              display: fileEntry.relPath,
            });
          }
          for (const directoryEntry of walkDirectories(legacyFullPath, asset.legacyPath)) {
            const isRoot = directoryEntry.relPath === asset.legacyPath;
            plan.actions.push({
              kind: 'remove',
              path: directoryEntry.relPath,
              category: isRoot ? 'legacy' : 'toolkit',
              ownership: 'agenticloop-owned',
              reason: isRoot
                ? 'duplicate legacy root asset'
                : 'empty directory under duplicate legacy root asset',
              directory: true,
              baseHash: fingerprintTargetPath(target, directoryEntry.relPath),
              display: isRoot
                ? `${asset.legacyPath} (removed duplicate legacy root asset)`
                : `${directoryEntry.relPath}/`,
            });
          }
        } else {
          plan.actions.push({
            kind: 'remove',
            path: asset.legacyPath,
            category: 'legacy',
            ownership: 'agenticloop-owned',
            reason: 'duplicate legacy root asset',
            baseHash: hashFileOrNull(legacyFullPath),
            display: `${asset.legacyPath} (removed duplicate legacy root asset)`,
          });
        }
      } else {
        plan.warnings.push(
          `Preserving legacy root asset '${asset.legacyPath}' because '${asset.currentPath}' already exists with different content.`
        );
      }
      continue;
    }
    plan.actions.push({
      kind: 'merge',
      path: asset.currentPath,
      category: 'legacy',
      ownership: 'agenticloop-owned',
      reason: 'migrate legacy canonical asset',
      display: `${asset.legacyPath} -> ${asset.currentPath}`,
      exec: {
        type: 'rename',
        from: asset.legacyPath,
        to: asset.currentPath,
        fromBaseHash: fingerprintTargetPath(target, asset.legacyPath),
        toBaseHash: fingerprintTargetPath(target, asset.currentPath),
      },
    });
  }
}

/** Return every directory in a tree deepest-first, including the root. */
function walkDirectories(fullPath, relPath) {
  const directories = [];
  for (const entry of readdirSync(fullPath).sort()) {
    const childFullPath = join(fullPath, entry);
    if (!statSync(childFullPath).isDirectory()) continue;
    directories.push(...walkDirectories(childFullPath, `${relPath}/${entry}`));
  }
  directories.push({ fullPath, relPath });
  return directories;
}

function planPruneActions(target, plan, removed = []) {
  const targetToolkitRoot = join(target, INSTALLED_TOOLKIT_ROOT_DIRECTORY);
  if (!existsSync(targetToolkitRoot) || !statSync(targetToolkitRoot).isDirectory()) return;

  const markUnknown = (srcDir, destDir, relBase) => {
    if (!existsSync(destDir)) return;
    for (const entry of readdirSync(destDir)) {
      const srcEntry = join(srcDir, entry);
      const destEntry = join(destDir, entry);
      const relPath = `${relBase}/${entry}`;
      if (!existsSync(srcEntry)) {
        removed.push({ relPath, fullPath: destEntry });
        continue;
      }
      const srcStat = statSync(srcEntry);
      const destStat = statSync(destEntry);
      if (srcStat.isDirectory() && destStat.isDirectory()) {
        markUnknown(srcEntry, destEntry, relPath);
        continue;
      }
      if (srcStat.isDirectory() !== destStat.isDirectory() || srcStat.isFile() !== destStat.isFile()) {
        removed.push({ relPath, fullPath: destEntry });
      }
    }
  };

  // Top-level payload prune: installed entries absent from package source.
  const allowedTopLevel = new Set(
    PACKAGE_SOURCE_RELATIVE_PATHS.map(relPath => relPath.split('/')[0]).filter(Boolean)
  );
  for (const entry of readdirSync(targetToolkitRoot)) {
    if (allowedTopLevel.has(entry)) continue;
    removed.push({
      relPath: `${INSTALLED_TOOLKIT_ROOT_DIRECTORY}/${entry}`,
      fullPath: join(targetToolkitRoot, entry),
    });
  }

  for (const installedRelPath of TOOLKIT_SOURCE_RELATIVE_PATHS) {
    const sourcePath = bundledToolkitPath(installedRelPath);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) continue;
    markUnknown(sourcePath, join(target, installedRelPath), installedRelPath);
  }

  // The kernel rejects recursive directory-removal mutations so a later batch
  // failure can never lose a directory tree. Expand every prune target into
  // owned-file removes plus explicit deepest-first empty-directory removes.
  // Empty-directory removal is non-recursive and rollback recreates any
  // directory removed before a later mutation fails.
  for (const { relPath, fullPath } of removed) {
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      for (const fileEntry of walkFiles(fullPath, relPath)) {
        plan.actions.push({
          kind: 'remove',
          path: fileEntry.relPath,
          category: 'toolkit',
          ownership: 'agenticloop-owned',
          reason: 'refresh prune: file under entry absent from package source',
          baseHash: hashFileOrNull(fileEntry.fullPath),
          display: fileEntry.relPath,
        });
      }
      for (const directoryEntry of walkDirectories(fullPath, relPath)) {
        plan.actions.push({
          kind: 'remove',
          path: directoryEntry.relPath,
          category: 'toolkit',
          ownership: 'agenticloop-owned',
          reason: 'refresh prune: empty directory under entry absent from package source',
          directory: true,
          baseHash: fingerprintTargetPath(target, directoryEntry.relPath),
          display: `${directoryEntry.relPath}/`,
        });
      }
      continue;
    }
    plan.actions.push({
      kind: 'remove',
      path: relPath,
      category: 'toolkit',
      ownership: 'agenticloop-owned',
      reason: 'refresh prune: entry absent from package source',
      baseHash: hashFileOrNull(fullPath),
      display: relPath,
    });
  }
}

function planToolkitSourceActions(target, refreshAssets, plan, legacyCoveredPrefixes = []) {
  const targetToolkitRoot = join(target, INSTALLED_TOOLKIT_ROOT_DIRECTORY);
  if (existsSync(targetToolkitRoot) && !statSync(targetToolkitRoot).isDirectory()) {
    plan.blockers.push(
      `Cannot scaffold toolkit source: ${INSTALLED_TOOLKIT_ROOT_DIRECTORY} exists and is not a directory`
    );
    return;
  }

  if (refreshAssets) {
    planPruneActions(target, plan);
  }

  for (const installedRelPath of TOOLKIT_SOURCE_RELATIVE_PATHS) {
    const sourcePath = bundledToolkitPath(installedRelPath);
    if (!existsSync(sourcePath)) {
      plan.blockers.push(`Source asset missing from package: ${installedRelPath}`);
      continue;
    }
    const files = statSync(sourcePath).isDirectory()
      ? walkFiles(sourcePath, installedRelPath)
      : [{ fullPath: sourcePath, relPath: installedRelPath }];
    for (const { fullPath, relPath } of files) {
      const targetPath = join(target, relPath);
      const content = readFileSync(fullPath, 'utf-8');
      if (!existsSync(targetPath)) {
        const coveredByLegacy = legacyCoveredPrefixes.some(
          prefix => relPath === prefix || relPath.startsWith(`${prefix}/`)
        );
        if (coveredByLegacy) {
          // The legacy rename exec delivers identical (ownership-proven)
          // content to this destination earlier in plan order.
          plan.actions.push({
            kind: 'skip',
            path: relPath,
            category: 'toolkit',
            ownership: 'agenticloop-owned',
            reason: 'covered by legacy canonical asset migration',
            display: relPath,
          });
          continue;
        }
        plan.actions.push({
          kind: 'create',
          path: relPath,
          category: 'toolkit',
          ownership: 'agenticloop-owned',
          reason: 'scaffold toolkit source',
          content,
          baseHash: null,
          display: relPath,
        });
      } else if (refreshAssets) {
        const current = readFileSync(targetPath, 'utf-8');
        if (current !== content) {
          plan.actions.push({
            kind: 'update',
            path: relPath,
            category: 'toolkit',
            ownership: 'agenticloop-owned',
            reason: 'refresh toolkit-owned asset',
            content,
            baseHash: hashContent(current),
            display: relPath,
          });
        } else {
          plan.actions.push({
            kind: 'skip',
            path: relPath,
            category: 'toolkit',
            ownership: 'agenticloop-owned',
            reason: 'toolkit asset already current',
            display: relPath,
          });
        }
      } else {
        plan.actions.push({
          kind: 'skip',
          path: relPath,
          category: 'toolkit',
          ownership: 'agenticloop-owned',
          reason: 'exists; refresh requires agenticloop update',
          display: relPath,
        });
      }
    }
  }
}

function planV2ConfigMigration(target, plan) {
  const configPath = join(target, 'agenticloop.json');
  if (!existsSync(configPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed.extends !== 'string') return;
  const normalized = parsed.extends.replace(/\\/g, '/').replace(/^\.\//, '');
  const v2Default = V2_BASE_CONFIG_RELATIVE_PATH.replace(/^\.\//, '');
  const v3Default = CONFIG_RELATIVE_PATH.replace(/^\.\//, '');
  if (normalized === v2Default) {
    parsed.extends = `./${v3Default}`;
    plan.actions.push({
      kind: 'update',
      path: 'agenticloop.json',
      category: 'config',
      ownership: 'target-owned',
      reason: 'migrate v2 extends path',
      content: JSON.stringify(parsed, null, 2) + '\n',
      baseHash: hashFileOrNull(configPath),
      display: `agenticloop.json: extends rewritten from ./agenticloop/base.json to ./${v3Default}`,
    });
  } else if (normalized !== v3Default && !existsSync(join(target, parsed.extends))) {
    plan.warnings.push(
      `agenticloop.json extends '${parsed.extends}' which does not exist. If this pointed at the old agenticloop/base.json, update it to ./agenticloop/config.json.`
    );
  }
}

function targetStatePath(relPath = '') {
  return relPath ? `${TARGET_STATE_DIRECTORY}/${relPath}` : TARGET_STATE_DIRECTORY;
}

function planMemoryScaffoldActions(target, plan) {
  const plannedDirs = new Set();
  const addDir = (relPath, display) => {
    if (plannedDirs.has(relPath)) return;
    plannedDirs.add(relPath);
    plan.actions.push({
      kind: 'create',
      path: relPath,
      category: 'state',
      ownership: 'target-owned',
      reason: 'scaffold target-state directory',
      directory: true,
      baseHash: null,
      display,
    });
  };

  const walk = (srcPath, relPath) => {
    if (!existsSync(srcPath)) {
      plan.blockers.push(
        `Source asset missing from package: ${relPath ? `${MEMORY_SCAFFOLD_RELATIVE_PATH}/${relPath}` : MEMORY_SCAFFOLD_RELATIVE_PATH}`
      );
      return;
    }
    for (const entry of readdirSync(srcPath).sort()) {
      const entrySrc = join(srcPath, entry);
      const childRel = relPath ? `${relPath}/${entry}` : entry;
      if (statSync(entrySrc).isDirectory()) {
        const destRel = targetStatePath(childRel);
        if (!existsSync(join(target, destRel))) {
          addDir(destRel, `${destRel}/`);
        }
        walk(entrySrc, childRel);
        continue;
      }
      if (entry === '.gitkeep') {
        const parentRel = targetStatePath(relPath);
        if (relPath && !existsSync(join(target, parentRel)) && !plannedDirs.has(parentRel)) {
          addDir(parentRel, `${parentRel}/`);
        }
        continue;
      }
      const destRel = targetStatePath(childRel);
      const destFull = join(target, destRel);
      if (existsSync(destFull)) {
        plan.actions.push({
          kind: 'skip',
          path: destRel,
          category: 'state',
          ownership: 'target-owned',
          reason: 'target-owned state exists; never overwritten',
          display: destRel,
        });
      } else {
        plan.actions.push({
          kind: 'create',
          path: destRel,
          category: 'state',
          ownership: 'target-owned',
          reason: 'instantiate target-state scaffold',
          content: readFileSync(entrySrc, 'utf-8'),
          baseHash: null,
          display: destRel,
        });
      }
    }
  };

  walk(MEMORY_SCAFFOLD, '');
}

function planAdapterConfigActions(target, selectedAdapter, plan) {
  const configRel = 'agenticloop.json';
  const configPath = join(target, configRel);
  let plannedCreate = false;
  if (!existsSync(configPath)) {
    if (!existsSync(TARGET_CFG_TEMPLATE)) {
      plan.blockers.push(`Source asset missing from package: ${TARGET_CONFIG_TEMPLATE_RELATIVE_PATH}`);
      return null;
    }
    const configWillBeScaffolded = existsSync(join(target, CONFIG_RELATIVE_PATH)) ||
      plan.actions.some(action => action.path === CONFIG_RELATIVE_PATH && action.kind === 'create');
    if (!configWillBeScaffolded) {
      plan.blockers.push(`Cannot create agenticloop.json: ${CONFIG_RELATIVE_PATH} was not scaffolded`);
      return null;
    }
    try {
      const content = renderTargetConfigForAdapter(selectedAdapter);
      plan.actions.push({
        kind: 'create',
        path: configRel,
        category: 'config',
        ownership: 'target-owned',
        reason: `create adapter config for ${selectedAdapter}`,
        content,
        baseHash: null,
        display: configRel,
      });
      plannedCreate = true;
    } catch (error) {
      plan.blockers.push(error.message);
      return null;
    }
  } else {
    plan.actions.push({
      kind: 'skip',
      path: configRel,
      category: 'config',
      ownership: 'target-owned',
      reason: 'adapter config exists; never overwritten',
      display: configRel,
    });

    // An explicit Codex selection adopts only missing target-owned fields.
    if (selectedAdapter === 'codex' || selectedAdapter === 'all') {
      try {
        const config = loadJsonFile(configPath);
        const { added } = ensureAdapterRoleSettings(config, 'codex');
        if (added.length > 0) {
          plan.actions.push({
            kind: 'update',
            path: configRel,
            category: 'config',
            ownership: 'target-owned',
            reason: 'adopt missing Codex role defaults',
            content: JSON.stringify(config, null, 2) + '\n',
            baseHash: hashFileOrNull(configPath),
            display: configRel,
          });
        }
      } catch (error) {
        plan.blockers.push(`Cannot apply Codex role defaults: ${error.message}`);
        return null;
      }
    }
  }
  return plannedCreate;
}

function plannedConfigText(target, plan) {
  const configPath = join(target, 'agenticloop.json');
  const planned = plan.actions.find(action => action.path === 'agenticloop.json' && (action.kind === 'create' || action.kind === 'update'));
  if (planned) return planned.content;
  if (existsSync(configPath)) return readFileSync(configPath, 'utf-8');
  return null;
}

/**
 * Resolve an agenticloop.json document with extends, preferring planned
 * action content over on-disk files so no-write planning works on a target
 * whose toolkit source does not exist yet.
 */
export function resolvePlannedConfig(target, plan, configText, referencePath, visited = new Set()) {  if (visited.has(referencePath)) {
    throw new Error(`Circular extends chain detected at ${referencePath}`);
  }
  visited.add(referencePath);
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    throw new Error(`Failed to load config at ${referencePath}: ${error.message}`);
  }
  if (typeof parsed?.extends !== 'string') return parsed;
  const extendsRel = parsed.extends.replace(/\\/g, '/').replace(/^\.\//, '');
  const planned = plan.actions.find(
    action => action.path === extendsRel && (action.kind === 'create' || action.kind === 'update')
  );
  const extendsPath = join(target, extendsRel);
  let baseText;
  if (planned) {
    baseText = planned.content;
  } else if (existsSync(extendsPath)) {
    baseText = readFileSync(extendsPath, 'utf-8');
  } else {
    throw new Error(
      `Cannot resolve extends "${parsed.extends}" from ${referencePath}: ${extendsRel} is not available`
    );
  }
  const base = resolvePlannedConfig(target, plan, baseText, extendsPath, visited);
  const merged = deepMerge(base, parsed);
  delete merged.extends;
  return merged;
}

function planAdapterGroup(target, selectedAdapter, plan) {
  const configText = plannedConfigText(target, plan);
  if (configText === null) {
    plan.blockers.push('Cannot generate adapter output: agenticloop.json not found after init');
    return;
  }
  let alConfig;
  try {
    alConfig = resolvePlannedConfig(target, plan, configText, join(target, 'agenticloop.json'));
  } catch (error) {
    plan.blockers.push(`Cannot generate adapter output: ${error.message}`);
    return;
  }
  const toolkitAssetsChange = plan.actions.some(action =>
    action.category === 'toolkit'
    && (action.kind === 'create' || action.kind === 'update')
  );
  // Init is planned as one atomic transaction. On a fresh install or asset
  // refresh, the canonical role files exist only as pending toolkit actions
  // when adapter output is rendered. Read those exact bundled assets instead
  // of the not-yet-updated target so generated prompts match the state that
  // validation sees after the transaction commits.
  const assetSourceRoot = toolkitAssetsChange
    ? dirname(bundledToolkitPath(CONFIG_RELATIVE_PATH))
    : target;
  const planned = planAdapterArtifacts({
    target,
    assetSourceRoot,
    alConfig,
    adapter: selectedAdapter,
  });
  if (!planned.ok) {
    plan.blockers.push(...planned.errors);
    return;
  }
  plan.adapterGroups.push({
    adapters: planned.adapters,
    outputRoot: planned.plan.outputRoot,
    actions: planned.plan.actions,
    files: planned.plan.files,
    blocked: planned.preflight.blocked.map(item => ({ relPath: item.relPath, message: item.message })),
  });
}

function planGitignoreActions(target, plan) {
  const gitignorePath = join(target, '.gitignore');
  const existed = existsSync(gitignorePath);
  let content = existed ? readFileSync(gitignorePath, 'utf-8') : '';
  const added = [];
  for (const { dir, patterns } of MANAGED_GITIGNORE_ENTRIES) {
    const lines = content.split('\n').map(line => line.trim());
    if (lines.some(line => patterns.includes(line))) continue;
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    content += `${prefix}${dir}/\n`;
    added.push(`${dir}/`);
  }
  if (added.length === 0) return;
  const summary = added.join(', ');
  plan.actions.push({
    kind: existed ? 'merge' : 'create',
    path: '.gitignore',
    category: 'gitignore',
    ownership: 'shared',
    reason: 'gitignore Agentic Loop scratch, worktree, and operator activation directories',
    content,
    baseHash: existed ? hashFileOrNull(gitignorePath) : null,
    display: existed ? `.gitignore (${summary} appended)` : `.gitignore (created with ${summary})`,
  });
}

/**
 * Plan the activation-guidance action for init. The guidance mutation is part
 * of the lifecycle plan (never a post-init side effect), so `--dry-run --json`
 * includes the AGENTS.md action and normal init performs no plan-absent
 * mutation. Enrollment rules match the historical post-init behavior: a fresh
 * target gets the block by default, an existing installation is refreshed only
 * when its prior block is manifest-owned (no silent enrollment), and a
 * malformed agenticloop.json fails the plan exactly as it failed the apply.
 */
function planGuidanceActions(target, plan) {
  const installationExisted = existsSync(join(target, INSTALLED_TOOLKIT_ROOT_DIRECTORY)) ||
    existsSync(join(target, TARGET_STATE_DIRECTORY, 'project.md')) ||
    existsSync(join(target, TARGET_STATE_DIRECTORY, 'generated-artifacts.json'));
  const { config, error: configError } = loadGuidanceAlConfig(target);
  if (configError) {
    plan.blockers.push(configError);
    return;
  }
  if (!installationExisted) {
    plan.actions.push(guidanceLifecycleAction({ installationExisted: false }));
    return;
  }
  // No silent enrollment: an existing installation is refreshed only when its
  // prior block is manifest-owned.
  const status = checkGuidance(target, { alConfig: config });
  if (status.owned !== true) return;
  if (status.status === 'current') {
    // Already current: keep the plan idempotent (zero mutations on rerun).
    plan.actions.push({
      kind: 'skip',
      path: 'AGENTS.md',
      category: 'guidance',
      ownership: 'shared',
      reason: 'activation guidance already current',
      display: 'AGENTS.md (activation guidance current)',
    });
    return;
  }
  plan.actions.push(guidanceLifecycleAction({ installationExisted: true }));
}

/**
 * Compute the idempotent init lifecycle plan. Pure: reads only.
 *
 * @param {Object} options
 * @param {string} options.target
 * @param {string|null} [options.adapter]
 * @param {boolean} [options.refreshAssets]
 * @param {boolean} [options.agentsGuidance]  Plan the activation-guidance action (default true).
 * @returns {import('./lifecycle-plan.js').LifecyclePlan}
 */
export function planInit({ target, adapter = null, refreshAssets = false, agentsGuidance = true }) {
  const plan = createPlan('init');

  if (isPackageSourceRepositoryRoot(target)) {
    plan.blockers.push(
      `Refusing to mutate the Agentic Loop package source repository at ${target}. Use --target to point at a downstream project directory.`
    );
    return plan;
  }

  planLegacyAssetActions(target, plan);
  const legacyCoveredPrefixes = plan.actions
    .filter(action => action.exec?.type === 'rename' && action.category === 'legacy')
    .map(action => action.path);
  planToolkitSourceActions(target, refreshAssets, plan, legacyCoveredPrefixes);
  if (refreshAssets) {
    planV2ConfigMigration(target, plan);
  }
  planMemoryScaffoldActions(target, plan);

  if (adapter) {
    planAdapterConfigActions(target, adapter, plan);
    if (plan.blockers.length === 0) {
      planAdapterGroup(target, adapter, plan);
    }
  }

  planGitignoreActions(target, plan);
  if (agentsGuidance) {
    planGuidanceActions(target, plan);
  }
  return plan;
}
