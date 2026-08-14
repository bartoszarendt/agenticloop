import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runProcess } from './helpers/process-runner.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-process-runner-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 1000;
  while (pidIsAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return !pidIsAlive(pid);
}

describe('process runner', () => {
  it('returns normal, nonzero, signal, and spawn outcomes without a shell', async () => {
    const cwd = mkdtempSync(join(temp, 'cwd-'));
    const success = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.cwd(), process.env.RUNNER_VALUE]))'], {
      cwd, env: { ...process.env, RUNNER_VALUE: 'present' },
    });
    const nonzero = await runProcess(process.execPath, ['-e', 'process.stderr.write("expected"); process.exit(7)']);
    const signalled = await runProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']);
    const missing = await runProcess(join(temp, 'missing-runner-command'), []);
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout), [cwd, 'present']);
    assert.equal(success.failure, null);
    assert.equal(nonzero.status, 7);
    assert.equal(nonzero.stderr, 'expected');
    assert.equal(nonzero.failure, null);
    if (process.platform === 'win32') {
      assert.equal(signalled.status, 1, 'Windows reports SIGTERM self-termination as a numeric exit');
      assert.equal(signalled.signal, null);
    } else {
      assert.equal(signalled.failure, 'signal');
      assert.equal(signalled.signal, 'SIGTERM');
    }
    assert.equal(missing.failure, 'spawn');
    assert.equal(missing.status, null);
    assert.equal(missing.error?.code, 'ENOENT');
  });

  it('bounds stdout and stderr collection', async () => {
    const result = await runProcess(process.execPath, [
      '-e', 'process.stdout.write("o".repeat(64)); process.stderr.write("e".repeat(64));',
    ], { outputLimit: 16 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.length, 16);
    assert.equal(result.stderr.length, 16);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
  });

  it('arms a timeout after readiness and settles with inherited descendant pipes', { timeout: 5000 }, async () => {
    const fixture = mkdtempSync(join(temp, 'inherited-pipe-'));
    const pidPath = join(fixture, 'descendant.pid');
    const parent = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: true });',
      'child.unref();',
      'writeFileSync(process.argv[1], String(child.pid));',
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("READY\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    try {
      const result = await runProcess(process.execPath, ['-e', parent, pidPath], {
        timeout: 100, timeoutAfterStdout: 'READY\n', startupTimeout: 1000,
        terminationGrace: 50, settlementGrace: 100,
      });
      assert.equal(result.failure, 'timeout');
      assert.equal(result.status, null);
      assert.equal(result.timedOut, true);
      assert.ok(result.termination.readiness.observed);
      assert.equal(result.termination.timeoutPhase, 'runtime');
      if (process.platform !== 'win32') {
        assert.equal(result.termination.escalation.signal, 'SIGKILL');
        assert.ok(result.termination.escalation.attempted, 'a SIGTERM-resistant group must escalate');
      }
      assert.ok(existsSync(pidPath));
    } finally {
      if (existsSync(pidPath)) {
        const pid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
        if (Number.isInteger(pid) && pid > 0 && pidIsAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  });

  it('bounds startup when the readiness signal never arrives', { timeout: 5000 }, async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeout: 2000,
      timeoutAfterStdout: 'READY\n',
      startupTimeout: 100,
      terminationGrace: 50,
      settlementGrace: 100,
    });

    assert.equal(result.failure, 'timeout');
    assert.equal(result.timedOut, true);
    assert.equal(result.termination.readiness.observed, false);
    assert.equal(result.termination.timeoutPhase, 'startup');
  });

  it('terminates a timed-out descendant process tree', { timeout: 5000 }, async () => {
    const fixture = mkdtempSync(join(temp, 'descendant-tree-'));
    const pidPath = join(fixture, 'descendant.pid');
    const parent = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.argv[1], String(child.pid));',
      'process.stdout.write("READY\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    let descendantPid;
    try {
      const result = await runProcess(process.execPath, ['-e', parent, pidPath], {
        timeout: 150, timeoutAfterStdout: 'READY\n', startupTimeout: 1000,
        terminationGrace: 50, settlementGrace: 100,
      });
      assert.equal(result.failure, 'timeout');
      assert.equal(result.timedOut, true);
      assert.equal(result.termination.readiness.observed, true);
      assert.equal(result.termination.timeoutPhase, 'runtime');
      assert.equal(result.termination.scope, process.platform === 'win32' ? 'pid-tree' : 'process-group');
      if (process.platform === 'win32') {
        assert.equal(result.termination.initial.signal, null);
        assert.equal(result.termination.initial.method, 'taskkill /pid /t /f');
        assert.equal(result.termination.initial.forced, true);
      } else {
        assert.equal(result.termination.initial.signal, 'SIGTERM');
        assert.equal(result.termination.initial.forced, false);
      }
      descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      assert.equal(await waitForExit(descendantPid), true, 'timed-out descendants must be cleaned up');
    } finally {
      if (descendantPid && pidIsAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    }
  });
});
