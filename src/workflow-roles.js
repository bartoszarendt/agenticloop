import { deepFreeze, WORKFLOW_ROLE_REGISTRY } from './transition-contract.js';

export const WORKFLOW_ROLE_ID_PATTERN = '^[a-z][a-z0-9-]*$';
const ROLE_ID_RE = new RegExp(WORKFLOW_ROLE_ID_PATTERN);
const EXACT_ROLE_FIELDS = new Set(['roleId', 'defaultLabel', 'escalationPrecedence']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  const wanted = expected instanceof Set ? expected : new Set(expected);
  return actual.length === wanted.size && actual.every(key => wanted.has(key));
}

export function isWorkflowRoleId(value) {
  return typeof value === 'string' && ROLE_ID_RE.test(value);
}

/**
 * Validate and enumerate a workflow-role registry in escalation order.
 * The optional registry seam exists for extension/migration tests; production
 * callers consume WORKFLOW_ROLE_REGISTRY.
 */
export function enumerateWorkflowRoles(registry = WORKFLOW_ROLE_REGISTRY) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new TypeError('workflow-role registry must be a non-empty array');
  }
  const ids = new Set();
  const precedence = new Set();
  const entries = registry.map((entry, index) => {
    if (!exactKeys(entry, EXACT_ROLE_FIELDS)) {
      throw new TypeError(`workflow-role registry entry ${index} must use the closed role schema`);
    }
    if (!ROLE_ID_RE.test(entry.roleId ?? '')) {
      throw new TypeError(`workflow-role registry entry ${index} has an invalid roleId`);
    }
    if (ids.has(entry.roleId)) {
      throw new TypeError(`workflow-role registry contains duplicate roleId '${entry.roleId}'`);
    }
    if (typeof entry.defaultLabel !== 'string' || !entry.defaultLabel.trim()) {
      throw new TypeError(`workflow role '${entry.roleId}' requires a non-empty defaultLabel`);
    }
    if (!Number.isSafeInteger(entry.escalationPrecedence) || entry.escalationPrecedence <= 0) {
      throw new TypeError(`workflow role '${entry.roleId}' has invalid escalationPrecedence`);
    }
    if (precedence.has(entry.escalationPrecedence)) {
      throw new TypeError(`workflow-role registry contains duplicate escalationPrecedence '${entry.escalationPrecedence}'`);
    }
    ids.add(entry.roleId);
    precedence.add(entry.escalationPrecedence);
    return { ...entry };
  });
  return deepFreeze(entries.sort((left, right) =>
    left.escalationPrecedence - right.escalationPrecedence ||
    left.roleId.localeCompare(right.roleId)
  ));
}

export const WORKFLOW_ROLE_ENTRIES = enumerateWorkflowRoles();
export const WORKFLOW_ROLE_IDS = Object.freeze(WORKFLOW_ROLE_ENTRIES.map(entry => entry.roleId));

/**
 * Resolve the effective registry for a target. `workflowRoles` is an extension
 * list: canonical role identities remain fixed and target roles are appended.
 */
export function resolveWorkflowRoleRegistry(config = null) {
  const extensions = config?.workflowRoles;
  if (extensions === undefined) return WORKFLOW_ROLE_ENTRIES;
  if (!Array.isArray(extensions)) {
    throw new TypeError('workflowRoles must be an array of workflow-role registry entries');
  }
  const canonicalIds = new Set(WORKFLOW_ROLE_IDS);
  for (const entry of extensions) {
    if (canonicalIds.has(entry?.roleId)) {
      throw new TypeError(`workflowRoles cannot override canonical roleId '${entry.roleId}'`);
    }
  }
  return enumerateWorkflowRoles([...WORKFLOW_ROLE_REGISTRY, ...extensions]);
}

export function resolveWorkflowRoleIds(config = null) {
  return Object.freeze(resolveWorkflowRoleRegistry(config).map(entry => entry.roleId));
}

export function getWorkflowRole(roleId, registry = WORKFLOW_ROLE_REGISTRY) {
  const entry = enumerateWorkflowRoles(registry).find(candidate => candidate.roleId === roleId);
  if (!entry) throw new TypeError(`unknown workflow roleId '${String(roleId)}'`);
  return entry;
}

export function getWorkflowRoleLabel(roleId, registry = WORKFLOW_ROLE_REGISTRY) {
  return getWorkflowRole(roleId, registry).defaultLabel;
}

function keysOf(value) {
  return isObject(value) ? Object.keys(value) : [];
}

/**
 * Validate exact role parity across role config, generated-agent inventory,
 * and model bindings. Values may be objects or arrays of immutable role IDs.
 */
export function validateWorkflowRoleParity({
  configRoles,
  agents,
  modelBindings,
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}) {
  const expected = enumerateWorkflowRoles(registry).map(entry => entry.roleId);
  const errors = [];
  for (const [label, value] of [
    ['config roles', configRoles],
    ['generated agents', agents],
    ['model bindings', modelBindings],
  ]) {
    const actual = Array.isArray(value) ? value : keysOf(value);
    const missing = expected.filter(roleId => !actual.includes(roleId));
    const unexpected = actual.filter(roleId => !expected.includes(roleId));
    const duplicate = actual.filter((roleId, index) => actual.indexOf(roleId) !== index);
    if (missing.length) errors.push(`${label} missing registry roles: ${missing.join(', ')}`);
    if (unexpected.length) errors.push(`${label} contains non-registry roles: ${unexpected.join(', ')}`);
    if (duplicate.length) errors.push(`${label} contains duplicate roles: ${[...new Set(duplicate)].join(', ')}`);
  }
  return { ok: errors.length === 0, errors, expected };
}

export function assertWorkflowRoleParity(input) {
  const result = validateWorkflowRoleParity(input);
  if (!result.ok) throw new TypeError(`workflow-role parity failed: ${result.errors.join('; ')}`);
  return result;
}
