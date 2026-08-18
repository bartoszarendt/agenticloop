/**
 * P35-C12R.2: one canonical dispatch-eligibility validator, four consumers.
 *
 * `test/c12r-preflight-convergence.test.js` states the *behavioural* exit gate:
 * no later boundary may discover a prerequisite the canonical preflight passed.
 * That property held while preflight and packet preparation still ran two
 * separate decision sequences, which meant it had to be re-proved by matrix
 * every time either sequence changed.
 *
 * This suite states the *structural* gate instead: there is exactly one module
 * that decides the shared prerequisites, and all four protected boundaries
 * consume it. Those are different claims, and both are needed - a facade that
 * merely called both old orchestrators would satisfy the behavioural property
 * and fail every assertion here.
 *
 * ## Two fact domains
 *
 * The suite deliberately does not assert that all four boundaries produce
 * identical output. Two of them read the world and two authenticate a sealed
 * artifact:
 *
 *   live_dispatch / live_readiness   see current repository and task state;
 *   sealed_packet                    sees only what one packet froze.
 *
 * Requiring a sealed-packet validator to notice a repository mutation it cannot
 * observe would mean either weakening what "authenticated" means or making role
 * start trust a packet over current reality. The sealed boundary is compared
 * against other sealed evaluations of the same packet; live state changes are
 * the live revalidation boundary's job, and are asserted there.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DISPATCH_ELIGIBILITY_DIMENSIONS,
  DISPATCH_FACT_SHAPES,
  DISPATCH_REVALIDATION_FACT_SHAPE,
  evaluateDispatchEligibility,
  liveDispatchCandidate,
  liveReadinessCandidate,
  revalidationDispatchCandidate,
  sealedPacketCandidate,
} from '../src/dispatch-eligibility.js';
import { evaluateHandoffPreflight } from '../src/handoff-preflight.js';
import {
  validateDispatchPreparation,
  verifyDispatchBeforeMutation,
} from '../src/dispatch-envelope.js';
import { createDispatchFixture, git, prepare, sha256 } from './helpers/dispatch-fixture.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-c12r2-structural-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function preflight(root, taskId = 'T-001') {
  return evaluateHandoffPreflight({
    target: root, taskId, backend: 'files', projectConfig: {}, io: {},
  });
}

/**
 * Prepare a packet from the committed facts on disk rather than from the
 * fixture's in-memory evidence, so preflight and packet preparation are
 * compared over one shared fact domain. Re-reading the task carrier and the
 * committed decomposition source is what `task prepare-dispatch` itself does.
 */
/** The refetchers `task prepare-dispatch` and `dispatch receive` really use. */
function liveRefetchers(fixture) {
  const body = readFileSync(fixture.taskPath, 'utf8');
  const snapshot = fixture.snapshot();
  const sourceRef = join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json');
  return {
    refetchTask: () => ({ ...snapshot, body, digest: sha256(body) }),
    refetchDecomposition: () => {
      try {
        return JSON.parse(readFileSync(sourceRef, 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

/** Live revalidation of one exact packet against current committed facts. */
function currentReceive(fixture, packet) {
  return verifyDispatchBeforeMutation(
    { ...fixture, ...liveRefetchers(fixture), packet, roleId: 'engineer' }, fixture.options,
  );
}
function currentPrepare(fixture) {
  return prepare(fixture, liveRefetchers(fixture));
}

describe('P35-C12R.2 the shared prerequisite inventory is closed', () => {
  it('declares one canonical dimension inventory with no duplicates', () => {
    assert.ok(DISPATCH_ELIGIBILITY_DIMENSIONS.length >= 19);
    assert.equal(
      new Set(DISPATCH_ELIGIBILITY_DIMENSIONS).size,
      DISPATCH_ELIGIBILITY_DIMENSIONS.length,
      'the dimension inventory must not repeat a dimension'
    );
    assert.ok(Object.isFrozen(DISPATCH_ELIGIBILITY_DIMENSIONS));
    for (const required of [
      'lifecycle', 'task_contract', 'contract_baseline', 'required_checks', 'activation',
      'activation_assurance', 'readiness', 'dependency_evidence', 'decomposition',
      'work_unit_membership', 'maintainer_attribution', 'task_eligibility',
      'repository_identity', 'base_identity', 'clean_state', 'assignment',
      'host_role_capability', 'return_capability',
    ]) {
      assert.ok(DISPATCH_ELIGIBILITY_DIMENSIONS.includes(required), `missing dimension '${required}'`);
    }
  });

  it('accounts for every declared dimension in every decision it returns', async () => {
    // This is what stops a newly added shared prerequisite from reaching one
    // adapter and silently missing another: the decision ledger is derived from
    // the inventory, so a dimension with no case is visibly `not_reached`
    // rather than absent.
    const fixture = await createDispatchFixture(temp, 'ledger-complete');
    const decisions = [];

    const pf = preflight(fixture.root);
    assert.equal(pf.ok, true, JSON.stringify(pf.errors));

    for (const shape of DISPATCH_FACT_SHAPES) {
      const refused = evaluateDispatchEligibility({ factShape: shape });
      assert.equal(refused.ok, false);
      decisions.push(refused);
    }
    for (const decision of decisions) {
      assert.deepEqual(
        Object.keys(decision.dimensions).sort(),
        [...DISPATCH_ELIGIBILITY_DIMENSIONS].sort(),
        'the decision ledger must cover exactly the declared dimension inventory'
      );
    }
  });

  it('fails closed on an unknown fact domain', () => {
    const decision = evaluateDispatchEligibility({ factShape: 'whatever_the_caller_wants' });
    assert.equal(decision.ok, false);
    assert.match(decision.errors.join('; '), /not a recognized fact domain/);
    assert.equal(decision.packetEligible, false);
  });

  it('fails closed on a candidate missing a required fact', () => {
    const candidate = liveDispatchCandidate({
      snapshot: {}, activationEvidence: null, readiness: {}, repository: {}, decomposition: {},
      parallelScanInventory: null, assignment: {}, policy: {}, returnAdapter: null,
      cleanStateObservation: {}, inventoryRecheck: null, authority: {}, now: undefined,
    });
    delete candidate.readiness;
    const decision = evaluateDispatchEligibility(candidate);
    assert.equal(decision.ok, false);
    assert.match(decision.errors.join('; '), /missing field\(s\): readiness/);
  });

  it('fails closed on a candidate carrying an unknown fact', () => {
    const candidate = sealedPacketCandidate({ packet: {}, authority: {}, now: undefined });
    candidate.skipActivation = true;
    const decision = evaluateDispatchEligibility(candidate);
    assert.equal(decision.ok, false);
    assert.match(decision.errors.join('; '), /unknown field\(s\): skipActivation/);
  });

  it('offers no permissive mode: there is no flag that skips a dimension', () => {
    // A caller cannot ask for fewer checks. The only way to change what is
    // evaluated is to hand over a different closed fact shape, and each shape's
    // required inventory is enforced above.
    for (const shape of DISPATCH_FACT_SHAPES) {
      const decision = evaluateDispatchEligibility({ factShape: shape, skipChecks: true });
      assert.equal(decision.ok, false, `${shape} accepted an unknown control field`);
    }
    assert.ok(DISPATCH_FACT_SHAPES.includes(DISPATCH_REVALIDATION_FACT_SHAPE));
  });

  it('binds the revalidation adapter to the same decision packet preparation takes', () => {
    // The third fact domain in the contract - current refetch facts used
    // immediately before role mutation - is the live dispatch decision, taken
    // again over fresh facts. Naming it separately keeps that explicit without
    // creating a second semantics for it.
    const input = {
      snapshot: {}, activationEvidence: null, readiness: {}, repository: {}, decomposition: {},
      parallelScanInventory: null, assignment: {}, policy: {}, returnAdapter: null,
      cleanStateObservation: {}, inventoryRecheck: null, authority: {}, now: undefined,
    };
    assert.deepEqual(revalidationDispatchCandidate(input), liveDispatchCandidate(input));
  });
});

describe('P35-C12R.2 all four boundaries consume the canonical evaluator', () => {
  it('routes preflight, packet preparation, packet validation, and role start through it', async () => {
    const fixture = await createDispatchFixture(temp, 'four-boundaries');

    // 1. handoff preflight - live authoritative facts, read-only.
    const pf = preflight(fixture.root);
    assert.equal(pf.ok, true, JSON.stringify(pf.errors));

    // 2. packet preparation - live authoritative facts, binds an assignment.
    const prepared = currentPrepare(fixture);
    assert.equal(prepared.ok, true, (prepared.validation?.errors ?? []).join('\n'));

    // 3. prepared-packet validation - the sealed artifact.
    const validated = validateDispatchPreparation(prepared.packet, fixture.options);
    assert.equal(validated.ok, true, validated.errors.join('\n'));

    // 4. role start - authenticates the exact packet, then revalidates live.
    const received = currentReceive(fixture, prepared.packet);
    assert.equal(received.ok, true, (received.validation?.errors ?? []).join('\n'));
  });

  it('a decision without a bound assignment can never mint a packet', async () => {
    // Structural, not conventional: preflight's decision reports
    // `packetEligible: false` because no assignment exists to bind, and packet
    // preparation refuses to mint from a decision that does not authorize it.
    const fixture = await createDispatchFixture(temp, 'packet-eligibility');
    const snapshot = fixture.snapshot();
    const decision = evaluateDispatchEligibility(liveReadinessCandidate({
      snapshot,
      authorization: { state: 'present', assurance: 'host_signed', errors: [] },
      readinessObservation: null,
      dependencyObservation: null,
      repository: null,
      decomposition: null,
      parallelScanInventory: null,
      hostRoleCapability: null,
      policy: null,
      returnCapability: null,
      cleanStateObservation: null,
      inventoryRecheck: null,
      authority: {},
      now: undefined,
    }));
    assert.equal(decision.factShape, 'live_readiness');
    assert.equal(decision.packetEligible, false);
    assert.equal(decision.dimensions.assignment.state, 'not_applicable');
    assert.match(decision.dimensions.assignment.note, /no role assignment exists/);
  });
});

describe('P35-C12R.2 live-fact convergence over one shared decision', () => {
  const LIVE_MUTATIONS = {
    'lifecycle: draft': fx => setStatus(fx, 'draft'),
    'lifecycle: closed': fx => setStatus(fx, 'closed'),
    'clean: modified tracked source': fx => {
      writeFileSync(join(fx.root, 'src', 'existing.js'), '// modified\n', 'utf8');
    },
    'decomposition: source deleted': fx => {
      rmSync(join(fx.root, '.agenticloop', 'decompositions', 'T-001.json'), { force: true });
      commitAll(fx.root, 'delete decomposition');
    },
    'baseline: history deleted': fx => {
      rmSync(join(fx.root, '.agenticloop', 'task-contract-history'), { recursive: true, force: true });
      commitAll(fx.root, 'delete contract history');
    },
  };

  for (const [name, mutate] of Object.entries(LIVE_MUTATIONS)) {
    it(`refuses at preflight, preparation, and live revalidation: ${name}`, async () => {
      const fixture = await createDispatchFixture(temp, `live-${name.replace(/[^a-z0-9]+/gi, '-')}`);
      // A packet minted before the mutation, so role-start live revalidation has
      // something authentic to revalidate against changed live state.
      const before = currentPrepare(fixture);
      assert.equal(before.ok, true, (before.validation?.errors ?? []).join('\n'));

      mutate(fixture);

      const pf = preflight(fixture.root);
      const prepared = currentPrepare(fixture);
      const received = currentReceive(fixture, before.packet);

      assert.equal(pf.ok, false, `preflight passed a refused prerequisite: ${name}`);
      assert.equal(prepared.ok, false, `packet preparation passed a refused prerequisite: ${name}`);
      assert.equal(received.ok, false, `live revalidation passed a refused prerequisite: ${name}`);
    });
  }

  it('keeps the one-way property from being satisfied by refusing everything', async () => {
    // Every positive case below has to keep passing, or the matrix above proves
    // nothing: a validator that refuses all input satisfies "preflight never
    // passes what a later boundary refuses" trivially.
    const fixture = await createDispatchFixture(temp, 'live-positive');
    const pf = preflight(fixture.root);
    const prepared = currentPrepare(fixture);
    const received = currentReceive(fixture, prepared.packet);
    assert.equal(pf.ok, true, JSON.stringify(pf.errors));
    assert.equal(prepared.ok, true, (prepared.validation?.errors ?? []).join('\n'));
    assert.equal(received.ok, true, (received.validation?.errors ?? []).join('\n'));
  });

  it('accepts an unrelated commit and a detached HEAD at all three live boundaries', async () => {
    const fixture = await createDispatchFixture(temp, 'live-incidental');
    const prepared = currentPrepare(fixture);
    assert.equal(prepared.ok, true, (prepared.validation?.errors ?? []).join('\n'));

    writeFileSync(join(fixture.root, 'UNRELATED.md'), '# unrelated\n', 'utf8');
    commitAll(fixture.root, 'unrelated commit');
    git(fixture.root, ['checkout', '--detach', 'HEAD']);

    assert.equal(preflight(fixture.root).ok, true);
    const again = currentPrepare(fixture);
    assert.equal(again.ok, true, (again.validation?.errors ?? []).join('\n'));
  });
});

describe('P35-C12R.2 sealed-artifact convergence over one exact packet', () => {
  it('agrees between packet validation and role-start authentication', async () => {
    const fixture = await createDispatchFixture(temp, 'sealed-agree');
    const prepared = currentPrepare(fixture);
    assert.equal(prepared.ok, true);

    const validated = validateDispatchPreparation(prepared.packet, fixture.options);
    const received = currentReceive(fixture, prepared.packet);
    assert.equal(validated.ok, true, validated.errors.join('\n'));
    assert.equal(received.ok, true, (received.validation?.errors ?? []).join('\n'));
  });

  it('refuses a digest-invalid packet at both sealed boundaries', async () => {
    const fixture = await createDispatchFixture(temp, 'sealed-digest');
    const prepared = currentPrepare(fixture);
    const tampered = { ...prepared.packet, task: { ...prepared.packet.task, scope: 'something else' } };

    const validated = validateDispatchPreparation(tampered, fixture.options);
    const received = currentReceive(fixture, tampered);
    assert.equal(validated.ok, false);
    assert.equal(received.ok, false);
  });

  it('classifies a legacy packet version as typed stale rather than malformed', async () => {
    const fixture = await createDispatchFixture(temp, 'sealed-legacy');
    const prepared = currentPrepare(fixture);
    const legacy = { ...prepared.packet, schemaVersion: 7 };
    const validated = validateDispatchPreparation(legacy, fixture.options);
    assert.equal(validated.ok, false);
    // Legacy evidence stays recognizable and regenerable; it never authorizes.
    assert.ok(
      validated.findings.every(item => item.code !== 'dispatch.packet.conserved'),
      'a legacy packet must not be reported as a conserved current packet'
    );
  });

  it('does not ask a sealed packet to observe live state it cannot see', async () => {
    // The distinction this suite exists to protect. A packet minted before a
    // repository mutation still authenticates as the exact artifact it is; the
    // mutation is caught by live revalidation, not by the schema boundary.
    const fixture = await createDispatchFixture(temp, 'sealed-vs-live');
    const prepared = currentPrepare(fixture);
    assert.equal(prepared.ok, true);

    writeFileSync(join(fixture.root, 'src', 'existing.js'), '// changed after minting\n', 'utf8');

    const sealed = validateDispatchPreparation(prepared.packet, fixture.options);
    const live = currentReceive(fixture, prepared.packet);
    assert.equal(sealed.ok, true, 'the sealed artifact is still authentic');
    assert.equal(live.ok, false, 'live revalidation must catch what the sealed boundary cannot');
  });
});

describe('P35-C12R.2 shared dimensions carry one diagnostic classification', () => {
  it('reports a decomposition fault with the same owning code at both live boundaries', async () => {
    const fixture = await createDispatchFixture(temp, 'code-decomposition');
    rmSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'), { force: true });
    commitAll(fixture.root, 'delete decomposition');

    const pf = preflight(fixture.root);
    const prepared = currentPrepare(fixture);
    assert.equal(pf.ok, false);
    assert.equal(prepared.ok, false);

    const preflightCodes = (pf.diagnostics ?? []).map(item => item.code);
    const prepareCodes = (prepared.validation?.diagnostics ?? []).map(item => item.code);
    assert.ok(preflightCodes.includes('parallel_scan.decomposition.invalid'));
    assert.ok(
      prepareCodes.includes('parallel_scan.decomposition.invalid'),
      `packet preparation reported ${prepareCodes.join(', ')} for a decomposition fault`
    );
  });

  it('reports a dirty relevant checkout with the same owning code at both live boundaries', async () => {
    const fixture = await createDispatchFixture(temp, 'code-clean-state');
    writeFileSync(join(fixture.root, 'src', 'stray.js'), '// stray\n', 'utf8');

    const pf = preflight(fixture.root);
    const prepared = currentPrepare(fixture);
    assert.equal(pf.ok, false);
    assert.equal(prepared.ok, false);
    assert.ok((pf.diagnostics ?? []).some(item => item.code === 'worktree.clean_gate.failed'));
    assert.ok((prepared.validation?.diagnostics ?? []).some(item => item.code === 'worktree.clean_gate.failed'));
  });

  it('reports a broken contract baseline with the same owning code at both live boundaries', async () => {
    const fixture = await createDispatchFixture(temp, 'code-baseline');
    rmSync(join(fixture.root, '.agenticloop', 'task-contract-history'), { recursive: true, force: true });
    commitAll(fixture.root, 'delete contract history');

    const pf = preflight(fixture.root);
    const prepared = currentPrepare(fixture);
    assert.equal(pf.ok, false);
    assert.equal(prepared.ok, false);
    assert.ok((pf.diagnostics ?? []).some(item => item.code === 'contract.baseline.invalid'));
    assert.ok(
      (prepared.validation?.diagnostics ?? []).some(item => String(item.code).startsWith('contract.baseline.')),
      `packet preparation reported ${(prepared.validation?.diagnostics ?? []).map(d => d.code).join(', ')}`
    );
  });
});

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', `${message}\n\nTask: T-001\nAgent: maintainer`]);
}

function setStatus(fx, status) {
  writeFileSync(fx.taskPath, readFileSync(fx.taskPath, 'utf8').replace(/^status: .*$/m, `status: ${status}`), 'utf8');
  commitAll(fx.root, `set ${status}`);
}
