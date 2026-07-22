/**
 * Adapter artifact generation for setup flow.
 *
 * Generates artifacts after all choices are confirmed, avoiding
 * the generate-then-regenerate behavior of init --setup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import { generateAdapterArtifacts } from './adapter-generation.js';
import { ensureAdapterRoleSettings, getDefaultRoleSettings } from './adapter-role-defaults.js';
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
 * Create agenticloop.json with adapter entry but no generated artifacts.
 *
 * @param {string} target  Target directory (must have agenticloop/config.json).
 * @param {string} adapter  Adapter host name or 'all'.
 * @returns {string|null} Error message, or null on success.
 */
export function ensureAdapterConfig(target, adapter) {
  const targetConfigPath = join(target, 'agenticloop.json');
  if (existsSync(targetConfigPath)) {
    if (adapter !== 'codex' && adapter !== 'all') return null;
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
  if (!existsSync(TARGET_CFG_TEMPLATE)) {
    return `Source asset missing from package: ${TARGET_CONFIG_TEMPLATE_RELATIVE_PATH}`;
  }
  if (!existsSync(join(target, CONFIG_RELATIVE_PATH))) {
    return `Cannot create agenticloop.json: ${CONFIG_RELATIVE_PATH} was not scaffolded`;
  }
  writeFileSync(targetConfigPath, renderTargetConfigForAdapter(adapter), 'utf-8');
  return null;
}

/**
 * Generate adapter artifacts for the selected adapter(s) through the
 * transactional generation service.
 *
 * @param {string} target  Target directory.
 * @param {string} adapter  Adapter host or 'all'.
 * @returns {{files: string[], errors: string[]}}
 */
export async function generateAdapters(target, adapter) {
  const cfgPath = join(target, 'agenticloop.json');
  if (!existsSync(cfgPath)) {
    return { files: [], errors: ['agenticloop.json not found; cannot generate adapter artifacts.'] };
  }

  let alConfig;
  try {
    alConfig = loadAgenticLoopConfig(cfgPath);
  } catch (e) {
    return { files: [], errors: [`Failed to parse agenticloop.json: ${e.message}`] };
  }

  const result = generateAdapterArtifacts({
    target,
    alConfig,
    adapter,
  });

  return {
    files: result.ok ? result.files : [],
    errors: result.errors,
  };
}
