/** Exact-head review-entry evidence and its resumable failure packet. */

import { canonicalJson, canonicalSha256 } from './canonical-json.js';
import { taskContractDigest } from './task-contract-baseline.js';
import { githubAttributionShape, resolveGitHubTaskIdentityStrict } from './github-task-identity.js';
import {
  createValidationResult,
  deriveEvidenceState,
  dispositionForEvidenceState,
  normalizeDiagnosticEvidenceStates,
  validateValidationResult,
  validationResultDigest,
  VALIDATION_RESULT_KIND,
} from './result-envelope.js';
import { evaluateCommitAttribution } from './commit-attribution.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';

export const REVIEW_ENTRY_RECEIPT_KIND = 'agenticloop.review-entry-receipt';
export const REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION = 3;
export const REVIEW_ENTRY_FAILURE_KIND = 'agenticloop.review-entry-resume';
export const REVIEW_ENTRY_FAILURE_SCHEMA_VERSION = 1;

/**
 * The receipt digest domain is derived from the schema version so the two can
 * never drift: a v3 receipt is only ever digested and verified in the v3
 * domain. An older digest is a legacy identity - it may be recognized for
 * diagnostics but is never reinterpreted as v3 and never authorizes the v3
 * review-entry or dispatch boundary.
 */
export const REVIEW_ENTRY_RECEIPT_DIGEST_DOMAIN =
  `${REVIEW_ENTRY_RECEIPT_KIND}.v${REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION}`;
const RECEIPT_DIGEST_RE = new RegExp(
  `^sha256:${REVIEW_ENTRY_RECEIPT_DIGEST_DOMAIN.replace(/\./g, '\\.')}:[a-f0-9]{64}$`
);
const LEGACY_RECEIPT_DIGEST_RE =
  /^sha256:agenticloop\.review-entry-receipt\.v([1-9]\d*):[a-f0-9]{64}$/;

export const REVIEW_ENTRY_RECEIPT_FIELDS = Object.freeze([
  'kind', 'schemaVersion', 'backend', 'task', 'artifact', 'checks', 'attribution',
  'review', 'observation', 'validation', 'lifecycle', 'workOwnerRoleId', 'digest',
]);

const REVIEW_ENTRY_RECEIPT_MODES = Object.freeze(['host_subagent', 'independent_human']);

const INVALIDATORS = Object.freeze([
  'artifact_head_changed', 'task_body_changed', 'task_contract_changed',
  'required_checks_changed', 'check_evidence_changed', 'attribution_changed',
  'review_evidence_changed',
]);

const BODY_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const CONTRACT_DIGEST_RE = /^sha256:v1:[a-f0-9]{64}$/;
const SEMANTIC_DIGEST_RE = /^sha256:agenticloop\.[a-z-]+\.v[1-9]\d*:[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isObject(value) && Object.keys(value).length === expected.length &&
    Object.keys(value).every(key => expected.includes(key));
}

function bodyDigest(body) {
  return `sha256:${canonicalSha256(String(body ?? ''))}`;
}

function semanticDigest(domain, value) {
  return `sha256:agenticloop.${domain}.v1:${canonicalSha256(value)}`;
}

function receiptDigest(receipt) {
  const projection = structuredClone(receipt);
  delete projection.digest;
  return `sha256:${REVIEW_ENTRY_RECEIPT_DIGEST_DOMAIN}:${canonicalSha256(projection)}`;
}

/**
 * Name the legacy schema version a receipt digest belongs to, or null when the
 * digest is not a recognizable review-entry receipt digest. Diagnostics use
 * this to say "stale v1 receipt" instead of "malformed digest"; nothing uses it
 * to grant authority.
 *
 * @param {unknown} digest
 * @returns {number|null}
 */
export function legacyReviewEntryReceiptDigestVersion(digest) {
  const match = String(digest ?? '').match(LEGACY_RECEIPT_DIGEST_RE);
  if (!match) return null;
  const version = Number(match[1]);
  return version === REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION ? null : version;
}

function oid(value) {
  return isGitObjectId(value);
}

function reviewAttribution(prData, issueData, head) {
  const identity = resolveGitHubTaskIdentityStrict(issueData);
  if (!identity.ok || !identity.identity) throw new TypeError('review entry requires a current task identity for attribution');
  const expected = githubAttributionShape(identity.identity.taskId, 'engineer');
  const commits = Array.isArray(prData?.commits) ? prData.commits : [];
  const normalized = commits.map(commit => {
    const id = String(commit?.oid ?? '');
    const message = typeof commit?.message === 'string'
      ? commit.message
      : [commit?.messageHeadline, commit?.messageBody].filter(part => typeof part === 'string' && part).join('\n');
    return { id, message };
  });
  if (normalized.length === 0 || normalized.some(commit => !oid(commit.id))) {
    throw new TypeError('review entry requires durable complete commit identities');
  }
  for (const commit of normalized) {
    const attribution = evaluateCommitAttribution({
      message: commit.message,
      taskId: identity.identity.taskId,
      role: 'engineer',
    });
    if (!attribution.ok) {
      throw new TypeError(`review entry attribution for commit ${commit.id} is invalid: ${attribution.errors.join('; ')}`);
    }
  }
  if (!normalized.some(commit => commit.id === head)) {
    throw new TypeError('review entry head is absent from the durable commit attribution inventory');
  }
  return { taskId: identity.identity.taskId, roleId: 'engineer', commits: normalized.map(commit => commit.id), trailers: expected };
}

function reviewHistoryObjectIds(history) {
  const ids = [];
  for (const event of history?.events ?? []) {
    if (event?.artifact !== undefined && event?.artifact !== null && event.artifact !== '') ids.push(event.artifact);
  }
  return ids;
}

/**
 * The current outstanding finding IDs a receipt's durable review history
 * carries: the finding inventory of its latest `needs_revision` outcome. Packet
 * validation binds its own `currentFindingIds` to this projection so the outer
 * packet cannot contradict the receipt it embeds.
 *
 * @param {any} receipt
 * @returns {string[]}
 */
export function reviewEntryReceiptCurrentFindingIds(receipt) {
  const ids = receipt?.review?.history?.currentFindingIds;
  return Array.isArray(ids) ? [...ids] : [];
}

function currentFindingIdsFromHistory(history) {
  const events = Array.isArray(history?.events) ? history.events : [];
  const prior = [...events].reverse().find(event => event?.type === 'outcome' && event?.status === 'needs_revision');
  return Array.isArray(prior?.findingIds) ? [...prior.findingIds] : [];
}

function reviewHistorySnapshot(history) {
  return {
    digest: semanticDigest('review-history', history),
    eventCount: history.events.length,
    currentFindingIds: currentFindingIdsFromHistory(history),
  };
}

function checkIdentity(check) {
  return String(check?.id ?? check?.matchKey ?? check?.text ?? '').trim();
}

function checksSnapshot(checks, evidence) {
  return {
    required: checks.map(check => ({
      identity: checkIdentity(check),
      digest: semanticDigest('required-check', check),
    })),
    evidence: evidence.map((entry, index) => ({
      identity: checkIdentity(checks[index]),
      digest: semanticDigest('check-evidence', entry),
    })),
  };
}

function receiptInputEvidenceState(loaded, result) {
  if (!loaded?.input || !result) return 'missing';
  if (!Array.isArray(result.requiredChecks) || result.requiredChecks.length === 0 ||
      !Array.isArray(result.evidenceMatches) || result.evidenceMatches.length === 0 ||
      !loaded.input.reviewHistory || !Array.isArray(loaded.input.reviewHistory.events) ||
      !Array.isArray(loaded.input.reviewHistory.errors)) return 'missing';
  return deriveEvidenceState(result.diagnostics ?? []) ?? (result.ok === false ? 'negative' : 'malformed');
}

/**
 * Build the embedded validation result for a preparation outcome.
 *
 * A failure carries the *derived* evidence state, not a hard-coded `negative`,
 * and its disposition comes from the one canonical mapping. A packet therefore
 * cannot report `missing` evidence beside a `blocked`/`negative` validation.
 */
function validationFor(result, evidenceState = null) {
  const ok = result?.ok === true;
  const state = ok ? 'current' : (evidenceState ?? deriveEvidenceState(result?.diagnostics ?? []) ?? 'negative');
  const validation = createValidationResult({
    command: 'github review prepare',
    ok,
    evidenceState: state,
    disposition: ok ? 'proceed' : dispositionForEvidenceState(state),
    errors: result?.errors ?? [],
    warnings: result?.warnings ?? [],
  });
  return { result: validation, digest: validationResultDigest(validation) };
}

function receiptMaterial(loaded, result, observedAt) {
  if (!result?.ok) throw new TypeError('a failed preparation cannot mint a review-entry receipt');
  const prData = loaded?.input?.prData;
  const issueData = loaded?.input?.issueData;
  const head = String(prData?.headRefOid ?? '');
  if (!oid(head)) throw new TypeError('review entry requires a complete current implementation head identity');
  const contract = taskContractDigest(issueData?.body);
  if (!contract.ok || !result?.contractBaseline?.digest || contract.digest !== result.contractBaseline.digest) {
    throw new TypeError('review entry task contract is missing, malformed, or changed');
  }
  const checks = Array.isArray(result.requiredChecks) ? result.requiredChecks : [];
  const evidence = Array.isArray(result.evidenceMatches) ? result.evidenceMatches : [];
  if (checks.length === 0 || evidence.length !== checks.length) {
    throw new TypeError('review entry requires exact current evidence for every required check');
  }
  const checkIds = checks.map(check => check.id ?? check.matchKey ?? check.text);
  if (checkIds.some(id => !String(id ?? '').trim()) || new Set(checkIds).size !== checkIds.length) {
    throw new TypeError('review entry required checks must have unique exact identities');
  }
  const reviewHistory = loaded?.input?.reviewHistory;
  if (!reviewHistory || !Array.isArray(reviewHistory.events) || !Array.isArray(reviewHistory.errors) || reviewHistory.errors.length > 0) {
    throw new TypeError('review entry requires current durable review evidence');
  }
  const historyIds = reviewHistoryObjectIds(reviewHistory);
  if (!historyIds.every(oid)) throw new TypeError('review entry review history contains an incomplete Git object identity');
  if (!sameGitObjectFormat([head, ...historyIds, ...(prData?.commits ?? []).map(commit => commit?.oid)])) {
    throw new TypeError('review entry Git identities must all use one object format');
  }
  const independentReviewRequired = String(contract.projection.independent_review_required).toLowerCase() === 'true';
  const reviewMode = independentReviewRequired ? 'independent_human' : 'host_subagent';
  const validation = validationFor(result);
  return {
    kind: REVIEW_ENTRY_RECEIPT_KIND,
    schemaVersion: REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION,
    backend: 'github',
    task: {
      id: String(issueData.number), bodyDigest: bodyDigest(issueData.body), contractDigest: contract.digest,
      contractBaseline: result.contractBaseline.baseline,
    },
    artifact: { kind: 'pull_request', pr: Number(prData.number), head },
    checks: checksSnapshot(checks, evidence),
    attribution: reviewAttribution(prData, issueData, head),
    review: { mode: reviewMode, independentReviewRequired, history: reviewHistorySnapshot(reviewHistory) },
    observation: { observedAt, invalidatedBy: INVALIDATORS },
    validation: { result: validation.result, digest: validation.digest },
    lifecycle: { claim: 'implementation_ready_for_review', completion: false },
    workOwnerRoleId: 'engineer',
    digest: null,
  };
}

export function createReviewEntryReceipt(loaded, result, { observedAt = new Date().toISOString() } = {}) {
  const receipt = receiptMaterial(loaded, result, observedAt);
  receipt.digest = receiptDigest(receipt);
  return Object.freeze(receipt);
}

/**
 * Static closed-schema and integrity validation for a review-entry receipt.
 *
 * This proves the receipt is a complete, self-consistent, digest-consistent v3
 * receipt. It deliberately requires no current repository state and therefore
 * proves nothing about whether the receipt is still *current*: only
 * {@link validateReviewEntryReceipt} - and, at the dispatch boundary,
 * `verifyReviewPacket` - can make that claim.
 *
 * @param {any} receipt
 * @returns {{ ok: boolean, errors: string[], evidenceState: string }}
 */
export function validateReviewEntryReceiptShape(receipt) {
  const errors = [];
  if (receipt === null || receipt === undefined) {
    return { ok: false, errors: ['review-entry receipt is missing'], evidenceState: 'missing' };
  }
  if (!exactKeys(receipt, REVIEW_ENTRY_RECEIPT_FIELDS)) {
    errors.push('review-entry receipt fields must equal the closed schema');
  }
  if (receipt?.kind !== REVIEW_ENTRY_RECEIPT_KIND) errors.push('review-entry receipt kind is invalid');
  let stale = false;
  if (receipt?.schemaVersion !== REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION) {
    errors.push(`review-entry receipt schemaVersion must be ${REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION}`);
    stale = Number.isInteger(receipt?.schemaVersion) && receipt.schemaVersion < REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION;
  }
  if (receipt?.backend !== 'github') errors.push('review-entry receipt backend is invalid');
  if (receipt?.workOwnerRoleId !== 'engineer') errors.push('review-entry receipt work owner must be immutable engineer');

  const task = receipt?.task;
  if (!exactKeys(task, ['id', 'bodyDigest', 'contractDigest', 'contractBaseline'])) {
    errors.push('review-entry receipt task projection must equal the closed schema');
  } else {
    if (typeof task.id !== 'string' || !/^[1-9]\d*$/.test(task.id)) errors.push('review-entry receipt task id must be a positive integer identity');
    if (!BODY_DIGEST_RE.test(String(task.bodyDigest ?? ''))) errors.push('review-entry receipt task bodyDigest is invalid');
    if (!CONTRACT_DIGEST_RE.test(String(task.contractDigest ?? ''))) errors.push('review-entry receipt task contractDigest is invalid');
    if (task.contractBaseline !== null && typeof task.contractBaseline !== 'string') errors.push('review-entry receipt task contractBaseline must be a string or null');
  }

  const artifact = receipt?.artifact;
  if (!exactKeys(artifact, ['kind', 'pr', 'head'])) {
    errors.push('review-entry receipt artifact projection must equal the closed schema');
  } else {
    if (artifact.kind !== 'pull_request') errors.push('review-entry receipt artifact kind must be pull_request');
    if (!Number.isInteger(artifact.pr) || artifact.pr <= 0) errors.push('review-entry receipt artifact pr must be a positive integer');
    if (!oid(artifact.head)) errors.push('review-entry receipt artifact head must be a complete Git object identity');
  }

  const checks = receipt?.checks;
  if (!exactKeys(checks, ['required', 'evidence'])) {
    errors.push('review-entry receipt check projection must equal the closed schema');
  } else if (!Array.isArray(checks.required) || !Array.isArray(checks.evidence)) {
    errors.push('review-entry receipt check collections must be arrays');
  } else {
    if (checks.required.length === 0) errors.push('review-entry receipt must bind at least one required check');
    if (checks.required.length !== checks.evidence.length) errors.push('review-entry receipt requires exact evidence for every required check');
    const identities = [];
    checks.required.forEach((check, index) => {
      if (!exactKeys(check, ['identity', 'digest'])) {
        errors.push(`review-entry receipt required check ${index + 1} must equal the closed snapshot schema`);
        return;
      }
      if (typeof check.identity !== 'string' || !check.identity.trim()) {
        errors.push(`review-entry receipt required check ${index + 1} must have an exact identity`);
      } else {
        identities.push(check.identity);
      }
      if (!SEMANTIC_DIGEST_RE.test(String(check.digest ?? '')) ||
          !String(check.digest).startsWith('sha256:agenticloop.required-check.v1:')) {
        errors.push(`review-entry receipt required check ${index + 1} digest is invalid`);
      }
    });
    checks.evidence.forEach((entry, index) => {
      if (!exactKeys(entry, ['identity', 'digest'])) {
        errors.push(`review-entry receipt check evidence ${index + 1} must equal the closed snapshot schema`);
        return;
      }
      if (entry.identity !== checks.required[index]?.identity) {
        errors.push(`review-entry receipt check evidence ${index + 1} does not bind its required-check identity`);
      }
      if (!SEMANTIC_DIGEST_RE.test(String(entry.digest ?? '')) ||
          !String(entry.digest).startsWith('sha256:agenticloop.check-evidence.v1:')) {
        errors.push(`review-entry receipt check evidence ${index + 1} digest is invalid`);
      }
    });
    if (identities.length === checks.required.length && new Set(identities).size !== identities.length) {
      errors.push('review-entry receipt required checks must have unique exact identities');
    }
  }

  const attribution = receipt?.attribution;
  if (!exactKeys(attribution, ['taskId', 'roleId', 'commits', 'trailers'])) {
    errors.push('review-entry receipt attribution must equal the closed schema');
  } else {
    if (typeof attribution.taskId !== 'string' || !attribution.taskId.trim()) errors.push('review-entry receipt attribution taskId is required');
    if (attribution.roleId !== 'engineer') errors.push('review-entry receipt attribution role must be immutable engineer');
    if (!Array.isArray(attribution.commits) || attribution.commits.length === 0 || !attribution.commits.every(oid)) {
      errors.push('review-entry receipt attribution commits must be complete Git object identities');
    } else if (oid(artifact?.head) && !attribution.commits.includes(artifact.head)) {
      errors.push('review-entry receipt head is absent from its own commit attribution inventory');
    }
    const expectedTrailers = typeof attribution.taskId === 'string' && attribution.taskId.trim()
      ? githubAttributionShape(attribution.taskId, 'engineer')
      : null;
    if (!exactKeys(attribution.trailers, ['bodyTrailer', 'taskTrailer', 'agentTrailer'])) {
      errors.push('review-entry receipt attribution trailers must equal the closed schema');
    } else if (expectedTrailers &&
      (attribution.trailers.bodyTrailer !== expectedTrailers.bodyTrailer ||
       attribution.trailers.taskTrailer !== expectedTrailers.taskTrailer ||
       attribution.trailers.agentTrailer !== expectedTrailers.agentTrailer)) {
      errors.push('review-entry receipt attribution trailers contradict its task and Engineer role identities');
    }
  }

  const review = receipt?.review;
  if (!exactKeys(review, ['mode', 'independentReviewRequired', 'history'])) {
    errors.push('review-entry receipt review projection must equal the closed schema');
  } else {
    if (!REVIEW_ENTRY_RECEIPT_MODES.includes(review.mode)) errors.push('review-entry receipt review mode is invalid');
    if (typeof review.independentReviewRequired !== 'boolean') errors.push('review-entry receipt independentReviewRequired must be boolean');
    else if (REVIEW_ENTRY_RECEIPT_MODES.includes(review.mode) &&
      review.independentReviewRequired !== (review.mode === 'independent_human')) {
      errors.push('review-entry receipt review mode contradicts independentReviewRequired');
    }
    if (!exactKeys(review.history, ['digest', 'eventCount', 'currentFindingIds'])) {
      errors.push('review-entry receipt review history must equal the closed snapshot schema');
    } else {
      if (!SEMANTIC_DIGEST_RE.test(String(review.history.digest ?? '')) ||
          !String(review.history.digest).startsWith('sha256:agenticloop.review-history.v1:')) {
        errors.push('review-entry receipt review history digest is invalid');
      }
      if (!Number.isSafeInteger(review.history.eventCount) || review.history.eventCount < 0) {
        errors.push('review-entry receipt review history eventCount must be a non-negative safe integer');
      }
      const findingIds = review.history.currentFindingIds;
      if (!Array.isArray(findingIds) || !findingIds.every(id => /^F-[1-9]\d*$/.test(id))) {
        errors.push('review-entry receipt review history currentFindingIds must be canonical finding IDs');
      } else if (new Set(findingIds).size !== findingIds.length) {
        errors.push('review-entry receipt review history currentFindingIds must not contain duplicates');
      }
    }
  }

  if (!sameGitObjectFormat([artifact?.head, ...(Array.isArray(attribution?.commits) ? attribution.commits : [])])) {
    errors.push('review-entry receipt Git identities must all use one object format');
  }

  const observation = receipt?.observation;
  if (!exactKeys(observation, ['observedAt', 'invalidatedBy'])) {
    errors.push('review-entry receipt observation must equal the closed schema');
  } else {
    if (typeof observation.observedAt !== 'string' || Number.isNaN(Date.parse(observation.observedAt)) ||
        new Date(observation.observedAt).toISOString() !== observation.observedAt) {
      errors.push('review-entry receipt observedAt must be an exact timestamp');
    }
    if (!Array.isArray(observation.invalidatedBy) ||
      observation.invalidatedBy.length !== INVALIDATORS.length ||
      observation.invalidatedBy.some((item, index) => item !== INVALIDATORS[index])) {
      errors.push('review-entry receipt invalidation inventory must equal the canonical inventory');
    }
  }

  const validation = receipt?.validation;
  if (!exactKeys(validation, ['result', 'digest'])) {
    errors.push('review-entry receipt validation binding must equal the closed schema');
  } else {
    const resultValidation = validateValidationResult(validation.result);
    if (!resultValidation.ok) {
      errors.push(`review-entry receipt validation result is invalid: ${resultValidation.errors[0]}`);
    } else {
      if (validation.result.kind !== VALIDATION_RESULT_KIND || validation.result.command !== 'github review prepare' ||
          validation.result.ok !== true || validation.result.evidenceState !== 'current' ||
          validation.result.disposition !== 'proceed') {
        errors.push('review-entry receipt validation result must be the successful current review-preparation result');
      }
      if (validation.digest !== validationResultDigest(validation.result)) {
        errors.push('review-entry receipt validation digest does not match its embedded result');
      }
    }
  }

  const lifecycle = receipt?.lifecycle;
  if (!exactKeys(lifecycle, ['claim', 'completion'])) {
    errors.push('review-entry receipt lifecycle must equal the closed schema');
  } else if (lifecycle.claim !== 'implementation_ready_for_review' || lifecycle.completion !== false) {
    errors.push('review-entry receipt may claim only non-completing implementation_ready_for_review');
  }

  const legacyVersion = legacyReviewEntryReceiptDigestVersion(receipt?.digest);
  if (legacyVersion !== null) {
    stale = true;
    errors.push(
      `review-entry receipt digest uses the legacy v${legacyVersion} domain; ` +
      `a v${REVIEW_ENTRY_RECEIPT_SCHEMA_VERSION} receipt must be digested in the ` +
      `'${REVIEW_ENTRY_RECEIPT_DIGEST_DOMAIN}' domain and cannot be reinterpreted`
    );
  } else if (!RECEIPT_DIGEST_RE.test(String(receipt?.digest ?? ''))) {
    errors.push(`review-entry receipt digest must use the '${REVIEW_ENTRY_RECEIPT_DIGEST_DOMAIN}' domain`);
  } else {
    let digestValid = false;
    try {
      digestValid = receipt.digest === receiptDigest(receipt);
    } catch {
      digestValid = false;
    }
    if (!digestValid) errors.push('review-entry receipt digest is invalid');
  }

  return {
    ok: errors.length === 0,
    errors,
    evidenceState: errors.length === 0 ? 'current' : stale ? 'stale' : 'malformed',
  };
}

/** Rebuild current material rather than trusting a prior receipt's head alone. */
export function validateReviewEntryReceipt(receipt, loaded, result) {
  const shape = validateReviewEntryReceiptShape(receipt);
  if (!shape.ok) {
    return { ok: false, errors: shape.errors, evidenceState: shape.evidenceState, receipt: null };
  }
  const errors = [];
  let evidenceState = 'current';
  let current = null;
  try {
    current = createReviewEntryReceipt(loaded, result, { observedAt: receipt?.observation?.observedAt });
    if (canonicalJson(current) !== canonicalJson(receipt)) {
      errors.push('review-entry receipt no longer matches current task, artifact, checks, attribution, or review evidence');
      evidenceState = 'changed';
    }
  } catch (error) {
    errors.push(error.message);
    evidenceState = receiptInputEvidenceState(loaded, result);
  }
  return { ok: errors.length === 0, errors, evidenceState: errors.length === 0 ? 'current' : evidenceState, receipt: current };
}

function ownerFor(diagnostics = []) {
  return diagnostics.find(item => item?.owner ?? item?.targetCapability?.owner)?.owner ??
    diagnostics.find(item => item?.targetCapability?.owner)?.targetCapability?.owner ??
    'engineer';
}

/**
 * Typed, owner-preserving review-entry failure/resume packet.
 *
 * Exactly one evidence state travels through the packet: the state derived from
 * the diagnostics under canonical precedence sets `evidence.state`, the
 * embedded validation's `evidenceState`, and - through the one canonical
 * mapping - its `disposition`. Capability-derived ownership and the precise
 * failed transition are preserved verbatim.
 */
export function createReviewEntryFailurePacket({ loaded, result, diagnostics = [] } = {}) {
  const ownerRole = ownerFor(diagnostics);
  const state = deriveEvidenceState(diagnostics) ?? 'negative';
  const validation = validationFor({ ...result, ok: false }, state).result;
  const packet = {
    kind: REVIEW_ENTRY_FAILURE_KIND,
    schemaVersion: REVIEW_ENTRY_FAILURE_SCHEMA_VERSION,
    task: { backend: 'github', id: String(loaded?.input?.issueData?.number ?? result?.issue ?? '') },
    artifact: { pr: Number(loaded?.input?.prData?.number ?? result?.pr ?? 0), head: String(loaded?.input?.prData?.headRefOid ?? result?.headRefOid ?? '').trim() || null },
    evidence: { state, diagnostics: normalizeDiagnosticEvidenceStates(diagnostics) },
    ownerRole,
    nextResumableTransition: diagnostics.find(item => typeof item?.nextResumableTransition === 'string')?.nextResumableTransition ??
      diagnostics.find(item => typeof item?.failedTransition === 'string')?.failedTransition ??
      'github_review_prepare',
    firstSafeRepair: diagnostics.find(item => typeof item?.nextAction === 'string')?.nextAction ??
      diagnostics.find(item => typeof item?.repairHint === 'string')?.repairHint ??
      null,
    preconditions: (result?.errors ?? []).map(String),
    validation,
    digest: null,
  };
  const projection = { ...packet };
  delete projection.digest;
  packet.digest = `sha256:${REVIEW_ENTRY_FAILURE_KIND}.v${REVIEW_ENTRY_FAILURE_SCHEMA_VERSION}:${canonicalSha256(projection)}`;
  return Object.freeze(packet);
}
