/** Stable membership/eligibility projection for dispatch-bound decomposition. */

import { canonicalJson, canonicalSha256 } from './canonical-json.js';

export const DECOMPOSITION_ELIGIBILITY_KIND = 'agenticloop.decomposition-eligibility';
export const DECOMPOSITION_ELIGIBILITY_SCHEMA_VERSION = 1;

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'taskId', 'backend', 'workUnitMembership',
  'lifecycleEligibility', 'protectedContract', 'dependencyState',
  'mutationBoundaries', 'knowledgeBoundaries', 'requiredChecks', 'scope', 'digest',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

function sortedStrings(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.replace(/\\/g, '/')))].sort() : value;
}

function projectionWithoutDigest(value) {
  const { digest: _digest, ...projection } = value;
  return projection;
}

function digest(value) {
  return `sha256:${DECOMPOSITION_ELIGIBILITY_KIND}.v${DECOMPOSITION_ELIGIBILITY_SCHEMA_VERSION}:${canonicalSha256(projectionWithoutDigest(value))}`;
}

/**
 * Build the facts that can change membership or independence. Carrier bytes and
 * carrier digests are deliberately absent; they remain separate observation
 * evidence on the scan record.
 */
export function createDecompositionEligibilityProjection({
  taskId,
  backend,
  contractDigest,
  scan,
  taskFacts = {},
} = {}) {
  const member = scan?.inventory?.members?.find(item => item?.taskId === taskId) ?? null;
  const eligibility = scan?.eligibility?.find(item => item?.taskId === taskId) ?? null;
  const excluded = (scan?.excluded ?? [])
    .filter(item => item?.taskId === taskId)
    .map(item => ({
      reasonCode: item.reasonCode ?? null,
      evidenceState: item.evidenceState ?? null,
    }));
  const value = {
    kind: DECOMPOSITION_ELIGIBILITY_KIND,
    schemaVersion: DECOMPOSITION_ELIGIBILITY_SCHEMA_VERSION,
    taskId: typeof taskId === 'string' ? taskId : null,
    backend: typeof backend === 'string' ? backend : null,
    workUnitMembership: {
      workUnitId: scan?.workUnit?.id ?? null,
      readyTaskIds: sortedStrings(scan?.readyTaskIds) ?? null,
      candidatePairs: Array.isArray(scan?.candidatePairs)
        ? scan.candidatePairs.map(pair => sortedStrings(pair)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
        : null,
      excluded,
      inventoryComplete: scan?.inventory?.complete ?? null,
      decompositionState: scan?.decomposition?.state ?? null,
    },
    lifecycleEligibility: {
      state: member?.state ?? null,
      eligibility: eligibility?.eligibility ?? null,
      ready: Array.isArray(scan?.readyTaskIds) ? scan.readyTaskIds.includes(taskId) : null,
      conclusion: scan?.conclusion ?? null,
    },
    protectedContract: {
      digest: typeof contractDigest === 'string' ? contractDigest : null,
    },
    dependencyState: scan?.readinessContext
      ? {
          digest: scan.readinessContext.digest ?? null,
          dependencies: scan.readinessContext.dependencies ?? null,
        }
      : null,
    mutationBoundaries: taskFacts.mutationBoundaries ?? null,
    knowledgeBoundaries: {
      classification: scan?.knowledgeCoupling?.find(item => item?.taskId === taskId)?.classification ?? null,
      blockers: (scan?.couplingBlockers ?? []).filter(item => item?.taskId === taskId),
      declared: taskFacts.knowledgeBoundaries ?? null,
    },
    requiredChecks: taskFacts.requiredChecks ?? null,
    scope: taskFacts.scope ?? null,
    digest: null,
  };
  value.digest = digest(value);
  return Object.freeze(value);
}

export function validateDecompositionEligibilityProjection(value, { taskId = null, backend = null } = {}) {
  const errors = [];
  if (!exactKeys(value, FIELDS)) return { ok: false, errors: ['decomposition eligibility fields must equal the closed schema'] };
  if (value.kind !== DECOMPOSITION_ELIGIBILITY_KIND || value.schemaVersion !== DECOMPOSITION_ELIGIBILITY_SCHEMA_VERSION) errors.push('decomposition eligibility identity is invalid');
  if (typeof value.taskId !== 'string' || !value.taskId || (taskId !== null && value.taskId !== taskId)) errors.push('decomposition eligibility taskId is invalid or mismatched');
  if (!['files', 'github'].includes(value.backend) || (backend !== null && value.backend !== backend)) errors.push('decomposition eligibility backend is invalid or mismatched');
  if (!isObject(value.workUnitMembership) || !isObject(value.lifecycleEligibility) || !isObject(value.protectedContract)) errors.push('decomposition eligibility membership, lifecycle, and contract projections are required');
  if (!isObject(value.dependencyState) && value.dependencyState !== null) errors.push('decomposition eligibility dependencyState must be an object or null');
  if (!/^sha256:v1:[a-f0-9]{64}$/.test(String(value.protectedContract?.digest ?? ''))) errors.push('decomposition eligibility protected contract digest is invalid');
  if (value.digest !== digest(value)) errors.push('decomposition eligibility digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function decompositionEligibilityDigest(value) {
  const checked = validateDecompositionEligibilityProjection(value);
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return value.digest;
}
