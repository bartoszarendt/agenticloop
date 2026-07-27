/**
 * Serializable input contract for deterministic review preparation.
 *
 * The live GitHub loader and offline consumers deliberately converge here.  The
 * evaluator still receives the established object shape, while this module owns
 * completeness checks and turns reference inventories into the lookup hooks the
 * existing verification validators expect.
 */

import { createDiagnostic } from './repair-policy.js';

export const PREPARATION_INPUT_SCHEMA_VERSION = 1;

const PR_ARRAY_FIELDS = ['files', 'statusCheckRollup', 'commits', 'comments', 'reviews'];
const ISSUE_ARRAY_FIELDS = ['comments'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arrayOfStrings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function diagnostic(message) {
  return createDiagnostic({ code: 'pr_body.input', message, repairHint: 'complete the serialized preparation input before rerunning the gate' });
}

/**
 * Validate and normalize the canonical, JSON-serializable preparation input.
 * Reference resolver functions are an explicitly live-only injection; offline
 * documents must carry the corresponding inventories instead.
 *
 * One completeness policy applies to every consumer (live preflight, offline
 * lint, review preparation, github-ready, and checkpoint commands): every
 * preparation category must be present. An explicitly unavailable value is
 * recorded as `null`; a silently omitted category is an incomplete-input
 * error, never a skipped validation.
 */
export function normalizePreparationInput(raw, options = {}) {
  const errors = [];
  if (!isObject(raw)) {
    return { ok: false, errors: [diagnostic('preparation input must be a JSON object')], value: null };
  }
  if (raw.schemaVersion !== PREPARATION_INPUT_SCHEMA_VERSION) {
    errors.push(diagnostic(`preparation input schemaVersion must be ${PREPARATION_INPUT_SCHEMA_VERSION}`));
  }

  const prData = raw.prData;
  const issueData = raw.issueData;
  if (!isObject(prData)) errors.push(diagnostic('preparation input is missing object field prData'));
  if (!isObject(issueData)) errors.push(diagnostic('preparation input is missing object field issueData'));

  if (isObject(prData)) {
    for (const field of ['number', 'body', 'headRefOid', 'baseRefOid']) {
      if (prData[field] === undefined || prData[field] === null || prData[field] === '') {
        errors.push(diagnostic(`preparation input prData.${field} is required`));
      }
    }
    for (const field of PR_ARRAY_FIELDS) {
      if (!Array.isArray(prData[field])) errors.push(diagnostic(`preparation input prData.${field} must be an array; categories may not be omitted`));
    }
  }
  if (isObject(issueData)) {
    for (const field of ['number', 'body']) {
      if (issueData[field] === undefined || issueData[field] === null || issueData[field] === '') {
        errors.push(diagnostic(`preparation input issueData.${field} is required`));
      }
    }
    for (const field of ISSUE_ARRAY_FIELDS) {
      if (!Array.isArray(issueData[field])) errors.push(diagnostic(`preparation input issueData.${field} must be an array; categories may not be omitted`));
    }
  }

  if (!isObject(raw.expectedAccount) || !String(raw.expectedAccount.login ?? '').trim()) {
    errors.push(diagnostic('preparation input expectedAccount.login is required'));
  }
  if (!isObject(raw.reviewHistory) || !Array.isArray(raw.reviewHistory.events) || !Array.isArray(raw.reviewHistory.errors)) {
    errors.push(diagnostic('preparation input reviewHistory must contain events and errors arrays'));
  }
  if (!arrayOfStrings(raw.basePaths)) {
    errors.push(diagnostic('preparation input basePaths must be an explicit array of base-tree paths'));
  }
  if (typeof raw.pathInventoryRequired !== 'boolean') {
    errors.push(diagnostic('preparation input pathInventoryRequired must be an explicit boolean'));
  }
  if (!Object.hasOwn(raw, 'verificationStatus')) {
    errors.push(diagnostic('preparation input verificationStatus must be present; use an explicit null when unavailable'));
  }
  if (!Array.isArray(raw.projectFacts)) {
    errors.push(diagnostic('preparation input projectFacts must be an explicit array'));
  }
  if (!['authoring', 'review'].includes(raw.mode)) {
    errors.push(diagnostic("preparation input mode must be 'authoring' or 'review'"));
  }
  if (!isObject(raw.references)) {
    errors.push(diagnostic('preparation input references must declare decisionIds and taskIds inventories'));
  } else {
    for (const field of ['decisionIds', 'taskIds']) {
      if (!arrayOfStrings(raw.references[field])) errors.push(diagnostic(`preparation input references.${field} must be an array of strings`));
    }
  }
  if (!isObject(raw.configuration)) {
    errors.push(diagnostic('preparation input configuration must be an object'));
  }

  if (errors.length > 0) return { ok: false, errors, value: null };

  const decisionIds = new Set(raw.references?.decisionIds ?? []);
  const taskIds = new Set(raw.references?.taskIds ?? []);
  const resolvers = options.referenceResolvers ?? {};
  return {
    ok: true,
    errors: [],
    value: {
      prData,
      issueData,
      verificationStatus: raw.verificationStatus,
      projectFacts: raw.projectFacts ?? [],
      decisionExists: resolvers.decisionExists ?? (id => decisionIds.has(id)),
      taskExists: resolvers.taskExists ?? (id => taskIds.has(id)),
      expectedAccount: raw.expectedAccount,
      reviewHistory: raw.reviewHistory ?? { events: [], errors: [] },
      reviewBudget: raw.configuration?.reviewBudget,
      reviewBudgetError: raw.configuration?.reviewBudgetError ?? null,
      projectMapConfig: raw.configuration?.projectMapConfig ?? null,
      basePaths: raw.basePaths ?? [],
      mode: raw.mode ?? 'review',
      pathInventoryRequired: raw.pathInventoryRequired !== false,
      preparationInput: raw,
    },
  };
}

/** Run an evaluator with the canonical normalized input and return one envelope. */
export function evaluatePreparationInput(raw, evaluator, options = {}) {
  const normalized = normalizePreparationInput(raw, options);
  if (!normalized.ok) {
    const errors = normalized.errors.map(item => item.message);
    return {
      schemaVersion: PREPARATION_INPUT_SCHEMA_VERSION,
      ok: false,
      errors,
      warnings: [],
      diagnostics: normalized.errors,
      warningDiagnostics: [],
      failureCategories: ['preparation_input'],
      inputComplete: false,
    };
  }
  const result = evaluator(normalized.value);
  return {
    ...result,
    schemaVersion: PREPARATION_INPUT_SCHEMA_VERSION,
    inputComplete: true,
  };
}

/** Convert a complete live loader result into the durable JSON document. */
export function createPreparationInput({
  prData,
  issueData,
  expectedAccount,
  reviewHistory,
  basePaths,
  mode = 'review',
  projectFacts = [],
  decisionIds = [],
  taskIds = [],
  verificationStatus,
  reviewBudget,
  reviewBudgetError = null,
  projectMapConfig = null,
  pathInventoryRequired = true,
} = {}) {
  return {
    schemaVersion: PREPARATION_INPUT_SCHEMA_VERSION,
    prData,
    issueData,
    expectedAccount,
    reviewHistory,
    basePaths,
    mode,
    pathInventoryRequired,
    projectFacts,
    references: { decisionIds, taskIds },
    verificationStatus: verificationStatus ?? null,
    configuration: { reviewBudget, reviewBudgetError, projectMapConfig },
  };
}
