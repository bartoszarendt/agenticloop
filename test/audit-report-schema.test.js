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
  auditorReturnReportDigest,
  parseAuditorWireReport,
  prepareAuditorReturnReportForSigning,
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
      verifier: input => ({ verified: input.reportDigest === auditorReturnReportDigest(parsed.report), reportDigest: input.reportDigest }),
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
      const changedRun = {
        ...run,
        wirePayload: changed,
        auditorReportDigest: auditorReportDigest(changed),
        auditorReturnReportDigest: auditorReturnReportDigest(changed),
      };
      const checked = await normalizeAuditorInvocationProvenance(changedRun, context);
      assert.ok(checked.errors.length > 0, 'mutated authenticated payload must fail');
    }
  });
});

describe('policy-aware Auditor return assurance', () => {
  it('accepts an asserted receipt-free return in standard mode and records its limitation', async () => {
    const parsed = parseAuditorWireReport(wireReport({
      invocation: {
        mode: 'host_subagent',
        reference: 'standard-auditor-invocation',
        provenance: 'asserted',
      },
    }));
    assert.equal(parsed.ok, true, parsed.errors.join('\n'));
    const checked = await normalizeAuditorInvocationProvenance(
      wireReportToAuditRun(parsed.report),
      {
        verifier: null,
        workUnit: 'phase:4',
        candidateArtifact: parsed.report.artifact,
        coveredTasks: parsed.report.covered_tasks,
        minimumReturnAssurance: 'session_reported',
      }
    );
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.run.auditorReturnAssurance, 'session_reported');
    assert.equal(checked.run.producerAuthenticated, false);
  });

  it('keeps hardened mode fail-closed for the same asserted return', async () => {
    const parsed = parseAuditorWireReport(wireReport({
      invocation: {
        mode: 'explicit_agent_invocation',
        reference: 'hardened-auditor-invocation',
        provenance: 'asserted',
      },
    }));
    const checked = await normalizeAuditorInvocationProvenance(
      wireReportToAuditRun(parsed.report),
      {
        verifier: null,
        workUnit: 'phase:4',
        candidateArtifact: parsed.report.artifact,
        coveredTasks: parsed.report.covered_tasks,
        minimumReturnAssurance: 'host_receipt',
      }
    );
    assert.match(checked.errors.join('\n'), /session_reported.*below the effective minimum 'host_receipt'/);
  });
});

describe('host-side pre-signing report preparation', () => {
  /**
   * A host holds the Auditor's raw wire report, not the CLI's normalized
   * projection of it. Every case here is a report a host may legitimately
   * receive and the CLI legitimately accepts; the digest the host prepares must
   * equal the digest the CLI derives for each one, or a genuine signature over
   * a genuine report is rejected.
   */
  const RAW_VARIANTS = {
    'surrounding whitespace in assessment and evidence': {
      assessment: '  One consolidated assessment paragraph.\n',
      evidence_checked: '\tnpm test (pass); npx agenticloop validate (pass)  ',
    },
    'surrounding whitespace in perspective bodies': {
      perspectives: {
        outcome: '\n  Outcome body: the integrated result achieves the goal.  ',
        completeness: 'Completeness body: nothing material is missing.\t',
        integration_coherence: '  Integration body: outputs compose without conflict.',
        engineering_quality: 'Quality body: the combined solution is appropriately simple.\n\n',
        verification: '\tVerification body: evidence proves the exact candidate.',
        risk: '  Risk body: no combined-state regressions found.  ',
      },
    },
    'surrounding whitespace in invocation fields': {
      invocation: {
        mode: ' host_subagent ', reference: '  invoke-0001\n',
        provenance: ' VERIFIED ', receipt: '  auditor-receipt-0001  ',
      },
    },
    'surrounding whitespace and blank entries in covered tasks': {
      covered_tasks: ['  T-001 ', '\tT-002\n'],
    },
    'surrounding whitespace in the artifact identity': {
      artifact: `  commit:${FULL_A}\n`,
    },
    'finding-field trimming and normalized severity and boolean forms': {
      findings: [{
        id: ' A-01 ', severity: '  LOW ', blocking: 'false',
        claim: '  Docs mention an obsolete flag  ',
        evidenceRefs: '\tdocs/usage.md:12', consequence: 'Reader confusion  ',
        requiredOutcome: '  Docs match behavior', verificationRequired: ' Re-read the section after edit\n',
      }],
    },
  };

  for (const [label, overrides] of Object.entries(RAW_VARIANTS)) {
    it(`derives one digest across host preparation and CLI parsing despite ${label}`, () => {
      const raw = wireReport(overrides);
      const prepared = prepareAuditorReturnReportForSigning(raw);
      assert.equal(prepared.ok, true, prepared.errors.join('\n'));

      // The host signs prepared.digest, then inserts the receipt it created
      // into the normalized report it was handed.
      const submitted = structuredClone(prepared.report);
      submitted.invocation.receipt = 'auditor-receipt-0001';
      const parsed = parseAuditorWireReport(submitted);
      assert.equal(parsed.ok, true, parsed.errors.join('\n'));
      assert.equal(
        wireReportToAuditRun(parsed.report).auditorReturnReportDigest,
        prepared.digest,
        'host and CLI must derive the same auditor-return-report digest'
      );

      // Submitting the untouched raw document the Auditor produced reaches the
      // same identity: normalization, not the caller's formatting, defines it.
      const rawSubmitted = parseAuditorWireReport(raw);
      assert.equal(rawSubmitted.ok, true, rawSubmitted.errors.join('\n'));
      assert.equal(
        wireReportToAuditRun(rawSubmitted.report).auditorReturnReportDigest,
        prepared.digest
      );
    });
  }

  it('ignores object key order in the raw document', () => {
    const canonical = prepareAuditorReturnReportForSigning(wireReport());
    const reordered = wireReport();
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    shuffled.invocation = Object.fromEntries(Object.entries(reordered.invocation).reverse());
    shuffled.perspectives = Object.fromEntries(Object.entries(reordered.perspectives).reverse());
    const prepared = prepareAuditorReturnReportForSigning(shuffled);
    assert.equal(prepared.ok, true, prepared.errors.join('\n'));
    assert.equal(prepared.digest, canonical.digest);
  });

  it('canonicalizes covered tasks identically for host and CLI', () => {
    const prepared = prepareAuditorReturnReportForSigning(wireReport({ covered_tasks: [' T-002', 'T-001 '] }));
    assert.equal(prepared.ok, true, prepared.errors.join('\n'));
    assert.deepEqual(prepared.report.covered_tasks, ['T-002', 'T-001']);
    const submitted = structuredClone(prepared.report);
    submitted.invocation.receipt = 'auditor-receipt-0001';
    assert.equal(
      wireReportToAuditRun(parseAuditorWireReport(submitted).report).auditorReturnReportDigest,
      prepared.digest
    );
  });

  it('returns a receipt-null projection without a caller-visible dummy receipt', () => {
    const prepared = prepareAuditorReturnReportForSigning(wireReport({
      invocation: { mode: 'host_subagent', reference: 'invoke-0001', provenance: 'verified' },
    }));
    assert.equal(prepared.ok, true, prepared.errors.join('\n'));
    assert.equal(prepared.report.invocation.receipt, null);
    assert.match(prepared.digest, /^sha256:agenticloop\.auditor-return-report\.v1:[a-f0-9]{64}$/);
    // The very same projection, submitted unsigned, is still refused.
    const unsigned = parseAuditorWireReport(structuredClone(prepared.report));
    assert.equal(unsigned.ok, false);
    assert.ok(unsigned.errors.some(error => error.includes('requires invocation.receipt')));
  });

  /**
   * Preparation is for reports that will carry a host return receipt. An
   * `asserted` report cannot: submission refuses an `asserted` report that
   * carries one, so preparing it produced a digest with no valid destination -
   * a host would sign something guaranteed to be rejected. Preparation refuses
   * up front, and it refuses rather than promoting the class.
   */
  it('refuses to prepare a report whose provenance is not verified', () => {
    for (const [label, invocation] of [
      ['explicit asserted', { mode: 'host_subagent', reference: 'invoke-0001', provenance: 'asserted' }],
      ['asserted with a receipt', {
        mode: 'host_subagent', reference: 'invoke-0001', provenance: 'asserted', receipt: 'auditor-receipt-0001',
      }],
      ['defaulted absent provenance', { mode: 'host_subagent', reference: 'invoke-0001' }],
      ['defaulted empty provenance', { mode: 'host_subagent', reference: 'invoke-0001', provenance: '   ' }],
      ['normalized case', { mode: 'host_subagent', reference: 'invoke-0001', provenance: ' ASSERTED ' }],
    ]) {
      const prepared = prepareAuditorReturnReportForSigning(wireReport({ invocation }));
      assert.equal(prepared.ok, false, label);
      assert.equal(prepared.report, null, label);
      assert.equal(prepared.digest, null, label);
      assert.equal(prepared.errors.length, 1, label);
      if (label === 'asserted with a receipt') {
        assert.match(prepared.errors[0], /asserted.*cannot carry invocation\.receipt/, label);
        continue;
      }
      assert.match(prepared.errors[0], /invocation\.provenance must be 'verified'/, label);
      assert.match(prepared.errors[0], /got 'asserted'/, label);
      assert.match(prepared.errors[0], /never promotes asserted provenance/, label);
    }

    // The verified path is untouched, receipt present or absent.
    for (const invocation of [
      { mode: 'host_subagent', reference: 'invoke-0001', provenance: 'verified' },
      { mode: 'host_subagent', reference: 'invoke-0001', provenance: 'verified', receipt: 'auditor-receipt-0001' },
    ]) {
      const prepared = prepareAuditorReturnReportForSigning(wireReport({ invocation }));
      assert.equal(prepared.ok, true, prepared.errors.join('\n'));
      assert.equal(prepared.report.invocation.provenance, 'verified');
      assert.equal(prepared.report.invocation.receipt, null);
    }
  });

  it('does not weaken normal submission: verified still requires a receipt', () => {
    for (const receipt of [undefined, null, '', '   ']) {
      const raw = wireReport({
        invocation: { mode: 'host_subagent', reference: 'invoke-0001', provenance: 'verified', receipt },
      });
      const result = parseAuditorWireReport(raw);
      assert.equal(result.ok, false, JSON.stringify(receipt));
      assert.ok(result.errors.some(error => error.includes('requires invocation.receipt')));
    }
  });

  it('fails closed with structured errors for an invalid report', () => {
    for (const [label, raw] of [
      ['not an object', 'auditor_report_v1'],
      ['wrong schema', wireReport({ report_schema: 'auditor_report_v2' })],
      ['unknown top-level field', { ...wireReport(), rogue: true }],
      ['missing perspective', (() => { const r = wireReport(); delete r.perspectives.risk; return r; })()],
      ['invalid verdict', wireReport({ verdict: 'looks-fine' })],
      ['empty covered tasks', wireReport({ covered_tasks: [] })],
      ['wrong producer', wireReport({ producer: { roleId: 'engineer' } })],
    ]) {
      const prepared = prepareAuditorReturnReportForSigning(raw);
      assert.equal(prepared.ok, false, label);
      assert.equal(prepared.report, null, label);
      assert.equal(prepared.digest, null, label);
      assert.ok(Array.isArray(prepared.errors) && prepared.errors.length > 0, label);
      assert.ok(prepared.errors.every(error => typeof error === 'string'), label);
    }
  });

  it('breaks the identity when any substantive field is mutated after signing', () => {
    const prepared = prepareAuditorReturnReportForSigning(wireReport({
      findings: [{
        id: 'A-01', severity: 'low', blocking: false, claim: 'Docs mention an obsolete flag',
        evidenceRefs: 'docs/usage.md:12', consequence: 'Reader confusion',
        requiredOutcome: 'Docs match behavior', verificationRequired: 'Re-read the section after edit',
      }],
    }));
    assert.equal(prepared.ok, true, prepared.errors.join('\n'));
    for (const mutate of [
      report => { report.assessment = 'Rewritten assessment.'; },
      report => { report.evidence_checked = 'nothing checked'; },
      report => { report.verdict = 'needs_remediation'; },
      report => { report.artifact = `commit:${'b'.repeat(40)}`; },
      report => { report.covered_tasks = ['T-001']; },
      report => { report.perspectives.risk = 'Rewritten risk.'; },
      report => { report.invocation.reference = 'invoke-0002'; },
      report => { report.invocation.mode = 'explicit_agent_invocation'; },
      report => { report.findings[0].severity = 'high'; },
      report => { report.findings[0].blocking = true; },
      report => { report.findings[0].claim = 'Rewritten claim'; },
    ]) {
      const mutated = structuredClone(prepared.report);
      mutate(mutated);
      mutated.invocation.receipt = 'auditor-receipt-0001';
      const parsed = parseAuditorWireReport(mutated);
      assert.equal(parsed.ok, true, parsed.errors.join('\n'));
      assert.notEqual(
        wireReportToAuditRun(parsed.report).auditorReturnReportDigest,
        prepared.digest,
        'a mutated substantive field must not keep the signed identity'
      );
    }
  });

  it('keeps the raw-document digest fail-closed when it differs from the normalized one', async () => {
    const raw = wireReport({ assessment: '  One consolidated assessment paragraph.\n' });
    const rawDigest = auditorReturnReportDigest(raw);
    const prepared = prepareAuditorReturnReportForSigning(raw);
    assert.notEqual(rawDigest, prepared.digest, 'the raw document must be the wrong digest here');

    const parsed = parseAuditorWireReport(raw);
    const run = wireReportToAuditRun(parsed.report);
    // A host that signed the raw document instead of the prepared projection
    // presents the wrong identity, and verification refuses it.
    const wrong = await normalizeAuditorInvocationProvenance(run, {
      workUnit: 'milestone:M00',
      candidateArtifact: run.auditedArtifact,
      coveredTasks: run.coveredTasks,
      verifier: () => ({ verified: true, reportDigest: rawDigest }),
    });
    assert.ok(wrong.errors.length > 0, 'the raw digest must not authenticate the report');

    const right = await normalizeAuditorInvocationProvenance(run, {
      workUnit: 'milestone:M00',
      candidateArtifact: run.auditedArtifact,
      coveredTasks: run.coveredTasks,
      verifier: () => ({ verified: true, reportDigest: prepared.digest }),
    });
    assert.deepEqual(right.errors, []);
  });

  it('keeps the receipt-bearing report digest a separate persisted identity', () => {
    const prepared = prepareAuditorReturnReportForSigning(wireReport());
    const submitted = structuredClone(prepared.report);
    submitted.invocation.receipt = 'auditor-receipt-0001';
    const run = wireReportToAuditRun(parseAuditorWireReport(submitted).report);
    assert.equal(run.auditorReturnReportDigest, prepared.digest);
    assert.notEqual(run.auditorReportDigest, run.auditorReturnReportDigest);
    assert.match(run.auditorReportDigest, /^sha256:agenticloop\.auditor-report\.v1:[a-f0-9]{64}$/);
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
    const run = {
      ...wireReportToAuditRun(wire.report),
      auditorReturnAssurance: 'host_receipt',
      producerAuthenticated: true,
    };
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
