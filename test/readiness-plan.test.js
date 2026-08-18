/**
 * Readiness is a sequence, shown as one.
 *
 * These are the two most expensive findings in the field record and they are
 * one failure seen twice. The Maintainer could not see the readiness sequence
 * as a sequence: each prerequisite was discovered by failing a gate, repaired,
 * and then invalidated by the repair after it. 23 of 29 preflights failed. 18
 * of 31 dispatch attempts failed. Activation happened before readiness was
 * settled, so every later repair changed facts an earlier observation had bound.
 *
 * The prerequisites were never the problem - each guards something real. The
 * problem was that they were only ever presented one failure at a time.
 *
 * These cases pin the properties that make a plan worth reading: it is ordered,
 * it is complete before anything is written, it is read-only, it never plans
 * activation, and it converges - repairing the step it names moves the plan
 * forward rather than sideways.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { READINESS_STEPS, buildReadinessPlan } from '../src/readiness-plan.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { makePreflightTask, makeDecomposition, taskPath } from './helpers/preflight-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-readiness-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function newTarget(name, taskId, { status = 'draft' } = {}) {
  const target = mkdtempSync(join(temp, `${name}-`));
  createTaskProjectFixture(target);
  makePreflightTask(target, taskId, { status });
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(target, 'docs'), { recursive: true });
  writeFileSync(join(target, 'src', 'existing.txt'), 'x\n', 'utf8');
  writeFileSync(join(target, 'docs', 'existing.md'), '# d\n', 'utf8');
  git(target, ['add', '-A']);
  git(target, ['commit', '-m', `task ${taskId}\n\nTask: ${taskId}\nAgent: maintainer`]);
  return target;
}

const stepById = (plan, id) => plan.steps.find(item => item.id === id);

describe('the plan is ordered and complete before anything is written', () => {
  it('reports every readiness step, in dependency order', () => {
    const target = newTarget('order', 'T-018');
    const plan = buildReadinessPlan(target, 'T-018');
    assert.deepEqual(plan.steps.map(item => item.id), [...READINESS_STEPS]);

    // Every declared dependency must appear earlier in the sequence, or the
    // plan would name a step whose inputs are not yet settled.
    const position = new Map(plan.steps.map((item, index) => [item.id, index]));
    for (const item of plan.steps) {
      for (const dependency of item.dependsOn) {
        assert.ok(
          position.get(dependency) < position.get(item.id),
          `${item.id} depends on ${dependency}, which is not earlier in the plan`
        );
      }
    }
  });

  it('shows the complete write set before anything is written', () => {
    const target = newTarget('writeset', 'T-018');
    const plan = buildReadinessPlan(target, 'T-018');
    assert.ok(plan.writeSet.length > 0, 'a task needing readiness has a non-empty write set');
    assert.equal(plan.writeSetIsWorkflowOnly, true);
    // The set names real paths only. A placeholder in a write set would defeat
    // the one thing the set is for: seeing exactly what is about to be written.
    for (const path of plan.writeSet) assert.doesNotMatch(path, /[<>]/, path);
    for (const path of plan.writeSet) {
      assert.ok(path.startsWith('.agenticloop/'), `${path} is not workflow or task evidence`);
    }
  });

  it('never plans a product-file change', () => {
    // A readiness plan that could touch the product would be a plan that could
    // do the Engineer's work.
    const target = newTarget('product', 'T-018');
    const plan = buildReadinessPlan(target, 'T-018');
    for (const path of plan.writeSet) {
      assert.equal(path.startsWith('src/'), false, `${path} is a product path`);
      assert.equal(path.startsWith('docs/'), false, `${path} is a product path`);
    }
  });

  it('names one final Maintainer-attributed commit', () => {
    const target = newTarget('commit', 'T-018');
    const plan = buildReadinessPlan(target, 'T-018');
    assert.match(plan.finalCommitTrailer, /^Task: T-018\nAgent: maintainer$/);
    assert.equal(stepById(plan, 'maintainer_attribution').owner, 'maintainer');
  });

  it('routes every step to the maintainer', () => {
    // Readiness is Maintainer authoring work end to end. An Engineer arriving
    // at any of these is the role churn this ordering exists to stop.
    const target = newTarget('owner', 'T-018');
    for (const item of buildReadinessPlan(target, 'T-018').steps) {
      assert.equal(item.owner, 'maintainer', item.id);
    }
  });
});

describe('the plan never plans activation', () => {
  it('says so explicitly rather than by omission', () => {
    // The field record found activation happening before readiness was settled. A plan
    // that included it would reintroduce exactly that ordering.
    const target = newTarget('activation', 'T-018');
    const plan = buildReadinessPlan(target, 'T-018');
    assert.equal(plan.activationPlanned, false);
    assert.match(plan.activationNote, /follows readiness/);
    assert.equal(plan.steps.some(item => item.id.includes('activation')), false);
    assert.equal(
      plan.steps.some(item => String(item.command ?? '').includes('agenticloop activate')),
      false,
      'no step may render an activation command'
    );
  });
});

describe('the plan is read-only and converges', () => {
  it('writes nothing and is stable over repeated evaluation', async () => {
    const target = newTarget('stable', 'T-018');
    const first = await runCliInProcess(['task', 'readiness-plan', 'T-018', '--json', '--target', target]);
    const second = await runCliInProcess(['task', 'readiness-plan', 'T-018', '--json', '--target', target]);
    // Non-zero because readiness is not settled; that is the report, not a fault.
    assert.equal(first.status, 1);
    assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' });
    assert.equal(String(status.stdout ?? '').trim(), '', 'the plan must not dirty the tree');
  });

  it('settles each step as its evidence appears, without disturbing the others', async () => {
    // Convergence is the property the field record found missing: repairing the named
    // step must move the plan forward rather than invalidating what came before.
    const target = newTarget('converge', 'T-019');
    const before = buildReadinessPlan(target, 'T-019');
    assert.equal(stepById(before, 'trusted_contract_baseline').settled, false);
    assert.equal(before.nextStep.id, 'trusted_contract_baseline');

    const baseline = await runCliInProcess([
      'task', 'establish-baseline', 'T-019',
      '--actor', 'Agentic Loop Test', '--authority', 'plan:x', '--target', target,
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);
    // A durable grouping, because the per-task fallback is deliberately not
    // accepted as a work-unit identity; that case is covered separately.
    makeDecomposition(target, 'T-019', { workUnitId: 'milestone:M2' });
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'settle readiness\n\nTask: T-019\nAgent: maintainer']);

    const after = buildReadinessPlan(target, 'T-019');
    assert.equal(stepById(after, 'trusted_contract_baseline').settled, true, 'the repaired step is settled');
    assert.equal(stepById(after, 'committed_decomposition').settled, true);
    assert.equal(stepById(after, 'dependency_observation').settled, true);
    assert.equal(stepById(after, 'maintainer_attribution').settled, true);
    // And the earlier step it depended on was not disturbed by the repair.
    assert.equal(stepById(after, 'task_contract').settled, true);
    // Only the lifecycle transition remains, which is the last step by design.
    assert.deepEqual([...after.pendingSteps], ['lifecycle_agent_ready']);
  });

  it('reports a fully settled task as ready and exits zero', async () => {
    const target = newTarget('ready', 'T-020', { status: 'agent-ready' });
    await runCliInProcess([
      'task', 'establish-baseline', 'T-020',
      '--actor', 'Agentic Loop Test', '--authority', 'plan:x', '--target', target,
    ]);
    makeDecomposition(target, 'T-020', { workUnitId: 'milestone:M2' });
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'settle readiness\n\nTask: T-020\nAgent: maintainer']);

    const plan = buildReadinessPlan(target, 'T-020');
    assert.equal(plan.ready, true, `pending: ${plan.pendingSteps.join(', ')}`);
    assert.deepEqual([...plan.writeSet], []);
    assert.equal(plan.nextStep, null);

    const result = await runCliInProcess(['task', 'readiness-plan', 'T-020', '--json', '--target', target]);
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('the plan renders exact commands where it can', () => {
  it('substitutes the supplied actor and authority into the baseline command', () => {
    const target = newTarget('exact', 'T-018');
    const plan = buildReadinessPlan(target, 'T-018', {
      actor: 'Agentic Loop Test',
      authority: 'plan:x',
    });
    const baseline = stepById(plan, 'trusted_contract_baseline');
    assert.match(baseline.command, /--actor Agentic Loop Test/);
    assert.match(baseline.command, /--authority plan:x/);
    assert.doesNotMatch(baseline.command, /<git-author>|<kind:reference>/);
  });

  it('binds the decomposition command to the current HEAD', () => {
    const target = newTarget('head', 'T-018');
    const head = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).stdout).trim();
    const plan = buildReadinessPlan(target, 'T-018');
    assert.match(stepById(plan, 'committed_decomposition').command, new RegExp(head));
  });

  it('does not call a per-task work-unit fallback a durable grouping', () => {
    // The scope confusion, caught at authoring time rather than at activation.
    const target = newTarget('workunit', 'T-021');
    makeDecomposition(target, 'T-021');
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'decomposition\n\nTask: T-021\nAgent: maintainer']);
    const plan = buildReadinessPlan(target, 'T-021');
    const workUnit = stepById(plan, 'work_unit_identity');
    assert.equal(workUnit.settled, false);
    assert.match(workUnit.detail, /per-task fallback/);
  });

  it('reports a missing task record as the first unmet step', () => {
    const target = newTarget('absent', 'T-018');
    const plan = buildReadinessPlan(target, 'T-404');
    assert.equal(plan.nextStep.id, 'task_contract');
    assert.match(plan.steps[0].detail, /does not exist/);
    assert.match(plan.steps[0].command, /task new T-404/);
  });
});
