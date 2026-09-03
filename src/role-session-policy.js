/**
 * When a role invocation may be retried, and when a session may be reused.
 *
 * The field record showed repeated Maintainer invocations "including empty returns" -
 * a role invoked, producing nothing, invoked again. Nothing bounded that loop,
 * so it could only end when a human noticed. An unbounded retry of a step that
 * produced no evidence is not resilience; it is a way to spend a budget without
 * changing state.
 *
 * Two policies live here, and they answer opposite questions:
 *
 * - **Retry**: this invocation returned nothing. May the same work be attempted
 *   again, or has the loop earned a diagnostic instead of another turn?
 * - **Reuse**: a session for this role already exists. Is it still describing
 *   the same work, or would reusing it silently apply stale context?
 *
 * The second is the more dangerous one to get wrong. A reused session that no
 * longer matches the current task, contract, packet, role, liveness, or host
 * execution identity is worse than a fresh one, because it looks like
 * continuity while carrying assumptions that no longer hold.
 *
 * The Auditor is excluded from reuse entirely, and that is a correctness
 * property rather than a tuning choice: an audit that continues a prior session
 * is no longer independent of what that session concluded.
 */

/** Empty returns permitted before the loop is reported rather than retried. */
export const DEFAULT_EMPTY_RETURN_BUDGET = 2;

/** The diagnostic an exhausted retry budget reports under. */
export const EMPTY_RETURN_DIAGNOSTIC_CODE = 'role_result.schema.invalid';

/** Identical tooling failures permitted before retry becomes a stop. */
export const DEFAULT_IDENTICAL_TOOLING_FAILURE_BUDGET = 2;

/** The diagnostic emitted for repeated identical no-progress tooling failures. */
export const TOOLING_FAILURE_DIAGNOSTIC_CODE = 'role_result.tooling_failure_repeated';

/** Roles whose work must be produced fresh, never continued. */
export const NON_REUSABLE_ROLES = Object.freeze(['auditor']);

/**
 * Identity fields a reusable session must still match exactly.
 *
 * Listed rather than compared ad hoc so adding a dimension to the session
 * identity cannot silently skip the reuse check.
 */
export const SESSION_IDENTITY_FIELDS = Object.freeze([
  'taskId',
  'taskContractDigest',
  'packetId',
  'roleId',
  'hostExecutionIdentity',
]);

/**
 * Decide whether another attempt is permitted after an empty return.
 *
 * `emptyReturns` counts invocations that produced no role result at all. A
 * bounded budget converts an invisible loop into one explicit diagnostic that a
 * host or model can act on.
 *
 * @param {{ emptyReturns?: number, budget?: number, roleId?: string, taskId?: string }} input
 */
export function evaluateEmptyReturnBudget(input = {}) {
  const budget = Number.isSafeInteger(input.budget) && input.budget > 0
    ? input.budget
    : DEFAULT_EMPTY_RETURN_BUDGET;
  const observed = Number.isSafeInteger(input.emptyReturns) && input.emptyReturns > 0
    ? input.emptyReturns
    : 0;
  const roleId = input.roleId ?? '<role>';
  const taskId = input.taskId ?? '<task-id>';
  if (observed < budget) {
    return Object.freeze({
      ok: true,
      exhausted: false,
      observed,
      budget,
      remaining: budget - observed,
      code: null,
      reason: null,
      repair: null,
    });
  }
  return Object.freeze({
    ok: false,
    exhausted: true,
    observed,
    budget,
    remaining: 0,
    code: EMPTY_RETURN_DIAGNOSTIC_CODE,
    // One diagnostic, not a retry. The loop is the finding.
    reason:
      `role '${roleId}' returned no result ${observed} time(s) for ${taskId}, reaching the empty-return budget of ${budget}; ` +
      'further identical invocations would repeat a step that produced no evidence',
    repair:
      `Inspect why '${roleId}' produced no result before invoking it again: the host may not be delivering the role result, ` +
      'the packet may not describe actionable work, or the required inputs may be missing. Retrying without a change repeats the same outcome.',
  });
}

/**
 * Bound retries of one exact tooling failure to one task-contract generation.
 * A changed signature or binding is a different recovery, not another count in
 * the same no-progress loop.
 */
export function evaluateToolingFailureRetry(input = {}) {
  const current = input.current ?? {};
  const budget = Number.isSafeInteger(input.budget) && input.budget >= 0
    ? input.budget
    : DEFAULT_IDENTICAL_TOOLING_FAILURE_BUDGET;
  const fields = ['taskId', 'taskContractDigest', 'attemptId', 'operation', 'signature'];
  const valid = fields.every(field => typeof current[field] === 'string' && current[field].trim());
  if (!valid) {
    return Object.freeze({
      ok: false, retryPermitted: false, repeated: 0, budget, remaining: 0,
      code: TOOLING_FAILURE_DIAGNOSTIC_CODE,
      reason: 'tooling-failure retry policy requires an exact task, task contract, attempt, operation, and failure signature',
      repair: 'Capture the typed failure and current task-contract identity before deciding whether to retry.',
    });
  }
  const refusal = (reason, repair) => Object.freeze({
    ok: false, retryPermitted: false, repeated: 0, budget, remaining: 0,
    code: TOOLING_FAILURE_DIAGNOSTIC_CODE, reason, repair,
  });
  if (current.attemptState !== 'live') {
    return refusal(
      `execution attempt '${current.attemptId}' is ${current.attemptState ?? 'not live'} and cannot be retried`,
      'Start a new authorized attempt; terminal attempts cannot consume tooling-retry budget.'
    );
  }
  if (current.contractCurrent !== true) {
    return refusal(
      `tooling-failure retry contract '${current.taskContractDigest}' is stale`,
      'Prepare a new dispatch against the current task contract before retrying.'
    );
  }
  if (current.mutationOccurred !== false) {
    return refusal(
      'the failed operation may have mutated state, so an automatic retry is unsafe',
      'Inspect and reconcile the mutation before deciding on a new operation.'
    );
  }
  if (current.safeToRetry !== true) {
    return refusal(
      'the failure did not positively attest that retry is safe',
      'Change strategy or obtain explicit recovery evidence before another attempt.'
    );
  }
  const repeated = (Array.isArray(input.failures) ? input.failures : []).filter(failure =>
    fields.every(field => failure?.[field] === current[field])).length + 1;
  if (repeated < budget) {
    return Object.freeze({
      ok: true, retryPermitted: true, repeated, budget, remaining: budget - repeated,
      code: null, reason: null, repair: null,
    });
  }
  return Object.freeze({
    ok: false, retryPermitted: false, repeated, budget, remaining: 0,
    code: TOOLING_FAILURE_DIAGNOSTIC_CODE,
    reason:
      `operation '${current.operation}' produced the identical tooling-failure signature ${repeated} time(s) ` +
      `for ${current.taskId} at ${current.taskContractDigest}; another unchanged retry would make no progress`,
    repair:
      'Stop retrying and preserve the current attempt when safe. Route one bounded validator/source diagnosis for the ' +
      'typed refusal signature; if it requires authority or a contract change, return a non-authoritative structured ' +
      'session status to the operator. Do not mint or consume another packet automatically.',
  });
}

/**
 * Decide whether an existing same-role session may be reused.
 *
 * Every identity field must still match, the session must still be live, and
 * the role must be one whose work may legitimately continue. A mismatch is
 * reported with the exact field that changed rather than as a generic refusal,
 * because "something moved" is not something a caller can act on.
 *
 * @param {{ session?: object, current?: object, live?: boolean }} input
 */
export function evaluateSessionReuse(input = {}) {
  const session = input.session ?? null;
  const current = input.current ?? null;
  if (!session || !current) {
    return Object.freeze({
      reusable: false,
      reason: 'no prior session is available to reuse',
      changedFields: Object.freeze([]),
    });
  }
  const roleId = current.roleId ?? session.roleId ?? null;
  if (NON_REUSABLE_ROLES.includes(roleId)) {
    return Object.freeze({
      reusable: false,
      // Independence is the reason, and it is worth stating: an audit that
      // continues a prior session is no longer independent of its conclusions.
      reason: `role '${roleId}' must produce fresh work; continuing a prior session would not be independent`,
      changedFields: Object.freeze([]),
    });
  }
  const changed = SESSION_IDENTITY_FIELDS.filter(field => session[field] !== current[field]);
  if (changed.length > 0) {
    return Object.freeze({
      reusable: false,
      reason: `the session no longer describes the current work; changed: ${changed.join(', ')}`,
      changedFields: Object.freeze(changed),
    });
  }
  if (input.live !== true) {
    return Object.freeze({
      reusable: false,
      reason: 'the prior session is not live',
      changedFields: Object.freeze([]),
    });
  }
  return Object.freeze({ reusable: true, reason: null, changedFields: Object.freeze([]) });
}
