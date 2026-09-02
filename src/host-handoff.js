/**
 * Authenticated host-adapter receipts for the activation and role-return
 * handoffs.
 *
 * These receipts are asymmetric on purpose. A shared secret would have to reach
 * the CLI through the same environment an agent uses to invoke the CLI, so the
 * agent could mint its own receipts and the boundary would only look like a
 * trust boundary. With Ed25519 the private half never leaves the host: the CLI
 * receives a pinned public key, an adapter id, and a key id, and can only ever
 * verify. Private signing material must stay outside the repository, generated
 * artifacts, packets, returns, prompts, and agent-visible environments.
 */

import { canonicalSha256 } from './canonical-json.js';
import { deepFreeze } from './immutable.js';
import { validateExecutionEvidence } from './execution-evidence.js';
import {
  HOST_SIGNATURE_ALGORITHM,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from './host-trust.js';

export const ROLE_RETURN_RECEIPT_KIND = 'agenticloop.role-return-producer';
export const LEGACY_ROLE_RETURN_RECEIPT_SCHEMA_VERSION = 1;
export const ROLE_RETURN_RECEIPT_SCHEMA_VERSION = 2;
export const EXCEPTIONAL_VERIFICATION_RECEIPT_KIND = 'agenticloop.exceptional-verification-producer';
export const EXCEPTIONAL_VERIFICATION_RECEIPT_SCHEMA_VERSION = 1;
export const EXECUTION_RECEIPT_KIND = 'agenticloop.execution-receipt';
export const EXECUTION_RECEIPT_SCHEMA_VERSION = 1;
export const ACTIVATION_SIGNATURE_KIND = 'agenticloop.activation-capture-signature';
export const ACTIVATION_SIGNATURE_SCHEMA_VERSION = 2;

const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class HostProducerMismatchError extends TypeError {
  constructor(message = 'host-observed producer role does not match the dispatched and returned role') {
    super(message);
    this.name = 'HostProducerMismatchError';
    this.code = 'role_return.producer_mismatch';
  }
}

export class HostReceiptStaleVersionError extends TypeError {
  constructor(
    observedVersion = LEGACY_ROLE_RETURN_RECEIPT_SCHEMA_VERSION,
    requiredVersion = ROLE_RETURN_RECEIPT_SCHEMA_VERSION
  ) {
    super(
      `host handoff receipt schemaVersion ${observedVersion} is stale; ` +
      `reissue the receipt as schemaVersion ${requiredVersion}`
    );
    this.name = 'HostReceiptStaleVersionError';
    this.code = 'role_return.receipt_stale';
    this.observedVersion = observedVersion;
    this.requiredVersion = requiredVersion;
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const wanted = expected instanceof Set ? expected : new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== wanted.size || actual.some(key => !wanted.has(key))) {
    throw new TypeError(`${label} fields must equal the closed schema`);
  }
}

/** Canonical identity of repository evidence signed by a host receipt. */
export function repositoryEvidenceDigest(evidence) {
  return `sha256:agenticloop.repository-evidence.v1:${canonicalSha256(evidence)}`;
}

function packetRepositoryIdentity(packet) {
  return packet?.activationBinding?.grant?.repositoryIdentity ?? packet?.activation?.repositoryIdentity ?? null;
}

/** Canonical work-unit identity bound by packets, returns, and host receipts. */
export function packetWorkUnitIdentity(packet) {
  return packet?.decomposition?.workUnitId ??
    packet?.decomposition?.scan?.workUnit?.id ??
    packet?.decomposition?.workUnit?.id ??
    null;
}

function executionEvidenceBinding(packet, roleReturn, repositoryEvidence) {
  return {
    packetId: packet?.packetId,
    packetDigest: packet?.digest,
    invocationId: packet?.assignment?.invocationId,
    taskId: packet?.task?.id,
    taskContractDigest: packet?.task?.taskContractDigest,
    currentCarrierDigest: roleReturn?.task?.currentCarrierDigest,
    repositoryHead: repositoryEvidence?.workflowHead,
    productHead: roleReturn?.productHead,
  };
}

/**
 * The exact bytes an activation-capture signature covers. Everything a capture
 * asserts about its own authority is inside this payload.
 */
export function activationSignaturePayload(capture) {
  return {
    kind: ACTIVATION_SIGNATURE_KIND,
    schemaVersion: ACTIVATION_SIGNATURE_SCHEMA_VERSION,
    adapter: capture?.adapter ?? null,
    keyId: capture?.signature?.keyId ?? null,
    captureId: capture?.captureId ?? null,
    intendedTaskId: capture?.intendedTaskId ?? null,
    repositoryIdentity: capture?.repositoryIdentity ?? null,
    captureCapability: capture?.captureCapability ?? null,
    operatorExpectedDigest: capture?.operatorExpectedDigest ?? null,
    normalizedActivationDigest: capture?.normalizedActivationDigest ?? null,
    capturedAt: capture?.capturedAt ?? null,
    expiresAt: capture?.expiresAt ?? null,
  };
}

/**
 * Attach a host signature to a capture skeleton. Only a host holding the
 * isolated private key can do this, which is what makes a capture's `supported`
 * capability meaningful rather than self-asserted.
 */
export function signActivationCapture(capture, { keyId, privateKey } = {}) {
  if (typeof keyId !== 'string' || !keyId.trim()) throw new TypeError('activation capture keyId is required');
  const skeleton = { ...capture, signature: { algorithm: HOST_SIGNATURE_ALGORITHM, keyId, value: null } };
  const value = signHostPayload(activationSignaturePayload(skeleton), privateKey);
  return deepFreeze({ ...skeleton, signature: { algorithm: HOST_SIGNATURE_ALGORITHM, keyId, value } });
}

/**
 * Verify a capture signature against one pinned trust-store adapter.
 * Returns a boolean; malformed input is a failed verification, not a throw.
 */
export function verifyActivationCaptureSignature(capture, trustedAdapter) {
  if (!trustedAdapter || capture?.adapter !== trustedAdapter.adapterId) return false;
  const signature = capture?.signature;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return false;
  if (signature.algorithm !== HOST_SIGNATURE_ALGORITHM) return false;
  if (signature.keyId !== trustedAdapter.keyId) return false;
  if (capture?.repositoryIdentity !== trustedAdapter.repositoryIdentity) return false;
  if (!ISO_INSTANT_RE.test(String(capture?.capturedAt ?? ''))) return false;
  if (!ISO_INSTANT_RE.test(String(capture?.expiresAt ?? ''))) return false;
  return verifyHostPayload(activationSignaturePayload(capture), signature.value, trustedAdapter.publicKey);
}

export function hostHandoffReceiptSignaturePayload(receipt) {
  return {
    ...receipt,
    authentication: {
      algorithm: receipt?.authentication?.algorithm,
      keyId: receipt?.authentication?.keyId,
    },
  };
}

function exactExecutionReceiptArtifact(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 10 &&
    ['checkId', 'path', 'digest', 'logicalCommand', 'args', 'resolvedExecutable', 'wrapperKind', 'wrapperProgram', 'wrapperArgs', 'childExitCode']
      .every(key => Object.hasOwn(value, key)) &&
    typeof value.checkId === 'string' && value.checkId &&
    typeof value.path === 'string' && value.path && !value.path.startsWith('/') && !value.path.includes('\\') && !value.path.split('/').some(part => !part || part === '.' || part === '..') &&
    /^sha256:agenticloop\.execution-evidence\.v4:[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.logicalCommand === 'string' && value.logicalCommand &&
    Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string') &&
    typeof value.resolvedExecutable === 'string' && value.resolvedExecutable &&
    typeof value.wrapperKind === 'string' &&
    (value.wrapperProgram === null || typeof value.wrapperProgram === 'string') &&
    Array.isArray(value.wrapperArgs) && value.wrapperArgs.every(arg => typeof arg === 'string') &&
    value.childExitCode === 0;
}

/** The execution receipt signature excludes only its signature value. */
export function hostExecutionReceiptSignaturePayload(receipt) {
  return {
    ...receipt,
    authentication: {
      algorithm: receipt?.authentication?.algorithm,
      keyId: receipt?.authentication?.keyId,
    },
  };
}

/**
 * Protected adapters issue this only after they have re-read each listed
 * target-confined execution artifact. The target CLI never receives a key.
 */
export function createHostExecutionReceipt(input = {}, privateKey) {
  const { adapterId, keyId, packet, roleReturn, repositoryEvidence, executions, replayId } = input;
  if (typeof adapterId !== 'string' || !adapterId || typeof keyId !== 'string' || !keyId) throw new TypeError('host execution receipt adapter identity is required');
  if (!packet?.packetId || !SEMANTIC_DIGEST_RE.test(packet?.digest ?? '') || !packet?.assignment?.invocationId || !packet?.assignment?.liveness?.expiry) throw new TypeError('host execution receipt requires an exact live dispatch packet');
  if (!roleReturn?.returnId || !SEMANTIC_DIGEST_RE.test(roleReturn?.digest ?? '') || !Array.isArray(executions) || executions.length === 0 || !executions.every(exactExecutionReceiptArtifact)) throw new TypeError('host execution receipt requires passed closed execution artifacts');
  if (new Set(executions.map(item => item.checkId)).size !== executions.length || typeof replayId !== 'string' || !replayId) throw new TypeError('host execution receipt requires unique check and replay identities');
  const receipt = {
    kind: EXECUTION_RECEIPT_KIND, schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
    adapterId, source: 'host_adapter', invocationId: packet.assignment.invocationId,
    targetRepository: packetRepositoryIdentity(packet), backend: packet.backend,
    task: { id: packet.task.id, workUnitIdentity: packetWorkUnitIdentity(packet), taskContractDigest: packet.task.taskContractDigest, dispatchCarrierDigest: packet.task.dispatchCarrierDigest, currentCarrierDigest: roleReturn.task?.currentCarrierDigest },
    packet: { packetId: packet.packetId, digest: packet.digest },
    roleReturn: { returnId: roleReturn.returnId, digest: roleReturn.digest },
    repositoryEvidenceDigest: repositoryEvidenceDigest(repositoryEvidence),
    heads: { productBaseHead: roleReturn.productBaseHead, productHead: roleReturn.productHead, workflowHead: roleReturn.workflowHead, candidateHead: roleReturn.candidateHead },
    executions: structuredClone(executions), replayId, issuedAt: input.issuedAt ?? new Date().toISOString(),
    freshness: { expiry: input.expiry ?? packet.assignment.liveness.expiry },
    authentication: { algorithm: HOST_SIGNATURE_ALGORITHM, keyId, value: null },
  };
  receipt.authentication.value = signHostPayload(hostExecutionReceiptSignaturePayload(receipt), privateKey);
  return deepFreeze(receipt);
}

/** Authenticate a protected execution receipt without re-running any command. */
export function verifyHostExecutionReceipt(receipt, {
  trustedAdapter, packet, roleReturn, repositoryEvidence, target, readExecutionArtifact, now = Date.now(),
} = {}) {
  const keys = ['kind', 'schemaVersion', 'adapterId', 'source', 'invocationId', 'targetRepository', 'backend', 'task', 'packet', 'roleReturn', 'repositoryEvidenceDigest', 'heads', 'executions', 'replayId', 'issuedAt', 'freshness', 'authentication'];
  exactKeys(receipt, keys, 'host execution receipt');
  exactKeys(receipt.task, ['id', 'workUnitIdentity', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest'], 'host execution receipt task');
  exactKeys(receipt.packet, ['packetId', 'digest'], 'host execution receipt packet');
  exactKeys(receipt.roleReturn, ['returnId', 'digest'], 'host execution receipt return');
  exactKeys(receipt.heads, ['productBaseHead', 'productHead', 'workflowHead', 'candidateHead'], 'host execution receipt heads');
  exactKeys(receipt.freshness, ['expiry'], 'host execution receipt freshness');
  exactKeys(receipt.authentication, ['algorithm', 'keyId', 'value'], 'host execution receipt authentication');
  if (receipt.kind !== EXECUTION_RECEIPT_KIND || receipt.schemaVersion !== EXECUTION_RECEIPT_SCHEMA_VERSION || receipt.source !== 'host_adapter' || !Array.isArray(receipt.executions) || !receipt.executions.length || !receipt.executions.every(exactExecutionReceiptArtifact)) throw new TypeError('host execution receipt identity is invalid');
  if (!trustedAdapter || trustedAdapter.capabilities?.returnReceipt !== 'supported' || receipt.adapterId !== trustedAdapter.adapterId || receipt.authentication.algorithm !== HOST_SIGNATURE_ALGORITHM || receipt.authentication.keyId !== trustedAdapter.keyId || !verifyHostPayload(hostExecutionReceiptSignaturePayload(receipt), receipt.authentication.value, trustedAdapter.publicKey)) throw new TypeError('host execution receipt authentication failed');
  if (!ISO_INSTANT_RE.test(receipt.issuedAt ?? '') || !ISO_INSTANT_RE.test(receipt.freshness.expiry ?? '') || Date.parse(receipt.issuedAt) > now + 1000 || Date.parse(receipt.issuedAt) > Date.parse(receipt.freshness.expiry) || now > Date.parse(receipt.freshness.expiry)) throw new TypeError('host execution receipt freshness is invalid or expired');
  if (receipt.targetRepository !== trustedAdapter.repositoryIdentity || receipt.targetRepository !== packetRepositoryIdentity(packet) || receipt.targetRepository !== targetRepositoryIdentity(target) || receipt.backend !== packet.backend || receipt.invocationId !== packet.assignment?.invocationId || receipt.packet.packetId !== packet.packetId || receipt.packet.digest !== packet.digest || receipt.roleReturn.returnId !== roleReturn.returnId || receipt.roleReturn.digest !== roleReturn.digest || receipt.repositoryEvidenceDigest !== repositoryEvidenceDigest(repositoryEvidence) || receipt.task.id !== packet.task?.id || receipt.task.workUnitIdentity !== packetWorkUnitIdentity(packet) || receipt.task.taskContractDigest !== packet.task?.taskContractDigest || receipt.task.dispatchCarrierDigest !== packet.task?.dispatchCarrierDigest || receipt.task.currentCarrierDigest !== roleReturn.task?.currentCarrierDigest || receipt.heads.productBaseHead !== roleReturn.productBaseHead || receipt.heads.productHead !== roleReturn.productHead || receipt.heads.workflowHead !== roleReturn.workflowHead || receipt.heads.candidateHead !== roleReturn.candidateHead) throw new TypeError('host execution receipt does not bind the exact return generation');
  if (typeof readExecutionArtifact !== 'function') throw new TypeError('host execution receipt verification requires target artifact rereading');
  const commandChecks = (roleReturn.checks ?? []).filter(check => check.kind === 'command' && check.outcome === 'passed');
  if (commandChecks.length !== receipt.executions.length || new Set(receipt.executions.map(item => item.checkId)).size !== receipt.executions.length) throw new TypeError('host execution receipt does not cover every passed command check');
  for (const artifact of receipt.executions) {
    const check = commandChecks.find(item => item.id === artifact.checkId);
    if (!check || check.executionEvidence?.path !== artifact.path || check.executionEvidence?.digest !== artifact.digest) throw new TypeError('host execution receipt execution target does not match the role return');
    const execution = readExecutionArtifact(artifact.path);
    // The receipt's artifact projection is not authority for the execution
    // binding.  Rebuild it from the authoritative packet, current return, and
    // independently supplied repository evidence on every verification.
    const checked = validateExecutionEvidence(execution, {
      expectedBinding: executionEvidenceBinding(packet, roleReturn, repositoryEvidence),
    });
    if (!checked.ok || execution.digest !== artifact.digest || execution.execution.outcome !== 'passed' || execution.execution.childExitCode !== 0 || execution.check.command !== artifact.logicalCommand || JSON.stringify(execution.check.args) !== JSON.stringify(artifact.args) || execution.runner.resolvedExecutable !== artifact.resolvedExecutable || execution.runner.wrapperKind !== artifact.wrapperKind || execution.runner.wrapperProgram !== artifact.wrapperProgram || JSON.stringify(execution.runner.wrapperArgs) !== JSON.stringify(artifact.wrapperArgs)) throw new TypeError(`host execution receipt artifact '${artifact.checkId}' drifted or is invalid`);
  }
  return receipt;
}

/**
 * Create a schema-, role-, adapter-, key-, invocation-, packet-, return-,
 * repository-, liveness-, and time-bound host receipt. Host integrations call
 * this only after receiving the raw role wire and collecting repository
 * evidence at their own transport boundary.
 */
export function createHostHandoffReceipt(input = {}, privateKey) {
  const { adapterId, keyId, packet, roleReturn, repositoryEvidence, observedProducerRole } = input;
  if (typeof adapterId !== 'string' || !adapterId.trim()) throw new TypeError('host adapterId is required');
  if (typeof keyId !== 'string' || !keyId.trim()) throw new TypeError('host handoff keyId is required');
  if (!packet?.assignment?.invocationId) throw new TypeError('dispatch packet invocationId is required');
  if (!packet?.assignment?.liveness?.expiry) throw new TypeError('dispatch packet liveness expiry is required');
  if (!packet?.packetId || !SEMANTIC_DIGEST_RE.test(packet?.digest ?? '')) throw new TypeError('dispatch packet identity is invalid');
  if (!roleReturn?.returnId || !SEMANTIC_DIGEST_RE.test(roleReturn?.digest ?? '')) throw new TypeError('role return identity is invalid');
  if (typeof observedProducerRole !== 'string' || !observedProducerRole.trim()) {
    throw new TypeError('host-observed producer role is required');
  }
  if (typeof packetRepositoryIdentity(packet) !== 'string') {
    throw new TypeError('dispatch packet target repository identity is required');
  }
  const receipt = {
    kind: ROLE_RETURN_RECEIPT_KIND,
    schemaVersion: ROLE_RETURN_RECEIPT_SCHEMA_VERSION,
    producerRole: observedProducerRole,
    source: 'host_adapter',
    adapterId,
    invocationId: packet.assignment.invocationId,
    packet: { packetId: packet.packetId, digest: packet.digest },
    roleReturn: { returnId: roleReturn.returnId, digest: roleReturn.digest },
    targetRepository: packetRepositoryIdentity(packet),
    repositoryEvidenceDigest: repositoryEvidenceDigest(repositoryEvidence),
    packetLiveness: { expiry: packet.assignment.liveness.expiry },
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    authentication: {
      algorithm: HOST_SIGNATURE_ALGORITHM,
      keyId,
      value: null,
    },
  };
  receipt.authentication.value = signHostPayload(
    hostHandoffReceiptSignaturePayload(receipt),
    privateKey
  );
  return deepFreeze(receipt);
}

/**
 * Authenticate a persisted host receipt against a pinned trust-store adapter and
 * bind it to the exact artifacts being verified. Returns the receipt unchanged
 * after successful verification.
 *
 * @param {any} receipt
 * @param {{ trustedAdapter?: any, packet?: any, roleReturn?: any, repositoryEvidence?: any, now?: number }} context
 */
export function verifyHostHandoffReceipt(receipt, {
  trustedAdapter,
  packet,
  roleReturn,
  repositoryEvidence,
  now = Date.now(),
} = {}) {
  exactKeys(receipt, [
    'kind', 'schemaVersion', 'producerRole', 'source', 'adapterId',
     'invocationId', 'packet', 'roleReturn', 'targetRepository', 'repositoryEvidenceDigest',
    'packetLiveness', 'receivedAt', 'authentication',
  ], 'host handoff receipt');
  exactKeys(receipt.packet, ['packetId', 'digest'], 'host handoff packet binding');
  exactKeys(receipt.roleReturn, ['returnId', 'digest'], 'host handoff return binding');
  exactKeys(receipt.packetLiveness, ['expiry'], 'host handoff liveness binding');
  exactKeys(receipt.authentication, ['algorithm', 'keyId', 'value'], 'host handoff authentication');
  if (receipt.kind !== ROLE_RETURN_RECEIPT_KIND ||
      ![LEGACY_ROLE_RETURN_RECEIPT_SCHEMA_VERSION, ROLE_RETURN_RECEIPT_SCHEMA_VERSION]
        .includes(receipt.schemaVersion) ||
      receipt.source !== 'host_adapter') {
    throw new TypeError('host handoff receipt identity is invalid');
  }
  if (!trustedAdapter || typeof trustedAdapter !== 'object') {
    throw new TypeError('host handoff verification requires a pinned trust-store adapter');
  }
  if (trustedAdapter.capabilities?.returnReceipt !== 'supported') {
    throw new TypeError(`host adapter '${trustedAdapter.adapterId}' is not trusted to produce role-return receipts`);
  }
  if (receipt.adapterId !== trustedAdapter.adapterId) {
    throw new TypeError('host handoff receipt adapter is not the pinned trusted adapter');
  }
  if (receipt.authentication.algorithm !== HOST_SIGNATURE_ALGORITHM ||
      receipt.authentication.keyId !== trustedAdapter.keyId) {
    throw new TypeError('host handoff receipt key identity is not the pinned trusted key');
  }
  if (!verifyHostPayload(
    hostHandoffReceiptSignaturePayload(receipt),
    receipt.authentication.value,
    trustedAdapter.publicKey
  )) {
    throw new TypeError('host handoff receipt authentication failed');
  }
  if (receipt.schemaVersion === LEGACY_ROLE_RETURN_RECEIPT_SCHEMA_VERSION) {
    throw new HostReceiptStaleVersionError();
  }
  if (packet?.returnAdapter?.adapterId !== trustedAdapter.adapterId ||
      packet?.returnAdapter?.keyId !== trustedAdapter.keyId ||
      packetRepositoryIdentity(packet) !== trustedAdapter.repositoryIdentity ||
      receipt.targetRepository !== trustedAdapter.repositoryIdentity ||
      targetRepositoryIdentity(repositoryEvidence?.worktree) !== trustedAdapter.repositoryIdentity) {
    throw new TypeError('host handoff receipt target, adapter, or key is not the packet-bound operator trust identity');
  }
  if (!ISO_INSTANT_RE.test(receipt.receivedAt ?? '') ||
      !Number.isFinite(Date.parse(receipt.receivedAt)) ||
      Date.parse(receipt.receivedAt) > now + 1000) {
    throw new TypeError('host handoff receivedAt is invalid or future-dated');
  }
  if (receipt.producerRole !== packet?.assignment?.roleId ||
      receipt.producerRole !== roleReturn?.producerRole) {
    throw new HostProducerMismatchError();
  }
  if (receipt.invocationId !== packet?.assignment?.invocationId ||
      receipt.packet.packetId !== packet?.packetId ||
      receipt.packet.digest !== packet?.digest ||
      receipt.roleReturn.returnId !== roleReturn?.returnId ||
      receipt.roleReturn.digest !== roleReturn?.digest ||
      receipt.repositoryEvidenceDigest !== repositoryEvidenceDigest(repositoryEvidence) ||
      receipt.packetLiveness.expiry !== packet?.assignment?.liveness?.expiry) {
    throw new TypeError('host handoff receipt does not bind the exact invocation artifacts');
  }
  const expiry = Date.parse(receipt.packetLiveness.expiry);
  if (!Number.isFinite(expiry) || Date.parse(receipt.receivedAt) > expiry) {
    throw new TypeError('host handoff receipt was produced after the dispatch liveness window closed');
  }
  return receipt;
}

/** Create a pinned-host receipt for an exceptional-verification wire value. */
export function createHostExceptionalVerificationReceipt(input = {}, privateKey) {
  const { adapterId, keyId, packet, exceptionalVerification, repositoryEvidence, observedProducerRole } = input;
  if (typeof adapterId !== 'string' || !adapterId.trim() || typeof keyId !== 'string' || !keyId.trim()) throw new TypeError('host exceptional receipt adapterId and keyId are required');
  if (!packet?.assignment?.invocationId || !packet?.assignment?.liveness?.expiry || !packet?.packetId || !SEMANTIC_DIGEST_RE.test(packet?.digest ?? '')) throw new TypeError('dispatch packet identity and liveness are required');
  if (!exceptionalVerification?.requestId || !SEMANTIC_DIGEST_RE.test(exceptionalVerification?.digest ?? '')) throw new TypeError('exceptional-verification identity is invalid');
  if (typeof observedProducerRole !== 'string' || !observedProducerRole.trim() || !packetRepositoryIdentity(packet)) throw new TypeError('host-observed producer role and target repository are required');
  const receipt = {
    kind: EXCEPTIONAL_VERIFICATION_RECEIPT_KIND, schemaVersion: EXCEPTIONAL_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    producerRole: observedProducerRole, source: 'host_adapter', adapterId,
    invocationId: packet.assignment.invocationId,
    packet: { packetId: packet.packetId, digest: packet.digest },
    exceptionalVerification: { requestId: exceptionalVerification.requestId, digest: exceptionalVerification.digest },
    targetRepository: packetRepositoryIdentity(packet),
    repositoryEvidenceDigest: repositoryEvidenceDigest(repositoryEvidence),
    packetLiveness: { expiry: packet.assignment.liveness.expiry },
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    authentication: { algorithm: HOST_SIGNATURE_ALGORITHM, keyId, value: null },
  };
  receipt.authentication.value = signHostPayload(hostHandoffReceiptSignaturePayload(receipt), privateKey);
  return deepFreeze(receipt);
}

/** Verify the exceptional request bytes at the same pinned host boundary. */
export function verifyHostExceptionalVerificationReceipt(receipt, {
  trustedAdapter, packet, exceptionalVerification, repositoryEvidence, now = Date.now(),
} = {}) {
  exactKeys(receipt, [
    'kind', 'schemaVersion', 'producerRole', 'source', 'adapterId', 'invocationId', 'packet',
    'exceptionalVerification', 'targetRepository', 'repositoryEvidenceDigest', 'packetLiveness', 'receivedAt', 'authentication',
  ], 'host exceptional-verification receipt');
  exactKeys(receipt.packet, ['packetId', 'digest'], 'host exceptional receipt packet binding');
  exactKeys(receipt.exceptionalVerification, ['requestId', 'digest'], 'host exceptional receipt request binding');
  exactKeys(receipt.packetLiveness, ['expiry'], 'host exceptional receipt liveness binding');
  exactKeys(receipt.authentication, ['algorithm', 'keyId', 'value'], 'host exceptional receipt authentication');
  if (receipt.kind !== EXCEPTIONAL_VERIFICATION_RECEIPT_KIND || receipt.schemaVersion !== EXCEPTIONAL_VERIFICATION_RECEIPT_SCHEMA_VERSION || receipt.source !== 'host_adapter') throw new TypeError('host exceptional-verification receipt identity is invalid');
  if (!trustedAdapter || trustedAdapter.capabilities?.returnReceipt !== 'supported' || receipt.adapterId !== trustedAdapter.adapterId || receipt.authentication.algorithm !== HOST_SIGNATURE_ALGORITHM || receipt.authentication.keyId !== trustedAdapter.keyId) throw new TypeError('host exceptional-verification receipt adapter or key is not trusted');
  if (!verifyHostPayload(hostHandoffReceiptSignaturePayload(receipt), receipt.authentication.value, trustedAdapter.publicKey)) throw new TypeError('host exceptional-verification receipt authentication failed');
  if (packet?.returnAdapter?.adapterId !== trustedAdapter.adapterId || packet?.returnAdapter?.keyId !== trustedAdapter.keyId || packetRepositoryIdentity(packet) !== trustedAdapter.repositoryIdentity || receipt.targetRepository !== trustedAdapter.repositoryIdentity || targetRepositoryIdentity(repositoryEvidence?.worktree) !== trustedAdapter.repositoryIdentity) throw new TypeError('host exceptional-verification receipt target is not packet-bound');
  if (!ISO_INSTANT_RE.test(receipt.receivedAt ?? '') || !Number.isFinite(Date.parse(receipt.receivedAt)) || Date.parse(receipt.receivedAt) > now + 1000) throw new TypeError('host exceptional-verification receipt receivedAt is invalid or future-dated');
  if (receipt.producerRole !== packet?.assignment?.roleId || receipt.producerRole !== exceptionalVerification?.producer?.roleId || receipt.invocationId !== packet?.assignment?.invocationId || receipt.packet.packetId !== packet?.packetId || receipt.packet.digest !== packet?.digest || receipt.exceptionalVerification.requestId !== exceptionalVerification?.requestId || receipt.exceptionalVerification.digest !== exceptionalVerification?.digest || receipt.repositoryEvidenceDigest !== repositoryEvidenceDigest(repositoryEvidence) || receipt.packetLiveness.expiry !== packet?.assignment?.liveness?.expiry) throw new TypeError('host exceptional-verification receipt does not bind the exact invocation artifacts');
  const expiry = Date.parse(receipt.packetLiveness.expiry);
  if (!Number.isFinite(expiry) || Date.parse(receipt.receivedAt) > expiry) throw new TypeError('host exceptional-verification receipt was produced after the dispatch liveness window closed');
  return receipt;
}
