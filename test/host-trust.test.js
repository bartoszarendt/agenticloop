import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  exportPublicKey,
  generateHostSigningKey,
  importPublicKey,
  loadHostTrustStore,
  operatorTrustStorePath,
  parseHostTrustStore,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from '../src/host-trust.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';

const temp = mkdtempSync(join(tmpdir(), 'agenticloop-host-trust-'));
after(() => rmSync(temp, { recursive: true, force: true }));

describe('Ed25519 host signing keys', () => {
  it('round-trips generated public KeyObjects and signs with generated private KeyObjects', () => {
    const { publicKey, privateKey } = generateHostSigningKey();
    const encoded = exportPublicKey(publicKey);
    const imported = importPublicKey(encoded);
    const payload = { adapter: 'operator.parser.v1', request: 'exact UTF-8 bytes' };
    const signature = signHostPayload(payload, privateKey);

    assert.equal(imported.type, 'public');
    assert.equal(imported.asymmetricKeyType, 'ed25519');
    assert.equal(verifyHostPayload(payload, signature, imported), true);
  });

  it('rejects wrong key material and key types', () => {
    const { publicKey, privateKey } = generateHostSigningKey();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

    assert.throws(() => exportPublicKey(privateKey), /public key/);
    assert.throws(() => signHostPayload({ probe: true }, publicKey), /private key/);
    assert.throws(() => exportPublicKey(rsa.publicKey), /ed25519 public key/);
    assert.throws(() => signHostPayload({ probe: true }, rsa.privateKey), /ed25519 private key/);
  });

  it('fails closed for malformed signatures and verification keys without throwing', () => {
    const { publicKey, privateKey } = generateHostSigningKey();
    const signature = signHostPayload({ probe: true }, privateKey);
    for (const malformed of [null, '', 'ed25519:', 'ed25519:not base64!', 'rsa:AAAA', 'ed25519:AAAA:extra']) {
      assert.doesNotThrow(() => verifyHostPayload({ probe: true }, malformed, publicKey));
      assert.equal(verifyHostPayload({ probe: true }, malformed, publicKey), false);
    }
    assert.equal(verifyHostPayload({ probe: false }, signature, publicKey), false);
    assert.equal(verifyHostPayload({ probe: true }, signature, 'not-a-key'), false);
  });
});

describe('fixed operator trust registry', () => {
  it('distinguishes missing, malformed, empty, and unsupported-boundary trust stores', () => {
    const target = mkdtempSync(join(temp, 'states-target-'));
    const operatorRoot = mkdtempSync(join(temp, 'states-operator-'));
    const missing = loadHostTrustStore(target, { operatorTrustRoot: operatorRoot });
    assert.equal(missing.ok, true);
    assert.equal(missing.state, 'missing');
    assert.deepEqual(missing.adapters, {});

    const path = operatorTrustStorePath(target, operatorRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{', 'utf8');
    const malformed = loadHostTrustStore(target, { operatorTrustRoot: operatorRoot });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.state, 'malformed');

    writeFileSync(path, JSON.stringify({
      kind: 'agenticloop.host-trust',
      schemaVersion: 1,
      target: { repositoryIdentity: targetRepositoryIdentity(target) },
      adapters: [],
    }), 'utf8');
    const empty = loadHostTrustStore(target, { operatorTrustRoot: operatorRoot });
    assert.equal(empty.ok, true);
    assert.equal(empty.state, 'empty_or_unsupported');

    const trust = createTestHostTrust({ target });
    writeFileSync(path, JSON.stringify(trust.document), 'utf8');
    const unprotected = loadHostTrustStore(target, { operatorTrustRoot: operatorRoot });
    assert.equal(unprotected.ok, false);
    assert.equal(unprotected.state, 'unsupported_boundary');
    const callerPromoted = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      hostAuthority: () => true,
    });
    assert.equal(callerPromoted.ok, false);
    assert.equal(callerPromoted.state, 'unsupported_boundary');
  });

  it('rejects repository-local, wrong-target, and in-process promoted trust documents', () => {
    const target = mkdtempSync(join(temp, 'target-'));
    const otherTarget = mkdtempSync(join(temp, 'other-target-'));
    const operatorRoot = mkdtempSync(join(temp, 'operator-'));
    const trust = createTestHostTrust({ target });
    const storePath = writeHostTrustStore(operatorRoot, trust);
    const localPath = join(target, '.agenticloop', 'host-trust.json');
    mkdirSync(join(target, '.agenticloop'));
    writeFileSync(localPath, `${JSON.stringify(trust.document)}\n`, 'utf8');

    const external = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: storePath,
      hostAuthority: () => true,
    });
    assert.equal(external.ok, false);
    assert.equal(external.state, 'unsupported_boundary');
    assert.deepEqual(external.adapters, {});
    assert.equal(loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: localPath,
    }).ok, false);
    assert.equal(parseHostTrustStore(JSON.stringify(trust.document), { target: otherTarget }).ok, false);
  });

  it('does not let a CLI assertion select an attacker-created external trust root', () => {
    const target = mkdtempSync(join(temp, 'asserted-target-'));
    const operatorRoot = mkdtempSync(join(temp, 'pinned-operator-'));
    const attackerRoot = mkdtempSync(join(temp, 'attacker-'));
    const operatorTrust = createTestHostTrust({ target });
    const attackerTrust = createTestHostTrust({ target, adapterId: 'attacker.parser.v1' });
    const operatorPath = writeHostTrustStore(operatorRoot, operatorTrust);
    const attackerPath = writeHostTrustStore(attackerRoot, attackerTrust);

    const callerPromoted = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: operatorPath,
      hostAuthority: () => true,
    });
    assert.equal(callerPromoted.ok, false);
    assert.equal(callerPromoted.state, 'unsupported_boundary');

    const rejected = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: attackerPath,
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /does not match the pre-registered operator trust path/);
  });

  it('rejects a pre-registered store path implemented as a symbolic link', t => {
    const target = mkdtempSync(join(temp, 'symlink-target-'));
    const operatorRoot = mkdtempSync(join(temp, 'symlink-operator-'));
    const otherRoot = mkdtempSync(join(temp, 'symlink-source-'));
    const trust = createTestHostTrust({ target });
    const sourcePath = writeHostTrustStore(otherRoot, trust);
    const expectedPath = operatorTrustStorePath(target, operatorRoot);
    mkdirSync(dirname(expectedPath), { recursive: true });
    try {
      symlinkSync(sourcePath, expectedPath, 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symbolic links unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const result = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: expectedPath,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /must not be a symbolic link/);
  });
});
