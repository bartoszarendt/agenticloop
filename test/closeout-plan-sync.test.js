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
import {
  createDispatchFixture,
  git as fixtureGit,
  prepare,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './helpers/dispatch-fixture.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../src/handoff-consumption.js';
import { createTaskReadinessEvidence } from '../src/task-evidence-contract.js';

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

const dispatchFixtures = new Map();

async function makeGitTarget(name, { withPlan = true, plan = planContent() } = {}) {
  const fixture = await createDispatchFixture(tmpDir, name, {
    workUnit: 'milestone:M00',
    projectMapContent: projectMap(withPlan), additionalAllowedPaths: ['.agenticloop/audits/**', 'PLAN.md'],
  });
  const target = fixture.root;
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  if (plan != null) writeFileSync(join(target, 'PLAN.md'), plan, 'utf-8');
  writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf-8');
  git(target, 'add -A');
  git(target, 'commit -qm "configure plan-sync fixture"');
  const repository = fixture.repository;
  const head = fixtureGit(target, ['rev-parse', 'HEAD']);
  for (const taskFixture of fixture.taskFixtures.values()) {
    taskFixture.repository = () => ({ ...repository(), head, baseHead: head });
    taskFixture.refetchRepository = taskFixture.repository;
    taskFixture.closeoutScanInventory = taskFixture.refetchParallelScanInventory();
  }
  dispatchFixtures.set(target, fixture);
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
  const fixture = dispatchFixtures.get(target);
  return runCliInProcess(['closeout', ...args, '--target', target], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: join(tmpDir, 'operator-activation'),
    hostAuthority: protectedHostBoundary(fixture.trust),
  });
}

async function certify(target) {
  const fixture = dispatchFixtures.get(target);
  const packets = new Map();
  const consumptions = new Map();
  for (const [taskId, taskFixture] of fixture.taskFixtures) {
    writeFileSync(taskFixture.taskPath, readFileSync(taskFixture.taskPath, 'utf8').replace(/^status: .*$/m, 'status: accepted'), 'utf8');
  }
  let artifact = commitAll(target, 'integrate candidate');
  for (const [taskId, taskFixture] of fixture.taskFixtures) {
    const snapshot = taskFixture.snapshot;
    taskFixture.snapshot = () => {
      const value = snapshot();
      const body = readFileSync(taskFixture.taskPath, 'utf8');
      return { ...value, body, digest: sha256(body) };
    };
    taskFixture.refetchTask = taskFixture.snapshot;
    taskFixture.readiness = {
      ...taskFixture.readiness,
      evidence: createTaskReadinessEvidence({
        ...taskFixture.readiness.evidence,
        task: { ...taskFixture.readiness.evidence.task, expectedDigest: taskFixture.snapshot().digest },
      }),
    };
    taskFixture.refetchReadiness = () => taskFixture.readiness;
    taskFixture.refetchParallelScanInventory = () => taskFixture.closeoutScanInventory;
    const repository = taskFixture.repository;
    const head = fixtureGit(target, ['rev-parse', 'HEAD']);
    taskFixture.repository = () => ({ ...repository(), head, baseHead: head });
    taskFixture.refetchRepository = taskFixture.repository;
    const prepared = prepare(taskFixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const packet = prepared.packet;
    packets.set(taskId, packet);
    const packetPath = join(target, '.agenticloop', 'tmp', `${taskId}-dispatch.json`);
    writeFileSync(packetPath, JSON.stringify(packet, null, 2), 'utf8');
  }
  for (const [taskId, packet] of packets) {
    const taskFixture = fixture.taskFixtures.get(taskId);
    const recognition = recognizeHandoff({
      transition: 'role_start',
      expectation: {
        backend: 'files', taskId, roleId: 'engineer', taskContractDigest: packet.task.contractDigest,
        carrierDigest: packet.task.digest, packetId: packet.packetId, packetDigest: packet.digest,
        workUnitIdentity: packet.decomposition.workUnitId, artifactHead: packet.repository.head,
        worktreeRoot: packet.repository.worktree, minimumActivationAssurance: 'operator_confirmed',
      },
      preparedDispatch: packet, validatePreparedDispatch: fixtureDispatchValidator(taskFixture),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
    const consumption = createDispatchConsumption({ backend: 'files', taskId, recognition });
    consumptions.set(taskId, consumption);
    const consumptionPath = join(target, dispatchConsumptionRelativePath(consumption));
    mkdirSync(join(consumptionPath, '..'), { recursive: true });
    writeFileSync(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');
  }
  writeFileSync(join(target, 'src', 'existing.js'), 'export const current = "closeout-ready";\n', 'utf8');
  fixtureGit(target, ['add', 'src/existing.js']);
  fixtureGit(target, ['commit', '-m', 'record closeout candidate\n\nTask: T-001\nAgent: engineer']);
  const productHead = fixtureGit(target, ['rev-parse', 'HEAD']);
  artifact = `commit:${productHead}`;
  fixtureGit(target, ['add', '-f', '.agenticloop/handoffs']);
  fixtureGit(target, ['commit', '-m', 'record dispatch consumption\n\nTask: T-001\nAgent: maintainer']);
  assert.equal((await audit([
    'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
    '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
  ], target)).status, 0);
  fixtureGit(target, ['add', '.agenticloop/audits']);
  fixtureGit(target, ['commit', '-m', 'record audit\n\nTask: T-001\nAgent: engineer']);
  const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
  writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'])), 'utf-8');
  assert.equal((await audit(['report', 'AUD-001', '--file', reportPath], target)).status, 0);
  fixtureGit(target, ['add', '.agenticloop/audits']);
  fixtureGit(target, ['commit', '-m', 'record audit report\n\nTask: T-001\nAgent: engineer']);
  const verifiedHead = fixtureGit(target, ['rev-parse', 'HEAD']);
  for (const [taskId, packet] of packets) {
    const changedPaths = fixtureGit(target, ['diff', '--name-only', `${packet.repository.head}..${verifiedHead}`]).split(/\r?\n/).filter(Boolean);
    const productChangedPaths = fixtureGit(target, ['diff', '--name-only', `${packet.repository.head}..${productHead}`]).split(/\r?\n/).filter(Boolean);
    const commits = fixtureGit(target, ['rev-list', '--reverse', `${packet.repository.head}..${productHead}`]).split(/\r?\n/).filter(Boolean);
    const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: productChangedPaths });
    evidence.workflowHead = verifiedHead;
    evidence.productChangedPaths = productChangedPaths;
    evidence.workflowChangedPaths = changedPaths.filter(path => !productChangedPaths.includes(path));
    evidence.productAttribution = { range: { base: packet.repository.head, head: productHead }, commits };
    const consumption = consumptions.get(taskId);
    evidence.carrierLineage = {
      dispatchConsumptionDigest: consumption.digest,
      evidenceMutationReceiptDigests: [],
    };
    const returnPath = join(target, '.agenticloop', 'tmp', `${taskId}-return.json`);
    const evidencePath = join(target, '.agenticloop', 'tmp', `${taskId}-evidence.json`);
    writeFileSync(returnPath, JSON.stringify(readyReturn(packet, evidence), null, 2), 'utf8');
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
    const verified = await runCliInProcess([
      'task', 'verify-return', taskId, '--packet', join(target, '.agenticloop', 'tmp', `${taskId}-dispatch.json`),
      '--return', returnPath, '--repository-evidence', evidencePath, '--target', target,
    ], { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) });
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
  }
  return artifact;
}

describe('plan-sync gate', () => {
  it('refuses completion when a plan applies and plan-sync evidence is omitted', async () => {
    const target = await makeGitTarget('omitted');
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
    const target = await makeGitTarget('not-required');
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
    const carrier = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8');
    assert.match(carrier, /AGENT_CLOSEOUT_PLAN_SYNC: not_required/);
  });

  it('verifies synced mechanically and binds the exact plan revision', async () => {
    const target = await makeGitTarget('synced');
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
    const target = await makeGitTarget('synced-multi-table', { plan: multiTablePlan });
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--json',
    ], target);

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(JSON.parse(result.stdout).plan_sync, /^synced@sha256:[0-9a-f]{64}$/);
  });

  it('fails synced when the plan still marks covered work items planned or in-progress', async () => {
    const target = await makeGitTarget('synced-open', { plan: planContent('planned', 'complete') });
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.gate === 'plan_sync' && /T-001/.test(item.message)));
  });

  it('fails synced for a missing plan, an unverifiable plan, or a stale revision', async () => {
    // Missing plan reference.
    const missing = await makeGitTarget('synced-missing', { plan: null });
    let artifact = await certify(missing);
    let result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-ref', 'PLAN.md', '--json',
    ], missing);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /missing plan/.test(item.message)));

    // No recognizable task table.
    const unverifiable = await makeGitTarget('synced-unverifiable', { plan: '# Plan\n\nfree prose only\n' });
    artifact = await certify(unverifiable);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], unverifiable);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /cannot be verified mechanically/.test(item.message)));

    // Internally incomplete: the table exists but covers none of the tasks.
    const incomplete = await makeGitTarget('synced-incomplete', {
      plan: ['# Plan', '', '| ID | Status | Task |', '|---|---|---|', '| T-099 | complete | other |', ''].join('\n'),
    });
    artifact = await certify(incomplete);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'synced', '--json',
    ], incomplete);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /internally incomplete/.test(item.message)));

    // Stale caller-cited revision.
    const stale = await makeGitTarget('synced-stale-rev');
    artifact = await certify(stale);
    result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--plan-sync', 'synced', '--plan-revision', `sha256:${'0'.repeat(64)}`, '--json',
    ], stale);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /does not match the current plan revision/.test(item.message)));
  });

  it('rejects plan references that resolve outside the target repository', async () => {
    const target = await makeGitTarget('synced-outside');
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
    const target = await makeGitTarget('plan-drift');
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
    const target = await makeGitTarget('skipped');
    const artifact = await certify(target);
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--plan-sync', 'skipped', '--json',
    ], target);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).completion_eligible, false);
  });

  it('no applicable plan keeps none and not_required passing', async () => {
    const target = await makeGitTarget('no-plan', { withPlan: false, plan: null });
    const artifact = await certify(target);
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).plan_sync, 'none');
  });
});
