/**
 * Importable CLI execution API.
 *
 * `runCli` executes a single agenticloop command in-process and returns its
 * numeric exit code without mutating global process state. Every command runs
 * through the injected-I/O contract: handlers receive an `io` context
 * (stdin/stdout/stderr, cwd, env, AbortSignal, prompt factory, and TTY/CI/
 * color capabilities) and return numeric exit codes. The thin binary
 * (`bin/agenticloop.js`) is the only entrypoint that assigns the returned code
 * to `process.exitCode`.
 *
 * Exit statuses:
 *   0    success, safe no-op, displayed help/version, or cancellation before apply
 *   1    operational, configuration, validation, or apply failure
 *   2    invalid command-line usage (CliUsageError)
 *   130  user interruption propagated through the cancellation contract
 *
 * Importing this module (or `./cli.js`) does not execute any command, so tests
 * can drive commands in-process.
 */

import {
  createIo,
  CliAbortError,
  CliUsageError,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_USAGE,
} from './cli-io.js';
import { dispatch } from './cli.js';

/**
 * @param {string[]} argv  Arguments after the node/bin prefix (e.g. process.argv.slice(2)).
 * @param {object} [options]
 * @param {string} [options.cwd]       Working directory for relative target resolution.
 * @param {NodeJS.ProcessEnv} [options.env]  Environment for env-sensitive behavior.
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {AbortSignal} [options.signal]  Cancellation propagated to prompts/planning/apply.
 * @param {boolean} [options.isTTY]     Override stdout TTY capability.
 * @param {boolean} [options.ci]        Override CI detection.
 * @param {boolean} [options.color]     Override color capability.
 * @param {Function} [options.promptFactory]  Injectable prompt factory for tests.
 * @param {Function} [options.ghCommandRunner]  Injectable read-only GitHub command runner for tests.
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, options = {}) {
  const io = createIo(options);
  try {
    io.throwIfAborted();
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(error.message);
      if (error.hint) io.err(error.hint);
      return EXIT_USAGE;
    }
    if (error instanceof CliAbortError || error?.name === 'AbortError') {
      io.err('Interrupted.');
      return EXIT_INTERRUPTED;
    }
    io.err(error?.stack ?? String(error));
    return EXIT_FAILURE;
  }
}

export { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_USAGE };
