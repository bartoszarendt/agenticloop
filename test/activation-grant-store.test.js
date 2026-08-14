/**
 * Operator activation material, durable activation storage, and activation
 * policy: assurance is earned through externally held keys, never asserted.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  activationGrantSignaturePayload,
  createActivationRevocation,
} from '../src/activation-grant.js';
import {
  ACTIVATION_MODES,
  MODE_MINIMUMS,
  activationPolicyPinPath,
  readProjectActivationRequest,
  resolveActivationPolicy,
} from '../src/activation-policy.js';
import {
  createActivationSignatureVerifier,
  assertSafeOperatorActivationKeyWritePath,
  assertSafeExternalActivationRevocationPath,
  externalActivationRevocationPath,
  loadOperatorActivationKey,
  operatorActivationKeyPath,
  provisionOperatorActivationKey,
  readExternalActivationRevocations,
  signOperatorActivationPayload,
  writeExternalActivationRevocation,
} from '../src/activation-trust.js';
import {
  ACTIVATION_STORE_ROOT,
  bindingRecordPath,
  grantRecordPath,
  readActivationRevocations,
  readTaskActivationBinding,
  revocationRecordPath,
  writeActivationRecords,
  writeActivationRevocation,
} from '../src/activation-store.js';
import { targetRepositoryIdentity } from '../src/host-trust.js';
import {
  CLEAN_DISPATCH_STATE_IDENTITY,
  PERMITTED_OPERATOR_STATE_PREFIXES,
  PERMITTED_UNTRACKED_PREFIXES,
} from '../src/repository-state.js';
import { bindingFor, grantFor } from './helpers/activation-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'agenticloop-activation-store-'));
});

after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Operator activation material
// ---------------------------------------------------------------------------

describe('operator activation material', () => {
  it('provisions a key outside the target, idempotently, and never writes into the target', () => {
    const target = mkdtempSync(join(temp, 'op-key-target-'));
    const root = mkdtempSync(join(temp, 'op-key-root-'));
    const first = provisionOperatorActivationKey(target, { operatorActivationRoot: root });
    assert.equal(first.ok, true, first.errors?.join('; '));
    assert.equal(first.created, true);
    assert.match(first.key.keyId, /^operator-[a-f0-9]{16}$/);
    assert.equal(first.path, operatorActivationKeyPath(target, root));
    assert.equal(existsSync(join(target, '.agenticloop')), false);

    const second = provisionOperatorActivationKey(target, { operatorActivationRoot: root });
    assert.equal(second.created, false);
    assert.equal(second.key.keyId, first.key.keyId);
  });

  it('fails closed when the root resolves inside the target', () => {
    const target = mkdtempSync(join(temp, 'inside-target-'));
    const inside = join(target, '.agenticloop', 'operator-activation');
    mkdirSync(inside, { recursive: true });
    const loaded = loadOperatorActivationKey(target, { operatorActivationRoot: inside });
    assert.equal(loaded.ok, false);
    assert.match(loaded.errors[0], /outside the target repository/);
  });

  it('refuses a preexisting external activation root implemented as a link', t => {
    const target = mkdtempSync(join(temp, 'key-link-target-'));
    const root = join(temp, 'key-link-root');
    const outside = mkdtempSync(join(temp, 'key-link-outside-'));
    try {
      symlinkSync(outside, root, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`symbolic links unavailable: ${error.code}`);
      throw error;
    }
    const provisioned = provisionOperatorActivationKey(target, { operatorActivationRoot: root });
    assert.equal(provisioned.ok, false);
    assert.match(provisioned.errors.join('\n'), /symbolic link or junction/);
    assert.equal(existsSync(operatorActivationKeyPath(target, outside)), false);
  });

  it('rejects an activation root replaced by a link during key-root materialization', t => {
    const target = mkdtempSync(join(temp, 'key-race-target-'));
    const root = join(temp, 'key-race-root');
    const destination = operatorActivationKeyPath(target, root);
    const outside = mkdtempSync(join(temp, 'key-race-outside-'));
    assert.doesNotThrow(() => assertSafeOperatorActivationKeyWritePath(target, root, destination));
    mkdirSync(root, { recursive: true });
    try {
      rmSync(root, { recursive: true });
      symlinkSync(outside, root, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`symbolic links unavailable: ${error.code}`);
      throw error;
    }
    assert.throws(() => assertSafeOperatorActivationKeyWritePath(target, root, destination), /symbolic link or junction/);
  });

  it('fails closed on a key bound to another repository', () => {
    const target = mkdtempSync(join(temp, 'mismatch-target-'));
    const other = mkdtempSync(join(temp, 'mismatch-other-'));
    const root = mkdtempSync(join(temp, 'mismatch-root-'));
    const provisioned = provisionOperatorActivationKey(other, { operatorActivationRoot: root });
    assert.equal(provisioned.ok, true);
    // Move the other repository's document to this target's derived path.
    const document = JSON.parse(readFileSync(provisioned.path, 'utf8'));
    writeFileSync(operatorActivationKeyPath(target, root), JSON.stringify(document), 'utf8');
    const loaded = loadOperatorActivationKey(target, { operatorActivationRoot: root });
    assert.equal(loaded.ok, false);
    assert.match(loaded.errors.join('; '), /does not match this repository/);
  });

  it('is not a signing oracle: it signs only canonical activation payloads for its own target', () => {
    const target = mkdtempSync(join(temp, 'oracle-target-'));
    const root = mkdtempSync(join(temp, 'oracle-root-'));
    const { key } = provisionOperatorActivationKey(target, { operatorActivationRoot: root });
    const repositoryIdentity = targetRepositoryIdentity(target);
    assert.throws(
      () => signOperatorActivationPayload({ kind: 'anything.else', repositoryIdentity }, { key, repositoryIdentity }),
      /signs only canonical activation and compatibility-waiver payloads/
    );
    assert.throws(
      () => signOperatorActivationPayload(
        { kind: 'agenticloop.activation-grant-signature', repositoryIdentity: 'file:/elsewhere' },
        { key, repositoryIdentity }
      ),
      /bound to its own target repository/
    );
  });

  it('verifies a real operator signature and rejects a foreign key', () => {
    const target = mkdtempSync(join(temp, 'verify-target-'));
    const root = mkdtempSync(join(temp, 'verify-root-'));
    const other = mkdtempSync(join(temp, 'verify-other-'));
    const { key } = provisionOperatorActivationKey(target, { operatorActivationRoot: root });
    const foreign = provisionOperatorActivationKey(other, { operatorActivationRoot: root }).key;
    const repositoryIdentity = targetRepositoryIdentity(target);
    const grant = grantFor({ repositoryIdentity });
    const payload = activationGrantSignaturePayload(grant);
    const signature = signOperatorActivationPayload(payload, { key, repositoryIdentity });
    assert.equal(createActivationSignatureVerifier({ operatorKey: key })(payload, signature, 'operator_confirmed'), true);
    assert.equal(createActivationSignatureVerifier({ operatorKey: foreign })(payload, signature, 'operator_confirmed'), false);
    // The operator key never satisfies a host_signed claim.
    assert.equal(createActivationSignatureVerifier({ operatorKey: key })(payload, signature, 'host_signed'), false);
  });
});

describe('external activation revocation authority', () => {
  function revocationFor(target) {
    return createActivationRevocation({ grant: grantFor({ repositoryIdentity: targetRepositoryIdentity(target) }) });
  }

  it('refuses an external revocation root inside the target on both write and read', () => {
    const target = mkdtempSync(join(temp, 'external-revocation-inside-target-'));
    const root = join(target, '.agenticloop', 'operator-activation');
    const revocation = revocationFor(target);
    const written = writeExternalActivationRevocation(target, revocation, { operatorActivationRoot: root });
    assert.equal(written.ok, false);
    assert.match(written.errors.join('; '), /outside the target repository/);
    const read = readExternalActivationRevocations(target, { operatorActivationRoot: root });
    assert.equal(read.ok, false);
    assert.match(read.errors.join('; '), /outside the target repository/);
  });

  it('refuses an external revocation root implemented as a link', t => {
    const target = mkdtempSync(join(temp, 'external-revocation-link-target-'));
    const root = join(temp, 'external-revocation-link-root');
    const outside = mkdtempSync(join(temp, 'external-revocation-link-outside-'));
    try {
      symlinkSync(outside, root, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`symbolic links unavailable: ${error.code}`);
      throw error;
    }
    const written = writeExternalActivationRevocation(target, revocationFor(target), { operatorActivationRoot: root });
    assert.equal(written.ok, false);
    assert.match(written.errors.join('; '), /symbolic link or junction/);
    const read = readExternalActivationRevocations(target, { operatorActivationRoot: root });
    assert.equal(read.ok, false);
    assert.match(read.errors.join('; '), /symbolic link or junction/);
  });

  it('rechecks external revocation authority after materialization before atomic write', t => {
    const target = mkdtempSync(join(temp, 'external-revocation-race-target-'));
    const root = join(temp, 'external-revocation-race-root');
    const revocation = revocationFor(target);
    const destination = externalActivationRevocationPath(target, revocation.revocationId, root);
    const outside = mkdtempSync(join(temp, 'external-revocation-race-outside-'));
    assert.doesNotThrow(() => assertSafeExternalActivationRevocationPath(target, root, destination));
    mkdirSync(root, { recursive: true });
    try {
      rmSync(root, { recursive: true });
      symlinkSync(outside, root, 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip(`symbolic links unavailable: ${error.code}`);
      throw error;
    }
    assert.throws(() => assertSafeExternalActivationRevocationPath(target, root, destination), /symbolic link or junction/);
  });
});

// ---------------------------------------------------------------------------
// Durable storage
// ---------------------------------------------------------------------------

describe('durable activation storage', () => {
  it('uses deterministic paths under the durable root and never .agenticloop/tmp', () => {
    assert.equal(ACTIVATION_STORE_ROOT, '.agenticloop/activations');
    assert.equal(
      grantRecordPath('grant:11111111-1111-4111-8111-111111111111'),
      '.agenticloop/activations/grants/11111111-1111-4111-8111-111111111111.json'
    );
    assert.equal(bindingRecordPath('files', 'T-016'), '.agenticloop/activations/bindings/files--T-016.json');
    assert.equal(bindingRecordPath('github', 'T-016'), '.agenticloop/activations/bindings/github--T-016.json');
    assert.equal(
      revocationRecordPath('revocation:22222222-2222-4222-8222-222222222222'),
      '.agenticloop/activations/revocations/22222222-2222-4222-8222-222222222222.json'
    );
  });

  it('refuses traversal, absolute, and Windows-hostile task slugs', () => {
    for (const bad of ['../escape', 'a/b', 'con', 'PRN', 'trailing.', '', 'x'.repeat(80)]) {
      assert.throws(() => bindingRecordPath('files', bad), /unsafe activation record task id/);
    }
    assert.throws(() => grantRecordPath('grant:not-a-uuid'), /must be grant:<uuid-v4>/);
    assert.throws(() => bindingRecordPath('svn', 'T-016'), /unsupported activation binding backend/);
  });

  it('writes a grant plus every binding as one transaction', () => {
    const target = mkdtempSync(join(temp, 'store-ok-'));
    const grant = grantFor();
    const bindings = [
      { ...bindingFor(grant), authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } },
      { ...bindingFor(grant, { taskId: 'T-017', carrier: '.agenticloop/tasks/T-017.md' }), authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } },
    ];
    const written = writeActivationRecords(target, { grant, bindings });
    assert.equal(written.ok, true, written.receipt.errors.join('; '));
    assert.equal(written.receipt.mutationDisposition, 'committed');
    assert.equal(written.receipt.unresolved, false);
    assert.equal(existsSync(join(target, grantRecordPath(grant.grantId))), true);
    assert.equal(existsSync(join(target, bindingRecordPath('files', 'T-016'))), true);
    assert.equal(existsSync(join(target, bindingRecordPath('files', 'T-017'))), true);
    assert.equal(readFileSync(join(target, grantRecordPath(grant.grantId)), 'utf8').includes('privateKey'), false);
  });

  it('produces no partial authority when one binding in the batch is invalid', () => {
    const target = mkdtempSync(join(temp, 'store-partial-'));
    const grant = grantFor();
    const good = { ...bindingFor(grant), authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } };
    const bad = { ...bindingFor(grant, { taskId: 'T-017', carrier: '.agenticloop/tasks/T-017.md' }), taskContractDigest: 'not-a-digest' };
    const written = writeActivationRecords(target, { grant, bindings: [good, bad] });
    assert.equal(written.ok, false);
    assert.equal(written.receipt.mutationDisposition, 'uncommitted');
    assert.equal(written.receipt.unresolved, false);
    assert.deepEqual(written.receipt.changedPaths, []);
    assert.equal(existsSync(join(target, ACTIVATION_STORE_ROOT, 'grants')), false);
    assert.equal(existsSync(join(target, bindingRecordPath('files', 'T-016'))), false);
  });

  it('replaces a prior binding only against its exact observed digest', () => {
    const target = mkdtempSync(join(temp, 'store-replace-'));
    const grant = grantFor();
    const binding = { ...bindingFor(grant), authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } };
    assert.equal(writeActivationRecords(target, { grant, bindings: [binding] }).ok, true);
    const second = grantFor();
    const secondBinding = { ...bindingFor(second), authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } };
    // A stale expected digest is a concurrent-activation conflict, not a silent overwrite.
    const stale = writeActivationRecords(target, {
      grant: second,
      bindings: [secondBinding],
      expectedBindingDigests: { [bindingRecordPath('files', 'T-016')]: `sha256:${'0'.repeat(64)}` },
    });
    assert.equal(stale.ok, false);
    assert.match(stale.receipt.errors.join('; '), /is stale/);
    const current = readTaskActivationBinding(target, 'files', 'T-016');
    assert.equal(current.record.grantId, grant.grantId);

    const third = grantFor();
    const thirdBinding = { ...bindingFor(third), authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } };
    assert.equal(writeActivationRecords(target, { grant: third, bindings: [thirdBinding] }).ok, true);
    assert.equal(readTaskActivationBinding(target, 'files', 'T-016').record.grantId, third.grantId);
  });

  it('is ignored by default and permitted untracked at the dispatch clean gate', async () => {
    const target = mkdtempSync(join(temp, 'store-gitignore-'));
    const initialized = await runCliInProcess(['init', '--target', target]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const ignored = readFileSync(join(target, '.gitignore'), 'utf8').split('\n').map(line => line.trim());
    assert.ok(ignored.includes('.agenticloop/activations/'));
    assert.ok(ignored.includes('.agenticloop/returns/verifications/'));
    // The clean gate names the class explicitly rather than folding it into
    // scratch, and the return boundary still refuses those paths as work.
    assert.deepEqual([...PERMITTED_OPERATOR_STATE_PREFIXES], [
      '.agenticloop/activations/', '.agenticloop/returns/verifications/', '.agenticloop/closeout-waivers/',
    ]);
    assert.deepEqual([...PERMITTED_UNTRACKED_PREFIXES], [
      '.agenticloop/tmp/', '.agenticloop/activations/', '.agenticloop/returns/verifications/', '.agenticloop/closeout-waivers/',
    ]);
    assert.match(CLEAN_DISPATCH_STATE_IDENTITY, /^sha256:agenticloop\.dispatch-clean-state\.v3:[a-f0-9]{64}$/);
  });

  it('surfaces a malformed revocation record as an unusable entry', () => {
    const target = mkdtempSync(join(temp, 'store-revocation-'));
    mkdirSync(join(target, ACTIVATION_STORE_ROOT, 'revocations'), { recursive: true });
    writeFileSync(join(target, ACTIVATION_STORE_ROOT, 'revocations', 'broken.json'), '{ not json', 'utf8');
    const read = readActivationRevocations(target);
    assert.equal(read.ok, false);
    assert.equal(read.revocations.length, 1);
    assert.match(read.errors[0], /invalid JSON/);
  });

  it('records a revocation exactly once', () => {
    const target = mkdtempSync(join(temp, 'store-revoke-'));
    const grant = grantFor();
    const revocation = createActivationRevocation({ grant });
    assert.equal(writeActivationRevocation(target, revocation).receipt.mutationDisposition, 'committed');
    assert.equal(writeActivationRevocation(target, revocation).receipt.mutationDisposition, 'already_current');
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('activation policy', () => {
  it('defaults to standard mode with no pin and no repository request', () => {
    const target = mkdtempSync(join(temp, 'policy-default-'));
    const root = mkdtempSync(join(temp, 'policy-default-root-'));
    const policy = resolveActivationPolicy({ target, projectConfig: {}, operatorActivationRoot: root });
    assert.equal(policy.ok, true);
    assert.equal(policy.mode, 'standard');
    assert.equal(policy.source, 'default');
    assert.equal(policy.minimumActivation, 'operator_confirmed');
    assert.equal(policy.minimumReturn, 'session_reported');
  });

  it('lets the repository raise the minimum', () => {
    const target = mkdtempSync(join(temp, 'policy-raise-'));
    const root = mkdtempSync(join(temp, 'policy-raise-root-'));
    const policy = resolveActivationPolicy({
      target,
      projectConfig: { activation: { mode: 'hardened' } },
      operatorActivationRoot: root,
    });
    assert.equal(policy.mode, 'hardened');
    assert.equal(policy.source, 'repository');
    assert.equal(policy.minimumActivation, 'host_signed');
    assert.equal(policy.minimumReturn, 'host_receipt');
  });

  it('never lets the repository lower an operator-pinned minimum', () => {
    const target = mkdtempSync(join(temp, 'policy-floor-'));
    const root = mkdtempSync(join(temp, 'policy-floor-root-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(activationPolicyPinPath(target, root), JSON.stringify({
      kind: 'agenticloop.activation-policy-pin',
      schemaVersion: 1,
      target: { repositoryIdentity: targetRepositoryIdentity(target) },
      mode: 'hardened',
    }), 'utf8');
    const policy = resolveActivationPolicy({
      target,
      projectConfig: { activation: { mode: 'standard' } },
      operatorActivationRoot: root,
    });
    assert.equal(policy.mode, 'hardened');
    assert.equal(policy.source, 'operator_pin');
    assert.equal(policy.pinnedMode, 'hardened');
    assert.equal(policy.requestedMode, 'standard');
  });

  it('fails closed at hardened when the pin or the repository request is malformed', () => {
    const target = mkdtempSync(join(temp, 'policy-bad-'));
    const root = mkdtempSync(join(temp, 'policy-bad-root-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(activationPolicyPinPath(target, root), '{ "kind": "wrong" }', 'utf8');
    const pinned = resolveActivationPolicy({ target, projectConfig: {}, operatorActivationRoot: root });
    assert.equal(pinned.ok, false);
    assert.equal(pinned.mode, 'hardened');
    assert.equal(pinned.source, 'unresolved');

    const badRequest = readProjectActivationRequest({ activation: { mode: 'yolo' } });
    assert.equal(badRequest.ok, false);
    const resolvedBad = resolveActivationPolicy({
      target: mkdtempSync(join(temp, 'policy-bad2-')),
      projectConfig: { activation: { mode: 'yolo' } },
      operatorActivationRoot: mkdtempSync(join(temp, 'policy-bad2-root-')),
    });
    assert.equal(resolvedBad.ok, false);
    assert.equal(resolvedBad.mode, 'hardened');
  });

  it('states the exact minimums each mode requires', () => {
    assert.deepEqual([...ACTIVATION_MODES], ['standard', 'hardened']);
    assert.deepEqual(MODE_MINIMUMS.standard, { activation: 'operator_confirmed', return: 'session_reported' });
    assert.deepEqual(MODE_MINIMUMS.hardened, { activation: 'host_signed', return: 'host_receipt' });
  });
});
