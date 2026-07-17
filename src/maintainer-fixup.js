// @ts-check

/**
 * Deterministic parsing and validation for the durable `## Maintainer Review
 * Fixup` review subsection.
 *
 * A Maintainer Review Fixup is disclosed by a `## Maintainer Review Fixup`
 * subsection plus `Task:`/`Agent: maintainer` commit trailers -- no new review
 * mode, marker, or frontmatter field. This module standardizes the subsection's
 * content enough to parse it robustly, ignoring examples inside fenced or
 * otherwise non-live Markdown. It is shared by the files-backend task-record
 * validator and the GitHub review audit so both surfaces read the same shape:
 * `validateFixupEpisode` owns the field rules (all eight standardized fields,
 * both verification fields, duplicate rejection, base/resulting distinctness)
 * and backends supply only their artifact-format check.
 */

import { markdownLines, parseAtxHeading } from './markdown.js';

/** The canonical durable disclosure heading. */
export const MAINTAINER_FIXUP_HEADING = '## Maintainer Review Fixup';

const FIXUP_HEADING_TEXT = 'Maintainer Review Fixup';

/**
 * Standardized fixup fields, keyed by their normalized snake_case name and
 * mapped from the human-readable bullet label. Order matches the canonical
 * template in `skills/review-and-accept/SKILL.md`. Every field is mandatory.
 * @type {ReadonlyArray<{ key: string, label: string }>}
 */
export const FIXUP_FIELDS = Object.freeze([
  { key: 'finding', label: 'Finding' },
  { key: 'eligibility_decision', label: 'Eligibility decision' },
  { key: 'base_artifact', label: 'Base artifact' },
  { key: 'correction', label: 'Correction' },
  { key: 'affected_files', label: 'Affected files' },
  { key: 'planned_verification', label: 'Planned verification' },
  { key: 'verification_result', label: 'Verification result' },
  { key: 'resulting_artifact', label: 'Resulting artifact' },
]);

const FIELD_LABEL_TO_KEY = new Map(
  FIXUP_FIELDS.map(field => [field.label.toLowerCase(), field.key])
);

const FIELD_KEY_TO_LABEL = new Map(FIXUP_FIELDS.map(field => [field.key, field.label]));

/**
 * Normalize an artifact reference for comparison. Backend-neutral: trims and
 * lowercases only, so `commit:AAA` and `commit:aaa` compare equal without
 * assuming a specific artifact grammar.
 *
 * @param {string} value
 */
export function normalizeArtifactToken(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Prefixes accepted as artifact spellings around a bare reference. */
const ARTIFACT_PREFIX_RE = /^(?:commit|sha):/;

/**
 * Strip a supported artifact prefix (`commit:`/`sha:`) from a normalized
 * artifact token, returning the bare reference.
 *
 * @param {string} value
 * @returns {string}
 */
export function bareArtifactToken(value) {
  return normalizeArtifactToken(value).replace(ARTIFACT_PREFIX_RE, '');
}

/**
 * @typedef {object} FixupEpisode
 * @property {number} headingLine Line number of the live heading (1-indexed).
 * @property {Record<string, string>} fields First-occurrence value per field key.
 * @property {Array<{ key: string, label: string, line: number, value: string }>} occurrences
 *   Every recognized field bullet in order, including duplicates.
 * @property {Array<{ key: string, label: string, line: number }>} duplicateFields
 *   Recognized field labels that appeared more than once (second and later hits).
 */

/**
 * Extract every live `## Maintainer Review Fixup` episode from a Markdown body.
 * Headings and field bullets inside fenced code, blockquotes, or indented code
 * are ignored so examples never register as live disclosures. Duplicate
 * recognized labels are retained in `duplicateFields` (first occurrence wins in
 * `fields`) so validators can reject them deterministically instead of letting a
 * later value silently overwrite an earlier one.
 *
 * @param {string} content
 * @returns {FixupEpisode[]}
 */
export function detectFixupEpisodes(content) {
  const lines = markdownLines(content);
  const episodes = [];

  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].live) continue;
    const heading = parseAtxHeading(lines[index].raw);
    if (!heading || heading.level !== 2 || heading.text !== FIXUP_HEADING_TEXT) continue;

    // Collect the body up to the next live heading of level <= 2.
    let end = lines.length;
    for (let j = index + 1; j < lines.length; j++) {
      if (!lines[j].live) continue;
      const inner = parseAtxHeading(lines[j].raw);
      if (inner && inner.level <= 2) {
        end = j;
        break;
      }
    }

    /** @type {Record<string, string>} */
    const fields = {};
    for (const field of FIXUP_FIELDS) fields[field.key] = '';
    /** @type {Array<{ key: string, label: string, line: number, value: string }>} */
    const occurrences = [];
    /** @type {Array<{ key: string, label: string, line: number }>} */
    const duplicateFields = [];
    const seen = new Set();
    for (let j = index + 1; j < end; j++) {
      if (!lines[j].live) continue;
      const bullet = lines[j].raw.match(/^\s*[-*+]\s*([A-Za-z][A-Za-z /]*?)\s*:\s*(.*)$/);
      if (!bullet) continue;
      const key = FIELD_LABEL_TO_KEY.get(bullet[1].trim().toLowerCase());
      if (!key) continue;
      const label = FIELD_KEY_TO_LABEL.get(key) ?? key;
      const value = bullet[2].trim();
      occurrences.push({ key, label, line: lines[j].line, value });
      if (seen.has(key)) {
        duplicateFields.push({ key, label, line: lines[j].line });
      } else {
        seen.add(key);
        fields[key] = value;
      }
    }

    episodes.push({ headingLine: lines[index].line, fields, occurrences, duplicateFields });
  }

  return episodes;
}

/**
 * Shared durable-shape validation for one fixup episode, used by both the
 * files-backend validator and the GitHub review audit so the field rules cannot
 * drift apart.
 *
 * Enforces:
 *   - all eight standardized fields are present and non-empty (including both
 *     `Planned verification` and `Verification result`);
 *   - duplicate recognized field labels are rejected, never silently merged;
 *   - base and resulting artifacts differ after normalization;
 *   - backend-specific artifact format via the optional `validateArtifact`
 *     callback (applied to `Base artifact` and `Resulting artifact`).
 *
 * @param {FixupEpisode} episode
 * @param {object} params
 * @param {string} params.subject Message prefix identifying the task/PR and
 *   source location, e.g. "Task record 'T-001.md'" or "PR #42 comment 2".
 * @param {(fieldLabel: string, value: string) => string | null} [params.validateArtifact]
 *   Backend artifact check; returns an error message or null when valid.
 * @returns {string[]} Error messages (empty when the episode shape is valid).
 */
export function validateFixupEpisode(episode, { subject, validateArtifact } = { subject: 'Maintainer Review Fixup' }) {
  const errors = [];
  const where = `${subject} Maintainer Review Fixup (heading line ${episode.headingLine})`;

  for (const duplicate of episode.duplicateFields) {
    errors.push(
      `${where} has duplicate field '${duplicate.label}' (line ${duplicate.line}); each standardized field must appear exactly once`
    );
  }

  for (const field of FIXUP_FIELDS) {
    if (!String(episode.fields[field.key] ?? '').trim()) {
      errors.push(`${where} is missing required field '${field.label}'`);
    }
  }

  const base = String(episode.fields.base_artifact ?? '').trim();
  const resulting = String(episode.fields.resulting_artifact ?? '').trim();

  if (typeof validateArtifact === 'function') {
    for (const [label, value] of [['Base artifact', base], ['Resulting artifact', resulting]]) {
      if (!value) continue;
      const artifactError = validateArtifact(label, value);
      if (artifactError) errors.push(`${where}: ${artifactError}`);
    }
  }

  if (base && resulting && bareArtifactToken(base) === bareArtifactToken(resulting)) {
    errors.push(
      `${where} base and resulting artifacts are identical; a fixup must change the artifact`
    );
  }

  return errors;
}

/**
 * Whether an evidence body references the given artifact, either by its full
 * normalized spelling or by its bare token (prefix stripped). Matches on token
 * boundaries so `commit:aaa111` evidence never satisfies `commit:aaa1`.
 *
 * @param {string} evidenceBody
 * @param {string} artifact
 * @returns {boolean}
 */
function evidenceReferencesArtifact(evidenceBody, artifact) {
  const body = String(evidenceBody ?? '').toLowerCase();
  const normalized = normalizeArtifactToken(artifact);
  if (!body || !normalized) return false;
  const candidates = new Set([normalized]);
  const bare = bareArtifactToken(artifact);
  if (bare) candidates.add(bare);
  for (const token of candidates) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^0-9a-z_])${escaped}([^0-9a-z_]|$)`, 'i').test(body)) return true;
  }
  return false;
}

/**
 * Validate the durable fixup subsection of a files-backed task record. Runs only
 * when at least one `## Maintainer Review Fixup` subsection is present; a record
 * without one produces no errors here.
 *
 * On top of the shared episode shape, files-backed records must show that the
 * accepted final state is the fixup result: the resulting artifact equals the
 * final reviewed/implementation artifact, the final `review_mode` is
 * `single_agent_fallback`, `independent_review_required` is not true, and the
 * final `## Evidence` section is non-empty and references the resulting
 * artifact (a `## Scope Completed` heading alone is not evidence). The static
 * record cannot prove when evidence was produced, so the enforced guarantee is
 * the evidence/artifact association, not temporal freshness.
 *
 * @param {object} params
 * @param {string} params.label                   Identifier for messages.
 * @param {string} params.content                 Full task-record Markdown.
 * @param {string} [params.reviewMode]            Current review_mode frontmatter value.
 * @param {string} [params.implementationArtifact] Current implementation_artifact.
 * @param {string} [params.reviewedArtifact]      Current reviewed_artifact.
 * @param {boolean|null} [params.independentRequired] Parsed independent_review_required.
 * @param {string|null} [params.evidenceBody]     Body of the final '## Evidence' section
 *   ('' or null when absent/empty).
 * @returns {string[]} Error messages (empty when the record satisfies the contract).
 */
export function validateFilesFixup(params) {
  const label = params.label;
  const episodes = detectFixupEpisodes(params.content ?? '');
  if (episodes.length === 0) return [];

  const errors = [];

  if (episodes.length > 1) {
    errors.push(
      `Task record '${label}' records ${episodes.length} Maintainer Review Fixup episodes; at most one is allowed per task`
    );
  }

  if (params.independentRequired === true) {
    errors.push(
      `Task record '${label}' records a Maintainer Review Fixup but independent_review_required is true; a fixup is not eligible for independent-review tasks`
    );
  }

  // Shared durable-shape validation for every live episode. Files artifacts are
  // free-form local references (commit, range, patch), so no format callback.
  for (const episode of episodes) {
    errors.push(...validateFixupEpisode(episode, { subject: `Task record '${label}'` }));
  }

  const episode = episodes[0];
  const resulting = String(episode.fields.resulting_artifact ?? '').trim();

  // The accepted final artifact must be the fixup result.
  const reviewedArtifact = String(params.reviewedArtifact ?? '').trim();
  const implementationArtifact = String(params.implementationArtifact ?? '').trim();
  const finalArtifact = reviewedArtifact || implementationArtifact;
  const resultingMatchesFinal =
    resulting && finalArtifact && normalizeArtifactToken(resulting) === normalizeArtifactToken(finalArtifact);
  if (resulting && finalArtifact && !resultingMatchesFinal) {
    errors.push(
      `Task record '${label}' Maintainer Review Fixup resulting artifact does not match the final reviewed artifact ('${resulting}' vs '${finalArtifact}')`
    );
  }

  // When the fixup result is the accepted final artifact, the maintainer
  // authored part of what it accepted: the review is same-session by
  // definition. (When the artifacts already mismatch, that error owns the
  // record; do not stack a mode error on top of it.)
  if (!resulting || !finalArtifact || resultingMatchesFinal) {
    const reviewMode = String(params.reviewMode ?? '').trim();
    if (reviewMode !== 'single_agent_fallback') {
      errors.push(
        `Task record '${label}' records a Maintainer Review Fixup but final review_mode is '${reviewMode || '(empty)'}'; an accepted fixup must record review_mode 'single_agent_fallback'`
      );
    }
  }

  // Final-state evidence: a non-empty '## Evidence' section that references the
  // resulting artifact. '## Scope Completed' alone proves nothing about checks.
  const evidenceBody = String(params.evidenceBody ?? '').trim();
  if (!evidenceBody) {
    errors.push(
      `Task record '${label}' records a Maintainer Review Fixup but has no non-empty final '## Evidence' section for the resulting artifact`
    );
  } else if (resulting && !evidenceReferencesArtifact(evidenceBody, resulting)) {
    errors.push(
      `Task record '${label}' Maintainer Review Fixup final '## Evidence' section does not reference the resulting artifact '${resulting}'; refreshed final-state evidence must be recorded against the fixup result`
    );
  }

  return errors;
}

/**
 * Whether a commit message carries the maintainer fixup attribution trailers.
 * Both a `Task:` trailer and an `Agent: maintainer` trailer must be present.
 * The trailer key is matched case-insensitively; the agent value must be
 * exactly `maintainer` after whitespace normalization.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function commitHasMaintainerFixupTrailers(message) {
  const text = String(message ?? '');
  const agentValues = [...text.matchAll(/^[ \t]*agent[ \t]*:[ \t]*([^\r\n]*?)[ \t]*$/gim)]
    .map(match => match[1]);
  const hasAgentMaintainer = agentValues.some(value => value === 'maintainer');
  const hasTask = /^[ \t]*task[ \t]*:[ \t]*\S/im.test(text);
  return hasAgentMaintainer && hasTask;
}

/**
 * Extract every `Task:` trailer value from a commit message.
 *
 * @param {string} message
 * @returns {string[]}
 */
export function commitTaskTrailerValues(message) {
  const text = String(message ?? '');
  return [...text.matchAll(/^[ \t]*task[ \t]*:[ \t]*([^\r\n]*\S)[ \t]*$/gim)]
    .map(match => match[1].trim());
}

/**
 * Cross-check a durable fixup subsection against `maintainer_fixup: true` event
 * evidence, where both are available. A durable subsection present implies a
 * corresponding event; a `maintainer_fixup: true` event implies a durable
 * subsection; more than one `maintainer_fixup: true` event is a
 * multiple-episode anomaly. Mismatches are warnings for historical data and
 * errors for newly produced workflow evidence. Callers must invoke this only
 * when the event surface is expected (event logging enabled) and the durable
 * record is available; absence of events with logging disabled is never a
 * mismatch.
 *
 * Production surface: `agenticloop validate` runs this for files-backed task
 * records when `.agenticloop/project.md` has `event_logging: enabled` (see
 * validate-config.js), reporting mismatches as historical warnings.
 *
 * @param {object} params
 * @param {number} [params.subsectionCount]          Durable `## Maintainer Review Fixup` episodes.
 * @param {number} [params.maintainerFixupEventCount] `maintainer_fixup: true` events.
 * @param {boolean} [params.newlyProduced]           Treat mismatches as errors when true.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function crossCheckMaintainerFixup(params) {
  const subsectionCount = params.subsectionCount ?? 0;
  const eventCount = params.maintainerFixupEventCount ?? 0;
  const messages = [];

  if (subsectionCount > 0 && eventCount === 0) {
    messages.push(
      'durable Maintainer Review Fixup subsection is present but no corresponding maintainer_fixup: true event was recorded'
    );
  }
  if (eventCount > 0 && subsectionCount === 0) {
    messages.push(
      'a maintainer_fixup: true event was recorded but no durable Maintainer Review Fixup subsection is present'
    );
  }
  if (eventCount > 1) {
    messages.push(
      `${eventCount} maintainer_fixup: true events are recorded for this task; at most one fixup episode is allowed per task`
    );
  }

  const bucket = params.newlyProduced ? 'errors' : 'warnings';
  return {
    errors: bucket === 'errors' ? messages : [],
    warnings: bucket === 'warnings' ? messages : [],
  };
}
