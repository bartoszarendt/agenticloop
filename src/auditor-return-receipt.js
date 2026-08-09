/**
 * Production verification for protected-host Auditor return receipts.
 *
 * The ordinary CLI does not call this loader automatically. A host integration
 * that owns an authenticated boundary loads the fixed operator trust store and
 * injects the returned verifier through `auditProvenanceVerifier`.
 */

import { canonicalJson } from './canonical-json.js';
import { deepFreeze } from './immutable.js';
import {
  HOST_SIGNATURE_ALGORITHM,
  loadHostTrustStore,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from './host-trust.js';

export const AUDITOR_RETURN_RECEIPT_KIND = 'agenticloop.auditor-return-receipt';
export const AUDITOR_RETURN_RECEIPT_SCHEMA_VERSION = 1;
/**
 * Tolerated clock disagreement between the signing host and this process for a
 * receipt's `issuedAt`. This bounds skew, not liveness: it is a separate policy
 * from `HOST_TRUST_CHALLENGE_TTL_MS`, which bounds how long one protected
 * loader challenge stays answerable. Neither derives from the other.
 */
export const AUDITOR_RECEIPT_FUTURE_SKEW_MS = 5_000;
/**
 * Maximum age and maximum declared validity interval of one Auditor return
 * receipt.
 *
 * A receipt proves that a protected host returned one specific audit report for
 * one specific invocation. That is a statement about a single in-flight audit
 * turn, so both the interval the receipt claims for itself
 * (`expiresAt - issuedAt`) and its observed age (`now - issuedAt`) are bounded
 * here. Without the interval bound a signing host could mint a receipt with an
 * arbitrarily distant `expiresAt` and keep it replayable indefinitely; without
 * the age bound an old receipt with a far-future expiry stayed `current`.
 *
 * Fifteen minutes covers a long single audit round trip, including a host that
 * waits on a human, while keeping a captured receipt useless once that turn is
 * over. It is a distinct policy from `AUDITOR_RECEIPT_FUTURE_SKEW_MS` (clock
 * disagreement) and from `HOST_TRUST_CHALLENGE_TTL_MS` (loader-challenge
 * liveness); none of the three derives from another.
 */
export const AUDITOR_RECEIPT_MAX_VALIDITY_MS = 900_000;

const DIGEST_RE = /^sha256:agenticloop\.auditor-return-report\.v1:[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const rendered = new Date(epoch).toISOString();
  return rendered === value || rendered.replace('.000Z', 'Z') === value ? epoch : null;
}

function canonicalTasks(value) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) return null;
  const tasks = value.map(item => item.trim()).sort();
  if (tasks.length === 0 || new Set(tasks).size !== tasks.length) return null;
  return tasks;
}

/** Exact canonical payload authenticated by the host signature. */
export function auditorReturnReceiptSignaturePayload(receipt) {
  return {
    ...receipt,
    authentication: {
      algorithm: receipt?.authentication?.algorithm,
      keyId: receipt?.authentication?.keyId,
    },
  };
}

/**
 * Bounded host-integration helper. Private keys remain external to the package,
 * generated adapters, CLI, and target repository.
 */
export function createAuditorReturnReceipt(input = {}, privateKey) {
  const tasks = canonicalTasks(input.coveredTasks);
  if (!tasks) throw new TypeError('Auditor return receipt coveredTasks must be a unique non-empty string array');
  const receipt = {
    kind: AUDITOR_RETURN_RECEIPT_KIND,
    schemaVersion: AUDITOR_RETURN_RECEIPT_SCHEMA_VERSION,
    receiptId: input.receiptId,
    producerRole: 'auditor',
    source: 'host_adapter',
    adapterId: input.adapterId,
    targetRepository: input.targetRepository,
    invocation: { reference: input.invocationReference, mode: input.invocationMode },
    audit: {
      workUnit: input.workUnit,
      candidateArtifact: input.candidateArtifact,
      coveredTasks: tasks,
    },
    reportDigest: input.reportDigest,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    authentication: {
      algorithm: HOST_SIGNATURE_ALGORITHM,
      keyId: input.keyId,
      value: null,
    },
  };
  const structural = validateAuditorReturnReceiptShape(receipt, { allowUnsigned: true });
  if (!structural.ok) throw new TypeError(structural.errors.join('; '));
  receipt.authentication.value = signHostPayload(auditorReturnReceiptSignaturePayload(receipt), privateKey);
  return deepFreeze(receipt);
}

/** Closed shape validation; no semantic or freshness authority is inferred. */
export function validateAuditorReturnReceiptShape(receipt, { allowUnsigned = false } = {}) {
  const errors = [];
  if (!exactKeys(receipt, [
    'kind', 'schemaVersion', 'receiptId', 'producerRole', 'source', 'adapterId',
    'targetRepository', 'invocation', 'audit', 'reportDigest', 'issuedAt',
    'expiresAt', 'authentication',
  ])) return { ok: false, errors: ['Auditor return receipt fields must equal the closed schema'] };
  if (receipt.kind !== AUDITOR_RETURN_RECEIPT_KIND || receipt.schemaVersion !== AUDITOR_RETURN_RECEIPT_SCHEMA_VERSION) {
    errors.push('Auditor return receipt identity is invalid');
  }
  for (const [label, value] of [
    ['receiptId', receipt.receiptId], ['adapterId', receipt.adapterId],
  ]) if (typeof value !== 'string' || !ID_RE.test(value)) errors.push(`Auditor return receipt ${label} is invalid`);
  if (typeof receipt.targetRepository !== 'string' || !receipt.targetRepository.startsWith('file:')) {
    errors.push('Auditor return receipt targetRepository is invalid');
  }
  if (receipt.producerRole !== 'auditor') errors.push("Auditor return receipt producerRole must be 'auditor'");
  if (receipt.source !== 'host_adapter') errors.push("Auditor return receipt source must be 'host_adapter'");
  if (!exactKeys(receipt.invocation, ['reference', 'mode']) ||
      typeof receipt.invocation?.reference !== 'string' || !receipt.invocation.reference.trim() ||
      typeof receipt.invocation?.mode !== 'string' || !receipt.invocation.mode.trim()) {
    errors.push('Auditor return receipt invocation is invalid');
  }
  if (!exactKeys(receipt.audit, ['workUnit', 'candidateArtifact', 'coveredTasks']) ||
      typeof receipt.audit?.workUnit !== 'string' || !receipt.audit.workUnit.trim() ||
      typeof receipt.audit?.candidateArtifact !== 'string' || !receipt.audit.candidateArtifact.trim() ||
      canonicalTasks(receipt.audit?.coveredTasks) === null ||
      canonicalJson(receipt.audit?.coveredTasks) !== canonicalJson(canonicalTasks(receipt.audit?.coveredTasks))) {
    errors.push('Auditor return receipt audit binding is invalid');
  }
  if (typeof receipt.reportDigest !== 'string' || !DIGEST_RE.test(receipt.reportDigest)) {
    errors.push('Auditor return receipt reportDigest is invalid');
  }
  if (canonicalInstant(receipt.issuedAt) === null || canonicalInstant(receipt.expiresAt) === null) {
    errors.push('Auditor return receipt liveness timestamps are invalid');
  }
  if (!exactKeys(receipt.authentication, ['algorithm', 'keyId', 'value']) ||
      receipt.authentication?.algorithm !== HOST_SIGNATURE_ALGORITHM ||
      typeof receipt.authentication?.keyId !== 'string' || !ID_RE.test(receipt.authentication.keyId) ||
      (!allowUnsigned && (typeof receipt.authentication?.value !== 'string' || !receipt.authentication.value))) {
    errors.push('Auditor return receipt authentication is invalid');
  }
  return { ok: errors.length === 0, errors };
}

/** Stable identity used only for replay detection; it grants no trust. */
export function auditorReturnReceiptIdentity(receiptWire) {
  try {
    const receipt = typeof receiptWire === 'string' ? JSON.parse(receiptWire) : receiptWire;
    return receipt?.kind === AUDITOR_RETURN_RECEIPT_KIND &&
      receipt?.schemaVersion === AUDITOR_RETURN_RECEIPT_SCHEMA_VERSION &&
      typeof receipt?.receiptId === 'string' && ID_RE.test(receipt.receiptId)
      ? receipt.receiptId
      : null;
  } catch {
    return null;
  }
}

/**
 * Authenticate first, then compare semantic bindings, then evaluate freshness.
 */
export function verifyAuditorReturnReceipt(receiptWire, context = {}) {
  let receipt;
  try {
    receipt = typeof receiptWire === 'string' ? JSON.parse(receiptWire) : receiptWire;
  } catch {
    return { verified: false, state: 'untrusted', error: 'Auditor return receipt is not valid JSON' };
  }
  const shape = validateAuditorReturnReceiptShape(receipt);
  if (!shape.ok) return { verified: false, state: 'untrusted', error: shape.errors.join('; ') };
  const adapter = context.trustedAdapter;
  if (!adapter || adapter.capabilities?.returnReceipt !== 'supported' ||
      receipt.adapterId !== adapter.adapterId ||
      receipt.authentication.keyId !== adapter.keyId ||
      receipt.authentication.algorithm !== adapter.algorithm ||
      !verifyHostPayload(auditorReturnReceiptSignaturePayload(receipt), receipt.authentication.value, adapter.publicKey)) {
    return { verified: false, state: 'untrusted', error: 'Auditor return receipt signature did not verify against the pinned host adapter' };
  }
  const expectedTasks = canonicalTasks(context.coveredTasks);
  const semanticMatch = receipt.targetRepository === adapter.repositoryIdentity &&
    receipt.targetRepository === targetRepositoryIdentity(context.target) &&
    receipt.producerRole === 'auditor' && context.role === 'auditor' &&
    receipt.invocation.reference === context.invocationReference &&
    receipt.invocation.mode === context.invocationMode &&
    receipt.audit.workUnit === context.workUnit &&
    receipt.audit.candidateArtifact === context.candidateArtifact &&
    expectedTasks !== null && canonicalJson(receipt.audit.coveredTasks) === canonicalJson(expectedTasks) &&
    receipt.reportDigest === context.reportDigest;
  if (!semanticMatch) {
    return { verified: false, state: 'untrusted', error: 'Auditor return receipt does not match the protected invocation and report binding' };
  }
  const issuedAt = canonicalInstant(receipt.issuedAt);
  const expiresAt = canonicalInstant(receipt.expiresAt);
  const now = context.now === undefined || context.now === null ? Date.now() : Number(context.now);
  // A non-finite verification clock makes every comparison below false, which
  // silently turned freshness off. There is no clock, so there is no freshness
  // judgement to make: refuse rather than admit the receipt.
  if (!Number.isFinite(now)) {
    return { verified: false, state: 'stale', error: 'Auditor return receipt freshness requires a finite verification clock' };
  }
  if (issuedAt >= expiresAt ||
      issuedAt > now + AUDITOR_RECEIPT_FUTURE_SKEW_MS ||
      expiresAt <= now ||
      expiresAt - issuedAt > AUDITOR_RECEIPT_MAX_VALIDITY_MS ||
      now - issuedAt > AUDITOR_RECEIPT_MAX_VALIDITY_MS) {
    return { verified: false, state: 'stale', error: 'Auditor return receipt is expired or outside its liveness window' };
  }
  return {
    verified: true,
    state: 'current',
    reportDigest: receipt.reportDigest,
    receiptId: receipt.receiptId,
    canonicalReceipt: canonicalJson(receipt),
  };
}

/** Load one protected, operator-pinned production verifier for a host wrapper. */
export function loadAuditorReturnReceiptVerifier(options = {}) {
  const loaded = loadHostTrustStore(options.target, {
    operatorTrustRoot: options.operatorTrustRoot,
    assertedPath: options.assertedPath,
    protectedBoundary: options.protectedBoundary,
    requiredSupportedAdapterIds: [options.adapterId],
    // Loader-challenge liveness reads `clock` twice and never reads `now`, so a
    // caller that only pins `now` for receipt freshness leaves challenge expiry
    // on the real clock instead of freezing it.
    clock: options.clock,
    monotonicClock: options.monotonicClock,
  });
  if (!loaded.ok) return { ...loaded, verifier: null };
  const trustedAdapter = loaded.adapters?.[options.adapterId];
  if (!trustedAdapter || trustedAdapter.capabilities.returnReceipt !== 'supported') {
    return {
      ...loaded,
      ok: false,
      errors: [`host adapter '${String(options.adapterId ?? '')}' does not provide a supported returnReceipt capability`],
      verifier: null,
    };
  }
  const target = options.target;
  return {
    ...loaded,
    verifier: input => verifyAuditorReturnReceipt(input.receipt, {
      ...input,
      target,
      trustedAdapter,
      now: options.now,
    }),
  };
}
