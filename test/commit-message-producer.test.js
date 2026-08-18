/**
 * The toolkit ships a producer for the one artifact it is strictest about.
 *
 * `verification.context.malformed` was the largest failure code of the field
 * run - fourteen refusals, three rejected commits, one history reset - and the
 * dominant trigger was a non-contiguous `Task:`/`Agent:` trailer block. The
 * grammar was not being misunderstood: `git commit -m … -m …`, the most natural
 * way for an agent to write a multi-line message, inserts a blank line between
 * every `-m` and therefore strands `Task:` in its own paragraph, outside the
 * final contiguous block the validator requires.
 *
 * Agentic Loop enforced that grammar and provided nothing that emitted it.
 * These cases pin the producer, and pin that the producer and the validator
 * share one renderer - so a message the toolkit hands out can never be one the
 * toolkit rejects.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  COMMIT_MESSAGE_CLASSES,
  evaluateCommitAttribution,
  parseFinalTrailerBlock,
  renderCommitMessage,
} from '../src/commit-attribution.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-commit-message-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function target(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  createTaskProjectFixture(root);
  mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
  return root;
}

describe('the defect the producer exists to remove', () => {
  it('confirms repeated -m arguments produce a message the grammar rejects', () => {
    // Reproduced exactly: git joins each -m with a blank line, so only the last
    // paragraph is the final contiguous trailer block and `Task:` is misplaced.
    const gitStyle = ['implement the task', 'Task: T-018', 'Agent: engineer'].join('\n\n');
    const parsed = parseFinalTrailerBlock(gitStyle);
    assert.deepEqual(parsed.trailers, ['Agent: engineer']);
    assert.deepEqual(parsed.misplaced, ['Task: T-018']);
    const checked = evaluateCommitAttribution({ message: gitStyle, taskId: 'T-018', role: 'engineer' });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /misplaced Task\/Agent trailer/);
  });

  it('points at the producer from the refusal, not at the grammar', () => {
    const checked = evaluateCommitAttribution({ message: 'no trailers here', taskId: 'T-018', role: 'engineer' });
    assert.equal(checked.ok, false);
    assert.match(checked.repairPlan, /task commit-message T-018 --class <commit-class>/);
    assert.match(checked.repairPlan, /git commit -F/);
  });
});

describe('the producer and the validator share one renderer', () => {
  it('emits a message the canonical validator accepts, with and without a body', () => {
    for (const body of [null, 'Binds the product head to the commit that introduced src/thing.js.']) {
      const rendered = renderCommitMessage({ taskId: 'T-018', role: 'engineer', subject: 'implement the task', body });
      assert.equal(rendered.ok, true, rendered.errors.join('; '));
      assert.match(rendered.message, /\n\nTask: T-018\nAgent: engineer\n$/);
      const checked = evaluateCommitAttribution({ message: rendered.message, taskId: 'T-018', role: 'engineer' });
      assert.equal(checked.ok, true, checked.errors.join('; '));
      assert.deepEqual(parseFinalTrailerBlock(rendered.message).misplaced, []);
    }
  });

  it('renders one accepted message for every declared commit class', () => {
    for (const [commitClass, role] of Object.entries(COMMIT_MESSAGE_CLASSES)) {
      const rendered = renderCommitMessage({ taskId: 'T-018', role, subject: `record ${commitClass}` });
      assert.equal(rendered.ok, true, `${commitClass}: ${rendered.errors.join('; ')}`);
      assert.equal(
        evaluateCommitAttribution({ message: rendered.message, taskId: 'T-018', role }).ok,
        true,
        `${commitClass} must render a message the validator accepts`
      );
    }
  });

  it('refuses a body that would become a misplaced trailer', () => {
    const rendered = renderCommitMessage({
      taskId: 'T-018', role: 'engineer', subject: 'implement',
      body: 'Task: T-018\n\nmore prose',
    });
    assert.equal(rendered.ok, false);
    assert.match(rendered.errors.join('; '), /cannot contain its own Task or Agent trailer/);
  });
});

describe('task commit-message', () => {
  it('writes a message file Git commits and the validator accepts', async () => {
    const root = target('produced');
    const output = '.agenticloop/tmp/message.txt';
    const result = await runCliInProcess([
      'task', 'commit-message', 'T-001', '--class', 'implementation_artifact_evidence',
      '--subject', 'record the implementation artifact',
      '--body', 'Binds the product head derived from Git.',
      '--output', output, '--json', '--target', root,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.role, 'engineer', 'the commit class decides the role, so no role has to guess it');
    assert.equal(report.commitCommand, `git commit -F ${output}`);

    const written = readFileSync(join(root, output), 'utf8');
    assert.equal(written, report.message);
    assert.equal(evaluateCommitAttribution({ message: written, taskId: 'T-001', role: 'engineer' }).ok, true);

    // Through real Git, with the file, exactly as the emitted command says.
    spawnSync('git', ['add', '-A'], { cwd: root });
    const committed = spawnSync('git', ['commit', '-F', output], { cwd: root, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    const message = spawnSync('git', ['show', '-s', '--format=%B', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout;
    assert.equal(evaluateCommitAttribution({ message, taskId: 'T-001', role: 'engineer' }).ok, true);
  });

  it('attributes a maintainer-owned class to the maintainer', async () => {
    const root = target('maintainer-class');
    const output = '.agenticloop/tmp/message.txt';
    const result = await runCliInProcess([
      'task', 'commit-message', 'T-001', '--class', 'attempt_abandonment',
      '--subject', 'abandon the expired attempt', '--output', output, '--json', '--target', root,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).role, 'maintainer');
    assert.match(readFileSync(join(root, output), 'utf8'), /\nAgent: maintainer\n$/);
  });

  it('refuses an unknown commit class and names the accepted ones', async () => {
    const root = target('unknown-class');
    const result = await runCliInProcess([
      'task', 'commit-message', 'T-001', '--class', 'invented_class',
      '--subject', 'x', '--output', '.agenticloop/tmp/m.txt', '--json', '--target', root,
    ]);
    assert.equal(result.status, 2);
    const errors = JSON.parse(result.stdout).errors.join('\n');
    assert.match(errors, /Invalid --class value 'invented_class'/);
    assert.match(errors, /implementation_artifact_evidence/);
    assert.match(errors, /attempt_abandonment/);
  });
});
