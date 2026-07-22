/**
 * Model catalog for guided setup and interactive model selection.
 *
 * Provides a bundled fallback catalog with freshness metadata.
 * Discovery order: host-native discovery where available, bundled catalog,
 * then custom entry.
 * Never stores API keys. Host-native discovery only asks an already configured
 * local host CLI for its model list.
 */

import { spawnSync } from 'node:child_process';
import { CODEX_SUPPORTED_REASONING_EFFORTS } from './codex-models.js';

const CATALOG_OBSERVED_AT = '2026-07';
const CATALOG_SOURCE = 'bundled-fallback';
const MODEL_DISCOVERY_TIMEOUT_MS = 3000;
const ALL_ROLES = ['orchestrator', 'maintainer', 'engineer'];

const DISCOVERY_SOURCES = {
  opencode: 'host-native:opencode',
  cursor: 'host-native:cursor',
  codex: 'host-native:codex',
};

const DISCOVERY_COMMANDS = {
  opencode: { command: 'opencode', args: ['models'], envKey: 'AGENTICLOOP_OPENCODE_COMMAND', optionKey: 'opencodeCommand' },
  cursor: { command: 'agent', args: ['models'], envKey: 'AGENTICLOOP_CURSOR_COMMAND', optionKey: 'cursorCommand' },
  codex: { command: 'codex', args: ['debug', 'models'], envKey: 'AGENTICLOOP_CODEX_COMMAND', optionKey: 'codexCommand' },
};

const CATALOG_ENTRIES = [
  {
    id: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    hosts: ['opencode'],
    roleSuitability: ['orchestrator', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'anthropic/claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    hosts: ['opencode'],
    roleSuitability: ['maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    hosts: ['opencode'],
    roleSuitability: ['orchestrator'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'openai/gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    hosts: ['opencode', 'copilot', 'cursor'],
    roleSuitability: ['maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'openai/gpt-5.4',
    label: 'GPT-5.4',
    provider: 'openai',
    hosts: ['opencode', 'copilot', 'cursor'],
    roleSuitability: ['maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    provider: 'openai',
    hosts: ['opencode', 'copilot', 'cursor'],
    roleSuitability: ['orchestrator'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'openai',
    hosts: ['opencode'],
    roleSuitability: ['maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'openai/gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    provider: 'openai',
    hosts: ['opencode'],
    roleSuitability: ['orchestrator', 'maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    provider: 'openai',
    hosts: ['opencode'],
    roleSuitability: ['orchestrator'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'openai',
    hosts: ['codex'],
    roleSuitability: ['maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    provider: 'openai',
    hosts: ['codex'],
    roleSuitability: ['orchestrator', 'maintainer', 'engineer'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    provider: 'openai',
    hosts: ['codex'],
    roleSuitability: ['orchestrator'],
    supportsReasoningEffort: true,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 (native)',
    provider: 'anthropic',
    hosts: ['claude-code'],
    roleSuitability: ['orchestrator'],
    supportsReasoningEffort: false,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 (native)',
    provider: 'anthropic',
    hosts: ['claude-code'],
    roleSuitability: ['orchestrator', 'maintainer', 'engineer'],
    supportsReasoningEffort: false,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8 (native)',
    provider: 'anthropic',
    hosts: ['claude-code'],
    roleSuitability: ['orchestrator', 'maintainer'],
    supportsReasoningEffort: false,
    source: CATALOG_SOURCE,
    observedAt: CATALOG_OBSERVED_AT,
  },
];

/**
 * Get catalog entries filtered by host and optionally by role.
 *
 * @param {string} host  Host adapter name.
 * @param {string} [role]  Optional role to filter by suitability.
 * @returns {object[]} Matching catalog entries.
 */
export function getCatalogEntries(host, role = null) {
  let entries = CATALOG_ENTRIES.filter(e => e.hosts.includes(host));
  if (role) {
    entries = entries.filter(e => e.roleSuitability.includes(role));
  }
  return entries;
}

/**
 * Get all available catalog entries.
 *
 * @returns {object[]}
 */
export function getAllCatalogEntries() {
  return [...CATALOG_ENTRIES];
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function buildDiscoveredEntry(id, host, label = id) {
  return {
    id,
    label,
    provider: id.split('/')[0] || host,
    hosts: [host],
    roleSuitability: [...ALL_ROLES],
    supportsReasoningEffort: host !== 'cursor',
    source: DISCOVERY_SOURCES[host],
    observedAt: new Date().toISOString().slice(0, 10),
    confidence: 'live',
  };
}

/**
 * Parse `opencode models` output into model catalog entries.
 *
 * OpenCode documents the command output as provider/model identifiers. The
 * parser is intentionally tolerant of bullets, table framing, and ANSI color.
 *
 * @param {string} output
 * @returns {object[]}
 */
export function parseOpenCodeModelsOutput(output) {
  const modelIds = new Set();
  const modelToken = /[A-Za-z0-9][A-Za-z0-9_.:-]*\/[A-Za-z0-9][A-Za-z0-9_.:/@+-]*/g;

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    for (const match of line.matchAll(modelToken)) {
      const id = match[0].replace(/[),.;\]]+$/g, '');
      if (id.includes('://')) continue;
      modelIds.add(id);
    }
  }

  return [...modelIds].sort().map(id => buildDiscoveredEntry(id, 'opencode'));
}

/**
 * Parse `agent models` output into model catalog entries for Cursor.
 *
 * Cursor CLI outputs lines shaped like `<id> - <label>`. The parser strips
 * ANSI, skips blank/header lines, deduplicates by id, and trims trailing
 * `(current)` from labels.
 *
 * @param {string} output
 * @returns {object[]}
 */
export function parseCursorModelsOutput(output) {
  const seen = new Set();
  const entries = [];
  const linePattern = /^(\S+)\s+-\s+(.+)$/;

  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(linePattern);
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const label = match[2].replace(/\s*\(current\)\s*$/, '').trim();
    entries.push(buildDiscoveredEntry(id, 'cursor', label));
  }

  return entries;
}

/**
 * Parse `codex debug models` JSON output into model catalog entries.
 *
 * Accepts `{ models: [...] }` or a bare array. Extracts a stable id from
 * `slug`, `id`, or `model` fields, and label from `displayName`,
 * `display_name`, `name`, or the id. Deduplicates by id.
 *
 * @param {string} output
 * @returns {object[]}
 */
export function parseCodexModelsOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(stripAnsi(output));
  } catch {
    return [];
  }

  const models = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : [];
  const seen = new Set();
  const entries = [];

  for (const item of models) {
    if (!item || typeof item !== 'object') continue;
    const id = item.slug ?? item.id ?? item.model;
    if (!id || typeof id !== 'string') continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const label = item.displayName ?? item.display_name ?? item.name ?? id;
    entries.push(buildDiscoveredEntry(id, 'codex', label));
  }

  return entries;
}

function runDiscoveryCommand(command, args, options) {
  const spawnOptions = {
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS,
    windowsHide: true,
  };

  const result = spawnSync(command, args, spawnOptions);
  if (
    process.platform !== 'win32' ||
    !['ENOENT', 'EINVAL'].includes(result?.error?.code)
  ) {
    return result;
  }

  // Windows host CLIs are often .cmd/.ps1 shims; retry via the shell only
  // when direct process creation failed with a wrapper-style error.
  return spawnSync(command, args, {
    ...spawnOptions,
    shell: true,
  });
}

const HOST_LABELS = {
  opencode: 'OpenCode',
  cursor: 'Cursor',
  codex: 'Codex',
};

const HOST_PARSERS = {
  opencode: parseOpenCodeModelsOutput,
  cursor: parseCursorModelsOutput,
  codex: parseCodexModelsOutput,
};

/**
 * Discover host-native model entries when a safe local list command exists.
 *
 * Supported hosts: opencode (`opencode models`), cursor (`agent models`),
 * codex (`codex debug models`). Unsupported hosts return empty entries.
 *
 * This is best-effort and non-fatal. It never stores credentials; it only asks
 * a locally configured host CLI for models the user already has access to.
 *
 * @param {string} host
 * @param {object} [options]
 * @param {string} [options.opencodeCommand]
 * @param {string} [options.cursorCommand]
 * @param {string} [options.codexCommand]
 * @param {(command: string, args: string[], options: object) => object} [options.runner]
 * @param {number} [options.timeoutMs]
 * @returns {{ entries: object[], source: string|null, warnings: string[] }}
 */
export function discoverModelEntries(host, options = {}) {
  const spec = DISCOVERY_COMMANDS[host];
  if (!spec) {
    return { entries: [], source: null, warnings: [] };
  }

  const source = DISCOVERY_SOURCES[host];
  const hostLabel = HOST_LABELS[host];
  const command = options[spec.optionKey] ?? process.env[spec.envKey] ?? spec.command;
  const runner = options.runner ?? runDiscoveryCommand;
  let result;

  try {
    result = runner(command, spec.args, options);
  } catch (error) {
    return {
      entries: [],
      source,
      warnings: [`${hostLabel} model discovery failed: ${error.message}`],
    };
  }

  if (result?.error) {
    return {
      entries: [],
      source,
      warnings: [`${hostLabel} model discovery unavailable: ${result.error.message}`],
    };
  }

  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? '').trim();
    return {
      entries: [],
      source,
      warnings: [
        stderr
          ? `${hostLabel} model discovery exited with status ${result?.status}: ${stderr}`
          : `${hostLabel} model discovery exited with status ${result?.status}`,
      ],
    };
  }

  const entries = HOST_PARSERS[host](result?.stdout ?? '');
  return { entries, source, warnings: [] };
}

/**
 * Get the catalog observed date for freshness warnings.
 *
 * @returns {string}
 */
export function getCatalogObservedAt() {
  return CATALOG_OBSERVED_AT;
}

/**
 * Check if the bundled catalog is likely stale (older than 6 months).
 *
 * @returns {{ stale: boolean, observedAt: string, ageMonths: number }}
 */
export function checkCatalogFreshness() {
  const observed = new Date(`${CATALOG_OBSERVED_AT}-01`);
  const now = new Date();
  const ageMonths = (now.getFullYear() - observed.getFullYear()) * 12 +
    (now.getMonth() - observed.getMonth());

  return {
    stale: ageMonths >= 6,
    observedAt: CATALOG_OBSERVED_AT,
    ageMonths,
  };
}

/**
 * Get the valid reasoning effort values for a host.
 *
 * @param {string} host
 * @returns {string[]} Valid reasoning effort values, empty if not supported.
 */
export function getReasoningEffortChoices(host) {
  if (host === 'claude-code' || host === 'copilot' || host === 'cursor') return [];
  if (host === 'codex') return [...CODEX_SUPPORTED_REASONING_EFFORTS];
  return ['low', 'medium', 'high'];
}

/**
 * Format a catalog entry for display in a selection list.
 *
 * @param {object} entry  Catalog entry.
 * @param {number} index  1-based index for display.
 * @returns {string}
 */
export function formatCatalogChoice(entry, index) {
  return `  ${index}. ${entry.label} (${entry.id})`;
}
