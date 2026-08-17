/**
 * Truthful adoption of work that predates the canonical lifecycle.
 *
 * C12-F10: T-016 and T-017 were implemented, accepted, integrated, and
 * independently auditable - and they could not be closed. They predate dispatch
 * packets and verified returns, the `return_evidence_absent` waiver scope is
 * retired, and no amount of operator intent can make a mechanical gate accept
 * evidence that was never produced. A human process exception was offered and
 * recorded, and the gate still could not consume it.
 *
 * There were three ways out and two of them are wrong:
 *
 * 1. Re-waive `return_evidence_absent`. That is what the retirement rejected:
 *    it makes normal closeout mean less for every task, forever, so that a
 *    handful of historical ones can pass.
 * 2. Synthesize the missing evidence - mint a packet, backdate a consumption,
 *    author a return. This is the one thing the whole model exists to prevent.
 *    A fabricated packet is worse than an absent one, because an absent one is
 *    legible as absent.
 * 3. Give historical work its own terminal result that says exactly what it is.
 *
 * This module is the third. An adoption record is **not** a closeout and never
 * projects as one. It carries a lower assurance than any canonically closed
 * task, and it names, individually, every evidence class it does not have. Its
 * whole value is that a reader can tell the difference years later.
 *
 * What it requires instead of the evidence it lacks:
 *
 * - the exact **current** task contract digest, so the thing being adopted is
 *   the thing on disk now, not a remembered version of it;
 * - an accepted implementation artifact, as a real Git object;
 * - an integration identity proving the artifact actually landed;
 * - an independent audit naming that exact artifact;
 * - an explicit human disposition with a durable authority reference.
 *
 * What it must never do: invent a packet, a consumption, a return, a host
 * receipt, or an activation. A missing evidence class is *named as missing*.
 */

import { canonicalSha256 } from './canonical-json.js';

export const HISTORICAL_ADOPTION_KIND = 'agenticloop.historical-adoption';
export const HISTORICAL_ADOPTION_SCHEMA_VERSION = 1;
export const HISTORICAL_ADOPTION_ROOT = '.agenticloop/adoptions';

/**
 * The terminal disposition a historical adoption reaches.
 *
 * Deliberately not `closed`. A reader scanning statuses must not have to
 * consult a second record to learn that this task never produced canonical
 * execution evidence, so the reduced assurance is in the name itself.
 */
export const HISTORICAL_ADOPTION_STATUS = 'historical_adoption_accepted';

/** The assurance grade an adopted task carries. Below every canonical grade. */
export const HISTORICAL_ADOPTION_ASSURANCE = 'historical_reduced';

/**
 * Evidence classes an adoption may declare missing.
 *
 * Closed on purpose. A free-text list would let an adoption quietly omit the
 * class that mattered; naming the domain means an omission is visible.
 */
export const HISTORICAL_MISSING_EVIDENCE_CLASSES = Object.freeze([
  'dispatch_packet',
  'dispatch_consumption',
  'carrier_mutation_lineage',
  'verified_return',
  'host_return_receipt',
  'activation_grant',
]);

/**
 * Evidence classes an adoption may never claim to have synthesized.
 *
 * Identical to the list above, and stated separately because the two rules are
 * different: one governs what may be declared absent, the other governs what
 * may never be declared present without the real record behind it.
 */
export const NON_SYNTHESIZABLE_EVIDENCE_CLASSES = HISTORICAL_MISSING_EVIDENCE_CLASSES;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const GIT_OBJECT_RE = /^[0-9a-f]{40}$/;
const AUTHORITY_RE = /^[a-z][a-z0-9_-]*:.+$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'backend', 'taskId', 'repositoryIdentity',
  'taskContractDigest', 'implementationArtifact', 'integration', 'audit',
  'disposition', 'missingEvidence', 'status', 'assurance', 'adoptedAt', 'digest',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

function withoutDigest(record) {
  const { digest: _ignored, ...projection } = record;
  return projection;
}

/** The semantic digest that freezes one adoption record. */
export function historicalAdoptionDigest(record) {
  return `sha256:${HISTORICAL_ADOPTION_KIND}.v${HISTORICAL_ADOPTION_SCHEMA_VERSION}:${canonicalSha256(withoutDigest(record))}`;
}

/** The storage path for one adoption record. */
export function historicalAdoptionRelativePath(taskId) {
  const normalized = String(taskId ?? '').trim();
  if (!TASK_ID_RE.test(normalized)) throw new TypeError('historical adoption taskId is invalid');
  return `${HISTORICAL_ADOPTION_ROOT}/${normalized}.json`;
}

/**
 * Build one frozen historical-adoption record.
 *
 * `missingEvidence` is required and must be non-empty: an adoption that claims
 * to be missing nothing is a task that should have gone through normal
 * closeout, and routing it here would launder canonical evidence into a
 * reduced-assurance record for no reason.
 */
export function createHistoricalAdoption(input = {}) {
  const record = {
    kind: HISTORICAL_ADOPTION_KIND,
    schemaVersion: HISTORICAL_ADOPTION_SCHEMA_VERSION,
    backend: input.backend,
    taskId: input.taskId,
    repositoryIdentity: input.repositoryIdentity,
    taskContractDigest: input.taskContractDigest,
    implementationArtifact: input.implementationArtifact,
    integration: input.integration,
    audit: input.audit,
    disposition: input.disposition,
    missingEvidence: Array.isArray(input.missingEvidence)
      ? [...new Set(input.missingEvidence)].sort()
      : input.missingEvidence,
    status: HISTORICAL_ADOPTION_STATUS,
    assurance: HISTORICAL_ADOPTION_ASSURANCE,
    adoptedAt: input.adoptedAt ?? new Date().toISOString(),
    digest: null,
  };
  record.digest = historicalAdoptionDigest(record);
  const checked = validateHistoricalAdoption(record);
  if (!checked.ok) throw new TypeError(`invalid historical adoption: ${checked.errors.join('; ')}`);
  return Object.freeze(record);
}

/**
 * Validate one adoption record against the closed schema.
 *
 * @param {object} record
 * @param {{ taskId?: string|null, repositoryIdentity?: string|null, taskContractDigest?: string|null, now?: number }} [expected]
 */
export function validateHistoricalAdoption(record, expected = {}) {
  const errors = [];
  if (!exactKeys(record, FIELDS)) {
    return { ok: false, errors: ['historical adoption fields must equal the closed schema'] };
  }
  if (record.kind !== HISTORICAL_ADOPTION_KIND) errors.push(`historical adoption kind must be '${HISTORICAL_ADOPTION_KIND}'`);
  if (record.schemaVersion !== HISTORICAL_ADOPTION_SCHEMA_VERSION) {
    errors.push(`historical adoption schemaVersion must be ${HISTORICAL_ADOPTION_SCHEMA_VERSION}`);
  }
  if (!['files', 'github'].includes(record.backend)) errors.push('historical adoption backend is invalid');
  if (!TASK_ID_RE.test(String(record.taskId ?? ''))) errors.push('historical adoption taskId is invalid');
  if (expected.taskId != null && record.taskId !== expected.taskId) {
    errors.push(`historical adoption taskId '${record.taskId}' does not match expected task '${expected.taskId}'`);
  }
  if (typeof record.repositoryIdentity !== 'string' || !record.repositoryIdentity) {
    errors.push('historical adoption repositoryIdentity is required');
  } else if (expected.repositoryIdentity != null && record.repositoryIdentity !== expected.repositoryIdentity) {
    errors.push('historical adoption was recorded for a different target repository');
  }

  // The contract is the *current* one. Adopting a remembered version would make
  // the record describe something that is no longer on disk.
  if (!CONTRACT_DIGEST_RE.test(String(record.taskContractDigest ?? ''))) {
    errors.push('historical adoption taskContractDigest is invalid');
  } else if (expected.taskContractDigest != null && record.taskContractDigest !== expected.taskContractDigest) {
    errors.push('historical adoption does not bind the exact current task contract');
  }

  // Accepted implementation artifact: a real Git object, not a description.
  if (!exactKeys(record.implementationArtifact, ['kind', 'commit']) ||
      record.implementationArtifact.kind !== 'git_commit' ||
      !GIT_OBJECT_RE.test(String(record.implementationArtifact.commit ?? ''))) {
    errors.push('historical adoption implementationArtifact must name an exact Git commit');
  }
  // Integration identity: proof the artifact actually landed somewhere durable.
  if (!exactKeys(record.integration, ['kind', 'reference', 'commit']) ||
      !['git_merge', 'git_branch_containment', 'pull_request'].includes(record.integration.kind) ||
      typeof record.integration.reference !== 'string' || !record.integration.reference ||
      !GIT_OBJECT_RE.test(String(record.integration.commit ?? ''))) {
    errors.push('historical adoption integration must name an exact integration identity and commit');
  }
  // Independent audit naming that exact artifact. An audit of "the work" is not
  // an audit of this artifact.
  if (!exactKeys(record.audit, ['reference', 'auditedArtifact', 'independent']) ||
      typeof record.audit.reference !== 'string' || !AUTHORITY_RE.test(String(record.audit.reference ?? '')) ||
      !GIT_OBJECT_RE.test(String(record.audit.auditedArtifact ?? '')) ||
      record.audit.independent !== true) {
    errors.push("historical adoption audit must be an independent audit referencing an exact artifact");
  } else if (record.implementationArtifact?.commit &&
             record.audit.auditedArtifact !== record.implementationArtifact.commit) {
    errors.push('historical adoption audit must name the exact artifact being adopted');
  }
  // Explicit human disposition. Reduced assurance is a decision a person makes.
  if (!exactKeys(record.disposition, ['kind', 'authority', 'reason']) ||
      record.disposition.kind !== 'human_adoption' ||
      !AUTHORITY_RE.test(String(record.disposition.authority ?? '')) ||
      typeof record.disposition.reason !== 'string' ||
      record.disposition.reason.trim().length < 16) {
    errors.push('historical adoption disposition must be an explicit human decision with a durable authority and a stated reason');
  }

  // The missing-evidence declaration is the point of the record.
  if (!Array.isArray(record.missingEvidence) || record.missingEvidence.length === 0) {
    errors.push('historical adoption must name at least one missing evidence class; a task missing nothing belongs in normal closeout');
  } else {
    const unknown = record.missingEvidence.filter(item => !HISTORICAL_MISSING_EVIDENCE_CLASSES.includes(item));
    if (unknown.length) errors.push(`historical adoption missingEvidence contains unknown class(es): ${unknown.join(', ')}`);
    const sorted = [...record.missingEvidence].sort();
    if (new Set(record.missingEvidence).size !== record.missingEvidence.length ||
        JSON.stringify(sorted) !== JSON.stringify(record.missingEvidence)) {
      errors.push('historical adoption missingEvidence must be a canonical sorted unique list');
    }
  }

  // The reduced grade is not selectable. An adoption that could claim a
  // canonical status or assurance would defeat its own purpose.
  if (record.status !== HISTORICAL_ADOPTION_STATUS) {
    errors.push(`historical adoption status must be '${HISTORICAL_ADOPTION_STATUS}'`);
  }
  if (record.assurance !== HISTORICAL_ADOPTION_ASSURANCE) {
    errors.push(`historical adoption assurance must be '${HISTORICAL_ADOPTION_ASSURANCE}'`);
  }

  const adoptedMs = Date.parse(record.adoptedAt);
  if (!ISO_UTC_RE.test(String(record.adoptedAt ?? '')) || !Number.isFinite(adoptedMs)) {
    errors.push('historical adoption adoptedAt must be a strict ISO-8601 UTC instant');
  } else if (adoptedMs > (expected.now ?? Date.now()) + 1000) {
    errors.push('historical adoption adoptedAt is future-dated');
  }
  if (record.digest !== historicalAdoptionDigest(record)) errors.push('historical adoption digest is invalid');
  return { ok: errors.length === 0, errors };
}

/**
 * The bounded projection every backend renders for an adopted task.
 *
 * Files and GitHub must say the same thing about assurance, so the projection
 * is derived here once rather than formatted twice. `canonicalClosure: false`
 * is the field a reader checks; the missing classes are the detail behind it.
 */
export function projectHistoricalAdoption(record) {
  return Object.freeze({
    taskId: record.taskId,
    status: record.status,
    assurance: record.assurance,
    canonicalClosure: false,
    reducedAssurance: true,
    missingEvidence: Object.freeze([...record.missingEvidence]),
    adoptedArtifact: record.implementationArtifact.commit,
    integration: `${record.integration.kind}:${record.integration.reference}`,
    auditReference: record.audit.reference,
    dispositionAuthority: record.disposition.authority,
    adoptedAt: record.adoptedAt,
    digest: record.digest,
  });
}
