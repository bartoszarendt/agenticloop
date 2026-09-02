import { readFileSync } from 'node:fs';

import { canonicalSha256 } from './canonical-json.js';
import { listWorkflowEvidenceFiles } from './carrier-root.js';
import { REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION, validateRequiredCheckEvidence } from './required-checks.js';

export const CHECK_EVIDENCE_SUPERSESSION_KIND = 'agenticloop.required-check-evidence-supersession';
export const CHECK_EVIDENCE_SUPERSESSION_SCHEMA_VERSION = 1;
const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'taskId', 'packetId', 'invocationId', 'reason', 'authority',
  'supersededDigest', 'supersededEvidence', 'observedAt', 'digest',
]);

function exact(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === FIELDS.length && Object.keys(value).every(key => FIELDS.includes(key));
}

function recordDigest(record) {
  const { digest, ...projection } = record;
  return `sha256:agenticloop.required-check-evidence-supersession.v1:${canonicalSha256(projection)}`;
}

export function validateCheckEvidenceSupersession(record, { taskId = null } = {}) {
  const errors = [];
  if (!exact(record)) return { ok: false, errors: ['check-evidence supersession fields must equal the closed schema'] };
  if (record.kind !== CHECK_EVIDENCE_SUPERSESSION_KIND || record.schemaVersion !== CHECK_EVIDENCE_SUPERSESSION_SCHEMA_VERSION) errors.push('check-evidence supersession identity is invalid');
  if (typeof record.taskId !== 'string' || !record.taskId || (taskId !== null && record.taskId !== taskId)) errors.push('check-evidence supersession taskId is invalid');
  if (!/^dispatch:[0-9a-f-]{36}$/.test(String(record.packetId ?? '')) || typeof record.invocationId !== 'string' || !record.invocationId) errors.push('check-evidence supersession dispatch binding is invalid');
  if (record.reason !== 'final_scaffold_rebind') errors.push('check-evidence supersession reason is invalid');
  if (!/^(?:maintainer|human):.+/.test(String(record.authority ?? ''))) errors.push('check-evidence supersession authority is invalid');
  const evidence = validateRequiredCheckEvidence(record.supersededEvidence, { contractVersion: REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION });
  if (!evidence.ok) errors.push(...evidence.errors.map(error => `superseded check evidence is invalid: ${error}`));
  const expectedSupersededDigest = `sha256:${canonicalSha256(record.supersededEvidence)}`;
  if (record.supersededDigest !== expectedSupersededDigest) errors.push('check-evidence supersession digest does not match the retained predecessor');
  const observed = Date.parse(record.observedAt);
  if (!Number.isFinite(observed) || new Date(observed).toISOString() !== record.observedAt) errors.push('check-evidence supersession observedAt is invalid');
  if (record.digest !== recordDigest(record)) errors.push('check-evidence supersession record digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function createCheckEvidenceSupersession(input) {
  const record = {
    kind: CHECK_EVIDENCE_SUPERSESSION_KIND,
    schemaVersion: CHECK_EVIDENCE_SUPERSESSION_SCHEMA_VERSION,
    taskId: input.taskId,
    packetId: input.packetId,
    invocationId: input.invocationId,
    reason: 'final_scaffold_rebind',
    authority: input.authority,
    supersededDigest: `sha256:${canonicalSha256(input.supersededEvidence)}`,
    supersededEvidence: structuredClone(input.supersededEvidence),
    observedAt: input.observedAt ?? new Date().toISOString(),
    digest: null,
  };
  record.digest = recordDigest(record);
  const checked = validateCheckEvidenceSupersession(record, { taskId: input.taskId });
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(record);
}

export function listCheckEvidenceSupersessions(target, taskId) {
  const records = [];
  const errors = [];
  for (const { name, path } of listWorkflowEvidenceFiles(target, ['.agenticloop', 'checks', taskId, 'history'])) {
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      const checked = validateCheckEvidenceSupersession(record, { taskId });
      if (!checked.ok) errors.push(...checked.errors.map(error => `${name}: ${error}`));
      else records.push(record);
    } catch (error) {
      errors.push(`${name}: check-evidence supersession is unreadable: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}
