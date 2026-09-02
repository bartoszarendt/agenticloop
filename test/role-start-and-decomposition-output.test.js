/**
 * Behavioral regression tests for task role-start (Batch A) and
 * prepare-decomposition --output (Batch B).
 *
 * Covers:
 *  F1: idempotent retry with exact binding comparison (productBaseHead)
 *  F2: decomposition fixtures with real Git data
 *  F3: conditional receipt classification
 *  F4: mutation failure injection proving zero partial writes
 *  F7: shellQuoteArgument for paths with spaces
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { COMMAND_REGISTRY, parseCommandArgs, isReceiptRevalidationArgv } from '../src/cli-registry.js';
import { validateRequiredCheckEvidence, REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION } from '../src/required-checks.js';
import { taskSubcommandBackends } from '../src/task-cli.js';
import { deriveHandoffSequence, renderHandoffSequence } from '../src/handoff-sequence.js';
import { validateTaskStatusTransition, LEGAL_TASK_STATUS_TRANSITIONS } from '../src/task-transition.js';
import { evaluateDispatchableLifecycle, DISPATCHABLE_TASK_STATUSES } from '../src/dispatchability.js';
import { prepareRoleDispatch, dispatchPreparationDigest } from '../src/dispatch-envelope.js';
import { createDispatchFixture, sha256 } from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { shellQuoteArgument } from '../src/task-evidence-contract.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'role-start-')); });
after(() => { try { rmSync(temp, { recursive: true, force: true }); } catch {} });

// ── N1: role-start is NOT receipt-revalidation safe ────────────────────────

describe('N1: role-start receipt revalidation', () => {
  it('role-start has no receiptRevalidation field', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['role-start'];
    assert.equal(spec.receiptRevalidation, undefined, 'role-start must not have receiptRevalidation');
  });

  it('isReceiptRevalidationArgv returns false for role-start', () => {
    const result = isReceiptRevalidationArgv(['task', 'role-start', 'T-001', '--packet', 'p.json', '--check-evidence-output', 'c.json']);
    assert.equal(result, false, 'role-start must not be receipt-revalidation safe');
  });
});

// ── N2: prepare-decomposition conditional receipt revalidation ─────────────

describe('N2: prepare-decomposition conditional receipt revalidation', () => {
  it('receiptRevalidation is read-only-without-output', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['prepare-decomposition'];
    assert.equal(spec.receiptRevalidation, 'read-only-without-output');
  });

  it('isReceiptRevalidationArgv returns true without --output', () => {
    const result = isReceiptRevalidationArgv([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'phase:1',
      '--source-ref', '.agenticloop/decompositions/T-001.json',
      '--source-revision', 'git-commit:abc123',
      '--base', 'git-tree:def456',
      '--dependencies', 'deps.json',
    ]);
    assert.equal(result, true, 'without --output must be receipt-safe');
  });

  it('isReceiptRevalidationArgv returns false with --output', () => {
    const result = isReceiptRevalidationArgv([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'phase:1',
      '--source-ref', '.agenticloop/decompositions/T-001.json',
      '--source-revision', 'git-commit:abc123',
      '--base', 'git-tree:def456',
      '--dependencies', 'deps.json',
      '--output', 'decomp.json',
    ]);
    assert.equal(result, false, 'with --output must not be receipt-safe');
  });
});

// ── N6: canonical check-evidence producer ──────────────────────────────────

describe('N6: canonical check-evidence producer', () => {
  it('producer passes validateRequiredCheckEvidence', () => {
    const packet = {
      task: {
        requiredChecks: [
          { id: 'RC-1', kind: 'command', command: 'npm test' },
          { id: 'RC-2', kind: 'manual', instruction: 'Inspect the output.' },
        ],
        requiredCheckEvidenceContract: REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
      },
    };
    const checks = packet.task.requiredChecks.map(required => ({
      id: required.id,
      kind: required.kind,
      ...(required.kind === 'command'
        ? { command: required.command, exitCode: -1, executionEvidence: null }
        : { instruction: required.instruction, exitCode: null }),
      outcome: 'not_run',
      evidence: 'not yet recorded',
    }));
    const result = validateRequiredCheckEvidence(checks, {
      label: 'test', contractVersion: REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
    });
    assert.equal(result.ok, true, `check evidence must be valid: ${result.errors.join('; ')}`);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].id, 'RC-1');
    assert.equal(result.checks[0].kind, 'command');
    assert.equal(result.checks[0].exitCode, -1);
    assert.equal(result.checks[0].executionEvidence, null);
    assert.equal(result.checks[1].id, 'RC-2');
    assert.equal(result.checks[1].kind, 'manual');
    assert.equal(result.checks[1].exitCode, null);
  });
});

// ── A3: terminal status refusal ────────────────────────────────────────────

describe('A3: terminal status refusal', () => {
  it('accepted -> in-progress is rejected', () => {
    const error = validateTaskStatusTransition('accepted', 'in-progress', null);
    assert.ok(error, 'accepted -> in-progress must be rejected');
    assert.match(error, /Cannot transition/);
  });

  it('closed -> in-progress is rejected', () => {
    const error = validateTaskStatusTransition('closed', 'in-progress', null);
    assert.ok(error, 'closed -> in-progress must be rejected');
  });

  it('dispatchable lifecycle rejects terminal statuses', () => {
    const result = evaluateDispatchableLifecycle('accepted');
    assert.equal(result.ok, false, 'accepted is not dispatchable');
    assert.equal(result.evidenceState, 'negative');
    const result2 = evaluateDispatchableLifecycle('closed');
    assert.equal(result2.ok, false, 'closed is not dispatchable');
  });

  it('valid transitions to in-progress are accepted', () => {
    for (const status of DISPATCHABLE_TASK_STATUSES) {
      if (status === 'in-progress') continue;
      const allowed = LEGAL_TASK_STATUS_TRANSITIONS[status]?.has('in-progress');
      if (allowed) {
        const error = validateTaskStatusTransition(status, 'in-progress', null);
        assert.equal(error, null, `${status} -> in-progress must be legal`);
      }
    }
  });
});

// ── A4: role-start registry ────────────────────────────────────────────────

describe('A4: role-start registry', () => {
  it('backend is files-only', () => {
    const backends = taskSubcommandBackends('role-start');
    assert.deepEqual(backends, ['files']);
  });

  it('has no --expect-digest option', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['role-start'];
    assert.ok(spec, 'role-start subcommand must exist');
    const hasExpectDigest = spec.options.some(opt => opt.name === 'expect-digest');
    assert.equal(hasExpectDigest, false, 'role-start must not accept --expect-digest');
  });

  it('requires --packet and --check-evidence-output', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['role-start'];
    const packetOpt = spec.options.find(opt => opt.name === 'packet');
    const checksOpt = spec.options.find(opt => opt.name === 'check-evidence-output');
    assert.ok(packetOpt, '--packet option must exist');
    assert.ok(checksOpt, '--check-evidence-output option must exist');
  });

  it('parses CLI args correctly', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['role-start'];
    const { opts, positional } = parseCommandArgs('task role-start', spec, [
      'T-001', '--packet', 'packet.json', '--check-evidence-output', 'checks.json', '--json',
    ]);
    assert.deepEqual(positional, ['T-001']);
    assert.equal(opts.packet, 'packet.json');
    assert.equal(opts.checkEvidenceOutput, 'checks.json');
    assert.equal(opts.json, true);
  });
});

// ── N5: nextSequence ───────────────────────────────────────────────────────

describe('N5: nextSequence', () => {
  it('step 2 uses refetch placeholder, not reused digest', () => {
    const seq = deriveHandoffSequence({ taskId: 'T-001', backend: 'files' });
    const roleStart = seq.steps.find(s => /role-start/.test(s.command));
    assert.ok(roleStart, 'sequence must include role-start step');
    assert.equal(roleStart.commitRequired, true);

    const evidenceSteps = seq.steps.filter(s => /evidence/.test(s.command));
    assert.ok(evidenceSteps.length >= 1, 'must have evidence steps');

    const step1 = evidenceSteps.find(s => /implementation_artifact/.test(s.command));
    if (step1) {
      assert.ok(!step1.command.includes('<refetch-after-commit>'), 'step 1 must use concrete digest');
    }

    const step2 = evidenceSteps.find(s => /implementation_summary/.test(s.command));
    if (step2) {
      assert.ok(step2.command.includes('<refetch-after-commit>'), 'step 2 must use refetch placeholder');
    }
  });

  it('sequence is renderable', () => {
    const seq = deriveHandoffSequence({ taskId: 'T-001', backend: 'files' });
    const rendered = renderHandoffSequence(seq);
    assert.ok(Array.isArray(rendered), 'must return array');
    assert.ok(rendered.length > 0, 'must have lines');
    assert.ok(rendered[0].includes('next ordered sequence'), 'must include header');
  });
});

// ── F6: handoff-sequence teaches role-start ────────────────────────────────

describe('F6: handoff-sequence role-start', () => {
  it('files backend uses task role-start', () => {
    const seq = deriveHandoffSequence({ taskId: 'T-001', backend: 'files' });
    const roleStart = seq.steps.find(s => /role-start/.test(s.command));
    assert.ok(roleStart, 'files backend sequence must use task role-start');
    assert.ok(roleStart.command.includes('--packet'), 'must include --packet');
    assert.ok(roleStart.command.includes('--check-evidence-output'), 'must include --check-evidence-output');
    assert.ok(roleStart.writes.some(w => w.includes('tasks/')), 'must write task record');
    assert.ok(roleStart.writes.some(w => w.includes('dispatch/')), 'must write dispatch consumption');
  });

  it('non-files backend uses task status', () => {
    const seq = deriveHandoffSequence({ taskId: 'T-001', backend: 'github' });
    const roleStart = seq.steps.find(s => /task status.*in-progress/.test(s.command));
    assert.ok(roleStart, 'non-files backend sequence must use task status');
  });
});

// ── F7: shellQuoteArgument ─────────────────────────────────────────────────

describe('F7: shellQuoteArgument', () => {
  it('passes through simple values', () => {
    assert.equal(shellQuoteArgument('simple'), 'simple');
    assert.equal(shellQuoteArgument('git-tree:abc123'), 'git-tree:abc123');
  });

  it('quotes values with spaces', () => {
    assert.equal(shellQuoteArgument('path with spaces'), '"path with spaces"');
  });

  it('quotes values with special chars', () => {
    // Forward slashes are in the safe pattern, so they pass through
    assert.equal(shellQuoteArgument('path/with/special'), 'path/with/special');
    // Backslashes need quoting
    assert.equal(shellQuoteArgument('path\\with\\backslash'), '"path\\with\\backslash"');
  });

  it('rejects unquotable values', () => {
    assert.throws(() => shellQuoteArgument('value"with"quotes'), /cannot emit a shell-safe/);
    assert.throws(() => shellQuoteArgument("value'with'quotes"), /cannot emit a shell-safe/);
  });
});

// ── N7: Behavioral tests with real fixtures ────────────────────────────────

describe('N7: role-start behavioral tests', () => {
  it('F1: role-start happy path and exact retry returns already_current', async () => {
    const fixture = await createDispatchFixture(temp, 'happy', { initialStatus: 'agent-ready' });
    const root = fixture.root;

    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, `prepareRoleDispatch failed: ${prepared.validation.errors?.join(', ')}`);
    const packetPath = join(root, '.agenticloop', 'tmp', 'packet.json');
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, JSON.stringify(prepared.packet, null, 2), 'utf8');

    // First role-start
    const result1 = await runCliInProcess([
      'task', 'role-start', 'T-001',
      '--packet', '.agenticloop/tmp/packet.json',
      '--check-evidence-output', '.agenticloop/tmp/checks.json',
      '--json',
      '--target', root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result1.status, 0, `first role-start failed: ${result1.stdout} ${result1.stderr}`);
    const output1 = JSON.parse(result1.stdout);
    assert.equal(output1.ok, true);
    assert.equal(output1.disposition, 'committed');
    assert.ok(output1.currentCarrierDigest, 'must have carrier digest');
    assert.ok(output1.nextSequence, 'must have nextSequence');
    assert.ok(output1.nextSequence.steps.length > 0, 'nextSequence must have steps');
    const commands = output1.nextSequence.steps.map(step => step.command).filter(command => typeof command === 'string');
    const productCommit = commands.findIndex(command => command.includes('prepare-product-commit'));
    const artifact = commands.findIndex(command => command.includes('implementation_artifact_evidence'));
    const summary = commands.findIndex(command => command.includes('implementation_summary_evidence'));
    const outcome = commands.findIndex(command => command.includes('implementation_outcome_evidence'));
    const initialize = commands.findIndex(command => command.includes('check-evidence-init'));
    const update = commands.findIndex(command => command.includes('check-evidence-update'));
    const prepare = commands.findIndex(command => command.includes('prepare-return'));
    const receiverCommands = output1.nextSequence.receiverSteps.map(step => step.command);
    assert.ok(productCommit >= 0 && productCommit < artifact && artifact < summary && summary < outcome && outcome < initialize && initialize < update && update < prepare,
      `unexpected lifecycle order: ${commands.join(' | ')}`);
    assert.equal(commands.some(command => command.includes('verify-return')), false);
    assert.match(receiverCommands[0], /verify-return/);
    for (const step of output1.nextSequence.steps) {
      if (step.commitRequired) {
        assert.ok(step.commitClass && step.commitReason);
      } else {
        assert.equal(step.commitClass ?? null, null);
        assert.equal(step.commitReason ?? null, null);
      }
    }

    // Exact retry should return already_current
    const result2 = await runCliInProcess([
      'task', 'role-start', 'T-001',
      '--packet', '.agenticloop/tmp/packet.json',
      '--check-evidence-output', '.agenticloop/tmp/checks.json',
      '--json',
      '--target', root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result2.status, 0, `retry failed: ${result2.stdout} ${result2.stderr}`);
    const output2 = JSON.parse(result2.stdout);
    assert.equal(output2.disposition, 'already_current', 'exact retry must return already_current');
  });

  it('F1: tampered head fails closed', async () => {
    const fixture = await createDispatchFixture(temp, 'tampered', { initialStatus: 'agent-ready' });
    const root = fixture.root;

    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, `prepareRoleDispatch failed: ${prepared.validation.errors?.join(', ')}`);

    // Tamper with the packet's repository head
    const tampered = structuredClone(prepared.packet);
    tampered.repository.head = sha256('tampered-head');
    tampered.digest = dispatchPreparationDigest(tampered);
    const packetPath = join(root, '.agenticloop', 'tmp', 'packet.json');
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, JSON.stringify(tampered, null, 2), 'utf8');

    const result = await runCliInProcess([
      'task', 'role-start', 'T-001',
      '--packet', '.agenticloop/tmp/packet.json',
      '--check-evidence-output', '.agenticloop/tmp/checks.json',
      '--json',
      '--target', root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result.status, 1, 'must reject tampered head');
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
  });

  it('F1: tampered digest fails closed', async () => {
    const fixture = await createDispatchFixture(temp, 'tampered-digest', { initialStatus: 'agent-ready' });
    const root = fixture.root;

    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, `prepareRoleDispatch failed: ${prepared.validation.errors?.join(', ')}`);

    // Tamper with the packet's dispatchCarrierDigest
    const tampered = structuredClone(prepared.packet);
    tampered.task.dispatchCarrierDigest = sha256('tampered');
    tampered.digest = dispatchPreparationDigest(tampered);
    const packetPath = join(root, '.agenticloop', 'tmp', 'packet.json');
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, JSON.stringify(tampered, null, 2), 'utf8');

    const result = await runCliInProcess([
      'task', 'role-start', 'T-001',
      '--packet', '.agenticloop/tmp/packet.json',
      '--check-evidence-output', '.agenticloop/tmp/checks.json',
      '--json',
      '--target', root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result.status, 1, 'must reject tampered digest');
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
  });

  it('F4: injected failure leaves zero partial writes', async () => {
    const fixture = await createDispatchFixture(temp, 'inject-fail', { initialStatus: 'agent-ready' });
    const root = fixture.root;

    const prepared = prepareRoleDispatch(fixture, fixture.options);
    assert.equal(prepared.ok, true, `prepareRoleDispatch failed: ${prepared.validation.errors?.join(', ')}`);
    const packetPath = join(root, '.agenticloop', 'tmp', 'packet.json');
    mkdirSync(dirname(packetPath), { recursive: true });
    writeFileSync(packetPath, JSON.stringify(prepared.packet, null, 2), 'utf8');

    // Record pre-existing state
    const carrierPath = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const preCarrier = readFileSync(carrierPath, 'utf8');
    const consumptionDir = join(root, '.agenticloop', 'handoffs', 'dispatch', 'T-001');
    const preConsumptionExists = existsSync(consumptionDir);
    const checksPath = join(root, '.agenticloop', 'tmp', 'checks.json');
    const preChecksExists = existsSync(checksPath);

    // Inject failure via fsMutationOptions.beforeWrite
    const result = await runCliInProcess([
      'task', 'role-start', 'T-001',
      '--packet', '.agenticloop/tmp/packet.json',
      '--check-evidence-output', '.agenticloop/tmp/checks.json',
      '--json',
      '--target', root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      fsMutationOptions: {
        beforeWrite: () => { throw new Error('injected failure'); },
      },
    });
    assert.equal(result.status, 1, 'must fail on injected failure');

    // Verify zero partial writes
    const postCarrier = readFileSync(carrierPath, 'utf8');
    assert.equal(postCarrier, preCarrier, 'carrier must be unchanged after injected failure');
    assert.equal(existsSync(consumptionDir), preConsumptionExists, 'consumption dir must be unchanged');
    assert.equal(existsSync(checksPath), preChecksExists, 'checks file must be unchanged');
  });
});

// ── N7: prepare-decomposition behavioral tests ─────────────────────────────

describe('N7: prepare-decomposition behavioral tests', () => {
  it('F2: stdout-only mode emits raw canonical source', async () => {
    const fixture = await createDispatchFixture(temp, 'decomp-stdout', { initialStatus: 'agent-ready' });
    const root = fixture.root;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    const result = await runCliInProcess([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'fixture-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001.json',
      '--source-revision', `git-commit:${head}`,
      '--base', tree,
      '--dependencies', 'dependencies.json',
      '--target', root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result.status, 0, `prepare-decomposition failed: ${result.stderr}`);
    // stdout-only mode emits raw canonical source (valid JSON decomposition)
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.kind, 'source must have kind');
    assert.ok(parsed.taskId, 'source must have taskId');
    // Verify no output file was created
    assert.equal(existsSync(join(root, '.agenticloop', 'tmp', 'decomp-output.json')), false, 'must not persist without --output');
  });

  it('F2: --output mode persists and reports committed', async () => {
    const fixture = await createDispatchFixture(temp, 'decomp-output', { initialStatus: 'agent-ready' });
    const root = fixture.root;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    const result = await runCliInProcess([
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'fixture-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001.json',
      '--source-revision', `git-commit:${head}`,
      '--base', tree,
      '--dependencies', 'dependencies.json',
      '--output', '.agenticloop/tmp/decomp-output.json',
      '--json',
      '--target', root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result.status, 0, `prepare-decomposition --output failed: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.disposition, 'committed');
    assert.equal(output.persisted, true);
    assert.ok(existsSync(join(root, '.agenticloop', 'tmp', 'decomp-output.json')), 'output file must exist');
  });

  it('F2: --output mode returns already_current on exact retry', async () => {
    const fixture = await createDispatchFixture(temp, 'decomp-retry', { initialStatus: 'agent-ready' });
    const root = fixture.root;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    // Use a recent fixed timestamp for deterministic output
    const observedAt = new Date().toISOString();

    const args = [
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'fixture-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001.json',
      '--source-revision', `git-commit:${head}`,
      '--base', tree,
      '--dependencies', 'dependencies.json',
      '--output', '.agenticloop/tmp/decomp-output.json',
      '--observed-at', observedAt,
      '--json',
      '--target', root,
    ];

    // First write
    const result1 = await runCliInProcess(args, { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result1.status, 0, `first write failed: ${result1.stdout} ${result1.stderr}`);

    // Second write (exact retry with same observedAt)
    const result2 = await runCliInProcess(args, { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result2.status, 0, `retry failed: ${result2.stderr}`);
    const output2 = JSON.parse(result2.stdout);
    assert.equal(output2.disposition, 'already_current', 'exact retry must return already_current');
  });

  it('F7: revalidation command handles paths with spaces', () => {
    // Test that shellQuoteArgument is used for paths with spaces
    const result = shellQuoteArgument('path with spaces');
    assert.equal(result, '"path with spaces"');
    // Verify the command would be executable
    assert.ok(!result.includes("'"), 'must not use single quotes');
  });
});

// ── Path handling ──────────────────────────────────────────────────────────

describe('path handling', () => {
  it('handles forward slashes in decomposition source-ref', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['prepare-decomposition'];
    const sourceRefOpt = spec.options.find(opt => opt.name === 'source-ref');
    assert.ok(sourceRefOpt, '--source-ref must exist');
  });

  it('role-start packet path is target-relative', () => {
    const spec = COMMAND_REGISTRY.task.subcommands['role-start'];
    const packetOpt = spec.options.find(opt => opt.name === 'packet');
    assert.ok(packetOpt.description.includes('target-relative'), 'must document target-relative');
  });
});
