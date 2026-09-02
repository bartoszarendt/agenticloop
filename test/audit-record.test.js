/**
 * Work-unit audit certificate contract tests.
 *
 * Covers the durable record shape, the exact-baseline certification rule, fresh
 * invocation provenance, the separate audit budget, verdict/limitation rules,
 * and the closeout gate. All fixtures are deterministic: no model invocation,
 * no credentials, no network, no external repository.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendAuditReport,
  applyAuditHumanResolution,
  applyAuditBudgetOverride,
  auditBudgetState,
  canonicalizeAuditRecord,
  certificationStatus,
  completedAuditRuns,
  coveredTaskSetsEqual,
  createAuditRecordContent,
  evaluateAuditCloseoutGate,
  findAuditRecord,
  nextAuditId,
  normalizeCoveredTasks,
  openBlockingFindings,
  parseAuditRecord,
  parseWorkUnitIdentity,
  repairAuditRecordStructure,
  updateAuditBaseline,
  validateAuditRecord,
  validateAuditRecords,
  workUnitIdentityForGroup,
} from '../src/audit-record.js';
import { DEFAULT_AUDIT_BUDGET } from '../src/layout.js';
import { parseAuditorWireReport, wireReportToAuditRun } from '../src/audit-report-schema.js';
import { createAuditorReturnReceipt } from '../src/auditor-return-receipt.js';
import { canonicalJson } from '../src/canonical-json.js';
import { createTestHostTrust } from './helpers/host-trust-fixture.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-record-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  return target;
}

function writeAudit(target, auditId, content) {
  writeFileSync(join(target, '.agenticloop', 'audits', `${auditId}.md`), content, 'utf-8');
}

function baseRecord(overrides = {}) {
  return createAuditRecordContent({
    auditId: 'AUD-001',
    workUnit: 'phase:4',
    coveredTasks: ['T-041', 'T-042'],
    candidateArtifact: 'commit:abc123',
    goal: 'Deliver Phase 4 with its accepted task outcomes integrated.',
    completionOracle: 'All covered task outcomes are present and final checks pass.',
    evidence: 'Integrated verification results for commit:abc123.',
    ...overrides,
  });
}

function report(overrides = {}) {
  return {
    verdict: 'needs_remediation',
    invocationMode: 'host_subagent',
    invocationReference: `ref-${Math.random().toString(36).slice(2)}`,
    auditedArtifact: 'commit:abc123',
    assessment: 'Consolidated assessment across all six perspectives.',
    evidenceChecked: 'npm test (pass)',
    findings: [],
    ...overrides,
  };
}

function authenticatedWireRun(wireReport) {
  return {
    ...wireReportToAuditRun(wireReport),
    auditorReturnAssurance: 'host_receipt',
    producerAuthenticated: true,
  };
}

function blockingFinding(id = 'A-01') {
  return {
    id,
    severity: 'high',
    blocking: true,
    claim: 'Two configuration sources disagree.',
    evidenceRefs: 'src/a.js:10, src/b.js:22',
    consequence: 'Runtime picks the wrong value.',
    requiredOutcome: 'One source of truth for the setting.',
    verificationRequired: 'npm test plus a new integration test.',
  };
}

// Append `count` non-certifying reports, asserting each one is accepted.
function appendRuns(content, count) {
  let current = content;
  for (let index = 0; index < count; index++) {
    const result = appendAuditReport(current, report({ invocationReference: `ref-${index + 1}` }));
    assert.ok(result.ok, `run ${index + 1} should be accepted: ${result.errors.join('; ')}`);
    current = result.content;
  }
  return current;
}

describe('work-unit identity', () => {
  it('accepts canonical grouped and explicit flat identities', () => {
    for (const value of ['phase:4', 'milestone:M2', 'epic:payments', 'custom:squad-a', 'work-unit:login']) {
      const parsed = parseWorkUnitIdentity(value);
      assert.ok(parsed.ok, `${value} should parse: ${parsed.error}`);
      assert.equal(parsed.canonical, value);
    }
  });

  it('rejects an unqualified or unknown-kind identity', () => {
    assert.equal(parseWorkUnitIdentity('phase-4').ok, false);
    assert.equal(parseWorkUnitIdentity('sprint:3').ok, false);
    assert.equal(parseWorkUnitIdentity('').ok, false);
  });

  it('derives grouped identities from the configured grouping profile only', () => {
    assert.equal(workUnitIdentityForGroup('phase', '4'), 'phase:4');
    assert.equal(workUnitIdentityForGroup('milestone', 'M2'), 'milestone:M2');
    assert.equal(workUnitIdentityForGroup('custom', 'squad-a'), 'custom:squad-a');
    // Flat projects have nothing durable to derive from; the human names the unit.
    assert.equal(workUnitIdentityForGroup('flat', 'anything'), null);
  });

  it('never uses a work-unit identity as a filename', () => {
    const target = makeTarget('identity-filenames');
    writeAudit(target, 'AUD-001', baseRecord());
    const found = findAuditRecord(target, 'phase:4');
    assert.ok(found);
    assert.match(found.relPath, /AUD-001\.md$/);
    assert.ok(!found.relPath.includes(':'), 'audit filenames must stay Windows-safe');
  });
});

describe('audit record validation', () => {
  it('accepts a canonical record', () => {
    assert.deepEqual(validateAuditRecord(baseRecord(), '.agenticloop/audits/AUD-001.md'), []);
  });

  it('migrates schema v2 assurance conservatively without discarding current certification', () => {
    const artifact = `commit:${'a'.repeat(40)}`;
    const wire = parseAuditorWireReport({
      report_schema: 'auditor_report_v1',
      producer: { roleId: 'auditor' },
      artifact,
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'schema-v2-run', provenance: 'asserted' },
      perspectives: Object.fromEntries(
        ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
          .map(key => [key, `${key} body.`])
      ),
      assessment: 'Consolidated assessment.',
      evidence_checked: 'npm test (pass)',
      verdict: 'certified',
      findings: [],
    });
    assert.equal(wire.ok, true, wire.errors.join('; '));
    const current = appendAuditReport(
      baseRecord({ candidateArtifact: artifact }),
      {
        ...wireReportToAuditRun(wire.report),
        auditorReturnAssurance: 'session_reported',
        producerAuthenticated: false,
      }
    );
    assert.equal(current.ok, true, current.errors.join('; '));
    const prior = current.content
      .replace('audit_schema_version: 3', 'audit_schema_version: 2')
      .replace(/- Auditor return assurance:.*\n/g, '')
      .replace(/- Producer authenticated:.*\n/g, '');
    const migrated = canonicalizeAuditRecord(prior, {
      evidence: 'Fresh integrated evidence for the same full candidate.',
      resolveArtifact: () => ({ ok: true, canonical: artifact }),
    });
    assert.equal(migrated.ok, true, migrated.errors.join('; '));
    const record = parseAuditRecord(migrated.content);
    assert.equal(record.auditSchemaVersion, 3);
    assert.equal(record.history[0].auditorReturnAssurance, 'session_reported');
    assert.equal(record.history[0].producerAuthenticated, 'false');
    assert.equal(certificationStatus(record).current, true);
  });

  it('rejects a missing required heading', () => {
    const content = baseRecord().replace('## Accepted Decisions\n\nnone\n', '');
    const errors = validateAuditRecord(content, '.agenticloop/audits/AUD-001.md');
    assert.ok(errors.some(e => e.includes("missing required section '## Accepted Decisions'")), errors.join('\n'));
  });

  it('repairs duplicate canonical titles without changing audit payloads', () => {
    const canonical = baseRecord();
    const corrupted = canonical.replace(
      '# AUD-001: Work-Unit Audit',
      Array(6).fill('# AUD-001: Work-Unit Audit').join('\n\n')
    );
    const errors = validateAuditRecord(corrupted, 'AUD-001.md');
    assert.match(errors.join('\n'), /Safe repair: agenticloop audit repair-structure AUD-001/);

    const repaired = repairAuditRecordStructure(corrupted);
    assert.ok(repaired.ok, repaired.errors.join('; '));
    assert.deepEqual(validateAuditRecord(repaired.content, 'AUD-001.md'), []);
    assert.equal((repaired.content.match(/^# AUD-001: Work-Unit Audit$/gm) ?? []).length, 1);
    assert.deepEqual(parseAuditRecord(repaired.content), parseAuditRecord(canonical));
  });

  it('refuses automatic audit repair when canonical sections are also corrupt', () => {
    const corrupted = baseRecord()
      .replace('# AUD-001: Work-Unit Audit', '')
      .replace('## Comments', '## Comments\n\nfirst\n\n## Comments');
    const repaired = repairAuditRecordStructure(corrupted);
    assert.equal(repaired.ok, false);
    assert.match(repaired.errors.join('\n'), /requires exactly one '## Comments'/);
  });

  it('refuses audit repair when an unrecognized live section would be lost', () => {
    const corrupted = baseRecord()
      .replace('# AUD-001: Work-Unit Audit', '')
      .replace('## Comments', '## Field Notes\n\nOperator prose that must survive.\n\n## Comments');
    const repaired = repairAuditRecordStructure(corrupted);
    assert.equal(repaired.ok, false);
    assert.match(repaired.errors.join('\n'), /would discard unrecognized live section.*Field Notes/);
    assert.match(corrupted, /Operator prose that must survive/);
  });

  it('rejects model, reasoning effort, provider, and mutable round fields by contract', () => {
    for (const key of ['model', 'reasoning_effort', 'provider', 'audit_round', 'completed_audits']) {
      const content = baseRecord().replace('audit_budget: 3', `${key}: something\naudit_budget: 3`);
      const errors = validateAuditRecord(content, '.agenticloop/audits/AUD-001.md');
      assert.ok(errors.some(e => e.includes(`must not set '${key}'`)), `${key}: ${errors.join('\n')}`);
    }
  });

  it('requires audit_id to match its filename', () => {
    const errors = validateAuditRecord(baseRecord(), '.agenticloop/audits/AUD-009.md');
    assert.ok(errors.some(e => e.includes("must match its filename 'AUD-009.md'")), errors.join('\n'));
  });

  it('rejects an unknown audit_state and an unknown verdict', () => {
    const badState = baseRecord().replace('audit_state: active', 'audit_state: pending');
    assert.ok(validateAuditRecord(badState, 'AUD-001.md').some(e => e.includes('audit_state')));

    const badVerdict = baseRecord().replace('latest_verdict:', 'latest_verdict: approved');
    assert.ok(validateAuditRecord(badVerdict, 'AUD-001.md').some(e => e.includes('latest_verdict')));
  });

  it('rejects a certified state that no longer matches the candidate baseline', () => {
    const certified = baseRecord()
      .replace('audit_state: active', 'audit_state: certified')
      .replace('certified_artifact:', 'certified_artifact: commit:stale')
      .replace('latest_verdict:', 'latest_verdict: certified');
    const errors = validateAuditRecord(certified, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes('does not match candidate_artifact')), errors.join('\n'));
  });

  it('rejects a latest_verdict that disagrees with the last recorded run', () => {
    const content = appendRuns(baseRecord(), 1)
      .replace('latest_verdict: needs_remediation', 'latest_verdict: certified');
    const errors = validateAuditRecord(content, 'AUD-001.md');
    assert.ok(
      errors.some(e => e.includes('latest_verdict must equal the last recorded Auditor verdict')),
      errors.join('\n')
    );
  });

  it('rejects a latest_verdict with no recorded run', () => {
    const content = baseRecord().replace('latest_verdict:', 'latest_verdict: certified');
    const errors = validateAuditRecord(content, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes('records no completed audit run')), errors.join('\n'));
  });

  it('rejects placeholder audit packets before any report can be recorded', () => {
    const placeholder = createAuditRecordContent({
      auditId: 'AUD-001',
      workUnit: 'phase:4',
      coveredTasks: ['T-041'],
      candidateArtifact: 'commit:abc123',
    });
    const errors = validateAuditRecord(placeholder, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes("concrete '## Work Unit Goal'")), errors.join('\n'));
    const append = appendAuditReport(placeholder, report({ verdict: 'certified' }));
    assert.equal(append.ok, false);
    assert.ok(append.errors.some(e => e.includes('existing audit record is invalid')));
  });

  it('binds evidence structurally to the exact candidate without prose repetition', () => {
    // The CLI owns the structural artifact binding: concise prose evidence no
    // longer fails for omitting the exact candidate string.
    const concise = baseRecord({
      evidence: 'npm test (pass), integration suite (pass).',
    });
    assert.deepEqual(validateAuditRecord(concise, 'AUD-001.md'), []);
    // Tampering with the rendered binding is still rejected.
    const tampered = concise
      .split('- Candidate artifact: commit:abc123')
      .join('- Candidate artifact: commit:other');
    const errors = validateAuditRecord(tampered, 'AUD-001.md');
    assert.ok(errors.some(error => error.includes("'## Evidence Available'")), errors.join('\n'));
    assert.ok(errors.some(error => error.includes("'## Frozen Baseline'")), errors.join('\n'));
  });

  it('derives the run count from history rather than a stored counter', () => {
    const content = appendRuns(baseRecord(), 3);
    const record = parseAuditRecord(content);
    assert.equal(completedAuditRuns(record), 3);
    assert.deepEqual(record.history.map(entry => entry.runNumber), [1, 2, 3]);
    assert.ok(!Object.hasOwn(record.frontmatter, 'audit_round'));
    assert.ok(!Object.hasOwn(record.frontmatter, 'completed_audits'));
  });

  it('rejects duplicate audit ids and duplicate work units across records', () => {
    const target = makeTarget('duplicates');
    writeAudit(target, 'AUD-001', baseRecord());
    writeAudit(target, 'AUD-002', baseRecord({ auditId: 'AUD-002' }));
    const { errors } = validateAuditRecords(target);
    assert.ok(errors.some(e => e.includes("duplicates work unit 'phase:4'")), errors.join('\n'));
  });

  it('rejects a covered task that does not match the project task id pattern', () => {
    const content = baseRecord({ coveredTasks: ['nope'] });
    const errors = validateAuditRecord(content, 'AUD-001.md', { taskIdRegex: '^T-\\d{3,}$' });
    assert.ok(errors.some(e => e.includes("covered task 'nope'")), errors.join('\n'));
  });

  it('rejects a reused Auditor return receipt identity across already-persisted records', () => {
    const target = makeTarget('duplicate-receipt-identity');
    const trust = createTestHostTrust({ target });

    /**
     * Two receipts sharing one receiptId but differing in every other byte.
     * Byte-equality alone cannot catch this, so the cross-record check must
     * compare the stable receipt identity - and it must do so in the durable
     * validator, not only in the pre-write guard, so a record pair that reached
     * disk by any route is still rejected on read.
     */
    function receipt(reportDigest, issuedAt, expiresAt) {
      return canonicalJson(createAuditorReturnReceipt({
        receiptId: 'shared-return-receipt',
        adapterId: trust.adapterId, keyId: trust.keyId,
        targetRepository: trust.repositoryIdentity,
        invocationReference: `invoke-${issuedAt}`, invocationMode: 'host_subagent',
        workUnit: 'phase:4', candidateArtifact: 'commit:abc123',
        coveredTasks: ['T-041', 'T-042'],
        reportDigest, issuedAt, expiresAt,
      }, trust.privateKey));
    }

    function recordWith(auditId, workUnit, invocationReference, receiptWire) {
      const wire = parseAuditorWireReport({
        report_schema: 'auditor_report_v1',
        producer: { roleId: 'auditor' },
        artifact: 'commit:abc123',
        covered_tasks: ['T-041', 'T-042'],
        invocation: {
          mode: 'host_subagent', reference: invocationReference,
          provenance: 'verified', receipt: receiptWire,
        },
        perspectives: Object.fromEntries(
          ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
            .map(key => [key, `${key} body.`])
        ),
        assessment: 'Consolidated assessment across all six perspectives.',
        evidence_checked: 'npm test (pass)',
        verdict: 'needs_remediation',
        findings: [],
      });
      assert.equal(wire.ok, true, wire.errors?.join('\n'));
      const appended = appendAuditReport(baseRecord({ auditId, workUnit }), authenticatedWireRun(wire.report));
      assert.ok(appended.ok, appended.errors.join('; '));
      return appended.content;
    }

    const digest = `sha256:agenticloop.auditor-return-report.v1:${'c'.repeat(64)}`;
    writeAudit(target, 'AUD-001', recordWith(
      'AUD-001', 'phase:4', 'invoke-first',
      receipt(digest, '2026-08-08T11:59:00.000Z', '2026-08-08T12:01:00.000Z')
    ));
    writeAudit(target, 'AUD-002', recordWith(
      'AUD-002', 'phase:5', 'invoke-second',
      receipt(digest, '2026-08-08T12:05:00.000Z', '2026-08-08T12:07:00.000Z')
    ));

    const { errors } = validateAuditRecords(target);
    assert.ok(
      errors.some(error => /reuses Auditor return receipt identity 'shared-return-receipt'/.test(error)),
      errors.join('\n')
    );
    // The two receipt payloads genuinely differ, so byte-equality alone would
    // have missed this.
    assert.equal(
      errors.some(error => /reuses invocation receipt/.test(error)),
      false,
      'the two receipts differ byte-for-byte; only the identity check can catch the replay'
    );
  });

  /**
   * A byte-identical replay and a receipt-identity reuse are the same refusal
   * seen at two granularities: identical bytes always carry an identical
   * receiptId. Emitting both named one root cause twice and left a reader
   * guessing whether two separate problems existed.
   */
  it('emits one root diagnostic for a byte-identical receipt replay', () => {
    const target = makeTarget('identical-receipt-replay');
    const trust = createTestHostTrust({ target });
    const digest = `sha256:agenticloop.auditor-return-report.v1:${'e'.repeat(64)}`;
    const receiptWire = canonicalJson(createAuditorReturnReceipt({
      receiptId: 'replayed-return-receipt',
      adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: 'invoke-original', invocationMode: 'host_subagent',
      workUnit: 'phase:4', candidateArtifact: 'commit:abc123',
      coveredTasks: ['T-041', 'T-042'], reportDigest: digest,
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey));

    const make = (auditId, workUnit, reference) => {
      const wire = parseAuditorWireReport({
        report_schema: 'auditor_report_v1', producer: { roleId: 'auditor' },
        artifact: 'commit:abc123', covered_tasks: ['T-041', 'T-042'],
        invocation: { mode: 'host_subagent', reference, provenance: 'verified', receipt: receiptWire },
        perspectives: Object.fromEntries(
          ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
            .map(key => [key, `${key} body.`])
        ),
        assessment: 'Consolidated assessment across all six perspectives.',
        evidence_checked: 'npm test (pass)', verdict: 'needs_remediation', findings: [],
      });
      assert.equal(wire.ok, true, wire.errors?.join('\n'));
      const appended = appendAuditReport(baseRecord({ auditId, workUnit }), authenticatedWireRun(wire.report));
      assert.ok(appended.ok, appended.errors.join('; '));
      return appended.content;
    };

    writeAudit(target, 'AUD-001', make('AUD-001', 'phase:4', 'invoke-a'));
    writeAudit(target, 'AUD-002', make('AUD-002', 'phase:5', 'invoke-b'));

    const { errors } = validateAuditRecords(target);
    const byteReplay = errors.filter(error => /reuses invocation receipt/.test(error));
    const identityReplay = errors.filter(error => /reuses Auditor return receipt identity/.test(error));
    assert.equal(byteReplay.length, 1, errors.join('\n'));
    assert.equal(
      identityReplay.length,
      0,
      'identical bytes trivially share a receiptId; the identity message would repeat one root cause'
    );
    assert.match(byteReplay[0], /^Audit record '[^']*AUD-002\.md'/);
    assert.match(byteReplay[0], /already recorded in '[^']*AUD-001\.md'$/);
  });

  it('accepts distinct Auditor return receipt identities across records', () => {
    const target = makeTarget('distinct-receipt-identity');
    const trust = createTestHostTrust({ target });
    const digest = `sha256:agenticloop.auditor-return-report.v1:${'d'.repeat(64)}`;
    const make = (auditId, workUnit, receiptId, reference) => {
      const receiptWire = canonicalJson(createAuditorReturnReceipt({
        receiptId, adapterId: trust.adapterId, keyId: trust.keyId,
        targetRepository: trust.repositoryIdentity,
        invocationReference: reference, invocationMode: 'host_subagent',
        workUnit: 'phase:4', candidateArtifact: 'commit:abc123',
        coveredTasks: ['T-041', 'T-042'], reportDigest: digest,
        issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
      }, trust.privateKey));
      const wire = parseAuditorWireReport({
        report_schema: 'auditor_report_v1', producer: { roleId: 'auditor' },
        artifact: 'commit:abc123', covered_tasks: ['T-041', 'T-042'],
        invocation: { mode: 'host_subagent', reference, provenance: 'verified', receipt: receiptWire },
        perspectives: Object.fromEntries(
          ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
            .map(key => [key, `${key} body.`])
        ),
        assessment: 'Consolidated assessment across all six perspectives.',
        evidence_checked: 'npm test (pass)', verdict: 'needs_remediation', findings: [],
      });
      assert.equal(wire.ok, true, wire.errors?.join('\n'));
      const appended = appendAuditReport(baseRecord({ auditId, workUnit }), authenticatedWireRun(wire.report));
      assert.ok(appended.ok, appended.errors.join('; '));
      return appended.content;
    };
    writeAudit(target, 'AUD-001', make('AUD-001', 'phase:4', 'return-receipt-a', 'invoke-a'));
    writeAudit(target, 'AUD-002', make('AUD-002', 'phase:5', 'return-receipt-b', 'invoke-b'));
    const { errors } = validateAuditRecords(target);
    assert.equal(
      errors.some(error => /reuses Auditor return receipt identity|reuses invocation receipt/.test(error)),
      false,
      errors.join('\n')
    );
  });
});

describe('exact-baseline certification', () => {
  it('certifies when the artifact and covered-task set both match', () => {
    const result = appendAuditReport(baseRecord(), report({ verdict: 'certified' }));
    assert.ok(result.ok, result.errors.join('; '));
    const record = parseAuditRecord(result.content);
    assert.equal(record.auditState, 'certified');
    assert.equal(record.certifiedArtifact, 'commit:abc123');
    assert.deepEqual(record.certifiedCoveredTasks, ['T-041', 'T-042']);
    assert.equal(certificationStatus(record).current, true);
    assert.deepEqual(validateAuditRecord(result.content, 'AUD-001.md'), []);
  });

  it('never treats frontmatter-only certification as current', () => {
    const forged = baseRecord()
      .replace('audit_state: active', 'audit_state: certified')
      .replace('certified_artifact:', 'certified_artifact: commit:abc123')
      .replace('certified_covered_tasks: []', 'certified_covered_tasks:\n  - T-041\n  - T-042')
      .replace('latest_verdict:', 'latest_verdict: certified');
    const record = parseAuditRecord(forged);
    assert.equal(certificationStatus(record).current, false);
    assert.ok(
      certificationStatus(record).reasons.some(reason => reason.includes('no completed Auditor run'))
    );
  });

  it('binds certification to the exact artifact and task set in the last run', () => {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    const tamperedArtifact = certified.replace(
      'Audited artifact: commit:abc123',
      'Audited artifact: commit:other'
    );
    assert.equal(certificationStatus(parseAuditRecord(tamperedArtifact)).current, false);
    assert.ok(
      validateAuditRecord(tamperedArtifact, 'AUD-001.md')
        .some(error => error.includes('last audited artifact')),
      validateAuditRecord(tamperedArtifact, 'AUD-001.md').join('\n')
    );

    const tamperedTasks = certified.replace(
      'Covered tasks: T-041, T-042',
      'Covered tasks: T-041'
    );
    assert.equal(certificationStatus(parseAuditRecord(tamperedTasks)).current, false);
    assert.ok(
      validateAuditRecord(tamperedTasks, 'AUD-001.md')
        .some(error => error.includes('last audited covered-task set'))
    );
  });

  it('makes certification stale when the candidate artifact changes', () => {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    const refreshed = updateAuditBaseline(certified, {
      candidateArtifact: 'commit:def456',
      evidence: 'Integrated verification results for commit:def456.',
    });
    const record = parseAuditRecord(refreshed);
    assert.equal(record.certifiedArtifact, '');
    assert.equal(record.auditState, 'active');
    assert.equal(certificationStatus(record).current, false);
    assert.deepEqual(validateAuditRecord(refreshed, 'AUD-001.md'), []);
  });

  it('makes certification stale when a covered task is added or removed', () => {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;

    const added = parseAuditRecord(updateAuditBaseline(certified, { coveredTasks: ['T-041', 'T-042', 'T-055'] }));
    assert.equal(certificationStatus(added).current, false);

    const removed = parseAuditRecord(updateAuditBaseline(certified, { coveredTasks: ['T-041'] }));
    assert.equal(certificationStatus(removed).current, false);
  });

  it('treats a reordered but identical covered-task set as equivalent', () => {
    assert.ok(coveredTaskSetsEqual(['T-042', 'T-041'], ['T-041', 'T-042']));
    assert.deepEqual(normalizeCoveredTasks(['T-042', 'T-041', 'T-042']), ['T-041', 'T-042']);

    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    const reordered = parseAuditRecord(updateAuditBaseline(certified, { coveredTasks: ['T-042', 'T-041'] }));
    assert.equal(certificationStatus(reordered).current, true, 'reordering is not a boundary change');
  });

  it('keeps an unresolved blocking finding out of a current certification', () => {
    const withFinding = appendAuditReport(
      baseRecord(),
      report({ findings: [blockingFinding()] })
    ).content;
    const record = parseAuditRecord(withFinding);
    assert.deepEqual(openBlockingFindings(record).map(f => f.id), ['A-01']);
    assert.equal(certificationStatus(record).current, false);
  });
});

describe('fresh invocation provenance', () => {
  it('accepts host_subagent and explicit_agent_invocation', () => {
    for (const mode of ['host_subagent', 'explicit_agent_invocation']) {
      const result = appendAuditReport(baseRecord(), report({ invocationMode: mode }));
      assert.ok(result.ok, `${mode}: ${result.errors.join('; ')}`);
    }
  });

  it('rejects single_agent_fallback', () => {
    const result = appendAuditReport(baseRecord(), report({ invocationMode: 'single_agent_fallback' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('same-session fallback does not satisfy auditing')));
  });

  it('rejects a missing invocation reference', () => {
    const result = appendAuditReport(baseRecord(), report({ invocationReference: '' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('unique invocation reference is required')));
  });

  it('rejects a reused invocation reference on append and on validation', () => {
    const first = appendAuditReport(baseRecord(), report({ invocationReference: 'ref-1' }));
    const reused = appendAuditReport(first.content, report({ invocationReference: 'ref-1' }));
    assert.equal(reused.ok, false);
    assert.ok(reused.errors.some(e => e.includes('already recorded')));

    // A hand-edited record with a duplicated reference must also fail validation.
    const second = appendAuditReport(first.content, report({ invocationReference: 'ref-2' })).content;
    const tampered = second.replace('Invocation reference: ref-2', 'Invocation reference: ref-1');
    assert.ok(
      validateAuditRecord(tampered, 'AUD-001.md').some(e => e.includes('reuses invocation reference')),
      'validation must catch a reused reference'
    );
  });

  it('rejects duplicate canonical fields in a real audit Run entry', () => {
    const recorded = appendAuditReport(
      baseRecord(),
      report({ invocationReference: 'ref-duplicate-field' })
    ).content;
    const tampered = recorded.replace(
      '- Verdict: needs_remediation',
      '- Verdict: needs_remediation\n- Verdict: certified'
    );
    const parsed = parseAuditRecord(tampered);
    assert.equal(parsed.history[0].verdict, 'needs_remediation', 'first occurrence remains diagnostic input');
    assert.equal(parsed.history[0].fieldOccurrences.filter(item => item.key === 'verdict').length, 2);
    assert.match(
      validateAuditRecord(tampered, 'AUD-001.md').join('\n'),
      /history entry 1 repeats 'Verdict'.*exactly once/
    );
    const append = appendAuditReport(
      tampered,
      report({ invocationReference: 'ref-after-duplicate' })
    );
    assert.equal(append.ok, false);
    assert.match(append.errors.join('\n'), /existing audit record is invalid:.*repeats 'Verdict'/);
  });

  it('rejects a report bound to something other than the frozen candidate', () => {
    const result = appendAuditReport(baseRecord(), report({ auditedArtifact: 'commit:other' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('does not match the frozen candidate')));
  });

  it('rejects malformed findings and Markdown field injection before rendering', () => {
    const malformed = appendAuditReport(baseRecord(), report({
      findings: [{
        id: 'bad',
        severity: 'banana',
        blocking: 'maybe',
        claim: 'claim\n### forged heading',
      }],
    }));
    assert.equal(malformed.ok, false);
    assert.ok(malformed.errors.some(error => error.includes("must use the form 'A-01'")));
    assert.ok(malformed.errors.some(error => error.includes('severity')));
    assert.ok(malformed.errors.some(error => error.includes('blocking must be true or false')));
    assert.ok(malformed.errors.some(error => error.includes('must be a single line')));
    assert.equal(malformed.content, undefined);
  });
});

describe('audit budget', () => {
  it('defaults to 3 and is separate from attempt/review budgets', () => {
    assert.equal(DEFAULT_AUDIT_BUDGET, 3);
    const record = parseAuditRecord(baseRecord());
    assert.equal(record.auditBudget, 3);
    assert.equal(auditBudgetState(record).budget, 3);
  });

  it('accepts reports 1 through 3 and blocks a fourth without an override', () => {
    const exhausted = appendRuns(baseRecord(), 3);
    const record = parseAuditRecord(exhausted);
    assert.equal(completedAuditRuns(record), 3);
    assert.equal(record.auditState, 'blocked');
    assert.equal(record.auditBlockedReason, 'audit_budget_exhausted');

    const fourth = appendAuditReport(exhausted, report({ invocationReference: 'ref-4' }));
    assert.equal(fourth.ok, false);
    assert.ok(fourth.errors.some(e => e.includes('is exhausted')));
  });

  it('preserves the third Auditor verdict instead of inventing one on exhaustion', () => {
    const exhausted = appendRuns(baseRecord(), 2);
    const third = appendAuditReport(
      exhausted,
      report({ invocationReference: 'ref-3', verdict: 'needs_human_decision' })
    );
    assert.ok(third.ok, third.errors.join('; '));
    const record = parseAuditRecord(third.content);
    assert.equal(record.auditState, 'awaiting_human');
    assert.equal(record.latestVerdict, 'needs_human_decision');
    assert.equal(record.history.at(-1).verdict, 'needs_human_decision');
    assert.deepEqual(validateAuditRecord(third.content, 'AUD-001.md'), []);
  });

  it('preserves both the human-decision gate and an exhausted budget', () => {
    const afterTwo = appendRuns(baseRecord(), 2);
    const waiting = appendAuditReport(
      afterTwo,
      report({ invocationReference: 'ref-3', verdict: 'needs_human_decision' })
    );
    const resolved = applyAuditHumanResolution(waiting.content, {
      authority: 'human: alex',
      note: 'Remediate the product gap and run another audit.',
    });
    assert.ok(resolved.ok, resolved.errors.join('; '));
    const record = parseAuditRecord(resolved.content);
    assert.equal(record.auditState, 'blocked');
    assert.equal(record.auditBlockedReason, 'audit_budget_exhausted');
    assert.equal(record.humanResolutionRef, 'human: alex');

    const stillBlocked = appendAuditReport(
      resolved.content,
      report({ invocationReference: 'ref-4', verdict: 'certified' })
    );
    assert.equal(stillBlocked.ok, false);
    assert.ok(stillBlocked.errors.some(error => error.includes('is exhausted')));
  });

  it('keeps a failed invocation that produced no report off the budget', () => {
    const afterOne = appendRuns(baseRecord(), 1);
    // A rejected append writes nothing, so history and budget are unchanged.
    const rejected = appendAuditReport(afterOne, report({ invocationMode: 'single_agent_fallback' }));
    assert.equal(rejected.ok, false);
    assert.equal(completedAuditRuns(parseAuditRecord(afterOne)), 1);
  });

  it('does not consume the budget for remediation or reset it on a new baseline', () => {
    const afterTwo = appendRuns(baseRecord(), 2);
    const rebaselined = updateAuditBaseline(afterTwo, {
      candidateArtifact: 'commit:def456',
      coveredTasks: ['T-041', 'T-042', 'T-055'],
      evidence: 'Integrated verification results for commit:def456.',
    });
    const record = parseAuditRecord(rebaselined);
    assert.equal(completedAuditRuns(record), 2, 'baseline replacement must not reset history');
    assert.equal(auditBudgetState(record).remaining, 1);
  });

  it('permits another report only after a recorded human-approved override', () => {
    const exhausted = appendRuns(baseRecord(), 3);

    const noAuthority = applyAuditBudgetOverride(exhausted, { budget: 7, authority: '' });
    assert.equal(noAuthority.ok, false);
    assert.ok(noAuthority.errors.some(e => e.includes('human authority reference')));

    const notHigher = applyAuditBudgetOverride(exhausted, { budget: 3, authority: 'human: alex' });
    assert.equal(notHigher.ok, false);

    const override = applyAuditBudgetOverride(exhausted, { budget: 7, authority: 'human: alex' });
    assert.ok(override.ok, override.errors.join('; '));
    const overridden = parseAuditRecord(override.content);
    assert.equal(overridden.auditBudget, 7);
    assert.equal(overridden.auditState, 'active');
    assert.match(override.content, /audit_budget raised to 7 by human: alex/);

    const fourth = appendAuditReport(override.content, report({ invocationReference: 'ref-4' }));
    assert.ok(fourth.ok, fourth.errors.join('; '));
    assert.equal(fourth.runNumber, 4);
  });

  it('keeps an existing stored budget of 5 valid and flags history above a lowered budget', () => {
    const existing = appendRuns(baseRecord({ auditBudget: 5 }), 5);
    assert.equal(parseAuditRecord(existing).auditBudget, 5);
    assert.deepEqual(validateAuditRecord(existing, 'AUD-001.md'), []);
    const exhausted = existing.replace('audit_budget: 5', 'audit_budget: 3');
    const errors = validateAuditRecord(exhausted, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes('above audit_budget 3')), errors.join('\n'));
  });
});

describe('verdicts and accepted limitations', () => {
  it('refuses certified while a blocking finding is open', () => {
    const result = appendAuditReport(
      baseRecord(),
      report({ verdict: 'certified', findings: [blockingFinding()] })
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('requires no open blocking findings')));
  });

  it('allows certified alongside a non-blocking finding', () => {
    const result = appendAuditReport(
      baseRecord(),
      report({ verdict: 'certified', findings: [{ ...blockingFinding('A-02'), blocking: false, severity: 'low' }] })
    );
    assert.ok(result.ok, result.errors.join('; '));
    assert.equal(parseAuditRecord(result.content).auditState, 'certified');
  });

  it('requires an authority reference for every retained limitation', () => {
    const withoutAuthority = baseRecord({
      knownLimitations: '- Legacy import path stays unmigrated for one release.',
    });
    const rejected = appendAuditReport(
      withoutAuthority,
      report({ verdict: 'certified_with_accepted_limitations' })
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(e => e.includes('cannot accept it')));

    const withAuthority = baseRecord({
      knownLimitations: '- Legacy import path stays unmigrated for one release. Authority: D-2026-07-01-002',
    });
    const accepted = appendAuditReport(
      withAuthority,
      report({ verdict: 'certified_with_accepted_limitations' })
    );
    assert.ok(accepted.ok, accepted.errors.join('; '));
    assert.deepEqual(validateAuditRecord(accepted.content, 'AUD-001.md'), []);
  });

  it('rejects Auditor self-authorization and missing decision records', () => {
    const selfAuthorized = baseRecord({
      knownLimitations: '- Keep the gap. Authority: auditor:self',
    });
    const rejected = appendAuditReport(
      selfAuthorized,
      report({ verdict: 'certified_with_accepted_limitations' })
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(error => error.includes("human: <identity>")));

    const missingDecision = baseRecord({
      knownLimitations: '- Keep the gap. Authority: D-2026-07-24-001',
    });
    const decisionRejected = appendAuditReport(
      missingDecision,
      report({ verdict: 'certified_with_accepted_limitations' }),
      { decisionExists: () => false }
    );
    assert.equal(decisionRejected.ok, false);
    assert.ok(decisionRejected.errors.some(error => error.includes('non-accepted decision')));
  });

  it('routes an unaccepted new limitation through a human-decision verdict', () => {
    const result = appendAuditReport(
      baseRecord(),
      report({ verdict: 'needs_human_decision' })
    );
    assert.ok(result.ok, result.errors.join('; '));
    const record = parseAuditRecord(result.content);
    assert.equal(record.latestVerdict, 'needs_human_decision');
    assert.equal(record.auditState, 'awaiting_human');
    assert.equal(record.certifiedArtifact, '', 'a human-decision verdict certifies nothing');
  });

  it('requires a durable human resolution before another Auditor report', () => {
    const waiting = appendAuditReport(
      baseRecord(),
      report({ verdict: 'needs_human_decision', invocationReference: 'ref-human-1' })
    );
    assert.ok(waiting.ok, waiting.errors.join('; '));
    assert.equal(parseAuditRecord(waiting.content).auditState, 'awaiting_human');

    const premature = appendAuditReport(
      waiting.content,
      report({ verdict: 'certified', invocationReference: 'ref-human-2' })
    );
    assert.equal(premature.ok, false);
    assert.ok(premature.errors.some(error => error.includes('audit resolve')));

    const selfResolution = applyAuditHumanResolution(waiting.content, {
      authority: 'auditor:self',
      note: 'Accept the limitation.',
    });
    assert.equal(selfResolution.ok, false);

    const resolved = applyAuditHumanResolution(waiting.content, {
      authority: 'human: alex',
      note: 'Do not accept the limitation; remediate it and re-audit.',
    });
    assert.ok(resolved.ok, resolved.errors.join('; '));
    const resolvedRecord = parseAuditRecord(resolved.content);
    assert.equal(resolvedRecord.auditState, 'active');
    assert.equal(resolvedRecord.humanResolutionRef, 'human: alex');

    const fresh = appendAuditReport(
      resolved.content,
      report({ verdict: 'certified', invocationReference: 'ref-human-2' })
    );
    assert.ok(fresh.ok, fresh.errors.join('; '));
    assert.equal(parseAuditRecord(fresh.content).humanResolutionRef, '');
  });

  it('keeps a finding open until a fresh Auditor drops it', () => {
    const withFinding = appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content;
    assert.deepEqual(openBlockingFindings(parseAuditRecord(withFinding)).map(f => f.id), ['A-01']);

    // Maintainer counter-evidence recorded in the record body does not clear it.
    const counterEvidence = withFinding.replace(
      '## Remediation Tasks\n\nnone',
      '## Remediation Tasks\n\n- A-01 rejected with counter-evidence: src/a.js:10 is dead code.'
    );
    assert.deepEqual(openBlockingFindings(parseAuditRecord(counterEvidence)).map(f => f.id), ['A-01']);

    // Only a fresh Auditor report without the finding closes it.
    const cleared = appendAuditReport(
      counterEvidence,
      report({ invocationReference: 'ref-fresh', verdict: 'certified', findings: [] })
    );
    assert.ok(cleared.ok, cleared.errors.join('; '));
    assert.deepEqual(openBlockingFindings(parseAuditRecord(cleared.content)), []);
  });

  it('validates the required finding fields', () => {
    const content = appendAuditReport(
      baseRecord(),
      report({ findings: [blockingFinding()] })
    ).content.replace('- Required outcome: One source of truth for the setting.\n', '');
    const errors = validateAuditRecord(content, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes("is missing 'Required outcome'")), errors.join('\n'));
  });
});

describe('closeout gate', () => {
  const externalBoundary = Object.freeze({
    expectedCandidate: 'commit:abc123',
    expectedCoveredTasks: Object.freeze(['T-041', 'T-042']),
  });
  function seedCertified(target) {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    writeAudit(target, 'AUD-001', certified);
    return certified;
  }

  it('blocks completion when audit is enabled and no record exists', () => {
    const target = makeTarget('gate-missing');
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled', ...externalBoundary });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_missing');
    assert.equal(gate.optOut, false);
  });

  it('blocks completion when the key is omitted, because the default is enabled', () => {
    const target = makeTarget('gate-default');
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', ...externalBoundary });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_missing');
  });

  it('permits completion with a current certificate', () => {
    const target = makeTarget('gate-certified');
    seedCertified(target);
    const gate = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      ...externalBoundary,
      taskStatus: () => 'accepted',
    });
    assert.equal(gate.allowed, true, gate.reasons.join('; '));
    assert.equal(gate.state, 'certified');
    assert.equal(gate.auditId, 'AUD-001');
  });

  it('requires the exact closeout candidate and exact covered-task inventory', () => {
    const target = makeTarget('gate-exact-candidate');
    seedCertified(target);
    const exact = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4', workUnitAudit: 'enabled',
      expectedCandidate: 'commit:abc123', expectedCoveredTasks: ['T-041', 'T-042'],
      taskStatus: () => 'accepted',
    });
    assert.equal(exact.allowed, true, exact.reasons.join('; '));

    const newer = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4', workUnitAudit: 'enabled',
      expectedCandidate: 'commit:def456', expectedCoveredTasks: ['T-041', 'T-042'],
      taskStatus: () => 'accepted',
    });
    assert.equal(newer.allowed, false);
    assert.equal(newer.state, 'audit_stale');
    assert.match(newer.repair, /audit baseline AUD-001 --artifact commit:def456/);

    const expanded = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4', workUnitAudit: 'enabled',
      expectedCandidate: 'commit:abc123', expectedCoveredTasks: ['T-041', 'T-042', 'T-043'],
      taskStatus: () => 'accepted',
    });
    assert.equal(expanded.allowed, false);
    assert.equal(expanded.state, 'audit_stale');
  });

  it('fails closed with distinct states when either external gate identity is omitted', () => {
    const target = makeTarget('gate-missing-external-identities');
    seedCertified(target);
    const noCandidate = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4', workUnitAudit: 'enabled',
      expectedCoveredTasks: ['T-041', 'T-042'],
    });
    assert.equal(noCandidate.allowed, false);
    assert.equal(noCandidate.state, 'audit_candidate_missing');
    assert.deepEqual(noCandidate.codes, ['audit_candidate_missing']);

    const noTasks = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4', workUnitAudit: 'enabled',
      expectedCandidate: 'commit:abc123',
    });
    assert.equal(noTasks.allowed, false);
    assert.equal(noTasks.state, 'audit_task_set_missing');
    assert.deepEqual(noTasks.codes, ['audit_task_set_missing']);
  });

  it('enforces the effective Auditor-return minimum independently at closeout', () => {
    const target = makeTarget('audit-return-minimum');
    seedCertified(target);
    const standard = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      ...externalBoundary,
      minimumAuditorReturnAssurance: 'session_reported',
    });
    assert.equal(standard.allowed, true, standard.reasons.join('; '));
    assert.equal(standard.auditorReturnAssurance, 'session_reported');
    assert.equal(standard.producerAuthenticated, false);

    const hardened = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      ...externalBoundary,
      minimumAuditorReturnAssurance: 'host_receipt',
    });
    assert.equal(hardened.allowed, false);
    assert.match(hardened.reasons.join('\n'), /session_reported.*below the effective minimum 'host_receipt'/);
  });

  it('fails closed when a structurally invalid record claims certification', () => {
    const target = makeTarget('invalid-claimed-certificate');
    const forged = baseRecord()
      .replace('audit_state: active', 'audit_state: certified')
      .replace('certified_artifact:', 'certified_artifact: commit:abc123')
      .replace('certified_covered_tasks: []', 'certified_covered_tasks:\n  - T-041\n  - T-042')
      .replace('latest_verdict:', 'latest_verdict: certified');
    writeAudit(target, 'AUD-001', forged);
    const result = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      ...externalBoundary,
      taskStatus: () => 'accepted',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.state, 'audit_invalid');
    assert.ok(result.reasons.some(reason => reason.includes('no completed audit run')));
  });

  it('fails closed when more than one record claims the same work unit', () => {
    const target = makeTarget('duplicate-gate-records');
    writeAudit(
      target,
      'AUD-001',
      appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content
    );
    writeAudit(
      target,
      'AUD-002',
      appendAuditReport(
        baseRecord({ auditId: 'AUD-002' }),
        report({ verdict: 'certified', invocationReference: 'ref-duplicate' })
      ).content
    );
    const result = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      ...externalBoundary,
      taskStatus: () => 'accepted',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.state, 'audit_invalid');
    assert.ok(result.reasons.some(reason => reason.includes('exactly one is required')));
  });

  it('blocks completion when the certificate went stale', () => {
    const target = makeTarget('gate-stale');
    const certified = seedCertified(target);
    writeAudit(target, 'AUD-001', updateAuditBaseline(certified, {
      candidateArtifact: 'commit:def456',
      evidence: 'Integrated verification results for commit:def456.',
    }));

    const gate = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4', workUnitAudit: 'enabled',
      expectedCandidate: 'commit:def456', expectedCoveredTasks: ['T-041', 'T-042'],
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_stale');
  });

  it('blocks completion while a blocking finding is unresolved', () => {
    const target = makeTarget('gate-finding');
    writeAudit(target, 'AUD-001', appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content);
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled', ...externalBoundary });
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some(r => r.includes('unresolved blocking findings')), gate.reasons.join('; '));
  });

  it('blocks completion when a covered task was reopened', () => {
    const target = makeTarget('gate-reopened');
    seedCertified(target);
    const gate = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      ...externalBoundary,
      taskStatus: taskId => (taskId === 'T-042' ? 'in-progress' : 'accepted'),
    });
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some(r => r.includes("covered task T-042 is 'in-progress'")), gate.reasons.join('; '));
  });

  it('reports a blocked audit rather than allowing completion', () => {
    const target = makeTarget('gate-blocked');
    writeAudit(target, 'AUD-001', appendRuns(baseRecord(), 3));
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled', ...externalBoundary });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_blocked');
  });

  it('bypasses the gate when explicitly disabled without claiming certification', () => {
    const target = makeTarget('gate-disabled');
    writeAudit(target, 'AUD-001', appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content);

    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'disabled' });
    assert.equal(gate.allowed, true);
    assert.equal(gate.state, 'audit_disabled');
    assert.equal(gate.optOut, true, 'the opt-out must stay visible in closeout evidence');
    assert.notEqual(gate.state, 'certified', 'opting out never certifies the work unit');

    // History is preserved for a later re-enable.
    assert.equal(completedAuditRuns(findAuditRecord(target, 'phase:4').record), 1);
  });

  it('restores the gate when audit is re-enabled', () => {
    const target = makeTarget('gate-reenabled');
    writeAudit(target, 'AUD-001', appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content);
    assert.equal(evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'disabled' }).allowed, true);
    assert.equal(evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled', ...externalBoundary }).allowed, false);
  });
});

describe('audit id allocation', () => {
  it('allocates stable zero-padded ids', () => {
    assert.equal(nextAuditId([]), 'AUD-001');
    assert.equal(nextAuditId(['AUD-001']), 'AUD-002');
    assert.equal(nextAuditId(['AUD-001', 'AUD-010']), 'AUD-011');
    assert.equal(nextAuditId(['not-an-audit']), 'AUD-001');
  });
});
