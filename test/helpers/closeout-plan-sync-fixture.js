import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCarrierLineage } from '../../src/handoff-consumption.js';
import { taskStatusFromBody } from '../../src/dispatchability.js';
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
import { git } from './git-fixture.js';
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
    assert.equal(fixture.taskFixtures.size, 1, 'plan-sync certification covers exactly T-001');
    const cli = { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) };
    const taskBody = () => readFileSync(fixture.taskPath, 'utf8');
    const carrierDigest = () => sha256(taskBody());

    // Real chronological order: dispatchable carrier, one packet, one
    // consumption, Engineer product work and evidence, return, review,
    // acceptance, audit. Nothing is minted retroactively.
    assert.equal(taskStatusFromBody(taskBody()), 'agent-ready', 'certification must begin from a dispatchable task');
    const repository = fixture.repository;
    const dispatchHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    fixture.repository = () => ({ ...repository(), head: dispatchHead, baseHead: dispatchHead });
    fixture.refetchRepository = fixture.repository;
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const packet = prepared.packet;
    assert.equal(packet.task.dispatchCarrierDigest, carrierDigest());
    const packetPath = '.agenticloop/tmp/T-001-dispatch.json';
    writeFileSync(join(target, packetPath), JSON.stringify(packet, null, 2), 'utf8');
    const started = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', carrierDigest(),
      '--dispatch-packet', packetPath, '--json', '--target', target,
    ], cli);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);

    writeFileSync(join(target, 'src', 'existing.js'), 'export const current = "closeout-ready";\n', 'utf8');
    fixtureGit(target, ['add', 'src/existing.js']);
    fixtureGit(target, ['commit', '-m', 'record closeout candidate\n\nTask: T-001\nAgent: engineer']);
    const productHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    const evidenced = await runCliInProcess([
      'task', 'evidence', 'T-001', '--class', 'implementation_artifact_evidence',
      '--expect-digest', carrierDigest(), '--product-head', productHead, '--json', '--target', target,
    ], cli);
    assert.equal(evidenced.status, 0, `${evidenced.stdout}${evidenced.stderr}`);
    fixtureGit(target, ['add', '.agenticloop/tasks/T-001.md']);
    fixtureGit(target, ['add', '-f', '.agenticloop/handoffs']);
    fixtureGit(target, ['commit', '-m', 'record implementation artifact\n\nTask: T-001\nAgent: engineer']);

    const verifiedHead = fixtureGit(target, ['rev-parse', 'HEAD']);
    const changedPaths = fixtureGit(target, ['diff', '--name-only', `${packet.repository.head}..${verifiedHead}`]).split(/\r?\n/).filter(Boolean);
    const productChangedPaths = fixtureGit(target, ['diff', '--name-only', `${packet.repository.head}..${productHead}`]).split(/\r?\n/).filter(Boolean);
    const commits = fixtureGit(target, ['rev-list', '--reverse', `${packet.repository.head}..${productHead}`]).split(/\r?\n/).filter(Boolean);
    const lineage = resolveCarrierLineage(target, 'T-001', {
      backend: 'files', taskContractDigest: packet.task.taskContractDigest,
      boundary: 'engineer_return', currentCarrierDigest: carrierDigest(),
    });
    assert.equal(lineage.ok, true, lineage.errors?.join('; '));
    const evidence = repositoryEvidence(packet, { head: productHead, changedPaths: productChangedPaths });
    evidence.workflowHead = verifiedHead;
    evidence.productChangedPaths = productChangedPaths;
    evidence.workflowChangedPaths = changedPaths.filter(path => !productChangedPaths.includes(path));
    evidence.productAttribution = { range: { base: packet.repository.head, head: productHead }, commits };
    evidence.task.currentCarrierDigest = carrierDigest();
    evidence.carrierLineage = {
      dispatchConsumptionDigest: lineage.dispatchConsumption.digest,
      evidenceMutationReceiptDigests: lineage.receipts.map(receipt => receipt.digest),
    };
    const returnPath = '.agenticloop/tmp/T-001-return.json';
    const evidencePath = '.agenticloop/tmp/T-001-evidence.json';
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
      'task', 'verify-return', 'T-001', '--packet', packetPath,
      '--return', returnPath, '--repository-evidence', evidencePath, '--target', target,
    ], cli);
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
    git(target, ['add', '-f', '.agenticloop/returns/verifications']);
    git(target, ['commit', '-m', 'record return verification\n\nTask: T-001\nAgent: maintainer']);

    // Maintainer review provenance, then acceptance under its own authority,
    // then the audit of the accepted work unit.
    writeFileSync(
      fixture.taskPath,
      `${taskBody()
        .replace(/^review_status:.*$/m, 'review_status: accepted')
        .replace(/^reviewed_artifact:.*$/m, `reviewed_artifact: commit:${productHead}`)
        .replace(/^review_mode:.*$/m, 'review_mode: host_subagent')}` +
      '\n## Scope Completed\n\n- Delivered the closeout candidate.\n' +
      '\n## Evidence\n\n- npm test (pass)\n',
      'utf8'
    );
    git(target, ['add', '.agenticloop/tasks/T-001.md']);
    git(target, ['commit', '-m', 'record maintainer review\n\nTask: T-001\nAgent: maintainer']);
    const accepted = await runCliInProcess([
      'task', 'status', 'T-001', 'accepted', '--expect-digest', carrierDigest(), '--json', '--target', target,
    ], cli);
    assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
    git(target, ['add', '.agenticloop/tasks/T-001.md']);
    git(target, ['commit', '-m', 'record accepted task\n\nTask: T-001\nAgent: maintainer']);
    const artifact = `commit:${fixtureGit(target, ['rev-parse', 'HEAD'])}`;

    assert.equal((await audit([
      'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    fixtureGit(target, ['add', '.agenticloop/audits']);
    fixtureGit(target, ['commit', '-m', 'record audit\n\nTask: T-001\nAgent: maintainer']);
    const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
    writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'])), 'utf-8');
    assert.equal((await audit(['report', 'AUD-001', '--file', reportPath], target)).status, 0);
    fixtureGit(target, ['add', '.agenticloop/audits']);
    fixtureGit(target, ['commit', '-m', 'record audit report\n\nTask: T-001\nAgent: maintainer']);
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
