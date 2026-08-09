/**
 * Mechanical plan-synchronization gate: an implicit `none` never completes
 * when a source plan applies, `not_required` is explicit and visible,
 * `synced` binds and verifies the exact plan reference/revision, and a plan
 * edit after certification stales the packet and marker.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { runCliInProcess } from './helpers/run-cli.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-plansync-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function projectMap(withPlan) {
  return [
    '---',
    'setup_status: confirmed',
    'development_stage: expansion',
    'task_backend: files',
    'work_unit_audit: enabled',
    'grouping_profile: milestone',
    ...(withPlan ? ['documents:', '  plan: PLAN.md'] : []),
    '---',
    '',
    '# Project',
    '',
  ].join('\n');
}

function planContent(statusT001 = 'complete', statusT002 = 'complete') {
  return [
    '# Plan',
    '',
    '| ID | Status | Task |',
    '|---|---|---|',
    `| T-001 | ${statusT001} | first |`,
    `| T-002 | ${statusT002} | second |`,
    '',
  ].join('\n');
}

function git(target, args) {
  return execSync(`git ${args}`, { cwd: target, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeGitTarget(name, { withPlan = true, plan = planContent() } = {}) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), projectMap(withPlan), 'utf-8');
  if (plan != null) writeFileSync(join(target, 'PLAN.md'), plan, 'utf-8');
  git(target, 'init -q');
  git(target, 'config user.email test@example.com');
  git(target, 'config user.name Test');
  writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf-8');
  git(target, 'add -A');
  git(target, 'commit -qm init');
  return target;
}

function writeTask(target, taskId, status) {
  writeFileSync(
    join(target, '.agenticloop', 'tasks', `${taskId}.md`),
    [
      '---', `task_id: ${taskId}`, `status: ${status}`, '---', '',
      `# ${taskId}`, '', '## Grouping', '', 'milestone:M00', '',
      '## Required Checks', '', '- [RC-1] command: `npm test`', '', '## Comments', '', '',
    ].join('\n'),
    'utf-8'
  );
}

function commitAll(target, message) {
  git(target, 'add -A');
  git(target, `commit -qm "${message}"`);
  return `commit:${git(target, 'rev-parse HEAD')}`;
}

function wireReport(artifact, coveredTasks) {
  return {
    report_schema: 'auditor_report_v1',
    producer: { roleId: 'auditor' },
    artifact,
    covered_tasks: coveredTasks,
    invocation: { mode: 'host_subagent', reference: `ref-${Math.random().toString(36).slice(2)}`, provenance: 'verified', receipt: `auditor-receipt-${Math.random().toString(36).slice(2)}` },
    perspectives: Object.fromEntries(
      ['outcome', 'completeness', 'integration_coherence', 'engineering_quality', 'verification', 'risk']
        .map(key => [key, `${key} body.`])
    ),
    assessment: 'Consolidated.',
    evidence_checked: 'npm test (pass)',
    verdict: 'certified',
    findings: [],
  };
}

async function audit(args, target) {
  return runCliInProcess(['audit', ...args, '--target', target]);
}

async function closeout(args, target) {
  const compatibility = args[0] === 'prepare'
    ? ['--legacy-unactivated', '--legacy-reason', 'historical unactivated plan-sync fixture']
    : [];
  return runCliInProcess(['closeout', ...args, ...compatibility, '--target', target], {
    operatorActivationRoot: join(tmpDir, 'operator-activation'),
    stdinIsTTY: true, isTTY: true, ci: false,
    promptFactory: () => ({ ask: async () => 'waive', close() {} }),
  });
}

async function certify(target) {
  writeTask(target, 'T-001', 'accepted');
  writeTask(target, 'T-002', 'accepted');
  const artifact = commitAll(target, 'integrate candidate');
  assert.equal((await audit([
    'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001,T-002',
    '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
  ], target)).status, 0);
  commitAll(target, 'record audit');
  const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
  writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001', 'T-002'])), 'utf-8');
  assert.equal((await audit(['report', 'AUD-001', '--file', reportPath], target)).status, 0);
  return artifact;
}

describe('plan-sync gate', () => {
  it('refuses completion when a plan applies and plan-sync evidence is omitted', async () => {
    const target = makeGitTarget('omitted');
    const artifact = await certify(target);
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.equal(packet.recommended_status, 'needs_context');
    assert.ok(packet.reasons.some(item => item.gate === 'plan_sync' && item.category === 'plan_sync_missing'),
      JSON.stringify(packet.reasons));
  });

  it('passes with an explicit not_required recorded visibly in the marker', async () => {
    const target = makeGitTarget('not-required');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'not_required', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.plan_sync, 'not_required');
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const carrier = readFileSync(join(target, '.agenticloop', 'tasks', 'T-002.md'), 'utf-8');
    assert.match(carrier, /AGENT_CLOSEOUT_PLAN_SYNC: not_required/);
  });

  it('verifies synced mechanically and binds the exact plan revision', async () => {
    const target = makeGitTarget('synced');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const prepared = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--output', packetPath,
    ], target);
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.match(packet.plan_sync, /^synced@sha256:[0-9a-f]{64}$/);
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const status = await closeout(['status', '--work-unit', 'milestone:M00'], target);
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.match(status.stdout, /complete \(current\)/);
  });

  it('finds the task table after unrelated Markdown tables', async () => {
    const multiTablePlan = [
      '# Plan',
      '',
      '| Risk | Mitigation |',
      '|---|---|',
      '| drift | verify |',
      '',
      planContent(),
    ].join('\n');
    const target = makeGitTarget('synced-multi-table', { plan: multiTablePlan });
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--json',
    ], target);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(JSON.parse(result.stdout).plan_sync, /^synced@sha256:[0-9a-f]{64}$/);
  });

  it('fails synced when the plan still marks covered work items planned or in-progress', async () => {
    const target = makeGitTarget('synced-open', { plan: planContent('complete', 'planned') });
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.gate === 'plan_sync' && /T-002/.test(item.message)));
  });

  it('fails synced for a missing plan, an unverifiable plan, or a stale revision', async () => {
    // Missing plan reference.
    const missing = makeGitTarget('synced-missing', { plan: null });
    let artifact = await certify(missing);
    let result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-ref', 'PLAN.md', '--json',
    ], missing);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /missing plan/.test(item.message)));

    // No recognizable task table.
    const unverifiable = makeGitTarget('synced-unverifiable', { plan: '# Plan\n\nfree prose only\n' });
    artifact = await certify(unverifiable);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], unverifiable);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /cannot be verified mechanically/.test(item.message)));

    // Internally incomplete: the table exists but covers none of the tasks.
    const incomplete = makeGitTarget('synced-incomplete', {
      plan: ['# Plan', '', '| ID | Status | Task |', '|---|---|---|', '| T-099 | complete | other |', ''].join('\n'),
    });
    artifact = await certify(incomplete);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], incomplete);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /internally incomplete/.test(item.message)));

    // Stale caller-cited revision.
    const stale = makeGitTarget('synced-stale-rev');
    artifact = await certify(stale);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-revision', `sha256:${'0'.repeat(64)}`, '--json',
    ], stale);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /does not match the current plan revision/.test(item.message)));
  });

  it('rejects plan references that resolve outside the target repository', async () => {
    const target = makeGitTarget('synced-outside');
    const outsidePlan = join(tmpDir, 'outside-plan.md');
    writeFileSync(outsidePlan, planContent(), 'utf-8');
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-ref', relative(target, outsidePlan), '--json',
    ], target);

    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /outside the target repository/.test(item.message)),
      result.stdout);
  });

  it('a plan edit after certification makes the packet and marker stale', async () => {
    const target = makeGitTarget('plan-drift');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--output', packetPath,
    ], target)).status, 0);

    // Editing the plan after certification is product drift and revision drift.
    writeFileSync(join(target, 'PLAN.md'), `${readFileSync(join(target, 'PLAN.md'), 'utf-8')}\nlate edit\n`, 'utf-8');
    commitAll(target, 'edit plan after certification');

    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 1);
    assert.match(recorded.stderr, /stale packet/);

    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.notEqual(JSON.parse(status.stdout).state, 'complete');
  });

  it('skipped remains non-passing', async () => {
    const target = makeGitTarget('skipped');
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'skipped', '--json',
    ], target);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).completion_eligible, false);
  });

  it('no applicable plan keeps none and not_required passing', async () => {
    const target = makeGitTarget('no-plan', { withPlan: false, plan: null });
    const artifact = await certify(target);
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).plan_sync, 'none');
  });
});
