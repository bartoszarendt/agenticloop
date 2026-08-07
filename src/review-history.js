/**
 * Durable review-history carriers shared by GitHub preflight, review audit,
 * and files task validation. This module only parses/normalizes events; policy
 * consumers decide which lifecycle action is being authorized.
 */

import { markdownLines, markdownSection, parseAtxHeading } from './markdown.js';
import { REVIEW_MODES, isValidReviewMode } from './review-provenance.js';
import { applyCheckpointRepairs, parseCheckpointRepair, parseReviewCheckpoint, VALID_NO_PROGRESS_DISPOSITIONS } from './review-checkpoint.js';
import { FINDING_ID_RE } from './resolution-matrix.js';
import {
  normalizeReviewRoleCarrier,
  renderReviewRoleCarrier,
  REVIEW_ROLE_CARRIER_SCHEMA_VERSION,
  REVIEW_ROLE_CARRIER_VERSION,
} from './review-role-carrier.js';
import { isGitObjectId } from './git-oid.js';

export { FINDING_ID_RE } from './resolution-matrix.js';

/** Canonical revision classification values shared by both backends. */
export const VALID_REVISION_CLASSIFICATIONS = new Set(['implementation_changing', 'record_only']);

/**
 * Validate one optional revision-classification value. A legacy outcome with
 * no declared classification defaults to `implementation_changing` (documented
 * fail-safe default: existing unclassified history keeps its established
 * no-progress semantics).
 *
 * @param {string} raw
 * @returns {{ classification: string|null, error: string|null }}
 */
export function parseRevisionClassification(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { classification: null, error: null };
  if (!VALID_REVISION_CLASSIFICATIONS.has(value)) {
    return { classification: null, error: `unsupported review classification '${value}'; expected one of: ${[...VALID_REVISION_CLASSIFICATIONS].join(', ')}` };
  }
  return { classification: value, error: null };
}

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

/** Parse the distinct no-progress carrier without overloading checkpoint fields. */export function parseNoProgressDisposition(body, options = {}) {
  const raw = String(body ?? '');
  const carrier = options.carrier ?? 'github';
  const marker = markdownLines(raw).some(line => line.live && /<!--\s*AGENTIC_LOOP_NO_PROGRESS\s*-->/.test(line.raw));
  const section = markdownSection(raw, '## No Progress Disposition') ?? markdownSection(raw, '### No Progress Disposition');
  if (!marker && !section) return { found: false, event: null, errors: [] };
  const errors = [];
  if (carrier === 'github' && !marker) errors.push('GitHub no-progress disposition is missing the AGENTIC_LOOP_NO_PROGRESS marker');
  if (!section) errors.push('no-progress marker is missing the No Progress Disposition section');
  const { fields, errors: fieldErrors } = labelledFields((section?.lines ?? []).map(line => line.raw).join('\n'));
  errors.push(...fieldErrors);
  const disposition = String(fields.no_progress_disposition ?? fields.disposition ?? '').toLowerCase();
  const target = fields.target ?? '';
  const reference = fields.reference ?? '';
  const role = normalizeReviewRoleCarrier(fields, {
    expectedRoleId: 'orchestrator', legacyField: 'orchestrator',
    legacyActorAccount: options.authenticatedActorAccount,
    allowUntrustedLegacyParse: carrier === 'github' && !options.authenticatedActorAccount,
    label: 'no-progress disposition',
  });
  errors.push(...role.errors);
  const orchestrator = role.actorAccount ?? '';
  const rawSustained = fields.sustained_finding_ids ?? fields.finding_ids ?? fields.findings ?? '';
  const sustainedFindingIds = String(rawSustained).split(',').map(value => value.trim()).filter(Boolean);
  if (!VALID_NO_PROGRESS_DISPOSITIONS.has(disposition)) errors.push(`no_progress_disposition '${disposition}' must be one of: ${[...VALID_NO_PROGRESS_DISPOSITIONS].join(', ')}`);
  if (disposition === 'targeted_revision' && !target) errors.push('no_progress targeted_revision requires Target');
  if (['split_task', 'contract_decision', 'blocked'].includes(disposition) && !reference) errors.push(`no_progress ${disposition} requires Reference`);
  if (sustainedFindingIds.length === 0) errors.push('no-progress disposition must bind the exact sustained finding ids it addresses');
  for (const id of sustainedFindingIds) {
    if (!FINDING_ID_RE.test(id)) errors.push(`no-progress sustained finding id '${id}' is not canonical (expected F-<positive integer>)`);
  }
  if (!orchestrator) errors.push('no-progress disposition requires Actor account');
  return { found: true, event: { type: 'no_progress', disposition, target, reference, sustainedFindingIds, orchestratorAttribution: orchestrator, roleId: role.roleId, carrier }, errors };
}

export function formatNoProgressDisposition(event, options = {}) {
  const carrier = options.carrier ?? 'github';
  const heading = '#'.repeat(options.headingLevel ?? (carrier === 'files' ? 3 : 2));
  const lines = [
    ...(carrier === 'github' ? ['<!-- AGENTIC_LOOP_NO_PROGRESS -->', ''] : []),
    `${heading} No Progress Disposition`, '',
    `- No progress disposition: ${event.disposition}`,
  ];
  if (event.sustainedFindingIds?.length) lines.push(`- Sustained finding ids: ${event.sustainedFindingIds.join(', ')}`);
  if (event.target) lines.push(`- Target: ${event.target}`);
  if (event.reference) lines.push(`- Reference: ${event.reference}`);
  lines.push(...renderReviewRoleCarrier({
    roleId: 'orchestrator',
    actorAccount: event.orchestratorAttribution,
  }));
  if (carrier === 'github') lines.push('', '[[agent: orchestrator]]');
  lines.push('');
  return lines.join('\n');
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
    marker.artifact !== String(currentArtifact ?? '') &&
    marker.errors?.length === 1 && marker.errors[0] === MISSING_FINDINGS_ERROR;
}

/**
 * Canonical GitHub login normalization for identity comparison.
 *
 * GitHub account names are case-insensitive for identity purposes but are
 * returned in their authored spelling. Comparisons therefore fold case, while
 * the durable carrier keeps the exact authenticated spelling: this function is
 * a comparison key only and is never written back into a review carrier.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeGitHubLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** @param {object|null|undefined} marker @param {object|null|undefined} expected */
export function isTrustedReviewMarker(marker, expected) {
  const expectedLogin = normalizeGitHubLogin(expected?.login);
  const markerLogin = normalizeGitHubLogin(marker?.author?.login);
  return Boolean(expectedLogin && markerLogin && markerLogin === expectedLogin);
}

/**
 * The single review-marker authority validator.
 *
 * `parseReviewMarker` decides only whether a carrier is *shaped* like a review
 * outcome. This function decides whether the parsed carrier may *speak* for a
 * Maintainer: a versioned actor account is an authenticated GitHub source
 * identity, never a self-asserted label, so a comment authenticated as one
 * account can never record an actor account belonging to somebody else. Both
 * GitHub review paths - shared durable history collection and
 * `github-review-audit` - consume this one function so the trust rule cannot
 * drift between them.
 *
 * The declared account is compared under {@link normalizeGitHubLogin} and is
 * never rewritten, prefixed, substituted, or invented: a real login whose
 * spelling happens to equal a role name round-trips unchanged.
 *
 * @param {object|null|undefined} marker parsed review marker
 * @param {{ body?: string, authenticatedAuthor?: {login?: string}|null,
 *   expectedAccount?: {login?: string}|null, label?: string }} [context]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateReviewMarkerAuthority(marker, {
  body = '',
  authenticatedAuthor = null,
  expectedAccount = null,
  label = 'review marker',
} = {}) {
  const errors = [];
  if (!marker || marker.type !== 'outcome') return { ok: true, errors };
  if (finalLiveRole(String(body ?? '')) !== 'maintainer') {
    errors.push(`${label} must end with the maintainer attribution trailer '[[agent: maintainer]]'`);
  }
  const authenticated = authenticatedAuthor?.login ?? marker.author?.login ?? '';
  const authenticatedLogin = normalizeGitHubLogin(authenticated);
  if (!authenticatedLogin) {
    errors.push(`${label} has no authenticated GitHub source author; actor attribution cannot be bound`);
  }
  const expectedLogin = normalizeGitHubLogin(expectedAccount?.login);
  if (expectedLogin && authenticatedLogin && authenticatedLogin !== expectedLogin) {
    errors.push(`${label} authenticated author '${authenticated}' is not the expected loop account '${expectedAccount?.login}'`);
  }
  if (marker.roleCarrierSchemaVersion === REVIEW_ROLE_CARRIER_SCHEMA_VERSION) {
    if (marker.roleId !== 'maintainer') {
      errors.push(`${label} Role ID must be immutable 'maintainer'`);
    }
    const actorAccount = String(marker.actorAccount ?? '').trim();
    if (!actorAccount) {
      errors.push(`${label} versioned role carrier requires Actor account`);
    } else if (authenticatedLogin && normalizeGitHubLogin(actorAccount) !== authenticatedLogin) {
      errors.push(
        `${label} Actor account '${actorAccount}' does not match its authenticated GitHub author '${authenticated}'`
      );
    }
  } else if (marker.roleCarrierSchemaVersion === null || marker.roleCarrierDeclaredVersion) {
    // Versioned role authority was declared but its version is unsupported or
    // could not be resolved. Fail closed here: the declaration is never
    // coerced into the legacy schema version 0.
    errors.push(
      `${label} declares an unsupported or unresolved review role carrier` +
      `${marker.roleCarrierDeclaredVersion ? ` version '${marker.roleCarrierDeclaredVersion}'` : ''}` +
      `; expected '${REVIEW_ROLE_CARRIER_VERSION}'`
    );
  } else if (String(marker.actorAccount ?? '').trim()) {
    // A legacy carrier declares no versioned actor account. Nothing may
    // manufacture one on its behalf.
    errors.push(`${label} legacy carrier cannot declare a versioned actor account`);
  }
  return { ok: errors.length === 0, errors };
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
  const classifications = markerValues(liveBody, 'AGENT_REVIEW_CLASSIFICATION');
  const carrierVersions = markerValues(liveBody, 'AGENT_REVIEW_ROLE_CARRIER');
  const roleIds = markerValues(liveBody, 'AGENT_REVIEW_ROLE_ID');
  const actorAccounts = markerValues(liveBody, 'AGENT_REVIEW_ACTOR_ACCOUNT');
  if (statuses.length + modes.length + artifacts.length + findings.length + humanRefs.length + classifications.length + carrierVersions.length + roleIds.length + actorAccounts.length === 0) {
    const hasMarkerLikeText = markdownLines(rawBody).some(line =>
      /AGENT_(?:REVIEW_(?:STATUS|MODE|ARTIFACT|FINDINGS|CLASSIFICATION)|HUMAN_REVIEW_REF)\s*:/i.test(line.raw)
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
  if (classifications.length > 1) errors.push('review marker must contain at most one classification');
  if (carrierVersions.length > 1 || roleIds.length > 1 || actorAccounts.length > 1) errors.push('review marker must not duplicate versioned role authority fields');
  const status = statuses[0] ?? '';
  const mode = modes[0] ?? '';
  const artifact = artifacts[0] ?? '';
  const parsedClassification = parseRevisionClassification(classifications[0]);
  if (parsedClassification.error) errors.push(parsedClassification.error);
  if (status && !['accepted', 'needs_revision'].includes(status)) {
    errors.push(`unsupported review status '${status}'; expected one of: accepted, needs_revision`);
  }
  if (mode && !isValidReviewMode(mode)) {
    errors.push(`unsupported review mode '${mode}'; expected one of: ${REVIEW_MODES.join(', ')}`);
  }
  if (artifact && !isGitObjectId(artifact)) errors.push('review artifact must be a complete Git object identity');
  const hasMaintainerTrailer = markdownLines(rawBody).some(line =>
    line.live && /^\s*\[\[agent:\s*maintainer\]\]\s*$/i.test(line.raw)
  );
  // The Maintainer trailer must be the final live nonblank line. An earlier
  // Maintainer trailer followed by another role or prose does not attribute the
  // marker to a Maintainer and fails closed here, in the one shared parser, so
  // both GitHub review paths inherit the same rule.
  if (!hasMaintainerTrailer) {
    errors.push("agent review marker is missing the maintainer attribution trailer; expected '[[agent: maintainer]]'");
  } else if (finalLiveRole(rawBody) !== 'maintainer') {
    errors.push("agent review marker maintainer attribution trailer '[[agent: maintainer]]' must be the final live nonblank line");
  }
  const versionedRole = carrierVersions.length || roleIds.length || actorAccounts.length
    ? normalizeReviewRoleCarrier({
      review_role_carrier: carrierVersions[0], role_id: roleIds[0], actor_account: actorAccounts[0],
    }, { expectedRoleId: 'maintainer', legacyField: 'maintainer', label: 'review marker' })
    : null;
  if (versionedRole) errors.push(...versionedRole.errors);
  const parsedFindings = status === 'needs_revision'
    ? findings.length === 1
      ? parseFindingIds(findings[0])
      : { findingIds: [], errors: [MISSING_FINDINGS_ERROR] }
    : { findingIds: [], errors: findings.length ? ['accepted review marker must not declare required findings'] : [] };
  errors.push(...parsedFindings.errors);
  const claimedRoleId = roleIds.length ? String(roleIds[0] ?? '').trim() : null;
  return {
    type: 'outcome', status, mode, artifact, findingIds: parsedFindings.findingIds,
    classification: parsedClassification.classification,
    // A declared versioned role that failed normalization keeps its claimed
    // value for diagnostics; it is never projected as 'maintainer'.
    roleId: versionedRole ? (versionedRole.roleId ?? claimedRoleId) : 'maintainer',
    actorAccount: versionedRole?.actorAccount ?? null,
    // 1 = supported v1 carrier, 0 = legacy carrier, null = versioned role
    // authority was declared but could not be resolved (unsupported or
    // malformed version). An unresolved declaration is never coerced into
    // the legacy schema version.
    roleCarrierSchemaVersion: versionedRole ? versionedRole.schemaVersion : 0,
    roleCarrierDeclaredVersion: versionedRole?.declaredVersion ?? null,
    humanReviewRef: humanRefs[0] ?? '', source, author: extractReviewAuthor(source), errors,
  };
}

/**
 * Render the canonical GitHub review outcome carrier parsed above.
 *
 * The writer is fail-before-emit: every field is validated against the same
 * closed contract the parser enforces *before* any text is returned, and the
 * rendered marker is then parsed back and re-rendered. Malformed output is
 * never handed to a caller to discover later at the review boundary.
 */
export function formatReviewMarker(marker) {
  const status = String(marker?.status ?? '').trim();
  const mode = String(marker?.mode ?? '').trim();
  const artifact = String(marker?.artifact ?? '').trim();
  const actorAccount = String(marker?.actorAccount ?? '').trim();
  const roleId = String(marker?.roleId ?? 'maintainer').trim();
  if (!['accepted', 'needs_revision'].includes(status)) throw new TypeError('review marker status is invalid');
  if (!REVIEW_MODES.includes(mode)) throw new TypeError('review marker mode is invalid');
  if (!isGitObjectId(artifact)) throw new TypeError('review marker artifact must be a complete Git object identity');
  if (roleId !== 'maintainer') throw new TypeError("review marker Role ID must be immutable 'maintainer'");
  if (!actorAccount) throw new TypeError('review marker Actor account must be non-empty');
  if (/[\r\n]/.test(actorAccount)) throw new TypeError('review marker Actor account must be one line');
  const findingIds = Array.isArray(marker?.findingIds) ? marker.findingIds.map(id => String(id).trim()) : [];
  if (status === 'needs_revision') {
    if (findingIds.length === 0) throw new TypeError('needs_revision review marker requires finding IDs');
    const parsedFindings = parseFindingIds(findingIds.join(', '));
    if (parsedFindings.errors.length) throw new TypeError(`review marker finding ids are invalid: ${parsedFindings.errors.join('; ')}`);
  } else if (findingIds.length > 0) {
    throw new TypeError('accepted review marker must not declare required findings');
  }
  const classification = marker?.classification ? String(marker.classification).trim() : '';
  if (classification) {
    const parsedClassification = parseRevisionClassification(classification);
    if (parsedClassification.error || !parsedClassification.classification) {
      throw new TypeError(`review marker classification is invalid: ${parsedClassification.error ?? classification}`);
    }
  }
  const humanReviewRef = marker?.humanReviewRef ? String(marker.humanReviewRef).trim() : '';
  if (marker?.humanReviewRef && !humanReviewRef) {
    throw new TypeError('review marker human review reference must be non-empty when declared');
  }
  if (/[\r\n]/.test(humanReviewRef)) {
    throw new TypeError('review marker human review reference must be one line');
  }
  const carrierVersion = marker?.roleCarrierVersion === undefined || marker?.roleCarrierVersion === null
    ? REVIEW_ROLE_CARRIER_VERSION
    : String(marker.roleCarrierVersion).trim();
  if (carrierVersion !== REVIEW_ROLE_CARRIER_VERSION) {
    throw new TypeError(`review marker role carrier must be '${REVIEW_ROLE_CARRIER_VERSION}'`);
  }
  const lines = [
    `AGENT_REVIEW_STATUS: ${status}`,
    `AGENT_REVIEW_MODE: ${mode}`,
    `AGENT_REVIEW_ARTIFACT: ${artifact}`,
  ];
  if (status === 'needs_revision') lines.push(`AGENT_REVIEW_FINDINGS: ${findingIds.join(', ')}`);
  if (classification) lines.push(`AGENT_REVIEW_CLASSIFICATION: ${classification}`);
  if (humanReviewRef) lines.push(`AGENT_HUMAN_REVIEW_REF: ${humanReviewRef}`);
  lines.push(
    `AGENT_REVIEW_ROLE_CARRIER: ${carrierVersion}`,
    `AGENT_REVIEW_ROLE_ID: ${roleId}`,
    `AGENT_REVIEW_ACTOR_ACCOUNT: ${actorAccount}`,
    '',
    '[[agent: maintainer]]'
  );
  const text = lines.join('\n');
  // Reuse the parser and the shared authority validator as the writer guard.
  // The emitted marker is authored *by* its declared actor account, so the
  // round trip authenticates against that identity.
  const source = { author: { login: actorAccount, type: 'Bot' } };
  const reparsed = parseReviewMarker(text, source);
  if (!reparsed || reparsed.type !== 'outcome' || reparsed.errors.length) {
    throw new TypeError(`review marker writer produced output its parser rejects: ${(reparsed?.errors ?? ['marker is not a live review outcome']).join('; ')}`);
  }
  const authority = validateReviewMarkerAuthority(reparsed, {
    body: text,
    authenticatedAuthor: source.author,
    expectedAccount: source.author,
    label: 'review marker',
  });
  if (!authority.ok) {
    throw new TypeError(`review marker writer produced output the authority validator rejects: ${authority.errors.join('; ')}`);
  }
  return text;
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
 * Enforce only declared stable-ID lifecycle rules. This intentionally does not
 * compare finding prose: Maintainer owns whether two findings are semantically
 * the same. It merely prevents renumbering and retired-ID reuse in durable
 * valid needs_revision history.
 */
export function validateFindingIdLifecycle(events) {
  const errors = [];
  const active = new Set();
  const retired = new Set();
  let next = 1;
  for (const event of [...(events ?? [])].sort((a, b) => (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0))) {
    if (event?.type !== 'outcome' || event.status !== 'needs_revision' || event.legacyMissingFindingIds) continue;
    const ids = Array.isArray(event.findingIds) ? event.findingIds : [];
    const current = new Set(ids);
    // Process finding IDs numerically within each ordered review event so a
    // severity ordering such as [F-2, F-1] is not rejected as an allocation
    // gap. Sustained (active) IDs never allocate; new IDs allocate in numeric
    // order, and real gaps/renumbering/reuse remain errors.
    const orderedIds = [...ids].sort((a, b) => Number(String(a).slice(2)) - Number(String(b).slice(2)));
    for (const id of orderedIds) {
      const number = Number(String(id).slice(2));
      if (retired.has(id)) errors.push(`review history reuses permanently retired finding id '${id}'`);
      if (!active.has(id)) {
        if (number !== next) {
          errors.push(`new finding id '${id}' must use next unused id 'F-${next}'`);
        }
        next = Math.max(next, number + 1);
      }
    }
    for (const id of active) {
      if (!current.has(id)) retired.add(id);
    }
    active.clear();
    for (const id of current) active.add(id);
  }
  return { valid: errors.length === 0, errors, activeFindingIds: [...active].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))), retiredFindingIds: [...retired].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))), nextFindingId: `F-${next}` };
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
    const checkpoint = parseReviewCheckpoint(body, { carrier: 'github', authenticatedActorAccount: author?.login });
    const repair = parseCheckpointRepair(body, { carrier: 'github', authenticatedActorAccount: author?.login });
    const noProgress = parseNoProgressDisposition(body, { carrier: 'github', authenticatedActorAccount: author?.login });
    if (trusted && marker?.type === 'outcome' && checkpoint.found) {
      errors.push(`${entry.kind} ${reference}: one carrier cannot contain both a review outcome and a checkpoint`);
      continue;
    }
    if (trusted && noProgress.found && (marker?.type === 'outcome' || checkpoint.found || repair.found)) {
      errors.push(`${entry.kind} ${reference}: no-progress disposition must use its own distinct carrier`);
      continue;
    }
    // Near misses are diagnostic-only and cannot alter durable history. Do not
    // let one skip a co-located checkpoint, which remains independently valid.
    const markerAuthority = marker && trusted && !marker.nearMiss
      ? validateReviewMarkerAuthority(marker, {
        body, authenticatedAuthor: author, expectedAccount, label: 'review marker',
      })
      : { ok: true, errors: [] };
    if (marker && trusted && !marker.nearMiss) {
      if (!reference) errors.push(`trusted ${entry.kind} review marker has no durable source reference`);
      else if (!markerAuthority.ok) {
        errors.push(...markerAuthority.errors.map(error => `${entry.kind} ${reference}: ${error}`));
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
        events.push({
          type: 'checkpoint_candidate', checkpoint: checkpoint.checkpoint, errors: checkpoint.errors,
          sourceReference: reference, sourceTimestamp: githubSourceTimestamp(source), sourceKind: entry.kind,
          discoveryOrder: sourceOrder, author, trusted: true,
        });
      } else if (!reference) {
        errors.push(`trusted ${entry.kind} checkpoint has no durable source reference`);
      } else if (checkpointRole !== 'orchestrator') {
        errors.push(`${entry.kind} ${reference}: checkpoint must end with the orchestrator attribution trailer '[[agent: orchestrator]]'`);
      } else if (String(checkpoint.checkpoint.orchestratorAttribution).toLowerCase() !== String(author?.login ?? '').toLowerCase()) {
        // Wrong-but-repairable authenticated attribution stays a malformed
        // candidate: one bounded same-author repair may correct it.
        // Unrepaired it remains fatal below.
        events.push({
          type: 'checkpoint_candidate', checkpoint: checkpoint.checkpoint,
          errors: [`checkpoint Orchestrator attribution '${checkpoint.checkpoint.orchestratorAttribution}' does not match its authenticated author`],
          sourceReference: reference, sourceTimestamp: githubSourceTimestamp(source), sourceKind: entry.kind,
          discoveryOrder: sourceOrder, author, trusted: true,
        });
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
    if (repair.found && trusted) {
      const repairRole = finalLiveRole(body);
      if (repair.errors.length) {
        errors.push(...repair.errors.map(error => `${entry.kind} ${reference}: ${error}`));
      } else if (!reference) {
        errors.push(`trusted ${entry.kind} checkpoint repair has no durable source reference`);
      } else if (repairRole !== 'orchestrator') {
        errors.push(`${entry.kind} ${reference}: checkpoint repair must end with the orchestrator attribution trailer '[[agent: orchestrator]]'`);
      } else if (String(repair.repair.orchestratorAttribution).toLowerCase() !== String(author?.login ?? '').toLowerCase()) {
        errors.push(`${entry.kind} ${reference}: checkpoint repair Orchestrator attribution does not match its authenticated author`);
      } else {
        events.push({
          ...repair.repair, sourceReference: reference, sourceTimestamp: githubSourceTimestamp(source), sourceKind: entry.kind,
          discoveryOrder: sourceOrder, author, trusted: true,
        });
      }
    }
    if (noProgress.found && trusted) {
      if (noProgress.errors.length) errors.push(...noProgress.errors.map(error => `${entry.kind} ${reference}: ${error}`));
      else if (finalLiveRole(body) !== 'orchestrator') errors.push(`${entry.kind} ${reference}: no-progress disposition must end with [[agent: orchestrator]]`);
      else if (String(noProgress.event.orchestratorAttribution).toLowerCase() !== String(author?.login ?? '').toLowerCase()) errors.push(`${entry.kind} ${reference}: no-progress Orchestrator attribution does not match its authenticated author`);
      else events.push({ ...noProgress.event, sourceReference: reference, sourceTimestamp: githubSourceTimestamp(source), sourceKind: entry.kind, discoveryOrder: sourceOrder, author, trusted: true });
    }
  }
  const repairedHistory = applyCheckpointRepairs(orderGitHubHistoryEvents(events));
  const ordered = repairedHistory.events;
  const lifecycle = validateFindingIdLifecycle(ordered);
  const result = { events: ordered, errors: [...errors, ...repairedHistory.errors, ...lifecycle.errors] };
  if (ordered.some(event => event.type === 'outcome' && event.status === 'needs_revision')) result.findingLifecycle = lifecycle;
  return result;
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
  const artifact = fields.artifact ?? '';
  if (!['accepted', 'needs_revision'].includes(status)) {
    errors.push(`review history ${reference} has invalid Status '${status}'; expected one of: accepted, needs_revision`);
  }
  if (!isValidReviewMode(mode)) {
    errors.push(`review history ${reference} has invalid Mode '${mode}'; expected one of: ${REVIEW_MODES.join(', ')}`);
  }
  if (!artifact || /\s/.test(artifact)) errors.push(`review history ${reference} has invalid Artifact '${artifact}'`);
  const role = normalizeReviewRoleCarrier(fields, {
    expectedRoleId: 'maintainer', legacyField: 'maintainer', label: `review history ${reference}`,
  });
  errors.push(...role.errors);
  const parsedClassification = parseRevisionClassification(fields.classification);
  if (parsedClassification.error) errors.push(`review history ${reference}: ${parsedClassification.error}`);
  const findings = status === 'needs_revision'
    ? parseFindingIds(fields.findings ?? '')
    : { findingIds: [], errors: fields.findings ? ['accepted review history entry must not declare required findings'] : [] };
  errors.push(...findings.errors.map(error => `review history ${reference}: ${error}`));
  return { event: { type: 'outcome', status, mode, artifact, findingIds: findings.findingIds, classification: parsedClassification.classification, roleId: role.roleId, actorAccount: role.actorAccount, sourceOrder, sourceReference: reference }, errors };
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
      if (checkpoint.errors.length) events.push({
        type: 'checkpoint_candidate', checkpoint: checkpoint.checkpoint, errors: checkpoint.errors,
        sourceOrder, sourceReference: `review-history:${sourceOrder + 1}`, trusted: true, trustedRole: 'orchestrator', sourceKind: 'files',
      });
      else if (checkpoint.checkpoint.roleId !== 'orchestrator' ||
          (checkpoint.checkpoint.roleCarrierSchemaVersion === 0 && String(checkpoint.checkpoint.orchestratorAttribution).toLowerCase() !== 'orchestrator')) {
        // Files checkpoints require the exact trusted-role attribution
        // `Orchestrator: orchestrator`. A wrong role stays a malformed
        // candidate so one bounded trusted-role repair may correct it.
        events.push({
          type: 'checkpoint_candidate', checkpoint: checkpoint.checkpoint,
          errors: ['files checkpoint must declare immutable Role ID: orchestrator'],
          sourceOrder, sourceReference: `review-history:${sourceOrder + 1}`, trusted: true, trustedRole: 'orchestrator', sourceKind: 'files',
        });
      }
      else events.push({ ...checkpoint.checkpoint, sourceOrder, sourceReference: `review-history:${sourceOrder + 1}`, trusted: true, trustedRole: 'orchestrator', sourceKind: 'files' });
      continue;
    }
    if (/^Review Round Checkpoint Repair$/i.test(entry.heading)) {
      const repair = parseCheckpointRepair(body, { carrier: 'files' });
      if (repair.errors.length) errors.push(...repair.errors.map(error => `files checkpoint repair: ${error}`));
      else if (repair.repair.roleId !== 'orchestrator') {
        errors.push('files checkpoint repair must declare immutable Role ID: orchestrator');
      } else events.push({ ...repair.repair, sourceOrder, sourceReference: `review-history:${sourceOrder + 1}`, trusted: true, trustedRole: 'orchestrator', sourceKind: 'files' });
      continue;
    }
    if (/^No Progress Disposition$/i.test(entry.heading)) {
      const noProgress = parseNoProgressDisposition(body, { carrier: 'files' });
      if (noProgress.errors.length) errors.push(...noProgress.errors.map(error => `files no-progress disposition: ${error}`));
      else if (noProgress.event.roleId !== 'orchestrator') errors.push('files no-progress disposition must declare immutable Role ID: orchestrator');
      else events.push({ ...noProgress.event, sourceOrder, sourceReference: `review-history:${sourceOrder + 1}`, trusted: true, trustedRole: 'orchestrator', sourceKind: 'files' });
      continue;
    }
    const reviewMatch = entry.heading.match(/^Review\s+(.+)$/i);
    if (!reviewMatch) continue;
    const reference = `review:${reviewMatch[1].trim()}`;
    const outcome = parseFilesOutcome(body, sourceOrder, reference);
    errors.push(...outcome.errors);
    if (outcome.errors.length === 0) events.push(outcome.event);
  }
  const repairedHistory = applyCheckpointRepairs(events);
  const lifecycle = validateFindingIdLifecycle(repairedHistory.events);
  const result = { events: repairedHistory.events, errors: [...errors, ...repairedHistory.errors, ...lifecycle.errors] };
  if (repairedHistory.events.some(event => event.type === 'outcome' && event.status === 'needs_revision')) result.findingLifecycle = lifecycle;
  return result;
}
