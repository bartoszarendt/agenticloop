/**
 * Versioned Auditor report wire format (`auditor_report_v1`).
 *
 * One schema is emitted by the Auditor role and consumed by
 * `agenticloop audit report <AUD-ID> --file <path>` and the `--stdin` source
 * mode without substantive rewriting. The schema requires the artifact, covered tasks, invocation
 * provenance, all six perspective results, a consolidated assessment, bounded
 * evidence checked, one verdict, and complete finding fields.
 *
 * Legacy inline `--finding-json` ingestion remains accepted during the
 * compatibility period and is recorded as `legacy_inline_v1`: it preserves
 * every supplied field, never fabricates six perspective bodies, and never
 * claims lossless wire-format provenance.
 */

import {
  AUDIT_FINDING_SEVERITIES,
  AUDIT_INVOCATION_MODES,
  AUDIT_PERSPECTIVES,
  AUDIT_REPORT_SCHEMA_VERSION,
  AUDIT_VERDICTS,
  LEGACY_INLINE_REPORT_VERSION,
} from './layout.js';
import { canonicalSha256 } from './canonical-json.js';

export { AUDIT_REPORT_SCHEMA_VERSION, LEGACY_INLINE_REPORT_VERSION, AUDIT_PERSPECTIVES };

export const AUDIT_INVOCATION_PROVENANCE_CLASSES = Object.freeze([
  'verified',
  'asserted',
]);

const FINDING_ID_PATTERN = /^A-\d{2,}$/;
const TOP_LEVEL_FIELDS = new Set([
  'report_schema', 'artifact', 'covered_tasks', 'invocation', 'perspectives',
  'assessment', 'evidence_checked', 'verdict', 'findings', 'producer',
]);
const INVOCATION_FIELDS = new Set(['mode', 'reference', 'provenance', 'receipt']);
const FINDING_FIELDS = new Set([
  'id', 'severity', 'blocking', 'claim', 'evidenceRefs', 'consequence',
  'requiredOutcome', 'verificationRequired',
]);
// Advisory bounds only. They document the intended report size for prompt
// budgets; they are never hard blockers - an oversized but otherwise valid
// report always persists.
export const ADVISORY_MAX_PERSPECTIVE_BODY_LENGTH = 20000;
export const ADVISORY_MAX_EVIDENCE_CHECKED_LENGTH = 4000;
export const ADVISORY_MAX_FINDINGS = 200;

function stringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Canonical identity covered by the host's Auditor-invocation receipt. */
export function auditorReportDigest(report) {
  return `sha256:agenticloop.auditor-report.v1:${canonicalSha256(report)}`;
}

/**
 * Exact substantive report identity authenticated by a host return receipt.
 * The receipt field is null in this projection because embedding a signature
 * over a digest that includes that same signature would be circular.
 *
 * This digest is only meaningful over a **normalized** report - the exact
 * projection `parseAuditorWireReport()` produces. A host must never compute it
 * over a raw wire document it has not normalized: permitted surrounding
 * whitespace, mixed-case severities, string booleans, and non-canonical covered
 * task entries all change the digest. Use
 * `prepareAuditorReturnReportForSigning()` to obtain the normalized projection
 * and its digest together.
 */
export function auditorReturnReportDigest(report) {
  const projected = structuredClone(report);
  if (projected?.invocation) projected.invocation.receipt = null;
  return `sha256:agenticloop.auditor-return-report.v1:${canonicalSha256(projected)}`;
}

/**
 * Validate and normalize one wire finding. Every substantive string is
 * preserved exactly after trimming outer whitespace only.
 */
function normalizeWireFinding(raw, index, errors) {
  const label = `finding ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!FINDING_FIELDS.has(key)) errors.push(`${label} has unknown finding field '${key}'`);
  }
  const finding = {
    id: stringField(raw.id),
    severity: stringField(raw.severity).toLowerCase(),
    blocking: raw.blocking === true || raw.blocking === 'true',
    claim: stringField(raw.claim),
    evidenceRefs: stringField(raw.evidenceRefs),
    consequence: stringField(raw.consequence),
    requiredOutcome: stringField(raw.requiredOutcome),
    verificationRequired: stringField(raw.verificationRequired),
  };
  if (raw.blocking !== true && raw.blocking !== false &&
      raw.blocking !== 'true' && raw.blocking !== 'false') {
    errors.push(`${label} field 'blocking' must be true or false`);
  }
  if (!FINDING_ID_PATTERN.test(finding.id)) {
    errors.push(`${label} field 'id' '${finding.id || '(missing)'}' must use the form 'A-01'`);
  }
  if (!AUDIT_FINDING_SEVERITIES.includes(finding.severity)) {
    errors.push(
      `${label} field 'severity' must be one of: ${AUDIT_FINDING_SEVERITIES.join(', ')}`
    );
  }
  for (const [field, value] of [
    ['claim', finding.claim],
    ['evidenceRefs', finding.evidenceRefs],
    ['consequence', finding.consequence],
    ['requiredOutcome', finding.requiredOutcome],
    ['verificationRequired', finding.verificationRequired],
  ]) {
    if (!value) {
      errors.push(
        `${label} is missing required field '${field}'; supply every finding field ` +
        `(id, severity, blocking, claim, evidenceRefs, consequence, requiredOutcome, verificationRequired)`
      );
    }
  }
  return finding;
}

/**
 * Validate and normalize one `auditor_report_v1` wire document.
 *
 * Exactly one normalization exists. Both the submission path
 * (`parseAuditorWireReport`) and the host pre-signing path
 * (`prepareAuditorReturnReportForSigning`) run it, so the digest a host signs
 * and the digest the CLI later derives are computed over identical bytes.
 *
 * @param {unknown} raw
 * @param {{ preSigning?: boolean }} [mode]  `preSigning` permits an absent
 *   receipt on a `verified` report because the receipt does not exist yet.
 * @returns {{ ok: boolean, errors: string[], report?: object }}
 */
function normalizeAuditorWireReport(raw, { preSigning = false } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['auditor report must be one JSON object'] };
  }
  if (raw.report_schema !== AUDIT_REPORT_SCHEMA_VERSION) {
    errors.push(
      `report_schema must be '${AUDIT_REPORT_SCHEMA_VERSION}' (got ${JSON.stringify(raw.report_schema ?? null)})`
    );
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`auditor report has unknown top-level field '${key}'`);
  }

  const artifact = stringField(raw.artifact);
  if (!artifact) errors.push("report requires 'artifact' naming the exact audited candidate");

  const coveredTasks = Array.isArray(raw.covered_tasks)
    ? raw.covered_tasks.map(item => stringField(item)).filter(Boolean)
    : [];
  if (!Array.isArray(raw.covered_tasks) || coveredTasks.length === 0) {
    errors.push("report requires 'covered_tasks' as a non-empty array of task ids");
  }

  const invocationRaw = raw.invocation && typeof raw.invocation === 'object' ? raw.invocation : {};
  for (const key of Object.keys(invocationRaw)) {
    if (!INVOCATION_FIELDS.has(key)) errors.push(`invocation has unknown field '${key}'`);
  }
  const invocation = {
    mode: stringField(invocationRaw.mode),
    reference: stringField(invocationRaw.reference),
    provenance: stringField(invocationRaw.provenance).toLowerCase() || 'asserted',
    receipt: stringField(invocationRaw.receipt),
  };
  if (!AUDIT_INVOCATION_MODES.includes(invocation.mode)) {
    errors.push(
      `invocation.mode must be one of: ${AUDIT_INVOCATION_MODES.join(', ')}; a same-session fallback does not satisfy auditing`
    );
  }
  if (!invocation.reference) {
    errors.push('invocation.reference is required and must be unique per Auditor invocation');
  }
  if (!AUDIT_INVOCATION_PROVENANCE_CLASSES.includes(invocation.provenance)) {
    errors.push(
      `invocation.provenance must be one of: ${AUDIT_INVOCATION_PROVENANCE_CLASSES.join(', ')}`
    );
  }
  if (!preSigning && invocation.provenance === 'verified' && !invocation.receipt) {
    errors.push("invocation.provenance 'verified' requires invocation.receipt");
  }
  if (invocation.provenance === 'asserted' && invocation.receipt) {
    errors.push("invocation.provenance 'asserted' cannot carry invocation.receipt; an opaque receipt is not producer authentication");
  }
  let producer = null;
  if (!raw.producer || typeof raw.producer !== 'object' || Array.isArray(raw.producer) ||
      Object.keys(raw.producer).length !== 1 || raw.producer.roleId !== 'auditor') {
    errors.push("producer must be the closed immutable role object { roleId: 'auditor' }");
  } else {
    producer = { roleId: 'auditor' };
  }

  const perspectivesRaw = raw.perspectives && typeof raw.perspectives === 'object'
    ? raw.perspectives
    : {};
  const perspectives = {};
  for (const key of AUDIT_PERSPECTIVES) {
    const body = perspectivesRaw[key];
    if (typeof body !== 'string' || !body.trim()) {
      errors.push(`report requires a non-empty perspective body for '${key}'`);
      perspectives[key] = '';
      continue;
    }
    perspectives[key] = body.trim();
  }
  for (const key of Object.keys(perspectivesRaw)) {
    if (!AUDIT_PERSPECTIVES.includes(key)) {
      errors.push(`unknown perspective '${key}'; expected exactly: ${AUDIT_PERSPECTIVES.join(', ')}`);
    }
  }

  const assessment = stringField(raw.assessment);
  if (!assessment) errors.push("report requires 'assessment' covering all six perspectives");

  const evidenceChecked = stringField(raw.evidence_checked);
  if (!evidenceChecked) {
    errors.push("report requires 'evidence_checked' naming the bounded evidence actually checked");
  }

  const verdict = stringField(raw.verdict);
  if (!AUDIT_VERDICTS.includes(verdict)) {
    errors.push(`verdict must be one of: ${AUDIT_VERDICTS.join(', ')}`);
  }

  const rawFindings = Array.isArray(raw.findings) ? raw.findings : null;
  if (rawFindings === null) {
    errors.push("report requires 'findings' as an array (empty when there are none)");
  }
  const findings = (rawFindings ?? []).map((finding, index) => normalizeWireFinding(finding, index, errors));
  const seenIds = new Set();
  for (const finding of findings) {
    if (!finding?.id) continue;
    if (seenIds.has(finding.id)) {
      errors.push(`finding id '${finding.id}' is duplicated`);
    }
    seenIds.add(finding.id);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    report: {
      report_schema: AUDIT_REPORT_SCHEMA_VERSION,
      producer,
      artifact,
      covered_tasks: coveredTasks,
      invocation,
      perspectives,
      assessment,
      evidence_checked: evidenceChecked,
      verdict,
      findings,
    },
  };
}

/**
 * Parse and validate a complete `auditor_report_v1` wire document for
 * submission. A `verified` report must carry a non-empty receipt here: this is
 * the authoritative ingestion path and it is never relaxed.
 *
 * @param {unknown} raw  Parsed JSON value.
 * @returns {{ ok: boolean, errors: string[], report?: object }}
 */
export function parseAuditorWireReport(raw) {
  return normalizeAuditorWireReport(raw, { preSigning: false });
}

/**
 * Host-side pre-signing preparation.
 *
 * A protected host cannot sign a report identity it cannot compute, and it
 * cannot compute the CLI's identity from a raw wire document, because the CLI
 * normalizes before it digests. This is the one supported way to obtain the
 * exact normalized report and the exact `auditor-return-report.v1` digest the
 * CLI will later derive - without needing a receipt that does not exist yet.
 *
 * Intended sequence:
 *
 *   1. `const prepared = prepareAuditorReturnReportForSigning(rawReport)`
 *   2. host signs `prepared.digest` into an Auditor return receipt
 *   3. host sets `prepared.report.invocation.receipt = JSON.stringify(receipt)`
 *   4. the CLI parses that report and derives the identical digest
 *
 * The returned report is the receipt-null normalized projection: every
 * substantive field is already trimmed, lower-cased, and canonicalized exactly
 * as ingestion will produce it. Mutating any substantive field after step 2
 * invalidates the signature, which is the intended fail-closed behavior.
 *
 * Validation is the same closed schema used by submission; only the
 * "`verified` requires a receipt" rule is deferred to submission. There is no
 * caller-visible dummy-receipt convention.
 *
 * The report's normalized `invocation.provenance` must already be `verified`.
 * Preparing an `asserted` report produced output no one could use: submission
 * rejects an `asserted` report that carries a receipt, so the host would sign a
 * digest whose only destination refuses it. Preparation refuses instead, and it
 * refuses rather than promoting the class - a caller does not acquire verified
 * provenance by asking a formatter for it.
 *
 * @param {unknown} rawReport  Parsed JSON value of the Auditor's wire report.
 * @returns {{ ok: boolean, errors: string[], report: object|null, digest: string|null }}
 */
export function prepareAuditorReturnReportForSigning(rawReport) {
  const parsed = normalizeAuditorWireReport(rawReport, { preSigning: true });
  if (!parsed.ok) return { ok: false, errors: parsed.errors, report: null, digest: null };
  const report = parsed.report;
  if (report.invocation.provenance !== 'verified') {
    return {
      ok: false,
      errors: [
        `invocation.provenance must be 'verified' to prepare a report for host return-receipt signing; ` +
        `got '${report.invocation.provenance}'. Preparation never promotes asserted provenance.`,
      ],
      report: null,
      digest: null,
    };
  }
  // The projection a host holds is receipt-null rather than receipt-empty so
  // inserting the receipt in step 3 is the only remaining edit, and so a report
  // handed back unsigned still fails the submission receipt rule.
  report.invocation.receipt = null;
  return {
    ok: true,
    errors: [],
    report,
    digest: auditorReturnReportDigest(report),
  };
}

/**
 * Convert a validated wire report into the shape `appendAuditReport` consumes.
 * Perspective bodies and provenance ride along for lossless durable history.
 *
 * Two distinct digests are carried, and they are not interchangeable:
 *
 * - `auditorReportDigest` covers the full normalized report *including* the
 *   receipt text. Durable persistence and report-identity history rely on it.
 * - `auditorReturnReportDigest` covers the receipt-null projection. It is the
 *   only digest a host return receipt authenticates, and it is the digest
 *   `normalizeAuditorInvocationProvenance()` sends to the verifier and compares
 *   the verifier's answer against - the same domain
 *   `prepareAuditorReturnReportForSigning()` hands the host.
 *
 * @param {object} report  Result of parseAuditorWireReport().report
 * @returns {object}
 */
export function wireReportToAuditRun(report) {
  return {
    verdict: report.verdict,
    invocationMode: report.invocation.mode,
    invocationReference: report.invocation.reference,
    invocationProvenance: report.invocation.provenance,
    invocationReceipt: report.invocation.receipt,
    auditedArtifact: report.artifact,
    coveredTasks: report.covered_tasks,
    assessment: report.assessment,
    evidenceChecked: report.evidence_checked,
    findings: report.findings,
    perspectives: report.perspectives,
    reportFormat: AUDIT_REPORT_SCHEMA_VERSION,
    wirePayload: structuredClone(report),
    auditorReportDigest: auditorReportDigest(report),
    auditorReturnReportDigest: auditorReturnReportDigest(report),
    freshAuditorReturn: true,
  };
}

/**
 * Build a `legacy_inline_v1` run from legacy inline options. Every supplied
 * field is preserved; no perspective bodies are fabricated.
 *
 * @param {object} inline  Legacy inline report fields.
 * @returns {object}
 */
export function legacyInlineToAuditRun(inline) {
  return {
    verdict: inline.verdict,
    invocationMode: inline.invocationMode,
    invocationReference: inline.invocationReference,
    invocationProvenance: 'asserted',
    invocationReceipt: '',
    auditedArtifact: inline.auditedArtifact,
    coveredTasks: inline.coveredTasks,
    assessment: inline.assessment,
    evidenceChecked: inline.evidenceChecked,
    findings: inline.findings,
    perspectives: null,
    reportFormat: LEGACY_INLINE_REPORT_VERSION,
  };
}
