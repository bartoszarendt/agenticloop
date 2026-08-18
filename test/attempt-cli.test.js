/**
 * At the CLI boundary: the real order, not a unit-level rehearsal.
 *
 * The conservation rule only means something if the commands an operator
 * actually runs enforce it. These cases build a genuine dispatch packet,
 * consume it as a role start, record Engineer work against it, and then try to
 * do exactly what the field session did: mint a replacement packet.
 *
 * They also check the escape hatch is real and complete - the refusal names a
 * command, that command works, and after it a new attempt is permitted with the
 * abandoned one still on record.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createDispatchFixture,
  git as fixtureGit,
  prepare,
} from './helpers/dispatch-fixture.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import {
  createDispatchConsumption,
  dispatchConsumptionRelativePath,
} from '../src/handoff-consumption.js';
import { createCarrierMutationReceipt } from '../src/task-evidence-contract.js';
import { executionAttemptIdentity } from '../src/execution-attempt.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-attempt-cli-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/**
 * Build one genuine packet and consume it, exactly as a role start does.
 * Returns the packet and the durable consumption record now on disk.
 */
function consumeOnePacket(fixture, taskId = 'T-001') {
  const prepared = prepare(fixture);
  assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
  const packet = prepared.packet;
  const packetPath = '.agenticloop/tmp/engineer-dispatch.json';
  mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(fixture.root, packetPath), `${JSON.stringify(packet, null, 2)}\n`, 'utf8');

  const recognition = recognizeHandoff({
    transition: 'role_start',
    expectation: {
      backend: 'files', taskId, roleId: 'engineer',
      taskContractDigest: packet.task.contractDigest, carrierDigest: packet.task.digest,
      packetId: packet.packetId, packetDigest: packet.digest,
      workUnitIdentity: packet.decomposition.workUnitId, artifactHead: packet.repository.head,
      worktreeRoot: packet.repository.worktree, minimumActivationAssurance: 'operator_confirmed',
    },
    preparedDispatch: packet,
    validatePreparedDispatch: fixtureDispatchValidator(fixture),
  });
  assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));

  const consumption = createDispatchConsumption({ backend: 'files', taskId, recognition });
  const consumptionPath = join(fixture.root, dispatchConsumptionRelativePath(consumption));
  mkdirSync(join(consumptionPath, '..'), { recursive: true });
  writeFileSync(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');
  return { packet, packetPath, consumption, attemptId: executionAttemptIdentity(consumption) };
}

/**
 * Record one Engineer carrier mutation under the live attempt.
 *
 * Built from the consumption's own immutable dispatch tuple, because that tuple
 * is exactly what scopes a receipt to an attempt - a receipt that does not carry
 * it belongs to some other generation and must not count here.
 */
function recordEngineerMutation(fixture, consumption, taskId = 'T-001', overrides = {}) {
  const receipt = createCarrierMutationReceipt({
    receiptId: overrides.receiptId ?? 'task-mutation:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    backend: 'files',
    task: { id: taskId, carrier: `.agenticloop/tasks/${taskId}.md` },
    taskContractDigest: consumption.taskContractDigest,
    dispatchCarrierDigest: consumption.dispatchCarrierDigest,
    priorCarrierDigest: consumption.currentCarrierDigest,
    currentCarrierDigest: consumption.currentCarrierDigest,
    mutationClass: 'implementation_artifact_evidence',
    ownedFields: ['implementation_artifact'],
    changedFields: ['implementation_artifact'],
    producer: {
      invocationId: consumption.invocationId,
      workUnitIdentity: consumption.workUnitIdentity,
      repositoryIdentity: consumption.repositoryIdentity,
      workflowRole: 'engineer',
      assuranceGrade: 'session_reported',
    },
    predecessor: { kind: 'dispatch_consumption', digest: consumption.digest },
  });
  const path = join(
    fixture.root, '.agenticloop', 'handoffs', 'task-mutations', taskId, `${receipt.receiptId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
  );
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

function cli(fixture, args, extra = {}) {
  return runCliInProcess([...args, '--target', fixture.root], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    ...extra,
  });
}

describe('the CLI conserves a consumed packet', () => {
  it('reports no attempts and permits dispatch before anything is consumed', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-none');
    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.deepEqual(report.attempts, []);
    assert.equal(report.liveAttempt, null);
    assert.equal(report.newPacketPermitted, true);
  });

  it('reports the live attempt after a packet is consumed', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-live');
    const { attemptId, packet } = consumeOnePacket(fixture);
    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].attemptId, attemptId);
    assert.equal(report.attempts[0].state, 'live');
    assert.equal(report.attempts[0].packetId, packet.packetId);
    // Nothing built yet, so a replacement costs nothing and is still permitted.
    assert.equal(report.newPacketPermitted, true);
  });

  it('refuses to mint a replacement once Engineer work is recorded', async () => {
    // The exact field-session move, through the real command.
    const fixture = await createDispatchFixture(temp, 'attempt-refuse');
    const { consumption, attemptId } = consumeOnePacket(fixture);
    recordEngineerMutation(fixture, consumption);

    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 1);
    const report = JSON.parse(status.stdout);
    assert.equal(report.newPacketPermitted, false);
    assert.equal(report.liveAttempt.attemptId, attemptId);
    assert.match(report.reason, /reaches a canonical return or is explicitly abandoned/);
    // One complete safe next action, naming both legal exits with real commands.
    assert.match(report.safeRepair, /task prepare-return T-001 --packet/);
    assert.match(report.safeRepair, new RegExp(`task abandon-attempt T-001 --attempt ${attemptId}`));
  });

  it('abandons a live attempt explicitly and preserves it on record', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-abandon');
    const { consumption, attemptId } = consumeOnePacket(fixture);
    recordEngineerMutation(fixture, consumption);

    const abandoned = await cli(fixture, [
      'task', 'abandon-attempt', 'T-001', '--attempt', attemptId,
      '--reason', 'the retained packet cannot prove the original product base',
      '--authority', 'operator:x', '--json',
    ]);
    assert.equal(abandoned.status, 0, abandoned.stderr);
    const record = JSON.parse(abandoned.stdout);
    assert.equal(record.attemptId, attemptId);
    assert.ok(existsInTarget(fixture, record.path), 'the abandonment record is written');

    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.newPacketPermitted, true, 'a new attempt is permitted after abandonment');
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0].state, 'abandoned');
    // The abandoned attempt is preserved, not erased: its packet, base, and
    // stated reason all survive so the history stays explicable.
    assert.equal(report.attempts[0].abandonment.reason,
      'the retained packet cannot prove the original product base');
    assert.equal(report.attempts[0].abandonment.authority, 'operator:x');
    assert.ok(report.attempts[0].productBaseHead);
  });

  it('refuses to abandon an attempt that does not exist', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-unknown');
    consumeOnePacket(fixture);
    const result = await cli(fixture, [
      'task', 'abandon-attempt', 'T-001', '--attempt', `attempt:${'f'.repeat(32)}`,
      '--reason', 'inventing a record for an attempt that never happened',
      '--authority', 'operator:x', '--json',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not recorded for T-001/);
    assert.match(result.stderr, /task attempt-status T-001/);
  });

  it('refuses to abandon the same attempt twice', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-twice');
    const { consumption, attemptId } = consumeOnePacket(fixture);
    recordEngineerMutation(fixture, consumption);
    const args = [
      'task', 'abandon-attempt', 'T-001', '--attempt', attemptId,
      '--reason', 'the retained packet cannot prove the original product base',
      '--authority', 'operator:x', '--json',
    ];
    assert.equal((await cli(fixture, args)).status, 0);
    const second = await cli(fixture, args);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already abandoned/);
  });

  it('requires a stated reason and a durable authority', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-usage');
    const { attemptId } = consumeOnePacket(fixture);
    const missing = await cli(fixture, ['task', 'abandon-attempt', 'T-001', '--attempt', attemptId]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--reason .* and --authority|--reason|--authority/);

    const weak = await cli(fixture, [
      'task', 'abandon-attempt', 'T-001', '--attempt', attemptId,
      '--reason', 'wip', '--authority', 'operator:x',
    ]);
    assert.equal(weak.status, 2);
    assert.match(weak.stderr, /reason must state why/);
  });
});

describe('guards the interpretation the field session got wrong', () => {
  it('keeps the same-checkout dispatch-to-consumption flow working', async () => {
    // The correction: same-checkout execution is supported. The field run
    // lost its lineage; it did not prove a protocol impossibility. If this ever
    // fails, the conservation rule has over-reached.
    const fixture = await createDispatchFixture(temp, 'attempt-same-checkout');
    const { packet, consumption, attemptId } = consumeOnePacket(fixture);
    assert.equal(consumption.packetId, packet.packetId);
    assert.equal(consumption.productBaseHead, packet.repository.head);
    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).attempts[0].attemptId, attemptId);
  });

  it('does not let an unrelated commit invalidate a live attempt', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-unrelated');
    const { attemptId } = consumeOnePacket(fixture);
    writeFileSync(join(fixture.root, 'UNRELATED.md'), '# unrelated\n', 'utf8');
    fixtureGit(fixture.root, ['add', '-A']);
    fixtureGit(fixture.root, ['commit', '-m', 'unrelated\n\nTask: T-001\nAgent: maintainer']);
    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    const report = JSON.parse(status.stdout);
    assert.equal(report.attempts[0].attemptId, attemptId, 'the attempt identity is stable');
    assert.equal(report.attempts[0].state, 'live');
  });

  it('does not count a receipt from another dispatch generation as work under this attempt', async () => {
    // Receipts are scoped by the immutable dispatch tuple, not by wall clock,
    // so an unrelated generation's receipt cannot make a fresh attempt
    // unstartable.
    const fixture = await createDispatchFixture(temp, 'attempt-foreign-receipt');
    const { consumption } = consumeOnePacket(fixture);
    const foreign = recordEngineerMutation(fixture, {
      ...consumption,
      dispatchCarrierDigest: `sha256:${'9'.repeat(64)}`,
      invocationId: 'some-other-invocation',
    }, 'T-001', { receiptId: 'task-mutation:bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
    assert.equal(foreign.producer.invocationId, 'some-other-invocation');
    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).newPacketPermitted, true);
  });
});

function existsInTarget(fixture, relPath) {
  try {
    readFileSync(join(fixture.root, ...String(relPath).split('/')), 'utf8');
    return true;
  } catch {
    return false;
  }
}

describe('the attempt ledger notices rewritten execution provenance', () => {
  it('refuses a new packet after the attempt range is reset, with a Maintainer-owned repair', async () => {
    // The field run's Engineer performed history repair - it reset commits -
    // and the Orchestrator's first recovery act an hour later was to check
    // whether any `git replace` refs had survived. Nothing mechanically
    // prevented or noticed it; the reset was discovered after the fact.
    const fixture = await createDispatchFixture(temp, 'attempt-history-reset');
    const { consumption } = consumeOnePacket(fixture);
    recordEngineerMutation(fixture, consumption);
    fixtureGit(fixture.root, ['commit', '--allow-empty', '-m', 'work\n\nTask: T-001\nAgent: engineer']);

    // Exactly what "repairing history" does to the base an attempt is evidence
    // about: the recorded commit stops being reachable from the current head.
    fixtureGit(fixture.root, ['checkout', '-q', '--orphan', 'rewritten']);
    fixtureGit(fixture.root, ['commit', '--allow-empty', '-m', 'rewritten history\n\nTask: T-001\nAgent: engineer']);

    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 1);
    const report = JSON.parse(status.stdout);
    assert.equal(report.newPacketPermitted, false);
    assert.match(report.reason, /rewritten or replaced/);
    assert.match(report.reason, /no longer an ancestor of the current head|no longer a reachable commit object/);
    // The repair is Maintainer-owned: the role that rewrote the history is
    // exactly the role that cannot authorize the rewrite.
    assert.match(report.safeRepair, /Maintainer-owned repair/);
    assert.match(report.safeRepair, /commit-attribution repair-record-render/);
  });

  it('reports history as unevaluated rather than rewritten when there are no attempts', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-history-none');
    const status = await cli(fixture, ['task', 'attempt-status', 'T-001', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).newPacketPermitted, true);
  });
});
