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
import {
  HOST_SIGNATURE_ALGORITHM,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from './host-trust.js';

export const ROLE_RETURN_RECEIPT_KIND = 'agenticloop.role-return-producer';
export const LEGACY_ROLE_RETURN_RECEIPT_SCHEMA_VERSION = 1;
export const ROLE_RETURN_RECEIPT_SCHEMA_VERSION = 2;
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
  if (typeof packet?.activation?.repositoryIdentity !== 'string' || !packet.activation.repositoryIdentity) {
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
    targetRepository: packet.activation.repositoryIdentity,
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
  if (packet?.activation?.adapter !== trustedAdapter.adapterId ||
      packet?.activation?.signature?.keyId !== trustedAdapter.keyId ||
      packet?.activation?.repositoryIdentity !== trustedAdapter.repositoryIdentity ||
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
