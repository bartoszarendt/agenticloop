/** Mechanical plan-synchronization failure tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createCloseoutPlanSyncFixture } from './helpers/closeout-plan-sync-fixture.js';

const fixture = createCloseoutPlanSyncFixture();
const { makeGitTarget, closeout, certify } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('plan-sync gate', () => {
  it('fails synced for a missing plan, an unverifiable plan, or a stale revision', async () => {
    // Missing plan reference.
    const missing = await makeGitTarget('synced-missing', { plan: null });
    let artifact = await certify(missing);
    let result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-ref', 'PLAN.md', '--json',
    ], missing);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /missing plan/.test(item.message)));

    // No recognizable task table.
    const unverifiable = await makeGitTarget('synced-unverifiable', { plan: '# Plan\n\nfree prose only\n' });
    artifact = await certify(unverifiable);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], unverifiable);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /cannot be verified mechanically/.test(item.message)));

    // Internally incomplete: the table exists but covers none of the tasks.
    const incomplete = await makeGitTarget('synced-incomplete', {
      plan: ['# Plan', '', '| ID | Status | Task |', '|---|---|---|', '| T-099 | complete | other |', ''].join('\n'),
    });
    artifact = await certify(incomplete);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], incomplete);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /internally incomplete/.test(item.message)));

    // Stale caller-cited revision.
    const stale = await makeGitTarget('synced-stale-rev');
    artifact = await certify(stale);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-revision', `sha256:${'0'.repeat(64)}`, '--json',
    ], stale);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /does not match the current plan revision/.test(item.message)));
  });
});
