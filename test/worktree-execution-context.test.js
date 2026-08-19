/**
 * A worktree target is a whole execution context or it is nothing.
 *
 * The worktree return lane is a deliberate flow: cut a branch before the
 * implementation, re-apply the product commits on it, and run the return chain
 * from a clean room. What the field run met instead was a lane that could see
 * only half the world. Commands resolved some state relative to `--target` and
 * other state relative to the carrier root, so:
 *
 * - `handoff-preflight --target <worktree>` reported the task's activation
 *   authorization as `missing` while the grant sat in the carrier root, and its
 *   repair hint printed `activate <task-id>` with no `--target` - a command
 *   that would authorize a different carrier than the one just evaluated; and
 * - `attempt-status --target <worktree>` reported `attempts: []` and
 *   `newPacketPermitted: true` for a task with live attempts outstanding in the
 *   carrier root, so a lane could mint packets blind to them.
 *
 * Both are one defect. These fixtures pin the property that closes it: for one
 * task, no command reports authority or attempt state that differs by target.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAgenticLoopWorktree } from '../src/worktree.js';
import { createDispatchFixture, git, prepare as prepareDispatch } from './helpers/dispatch-fixture.js';
import { interactiveOptions, scaffoldFixture } from './helpers/activation-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-worktree-context-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function carrierDigest(root, taskId = 'T-001') {
  const content = readFileSync(join(root, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

describe('activation authority spans the carrier root and its worktrees', () => {
  it('resolves one grant from both the carrier root and a worktree target', async () => {
    const fixture = await scaffoldFixture(temp, 'activation-span');
    const root = fixture.root;
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    };
    assertOk(
      await runCliInProcess(['activate', 'T-001', '--json', '--target', root], interactiveOptions(fixture)),
      'operator activation in the carrier root'
    );
    const worktree = createAgenticLoopWorktree({
      target: root, taskId: 'T-001', branch: 'task/T-001-return', from: 'HEAD',
    });

    const fromRoot = await runCliInProcess(
      ['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json', '--target', root], options);
    assertOk(fromRoot, 'preflight in the carrier root');

    const fromWorktree = await runCliInProcess(
      ['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json', '--target', worktree.path], options);
    assert.equal(
      JSON.parse(fromWorktree.stdout).errors.join('\n').includes("activation authorization is 'missing'"),
      false,
      'the grant that covers this task is visible from the worktree it was minted for'
    );
    assertOk(fromWorktree, 'preflight in the worktree');
  });

  it('names the evaluated carrier in every activation repair it prints', async () => {
    // The unauthorized case still refuses, and that refusal is where the hint
    // has to be exact: a bare `activate <task-id>` run from the operator's own
    // shell authorizes the root, not the worktree the refusal came from.
    const fixture = await scaffoldFixture(temp, 'activation-hint');
    const root = fixture.root;
    const worktree = createAgenticLoopWorktree({
      target: root, taskId: 'T-001', branch: 'task/T-001-return', from: 'HEAD',
    });
    const refused = await runCliInProcess(
      ['task', 'handoff-preflight', 'T-001', '--host', 'opencode', '--json', '--target', worktree.path],
      { operatorTrustRoot: fixture.operatorTrustRoot, operatorActivationRoot: fixture.operatorActivationRoot }
    );
    assert.equal(refused.status, 1, 'an unactivated task refuses from either carrier');
    const result = JSON.parse(refused.stdout);
    for (const hint of [result.firstSafeRepair, ...result.diagnostics.map(item => item.repairHint)]) {
      if (typeof hint !== 'string' || !hint.includes('agenticloop activate')) continue;
      for (const command of hint.split('; ')) {
        assert.match(
          command,
          /--target /,
          `an activation repair evaluated against a worktree must name it: ${command}`
        );
      }
    }
  });
});

describe('attempt state is a property of the task, not of the checkout', () => {
  it('reports the carrier root attempts from a worktree target', async () => {
    const fixture = await createDispatchFixture(temp, 'attempt-span');
    const root = fixture.root;
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
    };
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    const packetPath = '.agenticloop/tmp/packet.json';
    writeFileSync(join(root, packetPath), JSON.stringify(prepareDispatch(fixture).packet), 'utf8');
    assertOk(await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(root),
      '--dispatch-packet', packetPath, '--json', '--target', root,
    ], options), 'role start in the carrier root');
    git(root, ['add', '.agenticloop/tasks', '.agenticloop/handoffs']);
    git(root, ['commit', '-m', 'start the engineer role\n\nTask: T-001\nAgent: engineer']);

    // The return lane is cut before the attempt records, exactly as the field
    // lane was: the worktree checkout genuinely does not contain them.
    const worktree = createAgenticLoopWorktree({
      target: root, taskId: 'T-001', branch: 'task/T-001-return', from: 'HEAD~1',
    });

    const fromRoot = JSON.parse(
      assertOk(await runCliInProcess(
        ['task', 'attempt-status', 'T-001', '--json', '--target', root], options), 'attempt status in the root').stdout);
    assert.equal(fromRoot.attempts.length, 1, 'the carrier root holds one live attempt');

    const fromWorktree = JSON.parse((await runCliInProcess(
      ['task', 'attempt-status', 'T-001', '--json', '--target', worktree.path], options)).stdout);
    assert.deepEqual(
      fromWorktree.attempts.map(attempt => attempt.attemptId),
      fromRoot.attempts.map(attempt => attempt.attemptId),
      'a worktree lane sees every attempt outstanding against the task'
    );
    assert.equal(fromWorktree.liveAttempt?.attemptId, fromRoot.liveAttempt?.attemptId);
  });
});
