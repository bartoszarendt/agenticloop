/** Mechanical plan-synchronization verification tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createCloseoutPlanSyncFixture } from './helpers/closeout-plan-sync-fixture.js';

const fixture = createCloseoutPlanSyncFixture();
const { planContent, makeGitTarget, closeout, certify, cacheStats, releaseFixtures } = fixture;
let tmpDir;
before(() => { tmpDir = fixture.setup(); });
after(() => { fixture.cleanup(); });

function verificationFiles(target) {
  return readdirSync(join(target, '.agenticloop', 'returns', 'verifications')).sort();
}

describe('plan-sync gate', () => {
  it('finds the task table after unrelated Markdown tables', async () => {
    const multiTablePlan = [
      '# Plan',
      '',
      '| Risk | Mitigation |',
      '|---|---|',
      '| drift | verify |',
      '',
      planContent(),
    ].join('\n');
    const target = await makeGitTarget('synced-multi-table', { plan: multiTablePlan });
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--json',
    ], target);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(JSON.parse(result.stdout).plan_sync, /^synced@sha256:[0-9a-f]{64}$/);
  });

  it('fails synced when the plan still marks covered work items planned or in-progress', async () => {
    const target = await makeGitTarget('synced-open', { plan: planContent('planned', 'complete') });
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.gate === 'plan_sync' && /T-001/.test(item.message)));
  });

  it('rejects plan references that resolve outside the target repository', async () => {
    const target = await makeGitTarget('synced-outside');
    const outsidePlan = join(tmpDir, 'outside-plan.md');
    writeFileSync(outsidePlan, planContent(), 'utf-8');
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-ref', relative(target, outsidePlan), '--json',
    ], target);

    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /outside the target repository/.test(item.message)),
      result.stdout);
  });

  it('reuses only the exact matching plan-sync certification checkpoint', async () => {
    const firstTarget = await makeGitTarget('matching-plan-sync');
    const artifact = await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeGitTarget('matching-plan-sync');
    assert.equal(await certify(target), artifact);
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits + 1);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions);
    assert.deepEqual(verificationFiles(target), initialVerificationFiles);
  });

  it('reuses a pristine controller for different authored plans but not their certification', async () => {
    const firstTarget = await makeGitTarget('changed-plan-tree', { plan: planContent() });
    const artifact = await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeGitTarget('changed-plan-tree', { plan: planContent('complete', 'planned') });
    assert.equal(target, firstTarget, 'different authored plans may reuse only the pristine fixture controller');
    const changedArtifact = await certify(target);
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions + 1);
    assert.notEqual(changedArtifact, artifact, 'a distinct clean Git tree must not reuse the prior artifact');
    assert.notDeepEqual(verificationFiles(target), initialVerificationFiles, 'a distinct clean Git tree must run certification afresh');
  });
});
