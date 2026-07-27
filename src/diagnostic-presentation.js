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

/** Presentation-only concise guidance retained for CLI consumers. */
export function renderDiagnosticNextAction({ repairKind, escalationKind, repairHint = null }, capabilities) {
  const owner = capabilities.primaryOwnerByRepairKind[repairKind] ?? null;
  const escalationOwner = capabilities.escalationOwnerByKind[escalationKind] ?? null;
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
  const escalationOwner = capabilities.escalationOwnerByKind[escalationKind] ?? null;
  return {
    ...fact,
    owner,
    escalationKind,
    escalationOwner,
    nextAction: renderDiagnosticNextAction({ repairKind, escalationKind, repairHint: diagnostic.repairHint ?? null }, capabilities),
    firstSafeRepair: repairKind,
  };
}

export function presentDiagnostics(diagnostics, capabilities) {
  return (Array.isArray(diagnostics) ? diagnostics : []).map(item => presentDiagnostic(item, capabilities));
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
