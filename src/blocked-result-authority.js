import { createPublicKey, randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import {
  HOST_SIGNATURE_ALGORITHM,
  signHostPayload,
  verifyHostPayload,
} from './host-trust.js';
import { deepFreeze } from './immutable.js';
import { createDiagnostic } from './repair-policy.js';
import { createValidationResult } from './result-envelope.js';
import {
  HUMAN_AUTHORITY_BOUNDARY,
  TRANSITION_CAPABILITY_AUTHORITY_RECORDS,
  WORKFLOW_ROLE_REGISTRY,
} from './transition-contract.js';
import { validateRoleReturn } from './dispatch-envelope.js';
import { enumerateWorkflowRoles } from './workflow-roles.js';

export const BLOCKED_RESULT_REDELEGATION_KIND =
  TRANSITION_CAPABILITY_AUTHORITY_RECORDS.redelegation.kind;
export const BLOCKED_RESULT_REDELEGATION_SCHEMA_VERSION =
  TRANSITION_CAPABILITY_AUTHORITY_RECORDS.redelegation.schemaVersion;
export const HUMAN_DISPOSITION_KIND =
  TRANSITION_CAPABILITY_AUTHORITY_RECORDS.humanDisposition.kind;
export const HUMAN_DISPOSITION_SCHEMA_VERSION =
  TRANSITION_CAPABILITY_AUTHORITY_RECORDS.humanDisposition.schemaVersion;
export const HUMAN_RECOVERY_CLASSES =
  TRANSITION_CAPABILITY_AUTHORITY_RECORDS.humanDisposition.recoveryClasses;

const REDELEGATION_INVALIDATORS = Object.freeze([
  'blocked_return_changed',
  'dispatch_packet_changed',
  'blocker_evidence_changed',
  'resume_preconditions_changed',
  'authority_revoked',
  'authority_expired',
]);
const HUMAN_DISPOSITION_INVALIDATORS = Object.freeze([
  'blocked_return_changed',
  'recovery_identity_changed',
  'affected_scope_changed',
  'host_state_changed',
  'authority_revoked',
  'disposition_expired',
]);
const DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const wanted = expected instanceof Set ? expected : new Set(expected);
  const actual = Object.keys(value);
  return actual.length === wanted.size && actual.every(key => wanted.has(key));
}

function workflowRoleSet(registry = WORKFLOW_ROLE_REGISTRY) {
  return new Set(enumerateWorkflowRoles(registry).map(entry => entry.roleId));
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function semanticDigest(identity, value) {
  const projection = structuredClone(value);
  delete projection.digest;
  if (isObject(projection.authentication)) delete projection.authentication.value;
  return `sha256:${identity}:${canonicalSha256(projection)}`;
}

export function blockedAuthoritySignaturePayload(value) {
  return {
    ...value,
    authentication: {
      algorithm: value?.authentication?.algorithm,
      authorityId: value?.authentication?.authorityId,
      keyId: value?.authentication?.keyId,
    },
  };
}

function signingAuthentication(signing, payload) {
  if (!isObject(signing) ||
      typeof signing.authorityId !== 'string' || !signing.authorityId.trim() ||
      typeof signing.keyId !== 'string' || !signing.keyId.trim() ||
      !signing.privateKey) {
    throw new TypeError('trusted authority signing requires authorityId, keyId, and an Ed25519 private key');
  }
  return {
    algorithm: HOST_SIGNATURE_ALGORITHM,
    authorityId: signing.authorityId,
    keyId: signing.keyId,
    value: signHostPayload(payload, signing.privateKey),
  };
}

function validateAuthentication(value, {
  authorityKind,
  recordId,
  expectedIssuer,
  resolveTrustedAuthority,
} = {}) {
  const errors = [];
  if (!exactKeys(value?.authentication, ['algorithm', 'authorityId', 'keyId', 'value']) ||
      value.authentication.algorithm !== HOST_SIGNATURE_ALGORITHM ||
      typeof value.authentication.authorityId !== 'string' || !value.authentication.authorityId.trim() ||
      typeof value.authentication.keyId !== 'string' || !value.authentication.keyId.trim() ||
      typeof value.authentication.value !== 'string' || !value.authentication.value.trim()) {
    return { ok: false, errors: ['authority authentication is malformed'], untrusted: true };
  }
  if (typeof resolveTrustedAuthority !== 'function') {
    return {
      ok: false,
      errors: ['authority verification requires a fixed operator-pinned trust resolver'],
      untrusted: true,
    };
  }
  let trusted;
  try {
    trusted = resolveTrustedAuthority(value.authentication.authorityId, authorityKind);
  } catch (error) {
    return { ok: false, errors: [`authority is not pinned: ${error.message}`], untrusted: true };
  }
  if (!isObject(trusted) ||
      trusted.authorityId !== value.authentication.authorityId ||
      trusted.authorityKind !== authorityKind ||
      trusted.algorithm !== HOST_SIGNATURE_ALGORITHM ||
      trusted.keyId !== value.authentication.keyId ||
      !isObject(trusted.issuer) ||
      trusted.issuer.ownerKind !== expectedIssuer?.ownerKind ||
      trusted.issuer.ownerId !== expectedIssuer?.ownerId ||
      !trusted.publicKey) {
    errors.push('authority authentication does not match the pinned authority identity, kind, issuer, or key');
  }
  if (!Array.isArray(trusted?.revokedRecordIds) ||
      trusted.revokedRecordIds.some(item => typeof item !== 'string' || !item)) {
    errors.push('pinned authority revocation state is malformed');
  } else if (trusted.revokedRecordIds.includes(recordId)) {
    errors.push('authority record is revoked by current operator trust state');
  }
  if (errors.length === 0 && !verifyHostPayload(
    blockedAuthoritySignaturePayload(value),
    value.authentication.value,
    trusted.publicKey
  )) {
    errors.push('authority authentication signature failed');
  }
  return { ok: errors.length === 0, errors, untrusted: errors.length > 0 };
}

function instant(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function stringArray(value, { allowEmpty = true } = {}) {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(item => typeof item === 'string' && item.trim());
}

function blockedBinding(roleReturn) {
  return {
    returnId: roleReturn.returnId,
    digest: roleReturn.digest,
  };
}

function packetBinding(roleReturn) {
  return {
    packetId: roleReturn.packet.packetId,
    digest: roleReturn.packet.digest,
  };
}

function validBlockedReturn(value) {
  const checked = validateRoleReturn(value);
  return checked.ok && value.disposition === 'blocked';
}

function diagnostic(code, message, state = 'negative') {
  return createDiagnostic({
    code,
    message,
    evidence: {
      state,
      supplied: state !== 'missing',
      rollbackAuthorized: false,
    },
  });
}

function result(command, ok, {
  code = null,
  message = null,
  evidenceState = ok ? 'current' : 'negative',
  disposition = ok ? 'proceed' : 'blocked',
  ...domain
} = {}) {
  return createValidationResult({
    command,
    ok,
    evidenceState,
    disposition,
    diagnostics: ok ? [] : [diagnostic(code, message, evidenceState)],
    firstSafeRepair: null,
    ...domain,
  });
}

function authorityResult(validation, value = null) {
  return {
    ok: validation.ok === true,
    value: validation.ok === true ? deepFreeze(value) : null,
    validation,
  };
}

export function blockedResultRedelegationDigest(value) {
  return semanticDigest('agenticloop.blocked-result-redelegation.v2', value);
}

export function createBlockedResultRedelegation({
  blockedReturn,
  toRole,
  authority,
  reason,
  issuedAt = new Date().toISOString(),
  expiresAt,
  authorityId = `redelegation:${randomUUID()}`,
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}, signing = null) {
  if (!validBlockedReturn(blockedReturn)) {
    throw new TypeError('redelegation requires a schema-valid blocked role return');
  }
  const value = {
    kind: BLOCKED_RESULT_REDELEGATION_KIND,
    schemaVersion: BLOCKED_RESULT_REDELEGATION_SCHEMA_VERSION,
    authorityId,
    blockedReturn: blockedBinding(blockedReturn),
    packet: packetBinding(blockedReturn),
    fromRole: blockedReturn.producerRole,
    toRole,
    authority,
    reason,
    issuedAt,
    expiresAt,
    invalidatedBy: [...REDELEGATION_INVALIDATORS],
    authentication: {
      algorithm: HOST_SIGNATURE_ALGORITHM,
      authorityId: signing?.authorityId,
      keyId: signing?.keyId,
      value: null,
    },
    digest: null,
  };
  value.digest = blockedResultRedelegationDigest(value);
  value.authentication = signingAuthentication(signing, blockedAuthoritySignaturePayload(value));
  const checked = validateBlockedResultRedelegation(value, {
    blockedReturn,
    resolveTrustedAuthority: () => ({
      authorityId: signing.authorityId,
      authorityKind: 'blocked_result_redelegation',
      keyId: signing.keyId,
      algorithm: HOST_SIGNATURE_ALGORITHM,
      publicKey: createPublicKey(signing.privateKey),
      issuer: {
        ownerKind: value.authority.ownerKind,
        ownerId: value.authority.ownerId,
      },
      revokedRecordIds: [],
    }),
    registry,
  });
  if (!checked.ok) throw new TypeError(`invalid blocked-result redelegation: ${checked.errors.join('; ')}`);
  return deepFreeze(value);
}

export function validateBlockedResultRedelegation(value, {
  blockedReturn,
  resolveTrustedAuthority,
  now = Date.now(),
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}) {
  const errors = [];
  if (!exactKeys(value, [
    'kind', 'schemaVersion', 'authorityId', 'blockedReturn', 'packet', 'fromRole',
    'toRole', 'authority', 'reason', 'issuedAt', 'expiresAt', 'invalidatedBy',
    'authentication', 'digest',
  ])) return {
    ok: false,
    value: null,
    errors: ['blocked-result redelegation fields must equal the closed schema'],
    stale: false,
    untrusted: false,
  };
  if (value.kind !== BLOCKED_RESULT_REDELEGATION_KIND ||
      value.schemaVersion !== BLOCKED_RESULT_REDELEGATION_SCHEMA_VERSION) {
    errors.push('blocked-result redelegation identity is invalid');
  }
  if (typeof value.authorityId !== 'string' || !/^redelegation:[0-9a-f-]{36}$/.test(value.authorityId)) {
    errors.push('blocked-result redelegation authorityId is invalid');
  }
  if (!exactKeys(value.blockedReturn, ['returnId', 'digest']) ||
      typeof value.blockedReturn.returnId !== 'string' ||
      !DIGEST_RE.test(value.blockedReturn.digest ?? '')) {
    errors.push('blocked-result redelegation return binding is invalid');
  }
  if (!exactKeys(value.packet, ['packetId', 'digest']) ||
      typeof value.packet.packetId !== 'string' ||
      !DIGEST_RE.test(value.packet.digest ?? '')) {
    errors.push('blocked-result redelegation packet binding is invalid');
  }
  const roles = workflowRoleSet(registry);
  if (!roles.has(value.fromRole) || !roles.has(value.toRole) ||
      value.fromRole === value.toRole) {
    errors.push('blocked-result redelegation must change between two canonical workflow roles');
  }
  if (!exactKeys(value.authority, ['ownerKind', 'ownerId', 'reference']) ||
      !['workflow_role', 'human_authority'].includes(value.authority?.ownerKind) ||
      (value.authority?.ownerKind === 'workflow_role' && value.authority?.ownerId !== 'orchestrator') ||
      (value.authority?.ownerKind === 'human_authority' && value.authority?.ownerId !== HUMAN_AUTHORITY_BOUNDARY) ||
      typeof value.authority?.reference !== 'string' || !value.authority.reference.trim()) {
    errors.push('blocked-result redelegation authority must be Orchestrator or human_authority with a durable reference');
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) errors.push('blocked-result redelegation reason is required');
  if (!instant(value.issuedAt) || !instant(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    errors.push('blocked-result redelegation freshness interval is invalid');
  }
  if (!same(value.invalidatedBy, REDELEGATION_INVALIDATORS)) errors.push('blocked-result redelegation invalidation inventory is invalid');
  if (value.digest !== blockedResultRedelegationDigest(value)) errors.push('blocked-result redelegation digest is invalid');
  const authentication = validateAuthentication(value, {
    authorityKind: 'blocked_result_redelegation',
    recordId: value.authorityId,
    expectedIssuer: value.authority,
    resolveTrustedAuthority,
  });
  errors.push(...authentication.errors);
  if (blockedReturn !== undefined) {
    if (!validBlockedReturn(blockedReturn) ||
        !same(value.blockedReturn, blockedBinding(blockedReturn)) ||
        !same(value.packet, packetBinding(blockedReturn)) ||
        value.fromRole !== blockedReturn.producerRole) {
      errors.push('blocked-result redelegation does not bind the exact current blocked return');
    }
  }
  const stale = instant(value.expiresAt) && Date.parse(value.expiresAt) <= now;
  if (instant(value.issuedAt) && Date.parse(value.issuedAt) > now) {
    errors.push('blocked-result redelegation authority is issued in the future');
  }
  if (stale) errors.push('blocked-result redelegation authority is stale');
  return {
    ok: errors.length === 0,
    value: errors.length === 0 ? value : null,
    errors,
    stale,
    untrusted: authentication.untrusted,
  };
}

export function authorizeBlockedResultResume({
  blockedReturn,
  requestedOwner,
  redelegationAuthority = null,
  resolveTrustedAuthority,
  now = Date.now(),
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}) {
  const command = 'blocked result resume';
  if (!validBlockedReturn(blockedReturn)) {
    return authorityResult(result(command, false, {
      code: 'role_return.invalid',
      message: 'A schema-valid blocked role return is required before resumption.',
      evidenceState: 'malformed',
    }));
  }
  if (requestedOwner === blockedReturn.producerRole) {
    const value = {
      ownerRole: requestedOwner,
      redelegated: false,
      authority: null,
    };
    return authorityResult(
      result(command, true, { ownerRole: requestedOwner, redelegated: false }),
      value
    );
  }
  if (!workflowRoleSet(registry).has(requestedOwner)) {
    const availableRoles = enumerateWorkflowRoles(registry).map(entry => entry.roleId);
    return authorityResult(result(command, false, {
      code: 'blocked_result.owner_mismatch',
      message:
        `Requested blocked-result owner '${String(requestedOwner)}' is not in the effective ` +
        `workflow-role registry. Available role IDs: ${availableRoles.join(', ')}.`,
      evidenceState: 'malformed',
    }));
  }
  if (!redelegationAuthority) {
    return authorityResult(result(command, false, {
      code: 'blocked_result.redelegation_required',
      message: `Blocked return ${blockedReturn.returnId} remains owned by ${blockedReturn.producerRole}; changing owner to ${requestedOwner} requires an operator-pinned, signed agenticloop.blocked-result-redelegation v2 authority bound to ${blockedReturn.returnId}, ${blockedReturn.digest}, and packet ${blockedReturn.packet.packetId}.`,
      evidenceState: 'missing',
    }));
  }
  const checked = validateBlockedResultRedelegation(redelegationAuthority, {
    blockedReturn,
    resolveTrustedAuthority,
    now,
    registry,
  });
  if (!checked.ok || redelegationAuthority.toRole !== requestedOwner) {
    return authorityResult(result(command, false, {
      code: checked.untrusted
        ? 'blocked_result.redelegation_untrusted'
        : checked.stale
          ? 'blocked_result.redelegation_stale'
          : !checked.ok
            ? 'blocked_result.redelegation_invalid'
            : 'blocked_result.owner_mismatch',
      message: `Redelegation authority does not authorize ${requestedOwner} for blocked return ${blockedReturn.returnId}: ${checked.errors.join('; ') || 'target role mismatch'}.`,
      evidenceState: checked.untrusted ? 'negative' : checked.stale ? 'stale' : 'negative',
    }));
  }
  const value = {
    ownerRole: requestedOwner,
    redelegated: true,
    authority: redelegationAuthority,
    nextTransition: blockedReturn.blocker.resumeTransition,
  };
  return authorityResult(result(command, true, {
      ownerRole: requestedOwner,
      redelegated: true,
      authorityId: redelegationAuthority.authorityId,
      nextTransition: blockedReturn.blocker.resumeTransition,
    }), value);
}

export function humanDispositionDigest(value) {
  return semanticDigest('agenticloop.human-disposition.v2', value);
}

export function createHumanDisposition({
  blockedReturn,
  recovery,
  human,
  reason,
  result: dispositionResult,
  issuedAt = new Date().toISOString(),
  expiresAt,
  dispositionId = `human-disposition:${randomUUID()}`,
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}, signing = null) {
  if (!validBlockedReturn(blockedReturn)) {
    throw new TypeError('human disposition requires a schema-valid blocked role return');
  }
  const value = {
    kind: HUMAN_DISPOSITION_KIND,
    schemaVersion: HUMAN_DISPOSITION_SCHEMA_VERSION,
    dispositionId,
    blockedReturn: blockedBinding(blockedReturn),
    recovery,
    human,
    reason,
    issuedAt,
    expiresAt,
    result: dispositionResult,
    invalidatedBy: [...HUMAN_DISPOSITION_INVALIDATORS],
    attribution: {
      ownerKind: 'human_actor',
      actor: human?.actor,
    },
    authentication: {
      algorithm: HOST_SIGNATURE_ALGORITHM,
      authorityId: signing?.authorityId,
      keyId: signing?.keyId,
      value: null,
    },
    digest: null,
  };
  value.digest = humanDispositionDigest(value);
  value.authentication = signingAuthentication(signing, blockedAuthoritySignaturePayload(value));
  const checked = validateHumanDisposition(value, {
    blockedReturn,
    resolveTrustedAuthority: () => ({
      authorityId: signing.authorityId,
      authorityKind: 'human_disposition',
      keyId: signing.keyId,
      algorithm: HOST_SIGNATURE_ALGORITHM,
      publicKey: createPublicKey(signing.privateKey),
      issuer: {
        ownerKind: 'human_authority',
        ownerId: HUMAN_AUTHORITY_BOUNDARY,
      },
      revokedRecordIds: [],
    }),
    registry,
  });
  if (!checked.ok) throw new TypeError(`invalid human disposition: ${checked.errors.join('; ')}`);
  return deepFreeze(value);
}

export function validateHumanDisposition(value, {
  blockedReturn,
  requestedRecovery,
  resolveTrustedAuthority,
  now = Date.now(),
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}) {
  const errors = [];
  if (!exactKeys(value, [
    'kind', 'schemaVersion', 'dispositionId', 'blockedReturn', 'recovery', 'human',
    'reason', 'issuedAt', 'expiresAt', 'result', 'invalidatedBy', 'attribution',
    'authentication', 'digest',
  ])) return {
    ok: false,
    value: null,
    errors: ['human disposition fields must equal the closed schema'],
    stale: false,
    untrusted: false,
  };
  const roles = workflowRoleSet(registry);
  if (value.kind !== HUMAN_DISPOSITION_KIND || value.schemaVersion !== HUMAN_DISPOSITION_SCHEMA_VERSION) {
    errors.push('human disposition identity is invalid');
  }
  if (typeof value.dispositionId !== 'string' || !/^human-disposition:[0-9a-f-]{36}$/.test(value.dispositionId)) {
    errors.push('human dispositionId is invalid');
  }
  if (!exactKeys(value.blockedReturn, ['returnId', 'digest']) ||
      typeof value.blockedReturn.returnId !== 'string' ||
      !DIGEST_RE.test(value.blockedReturn.digest ?? '')) {
    errors.push('human disposition blocked-return binding is invalid');
  }
  if (!exactKeys(value.recovery, ['identity', 'class', 'scope', 'hostState']) ||
      typeof value.recovery?.identity !== 'string' || !value.recovery.identity.trim() ||
      !HUMAN_RECOVERY_CLASSES.includes(value.recovery?.class) ||
      !stringArray(value.recovery?.scope) || !stringArray(value.recovery?.hostState)) {
    errors.push('human disposition recovery must name an identity, class, exact scope, and exact host state');
  } else if (value.recovery.class === 'host_state_repair' && value.recovery.hostState.length === 0) {
    errors.push('host-state repair requires at least one exact host-state identity');
  } else if (value.recovery.class !== 'host_state_repair' && value.recovery.scope.length === 0) {
    errors.push('destructive or scope-changing recovery requires at least one exact affected-scope identity');
  }
  if (!exactKeys(value.human, ['actor', 'authorityReference']) ||
      typeof value.human?.actor !== 'string' || !value.human.actor.trim() ||
      typeof value.human?.authorityReference !== 'string' || !value.human.authorityReference.trim()) {
    errors.push('human disposition requires a human actor and durable authority reference');
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) errors.push('human disposition reason is required');
  if (!instant(value.issuedAt) || !instant(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    errors.push('human disposition freshness interval is invalid');
  }
  if (!exactKeys(value.result, ['ownerRole', 'nextTransition']) ||
      (value.result?.ownerRole !== null && !roles.has(value.result.ownerRole)) ||
      typeof value.result?.nextTransition !== 'string' || !value.result.nextTransition.trim()) {
    errors.push('human disposition result must name a canonical resulting owner or null and one next transition');
  }
  if (!same(value.invalidatedBy, HUMAN_DISPOSITION_INVALIDATORS)) errors.push('human disposition invalidation inventory is invalid');
  if (!exactKeys(value.attribution, ['ownerKind', 'actor']) ||
      value.attribution?.ownerKind !== 'human_actor' ||
      value.attribution?.actor !== value.human?.actor ||
      roles.has(value.attribution?.actor)) {
    errors.push('human disposition attribution must remain human and cannot fabricate a workflow role');
  }
  if (value.digest !== humanDispositionDigest(value)) errors.push('human disposition digest is invalid');
  const authentication = validateAuthentication(value, {
    authorityKind: 'human_disposition',
    recordId: value.dispositionId,
    expectedIssuer: {
      ownerKind: 'human_authority',
      ownerId: HUMAN_AUTHORITY_BOUNDARY,
    },
    resolveTrustedAuthority,
  });
  errors.push(...authentication.errors);
  if (blockedReturn !== undefined && (
    !validBlockedReturn(blockedReturn) ||
    !same(value.blockedReturn, blockedBinding(blockedReturn))
  )) errors.push('human disposition does not bind the exact current blocked return');
  if (requestedRecovery !== undefined && !same(value.recovery, requestedRecovery)) {
    errors.push('human disposition recovery does not match the exact requested recovery');
  }
  const stale = instant(value.expiresAt) && Date.parse(value.expiresAt) <= now;
  if (instant(value.issuedAt) && Date.parse(value.issuedAt) > now) {
    errors.push('human disposition is issued in the future');
  }
  if (stale) errors.push('human disposition is stale');
  return {
    ok: errors.length === 0,
    value: errors.length === 0 ? value : null,
    errors,
    stale,
    untrusted: authentication.untrusted,
  };
}

export function authorizeBlockedResultRecovery({
  blockedReturn,
  recovery,
  humanDisposition = null,
  resolveTrustedAuthority,
  now = Date.now(),
  registry = WORKFLOW_ROLE_REGISTRY,
} = {}) {
  const command = 'blocked result recover';
  if (!validBlockedReturn(blockedReturn)) {
    return authorityResult(result(command, false, {
      code: 'role_return.invalid',
      message: 'A schema-valid blocked role return is required before exceptional recovery.',
      evidenceState: 'malformed',
    }));
  }
  if (!humanDisposition) {
    return authorityResult(result(command, false, {
      code: 'human_disposition.required',
      message: `Recovery '${String(recovery?.identity)}' for blocked return ${blockedReturn.returnId} requires an operator-pinned, signed agenticloop.human-disposition v2 record bound to ${blockedReturn.returnId}, ${blockedReturn.digest}, and that exact recovery.`,
      evidenceState: 'missing',
    }));
  }
  const checked = validateHumanDisposition(humanDisposition, {
    blockedReturn,
    requestedRecovery: recovery,
    resolveTrustedAuthority,
    now,
    registry,
  });
  if (!checked.ok) {
    return authorityResult(result(command, false, {
      code: checked.untrusted
        ? 'human_disposition.untrusted'
        : checked.stale
          ? 'human_disposition.stale'
          : 'human_disposition.invalid',
      message: `Human disposition does not authorize the requested recovery: ${checked.errors.join('; ')}.`,
      evidenceState: checked.untrusted ? 'negative' : checked.stale ? 'stale' : 'negative',
    }));
  }
  const value = {
    authority: {
      ownerKind: 'human_authority',
      ownerId: HUMAN_AUTHORITY_BOUNDARY,
      authorityReference: humanDisposition.human.authorityReference,
    },
    attribution: humanDisposition.attribution,
    ownerRole: humanDisposition.result.ownerRole,
    nextTransition: humanDisposition.result.nextTransition,
  };
  return authorityResult(result(command, true, {
      dispositionId: humanDisposition.dispositionId,
      authorityKind: 'human_authority',
      humanActor: humanDisposition.human.actor,
      ownerRole: humanDisposition.result.ownerRole,
      nextTransition: humanDisposition.result.nextTransition,
    }), value);
}
