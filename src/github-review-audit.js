// @ts-check

import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { resolveIssueNumber } from './github-preflight.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  REVIEW_MODES,
  isValidReviewMode,
  satisfiesIndependentReview,
  parseIndependentReviewRequired,
} from './review-provenance.js';
import {
  bareArtifactToken,
  commitHasMaintainerFixupTrailers,
  commitTaskTrailerValues,
  detectFixupEpisodes,
  validateFixupEpisode,
} from './maintainer-fixup.js';

export class GitHubReviewAuditError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GitHubReviewAuditError';
  }
}

const PR_FIELDS = ['number', 'headRefOid', 'closingIssuesReferences', 'comments', 'reviews', 'commits'].join(',');
const ISSUE_FIELDS = ['number', 'body'].join(',');

/**
 * Detect live `## Maintainer Review Fixup` episodes across the PR's marker
 * sources (PR issue comments and PR review bodies -- the same set markers are
 * read from), retaining source metadata (comment/review ordinal) so validation
 * errors can identify where the episode was recorded. Fenced/quoted examples
 * are ignored by the shared detector.
 *
 * @param {any} prData
 * @returns {Array<import('./maintainer-fixup.js').FixupEpisode & { source: string }>}
 */
function collectFixupEpisodes(prData, sourcePrefix = `PR #${prData?.number ?? '?'}`) {
  const sources = [
    ...(Array.isArray(prData?.comments) ? prData.comments : [])
      .map((/** @type {any} */ entry, /** @type {number} */ index) => ({ entry, kind: 'comment', ordinal: index + 1 })),
    ...(Array.isArray(prData?.reviews) ? prData.reviews : [])
      .map((/** @type {any} */ entry, /** @type {number} */ index) => ({ entry, kind: 'review', ordinal: index + 1 })),
  ];

  const episodes = [];
  for (const { entry, kind, ordinal } of sources) {
    const body = typeof entry === 'string' ? entry : String(entry?.body ?? '');
    for (const episode of detectFixupEpisodes(body)) {
      episodes.push({ ...episode, source: `${sourcePrefix} ${kind} ${ordinal}` });
    }
  }
  return episodes;
}

/** @param {any} commit */
function commitMessageText(commit) {
  if (!commit || typeof commit !== 'object') return '';
  return [commit.messageHeadline, commit.messageBody, commit.message]
    .filter((/** @type {any} */ part) => typeof part === 'string' && part)
    .join('\n');
}

/**
 * Normalize a GitHub fixup artifact spelling to a bare lowercase commit SHA.
 * Supported spellings are the bare SHA and a `commit:`/`sha:` prefixed SHA.
 * The result is only meaningful when it passes {@link isFullCommitSha}.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeGitHubFixupArtifact(value) {
  return bareArtifactToken(value);
}

/** @param {string} value */
function isFullCommitSha(value) {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Backend artifact check handed to the shared fixup-episode validator: GitHub
 * fixup artifacts must normalize to a full 40-character commit SHA.
 *
 * @param {string} fieldLabel
 * @param {string} value
 * @returns {string|null}
 */
function githubFixupArtifactError(fieldLabel, value) {
  if (isFullCommitSha(normalizeGitHubFixupArtifact(value))) return null;
  return `'${fieldLabel}' must be a full 40-character commit SHA for the GitHub backend (got '${value}')`;
}

/**
 * Load and normalize the PR commit list for fixup attribution. Fails closed:
 * missing commit data or a commit without a resolvable full OID returns an
 * error instead of being silently skipped.
 *
 * @param {any} prData
 * @returns {{ commits: Array<{ oid: string, message: string }>, error: string|null }}
 */
function collectPrCommits(prData) {
  const raw = prData?.commits;
  if (!Array.isArray(raw)) {
    return {
      commits: [],
      error: 'pull request commit data is unavailable; cannot verify Maintainer Review Fixup attribution',
    };
  }
  const commits = [];
  for (const commit of raw) {
    const oid = String(commit?.oid ?? '').toLowerCase();
    if (!isFullCommitSha(oid)) {
      return {
        commits: [],
        error: 'pull request commit data is malformed (a commit is missing a full oid); cannot verify Maintainer Review Fixup attribution',
      };
    }
    commits.push({ oid, message: commitMessageText(commit) });
  }
  return { commits, error: null };
}

/**
 * Verify maintainer attribution for a current-head fixup episode. The relevant
 * commits are those in the base..resulting range of the PR commit list (or the
 * resulting commit alone when the base is not a PR commit); at least one must
 * carry the `Task:`/`Agent: maintainer` trailers, and when the audit knows a
 * canonical task identity the `Task:` trailer must name it. A trailer on an
 * unrelated commit elsewhere in the PR does not satisfy attribution.
 *
 * @param {any} prData
 * @param {{ fields: Record<string, string> }} episode
 * @param {string|null} canonicalTaskId
 * @returns {string[]}
 */
function validateCurrentFixupAttribution(prData, episode, canonicalTaskId) {
  const { commits, error } = collectPrCommits(prData);
  if (error) return [error];

  const resultingOid = normalizeGitHubFixupArtifact(episode.fields.resulting_artifact);
  const baseOid = normalizeGitHubFixupArtifact(episode.fields.base_artifact);

  const resultingIndex = commits.findIndex(commit => commit.oid === resultingOid);
  if (resultingIndex === -1) {
    return [
      `Maintainer Review Fixup resulting artifact '${resultingOid}' is not a commit on this pull request; cannot verify attribution`,
    ];
  }

  const baseIndex = commits.findIndex(commit => commit.oid === baseOid);
  const rangeStart = baseIndex !== -1 && baseIndex < resultingIndex ? baseIndex + 1 : resultingIndex;
  const range = commits.slice(rangeStart, resultingIndex + 1);

  const attributed = range.filter(commit => commitHasMaintainerFixupTrailers(commit.message));
  if (attributed.length === 0) {
    return [
      'a Maintainer Review Fixup is disclosed but no commit in the fixup range carries the Task: and Agent: maintainer attribution trailers',
    ];
  }

  if (canonicalTaskId) {
    const matchesTask = attributed.some(commit =>
      commitTaskTrailerValues(commit.message).some(value => value === canonicalTaskId)
    );
    if (!matchesTask) {
      return [
        `Maintainer Review Fixup commit attribution does not identify the task: no fixup-range commit carries a 'Task: ${canonicalTaskId}' trailer`,
      ];
    }
  }

  return [];
}

/**
 * Canonical task identity for trailer verification, when the linked task issue
 * declares one via YAML frontmatter `task_id`.
 *
 * @param {any} issueData
 * @returns {string|null}
 */
function resolveCanonicalTaskId(issueData) {
  const [frontmatter] = parseFrontmatter(String(issueData?.body ?? ''));
  const taskId = frontmatter?.task_id;
  if (typeof taskId !== 'string') return null;
  const trimmed = taskId.trim();
  return trimmed || null;
}

/**
 * @param {string} liveBody
 * @param {string} name
 * @returns {string[]}
 */
function markerValues(liveBody, name) {
  return [...liveBody.matchAll(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*\\S)[ \\t]*$`, 'gmi'))]
    .map(match => match[1].trim());
}

/**
 * Filter out lines inside fenced code blocks, indented code blocks, and
 * blockquotes so that example/quoted markers are not treated as live state.
 *
 * Fenced block matching is Markdown-consistent: the opening and closing fence
 * must use the same character (backtick or tilde), the closing fence must be
 * at least as long as the opening fence, and only trailing whitespace is
 * allowed after a closing fence. A line indented four or more spaces is
 * indented code, not a fence.
 *
 * @param {string} body
 * @returns {string} The body with non-live regions blanked out
 */
function filterLiveLines(body) {
  const lines = body.split(/\r?\n/);
  const result = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    // Markdown fences permit zero to three leading ASCII spaces. Do not use
    // trimStart() here: it also removes tabs and Unicode whitespace, which can
    // turn a non-fence line into a live opening or closing delimiter.
    const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.slice(leadingSpaces);

    // Tabs participate in Markdown indentation, but never in the fence's
    // optional zero-to-three-space prefix. Expand only the leading ASCII
    // space/tab run for the separate indented-code check.
    let indentColumns = 0;
    for (const char of line) {
      if (char === ' ') indentColumns += 1;
      else if (char === '\t') indentColumns += 4 - (indentColumns % 4);
      else break;
    }

    // Fenced code block detection (backtick or tilde). A valid opening fence
    // has 3+ delimiter characters and may carry an info string; backtick fences
    // cannot contain backticks in their info string. Closing fences must match
    // the delimiter character, be at least as long as the opening fence, and
    // have no non-whitespace suffix.
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch && leadingSpaces <= 3) {
      const ch = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      const rest = fenceMatch[2];
      if (!inFence) {
        // Opening fence: reject backtick info strings that contain backticks.
        if (!(ch === '`' && rest.includes('`'))) {
          inFence = true;
          fenceChar = ch;
          fenceLen = len;
          result.push('');
          continue;
        }
      } else if (ch === fenceChar && len >= fenceLen && /^[ \t]*$/.test(rest)) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
        result.push('');
        continue;
      }
    }

    if (inFence) {
      result.push('');
      continue;
    }

    // Blockquote: lines starting with >
    if (/^>/.test(trimmed)) {
      result.push('');
      continue;
    }

    // Indented code block: 4+ spaces on a non-empty line
    if (indentColumns >= 4 && trimmed.length > 0) {
      result.push('');
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}

/** @param {any} source */
function extractMarkerAuthor(source) {
  if (!source || typeof source === 'string') return null;
  const login = source?.author?.login ?? source?.user?.login ?? '';
  const authorType = source?.author?.type ?? source?.user?.type ?? '';
  if (!login) return null;
  return { login: String(login), type: String(authorType) };
}

/**
 * @param {unknown} body
 * @param {any} [source]
 */
export function parseReviewMarker(body, source = {}) {
  const liveBody = filterLiveLines(String(body ?? ''));
  const statuses = markerValues(liveBody, 'AGENT_REVIEW_STATUS');
  const modes = markerValues(liveBody, 'AGENT_REVIEW_MODE');
  const artifacts = markerValues(liveBody, 'AGENT_REVIEW_ARTIFACT');
  const humanRefs = markerValues(liveBody, 'AGENT_HUMAN_REVIEW_REF');
  if (statuses.length + modes.length + artifacts.length + humanRefs.length === 0) return null;
  const errors = [];
  for (const [name, values] of [['status', statuses], ['mode', modes], ['artifact', artifacts]]) {
    if (values.length !== 1) errors.push(`review marker must contain exactly one ${name}`);
  }
  if (humanRefs.length > 1) errors.push('review marker must contain at most one human review reference');
  const status = statuses[0] ?? '';
  const mode = modes[0] ?? '';
  const artifact = (artifacts[0] ?? '').toLowerCase();
  if (status && !['accepted', 'needs_revision'].includes(status)) errors.push(`unsupported review status '${status}'`);
  if (mode && !isValidReviewMode(mode)) errors.push(`unsupported review mode '${mode}'`);
  if (artifact && !/^[0-9a-f]{40}$/.test(artifact)) errors.push('review artifact must be a full 40-character PR head SHA');
  if (!/\[\[agent:\s*maintainer\]\]/i.test(liveBody)) {
    errors.push('agent review marker is missing the maintainer attribution trailer');
  }
  const author = extractMarkerAuthor(source);
  return { status, mode, artifact, humanReviewRef: humanRefs[0] ?? '', source, author, errors };
}

/** @param {any} prData */
export function collectReviewMarkers(prData) {
  const markerSources = [
    ...(Array.isArray(prData?.comments) ? prData.comments : []),
    ...(Array.isArray(prData?.reviews) ? prData.reviews : []),
  ];

  return markerSources
    .map(source => parseReviewMarker(typeof source === 'string' ? source : source?.body, source))
    .filter(marker => marker !== null);
}

/**
 * Normalize a raw GitHub REST review record into the internal review shape.
 *
 * @param {Record<string, any>} review
 * @returns {{ id: string, url: string, state: string, commitOid: string, author: { login: string, type: string } }}
 */
export function normalizeRestReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new GitHubReviewAuditError('GitHub review entry is malformed');
  }
  const id = review.id;
  const htmlUrl = review.html_url;
  const state = review.state;
  const commitId = review.commit_id;
  const user = review.user;

  if (id === undefined || id === null) {
    throw new GitHubReviewAuditError('GitHub review entry is missing id');
  }
  if (htmlUrl === undefined || htmlUrl === null) {
    throw new GitHubReviewAuditError('GitHub review entry is missing html_url');
  }
  if (state === undefined || state === null) {
    throw new GitHubReviewAuditError('GitHub review entry is missing state');
  }
  if (commitId === undefined || commitId === null) {
    throw new GitHubReviewAuditError('GitHub review entry is missing commit_id');
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new GitHubReviewAuditError('GitHub review entry is missing user');
  }

  return {
    id: String(id),
    url: String(htmlUrl),
    state: String(state).toUpperCase(),
    commitOid: String(commitId).toLowerCase(),
    author: {
      login: String(user.login ?? ''),
      type: String(user.type ?? ''),
    },
  };
}

/**
 * Validate that a referenced GitHub review is a genuine human review by a
 * different user bound to the current PR head, with an outcome-sensitive
 * required state.
 *
 * @param {string} ref The AGENT_HUMAN_REVIEW_REF value (review URL or ID)
 * @param {Array<any>} reviews Normalized PR reviews
 * @param {string} headRefOid The current PR head commit SHA (lowercase)
 * @param {{ login: string, type?: string }|null} expectedAccount The loop account to exclude
 * @param {string} expectedStatus The marker review status ('accepted' or 'needs_revision')
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateHumanReviewReference(ref, reviews, headRefOid, expectedAccount, expectedStatus) {
  const errors = [];
  if (!ref) {
    return { valid: false, errors: ['human review reference is empty'] };
  }

  const review = reviews.find(r => {
    const values = [r?.url, r?.id].filter(Boolean).map(String);
    return values.includes(ref);
  });

  if (!review) {
    return { valid: false, errors: [`AGENT_HUMAN_REVIEW_REF '${ref}' does not match any review on this pull request`] };
  }

  const login = String(review?.author?.login ?? '');
  const authorType = String(review?.author?.type ?? '');
  const state = String(review?.state ?? '');
  const commitOid = String(review?.commitOid ?? '').toLowerCase();

  if (!login) {
    errors.push('human review author has no login; cannot verify identity');
  }

  // Defense-in-depth: a login ending in [bot] is a bot indicator regardless of the declared type
  if (/\[bot\]$/i.test(login)) {
    errors.push(`human review author '${login}' appears to be a bot account (login ends with [bot])`);
  }

  // Only an explicit GitHub User type counts as a human
  const lowerType = authorType.toLowerCase();
  if (!lowerType) {
    errors.push(`human review author '${login}' has no explicit type; cannot mechanically confirm human identity`);
  } else if (lowerType !== 'user') {
    errors.push(`human review author '${login}' has type '${authorType}'; expected 'User'`);
  }

  // Different from the loop account
  const expectedLogin = expectedAccount?.login ? String(expectedAccount.login).toLowerCase() : null;
  if (expectedLogin && login && login.toLowerCase() === expectedLogin) {
    errors.push(`human review author '${login}' must differ from the loop account '${String(expectedAccount?.login ?? '')}'`);
  }

  // Outcome-sensitive state
  const requiredState = expectedStatus === 'needs_revision' ? 'CHANGES_REQUESTED' : 'APPROVED';
  if (state !== requiredState) {
    errors.push(`human review state is '${state}'; expected '${requiredState}'`);
  }

  // Must be bound to the current PR head
  if (!commitOid) {
    errors.push('human review has no commit binding; cannot verify it reviews the current PR head');
  } else if (commitOid !== headRefOid) {
    errors.push(`human review commit '${commitOid}' does not match current PR head '${headRefOid}'`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Coerce a frontmatter value into a string suitable for the shared boolean
 * parser. A bare `key:` with no value parses to an empty object via the
 * frontmatter parser; all structured values are invalid for this boolean.
 *
 * @param {unknown} value
 * @returns {string|null} the scalar string, '' for an empty value, or null when
 *   the value is structured and therefore not a well-formed boolean.
 */
function frontmatterScalarString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    return null;
  }
  return String(value);
}

/**
 * Count canonical top-level independent-review fields in a valid leading
 * frontmatter block. The generic frontmatter parser intentionally lets later
 * duplicate keys win, but an assurance gate must reject ambiguous duplicates.
 *
 * @param {string} raw
 * @returns {number|null} occurrence count, or null when the leading block is
 *   absent or malformed.
 */
function independentReviewFrontmatterCount(raw) {
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  return match[1]
    .split(/\r?\n/)
    .filter(line => /^independent_review_required[ \t]*:/.test(line))
    .length;
}

/**
 * Determine whether the linked task issue requires independent review.
 *
 * YAML frontmatter `independent_review_required: true|false` is the canonical
 * representation. The legacy `AGENT_INDEPENDENT_REVIEW_REQUIRED: true` body
 * marker remains a supported compatibility form. Both share the single boolean
 * parser used by the files backend (`parseIndependentReviewRequired`) so the two
 * surfaces cannot drift.
 *
 * Semantics:
 *   - neither representation present -> not required;
 *   - YAML true / marker true        -> required;
 *   - YAML false                     -> not required;
 *   - both present, same meaning     -> valid;
 *   - both present, conflicting      -> fail closed;
 *   - malformed YAML value           -> fail closed;
 *   - malformed or multiple markers  -> fail closed.
 *
 * Marker-looking lines inside fenced code, blockquotes, or indented code are
 * ignored exactly as elsewhere in this module (via `filterLiveLines`).
 *
 * @param {string} issueBody
 * @returns {{ value: boolean, error: string|null }}
 */
export function taskRequiresIndependentReview(issueBody) {
  const raw = String(issueBody ?? '');

  // Canonical YAML frontmatter representation.
  const [frontmatter] = parseFrontmatter(raw);
  const startsWithFrontmatter = /^---[ \t]*\r?\n/.test(raw);
  const fieldCount = independentReviewFrontmatterCount(raw);
  if (startsWithFrontmatter && frontmatter === null && /^independent_review_required[ \t]*:/m.test(raw)) {
    return {
      value: false,
      error: 'task issue has malformed YAML frontmatter containing independent_review_required',
    };
  }
  if (fieldCount !== null && fieldCount > 1) {
    return {
      value: false,
      error: 'task issue has duplicate independent_review_required frontmatter fields (expected exactly one true or false value)',
    };
  }

  let yamlValue = null;
  if (frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, 'independent_review_required')) {
    const candidate = frontmatterScalarString(frontmatter.independent_review_required);
    const parsed = candidate === null ? { value: null, malformed: true } : parseIndependentReviewRequired(candidate);
    if (parsed.malformed || parsed.value === null) {
      return {
        value: false,
        error: 'task issue has malformed independent_review_required frontmatter value (expected true or false)',
      };
    }
    yamlValue = parsed.value; // true | false | null (empty)
  }

  // Legacy compatibility marker. Only `true` is recognized; any other value, or
  // more than one marker, is malformed and fails closed.
  const liveBody = filterLiveLines(raw);
  const markerRaw = markerValues(liveBody, 'AGENT_INDEPENDENT_REVIEW_REQUIRED');
  let markerValue = null;
  if (markerRaw.length > 1) {
    return { value: false, error: 'task issue has malformed AGENT_INDEPENDENT_REVIEW_REQUIRED marker (expected one true marker)' };
  }
  if (markerRaw.length === 1) {
    if (parseIndependentReviewRequired(markerRaw[0]).value === true) {
      markerValue = true;
    } else {
      return { value: false, error: 'task issue has malformed AGENT_INDEPENDENT_REVIEW_REQUIRED marker (expected one true marker)' };
    }
  }

  // Conflicting representations fail closed.
  if (yamlValue !== null && markerValue !== null && yamlValue !== markerValue) {
    return {
      value: false,
      error:
        `task issue has conflicting independent-review signals: frontmatter independent_review_required is ${yamlValue} ` +
        `but AGENT_INDEPENDENT_REVIEW_REQUIRED marker is ${markerValue}`,
    };
  }

  return { value: yamlValue === true || markerValue === true, error: null };
}

const VALID_EXPECTED_STATUSES = new Set(['accepted', 'needs_revision']);

/**
 * @param {object} params
 * @param {any} params.prData
 * @param {any} params.issueData
 * @param {Array<any>} [params.taskPrData]
 * @param {Array<any>} [params.humanReviews]
 * @param {string} [params.expectedStatus]
 * @param {any} [params.expectedAccount]
 */
export function evaluateGitHubReviewAudit({
  prData,
  issueData,
  taskPrData = [],
  humanReviews = [],
  expectedStatus = 'accepted',
  expectedAccount = null,
}) {
  if (!VALID_EXPECTED_STATUSES.has(expectedStatus)) {
    return {
      ok: false,
      provenanceValid: false,
      acceptanceReady: false,
      expectedStatus,
      errors: [`invalid --expect-status '${expectedStatus}'; expected one of: ${[...VALID_EXPECTED_STATUSES].join(', ')}`],
      pr: prData?.number ?? null,
      issue: issueData?.number ?? null,
      headRefOid: '',
      independentReviewRequired: false,
      outcome: null,
    };
  }

  const errors = [];
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  const markers = collectReviewMarkers(prData);
  const requirement = taskRequiresIndependentReview(issueData?.body);
  if (!headRefOid) errors.push('PR head SHA is unavailable; cannot audit review provenance');
  if (requirement.error) errors.push(requirement.error);
  for (const marker of markers) errors.push(...marker.errors);

  // Phase 2: Verify marker author identity
  const expectedLogin = expectedAccount?.login ? String(expectedAccount.login).toLowerCase() : null;
  const current = markers.filter(marker => marker.artifact === headRefOid && marker.errors.length === 0);
  if (current.length === 1) {
    const marker = current[0];
    if (!expectedLogin) {
      errors.push('cannot verify marker author: expected loop account could not be resolved');
    } else if (!marker.author) {
      errors.push('marker author identity is missing; cannot verify loop account ownership');
    } else {
      const markerLogin = String(marker.author.login).toLowerCase();
      if (markerLogin !== expectedLogin) {
        errors.push(`marker author '${marker.author.login}' does not match expected loop account '${expectedAccount.login}'`);
      }
    }
  }

  if (current.length === 0) {
    if (markers.some(marker => marker.artifact && marker.artifact !== headRefOid)) {
      errors.push('review provenance is stale: no valid marker reviews the current PR head');
    } else {
      errors.push('no valid review marker for the current PR head');
    }
  }
  if (current.length > 1) errors.push('contradictory or duplicate valid review markers for the current PR head');
  const outcome = current.length === 1 ? current[0] : null;
  if (outcome && requirement.value && outcome.status === 'accepted' && !satisfiesIndependentReview(outcome.mode)) {
    errors.push('independent review is required but single_agent_fallback cannot accept this PR');
  }
  if (outcome?.mode === 'independent_human') {
    if (!outcome.humanReviewRef) {
      errors.push('independent_human review marker requires AGENT_HUMAN_REVIEW_REF');
    } else {
      const humanValidation = validateHumanReviewReference(outcome.humanReviewRef, humanReviews, headRefOid, expectedAccount, outcome.status);
      errors.push(...humanValidation.errors);
    }
  }

  // Durable Maintainer Review Fixup disclosure. A fallback review mode alone does
  // not prove a fixup; the `## Maintainer Review Fixup` subsection does. Every
  // live episode in PR history is shape-validated and counts toward the
  // at-most-one-per-task rule. Only a CURRENT-HEAD episode (normalized resulting
  // artifact equals the exact current PR head) binds the current review: it
  // requires AGENT_REVIEW_MODE: single_agent_fallback and verified maintainer
  // commit attribution in the fixup range, failing closed when commit data is
  // unavailable. A historical episode (resulting artifact is not the current
  // head -- e.g. a fixup superseded by an engineer revision) does not force the
  // current review mode; a later genuinely delegated review may use
  // host_subagent. Historical episodes are not attribution-checked because a
  // superseded revision may no longer be reachable from the PR commit list.
  const currentPrFixupEpisodes = collectFixupEpisodes(prData);
  const currentPrNumber = Number(prData?.number);
  const relatedPrFixupEpisodes = (Array.isArray(taskPrData) ? taskPrData : [])
    .filter(relatedPr => Number(relatedPr?.number) !== currentPrNumber)
    .flatMap(relatedPr => collectFixupEpisodes(relatedPr));
  const fixupEpisodes = [...relatedPrFixupEpisodes, ...currentPrFixupEpisodes];
  const fixupPresent = fixupEpisodes.length > 0;
  let currentFixup = null;
  if (fixupPresent) {
    for (const episode of fixupEpisodes) {
      errors.push(
        ...validateFixupEpisode(episode, {
          subject: `PR #${prData?.number ?? '?'} ${episode.source}`,
          validateArtifact: githubFixupArtifactError,
        })
      );
    }

    if (fixupEpisodes.length > 1) {
      errors.push('more than one Maintainer Review Fixup subsection is recorded for this pull request; at most one episode is allowed per task');
    }

    const currentEpisodes = headRefOid
      ? currentPrFixupEpisodes.filter(
        episode => normalizeGitHubFixupArtifact(episode.fields.resulting_artifact) === headRefOid
      )
      : [];
    currentFixup = currentEpisodes[0] ?? null;

    if (currentFixup) {
      if (outcome && outcome.mode !== 'single_agent_fallback') {
        errors.push(
          `a Maintainer Review Fixup is disclosed for the current PR head but the current review mode is '${outcome.mode}'; a self-accepted fixup must record AGENT_REVIEW_MODE: single_agent_fallback`
        );
      }
      errors.push(...validateCurrentFixupAttribution(prData, currentFixup, resolveCanonicalTaskId(issueData)));
    }
  }

  const provenanceValid = errors.length === 0;
  const acceptanceReady = provenanceValid && outcome?.status === 'accepted';
  const statusMatch = outcome?.status === expectedStatus;
  const ok = provenanceValid && statusMatch;

  if (provenanceValid && !statusMatch) {
    errors.push(`current review outcome is '${outcome?.status}'; expected '${expectedStatus}'`);
  }

  return {
    ok,
    provenanceValid,
    acceptanceReady,
    expectedStatus,
    errors,
    pr: prData?.number ?? null,
    issue: issueData?.number ?? null,
    headRefOid,
    independentReviewRequired: requirement.value,
    maintainerFixup: fixupPresent,
    maintainerFixupEpisodeCount: fixupEpisodes.length,
    maintainerFixupCurrent: currentFixup !== null,
    outcome: outcome && { status: outcome.status, mode: outcome.mode, artifact: outcome.artifact, humanReviewRef: outcome.humanReviewRef, author: outcome.author?.login ?? null },
  };
}

/**
 * @param {Function} commandRunner
 * @param {string[]} args
 * @returns {any}
 */
function runGh(commandRunner, args) {
  try {
    return runGhJson(commandRunner, args);
  } catch (error) {
    throw new GitHubReviewAuditError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Resolve the canonical owner/name for the repository under audit.
 *
 * Honors an explicit `--repo` override. Otherwise asks `gh` for the current
 * repository. This relies on the active `gh` host configuration; enterprise
 * hosts must be selected via `gh auth switch` or an explicit `--repo` that
 * disambiguates the host, because this module does not parse hostnames from
 * remote URLs or enterprise config on its own.
 *
 * @param {Function} commandRunner
 * @param {string} [explicitRepo]
 * @returns {string}
 */
function resolveRepoOwnerName(commandRunner, explicitRepo) {
  if (explicitRepo) return String(explicitRepo);
  const result = runGh(commandRunner, ['repo', 'view', '--json', 'nameWithOwner']);
  const nameWithOwner = result?.nameWithOwner;
  if (!nameWithOwner) {
    throw new GitHubReviewAuditError('cannot resolve current repository owner/name; pass --repo <owner/name>');
  }
  return String(nameWithOwner);
}

/**
 * Fetch all pull request reviews from the GitHub REST API and normalize them
 * into the internal review shape. Uses `gh api --paginate --slurp` so the
 * response is an array of pages; each page is flattened before normalization.
 *
 * @param {Function} commandRunner
 * @param {string} owner
 * @param {string} repo
 * @param {number|string} prNumber
 * @returns {Array<{ id: string, url: string, state: string, commitOid: string, author: { login: string, type: string } }>}
 */
function fetchRestReviews(commandRunner, owner, repo, prNumber) {
  const args = ['api', '--paginate', '--slurp', `repos/${owner}/${repo}/pulls/${prNumber}/reviews`];
  const result = runGh(commandRunner, args);
  if (!Array.isArray(result)) {
    throw new GitHubReviewAuditError('GitHub review endpoint returned a non-array response');
  }
  const flattened = result.flat();
  return flattened.map(normalizeRestReview);
}

/**
 * Fetch every same-repository pull request cross-referenced from the linked task
 * issue, excluding the PR currently under audit. This is the task-wide durable
 * history used to enforce the one-fixup-per-task bound across replacement PRs.
 * The lookup is only required when the current PR records a fixup candidate.
 *
 * @param {Function} commandRunner
 * @param {string} owner
 * @param {string} repoName
 * @param {number} issueNumber
 * @param {number|string} currentPrNumber
 * @param {string} [repoOverride]
 * @returns {Array<object>}
 */
function fetchTaskLinkedPullRequests(commandRunner, owner, repoName, issueNumber, currentPrNumber, repoOverride) {
  const timeline = runGh(commandRunner, [
    'api',
    '--paginate',
    '--slurp',
    '-H',
    'Accept: application/vnd.github+json',
    `repos/${owner}/${repoName}/issues/${issueNumber}/timeline`,
  ]);
  if (!Array.isArray(timeline)) {
    throw new GitHubReviewAuditError('GitHub issue timeline endpoint returned a non-array response; cannot enforce the task-wide Maintainer Review Fixup limit');
  }

  const currentNumber = Number(currentPrNumber);
  const linkedNumbers = new Set();
  for (const event of timeline.flat()) {
    const sourceIssue = event?.source?.issue;
    if (!sourceIssue?.pull_request) continue;
    const sourceRepo = String(sourceIssue?.repository?.full_name ?? '').toLowerCase();
    if (sourceRepo && sourceRepo !== `${owner}/${repoName}`.toLowerCase()) continue;
    const number = Number(sourceIssue?.number);
    if (Number.isInteger(number) && number > 0 && number !== currentNumber) linkedNumbers.add(number);
  }

  const related = [];
  for (const number of [...linkedNumbers].sort((a, b) => a - b)) {
    const args = ['pr', 'view', String(number), '--json', 'number,comments,reviews'];
    if (repoOverride) args.push('--repo', repoOverride);
    related.push(runGh(commandRunner, args));
  }
  return related;
}

/**
 * Strict issue resolver for review-audit. Unlike the generic resolveIssueNumber,
 * this enforces that the selected issue must be one of the PR's closing references.
 *
 * @param {Record<string, any>} prData The PR data from GitHub
 * @param {string|number|undefined} explicitIssue The --issue value, if provided
 * @returns {{ issueNumber: number, closingIssues: number[] }}
 * @throws {GitHubReviewAuditError}
 */
function resolveReviewAuditIssue(prData, explicitIssue) {
  const refs = Array.isArray(prData?.closingIssuesReferences) ? prData.closingIssuesReferences : [];
  const closingIssues = refs
    .map((/** @type {any} */ r) => r?.number)
    .filter((/** @type {unknown} */ n) => Number.isInteger(n));

  if (closingIssues.length === 0) {
    throw new GitHubReviewAuditError(
      'PR has no closing issue reference (e.g. "Closes #<n>"); the review audit cannot determine the linked task issue'
    );
  }

  if (explicitIssue !== undefined && explicitIssue !== null && explicitIssue !== '') {
    const parsed = Number(explicitIssue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new GitHubReviewAuditError(`--issue must be a positive integer, got '${explicitIssue}'`);
    }
    if (!closingIssues.includes(parsed)) {
      throw new GitHubReviewAuditError(
        `--issue ${parsed} is not one of the PR's closing issues (${closingIssues.map(n => `#${n}`).join(', ')}); ` +
        `the review audit requires the issue to be linked via a closing reference`
      );
    }
    return { issueNumber: parsed, closingIssues };
  }

  // No explicit issue
  if (closingIssues.length === 1) {
    return { issueNumber: closingIssues[0], closingIssues };
  }

  throw new GitHubReviewAuditError(
    `PR closes multiple issues (${closingIssues.map(n => `#${n}`).join(', ')}); pass --issue <number> to disambiguate`
  );
}

/**
 * @param {{
 *   pr?: string|number,
 *   issue?: string|number,
 *   repo?: string,
 *   expectedStatus?: string,
 *   commandRunner?: Function,
 * }} [options]
 */
export function runGitHubReviewAudit({ pr, issue, repo, expectedStatus, commandRunner = defaultGhCommandRunner } = {}) {
  const prNumber = Number(pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new GitHubReviewAuditError('--pr must be a positive integer');

  // Resolve the authenticated loop account
  /** @type {any} */
  let expectedAccount;
  try {
    expectedAccount = runGh(commandRunner, ['api', 'user', '--jq', `{"login":.login,"type":.type}`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitHubReviewAuditError(`cannot resolve authenticated GitHub account: ${message}`);
  }
  if (!expectedAccount?.login) {
    throw new GitHubReviewAuditError('authenticated GitHub account has no login; cannot verify marker authorship');
  }

  const prArgs = ['pr', 'view', String(prNumber), '--json', PR_FIELDS];
  if (repo) prArgs.push('--repo', repo);
  const prData = runGh(commandRunner, prArgs);

  let issueNumber, closingIssues;
  try {
    ({ issueNumber, closingIssues } = resolveReviewAuditIssue(prData, issue));
  } catch (error) {
    throw new GitHubReviewAuditError(error instanceof Error ? error.message : String(error));
  }

  const issueArgs = ['issue', 'view', String(issueNumber), '--json', ISSUE_FIELDS];
  if (repo) issueArgs.push('--repo', repo);
  const issueData = runGh(commandRunner, issueArgs);

  // The one-fixup bound is task-wide, not PR-local. When this PR records a
  // candidate episode, inspect every same-repository PR cross-referenced from
  // the linked task issue so a replacement PR cannot silently receive a second
  // fixup. Fail closed if that task history cannot be loaded.
  /** @type {Array<any>} */
  let taskPrData = [];
  if (collectFixupEpisodes(prData).length > 0) {
    const ownerName = resolveRepoOwnerName(commandRunner, repo);
    const parts = String(ownerName).split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new GitHubReviewAuditError(`cannot resolve repository owner/name: '${ownerName}'`);
    }
    taskPrData = fetchTaskLinkedPullRequests(
      commandRunner,
      parts[0],
      parts[1],
      issueNumber,
      prNumber,
      repo
    );
  }

  // Determine whether the current valid marker requires live human review data.
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  const markers = collectReviewMarkers(prData);
  const current = markers.filter(marker => marker.artifact === headRefOid && marker.errors.length === 0);
  const currentMarker = current.length === 1 ? current[0] : null;
  const requirement = taskRequiresIndependentReview(issueData?.body);

  /** @type {Array<any>} */
  let humanReviews = [];
  if (currentMarker?.mode === 'independent_human') {
    try {
      const ownerName = resolveRepoOwnerName(commandRunner, repo);
      const parts = String(ownerName).split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new GitHubReviewAuditError(`cannot resolve repository owner/name: '${ownerName}'`);
      }
      const [owner, repoName] = parts;
      humanReviews = fetchRestReviews(commandRunner, owner, repoName, prNumber);
    } catch (error) {
      return {
        ok: false,
        provenanceValid: false,
        acceptanceReady: false,
        expectedStatus: expectedStatus ?? 'accepted',
        errors: [error instanceof Error ? error.message : String(error)],
        pr: prData?.number ?? null,
        issue: issueData?.number ?? null,
        headRefOid,
        independentReviewRequired: requirement.value,
        outcome: null,
        closingIssues,
      };
    }
  }

  const result = evaluateGitHubReviewAudit({ prData, issueData, taskPrData, humanReviews, expectedStatus, expectedAccount });
  return { ...result, closingIssues };
}
