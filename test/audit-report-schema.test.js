/**
 * Auditor report wire-format tests: schema validation, lossless six-
 * perspective round trips through durable history, and legacy inline
 * compatibility.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  legacyInlineToAuditRun,
  auditorReportDigest,
  parseAuditorWireReport,
  wireReportToAuditRun,
} from '../src/audit-report-schema.js';
import {
  appendAuditReport,
  createAuditRecordContent,
  parseAuditRecord,
} from '../src/audit-record.js';
import { normalizeAuditorInvocationProvenance } from '../src/audit-provenance.js';

const FULL_A = 'a'.repeat(40);

function wireReport(overrides = {}) {
  return {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact: `commit:${FULL_A}`,
    covered_tasks: ['T-001', 'T-002'],
    invocation: {
      mode: 'host_subagent',
      reference: 'invoke-0001',
      provenance: 'verified',
      receipt: 'auditor-receipt-0001',
    },
    perspectives: {
      outcome: 'Outcome body: the integrated result achieves the goal.',
      completeness: 'Completeness body: nothing material is missing.',
      integration_coherence: 'Integration body: outputs compose without conflict.',
      engineering_quality: 'Quality body: the combined solution is appropriately simple.',
      verification: 'Verification body: evidence proves the exact candidate.',
      risk: 'Risk body: no combined-state regressions found.',
    },
    assessment: 'One consolidated assessment paragraph.',
    evidence_checked: 'npm test (pass); npx agenticloop validate (pass)',
    verdict: 'certified',
    findings: [],
    ...overrides,
  };
}

describe('auditor wire report schema', () => {
  it('accepts a complete report', () => {
    const result = parseAuditorWireReport(wireReport());
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.report.perspectives.risk.includes('Risk body'), true);
  });

  it('requires all six perspectives and every substantive field', () => {
    const missing = wireReport();
    delete missing.perspectives.verification;
    const result = parseAuditorWireReport(missing);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes("'verification'")));
    for (const field of ['artifact', 'assessment', 'evidence_checked', 'verdict', 'findings']) {
      const broken = wireReport();
      delete broken[field];
      assert.equal(parseAuditorWireReport(broken).ok, false, field);
    }
  });

  it('names the exact missing finding field and its repair', () => {
    const report = wireReport({
      findings: [{
        id: 'A-01',
        severity: 'high',
        blocking: true,
        claim: 'Something is wrong',
        evidenceRefs: 'src/a.js:10',
        consequence: 'It breaks',
      }],
      verdict: 'needs_remediation',
    });
    const result = parseAuditorWireReport(report);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes("required field 'requiredOutcome'")), result.errors.join('\n'));
    assert.ok(result.errors.some(error => error.includes("required field 'verificationRequired'")), result.errors.join('\n'));
  });

  it('rejects contradictory provenance claims truthfully', () => {
    const verified = wireReport({ invocation: { mode: 'host_subagent', reference: 'r1', provenance: 'verified' } });
    const result = parseAuditorWireReport(verified);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('receipt')));
    const withReceipt = wireReport({
      invocation: { mode: 'host_subagent', reference: 'r1', provenance: 'verified', receipt: 'host-receipt-1' },
    });
    assert.equal(parseAuditorWireReport(withReceipt).ok, true);
  });

  it('rejects unknown top-level, invocation, perspective, and finding fields', () => {
    const topLevel = wireReport({ unexpected: 'discarded today' });
    assert.equal(parseAuditorWireReport(topLevel).ok, false);

    const invocation = wireReport({
      invocation: { mode: 'host_subagent', reference: 'r1', provenance: 'asserted', extra: 'discarded today' },
    });
    assert.equal(parseAuditorWireReport(invocation).ok, false);

    const finding = wireReport({
      findings: [{
        id: 'A-01', severity: 'low', blocking: false,
        claim: 'Claim', evidenceRefs: 'src/a.js:1', consequence: 'Consequence',
        requiredOutcome: 'Outcome', verificationRequired: 'Verification', extra: 'discarded today',
      }],
    });
    const result = parseAuditorWireReport(finding);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes("unknown finding field 'extra'")));
  });

  it('never rejects an oversized but valid report (bounds are advisory)', () => {
    const huge = wireReport({
      perspectives: Object.fromEntries([
        'outcome', 'completeness', 'integration_coherence',
        'engineering_quality', 'verification', 'risk',
      ].map(key => [key, `${key}: ${'x'.repeat(25000)}`])),
    });
    assert.equal(parseAuditorWireReport(huge).ok, true);
  });

  it('requires the immutable Auditor producer and authenticates the complete canonical payload', async () => {
    const missingProducer = wireReport();
    delete missingProducer.producer;
    assert.equal(parseAuditorWireReport(missingProducer).ok, false);
    assert.equal(parseAuditorWireReport(wireReport({ producer: { roleId: 'engineer' } })).ok, false);

    const parsed = parseAuditorWireReport(wireReport());
    assert.equal(parsed.ok, true, parsed.errors.join('\n'));
    const run = wireReportToAuditRun(parsed.report);
    const context = {
      workUnit: 'phase:4', candidateArtifact: parsed.report.artifact,
      coveredTasks: parsed.report.covered_tasks,
      verifier: input => ({ verified: input.reportDigest === auditorReportDigest(parsed.report), reportDigest: input.reportDigest }),
    };
    assert.equal((await normalizeAuditorInvocationProvenance(run, context)).errors.length, 0);
    for (const mutate of [
      report => { report.findings = [{ id: 'A-01' }]; },
      report => { report.perspectives.risk = 'Changed risk.'; },
      report => { report.verdict = 'needs_remediation'; },
      report => { report.artifact = `commit:${'b'.repeat(40)}`; },
      report => { report.covered_tasks = ['T-999']; },
      report => { report.producer = { roleId: 'engineer' }; },
    ]) {
      const changed = structuredClone(parsed.report);
      mutate(changed);
      const changedRun = { ...run, wirePayload: changed, auditorReportDigest: auditorReportDigest(changed) };
      const checked = await normalizeAuditorInvocationProvenance(changedRun, context);
      assert.ok(checked.errors.length > 0, 'mutated authenticated payload must fail');
    }
  });
});

describe('lossless durable history', () => {
  function seedRecord() {
    return createAuditRecordContent({
      auditId: 'AUD-001',
      workUnit: 'milestone:M00',
      coveredTasks: ['T-001', 'T-002'],
      candidateArtifact: `commit:${FULL_A}`,
      auditBudget: 3,
      goal: 'Deliver the milestone outcome.',
      completionOracle: 'Observable completion holds.',
      evidence: 'Integrated checks pass.',
    });
  }

  it('persists and reparses all six perspective bodies and every substantive string', () => {
    const wire = parseAuditorWireReport(wireReport({
      findings: [{
        id: 'A-01',
        severity: 'low',
        blocking: false,
        claim: 'Docs mention an obsolete flag',
        evidenceRefs: 'docs/usage.md:12',
        consequence: 'Reader confusion',
        requiredOutcome: 'Docs match behavior',
        verificationRequired: 'Re-read the section after edit',
      }],
      verdict: 'certified',
    }));
    assert.equal(wire.ok, true, wire.errors.join('\n'));
    const run = wireReportToAuditRun(wire.report);
    const result = appendAuditReport(seedRecord(), run);
    assert.equal(result.ok, true, result.errors.join('\n'));

    const record = parseAuditRecord(result.content);
    assert.equal(record.history.length, 1);
    const entry = record.history[0];
    assert.equal(entry.reportFormat, 'auditor_report_v1');
    const payload = entry.reportPayload;
    assert.ok(payload, 'payload must reparse from durable history');
    for (const key of ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']) {
      assert.equal(payload.perspectives[key], wire.report.perspectives[key], key);
    }
    assert.equal(payload.assessment, wire.report.assessment);
    assert.equal(payload.evidence_checked, wire.report.evidence_checked);
    assert.deepEqual(payload.findings, wire.report.findings);
    assert.equal(payload.invocation.provenance, 'verified');
  });

  it('keeps legacy inline runs explicitly versioned without fabricated perspectives', () => {
    const run = legacyInlineToAuditRun({
      verdict: 'certified',
      invocationMode: 'explicit_agent_invocation',
      invocationReference: 'legacy-ref-1',
      auditedArtifact: `commit:${FULL_A}`,
      assessment: 'Short assessment.',
      evidenceChecked: 'npm test',
      findings: [],
    });
    const result = appendAuditReport(seedRecord(), run);
    assert.equal(result.ok, true, result.errors.join('\n'));
    const record = parseAuditRecord(result.content);
    const entry = record.history[0];
    assert.equal(entry.reportFormat, 'legacy_inline_v1');
    assert.equal(entry.invocationProvenance, 'asserted');
    const payload = entry.reportPayload;
    assert.equal(payload.report_schema, 'legacy_inline_v1');
    assert.equal(payload.perspectives, undefined, 'legacy inline must not fabricate perspective bodies');
    assert.equal(payload.assessment, 'Short assessment.');
    assert.equal(payload.invocation.reference, 'legacy-ref-1');
  });
});
