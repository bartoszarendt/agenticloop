/**
 * Injectable output/context for CLI command handlers.
 *
 * A CLI handler receives an `io` object instead of reaching for global
 * `console`, `process.cwd()`, or `process.env`. This lets the same handler run
 * in a real process (defaults) or in-process under test (memory-backed streams,
 * explicit cwd/env) without touching global process state.
 *
 * The `out`/`err`/`warn` writers mirror `console.log`/`console.error`/
 * `console.warn`: they join string arguments with a single space, append a
 * newline, and route to the stdout/stderr streams. `console.warn` writes to
 * stderr, so `warn` does too, preserving the original stream split that
 * subprocess-based tests assert against.
 */

function makeWriter(stream) {
  return (...args) => {
    stream.write(args.join(' ') + '\n');
  };
}

/**
 * @param {object} [options]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {NodeJS.WritableStream} [options.stderr]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{stdout, stderr, cwd, env, out: Function, err: Function, warn: Function}}
 */
export function createIo(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  return {
    stdout,
    stderr,
    cwd,
    env,
    out: makeWriter(stdout),
    err: makeWriter(stderr),
    warn: makeWriter(stderr),
  };
}
