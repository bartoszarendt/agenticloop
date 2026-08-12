import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { receiveRoleReturn } from '../src/dispatch-envelope.js';
import { createHostExceptionalVerificationReceipt } from '../src/host-handoff.js';
import { createExceptionalVerification } from '../src/exceptional-verification.js';
import { ROLE_ALLOWED_ACTIONS, buildHostRoleCapabilityInventory } from '../src/host-role-capabilities.js';
import { resolveWorkflowRoleRegistry } from '../src/workflow-roles.js';
import {
  createDispatchFixture,
  git,
  prepare,
  producerBinding,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';

let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-exceptional-')); });
after(() => rmSync(temp, { recursive: true, force: true }));
function exceptionalRequest(packet, ownerRole = 'maintainer') {
  return createExceptionalVerification({
    requestId: 'exception:123e4567-e89b-12d3-a456-426614174000',
    producer: { roleId: 'engineer' },
    transition: { packetId: packet.packetId, digest: packet.digest },
    check: { id: 'RC-1', failureOrUnavailability: 'remote verifier unavailable' },
    evidence: { state: 'missing', detail: 'The host returned no result.' },
    proposedDisposition: 'exception_rejected',
    dispositionAuthority: { roleId: ownerRole },
    nextResumableTransition: 'implementation_resume',
    freshness: { invalidatedBy: ['check_evidence_changed'] },
  });
}

describe('exceptional verification authority boundary', () => {
  it('authenticates one request and routes it to the capability-derived disposition owner', async () => {
    const fixture = await currentFilesTask('exceptional-authority');
    const packet = prepare(fixture).packet;
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "exception";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'exception evidence\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(packet, { head: returnHead });
    evidence.productAttribution = { range: { base: packet.repository.head, head: returnHead }, commits: [returnHead] };
    const roleReturn = readyReturn(packet, evidence);
    const request = exceptionalRequest(packet);
    const exceptionalReceipt = createHostExceptionalVerificationReceipt({
      adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId, packet,
      exceptionalVerification: request, repositoryEvidence: evidence,
      observedProducerRole: 'engineer',
    }, fixture.trust.privateKey);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producerBinding(fixture.trust, packet, roleReturn, evidence),
      exceptionalVerification: request, exceptionalReceipt,
    }, fixture.options);
    assert.equal(received.ok, true, JSON.stringify(received.validation));
    assert.equal(received.exceptional.state, 'exception_requested');
    assert.equal(received.exceptional.route.ownerRole, 'maintainer');
    assert.equal(received.validation.ok, true);
    assert.deepEqual(received.validation.diagnostics, []);

    // The pending request is routed, not granted.
    assert.equal(received.validation.disposition, 'exception_requested');
    assert.equal(received.exceptional.completion, false);
    assert.equal(received.exceptional.producer.roleId, 'engineer');
    assert.notEqual(received.exceptional.route.ownerRole, received.exceptional.producer.roleId);

    const missingReceipt = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producerBinding(fixture.trust, packet, roleReturn, evidence),
      exceptionalVerification: request,
    }, fixture.options);
    assert.equal(missingReceipt.ok, false);
    assert.equal(missingReceipt.validation.evidenceState, 'missing');
    assert.equal(missingReceipt.validation.disposition, 'needs_context');
    assert.match(missingReceipt.validation.errors.join('\n'), /producer receipt is required/);

    // A caller-supplied inventory arriving through untrusted role-return input
    // cannot select a disposition owner.
    const forgedRequest = exceptionalRequest(packet, 'auditor');
    const forgedReceipt = createHostExceptionalVerificationReceipt({
      adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId, packet,
      exceptionalVerification: forgedRequest, repositoryEvidence: evidence,
      observedProducerRole: 'engineer',
    }, fixture.trust.privateKey);
    const forged = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producerBinding(fixture.trust, packet, roleReturn, evidence),
      exceptionalVerification: forgedRequest, exceptionalReceipt: forgedReceipt,
      capabilityInventory: {
        auditor: { actionBindings: [{ action: 'task_workflow_mutate', policy: 'allowed' }] },
      },
    }, fixture.options);
    assert.equal(forged.ok, false);
    assert.match(
      forged.validation.errors.join('\n'),
      /disposition authority is not the capability-derived owner/
    );
  });

  it('derives the disposition owner only from a trusted effective registry and inventory', async () => {
    const fixture = await currentFilesTask('exceptional-effective-owner');
    const packet = prepare(fixture).packet;
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "exception";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'exception evidence\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(packet, { head: returnHead });
    evidence.productAttribution = { range: { base: packet.repository.head, head: returnHead }, commits: [returnHead] };
    const roleReturn = readyReturn(packet, evidence);
    const send = (request, extra = {}, options = fixture.options) => receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producerBinding(fixture.trust, packet, roleReturn, evidence),
      exceptionalVerification: request,
      exceptionalReceipt: createHostExceptionalVerificationReceipt({
        adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId, packet,
        exceptionalVerification: request, repositoryEvidence: evidence,
        observedProducerRole: 'engineer',
      }, fixture.trust.privateKey),
      ...extra,
    }, options);

    const extensionRegistry = resolveWorkflowRoleRegistry({
      workflowRoles: [{ roleId: 'release-captain', defaultLabel: 'Release Captain', escalationPrecedence: 9 }],
    });
    const policiesWithExtensionOwner = {
      ...ROLE_ALLOWED_ACTIONS,
      maintainer: ROLE_ALLOWED_ACTIONS.maintainer.filter(action => action !== 'task_workflow_mutate'),
      'release-captain': ['task_workflow_mutate'],
    };
    const extensionInventory = buildHostRoleCapabilityInventory({
      registry: extensionRegistry,
      rolePolicies: policiesWithExtensionOwner,
    });

    // A validly configured extension role succeeds when it is the sole trusted
    // owner of task_workflow_mutate.
    const extensionOwner = send(exceptionalRequest(packet, 'release-captain'), {
      workflowRoleRegistry: extensionRegistry,
    }, { ...fixture.options, hostRoleCapabilities: extensionInventory });
    assert.equal(extensionOwner.ok, true, JSON.stringify(extensionOwner.validation));
    assert.equal(extensionOwner.exceptional.route.ownerRole, 'release-captain');

    // The same extension role is unknown under the canonical registry.
    const unknownExtension = send(exceptionalRequest(packet, 'release-captain'));
    assert.equal(unknownExtension.ok, false);
    assert.match(unknownExtension.validation.errors.join('\n'), /disposition authority role is unknown/);

    // An effective registry the inventory does not cover fails closed.
    const mismatch = send(exceptionalRequest(packet, 'release-captain'), {
      workflowRoleRegistry: extensionRegistry,
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.validation.errors.join('\n'), /trusted effective host-role capability inventory/);

    // Zero and multiple eligible owners both fail closed.
    const noOwnerInventory = buildHostRoleCapabilityInventory({
      rolePolicies: {
        ...ROLE_ALLOWED_ACTIONS,
        maintainer: ROLE_ALLOWED_ACTIONS.maintainer.filter(action => action !== 'task_workflow_mutate'),
      },
    });
    const zeroOwners = send(exceptionalRequest(packet), {}, { ...fixture.options, hostRoleCapabilities: noOwnerInventory });
    assert.equal(zeroOwners.ok, false);
    assert.match(zeroOwners.validation.errors.join('\n'), /exactly one task-workflow disposition owner/);

    const twoOwnerInventory = buildHostRoleCapabilityInventory({
      rolePolicies: { ...ROLE_ALLOWED_ACTIONS, auditor: [...ROLE_ALLOWED_ACTIONS.auditor, 'task_workflow_mutate'] },
    });
    const multipleOwners = send(exceptionalRequest(packet), {}, { ...fixture.options, hostRoleCapabilities: twoOwnerInventory });
    assert.equal(multipleOwners.ok, false);
    assert.match(multipleOwners.validation.errors.join('\n'), /exactly one task-workflow disposition owner/);
  });

  it('fails closed for contradictory authority inputs and any changed authenticated request', async () => {
    const fixture = await currentFilesTask('exceptional-conflicts');
    const packet = prepare(fixture).packet;
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "exception";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'exception evidence\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(packet, { head: returnHead });
    evidence.productAttribution = { range: { base: packet.repository.head, head: returnHead }, commits: [returnHead] };
    const roleReturn = readyReturn(packet, evidence);
    const request = exceptionalRequest(packet);
    const exceptionalReceipt = createHostExceptionalVerificationReceipt({
      adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId, packet,
      exceptionalVerification: request, repositoryEvidence: evidence,
      observedProducerRole: 'engineer',
    }, fixture.trust.privateKey);
    const base = {
      raw: JSON.stringify(roleReturn), packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      runGit: fixture.runGit,
      ...producerBinding(fixture.trust, packet, roleReturn, evidence),
      exceptionalVerification: request, exceptionalReceipt,
    };
    for (const conflict of [
      { requestedOwner: 'maintainer' }, { redelegationAuthority: {} },
      { recovery: {} }, { humanDisposition: {} },
    ]) {
      const rejected = receiveRoleReturn({ ...base, ...conflict }, fixture.options);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.validation.evidenceState, 'malformed');
    }
    const changed = structuredClone(request);
    changed.evidence.detail = 'Changed after signing.';
    changed.digest = request.digest;
    const rejected = receiveRoleReturn({ ...base, exceptionalVerification: changed }, fixture.options);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.validation.evidenceState, 'negative', JSON.stringify(rejected.validation));
  });
});
