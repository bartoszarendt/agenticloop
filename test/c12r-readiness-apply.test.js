/**
 * P35-C12R.3 (C12-F2, C12-F3): readiness settles as one transaction.
 *
 * Showing the whole sequence removed the *discovery* loop. It did not remove the
 * *execution* loop, and C12-F2/C12-F3 measured both. Settling readiness by hand
 * meant `establish-baseline`, a commit, `prepare-decomposition` redirected to a
 * file, `task status agent-ready`, and a second commit - four or five commands,
 * usually two commits, with every repair able to invalidate what an earlier
 * command had already produced.
 *
 * ## What these cases are
 *
 * They are **current-artifact property regressions for the new implementation**,
 * not reproductions of an a037534 baseline failure. `task readiness-apply` did
 * not exist at a037534, and neither did the executable plan it consumes, so there
 * is no command or fixture there to fail. The two characterization cases that
 * *do* describe the prior artifact are named as such: they assert that the
 * manual route needs more than one commit and that an intermediate state is
 * genuinely untrusted, both of which are still true of the standalone commands.
 *
 * The properties pinned here:
 *
 * - one transaction, at most one Maintainer-attributed commit;
 * - the plan is read-only and apply refuses a display-only plan;
 * - a stale or tampered plan can never mutate;
 * - the write set is workflow evidence only and can never contain a product path
 *   or an activation path;
 * - activation is never performed;
 * - unrelated staged or dirty work can never be committed, overwritten, or
 *   discarded;
 * - rollback restores the exact predecessor state, and an unproved rollback
 *   reports `unresolved` rather than claiming success;
 * - rerunning is safe and creates nothing.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { git } from './helpers/git-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { taskPath } from './helpers/c12r-preflight-fixture.js';
import { buildReadinessPlan, readinessPlanDigest } from '../src/readiness-plan.js';
import {
  READINESS_APPLY_DISPOSITIONS,
  READINESS_APPLY_RECEIPT_KIND,
  applyReadinessPlan,
  evaluateReadinessRepositorySafety,
  validateExecutableReadinessPlan,
} from '../src/readiness-apply.js';
import { createReadinessApplyBindings } from '../src/task-cli.js';
import { evaluateCommitAttribution } from '../src/commit-attribution.js';
import {
  ACTOR,
  AUTHORITY,
  DECOMPOSITION_REF,
  DEPENDENCY_REF,
  HISTORY_REF,
  PLAN_REF,
  WORK_UNIT,
  applyPlan,
  commitCountSince,
  createReadinessTarget,
  dependencySnapshot,
  head,
  planArgs,
  porcelain,
  taskBody,
  tamperPlan,
  writePlan,
} from './helpers/readiness-apply-fixture.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-c12r-apply-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

const receipt = result => JSON.parse(result.stdout);

/** Plan, apply, and return everything a case needs to assert on. */
async function settle(name, options = {}) {
  const { target, taskId } = createReadinessTarget(temp, name, options);
  const baseHead = head(target);
  const { plan } = await writePlan(target, taskId, options.planOverrides ?? {});
  const applied = await applyPlan(target, taskId, options.mode ?? '--yes');
  return { target, taskId, baseHead, plan, applied, result: receipt(applied) };
}

describe('P35-C12R.3 one transaction, one commit', () => {
  it('takes a draft task to agent-ready in exactly one Maintainer-attributed commit', async () => {
    const { target, taskId, baseHead, result } = await settle('one-commit');
    assert.equal(result.kind, READINESS_APPLY_RECEIPT_KIND);
    assert.equal(result.mutationDisposition, 'committed');
    assert.equal(result.commitCount, 1);
    assert.equal(commitCountSince(target, baseHead), 1);
    assert.deepEqual(result.changedPaths, [
      DECOMPOSITION_REF(taskId),
      HISTORY_REF(taskId),
      `.agenticloop/tasks/${taskId}.md`,
    ]);
    assert.match(taskBody(target, taskId), /^status: agent-ready$/m);
    assert.equal(result.readiness.ready, true);
    assert.deepEqual(result.readiness.pendingSteps, []);
    assert.equal(result.unresolved, false);
  });

  it('carries the exact Maintainer trailers and the bounded readiness subject', async () => {
    const { target, taskId, result } = await settle('trailers');
    const message = git(target, ['show', '-s', '--format=%B', 'HEAD']);
    assert.equal(result.commit.subject, 'settle readiness');
    assert.match(message, new RegExp(`^Task: ${taskId}$`, 'm'));
    assert.match(message, /^Agent: maintainer$/m);
    // The canonical validator is applied inside apply itself; this confirms the
    // emitted commit is the one it validated.
    const attribution = evaluateCommitAttribution({ message, taskId, role: 'maintainer' });
    assert.deepEqual(attribution.errors, []);
    assert.equal(attribution.ok, true);
  });

  it('leaves the tracked worktree and index clean', async () => {
    const { target } = await settle('clean');
    assert.equal(porcelain(target), '');
  });

  it('never creates an activation and reports activation as the only external action', async () => {
    const { target, taskId, result } = await settle('activation');
    assert.equal(result.activationPlanned, false);
    assert.equal(result.activationCreated, false);
    assert.deepEqual(result.readiness.preflight.readinessOwnedBlockers, []);
    assert.deepEqual(result.readiness.preflight.blockerCodes, ['activation.capture.missing']);
    assert.match(result.nextAction, /Activation is the separate operator action/);
    assert.match(result.nextAction, /agenticloop activate/);
    for (const path of result.changedPaths) {
      assert.equal(path.startsWith('.agenticloop/activation'), false, path);
    }
    assert.equal(git(target, ['show', '--name-only', '--format=', 'HEAD']).includes('activation'), false);
    void taskId;
  });

  it('writes only workflow evidence, never a product file', async () => {
    const { target, result } = await settle('workflow-only');
    for (const path of result.changedPaths) {
      assert.ok(path.startsWith('.agenticloop/'), `${path} is not workflow evidence`);
    }
    for (const path of git(target, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean)) {
      assert.ok(path.startsWith('.agenticloop/'), `${path} is a product path`);
    }
    assert.equal(readFileSync(join(target, 'src', 'existing.txt'), 'utf8'), 'x\n');
    assert.equal(readFileSync(join(target, 'docs', 'existing.md'), 'utf8'), '# d\n');
  });

  it('settles a task whose baseline is already committed with a smaller write set', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'partial-baseline');
    const baseline = await runCliInProcess([
      'task', 'establish-baseline', taskId, '--actor', ACTOR, '--authority', AUTHORITY, '--target', target,
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);
    git(target, ['add', '--', HISTORY_REF(taskId)]);
    git(target, ['commit', '-m', `establish baseline\n\nTask: ${taskId}\nAgent: maintainer`]);
    const baseHead = head(target);
    const { plan } = await writePlan(target, taskId);
    assert.deepEqual([...plan.writeSet], [DECOMPOSITION_REF(taskId), `.agenticloop/tasks/${taskId}.md`]);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'committed');
    assert.equal(commitCountSince(target, baseHead), 1);
    assert.equal(result.readiness.ready, true);
  });

  it('performs a lifecycle-only final mutation when the evidence is already committed', async () => {
    const { target, taskId, baseHead } = await settle('lifecycle-only');
    // Reset the carrier to draft only, leaving committed baseline and
    // decomposition in place, then settle again from that partial state.
    const body = taskBody(target, taskId).replace(/^status: agent-ready$/m, 'status: draft');
    writeFileSync(taskPath(target, taskId), body, 'utf8');
    git(target, ['add', '--', `.agenticloop/tasks/${taskId}.md`]);
    git(target, ['commit', '-m', `revert lifecycle\n\nTask: ${taskId}\nAgent: maintainer`]);
    const partialHead = head(target);
    const { plan } = await writePlan(target, taskId);
    // Only the carrier remains: the committed baseline and decomposition are
    // still settled, so the transaction is a lifecycle-only final mutation.
    assert.deepEqual([...plan.writeSet], [`.agenticloop/tasks/${taskId}.md`]);
    assert.deepEqual([...plan.pendingSteps], ['lifecycle_agent_ready']);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'committed', JSON.stringify(result.errors));
    assert.deepEqual(result.changedPaths, [`.agenticloop/tasks/${taskId}.md`]);
    assert.equal(commitCountSince(target, partialHead), 1);
    void baseHead;
  });
});

describe('P35-C12R.3 the prior artifact genuinely needed more than one commit', () => {
  // Current-artifact characterization of the standalone route. These commands
  // still behave exactly as they did, which is why the orchestration exists.
  it('refuses an uncommitted baseline as untrusted intermediate state', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'characterize-untrusted');
    const baseline = await runCliInProcess([
      'task', 'establish-baseline', taskId, '--actor', ACTOR, '--authority', AUTHORITY, '--json', '--target', target,
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(JSON.parse(baseline.stdout).warning, /commit it separately/);
    // Until that append is committed it is not a trusted baseline, and the plan
    // says so rather than treating the write as progress.
    const plan = buildReadinessPlan(target, taskId, {});
    const step = plan.steps.find(item => item.id === 'trusted_contract_baseline');
    assert.equal(step.settled, false);
    assert.match(step.detail, /must be committed separately/);
  });

  it('needs two commits when the standalone commands are used in sequence', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'characterize-two-commits');
    const baseHead = head(target);
    await runCliInProcess([
      'task', 'establish-baseline', taskId, '--actor', ACTOR, '--authority', AUTHORITY, '--target', target,
    ]);
    const revision = `git-commit:${head(target)}`;
    const decomposition = await runCliInProcess([
      'task', 'prepare-decomposition', taskId,
      '--work-unit', WORK_UNIT, '--source-ref', DECOMPOSITION_REF(taskId),
      '--source-revision', revision, '--base', 'HEAD',
      '--dependencies', DEPENDENCY_REF(taskId), '--target', target,
    ]);
    assert.equal(decomposition.status, 0, decomposition.stderr);
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, DECOMPOSITION_REF(taskId)), `${decomposition.stdout.trimEnd()}\n`, 'utf8');
    // Commit one: the readiness evidence, because `task status agent-ready`
    // refuses an uncommitted baseline and an uncommitted decomposition.
    git(target, ['add', '--', HISTORY_REF(taskId), DECOMPOSITION_REF(taskId)]);
    git(target, ['commit', '-m', `settle evidence\n\nTask: ${taskId}\nAgent: maintainer`]);
    const linted = JSON.parse((await runCliInProcess(['task', 'lint', taskId, '--json', '--target', target])).stdout);
    const transition = await runCliInProcess([
      'task', 'status', taskId, 'agent-ready',
      '--expect-digest', linted[0].digest,
      '--base', 'HEAD', '--dependencies', DEPENDENCY_REF(taskId),
      '--json', '--target', target,
    ]);
    assert.equal(transition.status, 0, `${transition.stderr}\n${transition.stdout}`);
    // Commit two: the carrier the transition just wrote.
    git(target, ['add', '--', `.agenticloop/tasks/${taskId}.md`]);
    git(target, ['commit', '-m', `settle lifecycle\n\nTask: ${taskId}\nAgent: maintainer`]);
    assert.equal(commitCountSince(target, baseHead), 2,
      'the standalone sequence needs two readiness commits; the orchestration needs one');
  });
});

describe('P35-C12R.3 readiness-plan stays read-only', () => {
  it('writes nothing while producing an applicable executable plan', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'plan-readonly');
    const first = await runCliInProcess(planArgs(target, taskId));
    const second = await runCliInProcess(planArgs(target, taskId));
    assert.equal(first.status, 1, 'an unsettled plan exits non-zero; that is the report');
    const plan = JSON.parse(first.stdout);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.applicable, true);
    assert.deepEqual([...plan.blockers], []);
    // Deterministic over unchanged facts, which is what makes the digest usable
    // as a staleness test at all.
    assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
    assert.equal(porcelain(target), '');
  });

  it('marks a plan without exact apply inputs as display-only', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'plan-display-only');
    const plan = buildReadinessPlan(target, taskId, {});
    assert.equal(plan.applicable, false);
    assert.ok(plan.blockers.some(item => /--actor/.test(item)));
    assert.ok(plan.blockers.some(item => /--authority/.test(item)));
    assert.ok(plan.blockers.some(item => /--work-unit/.test(item)));
    assert.ok(plan.blockers.some(item => /--base/.test(item)));
    assert.ok(plan.blockers.some(item => /--dependencies/.test(item)));
  });

  it('refuses to apply a display-only plan', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'apply-display-only');
    const bare = await runCliInProcess(['task', 'readiness-plan', taskId, '--json', '--target', target]);
    writeFileSync(join(target, PLAN_REF(taskId)), bare.stdout, 'utf8');
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked');
    assert.ok(result.errors.some(item => /display-only/.test(item)));
    assert.equal(porcelain(target), '');
  });

  it('never renders an activation command and never plans activation', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'plan-no-activation');
    const { plan } = await writePlan(target, taskId);
    assert.equal(plan.activationPlanned, false);
    for (const step of plan.steps) {
      assert.doesNotMatch(String(step.command ?? ''), /agenticloop activate/);
      for (const path of step.writes) assert.equal(path.startsWith('.agenticloop/activation'), false);
    }
  });

  it('never renders git add -A for the readiness commit', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'plan-no-add-all');
    const { plan } = await writePlan(target, taskId);
    const attribution = plan.steps.find(item => item.id === 'maintainer_attribution');
    assert.doesNotMatch(attribution.command, /add\s+-A/);
    for (const path of plan.writeSet) assert.match(attribution.command, new RegExp(path.replace(/[.]/g, '\\.')));
  });

  it('contains no unresolved placeholder in an applicable plan', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'plan-no-placeholders');
    const { plan } = await writePlan(target, taskId);
    assert.doesNotMatch(JSON.stringify(plan.executable), /<[^>]*>/);
    for (const step of plan.steps) {
      if (step.settled) continue;
      assert.doesNotMatch(String(step.command ?? ''), /<[^>]*>/, step.id);
    }
  });
});

describe('P35-C12R.3 plan integrity fails closed', () => {
  const cases = [
    ['unknown fields', plan => { plan.extra = true; }, /closed schema/],
    ['unsupported schema version', plan => { plan.schemaVersion = 99; }, /unsupported readiness plan schemaVersion/],
    ['a tampered digest', plan => { plan.planDigest = plan.planDigest.replace(/.$/, '0'); }, /digest does not recompute/],
    ['a wrong task', plan => { plan.taskId = 'T-999'; }, /names task 'T-999'/],
    ['a wrong backend', plan => { plan.backend = 'github'; }, /backend must be 'files'/],
    ['a wrong repository identity', plan => {
      plan.executable.repository.authorityIdentity = 'file:/elsewhere';
      plan.planDigest = readinessPlanDigest(plan);
    }, /repository authority identity does not name this target/],
    ['a product path in the write set', plan => {
      plan.executable.writes.push({ path: 'src/output.txt', role: 'task_carrier', state: 'absent', digest: null });
      plan.writeSet.push('src/output.txt');
      plan.executable.predecessorStates.push({ path: 'src/output.txt', state: 'absent', digest: null });
      plan.planDigest = readinessPlanDigest(plan);
    }, /is a product path/],
    ['an activation path in the write set', plan => {
      plan.executable.writes.push({
        path: '.agenticloop/activations/files/T-018.json', role: 'trusted_contract_baseline', state: 'absent', digest: null,
      });
      plan.writeSet.push('.agenticloop/activations/files/T-018.json');
      plan.executable.predecessorStates.push({ path: '.agenticloop/activations/files/T-018.json', state: 'absent', digest: null });
      plan.planDigest = readinessPlanDigest(plan);
    }, /is activation state/],
    ['a duplicated write path', plan => {
      const first = plan.executable.writes[0];
      plan.executable.writes.push({ ...first });
      plan.executable.predecessorStates.push({ path: first.path, state: first.state, digest: first.digest });
      plan.planDigest = readinessPlanDigest(plan);
    }, /is duplicated/],
    ['an unresolved placeholder', plan => {
      plan.executable.actor = '<git-author>';
      plan.planDigest = readinessPlanDigest(plan);
    }, /no unresolved placeholders/],
    ['a per-task work-unit fallback', plan => {
      plan.executable.workUnit.id = 'work-unit:T-018';
      plan.planDigest = readinessPlanDigest(plan);
    }, /durable work-unit identity/],
    ['a planted activationPlanned', plan => {
      plan.activationPlanned = true;
      plan.planDigest = readinessPlanDigest(plan);
    }, /activationPlanned must be false/],
    ['a rewritten final commit message', plan => {
      plan.executable.finalCommitMessage = 'settle readiness\n\nTask: T-018\nAgent: engineer';
      plan.planDigest = readinessPlanDigest(plan);
    }, /finalCommitMessage must be/],
  ];

  for (const [label, mutate, pattern] of cases) {
    it(`refuses ${label} before any mutation`, async () => {
      const { target, taskId } = createReadinessTarget(temp, `integrity-${label.replace(/\W+/g, '-')}`);
      const baseHead = head(target);
      await writePlan(target, taskId);
      tamperPlan(target, taskId, mutate);
      const result = receipt(await applyPlan(target, taskId));
      assert.equal(result.mutationDisposition, 'blocked', JSON.stringify(result.errors));
      assert.ok(result.errors.some(error => pattern.test(error)), JSON.stringify(result.errors));
      assert.equal(result.commitCount, 0);
      assert.deepEqual(result.changedPaths, []);
      assert.equal(commitCountSince(target, baseHead), 0);
      assert.equal(porcelain(target), '');
    });
  }

  it('refuses a plan naming a target path outside this repository', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'integrity-escape');
    await writePlan(target, taskId);
    tamperPlan(target, taskId, plan => {
      plan.executable.writes[0].path = '../escape.json';
      plan.writeSet[0] = '../escape.json';
      plan.executable.predecessorStates[0].path = '../escape.json';
      plan.planDigest = readinessPlanDigest(plan);
    });
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked');
    assert.ok(result.errors.some(error => /not a confined target-relative path/.test(error)));
  });

  it('validates a well-formed plan through the exported validator', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'integrity-valid');
    const { plan } = await writePlan(target, taskId);
    assert.deepEqual(validateExecutableReadinessPlan(plan, { target, taskId, backend: 'files' }), { ok: true, errors: [] });
  });
});

describe('P35-C12R.3 a stale plan cannot mutate', () => {
  const staleCases = [
    ['HEAD moved', (target, taskId) => {
      writeFileSync(join(target, 'src', 'moved.txt'), 'm\n', 'utf8');
      git(target, ['add', '--', 'src/moved.txt']);
      git(target, ['commit', '-m', `unrelated\n\nTask: ${taskId}\nAgent: maintainer`]);
    }, /HEAD moved/],
    ['the task carrier changed', (target, taskId) => {
      writeFileSync(taskPath(target, taskId), `${taskBody(target, taskId)}\n<!-- edited -->\n`, 'utf8');
      git(target, ['add', '--', `.agenticloop/tasks/${taskId}.md`]);
      git(target, ['commit', '-m', `edit carrier\n\nTask: ${taskId}\nAgent: maintainer`]);
    }, /HEAD moved|expected digest/],
    ['the dependency snapshot changed', (target, taskId) => {
      writeFileSync(join(target, DEPENDENCY_REF(taskId)), dependencySnapshot({ statuses: { 'T-900': 'accepted' } }), 'utf8');
      git(target, ['add', '--', DEPENDENCY_REF(taskId)]);
      git(target, ['commit', '-m', `refresh dependencies\n\nTask: ${taskId}\nAgent: maintainer`]);
    }, /HEAD moved|dependency snapshot/],
    ['the task inventory changed', (target, taskId) => {
      writeFileSync(join(target, '.agenticloop', 'tasks', 'T-777.md'), readFileSync(taskPath(target, taskId), 'utf8').replace(/T-018/g, 'T-777'), 'utf8');
      git(target, ['add', '-A']);
      git(target, ['commit', '-m', `add sibling task\n\nTask: ${taskId}\nAgent: maintainer`]);
    }, /HEAD moved|inventory/],
    ['the trusted history changed', (target, taskId) => {
      runCliInProcess(['task', 'establish-baseline', taskId, '--actor', ACTOR, '--authority', AUTHORITY, '--target', target]);
    }, /trusted|history|predecessor|digest|blocker/i],
  ];

  for (const [label, drift, pattern] of staleCases) {
    it(`refuses when ${label}`, async () => {
      const { target, taskId } = createReadinessTarget(temp, `stale-${label.replace(/\W+/g, '-')}`);
      await writePlan(target, taskId);
      const driftedAt = head(target);
      await drift(target, taskId);
      const result = receipt(await applyPlan(target, taskId));
      assert.notEqual(result.mutationDisposition, 'committed', JSON.stringify(result));
      assert.ok(['stale', 'blocked'].includes(result.mutationDisposition), result.mutationDisposition);
      assert.ok(result.errors.some(error => pattern.test(error)), JSON.stringify(result.errors));
      assert.equal(result.commitCount, 0);
      assert.deepEqual(result.changedPaths, []);
      void driftedAt;
    });
  }

  it('refuses a base ref that now resolves to a different tree', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'stale-base');
    // The plan resolves --base to an exact tree, so a moved branch is caught by
    // the resolved identity rather than by the symbolic name.
    const { plan } = await writePlan(target, taskId, { base: 'HEAD' });
    assert.match(plan.executable.base.identity, /^git-tree:[0-9a-f]{40,64}$/);
    assert.equal(plan.executable.base.revalidationArgs[0], '--base');
    assert.match(plan.executable.base.revalidationArgs[1], /^[0-9a-f]{40,64}$/);
    writeFileSync(join(target, 'src', 'more.txt'), 'more\n', 'utf8');
    git(target, ['add', '--', 'src/more.txt']);
    git(target, ['commit', '-m', `move base\n\nTask: ${taskId}\nAgent: maintainer`]);
    const result = receipt(await applyPlan(target, taskId));
    assert.ok(['stale', 'blocked'].includes(result.mutationDisposition));
    assert.equal(result.commitCount, 0);
  });
});

describe('P35-C12R.3 unrelated work is never committed', () => {
  it('refuses an unrelated staged product file', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'safety-staged');
    await writePlan(target, taskId);
    writeFileSync(join(target, 'src', 'staged.txt'), 'staged\n', 'utf8');
    git(target, ['add', '--', 'src/staged.txt']);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked');
    assert.ok(result.errors.some(error => /is staged/.test(error)), JSON.stringify(result.errors));
    // The staged entry is preserved exactly, never reset or discarded.
    assert.match(porcelain(target), /A {2}src\/staged\.txt/);
    assert.equal(readFileSync(join(target, 'src', 'staged.txt'), 'utf8'), 'staged\n');
  });

  it('refuses an unrelated unstaged product change', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'safety-unstaged');
    await writePlan(target, taskId);
    writeFileSync(join(target, 'src', 'existing.txt'), 'changed\n', 'utf8');
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked');
    assert.ok(result.errors.some(error => /unrelated to this readiness plan/.test(error)));
    assert.equal(readFileSync(join(target, 'src', 'existing.txt'), 'utf8'), 'changed\n');
  });

  it('refuses an untracked collision on a planned create path', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'safety-collision');
    await writePlan(target, taskId);
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, DECOMPOSITION_REF(taskId)), '{"planted":true}\n', 'utf8');
    const result = receipt(await applyPlan(target, taskId));
    // A planned create path that unexpectedly exists changes the plan's bound
    // predecessor state, so it is refused as stale before any repository-safety
    // check is even reached.
    assert.equal(result.mutationDisposition, 'stale', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /predecessor path states changed/.test(error)), JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    // The planted bytes are preserved exactly, never overwritten or discarded.
    assert.equal(readFileSync(join(target, DECOMPOSITION_REF(taskId)), 'utf8'), '{"planted":true}\n');
  });

  it('refuses a dirty planned path whose bytes the plan did not bind', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'safety-dirty-planned');
    // Plan while the decomposition is absent, then plant bytes and re-plan so the
    // predecessor state matches; only the repository-safety policy can refuse it.
    mkdirSync(join(target, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(target, DECOMPOSITION_REF(taskId)), '{"planted":true}\n', 'utf8');
    const { plan } = await writePlan(target, taskId);
    const entry = plan.executable.writes.find(item => item.role === 'committed_decomposition');
    assert.equal(entry.state, 'file');
    // Now change the bytes without re-planning: the plan no longer binds them.
    writeFileSync(join(target, DECOMPOSITION_REF(taskId)), '{"planted":"changed"}\n', 'utf8');
    const result = receipt(await applyPlan(target, taskId));
    assert.ok(['stale', 'blocked'].includes(result.mutationDisposition), result.mutationDisposition);
    assert.equal(result.commitCount, 0);
    assert.equal(readFileSync(join(target, DECOMPOSITION_REF(taskId)), 'utf8'), '{"planted":"changed"}\n');
  });

  it('permits transient plan scratch under .agenticloop/tmp/', async () => {
    const { target, taskId, result } = await settle('safety-scratch');
    assert.equal(result.mutationDisposition, 'committed');
    assert.equal(git(target, ['show', '--name-only', '--format=', 'HEAD']).includes('.agenticloop/tmp/'), false);
    void taskId;
  });

  it('reports every unsafe path through the exported safety evaluator', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'safety-evaluator');
    const { plan } = await writePlan(target, taskId);
    assert.deepEqual(evaluateReadinessRepositorySafety(target, plan), { ok: true, errors: [] });
    writeFileSync(join(target, 'docs', 'existing.md'), '# changed\n', 'utf8');
    const dirty = evaluateReadinessRepositorySafety(target, plan);
    assert.equal(dirty.ok, false);
    assert.ok(dirty.errors.some(error => /docs\/existing\.md/.test(error)));
  });

  it('refuses a detached HEAD', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'safety-detached');
    git(target, ['checkout', '--detach', 'HEAD']);
    const planned = await runCliInProcess(planArgs(target, taskId));
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.applicable, false);
    assert.ok(plan.blockers.some(item => /detached/.test(item)));
    writeFileSync(join(target, PLAN_REF(taskId)), planned.stdout, 'utf8');
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked');
    assert.equal(result.commitCount, 0);
  });
});

describe('P35-C12R.3 failure injection and rollback', () => {
  it('restores the exact predecessor state when a Git hook rejects the commit', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'inject-hook');
    const baseHead = head(target);
    await writePlan(target, taskId);
    const hooks = join(target, '.git', 'hooks-active');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "hook refuses" 1>&2\nexit 1\n', 'utf8');
    chmodSync(hook, 0o755);
    git(target, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'rolled_back', JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.deepEqual(result.changedPaths, []);
    assert.equal(commitCountSince(target, baseHead), 0);
    // The exact predecessor state: the created paths are gone and the carrier is
    // byte-identical to what it was.
    assert.match(taskBody(target, taskId), /^status: draft$/m);
    assert.equal(porcelain(target), '');
    assert.match(result.recovery, /No commit was created/);
  });

  it('rolls back and creates no commit when the filesystem batch is interrupted', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'inject-fs');
    const baseHead = head(target);
    const { plan } = await writePlan(target, taskId);
    // The kernel's testable pre-write boundary: the batch fails before its first
    // write, so nothing can be left half-applied.
    const applied = applyReadinessPlan({
      target,
      taskId,
      plan,
      projectConfig: {},
      ...createReadinessApplyBindings(target, {}, taskId),
      beforeWrite: () => { throw new Error('injected pre-write failure'); },
    });
    assert.equal(applied.mutationDisposition, 'rolled_back');
    assert.deepEqual(applied.changedPaths, []);
    assert.equal(applied.commitCount, 0);
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.match(taskBody(target, taskId), /^status: draft$/m);
    assert.equal(porcelain(target), '');
  });

  it('preserves external progress and reports unresolved when a candidate path is replaced', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'inject-external');
    const baseHead = head(target);
    const { plan } = await writePlan(target, taskId);
    const applied = applyReadinessPlan({
      target,
      taskId,
      plan,
      projectConfig: {},
      ...createReadinessApplyBindings(target, {}, taskId),
      // Replace one candidate path after the batch wrote it, before verification.
      afterWrite: () => {
        writeFileSync(join(target, DECOMPOSITION_REF(taskId)), '{"external":true}\n', 'utf8');
      },
    });
    assert.equal(applied.mutationDisposition, 'unresolved', JSON.stringify(applied.errors));
    assert.equal(applied.commitCount, 0);
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.ok(applied.errors.some(error => /was replaced between the write and its verification/.test(error)),
      JSON.stringify(applied.errors));
    // External progress is preserved, never overwritten.
    assert.equal(readFileSync(join(target, DECOMPOSITION_REF(taskId)), 'utf8'), '{"external":true}\n');
    assert.match(applied.recovery, /decompositions/);
  });

  it('refuses staging drift when a candidate path changes before staging', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'inject-staging-drift');
    const baseHead = head(target);
    const { plan } = await writePlan(target, taskId);
    const applied = applyReadinessPlan({
      target,
      taskId,
      plan,
      projectConfig: {},
      ...createReadinessApplyBindings(target, {}, taskId),
      beforeCommit: () => {
        writeFileSync(join(target, DECOMPOSITION_REF(taskId)), '{"drifted":true}\n', 'utf8');
      },
    });
    assert.notEqual(applied.mutationDisposition, 'committed');
    assert.equal(applied.commitCount, 0);
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.ok(applied.errors.some(error => /changed between verification and staging/.test(error)),
      JSON.stringify(applied.errors));
  });

  it('refuses when HEAD moves between validation and the commit', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'inject-head-race');
    const baseHead = head(target);
    const { plan } = await writePlan(target, taskId);
    const applied = applyReadinessPlan({
      target,
      taskId,
      plan,
      projectConfig: {},
      ...createReadinessApplyBindings(target, {}, taskId),
      beforeCommit: () => {
        writeFileSync(join(target, 'src', 'race.txt'), 'race\n', 'utf8');
        git(target, ['add', '--', 'src/race.txt']);
        git(target, ['commit', '-m', `race\n\nTask: ${taskId}\nAgent: maintainer`]);
      },
    });
    assert.notEqual(applied.mutationDisposition, 'committed');
    assert.equal(applied.commitCount, 0);
    assert.equal(commitCountSince(target, baseHead), 1, 'only the racing commit exists');
  });
});

describe('P35-C12R.3 idempotence and safe rerun', () => {
  it('returns already_current for a fully ready task and creates nothing', async () => {
    const { target, taskId, baseHead } = await settle('idempotent');
    const rerun = receipt(await applyPlan(target, taskId));
    assert.equal(rerun.mutationDisposition, 'already_current');
    assert.equal(rerun.commitCount, 0);
    assert.deepEqual(rerun.changedPaths, []);
    assert.equal(commitCountSince(target, baseHead), 1);
    assert.equal(rerun.readiness.ready, true);
    assert.equal(rerun.activationCreated, false);
  });

  it('regenerates a ready plan with an empty write set', async () => {
    const { target, taskId } = await settle('regenerated');
    const planned = await runCliInProcess(planArgs(target, taskId));
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.ready, true);
    assert.deepEqual([...plan.writeSet], []);
    assert.deepEqual([...plan.pendingSteps], []);
    assert.equal(plan.applicable, true);
  });

  it('accepts a freshly regenerated ready plan as a proven no-op', async () => {
    // The consumed-plan rerun above still carries the pre-apply write set. A plan
    // regenerated over the settled task carries none, and applying it must stay a
    // no-op rather than being refused for having nothing to write.
    const { target, taskId, baseHead } = await settle('regenerated-noop');
    const { plan } = await writePlan(target, taskId);
    assert.deepEqual([...plan.writeSet], []);
    assert.deepEqual(validateExecutableReadinessPlan(plan, { target, taskId, backend: 'files' }), { ok: true, errors: [] });
    for (const mode of ['--dry-run', '--yes']) {
      const result = receipt(await applyPlan(target, taskId, mode));
      assert.equal(result.mutationDisposition, 'already_current', `${mode}: ${JSON.stringify(result.errors)}`);
      assert.equal(result.commitCount, 0);
      assert.deepEqual(result.changedPaths, []);
    }
    assert.equal(commitCountSince(target, baseHead), 1);
  });

  it('reports a dry run without writing, staging, or committing', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'dry-run');
    const baseHead = head(target);
    await writePlan(target, taskId);
    const result = receipt(await applyPlan(target, taskId, '--dry-run'));
    assert.equal(result.mutationDisposition, 'dry_run');
    assert.equal(result.dryRun, true);
    assert.equal(result.commitCount, 0);
    assert.ok(result.changedPaths.length > 0, 'a dry run still reports the exact write set');
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.equal(porcelain(target), '');
    assert.match(taskBody(target, taskId), /^status: draft$/m);
  });

  it('refuses mutation without --yes and refuses both flags together', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'confirmation');
    await writePlan(target, taskId);
    const bare = await runCliInProcess([
      'task', 'readiness-apply', taskId, '--plan', PLAN_REF(taskId), '--json', '--target', target,
    ]);
    assert.equal(bare.status, 2);
    assert.match(JSON.parse(bare.stdout).diagnostics[0].message, /--dry-run or --yes/);
    const both = await runCliInProcess([
      'task', 'readiness-apply', taskId, '--plan', PLAN_REF(taskId), '--dry-run', '--yes', '--json', '--target', target,
    ]);
    assert.equal(both.status, 2);
    assert.equal(porcelain(target), '');
  });

  it('declares every disposition it can report', () => {
    assert.deepEqual([...READINESS_APPLY_DISPOSITIONS], [
      'already_current', 'committed', 'dry_run', 'rolled_back', 'stale', 'blocked',
      'partially_committed', 'unresolved',
    ]);
  });
});

/**
 * Install one repository hook in a temporary target and point core.hooksPath at
 * it. Only ever used inside disposable fixtures; the real repository's hook
 * configuration is never touched.
 */
function installHook(target, name, body) {
  const hooks = join(target, '.git', 'hooks-active');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, name);
  writeFileSync(hook, body, 'utf8');
  chmodSync(hook, 0o755);
  git(target, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
  return hook;
}

/** Settle one task and leave its consumed executable plan on disk for rerun. */
async function settleConsumed(name) {
  const { target, taskId, baseHead, plan, result } = await settle(name);
  assert.equal(result.mutationDisposition, 'committed', JSON.stringify(result.errors));
  return { target, taskId, baseHead, plan };
}

describe('P35-C12R.3 repair R3-R2: already_current is a proven state', () => {
  it('returns stale, not already_current, when a consumed plan is reapplied after a later commit', async () => {
    const { target, taskId, baseHead } = await settleConsumed('repair-consumed-later-commit');
    writeFileSync(join(target, 'src', 'later.txt'), 'later\n', 'utf8');
    git(target, ['add', '--', 'src/later.txt']);
    git(target, ['commit', '-m', `later\n\nTask: ${taskId}\nAgent: maintainer`]);
    const movedHead = head(target);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'stale', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /HEAD moved|consumed/i.test(error)), JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.deepEqual(result.changedPaths, []);
    assert.equal(result.nextAction, null, 'a stale result never carries activation guidance');
    assert.equal(head(target), movedHead);
    assert.match(taskBody(target, taskId), /^status: agent-ready$/m);
  });

  it('returns blocked, not already_current, when a consumed plan is reapplied on a detached HEAD', async () => {
    const { target, taskId } = await settleConsumed('repair-consumed-detached');
    git(target, ['checkout', '--quiet', '--detach', 'HEAD']);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /detached/i.test(error)), JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.equal(result.nextAction, null);
    assert.match(taskBody(target, taskId), /^status: agent-ready$/m);
  });

  it('returns blocked when a consumed plan is reapplied over unrelated staged state', async () => {
    const { target, taskId } = await settleConsumed('repair-consumed-staged');
    const settledHead = head(target);
    writeFileSync(join(target, 'src', 'unrelated-staged.txt'), 'unrelated\n', 'utf8');
    git(target, ['add', '--', 'src/unrelated-staged.txt']);
    const before = porcelain(target);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /unrelated-staged\.txt' is staged/.test(error)), JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.equal(result.nextAction, null);
    // Refusal preserves the unsafe state exactly: nothing written, unstaged, or discarded.
    assert.equal(head(target), settledHead);
    assert.equal(porcelain(target), before);
    assert.match(porcelain(target), /A {2}src\/unrelated-staged\.txt/);
    assert.equal(readFileSync(join(target, 'src', 'unrelated-staged.txt'), 'utf8'), 'unrelated\n');
  });

  it('returns blocked when a consumed plan is reapplied over unrelated unstaged work', async () => {
    const { target, taskId } = await settleConsumed('repair-consumed-unstaged');
    const settledHead = head(target);
    writeFileSync(join(target, 'src', 'existing.txt'), 'changed\n', 'utf8');
    const before = porcelain(target);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /unrelated to this readiness plan/.test(error)), JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.equal(result.nextAction, null);
    assert.equal(head(target), settledHead);
    assert.equal(porcelain(target), before);
    assert.equal(readFileSync(join(target, 'src', 'existing.txt'), 'utf8'), 'changed\n');
  });

  it('no no-op refusal path creates an activation or mutates the task evidence', async () => {
    const { target, taskId } = await settleConsumed('repair-consumed-no-mutation');
    const beforeBody = taskBody(target, taskId);

    // Untracked unrelated work.
    writeFileSync(join(target, 'src', 'later.txt'), 'later\n', 'utf8');
    const untracked = receipt(await applyPlan(target, taskId));
    assert.equal(untracked.mutationDisposition, 'blocked', JSON.stringify(untracked.errors));
    assert.equal(untracked.activationCreated, false);
    assert.equal(existsSync(join(target, '.agenticloop', 'activation')), false);
    assert.equal(taskBody(target, taskId), beforeBody);
    rmSync(join(target, 'src', 'later.txt'));

    // Detached HEAD.
    git(target, ['checkout', '--quiet', '--detach', 'HEAD']);
    const detached = receipt(await applyPlan(target, taskId));
    assert.equal(detached.mutationDisposition, 'blocked', JSON.stringify(detached.errors));
    assert.equal(detached.activationCreated, false);
    assert.equal(existsSync(join(target, '.agenticloop', 'activation')), false);
    assert.equal(taskBody(target, taskId), beforeBody);
    git(target, ['checkout', '--quiet', '-']);
    assert.equal(porcelain(target), '');
  });
});

describe('P35-C12R.3 repair R3-R3: staged scratch is refused, unstaged scratch is not', () => {
  it('refuses a force-staged .agenticloop/tmp/ file through the exported safety evaluator', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-staged-scratch-evaluator');
    const { plan } = await writePlan(target, taskId);
    assert.equal(evaluateReadinessRepositorySafety(target, plan).ok, true);
    writeFileSync(join(target, '.agenticloop', 'tmp', 'staged.txt'), 'staged scratch\n', 'utf8');
    git(target, ['add', '-f', '--', '.agenticloop/tmp/staged.txt']);
    const unsafe = evaluateReadinessRepositorySafety(target, plan);
    assert.equal(unsafe.ok, false, 'a staged index entry is refused even under .agenticloop/tmp/');
    assert.ok(unsafe.errors.some(error => /staged\.txt' is staged/.test(error)), JSON.stringify(unsafe.errors));
  });

  it('refuses the same staged scratch in --dry-run before reporting a dry run', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-staged-scratch-dry');
    await writePlan(target, taskId);
    writeFileSync(join(target, '.agenticloop', 'tmp', 'staged.txt'), 'staged scratch\n', 'utf8');
    git(target, ['add', '-f', '--', '.agenticloop/tmp/staged.txt']);
    const result = receipt(await applyPlan(target, taskId, '--dry-run'));
    assert.equal(result.mutationDisposition, 'blocked', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /staged\.txt' is staged/.test(error)), JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.match(taskBody(target, taskId), /^status: draft$/m);
  });

  it('refuses the same staged scratch in --yes before any candidate mutation', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-staged-scratch-yes');
    const baseHead = head(target);
    await writePlan(target, taskId);
    writeFileSync(join(target, '.agenticloop', 'tmp', 'staged.txt'), 'staged scratch\n', 'utf8');
    git(target, ['add', '-f', '--', '.agenticloop/tmp/staged.txt']);
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'blocked', JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.match(taskBody(target, taskId), /^status: draft$/m);
    assert.equal(existsSync(join(target, DECOMPOSITION_REF(taskId))), false);
  });

  it('preserves the staged scratch index entry and bytes exactly across the refusal', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-staged-scratch-preserve');
    await writePlan(target, taskId);
    writeFileSync(join(target, '.agenticloop', 'tmp', 'staged.txt'), 'staged scratch\n', 'utf8');
    git(target, ['add', '-f', '--', '.agenticloop/tmp/staged.txt']);
    await applyPlan(target, taskId);
    assert.match(porcelain(target), /A {2}\.agenticloop\/tmp\/staged\.txt/);
    assert.equal(readFileSync(join(target, '.agenticloop', 'tmp', 'staged.txt'), 'utf8'), 'staged scratch\n');
  });
});

describe('P35-C12R.3 repair R3-R1: the exact commit tree across hooks', () => {
  it('cannot let a successful hook stage an unplanned product path into the readiness commit', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-hook-product-path');
    const baseHead = head(target);
    await writePlan(target, taskId);
    installHook(target, 'pre-commit',
      '#!/bin/sh\necho hooked > src/hook-product.txt\ngit add -- src/hook-product.txt\nexit 0\n');
    const result = receipt(await applyPlan(target, taskId));
    assert.notEqual(result.mutationDisposition, 'committed', JSON.stringify(result));
    assert.notEqual(result.mutationDisposition, 'unresolved',
      'a hook-contaminated commit is rolled back, not left behind as unresolved');
    assert.equal(result.mutationDisposition, 'rolled_back', JSON.stringify(result.errors));
    assert.ok(result.errors.some(error => /hook-product\.txt|unplanned|exact/.test(error)), JSON.stringify(result.errors));
    assert.equal(result.unresolved, false);
    // The actual Git history, not the receipt: no readiness commit exists.
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.equal(head(target), baseHead);
    assert.equal(
      git(target, ['show', '-s', '--format=%s', 'HEAD']),
      git(target, ['log', '--format=%s', '-1', baseHead]),
      'HEAD is still the pre-transaction fixture commit',
    );
    // Predecessor restoration: the carrier is a draft again and the evidence writes are gone.
    assert.match(taskBody(target, taskId), /^status: draft$/m);
    assert.equal(existsSync(join(target, DECOMPOSITION_REF(taskId))), false);
    // The hook's own worktree side effect is preserved, unstaged, never committed.
    assert.equal(readFileSync(join(target, 'src', 'hook-product.txt'), 'utf8'), 'hooked\n');
    assert.match(porcelain(target), /\?\? src\/hook-product\.txt/);
  });

  it('rolls back when a hook rewrites the staged bytes of a planned path', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-hook-rewrite');
    const baseHead = head(target);
    await writePlan(target, taskId);
    installHook(target, 'pre-commit',
      '#!/bin/sh\necho "\\nhooked" >> .agenticloop/tasks/T-018.md\ngit add -- .agenticloop/tasks/T-018.md\nexit 0\n');
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'rolled_back', JSON.stringify(result.errors));
    assert.equal(result.commitCount, 0);
    assert.equal(commitCountSince(target, baseHead), 0);
    assert.match(taskBody(target, taskId), /^status: draft$/m);
    assert.doesNotMatch(taskBody(target, taskId), /hooked/);
  });

  it('still executes hooks and keeps the exact tree when a hook only observes', async () => {
    const { target, taskId } = createReadinessTarget(temp, 'repair-hook-observe');
    const baseHead = head(target);
    const { plan } = await writePlan(target, taskId);
    installHook(target, 'pre-commit', '#!/bin/sh\necho ran > .agenticloop/tmp/hook-ran.txt\nexit 0\n');
    const result = receipt(await applyPlan(target, taskId));
    assert.equal(result.mutationDisposition, 'committed', JSON.stringify(result.errors));
    // The hook genuinely ran: hooks are not silently disabled.
    assert.equal(readFileSync(join(target, '.agenticloop', 'tmp', 'hook-ran.txt'), 'utf8'), 'ran\n');
    // The actual created commit tree carries exactly the validated planned paths.
    assert.deepEqual(
      git(target, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean).sort(),
      [...plan.writeSet].sort(),
    );
    assert.equal(commitCountSince(target, baseHead), 1);
    assert.equal(porcelain(target), '', 'ignored hook scratch under .agenticloop/tmp/ stays clean');
  });
});

