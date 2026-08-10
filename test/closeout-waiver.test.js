import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createLegacyUnactivatedWaiver,
  legacyWaiverPath,
  legacyWaiverSignaturePayload,
  RETIRED_WAIVER_SCOPE_DIAGNOSTIC,
  verifyLegacyUnactivatedWaiver,
} from '../src/closeout-waiver.js';
import {
  createActivationSignatureVerifier,
  provisionOperatorActivationKey,
  signOperatorActivationPayload,
} from '../src/activation-trust.js';
import { canonicalSha256 } from '../src/canonical-json.js';

let temp;
let target;
let key;
let verify;
const tasks = [{ taskId: 'T-001', taskContractDigest: `sha256:v1:${'a'.repeat(64)}` }];

function historicalTwoScopeWaiver(options = {}) {
  const record = structuredClone(createLegacyUnactivatedWaiver({
    target, workUnit: 'milestone:M00', tasks, reason: 'Historical work', key,
    ...options,
  }));
  record.waivedDimensions = ['activation_evidence_absent', 'return_evidence_absent'];
  record.statement = `Compatibility exception for missing evidence only: ${record.waivedDimensions.join(', ')}; ` +
    `repository ${record.repositoryIdentity}; work unit ${record.workUnit}; reason: ${record.reason}`;
  const { digest: ignoredDigest, authentication: ignoredAuthentication, ...projection } = record;
  record.digest = `sha256:agenticloop.legacy-unactivated-waiver.v1:${canonicalSha256(projection)}`;
  record.authentication = signOperatorActivationPayload(legacyWaiverSignaturePayload(record), {
    key, repositoryIdentity: record.repositoryIdentity,
  });
  return record;
}

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'al-closeout-waiver-'));
  target = join(temp, 'target');
  const provisioned = provisionOperatorActivationKey(target, { operatorActivationRoot: join(temp, 'operator') });
  assert.equal(provisioned.ok, true, provisioned.errors.join('; '));
  key = provisioned.key;
  verify = createActivationSignatureVerifier({ operatorKey: key });
});
after(() => rmSync(temp, { recursive: true, force: true }));

describe('legacy missing-evidence waiver', () => {
  it('binds only historical activation compatibility and its canonical path', () => {
    const record = createLegacyUnactivatedWaiver({
      target, workUnit: 'milestone:M00', tasks, reason: 'Historical work', key,
    });
    const checked = verifyLegacyUnactivatedWaiver(record, {
      target, workUnit: 'milestone:M00', tasks, verify,
      path: legacyWaiverPath('milestone:M00'),
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.deepEqual(record.waivedDimensions, ['activation_evidence_absent']);
    assert.match(record.statement, /activation_evidence_absent/);
    assert.doesNotMatch(record.statement, /return_evidence_absent/);
  });

  it('rejects changed contracts, noncanonical paths, unknown fields, and malformed reasons', () => {
    const record = createLegacyUnactivatedWaiver({
      target, workUnit: 'milestone:M00', tasks, reason: 'Historical work', key,
    });
    const contexts = [
      { tasks: [{ ...tasks[0], taskContractDigest: `sha256:v1:${'b'.repeat(64)}` }] },
      { path: legacyWaiverPath('milestone:OTHER') },
    ];
    for (const patch of contexts) {
      assert.equal(verifyLegacyUnactivatedWaiver(record, {
        target, workUnit: 'milestone:M00', tasks, verify,
        path: legacyWaiverPath('milestone:M00'), ...patch,
      }).ok, false);
    }
    assert.equal(verifyLegacyUnactivatedWaiver({ ...record, unknown: true }, {
      target, workUnit: 'milestone:M00', tasks, verify,
    }).ok, false);
    assert.throws(() => createLegacyUnactivatedWaiver({
      target, workUnit: 'milestone:M00', tasks, reason: '  not normalized  ', key,
    }), /normalized/);
  });

  it('rejects future issuance and excessive TTL', () => {
    assert.throws(() => createLegacyUnactivatedWaiver({
      target, workUnit: 'milestone:M00', tasks, reason: 'Historical work', key, ttlSeconds: 3601,
    }), /TTL/);
    const issuedAt = new Date(Date.now() + 60_000).toISOString();
    const record = createLegacyUnactivatedWaiver({
      target, workUnit: 'milestone:M00', tasks, reason: 'Historical work', key, issuedAt,
    });
    assert.equal(verifyLegacyUnactivatedWaiver(record, {
      target, workUnit: 'milestone:M00', tasks, verify,
    }).ok, false);
  });

  it('verifies an authentic historical two-scope record but projects activation-only behavior', () => {
    const record = historicalTwoScopeWaiver();
    const checked = verifyLegacyUnactivatedWaiver(record, {
      target, workUnit: 'milestone:M00', tasks, verify,
      path: legacyWaiverPath('milestone:M00'),
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.strictEqual(checked.record, record, 'the originally signed record stays unchanged');
    assert.deepEqual(checked.effectiveWaiver.waivedDimensions, ['activation_evidence_absent']);
    assert.equal(checked.diagnostics[0]?.code, RETIRED_WAIVER_SCOPE_DIAGNOSTIC);
    assert.match(checked.diagnostics[0]?.message ?? '', /dispatch consumption.*verified-return evidence remain mandatory/);
  });

  it('rejects tampered, expired, wrong-target, and wrong-generation historical records', () => {
    const authentic = historicalTwoScopeWaiver();
    const tampered = structuredClone(authentic);
    tampered.reason = 'Altered after signing';
    assert.equal(verifyLegacyUnactivatedWaiver(tampered, {
      target, workUnit: 'milestone:M00', tasks, verify,
    }).ok, false);

    const expired = historicalTwoScopeWaiver({
      issuedAt: new Date(Date.now() - 7_200_000).toISOString(), ttlSeconds: 3600,
    });
    assert.equal(verifyLegacyUnactivatedWaiver(expired, {
      target, workUnit: 'milestone:M00', tasks, verify,
    }).ok, false);

    assert.equal(verifyLegacyUnactivatedWaiver(authentic, {
      target: join(temp, 'another-target'), workUnit: 'milestone:M00', tasks, verify,
    }).ok, false);
    assert.equal(verifyLegacyUnactivatedWaiver(authentic, {
      target, workUnit: 'milestone:M00',
      tasks: [{ ...tasks[0], taskContractDigest: `sha256:v1:${'b'.repeat(64)}` }], verify,
    }).ok, false);
  });
});
