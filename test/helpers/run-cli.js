/**
 * In-process CLI runner for tests.
 *
 * Executes a migrated agenticloop command in-process via `runCli` and returns a
 * subprocess-like result (`{ status, stdout, stderr }`). Output is captured with
 * memory-backed writers instead of replacing global `console`, and the command's
 * `cwd`/`env` are injected explicitly so the parent process state is never
 * mutated. Use this for command-behavior tests; keep true subprocess execution
 * for the small smoke-test surface that exercises the real binary, TTY behavior,
 * packaging, and exit-code propagation.
 */

import { runCli } from '../../src/cli-main.js';

class MemoryStream {
  constructor() {
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }

  toString() {
    return this.chunks.join('');
  }
}

/**
 * @param {string[]} argv
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.isTTY]
 * @param {boolean} [options.stdinIsTTY]
 * @param {boolean} [options.ci]
 * @param {boolean} [options.color]
 * @param {Function} [options.promptFactory]
 * @param {Function} [options.ghCommandRunner]  Injectable read-only GitHub command runner.
 * @param {string} [options.operatorTrustRoot]  Injectable host-owned trust registry root.
 * @param {string} [options.operatorActivationRoot]  Injectable per-user operator activation root.
 * @param {Function} [options.hostAuthority] Test transport for a signed host-boundary challenge response.
 * @param {Function|null} [options.auditProvenanceVerifier] Protected test-only Auditor receipt verifier.
 * @param {object} [options.fsMutationOptions]  Injectable filesystem mutation hooks.
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function runCliInProcess(argv, options = {}) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const status = await runCli(argv, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdin: options.stdin,
    stdout,
    stderr,
    signal: options.signal,
    isTTY: options.isTTY,
    stdinIsTTY: options.stdinIsTTY,
    ci: options.ci,
    color: options.color,
    promptFactory: options.promptFactory,
    ghCommandRunner: options.ghCommandRunner,
    operatorTrustRoot: options.operatorTrustRoot,
    operatorActivationRoot: options.operatorActivationRoot,
    hostAuthority: options.hostAuthority,
    auditProvenanceVerifier: Object.hasOwn(options, 'auditProvenanceVerifier')
      ? options.auditProvenanceVerifier
      : ({ reportDigest }) => ({ verified: true, reportDigest }),
    fsMutationOptions: options.fsMutationOptions,
  });
  return {
    status,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
}

/**
 * A readable stream scripted with predefined lines, for prompt-driving tests.
 */
export function scriptedStdin(lines) {
  const chunks = [...lines];
  let index = 0;
  const listeners = { data: [], end: [] };
  const stream = {
    isTTY: false,
    setEncoding() {},
    on(event, fn) {
      listeners[event]?.push(fn);
      if (event === 'data') queueMicrotask(() => pump());
      return stream;
    },
    removeListener(event, fn) {
      const list = listeners[event];
      if (!list) return stream;
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
      return stream;
    },
    pause() {},
    resume() {},
  };
  let pumped = false;
  function pump() {
    if (pumped) return;
    pumped = true;
    for (const line of chunks) {
      for (const fn of listeners.data) fn(line + '\n');
    }
    for (const fn of listeners.end) fn();
  }
  return stream;
}

/**
 * A prompt factory scripted with predefined answers, for interactive tests
 * that should not depend on stream timing.
 */
export function scriptedPromptFactory(answers) {
  const queue = [...answers];
  return () => ({
    ask: () => Promise.resolve(queue.length > 0 ? queue.shift() : ''),
    write: () => {},
    close: () => {},
  });
}
