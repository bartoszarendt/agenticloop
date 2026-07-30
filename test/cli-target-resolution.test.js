/**
 * Injected-cwd target resolution tests.
 *
 * Every public command resolves a relative --target against the injected
 * io.cwd via resolveCliTarget, never against process.cwd(). Each row runs a
 * command with a target that exists ONLY under the injected cwd and asserts
 * the command inspected or mutated that directory, that process.cwd() is
 * unchanged, and that no probe directory appears under process.cwd().
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runCliInProcess, scriptedStdin } from './helpers/run-cli.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import { createIo, resolveCliTarget } from '../src/cli-io.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PROCESS_CWD = process.cwd();
const REL = `al-cwd-probe-${process.pid}`;
const PROBE_AT_PROCESS_CWD = join(PROCESS_CWD, REL);

let tmpBase;
let injectedCwd;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-cli-target-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  // A regression would create the probe under process.cwd(); clean it up.
  rmSync(PROBE_AT_PROCESS_CWD, { recursive: true, force: true });
});

function freshInjectedCwd() {
  injectedCwd = mkdtempSync(join(tmpBase, 'cwd-'));
  return injectedCwd;
}

function probeTarget() {
  return join(injectedCwd, REL);
}

function seededProbe() {
  const target = probeTarget();
  mkdirSync(target, { recursive: true });
  seedTargetLayout(REPO_ROOT, target);
  return target;
}

function assertProcessCwdUntouched() {
  assert.equal(process.cwd(), PROCESS_CWD, 'process.cwd() must be unchanged');
  assert.equal(existsSync(PROBE_AT_PROCESS_CWD), false,
    `no probe directory may appear under process.cwd(): ${PROBE_AT_PROCESS_CWD}`);
}

describe('resolveCliTarget', () => {
  it('returns io.cwd when no target is supplied', () => {
    const io = createIo({ cwd: '/injected' });
    assert.equal(resolveCliTarget(io, undefined), '/injected');
  });

  it('resolves relative targets against io.cwd, never process.cwd()', () => {
    const io = createIo({ cwd: '/injected' });
    assert.equal(resolveCliTarget(io, 'sub/dir'), resolve('/injected', 'sub/dir'));
  });

  it('preserves absolute targets', () => {
    const io = createIo({ cwd: '/injected' });
    const absolute = resolve('/elsewhere/target');
    assert.equal(resolveCliTarget(io, absolute), absolute);
  });
});

describe('relative --target resolves against the injected cwd', () => {
  it('init scaffolds only the injected-cwd target', async () => {
    freshInjectedCwd();
    const result = await runCliInProcess(['init', '--target', REL], { cwd: injectedCwd });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(probeTarget(), 'agenticloop', 'manifest.json')));
    assert.ok(existsSync(join(probeTarget(), '.agenticloop', 'project.md')));
    assertProcessCwdUntouched();
  });

  it('setup --dry-run plans against the injected-cwd target', async () => {
    freshInjectedCwd();
    const target = probeTarget();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'AGENTS.md'), '# AGENTS\n', 'utf-8');
    writeFileSync(join(target, 'README.md'), '# README\n', 'utf-8');
    const result = await runCliInProcess(['setup', '--target', REL, '--dry-run'], {
      cwd: injectedCwd,
      stdin: scriptedStdin(['yes', '', '']),
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Plan \(dry run/);
    assertProcessCwdUntouched();
  });

  it('update refreshes the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['update', '--target', REL], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertProcessCwdUntouched();
  });

  it('remove --dry-run inspects the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['remove', '--target', REL, '--dry-run'], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    // Dry-run removed nothing.
    assert.ok(existsSync(join(probeTarget(), 'agenticloop', 'manifest.json')));
    assertProcessCwdUntouched();
  });

  it('guidance apply writes the injected-cwd target only', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['guidance', 'apply', '--target', REL], { cwd: injectedCwd });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(probeTarget(), 'AGENTS.md'), 'utf-8'), /AGENTICLOOP_START/);
    assertProcessCwdUntouched();
  });

  it('validate inspects the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['validate', '--target', REL], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertProcessCwdUntouched();
  });

  it('configure models mutates the injected-cwd config only', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(
      ['configure', 'models', '--adapter', 'opencode', '--role', 'engineer', '--model', 'probe/model-x', '--target', REL],
      { cwd: injectedCwd }
    );
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const config = JSON.parse(readFileSync(join(probeTarget(), 'agenticloop.json'), 'utf-8'));
    assert.equal(config.adapters.opencode.roleSettings.engineer.model, 'probe/model-x');
    assertProcessCwdUntouched();
  });

  it('doctor and status read the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const doctor = await runCliInProcess(['doctor', '--target', REL], { cwd: injectedCwd });
    assert.equal(doctor.status, 0, `doctor: ${doctor.stdout}\n${doctor.stderr}`);
    const status = await runCliInProcess(['status', '--target', REL], { cwd: injectedCwd });
    assert.equal(status.status, 0, `status: ${status.stdout}\n${status.stderr}`);
    // The seeded config is what status reports on; reading process.cwd()
    // would report the repository's own installation instead.
    assert.match(status.stdout, /opencode/);
    assertProcessCwdUntouched();
  });

  it('worktree list inspects the injected-cwd repository', async (t) => {
    freshInjectedCwd();
    const target = probeTarget();
    mkdirSync(target, { recursive: true });
    try {
      execFileSync('git', ['init'], { cwd: target, stdio: 'ignore' });
    } catch {
      t.skip('git is not available');
      return;
    }
    const result = await runCliInProcess(['worktree', 'list', '--target', REL, '--json'], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertProcessCwdUntouched();
  });

  it('bootstrap-labels reads the injected-cwd task backend', async () => {
    freshInjectedCwd();
    const target = seededProbe();
    // A github-backend target lets a dry-run proceed; the repository root
    // (process.cwd()) uses the files backend and would refuse instead.
    mkdirSync(join(target, '.agenticloop'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'project.md'), [
      '---',
      'task_backend: "github"',
      '---',
      '# Project Map',
      '',
    ].join('\n'), 'utf-8');
    const result = await runCliInProcess(
      ['bootstrap-labels', '--repo', 'probe/repo', '--dry-run', '--target', REL],
      { cwd: injectedCwd }
    );
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /dry.run|would|label/i);
    assertProcessCwdUntouched();
  });

  it('generate writes adapter output under the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['generate', 'opencode', '--target', REL], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(join(probeTarget(), '.opencode')), 'adapter output must exist under the injected target');
    assertProcessCwdUntouched();
  });

  it('task new creates the record under the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['task', 'new', 'Probe', 'title', '--scaffold', '--target', REL], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(join(probeTarget(), '.agenticloop', 'tasks', 'T-001.md')));
    assertProcessCwdUntouched();
  });

  it('task list reads records from the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const created = await runCliInProcess(['task', 'new', 'Probe', 'title', '--scaffold', '--target', REL], { cwd: injectedCwd });
    assert.equal(created.status, 0, created.stderr);
    const result = await runCliInProcess(['task', 'list', '--target', REL, '--json'], { cwd: injectedCwd });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /T-001/);
    assertProcessCwdUntouched();
  });

  it('audit lint inspects the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(['audit', 'lint', '--target', REL, '--json'], { cwd: injectedCwd });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assertProcessCwdUntouched();
  });

  it('event-logging writes the event under the injected-cwd target', async () => {
    freshInjectedCwd();
    seededProbe();
    const result = await runCliInProcess(
      ['event-logging', 'task.started', '--task', 'T-001', '--summary', 'cwd probe', '--target', REL],
      { cwd: injectedCwd }
    );
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(existsSync(join(probeTarget(), '.agenticloop', 'logs', 'T-001.jsonl')));
    assertProcessCwdUntouched();
  });
});
