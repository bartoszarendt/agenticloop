/**
 * Canonical handoff recognition.
 *
 * Publishing `task prepare-dispatch` and `task verify-return` is not the same
 * as requiring them. This module is the single shared, host-neutral seam that
 * decides whether presented handoff evidence may authorize a protected
 * lifecycle transition, and it fails closed: absent, malformed, stale,
 * replayed, mismatched, unsupported, and unauthenticated evidence stay distinct
 * states, and none of them is recognition.
 *
 * Everything else a session can produce - a raw host subagent invocation, a
 * model-authored return, an operator paraphrase of one - remains observable
 * evidence graded exactly `session_reported`. Agentic Loop cannot stop a host
 * from making such a call; it can refuse to let the call satisfy a protected
 * handoff contract, and that refusal lives here rather than in any backend or
 * adapter. Files and GitHub hand this seam the same normalized evidence and
 * receive the same verdict; installed adapters project the verdict instead of
 * restating it.
 *
 * This is a pure evaluator. It owns no transport, no scheduler, no second
 * transition engine, and it never mutates durable state.
 */

import { canonicalSha256 } from './canonical-json.js';
// Role start authenticates the exact retained packet through the same closed
// sealed-decision contract prepared-packet validation produces, defined one
// layer below both so neither boundary owns a second copy of it.
import {
  PREPARED_DISPATCH_VALIDATION_KIND,
  PREPARED_DISPATCH_VALIDATION_SCHEMA_VERSION,
  createPreparedDispatchValidation,
  preparedDispatchValidationDigest,
  validatePreparedDispatchValidation,
} from './dispatch-eligibility.js';

export {
  PREPARED_DISPATCH_VALIDATION_KIND,
  PREPARED_DISPATCH_VALIDATION_SCHEMA_VERSION,
  createPreparedDispatchValidation,
  preparedDispatchValidationDigest,
  validatePreparedDispatchValidation,
};
import { createDiagnostic } from './repair-policy.js';
import { deriveEvidenceState, dispositionForEvidenceState } from './result-envelope.js';
import {
  DISPATCH_PREPARATION_KIND,
  DISPATCH_PREPARATION_SCHEMA_VERSION,
  dispatchPreparationDigest,
  legacyDispatchPreparationDigest,
  validateRoleReturn,
} from './dispatch-envelope.js';
import {
  RETURN_VERIFICATION_KIND,
  RETURN_VERIFICATION_SCHEMA_VERSION,
  listReturnVerifications,
  selectCurrentReturnVerifications,
  validateReturnVerification,
} from './return-verification.js';
import {
  RETURN_USE_FRESHNESS_POLICY,
  validateReturnUseFreshnessPolicy,
} from './return-use-freshness.js';

export const HANDOFF_RECOGNITION_KIND = 'agenticloop.handoff-recognition';
export const HANDOFF_RECOGNITION_SCHEMA_VERSION = 2;
/** Maximum age of a return that may authorize a new protected transition. */
/** @deprecated Use RETURN_USE_FRESHNESS_POLICY; retained as a source-compatible value. */
export const HANDOFF_RETURN_MAX_AGE_SECONDS = RETURN_USE_FRESHNESS_POLICY.maxAgeSeconds;

/**
 * The digest domain is derived from the schema version so the two can never
 * drift: a v1 verdict is only ever digested and compared in the v1 domain.
 */
export const HANDOFF_RECOGNITION_DIGEST_DOMAIN =
  `${HANDOFF_RECOGNITION_KIND}.v${HANDOFF_RECOGNITION_SCHEMA_VERSION}`;

/** The two canonical mechanisms a protected transition can require. */
export const HANDOFF_REQUIREMENTS = Object.freeze(['prepared_dispatch', 'verified_return']);

/**
 * The closed inventory of protected lifecycle transitions.
 *
 * `role_start` is the one boundary a prepared dispatch owns: no role may be
 * recognized as authoritatively started without a fresh canonical packet. Every
 * later boundary consumes a role result, so each requires a canonical verified
 * return. `claim` names the transition-contract lifecycle claim the transition
 * feeds, or null when the transition authorizes a mutation rather than a claim.
 */
export const PROTECTED_HANDOFF_TRANSITIONS = Object.freeze({
  role_start: Object.freeze({ requirement: 'prepared_dispatch', claim: null }),
  review_entry: Object.freeze({ requirement: 'verified_return', claim: 'implementation_ready_for_review' }),
  acceptance: Object.freeze({ requirement: 'verified_return', claim: 'review_accepted' }),
  integration: Object.freeze({ requirement: 'verified_return', claim: null }),
  closeout: Object.freeze({ requirement: 'verified_return', claim: 'closeout_complete' }),
});

export const PROTECTED_HANDOFF_TRANSITION_IDS =
  Object.freeze(Object.keys(PROTECTED_HANDOFF_TRANSITIONS));

/**
 * The grade every unauthenticated observation receives. It is a constant, not a
 * ceiling a caller may raise: an observation that claims a higher grade is
 * normalized back to this value and the claim is reported.
 */
export const HANDOFF_OBSERVATION_GRADE = 'session_reported';

/** Return assurance grades, weakest first. */
export const HANDOFF_RETURN_GRADES = Object.freeze(['session_reported', 'host_receipt']);

/** Activation assurance grades, weakest first. */
export const HANDOFF_ACTIVATION_GRADES =
  Object.freeze(['session_reported', 'operator_confirmed', 'host_signed']);

/** Every typed root diagnostic this seam can emit. */
export const HANDOFF_RECOGNITION_CODES = Object.freeze([
  'handoff.transition.unsupported',
  'handoff.expectation.malformed',
  'handoff.evidence.missing',
  'handoff.evidence.malformed',
  'handoff.evidence.stale',
  'handoff.evidence.replayed',
  'handoff.evidence.mismatched',
  'handoff.evidence.unsupported',
  'handoff.evidence.unauthenticated',
]);

/** The closed expectation a caller binds recognition to. */
export const HANDOFF_EXPECTATION_FIELDS = Object.freeze([
  'backend', 'taskId', 'roleId', 'invocationId', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest',
  'packetId', 'packetDigest', 'workUnitIdentity', 'productBaseHead', 'productHead', 'workflowHead', 'candidateHead', 'worktreeRoot',
  'repositoryIdentity', 'minimumActivationAssurance', 'minimumReturnAssurance',
  'returnUseFreshnessPolicy',
]);

/** The closed recognition verdict. */
export const HANDOFF_RECOGNITION_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'transition', 'requirement', 'recognized',
  'evidenceState', 'disposition', 'observedGrade', 'authenticated',
  'boundIdentity', 'observations', 'diagnostics', 'digest',
]);

/** The closed shape of one graded, non-authoritative observation. */
export const HANDOFF_OBSERVATION_FIELDS =
  Object.freeze(['label', 'grade', 'claimedGrade', 'authoritative']);

/** Canonical evidence states and dispositions a verdict may report. */
const HANDOFF_EVIDENCE_STATES =
  Object.freeze(['current', 'missing', 'malformed', 'stale', 'negative', 'changed']);
const HANDOFF_DISPOSITIONS =
  Object.freeze(['proceed', 'blocked', 'needs_context', 'rejected', 'superseded']);

/** The closed identity a recognized handoff binds. */
export const HANDOFF_BOUND_IDENTITY_FIELDS = Object.freeze([
  'backend', 'taskId', 'roleId', 'invocationId', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest',
  'packetId', 'packetDigest', 'workUnitIdentity', 'productBaseHead', 'productHead', 'workflowHead', 'candidateHead', 'worktreeRoot',
  'repositoryIdentity', 'returnId', 'returnGrade',
]);

/**
 * Future-instant tolerance. Recognition compares recorded instants against a
 * caller-supplied clock, and a small skew is ordinary in distributed capture;
 * anything beyond it is evidence issued for a future that has not happened.
 */
export const HANDOFF_CLOCK_SKEW_MS = 5 * 60 * 1000;

const SUPPORTED_BACKENDS = Object.freeze(['files', 'github']);
const OBSERVATION_LABEL_MAX = 200;
const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isObject(value) && Object.keys(value).length === expected.length &&
    Object.keys(value).every(key => expected.includes(key));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function gradeMeets(actual, minimum, ladder) {
  const actualIndex = ladder.indexOf(actual);
  const minimumIndex = ladder.indexOf(minimum);
  if (actualIndex < 0 || minimumIndex < 0) return false;
  return actualIndex >= minimumIndex;
}

/**
 * The work-unit identity a packet binds. Schema 6 flattens it onto the
 * decomposition binding; authentic prior packets carry it under the scan, and
 * `return-verification` reads the same two shapes. Recognition accepts both so
 * a legacy packet reports its real work unit instead of a spurious mismatch.
 */
function packetWorkUnitIdentity(packet) {
  return packet?.decomposition?.workUnitId
    ?? packet?.decomposition?.scan?.workUnit?.id
    ?? packet?.decomposition?.workUnit?.id
    ?? null;
}

function diagnostic(code, state, message, evidence = {}) {
  return createDiagnostic({
    code,
    message,
    evidence: { state, ...evidence },
  });
}

/**
 * Normalize and validate the closed expectation.
 *
 * `backend`, `taskId`, and `roleId` are always required: recognition that does
 * not know which task and which role it is deciding for cannot bind anything.
 * Every other field is optional and is compared only when the caller supplies
 * it, so a caller proves exactly the identity it actually holds instead of
 * being pushed into inventing a value it cannot know.
 *
 * @param {unknown} input
 * @returns {{ok: boolean, expectation: object|null, errors: string[]}}
 */
export function createHandoffExpectation(input) {
  const errors = [];
  if (!isObject(input)) {
    return { ok: false, expectation: null, errors: ['handoff expectation must be an object'] };
  }
  // v1 callers may still pass the retired ambiguous labels. They are accepted
  // only at this parser boundary and normalized before any verdict is emitted;
  // persisted v2 expectations and bound identities never serialize them.
  const legacyFields = new Set(['carrierDigest', 'artifactHead']);
  const unknown = Object.keys(input).filter(key => !HANDOFF_EXPECTATION_FIELDS.includes(key) && !legacyFields.has(key));
  if (unknown.length > 0) {
    errors.push(`handoff expectation has unknown field(s): ${unknown.sort().join(', ')}`);
  }
  const normalized = {
    ...input,
    dispatchCarrierDigest: input.dispatchCarrierDigest ?? input.carrierDigest,
    productBaseHead: input.productBaseHead ?? input.artifactHead,
  };
  if (!SUPPORTED_BACKENDS.includes(normalized.backend)) {
    errors.push(`handoff expectation backend must be one of: ${SUPPORTED_BACKENDS.join(', ')}`);
  }
  if (!nonEmptyString(normalized.taskId)) errors.push('handoff expectation taskId is required');
  if (!nonEmptyString(normalized.roleId)) errors.push('handoff expectation roleId is required');
  for (const field of [
    'invocationId', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest', 'packetId', 'packetDigest',
    'workUnitIdentity', 'productBaseHead', 'productHead', 'workflowHead', 'candidateHead', 'worktreeRoot', 'repositoryIdentity',
  ]) {
    const value = normalized[field];
    if (value !== undefined && value !== null && !nonEmptyString(value)) {
      errors.push(`handoff expectation ${field} must be a non-empty string when supplied`);
    }
  }
  if (normalized.minimumActivationAssurance !== undefined && normalized.minimumActivationAssurance !== null &&
      !HANDOFF_ACTIVATION_GRADES.includes(normalized.minimumActivationAssurance)) {
    errors.push(`handoff expectation minimumActivationAssurance must be one of: ${HANDOFF_ACTIVATION_GRADES.join(', ')}`);
  }
  if (normalized.minimumReturnAssurance !== undefined && normalized.minimumReturnAssurance !== null &&
      !HANDOFF_RETURN_GRADES.includes(normalized.minimumReturnAssurance)) {
    errors.push(`handoff expectation minimumReturnAssurance must be one of: ${HANDOFF_RETURN_GRADES.join(', ')}`);
  }
  if (normalized.returnUseFreshnessPolicy !== undefined && normalized.returnUseFreshnessPolicy !== null &&
      (!isObject(normalized.returnUseFreshnessPolicy) || !Number.isSafeInteger(normalized.returnUseFreshnessPolicy.maxAgeSeconds))) {
    errors.push('handoff expectation returnUseFreshnessPolicy must be a policy object when supplied');
  }
  if (errors.length > 0) return { ok: false, expectation: null, errors };
  const expectation = {};
  for (const field of HANDOFF_EXPECTATION_FIELDS) {
    expectation[field] = normalized[field] === undefined ? null : normalized[field];
  }
  return { ok: true, expectation: Object.freeze(expectation), errors: [] };
}

/**
 * Grade one observation of a handoff that did not travel the canonical path.
 *
 * The grade is fixed. A caller that hands in `{ grade: 'host_receipt' }` gets
 * `session_reported` back with `claimedGrade` recording what was asserted, so
 * an unauthenticated claim stays visible instead of quietly becoming true.
 *
 * @param {unknown} observation
 * @returns {{label: string, grade: string, claimedGrade: string|null, authoritative: false}}
 */
export function gradeObservedHandoffEvidence(observation) {
  const source = isObject(observation) ? observation : {};
  const rawLabel = typeof source.label === 'string' ? source.label : String(source.label ?? 'unlabeled observation');
  const claimed = typeof source.grade === 'string' ? source.grade : null;
  return Object.freeze({
    label: rawLabel.trim().slice(0, OBSERVATION_LABEL_MAX) || 'unlabeled observation',
    grade: HANDOFF_OBSERVATION_GRADE,
    claimedGrade: claimed === HANDOFF_OBSERVATION_GRADE ? null : claimed,
    authoritative: false,
  });
}

/** Deterministic digest of one validated recognition verdict. */
export function handoffRecognitionDigest(record) {
  const projection = { ...record };
  delete projection.digest;
  return `sha256:${HANDOFF_RECOGNITION_DIGEST_DOMAIN}:${canonicalSha256(projection)}`;
}

/**
 * Validate one recognition verdict's own structure and internal consistency.
 *
 * The digest here is an unkeyed integrity check over the verdict's canonical
 * projection, exactly like every other semantic digest in this repository. It
 * proves the record was not altered after it was produced; it does not prove
 * who produced it, and a caller that constructs a consistent verdict and seals
 * it with `handoffRecognitionDigest` will pass. That is deliberate: this is an
 * in-process evaluator, and the authenticity question it exists to answer is
 * asked of the evidence it consumes - the prepared dispatch and the verified
 * return, which carry their own host-authenticated provenance. Never treat a
 * verdict that crossed a trust boundary as authority; re-derive it there from
 * the evidence instead.
 *
 * @param {unknown} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateHandoffRecognition(record) {
  const errors = [];
  if (!exactKeys(record, HANDOFF_RECOGNITION_FIELDS)) {
    return { ok: false, errors: ['handoff recognition fields must equal the closed schema'] };
  }
  if (record.kind !== HANDOFF_RECOGNITION_KIND) errors.push(`handoff recognition kind must be '${HANDOFF_RECOGNITION_KIND}'`);
  if (record.schemaVersion !== HANDOFF_RECOGNITION_SCHEMA_VERSION) {
    errors.push(`handoff recognition schemaVersion must be ${HANDOFF_RECOGNITION_SCHEMA_VERSION}`);
  }
  if (!PROTECTED_HANDOFF_TRANSITION_IDS.includes(record.transition) && record.transition !== null) {
    errors.push('handoff recognition transition is not a protected lifecycle transition');
  }
  if (record.requirement !== null && !HANDOFF_REQUIREMENTS.includes(record.requirement)) {
    errors.push('handoff recognition requirement is invalid');
  }
  if (typeof record.recognized !== 'boolean') errors.push('handoff recognition recognized must be a boolean');
  if (typeof record.authenticated !== 'boolean') errors.push('handoff recognition authenticated must be a boolean');
  if (!exactKeys(record.boundIdentity, HANDOFF_BOUND_IDENTITY_FIELDS)) {
    errors.push('handoff recognition boundIdentity must equal the closed schema');
  }
  if (!Array.isArray(record.observations) || !Array.isArray(record.diagnostics)) {
    errors.push('handoff recognition observations and diagnostics must be arrays');
  }
  if (!HANDOFF_EVIDENCE_STATES.includes(record.evidenceState)) {
    errors.push('handoff recognition evidenceState is not a canonical evidence state');
  }
  if (!HANDOFF_DISPOSITIONS.includes(record.disposition)) {
    errors.push('handoff recognition disposition is not a canonical disposition');
  }
  if (exactKeys(record.boundIdentity, HANDOFF_BOUND_IDENTITY_FIELDS) &&
      Object.values(record.boundIdentity).some(value => value !== null && typeof value !== 'string')) {
    errors.push('handoff recognition boundIdentity values must be strings or null');
  }
  if (Array.isArray(record.observations) && record.observations.some(item =>
    !exactKeys(item, HANDOFF_OBSERVATION_FIELDS) ||
    typeof item.label !== 'string' || !item.label ||
    (item.claimedGrade !== null && typeof item.claimedGrade !== 'string'))) {
    errors.push('handoff recognition observations must equal the closed observation schema');
  }
  if (Array.isArray(record.diagnostics) &&
      record.diagnostics.some(item => !HANDOFF_RECOGNITION_CODES.includes(item?.code))) {
    errors.push('handoff recognition diagnostics must use the closed root diagnostic codes');
  }
  if (Array.isArray(record.observations) &&
      record.observations.some(item => item?.grade !== HANDOFF_OBSERVATION_GRADE || item?.authoritative !== false)) {
    errors.push(`handoff recognition observations are always '${HANDOFF_OBSERVATION_GRADE}' and never authoritative`);
  }
  // Recognition and diagnostics are one fact stated twice; they may not
  // disagree. A verdict that recognizes a handoff while reporting why it could
  // not is the exact shape a caller would misread as permission.
  if (record.recognized === true && Array.isArray(record.diagnostics) && record.diagnostics.length > 0) {
    errors.push('a recognized handoff cannot carry recognition diagnostics');
  }
  if (record.recognized === false && Array.isArray(record.diagnostics) && record.diagnostics.length === 0) {
    errors.push('an unrecognized handoff must state at least one typed diagnostic');
  }
  if (record.recognized === true && record.evidenceState !== 'current') {
    errors.push("a recognized handoff must report evidenceState 'current'");
  }
  if (record.recognized === true && record.disposition !== 'proceed') {
    errors.push("a recognized handoff must report disposition 'proceed'");
  }
  if (record.recognized === true && record.observedGrade === null) {
    errors.push('a recognized handoff must name the grade of the evidence it consumed');
  }
  // The two mechanisms grade different things and their ladders never mix: a
  // prepared dispatch reports how its activation was authenticated, a verified
  // return reports how the producing role identity was. Only the top of the
  // relevant ladder is authenticated recognition.
  const ladder = record.requirement === 'prepared_dispatch' ? HANDOFF_ACTIVATION_GRADES : HANDOFF_RETURN_GRADES;
  const authenticatedGrade = record.requirement === 'prepared_dispatch' ? 'host_signed' : 'host_receipt';
  if (record.observedGrade !== null && !ladder.includes(record.observedGrade)) {
    errors.push(`handoff recognition observedGrade '${String(record.observedGrade)}' is not a grade of its declared requirement`);
  }
  if (record.authenticated === true && record.observedGrade !== authenticatedGrade) {
    errors.push(`only '${authenticatedGrade}' evidence may report authenticated recognition`);
  }
  if (record.digest !== handoffRecognitionDigest(record)) errors.push('handoff recognition digest is invalid');
  return { ok: errors.length === 0, errors };
}

function boundIdentity(values = {}) {
  const identity = {};
  for (const field of HANDOFF_BOUND_IDENTITY_FIELDS) {
    identity[field] = values[field] === undefined ? null : values[field];
  }
  return identity;
}

function verdict({ transition, requirement, diagnostics, observations, identity, observedGrade, authenticated }) {
  const recognized = diagnostics.length === 0;
  const evidenceState = recognized ? 'current' : (deriveEvidenceState(diagnostics) ?? 'negative');
  const record = {
    kind: HANDOFF_RECOGNITION_KIND,
    schemaVersion: HANDOFF_RECOGNITION_SCHEMA_VERSION,
    transition,
    requirement,
    recognized,
    evidenceState,
    disposition: recognized ? 'proceed' : dispositionForEvidenceState(evidenceState),
    observedGrade: observedGrade ?? null,
    authenticated: recognized ? authenticated === true : false,
    boundIdentity: boundIdentity(identity),
    observations,
    diagnostics,
    digest: null,
  };
  record.digest = handoffRecognitionDigest(record);
  return Object.freeze(record);
}

/**
 * Compare one bound identity field, appending a mismatch diagnostic when the
 * caller supplied an expectation the evidence does not satisfy.
 */
/**
 * The base a role return binds when it carries an abandoned attempt's product
 * work, and only when the return states that claim self-consistently.
 */
function carriedProductBase(roleReturn) {
  const carried = roleReturn?.productLineage?.carriedBaseHead ?? null;
  return carried !== null && carried === roleReturn?.productBaseHead ? carried : null;
}

function bind(field, expected, actual, diagnostics, label) {
  if (expected === null || expected === undefined) return actual ?? null;
  if (expected !== actual) {
    diagnostics.push(diagnostic(
      'handoff.evidence.mismatched',
      'negative',
      `${label} '${String(actual ?? '(absent)')}' does not match the expected ${field} '${String(expected)}'`,
      { field, expected: String(expected), observed: actual === undefined || actual === null ? null : String(actual) }
    ));
  }
  return actual ?? null;
}

function instantMs(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // A canonical instant round-trips exactly; a value that only parses is a
  // different string wearing a timestamp's shape.
  return new Date(parsed).toISOString() === value ? parsed : null;
}

/**
 * Evaluate freshness for one recorded observation instant against its own
 * declared policy, or an explicit caller override.
 */
function evaluateFreshness({ observedAt, maxAgeSeconds, now, label, diagnostics }) {
  const observed = instantMs(observedAt);
  if (observed === null) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `${label} does not carry a canonical UTC observation instant`,
      { field: 'observedAt', observed: observedAt === undefined ? null : String(observedAt) }
    ));
    return;
  }
  if (observed > now + HANDOFF_CLOCK_SKEW_MS) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `${label} was observed in the future at ${observedAt}`,
      { field: 'observedAt', observed: observedAt }
    ));
    return;
  }
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `${label} does not declare a usable freshness policy`,
      { field: 'freshnessPolicy' }
    ));
    return;
  }
  if (now - observed > maxAgeSeconds * 1000) {
    diagnostics.push(diagnostic(
      'handoff.evidence.stale', 'stale',
      `${label} was observed at ${observedAt}, outside its ${maxAgeSeconds}s freshness policy`,
      { field: 'observedAt', observed: observedAt, maxAgeSeconds }
    ));
  }
}

function recognizePreparedDispatch({
  packet, expectation, consumedPacketIds, now, maxEvidenceAgeSeconds,
  validatePreparedDispatch, diagnostics,
}) {
  if (expectation.minimumActivationAssurance === null) {
    // A caller that cannot state the activation assurance its policy requires
    // cannot recognize a role start: the alternative is measuring the packet
    // against a minimum the packet itself declared.
    diagnostics.push(diagnostic(
      'handoff.expectation.malformed', 'malformed',
      'role-start recognition requires an explicit minimumActivationAssurance from current operator policy',
      { field: 'minimumActivationAssurance' }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (packet === null || packet === undefined) {
    diagnostics.push(diagnostic(
      'handoff.evidence.missing', 'missing',
      'no canonical prepared dispatch was supplied; an authoritative role start requires a fresh ' +
      "'agenticloop task prepare-dispatch' result"
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (!isObject(packet) || packet.kind !== DISPATCH_PREPARATION_KIND) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `supplied role-start evidence is not an '${DISPATCH_PREPARATION_KIND}' record`,
      { field: 'kind', observed: isObject(packet) ? String(packet.kind ?? '(absent)') : null }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (packet.schemaVersion !== DISPATCH_PREPARATION_SCHEMA_VERSION) {
    // An authentic prior packet is stale and regenerable. An unrecognizable
    // version is unsupported: this boundary cannot prove what it would mean.
    const legacyDigest = legacyDispatchPreparationDigest(packet, packet?.schemaVersion);
    if (legacyDigest !== null && legacyDigest === packet.digest) {
      diagnostics.push(diagnostic(
        'handoff.evidence.stale', 'stale',
        `prepared dispatch uses retired schemaVersion ${packet.schemaVersion}; regenerate it as schemaVersion ${DISPATCH_PREPARATION_SCHEMA_VERSION}`,
        { field: 'schemaVersion', observed: String(packet.schemaVersion) }
      ));
    } else {
      diagnostics.push(diagnostic(
        'handoff.evidence.unsupported', 'malformed',
        `prepared dispatch declares unsupported schemaVersion ${String(packet.schemaVersion)}`,
        { field: 'schemaVersion', observed: String(packet.schemaVersion) }
      ));
    }
    return { identity: { packetId: packet.packetId ?? null }, grade: null, authenticated: false };
  }
  if (!SEMANTIC_DIGEST_RE.test(String(packet.digest ?? '')) ||
      dispatchPreparationDigest(packet) !== packet.digest) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      'prepared dispatch digest does not match its own canonical projection',
      { field: 'digest', observed: packet.digest === undefined ? null : String(packet.digest) }
    ));
    return { identity: { packetId: packet.packetId ?? null }, grade: null, authenticated: false };
  }
  if (typeof validatePreparedDispatch !== 'function') {
    diagnostics.push(diagnostic(
      'handoff.expectation.malformed', 'malformed',
      'role-start recognition requires the canonical dispatch validator',
      { field: 'validatePreparedDispatch' }
    ));
    return { identity: { packetId: packet.packetId ?? null }, grade: null, authenticated: false };
  }
  const checked = validatePreparedDispatch(packet);
  const receipt = validatePreparedDispatchValidation(checked, packet);
  if (!receipt.ok) {
    for (const error of receipt.errors) {
      diagnostics.push(diagnostic('handoff.evidence.malformed', 'malformed', String(error), { field: 'packetValidation' }));
    }
    return { identity: { packetId: packet.packetId ?? null }, grade: null, authenticated: false };
  }
  if (!checked.ok) {
    for (const error of checked.errors) {
      diagnostics.push(diagnostic('handoff.evidence.malformed', 'malformed', String(error), { field: 'packet' }));
    }
  }
  if (Array.isArray(consumedPacketIds) && consumedPacketIds.includes(packet.packetId)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.replayed', 'stale',
      `prepared dispatch '${packet.packetId}' was already consumed; a role start requires a fresh packet`,
      { field: 'packetId', observed: String(packet.packetId) }
    ));
  }
  evaluateFreshness({
    observedAt: packet.decomposition?.observedAt,
    maxAgeSeconds: Number.isFinite(maxEvidenceAgeSeconds)
      ? maxEvidenceAgeSeconds
      : Number(packet.decomposition?.freshnessPolicy?.maxAgeSeconds),
    now,
    label: 'prepared dispatch',
    diagnostics,
  });

  const identity = {
    backend: bind('backend', expectation.backend, packet.backend, diagnostics, 'prepared dispatch backend'),
    taskId: bind('taskId', expectation.taskId, packet.task?.id, diagnostics, 'prepared dispatch task'),
    roleId: bind('roleId', expectation.roleId, packet.assignment?.roleId, diagnostics, 'prepared dispatch assigned role'),
    invocationId: bind('invocationId', expectation.invocationId, packet.assignment?.invocationId, diagnostics, 'prepared dispatch invocation'),
    taskContractDigest: bind('taskContractDigest', expectation.taskContractDigest, packet.task?.taskContractDigest, diagnostics, 'prepared dispatch task-contract digest'),
    dispatchCarrierDigest: bind('dispatchCarrierDigest', expectation.dispatchCarrierDigest, packet.task?.dispatchCarrierDigest, diagnostics, 'prepared dispatch dispatch carrier digest'),
    currentCarrierDigest: null,
    packetId: bind('packetId', expectation.packetId, packet.packetId, diagnostics, 'prepared dispatch packet'),
    packetDigest: bind('packetDigest', expectation.packetDigest, packet.digest, diagnostics, 'prepared dispatch packet digest'),
    workUnitIdentity: bind('workUnitIdentity', expectation.workUnitIdentity, packetWorkUnitIdentity(packet), diagnostics, 'prepared dispatch work unit'),
    productBaseHead: bind('productBaseHead', expectation.productBaseHead, packet.repository?.head, diagnostics, 'prepared dispatch product base head'),
    productHead: null,
    workflowHead: null,
    candidateHead: null,
    worktreeRoot: bind('worktreeRoot', expectation.worktreeRoot, packet.repository?.worktree, diagnostics, 'prepared dispatch worktree'),
    repositoryIdentity: bind(
      'repositoryIdentity', expectation.repositoryIdentity,
      packet.activationBinding?.grant?.repositoryIdentity ?? packet.activation?.repositoryIdentity,
      diagnostics, 'prepared dispatch repository identity'
    ),
    returnId: null,
    returnGrade: null,
  };

  const assurance = packet.assurance;
  if (!isObject(assurance)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      'prepared dispatch carries no assurance record', { field: 'assurance' }
    ));
    return { identity, grade: null, authenticated: false };
  }
  // The required minimum is the caller's current operator policy, never the
  // packet's own declaration. A packet that names its own floor would otherwise
  // be judged by a number it wrote itself.
  const minimum = expectation.minimumActivationAssurance;
  if (!HANDOFF_ACTIVATION_GRADES.includes(assurance.activation)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unsupported', 'malformed',
      `prepared dispatch declares unsupported activation assurance '${String(assurance.activation)}'`,
      { field: 'assurance.activation', observed: String(assurance.activation) }
    ));
  } else if (!gradeMeets(assurance.activation, minimum, HANDOFF_ACTIVATION_GRADES)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      `prepared dispatch activation assurance '${assurance.activation}' is below the required minimum '${String(minimum)}'`,
      { field: 'assurance.activation', observed: assurance.activation, expected: String(minimum) }
    ));
  }
  if (expectation.minimumReturnAssurance !== null &&
      !gradeMeets(assurance.minimumReturn, expectation.minimumReturnAssurance, HANDOFF_RETURN_GRADES)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      `prepared dispatch requires return assurance '${String(assurance.minimumReturn)}', below the required minimum '${expectation.minimumReturnAssurance}'`,
      { field: 'assurance.minimumReturn', observed: String(assurance.minimumReturn), expected: expectation.minimumReturnAssurance }
    ));
  }
  return {
    identity,
    grade: HANDOFF_ACTIVATION_GRADES.includes(assurance.activation) ? assurance.activation : null,
    authenticated: assurance.activation === 'host_signed',
  };
}

function recognizeVerifiedReturn({
  verification, expectation, now, maxEvidenceAgeSeconds, validateVerifiedReturn,
  validatePreparedDispatch, diagnostics,
}) {
  if (expectation.minimumReturnAssurance === null) {
    diagnostics.push(diagnostic(
      'handoff.expectation.malformed', 'malformed',
      'return recognition requires an explicit minimumReturnAssurance from current operator policy',
      { field: 'minimumReturnAssurance' }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (verification === null || verification === undefined) {
    diagnostics.push(diagnostic(
      'handoff.evidence.missing', 'missing',
      'no canonical verified return was supplied; this transition requires a persisted ' +
      "'agenticloop task verify-return' result"
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (!isObject(verification) || verification.kind !== RETURN_VERIFICATION_KIND) {
    // A raw role return, a role-return-shaped object, or model prose handed in
    // here is not a near miss: nothing verified it, so it is a different kind of
    // thing entirely and is named as such.
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `supplied return evidence is not an '${RETURN_VERIFICATION_KIND}' record; a role return is not its own verification`,
      { field: 'kind', observed: isObject(verification) ? String(verification.kind ?? '(absent)') : null }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (verification.schemaVersion !== RETURN_VERIFICATION_SCHEMA_VERSION) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unsupported', 'malformed',
      `return verification declares unsupported schemaVersion ${String(verification.schemaVersion)}`,
      { field: 'schemaVersion', observed: String(verification.schemaVersion) }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  const structural = validateReturnVerification(verification, { now });
  if (!structural.ok) {
    for (const error of structural.errors) {
      diagnostics.push(diagnostic('handoff.evidence.malformed', 'malformed', String(error), { field: 'verification' }));
    }
    return { identity: {}, grade: null, authenticated: false };
  }
  if (verification.disposition !== 'successful_current') {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      'a blocked role return is an observation and cannot authorize a protected lifecycle transition',
      { field: 'disposition', observed: verification.disposition }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (verification.requiredCheckEvidenceAssurance === 'authenticated_receipt' && (
    verification.observedReturnGrade !== 'host_receipt' || verification.producerAuthentication === null
  )) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      'return verification claims authenticated execution assurance without host-verified producer identity',
      { field: 'requiredCheckEvidenceAssurance' }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  // An authenticated receipt is never self-authenticating merely because its
  // persisted projection is structurally valid.  The only raw API escape hatch
  // is an injected authority which must re-resolve external trust and prove the
  // signed producer/execution receipts plus the exact committed replay binding.
  // Stored/public callers supply that authority through the protected host
  // boundary; callers that do not have one fail closed here.
  if (verification.requiredCheckEvidenceAssurance === 'authenticated_receipt' &&
      typeof validateVerifiedReturn !== 'function') {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      'authenticated return recognition requires current external verification of trusted adapter, signed receipts, and committed replay state',
      { field: 'validateVerifiedReturn' }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  const roleReturn = verification.evidence?.roleReturn;
  const roleReturnValidation = validateRoleReturn(roleReturn);
  if (!roleReturnValidation.ok) {
    for (const error of roleReturnValidation.errors) {
      diagnostics.push(diagnostic(
        'handoff.evidence.malformed', 'malformed',
        `embedded role return rejected: ${String(error)}`,
        { field: 'evidence.roleReturn' }
      ));
    }
    return { identity: {}, grade: null, authenticated: false };
  }
  // A verification record is internally consistent by construction: its own
  // validator compares its fields against the packet embedded inside it, which
  // says nothing about whether that packet was ever prepared. The two halves of
  // this seam therefore ask the same question of the same artifact - the
  // embedded packet must still digest to the identity the record claims, and
  // must still satisfy the canonical dispatch validator - so a record someone
  // wrote by hand fails here exactly as a fabricated packet fails at role start.
  const embeddedPacket = verification.evidence?.packet;
  if (dispatchPreparationDigest(embeddedPacket) !== verification.packetDigest ||
      embeddedPacket?.digest !== verification.packetDigest) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      'the packet embedded in this return verification does not digest to the packet identity the record claims',
      { field: 'packetDigest', observed: String(verification.packetDigest) }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  if (typeof validatePreparedDispatch !== 'function') {
    diagnostics.push(diagnostic(
      'handoff.expectation.malformed', 'malformed',
      'return recognition requires the canonical dispatch validator so the consumed packet can be revalidated',
      { field: 'validatePreparedDispatch' }
    ));
    return { identity: {}, grade: null, authenticated: false };
  }
  const packetValidation = validatePreparedDispatch(embeddedPacket);
  const packetReceipt = validatePreparedDispatchValidation(packetValidation, embeddedPacket);
  if (!packetReceipt.ok) {
    for (const error of packetReceipt.errors) {
      diagnostics.push(diagnostic('handoff.evidence.malformed', 'malformed', String(error), { field: 'packetValidation' }));
    }
    return { identity: {}, grade: null, authenticated: false };
  }
  if (!packetValidation.ok) {
    for (const error of packetValidation.errors) {
      diagnostics.push(diagnostic('handoff.evidence.malformed', 'malformed', String(error), { field: 'packet' }));
    }
    return { identity: {}, grade: null, authenticated: false };
  }
  if (typeof validateVerifiedReturn === 'function') {
    // Structural validity proves the record is intact, never that the world it
    // describes still holds. The caller owns that refetch; its failures are
    // reported as supplied and default to stale rather than malformed.
    let checked;
    try {
      checked = validateVerifiedReturn(verification);
    } catch (error) {
      checked = {
        ok: false,
        errors: [`verified return external revalidation failed: ${error.message}`],
        evidenceState: 'stale',
      };
    }
    if (!checked?.ok) {
      const state = checked?.evidenceState === 'malformed' ? 'malformed' : 'stale';
      const code = state === 'malformed' ? 'handoff.evidence.malformed' : 'handoff.evidence.stale';
      for (const error of checked?.errors ?? ['verified return failed canonical revalidation']) {
        diagnostics.push(diagnostic(code, state, String(error), { field: 'verification' }));
      }
    }
  }
  const policy = validateReturnUseFreshnessPolicy(expectation.returnUseFreshnessPolicy ?? RETURN_USE_FRESHNESS_POLICY);
  if (!policy.ok) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `return-use freshness policy is unusable: ${policy.errors.join('; ')}`,
      { field: 'returnUseFreshnessPolicy' }
    ));
  } else if (maxEvidenceAgeSeconds !== null && maxEvidenceAgeSeconds !== undefined &&
      (!Number.isFinite(maxEvidenceAgeSeconds) || maxEvidenceAgeSeconds <= 0)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      'return recognition received an unusable maximum evidence age',
      { field: 'maxEvidenceAgeSeconds' }
    ));
  } else {
    evaluateFreshness({
      observedAt: verification.verifiedAt,
      // Compatibility callers may tighten this bound for an immediate retry;
      // they can never extend the versioned return-use policy.
      maxAgeSeconds: Math.min(
        (expectation.returnUseFreshnessPolicy ?? RETURN_USE_FRESHNESS_POLICY).maxAgeSeconds,
        maxEvidenceAgeSeconds ?? (expectation.returnUseFreshnessPolicy ?? RETURN_USE_FRESHNESS_POLICY).maxAgeSeconds
      ),
      now,
      label: 'verified return',
      diagnostics,
    });
  }

  const identity = {
    backend: bind('backend', expectation.backend, verification.backend, diagnostics, 'verified return backend'),
    taskId: bind('taskId', expectation.taskId, verification.taskId, diagnostics, 'verified return task'),
    roleId: bind('roleId', expectation.roleId, verification.producerRole, diagnostics, 'verified return producing role'),
    invocationId: bind('invocationId', expectation.invocationId, verification.evidence?.packet?.assignment?.invocationId, diagnostics, 'verified return invocation'),
    taskContractDigest: bind('taskContractDigest', expectation.taskContractDigest, verification.taskContractDigest, diagnostics, 'verified return task-contract digest'),
    dispatchCarrierDigest: bind('dispatchCarrierDigest', expectation.dispatchCarrierDigest, roleReturn?.task?.dispatchCarrierDigest, diagnostics, 'verified return dispatch carrier digest'),
    currentCarrierDigest: bind('currentCarrierDigest', expectation.currentCarrierDigest, roleReturn?.task?.currentCarrierDigest, diagnostics, 'verified return current carrier digest'),
    packetId: bind('packetId', expectation.packetId, verification.packetId, diagnostics, 'verified return packet'),
    packetDigest: bind('packetDigest', expectation.packetDigest, verification.packetDigest, diagnostics, 'verified return packet digest'),
    workUnitIdentity: bind('workUnitIdentity', expectation.workUnitIdentity, verification.workUnitIdentity, diagnostics, 'verified return work unit'),
    // A return that carries the product work of a previous, explicitly
    // abandoned attempt binds that attempt's base rather than the packet base a
    // caller derives from the dispatch consumption. The claim is re-derived
    // from durable attempt records and reproved against Git at every
    // verification boundary, including the replay each protected transition
    // runs; this seam only has to stop expecting the packet base from a return
    // that explicitly and self-consistently declares another one.
    productBaseHead: bind(
      'productBaseHead',
      carriedProductBase(roleReturn) ?? expectation.productBaseHead,
      roleReturn?.productBaseHead,
      diagnostics,
      'verified return product base head'
    ),
    productHead: bind('productHead', expectation.productHead, roleReturn?.productHead, diagnostics, 'verified return product head'),
    workflowHead: bind('workflowHead', expectation.workflowHead, roleReturn?.workflowHead, diagnostics, 'verified return workflow head'),
    candidateHead: bind('candidateHead', expectation.candidateHead, roleReturn?.candidateHead, diagnostics, 'verified return candidate head'),
    worktreeRoot: bind('worktreeRoot', expectation.worktreeRoot, roleReturn?.worktree, diagnostics, 'verified return worktree'),
    repositoryIdentity: bind('repositoryIdentity', expectation.repositoryIdentity, verification.repositoryIdentity, diagnostics, 'verified return repository identity'),
    returnId: roleReturn?.returnId ?? null,
    returnGrade: verification.observedReturnGrade ?? null,
  };

  const grade = verification.observedReturnGrade;
  const minimum = expectation.minimumReturnAssurance;
  if (!HANDOFF_RETURN_GRADES.includes(grade)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unsupported', 'malformed',
      `verified return declares unsupported assurance grade '${String(grade)}'`,
      { field: 'observedReturnGrade', observed: String(grade) }
    ));
  } else if (!gradeMeets(grade, minimum, HANDOFF_RETURN_GRADES)) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      `verified return assurance '${grade}' is below the required minimum '${minimum}'; ` +
      'the producing role identity was not host-authenticated',
      { field: 'observedReturnGrade', observed: grade, expected: minimum }
    ));
  }
  return {
    identity,
    grade: HANDOFF_RETURN_GRADES.includes(grade) ? grade : null,
    authenticated: verification.evidence?.producerIdentityAuthenticated === true && grade === 'host_receipt',
  };
}

/**
 * Decide whether presented handoff evidence authorizes one protected lifecycle
 * transition.
 *
 * The verdict is the whole answer: `recognized` is true only when the required
 * canonical mechanism was consumed, its record is intact, its freshness holds,
 * every expectation the caller supplied is bound, and its assurance meets the
 * required minimum. Otherwise the verdict carries typed root diagnostics that
 * keep missing, malformed, stale, replayed, mismatched, unsupported, and
 * unauthenticated apart, and the caller must not mutate durable lifecycle state.
 *
 * @param {{
 *   transition: string,
 *   expectation: object,
 *   preparedDispatch?: object|null,
 *   verifiedReturn?: object|null,
 *   observations?: Array<any>,
 *   consumedPacketIds?: string[],
 *   now?: number,
 *   maxEvidenceAgeSeconds?: number|null,
 *   validatePreparedDispatch?: ((packet: any) => {ok: boolean, errors?: string[]})|null,
 *   validateVerifiedReturn?: ((record: any) => {ok: boolean, errors?: string[], evidenceState?: string})|null,
 *   priorDiagnostics?: object[],
 * }} input
 *
 * `validatePreparedDispatch` is the canonical dispatch validator and is required
 * by both requirements: a prepared dispatch is validated directly, and a
 * verified return has the packet it consumed revalidated the same way.
 * `priorDiagnostics` carries typed diagnostics the caller already derived while
 * resolving the evidence; entries are filtered to the closed vocabulary and can
 * only tighten a verdict, never grant one.
 * @returns {object} frozen closed recognition verdict
 */
export function recognizeHandoff({
  transition,
  expectation,
  preparedDispatch = null,
  verifiedReturn = null,
  observations = [],
  consumedPacketIds = [],
  now = Date.now(),
  maxEvidenceAgeSeconds = null,
  validatePreparedDispatch = null,
  validateVerifiedReturn = null,
  priorDiagnostics = [],
} = {}) {
  const graded = (Array.isArray(observations) ? observations : []).map(gradeObservedHandoffEvidence);
  // Diagnostics a caller already derived while resolving the evidence - an
  // unreadable store, a set of competing records - travel into the one closed
  // verdict instead of becoming a second answer beside it.
  const diagnostics = (Array.isArray(priorDiagnostics) ? priorDiagnostics : [])
    .filter(item => HANDOFF_RECOGNITION_CODES.includes(item?.code));
  const definition = Object.hasOwn(PROTECTED_HANDOFF_TRANSITIONS, String(transition))
    ? PROTECTED_HANDOFF_TRANSITIONS[String(transition)]
    : null;
  if (!definition) {
    diagnostics.push(diagnostic(
      'handoff.transition.unsupported', 'malformed',
      `'${String(transition)}' is not a protected lifecycle transition; expected one of: ${PROTECTED_HANDOFF_TRANSITION_IDS.join(', ')}`,
      { field: 'transition', observed: String(transition) }
    ));
    return verdict({
      transition: null, requirement: null, diagnostics, observations: graded,
      identity: {}, observedGrade: null, authenticated: false,
    });
  }
  const normalized = createHandoffExpectation(expectation);
  if (!normalized.ok) {
    for (const error of normalized.errors) {
      diagnostics.push(diagnostic('handoff.expectation.malformed', 'malformed', error, { field: 'expectation' }));
    }
    return verdict({
      transition: String(transition), requirement: definition.requirement, diagnostics,
      observations: graded, identity: {}, observedGrade: null, authenticated: false,
    });
  }

  const evaluated = definition.requirement === 'prepared_dispatch'
    ? recognizePreparedDispatch({
      packet: preparedDispatch,
      expectation: normalized.expectation,
      consumedPacketIds,
      now,
      maxEvidenceAgeSeconds,
      validatePreparedDispatch,
      diagnostics,
    })
    : recognizeVerifiedReturn({
      verification: verifiedReturn,
      expectation: normalized.expectation,
      now,
      maxEvidenceAgeSeconds,
      validateVerifiedReturn,
      validatePreparedDispatch,
      diagnostics,
    });

  // Naming the observations explicitly keeps the refusal honest: the caller did
  // present something, and what it presented is graded, non-authoritative
  // evidence rather than nothing at all.
  if (diagnostics.length > 0 && graded.length > 0) {
    diagnostics.push(diagnostic(
      'handoff.evidence.unauthenticated', 'negative',
      `${graded.length} observed handoff report(s) are graded '${HANDOFF_OBSERVATION_GRADE}' and cannot authorize ` +
      `the '${String(transition)}' transition`,
      { field: 'observations', observed: HANDOFF_OBSERVATION_GRADE }
    ));
  }

  return verdict({
    transition: String(transition),
    requirement: definition.requirement,
    diagnostics,
    observations: graded,
    identity: evaluated.identity,
    observedGrade: evaluated.grade,
    authenticated: evaluated.authenticated,
  });
}

/**
 * Recognize the current verified return for one protected transition, read from
 * the target's canonical return-verification store.
 *
 * This is the store-reading companion to `recognizeHandoff`, kept separate so
 * the evaluator itself stays pure. Resolution failures are typed before the
 * verdict is closed: an unreadable or malformed stored record is `malformed`,
 * competing current records are `stale`, and a store that simply holds nothing
 * for this identity is `missing`. None of them is recognition.
 *
 * @param {{target: string, transition: string, expectation: object,
 *          now?: number, maxEvidenceAgeSeconds?: number|null,
 *          validateVerifiedReturn?: ((record: any) => any)|null}} input
 * @returns {object} frozen closed recognition verdict
 */
export function recognizeStoredReturnHandoff({
  target,
  transition,
  expectation,
  now = Date.now(),
  maxEvidenceAgeSeconds = null,
  validateVerifiedReturn = null,
  validatePreparedDispatch = null,
  returnVerificationContext = null,
} = {}) {
  const normalized = createHandoffExpectation(expectation);
  if (!normalized.ok) return recognizeHandoff({ transition, expectation, now });
  const priorDiagnostics = [];
  let record = null;
  try {
    const listed = listReturnVerifications(target, normalized.expectation.taskId, {
      taskContractDigest: normalized.expectation.taskContractDigest,
      workUnitIdentity: normalized.expectation.workUnitIdentity,
      ...(returnVerificationContext ?? {}),
    });
    for (const error of listed.errors ?? []) {
      const name = String(error).split(':', 1)[0];
      const lifecycle = (listed.diagnostics ?? []).find(item => item.name === name);
      priorDiagnostics.push(diagnostic(
        'handoff.evidence.malformed', 'malformed',
        `stored return verification is unusable: ${error}`, {
          field: 'verification',
          ...(lifecycle ? { reason: lifecycle.reason, observedVersion: lifecycle.observedVersion } : {}),
        }
      ));
    }
    const selected = selectCurrentReturnVerifications(listed.records ?? []);
    if (!selected.ok) {
      for (const error of selected.errors ?? []) {
        priorDiagnostics.push(diagnostic(
          'handoff.evidence.stale', 'stale',
          `no single current return verification could be selected: ${error}`, { field: 'verification' }
        ));
      }
    } else if (selected.records.length === 1) {
      record = selected.records[0];
    }
  } catch (error) {
    priorDiagnostics.push(diagnostic(
      'handoff.evidence.malformed', 'malformed',
      `return-verification store could not be read: ${error.message}`, { field: 'verification' }
    ));
  }
  return recognizeHandoff({
    transition,
    expectation,
    verifiedReturn: record,
    now,
    maxEvidenceAgeSeconds,
    validateVerifiedReturn,
    validatePreparedDispatch,
    priorDiagnostics,
  });
}
