/** Authoritative lifecycle claims derived from canonical receipts only. */

import { validateReviewEntryReceipt } from './review-entry-receipt.js';
import { validateCloseoutPacket } from './closeout-contract.js';

function sameTaskSet(left, right) {
  const normalize = value => [...new Set((value ?? []).map(String))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function closeoutComplete({ closeoutPacket, closeoutTerminalReceipt, currentCloseoutMarker }) {
  if (validateCloseoutPacket(closeoutPacket).length > 0 ||
      closeoutPacket?.completion_eligible !== true ||
      closeoutPacket?.recommended_status !== 'complete') return null;
  const receipt = closeoutTerminalReceipt;
  if (!receipt || receipt.kind !== 'agenticloop.closeout-terminal-receipt' ||
      receipt.schemaVersion !== 1 ||
      receipt.action !== 'closeout_owned_accepted_to_closed' ||
      receipt.packetDigest !== closeoutPacket.digest ||
      receipt.workUnit !== closeoutPacket.work_unit ||
      receipt.backend !== closeoutPacket.backend ||
      receipt.unresolved !== false ||
      !['committed', 'already_current'].includes(receipt.mutationDisposition) ||
      !Array.isArray(receipt.transitions) ||
      receipt.transitions.length !== closeoutPacket.covered_tasks.length ||
      !sameTaskSet(receipt.transitions.map(item => item?.taskId), closeoutPacket.covered_tasks) ||
      receipt.transitions.some(item => item?.to !== 'closed' || !['committed', 'already_verified'].includes(item?.state))) return null;
  if (currentCloseoutMarker?.gateDigest !== closeoutPacket.digest ||
      currentCloseoutMarker?.artifact !== closeoutPacket.candidate_artifact ||
      currentCloseoutMarker?.workUnit !== closeoutPacket.work_unit) return null;
  return {
    claim: 'closeout_complete', authoritative: true, completion: true,
    packetDigest: closeoutPacket.digest, artifact: closeoutPacket.candidate_artifact,
    coveredTasks: [...closeoutPacket.covered_tasks].sort(),
  };
}

/**
 * Derive lifecycle claims from current receipt validators, never caller booleans
 * or prose. `closeout_complete` is impossible without the real closeout
 * terminal receipt and the current packet-bound marker.
 */
export function deriveLifecycleClaims({
  reviewEntry = null,
  currentArtifact = null,
  closeoutPacket = null,
  closeoutTerminalReceipt = null,
  currentCloseoutMarker = null,
} = {}) {
  const claims = [];
  if (reviewEntry?.receipt && reviewEntry?.loaded && reviewEntry?.result) {
    const checked = validateReviewEntryReceipt(reviewEntry.receipt, reviewEntry.loaded, reviewEntry.result);
    if (checked.ok && reviewEntry.receipt.artifact?.head === currentArtifact) {
      claims.push({
        claim: 'implementation_ready_for_review', authoritative: true, completion: false,
        receiptDigest: reviewEntry.receipt.digest,
      });
    }
  }
  const complete = closeoutComplete({ closeoutPacket, closeoutTerminalReceipt, currentCloseoutMarker });
  if (complete) claims.push(complete);
  return Object.freeze(claims);
}
