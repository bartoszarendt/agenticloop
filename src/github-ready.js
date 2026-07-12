/**
 * agenticloop github-ready - composite, read-only pre-merge acceptance gate.
 *
 * Combines the two existing GitHub gates into one verdict so the orchestrator
 * has a single command to run before merging a GitHub-backed implementation PR:
 *
 *   1. the evidence preflight (`runPreflight`) - the PR body carries final-state
 *      evidence for every required check, tied to the current head;
 *   2. the review provenance audit (`runGitHubReviewAudit`, expecting accepted) -
 *      an artifact-bound, correctly authored, accepted review exists for the
 *      current PR head.
 *
 * It is strictly read-only: it reuses the two functions in-process (each only
 * ever runs read-only `gh` reads) rather than shelling out to the CLI, and it
 * never merges, comments, or edits GitHub state. Both checks must pass, and they
 * must agree on the PR head and linked issue, or the gate fails closed.
 */

import { defaultGhCommandRunner } from './gh-helpers.js';
import { runPreflight, PreflightError } from './github-preflight.js';
import { runGitHubReviewAudit, GitHubReviewAuditError } from './github-review-audit.js';

export class GitHubReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubReadyError';
  }
}

/**
 * Run the composite readiness gate for a pull request.
 *
 * @param {object} options
 * @param {number|string} options.pr        PR number (required).
 * @param {number|string} [options.issue]   Linked task issue override.
 * @param {string} [options.repo]           owner/name repo override.
 * @param {Function} [options.commandRunner] Injectable `gh` runner for testing.
 * @returns {{
 *   ok: boolean,
 *   readyForMerge: boolean,
 *   pr: number,
 *   issue: number|null,
 *   headRefOid: string,
 *   preflight: { ok: boolean, errors: string[] },
 *   reviewAudit: { ok: boolean, acceptanceReady: boolean, independentReviewRequired: boolean, errors: string[] },
 *   errors: string[],
 * }}
 * @throws {GitHubReadyError} when the PR argument is not a positive integer.
 */
export function runGitHubReady({ pr, issue, repo, commandRunner = defaultGhCommandRunner } = {}) {
  const prNumber = Number(pr);
  if (pr === undefined || pr === null || pr === '' || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new GitHubReadyError(`--pr must be a positive integer, got '${pr}'`);
  }

  // 1. Evidence preflight.
  let preflight = { ok: false, errors: [], issue: null, headRefOid: '' };
  try {
    const result = runPreflight({ pr: prNumber, issue, repo, commandRunner });
    preflight = {
      ok: Boolean(result.ok),
      errors: Array.isArray(result.errors) ? result.errors : [],
      issue: result.issue ?? null,
      headRefOid: String(result.headRefOid ?? ''),
    };
  } catch (error) {
    if (!(error instanceof PreflightError)) throw error;
    preflight = { ok: false, errors: [error.message], issue: null, headRefOid: '' };
  }

  // 2. Review provenance audit, expecting an accepted current-head review.
  let reviewAudit = { ok: false, acceptanceReady: false, independentReviewRequired: false, errors: [], issue: null, headRefOid: '' };
  try {
    const result = runGitHubReviewAudit({ pr: prNumber, issue, repo, expectedStatus: 'accepted', commandRunner });
    reviewAudit = {
      ok: Boolean(result.ok),
      acceptanceReady: Boolean(result.acceptanceReady),
      independentReviewRequired: Boolean(result.independentReviewRequired),
      errors: Array.isArray(result.errors) ? result.errors : [],
      issue: result.issue ?? null,
      headRefOid: String(result.headRefOid ?? ''),
    };
  } catch (error) {
    if (!(error instanceof GitHubReviewAuditError)) throw error;
    reviewAudit = { ok: false, acceptanceReady: false, independentReviewRequired: false, errors: [error.message], issue: null, headRefOid: '' };
  }

  // Conservative cross-check: the two gates must describe the same PR head and
  // linked issue, or we refuse to certify readiness even if each passed alone.
  const errors = [];
  if (preflight.headRefOid && reviewAudit.headRefOid && preflight.headRefOid !== reviewAudit.headRefOid) {
    errors.push(
      `preflight and review audit resolved different PR heads ` +
      `(${preflight.headRefOid} vs ${reviewAudit.headRefOid}); refusing to certify merge readiness`
    );
  }
  if (preflight.issue !== null && reviewAudit.issue !== null && preflight.issue !== reviewAudit.issue) {
    errors.push(
      `preflight and review audit resolved different linked issues ` +
      `(#${preflight.issue} vs #${reviewAudit.issue}); refusing to certify merge readiness`
    );
  }

  const readyForMerge = preflight.ok && reviewAudit.ok && errors.length === 0;

  return {
    ok: readyForMerge,
    readyForMerge,
    pr: prNumber,
    issue: reviewAudit.issue ?? preflight.issue ?? null,
    headRefOid: reviewAudit.headRefOid || preflight.headRefOid || '',
    preflight: { ok: preflight.ok, errors: preflight.errors },
    reviewAudit: {
      ok: reviewAudit.ok,
      acceptanceReady: reviewAudit.acceptanceReady,
      independentReviewRequired: reviewAudit.independentReviewRequired,
      errors: reviewAudit.errors,
    },
    errors,
  };
}

/**
 * Format the human-readable summary lines for a github-ready result. Error
 * detail lines are returned separately so the CLI can route them to stderr.
 *
 * @param {ReturnType<typeof runGitHubReady>} result
 * @returns {{ summary: string[], errors: string[] }}
 */
export function formatGitHubReadyReport(result) {
  const summary = [
    'agenticloop github-ready',
    '='.repeat(50),
    `  PR: #${result.pr}`,
    `  linked issue: ${result.issue === null ? 'none' : `#${result.issue}`}`,
    `  current head: ${result.headRefOid || 'unknown'}`,
    `  evidence preflight: ${result.preflight.ok ? 'passed' : 'FAILED'}`,
    `  review audit: ${result.reviewAudit.ok ? 'passed' : 'FAILED'}`,
    `  independent review required: ${result.reviewAudit.independentReviewRequired}`,
    `  ready for merge: ${result.readyForMerge ? 'yes' : 'no'}`,
  ];

  const errors = [];
  for (const error of result.preflight.errors) errors.push(`preflight: ${error}`);
  for (const error of result.reviewAudit.errors) errors.push(`review-audit: ${error}`);
  for (const error of result.errors) errors.push(error);

  return { summary, errors };
}
