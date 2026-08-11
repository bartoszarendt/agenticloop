import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createTaskInventoryEnumeration,
  evaluateParallelScan,
  normalizeFilesTaskInventory,
} from '../src/parallel-scan.js';
import {
  SHIPPED_ACTIVATION_ADAPTERS,
  ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
  BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION,
  DECOMPOSITION_BINDING_SCHEMA_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  DISPATCH_PREPARATION_SCHEMA_VERSION,
  LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION,
  ROLE_RETURN_SCHEMA_VERSION,
  SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
  activationCapabilityInventory,
  activationCaptureDisposition,
  captureActivationInput,
  createRoleReturn,
  dispatchPreparationDigest,
  legacyDispatchPreparationDigest,
  prepareRoleDispatch,
  receiveRoleReturn,
  validateActivationCapture,
  validateDispatchPreparation,
  verifyDispatchBeforeMutation,
} from '../src/dispatch-envelope.js';
import { createHostExceptionalVerificationReceipt, createHostHandoffReceipt, signActivationCapture } from '../src/host-handoff.js';
import { createExceptionalVerification } from '../src/exceptional-verification.js';
import { ROLE_ALLOWED_ACTIONS, buildHostRoleCapabilityInventory } from '../src/host-role-capabilities.js';
import { resolveWorkflowRoleRegistry } from '../src/workflow-roles.js';
import {
  createBlockedResultRedelegation,
  createHumanDisposition,
} from '../src/blocked-result-authority.js';
import { generateHostSigningKey } from '../src/host-trust.js';
import { canonicalJson } from '../src/canonical-json.js';
import { validationResultDigest } from '../src/result-envelope.js';
import { createTaskReadinessEvidence } from '../src/task-evidence-contract.js';
import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import {
  DEFAULT_ACTIVATION_PAYLOAD,
  activation,
  createDispatchFixture,
  git,
  prepare,
  producerBinding,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-envelope-')); });
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

function blockedRuntimeReturn(packet) {
  const checks = [
    {
      id: 'RC-1',
      kind: 'command',
      command: 'npm test',
      outcome: 'blocked',
      exitCode: 1,
      evidence: 'host state prevents execution',
    },
    {
      id: 'RC-2',
      kind: 'command',
      command: 'npm run typecheck',
      outcome: 'blocked',
      exitCode: 1,
      evidence: 'host state prevents execution',
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
    productHead: packet.repository.head,
    workflowHead: packet.repository.head,
    candidateHead: null,
    productChangedPaths: [],
    workflowChangedPaths: [],
    productAttribution: {
      range: { base: packet.repository.head, head: packet.repository.head },
      commits: [],
    },
    checks,
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
    checks: evidence.checks,
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

describe('activation adapter authority', () => {
  it('ships a fail-closed inventory with no fixture identity and no supported host', () => {
    assert.deepEqual(Object.keys(SHIPPED_ACTIVATION_ADAPTERS), [
      'opencode.command.positional.v1',
      'claude-code.command.arguments.v1',
      'codex.skill.request.v1',
      'copilot.prompt.input.v1',
      'cursor.command.input.v1',
    ]);
    for (const entry of Object.values(SHIPPED_ACTIVATION_ADAPTERS)) {
      assert.equal(entry.captureCapability, 'unsupported');
      assert.equal(entry.trustedAdapter, null);
    }
  });

  it('recognizes a parser adapter only through an explicitly injected inventory', () => {
    const trust = createTestHostTrust();
    assert.throws(
      () => captureActivationInput({
        adapter: trust.adapterId,
        parserNormalizedPayload: 'x',
        sign: { keyId: trust.keyId, privateKey: trust.privateKey },
      }),
      /not in the resolved capability inventory/
    );
    const capture = activation(trust);
    assert.equal(capture.captureCapability, 'supported');
    assert.equal(validateActivationCapture(capture, { capabilities: trust.capabilities }).ok, true);
    // Without the injected inventory the same bytes are simply an unknown adapter.
    assert.equal(validateActivationCapture(capture).ok, false);
    assert.match(
      validateActivationCapture(capture).errors.join('\n'),
      /is not in the resolved capability inventory/
    );
  });

  it('refuses to let configuration upgrade a shipped fail-closed adapter', () => {
    const inventory = activationCapabilityInventory({
      'opencode.command.positional.v1': {
        adapterId: 'opencode.command.positional.v1',
        keyId: 'k', algorithm: 'ed25519', publicKey: 'AAAA',
        capabilities: { activationCapture: 'supported', returnReceipt: 'supported' },
      },
    });
    assert.equal(inventory['opencode.command.positional.v1'].captureCapability, 'unsupported');
    assert.equal(inventory['opencode.command.positional.v1'].trustedAdapter, null);
  });

  it('rejects a supported capture whose host signature is missing, forged, or wrong-keyed', () => {
    const trust = createTestHostTrust();
    const other = createTestHostTrust({ adapterId: trust.adapterId, keyId: trust.keyId });
    const capture = activation(trust);
    const unsigned = { ...capture, signature: null };
    assert.match(validateActivationCapture(unsigned, { capabilities: trust.capabilities }).errors.join('\n'), /requires a host signature/);
    const forged = { ...capture, signature: { ...capture.signature, value: `ed25519:${Buffer.from('nope').toString('base64')}` } };
    assert.match(validateActivationCapture(forged, { capabilities: trust.capabilities }).errors.join('\n'), /does not verify/);
    // Same adapter and key identity, different key material.
    assert.match(validateActivationCapture(capture, { capabilities: other.capabilities }).errors.join('\n'), /does not verify/);
    const tampered = { ...capture, normalizedActivationDigest: sha256('other'), integrity: 'mismatch' };
    assert.match(validateActivationCapture(tampered, { capabilities: trust.capabilities }).errors.join('\n'), /does not verify/);
  });

  it('produces the four exact capture dispositions before any task mutation', () => {
    const trust = createTestHostTrust();
    const payload = 'Do the exact thing.';
    const verified = activation(trust, payload, sha256(payload));
    assert.deepEqual(activationCaptureDisposition(verified, { capabilities: trust.capabilities }), {
      ok: true, evidenceState: 'current', disposition: 'proceed', errors: [], findings: [],
    });
    // Supported adapter, parser digest present, operator digest absent.
    const missing = captureActivationInput({
      adapter: trust.adapterId, expectedRequestSha256: null, parserNormalizedPayload: payload,
      intendedTaskId: 'T-001',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sign: { keyId: trust.keyId, privateKey: trust.privateKey },
    }, { capabilities: trust.capabilities });
    assert.equal(missing.captureCapability, 'supported');
    assert.equal(missing.normalizedActivationDigest, sha256(payload));
    assert.equal(missing.operatorExpectedDigest, null);
    const missingDisposition = activationCaptureDisposition(missing, { capabilities: trust.capabilities });
    assert.equal(missingDisposition.evidenceState, 'missing');
    assert.equal(missingDisposition.disposition, 'needs_context');
    const mismatch = activation(trust, payload, sha256('a different authorized request'));
    const mismatchDisposition = activationCaptureDisposition(mismatch, { capabilities: trust.capabilities });
    assert.equal(mismatchDisposition.evidenceState, 'changed');
    assert.equal(mismatchDisposition.disposition, 'rejected');
    const unsupported = captureActivationInput({ adapter: 'opencode.command.positional.v1' });
    const unsupportedDisposition = activationCaptureDisposition(unsupported);
    assert.equal(unsupportedDisposition.evidenceState, 'negative');
    assert.equal(unsupportedDisposition.disposition, 'blocked');
    assert.match(unsupportedDisposition.errors.join('\n'), /parser-owned byte artifact/);
  });

  it('fails closed on unknown and self-contradicting adapters', () => {
    const trust = createTestHostTrust();
    const capture = activation(trust);
    const unknown = { ...capture, adapter: 'invented.host.v1' };
    assert.equal(activationCaptureDisposition(unknown, { capabilities: trust.capabilities }).disposition, 'rejected');
    const contradictory = { ...capture, adapter: 'opencode.command.positional.v1' };
    const checked = validateActivationCapture(contradictory, { capabilities: trust.capabilities });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /contradicts the resolved adapter capability/);
    const declaresUnsupported = { ...capture, captureCapability: 'unsupported' };
    assert.equal(validateActivationCapture(declaresUnsupported, { capabilities: trust.capabilities }).ok, false);
  });

  it('rejects a forged verified capture whose digests differ', () => {
    const trust = createTestHostTrust();
    const valid = activation(trust);
    const forged = { ...valid, normalizedActivationDigest: sha256('different'), integrity: 'verified' };
    const checked = validateActivationCapture(forged, { capabilities: trust.capabilities });
    assert.equal(checked.ok, false);
    assert.equal(activationCaptureDisposition(forged, { capabilities: trust.capabilities }).disposition, 'rejected');
  });

  it('derives capture capability from the adapter and never from input data', () => {
    assert.throws(() => captureActivationInput({ captureCapability: 'supported' }), /derived/);
    const unsupported = captureActivationInput({ adapter: 'opencode.command.positional.v1' });
    assert.equal(unsupported.signature, null);
    assert.equal(unsupported.capturedAt, null);
    assert.equal(unsupported.integrity, 'missing');
  });

  it('keeps exact UTF-8 payload distinctions in parser-owned capture digests', () => {
    const trust = createTestHostTrust();
    const payloads = ['line one\nline two', 'line one\r\nline two', ' leading ', 'backtick ` and "quotes"', 'Unicode: café'];
    for (const payload of payloads) {
      const capture = activation(trust, payload, sha256(payload));
      assert.equal(capture.normalizedActivationDigest, sha256(payload));
      assert.equal(capture.integrity, 'verified');
    }
  });

  it('binds v2 captures to one task, repository, capture id, and expiry', () => {
    const firstRoot = mkdtempSync(join(temp, 'capture-root-a-'));
    const secondRoot = mkdtempSync(join(temp, 'capture-root-b-'));
    const trust = createTestHostTrust({ target: firstRoot });
    const valid = activation(trust);
    assert.equal(valid.schemaVersion, 2);
    assert.equal(valid.intendedTaskId, 'T-001');
    assert.match(valid.captureId, /^capture:[0-9a-f-]{36}$/);
    assert.equal(validateActivationCapture(valid, {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-001',
      repositoryIdentity: trust.adapter.repositoryIdentity,
    }).ok, true);
    for (const [field, value] of [
      ['intendedTaskId', 'T-002'],
      ['captureId', 'capture:11111111-1111-4111-8111-111111111111'],
      ['expiresAt', new Date(Date.now() + 7_200_000).toISOString()],
    ]) {
      const tampered = { ...valid, [field]: value };
      assert.equal(validateActivationCapture(tampered, { capabilities: trust.capabilities }).ok, false, field);
    }
    assert.equal(activationCaptureDisposition(valid, {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-002',
    }).ok, false);
    assert.equal(activationCaptureDisposition(valid, {
      capabilities: trust.capabilities,
      repositoryIdentity: `file:${secondRoot.replace(/\\/g, '/')}`,
    }).ok, false);
  });

  it('rejects expired, future-dated, and old supported captures', () => {
    const trust = createTestHostTrust();
    const expired = activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), {
      capturedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const expiredResult = activationCaptureDisposition(expired, { capabilities: trust.capabilities });
    assert.equal(expiredResult.ok, false);
    assert.equal(expiredResult.evidenceState, 'stale');

    const futureSkeleton = {
      ...structuredClone(activation(trust)),
      capturedAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      signature: null,
    };
    const future = signActivationCapture(futureSkeleton, {
      keyId: trust.keyId,
      privateKey: trust.privateKey,
    });
    assert.match(validateActivationCapture(future, { capabilities: trust.capabilities }).errors.join('\n'), /capturedAt/);

    const old = structuredClone(activation(trust));
    old.schemaVersion = 1;
    assert.match(validateActivationCapture(old, { capabilities: trust.capabilities }).errors.join('\n'), /schemaVersion must be 2/);
  });

  it('uses one injected clock for exact expiry and future-skew boundaries', () => {
    const trust = createTestHostTrust();
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    const base = structuredClone(activation(trust));
    const withTimes = (capturedAt, expiresAt) => signActivationCapture({
      ...base,
      capturedAt,
      expiresAt,
      signature: null,
    }, { keyId: trust.keyId, privateKey: trust.privateKey });
    const atExpiry = withTimes('2026-07-30T11:59:59.000Z', '2026-07-30T12:00:00.000Z');
    const common = {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-001',
      repositoryIdentity: trust.repositoryIdentity,
      now,
    };
    const expired = activationCaptureDisposition(atExpiry, common);
    assert.equal(expired.ok, false);
    assert.match(expired.errors.join('\n'), /expired/);

    const withinWindow = withTimes('2026-07-30T12:00:01.000Z', '2026-07-30T12:00:01.001Z');
    assert.equal(activationCaptureDisposition(withinWindow, common).ok, true);

    const beyondSkew = withTimes('2026-07-30T12:00:01.001Z', '2026-07-30T12:00:02.000Z');
    const rejected = activationCaptureDisposition(beyondSkew, common);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /capturedAt/);
  });

  it('returns typed unsupported v2 captures for every shipped adapter without invented proof', () => {
    for (const adapter of Object.keys(SHIPPED_ACTIVATION_ADAPTERS)) {
      const capture = captureActivationInput({ adapter });
      assert.equal(capture.schemaVersion, 2);
      assert.equal(capture.captureId, null);
      assert.equal(capture.intendedTaskId, null);
      assert.equal(capture.expiresAt, null);
      const disposition = activationCaptureDisposition(capture);
      assert.equal(disposition.evidenceState, 'negative');
      assert.equal(disposition.disposition, 'blocked');
    }
  });
});

describe('task-bound activation creation', () => {
  it('revalidates one signed task within its window, rejects cross-task replay, and keeps the public CLI fail-closed', async () => {
    const root = mkdtempSync(join(temp, 'task-new-v2-'));
    createTaskProjectFixture(root);
    const trust = createTestHostTrust({ target: root });
    const operatorTrustRoot = mkdtempSync(join(temp, 'task-new-v2-trust-'));
    const trustStorePath = writeHostTrustStore(operatorTrustRoot, trust);
    const capture = activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), {
      intendedTaskId: 'T-002',
    });
    const validationOptions = {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-002',
      repositoryIdentity: trust.repositoryIdentity,
    };
    assert.equal(activationCaptureDisposition(capture, validationOptions).ok, true);
    // Captures are freshness-bound rather than single-use. Revalidation of the
    // same task and bytes remains valid until the expiry boundary.
    assert.equal(activationCaptureDisposition(capture, validationOptions).ok, true);
    const crossTask = activationCaptureDisposition(capture, {
      ...validationOptions,
      intendedTaskId: 'T-003',
    });
    assert.equal(crossTask.ok, false);
    assert.match(crossTask.errors.join('\n'), /intended task/);

    writeFileSync(join(root, 'capture.json'), JSON.stringify(capture), 'utf8');
    const created = await runCliInProcess([
      'task', 'new', 'bound task', '--id', 'T-002', '--activation-input', 'capture.json',
      '--host-trust-store', trustStorePath, '--json', '--target', root,
    ], { operatorTrustRoot });
    assert.equal(created.status, 1);
    const createdResult = JSON.parse(created.stdout);
    assert.equal(createdResult.evidenceState, 'negative');
    assert.equal(createdResult.disposition, 'blocked');
    assert.match(createdResult.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--short', '.agenticloop/tasks/T-002.md'], { encoding: 'utf8' }).stdout, '');
  });

  it('rejects expired capture, unsupported shipped adapter, and malformed store before mutation', async () => {
    const root = mkdtempSync(join(temp, 'task-new-negative-'));
    createTaskProjectFixture(root);
    const trust = createTestHostTrust({ target: root });
    const operatorTrustRoot = mkdtempSync(join(temp, 'task-new-negative-trust-'));
    const trustStorePath = writeHostTrustStore(operatorTrustRoot, trust);
    const expired = activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), {
      intendedTaskId: 'T-004',
      capturedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const expiredDisposition = activationCaptureDisposition(expired, {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-004',
      repositoryIdentity: trust.repositoryIdentity,
    });
    assert.equal(expiredDisposition.ok, false);
    assert.match(expiredDisposition.errors.join('\n'), /expired/);
    writeFileSync(join(root, 'expired.json'), JSON.stringify(expired), 'utf8');
    const expiredRun = await runCliInProcess([
      'task', 'new', 'expired', '--id', 'T-004', '--activation-input', 'expired.json',
      '--host-trust-store', trustStorePath, '--json', '--target', root,
    ], { operatorTrustRoot });
    assert.equal(expiredRun.status, 1);
    assert.match(JSON.parse(expiredRun.stdout).errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);

    writeFileSync(join(root, 'unsupported.json'), JSON.stringify(captureActivationInput({
      adapter: 'cursor.command.input.v1',
    })), 'utf8');
    const unsupported = await runCliInProcess([
      'task', 'new', 'unsupported', '--id', 'T-005', '--activation-input', 'unsupported.json',
      '--json', '--target', root,
    ]);
    assert.equal(unsupported.status, 1);
    assert.equal(JSON.parse(unsupported.stdout).diagnostics[0].code, 'activation.capture.unsupported');

    writeFileSync(trustStorePath, '{', 'utf8');
    const malformed = await runCliInProcess([
      'task', 'new', 'malformed store', '--id', 'T-006', '--activation-input', 'expired.json',
      '--host-trust-store', trustStorePath, '--json', '--target', root,
    ], { operatorTrustRoot });
    assert.equal(malformed.status, 1);
    const malformedResult = JSON.parse(malformed.stdout);
    assert.equal(malformedResult.evidenceState, 'malformed');
    assert.equal(malformedResult.disposition, 'rejected');
    assert.match(malformedResult.errors.join('\n'), /Host trust store is invalid/);
    for (const id of ['T-004', 'T-005', 'T-006']) {
      assert.equal(spawnSync('git', ['-C', root, 'status', '--short', `.agenticloop/tasks/${id}.md`], { encoding: 'utf8' }).stdout, '');
    }
  });
});

describe('public activation edges reject unpinned adapters identically', () => {
  it('rejects omitted activation capture before task creation with a canonical needs-context result', async () => {
    const root = mkdtempSync(join(temp, 'activation-omitted-'));
    createTaskProjectFixture(root);
    const run = await runCliInProcess(['task', 'new', 'must not exist', '--id', 'T-001', '--json', '--target', root]);
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.disposition, 'needs_context');
    assert.equal(result.diagnostics[0].code, 'activation.capture.missing');
    assert.match(result.diagnostics[0].repairHint, /--scaffold/);
    assert.match(result.diagnostics[0].repairHint, /supported host-produced activation capture/);
    assert.match(result.diagnostics[0].repairHint, /Never author capture JSON/);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' }).stdout.includes('T-001.md'), false);

    const human = await runCliInProcess(['task', 'new', 'human repair', '--id', 'T-002', '--target', root]);
    assert.equal(human.status, 1);
    const humanOutput = `${human.stdout}\n${human.stderr}`;
    assert.match(humanOutput, /--scaffold/);
    assert.match(humanOutput, /supported host-produced activation capture/);
    assert.match(humanOutput, /Never author capture JSON/);
    assert.equal(existsSync(join(root, '.agenticloop', 'tasks', 'T-002.md')), false);
  });

  it('rejects --scaffold with --activation-input before mutation', async () => {
    const root = mkdtempSync(join(temp, 'activation-combination-'));
    createTaskProjectFixture(root);
    writeFileSync(join(root, 'capture.json'), '{}\n', 'utf8');
    const run = await runCliInProcess([
      'task', 'new', 'invalid combination', '--id', 'T-001',
      '--scaffold', '--activation-input', 'capture.json', '--target', root,
    ]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /cannot be combined/);
    assert.equal(existsSync(join(root, '.agenticloop', 'tasks', 'T-001.md')), false);
  });

  it('rejects the same unpinned capture through public creation and public preparation', async () => {
    const root = mkdtempSync(join(temp, 'unpinned-capture-'));
    createTaskProjectFixture(root);
    const trust = createTestHostTrust();
    const capture = activation(trust);
    writeFileSync(join(root, 'capture.json'), JSON.stringify(capture), 'utf8');
    const created = await runCliInProcess([
      'task', 'new', 'unpinned', '--id', 'T-001', '--activation-input', 'capture.json', '--json', '--target', root,
    ]);
    assert.equal(created.status, 1);
    const createdResult = JSON.parse(created.stdout);
    assert.equal(createdResult.kind, 'agenticloop.validation-result');
    assert.match(createdResult.errors.join('\n'), /not in the resolved capability inventory/);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' }).stdout.includes('T-001.md'), false);

    // The identical capture must also fail the preparation edge, not only creation.
    writeFileSync(join(root, 'dispatch-input.json'), JSON.stringify({ activation: capture }), 'utf8');
    const prepared = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--host-trust-store', 'C:/operator/trust.json', '--json', '--target', root,
    ]);
    assert.equal(prepared.status, 1);
    assert.equal(JSON.parse(prepared.stdout).ok, false);
  });

  it('rejects an unpinned capture at packet validation even when its digest is recomputed', async () => {
    const fixture = await currentFilesTask('recomputed-digest');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    // Recomputing the digest makes the packet internally consistent; adapter
    // authority is still resolved from the production inventory and refuses it.
    const forged = structuredClone(prepared.packet);
    forged.digest = dispatchPreparationDigest(forged);
    assert.equal(validateDispatchPreparation(forged).ok, false);
    assert.match(validateDispatchPreparation(forged).errors.join('\n'), /capability inventory/);
    assert.equal(validateDispatchPreparation(forged, fixture.options).ok, true);
  });
});

describe('dispatch preparation and receipt verification', () => {
  it('rejects caller-authored readiness/decomposition claims without authoritative refetch providers', async () => {
    const fixture = await currentFilesTask('missing-providers');
    const prepared = prepareRoleDispatch({
      activation: fixture.activation,
      assignment: fixture.assignment,
      readiness: fixture.readiness,
      decomposition: fixture.decomposition,
      refetchTask: fixture.refetchTask,
      refetchRepository: fixture.refetchRepository,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.validation.evidenceState, 'missing');
    assert.equal(prepared.validation.diagnostics[0].code, 'dispatch.packet.invalid');
    assert.match(prepared.validation.errors.join('\n'), /readiness refetch/);
  });

  it('refuses to prove dispatch without a Git reader for the initial repository state', async () => {
    const fixture = await currentFilesTask('no-git-reader');
    const prepared = prepareRoleDispatch({ ...fixture, runGit: undefined }, fixture.options);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.validation.evidenceState, 'missing');
    assert.match(prepared.validation.errors.join('\n'), /Git reader is required/);
  });

  it('rejects an activation-mismatched packet even when its digest is recomputed', async () => {
    const fixture = await currentFilesTask('activation-mismatch');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const forged = structuredClone(prepared.packet);
    forged.activation.normalizedActivationDigest = sha256('forged');
    forged.digest = dispatchPreparationDigest(forged);
    assert.equal(validateDispatchPreparation(forged, fixture.options).ok, false);
  });

  it('rejects invented packet references and a mismatched branch even when its digest is recomputed', async () => {
    const fixture = await currentFilesTask('invented-bindings');
    const prepared = prepare(fixture);
    const forged = structuredClone(prepared.packet);
    forged.assignment.branch = 'invented-branch';
    forged.assignment.canonicalReferences = ['invented/reference'];
    forged.assignment.requiredCapabilities = ['invented_capability'];
    forged.digest = dispatchPreparationDigest(forged);
    const checked = validateDispatchPreparation(forged, fixture.options);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /branch|canonicalReferences|requiredCapabilities/);
  });

  it('preserves the full canonical readiness result and verifies an unchanged packet before mutation', async () => {
    const fixture = await currentFilesTask('unchanged');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.readiness.resultDigest, validationResultDigest(fixture.readiness.result));
    assert.deepEqual(prepared.packet.readiness.result, fixture.readiness.result);
    const received = verifyDispatchBeforeMutation({
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchReadiness: fixture.refetchReadiness,
      refetchRepository: fixture.refetchRepository,
      refetchDecomposition: fixture.refetchDecomposition,
      refetchParallelScanInventory: fixture.refetchParallelScanInventory,
      runGit: fixture.runGit,
      roleId: 'engineer',
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
  });

  it('deep-freezes the emitted packet so nested mutation cannot rewrite it', async () => {
    const fixture = await currentFilesTask('frozen-packet');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.throws(() => { prepared.packet.task.allowedPaths.push('etc/**'); }, TypeError);
    assert.throws(() => { prepared.packet.activation.integrity = 'verified'; }, TypeError);
    assert.throws(() => { prepared.packet.repository.cleanState.priorGates.push({}); }, TypeError);
    assert.equal(validateDispatchPreparation(prepared.packet, fixture.options).ok, true);
  });

  it('binds the exact closed host-role capability declaration into dispatch', async () => {
    const fixture = await currentFilesTask('capability-bound-packet');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.assignment.host, 'opencode');
    assert.equal(prepared.packet.assignment.hostRoleCapability.roleId, 'engineer');
    assert.equal(
      prepared.packet.assignment.hostRoleCapability.actionBindings
        .find(binding => binding.action === 'implementation_mutate').policy,
      'allowed'
    );

    const forged = structuredClone(prepared.packet);
    forged.assignment.hostRoleCapability.unvalidated = true;
    forged.digest = dispatchPreparationDigest(forged);
    const checked = validateDispatchPreparation(forged, fixture.options);
    assert.equal(checked.ok, false);
    assert.ok(checked.findings.some(finding => finding.code === 'capability.declaration.invalid'));
  });

  it('measures the canonical preparation packet against the 16,384-byte regression threshold', async () => {
    const fixture = await currentFilesTask('packet-budget');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const packetBytes = Buffer.byteLength(canonicalJson(prepared.packet), 'utf8');
    assert.ok(packetBytes <= 16_384, `dispatch packet is ${packetBytes} bytes`);
    assert.ok(packetBytes > 0);
  });

  it('invalidates a packet when task, branch, or repository base changes after preparation', async () => {
    const fixture = await currentFilesTask('stale');
    const prepared = prepare(fixture);
    writeFileSync(fixture.taskPath, `${readFileSync(fixture.taskPath, 'utf8')}\n`, 'utf8');
    const staleTask = verifyDispatchBeforeMutation({
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchReadiness: fixture.refetchReadiness,
      refetchRepository: fixture.refetchRepository,
      refetchDecomposition: fixture.refetchDecomposition,
      runGit: fixture.runGit,
      roleId: 'engineer',
    }, fixture.options);
    assert.equal(staleTask.ok, false);
    assert.notEqual(staleTask.validation.disposition, 'proceed');
    git(fixture.root, ['checkout', '--', '.agenticloop/tasks/T-001.md']);
    const changedBranch = verifyDispatchBeforeMutation({
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchReadiness: fixture.refetchReadiness,
      refetchRepository: () => ({ ...fixture.repository(), branch: 'other-branch' }),
      refetchDecomposition: fixture.refetchDecomposition,
      runGit: fixture.runGit,
      roleId: 'engineer',
    }, fixture.options);
    assert.equal(changedBranch.ok, false);
  });

  it('keeps incomplete decomposition distinct from a complete empty ready inventory', async () => {
    const fixture = await currentFilesTask('decomposition');
    const resign = value => {
      const { sourceDigest, ...rest } = value;
      return { ...rest, sourceDigest: sha256(canonicalJson(rest)) };
    };
    // Incompleteness now comes from the bound scan record, not a token: the
    // scan itself reports that its inventory could not be proven complete.
    const source = fixture.decomposition.scan.decomposition;
    const bound = fixture.decomposition.scan.readinessContext;
    const basePaths = git(fixture.root, ['ls-tree', '-r', '--name-only', bound.base.identity.slice('git-tree:'.length)])
      .split(/\r?\n/).filter(Boolean);
    const rescan = ({ complete, entries }) => evaluateParallelScan({
      workUnit: { id: fixture.decomposition.scan.workUnit.id, backend: 'files' },
      inventory: normalizeFilesTaskInventory({
        inventoryId: 'files:.agenticloop/tasks',
        entries,
        complete,
        // Completeness is only ever provable by the authoritative enumerator's
        // typed receipt; the declared flag alone can never produce it.
        enumeration: complete === true
          ? createTaskInventoryEnumeration({
            backend: 'files', inventoryId: 'files:.agenticloop/tasks',
            observedAt: fixture.decomposition.observedAt,
            discovered: entries.length, returned: entries.length,
          })
          : null,
      }),
      decomposition: {
        source: source.source, sourceRef: source.sourceRef, revision: source.revision,
        declaredCompleteness: 'complete', attribution: 'maintainer',
      },
      observedAt: fixture.decomposition.observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths,
      dependencies: {},
      readinessContext: {
        base: fixture.readiness.evidence.base,
        dependencies: fixture.readiness.evidence.dependencies,
      },
      rescanTrigger: fixture.decomposition.scan.rescanTrigger,
    }, { now: Date.parse(fixture.decomposition.observedAt) + 1000 }).scan;

    const currentEntry = { carrier: '.agenticloop/tasks/T-001.md', content: fixture.snapshot().body, readError: null };
    const incompleteScan = rescan({ complete: false, entries: [currentEntry] });
    assert.equal(incompleteScan.conclusion, 'incomplete');
    const incomplete = resign({ ...structuredClone(fixture.decomposition), scan: incompleteScan });

    // A complete inventory that simply does not contain this task is a
    // different answer from an inventory that could not be proven complete.
    const foreignScan = rescan({
      complete: true,
      entries: [{ carrier: '.agenticloop/tasks/T-900.md', content: fixture.snapshot().body.replace('task_id: T-001', 'task_id: T-900'), readError: null }],
    });
    assert.equal(foreignScan.inventory.complete, true);
    const empty = resign({ ...structuredClone(fixture.decomposition), scan: foreignScan });

    const incompleteResult = prepare(fixture, { refetchDecomposition: () => incomplete });
    const emptyResult = prepare(fixture, { refetchDecomposition: () => empty });
    assert.equal(incompleteResult.ok, false);
    assert.equal(emptyResult.ok, false);
    assert.match(incompleteResult.validation.errors.join('\n'), /incomplete/);
    assert.match(emptyResult.validation.errors.join('\n'), /does not authorize this task as ready/);
  });

  it('emits a canonical validation result for unreadable dispatch JSON', async () => {
    const fixture = await currentFilesTask('cli-json');
    writeFileSync(join(fixture.root, 'invalid.json'), '{', 'utf8');
    const run = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'invalid.json', '--json', '--target', fixture.root,
    ]);
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.ok, false);
  });

  it('keeps public dispatch fail-closed while the trusted pure seam remains usable', async () => {
    const fixture = await currentFilesTask('cli-roundtrip');
    writeFileSync(join(fixture.root, 'dispatch-input.json'), JSON.stringify({
      readiness: {
        ...fixture.readiness,
        result: { callerAuthored: true },
        resultDigest: 'caller-authored',
      },
      decomposition: {
        sourceRef: fixture.decomposition.sourceRef,
        completeness: 'incomplete',
        authority: 'orchestrator',
      },
      assignment: fixture.assignment,
    }), 'utf8');
    const prepared = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--host-trust-store', fixture.trustStorePath, '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(prepared.status, 1);
    assert.match(JSON.parse(prepared.stdout).errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
    assert.equal(prepare(fixture).ok, true);
  });

  it('refuses a scaffold task that has no activation authoring reference at the trusted pure seam', async () => {
    const fixture = await currentFilesTask('scaffold-refusal');
    const scaffold = readFileSync(fixture.taskPath, 'utf8')
      .split('\n')
      .filter(line => !line.startsWith('activation_input_digest:') && !line.startsWith('activation_capture_ref:'))
      .join('\n');
    writeFileSync(fixture.taskPath, scaffold, 'utf8');
    git(fixture.root, ['add', '.agenticloop/tasks/T-001.md']);
    git(fixture.root, ['commit', '-m', 'record scaffold task\n\nTask: T-001\nAgent: maintainer']);
    const result = prepare(fixture);
    assert.equal(result.ok, false);
    assert.match(result.validation.errors.join('\n'), /scaffold task cannot authorize dispatch|activation_capture_ref/);
  });
});

describe('role-return handoff evidence', () => {
  it('accepts an unchanged raw producer return only with adapter provenance and repository evidence', async () => {
    const fixture = await currentFilesTask('return-positive');
    const prepared = prepare(fixture);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, { head: returnHead });
    evidence.productAttribution = {
      range: { base: prepared.packet.repository.head, head: returnHead },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${returnHead}`])
        .split(/\r?\n/)
        .filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
  });

  it('rejects recomputed packets whose material task contract binding differs from the authoritative task', async () => {
    const fixture = await currentFilesTask('return-contract-drift');
    const prepared = prepare(fixture);
    const mutations = [
      ['scope', value => `${value}\nattacker expansion`],
      ['allowedPaths', value => [...value, 'other/**']],
      ['activationCaptureRef', () => '.agenticloop/activation/other.json'],
      ['requiredChecks', value => value.map(check => check.id === 'RC-1' ? { ...check, command: 'npm run attacker' } : check)],
      ['taskContractDigest', () => `sha256:v1:${'f'.repeat(64)}`],
    ];
    for (const [field, mutate] of mutations) {
      const packet = structuredClone(prepared.packet);
      packet.task[field] = mutate(packet.task[field]);
      packet.digest = dispatchPreparationDigest(packet);
      assert.equal(validateDispatchPreparation(packet, fixture.options).ok, true, field);
      const evidence = repositoryEvidence(packet);
      const roleReturn = readyReturn(packet, evidence);
      const received = receiveRoleReturn({
        raw: JSON.stringify(roleReturn),
        packet,
        refetchTask: fixture.refetchTask,
        refetchRepositoryEvidence: () => evidence,
        ...producerBinding(fixture.trust, packet, roleReturn, evidence),
        runGit: fixture.runGit,
      }, fixture.options);
      assert.equal(received.ok, false, field);
      assert.equal(received.validation.producerRole, 'engineer', field);
      assert.match(received.validation.errors.join('\n'), /dispatch packet task contract/, field);
    }
  });

  it('rejects stale packet bytes when return and repository evidence are updated to the newer task', async () => {
    const fixture = await currentFilesTask('return-task-bytes-drift');
    const prepared = prepare(fixture);
    const current = fixture.snapshot();
    const changedBody = `${current.body}\n`;
    const changed = { ...current, body: changedBody, digest: sha256(changedBody) };
    const evidence = repositoryEvidence(prepared.packet);
    evidence.task.currentCarrierDigest = changed.digest;
    const oldReturn = readyReturn(prepared.packet, evidence);
    const roleReturn = createRoleReturn({ ...oldReturn, task: { ...oldReturn.task, currentCarrierDigest: changed.digest }, digest: undefined });
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: () => changed,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(received.validation.producerRole, 'engineer');
    assert.match(received.validation.errors.join('\n'), /Git reader|required to rederive/, 'v3 files evidence requires a trusted Git reader');
  });

  it('rejects changed backend, task id, carrier, digest, and activation binding even with a recomputed packet digest', async () => {
    const fixture = await currentFilesTask('return-identity-drift');
    const prepared = prepare(fixture);
    const mutations = [
      packet => { packet.backend = 'github'; },
      packet => { packet.task.id = 'T-002'; },
      packet => { packet.task.carrier = 'issue:77'; },
      packet => { packet.task.dispatchCarrierDigest = sha256('different task bytes'); },
      packet => { packet.task.activationDigest = sha256('different activation'); },
    ];
    for (const mutate of mutations) {
      const packet = structuredClone(prepared.packet);
      mutate(packet);
      packet.digest = dispatchPreparationDigest(packet);
      const evidence = repositoryEvidence(packet);
      const candidate = readyReturn(packet, evidence);
      const received = receiveRoleReturn({
        raw: JSON.stringify(candidate),
        packet,
        refetchTask: fixture.refetchTask,
        refetchRepositoryEvidence: () => evidence,
        ...producerBinding(fixture.trust, packet, candidate, evidence),
      }, fixture.options);
      assert.equal(received.ok, false);
      assert.equal(received.validation.producerRole, 'engineer');
    }
  });

  it('rejects ready returns with non-zero passed checks, empty paths, empty attribution, or omitted repository evidence', async () => {
    const fixture = await currentFilesTask('return-negative');
    const prepared = prepare(fixture);
    const variants = [
      { checks: [
        { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 9, evidence: 'wrong' },
        { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, evidence: 'ok' },
      ] },
      { productChangedPaths: [] },
    ];
    for (const patch of variants) {
      const candidate = { ...readyReturn(prepared.packet, repositoryEvidence(prepared.packet)), ...patch, digest: undefined };
      assert.throws(() => createRoleReturn(candidate), /invalid role return/);
    }
    const goodEvidence = repositoryEvidence(prepared.packet);
    const candidate = readyReturn(prepared.packet, goodEvidence);
    const missingEvidence = receiveRoleReturn({
      raw: JSON.stringify(candidate),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      ...producerBinding(fixture.trust, prepared.packet, candidate, goodEvidence),
    }, fixture.options);
    assert.equal(missingEvidence.ok, false);
    assert.equal(missingEvidence.validation.evidenceState, 'missing');
    const emptyAttribution = structuredClone(goodEvidence);
    emptyAttribution.productAttribution.commits = [];
    const malformed = { ...candidate, productAttribution: emptyAttribution.productAttribution };
    const received = receiveRoleReturn({
      raw: JSON.stringify(malformed),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => emptyAttribution,
      ...producerBinding(fixture.trust, prepared.packet, candidate, emptyAttribution),
    }, fixture.options);
    assert.equal(received.ok, false);
  });

  it('rejects replayed producer receipts across return identities and invocation bindings', async () => {
    const fixture = await currentFilesTask('return-replay');
    const prepared = prepare(fixture);
    const evidence = repositoryEvidence(prepared.packet);
    const first = readyReturn(prepared.packet, evidence);
    const receipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn: first,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    const second = readyReturn(prepared.packet, evidence);
    const replayed = receiveRoleReturn({
      raw: JSON.stringify(second),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: receipt,
      resolveTrustedAdapter: () => fixture.trust.adapter,
    }, fixture.options);
    assert.equal(replayed.ok, false);
    assert.match(replayed.validation.errors.join('\n'), /authentication failed|does not bind/);
  });

  it('requires complete blocker and resumption facts', async () => {
    const fixture = await currentFilesTask('blocked-return');
    const prepared = prepare(fixture);
    const evidence = repositoryEvidence(prepared.packet);
    const invalid = {
      producerRole: 'engineer', packet: { packetId: prepared.packet.packetId, digest: prepared.packet.digest },
      task: {
        backend: 'files', id: 'T-001', taskContractDigest: prepared.packet.task.taskContractDigest,
        dispatchCarrierDigest: prepared.packet.task.dispatchCarrierDigest,
        currentCarrierDigest: prepared.packet.task.dispatchCarrierDigest,
      },
      worktree: evidence.worktree, branch: evidence.branch,
      productBaseHead: evidence.productBaseHead, productHead: evidence.productHead,
      workflowHead: evidence.workflowHead, candidateHead: null,
      productChangedPaths: [], workflowChangedPaths: [], checks: [
        { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'blocked', exitCode: 1, evidence: 'blocked' },
        { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'not_run', exitCode: -1, evidence: 'not run' },
      ],
      productAttribution: evidence.productAttribution,
      carrierLineage: {
        dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}`,
        evidenceMutationReceiptDigests: [],
      },
      pr: evidence.pr,
      outcome: { kind: 'implementation_blocked', completion: false, authority: 'non_authoritative_role_outcome' }, disposition: 'blocked',
      blocker: { category: '', evidence: { kind: '', detail: '' }, resumeOwner: '', resumeTransition: '', resumePreconditions: { items: [], justification: '' } },
      freshness: {
        invalidatedBy: [
          'task_or_contract_changes', 'packet_or_assignment_changes', 'branch_or_head_changes',
          'check_or_transport_evidence_changes', 'initial_repository_state_changes',
        ],
      },
    };
    assert.throws(() => createRoleReturn(invalid), /category|blocker|resume/i);
  });

  it('rejects manually reconstructed orchestrator returns and exposes a read-only return verifier', async () => {
    const fixture = await currentFilesTask('manual-return');
    const prepared = prepare(fixture);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement return\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, { head: returnHead });
    evidence.productAttribution = {
      range: { base: prepared.packet.repository.head, head: returnHead },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${returnHead}`])
        .split(/\r?\n/)
        .filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const manual = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence, { source: 'orchestrator' }),
    }, fixture.options);
    assert.equal(manual.ok, false);
    const packetPath = join(fixture.root, 'packet.json');
    const returnPath = join(fixture.root, 'return.json');
    writeFileSync(packetPath, JSON.stringify(prepared.packet), 'utf8');
    writeFileSync(returnPath, JSON.stringify(roleReturn), 'utf8');
    const run = await runCliInProcess(
      ['task', 'verify-return', 'T-001', '--packet', 'packet.json', '--return', 'return.json', '--host-trust-store', fixture.trustStorePath, '--json', '--target', fixture.root],
      { operatorTrustRoot: fixture.operatorTrustRoot }
    );
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.disposition, 'blocked');
    assert.match(result.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
  });

  it('refetches an injected GitHub transport instead of swapping a projection object', async () => {
    const fixture = await currentFilesTask('github-transport');
    let calls = 0;
    const transport = {
      fetchIssue() {
        calls += 1;
        return { ...fixture.snapshot(), backend: 'github', carrier: 'issue:42' };
      },
    };
    const githubFixture = {
      ...fixture,
      refetchTask: () => transport.fetchIssue(),
      assignment: { ...fixture.assignment, canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'] },
      readiness: {
        ...fixture.readiness,
        evidence: createTaskReadinessEvidence({
          ...fixture.readiness.evidence,
          backend: 'github', task: { id: 'T-001', carrier: 'issue:42', expectedDigest: fixture.snapshot().digest },
        }),
      },
    };
    githubFixture.refetchReadiness = () => githubFixture.readiness;
    const prepared = prepare(githubFixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const githubEvidence = repositoryEvidence(prepared.packet, {
      pr: { state: 'open', number: 42, url: 'https://example.test/pull/42' },
    });
    const roleReturn = readyReturn(prepared.packet, githubEvidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: () => transport.fetchIssue(),
      refetchRepositoryEvidence: () => {
        calls += 1;
        return githubEvidence;
      },
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, githubEvidence),
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
    assert.ok(calls >= 3, 'injected transport must refetch GitHub issue and PR facts at dispatch and return');

    const attacked = structuredClone(prepared.packet);
    attacked.task.scope += '\nrecomputed GitHub packet expansion';
    attacked.digest = dispatchPreparationDigest(attacked);
    assert.equal(validateDispatchPreparation(attacked, fixture.options).ok, true);
    const attackedEvidence = repositoryEvidence(attacked, {
      pr: { state: 'open', number: 42, url: 'https://example.test/pull/42' },
    });
    const attackedReturn = readyReturn(attacked, attackedEvidence);
    const rejected = receiveRoleReturn({
      raw: JSON.stringify(attackedReturn),
      packet: attacked,
      refetchTask: () => transport.fetchIssue(),
      refetchRepositoryEvidence: () => attackedEvidence,
      ...producerBinding(fixture.trust, attacked, attackedReturn, attackedEvidence),
    }, fixture.options);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.validation.producerRole, 'engineer');
    assert.match(rejected.validation.errors.join('\n'), /dispatch packet task contract/);
  });
});

describe('OpenCode activation capability', () => {
  it('generates an explicit unsupported result instead of placeholder capture text', () => {
    const target = mkdtempSync(join(temp, 'opencode-target-'));
    const output = mkdtempSync(join(temp, 'opencode-output-'));
    mkdirSync(target, { recursive: true });
    seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
    generateOpencodeArtifacts(loadAgenticLoopConfig(join(target, 'agenticloop.json')), target, output);
    const command = readFileSync(join(output, '.opencode', 'commands', 'agenticloop.md'), 'utf8');
    assert.match(command, /Activation capture capability: `unsupported`/);
    assert.doesNotMatch(command, /\$(?:ARGUMENTS|\d+)/);
    assert.match(command, /parser-owned byte artifact/);
  });
});

describe('authoritative blocked-return receive path', () => {
  it('binds degraded reports into dispatch and consumes them at role-return receive', async () => {
    const fixture = await currentFilesTask('blocked-runtime-degraded');
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
    const fixture = await currentFilesTask('blocked-runtime-owner');
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
    const fixture = await currentFilesTask('blocked-runtime-recovery');
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

/**
 * Strip the current envelope down to the v2-v5 field set. Prior packets carried
 * exactly one activation model and no assurance statement, so a genuine legacy
 * carrier has neither field.
 */
function assuranceUnboundEnvelope(packet) {
  const legacy = structuredClone(packet);
  delete legacy.activationBinding;
  delete legacy.returnAdapter;
  delete legacy.assurance;
  return legacy;
}

describe('documented envelope identity contract', () => {
  it('AGENTIC_LOOP.md names the exact schema versions and digests the implementation emits', async () => {
    const doc = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf8');
    assert.match(doc, /agenticloop\.role-preparation`, schema version\s*\n?`7`/);
    assert.match(doc, /sha256:agenticloop\.role-preparation\.v7:<64-lowercase-hex>/);
    assert.match(doc, /agenticloop\.role-return`, schema version\s*\n?`3`/);
    assert.match(doc, /sha256:agenticloop\.role-return\.v3:<64-lowercase-hex>/);
    assert.match(doc, /agenticloop\.decomposition-provenance`, schema\s*\n?version `2`/);
    assert.match(doc, /agenticloop\.decomposition-binding`,\s*\n?schema version `1`/);
    assert.doesNotMatch(doc, /agenticloop\.role-preparation\.v1/);
    assert.doesNotMatch(doc, /agenticloop\.role-return\.v1/);
    assert.equal(DISPATCH_PREPARATION_SCHEMA_VERSION, 7);
    assert.equal(ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION, 5);
    assert.equal(SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION, 4);
    assert.equal(BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION, 2);
    assert.equal(LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION, 3);
    assert.equal(DECOMPOSITION_SCHEMA_VERSION, 2);
    assert.equal(DECOMPOSITION_BINDING_SCHEMA_VERSION, 1);
    assert.equal(ROLE_RETURN_SCHEMA_VERSION, 3);
    const fixture = await currentFilesTask('doc-contract');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.ok(prepared.packet.digest.startsWith('sha256:agenticloop.role-preparation.v7:'));
    const roleReturn = readyReturn(prepared.packet, repositoryEvidence(prepared.packet));
    assert.ok(roleReturn.digest.startsWith('sha256:agenticloop.role-return.v3:'));
  });

  it('classifies the shipped schemaVersion 2 baseline as typed stale without accepting it', async () => {
    const fixture = await currentFilesTask('baseline-v2-contract');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const baseline = assuranceUnboundEnvelope(prepared.packet);
    baseline.schemaVersion = BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION;
    delete baseline.assignment.host;
    delete baseline.assignment.hostRoleCapability;
    delete baseline.assignment.degradedEnforcementReports;
    baseline.digest = legacyDispatchPreparationDigest(
      baseline,
      BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(baseline, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 2 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    }]);
  });

  it('classifies an assurance-unbound schemaVersion 5 carrier as typed stale', async () => {
    const fixture = await currentFilesTask('legacy-v5-contract');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = assuranceUnboundEnvelope(prepared.packet);
    legacy.schemaVersion = ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION;
    legacy.digest = legacyDispatchPreparationDigest(
      legacy,
      ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 5 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    }]);
  });

  it('classifies a canonical schemaVersion 3 carrier as typed stale', async () => {
    const fixture = await currentFilesTask('legacy-v3-contract');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = assuranceUnboundEnvelope(prepared.packet);
    legacy.schemaVersion = LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION;
    delete legacy.assignment.degradedEnforcementReports;
    legacy.digest = legacyDispatchPreparationDigest(
      legacy,
      LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.length, 1);
    assert.deepEqual(checked.findings[0], {
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 3 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    });
  });

  it('classifies a schemaVersion 4 scan-unbound carrier as typed stale rather than migrating it', async () => {
    const fixture = await currentFilesTask('legacy-v4-contract');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = assuranceUnboundEnvelope(prepared.packet);
    legacy.schemaVersion = SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION;
    // A version 4 packet carried the version 1 decomposition source inline.
    legacy.decomposition = structuredClone(fixture.legacyDecomposition);
    legacy.digest = legacyDispatchPreparationDigest(
      legacy,
      SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION
    );

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation schemaVersion 4 is stale; regenerate the packet as schemaVersion 7 before dispatch or return import',
    }]);
  });

  it('classifies an authentic current packet with canonical v3 degraded reports as typed stale', async () => {
    const fixture = await currentFilesTask('nested-v3-contract');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const legacy = structuredClone(prepared.packet);
    const declaration = legacy.assignment.hostRoleCapability;
    legacy.assignment.degradedEnforcementReports = legacy.assignment.degradedEnforcementReports.map(report => ({
      ...report,
      schemaVersion: 3,
      limitation: declaration.limitation,
      detectionBoundary: declaration.detectionBoundary,
      recoveryRoute: declaration.recoveryRoute,
    }));
    legacy.digest = dispatchPreparationDigest(legacy);

    const checked = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.findings, [{
      code: 'dispatch.packet.stale',
      evidenceState: 'changed',
      disposition: 'superseded',
      message: 'dispatch preparation degraded-enforcement report schemaVersion 3 is stale; regenerate the packet before dispatch or return import',
    }]);
  });

  it('does not classify a malformed nested-v3 report lookalike as trusted stale', async () => {
    const fixture = await currentFilesTask('nested-v3-lookalike');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const malformed = structuredClone(prepared.packet);
    const declaration = malformed.assignment.hostRoleCapability;
    malformed.assignment.degradedEnforcementReports = malformed.assignment.degradedEnforcementReports.map(report => ({
      ...report,
      schemaVersion: 3,
      limitation: declaration.limitation,
      detectionBoundary: declaration.detectionBoundary,
      recoveryRoute: declaration.recoveryRoute,
    }));
    malformed.assignment.degradedEnforcementReports[0].unexpected = true;
    malformed.digest = dispatchPreparationDigest(malformed);

    const checked = validateDispatchPreparation(malformed, fixture.options);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.some(item => item.code === 'dispatch.packet.stale'), false);
    assert.ok(checked.findings.some(item => item.code === 'capability.declaration.invalid'));
  });

  it('does not promote malformed or current packets into a legacy version class', async () => {
    const fixture = await currentFilesTask('legacy-misclassification');
    const prepared = prepare(fixture);
    assert.equal(validateDispatchPreparation(prepared.packet, fixture.options).ok, true);
    const malformed = assuranceUnboundEnvelope(prepared.packet);
    malformed.schemaVersion = BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION;
    delete malformed.assignment.host;
    delete malformed.assignment.hostRoleCapability;
    delete malformed.assignment.degradedEnforcementReports;
    malformed.packetId = 'not-a-dispatch-id';
    const checked = validateDispatchPreparation(malformed, fixture.options);
    assert.equal(checked.ok, false);
    assert.equal(checked.findings.some(item => item.code === 'dispatch.packet.stale'), false);
    assert.match(checked.errors.join('\n'), /packetId|schemaVersion|digest/);
  });
});
