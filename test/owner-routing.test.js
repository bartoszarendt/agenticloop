/**
 * A typed failure returns to the role that owns it.
 *
 * The field session let its Engineer perform lifecycle, decomposition,
 * attribution, and history repair inside its own run. That is why the process
 * spent more effort on its own evidence than on the product task: work that
 * belonged to the Maintainer was done by whichever role happened to be holding
 * the failure.
 *
 * Routing is already derived rather than declared - `REPAIR_POLICY` maps a
 * diagnostic code to a repair kind, and `agents/*.md` binds each repair kind to
 * exactly one primary owner - so the risk is not that routing is missing. It is
 * that a *new* diagnostic quietly points Maintainer-domain work at the Engineer,
 * which is exactly what `parallel_scan.decomposition.invalid` did until
 * owner routing was corrected.
 *
 * These cases are written over the whole catalog rather than over examples, so
 * a code added later cannot escape them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { REPAIR_POLICY, repairPolicyFor } from '../src/repair-policy.js';
import { getProjectRoleCapabilities, HUMAN_AUTHORITY_BOUNDARY } from '../src/role-capabilities.js';
import { ROLE_ALLOWED_ACTIONS } from '../src/host-role-capabilities.js';

const capabilities = getProjectRoleCapabilities(process.cwd());
const ownerFor = code => capabilities.primaryOwnerByRepairKind[repairPolicyFor(code).repairKind] ?? null;
const codes = Object.keys(REPAIR_POLICY);

/**
 * Categories whose repair is Maintainer authoring work.
 *
 * Each of these is produced by a Maintainer-owned command and, on the files
 * backend, lands through a commit that must carry Maintainer attribution. An
 * Engineer cannot legitimately repair any of them from inside its own run.
 */
const MAINTAINER_OWNED_CATEGORIES = Object.freeze([
  'task_contract',      // lifecycle, baseline, contract, record structure
  'task_identity',
  'task_policy',
  'path_intent',        // scope and base inventory
  'generated_paths',
  'parallel_scan',      // decomposition and its inventory
  'review_checkpoint',
  'review_provenance',
  'review_audit',
]);

describe('every typed failure resolves to exactly one owner', () => {
  it('routes every catalog code to a declared primary owner', () => {
    const unrouted = codes.filter(code => !ownerFor(code));
    assert.deepEqual(unrouted, [], `these codes resolve to no owner: ${unrouted.join(', ')}`);
  });

  it('binds every repair kind to exactly one role', () => {
    // `loadRoleCapabilities` already rejects duplicate claims; this states the
    // consequence the routing depends on, so a future multi-claim shows up here
    // as an ownership failure rather than only as a startup error.
    const owners = new Set(Object.values(capabilities.primaryOwnerByRepairKind));
    for (const owner of owners) {
      assert.ok(Object.hasOwn(ROLE_ALLOWED_ACTIONS, owner), `'${owner}' is not a workflow role`);
    }
  });

  it('resolves every escalation to a role or to the human authority boundary', () => {
    for (const code of codes) {
      const { escalationKind } = repairPolicyFor(code);
      const owner = capabilities.escalationOwnerByKind[escalationKind];
      assert.ok(
        escalationKind === 'none' || owner === HUMAN_AUTHORITY_BOUNDARY || Object.hasOwn(ROLE_ALLOWED_ACTIONS, owner),
        `${code}: escalation '${escalationKind}' resolves to '${String(owner)}'`
      );
    }
  });
});

describe('the Engineer cannot be handed Maintainer-owned repair', () => {
  for (const category of MAINTAINER_OWNED_CATEGORIES) {
    it(`routes every '${category}' failure to the maintainer`, () => {
      const inCategory = codes.filter(code => repairPolicyFor(code).category === category);
      assert.ok(inCategory.length > 0, `no codes in category '${category}'; the list is stale`);
      const misrouted = inCategory
        .map(code => [code, ownerFor(code)])
        .filter(([, owner]) => owner !== 'maintainer');
      assert.deepEqual(
        misrouted,
        [],
        `Maintainer-owned work routed elsewhere: ${misrouted.map(([code, owner]) => `${code} -> ${owner}`).join(', ')}`
      );
    });
  }

  it('keeps decomposition repair with the role that authors it', () => {
    // The specific defect owner routing found: decomposition failures pointed at
    // `repair_evidence`, an Engineer capability, although the committed
    // decomposition source must carry Maintainer attribution to be accepted.
    for (const code of [
      'parallel_scan.decomposition.invalid',
      'parallel_scan.inventory.incomplete',
      'parallel_scan.record.invalid',
      'parallel_scan.evidence.stale',
    ]) {
      assert.equal(ownerFor(code), 'maintainer', code);
      assert.equal(repairPolicyFor(code).repairKind, 'regenerate_decomposition', code);
    }
  });

  it('keeps the lifecycle gate with the maintainer', () => {
    assert.equal(ownerFor('task.lifecycle.not_dispatchable'), 'maintainer');
  });

  it('leaves the Engineer its own attribution without granting task attribution', () => {
    // These two read alike and are not the same. `repair_attribution_trailer`
    // is the Engineer fixing its own commit trailer; `repair_task_attribution`
    // is Maintainer-owned task-record provenance.
    assert.equal(capabilities.primaryOwnerByRepairKind.repair_attribution_trailer, 'engineer');
    assert.equal(capabilities.primaryOwnerByRepairKind.repair_task_attribution, 'maintainer');
  });

  it('does not let the Engineer mutate task workflow state at the host boundary', () => {
    // The second, independent half of the boundary: even when a repair is
    // routed correctly, the host capability layer must not grant the Engineer
    // the action class that would let it perform Maintainer work anyway.
    assert.equal(ROLE_ALLOWED_ACTIONS.engineer.includes('task_workflow_mutate'), false);
    assert.ok(ROLE_ALLOWED_ACTIONS.maintainer.includes('task_workflow_mutate'));
    assert.ok(ROLE_ALLOWED_ACTIONS.engineer.includes('implementation_mutate'));
    assert.equal(ROLE_ALLOWED_ACTIONS.engineer.includes('closeout_owned_accepted_to_closed'), false);
    assert.equal(ROLE_ALLOWED_ACTIONS.engineer.includes('generic_accepted_to_closed'), false);
  });

  it('keeps the auditor unable to produce the work it audits', () => {
    // Independence is structural: an auditor that could implement could audit
    // its own artifact.
    assert.equal(ROLE_ALLOWED_ACTIONS.auditor.includes('implementation_mutate'), false);
    assert.equal(ROLE_ALLOWED_ACTIONS.auditor.includes('task_workflow_mutate'), false);
  });
});

describe('human-authority decisions never resolve to an agent role', () => {
  it('routes every human-authority escalation to the boundary, not a role', () => {
    const humanCodes = codes.filter(code => repairPolicyFor(code).escalationKind.startsWith('human_authority'));
    assert.ok(humanCodes.length > 0, 'the catalog declares at least one human-authority escalation');
    for (const code of humanCodes) {
      assert.equal(
        capabilities.escalationOwnerByKind[repairPolicyFor(code).escalationKind],
        HUMAN_AUTHORITY_BOUNDARY,
        code
      );
    }
  });

  it('keeps abandoning a live execution attempt a human decision', () => {
    // Completing the attempt is Engineer work; discarding its execution
    // evidence is not something any role may decide for itself.
    const policy = repairPolicyFor('dispatch.packet.conserved');
    assert.equal(capabilities.primaryOwnerByRepairKind[policy.repairKind], 'engineer');
    assert.equal(capabilities.escalationOwnerByKind[policy.escalationKind], HUMAN_AUTHORITY_BOUNDARY);
  });
});
