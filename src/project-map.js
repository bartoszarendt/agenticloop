/**
 * Parse and validate .agenticloop/project.md.
 *
 * Returns merged defaults plus explicit overrides from frontmatter.
 * All fields that are absent from frontmatter fall back to convention-first
 * defaults so agents do not need to discover source documents at runtime.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { getDefaultDocumentSelections, getDocumentRoleNames } from './document-roles.js';
import { PROJECT_MAP_RELATIVE_PATH } from './layout.js';
import { parseVerificationOperatingFacts } from './verification-learning.js';

export const PROJECT_MAP_PATH = PROJECT_MAP_RELATIVE_PATH;

export const PROJECT_MAP_DEFAULTS = {
  development_stage: 'unconfirmed',
  max_parallel_implementation_lanes: 5,
  task_backend: 'files',
  event_logging: 'disabled',
  event_logging_command: '',
  task_id_pattern: 'T-<number>',
  task_id_regex: '^T-\\d{3,}$',
  task_file_template: '.agenticloop/tasks/{taskId}.md',
  grouping_profile: 'flat',
  documents: getDefaultDocumentSelections(),
};

export const DEVELOPMENT_STAGES = [
  'greenfield',
  'expansion',
  'stabilization',
  'maintenance',
];

const GROUPING_PROFILE_DEFAULTS = {
  flat: {
    group_closeout: false,
  },
  phase: {
    grouping_term: 'Phase',
    group_closeout: true,
    group_heading_regex: '^##\\s+(?:\\S+\\s+)?Phase\\s+(?<groupId>\\d+(?:\\.\\d+)?)\\b',
  },
  milestone: {
    grouping_term: 'Milestone',
    group_closeout: true,
  },
  epic: {
    grouping_term: 'Epic',
    group_closeout: true,
  },
  custom: {},
};

const LEGACY_FRONTMATTER_KEYS = [
  'phase_summary_template',
  'summary_template',
  'implementation_plan',
  'repository_rules',
  'readme',
];

const VALID_EVENT_LOGGING_VALUES = new Set(['disabled', 'enabled']);
const VALID_SETUP_STATUSES = new Set(['unconfirmed', 'confirmed']);
const VALID_DEVELOPMENT_STAGES = new Set(DEVELOPMENT_STAGES);
const YYYY_MM_DD_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function parseBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function normalizeRawFrontmatter(raw) {
  const normalized = { ...raw };

  if (normalized.documents && typeof normalized.documents === 'object') {
    normalized.documents = { ...normalized.documents };
  }

  if (normalized.group_closeout !== undefined) {
    normalized.group_closeout = parseBoolean(normalized.group_closeout);
  }

  if (typeof normalized.event_logging === 'string') {
    normalized.event_logging = normalized.event_logging.trim();
  }

  if (typeof normalized.event_logging_command === 'string') {
    const trimmedCommand = normalized.event_logging_command.trim();
    if (trimmedCommand) normalized.event_logging_command = trimmedCommand;
    else delete normalized.event_logging_command;
  }

  if (typeof normalized.engineer_context_window_tokens === 'string') {
    const trimmedTokens = normalized.engineer_context_window_tokens.trim();
    if (/^\d+$/.test(trimmedTokens)) {
      normalized.engineer_context_window_tokens = Number(trimmedTokens);
    } else {
      normalized.engineer_context_window_tokens = trimmedTokens;
    }
  }

  if (typeof normalized.max_parallel_implementation_lanes === 'string') {
    const trimmedLanes = normalized.max_parallel_implementation_lanes.trim();
    if (/^\d+$/.test(trimmedLanes)) {
      normalized.max_parallel_implementation_lanes = Number(trimmedLanes);
    } else {
      normalized.max_parallel_implementation_lanes = trimmedLanes;
    }
  }

  for (const key of [
    'development_stage',
    'development_stage_rationale',
    'development_stage_revisit_when',
  ]) {
    if (typeof normalized[key] === 'string') normalized[key] = normalized[key].trim();
  }

  return normalized;
}

function mergeDocuments(rawDocuments = {}) {
  return {
    ...getDefaultDocumentSelections(),
    ...rawDocuments,
  };
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function hasConfirmedDevelopmentStage(config) {
  return config?.setup_status === 'confirmed' &&
    VALID_DEVELOPMENT_STAGES.has(getTrimmedString(config.development_stage));
}

/**
 * Load .agenticloop/project.md from repoRoot and return merged config.
 *
 * Returns null when the file does not exist.
 *
 * @param {string} repoRoot
 * @returns {{ config: object, raw: object } | null}
 */
export function loadProjectMap(repoRoot) {
  const mapPath = join(repoRoot, PROJECT_MAP_PATH);
  if (!existsSync(mapPath)) return null;

  const content = readFileSync(mapPath, 'utf-8');
  const [fm] = parseFrontmatter(content);

  const raw = normalizeRawFrontmatter(fm ?? {});
  const groupingProfile = raw.grouping_profile ?? PROJECT_MAP_DEFAULTS.grouping_profile;
  const groupingDefaults = GROUPING_PROFILE_DEFAULTS[groupingProfile] ?? {};
  const config = {
    ...PROJECT_MAP_DEFAULTS,
    ...groupingDefaults,
    ...raw,
    documents: mergeDocuments(raw.documents),
  };
  const verificationFacts = parseVerificationOperatingFacts(content, {
    taskIdRegex: config.task_id_regex,
  }).facts;

  return { config, raw, content, verificationFacts };
}

function localDecisionExists(repoRoot, decisionId) {
  return existsSync(join(repoRoot, '.agenticloop', 'decisions', `${decisionId}.md`));
}

/**
 * Validate project map frontmatter fields.
 *
 * @param {object} config  Merged config from loadProjectMap().config
 * @param {object} raw     Raw frontmatter from loadProjectMap().raw
 * @param {string} repoRoot
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateProjectMap(config, raw, repoRoot) {
  const errors = [];
  const warnings = [];
  const validDocumentRoles = new Set(getDocumentRoleNames());
  const validGroupingProfiles = new Set(Object.keys(GROUPING_PROFILE_DEFAULTS));
  const projectMapPath = join(repoRoot, PROJECT_MAP_PATH);
  if (existsSync(projectMapPath)) {
    const verificationFacts = parseVerificationOperatingFacts(readFileSync(projectMapPath, 'utf-8'), {
      decisionExists: decisionId => localDecisionExists(repoRoot, decisionId),
      taskIdRegex: config.task_id_regex,
    });
    errors.push(...verificationFacts.errors);
  }

  for (const legacyKey of LEGACY_FRONTMATTER_KEYS) {
    if (raw[legacyKey] !== undefined) {
      errors.push(
        `project.md: '${legacyKey}' is no longer supported and should be removed from the frontmatter. ` +
        `Task summaries now live inline in the task record (the work-unit summary section), and source ` +
        `documents are selected through typed 'documents' roles.`
      );
    }
  }

  if (raw.setup_status === undefined) {
    errors.push('project.md: setup_status is required');
  } else if (!VALID_SETUP_STATUSES.has(config.setup_status)) {
    errors.push(
      `project.md: setup_status must be 'unconfirmed' or 'confirmed', got: ${JSON.stringify(config.setup_status)}`
    );
  }

  if (config.setup_status === 'confirmed') {
    const confirmedAt = getTrimmedString(config.setup_confirmed_at);
    const confirmedBy = getTrimmedString(config.setup_confirmed_by);

    if (!confirmedAt) {
      errors.push("project.md: setup_confirmed_at is required when setup_status is 'confirmed'");
    } else if (!YYYY_MM_DD_REGEX.test(confirmedAt)) {
      errors.push("project.md: setup_confirmed_at must be YYYY-MM-DD when setup_status is 'confirmed'");
    }

    if (!confirmedBy) {
      errors.push("project.md: setup_confirmed_by is required when setup_status is 'confirmed'");
    }
  }

  const developmentStage = getTrimmedString(config.development_stage);
  if (raw.development_stage !== undefined && typeof raw.development_stage !== 'string') {
    errors.push('project.md: development_stage must be a string');
  }
  if (config.setup_status === 'confirmed') {
    if (!VALID_DEVELOPMENT_STAGES.has(developmentStage)) {
      errors.push(
        `project.md: confirmed setup requires development_stage to be one of ${DEVELOPMENT_STAGES.join(', ')}; ` +
        `got: ${JSON.stringify(config.development_stage)}. Run agenticloop setup interactively to confirm the project profile.`
      );
    }
  } else if (config.setup_status === 'unconfirmed' && raw.development_stage !== undefined && developmentStage !== 'unconfirmed') {
    errors.push("project.md: unconfirmed setup may only use development_stage: 'unconfirmed'");
  }

  for (const key of ['development_stage_rationale', 'development_stage_revisit_when']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      errors.push(`project.md: ${key} must be a string when provided`);
    }
  }

  if (
    !Number.isInteger(config.max_parallel_implementation_lanes) ||
    config.max_parallel_implementation_lanes <= 0
  ) {
    errors.push('project.md: max_parallel_implementation_lanes must be a positive integer');
  }

  if (config.task_backend !== 'files' && config.task_backend !== 'github') {
    errors.push(
      `project.md: task_backend must be 'files' or 'github', got: ${JSON.stringify(config.task_backend)}`
    );
  }

  if (!VALID_EVENT_LOGGING_VALUES.has(config.event_logging)) {
    errors.push(
      `project.md: event_logging must be 'disabled' or 'enabled', got: ${JSON.stringify(config.event_logging)}`
    );
  }

  if (raw.event_logging_command !== undefined && typeof raw.event_logging_command !== 'string') {
    errors.push('project.md: event_logging_command must be a string when provided');
  }

  // Planning-only convention consumed by role instructions; it does not route
  // models or change adapter generation.
  if (
    raw.engineer_context_window_tokens !== undefined &&
    (!Number.isInteger(raw.engineer_context_window_tokens) || raw.engineer_context_window_tokens <= 0)
  ) {
    errors.push('project.md: engineer_context_window_tokens must be a positive integer when provided');
  }

  if (!config.task_id_pattern) {
    errors.push("project.md: task_id_pattern is required");
  }

  if (!config.task_id_regex) {
    errors.push("project.md: task_id_regex is required");
  } else {
    try {
      new RegExp(config.task_id_regex);
    } catch {
      errors.push(`project.md: task_id_regex is not a valid regular expression: ${config.task_id_regex}`);
    }
  }

  if (!config.task_file_template) {
    errors.push("project.md: task_file_template is required");
  } else if (!config.task_file_template.includes('{taskId}')) {
    errors.push("project.md: task_file_template must include {taskId}");
  }

  if (!validGroupingProfiles.has(config.grouping_profile)) {
    errors.push(
      `project.md: grouping_profile must be one of ${[...validGroupingProfiles].join(', ')}, got: ${JSON.stringify(config.grouping_profile)}`
    );
  }

  if (config.group_heading_regex) {
    try {
      new RegExp(config.group_heading_regex);
    } catch {
      errors.push(
        `project.md: group_heading_regex is not a valid regular expression: ${config.group_heading_regex}`
      );
    }
  }

  if (raw.group_closeout !== undefined && typeof raw.group_closeout !== 'boolean') {
    errors.push('project.md: group_closeout must be true or false when provided');
  }

  if (config.grouping_profile === 'custom') {
    if (!config.grouping_term) {
      errors.push('project.md: grouping_term is required when grouping_profile is custom');
    }
    if (!config.group_heading_regex) {
      errors.push('project.md: group_heading_regex is required when grouping_profile is custom');
    }
    if (typeof raw.group_closeout !== 'boolean') {
      errors.push('project.md: custom grouping_profile requires an explicit boolean group_closeout');
    }
  }

  if (raw.documents !== undefined && typeof raw.documents !== 'object') {
    errors.push('project.md: documents must be a nested mapping of document roles to paths');
  }

  for (const key of Object.keys(raw.documents ?? {})) {
    if (!validDocumentRoles.has(key)) {
      errors.push(
        `project.md: documents.${key} is not a known document role (expected one of: ${[...validDocumentRoles].join(', ')})`
      );
    }
  }

  // Warn when override doc paths are configured but the files are missing
  for (const [roleName, docPath] of Object.entries(raw.documents ?? {})) {
    if (docPath && !existsSync(join(repoRoot, config.documents[roleName]))) {
      warnings.push(`project.md: documents.${roleName} points to missing file: ${config.documents[roleName]}`);
    }
  }

  return { errors, warnings };
}

/**
 * Validate a task ID string against the configured regex.
 *
 * @param {string} taskId
 * @param {string} regex   Value of task_id_regex from project map config.
 * @returns {boolean}
 */
export function isValidTaskId(taskId, regex) {
  try {
    return new RegExp(regex).test(taskId);
  } catch {
    return false;
  }
}
