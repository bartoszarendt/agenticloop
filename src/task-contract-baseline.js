/** Durable, versioned implementation-contract baselines for task records. */

import { canonicalSha256 } from './canonical-json.js';
import { parseFrontmatterStrict } from './frontmatter.js';
import { markdownSection } from './markdown.js';

export const TASK_CONTRACT_DIGEST_VERSION = 'v1';
export const TASK_CONTRACT_RECORD_SCHEMA_VERSION = 2;
export const TASK_CONTRACT_RECORD_KIND = 'agenticloop.task-contract-record';
const DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const BASELINE_MARKER_RE = /<!--\s*AGENTIC_LOOP_TASK_CONTRACT_BASELINE\s*\n([\s\S]*?)\n?-->/g;
const CORRECTION_MARKER_RE = /<!--\s*AGENTIC_LOOP_TASK_CONTRACT_CORRECTION\s*\n([\s\S]*?)\n?-->/g;
const RECORD_MARKER_RE = /<!--\s*AGENTIC_LOOP_TASK_CONTRACT_RECORD\s*\n([\s\S]*?)\n?-->/g;

function normalizedText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

function normalizedPaths(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter(item => typeof item === 'string')
    .map(item => item.replace(/\\/g, '/').trim())
    .filter(Boolean))].sort();
}

function fieldMap(text) {
  const fields = {};
  const duplicates = [];
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*?)\s*$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(fields, key)) duplicates.push(key);
    fields[key] = match[2];
  }
  return { fields, duplicates };
}

/** Remove baseline/correction carriers before contract content is projected. */
export function stripTaskContractMarkers(taskBody) {
  return String(taskBody ?? '')
    .replace(BASELINE_MARKER_RE, '')
    .replace(CORRECTION_MARKER_RE, '')
    .replace(/\r\n?/g, '\n');
}

/** RECORD markers in mutable task text are forbidden, not an authority cache. */
export function hasTaskContractRecordMarker(taskBody) {
  RECORD_MARKER_RE.lastIndex = 0;
  return RECORD_MARKER_RE.test(String(taskBody ?? ''));
}

/** Build the canonical material implementation-contract projection. */
export function taskContractProjection(taskBody) {
  const body = stripTaskContractMarkers(taskBody);
  const parsed = parseFrontmatterStrict(body);
  if (parsed.state !== 'valid') {
    return { ok: false, projection: null, error: parsed.state === 'malformed' ? `task frontmatter is malformed (${parsed.reason})` : 'task frontmatter is absent' };
  }
  const frontmatter = parsed.data;
  const taskId = typeof frontmatter.task_id === 'string' ? frontmatter.task_id.trim() : '';
  if (!taskId) return { ok: false, projection: null, error: 'task contract requires non-empty task_id' };
  const section = heading => normalizedText(markdownSection(body, heading)?.body ?? '');
  return {
    ok: true,
    error: null,
    projection: {
      version: TASK_CONTRACT_DIGEST_VERSION,
      task_id: taskId,
      scope: section('## Scope'),
      out_of_scope: section('## Out of Scope'),
      allowed_paths: normalizedPaths(frontmatter.allowed_paths),
      intended_creations: normalizedPaths(frontmatter.intended_creations),
      acceptance_criteria: section('## Acceptance Criteria'),
      required_checks: section('## Required Checks'),
      independent_review_required: String(frontmatter.independent_review_required ?? '').trim().toLowerCase(),
      locked_decision_refs: normalizedPaths(frontmatter.locked_decision_refs ?? frontmatter.decision_refs),
    },
  };
}

/** Return a versioned SHA-256 task-contract digest. */
export function taskContractDigest(taskBody) {
  const projected = taskContractProjection(taskBody);
  if (!projected.ok) return { ok: false, digest: null, projection: null, error: projected.error };
  return {
    ok: true,
    digest: `sha256:${TASK_CONTRACT_DIGEST_VERSION}:${canonicalSha256(projected.projection)}`,
    projection: projected.projection,
    error: null,
  };
}

export function renderTaskContractBaselineMarker({ digest, recordId = null }) {
  if (!DIGEST_RE.test(String(digest ?? ''))) throw new Error('task-contract baseline digest must be sha256:v1:<64 lowercase hex characters>');
  const reference = recordId ? `\nrecord_id: ${String(recordId).trim()}` : '';
  return `<!-- AGENTIC_LOOP_TASK_CONTRACT_BASELINE\nversion: 1\ndigest: ${digest}${reference}\n-->`;
}

export function renderTaskContractCorrectionMarker({ priorDigest, resultingDigest, reason, classification, authority, recordId = null }) {
  if (!DIGEST_RE.test(String(priorDigest ?? '')) || !DIGEST_RE.test(String(resultingDigest ?? ''))) {
    throw new Error('task-contract correction digests must be sha256:v1:<64 lowercase hex characters>');
  }
  const values = { reason, classification, authority };
  for (const [key, value] of Object.entries(values)) {
    if (!String(value ?? '').trim()) throw new Error(`task-contract correction ${key} is required`);
  }
  return [
    '<!-- AGENTIC_LOOP_TASK_CONTRACT_CORRECTION',
    'version: 1',
    'role: maintainer',
    `prior_digest: ${priorDigest}`,
    `resulting_digest: ${resultingDigest}`,
    `reason: ${String(reason).trim()}`,
    `classification: ${String(classification).trim()}`,
    `authority: ${String(authority).trim()}`,
    ...(recordId ? [`record_id: ${String(recordId).trim()}`] : []),
    '-->',
  ].join('\n');
}

/** Parse durable baseline and correction markers without accepting malformed fields. */
export function parseTaskContractMarkers(taskBody) {
  const parse = (pattern, kind) => {
    const entries = [];
    for (const match of String(taskBody ?? '').matchAll(pattern)) {
      const mapped = fieldMap(match[1]);
      entries.push({ kind, fields: mapped.fields, duplicates: mapped.duplicates, raw: match[0] });
    }
    return entries;
  };
  const baselines = parse(BASELINE_MARKER_RE, 'baseline');
  const corrections = parse(CORRECTION_MARKER_RE, 'correction');
  const errors = [];
  if (baselines.length > 1) errors.push('multiple task-contract baseline markers are present');
  for (const baseline of baselines) {
    if (baseline.duplicates.length) errors.push(`task-contract baseline marker has duplicate field(s): ${baseline.duplicates.join(', ')}`);
    if (baseline.fields.version !== '1' || !DIGEST_RE.test(baseline.fields.digest ?? '')) errors.push('task-contract baseline marker requires version: 1 and a valid digest');
  }
  for (const correction of corrections) {
    if (correction.duplicates.length) errors.push(`task-contract correction marker has duplicate field(s): ${correction.duplicates.join(', ')}`);
    for (const key of ['version', 'role', 'prior_digest', 'resulting_digest', 'reason', 'classification', 'authority']) {
      if (!String(correction.fields[key] ?? '').trim()) errors.push(`task-contract correction marker is missing '${key}'`);
    }
    if (correction.fields.version && correction.fields.version !== '1') errors.push('task-contract correction marker version must be 1');
    if (correction.fields.role && correction.fields.role !== 'maintainer') errors.push('task-contract correction marker role must be maintainer');
    for (const key of ['prior_digest', 'resulting_digest']) {
      if (correction.fields[key] && !DIGEST_RE.test(correction.fields[key])) errors.push(`task-contract correction marker '${key}' must be sha256:v1:<64 lowercase hex characters>`);
    }
  }
  return { baselines, corrections, errors };
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isRecordObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordError(record, message) {
  return `task-contract record '${String(record?.recordId ?? record?.carrier?.id ?? 'unknown')}' ${message}`;
}

function actorMatchesCarrier(actor, carrier) {
  const candidate = String(actor ?? '').trim();
  const author = String(carrier?.author ?? '').trim();
  if (!candidate || !author) return false;
  if (carrier?.kind === 'github_issue_comment') {
    return candidate.toLowerCase() === author.toLowerCase();
  }
  if (carrier?.kind === 'files_task_contract_history') {
    const authorEmail = String(carrier?.provenance?.authorEmail ?? '').trim();
    const normalized = candidate.toLowerCase();
    return normalized === author.toLowerCase() ||
      (Boolean(authorEmail) && normalized === `${author} <${authorEmail}>`.toLowerCase());
  }
  return candidate === author;
}

function projectionDigest(projection) {
  return `sha256:${TASK_CONTRACT_DIGEST_VERSION}:${canonicalSha256(projection)}`;
}

function authorityIsReference(value) {
  return /^[a-z][a-z0-9_-]*:\s*\S/i.test(String(value ?? '').trim());
}

/** Validate a transportable record payload. It intentionally has no carrier trust. */
export function validateTaskContractPayload(record, { taskId } = {}) {
  const errors = [];
  if (!isRecordObject(record)) return { ok: false, errors: ['task-contract record must be an object'] };
  if (record.kind !== TASK_CONTRACT_RECORD_KIND) errors.push(recordError(record, `requires kind '${TASK_CONTRACT_RECORD_KIND}'`));
  if (![1, TASK_CONTRACT_RECORD_SCHEMA_VERSION].includes(record.schemaVersion)) errors.push(recordError(record, `requires schemaVersion 1 or ${TASK_CONTRACT_RECORD_SCHEMA_VERSION}`));
  if (!['baseline', 'correction'].includes(record.type)) errors.push(recordError(record, "requires type 'baseline' or 'correction'"));
  if (!String(record.recordId ?? '').trim()) errors.push(recordError(record, 'requires stable recordId'));
  if (taskId && record.taskId !== taskId) errors.push(recordError(record, `does not belong to task '${taskId}'`));
  if (!authorityIsReference(record.authority)) errors.push(recordError(record, 'requires authority as a durable <kind>:<reference>'));
  if (!String(record.actor ?? '').trim()) errors.push(recordError(record, 'requires actor'));
  if (!isIsoTimestamp(record.timestamp)) errors.push(recordError(record, 'requires an ISO timestamp'));
  if (record.type === 'baseline' && !DIGEST_RE.test(String(record.digest ?? ''))) errors.push(recordError(record, 'requires a valid digest'));
  if (record.type === 'correction') {
    for (const key of ['priorDigest', 'resultingDigest', 'reason', 'affectedArtifact']) {
      if (!String(record[key] ?? '').trim()) errors.push(recordError(record, `requires ${key}`));
    }
    for (const key of ['priorDigest', 'resultingDigest']) {
      if (record[key] && !DIGEST_RE.test(record[key])) errors.push(recordError(record, `${key} must be sha256:v1:<64 lowercase hex characters>`));
    }
    if (!Array.isArray(record.changes) || record.changes.length === 0 || record.changes.some(change => !isRecordObject(change) || !String(change.field ?? '').trim() || !Object.hasOwn(change, 'oldValue') || !Object.hasOwn(change, 'newValue'))) {
      errors.push(recordError(record, 'requires non-empty changes with field, oldValue, and newValue'));
    }
  }
  if (record.schemaVersion === TASK_CONTRACT_RECORD_SCHEMA_VERSION) {
    if (record.type === 'baseline' && (!isRecordObject(record.projection) || projectionDigest(record.projection) !== record.digest)) errors.push(recordError(record, 'baseline projection does not recompute to digest'));
    if (record.type === 'correction') {
      if (!isRecordObject(record.priorProjection) || projectionDigest(record.priorProjection) !== record.priorDigest) errors.push(recordError(record, 'prior projection does not recompute to priorDigest'));
      if (!isRecordObject(record.resultingProjection) || projectionDigest(record.resultingProjection) !== record.resultingDigest) errors.push(recordError(record, 'resulting projection does not recompute to resultingDigest'));
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Validate an externally supplied carrier after its payload has been parsed. */
export function validateTaskContractRecord(record, { taskId, trustedActors = null } = {}) {
  const errors = [...validateTaskContractPayload(record, { taskId }).errors];
  const carrier = record?.carrier;
  if (!isRecordObject(carrier) || !String(carrier.id ?? '').trim() || !String(carrier.kind ?? '').trim()) {
    errors.push(recordError(record, 'requires stable carrier id and kind'));
  } else {
    if (carrier.verifiedAuthority !== true) errors.push(recordError(record, 'carrier authority is not verified'));
    if (carrier.edited === true) errors.push(recordError(record, 'carrier was edited; publish a new versioned record instead'));
    for (const key of ['author', 'createdAt', 'updatedAt', 'bodyDigest', 'url']) if (!String(carrier[key] ?? '').trim()) errors.push(recordError(record, `carrier ${key} is missing`));
    if (!isIsoTimestamp(carrier.createdAt) || !isIsoTimestamp(carrier.updatedAt)) errors.push(recordError(record, 'carrier timestamps are invalid'));
    if (!actorMatchesCarrier(record?.actor, carrier)) errors.push(recordError(record, 'actor does not match verified carrier author'));
    if (Array.isArray(trustedActors) && trustedActors.length && !trustedActors.map(actor => String(actor).toLowerCase()).includes(String(carrier.author ?? '').toLowerCase())) errors.push(recordError(record, 'carrier author is not in the configured trusted-actor allowlist'));
  }
  return { ok: errors.length === 0, errors };
}

export function createTaskContractBaselineRecord({ recordId, taskId, digest, projection, authority, actor, timestamp, affectedArtifact }) {
  const record = { kind: TASK_CONTRACT_RECORD_KIND, schemaVersion: TASK_CONTRACT_RECORD_SCHEMA_VERSION, type: 'baseline', recordId, taskId, digest, projection, authority, actor, timestamp, affectedArtifact };
  const validation = validateTaskContractPayload(record, { taskId });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}

export function createTaskContractCorrectionRecord({ recordId, taskId, priorDigest, resultingDigest, priorProjection, resultingProjection, changes, reason, authority, actor, affectedArtifact, timestamp }) {
  const record = { kind: TASK_CONTRACT_RECORD_KIND, schemaVersion: TASK_CONTRACT_RECORD_SCHEMA_VERSION, type: 'correction', recordId, taskId, priorDigest, resultingDigest, priorProjection, resultingProjection, changes, reason, authority, actor, affectedArtifact, timestamp };
  const validation = validateTaskContractPayload(record, { taskId });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}

/** Render only a payload. Backend carrier facts are attached after refetch. */
export function renderTaskContractRecord(record) {
  const { carrier: _legacyCarrier, ...payload } = record ?? {};
  const validation = validateTaskContractPayload(payload, { taskId: payload?.taskId });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return `<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n${JSON.stringify(payload)}\n-->`;
}

/**
 * Resolve the authority state of a carrier. GitHub carriers are classified by
 * the normalizer; other backends (or offline snapshots) fall back to their
 * explicit authority/edit flags.
 */
export function carrierAuthorityState(carrier) {
  if (typeof carrier?.authorityState === 'string' && carrier.authorityState) return carrier.authorityState;
  if (carrier?.verifiedAuthority === true) return 'trusted_immutable';
  if (carrier?.edited === true) return 'edited_authority';
  return 'incomplete_carrier';
}

/** Noise states never promote and never fail a chain. */
const NON_FATAL_CARRIER_STATES = new Set(['untrusted_association', 'not_allowlisted', 'edited_authority']);

/**
 * Parse independently fetched carriers without claiming their records are
 * trusted. Parse diagnostics retain carrier identity and authority
 * classification; only failures on decisive carriers are fatal.
 */
export function parseTaskContractRecords(carriers = []) {
  const parsedRecords = [];
  const parseDiagnostics = [];
  for (const carrier of carriers) {
    if (!isRecordObject(carrier)) continue;
    const state = carrierAuthorityState(carrier);
    for (const match of String(carrier.body ?? '').matchAll(RECORD_MARKER_RE)) {
      const diagnostic = message => ({
        carrierId: String(carrier.id ?? 'unknown'),
        carrierKind: String(carrier.kind ?? 'unknown'),
        carrierAuthor: String(carrier.author ?? ''),
        authorityState: state,
        fatal: !NON_FATAL_CARRIER_STATES.has(state),
        message,
      });
      let payload;
      try { payload = JSON.parse(match[1]); } catch {
        parseDiagnostics.push(diagnostic(`task-contract record carrier '${String(carrier.id ?? 'unknown')}' contains invalid JSON`));
        continue;
      }
      if (!isRecordObject(payload)) {
        parseDiagnostics.push(diagnostic(`task-contract record carrier '${String(carrier.id ?? 'unknown')}' must contain an object`));
        continue;
      }
      // Ignore any self-attested carrier in the wire payload.
      const { carrier: _embeddedCarrier, ...record } = payload;
      parsedRecords.push({ ...record, carrier: { ...carrier } });
    }
  }
  return {
    parsedRecords,
    parseDiagnostics,
    parseErrors: parseDiagnostics.filter(item => item.fatal).map(item => item.message),
    parseWarnings: parseDiagnostics.filter(item => !item.fatal).map(item => item.message),
  };
}

/**
 * Promote parsed records only after full payload and actual-carrier
 * validation. Untrusted-association and not-allowlisted carriers are
 * non-authoritative noise; edited authority carriers are rejected without
 * failing the chain; incomplete carriers fail safely as adapter errors; a
 * malformed record on a trusted immutable carrier is fatal. Duplicate,
 * fork, orphan, cycle, and replay checks run later, on promoted trusted
 * records only, so an untrusted duplicate record ID cannot invalidate a
 * trusted record.
 */
export function validateTrustedTaskContractRecords(parsedRecords = [], { taskId, trustedActors = null } = {}) {
  const trustedRecords = [];
  const rejectedRecords = [];
  const errors = [];
  const warnings = [];
  for (const record of Array.isArray(parsedRecords) ? parsedRecords : []) {
    const carrier = record?.carrier ?? null;
    const state = carrierAuthorityState(carrier);
    if (state === 'untrusted_association' || state === 'not_allowlisted') {
      const message = recordError(record, `ignored: carrier authority state '${state}' is not authoritative`);
      rejectedRecords.push({ record, carrier, state, errors: [message] });
      warnings.push(message);
      continue;
    }
    if (state === 'edited_authority') {
      const message = recordError(record, 'rejected: carrier was edited; publish a new versioned record instead');
      rejectedRecords.push({ record, carrier, state, errors: [message] });
      warnings.push(message);
      continue;
    }
    if (state !== 'trusted_immutable') {
      const detail = Array.isArray(carrier?.normalizationErrors) && carrier.normalizationErrors.length
        ? ` (${carrier.normalizationErrors.join('; ')})`
        : '';
      const message = recordError(record, `cannot determine carrier authority${detail}; this is an adapter/provenance error`);
      rejectedRecords.push({ record, carrier, state: 'incomplete_carrier', errors: [message] });
      errors.push(message);
      continue;
    }
    const validation = validateTaskContractRecord(record, { taskId, trustedActors });
    if (validation.ok) trustedRecords.push(record);
    else {
      rejectedRecords.push({ record, carrier, state: 'trusted_but_invalid', errors: validation.errors });
      errors.push(...validation.errors);
    }
  }
  return { trustedRecords, rejectedRecords, errors, warnings };
}

export function deriveTaskContractLifecycle(taskBody, { currentBody = null, transition = false } = {}) {
  const parsed = parseFrontmatterStrict(taskBody);
  if (parsed.state !== 'valid') return 'legacy';
  const current = parseFrontmatterStrict(String(currentBody ?? ''));
  const schemaCurrent = Number(parsed.data.task_contract_schema) >= 2;
  const enteringAgentReady = current.state === 'valid' && String(current.data.status ?? '') !== 'agent-ready' && String(parsed.data.status ?? '') === 'agent-ready';
  if (schemaCurrent && (transition || enteringAgentReady || String(parsed.data.status ?? '') === 'agent-ready')) return 'new';
  // Any actual transition into agent-ready — including a schema-less legacy
  // task — requires baseline migration. A legacy task whose material contract
  // changed relative to the known current body requires it too. Historical
  // inspection without either signal remains warning-only.
  if (transition || enteringAgentReady) return 'transition';
  if (!schemaCurrent && current.state === 'valid' && taskContractDigest(taskBody).digest !== taskContractDigest(currentBody).digest) return 'transition';
  return 'legacy';
}

function validateCorrectionClaims(correction) {
  if (correction.schemaVersion !== TASK_CONTRACT_RECORD_SCHEMA_VERSION) return [];
  const errors = [];
  const prior = correction.priorProjection;
  const resulting = correction.resultingProjection;
  const changed = new Set(correction.changes.map(change => change.field));
  for (const field of new Set([...Object.keys(prior), ...Object.keys(resulting)])) {
    const differs = JSON.stringify(prior[field]) !== JSON.stringify(resulting[field]);
    const claim = correction.changes.find(change => change.field === field);
    if (differs && !claim) errors.push(recordError(correction, `changed protected field '${field}' is absent from changes`));
    if (!differs && claim) errors.push(recordError(correction, `unchanged field '${field}' is falsely claimed in changes`));
    if (claim && (JSON.stringify(claim.oldValue) !== JSON.stringify(prior[field]) || JSON.stringify(claim.newValue) !== JSON.stringify(resulting[field]))) errors.push(recordError(correction, `change '${field}' does not match canonical projections`));
  }
  return errors;
}

/**
 * Validate the trusted record graph (payloads, carriers, duplicates, chain
 * connectivity) and compute the terminal digest/projection. Zero baselines is
 * not an error here; the caller decides whether a baseline is required.
 */
function evaluateTrustedRecordGraph(relevant, { taskId, prospectiveIds }) {
  const none = { errors: null, baseline: null, corrections: [], terminalDigest: null, terminalProjection: null };
  const recordErrors = relevant.flatMap(record => (prospectiveIds.has(record.recordId)
    ? validateTaskContractPayload(record, { taskId })
    : validateTaskContractRecord(record, { taskId })).errors);
  if (recordErrors.length) return { ...none, errors: recordErrors };
  const ids = new Set();
  const carriers = new Set();
  const duplicates = [];
  for (const record of relevant) {
    if (ids.has(record.recordId)) duplicates.push(`duplicate task-contract record ID '${record.recordId}'`);
    ids.add(record.recordId);
    const carrier = prospectiveIds.has(record.recordId)
      ? `prospective:${record.recordId}`
      : `${record.carrier.kind}:${record.carrier.id}`;
    if (carriers.has(carrier)) duplicates.push(`duplicate authoritative task-contract carrier '${carrier}'`);
    carriers.add(carrier);
  }
  if (duplicates.length) return { ...none, errors: duplicates };
  const baselines = relevant.filter(record => record.type === 'baseline');
  if (baselines.length > 1) return { ...none, errors: ['duplicate task-contract baseline records'] };
  if (baselines.length === 0) return { ...none, errors: [] };
  const baseline = baselines[0];
  const remaining = relevant.filter(record => record.type === 'correction');
  const corrections = [];
  let expectedDigest = baseline.digest;
  let expectedProjection = baseline.projection ?? null;
  const edges = new Set();
  const seenDigests = new Set([expectedDigest]);
  while (true) {
    const candidates = remaining.filter(record => record.priorDigest === expectedDigest);
    if (candidates.length === 0) break;
    if (candidates.length > 1) return { ...none, errors: [`task-contract correction fork at digest '${expectedDigest}'`] };
    const correction = candidates[0];
    const edge = `${correction.priorDigest}->${correction.resultingDigest}`;
    if (edges.has(edge)) return { ...none, errors: ['replayed task-contract correction edge'] };
    if (seenDigests.has(correction.resultingDigest)) return { ...none, errors: ['task-contract correction cycle detected'] };
    const claims = validateCorrectionClaims(correction);
    if (claims.length) return { ...none, errors: claims };
    edges.add(edge); seenDigests.add(correction.resultingDigest);
    corrections.push(correction);
    remaining.splice(remaining.indexOf(correction), 1);
    expectedDigest = correction.resultingDigest;
    expectedProjection = correction.resultingProjection ?? expectedProjection;
  }
  if (remaining.length) return { ...none, errors: ['orphan task-contract correction record(s) do not connect to the baseline chain'] };
  return { errors: [], baseline, corrections, terminalDigest: expectedDigest, terminalProjection: expectedProjection };
}

/**
 * Compute the terminal digest/projection of an already-trusted chain without
 * comparing it to a current body. Requires exactly one baseline.
 */
export function trustedChainTerminal(trustedRecords = [], { taskId } = {}) {
  const relevant = (Array.isArray(trustedRecords) ? trustedRecords : []).filter(record => record?.taskId === taskId);
  const graph = evaluateTrustedRecordGraph(relevant, { taskId, prospectiveIds: new Set() });
  if (graph.errors.length) return { ok: false, errors: graph.errors, baseline: null, corrections: [], terminalDigest: null, terminalProjection: null };
  if (!graph.baseline) return { ok: false, errors: ['missing task-contract baseline record'], baseline: null, corrections: [], terminalDigest: null, terminalProjection: null };
  return { ok: true, errors: [], baseline: graph.baseline, corrections: graph.corrections, terminalDigest: graph.terminalDigest, terminalProjection: graph.terminalProjection };
}

/** Validate the current contract against an independently verifiable record graph. */
export function validateTaskContractBaseline(taskBody, { requireBaseline = false, lifecycle = 'legacy', trustedRecords = [], trustedRecordErrors = [], prospectiveRecords = [] } = {}) {
  const current = taskContractDigest(taskBody);
  const requireTrustedBaseline = requireBaseline || lifecycle === 'new' || lifecycle === 'transition';
  if (!current.ok) {
    const missingContract = current.error === 'task frontmatter is absent' || current.error === 'task contract requires non-empty task_id';
    return {
      ok: !requireTrustedBaseline && missingContract,
      errors: requireTrustedBaseline ? ['task requires a trusted task-contract baseline record'] : missingContract ? [] : [current.error],
      warnings: requireTrustedBaseline ? [] : missingContract ? ['legacy task has no trusted task-contract baseline; establish one before the next readiness transition'] : [],
      digest: null,
      baseline: null,
      corrections: [],
      errorFacts: requireTrustedBaseline
        ? [{ code: 'contract.baseline.missing', message: 'task requires a trusted task-contract baseline record' }]
        : missingContract ? [] : [{ code: 'contract.baseline.invalid', message: current.error }],
    };
  }
  if (hasTaskContractRecordMarker(taskBody)) return { ok: false, errors: ['task-contract RECORD markers are forbidden in mutable task bodies; use independently fetched backend carriers'], warnings: [], digest: current.digest, baseline: null, corrections: [], errorFacts: [{ code: 'contract.baseline.invalid', message: 'task-contract RECORD markers are forbidden in mutable task bodies; use independently fetched backend carriers' }] };
  const markers = parseTaskContractMarkers(taskBody);
  if (markers.errors.length) return { ok: false, errors: markers.errors, warnings: [], digest: current.digest, baseline: null, corrections: [], errorFacts: markers.errors.map(message => ({ code: 'contract.baseline.invalid', message })) };
  if (trustedRecordErrors.length) return { ok: false, errors: [...trustedRecordErrors], warnings: [], digest: current.digest, baseline: null, corrections: [], errorFacts: trustedRecordErrors.map(message => ({ code: 'contract.baseline.invalid', message })) };
  const taskId = current.projection.task_id;
  const trusted = Array.isArray(trustedRecords) ? trustedRecords : [];
  const prospective = Array.isArray(prospectiveRecords) ? prospectiveRecords : [];
  const relevant = [...trusted, ...prospective].filter(record => record?.taskId === taskId);
  const prospectiveIds = new Set(prospective.map(record => record?.recordId));
  const graph = evaluateTrustedRecordGraph(relevant, { taskId, prospectiveIds });
  if (graph.errors.length) return { ok: false, errors: graph.errors, warnings: [], digest: current.digest, baseline: graph.baseline, corrections: graph.corrections, errorFacts: graph.errors.map(message => ({ code: 'contract.baseline.invalid', message })) };
  if (!graph.baseline) {
    return {
      ok: !requireTrustedBaseline,
      errors: requireTrustedBaseline ? ['missing task-contract baseline record'] : [],
      warnings: requireTrustedBaseline ? [] : ['legacy task has no trusted task-contract baseline; establish one before the next readiness transition'],
      digest: current.digest,
      baseline: null,
      corrections: [],
      errorFacts: requireTrustedBaseline ? [{ code: 'contract.baseline.missing', message: 'missing task-contract baseline record' }] : [],
    };
  }
  if (graph.terminalDigest !== current.digest) return { ok: false, errors: ['current task contract differs from the trusted baseline without an authorized correction record'], warnings: [], digest: current.digest, baseline: graph.baseline, corrections: graph.corrections, errorFacts: [{ code: 'contract.baseline.stale', message: 'current task contract differs from the trusted baseline without an authorized correction record' }] };
  return { ok: true, errors: [], warnings: [], digest: current.digest, baseline: graph.baseline, corrections: graph.corrections, errorFacts: [] };
}
