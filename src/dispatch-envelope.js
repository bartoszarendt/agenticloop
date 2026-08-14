/**
 * Exact single-role handoff artifacts. These functions are deliberately
 * read-only: they bind existing facts but do not create workflow state.
 *
 * Three rules shape this module:
 *
 * 1. Adapter authority is a dependency, never input data. The shipped inventory
 *    is fail-closed; a `supported` capture requires an operator-pinned host key.
 * 2. Every public validator is total. External wire JSON may be any
 *    JSON-compatible value and must produce validation findings, not a throw.
 * 3. Evidence state and disposition are classified where the failure happens.
 *    Nothing infers authority or freshness by matching English error prose.
 */

import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { CANCELLATION_PROVENANCE_KIND } from './cancellation-provenance.js';
import { deriveCommitRange } from './commit-range.js';
import { gitTreeObjectId, isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import { deepFreeze, frozenClone } from './immutable.js';
import { createDiagnostic } from './repair-policy.js';
import { receiveExceptionalVerification } from './exceptional-verification.js';
import {
  authorizeBlockedResultRecovery,
  authorizeBlockedResultResume,
} from './blocked-result-authority.js';
import {
  createValidationResult,
  dispositionForEvidenceState,
  evidenceStateRank,
  normalizeEvidenceState,
  validateValidationResult,
  validationResultDigest,
} from './result-envelope.js';
import {
  PARALLEL_SCAN_CLOCK_SKEW_SECONDS,
  PARALLEL_SCAN_MAX_FRESHNESS_SECONDS,
  evaluateParallelScan,
  parseCanonicalInstant,
  validateParallelScanInventoryBinding,
  validateParallelScanReadinessBinding,
  validateParallelScanRecord,
} from './parallel-scan.js';
import { fileMatchesScopePattern, parseDeviations } from './scope-matcher.js';
import {
  HostReceiptStaleVersionError,
  HostProducerMismatchError,
  signActivationCapture,
  verifyActivationCaptureSignature,
  verifyHostExceptionalVerificationReceipt,
  verifyHostHandoffReceipt,
} from './host-handoff.js';
import { HOST_SIGNATURE_ALGORITHM, targetRepositoryIdentity } from './host-trust.js';
import { pathIdentity } from './path-identity.js';
import {
  CLEAN_DISPATCH_STATE_IDENTITY,
  PERMITTED_OPERATOR_STATE_PREFIXES,
  PERMITTED_SCRATCH_PREFIXES,
  PERMITTED_UNTRACKED_PREFIXES,
  evaluateDispatchCleanState,
  evaluatePriorGateReceipts,
} from './repository-state.js';
import { PublicCommandError } from './public-error.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { validateTaskReadinessEvidence } from './task-evidence-contract.js';
import { taskContractDigest, validateTaskContractBaseline } from './task-contract-baseline.js';
import {
  parseRequiredCheckInventory,
  REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
  requiredCheckEvidenceMatchesInventory,
  validateRequiredCheckEvidence,
  validateRequiredCheckInventory,
} from './required-checks.js';
import { validateTaskRecord } from './validate-config.js';
import { WORKFLOW_ROLE_SET } from './workflow-vocabulary.js';
import { WORKFLOW_ROLE_REGISTRY } from './transition-contract.js';
import {
  HOST_ROLE_CAPABILITIES,
  createDegradedEnforcementReports,
  degradedEnforcementDeclarationFacts,
  validateDegradedEnforcementReport,
  validateHostRoleCapabilityDeclaration,
  validateHostRoleCapabilityInventory,
} from './host-role-capabilities.js';
import {
  ACTIVATION_ASSURANCE_LIMITATIONS,
  ACTIVATION_ASSURANCE_VALUES,
  ACTIVATION_CHANNELS,
  ACTIVATION_DERIVATIONS,
  RETURN_ASSURANCE_LIMITATIONS,
  RETURN_ASSURANCE_VALUES,
  activationAssuranceMeets,
  resolveTaskActivationBinding,
  validateActivationGrantShape,
  validateTaskActivationBindingShape,
} from './activation-grant.js';
import { ACTIVATION_MODES, MODE_MINIMUMS } from './activation-policy.js';

export const ACTIVATION_CAPTURE_KIND = 'agenticloop.activation-capture';
export const ACTIVATION_CAPTURE_SCHEMA_VERSION = 2;
export const DISPATCH_PREPARATION_KIND = 'agenticloop.role-preparation';
export const BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION = 2;
export const LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION = 3;
/**
 * The last packet version whose decomposition field carried the v1
 * caller-asserted completeness token. Its wire projection differs from the
 * current one, and no migration can supply the scan proof v2 requires, so an
 * authentic v4 packet is recognized and routed to typed regeneration.
 */
export const SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION = 4;
/**
 * The last packet version whose only activation model was a host-signed,
 * task-bound capture. A v5 packet carries no assurance dimensions and no
 * activation-grant binding, so it is recognized for typed stale routing and
 * regenerated rather than reinterpreted.
 */
export const ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION = 5;
/**
 * v6 used `task.digest` for the mutable carrier. v7 names every authority
 * identity explicitly so a later Engineer evidence mutation cannot be mistaken
 * for protected-contract drift.
 */
export const CARRIER_NAMED_DISPATCH_PREPARATION_SCHEMA_VERSION = 6;
/** Schema 7 authenticated no required-check execution-evidence contract. */
export const REQUIRED_CHECK_EVIDENCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION = 7;
export const DISPATCH_PREPARATION_SCHEMA_VERSION = 8;
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
export const ROLE_RETURN_KIND = 'agenticloop.role-return';
export const CANCELLATION_BLOCKER_CATEGORY = 'cancellation_requested';
export const ROLE_RETURN_SCHEMA_VERSION = 4;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;
const CLEAN_STATE_IDENTITY_RE = /^sha256:agenticloop\.dispatch-clean-state\.v3:[a-f0-9]{64}$/;
const INTEGRITY_STATES = new Set(['verified', 'missing', 'mismatch']);
const CHECK_OUTCOMES = new Set(['passed', 'failed', 'blocked', 'not_run']);
const RETURN_DISPOSITIONS = new Set(['proceed', 'blocked']);
const PR_STATES = new Set(['unavailable', 'not_applicable', 'open', 'updated']);
const RETURN_INVALIDATORS = Object.freeze([
  'task_or_contract_changes',
  'packet_or_assignment_changes',
  'branch_or_head_changes',
  'check_or_transport_evidence_changes',
  'initial_repository_state_changes',
]);

const ACTIVATION_CAPTURE_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'adapter', 'captureCapability', 'integrity',
  'captureId', 'intendedTaskId', 'operatorExpectedDigest',
  'normalizedActivationDigest', 'capturedAt', 'expiresAt', 'repositoryIdentity', 'signature',
]);
const CAPTURE_ID_RE = /^capture:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the inventory a call must use. `undefined` means "production": the
 * shipped fail-closed inventory. Anything else is an explicit dependency the
 * caller injected and must be a plain object.
 */
function resolveInventory(options) {
  const injected = options?.capabilities;
  if (injected === undefined || injected === null) return { ok: true, inventory: SHIPPED_ACTIVATION_ADAPTERS };
  if (!isObject(injected)) return { ok: false, inventory: null };
  return { ok: true, inventory: injected };
}

export const ACTIVATION_CLOCK_SKEW_MS = 1000;

const DEFAULT_DISPOSITION = Object.freeze({
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
class FindingSet {
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

function exactKeys(value, keys, label, findings) {
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

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex')}`;
}

function normalizeSha256(value) {
  const input = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(input) ? `sha256:${input}` : input;
}

/**
 * One canonical instant parser for the whole contract. Scan construction,
 * scan-record validation, decomposition validation, and dispatch all resolve a
 * timestamp through `parseCanonicalInstant`, so no layer can accept a
 * timestamp another layer rejects.
 */
function isoTimestamp(value, { futureAllowed = false, now = Date.now() } = {}) {
  return parseCanonicalInstant(value, {
    now,
    futureAllowed,
    skewSeconds: ACTIVATION_CLOCK_SKEW_MS / 1000,
  }).ok;
}

/** Canonical serialization is only defined for JSON-compatible values. */
function safeCanonical(value) {
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
function sameCanonical(left, right) {
  const a = safeCanonical(left);
  const b = safeCanonical(right);
  return a !== null && b !== null && a === b;
}

function semanticDigest(prefix, value) {
  try {
    return `sha256:${prefix}:${canonicalSha256(value)}`;
  } catch {
    return null;
  }
}

function projection(value) {
  if (!isObject(value)) return null;
  const { digest, ...result } = value;
  return result;
}

function stableReadinessProjection(readiness) {
  if (!isObject(readiness) || !isObject(readiness.evidence) || !isObject(readiness.evidence.dependencies)) return readiness;
  const copy = structuredClone(readiness);
  delete copy.evidence.dependencies.evaluatedAt;
  return copy;
}

/**
 * Default diagnostic code for a command surface. This maps typed evidence state
 * to a stable code; it never inspects a message.
 */
function commandDiagnosticCode(command, evidenceState) {
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

function findingSet(command, evidenceState = 'malformed') {
  return new FindingSet(commandDiagnosticCode(command, evidenceState));
}

function validation(command, ok, evidenceState, disposition, findings, domain = {}) {
  const primary = ok ? null : findings?.primary ?? null;
  const orderedFindings = ok ? [] : [
    ...(primary ? [primary] : []),
    ...(findings?.items ?? []).filter(item => item !== primary),
  ];
  const seen = new Set();
  const diagnostics = orderedFindings.flatMap(item => {
    const code = item?.code ?? commandDiagnosticCode(command, item?.evidenceState ?? evidenceState);
    const message = item?.message ?? 'Validation failed.';
    const identity = `${code}\0${message}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [createDiagnostic({
      code,
      message,
      evidence: {
        state: item?.evidenceState ?? evidenceState,
        supplied: (item?.evidenceState ?? evidenceState) !== 'missing',
        rollbackAuthorized: false,
      },
      // A finding that already knows its exact operator repair keeps it; the
      // presentation layer renders it ahead of the generic repair-kind text.
      ...(item?.repairHint ? { repairHint: item.repairHint } : {}),
    })];
  });
  return createValidationResult({
    command,
    ok,
    evidenceState,
    disposition,
    diagnostics,
    ...domain,
  });
}

/**
 * Render one warning per degraded action.
 *
 * The declaration-level prose is resolved from the digest-pinned declaration
 * rather than read off the report, so the rendered warning is unchanged while
 * the packet stops carrying the same few hundred bytes once per degraded
 * action.
 *
 * @param {object[]} reports
 * @param {object|null} [declaration]  The bound host-role capability declaration.
 */
function degradedWarningDiagnostics(reports, declaration = null) {
  return (reports ?? []).map(report => {
    const facts = degradedEnforcementDeclarationFacts(report, declaration);
    return createDiagnostic({
      level: 'warning',
      code: report.diagnosticCode,
      message: `${report.host}/${report.roleId} action '${report.action}' is ${report.enforcement}; ${facts.detectionBoundary} must evaluate compatible authenticated actor/evidence. Recovery: ${facts.recoveryRoute}`,
      evidence: {
        state: 'current',
        supplied: true,
        rollbackAuthorized: false,
        host: report.host,
        roleId: report.roleId,
        action: report.action,
        enforcement: report.enforcement,
        declarationDigest: report.declarationDigest,
        detectionBoundary: facts.detectionBoundary,
        recoveryRoute: facts.recoveryRoute,
      },
    });
  });
}

/** Build a failure envelope from typed findings; nothing is reclassified here. */
function failure(command, findings, domain = {}) {
  const primary = findings.primary ?? { evidenceState: 'malformed', disposition: 'rejected' };
  return {
    ok: false,
    packet: null,
    validation: validation(command, false, primary.evidenceState, primary.disposition, findings, domain),
  };
}

/** One typed finding shorthand for the common single-cause failure. */
function singleFailure(command, evidenceState, disposition, message, domain = {}, code = null, repairHint = null) {
  const findings = findingSet(command, evidenceState);
  findings.add(evidenceState, message, { disposition, code: code ?? undefined, repairHint: repairHint ?? undefined });
  return failure(command, findings, domain);
}

/**
 * The closed inventory of typed public errors whose own classification this
 * boundary preserves instead of imposing its own.
 *
 * Only these exact codes are recognized. A caller-supplied error object is not
 * an authority on how its own failure should be graded: without this allow-list,
 * any thrown value carrying `evidenceState: 'current'` could talk its way into a
 * softer disposition than the boundary actually proved. Everything else - a
 * plain `Error`, a forged receipt, an unpinned adapter, an unknown code - is
 * classified by the caller-supplied fallback below.
 */
const PRESERVED_BOUNDARY_FAULTS = new Map([
  // A well-formed registry declaring a capability no in-process boundary can
  // authenticate. This is not a forgery, so flattening it into
  // `negative/rejected` would report an authentication failure that never
  // happened and hide the real, actionable boundary limitation.
  ['host.boundary.unsupported', { evidenceState: 'negative', disposition: 'blocked' }],
  ['verification.context.missing', { evidenceState: 'missing', disposition: 'needs_context' }],
  ['verification.context.malformed', { evidenceState: 'malformed', disposition: 'rejected' }],
  ['verification.context.stale', { evidenceState: 'stale', disposition: 'superseded' }],
  ['contract.baseline.stale', { evidenceState: 'changed', disposition: 'superseded' }],
]);

/** The only fault an authentication site may reclassify away from rejection. */
const UNSUPPORTED_BOUNDARY_CODE = 'host.boundary.unsupported';

/**
 * Classify a fault thrown by an injected boundary function.
 *
 * `recognized` narrows the allow-list to the codes that are meaningful at this
 * specific call site. An authentication site passes only the unsupported-boundary
 * code, so an unpinned adapter or unknown key stays a rejected authentication
 * failure rather than being softened into a missing-context result.
 *
 * @param {unknown} error
 * @param {string} fallbackState        Safe classification when the fault is not recognized.
 * @param {string} fallbackDisposition
 * @param {Iterable<string>} [recognized]
 * @returns {{ evidenceState: string, disposition: string, code: string|null }}
 */
function classifyBoundaryFault(error, fallbackState, fallbackDisposition, recognized = PRESERVED_BOUNDARY_FAULTS.keys()) {
  const allowed = new Set(recognized);
  // The throwing boundary may supply arbitrary values. Preserve a code only
  // when it came through the repository's typed public-error hierarchy; a
  // plain Error with a copied allow-listed `code` is not authoritative.
  const code = error instanceof PublicCommandError && typeof error.code === 'string'
    ? error.code
    : null;
  const preserved = code !== null && allowed.has(code) ? PRESERVED_BOUNDARY_FAULTS.get(code) : null;
  if (!preserved) {
    return { evidenceState: fallbackState, disposition: fallbackDisposition, code: null };
  }
  return { ...preserved, code };
}

function canonicalReferences(backend, roleId) {
  return [`agents/${roleId}.md`, 'skills/role-delegation/SKILL.md', `backends/${backend}.md`];
}

function requiredCapabilities(roleId) {
  return roleId === 'engineer' ? ['implementation_mutation'] : [];
}

function decompositionInventoryDigest(taskId, readyTaskIds) {
  if (typeof taskId !== 'string' || !Array.isArray(readyTaskIds)) return null;
  return `sha256:${canonicalSha256({ taskId, readyTaskIds: [...readyTaskIds].sort() })}`;
}

/**
 * The v1 inventory shape: a caller-declared completeness token plus a visible
 * ready set. It is retained only to recognize authentic prior evidence for
 * typed stale routing; it can no longer authorize dispatch, because it never
 * proved that decomposition and authoring covered the whole work unit.
 */
function legacyDecompositionInventoryValid(value) {
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
function authenticLegacyDecomposition(value, taskId) {
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

function decompositionSourceDigest(value) {
  if (!isObject(value)) return null;
  const { sourceDigest, ...rest } = value;
  try {
    return `sha256:${canonicalSha256(rest)}`;
  } catch {
    return null;
  }
}

function safeRepositoryPath(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('//') &&
    !value.split('/').some(segment => segment === '.' || segment === '..');
}

/**
 * Build one closed decomposition record from validated parallel-scan evidence.
 *
 * Completeness and ready membership are *derived* from the scan record, never
 * accepted as caller assertions. A caller that has not run a scan that can
 * prove its bounded work unit was fully decomposed and authored cannot produce
 * a decomposition record that authorizes dispatch.
 *
 * The observation time and freshness policy are *not* caller inputs. They are
 * copied from the bound scan, because a caller that could supply them could
 * wrap a one-second scan in a one-day decomposition and rebind the freshness
 * policy the scan was actually observed under.
 *
 * @param {{ taskId: string, sourceRef: string, scan: any, route?: 'serial'|'parallel' }} input
 * @param {{ now?: number }} [options]  Injectable clock for the freshness check.
 */
export function createDecompositionProvenance(input = {}, options = {}) {
  const { taskId, sourceRef, scan, route = 'serial' } = input;
  const unknown = Object.keys(input).filter(key =>
    !['taskId', 'sourceRef', 'scan', 'route'].includes(key));
  if (unknown.length) throw new TypeError(`invalid decomposition provenance: unknown input field(s): ${unknown.join(', ')}`);
  const value = {
    kind: 'agenticloop.decomposition-provenance',
    schemaVersion: DECOMPOSITION_SCHEMA_VERSION,
    taskId,
    authority: 'maintainer',
    source: 'task-decomposition',
    route,
    scan: structuredClone(scan ?? null),
    observedAt: scan?.observedAt ?? null,
    freshnessPolicy: { maxAgeSeconds: scan?.freshnessPolicy?.maxAgeSeconds ?? null },
    sourceRef,
    sourceDigest: null,
  };
  value.sourceDigest = decompositionSourceDigest(value);
  const findings = findingSet('task prepare-dispatch');
  validateDecomposition(value, taskId, findings, { now: options.now });
  if (findings.length) throw new TypeError(`invalid decomposition provenance: ${findings.messages.join('; ')}`);
  return deepFreeze(value);
}

/**
 * Produce one committed decomposition source from an authoritative enumeration.
 *
 * This is the production path that emits what dispatch requires. It is
 * read-only: it enumerates, scans, validates, and renders canonical JSON, and
 * it never touches a task, a carrier, Git, GitHub, or lifecycle state.
 *
 * The enumerator is injected. The files backend supplies a directory listing
 * today; a GitHub adapter can supply an authoritative paginated inventory later
 * without forking any scan semantics, because everything after enumeration is
 * this one shared path.
 *
 * @param {{
 *   enumerateInventory: () => any,
 *   workUnit: { id: string, backend: string },
 *   taskId: string,
 *   sourceRef: string,
 *   sourceRevision: string,
 *   route?: 'serial'|'parallel',
 *   observedAt: string,
 *   freshnessPolicy: { maxAgeSeconds: number },
 *   basePaths: string[],
 *   readinessContext: { base: any, dependencies: any },
 *   dependencies?: Record<string, string>,
 *   rescanTrigger: string,
 *   joinPlans?: Record<string, any>,
 *   laneArtifacts?: Record<string, any>,
 *   declaredCompleteness?: 'complete'|'incomplete',
 * }} input
 * @param {{ now?: number }} [options]
 * @returns {{ ok: boolean, validation: any, scan: any|null, decomposition: any|null, source: string|null }}
 */
export function prepareDecompositionSource(input = {}, options = {}) {
  const command = 'task prepare-decomposition';
  const now = options.now ?? Date.now();
  const emptyResult = (evidenceState, disposition, message) => ({
    ...singleFailure(command, evidenceState, disposition, message),
    scan: null,
    decomposition: null,
    source: null,
  });
  try {
    if (typeof input?.enumerateInventory !== 'function') {
      return emptyResult('missing', 'needs_context', 'an authoritative task-inventory enumerator is required');
    }
    if (!TASK_ID_RE.test(String(input?.taskId ?? ''))) {
      return emptyResult('missing', 'needs_context', 'decomposition preparation requires the exact target task id');
    }
    let inventory;
    try {
      inventory = input.enumerateInventory();
    } catch (error) {
      return emptyResult('missing', 'needs_context', `authoritative task-inventory enumeration failed: ${error.message}`);
    }
    const scanned = evaluateParallelScan({
      workUnit: input.workUnit,
      inventory,
      decomposition: {
        source: 'task-decomposition',
        sourceRef: input.sourceRef,
        revision: input.sourceRevision,
        declaredCompleteness: input.declaredCompleteness ?? 'complete',
        attribution: 'maintainer',
      },
      observedAt: input.observedAt,
      freshnessPolicy: input.freshnessPolicy,
      basePaths: input.basePaths,
      dependencies: input.dependencies ?? {},
      readinessContext: input.readinessContext,
      rescanTrigger: input.rescanTrigger,
      joinPlans: input.joinPlans ?? {},
      laneArtifacts: input.laneArtifacts ?? {},
    }, { now });
    if (!scanned.ok) {
      return { ok: false, validation: scanned.result, scan: scanned.scan, decomposition: null, source: null };
    }
    // The emitted scan is held to the exact validator dispatch runs on it, in
    // this process, before anything is rendered for commit.
    const scanCheck = validateParallelScanRecord(scanned.scan, { now });
    if (!scanCheck.ok) {
      const findings = findingSet(command);
      for (const error of scanCheck.errors) {
        findings.malformed(`emitted parallel-scan record is not consumer-valid: ${error}`, {
          code: 'parallel_scan.record.invalid',
        });
      }
      return { ...failure(command, findings), scan: scanned.scan, decomposition: null, source: null };
    }
    let decomposition;
    try {
      decomposition = createDecompositionProvenance({
        taskId: input.taskId,
        sourceRef: input.sourceRef,
        scan: scanned.scan,
        route: input.route ?? 'serial',
      }, { now });
    } catch (error) {
      const findings = findingSet(command);
      findings.negative(error.message, { code: 'parallel_scan.decomposition.invalid' });
      return { ...failure(command, findings), scan: scanned.scan, decomposition: null, source: null };
    }
    return {
      ok: true,
      validation: validation(command, true, 'current', 'proceed', null),
      scan: scanned.scan,
      decomposition,
      // Deterministic canonical JSON: the same inputs render the same bytes, so
      // the committed source digest is reproducible by any reviewer.
      source: `${canonicalJson(decomposition)}\n`,
    };
  } catch (error) {
    return emptyResult('malformed', 'rejected', `decomposition preparation could not be evaluated: ${error.message}`);
  }
}

/**
 * Build a capture only from an adapter-owned parser producer. Capability is
 * looked up from the resolved inventory and is never accepted as input data.
 *
 * A `supported` adapter must sign its capture with the isolated host private
 * key: without that signature nothing distinguishes a parser-owned artifact
 * from a model-authored one.
 *
 * @param {any} input
 * @param {{ capabilities?: Record<string, any> }} [options]
 */
export function captureActivationInput(input = {}, options = {}) {
  const {
    adapter = 'opencode.command.positional.v1',
    captureId = `capture:${randomUUID()}`,
    intendedTaskId = null,
    expectedRequestSha256 = null,
    parserNormalizedPayload = null,
    capturedAt = null,
    expiresAt = null,
    sign = null,
    captureCapability: assertedCapability,
  } = input;
  if (assertedCapability !== undefined) {
    throw new TypeError('activation capture capability is derived from the selected adapter and cannot be asserted');
  }
  const resolved = resolveInventory(options);
  if (!resolved.ok) throw new TypeError('activation capability inventory must be an object');
  const capability = resolved.inventory[adapter];
  if (!capability) throw new TypeError(`activation adapter '${adapter}' is not in the resolved capability inventory`);
  if (capability.captureCapability === 'unsupported') {
    return deepFreeze({
      kind: ACTIVATION_CAPTURE_KIND,
      schemaVersion: ACTIVATION_CAPTURE_SCHEMA_VERSION,
      adapter,
      captureCapability: 'unsupported',
      integrity: 'missing',
      captureId: null,
      intendedTaskId: null,
      operatorExpectedDigest: null,
      normalizedActivationDigest: null,
      capturedAt: null,
      expiresAt: null,
      repositoryIdentity: null,
      signature: null,
    });
  }
  if (typeof parserNormalizedPayload !== 'string') {
    throw new TypeError('parser-normalized activation payload must be an exact UTF-8 string');
  }
  if (!isObject(sign) || typeof sign.keyId !== 'string' || !sign.keyId.trim() || !sign.privateKey) {
    throw new TypeError('a supported activation adapter must sign its capture with the isolated host private key');
  }
  if (capability.trustedAdapter?.repositoryIdentity === undefined || typeof capability.trustedAdapter.repositoryIdentity !== 'string') {
    throw new TypeError('a supported activation adapter must be scoped to an operator-pinned target repository');
  }
  if (!CAPTURE_ID_RE.test(String(captureId ?? ''))) {
    throw new TypeError('supported activation captureId must use the canonical capture:<uuid-v4> format');
  }
  if (!TASK_ID_RE.test(String(intendedTaskId ?? ''))) {
    throw new TypeError('supported activation capture intendedTaskId is required');
  }
  if (!isoTimestamp(expiresAt, { futureAllowed: true })) {
    throw new TypeError('supported activation capture expiresAt must be an ISO-8601 UTC instant');
  }
  const captured = capturedAt ?? new Date().toISOString();
  if (!isoTimestamp(captured) || Date.parse(expiresAt) <= Date.parse(captured)) {
    throw new TypeError('supported activation capture expiry must be later than capturedAt');
  }
  const operatorExpectedDigest = expectedRequestSha256 === null || expectedRequestSha256 === undefined || expectedRequestSha256 === ''
    ? null
    : normalizeSha256(expectedRequestSha256);
  if (operatorExpectedDigest !== null && !SHA256_RE.test(operatorExpectedDigest)) {
    throw new TypeError('operator expected request digest must be SHA-256 text');
  }
  const normalizedActivationDigest = digestBytes(parserNormalizedPayload);
  const skeleton = {
    kind: ACTIVATION_CAPTURE_KIND,
    schemaVersion: ACTIVATION_CAPTURE_SCHEMA_VERSION,
    adapter,
    captureCapability: 'supported',
    integrity: operatorExpectedDigest === null
      ? 'missing'
      : operatorExpectedDigest === normalizedActivationDigest ? 'verified' : 'mismatch',
    captureId,
    intendedTaskId,
    operatorExpectedDigest,
    normalizedActivationDigest,
    capturedAt: captured,
    expiresAt,
    repositoryIdentity: capability.trustedAdapter.repositoryIdentity,
    signature: null,
  };
  // Signing is the host's act: the private key is supplied by the caller at its
  // own boundary and is never read from configuration or the environment here.
  return deepFreeze(signActivationCapture(skeleton, { keyId: sign.keyId, privateKey: sign.privateKey }));
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
function validateDecomposition(value, taskId, findings, options = {}) {
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
  }

  validateDecompositionFreshness(value, findings, options);
}

function validateDecompositionFreshness(value, findings, options = {}) {
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

const DECOMPOSITION_BINDING_FIELDS = Object.freeze([
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
function decompositionBinding(source) {
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
function validateDecompositionBinding(value, taskId, findings, options = {}) {
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

const ACTIVATION_BINDING_FIELDS = Object.freeze(['kind', 'schemaVersion', 'grant', 'binding']);

const RETURN_ADAPTER_FIELDS = Object.freeze(['adapterId', 'keyId', 'capability']);

const DISPATCH_ASSURANCE_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'mode', 'policySource', 'activation', 'activationSource',
  'activationProducer', 'activationChannel', 'activationDerivation',
  'minimumActivation', 'minimumReturn', 'limitations',
]);

/**
 * Project one validated grant/binding pair into the constant-size packet
 * binding. Like the decomposition binding, this restates verified facts; the
 * durable records themselves are refetched and revalidated on every dispatch.
 */
function activationBindingProjection(grant, binding) {
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
function dispatchAssurance({ policy, activation, activationSource, producerId, channel, derivation }) {
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

function validateActivationBindingProjection(value, { taskId, contract, findings }) {
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

function validateReturnAdapter(value, findings) {
  if (value === null) return;
  exactKeys(value, RETURN_ADAPTER_FIELDS, 'dispatch return adapter', findings);
  if (typeof value?.adapterId !== 'string' || !value.adapterId.trim()) findings.malformed('dispatch return adapter adapterId is required');
  if (typeof value?.keyId !== 'string' || !value.keyId.trim()) findings.malformed('dispatch return adapter keyId is required');
  if (value?.capability !== 'returnReceipt') findings.malformed("dispatch return adapter capability must be 'returnReceipt'");
}

function validateDispatchAssurance(value, { activationBinding, activation, findings }) {
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

function validateCleanStateBinding(value, findings, label = 'dispatch clean-state binding') {
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

function validateRepositoryBinding(value, findings, label = 'dispatch repository binding') {
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

function validateAssignment(
  value,
  { backend, taskId, repository, hostRoleCapabilities = HOST_ROLE_CAPABILITIES },
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
  if (!isoTimestamp(value?.liveness?.expiry, { futureAllowed: true })) findings.malformed('dispatch liveness expiry must be an ISO-8601 UTC instant');
  else if (Date.parse(value.liveness.expiry) <= Date.now()) findings.stale('dispatch liveness window has expired');
  if (typeof value?.liveness?.stopCondition !== 'string' || !value.liveness.stopCondition.trim()) findings.malformed('dispatch liveness stopCondition is required');
  if (value?.cancellationBoundary !== 'return_on_cancellation') findings.malformed("dispatch cancellationBoundary must be 'return_on_cancellation'");
}

function validateTaskSnapshot(snapshot, findings) {
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

function validateCurrentTask(snapshot, findings) {
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
  if (!baseline.ok) for (const message of baseline.errors) findings.malformed(message);
  if (contract.ok && contract.projection?.task_id !== snapshot.taskId) findings.malformed('current task snapshot identity does not match the material contract');
  return contract.ok ? contract : null;
}

function validateReadiness(readiness, snapshot, findings) {
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
function evaluateInitialState({ runGit, scopePatterns, intendedCreations, priorGateReceipts, readCarrierDigest }, findings) {
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
function resolveDispatchActivation(input, findings) {
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
    findings.changed('activation capture target repository does not match dispatch repository');
    return null;
  }
  let bound = true;
  if (contract?.projection?.activation_input_digest !== capture?.normalizedActivationDigest) {
    findings.changed('task contract activation_input_digest does not match verified activation digest');
    bound = false;
  }
  // The authored task must reference the exact signed capture artifact, so a
  // frontmatter digest alone cannot stand in for parser-owned authoring.
  if (contract?.ok && !safeRepositoryPath(contract.projection?.activation_capture_ref)) {
    findings.missing(
      'task contract lacks a validated activation_capture_ref authoring provenance reference; ' +
      'a scaffold task cannot authorize dispatch until `npx agenticloop activate <task-id>` creates a task activation binding'
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

function dispatchBindings(input, findings) {
  const {
    snapshot,
    readiness,
    decomposition,
    assignment,
    repository,
    hostRoleCapabilities,
  } = input;
  const contract = validateCurrentTask(snapshot, findings);
  if (contract?.ok) {
    const strictChecks = parseRequiredCheckInventory(contract.projection.required_checks);
    for (const error of strictChecks.errors) findings.malformed(`task contract required checks are invalid for dispatch: ${error}`);
  }
  validateReadiness(readiness, snapshot, findings);
  validateRepositoryBinding(repository, findings);
  validateDecomposition(decomposition, snapshot?.taskId, findings);
  validateAssignment(assignment, {
    backend: snapshot?.backend,
    taskId: snapshot?.taskId,
    repository,
    hostRoleCapabilities,
  }, findings);
  const activation = resolveDispatchActivation({
    evidence: input.activationEvidence,
    snapshot,
    contract,
    decomposition,
    repository,
    capabilities: input.capabilities,
    verifyActivationSignature: input.verifyActivationSignature,
    now: input.now,
  }, findings);
  const baseIdentity = gitTreeObjectId(readiness?.evidence?.base?.identity);
  if (!baseIdentity) findings.malformed('dispatch readiness base identity must be a full git-tree identity');
  else if (repository?.baseTree !== baseIdentity) findings.changed('dispatch repository baseTree must equal readiness base Git-tree identity');
  return { contract, activation };
}

function packetTaskBinding(snapshot, contract) {
  const projection = contract.projection;
  const requiredChecks = parseRequiredCheckInventory(projection.required_checks);
  return {
    id: snapshot.taskId,
    carrier: snapshot.carrier,
    dispatchCarrierDigest: snapshot.digest,
    taskContractDigest: contract.digest,
    // Grant-bound activation never rewrites task frontmatter, so these legacy
    // provenance fields are absent - and null - for that path.
    activationDigest: projection.activation_input_digest ?? null,
    activationCaptureRef: projection.activation_capture_ref ?? null,
    scope: projection.scope,
    outOfScope: projection.out_of_scope,
    allowedPaths: projection.allowed_paths,
    intendedCreations: projection.intended_creations,
    acceptanceCriteria: projection.acceptance_criteria,
    preAuthorizedDeviationPaths: parseDeviations(snapshot.body).entries.map(entry => entry.path).sort(),
    requiredChecks: requiredChecks.ok ? requiredChecks.checks : [],
    requiredCheckEvidenceContract: REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
    independentReviewRequired: projection.independent_review_required,
    lockedDecisionRefs: projection.locked_decision_refs,
  };
}

/**
 * Derive the complete packet/task binding from an authoritative task snapshot.
 * This helper never consumes packet fields, so a recomputed packet digest
 * cannot influence the expected current binding.
 */
export function authoritativePacketTaskBinding(snapshot) {
  if (!isObject(snapshot)) return { ok: false, binding: null, error: 'authoritative task snapshot must be an object' };
  if (!['files', 'github'].includes(snapshot.backend)) return { ok: false, binding: null, error: 'authoritative task backend is invalid' };
  if (typeof snapshot.taskId !== 'string' || !snapshot.taskId ||
      typeof snapshot.carrier !== 'string' || !snapshot.carrier ||
      typeof snapshot.body !== 'string' || !snapshot.body ||
      digestBytes(snapshot.body) !== snapshot.digest) {
    return { ok: false, binding: null, error: 'authoritative task identity or exact carrier digest is invalid' };
  }
  const contract = taskContractDigest(snapshot.body);
  if (!contract.ok || contract.projection.task_id !== snapshot.taskId) {
    return { ok: false, binding: null, error: contract.error ?? 'authoritative task contract identity is invalid' };
  }
  const strictChecks = parseRequiredCheckInventory(contract.projection.required_checks);
  if (!strictChecks.ok) {
    return {
      ok: false,
      binding: null,
      error: `authoritative task required checks are invalid for dispatch: ${strictChecks.errors.join('; ')}`,
    };
  }
  return {
    ok: true,
    binding: { backend: snapshot.backend, task: packetTaskBinding(snapshot, contract) },
    contract,
    error: null,
  };
}

function packetFromBindings({ snapshot, activation, returnAdapter, readiness, decomposition, assignment, repository, contract, policy }) {
  /** @type {any} */
  const packet = {
    kind: DISPATCH_PREPARATION_KIND,
    schemaVersion: DISPATCH_PREPARATION_SCHEMA_VERSION,
    packetId: `dispatch:${randomUUID()}`,
    backend: snapshot.backend,
    task: packetTaskBinding(snapshot, contract),
    activation: activation.capture === null ? null : structuredClone(activation.capture),
    activationBinding: activation.binding === null ? null : structuredClone(activation.binding),
    returnAdapter: returnAdapter === null ? null : structuredClone(returnAdapter),
    assurance: dispatchAssurance({
      policy,
      activation: activation.assurance,
      activationSource: activation.source,
      producerId: activation.producerId,
      channel: activation.channel,
      derivation: activation.derivation,
    }),
    readiness: structuredClone(readiness),
    decomposition: decompositionBinding(decomposition),
    assignment: structuredClone(assignment),
    repository: structuredClone(repository),
    freshness: { invalidatedBy: [...RETURN_INVALIDATORS] },
  };
  packet.digest = dispatchPreparationDigest(packet);
  return packet;
}

/**
 * The default assurance policy for a caller that supplies none: standard mode
 * from the shipped default source. A caller that has resolved external operator
 * policy passes it explicitly; nothing here reads configuration.
 */
const DEFAULT_ASSURANCE_POLICY = Object.freeze({
  mode: 'standard',
  policySource: 'default',
  minimumActivation: MODE_MINIMUMS.standard.activation,
  minimumReturn: MODE_MINIMUMS.standard.return,
});

function normalizeAssurancePolicy(value) {
  if (!isObject(value)) return { ok: true, policy: DEFAULT_ASSURANCE_POLICY };
  const mode = value.mode ?? DEFAULT_ASSURANCE_POLICY.mode;
  if (!ACTIVATION_MODES.includes(mode)) return { ok: false, policy: null };
  const source = value.policySource ?? value.source ?? 'default';
  if (!POLICY_SOURCES.includes(source)) return { ok: false, policy: null };
  return {
    ok: true,
    policy: {
      mode,
      policySource: source,
      minimumActivation: MODE_MINIMUMS[mode].activation,
      minimumReturn: MODE_MINIMUMS[mode].return,
    },
  };
}

/** Public canonical digest helper for persisted packet readers and fixtures. */
export function dispatchPreparationDigest(packet) {
  return semanticDigest(`agenticloop.role-preparation.v${DISPATCH_PREPARATION_SCHEMA_VERSION}`, projection(packet));
}

export function legacyDispatchPreparationDigest(packet, schemaVersion = packet?.schemaVersion) {
  if (!LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSIONS.includes(schemaVersion)) return null;
  return semanticDigest(`agenticloop.role-preparation.v${schemaVersion}`, projection(packet));
}

/** Prior packet versions this boundary can still authenticate as typed stale. */
const LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSIONS = Object.freeze([
  BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION,
  LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION,
  SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
  ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
  CARRIER_NAMED_DISPATCH_PREPARATION_SCHEMA_VERSION,
  REQUIRED_CHECK_EVIDENCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION,
]);

/**
 * Refetch, validate, and bind one single-role implementation dispatch.
 *
 * Activation resolves in one fixed order: a current valid legacy host-signed
 * task capture, then a current valid task activation binding, then blocked.
 *
 * @param {any} input
 * @param {{
 *   capabilities?: Record<string, any>,
 *   verifyActivationSignature?: Function,
 *   assurancePolicy?: { mode?: string, policySource?: string },
 * }} [options]
 */
export function prepareRoleDispatch(input = {}, options = {}) {
  const command = 'task prepare-dispatch';
  try {
    const {
      refetchTask,
      refetchReadiness,
      refetchRepository,
      refetchDecomposition,
      refetchParallelScanInventory,
      refetchActivation = null,
      refetchActivationEvidence = null,
      runGit,
      priorGateReceipts = [],
      readCarrierDigest = null,
      assignment,
    } = input;
    const resolved = resolveInventory(options);
    if (!resolved.ok) return singleFailure(command, 'malformed', 'rejected', 'activation capability inventory must be an object');
    const policyCheck = normalizeAssurancePolicy(options.assurancePolicy);
    if (!policyCheck.ok) return singleFailure(command, 'malformed', 'rejected', 'dispatch assurance policy is invalid');
    const policy = policyCheck.policy;
    for (const [name, label] of [
      ['refetchTask', 'a current task refetch function is required'],
      ['refetchReadiness', 'an authoritative readiness refetch function is required'],
      ['refetchRepository', 'a current repository refetch function is required'],
      ['refetchDecomposition', 'an authoritative decomposition refetch function is required'],
      ['refetchParallelScanInventory', 'an authoritative parallel-scan inventory refetch function is required'],
    ]) {
      if (typeof input[name] !== 'function') return singleFailure(command, 'missing', 'needs_context', label);
    }
    let activationEvidence = input.activationEvidence
      ?? (input.activation === undefined || input.activation === null
        ? null
        : { source: 'legacy_task_capture', capture: input.activation });
    let snapshot;
    let readiness;
    let repository;
    let decomposition;
    let parallelScanInventory;
    try {
      snapshot = refetchTask();
      // When a provider is supplied the activation evidence is read from the
      // task's own durable provenance, so a caller cannot substitute one.
      if (typeof refetchActivationEvidence === 'function') {
        activationEvidence = refetchActivationEvidence({ snapshot });
      } else if (typeof refetchActivation === 'function') {
        activationEvidence = { source: 'legacy_task_capture', capture: refetchActivation({ snapshot }) };
      }
      readiness = refetchReadiness({ snapshot });
      repository = refetchRepository({ snapshot, readiness });
      decomposition = refetchDecomposition({ snapshot, readiness, repository });
      if (decomposition?.schemaVersion === DECOMPOSITION_SCHEMA_VERSION) {
        parallelScanInventory = refetchParallelScanInventory({ snapshot, readiness, repository, decomposition });
      }
    } catch (error) {
      const state = typeof error?.evidenceState === 'string' ? error.evidenceState : 'missing';
      const disposition = typeof error?.disposition === 'string' ? error.disposition : 'blocked';
      // A typed public error already names its own exact repair - for an
      // unactivated task that is the literal `npx agenticloop activate ...`
      // command. Preserve it instead of replacing it with a generic hint.
      const repairHint = error instanceof PublicCommandError ? error.safeRepair : null;
      return singleFailure(
        command, state, disposition, `authoritative refetch failed: ${error.message}`, {}, null, repairHint
      );
    }
    const findings = findingSet(command);
    let boundAssignment = assignment;
    try {
      boundAssignment = {
        ...assignment,
        worktree: pathIdentity(assignment?.worktree).authorityPath,
        degradedEnforcementReports: createDegradedEnforcementReports(assignment?.hostRoleCapability),
      };
    } catch (error) {
      findings.malformed(
        `dispatch assignment host-role capability declaration is invalid: ${error.message}`,
        { code: 'capability.declaration.invalid' }
      );
      return failure(command, findings);
    }
    // Task scope decides which untracked additions are relevant, so it is read
    // from the refetched record rather than supplied by the dispatch caller.
    const scopeContract = taskContractDigest(snapshot?.body);
    const cleanState = evaluateInitialState({
      runGit,
      scopePatterns: scopeContract.ok ? scopeContract.projection.allowed_paths ?? [] : [],
      intendedCreations: scopeContract.ok ? scopeContract.projection.intended_creations ?? [] : [],
      priorGateReceipts,
      readCarrierDigest,
    }, findings);
    if (!cleanState) return failure(command, findings);
    const bound = { ...repository, worktree: pathIdentity(repository?.worktree).authorityPath, cleanState };
    const checked = dispatchBindings({
      snapshot,
      activationEvidence,
      readiness,
      decomposition,
      assignment: boundAssignment,
      repository: bound,
      capabilities: options.capabilities,
      verifyActivationSignature: options.verifyActivationSignature,
      hostRoleCapabilities: options.hostRoleCapabilities,
    }, findings);
    if (findings.length) return failure(command, findings);
    if (!checked.activation) {
      findings.missing(
        'dispatch could not resolve any current activation authority for this task',
        { code: 'activation.capture.missing' }
      );
      return failure(command, findings);
    }
    // Effective policy is enforced before the packet is minted, so a
    // below-policy grade never reaches a signed dispatch artifact.
    if (!activationAssuranceMeets(checked.activation.assurance, policy.minimumActivation)) {
      findings.negative(
        `activation assurance '${checked.activation.assurance}' is below the effective minimum ` +
        `'${policy.minimumActivation}' required by ${policy.mode} mode (policy source: ${policy.policySource})`,
        { code: 'activation.assurance.insufficient', disposition: 'blocked' }
      );
      return failure(command, findings);
    }
    if (decomposition?.schemaVersion === DECOMPOSITION_SCHEMA_VERSION &&
        decomposition?.scan?.inventory?.complete === true &&
        decomposition?.scan?.decomposition?.state === 'complete') {
      const inventoryBinding = validateParallelScanInventoryBinding(decomposition.scan, parallelScanInventory);
      for (const error of inventoryBinding.errors) {
        findings.stale(error, { code: 'dispatch.packet.stale', disposition: 'superseded' });
      }
      // The base inventory and dependency snapshot decide readiness for the
      // whole ready set without changing any task carrier digest, so the
      // authoritatively refetched readiness evidence is compared with the
      // context the scan bound - not only with the dispatched task's record.
      const readinessBinding = validateParallelScanReadinessBinding(decomposition.scan, {
        base: readiness?.evidence?.base,
        dependencies: readiness?.evidence?.dependencies ?? null,
      });
      for (const error of readinessBinding.errors) {
        findings.stale(error, { code: 'dispatch.packet.stale', disposition: 'superseded' });
      }
    }
    if (findings.length) return failure(command, findings);
    const returnAdapter = options.returnAdapter ?? null;
    if (policy.minimumReturn === 'host_receipt' && returnAdapter === null) {
      findings.missing('hardened dispatch requires an explicitly pinned protected-boundary return adapter', {
        code: 'return.assurance.insufficient', disposition: 'blocked',
      });
      return failure(command, findings);
    }
    const packet = packetFromBindings({
      snapshot, activation: checked.activation, readiness, decomposition,
      assignment: boundAssignment, repository: bound, contract: checked.contract, policy, returnAdapter,
    });
    const resolveEmittedAuthority = candidate => resolveTaskActivationBinding({
      grant: candidate.activationBinding?.grant,
      binding: candidate.activationBinding?.binding,
      repositoryIdentity: targetRepositoryIdentity(candidate.repository?.worktree),
      backend: candidate.backend,
      taskId: candidate.task?.id,
      carrier: candidate.task?.carrier,
      taskContractDigest: candidate.task?.taskContractDigest,
      verifySignature: options.verifyActivationSignature,
      revocations: activationEvidence?.revocations ?? [],
      decomposition,
    });
    const packetValidation = validateDispatchPreparation(packet, {
      ...options,
      resolveActivationBinding: options.resolveActivationBinding ?? resolveEmittedAuthority,
    });
    if (!packetValidation.ok) {
      const emitted = findingSet(command);
      emitted.extend(packetValidation.findings);
      return failure(command, emitted);
    }
    return {
      ok: true,
      packet: frozenClone(packet),
      validation: validation(command, true, 'current', 'proceed', null, {
        warningDiagnostics: degradedWarningDiagnostics(
          boundAssignment.degradedEnforcementReports,
          boundAssignment.hostRoleCapability
        ),
        degradedEnforcementReports: boundAssignment.degradedEnforcementReports,
      }),
    };
  } catch (error) {
    return singleFailure(command, 'malformed', 'rejected', `dispatch preparation could not be evaluated: ${error.message}`);
  }
}

/**
 * Validate a persisted packet without treating its digest as sufficient proof.
 * Total over every JSON-compatible input.
 *
 * @param {any} packet
 * @param {{ capabilities?: Record<string, any> }} [options]
 */
function closedKeys(value, expected) {
  if (!isObject(value)) return false;
  const wanted = new Set(expected);
  const actual = Object.keys(value);
  return actual.length === wanted.size && actual.every(key => wanted.has(key));
}

const DISPATCH_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'packetId', 'backend', 'task', 'activation', 'activationBinding',
  'returnAdapter', 'assurance', 'readiness', 'decomposition', 'assignment', 'repository', 'freshness', 'digest',
]);
const V6_DISPATCH_FIELDS = DISPATCH_FIELDS;
/** The v2-v5 envelope: one activation model, no assurance dimensions. */
const ASSURANCE_UNBOUND_DISPATCH_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'packetId', 'backend', 'task', 'activation', 'readiness',
  'decomposition', 'assignment', 'repository', 'freshness', 'digest',
]);
const V2_ASSIGNMENT_FIELDS = Object.freeze([
  'roleId', 'worktree', 'branch', 'requiredCapabilities', 'canonicalReferences',
  'attribution', 'liveness', 'cancellationBoundary', 'invocationId',
]);
const V3_ASSIGNMENT_FIELDS = Object.freeze([
  'roleId', 'host', 'hostRoleCapability',
  'worktree', 'branch', 'requiredCapabilities', 'canonicalReferences',
  'attribution', 'liveness', 'cancellationBoundary', 'invocationId',
]);

const V4_ASSIGNMENT_FIELDS = Object.freeze([...V3_ASSIGNMENT_FIELDS, 'degradedEnforcementReports']);

function legacyDispatchCandidate(packet, schemaVersion) {
  const assignmentFields = schemaVersion === BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION
    ? V2_ASSIGNMENT_FIELDS
    : schemaVersion === SCAN_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION ||
      schemaVersion === ASSURANCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION ||
      schemaVersion === CARRIER_NAMED_DISPATCH_PREPARATION_SCHEMA_VERSION ||
      schemaVersion === REQUIRED_CHECK_EVIDENCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION
      ? V4_ASSIGNMENT_FIELDS
      : V3_ASSIGNMENT_FIELDS;
  const fields = schemaVersion === CARRIER_NAMED_DISPATCH_PREPARATION_SCHEMA_VERSION ||
    schemaVersion === REQUIRED_CHECK_EVIDENCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION
    ? V6_DISPATCH_FIELDS
    : ASSURANCE_UNBOUND_DISPATCH_FIELDS;
  return packet?.kind === DISPATCH_PREPARATION_KIND &&
    packet?.schemaVersion === schemaVersion &&
    closedKeys(packet, fields) &&
    closedKeys(packet.assignment, assignmentFields) &&
    typeof packet.packetId === 'string' &&
    /^dispatch:[0-9a-f-]{36}$/.test(packet.packetId) &&
    packet.digest === legacyDispatchPreparationDigest(packet, schemaVersion);
}

function currentProjectionOfLegacy(packet, schemaVersion, options) {
  const projected = structuredClone(packet);
  projected.schemaVersion = DISPATCH_PREPARATION_SCHEMA_VERSION;
  if (schemaVersion === CARRIER_NAMED_DISPATCH_PREPARATION_SCHEMA_VERSION) {
    projected.task = {
      ...projected.task,
      dispatchCarrierDigest: projected.task.digest,
      taskContractDigest: projected.task.contractDigest,
    };
    delete projected.task.digest;
    delete projected.task.contractDigest;
  }
  projected.task.requiredCheckEvidenceContract = REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION;
  if (schemaVersion === BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION) {
    const inventory = options.hostRoleCapabilities ?? HOST_ROLE_CAPABILITIES;
    const host = inventory.opencode ? 'opencode' : Object.keys(inventory)[0];
    const declaration = inventory?.[host]?.[projected.assignment.roleId];
    if (!declaration) return null;
    projected.assignment.host = host;
    projected.assignment.hostRoleCapability = structuredClone(declaration);
  }
  projected.assignment.degradedEnforcementReports =
    createDegradedEnforcementReports(projected.assignment.hostRoleCapability);
  // Prior envelopes had exactly one activation model - a host-signed capture -
  // and no assurance statement. The projection restates that truthfully so the
  // packet can be recognized as authentic prior evidence and routed to typed
  // regeneration; it never lets that evidence authorize a dispatch.
  if (schemaVersion !== CARRIER_NAMED_DISPATCH_PREPARATION_SCHEMA_VERSION &&
      schemaVersion !== REQUIRED_CHECK_EVIDENCE_UNBOUND_DISPATCH_PREPARATION_SCHEMA_VERSION) {
    projected.activationBinding = null;
    projected.returnAdapter = null;
    projected.assurance = dispatchAssurance({
      policy: DEFAULT_ASSURANCE_POLICY,
      activation: 'host_signed',
      activationSource: 'legacy_task_capture',
      producerId: projected.activation?.adapter ?? 'unknown',
      channel: 'protected_host_boundary',
      derivation: 'legacy_task_capture',
    });
  }
  projected.digest = dispatchPreparationDigest(projected);
  return projected;
}

function staleDispatchVersionResult(observedVersion) {
  const findings = findingSet('task prepare-dispatch');
  findings.changed(
    `dispatch preparation schemaVersion ${observedVersion} is stale; ` +
    `regenerate the packet as schemaVersion ${DISPATCH_PREPARATION_SCHEMA_VERSION} before dispatch or return import`,
    { code: 'dispatch.packet.stale', disposition: 'superseded' }
  );
  return { ok: false, errors: findings.messages, findings: findings.items };
}

const LEGACY_DEGRADED_ENFORCEMENT_REPORT_SCHEMA_VERSION = 3;

/** Reconstruct the exact v3 reports emitted by schema-v5 packets before the compact v4 report schema. */
function legacyV3DegradedEnforcementReports(declaration) {
  return createDegradedEnforcementReports(declaration).map(report => ({
    ...report,
    schemaVersion: LEGACY_DEGRADED_ENFORCEMENT_REPORT_SCHEMA_VERSION,
    limitation: declaration.limitation,
    detectionBoundary: declaration.detectionBoundary,
    recoveryRoute: declaration.recoveryRoute,
  }));
}

/**
 * Classify only an authentic current-envelope packet whose nested degraded
 * reports are the exact canonical v3 projection. The projected packet must
 * pass every current semantic check; malformed lookalikes are never promoted
 * into the trusted stale class.
 */
function legacyNestedDegradedReportCandidate(packet, options = {}) {
  if (packet?.kind !== DISPATCH_PREPARATION_KIND ||
      packet?.schemaVersion !== DISPATCH_PREPARATION_SCHEMA_VERSION ||
      packet?.digest !== dispatchPreparationDigest(packet)) return false;
  const declaration = packet?.assignment?.hostRoleCapability;
  const reports = packet?.assignment?.degradedEnforcementReports;
  if (!Array.isArray(reports) || !sameCanonical(reports, legacyV3DegradedEnforcementReports(declaration))) return false;
  const projected = structuredClone(packet);
  projected.assignment.degradedEnforcementReports = createDegradedEnforcementReports(declaration);
  projected.digest = dispatchPreparationDigest(projected);
  return validateCurrentDispatchPreparation(projected, options).ok;
}

function staleNestedDegradedReportResult() {
  const findings = findingSet('task prepare-dispatch');
  findings.changed(
    `dispatch preparation degraded-enforcement report schemaVersion ${LEGACY_DEGRADED_ENFORCEMENT_REPORT_SCHEMA_VERSION} is stale; ` +
    'regenerate the packet before dispatch or return import',
    { code: 'dispatch.packet.stale', disposition: 'superseded' }
  );
  return { ok: false, errors: findings.messages, findings: findings.items };
}

function validateCurrentDispatchPreparation(packet, options = {}) {
  const findings = findingSet('task prepare-dispatch');
  try {
    const shapeOk = exactKeys(packet, DISPATCH_FIELDS, 'dispatch preparation', findings);
    if (packet?.kind !== DISPATCH_PREPARATION_KIND) findings.malformed(`dispatch preparation kind must be '${DISPATCH_PREPARATION_KIND}'`);
    if (packet?.schemaVersion !== DISPATCH_PREPARATION_SCHEMA_VERSION) findings.malformed(`dispatch preparation schemaVersion must be ${DISPATCH_PREPARATION_SCHEMA_VERSION}`);
    if (typeof packet?.packetId !== 'string' || !/^dispatch:[0-9a-f-]{36}$/.test(packet.packetId)) findings.malformed('dispatch preparation packetId is invalid');
    if (!['files', 'github'].includes(packet?.backend)) findings.malformed('dispatch preparation backend is invalid');
    exactKeys(packet?.task, [
      'id', 'carrier', 'dispatchCarrierDigest', 'taskContractDigest', 'activationDigest', 'activationCaptureRef',
      'scope', 'outOfScope', 'allowedPaths', 'intendedCreations',
      'acceptanceCriteria', 'preAuthorizedDeviationPaths', 'requiredChecks', 'requiredCheckEvidenceContract', 'independentReviewRequired', 'lockedDecisionRefs',
    ], 'dispatch preparation task', findings);
    for (const key of ['id', 'carrier', 'scope']) {
      if (typeof packet?.task?.[key] !== 'string' || !packet.task[key]) findings.malformed(`dispatch preparation task ${key} is required`);
    }
    for (const key of ['outOfScope', 'acceptanceCriteria', 'independentReviewRequired']) {
      if (typeof packet?.task?.[key] !== 'string') findings.malformed(`dispatch preparation task ${key} must be a string`);
    }
    for (const key of ['allowedPaths', 'intendedCreations', 'preAuthorizedDeviationPaths', 'lockedDecisionRefs']) {
      if (!Array.isArray(packet?.task?.[key]) || packet.task[key].some(path => typeof path !== 'string')) {
        findings.malformed(`dispatch preparation task ${key} must be a string array`);
      }
    }
    const inventory = validateRequiredCheckInventory(packet?.task?.requiredChecks, {
      label: 'dispatch preparation task requiredChecks',
    });
    for (const error of inventory.errors) findings.malformed(error);
    if (packet?.task?.requiredCheckEvidenceContract !== REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION) {
      findings.malformed(`dispatch preparation task requiredCheckEvidenceContract must be ${REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION}`);
    }
    if (!SHA256_RE.test(packet?.task?.dispatchCarrierDigest ?? '')) findings.malformed('dispatch preparation task dispatchCarrierDigest must be sha256:<64 lowercase hex>');
    if (!CONTRACT_DIGEST_RE.test(packet?.task?.taskContractDigest ?? '')) findings.malformed('dispatch preparation task taskContractDigest must be sha256:v1:<64 lowercase hex>');
    const grantBound = packet?.assurance?.activationSource === 'activation_grant';
    if (grantBound) {
      // A grant never rewrites task frontmatter, so the legacy provenance
      // fields must be absent rather than invented.
      if (packet?.task?.activationDigest !== null || packet?.task?.activationCaptureRef !== null) {
        findings.malformed('a grant-bound dispatch packet must not claim legacy activation frontmatter provenance');
      }
      validateActivationBindingProjection(packet?.activationBinding, {
        taskId: packet?.task?.id,
        contract: { ok: true, digest: packet?.task?.taskContractDigest },
        findings,
      });
      if (typeof options.resolveActivationBinding !== 'function') {
        findings.missing('an external activation authority resolver is required for a grant-bound packet', {
          code: 'activation.grant.unauthenticated', disposition: 'blocked',
        });
      } else {
        const authority = options.resolveActivationBinding(packet);
        if (!authority?.ok) {
          for (const error of authority?.errors ?? [{ message: 'grant-bound packet activation authority did not validate', evidenceState: 'negative', code: 'activation.grant.unauthenticated' }]) {
            findings.add(error.evidenceState ?? 'negative', error.message, { code: error.code, disposition: authority?.disposition });
          }
        }
      }
    } else {
      if (!SHA256_RE.test(packet?.task?.activationDigest ?? '')) findings.malformed('dispatch preparation task activationDigest must be sha256:<64 lowercase hex>');
      if (!safeRepositoryPath(packet?.task?.activationCaptureRef)) findings.malformed('dispatch preparation task activationCaptureRef must be a safe repository-relative path');
      const capture = activationCaptureDisposition(packet?.activation, {
        ...options,
        intendedTaskId: packet?.task?.id,
        repositoryIdentity: targetRepositoryIdentity(packet?.repository?.worktree),
      });
      if (!capture.ok) findings.extend(capture.findings);
      if (packet?.task?.activationDigest !== packet?.activation?.normalizedActivationDigest) findings.changed('packet task activation digest must equal activation capture digest');
      if (packet?.activation?.repositoryIdentity !== targetRepositoryIdentity(packet?.repository?.worktree)) {
        findings.changed('packet activation target repository does not match dispatch repository');
      }
      if (packet?.activationBinding !== null) {
        findings.malformed('a legacy-capture dispatch packet must not also carry an activation binding');
      }
    }
    validateDispatchAssurance(packet?.assurance, {
      activationBinding: packet?.activationBinding ?? null,
      activation: packet?.activation ?? null,
      findings,
    });
    validateReturnAdapter(packet?.returnAdapter, findings);
    if (packet?.assurance?.minimumReturn === 'host_receipt' && packet?.returnAdapter === null) {
      findings.missing('a host_receipt packet minimum requires a pinned return adapter', { code: 'return.assurance.insufficient' });
    }
    validateReadiness(packet?.readiness, {
      backend: packet?.backend, taskId: packet?.task?.id, carrier: packet?.task?.carrier, digest: packet?.task?.dispatchCarrierDigest,
    }, findings);
    validateDecompositionBinding(packet?.decomposition, packet?.task?.id, findings, {
      allowLegacy: options.allowLegacyDecomposition === true,
    });
    validateRepositoryBinding(packet?.repository, findings);
    validateAssignment(packet?.assignment, {
      backend: packet?.backend,
      taskId: packet?.task?.id,
      repository: packet?.repository,
      hostRoleCapabilities: options.hostRoleCapabilities,
    }, findings);
    const baseIdentity = gitTreeObjectId(packet?.readiness?.evidence?.base?.identity);
    if (!baseIdentity) findings.malformed('packet readiness base identity must be a full git-tree identity');
    else if (packet?.repository?.baseTree !== baseIdentity) findings.changed('packet repository baseTree must equal readiness base Git-tree identity');
    exactKeys(packet?.freshness, ['invalidatedBy'], 'dispatch freshness', findings);
    if (!sameCanonical(packet?.freshness?.invalidatedBy, RETURN_INVALIDATORS)) findings.malformed('dispatch freshness invalidatedBy must equal the closed canonical inventory');
    if (!shapeOk || !SEMANTIC_DIGEST_RE.test(packet?.digest ?? '') || packet?.digest !== dispatchPreparationDigest(packet)) {
      findings.malformed('dispatch preparation digest is invalid');
    }
  } catch (error) {
    findings.malformed(`dispatch preparation could not be validated: ${error.message}`);
  }
  return { ok: findings.length === 0, errors: findings.messages, findings: findings.items };
}

export function validateDispatchPreparation(packet, options = {}) {
  try {
    if (legacyNestedDegradedReportCandidate(packet, options)) return staleNestedDegradedReportResult();
  } catch {
    // A structurally plausible but semantically malformed nested report is not
    // promoted into the trusted stale class.
  }
  for (const version of LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSIONS) {
    if (!legacyDispatchCandidate(packet, version)) continue;
    try {
      const projected = currentProjectionOfLegacy(packet, version, options);
      // Prior packets carry v1 decomposition evidence. `allowLegacyDecomposition`
      // authenticates them for this classification only; it never lets that
      // evidence authorize a dispatch.
      if (projected && validateCurrentDispatchPreparation(projected, { ...options, allowLegacyDecomposition: true }).ok) {
        return staleDispatchVersionResult(version);
      }
    } catch {
      // A structurally plausible but semantically malformed packet is not
      // promoted into the trusted legacy class.
    }
  }
  return validateCurrentDispatchPreparation(packet, options);
}

/**
 * Revalidate an emitted packet against current task and repository state,
 * including the initial-state gate, immediately before receiver mutation.
 *
 * @param {any} input
 * @param {{ capabilities?: Record<string, any> }} [options]
 */
export function verifyDispatchBeforeMutation(input = {}, options = {}) {
  const command = 'dispatch receive';
  try {
    const { packet, roleId } = input;
    const schema = validateDispatchPreparation(packet, options);
    if (!schema.ok) {
      const findings = findingSet(command);
      findings.extend(schema.findings);
      return failure(command, findings);
    }
    if (roleId !== packet.assignment.roleId) {
      return singleFailure(command, 'negative', 'rejected', 'receiving immutable role does not match packet assignment');
    }
    const current = prepareRoleDispatch({
      refetchTask: input.refetchTask,
      refetchReadiness: input.refetchReadiness,
      refetchRepository: input.refetchRepository,
      refetchDecomposition: input.refetchDecomposition,
      refetchParallelScanInventory: input.refetchParallelScanInventory,
      refetchActivation: input.refetchActivation ?? null,
      refetchActivationEvidence: input.refetchActivationEvidence ?? null,
      runGit: input.runGit,
      priorGateReceipts: input.priorGateReceipts ?? [],
      readCarrierDigest: input.readCarrierDigest ?? null,
      activation: packet.activation,
      assignment: packet.assignment,
    }, { ...options, assurancePolicy: options.assurancePolicy ?? packet.assurance });
    if (!current.ok) {
      const findings = findingSet(command);
      const state = current.validation.evidenceState;
      // A refetch that cannot even be evaluated stays missing; anything that
      // evaluated and disagrees supersedes the packet.
      findings.add(state, current.validation.errors[0] ?? 'dispatch preparation could not be revalidated', {
        disposition: state === 'missing' ? 'needs_context' : 'superseded',
      });
      for (const error of current.validation.errors.slice(1)) findings.add(state, error, { disposition: 'superseded' });
      return failure(command, findings);
    }
    const fields = [
      'backend', 'task', 'activation', 'activationBinding', 'assurance',
      'returnAdapter',
      'decomposition', 'assignment', 'repository', 'freshness',
    ];
    if (fields.some(field => !sameCanonical(current.packet[field], packet[field])) ||
        !sameCanonical(stableReadinessProjection(current.packet.readiness), stableReadinessProjection(packet.readiness))) {
      return singleFailure(command, 'changed', 'superseded', 'dispatch packet bindings changed after preparation');
    }
    return { ok: true, packet, validation: validation(command, true, 'current', 'proceed', null) };
  } catch (error) {
    return singleFailure(command, 'malformed', 'rejected', `dispatch receive could not be evaluated: ${error.message}`);
  }
}

function validateChecks(checks, findings, label = 'role return', contractVersion = null) {
  const checked = validateRequiredCheckEvidence(checks, { label, contractVersion });
  for (const error of checked.errors) findings.malformed(error);
}

/** Total validator for one role-return wire value. */
export function validateRoleReturn(value) {
  const findings = findingSet('role return receive');
  try {
    const has = key => isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
    const shapeOk = exactKeys(value, [
      'kind', 'schemaVersion', 'returnId', 'producerRole', 'packet', 'task', 'worktree', 'branch',
      'productBaseHead', 'productHead', 'workflowHead', 'candidateHead',
      'productChangedPaths', 'workflowChangedPaths', 'requiredCheckEvidenceContract', 'checks', 'productAttribution', 'pr', 'carrierLineage',
      'outcome', 'disposition', 'blocker', 'freshness', 'digest',
    ], 'role return', findings);
    // A closed-shape failure is the root cause. Continuing into children would
    // manufacture diagnostics for fields whose presence and type are unknown.
    if (!shapeOk) return { ok: false, errors: findings.messages, findings: findings.items };
    if (has('kind') && value.kind !== ROLE_RETURN_KIND) findings.malformed(`role return kind must be '${ROLE_RETURN_KIND}'`);
    if (has('schemaVersion') && value.schemaVersion !== ROLE_RETURN_SCHEMA_VERSION) findings.malformed(`role return schemaVersion must be ${ROLE_RETURN_SCHEMA_VERSION}`);
    if (has('returnId') && (typeof value.returnId !== 'string' || !/^return:[0-9a-f-]{36}$/.test(value.returnId))) findings.malformed('role return returnId is invalid');
    if (has('producerRole') && (value.producerRole !== 'engineer' || !WORKFLOW_ROLE_SET.has(value.producerRole))) findings.malformed('role return producerRole must be immutable engineer');
    if (has('packet') && exactKeys(value.packet, ['packetId', 'digest'], 'role return packet', findings)) {
      if (typeof value.packet.packetId !== 'string' || !value.packet.packetId) findings.malformed('role return packetId is required');
      if (!SEMANTIC_DIGEST_RE.test(value.packet.digest ?? '')) findings.malformed('role return packet digest must be canonical');
    }
    if (has('task') && exactKeys(value.task, [
      'backend', 'id', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest',
    ], 'role return task', findings)) {
      if (!['files', 'github'].includes(value.task.backend)) findings.malformed('role return task backend is invalid');
      if (typeof value.task.id !== 'string' || !value.task.id) findings.malformed('role return task id is required');
      if (!CONTRACT_DIGEST_RE.test(value.task.taskContractDigest ?? '')) findings.malformed('role return task taskContractDigest must be sha256:v1:<64 lowercase hex>');
      for (const key of ['dispatchCarrierDigest', 'currentCarrierDigest']) {
        if (!SHA256_RE.test(value.task[key] ?? '')) findings.malformed(`role return task ${key} must be sha256:<64 lowercase hex>`);
      }
    }
    if (has('worktree') && (typeof value.worktree !== 'string' || !value.worktree)) findings.malformed('role return worktree is required');
    if (has('branch') && (typeof value.branch !== 'string' || !value.branch)) findings.malformed('role return branch is required');
    for (const key of ['productBaseHead', 'productHead', 'workflowHead']) {
      if (has(key) && !isGitObjectId(value[key])) findings.malformed(`role return ${key} must be a full lowercase 40- or 64-character Git identity`);
    }
    if (has('candidateHead') && value.candidateHead !== null && !isGitObjectId(value.candidateHead)) {
      findings.malformed('role return candidateHead must be null or a full lowercase 40- or 64-character Git identity');
    }
    const productChangedPaths = has('productChangedPaths') && Array.isArray(value.productChangedPaths) ? value.productChangedPaths : null;
    const workflowChangedPaths = has('workflowChangedPaths') && Array.isArray(value.workflowChangedPaths) ? value.workflowChangedPaths : null;
    for (const [label, paths] of [['productChangedPaths', productChangedPaths], ['workflowChangedPaths', workflowChangedPaths]]) {
      if (!paths || paths.some(path => typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.includes('..'))) {
        findings.malformed(`role return ${label} must be safe canonical forward-slash paths`);
      } else if (!sameCanonical(paths, [...paths].sort()) || new Set(paths).size !== paths.length) {
        findings.malformed(`role return ${label} must be canonical sorted unique paths`);
      }
    }
    if (productChangedPaths && workflowChangedPaths && productChangedPaths.some(path => workflowChangedPaths.includes(path))) {
      findings.malformed('role return productChangedPaths and workflowChangedPaths must be disjoint');
    }
    if (value.requiredCheckEvidenceContract !== REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION) findings.malformed(`role return requiredCheckEvidenceContract must be ${REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION}`);
    if (has('checks')) validateChecks(
      value.checks,
      findings,
      'role return',
      value.requiredCheckEvidenceContract
    );
    if (has('carrierLineage') && exactKeys(value.carrierLineage, [
      'dispatchConsumptionDigest', 'evidenceMutationReceiptDigests',
    ], 'role return carrierLineage', findings)) {
      if (!SEMANTIC_DIGEST_RE.test(String(value.carrierLineage.dispatchConsumptionDigest ?? '')) ||
          !Array.isArray(value.carrierLineage.evidenceMutationReceiptDigests) ||
          value.carrierLineage.evidenceMutationReceiptDigests.some(digest => !SEMANTIC_DIGEST_RE.test(String(digest)))) {
        findings.malformed('role return carrierLineage is invalid');
      }
    }
    if (has('productAttribution') && exactKeys(value.productAttribution, ['range', 'commits'], 'role return productAttribution', findings)) {
      if (exactKeys(value.productAttribution.range, ['base', 'head'], 'role return productAttribution range', findings) &&
          (value.productAttribution.range.base !== value?.productBaseHead || value.productAttribution.range.head !== value?.productHead)) {
        findings.malformed('role return productAttribution range must match productBaseHead and productHead');
      }
      const commits = Array.isArray(value.productAttribution.commits) ? value.productAttribution.commits : null;
      if (!commits || commits.some(commit => !isGitObjectId(commit))) findings.malformed('role return productAttribution commits must be full Git identities');
      else if (value?.productHead !== value?.productBaseHead && commits.length === 0) findings.malformed('changed role return productHead requires a non-empty commit range');
    }
    // The heads, the attribution range, and every listed commit are identities
    // from one repository, so they cannot mix Git object formats. Only complete
    // identities are compared here: an abbreviation is already reported above,
    // and reporting it twice would blur two distinct faults into one.
    const returnIdentities = [
      value?.productBaseHead, value?.productHead, value?.workflowHead,
      value?.productAttribution?.range?.base, value?.productAttribution?.range?.head,
      ...(Array.isArray(value?.productAttribution?.commits) ? value.productAttribution.commits : []),
    ].filter(identity => identity !== null && identity !== undefined);
    if (returnIdentities.every(isGitObjectId) && !sameGitObjectFormat(returnIdentities)) {
      findings.malformed('role return Git identities must all share one Git object format');
    }
    if (has('pr') && exactKeys(value.pr, ['state', 'number', 'url'], 'role return PR state', findings)) {
      if (!PR_STATES.has(value.pr.state)) findings.malformed('role return PR state is invalid');
      if (['unavailable', 'not_applicable'].includes(value.pr.state) && (value.pr.number !== null || value.pr.url !== null)) {
        findings.malformed('unavailable or not-applicable PR state cannot claim a PR identity');
      }
      if (['open', 'updated'].includes(value.pr.state) && (!Number.isSafeInteger(value.pr.number) || typeof value.pr.url !== 'string' || !value.pr.url)) {
        findings.malformed('open or updated PR state requires number and URL');
      }
    }
    if (has('disposition') && !RETURN_DISPOSITIONS.has(value.disposition)) findings.malformed('role return disposition must use canonical transition vocabulary');
    if (has('outcome') && exactKeys(value.outcome, ['kind', 'completion', 'authority'], 'role return outcome', findings)) {
      if (value.outcome.completion !== false || value.outcome.authority !== 'non_authoritative_role_outcome') {
        findings.malformed('role return outcome must explicitly remain non-authoritative and non-completing');
      }
      if (RETURN_DISPOSITIONS.has(value?.disposition)) {
        const expected = value.disposition === 'proceed' ? 'implementation_ready_for_review' : 'implementation_blocked';
        if (value.outcome.kind !== expected) findings.malformed(`role return outcome kind must be '${expected}' for disposition '${value.disposition}'`);
      }
    }
    if (value?.disposition === 'proceed') {
      if (value?.blocker !== null) findings.malformed('successful role return cannot carry a blocker');
      if ((productChangedPaths ?? []).length === 0) findings.malformed('implementation-ready role return requires productChangedPaths derived from Git');
      if (Array.isArray(value?.checks) && value.checks.some(check => check?.outcome !== 'passed')) {
        findings.negative('implementation-ready role return cannot contain failed, blocked, or not-run checks');
      }
    } else if (value?.disposition === 'blocked' && has('blocker') &&
        exactKeys(value.blocker, ['category', 'evidence', 'resumeOwner', 'resumeTransition', 'resumePreconditions'], 'blocked role return', findings)) {
      if (typeof value.blocker.category !== 'string' || !value.blocker.category.trim()) findings.malformed('blocked role return category is required');
      if (exactKeys(value.blocker.evidence, ['kind', 'detail'], 'blocked role return evidence', findings) &&
          (typeof value.blocker.evidence.kind !== 'string' || !value.blocker.evidence.kind ||
           typeof value.blocker.evidence.detail !== 'string' || !value.blocker.evidence.detail.trim())) {
        findings.malformed('blocked role return requires typed blocker evidence');
      }
      // A cancellation claim is evidence-bound, never inferred: the blocker
      // must name the cancellation-provenance contract and the exact digest of
      // the Agentic Loop-controlled observation, which the producing and
      // receiving CLI boundaries validate against the consumed invocation.
      if (value.blocker.category === CANCELLATION_BLOCKER_CATEGORY) {
        if (value.blocker.evidence?.kind !== CANCELLATION_PROVENANCE_KIND ||
            !/^sha256:agenticloop\.cancellation-provenance\.v1:[a-f0-9]{64}$/.test(String(value.blocker.evidence?.detail ?? ''))) {
          findings.malformed('a cancellation-blocked role return must carry the exact cancellation-provenance evidence kind and observation digest');
        }
      } else if (value.blocker.evidence?.kind === CANCELLATION_PROVENANCE_KIND) {
        findings.malformed('cancellation-provenance blocker evidence requires the canonical cancellation blocker category');
      }
      if (value.blocker.resumeOwner !== value?.producerRole) findings.malformed('blocked role return resumeOwner must remain the producing role without a separate redelegation authority');
      if (typeof value.blocker.resumeTransition !== 'string' || !value.blocker.resumeTransition.trim()) findings.malformed('blocked role return resumeTransition is required');
      if (exactKeys(value.blocker.resumePreconditions, ['items', 'justification'], 'blocked role return resumePreconditions', findings)) {
        const items = value.blocker.resumePreconditions.items;
        if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())) findings.malformed('blocked role return resume preconditions must be non-empty strings');
        else if (items.length === 0 && (typeof value.blocker.resumePreconditions.justification !== 'string' || !value.blocker.resumePreconditions.justification.trim())) {
          findings.malformed('empty blocker resume preconditions require a non-empty justification');
        } else if (items.length > 0 && value.blocker.resumePreconditions.justification !== null) {
          findings.malformed('non-empty blocker resume preconditions require null justification');
        }
      }
    }
    if (has('freshness') && exactKeys(value.freshness, ['invalidatedBy'], 'role return freshness', findings) &&
        !sameCanonical(value.freshness.invalidatedBy, RETURN_INVALIDATORS)) {
      findings.malformed('role return freshness invalidatedBy must equal the closed canonical inventory');
    }
    if (shapeOk) {
      const digest = semanticDigest(`agenticloop.role-return.v${ROLE_RETURN_SCHEMA_VERSION}`, projection(value));
      if (!SEMANTIC_DIGEST_RE.test(value.digest ?? '') || value.digest !== digest) findings.malformed('role return digest is invalid');
    }
  } catch (error) {
    findings.malformed(`role return could not be validated: ${error.message}`);
  }
  return { ok: findings.length === 0, errors: findings.messages, findings: findings.items };
}

/** @param {any} input */
export function createRoleReturn(input = {}) {
  /** @type {any} */
  const value = {
    ...input,
    kind: ROLE_RETURN_KIND,
    schemaVersion: ROLE_RETURN_SCHEMA_VERSION,
    returnId: input.returnId ?? `return:${randomUUID()}`,
    requiredCheckEvidenceContract: input.requiredCheckEvidenceContract ?? REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
    checks: Array.isArray(input.checks)
      ? input.checks.map(check => check && typeof check === 'object' && !Array.isArray(check)
        ? { ...check }
        : check)
      : input.checks,
  };
  value.digest = semanticDigest(`agenticloop.role-return.v${ROLE_RETURN_SCHEMA_VERSION}`, projection(value));
  const checked = validateRoleReturn(value);
  if (!checked.ok) throw new TypeError(`invalid role return: ${checked.errors.join('; ')}`);
  return deepFreeze(value);
}

/**
 * Reconstruct commit attribution directly from durable Git objects.
 *
 * This is a thin wrapper over the one canonical range derivation, which proves
 * contiguous ancestry before listing commits.
 *
 * @param {any} input
 */
export function reconstructCommitAttribution(input = {}) {
  const { runGit, baseHead, head, taskId, roleId } = input;
  if (typeof runGit !== 'function') throw new TypeError('runGit is required to reconstruct attribution');
  const derived = deriveCommitRange({ runGit, baseHead, head, taskId, roleId });
  if (!derived.ok) throw new Error(derived.message);
  return { range: derived.range, commits: derived.commits, changedPaths: derived.changedPaths };
}

function validateRepositoryEvidence(value, findings) {
  const shapeOk = exactKeys(value, [
    'backend', 'task', 'worktree', 'branch', 'productBaseHead', 'productHead', 'workflowHead', 'candidateHead',
    'productChangedPaths', 'workflowChangedPaths', 'productAttribution', 'checks', 'pr', 'carrierLineage',
  ], 'repository evidence', findings);
  if (!shapeOk) return;
  if (!['files', 'github'].includes(value?.backend)) findings.malformed('repository evidence backend is invalid');
  exactKeys(value?.task, ['id', 'taskContractDigest', 'dispatchCarrierDigest', 'currentCarrierDigest'], 'repository evidence task', findings);
  if (typeof value?.task?.id !== 'string' || !value.task.id ||
      !CONTRACT_DIGEST_RE.test(value?.task?.taskContractDigest ?? '') ||
      !SHA256_RE.test(value?.task?.dispatchCarrierDigest ?? '') ||
      !SHA256_RE.test(value?.task?.currentCarrierDigest ?? '')) {
    findings.malformed('repository evidence task identity is invalid');
  }
  if (typeof value?.worktree !== 'string' || !value.worktree || typeof value?.branch !== 'string' || !value.branch) findings.malformed('repository evidence worktree and branch are required');
  for (const key of ['productBaseHead', 'productHead', 'workflowHead']) {
    if (!isGitObjectId(value?.[key])) findings.malformed(`repository evidence ${key} must be full Git identity`);
  }
  if (value?.candidateHead !== null && !isGitObjectId(value?.candidateHead)) findings.malformed('repository evidence candidateHead must be null or a full Git identity');
  for (const key of ['productChangedPaths', 'workflowChangedPaths']) {
    if (!Array.isArray(value?.[key]) || !sameCanonical(value[key], [...value[key]].sort())) {
      findings.malformed(`repository evidence ${key} must be canonical sorted paths`);
    }
  }
  validateChecks(value?.checks, findings, 'repository evidence');
  exactKeys(value?.productAttribution, ['range', 'commits'], 'repository evidence productAttribution', findings);
  exactKeys(value?.productAttribution?.range, ['base', 'head'], 'repository evidence productAttribution range', findings);
  if (value?.productAttribution?.range?.base !== value?.productBaseHead || value?.productAttribution?.range?.head !== value?.productHead) {
    findings.malformed('repository evidence productAttribution range must match product heads');
  }
  if (!Array.isArray(value?.productAttribution?.commits) || value.productAttribution.commits.some(commit => !isGitObjectId(commit))) {
    findings.malformed('repository evidence productAttribution commits are invalid');
  }
  // Repository evidence describes exactly one repository, and one repository has
  // exactly one object format; a mixed 40/64 claim is rejected, never resolved.
  const evidenceIdentities = [
    value?.productBaseHead, value?.productHead, value?.workflowHead,
    value?.productAttribution?.range?.base, value?.productAttribution?.range?.head,
    ...(Array.isArray(value?.productAttribution?.commits) ? value.productAttribution.commits : []),
  ].filter(identity => identity !== null && identity !== undefined);
  if (evidenceIdentities.every(isGitObjectId) && !sameGitObjectFormat(evidenceIdentities)) {
    findings.malformed('repository evidence Git identities must all share one Git object format');
  }
  exactKeys(value?.pr, ['state', 'number', 'url'], 'repository evidence PR state', findings);
  if (!PR_STATES.has(value?.pr?.state)) findings.malformed('repository evidence PR state is invalid');
  if (value?.backend === 'files' && !sameCanonical(value?.pr, { state: 'not_applicable', number: null, url: null })) findings.malformed('files repository evidence must derive PR state as not_applicable');
}

function validateReturnAgainstCurrent({
  wire, packet, snapshot, repositoryEvidence, producerEvidence, runGit,
  carrierLineage = null, returnAssurance = 'host_receipt', historicalCloseout = false,
}, findings) {
  validateRepositoryEvidence(repositoryEvidence, findings);
  const authoritative = authoritativePacketTaskBinding(snapshot);
  if (!authoritative.ok) {
    findings.malformed(`authoritative current task contract cannot be derived: ${authoritative.error}`);
  } else {
    // The dispatch carrier is the only task binding permitted to evolve during
    // the Engineer run. Compare every other packet task field against a fresh
    // authoritative derivation so a re-digested packet cannot expand scope or
    // alter checks while preserving only the contract digest.
    const { dispatchCarrierDigest: _packetCarrier, ...packetContractBinding } = packet?.task ?? {};
    const { dispatchCarrierDigest: _currentCarrier, ...currentContractBinding } = authoritative.binding.task;
    if (packet?.backend !== authoritative.binding.backend || !sameCanonical(packetContractBinding, currentContractBinding)) {
      findings.changed('dispatch packet task contract does not equal the refetched authoritative task contract');
    }
  }
  if (carrierLineage !== null && !carrierLineage?.ok) {
    findings.missing('a continuous recognized task carrier lineage is required before accepting the role return');
  } else if (carrierLineage !== null) {
    if (carrierLineage.taskContractDigest !== packet?.task?.taskContractDigest ||
        carrierLineage.dispatchCarrierDigest !== packet?.task?.dispatchCarrierDigest ||
        carrierLineage.currentCarrierDigest !== snapshot?.digest ||
        carrierLineage.currentCarrierDigest !== wire?.task?.currentCarrierDigest ||
        carrierLineage.dispatchConsumption?.digest !== wire?.carrierLineage?.dispatchConsumptionDigest ||
        !sameCanonical(carrierLineage.receipts?.map(receipt => receipt.digest) ?? [], wire?.carrierLineage?.evidenceMutationReceiptDigests ?? [])) {
      findings.changed('role return carrier lineage does not equal the current recognized mutation chain');
    }
  }
  // With a host receipt the observed producer role is authenticated evidence.
  // A session-reported return has no producer proof at all: the role is only
  // checked for internal consistency with the packet assignment, and nothing
  // downstream may describe it as authenticated.
  if (returnAssurance === 'host_receipt') {
    if (producerEvidence?.producerRole !== wire.producerRole || wire.producerRole !== packet.assignment.roleId) {
      findings.malformed('role return producer does not match trusted producer evidence and dispatch assignment');
    }
  } else if (wire.producerRole !== packet.assignment.roleId) {
    findings.malformed('role return producerRole does not match the dispatch assignment');
  }
  if (wire.packet.packetId !== packet.packetId || wire.packet.digest !== packet.digest) findings.changed('role return did not consume the exact dispatch packet');
  if (wire.task.backend !== packet.backend || wire.task.id !== packet.task.id ||
      wire.task.taskContractDigest !== packet.task.taskContractDigest ||
      wire.task.dispatchCarrierDigest !== packet.task.dispatchCarrierDigest) {
    findings.changed('role return task identity does not equal the persisted dispatch packet');
  }
  if (wire.task.backend !== snapshot.backend || wire.task.id !== snapshot.taskId ||
      wire.task.taskContractDigest !== authoritative.contract?.digest ||
      (!historicalCloseout && wire.task.currentCarrierDigest !== snapshot.digest)) {
    findings.changed('role return task identity does not equal refetched task');
  }
  if (wire.task.backend !== repositoryEvidence?.backend || wire.task.id !== repositoryEvidence?.task?.id ||
      wire.task.taskContractDigest !== repositoryEvidence?.task?.taskContractDigest ||
      wire.task.dispatchCarrierDigest !== repositoryEvidence?.task?.dispatchCarrierDigest ||
      wire.task.currentCarrierDigest !== repositoryEvidence?.task?.currentCarrierDigest) {
    findings.changed('role return task identity does not equal repository evidence');
  }
  if (wire.worktree !== packet.assignment.worktree || wire.worktree !== repositoryEvidence?.worktree) findings.changed('role return worktree does not match dispatched/current worktree');
  if (wire.branch !== packet.assignment.branch || wire.branch !== repositoryEvidence?.branch) findings.changed('role return branch does not match dispatched/current branch');
  if (wire.productBaseHead !== packet.repository.head || wire.productBaseHead !== repositoryEvidence?.productBaseHead) {
    findings.changed('role return productBaseHead does not equal the packet-bound base');
  }
  if (wire.productHead !== repositoryEvidence?.productHead || wire.workflowHead !== repositoryEvidence?.workflowHead) {
    findings.changed('role return productHead or workflowHead does not equal repository evidence');
  }
  for (const key of ['productChangedPaths', 'workflowChangedPaths', 'productAttribution', 'pr', 'carrierLineage']) {
    if (!sameCanonical(wire[key], repositoryEvidence?.[key])) findings.changed(`role return ${key} does not match refetched repository evidence`);
  }
  // Repository evidence carries the baseline observation projection only. The
  // wire return uses the packet-bound current grammar, whose execution-artifact
  // references are validated separately at the CLI boundary that can read them.
  const wireChecks = validateRequiredCheckEvidence(wire.checks, {
    contractVersion: wire.requiredCheckEvidenceContract,
  });
  const repositoryChecks = validateRequiredCheckEvidence(repositoryEvidence?.checks, {
    label: 'repository evidence',
  });
  const stableCheckObservations = checks => Array.isArray(checks)
    ? checks.map(check => {
        if (!check || typeof check !== 'object' || Array.isArray(check)) return check;
        const { executionEvidence: _executionEvidence, ...observation } = check;
        return observation;
      })
    : null;
  if (!wireChecks.ok || !repositoryChecks.ok ||
      !sameCanonical(stableCheckObservations(wireChecks.checks), repositoryChecks.checks)) {
    findings.changed('role return checks do not match refetched repository evidence by stable required-check id');
  }
  // Files-backend returns are verified against durable Git state, never
  // against caller-authored evidence: a Git reader is mandatory, the current
  // head is reread, and contiguous ancestry, the commit list, and the changed
  // paths are all rederived and compared with both the wire and the refetched
  // evidence. A GitHub/injected transport cannot rederive Git state here, so
  // its trust comes from the receipt authenticated at the boundary: the host
  // signed the exact repository-evidence digest at its own transport edge.
  if (packet.backend === 'files') {
    if (typeof runGit !== 'function') {
      findings.missing('a Git reader is required to rederive files-backend return evidence before accepting the role return', { disposition: 'blocked' });
    } else {
      const currentHead = runGit(['rev-parse', '--verify', 'HEAD']);
      const currentHeadId = String(currentHead?.stdout ?? '').trim();
      if (currentHead?.status !== 0 || !isGitObjectId(currentHeadId)) {
        findings.missing('current repository head could not be reread before accepting the role return');
      } else if (!historicalCloseout && currentHeadId !== wire.workflowHead) {
        findings.changed('role return workflowHead is no longer the current repository head');
      } else {
        if (historicalCloseout) {
          const ancestor = runGit(['merge-base', '--is-ancestor', wire.workflowHead, currentHeadId]);
          if (ancestor?.status !== 0) {
            findings.changed('historical role-return head is no longer an ancestor of the current repository head');
            return;
          }
        }
        const derived = deriveCommitRange({
          runGit, baseHead: wire.productBaseHead, head: wire.productHead, taskId: packet.task.id, roleId: packet.assignment.roleId,
        });
        if (!derived.ok) findings.add(derived.evidenceState, derived.message, { disposition: derived.disposition, code: derived.code });
        else {
          const productToWorkflow = runGit(['merge-base', '--is-ancestor', wire.productHead, wire.workflowHead]);
          if (productToWorkflow?.status !== 0) {
            findings.changed('role return productHead is not an ancestor of workflowHead');
          }
          if (!sameCanonical(wire.productAttribution.commits, derived.commits)) findings.changed('role return product attribution commits do not equal the durable Git commit range');
          if ((wire.productChangedPaths ?? []).some(path => !derived.changedPaths.includes(path)) ||
              derived.changedPaths.some(path => !wire.productChangedPaths.includes(path) && !wire.workflowChangedPaths.includes(path))) {
            findings.changed('role return product/workflow changed paths do not cover the durable Git commit range');
          }
        }
      }
    }
  } else if (typeof runGit === 'function') {
    const currentHead = runGit(['rev-parse', '--verify', 'HEAD']);
    const currentHeadId = String(currentHead?.stdout ?? '').trim();
    if (currentHead?.status === 0 && isGitObjectId(currentHeadId) &&
        (currentHeadId === wire.workflowHead || historicalCloseout)) {
      if (historicalCloseout) {
        const ancestor = runGit(['merge-base', '--is-ancestor', wire.workflowHead, currentHeadId]);
        if (ancestor?.status !== 0) {
          findings.changed('historical role-return head is no longer an ancestor of the current repository head');
          return;
        }
      }
      const derived = deriveCommitRange({
          runGit, baseHead: wire.productBaseHead, head: wire.productHead, taskId: packet.task.id, roleId: packet.assignment.roleId,
      });
      if (!derived.ok) findings.add(derived.evidenceState, derived.message, { disposition: derived.disposition, code: derived.code });
      else {
        const productToWorkflow = runGit(['merge-base', '--is-ancestor', wire.productHead, wire.workflowHead]);
        if (productToWorkflow?.status !== 0) findings.changed('role return productHead is not an ancestor of workflowHead');
        if (!sameCanonical(wire.productAttribution.commits, derived.commits)) findings.changed('role return product attribution commits do not equal the durable Git commit range');
      }
    }
  }
  const requiredChecks = authoritative.ok ? authoritative.binding.task.requiredChecks : packet.task.requiredChecks;
  if (!requiredCheckEvidenceMatchesInventory(wire.checks, requiredChecks, {
    contractVersion: packet?.task?.requiredCheckEvidenceContract,
  })) {
    findings.negative('role return checks do not match the authoritative required-check inventory by id, kind, and identity');
  }
  const contract = taskContractDigest(snapshot.body);
  const allowedPaths = new Set([
    ...(contract.projection?.allowed_paths ?? []),
    ...(packet.task?.preAuthorizedDeviationPaths ?? []),
  ]);
  for (const path of wire.productChangedPaths ?? []) {
    if (PERMITTED_SCRATCH_PREFIXES.some(prefix => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) {
      findings.negative(`role return product changed path '${path}' is scratch state and cannot be implementation work`);
      continue;
    }
    if (![...allowedPaths].some(pattern => fileMatchesScopePattern(path, pattern))) findings.negative(`role return product changed path '${path}' is outside packet-bound task scope`);
  }
}

function compareReturnAssuranceGrade(left, right) {
  return RETURN_ASSURANCE_ORDER_INDEX(left) - RETURN_ASSURANCE_ORDER_INDEX(right);
}

function RETURN_ASSURANCE_ORDER_INDEX(grade) {
  return grade === 'host_receipt' ? 1 : grade === 'session_reported' ? 0 : -1;
}

/**
 * One warning per session-reported return, so the degraded producer guarantee
 * is impossible to miss in human output and impossible to drop from the
 * structured validation result.
 */
function sessionReportedWarningDiagnostics(returnAssurance, producerRole) {
  if (returnAssurance !== 'session_reported') return [];
  return [createDiagnostic({
    level: 'warning',
    code: 'return.assurance.session_reported',
    message:
      `Role return for '${String(producerRole)}' is session_reported: schema, packet binding, and refetched ` +
      'repository evidence were all revalidated, but the producing role identity was NOT host-authenticated. ' +
      'Do not describe this result as cryptographically host-authenticated.',
    evidence: {
      state: 'current',
      supplied: true,
      rollbackAuthorized: false,
      returnAssurance,
      producerAuthenticated: false,
    },
  })];
}

/** The closed, honest assurance statement carried by every accepted return. */
function returnAssuranceStatement(packet, returnAssurance, minimumReturn) {
  return Object.freeze({
    kind: 'agenticloop.return-assurance',
    schemaVersion: 1,
    activation: packet?.assurance?.activation ?? null,
    activationSource: packet?.assurance?.activationSource ?? null,
    activationProducer: packet?.assurance?.activationProducer ?? null,
    activationChannel: packet?.assurance?.activationChannel ?? null,
    activationDerivation: packet?.assurance?.activationDerivation ?? null,
    return: returnAssurance,
    producerAuthenticated: returnAssurance === 'host_receipt',
    mode: packet?.assurance?.mode ?? null,
    policySource: packet?.assurance?.policySource ?? null,
    minimumActivation: packet?.assurance?.minimumActivation ?? null,
    minimumReturn,
    limitations: Object.freeze([
      ACTIVATION_ASSURANCE_LIMITATIONS[packet?.assurance?.activation] ?? 'activation assurance is unknown',
      RETURN_ASSURANCE_LIMITATIONS[returnAssurance],
    ]),
  });
}

/**
 * Verify a raw producer return at the handoff boundary. This function consumes
 * refetched task/repository facts and an adapter-produced provenance receipt; it
 * does not accept an Orchestrator reconstruction or persist/import the result.
 *
 * The trusted packet's assigned role stays attached to every failure path,
 * including an unexpected internal fault, so a malformed return always routes
 * back to its producer.
 *
 * @param {any} input
 * @param {{ capabilities?: Record<string, any> }} [options]
 */
export function receiveRoleReturn(input = {}, options = {}) {
  const command = 'role return receive';
  const producerRole = input?.packet?.assignment?.roleId;
  const producerDomain = WORKFLOW_ROLE_SET.has(producerRole) ? { producerRole } : {};
  try {
    const {
      raw,
      packet,
      refetchTask,
       refetchRepositoryEvidence,
       refetchCarrierLineage = null,
      producerReceipt,
      resolveTrustedAdapter,
      requestedOwner,
      redelegationAuthority = null,
      recovery = null,
      humanDisposition = null,
       exceptionalVerification = null,
       exceptionalReceipt = null,
      resolveTrustedAuthority,
      workflowRoleRegistry,
      now = Date.now(),
      runGit = null,
      historicalCloseout = false,
    } = input;
    let wire;
    try {
      wire = typeof raw === 'string' ? JSON.parse(raw) : null;
    } catch {
      return singleFailure(command, 'malformed', 'rejected', 'role return wire is not valid JSON', producerDomain);
    }
    if (wire === null || wire === undefined) {
      return singleFailure(command, 'malformed', 'rejected', 'role return must arrive as raw JSON wire text', producerDomain);
    }
    const wireValidation = validateRoleReturn(wire);
    if (!wireValidation.ok) {
      const findings = findingSet(command);
      findings.extend(wireValidation.findings);
      return failure(command, findings, producerDomain);
    }
    const packetValidation = validateDispatchPreparation(packet, options);
    if (!packetValidation.ok) {
      const findings = findingSet(command);
      findings.extend(packetValidation.findings);
      return failure(command, findings, producerDomain);
    }
    if (wire.requiredCheckEvidenceContract !== packet.task.requiredCheckEvidenceContract) {
      return singleFailure(
        command,
        'malformed',
        'rejected',
        'role return required-check evidence contract does not match the authenticated dispatch packet',
        producerDomain,
        'role_return.invalid'
      );
    }
    // Exception requests and blocked-result recovery are separate authority
    // edges. Reject every contradictory combination before either edge can
    // return an early result.
    if (exceptionalVerification !== null && (
      requestedOwner !== undefined || redelegationAuthority !== null ||
      recovery !== null || humanDisposition !== null
    )) {
      return singleFailure(
        command, 'malformed', 'rejected',
        'exceptional verification cannot be combined with recovery, redelegation, human disposition, or a requested owner',
        producerDomain, 'role_return.invalid'
      );
    }
    if (exceptionalVerification === null && exceptionalReceipt !== null) {
      return singleFailure(
        command, 'malformed', 'rejected',
        'an exceptional-verification producer receipt requires one exceptional-verification request',
        producerDomain, 'role_return.invalid'
      );
    }
    // Return assurance is decided here, before any evidence is consumed, from
    // the effective minimum and what the caller actually supplied. It is never
    // inferred later from how far verification happened to get.
    const packetMinimum = RETURN_ASSURANCE_VALUES.has(packet?.assurance?.minimumReturn)
      ? packet.assurance.minimumReturn
      : 'host_receipt';
    const callerMinimum = RETURN_ASSURANCE_VALUES.has(options.minimumReturnAssurance)
      ? options.minimumReturnAssurance
      : null;
    // Fail closed: the stronger of the packet-bound and caller-supplied minimum.
    const minimumReturn = callerMinimum === null
      ? packetMinimum
      : (compareReturnAssuranceGrade(callerMinimum, packetMinimum) >= 0 ? callerMinimum : packetMinimum);
    const hasProducerReceipt = Boolean(producerReceipt) && typeof producerReceipt === 'object' && !Array.isArray(producerReceipt);
    const returnAssurance = hasProducerReceipt ? 'host_receipt' : 'session_reported';
    for (const [value, label] of [
      [refetchTask, 'current task refetch function is required'],
      [refetchRepositoryEvidence, 'trusted repository-evidence refetch function is required'],
    ]) {
      if (typeof value !== 'function') return singleFailure(command, 'missing', 'blocked', label, producerDomain);
    }
    if (returnAssurance === 'host_receipt' && typeof resolveTrustedAdapter !== 'function') {
      return singleFailure(command, 'missing', 'blocked', 'pinned host-adapter trust resolver is required', producerDomain);
    }
    if (!hasProducerReceipt && minimumReturn === 'host_receipt') {
      return singleFailure(
        command, 'missing', 'blocked',
        'raw host-adapter producer receipt is required: the effective policy requires host_receipt return assurance',
        producerDomain, 'return.assurance.insufficient'
      );
    }
    if (!hasProducerReceipt && exceptionalVerification !== null) {
      return singleFailure(
        command, 'missing', 'blocked',
        'exceptional verification requires an authenticated host producer receipt',
        producerDomain, 'return.assurance.insufficient'
      );
    }
    let snapshot;
    try {
      snapshot = refetchTask();
    } catch (error) {
      return singleFailure(command, 'missing', 'blocked', `current task refetch failed: ${error.message}`, producerDomain);
    }
    let repositoryEvidence;
    try {
      repositoryEvidence = refetchRepositoryEvidence({ packet, wire, snapshot });
    } catch (error) {
      // Only recognized typed public errors keep their own classification; an
      // arbitrary thrown object cannot assert its own evidence state here.
      const fault = classifyBoundaryFault(error, 'missing', 'blocked');
      return singleFailure(
        command, fault.evidenceState, fault.disposition,
        `repository evidence refetch failed: ${error.message}`, producerDomain, fault.code
      );
    }
    let carrierLineage = null;
    if (typeof refetchCarrierLineage === 'function') {
      try {
        carrierLineage = refetchCarrierLineage({ packet, wire, snapshot });
      } catch (error) {
        return singleFailure(command, 'missing', 'blocked', `carrier lineage refetch failed: ${error.message}`, producerDomain);
      }
    }
    // Authentication happens here, at the authoritative boundary. No caller
    // callback can assert that a receipt was verified elsewhere: the raw
    // receipt is consumed and verified against the pinned adapter selected by
    // the packet, binding adapter/key, target repository, invocation, packet,
    // return, liveness, and repository-evidence digests in one step. The
    // public CLI resolves the pinned adapter from the fail-closed operator
    // trust store; fixture seams inject an explicitly trusted resolver and are
    // never production-reachable.
    let trustedAdapter = null;
    let producerEvidence = null;
    if (returnAssurance === 'host_receipt') {
      try {
        if (!isObject(packet?.returnAdapter)) {
          return singleFailure(command, 'negative', 'rejected', 'a producer receipt requires the exact packet-bound return adapter', producerDomain, 'role_return.invalid');
        }
        trustedAdapter = resolveTrustedAdapter(packet.returnAdapter.adapterId);
        if (trustedAdapter?.adapterId !== packet.returnAdapter.adapterId ||
            trustedAdapter?.keyId !== packet.returnAdapter.keyId ||
            trustedAdapter?.capabilities?.returnReceipt !== 'supported') {
          return singleFailure(command, 'negative', 'rejected', 'host producer authentication failed: producer receipt adapter does not match the packet-bound adapter, key, and returnReceipt capability', producerDomain, 'role_return.invalid');
        }
      } catch (error) {
        // A typed unsupported-boundary fault is a capability limitation, not a
        // forgery: the registry is well-formed and nothing failed authentication,
        // so it stays `negative/blocked` instead of being reported as a rejected
        // authentication attempt. Every other resolver fault - unpinned adapter,
        // unknown key, malformed store - remains `negative/rejected`.
        const fault = classifyBoundaryFault(error, 'negative', 'rejected', [UNSUPPORTED_BOUNDARY_CODE]);
        const message = fault.code === UNSUPPORTED_BOUNDARY_CODE
          ? `host producer authentication boundary is unsupported: ${error.message}`
          : `host producer authentication failed: ${error.message}`;
        return singleFailure(command, fault.evidenceState, fault.disposition, message, producerDomain, fault.code);
      }
      try {
        producerEvidence = verifyHostHandoffReceipt(producerReceipt, {
          trustedAdapter,
          packet,
          roleReturn: wire,
          repositoryEvidence,
          now,
        });
      } catch (error) {
        const producerMismatch = error instanceof HostProducerMismatchError;
        const staleReceipt = error instanceof HostReceiptStaleVersionError;
        return singleFailure(
          command,
          staleReceipt ? 'stale' : 'negative',
          staleReceipt ? 'superseded' : 'rejected',
          producerMismatch || staleReceipt
            ? error.message
            : `host producer authentication failed: ${error.message}`,
          producerDomain,
          producerMismatch || staleReceipt ? error.code : 'role_return.invalid'
        );
      }
    }
    const findings = findingSet(command);
    validateCurrentTask(snapshot, findings);
    validateReturnAgainstCurrent({
      wire, packet, snapshot, repositoryEvidence, producerEvidence, carrierLineage, runGit,
      returnAssurance, historicalCloseout,
    }, findings);
    const degradedReports = packet.assignment.degradedEnforcementReports;
    const implementation = packet.assignment.hostRoleCapability.actionBindings
      .find(binding => binding.action === 'implementation_mutate');
    if ((wire.productChangedPaths?.length ?? 0) > 0 && implementation?.policy !== 'allowed') {
      findings.negative(
        `${returnAssurance === 'host_receipt' ? 'authenticated' : 'session-reported'} role '${wire.producerRole}' ` +
        `returned implementation changes while implementation_mutate is ${implementation?.policy ?? 'unbound'}`,
        { code: 'capability.action.denied', disposition: 'rejected' }
      );
    }
    if (findings.length) return failure(command, findings, { producerRole: wire.producerRole });
    if (exceptionalVerification !== null) {
      // Required-check exceptions change no task or implementation authority.
      // The task-workflow capability derives the only eligible disposition
      // owner; an arbitrary claimed role cannot select itself here.
      //
      // The inventory comes from trusted options - the effective host-role
      // capability inventory the CLI builds from the selected host, effective
      // target configuration, effective workflow-role registry, and canonical
      // role policies - never from the untrusted role-return input. It is
      // revalidated against the effective registry before an owner is derived,
      // so neither a caller-supplied nor a tampered inventory can select one.
      const host = packet.assignment.hostRoleCapability.host;
      const registry = workflowRoleRegistry ?? WORKFLOW_ROLE_REGISTRY;
      const inventory = (options.hostRoleCapabilities ?? HOST_ROLE_CAPABILITIES)?.[host];
      const inventoryCheck = inventory
        ? validateHostRoleCapabilityInventory({ [host]: inventory }, { registry, hosts: [host] })
        : { ok: false, errors: [`no capability declarations for host '${String(host)}'`] };
      if (!inventoryCheck.ok) {
        return singleFailure(
          command, 'malformed', 'blocked',
          `exceptional verification requires a trusted effective host-role capability inventory: ${inventoryCheck.errors[0]}`,
          { producerRole: wire.producerRole }, 'capability.action.denied'
        );
      }
      const owners = Object.entries(inventory)
        .filter(([, declaration]) => declaration?.actionBindings?.some(binding =>
          binding.action === 'task_workflow_mutate' && binding.policy === 'allowed'
        ))
        .map(([roleId]) => roleId);
      if (owners.length !== 1) {
        return singleFailure(
          command, 'malformed', 'blocked',
          'exceptional verification cannot resolve exactly one task-workflow disposition owner from the selected capability inventory',
          { producerRole: wire.producerRole }, 'capability.action.denied'
        );
      }
      const [allowedDispositionOwner] = owners;
      if (!exceptionalReceipt || typeof exceptionalReceipt !== 'object' || Array.isArray(exceptionalReceipt)) {
        return singleFailure(command, 'missing', 'needs_context', 'host exceptional-verification producer receipt is required', { producerRole: wire.producerRole }, 'role_return.invalid');
      }
      try {
        verifyHostExceptionalVerificationReceipt(exceptionalReceipt, {
          trustedAdapter, packet, exceptionalVerification, repositoryEvidence, now,
        });
      } catch (error) {
        return singleFailure(command, 'negative', 'rejected', `host exceptional-verification authentication failed: ${error.message}`, { producerRole: wire.producerRole }, 'role_return.invalid');
      }
      const exceptional = receiveExceptionalVerification({
        request: exceptionalVerification,
        packet,
        authenticatedProducerRole: wire.producerRole,
        allowedDispositionOwner,
        workflowRoleRegistry: registry,
      });
      if (!exceptional.ok) {
        return { ok: false, packet: null, validation: exceptional.validation, exceptional };
      }
      return {
        ok: true,
        roleReturn: deepFreeze(wire),
        exceptional,
        returnAssurance,
        producerAuthenticated: true,
        assurance: returnAssuranceStatement(packet, returnAssurance, minimumReturn),
        blockedAuthority: null,
        validation: exceptional.validation,
      };
    }
    let blockedAuthority = null;
    if (wire.disposition === 'blocked') {
      if (recovery !== null) {
        if (requestedOwner !== undefined || redelegationAuthority !== null) {
          return singleFailure(
            command,
            'malformed',
            'rejected',
            'blocked recovery cannot simultaneously request workflow-role redelegation',
            { producerRole: wire.producerRole },
            'human_disposition.invalid'
          );
        }
        blockedAuthority = authorizeBlockedResultRecovery({
          blockedReturn: wire,
          recovery,
          humanDisposition,
          resolveTrustedAuthority,
          now,
          registry: workflowRoleRegistry,
        });
      } else {
        if (humanDisposition !== null) {
          return singleFailure(
            command,
            'malformed',
            'rejected',
            'human disposition requires an exact blocked recovery request',
            { producerRole: wire.producerRole },
            'human_disposition.invalid'
          );
        }
        if (redelegationAuthority !== null &&
            (requestedOwner === undefined || requestedOwner === wire.producerRole)) {
          return singleFailure(
            command,
            'malformed',
            'rejected',
            'redelegation authority requires an explicit owner change from the authenticated producer role',
            { producerRole: wire.producerRole },
            'blocked_result.owner_mismatch'
          );
        }
        blockedAuthority = authorizeBlockedResultResume({
          blockedReturn: wire,
          requestedOwner: requestedOwner ?? wire.producerRole,
          redelegationAuthority,
          resolveTrustedAuthority,
          now,
          registry: workflowRoleRegistry,
        });
      }
      const authorityValidation = blockedAuthority.validation;
      if (!blockedAuthority.ok) {
        const authorityFindings = findingSet(command);
        for (const diagnostic of authorityValidation.diagnostics ?? []) {
          authorityFindings.add(
            diagnostic.evidence?.state ?? authorityValidation.evidenceState,
            diagnostic.message,
            { code: diagnostic.code, disposition: authorityValidation.disposition }
          );
        }
        return failure(command, authorityFindings, { producerRole: wire.producerRole });
      }
    } else if (
      requestedOwner !== undefined ||
      redelegationAuthority !== null ||
      recovery !== null ||
      humanDisposition !== null
    ) {
      return singleFailure(
        command,
        'malformed',
        'rejected',
        'blocked-result authority inputs cannot be applied to a non-blocked role return',
        { producerRole: wire.producerRole },
        'role_return.invalid'
      );
    }
    const warningDiagnostics = [
      ...degradedWarningDiagnostics(degradedReports, packet.assignment.hostRoleCapability),
      ...sessionReportedWarningDiagnostics(returnAssurance, wire.producerRole),
    ];
    const assurance = returnAssuranceStatement(packet, returnAssurance, minimumReturn);
    return {
      ok: true,
      roleReturn: deepFreeze(wire),
      returnAssurance,
      producerAuthenticated: returnAssurance === 'host_receipt',
      assurance,
      blockedAuthority: blockedAuthority ? blockedAuthority.value : null,
      validation: validation(command, true, 'current', 'proceed', null, {
        producerRole: wire.producerRole,
        blockedAuthority: blockedAuthority ? structuredClone(blockedAuthority.value) : null,
        degradedEnforcementReports: degradedReports,
        warningDiagnostics,
        assurance,
      }),
    };
  } catch (error) {
    return singleFailure(command, 'malformed', 'rejected', `role return could not be evaluated: ${error.message}`, producerDomain);
  }
}
