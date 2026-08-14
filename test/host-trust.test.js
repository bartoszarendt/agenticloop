import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  exportPublicKey,
  generateHostSigningKey,
  hostTrustBoundarySignaturePayload,
  HOST_TRUST_BOUNDARY_RESPONSE_KIND,
  HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
  HOST_TRUST_CHALLENGE_TTL_MS,
  importPublicKey,
  loadHostTrustStore,
  operatorTrustStorePath,
  parseHostTrustStore,
  signHostPayload,
  targetRepositoryIdentity,
  verifyHostPayload,
} from '../src/host-trust.js';
import { assertSafeHostTrustStoreWritePath } from '../src/host-trust-cli.js';
import { createTestHostTrust, protectedHostBoundary, writeHostTrustStore } from './helpers/host-trust-fixture.js';

const temp = mkdtempSync(join(tmpdir(), 'agenticloop-host-trust-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SIGNATURE_PREFIX = 'ed25519:';

/**
 * Corrupt one signature's *payload* bytes, not its encoding.
 *
 * Flipping the trailing `=` produced text the signature grammar now rejects
 * outright, so the resulting refusal would no longer prove that Ed25519
 * verification itself failed. Changing a data character keeps the text a
 * well-formed canonical signature that simply does not verify.
 */
function corruptSignatureBody(signature) {
  const body = signature.slice(SIGNATURE_PREFIX.length);
  const index = BASE64_ALPHABET.indexOf(body[0]);
  return `${SIGNATURE_PREFIX}${BASE64_ALPHABET[(index + 1) % 64]}${body.slice(1)}`;
}

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

  /**
   * Exact signature-text grammar.
   *
   * Splitting on ':' and testing a permissive Base64 pattern accepted several
   * distinct texts for one signature: a trailing segment was silently dropped,
   * a wrong-length payload reached `crypto.verify`, and noncanonical trailing
   * bits gave the same 64 bytes more than one spelling. Signature text is an
   * identity that is compared and logged, so exactly one text must decode.
   */
  it('accepts exactly one canonical encoding of a valid signature', () => {
    const { publicKey, privateKey } = generateHostSigningKey();
    const payload = { probe: true };
    const signature = signHostPayload(payload, privateKey);
    const body = signature.slice(SIGNATURE_PREFIX.length);

    assert.equal(verifyHostPayload(payload, signature, publicKey), true);
    assert.equal(body.length, 88, 'a 64-byte Ed25519 signature is 88 padded Base64 characters');
    assert.ok(body.endsWith('=='));

    // The 86th data character carries 4 unused low bits. Canonical Base64
    // zeroes them, so `index % 16 === 0`; index + 1 decodes to the identical 64
    // bytes under a second spelling that must not be accepted.
    const tailIndex = BASE64_ALPHABET.indexOf(body[85]);
    assert.equal(tailIndex % 16, 0, 'canonical encoding zeroes the unused trailing bits');
    const noncanonical = `${SIGNATURE_PREFIX}${body.slice(0, 85)}${BASE64_ALPHABET[tailIndex + 1]}==`;
    assert.notEqual(noncanonical, signature);
    assert.deepEqual(
      Buffer.from(noncanonical.slice(SIGNATURE_PREFIX.length), 'base64'),
      Buffer.from(body, 'base64'),
      'the noncanonical spelling decodes to the same bytes, which is exactly why it must be refused'
    );

    const shortSignature = Buffer.from(body, 'base64').subarray(0, 63).toString('base64');
    const longSignature = Buffer.concat([Buffer.from(body, 'base64'), Buffer.from([0])]).toString('base64');

    const refused = [
      ['trailing ignored segment', `${signature}:ignored`],
      ['empty trailing segment', `${signature}:`],
      ['missing padding', `${SIGNATURE_PREFIX}${body.slice(0, 86)}`],
      ['extra padding', `${signature}=`],
      ['noncanonical trailing bits', noncanonical],
      ['63-byte payload', `${SIGNATURE_PREFIX}${shortSignature}`],
      ['65-byte payload', `${SIGNATURE_PREFIX}${longSignature}`],
      ['wrong algorithm', `ed448:${body}`],
      ['no algorithm', body],
      ['non-alphabet character', `${SIGNATURE_PREFIX}-${body.slice(1)}`],
      ['embedded whitespace', `${SIGNATURE_PREFIX}${body.slice(0, 40)} ${body.slice(41)}`],
    ];
    for (const [label, text] of refused) {
      assert.doesNotThrow(() => verifyHostPayload(payload, text, publicKey), label);
      assert.equal(verifyHostPayload(payload, text, publicKey), false, label);
    }

    // A well-formed canonical signature over different bytes still fails on the
    // cryptography rather than on the grammar.
    assert.equal(verifyHostPayload(payload, corruptSignatureBody(signature), publicKey), false);

    for (const badKey of [null, undefined, '', 'not-a-key', 'AAAA', {}, 42, Buffer.alloc(0)]) {
      assert.doesNotThrow(() => verifyHostPayload(payload, signature, badKey), String(badKey));
      assert.equal(verifyHostPayload(payload, signature, badKey), false, String(badKey));
    }
  });
});

describe('fixed operator trust registry', () => {
  it('refuses a preexisting operator trust root implemented as a symbolic link', t => {
    const target = mkdtempSync(join(temp, 'write-root-target-'));
    const root = join(temp, 'write-root-link');
    const outside = mkdtempSync(join(temp, 'write-root-outside-'));
    const destination = operatorTrustStorePath(target, root);
    try {
      symlinkSync(outside, root, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`symbolic links unavailable: ${error.code}`);
      throw error;
    }
    assert.throws(() => assertSafeHostTrustStoreWritePath(target, root, destination), /symbolic link or junction/);
  });

  it('refuses a root replaced by a link during trust-store materialization', t => {
    const target = mkdtempSync(join(temp, 'write-race-target-'));
    const root = join(temp, 'write-race-root');
    const destination = operatorTrustStorePath(target, root);
    const outside = mkdtempSync(join(temp, 'write-race-outside-'));
    // The first check models missing-root acceptance. Materialization occurs in
    // the CLI between checks; replace it before the required second check.
    assert.doesNotThrow(() => assertSafeHostTrustStoreWritePath(target, root, destination));
    mkdirSync(root, { recursive: true });
    try {
      rmSync(root, { recursive: true });
      symlinkSync(outside, root, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`symbolic links unavailable: ${error.code}`);
      throw error;
    }
    assert.throws(() => assertSafeHostTrustStoreWritePath(target, root, destination), /symbolic link or junction/);
  });

  it('loads closed schemaVersion 2 verification authorities from the fixed operator root', () => {
    const target = mkdtempSync(join(temp, 'authority-target-'));
    const operatorRoot = mkdtempSync(join(temp, 'authority-operator-'));
    const path = operatorTrustStorePath(target, operatorRoot);
    const { publicKeyBase64 } = generateHostSigningKey();
    const document = {
      kind: 'agenticloop.host-trust',
      schemaVersion: 2,
      target: { repositoryIdentity: targetRepositoryIdentity(target) },
      adapters: [],
      authorities: [{
        authorityId: 'redelegation-root',
        authorityKind: 'blocked_result_redelegation',
        keyId: 'redelegation-key-1',
        algorithm: 'ed25519',
        publicKey: publicKeyBase64,
        issuer: { ownerKind: 'workflow_role', ownerId: 'orchestrator' },
        revokedRecordIds: ['redelegation:00000000-0000-4000-8000-000000000001'],
      }],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(document), 'utf8');

    const loaded = loadHostTrustStore(target, { operatorTrustRoot: operatorRoot });
    assert.equal(loaded.ok, true, loaded.errors.join('\n'));
    assert.equal(loaded.authorities['redelegation-root'].authorityKind, 'blocked_result_redelegation');
    assert.equal(loaded.authorities['redelegation-root'].repositoryIdentity, targetRepositoryIdentity(target));
    assert.deepEqual(loaded.authorities['redelegation-root'].revokedRecordIds, document.authorities[0].revokedRecordIds);

    const callerFabricated = structuredClone(document);
    callerFabricated.authorities[0].publicKey = generateHostSigningKey().publicKeyBase64;
    const parsed = parseHostTrustStore(JSON.stringify(callerFabricated), { target });
    assert.equal(parsed.ok, true);
    assert.notEqual(
      parsed.authorities['redelegation-root'].publicKey,
      loaded.authorities['redelegation-root'].publicKey,
      'a separate document can parse, but callers cannot select it because load uses the fixed operator path'
    );

    const malformed = structuredClone(document);
    malformed.authorities[0].trusted = true;
    assert.equal(parseHostTrustStore(JSON.stringify(malformed), { target }).ok, false);
  });

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

  it('admits supported adapters only through a fresh signed boundary challenge', () => {
    const target = mkdtempSync(join(temp, 'protected-target-'));
    const operatorRoot = mkdtempSync(join(temp, 'protected-operator-'));
    const trust = createTestHostTrust({ target });
    const storePath = writeHostTrustStore(operatorRoot, trust);
    const observed = [];
    const loaded = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: storePath,
      protectedBoundary: protectedHostBoundary(trust, context => observed.push(context)),
    });
    assert.equal(loaded.ok, true, loaded.errors.join('\n'));
    assert.equal(loaded.state, 'protected_boundary');
    assert.equal(loaded.adapters[trust.adapterId].keyId, trust.keyId);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].kind, 'agenticloop.protected-host-trust-challenge');
    assert.equal(observed[0].targetRepositoryIdentity, trust.repositoryIdentity);
    assert.equal(observed[0].trustStorePath, storePath);
    assert.deepEqual(observed[0].supportedAdapterIds, [trust.adapterId]);

    const refused = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: storePath,
      protectedBoundary: () => false,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.state, 'unsupported_boundary');

    const callerPromoted = loadHostTrustStore(target, {
      operatorTrustRoot: operatorRoot,
      assertedPath: storePath,
      protectedBoundary: () => true,
    });
    assert.equal(callerPromoted.ok, false);
    assert.equal(callerPromoted.state, 'unsupported_boundary');
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

/**
 * Protected loader-challenge liveness.
 *
 * The challenge states an `expiresAt`. A stated expiry that nothing reads is
 * not a bound, so these tests drive an injectable clock across the callback and
 * assert that a late answer is refused however well it is signed - while every
 * other structural, identity, and signature check stays enforced.
 */
describe('protected loader challenge', () => {
  function fixture(name, extraAdapterIds = []) {
    const target = mkdtempSync(join(temp, `${name}-target-`));
    const operatorRoot = mkdtempSync(join(temp, `${name}-operator-`));
    const trust = createTestHostTrust({ target });
    const others = extraAdapterIds.map(adapterId =>
      createTestHostTrust({ target, adapterId, keyId: `${adapterId.replace(/\./g, '-')}-key` }));
    const document = {
      kind: 'agenticloop.host-trust',
      schemaVersion: 1,
      target: { repositoryIdentity: trust.repositoryIdentity },
      adapters: [trust, ...others].flatMap(entry => entry.document.adapters),
    };
    const storePath = writeHostTrustStore(operatorRoot, { target, document });
    return { target, operatorRoot, trust, others, storePath };
  }

  /** One response the protected host would legitimately produce. */
  function respond(trust, challenge, options = {}) {
    const response = {
      kind: HOST_TRUST_BOUNDARY_RESPONSE_KIND,
      schemaVersion: HOST_TRUST_BOUNDARY_SCHEMA_VERSION,
      adapterId: options.adapterId ?? trust.adapterId,
      keyId: options.keyId ?? trust.keyId,
      challengeNonce: options.challengeNonce ?? challenge.nonce,
      signature: null,
    };
    response.signature = signHostPayload(
      hostTrustBoundarySignaturePayload(challenge, response),
      options.signingKey ?? trust.privateKey
    );
    if (options.corruptSignature) {
      response.signature = corruptSignatureBody(response.signature);
    }
    return response;
  }

  /**
   * Load with a clock the test advances. `elapsed` is the number of
   * milliseconds that pass during the protected round trip.
   */
  function loadWithElapsed(fx, elapsed, boundary, extra = {}) {
    const issuedAt = Date.parse('2026-08-08T12:00:00.000Z');
    let reads = 0;
    return loadHostTrustStore(fx.target, {
      operatorTrustRoot: fx.operatorRoot,
      assertedPath: fx.storePath,
      clock: () => issuedAt,
      monotonicClock: () => (reads++ === 0 ? 10_000 : 10_000 + elapsed),
      protectedBoundary: boundary,
      ...extra,
    });
  }

  it('admits a response returned inside the challenge window', () => {
    const fx = fixture('ttl-inside');
    const loaded = loadWithElapsed(fx, HOST_TRUST_CHALLENGE_TTL_MS - 1, challenge => respond(fx.trust, challenge));
    assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
    assert.equal(loaded.state, 'protected_boundary');
    assert.equal(loaded.adapters[fx.trust.adapterId].keyId, fx.trust.keyId);
  });

  it('refuses a correctly signed response returned exactly at expiry', () => {
    const fx = fixture('ttl-exact');
    const loaded = loadWithElapsed(fx, HOST_TRUST_CHALLENGE_TTL_MS, challenge => respond(fx.trust, challenge));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
    assert.deepEqual(loaded.adapters, {});
  });

  it('refuses a correctly signed response returned after expiry', () => {
    const fx = fixture('ttl-after');
    const loaded = loadWithElapsed(fx, HOST_TRUST_CHALLENGE_TTL_MS + 1_000, challenge => respond(fx.trust, challenge));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
    assert.deepEqual(loaded.adapters, {});
  });

  /**
   * `now` must never become the loader clock.
   *
   * `now` pins receipt-freshness evaluation. When it was also allowed to supply
   * the loader clock, both reads around the callback returned the same fixed
   * instant, so `returnedAt - issuedAt` was always 0 and the challenge expiry
   * stopped bounding anything for every caller that passed only `now` - which
   * is what `loadAuditorReturnReceiptVerifier` does.
   */
  it('does not freeze challenge time for a now-only caller', () => {
    const fx = fixture('now-only-clock');
    const pinned = Date.parse('2020-01-01T00:00:00.000Z');
    const before = Date.now();
    let observed = null;
    const loaded = loadHostTrustStore(fx.target, {
      operatorTrustRoot: fx.operatorRoot,
      assertedPath: fx.storePath,
      now: pinned,
      protectedBoundary: challenge => {
        observed = challenge;
        return respond(fx.trust, challenge);
      },
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('\n'));
    assert.ok(observed, 'the boundary must receive a challenge');
    const issuedAt = Date.parse(observed.issuedAt);
    assert.notEqual(issuedAt, pinned, 'the pinned freshness instant must not become the loader clock');
    assert.ok(issuedAt >= before && issuedAt <= Date.now(), 'the loader must read the real clock');
  });

  it('enforces challenge expiry against the real clock for a now-only caller', () => {
    const fx = fixture('now-only-expiry');
    const loaded = loadHostTrustStore(fx.target, {
      operatorTrustRoot: fx.operatorRoot,
      assertedPath: fx.storePath,
      now: Date.parse('2020-01-01T00:00:00.000Z'),
      protectedBoundary: challenge => {
        // A genuinely slow protected round trip. `now` cannot mask it.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOST_TRUST_CHALLENGE_TTL_MS + 250);
        return respond(fx.trust, challenge);
      },
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
    assert.deepEqual(loaded.adapters, {});
  });

  it('refuses invalid wall and monotonic clock evidence without throwing', () => {
    const fx = fixture('non-finite-clock');
    const issuedAt = Date.parse('2026-08-08T12:00:00.000Z');
    for (const [label, clock, elapsedValues] of [
      ['non-finite wall clock', () => Number.NaN, [1, 2]],
      ['out-of-Date-range wall clock', () => Number.MAX_VALUE, [1, 2]],
      ['throwing wall clock', () => { throw new Error('clock failed'); }, [1, 2]],
      ['non-finite elapsed start', () => issuedAt, [Number.NaN, 2]],
      ['non-finite elapsed return', () => issuedAt, [1, Number.POSITIVE_INFINITY]],
      ['backward elapsed clock', () => issuedAt, [2, 1]],
    ]) {
      let reads = 0;
      const loaded = loadHostTrustStore(fx.target, {
        operatorTrustRoot: fx.operatorRoot,
        assertedPath: fx.storePath,
        clock,
        monotonicClock: () => elapsedValues[Math.min(reads++, elapsedValues.length - 1)],
        protectedBoundary: challenge => respond(fx.trust, challenge),
      });
      assert.equal(loaded.ok, false, label);
      assert.equal(loaded.state, 'unsupported_boundary', label);
    }
  });

  it('remains deterministic under an explicit advancing clock', () => {
    const fx = fixture('advancing-clock');
    for (const elapsed of [0, 1, HOST_TRUST_CHALLENGE_TTL_MS - 1]) {
      const loaded = loadWithElapsed(fx, elapsed, challenge => respond(fx.trust, challenge));
      assert.equal(loaded.ok, true, `${elapsed}: ${loaded.errors?.join('\n')}`);
      assert.equal(loaded.state, 'protected_boundary', String(elapsed));
    }
    for (const elapsed of [HOST_TRUST_CHALLENGE_TTL_MS, HOST_TRUST_CHALLENGE_TTL_MS + 1, 86_400_000]) {
      const loaded = loadWithElapsed(fx, elapsed, challenge => respond(fx.trust, challenge));
      assert.equal(loaded.ok, false, String(elapsed));
      assert.equal(loaded.state, 'unsupported_boundary', String(elapsed));
    }
    // An explicit clock still wins when `now` is also supplied.
    const withBoth = loadWithElapsed(fx, HOST_TRUST_CHALLENGE_TTL_MS + 1, challenge => respond(fx.trust, challenge), {
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    });
    assert.equal(withBoth.ok, false);
    assert.equal(withBoth.state, 'unsupported_boundary');
  });

  it('states an expiresAt that matches the enforced challenge lifetime', () => {
    const fx = fixture('ttl-declared');
    let observed = null;
    loadWithElapsed(fx, 0, challenge => {
      observed = challenge;
      return respond(fx.trust, challenge);
    });
    assert.ok(observed, 'the boundary must receive a challenge');
    assert.equal(
      Date.parse(observed.expiresAt) - Date.parse(observed.issuedAt),
      HOST_TRUST_CHALLENGE_TTL_MS
    );
  });

  it('refuses a response bound to the wrong nonce', () => {
    const fx = fixture('wrong-nonce');
    const loaded = loadWithElapsed(fx, 0, challenge =>
      respond(fx.trust, challenge, { challengeNonce: 'not-the-issued-nonce' }));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses a replayed response from a prior challenge', () => {
    const fx = fixture('replay');
    let captured = null;
    const first = loadWithElapsed(fx, 0, challenge => {
      captured = { challenge, response: respond(fx.trust, challenge) };
      return captured.response;
    });
    assert.equal(first.ok, true, first.errors?.join('\n'));

    // A fresh nonce is issued for the second load; the stored proof is bound to
    // the old one and confers nothing.
    const replayed = loadWithElapsed(fx, 0, challenge => {
      assert.notEqual(challenge.nonce, captured.challenge.nonce, 'each load must issue a fresh nonce');
      return captured.response;
    });
    assert.equal(replayed.ok, false);
    assert.equal(replayed.state, 'unsupported_boundary');
  });

  it('refuses a response naming an unregistered adapter', () => {
    const fx = fixture('wrong-adapter');
    const loaded = loadWithElapsed(fx, 0, challenge =>
      respond(fx.trust, challenge, { adapterId: 'attacker.parser.v1' }));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses a response naming the wrong pinned key id', () => {
    const fx = fixture('wrong-key-id');
    const loaded = loadWithElapsed(fx, 0, challenge =>
      respond(fx.trust, challenge, { keyId: 'some-other-key' }));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses a response signed by a key the operator never pinned', () => {
    const fx = fixture('wrong-key-material');
    const stranger = generateHostSigningKey();
    const loaded = loadWithElapsed(fx, 0, challenge =>
      respond(fx.trust, challenge, { signingKey: stranger.privateKey }));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses a forged signature over an otherwise valid response', () => {
    const fx = fixture('forged-signature');
    const loaded = loadWithElapsed(fx, 0, challenge =>
      respond(fx.trust, challenge, { corruptSignature: true }));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses a bare boolean callback however affirmative', () => {
    const fx = fixture('boolean-callback');
    for (const returned of [true, [true], 1, 'authorized', {}]) {
      const loaded = loadWithElapsed(fx, 0, () => returned);
      assert.equal(loaded.ok, false, String(returned));
      assert.equal(loaded.state, 'unsupported_boundary', String(returned));
    }
  });

  it('refuses a callback that throws', () => {
    const fx = fixture('throwing-callback');
    const loaded = loadWithElapsed(fx, 0, () => { throw new Error('host boundary unavailable'); });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses duplicate responses for the same adapter', () => {
    const fx = fixture('duplicate-adapter', ['second.parser.v1']);
    const loaded = loadWithElapsed(fx, 0, challenge => [
      respond(fx.trust, challenge),
      respond(fx.trust, challenge),
    ]);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('refuses a challenge that requests an adapter the store does not support', () => {
    const fx = fixture('missing-requested');
    const loaded = loadWithElapsed(fx, 0, challenge => respond(fx.trust, challenge), {
      requiredSupportedAdapterIds: ['never.registered.v1'],
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
  });

  it('authorizes every requested adapter or none of them', () => {
    const fx = fixture('multi-adapter', ['second.parser.v1']);
    const second = fx.others[0];

    const complete = loadWithElapsed(fx, 0, challenge => [
      respond(fx.trust, challenge),
      respond(second, challenge),
    ]);
    assert.equal(complete.ok, true, complete.errors?.join('\n'));
    assert.equal(complete.state, 'protected_boundary');
    assert.deepEqual(
      Object.keys(complete.adapters).sort(),
      [fx.trust.adapterId, second.adapterId].sort()
    );

    // One genuine proof plus one forged proof authorizes nothing at all.
    const partial = loadWithElapsed(fx, 0, challenge => [
      respond(fx.trust, challenge),
      respond(second, challenge, { corruptSignature: true }),
    ]);
    assert.equal(partial.ok, false);
    assert.equal(partial.state, 'unsupported_boundary');
    assert.deepEqual(partial.adapters, {});

    // A challenge covering both adapters answered for only one is incomplete.
    const answeredOnce = loadWithElapsed(fx, 0, challenge => respond(fx.trust, challenge));
    assert.equal(answeredOnce.ok, false);
    assert.equal(answeredOnce.state, 'unsupported_boundary');
  });

  it('keeps the ordinary CLI fail-closed with no protected boundary at all', () => {
    const fx = fixture('no-boundary');
    const loaded = loadHostTrustStore(fx.target, {
      operatorTrustRoot: fx.operatorRoot,
      assertedPath: fx.storePath,
    });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsupported_boundary');
    assert.deepEqual(loaded.adapters, {});
    assert.match(loaded.errors.join('\n'), /protected boundary/);
  });
});
