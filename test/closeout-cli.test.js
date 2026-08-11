/**
 * Closeout prepare/status/record tests (files backend): the full marker
 * lifecycle, stale-packet rejection, premature-marker correction, multiple
 * current markers, packet deletion with digest reconstruction, and all four
 * marker states.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
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
import { parseCloseoutMarkers, validateCloseoutPacket } from '../src/closeout-contract.js';
import { serializeValidationResult } from '../src/result-envelope.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';
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
import {
  legacyWaiverPath,
  legacyWaiverSignaturePayload,
  RETIRED_WAIVER_SCOPE_DIAGNOSTIC,
} from '../src/closeout-waiver.js';
import { provisionOperatorActivationKey, signOperatorActivationPayload } from '../src/activation-trust.js';
import { canonicalSha256 } from '../src/canonical-json.js';

const TASK_TEMPLATE = readFileSync(new URL('../memory/task-record.md', import.meta.url), 'utf8');

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-closeout-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const PROJECT_MAP = [
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

function git(target, args) {
  return execSync(`git ${args}`, { cwd: target, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeGitTarget(name, { grouping = 'milestone' } = {}) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(
    join(target, '.agenticloop', 'project.md'),
    PROJECT_MAP.replace('grouping_profile: milestone', `grouping_profile: ${grouping}`),
    'utf-8'
  );
  git(target, 'init -q');
  git(target, 'config user.email test@example.com');
  git(target, 'config user.name Test');
  writeFileSync(join(target, 'app.js'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n', 'utf-8');
  git(target, 'add -A');
  git(target, 'commit -qm init');
  return target;
}

const dispatchFixtures = new Map();

async function makeVerifiedGitTarget(name, { auditEnabled = true } = {}) {
  const projectMap = auditEnabled
    ? PROJECT_MAP
    : PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled');
  const fixture = await createDispatchFixture(tmpDir, name, {
    workUnit: 'milestone:M00', projectMapContent: projectMap,
    additionalAllowedPaths: ['.agenticloop/audits/**'],
  });
  const target = fixture.root;
  mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(target, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/handoffs/\n', 'utf8');
  fixtureGit(target, ['add', '.gitignore']);
  fixtureGit(target, ['commit', '-m', 'configure closeout fixture']);
  const repository = fixture.repository;
  const head = fixtureGit(target, ['rev-parse', 'HEAD']);
  fixture.repository = () => ({ ...repository(), head, baseHead: head });
  fixture.refetchRepository = fixture.repository;
  fixture.closeoutScanInventory = fixture.refetchParallelScanInventory();
  dispatchFixtures.set(target, fixture);
  return target;
}

function writeTask(target, taskId, status, grouping = '') {
  const content = TASK_TEMPLATE
    .replace(/^task_id: T-001$/m, `task_id: ${taskId}`)
    .replace(/^status: agent-ready$/m, `status: ${status}`)
    .replace(/^# T-001 - Short Task Title$/m, `# ${taskId}`)
    .replace('## Grouping\nOptional when the target project uses grouping.', `## Grouping\n\n${grouping}`);
  writeFileSync(
    join(target, '.agenticloop', 'tasks', `${taskId}.md`),
    content,
    'utf-8'
  );
}

function commitAll(target, message) {
  git(target, 'add -A');
  git(target, `commit -qm "${message}"`);
  return `commit:${git(target, 'rev-parse HEAD')}`;
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
    operatorActivationRoot: join(tmpDir, 'operator-activation'),
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

/**
 * Drive one work unit to a certified audit and return the candidate artifact.
 */
async function certify(target, {
  tasks = ['T-001'],
  grouping = 'milestone:M00',
  reportOverrides = {},
  auditOptions = {},
  skipAudit = false,
} = {}) {
  const fixture = dispatchFixtures.get(target);
  assert.ok(fixture, 'certification success requires a genuine dispatch fixture');
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
  const packetPath = join(target, '.agenticloop', 'tmp', 'engineer-dispatch.json');
  writeFileSync(packetPath, JSON.stringify(packet, null, 2), 'utf8');

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
  let artifact = `commit:${productHead}`;
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
  const evidence = repositoryEvidence(packet, {
    head: productHead, changedPaths: productChangedPaths,
  });
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
  const roleReturn = readyReturn(packet, evidence);
  const returnPath = join(target, '.agenticloop', 'tmp', 'engineer-return.json');
  const evidencePath = join(target, '.agenticloop', 'tmp', 'engineer-evidence.json');
  writeFileSync(returnPath, JSON.stringify(roleReturn, null, 2), 'utf8');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  const verified = await runCliInProcess([
    'task', 'verify-return', 'T-001', '--packet', packetPath, '--return', returnPath,
    '--repository-evidence', evidencePath, '--target', target,
  ], { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: protectedHostBoundary(fixture.trust) });
  assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
  return artifact;
}

describe('closeout prepare', () => {
  it('emits a completion-eligible packet for a certified work unit', async () => {
    const target = await makeVerifiedGitTarget('eligible');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.completion_eligible, true, JSON.stringify(packet.reasons));
    assert.equal(packet.recommended_status, 'complete');
    assert.equal(packet.publishable, true);
    assert.match(packet.digest, /^sha256:[0-9a-f]{64}$/);
  });

  it('completes standard-mode audit with a session-reported Auditor return', async () => {
    const target = await makeVerifiedGitTarget('standard-auditor-return');
    const artifact = await certify(target, {
      reportOverrides: {
        invocation: {
          mode: 'host_subagent',
          reference: 'fresh-standard-auditor',
          provenance: 'asserted',
        },
      },
      auditOptions: { auditProvenanceVerifier: null },
    });
    const packetPath = join(target, '.agenticloop', 'tmp', 'standard-packet.json');
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const packet = JSON.parse(readFileSync(packetPath, 'utf-8'));
    assert.equal(packet.audit.return_assurance, 'session_reported');
    assert.equal(packet.audit.producer_authenticated, false);
    assert.equal(packet.completion_eligible, true, JSON.stringify(packet.reasons));
  });

  it('reports audit due and refuses completion when no audit exists', async () => {
    const target = makeGitTarget('due');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    commitAll(target, 'work');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.equal(packet.recommended_status, 'follow_up_required');
    assert.ok(packet.reasons.some(item => item.gate === 'audit_gate' && item.category === 'audit_missing'));
    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(status.status, 1);
    assert.ok(status.stdout, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'audit_due');
  });

  it('never completes with an explicit audit opt-out but reports it truthfully', async () => {
    const target = await makeVerifiedGitTarget('optout', { auditEnabled: false });
    const artifact = await certify(target, { skipAudit: true });
    const result = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--json',
    ], target);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.audit_opt_out, true);
    assert.equal(packet.audit, null);
    // The opt-out is visible; closeout never claims certification.
    assert.equal(packet.completion_eligible, true, JSON.stringify(packet.reasons));
    assert.equal(packet.recommended_status, 'complete');
  });

  it('fails closed with a validator-clean non-complete packet when audit is disabled but no candidate exists', async () => {
    const target = makeGitTarget('optout-no-candidate');
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled'),
      'utf-8'
    );
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.deepEqual(validateCloseoutPacket(packet), []);
    assert.equal(packet.audit_opt_out, true);
    assert.equal(packet.audit, null);
    assert.equal(packet.candidate_artifact, '');
    assert.equal(packet.completion_eligible, false);
    assert.notEqual(packet.recommended_status, 'complete');
    assert.ok(packet.gates.some(gate => gate.id === 'candidate' && gate.passed === false));
    assert.ok(packet.reasons.some(reason => reason.gate === 'candidate'));
  });

  it('uses an authentic historical waiver through ordinary public prepare without retiring return evidence', async () => {
    const target = makeGitTarget('historical-waiver-public');
    writeFileSync(
      join(target, '.agenticloop', 'project.md'),
      PROJECT_MAP.replace('work_unit_audit: enabled', 'work_unit_audit: disabled'),
      'utf8'
    );
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'prepare historical waiver fixture');

    // Create the current activation-only record through the public command so
    // its task binding, path, repository identity, and operator key are genuine.
    const created = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json',
    ], target);
    assert.equal(created.status, 1, `${created.stdout}${created.stderr}`);

    const waiverFile = join(target, legacyWaiverPath('milestone:M00'));
    const historical = JSON.parse(readFileSync(waiverFile, 'utf8'));
    historical.waivedDimensions = ['activation_evidence_absent', 'return_evidence_absent'];
    historical.statement = `Compatibility exception for missing evidence only: ${historical.waivedDimensions.join(', ')}; ` +
      `repository ${historical.repositoryIdentity}; work unit ${historical.workUnit}; reason: ${historical.reason}`;
    const { digest: ignoredDigest, authentication: ignoredAuthentication, ...projection } = historical;
    historical.digest = `sha256:agenticloop.legacy-unactivated-waiver.v1:${canonicalSha256(projection)}`;
    const provisioned = provisionOperatorActivationKey(target, {
      operatorActivationRoot: join(tmpDir, 'operator-activation'),
    });
    assert.equal(provisioned.ok, true, provisioned.errors.join('; '));
    historical.authentication = signOperatorActivationPayload(legacyWaiverSignaturePayload(historical), {
      key: provisioned.key,
      repositoryIdentity: historical.repositoryIdentity,
    });
    writeFileSync(waiverFile, `${JSON.stringify(historical, null, 2)}\n`, 'utf8');
    const originalBytes = readFileSync(waiverFile, 'utf8');

    // No --legacy-unactivated option: this exercises the normal resolver.
    const prepared = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--json', '--target', target,
    ], { operatorActivationRoot: join(tmpDir, 'operator-activation') });
    assert.equal(prepared.status, 1, `${prepared.stdout}${prepared.stderr}`);
    const packet = JSON.parse(prepared.stdout);
    assert.equal(packet.assurance.tasks[0].compatibility_waived, true);
    assert.deepEqual(packet.assurance.compatibility_waiver.waivedDimensions, [
      'activation_evidence_absent', 'return_evidence_absent',
    ]);
    assert.deepEqual(
      packet.assurance.compatibility_diagnostics.map(item => item.code),
      [RETIRED_WAIVER_SCOPE_DIAGNOSTIC]
    );
    assert.ok(packet.reasons.some(item => item.category === 'return_evidence_absent'));
    assert.ok(!packet.reasons.some(item => item.category === 'activation_evidence_absent'));
    assert.equal(readFileSync(waiverFile, 'utf8'), originalBytes, 'the signed historical record stays byte-identical');

    const human = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact,
      '--target', target,
    ], { operatorActivationRoot: join(tmpDir, 'operator-activation') });
    assert.equal(human.status, 1, `${human.stdout}${human.stderr}`);
    assert.ok(human.stdout.includes(`compatibility diagnostic [${RETIRED_WAIVER_SCOPE_DIAGNOSTIC}]`));
    assert.equal(readFileSync(waiverFile, 'utf8'), originalBytes, 'human output also leaves the source record unchanged');
  });

  it('marks undisposed non-blocking findings completion-ineligible with a repair', async () => {
    const target = await makeVerifiedGitTarget('undisposed');
    await certify(target, { reportOverrides: {
      findings: [{
        id: 'A-01', severity: 'low', blocking: false,
        claim: 'docs drift', evidenceRefs: 'docs/x.md:1',
        consequence: 'confusion', requiredOutcome: 'docs match', verificationRequired: 're-read',
      }],
    } });

    const blocked = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(blocked.status, 1);
    const packet = JSON.parse(blocked.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.ok(packet.reasons.some(item => item.category === 'undisposed_findings' && /audit disposition/.test(item.repair)));

    // Certification may exist; terminal closeout waits for the disposition.
    const disposed = await audit([
      'disposition', 'AUD-001', '--run', '1', '--finding', 'A-01',
      '--type', 'follow_up', '--ref', 'T-009', '--note', 'tracked separately',
    ], target);
    assert.equal(disposed.status, 0, `${disposed.stdout}${disposed.stderr}`);
    fixtureGit(target, ['update-index', '--assume-unchanged', '.agenticloop/audits/AUD-001.md']);
    const eligible = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(eligible.status, 0, `${eligible.stdout}${eligible.stderr}`);
  });
});

describe('closeout record and status', () => {
  it('records a complete marker and verifies it after the packet is deleted', async () => {
    const target = await makeVerifiedGitTarget('lifecycle');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);

    // dry-run mutates nothing.
    const carrierBefore = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8');
    const dry = await closeout(['record', '--packet', packetPath, '--dry-run'], target);
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.match(dry.stdout, /dry run/);
    assert.equal(readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8'), carrierBefore);

    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const carrierAfter = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8');
    assert.ok(carrierAfter.includes('AGENT_CLOSEOUT_STATUS: complete'));
    assert.ok(carrierAfter.includes(`AGENT_CLOSEOUT_WORK_UNIT: milestone:M00`));
    assert.ok(carrierAfter.includes('AGENT_CLOSEOUT_AUDIT_ASSURANCE: host_receipt'));
    assert.ok(carrierAfter.includes('AGENT_CLOSEOUT_AUDIT_PRODUCER_AUTHENTICATED: true'));
    fixtureGit(target, ['update-index', '--assume-unchanged', '.agenticloop/tasks/T-001.md']);

    // Delete the transient packet: provenance must still reconstruct.
    unlinkSync(packetPath);
    const status = await closeout(['status', '--work-unit', 'milestone:M00'], target);
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.match(status.stdout, /complete \(current\)/);

    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-001.md'),
      `${carrierAfter}\nHost-local note after closeout.\n`,
      'utf-8'
    );
    const stale = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(stale.status, 1);
    const staleResult = JSON.parse(stale.stdout);
    assert.equal(staleResult.state, 'stale');
    assert.equal(staleResult.code, 'closeout.marker.stale');
    assert.equal(staleResult.resume_command, 'npx agenticloop closeout prepare --work-unit milestone:M00');
    assert.equal(staleResult.diagnostics[0].owner, 'engineer');
    assert.equal(staleResult.diagnostics[0].escalationOwner, null);
    assert.match(staleResult.diagnostics[0].nextAction, /closeout prepare/);
    assert.match(staleResult.firstSafeRepair, /closeout prepare/);
    assert.equal(
      stale.stdout.trim(),
      serializeValidationResult(staleResult, { capabilities: getProjectRoleCapabilities(target) })
    );
  });

  it('rejects a stale packet after task, audit, or marker state changed', async () => {
    const target = await makeVerifiedGitTarget('stale');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);

    // Product drift after preparation makes the packet stale.
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    commitAll(target, 'post-certification product change');
    const stale = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(stale.status, 1, `${stale.stdout}|${stale.stderr}`);
    assert.match(stale.stderr, /stale packet/);
    assert.ok(!readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8').includes('AGENT_CLOSEOUT_STATUS'));
  });

  it('preserves a concurrent carrier edit and does not close tasks when marker publication loses its precondition', async () => {
    const target = await makeVerifiedGitTarget('marker-publication-race');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    const carrierPath = join(target, '.agenticloop', 'tasks', 'T-001.md');
    const concurrent = `${readFileSync(carrierPath, 'utf8')}\nConcurrent operator note.\n`;
    const recorded = await closeout(
      ['record', '--packet', packetPath, '--yes'],
      target,
      { fsMutationOptions: { beforeWrite: () => writeFileSync(carrierPath, concurrent, 'utf8') } }
    );
    assert.equal(recorded.status, 1);
    assert.equal(readFileSync(carrierPath, 'utf8'), concurrent);
    assert.doesNotMatch(concurrent, /AGENT_CLOSEOUT_GATE:/);
    for (const taskId of ['T-001']) {
      assert.match(readFileSync(join(target, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8'), /status: accepted/);
    }
  });

  it('detects product drift and names the changed path', async () => {
    const target = await makeVerifiedGitTarget('drift');
    const artifact = await certify(target);
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    commitAll(target, 'product change after certification');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.category === 'product_drift' && /app\.js/.test(item.message)));
  });

  it('treats unknown and untracked paths as drift (deny-by-default)', async () => {
    const target = await makeVerifiedGitTarget('untracked');
    const artifact = await certify(target);
    writeFileSync(join(target, 'stray-notes.txt'), 'not tracked\n', 'utf-8');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.category === 'product_drift' && /stray-notes\.txt/.test(item.message)));
  });

  it('corrects a premature complete marker to follow_up_required and supersedes it', async () => {
    const target = makeGitTarget('premature');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    writeTask(target, 'T-002', 'accepted', 'milestone:M00');
    // Premature freehand marker: complete without any audit.
    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-002.md'),
      readFileSync(join(target, '.agenticloop', 'tasks', 'T-002.md'), 'utf-8') +
        '\nAGENT_CLOSEOUT_STATUS: complete\n',
      'utf-8'
    );
    commitAll(target, 'work plus premature marker');
    const prepare = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(prepare.status, 1);
    const packet = JSON.parse(prepare.stdout);
    assert.equal(packet.recommended_status, 'follow_up_required');
    assert.equal(packet.completion_eligible, false);
    assert.equal(packet.publishable, true, 'a truthful correction packet is publishable');

    const packetPath = join(target, '.agenticloop', 'tmp', 'correction.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--output', packetPath,
    ], target)).status, 1);
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    const carrier = readFileSync(join(target, '.agenticloop', 'tasks', 'T-002.md'), 'utf-8');
    assert.ok(carrier.includes('AGENT_CLOSEOUT_STATUS: follow_up_required'));
    assert.ok(carrier.includes('AGENT_CLOSEOUT_SUPERSEDES'));
    // The legacy marker stays recognizable as history.
    assert.ok(carrier.includes('AGENT_CLOSEOUT_STATUS: complete'));
    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(JSON.parse(status.stdout).state, 'follow_up_required');
  });

  it('fails closed on multiple unsuperseded current markers', async () => {
    const target = await makeVerifiedGitTarget('multiple-markers');
    const artifact = await certify(target);
    writeFileSync(
      join(target, '.agenticloop', 'tasks', 'T-001.md'),
      readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8') +
        '\nAGENT_CLOSEOUT_STATUS: complete\n\nAGENT_CLOSEOUT_STATUS: blocked\n',
      'utf-8'
    );
    commitAll(target, 'conflicting markers');
    const result = await closeout(['prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--json'], target);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /multiple unsuperseded/);
    const status = await closeout(['status', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(JSON.parse(status.stdout).state, 'contradictory');
  });

  it('does not append a third marker when a packet encounters contradictory current markers', async () => {
    const target = await makeVerifiedGitTarget('multiple-record');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-001.md');
    writeFileSync(
      carrierFile,
      `${readFileSync(carrierFile, 'utf-8')}\nAGENT_CLOSEOUT_STATUS: complete\n\nAGENT_CLOSEOUT_STATUS: blocked\n`,
      'utf-8'
    );
    const before = readFileSync(carrierFile, 'utf-8');
    const recorded = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(recorded.status, 1);
    assert.equal(readFileSync(carrierFile, 'utf-8'), before);
    assert.equal(parseCloseoutMarkers(before).length, 2);
  });

  it('only writes transient packets inside .agenticloop/tmp without overwriting other files', async () => {
    const target = makeGitTarget('output-safety');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const readme = join(target, 'README.md');
    writeFileSync(readme, 'do not overwrite\n', 'utf-8');
    const readmeResult = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--output', 'README.md',
    ], target);
    assert.equal(readmeResult.status, 1);
    assert.equal(readFileSync(readme, 'utf-8'), 'do not overwrite\n');

    const external = join(tmpDir, 'outside-closeout.json');
    const externalResult = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--output', external,
    ], target);
    assert.equal(externalResult.status, 1);
    assert.equal(existsSync(external), false);

    const packetPath = join(target, '.agenticloop', 'tmp', 'path with spaces', 'packet.json');
    const valid = await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--output', packetPath,
    ], target);
    assert.equal(valid.status, 1);
    assert.equal(existsSync(packetPath), true);
  });

  it('treats a same-packet files retry as idempotent success without rewriting the marker', async () => {
    const target = await makeVerifiedGitTarget('retry-idempotent');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    assert.equal((await closeout(['record', '--packet', packetPath, '--yes'], target)).status, 0);
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-001.md');
    const afterFirst = readFileSync(carrierFile, 'utf-8');
    fixtureGit(target, ['update-index', '--assume-unchanged', '.agenticloop/tasks/T-001.md']);

    // The same applied packet retries cleanly: exit 0, no marker rewrite.
    const retry = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(retry.status, 0, `${retry.stdout}${retry.stderr}`);
    assert.match(retry.stdout, /already current/);
    assert.equal(readFileSync(carrierFile, 'utf-8'), afterFirst);

    // Unrelated drift after publication still fails closed.
    writeFileSync(join(target, 'app.js'), 'export const v = 2;\n', 'utf-8');
    commitAll(target, 'post-publication drift');
    const drifted = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /stale packet/);
    assert.equal(readFileSync(carrierFile, 'utf-8'), afterFirst);
  });

  it('a same-packet retry fails closed on contradictory current markers', async () => {
    const target = await makeVerifiedGitTarget('retry-contradictory');
    const artifact = await certify(target);
    const packetPath = join(target, '.agenticloop', 'tmp', 'packet.json');
    assert.equal((await closeout([
      'prepare', '--work-unit', 'milestone:M00', '--artifact', artifact, '--output', packetPath,
    ], target)).status, 0);
    assert.equal((await closeout(['record', '--packet', packetPath, '--yes'], target)).status, 0);
    const carrierFile = join(target, '.agenticloop', 'tasks', 'T-001.md');
    writeFileSync(
      carrierFile,
      `${readFileSync(carrierFile, 'utf-8')}\nAGENT_CLOSEOUT_STATUS: blocked\n`,
      'utf-8'
    );
    commitAll(target, 'contradictory marker');
    const retry = await closeout(['record', '--packet', packetPath, '--yes'], target);
    assert.equal(retry.status, 1);
  });
});

describe('marker states', () => {
  it('recommends needs_context when the audit awaits a human decision', async () => {
    const target = makeGitTarget('needs-context');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'integrate');
    assert.equal((await audit([
      'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    commitAll(target, 'record audit');
    const reportPath = join(target, '.agenticloop', 'tmp', 'run-1.json');
    writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'], {
      verdict: 'needs_human_decision',
    })), 'utf-8');
    assert.equal((await audit(['report', 'AUD-001', '--file', reportPath], target)).status, 0);
    const prepare = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(prepare.status, 1);
    assert.equal(JSON.parse(prepare.stdout).recommended_status, 'needs_context');
  });

  it('recommends blocked when the audit budget is exhausted', async () => {
    const target = makeGitTarget('exhausted');
    writeTask(target, 'T-001', 'accepted', 'milestone:M00');
    const artifact = commitAll(target, 'integrate');
    assert.equal((await audit([
      'new', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', artifact, '--goal', 'g', '--completion-oracle', 'o', '--evidence', 'npm test',
    ], target)).status, 0);
    commitAll(target, 'record audit');
    for (let index = 0; index < 3; index++) {
      const reportPath = join(target, '.agenticloop', 'tmp', `run-${index}.json`);
      writeFileSync(reportPath, JSON.stringify(wireReport(artifact, ['T-001'], {
        verdict: 'needs_remediation',
      })), 'utf-8');
      const reported = await audit(['report', 'AUD-001', '--file', reportPath], target);
      assert.equal(reported.status, 0, `${reported.stdout}${reported.stderr}`);
    }
    const prepare = await closeout(['prepare', '--work-unit', 'milestone:M00', '--json'], target);
    assert.equal(prepare.status, 1);
    assert.equal(JSON.parse(prepare.stdout).recommended_status, 'blocked');
  });
});
