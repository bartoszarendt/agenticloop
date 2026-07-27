/**
 * Bounded improvement-proposal capture (`.agenticloop/improvements/`).
 *
 * Repeated friction remains the normal trigger for retrospective mining, but
 * one directly evidenced required-gate skip, bypass, fabrication, or material
 * misordering may create a proposal immediately. Proposals are human-reviewed:
 * creation never edits the proposed target surface, never promotes into
 * canonical methodology, and high-risk proposals mechanically require the
 * existing change-request boundary.
 *
 * Creation is transactional: the complete prospective record is validated
 * before an atomic create, IDs are allocated without overwriting collisions,
 * and a failed creation leaves no file or newly created empty directory
 * residue.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { durableReferenceErrors } from './durable-refs.js';
import { executeMutationBatch } from './fs-mutation-kernel.js';
import {
  IMPROVEMENT_PROPOSAL_RISK_LEVELS,
  IMPROVEMENT_PROPOSAL_SECTION_HEADINGS,
  IMPROVEMENT_PROPOSAL_STATUSES,
  IMPROVEMENT_PROPOSAL_TARGET_SURFACES,
  IMPROVEMENTS_DIRECTORY_RELATIVE_PATH,
} from './layout.js';

export { IMPROVEMENTS_DIRECTORY_RELATIVE_PATH };

export const IMPROVEMENT_ID_PATTERN = /^I-\d{4}-\d{2}-\d{2}-\d{3,}$/;

function frontmatterString(value) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function frontmatterList(value) {
  if (Array.isArray(value)) return value.map(item => frontmatterString(item)).filter(Boolean);
  return [];
}

/**
 * List improvement proposals (sorted) in a target.
 *
 * @param {string} repoRoot
 * @returns {{ improvementId: string, file: string, relPath: string, content: string }[]}
 */
export function listImprovementProposals(repoRoot) {
  const dir = join(repoRoot, IMPROVEMENTS_DIRECTORY_RELATIVE_PATH);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => ({
      improvementId: name.replace(/\.md$/, ''),
      file: join(dir, name),
      relPath: `${IMPROVEMENTS_DIRECTORY_RELATIVE_PATH}/${name}`,
      content: readFileSync(join(dir, name), 'utf-8'),
    }));
}

/**
 * Parse one improvement proposal.
 *
 * @param {string} content
 * @returns {object}
 */
export function parseImprovementProposal(content) {
  const [frontmatter] = parseFrontmatter(content);
  const fm = frontmatter ?? {};
  return {
    frontmatterPresent: frontmatter !== null,
    improvementId: frontmatterString(fm.improvement_id),
    status: frontmatterString(fm.status),
    date: frontmatterString(fm.date),
    supersedes: frontmatterList(fm.supersedes),
    relatedTasks: frontmatterList(fm.related_tasks),
    sourceRefs: frontmatterList(fm.source_refs),
    targetSurface: frontmatterString(fm.target_surface),
    targetPath: frontmatterString(fm.target_path),
    riskLevel: frontmatterString(fm.risk_level),
    requiresChangeRequest: fm.requires_change_request === true || fm.requires_change_request === 'true',
  };
}

/**
 * Validate one improvement proposal against the canonical template frontmatter
 * and section rules. This is the same contract the canonical template
 * validator enforces, applied to live proposals.
 *
 * @param {string} content
 * @param {string} relPath
 * @param {object} [options]
 * @param {object} [options.refContext]  Live durable-reference context; when
 *   supplied, every source_refs entry must resolve against live backend state.
 * @returns {string[]}
 */
export function validateImprovementProposal(content, relPath, options = {}) {
  const errors = [];
  const proposal = parseImprovementProposal(content);
  if (!proposal.frontmatterPresent) {
    return [`${relPath} missing YAML frontmatter`];
  }
  if (!proposal.improvementId) {
    errors.push(`${relPath} missing required frontmatter field 'improvement_id'`);
  } else if (!IMPROVEMENT_ID_PATTERN.test(proposal.improvementId)) {
    errors.push(`${relPath} improvement_id '${proposal.improvementId}' must match I-YYYY-MM-DD-NNN`);
  } else {
    const expected = relPath.split('/').pop()?.replace(/\.md$/, '');
    if (expected && expected !== proposal.improvementId) {
      errors.push(`${relPath} improvement_id '${proposal.improvementId}' must match its filename`);
    }
  }
  if (!proposal.date || !/^\d{4}-\d{2}-\d{2}$/.test(proposal.date)) {
    errors.push(`${relPath} requires frontmatter field 'date' in YYYY-MM-DD form`);
  }
  if (!IMPROVEMENT_PROPOSAL_STATUSES.includes(proposal.status)) {
    errors.push(`${relPath} status must be one of: ${IMPROVEMENT_PROPOSAL_STATUSES.join(', ')}`);
  }
  if (!IMPROVEMENT_PROPOSAL_RISK_LEVELS.includes(proposal.riskLevel)) {
    errors.push(`${relPath} risk_level must be one of: ${IMPROVEMENT_PROPOSAL_RISK_LEVELS.join(', ')}`);
  }
  if (!IMPROVEMENT_PROPOSAL_TARGET_SURFACES.includes(proposal.targetSurface)) {
    errors.push(`${relPath} target_surface must be one of: ${IMPROVEMENT_PROPOSAL_TARGET_SURFACES.join(', ')}`);
  }
  if (!proposal.targetPath) {
    errors.push(`${relPath} missing required frontmatter field 'target_path'`);
  }
  if (proposal.riskLevel === 'high' && !proposal.requiresChangeRequest) {
    errors.push(`${relPath} risk_level 'high' requires 'requires_change_request: true'`);
  }
  if (proposal.sourceRefs.length === 0) {
    errors.push(`${relPath} requires at least one durable 'source_refs' entry; a chat-only claim is not durable`);
  } else if (options.refContext) {
    for (const error of durableReferenceErrors(options.refContext, proposal.sourceRefs, 'source_ref')) {
      errors.push(`${relPath} ${error}`);
    }
  }
  for (const heading of IMPROVEMENT_PROPOSAL_SECTION_HEADINGS) {
    const pattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    if (!pattern.test(content)) {
      errors.push(`${relPath} is missing required section '${heading}'`);
    }
  }
  return errors;
}

/**
 * Allocate the next collision-safe proposal id for a date.
 *
 * @param {string[]} existingIds
 * @param {string} date  YYYY-MM-DD
 * @returns {string}
 */
export function nextImprovementId(existingIds, date) {
  let max = 0;
  for (const id of existingIds ?? []) {
    const match = String(id ?? '').match(/^I-(\d{4}-\d{2}-\d{2})-(\d{3,})$/);
    if (!match || match[1] !== date) continue;
    max = Math.max(max, Number(match[2]));
  }
  return `I-${date}-${String(max + 1).padStart(3, '0')}`;
}

function yamlList(key, values) {
  if (!values || values.length === 0) return `${key}: []`;
  return [`${key}:`, ...values.map(value => `  - ${value}`)].join('\n');
}

/**
 * Render one proposal from the canonical template shape.
 *
 * @param {object} options
 * @returns {string}
 */
export function renderImprovementProposal(options) {
  const lines = [
    '---',
    `improvement_id: ${options.improvementId}`,
    'status: proposed',
    `date: ${options.date}`,
    yamlList('supersedes', options.supersedes ?? []),
    yamlList('related_tasks', options.relatedTasks ?? []),
    yamlList('source_refs', options.sourceRefs),
    `target_surface: ${options.targetSurface}`,
    `target_path: ${options.targetPath}`,
    `risk_level: ${options.riskLevel}`,
    `requires_change_request: ${options.requiresChangeRequest === true}`,
    '---',
    '',
    `# ${options.improvementId}: ${options.title}`,
    '',
    '## Failure pattern',
    options.failurePattern,
    '',
    '## Evidence',
    options.evidence,
    '',
    '## Inferred mechanism',
    options.inferredMechanism ?? 'To be completed during human review.',
    '',
    '## Proposed change',
    options.proposedChange ?? 'To be completed during human review.',
    '',
    '## Expected behavioral effect',
    options.expectedEffect ?? 'To be completed during human review.',
    '',
    '## Regression risks',
    options.regressionRisks ?? 'To be completed during human review.',
    '',
    '## Candidate patch',
    options.candidatePatch ?? 'None yet.',
    '',
    '## Validation plan',
    options.validationPlan ?? 'To be completed during human review.',
    '',
    '## Rollback',
    options.rollback ?? 'Revert the proposed change through the ordinary change process.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Create one validated proposal transactionally. Returns the allocated id and
 * relative path on success. Never overwrites an existing proposal and leaves
 * no file or newly created empty directory residue on failure.
 *
 * @param {string} repoRoot
 * @param {object} options
 * @returns {{ ok: boolean, errors: string[], improvementId?: string, relPath?: string }}
 */
export function createImprovementProposal(repoRoot, options) {
  const errors = [];
  const title = String(options?.title ?? '').trim();
  if (!title) errors.push('improvement new requires --title');
  const targetSurface = String(options?.targetSurface ?? '').trim();
  if (!IMPROVEMENT_PROPOSAL_TARGET_SURFACES.includes(targetSurface)) {
    errors.push(`--target-surface must be one of: ${IMPROVEMENT_PROPOSAL_TARGET_SURFACES.join(', ')}`);
  }
  const targetPath = String(options?.targetPath ?? '').trim();
  if (!targetPath) errors.push('improvement new requires --target-path naming the proposed surface');
  const riskLevel = String(options?.riskLevel ?? '').trim().toLowerCase();
  if (!IMPROVEMENT_PROPOSAL_RISK_LEVELS.includes(riskLevel)) {
    errors.push(`--risk-level must be one of: ${IMPROVEMENT_PROPOSAL_RISK_LEVELS.join(', ')}`);
  }
  const sourceRefs = [...new Set((options?.sourceRefs ?? []).map(item => String(item ?? '').trim()).filter(Boolean))];
  if (sourceRefs.length === 0) {
    errors.push('improvement new requires at least one --source-ref citing durable evidence (audit id, marker ref, task id); a chat-only claim is not durable');
  }
  // Every source reference must resolve against live backend state before any
  // directory or file is created; a nonexistent artifact cannot be presented
  // as a recorded lesson.
  if (errors.length === 0 && options?.refContext) {
    errors.push(...durableReferenceErrors(options.refContext, sourceRefs, '--source-ref'));
  }
  if (errors.length > 0) return { ok: false, errors };

  const date = options?.date ?? new Date().toISOString().slice(0, 10);
  const existing = listImprovementProposals(repoRoot);
  const improvementId = nextImprovementId(existing.map(item => item.improvementId), date);
  const relPath = `${IMPROVEMENTS_DIRECTORY_RELATIVE_PATH}/${improvementId}.md`;
  if (existing.some(item => item.relPath === relPath)) {
    return { ok: false, errors: [`proposal id '${improvementId}' collides with an existing proposal; retry`] };
  }

  // High-risk proposals mechanically require the change-request boundary.
  const requiresChangeRequest = riskLevel === 'high' ? true : Boolean(options?.requiresChangeRequest);
  const content = renderImprovementProposal({
    improvementId,
    date,
    title,
    sourceRefs,
    targetSurface,
    targetPath,
    riskLevel,
    requiresChangeRequest,
    failurePattern: String(options?.failurePattern ?? '').trim() ||
      `Directly evidenced serious process-gate incident recorded through ${sourceRefs.join(', ')}.`,
    evidence: String(options?.evidence ?? '').trim() ||
      sourceRefs.map(ref => `- ${ref}: directly observed evidence.`).join('\n'),
    inferredMechanism: options?.inferredMechanism,
    proposedChange: options?.proposedChange,
    expectedEffect: options?.expectedEffect,
    regressionRisks: options?.regressionRisks,
    candidatePatch: options?.candidatePatch,
    validationPlan: options?.validationPlan,
    rollback: options?.rollback,
  });

  // Validate the complete prospective record before any write.
  const prospectiveErrors = validateImprovementProposal(content, relPath, { refContext: options?.refContext });
  if (prospectiveErrors.length > 0) {
    return { ok: false, errors: prospectiveErrors.map(error => `Cannot create proposal: ${error}`) };
  }

  // Narrow injection seam for collision testing and embedders that reserve an
  // ID externally. The exclusive mutation below remains the authority.
  try {
    options?.beforeCreate?.({ improvementId, relPath });
  } catch (error) {
    return { ok: false, errors: [`proposal creation failed before commit: ${error.message}`] };
  }

  const committed = executeMutationBatch(repoRoot, [{ type: 'create', path: relPath, content }]);
  if (!committed.ok) {
    return {
      ok: false,
      errors: [
        ...committed.errors.map(error => `proposal creation failed; no residue remains: ${error}`),
        ...committed.rollbackErrors.map(error => `rollback error: ${error}`),
      ],
    };
  }
  return { ok: true, errors: [], improvementId, relPath };
}
