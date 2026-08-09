/**
 * Operator-pinned host adapter trust.
 *
 * Agentic Loop ships no adapter that can prove a parser-owned activation byte
 * channel: every shipped host substitutes prompt text, which a model can author.
 * Capture capability is therefore not a property the toolkit can grant. It is
 * granted by an operator who registers a host adapter together with the public
 * half of a signing key whose private half lives outside the repository, outside
 * generated artifacts, outside prompts, and outside the environment available to
 * an agent invoking this CLI.
 *
 * Without that registration every real host stays fail-closed.
 */

import { KeyObject, createHash, createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { canonicalJson } from './canonical-json.js';

export const HOST_TRUST_KIND = 'agenticloop.host-trust';
export const HOST_TRUST_SCHEMA_VERSION = 1;
export const HOST_TRUST_AUTHORITY_SCHEMA_VERSION = 2;
// This repository-local manifest is portable data only. It never grants trust.
export const HOST_TRUST_FILE = '.agenticloop/host-trust.json';
export const HOST_SIGNATURE_ALGORITHM = 'ed25519';
export const OPERATOR_TRUST_DIRECTORY = '.agenticloop/host-trust';
export const HOST_TRUST_BOUNDARY_CHALLENGE_KIND = 'agenticloop.protected-host-trust-challenge';
export const HOST_TRUST_BOUNDARY_RESPONSE_KIND = 'agenticloop.protected-host-trust-response';
export const HOST_TRUST_BOUNDARY_SCHEMA_VERSION = 1;
/**
 * Lifetime of one protected loader challenge.
 *
 * This is a liveness bound on an out-of-process round trip: how long the
 * toolkit will wait for a protected host to sign a fresh nonce and still treat
 * the answer as describing the current boundary. It is deliberately a separate
 * policy from `AUDITOR_RECEIPT_FUTURE_SKEW_MS`, which bounds clock disagreement
 * between the signing host and this process. The two concepts are unrelated and
 * must remain independently tunable.
 */
export const HOST_TRUST_CHALLENGE_TTL_MS = 5_000;

/**
 * Exact wire length of a raw Ed25519 signature. The signature text grammar is
 * closed over this length: a decoded value of any other size is not an Ed25519
 * signature, whatever the surrounding text claims.
 */
export const HOST_SIGNATURE_BYTE_LENGTH = 64;

const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CANONICAL_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CAPABILITY_STATES = new Set(['supported', 'unsupported']);
const AUTHORITY_KINDS = new Set(['blocked_result_redelegation', 'human_disposition']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function requireKey(key, type, label) {
  if (!(key instanceof KeyObject) || key.type !== type || key.asymmetricKeyType !== HOST_SIGNATURE_ALGORITHM) {
    throw new TypeError(`${label} must be an ${HOST_SIGNATURE_ALGORITHM} ${type} key`);
  }
  return key;
}

/** Import one pinned Ed25519 verification key, preserving native KeyObjects. */
export function importPublicKey(value) {
  if (value instanceof KeyObject) return requireKey(value, 'public', 'host verification key');
  if ((typeof value !== 'string' && !Buffer.isBuffer(value)) || (typeof value === 'string' && !BASE64_RE.test(value))) {
    throw new TypeError('host verification key must be base64-encoded SPKI DER');
  }
  const encoded = typeof value === 'string' ? Buffer.from(value, 'base64') : value;
  return requireKey(createPublicKey({ key: encoded, format: 'der', type: 'spki' }), 'public', 'host verification key');
}

/** Export an Ed25519 public key in the pinned base64 SPKI DER form. */
export function exportPublicKey(publicKey) {
  return importPublicKey(publicKey).export({ type: 'spki', format: 'der' }).toString('base64');
}

function importPrivateKey(value) {
  if (value instanceof KeyObject) return requireKey(value, 'private', 'host signing key');
  return requireKey(createPrivateKey(value), 'private', 'host signing key');
}

/**
 * Generate an isolated host signing key pair. Test and fixture harnesses use
 * this so no private key is ever checked into the repository or an archive.
 */
export function generateHostSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync(HOST_SIGNATURE_ALGORITHM);
  return { publicKey, privateKey, publicKeyBase64: exportPublicKey(publicKey) };
}

/**
 * Sign one canonical payload with a host-held private key.
 *
 * @param {object} payload  Canonically serialized signature payload.
 * @param {import('node:crypto').KeyObject|string|Buffer} privateKey
 * @returns {string} `ed25519:<base64 signature>`
 */
export function signHostPayload(payload, privateKey) {
  const key = importPrivateKey(privateKey);
  const signature = sign(null, Buffer.from(canonicalJson(payload), 'utf8'), key);
  return `${HOST_SIGNATURE_ALGORITHM}:${signature.toString('base64')}`;
}

/**
 * Decode `ed25519:<canonical-base64-signature>` under an exact grammar.
 *
 * Split-based parsing accepted trailing segments (`ed25519:<sig>:ignored`),
 * short or over-long payloads, and noncanonical Base64 whose discarded trailing
 * bits let several distinct texts decode to one signature. The grammar here is
 * closed: exactly one separator, no suffix, padded canonical Base64, the exact
 * Ed25519 signature length, and a re-encoding that reproduces the supplied text
 * byte for byte. Returns `null` for anything else; it never throws.
 */
function decodeHostSignature(signatureText) {
  if (typeof signatureText !== 'string') return null;
  const separator = signatureText.indexOf(':');
  if (separator === -1) return null;
  // Exactly one separator: a second one means an unparsed, silently ignored segment.
  if (signatureText.indexOf(':', separator + 1) !== -1) return null;
  if (signatureText.slice(0, separator) !== HOST_SIGNATURE_ALGORITHM) return null;
  const encoded = signatureText.slice(separator + 1);
  // Padded Base64 only: an unpadded group would decode while re-encoding differently.
  if (!CANONICAL_BASE64_RE.test(encoded) || encoded.length % 4 !== 0) return null;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== HOST_SIGNATURE_BYTE_LENGTH) return null;
  // Canonical round trip: rejects noncanonical trailing bits Node would discard.
  if (decoded.toString('base64') !== encoded) return null;
  return decoded;
}

/**
 * Verify a host signature against a pinned public key. Returns a boolean and
 * never throws for malformed signature text.
 */
export function verifyHostPayload(payload, signatureText, publicKey) {
  const signature = decodeHostSignature(signatureText);
  if (signature === null) return false;
  let key;
  try {
    key = importPublicKey(publicKey);
  } catch {
    return false;
  }
  let message;
  try {
    message = Buffer.from(canonicalJson(payload), 'utf8');
  } catch {
    return false;
  }
  try {
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/**
 * Canonical payload signed by the protected host for one fresh loader challenge.
 * The callback transports this proof; returning a boolean never grants authority.
 */
export function hostTrustBoundarySignaturePayload(challenge, response) {
  return {
    kind: 'agenticloop.protected-host-trust-authorization',
    schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
    challenge,
    adapterId: response?.adapterId,
    keyId: response?.keyId,
  };
}

function boundaryChallenge(targetRepository, trustStorePath, supportedAdapterIds, now) {
  return Object.freeze({
    kind: HOST_TRUST_BOUNDARY_CHALLENGE_KIND,
    schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
    nonce: randomBytes(32).toString('base64url'),
    targetRepositoryIdentity: targetRepository,
    trustStorePath,
    supportedAdapterIds: Object.freeze([...supportedAdapterIds].sort()),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + HOST_TRUST_CHALLENGE_TTL_MS).toISOString(),
  });
}

/** Resolve independent wall and elapsed clocks for the protected round trip. */
function boundaryClocks(options) {
  return {
    wall: typeof options.clock === 'function'
      ? () => Number(options.clock())
      : () => Date.now(),
    elapsed: typeof options.monotonicClock === 'function'
      ? () => Number(options.monotonicClock())
      : () => performance.now(),
  };
}

function authenticatedBoundaryAdapters(parsed, supported, options, context) {
  if (typeof options.protectedBoundary !== 'function') return null;
  const requested = Array.isArray(options.requiredSupportedAdapterIds)
    ? [...new Set(options.requiredSupportedAdapterIds.map(String))].sort()
    : supported.map(adapter => adapter.adapterId).sort();
  if (requested.length === 0 || requested.some(id => !supported.some(adapter => adapter.adapterId === id))) {
    return null;
  }
  const clocks = boundaryClocks(options);
  let issuedAt;
  let startedAt;
  let challenge;
  try {
    issuedAt = clocks.wall();
    startedAt = clocks.elapsed();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(startedAt)) return null;
    challenge = boundaryChallenge(
      context.targetRepositoryIdentity,
      context.trustStorePath,
      requested,
      issuedAt
    );
  } catch {
    // Finite numbers outside the ECMAScript Date range, or throwing clock
    // providers, are not valid timing evidence.
    return null;
  }
  let returned;
  try {
    returned = options.protectedBoundary(challenge);
  } catch {
    return null;
  }
  // Wall time is carried in the signed challenge for auditability. Elapsed time
  // is measured separately with a monotonic source so an NTP/manual clock
  // rollback cannot extend the authorization window.
  let returnedAt;
  try {
    returnedAt = clocks.elapsed();
  } catch {
    return null;
  }
  if (!Number.isFinite(returnedAt) || returnedAt < startedAt ||
      returnedAt - startedAt >= HOST_TRUST_CHALLENGE_TTL_MS) return null;
  const responses = Array.isArray(returned) ? returned : [returned];
  if (responses.length !== requested.length) return null;
  const authorized = new Set();
  for (const response of responses) {
    if (!exactKeys(response, ['kind', 'schemaVersion', 'adapterId', 'keyId', 'challengeNonce', 'signature']) ||
        response.kind !== HOST_TRUST_BOUNDARY_RESPONSE_KIND ||
        response.schemaVersion !== HOST_TRUST_BOUNDARY_SCHEMA_VERSION ||
        response.challengeNonce !== challenge.nonce ||
        !requested.includes(response.adapterId) || authorized.has(response.adapterId)) {
      return null;
    }
    const adapter = parsed.adapters[response.adapterId];
    if (!adapter || adapter.keyId !== response.keyId ||
        !verifyHostPayload(hostTrustBoundarySignaturePayload(challenge, response), response.signature, adapter.publicKey)) {
      return null;
    }
    authorized.add(response.adapterId);
  }
  return authorized.size === requested.length ? authorized : null;
}

function canonicalPath(path) {
  const resolved = resolve(String(path));
  if (!existsSync(resolved)) return resolved;
  const nativeRealpath = realpathSync.native ?? realpathSync;
  return nativeRealpath(resolved);
}

export function targetRepositoryIdentity(target) {
  return `file:${canonicalPath(String(target ?? '.')).replace(/\\/g, '/')}`;
}

/** Fixed per-user trust root used by the public CLI. */
export function defaultOperatorTrustRoot() {
  return join(homedir(), ...OPERATOR_TRUST_DIRECTORY.split('/'));
}

/**
 * Resolve the only trust-store path permitted for a target. The CLI argument is
 * an assertion of this pre-registered path, never a way to select a new root.
 */
export function operatorTrustStorePath(target, operatorTrustRoot = defaultOperatorTrustRoot()) {
  const identity = targetRepositoryIdentity(target);
  const targetDigest = createHash('sha256').update(identity, 'utf8').digest('hex');
  return join(canonicalPath(operatorTrustRoot), `${targetDigest}.json`);
}

function validateEntry(entry, index, errors, repositoryIdentity) {
  if (!isObject(entry)) {
    errors.push(`host trust adapters[${index}] must be an object`);
    return null;
  }
  const expected = ['adapterId', 'keyId', 'algorithm', 'publicKey', 'capabilities'];
  const unknown = Object.keys(entry).filter(key => !expected.includes(key));
  const missing = expected.filter(key => !Object.hasOwn(entry, key));
  if (missing.length) errors.push(`host trust adapters[${index}] is missing field(s): ${missing.join(', ')}`);
  if (unknown.length) errors.push(`host trust adapters[${index}] contains unknown field(s): ${unknown.join(', ')}`);
  if (typeof entry.adapterId !== 'string' || !ADAPTER_ID_RE.test(entry.adapterId)) {
    errors.push(`host trust adapters[${index}] adapterId must be a lowercase dotted identifier`);
  }
  if (typeof entry.keyId !== 'string' || !KEY_ID_RE.test(entry.keyId)) {
    errors.push(`host trust adapters[${index}] keyId is required`);
  }
  if (entry.algorithm !== HOST_SIGNATURE_ALGORITHM) {
    errors.push(`host trust adapters[${index}] algorithm must be '${HOST_SIGNATURE_ALGORITHM}'`);
  }
  try {
    importPublicKey(entry.publicKey);
  } catch (error) {
    errors.push(`host trust adapters[${index}] publicKey is invalid: ${error.message}`);
  }
  if (!isObject(entry.capabilities)) {
    errors.push(`host trust adapters[${index}] capabilities must be an object`);
  } else {
    const capabilityKeys = ['activationCapture', 'returnReceipt'];
    const unknownCapabilities = Object.keys(entry.capabilities).filter(key => !capabilityKeys.includes(key));
    if (unknownCapabilities.length) {
      errors.push(`host trust adapters[${index}] capabilities contains unknown field(s): ${unknownCapabilities.join(', ')}`);
    }
    for (const key of capabilityKeys) {
      if (!CAPABILITY_STATES.has(entry.capabilities[key])) {
        errors.push(`host trust adapters[${index}] capabilities.${key} must be 'supported' or 'unsupported'`);
      }
    }
  }
  if (errors.length) return null;
  return Object.freeze({
    adapterId: entry.adapterId,
    keyId: entry.keyId,
    algorithm: entry.algorithm,
    publicKey: entry.publicKey,
    capabilities: Object.freeze({ ...entry.capabilities }),
    repositoryIdentity,
  });
}

function validateAuthorityEntry(entry, index, errors, repositoryIdentity) {
  const label = `host trust authorities[${index}]`;
  if (!isObject(entry)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const expected = [
    'authorityId', 'authorityKind', 'keyId', 'algorithm', 'publicKey',
    'issuer', 'revokedRecordIds',
  ];
  const unknown = Object.keys(entry).filter(key => !expected.includes(key));
  const missing = expected.filter(key => !Object.hasOwn(entry, key));
  if (missing.length) errors.push(`${label} is missing field(s): ${missing.join(', ')}`);
  if (unknown.length) errors.push(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  if (typeof entry.authorityId !== 'string' || !KEY_ID_RE.test(entry.authorityId)) {
    errors.push(`${label} authorityId is required`);
  }
  if (!AUTHORITY_KINDS.has(entry.authorityKind)) {
    errors.push(`${label} authorityKind is invalid`);
  }
  if (typeof entry.keyId !== 'string' || !KEY_ID_RE.test(entry.keyId)) {
    errors.push(`${label} keyId is required`);
  }
  if (entry.algorithm !== HOST_SIGNATURE_ALGORITHM) {
    errors.push(`${label} algorithm must be '${HOST_SIGNATURE_ALGORITHM}'`);
  }
  try {
    importPublicKey(entry.publicKey);
  } catch (error) {
    errors.push(`${label} publicKey is invalid: ${error.message}`);
  }
  if (!isObject(entry.issuer) ||
      Object.keys(entry.issuer).sort().join(',') !== 'ownerId,ownerKind' ||
      !['workflow_role', 'human_authority'].includes(entry.issuer?.ownerKind) ||
      typeof entry.issuer?.ownerId !== 'string' ||
      !entry.issuer.ownerId.trim()) {
    errors.push(`${label} issuer must contain exactly ownerKind and ownerId`);
  }
  if (!Array.isArray(entry.revokedRecordIds) ||
      entry.revokedRecordIds.some(value => typeof value !== 'string' || !value.trim()) ||
      new Set(entry.revokedRecordIds).size !== entry.revokedRecordIds.length) {
    errors.push(`${label} revokedRecordIds must be a unique array of non-empty strings`);
  }
  if (errors.length) return null;
  return Object.freeze({
    authorityId: entry.authorityId,
    authorityKind: entry.authorityKind,
    keyId: entry.keyId,
    algorithm: entry.algorithm,
    publicKey: entry.publicKey,
    issuer: Object.freeze({ ...entry.issuer }),
    revokedRecordIds: Object.freeze([...entry.revokedRecordIds]),
    repositoryIdentity,
  });
}

/**
 * Parse an externally held operator trust document. Its target identity makes a
 * copied store unusable for another checkout; repository-local manifests are
 * intentionally never consulted by this API.
 *
 * @param {string|null} text
 * @param {{ target?: string }} [options]
 * @returns {{ ok: boolean, adapters: Record<string, object>, errors: string[] }}
 */
export function parseHostTrustStore(text, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const emptyAuthorities = Object.freeze({});
  if (text === null || text === undefined) {
    return { ok: true, adapters: Object.freeze({}), authorities: emptyAuthorities, errors };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, adapters: Object.freeze({}), authorities: emptyAuthorities, errors: [`host trust store is not valid JSON: ${error.message}`] };
  }
  if (!isObject(parsed)) return { ok: false, adapters: Object.freeze({}), authorities: emptyAuthorities, errors: ['host trust store must be a JSON object'] };
  if (parsed.kind !== HOST_TRUST_KIND) errors.push(`host trust store kind must be '${HOST_TRUST_KIND}'`);
  const authoritySchema = parsed.schemaVersion === HOST_TRUST_AUTHORITY_SCHEMA_VERSION;
  if (parsed.schemaVersion !== HOST_TRUST_SCHEMA_VERSION && !authoritySchema) {
    errors.push(`host trust store schemaVersion must be ${HOST_TRUST_SCHEMA_VERSION} or ${HOST_TRUST_AUTHORITY_SCHEMA_VERSION}`);
  }
  const topLevelFields = authoritySchema
    ? ['kind', 'schemaVersion', 'target', 'adapters', 'authorities']
    : ['kind', 'schemaVersion', 'target', 'adapters'];
  const unknown = Object.keys(parsed).filter(key => !topLevelFields.includes(key));
  if (unknown.length) errors.push(`host trust store contains unknown field(s): ${unknown.join(', ')}`);
  if (!isObject(parsed.target) || Object.keys(parsed.target).length !== 1 || typeof parsed.target.repositoryIdentity !== 'string') {
    errors.push('host trust store target must contain exactly repositoryIdentity');
  }
  const expectedRepositoryIdentity = options.target === undefined ? null : targetRepositoryIdentity(options.target);
  if (expectedRepositoryIdentity !== null && parsed.target?.repositoryIdentity !== expectedRepositoryIdentity) {
    errors.push('host trust store target does not match this repository');
  }
  if (!Array.isArray(parsed.adapters)) {
    errors.push('host trust store adapters must be an array');
    return { ok: false, adapters: Object.freeze({}), authorities: emptyAuthorities, errors };
  }
  /** @type {Record<string, object>} */
  const adapters = {};
  const adapterKeyIds = new Map();
  parsed.adapters.forEach((entry, index) => {
    const entryErrors = [];
    const validated = validateEntry(entry, index, entryErrors, parsed.target?.repositoryIdentity ?? null);
    errors.push(...entryErrors);
    if (!validated) return;
    if (adapters[validated.adapterId]) {
      errors.push(`host trust store registers adapter '${validated.adapterId}' more than once`);
      return;
    }
    if (adapterKeyIds.has(validated.keyId)) {
      errors.push(`host trust store keyId '${validated.keyId}' is ambiguously assigned to adapters '${adapterKeyIds.get(validated.keyId)}' and '${validated.adapterId}'`);
      return;
    }
    adapterKeyIds.set(validated.keyId, validated.adapterId);
    adapters[validated.adapterId] = validated;
  });
  /** @type {Record<string, object>} */
  const authorities = {};
  if (authoritySchema && !Array.isArray(parsed.authorities)) {
    errors.push('host trust store authorities must be an array in schemaVersion 2');
  } else if (authoritySchema) {
    parsed.authorities.forEach((entry, index) => {
      const entryErrors = [];
      const validated = validateAuthorityEntry(entry, index, entryErrors, parsed.target?.repositoryIdentity ?? null);
      errors.push(...entryErrors);
      if (!validated) return;
      if (authorities[validated.authorityId]) {
        errors.push(`host trust store registers authority '${validated.authorityId}' more than once`);
        return;
      }
      authorities[validated.authorityId] = validated;
    });
  }
  return {
    ok: errors.length === 0,
    adapters: Object.freeze(adapters),
    authorities: Object.freeze(authorities),
    errors,
  };
}

/**
 * Read the target's pre-registered store from the fixed operator trust root.
 *
 * `assertedPath` may be supplied by the CLI for explicitness, but it must equal
 * the path derived from the host-owned root and canonical target identity. It
 * cannot select an arbitrary external file. Dynamic supported adapters remain
 * unavailable until an authenticated out-of-process host boundary exists.
 */
export function loadHostTrustStore(target, options = {}) {
  if (!isObject(options)) {
    return {
      ok: false,
      adapters: Object.freeze({}),
      authorities: Object.freeze({}),
      errors: ['host trust loading requires a structured host authority context'],
      path: null,
    };
  }
  const root = canonicalPath(String(target ?? '.'));
  const configuredRoot = options.operatorTrustRoot ?? defaultOperatorTrustRoot();
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim() || !isAbsolute(configuredRoot)) {
    return { ok: false, adapters: Object.freeze({}), authorities: Object.freeze({}), errors: ['operator host trust root must be an absolute path'], path: null };
  }
  const operatorRoot = canonicalPath(configuredRoot);
  const rootFromTarget = relative(root, operatorRoot);
  if (!rootFromTarget || (!rootFromTarget.startsWith('..') && !isAbsolute(rootFromTarget))) {
    return { ok: false, adapters: Object.freeze({}), authorities: Object.freeze({}), errors: ['operator host trust root must be outside the target repository'], path: null };
  }
  const path = operatorTrustStorePath(root, operatorRoot);
  if (options.assertedPath !== undefined) {
    if (typeof options.assertedPath !== 'string' || !isAbsolute(options.assertedPath) ||
        canonicalPath(options.assertedPath) !== canonicalPath(path)) {
      return {
        ok: false,
        adapters: Object.freeze({}),
        authorities: Object.freeze({}),
        errors: ['--host-trust-store does not match the pre-registered operator trust path for this target'],
        path,
      };
    }
  }
  if (!existsSync(path)) {
    return {
      ok: true,
      adapters: Object.freeze({}),
      authorities: Object.freeze({}),
      errors: [],
      path,
      state: 'missing',
    };
  }
  if (lstatSync(path).isSymbolicLink()) {
    return { ok: false, adapters: Object.freeze({}), authorities: Object.freeze({}), errors: ['host trust store must not be a symbolic link'], path };
  }
  const realPath = canonicalPath(path);
  const realPathFromTarget = relative(root, realPath);
  if (!realPathFromTarget || (!realPathFromTarget.startsWith('..') && !isAbsolute(realPathFromTarget))) {
    return { ok: false, adapters: Object.freeze({}), authorities: Object.freeze({}), errors: ['host trust store resolves inside the target repository'], path: realPath };
  }
  let text;
  try {
    text = readFileSync(realPath, 'utf8');
  } catch (error) {
    return { ok: false, adapters: Object.freeze({}), authorities: Object.freeze({}), errors: [`host trust store is unreadable: ${error.message}`], path: realPath };
  }
  const parsed = parseHostTrustStore(text, { target: root });
  if (!parsed.ok) return { ...parsed, path: realPath, state: 'malformed' };
  const supported = Object.values(parsed.adapters).filter(adapter =>
    adapter.capabilities.activationCapture === 'supported' ||
    adapter.capabilities.returnReceipt === 'supported'
  );
  if (supported.length > 0) {
    const authorized = authenticatedBoundaryAdapters(parsed, supported, options, {
      targetRepositoryIdentity: targetRepositoryIdentity(root),
      trustStorePath: realPath,
    });
    if (authorized) {
      const adapters = Object.freeze(Object.fromEntries(
        Object.entries(parsed.adapters).filter(([, adapter]) =>
          (adapter.capabilities.activationCapture !== 'supported' && adapter.capabilities.returnReceipt !== 'supported') ||
          authorized.has(adapter.adapterId)
        )
      ));
      return { ...parsed, adapters, path: realPath, state: 'protected_boundary' };
    }
    return {
      ok: false,
      adapters: Object.freeze({}),
      authorities: Object.freeze({}),
      errors: ['dynamic supported host adapters are unavailable through public or delegated in-process APIs; support requires a fresh Ed25519-signed loader challenge carried over authenticated host-controlled IPC, OS isolation, or an equivalent protected boundary'],
      path: realPath,
      state: 'unsupported_boundary',
    };
  }
  return { ...parsed, path: realPath, state: 'empty_or_unsupported' };
}
