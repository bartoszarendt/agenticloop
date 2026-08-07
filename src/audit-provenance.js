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
 * - When a host exposes no verifiable receipt and no event evidence, the
 *   record says provenance is `asserted` rather than manufacturing proof.
 */

import { listEventLogFiles, loadEvents } from './event-logging.js';
import { canonicalSha256 } from './canonical-json.js';

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
 * A receipt string is evidence to verify, never self-authentication. Hosts
 * without a verifier retain the receipt for traceability but classify it as
 * asserted provenance.
 *
 * @param {object} run
 * @param {{ verifier?: Function, workUnit: string, candidateArtifact: string, coveredTasks: string[] }} context
 * @returns {Promise<{ run: object, errors: string[] }>}
 */
export async function normalizeAuditorInvocationProvenance(run, context) {
  const normalized = { ...run };
  const authoritative = normalized.authoritativeAuditorReturn === true;
  if (authoritative && normalized.invocationProvenance !== 'verified') {
    return { run: normalized, errors: ['a fresh authoritative Auditor return requires verified invocation provenance'] };
  }
  if (normalized.invocationProvenance !== 'verified') {
    return { run: normalized, errors: [] };
  }
  if (typeof context?.verifier !== 'function') {
    if (normalized.authoritativeAuditorReturn === true) {
      return { run: normalized, errors: ['a verified Auditor invocation requires a host receipt verifier; asserted provenance cannot satisfy a fresh authoritative Auditor return'] };
    }
    normalized.invocationProvenance = 'asserted';
    return { run: normalized, errors: [] };
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
      reportDigest: normalized.auditorReportDigest,
    });
  } catch (error) {
    return { run: normalized, errors: [`host invocation receipt verification failed: ${error.message}`] };
  }
  if (result?.verified !== true || (authoritative && result.reportDigest !== normalized.auditorReportDigest)) {
    return { run: normalized, errors: ['host invocation receipt did not verify the Auditor role, work unit, candidate, tasks, and invocation reference'] };
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
