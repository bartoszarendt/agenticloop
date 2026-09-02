/** Closeout drift and marker correction tests for the files backend. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCloseoutCliFixture } from './helpers/closeout-cli-fixture.js';
import { renderCloseoutMarker } from '../src/closeout-contract.js';

const fixture = createCloseoutCliFixture();
const { makeGitTarget, makeVerifiedGitTarget, writeTask, commitAll, closeout, certify } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('closeout record and status', () => {
  it('detects product drift and names the changed path', async () => {
    const target = await makeVerifiedGitTarget('drift');
    const artifact = await certify(target);
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    commitAll(target, 'product change after certification');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.category === 'product_drift' && /app\.js/.test(item.message)));
  });

  it('treats unknown and untracked paths as drift (deny-by-default)', async () => {
    const target = await makeVerifiedGitTarget('untracked');
    const artifact = await certify(target);
    writeFileSync(join(target, 'stray-notes.txt'), 'not tracked\n', 'utf-8');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.category === 'product_drift' && /stray-notes\.txt/.test(item.message)));
  });

  it('corrects a premature complete marker to follow_up_required and supersedes it', async () => {
    const target = makeGitTarget('premature');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    writeTask(target, 'T-002', 'accepted', 'milestone:M00');
    // Premature freehand marker: complete without any audit.
    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-002.md'),
      readFileSync(join(target, '.agenticloop', 'tasks', 'T-002.md'), 'utf-8') +
        '\nAGENT_CLOSEOUT_STATUS: complete\n',
      'utf-8'
    );
    const artifact = commitAll(target, 'work plus premature marker');
    const prepare = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--covered-tasks', 'T-001,T-002', '--json',
    ], target);
    assert.equal(prepare.status, 1);
    const packet = JSON.parse(prepare.stdout);
    assert.equal(packet.recommended_status, 'follow_up_required', JSON.stringify(packet.reasons));
    assert.equal(packet.completion_eligible, false);
    assert.equal(packet.publishable, true, 'a truthful correction packet is publishable');

    const packetPath = join(target, '.agenticloop', 'tmp', 'correction.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--output', packetPath,
      '--artifact', artifact, '--covered-tasks', 'T-001,T-002',
    ], target)).status, 1);
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const carrier = readFileSync(join(target, '.agenticloop', 'tasks', 'T-002.md'), 'utf-8');
    assert.ok(carrier.includes('AGENT_CLOSEOUT_STATUS: follow_up_required'));
    assert.ok(carrier.includes('AGENT_CLOSEOUT_SUPERSEDES'));
    // The legacy marker stays recognizable as history.
    assert.ok(carrier.includes('AGENT_CLOSEOUT_STATUS: complete'));
    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(JSON.parse(status.stdout).state, 'follow_up_required');
  });

  it('fails closed on multiple unsuperseded current markers', async () => {
    const target = await makeVerifiedGitTarget('multiple-markers');
    const artifact = await certify(target);
    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-001.md'),
      readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8') +
        `\n${renderCloseoutMarker({
          status: 'complete', workUnit: 'milestone:M00', coveredTasks: ['T-001'], artifact,
          auditRef: 'AUD-001/run:1', auditAssurance: 'host_receipt', auditProducerAuthenticated: true,
          gateDigest: `sha256:${'a'.repeat(64)}`,
        })}\n\n${renderCloseoutMarker({
          status: 'blocked', workUnit: 'milestone:M00', coveredTasks: ['T-001'], artifact,
          auditRef: 'AUD-001/run:1', auditAssurance: 'host_receipt', auditProducerAuthenticated: true,
          gateDigest: `sha256:${'b'.repeat(64)}`,
        })}\n`,
      'utf-8'
    );
    commitAll(target, 'conflicting markers');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /multiple unsuperseded/);
    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(JSON.parse(status.stdout).state, 'contradictory');
  });
});
