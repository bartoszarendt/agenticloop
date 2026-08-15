/** Privacy-clean operational measurement contract. No raw logs or transcripts. */

import { canonicalSha256 } from './canonical-json.js';

export const OPERATIONAL_MEASUREMENT_KIND = 'agenticloop.operational-measurement';
export const OPERATIONAL_MEASUREMENT_SCHEMA_VERSION = 1;

export const OPERATIONAL_COUNTERS = Object.freeze([
  'dispatchAttempts', 'evidenceRefreshes', 'packetRemints', 'typedRefusals',
  'advancedManualInputs', 'returnRejections', 'metadataOnlyRounds',
  'destructiveCleanupRecommendations',
]);
export const OPERATIONAL_MILESTONES = Object.freeze([
  'authorizationToPreflight', 'preflightToPacket', 'packetToHostAdmission',
  'roleStartToCanonicalReturn', 'verifiedReturnToReviewAcceptance',
  'acceptanceToAuditCloseout',
]);

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'run', 'counters', 'milestones', 'sizes', 'disposition', 'digest',
]);
const RUN_FIELDS = Object.freeze([
  'hostIdentity', 'hostRoleCapabilityDigest', 'enforcementProfile',
  'activationAssurance', 'returnAssurance', 'hostAdmissionEvidenceGrade', 'executionState',
]);
const PROFILE_FIELDS = Object.freeze(['host', 'capabilityDigest', 'enforcementStates', 'assurance']);

function exact(value, fields) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
}

function digest(value) {
  const { digest: _digest, ...projection } = value;
  return `sha256:${OPERATIONAL_MEASUREMENT_KIND}.v${OPERATIONAL_MEASUREMENT_SCHEMA_VERSION}:${canonicalSha256(projection)}`;
}

function observation(value) {
  if (value === null || value === undefined) return { state: 'missing', value: null };
  if (!Number.isFinite(value) || value < 0) return { state: 'malformed', value: null };
  return { state: 'observed', value: Math.round(value) };
}

function normalizeCounters(input) {
  return Object.fromEntries(OPERATIONAL_COUNTERS.map(key => [key, Number.isSafeInteger(input?.[key]) && input[key] >= 0 ? input[key] : 0]));
}

function normalizeMilestones(input) {
  return Object.fromEntries(OPERATIONAL_MILESTONES.map(key => [key, observation(input?.[key])]));
}

/** Build a bounded, privacy-clean measurement observation. */
export function createOperationalMeasurement({
  hostIdentity,
  hostRoleCapabilityDigest,
  enforcementStates = {},
  activationAssurance = 'unknown',
  returnAssurance = 'unknown',
  hostAdmissionEvidenceGrade = 'missing',
  executionState = 'new',
  counters = {},
  milestones = {},
  sizes = {},
  disposition = {},
} = {}) {
  const enforcementProfile = {
    host: String(hostIdentity ?? '').trim(),
    capabilityDigest: String(hostRoleCapabilityDigest ?? '').trim(),
    enforcementStates: structuredClone(enforcementStates),
    assurance: {
      activation: activationAssurance,
      return: returnAssurance,
      admission: hostAdmissionEvidenceGrade,
      execution: executionState,
    },
  };
  const value = {
    kind: OPERATIONAL_MEASUREMENT_KIND,
    schemaVersion: OPERATIONAL_MEASUREMENT_SCHEMA_VERSION,
    run: {
      hostIdentity: enforcementProfile.host,
      hostRoleCapabilityDigest: enforcementProfile.capabilityDigest,
      enforcementProfile,
      activationAssurance,
      returnAssurance,
      hostAdmissionEvidenceGrade,
      executionState,
    },
    counters: normalizeCounters(counters),
    milestones: normalizeMilestones(milestones),
    sizes: {
      actingContextBytes: observation(sizes.actingContextBytes),
      dispatchPacketBytes: observation(sizes.dispatchPacketBytes),
      returnPacketBytes: observation(sizes.returnPacketBytes),
      orientationBytes: observation(sizes.orientationBytes),
      repeatedOrientationCount: observation(sizes.repeatedOrientationCount),
    },
    disposition: {
      state: disposition.state ?? 'bounded',
      maxRegressionPercent: Number.isFinite(disposition.maxRegressionPercent) ? disposition.maxRegressionPercent : 25,
      result: disposition.result ?? 'not_compared',
      rationale: String(disposition.rationale ?? 'measurement is descriptive and does not confer workflow authority'),
    },
    digest: null,
  };
  value.digest = digest(value);
  return Object.freeze(value);
}

export function validateOperationalMeasurement(value) {
  const errors = [];
  if (!exact(value, FIELDS)) return { ok: false, errors: ['operational measurement fields must equal the closed schema'] };
  if (value.kind !== OPERATIONAL_MEASUREMENT_KIND || value.schemaVersion !== OPERATIONAL_MEASUREMENT_SCHEMA_VERSION) errors.push('operational measurement identity is invalid');
  if (!exact(value.run, RUN_FIELDS) || !exact(value.run.enforcementProfile, PROFILE_FIELDS)) errors.push('operational measurement run/profile fields must equal the closed schema');
  if (!exact(value.counters, OPERATIONAL_COUNTERS)) errors.push('operational measurement counters must equal the closed counter inventory');
  for (const key of OPERATIONAL_COUNTERS) if (!Number.isSafeInteger(value.counters?.[key]) || value.counters[key] < 0) errors.push(`operational counter '${key}' must be a non-negative integer`);
  if (!exact(value.milestones, OPERATIONAL_MILESTONES) || OPERATIONAL_MILESTONES.some(key => !exact(value.milestones?.[key], ['state', 'value']) || !['observed', 'missing', 'malformed'].includes(value.milestones[key].state) || (value.milestones[key].state === 'observed' && !Number.isSafeInteger(value.milestones[key].value)))) errors.push('operational milestone observations are malformed or missing their explicit state');
  if (!exact(value.disposition, ['state', 'maxRegressionPercent', 'result', 'rationale']) || !Number.isFinite(value.disposition.maxRegressionPercent) || value.disposition.maxRegressionPercent < 0 || value.disposition.maxRegressionPercent > 100 || !value.disposition.rationale) errors.push('operational measurement disposition is invalid or unbounded');
  if (value.run.executionState !== 'new' && value.run.executionState !== 'resumed') errors.push('operational measurement executionState must be new or resumed');
  if (value.digest !== digest(value)) errors.push('operational measurement digest is invalid');
  return { ok: errors.length === 0, errors };
}

function profileDigest(value) {
  return `sha256:agenticloop.enforcement-profile.v1:${canonicalSha256(value.run.enforcementProfile)}`;
}

/** Compare only constant-enforcement strata and reject unexplained regressions. */
export function compareOperationalMeasurements(before, after) {
  const beforeCheck = validateOperationalMeasurement(before);
  const afterCheck = validateOperationalMeasurement(after);
  if (!beforeCheck.ok || !afterCheck.ok) return { ok: false, state: 'malformed', errors: [...beforeCheck.errors, ...afterCheck.errors] };
  if (profileDigest(before) !== profileDigest(after)) return { ok: false, state: 'unmatched_stratum', errors: ['operational measurements use different enforcement profiles; compare them as separate strata'] };
  const disposition = after.disposition;
  const regressions = [];
  for (const key of ['actingContextBytes', 'dispatchPacketBytes', 'returnPacketBytes', 'orientationBytes']) {
    const oldValue = before.sizes[key];
    const newValue = after.sizes[key];
    if (oldValue.state !== 'observed' || newValue.state !== 'observed') continue;
    if (oldValue.value === 0) continue;
    const percent = ((newValue.value - oldValue.value) / oldValue.value) * 100;
    if (percent > disposition.maxRegressionPercent) regressions.push(`${key} increased by ${percent.toFixed(2)}%`);
  }
  for (const key of OPERATIONAL_MILESTONES) {
    const oldValue = before.milestones[key];
    const newValue = after.milestones[key];
    if (oldValue.state !== 'observed' || newValue.state !== 'observed') continue;
    if (oldValue.value === 0) continue;
    const percent = ((newValue.value - oldValue.value) / oldValue.value) * 100;
    if (percent > disposition.maxRegressionPercent) regressions.push(`${key} increased by ${percent.toFixed(2)}%`);
  }
  return {
    ok: regressions.length === 0,
    state: regressions.length === 0 ? 'bounded' : 'unexplained_regression',
    errors: regressions,
    profileDigest: profileDigest(after),
  };
}
