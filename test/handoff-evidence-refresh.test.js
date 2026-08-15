import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

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

let root;

before(() => { root = mkdtempSync(join(tmpdir(), 'al-refresh-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

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
    assert.ok(result.errors.some(error => error.includes('changedFiles must exactly match')), result.errors.join('; '));
  });

  it('rejects trailing JSON through the public parser boundary', () => {
    const value = target();
    const path = join(value, 'plan.json');
    writeFileSync(path, '{"kind":"agenticloop.handoff-evidence-refresh-plan"}\ntrailing', 'utf8');
    assert.throws(() => JSON.parse(readFileSync(path, 'utf8')), /Unexpected token|Unexpected non-whitespace/);
  });
});
