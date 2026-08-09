import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createLegacyUnactivatedWaiver,
  legacyWaiverPath,
  verifyLegacyUnactivatedWaiver,
} from '../src/closeout-waiver.js';
import {
  createActivationSignatureVerifier,
  provisionOperatorActivationKey,
} from '../src/activation-trust.js';

let temp;
let target;
let key;
let verify;
const tasks = [{ taskId: 'T-001', taskContractDigest: `sha256:v1:${'a'.repeat(64)}` }];

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
  it('binds both explicit missing-evidence scopes and its canonical path', () => {
    const record = createLegacyUnactivatedWaiver({
      target, workUnit: 'milestone:M00', tasks, reason: 'Historical work', key,
    });
    const checked = verifyLegacyUnactivatedWaiver(record, {
      target, workUnit: 'milestone:M00', tasks, verify,
      path: legacyWaiverPath('milestone:M00'),
    });
    assert.equal(checked.ok, true, checked.errors.join('; '));
    assert.deepEqual(record.waivedDimensions, ['activation_evidence_absent', 'return_evidence_absent']);
    assert.match(record.statement, /activation_evidence_absent, return_evidence_absent/);
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
});
