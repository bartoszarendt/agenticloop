/**
 * Privacy-clean, disposable lifecycle baseline scenarios.
 *
 * This is a characterization harness, not a lifecycle shim: every command is
 * routed through `runCliInProcess`, the same CLI entry point used by command
 * tests. It records only stable command names, exit statuses, diagnostic codes,
 * and derived counts; it never retains command prose, packets, prompts, or a
 * target checkout after the caller removes its temporary root.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDispatchFixture, git } from './dispatch-fixture.js';
import { protectedHostBoundary } from './host-trust-fixture.js';
import { runCliInProcess } from './run-cli.js';
import { measureTaskWorkflow } from '../../src/workflow-measurement.js';

export const BASELINE_SCENARIOS = Object.freeze([
  'standard-serial', 'remediation', 'long-pause', 'update', 'operator-edit', 'eight-step-chain',
]);

function resultCode(result) {
  try {
    const value = JSON.parse(result.stdout);
    return value.code ?? value.error?.code ?? value.result?.code ?? value.diagnostics?.[0]?.code ?? 'none';
  } catch {
    return result.status === 0 ? 'none' : 'unstructured_cli_failure';
  }
}

function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fixtureHistory(root) {
  return git(root, ['rev-list', '--reverse', 'HEAD']).split(/\r?\n/).filter(Boolean);
}

/**
 * Create a real CLI fixture and provide bounded scenario operations.
 *
 * The fixture builder establishes activation, contract, dependency, and
 * decomposition evidence through the existing product helpers. No record is
 * hand-authored to imitate a lifecycle result.
 */
export async function createSyntheticScenarioHarness(temp, name) {
  // The shared fixture's complete attribution chain is intentionally bound to
  // this opaque canonical ID. Keeping it avoids inventing a replacement
  // dependency record merely to make a measurement fixture look successful.
  const fixture = await createDispatchFixture(temp, `synthetic-baseline-${name}`, { taskIds: ['T-001'] });
  const taskId = 'T-001';
  const commands = [];
  const cli = args => runCliInProcess([...args, '--target', fixture.root], {
    operatorTrustRoot: fixture.operatorTrustRoot,
    hostAuthority: protectedHostBoundary(fixture.trust),
  });
  mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });

  const run = async (step, args) => {
    const result = await cli(args);
    commands.push(Object.freeze({ step, command: args.slice(0, 3).join(' '), status: result.status, code: resultCode(result) }));
    return result;
  };
  const packetPath = '.agenticloop/tmp/baseline-packet.json';

  const start = async () => {
    const prepared = await run('prepare-dispatch', [
      'task', 'prepare-dispatch', taskId, '--host', 'opencode', '--role', 'engineer', '--output', packetPath, '--json',
    ]);
    if (prepared.status !== 0) return prepared;
    const started = await run('role-start', ['task', 'role-start', taskId, '--packet', packetPath, '--json']);
    if (started.status === 0) commit(fixture.root, `record role start\n\nTask: ${taskId}\nAgent: engineer`);
    return started;
  };
  const productCommit = label => {
    writeFileSync(join(fixture.root, 'src', 'baseline-product.js'), `export const baselineProduct = '${label}';\n`, 'utf8');
    return commit(fixture.root, `${label} product change\n\nTask: ${taskId}\nAgent: engineer`);
  };
  const measurement = () => {
    const history = fixtureHistory(fixture.root);
    return measureTaskWorkflow(fixture.root, taskId, {
      commitRange: 'authorization',
      // `fixture` initializes the Git repository before the fixture's durable
      // authorization/task record commit. The task fixture is the authorization
      // anchor; the following baseline commit is the pre-existing contract
      // commit excluded by the frozen M1 rule.
      authorizationHead: history[1],
      taskContractCommit: history[2],
      now: '2040-01-01T00:00:00.000Z',
    });
  };
  return { fixture, taskId, commands, run, start, productCommit, measurement };
}

function firstFailure(commands) {
  return commands.find(command => command.status !== 0) ?? null;
}

/** Run one frozen scenario and return only its privacy-clean observation. */
export async function runSyntheticScenario(temp, scenario) {
  if (!BASELINE_SCENARIOS.includes(scenario)) throw new TypeError(`unknown baseline scenario '${scenario}'`);
  const harness = await createSyntheticScenarioHarness(temp, scenario);
  let availability = 'measured';
  let unavailableReason = null;

  if (scenario === 'standard-serial' || scenario === 'remediation') {
    const started = await harness.start();
    if (started.status === 0) {
      harness.productCommit(scenario);
      await harness.run('prepare-return', [
        'task', 'prepare-return', harness.taskId, '--packet', '.agenticloop/tmp/baseline-packet.json',
        '--check-evidence', `.agenticloop/tmp/${harness.taskId}-checks.json`,
        '--outcome', 'implementation_ready_for_review', '--output', '.agenticloop/tmp/baseline-return.json', '--json',
      ]);
    }
  } else if (scenario === 'long-pause') {
    await harness.start();
    await harness.run('handoff-preflight-after-pause', ['task', 'handoff-preflight', harness.taskId, '--host', 'opencode', '--json']);
    availability = 'unavailable';
    unavailableReason = 'missing command: current CLI exposes no injectable --now/clock input for a multi-day protected-transition resume';
  } else if (scenario === 'update') {
    const started = await harness.start();
    if (started.status === 0) {
      mkdirSync(join(harness.fixture.root, '.opencode', 'agents'), { recursive: true });
      writeFileSync(join(harness.fixture.root, '.opencode', 'agents', 'generated-baseline.md'), 'generated synthetic fixture\n', 'utf8');
      await harness.run('handoff-preflight-after-generated-update', ['task', 'handoff-preflight', harness.taskId, '--host', 'opencode', '--json']);
      await harness.run('prepare-return-after-generated-update', [
        'task', 'prepare-return', harness.taskId, '--packet', '.agenticloop/tmp/baseline-packet.json',
        '--check-evidence', `.agenticloop/tmp/${harness.taskId}-checks.json`,
        '--outcome', 'implementation_ready_for_review', '--output', '.agenticloop/tmp/baseline-return.json', '--json',
      ]);
    }
  } else if (scenario === 'operator-edit') {
    const started = await harness.start();
    if (started.status === 0) {
      writeFileSync(join(harness.fixture.root, 'src', 'operator-edit.js'), 'export const operatorEdit = true;\n', 'utf8');
      commit(harness.fixture.root, 'operator product correction');
      await harness.run('handoff-preflight-after-operator-edit', ['task', 'handoff-preflight', harness.taskId, '--host', 'opencode', '--json']);
      availability = 'unavailable';
      unavailableReason = 'missing command: current CLI exposes no explicit product-adoption command for an out-of-band reachable commit';
    }
  } else {
    // The first shape is activation expiry. The current public CLI has no
    // injectable transition clock, so exercising it honestly blocks before the
    // other seven predicates can be reached. Keep each missing injector named
    // rather than manufacturing lookalike durable records.
    await harness.start();
    availability = 'unavailable';
    unavailableReason = 'missing command: no public injector can create the eight ordered current-policy predicates (first required injector: expired activation at protected-transition time)';
  }

  const failure = firstFailure(harness.commands);
  return Object.freeze({
    scenario,
    availability,
    unavailableReason,
    refusal: failure ? Object.freeze({ step: failure.step, code: failure.code }) : null,
    commands: Object.freeze(harness.commands.map(command => Object.freeze({ ...command }))),
    counters: Object.freeze({ ...harness.measurement().counters }),
  });
}
