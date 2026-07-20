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
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export async function runCliInProcess(argv, options = {}) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const status = await runCli(argv, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdout,
    stderr,
  });
  return {
    status,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  };
}
