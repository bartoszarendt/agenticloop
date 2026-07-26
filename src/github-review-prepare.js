/** Fail-closed, read-only exact-head Maintainer delegation preparation. */

import { readFileSync } from 'node:fs';
import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { loadPreflightInput, evaluatePreflight } from './github-preflight.js';
import { evaluatePreparationInput } from './preparation-input.js';
import { taskRequiresIndependentReview, validateReviewWorkspace } from './github-review-audit.js';

const REVIEW_PACKET_TYPE = 'agenticloop.github_review_preparation';
const REVIEW_PACKET_SCHEMA_VERSION = 1;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const REVIEW_MODES = new Set(['host_subagent', 'independent_human']);

export class GitHubReviewPrepareError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubReviewPrepareError';
  }
}

/** Refetch the current PR head through the same read-only command runner. */
function refetchCurrentHead(commandRunner, prNumber, repo) {
  const args = ['pr', 'view', String(prNumber), '--json', 'headRefOid'];
  if (repo) args.push('--repo', repo);
  const data = runGhJson(commandRunner, args);
  return String(data?.headRefOid ?? '').toLowerCase();
}

function validateHeadFreshness(stampedHead, currentHead) {
  const stamped = String(stampedHead ?? '').toLowerCase();
  const current = String(currentHead ?? '').toLowerCase();
  if (!FULL_SHA.test(stamped)) {
    return { valid: false, stale: false, reason: 'packet is missing a valid full-40-character stamped headRefOid' };
  }
  if (!FULL_SHA.test(current)) {
    return { valid: false, stale: false, reason: 'current head is missing or malformed; cannot confirm packet freshness' };
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
  const stampedHead = String(packet.headRefOid ?? '').toLowerCase();
  if (!FULL_SHA.test(stampedHead)) {
    errors.push('packet headRefOid must be a full 40-character SHA');
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
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
      errors.push('packet workspace must be null or a verified workspace object');
    } else {
      if (!String(workspace.path ?? '').trim()) errors.push('packet workspace path must be nonempty');
      if (workspace.verified !== true) errors.push('packet workspace must be verified');
      if (String(workspace.head ?? '').toLowerCase() !== stampedHead) {
        errors.push('packet workspace head must match packet headRefOid');
      }
    }
  }
  const preflight = packet.preflight;
  const digest = preflight?.digest;
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight) || preflight.ok !== true) {
    errors.push('packet preflight must record ok: true');
  }
  if (!digest || typeof digest !== 'object' || Array.isArray(digest)) {
    errors.push('packet preflight digest is required');
  } else {
    if (!Number.isInteger(digest.requiredChecks) || digest.requiredChecks < 0) {
      errors.push('packet preflight digest requiredChecks must be a non-negative integer');
    }
    if (!Number.isInteger(digest.evidenceMatches) || digest.evidenceMatches < 0) {
      errors.push('packet preflight digest evidenceMatches must be a non-negative integer');
    }
    if (String(digest.headRefOid ?? '').toLowerCase() !== stampedHead) {
      errors.push('packet preflight digest headRefOid must match packet headRefOid');
    }
  }
  if (!String(packet.lease ?? '').trim()) {
    errors.push('packet lease must be nonempty');
  }
  return {
    valid: errors.length === 0,
    stale: false,
    stampedHead,
    reason: errors[0] ?? null,
    errors,
  };
}

function ownerFor(category) {
  if (category === 'review_checkpoint') return 'orchestrator';
  if (category === 'task_policy' || category === 'preparation_input') return 'maintainer';
  if (category === 'attribution' || category === 'evidence' || category === 'checks' || category === 'scope_deviations' || category === 'revision_resolution') return 'engineer';
  return 'maintainer';
}

function routeDiagnostics(result) {
  const grouped = new Map();
  for (const diagnostic of result.diagnostics ?? []) {
    const owner = diagnostic.owner ?? ownerFor(diagnostic.category);
    if (!grouped.has(owner)) grouped.set(owner, []);
    grouped.get(owner).push({ ...diagnostic, owner, nextAction: diagnostic.nextAction ?? 'repair this deterministic gate failure and rerun github-review-prepare' });
  }
  return Object.fromEntries([...grouped].map(([owner, diagnostics]) => [owner, diagnostics]));
}

export function runGitHubReviewPrepare({ pr, workspace, packet: packetPath, ...options } = {}) {
  if (packetPath) return verifyReviewPacket({ pr, packet: packetPath, ...options });
  const loaded = loadPreflightInput({ pr, ...options, includeBasePaths: true });
  const result = evaluatePreparationInput(loaded.input, evaluatePreflight, { referenceResolvers: loaded.referenceResolvers });
  // The exact head is resolved from the complete current PR state immediately
  // before packet creation and stamped on every result.
  const head = String(loaded.input.prData.headRefOid ?? '').toLowerCase();
  const workspaceResult = workspace
    ? validateReviewWorkspace({ workspace, expectedArtifact: head })
    : { provided: false, valid: true, workspace: null, head: null };
  const workspaceDiagnostics = workspaceResult.error
    ? [{ message: workspaceResult.error, category: 'workspace', owner: 'engineer', nextAction: 'repair the workspace so it matches the exact review head before dispatch' }]
    : [];
  if (!result.ok || workspaceResult.error) {
    const errors = [...(result.errors ?? []), ...workspaceDiagnostics.map(d => d.message)];
    const routed = routeDiagnostics(result);
    // Workspace failures are part of structured diagnostics and owner routing,
    // never silently dropped.
    if (workspaceDiagnostics.length) {
      const existing = routed.engineer ?? [];
      routed.engineer = [...existing, ...workspaceDiagnostics];
    }
    return {
      schemaVersion: 1, ok: false, pr: loaded.input.prData.number, issue: loaded.input.issueData.number,
      headRefOid: head, errors, warnings: result.warnings ?? [], diagnostics: [...(result.diagnostics ?? []), ...workspaceDiagnostics],
      ownerRouting: routed, packet: null,
      firstSafeRepair: workspaceDiagnostics[0]?.nextAction ?? result.firstSafeRepair ?? 'repair the deterministic gate failures before any Maintainer dispatch',
    };
  }
  const independence = taskRequiresIndependentReview(loaded.input.issueData.body);
  if (independence.errors?.length) {
    return {
      schemaVersion: 1, ok: false, pr: loaded.input.prData.number, issue: loaded.input.issueData.number,
      headRefOid: head, errors: independence.errors, warnings: result.warnings ?? [],
      diagnostics: independence.errors.map(message => ({ message, category: 'task_policy', owner: 'maintainer' })),
      ownerRouting: { maintainer: independence.errors.map(message => ({ message, category: 'task_policy', owner: 'maintainer' })) }, packet: null,
      firstSafeRepair: 'Maintainer must repair the independent-review task contract before review dispatch.',
    };
  }
  // Immediately before packet emission, refetch the current PR head through
  // the same read-only command runner. A head that moved during preparation
  // invalidates the evaluation: emit no packet, only a stale-head diagnostic.
  const commandRunner = options.commandRunner ?? defaultGhCommandRunner;
  const freshHead = refetchCurrentHead(commandRunner, loaded.input.prData.number, options.repo);
  const freshness = validateHeadFreshness(head, freshHead);
  if (!freshness.valid) {
    const diagnostic = {
      message: freshness.stale
        ? `evaluated head ${head} differs from the current PR head ${freshHead}; the preparation is stale and no packet is emitted`
        : `cannot confirm packet freshness: ${freshness.reason}`,
      category: 'stale_head', owner: 'orchestrator', nextAction: 'rerun github-review-prepare against the current head before any Maintainer dispatch',
    };
    return {
      schemaVersion: 1, ok: false, pr: loaded.input.prData.number, issue: loaded.input.issueData.number,
      headRefOid: head, errors: [diagnostic.message], warnings: result.warnings ?? [],
      diagnostics: [diagnostic], ownerRouting: { orchestrator: [diagnostic] }, packet: null,
      firstSafeRepair: diagnostic.nextAction,
    };
  }
  const prior = [...loaded.input.reviewHistory.events].reverse().find(event => event.type === 'outcome' && event.status === 'needs_revision');
  const packet = {
    type: REVIEW_PACKET_TYPE, schemaVersion: REVIEW_PACKET_SCHEMA_VERSION,
    pr: loaded.input.prData.number, task: loaded.input.issueData.number, headRefOid: head,
    reviewMode: independence.value ? 'independent_human' : 'host_subagent',
    independentReviewRequired: Boolean(independence.value),
    workspace: workspaceResult.provided ? { path: workspaceResult.workspace, head: workspaceResult.head, verified: true } : null,
    currentFindingIds: prior?.findingIds ?? [],
    preflight: { ok: true, digest: { requiredChecks: result.requiredChecks.length, evidenceMatches: result.evidenceMatches.length, headRefOid: head } },
    lease: 'Review this exact head read-only. Do not mutate the branch, PR body, comments, task contract, or GitHub state while reviewing. A head change invalidates this packet.',
  };
  return {
    schemaVersion: 1, ok: true, pr: packet.pr, issue: packet.task, headRefOid: head,
    errors: [], warnings: result.warnings ?? [], diagnostics: result.warningDiagnostics ?? [], ownerRouting: {}, packet,
    firstSafeRepair: null,
  };
}

/**
 * Mechanical consumer-side packet validation. Advisory lease prose alone is
 * insufficient: if the PR head differs from the head stamped on the packet, the
 * packet is stale and must be rejected before review dispatch.
 */
export function validateReviewPacket(packet, currentHead, options = {}) {
  const shape = validateReviewPacketShape(packet, options.expectedPr);
  if (!shape.valid) return shape;
  return validateHeadFreshness(shape.stampedHead, currentHead);
}

/**
 * Consumer-side packet verification used before review dispatch. Reads a
 * previously emitted preparation packet from a local file, refetches the
 * current PR head read-only, and rejects stale, missing, malformed, or
 * mismatched packets. It never writes GitHub or local state.
 */
export function verifyReviewPacket({ pr, packet, commandRunner = defaultGhCommandRunner, repo } = {}) {
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
  if (parseError) {
    const diagnostic = { message: `review packet is not readable JSON: ${parseError}`, category: 'review_packet', owner: 'orchestrator', nextAction: 'regenerate the packet with github-review-prepare before dispatch' };
    return {
      schemaVersion: 1, ok: false, pr: prNumber, headRefOid: null,
      errors: [diagnostic.message], warnings: [], diagnostics: [diagnostic],
      ownerRouting: { orchestrator: [diagnostic] },
      packetCheck: { valid: false, stale: false, reason: 'packet is malformed' },
      packet: null, firstSafeRepair: diagnostic.nextAction,
    };
  }
  const shape = validateReviewPacketShape(parsed, prNumber);
  if (!shape.valid) {
    const diagnostic = { message: `review packet rejected before dispatch: ${shape.reason}`, category: 'review_packet', owner: 'orchestrator', nextAction: 'regenerate the packet with github-review-prepare before dispatch' };
    return {
      schemaVersion: 1, ok: false, pr: prNumber, headRefOid: null,
      errors: [diagnostic.message], warnings: [], diagnostics: [diagnostic],
      ownerRouting: { orchestrator: [diagnostic] },
      packetCheck: shape, packet: null, firstSafeRepair: diagnostic.nextAction,
    };
  }
  const currentHead = refetchCurrentHead(commandRunner, prNumber, repo);
  const check = validateReviewPacket(parsed, currentHead, { expectedPr: prNumber });
  const diagnostics = [];
  if (!check.valid) {
    diagnostics.push({
      message: `review packet rejected before dispatch: ${check.reason}`,
      category: 'stale_head', owner: 'orchestrator', nextAction: 'regenerate the packet with github-review-prepare before dispatch',
    });
  }
  const ok = diagnostics.length === 0;
  return {
    schemaVersion: 1, ok, pr: prNumber, headRefOid: currentHead,
    errors: diagnostics.map(item => item.message), warnings: [], diagnostics,
    ownerRouting: ok ? {} : { orchestrator: diagnostics },
    packetCheck: check, packet: ok ? parsed : null,
    firstSafeRepair: ok ? null : diagnostics[0].nextAction,
  };
}
