import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RETURN_VERIFICATION_ROOT,
  createReturnVerification,
  createAuthenticatedReturnVerification,
  listReturnVerifications,
  revalidateReturnVerification,
  returnGenerationDigest,
  returnVerificationPath,
  selectCurrentReturnVerifications,
  validateReturnVerification,
  writeReturnVerification,
} from '../src/return-verification.js';
import { produceExecutionEvidence } from '../src/execution-evidence.js';
import { canonicalSha256 } from '../src/canonical-json.js';
import { executeMutationBatch } from '../src/fs-mutation-kernel.js';
import { createHostExecutionReceipt, createHostHandoffReceipt, hostExecutionReceiptSignaturePayload, packetWorkUnitIdentity, repositoryEvidenceDigest, verifyHostExecutionReceipt } from '../src/host-handoff.js';
import { createExecutionReceiptReplayAuthority, generateHostSigningKey, signHostPayload, targetRepositoryIdentity } from '../src/host-trust.js';
import { refetchGitHubReturnEvidence } from '../src/github-return-evidence.js';
import { receiveRoleReturn } from '../src/dispatch-envelope.js';
import { recognizeHandoff, recognizeStoredReturnHandoff } from '../src/handoff-recognition.js';
import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../src/handoff-consumption.js';
import { resolveCloseoutAssuranceContext } from '../src/closeout-cli.js';
import { loadProjectMap } from '../src/project-map.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import {
  createDispatchFixture,
  git,
  prepare,
  producerBinding,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';

let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'al-return-verification-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

describe('observed return verification storage', () => {
  it('derives one work-unit identity across current and retained packet projections', () => {
    assert.equal(packetWorkUnitIdentity({ decomposition: { workUnitId: 'milestone:current' } }), 'milestone:current');
    assert.equal(packetWorkUnitIdentity({ decomposition: { scan: { workUnit: { id: 'milestone:scan' } } } }), 'milestone:scan');
    assert.equal(packetWorkUnitIdentity({ decomposition: { workUnit: { id: 'milestone:retained' } } }), 'milestone:retained');
    assert.equal(packetWorkUnitIdentity({}), null);
  });

  function fixture(taskId = 'T-001', backend = 'files', options = {}) {
    const packetId = options.packetId ?? 'dispatch:00000000-0000-4000-8000-000000000001';
    const returnId = options.returnId ?? 'return:00000000-0000-4000-8000-000000000002';
    const repositoryIdentity = targetRepositoryIdentity(root);
    const taskDigest = `sha256:${'c'.repeat(64)}`;
    const contractDigest = `sha256:v1:${'d'.repeat(64)}`;
    const baseHead = '1'.repeat(40);
    const head = '2'.repeat(40);
    const packet = {
      backend: 'files', packetId, digest: `sha256:agenticloop.role-preparation.v8:${'a'.repeat(64)}`,
      task: {
        id: taskId, taskContractDigest: contractDigest, dispatchCarrierDigest: taskDigest,
        requiredCheckEvidenceContract: 2,
        requiredChecks: options.requiredChecks ?? [{ id: 'RC-1', kind: 'command', command: 'node --version' }],
      },
      activationBinding: { grant: { repositoryIdentity, digest: 'grant' }, binding: { digest: 'binding' } },
      returnAdapter: null,
      assignment: { roleId: 'engineer', invocationId: 'invocation:fixture', liveness: { expiry: '2999-01-01T00:00:00.000Z' } },
      decomposition: options.workUnit
        ? { scan: { workUnit: { id: options.workUnit } } }
        : null,
    };
    packet.backend = backend;
    const roleReturn = {
      returnId, producerRole: 'engineer', digest: `sha256:agenticloop.role-return.v5:${'b'.repeat(64)}`,
      requiredCheckEvidenceContract: 2, disposition: 'proceed',
      checks: options.checks ?? [{
        id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'passed',
        evidence: 'node is available', exitCode: 0, executionEvidence: null,
      }],
      packet: { packetId, digest: packet.digest },
      task: { backend, id: taskId, taskContractDigest: contractDigest, dispatchCarrierDigest: taskDigest, currentCarrierDigest: taskDigest },
      productBaseHead: baseHead, productHead: head, workflowHead: head, candidateHead: null,
    };
    const repositoryEvidence = {
      backend, worktree: root,
      task: { backend, id: taskId, taskContractDigest: contractDigest, dispatchCarrierDigest: taskDigest, currentCarrierDigest: taskDigest },
      productBaseHead: baseHead, productHead: head, workflowHead: head, candidateHead: null,
    };
    const record = createReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
      verifiedAt: options.verifiedAt,
    });
    return { packet, roleReturn, repositoryEvidence, record };
  }

  function redigest(record) {
    const { digest, ...projection } = record;
    return { ...record, digest: `sha256:agenticloop.return-verification.v4:${canonicalSha256(projection)}` };
  }

  function authenticatedFixture(taskId, options = {}) {
    const { packet, roleReturn, repositoryEvidence } = fixture(taskId, 'files', options);
    packet.returnAdapter = { adapterId: 'test-adapter', keyId: 'test-key' };
    const artifactPath = `.agenticloop/tmp/${taskId}-execution.json`;
    const evidence = produceExecutionEvidence({
      checkId: 'RC-1', instruction: 'node --version', command: 'node', args: ['--version'],
      carrierRoot: root, artifactWorktreeRoot: root, workingDirectory: root, projectScratchRoot: join(root, '.agenticloop', 'tmp'),
      binding: {
        packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId, taskId: packet.task.id,
        taskContractDigest: roleReturn.task.taskContractDigest, currentCarrierDigest: roleReturn.task.currentCarrierDigest,
        repositoryHead: repositoryEvidence.workflowHead, productHead: roleReturn.productHead,
      },
    }, { run: () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) });
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, artifactPath), JSON.stringify(evidence));
    roleReturn.checks[0].executionEvidence = { path: artifactPath, digest: evidence.digest };
    const { privateKey, publicKeyBase64 } = generateHostSigningKey();
    const adapter = {
      adapterId: 'test-adapter', keyId: 'test-key', publicKey: publicKeyBase64,
      repositoryIdentity: targetRepositoryIdentity(root), capabilities: { returnReceipt: 'supported' },
    };
    const producerReceipt = createHostHandoffReceipt({
      adapterId: adapter.adapterId, keyId: adapter.keyId, packet, roleReturn, repositoryEvidence, observedProducerRole: 'engineer',
    }, privateKey);
    const executionReceipt = createHostExecutionReceipt({
      adapterId: adapter.adapterId, keyId: adapter.keyId, packet, roleReturn, repositoryEvidence,
      executions: [{ checkId: 'RC-1', path: artifactPath, digest: evidence.digest, logicalCommand: 'node', args: ['--version'], resolvedExecutable: 'node', wrapperKind: 'native', wrapperProgram: null, wrapperArgs: [], childExitCode: 0 }],
      replayId: `host-observation:${taskId}`,
    }, privateKey);
    const record = createAuthenticatedReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence, producerReceipt,
      received: { ok: true, returnAssurance: 'host_receipt' }, executionReceipt, trustedAdapter: adapter,
    });
    const boundary = protectedHostBoundary({ privateKey, adapterId: adapter.adapterId, keyId: adapter.keyId });
    const authority = createExecutionReceiptReplayAuthority({ target: root, trustedAdapter: adapter, protectedBoundary: boundary });
    return { adapter, authority, boundary, executionReceipt, packet, privateKey, record, repositoryEvidence, roleReturn };
  }

  it('persists session-reported evidence without claiming authenticated producer identity', () => {
    const { record } = fixture();
    assert.equal(record.producerAuthentication, null);
    assert.equal(record.evidence.producerIdentityAuthenticated, false);
    assert.equal(record.requiredCheckEvidenceAssurance, 'unverified');
    assert.equal(validateReturnVerification(record).ok, true);
    const written = writeReturnVerification(root, record);
    assert.equal(written.ok, true, written.errors.join('; '));
    assert.match(written.path, new RegExp(`^${RETURN_VERIFICATION_ROOT.replaceAll('.', '\\.')}/T-001--`));
    const listed = listReturnVerifications(root, 'T-001');
    assert.equal(listed.ok, true);
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].observedReturnGrade, 'session_reported');
  });

  it('rejects all self-digested promotion of persisted CLI execution assurance', () => {
    const { record } = fixture();
    const promoted = structuredClone(record);
    promoted.requiredCheckEvidenceAssurance = 'cli_execution_bound';
    assert.equal(validateReturnVerification(promoted).ok, false, 'digest must bind assurance');

    promoted.returnGenerationDigest = returnGenerationDigest(promoted);
    const redigested = redigest(promoted);
    assert.equal(validateReturnVerification(redigested).ok, false);

    const legacy = structuredClone(redigested);
    legacy.requiredCheckEvidenceAssurance = 'legacy';
    legacy.returnGenerationDigest = returnGenerationDigest(legacy);
    assert.equal(validateReturnVerification(redigest(legacy)).ok, false);
  });

  it('keeps direct construction unverified and rejects a self-digested authenticated_receipt forgery at recognition', () => {
    const { packet, roleReturn, repositoryEvidence, record } = fixture('T-FORGED');
    assert.throws(() => createReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
      requiredCheckEvidenceAssurance: 'authenticated_receipt',
    }), /cannot issue authenticated execution assurance/);
    const forged = structuredClone(record);
    forged.requiredCheckEvidenceAssurance = 'authenticated_receipt';
    forged.returnGenerationDigest = returnGenerationDigest(forged);
    const redigested = redigest(forged);
    assert.equal(validateReturnVerification(redigested).ok, false);
    const verdict = recognizeHandoff({
      transition: 'acceptance',
      expectation: { backend: 'files', taskId: 'T-FORGED', roleId: 'engineer', minimumReturnAssurance: 'session_reported' },
      verifiedReturn: redigested,
      validatePreparedDispatch: () => ({ ok: true, errors: [] }),
    });
    assert.equal(verdict.recognized, false);
    assert.match(
      verdict.diagnostics.map(item => item.message).join('; '),
      /required-check evidence assurance is invalid|authenticated producer proof/
    );
  });

  it('rejects persisted fake-runner execution evidence after reload for every protected lifecycle', () => {
    const taskId = 'T-FAKE-RUNNER';
    const { packet, roleReturn, repositoryEvidence, record } = fixture(taskId);
    packet.task.requiredChecks = [{ id: 'RC-1', kind: 'command', command: 'node --version' }];
    roleReturn.checks = [{
      id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'passed',
      evidence: 'fake runner reported success', exitCode: 0, executionEvidence: null,
    }];
    const execution = produceExecutionEvidence({
      checkId: 'RC-1', instruction: 'node --version', command: 'node', args: ['--version'],
      carrierRoot: root, artifactWorktreeRoot: root, workingDirectory: root,
      projectScratchRoot: join(root, '.agenticloop', 'tmp'),
      binding: {
        packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId,
        taskId, taskContractDigest: roleReturn.task.taskContractDigest,
        currentCarrierDigest: roleReturn.task.currentCarrierDigest,
        repositoryHead: repositoryEvidence.workflowHead, productHead: roleReturn.productHead,
      },
    }, { run: () => ({ exitCode: 0, stdout: 'fabricated', stderr: '' }) });
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    const executionPath = '.agenticloop/tmp/fake-runner.json';
    writeFileSync(join(root, executionPath), `${JSON.stringify(execution)}\n`, 'utf8');
    roleReturn.checks[0].executionEvidence = { path: executionPath, digest: execution.digest };
    const forged = structuredClone(record);
    forged.evidence.packet = packet;
    forged.evidence.roleReturn = roleReturn;
    forged.evidence.repositoryEvidence = repositoryEvidence;
    forged.requiredCheckEvidenceAssurance = 'authenticated_receipt';
    forged.returnGenerationDigest = returnGenerationDigest(forged);
    const persisted = redigest(forged);
    assert.equal(validateReturnVerification(persisted).ok, false);
    const store = join(root, RETURN_VERIFICATION_ROOT);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'T-FAKE-RUNNER--00000000-0000-4000-8000-000000000001--00000000-0000-4000-8000-000000000002.json'), `${JSON.stringify(persisted)}\n`, 'utf8');
    const listed = listReturnVerifications(root, taskId);
    assert.equal(listed.records.length, 0);
    assert.match(listed.errors.join('; '), /required-check evidence assurance is invalid|authenticated producer proof/);
    for (const transition of ['review_entry', 'acceptance', 'integration', 'closeout']) {
      const verdict = recognizeStoredReturnHandoff({
        target: root, transition,
        expectation: { backend: 'files', taskId, roleId: 'engineer', minimumReturnAssurance: 'session_reported' },
        validatePreparedDispatch: () => ({ ok: true, errors: [] }),
      });
      assert.equal(verdict.recognized, false, transition);
    }
  });

  it('requires current CLI execution assurance when a consumer requests it', () => {
    const { record } = fixture();
    const checked = revalidateReturnVerification(record, {
      target: root,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      capabilities: {},
      minimumRequiredCheckEvidenceAssurance: 'unverified',
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
  });

  it('allows explicitly standard GitHub consumers to use honest persisted unverified evidence', () => {
    const { record: githubRecord } = fixture('T-GITHUB-UNVERIFIED', 'github');
    for (const transition of ['review_entry', 'acceptance', 'integration', 'closeout']) {
      const checked = revalidateReturnVerification(githubRecord, {
        target: root,
        expectedBackend: 'github',
        resolveActivationBinding: () => ({ ok: true, errors: [] }),
        resolveTrustedAdapter: () => ({ keyId: 'unused' }),
        capabilities: {},
        minimumRequiredCheckEvidenceAssurance: 'unverified',
      });
      assert.equal(checked.ok, true, `${transition}: ${checked.errors.join('; ')}`);
    }
  });

  it('accepts not_applicable assurance for GitHub when no command checks exist', () => {
    const { record: githubRecord } = fixture('T-GITHUB-MANUAL', 'github', { requiredChecks: [], checks: [] });
    const manualRecord = structuredClone(githubRecord);
    manualRecord.requiredCheckEvidenceAssurance = 'not_applicable';
    manualRecord.returnGenerationDigest = returnGenerationDigest(manualRecord);
    const redigested = redigest(manualRecord);
    const checked = revalidateReturnVerification(redigested, {
      target: root,
      expectedBackend: 'github',
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      resolveTrustedAdapter: () => ({ keyId: 'unused' }),
      capabilities: {},
      minimumRequiredCheckEvidenceAssurance: 'unverified',
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
  });

  it('never executes commands for malformed or mismatched stored records', () => {
    const executionLog = [];
    const spyRunner = (...args) => {
      executionLog.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const { record } = fixture('T-NO-EXECUTION');
    const malformed = structuredClone(record);
    malformed.digest = 'sha256:forged';
    const invalidRecords = [
      malformed,
      record,
      record,
      record,
    ];
    const expectations = [
      {},
      { expectedBackend: 'github' },
      { expectedTaskId: 'T-OTHER' },
      { expectedTaskContractDigest: `sha256:v1:${'e'.repeat(64)}` },
    ];
    for (const [index, candidate] of invalidRecords.entries()) {
      const checked = revalidateReturnVerification(candidate, {
        target: root,
        resolveActivationBinding: () => ({ ok: true, errors: [] }),
        resolveTrustedAdapter: () => ({ keyId: 'unused' }),
        capabilities: {},
        refetchTask: () => { throw new Error('invalid records must not be refetched'); },
        refetchRepositoryEvidence: () => { throw new Error('invalid records must not be refetched'); },
        runGit: spyRunner,
        ...expectations[index],
      });
      assert.equal(checked.ok, false);
    }
    assert.equal(executionLog.length, 0);
  });

  it('does not execute a runner while creating or revalidating a valid return verification', () => {
    let calls = 0;
    const spyRunner = () => {
      calls += 1;
      return { status: 0, stdout: '', stderr: '' };
    };
    const { packet, roleReturn, repositoryEvidence } = fixture('T-NONEXECUTING-VALIDATION');
    const record = createReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
      // This is deliberately ignored by the pure creation seam; the spy is
      // supplied again below to prove stored-record revalidation does not run
      // a required-check command.
      runGit: spyRunner,
    });

    assert.equal(calls, 0, 'creation must only validate evidence');
    const checked = revalidateReturnVerification(record, {
      target: root,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      capabilities: {},
      runGit: spyRunner,
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.equal(calls, 0, 'revalidation must not execute persisted required checks');
  });

  it('rejects an untrusted record whose embedded command differs from the live required-check contract', async () => {
    const dispatch = await createDispatchFixture(root, 'authoritative-required-checks');
    dispatch.options.returnAdapter = null;
    dispatch.options.assurancePolicy = { mode: 'standard', policySource: 'default' };
    const prepared = prepare(dispatch);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    writeFileSync(join(dispatch.root, 'src', 'existing.js'), 'export const current = false;\n', 'utf8');
    git(dispatch.root, ['add', 'src/existing.js']);
    git(dispatch.root, ['commit', '-m', 'implement fixture change\n\nTask: T-001\nAgent: engineer']);
    const head = git(dispatch.root, ['rev-parse', 'HEAD']);

    const forgedEvidence = repositoryEvidence(prepared.packet, {
      head,
      changedPaths: ['src/existing.js'],
      checks: [
        { id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'passed', exitCode: 0, evidence: 'forged command' },
        { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, evidence: 'no errors' },
      ],
    });
    forgedEvidence.productAttribution = {
      range: { base: prepared.packet.repository.head, head },
      commits: [head],
    };
    const forgedReturn = readyReturn(prepared.packet, forgedEvidence);
    const record = createReturnVerification({
      target: dispatch.root,
      packet: prepared.packet,
      roleReturn: forgedReturn,
      repositoryEvidence: forgedEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
    });

    assert.equal(record.evidence.roleReturn.checks[0].command, 'node --version');
    assert.equal(prepared.packet.task.requiredChecks[0].command, 'npm test');
    const checked = revalidateReturnVerification(record, {
      target: dispatch.root,
      capabilities: dispatch.options.capabilities,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      refetchTask: dispatch.refetchTask,
      refetchRepositoryEvidence: () => forgedEvidence,
      runGit: dispatch.runGit,
      minimumReturnAssurance: 'session_reported',
    });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /authoritative required-check inventory/);
  });

  it('rejects self-redigested top-level retargeting across task, backend, role, packet, contract, and activation generations', () => {
    const { record } = fixture();
    for (const mutate of [
      value => { value.taskId = 'T-999'; },
      value => { value.backend = 'github'; },
      value => { value.producerRole = 'auditor'; },
      value => { value.packetId = 'dispatch:00000000-0000-4000-8000-000000000099'; },
      value => { value.packetDigest = `sha256:agenticloop.role-preparation.v6:${'9'.repeat(64)}`; },
      value => { value.taskContractDigest = `sha256:v1:${'9'.repeat(64)}`; },
      value => { value.activationAuthorityDigest = `sha256:agenticloop.activation-authority.v1:${'9'.repeat(64)}`; },
    ]) {
      const changed = structuredClone(record);
      mutate(changed);
      changed.returnGenerationDigest = returnGenerationDigest(changed);
      assert.equal(validateReturnVerification(redigest(changed)).ok, false);
    }
  });

  it('rejects embedded cross-task and repository-evidence reuse plus canonical path mismatch', () => {
    const { record } = fixture();
    const changed = structuredClone(record);
    changed.evidence.repositoryEvidence.task.id = 'T-002';
    changed.repositoryEvidenceDigest = repositoryEvidenceDigest(changed.evidence.repositoryEvidence);
    assert.equal(validateReturnVerification(redigest(changed)).ok, false);
    assert.equal(validateReturnVerification(record, {
      path: returnVerificationPath(record).replace('T-001--', 'T-002--'),
    }).ok, false);
  });

  it('is idempotent for an identical deterministic retry and rejects conflicting content', () => {
    const { record } = fixture('T-RETRY');
    assert.equal(writeReturnVerification(root, record).disposition, 'created');
    assert.equal(writeReturnVerification(root, record).disposition, 'already_current');
    const conflict = structuredClone(record);
    conflict.evidence.repositoryEvidence.branch = 'conflicting-branch';
    conflict.repositoryEvidenceDigest = repositoryEvidenceDigest(conflict.evidence.repositoryEvidence);
    assert.equal(writeReturnVerification(root, redigest(conflict)).disposition, 'conflict');
  });

  it('requires signed committed replay state for authenticated retries, listing, revalidation, and recognition', () => {
    const { adapter, authority, record } = authenticatedFixture('T-AUTH-RETRY', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000041',
      returnId: 'return:00000000-0000-4000-8000-000000000042',
    });
    const first = writeReturnVerification(root, record, { trustedAdapter: adapter, executionReceiptReplayAuthority: authority });
    assert.equal(first.disposition, 'created', first.errors?.join('; '));
    assert.equal(writeReturnVerification(root, record, {
      trustedAdapter: adapter, executionReceiptReplayAuthority: authority,
    }).disposition, 'already_current', 'same record must not re-consume the committed receipt');
    const context = {
      resolveTrustedAdapter: () => adapter,
      resolveExecutionReceiptReplayAuthority: () => authority,
    };
    assert.equal(listReturnVerifications(root, 'T-AUTH-RETRY', context).records.length, 1);
    assert.equal(revalidateReturnVerification(record, {
      target: root, resolveActivationBinding: () => ({ ok: true, errors: [] }), resolveTrustedAdapter: () => adapter,
      executionReceiptReplayAuthority: authority, capabilities: {},
    }).ok, true);
    const unsafeRecognition = recognizeStoredReturnHandoff({
      target: root, transition: 'acceptance',
      expectation: { backend: 'files', taskId: 'T-AUTH-RETRY', roleId: 'engineer', minimumReturnAssurance: 'host_receipt' },
      validatePreparedDispatch: () => ({ ok: true, errors: [] }),
    });
    assert.equal(unsafeRecognition.recognized, false, 'recognition without protected replay authority must fail closed');

    for (const transition of ['review_entry', 'acceptance', 'integration', 'closeout']) {
      const raw = recognizeHandoff({
        transition,
        expectation: { backend: 'files', taskId: 'T-AUTH-RETRY', roleId: 'engineer', minimumReturnAssurance: 'host_receipt' },
        verifiedReturn: record,
        validatePreparedDispatch: () => ({ ok: true, errors: [] }),
      });
      assert.equal(raw.recognized, false, `${transition} must refuse an authenticated record without external verification`);
      assert.match(raw.diagnostics.map(item => item.message).join('\n'), /current external verification/);

      for (const failure of ['signed execution receipt is invalid', 'committed replay state is no longer current']) {
        const refused = recognizeHandoff({
          transition,
          expectation: { backend: 'files', taskId: 'T-AUTH-RETRY', roleId: 'engineer', minimumReturnAssurance: 'host_receipt' },
          verifiedReturn: record,
          validatePreparedDispatch: () => ({ ok: true, errors: [] }),
          validateVerifiedReturn: () => ({ ok: false, errors: [failure], evidenceState: 'stale' }),
        });
        assert.equal(refused.recognized, false, `${transition} must not mutate/authorize on ${failure}`);
      }
    }
  });

  it('rejects a correctly re-signed execution receipt for the wrong authoritative work unit', () => {
    const fixture = authenticatedFixture('T-AUTH-WORK-UNIT', {
      workUnit: 'milestone:current',
      packetId: 'dispatch:00000000-0000-4000-8000-000000000043',
      returnId: 'return:00000000-0000-4000-8000-000000000044',
    });
    const receipt = structuredClone(fixture.executionReceipt);
    receipt.task.workUnitIdentity = 'milestone:other';
    receipt.authentication.value = signHostPayload(
      hostExecutionReceiptSignaturePayload(receipt),
      fixture.privateKey
    );
    assert.throws(() => verifyHostExecutionReceipt(receipt, {
      trustedAdapter: fixture.adapter,
      packet: fixture.packet,
      roleReturn: fixture.roleReturn,
      repositoryEvidence: fixture.repositoryEvidence,
      target: root,
      readExecutionArtifact: path => JSON.parse(readFileSync(join(root, path), 'utf8')),
    }), /does not bind the exact return generation/);
  });

  it('retains committed replay state when the authority adapter is reconstructed', () => {
    const fixture = authenticatedFixture('T-AUTH-RESTART', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000045',
      returnId: 'return:00000000-0000-4000-8000-000000000046',
    });
    assert.equal(writeReturnVerification(root, fixture.record, {
      trustedAdapter: fixture.adapter,
      executionReceiptReplayAuthority: fixture.authority,
    }).disposition, 'created');

    // Reconstruct the adapter around the same test-only host store, as a new CLI
    // process would reconnect to durable protected host replay state.
    const restartedAuthority = createExecutionReceiptReplayAuthority({
      target: root,
      trustedAdapter: fixture.adapter,
      protectedBoundary: fixture.boundary,
    });
    const listed = listReturnVerifications(root, 'T-AUTH-RESTART', {
      resolveTrustedAdapter: () => fixture.adapter,
      resolveExecutionReceiptReplayAuthority: () => restartedAuthority,
    });
    assert.equal(listed.ok, true, listed.errors.join('; '));
    assert.equal(listed.records.length, 1);
  });

  it('fails closed when commit recovery leaves an authenticated target residual or abort cannot be confirmed', () => {
    const residual = authenticatedFixture('T-AUTH-RESIDUAL', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000051',
      returnId: 'return:00000000-0000-4000-8000-000000000052',
    });
    const failCommit = {
      prepare: binding => residual.authority.prepare(binding),
      commit: () => ({ ok: false, error: 'commit transport failed' }),
      abort: (binding, tx) => residual.authority.abort(binding, tx),
      verify: binding => residual.authority.verify(binding),
    };
    const result = writeReturnVerification(root, residual.record, {
      trustedAdapter: residual.adapter, executionReceiptReplayAuthority: failCommit,
      mutationExecutor(target, mutations) {
        if (mutations[0].type === 'remove') return { ok: false, errors: ['rollback denied'], rollbackErrors: [] };
        return executeMutationBatch(target, mutations);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.recovery.type, 'commit_failed_recovery_incomplete');
    assert.equal(writeReturnVerification(root, residual.record, {
      trustedAdapter: residual.adapter, executionReceiptReplayAuthority: residual.authority,
    }).ok, false, 'a residual target must not take an unsafe already_current path');
    const listed = listReturnVerifications(root, 'T-AUTH-RESIDUAL', {
      resolveTrustedAdapter: () => residual.adapter,
      resolveExecutionReceiptReplayAuthority: () => residual.authority,
    });
    assert.equal(listed.records.length, 0);

    const aborted = authenticatedFixture('T-AUTH-ABORT', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000061',
      returnId: 'return:00000000-0000-4000-8000-000000000062',
    });
    const abortFailure = {
      prepare: binding => aborted.authority.prepare(binding), commit: () => ({ ok: false }),
      abort: () => ({ ok: false, error: 'abort unavailable' }), verify: binding => aborted.authority.verify(binding),
    };
    const writeFailure = writeReturnVerification(root, aborted.record, {
      trustedAdapter: aborted.adapter, executionReceiptReplayAuthority: abortFailure,
      mutationExecutor: () => ({ ok: false, errors: ['write denied'], rollbackErrors: [] }),
    });
    assert.equal(writeFailure.ok, false);
    assert.equal(writeFailure.recovery.type, 'write_failed_abort_unconfirmed');
    assert.equal(writeReturnVerification(root, aborted.record, {
      trustedAdapter: aborted.adapter, executionReceiptReplayAuthority: aborted.authority,
    }).ok, false, 'a prepared host replay cannot be retried as a new consumption');
  });

  it('binds selection to the expected work unit and keeps only the latest terminal observation', () => {
    const old = fixture('T-GENERATION', 'files', {
      workUnit: 'milestone:old',
      verifiedAt: '2025-08-09T10:00:00.000Z',
    }).record;
    const current = fixture('T-GENERATION', 'files', {
      workUnit: 'milestone:current',
      packetId: 'dispatch:00000000-0000-4000-8000-000000000011',
      returnId: 'return:00000000-0000-4000-8000-000000000012',
      verifiedAt: '2025-08-09T11:00:00.000Z',
    }).record;
    assert.equal(writeReturnVerification(root, old).ok, true);
    assert.equal(writeReturnVerification(root, current).ok, true);
    const listed = listReturnVerifications(root, 'T-GENERATION', { workUnitIdentity: 'milestone:current' });
    assert.equal(listed.ok, true, listed.errors.join('; '));
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].workUnitIdentity, 'milestone:current');
    assert.equal(listed.supersededCount, 1);
    const replayed = revalidateReturnVerification(current, {
      target: root,
      expectedWorkUnitIdentity: 'milestone:other',
      resolveActivationBinding: () => ({ ok: false, errors: [] }),
      capabilities: {},
    });
    assert.match(replayed.errors.join('; '), /another work unit/);

    const later = fixture('T-LATEST', 'files', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000021',
      returnId: 'return:00000000-0000-4000-8000-000000000022',
      verifiedAt: '2025-08-09T12:00:00.000Z',
    }).record;
    const earlier = fixture('T-LATEST', 'files', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000023',
      returnId: 'return:00000000-0000-4000-8000-000000000024',
      verifiedAt: '2025-08-09T11:00:00.000Z',
    }).record;
    const selected = selectCurrentReturnVerifications([earlier, later]);
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.records.map(item => item.recordId), [later.recordId]);
    assert.equal(selected.supersededCount, 1);
  });

  it('fails closed on equal-time competing terminal observations', () => {
    const left = fixture('T-AMBIGUOUS', 'files', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000031',
      returnId: 'return:00000000-0000-4000-8000-000000000032',
      verifiedAt: '2025-08-09T12:00:00.000Z',
    }).record;
    const right = fixture('T-AMBIGUOUS', 'files', {
      packetId: 'dispatch:00000000-0000-4000-8000-000000000033',
      returnId: 'return:00000000-0000-4000-8000-000000000034',
      verifiedAt: '2025-08-09T12:00:00.000Z',
    }).record;
    const selected = selectCurrentReturnVerifications([left, right]);
    assert.equal(selected.ok, false);
    assert.match(selected.errors.join('; '), /compete as current/);
  });

  it('rejects detached record IDs and future timestamps', () => {
    const { record } = fixture('T-CLOSED');
    const detached = structuredClone(record);
    detached.recordId = 'return-verification:00000000-0000-4000-8000-000000000099';
    assert.equal(validateReturnVerification(redigest(detached)).ok, false);

    const future = structuredClone(record);
    future.verifiedAt = '2999-01-01T00:00:00.000Z';
    assert.equal(validateReturnVerification(redigest(future)).ok, false);
  });

  it('refuses to construct a successful record from a failed verification', () => {
    assert.throws(() => createReturnVerification({ received: { ok: false } }), /successful role-return verification/);
  });

  it('refetches GitHub PR identity and rejects transport drift', () => {
    const head = 'a'.repeat(40);
    const evidence = {
      backend: 'github', branch: 'task/T-001',
      productBaseHead: 'b'.repeat(40), productHead: head, workflowHead: head,
      pr: { state: 'open', number: 42, url: 'https://github.test/o/r/pull/42' },
    };
    const runner = (_command, args) => ({
      status: 0,
      stdout: JSON.stringify({
        number: 42, state: 'OPEN', url: evidence.pr.url,
        headRefOid: head, headRefName: evidence.branch,
      }),
      stderr: '',
    });
    assert.deepEqual(refetchGitHubReturnEvidence(evidence, { commandRunner: runner }), evidence);
    assert.throws(() => refetchGitHubReturnEvidence(evidence, {
      commandRunner: () => ({ status: 0, stdout: JSON.stringify({
        number: 42, state: 'OPEN', url: evidence.pr.url,
        headRefOid: 'b'.repeat(40), headRefName: evidence.branch,
      }), stderr: '' }),
    }), /changed after return evidence/);
    assert.throws(() => refetchGitHubReturnEvidence({ ...evidence, workflowHead: undefined, head }, {
      commandRunner: runner,
    }), /productBaseHead, productHead, and workflowHead/);
    const merged = (_command, _args) => ({
      status: 0,
      stdout: JSON.stringify({
        number: 42, state: 'MERGED', url: evidence.pr.url,
        headRefOid: head, headRefName: evidence.branch,
        mergedAt: '2026-08-10T01:00:00Z', mergeCommit: { oid: 'c'.repeat(40) },
      }),
      stderr: '',
    });
    assert.deepEqual(
      refetchGitHubReturnEvidence(evidence, { commandRunner: merged, historicalCloseout: true }),
      evidence
    );
    assert.throws(() => refetchGitHubReturnEvidence(evidence, {
      commandRunner: () => ({ status: 0, stdout: JSON.stringify({
        number: 42, state: 'CLOSED', url: evidence.pr.url,
        headRefOid: head, headRefName: evidence.branch,
      }), stderr: '' }),
      historicalCloseout: true,
    }), /not a merged terminal PR/);
    assert.throws(() => refetchGitHubReturnEvidence(evidence, {
      commandRunner: () => ({ status: 0, stdout: JSON.stringify({
        number: 42, state: 'MERGED', url: evidence.pr.url,
        headRefOid: 'c'.repeat(40), headRefName: evidence.branch,
        mergedAt: '2026-08-10T01:00:00Z', mergeCommit: { oid: 'd'.repeat(40) },
      }), stderr: '' }),
      historicalCloseout: true,
    }), /changed after return evidence/);
  });

   it('freshly revalidates real standard and hardened return evidence', async () => {
    for (const grade of ['session_reported', 'host_receipt']) {
       const dispatch = await createDispatchFixture(root, `real-${grade}`, {
         requiredChecksText: '- [RC-1] command: `node --version`',
       });
      if (grade === 'session_reported') {
        dispatch.options.returnAdapter = null;
        dispatch.options.assurancePolicy = { mode: 'standard', policySource: 'default' };
      }
      const prepared = prepare(dispatch);
      assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
      const recognition = recognizeHandoff({
        transition: 'role_start',
        expectation: {
          backend: 'files', taskId: 'T-001', roleId: 'engineer',
          taskContractDigest: prepared.packet.task.contractDigest,
          carrierDigest: prepared.packet.task.digest,
          packetId: prepared.packet.packetId, packetDigest: prepared.packet.digest,
          workUnitIdentity: prepared.packet.decomposition.workUnitId,
          artifactHead: prepared.packet.repository.head,
          worktreeRoot: prepared.packet.repository.worktree,
          minimumActivationAssurance: 'operator_confirmed',
        },
        preparedDispatch: prepared.packet,
        validatePreparedDispatch: fixtureDispatchValidator(dispatch),
      });
      assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
      const consumption = createDispatchConsumption({ backend: 'files', taskId: 'T-001', recognition });
      writeFileSync(join(dispatch.root, 'src', 'existing.js'), `export const grade = '${grade}';\n`, 'utf8');
      git(dispatch.root, ['add', 'src/existing.js']);
      git(dispatch.root, ['commit', '-m', `verify ${grade}\n\nTask: T-001\nAgent: engineer`]);
      const productHead = git(dispatch.root, ['rev-parse', 'HEAD']);
      const consumptionPath = dispatchConsumptionRelativePath(consumption);
      mkdirSync(join(dispatch.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001'), { recursive: true });
      writeFileSync(join(dispatch.root, consumptionPath), `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');
      git(dispatch.root, ['add', '-f', '.agenticloop/handoffs']);
      git(dispatch.root, ['commit', '-m', `record dispatch consumption for ${grade}\n\nTask: T-001\nAgent: maintainer`]);
      const workflowHead = git(dispatch.root, ['rev-parse', 'HEAD']);
       const evidence = repositoryEvidence(prepared.packet, {
         head: productHead,
         checks: [{
           id: 'RC-1', kind: 'command', command: 'node --version', outcome: 'passed',
           exitCode: 0, evidence: 'node is available',
         }],
       });
      evidence.workflowHead = workflowHead;
      evidence.workflowChangedPaths = [consumptionPath];
      evidence.productAttribution = {
        range: { base: prepared.packet.repository.head, head: productHead },
        commits: git(dispatch.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${productHead}`])
          .split(/\r?\n/).filter(Boolean),
      };
      evidence.carrierLineage = {
        dispatchConsumptionDigest: consumption.digest,
        evidenceMutationReceiptDigests: [],
      };
      const roleReturn = readyReturn(prepared.packet, evidence);
      const binding = grade === 'host_receipt'
        ? producerBinding(dispatch.trust, prepared.packet, roleReturn, evidence)
        : { producerReceipt: null, resolveTrustedAdapter: () => dispatch.trust.adapter };
      const received = receiveRoleReturn({
        raw: JSON.stringify(roleReturn), packet: prepared.packet,
        refetchTask: dispatch.refetchTask,
        refetchRepositoryEvidence: () => evidence,
        producerReceipt: binding.producerReceipt,
        resolveTrustedAdapter: binding.resolveTrustedAdapter,
        runGit: dispatch.runGit,
      }, {
        ...dispatch.options,
        minimumReturnAssurance: grade,
      });
      assert.equal(received.ok, true, received.validation.errors?.join('\n'));
      assert.equal(received.returnAssurance, grade);
      const record = createReturnVerification({
        target: dispatch.root, packet: prepared.packet, roleReturn,
        repositoryEvidence: evidence, producerReceipt: binding.producerReceipt, received,
      });
      const stored = writeReturnVerification(dispatch.root, record);
      assert.equal(stored.ok, true, stored.errors.join('\n'));
      const revalidated = revalidateReturnVerification(record, {
        target: dispatch.root,
        capabilities: dispatch.options.capabilities,
        resolveActivationBinding: () => ({ ok: false, errors: [] }),
        resolveTrustedAdapter: binding.resolveTrustedAdapter,
        expectedBackend: 'files', expectedTaskId: 'T-001',
        expectedTaskContractDigest: prepared.packet.task.taskContractDigest,
        expectedActivationAuthorityDigest: record.activationAuthorityDigest,
        expectedWorkUnitIdentity: record.workUnitIdentity,
        refetchTask: dispatch.refetchTask,
        refetchRepositoryEvidence: () => evidence,
        runGit: dispatch.runGit,
        minimumReturnAssurance: grade,
      });
      assert.equal(revalidated.ok, true, revalidated.errors.join('\n'));

      const taskBody = readFileSync(dispatch.taskPath, 'utf8');
      writeFileSync(dispatch.taskPath, taskBody.replace('status: agent-ready', 'status: in-progress'), 'utf8');
      git(dispatch.root, ['add', '.agenticloop/tasks/T-001.md']);
      git(dispatch.root, ['commit', '-m', `advance lifecycle after ${grade}\n\nTask: T-001\nAgent: maintainer`]);

      const closeout = resolveCloseoutAssuranceContext(dispatch.root, {
        operatorTrustRoot: dispatch.operatorTrustRoot,
        hostAuthority: protectedHostBoundary(dispatch.trust),
      }, 'files', {
        config: loadProjectMap(dispatch.root).config,
        workUnit: record.workUnitIdentity,
      });
      assert.ok(closeout, 'closeout assurance context should resolve');
       const observed = closeout.resolveReturns('T-001');
        assert.equal(observed.usable, true, observed.reasons.join('\n'));
        assert.equal(observed.records.length, 1);
       if (grade === 'session_reported') {
        const wrongWorkUnit = resolveCloseoutAssuranceContext(dispatch.root, {
          operatorTrustRoot: dispatch.operatorTrustRoot,
          hostAuthority: protectedHostBoundary(dispatch.trust),
        }, 'files', {
          config: loadProjectMap(dispatch.root).config,
          workUnit: 'milestone:unrelated',
        }).resolveReturns('T-001');
        assert.equal(wrongWorkUnit.usable, false);
        assert.equal(wrongWorkUnit.failureCategory, 'return_for_another_generation');
      }
    }
  });

  it('classifies v3 return verification as incompatible with resume route', async () => {
    const v3Record = structuredClone(fixture('T-V3-COMPATIBILITY').record);
    v3Record.schemaVersion = 3;
    const { classifyLifecycleCompatibility } = await import('../src/lifecycle-compatibility.js');
    const compat = classifyLifecycleCompatibility(v3Record, 'agenticloop.return-verification');
    assert.equal(compat.state, 'incompatible');
    assert.equal(compat.route, 'resume_with_current_evidence');
    assert.equal(compat.reason, 'unsupported_legacy_version');
    assert.equal(compat.observedVersion, 3);
  });

  it('rejects v3 return verification at list and recognition boundaries', () => {
    const store = join(root, 'v3-boundary-test');
    mkdirSync(store, { recursive: true });
    const v3Dir = join(store, RETURN_VERIFICATION_ROOT);
    mkdirSync(v3Dir, { recursive: true });
    const v3Record = structuredClone(fixture('T-V3').record);
    v3Record.schemaVersion = 3;
    const name = returnVerificationPath(v3Record).split('/').at(-1);
    writeFileSync(join(v3Dir, name), JSON.stringify(v3Record));
    const listed = listReturnVerifications(store, 'T-V3');
    assert.equal(listed.records.length, 0, 'v3 records must not appear as current');
    assert.ok(listed.errors.some(e => e.includes('unsupported_legacy_version')), 'must report v3 as incompatible');

    // Recognition must also reject v3
    const verdict = recognizeStoredReturnHandoff({
      target: store, transition: 'closeout',
      expectation: { backend: 'files', taskId: 'T-V3', roleId: 'engineer', minimumReturnAssurance: 'session_reported' },
    });
    assert.equal(verdict.recognized, false, 'v3 must not be recognized');
    assert.ok(verdict.diagnostics.some(item => item.evidence?.reason === 'unsupported_legacy_version'));
  });

  it('rejects a future-version record when listing return evidence', () => {
    const store = join(root, 'future-version-list-boundary');
    const directory = join(store, RETURN_VERIFICATION_ROOT);
    mkdirSync(directory, { recursive: true });
    const futureRecord = structuredClone(fixture('T-FUTURE-VERSION').record);
    futureRecord.schemaVersion = 99;
    const name = returnVerificationPath(futureRecord).split('/').at(-1);
    writeFileSync(join(directory, name), JSON.stringify(futureRecord));

    const listed = listReturnVerifications(store, 'T-FUTURE-VERSION');
    assert.equal(listed.ok, false);
    assert.equal(listed.records.length, 0);
    assert.deepEqual(listed.diagnostics, [{
      name,
      reason: 'unsupported_new_version',
      observedVersion: 99,
    }]);
  });

  it('fails closeout assurance when its only return record is incompatible v3 evidence', async () => {
    const dispatch = await createDispatchFixture(root, 'closeout-v3-boundary');
    const v3Record = structuredClone(fixture('T-001').record);
    v3Record.schemaVersion = 3;
    const prepared = prepare(dispatch);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    v3Record.evidence.packet = prepared.packet;
    v3Record.taskContractDigest = prepared.packet.task.taskContractDigest;
    v3Record.dispatchCarrierDigest = prepared.packet.task.dispatchCarrierDigest;
    v3Record.taskId = prepared.packet.task.id;
    const directory = join(dispatch.root, RETURN_VERIFICATION_ROOT);
    mkdirSync(directory, { recursive: true });
    const name = returnVerificationPath(v3Record).split('/').at(-1);
    writeFileSync(join(directory, name), JSON.stringify(v3Record));

    const closeout = resolveCloseoutAssuranceContext(dispatch.root, {
      operatorTrustRoot: dispatch.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(dispatch.trust),
    }, 'files', {
      config: loadProjectMap(dispatch.root).config,
      workUnit: prepared.packet.decomposition.workUnitId,
    });
    assert.ok(closeout, 'closeout assurance context should resolve');
    const observed = closeout.resolveReturns('T-001');
    assert.equal(observed.usable, false);
    assert.equal(observed.failureCategory, 'return_evidence_malformed');
    assert.match(observed.reasons.join('; '), /unsupported_legacy_version/);
  });

  it('uses only not_applicable assurance without spawning for command-free tasks', () => {
    const { record } = fixture('T-NO-CMD', 'files', { requiredChecks: [], checks: [] });
    assert.equal(record.requiredCheckEvidenceAssurance, 'not_applicable');
    const executionLog = [];
    const checked = revalidateReturnVerification(record, {
      target: root,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      capabilities: {},
      runGit: (...args) => { executionLog.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.equal(executionLog.length, 0);

    const forged = structuredClone(record);
    forged.requiredCheckEvidenceAssurance = 'unverified';
    forged.returnGenerationDigest = returnGenerationDigest(forged);
    assert.equal(validateReturnVerification(redigest(forged)).ok, false);
  });

  it('uses only not_applicable assurance without spawning for manual-only tasks', () => {
    const { record } = fixture('T-MANUAL', 'files', {
      requiredChecks: [{ id: 'MC-1', kind: 'manual', instruction: 'Verify manually' }],
      checks: [{ id: 'MC-1', kind: 'manual', instruction: 'Verify manually', outcome: 'passed', evidence: 'Manually verified' }],
    });
    assert.equal(record.requiredCheckEvidenceAssurance, 'not_applicable');
    const executionLog = [];
    const checked = revalidateReturnVerification(record, {
      target: root,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      capabilities: {},
      runGit: (...args) => { executionLog.push(args); return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.equal(executionLog.length, 0);

    const forged = structuredClone(record);
    forged.requiredCheckEvidenceAssurance = 'unverified';
    forged.returnGenerationDigest = returnGenerationDigest(forged);
    assert.equal(validateReturnVerification(redigest(forged)).ok, false);
  });

  it('persists blocked observations without allowing lifecycle promotion', () => {
    const { packet, roleReturn, repositoryEvidence } = fixture('T-BLOCKED');
    roleReturn.disposition = 'blocked';
    roleReturn.blocker = { category: 'defects_found', detail: 'implementation has defects' };
    const blockedRecord = createReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
    });
    assert.equal(blockedRecord.disposition, 'blocked');
    assert.equal(validateReturnVerification(blockedRecord).ok, true);
    assert.equal(writeReturnVerification(root, blockedRecord).ok, true);
    const listed = listReturnVerifications(root, 'T-BLOCKED');
    assert.equal(listed.ok, true, listed.errors.join('; '));
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].disposition, 'blocked');

    const checked = revalidateReturnVerification(blockedRecord, {
      target: root,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      capabilities: {},
    });
    assert.equal(checked.ok, false, 'blocked return must not authorize protected transition');
    assert.match(checked.errors.join('; '), /blocked role return observation cannot authorize/);
    for (const transition of ['review_entry', 'acceptance', 'integration', 'closeout']) {
      const verdict = recognizeStoredReturnHandoff({
        target: root, transition,
        expectation: { backend: 'files', taskId: 'T-BLOCKED', roleId: 'engineer', minimumReturnAssurance: 'session_reported' },
        validatePreparedDispatch: () => ({ ok: true, errors: [] }),
      });
      assert.equal(verdict.recognized, false, transition);
    }
    const promoted = structuredClone(blockedRecord);
    promoted.disposition = 'successful_current';
    promoted.returnGenerationDigest = returnGenerationDigest(promoted);
    assert.equal(validateReturnVerification(redigest(promoted)).ok, false);
  });

  it('rejects createReturnVerification with caller-supplied authenticated_receipt', () => {
    const { packet, roleReturn, repositoryEvidence } = fixture('T-NO-AUTH');
    assert.throws(() => createReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
      requiredCheckEvidenceAssurance: 'authenticated_receipt',
    }), /cannot issue authenticated execution assurance/);
  });

  it('rejects process-local WeakSet marker as provenance', () => {
    const { record } = fixture('T-WEAKSET');
    // A WeakSet or similar marker cannot authenticate a record
    const forged = structuredClone(record);
    forged.requiredCheckEvidenceAssurance = 'authenticated_receipt';
    forged.returnGenerationDigest = returnGenerationDigest(forged);
    assert.equal(validateReturnVerification(redigest(forged)).ok, false);
  });

  it('issues authenticated assurance only from a protected receipt that re-reads the signed execution artifact', () => {
    const { packet, roleReturn, repositoryEvidence } = fixture('T-AUTH-EXECUTION');
    packet.returnAdapter = { adapterId: 'test-adapter', keyId: 'test-key' };
    const evidence = produceExecutionEvidence({
      checkId: 'RC-1', instruction: 'node --version', command: 'node', args: ['--version'],
      carrierRoot: root, artifactWorktreeRoot: root, workingDirectory: root, projectScratchRoot: join(root, '.agenticloop', 'tmp'),
      binding: {
        packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId, taskId: packet.task.id,
        taskContractDigest: roleReturn.task.taskContractDigest, currentCarrierDigest: roleReturn.task.currentCarrierDigest,
        repositoryHead: repositoryEvidence.workflowHead, productHead: roleReturn.productHead,
      },
    }, { run: () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) });
    const artifactPath = '.agenticloop/tmp/auth-execution.json';
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, artifactPath), JSON.stringify(evidence));
    roleReturn.checks[0].executionEvidence = { path: artifactPath, digest: evidence.digest };
    const { privateKey, publicKeyBase64 } = generateHostSigningKey();
    const adapter = {
      adapterId: 'test-adapter', keyId: 'test-key', publicKey: publicKeyBase64,
      repositoryIdentity: targetRepositoryIdentity(root), capabilities: { returnReceipt: 'supported' },
    };
    const receipt = createHostExecutionReceipt({
      adapterId: adapter.adapterId, keyId: adapter.keyId, packet, roleReturn, repositoryEvidence,
      executions: [{ checkId: 'RC-1', path: artifactPath, digest: evidence.digest, logicalCommand: 'node', args: ['--version'], resolvedExecutable: 'node', wrapperKind: 'native', wrapperProgram: null, wrapperArgs: [], childExitCode: 0 }],
      replayId: 'host-observation:auth-execution-1',
    }, privateKey);
    const producerReceipt = createHostHandoffReceipt({
      adapterId: adapter.adapterId, keyId: adapter.keyId, packet, roleReturn,
      repositoryEvidence, observedProducerRole: 'engineer',
    }, privateKey);
    const record = createAuthenticatedReturnVerification({
      target: root, packet, roleReturn, repositoryEvidence, received: { ok: true, returnAssurance: 'host_receipt' },
      producerReceipt,
      executionReceipt: receipt, trustedAdapter: adapter,
    });
    assert.equal(record.requiredCheckEvidenceAssurance, 'authenticated_receipt');
    writeFileSync(join(root, artifactPath), JSON.stringify({ ...evidence, digest: 'sha256:forged' }));
    const checked = revalidateReturnVerification(record, {
      target: root, resolveActivationBinding: () => ({ ok: true, errors: [] }), resolveTrustedAdapter: () => adapter, capabilities: {},
    });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /artifact 'RC-1' drifted/);
  });

  it('rejects a forged target-owned producer authentication at validation and recognition boundaries', () => {
    const { record } = fixture('T-FORGED-PRODUCER');
    const forged = structuredClone(record);
    forged.observedReturnGrade = 'host_receipt';
    forged.producerAuthentication = { adapterId: 'fake-adapter', keyId: 'fake-key' };
    forged.evidence.producerIdentityAuthenticated = true;
    forged.evidence.producerReceipt = {
      adapterId: 'fake-adapter', authentication: { keyId: 'fake-key' }, producerRole: 'engineer',
    };
    forged.evidence.packet.returnAdapter = { adapterId: 'target-adapter', keyId: 'target-key' };
    forged.returnGenerationDigest = returnGenerationDigest(forged);
    const persisted = redigest(forged);
    assert.equal(validateReturnVerification(persisted).ok, false);
    const checked = revalidateReturnVerification(persisted, {
      target: root,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
      resolveTrustedAdapter: () => ({ keyId: 'target-key' }),
      capabilities: {},
    });
    assert.equal(checked.ok, false);
    const verdict = recognizeHandoff({
      transition: 'acceptance',
      expectation: { backend: 'files', taskId: 'T-FORGED-PRODUCER', roleId: 'engineer', minimumReturnAssurance: 'session_reported' },
      verifiedReturn: persisted,
      validatePreparedDispatch: () => ({ ok: true, errors: [] }),
    });
    assert.equal(verdict.recognized, false);
    assert.match(verdict.diagnostics.map(item => item.message).join('; '), /authenticated producer identity/);
  });
});
