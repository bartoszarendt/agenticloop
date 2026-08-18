/**
 * P35-C12R.5 characterization: one execution attempt, in real order.
 *
 * Before C12R.5 the closeout fixtures built their evidence backwards. They set
 * a task to `accepted`, committed that, and only then minted the packet that
 * was supposed to have preceded it. Nothing in the product was wrong about the
 * rule - `evaluateDispatchableLifecycle` refused terminal statuses everywhere -
 * but the packet constructor carried a disclosed narrowing so those fixtures
 * kept working, and no test had ever driven a files-backed acceptance through
 * the canonical handoff chain.
 *
 * Driving it revealed the real boundary. The acceptance gate itself requires
 * post-return Maintainer review provenance on the carrier (`review_status`,
 * `review_mode`, `reviewed_artifact`, `## Scope Completed`, `## Evidence`), so
 * the live carrier can never still equal the carrier the Engineer returned.
 * Two carriers therefore exist and must stay distinct:
 *
 *   - the *execution* terminal - the dispatch consumption plus the Engineer's
 *     own receipt chain, which is what a signed return describes; and
 *   - the *live lifecycle* carrier - what review, acceptance, and closeout move
 *     afterwards under their own authority.
 *
 * These cases pin that separation, the real chronological order that produces
 * it, and the refusals that keep either boundary from absorbing the other.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDispatchFixture,
  git as fixtureGit,
  prepare,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './helpers/dispatch-fixture.js';
import { CLOSEOUT_PROJECT_MAP, createCloseoutCliFixture } from './helpers/closeout-cli-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { interactiveOptions } from './helpers/activation-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { produceExecutionEvidence } from '../src/execution-evidence.js';
import {
  carrierMutationRelativePath,
  currentDispatchConsumption,
  resolveCarrierLineage,
} from '../src/handoff-consumption.js';
import { createCarrierMutationReceipt } from '../src/task-evidence-contract.js';
import { writeActivationRevocation } from '../src/activation-store.js';
import { resolvePacketActivationBinding } from '../src/activation-resolution.js';
import { createActivationRevocation } from '../src/activation-grant.js';
import { taskStatusFromBody } from '../src/dispatchability.js';

const TEST_TMP_ROOT = fileURLToPath(new URL('../.agenticloop/tmp/', import.meta.url));

let temp;
before(() => { mkdirSync(TEST_TMP_ROOT, { recursive: true }); temp = mkdtempSync(join(TEST_TMP_ROOT, 'al-c12r5-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function taskFile(root) {
  return join(root, '.agenticloop', 'tasks', 'T-001.md');
}

function carrierDigest(root) {
  return sha256(readFileSync(taskFile(root), 'utf8'));
}

function mutationDirectory(root) {
  return join(root, '.agenticloop', 'handoffs', 'task-mutations', 'T-001');
}

function receiptRecords(root) {
  const directory = mutationDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

/**
 * One genuine attempt in real order, stopping at the verified return.
 *
 * Every step runs through the public command that owns it, so the packet, the
 * consumption, and the Engineer receipt chain are all production artifacts.
 */
async function realOrderAttempt(name, { projectMapContent = CLOSEOUT_PROJECT_MAP } = {}) {
  const fixture = await createDispatchFixture(temp, name, {
    workUnit: 'milestone:M00',
    projectMapContent,
    additionalAllowedPaths: ['.agenticloop/audits/**'],
  });
  const root = fixture.root;
  const cli = { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) };
  mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf8');
  fixtureGit(root, ['add', '.gitignore']);
  fixtureGit(root, ['commit', '-m', 'configure attempt fixture']);

  const attemptBase = fixtureGit(root, ['rev-parse', 'HEAD']);
  const repository = fixture.repository;
  fixture.repository = () => ({ ...repository(), head: attemptBase, baseHead: attemptBase });
  fixture.refetchRepository = fixture.repository;

  const dispatchableCarrierDigest = carrierDigest(root);
  const prepared = prepare(fixture);
  assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
  const packet = prepared.packet;
  const packetPath = '.agenticloop/tmp/engineer-dispatch.json';
  writeFileSync(join(root, packetPath), JSON.stringify(packet, null, 2), 'utf8');

  const started = await runCliInProcess([
    'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(root),
    '--dispatch-packet', packetPath, '--json', '--target', root,
  ], cli);
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);

  writeFileSync(join(root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
  fixtureGit(root, ['add', 'src/existing.js']);
  fixtureGit(root, ['commit', '-m', 'record candidate\n\nTask: T-001\nAgent: engineer']);
  const productHead = fixtureGit(root, ['rev-parse', 'HEAD']);

  const evidenced = await runCliInProcess([
    'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
    '--expect-digest', carrierDigest(root), '--product-head', productHead, '--json', '--target', root,
  ], cli);
  assert.equal(evidenced.status, 0, `${evidenced.stdout}${evidenced.stderr}`);
  fixtureGit(root, ['add', '.agenticloop/tasks/T-001.md']);
  fixtureGit(root, ['commit', '-m', 'record implementation artifact\n\nTask: T-001\nAgent: engineer']);

  const returnHead = fixtureGit(root, ['rev-parse', 'HEAD']);
  const returnCarrierDigest = carrierDigest(root);
  const lineage = resolveCarrierLineage(root, 'T-001', {
    backend: 'files', taskContractDigest: packet.task.taskContractDigest,
    boundary: 'engineer_return', currentCarrierDigest: returnCarrierDigest,
  });
  assert.equal(lineage.ok, true, lineage.errors?.join('; '));

  const productChangedPaths = fixtureGit(root, ['diff', '--name-only', `${attemptBase}..${productHead}`])
    .split(/\r?\n/).filter(Boolean);
  const allPaths = fixtureGit(root, ['diff', '--name-only', `${attemptBase}..${returnHead}`])
    .split(/\r?\n/).filter(Boolean);
  const commits = fixtureGit(root, ['rev-list', '--reverse', `${attemptBase}..${productHead}`])
    .split(/\r?\n/).filter(Boolean);
  const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: productChangedPaths });
  evidence.workflowHead = returnHead;
  evidence.productChangedPaths = productChangedPaths;
  evidence.workflowChangedPaths = allPaths.filter(path => !productChangedPaths.includes(path));
  evidence.productAttribution = { range: { base: attemptBase, head: productHead }, commits };
  evidence.task.currentCarrierDigest = returnCarrierDigest;
  evidence.carrierLineage = {
    dispatchConsumptionDigest: lineage.dispatchConsumption.digest,
    evidenceMutationReceiptDigests: lineage.receipts.map(receipt => receipt.digest),
  };
  const executionReferences = new Map(evidence.checks.filter(check => check.kind === 'command').map(check => {
    const [command, ...args] = check.command.split(' ');
    const path = check.id === 'RC-1' ? '.agenticloop/tmp/evidence.json' : `.agenticloop/tmp/${check.id}-evidence.json`;
    const execution = produceExecutionEvidence({
      checkId: check.id, instruction: check.command, command, args,
      carrierRoot: root, artifactWorktreeRoot: root, workingDirectory: root,
      projectScratchRoot: join(root, '.agenticloop', 'tmp'),
      binding: {
        packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId,
        taskId: 'T-001', taskContractDigest: evidence.task.taskContractDigest,
        currentCarrierDigest: returnCarrierDigest, repositoryHead: returnHead, productHead,
      },
    }, { run: () => ({ exitCode: 0, stdout: `${check.id} passed`, stderr: '' }) });
    writeFileSync(join(root, path), JSON.stringify(execution, null, 2), 'utf8');
    return [check.id, { path, digest: execution.digest }];
  }));
  const returnedEvidence = {
    ...evidence,
    checks: evidence.checks.map(check => executionReferences.has(check.id)
      ? { ...check, executionEvidence: executionReferences.get(check.id) }
      : check),
  };
  const returnPath = '.agenticloop/tmp/engineer-return.json';
  const evidencePath = '.agenticloop/tmp/engineer-evidence.json';
  writeFileSync(join(root, returnPath), JSON.stringify(readyReturn(packet, returnedEvidence), null, 2), 'utf8');
  writeFileSync(join(root, evidencePath), JSON.stringify(evidence, null, 2), 'utf8');
  const verified = await runCliInProcess([
    'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
    '--repository-evidence', evidencePath, '--target', root,
  ], cli);
  assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
  fixtureGit(root, ['add', '-f', '.agenticloop/returns/verifications']);
  fixtureGit(root, ['commit', '-m', 'record return verification\n\nTask: T-001\nAgent: maintainer']);

  return {
    fixture, root, cli, packet, attemptBase, productHead, returnHead,
    dispatchableCarrierDigest, returnCarrierDigest, lineage,
  };
}

/** Record the Maintainer review provenance the acceptance gate requires. */
function recordReview(root, productHead) {
  writeFileSync(
    taskFile(root),
    `${readFileSync(taskFile(root), 'utf8')
      .replace(/^review_status:.*$/m, 'review_status: accepted')
      .replace(/^reviewed_artifact:.*$/m, `reviewed_artifact: commit:${productHead}`)
      .replace(/^review_mode:.*$/m, 'review_mode: host_subagent')}` +
    '\n## Scope Completed\n\n- Delivered the candidate.\n' +
    '\n## Evidence\n\n- npm test (pass)\n',
    'utf8'
  );
  fixtureGit(root, ['add', '.agenticloop/tasks/T-001.md']);
  fixtureGit(root, ['commit', '-m', 'record maintainer review\n\nTask: T-001\nAgent: maintainer']);
}

describe('P35-C12R.5 the closeout fixture builds one attempt in real order', () => {
  const closeoutFixture = createCloseoutCliFixture();
  before(() => { closeoutFixture.setup(); });
  after(() => { closeoutFixture.cleanup(); });

  it('mints one packet from a dispatchable carrier, consumes it once, and never reminits', async () => {
    const target = await closeoutFixture.makeVerifiedGitTarget('real-order');
    const artifact = await closeoutFixture.certify(target);

    // Exactly one packet and exactly one consumption for the whole attempt.
    const dispatchDirectory = join(target, '.agenticloop', 'handoffs', 'dispatch', 'T-001');
    const consumptionFiles = readdirSync(dispatchDirectory).filter(name => name.endsWith('.json'));
    assert.equal(consumptionFiles.length, 1, 'an attempt consumes exactly one packet');
    const consumption = JSON.parse(readFileSync(join(dispatchDirectory, consumptionFiles[0]), 'utf8'));

    // The packet sealed the carrier as it stood while the task was still
    // dispatchable - not the accepted carrier closeout later reads.
    const packet = JSON.parse(readFileSync(join(target, '.agenticloop', 'tmp', 'engineer-dispatch.json'), 'utf8'));
    assert.equal(consumption.packetId, packet.packetId);
    assert.equal(consumption.dispatchCarrierDigest, packet.task.dispatchCarrierDigest);
    assert.notEqual(packet.task.dispatchCarrierDigest, carrierDigest(target));
    assert.equal(taskStatusFromBody(readFileSync(taskFile(target), 'utf8')), 'accepted');

    // Every identity that the plan requires to stay distinct, stays distinct.
    const distinct = new Set([
      packet.repository.head, consumption.productBaseHead, packet.packetId,
      consumption.invocationId, packet.task.dispatchCarrierDigest, carrierDigest(target),
    ]);
    assert.equal(distinct.size, 5, 'product base, packet, attempt, dispatch carrier, and live carrier are distinct');
    assert.equal(packet.repository.head, consumption.productBaseHead);

    // Acceptance is committed outside the Engineer product range.
    const productRange = fixtureGit(target, ['rev-list', `${packet.repository.head}..${artifact.slice('commit:'.length)}`])
      .split(/\r?\n/).filter(Boolean);
    assert.ok(productRange.length > 1, 'the workflow head is ahead of the product head');
    const acceptanceCommit = fixtureGit(target, ['log', '-1', '--format=%H', '--grep', 'record accepted task']);
    assert.ok(acceptanceCommit, 'the acceptance transition has its own commit');
    const engineerProductCommits = fixtureGit(target, [
      'rev-list', `${packet.repository.head}..HEAD`, '--grep', 'Agent: engineer',
    ]).split(/\r?\n/).filter(Boolean);
    assert.equal(engineerProductCommits.includes(acceptanceCommit), false,
      'acceptance is never attributed to the Engineer');

    // The Engineer return terminal survives review, acceptance, and audit.
    const lineage = resolveCarrierLineage(target, 'T-001', {
      backend: 'files', taskContractDigest: packet.task.taskContractDigest, boundary: 'engineer_return',
    });
    assert.equal(lineage.ok, true, lineage.errors?.join('; '));
    assert.equal(lineage.receipts.length, 1, 'one Engineer carrier mutation, with its receipt');
    assert.equal(lineage.receipts[0].mutationClass, 'implementation_artifact_evidence');
    assert.equal(lineage.receipts[0].producer.workflowRole, 'engineer');
    assert.notEqual(lineage.currentCarrierDigest, carrierDigest(target),
      'the execution terminal and the live lifecycle carrier are different digests');

    // Certification ends clean and committed, and no scratch artifact became
    // durable evidence along the way.
    assert.equal(fixtureGit(target, ['status', '--porcelain', '--untracked-files=all']), '');
    assert.deepEqual(
      fixtureGit(target, ['ls-files']).split(/\r?\n/).filter(path => path.startsWith('.agenticloop/tmp/')),
      []
    );

    // And the whole thing still closes out.
    const packetPath = join(target, '.agenticloop', 'tmp', 'closeout.json');
    const preparedCloseout = await closeoutFixture.closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target);
    assert.equal(preparedCloseout.status, 0, `${preparedCloseout.stdout}${preparedCloseout.stderr}`);
    assert.equal(JSON.parse(readFileSync(packetPath, 'utf8')).completion_eligible, true);
  });
});

describe('P35-C12R.5 the execution and lifecycle carrier boundaries stay separate', () => {
  it('refuses an unrecognized boundary rather than defaulting to a permissive one', async () => {
    const attempt = await realOrderAttempt('boundary-name');
    const resolved = resolveCarrierLineage(attempt.root, 'T-001', {
      backend: 'files', boundary: 'whatever-is-convenient',
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.errors.join('; '), /boundary 'whatever-is-convenient' is not recognized/);
  });

  it('refuses a caller-substituted terminal digest at either boundary', async () => {
    const attempt = await realOrderAttempt('terminal-substitution');
    for (const boundary of ['engineer_return', 'lifecycle']) {
      const resolved = resolveCarrierLineage(attempt.root, 'T-001', {
        backend: 'files', boundary,
        currentCarrierDigest: `sha256:${'b'.repeat(64)}`,
      });
      assert.equal(resolved.ok, false, boundary);
      assert.match(resolved.errors.join('; '), /terminal currentCarrierDigest does not equal/);
    }
    // The digest the Engineer actually returned still resolves.
    assert.equal(resolveCarrierLineage(attempt.root, 'T-001', {
      backend: 'files', boundary: 'engineer_return',
      currentCarrierDigest: attempt.returnCarrierDigest,
    }).ok, true);
  });

  it('keeps an acceptance transition out of the Engineer return lineage while the lifecycle chain keeps it', async () => {
    const attempt = await realOrderAttempt('acceptance-boundary');
    const { root, packet } = attempt;
    const consumption = currentDispatchConsumption(root, 'T-001', { backend: 'files' }).record;
    const priorReceipt = receiptRecords(root).at(-1);
    const acceptedCarrierDigest = `sha256:${'c'.repeat(64)}`;
    const receipt = createCarrierMutationReceipt({
      receiptId: `task-mutation:${randomUUID()}`,
      backend: 'files', task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md' },
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      priorCarrierDigest: attempt.returnCarrierDigest,
      currentCarrierDigest: acceptedCarrierDigest,
      mutationClass: 'acceptance_transition', ownedFields: ['status'], changedFields: ['status'],
      producer: {
        workflowRole: 'maintainer', assuranceGrade: 'host_receipt',
        invocationId: consumption.invocationId,
        workUnitIdentity: consumption.workUnitIdentity,
        repositoryIdentity: consumption.repositoryIdentity,
      },
      predecessor: { kind: 'task_mutation_receipt', digest: priorReceipt.digest },
    });
    writeFileSync(join(root, carrierMutationRelativePath(receipt)), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    const execution = resolveCarrierLineage(root, 'T-001', {
      backend: 'files', boundary: 'engineer_return', currentCarrierDigest: attempt.returnCarrierDigest,
    });
    assert.equal(execution.ok, true, execution.errors?.join('; '));
    assert.deepEqual(execution.receipts.map(item => item.mutationClass), ['implementation_artifact_evidence']);

    const lifecycle = resolveCarrierLineage(root, 'T-001', {
      backend: 'files', boundary: 'lifecycle', currentCarrierDigest: acceptedCarrierDigest,
    });
    assert.equal(lifecycle.ok, true, lifecycle.errors?.join('; '));
    assert.deepEqual(lifecycle.receipts.map(item => item.mutationClass),
      ['implementation_artifact_evidence', 'acceptance_transition']);

    // The Engineer boundary still terminates where the Engineer stopped, and
    // the lifecycle boundary refuses that stale terminal.
    assert.equal(execution.currentCarrierDigest, attempt.returnCarrierDigest);
    assert.equal(lifecycle.currentCarrierDigest, acceptedCarrierDigest);
    assert.equal(resolveCarrierLineage(root, 'T-001', {
      backend: 'files', boundary: 'lifecycle', currentCarrierDigest: attempt.returnCarrierDigest,
    }).ok, false);
  });

  it('never lets a lifecycle receipt bridge a gap in the Engineer chain', async () => {
    const attempt = await realOrderAttempt('lifecycle-bridge');
    const { root, packet } = attempt;
    const consumption = currentDispatchConsumption(root, 'T-001', { backend: 'files' }).record;
    const engineerReceipt = receiptRecords(root).at(-1);
    // Remove the Engineer receipt and replace it with a lifecycle-class record
    // that occupies exactly its position and carrier edge.
    rmSync(join(root, carrierMutationRelativePath(engineerReceipt)));
    const impostor = createCarrierMutationReceipt({
      receiptId: `task-mutation:${randomUUID()}`,
      backend: 'files', task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md' },
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      priorCarrierDigest: engineerReceipt.priorCarrierDigest,
      currentCarrierDigest: engineerReceipt.currentCarrierDigest,
      mutationClass: 'acceptance_transition', ownedFields: ['status'], changedFields: ['status'],
      producer: {
        workflowRole: 'maintainer', assuranceGrade: 'host_receipt',
        invocationId: consumption.invocationId,
        workUnitIdentity: consumption.workUnitIdentity,
        repositoryIdentity: consumption.repositoryIdentity,
      },
      predecessor: { kind: 'dispatch_consumption', digest: consumption.digest },
    });
    writeFileSync(join(root, carrierMutationRelativePath(impostor)), `${JSON.stringify(impostor, null, 2)}\n`, 'utf8');

    const execution = resolveCarrierLineage(root, 'T-001', {
      backend: 'files', boundary: 'engineer_return', currentCarrierDigest: attempt.returnCarrierDigest,
    });
    assert.equal(execution.ok, false, 'a Maintainer record cannot stand in for Engineer evidence');
    assert.equal(execution.receipts.length, 0);
    assert.match(execution.errors.join('; '), /terminal currentCarrierDigest does not equal/);
  });

  for (const [label, patch, expected] of [
    ['a wrong prior carrier digest', { priorCarrierDigest: `sha256:${'d'.repeat(64)}` }, /does not continue the recognized carrier lineage/],
    ['a wrong predecessor record', { predecessorFromConsumption: true }, /fork from one predecessor/],
    ['another dispatch generation', { dispatchCarrierDigest: `sha256:${'e'.repeat(64)}` }, /claims the active dispatch generation with mismatched identity/],
  ]) {
    it(`refuses an Engineer receipt with ${label}`, async () => {
      const attempt = await realOrderAttempt(`receipt-${label.replace(/\W+/g, '-')}`);
      const { root, packet } = attempt;
      const consumption = currentDispatchConsumption(root, 'T-001', { backend: 'files' }).record;
      const prior = receiptRecords(root).at(-1);
      const receipt = createCarrierMutationReceipt({
        receiptId: `task-mutation:${randomUUID()}`,
        backend: 'files', task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md' },
        taskContractDigest: packet.task.taskContractDigest,
        dispatchCarrierDigest: patch.dispatchCarrierDigest ?? packet.task.dispatchCarrierDigest,
        priorCarrierDigest: patch.priorCarrierDigest ?? attempt.returnCarrierDigest,
        currentCarrierDigest: `sha256:${'9'.repeat(64)}`,
        mutationClass: 'implementation_summary_evidence', ownedFields: ['comments'], changedFields: ['comments'],
        producer: {
          workflowRole: 'engineer', assuranceGrade: 'session_reported',
          invocationId: consumption.invocationId,
          workUnitIdentity: consumption.workUnitIdentity,
          repositoryIdentity: consumption.repositoryIdentity,
        },
        predecessor: patch.predecessorFromConsumption
          ? { kind: 'dispatch_consumption', digest: consumption.digest }
          : { kind: 'task_mutation_receipt', digest: prior.digest },
      });
      writeFileSync(join(root, carrierMutationRelativePath(receipt)), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

      const resolved = resolveCarrierLineage(root, 'T-001', {
        backend: 'files', boundary: 'engineer_return', currentCarrierDigest: attempt.returnCarrierDigest,
      });
      assert.equal(resolved.ok, false, label);
      assert.match(resolved.errors.join('; '), expected);
    });
  }

  it('refuses a receipt whose producer role does not own its mutation class', () => {
    const base = {
      receiptId: `task-mutation:${randomUUID()}`,
      backend: 'files', task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md' },
      taskContractDigest: `sha256:v1:${'a'.repeat(64)}`,
      dispatchCarrierDigest: `sha256:${'a'.repeat(64)}`,
      priorCarrierDigest: `sha256:${'b'.repeat(64)}`,
      currentCarrierDigest: `sha256:${'c'.repeat(64)}`,
      ownedFields: ['status'], changedFields: ['status'],
      predecessor: { kind: 'dispatch_consumption', digest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}` },
    };
    const engineerProducer = {
      workflowRole: 'engineer', assuranceGrade: 'session_reported',
      invocationId: 'invocation:x', workUnitIdentity: 'milestone:M00', repositoryIdentity: 'file:/x',
    };
    const maintainerProducer = { ...engineerProducer, workflowRole: 'maintainer', assuranceGrade: 'host_receipt' };
    // An Engineer may not label its own mutation an acceptance transition, and
    // a Maintainer transition may not be dressed as Engineer evidence.
    assert.throws(
      () => createCarrierMutationReceipt({ ...base, mutationClass: 'acceptance_transition', producer: engineerProducer }),
      /producer identity is invalid/
    );
    assert.throws(
      () => createCarrierMutationReceipt({
        ...base, mutationClass: 'implementation_summary_evidence',
        ownedFields: ['comments'], changedFields: ['comments'], producer: maintainerProducer,
      }),
      /producer identity is invalid/
    );
  });
});

describe('P35-C12R.5 acceptance answers to the Engineer return terminal', () => {
  it('accepts against the durably recognized return terminal, not the live carrier', async () => {
    const attempt = await realOrderAttempt('acceptance-terminal');
    const { root, cli, productHead, returnCarrierDigest } = attempt;
    recordReview(root, productHead);
    // The review provenance the acceptance gate requires has already moved the
    // carrier off the Engineer return terminal. Acceptance must still succeed.
    const preAcceptanceDigest = carrierDigest(root);
    assert.notEqual(preAcceptanceDigest, returnCarrierDigest);
    const accepted = await runCliInProcess([
      'task', 'status', 'T-001', 'accepted', '--expect-digest', preAcceptanceDigest, '--json', '--target', root,
    ], cli);
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
    const payload = JSON.parse(accepted.stdout);
    assert.equal(payload.handoff_recognition.recognized, true);
    assert.equal(payload.handoff_recognition.boundIdentity.currentCarrierDigest, returnCarrierDigest);
    // The receipt is expected against the live pre-acceptance carrier read from
    // disk, which is no longer the recognized Engineer return terminal.
    assert.equal(payload.receipt.expectedDigest, preAcceptanceDigest);
    assert.notEqual(payload.receipt.expectedDigest, returnCarrierDigest);
    assert.notEqual(payload.receipt.resultingDigest, returnCarrierDigest);
  });

  it('refuses acceptance when a post-return Engineer receipt moves the execution terminal', async () => {
    const attempt = await realOrderAttempt('acceptance-post-return-mutation');
    const { root, cli, packet, productHead, returnCarrierDigest } = attempt;
    recordReview(root, productHead);
    const consumption = currentDispatchConsumption(root, 'T-001', { backend: 'files' }).record;
    const prior = receiptRecords(root).at(-1);
    const receipt = createCarrierMutationReceipt({
      receiptId: `task-mutation:${randomUUID()}`,
      backend: 'files', task: { id: 'T-001', carrier: '.agenticloop/tasks/T-001.md' },
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      priorCarrierDigest: returnCarrierDigest,
      currentCarrierDigest: carrierDigest(root),
      mutationClass: 'implementation_summary_evidence', ownedFields: ['comments'], changedFields: ['comments'],
      producer: {
        workflowRole: 'engineer', assuranceGrade: 'session_reported',
        invocationId: consumption.invocationId,
        workUnitIdentity: consumption.workUnitIdentity,
        repositoryIdentity: consumption.repositoryIdentity,
      },
      predecessor: { kind: 'task_mutation_receipt', digest: prior.digest },
    });
    writeFileSync(join(root, carrierMutationRelativePath(receipt)), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    const accepted = await runCliInProcess([
      'task', 'status', 'T-001', 'accepted', '--expect-digest', carrierDigest(root), '--json', '--target', root,
    ], cli);
    assert.equal(accepted.status, 1, 'a verified return must still describe the current execution terminal');
    assert.match(`${accepted.stdout}${accepted.stderr}`, /currentCarrierDigest/);
    assert.match(readFileSync(taskFile(root), 'utf8'), /^status: in-progress$/m);
  });

  it('refuses the return when acceptance lands inside the Engineer product range', async () => {
    // Layer 1 of the reverted migration, pinned: a lifecycle commit inside the
    // product range is read as Engineer product work and rejected for lacking
    // the Engineer attribution trailer.
    const fixture = await createDispatchFixture(temp, 'acceptance-in-product-range', {
      workUnit: 'milestone:M00', projectMapContent: CLOSEOUT_PROJECT_MAP,
    });
    const root = fixture.root;
    const cli = { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) };
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf8');
    fixtureGit(root, ['add', '.gitignore']);
    fixtureGit(root, ['commit', '-m', 'configure fixture']);
    const attemptBase = fixtureGit(root, ['rev-parse', 'HEAD']);
    const repository = fixture.repository;
    fixture.repository = () => ({ ...repository(), head: attemptBase, baseHead: attemptBase });
    fixture.refetchRepository = fixture.repository;
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const packet = prepared.packet;
    writeFileSync(join(root, '.agenticloop/tmp/dispatch.json'), JSON.stringify(packet, null, 2), 'utf8');
    const started = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(root),
      '--dispatch-packet', '.agenticloop/tmp/dispatch.json', '--json', '--target', root,
    ], cli);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
    // A Maintainer-attributed lifecycle commit placed inside the product range.
    writeFileSync(join(root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-m', 'record accepted task\n\nTask: T-001\nAgent: maintainer']);
    const productHead = fixtureGit(root, ['rev-parse', 'HEAD']);

    const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: ['src/existing.js'] });
    evidence.workflowHead = productHead;
    evidence.productChangedPaths = ['src/existing.js'];
    evidence.workflowChangedPaths = [];
    evidence.productAttribution = { range: { base: attemptBase, head: productHead }, commits: [productHead] };
    evidence.task.currentCarrierDigest = carrierDigest(root);
    writeFileSync(join(root, '.agenticloop/tmp/return.json'), JSON.stringify(readyReturn(packet, evidence), null, 2), 'utf8');
    writeFileSync(join(root, '.agenticloop/tmp/evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    const verified = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', '.agenticloop/tmp/dispatch.json',
      '--return', '.agenticloop/tmp/return.json', '--repository-evidence', '.agenticloop/tmp/evidence.json',
      '--target', root,
    ], cli);
    assert.equal(verified.status, 1, 'a lifecycle commit cannot pass as Engineer product work');
    assert.match(
      `${verified.stdout}${verified.stderr}`,
      /wrong Agent trailer 'maintainer'; expected 'engineer'/
    );
  });
});

describe('P35-C12R.6 an expired grant still closes out the attempt it authorized', () => {
  it('completes the consumed attempt, refuses a new packet, and keeps revocation separate', async () => {
    const projectMap = CLOSEOUT_PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled');
    const fixture = await createDispatchFixture(temp, 'grant-closeout', {
      scaffold: true, workUnit: 'milestone:M00', projectMapContent: projectMap,
    });
    const root = fixture.root;
    fixture.operatorTrustRoot = mkdtempSync(join(temp, 'grant-closeout-empty-trust-'));
    fixture.operatorActivationRoot = mkdtempSync(join(temp, 'grant-closeout-activation-'));
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf8');
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-m', 'configure grant closeout fixture']);

    // A deliberately short-lived operator grant, created through the only
    // command that can mint `operator_confirmed`.
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--expires-in-hours', '0.0125', '--json', '--target', root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, `${activated.stdout}${activated.stderr}`);
    const activationReport = JSON.parse(activated.stdout);
    const grantExpiresAt = Date.parse(activationReport.expiresAt);
    assert.ok(Number.isFinite(grantExpiresAt));
    assert.equal(activationReport.assurance.activation, 'operator_confirmed');
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-m', 'record activation grant\n\nTask: T-001\nAgent: maintainer']);

    const cli = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    };
    writeFileSync(join(root, 'dispatch-input.json'), JSON.stringify({
      readiness: fixture.readiness, decomposition: fixture.decomposition, assignment: fixture.assignment,
    }, null, 2), 'utf8');
    const dispatched = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--target', root,
    ], cli);
    assert.equal(dispatched.status, 0, `${dispatched.stdout}${dispatched.stderr}`);
    const packet = JSON.parse(dispatched.stdout);
    assert.equal(packet.activation, null, 'this is the grant path, not the legacy capture path');
    assert.ok(packet.activationBinding.grant.grantId);
    const packetPath = '.agenticloop/tmp/engineer-dispatch.json';
    writeFileSync(join(root, packetPath), JSON.stringify(packet, null, 2), 'utf8');

    const started = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(root),
      '--dispatch-packet', packetPath, '--json', '--target', root,
    ], cli);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
    const consumption = currentDispatchConsumption(root, 'T-001', { backend: 'files' }).record;
    assert.ok(Date.parse(consumption.consumedAt) < grantExpiresAt,
      'the attempt must be consumed while the grant is still current');

    writeFileSync(join(root, 'src', 'existing.js'), 'export const current = "grant-return";\n', 'utf8');
    fixtureGit(root, ['add', 'src/existing.js']);
    fixtureGit(root, ['commit', '-m', 'record candidate\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(root, ['rev-parse', 'HEAD']);
    const evidenced = await runCliInProcess([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', carrierDigest(root), '--product-head', productHead, '--json', '--target', root,
    ], cli);
    assert.equal(evidenced.status, 0, `${evidenced.stdout}${evidenced.stderr}`);
    fixtureGit(root, ['add', '.agenticloop/tasks/T-001.md']);
    fixtureGit(root, ['commit', '-m', 'record implementation artifact\n\nTask: T-001\nAgent: engineer']);

    const returnHead = fixtureGit(root, ['rev-parse', 'HEAD']);
    const returnCarrierDigest = carrierDigest(root);
    const lineage = resolveCarrierLineage(root, 'T-001', {
      backend: 'files', taskContractDigest: packet.task.taskContractDigest,
      boundary: 'engineer_return', currentCarrierDigest: returnCarrierDigest,
    });
    assert.equal(lineage.ok, true, lineage.errors?.join('; '));
    const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: ['src/existing.js'] });
    evidence.workflowHead = returnHead;
    evidence.productChangedPaths = ['src/existing.js'];
    evidence.workflowChangedPaths = ['.agenticloop/tasks/T-001.md'];
    evidence.productAttribution = {
      range: { base: packet.repository.head, head: productHead }, commits: [productHead],
    };
    evidence.task.currentCarrierDigest = returnCarrierDigest;
    evidence.carrierLineage = {
      dispatchConsumptionDigest: lineage.dispatchConsumption.digest,
      evidenceMutationReceiptDigests: lineage.receipts.map(receipt => receipt.digest),
    };
    const grantExecutionReferences = new Map(evidence.checks.filter(check => check.kind === 'command').map(check => {
      const [command, ...args] = check.command.split(' ');
      const path = check.id === 'RC-1' ? '.agenticloop/tmp/evidence.json' : `.agenticloop/tmp/${check.id}-evidence.json`;
      const execution = produceExecutionEvidence({
        checkId: check.id, instruction: check.command, command, args,
        carrierRoot: root, artifactWorktreeRoot: root, workingDirectory: root,
        projectScratchRoot: join(root, '.agenticloop', 'tmp'),
        binding: {
          packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId,
          taskId: 'T-001', taskContractDigest: evidence.task.taskContractDigest,
          currentCarrierDigest: returnCarrierDigest, repositoryHead: returnHead, productHead,
        },
      }, { run: () => ({ exitCode: 0, stdout: `${check.id} passed`, stderr: '' }) });
      writeFileSync(join(root, path), JSON.stringify(execution, null, 2), 'utf8');
      return [check.id, { path, digest: execution.digest }];
    }));
    writeFileSync(join(root, '.agenticloop/tmp/engineer-return.json'),
      JSON.stringify(readyReturn(packet, {
        ...evidence,
        checks: evidence.checks.map(check => grantExecutionReferences.has(check.id)
          ? { ...check, executionEvidence: grantExecutionReferences.get(check.id) }
          : check),
      }), null, 2), 'utf8');
    writeFileSync(join(root, '.agenticloop/tmp/engineer-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    const verified = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath,
      '--return', '.agenticloop/tmp/engineer-return.json',
      '--repository-evidence', '.agenticloop/tmp/engineer-evidence.json', '--target', root,
    ], cli);
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
    fixtureGit(root, ['add', '-f', '.agenticloop/returns/verifications']);
    fixtureGit(root, ['commit', '-m', 'record return verification\n\nTask: T-001\nAgent: maintainer']);

    // Let the grant expire. Nothing about the consumed attempt changes: every
    // step from here on runs on an authority that is no longer current.
    const remaining = grantExpiresAt + 500 - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    assert.ok(Date.now() > grantExpiresAt, 'the grant must be expired before the lifecycle continues');

    recordReview(root, productHead);
    const accepted = await runCliInProcess([
      'task', 'status', 'T-001', 'accepted', '--expect-digest', carrierDigest(root), '--json', '--target', root,
    ], cli);
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
    fixtureGit(root, ['add', '.agenticloop/tasks/T-001.md']);
    fixtureGit(root, ['commit', '-m', 'record accepted task\n\nTask: T-001\nAgent: maintainer']);
    const artifact = `commit:${fixtureGit(root, ['rev-parse', 'HEAD'])}`;

    const closeoutOptions = {
      ...cli, stdinIsTTY: true, isTTY: true, ci: false,
      promptFactory: () => ({ ask: async () => 'waive', close() {} }),
    };
    const closeoutPacketPath = join(root, '.agenticloop', 'tmp', 'closeout.json');
    const closedOut = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--output', closeoutPacketPath, '--json', '--target', root,
    ], closeoutOptions);
    assert.equal(closedOut.status, 0, `${closedOut.stdout}${closedOut.stderr}`);
    const closeoutPacket = JSON.parse(readFileSync(closeoutPacketPath, 'utf8'));
    assert.equal(closeoutPacket.completion_eligible, true, JSON.stringify(closeoutPacket.reasons));
    assert.equal(closeoutPacket.assurance.tasks[0].activation, 'operator_confirmed');
    assert.equal(closeoutPacket.assurance.tasks[0].activation_source, 'activation_grant');

    // The same expired grant no longer authorizes new work. The operator-facing
    // surface says so directly...
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', root], cli);
    const row = JSON.parse(status.stdout).bindings.find(item => item.taskId === 'T-001');
    assert.equal(row.usable, false, 'an expired binding is not usable for new work');
    assert.equal(row.grantId, packet.activationBinding.grant.grantId);
    assert.ok(row.reasons.some(reason => /expired/i.test(reason)), JSON.stringify(row.reasons));

    // ...and the packet-level authority refuses at the current clock while the
    // pinned consumption instant still resolves. That difference is the whole
    // non-retroactive rule, checked at the seam that owns it.
    const io = { operatorTrustRoot: fixture.operatorTrustRoot, operatorActivationRoot: fixture.operatorActivationRoot };
    const atNow = resolvePacketActivationBinding(root, io, packet);
    assert.equal(atNow.ok, false, 'the expired grant cannot authorize a new attempt');
    assert.ok(atNow.errors.some(error => /expired/i.test(error.message)), JSON.stringify(atNow.errors));
    const atConsumption = resolvePacketActivationBinding(root, io, packet, {
      now: Date.parse(consumption.consumedAt),
    });
    assert.equal(atConsumption.ok, true, 'the attempt it authorized is still authorized');
    // A grant issued after the attempt started never authorizes it: pinning
    // only ever narrows.
    const beforeIssue = resolvePacketActivationBinding(root, io, packet, {
      now: Date.parse(packet.activationBinding.grant.issuedAt) - 3_600_000,
    });
    assert.equal(beforeIssue.ok, false);
    assert.ok(
      beforeIssue.errors.some(error => /issued in the future/i.test(error.message)),
      JSON.stringify(beforeIssue.errors)
    );

    // No new packet is produced for this task either way.
    const reminted = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--json', '--target', root,
    ], cli);
    assert.equal(reminted.status, 1, 'no second packet is minted for this task');
    assert.equal(JSON.parse(reminted.stdout).ok, false);

    // Revocation is not ordinary expiry: it still blocks the completed attempt.
    const revocation = createActivationRevocation({
      grant: packet.activationBinding.grant,
      reason: 'operator withdrew the authorization',
    });
    const written = writeActivationRevocation(root, revocation);
    assert.equal(written.ok, true, written.errors?.join('; '));
    const revokedCloseout = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--json', '--target', root,
    ], closeoutOptions);
    assert.equal(revokedCloseout.status, 1, 'revocation is time-independent and still refuses');
    const revokedPacket = JSON.parse(revokedCloseout.stdout);
    assert.equal(revokedPacket.completion_eligible, false);
    assert.ok(
      revokedPacket.reasons.some(item => item.category === 'activation_revoked'),
      JSON.stringify(revokedPacket.reasons)
    );
  });
});
