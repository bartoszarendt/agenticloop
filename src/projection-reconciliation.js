/**
 * Shared backend-projection reconciliation.
 *
 * The canonical transition contract already names which facts exist, who
 * produces and persists each one, which carrier each backend uses, and how far
 * each fact's authority reaches. What was missing is an evaluator that consumes
 * *observed* carrier facts and separates three different things that all look
 * like "the backends disagree":
 *
 * 1. a legitimate difference between two facts that were never synonyms
 *    (`agent-ready` contract state beside a current runtime blocker);
 * 2. evidence that is absent, not applicable to this backend, or superseded;
 * 3. genuine drift - two current authoritative carriers of one fact reporting
 *    different values, or a current closeout marker contradicting the
 *    authoritative terminal task carrier.
 *
 * This module owns only that comparison. It reads the fact inventory from
 * `transition-contract.js` rather than restating it, never mutates a carrier,
 * and reports through the canonical `agenticloop.validation-result` envelope.
 */

import { canonicalSha256 } from './canonical-json.js';
import { createDiagnostic } from './repair-policy.js';
import {
  createValidationResult,
  deriveEvidenceState,
  dispositionForEvidenceState,
} from './result-envelope.js';
import {
  TRANSITION_BACKENDS,
  TRANSITION_CONTRACT_DEFINITION,
  TRANSITION_EVIDENCE_STATES,
  TRANSITION_FACTS,
  TRANSITION_STATE_PROVENANCE,
  deepFreeze,
} from './transition-contract.js';

export const PROJECTION_OBSERVATION_KIND = 'agenticloop.projection-observation';
export const PROJECTION_OBSERVATION_SCHEMA_VERSION = 1;
export const PROJECTION_OBSERVATION_DIGEST_DOMAIN = 'agenticloop.projection-observation.v1';
export const PROJECTION_RECONCILIATION_KIND = 'agenticloop.projection-reconciliation';
export const PROJECTION_RECONCILIATION_SCHEMA_VERSION = 1;
export const PROJECTION_RECONCILIATION_DIGEST_DOMAIN = 'agenticloop.projection-reconciliation.v1';
export const PROJECTION_RECONCILIATION_COMMAND = 'projection reconcile';

/** Every relation one observed fact can hold in a reconciliation. */
export const PROJECTION_FACT_RELATIONS = Object.freeze([
  'current',
  'not_applicable',
  'evidence_absent',
  'advisory',
  'superseded',
  'contradiction',
  'invalid',
]);

/** Every relation an explicit cross-fact invariant can report. */
export const PROJECTION_INVARIANT_RELATIONS = Object.freeze([
  'distinct_fact',
  'label_presence_only',
  'advisory',
  'agreement',
  'insufficient_evidence',
  'contradiction',
]);

export const PROJECTION_OBSERVATION_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'factId', 'backend', 'carrier', 'value', 'valueDigest',
  'evidenceState', 'authority', 'observedAt', 'invalidatedBy', 'stateProvenance',
  'sourceRef', 'transport',
]);

const CARRIER_APPLICABILITY = Object.freeze(['applicable', 'not_applicable']);
const OWNER_FIELDS = Object.freeze(['ownerKind', 'ownerId']);
const AUTHORITY_FIELDS = Object.freeze(['producer', 'persister', 'typedRecord', 'artifactBinding']);
const CARRIER_FIELDS = Object.freeze(['applicability', 'identity']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Fault kinds an observation validator can report, classified at the fault site. */
const OBSERVATION_FAULT = 'observation';
const CARRIER_FAULT = 'carrier_applicability';

/**
 * The closed normalized value shape per fact. Files and GitHub must both
 * project into these shapes, so an equivalent fact digests identically on both
 * backends and transport detail cannot change a semantic verdict.
 */
const FACT_VALUE_FIELDS = Object.freeze({
  contract_readiness: Object.freeze(['readiness', 'contractDigest']),
  runtime_blocked_state: Object.freeze(['blocked', 'transitionId', 'blockerRef']),
  task_lifecycle_status: Object.freeze(['status', 'terminal']),
  labels: Object.freeze(['names']),
  comments: Object.freeze(['recordType', 'artifactRef']),
  review_readiness: Object.freeze(['ready', 'reviewedArtifact']),
  review_verdict: Object.freeze(['verdict', 'reviewedArtifact']),
  audit_state: Object.freeze(['auditId', 'certifiedArtifact']),
  terminal_closeout: Object.freeze(['closedOut', 'coveredTaskId', 'gateDigest']),
});

/**
 * The closed cross-fact invariant inventory.
 *
 * Only a relation listed here can be reported between two different facts. A
 * difference that no invariant covers is simply two distinct facts, never an
 * inferred contradiction.
 */
const CROSS_FACT_INVARIANTS = Object.freeze([
  Object.freeze({
    invariantId: 'readiness_vs_runtime_block',
    facts: Object.freeze(['contract_readiness', 'runtime_blocked_state']),
    relation: 'distinct_fact',
    rule: 'contract readiness and a current structured runtime blocker are separate facts; a blocker never rewrites the authored contract state',
  }),
  Object.freeze({
    invariantId: 'labels_vs_contract_readiness',
    facts: Object.freeze(['labels', 'contract_readiness']),
    relation: 'label_presence_only',
    rule: 'a backend label proves label presence only; it neither rewrites readiness nor authorizes resumption',
  }),
  Object.freeze({
    invariantId: 'labels_vs_lifecycle_status',
    facts: Object.freeze(['labels', 'task_lifecycle_status']),
    relation: 'label_presence_only',
    rule: 'a backend label proves label presence only; the durable record status is the lifecycle authority',
  }),
  Object.freeze({
    invariantId: 'comments_vs_lifecycle_status',
    facts: Object.freeze(['comments', 'task_lifecycle_status']),
    relation: 'advisory',
    rule: 'a comment carrier is authoritative only for the typed record it carries; untyped prose confers no lifecycle authority',
  }),
  Object.freeze({
    invariantId: 'review_verdict_vs_review_readiness',
    facts: Object.freeze(['review_verdict', 'review_readiness']),
    relation: 'agreement',
    rule: 'a current verdict and a current readiness receipt must bind the same reviewed artifact',
    compare: (verdict, readinessValue) =>
      verdict?.reviewedArtifact === null || readinessValue?.reviewedArtifact === null
        ? null
        : verdict?.reviewedArtifact === readinessValue?.reviewedArtifact,
  }),
  Object.freeze({
    invariantId: 'terminal_closeout_vs_lifecycle_status',
    facts: Object.freeze(['terminal_closeout', 'task_lifecycle_status']),
    relation: 'agreement',
    rule: 'a current closeout marker that reports a closed unit while the authoritative task carrier is non-terminal is genuine drift',
    compare: (closeout, status) => (closeout?.closedOut === true ? status?.terminal === true : null),
  }),
]);

const FACT_DEFINITIONS = new Map(TRANSITION_CONTRACT_DEFINITION.facts.map(fact => [fact.factId, fact]));

/** The canonical fact inventory, in contract order, read from the contract. */
export const PROJECTION_FACT_IDS = Object.freeze(TRANSITION_FACTS.map(fact => fact.factId));

// The value shapes above add normalization detail the contract does not carry,
// but they may never become a second fact inventory: their key set is checked
// against the canonical one at load time so a contract change cannot drift
// silently past this module.
{
  const shaped = Object.keys(FACT_VALUE_FIELDS).sort();
  const canonical = [...PROJECTION_FACT_IDS].sort();
  if (shaped.length !== canonical.length || shaped.some((factId, index) => factId !== canonical[index])) {
    throw new Error('projection observation value shapes must cover exactly the canonical transition-contract facts');
  }
  // The invariant inventory names facts by id. A contract rename would
  // otherwise leave an invariant silently comparing a fact that no longer
  // exists, which reports `insufficient_evidence` forever instead of failing.
  for (const invariant of CROSS_FACT_INVARIANTS) {
    for (const factId of invariant.facts) {
      if (!FACT_DEFINITIONS.has(factId)) {
        throw new Error(
          `cross-fact invariant '${invariant.invariantId}' names '${factId}', which is not a canonical transition-contract fact`
        );
      }
    }
  }
}

/**
 * The facts a backend actually projects.
 *
 * Authority-sensitive reconciliation needs all of them: a conclusion drawn
 * from one observed fact while seven other applicable facts were never looked
 * at is not a reconciliation, it is a guess with a digest attached.
 *
 * @param {string} backend
 * @returns {string[]}
 */
export function requiredProjectionFactIds(backend) {
  return PROJECTION_FACT_IDS.filter(factId => FACT_DEFINITIONS.get(factId)?.carriers?.[backend]?.applicable === true);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message) {
  throw new TypeError(message);
}

function closedKeys(value, fields, label, onError) {
  if (!isPlainObject(value)) return onError(`${label} must be an object`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) return onError(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
  const missing = fields.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) return onError(`${label} is missing required fields: ${missing.join(', ')}`);
  return true;
}

function normalizedOwner(owner, label, onError) {
  if (owner === null) return null;
  if (!closedKeys(owner, OWNER_FIELDS, label, onError)) return null;
  if (typeof owner.ownerKind !== 'string' || !owner.ownerKind) onError(`${label} ownerKind is required`);
  if (typeof owner.ownerId !== 'string' || !owner.ownerId) onError(`${label} ownerId is required`);
  return { ownerKind: owner.ownerKind, ownerId: owner.ownerId };
}

/**
 * Digest the semantic value only. `transport` (issue numbers, URLs, revisions)
 * is deliberately outside the domain so an equivalent files and GitHub fact
 * produces one digest.
 */
function observationValueDigest(factId, value) {
  return `sha256:${PROJECTION_OBSERVATION_DIGEST_DOMAIN}:${canonicalSha256({ factId, value: value ?? null })}`;
}

function validateFactValue(factId, value, onError) {
  if (value === null) return null;
  const fields = FACT_VALUE_FIELDS[factId];
  if (!closedKeys(value, fields, `${factId} observation value`, onError)) return null;
  if (factId === 'labels') {
    if (!Array.isArray(value.names) || value.names.some(name => typeof name !== 'string' || !name)) {
      onError('labels observation value names must be a string array');
      return null;
    }
    return { names: [...value.names].sort() };
  }
  return Object.fromEntries(fields.map(key => [key, value[key] ?? null]));
}

function sameOwner(actual, expected) {
  return actual?.ownerKind === expected?.ownerKind && actual?.ownerId === expected?.ownerId;
}

/**
 * Build one closed observation of a single canonical fact on one carrier.
 *
 * Strict by construction: a caller that cannot supply the freshness,
 * applicability, and provenance facts does not get a silently degraded
 * observation. `reconcileProjections` accepts raw objects too and reports the
 * same problems as canonical diagnostics.
 */
export function createProjectionObservation(input = {}) {
  const observation = normalizeObservation(input, fail);
  return deepFreeze(observation);
}

/**
 * Validate a *serialized* observation record.
 *
 * Construction may fill fields in; validation may not. A record that reached
 * this process from a carrier, a file, or another tool is held to the exact
 * emitted shape: every field present, no unknown fields, the canonical kind and
 * schema version, the closed carrier/authority/value shapes, and a
 * `valueDigest` that equals the digest recomputed from its own canonical value.
 * Silently repairing any of those would let a tampered digest, a dropped kind,
 * or a re-shaped value pass as authentic evidence.
 *
 * Total over arbitrary JSON-compatible input.
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, errors: string[], observation: any|null }}
 */
export function validateProjectionObservationRecord(value) {
  const errors = [];
  const observation = normalizeSerializedObservation(value, message => {
    errors.push(message);
    return false;
  });
  return { ok: errors.length === 0, errors, observation: errors.length === 0 ? observation : null };
}

function normalizeSerializedObservation(raw, onError) {
  if (!isPlainObject(raw)) {
    onError('projection observation must be an object');
    return null;
  }
  const missing = PROJECTION_OBSERVATION_FIELDS.filter(field => !Object.hasOwn(raw, field));
  if (missing.length > 0) {
    onError(`projection observation is missing required fields: ${missing.join(', ')}`);
  }
  if (!Object.hasOwn(raw, 'kind') || raw.kind !== PROJECTION_OBSERVATION_KIND) {
    onError(`projection observation kind must be '${PROJECTION_OBSERVATION_KIND}'`);
  }
  if (!Object.hasOwn(raw, 'schemaVersion') || raw.schemaVersion !== PROJECTION_OBSERVATION_SCHEMA_VERSION) {
    onError(`projection observation schemaVersion must be ${PROJECTION_OBSERVATION_SCHEMA_VERSION}`);
  }
  const normalized = normalizeObservation(raw, onError);
  if (!normalized) return null;
  // The supplied digest is compared with the one recomputed from the record's
  // own canonical value. A record whose digest was edited, or whose value was
  // edited under a retained digest, is rejected rather than re-digested.
  if (raw.valueDigest !== normalized.valueDigest) {
    onError('projection observation valueDigest does not match the digest recomputed from its canonical fact value');
  }
  if (safeCanonical(raw.value ?? null) !== safeCanonical(normalized.value)) {
    onError('projection observation value is not in the canonical normalized shape for its fact');
  }
  for (const field of ['evidenceState', 'observedAt', 'stateProvenance']) {
    if ((raw[field] ?? null) !== normalized[field]) {
      onError(`projection observation ${field} does not match the canonical shape for its carrier applicability`);
    }
  }
  return normalized;
}

function safeCanonical(value) {
  try {
    return canonicalSha256(value);
  } catch {
    return 'uncanonicalizable';
  }
}

function normalizeObservation(input, onError) {
  if (!isPlainObject(input)) {
    onError('projection observation must be an object');
    return null;
  }
  const {
    kind = PROJECTION_OBSERVATION_KIND,
    schemaVersion = PROJECTION_OBSERVATION_SCHEMA_VERSION,
    factId,
    backend,
    carrier,
    value = null,
    evidenceState = null,
    authority = { producer: null, persister: null, typedRecord: false, artifactBinding: null },
    observedAt = null,
    invalidatedBy = [],
    stateProvenance = null,
    sourceRef = null,
    transport = null,
  } = input;
  const unknown = Object.keys(input).filter(key => !PROJECTION_OBSERVATION_FIELDS.includes(key));
  if (unknown.length > 0) onError(`projection observation contains unknown fields: ${unknown.sort().join(', ')}`);
  if (kind !== PROJECTION_OBSERVATION_KIND) onError(`projection observation kind must be '${PROJECTION_OBSERVATION_KIND}'`);
  if (schemaVersion !== PROJECTION_OBSERVATION_SCHEMA_VERSION) {
    onError(`projection observation schemaVersion must be ${PROJECTION_OBSERVATION_SCHEMA_VERSION}`);
  }
  const definition = FACT_DEFINITIONS.get(factId);
  if (!definition) {
    onError(`projection observation factId '${String(factId)}' is not a canonical transition-contract fact`);
    return null;
  }
  if (!TRANSITION_BACKENDS.includes(backend)) {
    onError(`projection observation backend '${String(backend)}' is not a supported transition backend`);
    return null;
  }
  closedKeys(carrier, CARRIER_FIELDS, 'projection observation carrier', onError);
  const applicability = carrier?.applicability;
  if (!CARRIER_APPLICABILITY.includes(applicability)) {
    onError("projection observation carrier applicability must be 'applicable' or 'not_applicable'");
    return null;
  }
  const backendApplicable = definition.carriers[backend].applicable === true;
  if (backendApplicable && applicability !== 'applicable') {
    onError(`the ${backend} backend projects '${factId}'; a non-applicable carrier does not describe it`, CARRIER_FAULT);
  }
  if (!backendApplicable && applicability === 'applicable') {
    onError(`the ${backend} backend does not project '${factId}'; its carrier is not applicable, not missing`, CARRIER_FAULT);
  }

  closedKeys(authority, AUTHORITY_FIELDS, 'projection observation authority', onError);
  const normalizedAuthority = {
    producer: normalizedOwner(authority?.producer ?? null, 'projection observation authority producer', onError),
    persister: normalizedOwner(authority?.persister ?? null, 'projection observation authority persister', onError),
    typedRecord: authority?.typedRecord === true,
    artifactBinding: typeof authority?.artifactBinding === 'string' && authority.artifactBinding
      ? authority.artifactBinding
      : null,
  };
  if (authority?.typedRecord !== undefined && typeof authority.typedRecord !== 'boolean') {
    onError('projection observation authority typedRecord must be a boolean');
  }
  if (!Array.isArray(invalidatedBy) || invalidatedBy.some(item => typeof item !== 'string' || !item)) {
    onError('projection observation invalidatedBy must be an array of non-empty strings');
  }
  if (transport !== null && !isPlainObject(transport)) {
    onError('projection observation transport must be null or an object');
  }
  if (sourceRef !== null && (typeof sourceRef !== 'string' || !sourceRef)) {
    onError('projection observation sourceRef must be null or a non-empty string');
  }

  if (applicability === 'not_applicable') {
    if (carrier?.identity !== null) onError('a non-applicable projection carrier has no identity');
    if (value !== null) onError('a non-applicable projection carrier carries no value');
    if (evidenceState !== null) onError('a non-applicable projection carrier has no evidence state');
    if (observedAt !== null) onError('a non-applicable projection carrier has no observation time');
    if (stateProvenance !== null) onError('a non-applicable projection carrier classifies no observed state');
  } else {
    if (typeof carrier?.identity !== 'string' || !carrier.identity) {
      onError('projection observation carrier identity is required for an applicable carrier');
    }
    if (!TRANSITION_EVIDENCE_STATES.includes(evidenceState)) {
      onError(`projection observation evidenceState must be one of: ${TRANSITION_EVIDENCE_STATES.join(', ')}`);
    }
    if (typeof observedAt !== 'string' || !ISO_INSTANT.test(observedAt)) {
      onError('projection observation observedAt must be an ISO-8601 UTC instant');
    }
    if (!TRANSITION_STATE_PROVENANCE.includes(stateProvenance)) {
      onError(`projection observation stateProvenance must be one of: ${TRANSITION_STATE_PROVENANCE.join(', ')}`);
    }
    if (Array.isArray(invalidatedBy) && invalidatedBy.length === 0) {
      onError('projection observation invalidatedBy must name at least one invalidation condition');
    }
    // Host-local state is admissible on any host, but only with generic
    // recorded provenance. Without it the honest classification is
    // unexplained drift, which the caller must declare explicitly.
    if (stateProvenance === 'host_local_state' && !sourceRef) {
      onError('projection observation host_local_state requires a recorded provenance reference in sourceRef');
    }
    if (evidenceState === 'current' && value === null) {
      onError(`current evidence for '${factId}' must carry a non-null canonical fact value`);
    }
    if (evidenceState === 'missing' && value !== null) {
      onError(`missing evidence for '${factId}' must not carry a fact value`);
    }
    const untypedAdvisoryComment = factId === 'comments' && authority?.typedRecord !== true;
    if (evidenceState !== 'missing' && !untypedAdvisoryComment) {
      if (!sameOwner(normalizedAuthority.producer, definition.producer)) {
        onError(
          `projection observation authority producer for '${factId}' must be ` +
          `${definition.producer.ownerKind}:${definition.producer.ownerId}`
        );
      }
      if (!sameOwner(normalizedAuthority.persister, definition.persister)) {
        onError(
          `projection observation authority persister for '${factId}' must be ` +
          `${definition.persister.ownerKind}:${definition.persister.ownerId}`
        );
      }
      if (authority?.typedRecord !== true) {
        onError(`authoritative evidence for '${factId}' must carry a typed record`);
      }
    }
  }

  const normalizedValue = validateFactValue(factId, value, onError);
  return {
    kind: PROJECTION_OBSERVATION_KIND,
    schemaVersion: PROJECTION_OBSERVATION_SCHEMA_VERSION,
    factId,
    backend,
    carrier: { applicability, identity: carrier?.identity ?? null },
    value: normalizedValue,
    valueDigest: applicability === 'not_applicable' ? null : observationValueDigest(factId, normalizedValue),
    evidenceState: applicability === 'not_applicable' ? null : evidenceState,
    authority: normalizedAuthority,
    observedAt: applicability === 'not_applicable' ? null : observedAt,
    invalidatedBy: Array.isArray(invalidatedBy) ? [...invalidatedBy] : [],
    stateProvenance: applicability === 'not_applicable' ? null : stateProvenance,
    sourceRef: sourceRef ?? null,
    transport: transport ?? null,
  };
}

function diagnostic(level, code, evidence, message) {
  return createDiagnostic({ level, code, evidence, message });
}

function relationForEvidenceState(state) {
  if (state === 'current') return 'current';
  if (state === 'stale' || state === 'changed') return 'superseded';
  if (state === 'missing') return 'evidence_absent';
  return 'invalid';
}

/**
 * Reconcile observed carrier facts for one backend.
 *
 * Comparison is bounded by the canonical fact definitions and the closed
 * cross-fact invariant inventory above. Every other difference between carriers
 * is reported as what it is - two distinct facts - rather than promoted into a
 * contradiction.
 *
 * @param {{ backend: string, observations?: any[] }} input
 */
export function reconcileProjections(input = {}) {
  const { backend, observations = [] } = input;
  const diagnostics = [];
  const warnings = [];

  if (!TRANSITION_BACKENDS.includes(backend)) {
    diagnostics.push(diagnostic('error', 'projection.observation.invalid', { state: 'malformed' },
      `projection reconciliation backend '${String(backend)}' is not a supported transition backend`));
    return finish(backend, diagnostics, warnings, [], [], []);
  }
  if (!Array.isArray(observations)) {
    diagnostics.push(diagnostic('error', 'projection.observation.invalid', { state: 'malformed' },
      'projection reconciliation observations must be an array'));
    return finish(backend, diagnostics, warnings, [], [], []);
  }
  if (observations.length === 0) {
    diagnostics.push(diagnostic('error', 'evidence.missing', { state: 'missing' },
      'projection reconciliation requires at least one observed carrier fact'));
  }

  const normalized = [];
  for (const [index, raw] of observations.entries()) {
    // Faults are classified where they happen and carry their own code; the
    // evaluator never infers a fault kind by matching English error prose.
    // Supplied records are *validated*, never repaired: a missing kind, an
    // absent schema version, or a tampered digest is a finding, not something
    // this evaluator fills in on the record's behalf.
    const faults = [];
    const observation = normalizeSerializedObservation(raw, (message, fault = OBSERVATION_FAULT) => {
      faults.push({ message, fault });
      return false;
    });
    for (const { message, fault } of faults) {
      diagnostics.push(diagnostic(
        'error',
        fault === CARRIER_FAULT ? 'projection.carrier.not_applicable' : 'projection.observation.invalid',
        { state: 'malformed', index },
        message,
      ));
    }
    if (observation && faults.length === 0) normalized.push(observation);
  }

  const byFact = new Map(PROJECTION_FACT_IDS.map(factId => [factId, []]));
  for (const observation of normalized) {
    if (observation.backend !== backend) {
      diagnostics.push(diagnostic('error', 'projection.observation.invalid', { state: 'malformed' },
        `observation of '${observation.factId}' names backend '${observation.backend}' inside a '${backend}' reconciliation`));
      continue;
    }
    byFact.get(observation.factId).push(observation);
  }

  const facts = [];
  const contradictions = [];
  const unexplainedDrift = [];
  const currentValueByFact = new Map();
  const requiredFacts = requiredProjectionFactIds(backend);
  const missingRequiredFacts = [];

  for (const factId of PROJECTION_FACT_IDS) {
    const definition = FACT_DEFINITIONS.get(factId);
    const applicable = definition.carriers[backend].applicable === true;
    const observed = byFact.get(factId);

    // Applicability is resolved first. A non-applicable fact has a null carrier
    // identity by contract, and two null identities are not "the same carrier"
    // - reporting them as a duplicate would invent a carrier collision out of
    // the absence of carriers.
    if (!applicable) {
      facts.push(factRow(factId, definition, 'not_applicable', null, null, null, observed.length));
      continue;
    }

    const identities = observed.map(item => item.carrier.identity);
    if (new Set(identities).size !== identities.length) {
      diagnostics.push(diagnostic('error', 'projection.observation.invalid', { state: 'malformed', factId },
        `fact '${factId}' has more than one observation of the same carrier identity`));
    }

    if (observed.length === 0) {
      missingRequiredFacts.push(factId);
      diagnostics.push(diagnostic('error', 'evidence.missing', { state: 'missing', factId },
        `the ${backend} backend projects '${factId}', but the reconciliation observed no carrier for it; ` +
        'authority-sensitive conclusions require the complete applicable fact set'));
      facts.push(factRow(factId, definition, 'evidence_absent', null, null, null, 0));
      continue;
    }

    for (const observation of observed) {
      if (observation.stateProvenance === 'unexplained_drift') {
        if (!unexplainedDrift.includes(factId)) unexplainedDrift.push(factId);
        diagnostics.push(diagnostic('error', 'projection.state.unexplained', { state: 'negative', factId },
          `observed state on carrier '${observation.carrier.identity}' for fact '${factId}' is unexplained drift and blocks authority-sensitive conclusions`));
      }
      if (observation.stateProvenance === 'host_local_state') {
        warnings.push(diagnostic('warning', 'state.host_local', { state: 'current', factId },
          `fact '${factId}' carrier '${observation.carrier.identity}' is host-local state with recorded provenance '${observation.sourceRef}'`));
      }
      if (observation.evidenceState !== 'current' && observation.evidenceState !== 'missing') {
        diagnostics.push(diagnostic('error', 'projection.evidence.superseded', { state: observation.evidenceState, factId },
          `fact '${factId}' carrier '${observation.carrier.identity}' evidence is ${observation.evidenceState} and is superseded, not current`));
      }
      if (observation.evidenceState === 'missing') {
        diagnostics.push(diagnostic('error', 'evidence.missing', { state: 'missing', factId },
          `fact '${factId}' carrier '${observation.carrier.identity}' evidence is missing`));
      }
    }

    const current = observed.filter(item => item.evidenceState === 'current');
    // A comment carrier speaks only for the typed record it carries. Untyped
    // prose is advisory: it neither certifies nor contradicts any fact.
    const untyped = current.filter(item => factId === 'comments' && !item.authority.typedRecord);
    for (const observation of untyped) {
      warnings.push(diagnostic('warning', 'projection.authority.untyped', { state: 'current', factId },
        `carrier '${observation.carrier.identity}' carries no typed record and confers no authority for '${factId}'`));
    }
    const authoritative = current.filter(item => !untyped.includes(item));

    const digests = new Set(authoritative.map(item => item.valueDigest));
    if (digests.size > 1) {
      contradictions.push({
        factId,
        invariantId: null,
        detail: `carriers ${authoritative.map(item => `'${item.carrier.identity}'`).sort().join(' and ')} report different current values for '${factId}'`,
      });
      diagnostics.push(diagnostic('error', 'projection.fact.contradiction', { state: 'negative', factId },
        `fact '${factId}' has contradictory current authoritative carriers`));
    }

    const selected = authoritative[0] ?? current[0] ?? observed[0];
    if (authoritative.length > 0) currentValueByFact.set(factId, authoritative[0].value);
    const relation = digests.size > 1
      ? 'contradiction'
      : authoritative.length > 0
        ? 'current'
        : untyped.length > 0
          ? 'advisory'
          : relationForEvidenceState(selected.evidenceState);
    facts.push(factRow(
      factId,
      definition,
      relation,
      selected.evidenceState,
      selected.stateProvenance,
      selected.valueDigest,
      observed.length,
    ));
  }

  const invariants = [];
  for (const invariant of CROSS_FACT_INVARIANTS) {
    const [leftId, rightId] = invariant.facts;
    const leftFact = facts.find(item => item.factId === leftId);
    const rightFact = facts.find(item => item.factId === rightId);
    if (leftFact.relation !== 'current' || rightFact.relation !== 'current') {
      invariants.push({ invariantId: invariant.invariantId, facts: [leftId, rightId], relation: 'insufficient_evidence', rule: invariant.rule });
      continue;
    }
    if (!invariant.compare) {
      invariants.push({ invariantId: invariant.invariantId, facts: [leftId, rightId], relation: invariant.relation, rule: invariant.rule });
      continue;
    }
    const verdict = invariant.compare(currentValueByFact.get(leftId), currentValueByFact.get(rightId));
    if (verdict === null) {
      invariants.push({ invariantId: invariant.invariantId, facts: [leftId, rightId], relation: 'insufficient_evidence', rule: invariant.rule });
      continue;
    }
    if (verdict === true) {
      invariants.push({ invariantId: invariant.invariantId, facts: [leftId, rightId], relation: 'agreement', rule: invariant.rule });
      continue;
    }
    invariants.push({ invariantId: invariant.invariantId, facts: [leftId, rightId], relation: 'contradiction', rule: invariant.rule });
    contradictions.push({ factId: null, invariantId: invariant.invariantId, detail: invariant.rule });
    diagnostics.push(diagnostic('error', 'projection.fact.contradiction', { state: 'negative', factId: leftId },
      `'${leftId}' and '${rightId}' contradict each other: ${invariant.rule}`));
  }

  return finish(backend, diagnostics, warnings, facts, invariants, contradictions, unexplainedDrift, {
    requiredFacts,
    missingRequiredFacts,
  });
}

/**
 * One reconciliation row.
 *
 * Producer, persister, authority, canonical source, and the freshness rule are
 * read from the canonical fact definition and restated here, so a consumer
 * reading the record never has to guess who owns a fact or what makes its
 * evidence current - and never has a second place to state it differently.
 */
function factRow(factId, definition, relation, evidenceState, stateProvenance, valueDigest, observationCount) {
  return {
    factId,
    relation,
    producer: { ...definition.producer },
    persister: { ...definition.persister },
    authority: definition.authority,
    canonicalSource: definition.canonicalSource,
    freshnessRule: definition.freshness,
    evidenceState: evidenceState ?? null,
    stateProvenance: stateProvenance ?? null,
    valueDigest: valueDigest ?? null,
    observationCount,
  };
}

function finish(backend, diagnostics, warnings, facts, invariants, contradictions, unexplainedDrift = [], coverage = {}) {
  const requiredFacts = coverage.requiredFacts ?? (TRANSITION_BACKENDS.includes(backend) ? requiredProjectionFactIds(backend) : []);
  const missingRequiredFacts = coverage.missingRequiredFacts ?? [...requiredFacts];
  const errors = diagnostics.filter(item => item.level === 'error');
  const evidenceState = deriveEvidenceState(errors) ?? (errors.length === 0 ? 'current' : 'negative');
  const disposition = errors.length === 0 ? 'proceed' : dispositionForEvidenceState(evidenceState);
  // Partial reconciliation is representable - the fact rows still say exactly
  // what was and was not observed - but a conclusion that depends on authority
  // stays blocked until the whole required fact set is present.
  const authoritySensitiveConclusion =
    contradictions.length > 0 || unexplainedDrift.length > 0 || errors.length > 0 ||
    missingRequiredFacts.length > 0
      ? 'blocked'
      : 'available';

  // The verdict is deliberately backend-neutral: it carries the reconciliation
  // outcome and the exact drift found, not each carrier's applicability. Files
  // has no label carrier and GitHub does; that difference is a transport fact,
  // not a different semantic answer, so it must not change this digest.
  const verdict = {
    ok: errors.length === 0,
    evidenceState,
    disposition,
    authoritySensitiveConclusion,
    missingRequiredFacts: [...missingRequiredFacts],
    contradictions: [...contradictions]
      .map(item => ({ factId: item.factId ?? null, invariantId: item.invariantId ?? null }))
      .sort((left, right) => (`${left.factId}|${left.invariantId}` < `${right.factId}|${right.invariantId}` ? -1 : 1)),
  };

  const record = {
    kind: PROJECTION_RECONCILIATION_KIND,
    schemaVersion: PROJECTION_RECONCILIATION_SCHEMA_VERSION,
    backend,
    facts,
    invariants,
    contradictions,
    unexplainedDrift,
    requiredFacts: [...requiredFacts],
    missingRequiredFacts: [...missingRequiredFacts],
    authoritySensitiveConclusion,
    verdictDigest: `sha256:${PROJECTION_RECONCILIATION_DIGEST_DOMAIN}:${canonicalSha256(verdict)}`,
    digest: null,
  };
  record.digest = `sha256:${PROJECTION_RECONCILIATION_DIGEST_DOMAIN}:${canonicalSha256({ ...record, digest: null })}`;

  const result = createValidationResult({
    command: PROJECTION_RECONCILIATION_COMMAND,
    ok: errors.length === 0,
    evidenceState,
    disposition,
    diagnostics: errors,
    warningDiagnostics: warnings,
  });
  return { ok: errors.length === 0, result, reconciliation: deepFreeze(record) };
}
