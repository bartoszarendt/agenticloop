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
import { PublicCommandError, producerRefusal } from './public-error.js';
import { evaluateTaskRecordRoot } from './task-record-root.js';
import {
  DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
  dispatchableLifecycleRepair,
  evaluatePacketDispatchableLifecycle,
  taskStatusFromBody,
} from './dispatchability.js';
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

// The canonical dispatch-eligibility evaluator and every shared dimension
// validator it orchestrates. This module resolves facts, mints packets, and
// renders command envelopes; it no longer decides any shared prerequisite.
import {
  ACTIVATION_CAPTURE_KIND,
  ACTIVATION_CAPTURE_SCHEMA_VERSION,
  ACTIVATION_BINDING_KIND,
  ACTIVATION_BINDING_SCHEMA_VERSION,
  DISPATCH_ASSURANCE_KIND,
  DISPATCH_ASSURANCE_SCHEMA_VERSION,
  ACTIVATION_SOURCES,
  POLICY_SOURCES,
  LEGACY_DECOMPOSITION_SCHEMA_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  DECOMPOSITION_BINDING_KIND,
  DECOMPOSITION_BINDING_SCHEMA_VERSION,
  SHA256_RE,
  CONTRACT_DIGEST_RE,
  SEMANTIC_DIGEST_RE,
  CAPTURE_ID_RE,
  TASK_ID_RE,
  SHIPPED_ACTIVATION_ADAPTERS,
  activationCapabilityInventory,
  isObject,
  resolveInventory,
  ACTIVATION_CLOCK_SKEW_MS,
  FindingSet,
  exactKeys,
  digestBytes,
  normalizeSha256,
  isoTimestamp,
  sameCanonical,
  semanticDigest,
  projection,
  commandDiagnosticCode,
  findingSet,
  canonicalReferences,
  requiredCapabilities,
  decompositionSourceDigest,
  closedKeys,
  validateActivationCapture,
  activationCaptureDisposition,
  validateDecomposition,
  validateDecompositionFreshness,
  decompositionBinding,
  dispatchAssurance,
  validateCurrentTask,
  observeDispatchInitialState,
  evaluateDispatchEligibility,
  liveDispatchCandidate,
  sealedPacketCandidate,
} from './dispatch-eligibility.js';


// Preserved public surface: these names were exported from this module
// before the validator consolidation moved their definitions one layer down.
export {
  ACTIVATION_CAPTURE_KIND,
  ACTIVATION_CAPTURE_SCHEMA_VERSION,
  ACTIVATION_BINDING_KIND,
  ACTIVATION_BINDING_SCHEMA_VERSION,
  DISPATCH_ASSURANCE_KIND,
  DISPATCH_ASSURANCE_SCHEMA_VERSION,
  ACTIVATION_SOURCES,
  POLICY_SOURCES,
  LEGACY_DECOMPOSITION_SCHEMA_VERSION,
  DECOMPOSITION_SCHEMA_VERSION,
  DECOMPOSITION_BINDING_KIND,
  DECOMPOSITION_BINDING_SCHEMA_VERSION,
  SHIPPED_ACTIVATION_ADAPTERS,
  activationCapabilityInventory,
  ACTIVATION_CLOCK_SKEW_MS,
  validateActivationCapture,
  activationCaptureDisposition,
  FindingSet,
  findingSet,
  validateDecomposition,
  validateDecompositionFreshness,
};


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
export const ROLE_RETURN_KIND = 'agenticloop.role-return';
export const CANCELLATION_BLOCKER_CATEGORY = 'cancellation_requested';
export const ROLE_RETURN_SCHEMA_VERSION = 5;

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

function stableReadinessProjection(readiness) {
  if (!isObject(readiness) || !isObject(readiness.evidence) || !isObject(readiness.evidence.dependencies)) return readiness;
  const copy = structuredClone(readiness);
  delete copy.evidence.dependencies.evaluatedAt;
  return copy;
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

    // ── Boundary-only resolution ──────────────────────────────────────────
    // Everything below normalizes facts. Not one shared prerequisite is decided
    // here: the assignment's authority path and degraded-enforcement reports are
    // derived, the repository worktree identity is canonicalized, the scope the
    // clean gate reads is taken from the refetched record rather than from the
    // caller, and the initial repository state is observed. The verdict over all
    // of it belongs to `evaluateDispatchEligibility`.
    let boundAssignment = assignment;
    try {
      boundAssignment = {
        ...assignment,
        worktree: pathIdentity(assignment?.worktree).authorityPath,
        degradedEnforcementReports: createDegradedEnforcementReports(assignment?.hostRoleCapability),
      };
    } catch (error) {
      const findings = findingSet(command);
      findings.malformed(
        `dispatch assignment host-role capability declaration is invalid: ${error.message}`,
        { code: 'capability.declaration.invalid' }
      );
      return failure(command, findings);
    }
    // Task scope decides which untracked additions are relevant, so it is read
    // from the refetched record rather than supplied by the dispatch caller.
    const scopeContract = taskContractDigest(snapshot?.body);
    const cleanStateObservation = observeDispatchInitialState({
      runGit,
      scopePatterns: scopeContract.ok ? scopeContract.projection.allowed_paths ?? [] : [],
      intendedCreations: scopeContract.ok ? scopeContract.projection.intended_creations ?? [] : [],
      priorGateReceipts,
      readCarrierDigest,
    });
    const inventoryRecheck = scopeContract.ok && decomposition?.scan?.workUnit?.backend
      ? {
          taskId: snapshot.taskId,
          backend: decomposition.scan.workUnit.backend,
          currentContractDigest: scopeContract.digest,
          runGit,
          baseEvidence: readiness?.evidence?.base ?? null,
          dependencyEvidence: readiness?.evidence?.dependencies ?? null,
        }
      : null;

    // ── The one canonical semantic decision ───────────────────────────────
    const eligibility = evaluateDispatchEligibility(liveDispatchCandidate({
      snapshot,
      activationEvidence,
      readiness,
      repository: { ...repository, worktree: pathIdentity(repository?.worktree).authorityPath },
      decomposition,
      parallelScanInventory: parallelScanInventory ?? null,
      assignment: boundAssignment,
      policy,
      returnAdapter: options.returnAdapter ?? null,
      cleanStateObservation,
      inventoryRecheck,
      authority: {
        capabilities: options.capabilities,
        verifyActivationSignature: options.verifyActivationSignature,
        hostRoleCapabilities: options.hostRoleCapabilities,
      },
      now: options.now,
    }));
    if (!eligibility.ok) {
      const findings = findingSet(command);
      findings.extend(eligibility.findings);
      return failure(command, findings);
    }
    // A packet may only be minted from a decision that actually bound an
    // assignment over live facts. A read-only readiness decision is
    // structurally unable to reach this line.
    if (!eligibility.packetEligible) {
      return singleFailure(command, 'malformed', 'rejected', 'dispatch eligibility decision does not authorize packet creation');
    }

    const bound = eligibility.bindings.repository;
    const packet = packetFromBindings({
      snapshot,
      activation: eligibility.bindings.activation,
      readiness,
      decomposition,
      assignment: boundAssignment,
      repository: bound,
      contract: eligibility.bindings.contract,
      policy,
      returnAdapter: options.returnAdapter ?? null,
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
        ...(eligibility.proseDriftAccepted ? { proseDriftAccepted: true } : {}),
      }),
    };
  } catch (error) {
    return singleFailure(command, 'malformed', 'rejected', `dispatch preparation could not be evaluated: ${error.message}`);
  }
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
    // ── The one canonical semantic decision over the sealed packet ────────
    // Everything above this line is the closed wire schema: exact keys, kind,
    // schema version, packet id, backend, and the task field types. Everything
    // below is the closed freshness inventory and the exact digest. The shared
    // semantic prerequisites in between - activation authority, assurance,
    // return capability, readiness, decomposition, repository, assignment, and
    // base identity - are decided once, by the same evaluator packet
    // preparation and role start consume.
    //
    // A packet whose schema is already broken is never handed to the semantic
    // evaluator as if it were a valid candidate.
    if (shapeOk) {
      const eligibility = evaluateDispatchEligibility(sealedPacketCandidate({
        packet,
        authority: {
          capabilities: options.capabilities,
          hostRoleCapabilities: options.hostRoleCapabilities,
          resolveActivationBinding: options.resolveActivationBinding,
          allowLegacyDecomposition: options.allowLegacyDecomposition === true,
          allowedAdapters: options.allowedAdapters,
        },
        now: options.now,
      }));
      findings.extend(eligibility.findings);
    }
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

const ATTEMPT_IDENTITY_RE = /^attempt:[a-f0-9]{32}$/;

/**
 * Validate the explicit claim "this return's product work was committed under
 * previous attempts on this task, which were then explicitly abandoned".
 *
 * `null` is the ordinary answer and the only one an ordinary attempt may give.
 * A stated lineage must name the attempts it carries and must agree with the
 * base the return binds, so the claim is checkable on its own before anything
 * re-derives it from durable records.
 *
 * @returns {string[]} the identities this lineage contributes to the range's
 *   single-object-format proof
 */
function validateProductLineage(value, findings, label) {
  if (value === null || value === undefined) return [];
  if (!exactKeys(value, ['carriedBaseHead', 'attempts'], `${label} productLineage`, findings)) return [];
  const identities = [];
  if (!isGitObjectId(value.carriedBaseHead)) {
    findings.malformed(`${label} productLineage carriedBaseHead must be a full lowercase 40- or 64-character Git identity`);
  } else identities.push(value.carriedBaseHead);
  const attempts = Array.isArray(value.attempts) ? value.attempts : null;
  if (!attempts || attempts.length === 0) {
    findings.malformed(`${label} productLineage must name at least one carried execution attempt`);
    return identities;
  }
  for (const attempt of attempts) {
    if (!exactKeys(attempt, ['attemptId', 'packetId', 'productBaseHead'], `${label} productLineage attempt`, findings)) continue;
    if (!ATTEMPT_IDENTITY_RE.test(String(attempt.attemptId ?? ''))) {
      findings.malformed(`${label} productLineage attemptId must be a derived execution-attempt identity`);
    }
    if (typeof attempt.packetId !== 'string' || !attempt.packetId) {
      findings.malformed(`${label} productLineage attempt packetId is required`);
    }
    if (!isGitObjectId(attempt.productBaseHead)) {
      findings.malformed(`${label} productLineage attempt productBaseHead must be a full Git identity`);
    } else identities.push(attempt.productBaseHead);
  }
  // The carried base is the base of the earliest attempt being carried, not a
  // separately chosen commit: a lineage that names attempts but binds some
  // other base would widen the product range without evidence for the widening.
  if (isGitObjectId(value.carriedBaseHead) && isGitObjectId(attempts[0]?.productBaseHead) &&
      value.carriedBaseHead !== attempts[0].productBaseHead) {
    findings.malformed(`${label} productLineage carriedBaseHead must equal the earliest carried attempt's product base`);
  }
  return identities;
}

/** Total validator for one role-return wire value. */
export function validateRoleReturn(value) {
  const findings = findingSet('role return receive');
  try {
    const has = key => isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
    const shapeOk = exactKeys(value, [
      'kind', 'schemaVersion', 'returnId', 'producerRole', 'packet', 'task', 'worktree', 'branch',
      'productBaseHead', 'productLineage', 'productHead', 'workflowHead', 'candidateHead',
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
    const lineageIdentities = has('productLineage')
      ? validateProductLineage(value.productLineage, findings, 'role return')
      : [];
    if (value?.productLineage && isGitObjectId(value.productLineage.carriedBaseHead) &&
        value.productLineage.carriedBaseHead !== value?.productBaseHead) {
      findings.malformed('role return productBaseHead must equal the carried product lineage base it claims');
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
      ...lineageIdentities,
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

/**
 * A construction refusal is a fact about the caller's own evidence, not an
 * internal accident, so it is typed at the origin. Thrown as a bare
 * `TypeError` it reached the command boundary as an untyped error, whose
 * message that boundary is obliged to erase: the field run spent thirteen
 * `prepare-return` invocations reading "required operational context is
 * unavailable" for a refusal that names its own cause precisely.
 *
 * `committedStateEvaluated` is true here: the producer read the current task,
 * packet, and check evidence to reach this conclusion.
 */
const refuseRoleReturn = producerRefusal({
  code: 'role_return.invalid',
  committedStateEvaluated: true,
  safeRepair:
    'Repair the reported role-return facts at their producer and rerun the return preparation; ' +
    'never hand-edit the role return itself.',
});

/** @param {any} input */
export function createRoleReturn(input = {}) {
  /** @type {any} */
  const value = {
    ...input,
    kind: ROLE_RETURN_KIND,
    schemaVersion: ROLE_RETURN_SCHEMA_VERSION,
    returnId: input.returnId ?? `return:${randomUUID()}`,
    // Ordinary attempts carry nothing: the field is explicit and always present
    // so a return can never be silently missing the claim it did not make.
    productLineage: input.productLineage ?? null,
    requiredCheckEvidenceContract: input.requiredCheckEvidenceContract ?? REQUIRED_CHECK_EVIDENCE_CONTRACT_VERSION,
    checks: Array.isArray(input.checks)
      ? input.checks.map(check => check && typeof check === 'object' && !Array.isArray(check)
        ? { ...check }
        : check)
      : input.checks,
  };
  value.digest = semanticDigest(`agenticloop.role-return.v${ROLE_RETURN_SCHEMA_VERSION}`, projection(value));
  const checked = validateRoleReturn(value);
  if (!checked.ok) throw refuseRoleReturn(`invalid role return: ${checked.errors.join('; ')}`);
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
    'backend', 'task', 'worktree', 'branch', 'productBaseHead', 'productLineage', 'productHead', 'workflowHead', 'candidateHead',
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
  const evidenceLineageIdentities = validateProductLineage(value?.productLineage, findings, 'repository evidence');
  if (value?.productLineage && isGitObjectId(value.productLineage.carriedBaseHead) &&
      value.productLineage.carriedBaseHead !== value?.productBaseHead) {
    findings.malformed('repository evidence productBaseHead must equal the carried product lineage base it claims');
  }
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
    ...evidenceLineageIdentities,
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
  // An ordinary return binds exactly the packet's own base. A return that
  // explicitly carries an abandoned attempt's product work binds that attempt's
  // base instead - and only after the refetched evidence, rederived from the
  // same durable attempt records, states the identical lineage (compared with
  // every other evidence field below) and Git confirms the carried base is
  // behind the packet base.
  const boundProductBase = wire.productLineage ? wire.productLineage.carriedBaseHead : packet.repository.head;
  if (wire.productBaseHead !== boundProductBase || wire.productBaseHead !== repositoryEvidence?.productBaseHead) {
    findings.changed(wire.productLineage
      ? 'role return productBaseHead does not equal the carried-attempt base it claims'
      : 'role return productBaseHead does not equal the packet-bound base');
  }
  if (wire.productLineage && typeof runGit === 'function' &&
      isGitObjectId(wire.productLineage.carriedBaseHead) && isGitObjectId(packet.repository.head)) {
    const behind = runGit(['merge-base', '--is-ancestor', wire.productLineage.carriedBaseHead, packet.repository.head]);
    if (behind?.status !== 0) {
      findings.changed('role return carried product base is not an ancestor of the packet-bound base');
    }
  }
  if (wire.productHead !== repositoryEvidence?.productHead || wire.workflowHead !== repositoryEvidence?.workflowHead) {
    findings.changed('role return productHead or workflowHead does not equal repository evidence');
  }
  for (const key of ['productLineage', 'productChangedPaths', 'workflowChangedPaths', 'productAttribution', 'pr', 'carrierLineage']) {
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
