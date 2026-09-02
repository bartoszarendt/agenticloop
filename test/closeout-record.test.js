/** Closeout record and status tests for the files backend. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { serializeValidationResult } from '../src/result-envelope.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';
import { createCloseoutCliFixture } from './helpers/closeout-cli-fixture.js';
import { git as fixtureGit } from './helpers/dispatch-fixture.js';

const fixture = createCloseoutCliFixture();
const { makeVerifiedGitTarget, commitAll, closeout, certify, restore } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('closeout record and status', () => {
  it('runs fresh certification for a clean different HEAD with the same input tree', async () => {
    const target = await makeVerifiedGitTarget('certification-cache-head', {
      checkpointLabel: 'pre-certification',
    });
    const firstInputHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    const inputTree = fixtureGit(target, ['rev-parse', 'HEAD^{tree}']);
    const firstArtifact = await certify(target);

    restore(target, 'pre-certification');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    fixtureGit(target, ['commit', '--allow-empty', '-m', 'different certification input history']);

    assert.equal(fixtureGit(target, ['status', '--porcelain', '--untracked-files=all']), '');
    assert.equal(fixtureGit(target, ['rev-parse', 'HEAD^{tree}']), inputTree);
    assert.notEqual(fixtureGit(target, ['rev-parse', 'HEAD']), firstInputHead);

    const secondArtifact = await certify(target);
    assert.notEqual(
      secondArtifact,
      firstArtifact,
      'a distinct clean input HEAD must run fresh certification rather than restore the prior checkpoint'
    );
  });

  it('records a complete marker and verifies it after the packet is deleted', async () => {
    const target = await makeVerifiedGitTarget('lifecycle');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--covered-tasks', 'T-001', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);

    // dry-run mutates nothing.
    const carrierBefore = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8');
    const dry = await closeout(['record', '--packet', packetPath, '--dry-run'], target);
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.match(dry.stdout, /dry run/);
    assert.equal(readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8'), carrierBefore);

    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const carrierAfter = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8');
    assert.ok(carrierAfter.includes('AGENT_CLOSEOUT_STATUS: complete'));
    assert.ok(carrierAfter.includes(`AGENT_CLOSEOUT_WORK_UNIT: milestone:M00`));
    assert.ok(carrierAfter.includes('AGENT_CLOSEOUT_AUDIT_ASSURANCE: host_receipt'));
    assert.ok(carrierAfter.includes('AGENT_CLOSEOUT_AUDIT_PRODUCER_AUTHENTICATED: true'));
    fixtureGit(target, ['update-index', '--assume-unchanged', '.agenticloop/tasks/T-001.md']);

    // Delete the transient packet: provenance must still reconstruct.
    unlinkSync(packetPath);
    const status = await closeout(['status', '--work-unit', 'milestone:M00'], target);
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.match(status.stdout, /complete \(current\)/);

    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-001.md'),
      `${carrierAfter}\nHost-local note after closeout.\n`,
      'utf-8'
    );
    const stale = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(stale.status, 1);
    const staleResult = JSON.parse(stale.stdout);
    assert.equal(staleResult.state, 'stale');
    assert.equal(staleResult.code, 'closeout.marker.stale');
    assert.equal(staleResult.resume_command, 'npx agenticloop closeout prepare --work-unit milestone:M00');
    assert.equal(staleResult.diagnostics[0].owner, 'engineer');
    assert.equal(staleResult.diagnostics[0].escalationOwner, null);
    assert.match(staleResult.diagnostics[0].nextAction, /closeout prepare/);
    assert.match(staleResult.firstSafeRepair, /closeout prepare/);
    assert.equal(
      stale.stdout.trim(),
      serializeValidationResult(staleResult, { capabilities: getProjectRoleCapabilities(target) })
    );
  });

  it('rejects a stale packet after task, audit, or marker state changed', async () => {
    const target = await makeVerifiedGitTarget('stale');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--covered-tasks', 'T-001', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);

    // Product drift after preparation makes the packet stale.
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    commitAll(target, 'post-certification product change');
    const stale = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(stale.status, 1, `${stale.stdout}|${stale.stderr}`);
    assert.match(stale.stderr, /stale packet/);
    assert.ok(!readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8').includes('AGENT_CLOSEOUT_STATUS'));
  });

  it('preserves a concurrent carrier edit and does not close tasks when marker publication loses its precondition', async () => {
    const target = await makeVerifiedGitTarget('marker-publication-race');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--covered-tasks', 'T-001', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const carrierPath = join(target, '.agenticloop', 'tasks', 'T-001.md');
    const concurrent = `${readFileSync(carrierPath, 'utf8')}\nConcurrent operator note.\n`;
    const recorded = await closeout(
      ['record', '--packet', packetPath, '--yes'],
      target,
      { fsMutationOptions: { beforeWrite: () => writeFileSync(carrierPath, concurrent, 'utf8') } }
    );
    assert.equal(recorded.status, 1);
    assert.equal(readFileSync(carrierPath, 'utf8'), concurrent);
    assert.doesNotMatch(concurrent, /AGENT_CLOSEOUT_GATE:/);
    for (const taskId of ['T-001']) {
      assert.match(readFileSync(join(target, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8'), /status: accepted/);
    }
  });
});
