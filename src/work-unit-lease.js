/**
 * Deriving a per-task execution lease from work-unit intent already given.
 *
 * The field operator complaint, stated precisely: a milestone of eight tasks
 * read as eight interactive confirmations. Surfacing `--work-unit` in every
 * refusal (see `activation-repair.js`) fixes the *discovery* half of that. This
 * is the other half - what happens to a task that becomes ready **after** the
 * operator authorized the work unit it belongs to.
 *
 * Today a work-unit grant derives child bindings from committed decomposition
 * membership at the moment activation runs. A task that reaches the ready set
 * later is inside the operator's stated intent but outside the derived set, so
 * it asks again. That is the reconfirmation the remediation asks to remove.
 *
 * The rule that makes removing it safe is narrow, and the narrowness is the
 * point:
 *
 * > A lease may be derived without a new operator action **only** for a task
 * > inside the exact scope the operator confirmed.
 *
 * "Exact" means the scope digest the grant bound. A task added to the work unit
 * after confirmation was not authorized - the operator never saw it - so scope
 * expansion always requires a new confirmation. Without that, "authorize the
 * milestone" would quietly become "authorize whatever anyone later files under
 * this milestone", which is a materially different thing to consent to.
 *
 * This module decides eligibility only. It mints nothing: the authenticated
 * binding is still produced by the activation path from committed decomposition
 * evidence, so a derived lease remains traceable to the operator's grant and is
 * never model-authored.
 */

import { canonicalSha256 } from './canonical-json.js';

/** The diagnostic a scope-expansion refusal reports under. */
export const SCOPE_EXPANSION_DIAGNOSTIC_CODE = 'activation.binding.mismatch';

/**
 * The digest of a work unit's bound membership.
 *
 * Derived from the exact task identities and their contract digests, so both a
 * new member and a materially changed member move it. Order-independent by
 * construction, because membership is a set and the order it was enumerated in
 * is not part of what the operator agreed to.
 */
export function workUnitScopeDigest(members = []) {
  const normalized = [...members]
    .map(member => ({
      taskId: String(member?.taskId ?? ''),
      taskContractDigest: String(member?.taskContractDigest ?? ''),
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  return `sha256:agenticloop.work-unit-scope.v1:${canonicalSha256(normalized)}`;
}

/**
 * Decide whether a task may receive a derived lease under an existing grant.
 *
 * @param {{
 *   grant?: object,
 *   taskId?: string,
 *   currentMembers?: Array<{ taskId: string, taskContractDigest: string }>,
 *   boundScopeDigest?: string|null,
 *   now?: number,
 * }} input
 */
export function evaluateWorkUnitLease(input = {}) {
  const grant = input.grant ?? null;
  const taskId = input.taskId ?? null;
  const refuse = (reason, code = SCOPE_EXPANSION_DIAGNOSTIC_CODE) =>
    Object.freeze({ ok: false, derivable: false, reason, code, requiresOperatorAction: true });

  if (!grant || !taskId) return refuse('no work-unit grant and task were supplied');
  if (grant.scope?.type !== 'work_unit') {
    // An exact-task grant authorizes exactly its listed tasks. Deriving a lease
    // for anything else from it would be inventing scope the operator did not
    // state, which is the opposite of what this module is for.
    return refuse('the grant does not authorize a work unit, so no membership can be derived from it');
  }

  const members = Array.isArray(input.currentMembers) ? input.currentMembers : [];
  const member = members.find(item => item?.taskId === taskId) ?? null;
  if (!member) {
    return refuse(`task '${taskId}' is not a current member of work unit '${grant.scope.workUnitId}'`);
  }

  // The scope digest the grant bound, compared with the scope now. Any
  // difference - a new member, a removed one, a materially changed contract -
  // means the operator confirmed a different set than the one in front of us.
  const boundDigest = input.boundScopeDigest ?? grant.scope.scopeDigest ?? null;
  if (!boundDigest) {
    return refuse('the grant records no bound work-unit scope, so nothing can be compared against it');
  }
  const currentDigest = workUnitScopeDigest(members);
  if (currentDigest !== boundDigest) {
    return refuse(
      `work unit '${grant.scope.workUnitId}' has changed since it was authorized; ` +
      'a task added or materially changed after confirmation was never authorized, so the operator confirms the new scope'
    );
  }

  // Expiry still applies. A lease derived from expired intent is not intent.
  const now = input.now ?? Date.now();
  const expiresAt = Date.parse(grant.expiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return refuse(`the work-unit authorization expired at ${grant.expiresAt}`, 'activation.grant.expired');
  }

  return Object.freeze({
    ok: true,
    derivable: true,
    reason: null,
    code: null,
    // The operator is not asked again, because the scope they confirmed has not
    // changed. This is the whole benefit, and it is exactly this narrow.
    requiresOperatorAction: false,
    workUnitId: grant.scope.workUnitId,
    scopeDigest: currentDigest,
    // Stated so no caller mistakes eligibility for authority: the authenticated
    // binding is still minted by the activation path from committed evidence.
    mintsBinding: false,
    derivationSource: 'committed_decomposition_membership',
  });
}
