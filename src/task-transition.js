/**
 * Shared status-transition semantics for files and GitHub task carriers.
 *
 * This is the single legal-transition authority. It fails closed: a carrier
 * whose current status is absent or unrecognized cannot authorize a mutation,
 * because "unknown current state" is missing evidence, not permission. Callers
 * route such a record to the explicit correction-authority path instead of
 * treating an ordinary transition as an implicit repair.
 */

export const LEGAL_TASK_STATUS_TRANSITIONS = Object.freeze({
  draft: new Set(['agent-ready', 'blocked', 'needs_context']),
  'agent-ready': new Set(['in-progress', 'blocked', 'needs_context']),
  'in-progress': new Set(['needs_revision', 'blocked', 'needs_context', 'accepted']),
  needs_revision: new Set(['in-progress', 'blocked', 'needs_context']),
  blocked: new Set(['agent-ready', 'in-progress']),
  needs_context: new Set(['agent-ready', 'in-progress']),
  accepted: new Set(['closed']),
  closed: new Set(),
});

/** Every status this contract recognizes, in canonical lifecycle order. */
export const KNOWN_TASK_STATUSES = Object.freeze(Object.keys(LEGAL_TASK_STATUS_TRANSITIONS));

/**
 * Validate one requested status transition.
 *
 * @param {string|undefined} currentStatus  The status read from the current record.
 * @param {string} nextStatus  The requested target status.
 * @param {string|boolean|undefined} note  `--note` value, if supplied.
 * @returns {string|null} An error message, or null when the transition is legal.
 */
export function validateTaskStatusTransition(currentStatus, nextStatus, note) {
  const current = typeof currentStatus === 'string' ? currentStatus.trim() : '';
  const next = typeof nextStatus === 'string' ? nextStatus.trim() : '';
  if (!next) {
    return `Target task status is required. Expected one of: ${KNOWN_TASK_STATUSES.join(', ')}`;
  }
  if (!Object.hasOwn(LEGAL_TASK_STATUS_TRANSITIONS, next)) {
    return `Unknown target task status '${next}'. Expected one of: ${KNOWN_TASK_STATUSES.join(', ')}`;
  }
  if (!current) {
    return 'The current task status is missing from the record. A transition cannot double as a repair: ' +
      'restore the record through the correction-authority path before requesting a status change.';
  }
  if (!Object.hasOwn(LEGAL_TASK_STATUS_TRANSITIONS, current)) {
    return `Unknown current task status '${current}'. A transition cannot double as a repair: ` +
      'restore the record through the correction-authority path before requesting a status change.';
  }
  if (current === next) return null;
  const allowed = LEGAL_TASK_STATUS_TRANSITIONS[current];
  if (!allowed.has(next)) {
    return `Cannot transition from '${current}' to '${next}'. Allowed transitions: ${[...allowed].join(', ') || '(none; this status is terminal)'}`;
  }
  if ((next === 'blocked' || next === 'needs_context') && (!note || note === true)) {
    return `Transition to '${next}' requires --note explaining the reason`;
  }
  return null;
}
