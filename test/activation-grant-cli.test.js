/**
 * `agenticloop activate`, end to end on the files and GitHub backends: a
 * non-interactive caller cannot reach `operator_confirmed`, and no shipped
 * host adapter becomes supported because an activation grant exists.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ACTIVATION_ASSURANCE_LIMITATIONS,
  OPERATOR_CONFIRMATION_PHRASE,
  activationGrantDigest,
  createTaskActivationBinding,
  taskActivationBindingDigest,
  validateActivationGrantShape,
  validateTaskActivationBindingShape,
} from '../src/activation-grant.js';
import { activationPolicyPinPath } from '../src/activation-policy.js';
import { operatorActivationKeyPath } from '../src/activation-trust.js';
import {
  ACTIVATION_STORE_ROOT,
  bindingRecordPath,
  grantRecordPath,
} from '../src/activation-store.js';
import {
  SHIPPED_ACTIVATION_ADAPTERS,
  activationCapabilityInventory,
  dispatchPreparationDigest,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import { resolvePacketActivationBinding } from '../src/activation-resolution.js';
import { targetRepositoryIdentity } from '../src/host-trust.js';
import { taskContractDigest } from '../src/task-contract-baseline.js';
import { git } from './helpers/dispatch-fixture.js';
import { runCliInProcess, scriptedPromptFactory } from './helpers/run-cli.js';
import {
  correctContract,
  grantFor,
  interactiveOptions,
  runPrepareDispatch,
  scaffoldFixture,
  writeSecondTask,
} from './helpers/activation-fixture.js';

let temp;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'agenticloop-activation-cli-'));
});

after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
describe('agenticloop activate', () => {
  it('refuses non-interactive execution and offers no --yes escape hatch', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-noninteractive');
    const result = await runCliInProcess(['activate', 'T-001', '--json', '--target', fixture.root], {
      isTTY: false,
      stdinIsTTY: false,
      ci: false,
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /interactive terminal/);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
    // The refusal happens before any side effect, inside or outside the target:
    // a non-interactive caller cannot even cause the operator key to exist.
    assert.equal(existsSync(operatorActivationKeyPath(fixture.root, fixture.operatorActivationRoot)), false);

    const usage = await runCliInProcess(['activate', 'T-001', '--yes', '--target', fixture.root], {
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(usage.status, 2);

    // `--dry-run` is read-only, so it stays available non-interactively and
    // still creates nothing.
    const planned = await runCliInProcess(['activate', 'T-001', '--dry-run', '--target', fixture.root], {
      isTTY: false, stdinIsTTY: false, ci: false,
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /Dry run: no activation grant was created/);
    assert.equal(existsSync(operatorActivationKeyPath(fixture.root, fixture.operatorActivationRoot)), false);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('refuses to run under CI', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-ci');
    const result = await runCliInProcess(['activate', 'T-001', '--json', '--target', fixture.root], {
      isTTY: true,
      stdinIsTTY: true,
      ci: true,
      promptFactory: scriptedPromptFactory([OPERATOR_CONFIRMATION_PHRASE]),
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /refuses to run under CI/);
  });

  it('creates nothing when the operator does not type the exact phrase', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-cancel');
    const result = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture, ['y'])
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Activation cancelled/);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('shows the exact scope before asking and writes nothing on --dry-run', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-dry');
    const result = await runCliInProcess(
      ['activate', 'T-001', '--dry-run', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /contract digest: sha256:v1:[a-f0-9]{64}/);
    assert.match(result.stdout, /carrier:\s+\.agenticloop\/tasks\/T-001\.md/);
    assert.match(result.stdout, /resulting activation assurance: operator_confirmed/);
    assert.match(result.stdout, /Dry run: no activation grant was created/);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('activates an existing files task and makes it dispatchable in standard mode', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-files');
    // Before activation, dispatch is blocked and names the exact repair command.
    const blocked = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /npx agenticloop activate T-001/);

    const activated = await runCliInProcess(
      ['activate', 'T-001', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const report = JSON.parse(activated.stdout);
    assert.equal(report.assurance.activation, 'operator_confirmed');
    assert.equal(report.assurance.mode, 'standard');
    assert.equal(report.assurance.minimumReturn, 'session_reported');
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].taskId, 'T-001');
    assert.equal(report.tasks[0].contractDigest, fixture.contractDigest);
    assert.equal(report.tasks[0].derivation, 'direct_operator_confirmation');
    assert.ok(report.assurance.limitations.includes(ACTIVATION_ASSURANCE_LIMITATIONS.operator_confirmed));

    // The task record itself was never rewritten: no active activation
    // frontmatter appeared (the template's commented placeholders remain).
    const body = readFileSync(fixture.taskPath, 'utf8');
    assert.equal(/^activation_input_digest:/m.test(body), false);
    assert.equal(/^activation_capture_ref:/m.test(body), false);
    assert.equal(taskContractDigest(body).digest, fixture.contractDigest);

    const dispatched = await runPrepareDispatch(fixture);
    assert.equal(dispatched.status, 0, `${dispatched.stdout}\n${dispatched.stderr}`);
    // Criterion: the dispatch output states both grades truthfully.
    assert.match(dispatched.stderr, /^activation: operator_confirmed/m);
    assert.match(dispatched.stderr, /^return:\s+session_reported/m);
    assert.match(dispatched.stderr, /not an isolated host signer/);
    const packet = JSON.parse(dispatched.stdout);
    assert.equal(packet.activation, null);
    assert.equal(packet.activationBinding.grant.assurance, 'operator_confirmed');
    assert.equal(packet.activationBinding.binding.derivation, 'direct_operator_confirmation');
    assert.equal(packet.activationBinding.binding.taskContractDigest, fixture.contractDigest);
    assert.ok(packet.activationBinding.grant.authentication.value);
    assert.ok(packet.activationBinding.binding.authentication.value);
    assert.equal(packet.returnAdapter, null);
    assert.equal(packet.assurance.activation, 'operator_confirmed');
    assert.equal(packet.assurance.activationSource, 'activation_grant');
    assert.equal(packet.assurance.mode, 'standard');
    assert.equal(packet.assurance.minimumReturn, 'session_reported');
    assert.equal(packet.task.activationDigest, null);
    assert.equal(packet.task.activationCaptureRef, null);

    const forged = structuredClone(packet);
    forged.activationBinding.grant.evidence.scopeSummaryDigest = `sha256:${'f'.repeat(64)}`;
    forged.activationBinding.grant.digest = activationGrantDigest(forged.activationBinding.grant);
    forged.activationBinding.binding.grantDigest = forged.activationBinding.grant.digest;
    forged.activationBinding.binding.digest = taskActivationBindingDigest(forged.activationBinding.binding);
    forged.digest = dispatchPreparationDigest(forged);
    const forgedValidation = validateDispatchPreparation(forged, {
      resolveActivationBinding: candidate => resolvePacketActivationBinding(fixture.root, {
        operatorTrustRoot: fixture.operatorTrustRoot,
        operatorActivationRoot: fixture.operatorActivationRoot,
      }, candidate),
    });
    assert.equal(forgedValidation.ok, false);
    assert.match(forgedValidation.errors.join('\n'), /signature|producer must equal|does not verify/);
  });

  it('activates several tasks under one confirmation', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-multi');
    writeSecondTask(fixture, 'T-002');
    const activated = await runCliInProcess(
      ['activate', 'T-001', 'T-002', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const report = JSON.parse(activated.stdout);
    assert.deepEqual(report.tasks.map(task => task.taskId).sort(), ['T-001', 'T-002']);
    assert.equal(new Set(report.tasks.map(() => report.grantId)).size, 1);
  });

  it('produces no partial authority when one task in the set does not resolve', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-partial');
    const activated = await runCliInProcess(
      ['activate', 'T-001', 'T-404', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 1);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('invalidates a binding when the task contract changes', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-contract-change');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const priorDigest = fixture.contractDigest;
    const body = readFileSync(fixture.taskPath, 'utf8').replace('## Scope', '## Scope\n\nExpanded scope line.');
    writeFileSync(fixture.taskPath, body, 'utf8');
    git(fixture.root, ['add', '.agenticloop/tasks/T-001.md']);
    git(fixture.root, ['commit', '-m', 'change contract\n\nTask: T-001\nAgent: maintainer']);
    await correctContract(fixture, priorDigest, 'expand scope');
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /task contract changed after activation/);
  });

  it('refuses a hand-authored target-local grant that is internally self-consistent', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-forged');
    const repositoryIdentity = targetRepositoryIdentity(fixture.root);
    const grant = grantFor({
      repositoryIdentity,
      scope: { type: 'exact_tasks', taskIds: ['T-001'] },
    });
    // A "signature" the forger can author, over a digest that really matches.
    const forgedGrant = { ...grant, authentication: { algorithm: 'ed25519', keyId: 'operator-deadbeefdeadbeef', value: `ed25519:${Buffer.alloc(64).toString('base64')}` } };
    const binding = createTaskActivationBinding({
      grant: forgedGrant,
      backend: 'files',
      taskId: 'T-001',
      carrier: '.agenticloop/tasks/T-001.md',
      taskContractDigest: fixture.contractDigest,
      derivation: 'direct_operator_confirmation',
    });
    const forgedBinding = { ...binding, authentication: { algorithm: 'ed25519', keyId: 'operator-deadbeefdeadbeef', value: `ed25519:${Buffer.alloc(64).toString('base64')}` } };
    mkdirSync(join(fixture.root, ACTIVATION_STORE_ROOT, 'grants'), { recursive: true });
    mkdirSync(join(fixture.root, ACTIVATION_STORE_ROOT, 'bindings'), { recursive: true });
    writeFileSync(join(fixture.root, grantRecordPath(forgedGrant.grantId)), JSON.stringify(forgedGrant, null, 2), 'utf8');
    writeFileSync(join(fixture.root, bindingRecordPath('files', 'T-001')), JSON.stringify(forgedBinding, null, 2), 'utf8');
    // The record is self-consistent; only the external key can refute it.
    assert.equal(validateActivationGrantShape(forgedGrant).ok, true);
    assert.equal(validateTaskActivationBindingShape(forgedBinding).ok, true);

    const prepared = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(prepared.status, 1);
    assert.match(prepared.stdout, /unauthenticated|does not verify/);
  });

  it('blocks dispatch after the grant is revoked', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-revoke');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    const grantId = JSON.parse(activated.stdout).grantId;
    const revoked = await runCliInProcess(['activation', 'revoke', grantId, '--json', '--target', fixture.root], {
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    assert.equal(revoked.status, 0, revoked.stderr);
    const status = await runCliInProcess(['activation', 'status', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /was revoked/);
    rmSync(join(fixture.root, ACTIVATION_STORE_ROOT, 'revocations'), { recursive: true, force: true });
    const stillBlocked = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(stillBlocked.status, 1);
    assert.match(stillBlocked.stdout, /was revoked/);
  });

  it('refuses operator-confirmed activation under a hardened operator pin', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-hardened');
    mkdirSync(fixture.operatorActivationRoot, { recursive: true });
    writeFileSync(activationPolicyPinPath(fixture.root, fixture.operatorActivationRoot), JSON.stringify({
      kind: 'agenticloop.activation-policy-pin',
      schemaVersion: 1,
      target: { repositoryIdentity: targetRepositoryIdentity(fixture.root) },
      mode: 'hardened',
    }), 'utf8');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    // The grant is created honestly, and the command says plainly that it will
    // not authorize dispatch here.
    assert.equal(activated.status, 0, activated.stderr);
    assert.match(activated.stderr, /hardened mode, which requires host_signed activation/);
    const prepared = await runPrepareDispatch(fixture, ['--json']);
    assert.equal(prepared.status, 1);
    assert.match(prepared.stdout, /below the effective minimum 'host_signed'/);
  });

  it('leaves every shipped adapter unsupported and unpromotable', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-adapters');
    await runCliInProcess(['activate', 'T-001', '--target', fixture.root], interactiveOptions(fixture));
    for (const [adapterId, entry] of Object.entries(SHIPPED_ACTIVATION_ADAPTERS)) {
      assert.equal(entry.captureCapability, 'unsupported', adapterId);
      assert.equal(entry.trustedAdapter, null, adapterId);
    }
    const promoted = activationCapabilityInventory({
      'opencode.command.positional.v1': { capabilities: { activationCapture: 'supported' } },
    });
    assert.equal(promoted['opencode.command.positional.v1'].captureCapability, 'unsupported');
  });
});

describe('agenticloop activate on the GitHub backend', () => {
  /**
   * A GitHub-backed project whose one task lives in an issue body. Only the
   * read-only issue transport is injected; nothing writes to GitHub.
   */
  async function githubFixture(name) {
    const fixture = await scaffoldFixture(temp, name);
    const body = readFileSync(fixture.taskPath, 'utf8');
    writeFileSync(
      join(fixture.root, '.agenticloop', 'project.md'),
      readFileSync(join(fixture.root, '.agenticloop', 'project.md'), 'utf8')
        .replace(/task_backend:\s*\w+/, 'task_backend: github'),
      'utf8'
    );
    const issue = { number: 71, state: 'open', title: 'T-001 Dispatch envelope fixture', body, labels: [] };
    const ghCommandRunner = (_command, args) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ nameWithOwner: 'owner/repository' }) };
      }
      if (args[0] === 'api' && args.includes('--paginate')) {
        return { status: 0, stderr: '', stdout: JSON.stringify([[issue]]) };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stderr: '', stdout: JSON.stringify(issue) };
      }
      return { status: 1, stdout: '', stderr: `unexpected gh invocation: ${args.join(' ')}` };
    };
    return { ...fixture, ghCommandRunner, issue };
  }

  it('activates an existing GitHub task by its canonical identity and digest', async () => {
    const fixture = await githubFixture('activate-github');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--json', '--target', fixture.root],
      { ...interactiveOptions(fixture), ghCommandRunner: fixture.ghCommandRunner }
    );
    assert.equal(activated.status, 0, `${activated.stdout}\n${activated.stderr}`);
    const report = JSON.parse(activated.stdout);
    assert.equal(report.backend, 'github');
    assert.equal(report.tasks[0].taskId, 'T-001');
    assert.equal(report.tasks[0].carrier, 'issue:71');
    assert.equal(report.tasks[0].contractDigest, fixture.contractDigest);
    assert.equal(report.assurance.activation, 'operator_confirmed');
    // The binding is stored under the github-qualified deterministic name, so
    // a files binding for the same task id can never satisfy a GitHub dispatch.
    assert.equal(existsSync(join(fixture.root, bindingRecordPath('github', 'T-001'))), true);
    assert.equal(existsSync(join(fixture.root, bindingRecordPath('files', 'T-001'))), false);
  });

  it('refuses a task the authoritative GitHub inventory does not resolve', async () => {
    const fixture = await githubFixture('activate-github-missing');
    const activated = await runCliInProcess(
      ['activate', 'T-404', '--json', '--target', fixture.root],
      { ...interactiveOptions(fixture), ghCommandRunner: fixture.ghCommandRunner }
    );
    assert.equal(activated.status, 1);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });
});
