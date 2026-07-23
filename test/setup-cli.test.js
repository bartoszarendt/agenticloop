/**
 * CLI-level tests for `agenticloop setup` and `agenticloop doctor`.
 *
 * Covers:
 *   - Fresh target setup with piped input
 *   - Doctor output without mutation
 *   - Setup with --adapter preselection
 *   - No-TTY behavior
 *   - init --setup compatibility hint
 *   - Resumed setup (already confirmed)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import { loadJsonFile } from '../src/json.js';
import { parseFrontmatter } from '../src/frontmatter.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-setup-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEmptyTarget() {
  return mkdtempSync(join(tmpDir, 'target-'));
}

function makeTarget(options = {}) {
  const d = mkdtempSync(join(tmpDir, 'target-'));
  seedTargetLayout(REPO_ROOT, d, options);
  return d;
}

function writeProjectMap(target, frontmatter) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(frontmatter)) {
    if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push('---');
  lines.push('# Agentic Loop Project Map');
  mkdirSync(join(target, '.agenticloop'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), lines.join('\n'), 'utf-8');
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    ...options,
  });
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor CLI', () => {
  it('shows setup checklist for empty target', () => {
    const d = makeEmptyTarget();
    const result = run(['doctor', '--target', d]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('agenticloop doctor'));
    assert.ok(result.stdout.includes('Setup checklist'));
    assert.ok(result.stdout.includes('[ ] Toolkit installed'));
  });

  it('shows confirmed state for scaffolded target', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      development_stage: 'expansion',
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const result = run(['doctor', '--target', d]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('[x] Setup confirmed'));
    assert.ok(result.stdout.includes('[x] Toolkit installed'));
  });

  it('does not write files', () => {
    const d = makeEmptyTarget();
    const beforeFiles = new Set();
    run(['doctor', '--target', d]);
    assert.ok(!existsSync(join(d, 'agenticloop.json')));
    assert.ok(!existsSync(join(d, '.agenticloop')));
  });
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe('setup CLI', () => {
  it('scaffolds and confirms fresh target with piped input', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const input = [
      'yes',     // confirm project setup
      '4',       // skip adapter setup
    ].join('\n');

    const result = run(['setup', '--target', d], { input });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    assert.ok(existsSync(join(d, '.agenticloop', 'project.md')));
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    const [fm] = parseFrontmatter(content);
    assert.equal(fm.setup_status, 'confirmed');
    assert.equal(fm.development_stage, 'greenfield');
    assert.equal(fm.max_parallel_implementation_lanes, '5');
  });

  it('shows setup checklist in output', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const input = ['yes', '4'].join('\n');
    const result = run(['setup', '--target', d], { input });

    assert.ok(result.stdout.includes('Setup checklist'));
  });

  it('runs full validation when accepted after files-only setup', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const input = [
      'yes',     // confirm project setup
      '1',       // files-only mode
      'yes',     // run validation now
    ].join('\n');

    const result = run(['setup', '--target', d], { input });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes('Skill Validator - agenticloop/skills'));
    assert.ok(result.stdout.includes('Activation Corpus - OK'));
    assert.ok(result.stdout.includes('Validation passed.'));
  });

  it('resumed setup on already confirmed target', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      development_stage: 'expansion',
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const input = ['4'].join('\n');
    const result = run(['setup', '--target', d], { input });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('already confirmed'));
  });

  it('setup with --adapter preselects the adapter', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const input = [
      'yes',     // confirm project setup
      '',        // skip model config (blank)
      '',
      '',
    ].join('\n');

    const result = run(['setup', '--target', d, '--adapter', 'opencode'], { input });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(join(d, 'agenticloop.json')));
  });

  it('guided Codex setup writes the recommended target-owned role defaults', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const result = run(['setup', '--target', d, '--adapter', 'codex'], {
      input: ['yes', '', '', ''].join('\n'),
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.deepEqual(cfg.adapters.codex.roleSettings, {
      orchestrator: { model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      maintainer: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
      engineer: { model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' },
    });
  });

  it('blank input does not confirm setup', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const result = run(['setup', '--target', d], { input: '\n' });

    assert.ok(existsSync(join(d, '.agenticloop', 'project.md')));
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    const [fm] = parseFrontmatter(content);
    assert.notEqual(fm?.setup_status, 'confirmed',
      'blank input must not confirm setup');
    assert.ok(result.stdout.includes('cancelled') || result.stdout.includes('Explicit'),
      'should show cancellation message');
  });

  it('EOF/empty stdin does not confirm setup', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const result = run(['setup', '--target', d], { input: '' });

    assert.ok(existsSync(join(d, '.agenticloop', 'project.md')));
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    const [fm] = parseFrontmatter(content);
    assert.notEqual(fm?.setup_status, 'confirmed',
      'EOF must not confirm setup');
  });

  it('unknown answer does not confirm setup', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const result = run(['setup', '--target', d], { input: 'maybe\n' });

    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    const [fm] = parseFrontmatter(content);
    assert.notEqual(fm?.setup_status, 'confirmed',
      'unknown answer must not confirm setup');
  });

  it('edit path requires a second yes before writing project map changes', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const input = [
      'edit',
      'github',
      '',
      '',
      '',
      'no',
    ].join('\n');
    const result = run(['setup', '--target', d], { input });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Edited project map values/);
    assert.match(result.stdout, /not written/);
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    const [fm] = parseFrontmatter(content);
    assert.notEqual(fm?.setup_status, 'confirmed');
    assert.equal(fm?.task_backend, 'files');
    assert.equal(fm?.development_stage, 'unconfirmed');
  });

  it('presents bounded stage evidence and persists only human-confirmed edits', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# Project\n\nThis project is in maintenance mode.\n');

    const input = [
      'edit',
      'prod',
      'stabilization',
      '0',
      '4',
      'Release hardening is the current priority.',
      'The next capability roadmap is accepted.',
      '',
      '',
      '',
      '',
      'yes',
      '4',
    ].join('\n');
    const result = run(['setup', '--target', d], { input });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Development stage proposal: maintenance/);
    assert.match(result.stdout, /Invalid development stage/);
    assert.match(result.stdout, /Maximum implementation lanes must be a positive integer/);
    const [fm] = parseFrontmatter(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'));
    assert.equal(fm.development_stage, 'stabilization');
    assert.equal(fm.max_parallel_implementation_lanes, '4');
    assert.equal(fm.development_stage_rationale, 'Release hardening is the current priority.');
    assert.equal(fm.development_stage_revisit_when, 'The next capability roadmap is accepted.');
  });

  it('does not persist an edited stage when human confirmation is declined', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'README.md'), '# Project\n\nThis project is in maintenance mode.\n');
    const input = [
      'edit', 'maintenance', '', '', '', '', '', '', '', 'no',
    ].join('\n');

    const result = run(['setup', '--target', d], { input });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const [fm] = parseFrontmatter(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'));
    assert.equal(fm.development_stage, 'unconfirmed');
    assert.notEqual(fm.setup_status, 'confirmed');
    assert.match(result.stdout, /not written/);
  });

  it('migrates a confirmed project missing stage only after human confirmation and preserves its body', () => {
    const d = makeTarget();
    writeFileSync(join(d, 'ROADMAP.md'), '# Roadmap\n\nThis project is in maintenance mode.\n');
    const body = '# Existing Project Map\n\n## Project Operating Facts\n\n- Preserve this exact body.\n';
    writeFileSync(join(d, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: confirmed',
      'setup_confirmed_at: "2026-06-22"',
      'setup_confirmed_by: "human"',
      'task_backend: files',
      'grouping_profile: flat',
      '---',
      body,
    ].join('\n'));

    const result = run(['setup', '--target', d], { input: ['yes', '4'].join('\n') });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const content = readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8');
    const [fm] = parseFrontmatter(content);
    assert.ok(['greenfield', 'expansion', 'stabilization', 'maintenance'].includes(fm.development_stage));
    assert.equal(fm.documents, undefined, 'stage migration must not add unrelated document selections');
    assert.ok(content.endsWith(body), 'profile migration must preserve project-map body bytes');
  });

  it('requires an explicit stage selection when bounded evidence conflicts', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'README.md'), '# Project\n\nThe product is in maintenance mode.\n');
    writeFileSync(join(d, 'ROADMAP.md'), '# Roadmap\n\nThis is a greenfield project.\n');

    const input = [
      'yes',
      'stabilization',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'yes',
      '4',
    ].join('\n');
    const result = run(['setup', '--target', d], { input });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Development stage proposal: selection required/);
    assert.match(result.stdout, /requires an explicit development-stage selection/);
    const [fm] = parseFrontmatter(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'));
    assert.equal(fm.development_stage, 'stabilization');
  });

  it('allows a later human-confirmed profile transition without automatic stage changes', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      development_stage: 'expansion',
      max_parallel_implementation_lanes: 5,
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const transition = run(['setup', '--target', d], {
      input: ['yes', 'maintenance', '3', 'Compatibility commitments now govern changes.', 'After a planned major migration.', 'yes', '4'].join('\n'),
    });
    assert.equal(transition.status, 0, `stdout:\n${transition.stdout}\nstderr:\n${transition.stderr}`);
    let [fm] = parseFrontmatter(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'));
    assert.equal(fm.development_stage, 'maintenance');
    assert.equal(fm.max_parallel_implementation_lanes, '3');

    const nonInteractive = run(['setup', '--target', d, '--adapter', 'opencode', '--yes']);
    assert.equal(nonInteractive.status, 0, `stderr: ${nonInteractive.stderr}`);
    [fm] = parseFrontmatter(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'));
    assert.equal(fm.development_stage, 'maintenance');
  });

  it('continues setup when a confirmed profile update is declined', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      development_stage: 'expansion',
      max_parallel_implementation_lanes: 5,
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const result = run(['setup', '--target', d], {
      input: ['yes', 'maintenance', '', '', '', 'no', '4'].join('\n'),
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Profile update cancelled; continuing setup without profile changes/);
    assert.match(result.stdout, /Adapter setup:/);
    const [fm] = parseFrontmatter(readFileSync(join(d, '.agenticloop', 'project.md'), 'utf-8'));
    assert.equal(fm.development_stage, 'expansion');
  });

  it('--adapter does not generate artifacts before confirmation', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    // Answer "no" to project confirmation - should not generate any .opencode/ artifacts
    const result = run(['setup', '--target', d, '--adapter', 'opencode'], { input: 'no\n' });

    assert.ok(!existsSync(join(d, '.opencode')),
      'adapter artifacts must not exist when setup was not confirmed');
  });

  it('--yes non-interactive requires --adapter', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const result = run(['setup', '--target', d, '--yes']);
    assert.notEqual(result.status, 0, 'should fail without --adapter');
  });

  it('--yes --adapter fails on unconfirmed project map', () => {
    const d = makeTarget();
    // Project map exists but is not confirmed
    writeProjectMap(d, {
      setup_status: 'unconfirmed',
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const result = run(['setup', '--target', d, '--adapter', 'opencode', '--yes']);
    assert.notEqual(result.status, 0,
      'non-interactive setup must fail on unconfirmed project map');
    assert.ok(
      result.stdout.includes('unconfirmed') || result.stderr.includes('unconfirmed'),
      'should mention unconfirmed project map'
    );
    // Should NOT have generated adapter artifacts
    assert.ok(!existsSync(join(d, '.opencode')),
      'adapter artifacts must not exist when project map is unconfirmed in non-interactive mode');
  });

  it('--yes --adapter fails closed for a confirmed project missing development stage', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const result = run(['setup', '--target', d, '--adapter', 'opencode', '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /human-confirmed development stage/);
    assert.ok(!existsSync(join(d, '.opencode')));
  });
});

// ---------------------------------------------------------------------------
// init --setup hint
// ---------------------------------------------------------------------------

describe('init --setup compatibility', () => {
  it('prints migration hint when --setup is used', () => {
    const d = makeEmptyTarget();
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS\n');
    writeFileSync(join(d, 'README.md'), '# README\n');
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');

    const input = ['model-a', '', 'model-b', '', 'model-c', ''].join('\n');
    const result = run(['init', '--target', d, '--adapter', 'opencode', '--setup'], {
      input,
    });
    assert.ok(result.stdout.includes('agenticloop setup'));
  });
});
