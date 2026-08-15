import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, canonicalSha256 } from '../src/canonical-json.js';
import {
  DECOMPOSITION_BINDING_KIND,
  DECOMPOSITION_SCHEMA_VERSION,
  DISPATCH_PREPARATION_SCHEMA_VERSION,
  createDecompositionProvenance,
  prepareDecompositionSource,
} from '../src/dispatch-envelope.js';
import { createResettableDispatchFixturePool, git, gitTreeBaseEvidence, prepare } from './helpers/dispatch-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { COMMAND_REGISTRY } from '../src/cli-registry.js';
import { verifyCommittedAttributedSource } from '../src/committed-source.js';
import {
  PARALLEL_SCAN_CONCLUSIONS,
  PARALLEL_SCAN_DIGEST_DOMAIN,
  PARALLEL_SCAN_EXCLUSION_REASONS,
  PARALLEL_SCAN_KIND,
  PARALLEL_SCAN_MAX_FRESHNESS_SECONDS,
  PARALLEL_SCAN_READINESS_DIGEST_DOMAIN,
  PARALLEL_SCAN_SCHEMA_VERSION,
  PARALLEL_SCAN_SEMANTIC_DIGEST_DOMAIN,
  createTaskInventoryEnumeration,
  evaluateParallelScan,
  normalizeFilesTaskInventory,
  normalizeGitHubTaskInventory,
  parseCanonicalInstant,
  validateParallelScanInventoryBinding,
  validateParallelScanReadinessBinding,
  validateParallelScanRecord,
  validateTaskInventoryEnumeration,
} from '../src/parallel-scan.js';
import { createTaskReadinessEvidence, parseDependencySnapshot } from '../src/task-evidence-contract.js';
import { buildGitHubTaskIdentityInventory } from '../src/github-task-identity.js';
import { evaluateTaskReadiness } from '../src/task-readiness.js';
import { createValidationResult, validationResultDigest } from '../src/result-envelope.js';
import {
  createTaskContractBaselineRecord,
  renderTaskContractRecord,
  taskContractDigest,
} from '../src/task-contract-baseline.js';

const TEMPLATE = readFileSync(fileURLToPath(new URL('../memory/task-record.md', import.meta.url)), 'utf8');
const OBSERVED_AT = '2026-08-07T10:00:00.000Z';
const NOW = Date.parse(OBSERVED_AT) + 60_000;
const BASE_PATHS = ['src/existing.js'];
const fixturePool = createResettableDispatchFixturePool();

async function createDispatchFixture(temp, name, options = {}) {
  return fixturePool.acquire(temp, name, options);
}

afterEach(() => fixturePool.releaseAll());

function taskBody({
  taskId,
  ownedPaths = ['src/lane-a/**'],
  allowedPaths = ownedPaths,
  sharedMutations = null,
  eligibility = 'eligible',
  knowledge = 'independent',
  dependsOn = [],
  status = 'agent-ready',
} = {}) {
  const frontmatterExtras = [
    'allowed_paths:',
    ...allowedPaths.map(path => `  - ${path}`),
    'owned_paths:',
    ...ownedPaths.map(path => `  - ${path}`),
    ...(sharedMutations
      ? ['shared_mutations:', ...sharedMutations.flatMap(item => [
        `  ${item.path}:`,
        `    operation: ${item.operation}`,
        `    target: ${item.target}`,
      ])]
      : []),
    ...(dependsOn.length ? ['depends_on:', ...dependsOn.map(id => `  - ${id}`)] : []),
  ].join('\n');
  return TEMPLATE
    .replace('task_id: T-001', `task_id: ${taskId}`)
    .replace('status: agent-ready', `status: ${status}`)
    .replace('allowed_paths: []', frontmatterExtras)
    .replace('- Parallel eligibility: eligible | blocked | unknown', `- **Parallel eligibility**: ${eligibility}`)
    .replace('- Knowledge coupling: independent | coupled | unknown', `- **Knowledge coupling**: ${knowledge}`);
}

function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** The authoritative enumerator's typed receipt for a files inventory. */
function filesEnumeration(inventoryId, count, patch = {}) {
  return createTaskInventoryEnumeration({
    backend: 'files',
    inventoryId,
    observedAt: OBSERVED_AT,
    discovered: count,
    returned: count,
    ...patch,
  });
}

function githubEnumeration(inventoryId, count, patch = {}) {
  return createTaskInventoryEnumeration({
    backend: 'github',
    inventoryId,
    observedAt: OBSERVED_AT,
    discovered: count,
    returned: count,
    ...patch,
  });
}

const BASE_EVIDENCE = Object.freeze({
  kind: 'path_inventory',
  identity: 'path-inventory:base-paths.json',
  inventoryDigest: digestOf(canonicalJson([...BASE_PATHS].sort())),
  pathCount: BASE_PATHS.length,
  revalidationArgs: ['--base-paths', 'base-paths.json'],
});

/** Canonical dependency evidence built through the existing snapshot parser. */
function dependencyEvidence(statuses = {}, { observedAt = OBSERVED_AT, now = NOW } = {}) {
  const parsed = parseDependencySnapshot(JSON.stringify({
    kind: 'agenticloop.dependency-snapshot',
    schemaVersion: 1,
    source: 'files:.agenticloop/dependencies.json',
    observedAt,
    freshnessPolicy: { maxAgeSeconds: 3600 },
    statuses,
  }), { sourceRef: 'dependencies.json', now });
  assert.equal(parsed.ok, true, parsed.errors?.join('\n'));
  return parsed.evidence;
}

/** Re-derive the bound readiness-context digest after editing the context. */
function rehashReadinessContext(scan) {
  const { base, dependencies, observation } = scan.readinessContext;
  scan.readinessContext.digest =
    `sha256:${PARALLEL_SCAN_READINESS_DIGEST_DOMAIN}:${canonicalSha256({ base, dependencies, observation })}`;
  return scan;
}

/** The exact base-path inventory the fixture's bound base evidence identifies. */
function fixtureBasePaths(fixture) {
  return gitTreeBaseEvidence(
    fixture.root,
    fixture.readiness.evidence.base.identity.slice('git-tree:'.length),
  ).paths;
}

function safeDigest(value) {
  try {
    return canonicalSha256(value);
  } catch {
    return 'uncanonicalizable';
  }
}

/**
 * Re-sign an edited record exactly the way the module signs its own, so a
 * tampered record is refused on its invariants rather than merely on a stale
 * digest. Total, because adversarial fixtures are deliberately ill-typed.
 */
function rehashScan(scan) {
  const semantic = {
    workUnitId: scan.workUnit?.id ?? null,
    readyTaskIds: scan.readyTaskIds,
    readyCount: scan.readyCount,
    excluded: (Array.isArray(scan.excluded) ? scan.excluded : []).map(item => ({
      taskId: item?.taskId ?? null,
      reasonCode: item?.reasonCode ?? null,
      evidenceState: item?.evidenceState ?? null,
    })),
    eligibility: scan.eligibility,
    knowledgeCoupling: scan.knowledgeCoupling,
    couplingBlockers: scan.couplingBlockers,
    pairs: scan.pairs,
    candidatePairs: scan.candidatePairs,
    inventoryComplete: scan.inventory?.complete ?? null,
    decompositionState: scan.decomposition?.state ?? null,
    readinessContextDigest: scan.readinessContext?.digest ?? null,
    conclusion: scan.conclusion,
  };
  scan.semanticDigest = `sha256:${PARALLEL_SCAN_SEMANTIC_DIGEST_DOMAIN}:${safeDigest(semantic)}`;
  const { digest, semanticDigest, ...projection } = scan;
  scan.digest = `sha256:${PARALLEL_SCAN_DIGEST_DOMAIN}:${safeDigest(projection)}`;
  return scan;
}

function filesEntries(tasks) {
  return tasks.map(task => ({
    carrier: `.agenticloop/tasks/${task.carrierId ?? task.taskId}.md`,
    content: task.content ?? taskBody(task),
    readError: task.readError ?? null,
  }));
}

function scanInput({
  inventory,
  declaredCompleteness = 'complete',
  dependencies = {},
  joinPlans = {},
  laneArtifacts = {},
  observedAt = OBSERVED_AT,
  maxAgeSeconds = 3600,
  backend = 'files',
  readinessContext,
} = {}) {
  return {
    workUnit: { id: 'milestone-alpha', backend },
    inventory,
    decomposition: {
      source: 'task-decomposition',
      sourceRef: '.agenticloop/decompositions/milestone-alpha.json',
      revision: `git-blob:${'a'.repeat(40)}`,
      declaredCompleteness,
      attribution: 'maintainer',
    },
    observedAt,
    freshnessPolicy: { maxAgeSeconds },
    basePaths: BASE_PATHS,
    dependencies,
    readinessContext: readinessContext ?? {
      base: BASE_EVIDENCE,
      dependencies: dependencyEvidence(dependencies),
    },
    joinPlans,
    laneArtifacts,
    rescanTrigger: 'ready membership, dependencies, ownership, coupling, or source revision changes',
  };
}

function filesInventory(tasks, patch = {}) {
  const entries = filesEntries(tasks);
  const declared = patch.complete !== false;
  const scanInstant = parseCanonicalInstant(patch.observedAt, { now: NOW, futureAllowed: true });
  return normalizeFilesTaskInventory({
    inventoryId: 'files:.agenticloop/tasks',
    entries,
    complete: declared,
    // Completeness is only provable by the authoritative enumerator: a scan
    // that cannot show an exhaustive receipt is incomplete regardless of what
    // its caller declared.
    enumeration: declared
      ? filesEnumeration('files:.agenticloop/tasks', entries.length, {
          observedAt: scanInstant.ok ? patch.observedAt : OBSERVED_AT,
          ...(patch.enumeration ?? {}),
        })
      : (patch.enumeration ?? null),
  }, { now: NOW });
}

function filesScan(tasks, patch = {}) {
  return evaluateParallelScan(scanInput({ inventory: filesInventory(tasks, patch), ...patch }), { now: NOW });
}

describe('normalized backend inventories', () => {
  it('records exact carrier identity and digest for every files task', () => {
    const entries = filesEntries([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]);
    const inventory = normalizeFilesTaskInventory({
      inventoryId: 'files:tasks', entries, complete: true,
      enumeration: filesEnumeration('files:tasks', entries.length),
    }, { now: NOW });
    assert.equal(inventory.complete, true);
    assert.equal(inventory.enumeration.completion, 'exhaustive');
    assert.deepEqual(inventory.members.map(item => item.taskId), ['T-001', 'T-002']);
    assert.equal(inventory.members[0].carrier, '.agenticloop/tasks/T-001.md');
    assert.equal(inventory.members[0].digest, digestOf(entries[0].content));
    assert.equal(inventory.members[0].state, 'readable');
  });

  it('keeps an unreadable candidate record as an inventory member', () => {
    const inventory = normalizeFilesTaskInventory({
      inventoryId: 'files:tasks',
      entries: [{ carrier: '.agenticloop/tasks/T-009.md', content: null, readError: 'EACCES' }],
      complete: true,
      enumeration: filesEnumeration('files:tasks', 1),
    }, { now: NOW });
    assert.equal(inventory.members.length, 1);
    assert.equal(inventory.members[0].state, 'unreadable');
    assert.equal(inventory.members[0].carrier, '.agenticloop/tasks/T-009.md');
    assert.equal(inventory.members[0].identitySource, 'carrier');
  });

  it('normalizes a GitHub inventory into the same shared member shape', () => {
    const issues = [
      { number: 11, state: 'OPEN', title: 'T-001 lane a', labels: [{ name: 'task:T-001' }], body: taskBody({ taskId: 'T-001' }) },
      { number: 12, state: 'OPEN', title: 'T-002 lane b', labels: [{ name: 'task:T-002' }], body: taskBody({ taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }) },
    ];
    const inventory = normalizeGitHubTaskInventory({
      inventoryId: 'github:owner/repo',
      inventory: { ...buildGitHubTaskIdentityInventory(issues, { complete: true }), issues },
      enumeration: githubEnumeration('github:owner/repo', issues.length, { pageCount: 2 }),
    }, { now: NOW });
    assert.equal(inventory.complete, true);
    assert.deepEqual(inventory.members.map(item => item.taskId), ['T-001', 'T-002']);
    assert.equal(inventory.members[0].transport.issueNumber, 11);
    assert.equal(inventory.members[0].digest, digestOf(issues[0].body));
  });

  it('marks a truncated GitHub inventory incomplete', () => {
    const issues = [{ number: 11, state: 'OPEN', title: 'T-001', labels: [], body: taskBody({ taskId: 'T-001' }) }];
    const inventory = normalizeGitHubTaskInventory({
      inventoryId: 'github:owner/repo',
      inventory: { ...buildGitHubTaskIdentityInventory(issues, { complete: false }), issues },
      enumeration: githubEnumeration('github:owner/repo', issues.length, {
        discovered: 5, returned: 1, pageCount: 1, truncated: true, cursor: 'cursor:page-2',
      }),
    }, { now: NOW });
    assert.equal(inventory.complete, false);
    assert.ok(inventory.errors.length > 0);
  });

  it('retains an invalid GitHub issue identity as unreadable inventory evidence', () => {
    // Dropping the issue would turn a real carrier on the task surface into an
    // invisible one, which is exactly what makes a partial inventory dangerous.
    const issues = [
      { number: 11, state: 'OPEN', title: 'T-001', labels: [], body: taskBody({ taskId: 'T-001' }) },
      { number: 'not-a-number', state: 'OPEN', title: 'broken', labels: [], body: taskBody({ taskId: 'T-002' }) },
    ];
    const inventory = normalizeGitHubTaskInventory({
      inventoryId: 'github:owner/repo',
      inventory: { ...buildGitHubTaskIdentityInventory(issues, { complete: true }), issues },
      enumeration: githubEnumeration('github:owner/repo', 2),
    }, { now: NOW });
    assert.equal(inventory.members.length, 2);
    const unreadable = inventory.members.find(member => member.state === 'unreadable');
    assert.ok(unreadable, 'the invalid issue identity must remain an inventory member');
    assert.match(unreadable.carrier, /^issue:unreadable:/);
    assert.ok(inventory.errors.some(error => /no valid issue identity/.test(error)));
  });
});

describe('inventory completeness is authoritative, not asserted', () => {
  const entries = filesEntries([{ taskId: 'T-001' }]);
  const enumeration = filesEnumeration('files:.agenticloop/tasks', 1);

  for (const [label, declared] of [
    ['omitted', undefined],
    ['null', null],
    ['zero', 0],
    ['empty string', ''],
    ['an arbitrary string', 'yes'],
    ['an object', {}],
    ['false', false],
  ]) {
    it(`never derives completeness from a ${label} completeness input`, () => {
      const inventory = normalizeFilesTaskInventory({
        inventoryId: 'files:.agenticloop/tasks', entries, complete: declared, enumeration,
      }, { now: NOW });
      assert.equal(inventory.complete, false);
      assert.ok(inventory.errors.some(error => /exact boolean true/.test(error)));
    });
  }

  it('requires a typed enumeration receipt in addition to an exact true', () => {
    const withoutReceipt = normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks', entries, complete: true, enumeration: null,
    }, { now: NOW });
    assert.equal(withoutReceipt.complete, false);
    const withReceipt = normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks', entries, complete: true, enumeration,
    }, { now: NOW });
    assert.equal(withReceipt.complete, true);
  });

  it('rejects an enumeration receipt that does not cover this exact surface', () => {
    const wrongSurface = normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries,
      complete: true,
      enumeration: filesEnumeration('files:some/other/dir', 1),
    }, { now: NOW });
    assert.equal(wrongSurface.complete, false);
    const wrongCount = normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries,
      complete: true,
      enumeration: filesEnumeration('files:.agenticloop/tasks', 7),
    }, { now: NOW });
    assert.equal(wrongCount.complete, false);
  });

  it('refuses to call a truncated or cursor-bearing enumeration exhaustive', () => {
    const truncated = validateTaskInventoryEnumeration({
      kind: 'agenticloop.task-inventory-enumeration',
      schemaVersion: 1,
      backend: 'files',
      enumerator: 'agenticloop.files-task-directory.v1',
      inventoryId: 'files:.agenticloop/tasks',
      observedAt: OBSERVED_AT,
      coverage: { discovered: 3, returned: 1, pageCount: 1, truncated: true, cursor: 'next' },
      completion: 'exhaustive',
    }, { backend: 'files', inventoryId: 'files:.agenticloop/tasks', now: NOW });
    assert.equal(truncated.ok, false);
    assert.ok(truncated.errors.some(error => /truncated enumeration cannot be exhaustive/.test(error)));
    assert.ok(truncated.errors.some(error => /unfollowed pagination cursor/.test(error)));
  });

  it('never lets a caller-authored subset reach an eligibility conclusion', () => {
    const subset = filesScan([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }], {
      complete: true,
      enumeration: { discovered: 9, returned: 2, truncated: true, cursor: 'cursor:next' },
    });
    assert.equal(subset.ok, false);
    assert.equal(subset.scan.conclusion, 'incomplete');
    assert.ok(!['no_eligible_work', 'not_currently_eligible', 'parallel_candidates'].includes(subset.scan.conclusion));
  });
});

describe('inventory completeness and accounting', () => {
  it('accounts for every inventory member exactly once', () => {
    const { scan } = filesScan([
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
      { taskId: 'T-003', ownedPaths: ['src/lane-c/**'], eligibility: 'blocked' },
    ]);
    const accounted = [...scan.readyTaskIds, ...scan.excluded.map(item => item.taskId)].sort();
    assert.deepEqual(accounted, ['T-001', 'T-002', 'T-003']);
    assert.equal(new Set(accounted).size, accounted.length);
    assert.equal(scan.inventory.memberCount, 3);
  });

  it('distinguishes a complete inventory with zero ready tasks from an incomplete one', () => {
    const noWork = filesScan([
      { taskId: 'T-001', status: 'done', eligibility: 'blocked' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'], dependsOn: ['T-001'] },
    ], { dependencies: { 'T-001': 'unresolved' } });
    assert.equal(noWork.scan.conclusion, 'no_eligible_work');
    assert.equal(noWork.scan.readyTaskIds.length, 0);
    assert.equal(noWork.scan.inventory.complete, true);
    assert.equal(noWork.ok, true, noWork.result.errors.join('\n'));

    const truncated = filesScan([{ taskId: 'T-001', dependsOn: ['T-000'] }], {
      complete: false,
      dependencies: { 'T-000': 'unresolved' },
    });
    assert.equal(truncated.scan.conclusion, 'incomplete');
    assert.notEqual(truncated.scan.conclusion, 'no_eligible_work');
    assert.equal(truncated.ok, false);
  });

  it('gives every exclusion a stable reason code, evidence state, and evidence reference', () => {
    const { scan } = filesScan([
      { taskId: 'T-001', ownedPaths: ['src/lane-a/**'], dependsOn: ['T-000'] },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ], { dependencies: { 'T-000': 'unresolved' } });
    const excluded = scan.excluded.find(item => item.taskId === 'T-001');
    assert.equal(excluded.reasonCode, 'dependency_unresolved');
    assert.ok(PARALLEL_SCAN_EXCLUSION_REASONS.includes(excluded.reasonCode));
    assert.equal(excluded.evidenceState, 'negative');
    assert.equal(excluded.evidenceRef, '.agenticloop/tasks/T-001.md');
    assert.equal(excluded.carrierDigest, digestOf(taskBody({ taskId: 'T-001', ownedPaths: ['src/lane-a/**'], dependsOn: ['T-000'] })));
  });

  it('keeps a malformed record accounted for and fails completeness closed', () => {
    const result = filesScan([
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
      { taskId: 'T-BAD', carrierId: 'T-BAD', content: '---\nnot: [valid\n---\n# broken\n' },
    ]);
    const excluded = result.scan.excluded.find(item => item.evidenceRef === '.agenticloop/tasks/T-BAD.md');
    assert.ok(excluded, 'malformed record must remain an accounted inventory member');
    assert.equal(excluded.reasonCode, 'record_malformed');
    assert.equal(result.scan.inventory.complete, false);
    assert.equal(result.scan.conclusion, 'incomplete');
    assert.equal(result.ok, false);
  });

  it('fails closed on duplicate or ambiguous task identity', () => {
    const result = filesScan([
      { taskId: 'T-001', carrierId: 'T-001' },
      { taskId: 'T-001', carrierId: 'T-001-copy', ownedPaths: ['src/lane-b/**'] },
    ]);
    assert.equal(result.scan.conclusion, 'incomplete');
    assert.equal(result.ok, false);
    assert.ok(result.result.errors.join('\n').includes('T-001'));
    assert.ok(result.scan.excluded.some(item => item.reasonCode === 'identity_ambiguous'));
  });

  it('refuses a caller-declared complete token over derived incompleteness', () => {
    const result = filesScan([{ taskId: 'T-001' }], { complete: false, declaredCompleteness: 'complete' });
    assert.equal(result.scan.inventory.complete, false);
    assert.equal(result.scan.conclusion, 'incomplete');
    assert.equal(result.ok, false);
  });

  it('honours a caller-declared incomplete decomposition even with a clean inventory', () => {
    const result = filesScan([
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ], { declaredCompleteness: 'incomplete' });
    assert.equal(result.scan.conclusion, 'incomplete');
    assert.equal(result.scan.decomposition.state, 'incomplete');
  });

  it('treats a scan observed outside its freshness policy as stale and incomplete', () => {
    const result = filesScan([
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ], { maxAgeSeconds: 1 });
    assert.equal(result.scan.conclusion, 'incomplete');
    assert.equal(result.result.evidenceState, 'stale');
  });
});

describe('scan conclusions', () => {
  it('reports the exact ready count and a rescan trigger for a single ready task', () => {
    const result = filesScan([
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'], dependsOn: ['T-000'] },
    ], { dependencies: { 'T-000': 'unresolved' } });
    assert.equal(result.scan.conclusion, 'not_currently_eligible');
    assert.equal(result.scan.readyCount, 1);
    assert.ok(result.scan.rescanTrigger.length > 0);
    assert.equal(result.ok, true, result.result.errors.join('\n'));
  });

  it('reports two disjoint, independently coupled ready tasks as parallel candidates', () => {
    const result = filesScan([
      { taskId: 'T-001', ownedPaths: ['src/lane-a/**'] },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]);
    assert.equal(result.scan.conclusion, 'parallel_candidates');
    assert.deepEqual(result.scan.readyTaskIds, ['T-001', 'T-002']);
    assert.deepEqual(result.scan.pairs, [{
      left: 'T-001', right: 'T-002', relation: 'disjoint',
      reason: 'structured exclusive ownership is mechanically disjoint',
    }]);
    assert.deepEqual(result.scan.candidatePairs, [['T-001', 'T-002']]);
  });

  it('reports coupled knowledge as an exact blocker and withholds parallel candidacy', () => {
    const result = filesScan([
      { taskId: 'T-001', ownedPaths: ['src/lane-a/**'], knowledge: 'coupled' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]);
    assert.equal(result.scan.conclusion, 'not_currently_eligible');
    assert.deepEqual(result.scan.candidatePairs, []);
    assert.equal(result.scan.pairs[0].relation, 'blocked');
    assert.ok(result.scan.couplingBlockers.some(item => item.taskId === 'T-001' && item.classification === 'coupled'));
  });

  it('keeps unknown coupling non-eligible after the bounded discovery allowance', () => {
    const result = filesScan([
      { taskId: 'T-001', ownedPaths: ['src/lane-a/**'], knowledge: 'unknown' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]);
    assert.equal(result.scan.conclusion, 'not_currently_eligible');
    assert.equal(result.scan.pairs[0].relation, 'unknown');
    assert.ok(result.scan.couplingBlockers.some(item => item.classification === 'unknown'));
  });

  it('reports ineligible structured ownership per task without inferring eligibility', () => {
    const result = filesScan([
      { taskId: 'T-001', ownedPaths: ['src/lane-a/**'], eligibility: 'unknown' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]);
    const entry = result.scan.eligibility.find(item => item.taskId === 'T-001');
    assert.equal(entry.eligibility, 'unknown');
    assert.equal(result.scan.conclusion, 'not_currently_eligible');
  });

  it('accepts a Maintainer-classified managed join as a candidate pair', () => {
    const shared = [{ path: 'src/shared/index.js', operation: 'add_export', target: 'laneA' }];
    const sharedB = [{ path: 'src/shared/index.js', operation: 'add_export', target: 'laneB' }];
    const tasks = [
      { taskId: 'T-001', ownedPaths: ['src/lane-a/**'], allowedPaths: ['src/lane-a/**', 'src/shared/index.js'], sharedMutations: shared },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'], allowedPaths: ['src/lane-b/**', 'src/shared/index.js'], sharedMutations: sharedB },
    ];
    const result = filesScan(tasks, {
      laneArtifacts: {
        'T-001': { base: 'a'.repeat(40), head: 'b'.repeat(40) },
        'T-002': { base: 'a'.repeat(40), head: 'c'.repeat(40) },
      },
      joinPlans: {
        'T-001|T-002': {
          classifiedBy: 'maintainer',
          dependencyIndependent: true,
          knowledgeIndependent: true,
          compositionOrder: ['T-001', 'T-002'],
          joinTask: { taskId: 'JOIN-001', attemptBudget: 2, lease: 'return after each conflict resolution' },
          integratedChecks: ['npm test'],
          escalation: 'route semantic uncertainty to Maintainer',
          operations: [{ taskId: 'T-001', ...shared[0] }, { taskId: 'T-002', ...sharedB[0] }],
        },
      },
    });
    assert.equal(result.scan.pairs[0].relation, 'managed_join');
    assert.deepEqual(result.scan.candidatePairs, [['T-001', 'T-002']]);
    assert.equal(result.scan.conclusion, 'parallel_candidates');
  });

  it('only ever reports a closed conclusion vocabulary', () => {
    const result = filesScan([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]);
    assert.ok(PARALLEL_SCAN_CONCLUSIONS.includes(result.scan.conclusion));
  });
});

describe('durable scan record identity', () => {
  it('binds a closed, domain-separated, deterministic record digest', () => {
    const result = filesScan([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]);
    assert.equal(result.scan.kind, PARALLEL_SCAN_KIND);
    assert.equal(result.scan.schemaVersion, PARALLEL_SCAN_SCHEMA_VERSION);
    assert.ok(result.scan.digest.startsWith(`sha256:${PARALLEL_SCAN_DIGEST_DOMAIN}:`));
    assert.equal(validateParallelScanRecord(result.scan).ok, true);
    assert.equal(Object.isFrozen(result.scan), true);
  });

  it('canonicalizes set-like inventories and pair ordering deterministically', () => {
    const forward = filesScan([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]);
    const reversed = filesScan([{ taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }, { taskId: 'T-001' }]);
    assert.equal(forward.scan.digest, reversed.scan.digest);
    assert.deepEqual(reversed.scan.pairs.map(pair => [pair.left, pair.right]), [['T-001', 'T-002']]);
  });

  it('invalidates the scan when any bound input changes', () => {
    const baseline = filesScan([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]).scan.digest;
    const membership = filesScan([
      { taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }, { taskId: 'T-003', ownedPaths: ['src/lane-c/**'] },
    ]).scan.digest;
    const ownership = filesScan([
      { taskId: 'T-001', ownedPaths: ['src/lane-z/**'] }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]).scan.digest;
    const coupling = filesScan([
      { taskId: 'T-001', knowledge: 'coupled' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]).scan.digest;
    const dependency = filesScan([
      { taskId: 'T-001', dependsOn: ['T-000'] }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ], { dependencies: { 'T-000': 'resolved' } }).scan.digest;
    const freshness = filesScan([
      { taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ], { observedAt: '2026-08-07T10:00:30.000Z' }).scan.digest;
    const digests = [baseline, membership, ownership, coupling, dependency, freshness];
    assert.equal(new Set(digests).size, digests.length);
  });

  it('rejects a tampered member digest, scan digest, or accounting set', () => {
    const { scan } = filesScan([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]);
    const tamperedDigest = { ...structuredClone(scan), digest: `sha256:${PARALLEL_SCAN_DIGEST_DOMAIN}:${'0'.repeat(64)}` };
    assert.equal(validateParallelScanRecord(tamperedDigest).ok, false);

    const tamperedMember = structuredClone(scan);
    tamperedMember.inventory.members[0].digest = `sha256:${'f'.repeat(64)}`;
    assert.equal(validateParallelScanRecord(tamperedMember).ok, false);

    const tamperedAccounting = structuredClone(scan);
    tamperedAccounting.readyTaskIds = ['T-001', 'T-002', 'T-999'];
    assert.equal(validateParallelScanRecord(tamperedAccounting).ok, false);

    const forgedCompleteness = structuredClone(scan);
    forgedCompleteness.inventory.complete = false;
    assert.equal(validateParallelScanRecord(forgedCompleteness).ok, false);
  });

  it('rejects unknown fields and recomputed internally inconsistent candidate pairs', () => {
    const { scan } = filesScan([{ taskId: 'T-001' }]);

    const unknownField = structuredClone(scan);
    unknownField.forged = true;
    rehashScan(unknownField);
    const unknownCheck = validateParallelScanRecord(unknownField);
    assert.equal(unknownCheck.ok, false);
    assert.match(unknownCheck.errors.join('\n'), /closed schema/);

    const forgedPair = structuredClone(scan);
    forgedPair.conclusion = 'parallel_candidates';
    forgedPair.candidatePairs = [['T-001', 'T-999']];
    rehashScan(forgedPair);
    const pairCheck = validateParallelScanRecord(forgedPair);
    assert.equal(pairCheck.ok, false);
    assert.match(pairCheck.errors.join('\n'), /candidate pair|candidatePairs|conclusion/);
  });

  it('binds a scan to a freshly enumerated authoritative inventory', () => {
    const tasks = [
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ];
    const { scan } = filesScan(tasks);
    assert.equal(validateParallelScanInventoryBinding(scan, filesInventory(tasks)).ok, true);

    const omittedAtScanTime = filesInventory([...tasks, { taskId: 'T-003', ownedPaths: ['src/lane-c/**'] }]);
    assert.equal(validateParallelScanInventoryBinding(scan, omittedAtScanTime).ok, false);

    const changedCarrier = filesInventory([{ taskId: 'T-001', ownedPaths: ['src/changed/**'] }, tasks[1]]);
    assert.equal(validateParallelScanInventoryBinding(scan, changedCarrier).ok, false);

    // A refetch that cannot show an exhaustive enumeration proves nothing
    // about what is on the backend now.
    const untypedRefetch = { ...filesInventory(tasks), enumeration: null };
    assert.equal(validateParallelScanInventoryBinding(scan, untypedRefetch).ok, false);
  });

  it('rejects unknown decomposition attribution and unsafe source references', () => {
    const inventory = normalizeFilesTaskInventory({
      inventoryId: 'files:tasks',
      entries: filesEntries([{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }]),
      complete: true,
    });
    const input = scanInput({ inventory });
    input.decomposition.attribution = 'engineer';
    const wrongAuthority = evaluateParallelScan(input, { now: NOW });
    assert.equal(wrongAuthority.ok, false);
    assert.equal(wrongAuthority.scan.conclusion, 'incomplete');

    const unsafe = scanInput({ inventory });
    unsafe.decomposition.sourceRef = '../outside/decomposition.json';
    assert.equal(evaluateParallelScan(unsafe, { now: NOW }).ok, false);
  });
});

describe('backend-neutral semantics', () => {
  it('gives files and GitHub the same semantic verdict for the same normalized tasks', () => {
    const bodies = [taskBody({ taskId: 'T-001' }), taskBody({ taskId: 'T-002', ownedPaths: ['src/lane-b/**'] })];
    const files = evaluateParallelScan(scanInput({
      backend: 'files',
      inventory: normalizeFilesTaskInventory({
        inventoryId: 'inventory:milestone-alpha',
        entries: [
          { carrier: '.agenticloop/tasks/T-001.md', content: bodies[0], readError: null },
          { carrier: '.agenticloop/tasks/T-002.md', content: bodies[1], readError: null },
        ],
        complete: true,
      }),
    }), { now: NOW });
    const issues = [
      { number: 11, state: 'OPEN', title: 'T-001', labels: [{ name: 'task:T-001' }], body: bodies[0] },
      { number: 12, state: 'OPEN', title: 'T-002', labels: [{ name: 'task:T-002' }], body: bodies[1] },
    ];
    const github = evaluateParallelScan(scanInput({
      backend: 'github',
      inventory: normalizeGitHubTaskInventory({
        inventoryId: 'inventory:milestone-alpha',
        inventory: { ...buildGitHubTaskIdentityInventory(issues, { complete: true }), issues },
      }),
    }), { now: NOW });

    assert.equal(files.ok, github.ok);
    assert.equal(files.scan.conclusion, github.scan.conclusion);
    assert.deepEqual(files.scan.readyTaskIds, github.scan.readyTaskIds);
    assert.deepEqual(files.scan.candidatePairs, github.scan.candidatePairs);
    assert.equal(files.scan.semanticDigest, github.scan.semanticDigest);
  });

  it('keeps GitHub transport fields out of the shared semantic digest', () => {
    const body = taskBody({ taskId: 'T-001' });
    const other = taskBody({ taskId: 'T-002', ownedPaths: ['src/lane-b/**'] });
    const build = (leftNumber, rightNumber) => {
      const issues = [
        { number: leftNumber, state: 'OPEN', title: 'T-001', labels: [{ name: 'task:T-001' }], body },
        { number: rightNumber, state: 'OPEN', title: 'T-002', labels: [{ name: 'task:T-002' }], body: other },
      ];
      return evaluateParallelScan(scanInput({
        backend: 'github',
        inventory: normalizeGitHubTaskInventory({
          inventoryId: 'inventory:milestone-alpha',
          inventory: { ...buildGitHubTaskIdentityInventory(issues, { complete: true }), issues },
        }),
      }), { now: NOW }).scan;
    };
    assert.equal(build(11, 12).semanticDigest, build(4711, 4712).semanticDigest);
    assert.notEqual(build(11, 12).digest, build(4711, 4712).digest);
  });
});

describe('dispatch binding', () => {
  const temp = mkdtempSync(join(tmpdir(), 'scan-dispatch-'));
  after(() => rmSync(temp, { recursive: true, force: true }));

  // Rebuild a committed decomposition source by hand, exactly as a Maintainer
  // who bound the wrong scan would have committed it: internally well-formed
  // and correctly self-digested, so only the scan evidence itself can refuse it.
  function committedDecomposition(fixture, patch) {
    const value = { ...structuredClone(fixture.decomposition), ...patch, sourceDigest: null };
    const { sourceDigest, ...rest } = value;
    value.sourceDigest = `sha256:${createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')}`;
    return value;
  }

  function rebind(fixture, mutate) {
    const scan = structuredClone(fixture.decomposition.scan);
    mutate(scan);
    // Direct mutation: this is what a tampered committed source looks like.
    const decomposition = { ...structuredClone(fixture.decomposition), scan };
    return prepare(fixture, { refetchDecomposition: () => decomposition });
  }

  /**
   * Re-scan the fixture's own task surface. The base and dependency evidence
   * are the fixture's, so only the property under test differs from the scan
   * the fixture committed.
   */
  function fixtureScan(fixture, { entries, complete = true, declaredCompleteness = 'complete', dependencies = {} } = {}) {
    const observedAt = fixture.decomposition.observedAt;
    const members = entries ?? [
      { carrier: '.agenticloop/tasks/T-001.md', content: fixture.snapshot().body, readError: null },
    ];
    return evaluateParallelScan({
      workUnit: { id: 'fixture-work-unit', backend: 'files' },
      inventory: normalizeFilesTaskInventory({
        inventoryId: 'files:.agenticloop/tasks',
        entries: members,
        complete,
        enumeration: complete
          ? createTaskInventoryEnumeration({
            backend: 'files', inventoryId: 'files:.agenticloop/tasks', observedAt,
            discovered: members.length, returned: members.length,
          })
          : null,
      }, { now: Date.parse(observedAt) + 1000 }),
      decomposition: {
        source: 'task-decomposition',
        sourceRef: fixture.decomposition.sourceRef,
        revision: fixture.decomposition.scan.decomposition.revision,
        declaredCompleteness,
        attribution: 'maintainer',
      },
      observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths: fixtureBasePaths(fixture),
      dependencies,
      readinessContext: {
        base: fixture.readiness.evidence.base,
        dependencies: fixture.readiness.evidence.dependencies,
      },
      rescanTrigger: fixture.decomposition.scan.rescanTrigger,
    }, { now: Date.parse(observedAt) + 1000 });
  }

  function scanFor(fixture, patch = {}) {
    return fixtureScan(fixture, patch).scan;
  }

  it('accepts a dispatch bound to complete, fresh, ready scan evidence', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-accept');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(fixture.decomposition.schemaVersion, DECOMPOSITION_SCHEMA_VERSION);
    assert.equal(fixture.decomposition.scan.kind, PARALLEL_SCAN_KIND);
    assert.equal(validateParallelScanRecord(fixture.decomposition.scan).ok, true);
    assert.equal(prepared.packet.schemaVersion, DISPATCH_PREPARATION_SCHEMA_VERSION);
    // The packet carries a constant-size binding, not the scan record itself.
    const binding = prepared.packet.decomposition;
    assert.equal(binding.kind, DECOMPOSITION_BINDING_KIND);
    assert.equal(binding.scanDigest, fixture.decomposition.scan.digest);
    assert.equal(binding.sourceDigest, fixture.decomposition.sourceDigest);
    assert.equal(binding.inventoryComplete, true);
    assert.equal(binding.taskDisposition, 'ready');
    assert.equal(binding.scan, undefined);
  });

  it('refuses dispatch when authoritative inventory membership changed after the scan', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-live-membership');
    const currentInventory = normalizeFilesTaskInventory({
      inventoryId: 'files:.agenticloop/tasks',
      entries: [
        { carrier: '.agenticloop/tasks/T-001.md', content: fixture.snapshot().body, readError: null },
        { carrier: '.agenticloop/tasks/T-777.md', content: taskBody({ taskId: 'T-777', ownedPaths: ['src/lane-b/**'] }), readError: null },
      ],
      complete: true,
    });
    const refused = prepare(fixture, { refetchParallelScanInventory: () => currentInventory });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /inventory membership or task carrier digest changed/);
  });

  it('refuses a recomputed parallel route whose candidate pair is not backed by pair evidence', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-forged-pair');
    const scan = structuredClone(fixture.decomposition.scan);
    scan.conclusion = 'parallel_candidates';
    scan.candidatePairs = [['T-001', 'T-999']];
    rehashScan(scan);
    const decomposition = committedDecomposition(fixture, { route: 'parallel', scan });
    const refused = prepare(fixture, { refetchDecomposition: () => decomposition });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /candidate pair|candidatePairs|conclusion/);
  });

  it('keeps the packet binding constant-size as the work unit grows', async () => {
    const small = await createDispatchFixture(temp, 'scan-size-small');
    const prepared = prepare(small);
    const bindingBytes = Buffer.byteLength(canonicalJson(prepared.packet.decomposition), 'utf8');
    const sourceBytes = Buffer.byteLength(canonicalJson(small.decomposition), 'utf8');
    assert.ok(bindingBytes < sourceBytes, `binding ${bindingBytes} must be smaller than source ${sourceBytes}`);
    assert.ok(bindingBytes < 1024, `decomposition binding is ${bindingBytes} bytes`);
  });

  it('refuses dispatch when the bound scan inventory is incomplete', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-incomplete');
    const scan = scanFor(fixture, { complete: false });
    assert.equal(scan.conclusion, 'incomplete');
    const refused = prepare(fixture, { refetchDecomposition: () => committedDecomposition(fixture, { scan }) });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /incomplete/i);
  });

  it('refuses dispatch when the target task is excluded by the scan', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-excluded');
    // The task's own record declares no dependency, so exclusion is produced by
    // scanning it as part of a work unit whose declared decomposition is not
    // complete - the exact case a small visible ready set used to hide.
    const scan = scanFor(fixture, { declaredCompleteness: 'incomplete' });
    assert.equal(scan.decomposition.state, 'incomplete');
    const refused = prepare(fixture, { refetchDecomposition: () => committedDecomposition(fixture, { scan }) });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /incomplete/i);
  });

  it('refuses to construct decomposition provenance for a task the scan excluded', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-excluded-construct');
    const scanned = fixtureScan(fixture, {
      entries: [
        { carrier: '.agenticloop/tasks/T-001.md', content: fixture.snapshot().body, readError: null },
        { carrier: '.agenticloop/tasks/T-777.md', content: taskBody({ taskId: 'T-777', ownedPaths: ['src/lane-b/**'] }), readError: null },
      ],
    });
    assert.equal(scanned.scan.readyTaskIds.includes('T-777'), true);
    assert.throws(() => createDecompositionProvenance({
      taskId: 'T-404',
      sourceRef: fixture.decomposition.sourceRef,
      scan: scanned.scan,
    }), /does not authorize this task as ready|taskId must match/);
  });

  it('cannot rebind the freshness policy the scan was observed under', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-freshness-widening');
    // A one-second scan wrapped in a one-day decomposition is exactly the
    // rebinding this contract forbids.
    const narrow = structuredClone(fixture.decomposition.scan);
    narrow.freshnessPolicy = { maxAgeSeconds: 1 };
    narrow.readinessContext = {
      ...narrow.readinessContext,
      observation: { ...narrow.readinessContext.observation, maxAgeSeconds: 1 },
    };
    rehashReadinessContext(narrow);
    rehashScan(narrow);
    assert.equal(validateParallelScanRecord(narrow, { now: Date.parse(narrow.observedAt) + 500 }).ok, true);

    // The producer takes no freshness input at all.
    assert.throws(() => createDecompositionProvenance({
      taskId: 'T-001',
      sourceRef: fixture.decomposition.sourceRef,
      scan: narrow,
      freshnessPolicy: { maxAgeSeconds: 86_400 },
    }), /unknown input field/);

    // A hand-built source that widens it anyway is refused by the consumer.
    const widened = committedDecomposition(fixture, {
      scan: narrow,
      observedAt: narrow.observedAt,
      freshnessPolicy: { maxAgeSeconds: 86_400 },
    });
    const refused = prepare(fixture, { refetchDecomposition: () => widened });
    assert.equal(refused.ok, false);
    assert.match(
      refused.validation.errors.join('\n'),
      /freshnessPolicy must equal its bound parallel-scan freshness policy|stale/i,
    );
  });

  it('refuses a claimed parallel route the scan does not support', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-route');
    const decomposition = { ...structuredClone(fixture.decomposition), route: 'parallel' };
    const refused = prepare(fixture, { refetchDecomposition: () => decomposition });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /parallel candidate pair|parallel route is blocked/i);
  });

  it('refuses a tampered scan record whose digest no longer matches', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-tampered');
    const refused = rebind(fixture, scan => { scan.rescanTrigger = 'anything else'; });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /digest/i);
  });

  it('gives authentic legacy schemaVersion 1 decomposition evidence typed stale handling', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-legacy');
    const legacy = {
      kind: 'agenticloop.decomposition-provenance',
      schemaVersion: 1,
      taskId: 'T-001',
      authority: 'maintainer',
      source: 'task-decomposition',
      inventory: {
        id: 'decomposition:legacy',
        readyTaskIds: ['T-001'],
        digest: `sha256:${createHash('sha256').update(canonicalJson({ taskId: 'T-001', readyTaskIds: ['T-001'] }), 'utf8').digest('hex')}`,
      },
      completeness: 'complete',
      observedAt: fixture.decomposition.observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: fixture.decomposition.sourceRef,
    };
    legacy.sourceDigest = `sha256:${createHash('sha256').update(canonicalJson(legacy), 'utf8').digest('hex')}`;
    const stale = prepare(fixture, { refetchDecomposition: () => legacy });
    assert.equal(stale.ok, false);
    assert.match(stale.validation.errors.join('\n'), /schemaVersion 1 is stale|regenerate it as schemaVersion 2/);
    assert.ok(stale.validation.diagnostics.some(item => item.code === 'dispatch.packet.stale'));
  });

  it('keeps a malformed schemaVersion 1 lookalike malformed rather than stale', async () => {
    const fixture = await createDispatchFixture(temp, 'scan-legacy-lookalike');
    const lookalike = {
      kind: 'agenticloop.decomposition-provenance',
      schemaVersion: 1,
      taskId: 'T-001',
      authority: 'maintainer',
      source: 'task-decomposition',
      inventory: { id: 'decomposition:lookalike', readyTaskIds: ['T-001'], digest: `sha256:${'0'.repeat(64)}` },
      completeness: 'complete',
      observedAt: fixture.decomposition.observedAt,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      sourceRef: fixture.decomposition.sourceRef,
      sourceDigest: `sha256:${'0'.repeat(64)}`,
    };
    const rejected = prepare(fixture, { refetchDecomposition: () => lookalike });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.validation.errors.join('\n').includes('is stale'), false);
  });

  it('cannot be constructed from a caller-asserted completeness token', () => {
    assert.throws(() => createDecompositionProvenance({
      taskId: 'T-001',
      sourceRef: '.agenticloop/decompositions/T-001.json',
      completeness: 'complete',
      inventory: { id: 'x', readyTaskIds: ['T-001'], digest: `sha256:${'0'.repeat(64)}` },
    }), /unknown input field\(s\): completeness, inventory/);
  });
});

describe('scan diagnostics', () => {
  it('returns canonical validation-result diagnostics', () => {
    const result = filesScan([{ taskId: 'T-001' }], { complete: false });
    assert.equal(result.result.kind, 'agenticloop.validation-result');
    assert.equal(result.result.command, 'parallel scan');
    assert.equal(result.result.ok, false);
    assert.ok(result.result.diagnostics.every(item => typeof item.code === 'string' && item.code));
  });
});


describe('canonical instants and freshness bounds', () => {
  it('accepts only the one canonical instant format across every layer', () => {
    for (const value of [
      '2026-08-07T10:00:00Z',
      '2026-08-07T10:00:00.000Z',
    ]) {
      assert.equal(parseCanonicalInstant(value, { now: NOW }).ok, true, value);
    }
    for (const value of [
      '2026-08-07T10:00:00.5Z',
      '2026-08-07T10:00:00.50Z',
      '2026-08-07T10:00:00+00:00',
      '2026-08-07T10:00:00z',
      '2026-08-07 10:00:00Z',
      '2025-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-08-07T24:00:00Z',
      '2026-13-40T10:00:00Z',
      1_754_560_800_000,
      null,
      {},
    ]) {
      assert.equal(parseCanonicalInstant(value, { now: NOW }).ok, false, String(value));
    }
  });

  it('refuses a fractional-second scan the consumer would reject', () => {
    // The producer used to accept one- and two-digit fractions the dispatch
    // consumer rejected; construction and validation now share one parser.
    const scanned = filesScan([{ taskId: 'T-001' }], { observedAt: '2026-08-07T10:00:00.5Z' });
    assert.equal(scanned.ok, false);
    assert.match(scanned.result.errors.join('\n'), /observedAt must be an ISO-8601 UTC instant/);
  });

  it('rejects a future observation beyond the clock-skew allowance and accepts one inside it', () => {
    const skewMs = 5_000;
    const inside = new Date(NOW + skewMs - 1_000).toISOString();
    const outside = new Date(NOW + skewMs + 60_000).toISOString();
    assert.equal(parseCanonicalInstant(inside, { now: NOW }).ok, true);
    assert.equal(parseCanonicalInstant(outside, { now: NOW }).ok, false);
    const insideScan = filesScan([{ taskId: 'T-001' }], { observedAt: inside });
    assert.equal(insideScan.ok, true, insideScan.result.errors.join('\n'));
    assert.doesNotThrow(() => createDecompositionProvenance({
      taskId: 'T-001',
      sourceRef: '.agenticloop/decompositions/milestone-alpha.json',
      scan: insideScan.scan,
      route: 'serial',
    }, { now: NOW }));
    const future = filesScan([{ taskId: 'T-001' }], { observedAt: outside });
    assert.equal(future.ok, false);
    assert.match(future.result.errors.join('\n'), /future beyond the 5s clock-skew allowance/);
  });

  it('binds scan freshness to the authoritative enumeration observation time', () => {
    const enumerationObservedAt = new Date(NOW - 12 * 60 * 60 * 1000).toISOString();
    const scanned = filesScan([{ taskId: 'T-001' }], {
      observedAt: OBSERVED_AT,
      maxAgeSeconds: 60,
      enumeration: { observedAt: enumerationObservedAt },
    });
    assert.equal(scanned.ok, false);
    assert.match(scanned.result.errors.join('\n'), /must equal its authoritative inventory enumeration observation time/);
    assert.equal(validateParallelScanRecord(scanned.scan, { now: NOW }).ok, false);
  });

  it('bounds the freshness policy by a trusted maximum, not any positive safe integer', () => {
    const absurd = filesScan([{ taskId: 'T-001' }], { maxAgeSeconds: Number.MAX_SAFE_INTEGER });
    assert.equal(absurd.ok, false);
    assert.match(absurd.result.errors.join('\n'), /between 1 and 86400/);
    const atLimit = filesScan([{ taskId: 'T-001' }], { maxAgeSeconds: PARALLEL_SCAN_MAX_FRESHNESS_SECONDS });
    assert.equal(atLimit.ok, true, atLimit.result.errors.join('\n'));
  });

  it('uses an injectable clock for construction and validation', () => {
    const scanned = filesScan([{ taskId: 'T-001' }], { maxAgeSeconds: 60 });
    assert.equal(scanned.ok, true, scanned.result.errors.join('\n'));
    // The same record validated far in the future is still structurally valid;
    // freshness is the decomposition consumer's separate check.
    assert.equal(validateParallelScanRecord(scanned.scan, { now: NOW + 86_400_000 }).ok, true);
    // But validating it against a clock *before* it was observed is a future
    // observation, which no layer accepts.
    assert.equal(validateParallelScanRecord(scanned.scan, { now: Date.parse(OBSERVED_AT) - 600_000 }).ok, false);
  });
});

describe('scan schemas are exact and total', () => {
  function validScan() {
    const scanned = filesScan([
      { taskId: 'T-001' },
      { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] },
    ]);
    assert.equal(scanned.ok, true, scanned.result.errors.join('\n'));
    return structuredClone(scanned.scan);
  }

  const WRONG_VALUES = Object.freeze([null, 0, '', 'text', [], {}, true]);

  it('is total over arbitrary JSON-compatible input and never throws', () => {
    for (const value of [null, undefined, 0, '', 'text', [], [1], true, {}, { kind: 1 }, { inventory: [] }]) {
      const check = validateParallelScanRecord(value, { now: NOW });
      assert.equal(check.ok, false, String(value));
      assert.ok(Array.isArray(check.errors) && check.errors.length > 0);
    }
  });

  it('rejects deletion of any top-level field', () => {
    for (const field of Object.keys(validScan())) {
      const record = validScan();
      delete record[field];
      assert.equal(validateParallelScanRecord(record, { now: NOW }).ok, false, `deleting ${field}`);
    }
  });

  it('rejects an unknown top-level field', () => {
    const record = validScan();
    record.somethingElse = true;
    assert.equal(validateParallelScanRecord(record, { now: NOW }).ok, false);
  });

  const unchanged = (record, field, wrong) =>
    JSON.stringify(record[field] ?? null) === JSON.stringify(wrong ?? null);

  it('rejects a wrong-typed value in any top-level field', () => {
    for (const field of Object.keys(validScan())) {
      for (const wrong of WRONG_VALUES) {
        const record = validScan();
        if (unchanged(record, field, wrong)) continue;
        record[field] = wrong;
        assert.equal(
          validateParallelScanRecord(record, { now: NOW }).ok,
          false,
          `${field} = ${JSON.stringify(wrong)}`,
        );
      }
    }
  });

  it('rejects deletion or wrong types in every nested schema field', () => {
    const nested = ['inventory', 'workUnit', 'decomposition', 'readinessContext', 'freshnessPolicy'];
    for (const parent of nested) {
      for (const field of Object.keys(validScan()[parent])) {
        const deleted = validScan();
        delete deleted[parent][field];
        assert.equal(validateParallelScanRecord(deleted, { now: NOW }).ok, false, `deleting ${parent}.${field}`);
        for (const wrong of WRONG_VALUES) {
          const record = validScan();
          if (unchanged(record[parent], field, wrong)) continue;
          record[parent][field] = wrong;
          assert.equal(
            validateParallelScanRecord(record, { now: NOW }).ok,
            false,
            `${parent}.${field} = ${JSON.stringify(wrong)}`,
          );
        }
      }
    }
  });

  it('requires an explicit array for every collection field', () => {
    const collections = ['readyTaskIds', 'excluded', 'eligibility', 'knowledgeCoupling',
      'couplingBlockers', 'pairs', 'candidatePairs', 'invalidatedBy'];
    for (const field of collections) {
      for (const wrong of [null, {}, 'text', 0, true]) {
        const record = validScan();
        record[field] = wrong;
        rehashScan(record);
        const check = validateParallelScanRecord(record, { now: NOW });
        assert.equal(check.ok, false, `${field} = ${JSON.stringify(wrong)}`);
        // A wrong type must be reported as a wrong type, never coerced to an
        // empty collection that then re-digests as internally consistent.
        assert.ok(
          check.errors.some(error => /must be an array|must equal the canonical invalidator/.test(error)),
          `${field}: ${check.errors.join('; ')}`,
        );
      }
    }
  });

  it('refuses a re-digested candidatePairs object', () => {
    const record = validScan();
    record.candidatePairs = {};
    rehashScan(record);
    const check = validateParallelScanRecord(record, { now: NOW });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(error => /candidatePairs must be an array/.test(error)));
  });

  it('rejects wrong array elements inside a collection', () => {
    for (const [field, element] of [
      ['readyTaskIds', 42],
      ['excluded', 'not-an-exclusion'],
      ['eligibility', null],
      ['knowledgeCoupling', []],
      ['couplingBlockers', 7],
      ['pairs', 'left|right'],
      ['candidatePairs', 'T-001|T-002'],
    ]) {
      const record = validScan();
      record[field] = [element];
      rehashScan(record);
      assert.equal(validateParallelScanRecord(record, { now: NOW }).ok, false, field);
    }
  });

  it('rejects a missing decomposition revision or an empty inventory id', () => {
    const noRevision = validScan();
    noRevision.decomposition.revision = '';
    rehashScan(noRevision);
    const revisionCheck = validateParallelScanRecord(noRevision, { now: NOW });
    assert.equal(revisionCheck.ok, false);
    assert.ok(revisionCheck.errors.some(error => /decomposition revision is required/.test(error)));

    const noInventoryId = validScan();
    noInventoryId.inventory.id = '';
    rehashScan(noInventoryId);
    const idCheck = validateParallelScanRecord(noInventoryId, { now: NOW });
    assert.equal(idCheck.ok, false);
    assert.ok(idCheck.errors.some(error => /inventory id is required/.test(error)));
  });

  it('refuses a complete inventory with no typed enumeration receipt', () => {
    const record = validScan();
    record.inventory.enumeration = null;
    record.inventory.digest = record.inventory.digest;
    rehashScan(record);
    const check = validateParallelScanRecord(record, { now: NOW });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(error => /typed authoritative enumeration receipt/.test(error)));
  });

  it('never returns ok for a record the closed validator would reject', () => {
    // Producer/validator parity over the whole adversarial input matrix.
    for (const patch of [
      { observedAt: '2026-08-07T10:00:00.5Z' },
      { maxAgeSeconds: Number.MAX_SAFE_INTEGER },
      { maxAgeSeconds: 0 },
      { complete: true, enumeration: { truncated: true, cursor: 'next' } },
      { readinessContext: { base: null, dependencies: null } },
      { readinessContext: { base: { ...BASE_EVIDENCE, pathCount: 99 }, dependencies: null } },
    ]) {
      const scanned = filesScan([{ taskId: 'T-001' }], patch);
      if (scanned.ok) {
        assert.equal(
          validateParallelScanRecord(scanned.scan, { now: NOW }).ok,
          true,
          `ok scan must be consumer-valid: ${JSON.stringify(patch)}`,
        );
      }
      if (scanned.scan && !validateParallelScanRecord(scanned.scan, { now: NOW }).ok) {
        assert.equal(scanned.ok, false, `invalid emitted record must not be ok: ${JSON.stringify(patch)}`);
      }
    }
  });
});

describe('bound readiness context', () => {
  const tasks = [{ taskId: 'T-001' }, { taskId: 'T-002', ownedPaths: ['src/lane-b/**'] }];

  it('binds base and dependency evidence into the scan identity', () => {
    const baseline = filesScan(tasks);
    assert.equal(baseline.ok, true, baseline.result.errors.join('\n'));
    assert.equal(baseline.scan.readinessContext.base.identity, BASE_EVIDENCE.identity);
    assert.equal(baseline.scan.readinessContext.observation.observedAt, OBSERVED_AT);
    assert.equal(baseline.scan.readinessContext.observation.maxAgeSeconds, 3600);

    // Changed base evidence changes the scan identity, with no task body edited.
    const otherBase = {
      ...BASE_EVIDENCE,
      identity: 'path-inventory:other-base.json',
      revalidationArgs: ['--base-paths', 'other-base.json'],
    };
    const changedBase = filesScan(tasks, { readinessContext: { base: otherBase, dependencies: null } });
    assert.equal(changedBase.ok, true, changedBase.result.errors.join('\n'));
    assert.notEqual(changedBase.scan.digest, baseline.scan.digest);
  });

  it('gives dependency_status an exact bound evidence identity that changes the scan', () => {
    const withDeps = filesScan(tasks, { dependencies: { 'T-900': 'resolved' } });
    const changedDeps = filesScan(tasks, { dependencies: { 'T-900': 'accepted' } });
    assert.equal(withDeps.ok, true, withDeps.result.errors.join('\n'));
    assert.equal(changedDeps.ok, true, changedDeps.result.errors.join('\n'));
    // The task carrier digests are byte-identical across both scans.
    assert.deepEqual(
      withDeps.scan.inventory.members.map(member => member.digest),
      changedDeps.scan.inventory.members.map(member => member.digest),
    );
    // ...and the scan identity still changes, because dependency status is bound.
    assert.notEqual(
      withDeps.scan.readinessContext.dependencies.statusDigest,
      changedDeps.scan.readinessContext.dependencies.statusDigest,
    );
    assert.notEqual(withDeps.scan.digest, changedDeps.scan.digest);
  });

  it('refuses a scan that evaluated dependency statuses it did not bind', () => {
    const unbound = filesScan(tasks, {
      dependencies: { 'T-900': 'resolved' },
      readinessContext: { base: BASE_EVIDENCE, dependencies: null },
    });
    assert.equal(unbound.ok, false);
    assert.match(unbound.result.errors.join('\n'), /without binding the dependency evidence/);
  });

  it('refuses base evidence that does not describe the scanned base inventory', () => {
    const mismatched = filesScan(tasks, {
      readinessContext: { base: { ...BASE_EVIDENCE, pathCount: 99 }, dependencies: null },
    });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.result.errors.join('\n'), /pathCount does not match/);
  });

  it('reports a changed base or dependency identity as a stale binding', () => {
    const { scan } = filesScan(tasks, { dependencies: { 'T-900': 'resolved' } });
    const current = {
      base: BASE_EVIDENCE,
      dependencies: dependencyEvidence({ 'T-900': 'resolved' }),
    };
    assert.equal(validateParallelScanReadinessBinding(scan, current).ok, true);

    const changedBase = validateParallelScanReadinessBinding(scan, {
      ...current,
      base: { ...BASE_EVIDENCE, identity: 'path-inventory:moved.json', revalidationArgs: ['--base-paths', 'moved.json'] },
    });
    assert.equal(changedBase.ok, false);
    assert.match(changedBase.errors.join('\n'), /base evidence changed after the scan/);

    const changedStatus = validateParallelScanReadinessBinding(scan, {
      ...current,
      dependencies: dependencyEvidence({ 'T-900': 'blocked' }),
    });
    assert.equal(changedStatus.ok, false);
    assert.match(changedStatus.errors.join('\n'), /dependency status evidence changed after the scan/);

    const dropped = validateParallelScanReadinessBinding(scan, { ...current, dependencies: null });
    assert.equal(dropped.ok, false);
  });
});


describe('production decomposition producer', () => {
  const temp = mkdtempSync(join(tmpdir(), 'scan-produce-'));
  after(() => rmSync(temp, { recursive: true, force: true }));

  const PRODUCED_REF = '.agenticloop/decompositions/T-001-produced.json';

  it('exposes a read-only producer inside the existing task command family', () => {
    const task = COMMAND_REGISTRY.task;
    assert.ok(task.subcommands['prepare-decomposition'], 'the task family must own the producer');
    assert.equal(task.subcommands['prepare-decomposition'].receiptRevalidation, 'read-only');
    assert.match(task.usage, /prepare-decomposition/);
    // No second command family was created for it.
    assert.equal(Object.keys(COMMAND_REGISTRY).includes('decomposition'), false);
    assert.equal(Object.keys(COMMAND_REGISTRY).includes('scan'), false);
  });

  async function produce(fixture, patch = {}) {
    const baseTree = fixture.readiness.evidence.base.identity.slice('git-tree:'.length);
    return runCliInProcess([
      'task', 'prepare-decomposition', patch.taskId ?? 'T-001',
      '--work-unit', patch.workUnit ?? 'fixture-work-unit',
      '--source-ref', patch.sourceRef ?? PRODUCED_REF,
      '--source-revision', `git-commit:${git(fixture.root, ['rev-parse', 'HEAD'])}`,
      '--base', baseTree,
      '--dependencies', 'dependencies.json',
      ...(patch.repo ? ['--repo', patch.repo] : []),
      ...(patch.route ? ['--route', patch.route] : []),
      ...(patch.observedAt ? ['--observed-at', patch.observedAt] : []),
      '--json', '--target', fixture.root,
    ], patch.io ?? {});
  }

  it('uses the configured GitHub backend and exhausts the injected paginated transport', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-github');
    const projectPath = join(fixture.root, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf8').replace('task_backend: files', 'task_backend: github'),
      'utf8'
    );
    const task = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');
    const calls = [];
    const ghCommandRunner = (_command, args) => {
      calls.push(args);
      if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            [{ number: 101, state: 'open', title: 'Task T-001', body: task, labels: [{ name: 'task:T-001' }] }],
            [],
          ]),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
    };
    const produced = await produce(fixture, {
      repo: 'owner/repository',
      io: { ghCommandRunner },
    });
    assert.equal(produced.status, 0, `${produced.stdout}${produced.stderr}`);
    const decomposition = JSON.parse(produced.stdout);
    assert.equal(decomposition.scan.workUnit.backend, 'github');
    assert.equal(decomposition.scan.inventory.id, 'github:owner/repository');
    assert.equal(decomposition.scan.inventory.enumeration.enumerator, 'agenticloop.github-task-issue-inventory.v1');
    assert.equal(decomposition.scan.inventory.enumeration.coverage.pageCount, 2);
    assert.equal(decomposition.scan.inventory.enumeration.coverage.discovered, 1);
    assert.equal(decomposition.scan.inventory.enumeration.coverage.returned, 1);
    assert.equal(decomposition.scan.inventory.enumeration.coverage.truncated, false);
    assert.equal(decomposition.scan.inventory.enumeration.coverage.cursor, null);
    assert.ok(calls.some(args => args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')));
  });

  it('runs GitHub prepare-dispatch through authoritative refetch and blocks membership drift', async () => {
    const fixture = await createDispatchFixture(temp, 'dispatch-github');
    const projectPath = join(fixture.root, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf8').replace('task_backend: files', 'task_backend: github'),
      'utf8'
    );
    writeFileSync(
      join(fixture.root, 'agenticloop.json'),
      readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'),
      'utf8'
    );
    git(fixture.root, ['add', '.agenticloop/project.md', 'agenticloop.json']);
    git(fixture.root, ['commit', '-m', 'select GitHub task backend\n\nTask: T-001\nAgent: maintainer']);
    const githubTask = `${readFileSync(fixture.taskPath, 'utf8').replace(/^backend: files$/m, 'backend: github').trimEnd()}\n\n[[agent: maintainer]]\n`;
    const githubContract = taskContractDigest(githubTask);
    assert.equal(githubContract.ok, true, githubContract.error);
    const baselineAt = new Date().toISOString();
    const baselineRecord = createTaskContractBaselineRecord({
      recordId: 'github-comment:501', taskId: 'T-001', digest: githubContract.digest,
      projection: githubContract.projection, authority: 'maintainer:dispatch', actor: 'maintainer',
      timestamp: baselineAt, affectedArtifact: 'issue:101',
    });
    const comments = [{
      id: 501, html_url: 'https://example.test/issues/101#issuecomment-501',
      user: { login: 'maintainer' }, author_association: 'MEMBER',
      created_at: baselineAt, updated_at: baselineAt, body: renderTaskContractRecord(baselineRecord),
    }];
    const issues = [{
      number: 101, state: 'open', title: 'Task T-001', body: githubTask,
      labels: [{ name: 'task:T-001' }],
    }];
    const calls = [];
    const ghCommandRunner = (_command, args) => {
      calls.push(args);
      if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
        const endpoint = args.find(value => String(value).startsWith('repos/')) ?? '';
        return endpoint.includes('/comments')
          ? { status: 0, stdout: JSON.stringify([comments]), stderr: '' }
          : { status: 0, stdout: JSON.stringify([[...issues], []]), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 101, body: issues[0].body }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
    };
    const produced = await produce(fixture, {
      repo: 'owner/repository',
      io: { ghCommandRunner },
    });
    assert.equal(produced.status, 0, produced.stdout + produced.stderr);
    const decomposition = JSON.parse(produced.stdout);
    mkdirSync(join(fixture.root, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(fixture.root, PRODUCED_REF), `${produced.stdout.trim()}\n`, 'utf8');
    git(fixture.root, ['add', PRODUCED_REF]);
    git(fixture.root, ['commit', '-m', 'record GitHub decomposition\n\nTask: T-001\nAgent: maintainer']);

    const baseTree = decomposition.scan.readinessContext.base.identity.slice('git-tree:'.length);
    const basePaths = git(fixture.root, ['ls-tree', '-r', '--name-only', baseTree]).split(/\r?\n/).filter(Boolean);
    const rawReadiness = evaluateTaskReadiness({
      taskBody: githubTask,
      basePaths,
      mode: 'authoring',
      dependencies: {},
    });
    assert.equal(rawReadiness.ok, true, rawReadiness.errors.join('\n'));
    const readinessResult = createValidationResult({
      command: 'task-readiness',
      ok: rawReadiness.ok,
      evidenceState: rawReadiness.evidenceState,
      disposition: rawReadiness.disposition,
      errors: rawReadiness.errors,
      warnings: rawReadiness.warnings,
      diagnostics: rawReadiness.diagnostics,
    });
    const readiness = {
      evidence: createTaskReadinessEvidence({
        backend: 'github',
        task: { id: 'T-001', carrier: 'issue:101', expectedDigest: digestOf(githubTask) },
        base: fixture.readiness.evidence.base,
        dependencies: fixture.readiness.evidence.dependencies,
        trustedRecordCount: 1,
        trustedRecordErrors: [],
      }),
      result: readinessResult,
      resultDigest: validationResultDigest(readinessResult),
    };
    mkdirSync(join(fixture.root, '.agenticloop', 'tmp'), { recursive: true });
    const inputPath = join(fixture.root, '.agenticloop', 'tmp', 'github-dispatch-input.json');
    writeFileSync(inputPath, JSON.stringify({
      readiness,
      decomposition: { sourceRef: PRODUCED_REF },
      assignment: {
        ...fixture.assignment,
        canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'],
      },
    }), 'utf8');
    const command = () => runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', '.agenticloop/tmp/github-dispatch-input.json',
      '--host-trust-store', fixture.trustStorePath, '--repo', 'owner/repository',
      '--json', '--target', fixture.root,
    ], {
      operatorTrustRoot: fixture.operatorTrustRoot,
      hostAuthority: protectedHostBoundary(fixture.trust),
      ghCommandRunner,
    });
    const prepared = await command();
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const packet = JSON.parse(prepared.stdout);
    assert.equal(packet.backend, 'github');
    assert.equal(packet.task.carrier, 'issue:101');
    assert.equal(packet.decomposition.sourceRef, PRODUCED_REF);
    assert.ok(calls.some(args => args[0] === 'issue' && args[1] === 'view'));
    assert.ok(calls.some(args => args[0] === 'api' && args.some(value => String(value).includes('/comments'))));

    issues.push({
      number: 102, state: 'open', title: 'Task T-002',
      body: githubTask.replaceAll('T-001', 'T-002'), labels: [{ name: 'task:T-002' }],
    });
    const drifted = await command();
    assert.equal(drifted.status, 1);
    const rejected = JSON.parse(drifted.stdout);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /inventory|membership|decomposition/i);
  });

  it('produces a committable source that dispatch accepts unchanged', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-accept');
    const before = git(fixture.root, ['status', '--porcelain']);

    // 1. Authoritative enumeration + scan + decomposition, through the public
    //    read-only command. Nothing is written by the command itself.
    const produced = await produce(fixture);
    assert.equal(produced.status, 0, produced.stderr);
    assert.equal(git(fixture.root, ['status', '--porcelain']), before, 'the producer must mutate nothing');

    const decomposition = JSON.parse(produced.stdout);
    assert.equal(decomposition.kind, 'agenticloop.decomposition-provenance');
    assert.equal(decomposition.schemaVersion, DECOMPOSITION_SCHEMA_VERSION);
    assert.equal(decomposition.sourceRef, PRODUCED_REF);
    assert.equal(decomposition.scan.inventory.complete, true);
    assert.equal(decomposition.scan.inventory.enumeration.enumerator, 'agenticloop.files-task-directory.v1');
    assert.equal(decomposition.scan.inventory.enumeration.completion, 'exhaustive');
    assert.ok(decomposition.scan.readinessContext.digest);

    // The emitted scan passes the exact validator dispatch runs.
    assert.equal(validateParallelScanRecord(decomposition.scan).ok, true);

    // Deterministic canonical JSON: identical inputs render identical bytes.
    // The observation instant is an input, so it is pinned for this comparison.
    const pinnedAt = decomposition.observedAt;
    const first = await produce(fixture, { observedAt: pinnedAt });
    const second = await produce(fixture, { observedAt: pinnedAt });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stdout.trim(), canonicalJson(JSON.parse(first.stdout)));

    // 2. Commit it as a Maintainer-attributed source.
    mkdirSync(join(fixture.root, '.agenticloop', 'decompositions'), { recursive: true });
    writeFileSync(join(fixture.root, PRODUCED_REF), `${produced.stdout.trim()}\n`, 'utf8');
    git(fixture.root, ['add', PRODUCED_REF]);
    git(fixture.root, ['commit', '-m', 'record produced decomposition\n\nTask: T-001\nAgent: maintainer']);

    // 3. Read it back exactly as dispatch does, from the committed carrier.
    const verified = verifyCommittedAttributedSource(fixture.root, PRODUCED_REF, { taskId: 'T-001' });
    assert.equal(verified.ok, true, verified.error);
    const committed = JSON.parse(verified.source);

    // 4. Dispatch accepts the unchanged packet built from that source.
    const prepared = prepare(fixture, { refetchDecomposition: () => committed });
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(prepared.packet.decomposition.sourceRef, PRODUCED_REF);
    assert.equal(prepared.packet.decomposition.sourceDigest, committed.sourceDigest);
    assert.equal(prepared.packet.decomposition.inventoryComplete, true);
  });

  it('blocks the same path when authoritative membership changes after production', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-membership');
    const produced = await produce(fixture);
    assert.equal(produced.status, 0, produced.stderr);
    const committed = JSON.parse(produced.stdout);

    // A newly authored task appears on the authoritative surface after the
    // scan. It is committed, so the clean-state gate is satisfied and the
    // inventory binding is what refuses the dispatch. The dispatched task's own
    // carrier is byte-identical.
    writeFileSync(
      join(fixture.root, '.agenticloop', 'tasks', 'T-500.md'),
      taskBody({ taskId: 'T-500', ownedPaths: ['src/lane-z/**'] }),
      'utf8',
    );
    git(fixture.root, ['add', '.agenticloop/tasks/T-500.md']);
    git(fixture.root, ['commit', '-m', 'author a later task\n\nTask: T-500\nAgent: maintainer']);
    const refused = prepare(fixture, { refetchDecomposition: () => committed });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /inventory membership or task carrier digest changed/);
  });

  it('blocks the same path when the bound readiness evidence changes after production', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-evidence');
    const produced = await produce(fixture);
    assert.equal(produced.status, 0, produced.stderr);
    const committed = JSON.parse(produced.stdout);

    const movedBase = {
      ...fixture.readiness.evidence.base,
      identity: `git-tree:${'e'.repeat(40)}`,
      revalidationArgs: ['--base', 'e'.repeat(40)],
    };
    const refused = prepare(fixture, {
      refetchDecomposition: () => committed,
      refetchReadiness: () => ({
        ...fixture.readiness,
        evidence: { ...fixture.readiness.evidence, base: movedBase },
      }),
    });
    assert.equal(refused.ok, false);
    assert.match(refused.validation.errors.join('\n'), /base evidence changed after the scan|readiness/i);
  });

  it('returns canonical fail-closed diagnostics when bound evidence is not attributed to the task', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-unattributed');
    const refused = await produce(fixture, { taskId: 'T-404' });
    assert.equal(refused.status, 1);
    const result = JSON.parse(refused.stdout);
    assert.equal(result.kind, 'agenticloop.validation-result');
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('refuses to produce a source for a task the authoritative scan does not report ready', () => {
    // The producer path itself, with the enumerator injected: a work unit whose
    // authoritative surface does not contain the target task cannot yield a
    // decomposition, no matter what the caller asked for.
    const inventory = filesInventory([{ taskId: 'T-001' }]);
    const prepared = prepareDecompositionSource({
      enumerateInventory: () => inventory,
      workUnit: { id: 'milestone-alpha', backend: 'files' },
      taskId: 'T-404',
      sourceRef: '.agenticloop/decompositions/milestone-alpha.json',
      sourceRevision: `git-blob:${'a'.repeat(40)}`,
      observedAt: OBSERVED_AT,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths: BASE_PATHS,
      readinessContext: { base: BASE_EVIDENCE, dependencies: null },
      rescanTrigger: 'inventory membership changes',
    }, { now: NOW });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.decomposition, null);
    assert.equal(prepared.source, null);
    assert.equal(prepared.validation.kind, 'agenticloop.validation-result');
    assert.match(prepared.validation.errors.join('\n'), /does not authorize this task as ready/);
  });

  it('never emits a source whose scan the consumer validator would reject', () => {
    const prepared = prepareDecompositionSource({
      enumerateInventory: () => filesInventory([{ taskId: 'T-001' }]),
      workUnit: { id: 'milestone-alpha', backend: 'files' },
      taskId: 'T-001',
      sourceRef: '.agenticloop/decompositions/milestone-alpha.json',
      sourceRevision: `git-blob:${'a'.repeat(40)}`,
      observedAt: OBSERVED_AT,
      freshnessPolicy: { maxAgeSeconds: 3600 },
      basePaths: BASE_PATHS,
      readinessContext: { base: BASE_EVIDENCE, dependencies: dependencyEvidence() },
      rescanTrigger: 'inventory membership changes',
    }, { now: NOW });
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
    assert.equal(validateParallelScanRecord(prepared.scan, { now: NOW }).ok, true);
    assert.equal(prepared.source, `${canonicalJson(prepared.decomposition)}\n`);
  });

  it('refuses to run without an authoritative enumerator', () => {
    const prepared = prepareDecompositionSource({ taskId: 'T-001' });
    assert.equal(prepared.ok, false);
    assert.match(prepared.validation.errors.join('\n'), /authoritative task-inventory enumerator is required/);
  });

  it('refuses a claimed parallel route the authoritative scan does not support', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-route');
    const refused = await produce(fixture, { route: 'parallel' });
    assert.equal(refused.status, 1);
    assert.match(JSON.parse(refused.stdout).errors.join('\n'), /parallel candidate pair|parallel route is blocked/i);
  });

  it('excludes explicit pull-request entries from the GitHub task-issue surface', async () => {
    const fixture = await createDispatchFixture(temp, 'produce-github-prs');
    const projectPath = join(fixture.root, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf8').replace('task_backend: files', 'task_backend: github'),
      'utf8'
    );
    const task = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');
    // The REST issues endpoint returns pull requests interleaved with issues,
    // including one whose body would otherwise parse as a task record.
    const pages = [
      [
        { number: 100, state: 'open', title: 'Fix T-001', body: task, labels: [{ name: 'task:T-001' }],
          pull_request: { url: 'https://api.github.test/repos/owner/repository/pulls/100' } },
        { number: 101, state: 'open', title: 'Task T-001', body: task, labels: [{ name: 'task:T-001' }] },
      ],
      [
        { number: 102, state: 'closed', title: 'Old PR', body: task.replaceAll('T-001', 'T-002'), labels: [],
          pull_request: { url: 'https://api.github.test/repos/owner/repository/pulls/102', merged_at: null } },
      ],
    ];
    const ghCommandRunner = (_command, args) => {
      if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
        return { status: 0, stdout: JSON.stringify(pages), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
    };
    const produced = await produce(fixture, { repo: 'owner/repository', io: { ghCommandRunner } });
    assert.equal(produced.status, 0, `${produced.stdout}${produced.stderr}`);
    const decomposition = JSON.parse(produced.stdout);

    // Exactly one task carrier exists: the issue. Neither pull request became
    // one, and the PR that carries a task-shaped body did not smuggle T-002 in.
    const carriers = decomposition.scan.inventory.members.map(member => member.carrier);
    assert.deepEqual(carriers, ['issue:101']);
    assert.equal(carriers.includes('issue:100'), false, 'a pull request must never become a task carrier');
    assert.equal(carriers.includes('issue:102'), false, 'a pull request must never become a task carrier');
    assert.equal(
      decomposition.scan.inventory.members.some(member => member.taskId === 'T-002'),
      false,
      'a task-shaped pull-request body must not enter the task inventory'
    );

    // Enumeration coverage is defined over the task-issue surface *after* PR
    // filtering: `discovered` counts entries that could carry a task record,
    // not raw REST rows. Counting raw rows here would report discovered=3 for a
    // returned=1 inventory and make a complete issue inventory look truncated.
    const coverage = decomposition.scan.inventory.enumeration.coverage;
    // Raw transport rows and normalized task-issue count are distinguishable
    // here: the transport returned three rows across two pages, and exactly one
    // of them is a task carrier.
    assert.equal(pages.flat().length, 3, 'the transport returned three raw REST rows');
    assert.equal(pages.length, 2, 'across two pages');
    assert.equal(coverage.discovered, 1);
    assert.equal(coverage.returned, 1);
    assert.equal(coverage.pageCount, 2, 'every observed REST page is still accounted for');
    assert.equal(coverage.truncated, false);
    assert.equal(coverage.cursor, null);
    assert.equal(decomposition.scan.inventory.enumeration.completion, 'exhaustive');
    assert.equal(decomposition.scan.inventory.complete, true,
      'pull requests on the issues endpoint must not make a complete issue inventory incomplete');
  });

  /**
   * The transport-completion boundary.
   *
   * `gh api --paginate --slurp` returning successfully is the *only* evidence
   * the enumeration treats as proof that pagination was exhausted. A short
   * non-final page is deliberately not read as truncation: the REST API is free
   * to return fewer than `per_page` items on any page, so that heuristic would
   * report false truncation on ordinary complete inventories. Everything the
   * boundary can genuinely tell us - the command failed, or its output is not a
   * page inventory - fails closed instead.
   */
  describe('GitHub enumeration transport boundary', () => {
    async function enumerateWith(name, ghCommandRunner) {
      const fixture = await createDispatchFixture(temp, name);
      const projectPath = join(fixture.root, '.agenticloop', 'project.md');
      writeFileSync(
        projectPath,
        readFileSync(projectPath, 'utf8').replace('task_backend: files', 'task_backend: github'),
        'utf8'
      );
      return produce(fixture, { repo: 'owner/repository', io: { ghCommandRunner } });
    }

    it('fails closed when the paginated command itself fails', async () => {
      let paginateCalls = 0;
      const produced = await enumerateWith('enum-command-failure', (_command, args) => {
        if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
          paginateCalls += 1;
          return { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded' };
        }
        return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
      });
      assert.equal(paginateCalls, 1, 'the enumeration must actually attempt the paginated command');
      assert.equal(produced.status, 1, produced.stdout + produced.stderr);
      assert.doesNotMatch(
        produced.stdout,
        /"complete"\s*:\s*true/,
        'a failed transport must never yield a complete inventory'
      );
    });

    const MALFORMED = [
      ['a bare object instead of pages', JSON.stringify({ number: 101 })],
      ['a flat issue array instead of pages', JSON.stringify([{ number: 101 }])],
      ['an empty page inventory', JSON.stringify([])],
      ['a page inventory containing a non-array page', JSON.stringify([[], { number: 101 }])],
      ['a null page', JSON.stringify([null])],
      ['a JSON scalar', '42'],
      ['unparseable output', 'not json at all'],
    ];

    for (const [label, stdout] of MALFORMED) {
      it(`fails closed on ${label}`, async () => {
        const produced = await enumerateWith(
          `enum-malformed-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 20)}`,
          (_command, args) => {
            if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
              return { status: 0, stdout, stderr: '' };
            }
            return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
          }
        );
        assert.equal(produced.status, 1, produced.stdout + produced.stderr);
        assert.doesNotMatch(produced.stdout, /"complete"\s*:\s*true/);
      });
    }

    it('processes every returned page, including carriers on a later page', async () => {
      const fixture = await createDispatchFixture(temp, 'enum-all-pages');
      const projectPath = join(fixture.root, '.agenticloop', 'project.md');
      writeFileSync(
        projectPath,
        readFileSync(projectPath, 'utf8').replace('task_backend: files', 'task_backend: github'),
        'utf8'
      );
      const task = readFileSync(join(fixture.root, '.agenticloop', 'tasks', 'T-001.md'), 'utf8');
      // A carrier on the first page, an empty middle page, and a carrier on the
      // last page. A reader that stopped at the first short page would miss the
      // third page entirely.
      const pages = [
        [{ number: 101, state: 'open', title: 'Task T-001', body: task, labels: [{ name: 'task:T-001' }] }],
        [],
        [{
          number: 103, state: 'open', title: 'Task T-002',
          body: task.replaceAll('T-001', 'T-002'), labels: [{ name: 'task:T-002' }],
        }],
      ];
      const produced = await produce(fixture, {
        repo: 'owner/repository',
        io: {
          ghCommandRunner: (_command, args) => {
            if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
              return { status: 0, stdout: JSON.stringify(pages), stderr: '' };
            }
            return { status: 1, stdout: '', stderr: `unexpected fake GitHub call: ${args.join(' ')}` };
          },
        },
      });
      assert.equal(produced.status, 0, produced.stdout + produced.stderr);
      const decomposition = JSON.parse(produced.stdout);
      const carriers = decomposition.scan.inventory.members.map(member => member.carrier).sort();
      assert.deepEqual(carriers, ['issue:101', 'issue:103'], 'a carrier on the last page must be enumerated');
      const coverage = decomposition.scan.inventory.enumeration.coverage;
      assert.equal(coverage.pageCount, 3);
      assert.equal(coverage.discovered, 2);
      assert.equal(coverage.returned, 2);
      assert.equal(coverage.truncated, false, 'a short middle page is not truncation evidence');
      assert.equal(decomposition.scan.inventory.enumeration.completion, 'exhaustive');
    });
  });
});

describe('task backend selection', () => {
  const temp = mkdtempSync(join(tmpdir(), 'scan-backend-'));
  after(() => rmSync(temp, { recursive: true, force: true }));

  function selectBackend(root, backend) {
    const projectPath = join(root, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf8').replace('task_backend: files', `task_backend: ${backend}`),
      'utf8'
    );
  }

  /** A gh runner that fails the test if the CLI reaches the GitHub transport. */
  function forbiddenGhRunner(calls) {
    return (_command, args) => {
      calls.push(args);
      return { status: 1, stdout: '', stderr: 'the GitHub transport must not be reached' };
    };
  }

  function decompositionArgs(fixture) {
    return [
      'task', 'prepare-decomposition', 'T-001',
      '--work-unit', 'fixture-work-unit',
      '--source-ref', '.agenticloop/decompositions/T-001-produced.json',
      '--source-revision', `git-commit:${git(fixture.root, ['rev-parse', 'HEAD'])}`,
      '--base', fixture.readiness.evidence.base.identity.slice('git-tree:'.length),
      '--dependencies', 'dependencies.json',
      '--json', '--target', fixture.root,
    ];
  }

  function dispatchArgs(fixture) {
    writeFileSync(
      join(fixture.root, 'dispatch-input.json'),
      JSON.stringify({
        readiness: fixture.readiness,
        decomposition: fixture.decomposition,
        assignment: fixture.assignment,
      }),
      'utf8'
    );
    return [
      'task', 'prepare-dispatch', 'T-001',
      '--input', 'dispatch-input.json',
      '--json', '--target', fixture.root,
    ];
  }

  for (const [subcommand, buildArgs] of [
    ['prepare-decomposition', decompositionArgs],
    ['prepare-dispatch', dispatchArgs],
  ]) {
    it(`refuses an unsupported task backend at the root of ${subcommand}`, async () => {
      const fixture = await createDispatchFixture(temp, `unsupported-${subcommand}`);
      selectBackend(fixture.root, 'jira');
      // The command inputs themselves are written first, so the comparison
      // isolates mutation caused by the command from fixture setup.
      const args = buildArgs(fixture);
      const before = git(fixture.root, ['status', '--porcelain']);
      const calls = [];
      const result = await runCliInProcess(args, {
        ghCommandRunner: forbiddenGhRunner(calls),
      });
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      const value = JSON.parse(result.stdout);

      // One typed diagnostic in the existing public vocabulary, and it is the
      // root cause: no derivative inventory or backend-mismatch diagnostic is
      // emitted ahead of it.
      assert.equal(value.kind, 'agenticloop.validation-result');
      assert.equal(value.ok, false);
      assert.equal(value.diagnostics.length, 1);
      assert.equal(value.diagnostics[0].code, 'verification.context.malformed');
      assert.equal(value.evidenceState, 'malformed');
      assert.equal(value.disposition, 'rejected');
      assert.equal(value.rollbackAuthorized, false);
      assert.match(value.errors.join('\n'), /task backend 'jira'.*not supported/i);
      assert.match(value.errors.join('\n'), /github/);
      assert.match(value.errors.join('\n'), /files/);
      assert.equal(
        value.errors.some(error => /inventory|enumeration|parallel[- ]scan|membership/i.test(error)),
        false,
        'no derivative inventory diagnostic may precede the unsupported-backend root cause'
      );

      // Nothing was enumerated and no transport was contacted.
      assert.deepEqual(calls, [], 'no GitHub runner invocation may occur');
      assert.equal(git(fixture.root, ['status', '--porcelain']), before, 'no filesystem mutation may occur');
    });
  }

  it('refuses --repo on the files backend rather than silently ignoring it', async () => {
    const fixture = await createDispatchFixture(temp, 'files-repo-usage');
    const calls = [];
    const result = await runCliInProcess([
      ...decompositionArgs(fixture), '--repo', 'owner/repository',
    ], { ghCommandRunner: forbiddenGhRunner(calls) });
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(value.diagnostics[0].code, 'cli.usage');
    assert.match(value.errors.join('\n'), /--repo names a GitHub repository/);
    assert.deepEqual(calls, []);
  });

  it('keeps the valid files backend behavior unchanged', async () => {
    const fixture = await createDispatchFixture(temp, 'files-still-valid');
    const result = await runCliInProcess(decompositionArgs(fixture));
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const decomposition = JSON.parse(result.stdout);
    assert.equal(decomposition.scan.workUnit.backend, 'files');
    assert.equal(decomposition.scan.inventory.enumeration.enumerator, 'agenticloop.files-task-directory.v1');
  });
});

describe('dependency revalidation selector persistence', () => {
  it('persists a target-relative sourceRef distinct from the semantic source identity', () => {
    const { scan } = filesScan([{ taskId: 'T-001', dependsOn: ['T-000'] }], {
      dependencies: { 'T-000': 'resolved' },
    });
    const dependencies = scan.readinessContext.dependencies;
    // The semantic identity the snapshot declares about itself is not a path;
    // the artifact selector used to reopen the exact snapshot is.
    assert.equal(dependencies.source, 'files:.agenticloop/dependencies.json');
    assert.equal(dependencies.sourceRef, 'dependencies.json');
    assert.equal(validateParallelScanRecord(scan, { now: NOW }).ok, true);
  });

  it('refuses dependency evidence without an exact confined revalidation selector', () => {
    for (const sourceRef of ['/absolute/dependencies.json', '../escape.json', 'C:/deps.json', 'a/../b.json', '']) {
      const evidence = dependencyEvidence({ 'T-000': 'resolved' });
      evidence.revalidationArgs = ['--dependencies', sourceRef];
      const result = filesScan([{ taskId: 'T-001', dependsOn: ['T-000'] }], {
        dependencies: { 'T-000': 'resolved' },
        readinessContext: { base: BASE_EVIDENCE, dependencies: evidence },
      });
      assert.equal(result.ok, false, sourceRef);
      assert.ok(
        result.result.errors.some(error => /revalidation selector/.test(error)),
        `${sourceRef}: ${result.result.errors.join('\n')}`
      );
    }
  });

  it('rejects a record whose persisted selector escapes the target', () => {
    const { scan } = filesScan([{ taskId: 'T-001', dependsOn: ['T-000'] }], {
      dependencies: { 'T-000': 'resolved' },
    });
    for (const sourceRef of ['/absolute/dependencies.json', '../escape.json', 'C:/deps.json']) {
      const tampered = structuredClone(scan);
      tampered.readinessContext.dependencies.sourceRef = sourceRef;
      rehashScan(rehashReadinessContext(tampered));
      const checked = validateParallelScanRecord(tampered, { now: NOW });
      assert.equal(checked.ok, false, sourceRef);
      assert.ok(
        checked.errors.some(error => /sourceRef must be a canonical target-relative artifact path/.test(error)),
        `${sourceRef}: ${checked.errors.join('\n')}`
      );
    }
  });

  it('revalidates the bound selector against the authoritative refetch', () => {
    const { scan } = filesScan([{ taskId: 'T-001', dependsOn: ['T-000'] }], {
      dependencies: { 'T-000': 'resolved' },
    });
    const moved = dependencyEvidence({ 'T-000': 'resolved' });
    moved.revalidationArgs = ['--dependencies', 'other/dependencies.json'];
    const rebound = validateParallelScanReadinessBinding(scan, {
      base: BASE_EVIDENCE,
      dependencies: moved,
    });
    assert.equal(rebound.ok, false);
    assert.ok(rebound.errors.some(error => /revalidation selector changed/.test(error)));
  });

  it('routes an authentic schemaVersion 1 record to typed regeneration with the exact repair command', () => {
    const { scan } = filesScan([{ taskId: 'T-001', dependsOn: ['T-000'] }], {
      dependencies: { 'T-000': 'resolved' },
    });
    const legacy = structuredClone(scan);
    legacy.schemaVersion = 1;
    delete legacy.readinessContext.dependencies.sourceRef;
    const checked = validateParallelScanRecord(legacy, { now: NOW });
    assert.equal(checked.ok, false);
    const message = checked.errors.find(error => /superseded/.test(error));
    assert.ok(message, checked.errors.join('\n'));
    assert.match(message, /task prepare-decomposition <id> --work-unit <id> --source-ref <path> --source-revision <ref> --base <ref-or-tree> --dependencies <path>/);
  });
});
