/** Closeout record retry tests for the files backend. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCloseoutMarkers } from '../src/closeout-contract.js';
import { createCloseoutCliFixture } from './helpers/closeout-cli-fixture.js';
import { git as fixtureGit } from './helpers/dispatch-fixture.js';

const fixture = createCloseoutCliFixture();
const { makeVerifiedGitTarget, commitAll, closeout, certify } = fixture;
let tmpDir;
before(() => { tmpDir = fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('closeout record and status', () => {
  it('does not append a third marker when a packet encounters contradictory current markers', async () => {
    const target = await makeVerifiedGitTarget('multiple-record');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-001.md');
    writeFileSync(
      carrierFile,
      `${readFileSync(carrierFile, 'utf-8')}\nAGENT_CLOSEOUT_STATUS: complete\n\nAGENT_CLOSEOUT_STATUS: blocked\n`,
      'utf-8'
    );
    const before = readFileSync(carrierFile, 'utf-8');
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 1);
    assert.equal(readFileSync(carrierFile, 'utf-8'), before);
    assert.equal(parseCloseoutMarkers(before).length, 2);
  });

  it('only writes transient packets inside .agenticloop/tmp without overwriting other files', async () => {
    const target = await makeVerifiedGitTarget('output-safety');
    const readme = join(target, 'README.md');
    writeFileSync(readme, 'do not overwrite\n', 'utf-8');
    commitAll(target, 'add protected README');
    const artifact = await certify(target);
    const readmeResult = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', 'README.md',
    ], target);
    assert.equal(readmeResult.status, 1);
    assert.equal(readFileSync(readme, 'utf-8'), 'do not overwrite\n');

    const external = join(tmpDir, 'outside-closeout.json');
    const externalResult = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', external,
    ], target);
    assert.equal(externalResult.status, 1);
    assert.equal(existsSync(external), false);

    const packetPath = join(target, '.agenticloop', 'tmp', 'path with spaces', 'packet.json');
    const valid = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target);
    assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
    assert.equal(existsSync(packetPath), true);
  });

  it('treats a same-packet files retry as idempotent success without rewriting the marker', async () => {
    const target = await makeVerifiedGitTarget('retry-idempotent');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    assert.equal((await closeout(['record', '--packet', packetPath, '--yes'], target)).status, 0);
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-001.md');
    const afterFirst = readFileSync(carrierFile, 'utf-8');
    fixtureGit(target, ['update-index', '--assume-unchanged', '.agenticloop/tasks/T-001.md']);

    // The same applied packet retries cleanly: exit 0, no marker rewrite.
    const retry = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(retry.status, 0, `${retry.stdout}${retry.stderr}`);
    assert.match(retry.stdout, /already current/);
    assert.equal(readFileSync(carrierFile, 'utf-8'), afterFirst);

    // Unrelated drift after publication still fails closed.
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    commitAll(target, 'post-publication drift');
    const drifted = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /stale packet/);
    assert.equal(readFileSync(carrierFile, 'utf-8'), afterFirst);
  });

  it('a same-packet retry fails closed on contradictory current markers', async () => {
    const target = await makeVerifiedGitTarget('retry-contradictory');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    assert.equal((await closeout(['record', '--packet', packetPath, '--yes'], target)).status, 0);
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-001.md');
    writeFileSync(
      carrierFile,
      `${readFileSync(carrierFile, 'utf-8')}\nAGENT_CLOSEOUT_STATUS: blocked\n`,
      'utf-8'
    );
    commitAll(target, 'contradictory marker');
    const retry = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(retry.status, 1);
  });
});
