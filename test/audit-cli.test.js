/**
 * `agenticloop audit` CLI tests.
 *
 * Runs the command in-process (no subprocess). Exercises the mechanical
 * persistence path: create, refresh baseline, append a report, show status,
 * lint, and the human-approved budget override. Deterministic fixtures only.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess } from './helpers/run-cli.js';
import { parseAuditRecord } from '../src/audit-record.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-cli-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const PROJECT_MAP = [
  '---',
  'setup_status: confirmed',
  'setup_confirmed_at: 2026-07-24',
  'setup_confirmed_by: human',
  'development_stage: expansion',
  'task_backend: files',
  'work_unit_audit: enabled',
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

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), PROJECT_MAP, 'utf-8');
  for (const taskId of ['T-041', 'T-042', 'T-055', 'T-099']) {
    writeFileSync(
      join(target, '.agenticloop', 'tasks', `${taskId}.md`),
      `---\ntask_id: ${taskId}\nstatus: accepted\n---\n`,
      'utf-8'
    );
  }
  return target;
}

function run(args, target) {
  return runCliInProcess(['audit', ...args, '--target', target]);
}

function readRecord(target, auditId = 'AUD-001') {
  return parseAuditRecord(readFileSync(join(target, '.agenticloop', 'audits', `${auditId}.md`), 'utf-8'));
}

async function seedRecord(target) {
  const result = await run([
    'new',
    '--work-unit', 'phase:4',
    '--covered-tasks', 'T-041,T-042',
    '--artifact', 'commit:abc123',
    '--goal', 'Deliver Phase 4.',
    '--completion-oracle', 'All covered outcomes and checks pass.',
    '--evidence', 'Integrated verification for commit:abc123.',
  ], target);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result;
}

const FINDING_JSON = JSON.stringify([{
  id: 'A-01',
  severity: 'high',
  blocking: true,
  claim: 'Two config sources disagree',
  evidenceRefs: 'src/a.js:10',
  consequence: 'Wrong value at runtime',
  requiredOutcome: 'One source of truth',
  verificationRequired: 'npm test plus integration test',
}]);

describe('audit CLI', () => {
  it('creates a canonical record and lints clean', async () => {
    const target = makeTarget('create');
    await seedRecord(target);
    assert.ok(existsSync(join(target, '.agenticloop', 'audits', 'AUD-001.md')));
    const record = readRecord(target);
    assert.equal(record.workUnit, 'phase:4');
    assert.equal(record.auditBudget, 5);
    assert.equal((await run(['lint'], target)).status, 0);
  });

  it('requires a canonical work-unit, covered tasks, and an artifact', async () => {
    const target = makeTarget('create-guards');
    assert.equal((await run(['new', '--work-unit', 'phase-4', '--covered-tasks', 'T-041', '--artifact', 'commit:a'], target)).status, 1);
    assert.equal((await run(['new', '--work-unit', 'phase:4', '--artifact', 'commit:a'], target)).status, 1);
    assert.equal((await run(['new', '--work-unit', 'phase:4', '--covered-tasks', 'T-041'], target)).status, 1);
    const incompletePacket = await run([
      'new',
      '--work-unit', 'phase:4',
      '--covered-tasks', 'T-041',
      '--artifact', 'commit:a',
    ], target);
    assert.equal(incompletePacket.status, 1);
    assert.match(incompletePacket.stderr, /requires --goal/);
  });

  it('refuses a duplicate work unit', async () => {
    const target = makeTarget('dup-work-unit');
    await seedRecord(target);
    const dup = await run([
      'new',
      '--work-unit', 'phase:4',
      '--covered-tasks', 'T-099',
      '--artifact', 'commit:z',
      '--goal', 'Duplicate Phase 4.',
      '--completion-oracle', 'Duplicate outcome exists.',
      '--evidence', 'Duplicate evidence.',
    ], target);
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /already has audit record/);
  });

  it('appends a report and refreshes the derived certification fields', async () => {
    const target = makeTarget('report');
    await seedRecord(target);
    const result = await run([
      'report', 'AUD-001',
      '--verdict', 'needs_remediation',
      '--invocation-mode', 'host_subagent',
      '--invocation-ref', 'ref-1',
      '--assessment', 'Consolidated assessment across six perspectives.',
      '--evidence', 'npm test (pass)',
      '--finding-json', FINDING_JSON,
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const record = readRecord(target);
    assert.equal(record.latestVerdict, 'needs_remediation');
    assert.equal(record.history.length, 1);
    assert.equal(record.history[0].invocationReference, 'ref-1');
    assert.deepEqual(record.findings.map(f => f.id), ['A-01']);
  });

  it('rejects a same-session fallback and a reused invocation reference', async () => {
    const target = makeTarget('report-guards');
    await seedRecord(target);
    const fallback = await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'single_agent_fallback', '--invocation-ref', 'ref-1',
      '--assessment', 'x', '--evidence', 'y',
    ], target);
    assert.equal(fallback.status, 1);
    assert.match(fallback.stderr, /same-session fallback does not satisfy auditing/);

    await run([
      'report', 'AUD-001', '--verdict', 'needs_remediation',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'a', '--evidence', 'b',
    ], target);
    const reused = await run([
      'report', 'AUD-001', '--verdict', 'needs_remediation',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'a', '--evidence', 'b',
    ], target);
    assert.equal(reused.status, 1);
    assert.match(reused.stderr, /already recorded/);
  });

  it('clears stale certification when the baseline is refreshed', async () => {
    const target = makeTarget('baseline');
    await seedRecord(target);
    await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    assert.equal(readRecord(target).auditState, 'certified');

    const rebaseline = await run([
      'baseline', 'AUD-001',
      '--artifact', 'commit:def456',
      '--covered-tasks', 'T-041,T-042,T-055',
      '--evidence', 'Integrated verification for commit:def456.',
    ], target);
    assert.equal(rebaseline.status, 0);
    const record = readRecord(target);
    assert.equal(record.auditState, 'active');
    assert.equal(record.certifiedArtifact, '');
    assert.deepEqual(record.coveredTasks, ['T-041', 'T-042', 'T-055']);
  });

  it('requires refreshed evidence whenever the baseline changes', async () => {
    const target = makeTarget('baseline-evidence');
    await seedRecord(target);
    const result = await run([
      'baseline', 'AUD-001', '--artifact', 'commit:def456',
    ], target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --evidence/);
  });

  it('reports current certification via status exit code', async () => {
    const target = makeTarget('status');
    await seedRecord(target);
    const before = await run(['status', 'AUD-001'], target);
    assert.equal(before.status, 1, 'a non-certified record is not current');

    await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    const after = await run(['status', 'AUD-001', '--json'], target);
    assert.equal(after.status, 0);
    const payload = JSON.parse(after.stdout);
    assert.equal(payload.certification_current, true);
    assert.equal(payload.work_unit_audit, 'enabled');
  });

  it('makes status and closeout gate fail closed for tampered certification', async () => {
    const target = makeTarget('fail-closed');
    await seedRecord(target);
    await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    const file = join(target, '.agenticloop', 'audits', 'AUD-001.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf-8').replace(
        'Audited artifact: commit:abc123',
        'Audited artifact: commit:other'
      ),
      'utf-8'
    );

    const status = await run(['status', 'AUD-001', '--json'], target);
    assert.equal(status.status, 1);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.record_valid, false);
    assert.equal(payload.certification_current, false);

    const gate = await run(['gate', 'phase:4', '--json'], target);
    assert.equal(gate.status, 1);
    assert.equal(JSON.parse(gate.stdout).state, 'audit_invalid');
  });

  it('enforces files-backed task states through the closeout gate', async () => {
    const target = makeTarget('gate-task-state');
    await seedRecord(target);
    await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    assert.equal((await run(['gate', 'AUD-001'], target)).status, 0);

    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-042.md'),
      '---\ntask_id: T-042\nstatus: in-progress\n---\n',
      'utf-8'
    );
    const blocked = await run(['gate', 'phase:4'], target);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /rather than accepted or closed/);
  });

  it('requires audit resolve after a human-decision verdict', async () => {
    const target = makeTarget('human-resolution');
    await seedRecord(target);
    assert.equal((await run([
      'report', 'AUD-001', '--verdict', 'needs_human_decision',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-1',
      '--assessment', 'Human product direction is required.', '--evidence', 'spec review',
    ], target)).status, 0);
    assert.equal(readRecord(target).auditState, 'awaiting_human');

    const premature = await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-2',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    assert.equal(premature.status, 1);
    assert.match(premature.stderr, /audit resolve/);

    const invalid = await run([
      'resolve', 'AUD-001', '--authority', 'auditor:self', '--note', 'Proceed.',
    ], target);
    assert.equal(invalid.status, 1);

    const resolved = await run([
      'resolve', 'AUD-001',
      '--authority', 'human: alex',
      '--note', 'Remediate the gap, then run a fresh audit.',
    ], target);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(readRecord(target).auditState, 'active');

    const fresh = await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-2',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    assert.equal(fresh.status, 0, fresh.stderr);
  });

  it('blocks a sixth report and reopens it only after a recorded override', async () => {
    const target = makeTarget('budget');
    await seedRecord(target);
    for (let index = 1; index <= 5; index++) {
      const result = await run([
        'report', 'AUD-001', '--verdict', 'needs_remediation',
        '--invocation-mode', 'host_subagent', '--invocation-ref', `ref-${index}`,
        '--assessment', 'again', '--evidence', 'npm test (pass)',
      ], target);
      assert.equal(result.status, 0, `run ${index}: ${result.stderr}`);
    }
    assert.equal(readRecord(target).auditState, 'blocked');

    const sixth = await run([
      'report', 'AUD-001', '--verdict', 'needs_remediation',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-6',
      '--assessment', 'again', '--evidence', 'npm test (pass)',
    ], target);
    assert.equal(sixth.status, 1);
    assert.match(sixth.stderr, /exhausted/);

    const noAuthority = await run(['override', 'AUD-001', '--budget', '7'], target);
    assert.equal(noAuthority.status, 1);

    const override = await run(['override', 'AUD-001', '--budget', '7', '--authority', 'human: alex'], target);
    assert.equal(override.status, 0);
    assert.equal(readRecord(target).auditBudget, 7);

    const reopened = await run([
      'report', 'AUD-001', '--verdict', 'certified',
      '--invocation-mode', 'host_subagent', '--invocation-ref', 'ref-6',
      '--assessment', 'clean', '--evidence', 'npm test (pass)',
    ], target);
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.equal(readRecord(target).auditState, 'certified');
  });

  it('locates a record by work-unit identity as well as audit id', async () => {
    const target = makeTarget('selectors');
    await seedRecord(target);
    assert.equal((await run(['status', 'phase:4', '--json'], target)).status, 1);
    assert.equal((await run(['status', 'AUD-001', '--json'], target)).status, 1);
    assert.equal((await run(['status', 'AUD-777'], target)).status, 1);
  });
});
