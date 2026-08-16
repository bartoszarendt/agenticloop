import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTaskReadinessEvidence } from '../src/task-evidence-contract.js';
import { createTaskContractBaselineRecord, renderTaskContractRecord, taskContractDigest } from '../src/task-contract-baseline.js';
import {
  carrierMutationRelativePath,
  createDispatchConsumption,
  dispatchConsumptionRelativePath,
  resolveCarrierLineage,
} from '../src/handoff-consumption.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createReturnVerification, listReturnVerifications, writeReturnVerification } from '../src/return-verification.js';
import { receiveRoleReturn } from '../src/dispatch-envelope.js';
import { taskBodyDigest } from '../src/github-task-body.js';
import { createDispatchFixture, git, prepare, producerBinding, readyReturn, repositoryEvidence } from './helpers/dispatch-fixture.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

const ISSUE = 42;
const PR = 42;
let temp;

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-integration-routes-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function acceptedBody(source, integratedBy = '') {
  let body = source
    .replace('backend: files', 'backend: github')
    .replace('status: agent-ready', 'status: accepted');
  if (/^integrated_by:/m.test(body)) body = body.replace(/^integrated_by:.*$/m, `integrated_by: ${integratedBy}`);
  else body = body.replace('status: accepted', `status: accepted\nintegrated_by: ${integratedBy}`);
  return `${body.replace(/\s*\[\[agent: maintainer\]\]\s*$/i, '')}\n\n[[agent: maintainer]]\n`;
}

function trustedBaseline(body) {
  const contract = taskContractDigest(body);
  const text = renderTaskContractRecord(createTaskContractBaselineRecord({
    recordId: 'task-contract-record:00000000-0000-4000-8000-000000000042',
    taskId: 'T-001', digest: contract.digest, projection: contract.projection,
    authority: 'policy:T-001', actor: 'maintainer',
    timestamp: '2026-08-10T00:00:00.000Z', affectedArtifact: `issue:${ISSUE}`,
  }));
  return {
    id: 420, html_url: 'https://example.test/comments/420', user: { login: 'maintainer' },
    author_association: 'MEMBER', created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z', body: text,
  };
}

function transport(state) {
  return (_command, args) => {
    if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'maintainer' }) };
    if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[trustedBaseline(state.body)]]) };
    if (args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ number: ISSUE, body: state.body, labels: [] }) };
    }
    if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
      state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      state.bodyWrites += 1;
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const requested = Number(args[2]);
      const number = state.returnWrongPr ? PR + 1 : requested;
      const head = state.returnWrongHead ? 'f'.repeat(40) : state.head;
      return { status: 0, stdout: JSON.stringify({
        number, state: 'OPEN', url: `https://example.test/pull/${requested}`,
        headRefOid: head, headRefName: 'task/T-001',
      }) };
    }
    return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
  };
}

async function setField(fixture, state, field, value) {
  return runCliInProcess([
    'task-body', 'set-field', '--issue', String(ISSUE), '--field', field, '--value', value,
    '--expect-digest', taskBodyDigest(state.body), '--repo', 'example/repo', '--yes', '--json',
    '--target', fixture.root,
  ], {
    ghCommandRunner: transport(state), operatorTrustRoot: fixture.operatorTrustRoot,
    hostAuthority: protectedHostBoundary(fixture.trust),
  });
}

describe('canonical handoff GitHub integration public routes', () => {
  it('guards first integration, overwrite, clearing, PR/head identity, and compound acceptance without refusal writes', async () => {
    const fixture = await createDispatchFixture(temp, 'github-integration-routes');
    const original = readFileSync(fixture.taskPath, 'utf8');
    const state = { body: acceptedBody(original), bodyWrites: 0, head: 'a'.repeat(40), returnWrongPr: false, returnWrongHead: false };

    state.body = acceptedBody(original).replace('status: accepted', 'status: in-progress');
    const bundledAcceptance = await runCliInProcess([
      'task-body', 'transition', '--issue', String(ISSUE), '--status', 'accepted',
      '--expect-digest', taskBodyDigest(state.body), '--note', 'Do not publish this note.',
      '--label', 'status:accepted', '--repo', 'example/repo', '--yes', '--json',
      '--target', fixture.root,
    ], { ghCommandRunner: transport(state) });
    assert.equal(bundledAcceptance.status, 1);
    assert.match(bundledAcceptance.stdout, /acceptance must not bundle notes or labels/);
    assert.equal(state.bodyWrites, 0, 'a protected acceptance cannot partially publish side projections');

    state.body = acceptedBody(original);

    const noChainFirst = await setField(fixture, state, 'integrated_by', `pr:${PR}@${'a'.repeat(40)}`);
    assert.equal(noChainFirst.status, 1);
    assert.match(noChainFirst.stdout, /no durable canonical dispatch consumption/);
    assert.equal(state.bodyWrites, 0, 'first integration refusal must not edit the remote body');

    state.body = acceptedBody(original, `pr:${PR}@${'b'.repeat(40)}`);
    const noChainOverwrite = await setField(fixture, state, 'integrated_by', `pr:${PR}@${'a'.repeat(40)}`);
    assert.equal(noChainOverwrite.status, 1);
    assert.match(noChainOverwrite.stdout, /no durable canonical dispatch consumption/);
    assert.equal(state.bodyWrites, 0, 'overwrite refusal must not edit the remote body');

    const clearing = await setField(fixture, state, 'integrated_by', '');
    assert.equal(clearing.status, 1);
    assert.match(clearing.stdout, /clearing authoritative integrated_by evidence is not supported/);
    assert.equal(state.bodyWrites, 0, 'clearing refusal must not edit the remote body');

    state.body = acceptedBody(original);
    state.returnWrongPr = true;
    const wrongPr = await setField(fixture, state, 'integrated_by', `pr:${PR}@${'a'.repeat(40)}`);
    assert.equal(wrongPr.status, 1);
    assert.match(wrongPr.stdout, /does not match current PR/);
    assert.equal(state.bodyWrites, 0, 'wrong-PR refusal must not edit the remote body');

    state.returnWrongPr = false;
    state.returnWrongHead = true;
    const wrongHead = await setField(fixture, state, 'integrated_by', `pr:${PR}@${'a'.repeat(40)}`);
    assert.equal(wrongHead.status, 1);
    assert.match(wrongHead.stdout, /does not match current PR/);
    assert.equal(state.bodyWrites, 0, 'wrong-head refusal must not edit the remote body');

    state.returnWrongHead = false;
    state.body = original
      .replace('backend: files', 'backend: github')
      .replace('status: agent-ready', 'status: in-progress');
    const compoundPath = join(fixture.root, '.agenticloop', 'tmp', 'compound.md');
    mkdirSync(join(compoundPath, '..'), { recursive: true });
    writeFileSync(compoundPath, acceptedBody(original, `pr:${PR}@${'a'.repeat(40)}`), 'utf8');
    const compound = await runCliInProcess([
      'task-body', 'apply', '--issue', String(ISSUE), '--body-file', compoundPath,
      '--expect-digest', taskBodyDigest(state.body), '--repo', 'example/repo', '--yes', '--json',
      '--target', fixture.root,
    ], { ghCommandRunner: transport(state) });
    assert.equal(compound.status, 1);
    assert.match(compound.stdout, /compound acceptance plus integration mutation is refused/);
    assert.equal(state.bodyWrites, 0, 'compound refusal must not edit the remote body');

    // Integration follows a separately guarded acceptance. The accepted carrier
    // is the current generation observed by the integration boundary.
    state.body = acceptedBody(original);
    // The packet is prepared from the dispatchable carrier this task actually
    // had when its execution attempt started; `state.body` stays the accepted
    // carrier the later integration boundary observes. A packet can never be
    // minted from a terminal status, so the two must not be the same document.
    const dispatchBody = acceptedBody(original).replace('status: accepted', 'status: agent-ready');
    const initial = {
      ...fixture.snapshot(),
      body: dispatchBody,
      digest: taskBodyDigest(dispatchBody),
    };
    const githubFixture = {
      ...fixture,
      refetchTask: () => ({ ...initial, backend: 'github', carrier: `issue:${ISSUE}` }),
      assignment: { ...fixture.assignment, canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'] },
      readiness: {
        ...fixture.readiness,
        evidence: createTaskReadinessEvidence({
          ...fixture.readiness.evidence,
          backend: 'github', task: { id: 'T-001', carrier: `issue:${ISSUE}`, expectedDigest: initial.digest },
        }),
      },
    };
    githubFixture.refetchReadiness = () => githubFixture.readiness;
    const prepared = prepare(githubFixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));

    const recognition = recognizeHandoff({
      transition: 'role_start',
      expectation: {
        backend: 'github', taskId: 'T-001', roleId: 'engineer',
        taskContractDigest: prepared.packet.task.contractDigest,
        carrierDigest: prepared.packet.task.digest, packetId: prepared.packet.packetId,
        packetDigest: prepared.packet.digest, workUnitIdentity: prepared.packet.decomposition.workUnitId,
        worktreeRoot: prepared.packet.repository.worktree, minimumActivationAssurance: 'operator_confirmed',
      },
      preparedDispatch: prepared.packet,
      validatePreparedDispatch: fixtureDispatchValidator(fixture),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
    const consumption = createDispatchConsumption({ backend: 'github', taskId: 'T-001', recognition });
    const consumptionPath = join(fixture.root, dispatchConsumptionRelativePath(consumption));
    mkdirSync(join(consumptionPath, '..'), { recursive: true });
    writeFileSync(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');

    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const integrated = true;\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement integration route\n\nTask: T-001\nAgent: engineer']);
    state.head = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, {
      head: state.head,
      pr: { state: 'open', number: PR, url: `https://example.test/pull/${PR}` },
    });
    evidence.productAttribution = {
      range: { base: prepared.packet.repository.head, head: state.head },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${state.head}`]).split(/\r?\n/).filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const binding = producerBinding(fixture.trust, prepared.packet, roleReturn, evidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet,
      refetchTask: githubFixture.refetchTask, refetchRepositoryEvidence: () => evidence,
      producerReceipt: binding.producerReceipt, resolveTrustedAdapter: binding.resolveTrustedAdapter,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
    const verification = createReturnVerification({
      target: fixture.root, packet: prepared.packet, roleReturn, repositoryEvidence: evidence,
      producerReceipt: binding.producerReceipt, received,
      requiredCheckEvidenceAssurance: 'unverified',
    });
    const stored = writeReturnVerification(fixture.root, verification);
    assert.equal(stored.ok, true, stored.errors.join('\n'));

    const currentContract = taskContractDigest(state.body).digest;
    const listed = listReturnVerifications(fixture.root, 'T-001', {
      taskContractDigest: currentContract,
      workUnitIdentity: consumption.workUnitIdentity,
    });
    assert.equal(listed.ok, true, listed.errors.join('\n'));
    assert.equal(listed.records.length, 1, JSON.stringify({
      currentContract, returnContract: verification.taskContractDigest,
      consumedWorkUnit: consumption.workUnitIdentity, returnWorkUnit: verification.workUnitIdentity,
    }));
    const correct = await setField(fixture, state, 'integrated_by', `pr:${PR}@${state.head}`);
    assert.equal(correct.status, 0, `${correct.stdout}\n${correct.stderr}`);
    assert.equal(state.bodyWrites, 1);
    assert.match(state.body, new RegExp(`^integrated_by: ["']?pr:${PR}@${state.head}["']?$`, 'm'));
    assert.equal(JSON.parse(correct.stdout).handoff_recognition.recognized, true);
  });

  it('records bounded GitHub Engineer evidence as a continuous dispatch lineage', async () => {
    const fixture = await createDispatchFixture(temp, 'github-evidence-lineage');
    const original = readFileSync(fixture.taskPath, 'utf8');
    const readyBody = `${original
      .replace('backend: files', 'backend: github')
      .replace(/\[\[agent: [^\]]+\]\]\s*$/i, '')
      .trimEnd()}\n\n[[agent: maintainer]]\n`;
    const state = {
      body: readyBody.replace('status: agent-ready', 'status: in-progress'),
      bodyWrites: 0,
      head: 'a'.repeat(40),
      returnWrongPr: false,
      returnWrongHead: false,
    };
    const readySnapshot = {
      ...fixture.snapshot(),
      body: readyBody,
      digest: taskBodyDigest(readyBody),
    };
    const githubFixture = {
      ...fixture,
      refetchTask: () => ({ ...readySnapshot, backend: 'github', carrier: `issue:${ISSUE}` }),
      assignment: { ...fixture.assignment, canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'] },
      readiness: {
        ...fixture.readiness,
        evidence: createTaskReadinessEvidence({
          ...fixture.readiness.evidence,
          backend: 'github', task: { id: 'T-001', carrier: `issue:${ISSUE}`, expectedDigest: readySnapshot.digest },
        }),
      },
    };
    githubFixture.refetchReadiness = () => githubFixture.readiness;
    const prepared = prepare(githubFixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const recognition = recognizeHandoff({
      transition: 'role_start',
      expectation: {
        backend: 'github', taskId: 'T-001', roleId: 'engineer',
        taskContractDigest: prepared.packet.task.contractDigest,
        carrierDigest: readySnapshot.digest,
        packetId: prepared.packet.packetId, packetDigest: prepared.packet.digest,
        workUnitIdentity: prepared.packet.decomposition.workUnitId,
        worktreeRoot: prepared.packet.repository.worktree,
        minimumActivationAssurance: 'operator_confirmed',
      },
      preparedDispatch: prepared.packet,
      validatePreparedDispatch: fixtureDispatchValidator(fixture),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
    const consumption = createDispatchConsumption({
      backend: 'github', taskId: 'T-001', recognition,
      currentCarrierDigest: taskBodyDigest(state.body),
    });
    const consumptionPath = dispatchConsumptionRelativePath(consumption);
    mkdirSync(join(fixture.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001'), { recursive: true });
    writeFileSync(join(fixture.root, consumptionPath), `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');

    const result = await runCliInProcess([
      'task-body', 'evidence', '--issue', String(ISSUE),
      '--class', 'implementation_summary_evidence',
      '--expect-digest', taskBodyDigest(state.body),
      '--summary', 'Implemented the scoped change.', '--check-evidence', 'npm test passed',
      '--repo', 'example/repo', '--yes', '--json', '--target', fixture.root,
    ], {
      ghCommandRunner: transport(state), operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const published = JSON.parse(result.stdout).engineerEvidence;
    assert.equal(state.bodyWrites, 1);
    assert.equal(published.currentCarrierDigest, taskBodyDigest(state.body));
    assert.ok(existsSync(join(fixture.root, published.receiptPath)));
    assert.deepEqual(
      resolveCarrierLineage(fixture.root, 'T-001', {
        backend: 'github', taskContractDigest: published.taskContractDigest,
        currentCarrierDigest: published.currentCarrierDigest,
      }).receipts.map(receipt => receipt.digest),
      [published.receipt.digest]
    );
    assert.equal(published.receiptPath, carrierMutationRelativePath(published.receipt));
  });
});
