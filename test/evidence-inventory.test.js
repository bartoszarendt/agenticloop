/**
 * Every persisted evidence class earns its place.
 *
 * The governing principle of the remediation is that rich internal state must
 * produce a *simpler* external workflow, and its test is blunt: every persisted
 * field needs a named consumer and a decision it changes, or it must be derived,
 * transient, or removed. A record kept because it might be useful later is a
 * record nobody maintains and everybody has to reason about.
 *
 * An inventory that says so is only worth having if it cannot quietly go stale,
 * so these cases check it against the source's own storage-root declarations
 * rather than against itself. Adding a persisted class without accounting for it
 * fails here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  EVIDENCE_INVENTORY,
  INVENTORY_ROLES,
  STORAGE_CLASSES,
  evidenceVisibleToRole,
  validateEvidenceInventory,
} from '../src/evidence-inventory.js';
import { PERMITTED_SCRATCH_PREFIXES } from '../src/repository-state.js';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Every `.agenticloop/...` storage root the source declares as a constant. */
function declaredStorageRoots() {
  const roots = new Set();
  for (const name of readdirSync(SRC_DIR).filter(file => file.endsWith('.js'))) {
    const source = readFileSync(join(SRC_DIR, name), 'utf8');
    for (const match of source.matchAll(/^export const [A-Z_]*ROOT = '(\.agenticloop\/[^']+)'/gm)) {
      roots.add(match[1]);
    }
  }
  return roots;
}

describe('the inventory satisfies its own contract', () => {
  it('gives every class a producer, consumer, decision, retention, storage class, and projection', () => {
    const checked = validateEvidenceInventory();
    assert.equal(checked.ok, true, checked.errors.join('\n'));
  });

  it('makes every class name a real storage class', () => {
    for (const [name, item] of Object.entries(EVIDENCE_INVENTORY)) {
      assert.ok(Object.hasOwn(STORAGE_CLASSES, item.storageClass), `${name}: ${item.storageClass}`);
    }
  });

  it('requires a derivable class to justify being persisted at all', () => {
    // The principle's actual bite. A class that could be recomputed and has no
    // stated reason to exist is the failure mode, so the validator rejects it.
    const missingJustification = { ...EVIDENCE_INVENTORY };
    missingJustification.speculative = {
      root: '.agenticloop/speculative',
      producer: 'nobody',
      consumer: 'nobody',
      decision: 'none',
      derivable: true,
      retention: 'forever',
      storageClass: 'durable_project_evidence',
      visibleTo: [],
    };
    const checked = validateEvidenceInventory(missingJustification);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /justify why it is persisted/);
    assert.match(checked.errors.join('; '), /visible to no role must state why/);
  });

  it('records the one class that does not fully earn its place, and how that was settled', () => {
    // The inventory contract asks for redundant persisted values to be removed.
    // This one is a cache that changes no gate outcome, and it was recorded as a
    // reclassification candidate rather than quietly kept. The candidate is now
    // resolved: retained, bound to the attempt it describes, and no longer able
    // to hold a negative disposition derived from inputs the same refresh
    // replaces - which is what made the field record harmful.
    const cache = EVIDENCE_INVENTORY.handoff_derived_evidence;
    assert.match(cache.decision, /none that is authoritative/);
    assert.match(cache.reviewDisposition, /^resolved: /);
    assert.match(cache.reviewDisposition, /bound to the dispatch invocation/);
    assert.match(cache.reviewDisposition, /never carrying a disposition derived from inputs/);
  });

  it('names the two classes that are caches rather than authorities', () => {
    // Kept honest rather than hidden: derived handoff evidence and scratch are
    // recomputable, and both say so instead of being presented as evidence.
    const derivable = Object.entries(EVIDENCE_INVENTORY)
      .filter(([, item]) => item.derivable === true)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(derivable, ['handoff_derived_evidence', 'scratch']);
    for (const name of derivable) {
      assert.ok(EVIDENCE_INVENTORY[name].derivabilityNote, `${name} must justify persistence`);
    }
  });
});

describe('the inventory cannot go stale', () => {
  it('accounts for every storage root the source declares', () => {
    const declared = declaredStorageRoots();
    const inventoried = new Set(Object.values(EVIDENCE_INVENTORY).map(item => item.root));
    const unaccounted = [...declared].filter(root => !inventoried.has(root)).sort();
    assert.deepEqual(
      unaccounted,
      [],
      `these persisted roots have no inventory entry: ${unaccounted.join(', ')}`
    );
  });

  it('covers the roots the durable lifecycle actually writes to', () => {
    // Spot-checked against the classes the execution lifecycle produces, so a
    // future refactor that renames a root without updating the inventory is
    // caught even if the constant moves.
    const inventoried = new Set(Object.values(EVIDENCE_INVENTORY).map(item => item.root));
    for (const root of [
      '.agenticloop/tasks',
      '.agenticloop/task-contract-history',
      '.agenticloop/decompositions',
      '.agenticloop/activations',
      '.agenticloop/handoffs/dispatch',
      '.agenticloop/handoffs/task-mutations',
      '.agenticloop/handoffs/attempts',
      '.agenticloop/returns/verifications',
      '.agenticloop/adoptions',
    ]) {
      assert.ok(inventoried.has(root), `${root} is not inventoried`);
    }
  });

  it('agrees with the clean gate about what scratch is', () => {
    // The storage taxonomy is only true if the gate implements it. This is the
    // Generated-state class confusion stated as an assertion.
    const scratch = STORAGE_CLASSES.transient_scratch;
    assert.equal(scratch.cleanGate, 'excluded');
    assert.ok(
      PERMITTED_SCRATCH_PREFIXES.includes(scratch.location),
      `the clean gate excludes ${PERMITTED_SCRATCH_PREFIXES.join(', ')}, the taxonomy claims ${scratch.location}`
    );
  });

  it('states that durable evidence fails closed until committed', () => {
    assert.equal(STORAGE_CLASSES.durable_project_evidence.cleanGate, 'fails_closed_until_committed');
    assert.equal(STORAGE_CLASSES.durable_project_evidence.committed, true);
  });

  it('keeps operator material outside every repository', () => {
    const operator = STORAGE_CLASSES.operator_owned_authenticated_state;
    assert.equal(operator.committed, false);
    assert.match(operator.location, /outside every target repository/);
    assert.equal(EVIDENCE_INVENTORY.operator_activation_key.storageClass, operator.id);
  });
});

describe('each role receives a bounded projection', () => {
  it('keeps activation, audit, and closeout internals out of the Engineer view', () => {
    // An Engineer implementing a bounded change needs the contract, the packet
    // lineage, and its own receipts. Handing it the authority machinery around
    // those enlarges both what it must reason about and what it might act on,
    // for no implementation benefit.
    const engineer = evidenceVisibleToRole('engineer');
    for (const withheld of [
      'activation_grant',
      'closeout_waiver',
      'historical_adoption',
      'return_verification',
      'task_contract_history',
      'execution_attempt_abandonment',
      'operator_activation_key',
    ]) {
      assert.equal(engineer.includes(withheld), false, `engineer must not receive '${withheld}'`);
    }
  });

  it('gives the Engineer exactly what implementation needs', () => {
    const engineer = evidenceVisibleToRole('engineer');
    for (const needed of ['task_record', 'dispatch_consumption', 'carrier_mutation_receipt', 'scratch']) {
      assert.ok(engineer.includes(needed), `engineer needs '${needed}'`);
    }
  });

  it('gives no workflow role the operator key material', () => {
    for (const role of INVENTORY_ROLES) {
      assert.equal(
        evidenceVisibleToRole(role).includes('operator_activation_key'),
        false,
        `${role} must never receive operator key material`
      );
    }
    assert.ok(EVIDENCE_INVENTORY.operator_activation_key.visibilityNote);
  });

  it('lets the Auditor see what it must audit without seeing scratch decisions', () => {
    const auditor = evidenceVisibleToRole('auditor');
    assert.ok(auditor.includes('return_verification'));
    assert.ok(auditor.includes('task_contract_history'));
    assert.ok(auditor.includes('historical_adoption'), 'reduced assurance must be auditable');
    assert.equal(auditor.includes('activation_grant'), false, 'auditing an artifact does not require operator authority state');
  });

  it('rejects an unknown role rather than returning an empty projection', () => {
    // Returning [] for a typo would silently withhold everything and look like
    // a correctly bounded view.
    assert.throws(() => evidenceVisibleToRole('enginer'), /unknown workflow role/);
  });

  it('gives every role a non-empty projection', () => {
    for (const role of INVENTORY_ROLES) {
      assert.ok(evidenceVisibleToRole(role).length > 0, `${role} receives nothing`);
    }
  });
});
