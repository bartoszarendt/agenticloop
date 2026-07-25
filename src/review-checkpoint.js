/**
 * Backend-neutral Review Round Checkpoint parsing and authorization.
 *
 * A checkpoint binds a counted `needs_revision` outcome on artifact A and
 * authorizes exactly the following implementation revision to artifact B. It
 * never asserts that A and B are the same artifact.
 */

import { markdownLines, markdownSection } from './markdown.js';
import { DEFAULT_ATTEMPT_BUDGET, DEFAULT_REVIEW_BUDGET } from './layout.js';
import { parseFrontmatter } from './frontmatter.js';
import { resolveProjectAttemptBudget } from './project-map.js';

// Compatibility re-export: layout.js is the single canonical owner.
export { DEFAULT_ATTEMPT_BUDGET, DEFAULT_REVIEW_BUDGET } from './layout.js';
export const VALID_DIRECTIONS = new Set(['targeted_revision', 'needs_context', 'blocked']);
export const VALID_CHECKPOINT_CAUSES = new Set([
  'implementation_defect',
  'evidence_drift',
  'task_contract_ambiguity',
  'scope_pollution',
  'reviewer_engineer_disagreement',
  'external_blocker',
]);

/** Parse a positive safe-integer task budget shared by both task backends. */
export function parseTaskBudgetValue(value, field, fallback) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^[1-9]\d*$/.test(text)) {
    return { budget: fallback, error: `${field} '${String(value ?? '')}' must be a positive integer` };
  }
  const budget = Number(text);
  return Number.isSafeInteger(budget)
    ? { budget, error: null }
    : { budget: fallback, error: `${field} '${text}' is outside the supported integer range` };
}

/** Count top-level frontmatter fields without matching examples in the body. */
export function countTaskBudgetFieldOccurrences(content, field) {
  const block = String(content ?? '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] ?? '';
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`^${escapedField}[ \t]*:`, 'gm'))?.length ?? 0;
}

/** Parse the scalar review_budget value shared by both task backends. */
export function parseReviewBudgetValue(value) {
  return parseTaskBudgetValue(value, 'review_budget', DEFAULT_REVIEW_BUDGET);
}

/** Parse the scalar attempt_budget value shared by both task backends. */
export function parseAttemptBudgetValue(value) {
  return parseTaskBudgetValue(value, 'attempt_budget', DEFAULT_ATTEMPT_BUDGET);
}

/**
 * Resolve a task's equivalent-attempt budget without rewriting legacy records.
 * A stored task value is authoritative; only a missing field consults project
 * policy and then the built-in default.
 */
export function resolveTaskAttemptBudget(content, projectMapConfig = null) {
  const raw = String(content ?? '');
  const [frontmatter] = parseFrontmatter(raw);
  const projectBudget = resolveProjectAttemptBudget(projectMapConfig);
  const occurrences = countTaskBudgetFieldOccurrences(raw, 'attempt_budget');
  if (occurrences > 1) {
    return {
      budget: projectBudget.budget,
      error: 'attempt_budget appears more than once in frontmatter (duplicate field)',
    };
  }
  if (!frontmatter || !Object.hasOwn(frontmatter, 'attempt_budget')) {
    return projectBudget;
  }
  return parseAttemptBudgetValue(frontmatter.attempt_budget);
}

function fieldsFromLiveLines(body) {
  const fields = {};
  const errors = [];
  for (const line of markdownLines(body)) {
    if (!line.live) continue;
    const match = line.raw.match(/^\s*[-*]\s*([\w][\w\s]*?):\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (Object.hasOwn(fields, key)) errors.push(`duplicate checkpoint field '${match[1].trim()}'`);
    fields[key] = match[2].trim();
  }
  return { fields, errors };
}

/** @param {string} artifact */
function githubArtifactError(artifact) {
  return /^[0-9a-f]{40}$/i.test(artifact)
    ? null
    : `checkpoint artifact '${artifact}' is not a full 40-character SHA`;
}

/** @param {string} artifact */
function filesArtifactError(artifact) {
  return artifact && !/\s/.test(artifact)
    ? null
    : `checkpoint artifact '${artifact}' is not a canonical files implementation_artifact reference`;
}

/**
 * Parse one checkpoint carrier. GitHub requires its HTML marker and a full SHA;
 * files records use a `### Review Round Checkpoint` entry in `## Review History`
 * and bind the same semantic fields to the files implementation artifact form.
 *
 * @param {string} text
 * @param {{ carrier?: 'github'|'files', artifactValidator?: (artifact: string) => string|null }} [options]
 * @returns {{ found: boolean, checkpoint: object|null, errors: string[] }}
 */
export function parseReviewCheckpoint(text, options = {}) {
  const raw = String(text ?? '');
  const carrier = options.carrier ?? 'github';
  const markerPresent = markdownLines(raw).some(line =>
    line.live && /<!--\s*AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT\s*-->/.test(line.raw)
  );
  const section = markdownSection(raw, '## Review Round Checkpoint') ??
    markdownSection(raw, '### Review Round Checkpoint');
  const found = markerPresent || section !== null;
  if (!found) return { found: false, checkpoint: null, errors: [] };

  const errors = [];
  if (carrier === 'github' && !markerPresent) {
    errors.push('GitHub checkpoint is missing the AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT marker');
  }
  if (!section) {
    errors.push('checkpoint marker is missing the Review Round Checkpoint section');
  }

  const parsed = fieldsFromLiveLines(section?.body ?? '');
  errors.push(...parsed.errors);
  const fields = parsed.fields;
  const direction = fields.direction?.toLowerCase() ?? null;
  const cause = fields.cause?.toLowerCase() ?? fields.canonical_cause?.toLowerCase() ?? null;
  const reviewCountRaw = fields.review_count ?? fields.review_round ?? fields.round ?? null;
  const artifact = fields.artifact ?? fields.latest_reviewed_artifact ?? null;
  const target = fields.target ?? fields.exact_target ?? null;
  const reference = fields.reference ?? fields.maintainer_reference ?? null;
  const orchestratorAttribution = fields.orchestrator ?? fields.orchestrator_attribution ?? null;

  let reviewCount = null;
  if (!direction) errors.push('checkpoint is missing required field "direction"');
  else if (!VALID_DIRECTIONS.has(direction)) errors.push(`checkpoint direction '${direction}' is not valid`);

  if (!cause) errors.push('checkpoint is missing required field "cause"');
  else if (!VALID_CHECKPOINT_CAUSES.has(cause)) {
    errors.push(`checkpoint cause '${cause}' is not valid; expected one of: ${[...VALID_CHECKPOINT_CAUSES].join(', ')}`);
  }

  if (!reviewCountRaw) {
    errors.push('checkpoint is missing required field "review_count"');
  } else {
    reviewCount = Number(reviewCountRaw);
    if (!Number.isInteger(reviewCount) || reviewCount < 1) {
      errors.push(`checkpoint review_count '${reviewCountRaw}' is not a positive integer`);
    }
  }

  if (!artifact) {
    errors.push('checkpoint is missing required field "artifact"');
  } else {
    const artifactError = (options.artifactValidator ?? (carrier === 'github' ? githubArtifactError : filesArtifactError))(artifact);
    if (artifactError) errors.push(artifactError);
  }

  if (direction === 'targeted_revision' && !target) {
    errors.push('checkpoint with direction "targeted_revision" requires a "target" field');
  }
  if ((direction === 'needs_context' || direction === 'blocked') && !reference) {
    errors.push(`checkpoint with direction "${direction}" requires a "reference" field`);
  }
  if (!orchestratorAttribution) {
    errors.push('checkpoint is missing required field "orchestrator"');
  }

  return {
    found: true,
    checkpoint: {
      type: 'checkpoint',
      direction,
      cause,
      reviewCount,
      artifact: artifact?.toLowerCase() ?? null,
      target: target || null,
      reference: reference || null,
      orchestratorAttribution: orchestratorAttribution || null,
      carrier,
      raw,
    },
    errors,
  };
}

/** @param {Array<{ status?: string }>} reviewOutcomes */
export function countNeedsRevisionRounds(reviewOutcomes) {
  return Array.isArray(reviewOutcomes)
    ? reviewOutcomes.filter(outcome => outcome?.status === 'needs_revision').length
    : 0;
}

/** @param {unknown} value */
function artifactKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Validate a checkpoint object before it is written or evaluated. The default
 * artifact validator follows the GitHub projection; files callers pass their
 * implementation-artifact validator through parseReviewCheckpoint.
 *
 * @param {object} checkpoint
 * @param {{ artifactValidator?: (artifact: string) => string|null }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCheckpointSchema(checkpoint, options = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { valid: false, errors: ['checkpoint is not an object'] };
  }
  const errors = [];
  const direction = String(checkpoint.direction ?? '');
  const cause = String(checkpoint.cause ?? '');
  if (!VALID_DIRECTIONS.has(direction)) errors.push(`checkpoint direction '${direction}' is not valid`);
  if (!VALID_CHECKPOINT_CAUSES.has(cause)) errors.push(`checkpoint cause '${cause}' is not valid`);
  if (!Number.isInteger(checkpoint.reviewCount) || checkpoint.reviewCount < 1) {
    errors.push(`checkpoint review_count must be a positive integer, got ${checkpoint.reviewCount}`);
  }
  const artifact = String(checkpoint.artifact ?? '');
  const artifactError = (options.artifactValidator ?? githubArtifactError)(artifact);
  if (artifactError) errors.push(artifactError);
  if (direction === 'targeted_revision' && !checkpoint.target) {
    errors.push('checkpoint with direction "targeted_revision" requires a target');
  }
  if ((direction === 'needs_context' || direction === 'blocked') && !checkpoint.reference) {
    errors.push(`checkpoint with direction "${direction}" requires a reference`);
  }
  if (!checkpoint.orchestratorAttribution) errors.push('checkpoint is missing required field: orchestrator');
  return { valid: errors.length === 0, errors };
}

/**
 * Evaluate a durable ordered history. A `currentArtifact` equal to the last
 * reviewed artifact is a same-artifact re-review and does not consume a new
 * revision authorization. A distinct artifact requires a checkpoint only at
 * the configured review-budget boundary.
 *
 * @param {{
 *   reviewHistory?: Array<object>, reviewOutcomes?: Array<object>, checkpoint?: object|null,
 *   budget?: number, currentArtifact?: string, requireRevision?: boolean
 * }} params
 * @returns {{ authorized: boolean, errors: string[], warnings: string[] }}
 */
export function evaluateReviewCheckpoint({
  reviewHistory,
  reviewOutcomes = [],
  checkpoint = null,
  budget = DEFAULT_REVIEW_BUDGET,
  currentArtifact = '',
  requireRevision = false,
} = {}) {
  const errors = [];
  const warnings = [];
  if (!Number.isSafeInteger(budget) || budget < 1) {
    return { authorized: false, errors: [`review_budget must be a positive integer, got ${budget}`], warnings };
  }

  const base = Array.isArray(reviewHistory)
    ? reviewHistory
    : [
      ...reviewOutcomes.map(outcome => ({ ...outcome, type: 'outcome' })),
      ...(checkpoint ? [{
        ...checkpoint,
        type: 'checkpoint',
        // Legacy helper callers provide outcomes as an array and a checkpoint
        // separately. Its declared review count is the durable insertion point.
        sourceOrder: checkpoint.sourceOrder ?? Number(checkpoint.reviewCount) - 0.5,
      }] : []),
    ];
  const history = base
    .map((event, index) => ({ ...event, sourceOrder: Number.isFinite(event?.sourceOrder) ? event.sourceOrder : index }))
    .sort((left, right) => left.sourceOrder - right.sourceOrder);
  const outcomes = history.filter(event => event.type === 'outcome' &&
    (event.status === 'needs_revision' || event.status === 'accepted'));
  const needsRevision = outcomes.filter(event => event.status === 'needs_revision');
  const latestOutcome = outcomes.at(-1) ?? null;

  // No implementation change is being authorized for a record-only re-review
  // or a terminal accepted artifact.
  if (!requireRevision && latestOutcome && currentArtifact && artifactKey(latestOutcome.artifact) === artifactKey(currentArtifact)) {
    return { authorized: true, errors, warnings };
  }
  if (needsRevision.length < budget) {
    if (checkpointsPresent(history)) warnings.push('checkpoint present but review rounds are within budget; checkpoint is not required');
    return { authorized: true, errors, warnings };
  }

  const checkpoints = history.filter(event => event.type === 'checkpoint');
  const latestCheckpoint = checkpoints.at(-1) ?? null;
  if (!latestCheckpoint) {
    errors.push(
      `review round budget (${budget}) exhausted (${needsRevision.length} needs_revision outcomes); ` +
      'a Review Round Checkpoint is required before the next revision'
    );
    return { authorized: false, errors, warnings };
  }

  const schema = validateCheckpointSchema(latestCheckpoint, {
    artifactValidator: latestCheckpoint.carrier === 'files' ? filesArtifactError : githubArtifactError,
  });
  errors.push(...schema.errors);
  if (!schema.valid) return { authorized: false, errors, warnings };
  if (latestCheckpoint.direction !== 'targeted_revision') {
    errors.push(
      `checkpoint direction is '${latestCheckpoint.direction}'; only 'targeted_revision' authorizes another implementation attempt`
    );
    return { authorized: false, errors, warnings };
  }

  const precedingNeedsRevision = needsRevision.filter(event => event.sourceOrder < latestCheckpoint.sourceOrder);
  const precedingLatest = precedingNeedsRevision.at(-1) ?? null;
  if (!precedingLatest) {
    errors.push('checkpoint occurs before any counted needs_revision review outcome');
  } else {
    if (latestCheckpoint.reviewCount !== precedingNeedsRevision.length) {
      errors.push(
        `checkpoint review_count (${latestCheckpoint.reviewCount}) does not match the needs_revision count at the checkpoint (${precedingNeedsRevision.length})`
      );
    }
    if (artifactKey(latestCheckpoint.artifact) !== artifactKey(precedingLatest.artifact)) {
      errors.push(
        `checkpoint artifact (${String(latestCheckpoint.artifact).slice(0, 8)}...) does not match the latest reviewed artifact (${String(precedingLatest.artifact).slice(0, 8)}...)`
      );
    }
  }

  const laterOutcome = outcomes.find(event => event.sourceOrder > latestCheckpoint.sourceOrder);
  if (laterOutcome) {
    const ambiguousGitHubOrder =
      Number.isFinite(latestCheckpoint.sourceTimestamp) &&
      latestCheckpoint.sourceTimestamp === laterOutcome.sourceTimestamp &&
      latestCheckpoint.sourceKind &&
      laterOutcome.sourceKind &&
      latestCheckpoint.sourceKind !== laterOutcome.sourceKind;
    errors.push(ambiguousGitHubOrder
      ? 'checkpoint and review outcome share an ambiguous GitHub timestamp across carrier types; the checkpoint is treated as consumed and a fresh checkpoint is required'
      : 'checkpoint has been consumed by a subsequent review outcome; a new checkpoint is required');
  }
  return { authorized: errors.length === 0, errors, warnings };
}

/** @param {Array<object>} history */
function checkpointsPresent(history) {
  return history.some(event => event.type === 'checkpoint');
}

/**
 * Format one semantic checkpoint in the carrier selected by the caller.
 *
 * @param {object} checkpoint
 * @param {{ carrier?: 'github'|'files', headingLevel?: 2|3 }} [options]
 */
export function formatCheckpoint(checkpoint, options = {}) {
  const carrier = options.carrier ?? 'github';
  const heading = '#'.repeat(options.headingLevel ?? (carrier === 'files' ? 3 : 2));
  const lines = [
    ...(carrier === 'github' ? ['<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->', ''] : []),
    `${heading} Review Round Checkpoint`,
    '',
    `- Direction: ${checkpoint.direction}`,
    `- Cause: ${checkpoint.cause}`,
    `- Review count: ${checkpoint.reviewCount}`,
    `- Artifact: ${checkpoint.artifact}`,
  ];
  if (checkpoint.target) lines.push(`- Target: ${checkpoint.target}`);
  if (checkpoint.reference) lines.push(`- Reference: ${checkpoint.reference}`);
  if (checkpoint.orchestratorAttribution) lines.push(`- Orchestrator: ${checkpoint.orchestratorAttribution}`);
  if (carrier === 'github') lines.push('', '[[agent: orchestrator]]');
  lines.push('');
  return lines.join('\n');
}
