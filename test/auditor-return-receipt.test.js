import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AUDITOR_RECEIPT_MAX_VALIDITY_MS,
  createAuditorReturnReceipt,
  loadAuditorReturnReceiptVerifier,
  verifyAuditorReturnReceipt,
} from '../src/auditor-return-receipt.js';
import { auditorReturnReportDigest } from '../src/audit-report-schema.js';
import { canonicalJson } from '../src/canonical-json.js';
import { createTestHostTrust, protectedHostBoundary, writeHostTrustStore } from './helpers/host-trust-fixture.js';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SIGNATURE_PREFIX = 'ed25519:';

/**
 * Corrupt a signature's payload bytes rather than its encoding, so the refusal
 * proves Ed25519 verification failed and not that the signature grammar
 * rejected malformed text.
 */
function corruptSignatureBody(signature) {
  const body = signature.slice(SIGNATURE_PREFIX.length);
  const index = BASE64_ALPHABET.indexOf(body[0]);
  return `${SIGNATURE_PREFIX}${BASE64_ALPHABET[(index + 1) % 64]}${body.slice(1)}`;
}

let root;
let target;
let operatorRoot;
let trust;
let report;
let context;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'al-auditor-receipt-'));
  target = join(root, 'target');
  operatorRoot = join(root, 'operator');
  mkdirSync(target, { recursive: true });
  mkdirSync(operatorRoot, { recursive: true });
  trust = createTestHostTrust({ target });
  writeHostTrustStore(operatorRoot, trust);
  report = {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact: `commit:${'a'.repeat(40)}`,
    covered_tasks: ['T-001', 'T-002'],
    invocation: { mode: 'host_subagent', reference: 'audit-invocation-1', provenance: 'verified', receipt: null },
    perspectives: {
      outcome: 'Outcome.', completeness: 'Complete.', integration_coherence: 'Coherent.',
      engineering_quality: 'Quality.', verification: 'Verified.', risk: 'Risk checked.',
    },
    assessment: 'Consolidated assessment.', evidence_checked: 'npm test passed.', verdict: 'certified', findings: [],
  };
  context = {
    target,
    role: 'auditor',
    invocationReference: report.invocation.reference,
    invocationMode: report.invocation.mode,
    workUnit: 'milestone:M00',
    candidateArtifact: report.artifact,
    coveredTasks: report.covered_tasks,
    reportDigest: auditorReturnReportDigest(report),
    now: NOW,
  };
});

after(() => rmSync(root, { recursive: true, force: true }));

function receipt(overrides = {}) {
  return createAuditorReturnReceipt({
    receiptId: 'auditor-return-1',
    adapterId: trust.adapterId,
    keyId: trust.keyId,
    targetRepository: trust.repositoryIdentity,
    invocationReference: context.invocationReference,
    invocationMode: context.invocationMode,
    workUnit: context.workUnit,
    candidateArtifact: context.candidateArtifact,
    coveredTasks: context.coveredTasks,
    reportDigest: context.reportDigest,
    issuedAt: '2026-08-08T11:59:00.000Z',
    expiresAt: '2026-08-08T12:01:00.000Z',
    ...overrides,
  }, trust.privateKey);
}

describe('protected Auditor return receipt', () => {
  it('loads the operator-pinned production verifier only through the protected boundary', () => {
    const denied = loadAuditorReturnReceiptVerifier({ target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId });
    assert.equal(denied.ok, false);
    assert.equal(denied.verifier, null);

    const loaded = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId, now: NOW,
      protectedBoundary: protectedHostBoundary(trust),
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('; '));
    const result = loaded.verifier({ ...context, receipt: canonicalJson(receipt()) });
    assert.equal(result.verified, true, result.error);
    assert.equal(result.reportDigest, context.reportDigest);
    assert.equal(result.receiptId, 'auditor-return-1');

    const promoted = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId, now: NOW,
      protectedBoundary: () => true,
    });
    assert.equal(promoted.ok, false);
    assert.equal(promoted.verifier, null);
  });

  it('authenticates before classifying forged and expired data', () => {
    const expired = receipt({ issuedAt: '2026-08-08T11:00:00.000Z', expiresAt: '2026-08-08T11:01:00.000Z' });
    assert.equal(verifyAuditorReturnReceipt(expired, { ...context, trustedAdapter: trust.adapter }).state, 'stale');
    const forged = structuredClone(expired);
    forged.authentication.value = corruptSignatureBody(forged.authentication.value);
    const result = verifyAuditorReturnReceipt(forged, { ...context, trustedAdapter: trust.adapter });
    assert.equal(result.verified, false);
    assert.equal(result.state, 'untrusted');
  });

  it('rejects a zero-length liveness interval even inside the clock-skew allowance', () => {
    const instant = '2026-08-08T12:00:01.000Z';
    const zeroLength = receipt({ issuedAt: instant, expiresAt: instant });
    const result = verifyAuditorReturnReceipt(zeroLength, { ...context, trustedAdapter: trust.adapter });
    assert.equal(result.verified, false);
    assert.equal(result.state, 'stale');
  });

  it('rejects every authenticated semantic binding mismatch', () => {
    const cases = [
      ['adapter', { adapterId: 'wrong.adapter' }, {}],
      ['key', { keyId: 'wrong-key' }, {}],
      ['target', { targetRepository: 'file:/wrong-target' }, {}],
      ['role', {}, { role: 'orchestrator' }],
      ['invocation', { invocationReference: 'wrong-invocation' }, {}],
      ['mode', { invocationMode: 'wrong-mode' }, {}],
      ['work unit', { workUnit: 'milestone:other' }, {}],
      ['candidate', { candidateArtifact: `commit:${'b'.repeat(40)}` }, {}],
      ['tasks', { coveredTasks: ['T-001', 'T-003'] }, {}],
      ['report digest', { reportDigest: `sha256:agenticloop.auditor-return-report.v1:${'b'.repeat(64)}` }, {}],
    ];
    for (const [label, receiptOverrides, contextOverrides] of cases) {
      const result = verifyAuditorReturnReceipt(receipt(receiptOverrides), {
        ...context, trustedAdapter: trust.adapter, ...contextOverrides,
      });
      assert.equal(result.verified, false, label);
      assert.equal(result.state, 'untrusted', label);
    }
  });

  it('binds substantive report bytes without a circular receipt digest', () => {
    const first = auditorReturnReportDigest(report);
    const withReceipt = structuredClone(report);
    withReceipt.invocation.receipt = canonicalJson(receipt());
    assert.equal(auditorReturnReportDigest(withReceipt), first);
    withReceipt.assessment = 'Changed assessment.';
    assert.notEqual(auditorReturnReportDigest(withReceipt), first);
  });

  it('refuses a non-finite verification clock instead of skipping freshness', () => {
    // Every freshness comparison against NaN is false, so a non-finite clock
    // used to admit any authentic receipt regardless of its liveness window.
    const long = receipt({ issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:01:00.000Z' });
    for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'not-a-time', {}]) {
      const result = verifyAuditorReturnReceipt(long, { ...context, trustedAdapter: trust.adapter, now: clock });
      assert.equal(result.verified, false, String(clock));
      assert.equal(result.state, 'stale', String(clock));
    }
    assert.match(
      verifyAuditorReturnReceipt(long, { ...context, trustedAdapter: trust.adapter, now: Number.NaN }).error,
      /finite verification clock/
    );
  });

  it('refuses an old receipt whose expiry was pushed far into the future', () => {
    const stale = receipt({ issuedAt: '2026-08-01T12:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
    const result = verifyAuditorReturnReceipt(stale, { ...context, trustedAdapter: trust.adapter });
    assert.equal(result.verified, false);
    assert.equal(result.state, 'stale');
  });

  it('refuses a declared validity interval longer than the receipt policy', () => {
    const issuedAt = new Date(NOW - 1_000).toISOString();
    const overLong = receipt({
      issuedAt,
      expiresAt: new Date(NOW - 1_000 + AUDITOR_RECEIPT_MAX_VALIDITY_MS + 1_000).toISOString(),
    });
    const result = verifyAuditorReturnReceipt(overLong, { ...context, trustedAdapter: trust.adapter });
    assert.equal(result.verified, false);
    assert.equal(result.state, 'stale');
  });

  it('accepts the exact policy boundary and refuses one millisecond past it', () => {
    // Interval exactly equal to the policy, still inside its window: accepted.
    const atLimitIssued = NOW - AUDITOR_RECEIPT_MAX_VALIDITY_MS + 1_000;
    const atLimit = receipt({
      issuedAt: new Date(atLimitIssued).toISOString(),
      expiresAt: new Date(atLimitIssued + AUDITOR_RECEIPT_MAX_VALIDITY_MS).toISOString(),
    });
    const accepted = verifyAuditorReturnReceipt(atLimit, { ...context, trustedAdapter: trust.adapter });
    assert.equal(accepted.verified, true, accepted.error);

    // One millisecond more declared validity: refused.
    const overIssued = NOW - 1_000;
    const justOver = receipt({
      issuedAt: new Date(overIssued).toISOString(),
      expiresAt: new Date(overIssued + AUDITOR_RECEIPT_MAX_VALIDITY_MS + 1).toISOString(),
    });
    assert.equal(verifyAuditorReturnReceipt(justOver, { ...context, trustedAdapter: trust.adapter }).state, 'stale');

    // Age exactly at the policy with a live window: accepted.
    const atAge = receipt({
      issuedAt: new Date(NOW - AUDITOR_RECEIPT_MAX_VALIDITY_MS).toISOString(),
      expiresAt: new Date(NOW + 1_000).toISOString(),
    });
    assert.equal(
      verifyAuditorReturnReceipt(atAge, { ...context, trustedAdapter: trust.adapter }).state,
      'stale',
      'an age at the policy limit implies a declared interval past it'
    );
  });

  it('keeps forged-and-expired data untrusted while authentic over-age data is stale', () => {
    const overAge = receipt({
      issuedAt: new Date(NOW - AUDITOR_RECEIPT_MAX_VALIDITY_MS - 60_000).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    });
    assert.equal(verifyAuditorReturnReceipt(overAge, { ...context, trustedAdapter: trust.adapter }).state, 'stale');
    const forged = structuredClone(overAge);
    forged.authentication.value = corruptSignatureBody(forged.authentication.value);
    assert.equal(verifyAuditorReturnReceipt(forged, { ...context, trustedAdapter: trust.adapter }).state, 'untrusted');
  });

  it('rejects unknown receipt fields before signature or freshness semantics', () => {
    const malformed = { ...receipt(), extra: true };
    const result = verifyAuditorReturnReceipt(malformed, { ...context, trustedAdapter: trust.adapter });
    assert.equal(result.verified, false);
    assert.equal(result.state, 'untrusted');
    assert.match(result.error, /closed schema/);
  });
});
