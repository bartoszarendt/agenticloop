/**
 * Migrate operator activation material across repository-identity versions.
 *
 * Operator confirmation keys and external revocation tombstones are addressed
 * by a digest of the target's canonical repository identity, so versioning that
 * identity forward relocates every existing record. On Windows the v1 to v2
 * change (case folding) did exactly that: real operator keys and real deny
 * tombstones became unreachable, and the next activation looked like a
 * first-time setup instead of a lost identity.
 *
 * The rules this module enforces:
 *
 * - Legacy state is discovered, never assumed absent.
 * - Deny evidence is unioned fail-closed; that happens in the reader, so it
 *   applies whether or not a migration was ever run.
 * - More than one legacy key claiming the same checkout is a conflict the
 *   operator resolves, not something this code silently picks a winner for.
 * - Legacy files are never deleted or rewritten. The migration copies forward
 *   and verifies the copy before reporting success.
 * - The receipt lives beside the operator's own state, outside every target
 *   repository, and rerunning the migration is a no-op.
 *
 * On POSIX v1 and v2 agree, so every entry point here reports
 * `not_applicable` without touching the filesystem.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { atomicWriteFile } from './fs-mutation-kernel.js';
import { createDiagnostic } from './repair-policy.js';
import { displayPath } from './path-identity.js';
import { targetRepositoryIdentity } from './host-trust.js';
import {
  REPOSITORY_AUTHORITY_IDENTITY_VERSION,
  LEGACY_REPOSITORY_AUTHORITY_IDENTITY_VERSION,
  legacyRepositoryAuthorityIdentities,
  repositoryAuthorityDigest,
} from './repository-identity.js';
import {
  assertSafeOperatorActivationKeyWritePath,
  defaultOperatorActivationRoot,
  discoverLegacyOperatorActivationKeys,
  externalRevocationDirectoryForIdentity,
  loadOperatorActivationKey,
  operatorActivationKeyPath,
  renderOperatorActivationKeyDocument,
} from './activation-trust.js';

export const OPERATOR_ACTIVATION_IDENTITY_MIGRATION_KIND = 'agenticloop.operator-activation-identity-migration';
export const OPERATOR_ACTIVATION_IDENTITY_MIGRATION_SCHEMA_VERSION = 1;

/** The receipt path for one target, outside every target repository. */
export function operatorActivationMigrationReceiptPath(target, root = defaultOperatorActivationRoot()) {
  const digest = repositoryAuthorityDigest(targetRepositoryIdentity(target));
  return join(displayPath(root), 'migrations', `${digest}.json`);
}

function countRevocations(directory) {
  if (!existsSync(directory)) return 0;
  try {
    // Only the presence and count matter here; the fail-closed content read is
    // the reader's job, and duplicating it would give a second answer.
    return readdirSync(directory).filter(name => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/**
 * Report the current and superseded operator-identity state for one target.
 *
 * Read-only. `disposition` is the whole verdict:
 *
 * - `not_applicable` - this host has no superseded spellings at all.
 * - `current_only`   - nothing legacy exists; ordinary provisioning applies.
 * - `migration_available` - exactly one usable legacy key and no current key.
 * - `already_migrated`    - a current key exists alongside legacy state.
 * - `conflict`            - several legacy keys, or unreadable legacy state.
 */
export function inspectOperatorActivationIdentity(target, options = {}) {
  const root = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  const currentIdentity = targetRepositoryIdentity(target);
  const legacyIdentities = options.legacyIdentities ?? legacyRepositoryAuthorityIdentities(target);
  const current = loadOperatorActivationKey(target, { operatorActivationRoot: root });
  const legacyKeys = discoverLegacyOperatorActivationKeys(target, {
    operatorActivationRoot: root,
    legacyIdentities,
  });
  const legacy = legacyIdentities.map(identity => {
    const key = legacyKeys.find(item => item.identity === identity) ?? null;
    const revocationDirectory = externalRevocationDirectoryForIdentity(identity, root);
    return {
      identity,
      digest: repositoryAuthorityDigest(identity),
      keyPath: key?.path ?? null,
      keyState: key?.state ?? 'missing',
      keyId: key?.key?.keyId ?? null,
      errors: key?.errors ?? [],
      revocationDirectory,
      revocationCount: countRevocations(revocationDirectory),
    };
  });

  const usable = legacy.filter(item => item.keyState === 'present');
  const unreadable = legacy.filter(item => item.keyState === 'malformed');
  const distinctKeyIds = new Set(usable.map(item => item.keyId));

  let disposition;
  if (legacyIdentities.length === 0) disposition = 'not_applicable';
  else if (unreadable.length > 0 || distinctKeyIds.size > 1) disposition = 'conflict';
  else if (usable.length === 0) disposition = 'current_only';
  else if (current.state === 'present') disposition = 'already_migrated';
  else if (!current.ok) disposition = 'conflict';
  else disposition = 'migration_available';

  return Object.freeze({
    ok: disposition !== 'conflict',
    disposition,
    identityVersion: REPOSITORY_AUTHORITY_IDENTITY_VERSION,
    legacyIdentityVersion: LEGACY_REPOSITORY_AUTHORITY_IDENTITY_VERSION,
    currentIdentity,
    currentDigest: repositoryAuthorityDigest(currentIdentity),
    currentKeyPath: current.path,
    currentKeyState: current.state,
    currentKeyId: current.key?.keyId ?? null,
    currentRevocationDirectory: externalRevocationDirectoryForIdentity(currentIdentity, root),
    legacy: Object.freeze(legacy.map(item => Object.freeze(item))),
    receiptPath: operatorActivationMigrationReceiptPath(target, root),
    errors: Object.freeze([...unreadable.flatMap(item => item.errors)]),
  });
}

function conflictDiagnostic(inspection) {
  return createDiagnostic({
    code: 'activation.identity.conflict',
    evidence: {
      state: 'malformed',
      supplied: true,
      rollbackAuthorized: false,
      identities: inspection.legacy
        .filter(item => item.keyState !== 'missing')
        .map(item => item.identity),
    },
  });
}

function buildReceipt(inspection, { migratedFrom, keyId, migratedAt }) {
  return {
    kind: OPERATOR_ACTIVATION_IDENTITY_MIGRATION_KIND,
    schemaVersion: OPERATOR_ACTIVATION_IDENTITY_MIGRATION_SCHEMA_VERSION,
    identityVersion: inspection.identityVersion,
    fromIdentityVersion: inspection.legacyIdentityVersion,
    currentIdentity: inspection.currentIdentity,
    currentDigest: inspection.currentDigest,
    migratedFrom,
    keyId,
    // Legacy state is preserved, so the receipt records where it still lives
    // rather than claiming it was consumed.
    preservedLegacyPaths: inspection.legacy
      .filter(item => item.keyState !== 'missing' || item.revocationCount > 0)
      .map(item => ({
        identity: item.identity,
        keyPath: item.keyPath,
        revocationDirectory: item.revocationDirectory,
        revocationCount: item.revocationCount,
      })),
    migratedAt,
  };
}

/**
 * Copy one legacy operator activation key forward to the current identity.
 *
 * Mutating at most one file outside the target repository, plus one receipt.
 * Never deletes legacy state, never chooses between competing keys, and
 * verifies the migrated key reloads as this target's key before reporting
 * success.
 *
 * @param {string} target
 * @param {{ operatorActivationRoot?: string, legacyIdentities?: string[], now?: number }} [options]
 */
export function migrateOperatorActivationIdentity(target, options = {}) {
  const root = options.operatorActivationRoot ?? defaultOperatorActivationRoot();
  const inspection = inspectOperatorActivationIdentity(target, { ...options, operatorActivationRoot: root });
  const migratedAt = new Date(options.now ?? Date.now()).toISOString();

  if (inspection.disposition === 'conflict') {
    return {
      ok: false,
      migrated: false,
      disposition: 'conflict',
      inspection,
      diagnostic: conflictDiagnostic(inspection),
      errors: inspection.errors.length
        ? [...inspection.errors]
        : ['several operator activation keys claim this repository under superseded identity spellings'],
      receiptPath: inspection.receiptPath,
      receipt: null,
    };
  }
  if (inspection.disposition !== 'migration_available') {
    // `not_applicable`, `current_only`, and `already_migrated` are all terminal
    // successes with nothing to write.
    return {
      ok: true,
      migrated: false,
      disposition: inspection.disposition,
      inspection,
      diagnostic: null,
      errors: [],
      receiptPath: inspection.receiptPath,
      receipt: readReceipt(inspection.receiptPath),
    };
  }

  const source = inspection.legacy.find(item => item.keyState === 'present');
  let legacyDocument;
  try {
    legacyDocument = JSON.parse(readFileSync(source.keyPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      migrated: false,
      disposition: 'conflict',
      inspection,
      diagnostic: conflictDiagnostic(inspection),
      errors: [`superseded operator activation key is unreadable: ${error.message}`],
      receiptPath: inspection.receiptPath,
      receipt: null,
    };
  }

  const destination = operatorActivationKeyPath(target, root);
  try {
    assertSafeOperatorActivationKeyWritePath(target, root, destination);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    assertSafeOperatorActivationKeyWritePath(target, root, destination);
    atomicWriteFile(destination, renderOperatorActivationKeyDocument({
      repositoryIdentity: inspection.currentIdentity,
      keyId: legacyDocument.keyId,
      algorithm: legacyDocument.algorithm,
      publicKey: legacyDocument.publicKey,
      privateKey: legacyDocument.privateKey,
      createdAt: legacyDocument.createdAt,
    }));
  } catch (error) {
    return {
      ok: false,
      migrated: false,
      disposition: 'blocked',
      inspection,
      diagnostic: null,
      errors: [`migrated operator activation key could not be written: ${error.message}`],
      receiptPath: inspection.receiptPath,
      receipt: null,
    };
  }

  // Prove the copy before claiming it: the migrated key must load as this
  // target's key through the ordinary loader, with the same key identity.
  const reloaded = loadOperatorActivationKey(target, { operatorActivationRoot: root });
  if (!reloaded.ok || reloaded.state !== 'present' || reloaded.key.keyId !== legacyDocument.keyId) {
    return {
      ok: false,
      migrated: false,
      disposition: 'blocked',
      inspection,
      diagnostic: null,
      errors: reloaded.errors.length
        ? [...reloaded.errors]
        : ['the migrated operator activation key did not reload as this repository key'],
      receiptPath: inspection.receiptPath,
      receipt: null,
    };
  }

  const receipt = buildReceipt(inspection, {
    migratedFrom: { identity: source.identity, digest: source.digest, keyPath: source.keyPath },
    keyId: reloaded.key.keyId,
    migratedAt,
  });
  try {
    mkdirSync(resolve(inspection.receiptPath, '..'), { recursive: true });
    atomicWriteFile(inspection.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      migrated: true,
      disposition: 'unresolved',
      inspection,
      diagnostic: null,
      errors: [`the operator activation key was migrated but the receipt could not be written: ${error.message}`],
      receiptPath: inspection.receiptPath,
      receipt: null,
    };
  }
  return {
    ok: true,
    migrated: true,
    disposition: 'migrated',
    inspection,
    diagnostic: null,
    errors: [],
    receiptPath: inspection.receiptPath,
    receipt: Object.freeze(receipt),
  };
}

/** Read a previously written migration receipt, or null when there is none. */
export function readReceipt(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.kind === OPERATOR_ACTIVATION_IDENTITY_MIGRATION_KIND ? Object.freeze(parsed) : null;
  } catch {
    return null;
  }
}
