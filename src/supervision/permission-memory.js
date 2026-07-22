/**
 * Two bounded, in-memory permission stores.
 *
 * `TransientPermissionScopeStore` holds the exact scope the `assess` tier needs
 * to make a meaningful decision. It never touches durable run state, public
 * status, diagnostics, notifications, or JSONL. Sending an entry to the
 * supervisor still sends it to the configured model provider -- that is an
 * explicit, configured egress, not a claim of privacy.
 *
 * `PermissionDecisionCache` remembers bounded Agentic Loop decisions so an
 * identical request in the same generation does not have to wake the model
 * again. A replay is always an exact host `once` (or a bounded rejection) for
 * the *new* request; it never becomes an OpenCode `always` grant, and it never
 * crosses a project, authorization, lane, session, task, or policy boundary.
 */

import { createHmac } from 'node:crypto';

import { containsSensitiveMaterial, safeStructure } from './redaction.js';

export const PERMISSION_CACHE_KEY_VERSION = 1;

const MAXIMUM_STRING = 300;
const MAXIMUM_ARRAY = 20;

function boundedString(value, limit = MAXIMUM_STRING) {
  return String(value ?? '').slice(0, limit);
}

function boundedArray(values, limit = MAXIMUM_ARRAY) {
  return Array.isArray(values) ? values.slice(0, limit).map(entry => boundedString(entry, 200)) : [];
}

/**
 * Build the bounded transient value for one request.
 *
 * Only the fields the assess tier actually reasons about are carried, each of
 * them bounded in length and count. `null` is returned when the scope contains
 * credential-like material: a sensitive request is never stored and never
 * model-projected, whatever the caller asked for.
 */
export function buildTransientPermissionScope({
  request_id,
  operation,
  command = '',
  patterns = [],
  paths = [],
  targets = [],
  working_directory = null,
  containment = null,
  lane_id = null,
  task_ref = null,
  expected_artifact = null,
  authorization_generation = null,
  session_id = null,
  session_generation = null,
} = {}) {
  const scope = {
    request_id: boundedString(request_id, 120),
    operation: boundedString(operation, 60),
    command: boundedString(command),
    patterns: boundedArray(patterns),
    paths: boundedArray(paths),
    targets: boundedArray(targets),
    working_directory: working_directory === null ? null : boundedString(working_directory),
    containment: containment ? {
      checked: containment.checked === true,
      inside_project: containment.inside_project === true,
      protected: containment.protected === true,
    } : null,
    lane_id: lane_id === null ? null : boundedString(lane_id, 120),
    task_ref: task_ref === null ? null : boundedString(task_ref, 120),
    expected_artifact: expected_artifact === null ? null : boundedString(expected_artifact),
    authorization_generation: Number.isInteger(authorization_generation) ? authorization_generation : null,
    session_id: session_id === null ? null : boundedString(session_id, 120),
    session_generation: Number.isInteger(session_generation) ? session_generation : null,
  };
  const inspected = [scope.command, scope.working_directory, ...scope.patterns, ...scope.paths, ...scope.targets];
  if (inspected.some(entry => containsSensitiveMaterial(entry))) return null;
  // Redaction and bounded structured serialization are defence in depth, not
  // proof that the scope is safe to disclose. The sensitivity check above is
  // the boundary; this only limits the damage of a pattern that missed.
  return safeStructure(scope, { maxDepth: 3, stringLimit: MAXIMUM_STRING });
}

export class TransientPermissionScopeStore {
  constructor({ maximumEntries = 50, maximumAgeMs = 120_000, now = Date.now } = {}) {
    this.maximumEntries = Math.max(1, maximumEntries);
    this.maximumAgeMs = Math.max(1_000, maximumAgeMs);
    this.now = now;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  prune() {
    const cutoff = this.now() - this.maximumAgeMs;
    for (const [key, entry] of this.entries) {
      if (entry.stored_at <= cutoff) this.entries.delete(key);
    }
  }

  /**
   * Insert one immutable scope. A duplicate request keeps the scope it was
   * first registered with: a repeated host event can never replace the value a
   * pending decision is bound to.
   */
  insert(requestId, scope) {
    if (!requestId || !scope) return false;
    this.prune();
    if (this.entries.has(requestId)) return false;
    if (this.entries.size >= this.maximumEntries) {
      // Deterministic oldest-first eviction; Map preserves insertion order.
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(requestId, { scope, stored_at: this.now() });
    return true;
  }

  /**
   * Read one scope, proving it still belongs to the same request, the same
   * authorization generation, and the same session generation. Any mismatch is
   * reported as absent so the caller routes to the operator.
   */
  read(requestId, { authorization_generation = null, session_generation = null } = {}) {
    this.prune();
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    const scope = entry.scope;
    if (scope.request_id !== requestId) return null;
    if (authorization_generation !== null && scope.authorization_generation !== authorization_generation) return null;
    if (session_generation !== null && scope.session_generation !== session_generation) return null;
    return scope;
  }

  delete(requestId) {
    return this.entries.delete(requestId);
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Build the full cache context for one decision. Every component is part of the
 * key: a change in any of them is a different decision, not a cache hit.
 */
export function permissionCacheContext({
  project_identity,
  authorization_generation,
  lane_id,
  session_id,
  session_generation,
  task_ref,
  operation,
  policy_version,
  scope_fingerprint,
  progress_epoch = 0,
}) {
  return {
    key_version: PERMISSION_CACHE_KEY_VERSION,
    project_identity: boundedString(project_identity, 200),
    authorization_generation: Number.isInteger(authorization_generation) ? authorization_generation : null,
    lane_id: lane_id === null || lane_id === undefined ? null : boundedString(lane_id, 120),
    session_id: boundedString(session_id, 120),
    session_generation: Number.isInteger(session_generation) ? session_generation : 0,
    task_ref: task_ref === null || task_ref === undefined ? null : boundedString(task_ref, 120),
    operation: boundedString(operation, 60),
    policy_version: Number.isInteger(policy_version) ? policy_version : 1,
    scope_fingerprint: boundedString(scope_fingerprint, 64),
    progress_epoch: Number.isInteger(progress_epoch) ? progress_epoch : 0,
  };
}

export class PermissionDecisionCache {
  constructor({
    enabled = false,
    maximumEntries = 200,
    policyTtlMs = 900_000,
    supervisorTtlMs = 300_000,
    rejectionTtlMs = 600_000,
    key = 'agenticloop-permission-cache',
    now = Date.now,
  } = {}) {
    this.enabled = enabled === true;
    this.maximumEntries = Math.max(1, maximumEntries);
    this.policyTtlMs = Math.max(1_000, policyTtlMs);
    this.supervisorTtlMs = Math.max(1_000, supervisorTtlMs);
    this.rejectionTtlMs = Math.max(1_000, rejectionTtlMs);
    this.key = key;
    this.now = now;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * One-way, run-keyed cache key. The raw context never leaves this object and
   * the published key is an HMAC, so neither a reusable digest nor the exact
   * scope can be recovered from status or audit fields.
   */
  keyFor(context) {
    return createHmac('sha256', this.key).update(JSON.stringify(context)).digest('hex');
  }

  ttlFor(principal, decision) {
    if (decision === 'reject') return this.rejectionTtlMs;
    return principal === 'policy' ? this.policyTtlMs : this.supervisorTtlMs;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires_at <= now) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }

  get(context) {
    if (!this.enabled) return null;
    this.prune();
    const key = this.keyFor(context);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    // Refresh recency without extending the lifetime: eviction is LRU, expiry
    // is absolute.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { ...entry, key };
  }

  set(context, { decision, principal, origin_decision_id }) {
    if (!this.enabled) return null;
    if (decision !== 'once' && decision !== 'reject') return null;
    this.prune();
    const key = this.keyFor(context);
    if (!this.entries.has(key) && this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    const entry = {
      decision,
      principal,
      origin_decision_id: boundedString(origin_decision_id, 120),
      key_version: PERMISSION_CACHE_KEY_VERSION,
      stored_at: this.now(),
      expires_at: this.now() + this.ttlFor(principal, decision),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry, key };
  }

  /** Drop every entry whose recorded context matches a predicate-selected key. */
  invalidateKeys(keys) {
    let removed = 0;
    for (const key of keys) if (this.entries.delete(key)) removed += 1;
    return removed;
  }

  clear() {
    this.entries.clear();
  }

  /** Bounded, non-identifying metrics. No key or fingerprint is published. */
  stats() {
    return { enabled: this.enabled, entries: this.entries.size, hits: this.hits, misses: this.misses };
  }
}
