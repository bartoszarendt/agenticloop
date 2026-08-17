/**
 * P35-C12R.6 (C12-F9): activation scope and time.
 *
 * The field evidence separated two things that had been conflated. The
 * *assurance* semantics were already right - the interactive CLI correctly stops
 * a model from minting the evidence it is meant to be independent from - and
 * nothing here weakens them. What was wrong was the user-facing unit and the
 * temporal rule:
 *
 * - every refusal offered one task at a time, although `activate` has accepted
 *   an explicit task list and a canonical `--work-unit` all along;
 * - the decomposition fallback work unit is commonly `work-unit:<task-id>`, so
 *   offering it as a "work unit" would imply coverage it does not have;
 * - a 12-hour grant was re-evaluated against the current clock at closeout, so
 *   expiry could retroactively block work that was genuinely authorized when it
 *   started.
 *
 * Expiry means "this authority may not start new work". It has never meant
 * "the work it already started never happened".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVATION_LIFETIME_NOTE,
  activationRepairPlan,
  renderActivationRepair,
} from '../src/activation-repair.js';
import {
  DEFAULT_GRANT_TTL_SECONDS,
  MAX_GRANT_TTL_SECONDS,
  resolveTaskActivationBinding,
} from '../src/activation-grant.js';
import {
  CONTRACT_DIGEST,
  REPOSITORY,
  bindingFor,
  grantFor,
} from './helpers/activation-fixture.js';

describe('P35-C12R.6 one renderer offers every scope the operator actually has', () => {
  it('offers the exact task when that is all the site knows', () => {
    const plan = activationRepairPlan({ taskId: 'T-018' });
    assert.deepEqual(plan.options.map(option => option.scope), ['exact_task']);
    // `repairHint` is contractually an exact executable command, and stays one.
    assert.equal(renderActivationRepair({ taskId: 'T-018' }), 'npx agenticloop activate T-018');
    assert.doesNotMatch(renderActivationRepair({ taskId: 'T-018' }), /\.$/);
  });

  it('offers the ready set as one confirmation when there is more than one task', () => {
    const rendered = renderActivationRepair({
      taskId: 'T-018',
      readyTaskIds: ['T-020', 'T-018', 'T-019'],
    });
    // Command-led, so the primary action is still the first thing read.
    assert.match(rendered, /^npx agenticloop activate T-018;/);
    assert.match(rendered, /npx agenticloop activate T-018 T-019 T-020/);
  });

  it('does not offer a "batch" of one', () => {
    const plan = activationRepairPlan({ taskId: 'T-018', readyTaskIds: ['T-018'] });
    assert.equal(plan.options.some(option => option.scope === 'task_list'), false);
  });

  it('offers a canonical work unit when a durable one exists', () => {
    const plan = activationRepairPlan({ taskId: 'T-018', workUnitId: 'milestone:M2' });
    assert.ok(plan.options.some(option => option.scope === 'canonical_work_unit'));
    assert.match(renderActivationRepair(plan), /npx agenticloop activate --work-unit milestone:M2/);
  });

  it('refuses to dress a per-task fallback up as a work unit', () => {
    // `work-unit:<task-id>` is the decomposition fallback for a task with no
    // durable grouping. Offering it would be identical in effect to the
    // exact-task command while implying broader coverage.
    for (const workUnitId of ['work-unit:T-018', 'T-018']) {
      const plan = activationRepairPlan({ taskId: 'T-018', workUnitId });
      assert.equal(
        plan.options.some(option => option.scope === 'canonical_work_unit'),
        false,
        `${workUnitId} must not be offered as a canonical work unit`
      );
    }
  });

  it('states the external boundary and the bound-scope rule on the plan', () => {
    const plan = activationRepairPlan({ taskId: 'T-018', workUnitId: 'milestone:M2' });
    assert.match(plan.boundary, /interactive terminal outside the agent session/);
    assert.match(plan.boundary, /no --yes flag/);
    // A batch authorization covers what it was bound to, not later additions.
    assert.match(plan.scopeNote, /tasks added afterwards are not covered/);
    assert.equal(plan.lifetime, ACTIVATION_LIFETIME_NOTE);
    assert.match(plan.lifetime, /lifetime/);
  });

  it('never suggests a non-interactive or agent-mintable path', () => {
    const rendered = renderActivationRepair({
      taskId: 'T-018',
      readyTaskIds: ['T-018', 'T-019'],
      workUnitId: 'milestone:M2',
    });
    assert.doesNotMatch(rendered, /--yes\b/);
    assert.doesNotMatch(rendered, /--force\b/);
    for (const command of rendered.split(';')) {
      assert.match(command.trim(), /^(npx agenticloop activate|or, when )/);
    }
  });

  it('degrades to a placeholder rather than inventing a task id', () => {
    assert.equal(renderActivationRepair({}), 'npx agenticloop activate <task-id>');
  });
});

describe('P35-C12R.6 a work unit is not forced into a task lease', () => {
  it('allows a lifetime longer than the per-task default', () => {
    // C12-F9: a milestone that takes days should not be re-confirmed every
    // twelve hours. The grant ceiling is what makes a work-unit-appropriate
    // lifetime expressible at all.
    assert.equal(DEFAULT_GRANT_TTL_SECONDS, 43_200);
    assert.ok(
      MAX_GRANT_TTL_SECONDS > DEFAULT_GRANT_TTL_SECONDS,
      'a work unit must be able to outlive the per-task default'
    );
    assert.ok(MAX_GRANT_TTL_SECONDS >= 7 * 24 * 3600);
  });
});

// ── Temporal semantics ───────────────────────────────────────────────────────

describe('P35-C12R.6 expiry blocks new work without erasing finished work', () => {
  const alwaysVerify = () => true;
  const authenticated = record => ({
    ...record,
    authentication: { algorithm: 'ed25519', keyId: 'operator-0123456789abcdef', value: 'ed25519:AA==' },
  });

  function resolveAt(now, overrides = {}) {
    const grant = overrides.grant ?? grantFor({ ttlSeconds: 43_200 });
    const binding = overrides.binding ?? bindingFor(grant);
    return resolveTaskActivationBinding({
      grant: authenticated(grant),
      binding: authenticated(binding),
      repositoryIdentity: REPOSITORY,
      backend: 'files',
      taskId: 'T-016',
      carrier: '.agenticloop/tasks/T-016.md',
      taskContractDigest: CONTRACT_DIGEST,
      verifySignature: alwaysVerify,
      now,
      ...overrides.input,
    });
  }

  it('refuses to start new work once the grant has expired', () => {
    const grant = grantFor({ ttlSeconds: 43_200 });
    const afterExpiry = Date.parse(grant.expiresAt) + 1000;
    const resolved = resolveAt(afterExpiry, { grant });
    assert.equal(resolved.ok, false, 'expired authority cannot authorize a new attempt');
    assert.match(resolved.errors.map(item => item.message).join('; '), /expir/i);
  });

  it('still accepts the same grant evaluated as of the consumption instant', () => {
    // The C12-F9 defect: closeout re-evaluated a 12-hour grant against the
    // current clock, so an execution that outlived the window retroactively
    // lost authority it genuinely had when it started. Pinning the evaluation
    // to the consumption instant is what `closeout-cli` now does.
    const grant = grantFor({ ttlSeconds: 43_200 });
    const consumedAt = Date.parse(grant.issuedAt) + 60_000;
    assert.ok(consumedAt < Date.parse(grant.expiresAt), 'the attempt started inside the window');
    const resolved = resolveAt(consumedAt, { grant });
    assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
    assert.equal(resolved.assurance, 'operator_confirmed');
  });

  it('does not let a past instant authorize a grant issued after the attempt', () => {
    // Pinning to the past may only ever narrow. A grant minted after the work
    // started never authorized that work.
    const grant = grantFor({ ttlSeconds: 43_200 });
    const beforeIssuance = Date.parse(grant.issuedAt) - 600_000;
    const resolved = resolveAt(beforeIssuance, { grant });
    assert.equal(resolved.ok, false, 'a grant issued later cannot retroactively authorize');
  });

  it('keeps revocation effective regardless of the instant evaluated', () => {
    // Revocation is matched by grant identity and is deliberately
    // time-independent, so pinning expiry to the past is not a loophole:
    // a revoked grant still fails at the consumption instant.
    const grant = grantFor({ ttlSeconds: 43_200 });
    const consumedAt = Date.parse(grant.issuedAt) + 60_000;
    const resolved = resolveAt(consumedAt, {
      grant,
      input: {
        revocations: [{
          kind: 'agenticloop.activation-revocation',
          schemaVersion: 1,
          revocationId: `revocation:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`,
          grantId: grant.grantId,
          grantDigest: grant.digest,
          repositoryIdentity: REPOSITORY,
          revokedAt: new Date(consumedAt + 3_600_000).toISOString(),
          reason: 'operator revocation during execution',
        }],
      },
    });
    assert.equal(resolved.ok, false, 'revocation is not expiry and is never made non-retroactive');
    assert.match(resolved.errors.map(item => item.message).join('; '), /revok/i);
  });
});
