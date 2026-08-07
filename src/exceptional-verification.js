/** Typed exceptional-verification import and owner routing. */

import { canonicalSha256 } from './canonical-json.js';
import { createDiagnostic } from './repair-policy.js';
import { createValidationResult } from './result-envelope.js';
import { getWorkflowRole } from './workflow-roles.js';

export const EXCEPTIONAL_VERIFICATION_KIND = 'agenticloop.exceptional-verification';
export const EXCEPTIONAL_VERIFICATION_SCHEMA_VERSION = 1;

const STATES = new Set(['missing', 'malformed', 'stale', 'negative', 'changed']);
const DISPOSITIONS = new Set(['exception_accepted', 'exception_rejected']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function digest(value) {
  const projection = structuredClone(value);
  delete projection.digest;
  return `sha256:agenticloop.exceptional-verification.v1:${canonicalSha256(projection)}`;
}

function validation(ok, state, disposition, message, producerRole = null, ownerRole = null) {
  return createValidationResult({
    command: 'role return exceptional-verification', ok, evidenceState: state, disposition,
    diagnostics: ok ? [] : [createDiagnostic({
      code: 'role_return.invalid', message,
      evidence: { state, supplied: state !== 'missing', rollbackAuthorized: false },
    })],
    ...(producerRole ? { producerRole } : {}),
    ...(ownerRole ? { ownerRole } : {}),
  });
}

/**
 * Closed validator. It never grants an exception; it only requests routing.
 *
 * `workflowRoleRegistry` is the *effective* registry for the selected target,
 * so a validly configured extension role resolves here exactly as it does
 * everywhere else. `allowedDispositionOwner` is derived by the caller from a
 * trusted, validated effective capability inventory - never from the request.
 */
export function validateExceptionalVerification(value, {
  packet, producerRole, allowedDispositionOwner, workflowRoleRegistry,
} = {}) {
  const errors = [];
  const state = value?.evidence?.state;
  if (!exact(value, ['kind', 'schemaVersion', 'requestId', 'producer', 'transition', 'check', 'evidence', 'proposedDisposition', 'dispositionAuthority', 'nextResumableTransition', 'freshness', 'digest'])) errors.push('exceptional-verification fields must equal the closed schema');
  if (value?.kind !== EXCEPTIONAL_VERIFICATION_KIND || value?.schemaVersion !== EXCEPTIONAL_VERIFICATION_SCHEMA_VERSION) errors.push('exceptional-verification identity is invalid');
  if (typeof value?.requestId !== 'string' || !/^exception:[0-9a-f-]{36}$/.test(value.requestId)) errors.push('exceptional-verification requestId is invalid');
  if (!exact(value?.producer, ['roleId']) || value.producer.roleId !== producerRole || !value.producer.roleId) errors.push('exceptional-verification producer does not match the authenticated producing role');
  if (!exact(value?.transition, ['packetId', 'digest']) || value.transition.packetId !== packet?.packetId || value.transition.digest !== packet?.digest) errors.push('exceptional-verification does not bind the exact consumed dispatch packet');
  if (!exact(value?.check, ['id', 'failureOrUnavailability']) || typeof value?.check?.id !== 'string' || !value.check.id || typeof value.check.failureOrUnavailability !== 'string' || !value.check.failureOrUnavailability) errors.push('exceptional-verification must name one exact failed or unavailable check');
  if (!exact(value?.evidence, ['state', 'detail']) || !STATES.has(state) || typeof value?.evidence?.detail !== 'string' || !value.evidence.detail.trim()) errors.push('exceptional-verification evidence must use the canonical evidence-state vocabulary');
  if (!DISPOSITIONS.has(value?.proposedDisposition)) errors.push('exceptional-verification proposed disposition is invalid');
  if (!exact(value?.dispositionAuthority, ['roleId']) || typeof value?.dispositionAuthority?.roleId !== 'string') errors.push('exceptional-verification disposition authority is invalid');
  try {
    if (value?.dispositionAuthority?.roleId) {
      if (workflowRoleRegistry === undefined) getWorkflowRole(value.dispositionAuthority.roleId);
      else getWorkflowRole(value.dispositionAuthority.roleId, workflowRoleRegistry);
    }
  } catch { errors.push('exceptional-verification disposition authority role is unknown'); }
  if (allowedDispositionOwner && value?.dispositionAuthority?.roleId !== allowedDispositionOwner) errors.push('exceptional-verification disposition authority is not the capability-derived owner');
  if (typeof value?.nextResumableTransition !== 'string' || !value.nextResumableTransition.trim()) errors.push('exceptional-verification next resumable transition is required');
  if (!exact(value?.freshness, ['invalidatedBy']) || !Array.isArray(value?.freshness?.invalidatedBy) || value.freshness.invalidatedBy.length === 0) errors.push('exceptional-verification freshness invalidation inventory is required');
  const digestInvalid = value?.digest !== digest(value);
  if (digestInvalid) errors.push('exceptional-verification digest is invalid');
  return { ok: errors.length === 0, errors, evidenceState: digestInvalid ? 'negative' : (STATES.has(state) ? state : 'malformed') };
}

/**
 * Route a verified request to the named capability owner.
 *
 * A successful result means only that the request was authenticated and validly
 * routed: `ok: true` with disposition `exception_requested`. No exception has
 * been accepted or rejected, completion stays false, and no implementation,
 * task-mutation, acceptance, or closeout authority is granted.
 * `exception_accepted` and `exception_rejected` remain distinct future
 * authority edges owned by the named disposition owner, who is kept separate
 * from the authenticated producer.
 */
export function receiveExceptionalVerification({
  request, packet, authenticatedProducerRole, allowedDispositionOwner, workflowRoleRegistry,
} = {}) {
  const checked = validateExceptionalVerification(request, {
    packet, producerRole: authenticatedProducerRole, allowedDispositionOwner, workflowRoleRegistry,
  });
  if (!checked.ok) {
    return {
      ok: false,
      state: 'rejected',
      route: { ownerRole: authenticatedProducerRole ?? null, nextResumableTransition: 'resubmit_exceptional_verification' },
      validation: validation(false, checked.evidenceState, 'rejected', checked.errors[0], authenticatedProducerRole),
    };
  }
  return {
    ok: true,
    state: 'exception_requested',
    completion: false,
    request: Object.freeze(structuredClone(request)),
    producer: { roleId: authenticatedProducerRole },
    route: { ownerRole: request.dispositionAuthority.roleId, nextResumableTransition: request.nextResumableTransition },
    validation: validation(true, 'current', 'exception_requested', '', authenticatedProducerRole, request.dispositionAuthority.roleId),
  };
}

export function createExceptionalVerification(input = {}) {
  const value = { ...input, kind: EXCEPTIONAL_VERIFICATION_KIND, schemaVersion: EXCEPTIONAL_VERIFICATION_SCHEMA_VERSION, digest: null };
  value.digest = digest(value);
  return Object.freeze(value);
}
