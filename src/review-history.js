/**
 * Durable review-history carriers shared by GitHub preflight, review audit,
 * and files task validation. This module only parses/normalizes events; policy
 * consumers decide which lifecycle action is being authorized.
 */

import { markdownLines, markdownSection, parseAtxHeading } from './markdown.js';
import { REVIEW_MODES, isValidReviewMode } from './review-provenance.js';
import { parseReviewCheckpoint } from './review-checkpoint.js';
import { FINDING_ID_RE } from './resolution-matrix.js';

export { FINDING_ID_RE } from './resolution-matrix.js';

/** @param {string} body @param {string} name */
function markerValues(body, name) {
  const re = new RegExp(`^${name}:[ \\t]*([^\\r\\n]*\\S)[ \\t]*$`, 'gmi');
  return [...body.matchAll(re)].map(match => match[1].trim());
}

/** @param {unknown} source */
export function extractReviewAuthor(source) {
  if (!source || typeof source === 'string') return null;
  const login = source?.author?.login ?? source?.user?.login ?? '';
  const type = source?.author?.type ?? source?.user?.type ?? '';
  return login ? { login: String(login), type: String(type) } : null;
}

/** @param {string} body */
function finalLiveRole(body) {
  const finalLine = markdownLines(body)
    .filter(line => line.live && line.raw.trim())
    .at(-1)?.raw.trim() ?? '';
  return finalLine.match(/^\[\[agent:\s*([a-z_]+)\]\]$/i)?.[1].toLowerCase() ?? null;
}

/** @param {string} raw */
export function parseFindingIds(raw) {
  const errors = [];
  const values = String(raw ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (values.length === 0) return { findingIds: [], errors: ['needs_revision review marker requires AGENT_REVIEW_FINDINGS'] };
  const seen = new Set();
  for (const value of values) {
    if (!FINDING_ID_RE.test(value)) errors.push(`review finding identifier '${value}' is not canonical (expected F-<positive integer>)`);
    if (seen.has(value)) errors.push(`duplicate review finding identifier '${value}'`);
    seen.add(value);
  }
  return { findingIds: values, errors };
}

const MISSING_FINDINGS_ERROR = 'needs_revision review marker must contain exactly one AGENT_REVIEW_FINDINGS field';

/** @param {object|null|undefined} marker @param {string} currentArtifact */
export function isLegacyMissingFindingsMarker(marker, currentArtifact) {
  return marker?.status === 'needs_revision' &&
    Boolean(marker.artifact) &&
    marker.artifact !== String(currentArtifact ?? '').toLowerCase() &&
    marker.errors?.length === 1 && marker.errors[0] === MISSING_FINDINGS_ERROR;
}

/** @param {object|null|undefined} marker @param {object|null|undefined} expected */
export function isTrustedReviewMarker(marker, expected) {
  const expectedLogin = String(expected?.login ?? '').toLowerCase();
  const markerLogin = String(marker?.author?.login ?? '').toLowerCase();
  return Boolean(expectedLogin && markerLogin && markerLogin === expectedLogin);
}

/**
 * Parse a GitHub review marker without deciding whether its source is trusted.
 * `github-review-audit` re-exports this function to keep its public API stable.
 * Needs-revision markers require exactly one findings field by default. This
 * intentionally tightened the former caller-selectable contract.
 */
export function parseReviewMarker(body, source = {}) {
  const rawBody = String(body ?? '');
  const liveBody = markdownLines(rawBody).filter(line => line.live).map(line => line.raw).join('\n');
  const statuses = markerValues(liveBody, 'AGENT_REVIEW_STATUS');
  const modes = markerValues(liveBody, 'AGENT_REVIEW_MODE');
  const artifacts = markerValues(liveBody, 'AGENT_REVIEW_ARTIFACT');
  const findings = markerValues(liveBody, 'AGENT_REVIEW_FINDINGS');
  const humanRefs = markerValues(liveBody, 'AGENT_HUMAN_REVIEW_REF');
  if (statuses.length + modes.length + artifacts.length + findings.length + humanRefs.length === 0) {
    const hasMarkerLikeText = markdownLines(rawBody).some(line =>
      /AGENT_(?:REVIEW_(?:STATUS|MODE|ARTIFACT|FINDINGS)|HUMAN_REVIEW_REF)\s*:/i.test(line.raw)
    );
    if (!hasMarkerLikeText) return null;
    return {
      type: 'near_miss', status: '', mode: '', artifact: '', findingIds: [], humanReviewRef: '',
      source, author: extractReviewAuthor(source), nearMiss: true,
      errors: ['review marker-like text is not a live marker; fields must be unbulleted column-zero lines outside fenced code, blockquotes, and indented code'],
    };
  }
  const errors = [];
  for (const [name, values] of [['status', statuses], ['mode', modes], ['artifact', artifacts]]) {
    if (values.length !== 1) errors.push(`review marker must contain exactly one ${name}`);
  }
  if (humanRefs.length > 1) errors.push('review marker must contain at most one human review reference');
  const status = statuses[0] ?? '';
  const mode = modes[0] ?? '';
  const artifact = (artifacts[0] ?? '').toLowerCase();
  if (status && !['accepted', 'needs_revision'].includes(status)) {
    errors.push(`unsupported review status '${status}'; expected one of: accepted, needs_revision`);
  }
  if (mode && !isValidReviewMode(mode)) {
    errors.push(`unsupported review mode '${mode}'; expected one of: ${REVIEW_MODES.join(', ')}`);
  }
  if (artifact && !/^[0-9a-f]{40}$/.test(artifact)) errors.push('review artifact must be a full 40-character PR head SHA');
  const hasMaintainerTrailer = markdownLines(String(body ?? '')).some(line =>
    line.live && /^\s*\[\[agent:\s*maintainer\]\]\s*$/i.test(line.raw)
  );
  if (!hasMaintainerTrailer) {
    errors.push("agent review marker is missing the maintainer attribution trailer; expected '[[agent: maintainer]]'");
  }
  const parsedFindings = status === 'needs_revision'
    ? findings.length === 1
      ? parseFindingIds(findings[0])
      : { findingIds: [], errors: [MISSING_FINDINGS_ERROR] }
    : { findingIds: [], errors: findings.length ? ['accepted review marker must not declare required findings'] : [] };
  errors.push(...parsedFindings.errors);
  return {
    type: 'outcome', status, mode, artifact, findingIds: parsedFindings.findingIds,
    humanReviewRef: humanRefs[0] ?? '', source, author: extractReviewAuthor(source), errors,
  };
}

/** @param {any} source @param {number} fallback */
function durableSourceReference(source, fallback) {
  const id = source?.id;
  const url = source?.html_url ?? source?.url;
  if (id !== undefined && id !== null && String(id)) return String(id);
  if (url) return String(url);
  return fallback ? `source:${fallback}` : '';
}

/** @param {{ login?: string }|null} author @param {{ login?: string }|null} expected */
function trustedLoopAuthor(author, expected) {
  const expectedLogin = String(expected?.login ?? '').toLowerCase();
  return Boolean(expectedLogin && author?.login && String(author.login).toLowerCase() === expectedLogin);
}

/** @param {any} prData */
function githubSources(prData) {
  const sources = [
    ...(Array.isArray(prData?.comments) ? prData.comments : []).map((source, index) => ({ source, kind: 'comment', index })),
    ...(Array.isArray(prData?.reviews) ? prData.reviews : []).map((source, index) => ({ source, kind: 'review', index })),
  ].map((entry, sequence) => ({ ...entry, sequence }));
  return sources.sort((left, right) => {
    const leftTime = Date.parse(left.source?.created_at ?? left.source?.submitted_at ?? '');
    const rightTime = Date.parse(right.source?.created_at ?? right.source?.submitted_at ?? '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    return left.sequence - right.sequence;
  });
}

/** @param {any} source */
function githubSourceTimestamp(source) {
  const timestamp = Date.parse(source?.created_at ?? source?.submitted_at ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * GitHub's REST comment and review endpoints expose only second-resolution
 * timestamps and do not provide one shared sequence. At an equal cross-endpoint
 * timestamp, place the checkpoint before the outcome so ambiguity fails closed:
 * the outcome consumes that checkpoint and a later, unambiguous checkpoint can
 * still authorize the revision.
 *
 * @param {Array<object>} events
 */
function orderGitHubHistoryEvents(events) {
  return [...events]
    .sort((left, right) => {
      const leftTime = left.sourceTimestamp;
      const rightTime = right.sourceTimestamp;
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
        return Number.isFinite(leftTime) ? -1 : 1;
      }
      if (Number.isFinite(leftTime) && leftTime === rightTime &&
          left.sourceKind !== right.sourceKind && left.type !== right.type) {
        return left.type === 'checkpoint' ? -1 : 1;
      }
      return left.discoveryOrder - right.discoveryOrder;
    })
    .map((event, sourceOrder) => {
      const { discoveryOrder, ...ordered } = event;
      return { ...ordered, sourceOrder };
    });
}

/**
 * Convert all separately fetched GitHub PR conversation comments and review
 * bodies into a strictly trusted, source-ordered history. Untrusted sources do
 * not create events or errors; trusted malformed carriers fail closed.
 */
export function collectGitHubReviewHistory(prData, expectedAccount) {
  const events = [];
  const errors = [];
  for (const [sourceOrder, entry] of githubSources(prData).entries()) {
    const source = entry.source;
    const body = typeof source === 'string' ? source : String(source?.body ?? '');
    const author = extractReviewAuthor(source);
    const trusted = trustedLoopAuthor(author, expectedAccount);
    const reference = durableSourceReference(source, sourceOrder + 1);
    const marker = parseReviewMarker(body, source);
    const checkpoint = parseReviewCheckpoint(body, { carrier: 'github' });
    if (trusted && marker?.type === 'outcome' && checkpoint.found) {
      errors.push(`${entry.kind} ${reference}: one carrier cannot contain both a review outcome and a checkpoint`);
      continue;
    }
    // Near misses are diagnostic-only and cannot alter durable history. Do not
    // let one skip a co-located checkpoint, which remains independently valid.
    if (marker && trusted && !marker.nearMiss) {
      if (!reference) errors.push(`trusted ${entry.kind} review marker has no durable source reference`);
      else if (finalLiveRole(body) !== 'maintainer') {
        errors.push(`${entry.kind} ${reference}: review marker must end with the maintainer attribution trailer '[[agent: maintainer]]'`);
      } else if (marker.errors.length && !isLegacyMissingFindingsMarker(marker, prData?.headRefOid)) {
        errors.push(...marker.errors.map(error => `${entry.kind} ${reference}: ${error}`));
      } else if (isLegacyMissingFindingsMarker(marker, prData?.headRefOid)) {
        events.push({
          ...marker,
          legacyMissingFindingIds: true,
          sourceReference: reference,
          sourceTimestamp: githubSourceTimestamp(source),
          sourceKind: entry.kind,
          discoveryOrder: sourceOrder,
          author,
        });
      }
      else events.push({
        ...marker,
        sourceReference: reference,
        sourceTimestamp: githubSourceTimestamp(source),
        sourceKind: entry.kind,
        discoveryOrder: sourceOrder,
        author,
      });
    }

    if (checkpoint.found && trusted) {
      const checkpointRole = finalLiveRole(body);
      if (checkpoint.errors.length) {
        errors.push(...checkpoint.errors.map(error => `${entry.kind} ${reference}: ${error}`));
      } else if (!reference) {
        errors.push(`trusted ${entry.kind} checkpoint has no durable source reference`);
      } else if (checkpointRole !== 'orchestrator') {
        errors.push(`${entry.kind} ${reference}: checkpoint must end with the orchestrator attribution trailer '[[agent: orchestrator]]'`);
      } else if (String(checkpoint.checkpoint.orchestratorAttribution).toLowerCase() !== String(author?.login ?? '').toLowerCase()) {
        errors.push(`${entry.kind} ${reference}: checkpoint Orchestrator attribution does not match its authenticated author`);
      } else {
        events.push({
          ...checkpoint.checkpoint,
          sourceReference: reference,
          sourceTimestamp: githubSourceTimestamp(source),
          sourceKind: entry.kind,
          discoveryOrder: sourceOrder,
          author,
          trusted: true,
        });
      }
    }
  }
  return { events: orderGitHubHistoryEvents(events), errors };
}

function labelledFields(body) {
  const fields = {};
  const errors = [];
  for (const line of markdownLines(body)) {
    if (!line.live) continue;
    const match = line.raw.match(/^\s*[-*]\s*([\w][\w\s]*?):\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
    if (Object.hasOwn(fields, key)) errors.push(`duplicate review-history field '${match[1].trim()}'`);
    fields[key] = match[2].trim();
  }
  return { fields, errors };
}

function parseFilesOutcome(body, sourceOrder, reference) {
  const { fields, errors } = labelledFields(body);
  const status = fields.status?.toLowerCase() ?? '';
  const mode = fields.mode ?? '';
  const artifact = fields.artifact?.toLowerCase() ?? '';
  if (!['accepted', 'needs_revision'].includes(status)) {
    errors.push(`review history ${reference} has invalid Status '${status}'; expected one of: accepted, needs_revision`);
  }
  if (!isValidReviewMode(mode)) {
    errors.push(`review history ${reference} has invalid Mode '${mode}'; expected one of: ${REVIEW_MODES.join(', ')}`);
  }
  if (!artifact || /\s/.test(artifact)) errors.push(`review history ${reference} has invalid Artifact '${artifact}'`);
  if (fields.maintainer?.toLowerCase() !== 'maintainer') errors.push(`review history ${reference} must declare Maintainer: maintainer`);
  const findings = status === 'needs_revision'
    ? parseFindingIds(fields.findings ?? '')
    : { findingIds: [], errors: fields.findings ? ['accepted review history entry must not declare required findings'] : [] };
  errors.push(...findings.errors.map(error => `review history ${reference}: ${error}`));
  return { event: { type: 'outcome', status, mode, artifact, findingIds: findings.findingIds, sourceOrder, sourceReference: reference }, errors };
}

/**
 * Parse the append-only `## Review History` carrier for files-backed tasks.
 */
export function parseFilesReviewHistory(content) {
  const history = markdownSection(String(content ?? ''), '## Review History');
  if (!history) return { events: [], errors: [] };
  const entries = [];
  let current = null;
  for (const line of markdownLines(history.body)) {
    const heading = line.live ? parseAtxHeading(line.raw) : null;
    if (heading?.level === 3) {
      if (current) entries.push(current);
      current = { heading: heading.text, lines: [] };
      continue;
    }
    if (current) current.lines.push(line.raw);
  }
  if (current) entries.push(current);

  const events = [];
  const errors = [];
  for (const [sourceOrder, entry] of entries.entries()) {
    const body = `### ${entry.heading}\n${entry.lines.join('\n')}`;
    if (/^Review Round Checkpoint$/i.test(entry.heading)) {
      const checkpoint = parseReviewCheckpoint(body, { carrier: 'files' });
      if (checkpoint.errors.length) errors.push(...checkpoint.errors.map(error => `files checkpoint: ${error}`));
      else events.push({ ...checkpoint.checkpoint, sourceOrder, sourceReference: `review-history:${sourceOrder + 1}`, trusted: true });
      continue;
    }
    const reviewMatch = entry.heading.match(/^Review\s+(.+)$/i);
    if (!reviewMatch) continue;
    const reference = `review:${reviewMatch[1].trim()}`;
    const outcome = parseFilesOutcome(body, sourceOrder, reference);
    errors.push(...outcome.errors);
    if (outcome.errors.length === 0) events.push(outcome.event);
  }
  return { events, errors };
}
