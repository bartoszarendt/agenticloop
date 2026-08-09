/**
 * Operator-local activation confirmation material.
 *
 * `operator_confirmed` activation needs one property a target-local JSON file
 * can never have on its own: it must be impossible to forge by writing a file
 * into the repository. The confirmation key that signs grants and bindings is
 * therefore held **outside** the target, under a per-user root derived from the
 * canonical target repository identity, exactly like the host trust store.
 *
 * What this buys, honestly:
 *
 * - A model, a generated artifact, a prompt, or any process that can only write
 *   inside the repository cannot mint an activation grant. Its hand-authored
 *   record fails signature verification even when every field and digest is
 *   internally self-consistent.
 * - Copying `.agenticloop/activations/` into another checkout does not carry
 *   authority: the grant binds one canonical repository identity.
 *
 * What this does NOT buy:
 *
 * - Resistance to arbitrary hostile code executing as the same OS user. That
 *   code can read the key file. `operator_confirmed` is procedural, local-user
 *   assurance and is graded accordingly; it is never promoted to `host_signed`.
 *
 * This module deliberately exposes no general-purpose signing entry point. The
 * signer accepts only the two canonical activation payload kinds.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { atomicCreateFile, atomicWriteFile } from './fs-mutation-kernel.js';
import { validateActivationRevocation } from './activation-grant.js';
import {
  HOST_SIGNATURE_ALGORITHM,
  exportPublicKey,
  importPublicKey,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from './host-trust.js';

export const OPERATOR_ACTIVATION_KEY_KIND = 'agenticloop.operator-activation-key';
export const OPERATOR_ACTIVATION_KEY_SCHEMA_VERSION = 1;
/** Per-user root for operator activation confirmation material. */
export const OPERATOR_ACTIVATION_DIRECTORY = '.agenticloop/operator-activation';

/** The only payload kinds the operator confirmation key may ever sign. */
const SIGNABLE_PAYLOAD_KINDS = Object.freeze(new Set([
  'agenticloop.activation-grant-signature',
  'agenticloop.task-activation-binding-signature',
  'agenticloop.legacy-unactivated-waiver-signature',
]));

const KEY_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'target', 'keyId', 'algorithm', 'publicKey', 'privateKey', 'createdAt',
]);
const KEY_ID_RE = /^operator-[a-f0-9]{16}$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalPath(path) {
  const resolved = resolve(String(path));
  if (!existsSync(resolved)) return resolved;
  const nativeRealpath = realpathSync.native ?? realpathSync;
  return nativeRealpath(resolved);
}

/** Fixed per-user operator activation root used by the public CLI. */
export function defaultOperatorActivationRoot() {
  return join(homedir(), ...OPERATOR_ACTIVATION_DIRECTORY.split('/'));
}

/**
 * Resolve the only operator activation key path permitted for a target. The
 * path is derived from the canonical repository identity, so one machine can
 * hold independent confirmation material for many checkouts and none of them
 * can be reused for another.
 */
export function operatorActivationKeyPath(target, root = defaultOperatorActivationRoot()) {
  const identity = targetRepositoryIdentity(target);
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex');
  return join(canonicalPath(root), `${digest}.json`);
}

function repositoryActivationDigest(target) {
  return createHash('sha256').update(targetRepositoryIdentity(target), 'utf8').digest('hex');
}

export function externalActivationRevocationPath(target, revocationId, root = defaultOperatorActivationRoot()) {
  const suffix = String(revocationId ?? '').replace(/^revocation:/, '');
  if (!/^[0-9a-f-]{36}$/.test(suffix)) throw new TypeError('external activation revocation id is invalid');
  return join(canonicalPath(root), 'revocations', repositoryActivationDigest(target), `${suffix}.json`);
}

/** Create the externally authoritative deny tombstone. Existing tombstones are immutable. */
export function writeExternalActivationRevocation(target, revocation, options = {}) {
  const checked = validateActivationRevocation(revocation);
  if (!checked.ok) return { ok: false, errors: checked.errors.map(item => item.message), path: null, created: false };
  if (revocation.repositoryIdentity !== targetRepositoryIdentity(target)) {
    return { ok: false, errors: ['external activation revocation targets a different repository'], path: null, created: false };
  }
  const path = externalActivationRevocationPath(target, revocation.revocationId, options.operatorActivationRoot);
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      const valid = validateActivationRevocation(existing);
      if (!valid.ok || JSON.stringify(existing) !== JSON.stringify(revocation)) {
        return { ok: false, errors: ['external activation revocation tombstone already exists with malformed or different content'], path, created: false };
      }
      return { ok: true, errors: [], path, created: false };
    } catch (error) {
      return { ok: false, errors: [`external activation revocation tombstone is unreadable: ${error.message}`], path, created: false };
    }
  }
  try {
    atomicCreateFile(path, `${JSON.stringify(revocation, null, 2)}\n`);
    return { ok: true, errors: [], path, created: true };
  } catch (error) {
    return { ok: false, errors: [`external activation revocation could not be created: ${error.message}`], path, created: false };
  }
}

/** Read all external deny tombstones. A present malformed registry fails closed. */
export function readExternalActivationRevocations(target, options = {}) {
  const directory = join(canonicalPath(options.operatorActivationRoot ?? defaultOperatorActivationRoot()), 'revocations', repositoryActivationDigest(target));
  if (!existsSync(directory)) return { ok: true, revocations: [], errors: [], path: directory };
  if (lstatSync(directory).isSymbolicLink()) return { ok: false, revocations: [], errors: ['external activation revocation registry must not be a symbolic link'], path: directory };
  const revocations = [];
  const errors = [];
  try {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (!name.endsWith('.json') || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        errors.push(`external activation revocation registry contains unsupported entry '${name}'`);
        continue;
      }
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        const checked = validateActivationRevocation(record);
        if (!checked.ok || record.repositoryIdentity !== targetRepositoryIdentity(target)) {
          errors.push(`${name} is not a valid revocation for this repository`);
        } else revocations.push(record);
      } catch (error) {
        errors.push(`${name} is unreadable or invalid JSON: ${error.message}`);
      }
    }
  } catch (error) {
    errors.push(`external activation revocation registry is unreadable: ${error.message}`);
  }
  return { ok: errors.length === 0, revocations, errors, path: directory };
}

/**
 * Apply the strongest owner-only protection this platform offers.
 *
 * POSIX gets real 0o700/0o600 modes. Windows `chmod` only toggles the read-only
 * attribute and does not restrict other users, so the state is reported rather
 * than claimed: callers surface `ownerProtection` truthfully instead of
 * promising an ACL the toolkit did not set.
 */
function applyOwnerProtection(path, mode) {
  if (process.platform === 'win32') return 'platform_default_acl';
  try {
    chmodSync(path, mode);
    return 'posix_owner_only';
  } catch {
    return 'unenforced';
  }
}

function rootOutsideTarget(target, root) {
  const targetRoot = canonicalPath(target);
  const operatorRoot = canonicalPath(root);
  const fromTarget = relative(targetRoot, operatorRoot);
  return Boolean(fromTarget) && (fromTarget.startsWith('..') || isAbsolute(fromTarget));
}

function parseKeyDocument(text, { target, path }) {
  /** @type {string[]} */
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, key: null, errors: [`operator activation key is not valid JSON: ${error.message}`] };
  }
  if (!isObject(parsed)) return { ok: false, key: null, errors: ['operator activation key must be a JSON object'] };
  const missing = KEY_FIELDS.filter(field => !Object.hasOwn(parsed, field));
  const unknown = Object.keys(parsed).filter(field => !KEY_FIELDS.includes(field));
  if (missing.length) errors.push(`operator activation key is missing field(s): ${missing.join(', ')}`);
  if (unknown.length) errors.push(`operator activation key contains unknown field(s): ${unknown.join(', ')}`);
  if (parsed.kind !== OPERATOR_ACTIVATION_KEY_KIND) errors.push(`operator activation key kind must be '${OPERATOR_ACTIVATION_KEY_KIND}'`);
  if (parsed.schemaVersion !== OPERATOR_ACTIVATION_KEY_SCHEMA_VERSION) {
    errors.push(`operator activation key schemaVersion must be ${OPERATOR_ACTIVATION_KEY_SCHEMA_VERSION}`);
  }
  const expectedIdentity = targetRepositoryIdentity(target);
  if (!isObject(parsed.target) || Object.keys(parsed.target).length !== 1 ||
      typeof parsed.target.repositoryIdentity !== 'string') {
    errors.push('operator activation key target must contain exactly repositoryIdentity');
  } else if (parsed.target.repositoryIdentity !== expectedIdentity) {
    errors.push('operator activation key target does not match this repository');
  }
  if (typeof parsed.keyId !== 'string' || !KEY_ID_RE.test(parsed.keyId)) {
    errors.push('operator activation key keyId must be operator-<16 lowercase hex>');
  }
  if (parsed.algorithm !== HOST_SIGNATURE_ALGORITHM) {
    errors.push(`operator activation key algorithm must be '${HOST_SIGNATURE_ALGORITHM}'`);
  }
  try {
    importPublicKey(parsed.publicKey);
  } catch (error) {
    errors.push(`operator activation key publicKey is invalid: ${error.message}`);
  }
  if (typeof parsed.privateKey !== 'string' || !parsed.privateKey.trim()) {
    errors.push('operator activation key privateKey is required');
  }
  if (errors.length) return { ok: false, key: null, errors };
  return {
    ok: true,
    errors: [],
    key: Object.freeze({
      keyId: parsed.keyId,
      algorithm: parsed.algorithm,
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
      createdAt: parsed.createdAt,
      repositoryIdentity: parsed.target.repositoryIdentity,
      path,
    }),
  };
}

/**
 * Load the operator activation key for one target.
 *
 * Fails closed when the root is not outside the target, the file is a symbolic
 * link, its real path resolves inside the target, or the document is malformed
 * or bound to another repository.
 *
 * @param {string} target
 * @param {{ operatorActivationRoot?: string|null }} [options]
 * @returns {{ ok: boolean, state: string, key: object|null, errors: string[], path: string|null }}
 */
export function loadOperatorActivationKey(target, options = {}) {
  const configuredRoot = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim() || !isAbsolute(configuredRoot)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation root must be an absolute path'], path: null };
  }
  if (!rootOutsideTarget(target, configuredRoot)) {
    return {
      ok: false,
      state: 'malformed',
      key: null,
      errors: ['operator activation root must be outside the target repository'],
      path: null,
    };
  }
  const path = operatorActivationKeyPath(target, configuredRoot);
  if (!existsSync(path)) {
    return { ok: true, state: 'missing', key: null, errors: [], path };
  }
  if (lstatSync(path).isSymbolicLink()) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key must not be a symbolic link'], path };
  }
  const realPath = canonicalPath(path);
  if (!rootOutsideTarget(target, realPath)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key resolves inside the target repository'], path: realPath };
  }
  let text;
  try {
    text = readFileSync(realPath, 'utf8');
  } catch (error) {
    return { ok: false, state: 'malformed', key: null, errors: [`operator activation key is unreadable: ${error.message}`], path: realPath };
  }
  const parsed = parseKeyDocument(text, { target, path: realPath });
  if (!parsed.ok) return { ok: false, state: 'malformed', key: null, errors: parsed.errors, path: realPath };
  return { ok: true, state: 'present', key: parsed.key, errors: [], path: realPath };
}

/**
 * Provision the operator activation key for one target if it does not exist.
 *
 * This is the single setup operation. It is idempotent, never overwrites an
 * existing valid key, and never writes anything into the target repository.
 *
 * @param {string} target
 * @param {{ operatorActivationRoot?: string|null, now?: number }} [options]
 */
export function provisionOperatorActivationKey(target, options = {}) {
  const existing = loadOperatorActivationKey(target, options);
  if (existing.state === 'present') {
    return { ok: true, created: false, key: existing.key, path: existing.path, errors: [], ownerProtection: describeProtection() };
  }
  if (!existing.ok) return { ok: false, created: false, key: null, path: existing.path, errors: existing.errors, ownerProtection: null };
  const { publicKey, privateKey } = generateKeyPairSync(HOST_SIGNATURE_ALGORITHM);
  const publicKeyBase64 = exportPublicKey(publicKey);
  const keyId = `operator-${createHash('sha256').update(publicKeyBase64, 'utf8').digest('hex').slice(0, 16)}`;
  const document = {
    kind: OPERATOR_ACTIVATION_KEY_KIND,
    schemaVersion: OPERATOR_ACTIVATION_KEY_SCHEMA_VERSION,
    target: { repositoryIdentity: targetRepositoryIdentity(target) },
    keyId,
    algorithm: HOST_SIGNATURE_ALGORITHM,
    publicKey: publicKeyBase64,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  const path = existing.path;
  const directory = resolve(path, '..');
  mkdirSync(directory, { recursive: true });
  const directoryProtection = applyOwnerProtection(directory, 0o700);
  atomicWriteFile(path, `${JSON.stringify(document, null, 2)}\n`);
  const fileProtection = applyOwnerProtection(path, 0o600);
  const reloaded = loadOperatorActivationKey(target, options);
  if (!reloaded.ok || reloaded.state !== 'present') {
    return {
      ok: false,
      created: false,
      key: null,
      path,
      errors: reloaded.errors.length ? reloaded.errors : ['operator activation key did not refetch to a valid document'],
      ownerProtection: null,
    };
  }
  return {
    ok: true,
    created: true,
    key: reloaded.key,
    path: reloaded.path,
    errors: [],
    ownerProtection: { directory: directoryProtection, file: fileProtection, ...describeProtection() },
  };
}

function describeProtection() {
  return process.platform === 'win32'
    ? {
        platform: 'win32',
        limitation:
          'Windows inherits the parent directory ACL; the toolkit sets no explicit ACL. ' +
          'Keep the per-user profile directory restricted to your account.',
      }
    : {
        platform: process.platform,
        limitation: 'POSIX owner-only permissions (0700 directory, 0600 file). Same-user processes can still read the key.',
      };
}

/**
 * Sign one canonical activation payload with the operator confirmation key.
 *
 * Deliberately not a signing oracle: the payload must be one of the two closed
 * activation signature kinds, and it must name this exact target repository.
 *
 * @param {object} payload
 * @param {{ key: object, repositoryIdentity: string }} context
 */
export function signOperatorActivationPayload(payload, { key, repositoryIdentity } = {}) {
  if (!isObject(payload) || !SIGNABLE_PAYLOAD_KINDS.has(payload.kind)) {
    throw new TypeError('the operator activation key signs only canonical activation and compatibility-waiver payloads');
  }
  if (payload.repositoryIdentity !== repositoryIdentity) {
    throw new TypeError('the operator activation key signs only payloads bound to its own target repository');
  }
  if (!isObject(key) || typeof key.privateKey !== 'string' || key.repositoryIdentity !== repositoryIdentity) {
    throw new TypeError('operator activation signing requires the external key provisioned for this target');
  }
  return {
    algorithm: HOST_SIGNATURE_ALGORITHM,
    keyId: key.keyId,
    value: signHostPayload(payload, key.privateKey),
  };
}

/**
 * Build the verifier `resolveTaskActivationBinding` consumes.
 *
 * `operator_confirmed` verifies against the external operator public key.
 * `host_signed` verifies against the operator-pinned adapter key resolved from
 * the host trust store. Neither key is ever read from the target repository.
 *
 * @param {{ operatorKey?: object|null, resolveHostAdapter?: (adapterId: string) => any }} sources
 */
export function createActivationSignatureVerifier({ operatorKey = null, resolveHostAdapter = null } = {}) {
  return (payload, signature, assurance, context = {}) => {
    if (!isObject(signature) || signature.algorithm !== HOST_SIGNATURE_ALGORITHM) return false;
    if (assurance === 'operator_confirmed') {
      if (!operatorKey || operatorKey.keyId !== signature.keyId) return false;
      return verifyHostPayload(payload, signature.value, operatorKey.publicKey);
    }
    if (assurance === 'host_signed') {
      if (typeof resolveHostAdapter !== 'function') return false;
      const adapterId = context?.grant?.evidence?.adapterId;
      let adapter;
      try {
        adapter = resolveHostAdapter(adapterId);
      } catch {
        return false;
      }
      if (!adapter || adapter.adapterId !== adapterId || adapter.keyId !== signature.keyId ||
          adapter.capabilities?.activationCapture !== 'supported') return false;
      return verifyHostPayload(payload, signature.value, adapter.publicKey);
    }
    return false;
  };
}
