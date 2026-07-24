/**
 * Phase 27 end-to-end lifecycle, deterministic and fixture-driven.
 *
 * Walks one work unit through: accepted tasks -> initial audit -> needs
 * remediation -> remediation integrated -> old certificate goes stale -> fresh
 * invocation audits the new candidate -> certification unlocks closeout ->
 * separately, five non-certifying reports exhaust the budget -> and an explicit
 * disabled configuration bypasses the gate visibly. No model invocation, no
 * credentials, no network.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess } from './helpers/run-cli.js';
import {
  evaluateAuditCloseoutGate,
  findAuditRecord,
  completedAuditRuns,
} from '../src/audit-record.js';
import { validateAuditRecords } from '../src/audit-record.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-e2e-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function projectMap(mode) {
  return [
    '---',
    'setup_status: confirmed',
    'setup_confirmed_at: 2026-07-24',
    'setup_confirmed_by: human',
    'development_stage: expansion',
    'task_backend: files',
    `work_unit_audit: ${mode}`,
    'grouping_profile: phase',
    '---',
    '',
    '# Project',
    '',
    '## Verification Operating Facts',
    '',
    'No project-wide verification operating facts are currently recorded.',
    '',
  ].join('\n');
}

function makeTarget(name, mode = 'enabled') {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), projectMap(mode), 'utf-8');
  for (const taskId of ['T-041', 'T-042', 'T-055']) {
    writeFileSync(
      join(target, '.agenticloop', 'tasks', `${taskId}.md`),
      `---\ntask_id: ${taskId}\nstatus: accepted\n---\n`,
      'utf-8'
    );
  }
  return target;
}

function audit(target, args) {
  return runCliInProcess(['audit', ...args, '--target', target]);
}

function newAuditArgs(coveredTasks, artifact) {
  return [
    'new',
    '--work-unit', 'phase:4',
    '--covered-tasks', coveredTasks,
    '--artifact', artifact,
    '--goal', 'Deliver the complete Phase 4 outcome.',
    '--completion-oracle', 'All covered outcomes are integrated and checks pass.',
    '--evidence', `Integrated verification bound to ${artifact}.`,
  ];
}

async function reportRun(target, { verdict, ref, artifact, findings }) {
  const args = [
    'report', 'AUD-001',
    '--verdict', verdict,
    '--invocation-mode', 'host_subagent',
    '--invocation-ref', ref,
    '--assessment', 'Consolidated assessment across all six audit perspectives.',
    '--evidence', 'npm test (pass); npx agenticloop validate (pass)',
  ];
  if (artifact) args.push('--artifact', artifact);
  if (findings) args.push('--finding-json', findings);
  return audit(target, args);
}

const BLOCKING_FINDING = JSON.stringify([{
  id: 'A-01',
  severity: 'high',
  blocking: true,
  claim: 'Two config sources disagree after integration',
  evidenceRefs: 'src/config.js:10, src/settings.js:22',
  consequence: 'The integrated system reads the wrong value at runtime',
  requiredOutcome: 'One source of truth for the setting',
  verificationRequired: 'npm test plus a new cross-module integration test',
}]);

// A completed work unit gate is evaluated with all covered tasks accepted.
function gate(target, mode = 'enabled') {
  return evaluateAuditCloseoutGate(target, {
    workUnit: 'phase:4',
    workUnitAudit: mode,
    taskStatus: () => 'accepted',
  });
}

describe('audit end-to-end lifecycle', () => {
  it('runs remediation, staleness, fresh re-audit, and certification-unlocks-closeout', async () => {
    const target = makeTarget('lifecycle');

    // Accepted tasks integrated into one candidate -> create the audit record.
    assert.equal(
      (await audit(target, newAuditArgs('T-041,T-042', 'commit:aaa111'))).status,
      0
    );

    // Default-enabled project cannot complete before any audit certifies.
    assert.equal(gate(target).allowed, false);

    // Initial audit -> needs remediation.
    assert.equal((await reportRun(target, { verdict: 'needs_remediation', ref: 'ref-1', findings: BLOCKING_FINDING })).status, 0);
    assert.equal(gate(target).allowed, false, 'a blocking finding must keep closeout locked');

    // Remediation is implemented and integrated as ordinary tasks (T-055 added).
    // Refresh the candidate and covered-task boundary -> any stale certification clears.
    assert.equal(
      (await audit(target, [
        'baseline', 'AUD-001',
        '--artifact', 'commit:bbb222',
        '--covered-tasks', 'T-041,T-042,T-055',
        '--evidence', 'Integrated verification bound to commit:bbb222.',
      ])).status,
      0
    );

    // A report bound to the old candidate is rejected: the baseline moved.
    const staleReport = await reportRun(target, { verdict: 'certified', ref: 'ref-2', artifact: 'commit:aaa111' });
    assert.equal(staleReport.status, 1);
    assert.match(staleReport.stderr, /does not match the frozen candidate/);

    // Fresh invocation audits the new exact candidate and certifies it.
    assert.equal((await reportRun(target, { verdict: 'certified', ref: 'ref-2', artifact: 'commit:bbb222' })).status, 0);

    const closeout = gate(target);
    assert.equal(closeout.allowed, true, closeout.reasons.join('; '));
    assert.equal(closeout.state, 'certified');
    assert.equal(closeout.auditId, 'AUD-001');

    // The record still validates and history has exactly two runs.
    assert.deepEqual(validateAuditRecords(target, { taskIdRegex: '^T-\\d{3,}$' }).errors, []);
    assert.equal(completedAuditRuns(findAuditRecord(target, 'phase:4').record), 2);

    // Reopening a covered task re-locks closeout even though the certificate matches.
    const reopened = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      taskStatus: id => (id === 'T-055' ? 'in-progress' : 'accepted'),
    });
    assert.equal(reopened.allowed, false);
  });

  it('exhausts the budget after five non-certifying reports without inventing a verdict', async () => {
    const target = makeTarget('budget');
    await audit(target, newAuditArgs('T-041', 'commit:ccc333'));

    for (let index = 1; index <= 5; index++) {
      const verdict = index === 5 ? 'needs_human_decision' : 'needs_remediation';
      assert.equal((await reportRun(target, { verdict, ref: `ref-${index}` })).status, 0, `run ${index}`);
    }

    const record = findAuditRecord(target, 'phase:4').record;
    assert.equal(record.auditState, 'awaiting_human');
    assert.equal(record.auditBlockedReason, '');
    // The blocked state preserves the fifth Auditor's actual verdict; it is not
    // rewritten to a manufactured needs_human_decision because the budget ran out.
    assert.equal(record.latestVerdict, 'needs_human_decision');
    assert.equal(record.history.at(-1).verdict, 'needs_human_decision');

    const closeout = gate(target);
    assert.equal(closeout.allowed, false);
    assert.equal(closeout.state, 'audit_awaiting_human');
  });

  it('bypasses the gate visibly when work_unit_audit is explicitly disabled', async () => {
    const target = makeTarget('disabled', 'disabled');
    await audit(target, newAuditArgs('T-041', 'commit:ddd444'));
    await reportRun(target, { verdict: 'needs_remediation', ref: 'ref-1', findings: BLOCKING_FINDING });

    const closeout = gate(target, 'disabled');
    assert.equal(closeout.allowed, true);
    assert.equal(closeout.state, 'audit_disabled');
    assert.equal(closeout.optOut, true, 'the opt-out must be visible in closeout evidence');

    // Opting out never claims certification, and the audit history is preserved.
    assert.notEqual(closeout.state, 'certified');
    assert.equal(completedAuditRuns(findAuditRecord(target, 'phase:4').record), 1);

    // Re-enabling restores the gate and again requires a current certificate.
    assert.equal(gate(target, 'enabled').allowed, false);
  });

  it('does not retroactively invalidate a historical work unit that has no audit record', () => {
    // A project that predates Phase 27 has no audit records. Validating audit
    // records for that project must be clean; the gate only blocks a NEW
    // closeout, it does not reach back into already-published markers.
    const target = makeTarget('historical');
    assert.deepEqual(validateAuditRecords(target).errors, []);
  });
});
