import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authorizeBlockedResultRecovery,
  authorizeBlockedResultResume,
  createBlockedResultRedelegation,
  createHumanDisposition,
  humanDispositionDigest,
  validateHumanDisposition,
} from '../src/blocked-result-authority.js';
import { createRoleReturn } from '../src/dispatch-envelope.js';
import { generateHostSigningKey } from '../src/host-trust.js';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const LATER = '2099-07-30T13:00:00.000Z';
const FULL_SHA_A = '1111111111111111111111111111111111111111';
const FULL_SHA_B = '2222222222222222222222222222222222222222';
const RETURN_INVALIDATORS = [
  'task_or_contract_changes',
  'packet_or_assignment_changes',
  'branch_or_head_changes',
  'check_or_transport_evidence_changes',
  'initial_repository_state_changes',
];

function authorityFixture(authorityId, authorityKind, keyId) {
  const signingKey = generateHostSigningKey();
  return {
    trusted: {
      authorityId,
      authorityKind,
      keyId,
      algorithm: 'ed25519',
      publicKey: signingKey.publicKey,
      issuer: authorityKind === 'blocked_result_redelegation'
        ? { ownerKind: 'workflow_role', ownerId: 'orchestrator' }
        : { ownerKind: 'human_authority', ownerId: 'human_authority' },
      revokedRecordIds: [],
    },
    signing: {
      authorityId,
      keyId,
      privateKey: signingKey.privateKey,
    },
  };
}

const REDELEGATION_TRUST = authorityFixture(
  'agenticloop.test.orchestrator',
  'blocked_result_redelegation',
  'orchestrator-authority-1'
);
const HUMAN_TRUST = authorityFixture(
  'agenticloop.test.human',
  'human_disposition',
  'human-authority-1'
);
const resolveTrustedAuthority = authorityId => {
  if (authorityId === REDELEGATION_TRUST.trusted.authorityId) return REDELEGATION_TRUST.trusted;
  if (authorityId === HUMAN_TRUST.trusted.authorityId) return HUMAN_TRUST.trusted;
  throw new Error(`authority '${String(authorityId)}' is not pinned`);
};

function blockedReturn() {
  return createRoleReturn({
    producerRole: 'engineer',
    packet: {
      packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
      digest: `sha256:agenticloop.role-preparation.v4:${'1'.repeat(64)}`,
    },
    task: {
      backend: 'files',
      id: 'T-001',
      taskContractDigest: `sha256:v1:${'2'.repeat(64)}`,
      dispatchCarrierDigest: `sha256:${'3'.repeat(64)}`,
      currentCarrierDigest: `sha256:${'3'.repeat(64)}`,
    },
    worktree: 'C:\\target',
    branch: 'task/T-001',
    productBaseHead: FULL_SHA_A,
    productHead: FULL_SHA_B,
    workflowHead: FULL_SHA_B,
    candidateHead: null,
    productChangedPaths: [],
    workflowChangedPaths: [],
    checks: [{
      id: 'RC-1',
      kind: 'command',
      command: 'npm test',
      outcome: 'blocked',
      exitCode: 1,
      evidence: 'host state prevents execution',
      executionEvidence: null,
    }],
    productAttribution: {
      range: { base: FULL_SHA_A, head: FULL_SHA_B },
      commits: [FULL_SHA_B],
    },
    carrierLineage: {
      dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'4'.repeat(64)}`,
      evidenceMutationReceiptDigests: [],
    },
    pr: { state: 'not_applicable', number: null, url: null },
    outcome: {
      kind: 'implementation_blocked',
      completion: false,
      authority: 'non_authoritative_role_outcome',
    },
    disposition: 'blocked',
    blocker: {
      category: 'host_state',
      evidence: { kind: 'command_failure', detail: 'sandbox mount is read-only' },
      resumeOwner: 'engineer',
      resumeTransition: 'implementation_resume',
      resumePreconditions: { items: ['Restore the task worktree write mount.'], justification: null },
    },
    freshness: { invalidatedBy: RETURN_INVALIDATORS },
  });
}

function recovery(overrides = {}) {
  return {
    identity: 'repair:task-worktree-mount',
    class: 'host_state_repair',
    scope: [],
    hostState: ['worktree:C:\\target:write-mount'],
    ...overrides,
  };
}

function disposition(returned, requestedRecovery = recovery()) {
  return createHumanDisposition({
    blockedReturn: returned,
    recovery: requestedRecovery,
    human: {
      actor: 'Repository Owner',
      authorityReference: 'approval:P35-fixture-1',
    },
    reason: 'Restore the exact task worktree mount and make no source changes.',
    issuedAt: '2026-07-30T12:00:00.000Z',
    expiresAt: LATER,
    result: { ownerRole: 'engineer', nextTransition: 'implementation_resume' },
  }, HUMAN_TRUST.signing);
}

function redelegation(returned, overrides = {}, signing = REDELEGATION_TRUST.signing) {
  return createBlockedResultRedelegation({
    blockedReturn: returned,
    toRole: 'maintainer',
    authority: {
      ownerKind: 'workflow_role',
      ownerId: 'orchestrator',
      reference: 'dispatch:redelegate:T-001',
    },
    reason: 'Maintainer must repair the task contract before implementation resumes.',
    issuedAt: '2026-07-30T12:00:00.000Z',
    expiresAt: LATER,
    ...overrides,
  }, signing);
}

describe('blocked-result ownership', () => {
  it('retains the producing role on normal resume and requires typed authority for transfer', () => {
    const returned = blockedReturn();
    const retained = authorizeBlockedResultResume({
      blockedReturn: returned,
      requestedOwner: 'engineer',
      now: NOW,
    });
    assert.equal(retained.ok, true);
    assert.equal(retained.value.redelegated, false);
    assert.equal(retained.value.ownerRole, 'engineer');

    const transfer = authorizeBlockedResultResume({
      blockedReturn: returned,
      requestedOwner: 'maintainer',
      now: NOW,
    });
    assert.equal(transfer.ok, false);
    assert.equal(transfer.value, null);
    assert.equal(transfer.validation.diagnostics[0].code, 'blocked_result.redelegation_required');
  });

  it('permits only an exact, fresh redelegation bound to the blocked return and packet', () => {
    const returned = blockedReturn();
    const authority = redelegation(returned);
    const authorized = authorizeBlockedResultResume({
      blockedReturn: returned,
      requestedOwner: 'maintainer',
      redelegationAuthority: authority,
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.value.ownerRole, 'maintainer');
    assert.equal(authorized.value.redelegated, true);

    const stale = authorizeBlockedResultResume({
      blockedReturn: returned,
      requestedOwner: 'maintainer',
      redelegationAuthority: authority,
      resolveTrustedAuthority,
      now: Date.parse('2100-01-01T00:00:00.000Z'),
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.validation.diagnostics[0].code, 'blocked_result.redelegation_stale');

    const otherReturn = blockedReturn();
    const crossReturn = authorizeBlockedResultResume({
      blockedReturn: otherReturn,
      requestedOwner: 'maintainer',
      redelegationAuthority: authority,
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(crossReturn.ok, false);
    assert.equal(crossReturn.validation.diagnostics[0].code, 'blocked_result.redelegation_invalid');
  });

  it('rejects a self-minted redelegation even when its semantic digest is self-consistent', () => {
    const returned = blockedReturn();
    const rogueKey = generateHostSigningKey();
    const selfMinted = redelegation(returned, {}, {
      authorityId: REDELEGATION_TRUST.trusted.authorityId,
      keyId: REDELEGATION_TRUST.trusted.keyId,
      privateKey: rogueKey.privateKey,
    });
    const denied = authorizeBlockedResultResume({
      blockedReturn: returned,
      requestedOwner: 'maintainer',
      redelegationAuthority: selfMinted,
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.validation.diagnostics[0].code, 'blocked_result.redelegation_untrusted');

    const forgedAndExpired = authorizeBlockedResultResume({
      blockedReturn: returned,
      requestedOwner: 'maintainer',
      redelegationAuthority: selfMinted,
      resolveTrustedAuthority,
      now: Date.parse('2100-01-01T00:00:00.000Z'),
    });
    assert.equal(forgedAndExpired.ok, false);
    assert.equal(
      forgedAndExpired.validation.diagnostics[0].code,
      'blocked_result.redelegation_untrusted'
    );
    assert.equal(forgedAndExpired.validation.evidenceState, 'negative');
  });
});

describe('typed human disposition', () => {
  it('keeps destructive, scope-changing, and host-state repair blocked without human authority', () => {
    const returned = blockedReturn();
    for (const recoveryClass of ['destructive', 'scope_changing', 'host_state_repair']) {
      const requested = recoveryClass === 'host_state_repair'
        ? recovery()
        : recovery({
          identity: `repair:${recoveryClass}`,
          class: recoveryClass,
          scope: ['src/generated/**'],
          hostState: [],
        });
      const denied = authorizeBlockedResultRecovery({
        blockedReturn: returned,
        recovery: requested,
        now: NOW,
      });
      assert.equal(denied.ok, false);
      assert.equal(denied.validation.diagnostics[0].code, 'human_disposition.required');
    }
  });

  it('authorizes only the exact bound recovery and preserves human attribution', () => {
    const returned = blockedReturn();
    const requested = recovery();
    const human = disposition(returned, requested);
    const authorized = authorizeBlockedResultRecovery({
      blockedReturn: returned,
      recovery: requested,
      humanDisposition: human,
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(authorized.ok, true);
    assert.deepEqual(authorized.value.attribution, {
      ownerKind: 'human_actor',
      actor: 'Repository Owner',
    });
    assert.equal(authorized.value.authority.ownerKind, 'human_authority');
    assert.equal(authorized.value.ownerRole, 'engineer');

    const wrongScope = authorizeBlockedResultRecovery({
      blockedReturn: returned,
      recovery: recovery({ hostState: ['different-host-state'] }),
      humanDisposition: human,
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(wrongScope.ok, false);
    assert.equal(wrongScope.validation.diagnostics[0].code, 'human_disposition.invalid');
  });

  it('rejects stale, cross-return, unknown-field, and fabricated role-attribution dispositions', () => {
    const returned = blockedReturn();
    const valid = disposition(returned);
    const stale = authorizeBlockedResultRecovery({
      blockedReturn: returned,
      recovery: recovery(),
      humanDisposition: valid,
      resolveTrustedAuthority,
      now: Date.parse('2100-07-30T14:00:00.000Z'),
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.validation.diagnostics[0].code, 'human_disposition.stale');

    const otherReturn = blockedReturn();
    assert.equal(validateHumanDisposition(valid, {
      blockedReturn: otherReturn,
      requestedRecovery: recovery(),
      resolveTrustedAuthority,
      now: NOW,
    }).ok, false);

    const extra = { ...structuredClone(valid), unexpected: true };
    assert.equal(validateHumanDisposition(extra, {
      blockedReturn: returned,
      requestedRecovery: recovery(),
      resolveTrustedAuthority,
      now: NOW,
    }).ok, false);

    const fabricated = structuredClone(valid);
    fabricated.human.actor = 'engineer';
    fabricated.attribution.actor = 'engineer';
    fabricated.digest = humanDispositionDigest(fabricated);
    const checked = validateHumanDisposition(fabricated, {
      blockedReturn: returned,
      requestedRecovery: recovery(),
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /cannot fabricate a workflow role/);
  });

  it('rejects a self-minted human disposition and a trusted but revoked disposition', () => {
    const returned = blockedReturn();
    const rogueKey = generateHostSigningKey();
    const selfMinted = createHumanDisposition({
      blockedReturn: returned,
      recovery: recovery(),
      human: {
        actor: 'Repository Owner',
        authorityReference: 'approval:P35-fixture-rogue',
      },
      reason: 'Attempt to mint authority inside the workflow process.',
      issuedAt: '2026-07-30T12:00:00.000Z',
      expiresAt: LATER,
      result: { ownerRole: 'engineer', nextTransition: 'implementation_resume' },
    }, {
      authorityId: HUMAN_TRUST.trusted.authorityId,
      keyId: HUMAN_TRUST.trusted.keyId,
      privateKey: rogueKey.privateKey,
    });
    const forged = authorizeBlockedResultRecovery({
      blockedReturn: returned,
      recovery: recovery(),
      humanDisposition: selfMinted,
      resolveTrustedAuthority,
      now: NOW,
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.validation.diagnostics[0].code, 'human_disposition.untrusted');

    const forgedAndExpired = authorizeBlockedResultRecovery({
      blockedReturn: returned,
      recovery: recovery(),
      humanDisposition: selfMinted,
      resolveTrustedAuthority,
      now: Date.parse('2100-01-01T00:00:00.000Z'),
    });
    assert.equal(forgedAndExpired.ok, false);
    assert.equal(
      forgedAndExpired.validation.diagnostics[0].code,
      'human_disposition.untrusted'
    );
    assert.equal(forgedAndExpired.validation.evidenceState, 'negative');

    const valid = disposition(returned);
    const revoked = authorizeBlockedResultRecovery({
      blockedReturn: returned,
      recovery: recovery(),
      humanDisposition: valid,
      resolveTrustedAuthority: authorityId => ({
        ...resolveTrustedAuthority(authorityId),
        revokedRecordIds: [valid.dispositionId],
      }),
      now: NOW,
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.validation.diagnostics[0].code, 'human_disposition.untrusted');
  });
});
