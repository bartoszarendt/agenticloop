/**
 * Pure, no-write setup planner.
 *
 * Composes one repair-aware lifecycle plan for guided setup: the idempotent
 * init scaffold plan (always, even when a current layout manifest exists),
 * human-confirmed project-map merges, event-logging choice, adapter config
 * creation/reconciliation with model mutations folded in, adapter artifact
 * generation from the canonical adapter planners, and activation guidance.
 * The planner reads target state but never writes; setup renders the composed
 * plan, asks once before the first mutation, and applies it through the
 * generic lifecycle apply path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFileOrNull } from './lifecycle-plan.js';
import { planInit, renderTargetConfigForAdapter, resolvePlannedConfig } from './init-plan.js';
import { planAdapterArtifacts } from './adapter-generation.js';
import { guidanceLifecycleAction } from './guidance.js';
import { applyModelMutations } from './configure-models.js';
import {
  ensureAdapterRoleSettings,
  reconcileAdapterRoleSettings,
} from './adapter-role-defaults.js';
import { loadJsonFile } from './json.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  CONFIG_RELATIVE_PATH,
  PROJECT_MAP_RELATIVE_PATH,
  TARGET_CONFIG_TEMPLATE_RELATIVE_PATH,
  bundledToolkitPath,
} from './layout.js';
import { WORKFLOW_ROLE_IDS } from './workflow-roles.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
const TARGET_CFG_TEMPLATE = bundledToolkitPath(TARGET_CONFIG_TEMPLATE_RELATIVE_PATH);

function adapterHosts(selectedAdapter) {
  return selectedAdapter === 'all' ? IMPLEMENTED_ADAPTERS : [selectedAdapter];
}

function projectMapAction(target, values, reason) {
  const fullPath = join(target, PROJECT_MAP_RELATIVE_PATH);
  return {
    kind: 'merge',
    path: PROJECT_MAP_RELATIVE_PATH,
    category: 'state',
    ownership: 'target-owned',
    reason,
    baseHash: hashFileOrNull(fullPath),
    display: `.agenticloop/project.md (${reason})`,
    exec: { type: 'project-map', values },
  };
}

/**
 * Compute the setup adapter-config action (create or update) with model
 * mutations folded in, returning the planned raw config object.
 */
function planAdapterConfigAction(target, selectedAdapter, modelMutationsByHost, plan) {
  const configRel = 'agenticloop.json';
  const configPath = join(target, configRel);
  const hosts = adapterHosts(selectedAdapter);

  let rawConfig;
  let kind;
  let originalText = null;
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
      rawConfig = JSON.parse(renderTargetConfigForAdapter(selectedAdapter));
    } catch (error) {
      plan.blockers.push(error.message);
      return null;
    }
    kind = 'create';
  } else {
    originalText = readFileSync(configPath, 'utf-8');
    try {
      rawConfig = loadJsonFile(configPath);
    } catch (error) {
      plan.blockers.push(`Failed to parse agenticloop.json: ${error.message}`);
      return null;
    }
    kind = 'update';
  }

  const changed = [];
  // Non-destructive reconcile against the canonical role set (for example,
  // adding a missing auditor slot) for existing configs.
  if (kind === 'update') {
    try {
      const effectiveConfig = resolvePlannedConfig(target, plan, originalText, configPath);
      const canonicalRoles = WORKFLOW_ROLE_IDS;
      const { added } = reconcileAdapterRoleSettings(rawConfig, hosts, canonicalRoles);
      changed.push(...added);
    } catch (error) {
      plan.blockers.push(`Cannot reconcile adapter configuration: ${error.message}`);
      return null;
    }
    if (selectedAdapter === 'codex' || selectedAdapter === 'all') {
      try {
        const { added } = ensureAdapterRoleSettings(rawConfig, 'codex');
        changed.push(...added);
      } catch (error) {
        plan.blockers.push(`Cannot apply Codex role defaults: ${error.message}`);
        return null;
      }
    }
  }

  for (const host of hosts) {
    const mutations = modelMutationsByHost?.[host] ?? [];
    if (mutations.length === 0) continue;
    const applied = applyModelMutations(rawConfig, host, mutations);
    changed.push(...applied.updated);
    plan.warnings.push(...applied.warnings);
  }

  const content = JSON.stringify(rawConfig, null, 2) + '\n';
  if (kind === 'update' && content === originalText) {
    plan.actions.push({
      kind: 'skip',
      path: configRel,
      category: 'config',
      ownership: 'target-owned',
      reason: 'adapter config already current',
      display: configRel,
    });
  } else {
    plan.actions.push({
      kind,
      path: configRel,
      category: 'config',
      ownership: 'target-owned',
      reason: kind === 'create'
        ? `create adapter config for ${selectedAdapter}`
        : `reconcile adapter config and model settings (${changed.length} change(s))`,
      content,
      baseHash: kind === 'update' ? hashFileOrNull(configPath) : null,
      display: configRel,
    });
  }
  return rawConfig;
}

/**
 * Compose the repair-aware setup plan.
 *
 * @param {Object} options
 * @param {string} options.target
 * @param {string|null} [options.adapter]           Selected adapter host (or 'all').
 * @param {Object|null} [options.profileValues]     Confirmed project-map values to merge.
 * @param {string|null} [options.profileReason]     Display reason for the profile merge.
 * @param {'enabled'|'disabled'|null} [options.eventLogging]  Chosen event-logging value.
 * @param {Object<string, Array>} [options.modelMutationsByHost]  Model mutations per host.
 * @param {boolean} [options.agentsGuidance]
 * @param {boolean} [options.installationExisted]
 * @param {boolean} [options.guidanceEnrollable]    Prior guidance block is manifest-owned.
 * @returns {import('./lifecycle-plan.js').LifecyclePlan}
 */
export function planSetup(options) {
  const {
    target,
    adapter = null,
    profileValues = null,
    profileReason = 'human-confirmed profile values',
    eventLogging = null,
    modelMutationsByHost = null,
    agentsGuidance = true,
    installationExisted = false,
    guidanceEnrollable = false,
  } = options;

  // Setup always composes the idempotent init scaffold plan, including when a
  // current layout manifest exists; this is what makes setup repair-aware for
  // empty, current, legacy, partial, and inverse-partial targets. Guidance is
  // excluded here: setup plans its own guidance action below with the
  // enrollment state it computed from the pre-setup target.
  const plan = planInit({ target, adapter: null, refreshAssets: false, agentsGuidance: false });
  plan.command = 'setup';

  if (profileValues && Object.keys(profileValues).length > 0) {
    if (!existsSync(join(target, PROJECT_MAP_RELATIVE_PATH)) &&
        !plan.actions.some(a => a.path === PROJECT_MAP_RELATIVE_PATH && a.kind === 'create')) {
      plan.blockers.push('.agenticloop/project.md not found. Run agenticloop init first.');
    } else {
      plan.actions.push(projectMapAction(target, profileValues, profileReason));
    }
  }

  if (eventLogging) {
    const projectMapPath = join(target, PROJECT_MAP_RELATIVE_PATH);
    let rawEventLogging = null;
    if (existsSync(projectMapPath)) {
      const [fm] = parseFrontmatter(readFileSync(projectMapPath, 'utf-8'));
      rawEventLogging = fm?.event_logging ?? null;
    }
    if (rawEventLogging !== eventLogging) {
      plan.actions.push(projectMapAction(target, { event_logging: eventLogging }, `event_logging: ${eventLogging}`));
    }
  }

  if (adapter) {
    const rawConfig = planAdapterConfigAction(target, adapter, modelMutationsByHost, plan);
    if (rawConfig && plan.blockers.length === 0) {
      let effectiveConfig;
      try {
        effectiveConfig = resolvePlannedConfig(
          target,
          plan,
          JSON.stringify(rawConfig, null, 2) + '\n',
          join(target, 'agenticloop.json')
        );
      } catch (error) {
        plan.blockers.push(`Cannot generate adapter output: ${error.message}`);
        effectiveConfig = null;
      }
      if (effectiveConfig) {
        const planned = planAdapterArtifacts({ target, alConfig: effectiveConfig, adapter });
        if (!planned.ok) {
          plan.blockers.push(...planned.errors);
        } else {
          plan.adapterGroups.push({
            adapters: planned.adapters,
            outputRoot: planned.plan.outputRoot,
            actions: planned.plan.actions,
            files: planned.plan.files,
            blocked: planned.preflight.blocked.map(item => ({ relPath: item.relPath, message: item.message })),
          });
        }
      }
    }
  }

  if (agentsGuidance && (!installationExisted || guidanceEnrollable)) {
    plan.actions.push(guidanceLifecycleAction({ installationExisted }));
  }

  return plan;
}
