/**
 * Lifecycle plan schema, validation, parity, and kernel tests (Phase 28).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  LIFECYCLE_PLAN_SCHEMA_VERSION,
  applyLifecyclePlan,
  formatPartialApplyDiagnostics,
  hashFileOrNull,
  lifecyclePlanBlockers,
  lifecyclePlanCounts,
  lifecyclePlanFromJson,
  lifecyclePlanToJson,
  preflightLifecyclePlan,
  renderLifecyclePlan,
  validateLifecyclePlan,
} from '../src/lifecycle-plan.js';
import { executeMutationBatch } from '../src/fs-mutation-kernel.js';
import { planInit } from '../src/init-plan.js';
import { init, initExecHandler } from '../src/init.js';
import { createIo } from '../src/cli-io.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-lifecycle-plan-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function makeTarget() {
  return mkdtempSync(join(tmpBase, 'target-'));
}

function quietIo() {
  const sink = { write: () => true };
  return createIo({ stdout: sink, stderr: sink });
}

function minimalPlan() {
  return {
    schemaVersion: LIFECYCLE_PLAN_SCHEMA_VERSION,
    command: 'init',
    actions: [
      {
        kind: 'create',
        path: 'file.txt',
        category: 'state',
        ownership: 'agenticloop-owned',
        reason: 'test',
        content: 'hello',
        baseHash: null,
      },
    ],
    adapterGroups: [],
    blockers: [],
    warnings: [],
  };
}

describe('lifecycle plan schema', () => {
  it('exports schema version 1', () => {
    assert.equal(LIFECYCLE_PLAN_SCHEMA_VERSION, 1);
  });

  it('accepts the documented plan shape', () => {
    const plan = minimalPlan();
    assert.equal(validateLifecyclePlan(plan), plan);
  });

  it('rejects unknown schema versions', () => {
    const plan = { ...minimalPlan(), schemaVersion: 2 };
    assert.throws(() => validateLifecyclePlan(plan), /unsupported schemaVersion 2/);
  });

  it('rejects unknown plan fields', () => {
    const plan = { ...minimalPlan(), surprise: true };
    assert.throws(() => validateLifecyclePlan(plan), /unknown plan field 'surprise'/);
  });

  it('rejects unknown action kinds', () => {
    const plan = minimalPlan();
    plan.actions[0] = { ...plan.actions[0], kind: 'explode' };
    assert.throws(() => validateLifecyclePlan(plan), /unknown kind 'explode'/);
  });

  it('rejects unknown action fields', () => {
    const plan = minimalPlan();
    plan.actions[0] = { ...plan.actions[0], nope: 1 };
    assert.throws(() => validateLifecyclePlan(plan), /unknown field 'nope'/);
  });

  it('rejects unsafe action paths through the canonical kernel validator', () => {
    for (const path of [
      './x',          // dot segment
      'a//b',         // empty segment
      'C:/escape',    // drive-qualified
      '/abs/escape',  // absolute
      '../escape.txt',// traversal
      'a/../../b',    // nested traversal
      'a\\b',         // backslash
      'a\0b',         // NUL byte
      '.',            // bare dot
      '..',           // bare traversal
    ]) {
      const plan = minimalPlan();
      plan.actions[0] = { ...plan.actions[0], path };
      assert.throws(() => validateLifecyclePlan(plan), /unsafe path/, `path '${path}' must be rejected`);
    }
  });

  it('rejects invalid action execution descriptors before any filesystem operation', () => {
    const withExec = (exec) => {
      const plan = minimalPlan();
      plan.actions[0] = {
        kind: 'merge', path: 'AGENTS.md', category: 'guidance', ownership: 'shared',
        reason: 'test', exec,
      };
      return plan;
    };
    assert.throws(() => validateLifecyclePlan(withExec('guidance')), /non-object exec/);
    assert.throws(() => validateLifecyclePlan(withExec({ type: 'frobnicate' })), /unknown exec type/);
    assert.throws(() => validateLifecyclePlan(withExec({
      type: 'rename',
      from: '../x',
      to: 'AGENTS.md',
      fromBaseHash: 'source-hash',
      toBaseHash: null,
    })), /rename exec path is unsafe/);
    assert.throws(() => validateLifecyclePlan(withExec({ type: 'rename', from: 'a' })), /needs string 'from' and 'to'/);
    assert.throws(() => validateLifecyclePlan(withExec({
      type: 'rename', from: 'a', to: 'AGENTS.md', toBaseHash: null,
    })), /needs string 'fromBaseHash'/);
    assert.throws(() => validateLifecyclePlan(withExec({ type: 'project-map' })), /needs an object 'values'/);
    assert.throws(() => validateLifecyclePlan(withExec({ type: 'project-map', values: [] })), /needs an object 'values'/);
    assert.throws(() => validateLifecyclePlan(withExec({ type: 'guidance', refreshOnly: 'yes' })), /refreshOnly.*boolean/);
  });

  it('requires deterministic content for create/update actions', () => {
    const plan = minimalPlan();
    delete plan.actions[0].content;
    assert.throws(() => validateLifecyclePlan(plan), /no deterministic content/);
  });

  it('round-trips through the versioned JSON document', () => {
    const plan = minimalPlan();
    const text = lifecyclePlanToJson(plan);
    const parsed = JSON.parse(text);
    assert.equal(parsed.schemaVersion, 1);
    assert.deepEqual(lifecyclePlanFromJson(text), plan);
  });

  it('counts actions by kind including adapter groups', () => {
    const plan = minimalPlan();
    plan.actions.push({
      kind: 'skip', path: 'keep.txt', category: 'state', ownership: 'target-owned', reason: 'kept',
    });
    plan.adapterGroups.push({ adapters: ['codex'], outputRoot: '.', actions: [], files: ['a', 'b'], blocked: [{ relPath: 'c', message: 'blocked' }] });
    const counts = lifecyclePlanCounts(plan);
    assert.deepEqual(counts, { create: 1, update: 0, merge: 0, remove: 0, skip: 1, blocked: 1, adapter: 2 });
    assert.equal(lifecyclePlanBlockers(plan).length, 1);
  });
});

describe('lifecycle apply', () => {
  it('applies the planned actions for unchanged state (plan/apply parity)', () => {
    const target = makeTarget();
    const plan = planInit({ target });
    assert.equal(plan.blockers.length, 0);
    // The init plan must include the AGENTS.md activation-guidance action;
    // guidance is a planned mutation, not a post-init side effect.
    const guidanceAction = plan.actions.find(a => a.category === 'guidance');
    assert.ok(guidanceAction, 'init plan must include the AGENTS.md guidance action');
    assert.equal(guidanceAction.path, 'AGENTS.md');
    assert.equal(guidanceAction.kind, 'merge');
    assert.equal(guidanceAction.exec?.type, 'guidance');
    const applied = applyLifecyclePlan(target, plan, { execHandler: initExecHandler });
    assert.equal(applied.ok, true, applied.errors.join('\n'));
    assert.ok(applied.created.length > 0);
    assert.ok(existsSync(join(target, 'agenticloop', 'manifest.json')));
    assert.ok(existsSync(join(target, '.agenticloop', 'project.md')));
    assert.equal(applied.skipped.length, plan.actions.filter(a => a.kind === 'skip').length);
    // The applied mutation set matches the plan: every mutating planned action
    // is reported exactly once, and the guidance merge was applied.
    assert.ok(applied.merged.some(entry => entry.startsWith('guidance:')),
      `guidance merge must be applied, got merged=${JSON.stringify(applied.merged)}`);
    assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf-8'), /AGENTICLOOP_START/);
  });

  it('init --dry-run --json contains the guidance action and performs zero writes', async () => {
    const target = makeTarget();
    const stdout = [];
    const io = createIo({ stdout: { write: chunk => { stdout.push(chunk); return true; } }, stderr: { write: () => true } });
    const result = await init({ target, io, dryRun: true, json: true });
    assert.equal(result.errors.length, 0);
    const parsed = JSON.parse(stdout.join(''));
    assert.equal(parsed.schemaVersion, 1);
    const guidanceAction = parsed.actions.find(a => a.category === 'guidance');
    assert.ok(guidanceAction, 'JSON plan must include the AGENTS.md guidance action');
    assert.equal(guidanceAction.path, 'AGENTS.md');
    assert.equal(existsSync(join(target, 'AGENTS.md')), false, 'dry-run must not write');
    assert.equal(existsSync(join(target, 'agenticloop')), false, 'dry-run must not write');
  });

  it('JSON plan parity: applying the parsed plan to an unchanged equivalent target performs exactly the planned mutations', async () => {
    const planTarget = makeTarget();
    const applyTarget = makeTarget();
    // 1. Compute the init JSON plan on a fresh target.
    const stdout = [];
    const io = createIo({ stdout: { write: chunk => { stdout.push(chunk); return true; } }, stderr: { write: () => true } });
    const planned = await init({ target: planTarget, io, dryRun: true, json: true });
    assert.equal(planned.errors.length, 0);
    // 2. Parse and validate the plan document, then apply it to an unchanged
    //    equivalent target.
    const plan = lifecyclePlanFromJson(stdout.join(''));
    const applied = applyLifecyclePlan(applyTarget, plan, { execHandler: initExecHandler });
    assert.equal(applied.ok, true, applied.errors.join('\n'));
    // 3. Observed mutations match the planned actions exactly.
    const plannedMutations = plan.actions.filter(a => a.kind !== 'skip' && a.kind !== 'blocked');
    const observed = [...applied.created, ...applied.updated, ...applied.removed, ...applied.merged];
    assert.equal(observed.length, plannedMutations.length,
      `observed ${observed.length} mutations but the plan declared ${plannedMutations.length}`);
    // 4. The AGENTS.md guidance action is explicitly planned and applied.
    const guidanceAction = plan.actions.find(a => a.category === 'guidance');
    assert.ok(guidanceAction, 'JSON plan must include the AGENTS.md guidance action');
    assert.ok(applied.merged.some(entry => entry.startsWith('guidance:')),
      'guidance action must appear in the applied mutations');
    assert.match(readFileSync(join(applyTarget, 'AGENTS.md'), 'utf-8'), /AGENTICLOOP_START/);
  });

  it('fails safely when target state changes between plan and apply', () => {
    const target = makeTarget();
    const plan = planInit({ target });
    // Simulate drift: a planned create now exists.
    mkdirSync(join(target, 'agenticloop'), { recursive: true });
    writeFileSync(join(target, 'agenticloop', 'manifest.json'), '{}', 'utf-8');
    const stale = preflightLifecyclePlan(target, plan);
    assert.ok(stale.length > 0);
    const applied = applyLifecyclePlan(target, plan);
    assert.equal(applied.ok, false);
    assert.equal(applied.stale, true);
    assert.match(applied.errors[0], /changed since the plan was computed/);
  });

  it('fails stale legacy rename plans before creating destination directories', () => {
    const target = makeTarget();
    copyFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), join(target, 'AGENTIC_LOOP.md'));
    const plan = planInit({ target, agentsGuidance: false });
    const rename = plan.actions.find(action => action.exec?.type === 'rename');
    assert.ok(rename, 'expected a legacy rename action');

    rmSync(join(target, rename.exec.from));
    const applied = applyLifecyclePlan(target, plan, { execHandler: initExecHandler });

    assert.equal(applied.ok, false);
    assert.equal(applied.stale, true);
    assert.equal(applied.partialApply, false);
    assert.deepEqual(applied.committedSegments, []);
    assert.equal(applied.failedSegment, null, 'full-plan preflight must fail before a segment starts');
    assert.equal(existsSync(join(target, 'agenticloop')), false, 'stale preflight must perform zero writes');
    assert.match(applied.errors.join('\n'), /rename source .* changed since the plan was computed/);
  });

  it('refresh pruning plans and removes stale empty directories', async () => {
    const target = makeTarget();
    const first = await init({ target, agentsGuidance: false, io: quietIo() });
    assert.deepEqual(first.errors, []);
    const staleDir = join(target, 'agenticloop', 'stale-empty');
    mkdirSync(staleDir, { recursive: true });

    const plan = planInit({ target, refreshAssets: true, agentsGuidance: false });
    const removal = plan.actions.find(action => action.path === 'agenticloop/stale-empty');
    assert.ok(removal, 'the empty stale directory must be represented in the plan');
    assert.equal(removal.kind, 'remove');
    assert.equal(removal.directory, true);

    const applied = applyLifecyclePlan(target, plan, { execHandler: initExecHandler });
    assert.equal(applied.ok, true, applied.errors.join('\n'));
    assert.equal(existsSync(staleDir), false);
  });

  it('removes duplicate legacy directory trees through file and empty-directory actions', async () => {
    const target = makeTarget();
    const first = await init({ target, agentsGuidance: false, io: quietIo() });
    assert.deepEqual(first.errors, []);
    cpSync(join(target, 'agenticloop', 'agents'), join(target, 'agents'), { recursive: true });

    const plan = planInit({ target, agentsGuidance: false });
    assert.ok(plan.actions.some(action => action.path === 'agents' && action.directory === true));
    assert.equal(
      plan.actions.some(action => action.path === 'agents' && action.directory !== true),
      false,
      'the duplicate tree must not become an unsafe recursive remove',
    );

    const applied = applyLifecyclePlan(target, plan, { execHandler: initExecHandler });
    assert.equal(applied.ok, true, applied.errors.join('\n'));
    assert.equal(existsSync(join(target, 'agents')), false);
  });

  it('does not claim rollback when an exec handler throws after mutation', () => {
    const target = makeTarget();
    const plan = {
      schemaVersion: LIFECYCLE_PLAN_SCHEMA_VERSION,
      command: 'init',
      actions: [{
        kind: 'merge',
        path: 'marker.txt',
        category: 'guidance',
        ownership: 'shared',
        reason: 'adversarial exec handler',
        exec: { type: 'guidance' },
      }],
      adapterGroups: [],
      blockers: [],
      warnings: [],
    };
    const applied = applyLifecyclePlan(target, plan, {
      execHandler: () => {
        writeFileSync(join(target, 'residue.txt'), 'partial', 'utf-8');
        throw new Error('injected exec failure');
      },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.partialApply, true);
    assert.equal(applied.failedSegment?.rolledBack, false);
    assert.match(formatPartialApplyDiagnostics(applied).join('\n'), /could not confirm a complete rollback/);
    assert.doesNotMatch(formatPartialApplyDiagnostics(applied).join('\n'), /was rolled back internally/);
  });

  it('plan counts equal detailed action counts', () => {
    const target = makeTarget();
    const plan = planInit({ target });
    const counts = lifecyclePlanCounts(plan);
    const sum = counts.create + counts.update + counts.merge + counts.remove + counts.skip + counts.blocked;
    assert.equal(sum, plan.actions.length + plan.adapterGroups.reduce((n, g) => n + g.blocked.length, 0));
  });

  it('blockers stop every write', () => {
    const target = makeTarget();
    const plan = minimalPlan();
    plan.blockers.push('nope');
    const applied = applyLifecyclePlan(target, plan);
    assert.equal(applied.ok, false);
    assert.deepEqual(applied.errors, ['nope']);
    assert.equal(existsSync(join(target, 'file.txt')), false);
  });

  it('rolls back a batch and reports rollback evidence on injected failure', () => {
    const target = makeTarget();
    writeFileSync(join(target, 'existing.txt'), 'original', 'utf-8');
    const result = executeMutationBatch(target, [
      { type: 'write', path: 'existing.txt', content: 'updated' },
      { type: 'write', path: 'new-file.txt', content: 'new' },
      // Invalid content type forces a post-snapshot write failure.
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(target, 'existing.txt'), 'utf-8'), 'original');
    assert.equal(existsSync(join(target, 'new-file.txt')), false);
    assert.ok(Array.isArray(result.rollbackErrors));
  });

  it('cleans transaction-created empty directories on rollback', () => {
    const target = makeTarget();
    const result = executeMutationBatch(target, [
      { type: 'mkdir', path: 'fresh/nested' },
      { type: 'write', path: 'fresh/nested/file.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(target, 'fresh')), false);
  });

  it('cross-segment contract: fail-stop, committed segments kept, failed segment rolled back, rerun repairs', async () => {
    const target = makeTarget();
    writeFileSync(join(target, 'victim.txt'), 'original', 'utf-8');
    // A file blocks directory creation so the second batch fails mid-segment.
    writeFileSync(join(target, 'blocker'), 'file', 'utf-8');
    const hash = (p) => hashFileOrNull(join(target, p));
    const execAction = (path, label) => ({
      kind: 'merge', path, category: 'guidance', ownership: 'shared',
      reason: 'test exec', display: label, exec: { type: 'guidance' },
    });
    const plan = {
      schemaVersion: LIFECYCLE_PLAN_SCHEMA_VERSION,
      command: 'setup',
      actions: [
        { kind: 'create', path: 'first.txt', category: 'state', ownership: 'target-owned', reason: 'segment 1', content: 'one', baseHash: null },
        execAction('marker1.txt', 'marker 1'),
        { kind: 'update', path: 'victim.txt', category: 'state', ownership: 'target-owned', reason: 'segment 3', content: 'changed', baseHash: hash('victim.txt') },
        { kind: 'create', path: 'blocker/child.txt', category: 'state', ownership: 'target-owned', reason: 'failing write', content: 'x', baseHash: null },
        execAction('marker2.txt', 'marker 2'),
        { kind: 'create', path: 'later.txt', category: 'state', ownership: 'target-owned', reason: 'later segment', content: 'later', baseHash: null },
      ],
      adapterGroups: [],
      blockers: [],
      warnings: [],
    };
    const executedExecs = [];
    const execHandler = (action) => {
      executedExecs.push(action.path);
      return { ok: true, changed: true, display: action.display };
    };
    const applied = applyLifecyclePlan(target, plan, { execHandler });

    // 1. Earlier committed state is reported as committed.
    assert.equal(applied.ok, false);
    assert.equal(applied.partialApply, true, 'partial application must be reported');
    assert.deepEqual(applied.committedSegments, ['create first.txt', 'marker 1']);
    // 2. The failed segment is identified and was rolled back internally.
    assert.equal(applied.failedSegment?.kind, 'batch');
    assert.ok(applied.errors.length > 0, 'primary error must be reported');
    assert.equal(readFileSync(join(target, 'victim.txt'), 'utf-8'), 'original',
      'the failed segment must restore its own pre-state byte-for-byte');
    // Committed segments are NOT globally rolled back.
    assert.equal(readFileSync(join(target, 'first.txt'), 'utf-8'), 'one');
    // 3. No later segment executes.
    assert.deepEqual(executedExecs, ['marker1.txt'], 'the exec after the failed segment must not run');
    assert.equal(existsSync(join(target, 'later.txt')), false, 'the batch after the failed segment must not run');
    // 4. Partial application is reported clearly in human diagnostics.
    const diagnostics = formatPartialApplyDiagnostics(applied).join('\n');
    assert.match(diagnostics, /Partial application: 2 segment\(s\) committed/);
    assert.match(diagnostics, /Failed segment/);
    assert.match(diagnostics, /re-run agenticloop setup or init to repair/);

    // 5. Rerunning init over the partial state completes safely and
    //    idempotently: the partial scaffold is repaired, and a second rerun
    //    plans zero mutations.
    rmSync(join(target, 'blocker'));
    const repaired = await init({ target, io: quietIo() });
    assert.equal(repaired.errors.length, 0, repaired.errors.join('\n'));
    assert.ok(existsSync(join(target, 'agenticloop', 'manifest.json')));
    assert.equal(readFileSync(join(target, 'first.txt'), 'utf-8'), 'one', 'committed state is preserved');
    const rerunPlan = planInit({ target });
    const rerunMutations = rerunPlan.actions.filter(a => a.kind !== 'skip' && a.kind !== 'blocked');
    assert.deepEqual(rerunMutations, [], `rerun must be idempotent, got: ${JSON.stringify(rerunMutations.map(a => `${a.kind}:${a.path}`))}`);
  });

  it('rolls back and reports explicitly when a Windows-realistic EPERM blocks a rename', { skip: platform() !== 'win32' }, () => {
    const target = makeTarget();
    const protectedPath = join(target, 'protected.txt');
    writeFileSync(protectedPath, 'original', 'utf-8');
    // Read-only destination: rename over it fails with EPERM on Windows.
    chmodSync(protectedPath, 0o444);
    try {
      const result = executeMutationBatch(target, [
        { type: 'write', path: 'other.txt', content: 'other' },
        { type: 'write', path: 'protected.txt', content: 'updated' },
      ]);
      assert.equal(result.ok, false, 'read-only rename target must fail on Windows');
      assert.match(result.errors[0], /EPERM|operation not permitted/i);
      assert.equal(existsSync(join(target, 'other.txt')), false, 'earlier writes roll back');
      assert.equal(readFileSync(protectedPath, 'utf-8'), 'original');
    } finally {
      chmodSync(protectedPath, 0o666);
    }
  });

  it('surfaces rollback errors explicitly when restore itself is obstructed', { skip: platform() !== 'win32' }, () => {
    const target = makeTarget();
    const lockedPath = join(target, 'locked.txt');
    writeFileSync(lockedPath, 'original', 'utf-8');
    // Make the whole target read-only: the primary write and the rollback
    // restore both fail, so rollbackErrors must be populated explicitly.
    chmodSync(lockedPath, 0o444);
    chmodSync(target, 0o555);
    try {
      const result = executeMutationBatch(target, [
        { type: 'write', path: 'created.txt', content: 'new' },
        { type: 'write', path: 'locked.txt', content: 'updated' },
      ]);
      assert.equal(result.ok, false);
      assert.ok(result.rollbackErrors.length > 0 || !existsSync(join(target, 'created.txt')),
        'rollback failure is reported explicitly, never silently');
    } finally {
      chmodSync(target, 0o777);
      chmodSync(lockedPath, 0o666);
    }
  });

  it('second apply of the same planned end state is a no-op', async () => {
    const target = makeTarget();
    const first = await init({ target, io: quietIo() });
    assert.equal(first.errors.length, 0);
    const secondPlan = planInit({ target });
    const mutating = secondPlan.actions.filter(a => a.kind !== 'skip');
    assert.deepEqual(mutating, [], `expected zero second-run mutations, got: ${JSON.stringify(mutating.map(a => `${a.kind}:${a.path}`))}`);
  });
});

describe('init plan composition', () => {
  it('plans adapter groups from the canonical adapter planners', () => {
    const target = makeTarget();
    const plan = planInit({ target, adapter: 'opencode' });
    assert.equal(plan.blockers.length, 0, plan.blockers.join('\n'));
    assert.equal(plan.adapterGroups.length, 1);
    assert.ok(plan.adapterGroups[0].files.length > 0);
    assert.equal(plan.adapterGroups[0].blocked.length, 0);
  });

  it('adapter collisions match generation-transaction rules', async () => {
    const target = makeTarget();
    const first = await init({ target, adapter: 'opencode', io: quietIo() });
    assert.equal(first.errors.length, 0);
    // Modify an owned generated artifact: replanning must surface a blocked collision.
    const agentFile = join(target, '.opencode', 'agents', 'orchestrator.md');
    assert.ok(existsSync(agentFile));
    writeFileSync(agentFile, 'user edit\n', 'utf-8');
    const plan = planInit({ target, adapter: 'opencode' });
    assert.equal(plan.adapterGroups.length, 1);
    assert.ok(plan.adapterGroups[0].blocked.length > 0,
      'a modified owned artifact must block the plan exactly like generation-transaction');
    assert.match(plan.adapterGroups[0].blocked[0].message, /modified/i);
    // A blocked adapter group stops the entire apply before any write.
    const applied = applyLifecyclePlan(target, plan);
    assert.equal(applied.ok, false);
    assert.ok(applied.errors.some(error => error.startsWith('BLOCKED')));
    // forceGenerated refreshes a modified artifact proven owned, mirroring update.
    const { generateAdapterArtifacts } = await import('../src/adapter-generation.js');
    const forced = generateAdapterArtifacts({
      target,
      alConfig: (await import('../src/json.js')).loadAgenticLoopConfig(join(target, 'agenticloop.json')),
      adapter: 'opencode',
      forceGenerated: true,
    });
    assert.equal(forced.ok, true, forced.errors.join('\n'));
  });

  it('renders concise human plans and verbose paths', () => {
    const target = makeTarget();
    const plan = planInit({ target });
    const concise = renderLifecyclePlan(plan, { dryRun: true }).join('\n');
    assert.match(concise, /Plan \(dry run/);
    assert.match(concise, /Create\s+\d+/);
    assert.ok(!concise.includes('agenticloop/AGENTIC_LOOP.md'));
    const verbose = renderLifecyclePlan(plan, { dryRun: true, verbose: true }).join('\n');
    assert.ok(verbose.includes('agenticloop/AGENTIC_LOOP.md'));
  });

  it('repairs a partial target: current layout with missing project map', () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    const plan = planInit({ target });
    const projectMapAction = plan.actions.find(a => a.path === '.agenticloop/project.md');
    assert.ok(projectMapAction, 'repair plan must recreate the missing project map');
    assert.equal(projectMapAction.kind, 'create');
    const toolkitMutations = plan.actions.filter(a => a.category === 'toolkit' && a.kind !== 'skip');
    assert.deepEqual(toolkitMutations, [], 'current toolkit source must not be rewritten');
  });

  it('plans legacy migration for v2 layout targets', () => {
    const target = makeTarget();
    // Simulate a legacy target: canonical source at the root, nothing installed.
    writeFileSync(join(target, 'AGENTIC_LOOP.md'), readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf-8'), 'utf-8');
    const plan = planInit({ target });
    const rename = plan.actions.find(a => a.exec?.type === 'rename');
    assert.ok(rename, 'legacy plan must include a migration rename exec');
    assert.equal(rename.path, 'agenticloop/AGENTIC_LOOP.md');
  });
});
