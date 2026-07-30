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

import { KeyObject, createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalJson } from './canonical-json.js';

export const HOST_TRUST_KIND = 'agenticloop.host-trust';
export const HOST_TRUST_SCHEMA_VERSION = 1;
// This repository-local manifest is portable data only. It never grants trust.
export const HOST_TRUST_FILE = '.agenticloop/host-trust.json';
export const HOST_SIGNATURE_ALGORITHM = 'ed25519';
export const OPERATOR_TRUST_DIRECTORY = '.agenticloop/host-trust';

const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CAPABILITY_STATES = new Set(['supported', 'unsupported']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
 * Verify a host signature against a pinned public key. Returns a boolean and
 * never throws for malformed signature text.
 */
export function verifyHostPayload(payload, signatureText, publicKey) {
  if (typeof signatureText !== 'string') return false;
  const [algorithm, encoded] = signatureText.split(':');
  if (algorithm !== HOST_SIGNATURE_ALGORITHM || !encoded || !BASE64_RE.test(encoded)) return false;
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
    return verify(null, message, key, Buffer.from(encoded, 'base64'));
  } catch {
    return false;
  }
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
  if (text === null || text === undefined) return { ok: true, adapters: Object.freeze({}), errors };
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, adapters: Object.freeze({}), errors: [`host trust store is not valid JSON: ${error.message}`] };
  }
  if (!isObject(parsed)) return { ok: false, adapters: Object.freeze({}), errors: ['host trust store must be a JSON object'] };
  if (parsed.kind !== HOST_TRUST_KIND) errors.push(`host trust store kind must be '${HOST_TRUST_KIND}'`);
  if (parsed.schemaVersion !== HOST_TRUST_SCHEMA_VERSION) errors.push(`host trust store schemaVersion must be ${HOST_TRUST_SCHEMA_VERSION}`);
  const unknown = Object.keys(parsed).filter(key => !['kind', 'schemaVersion', 'target', 'adapters'].includes(key));
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
    return { ok: false, adapters: Object.freeze({}), errors };
  }
  /** @type {Record<string, object>} */
  const adapters = {};
  parsed.adapters.forEach((entry, index) => {
    const entryErrors = [];
    const validated = validateEntry(entry, index, entryErrors, parsed.target?.repositoryIdentity ?? null);
    errors.push(...entryErrors);
    if (!validated) return;
    if (adapters[validated.adapterId]) {
      errors.push(`host trust store registers adapter '${validated.adapterId}' more than once`);
      return;
    }
    adapters[validated.adapterId] = validated;
  });
  return { ok: errors.length === 0, adapters: Object.freeze(adapters), errors };
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
      errors: ['host trust loading requires a structured host authority context'],
      path: null,
    };
  }
  const root = canonicalPath(String(target ?? '.'));
  const configuredRoot = options.operatorTrustRoot ?? defaultOperatorTrustRoot();
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim() || !isAbsolute(configuredRoot)) {
    return { ok: false, adapters: Object.freeze({}), errors: ['operator host trust root must be an absolute path'], path: null };
  }
  const operatorRoot = canonicalPath(configuredRoot);
  const rootFromTarget = relative(root, operatorRoot);
  if (!rootFromTarget || (!rootFromTarget.startsWith('..') && !isAbsolute(rootFromTarget))) {
    return { ok: false, adapters: Object.freeze({}), errors: ['operator host trust root must be outside the target repository'], path: null };
  }
  const path = operatorTrustStorePath(root, operatorRoot);
  if (options.assertedPath !== undefined) {
    if (typeof options.assertedPath !== 'string' || !isAbsolute(options.assertedPath) ||
        canonicalPath(options.assertedPath) !== canonicalPath(path)) {
      return {
        ok: false,
        adapters: Object.freeze({}),
        errors: ['--host-trust-store does not match the pre-registered operator trust path for this target'],
        path,
      };
    }
  }
  if (!existsSync(path)) {
    return {
      ok: true,
      adapters: Object.freeze({}),
      errors: [],
      path,
      state: 'missing',
    };
  }
  if (lstatSync(path).isSymbolicLink()) {
    return { ok: false, adapters: Object.freeze({}), errors: ['host trust store must not be a symbolic link'], path };
  }
  const realPath = canonicalPath(path);
  const realPathFromTarget = relative(root, realPath);
  if (!realPathFromTarget || (!realPathFromTarget.startsWith('..') && !isAbsolute(realPathFromTarget))) {
    return { ok: false, adapters: Object.freeze({}), errors: ['host trust store resolves inside the target repository'], path: realPath };
  }
  let text;
  try {
    text = readFileSync(realPath, 'utf8');
  } catch (error) {
    return { ok: false, adapters: Object.freeze({}), errors: [`host trust store is unreadable: ${error.message}`], path: realPath };
  }
  const parsed = parseHostTrustStore(text, { target: root });
  if (!parsed.ok) return { ...parsed, path: realPath, state: 'malformed' };
  const supported = Object.values(parsed.adapters).filter(adapter =>
    adapter.capabilities.activationCapture === 'supported' ||
    adapter.capabilities.returnReceipt === 'supported'
  );
  if (supported.length > 0) {
    return {
      ok: false,
      adapters: Object.freeze({}),
      errors: ['dynamic supported host adapters are unavailable through public or delegated in-process APIs; a future integration requires authenticated host-controlled IPC, OS isolation, or an equivalent protected boundary'],
      path: realPath,
      state: 'unsupported_boundary',
    };
  }
  return { ...parsed, path: realPath, state: 'empty_or_unsupported' };
}
