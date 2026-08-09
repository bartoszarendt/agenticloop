/**
 * Universal, host-neutral activation: grants, task bindings, storage,
 * assurance policy, and the CLI that creates them.
 *
 * The property under test throughout is that assurance is *earned*, never
 * asserted: a record inside the repository cannot grade itself, a
 * non-interactive caller cannot reach `operator_confirmed`, and no shipped host
 * adapter becomes supported because an activation grant exists.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ACTIVATION_ASSURANCE_LIMITATIONS,
  ACTIVATION_ASSURANCE_ORDER,
  CLI_OPERATOR_PRODUCER_ID,
  MAX_GRANT_TTL_SECONDS,
  OPERATOR_CONFIRMATION_PHRASE,
  RETURN_ASSURANCE_LIMITATIONS,
  RETURN_ASSURANCE_ORDER,
  activationAssuranceMeets,
  activationGrantDigest,
  activationGrantSignaturePayload,
  createActivationGrant,
  createActivationRevocation,
  createTaskActivationBinding,
  resolveTaskActivationBinding,
  returnAssuranceMeets,
  taskActivationBindingDigest,
  taskActivationBindingSignaturePayload,
  validateActivationGrantShape,
  validateTaskActivationBindingShape,
} from '../src/activation-grant.js';
import {
  ACTIVATION_MODES,
  MODE_MINIMUMS,
  activationPolicyPinPath,
  loadActivationPolicyPin,
  readProjectActivationRequest,
  resolveActivationPolicy,
} from '../src/activation-policy.js';
import {
  createActivationSignatureVerifier,
  loadOperatorActivationKey,
  operatorActivationKeyPath,
  provisionOperatorActivationKey,
  signOperatorActivationPayload,
} from '../src/activation-trust.js';
import {
  ACTIVATION_STORE_ROOT,
  bindingRecordPath,
  grantRecordPath,
  listTaskActivationBindings,
  readActivationRevocations,
  readTaskActivationBinding,
  revocationRecordPath,
  writeActivationRecords,
  writeActivationRevocation,
} from '../src/activation-store.js';
import {
  SHIPPED_ACTIVATION_ADAPTERS,
  activationCapabilityInventory,
  dispatchPreparationDigest,
  prepareRoleDispatch,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import {
  loadTaskActivationEvidence,
  resolveActivationVerification,
  resolvePacketActivationBinding,
} from '../src/activation-resolution.js';
import { targetRepositoryIdentity } from '../src/host-trust.js';
import {
  CLEAN_DISPATCH_STATE_IDENTITY,
  PERMITTED_OPERATOR_STATE_PREFIXES,
  PERMITTED_UNTRACKED_PREFIXES,
} from '../src/repository-state.js';
import { taskContractDigest } from '../src/task-contract-baseline.js';
import { createDispatchFixture, git, prepare, sha256 } from './helpers/dispatch-fixture.js';
import { runCliInProcess, scriptedPromptFactory } from './helpers/run-cli.js';

let temp;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'agenticloop-activation-'));
});

after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure record contracts
// ---------------------------------------------------------------------------

const REPOSITORY = 'file:/tmp/fixture-repo';

function grantFor(overrides = {}) {
  return createActivationGrant({
    repositoryIdentity: REPOSITORY,
    backend: 'files',
    scope: { type: 'exact_tasks', taskIds: ['T-016', 'T-017'] },
    assurance: 'operator_confirmed',
    producer: { id: CLI_OPERATOR_PRODUCER_ID, channel: 'cli_interactive_confirmation' },
    evidence: {
      confirmedAt: new Date().toISOString(),
      confirmationPhrase: OPERATOR_CONFIRMATION_PHRASE,
      channel: 'cli_interactive_confirmation',
      operatorKeyId: 'operator-0123456789abcdef',
      scopeSummaryDigest: sha256('scope summary'),
    },
    ...overrides,
  });
}

const CONTRACT_DIGEST = `sha256:v1:${'a'.repeat(64)}`;

function bindingFor(grant, overrides = {}) {
  return createTaskActivationBinding({
    grant,
    backend: 'files',
    taskId: 'T-016',
    carrier: '.agenticloop/tasks/T-016.md',
    taskContractDigest: CONTRACT_DIGEST,
    derivation: 'direct_operator_confirmation',
    ...overrides,
  });
}

describe('activation grant and task binding contracts', () => {
  it('orders assurance grades and never accepts an unknown grade as sufficient', () => {
    assert.deepEqual([...ACTIVATION_ASSURANCE_ORDER], ['operator_confirmed', 'host_signed']);
    assert.deepEqual([...RETURN_ASSURANCE_ORDER], ['session_reported', 'host_receipt']);
    assert.equal(activationAssuranceMeets('host_signed', 'operator_confirmed'), true);
    assert.equal(activationAssuranceMeets('operator_confirmed', 'host_signed'), false);
    assert.equal(activationAssuranceMeets('operator_confirmed', 'operator_confirmed'), true);
    assert.equal(activationAssuranceMeets('scaffold', 'operator_confirmed'), false);
    assert.equal(activationAssuranceMeets(null, 'operator_confirmed'), false);
    assert.equal(returnAssuranceMeets('session_reported', 'host_receipt'), false);
    assert.equal(returnAssuranceMeets('host_receipt', 'session_reported'), true);
  });

  it('constructs a canonical grant with a matching semantic digest and immutable value', () => {
    const grant = grantFor();
    assert.equal(grant.kind, 'agenticloop.activation-grant');
    assert.equal(grant.schemaVersion, 1);
    assert.match(grant.grantId, /^grant:[0-9a-f-]{36}$/);
    assert.match(grant.revocation.id, /^revocation:[0-9a-f-]{36}$/);
    assert.equal(grant.revocation.state, 'active');
    assert.equal(grant.digest, activationGrantDigest(grant));
    assert.match(grant.digest, /^sha256:agenticloop\.activation-grant\.v1:[a-f0-9]{64}$/);
    assert.equal(validateActivationGrantShape(grant).ok, true);
    assert.equal(Object.isFrozen(grant), true);
    assert.equal(Object.isFrozen(grant.scope), true);
    assert.throws(() => { grant.scope.taskIds.push('T-999'); });
  });

  it('sorts and deduplicates an exact task scope so ordering carries no authority', () => {
    const grant = grantFor({ scope: { type: 'exact_tasks', taskIds: ['T-017', 'T-016', 'T-017'] } });
    assert.deepEqual(grant.scope.taskIds, ['T-016', 'T-017']);
  });

  it('rejects unknown input fields, unknown assurance values, and contradictory producers', () => {
    assert.throws(() => grantFor({ nonsense: true }), /unknown input field/);
    assert.throws(() => grantFor({ assurance: 'scaffold' }), /assurance must be/);
    assert.throws(
      () => grantFor({ producer: { id: 'some.host.adapter', channel: 'protected_host_boundary' } }),
      /operator-confirmed activation must be produced by/
    );
    assert.throws(
      () => createActivationGrant({
        repositoryIdentity: REPOSITORY,
        backend: 'files',
        scope: { type: 'exact_tasks', taskIds: ['T-016'] },
        assurance: 'host_signed',
        producer: { id: CLI_OPERATOR_PRODUCER_ID, channel: 'cli_interactive_confirmation' },
        evidence: { adapterId: 'x', keyId: 'k', captureId: null, channel: 'protected_host_boundary' },
      }),
      /host-signed activation evidence channel|host-signed activation must be produced/
    );
  });

  it('bounds grant lifetime', () => {
    assert.throws(() => grantFor({ ttlSeconds: MAX_GRANT_TTL_SECONDS + 1 }), /ttlSeconds must be an integer/);
    assert.throws(
      () => grantFor({ issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z' }),
      /lifetime must not exceed/
    );
  });

  it('refuses a work-unit scope that also enumerates tasks', () => {
    const grant = grantFor({ scope: { type: 'work_unit', workUnitId: 'wu-1' } });
    const tampered = { ...grant, scope: { ...grant.scope, taskIds: ['T-016'] } };
    tampered.digest = activationGrantDigest(tampered);
    const checked = validateActivationGrantShape(tampered);
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.some(item => /must not also enumerate tasks/.test(item.message)));
  });

  it('binds one task to the exact current contract digest and inherits grant assurance', () => {
    const grant = grantFor();
    const binding = bindingFor(grant);
    assert.equal(binding.grantId, grant.grantId);
    assert.equal(binding.grantDigest, grant.digest);
    assert.equal(binding.assurance, 'operator_confirmed');
    assert.equal(binding.taskContractDigest, CONTRACT_DIGEST);
    assert.equal(binding.expiresAt, grant.expiresAt);
    assert.equal(binding.digest, taskActivationBindingDigest(binding));
    assert.equal(validateTaskActivationBindingShape(binding).ok, true);
  });

  it('rejects a derivation that contradicts its assurance', () => {
    const grant = grantFor();
    assert.throws(
      () => bindingFor(grant, { derivation: 'direct_protected_host_binding' }),
      /protected-host derived binding must carry host_signed/
    );
  });

  it('rejects a decomposition source on a directly confirmed binding', () => {
    const grant = grantFor();
    assert.throws(
      () => bindingFor(grant, {
        decompositionSource: {
          sourceRef: '.agenticloop/decompositions/T-016.json',
          sourceDigest: sha256('x'),
          scanSemanticDigest: `sha256:agenticloop.parallel-scan.v1:${'b'.repeat(64)}`,
          workUnitId: 'wu-1',
          observedAt: new Date().toISOString(),
        },
      }),
      /only a decomposition-derived binding may carry a decomposition source/
    );
  });
});

// ---------------------------------------------------------------------------
// Resolution against current evidence
// ---------------------------------------------------------------------------

describe('activation binding resolution', () => {
  const alwaysVerify = () => true;

  function resolveWith(overrides = {}) {
    const grant = overrides.grant ?? grantFor();
    const binding = overrides.binding ?? bindingFor(grant);
    return resolveTaskActivationBinding({
      grant: { ...grant, authentication: { algorithm: 'ed25519', keyId: 'operator-0123456789abcdef', value: 'ed25519:AA==' } },
      binding: { ...binding, authentication: { algorithm: 'ed25519', keyId: 'operator-0123456789abcdef', value: 'ed25519:AA==' } },
      repositoryIdentity: REPOSITORY,
      backend: 'files',
      taskId: 'T-016',
      carrier: '.agenticloop/tasks/T-016.md',
      taskContractDigest: CONTRACT_DIGEST,
      verifySignature: alwaysVerify,
      ...overrides.input,
    });
  }

  it('accepts a current, in-scope, authenticated binding', () => {
    const resolved = resolveWith();
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
    assert.equal(resolved.assurance, 'operator_confirmed');
  });

  it('refuses a changed task contract as superseded, not as a malformed record', () => {
    const resolved = resolveWith({ input: { taskContractDigest: `sha256:v1:${'c'.repeat(64)}` } });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.evidenceState, 'changed');
    assert.equal(resolved.disposition, 'superseded');
    assert.ok(resolved.errors.some(item => item.code === 'activation.binding.stale_contract'));
  });

  it('refuses cross-task replay', () => {
    const resolved = resolveWith({ input: { taskId: 'T-017', carrier: '.agenticloop/tasks/T-017.md' } });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => item.code === 'activation.binding.task_mismatch'));
  });

  it('refuses cross-repository replay', () => {
    const resolved = resolveWith({ input: { repositoryIdentity: 'file:/tmp/other-repo' } });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => item.code === 'activation.grant.repository_mismatch'));
    assert.ok(resolved.errors.some(item => item.code === 'activation.binding.repository_mismatch'));
  });

  it('refuses an expired grant as stale', () => {
    const grant = grantFor({ ttlSeconds: 60 });
    const resolved = resolveWith({ grant, input: { now: Date.parse(grant.expiresAt) + 1000 } });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.evidenceState, 'stale');
    assert.ok(resolved.errors.some(item => item.code === 'activation.grant.expired'));
  });

  it('refuses a revoked grant', () => {
    const grant = grantFor();
    const revocation = createActivationRevocation({ grant, reason: 'test' });
    const resolved = resolveWith({ grant, input: { revocations: [revocation] } });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => item.code === 'activation.grant.revoked'));
  });

  it('treats a malformed revocation record as a revocation rather than ignoring it', () => {
    const resolved = resolveWith({ input: { revocations: [{ kind: 'agenticloop.activation-revocation', malformedPath: 'x' }] } });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => item.code === 'activation.grant.revoked'));
  });

  it('refuses an unauthenticated grant and a signature that does not verify', () => {
    const grant = grantFor();
    const binding = bindingFor(grant);
    const unauthenticated = resolveTaskActivationBinding({
      grant, binding,
      repositoryIdentity: REPOSITORY, backend: 'files', taskId: 'T-016',
      carrier: '.agenticloop/tasks/T-016.md', taskContractDigest: CONTRACT_DIGEST,
      verifySignature: alwaysVerify,
    });
    assert.equal(unauthenticated.ok, false);
    assert.ok(unauthenticated.errors.some(item => item.code === 'activation.grant.unauthenticated'));

    const rejected = resolveWith({ input: { verifySignature: () => false } });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(item => /does not verify against the external operator/.test(item.message)));
  });

  it('refuses a grant and binding signed by different keys', () => {
    const grant = grantFor();
    const binding = bindingFor(grant);
    const resolved = resolveTaskActivationBinding({
      grant: { ...grant, authentication: { algorithm: 'ed25519', keyId: 'k1', value: 'ed25519:AA==' } },
      binding: { ...binding, authentication: { algorithm: 'ed25519', keyId: 'k2', value: 'ed25519:AA==' } },
      repositoryIdentity: REPOSITORY, backend: 'files', taskId: 'T-016',
      carrier: '.agenticloop/tasks/T-016.md', taskContractDigest: CONTRACT_DIGEST,
      verifySignature: alwaysVerify,
    });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => /signed by different keys/.test(item.message)));
  });

  it('refuses a task outside an exact-task grant scope', () => {
    const grant = grantFor({ scope: { type: 'exact_tasks', taskIds: ['T-020'] } });
    const resolved = resolveWith({ grant });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => item.code === 'activation.grant.out_of_scope'));
  });
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

// ---------------------------------------------------------------------------
// CLI, end to end
// ---------------------------------------------------------------------------

/**
 * Turn a host-signed fixture into a plain scaffold project: the task keeps its
 * id, body, history, and decomposition, and simply loses its legacy activation
 * frontmatter. This is exactly the "existing scaffold/decomposed project" case.
 */
async function scaffoldFixture(name) {
  const fixture = await createDispatchFixture(temp, name, { scaffold: true });
  // The plugin-free path is the point of this fixture: no pinned host adapter
  // exists, so every command runs against an empty operator trust root.
  fixture.operatorTrustRoot = mkdtempSync(join(temp, `${name}-empty-trust-`));
  fixture.operatorActivationRoot = mkdtempSync(join(temp, `${name}-operator-activation-`));
  fixture.contractDigest = taskContractDigest(readFileSync(fixture.taskPath, 'utf8')).digest;
  return fixture;
}

async function correctContract(fixture, priorDigest, reason) {
  const corrected = await runCliInProcess([
    'task', 'authorize-correction', 'T-001',
    '--expect-prior-digest', priorDigest,
    '--reason', reason,
    '--authority', 'task:T-001',
    '--actor', 'Agentic Loop Test',
    '--target', fixture.root,
  ]);
  assert.equal(corrected.status, 0, corrected.stderr);
  git(fixture.root, ['add', '.agenticloop/task-contract-history']);
  git(fixture.root, ['commit', '-m', `authorize contract correction\n\nTask: T-001\nAgent: maintainer`]);
}

function interactiveOptions(fixture, answers = [OPERATOR_CONFIRMATION_PHRASE]) {
  return {
    isTTY: true,
    stdinIsTTY: true,
    ci: false,
    promptFactory: scriptedPromptFactory(answers),
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: fixture.operatorActivationRoot,
  };
}

describe('agenticloop activate', () => {
  it('refuses non-interactive execution and offers no --yes escape hatch', async () => {
    const fixture = await scaffoldFixture('activate-noninteractive');
    const result = await runCliInProcess(['activate', 'T-001', '--json', '--target', fixture.root], {
      isTTY: false,
      stdinIsTTY: false,
      ci: false,
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /interactive terminal/);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
    // The refusal happens before any side effect, inside or outside the target:
    // a non-interactive caller cannot even cause the operator key to exist.
    assert.equal(existsSync(operatorActivationKeyPath(fixture.root, fixture.operatorActivationRoot)), false);

    const usage = await runCliInProcess(['activate', 'T-001', '--yes', '--target', fixture.root], {
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(usage.status, 2);

    // `--dry-run` is read-only, so it stays available non-interactively and
    // still creates nothing.
    const planned = await runCliInProcess(['activate', 'T-001', '--dry-run', '--target', fixture.root], {
      isTTY: false, stdinIsTTY: false, ci: false,
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /Dry run: no activation grant was created/);
    assert.equal(existsSync(operatorActivationKeyPath(fixture.root, fixture.operatorActivationRoot)), false);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('refuses to run under CI', async () => {
    const fixture = await scaffoldFixture('activate-ci');
    const result = await runCliInProcess(['activate', 'T-001', '--json', '--target', fixture.root], {
      isTTY: true,
      stdinIsTTY: true,
      ci: true,
      promptFactory: scriptedPromptFactory([OPERATOR_CONFIRMATION_PHRASE]),
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /refuses to run under CI/);
  });

  it('creates nothing when the operator does not type the exact phrase', async () => {
    const fixture = await scaffoldFixture('activate-cancel');
    const result = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture, ['y'])
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Activation cancelled/);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('shows the exact scope before asking and writes nothing on --dry-run', async () => {
    const fixture = await scaffoldFixture('activate-dry');
    const result = await runCliInProcess(
      ['activate', 'T-001', '--dry-run', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /contract digest: sha256:v1:[a-f0-9]{64}/);
    assert.match(result.stdout, /carrier:\s+\.agenticloop\/tasks\/T-001\.md/);
    assert.match(result.stdout, /resulting activation assurance: operator_confirmed/);
    assert.match(result.stdout, /Dry run: no activation grant was created/);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('activates an existing files task and makes it dispatchable in standard mode', async () => {
    const fixture = await scaffoldFixture('activate-files');
    // Before activation, dispatch is blocked and names the exact repair command.
    const blocked = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /npx agenticloop activate T-001/);

    const activated = await runCliInProcess(
      ['activate', 'T-001', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const report = JSON.parse(activated.stdout);
    assert.equal(report.assurance.activation, 'operator_confirmed');
    assert.equal(report.assurance.mode, 'standard');
    assert.equal(report.assurance.minimumReturn, 'session_reported');
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].taskId, 'T-001');
    assert.equal(report.tasks[0].contractDigest, fixture.contractDigest);
    assert.equal(report.tasks[0].derivation, 'direct_operator_confirmation');
    assert.ok(report.assurance.limitations.includes(ACTIVATION_ASSURANCE_LIMITATIONS.operator_confirmed));

    // The task record itself was never rewritten: no active activation
    // frontmatter appeared (the template's commented placeholders remain).
    const body = readFileSync(fixture.taskPath, 'utf8');
    assert.equal(/^activation_input_digest:/m.test(body), false);
    assert.equal(/^activation_capture_ref:/m.test(body), false);
    assert.equal(taskContractDigest(body).digest, fixture.contractDigest);

    const dispatched = await runPrepareDispatch(fixture);
    assert.equal(dispatched.status, 0, `${dispatched.stdout}\n${dispatched.stderr}`);
    // Criterion: the dispatch output states both grades truthfully.
    assert.match(dispatched.stderr, /^activation: operator_confirmed/m);
    assert.match(dispatched.stderr, /^return:\s+session_reported/m);
    assert.match(dispatched.stderr, /not an isolated host signer/);
    const packet = JSON.parse(dispatched.stdout);
    assert.equal(packet.activation, null);
    assert.equal(packet.activationBinding.grant.assurance, 'operator_confirmed');
    assert.equal(packet.activationBinding.binding.derivation, 'direct_operator_confirmation');
    assert.equal(packet.activationBinding.binding.taskContractDigest, fixture.contractDigest);
    assert.ok(packet.activationBinding.grant.authentication.value);
    assert.ok(packet.activationBinding.binding.authentication.value);
    assert.equal(packet.returnAdapter, null);
    assert.equal(packet.assurance.activation, 'operator_confirmed');
    assert.equal(packet.assurance.activationSource, 'activation_grant');
    assert.equal(packet.assurance.mode, 'standard');
    assert.equal(packet.assurance.minimumReturn, 'session_reported');
    assert.equal(packet.task.activationDigest, null);
    assert.equal(packet.task.activationCaptureRef, null);

    const forged = structuredClone(packet);
    forged.activationBinding.grant.evidence.scopeSummaryDigest = `sha256:${'f'.repeat(64)}`;
    forged.activationBinding.grant.digest = activationGrantDigest(forged.activationBinding.grant);
    forged.activationBinding.binding.grantDigest = forged.activationBinding.grant.digest;
    forged.activationBinding.binding.digest = taskActivationBindingDigest(forged.activationBinding.binding);
    forged.digest = dispatchPreparationDigest(forged);
    const forgedValidation = validateDispatchPreparation(forged, {
      resolveActivationBinding: candidate => resolvePacketActivationBinding(fixture.root, {
        operatorTrustRoot: fixture.operatorTrustRoot,
        operatorActivationRoot: fixture.operatorActivationRoot,
      }, candidate),
    });
    assert.equal(forgedValidation.ok, false);
    assert.match(forgedValidation.errors.join('\n'), /signature|producer must equal|does not verify/);
  });

  it('activates several tasks under one confirmation', async () => {
    const fixture = await scaffoldFixture('activate-multi');
    writeSecondTask(fixture, 'T-002');
    const activated = await runCliInProcess(
      ['activate', 'T-001', 'T-002', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const report = JSON.parse(activated.stdout);
    assert.deepEqual(report.tasks.map(task => task.taskId).sort(), ['T-001', 'T-002']);
    assert.equal(new Set(report.tasks.map(() => report.grantId)).size, 1);
  });

  it('produces no partial authority when one task in the set does not resolve', async () => {
    const fixture = await scaffoldFixture('activate-partial');
    const activated = await runCliInProcess(
      ['activate', 'T-001', 'T-404', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 1);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('invalidates a binding when the task contract changes', async () => {
    const fixture = await scaffoldFixture('activate-contract-change');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const priorDigest = fixture.contractDigest;
    const body = readFileSync(fixture.taskPath, 'utf8').replace('## Scope', '## Scope\n\nExpanded scope line.');
    writeFileSync(fixture.taskPath, body, 'utf8');
    git(fixture.root, ['add', '.agenticloop/tasks/T-001.md']);
    git(fixture.root, ['commit', '-m', 'change contract\n\nTask: T-001\nAgent: maintainer']);
    await correctContract(fixture, priorDigest, 'expand scope');
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /task contract changed after activation/);
  });

  it('refuses a hand-authored target-local grant that is internally self-consistent', async () => {
    const fixture = await scaffoldFixture('activate-forged');
    const repositoryIdentity = targetRepositoryIdentity(fixture.root);
    const grant = grantFor({
      repositoryIdentity,
      scope: { type: 'exact_tasks', taskIds: ['T-001'] },
    });
    // A "signature" the forger can author, over a digest that really matches.
    const forgedGrant = { ...grant, authentication: { algorithm: 'ed25519', keyId: 'operator-deadbeefdeadbeef', value: `ed25519:${Buffer.alloc(64).toString('base64')}` } };
    const binding = createTaskActivationBinding({
      grant: forgedGrant,
      backend: 'files',
      taskId: 'T-001',
      carrier: '.agenticloop/tasks/T-001.md',
      taskContractDigest: fixture.contractDigest,
      derivation: 'direct_operator_confirmation',
    });
    const forgedBinding = { ...binding, authentication: { algorithm: 'ed25519', keyId: 'operator-deadbeefdeadbeef', value: `ed25519:${Buffer.alloc(64).toString('base64')}` } };
    mkdirSync(join(fixture.root, ACTIVATION_STORE_ROOT, 'grants'), { recursive: true });
    mkdirSync(join(fixture.root, ACTIVATION_STORE_ROOT, 'bindings'), { recursive: true });
    writeFileSync(join(fixture.root, grantRecordPath(forgedGrant.grantId)), JSON.stringify(forgedGrant, null, 2), 'utf8');
    writeFileSync(join(fixture.root, bindingRecordPath('files', 'T-001')), JSON.stringify(forgedBinding, null, 2), 'utf8');
    // The record is self-consistent; only the external key can refute it.
    assert.equal(validateActivationGrantShape(forgedGrant).ok, true);
    assert.equal(validateTaskActivationBindingShape(forgedBinding).ok, true);

    const prepared = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(prepared.status, 1);
    assert.match(prepared.stdout, /unauthenticated|does not verify/);
  });

  it('blocks dispatch after the grant is revoked', async () => {
    const fixture = await scaffoldFixture('activate-revoke');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    const grantId = JSON.parse(activated.stdout).grantId;
    const revoked = await runCliInProcess(['activation', 'revoke', grantId, '--json', '--target', fixture.root], {
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(revoked.status, 0, revoked.stderr);
    const status = await runCliInProcess(['activation', 'status', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /was revoked/);
    rmSync(join(fixture.root, ACTIVATION_STORE_ROOT, 'revocations'), { recursive: true, force: true });
    const stillBlocked = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(stillBlocked.status, 1);
    assert.match(stillBlocked.stdout, /was revoked/);
  });

  it('refuses operator-confirmed activation under a hardened operator pin', async () => {
    const fixture = await scaffoldFixture('activate-hardened');
    mkdirSync(fixture.operatorActivationRoot, { recursive: true });
    writeFileSync(activationPolicyPinPath(fixture.root, fixture.operatorActivationRoot), JSON.stringify({
      kind: 'agenticloop.activation-policy-pin',
      schemaVersion: 1,
      target: { repositoryIdentity: targetRepositoryIdentity(fixture.root) },
      mode: 'hardened',
    }), 'utf8');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    // The grant is created honestly, and the command says plainly that it will
    // not authorize dispatch here.
    assert.equal(activated.status, 0, activated.stderr);
    assert.match(activated.stderr, /hardened mode, which requires host_signed activation/);
    const prepared = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(prepared.status, 1);
    assert.match(prepared.stdout, /below the effective minimum 'host_signed'/);
  });

  it('leaves every shipped adapter unsupported and unpromotable', async () => {
    const fixture = await scaffoldFixture('activate-adapters');
    await runCliInProcess(['activate', 'T-001', '--target', fixture.root], interactiveOptions(fixture));
    for (const [adapterId, entry] of Object.entries(SHIPPED_ACTIVATION_ADAPTERS)) {
      assert.equal(entry.captureCapability, 'unsupported', adapterId);
      assert.equal(entry.trustedAdapter, null, adapterId);
    }
    const promoted = activationCapabilityInventory({
      'opencode.command.positional.v1': { capabilities: { activationCapture: 'supported' } },
    });
    assert.equal(promoted['opencode.command.positional.v1'].captureCapability, 'unsupported');
  });
});

describe('agenticloop activate on the GitHub backend', () => {
  /**
   * A GitHub-backed project whose one task lives in an issue body. Only the
   * read-only issue transport is injected; nothing writes to GitHub.
   */
  async function githubFixture(name) {
    const fixture = await scaffoldFixture(name);
    const body = readFileSync(fixture.taskPath, 'utf8');
    writeFileSync(
      join(fixture.root, '.agenticloop', 'project.md'),
      readFileSync(join(fixture.root, '.agenticloop', 'project.md'), 'utf8')
        .replace(/task_backend:\s*\w+/, 'task_backend: github'),
      'utf8'
    );
    const issue = { number: 71, state: 'open', title: 'T-001 Dispatch envelope fixture', body, labels: [] };
    const ghCommandRunner = (_command, args) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ nameWithOwner: 'owner/repository' }) };
      }
      if (args[0] === 'api' && args.includes('--paginate')) {
        return { status: 0, stderr: '', stdout: JSON.stringify([[issue]]) };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stderr: '', stdout: JSON.stringify(issue) };
      }
      return { status: 1, stdout: '', stderr: `unexpected gh invocation: ${args.join(' ')}` };
    };
    return { ...fixture, ghCommandRunner, issue };
  }

  it('activates an existing GitHub task by its canonical identity and digest', async () => {
    const fixture = await githubFixture('activate-github');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--json', '--target', fixture.root],
      { ...interactiveOptions(fixture), ghCommandRunner: fixture.ghCommandRunner }
    );
    assert.equal(activated.status, 0, `${activated.stdout}\n${activated.stderr}`);
    const report = JSON.parse(activated.stdout);
    assert.equal(report.backend, 'github');
    assert.equal(report.tasks[0].taskId, 'T-001');
    assert.equal(report.tasks[0].carrier, 'issue:71');
    assert.equal(report.tasks[0].contractDigest, fixture.contractDigest);
    assert.equal(report.assurance.activation, 'operator_confirmed');
    // The binding is stored under the github-qualified deterministic name, so
    // a files binding for the same task id can never satisfy a GitHub dispatch.
    assert.equal(existsSync(join(fixture.root, bindingRecordPath('github', 'T-001'))), true);
    assert.equal(existsSync(join(fixture.root, bindingRecordPath('files', 'T-001'))), false);
  });

  it('refuses a task the authoritative GitHub inventory does not resolve', async () => {
    const fixture = await githubFixture('activate-github-missing');
    const activated = await runCliInProcess(
      ['activate', 'T-404', '--json', '--target', fixture.root],
      { ...interactiveOptions(fixture), ghCommandRunner: fixture.ghCommandRunner }
    );
    assert.equal(activated.status, 1);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });
});

describe('work-unit activation from committed decomposition', () => {
  it('derives a child binding only from the canonical ready set', async () => {
    const fixture = await scaffoldFixture('activate-work-unit');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'fixture-work-unit', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, `${activated.stdout}\n${activated.stderr}`);
    const report = JSON.parse(activated.stdout);
    assert.equal(report.scopeType, 'work_unit');
    assert.equal(report.workUnitId, 'fixture-work-unit');
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].derivation, 'committed_decomposition_membership');

    const packet = await prepareThroughCli(fixture);
    assert.equal(packet.activationBinding.binding.derivation, 'committed_decomposition_membership');
    assert.equal(packet.activationBinding.grant.scope.type, 'work_unit');
    assert.equal(packet.activationBinding.grant.workUnitId, 'fixture-work-unit');
    assert.equal(packet.assurance.activationDerivation, 'committed_decomposition_membership');
  });

  it('refuses a work unit with no committed decomposition source', async () => {
    const fixture = await scaffoldFixture('activate-work-unit-missing');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'no-such-work-unit', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 1);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('invalidates a derived binding when the committed decomposition changes', async () => {
    const fixture = await scaffoldFixture('activate-work-unit-changed');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'fixture-work-unit', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const sourcePath = join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json');
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    source.observedAt = new Date(Date.parse(source.observedAt) + 1000).toISOString();
    writeFileSync(sourcePath, JSON.stringify(source, null, 2), 'utf8');
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /decomposition/);
  });

  it('invalidates a derived binding when the committed decomposition is removed', async () => {
    const fixture = await scaffoldFixture('activate-work-unit-removed');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'fixture-work-unit', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    rmSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'));
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /requires current committed decomposition evidence/);
  });

  it('never lets a work-unit grant authorize a task outside its ready set', () => {
    const grant = grantFor({ scope: { type: 'work_unit', workUnitId: 'wu-1' } });
    const binding = bindingFor(grant, {
      taskId: 'T-999',
      carrier: '.agenticloop/tasks/T-999.md',
      derivation: 'committed_decomposition_membership',
      decompositionSource: {
        sourceRef: '.agenticloop/decompositions/T-001.json',
        sourceDigest: sha256('source'),
        scanSemanticDigest: `sha256:agenticloop.parallel-scan.v1:${'d'.repeat(64)}`,
        workUnitId: 'wu-1',
        observedAt: '2026-08-09T00:00:00.000Z',
      },
    });
    const resolved = resolveTaskActivationBinding({
      grant: { ...grant, authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } },
      binding: { ...binding, authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } },
      repositoryIdentity: REPOSITORY,
      backend: 'files',
      taskId: 'T-999',
      carrier: '.agenticloop/tasks/T-999.md',
      taskContractDigest: CONTRACT_DIGEST,
      verifySignature: () => true,
      decomposition: {
        kind: 'agenticloop.decomposition-provenance',
        authority: 'maintainer',
        source: 'task-decomposition',
        sourceRef: '.agenticloop/decompositions/T-001.json',
        sourceDigest: sha256('source'),
        observedAt: '2026-08-09T00:00:00.000Z',
        scan: {
          semanticDigest: `sha256:agenticloop.parallel-scan.v1:${'d'.repeat(64)}`,
          workUnit: { id: 'wu-1' },
          inventory: { complete: true },
          decomposition: { state: 'complete' },
          readyTaskIds: ['T-001'],
        },
      },
    });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => /not a member of the canonical decomposition ready set/.test(item.message)));
  });
});

describe('hardened mode', () => {
  it('accepts host-signed activation and reports the hardened minimums', async () => {
    const fixture = await createDispatchFixture(temp, 'hardened-host-signed');
    const prepared = prepareRoleDispatch(fixture, {
      ...fixture.options,
      assurancePolicy: { mode: 'hardened', policySource: 'operator_pin' },
    });
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.assurance.mode, 'hardened');
    assert.equal(prepared.packet.assurance.policySource, 'operator_pin');
    assert.equal(prepared.packet.assurance.activation, 'host_signed');
    assert.equal(prepared.packet.assurance.minimumActivation, 'host_signed');
    assert.equal(prepared.packet.assurance.minimumReturn, 'host_receipt');
    assert.ok(prepared.packet.assurance.limitations.includes(RETURN_ASSURANCE_LIMITATIONS.host_receipt));
    assert.equal(
      prepared.packet.assurance.limitations.some(item => /NOT host-authenticated/.test(item)),
      false
    );
  });

  it('refuses an operator-confirmed grant under a hardened packet policy', async () => {
    const fixture = await scaffoldFixture('hardened-operator-confirmed');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const evidence = loadTaskActivationEvidence(fixture.root, { backend: 'files', taskId: 'T-001' });
    const verification = resolveActivationVerification(fixture.root, {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const prepared = prepareRoleDispatch({
      ...fixture,
      activation: undefined,
      refetchActivationEvidence: () => evidence,
    }, {
      capabilities: fixture.options.capabilities,
      verifyActivationSignature: verification.verify,
      assurancePolicy: { mode: 'hardened', policySource: 'operator_pin' },
    });
    assert.equal(prepared.ok, false);
    assert.match(prepared.validation.errors.join('\n'), /below the effective minimum 'host_signed'/);
    assert.equal(prepared.validation.disposition, 'blocked');
  });
});

describe('legacy activation compatibility', () => {
  it('keeps a host-signed v2 capture working with no activation grant present', async () => {
    const fixture = await createDispatchFixture(temp, 'legacy-capture');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.activationBinding, null);
    assert.equal(prepared.packet.assurance.activation, 'host_signed');
    assert.equal(prepared.packet.assurance.activationSource, 'legacy_task_capture');
    assert.equal(prepared.packet.assurance.activationDerivation, 'legacy_task_capture');
    assert.match(prepared.packet.task.activationDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(prepared.packet.task.activationCaptureRef, '.agenticloop/activation/T-001.json');
    assert.ok(prepared.packet.assurance.limitations.includes(ACTIVATION_ASSURANCE_LIMITATIONS.host_signed));
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function writeSecondTask(fixture, taskId) {
  const body = readFileSync(fixture.taskPath, 'utf8').replaceAll('T-001', taskId);
  writeFileSync(join(fixture.root, '.agenticloop', 'tasks', `${taskId}.md`), body, 'utf8');
  git(fixture.root, ['add', `.agenticloop/tasks/${taskId}.md`]);
  git(fixture.root, ['commit', '-m', `record ${taskId}\n\nTask: ${taskId}\nAgent: maintainer`]);
}

/** Write the fixture's own dispatch input beside the target. */
function writeDispatchInput(fixture) {
  writeFileSync(
    join(fixture.root, 'dispatch-input.json'),
    JSON.stringify({
      readiness: fixture.readiness,
      decomposition: fixture.decomposition,
      assignment: fixture.assignment,
    }, null, 2),
    'utf8'
  );
}

/** Run the real `task prepare-dispatch` command against the fixture. */
function runPrepareDispatch(fixture, extraArgs = []) {
  writeDispatchInput(fixture);
  return runCliInProcess([
    'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--target', fixture.root, ...extraArgs,
  ], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: fixture.operatorActivationRoot,
  });
}

/** Run `task prepare-dispatch` and return the emitted packet. */
async function prepareThroughCli(fixture) {
  const result = await runPrepareDispatch(fixture);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
