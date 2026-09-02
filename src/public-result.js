/**
 * Shared public gate-result presentation and failure normalization.
 *
 * The canonical public envelope helpers were private to `cli.js`; files
 * task-command boundaries need the same behavior at their
 * boundary, so they moved here rather than being reimplemented. There is still
 * exactly one place that turns a producer fact into a public validation result.
 */

import { CliUsageError } from './cli-io.js';
import {
  createValidationResult,
  deriveEvidenceState,
  dispositionForEvidenceState,
  emitValidationResult,
  normalizeEvidenceState,
} from './result-envelope.js';
import { OPERATIONAL_FAILURE_MESSAGE } from './public-error.js';
import { debugReferenceFor, emitDebugTrace } from './debug-trace.js';
import { createDiagnostic, repairPolicyFor } from './repair-policy.js';
import { presentDiagnostic } from './diagnostic-presentation.js';
import { getProjectRoleCapabilities } from './role-capabilities.js';

/**
 * Print one gate result, canonically serialized in JSON mode.
 *
 * @returns {number} process exit code
 */
export function printGateResult(command, result, asJson, io, exitCode = null) {
  const status = exitCode ?? (result.ok ? 0 : 1);
  if (asJson) {
    const output = status === 0 || result?.kind === 'agenticloop.validation-result'
      ? result
      : validationResultForGate(command, result);
    if (output?.kind === 'agenticloop.validation-result') emitValidationResult(io, output);
    else io.out(JSON.stringify(output));
    return status;
  }
  io.out();
  io.out(`agenticloop ${command}`);
  io.out('='.repeat(50));
  if (result.pr) io.out(`  PR: #${result.pr}`);
  if (result.issue) io.out(`  issue: #${result.issue}`);
  if (result.headRefOid) io.out(`  current head: ${result.headRefOid}`);
  io.out(`  status: ${result.ok ? 'passed' : 'FAILED'}`);
  // A successful non-terminal route (for example a pending exception request)
  // is authenticated and validly routed but grants no further authority, so the
  // disposition is printed rather than implied by "passed".
  if (result.ok && result.disposition && result.disposition !== 'proceed') {
    io.out(`  disposition: ${result.disposition}`);
  }
  for (const warning of result.warnings ?? []) io.warn(`  WARN: ${warning}`);
  for (const error of result.errors ?? []) io.err(`  ERROR: ${error}`);
  const firstSafeRepair = result.firstSafeRepair ?? result.diagnostics?.[0]?.repairHint ?? null;
  if (firstSafeRepair) io.out(`  first safe repair: ${firstSafeRepair}`);
  io.out();
  return status;
}

/** Project an evaluator result into the canonical public validation result. */
export function validationResultForGate(command, result) {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    command: _command,
    ok: _ok,
    evidenceState: _evidenceState,
    disposition: _disposition,
    diagnostics: _diagnostics,
    warningDiagnostics: _warningDiagnostics,
    errors: _errors,
    warnings: _warnings,
    failureCategories: _failureCategories,
    firstSafeRepair: _firstSafeRepair,
    rollbackAuthorized: _rollbackAuthorized,
    debugReference: _debugReference,
    ...domainFields
  } = result ?? {};
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  const hasDeclaredEvidenceState = Object.hasOwn(result ?? {}, 'evidenceState');
  const declaredEvidenceState = result?.evidenceState;
  const evidenceState = hasDeclaredEvidenceState
    ? normalizeEvidenceState(declaredEvidenceState)
    : deriveEvidenceState(diagnostics) ?? 'negative';
  const disposition = hasDeclaredEvidenceState && evidenceState !== declaredEvidenceState
    ? dispositionForEvidenceState(evidenceState)
    : result?.disposition ?? dispositionForEvidenceState(evidenceState);
  return createValidationResult({
    command,
    evidenceState,
    disposition,
    diagnostics,
    warningDiagnostics: result?.warningDiagnostics ?? [],
    errors: result?.errors ?? [],
    warnings: result?.warnings ?? [],
    firstSafeRepair: result?.firstSafeRepair ?? diagnostics[0]?.nextAction ?? null,
    debugReference: result?.debugReference ?? null,
    ...domainFields,
  });
}

/** Normalize a producer error into the canonical public validation result. */
export function commandFailure(command, error, category = 'operational_error', domainFields = {}, target = null) {
  const usage = category === 'usage' || error instanceof CliUsageError;
  const requestedCode = usage
    ? 'cli.usage'
    : typeof error?.code === 'string' ? error.code : 'cli.operational';
  let code = requestedCode;
  try { repairPolicyFor(code); } catch { code = usage ? 'cli.usage' : 'cli.operational'; }
  const message = typeof error?.publicMessage === 'string'
    ? error.publicMessage
    : usage
      ? error instanceof Error ? error.message : String(error)
      : OPERATIONAL_FAILURE_MESSAGE;
  const evidenceState = error?.evidenceState ?? (usage ? 'negative' : 'missing');
  const disposition = error?.disposition ?? dispositionForEvidenceState(evidenceState);
  // A command that catches its own failure never reaches the top-level handler,
  // so this boundary owns both halves of diagnosability: the stable public
  // handle, and the opt-in stack behind `--debug` / AGENTICLOOP_DEBUG=1.
  const reference = debugReferenceFor(command, error);
  emitDebugTrace(reference, error);
  const diagnostic = presentDiagnostic(createDiagnostic({
    code,
    message,
    evidence: {
      state: evidenceState,
      committedStateEvaluated: error?.committedStateEvaluated ?? usage,
      rollbackAuthorized: false,
    },
    repairHint: error?.safeRepair ?? error?.hint ?? 'Correct the command input or unavailable dependency, then rerun.',
  }), getProjectRoleCapabilities(target));
  return createValidationResult({
    command,
    evidenceState,
    disposition,
    diagnostics: [diagnostic],
    firstSafeRepair: error?.safeRepair ?? error?.hint ?? diagnostic.nextAction,
    debugReference: reference,
    requiredContext: Array.isArray(error?.requiredContext) ? error.requiredContext : [],
    ...(usage ? {
      safeToRetry: error?.safeToRetry === true && error?.mutationOccurred !== true,
      mutationOccurred: error?.mutationOccurred === true,
      canonicalUsage: error?.canonicalUsage ?? error?.hint ?? null,
    } : {}),
    ...domainFields,
  });
}
