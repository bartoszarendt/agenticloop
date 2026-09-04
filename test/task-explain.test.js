import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { COMMAND_REGISTRY, isReceiptRevalidationArgv } from '../src/cli-registry.js';
import { createSyntheticScenarioHarness } from './helpers/lifecycle-scenario-harness.js';
import { createDispatchFixture, git, prepare as prepareDispatch } from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import {
  actionVerdictForFactStates,
  authorizationPolicyCode,
  TASK_EXPLAIN_ACTION_DEPENDENCIES,
} from '../src/task-explain.js';
import { DISPATCH_ELIGIBILITY_DIMENSIONS } from '../src/dispatch-eligibility.js';
import { interactiveOptions } from './helpers/activation-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'task-explain-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function snapshot(root, relative = '') {
  const path = join(root, relative);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap(entry => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    // Git may refresh its administrative index timestamp while reading a
    // repository. It is not target workflow state, so the no-write assertion
    // covers every task/project/evidence file and excludes `.git` internals.
    if (child === '.git') return [];
    if (entry.isDirectory()) return snapshot(root, child);
    const stat = statSync(join(root, child));
    return [{ path: child, mtimeMs: stat.mtimeMs, digest: createHash('sha256').update(readFileSync(join(root, child))).digest('hex') }];
  });
}

const MANUAL_REQUIRED_CHECKS = '- [RC-1] manual: Inspect the final state.';

async function manualReturnScenario(name, { authorization = 'missing' } = {}) {
  const fixture = await createDispatchFixture(temp, name, {
    scaffold: true,
    requiredChecksText: MANUAL_REQUIRED_CHECKS,
  });
  const operatorTrustRoot = mkdtempSync(join(temp, `${name}-operator-trust-`));
  const operatorActivationRoot = mkdtempSync(join(temp, `${name}-operator-activation-`));
  const activationFixture = { ...fixture, operatorTrustRoot, operatorActivationRoot };
  if (authorization !== 'missing') {
    const activated = await runCliInProcess(['activate', 'T-001', '--json', '--target', fixture.root], interactiveOptions(activationFixture));
    assert.equal(activated.status, 0, activated.stderr);
    if (authorization === 'revoked') {
      const grantId = JSON.parse(activated.stdout).grantId;
      const revoked = await runCliInProcess(['activation', 'revoke', grantId, '--target', fixture.root], {
        operatorActivationRoot,
      });
      assert.equal(revoked.status, 0, revoked.stderr);
    }
  }
  writeFileSync(join(fixture.root, 'src', 'manual-candidate.js'), 'export const manualCandidate = true;\n', 'utf8');
  git(fixture.root, ['add', 'src/manual-candidate.js']);
  git(fixture.root, ['commit', '-m', 'manual candidate']);
  const candidate = git(fixture.root, ['rev-parse', 'HEAD']);
  const record = readFileSync(fixture.taskPath, 'utf8')
    .replace(/^status: agent-ready$/m, 'status: in-progress')
    .replace(/^implementation_artifact:.*$/m, `implementation_artifact: commit:${candidate}`);
  writeFileSync(fixture.taskPath, record, 'utf8');
  mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'T-001-checks.json'), JSON.stringify([{
    id: 'RC-1', kind: 'manual', instruction: 'Inspect the final state.', outcome: 'passed', exitCode: null, evidence: 'inspected',
  }]), 'utf8');
  return { root: fixture.root, trust: fixture.trust, operatorTrustRoot, operatorActivationRoot };
}

function explainFixture(fixture, args) {
  return runCliInProcess([...args, '--target', fixture.root], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    operatorActivationRoot: fixture.operatorActivationRoot,
    hostAuthority: protectedHostBoundary(fixture.trust),
  });
}

describe('task explain', () => {
  it('maps every lifecycle authorization state to its governing policy code', () => {
    const cases = [
      ['missing', [], 'activation.grant.unauthenticated'],
      ['malformed', ['activation grant fields are malformed'], 'activation.grant.malformed'],
      ['malformed', ['task activation binding fields are malformed'], 'activation.binding.malformed'],
      ['expired', [], 'activation.grant.expired'],
      ['revoked', [], 'activation.grant.revoked'],
      ['stale', [], 'activation.binding.stale_contract'],
      ['mismatched', [], 'activation.binding.mismatch'],
      ['mismatched', ['activation grant was issued for a different target repository'], 'activation.grant.repository_mismatch'],
      ['mismatched', ['task activation binding was issued for a different target repository'], 'activation.binding.repository_mismatch'],
      ['unauthenticated', ['activation grant signature does not verify against the external operator or pinned host key'], 'activation.grant.unauthenticated'],
      ['unauthenticated', ['task activation binding signature does not verify against the external operator or pinned host key'], 'activation.binding.unauthenticated'],
      ['unauthenticated', ["activation assurance 'operator_confirmed' is below the effective minimum 'host_signed'"], 'activation.assurance.insufficient'],
    ];
    for (const [state, errors, expected] of cases) {
      assert.equal(authorizationPolicyCode(state, errors), expected, `${state}: ${errors.join('; ')}`);
    }
  });

  it('is an explicitly read-only registered task command', () => {
    const spec = COMMAND_REGISTRY.task.subcommands.explain;
    assert.equal(spec.receiptRevalidation, 'read-only');
    assert.deepEqual(spec.positionals, [{ name: 'id', required: true }]);
    assert.equal(isReceiptRevalidationArgv(['task', 'explain', 'T-001']), true);
  });

  it('maps every canonical dispatch eligibility dimension for packet preparation', () => {
    assert.deepEqual(
      TASK_EXPLAIN_ACTION_DEPENDENCIES.prepare_dispatch,
      DISPATCH_ELIGIBILITY_DIMENSIONS.map(dimension => `dispatch.${dimension}`),
    );
  });

  it('does not change a synthetic target, including file contents and mtimes', async () => {
    const harness = await createSyntheticScenarioHarness(temp, 'read-only');
    const before = snapshot(harness.fixture.root);
    const result = await harness.run('explain', ['task', 'explain', harness.taskId, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(harness.fixture.root), before);
    assert.equal(JSON.parse(result.stdout).authority, 'none');
  });

  it('keeps the same facts in human and JSON presentation', async () => {
    const harness = await createSyntheticScenarioHarness(temp, 'parity');
    const json = await harness.run('explain-json', ['task', 'explain', harness.taskId, '--action', 'prepare_dispatch', '--json']);
    const human = await harness.run('explain-human', ['task', 'explain', harness.taskId, '--action', 'prepare_dispatch']);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(human.status, 0, human.stderr);
    const projection = JSON.parse(json.stdout);
    assert.equal(projection.actions.length, 1);
    const factsLine = human.stdout.split('\n').find(line => line.startsWith('facts: '));
    assert.deepEqual(JSON.parse(factsLine.slice('facts: '.length)), projection.task);
    assert.match(human.stdout, new RegExp(`task: ${projection.task.id}`));
    assert.match(human.stdout, new RegExp(`lifecycle.status: ${projection.task.lifecycle.status}`));
    assert.match(human.stdout, new RegExp(`activation.state: ${projection.task.activation.state}`));
    for (const action of projection.actions) {
      assert.match(human.stdout, new RegExp(`action: ${action.id}`));
      assert.match(human.stdout, new RegExp(`verdict: ${action.verdict}`));
      for (const reason of action.reasons) assert.match(human.stdout, new RegExp(reason.fact));
    }
  });

  it('preserves packet uncertainty while prioritizing an observed authorization failure', async () => {
    const harness = await createSyntheticScenarioHarness(temp, 'unknown');
    const unknown = await harness.run('explain-unknown', ['task', 'explain', harness.taskId, '--action', 'role_start', '--json']);
    assert.equal(unknown.status, 0, unknown.stderr);
    const unknownAction = JSON.parse(unknown.stdout).actions[0];
    assert.equal(unknownAction.verdict, 'illegal');
    assert.ok(unknownAction.reasons.some(reason => reason.fact === 'dispatch_packet.current'));
    assert.ok(unknownAction.reasons.some(reason => reason.fact === 'activation.current' && reason.state === 'failed'));

    const record = readFileSync(harness.fixture.taskPath, 'utf8').replace(/^status: agent-ready$/m, 'status: draft');
    writeFileSync(harness.fixture.taskPath, record, 'utf8');
    const illegal = await harness.run('explain-illegal', ['task', 'explain', harness.taskId, '--action', 'prepare_dispatch', '--json']);
    assert.equal(illegal.status, 0, illegal.stderr);
    const illegalAction = JSON.parse(illegal.stdout).actions[0];
    assert.equal(illegalAction.verdict, 'illegal');
    assert.ok(illegalAction.reasons.some(reason => reason.policyCode === 'task.lifecycle.not_dispatchable'));
  });

  it('faithfully projects a clean legacy-capture dispatch evaluation', async () => {
    const fixture = await createDispatchFixture(temp, 'legacy-capture-explain');
    const prepared = await explainFixture(fixture, [
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer', '--json',
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);

    const explained = await explainFixture(fixture, [
      'task', 'explain', 'T-001', '--action', 'prepare_dispatch', '--json',
    ]);
    assert.equal(explained.status, 0, explained.stderr);
    const action = JSON.parse(explained.stdout).actions[0];
    assert.equal(action.verdict, 'unknown');
    assert.deepEqual(action.reasons.map(reason => reason.fact), ['dispatch.assignment']);
    assert.equal(action.reasons[0].state, 'unknown');
    assert.equal(action.reasons.some(reason => reason.fact === 'dispatch.activation'), false);
  });

  it('projects genuinely missing and revoked activation as canonical dispatch failures', async () => {
    const missing = await createDispatchFixture(temp, 'missing-dispatch-activation', { scaffold: true });
    const missingPrepared = await explainFixture(missing, [
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer', '--json',
    ]);
    assert.equal(missingPrepared.status, 1, missingPrepared.stderr);
    const missingExplained = await explainFixture(missing, [
      'task', 'explain', 'T-001', '--action', 'prepare_dispatch', '--json',
    ]);
    assert.equal(missingExplained.status, 0, missingExplained.stderr);
    const missingAction = JSON.parse(missingExplained.stdout).actions[0];
    assert.equal(missingAction.verdict, 'illegal');
    assert.ok(missingAction.reasons.some(reason =>
      reason.fact === 'dispatch.activation' && reason.policyCode === 'activation.capture.missing'
    ));

    const revoked = await createDispatchFixture(temp, 'revoked-dispatch-activation', { scaffold: true });
    const activated = await runCliInProcess(['activate', 'T-001', '--json', '--target', revoked.root], interactiveOptions(revoked));
    assert.equal(activated.status, 0, activated.stderr);
    const revokedGrantId = JSON.parse(activated.stdout).grantId;
    const revokedRecord = await runCliInProcess(['activation', 'revoke', revokedGrantId, '--target', revoked.root], {
      operatorActivationRoot: revoked.operatorActivationRoot,
    });
    assert.equal(revokedRecord.status, 0, revokedRecord.stderr);
    const revokedPrepared = await explainFixture(revoked, [
      'task', 'prepare-dispatch', 'T-001', '--host', 'opencode', '--role', 'engineer', '--json',
    ]);
    assert.equal(revokedPrepared.status, 1, revokedPrepared.stderr);
    const revokedExplained = await explainFixture(revoked, [
      'task', 'explain', 'T-001', '--action', 'prepare_dispatch', '--json',
    ]);
    assert.equal(revokedExplained.status, 0, revokedExplained.stderr);
    const revokedAction = JSON.parse(revokedExplained.stdout).actions[0];
    assert.equal(revokedAction.verdict, 'illegal');
    assert.ok(revokedAction.reasons.some(reason =>
      reason.fact === 'dispatch.activation' && reason.policyCode === 'activation.grant.revoked'
    ));
  });

  it('never calls a dirty eligible worktree legal for prepare_dispatch', async () => {
    const fixture = await createDispatchFixture(temp, 'dirty-dispatch-explain');
    writeFileSync(join(fixture.root, 'src', 'dirty.js'), 'export const dirty = true;\n', 'utf8');

    const prepared = prepareDispatch(fixture);
    assert.equal(prepared.ok, false);
    assert.ok(prepared.validation.diagnostics.some(item => item.code === 'worktree.clean_gate.failed'));

    const result = await explainFixture(fixture, ['task', 'explain', 'T-001', '--action', 'prepare_dispatch', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'illegal');
    assert.ok(action.reasons.some(reason =>
      reason.fact === 'dispatch.clean_state' && reason.policyCode === 'worktree.clean_gate.failed' && reason.state === 'failed'
    ));
  });

  it('never reports malformed check evidence or malformed candidate identity as legal return facts', async () => {
    const harness = await createSyntheticScenarioHarness(temp, 'invalid-return-facts');
    const record = readFileSync(harness.fixture.taskPath, 'utf8')
      .replace(/^status: agent-ready$/m, 'status: in-progress')
      .replace(/^implementation_artifact:.*$/m, 'implementation_artifact: commit:not-a-sha');
    writeFileSync(harness.fixture.taskPath, record, 'utf8');
    writeFileSync(join(harness.fixture.root, '.agenticloop', 'tmp', `${harness.taskId}-checks.json`), JSON.stringify([{
      id: 'RC-999', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 0,
      evidence: 'fabricated', executionEvidence: null,
    }]), 'utf8');

    const result = await harness.run('explain-invalid-return-facts', ['task', 'explain', harness.taskId, '--action', 'prepare_return', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'illegal');
    assert.ok(action.reasons.some(reason => reason.fact === 'required_checks.current' && reason.state === 'failed'));
    assert.ok(action.reasons.some(reason => reason.fact === 'candidate.current' && reason.state === 'failed'));
  });

  it('rejects a passed command check without closed execution binding', async () => {
    const harness = await createSyntheticScenarioHarness(temp, 'missing-execution-binding');
    const record = readFileSync(harness.fixture.taskPath, 'utf8').replace(/^status: agent-ready$/m, 'status: in-progress');
    writeFileSync(harness.fixture.taskPath, record, 'utf8');
    writeFileSync(join(harness.fixture.root, '.agenticloop', 'tmp', `${harness.taskId}-checks.json`), JSON.stringify([
      { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 0, evidence: 'fabricated', executionEvidence: null },
      { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, evidence: 'fabricated', executionEvidence: null },
    ]), 'utf8');

    const result = await harness.run('explain-missing-execution-binding', ['task', 'explain', harness.taskId, '--action', 'prepare_return', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'illegal');
    assert.ok(action.reasons.some(reason => reason.fact === 'required_checks.current' && reason.state === 'failed'));
  });

  it('rejects a stale implementation candidate instead of reporting a legal return', async () => {
    const harness = await createSyntheticScenarioHarness(temp, 'stale-candidate');
    const candidate = harness.productCommit('candidate');
    writeFileSync(join(harness.fixture.root, 'src', 'baseline-product.js'), 'export const baselineProduct = \'later\';\n', 'utf8');
    git(harness.fixture.root, ['add', 'src/baseline-product.js']);
    git(harness.fixture.root, ['commit', '-m', 'later product change']);
    const record = readFileSync(harness.fixture.taskPath, 'utf8')
      .replace(/^status: agent-ready$/m, 'status: in-progress')
      .replace(/^implementation_artifact:.*$/m, `implementation_artifact: commit:${candidate}`);
    writeFileSync(harness.fixture.taskPath, record, 'utf8');

    const result = await harness.run('explain-stale-candidate', ['task', 'explain', harness.taskId, '--action', 'prepare_return', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'illegal');
    assert.ok(action.reasons.some(reason => reason.fact === 'candidate.current' && reason.policyCode === 'task.evidence.product_head'));
  });

  it('rejects every applicable projection action when manual-only return facts lack authorization', async () => {
    const fixture = await manualReturnScenario('manual-missing-authorization');
    const result = await explainFixture(fixture, ['task', 'explain', 'T-001', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const actions = JSON.parse(result.stdout).actions;
    assert.ok(actions.every(action => action.verdict !== 'legal'));
    for (const action of actions.filter(action => action.verdict !== 'not_applicable')) {
      assert.ok(action.reasons.some(reason =>
        (action.id === 'prepare_dispatch'
          ? reason.fact === 'dispatch.activation' && reason.policyCode === 'activation.capture.missing'
          : reason.fact === 'activation.current' && reason.policyCode === 'activation.grant.unauthenticated')
      ), `${action.id}: ${JSON.stringify(action.reasons)}`);
    }
    const returned = actions.find(action => action.id === 'prepare_return');
    assert.equal(returned.verdict, 'illegal');
    assert.ok(returned.reasons.some(reason =>
      reason.fact === 'activation.current' && reason.policyCode === 'activation.grant.unauthenticated'
    ));
  });

  it('rejects manual-only return facts when the current authorization is revoked', async () => {
    const fixture = await manualReturnScenario('manual-revoked-authorization', { authorization: 'revoked' });
    const result = await explainFixture(fixture, ['task', 'explain', 'T-001', '--action', 'prepare_return', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'illegal');
    assert.ok(action.reasons.some(reason =>
      reason.fact === 'activation.current' && reason.policyCode === 'activation.grant.revoked'
    ));
  });

  it('does not let manual-only evidence establish return currency without a bound packet and attempt', async () => {
    const fixture = await manualReturnScenario('manual-unobservable-binding', { authorization: 'present' });
    const result = await explainFixture(fixture, ['task', 'explain', 'T-001', '--action', 'prepare_return', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'unknown');
    assert.ok(action.reasons.some(reason =>
      reason.fact === 'required_checks.current' && reason.state === 'unknown' && /packet.*attempt binding/i.test(reason.detail)
    ));
  });

  it('never reports legal when any mapped material fact is failed or unobservable', () => {
    for (const [action, dependencies] of Object.entries(TASK_EXPLAIN_ACTION_DEPENDENCIES)) {
      for (const fact of dependencies) {
        for (const state of ['failed', 'unavailable']) {
          const states = Object.fromEntries(dependencies.map(dependency => [dependency, 'current']));
          states[fact] = state;
          assert.notEqual(
            actionVerdictForFactStates(action, states),
            'legal',
            `${action} must not be legal when ${fact} is ${state}`,
          );
        }
      }
    }
  });

  it('does not let manual-only evidence establish review currency without a bound packet and attempt', async () => {
    const fixture = await manualReturnScenario('manual-review-unobservable-binding', { authorization: 'present' });
    const result = await explainFixture(fixture, ['task', 'explain', 'T-001', '--action', 'review', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions[0];
    assert.equal(action.verdict, 'unknown');
    assert.ok(action.reasons.some(reason =>
      reason.fact === 'dispatch_packet.current' && reason.state === 'unknown'
    ));
    assert.ok(action.reasons.some(reason =>
      reason.fact === 'required_checks.current' && reason.state === 'unknown'
    ));
  });
});
