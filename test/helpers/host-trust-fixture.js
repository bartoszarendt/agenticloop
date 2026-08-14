/**
 * Isolated host trust fixture.
 *
 * Agentic Loop ships no adapter with a parser-owned activation channel, and it
 * deliberately contains no fixture adapter identity: a `supported` capture is
 * only ever granted by an operator who pins a real Ed25519 public key. Tests
 * therefore act as that operator. Every key pair is generated in-process, the
 * private half never touches the repository or an archive, and the resulting
 * capability inventory is injected explicitly.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { activationCapabilityInventory } from '../../src/dispatch-envelope.js';
import { canonicalJson } from '../../src/canonical-json.js';
import {
  createHostExecutionReceipt,
  createHostHandoffReceipt,
} from '../../src/host-handoff.js';
import {
  generateHostSigningKey,
  HOST_TRUST_BOUNDARY_RESPONSE_KIND,
  HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
  hostTrustBoundarySignaturePayload,
  EXECUTION_RECEIPT_REPLAY_BOUNDARY_KIND,
  EXECUTION_RECEIPT_REPLAY_BOUNDARY_SCHEMA_VERSION,
  executionReceiptReplaySignaturePayload,
  operatorTrustStorePath,
  signHostPayload,
  targetRepositoryIdentity,
} from '../../src/host-trust.js';

export const TEST_ADAPTER_ID = 'agenticloop.test.parser.v1';
export const TEST_KEY_ID = 'agenticloop-test-key-1';

/**
 * Create one operator-pinned host adapter with a freshly generated key pair.
 *
 * @param {{ adapterId?: string, keyId?: string, activationCapture?: string, returnReceipt?: string, target?: string }} [options]
 */
export function createTestHostTrust(options = {}) {
  const {
    adapterId = TEST_ADAPTER_ID,
    keyId = TEST_KEY_ID,
    activationCapture = 'supported',
    returnReceipt = 'supported',
    target = join(process.cwd(), 'operator-test-target'),
  } = options;
  const { privateKey, publicKey, publicKeyBase64 } = generateHostSigningKey();
  const repositoryIdentity = targetRepositoryIdentity(target);
  const adapter = {
    adapterId,
    keyId,
    algorithm: 'ed25519',
    publicKey: publicKeyBase64,
    capabilities: { activationCapture, returnReceipt },
    repositoryIdentity,
  };
  return {
    target,
    adapterId,
    keyId,
    privateKey,
    publicKey,
    publicKeyBase64,
    adapter,
    repositoryIdentity,
    document: {
      kind: 'agenticloop.host-trust', schemaVersion: 1,
      target: { repositoryIdentity },
      adapters: [{
        adapterId, keyId, algorithm: 'ed25519', publicKey: publicKeyBase64,
        capabilities: { activationCapture, returnReceipt },
      }],
    },
    capabilities: activationCapabilityInventory({ [adapterId]: adapter }),
  };
}

/** Persist a trust document outside the target repository. */
export function writeHostTrustStore(operatorRoot, trust) {
  const path = operatorTrustStorePath(trust.target, operatorRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(trust.document, null, 2)}\n`, 'utf8');
  return path;
}

/** Return a challenge-signing host boundary backed by the fixture's private key. */
export function protectedHostBoundary(trust, observe = () => {}) {
  const replay = new Map();
  return challenge => {
    if (challenge?.kind === EXECUTION_RECEIPT_REPLAY_BOUNDARY_KIND) {
      observe(challenge);
      const binding = challenge.binding;
      const key = `${binding.adapterId}\u0000${binding.keyId}\u0000${binding.targetRepositoryIdentity}\u0000${binding.replayId}`;
      const existing = replay.get(key);
      let state = 'rejected';
      let transactionId = null;
      if (challenge.operation === 'prepare' && !existing) {
        transactionId = `replay-tx:${Math.random().toString(36).slice(2)}`;
        replay.set(key, { binding: structuredClone(binding), transactionId, state: 'prepared' });
        state = 'prepared';
      } else if (existing && canonicalJson(existing.binding) === canonicalJson(binding)) {
        transactionId = existing.transactionId;
        if (challenge.operation === 'commit' && existing.state === 'prepared' && challenge.transactionId === transactionId) {
          existing.state = 'committed'; state = 'committed';
        } else if (challenge.operation === 'abort' && existing.state === 'prepared' && challenge.transactionId === transactionId) {
          replay.delete(key); state = 'aborted';
        } else if (challenge.operation === 'verify' && existing.state === 'committed') state = 'current';
      }
      const response = { kind: EXECUTION_RECEIPT_REPLAY_BOUNDARY_KIND, schemaVersion: EXECUTION_RECEIPT_REPLAY_BOUNDARY_SCHEMA_VERSION, operation: challenge.operation, binding, transactionId, state, signature: null };
      response.signature = signHostPayload(executionReceiptReplaySignaturePayload(challenge, response), trust.privateKey);
      return response;
    }
    observe(challenge);
    const response = {
      kind: HOST_TRUST_BOUNDARY_RESPONSE_KIND,
      schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
      adapterId: trust.adapterId,
      keyId: trust.keyId,
      challengeNonce: challenge.nonce,
      signature: null,
    };
    response.signature = signHostPayload(hostTrustBoundarySignaturePayload(challenge, response), trust.privateKey);
    return response;
  };
}

/**
 * Model the only external-only part of an authenticated return: the protected
 * host signs observations after the public CLI has produced its ordinary
 * packet, execution artifact, and role-return wire values.
 */
export function createAuthenticatedReturnReceipts(trust, {
  packet,
  roleReturn,
  repositoryEvidence,
  executions,
  replayId,
}) {
  return {
    producerReceipt: createHostHandoffReceipt({
      adapterId: trust.adapterId,
      keyId: trust.keyId,
      packet,
      roleReturn,
      repositoryEvidence,
      observedProducerRole: 'engineer',
    }, trust.privateKey),
    executionReceipt: createHostExecutionReceipt({
      adapterId: trust.adapterId,
      keyId: trust.keyId,
      packet,
      roleReturn,
      repositoryEvidence,
      executions,
      replayId,
    }, trust.privateKey),
  };
}
