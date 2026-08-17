/**
 * P35-C12R.6: a task that becomes ready inside authorized intent.
 *
 * C12-F9's operator complaint was that a milestone of eight tasks read as eight
 * confirmations. Surfacing `--work-unit` at every refusal fixes discovery; this
 * fixes the rest - a task that reaches the ready set *after* the operator
 * authorized its work unit is inside their stated intent but outside the set
 * derived at activation time, so it asks again.
 *
 * Removing that second ask is only safe under one rule, and these cases exist
 * to keep the rule narrow: a lease derives without a new operator action only
 * for a task inside the **exact** scope confirmed. Otherwise "authorize the
 * milestone" quietly becomes "authorize whatever anyone later files under this
 * milestone", which is a materially different thing to consent to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE_EXPANSION_DIAGNOSTIC_CODE,
  evaluateWorkUnitLease,
  workUnitScopeDigest,
} from '../src/work-unit-lease.js';
import { repairPolicyFor } from '../src/repair-policy.js';

const members = [
  { taskId: 'T-016', taskContractDigest: `sha256:v1:${'a'.repeat(64)}` },
  { taskId: 'T-017', taskContractDigest: `sha256:v1:${'b'.repeat(64)}` },
];

function grantFor(overrides = {}) {
  return {
    scope: {
      type: 'work_unit',
      workUnitId: 'milestone:M2',
      scopeDigest: workUnitScopeDigest(members),
      ...(overrides.scope ?? {}),
    },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

describe('P35-C12R.6 the scope digest is what the operator agreed to', () => {
  it('is order-independent, because membership is a set', () => {
    assert.equal(workUnitScopeDigest(members), workUnitScopeDigest([...members].reverse()));
  });

  it('moves when a member is added', () => {
    const expanded = [...members, { taskId: 'T-018', taskContractDigest: `sha256:v1:${'c'.repeat(64)}` }];
    assert.notEqual(workUnitScopeDigest(expanded), workUnitScopeDigest(members));
  });

  it('moves when a member changes materially', () => {
    const changed = [{ ...members[0], taskContractDigest: `sha256:v1:${'d'.repeat(64)}` }, members[1]];
    assert.notEqual(workUnitScopeDigest(changed), workUnitScopeDigest(members));
  });

  it('moves when a member is removed', () => {
    assert.notEqual(workUnitScopeDigest([members[0]]), workUnitScopeDigest(members));
  });
});

describe('P35-C12R.6 an in-scope task derives a lease without asking again', () => {
  it('derives for a member of the exact confirmed scope', () => {
    const verdict = evaluateWorkUnitLease({
      grant: grantFor(),
      taskId: 'T-017',
      currentMembers: members,
    });
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.requiresOperatorAction, false);
    assert.equal(verdict.workUnitId, 'milestone:M2');
  });

  it('does not itself mint authority', () => {
    // Eligibility is not a binding. The authenticated binding is still produced
    // by the activation path from committed decomposition evidence, so a derived
    // lease stays traceable to the operator grant and is never model-authored.
    const verdict = evaluateWorkUnitLease({ grant: grantFor(), taskId: 'T-016', currentMembers: members });
    assert.equal(verdict.mintsBinding, false);
    assert.equal(verdict.derivationSource, 'committed_decomposition_membership');
  });
});

describe('P35-C12R.6 scope expansion always returns to the operator', () => {
  it('refuses a task added after confirmation', () => {
    // The operator never saw this task. That is the whole reason it cannot be
    // covered by their earlier confirmation.
    const expanded = [...members, { taskId: 'T-018', taskContractDigest: `sha256:v1:${'c'.repeat(64)}` }];
    const verdict = evaluateWorkUnitLease({
      grant: grantFor(),
      taskId: 'T-018',
      currentMembers: expanded,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.requiresOperatorAction, true);
    assert.equal(verdict.code, SCOPE_EXPANSION_DIAGNOSTIC_CODE);
    assert.match(verdict.reason, /never authorized/);
  });

  it('refuses an existing member once any sibling changed the scope', () => {
    // Not just the new task: the confirmed set as a whole is what changed, so
    // no member of it rides on the old confirmation.
    const expanded = [...members, { taskId: 'T-018', taskContractDigest: `sha256:v1:${'c'.repeat(64)}` }];
    const verdict = evaluateWorkUnitLease({ grant: grantFor(), taskId: 'T-016', currentMembers: expanded });
    assert.equal(verdict.ok, false);
  });

  it('refuses a task that is not a member at all', () => {
    const verdict = evaluateWorkUnitLease({ grant: grantFor(), taskId: 'T-999', currentMembers: members });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /not a current member/);
  });

  it('refuses to derive work-unit membership from an exact-task grant', () => {
    // An exact-task grant authorizes exactly its listed tasks. Deriving beyond
    // them would invent scope the operator did not state.
    const verdict = evaluateWorkUnitLease({
      grant: grantFor({ scope: { type: 'exact_tasks', taskIds: ['T-016'] } }),
      taskId: 'T-016',
      currentMembers: members,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /does not authorize a work unit/);
  });

  it('refuses when the grant records no bound scope to compare against', () => {
    const verdict = evaluateWorkUnitLease({
      grant: grantFor({ scope: { type: 'work_unit', workUnitId: 'milestone:M2', scopeDigest: undefined } }),
      taskId: 'T-016',
      currentMembers: members,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /records no bound work-unit scope/);
  });

  it('still applies expiry, because a lease from expired intent is not intent', () => {
    const verdict = evaluateWorkUnitLease({
      grant: grantFor({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      taskId: 'T-016',
      currentMembers: members,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'activation.grant.expired');
  });

  it('reports refusals under codes the policy layer knows', () => {
    for (const code of [SCOPE_EXPANSION_DIAGNOSTIC_CODE, 'activation.grant.expired']) {
      assert.ok(repairPolicyFor(code), code);
    }
  });
});
