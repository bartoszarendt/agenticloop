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
import { deriveCommitRange } from './commit-range.js';
import { gitTreeObjectId, isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import { deepFreeze, frozenClone } from './immutable.js';
import { createDiagnostic } from './repair-policy.js';
import {
  authorizeBlockedResultRecovery,
  authorizeBlockedResultResume,
} from './blocked-result-authority.js';
import {
  createValidationResult,
  validateValidationResult,
  validationResultDigest,
} from './result-envelope.js';
import { fileMatchesScopePattern, parseDeviations } from './scope-matcher.js';
import {
  HostReceiptStaleVersionError,
  HostProducerMismatchError,
  signActivationCapture,
  verifyActivationCaptureSignature,
  verifyHostHandoffReceipt,
} from './host-handoff.js';
import { HOST_SIGNATURE_ALGORITHM, targetRepositoryIdentity } from './host-trust.js';
import {
  CLEAN_DISPATCH_STATE_IDENTITY,
  PERMITTED_SCRATCH_PREFIXES,
  evaluateDispatchCleanState,
  evaluatePriorGateReceipts,
} from './repository-state.js';
import { PublicCommandError } from './public-error.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import { validateTaskReadinessEvidence } from './task-evidence-contract.js';
import { taskContractDigest, validateTaskContractBaseline } from './task-contract-baseline.js';
import {
  parseRequiredCheckInventory,
  requiredCheckEvidenceMatchesInventory,
  validateRequiredCheckEvidence,
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

export const ACTIVATION_CAPTURE_KIND = 'agenticloop.activation-capture';
export const ACTIVATION_CAPTURE_SCHEMA_VERSION = 2;
export const DISPATCH_PREPARATION_KIND = 'agenticloop.role-preparation';
export const BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION = 2;
export const LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION = 3;
export const DISPATCH_PREPARATION_SCHEMA_VERSION = 4;
export const ROLE_RETURN_KIND = 'agenticloop.role-return';
export const ROLE_RETURN_SCHEMA_VERSION = 2;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;
const CLEAN_STATE_IDENTITY_RE = /^sha256:agenticloop\.dispatch-clean-state\.v1:[a-f0-9]{64}$/;
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

const EVIDENCE_RANK = Object.freeze({
  missing: 0, malformed: 1, negative: 2, changed: 3, stale: 4, current: 5,
});
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
    const item = {
      code: options.code ?? this.defaultCode,
      evidenceState,
      disposition: options.disposition ?? DEFAULT_DISPOSITION[evidenceState] ?? 'blocked',
      message: String(message),
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
      const left = EVIDENCE_RANK[item.evidenceState] ?? EVIDENCE_RANK.negative;
      const right = EVIDENCE_RANK[best.evidenceState] ?? EVIDENCE_RANK.negative;
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

function isoTimestamp(value, { futureAllowed = false, now = Date.now() } = {}) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && (futureAllowed || instant <= now + ACTIVATION_CLOCK_SKEW_MS);
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

function degradedWarningDiagnostics(reports) {
  return (reports ?? []).map(report => createDiagnostic({
    level: 'warning',
    code: report.diagnosticCode,
    message: `${report.host}/${report.roleId} action '${report.action}' is ${report.enforcement}; ${report.detectionBoundary} must evaluate compatible authenticated actor/evidence. Recovery: ${report.recoveryRoute}`,
    evidence: {
      state: 'current',
      supplied: true,
      rollbackAuthorized: false,
      host: report.host,
      roleId: report.roleId,
      action: report.action,
      enforcement: report.enforcement,
      declarationDigest: report.declarationDigest,
      detectionBoundary: report.detectionBoundary,
      recoveryRoute: report.recoveryRoute,
    },
  }));
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
function singleFailure(command, evidenceState, disposition, message, domain = {}, code = null) {
  const findings = findingSet(command, evidenceState);
  findings.add(evidenceState, message, { disposition, code: code ?? undefined });
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

/** Build one closed decomposition record for a durable provider source. */
export function createDecompositionProvenance(input = {}) {
  const value = {
    ...input,
    kind: 'agenticloop.decomposition-provenance',
    schemaVersion: 1,
  };
  value.sourceDigest = decompositionSourceDigest(value);
  const findings = findingSet('task prepare-dispatch');
  validateDecomposition(value, value.taskId, findings);
  if (findings.length) throw new TypeError(`invalid decomposition provenance: ${findings.messages.join('; ')}`);
  return deepFreeze(value);
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
 * `missing`/`needs_context`; a digest disagreement is `changed`/`rejected`.
 */
export function activationCaptureDisposition(capture, options = {}) {
  const checked = validateActivationCapture(capture, options);
  if (!checked.ok) {
    const primary = checked.findings.reduce((best, item) => {
      if (!best) return item;
      return (EVIDENCE_RANK[item.evidenceState] ?? 2) < (EVIDENCE_RANK[best.evidenceState] ?? 2) ? item : best;
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

function validateDecomposition(value, taskId, findings) {
  const shapeOk = exactKeys(value, [
    'kind', 'schemaVersion', 'taskId', 'authority', 'source', 'inventory',
    'completeness', 'observedAt', 'freshnessPolicy', 'sourceRef', 'sourceDigest',
  ], 'decomposition provenance', findings);
  if (value?.kind !== 'agenticloop.decomposition-provenance') findings.malformed("decomposition provenance kind must be 'agenticloop.decomposition-provenance'");
  if (value?.schemaVersion !== 1) findings.malformed('decomposition provenance schemaVersion must be 1');
  if (value?.taskId !== taskId) findings.malformed('decomposition provenance taskId must match the dispatched task');
  if (value?.authority !== 'maintainer' || value?.source !== 'task-decomposition') findings.malformed('decomposition provenance must name the canonical maintainer task-decomposition authority');
  if (!safeRepositoryPath(value?.sourceRef)) findings.malformed('decomposition provenance sourceRef must be a safe repository-relative path');
  if (shapeOk && value?.sourceDigest !== decompositionSourceDigest(value)) {
    findings.malformed('decomposition provenance sourceDigest does not match its exact source projection');
  }
  const inventoryOk = exactKeys(value?.inventory, ['id', 'digest', 'readyTaskIds'], 'decomposition inventory', findings);
  if (typeof value?.inventory?.id !== 'string' || !value.inventory.id) findings.malformed('decomposition inventory id is required');
  const readyTaskIds = Array.isArray(value?.inventory?.readyTaskIds) ? value.inventory.readyTaskIds : null;
  if (!readyTaskIds || readyTaskIds.some(id => typeof id !== 'string' || !id) ||
      new Set(readyTaskIds).size !== readyTaskIds.length) {
    findings.malformed('decomposition inventory readyTaskIds must be a unique string array');
  } else if (inventoryOk && value.inventory.digest !== decompositionInventoryDigest(value?.taskId, readyTaskIds)) {
    findings.malformed('decomposition inventory digest does not match its exact task inventory');
  }
  if (!['complete', 'incomplete'].includes(value?.completeness)) findings.malformed('decomposition completeness is invalid');
  else if (value.completeness !== 'complete') findings.negative('decomposition is incomplete and cannot authorize dispatch');
  if (readyTaskIds && !readyTaskIds.includes(taskId)) findings.negative('complete decomposition inventory does not authorize this task as ready');
  if (!isoTimestamp(value?.observedAt)) findings.malformed('decomposition observedAt must be a current ISO-8601 UTC instant');
  exactKeys(value?.freshnessPolicy, ['maxAgeSeconds'], 'decomposition freshnessPolicy', findings);
  if (!Number.isSafeInteger(value?.freshnessPolicy?.maxAgeSeconds) || value.freshnessPolicy.maxAgeSeconds <= 0) {
    findings.malformed('decomposition freshnessPolicy maxAgeSeconds must be a positive integer');
  } else if (isoTimestamp(value?.observedAt) && Date.now() - Date.parse(value.observedAt) > value.freshnessPolicy.maxAgeSeconds * 1000) {
    findings.stale('decomposition provenance is stale');
  }
}

function validateCleanStateBinding(value, findings, label = 'dispatch clean-state binding') {
  const shapeOk = exactKeys(value, ['identity', 'permittedScratchPrefixes', 'ignoredFilesPermitted', 'priorGates'], label, findings);
  if (!CLEAN_STATE_IDENTITY_RE.test(value?.identity ?? '')) {
    findings.malformed(`${label} identity must be a canonical clean-state digest`);
  } else if (value.identity !== CLEAN_DISPATCH_STATE_IDENTITY) {
    findings.negative(`${label} does not describe a clean checkout`, { code: 'worktree.clean_gate.failed' });
  }
  if (!sameCanonical(value?.permittedScratchPrefixes, [...PERMITTED_SCRATCH_PREFIXES])) {
    findings.malformed(`${label} permittedScratchPrefixes must equal the canonical permitted inventory`);
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
    ignoredFilesPermitted: true,
    priorGates: gates.gates,
  };
}

function dispatchBindings(input, findings) {
  const {
    snapshot,
    activation,
    readiness,
    decomposition,
    assignment,
    repository,
    capabilities,
    hostRoleCapabilities,
  } = input;
  const capture = activationCaptureDisposition(activation, {
    capabilities,
    intendedTaskId: snapshot?.taskId,
    repositoryIdentity: targetRepositoryIdentity(repository?.worktree),
  });
  if (!capture.ok) {
    findings.extend(capture.findings);
    return { contract: null };
  }
  const contract = validateCurrentTask(snapshot, findings);
  if (contract?.ok) {
    const strictChecks = parseRequiredCheckInventory(contract.projection.required_checks);
    for (const error of strictChecks.errors) findings.malformed(`task contract required checks are invalid for dispatch: ${error}`);
  }
  validateReadiness(readiness, snapshot, findings);
  validateRepositoryBinding(repository, findings);
  if (activation?.repositoryIdentity !== targetRepositoryIdentity(repository?.worktree)) {
    findings.changed('activation capture target repository does not match dispatch repository');
  }
  validateDecomposition(decomposition, snapshot?.taskId, findings);
  validateAssignment(assignment, {
    backend: snapshot?.backend,
    taskId: snapshot?.taskId,
    repository,
    hostRoleCapabilities,
  }, findings);
  if (contract?.projection?.activation_input_digest !== activation?.normalizedActivationDigest) {
    findings.changed('task contract activation_input_digest does not match verified activation digest');
  }
  // The authored task must reference the exact signed capture artifact, so a
  // frontmatter digest alone cannot stand in for parser-owned authoring.
  if (contract?.ok && !safeRepositoryPath(contract.projection?.activation_capture_ref)) {
    findings.missing('task contract lacks a validated activation_capture_ref authoring provenance reference');
  }
  const baseIdentity = gitTreeObjectId(readiness?.evidence?.base?.identity);
  if (!baseIdentity) findings.malformed('dispatch readiness base identity must be a full git-tree identity');
  else if (repository?.baseTree !== baseIdentity) findings.changed('dispatch repository baseTree must equal readiness base Git-tree identity');
  return { contract };
}

function packetTaskBinding(snapshot, contract) {
  const projection = contract.projection;
  const requiredChecks = parseRequiredCheckInventory(projection.required_checks);
  return {
    id: snapshot.taskId,
    carrier: snapshot.carrier,
    digest: snapshot.digest,
    contractDigest: contract.digest,
    activationDigest: projection.activation_input_digest,
    activationCaptureRef: projection.activation_capture_ref,
    scope: projection.scope,
    outOfScope: projection.out_of_scope,
    allowedPaths: projection.allowed_paths,
    intendedCreations: projection.intended_creations,
    acceptanceCriteria: projection.acceptance_criteria,
    requiredChecks: requiredChecks.ok ? requiredChecks.checks : [],
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

function packetFromBindings({ snapshot, activation, readiness, decomposition, assignment, repository, contract }) {
  /** @type {any} */
  const packet = {
    kind: DISPATCH_PREPARATION_KIND,
    schemaVersion: DISPATCH_PREPARATION_SCHEMA_VERSION,
    packetId: `dispatch:${randomUUID()}`,
    backend: snapshot.backend,
    task: packetTaskBinding(snapshot, contract),
    activation: structuredClone(activation),
    readiness: structuredClone(readiness),
    decomposition: structuredClone(decomposition),
    assignment: structuredClone(assignment),
    repository: structuredClone(repository),
    freshness: { invalidatedBy: [...RETURN_INVALIDATORS] },
  };
  packet.digest = dispatchPreparationDigest(packet);
  return packet;
}

/** Public canonical digest helper for persisted packet readers and fixtures. */
export function dispatchPreparationDigest(packet) {
  return semanticDigest('agenticloop.role-preparation.v4', projection(packet));
}

export function legacyDispatchPreparationDigest(packet, schemaVersion = packet?.schemaVersion) {
  if (![BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION, LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION]
    .includes(schemaVersion)) {
    return null;
  }
  return semanticDigest(`agenticloop.role-preparation.v${schemaVersion}`, projection(packet));
}

/**
 * Refetch, validate, and bind one single-role implementation dispatch.
 *
 * @param {any} input
 * @param {{ capabilities?: Record<string, any> }} [options]
 */
export function prepareRoleDispatch(input = {}, options = {}) {
  const command = 'task prepare-dispatch';
  try {
    const {
      refetchTask,
      refetchReadiness,
      refetchRepository,
      refetchDecomposition,
      refetchActivation = null,
      runGit,
      priorGateReceipts = [],
      readCarrierDigest = null,
      assignment,
    } = input;
    const resolved = resolveInventory(options);
    if (!resolved.ok) return singleFailure(command, 'malformed', 'rejected', 'activation capability inventory must be an object');
    for (const [name, label] of [
      ['refetchTask', 'a current task refetch function is required'],
      ['refetchReadiness', 'an authoritative readiness refetch function is required'],
      ['refetchRepository', 'a current repository refetch function is required'],
      ['refetchDecomposition', 'an authoritative decomposition refetch function is required'],
    ]) {
      if (typeof input[name] !== 'function') return singleFailure(command, 'missing', 'needs_context', label);
    }
    let activation = input.activation;
    let snapshot;
    let readiness;
    let repository;
    let decomposition;
    try {
      snapshot = refetchTask();
      // When a provider is supplied the capture is read from the task's own
      // durable authoring reference, so a caller cannot substitute one.
      if (typeof refetchActivation === 'function') activation = refetchActivation({ snapshot });
      readiness = refetchReadiness({ snapshot });
      repository = refetchRepository({ snapshot, readiness });
      decomposition = refetchDecomposition({ snapshot, readiness, repository });
    } catch (error) {
      const state = typeof error?.evidenceState === 'string' ? error.evidenceState : 'missing';
      const disposition = typeof error?.disposition === 'string' ? error.disposition : 'blocked';
      return singleFailure(command, state, disposition, `authoritative refetch failed: ${error.message}`);
    }
    const findings = findingSet(command);
    let boundAssignment = assignment;
    try {
      boundAssignment = {
        ...assignment,
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
    const bound = { ...repository, cleanState };
    const checked = dispatchBindings({
      snapshot,
      activation,
      readiness,
      decomposition,
      assignment: boundAssignment,
      repository: bound,
      capabilities: options.capabilities,
      hostRoleCapabilities: options.hostRoleCapabilities,
    }, findings);
    if (findings.length) return failure(command, findings);
    const packet = packetFromBindings({
      snapshot, activation, readiness, decomposition, assignment: boundAssignment,
      repository: bound, contract: checked.contract,
    });
    const packetValidation = validateDispatchPreparation(packet, options);
    if (!packetValidation.ok) {
      const emitted = findingSet(command);
      emitted.extend(packetValidation.findings);
      return failure(command, emitted);
    }
    return {
      ok: true,
      packet: frozenClone(packet),
      validation: validation(command, true, 'current', 'proceed', null, {
        warningDiagnostics: degradedWarningDiagnostics(boundAssignment.degradedEnforcementReports),
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

function legacyDispatchCandidate(packet, schemaVersion) {
  const assignmentFields = schemaVersion === BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION
    ? V2_ASSIGNMENT_FIELDS
    : V3_ASSIGNMENT_FIELDS;
  return packet?.kind === DISPATCH_PREPARATION_KIND &&
    packet?.schemaVersion === schemaVersion &&
    closedKeys(packet, DISPATCH_FIELDS) &&
    closedKeys(packet.assignment, assignmentFields) &&
    typeof packet.packetId === 'string' &&
    /^dispatch:[0-9a-f-]{36}$/.test(packet.packetId) &&
    packet.digest === legacyDispatchPreparationDigest(packet, schemaVersion);
}

function currentProjectionOfLegacy(packet, schemaVersion, options) {
  const projected = structuredClone(packet);
  projected.schemaVersion = DISPATCH_PREPARATION_SCHEMA_VERSION;
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

function validateCurrentDispatchPreparation(packet, options = {}) {
  const findings = findingSet('task prepare-dispatch');
  try {
    const shapeOk = exactKeys(packet, DISPATCH_FIELDS, 'dispatch preparation', findings);
    if (packet?.kind !== DISPATCH_PREPARATION_KIND) findings.malformed(`dispatch preparation kind must be '${DISPATCH_PREPARATION_KIND}'`);
    if (packet?.schemaVersion !== DISPATCH_PREPARATION_SCHEMA_VERSION) findings.malformed(`dispatch preparation schemaVersion must be ${DISPATCH_PREPARATION_SCHEMA_VERSION}`);
    if (typeof packet?.packetId !== 'string' || !/^dispatch:[0-9a-f-]{36}$/.test(packet.packetId)) findings.malformed('dispatch preparation packetId is invalid');
    if (!['files', 'github'].includes(packet?.backend)) findings.malformed('dispatch preparation backend is invalid');
    exactKeys(packet?.task, [
      'id', 'carrier', 'digest', 'contractDigest', 'activationDigest', 'activationCaptureRef',
      'scope', 'outOfScope', 'allowedPaths', 'intendedCreations',
      'acceptanceCriteria', 'requiredChecks', 'independentReviewRequired', 'lockedDecisionRefs',
    ], 'dispatch preparation task', findings);
    for (const key of ['id', 'carrier', 'scope']) {
      if (typeof packet?.task?.[key] !== 'string' || !packet.task[key]) findings.malformed(`dispatch preparation task ${key} is required`);
    }
    for (const key of ['outOfScope', 'acceptanceCriteria', 'independentReviewRequired']) {
      if (typeof packet?.task?.[key] !== 'string') findings.malformed(`dispatch preparation task ${key} must be a string`);
    }
    for (const key of ['allowedPaths', 'intendedCreations', 'lockedDecisionRefs']) {
      if (!Array.isArray(packet?.task?.[key]) || packet.task[key].some(path => typeof path !== 'string')) {
        findings.malformed(`dispatch preparation task ${key} must be a string array`);
      }
    }
    const inventory = validateRequiredCheckInventory(packet?.task?.requiredChecks, {
      label: 'dispatch preparation task requiredChecks',
    });
    for (const error of inventory.errors) findings.malformed(error);
    for (const key of ['digest', 'activationDigest']) {
      if (!SHA256_RE.test(packet?.task?.[key] ?? '')) findings.malformed(`dispatch preparation task ${key} must be sha256:<64 lowercase hex>`);
    }
    if (!CONTRACT_DIGEST_RE.test(packet?.task?.contractDigest ?? '')) findings.malformed('dispatch preparation task contractDigest must be sha256:v1:<64 lowercase hex>');
    if (!safeRepositoryPath(packet?.task?.activationCaptureRef)) findings.malformed('dispatch preparation task activationCaptureRef must be a safe repository-relative path');
    const capture = activationCaptureDisposition(packet?.activation, {
      ...options,
      intendedTaskId: packet?.task?.id,
      repositoryIdentity: targetRepositoryIdentity(packet?.repository?.worktree),
    });
    if (!capture.ok) findings.extend(capture.findings);
    if (packet?.task?.activationDigest !== packet?.activation?.normalizedActivationDigest) findings.changed('packet task activation digest must equal activation capture digest');
    validateReadiness(packet?.readiness, {
      backend: packet?.backend, taskId: packet?.task?.id, carrier: packet?.task?.carrier, digest: packet?.task?.digest,
    }, findings);
    validateDecomposition(packet?.decomposition, packet?.task?.id, findings);
    validateRepositoryBinding(packet?.repository, findings);
    if (packet?.activation?.repositoryIdentity !== targetRepositoryIdentity(packet?.repository?.worktree)) {
      findings.changed('packet activation target repository does not match dispatch repository');
    }
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
  for (const version of [
    BASELINE_DISPATCH_PREPARATION_SCHEMA_VERSION,
    LEGACY_DISPATCH_PREPARATION_SCHEMA_VERSION,
  ]) {
    if (!legacyDispatchCandidate(packet, version)) continue;
    try {
      const projected = currentProjectionOfLegacy(packet, version, options);
      if (projected && validateCurrentDispatchPreparation(projected, options).ok) {
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
      refetchActivation: input.refetchActivation ?? null,
      runGit: input.runGit,
      priorGateReceipts: input.priorGateReceipts ?? [],
      readCarrierDigest: input.readCarrierDigest ?? null,
      activation: packet.activation,
      assignment: packet.assignment,
    }, options);
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
    const fields = ['backend', 'task', 'activation', 'decomposition', 'assignment', 'repository', 'freshness'];
    if (fields.some(field => !sameCanonical(current.packet[field], packet[field])) ||
        !sameCanonical(stableReadinessProjection(current.packet.readiness), stableReadinessProjection(packet.readiness))) {
      return singleFailure(command, 'changed', 'superseded', 'dispatch packet bindings changed after preparation');
    }
    return { ok: true, packet, validation: validation(command, true, 'current', 'proceed', null) };
  } catch (error) {
    return singleFailure(command, 'malformed', 'rejected', `dispatch receive could not be evaluated: ${error.message}`);
  }
}

function validateChecks(checks, findings, label = 'role return') {
  const checked = validateRequiredCheckEvidence(checks, { label });
  for (const error of checked.errors) findings.malformed(error);
}

/** Total validator for one role-return wire value. */
export function validateRoleReturn(value) {
  const findings = findingSet('role return receive');
  try {
    const has = key => isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
    const shapeOk = exactKeys(value, [
      'kind', 'schemaVersion', 'returnId', 'producerRole', 'packet', 'task', 'worktree', 'branch', 'head', 'baseHead',
      'changedPaths', 'checks', 'attribution', 'pr', 'outcome', 'disposition', 'blocker', 'freshness', 'digest',
    ], 'role return', findings);
    if (has('kind') && value.kind !== ROLE_RETURN_KIND) findings.malformed(`role return kind must be '${ROLE_RETURN_KIND}'`);
    if (has('schemaVersion') && value.schemaVersion !== ROLE_RETURN_SCHEMA_VERSION) findings.malformed(`role return schemaVersion must be ${ROLE_RETURN_SCHEMA_VERSION}`);
    if (has('returnId') && (typeof value.returnId !== 'string' || !/^return:[0-9a-f-]{36}$/.test(value.returnId))) findings.malformed('role return returnId is invalid');
    if (has('producerRole') && (value.producerRole !== 'engineer' || !WORKFLOW_ROLE_SET.has(value.producerRole))) findings.malformed('role return producerRole must be immutable engineer');
    if (has('packet') && exactKeys(value.packet, ['packetId', 'digest'], 'role return packet', findings)) {
      if (typeof value.packet.packetId !== 'string' || !value.packet.packetId) findings.malformed('role return packetId is required');
      if (!SEMANTIC_DIGEST_RE.test(value.packet.digest ?? '')) findings.malformed('role return packet digest must be canonical');
    }
    if (has('task') && exactKeys(value.task, ['backend', 'id', 'digest'], 'role return task', findings)) {
      if (!['files', 'github'].includes(value.task.backend)) findings.malformed('role return task backend is invalid');
      if (typeof value.task.id !== 'string' || !value.task.id) findings.malformed('role return task id is required');
      if (!SHA256_RE.test(value.task.digest ?? '')) findings.malformed('role return task digest must be sha256:<64 lowercase hex>');
    }
    if (has('worktree') && (typeof value.worktree !== 'string' || !value.worktree)) findings.malformed('role return worktree is required');
    if (has('branch') && (typeof value.branch !== 'string' || !value.branch)) findings.malformed('role return branch is required');
    for (const key of ['head', 'baseHead']) {
      if (has(key) && !isGitObjectId(value[key])) findings.malformed(`role return ${key} must be a full lowercase 40- or 64-character Git identity`);
    }
    const changedPaths = has('changedPaths') && Array.isArray(value.changedPaths) ? value.changedPaths : null;
    if (has('changedPaths')) {
      if (!changedPaths || changedPaths.some(path => typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.includes('..'))) {
        findings.malformed('role return changedPaths must be safe canonical forward-slash paths');
      } else {
        if (!sameCanonical(changedPaths, [...changedPaths].sort())) findings.malformed('role return changedPaths must be canonical sorted order');
        if (new Set(changedPaths).size !== changedPaths.length) findings.malformed('role return changedPaths must not contain duplicates');
      }
    }
    if (has('checks')) validateChecks(value.checks, findings);
    if (has('attribution') && exactKeys(value.attribution, ['range', 'commits'], 'role return attribution', findings)) {
      if (exactKeys(value.attribution.range, ['base', 'head'], 'role return attribution range', findings) &&
          (value.attribution.range.base !== value?.baseHead || value.attribution.range.head !== value?.head)) {
        findings.malformed('role return attribution range must match baseHead and head');
      }
      const commits = Array.isArray(value.attribution.commits) ? value.attribution.commits : null;
      if (!commits || commits.some(commit => !isGitObjectId(commit))) findings.malformed('role return attribution commits must be full Git identities');
      else if (value?.head !== value?.baseHead && commits.length === 0) findings.malformed('changed role return head requires a non-empty commit range');
    }
    // The heads, the attribution range, and every listed commit are identities
    // from one repository, so they cannot mix Git object formats. Only complete
    // identities are compared here: an abbreviation is already reported above,
    // and reporting it twice would blur two distinct faults into one.
    const returnIdentities = [
      value?.baseHead, value?.head,
      value?.attribution?.range?.base, value?.attribution?.range?.head,
      ...(Array.isArray(value?.attribution?.commits) ? value.attribution.commits : []),
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
      if ((changedPaths ?? []).length === 0) findings.malformed('implementation-ready role return requires changed paths derived from Git');
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
      const digest = semanticDigest('agenticloop.role-return.v2', projection(value));
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
  };
  value.digest = semanticDigest('agenticloop.role-return.v2', projection(value));
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
  exactKeys(value, ['backend', 'task', 'worktree', 'branch', 'baseHead', 'head', 'changedPaths', 'attribution', 'checks', 'pr'], 'repository evidence', findings);
  if (!['files', 'github'].includes(value?.backend)) findings.malformed('repository evidence backend is invalid');
  exactKeys(value?.task, ['id', 'digest'], 'repository evidence task', findings);
  if (typeof value?.task?.id !== 'string' || !value.task.id || !SHA256_RE.test(value?.task?.digest ?? '')) findings.malformed('repository evidence task identity is invalid');
  if (typeof value?.worktree !== 'string' || !value.worktree || typeof value?.branch !== 'string' || !value.branch) findings.malformed('repository evidence worktree and branch are required');
  for (const key of ['baseHead', 'head']) {
    if (!isGitObjectId(value?.[key])) findings.malformed(`repository evidence ${key} must be full Git identity`);
  }
  if (!Array.isArray(value?.changedPaths) || !sameCanonical(value.changedPaths, [...value.changedPaths].sort())) findings.malformed('repository evidence changedPaths must be canonical sorted paths');
  validateChecks(value?.checks, findings, 'repository evidence');
  exactKeys(value?.attribution, ['range', 'commits'], 'repository evidence attribution', findings);
  exactKeys(value?.attribution?.range, ['base', 'head'], 'repository evidence attribution range', findings);
  if (value?.attribution?.range?.base !== value?.baseHead || value?.attribution?.range?.head !== value?.head) findings.malformed('repository evidence attribution range must match evidence heads');
  if (!Array.isArray(value?.attribution?.commits) || value.attribution.commits.some(commit => !isGitObjectId(commit))) findings.malformed('repository evidence attribution commits are invalid');
  // Repository evidence describes exactly one repository, and one repository has
  // exactly one object format; a mixed 40/64 claim is rejected, never resolved.
  const evidenceIdentities = [
    value?.baseHead, value?.head,
    value?.attribution?.range?.base, value?.attribution?.range?.head,
    ...(Array.isArray(value?.attribution?.commits) ? value.attribution.commits : []),
  ].filter(identity => identity !== null && identity !== undefined);
  if (evidenceIdentities.every(isGitObjectId) && !sameGitObjectFormat(evidenceIdentities)) {
    findings.malformed('repository evidence Git identities must all share one Git object format');
  }
  exactKeys(value?.pr, ['state', 'number', 'url'], 'repository evidence PR state', findings);
  if (!PR_STATES.has(value?.pr?.state)) findings.malformed('repository evidence PR state is invalid');
  if (value?.backend === 'files' && !sameCanonical(value?.pr, { state: 'not_applicable', number: null, url: null })) findings.malformed('files repository evidence must derive PR state as not_applicable');
}

function validateReturnAgainstCurrent({ wire, packet, snapshot, repositoryEvidence, producerEvidence, runGit }, findings) {
  validateRepositoryEvidence(repositoryEvidence, findings);
  const authoritative = authoritativePacketTaskBinding(snapshot);
  if (!authoritative.ok) {
    findings.malformed(`authoritative current task contract cannot be derived: ${authoritative.error}`);
  } else if (!sameCanonical(
    { backend: packet.backend, task: packet.task },
    authoritative.binding
  )) {
    findings.changed('dispatch packet task binding does not equal the refetched authoritative task and contract');
  }
  if (producerEvidence?.producerRole !== wire.producerRole || wire.producerRole !== packet.assignment.roleId) findings.malformed('role return producer does not match trusted producer evidence and dispatch assignment');
  if (wire.packet.packetId !== packet.packetId || wire.packet.digest !== packet.digest) findings.changed('role return did not consume the exact dispatch packet');
  if (wire.task.backend !== packet.backend || wire.task.id !== packet.task.id || wire.task.digest !== packet.task.digest) {
    findings.changed('role return task identity does not equal the persisted dispatch packet');
  }
  if (wire.task.backend !== snapshot.backend || wire.task.id !== snapshot.taskId || wire.task.digest !== snapshot.digest) findings.changed('role return task identity does not equal refetched task');
  if (wire.task.backend !== repositoryEvidence?.backend || wire.task.id !== repositoryEvidence?.task?.id || wire.task.digest !== repositoryEvidence?.task?.digest) findings.changed('role return task identity does not equal repository evidence');
  if (wire.worktree !== packet.assignment.worktree || wire.worktree !== repositoryEvidence?.worktree) findings.changed('role return worktree does not match dispatched/current worktree');
  if (wire.branch !== packet.assignment.branch || wire.branch !== repositoryEvidence?.branch) findings.changed('role return branch does not match dispatched/current branch');
  if (wire.baseHead !== packet.repository.head || wire.baseHead !== repositoryEvidence?.baseHead) findings.changed('role return base head does not equal the packet-bound base');
  if (wire.head !== repositoryEvidence?.head) findings.changed('role return head does not equal current repository head');
  for (const key of ['changedPaths', 'attribution', 'pr']) {
    if (!sameCanonical(wire[key], repositoryEvidence?.[key])) findings.changed(`role return ${key} does not match refetched repository evidence`);
  }
  const wireChecks = validateRequiredCheckEvidence(wire.checks);
  const repositoryChecks = validateRequiredCheckEvidence(repositoryEvidence?.checks, { label: 'repository evidence' });
  if (!wireChecks.ok || !repositoryChecks.ok || !sameCanonical(wireChecks.checks, repositoryChecks.checks)) {
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
      } else if (currentHeadId !== wire.head) {
        findings.changed('role return head is no longer the current repository head');
      } else {
        const derived = deriveCommitRange({
          runGit, baseHead: wire.baseHead, head: wire.head, taskId: packet.task.id, roleId: packet.assignment.roleId,
        });
        if (!derived.ok) findings.add(derived.evidenceState, derived.message, { disposition: derived.disposition, code: derived.code });
        else {
          if (!sameCanonical(wire.attribution.commits, derived.commits)) findings.changed('role return attribution commits do not equal the durable Git commit range');
          if (!sameCanonical(wire.changedPaths, derived.changedPaths)) findings.changed('role return changed paths do not equal the durable Git diff');
        }
      }
    }
  } else if (typeof runGit === 'function') {
    const currentHead = runGit(['rev-parse', '--verify', 'HEAD']);
    const currentHeadId = String(currentHead?.stdout ?? '').trim();
    if (currentHead?.status === 0 && isGitObjectId(currentHeadId) && currentHeadId === wire.head) {
      const derived = deriveCommitRange({
        runGit, baseHead: wire.baseHead, head: wire.head, taskId: packet.task.id, roleId: packet.assignment.roleId,
      });
      if (!derived.ok) findings.add(derived.evidenceState, derived.message, { disposition: derived.disposition, code: derived.code });
      else if (!sameCanonical(wire.attribution.commits, derived.commits)) findings.changed('role return attribution commits do not equal the durable Git commit range');
    }
  }
  const requiredChecks = authoritative.ok ? authoritative.binding.task.requiredChecks : packet.task.requiredChecks;
  if (!requiredCheckEvidenceMatchesInventory(wire.checks, requiredChecks)) {
    findings.negative('role return checks do not match the authoritative required-check inventory by id, kind, and identity');
  }
  const contract = taskContractDigest(snapshot.body);
  const deviations = parseDeviations(snapshot.body);
  const allowedPaths = new Set([...(contract.projection?.allowed_paths ?? []), ...deviations.entries.map(entry => entry.path)]);
  for (const path of wire.changedPaths ?? []) {
    if (PERMITTED_SCRATCH_PREFIXES.some(prefix => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) {
      findings.negative(`role return changed path '${path}' is permitted scratch state and cannot be presented as implementation work`);
      continue;
    }
    if (![...allowedPaths].some(pattern => fileMatchesScopePattern(path, pattern))) findings.negative(`role return changed path '${path}' is outside task scope and current deviations`);
  }
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
      producerReceipt,
      resolveTrustedAdapter,
      requestedOwner,
      redelegationAuthority = null,
      recovery = null,
      humanDisposition = null,
      resolveTrustedAuthority,
      workflowRoleRegistry,
      now = Date.now(),
      runGit = null,
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
    for (const [value, label] of [
      [refetchTask, 'current task refetch function is required'],
      [refetchRepositoryEvidence, 'trusted repository-evidence refetch function is required'],
      [resolveTrustedAdapter, 'pinned host-adapter trust resolver is required'],
    ]) {
      if (typeof value !== 'function') return singleFailure(command, 'missing', 'blocked', label, producerDomain);
    }
    if (!producerReceipt || typeof producerReceipt !== 'object' || Array.isArray(producerReceipt)) {
      return singleFailure(command, 'missing', 'blocked', 'raw host-adapter producer receipt is required', producerDomain);
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
    // Authentication happens here, at the authoritative boundary. No caller
    // callback can assert that a receipt was verified elsewhere: the raw
    // receipt is consumed and verified against the pinned adapter selected by
    // the packet, binding adapter/key, target repository, invocation, packet,
    // return, liveness, and repository-evidence digests in one step. The
    // public CLI resolves the pinned adapter from the fail-closed operator
    // trust store; fixture seams inject an explicitly trusted resolver and are
    // never production-reachable.
    let trustedAdapter;
    try {
      trustedAdapter = resolveTrustedAdapter(packet?.activation?.adapter);
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
    let producerEvidence;
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
    const findings = findingSet(command);
    validateCurrentTask(snapshot, findings);
    validateReturnAgainstCurrent({ wire, packet, snapshot, repositoryEvidence, producerEvidence, runGit }, findings);
    const degradedReports = packet.assignment.degradedEnforcementReports;
    const implementation = packet.assignment.hostRoleCapability.actionBindings
      .find(binding => binding.action === 'implementation_mutate');
    if ((wire.changedPaths?.length ?? 0) > 0 && implementation?.policy !== 'allowed') {
      findings.negative(
        `authenticated role '${wire.producerRole}' returned implementation changes while implementation_mutate is ${implementation?.policy ?? 'unbound'}`,
        { code: 'capability.action.denied', disposition: 'rejected' }
      );
    }
    if (findings.length) return failure(command, findings, { producerRole: wire.producerRole });
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
    const warningDiagnostics = degradedWarningDiagnostics(degradedReports);
    return {
      ok: true,
      roleReturn: deepFreeze(wire),
      blockedAuthority: blockedAuthority ? blockedAuthority.value : null,
      validation: validation(command, true, 'current', 'proceed', null, {
        producerRole: wire.producerRole,
        blockedAuthority: blockedAuthority ? structuredClone(blockedAuthority.value) : null,
        degradedEnforcementReports: degradedReports,
        warningDiagnostics,
      }),
    };
  } catch (error) {
    return singleFailure(command, 'malformed', 'rejected', `role return could not be evaluated: ${error.message}`, producerDomain);
  }
}
