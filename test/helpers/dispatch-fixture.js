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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
import { createTaskReadinessEvidence, parseDependencySnapshot } from '../../src/task-evidence-contract.js';
import { evaluateTaskReadiness } from '../../src/task-readiness.js';
import { loadFilesTaskContractRecords } from '../../src/files-task-contract.js';
import { createTaskProjectFixture } from './task-fixture.js';
import { createTestHostTrust, writeHostTrustStore } from './host-trust-fixture.js';
import { runCliInProcess } from './run-cli.js';

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

export function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function gitRunner(cwd) {
  return args => spawnSync('git', args, { cwd, encoding: 'utf8' });
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
 * @param {string} temp  Caller-owned temporary directory.
 * @param {string} name  Distinct fixture name.
 */
export async function createDispatchFixture(temp, name, options = {}) {
  // `scaffold: true` builds the same project without any legacy activation
  // provenance: the task is authored as a plain scaffold record, exactly like a
  // project that predates activation or was created with `task new --scaffold`.
  const scaffold = options.scaffold === true;
  const taskIds = options.taskIds ?? ['T-001'];
  assert.ok(taskIds.length > 0 && new Set(taskIds).size === taskIds.length, 'dispatch fixture task IDs must be unique');
  const root = mkdtempSync(join(temp, `${name}-`));
  createTaskProjectFixture(root);
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
  git(root, ['add', 'src', '.agenticloop/tasks', ...(!scaffold ? ['.agenticloop/activation'] : [])]);
  git(root, ['commit', '-m', 'task fixture']);
  git(root, ['branch', '-M', 'task/T-001']);
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
  const dependencyCommit = git(root, ['rev-parse', 'HEAD']);
  const dependencyBlob = git(root, ['rev-parse', 'HEAD:dependencies.json']);
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
        revision: `git-commit:${git(root, ['rev-parse', 'HEAD'])}`,
        declaredCompleteness: 'complete', attribution: 'maintainer',
      },
      observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths,
      dependencies: {},
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
      .filter(name => name.endsWith('.md'))
      .sort()
      .map(name => ({
        carrier: `.agenticloop/tasks/${name}`,
        content: readFileSync(join(root, '.agenticloop', 'tasks', name), 'utf8'),
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
  return { ...primary, taskFixtures };
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
    task: { id: packet.task.id, digest: packet.task.digest },
    worktree: packet.assignment.worktree,
    branch: packet.assignment.branch,
    baseHead: packet.repository.head,
    head,
    changedPaths,
    attribution: { range: { base: packet.repository.head, head }, commits: [FULL_SHA_B] },
    checks: checked,
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
    task: { backend: packet.backend, id: packet.task.id, digest: packet.task.digest },
    worktree: evidence.worktree, branch: evidence.branch, head: evidence.head, baseHead: evidence.baseHead,
    changedPaths: evidence.changedPaths, checks: evidence.checks, attribution: evidence.attribution, pr: evidence.pr,
    outcome: { kind: 'implementation_ready_for_review', completion: false, authority: 'non_authoritative_role_outcome' },
    disposition: 'proceed', blocker: null, freshness: { invalidatedBy: [...RETURN_INVALIDATORS] },
  });
}
