/**
 * Release contract for the canonical files-backed lifecycle.
 *
 * These scenarios intentionally use only public task commands for lifecycle
 * transitions. Git is used only for the commits those commands prescribe and
 * for black-box assertions about the resulting history.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDispatchFixture, git } from './helpers/dispatch-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-files-lifecycle-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

const TASK_ID = 'T-001';
const DEFAULT_CHECKS = `.agenticloop/tmp/${TASK_ID}-checks.json`;

function digestCarrier(root) {
  return `sha256:${createHash('sha256')
    .update(readFileSync(join(root, '.agenticloop', 'tasks', `${TASK_ID}.md`), 'utf8'))
    .digest('hex')}`;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function cliFor(fixture) {
  const options = {
    operatorTrustRoot: fixture.operatorTrustRoot,
    hostAuthority: protectedHostBoundary(fixture.trust),
    // The managed test sandbox can attach EPERM to a successful spawnSync
    // result. Preserve the real child's status/output at the public CLI seam.
    requiredCheckCommandRunner: ({ command, args, cwd }) => {
      const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
      return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
  return args => runCliInProcess([...args, '--target', fixture.root], options);
}

async function canonicalCommit(cli, root, commitClass, subject, paths) {
  const messagePath = `.agenticloop/tmp/${commitClass}.commit-message.txt`;
  assertOk(await cli([
    'task', 'commit-message', TASK_ID, '--class', commitClass,
    '--subject', subject, '--output', messagePath, '--json',
  ]), `prepare ${commitClass} commit message`);
  git(root, ['add', '--', ...paths]);
  git(root, ['commit', '-F', messagePath]);
  return git(root, ['rev-parse', 'HEAD']);
}

async function publishEngineerEvidence(cli, root, packetPath, productHead) {
  const mutations = [
    {
      class: 'implementation_artifact_evidence',
      args: ['--product-head', productHead],
      subject: 'Record implementation artifact evidence',
    },
    {
      class: 'implementation_summary_evidence',
      args: ['--summary', 'Implemented the task-owned product change.', '--check-evidence', DEFAULT_CHECKS],
      subject: 'Record implementation summary evidence',
    },
    {
      class: 'implementation_outcome_evidence',
      args: ['--outcome', 'implementation_ready_for_review'],
      subject: 'Record implementation outcome evidence',
    },
  ];
  for (const mutation of mutations) {
    const result = assertOk(await cli([
      'task', 'evidence', TASK_ID, '--class', mutation.class,
      '--expect-digest', digestCarrier(root), ...mutation.args, '--json',
    ]), mutation.class);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mutationClass, mutation.class);
    await canonicalCommit(cli, root, mutation.class, mutation.subject, [
      `.agenticloop/tasks/${TASK_ID}.md`,
      payload.receiptPath,
    ]);
  }
  assert.ok(existsSync(join(root, packetPath)));
}

async function runChecks(cli, root, packetPath) {
  const aggregate = JSON.parse(readFileSync(join(root, DEFAULT_CHECKS), 'utf8'));
  const durable = [];
  for (const check of aggregate) {
    const result = assertOk(await cli([
      'task', 'check-evidence-update', TASK_ID, '--packet', packetPath,
      '--input', DEFAULT_CHECKS, '--output', DEFAULT_CHECKS,
      '--check', check.id, '--outcome', 'passed', '--evidence', `${check.id} passed`, '--json',
    ]), `run ${check.id}`);
    JSON.parse(result.stdout);
    const current = JSON.parse(readFileSync(join(root, DEFAULT_CHECKS), 'utf8'))
      .find(item => item.id === check.id);
    if (current.executionEvidence) durable.push(current.executionEvidence.path);
  }
  assert.ok(durable.length > 0, 'the fixture must exercise immutable command execution evidence');
  await canonicalCommit(cli, root, 'required_check_evidence', 'Record required check execution evidence', durable);
  return durable;
}

async function preparePacketAndStart(fixture, cli, suffix) {
  const packetPath = `.agenticloop/tmp/dispatch-${suffix}.json`;
  assertOk(await cli([
    'task', 'prepare-dispatch', TASK_ID, '--host', 'opencode', '--role', 'engineer',
    '--output', packetPath, '--json',
  ]), `prepare dispatch ${suffix}`);
  const preflight = JSON.parse(assertOk(await cli([
    'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
  ]), `preflight ${suffix}`).stdout);
  const startStep = preflight.nextSequence.steps.find(step => /task role-start/.test(step.command));
  const started = JSON.parse(assertOk(await cli([
    'task', 'role-start', TASK_ID, '--packet', packetPath, '--json',
  ]), `role start ${suffix}`).stdout);
  const durableStartWrites = startStep?.writes ?? [
    `.agenticloop/tasks/${TASK_ID}.md`,
    `.agenticloop/handoffs/dispatch/${TASK_ID}/`,
    `.agenticloop/handoffs/attempts/${TASK_ID}/`,
  ];
  await canonicalCommit(cli, fixture.root, 'role_start_status', `Start Engineer attempt ${suffix}`, durableStartWrites);
  return {
    packetPath,
    packet: JSON.parse(readFileSync(join(fixture.root, packetPath), 'utf8')),
    attemptId: JSON.parse(assertOk(await cli([
      'task', 'attempt-status', TASK_ID, '--json',
    ]), `attempt status ${suffix}`).stdout).liveAttempt.attemptId,
    started,
  };
}

async function commitProduct(cli, root, packetPath, value) {
  writeFileSync(join(root, 'src', 'existing.js'), `export const current = "${value}";\n`, 'utf8');
  const plan = JSON.parse(assertOk(await cli([
    'task', 'prepare-product-commit', TASK_ID, '--packet', packetPath,
    '--subject', `Implement ${value}`,
    '--message-output', `.agenticloop/tmp/${value}.commit-message.txt`, '--json',
  ]), `prepare product ${value}`).stdout);
  git(root, plan.gitAddArgv.slice(1));
  git(root, plan.gitCommitArgv.slice(1));
  return git(root, ['rev-parse', 'HEAD']);
}

async function refreshDecomposition(cli, root, { liveAttempt = false } = {}) {
  const blocked = await cli(['task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json']);
  const result = JSON.parse(blocked.stdout);
  let command;
  if (liveAttempt) {
    assert.equal(blocked.status, 0, 'live preflight predicts the current attempt instead of proposing fresh dispatch');
    assert.equal(result.liveAttemptGate.nextStep, 'product_work');
    const head = git(root, ['rev-parse', 'HEAD']);
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
    command = [
      'task', 'prepare-decomposition', TASK_ID,
      '--work-unit', 'fixture-work-unit',
      '--source-ref', `.agenticloop/decompositions/${TASK_ID}.json`,
      '--source-revision', `git-commit:${head}`,
      '--base', tree,
      '--dependencies', 'dependencies.json',
      '--output', `.agenticloop/decompositions/${TASK_ID}.json`,
    ];
  } else {
    assert.equal(blocked.status, 1, 'the retired role-start carrier makes the committed decomposition stale');
    assert.match(result.firstSafeRepair, /task prepare-decomposition/);
    command = result.firstSafeRepair.replace(/^npx agenticloop /, '').split(' ');
  }
  assertOk(await cli([...command, '--json']), 'refresh decomposition');
  await canonicalCommit(
    cli,
    root,
    'handoff_evidence_refresh',
    'Refresh handoff decomposition',
    [`.agenticloop/decompositions/${TASK_ID}.json`],
  );
}

async function abandon(cli, root, attemptId, disposition) {
  const extra = disposition === 'superseded_by_maintainer_repair'
    ? ['--actor-role', 'maintainer']
    : [];
  assertOk(await cli([
    'task', 'abandon-attempt', TASK_ID, '--attempt', attemptId,
    '--disposition', disposition,
    '--reason', `Retire the prior attempt through ${disposition} recovery.`,
    '--authority', 'maintainer:reliability-test', ...extra, '--json',
  ]), `abandon as ${disposition}`);
  await canonicalCommit(
    cli,
    root,
    'attempt_abandonment',
    `Record ${disposition} attempt retirement`,
    [`.agenticloop/handoffs/attempts/${TASK_ID}/`],
  );
}

async function returnSuccessor(fixture, cli, packetPath, productHead, expectedAttemptId) {
  await publishEngineerEvidence(cli, fixture.root, packetPath, productHead);
  await runChecks(cli, fixture.root, packetPath);
  const returnPath = '.agenticloop/tmp/resumed-return.json';
  assertOk(await cli([
    'task', 'prepare-return', TASK_ID, '--packet', packetPath,
    '--check-evidence', DEFAULT_CHECKS, '--outcome', 'implementation_ready_for_review',
    '--output', returnPath, '--json',
  ]), 'prepare resumed return');
  const roleReturn = JSON.parse(readFileSync(join(fixture.root, returnPath), 'utf8'));
  assert.equal(roleReturn.productHead, productHead);
  assert.ok(roleReturn.productLineage, 'successor must disclose carried lineage');
  assert.ok(roleReturn.productLineage.attempts.some(item => item.attemptId === expectedAttemptId));
  assert.equal(roleReturn.productBaseHead, roleReturn.productLineage.carriedBaseHead);
  assertOk(await cli([
    'task', 'verify-return', TASK_ID, '--packet', packetPath,
    '--return', returnPath, '--from-current-repository', '--json',
  ]), 'verify resumed return');
  return roleReturn;
}

describe('canonical files-backend lifecycle', () => {
  it('reaches a verified return through the public canonical sequence without repair or packet churn', async () => {
    const fixture = await createDispatchFixture(temp, 'canonical-happy', {
      requiredChecksText: '- [RC-1] command: `node --version`\n- [RC-2] command: `node --version`',
    });
    const { root } = fixture;
    const cli = cliFor(fixture);
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    const packetPath = '.agenticloop/tmp/dispatch.json';
    const returnPath = '.agenticloop/tmp/return.json';

    assertOk(await cli([
      'task', 'prepare-dispatch', TASK_ID, '--host', 'opencode', '--role', 'engineer',
      '--output', packetPath, '--json',
    ]), 'prepare dispatch');
    const packet = JSON.parse(readFileSync(join(root, packetPath), 'utf8'));

    const preflight = JSON.parse(assertOk(await cli([
      'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
    ]), 'handoff preflight').stdout);
    const roleStartStep = preflight.nextSequence.steps.find(step => /task role-start/.test(step.command));
    assert.ok(roleStartStep, 'preflight must predict canonical role-start');
    assert.deepEqual(roleStartStep.writes.sort(), [
      `.agenticloop/handoffs/dispatch/${TASK_ID}/`,
      `.agenticloop/tasks/${TASK_ID}.md`,
    ].sort(), 'only durable role-start outputs are commit writes');
    assert.deepEqual(roleStartStep.scratchWrites, [DEFAULT_CHECKS]);

    const started = JSON.parse(assertOk(await cli([
      'task', 'role-start', TASK_ID, '--packet', packetPath, '--json',
    ]), 'role start with deterministic check aggregate').stdout);
    assert.equal(started.checkEvidenceOutput, DEFAULT_CHECKS);
    await canonicalCommit(cli, root, 'role_start_status', 'Start the Engineer role', roleStartStep.writes);
    assert.equal(git(root, ['ls-files', '--', DEFAULT_CHECKS]), '', 'mutable aggregate must not be tracked');
    const postStartPreflight = JSON.parse(assertOk(await cli([
      'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
    ]), 'post-start predictive preflight').stdout);
    assert.equal(postStartPreflight.liveAttemptGate.nextStep, 'product_work');
    assert.equal(postStartPreflight.nextSequence.steps[0].command, null);
    assert.match(postStartPreflight.nextSequence.steps[0].action, /genuine task-scoped product work/);

    writeFileSync(join(root, 'src', 'existing.js'), 'export const current = "canonical-return";\n', 'utf8');
    const productPlan = JSON.parse(assertOk(await cli([
      'task', 'prepare-product-commit', TASK_ID, '--packet', packetPath,
      '--subject', 'Implement canonical lifecycle',
      '--message-output', '.agenticloop/tmp/product.commit-message.txt', '--json',
    ]), 'prepare product commit').stdout);
    git(root, productPlan.gitAddArgv.slice(1));
    git(root, productPlan.gitCommitArgv.slice(1));
    const productHead = git(root, ['rev-parse', 'HEAD']);

    await publishEngineerEvidence(cli, root, packetPath, productHead);
    const checkPreflight = JSON.parse(assertOk(await cli([
      'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
    ]), 'required-check predictive preflight').stdout);
    assert.equal(checkPreflight.liveAttemptGate.nextStep, 'required_checks');
    assert.equal(checkPreflight.liveAttemptGate.checkEvidence.current, true);
    assert.match(checkPreflight.nextSequence.steps[0].command, /check-evidence-update/);
    assert.match(checkPreflight.nextSequence.steps[0].command, /--packet <retained-packet\.json>/);
    assert.match(checkPreflight.nextSequence.steps[0].command, /--check RC-1 --outcome passed/);
    assert.doesNotMatch(checkPreflight.nextSequence.steps[0].command, /--outcome pass(?:\s|$)/);
    const executionPaths = await runChecks(cli, root, packetPath);
    assert.deepEqual(executionPaths.sort(), [
      `.agenticloop/checks/${TASK_ID}/RC-1.execution.json`,
      `.agenticloop/checks/${TASK_ID}/RC-2.execution.json`,
    ]);
    assert.equal(git(root, ['ls-files', '--', DEFAULT_CHECKS]), '');

    const returnPreflight = JSON.parse(assertOk(await cli([
      'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
    ]), 'return predictive preflight').stdout);
    assert.equal(returnPreflight.liveAttemptGate.nextStep, 'prepare_return');
    assert.match(returnPreflight.nextSequence.steps[0].command, /task prepare-return/);
    assert.equal(returnPreflight.nextSequence.steps[0].commitRequired, false);

    assertOk(await cli([
      'task', 'prepare-return', TASK_ID, '--packet', packetPath,
      '--check-evidence', DEFAULT_CHECKS, '--outcome', 'implementation_ready_for_review',
      '--output', returnPath, '--json',
    ]), 'prepare return');
    const roleReturn = JSON.parse(readFileSync(join(root, returnPath), 'utf8'));
    const verified = JSON.parse(assertOk(await cli([
      'task', 'verify-return', TASK_ID, '--packet', packetPath,
      '--return', returnPath, '--from-current-repository', '--json',
    ]), 'verify return').stdout);

    assert.equal(roleReturn.productBaseHead, packet.repository.head);
    assert.equal(roleReturn.productHead, productHead);
    assert.equal(roleReturn.workflowHead, git(root, ['rev-parse', 'HEAD']));
    assert.equal(roleReturn.packet.packetId, packet.packetId);
    assert.equal(roleReturn.task.currentCarrierDigest, digestCarrier(root));
    assert.deepEqual(roleReturn.productChangedPaths, ['src/existing.js']);
    assert.deepEqual(roleReturn.checks.map(check => check.outcome), ['passed', 'passed']);
    assert.equal(verified.ok, true);
    const verificationDir = join(root, '.agenticloop', 'returns', 'verifications');
    const verification = JSON.parse(readFileSync(join(verificationDir, readdirSync(verificationDir)[0]), 'utf8'));
    assert.equal(verification.evidence.roleReturn.productHead, productHead);
    assert.equal(verification.evidence.packet.assignment.invocationId, packet.assignment.invocationId);
    assert.equal(JSON.parse(assertOk(await cli([
      'task', 'attempt-status', TASK_ID, '--json',
    ]), 'attempt status').stdout).attempts.length, 1, 'no packet remint or replacement occurred');
  });

  it('blocks a live return sequence when post-start activation trust loss would make prepare-return fail', async () => {
    const fixture = await createDispatchFixture(temp, 'live-return-policy', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const cli = cliFor(fixture);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const started = await preparePacketAndStart(fixture, cli, 'live-return-policy');
    const productHead = await commitProduct(cli, fixture.root, started.packetPath, 'live-return-policy');
    await publishEngineerEvidence(cli, fixture.root, started.packetPath, productHead);
    await runChecks(cli, fixture.root, started.packetPath);

    const before = JSON.parse(assertOk(await cli([
      'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
    ]), 'preflight before policy mutation').stdout);
    assert.equal(before.liveAttemptGate.nextStep, 'prepare_return');
    for (const dimension of ['readiness', 'decomposition', 'clean_state']) {
      assert.equal(before.liveAttemptGate.continuation.dimensions[dimension].state, 'not_applicable');
    }

    rmSync(fixture.operatorTrustRoot, { recursive: true, force: true });
    const blocked = await cli(['task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json']);
    assert.equal(blocked.status, 1);
    const preflight = JSON.parse(blocked.stdout);
    assert.equal(preflight.liveAttemptGate.nextStep, 'prepare_return');
    assert.equal(preflight.liveAttemptGate.continuation.dimensions.activation.state, 'refused');
    assert.ok(preflight.diagnostics.some(item => item.code.startsWith('activation.')));

    const downstream = await cli([
      'task', 'prepare-return', TASK_ID, '--packet', started.packetPath,
      '--check-evidence', DEFAULT_CHECKS, '--outcome', 'implementation_ready_for_review',
      '--output', '.agenticloop/tmp/activation-stale-return.json', '--json',
    ]);
    assert.equal(downstream.status, 1, 'the prescribed downstream return command must reject the same lost activation trust');
  });
});

describe('resumed and recovery files-backend lifecycle', () => {
  const cases = [
    { disposition: 'abandoned', priorProduct: true, budget: true, recovery: false },
    { disposition: 'superseded_by_maintainer_repair', priorProduct: true, budget: false, recovery: true },
    { disposition: 'tooling_failed', priorProduct: true, budget: true, recovery: false, label: 'tooling_failed-with-product' },
    { disposition: 'tooling_failed', priorProduct: false, budget: false, recovery: true, label: 'tooling_failed-without-product' },
    { disposition: 'superseded_before_work', priorProduct: false, budget: false, recovery: true },
  ];

  for (const scenario of cases) {
    const label = scenario.label ?? scenario.disposition;
    it(`carries durable lineage through ${label}`, async () => {
      const fixture = await createDispatchFixture(temp, `recovery-${label}`, {
        requiredChecksText: '- [RC-1] command: `node --version`',
      });
      const cli = cliFor(fixture);
      mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
      const first = await preparePacketAndStart(fixture, cli, 'first');
      const priorProductHead = scenario.priorProduct
        ? await commitProduct(cli, fixture.root, first.packetPath, `prior-${label}`)
        : null;
      await abandon(cli, fixture.root, first.attemptId, scenario.disposition);
      await refreshDecomposition(cli, fixture.root);
      const second = await preparePacketAndStart(fixture, cli, 'second');
      const productHead = priorProductHead ?? await commitProduct(cli, fixture.root, second.packetPath, `successor-${label}`);
      const returned = await returnSuccessor(fixture, cli, second.packetPath, productHead, first.attemptId);
      assert.equal(returned.productLineage.attempts[0].packetId, first.packet.packetId);
      const attempts = JSON.parse(assertOk(await cli([
        'task', 'attempt-status', TASK_ID, '--json',
      ]), 'final attempt status').stdout).attempts;
      const prior = attempts.find(item => item.attemptId === first.attemptId);
      assert.equal(prior.state, scenario.disposition);
      assert.equal(prior.engineeringBudgetConsumed, scenario.budget);
      assert.equal(prior.workflowRecovery, scenario.recovery);
    });
  }

  it('automatically supersedes a mutation-free attempt without consuming engineering budget', async () => {
    const fixture = await createDispatchFixture(temp, 'recovery-superseded-by-packet', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const cli = cliFor(fixture);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const first = await preparePacketAndStart(fixture, cli, 'first');
    await refreshDecomposition(cli, fixture.root, { liveAttempt: true });
    const second = await preparePacketAndStart(fixture, cli, 'second');
    const productHead = await commitProduct(cli, fixture.root, second.packetPath, 'successor-auto');
    await returnSuccessor(fixture, cli, second.packetPath, productHead, first.attemptId);
    const attempts = JSON.parse(assertOk(await cli([
      'task', 'attempt-status', TASK_ID, '--json',
    ]), 'automatic supersession status').stdout).attempts;
    const prior = attempts.find(item => item.attemptId === first.attemptId);
    assert.equal(prior.state, 'superseded_by_packet');
    assert.equal(prior.engineeringBudgetConsumed, false);
    assert.equal(prior.workflowRecovery, true);
  });
});

describe('live-attempt predictive safety', () => {
  it('refuses role start when Git cannot determine aggregate tracking state', async () => {
    const fixture = await createDispatchFixture(temp, 'aggregate-git-probe');
    const cli = cliFor(fixture);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const packetPath = '.agenticloop/tmp/git-probe-dispatch.json';
    assertOk(await cli([
      'task', 'prepare-dispatch', TASK_ID, '--host', 'opencode', '--role', 'engineer',
      '--output', packetPath, '--json',
    ]), 'prepare dispatch before Git probe failure');
    const carrierBefore = readFileSync(join(fixture.root, '.agenticloop', 'tasks', `${TASK_ID}.md`), 'utf8');
    writeFileSync(join(fixture.root, '.git', 'index'), 'not a Git index', 'utf8');

    const refused = await cli(['task', 'role-start', TASK_ID, '--packet', packetPath, '--json']);
    assert.equal(refused.status, 1);
    const result = JSON.parse(refused.stdout);
    assert.equal(result.diagnostics[0].code, 'check.aggregate.git_probe_failed');
    assert.match(result.firstSafeRepair, /readable Git work tree and index/);
    assert.equal(readFileSync(join(fixture.root, '.agenticloop', 'tasks', `${TASK_ID}.md`), 'utf8'), carrierBefore);
    assert.equal(existsSync(join(fixture.root, DEFAULT_CHECKS)), false);
  });

  it('freezes unrelated CLI mutations and preflights an external lineage edit before evidence', async () => {
    const fixture = await createDispatchFixture(temp, 'live-carrier-guard', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const cli = cliFor(fixture);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const started = await preparePacketAndStart(fixture, cli, 'guard');
    const carrierBeforeObservation = readFileSync(
      join(fixture.root, '.agenticloop', 'tasks', `${TASK_ID}.md`), 'utf8'
    );

    const statusRefusal = await cli([
      'task', 'status', TASK_ID, 'blocked', '--block-category', 'workflow',
      '--note', 'This note must wait.', '--expect-digest', digestCarrier(fixture.root), '--json',
    ]);
    assert.equal(statusRefusal.status, 1);
    const statusPayload = JSON.parse(statusRefusal.stdout);
    assert.ok(statusPayload.diagnostics.some(item => item.code === 'task.carrier.armed'));
    assert.equal(statusPayload.attemptId, started.attemptId);
    assert.equal(statusPayload.packetId, started.packet.packetId);

    const structuredEvidencePath = '.agenticloop/tmp/maintainer-evidence.json';
    writeFileSync(join(fixture.root, structuredEvidencePath), `${JSON.stringify({
      kind: 'agenticloop.task-evidence-input',
      schemaVersion: 1,
      actorRole: 'maintainer',
      provenance: {
        workflowRole: 'maintainer',
        invocationId: 'maintainer-live-attempt-observation',
        taskContractDigest: started.packet.task.taskContractDigest,
        attemptId: started.attemptId,
      },
      sections: {
        scopeCompleted: [], evidence: [], deviations: [], knownGaps: [],
        verificationAttempts: [],
        maintainerTriage: [{
          id: 'triage-live-attempt', summary: 'This carrier mutation must wait.',
          status: 'blocked', evidenceRefs: ['diagnostic:task.carrier.armed'],
        }],
        retryAuthorization: [], revisionResolution: [],
      },
    }, null, 2)}\n`, 'utf8');
    const evidenceRefusal = await cli([
      'task', 'evidence', TASK_ID, '--class', 'structured_task_evidence',
      '--input', structuredEvidencePath, '--expect-digest', digestCarrier(fixture.root), '--json',
    ]);
    assert.equal(evidenceRefusal.status, 1);
    const evidencePayload = JSON.parse(evidenceRefusal.stdout);
    assert.equal(evidencePayload.diagnostics[0].code, 'task.carrier.armed');
    assert.equal(evidencePayload.attemptId, started.attemptId);
    assert.equal(evidencePayload.packetId, started.packet.packetId);

    const correctionRefusal = await cli([
      'task', 'authorize-correction', TASK_ID,
      '--expect-prior-digest', started.packet.task.taskContractDigest,
      '--reason', 'This correction must wait.', '--authority', `task:${TASK_ID}`,
      '--actor', 'Agentic Loop Test', '--json',
    ]);
    assert.equal(correctionRefusal.status, 1);
    const correctionPayload = JSON.parse(correctionRefusal.stdout);
    assert.equal(correctionPayload.diagnostics[0].code, 'task.carrier.armed');
    assert.equal(correctionPayload.attemptId, started.attemptId);
    assert.equal(correctionPayload.packetId, started.packet.packetId);
    assert.equal(readFileSync(
      join(fixture.root, '.agenticloop', 'tasks', `${TASK_ID}.md`), 'utf8'
    ), carrierBeforeObservation, 'every refused CLI mutation must preserve the frozen carrier');

    const failureInput = '.agenticloop/tmp/tooling-failure.json';
    writeFileSync(join(fixture.root, failureInput), `${JSON.stringify({
      schemaVersion: 1,
      operation: 'task.handoff-preflight',
      diagnosticCode: 'task.evidence.lineage.stale',
      diagnosticClass: 'workflow',
      mutationOccurred: false,
      safeToRetry: true,
      provenance: { source: 'reliability-test' },
    }, null, 2)}\n`, 'utf8');
    const observation = JSON.parse(assertOk(await cli([
      'task', 'record-tooling-failure', TASK_ID, '--attempt', started.attemptId,
      '--input', failureInput, '--json',
    ]), 'record deferred recovery observation').stdout);
    assert.match(observation.path, /tooling-failures/);
    assert.equal(readFileSync(
      join(fixture.root, '.agenticloop', 'tasks', `${TASK_ID}.md`), 'utf8'
    ), carrierBeforeObservation, 'recovery observation must remain outside the frozen carrier');
    await canonicalCommit(cli, fixture.root, 'tooling_failure_observation',
      'Record deferred tooling failure observation', [observation.path]);

    const productHead = await commitProduct(cli, fixture.root, started.packetPath, 'guard-product');
    const artifact = JSON.parse(assertOk(await cli([
      'task', 'evidence', TASK_ID, '--class', 'implementation_artifact_evidence',
      '--expect-digest', digestCarrier(fixture.root), '--product-head', productHead, '--json',
    ]), 'allowed Engineer evidence mutation').stdout);
    await canonicalCommit(cli, fixture.root, 'implementation_artifact_evidence',
      'Record allowed artifact evidence', [`.agenticloop/tasks/${TASK_ID}.md`, artifact.receiptPath]);
    const expectedTerminal = artifact.currentCarrierDigest;

    const carrierPath = join(fixture.root, '.agenticloop', 'tasks', `${TASK_ID}.md`);
    writeFileSync(carrierPath,
      readFileSync(carrierPath, 'utf8').replace('## Comments\n', '## Comments\n\n- External out-of-chain edit.\n'),
      'utf8');
    const currentCarrierDigest = digestCarrier(fixture.root);

    const preflightResult = await cli([
      'task', 'handoff-preflight', TASK_ID, '--host', 'opencode', '--json',
    ]);
    assert.equal(preflightResult.status, 1);
    const preflight = JSON.parse(preflightResult.stdout);
    assert.ok(preflight.diagnostics.some(item => item.code === 'task.evidence.lineage.stale'));
    assert.equal(preflight.liveAttemptGate.nextStep, 'implementation_summary_evidence');
    assert.equal(preflight.liveAttemptGate.attemptId, started.attemptId);
    assert.equal(preflight.liveAttemptGate.packetId, started.packet.packetId);
    assert.equal(preflight.liveAttemptGate.expectedCarrierDigest, expectedTerminal);
    assert.equal(preflight.liveAttemptGate.currentCarrierDigest, currentCarrierDigest);
    assert.match(preflight.nextSequence.steps[0].command, /implementation_summary_evidence/);

    const evidenceResult = await cli([
      'task', 'evidence', TASK_ID, '--class', 'implementation_summary_evidence',
      '--expect-digest', currentCarrierDigest, '--summary', 'Must refuse first.',
      '--check-evidence', DEFAULT_CHECKS, '--json',
    ]);
    assert.equal(evidenceResult.status, 1);
    const evidence = JSON.parse(evidenceResult.stdout);
    assert.ok(evidence.diagnostics.some(item => item.code === 'task.evidence.lineage.stale'));
    assert.equal(evidence.attemptId, preflight.liveAttemptGate.attemptId);
    assert.equal(evidence.packetId, preflight.liveAttemptGate.packetId);
    assert.equal(evidence.expectedCarrierDigest, preflight.liveAttemptGate.expectedCarrierDigest);
    assert.equal(evidence.currentCarrierDigest, preflight.liveAttemptGate.currentCarrierDigest);
  });

  it('refuses an entire work-unit readiness apply when one member carrier is armed', async () => {
    const fixture = await createDispatchFixture(temp, 'armed-work-unit-readiness');
    const cli = cliFor(fixture);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const started = await preparePacketAndStart(fixture, cli, 'armed-readiness');

    assertOk(await cli([
      'task', 'new', 'Unrelated sibling', '--scaffold', '--id', 'T-002', '--json',
    ]), 'create unrelated sibling carrier');
    const planned = await cli([
      'task', 'readiness-plan', '--tasks', TASK_ID, 'T-002',
      '--actor', 'Agentic Loop Test', '--authority', 'work-unit:fixture-work-unit',
      '--work-unit', 'fixture-work-unit', '--base', 'HEAD',
      '--dependencies', 'dependencies.json', '--json',
    ]);
    assert.equal(planned.status, 1, 'the sibling is intentionally not ready, but the CLI must author the bounded plan');
    const plan = JSON.parse(planned.stdout);
    assert.deepEqual(plan.taskIds, [TASK_ID, 'T-002']);
    const workUnitPlanPath = '.agenticloop/tmp/armed-work-unit-readiness-plan.json';
    writeFileSync(join(fixture.root, workUnitPlanPath), planned.stdout, 'utf8');
    const before = new Map(plan.taskIds.map(taskId => [taskId, readFileSync(
      join(fixture.root, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8'
    )]));

    const refused = await cli([
      'task', 'readiness-apply', '--plan', workUnitPlanPath, '--yes', '--json',
    ]);
    assert.equal(refused.status, 1);
    const result = JSON.parse(refused.stdout);
    assert.equal(result.diagnostics[0].code, 'task.carrier.armed');
    assert.equal(result.task_id, TASK_ID);
    assert.equal(result.attemptId, started.attemptId);
    assert.equal(result.workUnitId, 'fixture-work-unit');
    assert.deepEqual(result.workUnitTaskIds, [TASK_ID, 'T-002']);
    assert.equal(result.atomicWorkUnitRefusal, true);
    assert.match(result.diagnostics[0].message, /entire apply is refused before mutation/i);
    assert.match(result.diagnostics[0].message, /partial sibling apply is unsupported/i);
    assert.match(result.firstSafeRepair, /Do not split or partially apply/i);
    for (const [taskId, content] of before) {
      assert.equal(readFileSync(join(fixture.root, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8'), content);
    }
  });

  it('rejects a tracked mutable check aggregate before return derivation', async () => {
    const fixture = await createDispatchFixture(temp, 'tracked-check-aggregate', {
      requiredChecksText: '- [RC-1] command: `node --version`',
    });
    const cli = cliFor(fixture);
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const started = await preparePacketAndStart(fixture, cli, 'tracked-checks');
    git(fixture.root, ['add', '-f', '--', DEFAULT_CHECKS]);
    git(fixture.root, ['commit', '-m', 'incorrectly track mutable checks']);
    const refused = await cli([
      'task', 'prepare-return', TASK_ID, '--packet', started.packetPath,
      '--check-evidence', DEFAULT_CHECKS, '--outcome', 'implementation_ready_for_review',
      '--output', '.agenticloop/tmp/should-not-exist.json', '--json',
    ]);
    assert.equal(refused.status, 1);
    const payload = JSON.parse(refused.stdout);
    assert.match(payload.diagnostics[0].message, /mutable check aggregate.*tracked by Git/i);
    assert.match(payload.diagnostics[0].message, /remove it from the index/i);
    assert.equal(existsSync(join(fixture.root, '.agenticloop', 'tmp', 'should-not-exist.json')), false);
  });
});
