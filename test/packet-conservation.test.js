/**
 * A consumed packet is conserved.
 *
 * The field record shows a session that dispatched before readiness was settled, then
 * minted fresh packets and repaired history after implementation until no
 * retained packet represented the start of the work that existed. Return
 * production then had nothing truthful to bind, and the session concluded that
 * same-checkout return was structurally impossible. It is not: the field run
 * destroyed its lineage, it did not discover a protocol limit. The passing
 * same-checkout return case is guarded below so that correction stays recorded.
 *
 * The rule these cases pin: a consumed packet reaches a canonical return or is
 * explicitly abandoned. It is never silently replaced once an Engineer has
 * built against it.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  EXECUTION_ATTEMPT_ABANDONMENT_KIND,
  EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION,
  PACKET_CONSERVATION_DIAGNOSTIC_CODE,
  evaluatePacketConservation,
  evaluateTaskPacketConservation,
  executionAttemptAbandonmentRelativePath,
  executionAttemptIdentity,
  groupExecutionAttempts,
  listExecutionAttemptAbandonments,
  validateExecutionAttemptAbandonment,
} from '../src/execution-attempt.js';
import { repairPolicyFor } from '../src/repair-policy.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-conserve-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/** A consumption-shaped record carrying only the fields conservation reads. */
function consumption(overrides = {}) {
  return {
    taskId: 'T-001',
    packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
    packetDigest: `sha256:agenticloop.role-preparation.v9:${'a'.repeat(64)}`,
    invocationId: 'invocation-1',
    dispatchCarrierDigest: `sha256:${'c'.repeat(64)}`,
    productBaseHead: '1'.repeat(40),
    consumedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function abandonment(attemptId, overrides = {}) {
  return {
    kind: EXECUTION_ATTEMPT_ABANDONMENT_KIND,
    schemaVersion: EXECUTION_ATTEMPT_ABANDONMENT_SCHEMA_VERSION,
    backend: 'files',
    taskId: 'T-001',
    attemptId,
    packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
    reason: 'the retained packet was minted after product work and cannot prove the original base',
    disposition: 'abandoned',
    authority: 'operator:x',
    abandonedAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('execution-attempt identity', () => {
  it('is derived from the evidence rather than minted beside it', () => {
    const record = consumption();
    assert.equal(executionAttemptIdentity(record), executionAttemptIdentity({ ...record }));
    assert.match(executionAttemptIdentity(record), /^attempt:[a-f0-9]{32}$/);
  });

  it('distinguishes attempts that share a packet but not a product base', () => {
    // The exact confusion the field session produced: a packet minted after product work
    // names a different base, and must never be read as the original attempt.
    const first = consumption({ productBaseHead: '1'.repeat(40) });
    const reminted = consumption({ productBaseHead: '2'.repeat(40) });
    assert.notEqual(executionAttemptIdentity(first), executionAttemptIdentity(reminted));
  });

  it('distinguishes attempts that share a base but not an invocation', () => {
    const first = consumption({ invocationId: 'invocation-1' });
    const second = consumption({ invocationId: 'invocation-2' });
    assert.notEqual(executionAttemptIdentity(first), executionAttemptIdentity(second));
  });

  it('refuses to derive an identity from incomplete evidence', () => {
    for (const missing of ['packetId', 'invocationId', 'productBaseHead']) {
      assert.throws(
        () => executionAttemptIdentity({ ...consumption(), [missing]: undefined }),
        /execution attempt identity requires/
      );
    }
  });
});

describe('attempts are grouped from durable evidence', () => {
  it('orders attempts deterministically and marks the abandoned ones', () => {
    const first = consumption({ consumedAt: '2026-08-01T10:00:00.000Z' });
    const second = consumption({
      packetId: 'dispatch:22222222-2222-4222-8222-222222222222',
      invocationId: 'invocation-2',
      consumedAt: '2026-08-01T11:00:00.000Z',
    });
    const attempts = groupExecutionAttempts({
      // Supplied out of order on purpose: ordering is derived, not trusted.
      consumptions: [second, first],
      abandonments: [abandonment(executionAttemptIdentity(first))],
    });
    assert.deepEqual(attempts.map(item => item.sequence), [1, 2]);
    assert.equal(attempts[0].attemptId, executionAttemptIdentity(first));
    assert.equal(attempts[0].state, 'abandoned');
    assert.equal(attempts[1].state, 'live');
    assert.equal(attempts[0].abandonment.authority, 'operator:x');
  });

  it('preserves each attempt product base distinctly', () => {
    const attempts = groupExecutionAttempts({
      consumptions: [
        consumption({ productBaseHead: '1'.repeat(40) }),
        consumption({
          packetId: 'dispatch:22222222-2222-4222-8222-222222222222',
          invocationId: 'invocation-2',
          productBaseHead: '2'.repeat(40),
          consumedAt: '2026-08-01T11:00:00.000Z',
        }),
      ],
    });
    assert.deepEqual(attempts.map(item => item.productBaseHead), ['1'.repeat(40), '2'.repeat(40)]);
  });
});

describe('packet conservation decides new dispatch', () => {
  it('permits a first attempt', () => {
    const verdict = evaluatePacketConservation({ consumptions: [], abandonments: [] });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.liveAttempt, null);
  });

  it('permits replacing a live attempt that has produced nothing', () => {
    // Refusing here would turn an ordinary retry into an operator ceremony:
    // nothing was built against the old base, so nothing is lost.
    const verdict = evaluatePacketConservation({
      consumptions: [consumption()],
      abandonments: [],
      engineerMutationCount: 0,
    });
    assert.equal(verdict.ok, true);
    assert.ok(verdict.liveAttempt, 'the live attempt is still reported');
  });

  it('refuses to replace a live attempt that has recorded Engineer work', () => {
    const record = consumption();
    const verdict = evaluatePacketConservation({
      consumptions: [record],
      abandonments: [],
      engineerMutationCount: 2,
      taskId: 'T-018',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, PACKET_CONSERVATION_DIAGNOSTIC_CODE);
    assert.equal(verdict.liveAttempt.attemptId, executionAttemptIdentity(record));
    assert.match(verdict.reason, /reaches a canonical return or is explicitly abandoned/);
    // One complete safe next action, naming both legal exits.
    assert.match(verdict.repair, /task prepare-return T-018 --packet/);
    assert.match(verdict.repair, /task abandon-attempt T-018 --attempt attempt:[a-f0-9]{32}/);
  });

  it('permits a new attempt once the previous one is explicitly abandoned', () => {
    const record = consumption();
    const verdict = evaluatePacketConservation({
      consumptions: [record],
      abandonments: [abandonment(executionAttemptIdentity(record))],
      engineerMutationCount: 5,
    });
    assert.equal(verdict.ok, true, 'an abandoned attempt no longer blocks a new one');
    assert.equal(verdict.attempts[0].state, 'abandoned');
  });

  it('routes the refusal to a role owner with a human-authority escalation', () => {
    // Completing the attempt is Engineer work; discarding execution evidence is
    // an operator decision. The policy layer, not the evaluator, says so.
    const policy = repairPolicyFor(PACKET_CONSERVATION_DIAGNOSTIC_CODE);
    assert.equal(policy.repairKind, 'complete_or_abandon_attempt');
    assert.match(policy.escalationKind, /^human_authority/);
  });
});

describe('abandonment records are authored, never inferred', () => {
  it('requires a stated reason and a durable authority', () => {
    const base = abandonment('attempt:' + 'a'.repeat(32));
    assert.equal(validateExecutionAttemptAbandonment(base, { taskId: 'T-001' }).ok, true);

    for (const [field, value, pattern] of [
      ['reason', '', /reason must state why/],
      ['reason', 'too short', /reason must state why/],
      ['authority', 'not-a-reference', /authority must be a durable/],
      ['authority', '', /authority must be a durable/],
      ['disposition', 'invented', /disposition must be/],
    ]) {
      const checked = validateExecutionAttemptAbandonment({ ...base, [field]: value }, { taskId: 'T-001' });
      assert.equal(checked.ok, false, `${field}=${JSON.stringify(value)} must be refused`);
      assert.match(checked.errors.join('; '), pattern);
    }
  });

  it('refuses a record bound to another task or a future instant', () => {
    const base = abandonment('attempt:' + 'a'.repeat(32));
    assert.equal(validateExecutionAttemptAbandonment(base, { taskId: 'T-999' }).ok, false);
    const future = { ...base, abandonedAt: new Date(Date.now() + 600000).toISOString() };
    const checked = validateExecutionAttemptAbandonment(future, { taskId: 'T-001' });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /future-dated/);
  });

  it('refuses an open schema', () => {
    const base = abandonment('attempt:' + 'a'.repeat(32));
    const checked = validateExecutionAttemptAbandonment({ ...base, extra: true }, { taskId: 'T-001' });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /closed schema/);
  });
});

describe('unreadable evidence fails closed', () => {
  function targetWith(files) {
    const root = mkdtempSync(join(temp, 'target-'));
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(root, ...relPath.split('/'));
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  it('treats an unreadable abandonment as a refusal, not as an absence', () => {
    // The failure mode that matters: a corrupted abandonment must never be
    // read as "no abandonment exists", because that direction silently
    // re-enables the reminting this module refuses.
    const root = targetWith({
      '.agenticloop/handoffs/attempts/T-001/attempt_abc.json': '{ not json',
    });
    const listed = listExecutionAttemptAbandonments(root, 'T-001');
    assert.equal(listed.ok, false);
    const verdict = evaluateTaskPacketConservation(root, 'T-001');
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /abandonment evidence is unreadable/);
  });

  it('refuses an abandonment whose filename does not match its attempt', () => {
    const attemptId = `attempt:${'a'.repeat(32)}`;
    const root = targetWith({
      '.agenticloop/handoffs/attempts/T-001/wrong-name.json':
        `${JSON.stringify(abandonment(attemptId), null, 2)}\n`,
    });
    const listed = listExecutionAttemptAbandonments(root, 'T-001');
    assert.equal(listed.ok, false);
    assert.match(listed.errors.join('; '), /filename does not match its attempt identity/);
  });

  it('reports no attempts for a task that has never been dispatched', () => {
    const root = targetWith({});
    const verdict = evaluateTaskPacketConservation(root, 'T-404');
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.attempts, []);
    assert.equal(verdict.liveAttempt, null);
  });

  it('places an abandonment record at a path derived from its own identity', () => {
    const record = abandonment(`attempt:${'b'.repeat(32)}`);
    assert.equal(
      executionAttemptAbandonmentRelativePath(record),
      `.agenticloop/handoffs/attempts/T-001/attempt_${'b'.repeat(32)}.json`
    );
  });
});
