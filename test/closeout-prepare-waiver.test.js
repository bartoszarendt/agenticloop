/** Closeout compatibility-waiver and marker-state tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { provisionOperatorActivationKey, signOperatorActivationPayload } from '../src/activation-trust.js';
import { canonicalSha256 } from '../src/canonical-json.js';
import {
  legacyWaiverPath,
  legacyWaiverSignaturePayload,
  RETIRED_WAIVER_SCOPE_DIAGNOSTIC,
} from '../src/closeout-waiver.js';
import { createCloseoutCliFixture } from './helpers/closeout-cli-fixture.js';
import { git as fixtureGit } from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

const fixture = createCloseoutCliFixture();
const {
  PROJECT_MAP, makeGitTarget, makeVerifiedGitTarget, writeTask, commitAll,
  wireReport, closeout, audit, certify,
} = fixture;
let tmpDir;
before(() => { tmpDir = fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('closeout prepare', () => {
  it('fails closed before packet creation when audit is disabled but no candidate exists', async () => {
    const target = makeGitTarget('optout-no-candidate');
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled'),
      'utf-8'
    );
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(result.status, 2);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.kind, 'agenticloop.validation-result');
    assert.equal(refusal.diagnostics[0].code, 'cli.usage');
    assert.equal(refusal.mutationOccurred, false);
    assert.equal(refusal.safeToRetry, true);
  });

  it('uses an authentic historical waiver through ordinary public prepare without retiring return evidence', async () => {
    const target = makeGitTarget('historical-waiver-public');
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled'),
      'utf8'
    );
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'prepare historical waiver fixture');

    // Create the current activation-only record through the public command so
    // its task binding, path, repository identity, and operator key are genuine.
    const created = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json',
    ], target);
    assert.equal(created.status, 1, `${created.stdout}${created.stderr}`);

    const waiverFile = join(target, legacyWaiverPath('milestone:M00'));
    const historical = JSON.parse(readFileSync(waiverFile, 'utf8'));
    historical.waivedDimensions = ['activation_evidence_absent', 'return_evidence_absent'];
    historical.statement = `Compatibility exception for missing evidence only: ${historical.waivedDimensions.join(', ')}; ` +
      `repository ${historical.repositoryIdentity}; work unit ${historical.workUnit}; reason: ${historical.reason}`;
    const { digest: ignoredDigest, authentication: ignoredAuthentication, ...projection } = historical;
    historical.digest = `sha256:agenticloop.legacy-unactivated-waiver.v1:${canonicalSha256(projection)}`;
    const provisioned = provisionOperatorActivationKey(target, {
      operatorActivationRoot: join(tmpDir, 'operator-activation'),
    });
    assert.equal(provisioned.ok, true, provisioned.errors.join('; '));
    historical.authentication = signOperatorActivationPayload(legacyWaiverSignaturePayload(historical), {
      key: provisioned.key,
      repositoryIdentity: historical.repositoryIdentity,
    });
    writeFileSync(waiverFile, `${JSON.stringify(historical, null, 2)}\n`, 'utf8');
    const originalBytes = readFileSync(waiverFile, 'utf8');

    // No --legacy-unactivated option: this exercises the normal resolver.
    const prepared = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--json', '--target', target,
    ], { operatorActivationRoot: join(tmpDir, 'operator-activation') });
    assert.equal(prepared.status, 1, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(prepared.stdout);
    assert.equal(packet.assurance.tasks[0].compatibility_waived, true);
    assert.deepEqual(packet.assurance.compatibility_waiver.waivedDimensions, [
      'activation_evidence_absent', 'return_evidence_absent',
    ]);
    assert.deepEqual(
      packet.assurance.compatibility_diagnostics.map(item => item.code),
      [RETIRED_WAIVER_SCOPE_DIAGNOSTIC]
    );
    assert.ok(packet.reasons.some(item => item.category === 'return_evidence_absent'));
    assert.ok(!packet.reasons.some(item => item.category === 'activation_evidence_absent'));
    assert.equal(readFileSync(waiverFile, 'utf8'), originalBytes, 'the signed historical record stays byte-identical');

    const human = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--target', target,
    ], { operatorActivationRoot: join(tmpDir, 'operator-activation') });
    assert.equal(human.status, 1, `${human.stdout}${human.stderr}`);
    assert.ok(human.stdout.includes(`compatibility diagnostic [${RETIRED_WAIVER_SCOPE_DIAGNOSTIC}]`));
    assert.equal(readFileSync(waiverFile, 'utf8'), originalBytes, 'human output also leaves the source record unchanged');
  });

  it('marks undisposed non-blocking findings completion-ineligible with a repair', async () => {
    const target = await makeVerifiedGitTarget('undisposed');
    const artifact = await certify(target, { reportOverrides: {
      findings: [{
        id: 'A-01', severity: 'low', blocking: false,
        claim: 'docs drift', evidenceRefs: 'docs/x.md:1',
        consequence: 'confusion', requiredOutcome: 'docs match', verificationRequired: 're-read',
      }],
    } });

    const blocked = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(blocked.status, 1);
    const packet = JSON.parse(blocked.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.ok(packet.reasons.some(item => item.category === 'undisposed_findings' && /audit disposition/.test(item.repair)));

    // Certification may exist; terminal closeout waits for the disposition.
    const disposed = await audit([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-01',
      '--type', 'follow_up', '--ref', 'T-009', '--note', 'tracked separately',
    ], target);
    assert.equal(disposed.status, 0, `${disposed.stdout}${disposed.stderr}`);
    fixtureGit(target, ['update-index', '--assume-unchanged', '.agenticloop/audits/AUD-001.md']);
    const eligible = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(eligible.status, 0, `${eligible.stdout}${eligible.stderr}`);
  });
});

describe('marker states', () => {
  it('recommends needs_context when the audit awaits a human decision', async () => {
    const target = makeGitTarget('needs-context');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'integrate');
    assert.equal((await audit([
      'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    commitAll(target, 'record audit');
    const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
    writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'], {
      verdict: 'needs_human_decision',
    })), 'utf-8');
    assert.equal((await audit(['report', 'AUD-001', '--file', reportPath], target)).status, 0);
    const prepare = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(prepare.status, 1);
    assert.equal(JSON.parse(prepare.stdout).recommended_status, 'needs_context');
  });

  it('recommends blocked when the audit budget is exhausted', async () => {
    const target = makeGitTarget('exhausted');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'integrate');
    assert.equal((await audit([
      'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    commitAll(target, 'record audit');
    for (let index = 0; index < 3; index++) {
      const reportPath = join(target, '.agenticloop', 'tmp', `run-${index}.json`);
      writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'], {
        verdict: 'needs_remediation',
      })), 'utf-8');
      const reported = await audit(['report', 'AUD-001', '--file', reportPath], target);
      assert.equal(reported.status, 0, `${reported.stdout}${reported.stderr}`);
    }
    const prepare = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(prepare.status, 1);
    assert.equal(JSON.parse(prepare.stdout).recommended_status, 'blocked');
  });
});
