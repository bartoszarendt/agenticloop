/**
 * Shared files-backed dispatch fixture.
 *
 * Builds a committed, clean task project whose task record is bound to a
 * host-signed activation capture from an operator-pinned test adapter. Both the
 * envelope tests and the hardening tests consume this so a single fixture
 * defines what "current, clean, activation-bound" means.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  captureActivationInput,
  createDecompositionProvenance,
  createRoleReturn,
  prepareRoleDispatch,
} from '../../src/dispatch-envelope.js';
import {
  createTaskInventoryEnumeration,
  evaluateParallelScan,
  normalizeFilesTaskInventory,
} from '../../src/parallel-scan.js';
import { createHostHandoffReceipt } from '../../src/host-handoff.js';
import { getHostRoleCapability } from '../../src/host-role-capabilities.js';
import { canonicalJson } from '../../src/canonical-json.js';
import { createValidationResult, validationResultDigest } from '../../src/result-envelope.js';
import { createTaskReadinessEvidence, dependencyStatusMap, parseDependencySnapshot } from '../../src/task-evidence-contract.js';
import { evaluateTaskReadiness } from '../../src/task-readiness.js';
import { loadFilesTaskContractRecords } from '../../src/files-task-contract.js';
import { createTaskProjectFixture } from './task-fixture.js';
import { createTestHostTrust, writeHostTrustStore } from './host-trust-fixture.js';
import { runCliInProcess } from './run-cli.js';
import { git, gitRunner } from './git-fixture.js';

export { git, gitRunner } from './git-fixture.js';

export const FULL_SHA_B = '2222222222222222222222222222222222222222';
export const ACTIVATION_CARRIER = '.agenticloop/activation/T-001.json';
export const DEFAULT_ACTIVATION_PAYLOAD = 'Implement punctuation.\nKeep the test.';
export const RETURN_INVALIDATORS = Object.freeze([
  'task_or_contract_changes',
  'packet_or_assignment_changes',
  'branch_or_head_changes',
  'check_or_transport_evidence_changes',
  'initial_repository_state_changes',
]);
const FIXTURE_EXECUTION_EVIDENCE = Object.freeze({
  path: '.agenticloop/tmp/evidence.json',
  digest: `sha256:agenticloop.execution-evidence.v4:${'a'.repeat(64)}`,
});

function withExecutionEvidence(checks) {
  return checks.map(check => check.kind === 'command' && check.outcome === 'passed'
    ? { ...check, executionEvidence: check.executionEvidence ?? FIXTURE_EXECUTION_EVIDENCE }
    : check);
}

export function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function filesystemState(path) {
  if (!existsSync(path)) return { present: false };
  if (!statSync(path).isDirectory()) {
    return { present: true, type: 'file', digest: sha256(readFileSync(path, 'utf8')) };
  }
  const entries = readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => entry.isDirectory()
      ? { name: entry.name, type: 'directory', entries: filesystemState(join(path, entry.name)).entries }
      : { name: entry.name, type: 'file', digest: sha256(readFileSync(join(path, entry.name), 'utf8')) });
  return { present: true, entries };
}

/**
 * Returns a cache key only for a clean Git input, including every external
 * harness path whose state can affect closeout certification.
 */
export function closeoutCertificationFingerprint(root, harnessOptions, externalPaths = []) {
  if (git(root, ['status', '--porcelain', '--untracked-files=all']) !== '') return null;
  return sha256(canonicalJson({
    gitHead: git(root, ['rev-parse', 'HEAD']),
    gitTree: git(root, ['rev-parse', 'HEAD^{tree}']),
    harnessOptions,
    externalState: externalPaths.map(path => ({ path: resolve(path), state: filesystemState(path) })),
  }));
}

/** Build one host-signed capture through an operator-pinned test adapter. */
export function activation(
  trust,
  payload = DEFAULT_ACTIVATION_PAYLOAD,
  expected = sha256(DEFAULT_ACTIVATION_PAYLOAD),
  {
    intendedTaskId = 'T-001',
    capturedAt = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
    captureId,
  } = {}
) {
  return captureActivationInput({
    adapter: trust.adapterId,
    ...(captureId ? { captureId } : {}),
    intendedTaskId,
    expectedRequestSha256: expected,
    parserNormalizedPayload: payload,
    capturedAt,
    expiresAt,
    sign: { keyId: trust.keyId, privateKey: trust.privateKey },
  }, { capabilities: trust.capabilities });
}

/**
 * Rebuild the retired schema-version-1 decomposition shape byte-exactly.
 *
 * Prior-evidence classification needs a record that is genuinely authentic, not
 * a hand-waved approximation: only then does "authentic prior evidence is typed
 * stale, a lookalike stays malformed" mean anything.
 */
export function legacyDecompositionProvenance(taskId, observedAt, sourceRef) {
  const value = {
    kind: 'agenticloop.decomposition-provenance',
    schemaVersion: 1,
    taskId,
    authority: 'maintainer',
    source: 'task-decomposition',
    inventory: {
      id: 'decomposition:fixture',
      readyTaskIds: [taskId],
      digest: sha256(canonicalJson({ taskId, readyTaskIds: [taskId] })),
    },
    completeness: 'complete',
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    sourceRef,
  };
  return { ...value, sourceDigest: sha256(canonicalJson(value)) };
}

function canonicalReadiness(raw) {
  return createValidationResult({
    command: 'task-readiness',
    ok: raw.ok,
    evidenceState: raw.evidenceState,
    disposition: raw.disposition,
    errors: raw.errors,
    warnings: raw.warnings,
    diagnostics: raw.diagnostics,
  });
}

/**
 * Create a clean, committed, activation-bound files task fixture.
 *
 * Building the committed git history costs a dozen-plus subprocess spawns.
 * A host-signed capture binds the exact repository path into committed,
 * trusted history, so the default fixture is rebuilt per call. A scaffold
 * fixture carries no capture at all, so the first scaffold call for a (temp,
 * options) pair builds a pristine template once and every call clones it
 * byte-for-byte (including `.git`) and rebinds only the path-bound closures.
 * Template roots are never handed to a caller, so clones stay fully
 * independent and mutable.
 *
 * @param {string} temp  Caller-owned temporary directory.
 * @param {string} name  Distinct fixture name.
 */
export async function createDispatchFixture(temp, name, options = {}) {
  if (options.scaffold !== true) return buildDispatchFixture(temp, name, options);
  const key = `${resolve(temp)}::${canonicalJson(options)}`;
  let template = fixtureTemplates.get(key);
  if (!template) {
    template = await buildDispatchFixture(temp, 'scaffold-template', options);
    fixtureTemplates.set(key, template);
  }
  return cloneDispatchFixture(template, temp, name);
}

const fixtureTemplates = new Map();
let fixtureCloneCounter = 0;
const dispatchTemplate = Symbol('dispatchTemplate');

async function buildDispatchFixture(temp, name, options = {}) {
  // `scaffold: true` builds the same project without any legacy activation
  // provenance: the task is authored as a plain scaffold record, exactly like a
  // project that predates activation or was created with `task new --scaffold`.
  const scaffold = options.scaffold === true;
  const taskIds = options.taskIds ?? ['T-001'];
  assert.ok(taskIds.length > 0 && new Set(taskIds).size === taskIds.length, 'dispatch fixture task IDs must be unique');
  const root = mkdtempSync(join(temp, `${name}-`));
  createTaskProjectFixture(root, { initialBranch: 'task/T-001' });
  if (typeof options.projectMapContent === 'string') {
    writeFileSync(join(root, '.agenticloop', 'project.md'), options.projectMapContent, 'utf8');
  }
  const trust = createTestHostTrust({ target: root });
  const operatorTrustRoot = join(temp, `${name}-operator-trust`);
  const trustStorePath = scaffold
    ? writeHostTrustStore(join(temp, `${name}-unused-trust`), trust)
    : writeHostTrustStore(operatorTrustRoot, trust);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'existing.js'), 'export const current = true;\n', 'utf8');
  const captures = new Map();
  const taskPaths = new Map();
  if (!scaffold) mkdirSync(join(root, '.agenticloop', 'activation'), { recursive: true });
  for (const taskId of taskIds) {
    const capturePath = `.agenticloop/activation/${taskId}.json`;
    const capture = scaffold ? null : activation(trust, DEFAULT_ACTIVATION_PAYLOAD, sha256(DEFAULT_ACTIVATION_PAYLOAD), { intendedTaskId: taskId });
    captures.set(taskId, capture);
    if (capture) writeFileSync(join(root, capturePath), JSON.stringify(capture, null, 2), 'utf8');
    const taskPath = join(root, '.agenticloop', 'tasks', `${taskId}.md`);
    taskPaths.set(taskId, taskPath);
    let body = readFileSync(join(root, 'agenticloop', 'memory', 'task-record.md'), 'utf8')
      .replaceAll('T-001', taskId)
      .replaceAll('Short Task Title', 'Dispatch envelope fixture')
      .replace('allowed_paths: []', 'allowed_paths:\n  - src/**')
      .replace('# intended_creations:', 'intended_creations:\n  - src/new.js')
      .replace(
        '- [RC-2] manual: Inspect the final state against the task acceptance criteria.',
        '- [RC-2] command: `npm run typecheck`'
      );
    for (const allowedPath of options.additionalAllowedPaths ?? []) {
      body = body.replace('  - src/**', `  - src/**\n  - ${allowedPath}`);
    }
    if (capture) {
      body = body.replace(
        'status: agent-ready',
        `status: agent-ready\nactivation_input_digest: ${capture.normalizedActivationDigest}\nactivation_capture_ref: ${capturePath}`
      );
    }
    if (typeof options.initialStatus === 'string') body = body.replace('status: agent-ready', `status: ${options.initialStatus}`);
    if (typeof options.requiredChecksText === 'string') {
      body = body.replace(
        '- [RC-1] command: `npm test`\n- [RC-2] command: `npm run typecheck`',
        options.requiredChecksText
      );
    }
    writeFileSync(taskPath, body, 'utf8');
  }
  git(root, ['add', 'src', '.agenticloop/project.md', '.agenticloop/tasks', ...(!scaffold ? ['.agenticloop/activation'] : [])]);
  git(root, ['commit', '-m', 'task fixture']);
  for (const taskId of taskIds) {
    const baseline = await runCliInProcess([
      'task', 'establish-baseline', taskId, '--actor', 'Agentic Loop Test', '--authority', `task:${taskId}`, '--target', root,
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);
  }
  git(root, ['add', '.agenticloop/task-contract-history']);
  git(root, ['commit', '-m', 'task baseline']);

  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const basePaths = git(root, ['ls-tree', '-r', '--name-only', tree]).split(/\r?\n/).filter(Boolean);
  const observedAt = new Date().toISOString();
  const dependencySource = JSON.stringify({
    kind: 'agenticloop.dependency-snapshot', schemaVersion: 1,
    source: 'files:.agenticloop/tasks', observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 }, statuses: {},
  });
  writeFileSync(join(root, 'dependencies.json'), dependencySource, 'utf8');
  git(root, ['add', 'dependencies.json']);
  git(root, ['commit', '-m', 'record dependency snapshot\n\nTask: T-001\nAgent: maintainer']);
  const [dependencyCommit, dependencyBlob] = git(root, ['rev-parse', 'HEAD', 'HEAD:dependencies.json']).split(/\r?\n/);
  const dependency = parseDependencySnapshot(dependencySource, {
    sourceRef: 'dependencies.json',
    provenance: {
      path: 'dependencies.json',
      blob: dependencyBlob,
      commit: dependencyCommit,
      role: 'maintainer',
    },
  });
  assert.equal(dependency.ok, true, dependency.errors?.join('\n'));
  const snapshots = new Map(taskIds.map(taskId => [taskId, () => {
    const current = readFileSync(taskPaths.get(taskId), 'utf8');
    const history = loadFilesTaskContractRecords(root, taskId);
    return {
      backend: 'files', taskId, carrier: `.agenticloop/tasks/${taskId}.md`, body: current,
      digest: sha256(current), trustedRecords: history.trustedRecords, trustedRecordErrors: history.errors,
    };
  }]));
  const readinessByTask = new Map();
  for (const taskId of taskIds) {
    const current = snapshots.get(taskId)();
    const ready = evaluateTaskReadiness({ taskBody: current.body, basePaths, mode: 'authoring', dependencies: {} });
    assert.equal(ready.ok, true, ready.errors.join('\n'));
    const readinessResult = canonicalReadiness(ready);
    const evidence = createTaskReadinessEvidence({
      backend: 'files', task: { id: taskId, carrier: current.carrier, expectedDigest: current.digest },
      base: {
        kind: 'git_tree', identity: `git-tree:${tree}`, inventoryDigest: sha256(canonicalJson([...basePaths].sort())),
        pathCount: basePaths.length, revalidationArgs: ['--base', tree],
      },
      dependencies: dependency.evidence, trustedRecordCount: current.trustedRecords.length, trustedRecordErrors: [],
    });
    readinessByTask.set(taskId, { evidence, result: readinessResult, resultDigest: validationResultDigest(readinessResult) });
  }
  // Decomposition completeness is derived from a real scan over the exact task
  // surface, never asserted: the fixture must prove what a caller must prove.
  const inventoryEntries = taskIds.map(taskId => ({
    carrier: `.agenticloop/tasks/${taskId}.md`, content: snapshots.get(taskId)().body, readError: null,
  }));
  const decompositions = new Map();
  mkdirSync(join(root, '.agenticloop', 'decompositions'), { recursive: true });
  for (const taskId of taskIds) {
    const decompositionSource = `.agenticloop/decompositions/${taskId}.json`;
    const readiness = readinessByTask.get(taskId);
    const scanned = evaluateParallelScan({
      workUnit: { id: options.workUnit ?? 'fixture-work-unit', backend: 'files' },
      inventory: normalizeFilesTaskInventory({
        inventoryId: 'files:.agenticloop/tasks', entries: inventoryEntries, complete: true,
        enumeration: createTaskInventoryEnumeration({
          backend: 'files', inventoryId: 'files:.agenticloop/tasks', observedAt,
          discovered: inventoryEntries.length, returned: inventoryEntries.length,
        }),
      }),
      decomposition: {
        source: 'task-decomposition', sourceRef: decompositionSource,
        revision: `git-commit:${dependencyCommit}`,
        declaredCompleteness: 'complete', attribution: 'maintainer',
      },
      observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths,
      dependencies: dependencyStatusMap(dependency.evidence),
      readinessContext: { base: readiness.evidence.base, dependencies: readiness.evidence.dependencies },
      rescanTrigger: 'ready membership, dependencies, ownership, coupling, or source revision changes',
    });
    assert.equal(scanned.ok, true, scanned.result.errors.join('\n'));
    const decomposition = createDecompositionProvenance({ taskId, scan: scanned.scan, route: 'serial', sourceRef: decompositionSource });
    decompositions.set(taskId, decomposition);
    writeFileSync(join(root, decompositionSource), JSON.stringify(decomposition, null, 2), 'utf8');
  }
  git(root, ['add', '.agenticloop/decompositions']);
  git(root, ['commit', '-m', 'record decomposition\n\nTask: T-001\nAgent: maintainer']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const repository = () => ({ worktree: resolve(root), branch: 'task/T-001', head, baseHead: head, baseTree: tree });
  const refetchParallelScanInventory = () => {
    const entries = readdirSync(join(root, '.agenticloop', 'tasks'))
      .filter(entry => entry.endsWith('.md'))
      .sort()
      .map(entry => ({
        carrier: `.agenticloop/tasks/${entry}`,
        content: readFileSync(join(root, '.agenticloop', 'tasks', entry), 'utf8'),
        readError: null,
      }));
    return normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries,
      complete: true,
      enumeration: createTaskInventoryEnumeration({
        backend: 'files',
        inventoryId: 'files:.agenticloop/tasks',
        observedAt: new Date().toISOString(),
        discovered: entries.length,
        returned: entries.length,
      }),
    });
  };
  const template = {
    root, trust, operatorTrustRoot, trustStorePath, tree, basePaths, head, observedAt,
    taskIds, captures, readinessByTask, decompositions,
  };
  return scaffold ? template : bindDispatchFixture(template, root);
}

/**
 * Byte-copy a pristine scaffold template (`.git` included) and rebind only the
 * path-bound closures. Scaffold fixtures carry no host-signed capture, so no
 * path-bound signed artifact is committed and clones are exact equivalents.
 */
function cloneDispatchFixture(template, temp, name) {
  const root = join(temp, `clone-${name}-${fixtureCloneCounter += 1}`);
  cpSync(template.root, root, { recursive: true });
  const trust = createTestHostTrust({ target: root });
  const operatorTrustRoot = join(temp, `clone-${name}-${fixtureCloneCounter}-operator-trust`);
  const trustStorePath = writeHostTrustStore(operatorTrustRoot, trust);
  return bindDispatchFixture({ ...template, trust, operatorTrustRoot, trustStorePath }, root);
}

function cloneTrust(trust) {
  return {
    ...trust,
    adapter: structuredClone(trust.adapter),
    document: structuredClone(trust.document),
    capabilities: structuredClone(trust.capabilities),
  };
}

function bindDispatchFixture(template, root) {
  const { tree, head, observedAt } = template;
  const trust = cloneTrust(template.trust);
  const operatorTrustRoot = template.operatorTrustRoot;
  const trustStorePath = template.trustStorePath;
  const basePaths = [...template.basePaths];
  const taskIds = [...template.taskIds];
  const captures = structuredClone(template.captures);
  const readinessByTask = structuredClone(template.readinessByTask);
  const decompositions = structuredClone(template.decompositions);
  const taskPaths = new Map(taskIds.map(taskId => [taskId, join(root, '.agenticloop', 'tasks', `${taskId}.md`)]));
  const snapshots = new Map(taskIds.map(taskId => [taskId, () => {
    const current = readFileSync(taskPaths.get(taskId), 'utf8');
    const history = loadFilesTaskContractRecords(root, taskId);
    return {
      backend: 'files', taskId, carrier: `.agenticloop/tasks/${taskId}.md`, body: current,
      digest: sha256(current), trustedRecords: history.trustedRecords, trustedRecordErrors: history.errors,
    };
  }]));
  const repository = () => ({ worktree: resolve(root), branch: 'task/T-001', head, baseHead: head, baseTree: tree });
  const refetchParallelScanInventory = () => {
    const entries = readdirSync(join(root, '.agenticloop', 'tasks'))
      .filter(entry => entry.endsWith('.md'))
      .sort()
      .map(entry => ({
        carrier: `.agenticloop/tasks/${entry}`,
        content: readFileSync(join(root, '.agenticloop', 'tasks', entry), 'utf8'),
        readError: null,
      }));
    return normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries,
      complete: true,
      enumeration: createTaskInventoryEnumeration({
        backend: 'files',
        inventoryId: 'files:.agenticloop/tasks',
        observedAt: new Date().toISOString(),
        discovered: entries.length,
        returned: entries.length,
      }),
    });
  };
  const common = {
    root, trust, operatorTrustRoot, trustStorePath, options: {
      capabilities: trust.capabilities,
      returnAdapter: { adapterId: trust.adapterId, keyId: trust.keyId, capability: 'returnReceipt' },
    },
    repository, refetchRepository: repository,
    runGit: gitRunner(root),
    priorGateReceipts: [],
    refetchParallelScanInventory,
  };
  const taskFixtures = new Map(taskIds.map(taskId => {
    const decompositionSource = `.agenticloop/decompositions/${taskId}.json`;
    const decomposition = decompositions.get(taskId);
    const readiness = readinessByTask.get(taskId);
    const assignment = {
      roleId: 'engineer', host: 'opencode', hostRoleCapability: getHostRoleCapability('opencode', 'engineer'),
      worktree: resolve(root), branch: 'task/T-001', invocationId: `invocation:${randomUUID()}`,
      requiredCapabilities: ['implementation_mutation'],
      canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/files.md'],
      attribution: { taskTrailer: `Task: ${taskId}`, agentTrailer: 'Agent: engineer' },
      liveness: { cadence: 'return after each check', expiry: new Date(Date.now() + 3_600_000).toISOString(), stopCondition: 'return on blocker' },
      cancellationBoundary: 'return_on_cancellation',
    };
    const snapshot = snapshots.get(taskId);
    return [taskId, {
      ...common, taskPath: taskPaths.get(taskId), activation: captures.get(taskId), snapshot, refetchTask: snapshot,
      readiness, refetchReadiness: () => readiness, decomposition,
      legacyDecomposition: legacyDecompositionProvenance(taskId, observedAt, decompositionSource),
      refetchDecomposition: () => decomposition, assignment,
    }];
  }));
  const primary = taskFixtures.get(taskIds[0]);
  const fixture = { ...primary, taskFixtures };
  Object.defineProperty(fixture, dispatchTemplate, { value: template });
  return fixture;
}

function ownedPath(temp, path) {
  const owner = resolve(temp);
  const target = resolve(path);
  const rel = relative(owner, target);
  assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'), `fixture path must be below caller temp root: ${target}`);
  return target;
}

/**
 * Snapshot and reset one capture-bound fixture at the exact signed path.
 * Callers must use the returned fixture anew after every reset so no mutated
 * closures, maps, or evidence objects survive between serial tests.
 */
export async function createResettableDispatchFixture(temp, name, options = {}, { resetPaths = [] } = {}) {
  const initial = await buildDispatchFixture(temp, name, options);
  const template = initial[dispatchTemplate];
  const livePaths = [initial.root, initial.operatorTrustRoot, ...resetPaths]
    .map(path => ownedPath(temp, path));
  const snapshotRoot = mkdtempSync(join(temp, '.dispatch-snapshot-'));
  const snapshotSets = new Map();
  let snapshotCounter = 0;
  const capture = (label, { gitRestore = false } = {}) => {
    if (gitRestore) {
      assert.equal(
        git(initial.root, ['status', '--porcelain', '--untracked-files=all']),
        '',
        `gitRestore checkpoint "${label}" requires a clean committed worktree`
      );
    }
    const directory = join(snapshotRoot, String(snapshotCounter += 1));
    const entries = livePaths.map((path, index) => {
      const snapshot = join(directory, String(index));
      const present = existsSync(path);
      if (present) cpSync(path, snapshot, { recursive: true });
      return { path, snapshot, present };
    });
    const gitHead = gitRestore ? git(initial.root, ['rev-parse', 'HEAD']) : null;
    const gitTree = gitRestore ? git(initial.root, ['rev-parse', 'HEAD^{tree}']) : null;
    const extraFiles = gitRestore
      ? [...new Set([
          ...git(initial.root, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/),
          ...git(initial.root, ['ls-files', '--others', '--ignored', '--exclude-standard']).split(/\r?\n/),
        ].filter(Boolean))]
      : [];
    const externalPaths = livePaths.filter(path => path !== initial.root);
    const liveState = gitRestore
      ? sha256(canonicalJson(externalPaths.map(path => ({ path, state: filesystemState(path) }))))
      : null;
    snapshotSets.set(label, { entries, gitHead, gitTree, extraFiles, liveState });
  };
  capture('initial', { gitRestore: true });
  let pristine = initial;

  return {
    root: initial.root,
    repositoryIdentity: initial.trust.repositoryIdentity,
    hasCheckpoint(label) {
      return snapshotSets.has(label);
    },
    checkpoint(label, options) {
      assert.ok(typeof label === 'string' && label, 'fixture checkpoint label is required');
      capture(label, options);
    },
    take(label = 'initial') {
      if (pristine && label === 'initial') {
        const fixture = pristine;
        pristine = null;
        return fixture;
      }
      const snapshotSet = snapshotSets.get(label);
      assert.ok(snapshotSet, `unknown fixture checkpoint: ${label}`);
      for (const entry of snapshotSet.entries) {
        ownedPath(temp, entry.path);
        if (entry.path === initial.root && snapshotSet.gitHead) {
          git(initial.root, ['reset', '--mixed', snapshotSet.gitHead]);
          git(initial.root, ['checkout-index', '-a', '-f']);
          git(initial.root, ['clean', '-fdx']);
          for (const extraFile of snapshotSet.extraFiles) {
            const source = join(entry.snapshot, ...extraFile.split('/'));
            const destination = ownedPath(initial.root, join(initial.root, ...extraFile.split('/')));
            mkdirSync(dirname(destination), { recursive: true });
            cpSync(source, destination, { recursive: true });
          }
          continue;
        }
        rmSync(entry.path, { recursive: true, force: true });
        if (entry.present) cpSync(entry.snapshot, entry.path, { recursive: true });
      }
      if (snapshotSet.gitHead) {
        assert.equal(git(initial.root, ['status', '--porcelain', '--untracked-files=all']), '', `restored checkpoint "${label}" must be clean`);
        assert.equal(git(initial.root, ['rev-parse', 'HEAD']), snapshotSet.gitHead, `restored checkpoint "${label}" must reproduce HEAD`);
        assert.equal(git(initial.root, ['rev-parse', 'HEAD^{tree}']), snapshotSet.gitTree, `restored checkpoint "${label}" must reproduce its tree`);
        assert.equal(
          sha256(canonicalJson(livePaths.filter(path => path !== initial.root).map(path => ({ path, state: filesystemState(path) })))),
          snapshotSet.liveState,
          `restored checkpoint "${label}" must reproduce external fixture state`
        );
      }
      return bindDispatchFixture(template, initial.root);
    },
  };
}

/** Pool same-path fixtures across serial tests while allowing several leases in one test. */
export function createResettableDispatchFixturePool() {
  const entriesByKey = new Map();
  const leased = new Set();
  const controllersByRoot = new Map();
  return {
    async acquire(temp, name, options = {}, resetOptions = {}) {
      const key = `${resolve(temp)}::${canonicalJson(options)}::${canonicalJson(resetOptions.resetPaths ?? [])}::${canonicalJson(resetOptions.cacheKey ?? null)}`;
      const entries = entriesByKey.get(key) ?? [];
      const preferredCheckpoint = resetOptions.preferredCheckpoint;
      let entry = entries.find(candidate => !leased.has(candidate) && preferredCheckpoint && candidate.hasCheckpoint(preferredCheckpoint));
      entry ??= entries.find(candidate => !leased.has(candidate));
      if (!entry) {
        entry = await createResettableDispatchFixture(temp, `${name}-pool-${entries.length}`, options, resetOptions);
        entries.push(entry);
        entriesByKey.set(key, entries);
        controllersByRoot.set(entry.root, entry);
      }
      leased.add(entry);
      return entry.take(preferredCheckpoint && entry.hasCheckpoint(preferredCheckpoint) ? preferredCheckpoint : 'initial');
    },
    hasCheckpoint(target, label) {
      return controllersByRoot.get(target)?.hasCheckpoint(label) ?? false;
    },
    checkpoint(target, label, options) {
      const controller = controllersByRoot.get(target);
      assert.ok(controller, `no resettable fixture owns ${target}`);
      controller.checkpoint(label, options);
    },
    restore(target, label) {
      const controller = controllersByRoot.get(target);
      assert.ok(controller, `no resettable fixture owns ${target}`);
      return controller.take(label);
    },
    releaseAll() {
      leased.clear();
    },
  };
}

/**
 * Base evidence for an exact Git tree, in the canonical readiness-evidence
 * shape a scan binds. Shared so no test re-derives the base inventory digest.
 */
export function gitTreeBaseEvidence(root, treeish = 'HEAD') {
  const treeOid = git(root, ['rev-parse', `${treeish}^{tree}`]);
  const paths = git(root, ['ls-tree', '-r', '--name-only', treeOid]).split(/\r?\n/).filter(Boolean);
  return {
    paths,
    evidence: {
      kind: 'git_tree',
      identity: `git-tree:${treeOid}`,
      inventoryDigest: sha256(canonicalJson([...paths].sort())),
      pathCount: paths.length,
      revalidationArgs: ['--base', treeOid],
    },
  };
}

/** A files inventory with the typed receipt its authoritative enumerator issues. */
export function filesScanInventory(inventoryId, entries, observedAt = new Date().toISOString()) {
  return normalizeFilesTaskInventory({
    inventoryId,
    entries,
    complete: true,
    enumeration: createTaskInventoryEnumeration({
      backend: 'files', inventoryId, observedAt, discovered: entries.length, returned: entries.length,
    }),
  });
}

/** Prepare through the fixture's injected capability inventory. */
export function prepare(fixture, patch = {}) {
  return prepareRoleDispatch({ ...fixture, ...patch }, fixture.options);
}

export function repositoryEvidence(packet, { head = FULL_SHA_B, changedPaths = ['src/existing.js'], checks = null, pr = null } = {}) {
  const checked = checks ?? [
    { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 0, evidence: '1 passing' },
    { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, evidence: 'no errors' },
  ];
  return {
    backend: packet.backend,
    task: {
      id: packet.task.id,
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      currentCarrierDigest: packet.task.dispatchCarrierDigest,
    },
    worktree: packet.assignment.worktree,
    branch: packet.assignment.branch,
    productBaseHead: packet.repository.head,
    productLineage: null,
    productHead: head,
    workflowHead: head,
    candidateHead: null,
    productChangedPaths: changedPaths,
    workflowChangedPaths: [],
    productAttribution: { range: { base: packet.repository.head, head }, commits: [FULL_SHA_B] },
    checks: checked,
    carrierLineage: {
      dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}`,
      evidenceMutationReceiptDigests: [],
    },
    pr: pr ?? { state: 'not_applicable', number: null, url: null },
  };
}

/**
 * Build the raw producer receipt plus the explicitly trusted resolver the
 * receive boundary consumes. Authentication itself happens inside
 * `receiveRoleReturn`; this helper only supplies fixture trust material.
 */
export function producerBinding(trust, packet, roleReturn, evidence, receiptPatch = {}) {
  const producerReceipt = {
    ...createHostHandoffReceipt({
      adapterId: trust.adapterId,
      keyId: trust.keyId,
      packet,
      roleReturn,
      observedProducerRole: packet.assignment.roleId,
      repositoryEvidence: evidence,
    }, trust.privateKey),
    ...receiptPatch,
  };
  return { producerReceipt, resolveTrustedAdapter: () => trust.adapter };
}

export function readyReturn(packet, evidence = repositoryEvidence(packet)) {
  return createRoleReturn({
    producerRole: 'engineer', packet: { packetId: packet.packetId, digest: packet.digest },
    task: { backend: packet.backend, id: packet.task.id, ...evidence.task },
    worktree: evidence.worktree, branch: evidence.branch,
    productBaseHead: evidence.productBaseHead, productLineage: evidence.productLineage ?? null,
    productHead: evidence.productHead,
    workflowHead: evidence.workflowHead, candidateHead: evidence.candidateHead,
    productChangedPaths: evidence.productChangedPaths, workflowChangedPaths: evidence.workflowChangedPaths,
    checks: withExecutionEvidence(evidence.checks), productAttribution: evidence.productAttribution, pr: evidence.pr,
    carrierLineage: evidence.carrierLineage,
    outcome: { kind: 'implementation_ready_for_review', completion: false, authority: 'non_authoritative_role_outcome' },
    disposition: 'proceed', blocker: null, freshness: { invalidatedBy: [...RETURN_INVALIDATORS] },
  });
}
