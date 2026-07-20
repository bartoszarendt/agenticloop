/**
 * Subprocess smoke tests for the real binary.
 *
 * Most command-behavior tests now run in-process via `runCli` for speed. This
 * file deliberately keeps a small surface that exercises the actual
 * `bin/agenticloop.js` entrypoint through a spawned Node process, so the things
 * that only a real process can prove stay covered:
 *
 *   - the binary entrypoint is runnable and wired to `runCli`
 *   - help and unknown-command behavior
 *   - real exit-code propagation to the process
 *   - environment propagation to a spawned command
 *   - packaging: the bin is declared and resolvable
 *   - at least one representative end-to-end command invocation
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-cli-smoke-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runBin(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', ...options });
}

describe('CLI binary smoke tests', () => {
  it('prints usage for --help and exits 0', () => {
    const result = runBin(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /agenticloop <command> \[options\]/);
  });

  it('prints usage with no command and exits 0', () => {
    const result = runBin([]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Commands:/);
  });

  it('reports an unknown command on stderr and exits 1', () => {
    const result = runBin(['frobnicate']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command: frobnicate/);
  });

  it('propagates a nonzero exit code from a failing command', () => {
    // `task new` with no title is a deterministic user error that must exit 1
    // through the real process, proving exit-code propagation from runCli.
    const target = mkdtempSync(join(tmpDir, 'fail-'));
    assert.equal(runBin(['init', '--target', target]).status, 0);
    const result = runBin(['task', 'new', '--target', target]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /task new requires a title/);
  });

  it('runs a representative end-to-end command through the real binary', () => {
    const target = mkdtempSync(join(tmpDir, 'e2e-'));
    const init = runBin(['init', '--target', target]);
    assert.equal(init.status, 0, `init failed:\n${init.stdout}\n${init.stderr}`);

    const created = runBin(['task', 'new', 'Smoke e2e task', '--target', target]);
    assert.equal(created.status, 0);
    assert.match(created.stdout, /Created \.agenticloop\/tasks\/T-001\.md/);
    assert.ok(existsSync(join(target, '.agenticloop', 'tasks', 'T-001.md')));
  });

  it('propagates the injected environment to the spawned process', () => {
    const target = mkdtempSync(join(tmpDir, 'env-'));
    const marker = join(target, 'environment.txt');
    const probe = join(target, 'environment-probe.cjs');
    writeFileSync(
      probe,
      "require('node:fs').writeFileSync(process.env.AGENTICLOOP_ENV_MARKER, process.env.AGENTICLOOP_ENV_VALUE);\n",
      'utf-8'
    );

    const result = runBin(['status'], {
      cwd: target,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${probe}`,
        AGENTICLOOP_ENV_MARKER: marker,
        AGENTICLOOP_ENV_VALUE: 'spawned',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf-8'), 'spawned');
  });
});

describe('CLI packaging', () => {
  it('declares the agenticloop bin and it resolves to an executable entry', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    assert.ok(pkg.bin && pkg.bin.agenticloop, 'package.json must declare the agenticloop bin');
    const binPath = join(REPO_ROOT, pkg.bin.agenticloop);
    assert.ok(existsSync(binPath), `declared bin should exist at ${binPath}`);
    const source = readFileSync(binPath, 'utf-8');
    assert.match(source, /^#!\/usr\/bin\/env node/, 'bin must carry a node shebang');
    assert.match(source, /runCli/, 'bin must delegate to runCli');
  });
});
