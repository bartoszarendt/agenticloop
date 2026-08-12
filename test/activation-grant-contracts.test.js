/**
 * Universal, host-neutral activation: grant and task-binding record contracts
 * and binding resolution against current evidence. Pure logic; no filesystem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVATION_ASSURANCE_ORDER,
  CLI_OPERATOR_PRODUCER_ID,
  MAX_GRANT_TTL_SECONDS,
  RETURN_ASSURANCE_ORDER,
  activationAssuranceMeets,
  activationGrantDigest,
  createActivationGrant,
  createActivationRevocation,
  resolveTaskActivationBinding,
  returnAssuranceMeets,
  taskActivationBindingDigest,
  validateActivationGrantShape,
  validateTaskActivationBindingShape,
} from '../src/activation-grant.js';
import { sha256 } from './helpers/dispatch-fixture.js';
import {
  CONTRACT_DIGEST,
  REPOSITORY,
  bindingFor,
  grantFor,
} from './helpers/activation-fixture.js';
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
