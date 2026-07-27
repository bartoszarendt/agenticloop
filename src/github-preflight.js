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
import { parseFrontmatterStrict } from './frontmatter.js';
import { githubAttributionShape, resolveGitHubTaskIdentity, resolveGitHubTaskIdentityStrict } from './github-task-identity.js';
import {
  loadProjectMap,
  resolveProjectReviewBudget,
} from './project-map.js';
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
  countTaskBudgetFieldOccurrences,
  parseReviewCheckpoint,
  evaluateReviewCheckpoint,
  evaluateNoProgress,
  DEFAULT_REVIEW_BUDGET,
  parseReviewBudgetValue,
  resolveTaskAttemptBudget,
} from './review-checkpoint.js';
import { collectGitHubReviewHistory } from './review-history.js';
import {
  RESOLUTION_ENTRY_SHAPE,
  VALID_DISPOSITIONS,
  parseResolutionMatrix,
  validateResolutionMatrix,
} from './resolution-matrix.js';
import { evaluateTaskReadiness } from './task-readiness.js';
import { parseFinalTrailerBlock } from './commit-attribution.js';
import {
  createPreparationInput,
  evaluatePreparationInput,
} from './preparation-input.js';
import { deriveTaskContractLifecycle, parseTaskContractRecords, taskContractDigest, validateTaskContractBaseline, validateTrustedTaskContractRecords } from './task-contract-baseline.js';
import { normalizeGitHubCommentCarriers } from './github-comment-carrier.js';
import { resolveTrustedTaskContractActors } from './trusted-actors.js';
import { createDiagnostic, preflightDiagnosticCode, repairPolicyFor } from './repair-policy.js';

export class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreflightError';
  }
}

const VALID_VERDICTS = new Set(['passed', 'failed', 'blocked', 'not run']);
const PR_EVIDENCE_ENTRY_SHAPE =
  '- Required check: <exact required check text>\n  Verdict: <passed|failed|blocked|not run>\n  Evidence: <excerpt>';
const RESOLUTION_EXPECTED_SHAPE = RESOLUTION_ENTRY_SHAPE.replace(/^"|"$/g, '');

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
export function parseReviewBudget(taskBody, projectMapConfig = null) {
  const raw = String(taskBody ?? '');
  const strict = parseFrontmatterStrict(raw);
  const frontmatter = strict.data;
  const occurrences = countTaskBudgetFieldOccurrences(raw, 'review_budget');
  const projectBudget = resolveProjectReviewBudget(projectMapConfig);
  if (strict.state === 'malformed') {
    return { ...projectBudget, error: `task frontmatter is malformed (${strict.reason})` };
  }
  if (occurrences > 1) return { budget: projectBudget.budget, error: 'task record has duplicate review_budget frontmatter fields' };
  if (!frontmatter || !Object.hasOwn(frontmatter, 'review_budget')) {
    return projectBudget;
  }
  const parsed = parseReviewBudgetValue(frontmatter.review_budget);
  return parsed.error
    ? { ...parsed, error: `task ${parsed.error}` }
    : parsed;
}

/** Read the equivalent-attempt budget from GitHub task metadata. */
export function parseAttemptBudget(taskBody, projectMapConfig = null) {
  const strict = parseFrontmatterStrict(String(taskBody ?? ''));
  if (strict.state === 'malformed') {
    const fallback = resolveTaskAttemptBudget('', projectMapConfig);
    return { ...fallback, error: `task frontmatter is malformed (${strict.reason})` };
  }
  return resolveTaskAttemptBudget(taskBody, projectMapConfig);
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

const PROOF_KINDS = new Set(['command', 'manual', 'contract_proof']);
const SATISFACTION_SOURCES = new Set(['pr_body', 'status_check', 'manual_observation', 'automated_observation']);
const OBSERVATION_EVIDENCE_SOURCES = new Set(['pr_body', 'manual_observation', 'automated_observation']);
const OBSERVATION_LEVELS = new Set(['running_path', 'unit', 'parser', 'helper', 'mock']);
const REQUIRED_CHECK_METADATA_NAMES = [
  'kind',
  'proof kind',
  'source',
  'sources',
  'satisfaction source',
  'satisfaction sources',
  'observation',
  'observations',
];
const REQUIRED_CHECK_METADATA_RE = new RegExp(
  `(?:\\[|\\()\\s*(?:${REQUIRED_CHECK_METADATA_NAMES
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\s*:[^\\]\\)]*(?:\\]|\\))`,
  'gi'
);
const GENERIC_OBSERVATION_RESULT_RE =
  /^(?:\d+\s+(?:tests?|checks?|examples?|assertions?|cases?|scenarios?)\s+(?:passed?|passing|succeeded|green)|(?:all\s+)?(?:tests?|checks?\s+)?(?:passed|pass|ok|green|success(?:ful)?|done)\.?)$/i;

/**
 * Build the semantic fallback identity used when a required check has no
 * stable RC id. Recognized typed metadata remains available on the parsed
 * object but is not part of the human evidence label that must match.
 */
export function normalizeRequiredCheckMatchKey(text) {
  return normalizeCheckText(String(text ?? '').replace(REQUIRED_CHECK_METADATA_RE, ' '));
}

function metadataValue(text, names) {
  const joined = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(text ?? '').match(new RegExp(`(?:\\[|\\()\\s*(?:${joined})\\s*:\\s*([^\\]\)]+)`, 'i'));
  return match?.[1]?.trim() ?? null;
}

function parseObservationList(value) {
  return String(value ?? '').split(/[|,;]/).map(item => item.trim()).filter(Boolean);
}

/** Parse optional typed-proof annotations without changing legacy wording. */
function parseRequiredCheckMetadata(text, command) {
  const rawKind = metadataValue(text, ['kind', 'proof kind']);
  const kind = rawKind?.toLowerCase().replace(/[ -]+/g, '_') ?? (command ? 'command' : 'manual');
  const rawSources = metadataValue(text, ['source', 'sources', 'satisfaction source', 'satisfaction sources']);
  const sources = rawSources
    ? parseObservationList(rawSources).map(value => value.toLowerCase().replace(/[ -]+/g, '_'))
    : rawKind
      ? (kind === 'command'
        ? ['pr_body']
        : kind === 'contract_proof'
          // A declared contract_proof with no explicit source may be satisfied by
          // either manual or automated observation (D9); it is never silently
          // forced to manual-only. Automated evidence must still cover every
          // declared observation.
          ? ['manual_observation', 'automated_observation']
          : ['manual_observation'])
      : (command ? ['pr_body', 'status_check'] : ['pr_body']);
  // A declared observation may pin its oracle level as `name@level`; without an
  // explicit level the observation requires running-path evidence.
  const observations = [];
  const observationLevels = {};
  for (const raw of parseObservationList(metadataValue(text, ['observation', 'observations']))) {
    const at = raw.lastIndexOf('@');
    if (at > 0) {
      const id = raw.slice(0, at).trim();
      observations.push(id);
      observationLevels[id] = raw.slice(at + 1).trim().toLowerCase().replace(/[ -]+/g, '_');
    } else {
      observations.push(raw);
    }
  }
  return {
    kind,
    kindDeclared: Boolean(rawKind),
    allowedSources: sources,
    observations,
    observationLevels,
  };
}

/**
 * Parse the issue body's `## Required Checks` section. Every non-empty list
 * item is treated as a required check. The original text is preserved for
 * reporting; a normalized form is added for comparison, and `command` holds the
 * backtick command when the check is written as one (null for manual checks).
 *
 * @returns {{ text: string, normalized: string, matchKey: string, command: string|null, id: string|null }[]}
 */
export function parseRequiredChecks(issueBody) {
  const section = extractSectionBody(issueBody, '## Required Checks');
  if (section === null) return [];
  return topLevelListItems(section).map(text => {
    const command = extractCommand(text);
    return {
      text,
      normalized: normalizeCheckText(text),
      matchKey: normalizeRequiredCheckMatchKey(text),
      command,
      id: extractCheckId(text),
      ...parseRequiredCheckMetadata(text, command),
    };
  });
}

/**
 * Validate task-owned required-check declarations before any evidence or
 * status-check satisfaction path runs.
 *
 * @returns {{ index: number, check: string, reason: string, category: 'task_policy' }[]}
 */
export function validateRequiredCheckContracts(requiredChecks) {
  const checks = Array.isArray(requiredChecks) ? requiredChecks : [];
  const failures = [];
  const add = (index, reason) => failures.push({
    index,
    check: checks[index]?.text ?? '<unknown required check>',
    reason,
    category: 'task_policy',
  });

  for (const [index, check] of checks.entries()) {
    const kind = check.kind ?? (check.command ? 'command' : 'manual');
    const sources = check.allowedSources ?? (check.command ? ['pr_body', 'status_check'] : ['pr_body']);
    const observations = check.observations ?? [];
    const matchKey = check.matchKey ?? normalizeRequiredCheckMatchKey(check.text);

    if (!matchKey) add(index, 'required check has no semantic identity after typed metadata is removed');
    if (!PROOF_KINDS.has(kind)) add(index, `required check has invalid proof kind '${kind}'`);

    const invalidSources = sources.filter(source => !SATISFACTION_SOURCES.has(source));
    if (invalidSources.length > 0) {
      add(index, `required check declares invalid satisfaction source${invalidSources.length === 1 ? '' : 's'} (${invalidSources.join(', ')})`);
    }

    if (kind === 'command' && !check.command) {
      add(index, "command check must declare its exact command in a backtick code span");
    }
    if (sources.includes('status_check') && kind !== 'command') {
      add(index, "status_check satisfaction is allowed only for proof kind 'command'");
    }
    if (observations.length > 0 && !sources.some(source => OBSERVATION_EVIDENCE_SOURCES.has(source))) {
      add(index, 'declared observations require at least one structured PR-body observation source; a status-check-only contract is unsatisfiable');
    }
    for (const observation of observations) {
      const level = check.observationLevels?.[observation] ?? 'running_path';
      if (!OBSERVATION_LEVELS.has(level)) {
        add(index, `required check declares invalid oracle level '${level}' for observation '${observation}'`);
      }
    }
  }

  const ids = new Map();
  const idlessMatchKeys = new Map();
  for (const [index, check] of checks.entries()) {
    if (check.id) {
      const group = ids.get(check.id) ?? [];
      group.push(index);
      ids.set(check.id, group);
      continue;
    }
    const matchKey = check.matchKey ?? normalizeRequiredCheckMatchKey(check.text);
    if (!matchKey) continue;
    const group = idlessMatchKeys.get(matchKey) ?? [];
    group.push(index);
    idlessMatchKeys.set(matchKey, group);
  }
  for (const [id, indexes] of ids) {
    if (indexes.length > 1) add(indexes[0], `task uses duplicate required-check id '${id}'`);
  }
  for (const [matchKey, indexes] of idlessMatchKeys) {
    if (indexes.length > 1) {
      add(indexes[0], `multiple required checks share semantic identity '${matchKey}'; assign distinct RC-N ids`);
    }
  }

  return failures;
}

/**
 * Detect a current-head marker such as `Current PR head: <sha>` anywhere in the
 * provided text. Accepts a few equivalent phrasings; the documented form is
 * `Current PR head: <sha>`.
 *
 * @returns {string|null} lowercased SHA, or null when no marker is present.
 */
export function extractHeadMarker(text) {
  const liveText = markdownLines(String(text ?? '')).filter(line => line.live).map(line => line.raw).join('\n');
  const match = liveText.match(
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
     *             entries: { check: string, verdict: string|null, evidence: string|null, id?: string|null }[], errors: string[] }}
 */
export function parsePrEvidence(prBody) {
  const sectionData = markdownSection(String(prBody ?? ''), '## Evidence');
  const section = sectionData?.body ?? null;
  const headSha = extractHeadMarker(prBody);
  const entries = [];
  const errors = [];
  if (section !== null) {
    const reqRe = /^[-*]\s*Required check:\s*(.+?)\s*$/i;
    const verdictRe = /^Verdict:\s*(.+?)\s*$/i;
    const evidenceRe = /^Evidence:\s*(.+?)\s*$/i;
    const kindRe = /^Kind:\s*(.+?)\s*$/i;
    const sourceRe = /^Source:\s*(.+?)\s*$/i;
    const observationsRe = /^Observations:\s*(.+?)\s*$/i;
    const observationStartRe = /^Observation:\s*(.+?)\s*$/i;
    const levelRe = /^Level:\s*(.+?)\s*$/i;
    const resultRe = /^Result:\s*(.+?)\s*$/i;
    const artifactRe = /^(?:Implementation head|Artifact):\s*(.+?)\s*$/i;
    let current = null;
    let currentField = null;
    let currentObservation = null;
    let entryIndent = null;
    let continuationEligible = false;
    const append = value => {
      if (!current || !currentField) return;
      current[currentField] = `${current[currentField] ?? ''} ${value}`.replace(/\s+/g, ' ').trim();
    };
    const sectionLines = sectionData?.lines ?? markdownLines(section);
    const liveLines = sectionLines.filter(line => line.live);
    for (const sourceLine of sectionLines) {
      if (!sourceLine.live) {
        // Four-space continuation is valid only directly after a live field.
        // A blank line, fence, quote, or other non-live block ends that field.
        if (continuationEligible && current && currentField && /^ {4,}\S/.test(sourceLine.raw)) {
          append(sourceLine.raw.trim());
        } else {
          continuationEligible = false;
        }
        continue;
      }
      const rawLine = sourceLine.raw;
      const line = rawLine.trim();
      if (!line) {
        currentField = null;
        currentObservation = null;
        continuationEligible = false;
        continue;
      }
      const rawRequest = rawLine.match(/^( {0,3})[-*]\s*Required check:\s*(.+?)\s*$/i);
      const reqMatch = rawRequest ? line.match(reqRe) : null;
      if (reqMatch && (entryIndent === null || rawRequest[1].length === entryIndent)) {
        if (entryIndent === null) entryIndent = rawRequest[1].length;
        if (current) entries.push(current);
        current = { check: reqMatch[1].trim(), verdict: null, evidence: null };
        const id = extractCheckId(current.check);
        if (id) current.id = id;
        currentField = 'check';
        currentObservation = null;
        continuationEligible = true;
        continue;
      }
      if (current) {
        const observationStart = line.match(observationStartRe);
        if (observationStart) {
          // A structured per-observation record: id, oracle level, concrete
          // result, current implementation artifact, and satisfaction source.
          currentObservation = { id: observationStart[1].trim(), level: null, result: null, artifact: null, source: null };
          (current.observationRecords ??= []).push(currentObservation);
          currentField = null;
          continuationEligible = false;
          continue;
        }
        const observationsList = line.match(observationsRe);
        if (observationsList) {
          // Legacy name list, retained for diagnostics only; it never
          // satisfies a declared observation by itself.
          current.observations = parseObservationList(observationsList[1]);
          currentObservation = null;
          currentField = null;
          continuationEligible = false;
          continue;
        }
        if (currentObservation) {
          const levelMatch = line.match(levelRe);
          if (levelMatch) {
            currentObservation.level = levelMatch[1].trim().toLowerCase().replace(/[ -]+/g, '_');
            continue;
          }
          const resultMatch = line.match(resultRe);
          if (resultMatch) {
            currentObservation.result = resultMatch[1].trim();
            continue;
          }
          const observationSource = line.match(sourceRe);
          if (observationSource) {
            currentObservation.source = observationSource[1].trim().toLowerCase().replace(/[ -]+/g, '_');
            continue;
          }
          const observationArtifact = line.match(artifactRe);
          if (observationArtifact) {
            currentObservation.artifact = observationArtifact[1].trim().toLowerCase();
            continue;
          }
          // Unrecognized content ends the record so malformed fields cannot
          // leak into it.
          currentObservation = null;
        }
        const verdictMatch = line.match(verdictRe);
        if (verdictMatch) {
          current.verdict = verdictMatch[1].trim();
          currentField = 'verdict';
          continuationEligible = true;
          continue;
        }
        const evidenceMatch = line.match(evidenceRe);
        if (evidenceMatch) {
          current.evidence = evidenceMatch[1].trim();
          currentField = 'evidence';
          continuationEligible = true;
          continue;
        }
        const kindMatch = line.match(kindRe);
        if (kindMatch) {
          current.kind = kindMatch[1].trim().toLowerCase().replace(/[ -]+/g, '_');
          currentField = 'kind';
          continuationEligible = false;
          continue;
        }
        const sourceMatch = line.match(sourceRe);
        if (sourceMatch) {
          current.source = sourceMatch[1].trim().toLowerCase().replace(/[ -]+/g, '_');
          currentField = 'source';
          continuationEligible = false;
          continue;
        }
        const artifactMatch = line.match(artifactRe);
        if (artifactMatch) {
          current.artifact = artifactMatch[1].trim().toLowerCase();
          currentField = null;
          continuationEligible = false;
          continue;
        }
        if (continuationEligible && currentField && /^[ \t]+\S/.test(rawLine)) {
          append(line);
          continue;
        }
      }
      currentField = null;
      continuationEligible = false;
    }
    if (current) entries.push(current);
    if (entries.length === 0 && liveLines.some(line => /required\s+check\s*:/i.test(line.raw))) {
      errors.push('PR evidence entries must use a live bullet entry: - Required check: <exact required check text>, followed by Verdict: <passed|failed|blocked|not run> and Evidence: <excerpt>');
    }
  }
  return { section, headSha, entries, errors };
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
 * Compare PR head SHA marker against the actual head. Review preparation requires exact
 * full 40-character SHA equality; short prefixes are rejected.
 */
export function headMatches(claimed, actual) {
  if (!claimed || !actual) return false;
  const a = String(claimed).toLowerCase();
  const b = String(actual).toLowerCase();
  return a.length === 40 && b.length === 40 && a === b;
}

/**
 * Validate the canonical structured per-observation evidence shape. Every
 * declared observation needs its own record carrying the observation ID, the
 * execution/oracle level (running_path unless the task pins another level with
 * `name@level`), a concrete result or bounded excerpt, the current
 * implementation artifact, and the satisfaction source. Copied observation
 * names, generic pass counts, helper-only state, mock-bound arguments, and
 * parser/unit-only results never satisfy a running-path observation.
 *
 * @returns {string[]} validation failure reasons
 */
function validateObservationRecords(rc, entry, source, options) {
  const errors = [];
  const records = new Map();
  for (const record of entry.observationRecords ?? []) {
    if (records.has(record.id)) errors.push(`duplicate structured observation record '${record.id}'`);
    records.set(record.id, record);
  }
  const declaredLevels = rc.observationLevels ?? {};
  for (const observation of rc.observations ?? []) {
    const declaredLevel = declaredLevels[observation] ?? 'running_path';
    if (!OBSERVATION_LEVELS.has(declaredLevel)) {
      errors.push(`required check declares invalid oracle level '${declaredLevel}' for observation '${observation}'`);
      continue;
    }
    const record = records.get(observation);
    if (!record) {
      errors.push(`evidence is missing a structured record for declared observation '${observation}'; copied observation names or generic pass counts are not evidence`);
      continue;
    }
    if (!record.level) {
      errors.push(`observation '${observation}' must record its execution/oracle level`);
    } else if (!OBSERVATION_LEVELS.has(record.level)) {
      errors.push(`observation '${observation}' records invalid oracle level '${record.level}'`);
    } else if (record.level !== declaredLevel) {
      errors.push(`observation '${observation}' records '${record.level}' evidence but the task requires '${declaredLevel}' evidence`);
    }
    const result = String(record.result ?? '').trim();
    if (!result) {
      errors.push(`observation '${observation}' must record a concrete result or bounded excerpt`);
    } else if (result.length < 12 || GENERIC_OBSERVATION_RESULT_RE.test(result)) {
      errors.push(`observation '${observation}' result is not substantive; generic pass counts and bare verdicts are not evidence`);
    }
    if (!record.artifact) {
      errors.push(`observation '${observation}' must record the current implementation artifact`);
    } else if (options.currentArtifact && !headMatches(record.artifact, options.currentArtifact)) {
      errors.push(`observation '${observation}' records stale artifact evidence; expected the current implementation artifact`);
    }
    if (!record.source) {
      errors.push(`observation '${observation}' must record its satisfaction source`);
    } else if (record.source !== source) {
      errors.push(`observation '${observation}' source '${record.source}' does not match the evidence satisfaction source '${source}'`);
    }
  }
  return errors;
}

/**
 * Validate the final-state fields that every parsed PR-body evidence entry owns,
 * independent of whether a caller supplied the task's required-check context.
 *
 * @returns {{ verdict: string, errors: string[], warnings: string[] }}
 */
export function validateEvidenceEntryFinality(entry) {
  const errors = [];
  const warnings = [];
  const verdict = String(entry?.verdict ?? '').toLowerCase().trim();
  const label = String(entry?.check ?? '').trim() || '<unnamed evidence entry>';
  if (!verdict) {
    errors.push('evidence entry is missing a Verdict line');
  } else if (!VALID_VERDICTS.has(verdict)) {
    errors.push(`unrecognized verdict '${entry.verdict}'; expected one of: ${[...VALID_VERDICTS].join(', ')}`);
  } else if (verdict === 'not run') {
    errors.push("verdict 'not run' is not final-state evidence");
  }
  if (!String(entry?.evidence ?? '').trim()) {
    errors.push('evidence entry is missing an Evidence excerpt');
  }
  if (errors.length === 0 && (verdict === 'failed' || verdict === 'blocked')) {
    warnings.push(`Required check '${label}' reports verdict '${verdict}'`);
  }
  return { verdict, errors, warnings };
}

/**
 * Compare required checks to PR-body evidence and status checks.
 *
 * @returns {{ matches: object[], statusSubstitutions: object[],
 *             missing: { check: string, reason: string, category?: string,
 *                        owner?: string, nextAction?: string }[], warnings: string[] }}
 */
export function compareRequiredChecksToEvidence(requiredChecks, evidenceEntries, statusChecks, options = {}) {
  const matches = [];
  const statusSubstitutions = [];
  const missing = [];
  const warnings = [];
  const contractFailures = validateRequiredCheckContracts(requiredChecks);
  if (contractFailures.length > 0) {
    return {
      matches,
      statusSubstitutions,
      missing: contractFailures.map(({ index: _index, ...failure }) => failure),
      warnings,
    };
  }

  for (const rc of requiredChecks) {
    const allowedSources = rc.allowedSources ?? (rc.command ? ['pr_body', 'status_check'] : ['pr_body']);
    const proofKind = rc.kind ?? (rc.command ? 'command' : 'manual');
    const observations = rc.observations ?? [];
    const entry = evidenceEntries.find(e =>
      rc.id
        ? extractCheckId(e.check) === rc.id
        : normalizeRequiredCheckMatchKey(e.check) === (rc.matchKey ?? normalizeRequiredCheckMatchKey(rc.text))
    );
    if (entry) {
      const source = entry.source ?? 'pr_body';
      // An evidence entry's kind is inferred from its own shape, never from the
      // required check it attempts to satisfy: an explicit Kind declaration
      // wins, otherwise a backtick command is command evidence and any other
      // legacy entry is manual. A command-shaped entry can therefore never
      // satisfy a manual check.
      const entryKind = entry.kind ?? (extractCommand(entry.check) ? 'command' : 'manual');
      if (!PROOF_KINDS.has(proofKind)) {
        missing.push({ check: rc.text, reason: `required check has invalid proof kind '${proofKind}'` });
        continue;
      }
      if (!allowedSources.every(value => SATISFACTION_SOURCES.has(value))) {
        missing.push({ check: rc.text, reason: `required check declares an invalid satisfaction source (${allowedSources.join(', ')})` });
        continue;
      }
      if (!PROOF_KINDS.has(entryKind)) {
        missing.push({ check: rc.text, reason: `evidence records invalid proof kind '${entryKind}'` });
        continue;
      }
      if (rc.kindDeclared && !entry.kind) {
        missing.push({ check: rc.text, reason: `evidence must record proof kind '${rc.kind}'` });
        continue;
      }
      if (entryKind !== proofKind) {
        missing.push({ check: rc.text, reason: `evidence proof kind '${entryKind}' does not match declared '${proofKind}'` });
        continue;
      }
      if (!SATISFACTION_SOURCES.has(source)) {
        missing.push({ check: rc.text, reason: `evidence records invalid satisfaction source '${source}'` });
        continue;
      }
      if (!allowedSources.includes(source)) {
        missing.push({ check: rc.text, reason: `evidence satisfaction source '${source}' is not allowed for this ${proofKind} check` });
        continue;
      }
      const requiredCommand = rc.command;
      const evidencedCommand = extractCommand(entry.check);
      if (requiredCommand && !evidencedCommand) {
        missing.push({ check: rc.text, reason: `command evidence must record the exact declared command '${requiredCommand}'` });
        continue;
      }
      if (requiredCommand && evidencedCommand !== requiredCommand) {
        missing.push({ check: rc.text, reason: `evidence command '${evidencedCommand}' does not match declared command '${requiredCommand}'` });
        continue;
      }
      if (observations.length > 0) {
        const observationErrors = validateObservationRecords(rc, entry, source, options);
        if (observationErrors.length > 0) {
          for (const reason of observationErrors) missing.push({ check: rc.text, reason });
          continue;
        }
      }
      if ((proofKind === 'manual' || proofKind === 'contract_proof') && rc.kindDeclared && !entry.artifact) {
        missing.push({ check: rc.text, reason: `${proofKind} evidence must record the exact implementation head` });
        continue;
      }
      if (entry.artifact && options.currentArtifact && !headMatches(entry.artifact, options.currentArtifact)) {
        missing.push({ check: rc.text, reason: `evidence implementation head '${entry.artifact}' is not the current artifact` });
        continue;
      }
      const finality = options.finalityValidated
        ? { verdict: String(entry?.verdict ?? '').toLowerCase().trim(), errors: [], warnings: [] }
        : validateEvidenceEntryFinality(entry);
      if (finality.errors.length > 0) {
        for (const reason of finality.errors) missing.push({ check: rc.text, reason });
        continue;
      }
      warnings.push(...finality.warnings);
      if (rc.id && normalizeCheckText(entry.check) !== rc.normalized) {
        warnings.push(`Evidence for ${rc.id} matched by stable id but its displayed check text differs from the issue`);
      }
      matches.push({ check: rc.text, id: rc.id ?? null, via: 'pr-body', verdict: finality.verdict, kind: proofKind, source });
      continue;
    }

    if (observations.length > 0) {
      missing.push({
        check: rc.text,
        reason: 'declared observations require explicit structured PR-body evidence; a status check cannot substitute',
      });
      continue;
    }
    const statusMatches = allowedSources.includes('status_check') ? matchStatusChecks(rc, statusChecks) : [];
    if (statusMatches.length === 1) {
      const name = statusCheckName(statusMatches[0]);
      matches.push({ check: rc.text, id: rc.id ?? null, via: 'status-check', statusCheck: name, kind: proofKind, source: 'status_check' });
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
      normalized: normalizeRequiredCheckMatchKey(candidate.check),
    }));
    const requiredMatchKey = rc.matchKey ?? normalizeRequiredCheckMatchKey(rc.text);
    const near = normalizedCandidates.find(candidate =>
      candidate.normalized.length >= 12 &&
      (candidate.normalized.startsWith(requiredMatchKey) || requiredMatchKey.startsWith(candidate.normalized))
    );
    const nearHint = near ? `; closest parsed PR-body entry is '${near.text}'` : '';
    missing.push({
      check: rc.text,
      reason: rc.command
        ? `command check has no acceptable evidence entry${allowedSources.includes('status_check') ? ' and no exact-match successful status check' : ''}${nearHint}`
        : `${proofKind === 'manual' ? 'manual check requires explicit PR-body evidence' : `${proofKind} check requires its declared observation evidence`}; a generic status check cannot substitute${nearHint}`,
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
 * Uses the canonical final-trailer-block parser shared with the local
 * commit-attribution check: the final contiguous run of `Token: value` lines
 * over live lines (fenced code, blockquotes, and indented code ignored).
 * Standard trailers like Co-authored-by, Signed-off-by, and Reviewed-by are
 * allowed alongside Task: and Agent: without breaking the block.
 *
 * @returns {{ errors: string[], warnings: string[], attributionEstablished: boolean }}
 */
export function validateAttribution(prBody, headCommitMessage, issueData) {
  const errors = [];
  const warnings = [];
  let attributionEstablished = false;

  const taskIdentity = resolveGitHubTaskIdentity(issueData);
  const liveBodyLines = markdownLines(prBody ?? '').filter(line => line.live).map(line => line.raw);
  const bodyRoles = liveBodyLines
    .map(line => line.trim().match(/^\[\[agent:\s*([a-z_]+)\]\]$/i)?.[1].toLowerCase() ?? null)
    .filter(Boolean);
  const finalBodyLine = [...liveBodyLines].reverse().find(line => line.trim())?.trim() ?? '';
  const finalBodyRole = finalBodyLine.match(/^\[\[agent:\s*([a-z_]+)\]\]$/i)?.[1].toLowerCase() ?? null;
  if (!finalBodyRole) {
    if (bodyRoles.length > 0) {
      errors.push("body role trailer must be the final live nonblank line; expected '[[agent: engineer]]', '[[agent: maintainer]]', or '[[agent: orchestrator]]'");
    }
    return { errors, warnings, attributionEstablished: false };
  }
  if (!['engineer', 'maintainer', 'orchestrator'].includes(finalBodyRole)) {
    errors.push(`body role trailer references unknown role '${finalBodyRole}'; expected '[[agent: engineer]]', '[[agent: maintainer]]', or '[[agent: orchestrator]]'`);
    return { errors, warnings, attributionEstablished: false };
  }
  if (new Set(bodyRoles).size > 1) {
    errors.push('body contains conflicting live role trailers');
  }
  const bodyRole = finalBodyRole;

  // The canonical final-trailer-block parser is shared with the local
  // commit-attribution check so live and offline attribution agree exactly:
  // the final contiguous run of `Token: value` lines (standard Git trailers
  // allowed) is authoritative, a blank separator is not required, and
  // Task/Agent lines outside that block are misplaced rather than scanned.
  const { named, misplaced } = parseFinalTrailerBlock(headCommitMessage ?? '');
  const taskMatches = named.filter(entry => entry.name === 'task').map(entry => entry.value);
  const agentMatches = named.filter(entry => entry.name === 'agent').map(entry => entry.value);

  const expectedTaskId = taskIdentity?.taskId ?? null;
  const expectedShape = expectedTaskId ? githubAttributionShape(expectedTaskId, bodyRole) : null;
  if (misplaced.length) {
    errors.push(`head commit has misplaced Task/Agent trailer(s) outside the final contiguous trailer block: ${[...new Set(misplaced)].join(', ')}`);
  }
  if (taskMatches.length === 0) {
    errors.push(expectedShape
      ? `head commit is missing required Task: trailer; expected '${expectedShape.taskTrailer}'`
      : 'head commit is missing required Task: trailer; linked task identity is unresolved');
  }
  if (agentMatches.length === 0) {
    errors.push(`head commit is missing required Agent: trailer; expected 'Agent: ${bodyRole}'`);
  }

  // Check for duplicate trailers
  if (taskMatches.length > 1) {
    errors.push(`head commit has duplicate Task: trailers`);
  }
  if (agentMatches.length > 1) {
    errors.push(`head commit has duplicate Agent: trailers`);
  }

  attributionEstablished = true;

  if (taskMatches.length === 1 && expectedTaskId) {
    const commitTask = taskMatches[0].trim();
    if (commitTask !== expectedTaskId) {
      errors.push(`head commit Task: '${commitTask}' does not match expected '${expectedShape.taskTrailer}'`);
    }
  }

  if (agentMatches.length === 1) {
    const commitAgent = agentMatches[0].toLowerCase();
    if (commitAgent !== bodyRole) {
      errors.push(`head commit Agent: '${agentMatches[0]}' does not match expected 'Agent: ${bodyRole}' for body trailer '${expectedShape?.bodyTrailer ?? `[[agent: ${bodyRole}]]`}'`);
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
export const PREFLIGHT_DIAGNOSTIC_CATEGORIES = Object.freeze([
  'head_identity',
  'summary_shape',
  'scope_deviations',
  'task_contract',
  'path_intent',
  'generated_paths',
  'dependencies',
  'attribution',
  'evidence',
  'checks',
  'task_policy',
  'review_checkpoint',
  'revision_resolution',
  'review_provenance',
  'other',
]);

export function categorizePreflightErrors(errors) {
  const categories = Object.fromEntries(
    PREFLIGHT_DIAGNOSTIC_CATEGORIES.map(category => [category, []])
  );

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

const UNMAPPED_PREFLIGHT_DIAGNOSTIC_CATEGORIES = PREFLIGHT_DIAGNOSTIC_CATEGORIES.filter(
  category => !repairPolicyFor(preflightDiagnosticCode(category)).repairKind
);
if (UNMAPPED_PREFLIGHT_DIAGNOSTIC_CATEGORIES.length > 0) {
  throw new Error(`preflight diagnostic categories lack repair kinds: ${UNMAPPED_PREFLIGHT_DIAGNOSTIC_CATEGORIES.join(', ')}`);
}

/**
 * Preserve legacy string arrays while exposing stable repair metadata to
 * `github-preflight --json` consumers.
 *
 * @param {Array<string|{ message: string, category?: string, expectedShape?: string, expectedValues?: string[], requiredFindingIds?: string[] }>} items
 */
function normalizePreflightDiagnostics(items) {
  return items.map(item => {
    const message = typeof item === 'string' ? item : item.message;
    const inferredCategory = categorizePreflightErrors([item])[0]?.category ?? 'other';
    const category = typeof item === 'object' && item.category ? item.category : inferredCategory;
    const code = typeof item === 'object' && typeof item.code === 'string'
      ? item.code
      : category === 'checks' && /has no non-empty '## Required Checks' section/.test(message)
        ? 'preflight.checks.task_contract'
        : preflightDiagnosticCode(category);
    const diagnostic = createDiagnostic({
      code,
      message,
      evidence: typeof item === 'object' && item.evidence && typeof item.evidence === 'object'
        ? item.evidence
        : {},
    });
    if (typeof item === 'object' && typeof item.expectedShape === 'string') {
      diagnostic.expectedShape = item.expectedShape;
    }
    if (typeof item === 'object' && Array.isArray(item.expectedValues)) {
      diagnostic.expectedValues = [...item.expectedValues];
    }
    if (typeof item === 'object' && Array.isArray(item.requiredFindingIds)) {
      diagnostic.requiredFindingIds = [...item.requiredFindingIds];
    }
    return diagnostic;
  });
}

/**
 * Canonical serialized shape of a review-history object for content-level
 * consistency comparison. Event and error content is compared, never merely
 * array lengths.
 */
function canonicalHistoryShape(history) {
  return JSON.stringify({
    events: Array.isArray(history?.events) ? history.events : [],
    errors: Array.isArray(history?.errors) ? history.errors : [],
  });
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
 * @param {number} [params.reviewBudget] Effective review budget override (built-in default: 5).
 * @param {object} [params.projectMapConfig] Project policy used to resolve attempt_budget.
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
  projectMapConfig = null,
  basePaths,
  mode,
  pathInventoryRequired = false,
}) {
  const errors = [];
  const warnings = [];
  const headRefOid = String(prData?.headRefOid ?? '').toLowerCase();
  const prNumber = prData?.number ?? null;
  const issueNumber = issueData?.number ?? null;
  const attemptBudget = parseAttemptBudget(issueData?.body, projectMapConfig);
  if (attemptBudget.error) {
    errors.push({ message: attemptBudget.error, category: 'task_policy' });
  }
  const strictTaskIdentity = resolveGitHubTaskIdentityStrict(issueData);
  if (!strictTaskIdentity.ok) errors.push(strictTaskIdentity.diagnostic);
  const trustedActorConfig = resolveTrustedTaskContractActors(projectMapConfig);
  for (const message of trustedActorConfig.errors) errors.push({ message, category: 'task_contract' });
  for (const message of trustedActorConfig.warnings) warnings.push(message);
  const trustedActors = trustedActorConfig.actors;
  const parsedCarrierRecords = parseTaskContractRecords(normalizeGitHubCommentCarriers(issueData?.comments, { trustedActors }));
  const trustedCarrierRecords = validateTrustedTaskContractRecords(parsedCarrierRecords.parsedRecords, {
    taskId: taskContractDigest(issueData?.body).projection?.task_id,
    trustedActors,
  });
  const contractBaseline = validateTaskContractBaseline(issueData?.body, {
    lifecycle: deriveTaskContractLifecycle(issueData?.body),
    trustedRecords: trustedCarrierRecords.trustedRecords,
    trustedRecordErrors: [...parsedCarrierRecords.parseErrors, ...trustedCarrierRecords.errors],
  });
  for (const message of [...(parsedCarrierRecords.parseWarnings ?? []), ...(trustedCarrierRecords.warnings ?? [])]) {
    warnings.push(message);
  }
  for (const message of contractBaseline.errors) {
    errors.push(createDiagnostic({
      code: message.includes('differs from the trusted baseline')
        ? 'contract.baseline.stale'
        : message.includes('trusted task-contract baseline record')
          ? 'contract.baseline.missing'
          : 'contract.baseline.invalid',
      message,
    }));
  }
  for (const message of contractBaseline.warnings) {
    warnings.push(createDiagnostic({ code: 'contract.baseline.missing', message, level: 'warning' }));
  }

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
  for (const error of evidence.errors) {
    errors.push({
      message: error,
      category: 'evidence',
      expectedShape: PR_EVIDENCE_ENTRY_SHAPE,
      expectedValues: [...VALID_VERDICTS],
    });
  }
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
    prData?.statusCheckRollup,
    { currentArtifact: headRefOid }
  );

  for (const item of comparison.missing) {
    const taskContractFailure = item.category === 'task_policy';
    const message = taskContractFailure
      ? `Required-check contract '${item.check}' is invalid: ${item.reason}`
      : `Required check '${item.check}' has no acceptable evidence: ${item.reason}`;
    if (taskContractFailure) {
      errors.push({
        message,
        category: item.category,
      });
    } else {
      errors.push(item.reason.startsWith('unrecognized verdict ')
        ? { message, category: 'evidence', expectedValues: [...VALID_VERDICTS] }
        : message);
    }
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

  // Path/deviation validation. Deviations are parsed exactly once
  // and `validatePathsAgainstDeviations` is the single changed-path authority.
  // When the path inventory is required, task readiness runs that authority
  // (with generated-path authorization); otherwise preflight runs it here.
  const scopePatterns = parseScopePatterns(issueData?.body);
  const prFiles = Array.isArray(prData?.files)
    ? prData.files.map(f => typeof f === 'string' ? f : (f?.path ?? '')).filter(Boolean)
    : [];
  const deviations = scopePatterns?.patterns ? parseDeviations(prData?.body) : { entries: [], errors: [] };
  let pathValidation = null;
  if (scopePatterns) {
    if (scopePatterns.error) {
      errors.push({ message: scopePatterns.error, category: 'scope_deviations' });
    } else if (scopePatterns.patterns && !pathInventoryRequired) {
      for (const err of deviations.errors) {
        errors.push({ message: err, category: 'scope_deviations' });
      }
    }
  }
  let taskReadiness = null;
  if (pathInventoryRequired) {
    taskReadiness = evaluateTaskReadiness({
      taskBody: issueData?.body,
      basePaths,
      mode: mode ?? 'review',
      changedPaths: prFiles,
      deviationEntries: deviations.entries,
      deviationErrors: deviations.errors,
      projectFacts,
    });
    for (const diagnostic of taskReadiness.diagnostics) {
      const target = diagnostic.level === 'error' ? errors : warnings;
      target.push(diagnostic);
    }
  }
  if (scopePatterns?.patterns && prFiles.length > 0 && !taskReadiness?.deviations) {
    pathValidation = validatePathsAgainstDeviations(prFiles, scopePatterns.patterns, deviations.entries);
    for (const err of pathValidation.errors) {
      errors.push({ message: err, category: 'scope_deviations' });
    }
  }

  // `allowed_paths` remains the broad scope/deviation map. When a task opts
  // into structured ownership, the exact current PR file list must also stay
  // inside its exclusive ownership or its declared exact shared mutations.
  const ownership = parseOwnershipDeclaration(issueData?.body);
  const taskFrontmatter = parseFrontmatterStrict(String(issueData?.body ?? '')).data;
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

  // Completion-summary shape validation
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

  // Attribution validation (when mechanically establishable)
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

  // Review Round Checkpoint enforcement. Raw PR comments/reviews
  // are the authorization source of truth: whenever the carrier fields are
  // part of the input, durable history is derived from them and any supplied
  // serialized reviewHistory is only a diagnostic/cache copy that must match
  // the derived history in canonical event/error content, never merely in
  // length. A fabricated or stale supplied history can never authorize
  // evaluation. When the carrier fields are entirely absent, the documented
  // legacy pure-helper contract trusts the explicit reviewHistory/
  // reviewOutcomes inputs instead.
  let checkpointValidation = null;
  const hasCarrierFields = Array.isArray(prData?.comments) || Array.isArray(prData?.reviews);
  const carrierDerivedHistory = hasCarrierFields ? collectGitHubReviewHistory(prData, expectedAccount) : null;
  let durableHistory;
  if (carrierDerivedHistory) {
    durableHistory = carrierDerivedHistory;
    if (reviewHistory && canonicalHistoryShape(reviewHistory) !== canonicalHistoryShape(carrierDerivedHistory)) {
      errors.push({ message: 'supplied reviewHistory is inconsistent with the raw PR comments/reviews; derive review history from those carriers rather than supplying a fabricated, stale, or empty normalized history', category: 'review_checkpoint' });
    }
  } else {
    durableHistory = reviewHistory ?? { events: [], errors: [] };
  }
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

  const noProgressValidation = evaluateNoProgress({ reviewHistory: historyEvents });
  for (const err of noProgressValidation.errors) {
    errors.push({ message: err, category: 'review_checkpoint' });
  }

  // Every re-review resolves the stable finding IDs from the latest
  // valid `needs_revision` carrier. Parser errors are part of the gate; a
  // duplicate matrix bullet entry cannot become valid merely because map lookup wins.
  let resolutionMatrixValidation = null;
  const reviewEvents = historyEvents.length > 0 ? historyEvents : reviewOutcomes;
  const priorOutcome = [...reviewEvents].reverse().find(outcome =>
    !outcome?.legacyMissingFindingIds && outcome?.type !== 'checkpoint' &&
    outcome?.status === 'needs_revision' && Array.isArray(outcome.findingIds)
  );
  const priorFindingIds = priorOutcome?.findingIds ?? [];
  if (priorOutcome && priorFindingIds.length > 0) {
    /** @param {string} message */
    const resolutionDiagnostic = message => ({
      message,
      category: 'revision_resolution',
      expectedShape: RESOLUTION_EXPECTED_SHAPE,
      expectedValues: [...VALID_DISPOSITIONS],
      requiredFindingIds: [...priorFindingIds],
    });
    const matrixResult = parseResolutionMatrix(prData?.body);
    for (const parserError of matrixResult.errors) {
      errors.push(resolutionDiagnostic(parserError));
    }
    if (matrixResult.status === 'absent') {
      errors.push(resolutionDiagnostic(
        `re-review requires a resolution matrix for finding IDs: ${priorFindingIds.join(', ')}`
      ));
    } else if (matrixResult.status === 'parsed') {
      resolutionMatrixValidation = validateResolutionMatrix({
        requiredFindingIds: priorFindingIds,
        entries: matrixResult.entries,
        currentArtifact: headRefOid,
      });
      for (const err of resolutionMatrixValidation.errors) {
        errors.push(resolutionDiagnostic(err));
      }
      for (const warn of resolutionMatrixValidation.warnings) {
        warnings.push(resolutionDiagnostic(warn));
      }
    }
  }

  const ok = errors.length === 0;

  // Extract plain error strings for backward compatibility
  const errorStrings = errors.map(e => typeof e === 'string' ? e : e.message);

  return {
    schemaVersion: 1,
    ok,
    errors: errorStrings,
    warnings: warnings.map(w => typeof w === 'string' ? w : w.message),
    diagnostics: normalizePreflightDiagnostics(errors),
    warningDiagnostics: normalizePreflightDiagnostics(warnings),
    pr: prNumber,
    issue: issueNumber,
    headRefOid,
    requiredChecks,
    evidenceMatches: comparison.matches,
    statusSubstitutions: comparison.statusSubstitutions,
    missing: comparison.missing,
    failureCategories: ok ? [] : categorizePreflightErrors(errors),
    pathValidation: pathValidation ? { unmatched: pathValidation.unmatched, missingDeviations: pathValidation.missingDeviations } : null,
    taskReadiness: taskReadiness ? { ok: taskReadiness.ok, paths: taskReadiness.paths, dependencies: taskReadiness.dependencies } : null,
    summaryValidation: { errors: summaryValidation.errors.map(e => typeof e === 'string' ? e : e.message) },
    attributionValidation: { established: attributionValidation.attributionEstablished, errors: attributionValidation.errors },
    attemptBudget: { budget: attemptBudget.budget, source: attemptBudget.source ?? 'task' },
    contractBaseline: {
      ok: contractBaseline.ok,
      digest: contractBaseline.digest,
      baseline: contractBaseline.baseline,
    },
    reviewHistory: { events: historyEvents.length, errors: durableHistory?.errors ?? [] },
    checkpointValidation: checkpointValidation ? { authorized: checkpointValidation.authorized, errors: checkpointValidation.errors } : null,
    noProgressValidation: {
      authorized: noProgressValidation.authorized,
      required: noProgressValidation.required,
      sustainedFindingIds: noProgressValidation.sustainedFindingIds,
      disposition: noProgressValidation.disposition?.disposition ?? null,
      errors: noProgressValidation.errors,
    },
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

function fetchBaseTreePaths(commandRunner, ownerName, baseRefOid) {
  if (!/^[0-9a-f]{40}$/i.test(String(baseRefOid ?? ''))) {
    throw new PreflightError('PR baseRefOid is unavailable or not a full SHA; cannot build the required base-tree path inventory');
  }
  const data = runGhPreflightJson(commandRunner, [
    'api',
    `repos/${ownerName}/git/trees/${baseRefOid}?recursive=1`,
  ]);
  if (!data || !Array.isArray(data.tree) || data.truncated === true) {
    throw new PreflightError('GitHub base-tree inventory is incomplete; cannot silently skip task path readiness');
  }
  return data.tree
    .filter(entry => entry?.type === 'blob' && typeof entry.path === 'string')
    .map(entry => entry.path.replace(/\\/g, '/'));
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
export function loadPreflightInput({
  pr,
  issue,
  repo,
  commandRunner = defaultGhCommandRunner,
  verificationStatus,
  target = process.cwd(),
  verificationContext,
  expectedAccount,
  includeBasePaths = true,
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
  // `gh pr view --json` always returns the requested list fields as arrays;
  // normalize explicitly so the preparation-input completeness policy sees
  // every category rather than a silently omitted one.
  for (const field of ['files', 'closingIssuesReferences', 'statusCheckRollup', 'commits']) {
    if (!Array.isArray(prData[field])) prData[field] = [];
  }

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
  const projectMapConfig = loadProjectMap(target)?.config ?? null;
  const reviewBudget = parseReviewBudget(issueData.body, projectMapConfig);

  // A base inventory is relevant only to the explicit path contract. This keeps
  // legacy tasks with no structured paths behavior-preserving while every task
  // that declares paths is evaluated against the exact PR base tree.
  const requiresPathInventory = includeBasePaths && Boolean(parseScopePatterns(issueData.body)?.patterns?.length);
  const basePaths = requiresPathInventory ? fetchBaseTreePaths(commandRunner, ownerName, prData.baseRefOid) : [];
  return {
    repo: ownerName,
    input: createPreparationInput({
      prData,
      issueData,
      expectedAccount: authenticatedAccount,
      reviewHistory,
      basePaths,
      mode: 'review',
      projectFacts: localContext.projectFacts,
      verificationStatus,
      reviewBudget: reviewBudget.budget,
      reviewBudgetError: reviewBudget.error,
      projectMapConfig,
      pathInventoryRequired: requiresPathInventory,
    }),
    referenceResolvers: {
      decisionExists: localContext.decisionExists,
      taskExists: localContext.taskExists,
    },
  };
}

/** Load live GitHub data and evaluate it through the serializable input contract. */
export function runPreflight(options = {}) {
  const loaded = loadPreflightInput(options);
  return evaluatePreparationInput(loaded.input, evaluatePreflight, {
    referenceResolvers: loaded.referenceResolvers,
  });
}
