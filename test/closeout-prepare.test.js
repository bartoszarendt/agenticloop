/** Closeout prepare tests for the files backend. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createCloseoutCliFixture } from './helpers/closeout-cli-fixture.js';

const fixture = createCloseoutCliFixture();
const { makeGitTarget, makeVerifiedGitTarget, writeTask, commitAll, closeout, certify, cacheStats, releaseFixtures } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

function verificationFiles(target) {
  return readdirSync(join(target, '.agenticloop', 'returns', 'verifications')).sort();
}

describe('closeout prepare', () => {
  it('refuses preparation without an independently supplied candidate', async () => {
    const target = makeGitTarget('candidate-required');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001', '--json',
    ], target);
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, 'agenticloop.validation-result');
    assert.equal(payload.diagnostics[0].code, 'cli.usage');
    assert.equal(payload.mutationOccurred, false);
    assert.equal(payload.safeToRetry, true);
    assert.match(payload.diagnostics[0].message, /cannot supply the expected candidate/);
  });

  it('rejects noncanonical, abbreviated, and nonexistent closeout candidates', async () => {
    const target = makeGitTarget('candidate-invalid');
    for (const artifact of ['release:not-a-commit', 'commit:abc1234', `commit:${'f'.repeat(40)}`]) {
      const result = await closeout([
        'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
        '--artifact', artifact, '--json',
      ], target);
      assert.notEqual(result.status, 0, artifact);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.kind, 'agenticloop.validation-result', artifact);
      assert.equal(payload.diagnostics[0].code, 'cli.usage', artifact);
      assert.equal(payload.mutationOccurred, false, artifact);
      assert.equal(payload.safeToRetry, true, artifact);
    }
  });

  it('emits a completion-eligible packet for a certified work unit', async () => {
    const target = await makeVerifiedGitTarget('eligible');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--covered-tasks', 'T-001', '--output', packetPath,
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.completion_eligible, true, JSON.stringify(packet.reasons));
    assert.equal(packet.recommended_status, 'complete');
    assert.equal(packet.publishable, true);
    assert.match(packet.digest, /^sha256:[0-9a-f]{64}$/);
  });

  it('completes standard-mode audit with a session-reported Auditor return', async () => {
    const target = await makeVerifiedGitTarget('standard-auditor-return');
    const artifact = await certify(target, {
      reportOverrides: {
        invocation: {
          mode: 'host_subagent',
          reference: 'fresh-standard-auditor',
          provenance: 'asserted',
        },
      },
      auditOptions: { auditProvenanceVerifier: null },
    });
    const packetPath = join(target, '.agenticloop', 'tmp', 'standard-packet.json');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--covered-tasks', 'T-001', '--output', packetPath,
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.audit.return_assurance, 'session_reported');
    assert.equal(packet.audit.producer_authenticated, false);
    assert.equal(packet.completion_eligible, true, JSON.stringify(packet.reasons));
  });

  it('reports audit due and refuses completion when no audit exists', async () => {
    const target = makeGitTarget('due');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'work');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--covered-tasks', 'T-001', '--json',
    ], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.equal(packet.recommended_status, 'follow_up_required');
    assert.ok(packet.reasons.some(item => item.gate === 'audit_gate' && item.category === 'audit_missing'));
    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(status.status, 1);
    assert.ok(status.stdout, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'missing');
  });

  it('never completes with an explicit audit opt-out but reports it truthfully', async () => {
    const target = await makeVerifiedGitTarget('optout', { auditEnabled: false });
    const artifact = await certify(target, { skipAudit: true });
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--json',
    ], target);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.audit_opt_out, true);
    assert.equal(packet.audit, null);
    // The opt-out is visible; closeout never claims certification.
    assert.equal(packet.completion_eligible, true, JSON.stringify(packet.reasons));
    assert.equal(packet.recommended_status, 'complete');
  });

  it('still rejects product-tree drift when work-unit audit is disabled', async () => {
    const target = await makeVerifiedGitTarget('optout-product-drift', { auditEnabled: false });
    await certify(target, { skipAudit: true });
    writeFileSync(join(target, 'src', 'existing.js'), 'export const changedAfterReturn = true;\n', 'utf8');
    const candidate = commitAll(target, 'different product candidate');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', candidate, '--json',
    ], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.gate === 'product_tree'));
  });

  it('does not restore certification over a changed activation path', async () => {
    const firstTarget = await makeVerifiedGitTarget('fingerprinted-certification');
    await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeVerifiedGitTarget('fingerprinted-certification');
    const activationRoot = join(dirname(target), 'operator-activation');
    mkdirSync(activationRoot, { recursive: true });
    const mutation = join(activationRoot, 'pre-certification-mutation.json');
    writeFileSync(mutation, '{}\n', 'utf8');

    await certify(target);
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions + 1);
    assert.equal(existsSync(mutation), true, 'a cache restore must not discard pre-certification external state');
    assert.notDeepEqual(verificationFiles(target), initialVerificationFiles, 'changed activation state must run certification afresh');
  });

  it('reuses the matching certified checkpoint with its exact certified artifact', async () => {
    const firstTarget = await makeVerifiedGitTarget('matching-certified-checkpoint');
    const artifact = await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeVerifiedGitTarget('matching-certified-checkpoint');
    assert.equal(await certify(target), artifact);
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits + 1);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions);
    assert.deepEqual(verificationFiles(target), initialVerificationFiles, 'matching input must restore the exact checkpoint');
  });

  it('recertifies when material certification options differ', async () => {
    const firstTarget = await makeVerifiedGitTarget('material-certification-options');
    await certify(firstTarget);
    const afterFirst = cacheStats();
    const initialVerificationFiles = verificationFiles(firstTarget);
    releaseFixtures();

    const target = await makeVerifiedGitTarget('material-certification-options');
    const artifact = await certify(target, {
      reportOverrides: {
        invocation: { mode: 'host_subagent', reference: 'material-option', provenance: 'asserted' },
      },
      auditOptions: { auditProvenanceVerifier: null },
    });
    const afterSecond = cacheStats();
    assert.equal(afterSecond.cacheHits, afterFirst.cacheHits);
    assert.equal(afterSecond.certificationExecutions, afterFirst.certificationExecutions + 1);
    assert.notDeepEqual(verificationFiles(target), initialVerificationFiles, 'different harness options must run certification afresh');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json',
    ], target);
    assert.equal(JSON.parse(result.stdout).audit.return_assurance, 'session_reported');
  });

});
