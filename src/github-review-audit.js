// @ts-check

import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { resolveIssueNumber } from './github-preflight.js';
import { REVIEW_MODES, isValidReviewMode, satisfiesIndependentReview } from './review-provenance.js';

export class GitHubReviewAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubReviewAuditError';
  }
}

const PR_FIELDS = ['number', 'headRefOid', 'closingIssuesReferences', 'comments', 'reviews'].join(',');
const ISSUE_FIELDS = ['number', 'body'].join(',');

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

function extractMarkerAuthor(source) {
  if (!source || typeof source === 'string') return null;
  const login = source?.author?.login ?? source?.user?.login ?? '';
  const authorType = source?.author?.type ?? source?.user?.type ?? '';
  if (!login) return null;
  return { login: String(login), type: String(authorType) };
}

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

export function collectReviewMarkers(prData) {
  const markerSources = [
    ...(Array.isArray(prData?.comments) ? prData.comments : []),
    ...(Array.isArray(prData?.reviews) ? prData.reviews : []),
  ];

  return markerSources
    .map(source => parseReviewMarker(typeof source === 'string' ? source : source?.body, source))
    .filter(Boolean);
}

/**
 * Normalize a raw GitHub REST review record into the internal review shape.
 *
 * @param {object} review
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
 * @param {Array} reviews Normalized PR reviews
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
    errors.push(`human review author '${login}' must differ from the loop account '${expectedAccount.login}'`);
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

export function taskRequiresIndependentReview(issueBody) {
  const liveBody = filterLiveLines(String(issueBody ?? ''));
  const values = markerValues(liveBody, 'AGENT_INDEPENDENT_REVIEW_REQUIRED');
  if (values.length > 1 || (values.length === 1 && values[0] !== 'true')) {
    return { value: false, error: 'task issue has malformed AGENT_INDEPENDENT_REVIEW_REQUIRED marker (expected one true marker)' };
  }
  return { value: values.length === 1, error: null };
}

const VALID_EXPECTED_STATUSES = new Set(['accepted', 'needs_revision']);

export function evaluateGitHubReviewAudit({ prData, issueData, humanReviews = [], expectedStatus = 'accepted', expectedAccount = null }) {
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
    outcome: outcome && { status: outcome.status, mode: outcome.mode, artifact: outcome.artifact, humanReviewRef: outcome.humanReviewRef, author: outcome.author?.login ?? null },
  };
}

function runGh(commandRunner, args) {
  try { return runGhJson(commandRunner, args); } catch (error) { throw new GitHubReviewAuditError(error.message); }
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
 * @returns {Array<{ id, url, state, commitOid, author }>}
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
 * Strict issue resolver for review-audit. Unlike the generic resolveIssueNumber,
 * this enforces that the selected issue must be one of the PR's closing references.
 *
 * @param {object} prData The PR data from GitHub
 * @param {string|number|undefined} explicitIssue The --issue value, if provided
 * @returns {{ issueNumber: number, closingIssues: number[] }}
 * @throws {GitHubReviewAuditError}
 */
function resolveReviewAuditIssue(prData, explicitIssue) {
  const refs = Array.isArray(prData?.closingIssuesReferences) ? prData.closingIssuesReferences : [];
  const closingIssues = refs.map(r => r?.number).filter(n => Number.isInteger(n));

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

export function runGitHubReviewAudit({ pr, issue, repo, expectedStatus, commandRunner = defaultGhCommandRunner } = {}) {
  if (!Number.isInteger(Number(pr)) || Number(pr) <= 0) throw new GitHubReviewAuditError('--pr must be a positive integer');

  // Resolve the authenticated loop account
  let expectedAccount;
  try {
    expectedAccount = runGh(commandRunner, ['api', 'user', '--jq', `{"login":.login,"type":.type}`]);
  } catch (error) {
    throw new GitHubReviewAuditError(`cannot resolve authenticated GitHub account: ${error.message}`);
  }
  if (!expectedAccount?.login) {
    throw new GitHubReviewAuditError('authenticated GitHub account has no login; cannot verify marker authorship');
  }

  const prArgs = ['pr', 'view', String(pr), '--json', PR_FIELDS];
  if (repo) prArgs.push('--repo', repo);
  const prData = runGh(commandRunner, prArgs);

  let issueNumber, closingIssues;
  try { ({ issueNumber, closingIssues } = resolveReviewAuditIssue(prData, issue)); } catch (error) { throw new GitHubReviewAuditError(error.message); }

  const issueArgs = ['issue', 'view', String(issueNumber), '--json', ISSUE_FIELDS];
  if (repo) issueArgs.push('--repo', repo);
  const issueData = runGh(commandRunner, issueArgs);

  // Determine whether the current valid marker requires live human review data.
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  const markers = collectReviewMarkers(prData);
  const current = markers.filter(marker => marker.artifact === headRefOid && marker.errors.length === 0);
  const currentMarker = current.length === 1 ? current[0] : null;
  const requirement = taskRequiresIndependentReview(issueData?.body);

  let humanReviews = [];
  if (currentMarker?.mode === 'independent_human') {
    try {
      const ownerName = resolveRepoOwnerName(commandRunner, repo);
      const parts = String(ownerName).split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new GitHubReviewAuditError(`cannot resolve repository owner/name: '${ownerName}'`);
      }
      const [owner, repoName] = parts;
      humanReviews = fetchRestReviews(commandRunner, owner, repoName, pr);
    } catch (error) {
      return {
        ok: false,
        provenanceValid: false,
        acceptanceReady: false,
        expectedStatus: expectedStatus ?? 'accepted',
        errors: [error.message],
        pr: prData?.number ?? null,
        issue: issueData?.number ?? null,
        headRefOid,
        independentReviewRequired: requirement.value,
        outcome: null,
        closingIssues,
      };
    }
  }

  const result = evaluateGitHubReviewAudit({ prData, issueData, humanReviews, expectedStatus, expectedAccount });
  return { ...result, closingIssues };
}
