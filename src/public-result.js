/**
 * Shared public gate-result presentation and failure normalization.
 *
 * The canonical public envelope helpers were private to `cli.js`; files
 * task-command boundaries need the same behavior at their
 * boundary, so they moved here rather than being reimplemented. There is still
 * exactly one place that turns a producer fact into a public validation result.
 */

import { CliUsageError } from './cli-io.js';
import { createValidationResult, emitValidationResult } from './result-envelope.js';
import { OPERATIONAL_FAILURE_MESSAGE } from './public-error.js';
import { createDiagnostic, repairPolicyFor } from './repair-policy.js';
import { presentDiagnostic } from './diagnostic-presentation.js';
import { getProjectRoleCapabilities } from './role-capabilities.js';

const EVIDENCE_STATES = ['missing', 'malformed', 'stale', 'negative', 'changed'];

function dispositionForEvidence(evidenceState) {
  if (evidenceState === 'missing') return 'needs_context';
  if (evidenceState === 'malformed') return 'rejected';
  if (evidenceState === 'stale' || evidenceState === 'changed') return 'superseded';
  return 'blocked';
}

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
  // Read the legacy evidenceState spelling for compatibility, while every
  // current producer emits the canonical evidence.state key.
  const diagnosticStates = new Set(diagnostics
    .map(item => item?.evidence?.state ?? item?.evidence?.evidenceState)
    .filter(state => EVIDENCE_STATES.includes(state)));
  const derivedState = EVIDENCE_STATES.find(state => diagnosticStates.has(state));
  const evidenceState = result?.evidenceState ?? derivedState ?? 'negative';
  const disposition = result?.disposition ?? dispositionForEvidence(evidenceState);
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
  const disposition = error?.disposition ?? dispositionForEvidence(evidenceState);
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
    debugReference: null,
    requiredContext: Array.isArray(error?.requiredContext) ? error.requiredContext : [],
    ...domainFields,
  });
}
