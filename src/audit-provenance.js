/**
 * Auditor invocation provenance verification.
 *
 * Capability-tiered and truthful:
 *
 * - When a host supplies a stable subagent/session receipt, the report records
 *   it and it is validated as `verified` (a receipt is required, and receipts
 *   are unique across all audit records).
 * - When event logging is enabled, the invocation reference must match the
 *   corresponding Auditor `role.invoked` event; the event carries
 *   `data.invocation_reference` for auditor delegations.
 * - A fresh Auditor return is graded under the effective policy. An honestly
 *   asserted, receipt-free return is `session_reported`; a verified protected
 *   host receipt is `host_receipt`.
 * - A report claiming verified provenance never degrades to session-reported.
 *   Without the protected verifier it fails closed instead.
 * - Legacy inline history remains distinct from a fresh wire-format return. A
 *   record with no verifiable receipt records `asserted` provenance rather
 *   than manufacturing proof.
 */

import { listEventLogFiles, loadEvents } from './event-logging.js';
import { canonicalSha256 } from './canonical-json.js';
import { returnAssuranceMeets, RETURN_ASSURANCE_VALUES } from './activation-grant.js';

/** Typed fail-closed return for an invalid fresh Auditor payload. */
export function createAuditorReportResumePacket({ errors = [], reportDigest = null, evidenceState = 'malformed' } = {}) {
  const packet = {
    kind: 'agenticloop.auditor-report-resume',
    schemaVersion: 1,
    ownerRole: 'auditor',
    nextResumableTransition: 'resubmit_auditor_report',
    evidence: { state: evidenceState, errors: [...errors].map(String) },
    reportDigest,
    digest: null,
  };
  packet.digest = `sha256:agenticloop.auditor-report-resume.v1:${canonicalSha256({ ...packet, digest: null })}`;
  return Object.freeze(packet);
}

/**
 * Normalize a caller's wire claim at the one host-capability boundary.
 *
 * A receipt string is evidence to verify, never self-authentication.
 *
 * - Fresh wire-format returns resolve to `session_reported` or `host_receipt`
 *   and must meet `minimumReturnAssurance`.
 * - Legacy runs retain their historical asserted/verified classification but
 *   receive an honest assurance grade when canonicalized.
 *
 * The digest sent to the verifier, and compared against its answer, is
 * `auditorReturnReportDigest` - the receipt-null projection of the *normalized*
 * report. That is the same digest domain a protected host obtains from
 * `prepareAuditorReturnReportForSigning()` before it signs, so a genuine
 * receipt over a valid report always matches here.
 *
 * @param {object} run
 * @param {{ verifier?: Function, workUnit: string, candidateArtifact: string, coveredTasks: string[], minimumReturnAssurance?: string }} context
 * @returns {Promise<{ run: object, errors: string[] }>}
 */
export async function normalizeAuditorInvocationProvenance(run, context) {
  const normalized = { ...run };
  const minimum = RETURN_ASSURANCE_VALUES.has(context?.minimumReturnAssurance)
    ? context.minimumReturnAssurance
    : 'host_receipt';
  const receipt = String(normalized.invocationReceipt ?? '').trim();

  if (normalized.invocationProvenance === 'asserted') {
    if (receipt) {
      return {
        run: normalized,
        errors: ['asserted Auditor invocation provenance cannot carry an opaque receipt; use verified provenance with the protected verifier or omit the receipt'],
      };
    }
    normalized.auditorReturnAssurance = 'session_reported';
    normalized.producerAuthenticated = false;
    if (!returnAssuranceMeets(normalized.auditorReturnAssurance, minimum)) {
      return {
        run: normalized,
        errors: [`Auditor return assurance 'session_reported' is below the effective minimum '${minimum}'`],
      };
    }
    return { run: normalized, errors: [] };
  }
  if (typeof context?.verifier !== 'function') {
    return { run: normalized, errors: ['a verified Auditor invocation requires a protected host receipt verifier; it cannot be downgraded to session_reported'] };
  }
  let result;
  try {
    result = await context.verifier({
      receipt: normalized.invocationReceipt,
      invocationReference: normalized.invocationReference,
      invocationMode: normalized.invocationMode,
      role: 'auditor',
      workUnit: context.workUnit,
      candidateArtifact: context.candidateArtifact,
      coveredTasks: context.coveredTasks,
      reportDigest: normalized.auditorReturnReportDigest,
    });
  } catch (error) {
    return { run: normalized, errors: [`host invocation receipt verification failed: ${error.message}`] };
  }
  if (result?.verified !== true || result.reportDigest !== normalized.auditorReturnReportDigest) {
    return { run: normalized, errors: ['host invocation receipt did not verify the Auditor role, work unit, candidate, tasks, and invocation reference'] };
  }
  normalized.auditorReturnAssurance = 'host_receipt';
  normalized.producerAuthenticated = true;
  if (!returnAssuranceMeets(normalized.auditorReturnAssurance, minimum)) {
    return {
      run: normalized,
      errors: [`Auditor return assurance 'host_receipt' is below the effective minimum '${minimum}'`],
    };
  }
  return { run: normalized, errors: [] };
}

/**
 * Find the `role.invoked` event matching one Auditor invocation reference.
 * Returns null when event logging has no matching event.
 *
 * @param {string} target
 * @param {string} invocationReference
 * @returns {{ matched: boolean, event: object|null, error: string|null }}
 */
export function findAuditorInvocationEvent(target, invocationReference) {
  const reference = String(invocationReference ?? '').trim();
  if (!reference) {
    return { matched: false, event: null, error: 'invocation reference is empty' };
  }
  let listing;
  try {
    listing = listEventLogFiles(target);
  } catch (error) {
    return { matched: false, event: null, error: error.message };
  }
  for (const file of listing?.files ?? []) {
    let events;
    try {
      events = loadEvents(file);
    } catch {
      continue;
    }
    for (const event of events) {
      if (event?.event_type !== 'role.invoked') continue;
      const data = event?.data ?? {};
      if (data.target_role !== 'auditor') continue;
      if (String(data.invocation_reference ?? '').trim() === reference) {
        return { matched: true, event, error: null };
      }
    }
  }
  return { matched: false, event: null, error: null };
}
