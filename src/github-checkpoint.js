/** Read-only GitHub checkpoint rendering and bounded repair planning. */

import { loadPreflightInput } from './github-preflight.js';
import { applyCheckpointRepairs, deriveCheckpointState, formatCheckpoint, formatCheckpointRepair, parseReviewCheckpoint, validateCheckpointSchema } from './review-checkpoint.js';

export class GitHubCheckpointError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubCheckpointError';
  }
}

function latestNeedsRevision(events) {
  return [...events].filter(event => event.type === 'outcome' && event.status === 'needs_revision').at(-1) ?? null;
}

export function renderGitHubCheckpoint({ pr, direction, cause, target, reference, ...options } = {}) {
  const loaded = loadPreflightInput({ pr, ...options, includeBasePaths: true });
  const { reviewHistory, expectedAccount } = loaded.input;
  // The renderer must reject durable-history errors before printing a carrier.
  if (reviewHistory.errors?.length) {
    throw new GitHubCheckpointError(`durable review history has errors; resolve them before rendering a checkpoint: ${reviewHistory.errors.join('; ')}`);
  }
  const outcomes = reviewHistory.events.filter(event => event.type === 'outcome' && event.status === 'needs_revision');
  const latest = latestNeedsRevision(reviewHistory.events);
  if (!latest) throw new GitHubCheckpointError('no durable needs_revision outcome exists; a checkpoint cannot be rendered');
  if (!direction || !cause) throw new GitHubCheckpointError('checkpoint direction and cause are required; the renderer will not infer authority-bearing intent');
  if (direction === 'targeted_revision' && !target) throw new GitHubCheckpointError('targeted_revision checkpoint requires --target');
  if ((direction === 'needs_context' || direction === 'blocked') && !reference) throw new GitHubCheckpointError(`${direction} checkpoint requires --reference`);
  const checkpoint = {
    direction,
    cause,
    reviewCount: outcomes.length,
    artifact: latest.artifact,
    target: target ?? null,
    reference: reference ?? null,
    orchestratorAttribution: expectedAccount.login,
  };
  // Validate the final checkpoint schema before printing a carrier.
  const schema = validateCheckpointSchema(checkpoint);
  if (!schema.valid) throw new GitHubCheckpointError(`checkpoint is invalid: ${schema.errors.join('; ')}`);
  // Derive state including the newly rendered (not yet durable) carrier rather
  // than only the old history.
  const checkpointState = deriveCheckpointState(reviewHistory.events, reviewHistory.errors ?? [], { proposed: checkpoint });
  return {
    schemaVersion: 1,
    ok: true,
    errors: [], warnings: [], diagnostics: [],
    pr: loaded.input.prData.number,
    headRefOid: loaded.input.prData.headRefOid,
    checkpoint,
    checkpointState,
    carrier: formatCheckpoint(checkpoint),
  };
}

function sourceFromInput(input, source) {
  const all = [...input.prData.comments, ...input.prData.reviews];
  return all.find(item => String(item?.id ?? item?.url ?? item?.html_url ?? '') === String(source)) ?? null;
}

export function planGitHubCheckpointRepair({ pr, source, ...options } = {}) {
  if (!source) throw new GitHubCheckpointError('--source <comment-or-review-id> is required');
  const loaded = loadPreflightInput({ pr, ...options, includeBasePaths: true });
  const { reviewHistory, expectedAccount } = loaded.input;
  const rawSource = sourceFromInput(loaded.input, source);
  if (!rawSource) throw new GitHubCheckpointError(`checkpoint source '${source}' was not found in ordered PR history`);
  const parsed = parseReviewCheckpoint(rawSource.body, { carrier: 'github' });
  const sourceAuthor = String(rawSource.user?.login ?? rawSource.author?.login ?? '').toLowerCase();
  const expectedLogin = String(expectedAccount.login).toLowerCase();
  // A wrong-but-repairable authenticated attribution is an eligible malformed
  // candidate: the parse succeeds, but the declared attribution is not the
  // authenticated author and one bounded same-author repair may correct it.
  const wrongAttribution = parsed.found && parsed.errors.length === 0 &&
    Boolean(parsed.checkpoint?.orchestratorAttribution) &&
    String(parsed.checkpoint.orchestratorAttribution).toLowerCase() !== sourceAuthor;
  if (!parsed.found || (parsed.errors.length === 0 && !wrongAttribution)) {
    throw new GitHubCheckpointError(`source '${source}' is not a malformed checkpoint eligible for repair`);
  }
  if (!sourceAuthor || sourceAuthor !== expectedLogin) {
    throw new GitHubCheckpointError('only the original authenticated Orchestrator may repair this checkpoint');
  }
  const historyEvents = reviewHistory.events;
  const candidateTimestamp = Date.parse(rawSource.created_at ?? rawSource.submitted_at ?? '');
  const sourceOrder = historyEvents.filter(event =>
    Number.isFinite(event.sourceTimestamp) && Number.isFinite(candidateTimestamp) && event.sourceTimestamp < candidateTimestamp
  ).length;
  const outcomesBefore = historyEvents.filter(event =>
    event.type === 'outcome' && event.status === 'needs_revision' && (event.sourceOrder ?? 0) < sourceOrder
  );
  const latestBefore = outcomesBefore.at(-1) ?? null;
  const partial = parsed.checkpoint ?? {};
  if (!latestBefore || !partial.direction || !partial.cause || (partial.direction === 'targeted_revision' && !partial.target) || ((partial.direction === 'needs_context' || partial.direction === 'blocked') && !partial.reference)) {
    throw new GitHubCheckpointError('source has ambiguous direction, cause, target, or reference; this authority-bearing defect is not repairable');
  }
  const correctedFields = [];
  if (String(partial.orchestratorAttribution ?? '').toLowerCase() !== sourceAuthor) correctedFields.push('orchestrator');
  if (!Number.isInteger(partial.reviewCount)) correctedFields.push('review_count');
  if (!partial.artifact) correctedFields.push('artifact');
  if (correctedFields.length === 0) throw new GitHubCheckpointError('source defect is not a bounded syntax or attribution repair');
  const checkpoint = {
    ...partial,
    reviewCount: Number.isInteger(partial.reviewCount) ? partial.reviewCount : outcomesBefore.length,
    artifact: partial.artifact || latestBefore.artifact,
    orchestratorAttribution: expectedAccount.login,
  };
  const candidate = {
    type: 'checkpoint_candidate',
    sourceOrder,
    sourceReference: String(rawSource.id ?? source),
    sourceKind: rawSource.submitted_at && !rawSource.created_at ? 'review' : 'comment',
    author: { login: sourceAuthor },
    errors: parsed.errors.length
      ? parsed.errors
      : [`checkpoint Orchestrator attribution '${partial.orchestratorAttribution}' does not match its authenticated author`],
    checkpoint: partial,
  };
  const maxOrder = Math.max(candidate.sourceOrder, ...historyEvents.map(event => event.sourceOrder ?? 0), 0);
  const repairEvent = {
    type: 'checkpoint_repair',
    sourceOrder: maxOrder + 1,
    sourceReference: '(planned repair)',
    source: candidate.sourceReference,
    originalAuthor: sourceAuthor,
    correctedFields,
    author: { login: sourceAuthor },
    checkpoint,
  };
  // The planner must never emit a carrier that application would reject:
  // simulate the proposed repair against ordered durable history through the
  // one shared pure repair-application function and refuse unless it succeeds.
  const simulation = applyCheckpointRepairs([...historyEvents, candidate, repairEvent]);
  const applied = simulation.events.find(event => event.type === 'checkpoint' && event.repairedBy === '(planned repair)');
  if (!applied || simulation.errors.length > 0) {
    throw new GitHubCheckpointError(`the proposed repair cannot be applied to ordered history; no carrier is emitted: ${simulation.errors.join('; ') || 'source is not repairable'}`);
  }
  const repair = {
    source: candidate.sourceReference, originalAuthor: sourceAuthor,
    reason: 'fill only fields mechanically derivable from authenticated ordered history',
    correctedFields, checkpoint,
  };
  return {
    schemaVersion: 1, ok: true, errors: [], warnings: [], diagnostics: [],
    pr: loaded.input.prData.number, source: candidate.sourceReference, repair,
    carrier: formatCheckpointRepair(repair),
    firstSafeRepair: 'Post this exact append-only repair carrier as the same authenticated Orchestrator; do not edit or delete the source.',
  };
}
