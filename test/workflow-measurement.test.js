/**
 * Measurement: derived, bounded, privacy-clean, and not a truth store.
 *
 * The field session was measured from outside and the process was found
 * spending more effort on its own evidence than on the product task. Getting
 * those numbers back is useful; getting them back as a second persisted store
 * is not, because a second store drifts from the first and then a reader has to
 * decide which one is true.
 *
 * So the constraint - "telemetry is not task evidence and must not become a
 * second workflow truth store" - is honoured by making it unviolatable: this
 * measurement persists nothing and derives everything from evidence that
 * already exists for its own reasons. These cases pin that, the privacy
 * property, and the deviation reporting the exit gate asks for.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ORDINARY_TASK_SHAPE,
  assertPrivacyClean,
  measureTaskWorkflow,
} from '../src/workflow-measurement.js';
import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../src/handoff-consumption.js';
import { executionAttemptAbandonmentRelativePath, executionAttemptIdentity } from '../src/execution-attempt.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createDispatchFixture, git as fixtureGit, prepare } from './helpers/dispatch-fixture.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-measure-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/** Consume one genuine packet. */
function consume(fixture, taskId = 'T-001') {
  const prepared = prepare(fixture);
  assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
  const packet = prepared.packet;
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
  return writeConsumption(fixture, createDispatchConsumption({ backend: 'files', taskId, recognition }));
}

function writeConsumption(fixture, consumption) {
  const path = join(fixture.root, dispatchConsumptionRelativePath(consumption));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');
  return consumption;
}

/**
 * Produce a genuine second attempt, the way one actually arises.
 *
 * Not a hand-edited copy of the first record: a consumption is digest-bound to
 * its recognition, so an edited one is simply invalid and would be *excluded*
 * from the measurement rather than counted - which is the correct behaviour and
 * would have made this case prove nothing.
 *
 * So the first consumption is committed (which is what an operator does, and
 * what clears the clean gate that otherwise blocks a second packet), and the
 * moved HEAD gives the second packet a genuinely different product base. That
 * is exactly the field shape: work rebuilt on a base the earlier
 * packet never described.
 */
function recordSecondAttempt(fixture, taskId = 'T-001', { moveBase = true } = {}) {
  fixtureGit(fixture.root, ['add', '-A']);
  fixtureGit(fixture.root, ['commit', '-m', `record first attempt\n\nTask: ${taskId}\nAgent: maintainer`]);
  if (moveBase) {
    // The fixture pins its repository projection at build time, so rebinding it
    // to the moved HEAD is what expresses "the second packet describes a
    // different product base". Without this the two attempts share a base,
    // which is a retry rather than a rebuild - a distinction the counters keep.
    const head = fixtureGit(fixture.root, ['rev-parse', 'HEAD']);
    const previous = fixture.repository();
    fixture.repository = () => ({ ...previous, head, baseHead: head });
    fixture.refetchRepository = fixture.repository;
  }
  return consume(fixture, taskId);
}

describe('measurement stores nothing and says so', () => {
  it('declares itself derived and non-authoritative', async () => {
    const fixture = await createDispatchFixture(temp, 'measure-declares');
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    assert.equal(measurement.derived, true);
    assert.equal(measurement.persisted, false);
    assert.equal(measurement.authority, 'none');
  });

  it('writes nothing into the target', async () => {
    // The constraint made unviolatable: measuring twice leaves the tree exactly
    // as it was, so there is no second store to drift from the first.
    const fixture = await createDispatchFixture(temp, 'measure-readonly');
    consume(fixture);
    const before = await runCliInProcess(['task', 'measure', 'T-001', '--json', '--target', fixture.root]);
    assert.equal(before.status, 0, before.stderr);
    const after = await runCliInProcess(['task', 'measure', 'T-001', '--json', '--target', fixture.root]);
    assert.equal(after.status, 0, after.stderr);
    const first = JSON.parse(before.stdout);
    const second = JSON.parse(after.stdout);
    // Everything except the observation instant is identical, because nothing
    // the first call did could change the second.
    assert.deepEqual(first.counters, second.counters);
    assert.deepEqual(first.attempts, second.attempts);
  });

  it('carries only identities, counts, and instants', async () => {
    const fixture = await createDispatchFixture(temp, 'measure-privacy');
    consume(fixture);
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    const clean = assertPrivacyClean(measurement);
    assert.equal(clean.ok, true, clean.violations.join('; '));
  });

  it('never surfaces an abandonment reason, which is free text', async () => {
    // The nearest free-text field in reach. It exists in the abandonment record
    // for a human to read there; the measurement has nowhere to put it.
    const fixture = await createDispatchFixture(temp, 'measure-no-prose');
    const consumption = consume(fixture);
    const attemptId = executionAttemptIdentity(consumption);
    const reason = 'the retained packet cannot prove the original product base';
    const record = {
      kind: 'agenticloop.execution-attempt-abandonment',
      schemaVersion: 1,
      backend: 'files',
      taskId: 'T-001',
      attemptId,
      packetId: consumption.packetId,
      reason,
      disposition: 'abandoned',
      authority: 'operator:x',
      abandonedAt: new Date().toISOString(),
    };
    const path = join(fixture.root, executionAttemptAbandonmentRelativePath(record));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    assert.equal(measurement.counters.abandonedAttempts, 1);
    assert.equal(JSON.stringify(measurement).includes(reason), false, 'a stated reason must never enter a measurement');
    assert.equal(assertPrivacyClean(measurement).ok, true);
  });
});

describe('the ordinary shape and its deviations', () => {
  it('reports the ordinary fixture as one attempt with no deviations', async () => {
    // The exit-gate case: one packet, one attempt, nothing abandoned, nothing
    // rebuilt on a second base.
    const fixture = await createDispatchFixture(temp, 'measure-ordinary');
    consume(fixture);
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    assert.equal(measurement.counters.executionAttempts, ORDINARY_TASK_SHAPE.executionAttempts);
    assert.equal(measurement.counters.abandonedAttempts, ORDINARY_TASK_SHAPE.abandonedAttempts);
    assert.equal(measurement.counters.packetRemints, 0);
    assert.deepEqual([...measurement.deviations], []);
    assert.equal(measurement.complete, true);
  });

  it('reports a remint against a second product base as a deviation', async () => {
    // The field shape, counted: two attempts against two different bases means
    // work was rebuilt on a base the earlier packet never described.
    const fixture = await createDispatchFixture(temp, 'measure-remint');
    const first = consume(fixture);
    const second = recordSecondAttempt(fixture);
    assert.notEqual(second.productBaseHead, first.productBaseHead, 'the second attempt starts from a different base');
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    assert.equal(measurement.counters.executionAttempts, 2);
    assert.equal(measurement.counters.packetRemints, 1);
    assert.equal(measurement.counters.distinctProductBases, 2);
    const shapes = measurement.deviations.map(item => item.shape);
    assert.ok(shapes.includes('executionAttempts'));
    assert.ok(shapes.includes('distinctProductBases'));
  });

  it('reports zero attempts for a task that never started', async () => {
    const fixture = await createDispatchFixture(temp, 'measure-none');
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    assert.equal(measurement.counters.executionAttempts, 0);
    assert.equal(measurement.liveAttemptId, null);
    assert.equal(measurement.complete, true);
  });

  it('names unreadable evidence rather than counting it as zero', async () => {
    // A measurement that reads a broken store as "nothing happened" is worse
    // than no measurement, because it looks like a clean run.
    const fixture = await createDispatchFixture(temp, 'measure-unreadable');
    const dir = join(fixture.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    assert.equal(measurement.complete, false);
    assert.ok(measurement.unreadableEvidence.includes('dispatch_consumption'));

    const result = await runCliInProcess(['task', 'measure', 'T-001', '--json', '--target', fixture.root]);
    assert.equal(result.status, 1, 'an incomplete measurement is not reported as a clean run');
  });
});

describe('measurement never invents a number', () => {
  it('omits a duration whose endpoints are not both durable evidence', async () => {
    const fixture = await createDispatchFixture(temp, 'measure-duration');
    const measurement = measureTaskWorkflow(fixture.root, 'T-001');
    // No attempt exists, so neither stage has endpoints. Absent, not estimated.
    assert.equal(measurement.durations.firstAttemptToLatestAttemptSeconds, null);
    assert.equal(measurement.durations.liveAttemptElapsedSeconds, null);
  });

  it('derives an elapsed duration only from recorded instants', async () => {
    const fixture = await createDispatchFixture(temp, 'measure-elapsed');
    const consumption = consume(fixture);
    const later = new Date(Date.parse(consumption.consumedAt) + 90_000).toISOString();
    const measurement = measureTaskWorkflow(fixture.root, 'T-001', { now: later });
    assert.equal(measurement.durations.liveAttemptElapsedSeconds, 90);
  });
});
