/**
 * Adapter artifact generation for setup flow.
 *
 * Generates artifacts after all choices are confirmed, avoiding
 * the generate-then-regenerate behavior of init --setup.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgenticLoopConfig } from './json.js';
import { generateOpencodeArtifacts } from './adapters/opencode.js';
import { generateCodexArtifacts } from './adapters/codex.js';
import { generateClaudeCodeArtifacts } from './adapters/claude-code.js';
import { generateCopilotArtifacts } from './adapters/copilot.js';
import { generateCursorArtifacts } from './adapters/cursor.js';
import { validateSharedAgenticLoopPluginCompatibility } from './adapter-plugin-compatibility.js';
import {
  CONFIG_RELATIVE_PATH,
  TARGET_CONFIG_TEMPLATE_RELATIVE_PATH,
  bundledToolkitPath,
} from './layout.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

const TARGET_CFG_TEMPLATE = bundledToolkitPath(TARGET_CONFIG_TEMPLATE_RELATIVE_PATH);

function renderAdapterEntry(host, indent = '    ') {
  return [
    `${indent}"${host}": {`,
    `${indent}  "roleSettings": {}`,
    `${indent}}`,
  ].join('\n');
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
  if (existsSync(targetConfigPath)) return null;
  if (!existsSync(TARGET_CFG_TEMPLATE)) {
    return `Source asset missing from package: ${TARGET_CONFIG_TEMPLATE_RELATIVE_PATH}`;
  }
  if (!existsSync(join(target, CONFIG_RELATIVE_PATH))) {
    return `Cannot create agenticloop.json: ${CONFIG_RELATIVE_PATH} was not scaffolded`;
  }
  writeFileSync(targetConfigPath, renderTargetConfigForAdapter(adapter), 'utf-8');
  return null;
}

const GENERATORS = {
  opencode: generateOpencodeArtifacts,
  codex: generateCodexArtifacts,
  'claude-code': generateClaudeCodeArtifacts,
  copilot: generateCopilotArtifacts,
  cursor: generateCursorArtifacts,
};

/**
 * Generate adapter artifacts for the selected adapter(s).
 *
 * @param {string} target  Target directory.
 * @param {string} adapter  Adapter host or 'all'.
 * @returns {Promise<{files: string[], errors: string[]}>}
 */
export async function generateAdapters(target, adapter) {
  const files = [];
  const errors = [];

  const cfgPath = join(target, 'agenticloop.json');
  if (!existsSync(cfgPath)) {
    errors.push('agenticloop.json not found; cannot generate adapter artifacts.');
    return { files, errors };
  }

  let alConfig;
  try {
    alConfig = loadAgenticLoopConfig(cfgPath);
  } catch (e) {
    errors.push(`Failed to parse agenticloop.json: ${e.message}`);
    return { files, errors };
  }

  const hosts = adapter === 'all' ? IMPLEMENTED_ADAPTERS : [adapter];

  for (const host of hosts) {
    if (host === 'codex' || host === 'cursor' || adapter === 'all') {
      const preflightErrors = validateSharedAgenticLoopPluginCompatibility(alConfig);
      if (preflightErrors.length > 0) {
        errors.push(...preflightErrors);
        continue;
      }
    }

    const generator = GENERATORS[host];
    if (!generator) {
      errors.push(`No generator for adapter: ${host}`);
      continue;
    }

    try {
      const result = generator(alConfig, target, target);
      files.push(...result.files);
    } catch (e) {
      errors.push(`Failed to generate ${host} artifacts: ${e.message}`);
    }
  }

  return { files, errors };
}
