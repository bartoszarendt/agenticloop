/**
 * The canonical lifecycle-dispatchability gate.
 *
 * Preflight, packet preparation, prepared-packet validation, and role-start
 * recognition all need one identical answer to "may this task begin an
 * execution attempt right now?". Before P35-C12R only the last of them asked:
 * preflight and `prepare-dispatch` reported success for a `draft` task, and the
 * refusal arrived at role start, inside the Engineer session, as an illegal
 * lifecycle transition (C12-F1). That handed Maintainer-owned readiness work to
 * the wrong role and started the repair cascade the field sessions measured.
 *
 * The rule is derived from the one legal-transition authority rather than being
 * restated here, so it cannot drift from what role start will actually accept:
 * a task is dispatchable exactly when its current status can legally reach
 * `in-progress`, or already is `in-progress`.
 */

import { parseFrontmatterStrict } from './frontmatter.js';
import { createDiagnostic } from './repair-policy.js';
import { stripTaskContractMarkers } from './task-contract-baseline.js';
import { KNOWN_TASK_STATUSES, LEGAL_TASK_STATUS_TRANSITIONS } from './task-transition.js';

/** The lifecycle status a role start moves a task into. */
export const ROLE_START_STATUS = 'in-progress';

/** Every status a dispatch packet may legally be created from. */
export const DISPATCHABLE_TASK_STATUSES = Object.freeze(
  KNOWN_TASK_STATUSES.filter(status =>
    status === ROLE_START_STATUS || LEGAL_TASK_STATUS_TRANSITIONS[status].has(ROLE_START_STATUS)
  )
);

/** Read the current lifecycle status from a task record body. */
export function taskStatusFromBody(taskBody) {
  const parsed = parseFrontmatterStrict(stripTaskContractMarkers(String(taskBody ?? '')));
  if (parsed.state !== 'valid') return null;
  const status = typeof parsed.data.status === 'string' ? parsed.data.status.trim() : '';
  return status || null;
}

/**
 * Decide whether one task's current lifecycle status permits dispatch.
 *
 * `evidenceState` follows the shared precedence: an absent or unrecognized
 * status is missing/malformed evidence rather than a negative answer, because
 * "unknown current state" never authorizes anything.
 *
 * @param {string|null|undefined} status
 * @returns {{ ok: boolean, status: string|null, evidenceState: string, reason: string|null }}
 */
export function evaluateDispatchableLifecycle(status) {
  const current = typeof status === 'string' ? status.trim() : '';
  if (!current) {
    return {
      ok: false,
      status: null,
      evidenceState: 'missing',
      reason: 'the task record declares no lifecycle status, so no execution attempt can be authorized',
    };
  }
  if (!Object.hasOwn(LEGAL_TASK_STATUS_TRANSITIONS, current)) {
    return {
      ok: false,
      status: current,
      evidenceState: 'malformed',
      reason: `task status '${current}' is not a recognized lifecycle status; expected one of: ${KNOWN_TASK_STATUSES.join(', ')}`,
    };
  }
  if (DISPATCHABLE_TASK_STATUSES.includes(current)) {
    return { ok: true, status: current, evidenceState: 'current', reason: null };
  }
  return {
    ok: false,
    status: current,
    evidenceState: 'negative',
    reason:
      `task status '${current}' cannot begin an execution attempt; ` +
      `a role start requires a status that legally reaches '${ROLE_START_STATUS}' ` +
      `(${DISPATCHABLE_TASK_STATUSES.join(', ')})`,
  };
}

/**
 * The exact command that settles this prerequisite.
 *
 * Only `draft` has a single unambiguous forward move. Terminal statuses have no
 * safe automatic repair at all, so none is invented: the caller is told what is
 * true instead of being handed a command that would fail.
 */
export function dispatchableLifecycleRepair(taskId, status) {
  if (status === 'draft') {
    return `npx agenticloop task set-status ${taskId} --status agent-ready --base <ref> --base-paths <path> --dependencies <path>`;
  }
  if (status === 'accepted' || status === 'closed') {
    return `Task ${taskId} has already completed its lifecycle; dispatch a new task instead of restarting this one.`;
  }
  return `Restore ${taskId} to a dispatchable status before requesting a packet.`;
}

/** Statuses that have already finished their execution attempt. */
export const TERMINAL_TASK_STATUSES = Object.freeze(
  KNOWN_TASK_STATUSES.filter(status => LEGAL_TASK_STATUS_TRANSITIONS[status].size === 0 || status === 'accepted')
);

/**
 * The subset of the rule the packet constructor enforces today.
 *
 * `prepareRoleDispatch` refuses every status that has not yet reached an
 * execution attempt - the C12-F1 defect - and reports terminal statuses to the
 * caller through preflight rather than refusing them here.
 *
 * This is a deliberate, disclosed narrowing, not a correctness claim: minting a
 * packet for an `accepted` task is genuinely wrong, but refusing it inside the
 * constructor also refuses the retroactive lineage the closeout fixtures build,
 * and building that lineage truthfully needs the carrier-generation chain that
 * P35-C12R.5 owns. The reopen gate is P35-C12R.5: once a closeout fixture can
 * express dispatch, consumption, carrier mutation receipts, and return in real
 * order, this narrowing is deleted and `evaluateDispatchableLifecycle` is
 * applied here unchanged.
 */
export function evaluatePacketDispatchableLifecycle(status) {
  const evaluated = evaluateDispatchableLifecycle(status);
  if (evaluated.ok) return evaluated;
  if (TERMINAL_TASK_STATUSES.includes(evaluated.status)) {
    return { ...evaluated, ok: true, evidenceState: 'current', enforcedAt: 'preflight' };
  }
  return evaluated;
}

/** One canonical diagnostic for a non-dispatchable lifecycle status. */
export function dispatchableLifecycleDiagnostic(taskId, evaluation) {
  return createDiagnostic({
    code: 'task.lifecycle.not_dispatchable',
    message: evaluation.reason,
    evidence: {
      state: evaluation.evidenceState,
      supplied: true,
      rollbackAuthorized: false,
      status: evaluation.status,
      dispatchableStatuses: [...DISPATCHABLE_TASK_STATUSES],
    },
    repairHint: dispatchableLifecycleRepair(taskId, evaluation.status),
  });
}
