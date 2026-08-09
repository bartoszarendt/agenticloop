/**
 * Adversarial coverage for the P35-04 handoff boundary.
 *
 * Every suite here exists because a specific bypass was demonstrated: a public
 * validator that threw on malformed wire JSON, a dispatch that ignored
 * pre-existing repository state, a `base..head` range that survived a reset, a
 * receipt whose signing secret an agent could read, and a prose-matched
 * insertion point that silently produced an unmodified adapter artifact.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  activationCaptureDisposition,
  createDecompositionProvenance,
  createRoleReturn,
  prepareRoleDispatch,
  receiveRoleReturn,
  validateActivationCapture,
  validateDispatchPreparation,
  validateRoleReturn,
  verifyDispatchBeforeMutation,
} from '../src/dispatch-envelope.js';
import { evaluateParallelScan, normalizeFilesTaskInventory } from '../src/parallel-scan.js';
import {
  blockedAuthoritySignaturePayload,
  blockedResultRedelegationDigest,
  createBlockedResultRedelegation,
  createHumanDisposition,
} from '../src/blocked-result-authority.js';
import {
  createHostHandoffReceipt,
  hostHandoffReceiptSignaturePayload,
  HostReceiptStaleVersionError,
  verifyHostHandoffReceipt,
} from '../src/host-handoff.js';
import {
  generateHostSigningKey,
  HOST_TRUST_FILE,
  parseHostTrustStore,
  signHostPayload,
} from '../src/host-trust.js';
import { deriveCommitRange } from '../src/commit-range.js';
import {
  CLEAN_DISPATCH_STATE_IDENTITY,
  evaluateDispatchCleanState,
  evaluatePriorGateReceipts,
} from '../src/repository-state.js';
import { assertAdapterSlots, fillAdapterSlot } from '../src/adapter-slots.js';
import {
  VerificationContextError,
  VerificationContextUnsupportedBoundaryError,
} from '../src/public-error.js';
import { repairPolicyFor } from '../src/repair-policy.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { buildHostRoleCapabilityInventory } from '../src/host-role-capabilities.js';
import { resolveWorkflowRoleRegistry } from '../src/workflow-roles.js';
import {
  activation,
  createDispatchFixture,
  filesScanInventory,
  git,
  gitRunner,
  gitTreeBaseEvidence,
  prepare,
  producerBinding,
  readyReturn,
  repositoryEvidence,
} from './helpers/dispatch-fixture.js';
import { createTestHostTrust, protectedHostBoundary as signedHostBoundary, writeHostTrustStore } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;

const FUZZ_VALUES = Object.freeze([
  null, [], {}, '', 'text', 0, 1, -1, true, false, [1, 2], { unknown: true }, [[]], { nested: { deep: [] } },
]);

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-hardening-')); });
after(() => rmSync(temp, { recursive: true, force: true }));

describe('public envelope validators are total', () => {
  it('never throws for any JSON-compatible input', () => {
    for (const value of FUZZ_VALUES) {
      for (const validator of [validateRoleReturn, validateDispatchPreparation, validateActivationCapture]) {
        const result = validator(value);
        assert.equal(result.ok, false, `${validator.name} accepted ${JSON.stringify(value) ?? 'undefined'}`);
        assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
        assert.ok(Array.isArray(result.findings));
        for (const finding of result.findings) {
          assert.ok(typeof finding.code === 'string' && finding.code);
          assert.ok(typeof finding.evidenceState === 'string' && finding.evidenceState);
          assert.ok(typeof finding.disposition === 'string' && finding.disposition);
        }
      }
      assert.equal(activationCaptureDisposition(value).ok, false);
      assert.equal(prepareRoleDispatch(value).ok, false);
      assert.equal(verifyDispatchBeforeMutation(value).ok, false);
      assert.equal(receiveRoleReturn(value).ok, false);
    }
    // `undefined` reaches the same paths through the default parameter.
    assert.equal(validateRoleReturn().ok, false);
    assert.equal(validateDispatchPreparation().ok, false);
    assert.equal(validateActivationCapture().ok, false);
    assert.equal(prepareRoleDispatch().ok, false);
    assert.equal(receiveRoleReturn().ok, false);
    assert.equal(verifyDispatchBeforeMutation().ok, false);
  });

  it('rejects an empty object without a derived-comparison crash', () => {
    for (const validator of [validateRoleReturn, validateDispatchPreparation, validateActivationCapture]) {
      const result = validator({});
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /is missing field\(s\)/);
    }
  });

  it('rejects each required field deleted, retyped, or joined by an unknown field', async () => {
    const fixture = await createDispatchFixture(temp, 'totality');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const valid = readyReturn(prepared.packet);
    assert.equal(validateRoleReturn(valid).ok, true);
    const packet = structuredClone(prepared.packet);

    const cases = [];
    for (const key of Object.keys(valid)) {
      const deleted = structuredClone(valid);
      delete deleted[key];
      cases.push([`role return without ${key}`, validateRoleReturn, deleted]);
      for (const replacement of [null, 'text', 7, [], {}, true]) {
        const retyped = structuredClone(valid);
        retyped[key] = replacement;
        // `blocker: null` is the valid ready-return representation, so assigning
        // the already-valid value is not a malformed-wire probe.
        if (!(key === 'blocker' && replacement === null)) {
          cases.push([`role return ${key}=${JSON.stringify(replacement)}`, validateRoleReturn, retyped]);
        }
      }
    }
    for (const key of Object.keys(packet)) {
      const deleted = structuredClone(packet);
      delete deleted[key];
      cases.push([`packet without ${key}`, value => validateDispatchPreparation(value, fixture.options), deleted]);
      for (const replacement of [null, 'text', 7, [], {}, true]) {
        const retyped = structuredClone(packet);
        retyped[key] = replacement;
        // A legacy-capture packet carries `activationBinding: null` already, so
        // assigning the already-valid value is not a malformed-wire probe.
        if (key === 'activationBinding' && replacement === null) continue;
        cases.push([`packet ${key}=${JSON.stringify(replacement)}`, value => validateDispatchPreparation(value, fixture.options), retyped]);
      }
    }
    cases.push(['role return with unknown field', validateRoleReturn, { ...structuredClone(valid), invented: true }]);
    cases.push(['packet with unknown field', value => validateDispatchPreparation(value, fixture.options), { ...structuredClone(packet), invented: true }]);

    for (const [label, validator, value] of cases) {
      let result;
      assert.doesNotThrow(() => { result = validator(value); }, `${label} threw`);
      assert.equal(result.ok, false, `${label} was accepted`);
      assert.ok(result.errors.length > 0, `${label} produced no errors`);
    }
  });

  it('keeps packet-bound producer routing on every malformed role-return path', async () => {
    const fixture = await createDispatchFixture(temp, 'producer-routing');
    const prepared = prepare(fixture);
    const packet = prepared.packet;
    const wires = [
      '{}',
      'null',
      '[]',
      '"text"',
      '17',
      '{',
      JSON.stringify({ kind: 'agenticloop.role-return' }),
      JSON.stringify({ ...structuredClone(readyReturn(packet)), digest: 'sha256:agenticloop.role-return.v1:0000' }),
    ];
    for (const raw of wires) {
      let received;
      assert.doesNotThrow(() => {
        received = receiveRoleReturn({ raw, packet }, fixture.options);
      }, `wire ${raw} threw`);
      assert.equal(received.ok, false);
      assert.equal(received.validation.producerRole, 'engineer', `wire ${raw} lost producer routing`);
      assert.equal(received.validation.kind, 'agenticloop.validation-result');
    }
    // A refetch provider that throws unexpectedly must also keep the route.
    const boom = receiveRoleReturn({
      raw: JSON.stringify(readyReturn(packet)),
      packet,
      refetchTask: () => { throw new Error('unexpected internal fault'); },
      refetchRepositoryEvidence: () => ({}),
      resolveTrustedAdapter: () => fixture.trust.adapter,
    }, fixture.options);
    assert.equal(boom.ok, false);
    assert.equal(boom.validation.producerRole, 'engineer');
  });

  it('preserves a primary cause plus independent public diagnostics', async () => {
    const fixture = await createDispatchFixture(temp, 'multi-diagnostic');
    const prepared = prepare(fixture);
    const malformed = structuredClone(readyReturn(prepared.packet));
    malformed.producerRole = 'orchestrator';
    malformed.changedPaths = ['../outside'];
    malformed.checks[0].exitCode = 9;
    const received = receiveRoleReturn({
      raw: JSON.stringify(malformed),
      packet: prepared.packet,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.ok(received.validation.diagnostics.length >= 3);
    assert.equal(received.validation.errors.length, received.validation.diagnostics.length);
    assert.deepEqual(
      received.validation.errors,
      received.validation.diagnostics.map(item => item.message)
    );
    assert.equal(received.validation.diagnostics[0].evidence.state, 'malformed');
    assert.equal(received.validation.producerRole, 'engineer');
    assert.equal(
      new Set(received.validation.diagnostics.map(item => `${item.code}\0${item.message}`)).size,
      received.validation.diagnostics.length
    );
  });
});

describe('initial repository state binds the dispatch', () => {
  it('binds a clean checkout to the canonical clean-state identity', async () => {
    const fixture = await createDispatchFixture(temp, 'clean-state');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.repository.cleanState.identity, CLEAN_DISPATCH_STATE_IDENTITY);
    assert.deepEqual(prepared.packet.repository.cleanState.priorGates, []);
    assert.equal(prepared.packet.repository.cleanState.ignoredFilesPermitted, true);
    const evaluated = evaluateDispatchCleanState({ runGit: fixture.runGit, scopePatterns: ['src/**'] });
    assert.equal(evaluated.ok, true, JSON.stringify(evaluated.findings));
    assert.equal(evaluated.identity, CLEAN_DISPATCH_STATE_IDENTITY);
  });

  it('blocks staged, unstaged, untracked in-scope, and shared-state changes', async () => {
    const cases = [
      ['staged', fixture => {
        writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "staged";\n', 'utf8');
        git(fixture.root, ['add', 'src/existing.js']);
      }],
      ['unstaged', fixture => {
        writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "unstaged";\n', 'utf8');
      }],
      ['untracked in scope', fixture => {
        writeFileSync(join(fixture.root, 'src', 'sneaked.js'), 'export const sneaked = true;\n', 'utf8');
      }],
      ['changed shared workflow state', fixture => {
        writeFileSync(join(fixture.root, '.agenticloop', 'left-behind.json'), '{"unowned":true}\n', 'utf8');
      }],
    ];
    for (const [label, dirty] of cases) {
      const fixture = await createDispatchFixture(temp, `dirty-${label.replace(/\s+/g, '-')}`);
      dirty(fixture);
      const prepared = prepare(fixture);
      assert.equal(prepared.ok, false, `${label} was accepted`);
      assert.equal(prepared.validation.evidenceState, 'negative', label);
      assert.equal(prepared.validation.diagnostics[0].code, 'worktree.clean_gate.failed', label);
      assert.match(prepared.validation.errors.join('\n'), /clean checkout/, label);
    }
  });

  it('permits bounded scratch and ignored state without weakening the gate', async () => {
    const fixture = await createDispatchFixture(temp, 'permitted-state');
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'scratch.txt'), 'bounded scratch\n', 'utf8');
    writeFileSync(join(fixture.root, '.gitignore'), 'ignored.log\n', 'utf8');
    git(fixture.root, ['add', '.gitignore']);
    git(fixture.root, ['commit', '-m', 'ignore log noise\n\nTask: T-001\nAgent: maintainer']);
    writeFileSync(join(fixture.root, 'ignored.log'), 'noise\n', 'utf8');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.repository.cleanState.identity, CLEAN_DISPATCH_STATE_IDENTITY);
  });

  it('blocks dispatch when a pre-existing ignored file sits inside task scope', async () => {
    const fixture = await createDispatchFixture(temp, 'ignored-in-scope');
    writeFileSync(join(fixture.root, '.gitignore'), 'src/sneaked.js\n', 'utf8');
    git(fixture.root, ['add', '.gitignore']);
    git(fixture.root, ['commit', '-m', 'ignore sneaked\n\nTask: T-001\nAgent: maintainer']);
    writeFileSync(join(fixture.root, 'src', 'sneaked.js'), 'export const sneaked = true;\n', 'utf8');
    const evaluated = evaluateDispatchCleanState({
      runGit: fixture.runGit, scopePatterns: ['src/**'], intendedCreations: ['src/new.js'],
    });
    assert.equal(evaluated.ok, false);
    assert.deepEqual(evaluated.state.ignoredRelevantPaths, ['src/sneaked.js']);
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, false, 'a pre-existing ignored in-scope file must block dispatch');
    assert.equal(prepared.validation.evidenceState, 'negative');
    assert.equal(prepared.validation.diagnostics[0].code, 'worktree.clean_gate.failed');
    assert.match(prepared.validation.errors.join('\n'), /ignored task-scope/);
    // The same file cannot be force-added and returned as role work: with no
    // packet emitted there is no valid return to verify.
  });

  it('blocks dispatch when an ignored file shadows an intended creation or shared state', async () => {
    const fixture = await createDispatchFixture(temp, 'ignored-creation');
    writeFileSync(join(fixture.root, '.gitignore'), 'src/new.js\n.agenticloop/owned.json\n', 'utf8');
    git(fixture.root, ['add', '.gitignore']);
    git(fixture.root, ['commit', '-m', 'ignore creation\n\nTask: T-001\nAgent: maintainer']);
    writeFileSync(join(fixture.root, 'src', 'new.js'), 'export const preexisting = true;\n', 'utf8');
    writeFileSync(join(fixture.root, '.agenticloop', 'owned.json'), '{"preexisting":true}\n', 'utf8');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, false, 'ignored intended-creation and shared-state paths must block dispatch');
    assert.match(prepared.validation.errors.join('\n'), /ignored task-scope/);
  });

  it('does not scan or fail unrelated ignored host-local caches', async () => {
    const fixture = await createDispatchFixture(temp, 'ignored-caches');
    writeFileSync(join(fixture.root, '.gitignore'), 'node_modules/\nvendor-cache/\n', 'utf8');
    git(fixture.root, ['add', '.gitignore']);
    git(fixture.root, ['commit', '-m', 'ignore caches\n\nTask: T-001\nAgent: maintainer']);
    mkdirSync(join(fixture.root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(fixture.root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n', 'utf8');
    mkdirSync(join(fixture.root, 'vendor-cache'), { recursive: true });
    writeFileSync(join(fixture.root, 'vendor-cache', 'blob.bin'), 'cache\n', 'utf8');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.repository.cleanState.identity, CLEAN_DISPATCH_STATE_IDENTITY);
  });

  it('refuses scratch-prefixed changed paths as returned implementation work', async () => {
    const fixture = await createDispatchFixture(temp, 'scratch-return');
    const prepared = prepare(fixture);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fixture.root, '.agenticloop', 'tmp', 'report.txt'), 'scratch\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['add', '-f', '.agenticloop/tmp/report.txt']);
    git(fixture.root, ['commit', '-m', 'implement\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, {
      head: returnHead,
      changedPaths: ['.agenticloop/tmp/report.txt', 'src/existing.js'],
    });
    evidence.attribution = {
      range: { base: prepared.packet.repository.head, head: returnHead },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${returnHead}`])
        .split(/\r?\n/)
        .filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(received.validation.producerRole, 'engineer');
    assert.match(received.validation.errors.join('\n'), /scratch state/);
  });

  it('revalidates the initial state immediately before receiver mutation', async () => {
    const fixture = await createDispatchFixture(temp, 'receive-state');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "dirtied";\n', 'utf8');
    const received = verifyDispatchBeforeMutation({
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchReadiness: fixture.refetchReadiness,
      refetchRepository: fixture.refetchRepository,
      refetchDecomposition: fixture.refetchDecomposition,
      refetchParallelScanInventory: fixture.refetchParallelScanInventory,
      runGit: fixture.runGit,
      roleId: 'engineer',
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.match(received.validation.errors.join('\n'), /clean checkout/);
  });

  it('accepts a resolved prior-gate receipt and blocks unresolved or drifted ones', async () => {
    const fixture = await createDispatchFixture(temp, 'prior-gates');
    const created = await runCliInProcess([
      'task', 'new', 'prior gate setup', '--id', 'T-002', '--scaffold', '--json', '--target', fixture.root,
    ]);
    assert.equal(created.status, 0, created.stderr);
    const receipt = JSON.parse(created.stdout).receipt;
    assert.equal(receipt.mutationDisposition, 'committed');
    git(fixture.root, ['add', '.agenticloop/tasks/T-002.md']);
    git(fixture.root, ['commit', '-m', 'record prior gate\n\nTask: T-002\nAgent: maintainer']);

    const taskEntries = ['T-001', 'T-002'].map(taskId => ({
      carrier: `.agenticloop/tasks/${taskId}.md`,
      content: readFileSync(join(fixture.root, '.agenticloop', 'tasks', `${taskId}.md`), 'utf8'),
      readError: null,
    }));
    const observedAt = new Date().toISOString();
    const currentInventory = filesScanInventory('files:.agenticloop/tasks', taskEntries, observedAt);
    // The scan must bind the same base the dispatch boundary refetches; a
    // different tree is exactly the staleness this binding now reports.
    const base = gitTreeBaseEvidence(
      fixture.root,
      fixture.readiness.evidence.base.identity.slice('git-tree:'.length),
    );
    const scanned = evaluateParallelScan({
      workUnit: { id: fixture.decomposition.scan.workUnit.id, backend: 'files' },
      inventory: currentInventory,
      decomposition: {
        source: 'task-decomposition',
        sourceRef: fixture.decomposition.sourceRef,
        revision: `git-commit:${git(fixture.root, ['rev-parse', 'HEAD'])}`,
        declaredCompleteness: 'complete',
        attribution: 'maintainer',
      },
      observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths: base.paths,
      dependencies: {},
      readinessContext: { base: base.evidence, dependencies: fixture.readiness.evidence.dependencies },
      rescanTrigger: fixture.decomposition.scan.rescanTrigger,
    });
    assert.equal(scanned.scan.inventory.complete, true, scanned.result.errors.join('\n'));
    const currentDecomposition = createDecompositionProvenance({
      taskId: 'T-001',
      scan: scanned.scan,
      route: 'serial',
      sourceRef: fixture.decomposition.sourceRef,
    });

    const resolved = prepare(fixture, {
      refetchDecomposition: () => currentDecomposition,
      refetchParallelScanInventory: () => currentInventory,
      priorGateReceipts: [receipt], readCarrierDigest: relPath => {
      const digestPath = join(fixture.root, relPath);
      return `sha256:${sha256Hex(readFileSync(digestPath, 'utf8'))}`;
      },
    });
    assert.equal(resolved.ok, true, resolved.validation.errors?.join('\n'));
    assert.deepEqual(resolved.packet.repository.cleanState.priorGates, [{
      taskId: 'T-002',
      carrier: '.agenticloop/tasks/T-002.md',
      mutationDisposition: 'committed',
      resultingDigest: receipt.resultingDigest,
    }]);

    const unresolved = evaluatePriorGateReceipts({
      receipts: [{
        ...receipt,
        mutationDisposition: 'unresolved',
        unresolved: true,
        recovery: 'Inspect the prior carrier and record its observed final state before dispatch.',
      }],
      readCarrierDigest: () => receipt.resultingDigest,
    });
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.findings[0].code, 'task.mutation.unresolved');
    assert.equal(unresolved.findings[0].disposition, 'blocked');

    const absentReader = evaluatePriorGateReceipts({ receipts: [receipt] });
    assert.equal(absentReader.ok, false);
    assert.equal(absentReader.findings[0].evidenceState, 'missing');
    assert.equal(absentReader.findings[0].disposition, 'needs_context');

    const unreadable = evaluatePriorGateReceipts({
      receipts: [receipt], readCarrierDigest: () => { throw new Error('permission denied'); },
    });
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.findings[0].evidenceState, 'missing');
    assert.equal(unreadable.findings[0].disposition, 'needs_context');

    const deleted = evaluatePriorGateReceipts({ receipts: [receipt], readCarrierDigest: () => null });
    assert.equal(deleted.ok, false);
    assert.equal(deleted.findings[0].evidenceState, 'missing');
    assert.equal(deleted.findings[0].disposition, 'needs_context');

    const drifted = evaluatePriorGateReceipts({
      receipts: [receipt],
      readCarrierDigest: () => `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.findings[0].evidenceState, 'changed');
    assert.equal(drifted.findings[0].disposition, 'superseded');

    const deletedDispatch = prepare(fixture, {
      priorGateReceipts: [receipt],
      readCarrierDigest: () => null,
    });
    assert.equal(deletedDispatch.ok, false);
    assert.match(deletedDispatch.validation.errors.join('\n'), /prior-gate carrier.*no longer readable/);

    const driftedDispatch = prepare(fixture, {
      priorGateReceipts: [receipt],
      readCarrierDigest: () => `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(driftedDispatch.ok, false);
    assert.match(driftedDispatch.validation.errors.join('\n'), /prior-gate receipt.*proved/);

    const malformed = evaluatePriorGateReceipts({ receipts: [{ kind: 'nope' }] });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.findings[0].evidenceState, 'malformed');
    assert.equal(evaluatePriorGateReceipts({ receipts: 'not-an-array' }).ok, false);
  });

  it('keeps the public CLI fail-closed when no protected host boundary is supplied', async () => {
    const fixture = await createDispatchFixture(temp, 'prior-gate-cli');
    const created = await runCliInProcess([
      'task', 'new', 'prior gate carrier', '--id', 'T-002', '--scaffold', '--json', '--target', fixture.root,
    ]);
    assert.equal(created.status, 0, created.stderr);
    const receipt = JSON.parse(created.stdout).receipt;
    git(fixture.root, ['add', '.agenticloop/tasks/T-002.md']);
    git(fixture.root, ['commit', '-m', 'record prior gate carrier\n\nTask: T-002\nAgent: maintainer']);
    const receiptPath = join(temp, 'prior-gate-cli-receipt.json');
    const inputPath = join(fixture.root, 'dispatch-input.json');
    writeFileSync(receiptPath, JSON.stringify([receipt]), 'utf8');
    writeFileSync(inputPath, JSON.stringify({
      readiness: fixture.readiness,
      decomposition: { sourceRef: fixture.decomposition.sourceRef },
      assignment: fixture.assignment,
    }), 'utf8');
    const command = () => runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json',
      '--prior-receipts', receiptPath, '--host-trust-store', fixture.trustStorePath,
      '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });

    const result = await command();
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.evidenceState, 'negative');
    assert.equal(envelope.disposition, 'blocked');
    assert.match(envelope.errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
  });
});

describe('return ancestry is proven, not assumed', () => {
  function scratchRepo(name) {
    const root = mkdtempSync(join(temp, `${name}-`));
    for (const args of [['init'], ['config', 'user.name', 'Agentic Loop Test'], ['config', 'user.email', 'loop@example.test']]) {
      git(root, args);
    }
    return root;
  }

  function commit(root, path, content, message) {
    writeFileSync(join(root, path), content, 'utf8');
    git(root, ['add', path]);
    git(root, ['commit', '-m', message]);
    return git(root, ['rev-parse', 'HEAD']);
  }

  const trailer = suffix => `${suffix}\n\nTask: T-001\nAgent: engineer`;
  const range = (root, baseHead, head, options = {}) => deriveCommitRange({
    runGit: gitRunner(root), baseHead, head, taskId: 'T-001', roleId: 'engineer', ...options,
  });

  it('derives a normal descendant and a multi-commit range', () => {
    const root = scratchRepo('ancestry-descendant');
    const base = commit(root, 'a.txt', 'a\n', trailer('base'));
    const first = commit(root, 'b.txt', 'b\n', trailer('first'));
    const second = commit(root, 'c.txt', 'c\n', trailer('second'));
    const single = range(root, base, first);
    assert.equal(single.ok, true, single.message);
    assert.deepEqual(single.commits, [first]);
    assert.deepEqual(single.changedPaths, ['b.txt']);
    const multiple = range(root, base, second);
    assert.equal(multiple.ok, true, multiple.message);
    assert.deepEqual(multiple.commits, [first, second]);
    assert.deepEqual(multiple.changedPaths, ['b.txt', 'c.txt']);
  });

  it('derives a merge commit range when every commit carries canonical trailers', () => {
    const root = scratchRepo('ancestry-merge');
    const base = commit(root, 'a.txt', 'a\n', trailer('base'));
    git(root, ['checkout', '-b', 'side']);
    commit(root, 'side.txt', 'side\n', trailer('side work'));
    git(root, ['checkout', '-']);
    commit(root, 'main.txt', 'main\n', trailer('main work'));
    git(root, ['merge', '--no-ff', 'side', '-m', trailer('merge side')]);
    const head = git(root, ['rev-parse', 'HEAD']);
    const derived = range(root, base, head);
    assert.equal(derived.ok, true, derived.message);
    assert.equal(derived.commits.length, 3);
    assert.ok(derived.changedPaths.includes('side.txt'));
    assert.ok(derived.changedPaths.includes('main.txt'));
  });

  it('rejects a head reset behind its dispatched base', () => {
    const root = scratchRepo('ancestry-reset');
    const base = commit(root, 'a.txt', 'a\n', trailer('base'));
    const ahead = commit(root, 'b.txt', 'b\n', trailer('ahead'));
    git(root, ['reset', '--hard', base]);
    const derived = range(root, ahead, base);
    assert.equal(derived.ok, false);
    assert.equal(derived.evidenceState, 'changed');
    assert.equal(derived.disposition, 'superseded');
    assert.match(derived.message, /is not an ancestor/);
  });

  it('rejects a divergent replacement commit', () => {
    const root = scratchRepo('ancestry-divergent');
    commit(root, 'a.txt', 'a\n', trailer('base'));
    const original = commit(root, 'b.txt', 'b\n', trailer('original'));
    git(root, ['reset', '--hard', 'HEAD~1']);
    const replacement = commit(root, 'b.txt', 'different\n', trailer('replacement'));
    const derived = range(root, original, replacement);
    assert.equal(derived.ok, false);
    assert.equal(derived.evidenceState, 'changed');
  });

  it('rejects unrelated history', () => {
    const root = scratchRepo('ancestry-unrelated');
    const base = commit(root, 'a.txt', 'a\n', trailer('base'));
    git(root, ['checkout', '--orphan', 'other']);
    git(root, ['rm', '-rf', '--cached', '.']);
    const orphan = commit(root, 'z.txt', 'z\n', trailer('orphan'));
    const derived = range(root, base, orphan);
    assert.equal(derived.ok, false);
    assert.equal(derived.evidenceState, 'changed');
  });

  it('rejects abbreviated and missing commit identities', () => {
    const root = scratchRepo('ancestry-identity');
    const base = commit(root, 'a.txt', 'a\n', trailer('base'));
    const head = commit(root, 'b.txt', 'b\n', trailer('head'));
    const abbreviated = range(root, base.slice(0, 7), head);
    assert.equal(abbreviated.ok, false);
    assert.equal(abbreviated.evidenceState, 'malformed');
    const absent = range(root, '0'.repeat(40), head);
    assert.equal(absent.ok, false);
    assert.equal(absent.evidenceState, 'stale');
    assert.equal(absent.disposition, 'superseded');
  });

  it('rejects an invalid trailer in any commit of the range', () => {
    const root = scratchRepo('ancestry-trailer');
    const base = commit(root, 'a.txt', 'a\n', trailer('base'));
    commit(root, 'b.txt', 'b\n', trailer('good'));
    const head = commit(root, 'c.txt', 'c\n', 'untrailed work');
    const derived = range(root, base, head);
    assert.equal(derived.ok, false);
    assert.equal(derived.evidenceState, 'malformed');
    assert.match(derived.message, /canonical Task:\/Agent: trailers/);
    // Attribution can be skipped explicitly when a caller only needs identities.
    assert.equal(range(root, base, head, { requireAttribution: false }).ok, true);
  });

  it('rejects a returned range whose ancestry no longer holds', async () => {
    const fixture = await createDispatchFixture(temp, 'return-ancestry');
    const prepared = prepare(fixture);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, { head: returnHead });
    evidence.attribution = { range: { base: prepared.packet.repository.head, head: returnHead }, commits: [returnHead] };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const accepted = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(accepted.ok, true, accepted.validation.errors?.join('\n'));

    // Rewrite history so the dispatched base is no longer an ancestor.
    git(fixture.root, ['reset', '--hard', 'HEAD~1']);
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "rewritten";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'rewrite\n\nTask: T-001\nAgent: engineer']);
    const rewritten = receiveRoleReturn({
      raw: JSON.stringify(roleReturn), packet: prepared.packet, refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      ...producerBinding(fixture.trust, prepared.packet, roleReturn, evidence),
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(rewritten.ok, false);
  });
});

describe('host receipt trust boundary', () => {
  async function signed(name) {
    const fixture = await createDispatchFixture(temp, name);
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const evidence = repositoryEvidence(prepared.packet);
    const roleReturn = readyReturn(prepared.packet, evidence);
    const receipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    return { fixture, packet: prepared.packet, evidence, roleReturn, receipt };
  }

  const verify = (receipt, context) => verifyHostHandoffReceipt(receipt, context);

  it('accepts only a receipt signed by the pinned key for the exact artifacts', async () => {
    const { fixture, packet, evidence, roleReturn, receipt } = await signed('receipt-positive');
    assert.equal(receipt.authentication.algorithm, 'ed25519');
    assert.ok(receipt.authentication.value.startsWith('ed25519:'));
    assert.equal(receipt.packetLiveness.expiry, packet.assignment.liveness.expiry);
    assert.equal(
      verify(receipt, { trustedAdapter: fixture.trust.adapter, packet, roleReturn, repositoryEvidence: evidence }),
      receipt
    );
    // The receipt carries no private key material anywhere in its bytes.
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE KEY/);
  });

  it('rejects an Orchestrator-observed artifact presented as an Engineer return even with correct trailers', async () => {
    const { fixture, packet, evidence, roleReturn } = await signed('receipt-producer-mismatch');
    assert.equal(roleReturn.producerRole, 'engineer');
    assert.equal(roleReturn.attribution.commits.length > 0, true);
    const mismatched = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet,
      roleReturn,
      observedProducerRole: 'orchestrator',
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    assert.throws(
      () => verify(mismatched, {
        trustedAdapter: fixture.trust.adapter,
        packet,
        roleReturn,
        repositoryEvidence: evidence,
      }),
      /host-observed producer role/
    );
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: mismatched,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(received.validation.diagnostics[0].code, 'role_return.producer_mismatch');
  });

  it('authenticates a producer-role claim before assigning semantic mismatch authority', async () => {
    const { fixture, packet, evidence, roleReturn, receipt } = await signed('receipt-forged-producer');
    const forged = structuredClone(receipt);
    forged.producerRole = 'orchestrator';
    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: forged,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(received.validation.diagnostics[0].code, 'role_return.invalid');
    assert.match(received.validation.diagnostics[0].message, /authentication failed/);
    assert.doesNotMatch(received.validation.diagnostics[0].message, /producer role/i);
  });

  it('classifies only an authentic baseline schemaVersion 1 receipt as typed stale', async () => {
    const { fixture, packet, evidence, roleReturn, receipt } = await signed('receipt-v1-baseline');
    const legacy = structuredClone(receipt);
    legacy.schemaVersion = 1;
    legacy.authentication.value = signHostPayload(
      hostHandoffReceiptSignaturePayload(legacy),
      fixture.trust.privateKey
    );
    const context = {
      trustedAdapter: fixture.trust.adapter,
      packet,
      roleReturn,
      repositoryEvidence: evidence,
    };
    assert.throws(
      () => verify(legacy, context),
      error => error instanceof HostReceiptStaleVersionError &&
        error.code === 'role_return.receipt_stale' &&
        error.observedVersion === 1 &&
        error.requiredVersion === 2
    );

    const received = receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: legacy,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(
      received.validation.diagnostics[0].code,
      'role_return.receipt_stale',
      received.validation.diagnostics[0].message
    );
    assert.match(received.validation.diagnostics[0].message, /schemaVersion 1.*schemaVersion 2/);

    const malformed = structuredClone(legacy);
    malformed.unexpected = true;
    assert.throws(() => verify(malformed, context), error =>
      !(error instanceof HostReceiptStaleVersionError) &&
      /fields must equal the closed schema/.test(error.message)
    );
  });

  it('rejects wrong keys, wrong adapters, and untrusted capabilities', async () => {
    const { fixture, packet, evidence, roleReturn, receipt } = await signed('receipt-identity');
    const context = { packet, roleReturn, repositoryEvidence: evidence };
    const otherKey = createTestHostTrust({ adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId });
    assert.throws(() => verify(receipt, { ...context, trustedAdapter: otherKey.adapter }), /authentication failed|packet-bound operator trust identity/);
    const otherAdapter = createTestHostTrust({ adapterId: 'another.host.v1' });
    assert.throws(() => verify(receipt, { ...context, trustedAdapter: otherAdapter.adapter }), /not the pinned trusted adapter/);
    const renamedKey = { ...fixture.trust.adapter, keyId: 'rotated-key' };
    assert.throws(() => verify(receipt, { ...context, trustedAdapter: renamedKey }), /not the pinned trusted key/);
    const noReceiptCapability = {
      ...fixture.trust.adapter,
      capabilities: { activationCapture: 'supported', returnReceipt: 'unsupported' },
    };
    assert.throws(() => verify(receipt, { ...context, trustedAdapter: noReceiptCapability }), /not trusted to produce/);
    assert.throws(() => verify(receipt, { ...context }), /pinned trust-store adapter/);
  });

  it('rejects altered bindings, replays, malformed signatures, and out-of-window receipts', async () => {
    const { fixture, packet, evidence, roleReturn, receipt } = await signed('receipt-bindings');
    const trustedAdapter = fixture.trust.adapter;
    const base = { trustedAdapter, packet, roleReturn, repositoryEvidence: evidence };

    const alteredEvidence = structuredClone(evidence);
    alteredEvidence.changedPaths = ['src/other.js'];
    assert.throws(() => verify(receipt, { ...base, repositoryEvidence: alteredEvidence }), /does not bind the exact/);

    const alteredReturn = { ...roleReturn, returnId: 'return:00000000-0000-4000-8000-000000000000' };
    assert.throws(() => verify(receipt, { ...base, roleReturn: alteredReturn }), /does not bind the exact/);

    const alteredInvocation = structuredClone(packet);
    alteredInvocation.assignment.invocationId = 'invocation:00000000-0000-4000-8000-000000000000';
    assert.throws(() => verify(receipt, { ...base, packet: alteredInvocation }), /does not bind the exact/);

    // Replay: the same receipt against a second, distinct return.
    const replayTarget = readyReturn(packet, evidence);
    assert.notEqual(replayTarget.returnId, roleReturn.returnId);
    assert.throws(() => verify(receipt, { ...base, roleReturn: replayTarget }), /does not bind the exact/);

    for (const value of [null, '', 'not-a-signature', 'ed25519:', 'hmac-sha256:abcd', `sha256:${'a'.repeat(64)}`]) {
      const malformed = { ...receipt, authentication: { ...receipt.authentication, value } };
      assert.throws(() => verify(malformed, base), /authentication failed|key identity is not/);
    }

    const future = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId, packet, roleReturn,
      observedProducerRole: packet.assignment.roleId,
      repositoryEvidence: evidence, receivedAt: new Date(Date.now() + 600_000).toISOString(),
    }, fixture.trust.privateKey);
    assert.throws(() => verify(future, base), /future-dated/);

    // A receipt produced after the dispatch liveness window closed is rejected
    // even though its signature is valid.
    const expiredPacket = structuredClone(packet);
    expiredPacket.assignment.liveness.expiry = new Date(Date.now() - 60_000).toISOString();
    const expiredReceipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId, keyId: fixture.trust.keyId, packet: expiredPacket, roleReturn,
      observedProducerRole: expiredPacket.assignment.roleId,
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    assert.throws(
      () => verify(expiredReceipt, { ...base, packet: expiredPacket }),
      /liveness window closed/
    );

    for (const field of ['kind', 'schemaVersion', 'source']) {
      const broken = { ...receipt, [field]: 'invented' };
      assert.throws(() => verify(broken, base), /identity is invalid/);
    }
    assert.throws(() => verify({ ...receipt, invented: true }, base), /closed schema/);
  });

  it('reads pinned adapters only from a valid operator trust document', async () => {
    const fixture = await createDispatchFixture(temp, 'trust-store');
    const stored = parseHostTrustStore(readFileSync(fixture.trustStorePath, 'utf8'), { target: fixture.root });
    assert.equal(stored.ok, true, stored.errors.join('\n'));
    assert.equal(stored.adapters[fixture.trust.adapterId].keyId, fixture.trust.keyId);
    assert.equal(parseHostTrustStore('{').ok, false);
    assert.equal(parseHostTrustStore('{"kind":"nope","schemaVersion":1,"adapters":[]}').ok, false);
    assert.equal(parseHostTrustStore(JSON.stringify({
      kind: 'agenticloop.host-trust', schemaVersion: 1,
      target: { repositoryIdentity: fixture.trust.repositoryIdentity },
      adapters: [{ ...fixture.trust.adapter, publicKey: 'not-a-key' }],
    })).ok, false);
    assert.equal(parseHostTrustStore(JSON.stringify({
      kind: 'agenticloop.host-trust', schemaVersion: 1,
      target: { repositoryIdentity: fixture.trust.repositoryIdentity },
      adapters: [fixture.trust.adapter, fixture.trust.adapter],
    })).ok, false);
    assert.equal(parseHostTrustStore(null).ok, true);
  });

  it('does not let a committed repository-local adapter or key authorize capture or return', async () => {
    const fixture = await createDispatchFixture(temp, 'repository-forgery');
    const forged = createTestHostTrust({ adapterId: 'repository.attacker.v1', target: fixture.root });
    const localTrustPath = join(fixture.root, HOST_TRUST_FILE);
    mkdirSync(join(fixture.root, '.agenticloop'), { recursive: true });
    writeFileSync(localTrustPath, `${JSON.stringify(forged.document)}\n`, 'utf8');
    git(fixture.root, ['add', HOST_TRUST_FILE]);
    git(fixture.root, ['commit', '-m', 'forge local adapter\n\nTask: T-001\nAgent: engineer']);

    const forgedCapture = activation(forged);
    const captureDisposition = activationCaptureDisposition(forgedCapture, { capabilities: fixture.options.capabilities });
    assert.equal(captureDisposition.ok, false);
    assert.equal(captureDisposition.evidenceState, 'malformed');

    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const evidence = repositoryEvidence(prepared.packet);
    const roleReturn = readyReturn(prepared.packet, evidence);
    const forgedReceipt = createHostHandoffReceipt({
      adapterId: forged.adapterId,
      keyId: forged.keyId,
      packet: prepared.packet,
      roleReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, forged.privateKey);
    assert.throws(() => verifyHostHandoffReceipt(forgedReceipt, {
      trustedAdapter: fixture.trust.adapter,
      packet: prepared.packet,
      roleReturn,
      repositoryEvidence: evidence,
    }), /pinned trusted adapter|packet-bound operator trust identity/);
  });

  it('does not let the public CLI select an arbitrary attacker-created external store', async () => {
    const fixture = await createDispatchFixture(temp, 'external-store-forgery');
    const attackerRoot = mkdtempSync(join(temp, 'attacker-operator-root-'));
    const attacker = createTestHostTrust({ target: fixture.root, adapterId: 'attacker.parser.v1' });
    const attackerPath = writeHostTrustStore(attackerRoot, attacker);
    writeFileSync(
      join(fixture.root, 'dispatch-input.json'),
      JSON.stringify({ assignment: fixture.assignment }),
      'utf8'
    );

    const result = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001',
      '--input', 'dispatch-input.json',
      '--host-trust-store', attackerPath,
      '--json',
      '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot, hostAuthority: () => true });

    assert.equal(result.status, 1);
    assert.match(
      JSON.parse(result.stdout).errors.join('\n'),
      /does not match the pre-registered operator trust path/
    );
  });
});

describe('adapter insertion slots fail loudly', () => {
  const source = [
    '<!-- AGENTICLOOP_ADAPTER_SLOT:activation_capability -->',
    '<!-- /AGENTICLOOP_ADAPTER_SLOT:activation_capability -->',
    '',
    'body',
    '',
    '<!-- AGENTICLOOP_ADAPTER_SLOT:requested_input -->',
    'Requested task or context: `$ARGUMENTS`',
    '<!-- /AGENTICLOOP_ADAPTER_SLOT:requested_input -->',
  ].join('\n');

  it('fills a declared slot and preserves its markers', () => {
    assert.equal(assertAdapterSlots(source), true);
    const filled = fillAdapterSlot(source, 'requested_input', 'advisory only');
    assert.match(filled, /<!-- AGENTICLOOP_ADAPTER_SLOT:requested_input -->\nadvisory only\n<!-- \/AGENTICLOOP_ADAPTER_SLOT:requested_input -->/);
    assert.doesNotMatch(filled, /\$ARGUMENTS/);
  });

  it('throws when a marker is absent, duplicated, or inverted', () => {
    assert.throws(() => assertAdapterSlots('no markers here'), /missing the 'activation_capability' adapter slot marker/);
    const duplicated = `${source}\n<!-- AGENTICLOOP_ADAPTER_SLOT:requested_input -->\n<!-- /AGENTICLOOP_ADAPTER_SLOT:requested_input -->`;
    assert.throws(() => assertAdapterSlots(duplicated), /duplicates the 'requested_input' adapter slot marker/);
    const inverted = [
      '<!-- /AGENTICLOOP_ADAPTER_SLOT:activation_capability -->',
      '<!-- AGENTICLOOP_ADAPTER_SLOT:activation_capability -->',
    ].join('\n');
    assert.throws(() => assertAdapterSlots(inverted), /closes the 'activation_capability' adapter slot before it opens/);
    assert.throws(() => fillAdapterSlot(source, 'invented_slot', ''), /unknown adapter slot/);
  });

  it('keeps every declared slot present in the canonical activation command', () => {
    const canonical = readFileSync(new URL('../commands/start.md', import.meta.url), 'utf8');
    assert.equal(assertAdapterSlots(canonical), true);
  });
});

describe('OpenCode activation transport corruption regression', () => {
  /**
   * The exact operator-authorized line and the exact corrupted line recorded by
   * the independent P35-00 rerun review. These bytes are the regression fixture:
   * the corruption joined a following bullet into the literal and dropped the
   * trailing exclamation mark, and no identity boundary noticed.
   *
   * This fixture reproduces the *detection*, not the OpenCode transport itself.
   * The host version was never captured and no live OpenCode run is in scope
   * here, so the transport root cause remains unreproduced. See
   * `.dev/P35-04-OPENCODE-TRANSPORT.md`.
   */
  const AUTHORIZED = 'hello("Ada") returns exactly Hello, Ada!';
  const RECEIVED = 'hello("Ada") returns exactly Hello, Adatest\\hello.test.js using node:test';

  it('pins the exact recorded bytes and their distinct digests', () => {
    assert.equal(AUTHORIZED.length, 40);
    assert.equal(sha256Hex(AUTHORIZED).length, 64);
    assert.notEqual(sha256Hex(AUTHORIZED), sha256Hex(RECEIVED));
    // Punctuation loss and line joining are the exact recorded differences.
    assert.ok(AUTHORIZED.endsWith('!'));
    assert.ok(!RECEIVED.includes('!'));
    assert.ok(RECEIVED.includes('Adatest\\hello.test.js'));
    assert.ok(!AUTHORIZED.includes('\n') && !RECEIVED.includes('\n'));
  });

  it('rejects the corrupted payload against the operator digest before task authoring', () => {
    const trust = createTestHostTrust();
    // The operator authorized AUTHORIZED; the transport delivered RECEIVED. A
    // host-signed capture over the delivered bytes must classify as changed and
    // be rejected before any task is created.
    const corrupted = activation(trust, RECEIVED, `sha256:${sha256Hex(AUTHORIZED)}`);
    assert.equal(corrupted.integrity, 'mismatch');
    assert.equal(corrupted.normalizedActivationDigest, `sha256:${sha256Hex(RECEIVED)}`);
    const disposition = activationCaptureDisposition(corrupted, { capabilities: trust.capabilities });
    assert.equal(disposition.ok, false);
    assert.equal(disposition.evidenceState, 'changed');
    assert.equal(disposition.disposition, 'rejected');
    // The same bytes, authorized honestly, verify.
    const honest = activation(trust, AUTHORIZED, `sha256:${sha256Hex(AUTHORIZED)}`);
    assert.equal(activationCaptureDisposition(honest, { capabilities: trust.capabilities }).ok, true);
  });
});

describe('role-return core boundary authenticates evidence itself', () => {
  async function committed(name) {
    const fixture = await createDispatchFixture(temp, name);
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "returned";\n', 'utf8');
    git(fixture.root, ['add', 'src/existing.js']);
    git(fixture.root, ['commit', '-m', 'implement\n\nTask: T-001\nAgent: engineer']);
    const returnHead = git(fixture.root, ['rev-parse', 'HEAD']);
    const evidence = repositoryEvidence(prepared.packet, { head: returnHead });
    evidence.attribution = {
      range: { base: prepared.packet.repository.head, head: returnHead },
      commits: git(fixture.root, ['rev-list', '--reverse', `${prepared.packet.repository.head}..${returnHead}`])
        .split(/\r?\n/)
        .filter(Boolean),
    };
    const roleReturn = readyReturn(prepared.packet, evidence);
    const receipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    const receive = (patch = {}, options = {}) => receiveRoleReturn({
      raw: JSON.stringify(roleReturn),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => evidence,
      producerReceipt: receipt,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      runGit: fixture.runGit,
      ...patch,
    }, { ...fixture.options, ...options });
    return { fixture, prepared, evidence, roleReturn, receipt, receive };
  }

  function blockedRoleReturn(packet, evidence) {
    return createRoleReturn({
      producerRole: 'engineer',
      packet: { packetId: packet.packetId, digest: packet.digest },
      task: { backend: packet.backend, id: packet.task.id, digest: packet.task.digest },
      worktree: evidence.worktree,
      branch: evidence.branch,
      head: evidence.head,
      baseHead: evidence.baseHead,
      changedPaths: evidence.changedPaths,
      checks: evidence.checks,
      attribution: evidence.attribution,
      pr: evidence.pr,
      outcome: {
        kind: 'implementation_blocked',
        completion: false,
        authority: 'non_authoritative_role_outcome',
      },
      disposition: 'blocked',
      blocker: {
        category: 'host_state',
        evidence: { kind: 'command_failure', detail: 'task worktree mount is read-only' },
        resumeOwner: 'engineer',
        resumeTransition: 'implementation_resume',
        resumePreconditions: {
          items: ['Restore the exact task worktree write mount.'],
          justification: null,
        },
      },
      freshness: {
        invalidatedBy: [
          'task_or_contract_changes',
          'packet_or_assignment_changes',
          'branch_or_head_changes',
          'check_or_transport_evidence_changes',
          'initial_repository_state_changes',
        ],
      },
    });
  }

  function authorityFixture(authorityId, authorityKind, keyId) {
    const key = generateHostSigningKey();
    return {
      trusted: {
        authorityId,
        authorityKind,
        keyId,
        algorithm: 'ed25519',
        publicKey: key.publicKeyBase64,
        issuer: authorityKind === 'blocked_result_redelegation'
          ? { ownerKind: 'workflow_role', ownerId: 'orchestrator' }
          : { ownerKind: 'human_authority', ownerId: 'human_authority' },
        revokedRecordIds: [],
      },
      signing: { authorityId, keyId, privateKey: key.privateKey },
    };
  }

  function installAuthorityTrust(fixture, authorities) {
    const document = {
      ...fixture.trust.document,
      schemaVersion: 2,
      authorities: authorities.map(authority => authority.trusted),
    };
    writeFileSync(fixture.trustStorePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    mkdirSync(join(fixture.root, 'agenticloop'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'agenticloop', 'config.json'),
      readFileSync(new URL('../config.json', import.meta.url)),
    );
    writeFileSync(
      join(fixture.root, 'agenticloop.json'),
      '{"extends":"./agenticloop/config.json"}\n',
      'utf8'
    );
  }

  function publicReturnFiles(fixture, prepared, evidence, roleReturn) {
    const write = (name, value) => {
      const path = join(fixture.root, name);
      writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
      return name;
    };
    const receipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, fixture.trust.privateKey);
    return {
      write,
      baseArgs: [
        'task', 'verify-return', 'T-001',
        '--packet', write('packet.json', prepared.packet),
        '--return', write('return.json', roleReturn),
        '--repository-evidence', write('evidence.json', evidence),
        '--producer-receipt', write('receipt.json', receipt),
        '--host-trust-store', fixture.trustStorePath,
        '--json',
        '--target', fixture.root,
      ],
    };
  }

  function protectedHostBoundary(fixture, calls) {
    return signedHostBoundary(fixture.trust, context => calls.push(context));
  }

  it('accepts the valid signed fixture through the explicitly trusted test seam', async () => {
    const { receive } = await committed('boundary-positive');
    const received = receive();
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
  });

  it('rejects a forged signature at the boundary', async () => {
    const { receipt, receive } = await committed('boundary-forged');
    const value = receipt.authentication.value;
    const forged = {
      ...receipt,
      authentication: { ...receipt.authentication, value: `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}` },
    };
    const received = receive({ producerReceipt: forged });
    assert.equal(received.ok, false);
    assert.equal(received.validation.evidenceState, 'negative');
    assert.equal(received.validation.disposition, 'rejected');
    assert.equal(received.validation.producerRole, 'engineer');
    assert.match(received.validation.errors.join('\n'), /authentication failed/);
  });

  it('rejects a structurally valid receipt signed by an unpinned key', async () => {
    const { fixture, prepared, evidence, roleReturn, receive } = await committed('boundary-unpinned');
    const attacker = createTestHostTrust({ target: fixture.root, adapterId: 'attacker.parser.v1' });
    const receipt = createHostHandoffReceipt({
      adapterId: attacker.adapterId,
      keyId: attacker.keyId,
      packet: prepared.packet,
      roleReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, attacker.privateKey);
    const received = receive({ producerReceipt: receipt });
    assert.equal(received.ok, false);
    assert.equal(received.validation.disposition, 'rejected');
    assert.match(received.validation.errors.join('\n'), /authentication failed/);
  });

  it('cannot be satisfied by a caller-authored producer evidence callback', async () => {
    const { receipt, receive } = await committed('boundary-callback');
    const received = receive(
      { producerReceipt: null, refetchProducerEvidence: () => receipt },
      { minimumReturnAssurance: 'host_receipt' }
    );
    assert.equal(received.ok, false);
    assert.equal(received.validation.evidenceState, 'missing');
    assert.equal(received.validation.disposition, 'blocked');
    assert.match(received.validation.errors.join('\n'), /raw host-adapter producer receipt is required/);
  });

  it('grades a receipt-less return session_reported and never claims an authenticated producer', async () => {
    const { receipt, receive } = await committed('boundary-session-reported');
    const received = receive({ producerReceipt: null, refetchProducerEvidence: () => receipt });
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
    assert.equal(received.returnAssurance, 'session_reported');
    assert.equal(received.producerAuthenticated, false);
    assert.equal(received.assurance.return, 'session_reported');
    assert.equal(received.assurance.activation, 'host_signed');
    assert.ok(received.validation.warningDiagnostics.some(item =>
      item.code === 'return.assurance.session_reported' && /NOT host-authenticated/.test(item.message)));
    assert.equal(
      received.validation.warningDiagnostics.some(item => /cryptographically host-authenticated/.test(item.message) &&
        !/Do not describe/.test(item.message)),
      false
    );
  });

  it('blocks a files-backend return when no Git reader can rederive the evidence', async () => {
    const { receive } = await committed('boundary-no-git');
    const received = receive({ runGit: null });
    assert.equal(received.ok, false);
    assert.equal(received.validation.evidenceState, 'missing');
    assert.equal(received.validation.disposition, 'blocked');
    assert.match(received.validation.errors.join('\n'), /Git reader is required/);
  });

  it('rejects a nonexistent returned commit identity', async () => {
    const { fixture, prepared, evidence, roleReturn } = await committed('boundary-ghost-commit');
    const ghost = `${'9'.repeat(40)}`;
    const ghostEvidence = { ...evidence, head: ghost, attribution: { range: { base: evidence.baseHead, head: ghost }, commits: [ghost] } };
    const ghostReturn = readyReturn(prepared.packet, ghostEvidence);
    const ghostReceipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn: ghostReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: ghostEvidence,
    }, fixture.trust.privateKey);
    const received = receiveRoleReturn({
      raw: JSON.stringify(ghostReturn),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => ghostEvidence,
      producerReceipt: ghostReceipt,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.equal(received.validation.producerRole, 'engineer');
    assert.match(received.validation.errors.join('\n'), /no longer the current repository head/);
  });

  it('rejects caller-authored changed paths that contradict rederived Git state', async () => {
    const { fixture, prepared, evidence } = await committed('boundary-authored-evidence');
    const authoredEvidence = { ...evidence, changedPaths: ['src/invented.js'] };
    const authoredReturn = readyReturn(prepared.packet, authoredEvidence);
    const authoredReceipt = createHostHandoffReceipt({
      adapterId: fixture.trust.adapterId,
      keyId: fixture.trust.keyId,
      packet: prepared.packet,
      roleReturn: authoredReturn,
      observedProducerRole: prepared.packet.assignment.roleId,
      repositoryEvidence: authoredEvidence,
    }, fixture.trust.privateKey);
    const received = receiveRoleReturn({
      raw: JSON.stringify(authoredReturn),
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchRepositoryEvidence: () => authoredEvidence,
      producerReceipt: authoredReceipt,
      resolveTrustedAdapter: () => fixture.trust.adapter,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(received.ok, false);
    assert.match(received.validation.errors.join('\n'), /changed paths do not equal the durable Git diff/);
  });

  it('rejects repository evidence the receipt did not sign', async () => {
    const { evidence, receive } = await committed('boundary-swapped-evidence');
    const swapped = { ...evidence, checks: evidence.checks.map(check => ({ ...check, evidence: 'tampered' })) };
    const received = receive({ refetchRepositoryEvidence: () => swapped });
    assert.equal(received.ok, false);
    assert.match(received.validation.errors.join('\n'), /does not bind|authentication failed/);
  });

  it('rejects a resolver that cannot pin the packet-selected adapter', async () => {
    const { receive } = await committed('boundary-no-adapter');
    const received = receive({ resolveTrustedAdapter: () => null });
    assert.equal(received.ok, false);
    assert.equal(received.validation.disposition, 'rejected');
    assert.match(received.validation.errors.join('\n'), /authentication failed/);
  });

  // A typed unsupported-boundary fault means the registry is well-formed and
  // nothing failed authentication: the boundary simply cannot prove the declared
  // capability in-process. Flattening it into `negative/rejected` would report an
  // authentication failure that never happened and hide the real limitation, so
  // its classification is preserved end to end.
  it('keeps a typed unsupported trust boundary negative/blocked, not rejected', async () => {
    const { receive } = await committed('boundary-unsupported-resolver');
    const received = receive({
      resolveTrustedAdapter: () => {
        throw new VerificationContextUnsupportedBoundaryError(
          'Host trust registry is well-formed but declares dynamic supported adapters: test'
        );
      },
    });
    assert.equal(received.ok, false);
    assert.equal(received.validation.evidenceState, 'negative');
    assert.equal(received.validation.disposition, 'blocked');
    assert.equal(received.validation.diagnostics[0].code, 'host.boundary.unsupported');
    assert.match(received.validation.errors.join('\n'), /boundary is unsupported/);
    assert.doesNotMatch(received.validation.errors.join('\n'), /authentication failed/);
  });

  it('preserves the typed classification on the error class itself', () => {
    const error = new VerificationContextUnsupportedBoundaryError();
    assert.equal(error.code, 'host.boundary.unsupported');
    assert.equal(error.evidenceState, 'negative');
    assert.equal(error.disposition, 'blocked');
    assert.equal(error.committedStateEvaluated, false);
    // The code must be catalogued, or the public presentation layer downgrades
    // it to a generic operational failure and the typed fact is lost.
    assert.doesNotThrow(() => repairPolicyFor('host.boundary.unsupported'));
  });

  it('does not let an untyped or self-graded fault assert its own classification', async () => {
    const { receive } = await committed('boundary-self-graded');

    // A plain resolver fault is a genuine authentication failure.
    const plain = receive({
      resolveTrustedAdapter: () => { throw new Error('key rotation failed'); },
    });
    assert.equal(plain.validation.evidenceState, 'negative');
    assert.equal(plain.validation.disposition, 'rejected');

    // A caller-supplied object claiming a passing state cannot talk its way in.
    const forgedGrade = receive({
      resolveTrustedAdapter: () => {
        const error = new Error('trust me');
        Object.assign(error, { code: 'totally.fine', evidenceState: 'current', disposition: 'proceed' });
        throw error;
      },
    });
    assert.equal(forgedGrade.ok, false);
    assert.equal(forgedGrade.validation.evidenceState, 'negative');
    assert.equal(forgedGrade.validation.disposition, 'rejected');
    assert.notEqual(forgedGrade.validation.diagnostics[0].code, 'totally.fine');

    // Copying an allow-listed code onto a plain Error does not make it a typed
    // public boundary fact.
    const forgedKnownCode = receive({
      resolveTrustedAdapter: () => {
        const error = new Error('pretend the boundary is unsupported');
        error.code = 'host.boundary.unsupported';
        throw error;
      },
    });
    assert.equal(forgedKnownCode.validation.evidenceState, 'negative');
    assert.equal(forgedKnownCode.validation.disposition, 'rejected');
    assert.notEqual(forgedKnownCode.validation.diagnostics[0].code, 'host.boundary.unsupported');

    // An unpinned adapter is an authentication failure, not missing context,
    // even though its typed error is a verification-context error.
    const unpinned = receive({
      resolveTrustedAdapter: () => {
        throw new VerificationContextError("packet-bound host adapter 'x' is not pinned");
      },
    });
    assert.equal(unpinned.validation.evidenceState, 'negative');
    assert.equal(unpinned.validation.disposition, 'rejected');

    // Likewise a self-graded repository-evidence refetch fault.
    const forgedEvidence = receive({
      refetchRepositoryEvidence: () => {
        const error = new Error('evidence unavailable');
        Object.assign(error, { code: 'made.up', evidenceState: 'current', disposition: 'proceed' });
        throw error;
      },
    });
    assert.equal(forgedEvidence.ok, false);
    assert.equal(forgedEvidence.validation.evidenceState, 'missing');
    assert.equal(forgedEvidence.validation.disposition, 'blocked');

    const forgedKnownEvidenceCode = receive({
      refetchRepositoryEvidence: () => {
        const error = new Error('pretend context is missing');
        error.code = 'verification.context.missing';
        throw error;
      },
    });
    assert.equal(forgedKnownEvidenceCode.validation.evidenceState, 'missing');
    assert.equal(forgedKnownEvidenceCode.validation.disposition, 'blocked');
    assert.notEqual(
      forgedKnownEvidenceCode.validation.diagnostics[0].code,
      'verification.context.missing'
    );
  });

  it('keeps a forged receipt signature rejected', async () => {
    const { receipt, receive } = await committed('boundary-forged-signature');
    const forged = { ...receipt, signature: Buffer.from('forged signature bytes').toString('base64') };
    const received = receive({ producerReceipt: forged });
    assert.equal(received.ok, false);
    assert.equal(received.validation.evidenceState, 'negative');
    assert.equal(received.validation.disposition, 'rejected');
    assert.notEqual(received.validation.diagnostics[0].code, 'host.boundary.unsupported');
  });

  it('presents an unsupported boundary as negative/blocked through public task verify-return', async () => {
    // The public path resolves trust from the fail-closed operator store. A
    // store that declares a dynamic `supported` adapter is well-formed but
    // unprovable in-process, which is the reachable unsupported-boundary case.
    const fixture = await createDispatchFixture(temp, 'public-unsupported-boundary');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const evidence = repositoryEvidence(prepared.packet);
    const roleReturn = readyReturn(prepared.packet, evidence);
    const write = (name, value) => {
      const path = join(fixture.root, name);
      writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
      return name;
    };
    const result = await runCliInProcess([
      'task', 'verify-return', 'T-001',
      '--packet', write('packet.json', prepared.packet),
      '--return', write('return.json', roleReturn),
      '--repository-evidence', write('evidence.json', evidence),
      '--producer-receipt', write('receipt.json', createHostHandoffReceipt({
        adapterId: fixture.trust.adapterId,
        keyId: fixture.trust.keyId,
        packet: prepared.packet,
        roleReturn,
        observedProducerRole: prepared.packet.assignment.roleId,
        repositoryEvidence: evidence,
      }, fixture.trust.privateKey)),
      '--host-trust-store', fixture.trustStorePath,
      '--json',
      '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(result.status, 1, result.stderr);
    const presented = JSON.parse(result.stdout);
    assert.equal(presented.ok, false);
    assert.equal(presented.evidenceState, 'negative');
    assert.equal(presented.disposition, 'blocked');
    assert.equal(presented.diagnostics[0].code, 'host.boundary.unsupported');
    assert.equal(presented.diagnostics[0].evidence.committedStateEvaluated, false);
  });

  it('authorizes a signed blocked-result owner transfer through the protected public CLI path', async () => {
    const { fixture, prepared, evidence } = await committed('public-redelegation-authority');
    const roleReturn = blockedRoleReturn(prepared.packet, evidence);
    const authority = authorityFixture(
      'agenticloop.test.orchestrator',
      'blocked_result_redelegation',
      'orchestrator-authority-1'
    );
    installAuthorityTrust(fixture, [authority]);
    buildHostRoleCapabilityInventory({
      adapterConfigs: loadAgenticLoopConfig(join(fixture.root, 'agenticloop.json')).adapters ?? {},
    });
    const issuedAt = new Date().toISOString();
    const redelegation = createBlockedResultRedelegation({
      blockedReturn: roleReturn,
      toRole: 'maintainer',
      authority: {
        ownerKind: 'workflow_role',
        ownerId: 'orchestrator',
        reference: 'dispatch:redelegate:T-001',
      },
      reason: 'Maintainer must repair the task contract before implementation resumes.',
      issuedAt,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, authority.signing);
    const carriers = publicReturnFiles(fixture, prepared, evidence, roleReturn);
    const calls = [];
    const result = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'maintainer',
      '--redelegation-authority', carriers.write('redelegation.json', redelegation),
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture, calls),
    });
    assert.equal(
      result.status,
      0,
      `${result.stderr || result.stdout}\nprotected calls: ${JSON.stringify(calls)}`
    );
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.ok(calls.length >= 2, 'adapter and blocked authority trust must both cross the protected seam');

    const forged = structuredClone(redelegation);
    forged.authentication.value = `${forged.authentication.value.slice(0, -2)}AA`;
    const denied = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'maintainer',
      '--redelegation-authority', carriers.write('redelegation-forged.json', forged),
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture, []),
    });
    assert.equal(denied.status, 1);
    assert.equal(
      JSON.parse(denied.stdout).diagnostics[0].code,
      'blocked_result.redelegation_untrusted'
    );
  });

  it('behaviorally validates blocked authority flag combinations, owners, expiry, and human selectors', async () => {
    const { fixture, prepared, evidence } = await committed('public-authority-flags');
    const roleReturn = blockedRoleReturn(prepared.packet, evidence);
    const redelegationAuthority = authorityFixture(
      'agenticloop.test.orchestrator',
      'blocked_result_redelegation',
      'orchestrator-authority-1'
    );
    const humanAuthority = authorityFixture(
      'agenticloop.test.human',
      'human_disposition',
      'human-authority-1'
    );
    installAuthorityTrust(fixture, [redelegationAuthority, humanAuthority]);
    const carriers = publicReturnFiles(fixture, prepared, evidence, roleReturn);
    const protectedOptions = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture, []),
    };
    const currentRedelegation = createBlockedResultRedelegation({
      blockedReturn: roleReturn,
      toRole: 'maintainer',
      authority: {
        ownerKind: 'workflow_role',
        ownerId: 'orchestrator',
        reference: 'dispatch:expired:T-001',
      },
      reason: 'Captured record that will be aged for the stale-path fixture.',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }, redelegationAuthority.signing);
    const expired = structuredClone(currentRedelegation);
    expired.issuedAt = '2020-01-01T00:00:00.000Z';
    expired.expiresAt = '2020-01-01T01:00:00.000Z';
    expired.digest = blockedResultRedelegationDigest(expired);
    expired.authentication.value = signHostPayload(
      blockedAuthoritySignaturePayload(expired),
      redelegationAuthority.signing.privateKey
    );

    const missingAuthority = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'maintainer',
    ], protectedOptions);
    assert.equal(missingAuthority.status, 1);
    assert.equal(
      JSON.parse(missingAuthority.stdout).diagnostics[0].code,
      'blocked_result.redelegation_required'
    );

    const invalidOwner = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'not_a_role',
    ], protectedOptions);
    assert.equal(invalidOwner.status, 1);
    assert.equal(
      JSON.parse(invalidOwner.stdout).diagnostics[0].code,
      'blocked_result.owner_mismatch'
    );

    const stale = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'maintainer',
      '--redelegation-authority', carriers.write('redelegation-expired.json', expired),
    ], protectedOptions);
    assert.equal(stale.status, 1);
    assert.equal(
      JSON.parse(stale.stdout).diagnostics[0].code,
      'blocked_result.redelegation_stale'
    );

    const replayReturn = blockedRoleReturn(prepared.packet, evidence);
    const replayCarriers = publicReturnFiles(fixture, prepared, evidence, replayReturn);
    const replayed = await runCliInProcess([
      ...replayCarriers.baseArgs,
      '--resume-owner', 'maintainer',
      '--redelegation-authority',
      replayCarriers.write('redelegation-replayed.json', currentRedelegation),
    ], protectedOptions);
    assert.equal(replayed.status, 1);
    assert.equal(
      JSON.parse(replayed.stdout).diagnostics[0].code,
      'blocked_result.redelegation_invalid'
    );

    const humanCarriers = publicReturnFiles(fixture, prepared, evidence, roleReturn);
    const recovery = {
      identity: 'repair:task-worktree-mount',
      class: 'host_state_repair',
      scope: [],
      hostState: [`worktree:${fixture.root}:write-mount`],
    };
    const disposition = createHumanDisposition({
      blockedReturn: roleReturn,
      recovery,
      human: {
        actor: 'Repository Owner',
        authorityReference: 'approval:P35-public-fixture',
      },
      reason: 'Restore the exact task worktree mount and make no source changes.',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      result: { ownerRole: 'engineer', nextTransition: 'implementation_resume' },
    }, humanAuthority.signing);
    const recoveryPath = humanCarriers.write('recovery.json', recovery);
    const dispositionPath = humanCarriers.write('human-disposition.json', disposition);
    const missingSelectors = await runCliInProcess([
      ...humanCarriers.baseArgs,
      '--recovery-request', recoveryPath,
      '--human-disposition', dispositionPath,
    ], protectedOptions);
    assert.equal(missingSelectors.status, 2);
    assert.match(missingSelectors.stderr, /human-disposition-authority/);

    const wrongKey = await runCliInProcess([
      ...humanCarriers.baseArgs,
      '--recovery-request', recoveryPath,
      '--human-disposition', dispositionPath,
      '--human-disposition-authority', humanAuthority.trusted.authorityId,
      '--human-disposition-key-id', 'wrong-key',
    ], protectedOptions);
    assert.equal(wrongKey.status, 1);
    assert.match(JSON.parse(wrongKey.stdout).diagnostics[0].message, /does not match/);

    const authorized = await runCliInProcess([
      ...humanCarriers.baseArgs,
      '--recovery-request', recoveryPath,
      '--human-disposition', dispositionPath,
      '--human-disposition-authority', humanAuthority.trusted.authorityId,
      '--human-disposition-key-id', humanAuthority.trusted.keyId,
    ], protectedOptions);
    assert.equal(authorized.status, 0, authorized.stderr || authorized.stdout);
    assert.equal(JSON.parse(authorized.stdout).ok, true);

    installAuthorityTrust(fixture, [
      redelegationAuthority,
      {
        ...humanAuthority,
        trusted: {
          ...humanAuthority.trusted,
          revokedRecordIds: [disposition.dispositionId],
        },
      },
    ]);
    const unauthorized = await runCliInProcess([
      ...humanCarriers.baseArgs,
      '--recovery-request', recoveryPath,
      '--human-disposition', dispositionPath,
      '--human-disposition-authority', humanAuthority.trusted.authorityId,
      '--human-disposition-key-id', humanAuthority.trusted.keyId,
    ], protectedOptions);
    assert.equal(unauthorized.status, 1);
    assert.equal(
      JSON.parse(unauthorized.stdout).diagnostics[0].code,
      'human_disposition.untrusted'
    );
  });

  it('accepts a configured hyphenated registry role through --resume-owner', async () => {
    const { fixture, prepared, evidence } = await committed('public-custom-resume-owner');
    const roleReturn = blockedRoleReturn(prepared.packet, evidence);
    const authority = authorityFixture(
      'agenticloop.test.orchestrator',
      'blocked_result_redelegation',
      'orchestrator-authority-1'
    );
    installAuthorityTrust(fixture, [authority]);
    const targetConfig = {
      extends: './agenticloop/config.json',
      workflowRoles: [{
        roleId: 'security-observer',
        defaultLabel: 'Security Observer',
        escalationPrecedence: 50,
      }],
    };
    writeFileSync(
      join(fixture.root, 'agenticloop.json'),
      `${JSON.stringify(targetConfig, null, 2)}\n`,
      'utf8'
    );
    const registry = resolveWorkflowRoleRegistry(
      loadAgenticLoopConfig(join(fixture.root, 'agenticloop.json'))
    );
    assert.ok(registry.some(role => role.roleId === 'security-observer'));
    assert.throws(
      () => resolveWorkflowRoleRegistry({
        workflowRoles: [{
          roleId: 'security_observer',
          defaultLabel: 'Invalid',
          escalationPrecedence: 50,
        }],
      }),
      /invalid roleId/
    );
    const redelegation = createBlockedResultRedelegation({
      blockedReturn: roleReturn,
      toRole: 'security-observer',
      authority: {
        ownerKind: 'workflow_role',
        ownerId: 'orchestrator',
        reference: 'dispatch:security-observer:T-001',
      },
      reason: 'Security observer must assess the blocked host-state boundary.',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      registry,
    }, authority.signing);
    const carriers = publicReturnFiles(fixture, prepared, evidence, roleReturn);
    const options = {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture, []),
    };
    const accepted = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'security-observer',
      '--redelegation-authority', carriers.write('custom-role-redelegation.json', redelegation),
    ], options);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(JSON.parse(accepted.stdout).ok, true);

    const rejected = await runCliInProcess([
      ...carriers.baseArgs,
      '--resume-owner', 'unknown-role',
    ], options);
    assert.equal(rejected.status, 1);
    assert.match(
      JSON.parse(rejected.stdout).diagnostics[0].message,
      /Available role IDs: .*security-observer/
    );
  });
});
