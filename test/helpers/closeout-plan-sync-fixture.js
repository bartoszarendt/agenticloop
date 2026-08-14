import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../../src/handoff-consumption.js';
import { produceExecutionEvidence } from '../../src/execution-evidence.js';
import { recognizeHandoff } from '../../src/handoff-recognition.js';
import { createTaskReadinessEvidence } from '../../src/task-evidence-contract.js';
import {
  createResettableDispatchFixturePool,
  closeoutCertificationFingerprint,
  git as fixtureGit,
  prepare,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './dispatch-fixture.js';
import { git } from './git-fixture.js';
import { fixtureDispatchValidator } from './handoff-fixture.js';
import { protectedHostBoundary } from './host-trust-fixture.js';
import { runCliInProcess } from './run-cli.js';

const TEST_TMP_ROOT = fileURLToPath(new URL('../../.agenticloop/tmp/', import.meta.url));

export function createCloseoutPlanSyncFixture() {
  let temp;
  const dispatchFixtures = new Map();
  const certifiedArtifacts = new Map();
  const configuredStates = new Map();
  const cacheStats = { certificationExecutions: 0, cacheHits: 0, lastInputFingerprint: null, lastRestoredCheckpoint: null };
  const fixturePool = createResettableDispatchFixturePool();
  afterEach(() => fixturePool.releaseAll());

  function setup() {
    mkdirSync(TEST_TMP_ROOT, { recursive: true });
    temp = mkdtempSync(join(TEST_TMP_ROOT, 'al-plansync-'));
    return temp;
  }

  function cleanup() {
    rmSync(temp, { recursive: true, force: true });
  }

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

  async function makeGitTarget(name, { withPlan = true, plan = planContent() } = {}) {
    const setupOptions = { withPlan, plan };
    const configuredCheckpoint = `configured:${sha256(JSON.stringify(setupOptions))}`;
    const fixture = await fixturePool.acquire(temp, name, {
      workUnit: 'milestone:M00',
      projectMapContent: projectMap(withPlan), additionalAllowedPaths: ['.agenticloop/audits/**', 'PLAN.md'],
    }, { cacheKey: { withPlan }, preferredCheckpoint: configuredCheckpoint, resetPaths: [join(temp, 'operator-activation')] });
    const target = fixture.root;
    if (fixturePool.hasCheckpoint(target, configuredCheckpoint)) {
      assert.equal(closeoutCertificationFingerprint(target, { setupOptions }, [fixture.operatorTrustRoot, join(temp, 'operator-activation')]), configuredStates.get(`${target}:${configuredCheckpoint}`));
    } else {
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    if (plan != null) writeFileSync(join(target, 'PLAN.md'), plan, 'utf-8');
    writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
    writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf-8');
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', 'configure plan-sync fixture']);
      const state = closeoutCertificationFingerprint(target, { setupOptions }, [fixture.operatorTrustRoot, join(temp, 'operator-activation')]);
      fixturePool.checkpoint(target, configuredCheckpoint, { gitRestore: true });
      configuredStates.set(`${target}:${configuredCheckpoint}`, state);
    }
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
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
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', message]);
    return `commit:${git(target, ['rev-parse', 'HEAD'])}`;
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
      operatorActivationRoot: join(temp, 'operator-activation'),
      hostAuthority: protectedHostBoundary(fixture.trust),
    });
  }

  async function certify(target) {
    const fixture = dispatchFixtures.get(target);
    const externalPaths = [fixture.operatorTrustRoot, join(temp, 'operator-activation')];
    const inputFingerprint = closeoutCertificationFingerprint(target, {}, externalPaths);
    cacheStats.lastInputFingerprint = inputFingerprint;
    const checkpoint = inputFingerprint && `certified:${inputFingerprint}`;
    const cached = checkpoint && certifiedArtifacts.get(`${target}:${inputFingerprint}`);
    if (cached && fixturePool.hasCheckpoint(target, checkpoint)) {
      const restored = fixturePool.restore(target, checkpoint);
      assert.equal(
        closeoutCertificationFingerprint(target, {}, externalPaths),
        cached.restoredState,
        'certification cache restore must reproduce its certified checkpoint exactly'
      );
      dispatchFixtures.set(target, restored);
      cacheStats.cacheHits += 1;
      cacheStats.lastRestoredCheckpoint = checkpoint;
      return cached.artifact;
    }
    cacheStats.certificationExecutions += 1;
    cacheStats.lastRestoredCheckpoint = null;
    const packets = new Map();
    const consumptions = new Map();
    for (const taskFixture of fixture.taskFixtures.values()) {
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
      const packetPath = `.agenticloop/tmp/${taskId}-dispatch.json`;
      writeFileSync(join(target, packetPath), JSON.stringify(packet, null, 2), 'utf8');
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
      const packetPath = `.agenticloop/tmp/${taskId}-dispatch.json`;
      const returnPath = `.agenticloop/tmp/${taskId}-return.json`;
      const evidencePath = `.agenticloop/tmp/${taskId}-evidence.json`;
      const executionReferences = new Map(evidence.checks.filter(check => check.kind === 'command').map(check => {
        const [command, ...args] = check.command.split(' ');
        const path = check.id === 'RC-1' ? '.agenticloop/tmp/evidence.json' : `.agenticloop/tmp/${check.id}-evidence.json`;
        const execution = produceExecutionEvidence({
          checkId: check.id, instruction: check.command, command, args,
          carrierRoot: target, artifactWorktreeRoot: target, workingDirectory: target,
          projectScratchRoot: join(target, '.agenticloop', 'tmp'),
          binding: {
            packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId,
            taskId, taskContractDigest: evidence.task.taskContractDigest,
            currentCarrierDigest: evidence.task.currentCarrierDigest, repositoryHead: verifiedHead, productHead,
          },
        }, { run: () => ({ exitCode: 0, stdout: `${check.id} passed`, stderr: '' }) });
        writeFileSync(join(target, path), JSON.stringify(execution, null, 2), 'utf8');
        return [check.id, { path, digest: execution.digest }];
      }));
      const returnedEvidence = {
        ...evidence,
        checks: evidence.checks.map(check => executionReferences.has(check.id)
          ? { ...check, executionEvidence: executionReferences.get(check.id) }
          : check),
      };
      writeFileSync(join(target, returnPath), JSON.stringify(readyReturn(packet, returnedEvidence), null, 2), 'utf8');
      writeFileSync(join(target, evidencePath), JSON.stringify(evidence, null, 2), 'utf8');
      const verified = await runCliInProcess([
        'task', 'verify-return', taskId, '--packet', packetPath,
        '--return', returnPath, '--repository-evidence', evidencePath, '--target', target,
      ], { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) });
      assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
    }
    git(target, ['add', '-f', '.agenticloop/returns/verifications']);
    git(target, ['commit', '-m', 'record return verification\n\nTask: T-001\nAgent: maintainer']);
    if (checkpoint) {
      const restoredState = closeoutCertificationFingerprint(target, {}, externalPaths);
      assert.ok(restoredState, `successful certification must end at a clean committed checkpoint: ${fixtureGit(target, ['status', '--porcelain', '--untracked-files=all'])}`);
      fixturePool.checkpoint(target, checkpoint, { gitRestore: true });
      certifiedArtifacts.set(`${target}:${inputFingerprint}`, { artifact, restoredState });
    }
    return artifact;
  }

  return {
    setup,
    cleanup,
    projectMap,
    planContent,
    makeGitTarget,
    writeTask,
    commitAll,
    wireReport,
    audit,
    closeout,
    certify,
    cacheStats: () => ({ ...cacheStats }),
    releaseFixtures: () => fixturePool.releaseAll(),
  };
}
