/**
 * Adapter config reconciliation helpers.
 *
 * Guided setup plans adapter config and generation through the pure lifecycle
 * planners (src/setup-plan.js); this module retains the shared non-destructive
 * agenticloop.json reconciliation used by update and direct-init flows.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import {
  ensureAdapterRoleSettings,
  getDefaultRoleSettings,
  reconcileAdapterRoleSettings,
} from './adapter-role-defaults.js';
import {
  CONFIG_RELATIVE_PATH,
  TARGET_CONFIG_TEMPLATE_RELATIVE_PATH,
  bundledToolkitPath,
} from './layout.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

const TARGET_CFG_TEMPLATE = bundledToolkitPath(TARGET_CONFIG_TEMPLATE_RELATIVE_PATH);

function renderAdapterEntry(host, indent = '    ') {
  const entry = JSON.stringify({ roleSettings: getDefaultRoleSettings(host) }, null, 2)
    .replace(/\n/g, `\n${indent}`);
  return `${indent}"${host}": ${entry}`;
}

function renderTargetConfigForAdapter(selectedAdapter) {
  const template = readFileSync(TARGET_CFG_TEMPLATE, 'utf-8');
  const hosts = selectedAdapter === 'all' ? IMPLEMENTED_ADAPTERS : [selectedAdapter];
  const entries = hosts.map(host => renderAdapterEntry(host)).join(',\n');
  const adapterBlockPattern = /  "adapters": \{[\s\S]*?\r?\n  \}\r?\n\}\s*$/;
  if (!adapterBlockPattern.test(template)) {
    throw new Error('Could not render selected adapter into target config template');
  }
  return template.replace(
    adapterBlockPattern,
    `  "adapters": {\n${entries}\n  }\n}\n`
  );
}

/**
 * Reconcile an existing target-owned agenticloop.json against the current
 * canonical role set for the selected adapter hosts. Non-destructive: adds
 * only missing adapter blocks, roleSettings maps, and per-role slots ({});
 * preserves every existing setting and unknown field. Idempotent.
 *
 * @param {string} target  Target directory containing agenticloop.json.
 * @param {string[]} hosts  Adapter hosts to reconcile.
 * @returns {{added: string[], preserved: string[], wrote: boolean, error: string|null}}
 */
export function reconcileTargetAdapterConfig(target, hosts) {
  const targetConfigPath = join(target, 'agenticloop.json');
  if (!existsSync(targetConfigPath)) {
    return { added: [], preserved: [], wrote: false, error: 'agenticloop.json not found' };
  }
  try {
    const rawConfig = loadJsonFile(targetConfigPath);
    const effectiveConfig = loadAgenticLoopConfig(targetConfigPath);
    const canonicalRoles = Object.keys(effectiveConfig.roles ?? {});
    const { added, preserved } = reconcileAdapterRoleSettings(rawConfig, hosts, canonicalRoles);
    if (added.length > 0) {
      writeFileSync(targetConfigPath, JSON.stringify(rawConfig, null, 2) + '\n', 'utf-8');
      return { added, preserved, wrote: true, error: null };
    }
    return { added, preserved, wrote: false, error: null };
  } catch (error) {
    return { added: [], preserved: [], wrote: false, error: `Cannot reconcile adapter configuration: ${error.message}` };
  }
}

/**
 * Create agenticloop.json with adapter entry but no generated artifacts.
 * An existing agenticloop.json is reconciled non-destructively against the
 * current canonical roles for the selected adapter(s).
 *
 * @param {string} target  Target directory (must have agenticloop/config.json).
 * @param {string} adapter  Adapter host name or 'all'.
 * @returns {string|null} Error message, or null on success.
 */
export function ensureAdapterConfig(target, adapter) {
  const targetConfigPath = join(target, 'agenticloop.json');
  if (existsSync(targetConfigPath)) {
    const hosts = adapter === 'all' ? IMPLEMENTED_ADAPTERS : [adapter];
    const reconciliation = reconcileTargetAdapterConfig(target, hosts);
    if (reconciliation.error) return reconciliation.error;
    if (adapter === 'codex' || adapter === 'all') {
      try {
        const config = loadJsonFile(targetConfigPath);
        const { added } = ensureAdapterRoleSettings(config, 'codex');
        if (added.length > 0) {
          writeFileSync(targetConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        }
        return null;
      } catch (error) {
        return `Cannot apply Codex role defaults: ${error.message}`;
      }
    }
    return null;
  }
  if (!existsSync(TARGET_CFG_TEMPLATE)) {
    return `Source asset missing from package: ${TARGET_CONFIG_TEMPLATE_RELATIVE_PATH}`;
  }
  if (!existsSync(join(target, CONFIG_RELATIVE_PATH))) {
    return `Cannot create agenticloop.json: ${CONFIG_RELATIVE_PATH} was not scaffolded`;
  }
  writeFileSync(targetConfigPath, renderTargetConfigForAdapter(adapter), 'utf-8');
  return null;
}
