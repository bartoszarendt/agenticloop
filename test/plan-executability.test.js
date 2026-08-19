/**
 * A plan may not contradict itself.
 *
 * The second field cohort produced two refusals that look unrelated and are one
 * class. `task readiness-plan` for an `in-progress` task emitted the step
 * `task status <id> agent-ready ...` and then listed, among its own blockers,
 * "Cannot transition from 'in-progress' to 'agent-ready'". The
 * `work_unit_identity` step reported that `work-unit:<id>` is a per-task
 * fallback rather than a durable grouping, and prescribed
 * `prepare-decomposition --work-unit work-unit:<id>` - passing back the exact
 * value its own blocker had just refused.
 *
 * Per-command assertions would have caught neither, because each command was
 * individually correct about every fact it reported. What was wrong is a
 * property of the pair: the plan prescribed a step its own findings reject.
 *
 * So this is one mechanical invariant over every plan-emitting command:
 *
 *   (a) no emitted step is named among the plan's own blockers, and
 *   (b) no argument value in an emitted step's command appears in a blocker as
 *       a rejected value - that is, quoted, which is how every refusal in this
 *       toolkit spells the value it is refusing.
 *
 * It is deliberately mechanical and deliberately general. The durable half of
 * the remediation is this test, not either individual correction.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildReadinessPlan } from '../src/readiness-plan.js';
import { deriveHandoffSequence } from '../src/handoff-sequence.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { makeDecomposition, makePreflightTask } from './helpers/preflight-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-plan-exec-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

/**
 * Command words that are never argument values: the launcher, the binary, its
 * command groups, and shell joinery. Everything else a command names is a value
 * the plan is asserting is usable right now.
 */
const COMMAND_WORDS = new Set([
  'npx', 'agenticloop', 'task', 'git', 'add', 'commit', '&&', '--', '-m', '-C',
]);

/** The values one prescribed command asserts are usable. */
export function commandArgumentValues(command) {
  return String(command ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !COMMAND_WORDS.has(token))
    .filter(token => !token.startsWith('-'))
    // A placeholder is an honest statement that the value is not yet known. It
    // is the echoed *concrete* value that makes a repair unexecutable.
    .filter(token => !/^["']?<.*>["']?$/.test(token))
    .map(token => token.replace(/^["'`]+|["'`,.;]+$/g, ''))
    .filter(Boolean);
}

/**
 * Assert the two halves of the invariant over one plan.
 *
 * `subjects` names what the plan is *about* - the task id, above all. A subject
 * appears in every command the plan emits and in most refusals it reports, and a
 * refusal that quotes it is describing the thing being planned, not refusing a
 * value the plan passed. "task 'T-404' does not exist" beside `task new T-404`
 * is a correct repair, not a contradiction.
 *
 * @param {{ label: string, steps: Array<{id?: string, command?: string|null}>,
 *           blockers: string[], subjects?: string[] }} plan
 */
export function assertPlanIsExecutable({ label, steps, blockers, subjects = [] }) {
  const text = blockers.join('\n');
  const subject = new Set(subjects);
  for (const item of steps) {
    if (!item?.command) continue;
    if (item.id) {
      assert.equal(
        blockers.some(blocker => blocker.includes(`'${item.id}'`)),
        false,
        `${label}: step '${item.id}' is prescribed and also named among the plan's own blockers`
      );
    }
    for (const value of commandArgumentValues(item.command)) {
      if (subject.has(value)) continue;
      assert.equal(
        text.includes(`'${value}'`),
        false,
        `${label}: step '${item.id ?? item.command}' passes '${value}', which a blocker of the same plan refuses:\n${
          blockers.filter(blocker => blocker.includes(`'${value}'`)).join('\n')}`
      );
    }
  }
}

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

/**
 * Every lifecycle status a readiness plan can be asked about, plus whether the
 * task has a decomposition and what grouping it names. The two field defects
 * live at `in-progress` and at the per-task fallback; the rest are here because
 * the invariant is supposed to hold everywhere, not only where it was violated.
 */
const READINESS_CASES = [
  { name: 'draft', status: 'draft', decomposition: null },
  { name: 'agent-ready', status: 'agent-ready', decomposition: null },
  { name: 'in-progress', status: 'in-progress', decomposition: null },
  { name: 'needs-revision', status: 'needs_revision', decomposition: null },
  { name: 'blocked', status: 'blocked', decomposition: null },
  { name: 'fallback-work-unit', status: 'in-progress', decomposition: {} },
  { name: 'durable-work-unit', status: 'agent-ready', decomposition: { workUnitId: 'milestone:M2' } },
];

describe('no plan prescribes a step its own findings reject', () => {
  for (const scenario of READINESS_CASES) {
    it(`holds for a readiness plan of a ${scenario.name} task`, () => {
      const taskId = 'T-001';
      const target = newTarget(`readiness-${scenario.name}`, taskId, { status: scenario.status });
      if (scenario.decomposition) {
        makeDecomposition(target, taskId, scenario.decomposition);
        git(target, ['add', '-A']);
        git(target, ['commit', '-m', `decomposition\n\nTask: ${taskId}\nAgent: maintainer`]);
      }
      const plan = buildReadinessPlan(target, taskId);
      assertPlanIsExecutable({
        label: `readiness-plan(${scenario.name})`,
        steps: plan.steps,
        blockers: plan.blockers,
        subjects: [taskId],
      });
    });
  }

  it('holds for a readiness plan carrying every supplied input', () => {
    const target = newTarget('readiness-supplied', 'T-001', { status: 'in-progress' });
    makeDecomposition(target, 'T-001');
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'decomposition\n\nTask: T-001\nAgent: maintainer']);
    const plan = buildReadinessPlan(target, 'T-001', {
      actor: 'Agentic Loop Test',
      authority: 'plan:x',
    });
    assertPlanIsExecutable({
      label: 'readiness-plan(supplied)', steps: plan.steps, blockers: plan.blockers, subjects: ['T-001'],
    });
  });

  it('holds for the dispatch sequence a preflight predicts', () => {
    for (const newPacketPermitted of [true, false]) {
      const sequence = deriveHandoffSequence({
        taskId: 'T-001',
        host: 'opencode',
        newPacketPermitted,
        liveAttempt: { attemptId: 'attempt:0123456789abcdef0123456789abcdef' },
      });
      assertPlanIsExecutable({
        label: `handoff-sequence(newPacketPermitted=${newPacketPermitted})`,
        steps: sequence.steps,
        blockers: [],
        subjects: ['T-001'],
      });
    }
  });

  it('holds for the whole preflight verdict, sequence against refusals', async () => {
    const target = newTarget('preflight', 'T-001', { status: 'in-progress' });
    makeDecomposition(target, 'T-001');
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'decomposition\n\nTask: T-001\nAgent: maintainer']);
    const result = await runCliInProcess(
      ['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json', '--target', target]);
    const verdict = JSON.parse(result.stdout);
    assertPlanIsExecutable({
      label: 'handoff-preflight',
      steps: verdict.nextSequence?.steps ?? [],
      blockers: verdict.errors ?? [],
      subjects: ['T-001'],
    });
  });
});

describe('the invariant is a real check, not a tautology', () => {
  it('fails a plan that prescribes a value its own blocker refuses', () => {
    assert.throws(
      () => assertPlanIsExecutable({
        label: 'synthetic',
        steps: [{ id: 'work_unit_identity', command: 'npx agenticloop task prepare-decomposition T-001 --work-unit work-unit:T-001' }],
        blockers: ["work-unit identity 'work-unit:T-001' is a per-task fallback, not a durable grouping"],
      }),
      /passes 'work-unit:T-001'/
    );
  });

  it('fails a plan that prescribes a transition its own blocker forbids', () => {
    assert.throws(
      () => assertPlanIsExecutable({
        label: 'synthetic',
        steps: [{ id: 'lifecycle_agent_ready', command: 'npx agenticloop task status T-001 agent-ready --expect-digest sha256:x' }],
        blockers: ["Cannot transition from 'in-progress' to 'agent-ready'. Allowed transitions: needs_revision, blocked"],
      }),
      /passes 'agent-ready'/
    );
  });

  it('fails a plan that names its own step among its blockers', () => {
    assert.throws(
      () => assertPlanIsExecutable({
        label: 'synthetic',
        steps: [{ id: 'committed_decomposition', command: 'npx agenticloop task prepare-decomposition T-001' }],
        blockers: ["step 'committed_decomposition' cannot be settled from current facts"],
      }),
      /named among the plan's own blockers/
    );
  });

  it('accepts an unresolved placeholder, which states what is not yet known', () => {
    assertPlanIsExecutable({
      label: 'synthetic',
      steps: [{ id: 'work_unit_identity', command: 'npx agenticloop task prepare-decomposition T-001 --work-unit <work-unit-id>' }],
      blockers: ["work-unit identity 'work-unit:T-001' is a per-task fallback, not a durable grouping"],
    });
  });
});
