/**
 * One validated, versioned evidence context and mutation receipt shared by the
 * files and GitHub task carriers.
 *
 * This module owns no transition semantics of its own: it reuses the canonical
 * transition vocabulary and validation-result JSON/digest utilities, plus
 * the evidence-state names already published by the shared contracts. Its only
 * job is to make the facts a guarded mutation consumed exact, complete, and
 * mechanically re-derivable.
 *
 * The evidence context is the pre-write input: task identity, expected
 * predecessor digest, resolved base identity and inventory digest, and the
 * dependency snapshot with its source, digest, observation time, freshness
 * policy, and evaluated state. The receipt is the post-write output: it binds
 * that exact context (by value and by derived digest), the candidate and
 * resulting digests, the verification-result identity, the owned projections,
 * the changed paths, the mutation disposition, and one safe, exact, read-only
 * revalidation command.
 *
 * A receipt never accepts a caller-supplied context digest. It is derived from
 * the context object actually used by pre-write and post-write validation, so a
 * receipt cannot advertise evidence a mutation did not consume.
 */

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { isReceiptRevalidationArgv } from './cli-registry.js';
import { GIT_OBJECT_ID_RE, GIT_TREE_IDENTITY_RE } from './git-oid.js';
import { TRANSITION_BACKENDS } from './transition-contract.js';

export const TASK_EVIDENCE_CONTEXT_KIND = 'agenticloop.task-evidence-context';
export const TASK_EVIDENCE_CONTEXT_SCHEMA_VERSION = 1;
export const TASK_READINESS_EVIDENCE_KIND = 'agenticloop.task-readiness-evidence';
export const TASK_READINESS_EVIDENCE_SCHEMA_VERSION = 1;
export const TASK_MUTATION_RECEIPT_KIND = 'agenticloop.task-mutation-receipt';
export const TASK_MUTATION_RECEIPT_SCHEMA_VERSION = 2;
export const DEPENDENCY_SNAPSHOT_KIND = 'agenticloop.dependency-snapshot';
export const DEPENDENCY_SNAPSHOT_SCHEMA_VERSION = 1;

/** Base evidence is either a resolved Git tree or an explicit path inventory. */
export const BASE_EVIDENCE_KINDS = Object.freeze(['git_tree', 'path_inventory']);

/** Freshness of the dependency snapshot against its own declared policy. */
export const DEPENDENCY_FRESHNESS_STATES = Object.freeze(['current', 'stale', 'unknown']);

/** Whether the observed dependency statuses satisfy the declared policy. */
export const DEPENDENCY_EVALUATED_STATES = Object.freeze(['satisfied', 'unsatisfied', 'indeterminate']);

/** Dependency statuses that count as satisfied for a readiness transition. */
export const SATISFIED_DEPENDENCY_STATUSES = Object.freeze(['resolved', 'accepted', 'closed']);

/**
 * Disposition of one attempted carrier mutation. `already_current` is the
 * validated no-op; `unresolved` means a mutation may have committed and the
 * exact final state could not be proven.
 */
export const TASK_MUTATION_DISPOSITIONS = Object.freeze([
  'committed',
  'already_current',
  'dry_run',
  'rolled_back',
  'uncommitted',
  'partially_committed',
  'unresolved',
]);

const FINAL_DISPOSITIONS = new Set(['committed', 'already_current', 'dry_run', 'rolled_back']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_TREE_IDENTITY_PATTERN = GIT_TREE_IDENTITY_RE;
const PATH_INVENTORY_IDENTITY_PATTERN = /^path-inventory:\S.*$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/**
 * The verification-result identity pinned by the transition contract as an
 * envelope constant, and the canonical digest form emitted for it.
 */
const VERIFICATION_RESULT_KIND = 'agenticloop.validation-result';
const VERIFICATION_DIGEST_PATTERN = /^sha256:agenticloop\.validation-result\.v1:[0-9a-f]{64}$/;

const PLACEHOLDER_PATTERN = /[<>]/;
/** Shell expansion that survives double quoting in POSIX shells, PowerShell, or both. */
const EXPANSION_PATTERN = /\$[({\w]|`/;

/**
 * Subcommands that mutate a durable carrier. A receipt's revalidation command
 * must never be one of these: a verifier that writes cannot prove what a prior
 * write produced.
 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(message) {
  throw new TypeError(message);
}

function stringList(value, label) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    fail(`${label} must be an array of strings`);
  }
  return [...value];
}

function assertExactKeys(value, label, allowedKeys) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) fail(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

/**
 * Characters that stay active inside a double-quoted string in at least one of
 * the three shells a reader might paste a revalidation command into:
 *
 *   `"` `'`   the quote characters themselves;
 *   `` ` ``   PowerShell's escape character;
 *   `$`       POSIX and PowerShell expansion and command substitution;
 *   `%` `!`   cmd.exe variable and delayed-expansion references.
 *
 * Everything else a path can contain — including `&`, `|`, `<`, `>`, `^`, and
 * parentheses — is inert inside double quotes in all three. POSIX shells also
 * collapse `\\` inside double quotes, and remove a backslash-newline pair, so
 * those forms cannot be emitted exactly across all three shells.
 */
const UNQUOTABLE_PATTERN = /["'`$%!\r\n]/;

/**
 * Quote one command argument so a copied revalidation command is inert in every
 * shell a reader might paste it into: POSIX shells, PowerShell, and cmd.exe.
 *
 * Double quotes are the only form all three honor. Single quotes quote nothing
 * at all in cmd.exe, so a single-quoted value carrying `&` runs its tail as a
 * second command there; that is why the safe-looking POSIX/PowerShell answer is
 * wrong for a cross-platform toolkit.
 *
 * A value containing a character from `UNQUOTABLE_PATTERN`, or a trailing,
 * doubled, newline-adjacent backslash, CR, or LF that double quotes cannot preserve
 * identically, has no representation that is simultaneously exact and inert
 * everywhere, so it is refused rather than emitted. A revalidation command that
 * cannot be pasted safely is not a verifier, and guessing at one would defeat
 * the point.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuoteArgument(value) {
  const text = String(value ?? '');
  if (text.length === 0) return '""';
  if (/^[A-Za-z0-9._:@/+-]+$/.test(text)) return text;
  if (UNQUOTABLE_PATTERN.test(text)) {
    fail(`cannot emit a shell-safe revalidation argument for ${JSON.stringify(text)}: quote, backtick, dollar sign, percent sign, exclamation mark, CR, and LF have no representation that is both exact and inert in POSIX shells, PowerShell, and cmd.exe`);
  }
  if (text.endsWith('\\') || text.includes('\\\\') || /\\\r?\n/.test(text)) {
    fail(`cannot emit a shell-safe revalidation argument for ${JSON.stringify(text)}: a trailing, doubled, or newline-adjacent backslash cannot be represented exactly inside double quotes in every supported shell`);
  }
  return `"${text}"`;
}

// ---------------------------------------------------------------------------
// Dependency snapshot
// ---------------------------------------------------------------------------

function evaluateDependencyStatuses(statuses) {
  const entries = Object.entries(statuses);
  // An explicitly supplied empty map is positive evidence that the task has no
  // dependencies. It is distinct from an omitted dependency snapshot, which
  // guarded readiness transitions reject before this evaluator is reached.
  if (entries.length === 0) return 'satisfied';
  return entries.every(([, status]) => SATISFIED_DEPENDENCY_STATUSES.includes(status))
    ? 'satisfied'
    : 'unsatisfied';
}

/**
 * Parse and validate one dependency-status snapshot document.
 *
 * The snapshot must name its own source identity, observation time, freshness
 * policy, and statuses. A bare `{id: status}` map has none of those facts and
 * is rejected as malformed rather than silently accepted: missing provenance is
 * not evidence of a satisfied dependency.
 *
 * @param {string} source  Raw document bytes.
 * @param {{sourceRef: string, now?: number, digest?: string, provenance?: object|null}} options
 * @returns {{ok: boolean, errors: string[], evidence: object|null}}
 */
export function parseDependencySnapshot(source, { sourceRef, now = Date.now(), digest = null, provenance = null } = {}) {
  const text = String(source ?? '');
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, errors: [`dependency snapshot '${sourceRef}' is not valid JSON`], evidence: null };
  }
  const errors = [];
  if (!isPlainObject(document)) {
    return { ok: false, errors: [`dependency snapshot '${sourceRef}' must be a JSON object`], evidence: null };
  }
  if (document.kind !== DEPENDENCY_SNAPSHOT_KIND) {
    errors.push(`dependency snapshot kind must be '${DEPENDENCY_SNAPSHOT_KIND}'`);
  }
  if (document.schemaVersion !== DEPENDENCY_SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`dependency snapshot schemaVersion must be ${DEPENDENCY_SNAPSHOT_SCHEMA_VERSION}`);
  }
  const unknownFields = Object.keys(document).filter(key => ![
    'kind', 'schemaVersion', 'source', 'observedAt', 'freshnessPolicy', 'statuses',
  ].includes(key));
  if (unknownFields.length > 0) errors.push(`dependency snapshot contains unknown fields: ${unknownFields.join(', ')}`);
  if (!nonEmptyString(document.source)) {
    errors.push('dependency snapshot requires a non-empty source identity');
  }
  if (!nonEmptyString(document.observedAt) || !ISO_INSTANT_PATTERN.test(document.observedAt)) {
    errors.push("dependency snapshot observedAt must be an ISO-8601 UTC instant such as '2026-07-29T10:00:00.000Z'");
  }
  const maxAgeSeconds = document.freshnessPolicy?.maxAgeSeconds;
  if (!isPlainObject(document.freshnessPolicy) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    errors.push('dependency snapshot freshnessPolicy must be { maxAgeSeconds: <positive integer> }');
  } else if (Object.keys(document.freshnessPolicy).some(key => key !== 'maxAgeSeconds')) {
    errors.push('dependency snapshot freshnessPolicy contains unknown fields');
  }
  if (!isPlainObject(document.statuses) ||
      Object.entries(document.statuses).some(([id, status]) => !nonEmptyString(id) || !nonEmptyString(status))) {
    errors.push('dependency snapshot statuses must map dependency ids to non-empty status strings');
  }
  if (errors.length > 0) return { ok: false, errors, evidence: null };

  const observedAt = Date.parse(document.observedAt);
  const ageSeconds = (now - observedAt) / 1000;
  if (ageSeconds < 0) {
    return {
      ok: false,
      errors: [`dependency snapshot '${sourceRef}' was observed in the future (${document.observedAt}); refusing to treat it as evidence`],
      evidence: null,
    };
  }
  if (ageSeconds > maxAgeSeconds) {
    return {
      ok: false,
      errors: [`dependency snapshot '${sourceRef}' is stale: observed ${Math.floor(ageSeconds)}s ago, policy allows ${maxAgeSeconds}s`],
      evidence: null,
    };
  }

  const statuses = Object.entries(document.statuses)
    .map(([id, status]) => ({ id, status }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    ok: true,
    errors: [],
    evidence: {
      source: String(document.source),
      digest: digest ?? `sha256:${canonicalSha256(text)}`,
      observedAt: document.observedAt,
      evaluatedAt: new Date(now).toISOString(),
      freshnessPolicy: { maxAgeSeconds },
      freshnessState: 'current',
      evaluatedState: evaluateDependencyStatuses(document.statuses),
      statuses,
      revalidationArgs: ['--dependencies', sourceRef],
      ...(provenance === null ? {} : { provenance }),
    },
  };
}

/** Dependency statuses projected as the `{id: status}` map readiness consumes. */
export function dependencyStatusMap(evidence) {
  return Object.fromEntries((evidence?.statuses ?? []).map(item => [item.id, item.status]));
}

// ---------------------------------------------------------------------------
// Evidence context
// ---------------------------------------------------------------------------

function normalizeBaseEvidence(base) {
  if (!isPlainObject(base)) fail('base evidence is required and must be an object');
  assertExactKeys(base, 'base evidence', ['kind', 'identity', 'inventoryDigest', 'pathCount', 'revalidationArgs']);
  if (!BASE_EVIDENCE_KINDS.includes(base.kind)) {
    fail(`base evidence kind must be one of: ${BASE_EVIDENCE_KINDS.join(', ')}`);
  }
  if (!nonEmptyString(base.identity)) fail('base evidence identity must be a non-empty string');
  if (base.kind === 'git_tree') {
    if (!base.identity.startsWith('git-tree:')) {
      fail("base evidence identity for a git_tree base must start with 'git-tree:'");
    }
    if (!GIT_TREE_IDENTITY_PATTERN.test(base.identity)) {
      fail(`base evidence must bind a resolved git tree object id, not the symbolic reference '${base.identity.slice('git-tree:'.length)}'`);
    }
  } else if (!PATH_INVENTORY_IDENTITY_PATTERN.test(base.identity)) {
    fail("path inventory evidence must use a path-inventory identity such as 'path-inventory:<relative-path>'");
  }
  if (!DIGEST_PATTERN.test(String(base.inventoryDigest ?? ''))) {
    fail('base evidence inventoryDigest must be a sha256:<64 lowercase hex> digest');
  }
  if (!Number.isSafeInteger(base.pathCount) || base.pathCount < 0) {
    fail('base evidence pathCount must be a non-negative safe integer');
  }
  const revalidationArgs = stringList(base.revalidationArgs, 'base evidence revalidationArgs');
  if (revalidationArgs.length === 0) fail('base evidence must carry the exact revalidation arguments');
  return {
    kind: base.kind,
    identity: base.identity,
    inventoryDigest: base.inventoryDigest,
    pathCount: base.pathCount,
    revalidationArgs,
  };
}

function normalizeDependencyEvidence(dependencies) {
  if (!isPlainObject(dependencies)) fail('dependency evidence is required and must be an object');
  const dependencyFields = [
    'source', 'digest', 'observedAt', 'evaluatedAt', 'freshnessPolicy',
    'freshnessState', 'evaluatedState', 'statuses', 'revalidationArgs',
  ];
  if (Object.hasOwn(dependencies, 'provenance')) dependencyFields.push('provenance');
  assertExactKeys(dependencies, 'dependency evidence', dependencyFields);
  assertExactKeys(dependencies.freshnessPolicy, 'dependency evidence freshnessPolicy', ['maxAgeSeconds']);
  if (!nonEmptyString(dependencies.source)) fail('dependency evidence requires a source identity');
  if (!DIGEST_PATTERN.test(String(dependencies.digest ?? ''))) {
    fail('dependency evidence digest must be a sha256:<64 lowercase hex> digest');
  }
  if (!nonEmptyString(dependencies.observedAt) || !ISO_INSTANT_PATTERN.test(dependencies.observedAt)) {
    fail('dependency evidence observedAt must be an ISO-8601 UTC instant');
  }
  if (!nonEmptyString(dependencies.evaluatedAt) || !ISO_INSTANT_PATTERN.test(dependencies.evaluatedAt)) {
    fail('dependency evidence evaluatedAt must be an ISO-8601 UTC instant');
  }
  const maxAgeSeconds = dependencies.freshnessPolicy?.maxAgeSeconds;
  if (!isPlainObject(dependencies.freshnessPolicy) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    fail('dependency evidence freshnessPolicy must be { maxAgeSeconds: <positive integer> }');
  }
  if (!DEPENDENCY_FRESHNESS_STATES.includes(dependencies.freshnessState)) {
    fail(`dependency evidence freshnessState must be one of: ${DEPENDENCY_FRESHNESS_STATES.join(', ')}`);
  }
  if (!DEPENDENCY_EVALUATED_STATES.includes(dependencies.evaluatedState)) {
    fail(`dependency evidence evaluatedState must be one of: ${DEPENDENCY_EVALUATED_STATES.join(', ')}`);
  }
  if (!Array.isArray(dependencies.statuses) ||
      !dependencies.statuses.every(item => {
        try {
          assertExactKeys(item, 'dependency evidence status', ['id', 'status']);
          return nonEmptyString(item.id) && nonEmptyString(item.status);
        } catch {
          return false;
        }
      })) {
    fail('dependency evidence statuses must be an array of { id, status } entries');
  }
  const statusIds = dependencies.statuses.map(item => item.id);
  if (new Set(statusIds).size !== statusIds.length) {
    fail('dependency evidence statuses must not contain duplicate dependency ids');
  }
  const observedAt = Date.parse(dependencies.observedAt);
  const evaluatedAt = Date.parse(dependencies.evaluatedAt);
  const ageSeconds = (evaluatedAt - observedAt) / 1000;
  if (!Number.isFinite(observedAt) || !Number.isFinite(evaluatedAt) || ageSeconds < 0) {
    fail('dependency evidence evaluatedAt must be at or after observedAt');
  }
  const derivedFreshnessState = ageSeconds > maxAgeSeconds ? 'stale' : 'current';
  if (dependencies.freshnessState !== derivedFreshnessState) {
    fail(`dependency evidence freshnessState must be '${derivedFreshnessState}' for observedAt and freshnessPolicy`);
  }
  const statusMap = Object.fromEntries(dependencies.statuses.map(item => [item.id, item.status]));
  const derivedEvaluatedState = derivedFreshnessState === 'current'
    ? evaluateDependencyStatuses(statusMap)
    : 'indeterminate';
  if (dependencies.evaluatedState !== derivedEvaluatedState) {
    fail(`dependency evidence evaluatedState must be '${derivedEvaluatedState}' for its freshness and statuses`);
  }
  const revalidationArgs = stringList(dependencies.revalidationArgs, 'dependency evidence revalidationArgs');
  if (revalidationArgs.length === 0) fail('dependency evidence must carry the exact revalidation arguments');
  if (Object.hasOwn(dependencies, 'provenance')) {
    assertExactKeys(dependencies.provenance, 'dependency evidence provenance', ['path', 'blob', 'commit', 'role']);
    if (!nonEmptyString(dependencies.provenance?.path) ||
        !/^[A-Za-z0-9._/-]+$/.test(dependencies.provenance.path) ||
        dependencies.provenance.path.startsWith('/') ||
        dependencies.provenance.path.includes('\\') ||
        dependencies.provenance.path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      fail('dependency evidence provenance path must be a safe canonical repository-relative path');
    }
    if (!GIT_OBJECT_ID_RE.test(String(dependencies.provenance?.blob ?? ''))) {
      fail('dependency evidence provenance blob must be an exact Git object identity');
    }
    if (!GIT_OBJECT_ID_RE.test(String(dependencies.provenance?.commit ?? ''))) {
      fail('dependency evidence provenance commit must be an exact Git commit identity');
    }
    if (dependencies.provenance?.role !== 'maintainer') {
      fail('dependency evidence provenance role must be maintainer');
    }
  }
  return {
    source: dependencies.source,
    digest: dependencies.digest,
    observedAt: dependencies.observedAt,
    evaluatedAt: dependencies.evaluatedAt,
    freshnessPolicy: { maxAgeSeconds },
    freshnessState: dependencies.freshnessState,
    evaluatedState: dependencies.evaluatedState,
    statuses: dependencies.statuses
      .map(item => ({ id: item.id, status: item.status }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    revalidationArgs,
    ...(Object.hasOwn(dependencies, 'provenance') ? { provenance: {
      path: dependencies.provenance.path,
      blob: dependencies.provenance.blob,
      commit: dependencies.provenance.commit,
      role: dependencies.provenance.role,
    } } : {}),
  };
}

/**
 * Normalize base evidence outside a full readiness-evidence record.
 *
 * Other evaluators (the parallel scan binds the base inventory its ready set
 * was derived from) need exactly this contract without inventing a second
 * base-evidence schema. Throws on any violation, like every other normalizer
 * here.
 *
 * @param {unknown} base
 */
export function normalizeReadinessBaseEvidence(base) {
  return normalizeBaseEvidence(base);
}

/**
 * Normalize dependency evidence outside a full readiness-evidence record.
 * Same contract, same code path, no second dependency schema.
 *
 * @param {unknown} dependencies
 */
export function normalizeReadinessDependencyEvidence(dependencies) {
  return normalizeDependencyEvidence(dependencies);
}

// ---------------------------------------------------------------------------
// Shared structural assertions
//
// Construction and validation enforce the same rules through the same code.
// An evidence object that reaches a later process, a persisted receipt, or a
// cross-carrier handoff is held to exactly the contract its builder applied;
// otherwise the validator becomes a weaker second contract and the objects it
// blesses are trusted on the strength of a check that never happened.
// ---------------------------------------------------------------------------

function assertContextBackend(backend) {
  if (!TRANSITION_BACKENDS.includes(backend)) {
    fail(`evidence context backend must be one of: ${TRANSITION_BACKENDS.join(', ')}`);
  }
  return backend;
}

function assertContextTaskIdentity(task) {
  assertExactKeys(task, 'evidence context task identity', ['id', 'carrier', 'expectedDigest']);
  if (!isPlainObject(task)) fail('evidence context task identity is required');
  if (!nonEmptyString(task.id)) fail('evidence context task id must be a non-empty string');
  if (!nonEmptyString(task.carrier)) fail('evidence context task carrier must be a non-empty string');
  if (!DIGEST_PATTERN.test(String(task.expectedDigest ?? ''))) {
    fail('evidence context task expectedDigest must be a sha256:<64 lowercase hex> digest');
  }
  return { id: task.id, carrier: task.carrier, expectedDigest: task.expectedDigest };
}

function assertContextTransition(transition) {
  assertExactKeys(transition, 'evidence context transition', ['fromStatus', 'toStatus']);
  if (!isPlainObject(transition)) fail('evidence context transition is required');
  if (!nonEmptyString(transition.fromStatus)) fail('evidence context transition fromStatus is required');
  if (!nonEmptyString(transition.toStatus)) fail('evidence context transition toStatus is required');
  if (transition.fromStatus === transition.toStatus) {
    fail('evidence context transition must change the task status');
  }
  return { fromStatus: transition.fromStatus, toStatus: transition.toStatus };
}

/**
 * Every structural rule a mutation receipt must satisfy, whether it was just
 * built or arrived from another process.
 *
 * Rules are collected rather than thrown one at a time so a malformed receipt
 * reports everything wrong with it in one pass; a caller repairing a persisted
 * receipt should not have to rediscover the next defect on every attempt.
 *
 * @param {object} receipt  A receipt-shaped object; field names match the built form.
 * @returns {string[]} every violated rule, empty when the receipt is well formed
 */
function receiptShapeErrors(receipt) {
  const errors = [];
  const rule = check => {
    try {
      check();
    } catch (error) {
      errors.push(error.message);
    }
  };
  rule(() => {
    if (!TRANSITION_BACKENDS.includes(receipt.backend)) {
      fail(`mutation receipt backend must be one of: ${TRANSITION_BACKENDS.join(', ')}`);
    }
  });
  rule(() => {
    assertExactKeys(receipt.task, 'mutation receipt task identity', ['id', 'carrier']);
    if (!isPlainObject(receipt.task)) fail('mutation receipt task identity is required');
    if (!nonEmptyString(receipt.task.id)) fail('mutation receipt task id is required');
    if (!nonEmptyString(receipt.task.carrier)) fail('mutation receipt task carrier is required');
  });
  rule(() => {
    assertExactKeys(receipt.verification, 'mutation receipt verification', ['resultKind', 'digest']);
    if (receipt.expectedDigest !== null && !DIGEST_PATTERN.test(String(receipt.expectedDigest))) {
      fail('mutation receipt expectedDigest must be a sha256 digest or null');
    }
  });
  rule(() => {
    if (!DIGEST_PATTERN.test(String(receipt.candidateDigest ?? ''))) {
      fail('mutation receipt candidateDigest must be a sha256 digest');
    }
  });
  rule(() => {
    if (receipt.resultingDigest !== null && !DIGEST_PATTERN.test(String(receipt.resultingDigest))) {
      fail('mutation receipt resultingDigest must be a sha256 digest or null');
    }
  });
  rule(() => {
    if (!TASK_MUTATION_DISPOSITIONS.includes(receipt.mutationDisposition)) {
      fail(`mutation receipt mutationDisposition must be one of: ${TASK_MUTATION_DISPOSITIONS.join(', ')}`);
    }
    if (['committed', 'rolled_back'].includes(receipt.mutationDisposition) && receipt.resultingDigest === null) {
      fail(`a ${receipt.mutationDisposition} mutation requires a resulting digest read back from the carrier`);
    }
  });
  rule(() => {
    if (!isPlainObject(receipt.verification)) {
      fail('mutation receipt verification requires { resultKind, digest }');
    }
    // The verification identity is the one the transition contract pins as
    // an envelope constant. An arbitrary kind or a free-text digest would let a
    // receipt cite a verification no shared contract defines.
    if (receipt.verification.resultKind !== VERIFICATION_RESULT_KIND) {
      fail(`mutation receipt verification resultKind must be '${VERIFICATION_RESULT_KIND}'`);
    }
    if (!VERIFICATION_DIGEST_PATTERN.test(String(receipt.verification.digest ?? ''))) {
      fail(`mutation receipt verification digest must be a canonical '${VERIFICATION_RESULT_KIND}' digest`);
    }
  });
  rule(() => stringList(receipt.ownedProjections ?? [], 'mutation receipt ownedProjections'));
  rule(() => {
    if (!Array.isArray(receipt.projections)) fail('mutation receipt projections must be an array');
    const names = new Set();
    for (const projection of receipt.projections) {
      assertExactKeys(projection, 'mutation receipt projection', ['name', 'owned', 'attempted', 'complete']);
      if (!nonEmptyString(projection.name)) fail('mutation receipt projection name is required');
      if (names.has(projection.name)) fail(`mutation receipt projections duplicate '${projection.name}'`);
      names.add(projection.name);
      if (projection.owned !== true || typeof projection.attempted !== 'boolean' || typeof projection.complete !== 'boolean') {
        fail(`mutation receipt projection '${projection.name}' must declare owned, attempted, and complete booleans`);
      }
    }
    const owned = [...names].sort();
    const declared = [...new Set(receipt.ownedProjections ?? [])].sort();
    if (JSON.stringify(owned) !== JSON.stringify(declared)) {
      fail('mutation receipt ownedProjections must exactly name the projection entries');
    }
    if (FINAL_DISPOSITIONS.has(receipt.mutationDisposition) && receipt.mutationDisposition !== 'dry_run' &&
        receipt.mutationDisposition !== 'rolled_back' && receipt.projections.some(item => !item.complete)) {
      fail(`final mutation disposition '${receipt.mutationDisposition}' cannot retain an incomplete projection`);
    }
  });
  rule(() => {
    const changedPaths = stringList(receipt.changedPaths ?? [], 'mutation receipt changedPaths');
    if (receipt.mutationDisposition === 'committed' && changedPaths.length === 0) {
      fail('a committed mutation must report at least one changed path');
    }
  });
  rule(() => {
    if (receipt.mutationDisposition === 'rolled_back' && receipt.rollback === null) {
      fail('a rolled_back mutation requires closed rollback evidence');
    }
    if (receipt.rollback === null) return;
    if (receipt.mutationDisposition !== 'rolled_back') {
      fail(`mutation disposition '${receipt.mutationDisposition}' cannot carry rollback evidence`);
    }
    assertExactKeys(receipt.rollback, 'mutation receipt rollback', ['attempted', 'restored', 'expectedDigest', 'resultingDigest', 'reason']);
    if (typeof receipt.rollback.attempted !== 'boolean' || typeof receipt.rollback.restored !== 'boolean' ||
        !DIGEST_PATTERN.test(String(receipt.rollback.expectedDigest ?? '')) ||
        !DIGEST_PATTERN.test(String(receipt.rollback.resultingDigest ?? '')) || !nonEmptyString(receipt.rollback.reason)) {
      fail('mutation receipt rollback must record attempted/restored facts, exact digests, and a reason');
    }
    if (!receipt.rollback.attempted || !receipt.rollback.restored ||
        receipt.rollback.expectedDigest !== receipt.expectedDigest ||
        receipt.rollback.resultingDigest !== receipt.resultingDigest ||
        receipt.expectedDigest !== receipt.resultingDigest ||
        receipt.changedPaths.length !== 0) {
      fail('a rolled_back mutation requires a proven exact restoration and zero changed paths');
    }
  });
  rule(() => assertReceiptRevalidationBinding(receipt));
  rule(() => {
    if (receipt.unresolved !== !FINAL_DISPOSITIONS.has(receipt.mutationDisposition)) {
      fail('mutation receipt unresolved flag contradicts its disposition');
    }
    if (receipt.unresolved && !nonEmptyString(receipt.recovery)) {
      fail(`mutation disposition '${receipt.mutationDisposition}' is unresolved and requires an exact recovery instruction`);
    }
    if (receipt.recovery !== null && typeof receipt.recovery !== 'string') {
      fail('mutation receipt recovery must be a string or null');
    }
  });
  return errors;
}

/**
 * Build one validated evidence context. Every caller of a guarded readiness
 * transition constructs this object before validating the current record, and
 * passes the same object to post-write validation and to the receipt.
 *
 * @param {object} input
 * @returns {object} frozen canonical evidence context
 */
export function createTaskEvidenceContext(input = {}) {
  if (!isPlainObject(input)) fail('evidence context input must be an object');
  assertExactKeys(input, 'evidence context input', ['backend', 'task', 'transition', 'base', 'dependencies']);
  assertContextBackend(input.backend);
  const task = assertContextTaskIdentity(input.task);
  const transition = assertContextTransition(input.transition);
  const context = {
    kind: TASK_EVIDENCE_CONTEXT_KIND,
    schemaVersion: TASK_EVIDENCE_CONTEXT_SCHEMA_VERSION,
    backend: input.backend,
    task: { id: task.id, carrier: task.carrier, expectedDigest: task.expectedDigest },
    transition: { fromStatus: transition.fromStatus, toStatus: transition.toStatus },
    base: normalizeBaseEvidence(input.base),
    dependencies: normalizeDependencyEvidence(input.dependencies),
  };
  const validation = validateTaskEvidenceContext(context);
  if (!validation.ok) fail(`invalid task evidence context: ${validation.errors.join('; ')}`);
  return Object.freeze(context);
}

/**
 * Validate an evidence context that arrived from a receipt or another process.
 *
 * @param {unknown} context
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTaskEvidenceContext(context) {
  const errors = [];
  if (!isPlainObject(context)) return { ok: false, errors: ['evidence context must be an object'] };
  try {
    assertExactKeys(context, 'evidence context', ['kind', 'schemaVersion', 'backend', 'task', 'transition', 'base', 'dependencies']);
  } catch (error) {
    errors.push(error.message);
  }
  if (context.kind !== TASK_EVIDENCE_CONTEXT_KIND) errors.push(`evidence context kind must be '${TASK_EVIDENCE_CONTEXT_KIND}'`);
  if (context.schemaVersion !== TASK_EVIDENCE_CONTEXT_SCHEMA_VERSION) {
    errors.push(`evidence context schemaVersion must be ${TASK_EVIDENCE_CONTEXT_SCHEMA_VERSION}`);
  }
  for (const assertion of [
    () => assertContextBackend(context.backend),
    () => assertContextTaskIdentity(context.task),
    () => assertContextTransition(context.transition),
    () => normalizeBaseEvidence(context.base),
    () => normalizeDependencyEvidence(context.dependencies),
    () => canonicalJson(context),
  ]) {
    try {
      assertion();
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build the evidence summary emitted by the read-only `task-readiness` command.
 *
 * This is deliberately not a mutation evidence context: a read-only evaluation
 * has no authoritative predecessor-to-successor transition, and dependencies
 * are optional outside a guarded `agent-ready` write.
 *
 * @param {object} input
 * @returns {object} frozen canonical readiness evidence
 */
export function createTaskReadinessEvidence(input = {}) {
  if (!isPlainObject(input)) fail('readiness evidence input must be an object');
  const task = assertContextTaskIdentity(input.task);
  const evidence = {
    kind: TASK_READINESS_EVIDENCE_KIND,
    schemaVersion: TASK_READINESS_EVIDENCE_SCHEMA_VERSION,
    backend: assertContextBackend(input.backend),
    task: { id: task.id, carrier: task.carrier, expectedDigest: task.expectedDigest },
    base: normalizeBaseEvidence(input.base),
    dependencies: input.dependencies === null || input.dependencies === undefined
      ? null
      : normalizeDependencyEvidence(input.dependencies),
    trustedRecordCount: input.trustedRecordCount,
    trustedRecordErrors: Array.isArray(input.trustedRecordErrors)
      ? [...input.trustedRecordErrors]
      : input.trustedRecordErrors,
  };
  const validation = validateTaskReadinessEvidence(evidence);
  if (!validation.ok) fail(`invalid task readiness evidence: ${validation.errors.join('; ')}`);
  return Object.freeze(evidence);
}

/**
 * Validate a read-only readiness-evidence summary from another process.
 *
 * @param {unknown} evidence
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTaskReadinessEvidence(evidence) {
  const errors = [];
  if (!isPlainObject(evidence)) {
    return { ok: false, errors: ['task readiness evidence must be an object'] };
  }
  const allowedKeys = new Set([
    'kind', 'schemaVersion', 'backend', 'task', 'base', 'dependencies',
    'trustedRecordCount', 'trustedRecordErrors',
  ]);
  const unknownKeys = Object.keys(evidence).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`task readiness evidence contains unknown fields: ${unknownKeys.join(', ')}`);
  }
  if (evidence.kind !== TASK_READINESS_EVIDENCE_KIND) {
    errors.push(`task readiness evidence kind must be '${TASK_READINESS_EVIDENCE_KIND}'`);
  }
  if (evidence.schemaVersion !== TASK_READINESS_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`task readiness evidence schemaVersion must be ${TASK_READINESS_EVIDENCE_SCHEMA_VERSION}`);
  }
  for (const assertion of [
    () => assertContextBackend(evidence.backend),
    () => assertContextTaskIdentity(evidence.task),
    () => normalizeBaseEvidence(evidence.base),
    () => {
      if (evidence.dependencies !== null) normalizeDependencyEvidence(evidence.dependencies);
    },
    () => {
      if (!Number.isSafeInteger(evidence.trustedRecordCount) || evidence.trustedRecordCount < 0) {
        fail('task readiness evidence trustedRecordCount must be a non-negative safe integer');
      }
    },
    () => {
      if (!Array.isArray(evidence.trustedRecordErrors) ||
          !evidence.trustedRecordErrors.every(error => typeof error === 'string')) {
        fail('task readiness evidence trustedRecordErrors must be an array of strings');
      }
    },
    () => canonicalJson(evidence),
  ]) {
    try {
      assertion();
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Deterministic digest of one validated evidence context. */
export function taskEvidenceContextDigest(context) {
  const validation = validateTaskEvidenceContext(context);
  if (!validation.ok) fail(`invalid task evidence context: ${validation.errors.join('; ')}`);
  return `sha256:agenticloop.task-evidence-context.v1:${canonicalSha256(context)}`;
}

// ---------------------------------------------------------------------------
// Mutation receipt
// ---------------------------------------------------------------------------

function parseRestrictedCommand(command) {
  if (/[\r\n]/.test(command)) fail('receipt revalidateCommand must not contain CR or LF');
  if (/['`$%!]/.test(command)) fail(`receipt revalidateCommand must be read-only and inert; cannot be parsed as restricted argv: '${command}'`);
  const tokens = [];
  let value = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) tokens.push(value);
      value = '';
      started = false;
      continue;
    }
    if (!quoted && /[&|;<>()[\]{}*?~]/.test(character)) {
      fail(`receipt revalidateCommand cannot be parsed as inert restricted argv: '${command}'`);
    }
    if (character === '\\') {
      const next = command[index + 1];
      if (!quoted || next === undefined || next === '\\' || next === '"' || next === '\r' || next === '\n') {
        fail(`receipt revalidateCommand cannot be parsed as inert restricted argv: '${command}'`);
      }
    }
    value += character;
    started = true;
  }
  if (quoted || !started && value) fail(`receipt revalidateCommand has unterminated or empty quoting: '${command}'`);
  if (started) tokens.push(value);
  if (tokens.length === 0 || tokens.some(token => !token)) fail(`receipt revalidateCommand cannot be parsed as inert restricted argv: '${command}'`);
  return tokens;
}

function agenticloopArgv(tokens) {
  const isBinary = token => /(?:^|\/)(?:agenticloop|agenticloop\.cmd)$/i.test(token) || /^agenticloop(?:\.cmd)?$/i.test(token);
  if (isBinary(tokens[0])) return tokens.slice(1);
  if (/^node(?:\.exe)?$/i.test(tokens[0]) && /(?:^|\/)bin\/agenticloop\.js$/i.test(tokens[1] ?? '')) return tokens.slice(2);
  if (/^npx(?:\.cmd)?$/i.test(tokens[0])) {
    let index = 1;
    while (tokens[index]?.startsWith('-')) {
      const option = tokens[index++];
      if (['--package', '-p'].includes(option)) index += 1;
    }
    if (isBinary(tokens[index])) return tokens.slice(index + 1);
  }
  if (/^pnpm(?:\.cmd)?$/i.test(tokens[0]) && tokens[1] === 'exec') {
    let index = 2;
    while (tokens[index]?.startsWith('-')) index += 1;
    if (isBinary(tokens[index])) return tokens.slice(index + 1);
  }
  fail(`receipt revalidateCommand does not use a supported inert Agentic Loop launcher: '${tokens.join(' ')}'`);
}

function assertReadOnlyRevalidation(command) {
  if (!nonEmptyString(command)) fail('receipt revalidateCommand must be a non-empty string');
  if (PLACEHOLDER_PATTERN.test(command)) {
    fail(`receipt revalidateCommand must be executable verbatim; it still contains a placeholder: ${command}`);
  }
  const argv = agenticloopArgv(parseRestrictedCommand(command));
  if (!isReceiptRevalidationArgv(argv)) {
    fail(`receipt revalidateCommand must be read-only; '${command}' is not an explicitly allowed revalidation command`);
  }
  // A command carrying live expansion is not read-only whatever it names: the
  // shell resolves the expansion before the toolkit ever sees the argument.
  if (EXPANSION_PATTERN.test(command)) {
    fail(`receipt revalidateCommand must be inert; '${command}' carries a shell expansion`);
  }
  return argv;
}

function assertReceiptRevalidationBinding(receipt) {
  const argv = assertReadOnlyRevalidation(receipt.revalidateCommand);
  const digest = receipt.resultingDigest ?? receipt.candidateDigest;
  const context = receipt.evidenceContext;
  let expected;
  if (context) {
    const carrierArgs = receipt.backend === 'github'
      ? ['--issue', String(receipt.task.carrier).replace(/^issue:/, '')]
      : ['--task-body', receipt.task.carrier];
    expected = [
      'task-readiness',
      ...carrierArgs,
      '--mode', 'authoring',
      '--expect-task-digest', digest,
      ...context.base.revalidationArgs,
      ...context.dependencies.revalidationArgs,
    ];
  } else if (receipt.backend === 'github') {
    expected = [
      'task-body', 'lint',
      '--issue', String(receipt.task.carrier).replace(/^issue:/, ''),
      '--expect-task-digest', digest,
    ];
  } else {
    expected = [
      'task', 'lint', receipt.task.id,
      '--expect-task-digest', digest,
    ];
  }
  if (canonicalJson(argv) !== canonicalJson(expected)) {
    fail(
      'mutation receipt revalidateCommand must exactly bind the receipt task carrier, ' +
      `resulting digest, base evidence, and dependency evidence (expected ${canonicalJson(expected)}, received ${canonicalJson(argv)})`
    );
  }
}

/**
 * Build one validated mutation receipt from the exact context a mutation used.
 *
 * The evidence-context digest is always derived here. Passing a contradicting
 * `evidenceContextDigest` is rejected so a receipt cannot advertise a context
 * the mutation did not consume.
 *
 * @param {object} input
 * @returns {object} frozen canonical receipt
 */
export function createTaskMutationReceipt(input = {}) {
  if (!isPlainObject(input)) fail('mutation receipt input must be an object');
  assertExactKeys(input, 'mutation receipt input', [
    'context', 'backend', 'taskId', 'carrier', 'expectedDigest', 'candidateDigest', 'resultingDigest',
    'evidenceContextDigest', 'verification', 'ownedProjections', 'projections', 'changedPaths',
    'mutationDisposition', 'recovery', 'revalidateCommand', 'rollback',
  ]);
  if (isPlainObject(input.verification)) {
    assertExactKeys(input.verification, 'mutation receipt verification', ['resultKind', 'digest']);
  }
  if (Array.isArray(input.projections)) {
    for (const projection of input.projections) {
      assertExactKeys(projection, 'mutation receipt projection', ['name', 'owned', 'attempted', 'complete']);
    }
  }
  const context = input.context ?? null;
  let evidenceContextDigest = null;
  if (context !== null) {
    const validation = validateTaskEvidenceContext(context);
    if (!validation.ok) fail(`invalid task evidence context: ${validation.errors.join('; ')}`);
    evidenceContextDigest = taskEvidenceContextDigest(context);
    if (input.evidenceContextDigest !== undefined && input.evidenceContextDigest !== evidenceContextDigest) {
      fail('receipt evidenceContextDigest is derived from the exact evidence context and cannot be supplied by a caller');
    }
  } else if (input.evidenceContextDigest !== undefined && input.evidenceContextDigest !== null) {
    fail('receipt evidenceContextDigest is derived from the exact evidence context and cannot be supplied by a caller');
  }

  // When a context is present it is the authority on identity. A caller may
  // restate a field but may not change it: a receipt that names one task while
  // embedding evidence for another is a receipt for neither, and the embedded
  // digest alone cannot catch it because the context is unmodified.
  if (context !== null) {
    for (const [label, supplied, derived] of [
      ['backend', input.backend, context.backend],
      ['task id', input.taskId, context.task.id],
      ['task carrier', input.carrier, context.task.carrier],
      ['expectedDigest', input.expectedDigest, context.task.expectedDigest],
    ]) {
      if (supplied !== undefined && supplied !== null && supplied !== derived) {
        fail(`mutation receipt ${label} '${supplied}' contradicts its evidence context '${derived}'; the context is the authority on identity`);
      }
    }
  }

  const ownedProjections = Array.isArray(input.ownedProjections) ? [...new Set(input.ownedProjections)].sort() : input.ownedProjections ?? [];
  const projections = Array.isArray(input.projections)
    ? input.projections.map(item => ({ name: item.name, owned: item.owned, attempted: item.attempted, complete: item.complete }))
    : Array.isArray(ownedProjections)
      ? ownedProjections.map(name => ({
        name,
        owned: true,
        attempted: input.mutationDisposition !== 'already_current' && input.mutationDisposition !== 'dry_run',
        complete: ['committed', 'already_current'].includes(input.mutationDisposition),
      }))
      : ownedProjections;
  const receipt = {
    kind: TASK_MUTATION_RECEIPT_KIND,
    schemaVersion: TASK_MUTATION_RECEIPT_SCHEMA_VERSION,
    backend: context?.backend ?? input.backend ?? null,
    task: {
      id: context?.task?.id ?? input.taskId ?? null,
      carrier: context?.task?.carrier ?? input.carrier ?? null,
    },
    expectedDigest: context?.task?.expectedDigest ?? input.expectedDigest ?? null,
    candidateDigest: input.candidateDigest,
    resultingDigest: input.resultingDigest ?? null,
    evidenceContext: context,
    evidenceContextDigest,
    verification: isPlainObject(input.verification)
      ? { resultKind: input.verification.resultKind, digest: input.verification.digest }
      : input.verification ?? null,
    ownedProjections,
    projections: Array.isArray(projections) ? [...projections].sort((left, right) => String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0) : projections,
    changedPaths: Array.isArray(input.changedPaths) ? [...input.changedPaths].sort() : input.changedPaths ?? [],
    mutationDisposition: input.mutationDisposition,
    unresolved: !FINAL_DISPOSITIONS.has(input.mutationDisposition),
    recovery: input.recovery ?? null,
    revalidateCommand: input.revalidateCommand,
    rollback: input.rollback ?? null,
  };
  // One structural contract, applied here and again on every read.
  const shapeErrors = receiptShapeErrors(receipt);
  if (shapeErrors.length > 0) fail(shapeErrors.join('; '));
  const validation = validateTaskMutationReceipt(receipt);
  if (!validation.ok) fail(`invalid task mutation receipt: ${validation.errors.join('; ')}`);
  return Object.freeze(receipt);
}

/**
 * Validate a receipt that arrived from another process or an earlier run.
 *
 * @param {unknown} receipt
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTaskMutationReceipt(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) return { ok: false, errors: ['mutation receipt must be an object'] };
  try {
    assertExactKeys(receipt, 'mutation receipt', [
      'kind', 'schemaVersion', 'backend', 'task', 'expectedDigest', 'candidateDigest', 'resultingDigest',
      'evidenceContext', 'evidenceContextDigest', 'verification', 'ownedProjections', 'projections',
      'changedPaths', 'mutationDisposition', 'unresolved', 'recovery', 'revalidateCommand', 'rollback',
    ]);
  } catch (error) {
    errors.push(error.message);
  }
  if (receipt.kind !== TASK_MUTATION_RECEIPT_KIND) errors.push(`mutation receipt kind must be '${TASK_MUTATION_RECEIPT_KIND}'`);
  if (receipt.schemaVersion !== TASK_MUTATION_RECEIPT_SCHEMA_VERSION) {
    errors.push(`mutation receipt schemaVersion must be ${TASK_MUTATION_RECEIPT_SCHEMA_VERSION}`);
  }
  errors.push(...receiptShapeErrors(receipt));
  if (receipt.evidenceContext !== null && receipt.evidenceContext !== undefined) {
    const validation = validateTaskEvidenceContext(receipt.evidenceContext);
    if (!validation.ok) errors.push(...validation.errors);
    else {
      if (receipt.evidenceContextDigest !== taskEvidenceContextDigest(receipt.evidenceContext)) {
        errors.push('mutation receipt evidenceContextDigest does not match its evidence context');
      }
      // The digest proves the context is intact, never that the receipt around
      // it describes the same mutation. Both have to agree field by field.
      const context = receipt.evidenceContext;
      for (const [label, actual, expected] of [
        ['backend', receipt.backend, context.backend],
        ['task id', receipt.task?.id, context.task?.id],
        ['task carrier', receipt.task?.carrier, context.task?.carrier],
        ['expectedDigest', receipt.expectedDigest, context.task?.expectedDigest],
      ]) {
        if (actual !== expected) {
          errors.push(`mutation receipt ${label} '${actual}' does not match its evidence context '${expected}'`);
        }
      }
    }
  } else if (receipt.evidenceContextDigest !== null) {
    errors.push('mutation receipt evidenceContextDigest must be null without an evidence context');
  }
  try {
    canonicalJson(receipt);
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors };
}

/** Deterministic digest of one validated mutation receipt. */
export function taskMutationReceiptDigest(receipt) {
  const validation = validateTaskMutationReceipt(receipt);
  if (!validation.ok) fail(`invalid task mutation receipt: ${validation.errors.join('; ')}`);
  return `sha256:agenticloop.task-mutation-receipt.v${TASK_MUTATION_RECEIPT_SCHEMA_VERSION}:${canonicalSha256(receipt)}`;
}
