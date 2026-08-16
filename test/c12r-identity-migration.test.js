/**
 * P35-C12R.0/.1 characterization: operator activation material must survive a
 * repository-identity version change.
 *
 * C12-F7 recorded that Windows authority-path case folding relocated the digest
 * that addresses operator keys and external revocation tombstones. Existing
 * keys became unreachable, existing deny tombstones stopped being consulted,
 * and the next activation silently provisioned a brand new identity - which is
 * the worst possible failure mode for a revocation store.
 *
 * The legacy identity list is derived from the host, so these cases inject an
 * explicit `legacyIdentities` set. That keeps the migration state machine under
 * test on every platform while `derives superseded Windows spellings` covers
 * the real Windows derivation itself.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  inspectOperatorActivationIdentity,
  migrateOperatorActivationIdentity,
  operatorActivationMigrationReceiptPath,
} from '../src/activation-identity-migration.js';
import {
  discoverLegacyOperatorActivationKeys,
  externalRevocationDirectoryForIdentity,
  loadOperatorActivationKey,
  operatorActivationKeyPathForIdentity,
  provisionOperatorActivationKey,
  readExternalActivationRevocations,
  renderOperatorActivationKeyDocument,
} from '../src/activation-trust.js';
import { HOST_SIGNATURE_ALGORITHM, exportPublicKey, targetRepositoryIdentity } from '../src/host-trust.js';
import {
  legacyRepositoryAuthorityIdentities,
  repositoryAuthorityDigest,
  repositoryAuthorityIdentity,
} from '../src/repository-identity.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-c12r-identity-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/** Real signing material, so a migrated key must load through the real loader. */
function keyMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync(HOST_SIGNATURE_ALGORITHM);
  const publicKeyBase64 = exportPublicKey(publicKey);
  return {
    keyId: `operator-${createHash('sha256').update(publicKeyBase64, 'utf8').digest('hex').slice(0, 16)}`,
    algorithm: HOST_SIGNATURE_ALGORITHM,
    publicKey: publicKeyBase64,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function fixture(name, { legacyCount = 1 } = {}) {
  const root = mkdtempSync(join(temp, `${name}-`));
  const target = join(root, 'target');
  const operatorActivationRoot = join(root, 'operator');
  mkdirSync(target, { recursive: true });
  mkdirSync(operatorActivationRoot, { recursive: true });
  const current = targetRepositoryIdentity(target);
  // Synthetic superseded spellings of this exact checkout. On Windows the real
  // derivation supplies these; injecting them keeps the state machine covered
  // everywhere without pretending POSIX has a case-folding problem.
  const legacyIdentities = Array.from({ length: legacyCount }, (_, index) => `${current}-v1-spelling-${index}`);
  return {
    root,
    target,
    operatorActivationRoot,
    legacyIdentities,
    currentIdentity: current,
    options: { operatorActivationRoot, legacyIdentities },
  };
}

function writeKeyUnder(fx, identity, material = keyMaterial()) {
  const path = operatorActivationKeyPathForIdentity(identity, fx.operatorActivationRoot);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, renderOperatorActivationKeyDocument({
    repositoryIdentity: identity,
    ...material,
  }), 'utf8');
  return { path, material };
}

function writeRevocationUnder(fx, identity, { grantId = `grant:${randomUUID()}` } = {}) {
  const directory = externalRevocationDirectoryForIdentity(identity, fx.operatorActivationRoot);
  mkdirSync(directory, { recursive: true });
  const revocationId = `revocation:${randomUUID()}`;
  const record = {
    kind: 'agenticloop.activation-revocation',
    schemaVersion: 1,
    revocationId,
    grantId,
    grantDigest: `sha256:agenticloop.activation-grant.v1:${'b'.repeat(64)}`,
    repositoryIdentity: identity,
    revokedAt: '2026-01-02T00:00:00.000Z',
    reason: 'operator revocation',
  };
  const path = join(directory, `${revocationId.replace(/^revocation:/, '')}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { path, record };
}

describe('P35-C12R repository-identity derivation is versioned', () => {
  it('derives superseded Windows spellings and none on POSIX', () => {
    const options = { platform: 'win32', exists: () => false };
    const current = repositoryAuthorityIdentity('C:\\Apps\\Repo', options);
    assert.equal(current, 'file:c:/apps/repo');

    const legacy = legacyRepositoryAuthorityIdentities('C:\\Apps\\Repo', options);
    assert.ok(legacy.includes('file:C:/Apps/Repo'), `expected the case-preserving v1 spelling: ${legacy.join(', ')}`);
    assert.ok(legacy.includes('file:c:/Apps/Repo'), `expected the lowercase-drive v1 spelling: ${legacy.join(', ')}`);
    assert.ok(!legacy.includes(current), 'the current identity is never reported as legacy');

    assert.deepEqual(
      legacyRepositoryAuthorityIdentities('/srv/repo', { platform: 'linux', exists: () => false }),
      [],
      'POSIX v1 and v2 agree, so there is nothing to migrate'
    );
  });

  it('keeps distinct identity spellings on distinct storage digests', () => {
    assert.match(repositoryAuthorityDigest('file:c:/apps/repo'), /^[a-f0-9]{64}$/);
    assert.notEqual(
      repositoryAuthorityDigest('file:c:/apps/repo'),
      repositoryAuthorityDigest('file:C:/Apps/Repo')
    );
  });
});

describe('P35-C12R legacy operator keys are never silently replaced', () => {
  it('refuses to provision a fresh identity while superseded key material exists', () => {
    const fx = fixture('no-silent-reprovision');
    const legacy = writeKeyUnder(fx, fx.legacyIdentities[0]);

    const provisioned = provisionOperatorActivationKey(fx.target, fx.options);
    assert.equal(provisioned.ok, false, 'a superseded key must block silent reprovisioning');
    assert.equal(provisioned.created, false);
    assert.equal(provisioned.diagnostic.code, 'activation.identity.migration_required');
    assert.equal(provisioned.diagnostic.category, 'activation');
    assert.match(provisioned.errors.join(' '), /superseded repository/);
    assert.equal(existsSync(legacy.path), true, 'the superseded key is left untouched');
    assert.equal(
      loadOperatorActivationKey(fx.target, fx.options).state,
      'missing',
      'no replacement identity was minted'
    );
  });

  it('provisions normally when nothing legacy exists', () => {
    const fx = fixture('clean-provision');
    const provisioned = provisionOperatorActivationKey(fx.target, fx.options);
    assert.equal(provisioned.ok, true, provisioned.errors.join('; '));
    assert.equal(provisioned.created, true);
    assert.equal(loadOperatorActivationKey(fx.target, fx.options).state, 'present');
  });

  it('discovers superseded key material and reports unreadable documents', () => {
    const fx = fixture('discovery', { legacyCount: 2 });
    writeKeyUnder(fx, fx.legacyIdentities[0]);
    const brokenPath = operatorActivationKeyPathForIdentity(fx.legacyIdentities[1], fx.operatorActivationRoot);
    writeFileSync(brokenPath, 'not json at all\n', 'utf8');

    const found = discoverLegacyOperatorActivationKeys(fx.target, fx.options);
    assert.equal(found.length, 2);
    assert.deepEqual(found.map(item => item.state).sort(), ['malformed', 'present']);
  });
});

describe('P35-C12R identity migration is explicit, verified, and idempotent', () => {
  it('migrates one superseded key forward and preserves the legacy state', () => {
    const fx = fixture('migrate');
    const legacy = writeKeyUnder(fx, fx.legacyIdentities[0]);

    const before = inspectOperatorActivationIdentity(fx.target, fx.options);
    assert.equal(before.disposition, 'migration_available');
    assert.equal(before.currentKeyState, 'missing');
    assert.equal(before.legacy[0].keyState, 'present');

    const migrated = migrateOperatorActivationIdentity(fx.target, { ...fx.options, now: Date.parse('2026-02-01T00:00:00Z') });
    assert.equal(migrated.ok, true, migrated.errors.join('; '));
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.disposition, 'migrated');

    // The migrated key is the operator's own key, not a new identity.
    const loaded = loadOperatorActivationKey(fx.target, fx.options);
    assert.equal(loaded.state, 'present');
    assert.equal(loaded.key.keyId, legacy.material.keyId);
    assert.equal(loaded.key.repositoryIdentity, fx.currentIdentity);

    // Legacy state is preserved, never consumed.
    assert.equal(existsSync(legacy.path), true);
    assert.equal(JSON.parse(readFileSync(legacy.path, 'utf8')).target.repositoryIdentity, fx.legacyIdentities[0]);

    // The receipt lives outside the target repository.
    const receiptPath = operatorActivationMigrationReceiptPath(fx.target, fx.operatorActivationRoot);
    assert.equal(migrated.receiptPath, receiptPath);
    assert.equal(existsSync(receiptPath), true);
    assert.equal(receiptPath.startsWith(fx.operatorActivationRoot), true);
    assert.equal(receiptPath.startsWith(fx.target), false);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.kind, 'agenticloop.operator-activation-identity-migration');
    assert.equal(receipt.identityVersion, 2);
    assert.equal(receipt.fromIdentityVersion, 1);
    assert.equal(receipt.keyId, legacy.material.keyId);
    assert.equal(receipt.migratedFrom.identity, fx.legacyIdentities[0]);
    assert.equal(receipt.preservedLegacyPaths[0].keyPath, legacy.path);
  });

  it('is idempotent on rerun and stops blocking activation afterwards', () => {
    const fx = fixture('idempotent');
    writeKeyUnder(fx, fx.legacyIdentities[0]);
    const first = migrateOperatorActivationIdentity(fx.target, fx.options);
    assert.equal(first.migrated, true);

    const second = migrateOperatorActivationIdentity(fx.target, fx.options);
    assert.equal(second.ok, true, second.errors.join('; '));
    assert.equal(second.migrated, false);
    assert.equal(second.disposition, 'already_migrated');
    assert.equal(second.receipt.keyId, first.receipt.keyId);

    // Once migrated, ordinary provisioning is a no-op that returns the same key.
    const provisioned = provisionOperatorActivationKey(fx.target, fx.options);
    assert.equal(provisioned.ok, true, provisioned.errors.join('; '));
    assert.equal(provisioned.created, false);
    assert.equal(provisioned.key.keyId, first.receipt.keyId);
  });

  it('refuses to choose between conflicting superseded keys', () => {
    const fx = fixture('conflict', { legacyCount: 2 });
    writeKeyUnder(fx, fx.legacyIdentities[0]);
    writeKeyUnder(fx, fx.legacyIdentities[1]);

    const inspected = inspectOperatorActivationIdentity(fx.target, fx.options);
    assert.equal(inspected.disposition, 'conflict');
    assert.equal(inspected.ok, false);

    const migrated = migrateOperatorActivationIdentity(fx.target, fx.options);
    assert.equal(migrated.ok, false);
    assert.equal(migrated.disposition, 'conflict');
    assert.equal(migrated.diagnostic.code, 'activation.identity.conflict');
    assert.equal(loadOperatorActivationKey(fx.target, fx.options).state, 'missing', 'a conflict mutates nothing');
    assert.equal(existsSync(operatorActivationMigrationReceiptPath(fx.target, fx.operatorActivationRoot)), false);
  });

  it('treats unreadable superseded key material as a conflict, not as absence', () => {
    const fx = fixture('malformed-legacy');
    const path = operatorActivationKeyPathForIdentity(fx.legacyIdentities[0], fx.operatorActivationRoot);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ "kind": "agenticloop.operator-activation-key" }\n', 'utf8');

    const migrated = migrateOperatorActivationIdentity(fx.target, fx.options);
    assert.equal(migrated.ok, false);
    assert.equal(migrated.disposition, 'conflict');
    assert.equal(loadOperatorActivationKey(fx.target, fx.options).state, 'missing');
  });

  it('reports not_applicable where the identity derivation never changed', () => {
    const fx = fixture('posix-shape');
    const inspected = inspectOperatorActivationIdentity(fx.target, {
      operatorActivationRoot: fx.operatorActivationRoot,
      legacyIdentities: [],
    });
    assert.equal(inspected.disposition, 'not_applicable');
    const migrated = migrateOperatorActivationIdentity(fx.target, {
      operatorActivationRoot: fx.operatorActivationRoot,
      legacyIdentities: [],
    });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.migrated, false);
    assert.equal(migrated.disposition, 'not_applicable');
  });
});

describe('P35-C12R deny evidence unions superseded registries fail-closed', () => {
  it('still denies a grant whose tombstone lives under a superseded identity', () => {
    const fx = fixture('legacy-tombstone');
    const legacy = writeRevocationUnder(fx, fx.legacyIdentities[0]);

    const read = readExternalActivationRevocations(fx.target, fx.options);
    assert.equal(read.ok, true, read.errors.join('; '));
    assert.equal(read.revocations.length, 1, 'the superseded tombstone must still be deny evidence');
    assert.equal(read.revocations[0].revocationId, legacy.record.revocationId);
    assert.equal(read.legacyPaths.length, 1);
  });

  it('unions current and superseded tombstones', () => {
    const fx = fixture('union');
    writeRevocationUnder(fx, fx.currentIdentity);
    writeRevocationUnder(fx, fx.legacyIdentities[0]);

    const read = readExternalActivationRevocations(fx.target, fx.options);
    assert.equal(read.ok, true, read.errors.join('; '));
    assert.equal(read.revocations.length, 2);
  });

  it('fails closed on an unreadable superseded tombstone', () => {
    const fx = fixture('legacy-corrupt');
    const directory = externalRevocationDirectoryForIdentity(fx.legacyIdentities[0], fx.operatorActivationRoot);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'broken.json'), 'not json\n', 'utf8');

    const read = readExternalActivationRevocations(fx.target, fx.options);
    assert.equal(read.ok, false, 'an unreadable deny record must not be skipped');
    assert.match(read.errors.join(' '), /unreadable|invalid JSON/);
  });

  it('rejects a tombstone bound to an unrelated repository', () => {
    const fx = fixture('foreign-tombstone');
    const directory = externalRevocationDirectoryForIdentity(fx.legacyIdentities[0], fx.operatorActivationRoot);
    mkdirSync(directory, { recursive: true });
    const revocationId = randomUUID();
    writeFileSync(join(directory, `${revocationId}.json`), `${JSON.stringify({
      kind: 'agenticloop.activation-revocation',
      schemaVersion: 1,
      revocationId: `revocation:${revocationId}`,
      grantId: `grant:${randomUUID()}`,
      grantDigest: `sha256:agenticloop.activation-grant.v1:${'c'.repeat(64)}`,
      repositoryIdentity: 'file:/somewhere/else',
      revokedAt: '2026-01-02T00:00:00.000Z',
      reason: 'operator revocation',
    }, null, 2)}\n`, 'utf8');

    const read = readExternalActivationRevocations(fx.target, fx.options);
    assert.equal(read.ok, false);
    assert.match(read.errors.join(' '), /not a valid revocation for this repository/);
  });

  it('keeps repositories isolated from each other', () => {
    const fx = fixture('isolation');
    const other = fixture('isolation-other');
    // Both checkouts share one operator root, as they would on one machine.
    other.operatorActivationRoot = fx.operatorActivationRoot;
    other.options = { operatorActivationRoot: fx.operatorActivationRoot, legacyIdentities: other.legacyIdentities };
    writeRevocationUnder(other, other.currentIdentity);

    const read = readExternalActivationRevocations(fx.target, fx.options);
    assert.equal(read.ok, true, read.errors.join('; '));
    assert.equal(read.revocations.length, 0, "another checkout's deny state is not this checkout's");
  });
});
