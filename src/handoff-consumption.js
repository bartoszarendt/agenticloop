/** Durable proof that a canonical dispatch packet was consumed at role start. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSha256 } from './canonical-json.js';
import { GIT_OBJECT_ID_RE } from './git-oid.js';
import { validateHandoffRecognition } from './handoff-recognition.js';

export const DISPATCH_CONSUMPTION_KIND = 'agenticloop.dispatch-consumption';
export const DISPATCH_CONSUMPTION_SCHEMA_VERSION = 2;
export const DISPATCH_CONSUMPTION_CLOCK_SKEW_MS = 1000;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PACKET_ID_RE = /^dispatch:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;
const TASK_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function dispatchConsumptionDigest(record) {
  const projection = { ...record };
  delete projection.digest;
  return `sha256:agenticloop.dispatch-consumption.v2:${canonicalSha256(projection)}`;
}

export function createDispatchConsumption({ backend, taskId, recognition, consumedAt = new Date().toISOString() }) {
  const checked = validateHandoffRecognition(recognition);
  if (!checked.ok || recognition?.recognized !== true || recognition.transition !== 'role_start' ||
      recognition.requirement !== 'prepared_dispatch') {
    throw new TypeError('dispatch consumption requires a valid recognized prepared-dispatch role-start verdict');
  }
  const identity = recognition.boundIdentity;
  const record = {
    kind: DISPATCH_CONSUMPTION_KIND,
    schemaVersion: DISPATCH_CONSUMPTION_SCHEMA_VERSION,
    backend,
    taskId,
    packetId: identity.packetId,
    packetDigest: identity.packetDigest,
    taskContractDigest: identity.taskContractDigest,
    carrierDigest: identity.carrierDigest,
    workUnitIdentity: identity.workUnitIdentity,
    repositoryIdentity: identity.repositoryIdentity,
    worktreeRoot: identity.worktreeRoot,
    artifactHead: identity.artifactHead,
    recognitionDigest: recognition.digest,
    recognition,
    consumedAt,
    digest: null,
  };
  record.digest = dispatchConsumptionDigest(record);
  const validation = validateDispatchConsumption(record, { backend, taskId });
  if (!validation.ok) throw new TypeError(`invalid dispatch consumption: ${validation.errors.join('; ')}`);
  return Object.freeze(record);
}

export function dispatchConsumptionRelativePath(record) {
  return `.agenticloop/handoffs/dispatch/${safeSegment(record.taskId)}/${safeSegment(record.packetId)}.json`;
}

export function validateDispatchConsumption(record, {
  backend = null, taskId = null, filename = null, now = Date.now(),
} = {}) {
  const required = [
    'kind', 'schemaVersion', 'backend', 'taskId', 'packetId', 'packetDigest',
    'taskContractDigest', 'carrierDigest', 'workUnitIdentity', 'repositoryIdentity',
    'worktreeRoot', 'artifactHead', 'recognitionDigest', 'recognition', 'consumedAt', 'digest',
  ];
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== required.length ||
      Object.keys(record).some(key => !required.includes(key))) {
    return { ok: false, errors: ['dispatch consumption fields must equal the closed schema'] };
  }
  if (record.kind !== DISPATCH_CONSUMPTION_KIND) errors.push(`dispatch consumption kind must be '${DISPATCH_CONSUMPTION_KIND}'`);
  if (record.schemaVersion !== DISPATCH_CONSUMPTION_SCHEMA_VERSION) errors.push(`dispatch consumption schemaVersion must be ${DISPATCH_CONSUMPTION_SCHEMA_VERSION}`);
  if (!['files', 'github'].includes(record.backend)) errors.push('dispatch consumption backend is invalid');
  if (backend !== null && record.backend !== backend) errors.push(`dispatch consumption backend '${record.backend}' does not match expected backend '${backend}'`);
  if (typeof record.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.taskId)) errors.push('dispatch consumption taskId is invalid');
  if (taskId !== null && record.taskId !== taskId) errors.push(`dispatch consumption taskId '${record.taskId}' does not match expected task '${taskId}'`);
  if (!PACKET_ID_RE.test(String(record.packetId ?? ''))) errors.push('dispatch consumption packetId is invalid');
  if (!SEMANTIC_DIGEST_RE.test(String(record.packetDigest ?? ''))) errors.push('dispatch consumption packetDigest is invalid');
  if (!CONTRACT_DIGEST_RE.test(String(record.taskContractDigest ?? ''))) errors.push('dispatch consumption taskContractDigest is invalid');
  if (!TASK_DIGEST_RE.test(String(record.carrierDigest ?? ''))) errors.push('dispatch consumption carrierDigest is invalid');
  if (typeof record.workUnitIdentity !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/.test(record.workUnitIdentity)) errors.push('dispatch consumption workUnitIdentity is invalid');
  if (typeof record.repositoryIdentity !== 'string' || !record.repositoryIdentity) errors.push('dispatch consumption repositoryIdentity is invalid');
  if (typeof record.worktreeRoot !== 'string' || !record.worktreeRoot) errors.push('dispatch consumption worktreeRoot is invalid');
  if (!GIT_OBJECT_ID_RE.test(String(record.artifactHead ?? ''))) errors.push('dispatch consumption artifactHead is invalid');
  if (!SEMANTIC_DIGEST_RE.test(String(record.recognitionDigest ?? ''))) errors.push('dispatch consumption recognitionDigest is invalid');

  const recognition = validateHandoffRecognition(record.recognition);
  if (!recognition.ok) errors.push(...recognition.errors.map(error => `embedded recognition: ${error}`));
  else {
    if (record.recognition.recognized !== true || record.recognition.transition !== 'role_start' ||
        record.recognition.requirement !== 'prepared_dispatch') {
      errors.push('embedded recognition must be a recognized prepared-dispatch role-start verdict');
    }
    if (record.recognitionDigest !== record.recognition.digest) errors.push('dispatch consumption recognitionDigest does not match embedded recognition');
    const identity = record.recognition.boundIdentity;
    for (const field of [
      'backend', 'taskId', 'packetId', 'packetDigest', 'taskContractDigest', 'carrierDigest',
      'workUnitIdentity', 'repositoryIdentity', 'worktreeRoot', 'artifactHead',
    ]) {
      if (record[field] !== identity[field]) errors.push(`dispatch consumption ${field} does not match embedded recognition`);
    }
  }

  const consumedMs = Date.parse(record.consumedAt);
  if (!ISO_UTC_RE.test(String(record.consumedAt ?? '')) || !Number.isFinite(consumedMs)) {
    errors.push('dispatch consumption consumedAt must be a strict ISO-8601 UTC instant');
  } else if (consumedMs > now + DISPATCH_CONSUMPTION_CLOCK_SKEW_MS) {
    errors.push('dispatch consumption consumedAt is future-dated');
  }
  if (filename !== null && filename !== `${safeSegment(record.packetId)}.json`) {
    errors.push('dispatch consumption filename does not match its packet identity');
  }
  if (record.digest !== dispatchConsumptionDigest(record)) errors.push('dispatch consumption digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function listDispatchConsumptions(target, taskId, options = {}) {
  const directory = join(target, '.agenticloop', 'handoffs', 'dispatch', safeSegment(taskId));
  if (!existsSync(directory)) return { ok: true, records: [], errors: [] };
  const records = [];
  const errors = [];
  for (const name of readdirSync(directory).filter(value => value.endsWith('.json')).sort()) {
    try {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const checked = validateDispatchConsumption(record, { ...options, taskId, filename: name });
      if (!checked.ok) errors.push(...checked.errors.map(error => `${name}: ${error}`));
      else records.push(record);
    } catch (error) {
      errors.push(`${name}: dispatch consumption is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

export function currentDispatchConsumption(target, taskId, options = {}) {
  const listed = listDispatchConsumptions(target, taskId, options);
  if (!listed.ok || listed.records.length === 0) return { ...listed, record: null };
  const ordered = [...listed.records].sort((a, b) =>
    Date.parse(a.consumedAt) - Date.parse(b.consumedAt) || a.packetId.localeCompare(b.packetId));
  return { ok: true, records: listed.records, errors: [], record: ordered.at(-1) };
}
