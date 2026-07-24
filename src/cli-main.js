/**
 * Importable CLI execution API.
 *
 * `runCli` executes a single agenticloop command and returns its numeric exit
 * code without mutating global process state. Commands that implement the
 * injectable-io contract run in-process. Transitional legacy commands run in
 * an isolated child process, which preserves the same cwd/env/output contract
 * without exposing their internal `process.exitCode` and `console` usage to the
 * caller. The thin binary (`bin/agenticloop.js`) is the only public entrypoint
 * that assigns the returned code to `process.exitCode`.
 *
 * Importing this module (or `./cli.js`) does not execute any command, so tests
 * can drive commands in-process.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createIo } from './cli-io.js';
import { dispatch } from './cli.js';

const BIN = fileURLToPath(new URL('../bin/agenticloop.js', import.meta.url));
const IN_PROCESS_COMMANDS = new Set([
  undefined,
  '--help',
  '-h',
  'help',
  'task',
  'audit',
  'event',
  'event-logging',
]);

function runLegacySubprocess(argv, io) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd: io.cwd,
      env: io.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', chunk => io.stdout.write(chunk));
    child.stderr.on('data', chunk => io.stderr.write(chunk));
    child.on('error', error => {
      io.err(`Failed to start agenticloop CLI: ${error.message}`);
      resolvePromise(1);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        io.err(`agenticloop CLI terminated by signal ${signal}`);
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * @param {string[]} argv  Arguments after the node/bin prefix (e.g. process.argv.slice(2)).
 * @param {object} [options]
 * @param {string} [options.cwd]     Working directory for relative target resolution.
 * @param {NodeJS.ProcessEnv} [options.env]  Environment for env-sensitive behavior.
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, options = {}) {
  const io = createIo(options);
  if (!IN_PROCESS_COMMANDS.has(argv[0]) && options.legacyInProcess !== true) {
    return await runLegacySubprocess(argv, io);
  }
  return await dispatch(argv, io);
}
