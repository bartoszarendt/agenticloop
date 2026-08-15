/** Host-neutral bounded same-task execution reuse decision. */

import { canonicalSha256 } from './canonical-json.js';
import { getWorkflowRole } from './workflow-roles.js';

export const EXECUTION_REUSE_KIND = 'agenticloop.execution-reuse-decision';
export const EXECUTION_REUSE_SCHEMA_VERSION = 1;

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'taskId', 'backend', 'roleId', 'host',
  'conditions', 'execution', 'independence', 'digest',
]);
const CONDITION_FIELDS = Object.freeze([
  'hostCapability', 'dispatchLive', 'dispatchUnconsumed', 'cancellationBoundary',
  'protectedContractUnchanged', 'carrierLineageValid', 'roleIdentityMatches',
  'hostExecutionReferenceCurrent', 'durableRefetchSucceeded',
]);

function exact(value, fields) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
}

function digest(value) {
  const { digest: _digest, ...projection } = value;
  return `sha256:${EXECUTION_REUSE_KIND}.v${EXECUTION_REUSE_SCHEMA_VERSION}:${canonicalSha256(projection)}`;
}

function normalizeConditions(input) {
  return {
    hostCapability: input.hostCapability === true,
    dispatchLive: input.dispatchLive === true,
    dispatchUnconsumed: input.dispatchUnconsumed === true,
    cancellationBoundary: input.cancellationBoundary ?? null,
    protectedContractUnchanged: input.protectedContractUnchanged === true,
    carrierLineageValid: input.carrierLineageValid === true,
    roleIdentityMatches: input.roleIdentityMatches === true,
    hostExecutionReferenceCurrent: input.hostExecutionReferenceCurrent === true,
    durableRefetchSucceeded: input.durableRefetchSucceeded === true,
  };
}

export function createExecutionReuseDecision(input = {}) {
  const taskId = String(input.taskId ?? '').trim();
  const backend = String(input.backend ?? '').trim();
  const roleId = String(input.roleId ?? '').trim();
  const host = String(input.host ?? '').trim();
  const conditions = normalizeConditions(input);
  const conditionErrors = [];
  try { getWorkflowRole(roleId); } catch { conditionErrors.push(`role '${roleId}' is not in the canonical workflow-role registry`); }
  if (!['maintainer', 'engineer'].includes(roleId)) conditionErrors.push('only same-task Maintainer or Engineer execution may be resumed');
  if (conditions.cancellationBoundary !== 'return_on_cancellation') conditionErrors.push("cancellation boundary must be 'return_on_cancellation'");
  for (const key of CONDITION_FIELDS) {
    if (key === 'cancellationBoundary') continue;
    if (conditions[key] !== true) conditionErrors.push(`reuse condition '${key}' is not current`);
  }
  const resumed = conditionErrors.length === 0;
  const value = {
    kind: EXECUTION_REUSE_KIND,
    schemaVersion: EXECUTION_REUSE_SCHEMA_VERSION,
    taskId,
    backend,
    roleId,
    host,
    conditions,
    execution: {
      state: resumed ? 'resumed' : 'new',
      reason: resumed
        ? 'all bounded same-task continuation conditions are current'
        : conditionErrors[0] ?? 'reuse conditions are not current',
      authority: 'none',
    },
    independence: {
      required: roleId === 'auditor' || input.independentReview === true,
      rationale: roleId === 'auditor' || input.independentReview === true
        ? 'Auditor and explicitly independent review executions always require a fresh invocation'
        : 'same-task mechanical continuation is not independent review authority',
    },
    digest: null,
  };
  value.digest = digest(value);
  return Object.freeze(value);
}

export function validateExecutionReuseDecision(value, { taskId = null } = {}) {
  const errors = [];
  if (!exact(value, FIELDS)) return { ok: false, errors: ['execution reuse decision fields must equal the closed schema'] };
  if (value.kind !== EXECUTION_REUSE_KIND || value.schemaVersion !== EXECUTION_REUSE_SCHEMA_VERSION) errors.push('execution reuse decision identity is invalid');
  if (!value.taskId || (taskId !== null && value.taskId !== taskId)) errors.push('execution reuse decision taskId is invalid or mismatched');
  if (!['files', 'github'].includes(value.backend)) errors.push('execution reuse decision backend is invalid');
  if (!value.host || !exact(value.conditions, CONDITION_FIELDS)) errors.push('execution reuse decision host or conditions are invalid');
  if (!exact(value.execution, ['state', 'reason', 'authority']) || !['new', 'resumed'].includes(value.execution.state) || value.execution.authority !== 'none') errors.push('execution reuse decision execution is invalid or claims authority');
  if (!exact(value.independence, ['required', 'rationale']) || typeof value.independence.required !== 'boolean' || !value.independence.rationale) errors.push('execution reuse decision independence is invalid');
  if (value.roleId === 'auditor' && value.execution.state === 'resumed') errors.push('Auditor execution may never be resumed');
  if (value.digest !== digest(value)) errors.push('execution reuse decision digest is invalid');
  return { ok: errors.length === 0, errors };
}
