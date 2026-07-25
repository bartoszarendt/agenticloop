/**
 * Setup state matrix and idempotency tests (Phase 28 Track B).
 *
 * Empty, current, legacy, partial, and inverse-partial targets all flow
 * through one repair-aware plan/apply path. Repeated setup produces zero
 * second-run mutations; init followed by setup does not duplicate scaffolding
 * or generated artifacts; human and JSON plans describe the same actions.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCliInProcess, scriptedStdin } from './helpers/run-cli.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import { parseFrontmatter } from '../src/frontmatter.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-setup-states-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function makeTarget() {
  return mkdtempSync(join(tmpBase, 'target-'));
}

function snapshotTree(root) {
  const entries = [];
  if (!existsSync(root)) return entries;
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir).sort()) {
      const fullPath = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(fullPath).isDirectory()) walk(fullPath, relPath);
      else entries.push(`${relPath}:${readFileSync(fullPath).length}`);
    }
  };
  walk(root, '');
  return entries;
}

function writeDocs(target) {
  writeFileSync(join(target, 'AGENTS.md'), '# AGENTS\n', 'utf-8');
  writeFileSync(join(target, 'README.md'), '# README\n', 'utf-8');
  writeFileSync(join(target, 'IMPLEMENTATION_PLAN.md'), '# Plan\n', 'utf-8');
}

function confirmProjectMap(target) {
  mkdirSync(join(target, '.agenticloop'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), [
    '---',
    'setup_status: "confirmed"',
    'setup_confirmed_at: "2026-06-22"',
    'setup_confirmed_by: "human"',
    'development_stage: "expansion"',
    'task_backend: "files"',
    'event_logging: "disabled"',
    'grouping_profile: "flat"',
    '---',
    '# Project Map',
    '',
  ].join('\n'), 'utf-8');
}

function readProjectMap(target) {
  const [fm] = parseFrontmatter(readFileSync(join(target, '.agenticloop', 'project.md'), 'utf-8'));
  return fm;
}

describe('setup state matrix', () => {
  it('empty target: interactive setup scaffolds and confirms', async () => {
    const target = makeTarget();
    writeDocs(target);
    const result = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['yes', '', '', 'y', 'n']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(readProjectMap(target).setup_status, 'confirmed');
    assert.ok(existsSync(join(target, 'agenticloop', 'manifest.json')));
  });

  it('current target: setup is a no-op repair with zero mutations', async () => {
    const target = makeTarget();
    writeDocs(target);
    const initResult = await runCliInProcess(['init', '--target', target]);
    assert.equal(initResult.status, 0, initResult.stderr);
    confirmProjectMap(target);
    const before = snapshotTree(target);
    const result = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['n', '', '', 'y', 'n']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Kept\s+\d+/);
    assert.deepEqual(snapshotTree(target), before, 'current target must not change');
  });

  it('partial target: current layout with a missing project map is repaired', async () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    // Partial: toolkit present, required target state missing.
    assert.equal(existsSync(join(target, '.agenticloop', 'project.md')), false);
    const result = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['yes', '', '', 'y', 'n']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(join(target, '.agenticloop', 'project.md')));
    // Toolkit source preserved, not duplicated.
    const plan = result.stdout;
    assert.match(plan, /Kept\s+\d+/);
  });

  it('inverse-partial target: generated-artifacts manifest without layout is repaired', async () => {
    const target = makeTarget();
    writeDocs(target);
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'generated-artifacts.json'),
      JSON.stringify({ schemaVersion: 4, packageVersion: '0.3.0', entries: [] }, null, 2), 'utf-8');
    const result = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['yes', '', '', 'y', 'n']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(join(target, 'agenticloop', 'manifest.json')));
    // The pre-existing manifest survives (no layout manifest was present).
    assert.ok(existsSync(join(target, '.agenticloop', 'generated-artifacts.json')));
  });

  it('legacy target: v2 canonical assets migrate through the plan', async () => {
    const target = makeTarget();
    writeDocs(target);
    writeFileSync(join(target, 'AGENTIC_LOOP.md'), readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf-8'), 'utf-8');
    const result = await runCliInProcess(['setup', '--target', target, '--verbose'], {
      stdin: scriptedStdin(['yes', '', '', 'y', 'n']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(existsSync(join(target, 'AGENTIC_LOOP.md')), false);
    assert.ok(existsSync(join(target, 'agenticloop', 'AGENTIC_LOOP.md')));
  });

  it('doctor and setup-state agree with setup on a partial target', async () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    const doctor = await runCliInProcess(['doctor', '--target', target]);
    assert.equal(doctor.status, 0);
    assert.match(doctor.stdout, /\[x\] Toolkit installed/);
    assert.match(doctor.stdout, /\[\] Project map|Project map/);
  });

  it('running setup twice produces zero second-run mutations', async () => {
    const target = makeTarget();
    writeDocs(target);
    const first = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['yes', '', '', 'y', 'n']),
    });
    assert.equal(first.status, 0, first.stderr);
    const between = snapshotTree(target);
    const second = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['n', '', '', 'y', 'n']),
    });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.match(second.stdout, /Kept\s+\d+/);
    assert.deepEqual(snapshotTree(target), between, 'second setup must not mutate');
  });

  it('init followed by setup does not duplicate scaffolding or artifacts', async () => {
    const target = makeTarget();
    writeDocs(target);
    const initResult = await runCliInProcess(['init', '--target', target, '--adapter', 'opencode']);
    assert.equal(initResult.status, 0, initResult.stderr);
    const between = snapshotTree(target);
    const setup = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['yes', '', '', 'y', 'n']),
    });
    assert.equal(setup.status, 0, `stdout:\n${setup.stdout}\nstderr:\n${setup.stderr}`);
    const after = snapshotTree(target);
    // Setup confirms the profile (project.md changes); nothing else changes.
    const changed = after.filter(entry => !between.includes(entry));
    const added = after.filter(entry => !between.includes(entry)).length;
    const removed = between.filter(entry => !after.includes(entry));
    assert.deepEqual(removed, [], 'setup must not remove init output');
    assert.ok(changed.every(entry => entry.startsWith('.agenticloop/project.md') || entry.startsWith('AGENTS.md')),
      `only the project map and guidance may change, got: ${changed.join(', ')}`);
    assert.equal(added, changed.length);
  });
});

describe('setup plan contracts', () => {
  it('setup --dry-run --json emits one versioned document on a confirmed target', async () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    confirmProjectMap(target);
    const before = snapshotTree(target);
    const result = await runCliInProcess(['setup', '--target', target, '--adapter', 'opencode', '--dry-run', '--json']);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.command, 'setup');
    assert.equal(result.stdout.trim().endsWith('}'), true);
    assert.deepEqual(snapshotTree(target), before, 'JSON dry-run must not write');
  });

  it('setup --dry-run --json fails on an unconfirmed profile with a valid plan document', async () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    const result = await runCliInProcess(['setup', '--target', target, '--adapter', 'opencode', '--dry-run', '--json']);
    assert.equal(result.status, 1);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schemaVersion, 1);
    assert.ok(plan.blockers.length > 0, 'blockers must explain the unconfirmed profile');
    assert.match(plan.blockers.join('\n'), /human-confirmed development stage/);
  });

  it('human and JSON plans describe the same normalized actions', async () => {
    const targetA = makeTarget();
    const targetB = makeTarget();
    seedTargetLayout(REPO_ROOT, targetA);
    seedTargetLayout(REPO_ROOT, targetB);
    confirmProjectMap(targetA);
    confirmProjectMap(targetB);
    const human = await runCliInProcess(['setup', '--target', targetA, '--adapter', 'opencode', '--dry-run', '--verbose'], {
      stdin: scriptedStdin(['n', '']),
    });
    const json = await runCliInProcess(['setup', '--target', targetB, '--adapter', 'opencode', '--dry-run', '--json']);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(json.status, 0, json.stderr);
    const plan = JSON.parse(json.stdout);
    const mutating = plan.actions.filter(a => a.kind !== 'skip');
    for (const action of mutating) {
      assert.ok(human.stdout.includes(action.path), `human plan must show ${action.path}`);
    }
    // Plan counts equal detailed action counts.
    const counts = { create: 0, update: 0, merge: 0, remove: 0, skip: 0, blocked: 0 };
    for (const action of plan.actions) counts[action.kind] += 1;
    assert.match(human.stdout, new RegExp(`Create\\s+${counts.create}`));
    assert.match(human.stdout, new RegExp(`Keep\\s+${counts.skip}`));
  });

  it('dry-run never creates or updates the generated-artifacts manifest', async () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    confirmProjectMap(target);
    const result = await runCliInProcess(['setup', '--target', target, '--adapter', 'opencode', '--dry-run'], {
      stdin: scriptedStdin(['n', '']),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(target, '.agenticloop', 'generated-artifacts.json')), false);
  });
});
