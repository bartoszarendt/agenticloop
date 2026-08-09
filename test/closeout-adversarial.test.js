/**
 * Adversarial closeout regression: the reproduced closeout-integrity failure
 * sequence. A premature freehand complete marker cannot stand, the first
 * invalid transition stops the flow, and the corrected public workflow
 * completes with provenance.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { runCliInProcess } from './helpers/run-cli.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-adversarial-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function git(target, args) {
  return execSync(`git ${args}`, { cwd: target, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), [
    '---',
    'setup_status: confirmed',
    'development_stage: expansion',
    'task_backend: files',
    'work_unit_audit: enabled',
    'grouping_profile: milestone',
    '---',
    '',
    '# Project',
    '',
  ].join('\n'), 'utf-8');
  git(target, 'init -q');
  git(target, 'config user.email test@example.com');
  git(target, 'config user.name Test');
  writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf-8');
  git(target, 'add -A');
  git(target, 'commit -qm init');
  return target;
}

function commitAll(target, message) {
  git(target, 'add -A');
  git(target, `commit -qm "${message}"`);
  return `commit:${git(target, 'rev-parse HEAD')}`;
}

function writeTask(target, taskId, status, grouping) {
  writeFileSync(join(target, '.agenticloop', 'tasks', `${taskId}.md`), [
    '---',
    `task_id: ${taskId}`,
    `status: ${status}`,
    '---',
    '',
    `# ${taskId}`,
    '',
    '## Grouping',
    '',
    grouping,
    '',
    '## Required Checks',
    '',
    '- [RC-1] command: `npm test`',
    '',
    '## Comments',
    '',
    '',
  ].join('\n'), 'utf-8');
}

function run(args, target) {
  const compatibility = args[0] === 'closeout' && args[1] === 'prepare'
    ? ['--legacy-unactivated', '--legacy-reason', 'historical unactivated incident fixture']
    : [];
  return runCliInProcess(args.concat(compatibility, ['--target', target]), {
    operatorActivationRoot: join(tmpDir, 'operator-activation'),
    stdinIsTTY: true, isTTY: true, ci: false,
    promptFactory: () => ({ ask: async () => 'waive', close() {} }),
  });
}

function wireReport(artifact, coveredTasks, overrides = {}) {
  return {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact,
    covered_tasks: coveredTasks,
    invocation: { mode: 'host_subagent', reference: `ref-${Math.random().toString(36).slice(2)}`, provenance: 'verified', receipt: `auditor-receipt-${Math.random().toString(36).slice(2)}` },
    perspectives: Object.fromEntries(
      ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
        .map(key => [key, `${key} body with substantive content.`])
    ),
    assessment: 'Consolidated assessment across all six perspectives.',
    evidence_checked: 'npm test (pass); npx agenticloop validate (pass)',
    verdict: 'certified',
    findings: [],
    ...overrides,
  };
}

describe('reproduced closeout-integrity failure sequence', () => {
  it('stops at the first invalid transition, then completes through the corrected workflow', async () => {
    const target = makeTarget('incident');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    writeTask(target, 'T-002', 'accepted', 'milestone:M00');
    writeTask(target, 'T-003', 'accepted', 'milestone:M00');

    // 1. The historical failure: a freehand complete marker without an audit.
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-003.md');
    writeFileSync(
      carrierFile,
      readFileSync(carrierFile, 'utf-8') + '\nAGENT_CLOSEOUT_STATUS: complete\n',
      'utf-8'
    );
    commitAll(target, 'integrated work plus a premature marker');

    // 2. Status exposes it as legacy history, never valid completion.
    const legacyStatus = await run(['closeout', 'status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(legacyStatus.status, 1);
    assert.ok(legacyStatus.stdout, legacyStatus.stderr);
    assert.equal(JSON.parse(legacyStatus.stdout).state, 'legacy_unprovenanced');

    // 3. Preparation emits a truthful correction packet (first invalid transition stops here).
    const correctionPath = join(target, '.agenticloop', 'tmp', 'correction.json');
    const prepareCorrection = await run([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--output', correctionPath,
    ], target);
    assert.equal(prepareCorrection.status, 1);
    const correction = JSON.parse(readFileSync(correctionPath, 'utf-8'));
    assert.equal(correction.recommended_status, 'follow_up_required');
    assert.ok(correction.reasons.some(item => item.category === 'audit_missing'));

    // 4. Recording the correction supersedes the premature marker.
    const recordedCorrection = await run(['closeout', 'record', '--packet', correctionPath, '--yes'], target);
    assert.equal(recordedCorrection.status, 0, `${recordedCorrection.stdout}${recordedCorrection.stderr}`);
    const carrier = readFileSync(carrierFile, 'utf-8');
    assert.ok(carrier.includes('AGENT_CLOSEOUT_STATUS: follow_up_required'));
    assert.ok(carrier.includes('AGENT_CLOSEOUT_SUPERSEDES'));

    // 5. The serious incident gets a durable improvement reference immediately.
    //    References must resolve against live state: the recorded correction
    //    marker's gate digest and the marker-carrier task are durable evidence.
    const proposal = await run([
      'improvement', 'new',
      '--title', 'Mechanically enforce work-unit audit before closeout',
      '--source-ref', correction.digest,
      '--source-ref', 'T-003',
      '--target-surface', 'core-methodology',
      '--target-path', 'agenticloop/skills/task-closeout/SKILL.md',
      '--risk-level', 'high',
    ], target);
    assert.equal(proposal.status, 0, `${proposal.stdout}${proposal.stderr}`);
    const proposalId = JSON.parse((await run(['improvement', 'status', '--json'], target)).stdout)[0].improvement_id;

    // 6. The corrected workflow: audit creation succeeds on the first command
    //    with concise evidence (no magic substring required).
    const artifact = `commit:${git(target, 'rev-parse HEAD')}`;
    const created = await run([
      'audit', 'new',
      '--work-unit', 'milestone:M00',
      '--covered-tasks', 'T-001,T-002,T-003',
      '--artifact', artifact,
      '--goal', 'Deliver the milestone outcome.',
      '--completion-oracle', 'Observable completion holds.',
      '--evidence', 'npm test (pass); integration suite (pass)',
    ], target);
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
    commitAll(target, 'record audit');

    // 7. The Auditor report persists losslessly from a file; findings route to dispositions.
    const reportPath = join(target, '.agenticloop', 'tmp', 'report.json');
    writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001', 'T-002', 'T-003'], {
      findings: [{
        id: 'A-01', severity: 'low', blocking: false,
        claim: 'closeout docs predate the mechanical gate', evidenceRefs: 'docs/closeout.md:3',
        consequence: 'operators may follow the old flow', requiredOutcome: 'docs describe the gate',
        verificationRequired: 're-read after edit',
      }],
    })), 'utf-8');
    const reported = await run(['audit', 'report', 'AUD-001', '--file', reportPath], target);
    assert.equal(reported.status, 0, `${reported.stdout}${reported.stderr}`);

    // 8. Terminal closeout waits for the non-blocking disposition.
    const prematurePrepare = await run(['closeout', 'prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(prematurePrepare.status, 1);
    assert.ok(JSON.parse(prematurePrepare.stdout).reasons.some(item => item.category === 'undisposed_findings'));

    const disposed = await run([
      'audit', 'disposition', 'AUD-001', '--run', '1', '--finding', 'A-01',
      '--type', 'follow_up', '--ref', proposalId, '--note', 'docs follow-up tracked',
    ], target);
    assert.equal(disposed.status, 0, `${disposed.stdout}${disposed.stderr}`);
    commitAll(target, 'record disposition');

    // 9. Full prepare -> record -> status cycle with the improvement reference.
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await run([
      'closeout', 'prepare', '--work-unit', 'milestone:M00',
      '--artifact', artifact, '--improvement-ref', proposalId, '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.completion_eligible, true);
    assert.deepEqual(packet.improvement_refs, [proposalId]);

    const recorded = await run(['closeout', 'record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const finalCarrier = readFileSync(carrierFile, 'utf-8');
    assert.ok(finalCarrier.includes('AGENT_CLOSEOUT_STATUS: complete'));

    // 10. Delete the transient packet: status still verifies by digest.
    unlinkSync(packetPath);
    const finalStatus = await run(['closeout', 'status', '--work-unit', 'milestone:M00'], target);
    assert.equal(finalStatus.status, 0, `${finalStatus.stdout}${finalStatus.stderr}`);
    assert.match(finalStatus.stdout, /complete \(current\)/);
  });
});

describe('invocation provenance registry', () => {
  it('rejects a host receipt reused across audit records', async () => {
    const target = makeTarget('receipt-reuse');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    writeTask(target, 'T-004', 'accepted', 'milestone:M01');
    const artifact = commitAll(target, 'integrate');
    for (const [workUnit, tasks] of [['milestone:M00', 'T-001'], ['milestone:M01', 'T-004']]) {
      assert.equal((await run([
        'audit', 'new', '--work-unit', workUnit, '--covered-tasks', tasks,
        '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
      ], target)).status, 0);
    }
    const receipt = 'host-receipt-shared-1';
    for (const [auditId, tasks] of [['AUD-001', ['T-001']], ['AUD-002', ['T-004']]]) {
      const reportPath = join(target, '.agenticloop', 'tmp', `${auditId}.json`);
      writeFileSync(reportPath, JSON.stringify(wireReport(artifact, tasks, {
        invocation: { mode: 'host_subagent', reference: `ref-${auditId}`, provenance: 'verified', receipt },
      })), 'utf-8');
      const reported = await run(['audit', 'report', auditId, '--file', reportPath], target);
      if (auditId === 'AUD-001') {
        assert.equal(reported.status, 0, `${reported.stdout}${reported.stderr}`);
      } else {
        assert.equal(reported.status, 1);
        assert.match(reported.stderr, /invocation receipt 'host-receipt-shared-1'/);
      }
    }
    const lint = await run(['audit', 'lint'], target);
    assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`);
  });

  it('rejects an unverifiable fresh Auditor report without consuming audit budget', async () => {
    const target = makeTarget('asserted');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'integrate');
    assert.equal((await run([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    const reportPath = join(target, '.agenticloop', 'tmp', 'r.json');
    writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'], {
      invocation: { mode: 'host_subagent', reference: 'ref-asserted', provenance: 'asserted' },
    })), 'utf-8');
    assert.equal((await run(['audit', 'report', 'AUD-001', '--file', reportPath], target)).status, 1);
    const status = await run(['audit', 'status', 'AUD-001', '--json'], target);
    assert.equal(JSON.parse(status.stdout).completed_audits, 0);
    // A verified claim without a receipt is rejected.
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    const artifact2 = commitAll(target, 'remediation');
    const baseline = await run([
      'audit', 'baseline', 'AUD-001', '--artifact', artifact2, '--evidence', 'fresh evidence',
    ], target);
    assert.equal(baseline.status, 0, `${baseline.stdout}${baseline.stderr}`);
    const fakePath = join(target, '.agenticloop', 'tmp', 'r2.json');
    writeFileSync(fakePath, JSON.stringify(wireReport(artifact2, ['T-001'], {
      invocation: { mode: 'host_subagent', reference: 'ref-fake', provenance: 'verified' },
    })), 'utf-8');
    const fake = await run(['audit', 'report', 'AUD-001', '--file', fakePath], target);
    assert.equal(fake.status, 1);
    assert.match(fake.stderr, /receipt/);
  });
});

describe('doctor audit-due diagnostics', () => {  it('reports a grouped work unit with accepted tasks and no audit as audit due', async () => {
    const target = makeTarget('doctor-due');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    writeTask(target, 'T-002', 'accepted', 'milestone:M00');
    const doctor = await run(['doctor'], target);
    // doctor stays a diagnostic command: reporting audit-due is not a failure.
    assert.equal(doctor.status, 0, `${doctor.stdout}${doctor.stderr}`);
    assert.match(doctor.stdout, /milestone:M00: audit due/);
  });

  it('does not report due state for flat projects (membership is never guessed)', async () => {
    const target = makeTarget('doctor-flat');
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      readFileSync(join(target, '.agenticloop', 'project.md'), 'utf-8')
        .replace('grouping_profile: milestone', 'grouping_profile: flat'),
      'utf-8'
    );
    writeTask(target, 'T-001', 'accepted', '');
    const doctor = await run(['doctor'], target);
    assert.equal(doctor.status, 0);
    assert.ok(!doctor.stdout.includes('audit due'));
  });
});

describe('event-logged invocation cross-check', () => {
  function enableEventLogging(target) {
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      readFileSync(join(target, '.agenticloop', 'project.md'), 'utf-8')
        .replace('work_unit_audit: enabled', 'work_unit_audit: enabled\nevent_logging: enabled\nevent_logging_command: "npx agenticloop event-logging append"'),
      'utf-8'
    );
  }

  it('requires a matching Auditor role.invoked event when event logging is enabled', async () => {
    const target = makeTarget('event-xcheck');
    enableEventLogging(target);
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'integrate');
    assert.equal((await run([
      'audit', 'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    const reference = 'invoke-no-event';
    const reportPath = join(target, '.agenticloop', 'tmp', 'r.json');
    writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'], {
      invocation: { mode: 'host_subagent', reference, provenance: 'verified', receipt: 'event-log-receipt' },
    })), 'utf-8');
    const missing = await run(['audit', 'report', 'AUD-001', '--file', reportPath], target);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /role\.invoked/);

    // Record the delegation event with the matching invocation reference.
    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), `${JSON.stringify({
      event_id: '11111111-1111-4111-8111-111111111111',
      event_type: 'role.invoked',
      task_id: 'T-001',
      role: 'orchestrator',
      occurred_at: '2026-07-27T00:00:00.000Z',
      outcome: 'success',
      data: {
        target_role: 'auditor',
        delegation_mode: 'host_subagent',
        fallback: false,
        invocation_reference: reference,
      },
    })}\n`, 'utf-8');
    const matched = await run(['audit', 'report', 'AUD-001', '--file', reportPath], target);
    assert.equal(matched.status, 0, `${matched.stdout}${matched.stderr}`);
  });
});
