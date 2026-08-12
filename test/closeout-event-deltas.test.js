/** Safe append-only closeout event delta tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createCloseoutWorkflowDeltaFixture } from './helpers/closeout-workflow-delta-fixture.js';

const fixture = createCloseoutWorkflowDeltaFixture();
const { makeGitTarget, commitAll, certify, cacheStats, releaseFixtures, recordCompleteMarker, statusState, closeoutEvent } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

function verificationFiles(target) {
  return readdirSync(join(target, '.agenticloop', 'returns', 'verifications')).sort();
}

describe('append-only closeout event deltas', () => {
  it('permits a schema-valid append-only task.closed event in the applicable log', async () => {
    const target = await makeGitTarget('event-append');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), `${closeoutEvent('T-001')}\n`, 'utf-8');
    commitAll(target, 'record closeout event');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
    assert.equal(state.exit, 0, JSON.stringify(state));
  });

  it('permits appending to a log that already existed at certification', async () => {
    const target = await makeGitTarget('event-append-existing');
    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), '', 'utf-8');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    const secondEvent = {
      ...JSON.parse(closeoutEvent('T-001')),
      event_id: '33333333-3333-4333-8333-333333333333',
    };
    writeFileSync(
      join(target, '.agenticloop', 'logs', 'T-001.jsonl'),
      `${closeoutEvent('T-001')}\n${JSON.stringify(secondEvent)}\n`,
      'utf-8'
    );
    commitAll(target, 'append closeout events');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
  });

  it('an event log for a non-covered task is not an applicable log and remains drift', async () => {
    const target = await makeGitTarget('event-foreign');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-099.jsonl'), `${closeoutEvent('T-099')}\n`, 'utf-8');
    commitAll(target, 'foreign event log');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete');
    assert.ok(state.reasons.some(message => /T-099/.test(message)), JSON.stringify(state));
  });

  it('reuses only the exact matching workflow-delta certification checkpoint', async () => {
    const firstTarget = await makeGitTarget('matching-workflow-delta');
    const artifact = await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeGitTarget('matching-workflow-delta');
    assert.equal(await certify(target), artifact);
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits + 1);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions);
    assert.match(afterSecond.lastRestoredCheckpoint, /^certified:/);
    assert.deepEqual(verificationFiles(target), initialVerificationFiles);
  });

  it('recertifies when activation state changes without Git tree drift', async () => {
    const firstTarget = await makeGitTarget('changed-workflow-activation');
    await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeGitTarget('changed-workflow-activation');
    const activationRoot = join(dirname(target), 'operator-activation');
    mkdirSync(activationRoot, { recursive: true });
    const marker = join(activationRoot, 'pre-certification-mutation.json');
    writeFileSync(marker, '{}\n', 'utf8');
    await certify(target);
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions + 1);
    assert.equal(existsSync(marker), true, 'a cache restore must not discard activation state');
    assert.notDeepEqual(verificationFiles(target), initialVerificationFiles, 'changed activation state must run certification afresh');
  });
});
