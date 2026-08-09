import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { canonicalSha256 } from './canonical-json.js';
import { executeMutationBatch, resolveTargetPath } from './fs-mutation-kernel.js';
import { signOperatorActivationPayload } from './activation-trust.js';
import { targetRepositoryIdentity } from './host-trust.js';

export const LEGACY_UNACTIVATED_WAIVER_KIND = 'agenticloop.legacy-unactivated-waiver';
export const LEGACY_UNACTIVATED_WAIVER_SCHEMA_VERSION = 1;
export const LEGACY_UNACTIVATED_WAIVER_ROOT = '.agenticloop/closeout-waivers';
export const LEGACY_WAIVER_MAX_TTL_SECONDS = 3600;
export const LEGACY_WAIVER_CLOCK_SKEW_MS = 1000;
export const LEGACY_WAIVER_SCOPES = Object.freeze(['activation_evidence_absent', 'return_evidence_absent']);

function digest(record) {
  const { digest: ignoredDigest, authentication: ignoredAuthentication, ...projection } = record;
  return `sha256:${LEGACY_UNACTIVATED_WAIVER_KIND}.v1:${canonicalSha256(projection)}`;
}

export function legacyWaiverSignaturePayload(record) {
  return {
    kind: 'agenticloop.legacy-unactivated-waiver-signature',
    schemaVersion: 1,
    waiverId: record.waiverId,
    repositoryIdentity: record.repositoryIdentity,
    workUnit: record.workUnit,
    digest: digest(record),
  };
}

export function legacyWaiverPath(workUnit) {
  const name = createHash('sha256').update(workUnit, 'utf8').digest('hex');
  return `${LEGACY_UNACTIVATED_WAIVER_ROOT}/${name}.json`;
}

function normalizedReason(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function canonicalStatement(record) {
  return `Compatibility exception for missing evidence only: ${(record?.waivedDimensions ?? []).join(', ')}; ` +
    `repository ${record?.repositoryIdentity}; work unit ${record?.workUnit}; reason: ${record?.reason}`;
}

export function createLegacyUnactivatedWaiver({
  target, workUnit, tasks, reason, key, waivedDimensions = LEGACY_WAIVER_SCOPES,
  issuedAt = new Date().toISOString(), ttlSeconds = LEGACY_WAIVER_MAX_TTL_SECONDS,
}) {
  const normalized = normalizedReason(reason);
  if (reason !== normalized || !normalized || normalized.length > 500) throw new TypeError('compatibility waiver reason must be normalized and contain 1-500 characters');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > LEGACY_WAIVER_MAX_TTL_SECONDS) throw new TypeError(`compatibility waiver TTL must be 1-${LEGACY_WAIVER_MAX_TTL_SECONDS} seconds`);
  const scopes = [...new Set(waivedDimensions)].sort();
  if (scopes.length === 0 || scopes.some(scope => !LEGACY_WAIVER_SCOPES.includes(scope))) throw new TypeError('compatibility waiver scopes are invalid');
  const record = {
    kind: LEGACY_UNACTIVATED_WAIVER_KIND,
    schemaVersion: LEGACY_UNACTIVATED_WAIVER_SCHEMA_VERSION,
    waiverId: `legacy-waiver:${randomUUID()}`,
    repositoryIdentity: targetRepositoryIdentity(target),
    workUnit,
    tasks: [...tasks].map(item => ({ taskId: item.taskId, taskContractDigest: item.taskContractDigest })).sort((a, b) => a.taskId.localeCompare(b.taskId)),
    reason: normalized,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString(),
    waivedDimensions: scopes,
    statement: null,
    authentication: null,
    digest: null,
  };
  record.statement = canonicalStatement(record);
  record.digest = digest(record);
  record.authentication = signOperatorActivationPayload(legacyWaiverSignaturePayload(record), {
    key,
    repositoryIdentity: record.repositoryIdentity,
  });
  return record;
}

export function verifyLegacyUnactivatedWaiver(record, { target, workUnit, tasks, verify, now = Date.now(), path = null }) {
  const errors = [];
  const fields = ['kind','schemaVersion','waiverId','repositoryIdentity','workUnit','tasks','reason','issuedAt','expiresAt','waivedDimensions','statement','authentication','digest'];
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))) {
    return { ok: false, errors: ['compatibility waiver fields must equal the closed schema'], record: null };
  }
  if (record?.kind !== LEGACY_UNACTIVATED_WAIVER_KIND || record?.schemaVersion !== 1 || record?.repositoryIdentity !== targetRepositoryIdentity(target) || record?.workUnit !== workUnit) errors.push('compatibility waiver identity does not match this repository and work unit');
  if (!/^legacy-waiver:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(record?.waiverId ?? '')) || !/^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(record?.workUnit ?? ''))) errors.push('compatibility waiver ID or work-unit identity is invalid');
  const expectedTasks = [...tasks].map(item => ({ taskId: item.taskId, taskContractDigest: item.taskContractDigest })).sort((a,b) => a.taskId.localeCompare(b.taskId));
  if (!Array.isArray(record?.tasks) || record.tasks.some(item => !item || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'taskId') || !Object.hasOwn(item, 'taskContractDigest') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.taskId) || !/^sha256:v1:[a-f0-9]{64}$/.test(item.taskContractDigest))) errors.push('compatibility waiver task bindings are invalid');
  if (canonicalSha256(record?.tasks) !== canonicalSha256(expectedTasks)) errors.push('compatibility waiver covered task contracts changed');
  const scopes = Array.isArray(record?.waivedDimensions) ? record.waivedDimensions : [];
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length || scopes.some(scope => !LEGACY_WAIVER_SCOPES.includes(scope)) || canonicalSha256(scopes) !== canonicalSha256([...scopes].sort())) errors.push('compatibility waiver scopes are invalid');
  if (record?.reason !== normalizedReason(record?.reason) || !record?.reason || record.reason.length > 500) errors.push('compatibility waiver reason must be normalized and contain 1-500 characters');
  if (record?.statement !== canonicalStatement(record) || record?.digest !== digest(record)) errors.push('compatibility waiver statement or digest is invalid');
  const issuedAt = Date.parse(record?.issuedAt);
  const expiresAt = Date.parse(record?.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt >= expiresAt || issuedAt > now + LEGACY_WAIVER_CLOCK_SKEW_MS || expiresAt <= now || expiresAt - issuedAt > LEGACY_WAIVER_MAX_TTL_SECONDS * 1000) errors.push('compatibility waiver timestamps are invalid, expired, future-issued, or exceed the maximum TTL');
  if (path !== null && path.replaceAll('\\', '/') !== legacyWaiverPath(record?.workUnit)) errors.push('compatibility waiver canonical path does not match its signed identity');
  if (typeof verify !== 'function' || !verify(legacyWaiverSignaturePayload(record), record?.authentication, 'operator_confirmed')) errors.push('compatibility waiver signature does not verify against the external operator-confirmation key');
  return { ok: errors.length === 0, errors, record: errors.length === 0 ? record : null };
}

export function writeLegacyUnactivatedWaiver(target, record) {
  const path = legacyWaiverPath(record.workUnit);
  const absolute = resolveTargetPath(target, path);
  const mutation = existsSync(absolute)
    ? { type: 'write', path, content: `${JSON.stringify(record, null, 2)}\n`, expectedDigest: `sha256:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`, expectedKind: 'file' }
    : { type: 'create', path, content: `${JSON.stringify(record, null, 2)}\n` };
  const applied = executeMutationBatch(target, [mutation]);
  return { ok: applied.ok, errors: [...applied.errors, ...applied.rollbackErrors], path };
}

export function readLegacyUnactivatedWaiver(target, workUnit) {
  const path = legacyWaiverPath(workUnit);
  try {
    const absolute = resolveTargetPath(target, path);
    if (!existsSync(absolute)) return { record: null, path, errors: [] };
    return { record: JSON.parse(readFileSync(absolute, 'utf8')), path, errors: [] };
  } catch (error) { return { record: null, path, errors: [error.message] }; }
}
