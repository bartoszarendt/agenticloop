import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 100;
const DEFAULT_SETTLEMENT_GRACE_MS = 250;

function boundedOutput(limit) {
  const chunks = [];
  let length = 0;
  let truncated = false;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      chunks.push(buffer.subarray(0, remaining));
      length += Math.min(buffer.length, remaining);
      truncated ||= buffer.length > remaining;
    },
    get text() { return Buffer.concat(chunks, length).toString('utf8'); },
    get truncated() { return truncated; },
  };
}

function terminateTree(child, signal) {
  if (!child?.pid) return false;
  try {
    if (process.platform === 'win32') {
      // `/pid` scopes taskkill to this exact root PID; `/t` includes only its
      // tree. Windows uses a forced tree kill for both attempts because console
      // processes do not have a reliable SIGTERM-equivalent through taskkill.
      return spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      }).status === 0;
    }
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Run an executable without a shell and return bounded output plus its outcome. */
export function runProcess(command, args, {
  cwd,
  env,
  stdio = ['ignore', 'pipe', 'pipe'],
  timeout = 120000,
  timeoutAfterStdout = null,
  startupTimeout = timeout,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  terminationGrace = DEFAULT_TERMINATION_GRACE_MS,
  settlementGrace = DEFAULT_SETTLEMENT_GRACE_MS,
} = {}) {
  return new Promise(resolveResult => {
    const stdout = boundedOutput(outputLimit);
    const stderr = boundedOutput(outputLimit);
    let timedOut = false;
    let spawnError = null;
    let timer = null;
    let escalationTimer = null;
    let settlementTimer = null;
    let settled = false;
    let child;
    let readinessOutput = '';
    const windowsTermination = process.platform === 'win32';
    const termination = {
      readiness: { signal: timeoutAfterStdout, observed: false, startupTimeout },
      initial: {
        signal: windowsTermination ? null : 'SIGTERM',
        method: windowsTermination ? 'taskkill /pid /t /f' : 'process-group signal',
        forced: windowsTermination,
        attempted: false,
      },
      escalation: {
        signal: windowsTermination ? null : 'SIGKILL',
        method: windowsTermination ? 'taskkill /pid /t /f retry' : 'process-group signal',
        forced: true,
        attempted: false,
      },
      scope: windowsTermination ? 'pid-tree' : 'process-group',
      timeoutPhase: null,
      settledWithoutClose: false,
    };
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
    };
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolveResult({
        status: spawnError || timedOut ? null : status,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        error: spawnError,
        failure: spawnError ? 'spawn' : timedOut ? 'timeout' : signal ? 'signal' : null,
        timedOut,
        termination,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };
    const armTimeout = (delay, phase) => {
      if (timer || delay <= 0) return;
      timer = setTimeout(() => {
        timedOut = true;
        termination.timeoutPhase = phase;
        termination.initial.attempted = terminateTree(child, termination.initial.signal);
        escalationTimer = setTimeout(() => {
          termination.escalation.attempted = terminateTree(child, termination.escalation.signal);
          settlementTimer = setTimeout(() => {
            termination.settledWithoutClose = true;
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            settle(null, null);
          }, settlementGrace);
          settlementTimer.unref();
        }, terminationGrace);
        escalationTimer.unref();
      }, delay);
      timer.unref();
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      spawnError = error;
      settle(null, null);
      return;
    }
    child.stdout?.on('data', chunk => {
      stdout.append(chunk);
      if (timeoutAfterStdout && !termination.readiness.observed) {
        const received = readinessOutput + chunk.toString('utf8');
        termination.readiness.observed = received.includes(timeoutAfterStdout);
        readinessOutput = received.slice(-timeoutAfterStdout.length);
        if (termination.readiness.observed && !timedOut) {
          if (timer) clearTimeout(timer);
          timer = null;
          armTimeout(timeout, 'runtime');
        }
      }
    });
    child.stderr?.on('data', chunk => stderr.append(chunk));
    child.once('error', error => {
      spawnError = error;
      settle(null, null);
    });
    armTimeout(timeoutAfterStdout ? startupTimeout : timeout, timeoutAfterStdout ? 'startup' : 'runtime');
    child.once('close', settle);
  });
}
