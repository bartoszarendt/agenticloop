/**
 * Closeout contracts: packet schema, canonical provenance projection, digest,
 * and the versioned closeout marker model.
 *
 * Locked semantics (do not weaken):
 *
 * - The packet under `.agenticloop/tmp/` is transient transport, not a durable
 *   record store. Marker provenance must be reconstructable from durable and
 *   live state after the packet is deleted.
 * - The digest covers the canonical provenance projection: deterministic
 *   canonical UTF-8 JSON (see canonical-json.js), excluding volatile
 *   timestamps, absolute paths, display messages, and the marker being
 *   produced. The projection binds the predecessor marker reference and
 *   carrier revision instead of recursively hashing its own output.
 * - Marker states are exactly `complete`, `follow_up_required`,
 *   `needs_context`, and `blocked`. `AGENT_CLOSEOUT_STATUS` remains the first
 *   compatibility line; current markers add schema and provenance lines.
 * - Legacy unprovenanced markers remain recognizable as history but are never
 *   silently treated as valid completion.
 * - Path classification is deny-by-default: a changed path not matched by one
 *   exact allowed workflow-metadata rule is product drift.
 */

import {
  AUDIT_REPORT_SCHEMA_VERSION,
  CLOSEOUT_MARKER_SCHEMA_VERSION,
  CLOSEOUT_MARKER_STATUSES,
  CLOSEOUT_PACKET_SCHEMA_VERSION,
} from './layout.js';
import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { RETURN_ASSURANCE_VALUES } from './activation-grant.js';

export {
  CLOSEOUT_MARKER_SCHEMA_VERSION,
  CLOSEOUT_MARKER_STATUSES,
  CLOSEOUT_PACKET_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Canonical provenance projection and digest
// ---------------------------------------------------------------------------

/**
 * The provenance projection is the only digest input. It carries every fact
 * needed to prove that the composite closeout evaluation ran, and nothing
 * volatile:
 *
 * - packet/work-unit identity, covered tasks, candidate artifact;
 * - audit binding (audit id, run, verdict, audit schema version);
 * - backend identity and carrier reference plus carrier revision;
 * - plan-sync disposition and evaluated gate outcomes (stable gate ids and
 *   pass/fail, never display text);
 * - finding-disposition state (run-qualified ids and disposition types);
 * - the predecessor marker reference (never the marker being produced).
 *
 * Set-like arrays are sorted here so array insertion order cannot change the
 * digest; the schema defines these sets as unordered.
 *
 * @param {object} packet
 * @returns {object}
 */
export function closeoutProvenanceProjection(packet) {
  const gates = Array.isArray(packet?.gates) ? packet.gates : [];
  const dispositions = Array.isArray(packet?.finding_dispositions)
    ? packet.finding_dispositions
    : [];
  return {
    packet_schema: CLOSEOUT_PACKET_SCHEMA_VERSION,
    marker_schema: CLOSEOUT_MARKER_SCHEMA_VERSION,
    work_unit: String(packet?.work_unit ?? ''),
    covered_tasks: [...(packet?.covered_tasks ?? [])].map(String).sort(),
    candidate_artifact: String(packet?.candidate_artifact ?? ''),
    audit: packet?.audit
      ? {
          audit_id: String(packet.audit.audit_id ?? ''),
          audit_schema_version: packet.audit.audit_schema_version ?? null,
          run: packet.audit.run ?? null,
          verdict: String(packet.audit.verdict ?? ''),
          report_format: String(packet.audit.report_format ?? ''),
          return_assurance: String(packet.audit.return_assurance ?? ''),
          producer_authenticated: packet.audit.producer_authenticated === true,
          report_digest: String(packet.audit.report_digest ?? ''),
        }
      : null,
    audit_opt_out: packet?.audit_opt_out === true,
    backend: String(packet?.backend ?? ''),
    carrier: packet?.carrier
      ? {
          kind: String(packet.carrier.kind ?? ''),
          reference: String(packet.carrier.reference ?? ''),
          revision: String(packet.carrier.revision ?? ''),
        }
      : null,
    plan_sync: String(packet?.plan_sync ?? 'none'),
    gates: gates
      .map(gate => ({ id: String(gate?.id ?? ''), passed: gate?.passed === true }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    finding_dispositions: dispositions
      .map(entry => ({
        run: entry?.run ?? null,
        finding_id: String(entry?.finding_id ?? ''),
        disposition: String(entry?.disposition ?? ''),
      }))
      .sort((left, right) =>
        (left.run ?? 0) - (right.run ?? 0) || left.finding_id.localeCompare(right.finding_id)),
    improvement_refs: [...(packet?.improvement_refs ?? [])].map(String).sort(),
    predecessor_marker: String(packet?.predecessor_marker ?? 'none'),
  };
}

/**
 * SHA-256 digest of the canonical provenance projection, prefixed for display
 * and marker use (`sha256:<hex>`).
 *
 * @param {object} packet
 * @returns {string}
 */
export function closeoutPacketDigest(packet) {
  return `sha256:${canonicalSha256(closeoutProvenanceProjection(packet))}`;
}

/**
 * Validate the substantive shape of a closeout packet. Volatile presentation
 * fields (messages, timestamps) are not checked here; they are never part of
 * the digest.
 *
 * @param {unknown} packet
 * @returns {string[]}
 */
export function validateCloseoutPacket(packet) {
  const errors = [];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return ['closeout packet must be a JSON object'];
  }
  if (packet.packet_schema !== CLOSEOUT_PACKET_SCHEMA_VERSION) {
    errors.push(
      `closeout packet packet_schema must be ${CLOSEOUT_PACKET_SCHEMA_VERSION} (got ${JSON.stringify(packet.packet_schema ?? null)})`
    );
  }
  if (typeof packet.work_unit !== 'string' || !packet.work_unit.trim()) {
    errors.push('closeout packet requires work_unit');
  }
  if (!Array.isArray(packet.covered_tasks) || packet.covered_tasks.some(item => typeof item !== 'string')) {
    errors.push('closeout packet covered_tasks must be an array of task ids');
  }
  if (!Array.isArray(packet.gates) || packet.gates.some(gate =>
    !gate || typeof gate.id !== 'string' || typeof gate.passed !== 'boolean')) {
    errors.push('closeout packet gates must be an array of { id, passed } entries');
  }
  if (!Array.isArray(packet.reasons)) {
    errors.push('closeout packet reasons must be an array');
  } else {
    for (const reason of packet.reasons) {
      if (!reason || typeof reason.gate !== 'string' || !reason.gate ||
          typeof reason.category !== 'string' || !reason.category ||
          typeof reason.message !== 'string' || !reason.message ||
          typeof reason.owner !== 'string' || !reason.owner) {
        errors.push('closeout packet reasons must contain structured gate, category, message, and owner fields');
        break;
      }
    }
  }
  if (typeof packet.candidate_artifact !== 'string') {
    errors.push('closeout packet candidate_artifact must be a string');
  } else if (!packet.candidate_artifact.trim() &&
      (packet.completion_eligible === true || packet.recommended_status === 'complete')) {
    // Truthful correction packets may legitimately have no bound candidate;
    // completion never can.
    errors.push('a completion-eligible closeout packet requires candidate_artifact');
  }
  if (packet.audit !== null && packet.audit !== undefined) {
    const audit = packet.audit;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit) ||
        typeof audit.audit_id !== 'string' || !audit.audit_id ||
        !Number.isSafeInteger(audit.audit_schema_version) ||
        !Number.isSafeInteger(audit.run) || audit.run < 1 ||
        typeof audit.verdict !== 'string' || !audit.verdict ||
        typeof audit.report_format !== 'string' || !audit.report_format ||
        !RETURN_ASSURANCE_VALUES.has(audit.return_assurance) ||
        typeof audit.producer_authenticated !== 'boolean' ||
        typeof audit.report_digest !== 'string' ||
        (audit.report_format === AUDIT_REPORT_SCHEMA_VERSION &&
          !/^sha256:agenticloop\.auditor-report\.v1:[a-f0-9]{64}$/.test(audit.report_digest))) {
      errors.push('closeout packet audit binding must include id, schema, run, verdict, report format, return assurance, producer authentication, and report digest');
    } else if (audit.return_assurance === 'host_receipt' && audit.producer_authenticated !== true) {
      errors.push('closeout packet host_receipt audit assurance requires producer_authenticated true');
    } else if (audit.return_assurance === 'session_reported' && audit.producer_authenticated !== false) {
      errors.push('closeout packet session_reported audit assurance requires producer_authenticated false');
    }
  }
  if (typeof packet.publishable !== 'boolean') {
    errors.push('closeout packet requires a boolean publishable flag');
  }
  if (typeof packet.completion_eligible !== 'boolean') {
    errors.push('closeout packet requires a boolean completion_eligible flag');
  }
  if (!CLOSEOUT_MARKER_STATUSES.includes(packet.recommended_status)) {
    errors.push(
      `closeout packet recommended_status must be one of: ${CLOSEOUT_MARKER_STATUSES.join(', ')}`
    );
  }
  if (packet.completion_eligible === true && packet.recommended_status !== 'complete') {
    errors.push('a completion-eligible packet must recommend status complete');
  }
  if (packet.recommended_status === 'complete' && packet.completion_eligible !== true) {
    errors.push('a packet recommending complete must be completion-eligible');
  }
  if (packet.publishable === false && packet.completion_eligible === true) {
    errors.push('an unpublishable packet cannot be completion-eligible');
  }
  const failedGates = Array.isArray(packet.gates)
    ? packet.gates.filter(gate => gate?.passed === false).map(gate => gate.id)
    : [];
  for (const gate of failedGates) {
    if (!Array.isArray(packet.reasons) || !packet.reasons.some(reason => reason?.gate === gate)) {
      errors.push(`failed closeout gate '${gate}' requires at least one structured reason`);
    }
  }
  if (packet.completion_eligible === true) {
    if (packet.publishable !== true) errors.push('a completion-eligible packet must be publishable');
    if (failedGates.length > 0) errors.push('a completion-eligible packet cannot contain failed gates');
    if (Array.isArray(packet.reasons) && packet.reasons.length > 0) {
      errors.push('a completion-eligible packet cannot contain non-complete reasons');
    }
  }
  if (packet.publishable === true && packet.completion_eligible !== true &&
      !['correct', 'update'].includes(packet.marker_action)) {
    errors.push('a non-complete publishable packet must declare marker_action correct or update');
  }
  if (packet.digest !== undefined &&
      packet.digest !== closeoutPacketDigest(packet)) {
    errors.push('closeout packet digest does not match its canonical provenance projection');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Closeout marker
// ---------------------------------------------------------------------------

export const CLOSEOUT_MARKER_KEYS = Object.freeze({
  status: 'AGENT_CLOSEOUT_STATUS',
  schema: 'AGENT_CLOSEOUT_SCHEMA',
  workUnit: 'AGENT_CLOSEOUT_WORK_UNIT',
  artifact: 'AGENT_CLOSEOUT_ARTIFACT',
  audit: 'AGENT_CLOSEOUT_AUDIT',
  auditAssurance: 'AGENT_CLOSEOUT_AUDIT_ASSURANCE',
  auditProducerAuthenticated: 'AGENT_CLOSEOUT_AUDIT_PRODUCER_AUTHENTICATED',
  predecessor: 'AGENT_CLOSEOUT_PREDECESSOR',
  planSync: 'AGENT_CLOSEOUT_PLAN_SYNC',
  improvements: 'AGENT_CLOSEOUT_IMPROVEMENTS',
  gate: 'AGENT_CLOSEOUT_GATE',
  supersedes: 'AGENT_CLOSEOUT_SUPERSEDES',
});

const MARKER_LINE_PATTERN = /^(AGENT_CLOSEOUT_[A-Z_]+):\s*(.*)$/;
// Dated correction notes appended next to a superseding marker are part of
// the marker envelope, not the carrier substance; they never change the
// marker-normalized carrier revision.
const MARKER_CORRECTION_NOTE_PATTERN = /^- \d{4}-\d{2}-\d{2}: closeout marker (corrected|correction recorded)/;
const MARKER_GATE_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Render one closeout marker block. `AGENT_CLOSEOUT_STATUS` is always
 * the first line for compatibility with existing consumers.
 *
 * @param {object} fields
 * @param {string} fields.status
 * @param {string} fields.workUnit
 * @param {string} fields.artifact
 * @param {string} [fields.auditRef]      e.g. 'AUD-001/run:3' or 'none'.
 * @param {string} [fields.auditAssurance] Observed Auditor return grade or 'none'.
 * @param {boolean|null} [fields.auditProducerAuthenticated]
 * @param {string} [fields.predecessor]   predecessor marker ref or 'none'.
 * @param {string} [fields.gateDigest]    'sha256:<hex>' or 'none'.
 * @param {string} [fields.supersedes]    superseded marker ref or ''.
 * @returns {string}
 */
export function renderCloseoutMarker(fields) {
  const status = String(fields?.status ?? '');
  if (!CLOSEOUT_MARKER_STATUSES.includes(status)) {
    throw new Error(`closeout marker status must be one of: ${CLOSEOUT_MARKER_STATUSES.join(', ')}`);
  }
  const lines = [
    `${CLOSEOUT_MARKER_KEYS.status}: ${status}`,
    `${CLOSEOUT_MARKER_KEYS.schema}: ${CLOSEOUT_MARKER_SCHEMA_VERSION}`,
    `${CLOSEOUT_MARKER_KEYS.workUnit}: ${String(fields?.workUnit ?? '')}`,
    `${CLOSEOUT_MARKER_KEYS.artifact}: ${String(fields?.artifact ?? '').trim() || 'none'}`,
    `${CLOSEOUT_MARKER_KEYS.audit}: ${fields?.auditRef ? String(fields.auditRef) : 'none'}`,
    `${CLOSEOUT_MARKER_KEYS.auditAssurance}: ${fields?.auditAssurance ? String(fields.auditAssurance) : 'none'}`,
    `${CLOSEOUT_MARKER_KEYS.auditProducerAuthenticated}: ${fields?.auditProducerAuthenticated === null || fields?.auditProducerAuthenticated === undefined ? 'none' : String(fields.auditProducerAuthenticated === true)}`,
    `${CLOSEOUT_MARKER_KEYS.predecessor}: ${fields?.predecessor ? String(fields.predecessor) : 'none'}`,
    `${CLOSEOUT_MARKER_KEYS.planSync}: ${fields?.planSync ? String(fields.planSync) : 'none'}`,
    `${CLOSEOUT_MARKER_KEYS.improvements}: ${Array.isArray(fields?.improvementRefs) && fields.improvementRefs.length > 0 ? fields.improvementRefs.join(',') : 'none'}`,
    `${CLOSEOUT_MARKER_KEYS.gate}: ${fields?.gateDigest ? String(fields.gateDigest) : 'none'}`,
  ];
  if (fields?.supersedes) {
    lines.push(`${CLOSEOUT_MARKER_KEYS.supersedes}: ${String(fields.supersedes)}`);
  }
  return lines.join('\n');
}

/**
 * Parse the closeout marker lines out of free text (a task-record comments
 * section or a GitHub comment body). Returns every marker block found, newest
 * last, in source order.
 *
 * @param {string} text
 * @returns {{ fields: Record<string, string>, status: string, provenanced: boolean, index: number }[]}
 */
export function parseCloseoutMarkers(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const markers = [];
  let current = null;
  const flush = () => {
    if (current) markers.push(current);
    current = null;
  };
  for (const raw of lines) {
    const match = raw.trim().match(MARKER_LINE_PATTERN);
    if (!match) {
      // Blank separator lines are allowed inside an envelope so GitHub Markdown
      // formatting cannot make a valid marker look partial.
      if (current && raw.trim() === '') continue;
      flush();
      continue;
    }
    const [, key, value] = match;
    if (key === CLOSEOUT_MARKER_KEYS.status) {
      flush();
      current = { fields: {}, index: markers.length, duplicates: [], errors: [] };
    }
    if (!current) continue;
    if (Object.values(CLOSEOUT_MARKER_KEYS).includes(key)) {
      if (Object.hasOwn(current.fields, key)) current.duplicates.push(key);
      current.fields[key] = value.trim();
    } else {
      current.errors.push(`unknown closeout marker field '${key}'`);
    }
  }
  flush();
  return markers.map(marker => {
    const status = marker.fields[CLOSEOUT_MARKER_KEYS.status] ?? '';
    const schema = marker.fields[CLOSEOUT_MARKER_KEYS.schema] ?? '';
    const hasEnvelope = Object.keys(marker.fields).some(key => key !== CLOSEOUT_MARKER_KEYS.status);
    const errors = [...marker.errors];
    for (const key of marker.duplicates) errors.push(`duplicate closeout marker field '${key}'`);
    if (!CLOSEOUT_MARKER_STATUSES.includes(status)) {
      errors.push(`unknown closeout marker status '${status || '(missing)'}'`);
    }
    if (hasEnvelope) {
      const required = [
        CLOSEOUT_MARKER_KEYS.status,
        CLOSEOUT_MARKER_KEYS.schema,
        CLOSEOUT_MARKER_KEYS.workUnit,
        CLOSEOUT_MARKER_KEYS.artifact,
        CLOSEOUT_MARKER_KEYS.audit,
        CLOSEOUT_MARKER_KEYS.auditAssurance,
        CLOSEOUT_MARKER_KEYS.auditProducerAuthenticated,
        CLOSEOUT_MARKER_KEYS.predecessor,
        CLOSEOUT_MARKER_KEYS.planSync,
        CLOSEOUT_MARKER_KEYS.improvements,
        CLOSEOUT_MARKER_KEYS.gate,
      ];
      for (const key of required) {
        if (!String(marker.fields[key] ?? '').trim()) errors.push(`closeout marker is missing required field '${key}'`);
      }
      if (schema !== String(CLOSEOUT_MARKER_SCHEMA_VERSION)) {
        errors.push(`closeout marker schema '${schema || '(missing)'}' is not supported`);
      }
      if (!MARKER_GATE_PATTERN.test(String(marker.fields[CLOSEOUT_MARKER_KEYS.gate] ?? ''))) {
        errors.push('closeout marker gate digest must be sha256:<64 lowercase hex characters>');
      }
      const auditRef = String(marker.fields[CLOSEOUT_MARKER_KEYS.audit] ?? '');
      const auditAssurance = String(marker.fields[CLOSEOUT_MARKER_KEYS.auditAssurance] ?? '');
      const auditAuthenticated = String(marker.fields[CLOSEOUT_MARKER_KEYS.auditProducerAuthenticated] ?? '');
      if (auditRef === 'none') {
        if (auditAssurance !== 'none' || auditAuthenticated !== 'none') {
          errors.push('closeout marker without an audit must record audit assurance and producer authentication as none');
        }
      } else if (!RETURN_ASSURANCE_VALUES.has(auditAssurance) ||
          !['true', 'false'].includes(auditAuthenticated) ||
          (auditAssurance === 'host_receipt') !== (auditAuthenticated === 'true')) {
        errors.push('closeout marker audit assurance and producer authentication are inconsistent');
      }
    }
    return {
      fields: marker.fields,
      index: marker.index,
      status,
      knownStatus: CLOSEOUT_MARKER_STATUSES.includes(status),
      provenanced: hasEnvelope && errors.length === 0,
      malformed: errors.length > 0,
      errors,
      supersededBy: null,
    };
  });
}

/**
 * Remove all closeout marker blocks from free text. Used to compute a stable
 * carrier revision: publishing a marker changes the carrier bytes but never
 * its marker-normalized revision, while any substantive carrier edit does.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCloseoutMarkers(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  let inMarker = false;
  for (const raw of lines) {
    const match = raw.trim().match(MARKER_LINE_PATTERN);
    if (match && Object.values(CLOSEOUT_MARKER_KEYS).includes(match[1])) {
      inMarker = true;
      continue;
    }
    if (inMarker && raw.trim() === '') {
      continue;
    }
    if (MARKER_CORRECTION_NOTE_PATTERN.test(raw.trim())) {
      inMarker = false;
      continue;
    }
    inMarker = false;
    kept.push(raw);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Resolve the current marker set with deterministic supersession precedence.
 * A marker carrying `AGENT_CLOSEOUT_SUPERSEDES` retires the referenced
 * marker(s). Superseded markers stay recognizable as history.
 *
 * @param {ReturnType<typeof parseCloseoutMarkers>} markers
 * @returns {{ current: object[], superseded: object[], legacy: object[], error: string|null }}
 */
export function resolveCurrentCloseoutMarkers(markers) {
  const list = [...(markers ?? [])];
  const supersededRefs = new Set();
  for (const marker of list) {
    const supersedes = marker.fields?.[CLOSEOUT_MARKER_KEYS.supersedes] ?? '';
    for (const ref of supersedes.split(',').map(item => item.trim()).filter(Boolean)) {
      supersededRefs.add(ref);
    }
  }
  // Provenanced markers use their unique gate digest. Legacy markers use a
  // content hash rather than their former ordinal `marker:<index>` identity;
  // neither reference changes when unrelated comments are inserted.
  const refFor = marker => marker?.provenanced
    ? marker.fields?.[CLOSEOUT_MARKER_KEYS.gate]
    : closeoutMarkerReference(marker);
  const superseded = [];
  const current = [];
  for (const marker of list) {
    if (supersededRefs.has(refFor(marker))) {
      superseded.push({ ...marker, reference: refFor(marker) });
    } else {
      current.push({ ...marker, reference: refFor(marker) });
    }
  }
  const legacy = current.filter(marker => !marker.provenanced);
  let error = null;
  if (current.length > 1) {
    error = `multiple unsuperseded current closeout markers (${current
      .map(marker => marker.reference)
      .join(', ')}); supersede all but one before closeout can proceed`;
  }
  const malformed = current.filter(marker => marker.malformed);
  if (!error && malformed.length > 0) {
    error = `current closeout marker is malformed: ${malformed[0].errors.join('; ')}`;
  }
  return { current, superseded, legacy, error };
}

/** Stable marker identity used only for predecessor and supersession references. */
export function closeoutMarkerReference(marker) {
  return `sha256:${canonicalSha256({
    fields: marker?.fields ?? {},
  })}`;
}

// ---------------------------------------------------------------------------
// Product / workflow-metadata path classification (deny-by-default)
// ---------------------------------------------------------------------------

function normalizeSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Classify one changed path after certification. The only allowed
 * post-certification deltas are:
 *
 * - the bound audit record itself (audit metadata committed after the product
 *   candidate without recursively invalidating its certificate),
 * - transient packet activity under `.agenticloop/tmp/`,
 * - exact workflow paths explicitly bound into this closeout evaluation
 *   (validated improvement proposals), and
 * - content-validated workflow records: the marker carrier, covered task
 *   records, and applicable event logs. These return content-bearing
 *   classifications; the caller must still prove the specific delta is one of
 *   the permitted workflow mutations (see validateWorkflowDeltaContent).
 *
 * Everything else - including any new untracked path - is product drift.
 *
 * @param {string} relPath
 * @param {{ auditRecordRelPath?: string, markerCarrierRelPath?: string, allowedWorkflowPaths?: string[], coveredTaskRelPaths?: string[], eventLogRelPaths?: string[], scratchRelPrefix?: string }} [options]
 * @returns {'audit_metadata'|'workflow_metadata'|'task_record'|'event_log'|'product'}
 */
export function classifyCloseoutPath(relPath, options = {}) {
  const normalized = normalizeSlashes(relPath);
  if (!normalized) return 'product';
  for (const prefix of [
    '.agenticloop/activations/',
    '.agenticloop/returns/verifications/',
    '.agenticloop/closeout-waivers/',
  ]) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return 'workflow_metadata';
  }
  const scratch = normalizeSlashes(options.scratchRelPrefix ?? '.agenticloop/tmp/');
  if (normalized === scratch.replace(/\/$/, '') || normalized.startsWith(scratch.endsWith('/') ? scratch : `${scratch}/`)) {
    // Transient packet activity is never product.
    return 'workflow_metadata';
  }
  const boundAuditRecord = normalizeSlashes(options.auditRecordRelPath ?? '');
  if (boundAuditRecord && normalized === boundAuditRecord) {
    return 'audit_metadata';
  }
  const markerCarrier = normalizeSlashes(options.markerCarrierRelPath ?? '');
  if (markerCarrier && normalized === markerCarrier) {
    // The marker carrier requires content validation: only the exact marker
    // mutation and an independently valid terminal transition are permitted.
    return 'task_record';
  }
  for (const path of options.coveredTaskRelPaths ?? []) {
    if (normalized === normalizeSlashes(path)) return 'task_record';
  }
  for (const path of options.eventLogRelPaths ?? []) {
    if (normalized === normalizeSlashes(path)) return 'event_log';
  }
  for (const path of options.allowedWorkflowPaths ?? []) {
    if (normalized === normalizeSlashes(path)) return 'workflow_metadata';
  }
  return 'product';
}

// ---------------------------------------------------------------------------
// Content-aware workflow-delta validation
// ---------------------------------------------------------------------------

/**
 * The one permitted covered-task terminal transition: frontmatter
 * `status: accepted` becomes `status: closed` and every other byte is
 * identical. Any other frontmatter or body change is product drift.
 *
 * @param {string|null} oldContent
 * @param {string|null} newContent
 * @returns {boolean}
 */
export function isTerminalTaskTransition(oldContent, newContent) {
  if (oldContent == null || newContent == null) return false;
  const replaced = replaceFrontmatterWorkflowStatus(String(oldContent), ['accepted'], 'closed');
  return replaced !== null && replaced === String(newContent);
}

/**
 * Replace the one top-level workflow status in YAML frontmatter while
 * preserving every other byte. Body text that merely resembles a status
 * field is never eligible for workflow-status normalization.
 *
 * @param {string} text
 * @param {string[]} acceptedValues
 * @param {string} replacement
 * @returns {string|null}
 */
function replaceFrontmatterWorkflowStatus(text, acceptedValues, replacement) {
  const source = String(text ?? '');
  const frontmatter = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!frontmatter) return null;
  const lines = frontmatter[2].split(/\r?\n/);
  const statusIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^status[ \t]*:/.test(lines[index])) statusIndexes.push(index);
  }
  if (statusIndexes.length !== 1) return null;
  const statusIndex = statusIndexes[0];
  const values = acceptedValues.map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`^(status[ \\t]*:[ \\t]*)(${values.join('|')})([ \\t]*)$`);
  if (!pattern.test(lines[statusIndex])) return null;
  lines[statusIndex] = lines[statusIndex].replace(pattern, `$1${replacement}$3`);
  const normalizedFrontmatter = `${frontmatter[1]}${lines.join(frontmatter[1].includes('\r\n') ? '\r\n' : '\n')}${frontmatter[3]}`;
  return `${normalizedFrontmatter}${source.slice(frontmatter[0].length)}`;
}

/**
 * Normalize a carrier or task record to its substantive content: closeout
 * marker envelopes removed, and the frontmatter status value normalized so
 * the one permitted terminal transition never changes the substance hash.
 *
 * @param {string} text
 * @returns {string}
 */
export function workflowRecordSubstance(text) {
  const stripped = stripCloseoutMarkers(text);
  const lines = stripped.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '## Comments') continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,2}\s+/.test(lines[end])) end += 1;
    if (lines.slice(index + 1, end).every(line => line.trim() === '')) {
      lines.splice(index, end - index);
    }
    break;
  }
  const normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return replaceFrontmatterWorkflowStatus(normalized, ['accepted', 'closed'], '<workflow-status>') ?? normalized;
}

/**
 * Validate one content-bearing workflow delta after certification.
 *
 * @param {'task_record'|'event_log'} classification
 * @param {object} change
 * @param {string} change.path
 * @param {string|null} change.oldContent  Content at the certified commit (or HEAD for dirty paths); null when added.
 * @param {string|null} change.newContent  Current content; null when deleted.
 * @param {{ markerCarrierRelPath?: string, allowedEventTypes?: string[], validateEvent?: Function }} [options]
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateWorkflowDeltaContent(classification, change, options = {}) {
  const path = String(change?.path ?? '');
  const { oldContent, newContent } = change ?? {};
  if (classification === 'task_record') {
    const isCarrier = normalizeSlashes(options.markerCarrierRelPath ?? '') === normalizeSlashes(path);
    if (oldContent == null || newContent == null) {
      return { ok: false, error: `covered task record '${path}' was added or deleted after certification` };
    }
    if (isCarrier) {
      // The carrier permits the exact marker mutation and, independently, the
      // valid terminal transition - never arbitrary carrier-file edits.
      if (workflowRecordSubstance(oldContent) === workflowRecordSubstance(newContent)) {
        return { ok: true };
      }
      if (stripCloseoutMarkers(oldContent) === stripCloseoutMarkers(newContent)) {
        return { ok: true };
      }
      if (isTerminalTaskTransition(stripCloseoutMarkers(oldContent), stripCloseoutMarkers(newContent))) {
        return { ok: true };
      }
      return { ok: false, error: `marker carrier '${path}' changed beyond the closeout marker and the permitted accepted->closed transition` };
    }
    if (isTerminalTaskTransition(oldContent, newContent)) {
      return { ok: true };
    }
    return { ok: false, error: `covered task record '${path}' changed beyond the permitted accepted->closed terminal transition` };
  }
  if (classification === 'event_log') {
    if (newContent == null) {
      return { ok: false, error: `event log '${path}' was deleted after certification` };
    }
    // A log created after certification is an append from empty; every
    // record it contains must be a valid permitted closeout event.
    const base = oldContent ?? '';
    if (!newContent.startsWith(base)) {
      return { ok: false, error: `event log '${path}' was rewritten after certification; only append-only closeout events are permitted` };
    }
    const appended = newContent.slice(base.length);
    const allowedTypes = new Set(options.allowedEventTypes ?? ['task.closed']);
    const validateEvent = options.validateEvent;
    const expectedTaskId = normalizeSlashes(path).match(/\/([^/]+)\.jsonl$/)?.[1] ?? '';
    const seenEventIds = new Set();
    for (const line of base.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event?.event_id === 'string' && event.event_id) seenEventIds.add(event.event_id);
      } catch {
        // The certified prefix is immutable here; only appended records are
        // evaluated as post-certification deltas.
      }
    }
    for (const line of appended.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return { ok: false, error: `event log '${path}' appended a malformed JSON event record` };
      }
      if (!allowedTypes.has(String(event?.event_type ?? ''))) {
        return { ok: false, error: `event log '${path}' appended disallowed event_type '${String(event?.event_type ?? '(missing)')}'` };
      }
      if (!expectedTaskId || String(event?.task_id ?? '') !== expectedTaskId) {
        return {
          ok: false,
          error:
            `event log '${path}' appended an event for task '${String(event?.task_id ?? '(missing)')}' ` +
            `instead of path-bound task '${expectedTaskId || '(unresolved)'}'`,
        };
      }
      if (String(event?.backend ?? '') !== 'files') {
        return {
          ok: false,
          error: `event log '${path}' appended backend '${String(event?.backend ?? '(missing)')}' rather than 'files'`,
        };
      }
      if (typeof event?.event_id === 'string' && seenEventIds.has(event.event_id)) {
        return { ok: false, error: `event log '${path}' appended duplicate event_id '${event.event_id}'` };
      }
      if (typeof validateEvent === 'function') {
        const result = validateEvent(event) ?? {};
        const errors = Array.isArray(result.errors) ? result.errors : [];
        if (errors.length > 0) {
          return { ok: false, error: `event log '${path}' appended an invalid closeout event: ${errors.join('; ')}` };
        }
      }
      if (typeof event?.event_id === 'string' && event.event_id) seenEventIds.add(event.event_id);
    }
    return { ok: true };
  }
  return { ok: false, error: `unsupported workflow delta classification '${classification}'` };
}

/**
 * Evaluate plan-sync disposition wording for the packet. The closeout
 * evaluator records one of: `none`, `not_required`, `synced`, `skipped`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidPlanSyncDisposition(value) {
  return ['none', 'not_required', 'synced', 'skipped'].includes(String(value ?? ''));
}

export { AUDIT_REPORT_SCHEMA_VERSION, canonicalJson };
