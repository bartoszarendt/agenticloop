/**
 * Closed parallel-scan provenance.
 *
 * The Parallel Opportunity Scan already existed as a prose discipline: look at
 * the ready set, decide serial or parallel, record a rescan trigger. Prose
 * cannot distinguish "this bounded work unit genuinely has no eligible work"
 * from "only one task happens to be authored so far", and the second was being
 * presented as the first.
 *
 * This module makes the difference mechanical. A scan states the exact
 * inventory it saw, proves every discovered member is accounted for exactly
 * once, records why each excluded task was excluded, binds the readiness
 * context its ready set was derived from, and refuses to reach a complete
 * conclusion from an inventory it cannot prove complete.
 *
 * Three rules shape the module:
 *
 * 1. Completeness is never a caller assertion. It is derived from a typed
 *    enumeration receipt issued by the authoritative enumerator.
 * 2. Construction and validation agree. `evaluateParallelScan` runs the same
 *    closed validator its consumers run and refuses to return `ok` for a
 *    record that validator would reject.
 * 3. It is read-only and deterministic: it validates and derives, it never
 *    decomposes work, chooses a solution, or mutates a carrier. Readiness,
 *    ownership, eligibility, and pair classification are delegated to their
 *    existing owners rather than reimplemented here.
 */

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { createHash } from 'node:crypto';
import { parseFrontmatterStrict } from './frontmatter.js';
import {
  classifyParallelPair,
  evaluateTaskEligibility,
  parseOwnershipDeclaration,
} from './parallel-ownership.js';
import { createDiagnostic } from './repair-policy.js';
import {
  createValidationResult,
  deriveEvidenceState,
  dispositionForEvidenceState,
} from './result-envelope.js';
import {
  dependencyStatusMap,
  normalizeReadinessBaseEvidence,
  normalizeReadinessDependencyEvidence,
} from './task-evidence-contract.js';
import { evaluateTaskReadiness, parseTaskReadinessDeclaration } from './task-readiness.js';
import { deepFreeze } from './transition-contract.js';

export const PARALLEL_SCAN_KIND = 'agenticloop.parallel-scan';
export const PARALLEL_SCAN_SCHEMA_VERSION = 1;
export const PARALLEL_SCAN_DIGEST_DOMAIN = 'agenticloop.parallel-scan.v1';
export const PARALLEL_SCAN_SEMANTIC_DIGEST_DOMAIN = 'agenticloop.parallel-scan-semantics.v1';
export const PARALLEL_SCAN_READINESS_DIGEST_DOMAIN = 'agenticloop.parallel-scan-readiness.v1';
export const PARALLEL_SCAN_COMMAND = 'parallel scan';

/**
 * The one canonical instant format for scan construction, record validation,
 * decomposition validation, and dispatch. Second precision, or exactly three
 * fractional digits, always UTC. Anything else - including one- or two-digit
 * fractions, offsets, and lowercase `z` - is not an instant this contract
 * accepts, so no layer can accept a timestamp another layer rejects.
 */
export const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * A timestamp beyond this allowance is a future observation, not clock jitter.
 * Evidence cannot be observed after the moment it is evaluated.
 */
export const PARALLEL_SCAN_CLOCK_SKEW_SECONDS = 5;

/**
 * The trusted maximum freshness policy. `Number.isSafeInteger` admits a policy
 * of a hundred million years, which is not a freshness policy at all; a scan
 * may not declare its observation valid for longer than this.
 */
export const PARALLEL_SCAN_MAX_FRESHNESS_SECONDS = 86_400;

/**
 * Parse a canonical instant.
 *
 * Total over arbitrary input: it returns a reason rather than throwing, and it
 * is the only place any layer of this contract decides whether a timestamp is
 * an instant.
 *
 * @param {unknown} value
 * @param {{ now?: number, skewSeconds?: number, futureAllowed?: boolean }} [options]
 * @returns {{ ok: boolean, epochMs: number|null, reason: string|null }}
 */
export function parseCanonicalInstant(value, options = {}) {
  const {
    now = Date.now(),
    skewSeconds = PARALLEL_SCAN_CLOCK_SKEW_SECONDS,
    futureAllowed = false,
  } = options;
  if (typeof value !== 'string' || !CANONICAL_INSTANT_PATTERN.test(value)) {
    return { ok: false, epochMs: null, reason: 'must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SS[.mmm]Z)' };
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    return { ok: false, epochMs: null, reason: 'is not a real calendar instant' };
  }
  // `Date.parse` normalizes some impossible or non-canonical values instead of
  // rejecting them (for example, 2025-02-29 becomes 2025-03-01 and 24:00
  // becomes midnight on the following day). Round-trip the parsed value into
  // this contract's exact textual form so normalization cannot turn malformed
  // wire evidence into an accepted instant.
  const rendered = new Date(epochMs).toISOString();
  const canonical = value.includes('.') ? rendered : rendered.replace('.000Z', 'Z');
  if (canonical !== value) {
    return { ok: false, epochMs: null, reason: 'is not a real canonical calendar instant' };
  }
  if (!futureAllowed && epochMs > now + skewSeconds * 1000) {
    return {
      ok: false,
      epochMs,
      reason: `is dated in the future beyond the ${skewSeconds}s clock-skew allowance`,
    };
  }
  return { ok: true, epochMs, reason: null };
}

/** Every reason a discovered inventory member can be excluded from the ready set. */
export const PARALLEL_SCAN_EXCLUSION_REASONS = Object.freeze([
  'record_unreadable',
  'record_malformed',
  'identity_ambiguous',
  'lifecycle_terminal',
  'dependency_unresolved',
  'not_ready',
]);

/** Every conclusion a scan can reach. */
export const PARALLEL_SCAN_CONCLUSIONS = Object.freeze([
  'parallel_candidates',
  'not_currently_eligible',
  'no_eligible_work',
  'incomplete',
]);

/** Every bound input whose change invalidates a scan. */
export const PARALLEL_SCAN_INVALIDATORS = Object.freeze([
  'inventory_membership',
  'inventory_enumeration_coverage',
  'task_carrier_digest',
  'base_inventory_identity',
  'dependency_status',
  'ownership_declaration',
  'knowledge_coupling',
  'decomposition_source_revision',
  'observation_freshness',
]);

// ---------------------------------------------------------------------------
// Typed enumeration receipt
//
// Inventory completeness is a claim about a backend surface nobody in this
// module can see. It is therefore never accepted as a caller boolean: the
// authoritative enumerator issues a typed receipt naming the backend, the
// inventory identity, its bounded coverage, and its pagination/completion
// evidence, and completeness is derived from that receipt.
// ---------------------------------------------------------------------------

export const TASK_INVENTORY_ENUMERATION_KIND = 'agenticloop.task-inventory-enumeration';
export const TASK_INVENTORY_ENUMERATION_SCHEMA_VERSION = 1;

/** The authoritative enumerator identity per backend. */
export const TASK_INVENTORY_ENUMERATORS = Object.freeze({
  files: 'agenticloop.files-task-directory.v1',
  github: 'agenticloop.github-task-issue-inventory.v1',
});

/** Every completion state an enumeration receipt can report. */
export const TASK_INVENTORY_COMPLETIONS = Object.freeze(['exhaustive', 'truncated', 'unknown']);

const ENUMERATION_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'backend', 'enumerator', 'inventoryId',
  'observedAt', 'coverage', 'completion',
]);
const ENUMERATION_COVERAGE_FIELDS = Object.freeze([
  'discovered', 'returned', 'pageCount', 'truncated', 'cursor',
]);

const MEMBER_STATES = Object.freeze(['readable', 'malformed', 'unreadable']);
const TERMINAL_STATUSES = Object.freeze(['done', 'closed', 'cancelled', 'accepted']);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PARALLEL_SCAN_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'workUnit', 'inventory', 'decomposition', 'readinessContext',
  'observedAt', 'freshnessPolicy', 'invalidatedBy', 'readyTaskIds', 'readyCount', 'excluded',
  'eligibility', 'pairs', 'candidatePairs', 'knowledgeCoupling', 'couplingBlockers',
  'conclusion', 'rescanTrigger', 'semanticDigest', 'digest',
]);
const INVENTORY_FIELDS = Object.freeze(['id', 'complete', 'enumeration', 'memberCount', 'members', 'digest']);
const INVENTORY_MEMBER_FIELDS = Object.freeze(['taskId', 'carrier', 'digest', 'revision', 'state', 'transport']);
const DECOMPOSITION_FIELDS = Object.freeze([
  'source', 'sourceRef', 'revision', 'attribution', 'declaredCompleteness', 'state',
]);
const READINESS_CONTEXT_FIELDS = Object.freeze(['base', 'dependencies', 'observation', 'digest']);
const READINESS_BASE_FIELDS = Object.freeze(['kind', 'identity', 'inventoryDigest', 'pathCount']);
// The dependency *identity*, not the moment some process happened to evaluate
// it. `evaluatedAt` is deliberately excluded: it changes on every read of the
// same snapshot, which would make an otherwise identical scan non-deterministic
// while proving nothing about the evidence.
const READINESS_DEPENDENCY_FIELDS = Object.freeze([
  'source', 'digest', 'observedAt', 'freshnessState', 'evaluatedState',
  'statusCount', 'statusDigest',
]);
const READINESS_OBSERVATION_FIELDS = Object.freeze(['observedAt', 'maxAgeSeconds']);
const EXCLUSION_FIELDS = Object.freeze([
  'taskId', 'reasonCode', 'evidenceState', 'evidenceRef', 'carrierDigest', 'detail',
]);
const PAIR_RELATIONS = Object.freeze(['blocked', 'unknown', 'disjoint', 'managed_join']);
const CANDIDATE_RELATIONS = new Set(['disjoint', 'managed_join']);
const BASE_EVIDENCE_KINDS = Object.freeze(['git_tree', 'path_inventory']);
const DEPENDENCY_FRESHNESS_STATES = Object.freeze(['current', 'stale', 'unknown']);
const DEPENDENCY_EVALUATED_STATES = Object.freeze(['satisfied', 'unsatisfied', 'indeterminate']);
// Diagnostic codes that mean the record itself could not be trusted as a task
// record. Those force inventory incompleteness; an ordinary unmet readiness
// condition does not.
const RECORD_INTEGRITY_CODES = new Set([
  'task.contract.malformed',
  'task.contract.absent',
  'task.record.structure',
  'task.body.bom',
  'task.body.utf8',
  'task.body.collapsed_newlines',
  'task.body.invalid',
  'task.body.identity',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const wanted = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== wanted.size || actual.some(key => !wanted.has(key))) {
    errors.push(`${label} fields must equal the closed schema`);
    return false;
  }
  return true;
}

/**
 * Require an explicit array. A wrong-typed collection is a schema violation,
 * never something to coerce into an empty list: coercion is exactly how a
 * `candidatePairs: {}` record re-digests as a valid scan with no candidates.
 */
function requireArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return null;
  }
  return value;
}

function contentDigest(text) {
  return `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

function safeRepositoryPath(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some(segment => segment === '.' || segment === '..');
}

function normalizedMember({ taskId, carrier, digest, revision, body, state, error, identitySource, transport }) {
  return {
    taskId,
    carrier,
    digest: digest ?? null,
    revision: revision ?? null,
    body: body ?? null,
    state,
    error: error ?? null,
    identitySource,
    transport: transport ?? null,
  };
}

function identityFromBody(body, carrier) {
  const parsed = parseFrontmatterStrict(String(body ?? ''));
  if (parsed.state !== 'valid') {
    return { taskId: carrier, identitySource: 'carrier', state: 'malformed', error: `task frontmatter is ${parsed.state}` };
  }
  const taskId = typeof parsed.data?.task_id === 'string' ? parsed.data.task_id.trim() : '';
  if (!taskId) {
    return { taskId: carrier, identitySource: 'carrier', state: 'malformed', error: 'task record declares no task_id' };
  }
  return { taskId, identitySource: 'frontmatter', state: 'readable', error: null };
}

/**
 * Build one typed enumeration receipt.
 *
 * Only the authoritative enumerator calls this: it is the artifact that proves
 * the bounded task surface was fully observed, so it names the enumerator, the
 * exact inventory identity, and the pagination evidence behind its claim.
 *
 * Schema v1 coverage semantics, retained unchanged and stated here so a reader
 * of a serialized receipt does not have to infer them:
 *
 * - `discovered` and `returned` are *producer-derived over the enumerator's own
 *   task surface*, not raw transport rows. The GitHub REST issues endpoint also
 *   returns pull requests; those are excluded at the surface boundary, so a
 *   response carrying two pull requests and one issue records
 *   `discovered: 1, returned: 1`, not `discovered: 3`. Reinterpreting these as
 *   raw-row counts would change the meaning of already-serialized v1 receipts
 *   and would require a schema version, so v1 keeps the producer-derived
 *   meaning.
 * - `pageCount` *is* the raw transport page count, so the raw transport shape
 *   and the normalized surface size stay independently visible.
 * - `truncated` is set only from evidence the transport itself supplies. A page
 *   shorter than the requested size is not such evidence: the API may return a
 *   short page at any position, so treating it as truncation would report
 *   complete inventories as incomplete.
 *
 * @param {{ backend: string, inventoryId: string, observedAt: string, discovered: number, returned: number, pageCount?: number, truncated?: boolean, cursor?: string|null, completion?: string }} input
 */
export function createTaskInventoryEnumeration(input = {}) {
  const {
    backend,
    inventoryId,
    observedAt,
    discovered,
    returned,
    pageCount = 1,
    truncated = false,
    cursor = null,
    completion = truncated === true ? 'truncated' : 'exhaustive',
  } = input;
  const receipt = {
    kind: TASK_INVENTORY_ENUMERATION_KIND,
    schemaVersion: TASK_INVENTORY_ENUMERATION_SCHEMA_VERSION,
    backend,
    enumerator: TASK_INVENTORY_ENUMERATORS[backend] ?? null,
    inventoryId,
    observedAt,
    coverage: { discovered, returned, pageCount, truncated, cursor },
    completion,
  };
  const check = validateTaskInventoryEnumeration(receipt, { backend, inventoryId });
  if (!check.ok) throw new TypeError(`invalid task inventory enumeration: ${check.errors.join('; ')}`);
  return deepFreeze(receipt);
}

/**
 * Validate a typed enumeration receipt against the surface it claims to cover.
 * Total over arbitrary JSON-compatible input.
 *
 * @param {unknown} value
 * @param {{ backend?: string, inventoryId?: string, memberCount?: number, now?: number }} [expected]
 * @returns {{ ok: boolean, errors: string[], receipt: any|null }}
 */
export function validateTaskInventoryEnumeration(value, expected = {}) {
  const errors = [];
  if (!exactKeys(value, ENUMERATION_FIELDS, 'task inventory enumeration', errors)) {
    return { ok: false, errors, receipt: null };
  }
  if (value.kind !== TASK_INVENTORY_ENUMERATION_KIND) {
    errors.push(`task inventory enumeration kind must be '${TASK_INVENTORY_ENUMERATION_KIND}'`);
  }
  if (value.schemaVersion !== TASK_INVENTORY_ENUMERATION_SCHEMA_VERSION) {
    errors.push(`task inventory enumeration schemaVersion must be ${TASK_INVENTORY_ENUMERATION_SCHEMA_VERSION}`);
  }
  if (!Object.hasOwn(TASK_INVENTORY_ENUMERATORS, value.backend)) {
    errors.push('task inventory enumeration backend must be files or github');
  } else if (value.enumerator !== TASK_INVENTORY_ENUMERATORS[value.backend]) {
    errors.push(`task inventory enumeration for '${value.backend}' must name enumerator '${TASK_INVENTORY_ENUMERATORS[value.backend]}'`);
  }
  if (typeof value.inventoryId !== 'string' || !value.inventoryId) {
    errors.push('task inventory enumeration inventoryId is required');
  }
  const observed = parseCanonicalInstant(value.observedAt, { now: expected.now ?? Date.now() });
  if (!observed.ok) errors.push(`task inventory enumeration observedAt ${observed.reason}`);
  if (!TASK_INVENTORY_COMPLETIONS.includes(value.completion)) {
    errors.push(`task inventory enumeration completion must be one of: ${TASK_INVENTORY_COMPLETIONS.join(', ')}`);
  }
  if (exactKeys(value.coverage, ENUMERATION_COVERAGE_FIELDS, 'task inventory enumeration coverage', errors)) {
    const { discovered, returned, pageCount, truncated, cursor } = value.coverage;
    for (const [key, count] of [['discovered', discovered], ['returned', returned], ['pageCount', pageCount]]) {
      if (!Number.isSafeInteger(count) || count < 0) {
        errors.push(`task inventory enumeration coverage ${key} must be a non-negative safe integer`);
      }
    }
    if (typeof truncated !== 'boolean') {
      errors.push('task inventory enumeration coverage truncated must be a boolean');
    }
    if (cursor !== null && (typeof cursor !== 'string' || !cursor)) {
      errors.push('task inventory enumeration coverage cursor must be null or a non-empty string');
    }
    if (Number.isSafeInteger(discovered) && Number.isSafeInteger(returned) && returned > discovered) {
      errors.push('task inventory enumeration returned more members than it discovered');
    }
    if (value.completion === 'exhaustive') {
      if (truncated === true) errors.push('a truncated enumeration cannot be exhaustive');
      if (cursor !== null) errors.push('an exhaustive enumeration cannot leave an unfollowed pagination cursor');
      if (Number.isSafeInteger(discovered) && Number.isSafeInteger(returned) && discovered !== returned) {
        errors.push('an exhaustive enumeration must return every member it discovered');
      }
      if (Number.isSafeInteger(pageCount) && pageCount < 1) {
        errors.push('an exhaustive enumeration must report at least one observed page');
      }
    }
    if (expected.memberCount !== undefined && Number.isSafeInteger(returned) && returned !== expected.memberCount) {
      errors.push(`task inventory enumeration returned ${returned} members but the inventory carries ${expected.memberCount}`);
    }
  }
  if (expected.backend !== undefined && value.backend !== expected.backend) {
    errors.push(`task inventory enumeration names backend '${String(value.backend)}' for a '${expected.backend}' inventory`);
  }
  if (expected.inventoryId !== undefined && value.inventoryId !== expected.inventoryId) {
    errors.push('task inventory enumeration inventoryId does not identify the enumerated surface');
  }
  if (errors.length > 0) return { ok: false, errors, receipt: null };
  return {
    ok: true,
    errors,
    receipt: {
      kind: value.kind,
      schemaVersion: value.schemaVersion,
      backend: value.backend,
      enumerator: value.enumerator,
      inventoryId: value.inventoryId,
      observedAt: value.observedAt,
      coverage: {
        discovered: value.coverage.discovered,
        returned: value.coverage.returned,
        pageCount: value.coverage.pageCount,
        truncated: value.coverage.truncated,
        cursor: value.coverage.cursor,
      },
      completion: value.completion,
    },
  };
}

/**
 * Derive inventory completeness.
 *
 * A caller's `complete` flag is necessary but never sufficient: it must be
 * exactly `true` (never `1`, `'yes'`, `{}`, or omitted) *and* be backed by an
 * exhaustive typed receipt from the authoritative enumerator for this exact
 * inventory identity.
 */
function deriveInventoryCompleteness({ declared, enumeration, backend, inventoryId, memberCount, errors, now }) {
  if (declared !== true) {
    errors.push('task inventory completeness must be declared as the exact boolean true');
  }
  const check = validateTaskInventoryEnumeration(enumeration, { backend, inventoryId, memberCount, now });
  if (!check.ok) {
    for (const error of check.errors) errors.push(error);
    return { complete: false, receipt: null };
  }
  if (check.receipt.completion !== 'exhaustive') {
    errors.push(`task inventory enumeration reports '${check.receipt.completion}' coverage and cannot prove a complete task surface`);
    return { complete: false, receipt: check.receipt };
  }
  return { complete: declared === true, receipt: check.receipt };
}

/**
 * Normalize a files-backed task surface into the shared scan inventory.
 *
 * A candidate record that cannot be read or parsed stays an inventory member
 * with error evidence. Dropping it would turn an unreadable task into an
 * invisible one, which is exactly the failure this contract exists to prevent.
 *
 * @param {{ inventoryId: string, entries: Array<{ carrier: string, content: string|null, readError?: string|null, revision?: string|null }>, complete?: unknown, enumeration?: unknown }} input
 * @param {{ now?: number }} [options]
 */
export function normalizeFilesTaskInventory(input = {}, options = {}) {
  const { inventoryId, entries = [], complete, enumeration = null } = input;
  const errors = [];
  const members = [];
  const id = String(inventoryId ?? '');
  if (!Array.isArray(entries)) {
    return {
      id,
      backend: 'files',
      complete: false,
      enumeration: null,
      members,
      errors: ['files inventory entries must be an array'],
    };
  }
  for (const entry of entries) {
    const carrier = String(entry?.carrier ?? '');
    if (!carrier) {
      errors.push('files inventory entry has no carrier path');
      continue;
    }
    if (entry?.readError || entry?.content === null || entry?.content === undefined) {
      members.push(normalizedMember({
        taskId: carrier, carrier, digest: null, revision: entry?.revision ?? null, body: null,
        state: 'unreadable', error: entry?.readError ?? 'task carrier could not be read', identitySource: 'carrier',
      }));
      errors.push(`task carrier '${carrier}' could not be read`);
      continue;
    }
    const identity = identityFromBody(entry.content, carrier);
    members.push(normalizedMember({
      taskId: identity.taskId,
      carrier,
      digest: contentDigest(entry.content),
      revision: entry?.revision ?? null,
      body: entry.content,
      state: identity.state,
      error: identity.error,
      identitySource: identity.identitySource,
    }));
    if (identity.state !== 'readable') errors.push(`task carrier '${carrier}': ${identity.error}`);
  }
  const completeness = deriveInventoryCompleteness({
    declared: complete,
    enumeration,
    backend: 'files',
    inventoryId: id,
    memberCount: members.length,
    errors,
    now: options.now,
  });
  return {
    id,
    backend: 'files',
    complete: completeness.complete,
    enumeration: completeness.receipt,
    members,
    errors,
  };
}

/**
 * Normalize a GitHub task inventory into the same shared scan inventory.
 *
 * Issue numbers, labels, and issue state travel as `transport` and never reach
 * the shared semantic digest. Truncation, duplicate identity, and identity
 * contradiction keep the existing repository-wide fail-closed behavior, and an
 * issue whose transport identity is itself invalid is retained as unreadable
 * inventory evidence rather than silently dropped: a discarded carrier is an
 * invisible task, which is the exact failure this contract prevents.
 *
 * @param {{ inventoryId: string, inventory: any, enumeration?: unknown }} input
 * @param {{ now?: number }} [options]
 */
export function normalizeGitHubTaskInventory(input = {}, options = {}) {
  const { inventoryId, inventory, enumeration = null } = input;
  const errors = [...(Array.isArray(inventory?.errors) ? inventory.errors : [])];
  const members = [];
  const id = String(inventoryId ?? '');
  const issues = Array.isArray(inventory?.issues) ? inventory.issues : [];
  if (!Array.isArray(inventory?.issues)) errors.push('GitHub task inventory issues must be an array');
  for (const [index, issue] of issues.entries()) {
    const number = Number(issue?.number);
    if (!Number.isInteger(number) || number <= 0) {
      // The issue exists on the surface; only its transport identity is
      // unreadable. Keeping it as a member preserves accounting and forces
      // completeness closed.
      const carrier = `issue:unreadable:${index}`;
      members.push(normalizedMember({
        taskId: carrier,
        carrier,
        digest: null,
        revision: null,
        body: null,
        state: 'unreadable',
        error: `GitHub issue at position ${index} has no valid issue identity`,
        identitySource: 'carrier',
      }));
      errors.push(`GitHub issue at position ${index} has no valid issue identity`);
      continue;
    }
    const carrier = `issue:${number}`;
    const identity = identityFromBody(issue?.body, carrier);
    members.push(normalizedMember({
      taskId: identity.taskId,
      carrier,
      digest: contentDigest(String(issue?.body ?? '')),
      revision: null,
      body: String(issue?.body ?? ''),
      state: identity.state,
      error: identity.error,
      identitySource: identity.identitySource,
      transport: {
        issueNumber: number,
        issueState: String(issue?.state ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open',
        labels: (Array.isArray(issue?.labels) ? issue.labels : [])
          .map(label => (typeof label === 'string' ? label : String(label?.name ?? '')))
          .filter(Boolean)
          .sort(),
      },
    }));
  }
  const duplicates = Array.isArray(inventory?.duplicates) ? inventory.duplicates.length : 0;
  const contradictions = Array.isArray(inventory?.contradictions) ? inventory.contradictions.length : 0;
  if (duplicates > 0) errors.push('GitHub task identity inventory reports duplicate task identities');
  if (contradictions > 0) errors.push('GitHub task identity inventory reports contradictory task identities');
  const completeness = deriveInventoryCompleteness({
    declared: inventory?.complete,
    enumeration,
    backend: 'github',
    inventoryId: id,
    memberCount: members.length,
    errors,
    now: options.now,
  });
  const complete = completeness.complete && duplicates === 0 && contradictions === 0;
  if (!complete && errors.length === 0) errors.push('GitHub task inventory is incomplete');
  return { id, backend: 'github', complete, enumeration: completeness.receipt, members, errors };
}

function diagnostic(level, code, evidence, message) {
  return createDiagnostic({ level, code, evidence, message });
}

function exclusionFor(member, reasonCode, evidenceState, detail) {
  return {
    taskId: member.taskId,
    reasonCode,
    evidenceState,
    evidenceRef: member.carrier,
    carrierDigest: member.digest,
    detail,
  };
}

function dependencyStatusDigest(statuses) {
  return `sha256:${PARALLEL_SCAN_READINESS_DIGEST_DOMAIN}:${canonicalSha256(
    [...statuses].map(item => ({ id: item.id, status: item.status }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  )}`;
}

function readinessContextDigest(context) {
  return `sha256:${PARALLEL_SCAN_READINESS_DIGEST_DOMAIN}:${safeCanonicalSha256({
    base: context.base,
    dependencies: context.dependencies,
    observation: context.observation,
  })}`;
}

/**
 * Bind the non-task-body inputs that decide the ready set.
 *
 * `basePaths` and a dependency-status map change which tasks are ready without
 * changing a single task carrier digest. Binding them here - through the same
 * base and dependency evidence contracts the readiness gate already uses, not
 * a second schema - makes that change visible as a scan-identity change and
 * gives `dependency_status` an exact evidence identity to invalidate.
 */
function bindReadinessContext(input, observation, errors) {
  const supplied = input?.readinessContext;
  if (!isPlainObject(supplied)) {
    errors.push('parallel scan requires a readinessContext binding its base and dependency evidence');
    return null;
  }
  const unknown = Object.keys(supplied).filter(key => !['base', 'dependencies'].includes(key));
  if (unknown.length > 0) {
    errors.push(`parallel scan readinessContext contains unknown fields: ${unknown.sort().join(', ')}`);
    return null;
  }
  let base;
  try {
    base = normalizeReadinessBaseEvidence(supplied.base);
  } catch (error) {
    errors.push(`parallel scan readinessContext base evidence is invalid: ${error.message}`);
    return null;
  }
  const basePaths = Array.isArray(input?.basePaths) ? input.basePaths : null;
  if (!basePaths || basePaths.some(path => typeof path !== 'string')) {
    errors.push('parallel scan basePaths must be an explicit array of strings');
    return null;
  }
  if (base.pathCount !== basePaths.length) {
    errors.push('parallel scan readinessContext base evidence pathCount does not match the scanned base inventory');
  }
  if (base.inventoryDigest !== contentDigest(canonicalJson([...basePaths].sort()))) {
    errors.push('parallel scan readinessContext base evidence inventoryDigest does not match the scanned base inventory');
  }

  const statusMap = input?.dependencies ?? {};
  if (!isPlainObject(statusMap)) {
    errors.push('parallel scan dependencies must be an explicit dependency-status object');
    return null;
  }
  let dependencies = null;
  if (supplied.dependencies === null || supplied.dependencies === undefined) {
    if (Object.keys(statusMap).length > 0) {
      errors.push('parallel scan evaluated dependency statuses without binding the dependency evidence they came from');
      return null;
    }
  } else {
    let evidence;
    try {
      evidence = normalizeReadinessDependencyEvidence(supplied.dependencies);
    } catch (error) {
      errors.push(`parallel scan readinessContext dependency evidence is invalid: ${error.message}`);
      return null;
    }
    const boundMap = dependencyStatusMap(evidence);
    const flatten = map => canonicalJson(Object.entries(map).map(([id, status]) => `${id}=${String(status)}`).sort());
    if (flatten(boundMap) !== flatten(statusMap)) {
      errors.push('parallel scan readinessContext dependency evidence does not match the dependency statuses the scan evaluated');
    }
    dependencies = {
      source: evidence.source,
      digest: evidence.digest,
      observedAt: evidence.observedAt,
      freshnessState: evidence.freshnessState,
      evaluatedState: evidence.evaluatedState,
      statusCount: evidence.statuses.length,
      statusDigest: dependencyStatusDigest(evidence.statuses),
    };
    if (evidence.freshnessState !== 'current') {
      errors.push(`parallel scan readinessContext dependency evidence is ${evidence.freshnessState} and cannot support a current ready set`);
    }
  }

  const context = {
    base: {
      kind: base.kind,
      identity: base.identity,
      inventoryDigest: base.inventoryDigest,
      pathCount: base.pathCount,
    },
    dependencies,
    observation,
    digest: null,
  };
  context.digest = readinessContextDigest(context);
  return context;
}

/**
 * Evaluate one bounded work unit's parallel scan.
 *
 * Returns the durable record even when the scan is incomplete: a scan that
 * cannot prove completeness must still say so explicitly rather than return
 * nothing (which a caller could read as "no work"). It never returns `ok` for
 * a record `validateParallelScanRecord` would reject.
 *
 * @param {any} input
 * @param {{ now?: number }} [options]
 */
export function evaluateParallelScan(input = {}, options = {}) {
  const now = options.now ?? Date.now();
  const diagnostics = [];
  const warnings = [];
  const push = (code, state, message) => diagnostics.push(diagnostic('error', code, { state }, message));

  const workUnitId = String(input?.workUnit?.id ?? '');
  const backend = String(input?.workUnit?.backend ?? '');
  if (!workUnitId) push('parallel_scan.record.invalid', 'malformed', 'parallel scan requires an exact bounded work-unit identity');
  if (!['files', 'github'].includes(backend)) push('parallel_scan.record.invalid', 'malformed', 'parallel scan backend must be files or github');

  const inventory = input?.inventory;
  if (!isPlainObject(inventory) || !Array.isArray(inventory.members)) {
    push('parallel_scan.inventory.incomplete', 'missing', 'parallel scan requires a normalized task inventory');
    return finish({ diagnostics, warnings, record: null });
  }
  if (inventory.backend && backend && inventory.backend !== backend) {
    push('parallel_scan.record.invalid', 'malformed', 'inventory backend does not match the scanned work unit backend');
  }

  const decomposition = isPlainObject(input?.decomposition) ? input.decomposition : {};
  if (decomposition.attribution !== 'maintainer' || decomposition.source !== 'task-decomposition') {
    push('parallel_scan.decomposition.invalid', 'malformed',
      'decomposition provenance must name the canonical maintainer task-decomposition authority');
  }
  if (!safeRepositoryPath(decomposition.sourceRef)) {
    push('parallel_scan.decomposition.invalid', 'malformed',
      'decomposition sourceRef must be a safe repository-relative path');
  }
  if (typeof decomposition.revision !== 'string' || !decomposition.revision) {
    push('parallel_scan.decomposition.invalid', 'malformed',
      'decomposition provenance requires an exact source revision');
  }
  if (!['complete', 'incomplete'].includes(decomposition.declaredCompleteness)) {
    push('parallel_scan.decomposition.invalid', 'malformed', 'decomposition declaredCompleteness is invalid');
  }

  const observedAt = input?.observedAt;
  const maxAgeSeconds = input?.freshnessPolicy?.maxAgeSeconds;
  const instant = parseCanonicalInstant(observedAt, { now });
  let fresh = true;
  if (!instant.ok) {
    push('parallel_scan.record.invalid', 'malformed', `parallel scan observedAt ${instant.reason}`);
    fresh = false;
  }
  if (isPlainObject(inventory.enumeration) && inventory.enumeration.observedAt !== observedAt) {
    push('parallel_scan.record.invalid', 'malformed',
      'parallel scan observedAt must equal its authoritative inventory enumeration observation time');
    fresh = false;
  }
  if (!validFreshnessPolicy(maxAgeSeconds)) {
    push('parallel_scan.record.invalid', 'malformed',
      `parallel scan freshnessPolicy maxAgeSeconds must be an integer between 1 and ${PARALLEL_SCAN_MAX_FRESHNESS_SECONDS}`);
    fresh = false;
  } else if (instant.ok && now - instant.epochMs > maxAgeSeconds * 1000) {
    diagnostics.push(diagnostic('error', 'parallel_scan.evidence.stale', { state: 'stale' },
      'parallel scan observation is outside its declared freshness policy'));
    fresh = false;
  }

  const rescanTrigger = typeof input?.rescanTrigger === 'string' && input.rescanTrigger.trim()
    ? input.rescanTrigger.trim()
    : '';
  if (!rescanTrigger) push('parallel_scan.record.invalid', 'malformed', 'parallel scan requires a concrete rescan trigger');

  const readinessErrors = [];
  const readinessContext = bindReadinessContext(input, {
    observedAt: instant.ok ? observedAt : null,
    maxAgeSeconds: validFreshnessPolicy(maxAgeSeconds) ? maxAgeSeconds : null,
  }, readinessErrors);
  for (const error of readinessErrors) {
    push('parallel_scan.record.invalid', 'malformed', error);
  }

  if (inventory.complete !== true) {
    diagnostics.push(diagnostic('error', 'parallel_scan.inventory.incomplete', { state: 'negative' },
      'the normalized task inventory is not proven complete by its authoritative enumeration receipt'));
  }
  for (const error of Array.isArray(inventory.errors) ? inventory.errors : []) {
    diagnostics.push(diagnostic('error', 'parallel_scan.inventory.incomplete', { state: 'negative' }, String(error)));
  }

  // Set-like member ordering is canonicalized before anything derives from it,
  // so a shuffled listing cannot produce a different scan identity.
  const members = [...inventory.members]
    .map(member => normalizedMember(member ?? {}))
    .sort((left, right) => (`${left.taskId}\u0000${left.carrier}` < `${right.taskId}\u0000${right.carrier}` ? -1 : 1));
  for (const member of members) {
    if (!MEMBER_STATES.includes(member.state)) {
      push('parallel_scan.record.invalid', 'malformed', `inventory member '${member.carrier}' has an unknown state`);
    }
  }

  const duplicated = new Set();
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.taskId)) duplicated.add(member.taskId);
    seen.add(member.taskId);
  }
  for (const taskId of [...duplicated].sort()) {
    diagnostics.push(diagnostic('error', 'parallel_scan.inventory.incomplete', { state: 'negative' },
      `task identity '${taskId}' is carried by more than one inventory member; identity must be unique within the work unit`));
  }

  const excluded = [];
  const readyTasks = [];
  let recordIntegrityFailure = false;

  for (const member of members) {
    if (duplicated.has(member.taskId)) {
      excluded.push(exclusionFor(member, 'identity_ambiguous', 'malformed', 'task identity is not unique within the bounded work unit'));
      recordIntegrityFailure = true;
      continue;
    }
    if (member.state === 'unreadable') {
      excluded.push(exclusionFor(member, 'record_unreadable', 'missing', member.error ?? 'task carrier could not be read'));
      recordIntegrityFailure = true;
      continue;
    }
    if (member.state === 'malformed') {
      excluded.push(exclusionFor(member, 'record_malformed', 'malformed', member.error ?? 'task record is malformed'));
      recordIntegrityFailure = true;
      continue;
    }
    const parsed = parseFrontmatterStrict(member.body);
    const status = String(parsed.data?.status ?? '').trim().toLowerCase();
    if (TERMINAL_STATUSES.includes(status)) {
      excluded.push(exclusionFor(member, 'lifecycle_terminal', 'negative', `task lifecycle status is '${status}'`));
      continue;
    }
    const readiness = evaluateTaskReadiness({
      taskBody: member.body,
      basePaths: Array.isArray(input?.basePaths) ? input.basePaths : [],
      mode: 'authoring',
      dependencies: isPlainObject(input?.dependencies) ? input.dependencies : {},
    });
    if (!readiness.ok) {
      const codes = new Set(readiness.diagnostics.filter(item => item.level === 'error').map(item => item.code));
      if ([...codes].some(code => RECORD_INTEGRITY_CODES.has(code))) {
        excluded.push(exclusionFor(member, 'record_malformed', 'malformed', readiness.errors[0] ?? 'task record is malformed'));
        recordIntegrityFailure = true;
        continue;
      }
      const reasonCode = codes.has('dependency.unresolved') ? 'dependency_unresolved' : 'not_ready';
      excluded.push(exclusionFor(member, reasonCode, 'negative', readiness.errors[0] ?? 'task is not ready'));
      continue;
    }
    const declaration = parseOwnershipDeclaration(member.body);
    const dependsOn = parseTaskReadinessDeclaration(member.body).declaration?.dependsOn ?? [];
    readyTasks.push({ member, declaration, dependsOn });
  }

  const readyTaskIds = readyTasks.map(item => item.member.taskId).sort();
  const eligibility = readyTasks
    .map(item => ({ taskId: item.member.taskId, eligibility: evaluateTaskEligibility(item.declaration) }))
    .sort((left, right) => (left.taskId < right.taskId ? -1 : 1));
  const knowledgeCoupling = readyTasks
    .map(item => ({ taskId: item.member.taskId, classification: item.declaration?.knowledgeCoupling ?? 'unknown' }))
    .sort((left, right) => (left.taskId < right.taskId ? -1 : 1));
  const couplingBlockers = knowledgeCoupling
    .filter(item => item.classification !== 'independent')
    .map(item => ({
      taskId: item.taskId,
      classification: item.classification,
      // `coupled` uses the existing two-wave rule; `unknown` stays non-eligible
      // once the single bounded discovery pass has been spent.
      blocker: item.classification === 'coupled'
        ? 'knowledge coupling requires the two-wave pattern before parallel implementation writes'
        : 'knowledge independence is unresolved after the bounded discovery allowance',
    }));

  const ordered = [...readyTasks].sort((left, right) => (left.member.taskId < right.member.taskId ? -1 : 1));
  const pairs = [];
  const candidatePairs = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const left = laneFor(ordered[i], input);
      const right = laneFor(ordered[j], input);
      const plan = input?.joinPlans?.[`${left.taskId}|${right.taskId}`] ?? null;
      const classified = classifyParallelPair(left, right, plan);
      pairs.push({ left: left.taskId, right: right.taskId, relation: classified.relation, reason: classified.reason });
      if (CANDIDATE_RELATIONS.has(classified.relation)) {
        candidatePairs.push([left.taskId, right.taskId]);
      }
    }
  }

  const structurallyValid = diagnostics.every(item => item.code === 'parallel_scan.inventory.incomplete' ||
    item.code === 'parallel_scan.evidence.stale');
  const inventoryComplete = inventory.complete === true && !recordIntegrityFailure &&
    (Array.isArray(inventory.errors) ? inventory.errors.length : 1) === 0 && duplicated.size === 0;
  const decompositionState = decomposition.declaredCompleteness === 'incomplete' || !inventoryComplete
    ? 'incomplete'
    : 'complete';
  const complete = inventoryComplete && decompositionState === 'complete' && fresh && structurallyValid;

  if (recordIntegrityFailure) {
    diagnostics.push(diagnostic('error', 'parallel_scan.inventory.incomplete', { state: 'negative' },
      'the inventory contains unreadable, malformed, or ambiguous task records; completeness fails closed'));
  }
  if (decomposition.declaredCompleteness === 'incomplete') {
    diagnostics.push(diagnostic('error', 'parallel_scan.decomposition.invalid', { state: 'negative' },
      'the decomposition source declares itself incomplete'));
  }

  let conclusion;
  if (!complete) conclusion = 'incomplete';
  else if (readyTaskIds.length === 0) conclusion = 'no_eligible_work';
  else if (readyTaskIds.length < 2 || candidatePairs.length === 0) conclusion = 'not_currently_eligible';
  else conclusion = 'parallel_candidates';

  const record = {
    kind: PARALLEL_SCAN_KIND,
    schemaVersion: PARALLEL_SCAN_SCHEMA_VERSION,
    workUnit: { id: workUnitId, backend },
    inventory: {
      id: String(inventory.id ?? ''),
      complete: inventoryComplete,
      enumeration: inventory.enumeration ?? null,
      memberCount: members.length,
      members: members.map(member => ({
        taskId: member.taskId,
        carrier: member.carrier,
        digest: member.digest,
        revision: member.revision,
        state: member.state,
        transport: member.transport,
      })),
      digest: null,
    },
    decomposition: {
      source: decomposition.source ?? null,
      sourceRef: decomposition.sourceRef ?? null,
      revision: decomposition.revision ?? null,
      attribution: decomposition.attribution ?? null,
      declaredCompleteness: decomposition.declaredCompleteness ?? null,
      state: decompositionState,
    },
    readinessContext,
    observedAt: instant.ok ? observedAt : null,
    freshnessPolicy: { maxAgeSeconds: validFreshnessPolicy(maxAgeSeconds) ? maxAgeSeconds : null },
    invalidatedBy: [...PARALLEL_SCAN_INVALIDATORS],
    readyTaskIds,
    readyCount: readyTaskIds.length,
    excluded: excluded.sort((left, right) => (`${left.taskId}\u0000${left.evidenceRef}` < `${right.taskId}\u0000${right.evidenceRef}` ? -1 : 1)),
    eligibility,
    pairs,
    candidatePairs,
    knowledgeCoupling,
    couplingBlockers,
    conclusion,
    rescanTrigger,
    semanticDigest: null,
    digest: null,
  };
  record.inventory.digest = inventoryDigest(record.inventory);
  record.semanticDigest = `sha256:${PARALLEL_SCAN_SEMANTIC_DIGEST_DOMAIN}:${safeCanonicalSha256(semanticProjection(record))}`;
  record.digest = `sha256:${PARALLEL_SCAN_DIGEST_DOMAIN}:${safeCanonicalSha256(digestProjection(record))}`;

  // Producer/validator parity. Whatever the construction path believed, the
  // emitted record is held to the exact contract its consumers apply; a record
  // this validator would reject is never returned as a successful scan.
  const emitted = validateParallelScanRecord(record, { now });
  if (!emitted.ok) {
    for (const error of emitted.errors) {
      if (!diagnostics.some(item => item.message === error)) {
        push('parallel_scan.record.invalid', 'malformed', error);
      }
    }
  }

  return finish({ diagnostics, warnings, record });
}

function validFreshnessPolicy(maxAgeSeconds) {
  return Number.isSafeInteger(maxAgeSeconds) &&
    maxAgeSeconds > 0 &&
    maxAgeSeconds <= PARALLEL_SCAN_MAX_FRESHNESS_SECONDS;
}

/**
 * Build the lane shape `classifyParallelPair` already consumes.
 *
 * A managed join is only valid against exact lane base/head artifacts, so a
 * scan run before those bindings exist reaches `unknown` through the existing
 * rule rather than a scan-local relaxation of it.
 */
function laneFor(entry, input) {
  const taskId = entry.member.taskId;
  const artifact = input?.laneArtifacts?.[taskId] ?? null;
  return {
    taskId,
    declaration: entry.declaration,
    dependsOn: entry.dependsOn,
    ...(artifact ? { artifact } : {}),
  };
}

/**
 * The membership identity of an inventory.
 *
 * The enumeration receipt is deliberately outside this domain: it carries the
 * observation time and pagination state of one particular enumeration run, so
 * including it would make every authoritative refetch differ from the bound
 * scan even when the task surface is byte-identical. The receipt is still
 * bound - it lives in the record and is covered by the record digest - and the
 * refetch compares receipts on their durable fields instead.
 */
function inventoryDigest(inventory) {
  return `sha256:${PARALLEL_SCAN_DIGEST_DOMAIN}:${safeCanonicalSha256({
    id: inventory.id,
    complete: inventory.complete,
    members: (Array.isArray(inventory.members) ? inventory.members : []).map(member => ({
      taskId: member?.taskId ?? null,
      carrier: member?.carrier ?? null,
      digest: member?.digest ?? null,
      revision: member?.revision ?? null,
      state: member?.state ?? null,
    })),
  })}`;
}

function inventorySnapshot(inventory) {
  const members = [...(Array.isArray(inventory?.members) ? inventory.members : [])]
    .map(member => normalizedMember(member ?? {}))
    .sort((left, right) => (`${left.taskId}\u0000${left.carrier}` < `${right.taskId}\u0000${right.carrier}` ? -1 : 1))
    .map(member => ({
      taskId: member.taskId,
      carrier: member.carrier,
      digest: member.digest,
      revision: member.revision,
      state: member.state,
      transport: member.transport,
    }));
  const identities = members.map(member => member.taskId);
  const complete = inventory?.complete === true &&
    (Array.isArray(inventory?.errors) ? inventory.errors.length : 1) === 0 &&
    new Set(identities).size === identities.length &&
    members.every(member => member.state === 'readable');
  const snapshot = {
    id: String(inventory?.id ?? ''),
    backend: String(inventory?.backend ?? ''),
    complete,
    enumeration: inventory?.enumeration ?? null,
    memberCount: members.length,
    members,
    digest: null,
  };
  snapshot.digest = inventoryDigest(snapshot);
  return snapshot;
}

/**
 * Compare a durable scan with a freshly enumerated authoritative backend
 * inventory. The current inventory is never taken from the authored
 * decomposition source, so omitted/new carriers and changed task bodies make
 * the scan stale before dispatch.
 */
export function validateParallelScanInventoryBinding(record, currentInventory) {
  const errors = [];
  if (!isPlainObject(record?.inventory) || !isPlainObject(record?.workUnit)) {
    return { ok: false, errors: ['parallel scan has no valid inventory binding'] };
  }
  if (!isPlainObject(currentInventory)) {
    return { ok: false, errors: ['authoritative parallel-scan inventory refetch did not return an object'] };
  }
  const current = inventorySnapshot(currentInventory);
  if (current.backend !== record.workUnit.backend) {
    errors.push('authoritative parallel-scan inventory backend does not match the scan work unit');
  }
  if (current.id !== record.inventory.id) {
    errors.push('authoritative parallel-scan inventory identity does not match the bound scan');
  }
  if (!current.complete) {
    errors.push('authoritative parallel-scan inventory refetch is incomplete');
  }
  if (current.memberCount !== record.inventory.memberCount || current.digest !== record.inventory.digest) {
    errors.push('authoritative parallel-scan inventory membership or task carrier digest changed after the scan');
  }
  // The refetch must itself be an exhaustive observation by the authoritative
  // enumerator for this exact surface; a truncated or untyped refetch proves
  // nothing about what is on the backend now.
  const enumeration = validateTaskInventoryEnumeration(current.enumeration, {
    backend: record.workUnit.backend,
    inventoryId: record.inventory.id,
    memberCount: current.memberCount,
  });
  if (!enumeration.ok) {
    errors.push('authoritative parallel-scan inventory refetch carries no valid enumeration receipt');
  } else if (enumeration.receipt.completion !== 'exhaustive') {
    errors.push('authoritative parallel-scan inventory refetch was not an exhaustive enumeration');
  } else if (record.inventory.enumeration &&
      enumeration.receipt.enumerator !== record.inventory.enumeration.enumerator) {
    errors.push('authoritative parallel-scan inventory refetch used a different enumerator than the bound scan');
  }
  return { ok: errors.length === 0, errors, inventory: current };
}

/**
 * Revalidate the readiness context the scan's whole ready set was derived from.
 *
 * The bound base inventory and dependency snapshot are work-unit-wide inputs:
 * a change to either can flip readiness for any ready task while every task
 * carrier digest stays byte-identical. Dispatch therefore refetches them and
 * compares the exact bound identities, not only the dispatched task's record.
 *
 * @param {any} record
 * @param {{ base?: any, dependencies?: any }} current  Freshly refetched base and
 *   dependency evidence, in the canonical readiness-evidence shapes.
 */
export function validateParallelScanReadinessBinding(record, current) {
  const bound = record?.readinessContext;
  if (!isPlainObject(bound)) {
    return { ok: false, errors: ['parallel scan has no bound readiness context to revalidate'] };
  }
  if (!isPlainObject(current)) {
    return { ok: false, errors: ['authoritative parallel-scan readiness refetch did not return an object'] };
  }
  const errors = [];
  let base;
  try {
    base = normalizeReadinessBaseEvidence(current.base);
  } catch (error) {
    return { ok: false, errors: [`authoritative parallel-scan base evidence is invalid: ${error.message}`] };
  }
  if (base.identity !== bound.base?.identity ||
      base.inventoryDigest !== bound.base?.inventoryDigest ||
      base.pathCount !== bound.base?.pathCount ||
      base.kind !== bound.base?.kind) {
    errors.push('authoritative base evidence changed after the scan; the bound ready set is stale');
  }

  const suppliedDependencies = current.dependencies ?? null;
  if (suppliedDependencies === null) {
    if (bound.dependencies !== null) {
      errors.push('the scan bound dependency evidence that the authoritative refetch no longer reports');
    }
  } else {
    let evidence;
    try {
      evidence = normalizeReadinessDependencyEvidence(suppliedDependencies);
    } catch (error) {
      return { ok: false, errors: [`authoritative parallel-scan dependency evidence is invalid: ${error.message}`] };
    }
    if (bound.dependencies === null) {
      errors.push('the authoritative refetch reports dependency evidence the scan never bound');
    } else if (
      evidence.source !== bound.dependencies.source ||
      evidence.digest !== bound.dependencies.digest ||
      evidence.observedAt !== bound.dependencies.observedAt ||
      evidence.freshnessState !== bound.dependencies.freshnessState ||
      evidence.evaluatedState !== bound.dependencies.evaluatedState ||
      evidence.statuses.length !== bound.dependencies.statusCount ||
      dependencyStatusDigest(evidence.statuses) !== bound.dependencies.statusDigest
    ) {
      errors.push('authoritative dependency status evidence changed after the scan; the bound ready set is stale');
    }
  }
  return { ok: errors.length === 0, errors };
}

function digestProjection(record) {
  const { digest, semanticDigest, ...rest } = record;
  return rest;
}

/**
 * The backend-neutral projection. Transport identity (issue numbers, labels,
 * issue state) and backend-specific carrier paths are excluded, so files and
 * GitHub reach one shared semantic verdict over the same normalized tasks.
 */
function semanticProjection(record) {
  return {
    workUnitId: record.workUnit?.id ?? null,
    readyTaskIds: record.readyTaskIds,
    readyCount: record.readyCount,
    excluded: (Array.isArray(record.excluded) ? record.excluded : [])
      .map(item => ({ taskId: item?.taskId ?? null, reasonCode: item?.reasonCode ?? null, evidenceState: item?.evidenceState ?? null })),
    eligibility: record.eligibility,
    knowledgeCoupling: record.knowledgeCoupling,
    couplingBlockers: record.couplingBlockers,
    pairs: record.pairs,
    candidatePairs: record.candidatePairs,
    inventoryComplete: record.inventory?.complete ?? null,
    decompositionState: record.decomposition?.state ?? null,
    readinessContextDigest: record.readinessContext?.digest ?? null,
    conclusion: record.conclusion,
  };
}

/**
 * Re-derive every internal invariant of a durable scan record.
 *
 * This is what a consumer runs on evidence it did not produce: digests, exact
 * accounting, the bound readiness context, and the completeness/conclusion
 * relationship. It cannot re-run readiness (the record carries digests, not
 * bodies), so a forged record still has to be internally consistent,
 * digest-bound, and carried by the committed, Maintainer-attributed source the
 * dispatch boundary verifies separately.
 *
 * Total over arbitrary JSON-compatible input: it returns errors, never throws.
 *
 * @param {unknown} record
 * @param {{ now?: number }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateParallelScanRecord(record, options = {}) {
  try {
    return validateParallelScanRecordInner(record, options);
  } catch (error) {
    return { ok: false, errors: [`parallel scan record could not be validated: ${error.message}`] };
  }
}

function validateParallelScanRecordInner(record, options) {
  const now = options?.now ?? Date.now();
  const errors = [];
  if (!isPlainObject(record)) return { ok: false, errors: ['parallel scan record must be an object'] };
  exactKeys(record, PARALLEL_SCAN_FIELDS, 'parallel scan record', errors);
  if (record.kind !== PARALLEL_SCAN_KIND) errors.push(`parallel scan kind must be '${PARALLEL_SCAN_KIND}'`);
  if (record.schemaVersion !== PARALLEL_SCAN_SCHEMA_VERSION) {
    errors.push(`parallel scan schemaVersion must be ${PARALLEL_SCAN_SCHEMA_VERSION}`);
  }
  if (!PARALLEL_SCAN_CONCLUSIONS.includes(record.conclusion)) errors.push('parallel scan conclusion is invalid');

  exactKeys(record.workUnit, ['id', 'backend'], 'parallel scan workUnit', errors);
  if (typeof record.workUnit?.id !== 'string' || !record.workUnit.id) errors.push('parallel scan workUnit id is required');
  if (!['files', 'github'].includes(record.workUnit?.backend)) errors.push('parallel scan workUnit backend is invalid');

  if (!isPlainObject(record.inventory)) {
    return { ok: false, errors: [...errors, 'parallel scan inventory is invalid'] };
  }
  exactKeys(record.inventory, INVENTORY_FIELDS, 'parallel scan inventory', errors);
  const inventoryMembers = requireArray(record.inventory.members, 'parallel scan inventory members', errors);
  if (!inventoryMembers) return { ok: false, errors };
  if (typeof record.inventory.id !== 'string' || !record.inventory.id) errors.push('parallel scan inventory id is required');
  if (typeof record.inventory.complete !== 'boolean') errors.push('parallel scan inventory complete must be boolean');
  if (record.inventory.memberCount !== inventoryMembers.length) {
    errors.push('parallel scan inventory memberCount does not match its member list');
  }
  // Completeness is only ever true with an exhaustive typed receipt from the
  // authoritative enumerator; an inventory that asserts it without one is
  // exactly the caller-authored completeness this contract forbids.
  if (record.inventory.enumeration === null) {
    if (record.inventory.complete === true) {
      errors.push('a complete parallel-scan inventory requires a typed authoritative enumeration receipt');
    }
  } else {
    const enumeration = validateTaskInventoryEnumeration(record.inventory.enumeration, {
      backend: record.workUnit?.backend,
      inventoryId: record.inventory.id,
      memberCount: inventoryMembers.length,
      now,
    });
    if (!enumeration.ok) {
      for (const error of enumeration.errors) errors.push(`parallel scan inventory enumeration: ${error}`);
    } else if (record.inventory.complete === true && enumeration.receipt.completion !== 'exhaustive') {
      errors.push('a complete parallel-scan inventory requires an exhaustive enumeration receipt');
    } else if (enumeration.receipt.observedAt !== record.observedAt) {
      errors.push('parallel scan observedAt must equal its authoritative inventory enumeration observation time');
    }
  }
  for (const member of inventoryMembers) {
    exactKeys(member, INVENTORY_MEMBER_FIELDS, 'parallel scan inventory member', errors);
    if (typeof member?.taskId !== 'string' || !member.taskId) errors.push('inventory member taskId is required');
    if (typeof member?.carrier !== 'string' || !member.carrier) errors.push('inventory member carrier is required');
    if (member?.digest !== null && !SHA256.test(String(member?.digest ?? ''))) {
      errors.push(`inventory member '${member?.taskId}' digest must be null or sha256:<64 lowercase hex>`);
    }
    if (!MEMBER_STATES.includes(member?.state)) errors.push(`inventory member '${member?.taskId}' state is invalid`);
    if (member?.state !== 'unreadable' && member?.digest === null) {
      errors.push(`inventory member '${member?.taskId}' must carry a digest`);
    }
    if (member?.revision !== null && (typeof member?.revision !== 'string' || !member.revision)) {
      errors.push(`inventory member '${member?.taskId}' revision must be null or a non-empty string`);
    }
    if (record.workUnit?.backend === 'files' && member?.transport !== null) {
      errors.push(`files inventory member '${member?.taskId}' must not carry transport fields`);
    }
    if (record.workUnit?.backend === 'github' && member?.transport !== null) {
      if (exactKeys(member?.transport, ['issueNumber', 'issueState', 'labels'], `GitHub inventory member '${member?.taskId}' transport`, errors)) {
        if (!Number.isSafeInteger(member.transport.issueNumber) || member.transport.issueNumber <= 0) {
          errors.push(`GitHub inventory member '${member.taskId}' issueNumber is invalid`);
        }
        if (!['open', 'closed'].includes(member.transport.issueState)) {
          errors.push(`GitHub inventory member '${member.taskId}' issueState is invalid`);
        }
        if (!Array.isArray(member.transport.labels) || member.transport.labels.some(label => typeof label !== 'string' || !label)) {
          errors.push(`GitHub inventory member '${member.taskId}' labels are invalid`);
        }
      }
    }
    if (record.workUnit?.backend === 'github' && member?.transport === null && member?.state !== 'unreadable') {
      errors.push(`GitHub inventory member '${member?.taskId}' must carry its transport identity`);
    }
  }
  if (record.inventory.digest !== inventoryDigest(record.inventory)) {
    errors.push('parallel scan inventory digest does not match its exact member set');
  }

  exactKeys(record.decomposition, DECOMPOSITION_FIELDS, 'parallel scan decomposition', errors);
  if (record.decomposition?.source !== 'task-decomposition' || record.decomposition?.attribution !== 'maintainer') {
    errors.push('parallel scan decomposition authority is invalid');
  }
  if (!safeRepositoryPath(record.decomposition?.sourceRef)) errors.push('parallel scan decomposition sourceRef is invalid');
  if (typeof record.decomposition?.revision !== 'string' || !record.decomposition.revision) {
    errors.push('parallel scan decomposition revision is required');
  }
  if (!['complete', 'incomplete'].includes(record.decomposition?.declaredCompleteness) ||
      !['complete', 'incomplete'].includes(record.decomposition?.state)) {
    errors.push('parallel scan decomposition completeness is invalid');
  }

  validateReadinessContextShape(record, errors);

  exactKeys(record.freshnessPolicy, ['maxAgeSeconds'], 'parallel scan freshnessPolicy', errors);
  const observed = parseCanonicalInstant(record.observedAt, { now });
  if (!observed.ok) errors.push(`parallel scan observedAt ${observed.reason}`);
  if (!validFreshnessPolicy(record.freshnessPolicy?.maxAgeSeconds)) {
    errors.push(`parallel scan freshnessPolicy maxAgeSeconds must be an integer between 1 and ${PARALLEL_SCAN_MAX_FRESHNESS_SECONDS}`);
  }
  const invalidatedBy = requireArray(record.invalidatedBy, 'parallel scan invalidatedBy', errors);
  if (invalidatedBy && (invalidatedBy.length !== PARALLEL_SCAN_INVALIDATORS.length ||
      invalidatedBy.some((value, index) => value !== PARALLEL_SCAN_INVALIDATORS[index]))) {
    errors.push('parallel scan invalidatedBy must equal the canonical invalidator inventory');
  }

  const ready = requireArray(record.readyTaskIds, 'parallel scan readyTaskIds', errors);
  const excluded = requireArray(record.excluded, 'parallel scan excluded', errors);
  if (!ready || !excluded) return { ok: false, errors };
  if (record.readyCount !== ready.length) errors.push('parallel scan readyCount does not match its ready set');
  if (new Set(ready).size !== ready.length || ready.some((taskId, index) => typeof taskId !== 'string' || !taskId || (index > 0 && ready[index - 1] >= taskId))) {
    errors.push('parallel scan readyTaskIds must be unique non-empty strings in canonical order');
  }
  for (const exclusion of excluded) {
    exactKeys(exclusion, EXCLUSION_FIELDS, `parallel scan exclusion '${exclusion?.taskId}'`, errors);
    if (typeof exclusion?.taskId !== 'string' || !exclusion.taskId) errors.push('parallel scan exclusion taskId is required');
    if (!PARALLEL_SCAN_EXCLUSION_REASONS.includes(exclusion?.reasonCode)) {
      errors.push(`exclusion of '${exclusion?.taskId}' uses an unknown reason code`);
    }
    if (typeof exclusion?.evidenceRef !== 'string' || !exclusion.evidenceRef) {
      errors.push(`exclusion of '${exclusion?.taskId}' has no evidence reference`);
    }
    if (!['missing', 'malformed', 'negative'].includes(exclusion?.evidenceState)) {
      errors.push(`exclusion of '${exclusion?.taskId}' has an invalid evidence state`);
    }
    if (exclusion?.carrierDigest !== null && !SHA256.test(String(exclusion?.carrierDigest ?? ''))) {
      errors.push(`exclusion of '${exclusion?.taskId}' carrierDigest is invalid`);
    }
    if (typeof exclusion?.detail !== 'string' || !exclusion.detail) {
      errors.push(`exclusion of '${exclusion?.taskId}' detail is required`);
    }
  }

  // Exact accounting: every discovered member appears once, as ready or as an
  // explicit exclusion, and nothing appears that was never discovered.
  const accounted = [...ready, ...excluded.map(item => item?.taskId)].sort();
  const discovered = inventoryMembers.map(member => member?.taskId).sort();
  if (accounted.length !== discovered.length || accounted.some((taskId, index) => taskId !== discovered[index])) {
    errors.push('parallel scan does not account for every inventory member exactly once as ready or excluded');
  }
  if (new Set(accounted).size !== accounted.length && new Set(discovered).size === discovered.length) {
    errors.push('parallel scan accounts for a task more than once');
  }

  const readySet = new Set(ready);
  const eligibility = requireArray(record.eligibility, 'parallel scan eligibility', errors);
  const knowledge = requireArray(record.knowledgeCoupling, 'parallel scan knowledgeCoupling', errors);
  const blockers = requireArray(record.couplingBlockers, 'parallel scan couplingBlockers', errors);
  const pairs = requireArray(record.pairs, 'parallel scan pairs', errors);
  const candidatePairs = requireArray(record.candidatePairs, 'parallel scan candidatePairs', errors);
  if (!eligibility || !knowledge || !blockers || !pairs || !candidatePairs) return { ok: false, errors };

  const eligibilityIds = [];
  for (const item of eligibility) {
    exactKeys(item, ['taskId', 'eligibility'], `parallel scan eligibility '${item?.taskId}'`, errors);
    eligibilityIds.push(item?.taskId);
    if (!['eligible', 'blocked', 'unknown'].includes(item?.eligibility)) {
      errors.push(`parallel scan eligibility for '${item?.taskId}' is invalid`);
    }
  }
  const knowledgeByTask = new Map();
  for (const item of knowledge) {
    exactKeys(item, ['taskId', 'classification'], `parallel scan knowledge coupling '${item?.taskId}'`, errors);
    if (!['independent', 'coupled', 'unknown'].includes(item?.classification)) {
      errors.push(`parallel scan knowledge coupling for '${item?.taskId}' is invalid`);
    }
    knowledgeByTask.set(item?.taskId, item?.classification);
  }
  const blockerIds = [];
  for (const item of blockers) {
    exactKeys(item, ['taskId', 'classification', 'blocker'], `parallel scan coupling blocker '${item?.taskId}'`, errors);
    blockerIds.push(item?.taskId);
    if (!['coupled', 'unknown'].includes(item?.classification) || typeof item?.blocker !== 'string' || !item.blocker) {
      errors.push(`parallel scan coupling blocker for '${item?.taskId}' is invalid`);
    }
    if (knowledgeByTask.get(item?.taskId) !== item?.classification) {
      errors.push(`parallel scan coupling blocker for '${item?.taskId}' does not match knowledge coupling`);
    }
  }
  const sortedReady = [...ready].sort();
  const sameTaskSet = values => values.length === ready.length &&
    [...values].sort().every((taskId, index) => taskId === sortedReady[index]);
  if (!sameTaskSet(eligibilityIds) || !sameTaskSet([...knowledgeByTask.keys()])) {
    errors.push('parallel scan eligibility and knowledge-coupling inventories must cover the ready set exactly');
  }
  const expectedBlockers = knowledge.filter(item => item?.classification !== 'independent').map(item => item?.taskId).sort();
  if (blockerIds.length !== expectedBlockers.length || blockerIds.slice().sort().some((taskId, index) => taskId !== expectedBlockers[index])) {
    errors.push('parallel scan coupling blockers must equal the non-independent ready-task set');
  }

  const pairByKey = new Map();
  for (const pair of pairs) {
    exactKeys(pair, ['left', 'right', 'relation', 'reason'], `parallel scan pair '${pair?.left}|${pair?.right}'`, errors);
    if (!readySet.has(pair?.left) || !readySet.has(pair?.right) || !(pair?.left < pair?.right)) {
      errors.push(`parallel scan pair '${pair?.left}|${pair?.right}' must name two distinct ready tasks in canonical order`);
    }
    if (!PAIR_RELATIONS.includes(pair?.relation) || typeof pair?.reason !== 'string' || !pair.reason) {
      errors.push(`parallel scan pair '${pair?.left}|${pair?.right}' classification is invalid`);
    }
    const key = `${pair?.left}|${pair?.right}`;
    if (pairByKey.has(key)) errors.push(`parallel scan pair '${key}' is duplicated`);
    pairByKey.set(key, pair);
  }
  const expectedPairKeys = [];
  for (let left = 0; left < ready.length; left += 1) {
    for (let right = left + 1; right < ready.length; right += 1) expectedPairKeys.push(`${ready[left]}|${ready[right]}`);
  }
  if (pairByKey.size !== expectedPairKeys.length || expectedPairKeys.some(key => !pairByKey.has(key))) {
    errors.push('parallel scan pairs must classify every unordered ready-task pair exactly once');
  }

  const candidateKeys = [];
  for (const pair of candidatePairs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !readySet.has(pair[0]) || !readySet.has(pair[1]) || !(pair[0] < pair[1])) {
      errors.push('parallel scan candidate pair must name two distinct ready tasks in canonical order');
      continue;
    }
    candidateKeys.push(`${pair[0]}|${pair[1]}`);
  }
  const expectedCandidateKeys = [...pairByKey.entries()]
    .filter(([, pair]) => CANDIDATE_RELATIONS.has(pair?.relation))
    .map(([key]) => key)
    .sort();
  if (new Set(candidateKeys).size !== candidateKeys.length ||
      candidateKeys.length !== expectedCandidateKeys.length ||
      candidateKeys.slice().sort().some((key, index) => key !== expectedCandidateKeys[index])) {
    errors.push('parallel scan candidatePairs must equal the disjoint or managed-join pair classifications');
  }

  const structurallyIncomplete = record.inventory.complete !== true || record.decomposition?.state !== 'complete';
  const derivedConclusion = structurallyIncomplete
    ? 'incomplete'
    : ready.length === 0
      ? 'no_eligible_work'
      : ready.length < 2 || expectedCandidateKeys.length === 0
        ? 'not_currently_eligible'
        : 'parallel_candidates';
  // A structurally complete scan may still have been observed outside its
  // freshness window and therefore legitimately carry `incomplete`. Current
  // freshness is checked again by the decomposition consumer.
  if ((structurallyIncomplete && record.conclusion !== 'incomplete') ||
      (!structurallyIncomplete && record.conclusion !== 'incomplete' && record.conclusion !== derivedConclusion)) {
    errors.push(`parallel scan conclusion must be '${derivedConclusion}' for its validated inventory and pair evidence`);
  }
  if (typeof record.rescanTrigger !== 'string' || !record.rescanTrigger.trim()) {
    errors.push('parallel scan requires a concrete rescan trigger');
  }

  if (record.digest !== `sha256:${PARALLEL_SCAN_DIGEST_DOMAIN}:${safeCanonicalSha256(digestProjection(record))}`) {
    errors.push('parallel scan digest does not match its exact record projection');
  }
  if (record.semanticDigest !== `sha256:${PARALLEL_SCAN_SEMANTIC_DIGEST_DOMAIN}:${safeCanonicalSha256(semanticProjection(record))}`) {
    errors.push('parallel scan semantic digest does not match its backend-neutral projection');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the bound readiness context.
 *
 * The context is a projection of the canonical base and dependency evidence
 * contracts; it is validated as an exact closed shape here because the scan
 * record carries digests, not the evidence documents themselves. The documents
 * are revalidated against these identities by
 * `validateParallelScanReadinessBinding` before dispatch.
 */
function validateReadinessContextShape(record, errors) {
  const context = record.readinessContext;
  if (!exactKeys(context, READINESS_CONTEXT_FIELDS, 'parallel scan readinessContext', errors)) return;
  if (exactKeys(context.base, READINESS_BASE_FIELDS, 'parallel scan readinessContext base', errors)) {
    if (!BASE_EVIDENCE_KINDS.includes(context.base.kind)) {
      errors.push(`parallel scan readinessContext base kind must be one of: ${BASE_EVIDENCE_KINDS.join(', ')}`);
    }
    if (typeof context.base.identity !== 'string' || !context.base.identity) {
      errors.push('parallel scan readinessContext base identity is required');
    }
    if (!SHA256.test(String(context.base.inventoryDigest ?? ''))) {
      errors.push('parallel scan readinessContext base inventoryDigest must be a sha256 digest');
    }
    if (!Number.isSafeInteger(context.base.pathCount) || context.base.pathCount < 0) {
      errors.push('parallel scan readinessContext base pathCount must be a non-negative safe integer');
    }
  }
  if (context.dependencies !== null) {
    if (exactKeys(context.dependencies, READINESS_DEPENDENCY_FIELDS, 'parallel scan readinessContext dependencies', errors)) {
      const dependencies = context.dependencies;
      if (typeof dependencies.source !== 'string' || !dependencies.source) {
        errors.push('parallel scan readinessContext dependency source is required');
      }
      if (!SHA256.test(String(dependencies.digest ?? ''))) {
        errors.push('parallel scan readinessContext dependency digest must be a sha256 digest');
      }
      if (!CANONICAL_INSTANT_PATTERN.test(String(dependencies.observedAt ?? ''))) {
        errors.push('parallel scan readinessContext dependency observedAt must be an ISO-8601 UTC instant');
      }
      if (!DEPENDENCY_FRESHNESS_STATES.includes(dependencies.freshnessState)) {
        errors.push('parallel scan readinessContext dependency freshnessState is invalid');
      }
      if (dependencies.freshnessState !== 'current') {
        errors.push('parallel scan readinessContext dependency evidence must be current');
      }
      if (!DEPENDENCY_EVALUATED_STATES.includes(dependencies.evaluatedState)) {
        errors.push('parallel scan readinessContext dependency evaluatedState is invalid');
      }
      if (!Number.isSafeInteger(dependencies.statusCount) || dependencies.statusCount < 0) {
        errors.push('parallel scan readinessContext dependency statusCount must be a non-negative safe integer');
      }
      if (typeof dependencies.statusDigest !== 'string' ||
          !dependencies.statusDigest.startsWith(`sha256:${PARALLEL_SCAN_READINESS_DIGEST_DOMAIN}:`)) {
        errors.push('parallel scan readinessContext dependency statusDigest must use the canonical readiness digest domain');
      }
    }
  }
  if (exactKeys(context.observation, READINESS_OBSERVATION_FIELDS, 'parallel scan readinessContext observation', errors)) {
    if (context.observation.observedAt !== record.observedAt) {
      errors.push('parallel scan readinessContext observation time must equal the scan observation time');
    }
    if (context.observation.maxAgeSeconds !== record.freshnessPolicy?.maxAgeSeconds) {
      errors.push('parallel scan readinessContext freshness policy must equal the scan freshness policy');
    }
  }
  if (context.digest !== readinessContextDigest(context)) {
    errors.push('parallel scan readinessContext digest does not match its exact bound evidence');
  }
}

function safeCanonicalSha256(value) {
  try {
    return canonicalSha256(value);
  } catch {
    return 'uncanonicalizable';
  }
}

function finish({ diagnostics, warnings, record }) {
  const errors = diagnostics.filter(item => item.level === 'error');
  const evidenceState = deriveEvidenceState(errors) ?? (errors.length === 0 ? 'current' : 'negative');
  const disposition = errors.length === 0 ? 'proceed' : dispositionForEvidenceState(evidenceState);
  const result = createValidationResult({
    command: PARALLEL_SCAN_COMMAND,
    ok: errors.length === 0,
    evidenceState,
    disposition,
    diagnostics: errors,
    warningDiagnostics: warnings,
  });
  return { ok: errors.length === 0, result, scan: record ? deepFreeze(record) : null };
}
