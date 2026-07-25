/**
 * Packed-package smoke tests (Phase 28).
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
    const bare = runPacked([]);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /agenticloop setup/);
    const commandHelp = runPacked(['setup', '--help']);
    assert.equal(commandHelp.status, 0);
    assert.match(commandHelp.stdout, /--non-interactive/);
    assert.match(commandHelp.stdout, /--dry-run/);
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
