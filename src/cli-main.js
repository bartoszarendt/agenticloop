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
  resolveCliTarget,
} from './cli-io.js';
import { dispatch } from './cli.js';
import { COMMAND_REGISTRY } from './cli-registry.js';
import { debugReferenceFor, runWithDebugTrace } from './debug-trace.js';
import { createDiagnostic, repairPolicyFor } from './repair-policy.js';
import { minimalUnexpectedFailureResult, presentDiagnostic } from './diagnostic-presentation.js';
import { getProjectRoleCapabilities } from './role-capabilities.js';
import { createValidationResult, emitValidationResult } from './result-envelope.js';
import { OPERATIONAL_FAILURE_MESSAGE } from './public-error.js';

const UNEXPECTED_FAILURE_MESSAGE = 'Validation or evaluation did not complete; rerun with --debug and provide the debug reference if support is required.';
const UNEXPECTED_FAILURE_REPAIR = 'Rerun once with --debug. If it fails again, report the debug reference; do not retry automatically.';

function commandSpec(argv) {
  const token = argv[0];
  const entry = COMMAND_REGISTRY[token]
    ?? Object.values(COMMAND_REGISTRY).find(candidate => candidate.aliases?.includes(token));
  if (!entry) return null;
  const subcommand = entry.subcommands?.[argv[1]];
  if (subcommand) return subcommand;
  if (entry.eventTypeOptions && argv[1] && !entry.subcommands?.[argv[1]]) {
    return { options: entry.eventTypeOptions };
  }
  return entry;
}

/**
 * Extract the global debug flag without treating a string-option value or a
 * token after `--` as a flag. Command parsing still owns every other token.
 */
function extractGlobalDebug(argv) {
  const stringOptions = new Set(
    (commandSpec(argv)?.options ?? [])
      .filter(option => option.type === 'string')
      .map(option => `--${option.name}`)
  );
  const publicArgv = [];
  let debug = false;
  let afterTerminator = false;
  let pendingStringOption = null;
  let targetOption;
  for (const argument of argv) {
    if (afterTerminator) {
      publicArgv.push(argument);
      continue;
    }
    if (pendingStringOption) {
      publicArgv.push(argument);
      if (pendingStringOption === '--target') targetOption = argument;
      pendingStringOption = null;
      continue;
    }
    if (argument === '--') {
      afterTerminator = true;
      publicArgv.push(argument);
      continue;
    }
    if (argument === '--debug') {
      debug = true;
      continue;
    }
    publicArgv.push(argument);
    if (stringOptions.has(argument)) {
      pendingStringOption = argument;
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals > 0 && stringOptions.has(argument.slice(0, equals)) && argument.slice(0, equals) === '--target') {
      targetOption = argument.slice(equals + 1);
    }
  }
  return { debug, publicArgv, targetOption };
}

function debugReference(argv, error, boundaryError = null) {
  return debugReferenceFor(argv.join(' '), error, boundaryError);
}

/**
 * Last-resort result that has no target capability, repair-policy, or
 * constructor dependency. Key insertion order is canonical JSON order so the
 * direct JSON.stringify fallback remains deterministic if serialization fails.
 */
function minimalPublicFailure(argv, error, boundaryError = null) {
  const command = argv.join(' ');
  const reference = debugReference(argv, error, boundaryError);
  return minimalUnexpectedFailureResult({
    command,
    debugReference: reference,
    message: UNEXPECTED_FAILURE_MESSAGE,
    repair: UNEXPECTED_FAILURE_REPAIR,
  });
}

function publicFailure(argv, error, target) {
  const internalMessage = error instanceof Error ? error.message : String(error);
  const requestedCode = typeof error?.code === 'string' ? error.code : error instanceof CliUsageError ? 'cli.usage' : 'cli.unexpected';
  let code = requestedCode;
  try { repairPolicyFor(code); } catch { code = error instanceof CliUsageError ? 'cli.usage' : 'cli.unexpected'; }
  const unexpected = code === 'cli.unexpected';
  const message = unexpected
    ? UNEXPECTED_FAILURE_MESSAGE
    : typeof error?.publicMessage === 'string'
      ? error.publicMessage
      : error instanceof CliUsageError
        ? internalMessage
        : OPERATIONAL_FAILURE_MESSAGE;
  const evidenceState = unexpected ? 'missing' : error?.evidenceState ?? (error instanceof CliUsageError ? 'negative' : 'missing');
  const disposition = unexpected
    ? 'blocked'
    : error?.disposition ?? (evidenceState === 'missing' ? 'needs_context' : evidenceState === 'changed' || evidenceState === 'stale' ? 'superseded' : 'blocked');
  const repairHint = unexpected ? UNEXPECTED_FAILURE_REPAIR : error?.safeRepair ?? error?.hint ?? null;
  const diagnostic = presentDiagnostic(createDiagnostic({
    code,
    message,
    evidence: {
      state: evidenceState,
      committedStateEvaluated: unexpected ? false : error?.committedStateEvaluated ?? (error instanceof CliUsageError),
      rollbackAuthorized: false,
    },
    repairHint,
  }), getProjectRoleCapabilities(target));
  const command = argv.join(' ');
  return createValidationResult({
    command,
    evidenceState,
    disposition,
    diagnostics: [diagnostic],
    firstSafeRepair: repairHint ?? diagnostic.nextAction ?? null,
    debugReference: debugReference(argv, error),
    requiredContext: Array.isArray(error?.requiredContext) && error.requiredContext.length > 0
      ? error.requiredContext
      : code === 'task.record.structure'
        ? ['a trusted prior canonical record or human-authorized reconstruction of the duplicated structure']
        : [],
  });
}

function emitHumanFailure(io, result, error) {
  const diagnostic = result?.diagnostics?.[0] ?? {};
  const message = result?.errors?.[0] ?? UNEXPECTED_FAILURE_MESSAGE;
  const hint = error?.hint;
  io.err(`[${diagnostic.code ?? 'cli.unexpected'}] ${message}`);
  if (error instanceof CliUsageError && hint) io.err(hint);
  if (result?.debugReference) io.err(`debug reference: ${result.debugReference}`);
  if (result?.firstSafeRepair && (!hint || result.firstSafeRepair !== hint)) {
    io.err(`first safe repair: ${result.firstSafeRepair}`);
  }
}

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
 * @param {string} [options.operatorTrustRoot]  Per-user host trust registry root.
 * @param {string} [options.operatorActivationRoot]  Per-user operator activation root.
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, options = {}) {
  const io = createIo(options);
  const extracted = extractGlobalDebug(argv);
  const debug = extracted.debug || io.env.AGENTICLOOP_DEBUG === '1';
  const publicArgv = extracted.publicArgv;
  try {
    io.throwIfAborted();
    // Commands that catch their own failures never reach this handler, so the
    // debug switch is bound to the whole execution rather than to this catch.
    return await runWithDebugTrace({ debug, io }, () => dispatch(publicArgv, io));
  } catch (error) {
    if (error instanceof CliAbortError || error?.name === 'AbortError') {
      io.err('Interrupted.');
      return EXIT_INTERRUPTED;
    }
    const boundaryErrors = [];
    let result;
    try {
      result = publicFailure(publicArgv, error, resolveCliTarget(io, extracted.targetOption));
    } catch (boundaryError) {
      boundaryErrors.push(boundaryError);
      result = minimalPublicFailure(publicArgv, error, boundaryError);
    }
    if (publicArgv.includes('--json')) {
      try {
        emitValidationResult(io, result);
      } catch (boundaryError) {
        boundaryErrors.push(boundaryError);
        result = minimalPublicFailure(publicArgv, error, boundaryError);
        io.out(JSON.stringify(result));
      }
    } else {
      try {
        emitHumanFailure(io, result, error);
      } catch (boundaryError) {
        boundaryErrors.push(boundaryError);
        result = minimalPublicFailure(publicArgv, error, boundaryError);
        try {
          emitHumanFailure(io, result, null);
        } catch (fallbackError) {
          boundaryErrors.push(fallbackError);
        }
      }
    }
    if (debug) {
      try {
        io.err(error?.stack ?? String(error));
        for (const boundaryError of boundaryErrors) {
          io.err(`Failure rendering error: ${boundaryError?.stack ?? String(boundaryError)}`);
        }
      } catch {
        // Debug output is best-effort and must never replace the command's exit.
      }
    }
    return error instanceof CliUsageError ? EXIT_USAGE : EXIT_FAILURE;
  }
}

export { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_USAGE };
