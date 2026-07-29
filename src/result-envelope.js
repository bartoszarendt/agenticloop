/** Canonical public validation-result envelopes. */

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  HUMAN_AUTHORITY_BOUNDARY,
  TRANSITION_DISPOSITIONS,
  TRANSITION_EVIDENCE_STATES,
  WORKFLOW_ROLES,
} from './transition-contract.js';
import { repairPolicyFor } from './repair-policy.js';
import {
  bindDiagnosticRoutingCapabilities,
  diagnosticRoutingCapabilities,
} from './diagnostic-routing-context.js';

export const VALIDATION_RESULT_KIND = 'agenticloop.validation-result';
export const VALIDATION_RESULT_SCHEMA_VERSION = 1;
export const VALIDATION_RESULT_REQUIRED_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'command', 'ok', 'evidenceState', 'disposition',
  'errors', 'warnings', 'diagnostics', 'warningDiagnostics',
  'failureCategories', 'firstSafeRepair', 'rollbackAuthorized', 'debugReference',
].sort());

// These arrays are inventories, not sequences: canonical output sorts them.
export const VALIDATION_RESULT_SET_LIKE_FIELDS = Object.freeze([
  'errors', 'warnings', 'diagnostics', 'warningDiagnostics', 'failureCategories',
]);

export const DIAGNOSTIC_ROOT_PRECEDENCE = Object.freeze([
  Object.freeze({ code: 'task.body.utf8', prerequisite: 'canonical_task_record' }),
  Object.freeze({ code: 'task.body.bom', prerequisite: 'canonical_task_record' }),
  Object.freeze({ code: 'task.body.collapsed_newlines', prerequisite: 'canonical_task_record' }),
  Object.freeze({ code: 'task.record.structure', prerequisite: 'canonical_task_record' }),
]);

function compareCanonical(left, right) {
  const leftText = canonicalJson(left);
  const rightText = canonicalJson(right);
  // ECMAScript relational comparison is exact UTF-16 code-unit ordering, unlike
  // localeCompare(), whose collation varies by host locale and can return 0.
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (item === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
      return [key, canonicalValue(item, `${path}.${key}`)];
    }));
  }
  throw new TypeError(`${path} must be canonical JSON data`);
}

function normalizedDiagnostic(diagnostic, { capabilities: explicitCapabilities = null } = {}) {
  if (!isPlainObject(diagnostic)) throw new TypeError('validation result diagnostics must contain objects');
  const capabilities = diagnosticRoutingCapabilities(diagnostic, explicitCapabilities);
  const result = canonicalValue(diagnostic, 'diagnostic');
  if (typeof result.code !== 'string' || !result.code) throw new TypeError('validation result diagnostic code must be a non-empty string');
  if (typeof result.message !== 'string') throw new TypeError('validation result diagnostic message must be a string');
  if (typeof result.level !== 'string') throw new TypeError('validation result diagnostic level must be a string');
  const allowedFields = new Set([
    'level', 'code', 'category', 'message', 'evidence', 'repairKind',
    'escalationKind', 'repairHint', 'diagnosticPrerequisites',
    'expectedShape', 'expectedValues', 'owner', 'escalationOwner',
    'nextAction', 'firstSafeRepair',
  ]);
  const unknownFields = Object.keys(result).filter(field => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new TypeError(`validation result diagnostic contains unknown fields: ${unknownFields.join(', ')}`);
  }
  const policy = repairPolicyFor(result.code);
  for (const [field, expected] of [
    ['category', policy.category],
    ['repairKind', policy.repairKind],
    ['escalationKind', policy.escalationKind],
  ]) {
    if (result[field] !== expected) {
      throw new TypeError(`validation result diagnostic ${field} must be '${expected}' for code '${result.code}'`);
    }
  }
  if (result.diagnosticPrerequisites !== undefined) {
    if (!Array.isArray(result.diagnosticPrerequisites) || !result.diagnosticPrerequisites.every(item => typeof item === 'string' && item)) {
      throw new TypeError('diagnosticPrerequisites must be an array of non-empty strings');
    }
    result.diagnosticPrerequisites = [...new Set(result.diagnosticPrerequisites)].sort(compareCanonical);
  }
  const routingFields = ['owner', 'escalationOwner', 'nextAction', 'firstSafeRepair'];
  if (routingFields.some(field => Object.hasOwn(result, field))) {
    if (!capabilities) {
      throw new TypeError(
        'validation result diagnostic routing capabilities are required to validate presentation fields'
      );
    }
    const expectedOwner = capabilities.primaryOwnerByRepairKind[result.repairKind];
    const expectedEscalationOwner = capabilities.escalationOwnerByKind[result.escalationKind] ?? null;
    if (!WORKFLOW_ROLES.includes(result.owner) || result.owner !== expectedOwner) {
      throw new TypeError(
        `validation result diagnostic owner must be '${expectedOwner}' for repair kind '${result.repairKind}'`
      );
    }
    if (result.escalationOwner !== null &&
        result.escalationOwner !== HUMAN_AUTHORITY_BOUNDARY &&
        !WORKFLOW_ROLES.includes(result.escalationOwner)) {
      throw new TypeError(
        `validation result diagnostic escalationOwner must be null, '${HUMAN_AUTHORITY_BOUNDARY}', or one of: ${WORKFLOW_ROLES.join(', ')}`
      );
    }
    if (result.escalationOwner !== expectedEscalationOwner) {
      throw new TypeError(
        `validation result diagnostic escalationOwner must be ${expectedEscalationOwner === null ? 'null' : `'${expectedEscalationOwner}'`} ` +
        `for escalation kind '${result.escalationKind}'`
      );
    }
    if (result.firstSafeRepair !== result.repairKind) {
      throw new TypeError('validation result diagnostic firstSafeRepair must equal its policy repairKind');
    }
    const expectedAction = `${result.repairHint ? `${result.repairHint} ` : ''}Repair: ${result.repairKind}. Owner: ${result.owner}.` +
      (result.escalationOwner ? ` Escalation owner: ${result.escalationOwner}.` : '');
    if (result.nextAction !== expectedAction) {
      throw new TypeError('validation result diagnostic nextAction must be derived from its policy and routing fields');
    }
  }
  return bindDiagnosticRoutingCapabilities(result, capabilities);
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`validation result field '${field}' must be an array`);
  } else if (!value.every(item => typeof item === 'string')) {
    errors.push(`validation result field '${field}' must contain only strings`);
  }
}

function validateDiagnosticArray(value, field, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`validation result field '${field}' must be an array`);
    return;
  }
  for (const item of value) {
    try { normalizedDiagnostic(item, options); } catch (error) { errors.push(`validation result field '${field}' ${error.message}`); }
  }
}

function validateEnvelopeRoutingContext(result, errors, options = {}) {
  if (options.capabilities) return;
  const contexts = new Set();
  for (const diagnostic of [
    ...(Array.isArray(result?.diagnostics) ? result.diagnostics : []),
    ...(Array.isArray(result?.warningDiagnostics) ? result.warningDiagnostics : []),
  ]) {
    if (!isPlainObject(diagnostic)) continue;
    const hasRouting = ['owner', 'escalationOwner', 'nextAction', 'firstSafeRepair']
      .some(field => Object.hasOwn(diagnostic, field));
    if (!hasRouting) continue;
    const capabilities = diagnosticRoutingCapabilities(diagnostic);
    if (capabilities) contexts.add(capabilities);
  }
  if (contexts.size > 1) {
    errors.push('validation result diagnostics must share one routing capability context');
  }
}

/**
 * Shared H1 utility for accumulator-style gates that already collected
 * independent facts before a prerequisite failed. Root-aware gates may instead
 * fail fast before dependent parsers run; guarded mutation gates can reuse this helper when a
 * gate must preserve independently computed facts.
 */
export function suppressDependentDiagnostics(diagnostics, failedPrerequisites = [], options = {}) {
  const failed = new Set(failedPrerequisites);
  const output = [];
  const seen = new Set();
  for (const item of Array.isArray(diagnostics) ? diagnostics : []) {
    const normalized = normalizedDiagnostic(item, options);
    if ((normalized.diagnosticPrerequisites ?? []).some(prerequisite => failed.has(prerequisite))) continue;
    const identity = canonicalJson(normalized);
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(normalized);
  }
  return output;
}

/** Shared accumulator companion to suppressDependentDiagnostics; see above. */
export function consolidateDiagnostics(diagnostics, options = {}) {
  const input = Array.isArray(diagnostics) ? diagnostics : [];
  const primary = DIAGNOSTIC_ROOT_PRECEDENCE.find(entry => input.some(item => item?.code === entry.code));
  if (!primary) return suppressDependentDiagnostics(input, [], options);
  return suppressDependentDiagnostics(
    input.filter(item => item?.code === primary.code || !DIAGNOSTIC_ROOT_PRECEDENCE.some(entry => entry.code === item?.code)),
    [primary.prerequisite],
    options
  );
}

export function validateRequiredFieldInventory(inventory) {
  const errors = [];
  if (!Array.isArray(inventory)) return { ok: false, errors: ['required-field inventory must be an array'] };
  const counts = new Map();
  for (const field of inventory) {
    if (typeof field !== 'string') errors.push('required-field inventory must contain only strings');
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  for (const [field, count] of counts) if (count > 1) errors.push(`required-field inventory duplicates '${field}'`);
  for (const field of VALIDATION_RESULT_REQUIRED_FIELDS) if (!counts.has(field)) errors.push(`required-field inventory is missing '${field}'`);
  for (const field of counts.keys()) if (!VALIDATION_RESULT_REQUIRED_FIELDS.includes(field)) errors.push(`required-field inventory contains unknown field '${field}'`);
  return { ok: errors.length === 0, errors };
}

export function validateValidationResult(result, options = {}) {
  const errors = [];
  if (!isPlainObject(result)) return { ok: false, errors: ['validation result must be an object'] };
  for (const field of VALIDATION_RESULT_REQUIRED_FIELDS) if (!Object.hasOwn(result, field)) errors.push(`validation result is missing required field '${field}'`);
  if (result.kind !== VALIDATION_RESULT_KIND) errors.push(`validation result kind must be '${VALIDATION_RESULT_KIND}'`);
  if (result.schemaVersion !== VALIDATION_RESULT_SCHEMA_VERSION) errors.push(`validation result schemaVersion must be ${VALIDATION_RESULT_SCHEMA_VERSION}`);
  if (typeof result.command !== 'string') errors.push('validation result command must be a string');
  if (typeof result.ok !== 'boolean') errors.push('validation result ok must be a boolean');
  if (!TRANSITION_EVIDENCE_STATES.includes(result.evidenceState)) errors.push(`validation result evidenceState must be one of: ${TRANSITION_EVIDENCE_STATES.join(', ')}`);
  if (!TRANSITION_DISPOSITIONS.includes(result.disposition)) errors.push(`validation result disposition must be one of: ${TRANSITION_DISPOSITIONS.join(', ')}`);
  validateStringArray(result.errors, 'errors', errors);
  validateStringArray(result.warnings, 'warnings', errors);
  validateStringArray(result.failureCategories, 'failureCategories', errors);
  validateDiagnosticArray(result.diagnostics, 'diagnostics', errors, options);
  validateDiagnosticArray(result.warningDiagnostics, 'warningDiagnostics', errors, options);
  validateEnvelopeRoutingContext(result, errors, options);
  if (result.firstSafeRepair !== null && typeof result.firstSafeRepair !== 'string') errors.push('validation result firstSafeRepair must be a string or null');
  if (result.debugReference !== null && typeof result.debugReference !== 'string') errors.push('validation result debugReference must be a string or null');
  if (result.ok === true && result.disposition !== 'proceed') errors.push("successful validation result requires disposition 'proceed'");
  if (result.ok === false && result.disposition === 'proceed') errors.push("failed validation result cannot use disposition 'proceed'");
  if (result.rollbackAuthorized !== false) errors.push('public validation results cannot authorize rollback');
  try {
    for (const [key, value] of Object.entries(result)) canonicalValue(value, `validation result.${key}`);
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors };
}

export function createValidationResult(input = {}, options = {}) {
  if (!isPlainObject(input)) throw new TypeError('validation result input must be an object');
  const {
    kind,
    schemaVersion,
    command,
    ok = false,
    evidenceState = ok === true ? 'current' : 'negative',
    disposition = ok === true ? 'proceed' : 'blocked',
    diagnostics = [],
    warningDiagnostics = [],
    errors,
    warnings,
    failureCategories,
    firstSafeRepair = null,
    rollbackAuthorized,
    debugReference = null,
    ...domainFields
  } = input;
  if (kind !== undefined && kind !== VALIDATION_RESULT_KIND) throw new TypeError(`protected field 'kind' must be '${VALIDATION_RESULT_KIND}'`);
  if (schemaVersion !== undefined && schemaVersion !== VALIDATION_RESULT_SCHEMA_VERSION) throw new TypeError(`protected field 'schemaVersion' must be ${VALIDATION_RESULT_SCHEMA_VERSION}`);
  if (rollbackAuthorized !== undefined && rollbackAuthorized !== false) throw new TypeError("protected field 'rollbackAuthorized' must be false");
  if (typeof command !== 'string') throw new TypeError('validation result command must be a string');
  if (typeof ok !== 'boolean') throw new TypeError('validation result ok must be a boolean');
  if (!Array.isArray(diagnostics)) throw new TypeError('validation result diagnostics must be an array');
  if (!Array.isArray(warningDiagnostics)) throw new TypeError('validation result warningDiagnostics must be an array');
  const normalizedDiagnostics = consolidateDiagnostics(diagnostics, options);
  const normalizedWarnings = consolidateDiagnostics(warningDiagnostics, options);
  const errorDiagnostics = normalizedDiagnostics.filter(item => item.level !== 'warning');
  const warningsList = normalizedWarnings.length > 0 ? normalizedWarnings : normalizedDiagnostics.filter(item => item.level === 'warning');
  const hasStructuredDiagnostics = diagnostics.length > 0 || warningDiagnostics.length > 0;
  const result = {
    ...canonicalValue(domainFields, 'validation result domain field'),
    kind: VALIDATION_RESULT_KIND,
    schemaVersion: VALIDATION_RESULT_SCHEMA_VERSION,
    command,
    ok,
    evidenceState,
    disposition,
    errors: hasStructuredDiagnostics ? errorDiagnostics.map(item => item.message) : errors ?? [],
    warnings: hasStructuredDiagnostics ? warningsList.map(item => item.message) : warnings ?? [],
    diagnostics: errorDiagnostics,
    warningDiagnostics: warningsList,
    failureCategories: hasStructuredDiagnostics
      ? [...new Set(errorDiagnostics.map(item => item.category).filter(Boolean))]
      : failureCategories ?? [],
    firstSafeRepair,
    rollbackAuthorized: false,
    debugReference,
  };
  const validation = validateValidationResult(result, options);
  if (!validation.ok) throw new TypeError(`invalid validation result: ${validation.errors.join('; ')}`);
  return result;
}

function canonicalResultProjection(result, options = {}) {
  const validation = validateValidationResult(result, options);
  if (!validation.ok) throw new TypeError(`invalid validation result: ${validation.errors.join('; ')}`);
  return {
    ...result,
    errors: [...new Set(result.errors)].sort(compareCanonical),
    warnings: [...new Set(result.warnings)].sort(compareCanonical),
    diagnostics: [...new Map(result.diagnostics.map(item => {
      const normalized = normalizedDiagnostic(item, options);
      return [canonicalJson(normalized), normalized];
    })).values()].sort(compareCanonical),
    warningDiagnostics: [...new Map(result.warningDiagnostics.map(item => {
      const normalized = normalizedDiagnostic(item, options);
      return [canonicalJson(normalized), normalized];
    })).values()].sort(compareCanonical),
    failureCategories: [...new Set(result.failureCategories)].sort(compareCanonical),
  };
}

export function serializeValidationResult(result, options = {}) {
  return canonicalJson(canonicalResultProjection(result, options));
}

/**
 * Public deterministic digest contract. Public gates serialize results for
 * transport; transition binding may consume this digest directly.
 */
export function validationResultDigest(result, options = {}) {
  return `sha256:agenticloop.validation-result.v1:${canonicalSha256(canonicalResultProjection(result, options))}`;
}

/** Emit a public failure only through the canonical validation serializer. */
export function emitValidationResult(io, result, options = {}) {
  io.out(serializeValidationResult(result, options));
}
