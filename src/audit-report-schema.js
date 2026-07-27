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

export { AUDIT_REPORT_SCHEMA_VERSION, LEGACY_INLINE_REPORT_VERSION, AUDIT_PERSPECTIVES };

export const AUDIT_INVOCATION_PROVENANCE_CLASSES = Object.freeze([
  'verified',
  'asserted',
]);

const FINDING_ID_PATTERN = /^A-\d{2,}$/;
const TOP_LEVEL_FIELDS = new Set([
  'report_schema', 'artifact', 'covered_tasks', 'invocation', 'perspectives',
  'assessment', 'evidence_checked', 'verdict', 'findings',
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
 * Parse and validate a complete `auditor_report_v1` wire document.
 *
 * @param {unknown} raw  Parsed JSON value.
 * @returns {{ ok: boolean, errors: string[], report?: object }}
 */
export function parseAuditorWireReport(raw) {
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
  if (invocation.provenance === 'verified' && !invocation.receipt) {
    errors.push("invocation.provenance 'verified' requires invocation.receipt");
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
 * Convert a validated wire report into the shape `appendAuditReport` consumes.
 * Perspective bodies and provenance ride along for lossless durable history.
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
