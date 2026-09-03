/**
 * Shared freeze gate for files-backed task carriers during a live Engineer attempt.
 *
 * The carrier is the Engineer attempt's ordered evidence channel. Once a
 * prepared dispatch is consumed, unrelated task or Maintainer mutations may
 * not move that channel's terminal. Recovery observations remain in the
 * existing append-only handoff record families until the attempt is returned
 * or abandoned.
 */

import { evaluateTaskPacketConservation } from './execution-attempt.js';
import { resolveCarrierLineage } from './handoff-consumption.js';
import { ENGINEER_CARRIER_MUTATION_CLASSES } from './task-evidence-contract.js';

export const ARMED_TASK_CARRIER_DIAGNOSTIC_CODE = 'task.carrier.armed';

export function evaluateTaskCarrierMutationGuard(target, taskId, {
  backend = 'files',
  taskContractDigest,
  currentCarrierDigest,
  mutationClass = null,
} = {}) {
  const conservation = evaluateTaskPacketConservation(target, taskId, { backend });
  const liveAttempt = conservation.liveAttempt ?? null;
  if (!liveAttempt) return { ok: true, liveAttempt: null, lineage: null };

  const lineage = resolveCarrierLineage(target, taskId, {
    backend,
    taskContractDigest,
    currentCarrierDigest,
    boundary: 'engineer_return',
  });
  const engineerMutation = ENGINEER_CARRIER_MUTATION_CLASSES.includes(mutationClass);
  if (engineerMutation && lineage.ok) {
    return { ok: true, liveAttempt, lineage };
  }

  const expectedCarrierDigest = lineage.currentCarrierDigest ??
    liveAttempt.consumption?.currentCarrierDigest ?? null;
  const safeWhen =
    'after the current attempt has a verified return, or after it is explicitly abandoned and before the next role start';
  return {
    ok: false,
    code: engineerMutation ? 'task.evidence.lineage.stale' : ARMED_TASK_CARRIER_DIAGNOSTIC_CODE,
    evidenceState: lineage.ok ? 'current' : 'changed',
    disposition: 'blocked',
    liveAttempt,
    lineage,
    expectedCarrierDigest,
    currentCarrierDigest,
    safeWhen,
    message:
      `task carrier ${taskId} is frozen by live consumed attempt ${liveAttempt.attemptId} ` +
      `(packet ${liveAttempt.packetId}); its recognized lineage terminal is ${expectedCarrierDigest ?? '(unresolved)'}, ` +
      `while the current carrier is ${currentCarrierDigest ?? '(unresolved)'}. ` +
      `Only the recognized ordered evidence chain may mutate this carrier; the requested mutation may land ${safeWhen}.`,
    safeRepair:
      `Keep recovery observations in the existing append-only handoff/tooling-failure records. ` +
      `Do not edit or rebind the carrier. Resume the recognized evidence chain at ` +
      `${expectedCarrierDigest ?? '(the recorded terminal)'}, or explicitly abandon attempt ${liveAttempt.attemptId} ` +
      'under its closed-schema recovery disposition before making an unrelated carrier mutation.',
  };
}
