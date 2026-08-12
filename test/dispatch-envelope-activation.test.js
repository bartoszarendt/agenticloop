import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  SHIPPED_ACTIVATION_ADAPTERS,
  activationCapabilityInventory,
  activationCaptureDisposition,
  captureActivationInput,
  dispatchPreparationDigest,
  validateActivationCapture,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import { signActivationCapture } from '../src/host-handoff.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { createTestHostTrust, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import {
  DEFAULT_ACTIVATION_PAYLOAD,
  activation,
  createDispatchFixture,
  prepare,
  sha256,
} from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-activation-')); });
after(() => rmSync(temp, { recursive: true, force: true }));
describe('activation adapter authority', () => {
  it('ships a fail-closed inventory with no fixture identity and no supported host', () => {
    assert.deepEqual(Object.keys(SHIPPED_ACTIVATION_ADAPTERS), [
      'opencode.command.positional.v1',
      'claude-code.command.arguments.v1',
      'codex.skill.request.v1',
      'copilot.prompt.input.v1',
      'cursor.command.input.v1',
    ]);
    for (const entry of Object.values(SHIPPED_ACTIVATION_ADAPTERS)) {
      assert.equal(entry.captureCapability, 'unsupported');
      assert.equal(entry.trustedAdapter, null);
    }
  });

  it('recognizes a parser adapter only through an explicitly injected inventory', () => {
    const trust = createTestHostTrust();
    assert.throws(
      () => captureActivationInput({
        adapter: trust.adapterId,
        parserNormalizedPayload: 'x',
        sign: { keyId: trust.keyId, privateKey: trust.privateKey },
      }),
      /not in the resolved capability inventory/
    );
    const capture = activation(trust);
    assert.equal(capture.captureCapability, 'supported');
    assert.equal(validateActivationCapture(capture, { capabilities: trust.capabilities }).ok, true);
    // Without the injected inventory the same bytes are simply an unknown adapter.
    assert.equal(validateActivationCapture(capture).ok, false);
    assert.match(
      validateActivationCapture(capture).errors.join('\n'),
      /is not in the resolved capability inventory/
    );
  });

  it('refuses to let configuration upgrade a shipped fail-closed adapter', () => {
    const inventory = activationCapabilityInventory({
      'opencode.command.positional.v1': {
        adapterId: 'opencode.command.positional.v1',
        keyId: 'k', algorithm: 'ed25519', publicKey: 'AAAA',
        capabilities: { activationCapture: 'supported', returnReceipt: 'supported' },
      },
    });
    assert.equal(inventory['opencode.command.positional.v1'].captureCapability, 'unsupported');
    assert.equal(inventory['opencode.command.positional.v1'].trustedAdapter, null);
  });

  it('rejects a supported capture whose host signature is missing, forged, or wrong-keyed', () => {
    const trust = createTestHostTrust();
    const other = createTestHostTrust({ adapterId: trust.adapterId, keyId: trust.keyId });
    const capture = activation(trust);
    const unsigned = { ...capture, signature: null };
    assert.match(validateActivationCapture(unsigned, { capabilities: trust.capabilities }).errors.join('\n'), /requires a host signature/);
    const forged = { ...capture, signature: { ...capture.signature, value: `ed25519:${Buffer.from('nope').toString('base64')}` } };
    assert.match(validateActivationCapture(forged, { capabilities: trust.capabilities }).errors.join('\n'), /does not verify/);
    // Same adapter and key identity, different key material.
    assert.match(validateActivationCapture(capture, { capabilities: other.capabilities }).errors.join('\n'), /does not verify/);
    const tampered = { ...capture, normalizedActivationDigest: sha256('other'), integrity: 'mismatch' };
    assert.match(validateActivationCapture(tampered, { capabilities: trust.capabilities }).errors.join('\n'), /does not verify/);
  });

  it('produces the four exact capture dispositions before any task mutation', () => {
    const trust = createTestHostTrust();
    const payload = 'Do the exact thing.';
    const verified = activation(trust, payload, sha256(payload));
    assert.deepEqual(activationCaptureDisposition(verified, { capabilities: trust.capabilities }), {
      ok: true, evidenceState: 'current', disposition: 'proceed', errors: [], findings: [],
    });
    // Supported adapter, parser digest present, operator digest absent.
    const missing = captureActivationInput({
      adapter: trust.adapterId, expectedRequestSha256: null, parserNormalizedPayload: payload,
      intendedTaskId: 'T-001',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sign: { keyId: trust.keyId, privateKey: trust.privateKey },
    }, { capabilities: trust.capabilities });
    assert.equal(missing.captureCapability, 'supported');
    assert.equal(missing.normalizedActivationDigest, sha256(payload));
    assert.equal(missing.operatorExpectedDigest, null);
    const missingDisposition = activationCaptureDisposition(missing, { capabilities: trust.capabilities });
    assert.equal(missingDisposition.evidenceState, 'missing');
    assert.equal(missingDisposition.disposition, 'needs_context');
    const mismatch = activation(trust, payload, sha256('a different authorized request'));
    const mismatchDisposition = activationCaptureDisposition(mismatch, { capabilities: trust.capabilities });
    assert.equal(mismatchDisposition.evidenceState, 'changed');
    assert.equal(mismatchDisposition.disposition, 'rejected');
    const unsupported = captureActivationInput({ adapter: 'opencode.command.positional.v1' });
    const unsupportedDisposition = activationCaptureDisposition(unsupported);
    assert.equal(unsupportedDisposition.evidenceState, 'negative');
    assert.equal(unsupportedDisposition.disposition, 'blocked');
    assert.match(unsupportedDisposition.errors.join('\n'), /parser-owned byte artifact/);
  });

  it('fails closed on unknown and self-contradicting adapters', () => {
    const trust = createTestHostTrust();
    const capture = activation(trust);
    const unknown = { ...capture, adapter: 'invented.host.v1' };
    assert.equal(activationCaptureDisposition(unknown, { capabilities: trust.capabilities }).disposition, 'rejected');
    const contradictory = { ...capture, adapter: 'opencode.command.positional.v1' };
    const checked = validateActivationCapture(contradictory, { capabilities: trust.capabilities });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /contradicts the resolved adapter capability/);
    const declaresUnsupported = { ...capture, captureCapability: 'unsupported' };
    assert.equal(validateActivationCapture(declaresUnsupported, { capabilities: trust.capabilities }).ok, false);
  });

  it('rejects a forged verified capture whose digests differ', () => {
    const trust = createTestHostTrust();
    const valid = activation(trust);
    const forged = { ...valid, normalizedActivationDigest: sha256('different'), integrity: 'verified' };
    const checked = validateActivationCapture(forged, { capabilities: trust.capabilities });
    assert.equal(checked.ok, false);
    assert.equal(activationCaptureDisposition(forged, { capabilities: trust.capabilities }).disposition, 'rejected');
  });

  it('derives capture capability from the adapter and never from input data', () => {
    assert.throws(() => captureActivationInput({ captureCapability: 'supported' }), /derived/);
    const unsupported = captureActivationInput({ adapter: 'opencode.command.positional.v1' });
    assert.equal(unsupported.signature, null);
    assert.equal(unsupported.capturedAt, null);
    assert.equal(unsupported.integrity, 'missing');
  });

  it('keeps exact UTF-8 payload distinctions in parser-owned capture digests', () => {
    const trust = createTestHostTrust();
    const payloads = ['line one\nline two', 'line one\r\nline two', ' leading ', 'backtick ` and "quotes"', 'Unicode: café'];
    for (const payload of payloads) {
      const capture = activation(trust, payload, sha256(payload));
      assert.equal(capture.normalizedActivationDigest, sha256(payload));
      assert.equal(capture.integrity, 'verified');
    }
  });

  it('binds v2 captures to one task, repository, capture id, and expiry', () => {
    const firstRoot = mkdtempSync(join(temp, 'capture-root-a-'));
    const secondRoot = mkdtempSync(join(temp, 'capture-root-b-'));
    const trust = createTestHostTrust({ target: firstRoot });
    const valid = activation(trust);
    assert.equal(valid.schemaVersion, 2);
    assert.equal(valid.intendedTaskId, 'T-001');
    assert.match(valid.captureId, /^capture:[0-9a-f-]{36}$/);
    assert.equal(validateActivationCapture(valid, {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-001',
      repositoryIdentity: trust.adapter.repositoryIdentity,
    }).ok, true);
    for (const [field, value] of [
      ['intendedTaskId', 'T-002'],
      ['captureId', 'capture:11111111-1111-4111-8111-111111111111'],
      ['expiresAt', new Date(Date.now() + 7_200_000).toISOString()],
    ]) {
      const tampered = { ...valid, [field]: value };
      assert.equal(validateActivationCapture(tampered, { capabilities: trust.capabilities }).ok, false, field);
    }
    assert.equal(activationCaptureDisposition(valid, {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-002',
    }).ok, false);
    assert.equal(activationCaptureDisposition(valid, {
      capabilities: trust.capabilities,
      repositoryIdentity: `file:${secondRoot.replace(/\\/g, '/')}`,
    }).ok, false);
  });

  it('rejects expired, future-dated, and old supported captures', () => {
    const trust = createTestHostTrust();
    const expired = activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), {
      capturedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const expiredResult = activationCaptureDisposition(expired, { capabilities: trust.capabilities });
    assert.equal(expiredResult.ok, false);
    assert.equal(expiredResult.evidenceState, 'stale');

    const futureSkeleton = {
      ...structuredClone(activation(trust)),
      capturedAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      signature: null,
    };
    const future = signActivationCapture(futureSkeleton, {
      keyId: trust.keyId,
      privateKey: trust.privateKey,
    });
    assert.match(validateActivationCapture(future, { capabilities: trust.capabilities }).errors.join('\n'), /capturedAt/);

    const old = structuredClone(activation(trust));
    old.schemaVersion = 1;
    assert.match(validateActivationCapture(old, { capabilities: trust.capabilities }).errors.join('\n'), /schemaVersion must be 2/);
  });

  it('uses one injected clock for exact expiry and future-skew boundaries', () => {
    const trust = createTestHostTrust();
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    const base = structuredClone(activation(trust));
    const withTimes = (capturedAt, expiresAt) => signActivationCapture({
      ...base,
      capturedAt,
      expiresAt,
      signature: null,
    }, { keyId: trust.keyId, privateKey: trust.privateKey });
    const atExpiry = withTimes('2026-07-30T11:59:59.000Z', '2026-07-30T12:00:00.000Z');
    const common = {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-001',
      repositoryIdentity: trust.repositoryIdentity,
      now,
    };
    const expired = activationCaptureDisposition(atExpiry, common);
    assert.equal(expired.ok, false);
    assert.match(expired.errors.join('\n'), /expired/);

    const withinWindow = withTimes('2026-07-30T12:00:01.000Z', '2026-07-30T12:00:01.001Z');
    assert.equal(activationCaptureDisposition(withinWindow, common).ok, true);

    const beyondSkew = withTimes('2026-07-30T12:00:01.001Z', '2026-07-30T12:00:02.000Z');
    const rejected = activationCaptureDisposition(beyondSkew, common);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /capturedAt/);
  });

  it('returns typed unsupported v2 captures for every shipped adapter without invented proof', () => {
    for (const adapter of Object.keys(SHIPPED_ACTIVATION_ADAPTERS)) {
      const capture = captureActivationInput({ adapter });
      assert.equal(capture.schemaVersion, 2);
      assert.equal(capture.captureId, null);
      assert.equal(capture.intendedTaskId, null);
      assert.equal(capture.expiresAt, null);
      const disposition = activationCaptureDisposition(capture);
      assert.equal(disposition.evidenceState, 'negative');
      assert.equal(disposition.disposition, 'blocked');
    }
  });
});

describe('task-bound activation creation', () => {
  it('revalidates one signed task within its window, rejects cross-task replay, and keeps the public CLI fail-closed', async () => {
    const root = mkdtempSync(join(temp, 'task-new-v2-'));
    createTaskProjectFixture(root);
    const trust = createTestHostTrust({ target: root });
    const operatorTrustRoot = mkdtempSync(join(temp, 'task-new-v2-trust-'));
    const trustStorePath = writeHostTrustStore(operatorTrustRoot, trust);
    const capture = activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), {
      intendedTaskId: 'T-002',
    });
    const validationOptions = {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-002',
      repositoryIdentity: trust.repositoryIdentity,
    };
    assert.equal(activationCaptureDisposition(capture, validationOptions).ok, true);
    // Captures are freshness-bound rather than single-use. Revalidation of the
    // same task and bytes remains valid until the expiry boundary.
    assert.equal(activationCaptureDisposition(capture, validationOptions).ok, true);
    const crossTask = activationCaptureDisposition(capture, {
      ...validationOptions,
      intendedTaskId: 'T-003',
    });
    assert.equal(crossTask.ok, false);
    assert.match(crossTask.errors.join('\n'), /intended task/);

    writeFileSync(join(root, 'capture.json'), JSON.stringify(capture), 'utf8');
    const created = await runCliInProcess([
      'task', 'new', 'bound task', '--id', 'T-002', '--activation-input', 'capture.json',
      '--host-trust-store', trustStorePath, '--json', '--target', root,
    ], { operatorTrustRoot });
    assert.equal(created.status, 1);
    const createdResult = JSON.parse(created.stdout);
    assert.equal(createdResult.evidenceState, 'negative');
    assert.equal(createdResult.disposition, 'blocked');
    assert.match(createdResult.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--short', '.agenticloop/tasks/T-002.md'], { encoding: 'utf8' }).stdout, '');
  });

  it('rejects expired capture, unsupported shipped adapter, and malformed store before mutation', async () => {
    const root = mkdtempSync(join(temp, 'task-new-negative-'));
    createTaskProjectFixture(root);
    const trust = createTestHostTrust({ target: root });
    const operatorTrustRoot = mkdtempSync(join(temp, 'task-new-negative-trust-'));
    const trustStorePath = writeHostTrustStore(operatorTrustRoot, trust);
    const expired = activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), {
      intendedTaskId: 'T-004',
      capturedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const expiredDisposition = activationCaptureDisposition(expired, {
      capabilities: trust.capabilities,
      intendedTaskId: 'T-004',
      repositoryIdentity: trust.repositoryIdentity,
    });
    assert.equal(expiredDisposition.ok, false);
    assert.match(expiredDisposition.errors.join('\n'), /expired/);
    writeFileSync(join(root, 'expired.json'), JSON.stringify(expired), 'utf8');
    const expiredRun = await runCliInProcess([
      'task', 'new', 'expired', '--id', 'T-004', '--activation-input', 'expired.json',
      '--host-trust-store', trustStorePath, '--json', '--target', root,
    ], { operatorTrustRoot });
    assert.equal(expiredRun.status, 1);
    assert.match(JSON.parse(expiredRun.stdout).errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);

    writeFileSync(join(root, 'unsupported.json'), JSON.stringify(captureActivationInput({
      adapter: 'cursor.command.input.v1',
    })), 'utf8');
    const unsupported = await runCliInProcess([
      'task', 'new', 'unsupported', '--id', 'T-005', '--activation-input', 'unsupported.json',
      '--json', '--target', root,
    ]);
    assert.equal(unsupported.status, 1);
    assert.equal(JSON.parse(unsupported.stdout).diagnostics[0].code, 'activation.capture.unsupported');

    writeFileSync(trustStorePath, '{', 'utf8');
    const malformed = await runCliInProcess([
      'task', 'new', 'malformed store', '--id', 'T-006', '--activation-input', 'expired.json',
      '--host-trust-store', trustStorePath, '--json', '--target', root,
    ], { operatorTrustRoot });
    assert.equal(malformed.status, 1);
    const malformedResult = JSON.parse(malformed.stdout);
    assert.equal(malformedResult.evidenceState, 'malformed');
    assert.equal(malformedResult.disposition, 'rejected');
    assert.match(malformedResult.errors.join('\n'), /Host trust store is invalid/);
    for (const id of ['T-004', 'T-005', 'T-006']) {
      assert.equal(spawnSync('git', ['-C', root, 'status', '--short', `.agenticloop/tasks/${id}.md`], { encoding: 'utf8' }).stdout, '');
    }
  });
});

describe('public activation edges reject unpinned adapters identically', () => {
  it('rejects omitted activation capture before task creation with a canonical needs-context result', async () => {
    const root = mkdtempSync(join(temp, 'activation-omitted-'));
    createTaskProjectFixture(root);
    const run = await runCliInProcess(['task', 'new', 'must not exist', '--id', 'T-001', '--json', '--target', root]);
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.disposition, 'needs_context');
    assert.equal(result.diagnostics[0].code, 'activation.capture.missing');
    assert.match(result.diagnostics[0].repairHint, /--scaffold/);
    assert.match(result.diagnostics[0].repairHint, /supported host-produced activation capture/);
    assert.match(result.diagnostics[0].repairHint, /Never author capture JSON/);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' }).stdout.includes('T-001.md'), false);

    const human = await runCliInProcess(['task', 'new', 'human repair', '--id', 'T-002', '--target', root]);
    assert.equal(human.status, 1);
    const humanOutput = `${human.stdout}\n${human.stderr}`;
    assert.match(humanOutput, /--scaffold/);
    assert.match(humanOutput, /supported host-produced activation capture/);
    assert.match(humanOutput, /Never author capture JSON/);
    assert.equal(existsSync(join(root, '.agenticloop', 'tasks', 'T-002.md')), false);
  });

  it('rejects --scaffold with --activation-input before mutation', async () => {
    const root = mkdtempSync(join(temp, 'activation-combination-'));
    createTaskProjectFixture(root);
    writeFileSync(join(root, 'capture.json'), '{}\n', 'utf8');
    const run = await runCliInProcess([
      'task', 'new', 'invalid combination', '--id', 'T-001',
      '--scaffold', '--activation-input', 'capture.json', '--target', root,
    ]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /cannot be combined/);
    assert.equal(existsSync(join(root, '.agenticloop', 'tasks', 'T-001.md')), false);
  });

  it('rejects the same unpinned capture through public creation and public preparation', async () => {
    const root = mkdtempSync(join(temp, 'unpinned-capture-'));
    createTaskProjectFixture(root);
    const trust = createTestHostTrust();
    const capture = activation(trust);
    writeFileSync(join(root, 'capture.json'), JSON.stringify(capture), 'utf8');
    const created = await runCliInProcess([
      'task', 'new', 'unpinned', '--id', 'T-001', '--activation-input', 'capture.json', '--json', '--target', root,
    ]);
    assert.equal(created.status, 1);
    const createdResult = JSON.parse(created.stdout);
    assert.equal(createdResult.kind, 'agenticloop.validation-result');
    assert.match(createdResult.errors.join('\n'), /not in the resolved capability inventory/);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' }).stdout.includes('T-001.md'), false);

    // The identical capture must also fail the preparation edge, not only creation.
    writeFileSync(join(root, 'dispatch-input.json'), JSON.stringify({ activation: capture }), 'utf8');
    const prepared = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--host-trust-store', 'C:/operator/trust.json', '--json', '--target', root,
    ]);
    assert.equal(prepared.status, 1);
    assert.equal(JSON.parse(prepared.stdout).ok, false);
  });

  it('rejects an unpinned capture at packet validation even when its digest is recomputed', async () => {
    const fixture = await currentFilesTask('recomputed-digest');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    // Recomputing the digest makes the packet internally consistent; adapter
    // authority is still resolved from the production inventory and refuses it.
    const forged = structuredClone(prepared.packet);
    forged.digest = dispatchPreparationDigest(forged);
    assert.equal(validateDispatchPreparation(forged).ok, false);
    assert.match(validateDispatchPreparation(forged).errors.join('\n'), /capability inventory/);
    assert.equal(validateDispatchPreparation(forged, fixture.options).ok, true);
  });
});
