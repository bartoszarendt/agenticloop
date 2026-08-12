/** Covered-task transition drift and rename-safety tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCloseoutWorkflowDeltaFixture } from './helpers/closeout-workflow-delta-fixture.js';
import { git as fixtureGit } from './helpers/dispatch-fixture.js';

const fixture = createCloseoutWorkflowDeltaFixture();
const {
  git, makeGitTarget, taskPath, writeTask, commitAll, certify,
  recordCompleteMarker, statusState,
} = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('covered-task terminal transitions', () => {
  it('rejects any unrelated covered-task change as product drift', async () => {
    const target = await makeGitTarget('unrelated-task-change');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // Status regression is not the permitted terminal transition.
    writeTask(target, 'T-001', 'in-progress');
    commitAll(target, 'reopen T-001');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete');
    assert.ok(state.reasons.some(message => /T-001/.test(message)), JSON.stringify(state));

    // Body edits unrelated to the terminal transition are drift too.
    const target2 = await makeGitTarget('task-body-edit');
    const artifact2 = await certify(target2);
    await recordCompleteMarker(target2, artifact2);
    writeFileSync(
      taskPath(target2, 'T-001'),
      readFileSync(taskPath(target2, 'T-001'), 'utf-8').replace(/^status: accepted$/m, 'status: closed') + '\nextra notes\n',
      'utf-8'
    );
    commitAll(target2, 'edit T-001 body');
    const state2 = await statusState(target2);
    assert.notEqual(state2.state, 'complete');
  });
});

describe('scratch and rename safety', () => {
  it('treats tracked scratch activity under .agenticloop/tmp as transient', async () => {
    const target = await makeGitTarget('scratch');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    writeFileSync(join(target, '.agenticloop', 'tmp', 'notes.txt'), 'transient\n', 'utf-8');
    git(target, ['add', '-f', '.agenticloop/tmp/notes.txt']);
    fixtureGit(target, ['commit', '-m', 'tracked scratch\n\nTask: T-001\nAgent: engineer']);

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
  });

  it('rejects product-to-scratch and product-to-carrier rename attacks', async () => {
    const target = await makeGitTarget('rename-scratch');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    git(target, ['mv', 'app.js', '.agenticloop/tmp/app.js']);
    git(target, ['add', '-A']);
    fixtureGit(target, ['commit', '-m', 'rename product into scratch\n\nTask: T-001\nAgent: engineer']);

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete');
    assert.ok(state.reasons.some(message => /app\.js/.test(message)), JSON.stringify(state));
  });
});
