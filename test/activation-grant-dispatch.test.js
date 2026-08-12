/**
 * Activation against committed decomposition evidence, hardened mode, and
 * legacy capture compatibility: derived bindings live and die with the
 * committed decomposition, and host-signed legacy captures keep working.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ACTIVATION_ASSURANCE_LIMITATIONS,
  RETURN_ASSURANCE_LIMITATIONS,
  resolveTaskActivationBinding,
} from '../src/activation-grant.js';
import { ACTIVATION_STORE_ROOT } from '../src/activation-store.js';
import { prepareRoleDispatch } from '../src/dispatch-envelope.js';
import {
  loadTaskActivationEvidence,
  resolveActivationVerification,
} from '../src/activation-resolution.js';
import { createDispatchFixture, prepare, sha256 } from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import {
  CONTRACT_DIGEST,
  REPOSITORY,
  bindingFor,
  grantFor,
  interactiveOptions,
  prepareThroughCli,
  scaffoldFixture,
} from './helpers/activation-fixture.js';

let temp;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'agenticloop-activation-dispatch-'));
});

after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
describe('work-unit activation from committed decomposition', () => {
  it('derives a child binding only from the canonical ready set', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-work-unit');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'fixture-work-unit', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, `${activated.stdout}\n${activated.stderr}`);
    const report = JSON.parse(activated.stdout);
    assert.equal(report.scopeType, 'work_unit');
    assert.equal(report.workUnitId, 'fixture-work-unit');
    assert.equal(report.tasks.length, 1);
    assert.equal(report.tasks[0].derivation, 'committed_decomposition_membership');

    const packet = await prepareThroughCli(fixture);
    assert.equal(packet.activationBinding.binding.derivation, 'committed_decomposition_membership');
    assert.equal(packet.activationBinding.grant.scope.type, 'work_unit');
    assert.equal(packet.activationBinding.grant.workUnitId, 'fixture-work-unit');
    assert.equal(packet.assurance.activationDerivation, 'committed_decomposition_membership');
  });

  it('refuses a work unit with no committed decomposition source', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-work-unit-missing');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'no-such-work-unit', '--json', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 1);
    assert.equal(existsSync(join(fixture.root, ACTIVATION_STORE_ROOT)), false);
  });

  it('invalidates a derived binding when the committed decomposition changes', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-work-unit-changed');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'fixture-work-unit', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const sourcePath = join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json');
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    source.observedAt = new Date(Date.parse(source.observedAt) + 1000).toISOString();
    writeFileSync(sourcePath, JSON.stringify(source, null, 2), 'utf8');
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /decomposition/);
  });

  it('invalidates a derived binding when the committed decomposition is removed', async () => {
    const fixture = await scaffoldFixture(temp, 'activate-work-unit-removed');
    const activated = await runCliInProcess(
      ['activate', '--work-unit', 'fixture-work-unit', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    rmSync(join(fixture.root, '.agenticloop', 'decompositions', 'T-001.json'));
    const status = await runCliInProcess(['activation', 'status', 'T-001', '--json', '--target', fixture.root], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const report = JSON.parse(status.stdout);
    assert.equal(report.bindings[0].usable, false);
    assert.match(report.bindings[0].reasons.join('; '), /requires current committed decomposition evidence/);
  });

  it('never lets a work-unit grant authorize a task outside its ready set', () => {
    const grant = grantFor({ scope: { type: 'work_unit', workUnitId: 'wu-1' } });
    const binding = bindingFor(grant, {
      taskId: 'T-999',
      carrier: '.agenticloop/tasks/T-999.md',
      derivation: 'committed_decomposition_membership',
      decompositionSource: {
        sourceRef: '.agenticloop/decompositions/T-001.json',
        sourceDigest: sha256('source'),
        scanSemanticDigest: `sha256:agenticloop.parallel-scan.v1:${'d'.repeat(64)}`,
        workUnitId: 'wu-1',
        observedAt: '2026-08-09T00:00:00.000Z',
      },
    });
    const resolved = resolveTaskActivationBinding({
      grant: { ...grant, authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } },
      binding: { ...binding, authentication: { algorithm: 'ed25519', keyId: 'k', value: 'ed25519:AA==' } },
      repositoryIdentity: REPOSITORY,
      backend: 'files',
      taskId: 'T-999',
      carrier: '.agenticloop/tasks/T-999.md',
      taskContractDigest: CONTRACT_DIGEST,
      verifySignature: () => true,
      decomposition: {
        kind: 'agenticloop.decomposition-provenance',
        authority: 'maintainer',
        source: 'task-decomposition',
        sourceRef: '.agenticloop/decompositions/T-001.json',
        sourceDigest: sha256('source'),
        observedAt: '2026-08-09T00:00:00.000Z',
        scan: {
          semanticDigest: `sha256:agenticloop.parallel-scan.v1:${'d'.repeat(64)}`,
          workUnit: { id: 'wu-1' },
          inventory: { complete: true },
          decomposition: { state: 'complete' },
          readyTaskIds: ['T-001'],
        },
      },
    });
    assert.equal(resolved.ok, false);
    assert.ok(resolved.errors.some(item => /not a member of the canonical decomposition ready set/.test(item.message)));
  });
});

describe('hardened mode', () => {
  it('accepts host-signed activation and reports the hardened minimums', async () => {
    const fixture = await createDispatchFixture(temp, 'hardened-host-signed');
    const prepared = prepareRoleDispatch(fixture, {
      ...fixture.options,
      assurancePolicy: { mode: 'hardened', policySource: 'operator_pin' },
    });
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.assurance.mode, 'hardened');
    assert.equal(prepared.packet.assurance.policySource, 'operator_pin');
    assert.equal(prepared.packet.assurance.activation, 'host_signed');
    assert.equal(prepared.packet.assurance.minimumActivation, 'host_signed');
    assert.equal(prepared.packet.assurance.minimumReturn, 'host_receipt');
    assert.ok(prepared.packet.assurance.limitations.includes(RETURN_ASSURANCE_LIMITATIONS.host_receipt));
    assert.equal(
      prepared.packet.assurance.limitations.some(item => /NOT host-authenticated/.test(item)),
      false
    );
  });

  it('refuses an operator-confirmed grant under a hardened packet policy', async () => {
    const fixture = await scaffoldFixture(temp, 'hardened-operator-confirmed');
    const activated = await runCliInProcess(
      ['activate', 'T-001', '--target', fixture.root],
      interactiveOptions(fixture)
    );
    assert.equal(activated.status, 0, activated.stderr);
    const evidence = loadTaskActivationEvidence(fixture.root, { backend: 'files', taskId: 'T-001' });
    const verification = resolveActivationVerification(fixture.root, {
      operatorTrustRoot: fixture.operatorTrustRoot,
      operatorActivationRoot: fixture.operatorActivationRoot,
    });
    const prepared = prepareRoleDispatch({
      ...fixture,
      activation: undefined,
      refetchActivationEvidence: () => evidence,
    }, {
      capabilities: fixture.options.capabilities,
      verifyActivationSignature: verification.verify,
      assurancePolicy: { mode: 'hardened', policySource: 'operator_pin' },
    });
    assert.equal(prepared.ok, false);
    assert.match(prepared.validation.errors.join('\n'), /below the effective minimum 'host_signed'/);
    assert.equal(prepared.validation.disposition, 'blocked');
  });
});

describe('legacy activation compatibility', () => {
  it('keeps a host-signed v2 capture working with no activation grant present', async () => {
    const fixture = await createDispatchFixture(temp, 'legacy-capture');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.activationBinding, null);
    assert.equal(prepared.packet.assurance.activation, 'host_signed');
    assert.equal(prepared.packet.assurance.activationSource, 'legacy_task_capture');
    assert.equal(prepared.packet.assurance.activationDerivation, 'legacy_task_capture');
    assert.match(prepared.packet.task.activationDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(prepared.packet.task.activationCaptureRef, '.agenticloop/activation/T-001.json');
    assert.ok(prepared.packet.assurance.limitations.includes(ACTIVATION_ASSURANCE_LIMITATIONS.host_signed));
  });
});
