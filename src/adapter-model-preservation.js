/**
 * Preserve target-local model choices before refreshing generated adapters.
 *
 * `agenticloop update` regenerates host artifacts from canonical sources. If a
 * target project edited generated artifacts directly before moving those model
 * choices into agenticloop.json, this helper backfills missing adapter-local
 * role settings so regeneration does not silently replace them with defaults.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import {
  CODEX_SUPPORTED_REASONING_EFFORTS,
  normalizeCodexModel,
} from './codex-models.js';
import {
  resolveOpencodeAgentPath,
} from './adapters/opencode.js';
import { resolveCopilotAgentPath } from './adapters/copilot.js';
import { resolveCursorAgentPath } from './adapters/cursor.js';
import { WORKFLOW_ROLE_IDS } from './workflow-roles.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

function expandAdapters(adapters) {
  if (!adapters || adapters.length === 0) return [];
  if (adapters.includes('all')) return IMPLEMENTED_ADAPTERS;
  return [...new Set(adapters)];
}

function agentNameForRole(adapterCfg, roleName) {
  return adapterCfg?.roleBindings?.[roleName]?.agent ?? roleName;
}

function usefulString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function usefulReasoningSetting(value) {
  return usefulString(value);
}

function usefulCodexReasoningSetting(value) {
  if (!usefulString(value)) return false;
  return CODEX_SUPPORTED_REASONING_EFFORTS.has(value.trim());
}

function parseTomlString(rawValue) {
  const raw = rawValue.trim();
  if (!raw) return '';
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
    }
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, raw.endsWith("'") ? -1 : undefined);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

function readTomlField(text, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = text.match(pattern);
  return match ? parseTomlString(match[1]) : '';
}

function extractOpenCodeSettings(target, alConfig) {
  const settings = {};
  const warnings = [];

  for (const roleName of WORKFLOW_ROLE_IDS) {
    const agentPath = resolveOpencodeAgentPath(target, roleName);
    if (!existsSync(agentPath)) continue;

    let fm;
    try {
      [fm] = parseFrontmatter(readFileSync(agentPath, 'utf-8'));
    } catch (error) {
      warnings.push(`Could not inspect ${join('.opencode', 'agents', `${roleName}.md`)} for model preservation: ${error.message}`);
      continue;
    }
    if (!fm) continue;

    settings[roleName] = {
      model: usefulString(fm.model) ? fm.model : undefined,
      reasoningEffort: usefulReasoningSetting(fm.variant) ? fm.variant : undefined,
    };
  }
  return { settings, warnings };
}

function extractCodexSettings(target, alConfig) {
  const adapterCfg = alConfig.adapters?.codex ?? {};
  const settings = {};
  const warnings = [];

  for (const roleName of WORKFLOW_ROLE_IDS) {
    const agentName = agentNameForRole(adapterCfg, roleName);
    const tomlPath = join(target, '.codex', 'agents', `${agentName}.toml`);
    if (!existsSync(tomlPath)) continue;

    let text;
    try {
      text = readFileSync(tomlPath, 'utf-8');
    } catch (error) {
      warnings.push(`Could not inspect .codex/agents/${agentName}.toml for model preservation: ${error.message}`);
      continue;
    }

    const model = readTomlField(text, 'model');
    const effort = readTomlField(text, 'model_reasoning_effort');
    if (usefulString(effort) && !usefulCodexReasoningSetting(effort)) {
      warnings.push(
        `Ignoring unsupported Codex model_reasoning_effort '${effort}' in .codex/agents/${agentName}.toml while preserving model settings`
      );
    }
    settings[roleName] = {
      model: usefulString(model) ? normalizeCodexModel(model) : undefined,
      reasoningEffort: usefulCodexReasoningSetting(effort) ? effort : undefined,
    };
  }

  return { settings, warnings };
}

function extractClaudeCodeSettings(target, alConfig) {
  const adapterCfg = alConfig.adapters?.['claude-code'] ?? {};
  const settings = {};
  const warnings = [];

  for (const roleName of WORKFLOW_ROLE_IDS) {
    const agentName = agentNameForRole(adapterCfg, roleName);
    const mdPath = join(target, '.claude', 'agents', `${agentName}.md`);
    if (!existsSync(mdPath)) continue;

    let fm;
    try {
      [fm] = parseFrontmatter(readFileSync(mdPath, 'utf-8'));
    } catch (error) {
      warnings.push(`Could not inspect .claude/agents/${agentName}.md for model preservation: ${error.message}`);
      continue;
    }
    if (!fm) continue;

    // Claude Code agent frontmatter may also carry permissionMode, but model is
    // the only setting preserved here. Effort is not rendered.
    settings[roleName] = {
      model: usefulString(fm.model) ? fm.model : undefined,
      reasoningEffort: undefined,
    };
  }

  return { settings, warnings };
}

function extractCopilotSettings(target, alConfig) {
  const adapterCfg = alConfig.adapters?.copilot ?? {};
  const settings = {};
  const warnings = [];

  for (const roleName of WORKFLOW_ROLE_IDS) {
    const agentName = agentNameForRole(adapterCfg, roleName);
    const mdPath = resolveCopilotAgentPath(target, agentName);
    if (!existsSync(mdPath)) continue;

    let fm;
    try {
      [fm] = parseFrontmatter(readFileSync(mdPath, 'utf-8'));
    } catch (error) {
      warnings.push(`Could not inspect .github/agents/${agentName}.agent.md for model preservation: ${error.message}`);
      continue;
    }
    if (!fm) continue;

    settings[roleName] = {
      model: usefulString(fm.model) ? fm.model : undefined,
      reasoningEffort: undefined,
    };
  }

  return { settings, warnings };
}

function extractCursorSettings(target, alConfig) {
  const adapterCfg = alConfig.adapters?.cursor ?? {};
  const settings = {};
  const warnings = [];

  for (const roleName of WORKFLOW_ROLE_IDS) {
    const agentName = agentNameForRole(adapterCfg, roleName);
    const mdPath = resolveCursorAgentPath(target, agentName);
    if (!existsSync(mdPath)) continue;

    let fm;
    try {
      [fm] = parseFrontmatter(readFileSync(mdPath, 'utf-8'));
    } catch (error) {
      warnings.push(`Could not inspect .cursor/agents/${agentName}.md for model preservation: ${error.message}`);
      continue;
    }
    if (!fm) continue;

    const model = usefulString(fm.model) && fm.model !== 'inherit' ? fm.model : undefined;
    settings[roleName] = {
      model,
      reasoningEffort: undefined,
    };
  }

  return { settings, warnings };
}

function extractSettings(host, target, alConfig) {
  if (host === 'opencode') return extractOpenCodeSettings(target, alConfig);
  if (host === 'codex') return extractCodexSettings(target, alConfig);
  if (host === 'claude-code') return extractClaudeCodeSettings(target, alConfig);
  if (host === 'copilot') return extractCopilotSettings(target, alConfig);
  if (host === 'cursor') return extractCursorSettings(target, alConfig);
  return { settings: {}, warnings: [] };
}

function shouldFill(existingValue) {
  return existingValue === undefined || existingValue === '';
}

function ensureRoleSettings(targetConfig, host, roleName) {
  targetConfig.adapters ??= {};
  targetConfig.adapters[host] ??= {};
  targetConfig.adapters[host].roleSettings ??= {};
  targetConfig.adapters[host].roleSettings[roleName] ??= {};
  return targetConfig.adapters[host].roleSettings[roleName];
}

function effectiveConfiguredReasoningSetting(roleSettings) {
  return roleSettings.reasoningEffort ?? roleSettings.variant;
}

function sourceArtifactFor(host, target, alConfig, roleName) {
  const adapterCfg = alConfig.adapters?.[host] ?? {};
  const agentName = agentNameForRole(adapterCfg, roleName);
  let path;
  if (host === 'opencode') path = resolveOpencodeAgentPath(target, roleName);
  else if (host === 'codex') path = join(target, '.codex', 'agents', `${agentName}.toml`);
  else if (host === 'claude-code') path = join(target, '.claude', 'agents', `${agentName}.md`);
  else if (host === 'copilot') path = resolveCopilotAgentPath(target, agentName);
  else path = resolveCursorAgentPath(target, agentName);
  return relative(target, path).replaceAll('\\', '/');
}

/**
 * Backfill missing target-owned model settings from existing generated adapter
 * artifacts.
 *
 * @param {string} target
 * @param {string[]} adapters  Adapter targets, with optional "all".
 * @param {{write?: boolean}} [options]
 * @returns {{ updated: string[], warnings: string[], errors: string[], config?: object, content?: string }}
 */
export function preserveExistingAdapterModelSettings(target, adapters, options = {}) {
  const hosts = expandAdapters(adapters);
  const updated = [];
  const imports = [];
  const warnings = [];
  const errors = [];
  if (hosts.length === 0) return { updated, imports, warnings, errors };

  const cfgPath = join(target, 'agenticloop.json');
  if (!existsSync(cfgPath)) return { updated, imports, warnings, errors };

  let targetConfig;
  let alConfig;
  try {
    targetConfig = loadJsonFile(cfgPath);
    alConfig = loadAgenticLoopConfig(cfgPath);
  } catch (error) {
    errors.push(`Cannot preserve adapter model settings: ${error.message}`);
    return { updated, imports, warnings, errors };
  }

  for (const host of hosts) {
    const { settings, warnings: hostWarnings } = extractSettings(host, target, alConfig);
    warnings.push(...hostWarnings);

    for (const [roleName, roleSettings] of Object.entries(settings)) {
      const targetRoleSettings = ensureRoleSettings(targetConfig, host, roleName);
      if (usefulString(roleSettings.model) && shouldFill(targetRoleSettings.model)) {
        targetRoleSettings.model = roleSettings.model;
        const path = `adapters.${host}.roleSettings.${roleName}.model`;
        updated.push(path);
        imports.push({ path, value: roleSettings.model, source: sourceArtifactFor(host, target, alConfig, roleName) });
      }
      if (
        targetRoleSettings.reasoningEffortDefault !== true &&
        usefulReasoningSetting(roleSettings.reasoningEffort) &&
        shouldFill(effectiveConfiguredReasoningSetting(targetRoleSettings))
      ) {
        targetRoleSettings.reasoningEffort = roleSettings.reasoningEffort;
        const path = `adapters.${host}.roleSettings.${roleName}.reasoningEffort`;
        updated.push(path);
        imports.push({ path, value: roleSettings.reasoningEffort, source: sourceArtifactFor(host, target, alConfig, roleName) });
      }
    }
  }

  const content = updated.length > 0 ? JSON.stringify(targetConfig, null, 2) + '\n' : undefined;
  if (content && options.write !== false) {
    try {
      writeFileSync(cfgPath, content, 'utf-8');
    } catch (error) {
      errors.push(`Failed to write preserved adapter model settings to agenticloop.json: ${error.message}`);
    }
  }

  return { updated, imports, warnings, errors, config: targetConfig, content };
}
