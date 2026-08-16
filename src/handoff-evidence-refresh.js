/** Bounded refresh of derived handoff evidence only. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { executeMutationBatch, resolveTargetPath } from './fs-mutation-kernel.js';
import { targetRepositoryIdentity } from './host-trust.js';
import { evaluateCommitAttribution } from './commit-attribution.js';
import { currentDispatchConsumption } from './handoff-consumption.js';
import { evaluateParallelScan, normalizeFilesTaskInventory, createTaskInventoryEnumeration } from './parallel-scan.js';
import { createDecompositionProvenance, DECOMPOSITION_SCHEMA_VERSION } from './dispatch-envelope.js';
import { parseTaskReadinessDeclaration } from './task-readiness.js';
import { parseDependencySnapshot, dependencyStatusMap } from './task-evidence-contract.js';
import { GIT_MAX_BUFFER } from './git-runner.js';

export const HANDOFF_REFRESH_PLAN_KIND = 'agenticloop.handoff-evidence-refresh-plan';
export const HANDOFF_REFRESH_PLAN_SCHEMA_VERSION = 1;
export const HANDOFF_REFRESH_RECEIPT_KIND = 'agenticloop.handoff-derived-evidence';
export const HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION = 1;
export const HANDOFF_REFRESH_ROOT = '.agenticloop/handoffs/derived-evidence';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const PLAN_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'targetRepository', 'taskId', 'backend', 'carrier',
  'carrierDigest', 'contractDigest', 'source', 'expected', 'proposed',
  'changedFiles', 'categories', 'additionalWrites', 'inputs', 'authority', 'digest',
]);
const RECEIPT_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'targetRepository', 'taskId', 'backend', 'carrier',
  'carrierDigest', 'contractDigest', 'repository', 'readiness',
  'decomposition', 'dispatch', 'authority', 'digest',
]);
const CATEGORY_NAMES = Object.freeze(['receipt', 'dependency_observation', 'decomposition_provenance', 'dispatch']);
const CATEGORY_ACTIONS = Object.freeze(['refreshed', 'requires_maintainer_observation', 'requires_maintainer_regeneration', 'not_applicable']);
const ALLOWED_WRITE_ROOTS = Object.freeze([
  `${HANDOFF_REFRESH_ROOT}/`,
  '.agenticloop/decompositions/',
]);
const PROTECTED_WORKFLOW_PREFIXES = Object.freeze([
  '.agenticloop/tasks/',
  '.agenticloop/activation/',
  '.agenticloop/activations/',
  '.agenticloop/reviews/',
  '.agenticloop/returns/',
  '.agenticloop/handoffs/',
]);
const INPUTS_FIELDS = Object.freeze(['dependencySnapshot', 'decomposition', 'carriers']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length &&
    Object.keys(value).every(key => fields.includes(key));
}

function byteDigest(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex')}`;
}

function semanticDigest(value) {
  return `sha256:agenticloop.handoff-derived-evidence.v${HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION}:${canonicalSha256(value)}`;
}

function withoutDigest(value) {
  const { digest: _digest, ...projection } = value;
  return projection;
}

function safeTaskId(taskId) {
  return String(taskId ?? '').trim();
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split('/');
  return !parts.some(part => !part || part === '.' || part === '..');
}

function isAllowedWritePath(path, rederivedDepSnapshotPath) {
  if (ALLOWED_WRITE_ROOTS.some(root => path.startsWith(root))) return true;
  if (rederivedDepSnapshotPath !== null && path === rederivedDepSnapshotPath) return true;
  return false;
}

export function handoffRefreshRelativePath(taskId) {
  const normalized = safeTaskId(taskId);
  if (!TASK_ID_RE.test(normalized)) throw new TypeError('handoff refresh taskId is invalid');
  return `${HANDOFF_REFRESH_ROOT}/${normalized}.json`;
}

export function handoffRefreshMaintainerTrailerBlock(taskId) {
  const normalized = safeTaskId(taskId);
  if (!TASK_ID_RE.test(normalized)) throw new TypeError('handoff refresh taskId is invalid');
  return `Task: ${normalized}\nAgent: maintainer`;
}

export function validateHandoffRefreshMaintainerTrailer(taskId, message = null) {
  const trailer = handoffRefreshMaintainerTrailerBlock(taskId);
  const attribution = evaluateCommitAttribution({
    taskId,
    role: 'maintainer',
    message: message ?? `refresh derived evidence\n\n${trailer}`,
  });
  return {
    ok: attribution.ok,
    trailer,
    errors: attribution.errors,
  };
}

function projectionFromPreflight(preflight, target = null) {
  const taskId = safeTaskId(preflight?.taskId);
  let dispatchInvocation = null;
  let dispatchLiveness = null;
  if (target && taskId) {
    try {
      const consumption = currentDispatchConsumption(target, taskId);
      if (consumption.ok && consumption.record) {
        dispatchInvocation = consumption.record.invocationId;
        dispatchLiveness = {
          consumedAt: consumption.record.consumedAt,
          invocationId: consumption.record.invocationId,
        };
      }
    } catch {
      // Dispatch consumption lookup failure is non-fatal for projection.
    }
  }
  return {
    repository: preflight?.repository
      ? {
          head: preflight.repository.head ?? null,
          baseTree: preflight.repository.baseTree ?? null,
          productBase: preflight.repository.productBase ?? null,
        }
      : null,
    readiness: preflight?.readiness
      ? {
          evidenceState: preflight.readiness.evidenceState ?? null,
          disposition: preflight.readiness.disposition ?? null,
          base: preflight.readiness.base ?? null,
          dependencies: preflight.readiness.dependencies ?? null,
        }
      : null,
    decomposition: preflight?.decomposition
      ? {
          sourceRef: preflight.decomposition.sourceRef ?? null,
          sourceRevision: preflight.decomposition.sourceRevision ?? null,
          sourceCommit: preflight.decomposition.sourceCommit ?? null,
          inventoryComplete: preflight.decomposition.inventoryComplete ?? false,
          baseMode: preflight.decomposition.baseMode ?? null,
          eligibility: preflight.decomposition.eligibility ?? null,
          dispatchCompatible: preflight.decomposition.dispatchCompatible ?? false,
        }
      : null,
    dispatch: { liveness: dispatchLiveness, invocation: dispatchInvocation },
  };
}

const ELIGIBILITY_DIGEST_RE = /^sha256:agenticloop\.decomposition-eligibility\.v1:[a-f0-9]{64}$/;

function createReceipt({ target, preflight }) {
  const projection = projectionFromPreflight(preflight, target);
  const receipt = {
    kind: HANDOFF_REFRESH_RECEIPT_KIND,
    schemaVersion: HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION,
    targetRepository: targetRepositoryIdentity(target),
    taskId: safeTaskId(preflight?.taskId),
    backend: preflight?.backend ?? null,
    carrier: preflight?.carrier ?? null,
    carrierDigest: preflight?.carrierDigest ?? null,
    contractDigest: preflight?.contractDigest ?? null,
    repository: projection.repository,
    readiness: {
      ...projection.readiness,
      dependencyAge: preflight?.dependencyAge ?? null,
    },
    decomposition: {
      ...projection.decomposition,
      eligibilityDigest: preflight?.decomposition?.eligibilityDigest ?? null,
    },
    dispatch: projection.dispatch,
    authority: {
      state: 'derived_only',
      durableCommitRequired: true,
      durableCommit: null,
    },
    digest: null,
  };
  receipt.digest = semanticDigest(withoutDigest(receipt));
  return receipt;
}

export function validateHandoffRefreshReceipt(value, { target = null, taskId = null } = {}) {
  const errors = [];
  if (!exactKeys(value, RECEIPT_FIELDS)) {
    return { ok: false, errors: ['handoff derived-evidence receipt fields must equal the closed schema'] };
  }
  if (value.kind !== HANDOFF_REFRESH_RECEIPT_KIND || value.schemaVersion !== HANDOFF_REFRESH_RECEIPT_SCHEMA_VERSION) {
    errors.push('handoff derived-evidence receipt identity is invalid');
  }
  if (!TASK_ID_RE.test(String(value.taskId ?? '')) || (taskId !== null && value.taskId !== taskId)) {
    errors.push('handoff derived-evidence receipt taskId is invalid or mismatched');
  }
  if (!['files', 'github'].includes(value.backend)) errors.push('handoff derived-evidence receipt backend is invalid');
  if (typeof value.targetRepository !== 'string' || !value.targetRepository) errors.push('handoff derived-evidence receipt targetRepository is required');
  if (typeof value.carrier !== 'string' || !value.carrier) errors.push('handoff derived-evidence receipt carrier is required');
  if (!DIGEST_RE.test(String(value.carrierDigest ?? ''))) errors.push('handoff derived-evidence receipt carrierDigest is invalid');
  if (!CONTRACT_DIGEST_RE.test(String(value.contractDigest ?? ''))) errors.push('handoff derived-evidence receipt contractDigest is invalid');
  if (!isObject(value.repository) || !isObject(value.readiness) || !isObject(value.decomposition) || !isObject(value.dispatch)) {
    errors.push('handoff derived-evidence receipt derived projections must be objects');
  }
  if (isObject(value.dispatch)) {
    if (value.dispatch.invocation !== null && typeof value.dispatch.invocation !== 'string') {
      errors.push('handoff derived-evidence receipt dispatch.invocation must be a string or null');
    }
    if (value.dispatch.liveness !== null) {
      if (!isObject(value.dispatch.liveness)) {
        errors.push('handoff derived-evidence receipt dispatch.liveness must be an object or null');
      } else if (typeof value.dispatch.liveness.consumedAt !== 'string' || typeof value.dispatch.liveness.invocationId !== 'string') {
        errors.push('handoff derived-evidence receipt dispatch.liveness must have consumedAt and invocationId strings');
      }
    }
  }
  if (isObject(value.decomposition)) {
    const eligDigest = value.decomposition.eligibilityDigest;
    if (eligDigest !== null && eligDigest !== undefined) {
      if (!ELIGIBILITY_DIGEST_RE.test(String(eligDigest))) {
        errors.push('handoff derived-evidence receipt decomposition eligibilityDigest must use the decomposition-eligibility domain');
      }
    }
  }
  if (!exactKeys(value.authority, ['state', 'durableCommitRequired', 'durableCommit']) ||
      value.authority.state !== 'derived_only' || value.authority.durableCommitRequired !== true ||
      value.authority.durableCommit !== null) {
    errors.push('handoff derived-evidence receipt authority must remain derived_only and non-authoritative');
  }
  if (target !== null && value.targetRepository !== targetRepositoryIdentity(target)) errors.push('handoff derived-evidence receipt targetRepository is stale');
  if (value.digest !== semanticDigest(withoutDigest(value))) errors.push('handoff derived-evidence receipt digest is invalid');
  return { ok: errors.length === 0, errors };
}

export function validateHandoffRefreshPlan(value, { target = null, taskId = null } = {}) {
  const errors = [];
  if (!exactKeys(value, PLAN_FIELDS)) {
    return { ok: false, errors: ['handoff refresh plan fields must equal the closed schema'] };
  }
  if (value.kind !== HANDOFF_REFRESH_PLAN_KIND || value.schemaVersion !== HANDOFF_REFRESH_PLAN_SCHEMA_VERSION) {
    errors.push('handoff refresh plan identity is invalid');
  }
  if (!TASK_ID_RE.test(String(value.taskId ?? '')) || (taskId !== null && value.taskId !== taskId)) errors.push('handoff refresh plan taskId is invalid or mismatched');
  if (!['files', 'github'].includes(value.backend)) errors.push('handoff refresh plan backend is invalid');
  if (target !== null && value.targetRepository !== targetRepositoryIdentity(target)) errors.push('handoff refresh plan targetRepository is stale');
  if (!DIGEST_RE.test(String(value.carrierDigest ?? ''))) errors.push('handoff refresh plan carrierDigest is invalid');
  if (!CONTRACT_DIGEST_RE.test(String(value.contractDigest ?? ''))) errors.push('handoff refresh plan contractDigest is invalid');
  if (!exactKeys(value.source, ['kind', 'schemaVersion', 'observationDigest']) ||
      value.source.kind !== 'agenticloop.handoff-preflight' || value.source.schemaVersion !== 1 ||
      !DIGEST_RE.test(String(value.source.observationDigest ?? ''))) {
    errors.push('handoff refresh plan source identity is invalid');
  }
  if (!exactKeys(value.expected, ['path', 'digest']) || typeof value.expected.path !== 'string' ||
      (value.expected.digest !== null && !DIGEST_RE.test(String(value.expected.digest)))) {
    errors.push('handoff refresh plan expected derived state is invalid');
  } else {
    try {
      if (value.expected.path !== handoffRefreshRelativePath(value.taskId)) {
        errors.push('handoff refresh plan expected path must be the canonical derived-evidence path for the task');
      }
    } catch {
      errors.push('handoff refresh plan expected path cannot be validated because taskId is invalid');
    }
  }
  const proposed = validateHandoffRefreshReceipt(value.proposed, { taskId: value.taskId });
  if (!proposed.ok) errors.push(...proposed.errors.map(error => `proposed: ${error}`));
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length < 1 ||
      value.changedFiles.some(path => typeof path !== 'string' || !path)) {
    errors.push('handoff refresh plan changedFiles must contain at least one bounded path');
  } else {
    const receiptPath = value.expected?.path;
    for (const changedPath of value.changedFiles) {
      if (!isSafeRelativePath(changedPath)) {
        errors.push(`handoff refresh plan changedFiles entry is not a safe relative path: ${changedPath}`);
      }
    }
    if (receiptPath && !value.changedFiles.includes(receiptPath)) {
      errors.push('handoff refresh plan changedFiles must include the receipt path');
    }
    if (Array.isArray(value.additionalWrites)) {
      for (const entry of value.additionalWrites) {
        if (!value.changedFiles.includes(entry.path)) {
          errors.push(`handoff refresh plan additionalWrites path ${entry.path} is not in changedFiles`);
        }
      }
    }
  }
  if (!Array.isArray(value.categories)) {
    errors.push('handoff refresh plan categories must be an array');
  } else {
    for (const cat of value.categories) {
      if (!isObject(cat)) { errors.push('handoff refresh plan category entry must be an object'); continue; }
      if (!CATEGORY_NAMES.includes(cat.category)) errors.push(`handoff refresh plan category name is invalid: ${cat.category}`);
      if (!CATEGORY_ACTIONS.includes(cat.action)) errors.push(`handoff refresh plan category action is invalid: ${cat.action}`);
      if (typeof cat.reason !== 'string' || !cat.reason) errors.push('handoff refresh plan category reason must be a non-empty string');
    }
  }
  if (!Array.isArray(value.additionalWrites)) {
    errors.push('handoff refresh plan additionalWrites must be an array');
  } else {
    const depCat = value.categories?.find(c => c.category === 'dependency_observation');
    const depRefreshed = depCat?.action === 'refreshed';
    let rederivedDepSnapshotPath = null;
    if (depRefreshed && target !== null && taskId !== null) {
      const derived = deriveDependencySnapshotFromDecomposition(target, taskId);
      if (derived.ok) {
        rederivedDepSnapshotPath = derived.path;
      } else {
        errors.push(`dependency_observation is 'refreshed' but snapshot path cannot be re-derived: ${derived.reason}`);
      }
    }
    let outOfRootsCount = 0;
    let outOfRootsEntry = null;
    for (const entry of value.additionalWrites) {
      if (!isObject(entry)) { errors.push('handoff refresh plan additionalWrites entry must be an object'); continue; }
      if (typeof entry.path !== 'string' || !entry.path) errors.push('handoff refresh plan additionalWrites path must be a non-empty string');
      else if (!isSafeRelativePath(entry.path)) errors.push(`handoff refresh plan additionalWrites path is not safe: ${entry.path}`);
      else if (!isAllowedWritePath(entry.path, rederivedDepSnapshotPath)) errors.push(`handoff refresh plan additionalWrites path is not under an allowed root: ${entry.path}`);
      else {
        const underFixed = ALLOWED_WRITE_ROOTS.some(root => entry.path.startsWith(root));
        if (!underFixed) {
          outOfRootsCount += 1;
          outOfRootsEntry = entry;
        }
      }
      if (entry.expectedDigest !== null && !DIGEST_RE.test(String(entry.expectedDigest ?? ''))) errors.push('handoff refresh plan additionalWrites expectedDigest must be a sha256 digest or null');
      if (typeof entry.content !== 'string' || !entry.content) errors.push('handoff refresh plan additionalWrites content must be a non-empty string');
    }
    if (outOfRootsCount > 1) {
      errors.push('handoff refresh plan additionalWrites contains more than one out-of-roots entry');
    }
    if (outOfRootsEntry !== null && rederivedDepSnapshotPath !== null) {
      if (outOfRootsEntry.path !== rederivedDepSnapshotPath) {
        errors.push(`handoff refresh plan out-of-roots entry ${outOfRootsEntry.path} does not match re-derived snapshot path ${rederivedDepSnapshotPath}`);
      }
      if (!depRefreshed) {
        errors.push('handoff refresh plan out-of-roots entry present but dependency_observation is not refreshed');
      }
    }
  }
  if (!isObject(value.inputs)) {
    errors.push('handoff refresh plan inputs must be an object');
  } else if (!exactKeys(value.inputs, INPUTS_FIELDS)) {
    errors.push('handoff refresh plan inputs must have exactly the fields: ' + INPUTS_FIELDS.join(', '));
  } else {
    const { dependencySnapshot, decomposition, carriers } = value.inputs;
    if (dependencySnapshot !== null && !DIGEST_RE.test(String(dependencySnapshot))) {
      errors.push('handoff refresh plan inputs.dependencySnapshot must be a sha256 digest or null');
    }
    if (decomposition !== null && !DIGEST_RE.test(String(decomposition))) {
      errors.push('handoff refresh plan inputs.decomposition must be a sha256 digest or null');
    }
    if (!DIGEST_RE.test(String(carriers))) {
      errors.push('handoff refresh plan inputs.carriers must be a sha256 digest');
    }
  }
  if (!exactKeys(value.authority, ['state', 'durableCommitRequired', 'durableCommit']) || value.authority.state !== 'derived_only' || value.authority.durableCommitRequired !== true || value.authority.durableCommit !== null) errors.push('handoff refresh plan authority must remain derived_only and non-authoritative');
  if (value.digest !== `sha256:agenticloop.handoff-refresh-plan.v1:${canonicalSha256(withoutDigest(value))}`) errors.push('handoff refresh plan digest is invalid');
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Category 2 — Dependency-status observation refresh
// ---------------------------------------------------------------------------

function attemptDependencySnapshotRefresh({ target, preflight }) {
  const decompositionRef = preflight?.decomposition?.sourceRef;
  if (!decompositionRef) {
    return { ok: false, skipped: true, reason: 'no decomposition sourceRef in preflight', expectedDigest: null, content: null, path: null, snapshot: null };
  }
  const decompositionPath = join(target, decompositionRef);
  if (!existsSync(decompositionPath)) {
    return { ok: false, skipped: true, reason: 'decomposition source not found', expectedDigest: null, content: null, path: null, snapshot: null };
  }
  let decompositionSource;
  try {
    decompositionSource = JSON.parse(readFileSync(decompositionPath, 'utf8'));
  } catch {
    return { ok: false, skipped: true, reason: 'decomposition source is unreadable', expectedDigest: null, content: null, path: null, snapshot: null };
  }
  const depSourceRef = decompositionSource?.scan?.readinessContext?.dependencies?.sourceRef;
  if (!depSourceRef) {
    return { ok: false, skipped: true, reason: 'no dependency snapshot sourceRef in decomposition readinessContext', expectedDigest: null, content: null, path: null, snapshot: null };
  }
  const depPath = join(target, depSourceRef);
  if (!existsSync(depPath)) {
    return { ok: false, skipped: true, reason: `dependency snapshot not found at ${depSourceRef}`, expectedDigest: null, content: null, path: null, snapshot: null };
  }
  let rawContent;
  try {
    rawContent = readFileSync(depPath, 'utf8');
  } catch (error) {
    return { ok: false, skipped: false, reason: `dependency snapshot unreadable: ${error.message}`, expectedDigest: null, content: null, path: null, snapshot: null };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(rawContent);
  } catch {
    return { ok: false, skipped: false, reason: 'dependency snapshot is not valid JSON', expectedDigest: null, content: null, path: null, snapshot: null };
  }
  if (snapshot?.kind !== 'agenticloop.dependency-snapshot' || snapshot?.schemaVersion !== 1) {
    return { ok: false, skipped: false, reason: 'dependency snapshot has invalid kind or schemaVersion', expectedDigest: null, content: null, path: null, snapshot: null };
  }
  const taskId = safeTaskId(preflight?.taskId);
  const carrierPath = join(target, '.agenticloop', 'tasks', `${taskId}.md`);
  if (!existsSync(carrierPath)) {
    return { ok: false, skipped: false, reason: `task carrier not found: ${taskId}`, expectedDigest: null, content: null, path: null, snapshot: null };
  }
  let carrierBody;
  try {
    carrierBody = readFileSync(carrierPath, 'utf8');
  } catch {
    return { ok: false, skipped: false, reason: `task carrier unreadable: ${taskId}`, expectedDigest: null, content: null, path: null, snapshot: null };
  }
  const declared = parseTaskReadinessDeclaration(carrierBody).declaration?.dependsOn ?? [];
  const existingStatuses = snapshot.statuses ?? {};
  const missing = declared.filter(depId => !Object.hasOwn(existingStatuses, depId));
  if (missing.length > 0) {
    return {
      ok: false, skipped: false,
      reason: `missing maintainer-recorded statuses for dependencies: ${missing.sort().join(', ')}`,
      expectedDigest: null, content: null, path: null, snapshot: null,
      missingDependencies: missing,
    };
  }
  // This renews the observation *window* on Maintainer-recorded statuses; it does
  // not re-observe dependency state. The existing statuses are carried forward
  // verbatim and only `observedAt` is re-stamped, so a status that was `satisfied`
  // stays `satisfied` with its maxAgeSeconds window reset. The refresh verifies
  // only that every declared dependency has a recorded status (missing ones fail
  // above); the Maintainer remains responsible for those statuses still being
  // currently true. Re-observing dependency status is recorded follow-up work.
  const freshObservedAt = new Date().toISOString();
  const freshSnapshot = {
    kind: 'agenticloop.dependency-snapshot',
    schemaVersion: 1,
    source: snapshot.source,
    observedAt: freshObservedAt,
    freshnessPolicy: snapshot.freshnessPolicy,
    statuses: existingStatuses,
  };
  const freshContent = `${canonicalJson(freshSnapshot)}\n`;
  const currentDigest = byteDigest(rawContent);
  return {
    ok: true,
    skipped: false,
    reason: declared.length === 0
      ? 'no declared dependencies; observedAt renewed'
      : 'all declared dependencies have maintainer-recorded statuses; observedAt renewed',
    expectedDigest: currentDigest,
    content: freshContent,
    path: depSourceRef,
    snapshot: freshSnapshot,
    statusMap: { ...existingStatuses },
  };
}

// ---------------------------------------------------------------------------
// Category 3 — Decomposition provenance regeneration
// ---------------------------------------------------------------------------

function attemptDecompositionRegeneration({ target, preflight, taskId, refreshedSnapshotContent, refreshedSnapshotPath }) {
  const decompositionRef = preflight?.decomposition?.sourceRef;
  if (!decompositionRef) {
    return { ok: false, skipped: true, reason: 'no decomposition sourceRef in preflight', expectedDigest: null, content: null, path: null };
  }
  const decompositionPath = join(target, decompositionRef);
  if (!existsSync(decompositionPath)) {
    return { ok: false, skipped: true, reason: `decomposition not found at ${decompositionRef}`, expectedDigest: null, content: null, path: null };
  }
  let decompositionSource;
  try {
    decompositionSource = JSON.parse(readFileSync(decompositionPath, 'utf8'));
  } catch {
    return { ok: false, skipped: false, reason: 'decomposition source is unreadable', expectedDigest: null, content: null, path: null };
  }
  if (decompositionSource?.authority !== 'maintainer') {
    return { ok: false, skipped: false, reason: 'decomposition is not maintainer-attributed; requires maintainer regeneration', expectedDigest: null, content: null, path: null };
  }
  if (decompositionSource?.schemaVersion !== DECOMPOSITION_SCHEMA_VERSION) {
    return { ok: false, skipped: false, reason: `decomposition schemaVersion ${decompositionSource.schemaVersion} is not current ${DECOMPOSITION_SCHEMA_VERSION}; requires maintainer regeneration`, expectedDigest: null, content: null, path: null };
  }
  const scan = decompositionSource?.scan;
  if (!scan?.workUnit || !scan?.inventory || !scan?.decomposition) {
    return { ok: false, skipped: false, reason: 'decomposition scan is missing required fields', expectedDigest: null, content: null, path: null };
  }
  const depSourceRef = scan?.readinessContext?.dependencies?.sourceRef ?? null;
  let depEvidence = null;
  let depStatusMapValue = {};
  if (depSourceRef) {
    let snapshotBytes = null;
    let snapshotSourceRef = null;
    if (refreshedSnapshotContent !== null && refreshedSnapshotPath === depSourceRef) {
      snapshotBytes = refreshedSnapshotContent;
      snapshotSourceRef = refreshedSnapshotPath;
    } else {
      const depAbsolute = join(target, depSourceRef);
      if (existsSync(depAbsolute)) {
        try { snapshotBytes = readFileSync(depAbsolute, 'utf8'); } catch { /* null */ }
      }
      snapshotSourceRef = depSourceRef;
    }
    if (snapshotBytes !== null) {
      const parsed = parseDependencySnapshot(snapshotBytes, { sourceRef: snapshotSourceRef });
      if (!parsed.ok) {
        return { ok: false, skipped: false, reason: `dependency snapshot parse failed: ${parsed.errors.join('; ')}`, expectedDigest: null, content: null, path: null };
      }
      depEvidence = parsed.evidence;
      depStatusMapValue = dependencyStatusMap(depEvidence);
    }
  } else {
    const now = Date.now();
    const maxAgeSeconds = decompositionSource.freshnessPolicy?.maxAgeSeconds ?? 3600;
    depEvidence = {
      source: 'files:.agenticloop/tasks',
      digest: `sha256:${createHash('sha256').update('').digest('hex')}`,
      observedAt: new Date(now).toISOString(),
      evaluatedAt: new Date(now).toISOString(),
      freshnessPolicy: { maxAgeSeconds },
      freshnessState: 'current',
      evaluatedState: 'satisfied',
      statuses: [],
      revalidationArgs: ['--dependencies', 'none'],
    };
    depStatusMapValue = {};
  }
  const tasksDir = join(target, '.agenticloop', 'tasks');
  if (!existsSync(tasksDir)) {
    return { ok: false, skipped: false, reason: 'tasks directory not found', expectedDigest: null, content: null, path: null };
  }
  const taskFiles = readdirSync(tasksDir).filter(f => f.endsWith('.md')).sort();
  if (taskFiles.length === 0) {
    return { ok: false, skipped: false, reason: 'no task carrier files found', expectedDigest: null, content: null, path: null };
  }
  const inventoryEntries = [];
  for (const file of taskFiles) {
    const carrier = `.agenticloop/tasks/${file}`;
    try {
      const content = readFileSync(join(target, carrier), 'utf8');
      inventoryEntries.push({ carrier, content, readError: null });
    } catch {
      return { ok: false, skipped: false, reason: `task carrier unreadable: ${carrier}`, expectedDigest: null, content: null, path: null };
    }
  }
  const treeResult = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  if (treeResult.status !== 0) {
    return { ok: false, skipped: false, reason: 'could not resolve HEAD^{tree}', expectedDigest: null, content: null, path: null };
  }
  const treeOid = treeResult.stdout.trim();
  const lsResult = spawnSync('git', ['ls-tree', '-r', '--name-only', treeOid], { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  if (lsResult.status !== 0) {
    return { ok: false, skipped: false, reason: 'could not list tree paths', expectedDigest: null, content: null, path: null };
  }
  const basePaths = lsResult.stdout.split(/\r?\n/).filter(Boolean);
  const observedAt = new Date().toISOString();
  const inventoryId = scan.inventory?.id ?? 'files:.agenticloop/tasks';
  const inventory = normalizeFilesTaskInventory({
    inventoryId,
    entries: inventoryEntries,
    complete: true,
    enumeration: createTaskInventoryEnumeration({
      backend: 'files',
      inventoryId,
      observedAt,
      discovered: inventoryEntries.length,
      returned: inventoryEntries.length,
    }),
  });
  const baseEvidence = {
    kind: 'git_tree',
    identity: `git-tree:${treeOid}`,
    inventoryDigest: `sha256:${createHash('sha256').update(canonicalJson([...basePaths].sort())).digest('hex')}`,
    pathCount: basePaths.length,
    revalidationArgs: ['--base', treeOid],
  };
  const readinessContext = {
    base: baseEvidence,
    dependencies: depEvidence,
  };
  let scanned;
  try {
    scanned = evaluateParallelScan({
      workUnit: scan.workUnit,
      inventory,
      decomposition: {
        source: scan.decomposition?.source ?? 'task-decomposition',
        sourceRef: decompositionRef,
        revision: scan.decomposition?.revision ?? `git-commit:${treeOid}`,
        declaredCompleteness: scan.decomposition?.declaredCompleteness ?? 'complete',
        attribution: scan.decomposition?.attribution ?? 'maintainer',
      },
      observedAt,
      freshnessPolicy: decompositionSource.freshnessPolicy ?? { maxAgeSeconds: 3600 },
      basePaths,
      dependencies: depStatusMapValue,
      readinessContext,
      rescanTrigger: scan.rescanTrigger ?? 'derived-evidence refresh',
    });
  } catch (error) {
    return { ok: false, skipped: false, reason: `parallel scan threw: ${error.message}`, expectedDigest: null, content: null, path: null };
  }
  if (!scanned.ok) {
    return { ok: false, skipped: false, reason: `parallel scan failed: ${scanned.result?.errors?.join('; ') ?? 'unknown error'}`, expectedDigest: null, content: null, path: null };
  }
  let decomposition;
  try {
    decomposition = createDecompositionProvenance({
      taskId,
      scan: scanned.scan,
      route: decompositionSource.route ?? 'serial',
      sourceRef: decompositionRef,
    });
  } catch (error) {
    return { ok: false, skipped: false, reason: `decomposition provenance creation failed: ${error.message}`, expectedDigest: null, content: null, path: null };
  }
  const content = `${canonicalJson(decomposition)}\n`;
  const currentDigest = existsSync(decompositionPath) ? byteDigest(readFileSync(decompositionPath)) : null;
  return {
    ok: true,
    skipped: false,
    reason: 'decomposition provenance regenerated from current facts',
    expectedDigest: currentDigest,
    content,
    path: decompositionRef,
    decomposition,
  };
}

function deriveDependencySnapshotFromDecomposition(target, taskId) {
  const decompositionRef = `.agenticloop/decompositions/${taskId}.json`;
  const decompositionPath = join(target, decompositionRef);
  if (!existsSync(decompositionPath)) {
    return { ok: false, reason: 'decomposition not found on disk', path: null, content: null, expectedDigest: null };
  }
  let decompositionSource;
  try {
    decompositionSource = JSON.parse(readFileSync(decompositionPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'decomposition is unreadable', path: null, content: null, expectedDigest: null };
  }
  const depSourceRef = decompositionSource?.scan?.readinessContext?.dependencies?.sourceRef ?? null;
  if (!depSourceRef) {
    return { ok: false, reason: 'decomposition has no dependency snapshot sourceRef', path: null, content: null, expectedDigest: null };
  }
  if (!isSafeRelativePath(depSourceRef) || !depSourceRef.endsWith('.json')) {
    return { ok: false, reason: `dependency snapshot path is not a safe JSON path: ${depSourceRef}`, path: null, content: null, expectedDigest: null };
  }
  if (PROTECTED_WORKFLOW_PREFIXES.some(prefix => depSourceRef.startsWith(prefix))) {
    return { ok: false, reason: `dependency snapshot path collides with workflow state: ${depSourceRef}`, path: null, content: null, expectedDigest: null };
  }
  const depAbsolute = join(target, depSourceRef);
  if (!existsSync(depAbsolute)) {
    return { ok: false, reason: `dependency snapshot not found at ${depSourceRef}`, path: null, content: null, expectedDigest: null };
  }
  let content;
  try {
    content = readFileSync(depAbsolute, 'utf8');
  } catch {
    return { ok: false, reason: `dependency snapshot unreadable at ${depSourceRef}`, path: null, content: null, expectedDigest: null };
  }
  const expectedDigest = decompositionSource?.scan?.readinessContext?.dependencies?.digest ?? null;
  if (expectedDigest === null) {
    return { ok: false, reason: 'decomposition binds no dependency snapshot digest', path: null, content: null, expectedDigest: null };
  }
  let snapshotObservedAt;
  try { snapshotObservedAt = JSON.parse(content)?.observedAt; } catch { /* will be caught below */ }
  const snapshotNow = snapshotObservedAt ? Date.parse(snapshotObservedAt) + 1000 : Date.now();
  const parsed = parseDependencySnapshot(content, { sourceRef: depSourceRef, now: snapshotNow });
  if (!parsed.ok) {
    return { ok: false, reason: `dependency snapshot is malformed: ${parsed.errors[0]}`, path: null, content: null, expectedDigest: null };
  }
  if (parsed.evidence.digest !== expectedDigest) {
    return { ok: false, reason: `dependency snapshot digest ${parsed.evidence.digest} does not match decomposition binding ${expectedDigest}`, path: null, content: null, expectedDigest: null };
  }
  return { ok: true, reason: null, path: depSourceRef, content, expectedDigest: parsed.evidence.digest };
}

function collectCarrierDigests(target) {
  const tasksDir = join(target, '.agenticloop', 'tasks');
  if (!existsSync(tasksDir)) return { digests: [], carrierDigest: byteDigest('') };
  const files = readdirSync(tasksDir).filter(f => f.endsWith('.md')).sort();
  const digests = files.map(f => {
    const carrierPath = `.agenticloop/tasks/${f}`;
    const content = readFileSync(join(target, carrierPath), 'utf8');
    return { path: carrierPath, digest: byteDigest(content) };
  });
  return { digests, carrierDigest: byteDigest(canonicalJson(digests)) };
}

export function createHandoffEvidenceRefreshPlan({ target, preflight }) {
  if (!isObject(preflight) || preflight.kind !== 'agenticloop.handoff-preflight') throw new TypeError('handoff refresh requires one handoff-preflight result');
  const taskId = safeTaskId(preflight.taskId);
  if (!TASK_ID_RE.test(taskId)) throw new TypeError('handoff refresh requires a valid task id');
  if (preflight.backend !== 'files') throw new TypeError('handoff evidence refresh currently supports only the files backend');
  if (!preflight.carrierDigest || !preflight.contractDigest || !preflight.repository?.head) throw new TypeError('handoff refresh requires current carrier, protected contract, and repository identities');

  // Category 1: Receipt (always)
  const proposed = createReceipt({ target, preflight });
  const receiptPath = handoffRefreshRelativePath(taskId);
  const receiptAbsolute = resolveTargetPath(target, receiptPath);
  const receiptExpected = existsSync(receiptAbsolute)
    ? { path: receiptPath, digest: byteDigest(readFileSync(receiptAbsolute)) }
    : { path: receiptPath, digest: null };

  // Category 2: Dependency-status observation refresh
  const depAgeState = preflight?.dependencyAge?.state;
  let depResult = { ok: false, skipped: true, reason: 'dependency refresh not triggered', expectedDigest: null, content: null, path: null, snapshot: null, statusMap: null };
  if (depAgeState !== 'observed') {
    depResult = attemptDependencySnapshotRefresh({ target, preflight });
  }

  // Category 3: Decomposition provenance regeneration
  // Pairing rule: dependency snapshot renewal forces decomposition regeneration
  // so the new decomposition binds the renewed snapshot regardless of the
  // decomposition's own dispatch compatibility state.
  const decompCompatible = preflight?.decomposition?.dispatchCompatible === true;
  const refreshedSnapshotContent = depResult.ok ? depResult.content : null;
  const refreshedSnapshotPath = depResult.ok ? depResult.path : null;
  let decompResult = { ok: false, skipped: true, reason: 'decomposition regeneration not triggered', expectedDigest: null, content: null, path: null };
  if (!decompCompatible || depResult.ok) {
    decompResult = attemptDecompositionRegeneration({ target, preflight, taskId, refreshedSnapshotContent, refreshedSnapshotPath });
  }
  if (depResult.ok && !decompResult.ok) {
    depResult = {
      ok: false,
      skipped: false,
      reason: `dependency snapshot renewal requires paired decomposition regeneration; ${decompResult.reason}`,
      expectedDigest: null,
      content: null,
      path: null,
      snapshot: null,
      statusMap: null,
    };
  }

  // Category 4: Dispatch fields (populated in receipt via projectionFromPreflight)
  let hasDispatchConsumption = false;
  try {
    const consumption = currentDispatchConsumption(target, taskId);
    hasDispatchConsumption = consumption.ok && consumption.record !== null;
  } catch {
    // Non-fatal.
  }

  // Build categories
  const categories = [
    { category: 'receipt', action: 'refreshed', reason: 'receipt refreshed from current preflight' },
    {
      category: 'dependency_observation',
      action: depResult.ok ? 'refreshed' : (depResult.skipped ? 'not_applicable' : 'requires_maintainer_observation'),
      reason: depResult.reason,
    },
    {
      category: 'decomposition_provenance',
      action: decompResult.ok ? 'refreshed' : (decompResult.skipped ? 'not_applicable' : 'requires_maintainer_regeneration'),
      reason: decompResult.reason,
    },
    {
      category: 'dispatch',
      action: hasDispatchConsumption ? 'refreshed' : 'not_applicable',
      reason: hasDispatchConsumption ? 'dispatch consumption populated from current record' : 'no dispatch consumption record exists',
    },
  ];

  // Build changedFiles and additionalWrites
  const changedFiles = [receiptPath];
  const additionalWrites = [];
  if (depResult.ok) {
    changedFiles.push(depResult.path);
    additionalWrites.push({ path: depResult.path, expectedDigest: depResult.expectedDigest, content: depResult.content });
  }
  if (decompResult.ok) {
    changedFiles.push(decompResult.path);
    additionalWrites.push({ path: decompResult.path, expectedDigest: decompResult.expectedDigest, content: decompResult.content });
  }

  // Build inputs (F4): pin derivation inputs into the plan
  const depDerived = deriveDependencySnapshotFromDecomposition(target, taskId);
  const decompPath = join(target, '.agenticloop', 'decompositions', `${taskId}.json`);
  const decompContent = existsSync(decompPath) ? readFileSync(decompPath, 'utf8') : null;
  const { carrierDigest } = collectCarrierDigests(target);
  const planInputs = {
    dependencySnapshot: depDerived.ok ? byteDigest(depDerived.content) : null,
    decomposition: decompContent !== null ? byteDigest(decompContent) : null,
    carriers: carrierDigest,
  };

  const observation = {
    ...projectionFromPreflight(preflight, target),
    taskId,
    backend: preflight.backend,
    carrier: preflight.carrier,
    carrierDigest: preflight.carrierDigest,
    contractDigest: preflight.contractDigest,
  };
  const plan = {
    kind: HANDOFF_REFRESH_PLAN_KIND,
    schemaVersion: HANDOFF_REFRESH_PLAN_SCHEMA_VERSION,
    targetRepository: targetRepositoryIdentity(target),
    taskId,
    backend: preflight.backend,
    carrier: preflight.carrier,
    carrierDigest: preflight.carrierDigest,
    contractDigest: preflight.contractDigest,
    source: {
      kind: 'agenticloop.handoff-preflight',
      schemaVersion: 1,
      observationDigest: `sha256:${canonicalSha256(observation)}`,
    },
    expected: receiptExpected,
    proposed,
    changedFiles,
    categories,
    additionalWrites,
    inputs: planInputs,
    authority: { state: 'derived_only', durableCommitRequired: true, durableCommit: null },
    digest: null,
  };
  plan.digest = `sha256:agenticloop.handoff-refresh-plan.v1:${canonicalSha256(withoutDigest(plan))}`;
  const checked = validateHandoffRefreshPlan(plan, { target, taskId });
  if (!checked.ok) throw new TypeError(checked.errors.join('; '));
  return Object.freeze(plan);
}

function currentObservation(preflight, target) {
  return {
    ...projectionFromPreflight(preflight, target),
    taskId: preflight?.taskId ?? null,
    backend: preflight?.backend ?? null,
    carrier: preflight?.carrier ?? null,
    carrierDigest: preflight?.carrierDigest ?? null,
    contractDigest: preflight?.contractDigest ?? null,
  };
}

export function applyHandoffEvidenceRefresh({ target, plan, preflight }) {
  if (Array.isArray(plan.additionalWrites) && plan.additionalWrites.length > 0) {
    const depDerived = deriveDependencySnapshotFromDecomposition(target, plan.taskId);
    if (!depDerived.ok) {
      const depDecompPath = join(target, '.agenticloop', 'decompositions', `${plan.taskId}.json`);
      let depSnapshotPath = null;
      try {
        const depDecomp = JSON.parse(readFileSync(depDecompPath, 'utf8'));
        depSnapshotPath = depDecomp?.scan?.readinessContext?.dependencies?.sourceRef ?? null;
      } catch { /* ignore */ }
      if (depSnapshotPath !== null && plan.additionalWrites.some(w => w.path === depSnapshotPath)) {
        return {
          ok: false,
          evidenceState: 'changed',
          disposition: 'superseded',
          errors: [`handoff refresh plan is stale: dependency snapshot binding re-derivation failed: ${depDerived.reason}`],
          changedFiles: [],
          firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
        };
      }
    }
  }
  const checked = validateHandoffRefreshPlan(plan, { target, taskId: preflight?.taskId ?? null });
  if (!checked.ok) return { ok: false, evidenceState: 'malformed', disposition: 'rejected', errors: checked.errors, changedFiles: [] };
  const expectedObservationDigest = plan.source.observationDigest;
  const actualObservationDigest = `sha256:${canonicalSha256(currentObservation(preflight, target))}`;
  if (actualObservationDigest !== expectedObservationDigest || preflight.carrierDigest !== plan.carrierDigest || preflight.contractDigest !== plan.contractDigest) {
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'superseded',
      errors: ['handoff refresh plan is stale: task, carrier, protected contract, repository, dependency, or decomposition evidence changed'],
      changedFiles: [],
      firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
    };
  }
  // Compare-before-write: check receipt expected digest
  const receiptPath = plan.expected.path;
  const receiptAbsolute = resolveTargetPath(target, receiptPath);
  const receiptCurrentDigest = existsSync(receiptAbsolute) ? byteDigest(readFileSync(receiptAbsolute)) : null;
  if (receiptCurrentDigest !== plan.expected.digest) {
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'superseded',
      errors: ['handoff refresh derived receipt changed since the plan was created'],
      changedFiles: [],
      firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
    };
  }
  // Compare-before-write: check additional files expected digests
  for (const entry of plan.additionalWrites) {
    const absolute = resolveTargetPath(target, entry.path);
    const currentDigest = existsSync(absolute) ? byteDigest(readFileSync(absolute)) : null;
    if (currentDigest !== entry.expectedDigest) {
      return {
        ok: false,
        evidenceState: 'changed',
        disposition: 'superseded',
        errors: [`handoff refresh additional file ${entry.path} changed since the plan was created`],
        changedFiles: [],
        firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
      };
    }
  }
  // F4: Compare-before-write: check inputs digests
  if (isObject(plan.inputs)) {
    const depDerived = deriveDependencySnapshotFromDecomposition(target, plan.taskId);
    const actualDepDigest = depDerived.ok ? byteDigest(depDerived.content) : null;
    if (actualDepDigest !== plan.inputs.dependencySnapshot) {
      return {
        ok: false,
        evidenceState: 'changed',
        disposition: 'superseded',
        errors: ['handoff refresh plan inputs.dependencySnapshot changed since the plan was created'],
        changedFiles: [],
        firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
      };
    }
    const decompPath = join(target, '.agenticloop', 'decompositions', `${plan.taskId}.json`);
    const actualDecompDigest = existsSync(decompPath) ? byteDigest(readFileSync(decompPath)) : null;
    if (actualDecompDigest !== plan.inputs.decomposition) {
      return {
        ok: false,
        evidenceState: 'changed',
        disposition: 'superseded',
        errors: ['handoff refresh plan inputs.decomposition changed since the plan was created'],
        changedFiles: [],
        firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
      };
    }
    const { carrierDigest: actualCarrierDigest } = collectCarrierDigests(target);
    if (actualCarrierDigest !== plan.inputs.carriers) {
      return {
        ok: false,
        evidenceState: 'changed',
        disposition: 'superseded',
        errors: ['handoff refresh plan inputs.carriers changed since the plan was created'],
        changedFiles: [],
        firstSafeRepair: 'Re-run task handoff-preflight with --repair-plan and apply the new plan.',
      };
    }
  }
  // Build mutations for all files
  const receiptContent = `${canonicalJson(plan.proposed)}\n`;
  const mutations = [
    plan.expected.digest === null
      ? { type: 'create', path: receiptPath, content: receiptContent }
      : { type: 'write', path: receiptPath, content: receiptContent, expectedDigest: plan.expected.digest, expectedKind: 'file' },
  ];
  for (const entry of plan.additionalWrites) {
    mutations.push(
      entry.expectedDigest === null
        ? { type: 'create', path: entry.path, content: entry.content }
        : { type: 'write', path: entry.path, content: entry.content, expectedDigest: entry.expectedDigest, expectedKind: 'file' },
    );
  }
  const applied = executeMutationBatch(target, mutations);
  if (!applied.ok) {
    return {
      ok: false,
      evidenceState: applied.stale ? 'changed' : 'negative',
      disposition: applied.stale ? 'superseded' : 'blocked',
      errors: [...applied.errors, ...applied.rollbackErrors],
      changedFiles: applied.writtenFiles,
    };
  }
  // Refetch and compare all written files
  // Receipt
  let written;
  try {
    written = JSON.parse(readFileSync(receiptAbsolute, 'utf8'));
  } catch (error) {
    return { ok: false, evidenceState: 'malformed', disposition: 'blocked', errors: [`refetched derived receipt is unreadable: ${error.message}`], changedFiles: applied.writtenFiles };
  }
  const receipt = validateHandoffRefreshReceipt(written, { target, taskId: plan.taskId });
  if (!receipt.ok || canonicalJson(written) !== canonicalJson(plan.proposed)) {
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'blocked',
      errors: [...receipt.errors, 'refetched derived receipt does not equal the planned validated candidate'],
      changedFiles: applied.writtenFiles,
    };
  }
  // Additional files
  for (const entry of plan.additionalWrites) {
    const absolute = resolveTargetPath(target, entry.path);
    let refetched;
    try {
      refetched = readFileSync(absolute, 'utf8');
    } catch (error) {
      return { ok: false, evidenceState: 'malformed', disposition: 'blocked', errors: [`refetched additional file ${entry.path} is unreadable: ${error.message}`], changedFiles: applied.writtenFiles };
    }
    if (refetched !== entry.content) {
      return {
        ok: false,
        evidenceState: 'changed',
        disposition: 'blocked',
        errors: [`refetched additional file ${entry.path} does not equal the planned content`],
        changedFiles: applied.writtenFiles,
      };
    }
  }
  return {
    ok: true,
    evidenceState: 'current',
    disposition: 'proceed',
    errors: [],
    changedFiles: applied.writtenFiles,
    receipt: written,
    authority: plan.authority,
    maintainerTrailerBlock: handoffRefreshMaintainerTrailerBlock(plan.taskId),
    attributionValidation: validateHandoffRefreshMaintainerTrailer(plan.taskId),
    firstSafeRepair: null,
  };
}
