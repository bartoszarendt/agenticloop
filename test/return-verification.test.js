import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RETURN_VERIFICATION_ROOT,
  createReturnVerification,
  listReturnVerifications,
  revalidateReturnVerification,
  returnGenerationDigest,
  returnVerificationPath,
  selectCurrentReturnVerifications,
  validateReturnVerification,
  writeReturnVerification,
} from '../src/return-verification.js';
import { canonicalSha256 } from '../src/canonical-json.js';
import { repositoryEvidenceDigest } from '../src/host-handoff.js';
import { targetRepositoryIdentity } from '../src/host-trust.js';
import { refetchGitHubReturnEvidence } from '../src/github-return-evidence.js';
import { receiveRoleReturn } from '../src/dispatch-envelope.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
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
  function fixture(taskId = 'T-001', backend = 'files', options = {}) {
    const packetId = options.packetId ?? 'dispatch:00000000-0000-4000-8000-000000000001';
    const returnId = options.returnId ?? 'return:00000000-0000-4000-8000-000000000002';
    const repositoryIdentity = targetRepositoryIdentity(root);
    const taskDigest = `sha256:${'c'.repeat(64)}`;
    const contractDigest = `sha256:v1:${'d'.repeat(64)}`;
    const baseHead = '1'.repeat(40);
    const head = '2'.repeat(40);
    const packet = {
      backend: 'files', packetId, digest: `sha256:agenticloop.role-preparation.v7:${'a'.repeat(64)}`,
      task: { id: taskId, taskContractDigest: contractDigest, dispatchCarrierDigest: taskDigest }, activation: null,
      activationBinding: { grant: { repositoryIdentity, digest: 'grant' }, binding: { digest: 'binding' } },
      returnAdapter: null,
      assignment: { roleId: 'engineer', invocationId: 'invocation:fixture' },
      decomposition: options.workUnit
        ? { scan: { workUnit: { id: options.workUnit } } }
        : null,
    };
    packet.backend = backend;
    const roleReturn = {
      returnId, producerRole: 'engineer', digest: `sha256:agenticloop.role-return.v3:${'b'.repeat(64)}`,
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
    return { ...record, digest: `sha256:agenticloop.return-verification.v2:${canonicalSha256(projection)}` };
  }

  it('persists session-reported evidence without claiming authenticated producer identity', () => {
    const { record } = fixture();
    assert.equal(record.producerAuthentication, null);
    assert.equal(record.evidence.producerIdentityAuthenticated, false);
    assert.equal(validateReturnVerification(record).ok, true);
    const written = writeReturnVerification(root, record);
    assert.equal(written.ok, true, written.errors.join('; '));
    assert.match(written.path, new RegExp(`^${RETURN_VERIFICATION_ROOT.replaceAll('.', '\\.')}/T-001--`));
    const listed = listReturnVerifications(root, 'T-001');
    assert.equal(listed.ok, true);
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].observedReturnGrade, 'session_reported');
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
  });

  it('freshly revalidates real standard and hardened return evidence', async () => {
    for (const grade of ['session_reported', 'host_receipt']) {
      const dispatch = await createDispatchFixture(root, `real-${grade}`);
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
      const evidence = repositoryEvidence(prepared.packet, { head: productHead });
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
});
