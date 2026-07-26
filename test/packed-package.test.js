/**
 * Packed-package smoke tests.
 *
 * Builds a real `npm pack` archive once, installs it into an isolated prefix,
 * and proves the shipped binary reports the package version, renders complete
 * help, ships docs/cli-reference.md, runs setup dry-run with zero writes, and
 * retains the direct init path — so the documented CLI contract cannot be
 * omitted from the published package.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpBase;
let packedBin;
let packedRoot;

function npm(args, options = {}) {
  return spawnSync('npm', args, {
    encoding: 'utf-8',
    shell: true,
    env: { ...process.env, npm_config_cache: join(tmpBase, 'npm-cache') },
    ...options,
  });
}

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-packed-'));
  const packDir = join(tmpBase, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packed = npm(['pack', '--pack-destination', packDir], { cwd: REPO_ROOT });
  assert.equal(packed.status, 0, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`);
  const tarball = readdirSync(packDir).find(entry => entry.endsWith('.tgz'));
  assert.ok(tarball, 'npm pack must produce a tarball');

  const prefix = join(tmpBase, 'prefix');
  const installed = npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', join(packDir, tarball)]);
  assert.equal(installed.status, 0, `npm install failed:\n${installed.stdout}\n${installed.stderr}`);
  packedRoot = join(prefix, 'node_modules', 'agenticloop');
  packedBin = join(packedRoot, 'bin', 'agenticloop.js');
  assert.ok(existsSync(packedBin), `packed binary missing at ${packedBin}`);
}, { timeout: 300000 });

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function runPacked(args, options = {}) {
  return spawnSync(process.execPath, [packedBin, ...args], { encoding: 'utf-8', ...options });
}

describe('packed package smoke tests', () => {
  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    for (const args of [['--version'], ['version']]) {
      const result = runPacked(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`agenticloop ${pkg.version.replaceAll('.', '\\.')}`));
    }
  });

  it('renders complete help and first-use guidance', () => {
    const help = runPacked(['help']);
    assert.equal(help.status, 0, help.stderr);
    for (const command of ['setup', 'init', 'doctor', 'update', 'remove', 'task', 'audit', 'worktree']) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'), `complete help must list '${command}'`);
    }
    for (const command of ['pr-body', 'task-readiness', 'commit-attribution', 'github-checkpoint', 'github-review-prepare']) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'), `complete help must list review-preparation command '${command}'`);
    }
    const bare = runPacked([]);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /agenticloop setup/);
    const commandHelp = runPacked(['setup', '--help']);
    assert.equal(commandHelp.status, 0);
    assert.match(commandHelp.stdout, /--non-interactive/);
    assert.match(commandHelp.stdout, /--dry-run/);
  });

  it('renders --help for every review-preparation command from the installed tarball', () => {
    for (const [command, sub] of [['pr-body', 'scaffold'], ['pr-body', 'lint'], ['task-readiness', null], ['commit-attribution', 'check'], ['github-checkpoint', 'render'], ['github-checkpoint', 'repair-plan'], ['github-review-prepare', null], ['github-preflight', null], ['github-review-audit', null], ['github-ready', null]]) {
      const args = sub ? [command, sub, '--help'] : [command, '--help'];
      const result = runPacked(args);
      assert.equal(result.status, 0, `${args.join(' ')} --help failed:\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.length > 0, `${command} --help must render text`);
    }
  });

  it('runs task-readiness with --task-body and --base-paths from the installed tarball', () => {
    const target = mkdtempSync(join(tmpBase, 'readiness-'));
    const taskFile = join(target, 'task.md');
    writeFileSync(taskFile, '---\nallowed_paths: ["src/**"]\n---\n# Task\n', 'utf-8');
    const baseFile = join(target, 'base.json');
    writeFileSync(baseFile, JSON.stringify(['src/app.js']), 'utf-8');
    const ok = runPacked(['task-readiness', '--task-body', taskFile, '--base-paths', baseFile, '--mode', 'review', '--json'], { cwd: target });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(JSON.parse(ok.stdout).ok, true);
    const typo = join(target, 'task-typo.md');
    writeFileSync(typo, '---\nallowed_paths: ["src/app/App.tsx"]\n---\n# Task\n', 'utf-8');
    const bad = runPacked(['task-readiness', '--task-body', typo, '--base-paths', baseFile, '--mode', 'review', '--json'], { cwd: target });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(JSON.parse(bad.stdout).errors.join('\n'), /App\.tsx/);
  });

  it('fails GitHub handlers safely before any network access on missing input', () => {
    for (const args of [
      ['github-preflight', '--json'],
      ['github-review-prepare', '--json'],
      ['github-checkpoint', 'render', '--json'],
      ['github-checkpoint', 'repair-plan', '--json'],
      ['pr-body', 'scaffold', '--json'],
    ]) {
      const result = runPacked(args);
      assert.equal(result.status, 2, `${args.join(' ')} must exit 2 on missing input:\n${result.stdout}\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false, `${args.join(' ')} must return a failure envelope`);
      assert.match(parsed.errors.join('\n'), /--pr|--issue|required/i, `${args.join(' ')} must name the missing input`);
    }
  });

  it('runs commit-attribution check read-only from the installed tarball and never amends', () => {
    const target = mkdtempSync(join(tmpBase, 'attr-'));
    const messageFile = join(target, 'message.txt');
    writeFileSync(messageFile, 'subject\n\nTask: T-007\nAgent: maintainer\nTask: T-007', 'utf-8');
    const result = runPacked(['commit-attribution', 'check', '--task', 'T-007', '--message-file', messageFile, '--json', '--target', target], { cwd: target });
    // Failing attribution returns a nonzero gate result with a repair plan.
    assert.notEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.repairPlan, /Task: T-007/);
    assert.match(parsed.repairPlan, /Agent: engineer/);
    assert.ok(!/git commit --amend|git push|--force/i.test(parsed.repairPlan), 'repair plan must never amend or push');
    // The message file is unchanged: the command is strictly read-only.
    assert.equal(readFileSync(messageFile, 'utf-8'), 'subject\n\nTask: T-007\nAgent: maintainer\nTask: T-007');
  });

  it('runs pr-body lint offline from the installed tarball', () => {
    const target = mkdtempSync(join(tmpBase, 'lint-'));
    const HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const input = {
      schemaVersion: 1,
      prData: { number: 1, body: '## Scope Completed\nREPLACE: x\n\n## Evidence\nCurrent PR head: ' + HEAD_SHA + '\n', headRefOid: HEAD_SHA, baseRefOid: 'b'.repeat(40), files: [], statusCheckRollup: [], commits: [], comments: [], reviews: [] },
      issueData: { number: 2, body: '---\ntask_id: T-1\n---\n# T\n', comments: [] },
      expectedAccount: { login: 'bot' }, reviewHistory: { events: [], errors: [] },
      basePaths: [], mode: 'review', projectFacts: [], references: { decisionIds: [], taskIds: [] },
      verificationStatus: null, configuration: { reviewBudget: 5, reviewBudgetError: null, projectMapConfig: null },
      pathInventoryRequired: true,
    };
    const inputFile = join(target, 'input.json');
    writeFileSync(inputFile, JSON.stringify(input), 'utf-8');
    const result = runPacked(['pr-body', 'lint', '--input', inputFile, '--json'], { cwd: target });
    // A scaffold containing REPLACE must fail lint; it never performs network access.
    assert.notEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.lintReady, false);
    assert.match(parsed.errors.join('\n'), /placeholder/i);
  });

  it('ships docs/cli-reference.md', () => {
    assert.ok(existsSync(join(packedRoot, 'docs', 'cli-reference.md')),
      'docs/cli-reference.md must be shipped in the packed package');
  });

  it('runs setup --dry-run --json with zero writes from the packed package', () => {
    const target = mkdtempSync(join(tmpBase, 'target-'));
    const result = runPacked(['setup', '--target', target, '--adapter', 'opencode', '--dry-run', '--json']);
    // Unconfirmed profile: exit 1 with a valid versioned plan document.
    assert.equal(result.status, 1, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.command, 'setup');
    assert.ok(plan.blockers.length > 0);
    assert.deepEqual(readdirSync(target), [], 'setup dry-run must not write');
  });

  it('runs init --dry-run with zero writes from the packed package', () => {
    const target = mkdtempSync(join(tmpBase, 'target-'));
    const result = runPacked(['init', '--target', target, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan \(dry run/);
    assert.deepEqual(readdirSync(target), [], 'init dry-run must not write');
  });

  it('retains the direct init path for all five adapters', () => {
    for (const adapter of ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']) {
      const target = mkdtempSync(join(tmpBase, `target-${adapter}-`));
      const result = runPacked(['init', '--target', target, '--adapter', adapter]);
      assert.equal(result.status, 0, `${adapter}:\n${result.stdout}\n${result.stderr}`);
      assert.ok(existsSync(join(target, 'agenticloop.json')), `${adapter} must create agenticloop.json`);
      assert.ok(existsSync(join(target, 'agenticloop', 'manifest.json')), `${adapter} must scaffold the toolkit`);
    }
  });

  it('reports usage failures with exit 2 from the packed binary', () => {
    const target = mkdtempSync(join(tmpBase, 'target-'));
    writeFileSync(join(target, 'README.md'), '# R\n', 'utf-8');
    const result = runPacked(['init', '--target', target, '--unknown-flag']);
    assert.equal(result.status, 2);
    assert.deepEqual(readdirSync(target), ['README.md'], 'invalid usage must not mutate');
  });
});
