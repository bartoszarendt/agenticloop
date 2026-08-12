/** Mechanical plan-synchronization evidence tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCloseoutPlanSyncFixture } from './helpers/closeout-plan-sync-fixture.js';

const fixture = createCloseoutPlanSyncFixture();
const { makeGitTarget, closeout, certify } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('plan-sync gate', () => {
  it('refuses completion when a plan applies and plan-sync evidence is omitted', async () => {
    const target = await makeGitTarget('omitted');
    const artifact = await certify(target);
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.equal(packet.recommended_status, 'needs_context');
    assert.ok(packet.reasons.some(item => item.gate === 'plan_sync' && item.category === 'plan_sync_missing'),
      JSON.stringify(packet.reasons));
  });

  it('passes with an explicit not_required recorded visibly in the marker', async () => {
    const target = await makeGitTarget('not-required');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'not_required', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.plan_sync, 'not_required');
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const carrier = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8');
    assert.match(carrier, /AGENT_CLOSEOUT_PLAN_SYNC: not_required/);
  });

  it('verifies synced mechanically and binds the exact plan revision', async () => {
    const target = await makeGitTarget('synced');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.match(packet.plan_sync, /^synced@sha256:[0-9a-f]{64}$/);
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const status = await closeout(['status', '--work-unit', 'milestone:M00'], target);
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.match(status.stdout, /complete \(current\)/);
  });

});
