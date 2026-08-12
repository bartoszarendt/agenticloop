/** Mechanical plan-synchronization drift tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCloseoutPlanSyncFixture } from './helpers/closeout-plan-sync-fixture.js';

const fixture = createCloseoutPlanSyncFixture();
const { makeGitTarget, commitAll, closeout, certify } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('plan-sync gate', () => {
  it('a plan edit after certification makes the packet and marker stale', async () => {
    const target = await makeGitTarget('plan-drift');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--output', packetPath,
    ], target)).status, 0);

    // Editing the plan after certification is product drift and revision drift.
    writeFileSync(join(target, 'PLAN.md'), `${readFileSync(join(target, 'PLAN.md'), 'utf-8')}\nlate edit\n`, 'utf-8');
    commitAll(target, 'edit plan after certification');

    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 1);
    assert.match(recorded.stderr, /stale packet/);

    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.notEqual(JSON.parse(status.stdout).state, 'complete');
  });

  it('skipped remains non-passing', async () => {
    const target = await makeGitTarget('skipped');
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'skipped', '--json',
    ], target);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).completion_eligible, false);
  });

  it('no applicable plan keeps none and not_required passing', async () => {
    const target = await makeGitTarget('no-plan', { withPlan: false, plan: null });
    const artifact = await certify(target);
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).plan_sync, 'none');
  });
});
