import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createTaskInventoryEnumeration,
  evaluateParallelScan,
  normalizeFilesTaskInventory,
} from '../src/parallel-scan.js';
import {
  dispatchPreparationDigest,
  prepareRoleDispatch,
  validateDispatchPreparation,
  verifyDispatchBeforeMutation,
} from '../src/dispatch-envelope.js';
import { canonicalJson } from '../src/canonical-json.js';
import { validationResultDigest } from '../src/result-envelope.js';
import {
  createDispatchFixture,
  git,
  prepare,
  sha256,
} from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

let temp;

const currentFilesTask = name => createDispatchFixture(temp, name);

// Read-only tests share one fixture; tests that commit or write into the
// repository build their own.
let sharedTask;
const sharedFilesTask = () => (sharedTask ??= createDispatchFixture(temp, 'shared'));

before(() => { temp = mkdtempSync(join(tmpdir(), 'al-dispatch-preparation-')); });
after(() => rmSync(temp, { recursive: true, force: true }));
describe('dispatch preparation and receipt verification', () => {
  it('rejects caller-authored readiness/decomposition claims without authoritative refetch providers', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepareRoleDispatch({
      activation: fixture.activation,
      assignment: fixture.assignment,
      readiness: fixture.readiness,
      decomposition: fixture.decomposition,
      refetchTask: fixture.refetchTask,
      refetchRepository: fixture.refetchRepository,
      runGit: fixture.runGit,
    }, fixture.options);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.validation.evidenceState, 'missing');
    assert.equal(prepared.validation.diagnostics[0].code, 'dispatch.packet.invalid');
    assert.match(prepared.validation.errors.join('\n'), /readiness refetch/);
  });

  it('refuses to prove dispatch without a Git reader for the initial repository state', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepareRoleDispatch({ ...fixture, runGit: undefined }, fixture.options);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.validation.evidenceState, 'missing');
    assert.match(prepared.validation.errors.join('\n'), /Git reader is required/);
  });

  it('rejects an activation-mismatched packet even when its digest is recomputed', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const forged = structuredClone(prepared.packet);
    forged.activation.normalizedActivationDigest = sha256('forged');
    forged.digest = dispatchPreparationDigest(forged);
    assert.equal(validateDispatchPreparation(forged, fixture.options).ok, false);
  });

  it('rejects invented packet references and a mismatched branch even when its digest is recomputed', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    const forged = structuredClone(prepared.packet);
    forged.assignment.branch = 'invented-branch';
    forged.assignment.canonicalReferences = ['invented/reference'];
    forged.assignment.requiredCapabilities = ['invented_capability'];
    forged.digest = dispatchPreparationDigest(forged);
    const checked = validateDispatchPreparation(forged, fixture.options);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /branch|canonicalReferences|requiredCapabilities/);
  });

  it('preserves the full canonical readiness result and verifies an unchanged packet before mutation', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.readiness.resultDigest, validationResultDigest(fixture.readiness.result));
    assert.deepEqual(prepared.packet.readiness.result, fixture.readiness.result);
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
    assert.equal(received.ok, true, received.validation.errors?.join('\n'));
  });

  it('deep-freezes the emitted packet so nested mutation cannot rewrite it', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.throws(() => { prepared.packet.task.allowedPaths.push('etc/**'); }, TypeError);
    assert.throws(() => { prepared.packet.activation.integrity = 'verified'; }, TypeError);
    assert.throws(() => { prepared.packet.repository.cleanState.priorGates.push({}); }, TypeError);
    assert.equal(validateDispatchPreparation(prepared.packet, fixture.options).ok, true);
  });

  it('binds the exact closed host-role capability declaration into dispatch', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.assignment.host, 'opencode');
    assert.equal(prepared.packet.assignment.hostRoleCapability.roleId, 'engineer');
    assert.equal(
      prepared.packet.assignment.hostRoleCapability.actionBindings
        .find(binding => binding.action === 'implementation_mutate').policy,
      'allowed'
    );

    const forged = structuredClone(prepared.packet);
    forged.assignment.hostRoleCapability.unvalidated = true;
    forged.digest = dispatchPreparationDigest(forged);
    const checked = validateDispatchPreparation(forged, fixture.options);
    assert.equal(checked.ok, false);
    assert.ok(checked.findings.some(finding => finding.code === 'capability.declaration.invalid'));
  });

  it('measures the canonical preparation packet against the 16,384-byte regression threshold', async () => {
    const fixture = await sharedFilesTask();
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    const packetBytes = Buffer.byteLength(canonicalJson(prepared.packet), 'utf8');
    assert.ok(packetBytes <= 16_384, `dispatch packet is ${packetBytes} bytes`);
    assert.ok(packetBytes > 0);
  });

  it('invalidates a packet when task, branch, or repository base changes after preparation', async () => {
    const fixture = await currentFilesTask('stale');
    const prepared = prepare(fixture);
    writeFileSync(fixture.taskPath, `${readFileSync(fixture.taskPath, 'utf8')}\n`, 'utf8');
    const staleTask = verifyDispatchBeforeMutation({
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchReadiness: fixture.refetchReadiness,
      refetchRepository: fixture.refetchRepository,
      refetchDecomposition: fixture.refetchDecomposition,
      runGit: fixture.runGit,
      roleId: 'engineer',
    }, fixture.options);
    assert.equal(staleTask.ok, false);
    assert.notEqual(staleTask.validation.disposition, 'proceed');
    git(fixture.root, ['checkout', '--', '.agenticloop/tasks/T-001.md']);
    const changedBranch = verifyDispatchBeforeMutation({
      packet: prepared.packet,
      refetchTask: fixture.refetchTask,
      refetchReadiness: fixture.refetchReadiness,
      refetchRepository: () => ({ ...fixture.repository(), branch: 'other-branch' }),
      refetchDecomposition: fixture.refetchDecomposition,
      runGit: fixture.runGit,
      roleId: 'engineer',
    }, fixture.options);
    assert.equal(changedBranch.ok, false);
  });

  it('keeps incomplete decomposition distinct from a complete empty ready inventory', async () => {
    const fixture = await sharedFilesTask();
    const resign = value => {
      const { sourceDigest, ...rest } = value;
      return { ...rest, sourceDigest: sha256(canonicalJson(rest)) };
    };
    // Incompleteness now comes from the bound scan record, not a token: the
    // scan itself reports that its inventory could not be proven complete.
    const source = fixture.decomposition.scan.decomposition;
    const bound = fixture.decomposition.scan.readinessContext;
    const basePaths = git(fixture.root, ['ls-tree', '-r', '--name-only', bound.base.identity.slice('git-tree:'.length)])
      .split(/\r?\n/).filter(Boolean);
    const rescan = ({ complete, entries }) => evaluateParallelScan({
      workUnit: { id: fixture.decomposition.scan.workUnit.id, backend: 'files' },
      inventory: normalizeFilesTaskInventory({
        inventoryId: 'files:.agenticloop/tasks',
        entries,
        complete,
        // Completeness is only ever provable by the authoritative enumerator's
        // typed receipt; the declared flag alone can never produce it.
        enumeration: complete === true
          ? createTaskInventoryEnumeration({
            backend: 'files', inventoryId: 'files:.agenticloop/tasks',
            observedAt: fixture.decomposition.observedAt,
            discovered: entries.length, returned: entries.length,
          })
          : null,
      }),
      decomposition: {
        source: source.source, sourceRef: source.sourceRef, revision: source.revision,
        declaredCompleteness: 'complete', attribution: 'maintainer',
      },
      observedAt: fixture.decomposition.observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths,
      dependencies: {},
      readinessContext: {
        base: fixture.readiness.evidence.base,
        dependencies: fixture.readiness.evidence.dependencies,
      },
      rescanTrigger: fixture.decomposition.scan.rescanTrigger,
    }, { now: Date.parse(fixture.decomposition.observedAt) + 1000 }).scan;

    const currentEntry = { carrier: '.agenticloop/tasks/T-001.md', content: fixture.snapshot().body, readError: null };
    const incompleteScan = rescan({ complete: false, entries: [currentEntry] });
    assert.equal(incompleteScan.conclusion, 'incomplete');
    const incomplete = resign({ ...structuredClone(fixture.decomposition), scan: incompleteScan });

    // A complete inventory that simply does not contain this task is a
    // different answer from an inventory that could not be proven complete.
    const foreignScan = rescan({
      complete: true,
      entries: [{ carrier: '.agenticloop/tasks/T-900.md', content: fixture.snapshot().body.replace('task_id: T-001', 'task_id: T-900'), readError: null }],
    });
    assert.equal(foreignScan.inventory.complete, true);
    const empty = resign({ ...structuredClone(fixture.decomposition), scan: foreignScan });

    const incompleteResult = prepare(fixture, { refetchDecomposition: () => incomplete });
    const emptyResult = prepare(fixture, { refetchDecomposition: () => empty });
    assert.equal(incompleteResult.ok, false);
    assert.equal(emptyResult.ok, false);
    assert.match(incompleteResult.validation.errors.join('\n'), /incomplete/);
    assert.match(emptyResult.validation.errors.join('\n'), /does not authorize this task as ready/);
  });

  it('emits a canonical validation result for unreadable dispatch JSON', async () => {
    const fixture = await currentFilesTask('cli-json');
    writeFileSync(join(fixture.root, 'invalid.json'), '{', 'utf8');
    const run = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'invalid.json', '--json', '--target', fixture.root,
    ]);
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.ok, false);
  });

  it('keeps public dispatch fail-closed while the trusted pure seam remains usable', async () => {
    const fixture = await currentFilesTask('cli-roundtrip');
    writeFileSync(join(fixture.root, 'dispatch-input.json'), JSON.stringify({
      readiness: {
        ...fixture.readiness,
        result: { callerAuthored: true },
        resultDigest: 'caller-authored',
      },
      decomposition: {
        sourceRef: fixture.decomposition.sourceRef,
        completeness: 'incomplete',
        authority: 'orchestrator',
      },
      assignment: fixture.assignment,
    }), 'utf8');
    const prepared = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', 'dispatch-input.json', '--host-trust-store', fixture.trustStorePath, '--json', '--target', fixture.root,
    ], { operatorTrustRoot: fixture.operatorTrustRoot });
    assert.equal(prepared.status, 1);
    assert.match(JSON.parse(prepared.stdout).errors.join('\n'), /authenticated host-controlled IPC|unsupported.*in-process/i);
    assert.equal(prepare(fixture).ok, true);
  });

  it('refuses a scaffold task that has no activation authoring reference at the trusted pure seam', async () => {
    const fixture = await currentFilesTask('scaffold-refusal');
    const scaffold = readFileSync(fixture.taskPath, 'utf8')
      .split('\n')
      .filter(line => !line.startsWith('activation_input_digest:') && !line.startsWith('activation_capture_ref:'))
      .join('\n');
    writeFileSync(fixture.taskPath, scaffold, 'utf8');
    git(fixture.root, ['add', '.agenticloop/tasks/T-001.md']);
    git(fixture.root, ['commit', '-m', 'record scaffold task\n\nTask: T-001\nAgent: maintainer']);
    const result = prepare(fixture);
    assert.equal(result.ok, false);
    assert.match(result.validation.errors.join('\n'), /scaffold task cannot authorize dispatch|activation_capture_ref/);
  });
});
