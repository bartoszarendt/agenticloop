/**
 * A task and role carry at most one live attempt, and the budget binds.
 *
 * The field cohort left nine execution attempts on record for one task, six of
 * them simultaneously live. Attempts 1-3 were never retired; 7, 8 and 9 were
 * consumed within four and a half minutes of each other; and `attempt-status`
 * reported `new packet permitted: yes` throughout. Nothing there was a wrong
 * decision. `abandon-attempt` retires only the attempt an operator names, and
 * consuming a successor retired nothing at all - so an attempt that had plainly
 * been superseded stayed live until a human said otherwise, and no human did.
 *
 * The task's own `attempt_budget: 5` bound nothing. Nine attempts against it
 * went unnoticed until the Engineer counted them by hand and reported its
 * effort as `near_budget`. A field that binds nothing is worse than absent.
 *
 * These cases pin both halves: consuming a packet retires its predecessors with
 * a truthful reason, and the budget is a hard stop with a typed refusal.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDispatchFixture, git } from './helpers/dispatch-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-attempt-supersession-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function carrierDigest(root, taskId = 'T-001') {
  const content = readFileSync(join(root, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

/**
 * Drive one more role start against a fresh packet, exactly as a resumed
 * attempt does: mint, consume, commit the workflow state it produced.
 */
async function consumePacket(fixture, cli, sequence) {
  const root = fixture.root;
  const packetPath = `.agenticloop/tmp/packet-${sequence}.json`;
  // Every packet is minted through the real commands. For a successor, execute
  // live preflight first: it must truthfully predict product work for the
  // current attempt, not claim a fresh-dispatch repair is its next command.
  // Automatic pre-work supersession then refreshes decomposition explicitly.
  if (sequence > 1) {
    const preflight = await cli(['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json']);
    const preflightResult = JSON.parse(preflight.stdout);
    if (preflight.status === 1) {
      assert.match(preflightResult.firstSafeRepair, /^npx agenticloop task prepare-decomposition /);
      const repair = preflightResult.firstSafeRepair.replace(/^npx agenticloop /, '').split(' ');
      assertOk(await cli([...repair, '--json']), `execute preflight repair for ${sequence}`);
    } else {
      assert.equal(preflight.status, 0, `preflight before successor ${sequence} must be decided`);
      assert.equal(preflightResult.liveAttemptGate.nextStep, 'product_work');
      const head = git(root, ['rev-parse', 'HEAD']);
      const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
      assertOk(await cli([
        'task', 'prepare-decomposition', 'T-001',
        '--work-unit', 'fixture-work-unit',
        '--source-ref', '.agenticloop/decompositions/T-001.json',
        '--source-revision', `git-commit:${head}`,
        '--base', tree,
        '--dependencies', 'dependencies.json',
        '--output', '.agenticloop/decompositions/T-001.json', '--json',
      ]), `regenerate the decomposition for ${sequence}`);
    }
    git(root, ['add', '.agenticloop/decompositions']);
    git(root, ['commit', '-m', `regenerate the decomposition\n\nTask: T-001\nAgent: maintainer`]);
  }
  assertOk(await cli([
    'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer',
    '--output', packetPath, '--json',
  ]), `mint packet ${sequence}`);
  const started = await cli(['task', 'role-start', 'T-001', '--packet', packetPath, '--json']);
  if (started.status === 0) {
    git(root, ['add', '.agenticloop/tasks', '.agenticloop/handoffs']);
    git(root, ['commit', '-m', `start attempt ${sequence}\n\nTask: T-001\nAgent: engineer`]);
  }
  return started;
}

async function startedTask(name, options = {}) {
  const fixture = await createDispatchFixture(temp, name, options);
  const cli = args => runCliInProcess([...args, '--target', fixture.root], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    hostAuthority: protectedHostBoundary(fixture.trust),
  });
  mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
  return { fixture, cli };
}

const attemptStatus = async cli =>
  JSON.parse((await cli(['task', 'attempt-status', 'T-001', '--json'])).stdout);

describe('consuming a packet retires the attempt it supersedes', () => {
  it('leaves exactly one live attempt for the task and role', async () => {
    const { fixture, cli } = await startedTask('supersede');
    for (const sequence of [1, 2, 3]) {
      assertOk(await consumePacket(fixture, cli, sequence), `role start ${sequence}`);
    }

    const status = await attemptStatus(cli);
    assert.equal(status.attempts.length, 3, 'every attempt stays on record');
    const live = status.attempts.filter(attempt => attempt.state === 'live');
    assert.equal(live.length, 1, `exactly one attempt is live, not ${live.length}`);
    assert.equal(live[0].attemptId, status.attempts.at(-1).attemptId, 'the survivor is the newest attempt');
    assert.equal(status.liveAttempt.attemptId, live[0].attemptId);
  });

  it('names the superseding packet as the reason and the authority', async () => {
    const { fixture, cli } = await startedTask('supersede-reason');
    assertOk(await consumePacket(fixture, cli, 1), 'first role start');
    assertOk(await consumePacket(fixture, cli, 2), 'second role start');

    const status = await attemptStatus(cli);
    const retired = status.attempts.find(attempt => attempt.state === 'superseded_by_packet');
    assert.equal(retired.abandonment.disposition, 'superseded_by_packet');
    assert.equal(retired.abandonment.authority, status.liveAttempt.packetId,
      'the successor packet is the durable reference that permitted the retirement');
    assert.match(retired.abandonment.reason, /superseded by dispatch packet dispatch:/);
    assert.match(retired.abandonment.reason, /for role engineer/);
  });

  it('leaves explicit abandonment as the exit for an attempt with no successor', async () => {
    // Supersession never replaces the operator path; it only covers the case
    // where a successor exists and the predecessor is therefore over.
    const { fixture, cli } = await startedTask('supersede-explicit');
    assertOk(await consumePacket(fixture, cli, 1), 'role start');
    const status = await attemptStatus(cli);
    assertOk(await cli([
      'task', 'abandon-attempt', 'T-001', '--attempt', status.liveAttempt.attemptId,
      '--reason', 'the operator stopped this work and no successor packet exists',
      '--authority', 'operator:field-run', '--json',
    ]), 'explicit abandonment');
    const after = await attemptStatus(cli);
    assert.equal(after.attempts.at(-1).abandonment.disposition, 'abandoned');
    git(fixture.root, ['add', '.agenticloop/handoffs/attempts']);
    git(fixture.root, ['commit', '-m', 'record explicit abandonment\n\nTask: T-001\nAgent: maintainer']);

    const preflight = await cli(['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json']);
    assert.equal(preflight.status, 1, 'retired attempt exposes the fresh-dispatch repair');
    const result = JSON.parse(preflight.stdout);
    assert.match(result.firstSafeRepair, /^npx agenticloop task prepare-decomposition /);
    const repair = result.firstSafeRepair.replace(/^npx agenticloop /, '').split(' ');
    assertOk(await cli([...repair, '--json']), 'execute preflight first-safe repair');
  });
});

describe('attempt_budget is a bound, not a comment', () => {
  it('refuses a further packet at the declared budget, with a typed refusal', async () => {
    const { fixture, cli } = await startedTask('budget');
    // A budget of two makes the bound reachable without driving five identical
    // role starts; the field task declared five and reached nine.
    const carrier = join(fixture.root, '.agenticloop', 'tasks', 'T-001.md');
    writeFileSync(carrier, readFileSync(carrier, 'utf8').replace('attempt_budget: 5', 'attempt_budget: 2'), 'utf8');
    git(fixture.root, ['add', '.agenticloop/tasks']);
    git(fixture.root, ['commit', '-m', 'declare the attempt budget\n\nTask: T-001\nAgent: maintainer']);

    assertOk(await consumePacket(fixture, cli, 1), 'first role start');
    const first = await attemptStatus(cli);
    assertOk(await cli([
      'task', 'abandon-attempt', 'T-001', '--attempt', first.liveAttempt.attemptId,
      '--reason', 'Engineering attempt made no acceptable progress and requires a fresh approach.',
      '--authority', 'maintainer:budget-test', '--json',
    ]), 'record real no-progress attempt');
    git(fixture.root, ['add', '.agenticloop/handoffs/attempts']);
    git(fixture.root, ['commit', '-m', 'record no-progress attempt\n\nTask: T-001\nAgent: maintainer']);
    assertOk(await consumePacket(fixture, cli, 2), 'second role start');

    const status = JSON.parse((await cli(['task', 'attempt-status', 'T-001', '--json'])).stdout);
    assert.equal(status.newPacketPermitted, false, 'the budget is a hard stop');
    assert.deepEqual(
      { budget: status.attemptBudget.budget, recorded: status.attemptBudget.recorded, source: status.attemptBudget.source },
      { budget: 2, recorded: 2, source: 'task' }
    );
    assert.match(status.reason, /attempt_budget of 2/);
    assert.match(status.safeRepair, /record the task as blocked or needs_context/);
    assert.match(status.safeRepair, /authorize-correction T-001/);
  });

  it('reports the budget it is measuring against while the task is still under it', async () => {
    const { fixture, cli } = await startedTask('budget-under');
    assertOk(await consumePacket(fixture, cli, 1), 'first role start');
    const status = await attemptStatus(cli);
    assert.equal(status.newPacketPermitted, true);
    assert.equal(status.attemptBudget.budget, 5, 'the task record materializes the built-in default');
    assert.equal(status.attemptBudget.recorded, 1);
  });
});
