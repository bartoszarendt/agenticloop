/**
 * Transactional audit mutation tests: invalid creation/rebaseline leaves no
 * residue, evidence binding is CLI-owned, dispositions behave, and legacy
 * records migrate only through the explicit canonicalize path.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess, scriptedStdin } from './helpers/run-cli.js';
import { parseAuditRecord } from '../src/audit-record.js';
import { auditorReturnReportDigest, prepareAuditorReturnReportForSigning } from '../src/audit-report-schema.js';
import {
  auditorReturnReceiptSignaturePayload,
  createAuditorReturnReceipt,
  loadAuditorReturnReceiptVerifier,
} from '../src/auditor-return-receipt.js';
import { signHostPayload } from '../src/host-trust.js';
import { createTestHostTrust, protectedHostBoundary, writeHostTrustStore } from './helpers/host-trust-fixture.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-txn-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const FULL_A = 'a'.repeat(40);
const FULL_B = 'b'.repeat(40);

const PROJECT_MAP = [
  '---',
  'setup_status: confirmed',
  'development_stage: expansion',
  'task_backend: files',
  'work_unit_audit: enabled',
  'grouping_profile: phase',
  '---',
  '',
  '# Project',
  '',
].join('\n');

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), PROJECT_MAP, 'utf-8');
  for (const taskId of ['T-041', 'T-042', 'T-055']) {
    writeFileSync(
      join(target, '.agenticloop', 'tasks', `${taskId}.md`),
      `---\ntask_id: ${taskId}\nstatus: accepted\n---\n`,
      'utf-8'
    );
  }
  return target;
}

function run(args, target, options = {}) {
  return runCliInProcess(['audit', ...args, '--target', target], options);
}

function newArgs() {
  return [
    'new',
    '--work-unit', 'phase:4',
    '--covered-tasks', 'T-041,T-042',
    '--artifact', `commit:${FULL_A}`,
    '--goal', 'Deliver Phase 4.',
    '--completion-oracle', 'All covered outcomes and checks pass.',
    '--evidence', 'npm test (pass); integration suite (pass).',
  ];
}

function wireReport(overrides = {}) {
  return {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact: `commit:${FULL_A}`,
    covered_tasks: ['T-001', 'T-002'],
    invocation: { mode: 'host_subagent', reference: 'r-1', provenance: 'verified', receipt: 'auditor-receipt-0001' },
    perspectives: Object.fromEntries(
      ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
        .map(key => [key, `${key} body.`])
    ),
    assessment: 'Consolidated.',
    evidence_checked: 'npm test',
    verdict: 'needs_remediation',
    findings: [],
    ...overrides,
  };
}

async function seedRecord(target) {
  const result = await run(newArgs(), target);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

describe('transactional audit creation', () => {
  it('creates no residue when the prospective record is invalid', async () => {
    const target = makeTarget('invalid-new');
    const args = newArgs();
    args.splice(args.indexOf('--goal'), 2);
    const result = await run(args, target);
    // Missing --goal is a usage failure before any write.
    assert.equal(result.status, 2);
    assert.deepEqual(readdirSync(join(target, '.agenticloop', 'audits')), []);
  });

  it('fails before write on unknown covered tasks with a repair command', async () => {
    const target = makeTarget('unknown-tasks');
    const args = newArgs();
    args[args.indexOf('--covered-tasks') + 1] = 'T-041,T-999';
    const result = await run(args, target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown task 'T-999'/);
    assert.match(result.stderr, /repair: agenticloop audit new/);
    assert.deepEqual(readdirSync(join(target, '.agenticloop', 'audits')), []);
  });

  it('renders the structural artifact binding without prose repetition', async () => {
    const target = makeTarget('structural-binding');
    await seedRecord(target);
    const content = readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8');
    const evidence = content.split('## Evidence Available')[1].split('##')[0];
    assert.ok(evidence.includes(`- Candidate artifact: commit:${FULL_A}`));
    assert.ok(evidence.includes('npm test (pass); integration suite (pass).'));
    assert.equal((await run(['lint'], target)).status, 0);
  });

  it('leaves the existing record byte-identical on an invalid rebaseline', async () => {
    const target = makeTarget('bad-baseline');
    await seedRecord(target);
    const file = join(target, '.agenticloop', 'audits', 'AUD-001.md');
    const before = readFileSync(file, 'utf-8');
    const result = await run([
      'baseline', 'AUD-001',
      '--covered-tasks', 'T-041,T-999',
      '--evidence', 'fresh evidence',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /repair: agenticloop audit baseline AUD-001/);
    assert.equal(readFileSync(file, 'utf-8'), before);
  });

  it('rejects --canonicalize combined with --artifact as a usage error', async () => {
    const target = makeTarget('canonicalize-conflict');
    await seedRecord(target);
    const result = await run([
      'baseline', 'AUD-001', '--canonicalize', '--artifact', `commit:${FULL_B}`,
      '--evidence', 'x',
    ], target);
    assert.equal(result.status, 2);
  });
});

describe('legacy record migration', () => {
  function legacyRecord() {
    return [
      '---',
      'audit_id: AUD-001',
      'work_unit: phase:4',
      'audit_state: active',
      'human_resolution_ref:',
      'covered_tasks:',
      '  - T-041',
      'candidate_artifact: commit:0000000',
      'certified_artifact:',
      'certified_covered_tasks: []',
      'latest_verdict:',
      'audit_budget: 3',
      '---',
      '',
      '# AUD-001: Work-Unit Audit',
      '',
      '## Work Unit Goal',
      '',
      'Deliver Phase 4.',
      '',
      '## Completion Oracle',
      '',
      'Checks pass.',
      '',
      '## Covered Tasks',
      '',
      '- T-041',
      '',
      '## Frozen Baseline',
      '',
      '- Candidate artifact: commit:0000000',
      '',
      '## Evidence Available',
      '',
      '- Candidate artifact: commit:0000000',
      '',
      'Evidence for the candidate.',
      '',
      '## Accepted Decisions',
      '',
      'none',
      '',
      '## Known Limitations',
      '',
      'none',
      '',
      '## Audit History',
      '',
      'No audit runs are currently recorded.',
      '',
      '## Consolidated Findings',
      '',
      'No findings are currently open.',
      '',
      '## Remediation Tasks',
      '',
      'none',
      '',
      '## Final Certification',
      '',
      'This work unit is not currently certified.',
      '',
      '## Comments',
      '',
      '',
    ].join('\n');
  }

  it('flags a legacy record with the deterministic migration diagnostic', async () => {
    const target = makeTarget('legacy-flag');
    writeFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), legacyRecord(), 'utf-8');
    const lint = await run(['lint'], target);
    assert.equal(lint.status, 1);
    assert.match(lint.stdout, /audit baseline AUD-001 --canonicalize/);
  });

  it('canonicalizes atomically: upgrades schema, resolves the candidate, preserves history shape', async () => {
    const target = makeTarget('canonicalize');
    writeFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), legacyRecord(), 'utf-8');
    const result = await run([
      'baseline', 'AUD-001', '--canonicalize',
      '--evidence', 'Current integrated evidence.',
    ], target);
    // The legacy short sha cannot resolve outside a git work tree: explicit failure, no silent reinterpretation.
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot canonicalize legacy candidate/);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.auditSchemaVersion, null, 'a failed canonicalize must not rewrite the record');
  });

  it('migrates a legacy record with a full-sha candidate', async () => {
    const target = makeTarget('canonicalize-full');
    writeFileSync(
      join(target, '.agenticloop', 'audits', 'AUD-001.md'),
      legacyRecord().replaceAll('commit:0000000', `commit:${FULL_A}`),
      'utf-8'
    );
    const result = await run([
      'baseline', 'AUD-001', '--canonicalize',
      '--evidence', 'Current integrated evidence.',
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.auditSchemaVersion, 2);
    assert.equal(record.candidateArtifact, `commit:${FULL_A}`);
    assert.equal((await run(['lint'], target)).status, 0);
  });
});

describe('finding dispositions', () => {
  async function seedReportedRecord(target, findings) {
    await seedRecord(target);
    const report = wireReport({
      covered_tasks: ['T-041', 'T-042'],
      findings,
      verdict: findings.some(finding => finding.blocking) ? 'needs_remediation' : 'certified',
    });
    const reportPath = join(target, '.agenticloop', 'tmp-report.json');
    writeFileSync(reportPath, JSON.stringify(report), 'utf-8');
    const result = await run(['report', 'AUD-001', '--file', reportPath], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }

  const blockingFinding = {
    id: 'A-01', severity: 'high', blocking: true,
    claim: 'Config sources disagree', evidenceRefs: 'src/a.js:1',
    consequence: 'Wrong value', requiredOutcome: 'One source', verificationRequired: 'npm test',
  };
  const lowFinding = {
    id: 'A-02', severity: 'low', blocking: false,
    claim: 'Docs drift', evidenceRefs: 'docs/x.md:1',
    consequence: 'Confusion', requiredOutcome: 'Docs match', verificationRequired: 'Re-read',
  };

  it('records a typed disposition without certifying, resolving, or consuming budget', async () => {
    const target = makeTarget('disposition');
    await seedReportedRecord(target, [blockingFinding, lowFinding]);
    const before = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    const result = await run([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-02',
      '--type', 'follow_up', '--ref', 'T-055', '--note', 'tracked separately',
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /never resolves a blocking finding/);
    const after = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(after.auditState, before.auditState);
    assert.equal(after.auditBudget, before.auditBudget);
    assert.equal(after.history.length, before.history.length, 'disposition never appends an audit run');
    assert.equal(after.dispositions.length, 1);
    assert.equal(after.dispositions[0].type, 'follow_up');
    assert.equal(after.dispositions[0].run, 1);
    assert.equal(after.dispositions[0].findingId, 'A-02');
  });

  it('requires note and authority provenance for no_action', async () => {
    const target = makeTarget('no-action');
    await seedReportedRecord(target, [blockingFinding, lowFinding]);
    const result = await run([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-02', '--type', 'no_action',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--note/);
    const withNote = await run([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-02', '--type', 'no_action',
      '--note', 'Acceptable as-is', '--authority', 'human: Casey',
    ], target);
    assert.equal(withNote.status, 0, `${withNote.stdout}${withNote.stderr}`);
  });

  it('rejects a disposition for a finding the run did not report (run-qualified identity)', async () => {
    const target = makeTarget('run-qualified');
    await seedReportedRecord(target, [blockingFinding, lowFinding]);
    const result = await run([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-09', '--type', 'follow_up',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run-qualified|did not report/);
  });

  it('keeps a blocking finding blocking after disposition', async () => {
    const target = makeTarget('blocking-stays');
    await seedReportedRecord(target, [blockingFinding]);
    await run([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-01',
      '--type', 'remediation_task', '--ref', 'T-055',
    ], target);
    const gate = await run(['gate', 'AUD-001', '--json'], target);
    assert.equal(gate.status, 1);
    assert.match(gate.stdout, /A-01/);
  });
});

describe('report ingestion modes', () => {
  it('rejects every signed receipt mismatch before audit mutation or budget consumption', async () => {
    const target = makeTarget('protected-auditor-negative');
    await seedRecord(target);
    const operatorRoot = join(tmpDir, 'protected-auditor-negative-operator');
    mkdirSync(operatorRoot, { recursive: true });
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorRoot, trust);
    const report = wireReport({
      artifact: `commit:${FULL_A}`,
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'negative-auditor-ref', provenance: 'verified', receipt: null },
    });
    const baseInput = {
      receiptId: 'negative-auditor-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
      workUnit: 'phase:4', candidateArtifact: report.artifact, coveredTasks: report.covered_tasks,
      reportDigest: auditorReturnReportDigest(report),
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    };
    const makeReceipt = overrides => createAuditorReturnReceipt({ ...baseInput, ...overrides }, trust.privateKey);
    const forged = structuredClone(makeReceipt({}));
    // Corrupt a signature *data* character, not the trailing padding: the
    // signature grammar would reject damaged padding before verification runs,
    // so this keeps the case a genuine cryptographic forgery.
    forged.authentication.value = (value => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const body = value.slice('ed25519:'.length);
      return `ed25519:${alphabet[(alphabet.indexOf(body[0]) + 1) % 64]}${body.slice(1)}`;
    })(forged.authentication.value);
    const wrongRole = structuredClone(makeReceipt({}));
    wrongRole.producerRole = 'engineer';
    wrongRole.authentication.value = signHostPayload(auditorReturnReceiptSignaturePayload(wrongRole), trust.privateKey);
    const receipts = [
      forged,
      wrongRole,
      makeReceipt({ adapterId: 'wrong.adapter' }),
      makeReceipt({ keyId: 'wrong-key' }),
      makeReceipt({ targetRepository: 'file:/wrong-target' }),
      makeReceipt({ invocationReference: 'wrong-invocation' }),
      makeReceipt({ invocationMode: 'wrong-mode' }),
      makeReceipt({ workUnit: 'phase:other' }),
      makeReceipt({ candidateArtifact: `commit:${FULL_B}` }),
      makeReceipt({ coveredTasks: ['T-041'] }),
      makeReceipt({ reportDigest: `sha256:agenticloop.auditor-return-report.v1:${'b'.repeat(64)}` }),
      makeReceipt({ issuedAt: '2026-08-08T11:00:00.000Z', expiresAt: '2026-08-08T11:01:00.000Z' }),
    ];
    const loaded = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId,
      now: Date.parse('2026-08-08T12:00:00.000Z'), protectedBoundary: protectedHostBoundary(trust),
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('; '));
    const reportPath = join(target, '.agenticloop', 'tmp', 'negative-report.json');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    for (const [index, receipt] of receipts.entries()) {
      report.invocation.receipt = JSON.stringify(receipt);
      writeFileSync(reportPath, JSON.stringify(report), 'utf8');
      const result = await run(['report', 'AUD-001', '--file', reportPath], target, {
        auditProvenanceVerifier: loaded.verifier,
      });
      assert.equal(result.status, 1, `case ${index}: ${result.stdout}${result.stderr}`);
      const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf8'));
      assert.equal(record.history.length, 0, `case ${index} mutated audit history`);
    }
  });

  it('persists the exact authenticated Auditor return through the production verifier', async () => {
    const target = makeTarget('protected-auditor-return');
    await seedRecord(target);
    const operatorRoot = join(tmpDir, 'protected-auditor-operator');
    mkdirSync(operatorRoot, { recursive: true });
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorRoot, trust);
    const report = wireReport({
      artifact: `commit:${FULL_A}`,
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'protected-auditor-ref', provenance: 'verified', receipt: null },
    });
    const receipt = createAuditorReturnReceipt({
      receiptId: 'protected-auditor-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
      workUnit: 'phase:4', candidateArtifact: report.artifact, coveredTasks: report.covered_tasks,
      reportDigest: auditorReturnReportDigest(report),
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey);
    report.invocation.receipt = JSON.stringify(receipt);
    const loaded = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId,
      now: Date.parse('2026-08-08T12:00:00.000Z'), protectedBoundary: protectedHostBoundary(trust),
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('; '));
    const reportPath = join(target, '.agenticloop', 'tmp', 'protected-report.json');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report), 'utf-8');
    const result = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0].reportPayload.invocation.receipt, report.invocation.receipt);

    const replay = structuredClone(report);
    replay.invocation.reference = 'protected-auditor-ref-2';
    replay.invocation.receipt = null;
    replay.invocation.receipt = JSON.stringify(createAuditorReturnReceipt({
      receiptId: 'protected-auditor-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: replay.invocation.reference, invocationMode: replay.invocation.mode,
      workUnit: 'phase:4', candidateArtifact: replay.artifact, coveredTasks: replay.covered_tasks,
      reportDigest: auditorReturnReportDigest(replay),
      issuedAt: '2026-08-08T11:59:10.000Z', expiresAt: '2026-08-08T12:01:10.000Z',
    }, trust.privateKey));
    writeFileSync(reportPath, JSON.stringify(replay), 'utf8');
    const replayed = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(replayed.status, 1);
    assert.match(replayed.stderr, /receipt identity.*already used/i);
    const unchanged = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(unchanged.history.length, 1);
  });

  /**
   * The pre-write guard refuses a replay twice over: byte equality and receipt
   * identity. For identical bytes those are the same finding, so only the
   * byte-level diagnostic is emitted. The identity diagnostic is reserved for
   * the case byte equality cannot see - a re-minted receipt around a spent
   * receiptId, already covered above.
   */
  it('emits one receipt diagnostic for a byte-identical replay and consumes nothing', async () => {
    const target = makeTarget('identical-receipt-replay-cli');
    await seedRecord(target);
    const operatorRoot = join(tmpDir, 'identical-replay-operator');
    mkdirSync(operatorRoot, { recursive: true });
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorRoot, trust);
    const report = wireReport({
      artifact: `commit:${FULL_A}`,
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'identical-replay-ref', provenance: 'verified', receipt: null },
    });
    report.invocation.receipt = JSON.stringify(createAuditorReturnReceipt({
      receiptId: 'identical-replay-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: report.invocation.reference, invocationMode: report.invocation.mode,
      workUnit: 'phase:4', candidateArtifact: report.artifact, coveredTasks: report.covered_tasks,
      reportDigest: auditorReturnReportDigest(report),
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey));
    const loaded = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId,
      now: Date.parse('2026-08-08T12:00:00.000Z'), protectedBoundary: protectedHostBoundary(trust),
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('; '));
    const reportPath = join(target, '.agenticloop', 'tmp', 'identical-replay.json');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');

    const first = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const recordPath = join(target, '.agenticloop', 'audits', 'AUD-001.md');
    const afterFirst = readFileSync(recordPath, 'utf8');
    assert.equal(parseAuditRecord(afterFirst).history.length, 1);

    // Resubmit the identical bytes.
    const replayed = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(replayed.status, 1);
    // Count the operator-facing diagnostics only; the Auditor resume packet
    // echoes the same error list as one JSON line.
    const diagnostics = replayed.stderr
      .split('\n')
      .filter(line => line.startsWith('Cannot record audit report:'));
    const byteReplay = diagnostics.filter(line => /invocation receipt '.*' was already used/.test(line));
    const identityReplay = diagnostics.filter(line => /return receipt identity '.*' was already used/.test(line));
    assert.equal(byteReplay.length, 1, replayed.stderr);
    assert.equal(identityReplay.length, 0, replayed.stderr);
    // The reused invocation reference is a genuinely distinct identity and is
    // still reported on its own.
    assert.equal(
      diagnostics.filter(line => /invocation reference '.*' was already recorded/.test(line)).length,
      1,
      replayed.stderr
    );

    // The refused replay leaves the durable record - history and budgets alike -
    // byte-identical to the state the accepted run produced.
    assert.equal(readFileSync(recordPath, 'utf8'), afterFirst, 'a refused replay must not mutate the audit record');
  });

  it('signs the prepared normalized projection of a whitespace-bearing report and persists it', async () => {
    const target = makeTarget('prepared-auditor-return');
    await seedRecord(target);
    const operatorRoot = join(tmpDir, 'prepared-auditor-operator');
    mkdirSync(operatorRoot, { recursive: true });
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorRoot, trust);

    // The Auditor's raw wire document carries permitted surrounding whitespace
    // and non-canonical forms throughout. A protected host cannot digest this
    // document directly; it must prepare it first.
    const raw = wireReport({
      artifact: `  commit:${FULL_A}\n`,
      covered_tasks: [' T-041 ', '\tT-042\n'],
      invocation: {
        mode: ' host_subagent ', reference: '  prepared-auditor-ref\n',
        provenance: ' VERIFIED ',
      },
      assessment: '\n  Consolidated assessment with surrounding whitespace.  ',
      evidence_checked: '\tnpm test (pass)  ',
      perspectives: Object.fromEntries(
        ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
          .map(key => [key, `  ${key} body.\n`])
      ),
      findings: [{
        id: ' A-01 ', severity: ' HIGH ', blocking: 'true',
        claim: '  A blocking claim  ', evidenceRefs: '\tsrc/x.js:1',
        consequence: 'Breakage  ', requiredOutcome: '  Fix it',
        verificationRequired: ' Re-run the suite\n',
      }],
      verdict: 'needs_remediation',
    });

    const prepared = prepareAuditorReturnReportForSigning(raw);
    assert.equal(prepared.ok, true, prepared.errors.join('\n'));
    assert.notEqual(
      prepared.digest,
      auditorReturnReportDigest(raw),
      'the raw document must not already equal the normalized identity'
    );

    // Step 2: the host signs exactly the digest it was handed.
    const receipt = createAuditorReturnReceipt({
      receiptId: 'prepared-auditor-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: prepared.report.invocation.reference,
      invocationMode: prepared.report.invocation.mode,
      workUnit: 'phase:4',
      candidateArtifact: prepared.report.artifact,
      coveredTasks: prepared.report.covered_tasks,
      reportDigest: prepared.digest,
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey);

    // Step 3: the receipt goes into the normalized report the host was handed.
    const submitted = structuredClone(prepared.report);
    submitted.invocation.receipt = JSON.stringify(receipt);

    const loaded = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId,
      now: Date.parse('2026-08-08T12:00:00.000Z'), protectedBoundary: protectedHostBoundary(trust),
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('; '));
    const reportPath = join(target, '.agenticloop', 'tmp', 'prepared-report.json');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(submitted), 'utf8');

    // Step 4: the CLI derives the identical digest and the genuine receipt verifies.
    const result = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0].invocationProvenance, 'verified');
    assert.equal(record.history[0].reportPayload.assessment, 'Consolidated assessment with surrounding whitespace.');
    assert.equal(record.history[0].reportPayload.findings[0].severity, 'high');
    assert.equal(record.history[0].reportPayload.findings[0].blocking, true);

    // Mutating a substantive field after signing invalidates the binding, and
    // the mutated report leaves no residue in durable history.
    const mutated = structuredClone(submitted);
    mutated.assessment = 'Rewritten after signing.';
    mutated.invocation.reference = 'prepared-auditor-ref-2';
    writeFileSync(reportPath, JSON.stringify(mutated), 'utf8');
    const rejected = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(rejected.status, 1);
    const unchanged = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(unchanged.history.length, 1);
  });

  it('refuses a receipt signed over the raw document instead of the prepared projection', async () => {
    const target = makeTarget('raw-digest-auditor-return');
    await seedRecord(target);
    const operatorRoot = join(tmpDir, 'raw-digest-auditor-operator');
    mkdirSync(operatorRoot, { recursive: true });
    const trust = createTestHostTrust({ target });
    writeHostTrustStore(operatorRoot, trust);
    const raw = wireReport({
      artifact: `commit:${FULL_A}`,
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'raw-digest-ref', provenance: 'verified' },
      assessment: '  Consolidated with whitespace.  ',
    });
    const prepared = prepareAuditorReturnReportForSigning(raw);
    assert.equal(prepared.ok, true, prepared.errors.join('\n'));
    // The host takes the documented shortcut this correction exists to remove.
    const wrongReceipt = createAuditorReturnReceipt({
      receiptId: 'raw-digest-receipt', adapterId: trust.adapterId, keyId: trust.keyId,
      targetRepository: trust.repositoryIdentity,
      invocationReference: prepared.report.invocation.reference,
      invocationMode: prepared.report.invocation.mode,
      workUnit: 'phase:4', candidateArtifact: prepared.report.artifact,
      coveredTasks: prepared.report.covered_tasks,
      reportDigest: auditorReturnReportDigest(raw),
      issuedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:01:00.000Z',
    }, trust.privateKey);
    const submitted = structuredClone(prepared.report);
    submitted.invocation.receipt = JSON.stringify(wrongReceipt);
    const loaded = loadAuditorReturnReceiptVerifier({
      target, operatorTrustRoot: operatorRoot, adapterId: trust.adapterId,
      now: Date.parse('2026-08-08T12:00:00.000Z'), protectedBoundary: protectedHostBoundary(trust),
    });
    assert.equal(loaded.ok, true, loaded.errors?.join('; '));
    const reportPath = join(target, '.agenticloop', 'tmp', 'raw-digest-report.json');
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(submitted), 'utf8');
    const result = await run(['report', 'AUD-001', '--file', reportPath], target, {
      auditProvenanceVerifier: loaded.verifier,
    });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.history.length, 0);
  });

  async function seed(target) {
    await seedRecord(target);
  }

  it('persists a complete report from a path containing spaces', async () => {
    const target = makeTarget('spaces path');
    await seed(target);
    const spacedDir = join(target, 'reports with spaces');
    mkdirSync(spacedDir, { recursive: true });
    const reportPath = join(spacedDir, 'run 1.json');
    writeFileSync(reportPath, JSON.stringify(wireReport({ covered_tasks: ['T-041', 'T-042'] })), 'utf-8');
    const result = await run(['report', 'AUD-001', '--file', reportPath], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0].reportPayload.perspectives.risk, 'risk body.');
  });

  it('persists the same canonical record from piped stdin as from a file', async () => {
    const report = JSON.stringify(wireReport({ covered_tasks: ['T-041', 'T-042'] }));
    const targetFile = makeTarget('via-file');
    await seed(targetFile);
    const filePath = join(targetFile, 'report.json');
    writeFileSync(filePath, report, 'utf-8');
    assert.equal((await run(['report', 'AUD-001', '--file', filePath], targetFile)).status, 0);

    const targetStdin = makeTarget('via-stdin');
    await seed(targetStdin);
    const stdinResult = await runCliInProcess(
      ['audit', 'report', 'AUD-001', '--stdin', '--target', targetStdin],
      { stdin: scriptedStdin([report]) }
    );
    assert.equal(stdinResult.status, 0, `${stdinResult.stdout}${stdinResult.stderr}`);

    const fromFile = readFileSync(join(targetFile, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8');
    const fromStdin = readFileSync(join(targetStdin, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8');
    assert.equal(fromStdin, fromFile);
  });

  it('fails conflicting source modes before any file or stdin read', async () => {
    const target = makeTarget('mode-conflict');
    await seed(target);
    const result = await runCliInProcess(
      ['audit', 'report', 'AUD-001', '--stdin', '--verdict', 'certified', '--target', target],
      { stdin: scriptedStdin(['{"never":"read"}']) }
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /conflict/);
    const fileConflict = await run([
      'report', 'AUD-001', '--file', 'nonexistent.json', '--finding-json', '[]',
    ], target);
    assert.equal(fileConflict.status, 2);
    assert.match(fileConflict.stderr, /conflict/);
  });

  it('keeps legacy inline ingestion compatible and visibly versioned', async () => {
    const target = makeTarget('legacy-inline');
    await seed(target);
    const result = await run([
      'report', 'AUD-001',
      '--verdict', 'needs_remediation',
      '--invocation-mode', 'host_subagent',
      '--invocation-ref', 'legacy-1',
      '--assessment', 'Legacy assessment.',
      '--evidence', 'npm test',
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.history[0].reportFormat, 'legacy_inline_v1');
    assert.equal(record.history[0].reportPayload.perspectives, undefined);
  });

  it('refuses an unauthenticated authoritative receipt without consuming audit budget', async () => {
    const target = makeTarget('receipt-asserted');
    await seed(target);
    const reportPath = join(target, 'report.json');
    writeFileSync(reportPath, JSON.stringify(wireReport({
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'receipt-claim', provenance: 'verified', receipt: 'claimed-receipt' },
    })), 'utf-8');
    const result = await run(['report', 'AUD-001', '--file', reportPath], target, { auditProvenanceVerifier: null });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const record = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-001.md'), 'utf-8'));
    assert.equal(record.history.length, 0);
    assert.equal((await run(['lint'], target)).status, 0);
  });

  it('rejects reused invocation references and receipts before a second audit write', async () => {
    const target = makeTarget('receipt-unique');
    await seedRecord(target);
    const second = await run([
      'new', '--work-unit', 'phase:5', '--covered-tasks', 'T-055', '--artifact', `commit:${FULL_A}`,
      '--goal', 'Deliver Phase 5.', '--completion-oracle', 'All covered outcomes pass.', '--evidence', 'npm test',
    ], target);
    assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
    const firstPath = join(target, 'first.json');
    const secondPath = join(target, 'second.json');
    const first = wireReport({
      covered_tasks: ['T-041', 'T-042'],
      invocation: { mode: 'host_subagent', reference: 'shared-reference', provenance: 'verified', receipt: 'shared-receipt' },
    });
    writeFileSync(firstPath, JSON.stringify(first), 'utf-8');
    writeFileSync(secondPath, JSON.stringify({ ...first, covered_tasks: ['T-055'] }), 'utf-8');
    assert.equal((await run(['report', 'AUD-001', '--file', firstPath], target)).status, 0);
    const rejected = await run(['report', 'AUD-002', '--file', secondPath], target);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /invocation reference 'shared-reference'/);
    assert.equal((await run(['lint'], target)).status, 0);
    const secondRecord = parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', 'AUD-002.md'), 'utf-8'));
    assert.equal(secondRecord.history.length, 0);
  });

  function assertAuditorResumePacket(stderr) {
    const line = stderr.split('\n').find(entry => entry.includes('Auditor resume packet:'));
    assert.ok(line, `expected an Auditor resume packet in stderr:\n${stderr}`);
    const packet = JSON.parse(line.slice(line.indexOf('{')));
    assert.equal(packet.kind, 'agenticloop.auditor-report-resume');
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.ownerRole, 'auditor');
    assert.equal(packet.nextResumableTransition, 'resubmit_auditor_report');
    assert.equal(packet.evidence.state, 'malformed');
    assert.ok(packet.digest.startsWith('sha256:agenticloop.auditor-report-resume.v1:'));
    return packet;
  }

  it('returns malformed --file JSON to the Auditor without a durable write or budget consumption', async () => {
    const target = makeTarget('malformed-file');
    await seed(target);
    const recordPath = join(target, '.agenticloop', 'audits', 'AUD-001.md');
    const before = readFileSync(recordPath, 'utf-8');
    const reportPath = join(target, 'broken.json');
    writeFileSync(reportPath, '{ this is not valid json', 'utf-8');
    const result = await run(['report', 'AUD-001', '--file', reportPath], target);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /not valid JSON/);
    assertAuditorResumePacket(result.stderr);
    assert.equal(readFileSync(recordPath, 'utf-8'), before, 'malformed JSON performs no durable write and consumes no audit budget');
  });

  it('returns malformed --stdin JSON to the Auditor without a durable write or budget consumption', async () => {
    const target = makeTarget('malformed-stdin');
    await seed(target);
    const recordPath = join(target, '.agenticloop', 'audits', 'AUD-001.md');
    const before = readFileSync(recordPath, 'utf-8');
    const result = await runCliInProcess(
      ['audit', 'report', 'AUD-001', '--stdin', '--target', target],
      { stdin: scriptedStdin(['{ this is not valid json']) }
    );
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /not valid JSON/);
    assertAuditorResumePacket(result.stderr);
    assert.equal(readFileSync(recordPath, 'utf-8'), before, 'malformed JSON performs no durable write and consumes no audit budget');
  });

  it('keeps a missing report file distinct from a malformed Auditor payload', async () => {
    const target = makeTarget('missing-report-file');
    await seed(target);
    const result = await run(['report', 'AUD-001', '--file', join(target, 'does-not-exist.json')], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /report file not found/);
    assert.doesNotMatch(result.stderr, /Auditor resume packet/);
  });
});
