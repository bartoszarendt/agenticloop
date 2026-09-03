/**
 * Canonical dispatch-eligibility evaluation.
 *
 * This is the single leaf-level owner of every shared semantic prerequisite a
 * dispatch must satisfy. Four protected boundaries consume it directly:
 *
 *   1. `task handoff-preflight`      - live authoritative facts, read-only;
 *   2. `task prepare-dispatch`       - live authoritative facts, mints a packet;
 *   3. prepared-packet validation    - a sealed, authenticated packet;
 *   4. Engineer role-start           - the sealed packet, then live revalidation.
 *
 * Before the consolidation those boundaries each ran their own decision sequence over
 * the same dimensions. Convergence was then a property to be tested rather than
 * a structural fact, and every divergence found by the convergence matrix
 * (clean state graded as advisory at one boundary and blocking at another,
 * contract-history errors loaded and discarded, work-unit membership never
 * re-enumerated) was an instance of the same shape. This module removes the
 * duplication itself: boundary code resolves facts and renders results; the
 * final semantic decision is made here exactly once.
 *
 * ## Two fact domains, deliberately distinct
 *
 * A convergence property is only meaningful over one fact domain, so the
 * candidate declares which one it carries:
 *
 * - `live`   - authoritative facts refetched from the target right now. Shared
 *              by preflight, packet preparation, and the live revalidation that
 *              runs immediately before role mutation. These are comparable when
 *              they receive the same unchanged facts.
 * - `sealed` - the authenticated projections carried inside one exact packet,
 *              plus externally resolved authority. Shared by prepared-packet
 *              validation and role-start authentication of that same packet.
 *
 * A sealed candidate cannot observe a repository mutation that happened after
 * its packet was minted, and it is never asked to: detecting that is the live
 * revalidation boundary's job. Do not "fix" this by requiring all four outputs
 * to be identical - two of them authenticate a sealed artifact and two of them
 * read the world, and collapsing that distinction would either make the schema
 * validator claim knowledge it does not have or make role start trust a packet
 * over current reality.
 *
 * ## Rules
 *
 * - No filesystem, GitHub, terminal, or CLI rendering I/O lives in the
 *   evaluator. Boundary resolvers produce facts; this module decides.
 * - The candidate is a closed inventory. An unknown dimension, an unknown fact
 *   domain, or a missing required key fails closed.
 * - There is no permissive mode. A caller cannot ask for a dimension to be
 *   skipped, and no dimension is decided from a caller-supplied "already valid"
 *   boolean.
 * - The per-dimension validators below remain the canonical authority for their
 *   own dimension. This module owns their *orchestration*, not a second
 *   implementation of any of them.
 */

import { createHash } from 'node:crypto';

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { gitTreeObjectId, isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import {
  dispositionForEvidenceState,
  evidenceStateRank,
  normalizeEvidenceState,
  validateValidationResult,
  validationResultDigest,
} from './result-envelope.js';
import {
  PARALLEL_SCAN_CLOCK_SKEW_SECONDS,
  PARALLEL_SCAN_MAX_FRESHNESS_SECONDS,
  parseCanonicalInstant,
  validateParallelScanInventoryBinding,
  validateParallelScanReadinessBinding,
  validateParallelScanRecord,
} from './parallel-scan.js';
import { verifyActivationCaptureSignature } from './host-handoff.js';
import { HOST_SIGNATURE_ALGORITHM, targetRepositoryIdentity } from './host-trust.js';
import {
  CLEAN_DISPATCH_STATE_IDENTITY,
  PERMITTED_OPERATOR_STATE_PREFIXES,
  PERMITTED_SCRATCH_PREFIXES,
  evaluateDispatchCleanState,
  evaluatePriorGateReceipts,
} from './repository-state.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { validateTaskReadinessEvidence } from './task-evidence-contract.js';
import { taskContractDigest, validateTaskContractBaseline } from './task-contract-baseline.js';
import {
  parseRequiredCheckInventory,
  validateRequiredCheckInventory,
} from './required-checks.js';
import { validateTaskRecord } from './validate-config.js';
import { WORKFLOW_ROLE_SET } from './workflow-vocabulary.js';
import {
  HOST_ROLE_CAPABILITIES,
  createDegradedEnforcementReports,
  validateDegradedEnforcementReport,
  validateHostRoleCapabilityDeclaration,
} from './host-role-capabilities.js';
import {
  ACTIVATION_ASSURANCE_LIMITATIONS,
  ACTIVATION_ASSURANCE_VALUES,
  ACTIVATION_CHANNELS,
  ACTIVATION_DERIVATIONS,
  DEFAULT_GRANT_TTL_SECONDS,
  RETURN_ASSURANCE_LIMITATIONS,
  RETURN_ASSURANCE_VALUES,
  activationAssuranceMeets,
  resolveTaskActivationBinding,
  validateActivationGrantShape,
  validateTaskActivationBindingShape,
} from './activation-grant.js';
import { ACTIVATION_MODES, MODE_MINIMUMS } from './activation-policy.js';
import {
  DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
  dispatchableLifecycleRepair,
  evaluateDispatchableLifecycle,
  evaluatePacketDispatchableLifecycle,
  taskStatusFromBody,
} from './dispatchability.js';

export const ACTIVATION_CAPTURE_KIND = 'agenticloop.activation-capture';

export const ACTIVATION_CAPTURE_SCHEMA_VERSION = 2;

/** Packet-carried authenticated envelope containing a complete signed grant and binding. */
export const ACTIVATION_BINDING_KIND = 'agenticloop.activation-binding';

export const ACTIVATION_BINDING_SCHEMA_VERSION = 1;

/** Packet-carried, closed statement of both assurance dimensions. */
export const DISPATCH_ASSURANCE_KIND = 'agenticloop.dispatch-assurance';

export const DISPATCH_ASSURANCE_SCHEMA_VERSION = 1;

/** Closed inventory of where a packet's activation authority came from. */
export const ACTIVATION_SOURCES = Object.freeze(['legacy_task_capture', 'activation_grant']);

export const POLICY_SOURCES = Object.freeze([
  'default', 'repository', 'operator_pin', 'operator_pin+repository',
]);

/** Decomposition provenance: v1 asserted completeness, v2 derives it from a scan. */
export const LEGACY_DECOMPOSITION_SCHEMA_VERSION = 1;

export const DECOMPOSITION_SCHEMA_VERSION = 2;

/**
 * The committed decomposition source carries the whole scan record, because
 * that record is the proof. The packet carries only a constant-size binding to
 * it, so packet size stays independent of how many tasks the work unit has.
 */
export const DECOMPOSITION_BINDING_KIND = 'agenticloop.decomposition-binding';

export const DECOMPOSITION_BINDING_SCHEMA_VERSION = 1;

export const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;

export const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;

export const CLEAN_STATE_IDENTITY_RE = /^sha256:agenticloop\.dispatch-clean-state\.v3:[a-f0-9]{64}$/;

export const INTEGRITY_STATES = new Set(['verified', 'missing', 'mismatch']);

export const ACTIVATION_CAPTURE_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'adapter', 'captureCapability', 'integrity',
  'captureId', 'intendedTaskId', 'operatorExpectedDigest',
  'normalizedActivationDigest', 'capturedAt', 'expiresAt', 'repositoryIdentity', 'signature',
]);

export const CAPTURE_ID_RE = /^capture:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The shipped, closed activation inventory.
 *
 * OpenCode's command template substitutes values into prompt text, so a model
 * can author whatever the "capture" claims. No shipped host exposes a
 * parser-owned byte or artifact channel, so every shipped adapter is
 * fail-closed. This inventory contains no fixture identity: a test that needs a
 * `supported` adapter registers a real Ed25519 key through the same
 * operator-owned trust store a host integrator would use.
 */
export const SHIPPED_ACTIVATION_ADAPTERS = Object.freeze({
  'opencode.command.positional.v1': Object.freeze({
    captureCapability: 'unsupported',
    limitation: 'OpenCode positional command substitution is prompt text, not a parser-owned byte artifact.',
    trustedAdapter: null,
  }),
  'claude-code.command.arguments.v1': Object.freeze({
    captureCapability: 'unsupported',
    limitation: 'Claude Code command arguments are model-visible prompt text, not a parser-owned byte artifact.',
    trustedAdapter: null,
  }),
  'codex.skill.request.v1': Object.freeze({
    captureCapability: 'unsupported',
    limitation: 'Codex skill request text is model-visible, not a parser-owned byte artifact.',
    trustedAdapter: null,
  }),
  'copilot.prompt.input.v1': Object.freeze({
    captureCapability: 'unsupported',
    limitation: 'Copilot prompt input is model-visible, not a parser-owned byte artifact.',
    trustedAdapter: null,
  }),
  'cursor.command.input.v1': Object.freeze({
    captureCapability: 'unsupported',
    limitation: 'Cursor command input is model-visible, not a parser-owned byte artifact.',
    trustedAdapter: null,
  }),
});

/**
 * Derive the authoritative activation capability inventory for one target.
 *
 * The shipped fail-closed entries can never be upgraded by configuration; an
 * operator can only add adapters the toolkit does not ship. Every public edge -
 * task creation, dispatch preparation, persisted-packet validation, and
 * receive-side verification - resolves its inventory through this one function.
 *
 * @param {Record<string, any>} trustedAdapters  Pinned adapters from the host trust store.
 */
export function activationCapabilityInventory(trustedAdapters = {}) {
  /** @type {Record<string, any>} */
  const inventory = { ...SHIPPED_ACTIVATION_ADAPTERS };
  for (const [adapterId, adapter] of Object.entries(trustedAdapters ?? {})) {
    if (Object.hasOwn(SHIPPED_ACTIVATION_ADAPTERS, adapterId)) continue;
    const supported = adapter?.capabilities?.activationCapture === 'supported';
    inventory[adapterId] = Object.freeze({
      captureCapability: supported ? 'supported' : 'unsupported',
      limitation: supported
        ? null
        : `Host adapter '${adapterId}' is registered without a parser-owned activation capture capability.`,
      trustedAdapter: adapter ?? null,
    });
  }
  return Object.freeze(inventory);
}

export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the inventory a call must use. `undefined` means "production": the
 * shipped fail-closed inventory. Anything else is an explicit dependency the
 * caller injected and must be a plain object.
 */
export function resolveInventory(options) {
  const injected = options?.capabilities;
  if (injected === undefined || injected === null) return { ok: true, inventory: SHIPPED_ACTIVATION_ADAPTERS };
  if (!isObject(injected)) return { ok: false, inventory: null };
  return { ok: true, inventory: injected };
}

export const ACTIVATION_CLOCK_SKEW_MS = 1000;

export const DEFAULT_DISPOSITION = Object.freeze({
  missing: 'needs_context',
  malformed: 'rejected',
  negative: 'blocked',
  changed: 'superseded',
  stale: 'superseded',
});

/**
 * A typed finding collector. Each entry records the evidence state and
 * disposition decided at the point of failure together with a stable diagnostic
 * code, so no later stage has to guess them from the message text.
 */
export class FindingSet {
  /** @param {string} defaultCode */
  constructor(defaultCode) {
    /** @type {any[]} */
    this.items = [];
    this.defaultCode = defaultCode;
  }

  add(evidenceState, message, options = {}) {
    const normalizedEvidenceState = normalizeEvidenceState(evidenceState);
    const item = {
      code: options.code ?? this.defaultCode,
      evidenceState: normalizedEvidenceState,
      disposition: normalizedEvidenceState === evidenceState
        ? options.disposition ?? DEFAULT_DISPOSITION[normalizedEvidenceState] ?? 'blocked'
        : dispositionForEvidenceState(normalizedEvidenceState),
      message: String(message),
      ...(options.repairHint ? { repairHint: options.repairHint } : {}),
      ...(options.domain ?? {}),
    };
    if (!this.items.some(existing =>
      existing.code === item.code &&
      existing.evidenceState === item.evidenceState &&
      existing.disposition === item.disposition &&
      existing.message === item.message
    )) this.items.push(item);
    return this;
  }

  missing(message, options) { return this.add('missing', message, options); }
  malformed(message, options) { return this.add('malformed', message, options); }
  negative(message, options) { return this.add('negative', message, options); }
  stale(message, options) { return this.add('stale', message, options); }
  changed(message, options) { return this.add('changed', message, options); }

  /** Adopt findings produced by a typed sub-evaluator without reclassifying them. */
  extend(findings) {
    for (const item of findings ?? []) {
      this.add(item.evidenceState, item.message, {
        code: item.code ?? this.defaultCode,
        disposition: item.disposition,
        // The owning repair travels with the finding. Dropping it here made a
        // dimension that names its exact repair - the lifecycle gate does -
        // lose it the moment the finding crossed one collector boundary.
        ...(item.repairHint ? { repairHint: item.repairHint } : {}),
      });
    }
    return this;
  }

  get length() { return this.items.length; }

  get messages() { return this.items.map(item => item.message); }

  /** The most fundamental fault: state you cannot evaluate outranks state you can. */
  get primary() {
    return this.items.reduce((best, item) => {
      if (best === null) return item;
      const left = evidenceStateRank(item.evidenceState);
      const right = evidenceStateRank(best.evidenceState);
      return left < right ? item : best;
    }, /** @type {any} */ (null));
  }
}

export function exactKeys(value, keys, label, findings) {
  if (!isObject(value)) {
    findings.malformed(`${label} must be an object`);
    return false;
  }
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = actual.filter(key => !expected.has(key));
  if (missing.length) findings.malformed(`${label} is missing field(s): ${missing.join(', ')}`);
  if (unknown.length) findings.malformed(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  return missing.length === 0 && unknown.length === 0;
}

export function digestBytes(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex')}`;
}

export function normalizeSha256(value) {
  const input = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(input) ? `sha256:${input}` : input;
}

/**
 * One canonical instant parser for the whole contract. Scan construction,
 * scan-record validation, decomposition validation, and dispatch all resolve a
 * timestamp through `parseCanonicalInstant`, so no layer can accept a
 * timestamp another layer rejects.
 */
export function isoTimestamp(value, { futureAllowed = false, now = Date.now() } = {}) {
  return parseCanonicalInstant(value, {
    now,
    futureAllowed,
    skewSeconds: ACTIVATION_CLOCK_SKEW_MS / 1000,
  }).ok;
}

/** Canonical serialization is only defined for JSON-compatible values. */
export function safeCanonical(value) {
  try {
    return canonicalJson(value);
  } catch {
    return null;
  }
}

/**
 * Equality over canonical form that tolerates absent or non-canonical input.
 * Two values that cannot both be canonicalized are never equal, so a malformed
 * field fails its comparison instead of aborting the whole validator.
 */
export function sameCanonical(left, right) {
  const a = safeCanonical(left);
  const b = safeCanonical(right);
  return a !== null && b !== null && a === b;
}

export function semanticDigest(prefix, value) {
  try {
    return `sha256:${prefix}:${canonicalSha256(value)}`;
  } catch {
    return null;
  }
}

/**
 * How long a minted dispatch packet stays consumable.
 *
 * The window was hand-sized at one hour, and that is not a window - it is a
 * timer on the operator. In the field, two of six attempts were abandoned for
 * expiry rather than for any semantic reason: the packet lost its liveness
 * while the Orchestrator was performing the repairs the toolkit itself had
 * demanded, and a later attempt expired mid-cycle again forty minutes on. The
 * orchestrator's own read was that each multi-delegation cycle exceeds the
 * window, so the packet "keeps dying".
 *
 * The clock is a backstop, not the mechanism. Every fact a packet binds - the
 * carrier digest, the repository head, readiness, the decomposition, the clean
 * state, the activation authority - is revalidated at consumption, and a real
 * change fails there semantically whatever the clock says. So the window is
 * derived from the one bound it genuinely must respect: a packet may not
 * outlive the operator authorization that a default activation grant carries.
 */
export const DISPATCH_LIVENESS_WINDOW_SECONDS = DEFAULT_GRANT_TTL_SECONDS;

export function projection(value) {
  if (!isObject(value)) return null;
  const { digest, ...result } = value;
  return result;
}

/**
 * Default diagnostic code for a command surface. This maps typed evidence state
 * to a stable code; it never inspects a message.
 */
export function commandDiagnosticCode(command, evidenceState) {
  if (command === 'task new') {
    return evidenceState === 'missing'
      ? 'activation.capture.missing'
      : evidenceState === 'changed'
        ? 'activation.capture.mismatch'
        : evidenceState === 'negative'
          ? 'activation.capture.unsupported'
          : 'activation.capture.malformed';
  }
  if (command.includes('dispatch')) {
    return evidenceState === 'changed' || evidenceState === 'stale' ? 'dispatch.packet.stale' : 'dispatch.packet.invalid';
  }
  if (command.startsWith('role return')) {
    return evidenceState === 'changed' || evidenceState === 'stale' ? 'role_return.stale' : 'role_return.invalid';
  }
  return 'evidence.malformed';
}

export function findingSet(command, evidenceState = 'malformed') {
  return new FindingSet(commandDiagnosticCode(command, evidenceState));
}

export function canonicalReferences(backend, roleId) {
  return [`agents/${roleId}.md`, 'skills/role-delegation/SKILL.md', `backends/${backend}.md`];
}

export function requiredCapabilities(roleId) {
  return roleId === 'engineer' ? ['implementation_mutation'] : [];
}

export function decompositionInventoryDigest(taskId, readyTaskIds) {
  if (typeof taskId !== 'string' || !Array.isArray(readyTaskIds)) return null;
  return `sha256:${canonicalSha256({ taskId, readyTaskIds: [...readyTaskIds].sort() })}`;
}

/**
 * The v1 inventory shape: a caller-declared completeness token plus a visible
 * ready set. It is retained only to recognize authentic prior evidence for
 * typed stale routing; it can no longer authorize dispatch, because it never
 * proved that decomposition and authoring covered the whole work unit.
 */
export function legacyDecompositionInventoryValid(value) {
  const readyTaskIds = value?.inventory?.readyTaskIds;
  return closedKeys(value?.inventory, ['id', 'digest', 'readyTaskIds']) &&
    typeof value?.inventory?.id === 'string' && Boolean(value.inventory.id) &&
    Array.isArray(readyTaskIds) &&
    readyTaskIds.every(id => typeof id === 'string' && id) &&
    new Set(readyTaskIds).size === readyTaskIds.length &&
    value.inventory.digest === decompositionInventoryDigest(value?.taskId, readyTaskIds) &&
    ['complete', 'incomplete'].includes(value?.completeness);
}

/**
 * Recognize authentic `schemaVersion: 1` decomposition evidence.
 *
 * Authenticity here means the record is exactly what the v1 contract produced -
 * closed field set, matching source and inventory digests, canonical Maintainer
 * attribution. A malformed lookalike fails this and stays malformed; only
 * authentic prior evidence earns typed stale/regeneration guidance.
 */
export function authenticLegacyDecomposition(value, taskId) {
  return value?.kind === 'agenticloop.decomposition-provenance' &&
    value?.schemaVersion === LEGACY_DECOMPOSITION_SCHEMA_VERSION &&
    closedKeys(value, [
      'kind', 'schemaVersion', 'taskId', 'authority', 'source', 'inventory',
      'completeness', 'observedAt', 'freshnessPolicy', 'sourceRef', 'sourceDigest',
    ]) &&
    value.taskId === taskId &&
    value.authority === 'maintainer' &&
    value.source === 'task-decomposition' &&
    safeRepositoryPath(value.sourceRef) &&
    value.sourceDigest === decompositionSourceDigest(value) &&
    legacyDecompositionInventoryValid(value);
}

export function decompositionSourceDigest(value) {
  if (!isObject(value)) return null;
  const { sourceDigest, ...rest } = value;
  try {
    return `sha256:${canonicalSha256(rest)}`;
  } catch {
    return null;
  }
}

export function safeRepositoryPath(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some(segment => segment === '.' || segment === '..');
}

/**
 * Validate a persisted packet without treating its digest as sufficient proof.
 * Total over every JSON-compatible input.
 *
 * @param {any} packet
 * @param {{ capabilities?: Record<string, any> }} [options]
 */
export function closedKeys(value, expected) {
  if (!isObject(value)) return false;
  const wanted = new Set(expected);
  const actual = Object.keys(value);
  return actual.length === wanted.size && actual.every(key => wanted.has(key));
}

/**
 * Recompute every persisted capture relation; never trust its claimed state.
 *
 * @param {any} capture
 * @param {{ capabilities?: Record<string, any>, allowedAdapters?: Set<string>|null }} [options]
 */
export function validateActivationCapture(capture, options = {}) {
  const findings = findingSet('task new');
  const resolved = resolveInventory(options);
  if (!resolved.ok) {
    findings.malformed('activation capability inventory must be an object', { code: 'activation.capture.malformed' });
    return { ok: false, errors: findings.messages, findings: findings.items };
  }
  const { allowedAdapters = null } = options;
  const shapeOk = exactKeys(capture, ACTIVATION_CAPTURE_FIELDS, 'activation capture', findings);
  if (capture?.kind !== ACTIVATION_CAPTURE_KIND) findings.malformed(`activation capture kind must be '${ACTIVATION_CAPTURE_KIND}'`);
  if (capture?.schemaVersion !== ACTIVATION_CAPTURE_SCHEMA_VERSION) findings.malformed(`activation capture schemaVersion must be ${ACTIVATION_CAPTURE_SCHEMA_VERSION}`);
  const adapter = typeof capture?.adapter === 'string' ? capture.adapter : '';
  const capability = Object.hasOwn(resolved.inventory, adapter) ? resolved.inventory[adapter] : null;
  if (!capability) {
    findings.malformed(`activation capture adapter '${adapter}' is not in the resolved capability inventory`, {
      code: 'activation.capture.malformed',
    });
  }
  if (allowedAdapters && !allowedAdapters.has(adapter)) {
    findings.malformed(`activation capture adapter '${adapter}' is not available on this authoring surface`);
  }
  if (!['supported', 'unsupported'].includes(capture?.captureCapability)) findings.malformed('activation capture capability is invalid');
  if (!INTEGRITY_STATES.has(capture?.integrity)) findings.malformed('activation integrity is invalid');
  if (capture?.operatorExpectedDigest !== null && !SHA256_RE.test(capture?.operatorExpectedDigest ?? '')) {
    findings.malformed('activation capture operatorExpectedDigest must be null or sha256:<64 lowercase hex>');
  }
  if (capture?.normalizedActivationDigest !== null && !SHA256_RE.test(capture?.normalizedActivationDigest ?? '')) {
    findings.malformed('activation capture normalizedActivationDigest must be null or sha256:<64 lowercase hex>');
  }
  if (!capability || !shapeOk) return { ok: false, errors: findings.messages, findings: findings.items };
  if (capture.captureCapability !== capability.captureCapability) {
    findings.malformed('activation capture capability contradicts the resolved adapter capability');
  }
  if (capability.captureCapability === 'unsupported') {
    if (capture?.integrity !== 'missing' || capture?.captureId !== null ||
        capture?.intendedTaskId !== null || capture?.operatorExpectedDigest !== null ||
        capture?.normalizedActivationDigest !== null || capture?.capturedAt !== null ||
        capture?.expiresAt !== null || capture?.repositoryIdentity !== null || capture?.signature !== null) {
      findings.malformed('unsupported activation capture must have missing integrity and no invented task, expiry, digest, repository, or signature proof');
    }
    return { ok: findings.length === 0, errors: findings.messages, findings: findings.items };
  }
  if (!CAPTURE_ID_RE.test(String(capture?.captureId ?? ''))) {
    findings.malformed('supported activation captureId must use the canonical capture:<uuid-v4> format');
  }
  if (!TASK_ID_RE.test(String(capture?.intendedTaskId ?? ''))) {
    findings.malformed('supported activation capture intendedTaskId is invalid');
  }
  if (!capture?.normalizedActivationDigest) findings.malformed('supported activation capture requires parser-normalized digest');
  const now = options.now ?? Date.now();
  if (!isoTimestamp(capture?.capturedAt, { now })) findings.malformed('supported activation capture requires a current ISO-8601 UTC capturedAt', {
    code: 'activation.capture.malformed',
  });
  if (!isoTimestamp(capture?.expiresAt, { futureAllowed: true, now })) {
    findings.malformed('supported activation capture requires an ISO-8601 UTC expiresAt');
  } else {
    if (Date.parse(capture.expiresAt) <= Date.parse(capture?.capturedAt ?? '')) {
      findings.malformed('supported activation capture expiresAt must be later than capturedAt');
    }
    if (Date.parse(capture.expiresAt) <= now) {
      findings.stale('supported activation capture has expired', { code: 'activation.capture.expired' });
    }
  }
  if (options.intendedTaskId !== undefined && capture?.intendedTaskId !== options.intendedTaskId) {
    findings.changed('activation capture intended task does not match the prospective task id');
  }
  if (options.repositoryIdentity !== undefined && capture?.repositoryIdentity !== options.repositoryIdentity) {
    findings.changed('activation capture repository does not match the prospective target repository');
  }
  if (capture?.repositoryIdentity !== capability.trustedAdapter?.repositoryIdentity) {
    findings.malformed('supported activation capture target repository does not match the pinned operator trust store');
  }
  if (!isObject(capture?.signature)) {
    findings.malformed('supported activation capture requires a host signature');
  } else {
    exactKeys(capture.signature, ['algorithm', 'keyId', 'value'], 'activation capture signature', findings);
    if (capture.signature.algorithm !== HOST_SIGNATURE_ALGORITHM) {
      findings.malformed(`activation capture signature algorithm must be '${HOST_SIGNATURE_ALGORITHM}'`);
    }
    if (!capability.trustedAdapter) {
      findings.malformed(`activation adapter '${adapter}' claims capture support without a pinned host verification key`);
    } else if (!verifyActivationCaptureSignature(capture, capability.trustedAdapter)) {
      findings.malformed('activation capture host signature does not verify against the pinned adapter key');
    }
  }
  const expected = capture?.operatorExpectedDigest;
  const normalized = capture?.normalizedActivationDigest;
  const derivedIntegrity = expected === null ? 'missing' : expected === normalized ? 'verified' : 'mismatch';
  if (capture?.integrity !== derivedIntegrity) {
    findings.malformed(`activation integrity must be '${derivedIntegrity}' for the persisted proof digests`);
  }
  return { ok: findings.length === 0, errors: findings.messages, findings: findings.items };
}

/**
 * Classify one capture into its exact typed disposition.
 *
 * Capability and evidence state stay orthogonal: an unsupported host is
 * `negative`/`blocked`; a capable host missing the operator digest is
 * `missing`/`needs_context`; a digest disagreement is `changed`/`superseded`.
 */
export function activationCaptureDisposition(capture, options = {}) {
  const checked = validateActivationCapture(capture, options);
  if (!checked.ok) {
    const primary = checked.findings.reduce((best, item) => {
      if (!best) return item;
      return evidenceStateRank(item.evidenceState) < evidenceStateRank(best.evidenceState) ? item : best;
    }, null);
    return {
      ok: false,
      evidenceState: primary?.evidenceState ?? 'malformed',
      disposition: primary?.disposition ?? 'rejected',
      errors: checked.errors,
      findings: checked.findings,
    };
  }
  const resolved = resolveInventory(options);
  if (capture.captureCapability === 'unsupported') {
    const message = resolved.inventory[capture.adapter]?.limitation ?? 'parser-owned activation capture is unsupported';
    return {
      ok: false,
      evidenceState: 'negative',
      disposition: 'blocked',
      errors: [message],
      findings: [{ code: 'activation.capture.unsupported', evidenceState: 'negative', disposition: 'blocked', message }],
    };
  }
  if (capture.integrity === 'missing') {
    const message = 'operator expected request digest is missing';
    return {
      ok: false,
      evidenceState: 'missing',
      disposition: 'needs_context',
      errors: [message],
      findings: [{ code: 'activation.capture.missing', evidenceState: 'missing', disposition: 'needs_context', message }],
    };
  }
  if (capture.integrity === 'mismatch') {
    const message = 'operator expected request digest does not equal parser-normalized activation digest';
    return {
      ok: false,
      evidenceState: 'changed',
      disposition: 'rejected',
      errors: [message],
      findings: [{ code: 'activation.capture.mismatch', evidenceState: 'changed', disposition: 'rejected', message }],
    };
  }
  return { ok: true, evidenceState: 'current', disposition: 'proceed', errors: [], findings: [] };
}

/**
 * Validate decomposition provenance.
 *
 * Authentic prior-version evidence is routed to typed stale/regeneration
 * guidance rather than silently reinterpreted under the current rules: the v1
 * record simply does not contain the inventory proof v2 requires, and no
 * migration can invent it.
 *
 * @param {any} value
 * @param {string} taskId
 * @param {any} findings
 * @param {{ allowLegacy?: boolean }} [options]  `allowLegacy` is used only to
 *   authenticate a prior-version dispatch packet before reporting it stale.
 */
export function validateDecomposition(value, taskId, findings, options = {}) {
  if (value?.schemaVersion !== DECOMPOSITION_SCHEMA_VERSION && authenticLegacyDecomposition(value, taskId)) {
    if (options.allowLegacy) return;
    findings.stale(
      `decomposition provenance schemaVersion ${value.schemaVersion} is stale; ` +
      `regenerate it as schemaVersion ${DECOMPOSITION_SCHEMA_VERSION} from a validated parallel-scan record before dispatch`,
      { code: 'dispatch.packet.stale', disposition: 'superseded' }
    );
    return;
  }
  const shapeOk = exactKeys(value, [
    'kind', 'schemaVersion', 'taskId', 'authority', 'source', 'route', 'scan',
    'observedAt', 'freshnessPolicy', 'sourceRef', 'sourceDigest',
  ], 'decomposition provenance', findings);
  if (value?.kind !== 'agenticloop.decomposition-provenance') findings.malformed("decomposition provenance kind must be 'agenticloop.decomposition-provenance'");
  if (value?.schemaVersion !== DECOMPOSITION_SCHEMA_VERSION) findings.malformed(`decomposition provenance schemaVersion must be ${DECOMPOSITION_SCHEMA_VERSION}`);
  if (value?.taskId !== taskId) findings.malformed('decomposition provenance taskId must match the dispatched task');
  if (value?.authority !== 'maintainer' || value?.source !== 'task-decomposition') findings.malformed('decomposition provenance must name the canonical maintainer task-decomposition authority');
  if (!['serial', 'parallel'].includes(value?.route)) findings.malformed("decomposition route must be 'serial' or 'parallel'");
  if (!safeRepositoryPath(value?.sourceRef)) findings.malformed('decomposition provenance sourceRef must be a safe repository-relative path');
  if (shapeOk && value?.sourceDigest !== decompositionSourceDigest(value)) {
    findings.malformed('decomposition provenance sourceDigest does not match its exact source projection');
  }

  // Completeness is never read as a token. It is re-derived from the bound
  // scan record, and the scan's own invariants are re-checked here so a
  // hand-edited "complete" cannot outrank the evidence it claims to summarize.
  const scan = value?.scan;
  const scanCheck = validateParallelScanRecord(scan, { now: options.now });
  if (!scanCheck.ok) {
    for (const error of scanCheck.errors) findings.malformed(`decomposition parallel-scan evidence is invalid: ${error}`);
  } else {
    if (scan.conclusion === 'incomplete') {
      findings.negative('decomposition parallel-scan evidence is incomplete and cannot authorize dispatch');
    }
    if (scan.inventory.complete !== true || scan.decomposition.state !== 'complete') {
      findings.negative('decomposition is incomplete and cannot authorize dispatch');
    }
    const excludedHere = scan.excluded.find(item => item.taskId === taskId);
    if (excludedHere) {
      findings.negative(
        `task '${taskId}' is excluded from the validated scan (${excludedHere.reasonCode}) and cannot be dispatched`
      );
    } else if (!scan.readyTaskIds.includes(taskId)) {
      findings.negative('complete decomposition inventory does not authorize this task as ready');
    }
    // A parallel route needs the scan to have actually found this task in a
    // candidate pair; coupling or ownership blockers refuse the claimed route.
    if (value?.route === 'parallel') {
      const paired = (scan.candidatePairs ?? []).some(pair => pair.includes(taskId));
      if (scan.conclusion !== 'parallel_candidates' || !paired) {
        findings.negative(
          `the validated scan does not place task '${taskId}' in a parallel candidate pair; the claimed parallel route is blocked`
        );
      }
    }
    // Freshness cannot be rebound after scanning. The decomposition restates
    // the scan's own observation time and policy exactly; it can never widen,
    // narrow, or otherwise replace them.
    if (scan.observedAt !== value?.observedAt) {
      findings.malformed('decomposition observedAt must equal its bound parallel-scan observation time');
    }
    if (scan.freshnessPolicy?.maxAgeSeconds !== value?.freshnessPolicy?.maxAgeSeconds) {
      findings.malformed('decomposition freshnessPolicy must equal its bound parallel-scan freshness policy');
    }
    const depSourceRef = scan.readinessContext?.dependencies?.sourceRef;
    if (depSourceRef === null || depSourceRef === undefined) {
      const perTask = scan.readinessContext?.dependenciesByTask;
      if (!Array.isArray(perTask) || perTask.length === 0 ||
          perTask.some(entry => entry?.evidence !== null && !safeRepositoryPath(entry?.evidence?.sourceRef))) {
        findings.malformed('decomposition scan readinessContext must carry canonical per-task dependency revalidation selectors');
      }
    } else if (!safeRepositoryPath(depSourceRef)) {
      findings.malformed('decomposition scan readinessContext dependency sourceRef must be a safe repository-relative path');
    }
  }

  validateDecompositionFreshness(value, findings, options);
}

export function validateDecompositionFreshness(value, findings, options = {}) {
  const now = options.now ?? Date.now();
  const observed = parseCanonicalInstant(value?.observedAt, {
    now,
    skewSeconds: PARALLEL_SCAN_CLOCK_SKEW_SECONDS,
  });
  if (!observed.ok) findings.malformed(`decomposition observedAt ${observed.reason}`);
  exactKeys(value?.freshnessPolicy, ['maxAgeSeconds'], 'decomposition freshnessPolicy', findings);
  const maxAgeSeconds = value?.freshnessPolicy?.maxAgeSeconds;
  // A "positive safe integer" policy admits a hundred million years, which is
  // not a freshness policy. The trusted maximum is the same one the scan
  // contract enforces.
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0 || maxAgeSeconds > PARALLEL_SCAN_MAX_FRESHNESS_SECONDS) {
    findings.malformed(
      `decomposition freshnessPolicy maxAgeSeconds must be an integer between 1 and ${PARALLEL_SCAN_MAX_FRESHNESS_SECONDS}`
    );
  } else if (observed.ok && now - observed.epochMs > maxAgeSeconds * 1000) {
    findings.stale('decomposition provenance is stale');
  }
}

export const DECOMPOSITION_BINDING_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'taskId', 'route', 'sourceRef', 'sourceDigest',
  'scanDigest', 'scanSemanticDigest', 'workUnitId', 'inventoryId', 'inventoryDigest',
  'inventoryComplete', 'decompositionState', 'conclusion', 'readyCount',
  'taskDisposition', 'observedAt', 'freshnessPolicy',
]);

/**
 * Project a validated decomposition source into the constant-size packet
 * binding. Only a source that already passed `validateDecomposition` reaches
 * this, so the binding restates verified facts rather than asserting new ones.
 */
export function decompositionBinding(source) {
  const scan = source.scan;
  return {
    kind: DECOMPOSITION_BINDING_KIND,
    schemaVersion: DECOMPOSITION_BINDING_SCHEMA_VERSION,
    taskId: source.taskId,
    route: source.route,
    sourceRef: source.sourceRef,
    sourceDigest: source.sourceDigest,
    scanDigest: scan.digest,
    scanSemanticDigest: scan.semanticDigest,
    workUnitId: scan.workUnit.id,
    inventoryId: scan.inventory.id,
    inventoryDigest: scan.inventory.digest,
    inventoryComplete: scan.inventory.complete,
    decompositionState: scan.decomposition.state,
    conclusion: scan.conclusion,
    readyCount: scan.readyCount,
    taskDisposition: 'ready',
    observedAt: source.observedAt,
    freshnessPolicy: { ...source.freshnessPolicy },
  };
}

/**
 * Validate the packet-carried binding.
 *
 * The binding cannot re-derive the scan (it deliberately does not carry it), so
 * it is verified as a shape plus an exact identity pair, and every dispatch
 * refetches and revalidates the committed source it names before mutation.
 */
export function validateDecompositionBinding(value, taskId, findings, options = {}) {
  if (value?.kind === 'agenticloop.decomposition-provenance') {
    if (options.allowLegacy && authenticLegacyDecomposition(value, taskId)) return;
    validateDecomposition(value, taskId, findings, options);
    if (value?.schemaVersion === DECOMPOSITION_SCHEMA_VERSION) {
      findings.malformed('dispatch packets carry the decomposition binding, not the full decomposition source');
    }
    return;
  }
  exactKeys(value, DECOMPOSITION_BINDING_FIELDS, 'decomposition binding', findings);
  if (value?.kind !== DECOMPOSITION_BINDING_KIND) findings.malformed(`decomposition binding kind must be '${DECOMPOSITION_BINDING_KIND}'`);
  if (value?.schemaVersion !== DECOMPOSITION_BINDING_SCHEMA_VERSION) {
    findings.malformed(`decomposition binding schemaVersion must be ${DECOMPOSITION_BINDING_SCHEMA_VERSION}`);
  }
  if (value?.taskId !== taskId) findings.malformed('decomposition binding taskId must match the dispatched task');
  if (!['serial', 'parallel'].includes(value?.route)) findings.malformed("decomposition binding route must be 'serial' or 'parallel'");
  if (!safeRepositoryPath(value?.sourceRef)) findings.malformed('decomposition binding sourceRef must be a safe repository-relative path');
  if (!SHA256_RE.test(value?.sourceDigest ?? '')) findings.malformed('decomposition binding sourceDigest must be sha256:<64 lowercase hex>');
  for (const key of ['scanDigest', 'scanSemanticDigest', 'inventoryDigest']) {
    if (!SEMANTIC_DIGEST_RE.test(value?.[key] ?? '')) findings.malformed(`decomposition binding ${key} must be a canonical semantic digest`);
  }
  for (const key of ['workUnitId', 'inventoryId']) {
    if (typeof value?.[key] !== 'string' || !value[key]) findings.malformed(`decomposition binding ${key} is required`);
  }
  if (value?.taskDisposition !== 'ready') findings.negative('decomposition binding does not report this task as ready');
  if (value?.inventoryComplete !== true) findings.negative('decomposition is incomplete and cannot authorize dispatch');
  if (value?.decompositionState !== 'complete') findings.negative('decomposition is incomplete and cannot authorize dispatch');
  if (value?.conclusion === 'incomplete') findings.negative('decomposition parallel-scan evidence is incomplete and cannot authorize dispatch');
  if (!Number.isSafeInteger(value?.readyCount) || value.readyCount < 1) {
    findings.negative('decomposition binding must report at least one ready task');
  }
  if (value?.route === 'parallel' && value?.conclusion !== 'parallel_candidates') {
    findings.negative('the bound scan does not support the claimed parallel route');
  }
  validateDecompositionFreshness(value, findings, options);
}

export const ACTIVATION_BINDING_FIELDS = Object.freeze(['kind', 'schemaVersion', 'grant', 'binding']);

export const RETURN_ADAPTER_FIELDS = Object.freeze(['adapterId', 'keyId', 'capability']);

export const DISPATCH_ASSURANCE_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'mode', 'policySource', 'activation', 'activationSource',
  'activationProducer', 'activationChannel', 'activationDerivation',
  'minimumActivation', 'minimumReturn', 'limitations',
]);

/**
 * Project one validated grant/binding pair into the constant-size packet
 * binding. Like the decomposition binding, this restates verified facts; the
 * durable records themselves are refetched and revalidated on every dispatch.
 */
export function activationBindingProjection(grant, binding) {
  return {
    kind: ACTIVATION_BINDING_KIND,
    schemaVersion: ACTIVATION_BINDING_SCHEMA_VERSION,
    grant: structuredClone(grant),
    binding: structuredClone(binding),
  };
}

/**
 * Build the packet's closed assurance statement.
 *
 * Both dimensions travel together, and the honest limitation text for each
 * grade is carried verbatim so no downstream renderer has to invent it - or can
 * quietly drop it.
 */
export function dispatchAssurance({ policy, activation, activationSource, producerId, channel, derivation }) {
  const limitations = [ACTIVATION_ASSURANCE_LIMITATIONS[activation]];
  const minimumReturn = policy.minimumReturn;
  limitations.push(RETURN_ASSURANCE_LIMITATIONS[minimumReturn]);
  return {
    kind: DISPATCH_ASSURANCE_KIND,
    schemaVersion: DISPATCH_ASSURANCE_SCHEMA_VERSION,
    mode: policy.mode,
    policySource: policy.policySource,
    activation,
    activationSource,
    activationProducer: producerId,
    activationChannel: channel,
    activationDerivation: derivation,
    minimumActivation: policy.minimumActivation,
    minimumReturn,
    limitations,
  };
}

export function validateActivationBindingProjection(value, { taskId, contract, findings }) {
  exactKeys(value, ACTIVATION_BINDING_FIELDS, 'dispatch activation binding', findings);
  if (value?.kind !== ACTIVATION_BINDING_KIND) findings.malformed(`dispatch activation binding kind must be '${ACTIVATION_BINDING_KIND}'`);
  if (value?.schemaVersion !== ACTIVATION_BINDING_SCHEMA_VERSION) {
    findings.malformed(`dispatch activation binding schemaVersion must be ${ACTIVATION_BINDING_SCHEMA_VERSION}`);
  }
  const grantShape = validateActivationGrantShape(value?.grant);
  const bindingShape = validateTaskActivationBindingShape(value?.binding);
  for (const error of grantShape.errors) findings.malformed(`dispatch activation grant: ${error.message}`);
  for (const error of bindingShape.errors) findings.malformed(`dispatch activation binding: ${error.message}`);
  if (!CONTRACT_DIGEST_RE.test(String(value?.binding?.taskContractDigest ?? ''))) {
    findings.malformed('dispatch activation binding taskContractDigest must be sha256:v1:<64 lowercase hex>');
  } else if (contract?.ok && value.binding.taskContractDigest !== contract.digest) {
    findings.changed(
      `the task contract for '${String(taskId)}' changed after activation; re-run the activation command`,
      { code: 'activation.binding.stale_contract', disposition: 'superseded' }
    );
  }
}

export function validateReturnAdapter(value, findings) {
  if (value === null) return;
  exactKeys(value, RETURN_ADAPTER_FIELDS, 'dispatch return adapter', findings);
  if (typeof value?.adapterId !== 'string' || !value.adapterId.trim()) findings.malformed('dispatch return adapter adapterId is required');
  if (typeof value?.keyId !== 'string' || !value.keyId.trim()) findings.malformed('dispatch return adapter keyId is required');
  if (value?.capability !== 'returnReceipt') findings.malformed("dispatch return adapter capability must be 'returnReceipt'");
}

export function validateDispatchAssurance(value, { activationBinding, activation, findings }) {
  exactKeys(value, DISPATCH_ASSURANCE_FIELDS, 'dispatch assurance', findings);
  if (value?.kind !== DISPATCH_ASSURANCE_KIND) findings.malformed(`dispatch assurance kind must be '${DISPATCH_ASSURANCE_KIND}'`);
  if (value?.schemaVersion !== DISPATCH_ASSURANCE_SCHEMA_VERSION) {
    findings.malformed(`dispatch assurance schemaVersion must be ${DISPATCH_ASSURANCE_SCHEMA_VERSION}`);
  }
  if (!ACTIVATION_MODES.includes(value?.mode)) findings.malformed('dispatch assurance mode must be standard or hardened');
  if (!POLICY_SOURCES.includes(value?.policySource)) findings.malformed('dispatch assurance policySource is invalid');
  if (!ACTIVATION_ASSURANCE_VALUES.has(value?.activation)) findings.malformed('dispatch assurance activation grade is invalid');
  if (!ACTIVATION_SOURCES.includes(value?.activationSource)) findings.malformed('dispatch assurance activationSource is invalid');
  if (!ACTIVATION_ASSURANCE_VALUES.has(value?.minimumActivation)) findings.malformed('dispatch assurance minimumActivation is invalid');
  if (!RETURN_ASSURANCE_VALUES.has(value?.minimumReturn)) findings.malformed('dispatch assurance minimumReturn is invalid');
  if (typeof value?.activationProducer !== 'string' || !value.activationProducer.trim()) {
    findings.malformed('dispatch assurance activationProducer is required');
  }
  if (!ACTIVATION_CHANNELS.includes(value?.activationChannel)) findings.malformed('dispatch assurance activationChannel is invalid');
  if (![...ACTIVATION_DERIVATIONS, 'legacy_task_capture'].includes(value?.activationDerivation)) {
    findings.malformed('dispatch assurance activationDerivation is invalid');
  }
  // The mode is not a label: it must equal exactly the minimums it names.
  if (ACTIVATION_MODES.includes(value?.mode)) {
    const expected = MODE_MINIMUMS[value.mode];
    if (value?.minimumActivation !== expected.activation || value?.minimumReturn !== expected.return) {
      findings.malformed(`dispatch assurance ${value.mode} mode must require ${expected.activation}/${expected.return}`);
    }
  }
  if (!activationAssuranceMeets(value?.activation, value?.minimumActivation)) {
    findings.negative(
      `activation assurance '${String(value?.activation)}' is below the packet's declared minimum '${String(value?.minimumActivation)}'`,
      { code: 'activation.assurance.insufficient', disposition: 'blocked' }
    );
  }
  if (!Array.isArray(value?.limitations) || value.limitations.length === 0 ||
      value.limitations.some(item => typeof item !== 'string' || !item.trim())) {
    findings.malformed('dispatch assurance limitations must be a non-empty array of honest limitation statements');
  } else if (ACTIVATION_ASSURANCE_VALUES.has(value?.activation) &&
      !value.limitations.includes(ACTIVATION_ASSURANCE_LIMITATIONS[value.activation])) {
    findings.malformed('dispatch assurance must carry the canonical limitation text for its activation grade');
  } else if (RETURN_ASSURANCE_VALUES.has(value?.minimumReturn) &&
      !value.limitations.includes(RETURN_ASSURANCE_LIMITATIONS[value.minimumReturn])) {
    findings.malformed('dispatch assurance must carry the canonical limitation text for its minimum return grade');
  }
  // Source, presence, and grade form one consistent triple. A packet cannot
  // claim host-signed activation while carrying only an operator-confirmed
  // grant, and it cannot claim a grant while carrying a legacy capture.
  if (value?.activationSource === 'legacy_task_capture') {
    if (activationBinding !== null) findings.malformed('a legacy-capture packet must not also carry an activation binding');
    if (!isObject(activation)) findings.malformed('a legacy-capture packet must carry its activation capture');
    if (value?.activation !== 'host_signed') findings.malformed('a legacy host-signed capture always grades as host_signed activation');
    if (value?.activationDerivation !== 'legacy_task_capture') {
      findings.malformed("a legacy-capture packet must record derivation 'legacy_task_capture'");
    }
    if (value?.activationChannel !== 'protected_host_boundary') {
      findings.malformed('a legacy host-signed capture is produced over a protected host boundary');
    }
  }
  if (value?.activationSource === 'activation_grant') {
    if (activation !== null) findings.malformed('a grant-bound packet must not also carry a legacy activation capture');
    if (!isObject(activationBinding)) findings.malformed('a grant-bound packet must carry its activation binding');
    if (isObject(activationBinding)) {
      if (activationBinding.binding?.assurance !== value?.activation) {
        findings.malformed('dispatch assurance activation grade must equal the bound grant assurance');
      }
      if (activationBinding.binding?.derivation !== value?.activationDerivation) {
        findings.malformed('dispatch assurance activationDerivation must equal the bound binding derivation');
      }
      if (activationBinding.grant?.producer?.id !== value?.activationProducer) {
        findings.malformed('dispatch assurance activationProducer must equal the bound grant producer');
      }
      if (activationBinding.grant?.producer?.channel !== value?.activationChannel) {
        findings.malformed('dispatch assurance activationChannel must equal the bound grant channel');
      }
    }
  }
}

export function validateCleanStateBinding(value, findings, label = 'dispatch clean-state binding') {
  const shapeOk = exactKeys(value, [
    'identity', 'permittedScratchPrefixes', 'permittedOperatorStatePrefixes',
    'ignoredFilesPermitted', 'priorGates',
  ], label, findings);
  if (!CLEAN_STATE_IDENTITY_RE.test(value?.identity ?? '')) {
    findings.malformed(`${label} identity must be a canonical clean-state digest`);
  } else if (value.identity !== CLEAN_DISPATCH_STATE_IDENTITY) {
    findings.negative(`${label} does not describe a clean checkout`, { code: 'worktree.clean_gate.failed' });
  }
  if (!sameCanonical(value?.permittedScratchPrefixes, [...PERMITTED_SCRATCH_PREFIXES])) {
    findings.malformed(`${label} permittedScratchPrefixes must equal the canonical permitted inventory`);
  }
  if (!sameCanonical(value?.permittedOperatorStatePrefixes, [...PERMITTED_OPERATOR_STATE_PREFIXES])) {
    findings.malformed(`${label} permittedOperatorStatePrefixes must equal the canonical permitted inventory`);
  }
  if (value?.ignoredFilesPermitted !== true) findings.malformed(`${label} must declare the ignored-file exception explicitly`);
  if (!Array.isArray(value?.priorGates)) {
    findings.malformed(`${label} priorGates must be an array`);
    return;
  }
  if (!shapeOk) return;
  for (const gate of value.priorGates) {
    exactKeys(gate, ['taskId', 'carrier', 'mutationDisposition', 'resultingDigest'], `${label} prior gate`, findings);
    if (typeof gate?.taskId !== 'string' || !gate.taskId) findings.malformed(`${label} prior gate taskId is required`);
    if (typeof gate?.carrier !== 'string' || !gate.carrier) findings.malformed(`${label} prior gate carrier is required`);
    if (typeof gate?.mutationDisposition !== 'string' || !gate.mutationDisposition) findings.malformed(`${label} prior gate mutationDisposition is required`);
    if (gate?.resultingDigest !== null && !SHA256_RE.test(gate?.resultingDigest ?? '')) {
      findings.malformed(`${label} prior gate resultingDigest must be null or sha256:<64 lowercase hex>`);
    }
  }
  if (!sameCanonical(value.priorGates.map(gate => gate?.carrier), [...value.priorGates.map(gate => gate?.carrier)].sort())) {
    findings.malformed(`${label} priorGates must be in canonical carrier order`);
  }
}

export function validateRepositoryBinding(value, findings, label = 'dispatch repository binding') {
  exactKeys(value, ['worktree', 'branch', 'head', 'baseHead', 'baseTree', 'cleanState'], label, findings);
  if (typeof value?.worktree !== 'string' || !value.worktree) findings.malformed(`${label} worktree is required`);
  if (typeof value?.branch !== 'string' || !value.branch) findings.malformed(`${label} branch is required`);
  for (const key of ['head', 'baseHead', 'baseTree']) {
    if (!isGitObjectId(value?.[key])) findings.malformed(`${label} ${key} must be a full lowercase 40- or 64-character Git identity`);
  }
  // One repository has exactly one object format. A binding that mixes 40- and
  // 64-hex identities describes two repositories, not one dispatch target.
  if (!sameGitObjectFormat([value?.head, value?.baseHead, value?.baseTree])) {
    findings.malformed(`${label} head, baseHead, and baseTree must share one Git object format`);
  }
  validateCleanStateBinding(value?.cleanState, findings, `${label} cleanState`);
}

export function validateAssignment(
  value,
  { backend, taskId, repository, hostRoleCapabilities = HOST_ROLE_CAPABILITIES, now = Date.now() },
  findings
) {
  exactKeys(value, [
    'roleId', 'host', 'hostRoleCapability', 'degradedEnforcementReports',
    'worktree', 'branch', 'requiredCapabilities', 'canonicalReferences',
    'attribution', 'liveness', 'cancellationBoundary', 'invocationId',
  ], 'dispatch assignment', findings);
  if (value?.roleId !== 'engineer' || !WORKFLOW_ROLE_SET.has(value?.roleId)) findings.malformed('dispatch assignment must name immutable roleId engineer');
  if (typeof value?.host !== 'string' || !value.host.trim()) {
    findings.malformed('dispatch assignment host is required', { code: 'capability.declaration.invalid' });
  } else {
    const declaration = validateHostRoleCapabilityDeclaration(value?.hostRoleCapability, {
      expectedHost: value.host,
      expectedRoleId: value.roleId,
    });
    if (!declaration.ok) {
      findings.malformed(
        `dispatch assignment host-role capability declaration is invalid: ${declaration.errors.join('; ')}`,
        { code: 'capability.declaration.invalid' }
      );
    } else {
      let canonical = null;
      try {
        canonical = hostRoleCapabilities?.[value.host]?.[value.roleId] ?? null;
        if (!canonical) throw new TypeError(
          `no effective host-role capability declaration for '${String(value.host)}/${String(value.roleId)}'`
        );
      } catch (error) {
        findings.malformed(error.message, { code: 'capability.declaration.invalid' });
      }
      if (canonical && !sameCanonical(value.hostRoleCapability, canonical)) {
        findings.malformed(
          'dispatch assignment host-role capability declaration must equal the canonical shipped declaration',
          { code: 'capability.declaration.invalid' }
        );
      }
      const reports = Array.isArray(value.degradedEnforcementReports)
        ? value.degradedEnforcementReports
        : [];
      if (!Array.isArray(value.degradedEnforcementReports)) {
        findings.malformed(
          'dispatch assignment degradedEnforcementReports must be an array',
          { code: 'capability.declaration.invalid' }
        );
      } else {
        for (const report of reports) {
          const reportValidation = validateDegradedEnforcementReport(report, {
            declaration: value.hostRoleCapability,
          });
          if (!reportValidation.ok) {
            findings.malformed(
              `dispatch assignment degraded-enforcement report is invalid: ${reportValidation.errors.join('; ')}`,
              { code: 'capability.declaration.invalid' }
            );
          }
        }
        const expectedReports = createDegradedEnforcementReports(value.hostRoleCapability);
        if (!sameCanonical(reports, expectedReports)) {
          findings.malformed(
            'dispatch assignment degradedEnforcementReports must equal the canonical declaration-derived reports',
            { code: 'capability.declaration.invalid' }
          );
        }
      }
      const implementation = value.hostRoleCapability?.actionBindings?.find(item => item.action === 'implementation_mutate');
      if (implementation?.policy !== 'allowed') {
        findings.negative(
          'dispatch assignment role is denied implementation mutation by the bound host-role capability declaration',
          { code: 'capability.action.denied' }
        );
      }
    }
  }
  if (typeof value?.invocationId !== 'string' || !/^invocation:[0-9a-f-]{36}$/.test(value.invocationId)) {
    findings.malformed('dispatch assignment invocationId must be an immutable invocation UUID');
  }
  if (value?.worktree !== repository?.worktree) findings.malformed('dispatch assignment worktree must match refetched repository worktree');
  if (value?.branch !== repository?.branch) findings.malformed('dispatch assignment branch must match refetched repository branch');
  if (!sameCanonical(value?.requiredCapabilities, requiredCapabilities(value?.roleId))) {
    findings.malformed('dispatch assignment requiredCapabilities must equal the canonical role capability references');
  }
  if (!sameCanonical(value?.canonicalReferences, canonicalReferences(backend, value?.roleId))) {
    findings.malformed('dispatch assignment canonicalReferences must equal canonical role, skill, and backend references');
  }
  exactKeys(value?.attribution, ['taskTrailer', 'agentTrailer'], 'dispatch attribution', findings);
  if (value?.attribution?.taskTrailer !== `Task: ${taskId}`) findings.malformed('dispatch attribution Task trailer does not match the task');
  if (value?.attribution?.agentTrailer !== `Agent: ${value?.roleId}`) findings.malformed('dispatch attribution Agent trailer does not match the role');
  exactKeys(value?.liveness, ['cadence', 'expiry', 'stopCondition'], 'dispatch liveness', findings);
  if (typeof value?.liveness?.cadence !== 'string' || !value.liveness.cadence.trim()) findings.malformed('dispatch liveness cadence is required');
  if (!isoTimestamp(value?.liveness?.expiry, { futureAllowed: true, now })) findings.malformed('dispatch liveness expiry must be an ISO-8601 UTC instant');
  // Judged at the evaluation instant, not the wall clock. Expiry is not
  // retroactive: a boundary revalidating an already-consumed attempt pins this
  // to the consumption instant, exactly as it already pins the activation
  // authority, so repairs, review, and closeout that run long do not retire a
  // packet that was live when the work it authorized began. A boundary
  // authorizing *new* work supplies no instant and gets the current clock,
  // which is what makes the window a gate on consumption at all.
  else if (Date.parse(value.liveness.expiry) <= now) findings.stale('dispatch liveness window has expired');
  if (typeof value?.liveness?.stopCondition !== 'string' || !value.liveness.stopCondition.trim()) findings.malformed('dispatch liveness stopCondition is required');
  if (value?.cancellationBoundary !== 'return_on_cancellation') findings.malformed("dispatch cancellationBoundary must be 'return_on_cancellation'");
}

export function validateTaskSnapshot(snapshot, findings) {
  const shapeOk = exactKeys(snapshot, ['backend', 'taskId', 'carrier', 'body', 'digest', 'trustedRecords', 'trustedRecordErrors'], 'current task snapshot', findings);
  if (!['files', 'github'].includes(snapshot?.backend)) findings.malformed('current task snapshot backend must be files or github');
  for (const key of ['taskId', 'carrier', 'body']) {
    if (typeof snapshot?.[key] !== 'string' || !snapshot[key]) findings.malformed(`current task snapshot ${key} is required`);
  }
  if (!SHA256_RE.test(snapshot?.digest ?? '')) findings.malformed('current task snapshot digest must be sha256:<64 lowercase hex>');
  if (!Array.isArray(snapshot?.trustedRecords) || !Array.isArray(snapshot?.trustedRecordErrors) ||
      snapshot?.trustedRecordErrors?.some(item => typeof item !== 'string')) {
    findings.malformed('current task snapshot trusted contract evidence is malformed');
  }
  return shapeOk;
}

export function validateCurrentTask(snapshot, findings) {
  const before = findings.length;
  validateTaskSnapshot(snapshot, findings);
  if (findings.length !== before) return null;
  if (digestBytes(snapshot.body) !== snapshot.digest) findings.changed('current task snapshot digest does not match its exact body');
  const root = evaluateTaskRecordRoot(snapshot.body);
  if (!root.ok) for (const item of root.diagnostics) findings.malformed(item.message, { code: item.code });
  for (const message of validateTaskRecord(snapshot.body, snapshot.carrier)) findings.malformed(message);
  const contract = taskContractDigest(snapshot.body);
  if (!contract.ok) findings.malformed(contract.error);
  const baseline = validateTaskContractBaseline(snapshot.body, {
    lifecycle: 'transition', trustedRecords: snapshot.trustedRecords, trustedRecordErrors: snapshot.trustedRecordErrors,
  });
  // The trusted append-only contract chain is its own dimension with its own
  // Maintainer-owned repair, so it is coded here rather than inheriting the
  // caller boundary default code.
  if (!baseline.ok) for (const message of baseline.errors) findings.malformed(message, { code: 'contract.baseline.invalid' });
  if (contract.ok && contract.projection?.task_id !== snapshot.taskId) findings.malformed('current task snapshot identity does not match the material contract');
  return contract.ok ? contract : null;
}

export function validateReadiness(readiness, snapshot, findings) {
  exactKeys(readiness, ['evidence', 'result', 'resultDigest'], 'dispatch readiness', findings);
  const evidence = validateTaskReadinessEvidence(readiness?.evidence);
  if (!evidence.ok) for (const error of evidence.errors) findings.malformed(`dispatch readiness evidence: ${error}`);
  const result = validateValidationResult(readiness?.result);
  if (!result.ok) for (const error of result.errors) findings.malformed(`dispatch readiness result: ${error}`);
  if (result.ok && readiness?.resultDigest !== validationResultDigest(readiness.result)) {
    findings.malformed('dispatch readiness resultDigest must equal the canonical validation-result digest');
  }
  if (readiness?.result?.ok !== true || readiness?.result?.evidenceState !== 'current' || readiness?.result?.disposition !== 'proceed') {
    findings.negative('dispatch readiness result must be current and proceeding');
  }
  if (readiness?.evidence?.backend !== snapshot?.backend || readiness?.evidence?.task?.id !== snapshot?.taskId ||
      readiness?.evidence?.task?.carrier !== snapshot?.carrier || readiness?.evidence?.task?.expectedDigest !== snapshot?.digest) {
    findings.changed('dispatch readiness evidence does not bind the refetched task');
  }
  if (readiness?.evidence?.dependencies === null ||
      !isObject(readiness?.evidence?.dependencies?.provenance) ||
      readiness?.evidence?.trustedRecordErrors?.length !== 0) {
    findings.missing('dispatch readiness evidence lacks current dependency or trusted-contract proof');
  }
}

/**
 * Evaluate initial repository state and prior-gate receipts for one dispatch.
 * Returns the exact clean-state binding that is folded into the packet digest.
 */
export function evaluateInitialState({ runGit, scopePatterns, intendedCreations, priorGateReceipts, readCarrierDigest }, findings) {
  if (typeof runGit !== 'function') {
    findings.missing('a Git reader is required to prove the initial repository state before dispatch');
    return null;
  }
  let clean;
  try {
    clean = evaluateDispatchCleanState({ runGit, scopePatterns, intendedCreations });
  } catch (error) {
    findings.missing(`initial repository state could not be evaluated: ${error.message}`);
    return null;
  }
  findings.extend(clean.findings);
  const gates = evaluatePriorGateReceipts({ receipts: priorGateReceipts ?? [], readCarrierDigest });
  findings.extend(gates.findings);
  if (!clean.ok || !gates.ok) return null;
  return {
    identity: clean.identity,
    permittedScratchPrefixes: [...PERMITTED_SCRATCH_PREFIXES],
    permittedOperatorStatePrefixes: [...PERMITTED_OPERATOR_STATE_PREFIXES],
    ignoredFilesPermitted: true,
    priorGates: gates.gates,
  };
}

/**
 * Resolve one task's activation authority in the fixed precedence order:
 *
 *   1. a current, valid, legacy host-signed task capture;
 *   2. a current, valid task activation binding;
 *   3. otherwise blocked.
 *
 * Both paths are total and recompute every relation. Nothing is graded from a
 * self-asserted field: the legacy path re-verifies the host signature against
 * the pinned adapter, and the grant path re-verifies grant and binding
 * signatures against a key held outside the target repository.
 */
export function resolveDispatchActivation(input, findings) {
  const { evidence, snapshot, contract, decomposition, repository, capabilities, verifyActivationSignature } = input;
  const repositoryIdentity = targetRepositoryIdentity(repository?.worktree);
  if (evidence?.source === 'activation_grant') {
    if (typeof verifyActivationSignature !== 'function') {
      findings.missing(
        'an external activation signature verifier is required to consume an activation grant',
        { code: 'activation.grant.unauthenticated' }
      );
      return null;
    }
    const resolved = resolveTaskActivationBinding({
      grant: evidence.grant,
      binding: evidence.binding,
      repositoryIdentity,
      backend: snapshot?.backend,
      taskId: snapshot?.taskId,
      carrier: snapshot?.carrier,
      taskContractDigest: contract?.ok ? contract.digest : null,
      verifySignature: verifyActivationSignature,
      revocations: evidence.revocations ?? [],
      decomposition,
      now: input.now,
    });
    if (!resolved.ok) {
      for (const error of resolved.errors) {
        findings.add(error.evidenceState, error.message, { code: error.code });
      }
      return null;
    }
    return {
      source: 'activation_grant',
      assurance: resolved.assurance,
      producerId: evidence.grant.producer.id,
      channel: evidence.grant.producer.channel,
      derivation: evidence.binding.derivation,
      binding: activationBindingProjection(evidence.grant, evidence.binding),
      capture: null,
    };
  }
  const capture = evidence?.source === 'legacy_task_capture' ? evidence.capture : evidence;
  const disposition = activationCaptureDisposition(capture, {
    capabilities,
    intendedTaskId: snapshot?.taskId,
    repositoryIdentity,
  });
  if (!disposition.ok) {
    findings.extend(disposition.findings);
    return null;
  }
  if (capture?.repositoryIdentity !== repositoryIdentity) {
    findings.changed('activation capture target repository does not match dispatch repository', {
      code: 'activation.capture.mismatch',
    });
    return null;
  }
  let bound = true;
  if (contract?.projection?.activation_input_digest !== capture?.normalizedActivationDigest) {
    findings.changed('task contract activation_input_digest does not match verified activation digest', {
      code: 'activation.capture.mismatch',
    });
    bound = false;
  }
  // The authored task must reference the exact signed capture artifact, so a
  // frontmatter digest alone cannot stand in for parser-owned authoring.
  if (contract?.ok && !safeRepositoryPath(contract.projection?.activation_capture_ref)) {
    findings.missing(
      'task contract lacks a validated activation_capture_ref authoring provenance reference; ' +
      'a scaffold task cannot authorize dispatch until `npx agenticloop activate <task-id>` creates a task activation binding',
      { code: 'activation.capture.missing' }
    );
    bound = false;
  }
  if (!bound) return null;
  return {
    source: 'legacy_task_capture',
    assurance: 'host_signed',
    producerId: capture.adapter,
    channel: 'protected_host_boundary',
    derivation: 'legacy_task_capture',
    binding: null,
    capture,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The canonical dispatch-eligibility evaluator
 *
 * Everything above this line is a per-dimension authority. Everything below is
 * their single orchestration. No boundary re-runs any of it.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The closed inventory of shared prerequisite dimensions.
 *
 * A dimension named here is decided in this module and nowhere else. Every
 * dimension must be accounted for in the returned decision ledger, so a new
 * prerequisite cannot quietly reach one boundary and miss another.
 */
export const DISPATCH_ELIGIBILITY_DIMENSIONS = Object.freeze([
  'task_identity',
  'lifecycle',
  'task_contract',
  'contract_baseline',
  'required_checks',
  'activation',
  'activation_assurance',
  'readiness',
  'dependency_evidence',
  'decomposition',
  'work_unit_membership',
  'maintainer_attribution',
  'task_eligibility',
  'repository_identity',
  'base_identity',
  'clean_state',
  'assignment',
  'host_role_capability',
  'return_capability',
]);

/**
 * One canonical diagnostic code per shared dimension.
 *
 * A sub-validator that classifies its own failure precisely keeps its own code;
 * this is the code an otherwise-uncoded finding in that dimension receives. The
 * same fault therefore reports the same code - and routes to the same owning
 * role through `repair-policy.js` - at every boundary. Before the consolidation a broken
 * decomposition was `parallel_scan.decomposition.invalid` (Maintainer,
 * regenerate) at preflight and `dispatch.packet.invalid` (dispatch, repair
 * evidence) at packet preparation, for one fault over identical facts.
 */
const DIMENSION_DIAGNOSTIC_CODE = Object.freeze({
  task_identity: 'task.contract.malformed',
  lifecycle: DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
  task_contract: 'task.contract.malformed',
  contract_baseline: 'contract.baseline.invalid',
  required_checks: 'task.contract.malformed',
  activation: 'activation.capture.missing',
  activation_assurance: 'activation.assurance.insufficient',
  readiness: 'dispatch.packet.invalid',
  dependency_evidence: 'dependency.unresolved',
  decomposition: 'parallel_scan.decomposition.invalid',
  work_unit_membership: 'parallel_scan.decomposition.invalid',
  maintainer_attribution: 'parallel_scan.decomposition.invalid',
  task_eligibility: 'parallel_scan.decomposition.invalid',
  repository_identity: 'dispatch.packet.invalid',
  base_identity: 'dispatch.packet.invalid',
  clean_state: 'worktree.clean_gate.failed',
  assignment: 'dispatch.packet.invalid',
  host_role_capability: 'capability.declaration.invalid',
  return_capability: 'return.assurance.insufficient',
});

/** Public projection of the canonical code table, for boundary presentation. */
export function dispatchDimensionDiagnosticCode(dimension) {
  return DIMENSION_DIAGNOSTIC_CODE[dimension] ?? null;
}

/**
 * The closed fact shapes.
 *
 * - `live_dispatch`   authoritative facts refetched now, binding one assignment.
 *                     Used by `task prepare-dispatch` and by the live
 *                     revalidation that runs immediately before role mutation.
 * - `live_readiness`  authoritative facts refetched now with no assignment bound
 *                     yet. Used by `task handoff-preflight`.
 * - `live_continuation` current authority and task facts for an already
 *                     consumed attempt. Used by live-attempt preflight without
 *                     replaying role-start-only clean/readiness decisions.
 * - `sealed_packet`   the authenticated projections carried inside one exact
 *                     packet, plus externally resolved authority. Used by
 *                     prepared-packet validation and by role-start
 *                     authentication of that same packet.
 *
 * These are shapes, not modes: each has a fixed required-field inventory that is
 * checked mechanically, and no caller can ask for a dimension to be skipped. A
 * candidate carrying an unknown shape, an unknown field, or a missing field is
 * refused before any dimension is evaluated.
 */
export const DISPATCH_FACT_SHAPES = Object.freeze([
  'live_dispatch', 'live_readiness', 'live_continuation', 'sealed_packet',
]);

/**
 * The fact shape the pre-mutation revalidation boundary evaluates.
 *
 * Role start revalidates live facts through exactly the `live_dispatch`
 * decision, so a packet that no longer matches current reality is refused
 * there. It is named here so the third fact domain in the contract is explicit
 * rather than implied by a call site.
 */
export const DISPATCH_REVALIDATION_FACT_SHAPE = 'live_dispatch';

const CANDIDATE_FIELDS = Object.freeze({
  live_dispatch: Object.freeze([
    'factShape', 'snapshot', 'activationEvidence', 'readiness', 'repository',
    'decomposition', 'parallelScanInventory', 'assignment', 'policy', 'returnAdapter',
    'cleanStateObservation', 'inventoryRecheck', 'authority', 'now',
  ]),
  live_readiness: Object.freeze([
    'factShape', 'snapshot', 'authorization', 'readinessObservation', 'dependencyObservation',
    'repository', 'decomposition', 'parallelScanInventory', 'hostRoleCapability', 'policy',
    'returnCapability', 'cleanStateObservation', 'inventoryRecheck', 'authority', 'now',
  ]),
  live_continuation: Object.freeze([
    'factShape', 'snapshot', 'authorization', 'repository', 'hostRoleCapability',
    'policy', 'returnCapability', 'consumption', 'now',
  ]),
  sealed_packet: Object.freeze([
    'factShape', 'packet', 'authority', 'now',
  ]),
});

/** Authorization states a live readiness boundary can observe, and their codes. */
const AUTHORIZATION_DIAGNOSTIC = Object.freeze({
  present: { code: null, evidenceState: 'current' },
  missing: { code: 'activation.capture.missing', evidenceState: 'missing' },
  expired: { code: 'activation.grant.expired', evidenceState: 'negative' },
  revoked: { code: 'activation.grant.revoked', evidenceState: 'negative' },
  stale: { code: 'activation.binding.stale_contract', evidenceState: 'negative' },
  mismatched: { code: 'activation.binding.mismatch', evidenceState: 'negative' },
  unauthenticated: { code: 'activation.assurance.insufficient', evidenceState: 'negative' },
  malformed: { code: 'activation.grant.malformed', evidenceState: 'malformed' },
});

/**
 * Classify one observed activation-authorization state.
 *
 * Exported because the preflight boundary reports the state in its domain
 * fields as well as in its diagnostics; the classification itself is decided
 * here so the two boundaries cannot disagree about what `revoked` means.
 */
export function authorizationDiagnostic(state) {
  return AUTHORIZATION_DIAGNOSTIC[state] ?? AUTHORIZATION_DIAGNOSTIC.missing;
}

function candidateShapeError(candidate) {
  if (!isObject(candidate)) return 'dispatch eligibility candidate must be an object';
  const shape = candidate.factShape;
  if (!DISPATCH_FACT_SHAPES.includes(shape)) {
    return `dispatch eligibility candidate factShape '${String(shape)}' is not a recognized fact domain`;
  }
  const expected = CANDIDATE_FIELDS[shape];
  const actual = Object.keys(candidate);
  const missing = expected.filter(key => !Object.hasOwn(candidate, key));
  const unknown = actual.filter(key => !expected.includes(key));
  if (missing.length) return `${shape} dispatch eligibility candidate is missing field(s): ${missing.join(', ')}`;
  if (unknown.length) return `${shape} dispatch eligibility candidate contains unknown field(s): ${unknown.join(', ')}`;
  return null;
}

/** A per-dimension sink whose default code is that dimension's canonical code. */
function dimensionFindings(dimension) {
  const code = DIMENSION_DIAGNOSTIC_CODE[dimension];
  if (!code) throw new TypeError(`no canonical diagnostic code for dispatch dimension '${dimension}'`);
  return new FindingSet(code);
}

/**
 * Ledger entry states.
 *
 * `not_applicable` records a dimension that does not exist in this fact domain -
 * there is no assignment to check before one is bound - and never a dimension a
 * caller asked to skip. `not_reached` records a dimension a fail-fast refusal
 * stopped short of. Both are reported, so an omission is visible rather than
 * silent.
 */
const DIMENSION_STATES = Object.freeze(['satisfied', 'refused', 'not_applicable', 'not_reached']);

class DecisionLedger {
  constructor() {
    /** @type {Record<string, any>} */
    this.entries = {};
    for (const dimension of DISPATCH_ELIGIBILITY_DIMENSIONS) {
      this.entries[dimension] = { state: 'not_reached', evidenceState: null, code: null, note: null };
    }
  }

  record(dimension, state, { evidenceState = null, code = null, note = null } = {}) {
    if (!Object.hasOwn(this.entries, dimension)) {
      throw new TypeError(`'${dimension}' is not a declared dispatch eligibility dimension`);
    }
    if (!DIMENSION_STATES.includes(state)) throw new TypeError(`invalid dimension state '${state}'`);
    this.entries[dimension] = { state, evidenceState, code, note };
  }

  /** Fold one dimension's findings into the ledger and the ordered finding list. */
  absorb(dimension, sink, findings, note = null) {
    if (sink.length === 0) {
      this.record(dimension, 'satisfied', { note });
      return true;
    }
    const primary = sink.primary;
    this.record(dimension, 'refused', {
      evidenceState: primary?.evidenceState ?? null,
      code: primary?.code ?? DIMENSION_DIAGNOSTIC_CODE[dimension],
      note,
    });
    findings.extend(sink.items);
    return false;
  }
}

function freezeDecision({
  ok, factShape, findings, ledger, warnings = null, bindings = null,
  packetEligible = false, proseDriftAccepted = false,
}) {
  return Object.freeze({
    ok,
    factShape,
    findings: Object.freeze(findings.items.map(item => Object.freeze({ ...item }))),
    errors: Object.freeze([...findings.messages]),
    // Boundary-only advisories a shared dimension produced. They are carried
    // separately so no shared blocker can be downgraded into this list.
    warnings: Object.freeze((warnings?.items ?? []).map(item => Object.freeze({ ...item }))),
    dimensions: Object.freeze(ledger.entries),
    bindings: bindings === null ? null : Object.freeze(bindings),
    // Only a decision that actually bound an assignment over live facts may
    // mint a packet. Preflight decisions are structurally unable to.
    packetEligible: ok === true && packetEligible === true,
    proseDriftAccepted,
  });
}

function shapeRefusal(factShape, message) {
  const ledger = new DecisionLedger();
  const findings = new FindingSet('dispatch.packet.invalid');
  findings.malformed(message);
  return freezeDecision({ ok: false, factShape: factShape ?? null, findings, ledger });
}

/**
 * Observe initial repository state for one dispatch.
 *
 * This is the resolver half of the clean-state dimension: it runs the injected
 * Git reader and returns what `repository-state.js` saw. It deliberately does
 * not decide anything - whether a dirty path blocks, and with which evidence
 * state and code, is decided once in `evaluateDispatchEligibility`. Preflight
 * and packet preparation calling the same evaluator but grading its result
 * differently is exactly the clean-state divergence defect.
 */
export function observeDispatchInitialState({
  runGit, scopePatterns, intendedCreations, priorGateReceipts = [], readCarrierDigest = null,
}) {
  if (typeof runGit !== 'function') {
    return {
      ok: false, clean: null, gates: null,
      reason: 'a Git reader is required to prove the initial repository state before dispatch',
    };
  }
  let clean;
  try {
    clean = evaluateDispatchCleanState({ runGit, scopePatterns, intendedCreations });
  } catch (error) {
    return { ok: false, clean: null, gates: null, reason: `initial repository state could not be evaluated: ${error.message}` };
  }
  const gates = evaluatePriorGateReceipts({ receipts: priorGateReceipts ?? [], readCarrierDigest });
  return { ok: true, clean, gates, reason: null };
}

/**
 * Decide the clean-state dimension and derive the exact binding folded into the
 * packet digest. Returns null when the dimension refuses.
 */
function decideCleanState(observation, sink) {
  if (!isObject(observation)) {
    sink.missing('initial repository state was not observed before dispatch');
    return null;
  }
  if (observation.ok !== true) {
    sink.missing(String(observation.reason ?? 'initial repository state could not be evaluated'));
    return null;
  }
  sink.extend(observation.clean?.findings ?? []);
  sink.extend(observation.gates?.findings ?? []);
  if (observation.clean?.ok !== true || observation.gates?.ok !== true) return null;
  return {
    identity: observation.clean.identity,
    permittedScratchPrefixes: [...PERMITTED_SCRATCH_PREFIXES],
    permittedOperatorStatePrefixes: [...PERMITTED_OPERATOR_STATE_PREFIXES],
    ignoredFilesPermitted: true,
    priorGates: observation.gates.gates,
  };
}

/**
 * Decide the task dimensions from one authoritative snapshot.
 *
 * `validateCurrentTask` stays the single authority; this records which of the
 * four task-side dimensions it refused, using the codes the validator itself
 * assigns, so the ledger is derived from the decision rather than restated
 * beside it.
 */
function decideTaskDimensions(snapshot, sink, ledger) {
  const contract = validateCurrentTask(snapshot, sink);
  const beforeChecks = sink.length;
  if (contract?.ok) {
    const strictChecks = parseRequiredCheckInventory(contract.projection.required_checks);
    for (const error of strictChecks.errors) {
      sink.malformed(`task contract required checks are invalid for dispatch: ${error}`);
    }
  }
  const items = sink.items;
  const baselineItems = items.filter(item => item.code === 'contract.baseline.invalid');
  const checkItems = items.slice(beforeChecks);
  const identityItems = items.filter(item => /identity|digest does not match its exact body/i.test(item.message));
  const contractItems = items.filter(item =>
    !baselineItems.includes(item) && !checkItems.includes(item) && !identityItems.includes(item));

  for (const [dimension, group] of [
    ['task_identity', identityItems],
    ['task_contract', contractItems],
    ['contract_baseline', baselineItems],
    ['required_checks', checkItems],
  ]) {
    if (group.length === 0) ledger.record(dimension, 'satisfied');
    else ledger.record(dimension, 'refused', { evidenceState: group[0].evidenceState, code: group[0].code });
  }
  return contract;
}

/** Decide current activation and policy once for every live fact domain. */
function decideCurrentAuthorization(authorization, policy, ledger, findings) {
  const activationSink = dimensionFindings('activation');
  if (!isObject(authorization)) {
    activationSink.missing('no current activation authority was resolved for this task');
  } else if (authorization.state !== 'present') {
    const classified = authorizationDiagnostic(authorization.state);
    const messages = Array.isArray(authorization.errors) && authorization.errors.length
      ? authorization.errors
      : [`task activation authorization is '${String(authorization.state)}'`];
    activationSink.add(classified.evidenceState, messages.join('; '), { code: classified.code });
  }
  ledger.absorb('activation', activationSink, findings);

  const assuranceSink = dimensionFindings('activation_assurance');
  if (isObject(authorization) && authorization.state === 'present' &&
      typeof policy?.minimumActivation === 'string' && typeof authorization.assurance === 'string' &&
      !activationAssuranceMeets(authorization.assurance, policy.minimumActivation)) {
    assuranceSink.negative(
      `activation assurance '${authorization.assurance}' is below the effective minimum ` +
      `'${policy.minimumActivation}' required by ${policy.mode} mode`,
      { code: 'activation.assurance.insufficient', disposition: 'blocked' }
    );
  }
  ledger.absorb('activation_assurance', assuranceSink, findings);
}

/**
 * Decide the work-unit dimensions: current inventory membership, the readiness
 * context the scan bound, and the eligibility recheck dispatch and preflight
 * both supply. Only asked over a well-formed decomposition, because membership
 * staleness derived from a malformed scan names a symptom beside its cause.
 */
function decideWorkUnitBinding({ decomposition, parallelScanInventory, inventoryRecheck, readiness }, sink) {
  let proseDriftAccepted = false;
  if (decomposition?.schemaVersion !== DECOMPOSITION_SCHEMA_VERSION ||
      decomposition?.scan?.inventory?.complete !== true ||
      decomposition?.scan?.decomposition?.state !== 'complete') {
    return { proseDriftAccepted, evaluated: false };
  }
  if (isObject(parallelScanInventory)) {
    const binding = validateParallelScanInventoryBinding(
      decomposition.scan, parallelScanInventory, { eligibilityRecheck: inventoryRecheck ?? undefined },
    );
    for (const error of binding.errors) sink.stale(error, { disposition: 'superseded' });
    if (binding.proseDriftAccepted) proseDriftAccepted = true;
  }
  if (readiness !== undefined && readiness !== null) {
    // The base inventory and dependency snapshot decide readiness for the whole
    // ready set without changing any task carrier digest, so the authoritative
    // readiness evidence is compared with the context the scan bound - not only
    // with the dispatched task's own record.
    const readinessBinding = validateParallelScanReadinessBinding(decomposition.scan, {
      base: readiness?.evidence?.base,
      dependencies: readiness?.evidence?.dependencies ?? null,
      ...(readiness?.dependenciesByTask ? { dependenciesByTask: readiness.dependenciesByTask } : {}),
    });
    for (const error of readinessBinding.errors) sink.stale(error, { disposition: 'superseded' });
  }
  return { proseDriftAccepted, evaluated: true };
}

/** Record the decomposition-derived dimensions the scan validator already decided. */
function recordDecompositionDimensions(ledger, decomposition, refused, evidenceState, code) {
  const state = refused ? 'refused' : 'satisfied';
  const detail = refused ? { evidenceState, code } : {};
  ledger.record('decomposition', state, detail);
  ledger.record('maintainer_attribution', state, {
    ...detail,
    note: refused ? null : `committed decomposition authority '${String(decomposition?.authority ?? '')}'`,
  });
  ledger.record('task_eligibility', state, detail);
}

/* ── live_dispatch: authoritative facts binding one assignment ───────────── */

function evaluateLiveDispatch(candidate) {
  const shape = 'live_dispatch';
  const ledger = new DecisionLedger();
  const findings = new FindingSet('dispatch.packet.invalid');
  const {
    snapshot, activationEvidence, readiness, repository, decomposition,
    parallelScanInventory, assignment, policy, returnAdapter,
    cleanStateObservation, inventoryRecheck, authority, now,
  } = candidate;

  // 1. Lifecycle, asked before any other fact. A task that cannot legally reach
  //    a role start must never receive a packet, or the refusal surfaces inside
  //    the Engineer session instead.
  const lifecycleSink = dimensionFindings('lifecycle');
  const lifecycle = evaluateDispatchableLifecycle(taskStatusFromBody(snapshot?.body));
  if (!lifecycle.ok) {
    lifecycleSink.add(lifecycle.evidenceState, lifecycle.reason, {
      code: DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
      repairHint: dispatchableLifecycleRepair(snapshot?.taskId ?? '<task-id>', lifecycle.status),
    });
    ledger.absorb('lifecycle', lifecycleSink, findings);
    return freezeDecision({ ok: false, factShape: shape, findings, ledger });
  }
  ledger.record('lifecycle', 'satisfied', { note: lifecycle.status });

  // 2. Relevant clean state, before anything is bound.
  const cleanSink = dimensionFindings('clean_state');
  const cleanState = decideCleanState(cleanStateObservation, cleanSink);
  ledger.absorb('clean_state', cleanSink, findings);
  if (cleanState === null) return freezeDecision({ ok: false, factShape: shape, findings, ledger });

  const boundRepository = { ...repository, cleanState };

  // 3. Task identity, contract, trusted baseline, required-check inventory.
  const taskSink = dimensionFindings('task_contract');
  const contract = decideTaskDimensions(snapshot, taskSink, ledger);
  findings.extend(taskSink.items);

  // 4. Readiness evidence bound to the refetched task.
  const readinessSink = dimensionFindings('readiness');
  validateReadiness(readiness, snapshot, readinessSink);
  ledger.absorb('readiness', readinessSink, findings);
  ledger.record('dependency_evidence', readinessSink.length === 0 ? 'satisfied' : 'refused', {
    note: 'dependency provenance is proved by the readiness evidence contract',
  });

  // 5. Repository and worktree identity, including the clean-state binding.
  const repositorySink = dimensionFindings('repository_identity');
  validateRepositoryBinding(boundRepository, repositorySink);
  ledger.absorb('repository_identity', repositorySink, findings);

  // 6. Committed decomposition: validity, freshness, Maintainer attribution,
  //    and this task's eligibility inside the validated scan.
  const decompositionSink = dimensionFindings('decomposition');
  validateDecomposition(decomposition, snapshot?.taskId, decompositionSink, { now });
  const decompositionRefused = decompositionSink.length > 0;
  recordDecompositionDimensions(
    ledger, decomposition, decompositionRefused,
    decompositionSink.primary?.evidenceState ?? null, decompositionSink.primary?.code ?? null,
  );
  findings.extend(decompositionSink.items);

  // 7. Assignment and host-role capability.
  const assignmentSink = dimensionFindings('assignment');
  validateAssignment(assignment, {
    backend: snapshot?.backend,
    taskId: snapshot?.taskId,
    repository: boundRepository,
    hostRoleCapabilities: authority?.hostRoleCapabilities,
    ...(Number.isFinite(now) ? { now } : {}),
  }, assignmentSink);
  const capabilityItems = assignmentSink.items.filter(item => String(item.code ?? '').startsWith('capability.'));
  ledger.record('host_role_capability', capabilityItems.length ? 'refused' : 'satisfied',
    capabilityItems.length ? { evidenceState: capabilityItems[0].evidenceState, code: capabilityItems[0].code } : {});
  const assignmentItems = assignmentSink.items.filter(item => !capabilityItems.includes(item));
  ledger.record('assignment', assignmentItems.length ? 'refused' : 'satisfied',
    assignmentItems.length ? { evidenceState: assignmentItems[0].evidenceState, code: assignmentItems[0].code } : {});
  findings.extend(assignmentSink.items);

  // 8. Current activation authority, in the fixed resolution order.
  const activationSink = dimensionFindings('activation');
  const activation = resolveDispatchActivation({
    evidence: activationEvidence,
    snapshot,
    contract,
    decomposition,
    repository: boundRepository,
    capabilities: authority?.capabilities,
    verifyActivationSignature: authority?.verifyActivationSignature,
    now,
  }, activationSink);
  ledger.absorb('activation', activationSink, findings);

  // 9. Readiness base versus repository base-tree identity.
  const baseSink = dimensionFindings('base_identity');
  const baseIdentity = gitTreeObjectId(readiness?.evidence?.base?.identity);
  if (!baseIdentity) baseSink.malformed('dispatch readiness base identity must be a full git-tree identity');
  else if (boundRepository?.baseTree !== baseIdentity) {
    baseSink.changed('dispatch repository baseTree must equal readiness base Git-tree identity');
  }
  ledger.absorb('base_identity', baseSink, findings);

  if (findings.length) return freezeDecision({ ok: false, factShape: shape, findings, ledger });

  if (!activation) {
    const sink = dimensionFindings('activation');
    sink.missing('dispatch could not resolve any current activation authority for this task', {
      code: 'activation.capture.missing',
    });
    ledger.absorb('activation', sink, findings);
    return freezeDecision({ ok: false, factShape: shape, findings, ledger });
  }

  // 10. Effective assurance policy, enforced before anything is minted so a
  //     below-policy grade never reaches a signed dispatch artifact.
  const assuranceSink = dimensionFindings('activation_assurance');
  if (!activationAssuranceMeets(activation.assurance, policy?.minimumActivation)) {
    assuranceSink.negative(
      `activation assurance '${activation.assurance}' is below the effective minimum ` +
      `'${policy?.minimumActivation}' required by ${policy?.mode} mode (policy source: ${policy?.policySource})`,
      { code: 'activation.assurance.insufficient', disposition: 'blocked' }
    );
  }
  ledger.absorb('activation_assurance', assuranceSink, findings);
  if (findings.length) return freezeDecision({ ok: false, factShape: shape, findings, ledger });

  // 11. Current work-unit membership over a freshly enumerated inventory.
  const membershipSink = dimensionFindings('work_unit_membership');
  const workUnit = decideWorkUnitBinding(
    { decomposition, parallelScanInventory, inventoryRecheck, readiness }, membershipSink,
  );
  if (!workUnit.evaluated) {
    ledger.record('work_unit_membership', 'not_applicable', {
      note: 'the bound decomposition is not a complete current-schema scan, so it authorizes no membership',
    });
  } else {
    ledger.absorb('work_unit_membership', membershipSink, findings);
  }
  findings.extend(membershipSink.items);
  if (findings.length) return freezeDecision({ ok: false, factShape: shape, findings, ledger });

  // 12. Return capability required by the effective policy.
  const returnSink = dimensionFindings('return_capability');
  if (policy?.minimumReturn === 'host_receipt' && (returnAdapter ?? null) === null) {
    returnSink.missing('hardened dispatch requires an explicitly pinned protected-boundary return adapter', {
      code: 'return.assurance.insufficient', disposition: 'blocked',
    });
  }
  ledger.absorb('return_capability', returnSink, findings);
  if (findings.length) return freezeDecision({ ok: false, factShape: shape, findings, ledger });

  return freezeDecision({
    ok: true,
    factShape: shape,
    findings,
    ledger,
    bindings: {
      snapshot,
      contract,
      activation,
      readiness,
      decomposition,
      assignment,
      repository: boundRepository,
      cleanState,
      policy,
      returnAdapter: returnAdapter ?? null,
    },
    packetEligible: true,
    proseDriftAccepted: workUnit.proseDriftAccepted,
  });
}

/* ── live_readiness: authoritative facts, no assignment bound yet ────────── */

function evaluateLiveReadiness(candidate) {
  const shape = 'live_readiness';
  const ledger = new DecisionLedger();
  const findings = new FindingSet('dispatch.packet.invalid');
  const warnings = new FindingSet('dispatch.packet.invalid');
  const {
    snapshot, authorization, readinessObservation, dependencyObservation, repository,
    decomposition, parallelScanInventory, hostRoleCapability, policy, returnCapability,
    cleanStateObservation, inventoryRecheck, now,
  } = candidate;

  // 1. Lifecycle - the same gate role start applies, asked here so a green
  //    preflight cannot be refused later over unchanged facts.
  const lifecycleSink = dimensionFindings('lifecycle');
  const lifecycle = evaluateDispatchableLifecycle(taskStatusFromBody(snapshot?.body));
  if (!lifecycle.ok) {
    lifecycleSink.add(lifecycle.evidenceState, lifecycle.reason, {
      code: DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
      repairHint: dispatchableLifecycleRepair(snapshot?.taskId ?? '<task-id>', lifecycle.status),
    });
  }
  ledger.absorb('lifecycle', lifecycleSink, findings);

  // 2. Task identity, contract, trusted append-only baseline, required checks.
  const taskSink = dimensionFindings('task_contract');
  const contract = decideTaskDimensions(snapshot, taskSink, ledger);
  findings.extend(taskSink.items);

  // 3. Current activation authorization and the assurance the policy requires.
  decideCurrentAuthorization(authorization, policy, ledger, findings);

  // 4. Readiness. The fact domains genuinely differ here and must: packet
  //    preparation validates a readiness *evidence artifact* the Maintainer
  //    produced, while this boundary runs the authoring evaluation that
  //    produces one. What is shared - and decided here for both - is the
  //    verdict: a readiness error blocks, and is never downgraded to advice.
  const readinessSink = dimensionFindings('readiness');
  if (!isObject(readinessObservation)) {
    readinessSink.missing('task readiness could not be evaluated', { code: 'readiness.base_inventory.missing' });
  } else {
    for (const diagnostic of readinessObservation.diagnostics ?? []) {
      if (diagnostic.level === 'error') {
        readinessSink.add(diagnostic.evidence?.state ?? 'negative', diagnostic.message, { code: diagnostic.code });
      } else if (diagnostic.level === 'warning') {
        warnings.add(diagnostic.evidence?.state ?? 'current', diagnostic.message, { code: diagnostic.code });
      }
    }
  }
  ledger.absorb('readiness', readinessSink, findings);

  const dependencySink = dimensionFindings('dependency_evidence');
  ledger.record('dependency_evidence', readinessSink.length === 0 ? 'satisfied' : 'refused', {
    note: `observed dependency freshness: ${String(dependencyObservation?.state ?? 'unknown')}`,
  });
  ledger.absorb('dependency_evidence', dependencySink, findings);

  // 5. Committed decomposition, its Maintainer attribution, and this task's
  //    eligibility inside the validated scan.
  const decompositionSink = dimensionFindings('decomposition');
  if (!isObject(decomposition)) {
    // The source could not be resolved at all. Running the record validator over
    // absent evidence would emit its whole shape cascade beside the one fact
    // that matters, so the absence is reported once and the cascade is not run.
    decompositionSink.missing(
      'the committed decomposition source is absent or could not be read, so it authorizes no dispatch'
    );
  } else {
    validateDecomposition(decomposition, snapshot?.taskId, decompositionSink, { now });
  }
  const decompositionRefused = decompositionSink.length > 0;
  recordDecompositionDimensions(
    ledger, decomposition, decompositionRefused,
    decompositionSink.primary?.evidenceState ?? null, decompositionSink.primary?.code ?? null,
  );
  findings.extend(decompositionSink.items);

  // 6. Current work-unit membership, re-enumerated rather than trusted, and
  //    only over a well-formed scan.
  const membershipSink = dimensionFindings('work_unit_membership');
  if (decompositionRefused || !isObject(parallelScanInventory)) {
    ledger.record('work_unit_membership', 'not_applicable', {
      note: decompositionRefused
        ? 'the bound decomposition is the root cause; membership derived from it would name a symptom'
        : 'the backend inventory could not be enumerated, so no membership verdict is claimed',
    });
  } else {
    const workUnit = decideWorkUnitBinding(
      { decomposition, parallelScanInventory, inventoryRecheck, readiness: null }, membershipSink,
    );
    if (!workUnit.evaluated) {
      ledger.record('work_unit_membership', 'not_applicable', {
        note: 'the bound decomposition is not a complete current-schema scan, so it authorizes no membership',
      });
    } else {
      ledger.absorb('work_unit_membership', membershipSink, findings);
    }
    findings.extend(membershipSink.items);
  }

  // 7. Repository and worktree identity. No assignment is bound at this
  //    boundary, so there is no packet repository binding to check - only the
  //    identity every boundary shares.
  const repositorySink = dimensionFindings('repository_identity');
  if (!isObject(repository)) repositorySink.missing('repository state could not be observed');
  else {
    if (typeof repository.worktree !== 'string' || !repository.worktree) {
      repositorySink.malformed('repository worktree identity is required');
    }
    if (!isGitObjectId(repository.head)) repositorySink.malformed('repository HEAD must be a full Git object identity');
    if (repository.baseTree !== null && !isGitObjectId(repository.baseTree)) {
      repositorySink.malformed('repository base tree must be a full Git object identity');
    }
    if (isGitObjectId(repository.head) && isGitObjectId(repository.baseTree) &&
        !sameGitObjectFormat([repository.head, repository.baseTree])) {
      repositorySink.malformed('repository head and baseTree must share one Git object format');
    }
  }
  ledger.absorb('repository_identity', repositorySink, findings);

  // 8. Readiness base versus repository base tree. This boundary resolves the
  //    readiness base from the repository it is standing in, so the comparison
  //    proves the base is resolvable rather than that a supplied artifact agrees.
  const baseSink = dimensionFindings('base_identity');
  const observedBase = gitTreeObjectId(readinessObservation?.base?.identity ?? null);
  if (isObject(readinessObservation) && !observedBase) {
    baseSink.missing('could not resolve a readiness base Git-tree identity', {
      code: 'readiness.base_inventory.missing',
    });
  } else if (observedBase && isGitObjectId(repository?.baseTree) && repository.baseTree !== observedBase) {
    baseSink.changed('repository baseTree must equal the readiness base Git-tree identity');
  }
  ledger.absorb('base_identity', baseSink, findings);

  // 9. Relevant clean state, at dispatch strength. Preflight used to report a
  //    dirty relevant checkout as advice while dispatch failed closed over the
  //    same evaluator; the verdict is now decided once.
  const cleanSink = dimensionFindings('clean_state');
  const cleanState = decideCleanState(cleanStateObservation, cleanSink);
  ledger.absorb('clean_state', cleanSink, findings);

  // 10. Host-role capability. There is no assignment to bind yet, which is a
  //     fact of this domain, not a check a caller asked to skip.
  const capabilitySink = dimensionFindings('host_role_capability');
  if (isObject(hostRoleCapability) && Array.isArray(hostRoleCapability.errors) && hostRoleCapability.errors.length) {
    capabilitySink.malformed(
      `host-role capability declaration is invalid: ${hostRoleCapability.errors.join('; ')}`,
      { code: 'capability.declaration.invalid' }
    );
  }
  ledger.absorb('host_role_capability', capabilitySink, findings);
  ledger.record('assignment', 'not_applicable', {
    note: 'no role assignment exists before packet preparation binds one',
  });

  // 11. Return capability required by the effective policy.
  const returnSink = dimensionFindings('return_capability');
  if (isObject(returnCapability)) {
    for (const error of returnCapability.errors ?? []) {
      returnSink.negative(error.message, { code: error.code ?? 'return.assurance.insufficient' });
    }
    for (const warning of returnCapability.warnings ?? []) {
      warnings.add(warning.evidenceState ?? 'current', warning.message, { code: warning.code });
    }
  }
  ledger.absorb('return_capability', returnSink, findings);

  return freezeDecision({
    ok: findings.length === 0,
    factShape: shape,
    findings,
    warnings,
    ledger,
    bindings: findings.length === 0
      ? { snapshot, contract, decomposition, repository, cleanState, policy }
      : null,
    // A read-only readiness decision can never mint a packet: no assignment
    // was bound, so no packet exists to authorize.
    packetEligible: false,
  });
}

/* ── live_continuation: current gates for one consumed attempt ──────────── */

/**
 * Decide the gates that can still invalidate an already-consumed attempt.
 * Role-start-only facts (initial clean state, readiness, and decomposition)
 * are represented explicitly as not applicable: replaying them after the
 * required role-start commit would manufacture staleness. Current task,
 * activation, policy, repository identity, host capability, and return
 * capability remain live and are evaluated before preflight may say proceed.
 */
function evaluateLiveContinuation(candidate) {
  const shape = 'live_continuation';
  const ledger = new DecisionLedger();
  const findings = new FindingSet('dispatch.packet.invalid');
  const warnings = new FindingSet('dispatch.packet.invalid');
  const {
    snapshot, authorization, repository, hostRoleCapability, policy,
    returnCapability, consumption,
  } = candidate;

  const lifecycleSink = dimensionFindings('lifecycle');
  const status = taskStatusFromBody(snapshot?.body);
  if (status !== 'in-progress') {
    lifecycleSink.negative(
      `a live consumed Engineer attempt requires task status 'in-progress', observed '${String(status ?? 'missing')}'`,
      { code: DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE, disposition: 'blocked' },
    );
  }
  ledger.absorb('lifecycle', lifecycleSink, findings);

  const taskSink = dimensionFindings('task_contract');
  const contract = decideTaskDimensions(snapshot, taskSink, ledger);
  findings.extend(taskSink.items);

  decideCurrentAuthorization(authorization, policy, ledger, findings);

  for (const [dimension, note] of [
    ['readiness', 'the recognized role-start consumption sealed the dispatch readiness decision'],
    ['dependency_evidence', 'the recognized role-start consumption sealed dependency evidence'],
    ['decomposition', 'the recognized role-start consumption sealed decomposition evidence'],
    ['work_unit_membership', 'the recognized role-start consumption sealed work-unit membership'],
    ['maintainer_attribution', 'the recognized role-start consumption sealed Maintainer attribution'],
    ['task_eligibility', 'the recognized role-start consumption sealed task eligibility'],
    ['base_identity', 'the live attempt may advance beyond its sealed dispatch base'],
    ['clean_state', 'role-start and product work are expected to advance the initially clean checkout'],
  ]) ledger.record(dimension, 'not_applicable', { note });

  const repositorySink = dimensionFindings('repository_identity');
  if (!isObject(repository)) {
    repositorySink.missing('current repository state could not be observed');
  } else {
    if (typeof repository.worktree !== 'string' || !repository.worktree) {
      repositorySink.malformed('current repository worktree identity is required');
    }
    if (!isGitObjectId(repository.head)) repositorySink.malformed('current repository HEAD must be a full Git identity');
  }
  if (!isObject(consumption)) {
    repositorySink.missing('recognized live-attempt dispatch consumption is required');
  } else {
    if (consumption.backend !== snapshot?.backend || consumption.taskId !== snapshot?.taskId ||
        consumption.taskContractDigest !== contract?.digest) {
      repositorySink.changed('live dispatch consumption does not bind the current task and contract');
    }
    if (typeof repository?.worktree === 'string' &&
        consumption.repositoryIdentity !== targetRepositoryIdentity(repository.worktree)) {
      repositorySink.changed('live dispatch consumption does not bind the current repository identity');
    }
    if (consumption.workflowRole !== 'engineer') {
      repositorySink.negative('live dispatch consumption is not assigned to the Engineer role');
    }
  }
  ledger.absorb('repository_identity', repositorySink, findings);

  const assignmentSink = dimensionFindings('assignment');
  if (!isObject(consumption) || typeof consumption.packetId !== 'string' ||
      typeof consumption.invocationId !== 'string') {
    assignmentSink.missing('live attempt packet and invocation identity are unavailable');
  }
  ledger.absorb('assignment', assignmentSink, findings);

  const capabilitySink = dimensionFindings('host_role_capability');
  if (!isObject(hostRoleCapability)) {
    capabilitySink.missing('current Engineer host-role capability could not be resolved');
  } else if (Array.isArray(hostRoleCapability.errors) && hostRoleCapability.errors.length) {
    capabilitySink.malformed(
      `host-role capability declaration is invalid: ${hostRoleCapability.errors.join('; ')}`,
      { code: 'capability.declaration.invalid' },
    );
  }
  ledger.absorb('host_role_capability', capabilitySink, findings);

  const returnSink = dimensionFindings('return_capability');
  if (isObject(returnCapability)) {
    for (const error of returnCapability.errors ?? []) {
      returnSink.negative(error.message, { code: error.code ?? 'return.assurance.insufficient' });
    }
    for (const warning of returnCapability.warnings ?? []) {
      warnings.add(warning.evidenceState ?? 'current', warning.message, { code: warning.code });
    }
  }
  ledger.absorb('return_capability', returnSink, findings);

  return freezeDecision({
    ok: findings.length === 0,
    factShape: shape,
    findings,
    warnings,
    ledger,
    bindings: findings.length === 0
      ? { snapshot, contract, repository, policy, consumption }
      : null,
    packetEligible: false,
  });
}

/* ── sealed_packet: the authenticated projections inside one exact packet ── */

function evaluateSealedPacket(candidate) {
  const shape = 'sealed_packet';
  const ledger = new DecisionLedger();
  const findings = new FindingSet('dispatch.packet.invalid');
  const { packet, authority, now } = candidate;
  const options = isObject(authority) ? authority : {};

  // The sealed domain never re-decides lifecycle, clean state, or live
  // membership: a packet cannot observe the repository it was minted from.
  // Those are the live revalidation boundary's job, and are recorded here as
  // out of this fact domain rather than quietly passed.
  ledger.record('lifecycle', 'not_applicable', {
    note: 'the sealed packet cannot observe the current task status; role-start live revalidation decides it',
  });
  ledger.record('clean_state', 'not_applicable', {
    note: 'the sealed packet carries the clean-state binding it was minted under; current state is revalidated live',
  });
  ledger.record('work_unit_membership', 'not_applicable', {
    note: 'the sealed packet cannot re-enumerate the backend inventory; live revalidation does',
  });
  ledger.record('dependency_evidence', 'not_applicable', {
    note: 'dependency provenance is proved by the readiness evidence the packet carries',
  });

  // 1. Activation authority, authenticated externally rather than believed.
  const activationSink = dimensionFindings('activation');
  const grantBound = packet?.assurance?.activationSource === 'activation_grant';
  if (grantBound) {
    // A grant never rewrites task frontmatter, so the legacy provenance fields
    // must be absent rather than invented.
    if (packet?.task?.activationDigest !== null || packet?.task?.activationCaptureRef !== null) {
      activationSink.malformed('a grant-bound dispatch packet must not claim legacy activation frontmatter provenance');
    }
    validateActivationBindingProjection(packet?.activationBinding, {
      taskId: packet?.task?.id,
      contract: { ok: true, digest: packet?.task?.taskContractDigest },
      findings: activationSink,
    });
    if (typeof options.resolveActivationBinding !== 'function') {
      activationSink.missing('an external activation authority resolver is required for a grant-bound packet', {
        code: 'activation.grant.unauthenticated', disposition: 'blocked',
      });
    } else {
      const resolved = options.resolveActivationBinding(packet);
      if (!resolved?.ok) {
        for (const error of resolved?.errors ?? [{
          message: 'grant-bound packet activation authority did not validate',
          evidenceState: 'negative',
          code: 'activation.grant.unauthenticated',
        }]) {
          activationSink.add(error.evidenceState ?? 'negative', error.message, {
            code: error.code, disposition: resolved?.disposition,
          });
        }
      }
    }
  } else {
    if (!SHA256_RE.test(packet?.task?.activationDigest ?? '')) {
      activationSink.malformed('dispatch preparation task activationDigest must be sha256:<64 lowercase hex>');
    }
    if (!safeRepositoryPath(packet?.task?.activationCaptureRef)) {
      activationSink.malformed('dispatch preparation task activationCaptureRef must be a safe repository-relative path');
    }
    const capture = activationCaptureDisposition(packet?.activation, {
      ...options,
      intendedTaskId: packet?.task?.id,
      repositoryIdentity: targetRepositoryIdentity(packet?.repository?.worktree),
      ...(typeof now === 'number' && Number.isFinite(now) ? { now } : {}),
    });
    if (!capture.ok) activationSink.extend(capture.findings);
    if (packet?.task?.activationDigest !== packet?.activation?.normalizedActivationDigest) {
      activationSink.changed('packet task activation digest must equal activation capture digest', {
        code: 'activation.capture.mismatch',
      });
    }
    if (packet?.activation?.repositoryIdentity !== targetRepositoryIdentity(packet?.repository?.worktree)) {
      activationSink.changed('packet activation target repository does not match dispatch repository', {
        code: 'activation.capture.mismatch',
      });
    }
    if (packet?.activationBinding !== null) {
      activationSink.malformed('a legacy-capture dispatch packet must not also carry an activation binding');
    }
  }
  ledger.absorb('activation', activationSink, findings);

  // 2. The packet's closed assurance statement, and the grade it declares.
  const assuranceSink = dimensionFindings('activation_assurance');
  validateDispatchAssurance(packet?.assurance, {
    activationBinding: packet?.activationBinding ?? null,
    activation: packet?.activation ?? null,
    findings: assuranceSink,
  });
  ledger.absorb('activation_assurance', assuranceSink, findings);

  // 3. Return capability.
  const returnSink = dimensionFindings('return_capability');
  validateReturnAdapter(packet?.returnAdapter, returnSink);
  if (packet?.assurance?.minimumReturn === 'host_receipt' && packet?.returnAdapter === null) {
    returnSink.missing('a host_receipt packet minimum requires a pinned return adapter', {
      code: 'return.assurance.insufficient',
    });
  }
  ledger.absorb('return_capability', returnSink, findings);

  // 4. Readiness evidence bound to the packet's own task identity.
  const readinessSink = dimensionFindings('readiness');
  validateReadiness(packet?.readiness, {
    backend: packet?.backend,
    taskId: packet?.task?.id,
    carrier: packet?.task?.carrier,
    digest: packet?.task?.dispatchCarrierDigest,
  }, readinessSink);
  ledger.absorb('readiness', readinessSink, findings);

  // 5. Decomposition binding, its attribution, and this task's eligibility.
  const decompositionSink = dimensionFindings('decomposition');
  validateDecompositionBinding(packet?.decomposition, packet?.task?.id, decompositionSink, {
    allowLegacy: options.allowLegacyDecomposition === true,
    ...(typeof now === 'number' && Number.isFinite(now) ? { now } : {}),
  });
  const decompositionRefused = decompositionSink.length > 0;
  recordDecompositionDimensions(
    ledger, packet?.decomposition, decompositionRefused,
    decompositionSink.primary?.evidenceState ?? null, decompositionSink.primary?.code ?? null,
  );
  findings.extend(decompositionSink.items);

  // 6. Repository binding, including the clean-state binding it was minted under.
  const repositorySink = dimensionFindings('repository_identity');
  validateRepositoryBinding(packet?.repository, repositorySink);
  ledger.absorb('repository_identity', repositorySink, findings);

  // 7. Assignment and host-role capability.
  const assignmentSink = dimensionFindings('assignment');
  validateAssignment(packet?.assignment, {
    backend: packet?.backend,
    taskId: packet?.task?.id,
    repository: packet?.repository,
    hostRoleCapabilities: options.hostRoleCapabilities,
    ...(Number.isFinite(now) ? { now } : {}),
  }, assignmentSink);
  const capabilityItems = assignmentSink.items.filter(item => String(item.code ?? '').startsWith('capability.'));
  ledger.record('host_role_capability', capabilityItems.length ? 'refused' : 'satisfied',
    capabilityItems.length ? { evidenceState: capabilityItems[0].evidenceState, code: capabilityItems[0].code } : {});
  const assignmentItems = assignmentSink.items.filter(item => !capabilityItems.includes(item));
  ledger.record('assignment', assignmentItems.length ? 'refused' : 'satisfied',
    assignmentItems.length ? { evidenceState: assignmentItems[0].evidenceState, code: assignmentItems[0].code } : {});
  findings.extend(assignmentSink.items);

  // 8. Readiness base versus packet repository base tree.
  const baseSink = dimensionFindings('base_identity');
  const baseIdentity = gitTreeObjectId(packet?.readiness?.evidence?.base?.identity);
  if (!baseIdentity) baseSink.malformed('packet readiness base identity must be a full git-tree identity');
  else if (packet?.repository?.baseTree !== baseIdentity) {
    baseSink.changed('packet repository baseTree must equal readiness base Git-tree identity');
  }
  ledger.absorb('base_identity', baseSink, findings);

  // The packet's own task identity and contract digest are proved by the closed
  // schema gate that must run before this evaluator sees the packet at all.
  ledger.record('task_identity', 'satisfied', { note: 'proved by the closed packet schema and digest gate' });
  ledger.record('task_contract', 'satisfied', { note: 'proved by the closed packet schema and digest gate' });
  ledger.record('contract_baseline', 'satisfied', {
    note: 'the packet carries the readiness evidence whose trusted-contract proof was checked when it was minted',
  });
  ledger.record('required_checks', 'satisfied', { note: 'proved by the closed packet schema gate' });

  return freezeDecision({ ok: findings.length === 0, factShape: shape, findings, ledger });
}

const SHAPE_EVALUATORS = Object.freeze({
  live_dispatch: evaluateLiveDispatch,
  live_readiness: evaluateLiveReadiness,
  live_continuation: evaluateLiveContinuation,
  sealed_packet: evaluateSealedPacket,
});

/**
 * Evaluate every applicable shared dispatch prerequisite over one closed
 * candidate, and return one closed immutable decision.
 *
 * This is the only place any of these dimensions is decided. Boundaries resolve
 * facts, map the returned findings into their own envelope, and add
 * boundary-only operational or schema refusals - they do not re-decide anything
 * here, and they cannot ask for a dimension to be skipped.
 */
export function evaluateDispatchEligibility(candidate) {
  const shapeError = candidateShapeError(candidate);
  if (shapeError) return shapeRefusal(candidate?.factShape ?? null, shapeError);
  try {
    return SHAPE_EVALUATORS[candidate.factShape](candidate);
  } catch (error) {
    return shapeRefusal(candidate.factShape, `dispatch eligibility could not be evaluated: ${error.message}`);
  }
}

/* ── Closed candidate adapters ───────────────────────────────────────────── */

/**
 * Build the live authoritative candidate that binds one assignment.
 *
 * Every field is required. Constructing the candidate through this adapter is
 * what makes the required inventory mechanical: a boundary that forgets a fact
 * cannot silently evaluate fewer dimensions, it produces a candidate that
 * `evaluateDispatchEligibility` refuses.
 */
export function liveDispatchCandidate({
  snapshot, activationEvidence, readiness, repository, decomposition,
  parallelScanInventory, assignment, policy, returnAdapter,
  cleanStateObservation, inventoryRecheck, authority, now,
}) {
  return {
    factShape: 'live_dispatch',
    snapshot,
    activationEvidence: activationEvidence ?? null,
    readiness,
    repository,
    decomposition,
    parallelScanInventory: parallelScanInventory ?? null,
    assignment,
    policy,
    returnAdapter: returnAdapter ?? null,
    cleanStateObservation,
    inventoryRecheck: inventoryRecheck ?? null,
    authority: authority ?? {},
    now: now ?? undefined,
  };
}

/**
 * The candidate the live revalidation boundary evaluates immediately before
 * role mutation.
 *
 * It is deliberately the same decision as packet preparation over freshly
 * refetched facts: that identity is what makes "a green preflight is never
 * refused later" checkable rather than aspirational. It is named separately so
 * the third fact domain in the contract - current refetch facts used just
 * before mutation - is explicit at its call site.
 */
export function revalidationDispatchCandidate(input) {
  return liveDispatchCandidate(input);
}

/**
 * Build the live authoritative candidate for a read-only boundary that has not
 * bound an assignment.
 */
export function liveReadinessCandidate({
  snapshot, authorization, readinessObservation, dependencyObservation, repository,
  decomposition, parallelScanInventory, hostRoleCapability, policy, returnCapability,
  cleanStateObservation, inventoryRecheck, authority, now,
}) {
  return {
    factShape: 'live_readiness',
    snapshot,
    authorization: authorization ?? null,
    readinessObservation: readinessObservation ?? null,
    dependencyObservation: dependencyObservation ?? null,
    repository: repository ?? null,
    decomposition: decomposition ?? null,
    parallelScanInventory: parallelScanInventory ?? null,
    hostRoleCapability: hostRoleCapability ?? null,
    policy: policy ?? null,
    returnCapability: returnCapability ?? null,
    cleanStateObservation: cleanStateObservation ?? null,
    inventoryRecheck: inventoryRecheck ?? null,
    authority: authority ?? {},
    now: now ?? undefined,
  };
}

/** Build the current-facts candidate for an already-consumed attempt. */
export function liveContinuationCandidate({
  snapshot, authorization, repository, hostRoleCapability, policy,
  returnCapability, consumption, now,
}) {
  return {
    factShape: 'live_continuation',
    snapshot,
    authorization: authorization ?? null,
    repository: repository ?? null,
    hostRoleCapability: hostRoleCapability ?? null,
    policy: policy ?? null,
    returnCapability: returnCapability ?? null,
    consumption: consumption ?? null,
    now: now ?? undefined,
  };
}

/**
 * Build the sealed candidate from one packet that has already passed its closed
 * schema, identity, and digest gate.
 *
 * A malformed packet must never reach the semantic evaluator as if it were a
 * valid candidate, so this adapter is only ever called after that gate.
 */
export function sealedPacketCandidate({ packet, authority, now }) {
  return {
    factShape: 'sealed_packet',
    packet,
    authority: authority ?? {},
    now: now ?? undefined,
  };
}

/* ── The closed sealed-decision contract ─────────────────────────────────── */

/**
 * The closed, digest-bound result shape a sealed-packet decision travels in.
 *
 * Role start may not be handed a bare `{ ok: true }`: it authenticates the exact
 * retained packet, and the receipt binds the decision to that packet's id and
 * digest. Because the packet digest is taken over the whole packet projection,
 * binding to it binds the decision to the packet's task, carrier, contract
 * digest, repository, assignment, and declared assurance transitively - which is
 * why the schema does not restate them and is not versioned up to.
 *
 * The digest detects alteration and packet substitution. It does not
 * authenticate who ran the validator or independently prove canonical origin;
 * that authority comes from the caller rerunning this evaluator through a closed
 * adapter immediately before mutation.
 *
 * It lives here, below both `dispatch-envelope.js` and `handoff-recognition.js`,
 * so prepared-packet validation and role-start authentication share one
 * definition instead of one importing the other.
 */
export const PREPARED_DISPATCH_VALIDATION_KIND = 'agenticloop.prepared-dispatch-validation';
export const PREPARED_DISPATCH_VALIDATION_SCHEMA_VERSION = 1;

export function preparedDispatchValidationDigest(record) {
  const projected = { ...record };
  delete projected.digest;
  return `sha256:${PREPARED_DISPATCH_VALIDATION_KIND}.v${PREPARED_DISPATCH_VALIDATION_SCHEMA_VERSION}:${canonicalSha256(projected)}`;
}

/** Create an unkeyed digest-bound integrity record for one packet/result pair. */
export function createPreparedDispatchValidation(packet, checked) {
  const record = {
    kind: PREPARED_DISPATCH_VALIDATION_KIND,
    schemaVersion: PREPARED_DISPATCH_VALIDATION_SCHEMA_VERSION,
    packetId: typeof packet?.packetId === 'string' ? packet.packetId : null,
    packetDigest: typeof packet?.digest === 'string' ? packet.digest : null,
    ok: checked?.ok === true,
    errors: Array.isArray(checked?.errors) ? checked.errors.map(String) : [],
    digest: null,
  };
  record.digest = preparedDispatchValidationDigest(record);
  return Object.freeze(record);
}

/** Validate one sealed decision receipt against the exact packet it must bind. */
export function validatePreparedDispatchValidation(record, packet) {
  const fields = ['kind', 'schemaVersion', 'packetId', 'packetDigest', 'ok', 'errors', 'digest'];
  const errors = [];
  const closed = isObject(record) &&
    Object.keys(record).length === fields.length &&
    fields.every(field => Object.hasOwn(record, field));
  if (!closed) return { ok: false, errors: ['canonical dispatch validation receipt fields must equal the closed schema'] };
  if (record.kind !== PREPARED_DISPATCH_VALIDATION_KIND ||
      record.schemaVersion !== PREPARED_DISPATCH_VALIDATION_SCHEMA_VERSION) {
    errors.push('canonical dispatch validation receipt identity is invalid');
  }
  if (record.packetId !== packet?.packetId || record.packetDigest !== packet?.digest) {
    errors.push('canonical dispatch validation receipt does not bind the exact packet');
  }
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.errors) ||
      record.errors.some(error => typeof error !== 'string' || !error)) {
    errors.push('canonical dispatch validation receipt result is malformed');
  }
  if (record.ok === true && record.errors.length > 0) errors.push('successful canonical dispatch validation cannot carry errors');
  if (record.ok === false && record.errors.length === 0) errors.push('failed canonical dispatch validation must carry errors');
  if (record.digest !== preparedDispatchValidationDigest(record)) errors.push('canonical dispatch validation receipt digest is invalid');
  return { ok: errors.length === 0, errors };
}
