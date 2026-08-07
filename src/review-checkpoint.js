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
import {
  normalizeReviewRoleCarrier,
  renderReviewRoleCarrier,
  REVIEW_ROLE_CARRIER_SCHEMA_VERSION,
} from './review-role-carrier.js';
import { isGitObjectId } from './git-oid.js';

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
export const VALID_NO_PROGRESS_DISPOSITIONS = new Set(['targeted_revision', 'split_task', 'contract_decision', 'blocked']);
/**
 * Mechanically repairable checkpoint fields.
 *
 * A field is repairable only when its correct value is derivable from
 * authenticated ordered history or fixed by an immutable contract:
 *   - `review_count` and `artifact` derive from the ordered durable history;
 *   - `actor_account` derives from the authenticated GitHub author of the
 *     repaired source, and is *not* derivable for files-backed history, which
 *     has no authenticated source - those carriers must be reissued;
 *   - `role_id` is fixed by the carrier type's immutable role contract;
 *   - `review_role_carrier` is fixed by the one supported carrier version.
 * Everything else - direction, cause, target, reference - carries authority and
 * requires reissuance rather than repair.
 *
 * `orchestrator` is the legacy spelling of `actor_account` and stays parseable
 * for existing history; newly emitted repairs use the canonical versioned name.
 */
export const CANONICAL_REPAIRABLE_CHECKPOINT_FIELDS = Object.freeze([
  'review_count', 'artifact', 'actor_account', 'role_id', 'review_role_carrier',
]);
const LEGACY_REPAIRABLE_FIELD_ALIASES = Object.freeze({ orchestrator: 'actor_account' });
const REPAIRABLE_CHECKPOINT_FIELDS = new Set([
  ...CANONICAL_REPAIRABLE_CHECKPOINT_FIELDS,
  ...Object.keys(LEGACY_REPAIRABLE_FIELD_ALIASES),
]);

/** Normalize a declared corrected-field name onto its canonical spelling. */
function canonicalRepairFieldName(field) {
  return LEGACY_REPAIRABLE_FIELD_ALIASES[field] ?? field;
}

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
  return isGitObjectId(artifact)
    ? null
    : `checkpoint artifact '${artifact}' is not a complete Git object identity`;
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

  const parsed = fieldsFromLiveLines((section?.lines ?? []).map(line => line.raw).join('\n'));
  errors.push(...parsed.errors);
  const fields = parsed.fields;
  const direction = fields.direction?.toLowerCase() ?? null;
  const cause = fields.cause?.toLowerCase() ?? fields.canonical_cause?.toLowerCase() ?? null;
  const reviewCountRaw = fields.review_count ?? fields.review_round ?? fields.round ?? null;
  const artifact = fields.artifact ?? fields.latest_reviewed_artifact ?? null;
  const target = fields.target ?? fields.exact_target ?? null;
  const reference = fields.reference ?? fields.maintainer_reference ?? null;
  const role = normalizeReviewRoleCarrier(fields, {
    expectedRoleId: 'orchestrator', legacyField: 'orchestrator',
    legacyActorAccount: options.authenticatedActorAccount,
    allowUntrustedLegacyParse: carrier === 'github' && !options.authenticatedActorAccount,
    label: 'checkpoint',
  });
  errors.push(...role.errors);
  const orchestratorAttribution = role.actorAccount;

  let reviewCount = null;
  if (!direction) errors.push('checkpoint is missing required field "direction"');
  else if (!VALID_DIRECTIONS.has(direction)) {
    errors.push(`checkpoint direction '${direction}' is not valid; expected one of: ${[...VALID_DIRECTIONS].join(', ')}`);
  }

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
  if (!orchestratorAttribution) errors.push('checkpoint is missing required actor account');

  return {
    found: true,
    checkpoint: {
      type: 'checkpoint',
      direction,
      cause,
      reviewCount,
      artifact: carrier === 'github' ? artifact ?? null : artifact ?? null,
      target: target || null,
      reference: reference || null,
      orchestratorAttribution: orchestratorAttribution || null,
      roleId: role.roleId,
      roleCarrierSchemaVersion: role.schemaVersion,
      carrier,
      raw,
    },
    errors,
  };
}

/** Parse the distinct append-only repair carrier; it is never a checkpoint. */
export function parseCheckpointRepair(text, options = {}) {
  const raw = String(text ?? '');
  const carrier = options.carrier ?? 'github';
  const marker = markdownLines(raw).some(line => line.live && /<!--\s*AGENTIC_LOOP_REVIEW_CHECKPOINT_REPAIR\s*-->/.test(line.raw));
  const section = markdownSection(raw, '## Review Round Checkpoint Repair') ?? markdownSection(raw, '### Review Round Checkpoint Repair');
  if (!marker && !section) return { found: false, repair: null, errors: [] };
  const errors = [];
  if (carrier === 'github' && !marker) errors.push('GitHub checkpoint repair is missing the AGENTIC_LOOP_REVIEW_CHECKPOINT_REPAIR marker');
  if (!section) errors.push('checkpoint repair marker is missing the Review Round Checkpoint Repair section');
  const { fields, errors: fieldErrors } = fieldsFromLiveLines((section?.lines ?? []).map(line => line.raw).join('\n'));
  errors.push(...fieldErrors);
  const source = fields.source ?? '';
  const originalAuthor = fields.original_author ?? '';
  const reason = fields.reason ?? '';
  const declaredFields = String(fields.corrected_fields ?? '').split(',').map(value => value.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  const correctedFields = declaredFields.map(canonicalRepairFieldName);
  const role = normalizeReviewRoleCarrier(fields, {
    expectedRoleId: 'orchestrator', legacyField: 'orchestrator',
    legacyActorAccount: options.authenticatedActorAccount,
    allowUntrustedLegacyParse: carrier === 'github' && !options.authenticatedActorAccount,
    label: 'checkpoint repair',
  });
  errors.push(...role.errors);
  const orchestrator = role.actorAccount ?? '';
  if (!source) errors.push('checkpoint repair is missing required field "source"');
  if (!originalAuthor) errors.push('checkpoint repair is missing required field "original_author"');
  if (!reason) errors.push('checkpoint repair is missing required field "reason"');
  if (declaredFields.length === 0) errors.push('checkpoint repair is missing required field "corrected_fields"');
  if (new Set(correctedFields).size !== correctedFields.length) {
    errors.push('checkpoint repair corrected_fields must not contain duplicate or aliased duplicate fields');
  }
  for (const field of declaredFields) {
    if (!REPAIRABLE_CHECKPOINT_FIELDS.has(field)) errors.push(`checkpoint repair field '${field}' is not mechanically repairable`);
  }
  if (!orchestrator) errors.push('checkpoint repair is missing required actor account');
  const checkpointText = [
    ...(carrier === 'github' ? ['<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->', ''] : []),
    '## Review Round Checkpoint', '',
    ...['direction', 'cause', 'review_count', 'artifact', 'target', 'reference', 'review_role_carrier', 'role_id', 'actor_account', 'orchestrator']
      .filter(key => fields[key])
      .map(key => `- ${key.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())}: ${fields[key]}`),
  ].join('\n');
  const checkpoint = parseReviewCheckpoint(checkpointText, { carrier });
  // The repair must carry a full replacement checkpoint even when the named
  // source omitted a mechanically derivable field.
  errors.push(...checkpoint.errors);
  return {
    found: true,
    repair: {
      type: 'checkpoint_repair', source, originalAuthor, reason, correctedFields,
      checkpoint: checkpoint.checkpoint, orchestratorAttribution: orchestrator, roleId: role.roleId, carrier, raw,
    },
    errors,
  };
}

/** Render a bounded repair carrier without mutating its source. */
export function formatCheckpointRepair(repair, options = {}) {
  const carrier = options.carrier ?? 'github';
  const heading = '#'.repeat(options.headingLevel ?? (carrier === 'files' ? 3 : 2));
  const checkpoint = repair.checkpoint ?? repair;
  const lines = [
    ...(carrier === 'github' ? ['<!-- AGENTIC_LOOP_REVIEW_CHECKPOINT_REPAIR -->', ''] : []),
    `${heading} Review Round Checkpoint Repair`, '',
    `- Source: ${repair.source}`,
    `- Original author: ${repair.originalAuthor}`,
    `- Reason: ${repair.reason}`,
    `- Corrected fields: ${(repair.correctedFields ?? []).join(', ')}`,
    `- Direction: ${checkpoint.direction}`,
    `- Cause: ${checkpoint.cause}`,
    `- Review count: ${checkpoint.reviewCount}`,
    `- Artifact: ${checkpoint.artifact}`,
  ];
  if (checkpoint.target) lines.push(`- Target: ${checkpoint.target}`);
  if (checkpoint.reference) lines.push(`- Reference: ${checkpoint.reference}`);
  lines.push(...renderReviewRoleCarrier({
    roleId: 'orchestrator',
    actorAccount: checkpoint.orchestratorAttribution ?? repair.orchestratorAttribution,
  }));
  if (carrier === 'github') lines.push('', '[[agent: orchestrator]]');
  lines.push('');
  return lines.join('\n');
}

function repairSourceAuthor(event) {
  return String(event?.author?.login ?? event?.trustedRole ?? '').toLowerCase();
}

/**
 * The one pure, shared checkpoint-repair validation function. It enforces the
 * complete bounded-repair contract against ordered durable history:
 *   - the exact named source exists and is a malformed checkpoint candidate;
 *   - the source is not already valid and not already repaired;
 *   - the repair appears after its source and is authored by (and names) the
 *     exact original authenticated author;
 *   - the source has not been consumed by a later review outcome;
 *   - direction, cause, target, and reference authority are never expanded;
 *   - the bound artifact and review count change only to values mechanically
 *     derivable from authenticated ordered history;
 *   - the corrected checkpoint passes the full carrier schema.
 * Returns a cloned replacement event; caller-owned objects are never mutated.
 *
 * @returns {{ valid: boolean, errors: string[], repairedEvent: object|null }}
 */
export function validateCheckpointRepairEvent({ event, source, ordered, alreadyRepaired = false } = {}) {
  const label = `checkpoint repair ${event.sourceReference ?? event.source}`;
  if (!source) {
    return { valid: false, errors: [`${label} names no malformed checkpoint source '${event.source}'`], repairedEvent: null };
  }
  if (alreadyRepaired) {
    return { valid: false, errors: [`${label} attempts a second repair of '${event.source}'`], repairedEvent: null };
  }
  if (!source.errors?.length) {
    return { valid: false, errors: [`${label} cannot repair an already valid checkpoint`], repairedEvent: null };
  }
  if ((event.sourceOrder ?? 0) <= (source.sourceOrder ?? 0)) {
    return { valid: false, errors: [`${label} must appear after its source in durable history`], repairedEvent: null };
  }
  const sourceAuthor = repairSourceAuthor(source);
  const repairAuthor = repairSourceAuthor(event);
  if (!sourceAuthor || sourceAuthor !== repairAuthor || String(event.originalAuthor).toLowerCase() !== sourceAuthor) {
    return { valid: false, errors: [`${label} must be authored by and name the exact original authenticated Orchestrator`], repairedEvent: null };
  }
  if ((ordered ?? []).some(candidate => candidate.type === 'outcome' && (candidate.sourceOrder ?? 0) > (source.sourceOrder ?? 0))) {
    return { valid: false, errors: [`${label} cannot repair a checkpoint after it has been consumed by a review outcome`], repairedEvent: null };
  }
  const partial = source.checkpoint ?? {};
  const replacement = event.checkpoint ?? {};
  const errors = [];
  for (const field of ['direction', 'cause', 'target', 'reference']) {
    if (!partial[field] || partial[field] === replacement[field]) continue;
    errors.push(`${label} changes authority-bearing field '${field}', which is not repairable`);
  }
  const prior = (ordered ?? []).filter(candidate => candidate.type === 'outcome' && candidate.status === 'needs_revision' && (candidate.sourceOrder ?? 0) < (source.sourceOrder ?? 0));
  const latest = prior.at(-1);
  if (!latest) {
    return { valid: false, errors: [`${label} has no prior needs_revision outcome from which to derive missing fields`], repairedEvent: null };
  }
  if (partial.artifact && partial.artifact !== replacement.artifact) errors.push(`${label} changes the bound artifact`);
  if (!partial.artifact && replacement.artifact !== latest.artifact) errors.push(`${label} artifact is not the latest reviewed artifact`);
  if (Number.isInteger(partial.reviewCount) && partial.reviewCount !== replacement.reviewCount) errors.push(`${label} changes review_count`);
  if (!Number.isInteger(partial.reviewCount) && replacement.reviewCount !== prior.length) errors.push(`${label} review_count is not mechanically derivable from ordered history`);
  // Versioned role-carrier repair. Actor identity may only be restored from the
  // authenticated GitHub author of the repaired source; files-backed history has
  // no authenticated source, so an underivable actor requires reissuance. The
  // immutable role ID and the supported carrier version are contract-fixed.
  const declaredList = (event.correctedFields ?? []).map(canonicalRepairFieldName);
  const declaredRepairs = new Set(declaredList);
  if (declaredRepairs.size !== declaredList.length) {
    errors.push(`${label} correctedFields must not contain duplicate or aliased duplicate fields`);
  }
  for (const field of declaredRepairs) {
    if (!CANONICAL_REPAIRABLE_CHECKPOINT_FIELDS.includes(field)) {
      errors.push(`${label} declares non-repairable field '${field}'`);
    }
  }
  const actualRepairs = new Set();
  if (!Number.isInteger(partial.reviewCount) && Number.isInteger(replacement.reviewCount)) actualRepairs.add('review_count');
  if (!partial.artifact && replacement.artifact) actualRepairs.add('artifact');
  if (String(partial.orchestratorAttribution ?? '').toLowerCase() !== String(replacement.orchestratorAttribution ?? '').toLowerCase()) actualRepairs.add('actor_account');
  if (partial.roleId !== replacement.roleId) actualRepairs.add('role_id');
  if (partial.roleCarrierSchemaVersion !== replacement.roleCarrierSchemaVersion) actualRepairs.add('review_role_carrier');
  const missingDeclarations = [...actualRepairs].filter(field => !declaredRepairs.has(field));
  const spuriousDeclarations = [...declaredRepairs].filter(field => !actualRepairs.has(field));
  if (missingDeclarations.length > 0) {
    errors.push(`${label} correctedFields omits repaired field(s): ${missingDeclarations.join(', ')}`);
  }
  if (spuriousDeclarations.length > 0) {
    errors.push(`${label} correctedFields declares unchanged field(s): ${spuriousDeclarations.join(', ')}`);
  }
  const replacementActor = String(replacement.orchestratorAttribution ?? '');
  if (replacementActor && replacementActor.toLowerCase() !== sourceAuthor) {
    errors.push(`${label} actor account '${replacementActor}' is not the authenticated author of its source`);
  }
  if (declaredRepairs.has('actor_account')) {
    // A legacy files carrier's `Orchestrator:` value is the fixed trusted-role
    // spelling, not an account, so restoring it is contract-fixed rather than
    // an identity derivation. A real account is only derivable from an
    // authenticated GitHub author.
    const authenticatedSource = String(source.author?.login ?? '');
    const legacyRoleToken = replacement.roleCarrierSchemaVersion === 0 &&
      replacementActor.toLowerCase() === 'orchestrator';
    if (!replacementActor) {
      errors.push(`${label} declares an actor_account repair without a derivable actor account`);
    } else if (!authenticatedSource && !legacyRoleToken) {
      errors.push(`${label} cannot derive actor identity without an authenticated source; reissue the checkpoint`);
    }
  }
  if (declaredRepairs.has('role_id') && replacement.roleId !== 'orchestrator') {
    errors.push(`${label} role_id repair must restore the immutable 'orchestrator' role`);
  }
  if (declaredRepairs.has('review_role_carrier') &&
      replacement.roleCarrierSchemaVersion !== REVIEW_ROLE_CARRIER_SCHEMA_VERSION) {
    errors.push(`${label} review_role_carrier repair must restore the supported carrier version`);
  }
  if (replacement.roleId !== 'orchestrator') {
    errors.push(`${label} replacement role ID must be immutable 'orchestrator'`);
  }
  if (![0, REVIEW_ROLE_CARRIER_SCHEMA_VERSION].includes(replacement.roleCarrierSchemaVersion)) {
    errors.push(`${label} replacement review role carrier version is invalid`);
  }
  if (errors.length > 0) {
    return { valid: false, errors, repairedEvent: null };
  }
  const schema = validateCheckpointSchema(replacement, {
    artifactValidator: replacement.carrier === 'files' ? filesArtifactError : githubArtifactError,
  });
  if (!schema.valid) {
    return { valid: false, errors: schema.errors.map(error => `${label}: ${error}`), repairedEvent: null };
  }
  // Clone/replace: the repaired event is a new object at the source position.
  // The caller's source candidate is never given new properties.
  return {
    valid: true,
    errors: [],
    repairedEvent: {
      ...source,
      ...replacement,
      type: 'checkpoint',
      sourceOrder: source.sourceOrder,
      repairedBy: event.sourceReference,
    },
  };
}

/**
 * Apply only legal repair events in ordered history. Repaired carriers retain
 * their source position; repair events remain visible but never count/select.
 * The function is pure: it returns a new ordered array of events and never
 * mutates or annotates the caller's event objects.
 */
export function applyCheckpointRepairs(events) {
  const errors = [];
  const ordered = [...(events ?? [])].sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0));
  const repaired = new Set();
  const repairedBySource = new Map();
  for (const event of ordered) {
    if (event.type !== 'checkpoint_repair') continue;
    const source = ordered.find(candidate => candidate.type === 'checkpoint_candidate' && candidate.sourceReference === event.source);
    const result = validateCheckpointRepairEvent({ event, source, ordered, alreadyRepaired: repaired.has(event.source) });
    if (!result.valid) {
      errors.push(...result.errors);
      continue;
    }
    repaired.add(event.source);
    repairedBySource.set(event.source, result.repairedEvent);
  }
  const output = [];
  for (const event of ordered) {
    if (event.type === 'checkpoint_candidate') {
      const replacement = repairedBySource.get(event.sourceReference);
      if (replacement) output.push(replacement);
      else errors.push(...(event.errors ?? []).map(error => `${event.sourceKind ?? 'history'} ${event.sourceReference}: ${error}`));
    } else {
      // Checkpoints, outcomes, and distinct repair events all remain visible in
      // ordered history. Repairs never count as outcomes or select as checkpoints.
      output.push(event);
    }
  }
  return { events: output.sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0)), errors };
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
  if (!VALID_DIRECTIONS.has(direction)) {
    errors.push(`checkpoint direction '${direction}' is not valid; expected one of: ${[...VALID_DIRECTIONS].join(', ')}`);
  }
  if (!VALID_CHECKPOINT_CAUSES.has(cause)) {
    errors.push(`checkpoint cause '${cause}' is not valid; expected one of: ${[...VALID_CHECKPOINT_CAUSES].join(', ')}`);
  }
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
  // Role-ID and carrier-version immutability checks apply unconditionally. A
  // hand-built checkpoint without a carrier discriminator must not bypass
  // them; a declared version that did not resolve (null) is never coerced
  // into the legacy schema version 0.
  if (checkpoint.roleId !== 'orchestrator') errors.push("checkpoint role ID must be immutable 'orchestrator'");
  if (![0, REVIEW_ROLE_CARRIER_SCHEMA_VERSION].includes(checkpoint.roleCarrierSchemaVersion)) {
    errors.push('checkpoint review role carrier version is invalid');
  }
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

/** Evaluate the distinct stable-finding no-progress guard before review budget. */
export function evaluateNoProgress({ reviewHistory = [] } = {}) {
  // Only consecutive valid implementation-changing needs_revision outcomes can
  // sustain a finding. Record-only corrections, stale (legacy missing-finding)
  // reviews, and accepted outcomes never trigger the guard; withdrawn or
  // retired findings are absent from the latest outcome and therefore cannot
  // be sustained; a legacy outcome with no declared classification defaults to
  // implementation_changing.
  const isCountable = event =>
    event?.type === 'outcome' &&
    event.status === 'needs_revision' &&
    !event.legacyMissingFindingIds &&
    (event.classification ?? 'implementation_changing') === 'implementation_changing';
  const outcomes = [...reviewHistory]
    .filter(isCountable)
    .sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0));
  const previous = outcomes.at(-2);
  const latest = outcomes.at(-1);
  if (!previous || !latest) {
    return { authorized: true, required: false, sustainedFindingIds: [], errors: [], warnings: [], disposition: null };
  }
  const priorIds = new Set(previous.findingIds ?? []);
  const sustainedFindingIds = (latest.findingIds ?? []).filter(id => priorIds.has(id));
  if (sustainedFindingIds.length === 0) {
    return { authorized: true, required: false, sustainedFindingIds, errors: [], warnings: [], disposition: null };
  }
  const disposition = [...reviewHistory]
    .filter(event => event?.type === 'no_progress' && (event.sourceOrder ?? 0) > (latest.sourceOrder ?? 0))
    .at(-1) ?? null;
  if (!disposition) {
    return {
      authorized: false, required: true, sustainedFindingIds,
      errors: [`stable finding(s) ${sustainedFindingIds.join(', ')} persisted through two consecutive needs_revision outcomes; record a No Progress Disposition before another equivalent Engineer revision`],
      warnings: [], disposition: null,
    };
  }
  // The disposition must bind the exact sustained finding IDs. A disposition
  // recorded for different findings cannot authorize another revision for
  // these sustained findings.
  const boundIds = (disposition.sustainedFindingIds ?? []).slice().sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const actualIds = [...sustainedFindingIds].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  if (boundIds.length === 0) {
    return { authorized: false, required: true, sustainedFindingIds, errors: ['no_progress disposition must bind the exact sustained finding ids it addresses'], warnings: [], disposition };
  }
  if (boundIds.length !== actualIds.length || boundIds.some((id, index) => id !== actualIds[index])) {
    return { authorized: false, required: true, sustainedFindingIds, errors: [`no_progress disposition binds ${boundIds.join(', ')} but the sustained findings are ${actualIds.join(', ')}`], warnings: [], disposition };
  }
  if (disposition.disposition === 'targeted_revision' && !disposition.target) {
    return { authorized: false, required: true, sustainedFindingIds, errors: ['no_progress targeted_revision requires a materially different target'], warnings: [], disposition };
  }
  if (['split_task', 'contract_decision', 'blocked'].includes(disposition.disposition)) {
    return {
      authorized: false, required: true, sustainedFindingIds,
      errors: [`no_progress disposition '${disposition.disposition}' does not authorize another parent Engineer revision`], warnings: [], disposition,
    };
  }
  return { authorized: true, required: true, sustainedFindingIds, errors: [], warnings: [], disposition };
}

/** @param {Array<object>} history */
function checkpointsPresent(history) {
  return history.some(event => event.type === 'checkpoint');
}

/**
 * Derive checkpoint state from ordered durable history. States:
 *   - 'absent': no durable checkpoint exists
 *   - 'rendered': a rendered/unposted candidate exists (options.proposed) but
 *     no durable checkpoint authorizes anything yet
 *   - 'authorizes_revision': the latest durable checkpoint authorizes one
 *     revision from artifact/review A toward its intended direction/target B
 *   - 'consumed': a later review outcome consumed the latest checkpoint
 *   - 'invalid': durable-history errors prevent a definitive state
 *
 * The event causing the state is always identified. An authorizing state names
 * the source event, the from artifact/review (A), the intended direction and
 * target (B), and the review count; a consumed state names both the checkpoint
 * and the consuming outcome.
 *
 * @param {Array<object>} events
 * @param {string[]} [errors]
 * @param {{ proposed?: object|null }} [options] A newly rendered, not yet
 *   durable checkpoint candidate to include in the state derivation.
 */
export function deriveCheckpointState(events, errors = [], options = {}) {
  if (Array.isArray(errors) && errors.length > 0) {
    return { state: 'invalid', event: null, authorizes: false, reason: 'durable review history contains errors' };
  }
  const ordered = [...(events ?? [])].sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0));
  const checkpoints = ordered.filter(event => event?.type === 'checkpoint');
  const latest = checkpoints.at(-1) ?? null;
  const proposed = options.proposed ?? null;
  if (!latest) {
    if (proposed) {
      return { state: 'rendered', event: null, authorizes: false, candidate: proposed };
    }
    return { state: 'absent', event: null, authorizes: false };
  }
  const laterOutcome = ordered.find(event => event?.type === 'outcome' && (event.sourceOrder ?? 0) > (latest.sourceOrder ?? 0));
  if (laterOutcome) {
    return {
      state: 'consumed',
      event: latest.sourceReference ?? null,
      consumedBy: laterOutcome.sourceReference ?? null,
      authorizes: false,
      checkpoint: latest.sourceReference ?? null,
      consumingOutcome: laterOutcome.sourceReference ?? null,
    };
  }
  const precedingNeedsRevision = ordered.filter(event =>
    event?.type === 'outcome' && event.status === 'needs_revision' && (event.sourceOrder ?? 0) < (latest.sourceOrder ?? 0)
  ).at(-1) ?? null;
  return {
    state: 'authorizes_revision',
    event: latest.sourceReference ?? null,
    authorizes: true,
    source: latest.sourceReference ?? null,
    fromArtifact: latest.artifact ?? precedingNeedsRevision?.artifact ?? null,
    fromReview: precedingNeedsRevision?.sourceReference ?? null,
    direction: latest.direction ?? null,
    target: latest.target ?? null,
    reviewCount: latest.reviewCount ?? null,
  };
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
  lines.push(...renderReviewRoleCarrier({
    roleId: 'orchestrator',
    actorAccount: checkpoint.orchestratorAttribution,
  }));
  if (carrier === 'github') lines.push('', '[[agent: orchestrator]]');
  lines.push('');
  return lines.join('\n');
}
