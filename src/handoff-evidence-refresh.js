/** Bounded refresh of derived handoff evidence only. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { executeMutationBatch, resolveTargetPath } from './fs-mutation-kernel.js';
import { targetRepositoryIdentity } from './host-trust.js';
import { evaluateCommitAttribution } from './commit-attribution.js';

export const HANDOFF_REFRESH_PLAN_KIND = 'agenticloop.handoff-evidence-refresh-plan';
export const HANDOFF_REFRESH_PLAN_SCHEMA_VERSION = 1;
export const HANDOFF_REFRESH_RECEIPT_KIND = 'agenticloop.handoff-derived-evidence';
export const HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION = 1;
export const HANDOFF_REFRESH_ROOT = '.agenticloop/handoffs/derived-evidence';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const PLAN_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'targetRepository', 'taskId', 'backend', 'carrier',
  'carrierDigest', 'contractDigest', 'source', 'expected', 'proposed',
  'changedFiles', 'authority', 'digest',
]);
const RECEIPT_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'targetRepository', 'taskId', 'backend', 'carrier',
  'carrierDigest', 'contractDigest', 'repository', 'readiness',
  'decomposition', 'dispatch', 'authority', 'digest',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

function byteDigest(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex')}`;
}

function semanticDigest(value) {
  return `sha256:agenticloop.handoff-derived-evidence.v${HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION}:${canonicalSha256(value)}`;
}

function withoutDigest(value) {
  const { digest: _digest, ...projection } = value;
  return projection;
}

function safeTaskId(taskId) {
  return String(taskId ?? '').trim();
}

export function handoffRefreshRelativePath(taskId) {
  const normalized = safeTaskId(taskId);
  if (!TASK_ID_RE.test(normalized)) throw new TypeError('handoff refresh taskId is invalid');
  return `${HANDOFF_REFRESH_ROOT}/${normalized}.json`;
}

export function handoffRefreshMaintainerTrailerBlock(taskId) {
  const normalized = safeTaskId(taskId);
  if (!TASK_ID_RE.test(normalized)) throw new TypeError('handoff refresh taskId is invalid');
  return `Task: ${normalized}\nAgent: maintainer`;
}

export function validateHandoffRefreshMaintainerTrailer(taskId, message = null) {
  const trailer = handoffRefreshMaintainerTrailerBlock(taskId);
  const attribution = evaluateCommitAttribution({
    taskId,
    role: 'maintainer',
    message: message ?? `refresh derived evidence\n\n${trailer}`,
  });
  return {
    ok: attribution.ok,
    trailer,
    errors: attribution.errors,
  };
}

function projectionFromPreflight(preflight) {
  return {
    repository: preflight?.repository
      ? {
          head: preflight.repository.head ?? null,
          baseTree: preflight.repository.baseTree ?? null,
          productBase: preflight.repository.productBase ?? null,
        }
      : null,
    readiness: preflight?.readiness
      ? {
          evidenceState: preflight.readiness.evidenceState ?? null,
          disposition: preflight.readiness.disposition ?? null,
          base: preflight.readiness.base ?? null,
          dependencies: preflight.readiness.dependencies ?? null,
        }
      : null,
    decomposition: preflight?.decomposition
      ? {
          sourceRef: preflight.decomposition.sourceRef ?? null,
          sourceRevision: preflight.decomposition.sourceRevision ?? null,
          sourceCommit: preflight.decomposition.sourceCommit ?? null,
          inventoryComplete: preflight.decomposition.inventoryComplete ?? false,
          baseMode: preflight.decomposition.baseMode ?? null,
          eligibility: preflight.decomposition.eligibility ?? null,
          dispatchCompatible: preflight.decomposition.dispatchCompatible ?? false,
        }
      : null,
    dispatch: { liveness: null, invocation: null },
  };
}

function eligibilityDigest(preflight) {
  const decomposition = preflight?.decomposition ?? null;
  return `sha256:agenticloop.handoff-eligibility.v1:${canonicalSha256({
    taskId: preflight?.taskId ?? null,
    backend: preflight?.backend ?? null,
    carrier: preflight?.carrier ?? null,
    contractDigest: preflight?.contractDigest ?? null,
    readiness: preflight?.readiness
      ? {
          ok: preflight.readiness.ok,
          evidenceState: preflight.readiness.evidenceState ?? null,
          disposition: preflight.readiness.disposition ?? null,
          dependencies: preflight.readiness.dependencies ?? null,
        }
      : null,
    decomposition: decomposition
      ? {
          sourceRef: decomposition.sourceRef ?? null,
          sourceCommit: decomposition.sourceCommit ?? null,
          inventoryComplete: decomposition.inventoryComplete ?? false,
          baseMode: decomposition.baseMode ?? null,
          eligibility: decomposition.eligibility ?? null,
          dispatchCompatible: decomposition.dispatchCompatible ?? false,
        }
      : null,
  })}`;
}

function createReceipt({ target, preflight }) {
  const projection = projectionFromPreflight(preflight);
  const receipt = {
    kind: HANDOFF_REFRESH_RECEIPT_KIND,
    schemaVersion: HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION,
    targetRepository: targetRepositoryIdentity(target),
    taskId: safeTaskId(preflight?.taskId),
    backend: preflight?.backend ?? null,
    carrier: preflight?.carrier ?? null,
    carrierDigest: preflight?.carrierDigest ?? null,
    contractDigest: preflight?.contractDigest ?? null,
    repository: projection.repository,
    readiness: {
      ...projection.readiness,
      dependencyAge: preflight?.dependencyAge ?? null,
    },
    decomposition: {
      ...projection.decomposition,
      eligibilityDigest: preflight?.decomposition?.eligibilityDigest ?? eligibilityDigest(preflight),
    },
    dispatch: projection.dispatch,
    authority: {
      state: 'derived_only',
      durableCommitRequired: true,
      durableCommit: null,
    },
    digest: null,
  };
  receipt.digest = semanticDigest(withoutDigest(receipt));
  return receipt;
}

export function validateHandoffRefreshReceipt(value, { target = null, taskId = null } = {}) {
  const errors = [];
  if (!exactKeys(value, RECEIPT_FIELDS)) {
    return { ok: false, errors: ['handoff derived-evidence receipt fields must equal the closed schema'] };
  }
  if (value.kind !== HANDOFF_REFRESH_RECEIPT_KIND || value.schemaVersion !== HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION) {
    errors.push('handoff derived-evidence receipt identity is invalid');
  }
  if (!TASK_ID_RE.test(String(value.taskId ?? '')) || (taskId !== null && value.taskId !== taskId)) {
    errors.push('handoff derived-evidence receipt taskId is invalid or mismatched');
  }
  if (!['files', 'github'].includes(value.backend)) errors.push('handoff derived-evidence receipt backend is invalid');
  if (typeof value.targetRepository !== 'string' || !value.targetRepository) errors.push('handoff derived-evidence receipt targetRepository is required');
  if (typeof value.carrier !== 'string' || !value.carrier) errors.push('handoff derived-evidence receipt carrier is required');
  if (!DIGEST_RE.test(String(value.carrierDigest ?? ''))) errors.push('handoff derived-evidence receipt carrierDigest is invalid');
  if (!CONTRACT_DIGEST_RE.test(String(value.contractDigest ?? ''))) errors.push('handoff derived-evidence receipt contractDigest is invalid');
  if (!isObject(value.repository) || !isObject(value.readiness) || !isObject(value.decomposition) || !isObject(value.dispatch)) {
    errors.push('handoff derived-evidence receipt derived projections must be objects');
  }
  if (!exactKeys(value.authority, ['state', 'durableCommitRequired', 'durableCommit']) ||
      value.authority.state !== 'derived_only' || value.authority.durableCommitRequired !== true ||
      value.authority.durableCommit !== null) {
    errors.push('handoff derived-evidence receipt authority must remain derived_only and non-authoritative');
  }
  if (target !== null && value.targetRepository !== targetRepositoryIdentity(target)) errors.push('handoff derived-evidence receipt targetRepository is stale');
  if (value.digest !== semanticDigest(withoutDigest(value))) errors.push('handoff derived-evidence receipt digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function validateHandoffRefreshPlan(value, { target = null, taskId = null } = {}) {
  const errors = [];
  if (!exactKeys(value, PLAN_FIELDS)) {
    return { ok: false, errors: ['handoff refresh plan fields must equal the closed schema'] };
  }
  if (value.kind !== HANDOFF_REFRESH_PLAN_KIND || value.schemaVersion !== HANDOFF_REFRESH_PLAN_SCHEMA_VERSION) {
    errors.push('handoff refresh plan identity is invalid');
  }
  if (!TASK_ID_RE.test(String(value.taskId ?? '')) || (taskId !== null && value.taskId !== taskId)) errors.push('handoff refresh plan taskId is invalid or mismatched');
  if (!['files', 'github'].includes(value.backend)) errors.push('handoff refresh plan backend is invalid');
  if (target !== null && value.targetRepository !== targetRepositoryIdentity(target)) errors.push('handoff refresh plan targetRepository is stale');
  if (!DIGEST_RE.test(String(value.carrierDigest ?? ''))) errors.push('handoff refresh plan carrierDigest is invalid');
  if (!CONTRACT_DIGEST_RE.test(String(value.contractDigest ?? ''))) errors.push('handoff refresh plan contractDigest is invalid');
  if (!exactKeys(value.source, ['kind', 'schemaVersion', 'observationDigest']) ||
      value.source.kind !== 'agenticloop.handoff-preflight' || value.source.schemaVersion !== 1 ||
      !DIGEST_RE.test(String(value.source.observationDigest ?? ''))) {
    errors.push('handoff refresh plan source identity is invalid');
  }
  if (!exactKeys(value.expected, ['path', 'digest']) || typeof value.expected.path !== 'string' ||
      (value.expected.digest !== null && !DIGEST_RE.test(String(value.expected.digest)))) {
    errors.push('handoff refresh plan expected derived state is invalid');
  } else {
    try {
      if (value.expected.path !== handoffRefreshRelativePath(value.taskId)) {
        errors.push('handoff refresh plan expected path must be the canonical derived-evidence path for the task');
      }
    } catch {
      errors.push('handoff refresh plan expected path cannot be validated because taskId is invalid');
    }
  }
  const proposed = validateHandoffRefreshReceipt(value.proposed, { taskId: value.taskId });
  if (!proposed.ok) errors.push(...proposed.errors.map(error => `proposed: ${error}`));
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length !== 1 || value.changedFiles.some(path => typeof path !== 'string' || !path)) errors.push('handoff refresh plan changedFiles must contain exactly one bounded path');
  if (value.changedFiles[0] !== value.expected.path) errors.push('handoff refresh plan changedFiles must exactly match the expected derived-evidence path');
  if (!exactKeys(value.authority, ['state', 'durableCommitRequired', 'durableCommit']) || value.authority.state !== 'derived_only' || value.authority.durableCommitRequired !== true || value.authority.durableCommit !== null) errors.push('handoff refresh plan authority must remain derived_only and non-authoritative');
  if (value.digest !== `sha256:agenticloop.handoff-refresh-plan.v1:${canonicalSha256(withoutDigest(value))}`) errors.push('handoff refresh plan digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function createHandoffEvidenceRefreshPlan({ target, preflight }) {
  if (!isObject(preflight) || preflight.kind !== 'agenticloop.handoff-preflight') throw new TypeError('handoff refresh requires one handoff-preflight result');
  const taskId = safeTaskId(preflight.taskId);
  if (!TASK_ID_RE.test(taskId)) throw new TypeError('handoff refresh requires a valid task id');
  if (preflight.backend !== 'files') throw new TypeError('handoff evidence refresh currently supports only the files backend');
  if (!preflight.carrierDigest || !preflight.contractDigest || !preflight.repository?.head) throw new TypeError('handoff refresh requires current carrier, protected contract, and repository identities');

  const proposed = createReceipt({ target, preflight });
  const path = handoffRefreshRelativePath(taskId);
  const absolute = resolveTargetPath(target, path);
  const expected = existsSync(absolute)
    ? { path, digest: byteDigest(readFileSync(absolute)) }
    : { path, digest: null };
  const observation = {
    ...projectionFromPreflight(preflight),
    taskId,
    backend: preflight.backend,
    carrier: preflight.carrier,
    carrierDigest: preflight.carrierDigest,
    contractDigest: preflight.contractDigest,
  };
  const plan = {
    kind: HANDOFF_REFRESH_PLAN_KIND,
    schemaVersion: HANDOFF_REFRESH_PLAN_SCHEMA_VERSION,
    targetRepository: targetRepositoryIdentity(target),
    taskId,
    backend: preflight.backend,
    carrier: preflight.carrier,
    carrierDigest: preflight.carrierDigest,
    contractDigest: preflight.contractDigest,
    source: {
      kind: 'agenticloop.handoff-preflight',
      schemaVersion: 1,
      observationDigest: `sha256:${canonicalSha256(observation)}`,
    },
    expected,
    proposed,
    changedFiles: [path],
    authority: { state: 'derived_only', durableCommitRequired: true, durableCommit: null },
    digest: null,
  };
  plan.digest = `sha256:agenticloop.handoff-refresh-plan.v1:${canonicalSha256(withoutDigest(plan))}`;
  const checked = validateHandoffRefreshPlan(plan, { target, taskId });
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(plan);
}

function currentObservation(preflight) {
  return {
    ...projectionFromPreflight(preflight),
    taskId: preflight?.taskId ?? null,
    backend: preflight?.backend ?? null,
    carrier: preflight?.carrier ?? null,
    carrierDigest: preflight?.carrierDigest ?? null,
    contractDigest: preflight?.contractDigest ?? null,
  };
}

export function applyHandoffEvidenceRefresh({ target, plan, preflight }) {
  const checked = validateHandoffRefreshPlan(plan, { target, taskId: preflight?.taskId ?? null });
  if (!checked.ok) return { ok: false, evidenceState: 'malformed', disposition: 'rejected', errors: checked.errors, changedFiles: [] };
  const expectedObservationDigest = plan.source.observationDigest;
  const actualObservationDigest = `sha256:${canonicalSha256(currentObservation(preflight))}`;
  if (actualObservationDigest !== expectedObservationDigest || preflight.carrierDigest !== plan.carrierDigest || preflight.contractDigest !== plan.contractDigest) {
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'superseded',
      errors: ['handoff refresh plan is stale: task, carrier, protected contract, repository, dependency, or decomposition evidence changed'],
      changedFiles: [],
      firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
    };
  }
  const path = plan.expected.path;
  const absolute = resolveTargetPath(target, path);
  const currentDigest = existsSync(absolute) ? byteDigest(readFileSync(absolute)) : null;
  if (currentDigest !== plan.expected.digest) {
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'superseded',
      errors: ['handoff refresh derived receipt changed since the plan was created'],
      changedFiles: [],
      firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
    };
  }
  const content = `${canonicalJson(plan.proposed)}\n`;
  const mutation = plan.expected.digest === null
    ? { type: 'create', path, content }
    : { type: 'write', path, content, expectedDigest: plan.expected.digest, expectedKind: 'file' };
  const applied = executeMutationBatch(target, [mutation]);
  if (!applied.ok) {
    return {
      ok: false,
      evidenceState: applied.stale ? 'changed' : 'negative',
      disposition: applied.stale ? 'superseded' : 'blocked',
      errors: [...applied.errors, ...applied.rollbackErrors],
      changedFiles: applied.writtenFiles,
    };
  }
  let written;
  try {
    written = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    return { ok: false, evidenceState: 'malformed', disposition: 'blocked', errors: [`refetched derived receipt is unreadable: ${error.message}`], changedFiles: [path] };
  }
  const receipt = validateHandoffRefreshReceipt(written, { target, taskId: plan.taskId });
  if (!receipt.ok || canonicalJson(written) !== canonicalJson(plan.proposed)) {
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'blocked',
      errors: [...receipt.errors, 'refetched derived receipt does not equal the planned validated candidate'],
      changedFiles: [path],
    };
  }
  return {
    ok: true,
    evidenceState: 'current',
    disposition: 'proceed',
    errors: [],
    changedFiles: applied.writtenFiles,
    receipt: written,
    authority: plan.authority,
    maintainerTrailerBlock: handoffRefreshMaintainerTrailerBlock(plan.taskId),
    attributionValidation: validateHandoffRefreshMaintainerTrailer(plan.taskId),
    firstSafeRepair: null,
  };
}
