/**
 * Packaged protected-host integration over one fixed inherited descriptor.
 *
 * Descriptor 3 carries a closed JSON envelope authored by the trusted parent.
 * The envelope owns every security-sensitive input: adapter/key registration,
 * target identity, operator trust-store location, and private key. Callers may
 * supply only the target whose identity must match the protected envelope.
 *
 * This remains a reference integration rather than a generated-host feature.
 * A plain CLI invocation receives no descriptor and therefore fails closed.
 */

import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { loadAuditorReturnReceiptVerifier } from './auditor-return-receipt.js';
import {
  HOST_TRUST_BOUNDARY_CHALLENGE_KIND,
  HOST_TRUST_BOUNDARY_RESPONSE_KIND,
  HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
  HOST_SIGNATURE_ALGORITHM,
  hostTrustBoundarySignaturePayload,
  signHostPayload,
  targetRepositoryIdentity,
} from './host-trust.js';

export const PROTECTED_KEY_DESCRIPTOR = 3;
export const PROTECTED_HOST_CONFIG_KIND = 'agenticloop.protected-host-config';
export const PROTECTED_HOST_CONFIG_SCHEMA_VERSION = 1;

const CONFIG_FIELDS = Object.freeze([
  'kind',
  'schemaVersion',
  'adapterId',
  'keyId',
  'targetRepositoryIdentity',
  'operatorTrustRoot',
  'assertedPath',
  'privateKey',
]);

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return object(value) && Object.keys(value).length === expected.length &&
    Object.keys(value).every(key => expected.includes(key));
}

function unsupported(error) {
  return {
    ok: false,
    adapters: Object.freeze({}),
    authorities: Object.freeze({}),
    errors: [error instanceof Error ? error.message : String(error)],
    path: null,
    state: 'unsupported_boundary',
    verifier: null,
  };
}

/** Read and validate the host-owned configuration from fixed descriptor 3. */
function readProtectedHostConfig(target) {
  let text;
  try {
    text = readFileSync(PROTECTED_KEY_DESCRIPTOR, 'utf8');
  } catch (error) {
    throw new Error(
      `protected host boundary is unavailable: no readable configuration on file descriptor ${PROTECTED_KEY_DESCRIPTOR} (${error.code ?? error.message})`
    );
  }
  if (!text) {
    throw new Error(`protected host boundary is unavailable: file descriptor ${PROTECTED_KEY_DESCRIPTOR} carried no configuration`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('protected host boundary configuration is not valid JSON');
  }
  if (!exactKeys(config, CONFIG_FIELDS) ||
      config.kind !== PROTECTED_HOST_CONFIG_KIND ||
      config.schemaVersion !== PROTECTED_HOST_CONFIG_SCHEMA_VERSION) {
    throw new Error('protected host boundary configuration fields do not match the closed schema');
  }
  if (typeof config.adapterId !== 'string' || !config.adapterId.trim() ||
      typeof config.keyId !== 'string' || !config.keyId.trim()) {
    throw new Error('protected host boundary configuration requires adapterId and keyId');
  }
  const expectedTarget = targetRepositoryIdentity(target);
  if (config.targetRepositoryIdentity !== expectedTarget) {
    throw new Error('protected host boundary configuration does not match the target repository');
  }
  if (typeof config.operatorTrustRoot !== 'string' || !isAbsolute(config.operatorTrustRoot)) {
    throw new Error('protected host boundary configuration requires an absolute operatorTrustRoot');
  }
  if (config.assertedPath !== null &&
      (typeof config.assertedPath !== 'string' || !isAbsolute(config.assertedPath))) {
    throw new Error('protected host boundary assertedPath must be null or absolute');
  }
  if (typeof config.privateKey !== 'string' || !config.privateKey.startsWith('-----BEGIN')) {
    throw new Error('protected host boundary configuration requires one PEM private key');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: config.privateKey, format: 'pem' });
  } catch {
    throw new Error('protected host boundary private key is malformed');
  }
  if (privateKey.asymmetricKeyType !== HOST_SIGNATURE_ALGORITHM) {
    throw new Error(`protected host boundary key must be an ${HOST_SIGNATURE_ALGORITHM} private key`);
  }
  return Object.freeze({
    adapterId: config.adapterId,
    keyId: config.keyId,
    operatorTrustRoot: config.operatorTrustRoot,
    assertedPath: config.assertedPath,
    privateKey,
  });
}

function createProtectedHostBoundary({ adapterId, keyId, privateKey }) {
  return challenge => {
    if (!challenge || typeof challenge !== 'object' ||
        challenge.kind !== HOST_TRUST_BOUNDARY_CHALLENGE_KIND ||
        challenge.schemaVersion !== HOST_TRUST_BOUNDARY_SCHEMA_VERSION ||
        typeof challenge.nonce !== 'string' || !challenge.nonce ||
        !Array.isArray(challenge.supportedAdapterIds) ||
        !challenge.supportedAdapterIds.includes(adapterId)) {
      throw new Error('protected host boundary refused an unrecognized loader challenge');
    }
    const response = {
      kind: HOST_TRUST_BOUNDARY_RESPONSE_KIND,
      schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
      adapterId,
      keyId,
      challengeNonce: challenge.nonce,
      signature: null,
    };
    response.signature = signHostPayload(
      hostTrustBoundarySignaturePayload(challenge, response),
      privateKey
    );
    return response;
  };
}

/**
 * Load the production Auditor receipt verifier from protected descriptor 3.
 *
 * `target` is the sole caller input and is checked against the protected
 * envelope. Test clocks, alternate descriptors/readers, trust roots, asserted
 * paths, adapter identities, and key identities are intentionally unavailable.
 *
 * @param {{ target?: string }} options
 */
export function loadProtectedAuditorReturnVerifier(options = {}) {
  if (!exactKeys(options, ['target']) && !exactKeys(options, [])) {
    return unsupported(new Error('protected host boundary accepts only the target option'));
  }
  let config;
  try {
    config = readProtectedHostConfig(options.target);
  } catch (error) {
    return unsupported(error);
  }
  return loadAuditorReturnReceiptVerifier({
    target: options.target,
    operatorTrustRoot: config.operatorTrustRoot,
    assertedPath: config.assertedPath ?? undefined,
    adapterId: config.adapterId,
    protectedBoundary: createProtectedHostBoundary(config),
  });
}
