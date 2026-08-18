/**
 * One debug reference derivation, and one opt-in root-cause stack emission.
 *
 * A public failure envelope deliberately says nothing about the internal cause.
 * That is only defensible when the envelope still carries a handle the caller
 * can quote and the operator can turn back into the cause: a stable digest of
 * the command and the internal message, plus a `--debug` /
 * `AGENTICLOOP_DEBUG=1` switch that prints the real stack.
 *
 * The field record shows what happens without both. A `prepare-return` refusal
 * that caught its own error inside the command never reached the top-level
 * handler, so `--debug` printed nothing and `debugReference` was hardcoded to
 * `null`: an envelope with no root cause and no reference by which to request
 * one. Thirteen invocations produced thirteen identical, informationless
 * sentences, and the run ended with roles reading Agentic Loop's own source to
 * find out why.
 *
 * The digest is not a privacy leak: it is a one-way function of the command and
 * the internal message, which is exactly what a support channel needs to match
 * a report to a producer path without the report carrying internal prose.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/**
 * The debug context of the currently executing command.
 *
 * Async-local rather than module-global: `runCli` is importable and several
 * commands can run concurrently in one process, so a shared mutable flag would
 * let one command's `--debug` print another command's stack.
 */
const debugContext = new AsyncLocalStorage();

/** Derive the stable public handle for one internal failure. */
export function debugReferenceFor(command, error, boundaryError = null) {
  const material = [
    String(command ?? ''),
    error?.name ?? 'Error',
    error instanceof Error ? error.message : String(error),
    boundaryError?.name ?? '',
    boundaryError instanceof Error ? boundaryError.message : boundaryError ? String(boundaryError) : '',
  ].join('\0');
  return `debug:sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/**
 * Run one command with a debug context bound to it.
 *
 * @param {{ debug: boolean, io: { err: (line?: string) => void } }} context
 * @param {() => any} fn
 */
export function runWithDebugTrace(context, fn) {
  return debugContext.run(context, fn);
}

/**
 * Print the real stack of a failure the public envelope had to generalize.
 *
 * Best-effort by construction: debug output never changes what a command
 * returns, and a broken writer must not replace the command's own result.
 */
export function emitDebugTrace(reference, error) {
  const context = debugContext.getStore();
  if (!context?.debug || typeof context.io?.err !== 'function') return false;
  try {
    context.io.err(`debug reference: ${reference}`);
    context.io.err(error?.stack ?? String(error));
    return true;
  } catch {
    return false;
  }
}
