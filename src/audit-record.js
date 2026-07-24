/**
 * Work-unit audit certificates (`.agenticloop/audits/`).
 *
 * An audit record is target-owned certification state for one work unit. It is
 * deliberately NOT a task record:
 *
 *   - it is produced by a read-only role that implements nothing;
 *   - it is never reviewed or accepted through the task acceptance gate;
 *   - it carries append-only Auditor report history instead of one reviewed
 *     implementation artifact.
 *
 * Because of that, this module owns a validator that is independent of the
 * ordinary task-record validator; no audit-specific carve-outs belong in
 * `validateFilesTaskRecord`.
 *
 * This store does not reintroduce the summaries store removed in Phase 23. That
 * store duplicated per-task completion summaries that already live inline in the
 * task record. This store holds state that exists nowhere else: work-unit
 * certification status, the exact certified baseline, and report history. It is
 * analogous in separation - not in semantics - to `.agenticloop/decisions/`.
 *
 * Model, reasoning effort, provider, and any mutable round counter are rejected
 * by contract: models are adapter configuration and the run number is derived
 * from `## Audit History`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { markdownLines, markdownSection, parseAtxHeading, topLevelListItems } from './markdown.js';
import { decisionReferenceId } from './verification-learning.js';
import {
  AUDITS_DIRECTORY_RELATIVE_PATH,
  AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED,
  AUDIT_FINDING_SEVERITIES,
  AUDIT_INVOCATION_MODES,
  AUDIT_RECORD_ID_PATTERN,
  AUDIT_REQUIRED_SECTION_HEADINGS,
  AUDIT_STATES,
  AUDIT_VERDICTS,
  CERTIFYING_AUDIT_VERDICTS,
  DEFAULT_AUDIT_BUDGET,
} from './layout.js';

/**
 * Frontmatter keys that must never appear on an audit record. `model`,
 * `reasoning_effort`, and `provider` belong to adapter configuration;
 * `audit_round` and `completed_audits` would duplicate derived history state.
 */
export const FORBIDDEN_AUDIT_FRONTMATTER_KEYS = Object.freeze([
  'model',
  'reasoning_effort',
  'reasoningEffort',
  'provider',
  'audit_round',
  'completed_audits',
]);

const AUDIT_HISTORY_EMPTY_STATE = 'No audit runs are currently recorded.';
const AUDIT_FINDINGS_EMPTY_STATE = 'No findings are currently open.';
const AUDIT_CERTIFICATION_EMPTY_STATE = 'This work unit is not currently certified.';
const AUDIT_GOAL_PLACEHOLDER =
  'Record the intended work-unit outcome and its durable source reference.';
const AUDIT_ORACLE_PLACEHOLDER =
  'Record the observable result that proves the work unit achieved its goal.';
const AUDIT_EVIDENCE_PLACEHOLDER =
  'Record the final integrated verification evidence bound to the frozen baseline.';

export const AUDIT_EMPTY_STATES = Object.freeze({
  history: AUDIT_HISTORY_EMPTY_STATE,
  findings: AUDIT_FINDINGS_EMPTY_STATE,
  certification: AUDIT_CERTIFICATION_EMPTY_STATE,
});

/**
 * Work-unit identity kinds. Grouped projects reuse the existing grouping
 * profiles; flat projects must name the unit explicitly with `work-unit:<name>`.
 */
export const WORK_UNIT_KINDS = Object.freeze([
  'phase',
  'milestone',
  'epic',
  'custom',
  'work-unit',
]);

const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FINDING_ID_PATTERN = /^A-\d{2,}$/;
const RUN_HEADING_PATTERN = /^Run\s+(\d+)$/;
const HUMAN_AUTHORITY_PATTERN = /^human:\s*\S(?:.*\S)?$/i;

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/**
 * Read a frontmatter value as a trimmed string.
 *
 * The frontmatter parser represents an empty scalar (`certified_artifact:`) as
 * an empty object, so those collapse to ''.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function auditFrontmatterString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * Read a frontmatter value as a list of trimmed strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function auditFrontmatterList(value) {
  if (Array.isArray(value)) {
    return value.map(item => auditFrontmatterString(item)).filter(Boolean);
  }
  return [];
}

/**
 * Canonical ordering/deduplication for a covered-task set. Two sets are the same
 * boundary when they contain the same task IDs, regardless of listed order.
 *
 * @param {string[]} taskIds
 * @returns {string[]}
 */
export function normalizeCoveredTasks(taskIds) {
  return [...new Set((taskIds ?? []).map(id => String(id ?? '').trim()).filter(Boolean))].sort();
}

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {boolean}
 */
export function coveredTaskSetsEqual(left, right) {
  const a = normalizeCoveredTasks(left);
  const b = normalizeCoveredTasks(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Human authority is deliberately typed so an Auditor cannot authorize its own
 * exception with arbitrary prose.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHumanAuthorityReference(value) {
  return HUMAN_AUTHORITY_PATTERN.test(String(value ?? '').trim());
}

/**
 * Accepted limitations may cite either direct human authority or a durable
 * decision record. Return the decision id when the latter form is used.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function limitationDecisionReference(value) {
  return decisionReferenceId(String(value ?? '').trim());
}

/**
 * Parse a canonical work-unit identity such as `phase:4` or `work-unit:login`.
 *
 * @param {string} value
 * @returns {{ ok: true, kind: string, id: string, canonical: string } | { ok: false, error: string }}
 */
export function parseWorkUnitIdentity(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'work unit identity is empty' };
  }
  const separator = raw.indexOf(':');
  if (separator === -1) {
    return {
      ok: false,
      error: `work unit identity '${raw}' must be '<kind>:<id>' (kinds: ${WORK_UNIT_KINDS.join(', ')})`,
    };
  }
  const kind = raw.slice(0, separator).trim();
  const id = raw.slice(separator + 1).trim();
  if (!WORK_UNIT_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `work unit kind '${kind}' must be one of: ${WORK_UNIT_KINDS.join(', ')}`,
    };
  }
  if (!WORK_UNIT_ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: `work unit id '${id}' must be alphanumeric with '.', '_', or '-' separators`,
    };
  }
  return { ok: true, kind, id, canonical: `${kind}:${id}` };
}

/**
 * Derive the canonical work-unit identity for a configured grouping profile.
 * Flat projects have no derivable grouping, so they need an explicit name.
 *
 * @param {string} groupingProfile
 * @param {string} groupId
 * @returns {string|null}
 */
export function workUnitIdentityForGroup(groupingProfile, groupId) {
  const id = String(groupId ?? '').trim();
  if (!id) return null;
  if (groupingProfile === 'phase' || groupingProfile === 'milestone' || groupingProfile === 'epic') {
    return `${groupingProfile}:${id}`;
  }
  if (groupingProfile === 'custom') return `custom:${id}`;
  return null;
}

// ---------------------------------------------------------------------------
// Record location
// ---------------------------------------------------------------------------

/**
 * Audit records use their own stable IDs. Work-unit identities contain ':',
 * which is not a legal Windows filename character, so they are never used as
 * filenames.
 *
 * @param {string} auditId
 * @returns {string}
 */
export function auditRecordFileName(auditId) {
  return `${String(auditId ?? '').trim()}.md`;
}

/**
 * @param {string} repoRoot
 * @param {string} auditId
 * @returns {string}
 */
export function auditRecordPath(repoRoot, auditId) {
  return join(repoRoot, AUDITS_DIRECTORY_RELATIVE_PATH, auditRecordFileName(auditId));
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function auditsDirectory(repoRoot) {
  return join(repoRoot, AUDITS_DIRECTORY_RELATIVE_PATH);
}

/**
 * List audit record files (sorted) in a target.
 *
 * @param {string} repoRoot
 * @returns {{ auditId: string, file: string, relPath: string, content: string }[]}
 */
export function listAuditRecordFiles(repoRoot) {
  const dir = auditsDirectory(repoRoot);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const file = join(dir, name);
      return {
        auditId: basename(name, '.md'),
        file,
        relPath: `${AUDITS_DIRECTORY_RELATIVE_PATH}/${name}`,
        content: readFileSync(file, 'utf-8'),
      };
    });
}

/**
 * Allocate the next `AUD-###` identifier from existing records.
 *
 * @param {string[]} existingIds
 * @returns {string}
 */
export function nextAuditId(existingIds) {
  let max = 0;
  for (const id of existingIds ?? []) {
    const match = String(id ?? '').match(/^AUD-(\d{3,})$/);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `AUD-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Find one audit record by audit ID or by canonical work-unit identity.
 *
 * @param {string} repoRoot
 * @param {string} selector
 * @returns {{ auditId: string, file: string, relPath: string, content: string, record: object } | null}
 */
export function findAuditRecord(repoRoot, selector) {
  const wanted = String(selector ?? '').trim();
  if (!wanted) return null;
  for (const entry of listAuditRecordFiles(repoRoot)) {
    const record = parseAuditRecord(entry.content);
    if (entry.auditId === wanted || record.auditId === wanted || record.workUnit === wanted) {
      return { ...entry, record };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `- Key: value` bullets from a Markdown block into a lookup keyed by the
 * lowercased label.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
function parseLabeledBullets(body) {
  const fields = new Map();
  for (const item of topLevelListItems(body)) {
    const match = item.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    fields.set(match[1].trim().toLowerCase(), match[2].trim());
  }
  return fields;
}

/**
 * Return the level-3 headings that belong to a level-2 section.
 *
 * @param {string} content
 * @param {string} heading
 * @returns {{ text: string, body: string }[]}
 */
function subsectionsOf(content, heading) {
  const section = markdownSection(content, heading);
  if (!section) return [];
  const lines = markdownLines(content);
  const entries = [];
  let current = null;
  for (let index = section.startLine; index < section.endLine; index++) {
    const item = lines[index];
    if (!item.live) {
      if (current) current.lines.push(item.raw);
      continue;
    }
    const parsed = parseAtxHeading(item.raw);
    if (parsed && parsed.level === 3) {
      if (current) entries.push(current);
      current = { text: parsed.text, lines: [] };
      continue;
    }
    if (parsed && parsed.level <= 2) break;
    if (current) current.lines.push(item.raw);
  }
  if (current) entries.push(current);
  return entries.map(entry => ({ text: entry.text, body: entry.lines.join('\n').trim() }));
}

/**
 * Parse an audit record into its durable shape.
 *
 * @param {string} content
 * @returns {object}
 */
export function parseAuditRecord(content) {
  const [frontmatter] = parseFrontmatter(content);
  const fm = frontmatter ?? {};

  const history = subsectionsOf(content, '## Audit History')
    .map((entry, index) => {
      const fields = parseLabeledBullets(entry.body);
      const runMatch = entry.text.match(RUN_HEADING_PATTERN);
      return {
        heading: entry.text,
        position: index + 1,
        runNumber: runMatch ? Number(runMatch[1]) : null,
        invocationReference: fields.get('invocation reference') ?? '',
        invocationMode: fields.get('invocation mode') ?? '',
        auditedArtifact: fields.get('audited artifact') ?? '',
        coveredTasks: (fields.get('covered tasks') ?? '')
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
        verdict: fields.get('verdict') ?? '',
        assessment: fields.get('assessment') ?? '',
        findings: (fields.get('findings') ?? '')
          .split(',')
          .map(value => value.trim())
          .filter(value => value && value.toLowerCase() !== 'none'),
        evidenceChecked: fields.get('evidence checked') ?? '',
      };
    });

  const findings = subsectionsOf(content, '## Consolidated Findings').map(entry => {
    const fields = parseLabeledBullets(entry.body);
    return {
      id: entry.text,
      severity: (fields.get('severity') ?? '').toLowerCase(),
      blocking: (fields.get('blocking') ?? '').toLowerCase(),
      claim: fields.get('claim') ?? '',
      evidenceRefs: fields.get('evidence refs') ?? '',
      consequence: fields.get('consequence') ?? '',
      requiredOutcome: fields.get('required outcome') ?? '',
      verificationRequired: fields.get('verification required') ?? '',
    };
  });

  const budgetRaw = fm.audit_budget;
  const budget = typeof budgetRaw === 'number'
    ? budgetRaw
    : /^\d+$/.test(auditFrontmatterString(budgetRaw))
      ? Number(auditFrontmatterString(budgetRaw))
      : null;

  return {
    frontmatterPresent: frontmatter !== null,
    frontmatter: fm,
    auditId: auditFrontmatterString(fm.audit_id),
    workUnit: auditFrontmatterString(fm.work_unit),
    auditState: auditFrontmatterString(fm.audit_state),
    auditBlockedReason: auditFrontmatterString(fm.audit_blocked_reason),
    humanResolutionRef: auditFrontmatterString(fm.human_resolution_ref),
    coveredTasks: auditFrontmatterList(fm.covered_tasks),
    candidateArtifact: auditFrontmatterString(fm.candidate_artifact),
    certifiedArtifact: auditFrontmatterString(fm.certified_artifact),
    certifiedCoveredTasks: auditFrontmatterList(fm.certified_covered_tasks),
    latestVerdict: auditFrontmatterString(fm.latest_verdict),
    auditBudget: budget,
    history,
    findings,
    sections: Object.fromEntries(
      AUDIT_REQUIRED_SECTION_HEADINGS.map(heading => [
        heading,
        markdownSection(content, heading)?.body ?? null,
      ])
    ),
  };
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * The number of completed substantive Auditor reports, derived from history.
 * There is no stored counter to drift.
 *
 * @param {object} record
 * @returns {number}
 */
export function completedAuditRuns(record) {
  return (record?.history ?? []).length;
}

/**
 * Budget state for an audit record. Failed invocations that produced no report
 * never reach history, so they never consume the budget.
 *
 * @param {object} record
 * @returns {{ budget: number, completed: number, remaining: number, exhausted: boolean }}
 */
export function auditBudgetState(record) {
  const budget = Number.isInteger(record?.auditBudget) && record.auditBudget > 0
    ? record.auditBudget
    : DEFAULT_AUDIT_BUDGET;
  const completed = completedAuditRuns(record);
  return {
    budget,
    completed,
    remaining: Math.max(0, budget - completed),
    exhausted: completed >= budget,
  };
}

/**
 * Open blocking findings. A finding stays open until a fresh Auditor accepts its
 * disposition or a human resolves it; maintainer counter-evidence alone does not
 * remove it.
 *
 * @param {object} record
 * @returns {object[]}
 */
export function openBlockingFindings(record) {
  return (record?.findings ?? []).filter(finding => finding.blocking === 'true');
}

/**
 * Certification is current only when the certified artifact and the certified
 * covered-task set both still match the candidate baseline.
 *
 * @param {object} record
 * @returns {{ current: boolean, reasons: string[] }}
 */
export function certificationStatus(record) {
  const reasons = [];
  const lastRun = record?.history?.[record.history.length - 1] ?? null;
  if (!lastRun) {
    reasons.push('no completed Auditor run is recorded');
  } else {
    if (lastRun.verdict !== record.latestVerdict) {
      reasons.push(
        `last Auditor verdict '${lastRun.verdict}' does not match latest_verdict '${record.latestVerdict || '(empty)'}'`
      );
    }
    if (lastRun.auditedArtifact !== record.candidateArtifact) {
      reasons.push(
        `last audited artifact '${lastRun.auditedArtifact || '(empty)'}' does not match candidate_artifact '${record.candidateArtifact}'`
      );
    }
    if (!coveredTaskSetsEqual(lastRun.coveredTasks, record.coveredTasks)) {
      reasons.push('last audited covered-task set does not match covered_tasks');
    }
  }
  if (!record?.certifiedArtifact) {
    reasons.push('no certified artifact is recorded');
  } else if (record.certifiedArtifact !== record.candidateArtifact) {
    reasons.push(
      `certified_artifact '${record.certifiedArtifact}' does not match candidate_artifact '${record.candidateArtifact}'`
    );
  }
  if (record?.certifiedArtifact && !coveredTaskSetsEqual(record.certifiedCoveredTasks, record.coveredTasks)) {
    reasons.push('certified_covered_tasks does not match covered_tasks');
  }
  if (lastRun && record?.certifiedArtifact && lastRun.auditedArtifact !== record.certifiedArtifact) {
    reasons.push('last audited artifact does not match certified_artifact');
  }
  if (lastRun && record?.certifiedArtifact &&
      !coveredTaskSetsEqual(lastRun.coveredTasks, record.certifiedCoveredTasks)) {
    reasons.push('last audited covered-task set does not match certified_covered_tasks');
  }
  if (!CERTIFYING_AUDIT_VERDICTS.includes(record?.latestVerdict ?? '')) {
    reasons.push(
      `latest_verdict '${record?.latestVerdict || '(empty)'}' is not a certifying verdict`
    );
  }
  if (record?.auditState !== 'certified') {
    reasons.push(`audit_state '${record?.auditState || '(empty)'}' is not 'certified'`);
  }
  const blocking = openBlockingFindings(record);
  if (blocking.length > 0) {
    reasons.push(`unresolved blocking findings: ${blocking.map(f => f.id).join(', ')}`);
  }
  return { current: reasons.length === 0, reasons };
}

/**
 * Known limitations with their authority references. A retained limitation needs
 * an existing human or accepted-decision authority; the Auditor may recommend an
 * acceptance but cannot grant one.
 *
 * @param {string} content
 * @returns {{ entries: { text: string, authority: string }[], none: boolean }}
 */
export function parseKnownLimitations(content) {
  const body = markdownSection(content, '## Known Limitations')?.body ?? '';
  const items = topLevelListItems(body);
  const normalized = body.trim().toLowerCase();
  if (items.length === 0 && (normalized === 'none' || normalized === '')) {
    return { entries: [], none: true };
  }
  const entries = items
    .filter(item => item.trim().toLowerCase() !== 'none')
    .map(item => {
      const match = item.match(/Authority:\s*(.+?)\s*$/i);
      return { text: item, authority: match ? match[1].trim() : '' };
    });
  return { entries, none: entries.length === 0 };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOrderedAuditHeadings(content, label, errors) {
  const lines = markdownLines(content);
  let cursor = 0;
  for (const heading of AUDIT_REQUIRED_SECTION_HEADINGS) {
    const wanted = parseAtxHeading(heading);
    let found = -1;
    for (let index = cursor; index < lines.length; index++) {
      if (!lines[index].live) continue;
      const parsed = parseAtxHeading(lines[index].raw);
      if (parsed && parsed.level === wanted.level && parsed.text === wanted.text) {
        found = index;
        break;
      }
    }
    if (found === -1) {
      errors.push(`Audit record '${label}' is missing required section '${heading}'`);
      continue;
    }
    cursor = found + 1;
  }
}

function validateAuditHistoryEntries(record, label, errors) {
  const seenReferences = new Set();
  record.history.forEach((entry, index) => {
    const entryLabel = `Audit record '${label}' history entry ${index + 1}`;
    if (entry.runNumber === null) {
      errors.push(`${entryLabel} heading must be '### Run <n>' (got '${entry.heading}')`);
    } else if (entry.runNumber !== index + 1) {
      errors.push(
        `${entryLabel} must be run ${index + 1}; audit history is append-only and derives run numbers from position`
      );
    }

    if (!entry.invocationReference) {
      errors.push(`${entryLabel} is missing 'Invocation reference'`);
    } else if (seenReferences.has(entry.invocationReference)) {
      errors.push(
        `${entryLabel} reuses invocation reference '${entry.invocationReference}'; every re-audit requires a fresh Auditor invocation`
      );
    } else {
      seenReferences.add(entry.invocationReference);
    }

    if (!entry.invocationMode) {
      errors.push(`${entryLabel} is missing 'Invocation mode'`);
    } else if (!AUDIT_INVOCATION_MODES.includes(entry.invocationMode)) {
      errors.push(
        `${entryLabel} invocation mode '${entry.invocationMode}' must be one of: ${AUDIT_INVOCATION_MODES.join(', ')}; a same-session fallback does not satisfy auditing`
      );
    }

    if (!entry.auditedArtifact) {
      errors.push(`${entryLabel} is missing 'Audited artifact'`);
    }
    if (entry.coveredTasks.length === 0) {
      errors.push(`${entryLabel} is missing 'Covered tasks'`);
    }
    if (!entry.verdict) {
      errors.push(`${entryLabel} is missing 'Verdict'`);
    } else if (!AUDIT_VERDICTS.includes(entry.verdict)) {
      errors.push(
        `${entryLabel} verdict '${entry.verdict}' must be one of: ${AUDIT_VERDICTS.join(', ')}`
      );
    }
    if (!entry.assessment) {
      errors.push(`${entryLabel} is missing 'Assessment'`);
    }
    if (!entry.evidenceChecked) {
      errors.push(`${entryLabel} is missing 'Evidence checked'`);
    }
  });
}

function validateAuditFindings(record, label, errors) {
  const seen = new Set();
  for (const finding of record.findings) {
    const findingLabel = `Audit record '${label}' finding '${finding.id}'`;
    if (!FINDING_ID_PATTERN.test(finding.id)) {
      errors.push(`${findingLabel} must use a stable id in the form 'A-01'`);
    }
    if (seen.has(finding.id)) {
      errors.push(`${findingLabel} is duplicated`);
    }
    seen.add(finding.id);

    if (!AUDIT_FINDING_SEVERITIES.includes(finding.severity)) {
      errors.push(
        `${findingLabel} severity must be one of: ${AUDIT_FINDING_SEVERITIES.join(', ')}`
      );
    }
    if (finding.blocking !== 'true' && finding.blocking !== 'false') {
      errors.push(`${findingLabel} field 'Blocking' must be true or false`);
    }
    for (const [field, value] of [
      ['Claim', finding.claim],
      ['Evidence refs', finding.evidenceRefs],
      ['Consequence', finding.consequence],
      ['Required outcome', finding.requiredOutcome],
      ['Verification required', finding.verificationRequired],
    ]) {
      if (!value) errors.push(`${findingLabel} is missing '${field}'`);
    }
  }
}

function validateConcreteAuditPacket(record, label, errors) {
  for (const [heading, placeholder] of [
    ['## Work Unit Goal', AUDIT_GOAL_PLACEHOLDER],
    ['## Completion Oracle', AUDIT_ORACLE_PLACEHOLDER],
  ]) {
    const body = String(record.sections?.[heading] ?? '').trim();
    if (!body || body === placeholder) {
      errors.push(`Audit record '${label}' requires a concrete '${heading}' audit input`);
    }
  }

  const evidence = String(record.sections?.['## Evidence Available'] ?? '').trim();
  if (!evidence || evidence === AUDIT_EVIDENCE_PLACEHOLDER ||
      !record.candidateArtifact || !evidence.includes(record.candidateArtifact)) {
    errors.push(
      `Audit record '${label}' must bind concrete '## Evidence Available' to candidate_artifact '${record.candidateArtifact || '(empty)'}'`
    );
  }

  const frozenBaseline = String(record.sections?.['## Frozen Baseline'] ?? '').trim();
  if (!frozenBaseline || !record.candidateArtifact ||
      !frozenBaseline.includes(record.candidateArtifact)) {
    errors.push(
      `Audit record '${label}' must bind '## Frozen Baseline' to candidate_artifact '${record.candidateArtifact || '(empty)'}'`
    );
  }

  const coveredBody = String(record.sections?.['## Covered Tasks'] ?? '');
  for (const taskId of record.coveredTasks) {
    if (!coveredBody.split(/\r?\n/).some(line => line.trim() === `- ${taskId}`)) {
      errors.push(
        `Audit record '${label}' must list covered task '${taskId}' in '## Covered Tasks'`
      );
    }
  }
}

function authorityValidationError(authority, options = {}) {
  if (isHumanAuthorityReference(authority)) return '';
  const decisionId = limitationDecisionReference(authority);
  if (!decisionId) {
    return "authority must be 'human: <identity>' or a D-... decision reference";
  }
  const decisionAccepted = options.decisionAccepted ?? options.decisionExists;
  if (typeof decisionAccepted === 'function' && !decisionAccepted(decisionId)) {
    return `authority references missing or non-accepted decision '${decisionId}'`;
  }
  return '';
}

/**
 * Validate one audit record. Independent of the task-record validator.
 *
 * @param {string} content
 * @param {string} label     Display label (usually the record's relative path).
 * @param {object} [options]
 * @param {string} [options.taskIdRegex]  Project task id regex for covered tasks.
 * @param {(taskId: string) => boolean} [options.taskExists]
 * @param {(decisionId: string) => boolean} [options.decisionExists]
 * @param {(decisionId: string) => boolean} [options.decisionAccepted]
 * @returns {string[]}
 */
export function validateAuditRecord(content, label, options = {}) {
  const errors = [];
  const record = parseAuditRecord(content);

  if (!record.frontmatterPresent) {
    return [`Audit record '${label}' is missing YAML frontmatter`];
  }

  for (const key of FORBIDDEN_AUDIT_FRONTMATTER_KEYS) {
    if (Object.hasOwn(record.frontmatter, key)) {
      errors.push(
        `Audit record '${label}' must not set '${key}'; model configuration is adapter-local and the run count is derived from '## Audit History'`
      );
    }
  }

  const expectedId = basename(String(label ?? ''), '.md');
  if (!record.auditId) {
    errors.push(`Audit record '${label}' is missing required frontmatter field 'audit_id'`);
  } else {
    if (!AUDIT_RECORD_ID_PATTERN.test(record.auditId)) {
      errors.push(`Audit record '${label}' audit_id '${record.auditId}' must match AUD-<number>`);
    }
    if (expectedId && expectedId !== record.auditId) {
      errors.push(
        `Audit record '${label}' audit_id '${record.auditId}' must match its filename '${expectedId}.md'`
      );
    }
  }

  if (!record.workUnit) {
    errors.push(`Audit record '${label}' is missing required frontmatter field 'work_unit'`);
  } else {
    const identity = parseWorkUnitIdentity(record.workUnit);
    if (!identity.ok) {
      errors.push(`Audit record '${label}' ${identity.error}`);
    }
  }

  if (!record.auditState) {
    errors.push(`Audit record '${label}' is missing required frontmatter field 'audit_state'`);
  } else if (!AUDIT_STATES.includes(record.auditState)) {
    errors.push(
      `Audit record '${label}' audit_state '${record.auditState}' must be one of: ${AUDIT_STATES.join(', ')}`
    );
  }

  if (record.coveredTasks.length === 0) {
    errors.push(`Audit record '${label}' requires a non-empty 'covered_tasks' boundary`);
  } else if (options.taskIdRegex) {
    let pattern = null;
    try {
      pattern = new RegExp(options.taskIdRegex);
    } catch { /* project map validation reports an invalid regex */ }
    for (const taskId of record.coveredTasks) {
      if (pattern && !pattern.test(taskId)) {
        errors.push(
          `Audit record '${label}' covered task '${taskId}' does not match the project task id pattern`
        );
      } else if (options.taskExists && !options.taskExists(taskId)) {
        errors.push(`Audit record '${label}' covers unknown task '${taskId}'`);
      }
    }
  }

  if (!record.candidateArtifact) {
    errors.push(
      `Audit record '${label}' is missing required frontmatter field 'candidate_artifact'`
    );
  }

  if (record.latestVerdict && !AUDIT_VERDICTS.includes(record.latestVerdict)) {
    errors.push(
      `Audit record '${label}' latest_verdict '${record.latestVerdict}' must be one of: ${AUDIT_VERDICTS.join(', ')}`
    );
  }

  if (record.auditBudget === null || !Number.isInteger(record.auditBudget) || record.auditBudget <= 0) {
    errors.push(`Audit record '${label}' audit_budget must be a positive integer`);
  }

  validateOrderedAuditHeadings(content, label, errors);
  validateAuditHistoryEntries(record, label, errors);
  validateAuditFindings(record, label, errors);
  validateConcreteAuditPacket(record, label, errors);

  // --- History / frontmatter consistency ---------------------------------
  const lastRun = record.history[record.history.length - 1] ?? null;
  if (!lastRun) {
    if (record.latestVerdict) {
      errors.push(
        `Audit record '${label}' sets latest_verdict '${record.latestVerdict}' but records no completed audit run`
      );
    }
  } else if (record.latestVerdict !== lastRun.verdict) {
    errors.push(
      `Audit record '${label}' latest_verdict must equal the last recorded Auditor verdict '${lastRun.verdict}'`
    );
  }

  if (record.auditState === 'certified' && lastRun) {
    if (lastRun.auditedArtifact !== record.candidateArtifact) {
      errors.push(
        `Audit record '${label}' claims certification but the last audited artifact '${lastRun.auditedArtifact}' does not match candidate_artifact '${record.candidateArtifact}'`
      );
    }
    if (!coveredTaskSetsEqual(lastRun.coveredTasks, record.coveredTasks)) {
      errors.push(
        `Audit record '${label}' claims certification but the last audited covered-task set does not match covered_tasks`
      );
    }
  }

  const budgetState = auditBudgetState(record);
  if (record.auditBudget !== null && budgetState.completed > budgetState.budget) {
    errors.push(
      `Audit record '${label}' records ${budgetState.completed} completed audits above audit_budget ${budgetState.budget}; a further report requires a recorded human-approved budget override`
    );
  }

  // --- State consistency --------------------------------------------------
  if (record.auditState === 'certified') {
    const status = certificationStatus(record);
    for (const reason of status.reasons) {
      errors.push(`Audit record '${label}' claims audit_state 'certified' but ${reason}`);
    }
  } else {
    if (record.certifiedArtifact) {
      errors.push(
        `Audit record '${label}' has audit_state '${record.auditState}' but still records certified_artifact; clear stale certification when the baseline changes`
      );
    }
    if (record.certifiedCoveredTasks.length > 0) {
      errors.push(
        `Audit record '${label}' has audit_state '${record.auditState}' but still records certified_covered_tasks; clear stale certification when the baseline changes`
      );
    }
  }

  if (record.auditState === 'blocked') {
    if (!record.auditBlockedReason) {
      errors.push(
        `Audit record '${label}' has audit_state 'blocked' but is missing 'audit_blocked_reason'`
      );
    } else if (record.auditBlockedReason === AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED && !budgetState.exhausted) {
      errors.push(
        `Audit record '${label}' claims '${AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED}' but only ${budgetState.completed} of ${budgetState.budget} audits are recorded`
      );
    }
    if (lastRun && record.latestVerdict !== lastRun.verdict) {
      errors.push(
        `Audit record '${label}' must preserve the last actual Auditor verdict when blocked`
      );
    }
  } else if (record.auditBlockedReason) {
    errors.push(
      `Audit record '${label}' sets audit_blocked_reason but audit_state is '${record.auditState}'`
    );
  }

  const lastRunMatchesCandidate = Boolean(
    lastRun &&
    lastRun.auditedArtifact === record.candidateArtifact &&
    coveredTaskSetsEqual(lastRun.coveredTasks, record.coveredTasks)
  );

  if (record.auditState === 'awaiting_human') {
    if (record.latestVerdict !== 'needs_human_decision') {
      errors.push(
        `Audit record '${label}' may use audit_state 'awaiting_human' only after verdict 'needs_human_decision'`
      );
    }
    if (!lastRunMatchesCandidate) {
      errors.push(
        `Audit record '${label}' may await a human decision only for the current candidate baseline`
      );
    }
    if (record.humanResolutionRef) {
      errors.push(
        `Audit record '${label}' is still awaiting human direction but already sets human_resolution_ref`
      );
    }
  } else if (record.latestVerdict === 'needs_human_decision' &&
      lastRunMatchesCandidate && record.auditState !== 'certified' && !record.humanResolutionRef) {
    errors.push(
      `Audit record '${label}' preserves verdict 'needs_human_decision' outside audit_state 'awaiting_human' without a human_resolution_ref`
    );
  }

  if (record.humanResolutionRef) {
    const authorityError = authorityValidationError(record.humanResolutionRef);
    if (authorityError) {
      errors.push(`Audit record '${label}' human_resolution_ref ${authorityError}`);
    }
    const comments = String(record.sections?.['## Comments'] ?? '');
    if (!comments.includes(`human decision recorded by ${record.humanResolutionRef}:`)) {
      errors.push(
        `Audit record '${label}' sets human_resolution_ref without a matching durable human-decision entry in '## Comments'`
      );
    }
  }

  // Budget exhaustion is a workflow stop, not an Auditor verdict.
  if (budgetState.exhausted && lastRun && !CERTIFYING_AUDIT_VERDICTS.includes(record.latestVerdict) &&
      record.auditState !== 'blocked' && record.auditState !== 'awaiting_human') {
    errors.push(
      `Audit record '${label}' exhausted audit_budget ${budgetState.budget} without certification; set audit_state 'blocked' with reason '${AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED}' and keep the Auditor's actual verdict`
    );
  }

  // --- Accepted limitations ----------------------------------------------
  if (record.latestVerdict === 'certified_with_accepted_limitations') {
    const limitations = parseKnownLimitations(content);
    if (limitations.entries.length === 0) {
      errors.push(
        `Audit record '${label}' uses verdict 'certified_with_accepted_limitations' but '## Known Limitations' lists none`
      );
    }
    for (const entry of limitations.entries) {
      const authorityError = authorityValidationError(entry.authority, options);
      if (authorityError) {
        errors.push(
          `Audit record '${label}' retained limitation ${authorityError}; the Auditor may recommend acceptance but cannot accept a limitation`
        );
      }
    }
  }

  return errors;
}

/**
 * Validate every audit record in a target, including cross-record uniqueness.
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateAuditRecords(repoRoot, options = {}) {
  const errors = [];
  const warnings = [];
  const entries = listAuditRecordFiles(repoRoot);
  const seenIds = new Map();
  const seenWorkUnits = new Map();

  for (const entry of entries) {
    errors.push(...validateAuditRecord(entry.content, entry.relPath, options));
    const record = parseAuditRecord(entry.content);
    if (record.auditId) {
      if (seenIds.has(record.auditId)) {
        errors.push(
          `Audit record '${entry.relPath}' reuses audit_id '${record.auditId}' already used by '${seenIds.get(record.auditId)}'`
        );
      } else {
        seenIds.set(record.auditId, entry.relPath);
      }
    }
    if (record.workUnit) {
      if (seenWorkUnits.has(record.workUnit)) {
        errors.push(
          `Audit record '${entry.relPath}' duplicates work unit '${record.workUnit}' already certified by '${seenWorkUnits.get(record.workUnit)}'`
        );
      } else {
        seenWorkUnits.set(record.workUnit, entry.relPath);
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Rendering and mechanical mutation
//
// The Auditor returns a structured report and never edits files. Orchestrator or
// the `agenticloop audit` CLI persists it through these helpers, which append to
// history without altering earlier entries or the report's substantive findings.
// ---------------------------------------------------------------------------

const AUDIT_PREAMBLE_LINES = Object.freeze([
  'Work-unit audit certificate. Certification state and append-only Auditor',
  'report history for one work unit. Per-task completion summaries stay inline in',
  'their task records; this store never duplicates them.',
]);

function renderFrontmatterLines(fields) {
  const lines = ['---'];
  lines.push(`audit_id: ${fields.auditId}`);
  lines.push(`work_unit: ${fields.workUnit}`);
  lines.push(`audit_state: ${fields.auditState}`);
  if (fields.auditBlockedReason) {
    lines.push(`audit_blocked_reason: ${fields.auditBlockedReason}`);
  }
  lines.push(`human_resolution_ref:${fields.humanResolutionRef ? ` ${fields.humanResolutionRef}` : ''}`);
  const covered = normalizeCoveredTasks(fields.coveredTasks);
  if (covered.length === 0) {
    lines.push('covered_tasks: []');
  } else {
    lines.push('covered_tasks:');
    for (const taskId of covered) lines.push(`  - ${taskId}`);
  }
  lines.push(`candidate_artifact: ${fields.candidateArtifact}`);
  lines.push(`certified_artifact:${fields.certifiedArtifact ? ` ${fields.certifiedArtifact}` : ''}`);
  const certifiedCovered = normalizeCoveredTasks(fields.certifiedCoveredTasks);
  if (certifiedCovered.length === 0) {
    lines.push('certified_covered_tasks: []');
  } else {
    lines.push('certified_covered_tasks:');
    for (const taskId of certifiedCovered) lines.push(`  - ${taskId}`);
  }
  lines.push(`latest_verdict:${fields.latestVerdict ? ` ${fields.latestVerdict}` : ''}`);
  lines.push(`audit_budget: ${fields.auditBudget}`);
  lines.push('---');
  return lines;
}

/**
 * Split an audit record into its editable parts so a rewrite can preserve every
 * human-authored section verbatim.
 *
 * @param {string} content
 * @returns {{ fields: object, preamble: string, sections: Record<string, string> }}
 */
export function readAuditRecordParts(content) {
  const record = parseAuditRecord(content);
  const [, body] = parseFrontmatter(content);
  const lines = markdownLines(body);
  let firstSectionIndex = lines.length;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].live) continue;
    const parsed = parseAtxHeading(lines[index].raw);
    if (parsed && parsed.level === 2) {
      firstSectionIndex = index;
      break;
    }
  }
  const preamble = lines.slice(0, firstSectionIndex).map(item => item.raw).join('\n').trim();
  const sections = {};
  for (const heading of AUDIT_REQUIRED_SECTION_HEADINGS) {
    sections[heading] = markdownSection(content, heading)?.body ?? '';
  }
  return {
    fields: {
      auditId: record.auditId,
      workUnit: record.workUnit,
      auditState: record.auditState,
      auditBlockedReason: record.auditBlockedReason,
      humanResolutionRef: record.humanResolutionRef,
      coveredTasks: record.coveredTasks,
      candidateArtifact: record.candidateArtifact,
      certifiedArtifact: record.certifiedArtifact,
      certifiedCoveredTasks: record.certifiedCoveredTasks,
      latestVerdict: record.latestVerdict,
      auditBudget: record.auditBudget ?? DEFAULT_AUDIT_BUDGET,
    },
    preamble,
    sections,
  };
}

/**
 * Render an audit record from its parts in canonical section order.
 *
 * @param {{ fields: object, preamble?: string, sections: Record<string, string> }} parts
 * @returns {string}
 */
export function renderAuditRecord(parts) {
  const lines = [...renderFrontmatterLines(parts.fields), ''];
  lines.push(`# ${parts.fields.auditId}: Work-Unit Audit`);
  lines.push('');
  lines.push(parts.preamble?.trim() ? parts.preamble.trim() : AUDIT_PREAMBLE_LINES.join('\n'));
  lines.push('');
  for (const heading of AUDIT_REQUIRED_SECTION_HEADINGS) {
    lines.push(heading);
    lines.push('');
    lines.push((parts.sections?.[heading] ?? '').trim());
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

/**
 * Create a new audit record for one work unit.
 *
 * @param {object} options
 * @returns {string}
 */
export function createAuditRecordContent(options) {
  const coveredTasks = normalizeCoveredTasks(options.coveredTasks);
  const sections = {
    '## Work Unit Goal': options.goal?.trim() || AUDIT_GOAL_PLACEHOLDER,
    '## Completion Oracle': options.completionOracle?.trim() || AUDIT_ORACLE_PLACEHOLDER,
    '## Covered Tasks': coveredTasks.map(taskId => `- ${taskId}`).join('\n'),
    '## Frozen Baseline': options.frozenBaseline?.trim() || `- Candidate artifact: ${options.candidateArtifact}`,
    '## Evidence Available': options.evidence?.trim() || AUDIT_EVIDENCE_PLACEHOLDER,
    '## Accepted Decisions': options.acceptedDecisions?.trim() || 'none',
    '## Known Limitations': options.knownLimitations?.trim() || 'none',
    '## Audit History': AUDIT_HISTORY_EMPTY_STATE,
    '## Consolidated Findings': AUDIT_FINDINGS_EMPTY_STATE,
    '## Remediation Tasks': 'none',
    '## Final Certification': AUDIT_CERTIFICATION_EMPTY_STATE,
    '## Comments': '',
  };
  return renderAuditRecord({
    fields: {
      auditId: options.auditId,
      workUnit: options.workUnit,
      auditState: 'active',
      auditBlockedReason: '',
      humanResolutionRef: '',
      coveredTasks,
      candidateArtifact: options.candidateArtifact,
      certifiedArtifact: '',
      certifiedCoveredTasks: [],
      latestVerdict: '',
      auditBudget: Number.isInteger(options.auditBudget) && options.auditBudget > 0
        ? options.auditBudget
        : DEFAULT_AUDIT_BUDGET,
    },
    sections,
  });
}

/**
 * Replace the candidate baseline and covered-task boundary. Any certification
 * that no longer matches the new baseline is cleared; history is untouched, so a
 * new baseline never resets the budget.
 *
 * @param {string} content
 * @param {{ candidateArtifact?: string, coveredTasks?: string[], evidence?: string }} updates
 * @returns {string}
 */
export function updateAuditBaseline(content, updates) {
  const parts = readAuditRecordParts(content);
  if (updates.candidateArtifact) {
    parts.fields.candidateArtifact = String(updates.candidateArtifact).trim();
  }
  if (Array.isArray(updates.coveredTasks) && updates.coveredTasks.length > 0) {
    parts.fields.coveredTasks = normalizeCoveredTasks(updates.coveredTasks);
    parts.sections['## Covered Tasks'] = parts.fields.coveredTasks
      .map(taskId => `- ${taskId}`)
      .join('\n');
  }
  parts.sections['## Frozen Baseline'] = `- Candidate artifact: ${parts.fields.candidateArtifact}`;
  if (updates.evidence) {
    parts.sections['## Evidence Available'] = String(updates.evidence).trim();
  }

  const stale = parts.fields.certifiedArtifact !== parts.fields.candidateArtifact ||
    !coveredTaskSetsEqual(parts.fields.certifiedCoveredTasks, parts.fields.coveredTasks);
  if (stale) {
    parts.fields.certifiedArtifact = '';
    parts.fields.certifiedCoveredTasks = [];
    if (parts.fields.auditState === 'certified' || parts.fields.auditState === 'awaiting_human') {
      parts.fields.auditState = 'active';
      parts.fields.auditBlockedReason = '';
    }
    parts.fields.humanResolutionRef = '';
    const budget = auditBudgetState(parseAuditRecord(content));
    if (budget.exhausted && parts.fields.auditState === 'active') {
      parts.fields.auditState = 'blocked';
      parts.fields.auditBlockedReason = AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED;
    }
    parts.sections['## Final Certification'] = AUDIT_CERTIFICATION_EMPTY_STATE;
  }
  return renderAuditRecord(parts);
}

function normalizedSingleLine(value, field, errors, required = true) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) {
    errors.push(`${field} is required`);
  } else if (/[\r\n]/.test(normalized)) {
    errors.push(`${field} must be a single line`);
  }
  return normalized;
}

function normalizeReportFindings(rawFindings, errors) {
  if (!Array.isArray(rawFindings)) {
    errors.push('findings must be an array');
    return [];
  }

  const seen = new Set();
  return rawFindings.map((raw, index) => {
    const label = `finding ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${label} must be an object`);
      return {
        id: '',
        severity: '',
        blocking: false,
        claim: '',
        evidenceRefs: '',
        consequence: '',
        requiredOutcome: '',
        verificationRequired: '',
      };
    }
    const id = normalizedSingleLine(raw.id, `${label} id`, errors);
    const severity = normalizedSingleLine(raw.severity, `${label} severity`, errors).toLowerCase();
    const blockingRaw = raw.blocking;
    const blocking = blockingRaw === true || blockingRaw === 'true'
      ? true
      : blockingRaw === false || blockingRaw === 'false'
        ? false
        : null;
    const finding = {
      id,
      severity,
      blocking: blocking ?? false,
      claim: normalizedSingleLine(raw.claim, `${label} claim`, errors),
      evidenceRefs: normalizedSingleLine(
        raw.evidenceRefs ?? raw.evidence_refs,
        `${label} evidence refs`,
        errors
      ),
      consequence: normalizedSingleLine(raw.consequence, `${label} consequence`, errors),
      requiredOutcome: normalizedSingleLine(
        raw.requiredOutcome ?? raw.required_outcome,
        `${label} required outcome`,
        errors
      ),
      verificationRequired: normalizedSingleLine(
        raw.verificationRequired ?? raw.verification_required,
        `${label} verification required`,
        errors
      ),
    };
    if (!FINDING_ID_PATTERN.test(id)) {
      errors.push(`${label} id '${id}' must use the form 'A-01'`);
    } else if (seen.has(id)) {
      errors.push(`${label} duplicates id '${id}'`);
    }
    seen.add(id);
    if (!AUDIT_FINDING_SEVERITIES.includes(severity)) {
      errors.push(
        `${label} severity '${severity}' must be one of: ${AUDIT_FINDING_SEVERITIES.join(', ')}`
      );
    }
    if (blocking === null) {
      errors.push(`${label} blocking must be true or false`);
    }
    return finding;
  });
}

function renderFindingBlock(finding) {
  return [
    `### ${finding.id}`,
    '',
    `- Severity: ${finding.severity}`,
    `- Blocking: ${finding.blocking === true || finding.blocking === 'true'}`,
    `- Claim: ${finding.claim}`,
    `- Evidence refs: ${finding.evidenceRefs}`,
    `- Consequence: ${finding.consequence}`,
    `- Required outcome: ${finding.requiredOutcome}`,
    `- Verification required: ${finding.verificationRequired}`,
  ].join('\n');
}

function renderHistoryBlock(entry, runNumber) {
  return [
    `### Run ${runNumber}`,
    '',
    `- Invocation reference: ${entry.invocationReference}`,
    `- Invocation mode: ${entry.invocationMode}`,
    `- Audited artifact: ${entry.auditedArtifact}`,
    `- Covered tasks: ${normalizeCoveredTasks(entry.coveredTasks).join(', ')}`,
    `- Verdict: ${entry.verdict}`,
    `- Assessment: ${entry.assessment}`,
    `- Findings: ${(entry.findings ?? []).length > 0 ? entry.findings.join(', ') : 'none'}`,
    `- Evidence checked: ${entry.evidenceChecked}`,
  ].join('\n');
}

/**
 * Append one completed Auditor report.
 *
 * Refuses to append when the report is not admissible so a certificate cannot be
 * advanced by a same-session fallback, a reused invocation, a stale baseline, or
 * an unauthorized run past the budget.
 *
 * @param {string} content
 * @param {object} report
 * @param {object} [validationOptions]
 * @returns {{ ok: boolean, content?: string, errors: string[], runNumber?: number }}
 */
export function appendAuditReport(content, report, validationOptions = {}) {
  const errors = [];
  const record = parseAuditRecord(content);
  const parts = readAuditRecordParts(content);
  const existingErrors = validateAuditRecord(
    content,
    `${record.auditId || 'audit'}.md`,
    validationOptions
  );
  errors.push(...existingErrors.map(error => `existing audit record is invalid: ${error}`));

  if (!AUDIT_VERDICTS.includes(report?.verdict)) {
    errors.push(`verdict must be one of: ${AUDIT_VERDICTS.join(', ')}`);
  }
  if (!AUDIT_INVOCATION_MODES.includes(report?.invocationMode)) {
    errors.push(
      `invocation mode must be one of: ${AUDIT_INVOCATION_MODES.join(', ')}; a same-session fallback does not satisfy auditing`
    );
  }
  const reference = normalizedSingleLine(
    report?.invocationReference,
    'a unique invocation reference',
    errors
  );
  if (!reference) {
  } else if (record.history.some(entry => entry.invocationReference === reference)) {
    errors.push(
      `invocation reference '${reference}' was already recorded; every re-audit requires a fresh Auditor invocation`
    );
  }
  const auditedArtifact = normalizedSingleLine(
    report?.auditedArtifact ?? record.candidateArtifact,
    'an audited artifact',
    errors
  );
  if (!auditedArtifact) {
  } else if (auditedArtifact !== record.candidateArtifact) {
    errors.push(
      `audited artifact '${auditedArtifact}' does not match the frozen candidate '${record.candidateArtifact}'`
    );
  }
  const assessment = normalizedSingleLine(
    report?.assessment,
    'an assessment summary',
    errors
  );
  const evidenceChecked = normalizedSingleLine(
    report?.evidenceChecked,
    'evidence checked',
    errors
  );
  const reportCoveredTasks = normalizeCoveredTasks(report?.coveredTasks ?? record.coveredTasks);
  if (!coveredTaskSetsEqual(reportCoveredTasks, record.coveredTasks)) {
    errors.push('reported covered tasks do not match the frozen covered_tasks boundary');
  }

  const budgetState = auditBudgetState(record);
  if (budgetState.exhausted) {
    errors.push(
      `audit_budget ${budgetState.budget} is exhausted; record a human-approved budget override before another report`
    );
  }
  if (record.auditState !== 'active') {
    errors.push(
      record.auditState === 'awaiting_human'
        ? 'audit is awaiting a recorded human decision; run audit resolve before another report'
        : record.auditState === 'certified'
          ? 'audit is already certified for this baseline; update the baseline before another report'
          : `audit is blocked (${record.auditBlockedReason || record.auditState || 'blocked'}); a recorded human authorization is required first`
    );
  }

  const findings = normalizeReportFindings(report?.findings ?? [], errors);
  const blockingFindings = findings.filter(f => f.blocking === true || f.blocking === 'true');
  if (report?.verdict === 'certified' && blockingFindings.length > 0) {
    errors.push(
      `verdict 'certified' requires no open blocking findings (got ${blockingFindings.map(f => f.id).join(', ')})`
    );
  }
  if (report?.verdict === 'certified_with_accepted_limitations') {
    const limitations = parseKnownLimitations(content);
    if (limitations.entries.length === 0) {
      errors.push(
        "verdict 'certified_with_accepted_limitations' requires recorded limitations with authority references"
      );
    }
    for (const entry of limitations.entries) {
      const authorityError = authorityValidationError(entry.authority, validationOptions);
      if (authorityError) {
        errors.push(
          `retained limitation '${entry.text}' ${authorityError}; the Auditor may recommend acceptance but cannot accept it`
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const runNumber = record.history.length + 1;
  const historyBody = parts.sections['## Audit History'].trim();
  const priorHistory = historyBody === AUDIT_HISTORY_EMPTY_STATE ? '' : historyBody;
  parts.sections['## Audit History'] = [priorHistory, renderHistoryBlock({
    ...report,
    invocationReference: reference,
    auditedArtifact,
    coveredTasks: reportCoveredTasks,
    assessment,
    evidenceChecked,
    findings: findings.map(f => f.id),
  }, runNumber)].filter(Boolean).join('\n\n');

  parts.sections['## Consolidated Findings'] = findings.length > 0
    ? findings.map(renderFindingBlock).join('\n\n')
    : AUDIT_FINDINGS_EMPTY_STATE;

  parts.fields.latestVerdict = report.verdict;
  parts.fields.humanResolutionRef = '';

  if (CERTIFYING_AUDIT_VERDICTS.includes(report.verdict)) {
    parts.fields.auditState = 'certified';
    parts.fields.auditBlockedReason = '';
    parts.fields.certifiedArtifact = auditedArtifact;
    parts.fields.certifiedCoveredTasks = normalizeCoveredTasks(record.coveredTasks);
    parts.sections['## Final Certification'] = [
      `- Certified artifact: ${auditedArtifact}`,
      `- Certified covered tasks: ${normalizeCoveredTasks(record.coveredTasks).join(', ')}`,
      `- Verdict: ${report.verdict}`,
      `- Certified at run: ${runNumber}`,
    ].join('\n');
  } else {
    parts.fields.certifiedArtifact = '';
    parts.fields.certifiedCoveredTasks = [];
    parts.sections['## Final Certification'] = AUDIT_CERTIFICATION_EMPTY_STATE;
    // Budget exhaustion stops the loop for human direction. It never invents a
    // verdict: latest_verdict keeps the Auditor's actual result.
    const nextBudget = auditBudgetState({ ...record, history: [...record.history, {}] });
    if (report.verdict === 'needs_human_decision') {
      parts.fields.auditState = 'awaiting_human';
      parts.fields.auditBlockedReason = '';
    } else {
      parts.fields.auditState = nextBudget.exhausted ? 'blocked' : 'active';
      parts.fields.auditBlockedReason = nextBudget.exhausted
        ? AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED
        : '';
    }
  }

  const rendered = renderAuditRecord(parts);
  const renderedErrors = validateAuditRecord(
    rendered,
    `${record.auditId || 'audit'}.md`,
    validationOptions
  );
  if (renderedErrors.length > 0) {
    return {
      ok: false,
      errors: renderedErrors.map(error => `rendered audit report is invalid: ${error}`),
    };
  }
  return { ok: true, content: rendered, errors: [], runNumber };
}

/**
 * Record a human-approved budget increase. This is the only way past an
 * exhausted budget; it never rewrites history.
 *
 * @param {string} content
 * @param {{ budget: number, authority: string, note?: string }} options
 * @returns {{ ok: boolean, content?: string, errors: string[] }}
 */
export function applyAuditBudgetOverride(content, options, validationOptions = {}) {
  const errors = [];
  const record = parseAuditRecord(content);
  const budget = Number(options?.budget);
  const authority = String(options?.authority ?? '').trim();
  errors.push(...validateAuditRecord(
    content,
    `${record.auditId || 'audit'}.md`,
    validationOptions
  ).map(error => `existing audit record is invalid: ${error}`));

  if (!Number.isInteger(budget) || budget <= 0) {
    errors.push('budget override must be a positive integer');
  } else if (record.auditBudget !== null && budget <= record.auditBudget) {
    errors.push(
      `budget override must increase audit_budget above ${record.auditBudget}`
    );
  }
  if (!isHumanAuthorityReference(authority)) {
    errors.push(
      "budget override requires a recorded human authority reference in the form 'human: <identity>'"
    );
  }
  if (/[\r\n]/.test(String(options?.note ?? '').trim())) {
    errors.push('budget override note must be a single line');
  }
  if (errors.length > 0) return { ok: false, errors };

  const parts = readAuditRecordParts(content);
  parts.fields.auditBudget = budget;
  if (parts.fields.auditState === 'blocked' &&
      parts.fields.auditBlockedReason === AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED) {
    parts.fields.auditState = 'active';
    parts.fields.auditBlockedReason = '';
  }
  const date = new Date().toISOString().slice(0, 10);
  const note = options?.note?.trim() ? ` ${options.note.trim()}` : '';
  const comment = `- ${date}: audit_budget raised to ${budget} by ${authority}.${note}`;
  parts.sections['## Comments'] = [parts.sections['## Comments'].trim(), comment]
    .filter(Boolean)
    .join('\n');
  const rendered = renderAuditRecord(parts);
  const renderedErrors = validateAuditRecord(
    rendered,
    `${record.auditId || 'audit'}.md`,
    validationOptions
  );
  if (renderedErrors.length > 0) {
    return {
      ok: false,
      errors: renderedErrors.map(error => `overridden audit record is invalid: ${error}`),
    };
  }
  return { ok: true, content: rendered, errors: [] };
}

/**
 * Record the human direction required by a `needs_human_decision` verdict.
 * Resolving the decision does not certify anything; it only permits a fresh,
 * independent Auditor run. If the audit budget is exhausted, the ordinary
 * budget block remains in force after resolution.
 *
 * @param {string} content
 * @param {{ authority: string, note?: string }} options
 * @returns {{ ok: boolean, content?: string, errors: string[] }}
 */
export function applyAuditHumanResolution(content, options, validationOptions = {}) {
  const record = parseAuditRecord(content);
  const errors = [];
  const authority = String(options?.authority ?? '').trim();
  errors.push(...validateAuditRecord(
    content,
    `${record.auditId || 'audit'}.md`,
    validationOptions
  ).map(error => `existing audit record is invalid: ${error}`));
  if (record.auditState !== 'awaiting_human' ||
      record.latestVerdict !== 'needs_human_decision') {
    errors.push("audit resolve requires audit_state 'awaiting_human' after verdict 'needs_human_decision'");
  }
  if (!isHumanAuthorityReference(authority)) {
    errors.push("audit resolution requires authority in the form 'human: <identity>'");
  }
  if (!String(options?.note ?? '').trim()) {
    errors.push('audit resolution requires --note describing the human decision');
  }
  if (/[\r\n]/.test(String(options?.note ?? '').trim())) {
    errors.push('audit resolution note must be a single line');
  }
  if (errors.length > 0) return { ok: false, errors };

  const parts = readAuditRecordParts(content);
  const budget = auditBudgetState(record);
  parts.fields.humanResolutionRef = authority;
  parts.fields.auditState = budget.exhausted ? 'blocked' : 'active';
  parts.fields.auditBlockedReason = budget.exhausted
    ? AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED
    : '';
  const date = new Date().toISOString().slice(0, 10);
  const comment = `- ${date}: human decision recorded by ${authority}: ${options.note.trim()}`;
  parts.sections['## Comments'] = [parts.sections['## Comments'].trim(), comment]
    .filter(Boolean)
    .join('\n');
  const rendered = renderAuditRecord(parts);
  const renderedErrors = validateAuditRecord(
    rendered,
    `${record.auditId || 'audit'}.md`,
    validationOptions
  );
  if (renderedErrors.length > 0) {
    return {
      ok: false,
      errors: renderedErrors.map(error => `resolved audit record is invalid: ${error}`),
    };
  }
  return { ok: true, content: rendered, errors: [] };
}

// ---------------------------------------------------------------------------
// Closeout gate
// ---------------------------------------------------------------------------

/**
 * Evaluate whether work-unit closeout may publish
 * `AGENT_CLOSEOUT_STATUS: complete` for one work unit.
 *
 * @param {string} repoRoot
 * @param {object} params
 * @param {string} params.workUnit                 Canonical work-unit identity.
 * @param {string} [params.workUnitAudit]          Resolved project setting.
 * @param {(taskId: string) => string} [params.taskStatus]  Current status per covered task.
 * @param {string} [params.taskIdRegex]
 * @param {(taskId: string) => boolean} [params.taskExists]
 * @param {(decisionId: string) => boolean} [params.decisionExists]
 * @param {(decisionId: string) => boolean} [params.decisionAccepted]
 * @returns {{ allowed: boolean, state: string, reasons: string[], auditId: string|null, optOut: boolean }}
 */
export function evaluateAuditCloseoutGate(repoRoot, params) {
  const workUnit = String(params?.workUnit ?? '').trim();
  const mode = params?.workUnitAudit === 'disabled' ? 'disabled' : 'enabled';

  if (mode === 'disabled') {
    const existing = findAuditRecord(repoRoot, workUnit);
    return {
      allowed: true,
      state: 'audit_disabled',
      reasons: [],
      auditId: existing?.record?.auditId ?? null,
      optOut: true,
    };
  }

  const matches = listAuditRecordFiles(repoRoot)
    .map(entry => ({ ...entry, record: parseAuditRecord(entry.content) }))
    .filter(entry => entry.record.workUnit === workUnit);
  if (matches.length === 0) {
    return {
      allowed: false,
      state: 'audit_missing',
      reasons: [
        `work_unit_audit is enabled but no audit record exists for work unit '${workUnit}'`,
      ],
      auditId: null,
      optOut: false,
    };
  }
  if (matches.length > 1) {
    return {
      allowed: false,
      state: 'audit_invalid',
      reasons: [
        `work unit '${workUnit}' has ${matches.length} audit records; exactly one is required`,
      ],
      auditId: null,
      optOut: false,
    };
  }

  const found = matches[0];
  const record = found.record;
  const validationErrors = validateAuditRecord(found.content, found.relPath, {
    taskIdRegex: params?.taskIdRegex,
    taskExists: params?.taskExists,
    decisionExists: params?.decisionExists,
    decisionAccepted: params?.decisionAccepted,
  });
  if (validationErrors.length > 0) {
    return {
      allowed: false,
      state: 'audit_invalid',
      reasons: validationErrors,
      auditId: record.auditId || null,
      optOut: false,
      budget: auditBudgetState(record),
    };
  }
  const status = certificationStatus(record);
  const reasons = [...status.reasons];

  if (typeof params?.taskStatus === 'function') {
    for (const taskId of normalizeCoveredTasks(record.coveredTasks)) {
      const taskState = String(params.taskStatus(taskId) ?? '').trim();
      if (taskState !== 'accepted' && taskState !== 'closed') {
        reasons.push(`covered task ${taskId} is '${taskState || 'missing'}' rather than accepted or closed`);
      }
    }
  }

  const budgetState = auditBudgetState(record);
  if (record.auditState === 'awaiting_human') {
    return {
      allowed: false,
      state: 'audit_awaiting_human',
      reasons: reasons.length > 0
        ? reasons
        : [`audit ${record.auditId} awaits a recorded human decision`],
      auditId: record.auditId,
      optOut: false,
      budget: budgetState,
    };
  }
  if (record.auditState === 'blocked') {
    return {
      allowed: false,
      state: 'audit_blocked',
      reasons: reasons.length > 0
        ? reasons
        : [`audit ${record.auditId} is blocked (${record.auditBlockedReason || 'blocked'})`],
      auditId: record.auditId,
      optOut: false,
      budget: budgetState,
    };
  }

  return {
    allowed: reasons.length === 0,
    state: reasons.length === 0 ? 'certified' : 'audit_not_current',
    reasons,
    auditId: record.auditId,
    optOut: false,
    budget: budgetState,
  };
}
