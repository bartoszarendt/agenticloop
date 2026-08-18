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

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

import { atomicCreateFile, atomicWriteFile } from './fs-mutation-kernel.js';
import { validateActivationRevocation } from './activation-grant.js';
import { createDiagnostic } from './repair-policy.js';
import {
  HOST_SIGNATURE_ALGORITHM,
  exportPublicKey,
  importPublicKey,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from './host-trust.js';
import { displayPath, isPathOutside, isPathWithin, pathIdentity } from './path-identity.js';
import { legacyRepositoryAuthorityIdentities, repositoryAuthorityDigest } from './repository-identity.js';

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
  return operatorActivationKeyPathForIdentity(targetRepositoryIdentity(target), root);
}

/** Address operator key storage by an explicit identity, including a legacy one. */
export function operatorActivationKeyPathForIdentity(identity, root = defaultOperatorActivationRoot()) {
  return join(displayPath(root), `${repositoryAuthorityDigest(identity)}.json`);
}

export function externalActivationRevocationPath(target, revocationId, root = defaultOperatorActivationRoot()) {
  const suffix = String(revocationId ?? '').replace(/^revocation:/, '');
  if (!/^[0-9a-f-]{36}$/.test(suffix)) throw new TypeError('external activation revocation id is invalid');
  return join(externalRevocationDirectoryForIdentity(targetRepositoryIdentity(target), root), `${suffix}.json`);
}

/** Address the external deny registry by an explicit identity, including a legacy one. */
export function externalRevocationDirectoryForIdentity(identity, root = defaultOperatorActivationRoot()) {
  return join(displayPath(root), 'revocations', repositoryAuthorityDigest(identity));
}

function externalRevocationDirectory(target, root) {
  return externalRevocationDirectoryForIdentity(targetRepositoryIdentity(target), root);
}

/** Apply the operator-storage authority boundary to external revocation tombstones. */
export function assertSafeExternalActivationRevocationPath(target, root, path) {
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
    throw new Error('operator activation root must be an absolute path');
  }
  const canonicalTarget = pathIdentity(target).authorityPath;
  const canonicalRoot = pathIdentity(root).authorityPath;
  const canonicalPath = pathIdentity(path).authorityPath;
  const rootToDestination = relative(resolve(root), resolve(path));
  if (!rootToDestination || rootToDestination === '..' ||
      rootToDestination.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rootToDestination)) {
    throw new Error('external activation revocation destination must remain below the operator activation root');
  }
  if (!isPathOutside(canonicalRoot, canonicalTarget) || !isPathOutside(canonicalPath, canonicalTarget)) {
    throw new Error('operator activation root and external activation revocation destination must remain outside the target repository');
  }
  assertNoLinkComponents(root, 'operator activation root');
  assertNoLinkComponents(path, 'external activation revocation destination');
}

/** Create the externally authoritative deny tombstone. Existing tombstones are immutable. */
export function writeExternalActivationRevocation(target, revocation, options = {}) {
  const checked = validateActivationRevocation(revocation);
  if (!checked.ok) return { ok: false, errors: checked.errors.map(item => item.message), path: null, created: false };
  if (revocation.repositoryIdentity !== targetRepositoryIdentity(target)) {
    return { ok: false, errors: ['external activation revocation targets a different repository'], path: null, created: false };
  }
  const root = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  const path = externalActivationRevocationPath(target, revocation.revocationId, root);
  try {
    assertSafeExternalActivationRevocationPath(target, root, path);
  } catch (error) {
    return { ok: false, errors: [error.message], path, created: false };
  }
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
    mkdirSync(resolve(path, '..'), { recursive: true });
    assertSafeExternalActivationRevocationPath(target, root, path);
    atomicCreateFile(path, `${JSON.stringify(revocation, null, 2)}\n`);
    return { ok: true, errors: [], path, created: true };
  } catch (error) {
    return { ok: false, errors: [`external activation revocation could not be created: ${error.message}`], path, created: false };
  }
}

/**
 * Read all external deny tombstones for one target.
 *
 * Deny evidence is read as the union of the current identity's registry and
 * every superseded identity spelling this host could have written under. A
 * revocation that became unreachable because the identity derivation changed
 * would otherwise silently re-enable a grant the operator explicitly killed, so
 * the legacy registries are consulted, their tombstones accepted only when they
 * name one of this target's own identities, and any unreadable entry in any of
 * them still fails the whole read closed.
 */
export function readExternalActivationRevocations(target, options = {}) {
  const root = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  const currentIdentity = targetRepositoryIdentity(target);
  const legacyIdentities = options.legacyIdentities ?? legacyRepositoryAuthorityIdentities(target);
  const accepted = new Set([currentIdentity, ...legacyIdentities]);
  const directory = externalRevocationDirectory(target, root);
  const revocations = [];
  const errors = [];
  const legacyPaths = [];

  for (const identity of [currentIdentity, ...legacyIdentities]) {
    const registry = externalRevocationDirectoryForIdentity(identity, root);
    if (identity !== currentIdentity) legacyPaths.push(registry);
    try {
      assertSafeExternalActivationRevocationPath(target, root, registry);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (!existsSync(registry)) continue;
    if (lstatSync(registry).isSymbolicLink()) {
      errors.push('external activation revocation registry must not be a symbolic link');
      continue;
    }
    try {
      for (const name of readdirSync(registry).sort()) {
        const path = join(registry, name);
        try { assertSafeExternalActivationRevocationPath(target, root, path); } catch (error) {
          errors.push(error.message);
          continue;
        }
        if (!name.endsWith('.json') || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
          errors.push(`external activation revocation registry contains unsupported entry '${name}'`);
          continue;
        }
        try {
          const record = JSON.parse(readFileSync(path, 'utf8'));
          const checked = validateActivationRevocation(record);
          if (!checked.ok || !accepted.has(record.repositoryIdentity)) {
            errors.push(`${name} is not a valid revocation for this repository`);
          } else revocations.push(record);
        } catch (error) {
          errors.push(`${name} is unreadable or invalid JSON: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`external activation revocation registry is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, revocations, errors, path: directory, legacyPaths };
}

/**
 * Apply the strongest owner-only protection this platform offers.
 *
 * POSIX gets real 0o700/0o600 modes. Windows `chmod` only toggles the read-only
 * attribute and does not restrict other users, so the state is reported rather
 * than claimed: callers surface `ownerProtection` truthfully instead of
 * promising an ACL the toolkit did not set.
 */
export function applyOwnerProtection(path, mode) {
  if (process.platform === 'win32') return 'platform_default_acl';
  try {
    chmodSync(path, mode);
    return 'posix_owner_only';
  } catch {
    return 'unenforced';
  }
}

function rootOutsideTarget(target, root) {
  return isPathOutside(root, target);
}

function assertNoLinkComponents(path, label) {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  for (const segment of relative(parsed.root, absolute).split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) break;
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not contain a symbolic link or junction component`);
    }
  }
}

/** Revalidate external private-key authority after root materialization and before writing. */
export function assertSafeOperatorActivationKeyWritePath(target, root, path) {
  const canonicalTarget = pathIdentity(target).authorityPath;
  const canonicalRoot = pathIdentity(root).authorityPath;
  const canonicalPath = pathIdentity(path).authorityPath;
  const rootToDestination = relative(resolve(root), resolve(path));
  if (!rootToDestination || rootToDestination === '..' ||
      rootToDestination.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rootToDestination)) {
    throw new Error('operator activation key destination must remain below the operator activation root');
  }
  if (!isPathOutside(canonicalRoot, canonicalTarget) || !isPathOutside(canonicalPath, canonicalTarget)) {
    throw new Error('operator activation key root and destination must remain outside the target repository');
  }
  assertNoLinkComponents(root, 'operator activation root');
  assertNoLinkComponents(path, 'operator activation key destination');
}

function parseKeyDocument(text, { expectedIdentity, path }) {
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
  const realPath = displayPath(path);
  if (!rootOutsideTarget(target, realPath)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key resolves inside the target repository'], path: realPath };
  }
  // The same membership assertion the explicit-path reader applies. This path is
  // derived rather than supplied, so it is a redundancy on purpose: both readers
  // state the whole boundary, and neither depends on the other's derivation.
  if (!isPathWithin(realPath, configuredRoot)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key resolves outside the operator activation root'], path: realPath };
  }
  let text;
  try {
    text = readFileSync(realPath, 'utf8');
  } catch (error) {
    return { ok: false, state: 'malformed', key: null, errors: [`operator activation key is unreadable: ${error.message}`], path: realPath };
  }
  const parsed = parseKeyDocument(text, { expectedIdentity: targetRepositoryIdentity(target), path: realPath });
  if (!parsed.ok) return { ok: false, state: 'malformed', key: null, errors: parsed.errors, path: realPath };
  return { ok: true, state: 'present', key: parsed.key, errors: [], path: realPath };
}

/**
 * Read one operator activation key document from an exact path, checked against
 * an explicitly supplied repository identity.
 *
 * Identity migration needs this: a key provisioned under a superseded identity
 * spelling is a valid document that simply names an older identity, and calling
 * it malformed would hide exactly the state the migration must find.
 *
 * It applies the same confinement `loadOperatorActivationKey` applies, because
 * relaxing only the identity check must not also relax the trust boundary. A
 * document reachable from inside the target repository is never operator
 * material, and treating one as such would let repository content decide
 * whether operator authority may be provisioned.
 *
 * @param {string} path
 * @param {string} expectedIdentity
 * @param {{ target: string, root: string }} confinement
 */
export function readOperatorActivationKeyDocument(path, expectedIdentity, { target, root } = {}) {
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation root must be an absolute path'], path };
  }
  if (!rootOutsideTarget(target, root)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation root must be outside the target repository'], path };
  }
  // "Outside the target" and "inside the operator root" are two different
  // claims, and only the first was proven. Any path anywhere else
  // on the host satisfied the old check, so a future caller supplying an
  // arbitrary path could have had its content accepted as operator material.
  // Membership is asserted here lexically first, then again on the realpath, so
  // neither a traversal argument nor a link that leaves the root can pass.
  if (!isPathWithin(path, root)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key must remain below the operator activation root'], path };
  }
  if (!existsSync(path)) return { ok: true, state: 'missing', key: null, errors: [], path };
  if (lstatSync(path).isSymbolicLink()) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key must not be a symbolic link'], path };
  }
  const realPath = displayPath(path);
  if (!rootOutsideTarget(target, realPath)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key resolves inside the target repository'], path: realPath };
  }
  if (!isPathWithin(realPath, root)) {
    return { ok: false, state: 'malformed', key: null, errors: ['operator activation key resolves outside the operator activation root'], path: realPath };
  }
  let text;
  try {
    text = readFileSync(realPath, 'utf8');
  } catch (error) {
    return { ok: false, state: 'malformed', key: null, errors: [`operator activation key is unreadable: ${error.message}`], path: realPath };
  }
  const parsed = parseKeyDocument(text, { expectedIdentity, path: realPath });
  if (!parsed.ok) return { ok: false, state: 'malformed', key: null, errors: parsed.errors, path };
  return { ok: true, state: 'present', key: parsed.key, errors: [], path };
}

/** Build the exact key document bytes for one identity and key material. */
export function renderOperatorActivationKeyDocument({ repositoryIdentity, keyId, algorithm, publicKey, privateKey, createdAt }) {
  return `${JSON.stringify({
    kind: OPERATOR_ACTIVATION_KEY_KIND,
    schemaVersion: OPERATOR_ACTIVATION_KEY_SCHEMA_VERSION,
    target: { repositoryIdentity },
    keyId,
    algorithm,
    publicKey,
    privateKey,
    createdAt,
  }, null, 2)}\n`;
}

/**
 * Discover operator activation keys stored under superseded identity spellings.
 *
 * Only keys that actually exist are returned. A document that is present but
 * unreadable is reported as `malformed` rather than skipped, because "there is
 * something here I cannot read" must never be treated as "there is nothing
 * here" by a caller that is about to mint replacement authority.
 */
export function discoverLegacyOperatorActivationKeys(target, options = {}) {
  const root = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  const legacyIdentities = options.legacyIdentities ?? legacyRepositoryAuthorityIdentities(target);
  const found = [];
  for (const identity of legacyIdentities) {
    let path;
    try {
      path = operatorActivationKeyPathForIdentity(identity, root);
    } catch (error) {
      found.push({ identity, path: null, state: 'malformed', key: null, errors: [error.message] });
      continue;
    }
    const read = readOperatorActivationKeyDocument(path, identity, { target, root });
    if (read.state === 'missing') continue;
    found.push({ identity, path, state: read.state, key: read.key, errors: read.errors });
  }
  return found;
}

/**
 * Provision the operator activation key for one target if it does not exist.
 *
 * This is the single setup operation. It is idempotent, never overwrites an
 * existing valid key, and never writes anything into the target repository.
 *
 * It also refuses to mint a fresh identity while operator material for this
 * same checkout still exists under a superseded identity spelling. Quietly
 * provisioning there would look like a successful first-time setup while
 * orphaning the operator's real key and every deny tombstone bound to it.
 *
 * @param {string} target
 * @param {{ operatorActivationRoot?: string|null, now?: number, legacyIdentities?: string[] }} [options]
 */
export function provisionOperatorActivationKey(target, options = {}) {
  const existing = loadOperatorActivationKey(target, options);
  if (existing.state === 'present') {
    return { ok: true, created: false, key: existing.key, path: existing.path, errors: [], ownerProtection: describeProtection() };
  }
  if (!existing.ok) return { ok: false, created: false, key: null, path: existing.path, errors: existing.errors, ownerProtection: null };
  const legacyKeys = discoverLegacyOperatorActivationKeys(target, options);
  if (legacyKeys.length > 0) {
    return {
      ok: false,
      created: false,
      key: null,
      path: existing.path,
      errors: [
        `operator activation material already exists under ${legacyKeys.length} superseded repository ` +
        `identity spelling(s): ${legacyKeys.map(item => item.identity).join(', ')}`,
      ],
      diagnostic: createDiagnostic({
        code: 'activation.identity.migration_required',
        evidence: {
          state: 'stale',
          supplied: true,
          rollbackAuthorized: false,
          identities: legacyKeys.map(item => item.identity),
        },
      }),
      legacyKeys,
      ownerProtection: null,
    };
  }
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
  const root = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  const directory = resolve(path, '..');
  // A missing root is only a provisional lexical fact; defend both the
  // preexisting-link case and replacement while the directory is materialized.
  try {
    assertSafeOperatorActivationKeyWritePath(target, root, path);
  } catch (error) {
    return { ok: false, created: false, key: null, path, errors: [error.message], ownerProtection: null };
  }
  mkdirSync(directory, { recursive: true });
  try {
    assertSafeOperatorActivationKeyWritePath(target, root, path);
  } catch (error) {
    return { ok: false, created: false, key: null, path, errors: [error.message], ownerProtection: null };
  }
  const directoryProtection = applyOwnerProtection(directory, 0o700);
  try {
    assertSafeOperatorActivationKeyWritePath(target, root, path);
  } catch (error) {
    return { ok: false, created: false, key: null, path, errors: [error.message], ownerProtection: null };
  }
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

export function describeProtection() {
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
