import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { canonicalSha256 } from './canonical-json.js';
import { listWorkflowEvidenceFiles } from './carrier-root.js';
import { executeMutationBatch } from './fs-mutation-kernel.js';
import { evaluateToolingFailureRetry } from './role-session-policy.js';

export const TOOLING_FAILURE_OBSERVATION_KIND = 'agenticloop.tooling-failure-observation';
export const TOOLING_FAILURE_OBSERVATION_SCHEMA_VERSION = 1;
const ROOT = '.agenticloop/handoffs/attempts';
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'operation', 'diagnosticCode', 'diagnosticClass',
  'mutationOccurred', 'safeToRetry', 'provenance',
]);
const RECORD_KEYS = Object.freeze([
  'kind', 'schemaVersion', 'recordId', 'taskId', 'taskContractDigest', 'attempt',
  'operation', 'signature', 'diagnosticCode', 'diagnosticClass', 'observedAt',
  'mutationOccurred', 'safeToRetry', 'provenance', 'digest',
]);

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

export function validateToolingFailureInput(value) {
  const errors = [];
  if (!exactObject(value, INPUT_KEYS)) return { ok: false, errors: ['tooling-failure input fields must equal the closed schema'] };
  if (value.schemaVersion !== 1) errors.push('tooling-failure input schemaVersion must be 1');
  for (const field of ['operation', 'diagnosticCode', 'diagnosticClass']) {
    if (typeof value[field] !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(value[field])) errors.push(`tooling-failure ${field} is invalid`);
  }
  if (typeof value.mutationOccurred !== 'boolean' || typeof value.safeToRetry !== 'boolean') errors.push('tooling-failure mutationOccurred and safeToRetry must be booleans');
  if (!value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance) ||
      Object.keys(value.provenance).some(key => !['source', 'operationRef'].includes(key)) ||
      typeof value.provenance.source !== 'string' || value.provenance.source.length > 128 ||
      (value.provenance.operationRef !== undefined && (typeof value.provenance.operationRef !== 'string' || value.provenance.operationRef.length > 256))) {
    errors.push('tooling-failure provenance must contain bounded source and optional operationRef strings');
  }
  return { ok: errors.length === 0, errors };
}

function attemptShape(attempt) {
  return {
    attemptId: attempt.attemptId,
    packetId: attempt.packetId,
    packetDigest: attempt.packetDigest,
    invocationId: attempt.invocationId,
    productBaseHead: attempt.productBaseHead,
  };
}

function signatureFor(input) {
  return `sha256:agenticloop.tooling-failure-signature.v1:${canonicalSha256({
    operation: input.operation,
    diagnosticCode: input.diagnosticCode,
    diagnosticClass: input.diagnosticClass,
    mutationOccurred: input.mutationOccurred,
    safeToRetry: input.safeToRetry,
  })}`;
}

export function validateToolingFailureObservation(record, { taskId = null } = {}) {
  const errors = [];
  if (!exactObject(record, RECORD_KEYS)) return { ok: false, errors: ['tooling-failure observation fields must equal the closed schema'] };
  if (record.kind !== TOOLING_FAILURE_OBSERVATION_KIND || record.schemaVersion !== TOOLING_FAILURE_OBSERVATION_SCHEMA_VERSION) errors.push('tooling-failure observation identity is invalid');
  if (taskId !== null && record.taskId !== taskId) errors.push('tooling-failure observation taskId does not match the requested task');
  if (!/^sha256:v1:[a-f0-9]{64}$/.test(String(record.taskContractDigest ?? ''))) errors.push('tooling-failure taskContractDigest is invalid');
  if (!record.attempt || typeof record.attempt !== 'object' || Object.keys(record.attempt).length !== 5) errors.push('tooling-failure exact attempt identity is incomplete');
  else {
    if (!/^attempt:[a-f0-9]{32}$/.test(String(record.attempt.attemptId ?? ''))) errors.push('tooling-failure attemptId is invalid');
    if (typeof record.attempt.packetId !== 'string' || typeof record.attempt.packetDigest !== 'string' ||
        typeof record.attempt.invocationId !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(record.attempt.productBaseHead ?? ''))) {
      errors.push('tooling-failure exact attempt binding is invalid');
    }
  }
  if (record.signature !== signatureFor(record)) errors.push('tooling-failure signature does not match normalized failure fields');
  if (!Number.isFinite(Date.parse(record.observedAt)) || new Date(Date.parse(record.observedAt)).toISOString() !== record.observedAt) errors.push('tooling-failure observedAt is invalid');
  const input = Object.fromEntries(INPUT_KEYS.map(key => [key, key === 'schemaVersion' ? 1 : record[key]]));
  errors.push(...validateToolingFailureInput(input).errors);
  const { digest, ...unsigned } = record;
  if (digest !== `sha256:${TOOLING_FAILURE_OBSERVATION_KIND}.v1:${canonicalSha256(unsigned)}`) errors.push('tooling-failure observation digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function listToolingFailureObservations(target, taskId) {
  const records = [];
  const errors = [];
  for (const { name, path } of listWorkflowEvidenceFiles(target, [...ROOT.split('/'), taskId, 'tooling-failures'])) {
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      const checked = validateToolingFailureObservation(record, { taskId });
      if (!checked.ok) errors.push(`${name}: ${checked.errors.join('; ')}`);
      else records.push(record);
    } catch (error) { errors.push(`${name}: tooling-failure observation is unreadable: ${error.message}`); }
  }
  return { ok: errors.length === 0, records, errors };
}

export function recordToolingFailure(target, {
  taskId, taskContractDigest, currentTaskContractDigest, attempt, input,
  budget = 2, now = new Date().toISOString(), mutationOptions = {},
} = {}) {
  const checkedInput = validateToolingFailureInput(input);
  if (!checkedInput.ok) return { ok: false, code: 'tooling_failure_input_invalid', errors: checkedInput.errors, mutationOccurred: false, safeToRetry: true };
  const policyCurrent = {
    taskId,
    taskContractDigest,
    attemptId: attempt?.attemptId,
    attemptState: attempt?.state,
    contractCurrent: taskContractDigest === currentTaskContractDigest,
    operation: input.operation,
    signature: signatureFor(input),
    mutationOccurred: input.mutationOccurred,
    safeToRetry: input.safeToRetry,
  };
  const safety = evaluateToolingFailureRetry({ budget, current: policyCurrent, failures: [] });
  if (safety.repeated === 0 && !safety.retryPermitted) {
    return { ...safety, code: safety.code ?? 'tooling_failure_retry_unsafe', errors: [safety.reason] };
  }
  const record = {
    kind: TOOLING_FAILURE_OBSERVATION_KIND,
    schemaVersion: 1,
    recordId: `tooling-failure:${randomUUID()}`,
    taskId,
    taskContractDigest,
    attempt: attemptShape(attempt),
    operation: input.operation,
    signature: signatureFor(input),
    diagnosticCode: input.diagnosticCode,
    diagnosticClass: input.diagnosticClass,
    observedAt: now,
    mutationOccurred: input.mutationOccurred,
    safeToRetry: input.safeToRetry,
    provenance: structuredClone(input.provenance),
    digest: null,
  };
  record.digest = `sha256:${TOOLING_FAILURE_OBSERVATION_KIND}.v1:${canonicalSha256(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'digest')))}`;
  const checked = validateToolingFailureObservation(record, { taskId });
  if (!checked.ok) return { ok: false, code: 'tooling_failure_input_invalid', errors: checked.errors, mutationOccurred: false, safeToRetry: true };
  const cohort = canonicalSha256({
    taskId, taskContractDigest, attemptId: record.attempt.attemptId,
    operation: record.operation, signature: record.signature,
  });
  for (let admission = 0; admission < 8; admission += 1) {
    const prior = listToolingFailureObservations(target, taskId);
    if (!prior.ok) return { ok: false, code: 'tooling_failure_evidence_conflict', errors: prior.errors, mutationOccurred: false, safeToRetry: true };
    const cohortRecords = prior.records.filter(item =>
      item.taskId === taskId && item.taskContractDigest === taskContractDigest &&
      item.attempt.attemptId === record.attempt.attemptId && item.operation === record.operation &&
      item.signature === record.signature);
    const retry = evaluateToolingFailureRetry({ budget, current: policyCurrent, failures: cohortRecords.map(item => ({
      taskId: item.taskId, taskContractDigest: item.taskContractDigest,
      attemptId: item.attempt.attemptId, operation: item.operation, signature: item.signature,
    })) });
    const ordinal = cohortRecords.length + 1;
    const path = `${ROOT}/${taskId}/tooling-failures/${cohort}-${String(ordinal).padStart(4, '0')}.json`;
    const applied = executeMutationBatch(target, [{ type: 'create', path, content: `${JSON.stringify(record, null, 2)}\n` }], mutationOptions);
    if (applied.ok) return { ...retry, record, path, recordMutationOccurred: true };
    if (applied.rollbackErrors.length === 0) continue;
    return { ok: false, code: 'tooling_failure_write_failed', errors: [...applied.errors, ...applied.rollbackErrors], mutationOccurred: false, safeToRetry: false };
  }
  return { ok: false, retryPermitted: false, code: 'tooling_failure_admission_conflict', errors: ['tooling-failure retry admission changed concurrently; rerun against current cohort history'], mutationOccurred: false, safeToRetry: true };
}
