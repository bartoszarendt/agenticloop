/**
 * Retry bounds, session reuse, revocation, adoption.
 *
 * Four small policies that each close one named deferral. They share a shape:
 * the field record showed a loop or a conflation that nothing bounded, and the
 * fix is to name the boundary rather than to add a mechanism.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_EMPTY_RETURN_BUDGET,
  DEFAULT_IDENTICAL_TOOLING_FAILURE_BUDGET,
  EMPTY_RETURN_DIAGNOSTIC_CODE,
  NON_REUSABLE_ROLES,
  SESSION_IDENTITY_FIELDS,
  TOOLING_FAILURE_DIAGNOSTIC_CODE,
  evaluateEmptyReturnBudget,
  evaluateToolingFailureRetry,
  evaluateSessionReuse,
} from '../src/role-session-policy.js';
import {
  REVOCATION_DURING_EXECUTION_DISPOSITIONS,
  revocationDuringExecutionPlan,
} from '../src/activation-repair.js';
import {
  HISTORICAL_ADOPTION_ASSURANCE,
  createHistoricalAdoption,
  historicalAdoptionRelativePath,
  readHistoricalAdoption,
} from '../src/historical-adoption.js';
import { repairPolicyFor } from '../src/repair-policy.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-role-policy-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

// ── Empty-return retry bounds ────────────────────────────────────────────────

describe('an empty-return loop is bounded', () => {
  it('permits retries below the budget', () => {
    const verdict = evaluateEmptyReturnBudget({ emptyReturns: 1, budget: 3 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.remaining, 2);
  });

  it('stops and reports once the budget is reached', () => {
    // The field record showed repeated invocations "including empty returns" with
    // nothing bounding the loop. The budget converts an invisible loop into one
    // explicit diagnostic.
    const verdict = evaluateEmptyReturnBudget({
      emptyReturns: DEFAULT_EMPTY_RETURN_BUDGET,
      roleId: 'maintainer',
      taskId: 'T-018',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.exhausted, true);
    assert.equal(verdict.code, EMPTY_RETURN_DIAGNOSTIC_CODE);
    assert.match(verdict.reason, /returned no result/);
    // The repair says to diagnose, not to retry. Retrying without a change is
    // the behaviour the budget exists to stop.
    assert.match(verdict.repair, /Retrying without a change repeats the same outcome/);
  });

  it('emits exactly one diagnostic rather than escalating with each retry', () => {
    const first = evaluateEmptyReturnBudget({ emptyReturns: 2, budget: 2 });
    const later = evaluateEmptyReturnBudget({ emptyReturns: 9, budget: 2 });
    assert.equal(first.code, later.code);
    assert.equal(later.remaining, 0);
  });

  it('routes the diagnostic to a real owner', () => {
    assert.ok(repairPolicyFor(EMPTY_RETURN_DIAGNOSTIC_CODE));
  });

  it('treats malformed counts as zero rather than as exhaustion', () => {
    // Failing closed here would block work on a bad counter; the count is
    // telemetry, not evidence.
    for (const emptyReturns of [undefined, null, -1, 'many']) {
      assert.equal(evaluateEmptyReturnBudget({ emptyReturns }).ok, true, String(emptyReturns));
    }
  });
});

describe('an identical tooling-failure loop is contract-bound and bounded', () => {
  const failure = {
    taskId: 'T-018',
    taskContractDigest: `sha256:v1:${'a'.repeat(64)}`,
    attemptId: `attempt:${'1'.repeat(32)}`,
    attemptState: 'live',
    contractCurrent: true,
    operation: 'task role-start',
    signature: 'spawn:ENOENT:node',
    mutationOccurred: false,
    safeToRetry: true,
  };

  it('permits one recovery but stops the repeated identical failure', () => {
    const first = evaluateToolingFailureRetry({ current: failure });
    assert.equal(first.retryPermitted, true);
    const repeated = evaluateToolingFailureRetry({ current: failure, failures: [failure] });
    assert.equal(repeated.retryPermitted, false);
    assert.equal(repeated.repeated, DEFAULT_IDENTICAL_TOOLING_FAILURE_BUDGET);
    assert.match(repeated.repair, /Stop retrying/);
    assert.ok(repairPolicyFor(TOOLING_FAILURE_DIAGNOSTIC_CODE));
  });

  it('does not conflate a changed task, contract, attempt, operation, or signature', () => {
    for (const current of [
      { ...failure, taskId: 'T-019' },
      { ...failure, taskContractDigest: `sha256:v1:${'b'.repeat(64)}` },
      { ...failure, attemptId: `attempt:${'2'.repeat(32)}` },
      { ...failure, operation: 'task prepare-return' },
      { ...failure, signature: 'exit:1' },
    ]) {
      assert.equal(evaluateToolingFailureRetry({ current, failures: [failure] }).retryPermitted, true);
    }
  });

  it('refuses to guess from an unshaped failure', () => {
    assert.equal(evaluateToolingFailureRetry({ current: { taskId: 'T-018' } }).retryPermitted, false);
  });

  it('requires a live current safe no-mutation attempt and honors zero budget', () => {
    for (const current of [
      { ...failure, mutationOccurred: true },
      { ...failure, safeToRetry: false },
      { ...failure, contractCurrent: false },
      { ...failure, attemptState: 'returned' },
      { ...failure, attemptState: 'accepted' },
      { ...failure, attemptState: 'superseded_by_packet' },
      { ...failure, attemptState: 'abandoned' },
    ]) assert.equal(evaluateToolingFailureRetry({ current }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current: failure, budget: 0 }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current: failure, budget: 1 }).retryPermitted, false);
    assert.equal(evaluateToolingFailureRetry({ current: failure, budget: 2 }).retryPermitted, true);
  });
});

// ── Session reuse ────────────────────────────────────────────────────────────

describe('a session is reused only while it still describes the work', () => {
  const identity = {
    taskId: 'T-018',
    taskContractDigest: `sha256:v1:${'a'.repeat(64)}`,
    packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
    roleId: 'engineer',
    hostExecutionIdentity: 'host:claude-code#1',
  };

  it('reuses a live session whose identity is unchanged', () => {
    const verdict = evaluateSessionReuse({ session: { ...identity }, current: { ...identity }, live: true });
    assert.equal(verdict.reusable, true);
  });

  it('refuses reuse when any identity field moved, and names which', () => {
    // "Something changed" is not actionable. Each field is checked and reported
    // so a caller knows what invalidated the session.
    for (const field of SESSION_IDENTITY_FIELDS) {
      if (field === 'roleId') continue; // covered by the auditor case below
      const verdict = evaluateSessionReuse({
        session: { ...identity },
        current: { ...identity, [field]: 'changed' },
        live: true,
      });
      assert.equal(verdict.reusable, false, field);
      assert.deepEqual([...verdict.changedFields], [field]);
    }
  });

  it('refuses a session that is not live', () => {
    const verdict = evaluateSessionReuse({ session: { ...identity }, current: { ...identity }, live: false });
    assert.equal(verdict.reusable, false);
    assert.match(verdict.reason, /not live/);
  });

  it('never reuses an Auditor session', () => {
    // Independence is structural: an audit that continues a prior session is no
    // longer independent of what that session concluded.
    const auditor = { ...identity, roleId: 'auditor' };
    const verdict = evaluateSessionReuse({ session: { ...auditor }, current: { ...auditor }, live: true });
    assert.equal(verdict.reusable, false);
    assert.match(verdict.reason, /not be independent/);
    assert.ok(NON_REUSABLE_ROLES.includes('auditor'));
  });

  it('refuses when there is no prior session at all', () => {
    assert.equal(evaluateSessionReuse({ current: { ...identity }, live: true }).reusable, false);
    assert.equal(evaluateSessionReuse({}).reusable, false);
  });
});

// ── Revocation during execution ──────────────────────────────────────────────

describe('revocation during execution is not expiry', () => {
  it('states the distinction rather than implying it', () => {
    // Expiry is non-retroactive because the authority lapsed. Revocation is a
    // deliberate withdrawal, so it fails at every instant including consumption.
    const plan = revocationDuringExecutionPlan({ taskId: 'T-018' });
    assert.equal(plan.distinctFromExpiry, true);
    assert.match(plan.note, /Expiry is non-retroactive; revocation is not/);
  });

  it('offers both dispositions and defaults to neither', () => {
    // Discarding completed work and continuing under withdrawn authority are
    // both human decisions. Picking one automatically would make it silently.
    const plan = revocationDuringExecutionPlan({
      taskId: 'T-018',
      attemptId: `attempt:${'a'.repeat(32)}`,
      hasRecordedWork: true,
    });
    assert.deepEqual(
      plan.options.map(option => option.disposition).sort(),
      [...REVOCATION_DURING_EXECUTION_DISPOSITIONS].sort()
    );
    assert.equal(plan.defaultDisposition, null);
    assert.match(
      plan.options.find(option => option.disposition === 'abandon_attempt').command,
      /task abandon-attempt T-018 --attempt attempt:[a-f0-9]{32}/
    );
  });

  it('points at attempt-status when the attempt is not yet identified', () => {
    const plan = revocationDuringExecutionPlan({ taskId: 'T-018' });
    assert.match(
      plan.options.find(option => option.disposition === 'abandon_attempt').command,
      /task attempt-status T-018/
    );
  });
});

// ── Adoption reader ──────────────────────────────────────────────────────────

describe('closeout can consume an adoption without inventing evidence', () => {
  const COMMIT = 'a'.repeat(40);

  function adoptionRecord(overrides = {}) {
    return createHistoricalAdoption({
      backend: 'files',
      taskId: 'T-016',
      repositoryIdentity: 'file:/tmp/fixture-repo',
      taskContractDigest: `sha256:v1:${'c'.repeat(64)}`,
      implementationArtifact: { kind: 'git_commit', commit: COMMIT },
      integration: { kind: 'git_merge', reference: 'main', commit: 'b'.repeat(40) },
      audit: { reference: 'audit:WU-1', auditedArtifact: COMMIT, independent: true },
      disposition: {
        kind: 'human_adoption',
        authority: 'operator:x',
        reason: 'this task predates canonical dispatch and return evidence',
      },
      missingEvidence: ['dispatch_packet', 'verified_return'],
      ...overrides,
    });
  }

  function targetWith(content) {
    const root = mkdtempSync(join(temp, 'adopt-'));
    if (content !== null) {
      const path = join(root, ...historicalAdoptionRelativePath('T-016').split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content, 'utf8');
    }
    return root;
  }

  it('reads a valid adoption and reports its reduced assurance', () => {
    const root = targetWith(`${JSON.stringify(adoptionRecord(), null, 2)}\n`);
    const read = readHistoricalAdoption(root, 'T-016');
    assert.equal(read.ok, true, read.errors.join('; '));
    assert.equal(read.record.assurance, HISTORICAL_ADOPTION_ASSURANCE);
    assert.deepEqual([...read.record.missingEvidence], ['dispatch_packet', 'verified_return']);
  });

  it('distinguishes "not adopted" from "adoption is damaged"', () => {
    // The distinction that matters: a corrupted adoption falling back to "not
    // adopted" would hide the damage behind an ordinary refusal.
    const absent = readHistoricalAdoption(targetWith(null), 'T-016');
    assert.equal(absent.ok, false);
    assert.deepEqual(absent.errors, []);

    const damaged = readHistoricalAdoption(targetWith('{ not json'), 'T-016');
    assert.equal(damaged.ok, false);
    assert.ok(damaged.errors.length > 0, 'a damaged record reports why');
  });

  it('refuses an adoption bound to a different contract', () => {
    const root = targetWith(`${JSON.stringify(adoptionRecord(), null, 2)}\n`);
    const read = readHistoricalAdoption(root, 'T-016', {
      taskContractDigest: `sha256:v1:${'d'.repeat(64)}`,
    });
    assert.equal(read.ok, false);
    assert.match(read.errors.join('; '), /exact current task contract/);
  });

  it('refuses an adoption whose record was edited after freezing', () => {
    const tampered = { ...adoptionRecord(), assurance: 'operator_confirmed' };
    const root = targetWith(`${JSON.stringify(tampered, null, 2)}\n`);
    assert.equal(readHistoricalAdoption(root, 'T-016').ok, false);
  });
});
