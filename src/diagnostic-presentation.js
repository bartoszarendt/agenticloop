/**
 * Diagnostic presentation boundary.
 *
 * Evaluators emit diagnostic facts only (level, code, category, repairKind,
 * escalationKind, evidence, message). This module — used only by CLI/workflow
 * presentation — composes the compatibility routing fields (owner,
 * escalationOwner, ownerRouting, nextAction, firstSafeRepair) from those
 * facts plus the memoized role capability bindings. Pure evaluators and
 * validators never import this module or the capability resolver.
 */

import { repairPolicyFor } from './repair-policy.js';
import { getProjectRoleCapabilities } from './role-capabilities.js';
import { bindDiagnosticRoutingCapabilities } from './diagnostic-routing-context.js';

/** Presentation-only concise guidance retained for CLI consumers. */
export function renderDiagnosticNextAction({ repairKind, escalationKind, repairHint = null }, capabilities) {
  const owner = capabilities.primaryOwnerByRepairKind[repairKind] ?? null;
  const escalationOwner = capabilities.escalationOwnerByKind[escalationKind] || null;
  const escalation = escalationOwner ? ` Escalation owner: ${escalationOwner}.` : '';
  const hint = repairHint ? `${repairHint} ` : '';
  return `${hint}Repair: ${repairKind}. Owner: ${owner}.${escalation}`;
}

/**
 * Compose routing fields for one diagnostic fact. Diagnostics that already
 * carry presentation routing (hand-built by this layer) pass through
 * unchanged; facts without a known repair kind are returned untouched.
 */
export function presentDiagnostic(diagnostic, capabilities) {
  if (!diagnostic || typeof diagnostic !== 'object') return diagnostic;
  const {
    owner: _owner,
    escalationOwner: _escalationOwner,
    ownerRouting: _ownerRouting,
    nextAction: _nextAction,
    firstSafeRepair: _firstSafeRepair,
    ...fact
  } = diagnostic;
  const repairKind = diagnostic.repairKind
    ?? (typeof diagnostic.code === 'string' ? repairPolicyFor(diagnostic.code).repairKind : null);
  if (!repairKind || !capabilities.primaryOwnerByRepairKind[repairKind]) return fact;
  const escalationKind = diagnostic.escalationKind
    ?? (typeof diagnostic.code === 'string' ? repairPolicyFor(diagnostic.code).escalationKind : 'none');
  const owner = capabilities.primaryOwnerByRepairKind[repairKind];
  const escalationOwner = capabilities.escalationOwnerByKind[escalationKind] || null;
  return bindDiagnosticRoutingCapabilities({
    ...fact,
    owner,
    escalationKind,
    escalationOwner,
    nextAction: renderDiagnosticNextAction({ repairKind, escalationKind, repairHint: diagnostic.repairHint ?? null }, capabilities),
    firstSafeRepair: repairKind,
  }, capabilities);
}

export function presentDiagnostics(diagnostics, capabilities) {
  return (Array.isArray(diagnostics) ? diagnostics : []).map(item => presentDiagnostic(item, capabilities));
}

/**
 * Construct the dependency-free last-resort public boundary result. This
 * intentionally bypasses capability routing and the canonical constructors:
 * it is used only after that normal presentation path itself has failed.
 * Insertion order is canonical so direct JSON.stringify remains deterministic.
 */
export function minimalUnexpectedFailureResult({ command, debugReference, message, repair }) {
  const diagnostic = {
    category: 'operational_error',
    code: 'cli.unexpected',
    escalationKind: 'human_authority_review',
    evidence: {
      committedStateEvaluated: false,
      rollbackAuthorized: false,
      state: 'missing',
    },
    level: 'error',
    message,
    repairHint: repair,
    repairKind: 'repair_evidence',
  };
  return {
    command,
    debugReference,
    diagnostics: [diagnostic],
    disposition: 'blocked',
    errors: [message],
    evidenceState: 'missing',
    failureCategories: ['operational_error'],
    firstSafeRepair: repair,
    kind: 'agenticloop.validation-result',
    ok: false,
    requiredContext: [],
    rollbackAuthorized: false,
    schemaVersion: 1,
    warningDiagnostics: [],
    warnings: [],
  };
}

/**
 * Derive the envelope compatibility fields for a gate result: presented
 * diagnostics plus the envelope `firstSafeRepair`.
 */
export function presentGateResult(result, capabilities) {
  if (!result || typeof result !== 'object') return result;
  const diagnostics = presentDiagnostics(result.diagnostics, capabilities);
  const warningDiagnostics = presentDiagnostics(result.warningDiagnostics, capabilities);
  const firstSafeRepair = result.ok
    ? null
    : (diagnostics[0]?.nextAction ?? result.firstSafeRepair ?? null);
  return { ...result, diagnostics, warningDiagnostics, firstSafeRepair };
}

/** Convenience for CLI commands: memoized bindings for the target project. */
export function presentGateResultForTarget(result, target) {
  return presentGateResult(result, getProjectRoleCapabilities(target));
}
