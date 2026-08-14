import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../../src/handoff-consumption.js';
import { recognizeHandoff } from '../../src/handoff-recognition.js';
import { createTaskReadinessEvidence } from '../../src/task-evidence-contract.js';
import { produceExecutionEvidence } from '../../src/execution-evidence.js';
import {
  createResettableDispatchFixturePool,
  closeoutCertificationFingerprint,
  git as fixtureGit,
  prepare,
  readyReturn,
  repositoryEvidence,
  sha256,
} from './dispatch-fixture.js';
import { initTestGitRepository, git } from './git-fixture.js';
import { fixtureDispatchValidator } from './handoff-fixture.js';
import { protectedHostBoundary } from './host-trust-fixture.js';
import { runCliInProcess } from './run-cli.js';

const TEST_TMP_ROOT = fileURLToPath(new URL('../../.agenticloop/tmp/', import.meta.url));

const TASK_TEMPLATE = readFileSync(new URL('../../memory/task-record.md', import.meta.url), 'utf8');

export const CLOSEOUT_PROJECT_MAP = [
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
].join('\n');

export function createCloseoutCliFixture() {
  let temp;
  const dispatchFixtures = new Map();
  const certifiedArtifacts = new Map();
  const configuredStates = new Map();
  const cacheStats = { certificationExecutions: 0, cacheHits: 0, lastInputFingerprint: null, lastRestoredCheckpoint: null };
  const fixturePool = createResettableDispatchFixturePool();
  afterEach(() => fixturePool.releaseAll());

  function setup() {
    mkdirSync(TEST_TMP_ROOT, { recursive: true });
    temp = mkdtempSync(join(TEST_TMP_ROOT, 'al-closeout-'));
    return temp;
  }

  function cleanup() {
    rmSync(temp, { recursive: true, force: true });
  }

  function bindVerifiedFixture(target, fixture) {
    const repository = fixture.repository;
    const head = fixtureGit(target, ['rev-parse', 'HEAD']);
    fixture.repository = () => ({ ...repository(), head, baseHead: head });
    fixture.refetchRepository = fixture.repository;
    fixture.closeoutScanInventory = fixture.refetchParallelScanInventory();
    dispatchFixtures.set(target, fixture);
  }

  function makeGitTarget(name, { grouping = 'milestone' } = {}) {
    const target = mkdtempSync(join(temp, `${name}-`));
    mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      CLOSEOUT_PROJECT_MAP.replace('grouping_profile: milestone', `grouping_profile: ${grouping}`),
      'utf-8'
    );
    initTestGitRepository(target, {
      quiet: true,
      userName: 'Test',
      userEmail: 'test@example.com',
    });
    writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
    writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf-8');
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', 'init']);
    return target;
  }

  async function makeVerifiedGitTarget(name, { auditEnabled = true, checkpointLabel = null } = {}) {
    const projectMap = auditEnabled
      ? CLOSEOUT_PROJECT_MAP
      : CLOSEOUT_PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled');
    const setupOptions = { auditEnabled, projectMap };
    const configuredCheckpoint = `configured:${sha256(JSON.stringify(setupOptions))}`;
    const fixture = await fixturePool.acquire(temp, name, {
      workUnit: 'milestone:M00', projectMapContent: projectMap,
      additionalAllowedPaths: ['.agenticloop/audits/**'],
    }, { preferredCheckpoint: configuredCheckpoint, resetPaths: [join(temp, 'operator-activation')] });
    const target = fixture.root;
    if (fixturePool.hasCheckpoint(target, configuredCheckpoint)) {
      assert.equal(closeoutCertificationFingerprint(target, { setupOptions }, [fixture.operatorTrustRoot, join(temp, 'operator-activation')]), configuredStates.get(`${target}:${configuredCheckpoint}`));
    } else {
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf8');
    fixtureGit(target, ['add', '.gitignore']);
    fixtureGit(target, ['commit', '-m', 'configure closeout fixture']);
      const state = closeoutCertificationFingerprint(target, { setupOptions }, [fixture.operatorTrustRoot, join(temp, 'operator-activation')]);
      fixturePool.checkpoint(target, configuredCheckpoint, { gitRestore: true });
      configuredStates.set(`${target}:${configuredCheckpoint}`, state);
    }
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    bindVerifiedFixture(target, fixture);
    if (checkpointLabel) fixturePool.checkpoint(target, checkpointLabel, { gitRestore: true });
    return target;
  }

  function restore(target, checkpointLabel) {
    const fixture = fixturePool.restore(target, checkpointLabel);
    bindVerifiedFixture(target, fixture);
    return fixture;
  }

  function writeTask(target, taskId, status, grouping = '') {
    const content = TASK_TEMPLATE
      .replace(/^task_id: T-001$/m, `task_id: ${taskId}`)
      .replace(/^status: agent-ready$/m, `status: ${status}`)
      .replace(/^# T-001 - Short Task Title$/m, `# ${taskId}`)
      .replace('## Grouping\nOptional when the target project uses grouping.', `## Grouping\n\n${grouping}`);
    writeFileSync(join(target, '.agenticloop', 'tasks', `${taskId}.md`), content, 'utf-8');
  }

  function commitAll(target, message) {
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', message]);
    return `commit:${git(target, ['rev-parse', 'HEAD'])}`;
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
          .map(key => [key, `${key} body.`])
      ),
      assessment: 'Consolidated.',
      evidence_checked: 'npm test (pass)',
      verdict: 'certified',
      findings: [],
      ...overrides,
    };
  }

  function run(args, target) {
    return runCliInProcess(args.split(' ').concat(['--target', target]).filter(Boolean), {});
  }

  async function closeout(args, target, options = {}) {
    const fixture = dispatchFixtures.get(target);
    const compatibility = args[0] === 'prepare' && !fixture
      ? ['--legacy-unactivated', '--legacy-reason', 'pre-activation test fixture']
      : [];
    return runCliInProcess(['closeout', ...args, ...compatibility, '--target', target], {
      operatorTrustRoot: fixture?.operatorTrustRoot,
      operatorActivationRoot: join(temp, 'operator-activation'),
      hostAuthority: fixture ? protectedHostBoundary(fixture.trust) : undefined,
      stdinIsTTY: true,
      isTTY: true,
      ci: false,
      promptFactory: () => ({ ask: async () => 'waive', close() {} }),
      ...options,
    });
  }

  async function audit(args, target, options = {}) {
    return runCliInProcess(['audit', ...args, '--target', target], options);
  }

  async function certify(target, {
    tasks = ['T-001'],
    grouping = 'milestone:M00',
    reportOverrides = {},
    auditOptions = {},
    skipAudit = false,
  } = {}) {
    const fixture = dispatchFixtures.get(target);
    assert.ok(fixture, 'certification success requires a genuine dispatch fixture');
    const externalPaths = [fixture.operatorTrustRoot, join(temp, 'operator-activation')];
    const inputFingerprint = closeoutCertificationFingerprint(target, {
      tasks, grouping, reportOverrides, auditOptions, skipAudit,
    }, externalPaths);
    cacheStats.lastInputFingerprint = inputFingerprint;
    const checkpoint = inputFingerprint && `certified:${inputFingerprint}`;
    const cached = checkpoint && certifiedArtifacts.get(`${target}:${inputFingerprint}`);
    if (cached && fixturePool.hasCheckpoint(target, checkpoint)) {
      const restored = fixturePool.restore(target, checkpoint);
      assert.equal(
        closeoutCertificationFingerprint(target, {
          tasks, grouping, reportOverrides, auditOptions, skipAudit,
        }, externalPaths),
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
    assert.deepEqual(tasks, ['T-001']);
    writeFileSync(
      fixture.taskPath,
      readFileSync(fixture.taskPath, 'utf8').replace(/^status: .*$/m, 'status: accepted'),
      'utf8'
    );
    commitAll(target, 'record accepted task');
    const snapshot = fixture.snapshot;
    fixture.snapshot = () => {
      const value = snapshot();
      const body = readFileSync(fixture.taskPath, 'utf8');
      return { ...value, body, digest: sha256(body) };
    };
    fixture.refetchTask = fixture.snapshot;
    const readinessEvidence = createTaskReadinessEvidence({
      ...fixture.readiness.evidence,
      task: { ...fixture.readiness.evidence.task, expectedDigest: fixture.snapshot().digest },
    });
    fixture.readiness = { ...fixture.readiness, evidence: readinessEvidence };
    fixture.refetchReadiness = () => fixture.readiness;
    fixture.refetchParallelScanInventory = () => fixture.closeoutScanInventory;
    const repository = fixture.repository;
    const currentHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    fixture.repository = () => ({ ...repository(), head: currentHead, baseHead: currentHead });
    fixture.refetchRepository = fixture.repository;
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const packet = prepared.packet;
    const packetPath = '.agenticloop/tmp/engineer-dispatch.json';
    writeFileSync(join(target, packetPath), JSON.stringify(packet, null, 2), 'utf8');

    const recognition = recognizeHandoff({
      transition: 'role_start',
      expectation: {
        backend: 'files', taskId: 'T-001', roleId: 'engineer',
        taskContractDigest: packet.task.contractDigest, carrierDigest: packet.task.digest,
        packetId: packet.packetId, packetDigest: packet.digest,
        workUnitIdentity: packet.decomposition.workUnitId, artifactHead: packet.repository.head,
        worktreeRoot: packet.repository.worktree, minimumActivationAssurance: 'operator_confirmed',
      },
      preparedDispatch: packet,
      validatePreparedDispatch: fixtureDispatchValidator(fixture),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
    const consumption = createDispatchConsumption({ backend: 'files', taskId: 'T-001', recognition });
    const consumptionPath = join(target, dispatchConsumptionRelativePath(consumption));
    mkdirSync(join(consumptionPath, '..'), { recursive: true });
    writeFileSync(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');

    writeFileSync(join(target, 'src', 'existing.js'), 'export const current = "closeout-ready";\n', 'utf8');
    fixtureGit(target, ['add', 'src/existing.js']);
    fixtureGit(target, ['commit', '-m', 'record closeout candidate\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    const artifact = `commit:${productHead}`;
    if (!skipAudit) {
      const created = await audit([
        'new', '--work-unit', 'milestone:M00', '--covered-tasks', tasks.join(','),
        '--artifact', artifact, '--goal', 'Deliver the milestone.',
        '--completion-oracle', 'Observable completion.', '--evidence', 'npm test (pass)',
      ], target);
      assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
      fixtureGit(target, ['add', '.agenticloop/audits']);
      fixtureGit(target, ['commit', '-m', 'record audit\n\nTask: T-001\nAgent: engineer']);
      const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
      writeFileSync(reportPath, JSON.stringify(wireReport(artifact, tasks, reportOverrides)), 'utf8');
      const reported = await audit(['report', 'AUD-001', '--file', reportPath], target, auditOptions);
      assert.equal(reported.status, 0, `${reported.stdout}${reported.stderr}`);
      fixtureGit(target, ['add', '.agenticloop/audits']);
      fixtureGit(target, ['commit', '-m', 'record audit report\n\nTask: T-001\nAgent: engineer']);
    }
    const returnHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    const changedPaths = fixtureGit(target, ['diff', '--name-only', `${packet.repository.head}..${returnHead}`])
      .split(/\r?\n/).filter(Boolean);
    const productChangedPaths = fixtureGit(target, ['diff', '--name-only', `${packet.repository.head}..${productHead}`])
      .split(/\r?\n/).filter(Boolean);
    const commits = fixtureGit(target, ['rev-list', '--reverse', `${packet.repository.head}..${productHead}`])
      .split(/\r?\n/).filter(Boolean);
    const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: productChangedPaths });
    evidence.workflowHead = returnHead;
    evidence.productChangedPaths = productChangedPaths;
    evidence.workflowChangedPaths = changedPaths.filter(path => !productChangedPaths.includes(path));
    evidence.productAttribution = {
      range: { base: packet.repository.head, head: productHead },
      commits,
    };
    evidence.carrierLineage = {
      dispatchConsumptionDigest: consumption.digest,
      evidenceMutationReceiptDigests: [],
    };
    const executionReferences = new Map(evidence.checks.filter(check => check.kind === 'command').map(check => {
      const [command, ...args] = check.command.split(' ');
      const path = check.id === 'RC-1' ? '.agenticloop/tmp/evidence.json' : `.agenticloop/tmp/${check.id}-evidence.json`;
      const execution = produceExecutionEvidence({
        checkId: check.id, instruction: check.command, command, args,
        carrierRoot: target, artifactWorktreeRoot: target, workingDirectory: target,
        projectScratchRoot: join(target, '.agenticloop', 'tmp'),
        binding: {
          packetId: packet.packetId, packetDigest: packet.digest, invocationId: packet.assignment.invocationId,
          taskId: 'T-001', taskContractDigest: evidence.task.taskContractDigest,
          currentCarrierDigest: evidence.task.currentCarrierDigest, repositoryHead: returnHead, productHead,
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
    const roleReturn = readyReturn(packet, returnedEvidence);
    const returnPath = '.agenticloop/tmp/engineer-return.json';
    const evidencePath = '.agenticloop/tmp/engineer-evidence.json';
    writeFileSync(join(target, returnPath), JSON.stringify(roleReturn, null, 2), 'utf8');
    writeFileSync(join(target, evidencePath), JSON.stringify(evidence, null, 2), 'utf8');
    const verified = await runCliInProcess([
      'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
      '--repository-evidence', evidencePath, '--target', target,
    ], { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) });
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
    fixtureGit(target, ['add', '-f', '.agenticloop/returns/verifications']);
    fixtureGit(target, ['commit', '-m', 'record return verification\n\nTask: T-001\nAgent: maintainer']);
    if (checkpoint) {
      const restoredState = closeoutCertificationFingerprint(target, {
        tasks, grouping, reportOverrides, auditOptions, skipAudit,
      }, externalPaths);
      assert.ok(restoredState, `successful certification must end at a clean committed checkpoint: ${fixtureGit(target, ['status', '--porcelain', '--untracked-files=all'])}`);
      fixturePool.checkpoint(target, checkpoint, { gitRestore: true });
      certifiedArtifacts.set(`${target}:${inputFingerprint}`, { artifact, restoredState });
    }
    return artifact;
  }

  return {
    PROJECT_MAP: CLOSEOUT_PROJECT_MAP,
    setup,
    cleanup,
    makeGitTarget,
    makeVerifiedGitTarget,
    restore,
    writeTask,
    commitAll,
    wireReport,
    run,
    closeout,
    audit,
    certify,
    cacheStats: () => ({ ...cacheStats }),
    releaseFixtures: () => fixturePool.releaseAll(),
    operatorTrustRoot: target => dispatchFixtures.get(target)?.operatorTrustRoot,
  };
}
