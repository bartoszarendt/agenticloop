import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { canonicalSha256 } from './canonical-json.js';
import { executeMutationBatch, resolveTargetPath } from './fs-mutation-kernel.js';
import { repositoryEvidenceDigest, verifyHostHandoffReceipt } from './host-handoff.js';
import { targetRepositoryIdentity } from './host-trust.js';
import { dispatchPreparationDigest, receiveRoleReturn, validateDispatchPreparation, validateRoleReturn } from './dispatch-envelope.js';

export const RETURN_VERIFICATION_ROOT = '.agenticloop/returns/verifications';
export const RETURN_VERIFICATION_KIND = 'agenticloop.return-verification';
export const RETURN_VERIFICATION_SCHEMA_VERSION = 1;
export const RETURN_VERIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'recordId', 'repositoryIdentity', 'backend', 'taskId',
  'workUnitIdentity', 'taskContractDigest', 'packetId', 'packetDigest',
  'dispatchAuthorityDigest', 'activationAuthorityDigest', 'returnGenerationDigest', 'roleReturnDigest',
  'repositoryEvidenceDigest', 'producerRole', 'observedReturnGrade',
  'producerAuthentication', 'verifiedAt', 'disposition', 'evidence', 'digest',
]);

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function semanticDigest(record) {
  const { digest, ...projection } = record;
  return `sha256:${RETURN_VERIFICATION_KIND}.v1:${canonicalSha256(projection)}`;
}
export function returnActivationAuthorityDigest(packet) {
  return `sha256:agenticloop.activation-authority.v1:${canonicalSha256(packet.activationBinding ?? packet.activation)}`;
}

function packetRepositoryIdentity(packet) {
  return packet?.activationBinding?.grant?.repositoryIdentity ?? packet?.activation?.repositoryIdentity ?? null;
}

function workUnitIdentity(packet) {
  return packet?.decomposition?.scan?.workUnit?.id ?? packet?.decomposition?.workUnit?.id ?? null;
}

function dispatchAuthorityDigest(packet) {
  return `sha256:agenticloop.dispatch-authority.v1:${canonicalSha256({
    packetId: packet?.packetId ?? null,
    packetDigest: packet?.digest ?? null,
    backend: packet?.backend ?? null,
    task: packet?.task ?? null,
    assignment: packet?.assignment ?? null,
  })}`;
}

export function returnGenerationDigest(record) {
  return `sha256:agenticloop.return-generation.v1:${canonicalSha256({
    repositoryIdentity: record?.repositoryIdentity ?? null,
    backend: record?.backend ?? null,
    taskId: record?.taskId ?? null,
    workUnitIdentity: record?.workUnitIdentity ?? null,
    taskContractDigest: record?.taskContractDigest ?? null,
    packetId: record?.packetId ?? null,
    packetDigest: record?.packetDigest ?? null,
    dispatchAuthorityDigest: record?.dispatchAuthorityDigest ?? null,
    activationAuthorityDigest: record?.activationAuthorityDigest ?? null,
    producerRole: record?.producerRole ?? null,
  })}`;
}

export function returnVerificationPath(record) {
  const task = String(record?.taskId ?? '');
  const packet = String(record?.packetId ?? '').replace(/^dispatch:/, '');
  const returned = String(record?.evidence?.roleReturn?.returnId ?? '').replace(/^return:/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task) ||
      !/^[0-9a-f-]{36}$/.test(packet) || !/^[0-9a-f-]{36}$/.test(returned)) {
    throw new TypeError('return verification identities are not safe for deterministic storage');
  }
  return `${RETURN_VERIFICATION_ROOT}/${task}--${packet}--${returned}.json`;
}

export function validateReturnVerification(record, { path = null, now = Date.now() } = {}) {
  const errors = [];
  if (!isObject(record) || Object.keys(record).length !== FIELDS.length || Object.keys(record).some(key => !FIELDS.includes(key))) {
    errors.push('return verification fields must equal the closed schema');
    return { ok: false, errors };
  }
  if (record.kind !== RETURN_VERIFICATION_KIND || record.schemaVersion !== RETURN_VERIFICATION_SCHEMA_VERSION) errors.push('return verification identity is invalid');
  const embeddedReturnId = String(record.evidence?.roleReturn?.returnId ?? '');
  const expectedRecordId = embeddedReturnId.startsWith('return:')
    ? `return-verification:${embeddedReturnId.slice('return:'.length)}`
    : null;
  if (!/^return-verification:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(record.recordId ?? '')) ||
      record.recordId !== expectedRecordId) errors.push('return verification recordId does not match the embedded return identity');
  if (!['files', 'github'].includes(record.backend) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.taskId)) errors.push('return verification task identity is invalid');
  if (!['session_reported', 'host_receipt'].includes(record.observedReturnGrade)) errors.push('return verification observed grade is invalid');
  if (record.disposition !== 'successful_current') errors.push('return verification disposition is invalid');
  const verifiedAt = Date.parse(record.verifiedAt);
  if (!Number.isFinite(verifiedAt) || new Date(verifiedAt).toISOString() !== record.verifiedAt ||
      verifiedAt > now + RETURN_VERIFICATION_CLOCK_SKEW_MS) errors.push('return verification verifiedAt is invalid or future-issued');
  if (!isObject(record.evidence) || Object.keys(record.evidence).length !== 5 ||
      Object.keys(record.evidence).some(key => !['packet', 'roleReturn', 'repositoryEvidence', 'producerReceipt', 'producerIdentityAuthenticated'].includes(key)) ||
      !isObject(record.evidence.packet) || !isObject(record.evidence.roleReturn) || !isObject(record.evidence.repositoryEvidence)) errors.push('return verification evidence is incomplete or not closed');
  const packet = record.evidence?.packet;
  const roleReturn = record.evidence?.roleReturn;
  const repositoryEvidence = record.evidence?.repositoryEvidence;
  const producerReceipt = record.evidence?.producerReceipt;
  const expectedRepository = packetRepositoryIdentity(packet);
  if (record.repositoryIdentity !== expectedRepository) errors.push('return verification repository identity does not match the embedded packet authority');
  if (record.backend !== packet?.backend || record.backend !== roleReturn?.task?.backend || record.backend !== repositoryEvidence?.backend) errors.push('return verification backend does not match all embedded evidence');
  if (record.taskId !== packet?.task?.id || record.taskId !== roleReturn?.task?.id || record.taskId !== repositoryEvidence?.task?.id) errors.push('return verification task does not match all embedded evidence');
  if (record.workUnitIdentity !== workUnitIdentity(packet)) errors.push('return verification work-unit identity does not match the embedded packet');
  if (record.taskContractDigest !== packet?.task?.contractDigest) errors.push('return verification task-contract digest does not match the embedded packet');
  if (record.packetId !== packet?.packetId || record.packetId !== roleReturn?.packet?.packetId) errors.push('return verification packet ID does not match the embedded return');
  if (record.packetDigest !== packet?.digest || record.packetDigest !== roleReturn?.packet?.digest) errors.push('return verification packet digest does not match the embedded return');
  if (record.dispatchAuthorityDigest !== dispatchAuthorityDigest(packet)) errors.push('return verification dispatch authority does not match the embedded packet');
  if (record.activationAuthorityDigest !== returnActivationAuthorityDigest(packet)) errors.push('return verification activation authority does not match the embedded packet');
  if (record.roleReturnDigest !== roleReturn?.digest) errors.push('return verification role-return digest does not match the embedded return');
  if (record.producerRole !== packet?.assignment?.roleId || record.producerRole !== roleReturn?.producerRole) errors.push('return verification producer role does not match the packet assignment and embedded return');
  if (record.repositoryEvidenceDigest !== repositoryEvidenceDigest(repositoryEvidence)) errors.push('return verification repository-evidence digest does not match the embedded evidence');
  if (record.returnGenerationDigest !== returnGenerationDigest(record)) errors.push('return verification generation digest is invalid');
  if (record.observedReturnGrade === 'host_receipt' && (
    !isObject(record.producerAuthentication) ||
    Object.keys(record.producerAuthentication).length !== 2 ||
    Object.keys(record.producerAuthentication).some(key => !['adapterId', 'keyId'].includes(key)) ||
    !isObject(producerReceipt)
  )) errors.push('host_receipt verification requires closed authenticated producer evidence');
  if (record.observedReturnGrade === 'session_reported' && (record.producerAuthentication !== null || record.evidence.producerReceipt !== null)) errors.push('session_reported verification must not claim authenticated producer identity');
  if (record.observedReturnGrade === 'host_receipt' && (
    record.evidence.producerIdentityAuthenticated !== true ||
    record.producerAuthentication?.adapterId !== packet?.returnAdapter?.adapterId ||
    record.producerAuthentication?.keyId !== packet?.returnAdapter?.keyId ||
    producerReceipt?.adapterId !== record.producerAuthentication?.adapterId ||
    producerReceipt?.authentication?.keyId !== record.producerAuthentication?.keyId ||
    producerReceipt?.producerRole !== record.producerRole
  )) errors.push('return verification authenticated producer identity does not match the packet and receipt');
  if (record.observedReturnGrade === 'session_reported' && record.evidence.producerIdentityAuthenticated !== false) errors.push('session_reported verification cannot authenticate producer identity');
  if (path !== null) {
    try {
      if (path.replaceAll('\\', '/') !== returnVerificationPath(record)) errors.push('return verification canonical path does not match its validated identity');
    } catch (error) { errors.push(error.message); }
  }
  if (record.digest !== semanticDigest(record)) errors.push('return verification digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function createReturnVerification({ target, packet, roleReturn, repositoryEvidence, producerReceipt = null, received, verifiedAt = new Date().toISOString() }) {
  if (!received?.ok) throw new TypeError('a successful role-return verification is required');
  const grade = received.returnAssurance;
  const record = {
    kind: RETURN_VERIFICATION_KIND,
    schemaVersion: RETURN_VERIFICATION_SCHEMA_VERSION,
    recordId: `return-verification:${String(roleReturn.returnId).replace(/^return:/, '') || randomUUID()}`,
    repositoryIdentity: targetRepositoryIdentity(target),
    backend: packet.backend,
    taskId: packet.task.id,
    workUnitIdentity: workUnitIdentity(packet),
    taskContractDigest: packet.task.contractDigest,
    packetId: packet.packetId,
    packetDigest: packet.digest,
    dispatchAuthorityDigest: dispatchAuthorityDigest(packet),
    activationAuthorityDigest: returnActivationAuthorityDigest(packet),
    returnGenerationDigest: null,
    roleReturnDigest: roleReturn.digest,
    repositoryEvidenceDigest: repositoryEvidenceDigest(repositoryEvidence),
    producerRole: roleReturn.producerRole,
    observedReturnGrade: grade,
    producerAuthentication: grade === 'host_receipt'
      ? { adapterId: packet.returnAdapter.adapterId, keyId: packet.returnAdapter.keyId }
      : null,
    verifiedAt,
    disposition: 'successful_current',
    evidence: {
      packet: structuredClone(packet),
      roleReturn: structuredClone(roleReturn),
      repositoryEvidence: structuredClone(repositoryEvidence),
      producerReceipt: producerReceipt === null ? null : structuredClone(producerReceipt),
      producerIdentityAuthenticated: grade === 'host_receipt',
    },
    digest: null,
  };
  record.returnGenerationDigest = returnGenerationDigest(record);
  record.digest = semanticDigest(record);
  const checked = validateReturnVerification(record);
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(record);
}

export function writeReturnVerification(target, record) {
  const checked = validateReturnVerification(record);
  if (!checked.ok) return { ok: false, errors: checked.errors, path: null };
  const path = returnVerificationPath(record);
  const absolute = resolveTargetPath(target, path);
  if (existsSync(absolute)) {
    try {
      const existing = JSON.parse(readFileSync(absolute, 'utf8'));
      const existingCheck = validateReturnVerification(existing, { path });
      if (!existingCheck.ok) return { ok: false, disposition: 'conflict', errors: [`conflicting return verification at ${path}: ${existingCheck.errors.join('; ')}`], path };
      const comparable = value => {
        const { recordId, verifiedAt, digest, ...semantic } = value;
        return semantic;
      };
      if (canonicalSha256(comparable(existing)) === canonicalSha256(comparable(record))) {
        return { ok: true, disposition: 'already_current', errors: [], path };
      }
      return { ok: false, disposition: 'conflict', errors: [`conflicting return verification already exists at ${path}`], path };
    } catch (error) {
      return { ok: false, disposition: 'conflict', errors: [`conflicting return verification at ${path}: ${error.message}`], path };
    }
  }
  const applied = executeMutationBatch(target, [{ type: 'create', path, content: `${JSON.stringify(record, null, 2)}\n` }]);
  return { ok: applied.ok, disposition: applied.ok ? 'created' : 'conflict', errors: [...applied.errors, ...applied.rollbackErrors], path };
}

export function listReturnVerifications(target, taskId = null, {
  taskContractDigest = null,
  activationAuthorityDigest = null,
  workUnitIdentity: expectedWorkUnitIdentity = null,
} = {}) {
  const directory = resolve(target, RETURN_VERIFICATION_ROOT);
  if (!existsSync(directory)) return { ok: true, records: [], errors: [] };
  const records = [];
  const errors = [];
  let supersededCount = 0;
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) { errors.push(`unsupported return-verification entry '${name}'`); continue; }
    try {
      const record = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
      const candidateTask = record?.evidence?.packet?.task?.id ?? record?.taskId;
      const candidateContract = record?.evidence?.packet?.task?.contractDigest ?? record?.taskContractDigest;
      const candidateAuthority = isObject(record?.evidence?.packet)
        ? returnActivationAuthorityDigest(record.evidence.packet)
        : record?.activationAuthorityDigest;
      const candidateWorkUnit = isObject(record?.evidence?.packet)
        ? workUnitIdentity(record.evidence.packet)
        : record?.workUnitIdentity;
      if (taskId !== null && candidateTask !== taskId) continue;
      if (taskContractDigest !== null && candidateContract !== taskContractDigest) { supersededCount += 1; continue; }
      if (activationAuthorityDigest !== null && candidateAuthority !== activationAuthorityDigest) { supersededCount += 1; continue; }
      if (expectedWorkUnitIdentity !== null && candidateWorkUnit !== expectedWorkUnitIdentity) { supersededCount += 1; continue; }
      const path = `${RETURN_VERIFICATION_ROOT}/${name}`;
      const checked = validateReturnVerification(record, { path });
      if (!checked.ok) errors.push(`${name}: ${checked.errors.join('; ')}`);
      else records.push(record);
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  return { ok: errors.length === 0, records, errors, supersededCount };
}

/**
 * Select the one terminal return observation for a task lifecycle generation.
 * Preparation packets are intentionally read-only and are not an issuance
 * ledger, so closeout defines "current" as the latest successfully persisted
 * verification observation for the exact repository/work-unit/task/contract/
 * activation tuple. Equal-time competing observations are ambiguous and fail
 * closed instead of relying on directory or UUID order.
 */
export function selectCurrentReturnVerifications(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: true, records: [], supersededCount: 0, errors: [] };
  }
  const ordered = [...records].sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt));
  const latestAt = ordered[0].verifiedAt;
  const current = ordered.filter(record => record.verifiedAt === latestAt);
  if (current.length !== 1) {
    return {
      ok: false,
      records: [],
      supersededCount: ordered.length - current.length,
      errors: [`multiple return verifications compete as current at ${latestAt}`],
    };
  }
  return {
    ok: true,
    records: current,
    supersededCount: ordered.length - 1,
    errors: [],
  };
}

export function revalidateReturnVerification(record, {
  target, resolveActivationBinding, resolveTrustedAdapter, capabilities, now = Date.now(),
  expectedBackend = null, expectedTaskId = null, expectedTaskContractDigest = null,
  expectedActivationAuthorityDigest = null, refetchTask = null, refetchRepositoryEvidence = null,
  expectedWorkUnitIdentity = null,
  runGit = null, minimumReturnAssurance = null,
}) {
  const checked = validateReturnVerification(record);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const { packet, roleReturn, repositoryEvidence, producerReceipt } = record.evidence;
  const errors = [];
  if (expectedBackend !== null && record.backend !== expectedBackend) errors.push('return verification belongs to another backend');
  if (expectedTaskId !== null && record.taskId !== expectedTaskId) errors.push('return verification belongs to another task');
  if (expectedTaskContractDigest !== null && record.taskContractDigest !== expectedTaskContractDigest) errors.push('return verification belongs to another task-contract generation');
  if (expectedActivationAuthorityDigest !== null && record.activationAuthorityDigest !== expectedActivationAuthorityDigest) errors.push('return verification belongs to another activation generation');
  if (expectedWorkUnitIdentity !== null && record.workUnitIdentity !== expectedWorkUnitIdentity) errors.push('return verification belongs to another work unit');
  if (record.repositoryIdentity !== targetRepositoryIdentity(target) || record.packetDigest !== dispatchPreparationDigest(packet) || packet.digest !== record.packetDigest) errors.push('return verification packet or repository identity changed');
  if (record.activationAuthorityDigest !== returnActivationAuthorityDigest(packet)) errors.push('return verification activation authority changed');
  if (!validateRoleReturn(roleReturn).ok || roleReturn.digest !== record.roleReturnDigest) errors.push('return verification role-return evidence changed');
  if (repositoryEvidenceDigest(repositoryEvidence) !== record.repositoryEvidenceDigest) errors.push('return verification repository evidence changed');
  if (packet.activationBinding !== null) {
    const authority = resolveActivationBinding(packet);
    if (!authority?.ok) errors.push(...(authority?.errors ?? []).map(item => item.message));
  }
  const packetValidation = validateDispatchPreparation(packet, { resolveActivationBinding, capabilities });
  if (!packetValidation.ok) errors.push(...packetValidation.errors);
  if (record.observedReturnGrade === 'host_receipt') {
    try {
      const adapter = resolveTrustedAdapter(record.producerAuthentication.adapterId);
      if (adapter.keyId !== record.producerAuthentication.keyId) throw new TypeError('stored producer key no longer matches external trust');
      verifyHostHandoffReceipt(producerReceipt, { trustedAdapter: adapter, packet, roleReturn, repositoryEvidence, now });
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length === 0 && typeof refetchTask === 'function' && typeof refetchRepositoryEvidence === 'function') {
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet, refetchTask, refetchRepositoryEvidence,
      producerReceipt, resolveTrustedAdapter, now, runGit, historicalCloseout: true,
    }, { capabilities, resolveActivationBinding, minimumReturnAssurance: minimumReturnAssurance ?? record.observedReturnGrade });
    if (!received.ok) errors.push(...(received.validation?.errors ?? ['authoritative role-return revalidation failed']));
    else if (received.returnAssurance !== record.observedReturnGrade) errors.push('fresh return assurance does not match the stored observed grade');
  }
  return { ok: errors.length === 0, errors, record };
}
