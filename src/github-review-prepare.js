/** Fail-closed, read-only exact-head Maintainer delegation preparation. */

import { readFileSync } from 'node:fs';
import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { loadPreflightInput, evaluatePreflight } from './github-preflight.js';
import { evaluatePreparationInput } from './preparation-input.js';
import { presentDiagnostics } from './diagnostic-presentation.js';
import { createDiagnostic } from './repair-policy.js';
import { getProjectRoleCapabilities } from './role-capabilities.js';
import { taskRequiresIndependentReview, validateReviewWorkspace } from './github-review-audit.js';
import {
  createReviewEntryFailurePacket,
  createReviewEntryReceipt,
  reviewEntryReceiptCurrentFindingIds,
  validateReviewEntryReceipt,
  validateReviewEntryReceiptShape,
} from './review-entry-receipt.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import { recognizeLifecycleReturn } from './handoff-binding.js';
import { resolveGitHubTaskIdentityStrict } from './github-task-identity.js';
import { canonicalSha256 } from './canonical-json.js';
import { fetchGitHubTaskBody } from './github-task-body.js';
import { refetchGitHubReturnEvidence } from './github-return-evidence.js';

const REVIEW_PACKET_TYPE = 'agenticloop.github_review_preparation';
const REVIEW_PACKET_SCHEMA_VERSION = 3;
const REVIEW_MODES = new Set(['host_subagent', 'independent_human']);
export const REVIEW_PACKET_LEASE =
  'Review this exact head read-only. Do not mutate the branch, PR body, comments, task contract, or GitHub state while reviewing. A head change invalidates this packet.';
const REVIEW_PACKET_DIGEST_DOMAIN = `agenticloop.github-review-preparation.v${REVIEW_PACKET_SCHEMA_VERSION}`;

import { PublicCommandError } from './public-error.js';

export class GitHubReviewPrepareError extends PublicCommandError {
  constructor(message) {
    super(message);
    this.name = 'GitHubReviewPrepareError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isObject(value) && Object.keys(value).length === expected.length &&
    Object.keys(value).every(key => expected.includes(key));
}

export function reviewPacketDigest(packet) {
  const projection = structuredClone(packet);
  delete projection.digest;
  return `sha256:${REVIEW_PACKET_DIGEST_DOMAIN}:${canonicalSha256(projection)}`;
}

/** Refetch the current PR head through the same read-only command runner. */
function refetchCurrentHead(commandRunner, prNumber, repo) {
  const args = ['pr', 'view', String(prNumber), '--json', 'headRefOid'];
  if (repo) args.push('--repo', repo);
  const data = runGhJson(commandRunner, args);
  return String(data?.headRefOid ?? '');
}

function validateHeadFreshness(stampedHead, currentHead) {
  const stamped = String(stampedHead ?? '');
  const current = String(currentHead ?? '');
  if (!isGitObjectId(stamped)) {
    return { valid: false, stale: false, reason: 'packet is missing a complete stamped Git object identity' };
  }
  if (!isGitObjectId(current)) {
    return { valid: false, stale: false, reason: 'current head is missing or malformed; cannot confirm packet freshness' };
  }
  if (!sameGitObjectFormat([stamped, current])) {
    return { valid: false, stale: false, reason: `packet head ${stamped} and current head ${current} use different Git object formats` };
  }
  if (stamped !== current) {
    return { valid: false, stale: true, stampedHead: stamped, currentHead: current, reason: `packet head ${stamped} differs from current head ${current}; the packet is stale` };
  }
  return { valid: true, stale: false, stampedHead: stamped, currentHead: current };
}

function validateReviewPacketShape(packet, expectedPr) {
  const errors = [];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return { valid: false, stale: false, reason: 'packet must be a JSON object', errors: ['packet must be a JSON object'] };
  }
  const required = ['type', 'schemaVersion', 'pr', 'task', 'headRefOid', 'reviewMode', 'independentReviewRequired', 'workspace', 'currentFindingIds', 'preflight', 'taskContract', 'reviewEntryReceipt', 'lease', 'digest'];
  if (Object.keys(packet).length !== required.length || Object.keys(packet).some(key => !required.includes(key))) {
    errors.push('packet fields must equal the authoritative closed schema');
  }
  if (packet.type !== REVIEW_PACKET_TYPE) {
    errors.push(`packet type must be '${REVIEW_PACKET_TYPE}'`);
  }
  if (packet.schemaVersion !== REVIEW_PACKET_SCHEMA_VERSION) {
    errors.push(`packet schemaVersion must be ${REVIEW_PACKET_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(packet.pr) || packet.pr <= 0) {
    errors.push('packet pr must be a positive integer');
  } else if (expectedPr !== undefined && packet.pr !== expectedPr) {
    errors.push(`packet pr ${packet.pr} does not match requested PR ${expectedPr}`);
  }
  if (!Number.isInteger(packet.task) || packet.task <= 0) {
    errors.push('packet task must be a positive integer issue identity');
  }
  const stampedHead = String(packet.headRefOid ?? '');
  if (!isGitObjectId(stampedHead)) {
    errors.push('packet headRefOid must be a complete Git object identity');
  }
  if (!REVIEW_MODES.has(packet.reviewMode)) {
    errors.push(`packet reviewMode must be one of: ${[...REVIEW_MODES].join(', ')}`);
  }
  if (typeof packet.independentReviewRequired !== 'boolean') {
    errors.push('packet independentReviewRequired must be boolean');
  } else if (
    REVIEW_MODES.has(packet.reviewMode) &&
    packet.independentReviewRequired !== (packet.reviewMode === 'independent_human')
  ) {
    errors.push('packet independentReviewRequired is inconsistent with reviewMode');
  }
  if (!Array.isArray(packet.currentFindingIds) || !packet.currentFindingIds.every(id => /^F-[1-9]\d*$/.test(id))) {
    errors.push('packet currentFindingIds must be an array of finding IDs');
  } else if (new Set(packet.currentFindingIds).size !== packet.currentFindingIds.length) {
    errors.push('packet currentFindingIds must not contain duplicates');
  }
  if (!Object.hasOwn(packet, 'workspace')) {
    errors.push('packet must include the workspace field');
  } else if (packet.workspace !== null) {
    const workspace = packet.workspace;
    if (!exactKeys(workspace, ['path', 'head', 'verified'])) {
      errors.push('packet workspace must be null or a verified workspace object');
    } else {
      if (typeof workspace.path !== 'string' || !workspace.path.trim()) errors.push('packet workspace path must be a nonempty string');
      if (workspace.verified !== true) errors.push('packet workspace must be verified');
      if (String(workspace.head ?? '') !== stampedHead || !sameGitObjectFormat([workspace.head, stampedHead])) {
        errors.push('packet workspace head must match packet headRefOid');
      }
    }
  }
  const preflight = packet.preflight;
  const digest = preflight?.digest;
  if (!exactKeys(preflight, ['ok', 'digest']) || preflight.ok !== true) {
    errors.push('packet preflight must record ok: true');
  }
  if (!exactKeys(digest, ['requiredChecks', 'evidenceMatches', 'headRefOid'])) {
    errors.push('packet preflight digest is required');
  } else {
    if (!Number.isSafeInteger(digest.requiredChecks) || digest.requiredChecks < 0) {
      errors.push('packet preflight digest requiredChecks must be a non-negative integer');
    }
    if (!Number.isSafeInteger(digest.evidenceMatches) || digest.evidenceMatches < 0) {
      errors.push('packet preflight digest evidenceMatches must be a non-negative integer');
    }
    if (String(digest.headRefOid ?? '') !== stampedHead) {
      errors.push('packet preflight digest headRefOid must match packet headRefOid');
    }
  }
  if (packet.lease !== REVIEW_PACKET_LEASE) {
    errors.push('packet lease must equal the immutable read-only review lease');
  }
  const contract = packet.taskContract;
  if (!exactKeys(contract, ['digest', 'baseline'])) {
    errors.push('packet taskContract must be an object');
  } else {
    if (contract.digest !== null && typeof contract.digest !== 'string') {
      errors.push('packet taskContract digest must be a string or null');
    }
    if (contract.baseline !== null && !isObject(contract.baseline)) {
      errors.push('packet taskContract baseline must be an object or null');
    }
  }
  let digestValid = false;
  try {
    digestValid = typeof packet.digest === 'string' && packet.digest === reviewPacketDigest(packet);
  } catch {
    digestValid = false;
  }
  if (!digestValid) {
    errors.push('packet digest is invalid');
  }
  // The embedded receipt is validated as a complete, digest-consistent,
  // correctly digested v3 receipt in its own right. Matching projections alone are not
  // evidence: a fabricated object that merely echoes the packet's head and task
  // must not pass this boundary.
  const receipt = packet.reviewEntryReceipt;
  const receiptShape = validateReviewEntryReceiptShape(receipt);
  if (!receiptShape.ok) {
    errors.push(...receiptShape.errors.map(error => `packet reviewEntryReceipt rejected: ${error}`));
  } else {
    // Every duplicated outer field is bound to the receipt. A packet cannot
    // restate a field the receipt already fixes and disagree with it.
    if (receipt.artifact.head !== stampedHead) errors.push('packet headRefOid does not equal the receipt artifact head');
    if (receipt.artifact.pr !== packet.pr) errors.push('packet pr does not equal the receipt artifact pr');
    if (receipt.task.id !== String(packet.task)) errors.push('packet task does not equal the receipt task id');
    if (receipt.task.contractDigest !== (packet.taskContract?.digest ?? null)) {
      errors.push('packet taskContract digest does not equal the receipt task contract digest');
    }
    if (canonicalSha256(receipt.task.contractBaseline) !== canonicalSha256(packet.taskContract?.baseline ?? null)) {
      errors.push('packet taskContract baseline does not equal the receipt task contract baseline');
    }
    if (receipt.review.mode !== packet.reviewMode) errors.push('packet reviewMode does not equal the receipt review mode');
    if (receipt.review.independentReviewRequired !== packet.independentReviewRequired) {
      errors.push('packet independentReviewRequired does not equal the receipt review requirement');
    }
    if (digest && typeof digest === 'object' && !Array.isArray(digest)) {
      if (digest.requiredChecks !== receipt.checks.required.length) {
        errors.push('packet preflight digest requiredChecks does not equal the receipt required-check count');
      }
      if (digest.evidenceMatches !== receipt.checks.evidence.length) {
        errors.push('packet preflight digest evidenceMatches does not equal the receipt evidence count');
      }
    }
    const receiptFindingIds = reviewEntryReceiptCurrentFindingIds(receipt);
    const packetFindingIds = Array.isArray(packet.currentFindingIds) ? packet.currentFindingIds : null;
    if (packetFindingIds === null ||
      packetFindingIds.length !== receiptFindingIds.length ||
      packetFindingIds.some((id, index) => id !== receiptFindingIds[index])) {
      errors.push('packet currentFindingIds do not equal the current finding ids in the receipt review history');
    }
    if (packet.workspace && typeof packet.workspace === 'object' && !Array.isArray(packet.workspace) &&
      String(packet.workspace.head ?? '') !== receipt.artifact.head) {
      errors.push('packet workspace head does not equal the receipt artifact head');
    }
  }
  return {
    valid: errors.length === 0,
    stale: false,
    stampedHead,
    reason: errors[0] ?? null,
    errors,
  };
}

function routeDiagnostics(facts, capabilities) {
  const diagnostics = presentDiagnostics(facts, capabilities);
  const grouped = new Map();
  for (const diagnostic of diagnostics) {
    const owner = diagnostic.owner;
    if (!owner) {
      throw new GitHubReviewPrepareError(
        `diagnostic '${String(diagnostic.code ?? diagnostic.category ?? 'unknown')}' has no capability-derived owner`
      );
    }
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push(diagnostic);
  }
  return {
    diagnostics,
    ownerRouting: Object.fromEntries([...grouped].map(([owner, owned]) => [owner, owned])),
  };
}

export function runGitHubReviewPrepare({ pr, workspace, packet: packetPath, ...options } = {}) {
  if (packetPath) return verifyReviewPacket({ pr, packet: packetPath, ...options });
  const loaded = loadPreflightInput({ pr, ...options, includeBasePaths: true });
  const result = evaluatePreparationInput(loaded.input, evaluatePreflight, { referenceResolvers: loaded.referenceResolvers });
  const capabilities = getProjectRoleCapabilities(options.target ?? process.cwd());
  // The exact head is resolved from the complete current PR state immediately
  // before packet creation and stamped on every result.
  const head = String(loaded.input.prData.headRefOid ?? '');
  const workspaceResult = workspace
    ? validateReviewWorkspace({ workspace, expectedArtifact: head })
    : { provided: false, valid: true, workspace: null, head: null };
  const workspaceFacts = workspaceResult.error
    ? [createDiagnostic({
      code: 'review_prepare.workspace',
      message: workspaceResult.error,
      repairHint: 'Repair the workspace so it matches the exact review head before dispatch.',
    })]
    : [];
  if (!result.ok || workspaceResult.error) {
    const errors = [...(result.errors ?? []), ...workspaceFacts.map(d => d.message)];
    const routed = routeDiagnostics([...(result.diagnostics ?? []), ...workspaceFacts], capabilities);
    const failedResult = { ...result, ok: false, errors };
    return {
      schemaVersion: 1, ok: false, pr: loaded.input.prData.number, issue: loaded.input.issueData.number,
      headRefOid: head, errors, warnings: result.warnings ?? [], diagnostics: routed.diagnostics,
      ownerRouting: routed.ownerRouting, packet: null,
      resumePacket: createReviewEntryFailurePacket({ loaded, result: failedResult, diagnostics: routed.diagnostics }),
      firstSafeRepair: routed.diagnostics[0]?.nextAction ?? null,
    };
  }
  const independence = taskRequiresIndependentReview(loaded.input.issueData.body);
  if (independence.errors?.length) {
    const facts = independence.errors.map(message => createDiagnostic({
      code: 'preflight.task_policy',
      message,
      repairHint: 'Repair the independent-review task contract before review dispatch.',
    }));
    const routed = routeDiagnostics(facts, capabilities);
    return {
      schemaVersion: 1, ok: false, pr: loaded.input.prData.number, issue: loaded.input.issueData.number,
      headRefOid: head, errors: independence.errors, warnings: result.warnings ?? [],
      diagnostics: routed.diagnostics, ownerRouting: routed.ownerRouting, packet: null,
      resumePacket: createReviewEntryFailurePacket({ loaded, result: { ...result, ok: false, errors: independence.errors }, diagnostics: routed.diagnostics }),
      firstSafeRepair: routed.diagnostics[0]?.nextAction ?? null,
    };
  }
  // Re-fetch every receipt binding immediately before emission. A head-only
  // re-read cannot detect task-body, check, attribution, or review drift.
  const refreshed = loadPreflightInput({ pr, ...options, includeBasePaths: true });
  const freshResult = evaluatePreparationInput(refreshed.input, evaluatePreflight, { referenceResolvers: refreshed.referenceResolvers });
  const freshHead = String(refreshed.input.prData.headRefOid ?? '');
  const commandRunner = options.commandRunner ?? defaultGhCommandRunner;
  const emittedHead = refetchCurrentHead(commandRunner, refreshed.input.prData.number, options.repo);
  const freshness = validateHeadFreshness(freshHead, emittedHead);
  const finalIndependence = taskRequiresIndependentReview(refreshed.input.issueData.body);
  const finalWorkspace = workspace
    ? validateReviewWorkspace({ workspace, expectedArtifact: freshHead })
    : { provided: false, valid: true, workspace: null, head: null };
  if (!freshness.valid || !freshResult.ok || finalIndependence.errors?.length || finalWorkspace.error) {
    const fact = createDiagnostic({
      code: 'review_prepare.stale_head',
      message: !freshness.valid && freshness.stale
        ? `evaluated head ${freshHead} differs from the current PR head ${emittedHead}; the preparation is stale and no packet is emitted`
        : !freshness.valid
          ? `cannot confirm packet freshness: ${freshness.reason}`
          : finalWorkspace.error
            ? finalWorkspace.error
            : finalIndependence.errors?.[0] ??
              'review-entry bindings changed or are no longer valid after the final refetch; no receipt is emitted',
      repairHint: 'Rerun github-review-prepare against the current head before review dispatch.',
    });
    const routed = routeDiagnostics([fact], capabilities);
    const diagnostic = routed.diagnostics[0];
    const failedResult = freshResult.ok ? { ...freshResult, ok: false, errors: [diagnostic.message] } : freshResult;
    return {
      schemaVersion: 1, ok: false, pr: refreshed.input.prData.number, issue: refreshed.input.issueData.number,
      headRefOid: freshHead, errors: [diagnostic.message], warnings: freshResult.warnings ?? [],
      diagnostics: routed.diagnostics, ownerRouting: routed.ownerRouting, packet: null,
      resumePacket: createReviewEntryFailurePacket({ loaded: refreshed, result: failedResult, diagnostics: routed.diagnostics }),
      firstSafeRepair: diagnostic.nextAction,
    };
  }
  // Review entry is protected: no packet or lifecycle-bearing receipt exists
  // until a current canonical verified return is recognized. Returning a
  // readable packet with a null outer claim was still a dispatch capability,
  // and the embedded receipt still asserted the claim.
  const handoffRecognition = recognizeReviewEntryHandoff({
    target: options.target,
    io: options.io ?? null,
    issueBody: refreshed.input.issueData.body,
    issueNumber: refreshed.input.issueData.number,
    taskContractDigest: freshResult.contractBaseline?.digest ?? null,
    artifactHead: freshHead,
    commandRunner,
    repo: options.repo,
  });
  if (!handoffRecognition.recognized) {
    const routed = routeDiagnostics(handoffRecognition.diagnostics, capabilities);
    const errors = routed.diagnostics.map(item => item.message);
    return {
      schemaVersion: 1, ok: false, pr: refreshed.input.prData.number,
      issue: refreshed.input.issueData.number, headRefOid: freshHead,
      errors, warnings: freshResult.warnings ?? [], diagnostics: routed.diagnostics,
      ownerRouting: routed.ownerRouting, packet: null,
      resumePacket: createReviewEntryFailurePacket({
        loaded: refreshed,
        result: { ...freshResult, ok: false, errors },
        diagnostics: routed.diagnostics,
      }),
      handoffRecognition,
      firstSafeRepair: routed.diagnostics[0]?.nextAction ?? null,
    };
  }
  const receipt = createReviewEntryReceipt(refreshed, freshResult);
  const prior = [...refreshed.input.reviewHistory.events].reverse().find(event => event.type === 'outcome' && event.status === 'needs_revision');
  const packet = {
    type: REVIEW_PACKET_TYPE, schemaVersion: REVIEW_PACKET_SCHEMA_VERSION,
    pr: refreshed.input.prData.number, task: refreshed.input.issueData.number, headRefOid: freshHead,
    reviewMode: finalIndependence.value ? 'independent_human' : 'host_subagent',
    independentReviewRequired: Boolean(finalIndependence.value),
    workspace: finalWorkspace.provided ? { path: finalWorkspace.workspace, head: finalWorkspace.head, verified: true } : null,
    currentFindingIds: prior?.findingIds ?? [],
    preflight: { ok: true, digest: { requiredChecks: freshResult.requiredChecks.length, evidenceMatches: freshResult.evidenceMatches.length, headRefOid: freshHead } },
    taskContract: {
      digest: freshResult.contractBaseline?.digest ?? null,
      baseline: freshResult.contractBaseline?.baseline ?? null,
    },
    reviewEntryReceipt: receipt,
    lease: REVIEW_PACKET_LEASE,
    digest: null,
  };
  packet.digest = reviewPacketDigest(packet);
  return {
    schemaVersion: 1, ok: true, pr: packet.pr, issue: packet.task, headRefOid: packet.headRefOid,
    errors: [], warnings: freshResult.warnings ?? [], diagnostics: presentDiagnostics(freshResult.warningDiagnostics ?? [], capabilities), ownerRouting: {}, packet,
    lifecycle: {
      claim: receipt.lifecycle.claim, completion: false, receiptDigest: receipt.digest,
      attribution: receipt.attribution, handoffRecognitionDigest: handoffRecognition.digest,
    },
    handoffRecognition,
    firstSafeRepair: null,
  };
}

/**
 * Recognize the canonical verified return standing behind one review entry.
 *
 * The task identity and contract generation come from the live issue and its
 * trusted baseline, and the assurance minimum from current operator policy, so
 * nothing here is read back out of the evidence being judged.
 */
function recognizeReviewEntryHandoff({
  target, io, issueBody, issueNumber, taskContractDigest, artifactHead,
  commandRunner = defaultGhCommandRunner, repo,
}) {
  const root = target ?? process.cwd();
  const identity = resolveGitHubTaskIdentityStrict({ body: issueBody });
  const taskId = identity.ok ? identity.identity?.taskId ?? null : null;
  const liveTask = () => {
    const fetched = fetchGitHubTaskBody({
      issue: issueNumber,
      repo,
      commandRunner,
    });
    return {
      backend: 'github', taskId, carrier: `issue:${fetched.issue}`,
      body: fetched.body, digest: fetched.digest,
      trustedRecords: fetched.trustedRecords,
      trustedRecordErrors: fetched.trustedRecordErrors,
    };
  };
  return recognizeLifecycleReturn({
    target: root,
    transition: 'review_entry',
    io,
    backend: 'github',
    taskId,
    taskContractDigest,
    carrierDigest: liveTask().digest,
    artifactHead,
    refetchTask: liveTask,
    refetchRepositoryEvidence: record => refetchGitHubReturnEvidence(record.evidence.repositoryEvidence, {
      commandRunner,
      repo,
    }),
  });
}

/**
 * Structural and integrity validation of a review packet against a head the
 * caller already holds.
 *
 * This proves the packet is a complete closed-schema packet, that its embedded
 * review-entry receipt is a complete digest-consistent v3 receipt, that no outer field
 * contradicts that receipt, and that the stamped head equals the supplied head.
 *
 * It does **not** prove current repository state: it performs no refetch, no
 * preflight re-evaluation, and no revalidation of the receipt against live
 * task, check, attribution, or review evidence. Only
 * {@link verifyReviewPacket} may claim current authoritative dispatch
 * readiness, and no dispatch caller may authorize review from shape and head
 * validation alone.
 */
export function validateReviewPacket(packet, currentHead, options = {}) {
  const shape = validateReviewPacketShape(packet, options.expectedPr);
  if (!shape.valid) return shape;
  return validateHeadFreshness(shape.stampedHead, currentHead);
}

/**
 * The authoritative current-state consumer used before review dispatch.
 *
 * Reads a previously emitted preparation packet from a local file, applies the
 * full structural/integrity check above, refetches the complete current PR and
 * task state read-only, re-evaluates preflight, revalidates the complete
 * receipt against that current state, and compares the evaluated head with the
 * current head. Stale, missing, malformed, fabricated, and self-contradictory
 * packets are all rejected. It never writes GitHub or local state.
 */
export function verifyReviewPacket({
  pr, packet, commandRunner = defaultGhCommandRunner, workspaceCommandRunner,
  repo, target = process.cwd(), io = null,
} = {}) {
  const prNumber = Number(pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new GitHubReviewPrepareError(`--pr must be a positive integer, got '${pr}'`);
  }
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(readFileSync(String(packet), 'utf8'));
  } catch (error) {
    parseError = error.message;
  }
  const capabilities = getProjectRoleCapabilities(target);
  if (parseError) {
    const routed = routeDiagnostics([createDiagnostic({
      code: 'review_prepare.packet',
      message: `review packet is not readable JSON: ${parseError}`,
      repairHint: 'Regenerate the packet with github-review-prepare before dispatch.',
    })], capabilities);
    const diagnostic = routed.diagnostics[0];
    return {
      schemaVersion: 1, ok: false, pr: prNumber, headRefOid: null,
      errors: [diagnostic.message], warnings: [], diagnostics: routed.diagnostics,
      ownerRouting: routed.ownerRouting,
      packetCheck: { valid: false, stale: false, reason: 'packet is malformed' },
      packet: null, firstSafeRepair: diagnostic.nextAction,
    };
  }
  const shape = validateReviewPacketShape(parsed, prNumber);
  if (!shape.valid) {
    const routed = routeDiagnostics([createDiagnostic({
      code: 'review_prepare.packet',
      message: `review packet rejected before dispatch: ${shape.reason}`,
      repairHint: 'Regenerate the packet with github-review-prepare before dispatch.',
    })], capabilities);
    const diagnostic = routed.diagnostics[0];
    return {
      schemaVersion: 1, ok: false, pr: prNumber, headRefOid: null,
      errors: [diagnostic.message], warnings: [], diagnostics: routed.diagnostics,
      ownerRouting: routed.ownerRouting,
      packetCheck: shape, packet: null, firstSafeRepair: diagnostic.nextAction,
    };
  }
  const currentHead = refetchCurrentHead(commandRunner, prNumber, repo);
  const check = validateReviewPacket(parsed, currentHead, { expectedPr: prNumber });
  const facts = [];
  let handoffRecognition = null;
  if (!check.valid) {
    facts.push(createDiagnostic({
      code: 'review_prepare.stale_head',
      message: `review packet rejected before dispatch: ${check.reason}`,
      repairHint: 'Regenerate the packet with github-review-prepare before dispatch.',
    }));
  }
  if (check.valid) {
    try {
      if (parsed.workspace) {
        const workspace = validateReviewWorkspace({
          workspace: parsed.workspace.path,
          expectedArtifact: currentHead,
          ...(workspaceCommandRunner ? { commandRunner: workspaceCommandRunner } : {}),
        });
        if (workspace.error || workspace.head !== parsed.workspace.head || workspace.workspace !== parsed.workspace.path) {
          facts.push(createDiagnostic({
            code: 'review_prepare.packet',
            message: `review packet rejected before dispatch: workspace verification failed: ${workspace.error ?? 'the resolved workspace identity differs from the packet'}`,
            repairHint: 'Regenerate the packet from a workspace at the exact current review head.',
          }));
        }
      }
      const refreshed = loadPreflightInput({ pr: prNumber, issue: parsed.task, repo, commandRunner, target, includeBasePaths: true });
      const result = evaluatePreparationInput(refreshed.input, evaluatePreflight, { referenceResolvers: refreshed.referenceResolvers });
      const refreshedHead = String(refreshed.input.prData.headRefOid ?? '');
      if (refreshedHead !== currentHead) {
        facts.push(createDiagnostic({
          code: 'review_prepare.stale_head',
          message: `review packet rejected before dispatch: evaluated head ${refreshedHead} differs from current head ${currentHead}`,
          repairHint: 'Regenerate the packet with github-review-prepare before dispatch.',
        }));
      }
      const receipt = validateReviewEntryReceipt(parsed.reviewEntryReceipt, refreshed, result);
      if (!receipt.ok) facts.push(createDiagnostic({
        code: 'review_prepare.packet',
        message: `review packet rejected before dispatch: ${receipt.errors[0]}`,
        repairHint: 'Regenerate the packet with github-review-prepare before dispatch.',
      }));
      handoffRecognition = recognizeReviewEntryHandoff({
        target,
        io,
        issueBody: refreshed.input.issueData.body,
        issueNumber: refreshed.input.issueData.number,
        taskContractDigest: result.contractBaseline?.digest ?? null,
        artifactHead: currentHead,
        commandRunner,
        repo,
      });
      if (!handoffRecognition.recognized) facts.push(...handoffRecognition.diagnostics);
    } catch (error) {
      facts.push(createDiagnostic({
        code: 'review_prepare.packet',
        message: `review packet could not revalidate every receipt binding: ${error.message}`,
        repairHint: 'Regenerate the packet with github-review-prepare before dispatch.',
      }));
    }
  }
  const routed = routeDiagnostics(facts, capabilities);
  const diagnostics = routed.diagnostics;
  const ok = diagnostics.length === 0;
  return {
    schemaVersion: 1, ok, pr: prNumber, headRefOid: currentHead,
    errors: diagnostics.map(item => item.message), warnings: [], diagnostics,
    ownerRouting: routed.ownerRouting,
    packetCheck: check, packet: ok ? parsed : null,
    handoffRecognition,
    firstSafeRepair: ok ? null : diagnostics[0].nextAction,
  };
}
