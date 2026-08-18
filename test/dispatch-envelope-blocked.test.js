import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createRoleReturn,
  dispatchPreparationDigest,
  receiveRoleReturn,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import { generateHostSigningKey } from '../src/host-trust.js';
import {
  createBlockedResultRedelegation,
  createHumanDisposition,
} from '../src/blocked-result-authority.js';
import {
  createDispatchFixture,
  prepare,
  producerBinding,
} from './helpers/dispatch-fixture.js';

let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

// Read-only tests share one fixture; tests that commit or write into the
// repository build their own.
let sharedTask;
const sharedFilesTask = () => (sharedTask ??= createDispatchFixture(temp, 'shared'));

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-blocked-')); });
after(() => rmSync(temp, { recursive: true, force: true }));
function blockedRuntimeReturn(packet) {
  const checks = [
    {
      id: 'RC-1',
      kind: 'command',
      command: 'npm test',
      outcome: 'blocked',
      exitCode: 1,
      evidence: 'host state prevents execution',
      executionEvidence: null,
    },
    {
      id: 'RC-2',
      kind: 'command',
      command: 'npm run typecheck',
      outcome: 'blocked',
      exitCode: 1,
      evidence: 'host state prevents execution',
      executionEvidence: null,
    },
  ];
  const evidence = {
    backend: packet.backend,
    task: {
      id: packet.task.id,
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      currentCarrierDigest: packet.task.dispatchCarrierDigest,
    },
    worktree: packet.assignment.worktree,
    branch: packet.assignment.branch,
    productBaseHead: packet.repository.head,
    productLineage: null,
    productHead: packet.repository.head,
    workflowHead: packet.repository.head,
    candidateHead: null,
    productChangedPaths: [],
    workflowChangedPaths: [],
    productAttribution: {
      range: { base: packet.repository.head, head: packet.repository.head },
      commits: [],
    },
    checks: checks.map(({ executionEvidence: _executionEvidence, ...check }) => check),
    carrierLineage: {
      dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}`,
      evidenceMutationReceiptDigests: [],
    },
    pr: { state: 'not_applicable', number: null, url: null },
  };
  const roleReturn = createRoleReturn({
    producerRole: 'engineer',
    packet: { packetId: packet.packetId, digest: packet.digest },
    task: { backend: packet.backend, ...evidence.task },
    worktree: evidence.worktree,
    branch: evidence.branch,
    productBaseHead: evidence.productBaseHead,
    productHead: evidence.productHead,
    workflowHead: evidence.workflowHead,
    candidateHead: evidence.candidateHead,
    productChangedPaths: evidence.productChangedPaths,
    workflowChangedPaths: evidence.workflowChangedPaths,
    checks,
    productAttribution: evidence.productAttribution,
    carrierLineage: evidence.carrierLineage,
    pr: evidence.pr,
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
      resumePreconditions: {
        items: ['Restore the task worktree write mount.'],
        justification: null,
      },
    },
    freshness: {
      invalidatedBy: [
        'task_or_contract_changes',
        'packet_or_assignment_changes',
        'branch_or_head_changes',
        'check_or_transport_evidence_changes',
        'initial_repository_state_changes',
      ],
    },
  });
  return { roleReturn, evidence };
}

describe('authoritative blocked-return receive path', () => {
  it('binds degraded reports into dispatch and consumes them at role-return receive', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.ok(prepared.packet.assignment.degradedEnforcementReports.length > 0);
    assert.ok(prepared.packet.assignment.degradedEnforcementReports.every(report =>
      report.diagnosticCode === 'capability.enforcement.degraded' &&
      report.declarationDigest === prepared.packet.assignment.hostRoleCapability.digest
    ));
    // Each report pins its declaration rather than restating it, and the
    // declaration it pins is carried once in the same packet.
    assert.equal(prepared.packet.assignment.hostRoleCapability.detectionBoundary, 'role_return_receive');
    for (const report of prepared.packet.assignment.degradedEnforcementReports) {
      for (const field of ['limitation', 'detectionBoundary', 'recoveryRoute']) {
        assert.equal(Object.hasOwn(report, field), false, `report must not restate '${field}'`);
      }
    }
    // The rendered warning still names the boundary and the recovery route,
    // resolved from the pinned declaration.
    const degradedWarning = prepared.validation.warningDiagnostics.find(diagnostic =>
      diagnostic.code === 'capability.enforcement.degraded'
    );
    assert.ok(degradedWarning);
    assert.equal(degradedWarning.evidence.detectionBoundary, 'role_return_receive');
    assert.match(degradedWarning.message, /role_return_receive must evaluate/);
    assert.match(degradedWarning.message, /Recovery: /);

    const fabricated = structuredClone(prepared.packet);
    fabricated.assignment.degradedEnforcementReports[0].enforcement = 'enforced';
    fabricated.digest = dispatchPreparationDigest(fabricated);
    const rejectedReport = validateDispatchPreparation(fabricated, fixture.options);
    assert.equal(rejectedReport.ok, false);
    assert.ok(rejectedReport.errors.some(error => /degraded-enforcement|capability/i.test(error)));

    const { roleReturn, evidence } = blockedRuntimeReturn(prepared.packet);
    const producer = producerBinding(fixture.trust, prepared.packet, roleReturn, evidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producer,
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
    assert.equal(received.blockedAuthority.ownerRole, 'engineer');
    assert.equal(received.blockedAuthority.redelegated, false);
    assert.ok(received.validation.warningDiagnostics.some(diagnostic =>
      diagnostic.code === 'capability.enforcement.degraded'
    ));
  });

  it('denies owner transfer through the receive edge without exact trusted redelegation', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const { roleReturn, evidence } = blockedRuntimeReturn(prepared.packet);
    const producer = producerBinding(fixture.trust, prepared.packet, roleReturn, evidence);
    const base = {
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producer,
    };
    const missing = receiveRoleReturn({
      ...base,
      requestedOwner: 'maintainer',
    }, fixture.options);
    assert.equal(missing.ok, false);
    assert.equal(missing.validation.diagnostics[0].code, 'blocked_result.redelegation_required');

    const trustedKey = generateHostSigningKey();
    const trustedAuthority = {
      authorityId: 'agenticloop.test.runtime-orchestrator',
      authorityKind: 'blocked_result_redelegation',
      keyId: 'runtime-orchestrator-1',
      algorithm: 'ed25519',
      publicKey: trustedKey.publicKey,
      issuer: { ownerKind: 'workflow_role', ownerId: 'orchestrator' },
      revokedRecordIds: [],
    };
    const authorityInput = {
      authorityId: trustedAuthority.authorityId,
      keyId: trustedAuthority.keyId,
      privateKey: trustedKey.privateKey,
    };
    const redelegation = createBlockedResultRedelegation({
      blockedReturn: roleReturn,
      toRole: 'maintainer',
      authority: {
        ownerKind: 'workflow_role',
        ownerId: 'orchestrator',
        reference: 'dispatch:runtime-redelegate:T-001',
      },
      reason: 'The exact blocked transition now belongs to Maintainer.',
      expiresAt: '2099-07-30T13:00:00.000Z',
    }, authorityInput);
    const permitted = receiveRoleReturn({
      ...base,
      requestedOwner: 'maintainer',
      redelegationAuthority: redelegation,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(permitted.ok, true, permitted.validation.errors?.join('\n'));
    assert.equal(permitted.blockedAuthority.ownerRole, 'maintainer');
    assert.equal(permitted.blockedAuthority.nextTransition, 'implementation_resume');

    const rogueKey = generateHostSigningKey();
    const selfMinted = createBlockedResultRedelegation({
      blockedReturn: roleReturn,
      toRole: 'maintainer',
      authority: {
        ownerKind: 'workflow_role',
        ownerId: 'orchestrator',
        reference: 'dispatch:self-minted:T-001',
      },
      reason: 'Caller-authored authority must not transfer ownership.',
      expiresAt: '2099-07-30T13:00:00.000Z',
    }, {
      authorityId: trustedAuthority.authorityId,
      keyId: trustedAuthority.keyId,
      privateKey: rogueKey.privateKey,
    });
    const forged = receiveRoleReturn({
      ...base,
      requestedOwner: 'maintainer',
      redelegationAuthority: selfMinted,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(forged.ok, false);
    assert.equal(forged.validation.diagnostics[0].code, 'blocked_result.redelegation_untrusted');

    const malformedAuthority = structuredClone(redelegation);
    malformedAuthority.callerApproved = true;
    const malformed = receiveRoleReturn({
      ...base,
      requestedOwner: 'maintainer',
      redelegationAuthority: malformedAuthority,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(malformed.ok, false);

    const revoked = receiveRoleReturn({
      ...base,
      requestedOwner: 'maintainer',
      redelegationAuthority: redelegation,
      resolveTrustedAuthority: () => ({
        ...trustedAuthority,
        revokedRecordIds: [redelegation.authorityId],
      }),
    }, fixture.options);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.validation.diagnostics[0].code, 'blocked_result.redelegation_untrusted');

    const stale = receiveRoleReturn({
      ...base,
      requestedOwner: 'maintainer',
      redelegationAuthority: redelegation,
      resolveTrustedAuthority: () => trustedAuthority,
      now: Date.parse('2100-01-01T00:00:00.000Z'),
    }, fixture.options);
    assert.equal(stale.ok, false);
    assert.equal(stale.validation.evidenceState, 'stale');
    assert.equal(stale.validation.diagnostics[0].code, 'blocked_result.redelegation_stale');

    const otherFixture = await currentFilesTask('blocked-runtime-owner-cross-packet');
    const otherPrepared = prepare(otherFixture);
    const otherBlocked = blockedRuntimeReturn(otherPrepared.packet);
    const crossPacket = receiveRoleReturn({
      raw: JSON.stringify(otherBlocked.roleReturn),
      packet: otherPrepared.packet,
      refetchTask: otherFixture.refetchTask,
      refetchRepositoryEvidence: () => otherBlocked.evidence,
      runGit: otherFixture.runGit,
      ...producerBinding(
        otherFixture.trust,
        otherPrepared.packet,
        otherBlocked.roleReturn,
        otherBlocked.evidence
      ),
      requestedOwner: 'maintainer',
      redelegationAuthority: redelegation,
      resolveTrustedAuthority: () => trustedAuthority,
    }, otherFixture.options);
    assert.equal(crossPacket.ok, false);
    assert.equal(crossPacket.validation.diagnostics[0].code, 'blocked_result.redelegation_invalid');
  });

  it('keeps exceptional recovery blocked until an exact trusted human disposition arrives', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const { roleReturn, evidence } = blockedRuntimeReturn(prepared.packet);
    const producer = producerBinding(fixture.trust, prepared.packet, roleReturn, evidence);
    const recovery = {
      identity: 'repair:task-worktree-mount',
      class: 'host_state_repair',
      scope: [],
      hostState: [`worktree:${prepared.packet.assignment.worktree}:write-mount`],
    };
    const base = {
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      recovery,
      ...producer,
    };
    const missing = receiveRoleReturn(base, fixture.options);
    assert.equal(missing.ok, false);
    assert.equal(missing.validation.diagnostics[0].code, 'human_disposition.required');

    const trustedKey = generateHostSigningKey();
    const trustedAuthority = {
      authorityId: 'agenticloop.test.runtime-human',
      authorityKind: 'human_disposition',
      keyId: 'runtime-human-1',
      algorithm: 'ed25519',
      publicKey: trustedKey.publicKey,
      issuer: { ownerKind: 'human_authority', ownerId: 'human_authority' },
      revokedRecordIds: [],
    };
    const disposition = createHumanDisposition({
      blockedReturn: roleReturn,
      recovery,
      human: {
        actor: 'Repository Owner',
        authorityReference: 'approval:runtime-human-1',
      },
      reason: 'Restore only the exact blocked worktree mount.',
      expiresAt: '2099-07-30T13:00:00.000Z',
      result: { ownerRole: 'engineer', nextTransition: 'implementation_resume' },
    }, {
      authorityId: trustedAuthority.authorityId,
      keyId: trustedAuthority.keyId,
      privateKey: trustedKey.privateKey,
    });
    const permitted = receiveRoleReturn({
      ...base,
      humanDisposition: disposition,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(permitted.ok, true, permitted.validation.errors?.join('\n'));
    assert.deepEqual(permitted.blockedAuthority.attribution, {
      ownerKind: 'human_actor',
      actor: 'Repository Owner',
    });
    assert.notEqual(permitted.blockedAuthority.attribution.actor, 'engineer');

    const wrongRecovery = receiveRoleReturn({
      ...base,
      recovery: { ...recovery, identity: 'repair:different-host-state' },
      humanDisposition: disposition,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(wrongRecovery.ok, false);
    assert.equal(wrongRecovery.validation.diagnostics[0].code, 'human_disposition.invalid');

    const rogueKey = generateHostSigningKey();
    const selfMinted = createHumanDisposition({
      blockedReturn: roleReturn,
      recovery,
      human: {
        actor: 'Repository Owner',
        authorityReference: 'approval:self-minted',
      },
      reason: 'A caller-held key cannot authorize recovery.',
      expiresAt: '2099-07-30T13:00:00.000Z',
      result: { ownerRole: 'engineer', nextTransition: 'implementation_resume' },
    }, {
      authorityId: trustedAuthority.authorityId,
      keyId: trustedAuthority.keyId,
      privateKey: rogueKey.privateKey,
    });
    const forged = receiveRoleReturn({
      ...base,
      humanDisposition: selfMinted,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(forged.ok, false);
    assert.equal(forged.validation.diagnostics[0].code, 'human_disposition.untrusted');

    const revoked = receiveRoleReturn({
      ...base,
      humanDisposition: disposition,
      resolveTrustedAuthority: () => ({
        ...trustedAuthority,
        revokedRecordIds: [disposition.dispositionId],
      }),
    }, fixture.options);
    assert.equal(revoked.ok, false);
    assert.equal(revoked.validation.diagnostics[0].code, 'human_disposition.untrusted');

    const malformedDisposition = structuredClone(disposition);
    malformedDisposition.callerApproved = true;
    const malformed = receiveRoleReturn({
      ...base,
      humanDisposition: malformedDisposition,
      resolveTrustedAuthority: () => trustedAuthority,
    }, fixture.options);
    assert.equal(malformed.ok, false);

    const stale = receiveRoleReturn({
      ...base,
      humanDisposition: disposition,
      resolveTrustedAuthority: () => trustedAuthority,
      now: Date.parse('2100-01-01T00:00:00.000Z'),
    }, fixture.options);
    assert.equal(stale.ok, false);
    assert.equal(stale.validation.diagnostics[0].code, 'human_disposition.stale');

    const otherFixture = await currentFilesTask('blocked-runtime-recovery-cross-return');
    const otherPrepared = prepare(otherFixture);
    const otherBlocked = blockedRuntimeReturn(otherPrepared.packet);
    const crossReturn = receiveRoleReturn({
      raw: JSON.stringify(otherBlocked.roleReturn),
      packet: otherPrepared.packet,
      refetchTask: otherFixture.refetchTask,
      refetchRepositoryEvidence: () => otherBlocked.evidence,
      runGit: otherFixture.runGit,
      recovery,
      humanDisposition: disposition,
      resolveTrustedAuthority: () => trustedAuthority,
      ...producerBinding(
        otherFixture.trust,
        otherPrepared.packet,
        otherBlocked.roleReturn,
        otherBlocked.evidence
      ),
    }, otherFixture.options);
    assert.equal(crossReturn.ok, false);
    assert.equal(crossReturn.validation.diagnostics[0].code, 'human_disposition.invalid');
  });
});
