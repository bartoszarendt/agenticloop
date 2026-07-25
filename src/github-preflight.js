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
 *   - extractCheckId(text)
 *   - isSuccessfulStatusCheck(check) / statusCheckName(check)
 *   - evaluatePreflight({ prData, issueData })
 *
 * Impure entry point:
 *   - runPreflight({ pr, issue, repo, commandRunner })
 */

import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { markdownSection, topLevelListItems, markdownLines } from './markdown.js';
import { validateGitHubVerificationAttempts } from './verification-learning.js';
import { createLocalVerificationContext } from './verification-context.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  parseScopePatterns,
  parseDeviations,
  validatePathsAgainstDeviations,
} from './scope-matcher.js';
import {
  collectGitHubArtifactChangedPaths,
  parseOwnershipDeclaration,
  validateChangedPathsAgainstOwnership,
  validateGitHubSharedMutationContents,
} from './parallel-ownership.js';
import {
  parseReviewCheckpoint,
  evaluateReviewCheckpoint,
  DEFAULT_REVIEW_BUDGET,
  parseReviewBudgetValue,
} from './review-checkpoint.js';
import { collectGitHubReviewHistory } from './review-history.js';
import {
  parseResolutionMatrix,
  validateResolutionMatrix,
} from './resolution-matrix.js';

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
  'baseRefOid',
  'headRefOid',
  'files',
  'closingIssuesReferences',
  'statusCheckRollup',
  'commits',
  'comments',
  'reviews',
].join(',');

const ISSUE_FIELDS = ['number', 'body', 'title'].join(',');

/**
 * Extract the body of a Markdown section by its exact heading line, stopping at
 * the next heading of the same or higher level. Heading match is on the trimmed
 * line so leading indentation does not matter.
 */
export function extractSectionBody(markdown, heading) {
  return markdownSection(String(markdown ?? ''), heading)?.body ?? null;
}

/**
 * Read the review budget from the linked task's frontmatter. It is deliberately
 * separate from review event parsing so malformed task metadata fails closed
 * before it can loosen the revision limit.
 */
export function parseReviewBudget(taskBody) {
  const raw = String(taskBody ?? '');
  const [frontmatter] = parseFrontmatter(raw);
  const occurrences = raw.match(/^review_budget\s*:/gm)?.length ?? 0;
  if (occurrences > 1) return { budget: DEFAULT_REVIEW_BUDGET, error: 'task record has duplicate review_budget frontmatter fields' };
  if (!frontmatter || !Object.hasOwn(frontmatter, 'review_budget')) {
    return { budget: DEFAULT_REVIEW_BUDGET, error: null };
  }
  const parsed = parseReviewBudgetValue(frontmatter.review_budget);
  return parsed.error
    ? { ...parsed, error: `task ${parsed.error}` }
    : parsed;
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

/** Return an optional stable check id written as `[RC-<number>]`. */
export function extractCheckId(text) {
  return String(text ?? '').match(/^\s*\[(RC-\d+)\]\s*/i)?.[1].toUpperCase() ?? null;
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
 * @returns {{ text: string, normalized: string, command: string|null, id: string|null }[]}
 */
export function parseRequiredChecks(issueBody) {
  const section = extractSectionBody(issueBody, '## Required Checks');
  if (section === null) return [];
  return topLevelListItems(section).map(text => ({
    text,
    normalized: normalizeCheckText(text),
    command: extractCommand(text),
    id: extractCheckId(text),
  }));
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
 *             entries: { check: string, verdict: string|null, evidence: string|null, id?: string|null }[] }}
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
    let currentField = null;
    let entryIndent = null;
    const append = value => {
      if (!current || !currentField) return;
      current[currentField] = `${current[currentField] ?? ''} ${value}`.replace(/\s+/g, ' ').trim();
    };
    for (const rawLine of section.split('\n')) {
      const line = rawLine.trim();
      const rawRequest = rawLine.match(/^( {0,3})[-*]\s*Required check:\s*(.+?)\s*$/i);
      const reqMatch = rawRequest ? line.match(reqRe) : null;
      if (reqMatch && (entryIndent === null || rawRequest[1].length === entryIndent)) {
        if (entryIndent === null) entryIndent = rawRequest[1].length;
        if (current) entries.push(current);
        current = { check: reqMatch[1].trim(), verdict: null, evidence: null };
        const id = extractCheckId(current.check);
        if (id) current.id = id;
        currentField = 'check';
        continue;
      }
      if (current) {
        const verdictMatch = line.match(verdictRe);
        if (verdictMatch) {
          current.verdict = verdictMatch[1].trim();
          currentField = 'verdict';
          continue;
        }
        const evidenceMatch = line.match(evidenceRe);
        if (evidenceMatch) {
          current.evidence = evidenceMatch[1].trim();
          currentField = 'evidence';
          continue;
        }
        if (/^[ \t]+\S/.test(rawLine)) append(line);
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
 * Compare PR head SHA marker against the actual head. Phase 29 requires exact
 * full 40-character SHA equality; short prefixes are rejected.
 */
export function headMatches(claimed, actual) {
  if (!claimed || !actual) return false;
  const a = String(claimed).toLowerCase();
  const b = String(actual).toLowerCase();
  return a.length === 40 && b.length === 40 && a === b;
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
    const entry = evidenceEntries.find(e =>
      rc.id ? extractCheckId(e.check) === rc.id : normalizeCheckText(e.check) === rc.normalized
    );
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
      if (rc.id && normalizeCheckText(entry.check) !== rc.normalized) {
        warnings.push(`Evidence for ${rc.id} matched by stable id but its displayed check text differs from the issue`);
      }
      matches.push({ check: rc.text, id: rc.id ?? null, via: 'pr-body', verdict });
      continue;
    }

    const statusMatches = matchStatusChecks(rc, statusChecks);
    if (statusMatches.length === 1) {
      const name = statusCheckName(statusMatches[0]);
      matches.push({ check: rc.text, id: rc.id ?? null, via: 'status-check', statusCheck: name });
      statusSubstitutions.push({ check: rc.text, statusCheck: name });
      continue;
    }
    if (statusMatches.length > 1) {
      warnings.push(
        `Multiple successful status checks match required check '${rc.text}'; require explicit PR-body evidence instead`
      );
    }
    const normalizedCandidates = evidenceEntries.map(candidate => ({
      text: candidate.check,
      normalized: normalizeCheckText(candidate.check),
    }));
    const near = normalizedCandidates.find(candidate =>
      candidate.normalized.length >= 12 &&
      (candidate.normalized.startsWith(rc.normalized) || rc.normalized.startsWith(candidate.normalized))
    );
    const nearHint = near ? `; closest parsed PR-body entry is '${near.text}'` : '';
    missing.push({
      check: rc.text,
      reason: rc.command
        ? `command check has no PR-body evidence entry and no exact-match successful status check${nearHint}`
        : `manual check requires explicit PR-body evidence (a Verdict and Evidence excerpt); a status check cannot substitute${nearHint}`,
    });
  }

  return { matches, statusSubstitutions, missing, warnings };
}

/**
 * Detect whether a section body is purely a placeholder. A section is a
 * placeholder when its meaningful content is entirely placeholder tokens.
 *
 * Rejects:
 * - empty sections
 * - sections whose only non-whitespace content is "None", "TBD", "N/A", etc.
 * - sections with only empty bullets
 * - sections that consist entirely of a sentence whose main content claim is
 *   a placeholder (e.g., "PR at TBD." replaces the artifact reference)
 *
 * Allows:
 * - substantive text that mentions "none" incidentally (e.g., "No deviations
 *   were needed; none of the files exceeded scope")
 *
 * @param {string} body
 * @returns {boolean}
 */
function isPlaceholderSection(body) {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return true;
  // Single-token placeholders: "None", "None.", "TBD", "N/A", etc.
  if (/^(?:none|tbd|n\/a|tba|todo)\.?$/i.test(trimmed)) return true;
  // Empty bullet list: just dashes or asterisks with no content
  const nonEmptyLines = trimmed.split('\n').filter(l => {
    const t = l.trim();
    return t && !/^[-*]\s*$/.test(t);
  });
  if (nonEmptyLines.length === 0) return true;
  // Check for placeholder tokens used as substantive content claims.
  // "TBD" used as an artifact reference (e.g., "PR at TBD.") is a placeholder.
  // But "none of the files" in a substantive sentence is not.
  const joined = nonEmptyLines.join(' ');
  // Reject if TBD/N/A/TBA appears as a standalone word (not part of a larger word)
  if (/\b(?:TBD|N\/A|TBA)\b/i.test(joined)) return true;
  // Reject if "None" appears as the main content claim in a sentence that
  // otherwise has no substantive content (e.g., "PR at None." or just "None")
  // Allow "none" when it's part of a substantive sentence with other content
  const noneAsContent = /\bNone\b/i.test(joined);
  if (noneAsContent) {
    // Count substantive words (excluding common filler)
    const words = joined.split(/\s+/).filter(w =>
      w.length > 2 && !/^(?:the|and|for|was|are|but|not|has|had|with|from|that|this|have|been|none|pr|at)$/i.test(w)
    );
    // If "None" appears and there are very few other substantive words, it's a placeholder
    if (words.length <= 2) return true;
  }
  return false;
}

/**
 * Detect an explicit current/head artifact claim in text. Returns the SHA if
 * found, or null. Only matches SHAs that are explicitly presented as the
 * current/head/implementation artifact, not incidental hex tokens.
 *
 * @param {string} text
 * @returns {{ sha: string, isShort: boolean }|null}
 */
function extractCurrentArtifactClaim(text) {
  const patterns = [
    /(?:current\s+(?:pr\s+)?(?:head|artifact|implementation)|implementation\s+artifact)\s*[:=]\s*`?([0-9a-f]{7,40})`?/i,
    /\b(?:at|commit|sha)\s+`?([0-9a-f]{7,40})`?\s*[.!)]?\s*$/im,
    /\bPR\s+at\s+`?([0-9a-f]{7,40})`?\s*[.!)]?/i,
    /\b(?:pr|pull\s+request)\s+(?:#?\d+\s+)?(?:at|commit)\s+`?([0-9a-f]{7,40})`?/i,
  ];
  for (const pattern of patterns) {
    const match = (text ?? '').match(pattern);
    if (match) {
      const sha = match[1].toLowerCase();
      return { sha, isShort: sha.length < 40 };
    }
  }
  return null;
}

/**
 * Validate the canonical completion-summary shape in the PR body.
 * `Scope Completed`, `Artifacts`, and `Evidence` are substantive;
 * `Deviations`, `Known Gaps`, and `Follow-Ups` may say `None`.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateCompletionSummary(prBody, headRefOid) {
  const errors = [];
  const warnings = [];

  const requiredSubstantive = ['## Scope Completed', '## Artifacts', '## Evidence'];
  const requiredOrNone = ['## Deviations', '## Known Gaps', '## Follow-Ups'];

  for (const heading of requiredSubstantive) {
    const body = extractSectionBody(prBody, heading);
    if (body === null) {
      errors.push({ message: `PR body is missing the '${heading}' section`, category: 'summary_shape' });
    } else if (isPlaceholderSection(body)) {
      errors.push({ message: `PR body '${heading}' section is empty or contains only placeholder content`, category: 'summary_shape' });
    } else if (heading === '## Artifacts' || heading === '## Evidence') {
      // Also reject sections that contain empty bullets even alongside substantive content
      if (/^\s*-\s*$/m.test(body)) {
        errors.push({ message: `PR body '${heading}' section contains empty bullet items`, category: 'summary_shape' });
      }
    }
  }

  for (const heading of requiredOrNone) {
    const body = extractSectionBody(prBody, heading);
    if (body === null) {
      errors.push({ message: `PR body is missing the '${heading}' section`, category: 'summary_shape' });
    }
    // Non-empty sections that are not placeholders are fine;
    // sections that say "None" are explicitly allowed for these headings
  }

  // Validate explicit current-artifact claims against the head
  if (headRefOid) {
    const artifactsBody = extractSectionBody(prBody, '## Artifacts') ?? '';
    const evidenceBody = extractSectionBody(prBody, '## Evidence') ?? '';

    // Check for explicit current-head claims
    for (const sectionBody of [artifactsBody, evidenceBody]) {
      const claim = extractCurrentArtifactClaim(sectionBody);
      if (claim) {
        const headLower = headRefOid.toLowerCase();
        if (claim.isShort) {
          errors.push({
            message: `explicit current-artifact claim uses a short SHA '${claim.sha}'; full 40-character SHA required`,
            category: 'summary_shape',
          });
        } else if (claim.sha !== headLower) {
          errors.push({
            message: `explicit current-artifact claim '${claim.sha.slice(0, 8)}...' contradicts current PR head '${headLower.slice(0, 8)}...'`,
            category: 'summary_shape',
          });
        }
      }
    }

    // Scan for unlabeled bare 40-char SHAs that are not the head and not in
    // labeled/range contexts. This is a narrower check than before: only bare
    // SHAs in artifact-like positions are flagged, not filenames, checksums,
    // issue identifiers, or incidental hex text.
    const combined = artifactsBody + '\n' + evidenceBody;
    const bareShaRe = /\b([0-9a-f]{40})\b/gi;
    let match;
    while ((match = bareShaRe.exec(combined)) !== null) {
      const cited = match[1].toLowerCase();
      if (cited === headRefOid.toLowerCase()) continue;

      // Check surrounding context for labels that make this a legitimate reference
      const before = combined.slice(Math.max(0, match.index - 40), match.index);
      const after = combined.slice(match.index + 40, match.index + 80);
      const context = before + after;

      // Allow labeled references: base, head, range, parent, merge-base, from, to, prior, previous, commit
      const isLabeled = /(?:base|head|range|parent|merge-base|from|to|prior|previous|commit|sha|artifact)[\s:=]*$/i.test(before) ||
        /^[\s.]*\.\.[\s.]*/.test(after) || // range notation: sha..sha
        /^\s*[–—-]/.test(after); // labeled: "sha - description"

      if (isLabeled) continue;

      // Allow SHAs in filename-like contexts (e.g., deadbeef in docs/deadbeef.md)
      // If the SHA is part of a path or filename, skip
      if (/[\\/]/.test(before.slice(-1)) || /[\\/]/.test(after.slice(0, 1))) continue;
      if (/^[a-z0-9._-]*\.(?:md|txt|json|ya?ml|js|ts|py|sh)$/i.test(after)) continue;

      // This is a bare unlabeled SHA - could be a stale current-artifact reference
      // Only flag if it looks like it's claiming to be the current artifact
      // Don't flag if it's clearly in a different context (like a diff range, issue number, etc.)
      errors.push({
        message: `unlabeled 40-character SHA '${cited.slice(0, 8)}...' in summary; label it as base, range, or other reference, or remove it`,
        category: 'summary_shape',
      });
    }
  }

  return { errors, warnings };
}

/**
 * Validate cooperative attribution when it can be mechanically established.
 * When the PR body has a role trailer and the head commit has Task:/Agent:
 * trailers, verify consistency. Does not reject human-authored commits.
 *
 * Uses live-line filtering to ignore fenced code, blockquotes, and indented code.
 * Matches trailers only in the final trailer block of the commit message.
 * The trailer block is the final contiguous block of "Key: Value" lines at the
 * end of the commit message, separated from the body by a blank line. Standard
 * trailers like Co-authored-by, Signed-off-by, and Reviewed-by are allowed
 * alongside Task: and Agent: without breaking the block.
 *
 * @returns {{ errors: string[], warnings: string[], attributionEstablished: boolean }}
 */
export function validateAttribution(prBody, headCommitMessage, issueData) {
  const errors = [];
  const warnings = [];
  let attributionEstablished = false;

  const [frontmatter] = parseFrontmatter(String(issueData?.body ?? ''));
  const canonicalTaskId = frontmatter?.task_id?.trim() ?? null;
  const liveBodyLines = markdownLines(prBody ?? '').filter(line => line.live).map(line => line.raw);
  const bodyRoles = liveBodyLines
    .map(line => line.trim().match(/^\[\[agent:\s*([a-z_]+)\]\]$/i)?.[1].toLowerCase() ?? null)
    .filter(Boolean);
  const finalBodyLine = [...liveBodyLines].reverse().find(line => line.trim())?.trim() ?? '';
  const finalBodyRole = finalBodyLine.match(/^\[\[agent:\s*([a-z_]+)\]\]$/i)?.[1].toLowerCase() ?? null;
  if (!finalBodyRole) {
    if (bodyRoles.length > 0) errors.push('body role trailer must be the final live nonblank line');
    return { errors, warnings, attributionEstablished: false };
  }
  if (!['engineer', 'maintainer', 'orchestrator'].includes(finalBodyRole)) {
    errors.push(`body role trailer references unknown role '${finalBodyRole}'`);
    return { errors, warnings, attributionEstablished: false };
  }
  if (new Set(bodyRoles).size > 1) {
    errors.push('body contains conflicting live role trailers');
  }
  const bodyRole = finalBodyRole;
  const liveCommitLines = markdownLines(headCommitMessage ?? '').filter(line => line.live).map(line => line.raw);

  // Extract the final contiguous trailer block from the commit message.
  // A Git trailer block is the final consecutive "Key: Value" lines, separated
  // from the commit body by a blank line. We recognize standard trailers
  // (Task:, Agent:, Co-authored-by:, Signed-off-by:, Reviewed-by:, etc.)
  // and allow them mixed in the block.
  const KNOWN_TRAILER_KEYS = [
    'task', 'agent', 'co-authored-by', 'signed-off-by', 'reviewed-by',
    'acked-by', 'tested-by', 'reported-by', 'suggested-by', 'helped-by',
    'inspired-by', 'cc', 'see-also', 'ref', 'related-to', 'fixes', 'closes',
  ];

  const trailerLines = [];
  let cursor = liveCommitLines.length - 1;
  while (cursor >= 0 && !liveCommitLines[cursor].trim()) cursor--;
  for (; cursor >= 0; cursor--) {
    const line = liveCommitLines[cursor].trim();
    const trailerMatch = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.+)$/);
    if (!trailerMatch) break;
    const key = trailerMatch[1].toLowerCase();
    if (!(KNOWN_TRAILER_KEYS.includes(key) || /^[A-Z][\w-]*$/.test(trailerMatch[1]))) break;
    trailerLines.unshift(line);
  }

  const trailerBlock = trailerLines.join('\n');

  // Extract Task: and Agent: trailers from the trailer block
  const taskMatches = [...trailerBlock.matchAll(/^Task:\s*(\S+)$/gmi)];
  const agentMatches = [...trailerBlock.matchAll(/^Agent:\s*(\S+)$/gmi)];

  if (taskMatches.length === 0) errors.push('head commit is missing required Task: trailer');
  if (agentMatches.length === 0) errors.push('head commit is missing required Agent: trailer');

  // Check for duplicate trailers
  if (taskMatches.length > 1) {
    errors.push(`head commit has duplicate Task: trailers`);
  }
  if (agentMatches.length > 1) {
    errors.push(`head commit has duplicate Agent: trailers`);
  }

  attributionEstablished = true;

  // Use canonical task_id if available, otherwise fall back to issue number
  const expectedTaskId = canonicalTaskId ?? (issueData?.number ? `#${issueData.number}` : null);

  if (taskMatches.length === 1 && expectedTaskId) {
    const commitTask = taskMatches[0][1].trim();
    if (commitTask !== expectedTaskId) {
      errors.push(`head commit Task: '${commitTask}' does not match canonical task '${expectedTaskId}'`);
    }
  }

  if (agentMatches.length === 1) {
    const commitAgent = agentMatches[0][1].toLowerCase();
    if (commitAgent !== bodyRole) {
      errors.push(`head commit Agent: '${agentMatches[0][1]}' does not match body role trailer '${bodyRole}'`);
    }
  }

  return { errors, warnings, attributionEstablished };
}

/**
 * Categorize preflight failures for structured routing.
 * Accepts both string errors and structured { message, category } errors.
 * @param {Array<string|{ message: string, category?: string }>} errors
 * @returns {{ category: string, errors: string[] }[]}
 */
export function categorizePreflightErrors(errors) {
  const categories = {
    head_identity: [],
    summary_shape: [],
    scope_deviations: [],
    attribution: [],
    evidence: [],
    checks: [],
    review_checkpoint: [],
    revision_resolution: [],
    review_provenance: [],
    other: [],
  };

  for (const error of errors) {
    const errorStr = typeof error === 'string' ? error : error.message;
    const category = typeof error === 'object' && error.category ? error.category : null;

    if (category && categories[category]) {
      categories[category].push(errorStr);
      continue;
    }

    // Fallback: substring matching for backward compatibility
    const lower = errorStr.toLowerCase();
    if (lower.includes('head') || lower.includes('headrefoid') || lower.includes('sha') || lower.includes('artifact')) {
      categories.head_identity.push(errorStr);
    } else if (lower.includes('scope completed') || lower.includes('artifacts') || lower.includes('summary')) {
      categories.summary_shape.push(errorStr);
    } else if (lower.includes('deviation') || lower.includes('unexpected file') || lower.includes('allowed_paths')) {
      categories.scope_deviations.push(errorStr);
    } else if (lower.includes('attribution') || lower.includes('trailer') || lower.includes('agent:')) {
      categories.attribution.push(errorStr);
    } else if (lower.includes('evidence') || lower.includes('verdict')) {
      categories.evidence.push(errorStr);
    } else if (lower.includes('required check') || lower.includes('status check')) {
      categories.checks.push(errorStr);
    } else {
      categories.other.push(errorStr);
    }
  }

  return Object.entries(categories)
    .filter(([, errors]) => errors.length > 0)
    .map(([category, errors]) => ({ category, errors }));
}

/**
 * Pure evaluation of preflight state from already-fetched GitHub data.
 *
 * @param {object} params
 * @param {object} params.prData    PR data with number, body, headRefOid, files,
 *                                   closingIssuesReferences, statusCheckRollup.
 * @param {object} params.issueData Issue data with number, body, title, comments.
 * @param {'accepted'|'closed'} [params.verificationStatus] Terminal lifecycle
 *   status for verification-attempt triage evaluation.
 * @param {{ id: string }[]} [params.projectFacts]
 * @param {(id: string) => boolean} [params.decisionExists]
 * @param {(id: string) => boolean} [params.taskExists]
 * @param {{ login: string }} [params.expectedAccount]
 * @param {{ events: Array<object>, errors: string[] }} [params.reviewHistory]
 *   Ordered, trusted review history derived from durable GitHub carriers.
 * @param {Array<{ status: string, artifact?: string }>} [params.reviewOutcomes]
 *   Legacy pure-test input; production callers pass reviewHistory.
 * @param {number} [params.reviewBudget] Override for review budget (default: 3).
 * @returns {object} structured result.
 */
export function evaluatePreflight({
  prData,
  issueData,
  verificationStatus,
  projectFacts,
  decisionExists,
  taskExists,
  expectedAccount,
  reviewHistory,
  reviewOutcomes = [],
  reviewBudget = DEFAULT_REVIEW_BUDGET,
  reviewBudgetError = null,
}) {
  const errors = [];
  const warnings = [];
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  const prNumber = prData?.number ?? null;
  const issueNumber = issueData?.number ?? null;

  if (!headRefOid) {
    errors.push('PR head commit (headRefOid) is unavailable; cannot verify evidence freshness');
  } else if (!/^[0-9a-f]{40}$/.test(headRefOid)) {
    errors.push(`PR head commit '${headRefOid}' is not a full 40-character hexadecimal SHA`);
  }

  const requiredChecks = parseRequiredChecks(issueData?.body);
  if (requiredChecks.length === 0) {
    errors.push(
      issueNumber
        ? `Issue #${issueNumber} has no non-empty '## Required Checks' section; the task record is incomplete`
        : "Linked issue has no non-empty '## Required Checks' section; the task record is incomplete"
    );
  }
  const requiredIds = requiredChecks.map(check => check.id).filter(Boolean);
  for (const id of new Set(requiredIds)) {
    if (requiredIds.filter(candidate => candidate === id).length > 1) {
      const label = issueNumber ? `Issue #${issueNumber}` : 'Linked issue';
      errors.push(`${label} uses duplicate required-check id '${id}'`);
    }
  }

  const verificationAttempts = validateGitHubVerificationAttempts(issueData?.comments, {
    requiredChecks,
    status: verificationStatus,
    projectFacts,
    decisionExists,
    taskExists,
    expectedAccount,
  });
  errors.push(...verificationAttempts.errors);
  warnings.push(...verificationAttempts.warnings);

  const evidence = parsePrEvidence(prData?.body);
  if (evidence.section === null) {
    errors.push("PR body has no '## Evidence' section");
  } else if (evidence.entries.length === 0 && evidence.section.trim() === '') {
    errors.push("PR body '## Evidence' section is empty");
  }
  const evidenceIds = evidence.entries.map(entry => extractCheckId(entry.check)).filter(Boolean);
  for (const id of new Set(evidenceIds)) {
    if (evidenceIds.filter(candidate => candidate === id).length > 1) {
      errors.push(`PR body uses duplicate evidence check id '${id}'`);
    }
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

  const exceptionalCarrierIds = new Set(
    verificationAttempts.records.map(record => record.checkId)
  );
  for (const match of comparison.matches.filter(
    item => item.via === 'pr-body' && (item.verdict === 'failed' || item.verdict === 'blocked')
  )) {
    if (!match.id) {
      errors.push(
        `Required check '${match.check}' reports verdict '${match.verdict}' and needs a stable [RC-N] id for exceptional attempt history`
      );
    } else if (!exceptionalCarrierIds.has(match.id)) {
      errors.push(
        `Required check '${match.check}' reports verdict '${match.verdict}' but has no marked exceptional attempt carrier for ${match.id}`
      );
    }
  }

  // Phase 29: path/deviation validation
  const scopePatterns = parseScopePatterns(issueData?.body);
  const prFiles = Array.isArray(prData?.files)
    ? prData.files.map(f => typeof f === 'string' ? f : (f?.path ?? '')).filter(Boolean)
    : [];
  let pathValidation = null;
  if (scopePatterns) {
    if (scopePatterns.error) {
      errors.push({ message: scopePatterns.error, category: 'scope_deviations' });
    } else if (scopePatterns.patterns && prFiles.length > 0) {
      const deviations = parseDeviations(prData?.body);
      for (const err of deviations.errors) {
        errors.push({ message: err, category: 'scope_deviations' });
      }
      pathValidation = validatePathsAgainstDeviations(prFiles, scopePatterns.patterns, deviations.entries);
      for (const err of pathValidation.errors) {
        errors.push({ message: err, category: 'scope_deviations' });
      }
    }
  }

  // `allowed_paths` remains the broad scope/deviation map. When a task opts
  // into structured ownership, the exact current PR file list must also stay
  // inside its exclusive ownership or its declared exact shared mutations.
  const ownership = parseOwnershipDeclaration(issueData?.body);
  const [taskFrontmatter] = parseFrontmatter(String(issueData?.body ?? ''));
  const integratedBy = typeof taskFrontmatter?.integrated_by === 'string'
    ? taskFrontmatter.integrated_by.trim()
    : '';
  if (integratedBy && !/^pr:\d+@[0-9a-f]{40}$/i.test(integratedBy)) {
    errors.push({
      message: "GitHub task integrated_by must be an exact 'pr:<number>@<40-sha>' artifact",
      category: 'scope_deviations',
    });
  }
  for (const error of ownership.errors) {
    errors.push({ message: error, category: 'scope_deviations' });
  }
  if (ownership.present && ownership.errors.length === 0) {
    const changed = collectGitHubArtifactChangedPaths(prData?.files);
    if (changed.error) {
      errors.push({ message: changed.error, category: 'scope_deviations' });
    } else {
      const ownershipValidation = validateChangedPathsAgainstOwnership(changed.paths, ownership);
      for (const error of ownershipValidation.errors) {
        errors.push({ message: error, category: 'scope_deviations' });
      }
      if (ownershipValidation.ok) {
        const operationValidation = validateGitHubSharedMutationContents(
          changed.paths,
          ownership,
          prData?.sharedMutationContents
        );
        for (const error of operationValidation.errors) {
          errors.push({ message: error, category: 'scope_deviations' });
        }
      }
    }
  }

  // Phase 29: completion-summary shape validation
  const summaryValidation = validateCompletionSummary(prData?.body, headRefOid);
  for (const err of summaryValidation.errors) {
    if (typeof err === 'string') {
      errors.push({ message: err, category: 'summary_shape' });
    } else {
      errors.push(err);
    }
  }
  for (const warn of summaryValidation.warnings) {
    warnings.push({ message: warn, category: 'summary_shape' });
  }

  // Phase 29: attribution validation (when mechanically establishable)
  // Extract head commit message from PR commits data
  const prCommits = Array.isArray(prData?.commits) ? prData.commits : [];
  const headCommit = prCommits.find(c => String(c?.oid ?? '').toLowerCase() === headRefOid);
  const headCommitMessage = headCommit
    ? (typeof headCommit.message === 'string' && headCommit.message.trim()
      ? headCommit.message
      : [headCommit.messageHeadline, headCommit.messageBody]
        .filter(part => typeof part === 'string' && part)
        .join('\n'))
    : null;
  const attributionValidation = validateAttribution(
    prData?.body,
    headCommitMessage,
    issueData
  );
  for (const err of attributionValidation.errors) {
    errors.push({ message: err, category: 'attribution' });
  }
  for (const warn of attributionValidation.warnings) {
    warnings.push({ message: warn, category: 'attribution' });
  }

  // Phase 29: Review Round Checkpoint enforcement. Production data is parsed
  // from separately paginated PR comments/reviews; only the legacy pure helper
  // path receives explicit reviewOutcomes.
  let checkpointValidation = null;
  const durableHistory = reviewHistory ?? collectGitHubReviewHistory(prData, expectedAccount);
  const historyEvents = Array.isArray(durableHistory?.events) ? durableHistory.events : [];
  for (const historyError of durableHistory?.errors ?? []) {
    errors.push({ message: historyError, category: 'review_checkpoint' });
  }
  if (reviewBudgetError) {
    errors.push({ message: reviewBudgetError, category: 'review_checkpoint' });
  }
  let legacyCheckpoint = null;
  if (historyEvents.length === 0 && reviewOutcomes.length > 0) {
    for (const source of Array.isArray(prData?.comments) ? prData.comments : []) {
      const parsed = parseReviewCheckpoint(typeof source === 'string' ? source : source?.body, { carrier: 'github' });
      if (parsed.found && parsed.errors.length === 0) legacyCheckpoint = parsed.checkpoint;
      for (const parserError of parsed.errors) {
        errors.push({ message: parserError, category: 'review_checkpoint' });
      }
    }
  }
  if (historyEvents.length > 0 || reviewOutcomes.length > 0) {
    checkpointValidation = evaluateReviewCheckpoint({
      reviewHistory: historyEvents.length > 0 ? historyEvents : undefined,
      reviewOutcomes,
      checkpoint: legacyCheckpoint,
      budget: reviewBudget,
      currentArtifact: headRefOid,
    });
    for (const err of checkpointValidation.errors) {
      errors.push({ message: err, category: 'review_checkpoint' });
    }
    for (const warn of checkpointValidation.warnings) {
      warnings.push({ message: warn, category: 'review_checkpoint' });
    }
  }

  // Phase 29: every re-review resolves the stable finding IDs from the latest
  // valid `needs_revision` carrier. Parser errors are part of the gate; a
  // duplicate matrix row cannot become valid merely because map lookup wins.
  let resolutionMatrixValidation = null;
  const reviewEvents = historyEvents.length > 0 ? historyEvents : reviewOutcomes;
  const priorOutcome = [...reviewEvents].reverse().find(outcome =>
    outcome?.type !== 'checkpoint' && outcome?.status === 'needs_revision' && Array.isArray(outcome.findingIds)
  );
  const priorFindingIds = priorOutcome?.findingIds ?? [];
  if (priorOutcome && priorFindingIds.length > 0) {
    const matrixResult = parseResolutionMatrix(prData?.body);
    for (const parserError of matrixResult.errors) {
      errors.push({ message: parserError, category: 'revision_resolution' });
    }
    if (!matrixResult.found) {
      errors.push({
        message: `re-review requires a resolution matrix for ${priorFindingIds.length} prior finding(s)`,
        category: 'revision_resolution',
      });
    } else {
      resolutionMatrixValidation = validateResolutionMatrix({
        requiredFindingIds: priorFindingIds,
        entries: matrixResult.entries,
        currentArtifact: headRefOid,
      });
      for (const err of resolutionMatrixValidation.errors) {
        errors.push({ message: err, category: 'revision_resolution' });
      }
      for (const warn of resolutionMatrixValidation.warnings) {
        warnings.push({ message: warn, category: 'revision_resolution' });
      }
    }
  }

  const ok = errors.length === 0;

  // Extract plain error strings for backward compatibility
  const errorStrings = errors.map(e => typeof e === 'string' ? e : e.message);

  return {
    ok,
    errors: errorStrings,
    warnings: warnings.map(w => typeof w === 'string' ? w : w.message),
    pr: prNumber,
    issue: issueNumber,
    headRefOid,
    requiredChecks,
    evidenceMatches: comparison.matches,
    statusSubstitutions: comparison.statusSubstitutions,
    missing: comparison.missing,
    failureCategories: ok ? [] : categorizePreflightErrors(errors),
    pathValidation: pathValidation ? { unmatched: pathValidation.unmatched, missingDeviations: pathValidation.missingDeviations } : null,
    summaryValidation: { errors: summaryValidation.errors.map(e => typeof e === 'string' ? e : e.message) },
    attributionValidation: { established: attributionValidation.attributionEstablished, errors: attributionValidation.errors },
    reviewHistory: { events: historyEvents.length, errors: durableHistory?.errors ?? [] },
    checkpointValidation: checkpointValidation ? { authorized: checkpointValidation.authorized, errors: checkpointValidation.errors } : null,
    resolutionMatrixValidation: resolutionMatrixValidation ? { valid: resolutionMatrixValidation.valid, errors: resolutionMatrixValidation.errors } : null,
  };
}

function runGhPreflightJson(commandRunner, args) {
  try {
    return runGhJson(commandRunner, args);
  } catch (error) {
    throw new PreflightError(error.message);
  }
}

function resolveAuthenticatedAccount(commandRunner) {
  const account = runGhPreflightJson(commandRunner, ['api', 'user', '--jq', `{"login":.login,"type":.type}`]);
  if (!account?.login) {
    throw new PreflightError('authenticated GitHub account has no login; cannot verify verification-attempt comment authorship');
  }
  return account;
}

function resolveRepoOwnerName(commandRunner, explicitRepo) {
  if (explicitRepo) return String(explicitRepo);
  const result = runGhPreflightJson(commandRunner, ['repo', 'view', '--json', 'nameWithOwner']);
  if (!result?.nameWithOwner) throw new PreflightError('cannot resolve repository owner/name for paginated issue-comment validation');
  return String(result.nameWithOwner);
}

function fetchAllPaginated(commandRunner, ownerName, endpoint, label) {
  const parts = String(ownerName).split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PreflightError(`cannot resolve repository owner/name: '${ownerName}'`);
  }
  const pages = runGhPreflightJson(commandRunner, [
    'api',
    '--paginate',
    '--slurp',
    `repos/${parts[0]}/${parts[1]}/${endpoint}?per_page=100`,
  ]);
  if (!Array.isArray(pages)) throw new PreflightError(`GitHub ${label} pagination returned incomplete data`);
  if (pages.some(page => !Array.isArray(page))) {
    throw new PreflightError(`GitHub ${label} pagination returned a malformed page`);
  }
  return pages.flat();
}

function fetchAllIssueComments(commandRunner, ownerName, issueNumber) {
  return fetchAllPaginated(commandRunner, ownerName, `issues/${issueNumber}/comments`, 'issue-comment');
}

function fetchAllPrConversationComments(commandRunner, ownerName, prNumber) {
  return fetchAllPaginated(commandRunner, ownerName, `issues/${prNumber}/comments`, 'PR-conversation comment');
}

function fetchAllPrReviews(commandRunner, ownerName, prNumber) {
  return fetchAllPaginated(commandRunner, ownerName, `pulls/${prNumber}/reviews`, 'PR review');
}

function repositoryContentEndpoint(ownerName, path, ref) {
  const [owner, repo] = String(ownerName).split('/');
  const encodedPath = String(path).split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
}

function fetchRepositoryContentAtRef(commandRunner, ownerName, path, ref) {
  const data = runGhPreflightJson(commandRunner, [
    'api',
    repositoryContentEndpoint(ownerName, path, ref),
  ]);
  if (!data || data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new PreflightError(`GitHub content response for '${path}' at '${ref}' is incomplete`);
  }
  return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf-8');
}

function hydrateSharedMutationContents(prData, issueData, commandRunner, ownerName) {
  const declaration = parseOwnershipDeclaration(issueData?.body);
  if (!declaration.present || declaration.errors.length > 0 || !(declaration.sharedMutations?.length > 0)) return;
  const changed = new Set(collectGitHubArtifactChangedPaths(prData?.files).paths);
  const baseRefOid = String(prData?.baseRefOid ?? '').toLowerCase();
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  prData.sharedMutationContents = {};
  for (const mutation of declaration.sharedMutations) {
    if (!changed.has(mutation.path)) continue;
    if (!/^[0-9a-f]{40}$/.test(baseRefOid) || !/^[0-9a-f]{40}$/.test(headRefOid)) {
      prData.sharedMutationContents[mutation.path] = {
        error: 'PR lacks exact base/head SHA identities for shared-operation validation',
      };
      continue;
    }
    try {
      prData.sharedMutationContents[mutation.path] = {
        baseContent: fetchRepositoryContentAtRef(commandRunner, ownerName, mutation.path, baseRefOid),
        headContent: fetchRepositoryContentAtRef(commandRunner, ownerName, mutation.path, headRefOid),
      };
    } catch (error) {
      prData.sharedMutationContents[mutation.path] = { error: error.message };
    }
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
 * @param {'accepted'|'closed'} [options.verificationStatus] Internal terminal
 *   lifecycle status for verification-attempt triage evaluation.
 * @param {string} [options.target] Local target root for project facts and references.
 * @param {object} [options.verificationContext] Injectable local validation context.
 * @param {{ login: string }} [options.expectedAccount] Injectable authenticated account.
 * @returns {object} the evaluatePreflight result.
 * @throws {PreflightError} on missing/incomplete GitHub data.
 */
export function runPreflight({
  pr,
  issue,
  repo,
  commandRunner = defaultGhCommandRunner,
  verificationStatus,
  target = process.cwd(),
  verificationContext,
  expectedAccount,
} = {}) {
  if (pr === undefined || pr === null || pr === '') {
    throw new PreflightError('--pr <number> is required');
  }
  const prNumber = Number(pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new PreflightError(`--pr must be a positive integer, got '${pr}'`);
  }

  const prArgs = ['pr', 'view', String(prNumber), '--json', PR_FIELDS];
  if (repo) prArgs.push('--repo', repo);
  const prData = runGhPreflightJson(commandRunner, prArgs);

  const { issueNumber } = resolveIssueNumber(prData, issue);

  const issueArgs = ['issue', 'view', String(issueNumber), '--json', ISSUE_FIELDS];
  if (repo) issueArgs.push('--repo', repo);
  const issueData = runGhPreflightJson(commandRunner, issueArgs);
  const ownerName = resolveRepoOwnerName(commandRunner, repo);
  hydrateSharedMutationContents(prData, issueData, commandRunner, ownerName);
  issueData.comments = fetchAllIssueComments(commandRunner, ownerName, issueNumber);
  // PR conversation comments are not interchangeable with task-issue comments:
  // the former are durable review/checkpoint carriers, the latter verification
  // attempt history. Both endpoints are paginated independently.
  prData.comments = fetchAllPrConversationComments(commandRunner, ownerName, prNumber);
  prData.reviews = fetchAllPrReviews(commandRunner, ownerName, prNumber);

  const localContext = verificationContext ?? createLocalVerificationContext(target);
  const authenticatedAccount = expectedAccount ?? resolveAuthenticatedAccount(commandRunner);
  const reviewHistory = collectGitHubReviewHistory(prData, authenticatedAccount);
  const reviewBudget = parseReviewBudget(issueData.body);

  return evaluatePreflight({
    prData,
    issueData,
    verificationStatus,
    ...localContext,
    expectedAccount: authenticatedAccount,
    reviewHistory,
    reviewBudget: reviewBudget.budget,
    reviewBudgetError: reviewBudget.error,
  });
}
