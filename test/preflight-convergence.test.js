/**
 * One preflight is the complete list of blockers.
 *
 * The exit gate is a property, not a feature: **no later execution
 * boundary may discover a prerequisite that the canonical preflight passed.**
 * The draft lifecycle refusal was one instance of its violation, and repairing only that
 * instance left the property itself unproven.
 *
 * So this suite states the property directly and checks it over a matrix of
 * single-dimension mutations of one pristine dispatch fixture. Each case mutates
 * the target and derives nothing new, so both boundaries evaluate the *same*
 * facts - which is exactly the precondition the invariant is stated over.
 *
 * Running it as a matrix rather than as hand-written pairs is deliberate: it is
 * what found clean state reported as an advisory warning at preflight and
 * enforced as a blocking gate at dispatch, committed append-only
 * contract-history errors loaded and then discarded, and work-unit inventory
 * membership never re-enumerated at preflight. None of those were visible from
 * any single hand-written case.
 *
 * The converse - preflight stricter than dispatch - is deliberately *not* an
 * error. Preflight is allowed to refuse earlier; it may not pass later.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDispatchFixture, git, prepare, sha256 } from './helpers/dispatch-fixture.js';
import { evaluateHandoffPreflight } from '../src/handoff-preflight.js';
import { DISPATCHABLE_TASK_STATUSES } from '../src/dispatchability.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-converge-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function preflight(root, taskId = 'T-001') {
  return evaluateHandoffPreflight({
    target: root, taskId, backend: 'files', projectConfig: {}, io: {},
  });
}

/** Run both boundaries over the same current facts. */
function bothBoundaries(fixture, taskId = 'T-001') {
  const pf = preflight(fixture.root, taskId);
  const body = readFileSync(fixture.taskPath, 'utf8');
  const snapshot = fixture.snapshot();
  const pr = prepare(fixture, {
    refetchTask: () => ({ ...snapshot, body, digest: sha256(body) }),
  });
  return {
    preflight: pf,
    prepare: pr,
    preflightCodes: (pf.diagnostics ?? []).map(item => item.code),
    prepareCodes: (pr.validation?.diagnostics ?? []).map(item => item.code),
    prepareErrors: pr.validation?.errors ?? [],
  };
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', `${message}\n\nTask: T-001\nAgent: maintainer`]);
}

/**
 * Every mutation is one dimension the exit gate names, expressed as a
 * change to committed or working-tree state rather than to supplied evidence.
 */
const MUTATIONS = {
  pristine: () => {},

  // Lifecycle
  'lifecycle: draft': fx => setStatus(fx, 'draft'),
  'lifecycle: accepted': fx => setStatus(fx, 'accepted'),

  // Trusted contract baseline
  'baseline: history deleted': fx => {
    rmSync(join(fx.root, '.agenticloop', 'task-contract-history'), { recursive: true, force: true });
    commitAll(fx.root, 'delete contract history');
  },
  'baseline: history rewritten': fx => {
    writeFileSync(
      join(fx.root, '.agenticloop', 'task-contract-history', 'T-001.jsonl'),
      '{ not a record\n',
      'utf8'
    );
    commitAll(fx.root, 'rewrite contract history');
  },

  // Relevant clean state
  'clean: modified tracked source': fx => {
    writeFileSync(join(fx.root, 'src', 'existing.js'), '// modified\n', 'utf8');
  },
  'clean: untracked in-scope path': fx => {
    writeFileSync(join(fx.root, 'src', 'stray.js'), '// stray\n', 'utf8');
  },
  'clean: uncommitted durable evidence': fx => {
    const dir = join(fx.root, '.agenticloop', 'handoffs', 'derived-evidence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'T-001.json'), '{"generated":true}\n', 'utf8');
  },

  // Committed decomposition and work-unit membership
  'decomposition: source deleted': fx => {
    rmSync(join(fx.root, '.agenticloop', 'decompositions', 'T-001.json'), { force: true });
    commitAll(fx.root, 'delete decomposition');
  },
  'work unit: task added to the inventory': fx => {
    const body = readFileSync(fx.taskPath, 'utf8').replaceAll('T-001', 'T-777');
    writeFileSync(join(fx.root, '.agenticloop', 'tasks', 'T-777.md'), body, 'utf8');
    commitAll(fx.root, 'add a task to the inventory');
  },

  // Task contract and scope
  'contract: body drift committed': fx => {
    writeFileSync(fx.taskPath, readFileSync(fx.taskPath, 'utf8').replace('## Task', '## Task\n\nDrifted.'), 'utf8');
    commitAll(fx.root, 'drift the task body');
  },
  'scope: allowed path narrowed away': fx => {
    writeFileSync(
      fx.taskPath,
      readFileSync(fx.taskPath, 'utf8').replace(/^ {2}- src\/\*\*$/m, '  - nonexistent/**'),
      'utf8'
    );
    commitAll(fx.root, 'narrow scope');
  },

  // Dependency and activation evidence
  'dependency: snapshot deleted': fx => {
    rmSync(join(fx.root, 'dependencies.json'), { force: true });
    commitAll(fx.root, 'delete dependency snapshot');
  },
  'activation: capture deleted': fx => {
    rmSync(join(fx.root, '.agenticloop', 'activation', 'T-001.json'), { force: true });
    commitAll(fx.root, 'delete activation capture');
  },

  // Repository and base identity
  'base: unrelated commit on top': fx => {
    writeFileSync(join(fx.root, 'UNRELATED.md'), '# unrelated\n', 'utf8');
    commitAll(fx.root, 'unrelated commit');
  },
  'base: detached HEAD': fx => {
    git(fx.root, ['checkout', '--detach', 'HEAD']);
  },
};

function setStatus(fx, status) {
  writeFileSync(fx.taskPath, readFileSync(fx.taskPath, 'utf8').replace(/^status: .*$/m, `status: ${status}`), 'utf8');
  commitAll(fx.root, `set ${status}`);
}

describe('a green preflight is never refused by a later boundary', () => {
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(`converges over unchanged facts: ${name}`, async () => {
      const fixture = await createDispatchFixture(temp, `conv-${name.replace(/[^a-z0-9]+/gi, '-')}`);
      mutate(fixture);
      const outcome = bothBoundaries(fixture);

      if (outcome.preflight.ok === true) {
        assert.equal(
          outcome.prepare.ok,
          true,
          `preflight passed but packet preparation refused the same facts:\n` +
          `  ${outcome.prepareErrors.join('\n  ')}\n` +
          `  codes: ${outcome.prepareCodes.join(', ')}`
        );
      }
      // The converse is allowed on purpose: preflight may refuse earlier than
      // dispatch would. Only the false green breaks the invariant.
    });
  }

  it('keeps the pristine fixture dispatchable at both boundaries', async () => {
    // A convergence property is trivially satisfiable by refusing everything.
    // This is the case that stops the suite from being vacuous.
    const fixture = await createDispatchFixture(temp, 'conv-pristine-positive');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, true, JSON.stringify(outcome.preflight.errors));
    assert.equal(outcome.prepare.ok, true, outcome.prepareErrors.join('\n'));
  });

  it('passes both boundaries from every dispatchable lifecycle status', async () => {
    // Derived from the status domain rather than listed, so a new dispatchable
    // status cannot silently escape the property.
    for (const status of DISPATCHABLE_TASK_STATUSES) {
      const fixture = await createDispatchFixture(temp, `conv-status-${status}`, { initialStatus: status });
      const outcome = bothBoundaries(fixture);
      assert.equal(outcome.preflight.ok, true, `${status}: ${JSON.stringify(outcome.preflight.errors)}`);
      assert.equal(outcome.prepare.ok, true, `${status}: ${outcome.prepareErrors.join('\n')}`);
    }
  });
});

describe('preflight enforces the dimensions it reports on', () => {
  it('refuses a dirty relevant checkout instead of advising about it', async () => {
    // Preflight and dispatch have always shared
    // `evaluateDispatchCleanState`; preflight downgraded the result to a warning
    // and told the caller dispatch "may" refuse later.
    const fixture = await createDispatchFixture(temp, 'clean-gate-enforced');
    writeFileSync(join(fixture.root, 'src', 'stray.js'), '// stray\n', 'utf8');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, false, 'a dirty relevant checkout blocks preflight');
    assert.ok(outcome.preflightCodes.includes('worktree.clean_gate.failed'));
    assert.equal(outcome.preflight.cleanState, 'dirty');
    const finding = outcome.preflight.diagnostics.find(item => item.code === 'worktree.clean_gate.failed');
    assert.match(finding.repairHint, /commit the relevant untracked paths|Commit or revert/);
    // And the same code is what dispatch reports, from the same evaluator.
    assert.ok(outcome.prepareCodes.includes('worktree.clean_gate.failed'));
  });

  it('permits scratch output that the clean gate already excludes', async () => {
    // The other half of the same rule: transient output written under the
    // permitted scratch prefix must not self-block the next gate.
    const fixture = await createDispatchFixture(temp, 'clean-gate-scratch');
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'scratch.json'), '{}\n', 'utf8');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, true, JSON.stringify(outcome.preflight.errors));
    assert.equal(outcome.prepare.ok, true, outcome.prepareErrors.join('\n'));
  });

  it('reports a broken append-only contract history instead of discarding it', async () => {
    // The errors were loaded into the snapshot and dropped as
    // "optional for the preflight report", while dispatch refuses on them.
    const fixture = await createDispatchFixture(temp, 'contract-history-enforced');
    rmSync(join(fixture.root, '.agenticloop', 'task-contract-history'), { recursive: true, force: true });
    commitAll(fixture.root, 'delete contract history');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, false);
    assert.ok(
      outcome.preflightCodes.includes('contract.baseline.invalid'),
      `expected a contract baseline diagnostic, got: ${outcome.preflightCodes.join(', ')}`
    );
    const finding = outcome.preflight.diagnostics.find(item => item.code === 'contract.baseline.invalid');
    assert.match(finding.message, /append-only/);
    assert.match(finding.repairHint, /authorize-correction|restoring the committed chain/);
  });

  it('re-enumerates work-unit membership instead of trusting the bound scan', async () => {
    // `validateDecomposition` checks the record's own shape; only
    // dispatch re-enumerated the backend, so membership drift passed preflight.
    const fixture = await createDispatchFixture(temp, 'membership-enforced');
    const body = readFileSync(fixture.taskPath, 'utf8').replaceAll('T-001', 'T-778');
    writeFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-778.md'), body, 'utf8');
    commitAll(fixture.root, 'add a task to the inventory');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, false, 'membership drift must not reach a green preflight');
    assert.ok(outcome.preflightCodes.includes('parallel_scan.decomposition.invalid'));
    const finding = outcome.preflight.diagnostics.find(item => item.code === 'parallel_scan.decomposition.invalid');
    assert.match(finding.message, /membership or task carrier digest changed/);
  });
});

describe('guards for interpretations the field evidence rejected', () => {
  it('does not treat an unrelated commit as invalidating readiness', async () => {
    // The disproved claim from the field session: that every HEAD change
    // invalidates decomposition. Only bound semantic inputs may.
    const fixture = await createDispatchFixture(temp, 'guard-unrelated-commit');
    writeFileSync(join(fixture.root, 'UNRELATED.md'), '# unrelated\n', 'utf8');
    commitAll(fixture.root, 'unrelated commit');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, true, JSON.stringify(outcome.preflight.errors));
    assert.equal(outcome.prepare.ok, true, outcome.prepareErrors.join('\n'));
  });

  it('does not treat a detached HEAD as a dispatch blocker on its own', async () => {
    const fixture = await createDispatchFixture(temp, 'guard-detached');
    git(fixture.root, ['checkout', '--detach', 'HEAD']);
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, true, JSON.stringify(outcome.preflight.errors));
    assert.equal(outcome.prepare.ok, true, outcome.prepareErrors.join('\n'));
  });

  it('treats a material task-body change as invalidating, not incidental', async () => {
    // The other side of the same boundary: incidental motion is tolerated,
    // material contract drift is not.
    const fixture = await createDispatchFixture(temp, 'guard-material-drift');
    writeFileSync(
      fixture.taskPath,
      readFileSync(fixture.taskPath, 'utf8').replace(/^ {2}- src\/\*\*$/m, '  - src/**\n  - lib/**'),
      'utf8'
    );
    commitAll(fixture.root, 'widen scope');
    const outcome = bothBoundaries(fixture);
    assert.equal(outcome.preflight.ok, false, 'a scope change is material');
  });
});
