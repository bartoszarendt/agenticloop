/**
 * agenticloop github-preflight - pre-review evidence gate for GitHub-backed work.
 *
 * Mechanically verifies that a pull request body carries final-state
 * implementation evidence for every required check named in the linked task
 * issue, tied to the current PR head commit. This closes the gap where
 * `agenticloop validate` inspects local config but never the live PR body.
 *
 * The module keeps parsing and comparison pure and testable. The only impure
 * surface is the GitHub CLI (`gh`), which is isolated behind an injectable
 * command runner so the evaluation logic can be exercised directly.
 *
 * Pure helpers (exported):
 *   - extractSectionBody(markdown, heading)
 *   - parseRequiredChecks(issueBody)
 *   - parsePrEvidence(prBody)
 *   - extractHeadMarker(text)
 *   - normalizeCheckText(text)
 *   - isSuccessfulStatusCheck(check) / statusCheckName(check)
 *   - evaluatePreflight({ prData, issueData })
 *
 * Impure entry point:
 *   - runPreflight({ pr, issue, repo, commandRunner })
 */

import { spawnSync } from 'node:child_process';

export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
  }
}

const VALID_VERDICTS = new Set(['passed', 'failed', 'blocked', 'not run']);

const PR_FIELDS = [
  'number',
  'body',
  'headRefOid',
  'files',
  'closingIssuesReferences',
  'statusCheckRollup',
].join(',');

const ISSUE_FIELDS = ['number', 'body', 'title'].join(',');

/**
 * Extract the body of a Markdown section by its exact heading line, stopping at
 * the next heading of the same or higher level. Heading match is on the trimmed
 * line so leading indentation does not matter.
 */
export function extractSectionBody(markdown, heading) {
  const text = String(markdown ?? '');
  const trimmedHeading = heading.trim();
  const headingLevel = (trimmedHeading.match(/^(#{1,6})/) ?? [])[1]?.length ?? 2;
  const breakRe = new RegExp(`^#{1,${headingLevel}}\\s`);
  const lines = text.split('\n');
  let inSection = false;
  const bodyLines = [];
  for (const line of lines) {
    if (line.trim() === trimmedHeading) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (breakRe.test(line.trim())) break;
      bodyLines.push(line);
    }
  }
  return inSection ? bodyLines.join('\n').trim() : null;
}

/**
 * Normalize check/command text for comparison only. Strips Markdown code
 * backticks, normalizes backslashes to forward slashes for command-like paths,
 * collapses whitespace, and lowercases. The original text is preserved by
 * callers for reporting.
 */
export function normalizeCheckText(text) {
  return String(text ?? '')
    .replace(/`/g, '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Extract the command from a required-check line written as a backtick code
 * span, e.g. `` `npm test` ``. Returns the normalized command, or null when the
 * check is not written as a command (treated as a manual check). Only checks
 * written as backtick commands are eligible for status-check substitution.
 *
 * @returns {string|null}
 */
export function extractCommand(text) {
  const match = String(text ?? '').match(/`([^`]+)`/);
  return match ? normalizeCheckText(match[1]) : null;
}

/**
 * Parse the issue body's `## Required Checks` section. Every non-empty list
 * item is treated as a required check. The original text is preserved for
 * reporting; a normalized form is added for comparison, and `command` holds the
 * backtick command when the check is written as one (null for manual checks).
 *
 * @returns {{ text: string, normalized: string, command: string|null }[]}
 */
export function parseRequiredChecks(issueBody) {
  const section = extractSectionBody(issueBody, '## Required Checks');
  if (section === null) return [];
  const checks = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^[-*]\s+(.*\S)\s*$/);
    if (!match) continue;
    const text = match[1].trim();
    if (!text) continue;
    checks.push({ text, normalized: normalizeCheckText(text), command: extractCommand(text) });
  }
  return checks;
}

/**
 * Detect a current-head marker such as `Current PR head: <sha>` anywhere in the
 * provided text. Accepts a few equivalent phrasings; the documented form is
 * `Current PR head: <sha>`.
 *
 * @returns {string|null} lowercased SHA, or null when no marker is present.
 */
export function extractHeadMarker(text) {
  const match = String(text ?? '').match(
    /(?:current pr head|pr head|head commit|head ref oid|headrefoid)\s*[:=]\s*`?([0-9a-f]{7,40})`?/i
  );
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parse the PR body's `## Evidence` section into structured entries plus the
 * current-head marker.
 *
 * Supported entry shape:
 *   - Required check: <exact required check text>
 *     Verdict: passed|failed|blocked|not run
 *     Evidence: <concise output excerpt or status-check reference>
 *
 * @returns {{ section: string|null, headSha: string|null,
 *             entries: { check: string, verdict: string|null, evidence: string|null }[] }}
 */
export function parsePrEvidence(prBody) {
  const section = extractSectionBody(prBody, '## Evidence');
  const headSha = extractHeadMarker(prBody);
  const entries = [];
  if (section !== null) {
    const reqRe = /^[-*]\s*Required check:\s*(.+?)\s*$/i;
    const verdictRe = /^Verdict:\s*(.+?)\s*$/i;
    const evidenceRe = /^Evidence:\s*(.+?)\s*$/i;
    let current = null;
    for (const rawLine of section.split('\n')) {
      const line = rawLine.trim();
      const reqMatch = line.match(reqRe);
      if (reqMatch) {
        if (current) entries.push(current);
        current = { check: reqMatch[1].trim(), verdict: null, evidence: null };
        continue;
      }
      if (current) {
        const verdictMatch = line.match(verdictRe);
        if (verdictMatch) {
          current.verdict = verdictMatch[1].trim();
          continue;
        }
        const evidenceMatch = line.match(evidenceRe);
        if (evidenceMatch) {
          current.evidence = evidenceMatch[1].trim();
          continue;
        }
      }
    }
    if (current) entries.push(current);
  }
  return { section, headSha, entries };
}

export function statusCheckName(check) {
  if (!check || typeof check !== 'object') return '';
  return String(check.name ?? check.context ?? '').trim();
}

/**
 * A status check counts as successful only when it completed successfully.
 * Handles both CheckRun (status/conclusion) and StatusContext (state) shapes
 * returned by `gh pr view --json statusCheckRollup`.
 */
export function isSuccessfulStatusCheck(check) {
  if (!check || typeof check !== 'object') return false;
  if (typeof check.conclusion === 'string' || typeof check.status === 'string') {
    const status = String(check.status ?? '').toUpperCase();
    const conclusion = String(check.conclusion ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') return false;
    return conclusion === 'SUCCESS';
  }
  if (typeof check.state === 'string') {
    return String(check.state).toUpperCase() === 'SUCCESS';
  }
  return false;
}

/**
 * Find successful status checks that can substitute for a required check.
 *
 * Substitution is restricted to command checks (those written as a backtick
 * command) and requires an exact normalized name match, so a status check named
 * `test` cannot stand in for `npm test -- focused-case`, and no status check can
 * substitute for a manual check. Returns every successful exact match so the
 * caller can detect ambiguity. Empty or absent status data yields no matches; it
 * is never treated as passing.
 */
function matchStatusChecks(requiredCheck, statusChecks) {
  const target = requiredCheck.command;
  if (!target) return [];
  const successful = (Array.isArray(statusChecks) ? statusChecks : []).filter(isSuccessfulStatusCheck);
  return successful.filter(check => {
    const name = normalizeCheckText(statusCheckName(check));
    return Boolean(name) && name === target;
  });
}

/**
 * Compare PR head SHA marker against the actual head, allowing short-SHA
 * prefixes (>= 7 chars) in either direction.
 */
export function headMatches(claimed, actual) {
  if (!claimed || !actual) return false;
  const a = String(claimed).toLowerCase();
  const b = String(actual).toLowerCase();
  if (a === b) return true;
  if (a.length >= 7 && b.startsWith(a)) return true;
  if (b.length >= 7 && a.startsWith(b)) return true;
  return false;
}

/**
 * Compare required checks to PR-body evidence and status checks.
 *
 * @returns {{ matches: object[], statusSubstitutions: object[],
 *             missing: { check: string, reason: string }[], warnings: string[] }}
 */
export function compareRequiredChecksToEvidence(requiredChecks, evidenceEntries, statusChecks) {
  const matches = [];
  const statusSubstitutions = [];
  const missing = [];
  const warnings = [];

  for (const rc of requiredChecks) {
    const entry = evidenceEntries.find(e => normalizeCheckText(e.check) === rc.normalized);
    if (entry) {
      const verdict = (entry.verdict ?? '').toLowerCase().trim();
      const hasEvidence = Boolean((entry.evidence ?? '').trim());
      if (!verdict) {
        missing.push({ check: rc.text, reason: 'evidence entry is missing a Verdict line' });
        continue;
      }
      if (!VALID_VERDICTS.has(verdict)) {
        missing.push({ check: rc.text, reason: `unrecognized verdict '${entry.verdict}'` });
        continue;
      }
      if (verdict === 'not run') {
        missing.push({ check: rc.text, reason: "verdict 'not run' is not final-state evidence" });
        continue;
      }
      if (!hasEvidence) {
        missing.push({ check: rc.text, reason: 'evidence entry is missing an Evidence excerpt' });
        continue;
      }
      if (verdict === 'failed' || verdict === 'blocked') {
        warnings.push(`Required check '${rc.text}' reports verdict '${verdict}'`);
      }
      matches.push({ check: rc.text, via: 'pr-body', verdict });
      continue;
    }

    const statusMatches = matchStatusChecks(rc, statusChecks);
    if (statusMatches.length === 1) {
      const name = statusCheckName(statusMatches[0]);
      matches.push({ check: rc.text, via: 'status-check', statusCheck: name });
      statusSubstitutions.push({ check: rc.text, statusCheck: name });
      continue;
    }
    if (statusMatches.length > 1) {
      warnings.push(
        `Multiple successful status checks match required check '${rc.text}'; require explicit PR-body evidence instead`
      );
    }
    missing.push({
      check: rc.text,
      reason: rc.command
        ? 'command check has no PR-body evidence entry and no exact-match successful status check'
        : 'manual check requires explicit PR-body evidence (a Verdict and Evidence excerpt); a status check cannot substitute',
    });
  }

  return { matches, statusSubstitutions, missing, warnings };
}

/**
 * Pure evaluation of preflight state from already-fetched GitHub data.
 *
 * @param {object} params
 * @param {object} params.prData    PR data with number, body, headRefOid, files,
 *                                   closingIssuesReferences, statusCheckRollup.
 * @param {object} params.issueData Issue data with number, body, title.
 * @returns {object} structured result.
 */
export function evaluatePreflight({ prData, issueData }) {
  const errors = [];
  const warnings = [];
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  const prNumber = prData?.number ?? null;
  const issueNumber = issueData?.number ?? null;

  if (!headRefOid) {
    errors.push('PR head commit (headRefOid) is unavailable; cannot verify evidence freshness');
  }

  const requiredChecks = parseRequiredChecks(issueData?.body);
  if (requiredChecks.length === 0) {
    errors.push(
      issueNumber
        ? `Issue #${issueNumber} has no non-empty '## Required Checks' section; the task record is incomplete`
        : "Linked issue has no non-empty '## Required Checks' section; the task record is incomplete"
    );
  }

  const evidence = parsePrEvidence(prData?.body);
  if (evidence.section === null) {
    errors.push("PR body has no '## Evidence' section");
  } else if (evidence.entries.length === 0 && evidence.section.trim() === '') {
    errors.push("PR body '## Evidence' section is empty");
  }

  if (!evidence.headSha) {
    errors.push("PR body is missing a 'Current PR head: <sha>' marker");
  } else if (headRefOid && !headMatches(evidence.headSha, headRefOid)) {
    errors.push(
      `PR body cites head ${evidence.headSha} but the current PR head is ${headRefOid}; evidence is stale`
    );
  }

  const comparison = compareRequiredChecksToEvidence(
    requiredChecks,
    evidence.entries,
    prData?.statusCheckRollup
  );

  for (const item of comparison.missing) {
    errors.push(`Required check '${item.check}' has no acceptable evidence: ${item.reason}`);
  }
  warnings.push(...comparison.warnings);

  const ok = errors.length === 0;

  return {
    ok,
    errors,
    warnings,
    pr: prNumber,
    issue: issueNumber,
    headRefOid,
    requiredChecks,
    evidenceMatches: comparison.matches,
    statusSubstitutions: comparison.statusSubstitutions,
    missing: comparison.missing,
  };
}

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

function runGhJson(commandRunner, args) {
  const result = commandRunner('gh', args, { encoding: 'utf-8' });
  if (result.error) {
    throw new PreflightError(
      `Failed to run 'gh ${args.join(' ')}': ${result.error.message}. Install the GitHub CLI and ensure it is on PATH.`
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    const detail = stderr || stdout || `exit ${result.status}`;
    let hint = '';
    if (/not logged|authentication|gh auth/i.test(detail)) {
      hint = " Run 'gh auth login' first.";
    }
    throw new PreflightError(`'gh ${args.join(' ')}' failed: ${detail}.${hint}`);
  }
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    throw new PreflightError(`'gh ${args.join(' ')}' returned no output`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PreflightError(`'gh ${args.join(' ')}' returned output that is not valid JSON`);
  }
}

/**
 * Resolve which issue number to treat as the task record for a PR.
 *
 * @returns {{ issueNumber: number|null, warnings: string[] }}
 * @throws {PreflightError} when no issue can be resolved.
 */
export function resolveIssueNumber(prData, explicitIssue) {
  if (explicitIssue !== undefined && explicitIssue !== null && explicitIssue !== '') {
    const parsed = Number(explicitIssue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new PreflightError(`--issue must be a positive integer, got '${explicitIssue}'`);
    }
    return { issueNumber: parsed, warnings: [] };
  }

  const refs = Array.isArray(prData?.closingIssuesReferences) ? prData.closingIssuesReferences : [];
  if (refs.length === 0) {
    throw new PreflightError(
      'PR has no closing issue reference (e.g. "Closes #<n>"); pass --issue <number> or fix the PR body'
    );
  }
  if (refs.length === 1) {
    return { issueNumber: refs[0].number, warnings: [] };
  }
  throw new PreflightError(
    `PR closes multiple issues (${refs.map(r => `#${r.number}`).join(', ')}); pass --issue <number> to disambiguate`
  );
}

/**
 * Fetch PR and issue data via `gh`, then evaluate the preflight gate.
 *
 * @param {object} options
 * @param {number|string} options.pr     PR number (required).
 * @param {number|string} [options.issue] Issue number override.
 * @param {string} [options.repo]          owner/name repo override.
 * @param {Function} [options.commandRunner] Injectable runner for testing.
 * @returns {object} the evaluatePreflight result.
 * @throws {PreflightError} on missing/incomplete GitHub data.
 */
export function runPreflight({ pr, issue, repo, commandRunner = defaultCommandRunner } = {}) {
  if (pr === undefined || pr === null || pr === '') {
    throw new PreflightError('--pr <number> is required');
  }
  const prNumber = Number(pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new PreflightError(`--pr must be a positive integer, got '${pr}'`);
  }

  const prArgs = ['pr', 'view', String(prNumber), '--json', PR_FIELDS];
  if (repo) prArgs.push('--repo', repo);
  const prData = runGhJson(commandRunner, prArgs);

  const { issueNumber } = resolveIssueNumber(prData, issue);

  const issueArgs = ['issue', 'view', String(issueNumber), '--json', ISSUE_FIELDS];
  if (repo) issueArgs.push('--repo', repo);
  const issueData = runGhJson(commandRunner, issueArgs);

  return evaluatePreflight({ prData, issueData });
}
