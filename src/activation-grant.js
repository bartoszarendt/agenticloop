/**
 * Host-neutral activation grants and task activation bindings.
 *
 * Agentic Loop's original activation path required a parser-owned, host-signed
 * capture. No shipped host adapter can produce one, so that path is only
 * reachable through an operator-integrated protected host. This module adds the
 * second, universal path: a durable **ActivationGrant** authored by the local
 * CLI after an explicit interactive operator confirmation, plus one
 * **TaskActivationBinding** per authorized task.
 *
 * Three rules shape the schemas here:
 *
 * 1. Assurance is a *derived* property of who produced the record, never a
 *    field a record may assert about itself. A grant claiming `host_signed`
 *    must authenticate against an adapter key pinned in the operator trust
 *    store; a grant claiming `operator_confirmed` must authenticate against the
 *    operator confirmation key held **outside** the target repository. A
 *    hand-authored, internally self-consistent JSON file in the target cannot
 *    satisfy either.
 * 2. Every relation is recomputed. Repository identity, task identity, exact
 *    current task-contract digest, grant/binding linkage, freshness, expiry,
 *    revocation, and decomposition derivation are all re-derived from current
 *    evidence at use time.
 * 3. Unknown fields, unknown enum values, contradictory derivations, stale
 *    digests, and cross-repository reuse fail closed.
 *
 * `operator_confirmed` is procedural, local-user assurance. It proves that a
 * human at an interactive terminal on this machine saw the exact task set,
 * carriers, and contract digests and typed a confirmation. It is **not**
 * equivalent to an isolated host signer, and it does not resist arbitrary
 * hostile code running as the same OS user.
 */

import { randomUUID } from 'node:crypto';

import { canonicalSha256 } from './canonical-json.js';
import { deepFreeze } from './immutable.js';
import { HOST_SIGNATURE_ALGORITHM } from './host-trust.js';
import { producerRefusal } from './public-error.js';

export const ACTIVATION_GRANT_KIND = 'agenticloop.activation-grant';
export const ACTIVATION_GRANT_SCHEMA_VERSION = 1;
export const TASK_ACTIVATION_BINDING_KIND = 'agenticloop.task-activation-binding';
export const TASK_ACTIVATION_BINDING_SCHEMA_VERSION = 1;
export const ACTIVATION_REVOCATION_KIND = 'agenticloop.activation-revocation';
export const ACTIVATION_REVOCATION_SCHEMA_VERSION = 1;

/**
 * Activation assurance, weakest first. `absent` is not a grade: an unactivated
 * or scaffold task carries no activation record at all and stays blocked.
 */
export const ACTIVATION_ASSURANCE_ORDER = Object.freeze(['operator_confirmed', 'host_signed']);
/** Return assurance, weakest first. */
export const RETURN_ASSURANCE_ORDER = Object.freeze(['session_reported', 'host_receipt']);

export const ACTIVATION_ASSURANCE_VALUES = Object.freeze(new Set(ACTIVATION_ASSURANCE_ORDER));
export const RETURN_ASSURANCE_VALUES = Object.freeze(new Set(RETURN_ASSURANCE_ORDER));

/** Closed scope inventory a grant may authorize. */
export const ACTIVATION_SCOPE_TYPES = Object.freeze(['exact_tasks', 'work_unit', 'captured_request']);

/** Closed inventory of how a task binding acquired its authority. */
export const ACTIVATION_DERIVATIONS = Object.freeze([
  'direct_operator_confirmation',
  'direct_protected_host_binding',
  'committed_decomposition_membership',
]);

/** Closed inventory of activation producer channels. */
export const ACTIVATION_CHANNELS = Object.freeze([
  'cli_interactive_confirmation',
  'protected_host_boundary',
]);

/** The only producer identity the shipped CLI may claim. */
export const CLI_OPERATOR_PRODUCER_ID = 'agenticloop.cli.operator-confirmation.v1';

/** The exact phrase an operator types to confirm an activation. */
export const OPERATOR_CONFIRMATION_PHRASE = 'activate';

/**
 * Every activation-record producer below refuses caller-supplied evidence
 * through one typed public refusal rather than a bare `TypeError`.
 *
 * `agenticloop activate` and `agenticloop activation revoke` call these
 * producers directly and hand whatever they throw to the command-failure
 * boundary. An untyped throw there is erased to "required operational context
 * is unavailable", so the operator learns nothing about the record the CLI
 * itself just built. `activation.grant.malformed` is the existing evidence fact
 * for exactly this - no new repair capability is introduced.
 */
const refuse = producerRefusal({
  code: 'activation.grant.malformed',
  safeRepair:
    'Repair the reported activation facts at their source and rerun the activation command; ' +
    'never hand-edit an activation grant, binding, or revocation record.',
});

/** Default grant lifetime: long enough for one working session, not open-ended. */
export const DEFAULT_GRANT_TTL_SECONDS = 43_200;
/** Upper bound on any requested grant lifetime. One work unit is not forever. */
export const MAX_GRANT_TTL_SECONDS = 604_800;
/** Tolerated clock skew when evaluating grant/binding instants. */
export const ACTIVATION_GRANT_CLOCK_SKEW_MS = 1000;

const GRANT_ID_RE = /^grant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING_ID_RE = /^binding:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVOCATION_ID_RE = /^revocation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Canonical work-unit identities are `<kind>:<id>` (phase:4, milestone:M2,
// epic:x, custom:x, work-unit:x), and the scan contract also admits bare ids.
const WORK_UNIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const GRANT_DIGEST_RE = /^sha256:agenticloop\.activation-grant\.v1:[a-f0-9]{64}$/;
const BINDING_DIGEST_RE = /^sha256:agenticloop\.task-activation-binding\.v1:[a-f0-9]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const ACTIVATION_GRANT_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'grantId', 'repositoryIdentity', 'backend', 'scope',
  'operatorIntentDigest', 'workUnitId', 'assurance', 'producer',
  'issuedAt', 'expiresAt', 'revocation', 'evidence', 'authentication', 'digest',
]);

export const TASK_ACTIVATION_BINDING_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'bindingId', 'grantId', 'grantDigest',
  'repositoryIdentity', 'backend', 'taskId', 'carrier', 'taskContractDigest',
  'derivation', 'decompositionSource', 'assurance',
  'issuedAt', 'expiresAt', 'authentication', 'digest',
]);

export const ACTIVATION_REVOCATION_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'revocationId', 'grantId', 'grantDigest',
  'repositoryIdentity', 'revokedAt', 'reason',
]);

const PRODUCER_FIELDS = Object.freeze(['id', 'channel']);
const AUTHENTICATION_FIELDS = Object.freeze(['algorithm', 'keyId', 'value']);
const REVOCATION_BINDING_FIELDS = Object.freeze(['id', 'state']);
const DECOMPOSITION_SOURCE_FIELDS = Object.freeze([
  'sourceRef', 'sourceDigest', 'scanSemanticDigest', 'workUnitId', 'observedAt',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isObject(value)) return { ok: false, missing: [...keys], unknown: [] };
  const expected = new Set(keys);
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !expected.has(key));
  return { ok: missing.length === 0 && unknown.length === 0, missing, unknown };
}

function shapeErrors(value, keys, label, errors) {
  const shape = exactKeys(value, keys);
  if (!isObject(value)) {
    errors.push({ code: 'activation.grant.malformed', evidenceState: 'malformed', message: `${label} must be an object` });
    return false;
  }
  if (shape.missing.length) {
    errors.push({
      code: 'activation.grant.malformed',
      evidenceState: 'malformed',
      message: `${label} is missing field(s): ${shape.missing.join(', ')}`,
    });
  }
  if (shape.unknown.length) {
    errors.push({
      code: 'activation.grant.malformed',
      evidenceState: 'malformed',
      message: `${label} contains unknown field(s): ${shape.unknown.join(', ')}`,
    });
  }
  return shape.ok;
}

function instantMs(value) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Semantic digest over the record projection.
 *
 * `digest` and `authentication` are both excluded. The signature is computed
 * *over* this digest, so including it would be circular: the record's semantic
 * identity is what the signature attests to, not the other way round. Every
 * other field - including producer, channel, assurance, scope, and expiry - is
 * covered, so no field can be edited without breaking both the digest and the
 * signature bound to it.
 */
function semanticDigest(prefix, value) {
  if (!isObject(value)) return null;
  const { digest, authentication, ...rest } = value;
  try {
    return `sha256:${prefix}:${canonicalSha256(rest)}`;
  } catch {
    return null;
  }
}

/**
 * Canonical signature payload for one grant. The signature covers the exact
 * semantic digest plus the identity fields a verifier must not have to trust
 * the record for, so a re-signed lookalike cannot borrow another grant's proof.
 */
export function activationGrantSignaturePayload(grant) {
  return {
    kind: 'agenticloop.activation-grant-signature',
    schemaVersion: ACTIVATION_GRANT_SCHEMA_VERSION,
    grantId: grant?.grantId ?? null,
    repositoryIdentity: grant?.repositoryIdentity ?? null,
    assurance: grant?.assurance ?? null,
    digest: activationGrantDigest(grant),
  };
}

/** Canonical signature payload for one task activation binding. */
export function taskActivationBindingSignaturePayload(binding) {
  return {
    kind: 'agenticloop.task-activation-binding-signature',
    schemaVersion: TASK_ACTIVATION_BINDING_SCHEMA_VERSION,
    bindingId: binding?.bindingId ?? null,
    grantId: binding?.grantId ?? null,
    repositoryIdentity: binding?.repositoryIdentity ?? null,
    taskId: binding?.taskId ?? null,
    taskContractDigest: binding?.taskContractDigest ?? null,
    assurance: binding?.assurance ?? null,
    digest: taskActivationBindingDigest(binding),
  };
}

export function activationGrantDigest(grant) {
  return semanticDigest(`${ACTIVATION_GRANT_KIND}.v${ACTIVATION_GRANT_SCHEMA_VERSION}`, grant);
}

export function taskActivationBindingDigest(binding) {
  return semanticDigest(
    `${TASK_ACTIVATION_BINDING_KIND}.v${TASK_ACTIVATION_BINDING_SCHEMA_VERSION}`,
    binding
  );
}

/** Compare two activation assurance grades. Unknown grades rank below every known one. */
export function compareActivationAssurance(left, right) {
  return ACTIVATION_ASSURANCE_ORDER.indexOf(left) - ACTIVATION_ASSURANCE_ORDER.indexOf(right);
}

export function compareReturnAssurance(left, right) {
  return RETURN_ASSURANCE_ORDER.indexOf(left) - RETURN_ASSURANCE_ORDER.indexOf(right);
}

/** True when `observed` is a known grade at least as strong as `minimum`. */
export function activationAssuranceMeets(observed, minimum) {
  if (!ACTIVATION_ASSURANCE_VALUES.has(observed) || !ACTIVATION_ASSURANCE_VALUES.has(minimum)) return false;
  return compareActivationAssurance(observed, minimum) >= 0;
}

export function returnAssuranceMeets(observed, minimum) {
  if (!RETURN_ASSURANCE_VALUES.has(observed) || !RETURN_ASSURANCE_VALUES.has(minimum)) return false;
  return compareReturnAssurance(observed, minimum) >= 0;
}

/**
 * The honest, non-cryptographic description of one activation grade. Rendered
 * verbatim into CLI output, dispatch packets, audit evidence, and closeout so
 * no surface can quietly upgrade the language.
 */
export const ACTIVATION_ASSURANCE_LIMITATIONS = Object.freeze({
  operator_confirmed:
    'Procedural local-operator assurance: a human at an interactive terminal on this machine confirmed the exact task set and contract digests. ' +
    'It is not an isolated host signer and does not resist arbitrary code running as the same OS user.',
  host_signed:
    'Parser/host-owned activation capture authenticated by an isolated signer registered in the operator trust store.',
});

export const RETURN_ASSURANCE_LIMITATIONS = Object.freeze({
  session_reported:
    'Schema-valid role result reported through the coordinating session and revalidated against refetched repository evidence. ' +
    'The producing role identity is NOT host-authenticated.',
  host_receipt:
    'Authenticated host handoff receipt proving the observed producer role against an operator-pinned adapter key.',
});

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build one unsigned activation grant skeleton.
 *
 * The caller supplies facts only. Assurance, producer identity, and channel are
 * validated as a consistent triple: a CLI-authored grant can never name a
 * protected-host channel, and a protected-host grant can never name the CLI
 * confirmation producer.
 *
 * @param {{
 *   repositoryIdentity: string,
 *   backend: 'files'|'github',
 *   scope: { type: string, taskIds?: string[], workUnitId?: string, operatorIntentDigest?: string },
 *   assurance: 'operator_confirmed'|'host_signed',
 *   producer: { id: string, channel: string },
 *   issuedAt?: string,
 *   expiresAt?: string,
 *   ttlSeconds?: number,
 *   operatorIntentDigest?: string|null,
 *   evidence: object,
 *   grantId?: string,
 *   revocationId?: string,
 * }} input
 */
export function createActivationGrant(input = {}) {
  const known = [
    'repositoryIdentity', 'backend', 'scope', 'assurance', 'producer', 'issuedAt',
    'expiresAt', 'ttlSeconds', 'operatorIntentDigest', 'evidence', 'grantId', 'revocationId',
  ];
  const unknown = Object.keys(input).filter(key => !known.includes(key));
  if (unknown.length) throw refuse(`invalid activation grant: unknown input field(s): ${unknown.join(', ')}`);
  if (!ACTIVATION_ASSURANCE_VALUES.has(input.assurance)) {
    throw refuse('activation grant assurance must be operator_confirmed or host_signed');
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issued = instantMs(issuedAt);
  if (issued === null) throw refuse('activation grant issuedAt must be an ISO-8601 UTC instant');
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  if (input.expiresAt === undefined &&
      (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_GRANT_TTL_SECONDS)) {
    throw refuse(`activation grant ttlSeconds must be an integer between 1 and ${MAX_GRANT_TTL_SECONDS}`);
  }
  const expiresAt = input.expiresAt ?? new Date(issued + ttlSeconds * 1000).toISOString();
  const scope = normalizeScope(input.scope);
  const grant = {
    kind: ACTIVATION_GRANT_KIND,
    schemaVersion: ACTIVATION_GRANT_SCHEMA_VERSION,
    grantId: input.grantId ?? `grant:${randomUUID()}`,
    repositoryIdentity: input.repositoryIdentity ?? null,
    backend: input.backend ?? null,
    scope,
    operatorIntentDigest: input.operatorIntentDigest ?? scope.operatorIntentDigest ?? null,
    workUnitId: scope.workUnitId ?? null,
    assurance: input.assurance,
    producer: {
      id: input.producer?.id ?? null,
      channel: input.producer?.channel ?? null,
    },
    issuedAt,
    expiresAt,
    revocation: {
      id: input.revocationId ?? `revocation:${randomUUID()}`,
      state: 'active',
    },
    evidence: normalizeEvidence(input.assurance, input.evidence),
    authentication: null,
    digest: null,
  };
  grant.digest = activationGrantDigest(grant);
  const checked = validateActivationGrantShape(grant);
  if (!checked.ok) throw refuse(`invalid activation grant: ${checked.errors[0].message}`);
  return deepFreeze(grant);
}

function normalizeScope(scope) {
  if (!isObject(scope)) throw refuse('activation grant scope must be an object');
  if (!ACTIVATION_SCOPE_TYPES.includes(scope.type)) {
    throw refuse(`activation grant scope type must be one of: ${ACTIVATION_SCOPE_TYPES.join(', ')}`);
  }
  if (scope.type === 'exact_tasks') {
    const taskIds = Array.isArray(scope.taskIds) ? [...new Set(scope.taskIds.map(String))].sort() : null;
    if (!taskIds || taskIds.length === 0 || taskIds.some(id => !TASK_ID_RE.test(id))) {
      throw refuse('an exact_tasks activation scope requires a non-empty set of canonical task ids');
    }
    return { type: 'exact_tasks', taskIds, workUnitId: null, operatorIntentDigest: null };
  }
  if (scope.type === 'work_unit') {
    if (typeof scope.workUnitId !== 'string' || !WORK_UNIT_ID_RE.test(scope.workUnitId)) {
      throw refuse('a work_unit activation scope requires a canonical work-unit id');
    }
    return { type: 'work_unit', taskIds: null, workUnitId: scope.workUnitId, operatorIntentDigest: null };
  }
  if (typeof scope.operatorIntentDigest !== 'string' || !SHA256_RE.test(scope.operatorIntentDigest)) {
    throw refuse('a captured_request activation scope requires an operator-intent SHA-256 digest');
  }
  return {
    type: 'captured_request',
    taskIds: null,
    workUnitId: null,
    operatorIntentDigest: scope.operatorIntentDigest,
  };
}

function normalizeEvidence(assurance, evidence) {
  if (!isObject(evidence)) throw refuse('activation grant evidence must be an object');
  if (assurance === 'operator_confirmed') {
    const { confirmedAt, confirmationPhrase, channel, operatorKeyId, scopeSummaryDigest } = evidence;
    if (channel !== 'cli_interactive_confirmation') {
      throw refuse("operator-confirmed activation evidence channel must be 'cli_interactive_confirmation'");
    }
    if (confirmationPhrase !== OPERATOR_CONFIRMATION_PHRASE) {
      throw refuse(`operator-confirmed activation evidence must record the exact confirmation phrase '${OPERATOR_CONFIRMATION_PHRASE}'`);
    }
    if (instantMs(confirmedAt) === null) {
      throw refuse('operator-confirmed activation evidence requires an ISO-8601 UTC confirmedAt');
    }
    if (typeof operatorKeyId !== 'string' || !KEY_ID_RE.test(operatorKeyId)) {
      throw refuse('operator-confirmed activation evidence requires the local operator confirmation key id');
    }
    if (typeof scopeSummaryDigest !== 'string' || !SHA256_RE.test(scopeSummaryDigest)) {
      throw refuse('operator-confirmed activation evidence requires the digest of the exact scope summary shown to the operator');
    }
    return { confirmedAt, confirmationPhrase, channel, operatorKeyId, scopeSummaryDigest };
  }
  const { adapterId, keyId, captureId, channel } = evidence;
  if (channel !== 'protected_host_boundary') {
    throw refuse("host-signed activation evidence channel must be 'protected_host_boundary'");
  }
  if (typeof adapterId !== 'string' || !adapterId.trim()) {
    throw refuse('host-signed activation evidence requires the pinned adapter id');
  }
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) {
    throw refuse('host-signed activation evidence requires the pinned host key id');
  }
  if (captureId !== null && (typeof captureId !== 'string' || !captureId.trim())) {
    throw refuse('host-signed activation evidence captureId must be null or the exact capture identity');
  }
  return { adapterId, keyId, captureId, channel };
}

/**
 * Build one unsigned task activation binding.
 *
 * @param {{
 *   grant: object,
 *   backend: 'files'|'github',
 *   taskId: string,
 *   carrier: string,
 *   taskContractDigest: string,
 *   derivation: string,
 *   decompositionSource?: object|null,
 *   bindingId?: string,
 *   issuedAt?: string,
 *   expiresAt?: string,
 * }} input
 */
export function createTaskActivationBinding(input = {}) {
  const known = [
    'grant', 'backend', 'taskId', 'carrier', 'taskContractDigest', 'derivation',
    'decompositionSource', 'bindingId', 'issuedAt', 'expiresAt',
  ];
  const unknown = Object.keys(input).filter(key => !known.includes(key));
  if (unknown.length) throw refuse(`invalid task activation binding: unknown input field(s): ${unknown.join(', ')}`);
  const grant = input.grant;
  if (!isObject(grant)) throw refuse('a task activation binding requires its authorizing grant');
  const binding = {
    kind: TASK_ACTIVATION_BINDING_KIND,
    schemaVersion: TASK_ACTIVATION_BINDING_SCHEMA_VERSION,
    bindingId: input.bindingId ?? `binding:${randomUUID()}`,
    grantId: grant.grantId ?? null,
    grantDigest: grant.digest ?? null,
    repositoryIdentity: grant.repositoryIdentity ?? null,
    backend: input.backend ?? null,
    taskId: input.taskId ?? null,
    carrier: input.carrier ?? null,
    taskContractDigest: input.taskContractDigest ?? null,
    derivation: input.derivation ?? null,
    decompositionSource: input.decompositionSource
      ? {
          sourceRef: input.decompositionSource.sourceRef ?? null,
          sourceDigest: input.decompositionSource.sourceDigest ?? null,
          scanSemanticDigest: input.decompositionSource.scanSemanticDigest ?? null,
          workUnitId: input.decompositionSource.workUnitId ?? null,
          observedAt: input.decompositionSource.observedAt ?? null,
        }
      : null,
    assurance: grant.assurance ?? null,
    issuedAt: input.issuedAt ?? grant.issuedAt ?? new Date().toISOString(),
    // A binding never outlives its grant.
    expiresAt: input.expiresAt ?? grant.expiresAt ?? null,
    authentication: null,
    digest: null,
  };
  binding.digest = taskActivationBindingDigest(binding);
  const checked = validateTaskActivationBindingShape(binding);
  if (!checked.ok) throw refuse(`invalid task activation binding: ${checked.errors[0].message}`);
  return deepFreeze(binding);
}

/** Build one target-local revocation record for an existing grant. */
export function createActivationRevocation(input = {}) {
  const known = ['grant', 'reason', 'revokedAt', 'revocationId'];
  const unknown = Object.keys(input).filter(key => !known.includes(key));
  if (unknown.length) throw refuse(`invalid activation revocation: unknown input field(s): ${unknown.join(', ')}`);
  const grant = input.grant;
  if (!isObject(grant)) throw refuse('an activation revocation requires the grant it revokes');
  const record = {
    kind: ACTIVATION_REVOCATION_KIND,
    schemaVersion: ACTIVATION_REVOCATION_SCHEMA_VERSION,
    revocationId: input.revocationId ?? grant.revocation?.id ?? `revocation:${randomUUID()}`,
    grantId: grant.grantId ?? null,
    grantDigest: grant.digest ?? null,
    repositoryIdentity: grant.repositoryIdentity ?? null,
    revokedAt: input.revokedAt ?? new Date().toISOString(),
    reason: typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'operator revocation',
  };
  const errors = [];
  validateActivationRevocationInto(record, errors);
  if (errors.length) throw refuse(`invalid activation revocation: ${errors[0].message}`);
  return deepFreeze(record);
}

// ---------------------------------------------------------------------------
// Shape validation (pure, total over any JSON value)
// ---------------------------------------------------------------------------

function fail(errors, message, evidenceState = 'malformed', code = 'activation.grant.malformed') {
  errors.push({ code, evidenceState, message });
}

/** Structural validation only. Authentication and freshness are separate. */
export function validateActivationGrantShape(grant) {
  const errors = [];
  const shapeOk = shapeErrors(grant, ACTIVATION_GRANT_FIELDS, 'activation grant', errors);
  if (grant?.kind !== ACTIVATION_GRANT_KIND) fail(errors, `activation grant kind must be '${ACTIVATION_GRANT_KIND}'`);
  if (grant?.schemaVersion !== ACTIVATION_GRANT_SCHEMA_VERSION) {
    fail(errors, `activation grant schemaVersion must be ${ACTIVATION_GRANT_SCHEMA_VERSION}`);
  }
  if (!GRANT_ID_RE.test(String(grant?.grantId ?? ''))) fail(errors, 'activation grant grantId must be grant:<uuid-v4>');
  if (typeof grant?.repositoryIdentity !== 'string' || !grant.repositoryIdentity.startsWith('file:')) {
    fail(errors, 'activation grant repositoryIdentity must be a canonical target repository identity');
  }
  if (!['files', 'github'].includes(grant?.backend)) fail(errors, 'activation grant backend must be files or github');
  if (!ACTIVATION_ASSURANCE_VALUES.has(grant?.assurance)) {
    fail(errors, 'activation grant assurance must be operator_confirmed or host_signed');
  }
  validateScopeInto(grant?.scope, errors);
  if (grant?.scope?.type === 'work_unit' && grant?.workUnitId !== grant?.scope?.workUnitId) {
    fail(errors, 'activation grant workUnitId must equal its work-unit scope identity');
  }
  if (grant?.scope?.type !== 'work_unit' && grant?.workUnitId !== null) {
    fail(errors, 'activation grant workUnitId must be null outside a work-unit scope');
  }
  if (grant?.scope?.type === 'captured_request' && grant?.operatorIntentDigest !== grant?.scope?.operatorIntentDigest) {
    fail(errors, 'activation grant operatorIntentDigest must equal its captured-request scope digest');
  }
  if (grant?.operatorIntentDigest !== null && !SHA256_RE.test(String(grant?.operatorIntentDigest ?? ''))) {
    fail(errors, 'activation grant operatorIntentDigest must be null or sha256:<64 lowercase hex>');
  }
  if (shapeErrors(grant?.producer, PRODUCER_FIELDS, 'activation grant producer', errors)) {
    if (typeof grant.producer.id !== 'string' || !grant.producer.id.trim()) {
      fail(errors, 'activation grant producer id is required');
    }
    if (!ACTIVATION_CHANNELS.includes(grant.producer.channel)) {
      fail(errors, `activation grant producer channel must be one of: ${ACTIVATION_CHANNELS.join(', ')}`);
    }
    // Assurance, producer, and channel are one consistent triple.
    if (grant.assurance === 'operator_confirmed' &&
        (grant.producer.channel !== 'cli_interactive_confirmation' || grant.producer.id !== CLI_OPERATOR_PRODUCER_ID)) {
      fail(errors, `operator-confirmed activation must be produced by '${CLI_OPERATOR_PRODUCER_ID}' over the interactive CLI channel`);
    }
    if (grant.assurance === 'host_signed' &&
        (grant.producer.channel !== 'protected_host_boundary' || grant.producer.id === CLI_OPERATOR_PRODUCER_ID)) {
      fail(errors, 'host-signed activation must be produced by a pinned host adapter over a protected host boundary');
    }
  }
  const issued = instantMs(grant?.issuedAt);
  const expires = instantMs(grant?.expiresAt);
  if (issued === null) fail(errors, 'activation grant issuedAt must be an ISO-8601 UTC instant');
  if (expires === null) fail(errors, 'activation grant expiresAt must be an ISO-8601 UTC instant');
  if (issued !== null && expires !== null) {
    if (expires <= issued) fail(errors, 'activation grant expiresAt must be later than issuedAt');
    else if (expires - issued > MAX_GRANT_TTL_SECONDS * 1000) {
      fail(errors, `activation grant lifetime must not exceed ${MAX_GRANT_TTL_SECONDS} seconds`);
    }
  }
  if (shapeErrors(grant?.revocation, REVOCATION_BINDING_FIELDS, 'activation grant revocation', errors)) {
    if (!REVOCATION_ID_RE.test(String(grant.revocation.id ?? ''))) {
      fail(errors, 'activation grant revocation id must be revocation:<uuid-v4>');
    }
    if (grant.revocation.state !== 'active') {
      fail(errors, "an issued activation grant must record revocation state 'active'", 'negative', 'activation.grant.revoked');
    }
  }
  validateGrantEvidenceInto(grant, errors);
  validateAuthenticationInto(grant?.authentication, 'activation grant', errors, { nullable: true });
  if (shapeOk) {
    const expected = activationGrantDigest(grant);
    if (expected === null || grant?.digest !== expected) {
      fail(errors, 'activation grant digest does not match its canonical semantic projection');
    }
    if (!GRANT_DIGEST_RE.test(String(grant?.digest ?? ''))) {
      fail(errors, 'activation grant digest must be a canonical semantic digest');
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateScopeInto(scope, errors) {
  if (!shapeErrors(scope, ['type', 'taskIds', 'workUnitId', 'operatorIntentDigest'], 'activation grant scope', errors)) return;
  if (!ACTIVATION_SCOPE_TYPES.includes(scope.type)) {
    fail(errors, `activation grant scope type must be one of: ${ACTIVATION_SCOPE_TYPES.join(', ')}`);
    return;
  }
  if (scope.type === 'exact_tasks') {
    if (!Array.isArray(scope.taskIds) || scope.taskIds.length === 0 ||
        scope.taskIds.some(id => typeof id !== 'string' || !TASK_ID_RE.test(id))) {
      fail(errors, 'activation grant exact_tasks scope requires canonical task ids');
    } else if (new Set(scope.taskIds).size !== scope.taskIds.length) {
      fail(errors, 'activation grant exact_tasks scope must not repeat a task id');
    } else if (scope.taskIds.some((id, index) => index > 0 && id <= scope.taskIds[index - 1])) {
      fail(errors, 'activation grant exact_tasks scope task ids must be in canonical sorted order');
    }
    if (scope.workUnitId !== null || scope.operatorIntentDigest !== null) {
      fail(errors, 'activation grant exact_tasks scope must not also claim a work unit or captured request');
    }
    return;
  }
  if (scope.type === 'work_unit') {
    if (typeof scope.workUnitId !== 'string' || !WORK_UNIT_ID_RE.test(scope.workUnitId)) {
      fail(errors, 'activation grant work_unit scope requires a canonical work-unit id');
    }
    if (scope.taskIds !== null || scope.operatorIntentDigest !== null) {
      fail(errors, 'activation grant work_unit scope must not also enumerate tasks or claim a captured request');
    }
    return;
  }
  if (typeof scope.operatorIntentDigest !== 'string' || !SHA256_RE.test(scope.operatorIntentDigest)) {
    fail(errors, 'activation grant captured_request scope requires an operator-intent SHA-256 digest');
  }
  if (scope.taskIds !== null || scope.workUnitId !== null) {
    fail(errors, 'activation grant captured_request scope must not also enumerate tasks or a work unit');
  }
}

function validateGrantEvidenceInto(grant, errors) {
  const assurance = grant?.assurance;
  const evidence = grant?.evidence;
  if (assurance === 'operator_confirmed') {
    if (!shapeErrors(evidence, ['confirmedAt', 'confirmationPhrase', 'channel', 'operatorKeyId', 'scopeSummaryDigest'],
      'operator-confirmed activation evidence', errors)) return;
    if (evidence.channel !== 'cli_interactive_confirmation') {
      fail(errors, "operator-confirmed activation evidence channel must be 'cli_interactive_confirmation'");
    }
    if (evidence.confirmationPhrase !== OPERATOR_CONFIRMATION_PHRASE) {
      fail(errors, `operator-confirmed activation evidence must record the exact confirmation phrase '${OPERATOR_CONFIRMATION_PHRASE}'`);
    }
    if (instantMs(evidence.confirmedAt) === null) {
      fail(errors, 'operator-confirmed activation evidence requires an ISO-8601 UTC confirmedAt');
    }
    if (typeof evidence.operatorKeyId !== 'string' || !KEY_ID_RE.test(evidence.operatorKeyId)) {
      fail(errors, 'operator-confirmed activation evidence requires the local operator confirmation key id');
    }
    if (typeof evidence.scopeSummaryDigest !== 'string' || !SHA256_RE.test(evidence.scopeSummaryDigest)) {
      fail(errors, 'operator-confirmed activation evidence requires the exact scope-summary digest');
    }
    return;
  }
  if (assurance === 'host_signed') {
    if (!shapeErrors(evidence, ['adapterId', 'keyId', 'captureId', 'channel'], 'host-signed activation evidence', errors)) return;
    if (evidence.channel !== 'protected_host_boundary') {
      fail(errors, "host-signed activation evidence channel must be 'protected_host_boundary'");
    }
    if (typeof evidence.adapterId !== 'string' || !evidence.adapterId.trim()) {
      fail(errors, 'host-signed activation evidence requires the pinned adapter id');
    }
    if (typeof evidence.keyId !== 'string' || !KEY_ID_RE.test(evidence.keyId)) {
      fail(errors, 'host-signed activation evidence requires the pinned host key id');
    }
    if (evidence.captureId !== null && (typeof evidence.captureId !== 'string' || !evidence.captureId.trim())) {
      fail(errors, 'host-signed activation evidence captureId must be null or the exact capture identity');
    }
  }
}

function validateAuthenticationInto(authentication, label, errors, { nullable = false } = {}) {
  if (authentication === null) {
    if (!nullable) fail(errors, `${label} requires an authentication signature`, 'missing', 'activation.grant.unauthenticated');
    return;
  }
  if (!shapeErrors(authentication, AUTHENTICATION_FIELDS, `${label} authentication`, errors)) return;
  if (authentication.algorithm !== HOST_SIGNATURE_ALGORITHM) {
    fail(errors, `${label} authentication algorithm must be '${HOST_SIGNATURE_ALGORITHM}'`);
  }
  if (typeof authentication.keyId !== 'string' || !KEY_ID_RE.test(authentication.keyId)) {
    fail(errors, `${label} authentication keyId is required`);
  }
  if (typeof authentication.value !== 'string' || !authentication.value.startsWith(`${HOST_SIGNATURE_ALGORITHM}:`)) {
    fail(errors, `${label} authentication value must be an ed25519 signature`);
  }
}

export function validateTaskActivationBindingShape(binding) {
  const errors = [];
  const shapeOk = shapeErrors(binding, TASK_ACTIVATION_BINDING_FIELDS, 'task activation binding', errors);
  if (binding?.kind !== TASK_ACTIVATION_BINDING_KIND) {
    fail(errors, `task activation binding kind must be '${TASK_ACTIVATION_BINDING_KIND}'`);
  }
  if (binding?.schemaVersion !== TASK_ACTIVATION_BINDING_SCHEMA_VERSION) {
    fail(errors, `task activation binding schemaVersion must be ${TASK_ACTIVATION_BINDING_SCHEMA_VERSION}`);
  }
  if (!BINDING_ID_RE.test(String(binding?.bindingId ?? ''))) {
    fail(errors, 'task activation binding bindingId must be binding:<uuid-v4>');
  }
  if (!GRANT_ID_RE.test(String(binding?.grantId ?? ''))) {
    fail(errors, 'task activation binding grantId must be grant:<uuid-v4>');
  }
  if (!GRANT_DIGEST_RE.test(String(binding?.grantDigest ?? ''))) {
    fail(errors, 'task activation binding grantDigest must be a canonical grant semantic digest');
  }
  if (typeof binding?.repositoryIdentity !== 'string' || !binding.repositoryIdentity.startsWith('file:')) {
    fail(errors, 'task activation binding repositoryIdentity must be a canonical target repository identity');
  }
  if (!['files', 'github'].includes(binding?.backend)) {
    fail(errors, 'task activation binding backend must be files or github');
  }
  if (!TASK_ID_RE.test(String(binding?.taskId ?? ''))) {
    fail(errors, 'task activation binding taskId is invalid');
  }
  if (typeof binding?.carrier !== 'string' || !binding.carrier.trim()) {
    fail(errors, 'task activation binding carrier is required');
  }
  if (!CONTRACT_DIGEST_RE.test(String(binding?.taskContractDigest ?? ''))) {
    fail(errors, 'task activation binding taskContractDigest must be sha256:v1:<64 lowercase hex>');
  }
  if (!ACTIVATION_DERIVATIONS.includes(binding?.derivation)) {
    fail(errors, `task activation binding derivation must be one of: ${ACTIVATION_DERIVATIONS.join(', ')}`);
  }
  if (!ACTIVATION_ASSURANCE_VALUES.has(binding?.assurance)) {
    fail(errors, 'task activation binding assurance must be operator_confirmed or host_signed');
  }
  // Derivation and assurance may not contradict each other.
  if (binding?.derivation === 'direct_protected_host_binding' && binding?.assurance !== 'host_signed') {
    fail(errors, 'a protected-host derived binding must carry host_signed assurance');
  }
  if (binding?.derivation === 'direct_operator_confirmation' && binding?.assurance !== 'operator_confirmed') {
    fail(errors, 'an operator-confirmed derived binding must carry operator_confirmed assurance');
  }
  if (binding?.derivation === 'committed_decomposition_membership') {
    if (!shapeErrors(binding?.decompositionSource, DECOMPOSITION_SOURCE_FIELDS,
      'task activation binding decompositionSource', errors)) {
      // shapeErrors already reported the fault.
    } else {
      const source = binding.decompositionSource;
      if (!safeRepositoryPath(source.sourceRef)) {
        fail(errors, 'task activation binding decompositionSource sourceRef must be a safe repository-relative path');
      }
      if (!SHA256_RE.test(String(source.sourceDigest ?? ''))) {
        fail(errors, 'task activation binding decompositionSource sourceDigest must be sha256:<64 lowercase hex>');
      }
      if (typeof source.scanSemanticDigest !== 'string' ||
          !/^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/.test(source.scanSemanticDigest)) {
        fail(errors, 'task activation binding decompositionSource scanSemanticDigest must be a canonical semantic digest');
      }
      if (typeof source.workUnitId !== 'string' || !WORK_UNIT_ID_RE.test(source.workUnitId)) {
        fail(errors, 'task activation binding decompositionSource workUnitId is required');
      }
      if (instantMs(source.observedAt) === null) {
        fail(errors, 'task activation binding decompositionSource observedAt must be an ISO-8601 UTC instant');
      }
    }
  } else if (binding?.decompositionSource !== null) {
    fail(errors, 'only a decomposition-derived binding may carry a decomposition source reference');
  }
  const issued = instantMs(binding?.issuedAt);
  const expires = instantMs(binding?.expiresAt);
  if (issued === null) fail(errors, 'task activation binding issuedAt must be an ISO-8601 UTC instant');
  if (expires === null) fail(errors, 'task activation binding expiresAt must be an ISO-8601 UTC instant');
  if (issued !== null && expires !== null && expires <= issued) {
    fail(errors, 'task activation binding expiresAt must be later than issuedAt');
  }
  validateAuthenticationInto(binding?.authentication, 'task activation binding', errors, { nullable: true });
  if (shapeOk) {
    const expected = taskActivationBindingDigest(binding);
    if (expected === null || binding?.digest !== expected) {
      fail(errors, 'task activation binding digest does not match its canonical semantic projection');
    }
    if (!BINDING_DIGEST_RE.test(String(binding?.digest ?? ''))) {
      fail(errors, 'task activation binding digest must be a canonical semantic digest');
    }
  }
  return { ok: errors.length === 0, errors };
}

function safeRepositoryPath(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some(segment => segment === '.' || segment === '..');
}

function validateActivationRevocationInto(record, errors) {
  if (!shapeErrors(record, ACTIVATION_REVOCATION_FIELDS, 'activation revocation', errors)) return;
  if (record.kind !== ACTIVATION_REVOCATION_KIND) fail(errors, `activation revocation kind must be '${ACTIVATION_REVOCATION_KIND}'`);
  if (record.schemaVersion !== ACTIVATION_REVOCATION_SCHEMA_VERSION) {
    fail(errors, `activation revocation schemaVersion must be ${ACTIVATION_REVOCATION_SCHEMA_VERSION}`);
  }
  if (!REVOCATION_ID_RE.test(String(record.revocationId ?? ''))) fail(errors, 'activation revocation revocationId must be revocation:<uuid-v4>');
  if (!GRANT_ID_RE.test(String(record.grantId ?? ''))) fail(errors, 'activation revocation grantId must be grant:<uuid-v4>');
  if (!GRANT_DIGEST_RE.test(String(record.grantDigest ?? ''))) fail(errors, 'activation revocation grantDigest must be a canonical grant semantic digest');
  if (typeof record.repositoryIdentity !== 'string' || !record.repositoryIdentity.startsWith('file:')) {
    fail(errors, 'activation revocation repositoryIdentity must be a canonical target repository identity');
  }
  if (instantMs(record.revokedAt) === null) fail(errors, 'activation revocation revokedAt must be an ISO-8601 UTC instant');
  if (typeof record.reason !== 'string' || !record.reason.trim()) fail(errors, 'activation revocation reason is required');
}

export function validateActivationRevocation(record) {
  const errors = [];
  validateActivationRevocationInto(record, errors);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Full evidence resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one task's activation authority from a grant/binding pair against
 * current, independently refetched evidence.
 *
 * Nothing here is read from the records themselves as authority: the caller
 * supplies the current repository identity, the current task identity and
 * contract digest, the verifier for the record signatures, and (for a
 * decomposition-derived binding) the current committed decomposition facts.
 *
 * @param {{
 *   grant: any,
 *   binding: any,
 *   repositoryIdentity: string,
 *   backend: string,
 *   taskId: string,
 *   carrier: string,
 *   taskContractDigest: string,
 *   verifySignature: (payload: object, signature: object, assurance: string) => boolean,
 *   revocations?: any[],
 *   decomposition?: any,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, evidenceState: string, disposition: string, errors: object[], assurance: string|null }}
 */
export function resolveTaskActivationBinding(input = {}) {
  const errors = [];
  const now = input.now ?? Date.now();
  const skew = ACTIVATION_GRANT_CLOCK_SKEW_MS;
  const grant = input.grant;
  const binding = input.binding;

  const grantShape = validateActivationGrantShape(grant);
  errors.push(...grantShape.errors);
  const bindingShape = validateTaskActivationBindingShape(binding);
  errors.push(...bindingShape.errors);
  if (errors.length) return conclude(errors, null);

  // Linkage: the binding must name this exact grant record, not merely its id.
  if (binding.grantId !== grant.grantId || binding.grantDigest !== grant.digest) {
    fail(errors, 'task activation binding does not bind this exact activation grant', 'changed', 'activation.binding.mismatch');
  }
  if (binding.assurance !== grant.assurance) {
    fail(errors, 'task activation binding assurance does not equal its grant assurance', 'malformed', 'activation.binding.mismatch');
  }

  // Repository: a grant or binding copied into another checkout is unusable.
  if (grant.repositoryIdentity !== input.repositoryIdentity) {
    fail(errors, 'activation grant was issued for a different target repository', 'changed', 'activation.grant.repository_mismatch');
  }
  if (binding.repositoryIdentity !== input.repositoryIdentity) {
    fail(errors, 'task activation binding was issued for a different target repository', 'changed', 'activation.binding.repository_mismatch');
  }

  // Task identity and exact current contract.
  if (binding.taskId !== input.taskId) {
    fail(errors, `task activation binding authorizes task '${binding.taskId}', not '${String(input.taskId)}'`, 'changed', 'activation.binding.task_mismatch');
  }
  if (binding.backend !== input.backend) {
    fail(errors, 'task activation binding backend does not match the dispatch backend', 'changed', 'activation.binding.task_mismatch');
  }
  if (binding.carrier !== input.carrier) {
    fail(errors, 'task activation binding carrier does not match the current task carrier', 'changed', 'activation.binding.task_mismatch');
  }
  if (binding.taskContractDigest !== input.taskContractDigest) {
    fail(
      errors,
      'the task contract changed after activation; re-run the activation command for the current contract',
      'changed',
      'activation.binding.stale_contract'
    );
  }

  // Grant scope must actually cover this task.
  if (grant.scope.type === 'exact_tasks' && !grant.scope.taskIds.includes(input.taskId)) {
    fail(errors, `activation grant scope does not include task '${String(input.taskId)}'`, 'negative', 'activation.grant.out_of_scope');
  }
  if (grant.scope.type === 'work_unit' && binding.derivation !== 'committed_decomposition_membership') {
    fail(errors, 'a work-unit activation grant may only derive committed-decomposition task bindings', 'negative', 'activation.grant.out_of_scope');
  }
  if (grant.scope.type === 'exact_tasks' && binding.derivation === 'committed_decomposition_membership') {
    fail(errors, 'an exact-task activation grant cannot produce a decomposition-derived binding', 'malformed', 'activation.binding.mismatch');
  }

  // Freshness and expiry, evaluated independently for grant and binding.
  const grantIssued = instantMs(grant.issuedAt);
  const grantExpires = instantMs(grant.expiresAt);
  const bindingIssued = instantMs(binding.issuedAt);
  const bindingExpires = instantMs(binding.expiresAt);
  if (grantIssued !== null && grantIssued - skew > now) {
    fail(errors, 'activation grant is issued in the future', 'malformed', 'activation.grant.malformed');
  }
  if (grantExpires !== null && grantExpires <= now) {
    fail(errors, 'activation grant has expired; re-run the activation command', 'stale', 'activation.grant.expired');
  }
  if (bindingIssued !== null && bindingIssued - skew > now) {
    fail(errors, 'task activation binding is issued in the future', 'malformed', 'activation.binding.malformed');
  }
  if (bindingExpires !== null && bindingExpires <= now) {
    fail(errors, 'task activation binding has expired; re-run the activation command', 'stale', 'activation.binding.expired');
  }
  if (grantExpires !== null && bindingExpires !== null && bindingExpires > grantExpires) {
    fail(errors, 'task activation binding cannot outlive its activation grant', 'malformed', 'activation.binding.malformed');
  }

  // Revocation. A malformed revocation record is treated as a revocation.
  for (const record of input.revocations ?? []) {
    const checked = validateActivationRevocation(record);
    if (!checked.ok) {
      fail(errors, `an activation revocation record for this target is malformed: ${checked.errors[0].message}`, 'malformed', 'activation.grant.revoked');
      continue;
    }
    if (record.grantId === grant.grantId || record.revocationId === grant.revocation.id) {
      fail(errors, `activation grant ${grant.grantId} was revoked at ${record.revokedAt}`, 'negative', 'activation.grant.revoked');
    }
  }

  // Authentication. This is the step a hand-authored target-local record cannot
  // pass: the verifying key lives outside the repository.
  if (grant.assurance === 'operator_confirmed' &&
      grant.evidence.operatorKeyId !== grant.authentication?.keyId) {
    fail(errors, 'operator-confirmed activation evidence key must equal the grant authentication key', 'malformed', 'activation.grant.unauthenticated');
  }
  if (grant.assurance === 'host_signed') {
    if (grant.producer.id !== grant.evidence.adapterId) {
      fail(errors, 'host-signed activation producer must equal the evidence adapter id', 'malformed', 'activation.grant.unauthenticated');
    }
    if (grant.producer.channel !== 'protected_host_boundary' || grant.evidence.channel !== 'protected_host_boundary') {
      fail(errors, 'host-signed activation must use the protected host boundary', 'malformed', 'activation.grant.unauthenticated');
    }
    if (grant.evidence.keyId !== grant.authentication?.keyId) {
      fail(errors, 'host-signed activation evidence key must equal the grant authentication key', 'malformed', 'activation.grant.unauthenticated');
    }
  }
  if (typeof input.verifySignature !== 'function') {
    fail(errors, 'an external activation signature verifier is required', 'missing', 'activation.grant.unauthenticated');
  } else {
    if (grant.authentication === null) {
      fail(errors, 'activation grant is unauthenticated', 'missing', 'activation.grant.unauthenticated');
    } else if (!input.verifySignature(
      activationGrantSignaturePayload(grant), grant.authentication, grant.assurance,
      { recordType: 'grant', grant, binding }
    )) {
      fail(errors, 'activation grant signature does not verify against the external operator or pinned host key', 'negative', 'activation.grant.unauthenticated');
    }
    if (binding.authentication === null) {
      fail(errors, 'task activation binding is unauthenticated', 'missing', 'activation.binding.unauthenticated');
    } else if (!input.verifySignature(
      taskActivationBindingSignaturePayload(binding), binding.authentication, binding.assurance,
      { recordType: 'binding', grant, binding }
    )) {
      fail(errors, 'task activation binding signature does not verify against the external operator or pinned host key', 'negative', 'activation.binding.unauthenticated');
    }
    if (grant.authentication !== null && binding.authentication !== null &&
        grant.authentication.keyId !== binding.authentication.keyId) {
      fail(errors, 'activation grant and task binding were signed by different keys', 'malformed', 'activation.binding.mismatch');
    }
  }

  // Decomposition derivation, when present.
  if (binding.derivation === 'committed_decomposition_membership') {
    validateDecompositionDerivation({ grant, binding, decomposition: input.decomposition, taskId: input.taskId }, errors);
  }

  return conclude(errors, grant.assurance);
}

/**
 * A work-unit grant only derives a child binding from current committed
 * decomposition evidence. Every element is rechecked here: canonical work-unit
 * match, Maintainer attribution, exact committed source reference and digest,
 * complete authoritative inventory, and canonical ready-set membership.
 */
function validateDecompositionDerivation({ grant, binding, decomposition, taskId }, errors) {
  const source = binding.decompositionSource;
  if (!isObject(decomposition)) {
    fail(errors, 'a decomposition-derived activation binding requires current committed decomposition evidence', 'missing', 'activation.binding.decomposition_missing');
    return;
  }
  if (decomposition.kind !== 'agenticloop.decomposition-provenance') {
    fail(errors, 'decomposition evidence is not a canonical decomposition provenance record', 'malformed', 'activation.binding.decomposition_invalid');
    return;
  }
  if (decomposition.authority !== 'maintainer' || decomposition.source !== 'task-decomposition') {
    fail(errors, 'decomposition-derived activation requires Maintainer-attributed task decomposition', 'negative', 'activation.binding.decomposition_invalid');
  }
  if (decomposition.sourceRef !== source.sourceRef) {
    fail(errors, 'decomposition evidence does not come from the exact committed source the binding names', 'changed', 'activation.binding.decomposition_changed');
  }
  if (decomposition.sourceDigest !== source.sourceDigest) {
    fail(errors, 'the committed decomposition source changed after activation; re-run the activation command', 'changed', 'activation.binding.decomposition_changed');
  }
  const scan = decomposition.scan;
  if (!isObject(scan)) {
    fail(errors, 'decomposition evidence carries no parallel-scan record', 'malformed', 'activation.binding.decomposition_invalid');
    return;
  }
  if (scan.semanticDigest !== source.scanSemanticDigest) {
    fail(errors, 'the bound decomposition scan changed after activation; re-run the activation command', 'changed', 'activation.binding.decomposition_changed');
  }
  if (scan.workUnit?.id !== source.workUnitId || scan.workUnit?.id !== grant.workUnitId) {
    fail(errors, 'decomposition evidence does not cover the exact work unit this grant authorizes', 'changed', 'activation.grant.out_of_scope');
  }
  if (scan.inventory?.complete !== true || scan.decomposition?.state !== 'complete') {
    fail(errors, 'decomposition-derived activation requires a complete authoritative task inventory', 'negative', 'activation.binding.decomposition_invalid');
  }
  if (!Array.isArray(scan.readyTaskIds) || !scan.readyTaskIds.includes(taskId)) {
    fail(errors, `task '${String(taskId)}' is not a member of the canonical decomposition ready set`, 'negative', 'activation.grant.out_of_scope');
  }
  if (decomposition.observedAt !== source.observedAt) {
    fail(errors, 'decomposition observation time changed after activation; re-run the activation command', 'changed', 'activation.binding.decomposition_changed');
  }
}

function conclude(errors, assurance) {
  if (errors.length === 0) {
    return { ok: true, evidenceState: 'current', disposition: 'proceed', errors: [], assurance };
  }
  const rank = state => ['missing', 'malformed', 'negative', 'changed', 'stale', 'current'].indexOf(state);
  const primary = errors.reduce((best, item) =>
    best === null || rank(item.evidenceState) < rank(best.evidenceState) ? item : best, null);
  const disposition = {
    missing: 'needs_context',
    malformed: 'rejected',
    negative: 'blocked',
    changed: 'superseded',
    stale: 'superseded',
  }[primary.evidenceState] ?? 'blocked';
  return {
    ok: false,
    evidenceState: primary.evidenceState,
    disposition,
    errors: errors.map(item => ({ ...item })),
    assurance: null,
  };
}
