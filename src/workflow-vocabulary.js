/** Shared, intentionally distinct vocabulary for workflow runtime data. */

import { HUMAN_AUTHORITY_BOUNDARY, WORKFLOW_ROLES } from './transition-contract.js';

export { WORKFLOW_ROLES };
export const DIAGNOSTIC_OWNERS = Object.freeze([...WORKFLOW_ROLES, 'human_authority']);
export const EVENT_ROLES = Object.freeze([...WORKFLOW_ROLES, 'human', 'unknown']);

export const WORKFLOW_ROLE_SET = new Set(WORKFLOW_ROLES);
export const DIAGNOSTIC_OWNER_SET = new Set(DIAGNOSTIC_OWNERS);
export const EVENT_ROLE_SET = new Set(EVENT_ROLES);

/**
 * Map event attribution to the owner domain without treating human_authority
 * as a valid event role or unknown as an actionable owner.
 */
export function eventRoleToDiagnosticOwner(eventRole) {
  if (WORKFLOW_ROLE_SET.has(eventRole)) return eventRole;
  return eventRole === 'human' ? HUMAN_AUTHORITY_BOUNDARY : null;
}

export function isDiagnosticOwner(value) {
  return DIAGNOSTIC_OWNER_SET.has(value);
}
