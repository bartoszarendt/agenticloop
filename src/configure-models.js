/**
 * Configure per-host role model settings in a target's agenticloop.json.
 *
 * Supports non-interactive use so scripts and CI can set models without
 * terminal interaction. Supports interactive prompts when no --role/--model
 * flags are supplied. Writes to adapters.<host>.roleSettings.<role> and
 * preserves canonical agents/*.md as model-free source.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJsonFile } from './json.js';
import { CODEX_SUPPORTED_REASONING_EFFORTS_DISPLAY } from './codex-models.js';
import { ensureAdapterRoleSettings } from './adapter-role-defaults.js';
import {
  OPENCODE_AGENT_RELATIVE_PATHS,
  OPENCODE_COMMAND_RELATIVE_PATH,
} from './adapters/opencode.js';
import { generatedCopilotArtifactsPresent } from './adapters/copilot.js';
import { generatedCursorArtifactsPresent } from './adapters/cursor.js';
import {
  checkCatalogFreshness,
  discoverModelEntries,
  getCatalogEntries,
  getReasoningEffortChoices,
} from './model-catalog.js';

const VALID_HOSTS = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor']);

function supportsReasoningEffort(host) {
  return host !== 'claude-code' && host !== 'copilot' && host !== 'cursor';
}

/**
 * Detect host adapters from existing artifacts in the target directory.
 *
 * Looks for .opencode/agents/*.md, .opencode/commands/agenticloop.md,
 * .codex/agents/, .agents/skills/agenticloop/SKILL.md,
 * plugins/agenticloop/.codex-plugin/, .claude/agents/, and
 * GitHub Copilot generated .github/agents/. .github/skills/agenticloop/SKILL.md,
 * or .github/prompts/agenticloop.prompt.md, and generated Cursor
 * .cursor/agents/ or .cursor/skills/agenticloop/SKILL.md.
 *
 * @param {string} repoRoot
 * @returns {string[]} Detected host names.
 */
export function detectHost(repoRoot) {
  const detected = [];
  const opencodePresent = Object.values(OPENCODE_AGENT_RELATIVE_PATHS)
    .some(relPath => existsSync(join(repoRoot, relPath))) || existsSync(join(repoRoot, OPENCODE_COMMAND_RELATIVE_PATH));
  if (opencodePresent) detected.push('opencode');
  if (
    existsSync(join(repoRoot, '.codex', 'agents')) ||
    existsSync(join(repoRoot, '.agents', 'skills', 'agenticloop', 'SKILL.md')) ||
    existsSync(join(repoRoot, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json')) ||
    existsSync(join(repoRoot, '.codex-plugin'))
  ) {
    detected.push('codex');
  }
  if (existsSync(join(repoRoot, '.claude', 'agents'))) detected.push('claude-code');
  if (generatedCopilotArtifactsPresent(repoRoot).length > 0) detected.push('copilot');
  if (generatedCursorArtifactsPresent(repoRoot).length > 0) detected.push('cursor');
  return detected;
}

/**
 * Validate a host adapter name.
 *
 * @param {string} host
 * @returns {string|null} Error message or null if valid.
 */
export function validateHost(host) {
  if (!host) return '--adapter is required';
  if (!VALID_HOSTS.has(host)) return `Unknown adapter '${host}'. Use: ${[...VALID_HOSTS].join(', ')}`;
  return null;
}

/**
 * Create a prompt helper bound to the given input and output streams.
 *
 * Uses a simple line reader so piped input works reliably with top-level
 * await and does not keep a readline interface open across questions.
 *
 * @param {NodeJS.ReadableStream} [input=process.stdin]
 * @param {NodeJS.WritableStream} [output=process.stdout]
 * @returns {{ ask: (question: string) => Promise<string>, close: () => void }}
 */
export function createPrompts(input = process.stdin, output = process.stdout) {
  let buffer = '';
  let pending = null;
  let ended = false;

  function resolveNext() {
    if (!pending) return;
    const idx = buffer.indexOf('\n');
    if (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      const resolve = pending;
      pending = null;
      resolve(line);
    } else if (ended) {
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      const resolve = pending;
      pending = null;
      resolve(line);
    }
  }

  function onData(chunk) {
    buffer += chunk;
    resolveNext();
  }

  function onEnd() {
    ended = true;
    resolveNext();
  }

  input.setEncoding('utf-8');
  input.on('data', onData);
  input.on('end', onEnd);

  return {
    ask: (question) => new Promise((resolve) => {
      output.write(question);
      pending = resolve;
      resolveNext();
    }),
    write: (msg) => output.write(msg),
    close: () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.pause?.();
    },
  };
}

/**
 * Prompt for model settings for each configured logical role.
 * Reasoning effort is collected only for adapters that support it.
 *
 * @param {string[]} roles
 * @param {string} host
 * @param {{ ask: (q: string) => Promise<string> }} prompts
 * @returns {Promise<Array<{role: string, model?: string, reasoningEffort?: string}>>}
 */
export async function promptModelSettings(roles, host, prompts) {
  const mutations = [];
  for (const role of roles) {
    const model = (await prompts.ask(`  ${role} model for ${host} (blank to skip):\n`)).trim();
    if (!model) continue;
    if (!supportsReasoningEffort(host)) {
      mutations.push({ role, model });
      continue;
    }
    const reasoningEffortPrompt = host === 'codex'
      ? `  ${role} reasoning effort for ${host} (${CODEX_SUPPORTED_REASONING_EFFORTS_DISPLAY}; blank to skip):\n`
      : `  ${role} reasoning effort for ${host} (blank to skip):\n`;
    const reasoningEffort = (await prompts.ask(reasoningEffortPrompt)).trim();
    mutations.push({ role, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
  }
  return mutations;
}

/**
 * Build a numbered choice list for model selection.
 *
 * @param {string} host
 * @param {string} role
 * @param {string|null} currentModel  Current model setting if any.
 * @returns {{ choices: Array<{index: number, label: string, value: string|null, action: string}>, text: string }}
 */
function filterModelEntriesForHostRole(entries, host, role) {
  return entries.filter(entry => {
    const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
    const roles = Array.isArray(entry.roleSuitability) ? entry.roleSuitability : [];
    return hosts.includes(host) && (!role || roles.length === 0 || roles.includes(role));
  });
}

export function buildModelChoices(host, role, currentModel = null, options = {}) {
  const providedEntries = Array.isArray(options.modelEntries)
    ? filterModelEntriesForHostRole(options.modelEntries, host, role)
    : null;
  const catalogEntries = providedEntries ?? getCatalogEntries(host, role);
  const choices = [];
  let idx = 1;

  if (currentModel) {
    choices.push({ index: 0, label: `Keep current (${currentModel})`, value: currentModel, action: 'keep' });
  }

  for (const entry of catalogEntries) {
    choices.push({ index: idx, label: `${entry.label} (${entry.id})`, value: entry.id, action: 'catalog' });
    idx++;
  }

  choices.push({ index: idx, label: 'Custom model ID', value: null, action: 'custom' });
  idx++;
  choices.push({ index: idx, label: 'Skip this role', value: null, action: 'skip' });
  idx++;
  choices.push({ index: idx, label: 'Cancel', value: null, action: 'cancel' });

  const lines = [];
  for (const choice of choices) {
    lines.push(`  ${choice.index}. ${choice.label}`);
  }

  return { choices, text: lines.join('\n') };
}

/**
 * Build a numbered choice list for reasoning effort selection.
 *
 * @param {string} host
 * @param {string|null} currentEffort
 * @returns {{ choices: Array<{index: number, label: string, value: string|null, action: string}>, text: string }}
 */
export function buildReasoningEffortChoices(host, currentEffort = null) {
  const values = getReasoningEffortChoices(host);
  if (values.length === 0) return { choices: [], text: '' };

  const choices = [];
  let idx = 1;

  if (currentEffort) {
    choices.push({ index: 0, label: `Keep current (${currentEffort})`, value: currentEffort, action: 'keep' });
  }

  for (const value of values) {
    choices.push({ index: idx, label: value, value, action: 'select' });
    idx++;
  }

  choices.push({ index: idx, label: 'Skip', value: null, action: 'skip' });

  const lines = [];
  for (const choice of choices) {
    lines.push(`  ${choice.index}. ${choice.label}`);
  }

  return { choices, text: lines.join('\n') };
}

function resolveChoice(choices, input) {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const num = parseInt(trimmed, 10);
  if (!isNaN(num)) {
    return choices.find(c => c.index === num) ?? null;
  }
  return null;
}

function writePromptNote(prompts, message) {
  if (typeof prompts.write === 'function') {
    prompts.write(message);
  }
}

function resolvePromptModelEntries(host, prompts, options) {
  if (Array.isArray(options.modelEntries)) {
    return options.modelEntries;
  }
  if (options.discoverModels !== true) {
    return [];
  }

  const discovery = discoverModelEntries(host, {
    opencodeCommand: options.opencodeCommand,
    cursorCommand: options.cursorCommand,
    codexCommand: options.codexCommand,
    runner: options.modelDiscoveryRunner,
    timeoutMs: options.modelDiscoveryTimeoutMs,
  });

  if (discovery.entries.length > 0) {
    writePromptNote(
      prompts,
      `  Discovered ${discovery.entries.length} ${host} model(s) from ${discovery.source}.\n`
    );
  }

  return discovery.entries;
}

/**
 * Enhanced interactive model prompt with catalog choices.
 *
 * @param {string[]} roles
 * @param {string} host
 * @param {{ ask: (q: string) => Promise<string> }} prompts
 * @param {object} [currentSettings]  Current roleSettings for this host.
 * @returns {Promise<{mutations: Array<{role: string, model?: string, reasoningEffort?: string}>, cancelled: boolean}>}
 */
export async function promptModelSettingsInteractive(
  roles,
  host,
  prompts,
  currentSettings = {},
  options = {}
) {
  const mutations = [];
  const freshness = checkCatalogFreshness();
  const discoveredModelEntries = resolvePromptModelEntries(host, prompts, options);
  const modelChoiceOptions = discoveredModelEntries.length > 0
    ? { modelEntries: discoveredModelEntries }
    : {};

  if (discoveredModelEntries.length === 0 && freshness.stale) {
    prompts.write(`  Note: bundled model catalog is from ${freshness.observedAt} (${freshness.ageMonths} months old). Custom model IDs are always available.\n`);
  }

  let applyToRemaining = null;

  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const currentModel = currentSettings[role]?.model ?? null;
    const currentEffort = currentSettings[role]?.reasoningEffort ?? null;

    if (applyToRemaining !== null) {
      mutations.push({ role, model: applyToRemaining.model, ...(applyToRemaining.reasoningEffort ? { reasoningEffort: applyToRemaining.reasoningEffort } : {}) });
      continue;
    }

    const { choices, text } = buildModelChoices(host, role, currentModel, modelChoiceOptions);

    const header = currentModel
      ? `\n  ${role} model for ${host} (current: ${currentModel}):\n`
      : `\n  ${role} model for ${host}:\n`;

    const answer = (await prompts.ask(`${header}${text}\n  Choice: `)).trim();

    const selected = resolveChoice(choices, answer);

    if (!selected) {
      if (answer) {
        mutations.push({ role, model: answer });
      } else {
        continue;
      }
    } else if (selected.action === 'cancel') {
      return { mutations: [], cancelled: true };
    } else if (selected.action === 'skip') {
      continue;
    } else if (selected.action === 'keep') {
      continue;
    } else if (selected.action === 'custom') {
      const customModel = (await prompts.ask('  Custom model ID: ')).trim();
      if (!customModel) continue;
      mutations.push({ role, model: customModel });
    } else {
      mutations.push({ role, model: selected.value });
    }

    const lastMutation = mutations[mutations.length - 1];
    if (!lastMutation || lastMutation.role !== role) continue;

    if (supportsReasoningEffort(host)) {
      const effortChoices = buildReasoningEffortChoices(host, currentEffort);
      if (effortChoices.choices.length > 0) {
        const effortAnswer = (await prompts.ask(`  ${role} reasoning effort:\n${effortChoices.text}\n  Choice: `)).trim();
        const effortSelected = resolveChoice(effortChoices.choices, effortAnswer);

        if (effortSelected && effortSelected.action === 'select') {
          lastMutation.reasoningEffort = effortSelected.value;
        } else if (effortSelected && effortSelected.action === 'keep') {
          // keep current, no mutation needed
        }
      }
    }

    if (i < roles.length - 1 && mutations.length > 0) {
      const applyAnswer = (await prompts.ask('  Apply same model to remaining roles? (y/N): ')).trim().toLowerCase();
      if (applyAnswer === 'y' || applyAnswer === 'yes') {
        applyToRemaining = { model: lastMutation.model, reasoningEffort: lastMutation.reasoningEffort };
      }
    }
  }

  return { mutations, cancelled: false };
}

/**
 * Apply one or more model setting mutations to the target config file.
 *
 * @param {string} targetDir  Directory containing agenticloop.json.
 * @param {object} options
 * @param {string} options.adapter  Host adapter name (opencode, codex, claude-code, copilot, cursor).
 * @param {Array<{role: string, model?: string, reasoningEffort?: string}>} [options.mutations]
 * @param {'recommended'} [options.profile] Named profile to apply without replacing explicit fields.
 * @param {boolean} [options.warnJsoncComments] Deprecated no-op retained for compatibility.
 * @returns {{ errors: string[], warnings: string[], updated: string[], preserved: string[] }}
 */
export function configureModels(targetDir, options) {
  const errors = [];
  const warnings = [];
  const updated = [];
  const preserved = [];

  const cfgPath = join(targetDir, 'agenticloop.json');
  if (!existsSync(cfgPath)) {
    errors.push(`agenticloop.json not found at ${cfgPath}`);
    return { errors, warnings, updated, preserved };
  }

  let config;
  try {
    config = loadJsonFile(cfgPath);
  } catch (e) {
    errors.push(`Failed to parse agenticloop.json: ${e.message}`);
    return { errors, warnings, updated, preserved };
  }

  const host = options.adapter;
  const hostError = validateHost(host);
  if (hostError) {
    errors.push(hostError);
    return { errors, warnings, updated, preserved };
  }

  config.adapters = config.adapters ?? {};
  config.adapters[host] = config.adapters[host] ?? {};
  config.adapters[host].roleSettings = config.adapters[host].roleSettings ?? {};

  if (options.profile !== undefined) {
    if (options.profile !== 'recommended') {
      errors.push(`Unknown model profile '${options.profile}'. Use: recommended`);
    } else if (host !== 'codex') {
      errors.push("Model profile 'recommended' is currently available only for --adapter codex.");
    } else if ((options.mutations ?? []).length > 0) {
      errors.push("--profile recommended cannot be combined with --role, --model, or --reasoning-effort.");
    } else {
      const result = ensureAdapterRoleSettings(config, host);
      updated.push(...result.added);
      preserved.push(...result.kept);
    }
  } else {
    for (const mutation of options.mutations ?? []) {
      const { role, model, reasoningEffort } = mutation;
      if (!role) {
        warnings.push('Skipping model setting with no role');
        continue;
      }

      config.adapters[host].roleSettings[role] =
        config.adapters[host].roleSettings[role] ?? {};

      if (model !== undefined) {
        config.adapters[host].roleSettings[role].model = model;
        updated.push(`adapters.${host}.roleSettings.${role}.model`);
      }
      if (reasoningEffort !== undefined) {
        if (!supportsReasoningEffort(host)) {
          warnings.push(`Skipping reasoningEffort for ${host}; this adapter uses only model settings.`);
          continue;
        }
        config.adapters[host].roleSettings[role].reasoningEffort = reasoningEffort;
        updated.push(`adapters.${host}.roleSettings.${role}.reasoningEffort`);
      }
    }
  }

  if (errors.length === 0 && updated.length > 0) {
    try {
      writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    } catch (e) {
      errors.push(`Failed to write agenticloop.json: ${e.message}`);
    }
  }

  return { errors, warnings, updated, preserved };
}

/**
 * Parse repeated --role/--model/--reasoning-effort options from argv.
 *
 * Supports two styles:
 *   --role orchestrator --model <id> --reasoning-effort <value>
 *   --role maintainer --model <id>
 *
 * Each --role starts a new mutation. Options before the first --role are
 * ignored.
 *
 * @param {string[]} args
 * @returns {Array<{role?: string, model?: string, reasoningEffort?: string}>}
 */
export function parseModelMutations(args) {
  const mutations = [];
  let current = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--role') {
      if (current.role) mutations.push(current);
      current = { role: args[++i] };
    } else if (arg === '--model') {
      current.model = args[++i];
    } else if (arg === '--reasoning-effort') {
      current.reasoningEffort = args[++i];
    }
  }
  if (current.role) mutations.push(current);

  return mutations;
}
