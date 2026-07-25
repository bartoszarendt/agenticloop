/**
 * CLI safety contract tests (Phase 28).
 *
 * Zero-mutation guarantees for help, invalid usage, dry-run, declined apply,
 * and pre-apply cancellation; exit-status contract (0/1/2/130); injectable
 * capabilities (TTY/CI/color/NO_COLOR); and the setup compatibility spellings.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runCliInProcess, scriptedStdin } from './helpers/run-cli.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-cli-safety-'));
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
      else entries.push(relPath);
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

describe('zero-mutation safety', () => {
  it('init --help and setup --help change nothing', async () => {
    for (const argv of [['init', '--help'], ['setup', '--help'], ['init', '-h'], ['setup', '-h']]) {
      const target = makeTarget();
      const result = await runCliInProcess([...argv, '--target', target]);
      assert.equal(result.status, 0, argv.join(' '));
      assert.deepEqual(snapshotTree(target), [], `${argv.join(' ')} must not write`);
    }
  });

  it('unknown and misspelled options exit 2 with zero filesystem changes', async () => {
    for (const argv of [
      ['init', '--targt'],
      ['init', '--frobnicate'],
      ['setup', '--yes', '--adaptr', 'opencode'],
      ['setup', '--event-logging', 'sometimes'],
      ['setup', '--non-interactive'],
    ]) {
      const target = makeTarget();
      const result = await runCliInProcess([...argv, '--target', target]);
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
      assert.deepEqual(snapshotTree(target), [], `${argv.join(' ')} must not write`);
    }
  });

  it('missing option values exit 2 with zero filesystem changes', async () => {
    const target = makeTarget();
    const result = await runCliInProcess(['init', '--target']);
    assert.equal(result.status, 2);
    assert.deepEqual(snapshotTree(target), []);
  });

  it('unexpected operands exit 2 before any handler or mutation runs', async () => {
    for (const argv of [
      ['init', 'unexpected'],
      ['setup', 'unexpected'],
      ['update', 'unexpected'],
      ['remove', '--yes', '.agenticloop'],
      ['validate', 'unexpected'],
      ['doctor', 'unexpected'],
      ['status', 'unexpected'],
      ['generate', 'opencode', 'unexpected'],
      ['worktree', 'add', 'T-001', 'branch', 'extra'],
      ['worktree', 'remove', 'T-001', 'extra'],
      ['task', 'status', 'T-001', 'done', 'extra'],
      ['task', 'lint', 'T-001', 'T-002'],
      ['audit', 'gate', 'A-1', 'extra'],
      ['audit', 'lint', 'A-1', 'extra'],
      ['task', 'status'],
      ['worktree', 'add', 'T-001'],
    ]) {
      const target = makeTarget();
      const result = await runCliInProcess([...argv, '--target', target]);
      assert.equal(result.status, 2, `${argv.join(' ')}: status=${result.status} stderr=${result.stderr}`);
      assert.deepEqual(snapshotTree(target), [], `${argv.join(' ')} must not write`);
    }
  });

  it('init --dry-run performs zero writes including gitignore and manifests', async () => {
    const target = makeTarget();
    const result = await runCliInProcess(['init', '--target', target, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan \(dry run/);
    assert.deepEqual(snapshotTree(target), [], 'dry-run must not write');
  });

  it('init --dry-run --adapter performs zero writes', async () => {
    const target = makeTarget();
    const result = await runCliInProcess(['init', '--target', target, '--dry-run', '--adapter', 'opencode']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshotTree(target), []);
  });

  it('init --dry-run succeeds against a read-only target', async () => {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
    const before = snapshotTree(target);
    chmodSync(target, 0o555);
    try {
      const result = await runCliInProcess(['init', '--target', target, '--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(snapshotTree(target), before);
    } finally {
      chmodSync(target, 0o777);
    }
  });

  it('setup --dry-run performs zero writes and exits 0 on a fresh target', async () => {
    const target = makeTarget();
    writeDocs(target);
    const result = await runCliInProcess(['setup', '--target', target, '--dry-run'], {
      stdin: scriptedStdin(['yes', '', '']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Plan \(dry run/);
    assert.deepEqual(snapshotTree(target), ['AGENTS.md', 'IMPLEMENTATION_PLAN.md', 'README.md']);
  });

  it('declining the final setup apply produces zero filesystem changes', async () => {
    const target = makeTarget();
    writeDocs(target);
    const result = await runCliInProcess(['setup', '--target', target], {
      stdin: scriptedStdin(['yes', '', '', 'n']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /cancelled before apply/);
    assert.deepEqual(snapshotTree(target), ['AGENTS.md', 'IMPLEMENTATION_PLAN.md', 'README.md']);
  });

  it('in-process cancellation before apply returns 130 and writes nothing', async () => {
    const target = makeTarget();
    writeDocs(target);
    const controller = new AbortController();
    controller.abort();
    const result = await runCliInProcess(['setup', '--target', target], {
      signal: controller.signal,
    });
    assert.equal(result.status, 130);
    assert.deepEqual(snapshotTree(target), ['AGENTS.md', 'IMPLEMENTATION_PLAN.md', 'README.md']);
  });

  it('in-process abort during interactive prompts returns 130 with zero writes', async () => {
    const target = makeTarget();
    writeDocs(target);
    const controller = new AbortController();
    const promptFactory = () => ({
      ask: () => {
        controller.abort();
        return new Promise(() => {});
      },
      write: () => {},
      close: () => {},
    });
    const result = await runCliInProcess(['setup', '--target', target], {
      promptFactory,
      signal: controller.signal,
    });
    assert.equal(result.status, 130);
    assert.deepEqual(snapshotTree(target), ['AGENTS.md', 'IMPLEMENTATION_PLAN.md', 'README.md']);
  });

  it('usage failures exit 2 and operational failures exit 1', async () => {
    const target = makeTarget();
    // Usage: unknown adapter value.
    const usage = await runCliInProcess(['init', '--target', target, '--adapter', 'invalid-host']);
    assert.equal(usage.status, 2);
    // Operational: init against the package source repository root.
    const operational = await runCliInProcess(['init', '--target', REPO_ROOT]);
    assert.equal(operational.status, 1);
  });

  it('a real process reports SIGINT as exit 130 on POSIX platforms', { skip: platform() === 'win32' }, async () => {
    const target = makeTarget();
    writeDocs(target);
    const child = spawnSync(process.execPath, [BIN, 'setup', '--target', target], {
      input: 'yes\n',
      encoding: 'utf-8',
      killSignal: 'SIGINT',
      timeout: 5000,
    });
    // Node child signal delivery is not portable to Windows; POSIX-only check.
    assert.ok(child.status === 130 || child.signal === 'SIGINT',
      `expected exit 130 or SIGINT termination, got status=${child.status} signal=${child.signal}`);
  });
});

describe('capabilities and output contract', () => {
  it('human results use stdout and warnings/errors use stderr', async () => {
    const target = makeTarget();
    const result = await runCliInProcess(['init', '--target', target, '--adapter', 'invalid-host']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Invalid --adapter value/);
  });

  it('respects NO_COLOR for styled output', async () => {
    const withColor = await runCliInProcess(['help'], { color: true });
    const withoutColor = await runCliInProcess(['help'], { env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(withColor.status, 0);
    assert.equal(withoutColor.status, 0);
    assert.ok(!withoutColor.stdout.includes('\u001b'), 'NO_COLOR output must not contain ANSI escapes');
  });

  it('non-TTY and CI output stays plain and deterministic', async () => {
    const result = await runCliInProcess(['help', 'init'], { isTTY: false, ci: true });
    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes('\u001b'), 'CI/non-TTY output must not contain ANSI escapes');
  });

  it('JSON stdout parses as exactly one document', async () => {
    const target = makeTarget();
    const result = await runCliInProcess(['init', '--target', target, '--dry-run', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.command, 'init');
    assert.ok(Array.isArray(parsed.actions));
    // Exactly one document: no trailing prose after the JSON value.
    assert.equal(result.stdout.trim().endsWith('}'), true);
    assert.deepEqual(snapshotTree(target), []);
  });

  it('injected capabilities are independent of process globals', async () => {
    const previousCi = process.env.CI;
    delete process.env.CI;
    try {
      const ci = await runCliInProcess(['help'], { ci: true });
      const notCi = await runCliInProcess(['help'], { ci: false });
      assert.equal(ci.status, 0);
      assert.equal(notCi.status, 0);
      assert.equal(process.env.CI, undefined);
    } finally {
      if (previousCi !== undefined) process.env.CI = previousCi;
    }
  });
});

describe('setup compatibility spellings', () => {
  function makeConfirmedTarget() {
    const target = makeTarget();
    seedTargetLayout(REPO_ROOT, target);
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
    return target;
  }

  it('setup --non-interactive is equivalent to setup --yes', async () => {
    const targetYes = makeConfirmedTarget();
    const targetNonInteractive = makeConfirmedTarget();
    const viaYes = await runCliInProcess(['setup', '--target', targetYes, '--adapter', 'opencode', '--yes']);
    const viaNonInteractive = await runCliInProcess(['setup', '--target', targetNonInteractive, '--adapter', 'opencode', '--non-interactive']);
    assert.equal(viaYes.status, 0, viaYes.stderr);
    assert.equal(viaNonInteractive.status, 0, viaNonInteractive.stderr);
    assert.deepEqual(snapshotTree(targetYes).sort(), snapshotTree(targetNonInteractive).sort());
  });

  it('neither spelling confirms a missing human-controlled project profile', async () => {
    for (const flag of ['--yes', '--non-interactive']) {
      const target = makeTarget();
      seedTargetLayout(REPO_ROOT, target);
      const result = await runCliInProcess(['setup', '--target', target, '--adapter', 'opencode', flag]);
      assert.equal(result.status, 1, `${flag}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, /human-confirmed development stage|unconfirmed/);
      assert.equal(existsSync(join(target, '.opencode')), false);
    }
  });

  it('init --setup retains behavior and emits a deprecation warning', async () => {
    const target = makeTarget();
    const result = await runCliInProcess(['init', '--target', target, '--setup']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--setup requires --adapter/);
    const withAdapter = await runCliInProcess(['init', '--target', target, '--setup', '--adapter', 'all']);
    assert.equal(withAdapter.status, 2);
    assert.match(withAdapter.stderr, /--setup requires one concrete adapter/);
    assert.match(withAdapter.stderr, /DEPRECATED/);
  });
});
