/** Authoritative lifecycle claims derived from canonical receipts only. */

import { canonicalSha256 } from './canonical-json.js';
import { validateReviewEntryReceipt } from './review-entry-receipt.js';
import { validateCloseoutPacket } from './closeout-contract.js';
import {
  PROTECTED_HANDOFF_TRANSITIONS,
  validateHandoffRecognition,
} from './handoff-recognition.js';

/** Digest domain for a claim resting on more than one recognized verdict. */
const HANDOFF_RECOGNITION_SET_DOMAIN = 'agenticloop.handoff-recognition-set.v1';

function sameTaskSet(left, right) {
  const normalize = value => [...new Set((value ?? []).map(String))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/**
 * Select the recognized handoff evidence for one protected transition.
 *
 * Every verdict is rechecked here rather than skimmed: one for another
 * transition, one carrying the wrong requirement, or one that recorded its own
 * refusal yields null. The verdict digest is an integrity check, not an
 * authenticity proof - an internally consistent verdict resealed with
 * `handoffRecognitionDigest` will pass - so only ever hand this function
 * verdicts produced in-process by `recognizeHandoff` during the same run. The
 * authenticity question belongs to the evidence those verdicts consumed.
 *
 * A transition may rest on several verdicts - a closeout covers a task set, and
 * each covered task carries its own verified return. All of them must be
 * recognized, and the claim records one stable digest over the ordered set so a
 * partially recognized set can never be summarized as a recognized one.
 */
function recognizedHandoff(handoff, transition) {
  const supplied = handoff !== null && typeof handoff === 'object' && !Array.isArray(handoff)
    ? handoff[transition]
    : null;
  const verdicts = Array.isArray(supplied) ? supplied : supplied ? [supplied] : [];
  if (verdicts.length === 0) return null;
  for (const verdict of verdicts) {
    if (!verdict || !validateHandoffRecognition(verdict).ok) return null;
    if (verdict.transition !== transition || verdict.recognized !== true) return null;
    if (verdict.requirement !== PROTECTED_HANDOFF_TRANSITIONS[transition].requirement) return null;
  }
  const digests = verdicts.map(verdict => verdict.digest);
  return {
    digest: digests.length === 1
      ? digests[0]
      : `sha256:${HANDOFF_RECOGNITION_SET_DOMAIN}:${canonicalSha256(digests)}`,
    bindings: verdicts.map(verdict => ({ ...verdict.boundIdentity })),
  };
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
 *
 * Every claim additionally requires the canonical handoff chain for its own
 * protected transition. A correct receipt proves what was produced; it does not
 * prove that the role result behind it travelled `task prepare-dispatch` and
 * `task verify-return`. Without a recognized verdict the claim is not weakened
 * or annotated - it is simply not made, because a claim nobody can authorize is
 * exactly the thing a reader would misread as authorization.
 *
 * @param {{
 *   reviewEntry?: object|null,
 *   currentArtifact?: string|null,
 *   closeoutPacket?: object|null,
 *   closeoutTerminalReceipt?: object|null,
 *   currentCloseoutMarker?: object|null,
 *   handoff?: Record<string, object>|null,
 * }} [input]
 * @returns {ReadonlyArray<object>}
 */
export function deriveLifecycleClaims({
  reviewEntry = null,
  currentArtifact = null,
  closeoutPacket = null,
  closeoutTerminalReceipt = null,
  currentCloseoutMarker = null,
  handoff = null,
} = {}) {
  const claims = [];
  if (reviewEntry?.receipt && reviewEntry?.loaded && reviewEntry?.result) {
    const checked = validateReviewEntryReceipt(reviewEntry.receipt, reviewEntry.loaded, reviewEntry.result);
    const recognition = recognizedHandoff(handoff, 'review_entry');
    if (checked.ok && recognition && reviewEntry.receipt.artifact?.head === currentArtifact) {
      claims.push({
        claim: 'implementation_ready_for_review', authoritative: true, completion: false,
        receiptDigest: reviewEntry.receipt.digest,
        handoffRecognitionDigest: recognition.digest,
        handoffBindings: recognition.bindings,
      });
    }
  }
  const complete = closeoutComplete({ closeoutPacket, closeoutTerminalReceipt, currentCloseoutMarker });
  const closeoutRecognition = recognizedHandoff(handoff, 'closeout');
  if (complete && closeoutRecognition) {
    claims.push({
      ...complete,
      handoffRecognitionDigest: closeoutRecognition.digest,
      handoffBindings: closeoutRecognition.bindings,
    });
  }
  return Object.freeze(claims);
}
