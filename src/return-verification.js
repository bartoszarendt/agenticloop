import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { canonicalSha256 } from './canonical-json.js';
import { executeMutationBatch, readConfinedTargetFile, resolveTargetPath } from './fs-mutation-kernel.js';
import { packetWorkUnitIdentity, repositoryEvidenceDigest, verifyHostExecutionReceipt, verifyHostHandoffReceipt } from './host-handoff.js';
import { targetRepositoryIdentity } from './host-trust.js';
import { receiveRoleReturn } from './dispatch-envelope.js';
import { classifyLifecycleCompatibility, compatibilityMessage } from './lifecycle-compatibility.js';
import { REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION, validateRequiredCheckEvidence } from './required-checks.js';

export const RETURN_VERIFICATION_ROOT = '.agenticloop/returns/verifications';
export const RETURN_VERIFICATION_KIND = 'agenticloop.return-verification';
export const RETURN_VERIFICATION_SCHEMA_VERSION = 4;
export const RETURN_VERIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const CURRENT_REQUIRED_CHECK_EVIDENCE_ASSURANCE = 'unverified';
export const REQUIRED_CHECK_EVIDENCE_ASSURANCE_GRADES = Object.freeze([
  'authenticated_receipt',
  'unverified',
  'not_applicable',
]);

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'recordId', 'repositoryIdentity', 'backend', 'taskId',
  'workUnitIdentity', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest',
  'productBaseHead', 'productHead', 'workflowHead', 'candidateHead', 'packetId', 'packetDigest',
  'dispatchAuthorityDigest', 'activationAuthorityDigest', 'returnGenerationDigest', 'roleReturnDigest',
  'repositoryEvidenceDigest', 'producerRole', 'requiredCheckEvidenceContract', 'requiredCheckEvidenceAssurance', 'observedReturnGrade',
  'producerAuthentication', 'verifiedAt', 'disposition', 'evidence', 'digest',
]);

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function successfulDisposition(roleReturn) {
  return roleReturn?.disposition === 'proceed' ? 'successful_current' : 'blocked';
}

function semanticDigest(record) {
  const { digest, ...projection } = record;
  return `sha256:${RETURN_VERIFICATION_KIND}.v${RETURN_VERIFICATION_SCHEMA_VERSION}:${canonicalSha256(projection)}`;
}
export function returnActivationAuthorityDigest(packet) {
  return `sha256:agenticloop.activation-authority.v1:${canonicalSha256(packet.activationBinding ?? packet.activation)}`;
}

function packetRepositoryIdentity(packet) {
  return packet?.activationBinding?.grant?.repositoryIdentity ?? packet?.activation?.repositoryIdentity ?? null;
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
    dispatchCarrierDigest: record?.dispatchCarrierDigest ?? null,
    currentCarrierDigest: record?.currentCarrierDigest ?? null,
    productBaseHead: record?.productBaseHead ?? null,
    productHead: record?.productHead ?? null,
    workflowHead: record?.workflowHead ?? null,
    candidateHead: record?.candidateHead ?? null,
    packetId: record?.packetId ?? null,
    packetDigest: record?.packetDigest ?? null,
    dispatchAuthorityDigest: record?.dispatchAuthorityDigest ?? null,
    activationAuthorityDigest: record?.activationAuthorityDigest ?? null,
    producerRole: record?.producerRole ?? null,
    requiredCheckEvidenceContract: record?.requiredCheckEvidenceContract ?? null,
    requiredCheckEvidenceAssurance: record?.requiredCheckEvidenceAssurance ?? null,
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
  if (!['successful_current', 'blocked'].includes(record.disposition) ||
      record.disposition !== successfulDisposition(record.evidence?.roleReturn)) {
    errors.push('return verification disposition does not reflect the verified role return');
  }
  const verifiedAt = Date.parse(record.verifiedAt);
  if (!Number.isFinite(verifiedAt) || new Date(verifiedAt).toISOString() !== record.verifiedAt ||
      verifiedAt > now + RETURN_VERIFICATION_CLOCK_SKEW_MS) errors.push('return verification verifiedAt is invalid or future-issued');
  if (!isObject(record.evidence) || Object.keys(record.evidence).length !== 6 ||
      Object.keys(record.evidence).some(key => !['packet', 'roleReturn', 'repositoryEvidence', 'producerReceipt', 'executionReceipt', 'producerIdentityAuthenticated'].includes(key)) ||
      !isObject(record.evidence.packet) || !isObject(record.evidence.roleReturn) || !isObject(record.evidence.repositoryEvidence)) errors.push('return verification evidence is incomplete or not closed');
  const packet = record.evidence?.packet;
  const roleReturn = record.evidence?.roleReturn;
  const repositoryEvidence = record.evidence?.repositoryEvidence;
  const producerReceipt = record.evidence?.producerReceipt;
  const executionReceipt = record.evidence?.executionReceipt;
  const expectedRepository = packetRepositoryIdentity(packet);
  if (record.repositoryIdentity !== expectedRepository) errors.push('return verification repository identity does not match the embedded packet authority');
  if (record.backend !== packet?.backend || record.backend !== roleReturn?.task?.backend || record.backend !== repositoryEvidence?.backend) errors.push('return verification backend does not match all embedded evidence');
  if (record.taskId !== packet?.task?.id || record.taskId !== roleReturn?.task?.id || record.taskId !== repositoryEvidence?.task?.id) errors.push('return verification task does not match all embedded evidence');
  if (record.workUnitIdentity !== packetWorkUnitIdentity(packet)) errors.push('return verification work-unit identity does not match the embedded packet');
  if (record.taskContractDigest !== packet?.task?.taskContractDigest) errors.push('return verification taskContractDigest does not match the embedded packet');
  if (record.dispatchCarrierDigest !== packet?.task?.dispatchCarrierDigest) errors.push('return verification dispatchCarrierDigest does not match the embedded packet');
  if (record.currentCarrierDigest !== roleReturn?.task?.currentCarrierDigest || record.currentCarrierDigest !== repositoryEvidence?.task?.currentCarrierDigest) errors.push('return verification currentCarrierDigest does not match embedded current evidence');
  for (const [field, expected] of [
    ['productBaseHead', roleReturn?.productBaseHead], ['productHead', roleReturn?.productHead],
    ['workflowHead', roleReturn?.workflowHead], ['candidateHead', roleReturn?.candidateHead],
  ]) {
    if (record[field] !== expected || record[field] !== repositoryEvidence?.[field]) errors.push(`return verification ${field} does not match embedded evidence`);
  }
  if (record.packetId !== packet?.packetId || record.packetId !== roleReturn?.packet?.packetId) errors.push('return verification packet ID does not match the embedded return');
  if (record.packetDigest !== packet?.digest || record.packetDigest !== roleReturn?.packet?.digest) errors.push('return verification packet digest does not match the embedded return');
  if (record.dispatchAuthorityDigest !== dispatchAuthorityDigest(packet)) errors.push('return verification dispatch authority does not match the embedded packet');
  if (record.activationAuthorityDigest !== returnActivationAuthorityDigest(packet)) errors.push('return verification activation authority does not match the embedded packet');
  if (record.roleReturnDigest !== roleReturn?.digest) errors.push('return verification role-return digest does not match the embedded return');
  if (record.producerRole !== packet?.assignment?.roleId || record.producerRole !== roleReturn?.producerRole) errors.push('return verification producer role does not match the packet assignment and embedded return');
  if (record.requiredCheckEvidenceContract !== packet?.task?.requiredCheckEvidenceContract ||
      record.requiredCheckEvidenceContract !== roleReturn?.requiredCheckEvidenceContract ||
      record.requiredCheckEvidenceContract !== 2) {
    errors.push('return verification required-check evidence contract does not match the current packet and role return');
  }
  if (record.requiredCheckEvidenceAssurance === 'authenticated_receipt' && (
    record.observedReturnGrade !== 'host_receipt' || record.producerAuthentication === null || !isObject(executionReceipt)
  )) {
    errors.push('return verification claims authenticated execution assurance without authenticated producer proof');
  }
  if (!REQUIRED_CHECK_EVIDENCE_ASSURANCE_GRADES.includes(record.requiredCheckEvidenceAssurance)) {
    errors.push('return verification required-check evidence assurance is invalid');
  }
  const hasCommandChecks = Array.isArray(packet?.task?.requiredChecks) &&
    packet.task.requiredChecks.some(check => check?.kind === 'command');
  if (!hasCommandChecks && record.requiredCheckEvidenceAssurance !== 'not_applicable') {
    errors.push('return verification without command checks must use not_applicable required-check evidence assurance');
  }
  if (hasCommandChecks && record.requiredCheckEvidenceAssurance === 'not_applicable') {
    errors.push('return verification with command checks cannot use not_applicable required-check evidence assurance');
  }
  if (record.repositoryEvidenceDigest !== repositoryEvidenceDigest(repositoryEvidence)) errors.push('return verification repository-evidence digest does not match the embedded evidence');
  if (record.returnGenerationDigest !== returnGenerationDigest(record)) errors.push('return verification generation digest is invalid');
  if (record.observedReturnGrade === 'host_receipt' && (
    !isObject(record.producerAuthentication) ||
    Object.keys(record.producerAuthentication).length !== 2 ||
    Object.keys(record.producerAuthentication).some(key => !['adapterId', 'keyId'].includes(key)) ||
    !isObject(producerReceipt)
  )) errors.push('host_receipt verification requires closed authenticated producer evidence');
  if (record.observedReturnGrade === 'session_reported' && (record.producerAuthentication !== null || record.evidence.producerReceipt !== null || executionReceipt !== null)) errors.push('session_reported verification must not claim authenticated producer identity');
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

export function createReturnVerification({
  target,
  packet,
  roleReturn,
  repositoryEvidence,
  producerReceipt = null,
  received,
  requiredCheckEvidenceAssurance = null,
  verifiedAt = new Date().toISOString(),
}) {
  if (!received?.ok) throw new TypeError('a successful role-return verification is required');
  const hasCommandChecks = Array.isArray(packet?.task?.requiredChecks) &&
    packet.task.requiredChecks.some(check => check?.kind === 'command');
  const resolvedAssurance = requiredCheckEvidenceAssurance ?? (hasCommandChecks ? 'unverified' : 'not_applicable');
  if (!REQUIRED_CHECK_EVIDENCE_ASSURANCE_GRADES.includes(resolvedAssurance) || resolvedAssurance === 'authenticated_receipt') {
    throw new TypeError('createReturnVerification cannot issue authenticated execution assurance');
  }
  const grade = received.returnAssurance;
  const record = {
    kind: RETURN_VERIFICATION_KIND,
    schemaVersion: RETURN_VERIFICATION_SCHEMA_VERSION,
    recordId: `return-verification:${String(roleReturn.returnId).replace(/^return:/, '') || randomUUID()}`,
    repositoryIdentity: targetRepositoryIdentity(target),
    backend: packet.backend,
    taskId: packet.task.id,
    workUnitIdentity: packetWorkUnitIdentity(packet),
    taskContractDigest: packet.task.taskContractDigest,
    dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
    currentCarrierDigest: roleReturn.task?.currentCarrierDigest ?? repositoryEvidence.task?.currentCarrierDigest ?? null,
    productBaseHead: roleReturn.productBaseHead ?? repositoryEvidence.productBaseHead ?? null,
    productHead: roleReturn.productHead ?? repositoryEvidence.productHead ?? null,
    workflowHead: roleReturn.workflowHead ?? repositoryEvidence.workflowHead ?? null,
    candidateHead: roleReturn.candidateHead ?? repositoryEvidence.candidateHead ?? null,
    packetId: packet.packetId,
    packetDigest: packet.digest,
    dispatchAuthorityDigest: dispatchAuthorityDigest(packet),
    activationAuthorityDigest: returnActivationAuthorityDigest(packet),
    returnGenerationDigest: null,
    roleReturnDigest: roleReturn.digest,
    repositoryEvidenceDigest: repositoryEvidenceDigest(repositoryEvidence),
    producerRole: roleReturn.producerRole,
    requiredCheckEvidenceContract: roleReturn.requiredCheckEvidenceContract ?? packet.task?.requiredCheckEvidenceContract ?? 2,
    requiredCheckEvidenceAssurance: resolvedAssurance,
    observedReturnGrade: grade,
    producerAuthentication: grade === 'host_receipt'
      ? { adapterId: packet.returnAdapter.adapterId, keyId: packet.returnAdapter.keyId }
      : null,
    verifiedAt,
    disposition: successfulDisposition(roleReturn),
    evidence: {
      packet: structuredClone(packet),
      roleReturn: structuredClone(roleReturn),
      repositoryEvidence: structuredClone(repositoryEvidence),
      producerReceipt: producerReceipt === null ? null : structuredClone(producerReceipt),
      executionReceipt: null,
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

export function readTargetExecutionArtifact(target, relPath) {
  try {
    return JSON.parse(readConfinedTargetFile(target, relPath).content);
  } catch (error) {
    throw new TypeError(`execution receipt artifact '${String(relPath)}' is not a target-confined regular JSON file: ${error.message}`);
  }
}

function authenticateStoredExecutionReceipt(record, { target, trustedAdapter, now = Date.now() } = {}) {
  if (!trustedAdapter) throw new TypeError('authenticated return verification requires current external host trust');
  const { packet, roleReturn, repositoryEvidence, producerReceipt, executionReceipt } = record.evidence;
  if (trustedAdapter.adapterId !== record.producerAuthentication?.adapterId ||
      trustedAdapter.keyId !== record.producerAuthentication?.keyId) {
    throw new TypeError('authenticated return verification no longer matches current external host trust');
  }
  verifyHostHandoffReceipt(producerReceipt, { trustedAdapter, packet, roleReturn, repositoryEvidence, now });
  verifyHostExecutionReceipt(executionReceipt, {
    trustedAdapter, packet, roleReturn, repositoryEvidence, target,
    readExecutionArtifact: path => readTargetExecutionArtifact(target, path), now,
  });
}

function replayBinding(record) {
  const receipt = record.evidence.executionReceipt;
  return {
    adapterId: receipt.adapterId,
    keyId: receipt.authentication.keyId,
    targetRepositoryIdentity: record.repositoryIdentity,
    replayId: receipt.replayId,
    recordId: record.recordId,
    recordDigest: record.digest,
  };
}

function consumeExecutionReceipt(record, authority) {
  if (!authority || typeof authority.prepare !== 'function' || typeof authority.commit !== 'function' || typeof authority.abort !== 'function') {
    throw new TypeError('authenticated return verification requires a protected durable execution-receipt replay consumer');
  }
  const result = authority.prepare(replayBinding(record));
  if (!result?.ok || result.state !== 'prepared' || typeof result.transactionId !== 'string' || !result.transactionId) {
    throw new TypeError(`protected execution-receipt replay consumption failed: ${result?.error ?? 'receipt was already consumed or the protected sink is unavailable'}`);
  }
  return result.transactionId;
}

/**
 * The replay service, rather than target state, is the authority for whether an
 * authenticated receipt has become usable. Its signed `current` response means
 * the exact binding was durably committed; every other state is unusable.
 */
function verifyCommittedExecutionReceipt(record, authority) {
  if (!authority || typeof authority.verify !== 'function') {
    throw new TypeError('authenticated return verification requires a protected durable execution-receipt replay consumer');
  }
  const result = authority.verify(replayBinding(record));
  if (!result?.ok || result.state !== 'current') {
    throw new TypeError(`protected execution-receipt replay verification failed: ${result?.error ?? 'receipt is not durably committed'}`);
  }
  return result;
}

function abortPreparedExecutionReceipt(record, authority, transactionId) {
  let result;
  try {
    result = authority.abort(replayBinding(record), transactionId);
  } catch (error) {
    throw new TypeError(`protected execution-receipt replay abort failed: ${error.message}`);
  }
  if (!result?.ok || result.state !== 'aborted') {
    throw new TypeError(`protected execution-receipt replay abort failed: ${result?.error ?? 'receipt was not durably aborted'}`);
  }
  return result;
}

function replayRecovery(type, path, details = {}) {
  return {
    type,
    path,
    targetRecordState: 'unusable_until_signed_replay_commit',
    repair: `remove or revalidate '${path}' only after the protected replay authority reports the exact binding committed`,
    ...details,
  };
}

/**
 * The sole constructor permitted to issue authenticated execution assurance.
 * It verifies the protected host signature and re-reads every signed artifact;
 * the generic constructor intentionally has no receipt parameter for this grade.
 */
export function createAuthenticatedReturnVerification({
  target, packet, roleReturn, repositoryEvidence, producerReceipt, received,
  executionReceipt, trustedAdapter, verifiedAt = new Date().toISOString(), now = Date.now(),
}) {
  if (!received?.ok || received.returnAssurance !== 'host_receipt') {
    throw new TypeError('authenticated execution assurance requires a host-receipt return verification');
  }
  const adapter = trustedAdapter;
  verifyHostHandoffReceipt(producerReceipt, {
    trustedAdapter: adapter, packet, roleReturn, repositoryEvidence, now,
  });
  verifyHostExecutionReceipt(executionReceipt, {
    trustedAdapter: adapter, packet, roleReturn, repositoryEvidence, target,
    readExecutionArtifact: path => readTargetExecutionArtifact(target, path), now,
  });
  const provisional = createReturnVerification({
    target, packet, roleReturn, repositoryEvidence, producerReceipt, received, verifiedAt,
  });
  const record = structuredClone(provisional);
  record.requiredCheckEvidenceAssurance = 'authenticated_receipt';
  record.evidence.executionReceipt = structuredClone(executionReceipt);
  record.returnGenerationDigest = returnGenerationDigest(record);
  record.digest = semanticDigest(record);
  const checked = validateReturnVerification(record, { now });
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(record);
}

export function writeReturnVerification(target, record, {
  trustedAdapter = null,
  executionReceiptReplayAuthority = null,
  now = Date.now(),
  mutationExecutor = executeMutationBatch,
} = {}) {
  const checked = validateReturnVerification(record);
  if (!checked.ok) return { ok: false, errors: checked.errors, path: null };
  try {
    if (record.requiredCheckEvidenceAssurance === 'authenticated_receipt') {
      authenticateStoredExecutionReceipt(record, { target, trustedAdapter, now });
    }
  } catch (error) {
    return { ok: false, errors: [error.message], path: null };
  }
  const path = returnVerificationPath(record);
  const absolute = resolveTargetPath(target, path);
  if (existsSync(absolute)) {
    try {
      const existing = JSON.parse(readFileSync(absolute, 'utf8'));
      const existingCheck = validateReturnVerification(existing, { path });
      if (!existingCheck.ok) return { ok: false, disposition: 'conflict', errors: [`conflicting return verification at ${path}: ${existingCheck.errors.join('; ')}`], path };
      if (existing.digest === record.digest) {
        if (record.requiredCheckEvidenceAssurance === 'authenticated_receipt') {
          // A residual target file is never evidence of a completed replay
          // transaction. Verify the exact persisted binding before taking the
          // idempotent path, including after a process restart.
          verifyCommittedExecutionReceipt(existing, executionReceiptReplayAuthority);
        }
        return { ok: true, disposition: 'already_current', errors: [], path };
      }
      return { ok: false, disposition: 'conflict', errors: [`conflicting return verification already exists at ${path}`], path };
    } catch (error) {
      return { ok: false, disposition: 'conflict', errors: [`conflicting return verification at ${path}: ${error.message}`], path };
    }
  }
  let replayTransaction = null;
  try {
    if (record.requiredCheckEvidenceAssurance === 'authenticated_receipt') replayTransaction = consumeExecutionReceipt(record, executionReceiptReplayAuthority);
  } catch (error) {
    return { ok: false, disposition: 'conflict', errors: [error.message], path };
  }
  const applied = mutationExecutor(target, [{ type: 'create', path, content: `${JSON.stringify(record, null, 2)}\n` }]);
  if (!applied.ok) {
    if (replayTransaction !== null) {
      try {
        abortPreparedExecutionReceipt(record, executionReceiptReplayAuthority, replayTransaction);
      } catch (error) {
        return {
          ok: false, disposition: 'conflict',
          errors: [...applied.errors, ...applied.rollbackErrors, error.message], path,
          recovery: replayRecovery('write_failed_abort_unconfirmed', path),
        };
      }
    }
    return { ok: false, disposition: 'conflict', errors: [...applied.errors, ...applied.rollbackErrors], path };
  }
  if (replayTransaction !== null) {
    let committed;
    try {
      committed = executionReceiptReplayAuthority.commit(replayBinding(record), replayTransaction);
    } catch (error) {
      committed = { ok: false, error: error.message };
    }
    if (!committed?.ok || committed.state !== 'committed') {
      // No atomic cross-system transaction is claimed here. A failed commit is
      // followed by best-effort target rollback and a required host abort. If
      // either recovery action fails, any residual target file remains unusable
      // because every listing and recognition route re-verifies host commit.
      const rolledBack = mutationExecutor(target, [{ type: 'remove', path }]);
      let abortError = null;
      try {
        abortPreparedExecutionReceipt(record, executionReceiptReplayAuthority, replayTransaction);
      } catch (error) {
        abortError = error.message;
      }
      const errors = [
        `protected execution-receipt replay commit failed: ${committed?.error ?? 'unavailable'}`,
        ...rolledBack.errors,
        ...rolledBack.rollbackErrors,
        ...(abortError ? [abortError] : []),
      ];
      return {
        ok: false,
        disposition: 'conflict',
        errors,
        path,
        ...(rolledBack.ok && !abortError ? {} : {
          recovery: replayRecovery('commit_failed_recovery_incomplete', path, {
            rollbackConfirmed: rolledBack.ok,
            abortConfirmed: !abortError,
          }),
        }),
      };
    }
  }
  return { ok: true, disposition: 'created', errors: [], path };
}

export function listReturnVerifications(target, taskId = null, {
  taskContractDigest = null,
  activationAuthorityDigest = null,
  workUnitIdentity: expectedWorkUnitIdentity = null,
  resolveTrustedAdapter = null,
  resolveExecutionReceiptReplayAuthority = null,
  now = Date.now(),
} = {}) {
  const directory = resolve(target, RETURN_VERIFICATION_ROOT);
  if (!existsSync(directory)) return { ok: true, records: [], errors: [], diagnostics: [] };
  const records = [];
  const errors = [];
  const diagnostics = [];
  let supersededCount = 0;
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) { errors.push(`unsupported return-verification entry '${name}'`); continue; }
    try {
      const record = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
      const candidateTask = record?.evidence?.packet?.task?.id ?? record?.taskId;
       const candidateContract = record?.evidence?.packet?.task?.taskContractDigest ?? record?.taskContractDigest;
      const candidateAuthority = isObject(record?.evidence?.packet)
        ? returnActivationAuthorityDigest(record.evidence.packet)
        : record?.activationAuthorityDigest;
      const candidateWorkUnit = isObject(record?.evidence?.packet)
        ? packetWorkUnitIdentity(record.evidence.packet)
        : record?.workUnitIdentity;
      if (taskId !== null && candidateTask !== taskId) continue;
      if (taskContractDigest !== null && candidateContract !== taskContractDigest) { supersededCount += 1; continue; }
      if (activationAuthorityDigest !== null && candidateAuthority !== activationAuthorityDigest) { supersededCount += 1; continue; }
      if (expectedWorkUnitIdentity !== null && candidateWorkUnit !== expectedWorkUnitIdentity) { supersededCount += 1; continue; }
      const compatibility = classifyLifecycleCompatibility(record, RETURN_VERIFICATION_KIND);
      if (compatibility.state !== 'current') {
        errors.push(`${name}: ${compatibilityMessage(compatibility, 'return verification')}`);
        diagnostics.push({ name, reason: compatibility.reason, observedVersion: compatibility.observedVersion });
      } else {
        const path = `${RETURN_VERIFICATION_ROOT}/${name}`;
        const checked = validateReturnVerification(record, { path });
        if (!checked.ok) errors.push(`${name}: ${checked.errors.join('; ')}`);
        else if (record.requiredCheckEvidenceAssurance === 'authenticated_receipt') {
          try {
            if (typeof resolveTrustedAdapter !== 'function') {
              throw new TypeError('authenticated return verification cannot be recognized without current external host trust');
            }
            authenticateStoredExecutionReceipt(record, {
              target,
              trustedAdapter: resolveTrustedAdapter(record.producerAuthentication?.adapterId),
              now,
            });
            const replayAuthority = typeof resolveExecutionReceiptReplayAuthority === 'function'
              ? resolveExecutionReceiptReplayAuthority(record)
              : null;
            verifyCommittedExecutionReceipt(record, replayAuthority);
            records.push(record);
          } catch (error) { errors.push(`${name}: ${error.message}`); }
        } else records.push(record);
      }
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  return { ok: errors.length === 0, records, errors, diagnostics, supersededCount };
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
  runGit = null, minimumReturnAssurance = null, minimumRequiredCheckEvidenceAssurance = null,
  // Carrier evidence legitimately advances after the return (acceptance and
  // integration). Preserve the established historical-chain revalidation
  // semantics; callers narrow the GitHub transport state separately.
  executionReceiptReplayAuthority = null, historicalCloseout = true,
}) {
  const checked = validateReturnVerification(record);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const { packet, roleReturn, repositoryEvidence, producerReceipt, executionReceipt } = record.evidence;
  const revalidateNonExecuting = () => {
    const errors = [];
    if (record.disposition !== 'successful_current') errors.push('blocked role return observation cannot authorize a protected lifecycle transition');
    if (expectedBackend !== null && record.backend !== expectedBackend) errors.push('return verification belongs to another backend');
    if (expectedTaskId !== null && record.taskId !== expectedTaskId) errors.push('return verification belongs to another task');
    if (expectedTaskContractDigest !== null && record.taskContractDigest !== expectedTaskContractDigest) errors.push('return verification belongs to another task-contract generation');
    if (expectedActivationAuthorityDigest !== null && record.activationAuthorityDigest !== expectedActivationAuthorityDigest) errors.push('return verification belongs to another activation generation');
    if (expectedWorkUnitIdentity !== null && record.workUnitIdentity !== expectedWorkUnitIdentity) errors.push('return verification belongs to another work unit');
    if (minimumRequiredCheckEvidenceAssurance !== null &&
        record.requiredCheckEvidenceAssurance !== 'not_applicable' &&
        record.requiredCheckEvidenceAssurance !== 'authenticated_receipt' &&
        record.requiredCheckEvidenceAssurance !== minimumRequiredCheckEvidenceAssurance) {
      errors.push(`return verification required-check evidence assurance '${record.requiredCheckEvidenceAssurance}' does not meet the required current assurance '${minimumRequiredCheckEvidenceAssurance}'`);
    }
    if (packet?.assurance?.mode === 'hardened' &&
        record.requiredCheckEvidenceAssurance !== 'not_applicable' &&
        record.requiredCheckEvidenceAssurance !== 'authenticated_receipt') {
      errors.push('hardened required-check assurance requires a protected authenticated execution receipt');
    }
    if (record.repositoryIdentity !== targetRepositoryIdentity(target)) errors.push('return verification repository identity changed');
    if (record.activationAuthorityDigest !== returnActivationAuthorityDigest(packet)) errors.push('return verification activation authority changed');
    if (repositoryEvidenceDigest(repositoryEvidence) !== record.repositoryEvidenceDigest) errors.push('return verification repository evidence changed');
    if (packet.activationBinding !== null) {
      const authority = resolveActivationBinding(packet);
      if (!authority?.ok) errors.push(...(authority?.errors ?? []).map(item => item.message));
    }
    if (record.observedReturnGrade === 'host_receipt') {
      try {
        const adapter = resolveTrustedAdapter(record.producerAuthentication.adapterId);
        if (adapter.keyId !== record.producerAuthentication.keyId) throw new TypeError('stored producer key no longer matches external trust');
        verifyHostHandoffReceipt(producerReceipt, { trustedAdapter: adapter, packet, roleReturn, repositoryEvidence, now });
      } catch (error) { errors.push(error.message); }
    }
    if (record.requiredCheckEvidenceAssurance === 'authenticated_receipt') {
      try {
        const adapter = resolveTrustedAdapter(record.producerAuthentication.adapterId);
        authenticateStoredExecutionReceipt(record, { target, trustedAdapter: adapter, now });
        verifyCommittedExecutionReceipt(record, executionReceiptReplayAuthority);
      } catch (error) { errors.push(error.message); }
    }
    if (errors.length === 0 && typeof refetchTask === 'function' && typeof refetchRepositoryEvidence === 'function') {
      const received = receiveRoleReturn({
        raw: JSON.stringify(roleReturn), packet, refetchTask, refetchRepositoryEvidence,
        producerReceipt, resolveTrustedAdapter, now, runGit, historicalCloseout,
      }, { capabilities, resolveActivationBinding, minimumReturnAssurance: minimumReturnAssurance ?? record.observedReturnGrade });
      if (!received.ok) errors.push(...(received.validation?.errors ?? ['authoritative role-return revalidation failed']));
      else if (received.returnAssurance !== record.observedReturnGrade) errors.push('fresh return assurance does not match the stored observed grade');
    }
    return errors;
  };

  const errors = revalidateNonExecuting();
  return { ok: errors.length === 0, errors, record };
}
