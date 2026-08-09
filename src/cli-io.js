/**
 * Injectable I/O and execution context for CLI command handlers.
 *
 * A CLI handler receives an `io` object instead of reaching for global
 * `console`, `process.stdin`, `process.cwd()`, or `process.env`. This lets the
 * same handler run in a real process (defaults) or in-process under test
 * (memory-backed streams, explicit cwd/env, injected prompts, injected
 * capabilities, injected AbortSignal) without touching global process state.
 *
 * The `out`/`err`/`warn` writers join string arguments with a single space,
 * append a newline, and route to the stdout/stderr streams. Human results go
 * to stdout; warnings and errors go to stderr. In JSON mode, stdout must
 * contain exactly one machine-readable document, so diagnostics always use
 * stderr.
 *
 * Capabilities (TTY, CI, color, progress) are detected from the injected
 * streams/env by default and can be overridden independently per test without
 * mutating process globals. Color and progress are presentational only: they
 * never replace words, and they are disabled for non-TTY, CI, NO_COLOR, and
 * redirected output.
 *
 * Cancellation flows through one AbortSignal: runCli, prompts, planning, and
 * apply all observe `io.signal`. Handlers translate an abort into exit status
 * 130 via `CliAbortError`.
 */

import { createPrompts } from './configure-models.js';
import { isAbsolute, resolve } from 'node:path';

/**
 * Resolve a `--target` option against the injected I/O cwd. Relative targets
 * resolve against `io.cwd` (never `process.cwd()`), absolute targets are
 * preserved, and an omitted target means the injected cwd itself. Every
 * public command must use this helper so tests can prove `process.cwd()` is
 * never consulted.
 *
 * @param {object} io
 * @param {string|undefined} targetOption
 * @returns {string}
 */
export function resolveCliTarget(io, targetOption) {
  if (!targetOption) return io.cwd;
  return isAbsolute(targetOption) ? resolve(targetOption) : resolve(io.cwd, targetOption);
}

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

/** Invalid command-line usage. runCli renders the message and exits 2. */
export class CliUsageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = EXIT_USAGE;
    this.hint = options.hint ?? null;
    this.code = 'cli.usage';
    this.evidenceState = 'negative';
    this.disposition = 'blocked';
  }
}

/** User interruption propagated through the cancellation contract (exit 130). */
export class CliAbortError extends Error {
  constructor(message = 'Interrupted') {
    super(message);
    this.name = 'CliAbortError';
    this.exitCode = EXIT_INTERRUPTED;
  }
}

function makeWriter(stream) {
  return (...args) => {
    stream.write(args.join(' ') + '\n');
  };
}

function detectCi(env) {
  const value = env.CI ?? env.CONTINUOUS_INTEGRATION;
  if (value === undefined || value === null) return false;
  return value !== '' && value !== 'false' && value !== '0';
}

function detectColor(env, stdoutIsTTY, ci) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return stdoutIsTTY && !ci;
}

/**
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.isTTY]        Override stdout TTY capability.
 * @param {boolean} [options.stdinIsTTY]   Override stdin TTY capability.
 * @param {boolean} [options.ci]           Override CI detection.
 * @param {boolean} [options.color]        Override color capability.
 * @param {(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => object} [options.promptFactory]
 * @param {Function} [options.ghCommandRunner]  Injectable read-only GitHub command runner for tests.
 * @param {Function} [options.auditProvenanceVerifier] Host receipt verifier for Auditor delegations.
 * @param {string} [options.operatorTrustRoot] Test-only alternate registry root; it cannot authorize supported adapters.
 * @param {Function} [options.hostAuthority] Host transport for a nonce-bound, Ed25519-signed boundary challenge response.
 * @returns {object} io context
 */
export function createIo(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const signal = options.signal ?? null;
  const isTTY = options.isTTY ?? Boolean(stdout.isTTY);
  const stdinIsTTY = options.stdinIsTTY ?? Boolean(stdin.isTTY);
  const ci = options.ci ?? detectCi(env);
  const color = options.color ?? detectColor(env, isTTY, ci);

  const io = {
    stdin,
    stdout,
    stderr,
    cwd,
    env,
    signal,
    isTTY,
    stdinIsTTY,
    ci,
    color,
    out: makeWriter(stdout),
    err: makeWriter(stderr),
    warn: makeWriter(stderr),
    ghCommandRunner: options.ghCommandRunner ?? null,
    auditProvenanceVerifier: options.auditProvenanceVerifier ?? null,
    operatorTrustRoot: options.operatorTrustRoot ?? null,
    hostAuthority: options.hostAuthority ?? null,
    fsMutationOptions: options.fsMutationOptions ?? null,
  };

  io.style = (text, code) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  io.bold = (text) => io.style(text, 1);
  io.dim = (text) => io.style(text, 2);

  io.throwIfAborted = () => {
    if (signal?.aborted) {
      throw new CliAbortError();
    }
  };

  /**
   * Create a prompt session bound to this io context. The default factory is
   * the canonical line-prompt implementation from configure-models.js; tests
   * may inject a scripted factory through createIo options. The returned
   * session's ask() rejects with CliAbortError when io.signal aborts.
   */
  io.createPrompts = () => {
    const factory = options.promptFactory ?? defaultPromptFactory;
    const session = factory(stdin, stdout);
    if (!signal) return session;
    const ask = session.ask.bind(session);
    return {
      ...session,
      ask: (question) => {
        io.throwIfAborted();
        return new Promise((resolvePromise, rejectPromise) => {
          const onAbort = () => rejectPromise(new CliAbortError());
          signal.addEventListener('abort', onAbort, { once: true });
          ask(question).then(
            answer => {
              signal.removeEventListener('abort', onAbort);
              resolvePromise(answer);
            },
            error => {
              signal.removeEventListener('abort', onAbort);
              rejectPromise(error);
            }
          );
        });
      },
    };
  };

  /**
   * Progress reporter for genuinely slow operations. Returns a no-op reporter
   * unless progress capability is enabled (TTY, not CI, not JSON mode, not
   * redirected). Commands set `io.progressEnabled` explicitly.
   */
  io.progressEnabled = false;
  io.createProgress = (label) => {
    if (!io.progressEnabled) {
      return { update: () => {}, done: () => {} };
    }
    stderr.write(`${label}...\n`);
    return {
      update: (text) => stderr.write(`${label}: ${text}\n`),
      done: (text) => stderr.write(`${label}: ${text ?? 'done'}\n`),
    };
  };

  return io;
}

function defaultPromptFactory(input, output) {
  return createPrompts(input, output);
}
