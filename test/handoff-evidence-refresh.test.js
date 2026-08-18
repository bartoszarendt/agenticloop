import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { canonicalJson, canonicalSha256 } from '../src/canonical-json.js';
import { createDecompositionEligibilityProjection } from '../src/decomposition-eligibility.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import {
  applyHandoffEvidenceRefresh,
  createHandoffEvidenceRefreshPlan,
  HANDOFF_REFRESH_ROOT,
  validateHandoffRefreshPlan,
  validateHandoffRefreshReceipt,
} from '../src/handoff-evidence-refresh.js';
import { createDispatchFixture, prepare } from './helpers/dispatch-fixture.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../src/handoff-consumption.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { defaultDependencyFreshnessSeconds, parseDependencySnapshot } from '../src/task-evidence-contract.js';
import { validateDecomposition, findingSet } from '../src/dispatch-envelope.js';
import { validateParallelScanReadinessBinding } from '../src/parallel-scan.js';

let root;

before(() => { root = mkdtempSync(join(tmpdir(), 'al-refresh-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

function fileDigest(content) {
  return `sha256:${createHash('sha256').update(Buffer.from(String(content), 'utf8')).digest('hex')}`;
}

function target() {
  const value = mkdtempSync(join(root, 'target-'));
  createTaskProjectFixture(value);
  writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), 'fixture task\n', 'utf8');
  return value;
}

const ELIGIBILITY_DIGEST_RE = /^sha256:agenticloop\.decomposition-eligibility\.v1:[a-f0-9]{64}$/;

function buildEligibilityDigest(taskId, contractDigest) {
  const minimalScan = {
    workUnit: { id: 'test-work-unit', backend: 'files' },
    inventory: { complete: true, members: [{ taskId, state: 'readable', carrier: `.agenticloop/tasks/${taskId}.md`, digest: `sha256:${'b'.repeat(64)}` }] },
    readyTaskIds: [taskId],
    excluded: [],
    eligibility: [{ taskId, eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: contractDigest }],
    knowledgeCoupling: [{ taskId, classification: 'independent' }],
    couplingBlockers: [],
    candidatePairs: [],
    conclusion: 'not_currently_eligible',
    decomposition: { state: 'complete' },
    readinessContext: { digest: `sha256:readiness:${'c'.repeat(64)}`, dependencies: {} },
  };
  return createDecompositionEligibilityProjection({
    taskId, backend: 'files', contractDigest, scan: minimalScan,
    taskFacts: { requiredChecks: null, scope: null },
  }).digest;
}

function preflight(value, taskId = 'T-001') {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
  const contractDigest = `sha256:v1:${'2'.repeat(64)}`;
  return {
    kind: 'agenticloop.handoff-preflight',
    schemaVersion: 1,
    taskId,
    backend: 'files',
    carrier: `.agenticloop/tasks/${taskId}.md`,
    carrierDigest: `sha256:${'1'.repeat(64)}`,
    contractDigest,
    repository: { head, baseTree: tree, productBase: null },
    readiness: {
      ok: true,
      evidenceState: 'current',
      disposition: 'proceed',
      base: { identity: `git-tree:${tree}` },
      dependencies: {},
    },
    dependencyAge: { evaluatedAt: '2026-01-01T00:00:00.000Z', maxAgeSeconds: 3600 },
    decomposition: {
      sourceRef: `.agenticloop/decompositions/${taskId}.json`,
      sourceRevision: head,
      sourceCommit: head,
      inventoryComplete: true,
      baseMode: 'git_tree',
      eligibility: 'eligible',
      dispatchCompatible: true,
      eligibilityDigest: buildEligibilityDigest(taskId, contractDigest),
    },
  };
}

describe('handoff derived-evidence refresh', () => {
  it('creates a closed deterministic plan and applies it atomically', () => {
    const value = target();
    const current = preflight(value);
    const first = createHandoffEvidenceRefreshPlan({ target: value, preflight: current });
    const second = createHandoffEvidenceRefreshPlan({ target: value, preflight: current });
    assert.deepEqual(first, second);
    assert.equal(validateHandoffRefreshPlan(first, { target: value, taskId: 'T-001' }).ok, true);
    assert.equal(first.authority.state, 'derived_only');
    assert.equal(first.authority.durableCommitRequired, true);
    assert.equal(first.changedFiles.length, 1);

    // Categories: receipt refreshed, others not_applicable
    assert.equal(first.categories.length, 4);
    const receiptCat = first.categories.find(c => c.category === 'receipt');
    assert.equal(receiptCat.action, 'refreshed');
    const depCat = first.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCat.action, 'not_applicable');
    const decompCat = first.categories.find(c => c.category === 'decomposition_provenance');
    assert.equal(decompCat.action, 'not_applicable');
    const dispatchCat = first.categories.find(c => c.category === 'dispatch');
    assert.equal(dispatchCat.action, 'not_applicable');

    // Dispatch field: nulls when no consumption exists
    assert.equal(first.proposed.dispatch.invocation, null);
    assert.equal(first.proposed.dispatch.liveness, null);

    const taskBefore = readFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');
    const applied = applyHandoffEvidenceRefresh({ target: value, plan: first, preflight: current });
    assert.equal(applied.ok, true, applied.errors?.join('; '));
    assert.deepEqual(applied.changedFiles, [`${HANDOFF_REFRESH_ROOT}/T-001.json`]);
    assert.equal(existsSync(join(value, HANDOFF_REFRESH_ROOT, 'T-001.json')), true);
    assert.equal(readFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), 'utf8'), taskBefore);
    assert.equal(validateHandoffRefreshReceipt(applied.receipt, { target: value, taskId: 'T-001' }).ok, true);
    assert.match(applied.receipt.decomposition.eligibilityDigest, ELIGIBILITY_DIGEST_RE);
    assert.equal(applied.attributionValidation.ok, true);
    assert.equal(applied.maintainerTrailerBlock, 'Task: T-001\nAgent: maintainer');
  });

  it('rejects stale carrier or repository observations before writing', () => {
    const value = target();
    const current = preflight(value);
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: current });
    const changed = { ...current, carrierDigest: `sha256:${'3'.repeat(64)}` };
    const result = applyHandoffEvidenceRefresh({ target: value, plan, preflight: changed });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceState, 'changed');
    assert.equal(result.disposition, 'superseded');
    assert.equal(existsSync(join(value, HANDOFF_REFRESH_ROOT, 'T-001.json')), false);
  });

  it('rejects protected authority edits in a plan', () => {
    const value = target();
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: preflight(value) });
    const forged = structuredClone(plan);
    forged.authority.durableCommitRequired = false;
    assert.equal(validateHandoffRefreshPlan(forged, { target: value, taskId: 'T-001' }).ok, false);
  });

  it('rejects forged expected paths targeting task or product files', () => {
    const value = target();
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: preflight(value) });
    const forgedPath = structuredClone(plan);
    forgedPath.expected.path = '.agenticloop/tasks/T-001.md';
    forgedPath.changedFiles = [`${HANDOFF_REFRESH_ROOT}/T-001.json`];
    const result = validateHandoffRefreshPlan(forgedPath, { target: value, taskId: 'T-001' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('expected path must be the canonical derived-evidence path')), result.errors.join('; '));
    assert.ok(result.errors.some(error => error.includes('changedFiles must include the receipt path')), result.errors.join('; '));
  });

  it('rejects trailing JSON through the public parser boundary', () => {
    const value = target();
    const path = join(value, 'plan.json');
    writeFileSync(path, '{"kind":"agenticloop.handoff-evidence-refresh-plan"}\ntrailing', 'utf8');
    assert.throws(() => JSON.parse(readFileSync(path, 'utf8')), /Unexpected token|Unexpected non-whitespace/);
  });

  it('category 2: stale dependency snapshot produces refreshed snapshot with preserved statuses', () => {
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: {},
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null,2), 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md', depSnapshotPath, '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add dependency and decomposition']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const depCatPlan = plan.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCatPlan.action, 'refreshed', `depCatPlan reason: ${depCatPlan.reason}`);
    assert.match(depCatPlan.reason, /observedAt renewed/);

    const depWrite = plan.additionalWrites.find(w => w.path === depSnapshotPath);
    assert.ok(depWrite, 'dependency snapshot write must be in additionalWrites');
    const writtenSnapshot = JSON.parse(depWrite.content);
    assert.equal(writtenSnapshot.observedAt > staleObservedAt, true, 'observedAt must be fresh');
    assert.deepEqual(writtenSnapshot.statuses, {}, 'empty statuses preserved');
    // The refresh is the producer, so it emits the backend-derived policy rather
    // than carrying the hand-authored one-hour window forward into a window that
    // expires again inside the same delegation cycle.
    assert.equal(writtenSnapshot.freshnessPolicy.maxAgeSeconds, defaultDependencyFreshnessSeconds('files'));

    const applied = applyHandoffEvidenceRefresh({ target: value, plan, preflight: stalePreflight });
    assert.equal(applied.ok, true, applied.errors?.join('; '));
  });

  it('category 3: stale decomposition triggers regeneration', () => {
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier with template']);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: '2020-01-01T00:00:00.000Z',
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: null, source: 'files:.agenticloop/tasks', digest: `sha256:${'f'.repeat(64)}`, observedAt: '2020-01-01T00:00:00.000Z', evaluatedAt: '2020-01-01T00:00:00.000Z', freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    git(value, ['add', '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add stale decomposition']);

    const current = preflight(value);
    const stalePreflight = { ...current, decomposition: { ...current.decomposition, dispatchCompatible: false } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });
    const decompCatPlan = plan.categories.find(c => c.category === 'decomposition_provenance');
    assert.equal(decompCatPlan.action, 'refreshed', `decompCatPlan reason: ${decompCatPlan.reason}`);
    assert.ok(plan.additionalWrites.some(w => w.path === '.agenticloop/decompositions/T-001.json'));
    assert.ok(plan.changedFiles.includes('.agenticloop/decompositions/T-001.json'));
  });

  it('category 4: dispatch fields populated from consumption record', async () => {
    const temp = mkdtempSync(join(root, 'dispatch-'));
    const fixture = await createDispatchFixture(temp, 'dispatch-test');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation?.errors?.join('; '));

    // Create a recognition from the prepared dispatch
    const recognition = recognizeHandoff({
      transition: 'role_start',
      expectation: {
        backend: 'files', taskId: 'T-001', roleId: 'engineer',
        taskContractDigest: prepared.packet.task.contractDigest,
        carrierDigest: prepared.packet.task.digest,
        packetId: prepared.packet.packetId, packetDigest: prepared.packet.digest,
        workUnitIdentity: prepared.packet.decomposition.workUnitId,
        artifactHead: prepared.packet.repository.head,
        worktreeRoot: prepared.packet.repository.worktree,
        minimumActivationAssurance: 'operator_confirmed',
      },
      preparedDispatch: prepared.packet,
      validatePreparedDispatch: fixtureDispatchValidator(fixture),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));

    // Create and write the consumption record
    const consumption = createDispatchConsumption({ backend: 'files', taskId: 'T-001', recognition });
    const consumptionPath = dispatchConsumptionRelativePath(consumption);
    mkdirSync(join(fixture.root, '.agenticloop', 'handoffs', 'dispatch', 'T-001'), { recursive: true });
    writeFileSync(join(fixture.root, consumptionPath), `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');

    // Build preflight for this fixture
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: fixture.root, encoding: 'utf8' }).stdout.trim();
    const contractDigest = prepared.packet.task.taskContractDigest;
    const dispatchPreflight = {
      kind: 'agenticloop.handoff-preflight', schemaVersion: 1,
      taskId: 'T-001', backend: 'files',
      carrier: '.agenticloop/tasks/T-001.md',
      carrierDigest: prepared.packet.task.dispatchCarrierDigest,
      contractDigest,
      repository: { head, baseTree: tree, productBase: null },
      readiness: { ok: true, evidenceState: 'current', disposition: 'proceed', base: { identity: `git-tree:${tree}` }, dependencies: {} },
      dependencyAge: { state: 'observed', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600 },
      decomposition: {
        sourceRef: '.agenticloop/decompositions/T-001.json',
        sourceRevision: head, sourceCommit: head,
        inventoryComplete: true, baseMode: 'git_tree',
        eligibility: 'eligible', dispatchCompatible: true,
        eligibilityDigest: buildEligibilityDigest('T-001', contractDigest),
      },
    };
    const plan = createHandoffEvidenceRefreshPlan({ target: fixture.root, preflight: dispatchPreflight });

    // Dispatch fields should be populated
    assert.equal(plan.proposed.dispatch.invocation, consumption.invocationId);
    assert.notEqual(plan.proposed.dispatch.liveness, null);
    assert.equal(plan.proposed.dispatch.liveness.invocationId, consumption.invocationId);
    assert.equal(typeof plan.proposed.dispatch.liveness.consumedAt, 'string');

    // Category dispatch should be refreshed
    const dispatchCat = plan.categories.find(c => c.category === 'dispatch');
    assert.equal(dispatchCat.action, 'refreshed');
  });

  it('category 4: dispatch fields are nulls without consumption', () => {
    const value = target();
    const current = preflight(value);
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: current });
    assert.equal(plan.proposed.dispatch.invocation, null);
    assert.equal(plan.proposed.dispatch.liveness, null);
    const dispatchCat = plan.categories.find(c => c.category === 'dispatch');
    assert.equal(dispatchCat.action, 'not_applicable');
  });

  it('invariant: apply with smuggled task-carrier path in additionalWrites is rejected', () => {
    const value = target();
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: preflight(value) });
    const forged = structuredClone(plan);
    forged.additionalWrites.push({ path: '.agenticloop/tasks/T-001.md', expectedDigest: null, content: '{}\n' });
    forged.changedFiles.push('.agenticloop/tasks/T-001.md');
    const result = validateHandoffRefreshPlan(forged, { target: value, taskId: 'T-001' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('not under an allowed root')), result.errors.join('; '));
  });

  it('invariant: apply with smuggled product path in additionalWrites is rejected', () => {
    const value = target();
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: preflight(value) });
    const forged = structuredClone(plan);
    forged.additionalWrites.push({ path: 'src/evil.js', expectedDigest: null, content: 'malware\n' });
    forged.changedFiles.push('src/evil.js');
    const result = validateHandoffRefreshPlan(forged, { target: value, taskId: 'T-001' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('not under an allowed root')), result.errors.join('; '));
  });

  it('invariant: plan with requires_maintainer_observation has no additional writes for that category', () => {
    const value = target();
    const current = preflight(value);
    // dependencyAge.state is stale but snapshot doesn't exist → requires_maintainer_observation or not_applicable
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600 } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });
    const depCat = plan.categories.find(c => c.category === 'dependency_observation');
    // Without a decomposition sourceRef pointing to a real snapshot, this is not_applicable
    assert.equal(depCat.action, 'not_applicable');
    // No additional writes for dependency
    assert.equal(plan.additionalWrites.filter(w => !w.path.startsWith('.agenticloop/decompositions/')).length, 0);
  });

  it('atomicity: conflicting receipt digest causes apply to refuse and write nothing', () => {
    const value = target();
    const current = preflight(value);
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: current });
    // Pre-write a conflicting file at the receipt path
    const receiptPath = join(value, HANDOFF_REFRESH_ROOT, 'T-001.json');
    mkdirSync(join(value, HANDOFF_REFRESH_ROOT), { recursive: true });
    writeFileSync(receiptPath, '{"stale":"content"}\n', 'utf8');
    const result = applyHandoffEvidenceRefresh({ target: value, plan, preflight: current });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceState, 'changed');
    assert.equal(result.disposition, 'superseded');
    assert.deepEqual(result.changedFiles, []);
  });

  it('atomicity: multi-file plan with conflicting additional file digest writes nothing', () => {
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier with template']);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionPath = join(value, '.agenticloop', 'decompositions', 'T-001.json');
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: '2020-01-01T00:00:00.000Z',
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: null, source: 'files:.agenticloop/tasks', digest: `sha256:${'f'.repeat(64)}`, observedAt: '2020-01-01T00:00:00.000Z', evaluatedAt: '2020-01-01T00:00:00.000Z', freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    writeFileSync(decompositionPath, JSON.stringify(decompositionSource, null, 2), 'utf8');
    git(value, ['add', '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add stale decomposition']);

    const current = preflight(value);
    const stalePreflight = { ...current, decomposition: { ...current.decomposition, dispatchCompatible: false } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });
    const decompCat = plan.categories.find(c => c.category === 'decomposition_provenance');
    assert.equal(decompCat.action, 'refreshed', `decompCat reason: ${decompCat.reason}`);

    writeFileSync(decompositionPath, '{"modified":"after plan"}\n', 'utf8');
    const result = applyHandoffEvidenceRefresh({ target: value, plan, preflight: stalePreflight });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceState, 'changed');
    assert.deepEqual(result.changedFiles, []);
  });

  // F1(a): override preservation — snapshot 'resolved' preserved over carrier 'in-progress'
  it('F1a: snapshot override preserved — resolved survives carrier in-progress', () => {
    const value = target();
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-002': 'resolved' },
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [{ id: 'T-002', status: 'resolved' }], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 1 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier.replace('# depends_on:\n#   - T-000', 'depends_on:\n  - T-002'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-002.md'), templateCarrier.replaceAll('T-001', 'T-002').replace('status: agent-ready', 'status: in-progress'), 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json', '.agenticloop/tasks/T-001.md', '.agenticloop/tasks/T-002.md']);
    git(value, ['commit', '-m', 'add dependency, decomposition, and carriers']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const depCatPlan = plan.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCatPlan.action, 'refreshed', `depCatPlan reason: ${depCatPlan.reason}`);

    const depWrite = plan.additionalWrites.find(w => w.path === depSnapshotPath);
    assert.ok(depWrite);
    const writtenSnapshot = JSON.parse(depWrite.content);
    assert.equal(writtenSnapshot.statuses['T-002'], 'resolved', 'snapshot override must be preserved');
    assert.equal(writtenSnapshot.observedAt > staleObservedAt, true, 'observedAt must be fresh');

    const applied = applyHandoffEvidenceRefresh({ target: value, plan, preflight: stalePreflight });
    assert.equal(applied.ok, true, applied.errors?.join('; '));
  });

  // F1(b): carrier 'done' does not degrade a satisfied snapshot
  it('F1b: carrier done does not degrade satisfied snapshot', () => {
    const value = target();
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-002': 'resolved' },
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [{ id: 'T-002', status: 'resolved' }], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 1 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier.replace('# depends_on:\n#   - T-000', 'depends_on:\n  - T-002'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-002.md'), templateCarrier.replaceAll('T-001', 'T-002').replace('status: agent-ready', 'status: done'), 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json', '.agenticloop/tasks/T-001.md', '.agenticloop/tasks/T-002.md']);
    git(value, ['commit', '-m', 'add dependency, decomposition, and carriers']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const depCatPlan = plan.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCatPlan.action, 'refreshed');

    const depWrite = plan.additionalWrites.find(w => w.path === depSnapshotPath);
    const writtenSnapshot = JSON.parse(depWrite.content);
    assert.equal(writtenSnapshot.statuses['T-002'], 'resolved', 'snapshot resolved must not be downgraded to done');
  });

  // F1(c): new unrecorded dependency → requires_maintainer_observation, no write
  it('F1c: new unrecorded dependency requires maintainer observation', () => {
    const value = target();
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-002': 'resolved' },
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [{ id: 'T-002', status: 'resolved' }], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 1 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    // T-001 depends on T-002 AND T-003, but snapshot only has T-002
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), '---\nstatus: agent-ready\ndepends_on:\n  - T-002\n  - T-003\n---\nTask body\n', 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-002.md'), '---\nstatus: resolved\n---\nDependency task\n', 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-003.md'), '---\nstatus: agent-ready\n---\nNew dependency task\n', 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json', '.agenticloop/tasks']);
    git(value, ['commit', '-m', 'add dependency, decomposition, and carriers']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const depCatPlan = plan.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCatPlan.action, 'requires_maintainer_observation');
    assert.match(depCatPlan.reason, /T-003/);

    const depWrite = plan.additionalWrites.find(w => w.path === depSnapshotPath);
    assert.equal(depWrite, undefined, 'no snapshot write when requires_maintainer_observation');
  });

  // F2(a): forged plan with protected out-of-roots path fails validation
  it('F2a: forged plan with task-carrier out-of-roots path fails validation', () => {
    const value = target();
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-002': 'resolved' },
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [{ id: 'T-002', status: 'resolved' }], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 1 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), '---\nstatus: agent-ready\ndepends_on:\n  - T-002\n---\nTask body\n', 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-002.md'), '---\nstatus: resolved\n---\nDependency task\n', 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json', '.agenticloop/tasks']);
    git(value, ['commit', '-m', 'add dependency, decomposition, and carriers']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const forged = structuredClone(plan);
    forged.additionalWrites.push({ path: '.agenticloop/tasks/T-001.md', expectedDigest: null, content: '{}\n' });
    forged.changedFiles.push('.agenticloop/tasks/T-001.md');
    const result = validateHandoffRefreshPlan(forged, { target: value, taskId: 'T-001' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('not under an allowed root')), result.errors.join('; '));
  });

  // F4: mutate carrier between plan and apply → apply refuses
  it('F4: uncommitted carrier mutation between plan and apply causes refusal', () => {
    const value = target();
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: { 'T-002': 'resolved' },
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [{ id: 'T-002', status: 'resolved' }], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 1 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), '---\nstatus: agent-ready\ndepends_on:\n  - T-002\n---\nTask body\n', 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-002.md'), '---\nstatus: resolved\n---\nDependency task\n', 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json', '.agenticloop/tasks']);
    git(value, ['commit', '-m', 'add dependency, decomposition, and carriers']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    // Mutate carrier between plan and apply
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-002.md'), '---\nstatus: in-progress\n---\nMutated carrier\n', 'utf8');

    const result = applyHandoffEvidenceRefresh({ target: value, plan, preflight: stalePreflight });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceState, 'changed');
    assert.deepEqual(result.changedFiles, []);
  });

  // F3b: when category2 and category3 both refresh, decomposition's bound dependency digest matches snapshot
  it('F3b: category3 regenerated decomposition binds the snapshot written by category2', () => {
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier with template']);
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: {},
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: '2020-01-01T00:00:00.000Z',
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add dependency and decomposition']);

    const current = preflight(value);
    const stalePreflight = {
      ...current,
      dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt },
      decomposition: { ...current.decomposition, dispatchCompatible: false },
    };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const depCatPlan = plan.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCatPlan.action, 'refreshed');
    const decompCatPlan = plan.categories.find(c => c.category === 'decomposition_provenance');
    assert.equal(decompCatPlan.action, 'refreshed');

    const depWrite = plan.additionalWrites.find(w => w.path === depSnapshotPath);
    assert.ok(depWrite, 'snapshot write must exist');
    const decompWrite = plan.additionalWrites.find(w => w.path === '.agenticloop/decompositions/T-001.json');
    assert.ok(decompWrite, 'decomposition write must exist');

    const writtenDecomp = JSON.parse(decompWrite.content);
    const writtenSnapshot = JSON.parse(depWrite.content);
    const depEvidence = writtenDecomp.scan.readinessContext.dependencies;
    assert.ok(depEvidence, 'decomposition must have dependency evidence');
    // The decomposition's dependency digest comes from parseDependencySnapshot which uses canonicalSha256
    const expectedDepDigest = `sha256:${canonicalSha256(depWrite.content)}`;
    assert.equal(depEvidence.digest, expectedDepDigest, 'decomposition bound digest must equal snapshot write digest');
    assert.equal(depEvidence.observedAt, writtenSnapshot.observedAt, 'decomposition bound observedAt must equal snapshot observedAt');
  });

  it('NF3: snapshot binding re-derivation failure with snapshot in additionalWrites returns changed/superseded', () => {
    const value = target();
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: {},
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: '2020-01-01T00:00:00.000Z',
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    git(value, ['add', depSnapshotPath, '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add dependency and decomposition']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const mutatedSnapshot = { ...depSnapshot, statuses: { 'T-999': 'blocked' } };
    writeFileSync(join(value, depSnapshotPath), `${canonicalJson(mutatedSnapshot)}\n`, 'utf8');

    const result = applyHandoffEvidenceRefresh({ target: value, plan, preflight: stalePreflight });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceState, 'changed');
    assert.equal(result.disposition, 'superseded');
    assert.deepEqual(result.changedFiles, []);
    assert.ok(result.firstSafeRepair.includes('repair-plan'), result.firstSafeRepair);
  });

  it('two-cycle regression: canonical digest works across plan-create-apply-replan-reapply', () => {
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: {},
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: '2020-01-01T00:00:00.000Z',
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: '2020-01-01T00:00:00.000Z',
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md', depSnapshotPath, '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add dependency and decomposition']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan1 = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });
    const applied1 = applyHandoffEvidenceRefresh({ target: value, plan: plan1, preflight: stalePreflight });
    assert.equal(applied1.ok, true, `cycle 1 apply failed: ${applied1.errors?.join('; ')}`);

    git(value, ['add', ...applied1.changedFiles]);
    git(value, ['commit', '-m', 'apply cycle 1 refresh']);

    const current2 = preflight(value);
    const stalePreflight2 = { ...current2, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: stalePreflight.dependencyAge.observedAt } };
    const plan2 = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight2 });
    const applied2 = applyHandoffEvidenceRefresh({ target: value, plan: plan2, preflight: stalePreflight2 });
    assert.equal(applied2.ok, true, `cycle 2 apply failed: ${applied2.errors?.join('; ')}`);
  });

  it('CLI e2e: preflight --repair-plan then refresh-handoff-evidence via public CLI', async () => {
    const { runCliInProcess } = await import('./helpers/run-cli.js');
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier with template']);

    // Step 1: Run handoff-preflight with --repair-plan to generate a plan
    const preflightRun = await runCliInProcess([
      'task', 'handoff-preflight', 'T-001',
      '--repair-plan', '.agenticloop/tmp/refresh-plan.json',
      '--json',
    ], { cwd: value });
    // Preflight may succeed or fail depending on fixture state; either way the plan should be generated
    const preflight = JSON.parse(preflightRun.stdout);
    assert.ok(preflight.refreshPlan, 'preflight JSON should include refreshPlan');
    assert.ok(preflight.refreshPlanPath, 'preflight JSON should include refreshPlanPath');
    const planPath = join(value, '.agenticloop', 'tmp', 'refresh-plan.json');
    assert.ok(existsSync(planPath), 'plan file should be written');

    // Step 2: Run refresh-handoff-evidence with the plan
    const refreshRun = await runCliInProcess([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--plan', '.agenticloop/tmp/refresh-plan.json',
      '--yes', '--json',
    ], { cwd: value });
    assert.equal(refreshRun.status, 0, `refresh should succeed\nstderr:\n${refreshRun.stderr}`);
    const refreshResult = JSON.parse(refreshRun.stdout);
    assert.ok(refreshResult.receipt, 'refresh result should have a receipt');
    assert.ok(refreshResult.changedFiles, 'refresh result should have changedFiles');
    assert.ok(refreshResult.changedFiles.length > 0, 'should have at least one changed file');
    assert.ok(refreshResult.changedFiles.some(f => f.includes('T-001')), 'changed files should reference the task');
  });

  it('CLI e2e: refresh-handoff-evidence rejects missing --yes', async () => {
    const { runCliInProcess } = await import('./helpers/run-cli.js');
    const value = target();
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), 'fixture\n', 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier']);

    // Write a minimal plan
    const planPath = join(value, '.agenticloop', 'tmp', 'plan.json');
    mkdirSync(join(value, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(planPath, '{}\n', 'utf8');

    const run = await runCliInProcess([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--plan', '.agenticloop/tmp/plan.json',
      // No --yes
      '--json',
    ], { cwd: value });
    assert.equal(run.status, 2, 'missing --yes should exit with usage error');
    const result = JSON.parse(run.stdout);
    assert.ok(result.evidenceState, 'result should have evidenceState');
    assert.match(result.diagnostics[0].message, /--yes/);
  });

  it('CLI e2e: refresh-handoff-evidence rejects missing --plan', async () => {
    const { runCliInProcess } = await import('./helpers/run-cli.js');
    const value = target();
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), 'fixture\n', 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier']);

    const run = await runCliInProcess([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--yes', '--json',
    ], { cwd: value });
    assert.equal(run.status, 2, 'missing --plan should exit with usage error');
    const result = JSON.parse(run.stdout);
    assert.ok(result.evidenceState, 'result should have evidenceState');
  });

  it('CLI e2e: refresh-handoff-evidence rejects malformed plan file', async () => {
    const { runCliInProcess } = await import('./helpers/run-cli.js');
    const value = target();
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), 'fixture\n', 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier']);

    const planPath = join(value, '.agenticloop', 'tmp', 'bad-plan.json');
    mkdirSync(join(value, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(planPath, '{"kind":"wrong.kind"}\n', 'utf8');

    const run = await runCliInProcess([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--plan', '.agenticloop/tmp/bad-plan.json',
      '--yes', '--json',
    ], { cwd: value });
    assert.notEqual(run.status, 0, 'malformed plan should fail');
    const result = JSON.parse(run.stdout);
    assert.ok(result.evidenceState, 'result should have evidenceState');
    assert.ok(result.diagnostics[0].message.includes('malformed') || result.diagnostics[0].code.includes('malformed'));
  });

  it('CLI e2e: refresh-handoff-evidence human output shape', async () => {
    const { runCliInProcess } = await import('./helpers/run-cli.js');
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md']);
    git(value, ['commit', '-m', 'write carrier with template']);

    // Generate a plan first
    await runCliInProcess([
      'task', 'handoff-preflight', 'T-001',
      '--repair-plan', '.agenticloop/tmp/plan.json',
      '--json',
    ], { cwd: value });

    // Run refresh in human mode
    const run = await runCliInProcess([
      'task', 'refresh-handoff-evidence', 'T-001',
      '--plan', '.agenticloop/tmp/plan.json',
      '--yes',
    ], { cwd: value });
    assert.equal(run.status, 0, `refresh should succeed\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /REFRESHED/);
    assert.match(run.stdout, /T-001/);
  });

  it('pairing: fresh decomposition + stale snapshot produces both refreshed, readiness binding passes', () => {
    const value = target();
    const templateCarrier = readFileSync(join(value, 'agenticloop', 'memory', 'task-record.md'), 'utf8');
    writeFileSync(join(value, '.agenticloop', 'tasks', 'T-001.md'), templateCarrier, 'utf8');
    const depSnapshotPath = 'dependencies.json';
    const staleObservedAt = '2020-01-01T00:00:00.000Z';
    const depSnapshot = {
      kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
      source: 'files:.agenticloop/tasks', observedAt: staleObservedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      statuses: {},
    };
    const depSnapshotContent = `${canonicalJson(depSnapshot)}\n`;
    writeFileSync(join(value, depSnapshotPath), depSnapshotContent, 'utf8');
    const depSnapshotDigest = parseDependencySnapshot(depSnapshotContent, { sourceRef: depSnapshotPath, now: Date.parse(staleObservedAt) + 1000 }).evidence.digest;

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: value, encoding: 'utf8' }).stdout.trim();
    const decompositionSource = {
      kind: 'agenticloop.decomposition-provenance', schemaVersion: 2,
      taskId: 'T-001', authority: 'maintainer', source: 'task-decomposition', route: 'serial',
      scan: {
        workUnit: { id: 'test-work-unit', backend: 'files' },
        inventory: { id: 'files:.agenticloop/tasks', complete: true, memberCount: 1, members: [{ taskId: 'T-001', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'a'.repeat(64)}`, state: 'readable' }], digest: `sha256:${'d'.repeat(64)}` },
        decomposition: { source: 'task-decomposition', sourceRef: '.agenticloop/decompositions/T-001.json', revision: `git-commit:${head}`, declaredCompleteness: 'complete', attribution: 'maintainer', state: 'complete' },
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 3600 },
        readyTaskIds: ['T-001'],
        excluded: [],
        eligibility: [{ taskId: 'T-001', eligibility: 'eligible', status: 'agent-ready', protectedContractDigest: `sha256:v1:${'2'.repeat(64)}`, declaredDependencies: [] }],
        knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
        couplingBlockers: [],
        candidatePairs: [],
        conclusion: 'not_currently_eligible',
        readinessContext: {
          base: { kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: `sha256:${'e'.repeat(64)}`, pathCount: 10, revalidationArgs: ['--base', tree] },
          dependencies: { sourceRef: depSnapshotPath, source: 'files:.agenticloop/tasks', digest: depSnapshotDigest, observedAt: staleObservedAt, evaluatedAt: staleObservedAt, freshnessPolicy: { maxAgeSeconds: 3600 }, freshnessState: 'stale', evaluatedState: 'indeterminate', statuses: [], statusDigest: `sha256:${'g'.repeat(64)}`, statusCount: 0 },
        },
        rescanTrigger: 'test',
      },
      observedAt: new Date().toISOString(),
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: '.agenticloop/decompositions/T-001.json',
      sourceDigest: null,
    };
    decompositionSource.sourceDigest = `sha256:${'h'.repeat(64)}`;
    mkdirSync(join(value, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), JSON.stringify(decompositionSource, null, 2), 'utf8');
    git(value, ['add', '.agenticloop/tasks/T-001.md', depSnapshotPath, '.agenticloop/decompositions/T-001.json']);
    git(value, ['commit', '-m', 'add dependency and decomposition']);

    const current = preflight(value);
    const stalePreflight = { ...current, dependencyAge: { state: 'stale', evaluatedAt: new Date().toISOString(), maxAgeSeconds: 3600, observedAt: staleObservedAt } };
    const plan = createHandoffEvidenceRefreshPlan({ target: value, preflight: stalePreflight });

    const depCatPlan = plan.categories.find(c => c.category === 'dependency_observation');
    assert.equal(depCatPlan.action, 'refreshed', `depCatPlan reason: ${depCatPlan.reason}`);
    const decompCatPlan = plan.categories.find(c => c.category === 'decomposition_provenance');
    assert.equal(decompCatPlan.action, 'refreshed', `decompCatPlan reason: ${decompCatPlan.reason}`);

    const depWrite = plan.additionalWrites.find(w => w.path === depSnapshotPath);
    assert.ok(depWrite, 'dependency snapshot write must be in additionalWrites');
    const decompWrite = plan.additionalWrites.find(w => w.path === '.agenticloop/decompositions/T-001.json');
    assert.ok(decompWrite, 'decomposition write must be in additionalWrites');

    const applied = applyHandoffEvidenceRefresh({ target: value, plan, preflight: stalePreflight });
    assert.equal(applied.ok, true, applied.errors?.join('; '));

    const regenDecomp = JSON.parse(readFileSync(join(value, '.agenticloop', 'decompositions', 'T-001.json'), 'utf8'));
    const findings = findingSet('test');
    validateDecomposition(regenDecomp, 'T-001', findings);
    assert.equal(findings.length, 0, `validateDecomposition failed: ${findings.messages.join('; ')}`);

    const newSnapshotContent = readFileSync(join(value, depSnapshotPath), 'utf8');
    const parsedDep = parseDependencySnapshot(newSnapshotContent, { sourceRef: depSnapshotPath, now: Date.now() });
    assert.equal(parsedDep.ok, true, parsedDep.errors?.join('; '));
    const boundBase = regenDecomp.scan.readinessContext.base;
    const treeFromIdentity = boundBase.identity.replace('git-tree:', '');
    const baseEvidence = { ...boundBase, revalidationArgs: ['--base', treeFromIdentity] };
    const binding = validateParallelScanReadinessBinding(regenDecomp.scan, {
      base: baseEvidence,
      dependencies: parsedDep.evidence,
    });
    assert.equal(binding.ok, true, `readiness binding failed: ${binding.errors?.join('; ')}`);
  });
});
