import { markdownLines, markdownSection, parseAtxHeading } from './markdown.js';
import { parseResolutionMatrix } from './resolution-matrix.js';
import { parseVerificationAttempts } from './verification-learning.js';

export const TASK_EVIDENCE_INPUT_KIND = 'agenticloop.task-evidence-input';
export const TASK_EVIDENCE_INPUT_SCHEMA_VERSION = 1;
export const TASK_EVIDENCE_SECTIONS = Object.freeze({
  scopeCompleted: '## Scope Completed',
  evidence: '## Evidence',
  deviations: '## Deviations',
  knownGaps: '## Known Gaps',
  verificationAttempts: '## Verification Attempts',
  maintainerTriage: '## Maintainer Triage',
  retryAuthorization: '## Retry Authorization',
  revisionResolution: '## Revision Resolution',
});

const ENGINEER = new Set(['scopeCompleted', 'evidence', 'deviations', 'knownGaps', 'verificationAttempts', 'revisionResolution']);
const MAINTAINER = new Set(['maintainerTriage', 'retryAuthorization']);
const SIMPLE_ENTRY_KEYS = Object.freeze(['id', 'summary', 'status', 'evidenceRefs']);
const ATTEMPT_ENTRY_KEYS = Object.freeze([
  'id', 'attempt', 'artifact', 'command', 'strategy', 'timeoutMs', 'outcome',
  'durationMs', 'required', 'partialEvidence', 'proposedNextStrategy',
  'candidateClassification', 'recordedAt',
]);
const PROVENANCE_KEYS = Object.freeze(['workflowRole', 'invocationId', 'taskContractDigest', 'attemptId']);
const OUTCOMES = new Set(['passed', 'failed', 'timed_out', 'blocked']);
const STRATEGIES = new Set(['foreground', 'background', 'focused', 'split', 'ci']);
const TRIAGE = new Set(['one_off', 'project_fact', 'decision', 'follow_up', 'blocker']);
const DISPOSITIONS = new Set(['resolved', 'disputed', 'blocked']);

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function boundedLine(value, max = 1000) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\r\n]/.test(value);
}

function validateSimpleEntry(entry, section, errors) {
  if (!exact(entry, SIMPLE_ENTRY_KEYS)) {
    errors.push(`task evidence ${section} entry fields must equal id, summary, status, evidenceRefs`);
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(entry.id ?? ''))) errors.push(`task evidence ${section} entry id is invalid`);
  if (!boundedLine(entry.summary)) errors.push(`task evidence ${section} entry summary must be one bounded line`);
  if (!(entry.status === null || /^[a-z][a-z0-9_-]{0,63}$/.test(String(entry.status ?? '')))) errors.push(`task evidence ${section} entry status is invalid`);
  if (!Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.some(ref => !boundedLine(ref, 256))) errors.push(`task evidence ${section} entry evidenceRefs must be bounded strings`);
}

function validateAttemptEntry(entry, errors) {
  if (!exact(entry, ATTEMPT_ENTRY_KEYS)) {
    errors.push(`task evidence verificationAttempts entry fields must equal ${ATTEMPT_ENTRY_KEYS.join(', ')}`);
    return;
  }
  if (!/^RC-[1-9]\d*$/.test(String(entry.id ?? ''))) errors.push("verification attempt id must use stable 'RC-<positive number>' form");
  if (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1) errors.push('verification attempt number must be a positive integer');
  for (const field of ['artifact', 'command', 'partialEvidence']) if (!boundedLine(entry[field])) errors.push(`verification attempt ${field} must be one bounded line`);
  if (!STRATEGIES.has(entry.strategy)) errors.push('verification attempt strategy is invalid');
  if (!(entry.timeoutMs === 'unknown' || entry.timeoutMs === 'none' || (Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs > 0))) errors.push('verification attempt timeoutMs is invalid');
  if (!OUTCOMES.has(entry.outcome)) errors.push('verification attempt outcome is invalid');
  if (!(entry.durationMs === 'unknown' || entry.durationMs === 'none' || (Number.isSafeInteger(entry.durationMs) && entry.durationMs > 0))) errors.push('verification attempt durationMs is invalid');
  if (typeof entry.required !== 'boolean') errors.push('verification attempt required must be boolean');
  if (!(entry.proposedNextStrategy === 'none' || STRATEGIES.has(entry.proposedNextStrategy))) errors.push('verification attempt proposedNextStrategy is invalid');
  if (!(entry.candidateClassification === null || TRIAGE.has(entry.candidateClassification))) errors.push('verification attempt candidateClassification is invalid');
  if (typeof entry.recordedAt !== 'string' || !Number.isFinite(Date.parse(entry.recordedAt)) || new Date(Date.parse(entry.recordedAt)).toISOString() !== entry.recordedAt) errors.push('verification attempt recordedAt must be a canonical UTC instant');
}

export function validateTaskEvidenceInput(value) {
  const errors = [];
  if (!exact(value, ['kind', 'schemaVersion', 'actorRole', 'provenance', 'sections'])) return { ok: false, errors: ['task evidence input fields must equal the closed schema'] };
  if (value.kind !== TASK_EVIDENCE_INPUT_KIND || value.schemaVersion !== TASK_EVIDENCE_INPUT_SCHEMA_VERSION) errors.push('task evidence input identity is invalid');
  if (!['engineer', 'maintainer'].includes(value.actorRole)) errors.push('task evidence actorRole is invalid');
  if (!exact(value.provenance, PROVENANCE_KEYS)) {
    errors.push('task evidence provenance fields must equal workflowRole, invocationId, taskContractDigest, attemptId');
  } else {
    if (value.provenance.workflowRole !== value.actorRole) errors.push('task evidence actorRole does not match provenance workflowRole');
    if (!boundedLine(value.provenance.invocationId, 256)) errors.push('task evidence provenance invocationId is invalid');
    if (!/^sha256:v1:[a-f0-9]{64}$/.test(String(value.provenance.taskContractDigest ?? ''))) errors.push('task evidence provenance taskContractDigest is invalid');
    if (!/^attempt:[a-f0-9]{32}$/.test(String(value.provenance.attemptId ?? ''))) errors.push('task evidence provenance attemptId is invalid');
  }
  if (!exact(value.sections, Object.keys(TASK_EVIDENCE_SECTIONS))) return { ok: false, errors: [...errors, 'task evidence sections must equal the closed schema'] };
  for (const [section, entries] of Object.entries(value.sections)) {
    if (!Array.isArray(entries)) { errors.push(`task evidence section ${section} must be an array`); continue; }
    if (entries.length > 100) errors.push(`task evidence section ${section} exceeds 100 entries`);
    const ownership = value.actorRole === 'engineer' ? ENGINEER : MAINTAINER;
    if (entries.length > 0 && !ownership.has(section)) errors.push(`${value.actorRole} does not own authoritative section ${section}`);
    const seen = new Set();
    for (const entry of entries) {
      if (section === 'verificationAttempts') validateAttemptEntry(entry, errors);
      else validateSimpleEntry(entry, section, errors);
      const identity = section === 'verificationAttempts' ? `${entry?.id}:${entry?.attempt}` : String(entry?.id ?? '');
      if (seen.has(identity)) errors.push(`task evidence ${section} entry identity '${identity}' is duplicated`);
      seen.add(identity);
      if (section === 'revisionResolution') {
        if (!/^F-[1-9]\d*$/.test(String(entry?.id ?? ''))) errors.push("revision resolution id must use stable 'F-<positive number>' form");
        if (!DISPOSITIONS.has(entry?.status)) errors.push('revision resolution status must be resolved, disputed, or blocked');
        if (entry?.evidenceRefs?.length !== 1) errors.push('revision resolution requires exactly one durable evidence reference');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function renderSimple(entries) {
  return entries.map(entry => [`### ${entry.id}`, `- Summary: ${entry.summary.trim()}`, `- Status: ${entry.status ?? 'recorded'}`, `- Evidence refs: ${entry.evidenceRefs.length ? entry.evidenceRefs.join(', ') : 'none'}`].join('\n')).join('\n\n');
}

function renderVerificationAttempts(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.id)) grouped.set(entry.id, []);
    grouped.get(entry.id).push(entry);
  }
  return [...grouped.entries()].map(([checkId, attempts]) => [
    `### ${checkId}`,
    ...attempts.sort((a, b) => a.attempt - b.attempt).map(entry => [
      `#### Attempt ${entry.attempt}`,
      `- Artifact: ${entry.artifact.trim()}`,
      `- Command: ${entry.command.trim()}`,
      `- Strategy: ${entry.strategy}`,
      `- Timeout ms: ${entry.timeoutMs}`,
      `- Outcome: ${entry.outcome}`,
      `- Duration ms: ${entry.durationMs}`,
      `- Required: ${entry.required}`,
      `- Partial evidence: ${entry.partialEvidence.trim()}`,
      `- Proposed next strategy: ${entry.proposedNextStrategy}`,
      ...(entry.candidateClassification === null ? [] : [`- Candidate classification: ${entry.candidateClassification}`]),
      '- Recorded by: engineer',
      `- Recorded at: ${entry.recordedAt}`,
    ].join('\n')),
  ].join('\n\n')).join('\n\n');
}

function renderRevisionResolution(entries) {
  return entries.map(entry => `- [${entry.id}] ${entry.status}: ${entry.summary.trim()} [ref: ${entry.evidenceRefs[0].trim()}]`).join('\n');
}

function renderSection(key, entries) {
  if (key === 'verificationAttempts') return renderVerificationAttempts(entries);
  if (key === 'revisionResolution') return renderRevisionResolution(entries);
  return renderSimple(entries);
}

function markerPair(key) {
  return [`<!-- AGENTICLOOP_TASK_EVIDENCE:${key}:START -->`, `<!-- AGENTICLOOP_TASK_EVIDENCE:${key}:END -->`];
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineOffset(content, lineNumber) {
  if (lineNumber <= 0) return 0;
  const chunks = String(content).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return chunks.slice(0, lineNumber).reduce((total, chunk) => total + chunk.length, 0);
}

function upsertSection(content, key, entries) {
  if (entries.length === 0) return content;
  const heading = TASK_EVIDENCE_SECTIONS[key];
  const [markerStart, markerEnd] = markerPair(key);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const block = `${markerStart}${eol}${renderSection(key, entries).replace(/\n/g, eol)}${eol}${markerEnd}`;
  const markerPattern = new RegExp(`${escaped(markerStart)}[\\s\\S]*?${escaped(markerEnd)}`, 'g');
  const matches = [...content.matchAll(markerPattern)];
  if (matches.length > 1) throw new TypeError(`task evidence section ${key} contains duplicate generated blocks`);
  if (matches.length === 1) return content.replace(markerPattern, block);
  if (content.includes(markerStart) || content.includes(markerEnd)) throw new TypeError(`task evidence section ${key} contains incomplete generated markers`);
  const section = markdownSection(content, heading);
  if (!section) {
    const separator = content.length === 0 || /(?:\r?\n){2}$/.test(content) ? '' : (/(?:\r?\n)$/.test(content) ? eol : `${eol}${eol}`);
    return `${content}${separator}${heading}${eol}${eol}${block}${eol}`;
  }
  const canonicalEmpty = section.body === 'None.' || section.body === 'None' ||
    (key === 'verificationAttempts' && section.body === 'No verification attempts are currently recorded.');
  if (canonicalEmpty) {
    const start = lineOffset(content, section.startLine);
    const end = lineOffset(content, section.endLine);
    return `${content.slice(0, start)}${eol}${block}${eol}${content.slice(end)}`;
  }
  if (key !== 'verificationAttempts' && key !== 'revisionResolution') {
    const existingIds = new Set(section.lines
      .filter(line => line.live)
      .map(line => parseAtxHeading(line.raw))
      .filter(headingEntry => headingEntry?.level === 3)
      .map(headingEntry => headingEntry.text));
    const conflict = entries.find(entry => existingIds.has(entry.id));
    if (conflict) throw new TypeError(`task evidence section ${key} conflicts with existing entry '${conflict.id}'`);
  }
  const offset = lineOffset(content, section.endLine);
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  return `${before}${/(?:\r?\n){2}$/.test(before) ? '' : eol}${block}${eol}${after}`;
}

function duplicateSectionErrors(content) {
  const counts = new Map(Object.values(TASK_EVIDENCE_SECTIONS).map(heading => [heading.slice(3), 0]));
  for (const line of markdownLines(content)) {
    if (!line.live) continue;
    const heading = parseAtxHeading(line.raw);
    if (heading?.level === 2 && counts.has(heading.text)) counts.set(heading.text, counts.get(heading.text) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([heading]) => `task record repeats the '## ${heading}' section`);
}

export function validateAppliedTaskEvidence(content, input) {
  const inputCheck = validateTaskEvidenceInput(input);
  if (!inputCheck.ok) return inputCheck;
  const errors = duplicateSectionErrors(content);
  for (const [key, entries] of Object.entries(input.sections)) {
    if (entries.length === 0) continue;
    const [start, end] = markerPair(key);
    if ((content.match(new RegExp(escaped(start), 'g')) ?? []).length !== 1 || (content.match(new RegExp(escaped(end), 'g')) ?? []).length !== 1) errors.push(`task evidence section ${key} does not contain exactly one generated block`);
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const expectedBlock = `${start}${eol}${renderSection(key, entries).replace(/\n/g, eol)}${eol}${end}`;
    if (!content.includes(expectedBlock)) errors.push(`task evidence section ${key} does not match its canonical rendering`);
  }
  if (input.sections.verificationAttempts.length > 0) {
    const parsed = parseVerificationAttempts(content);
    errors.push(...parsed.errors);
    for (const expected of input.sections.verificationAttempts) {
      const actual = parsed.attempts.find(item => item.checkId === expected.id && item.number === expected.attempt);
      if (!actual || actual.artifact !== expected.artifact.trim() || actual.command !== expected.command.trim() || actual.outcome !== expected.outcome) errors.push(`verification attempt ${expected.id}/${expected.attempt} did not round-trip through the canonical parser`);
    }
  }
  if (input.sections.revisionResolution.length > 0) {
    const parsed = parseResolutionMatrix(content);
    errors.push(...parsed.errors);
    for (const expected of input.sections.revisionResolution) {
      const actual = parsed.entries.find(item => item.findingId === expected.id);
      if (!actual || actual.disposition !== expected.status || actual.evidence !== expected.summary.trim() || actual.reference !== expected.evidenceRefs[0].trim()) errors.push(`revision resolution ${expected.id} did not round-trip through the canonical parser`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function applyTaskEvidenceInput(content, input) {
  const checked = validateTaskEvidenceInput(input);
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  let candidate = String(content ?? '');
  for (const key of Object.keys(TASK_EVIDENCE_SECTIONS)) candidate = upsertSection(candidate, key, input.sections[key]);
  const semantic = validateAppliedTaskEvidence(candidate, input);
  if (!semantic.ok) throw new TypeError(`structured task evidence is not canonical: ${semantic.errors.join('; ')}`);
  return candidate;
}
