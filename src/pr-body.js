/** Canonical, intentionally incomplete PR-body scaffold and structural offline lint. */

import { formatResolutionMatrix, parseResolutionMatrix, validateResolutionMatrix } from './resolution-matrix.js';
import { createDiagnostic } from './repair-policy.js';
import { markdownLines, markdownSection } from './markdown.js';
import { isFileInScope, parseDeviations, parseScopePatterns } from './scope-matcher.js';
import { parseTaskReadinessDeclaration } from './task-readiness.js';
import { resolveGitHubTaskIdentity } from './github-task-identity.js';
import {
  compareRequiredChecksToEvidence,
  extractHeadMarker,
  headMatches,
  parsePrEvidence,
  validateEvidenceEntryFinality,
} from './github-preflight.js';

const PLACEHOLDER_RE = /\bREPLACE\b|\bTODO\b|\bTBD\b|<<<.*?>>>|<replace[^>]*>|<[^>]*placeholder[^>]*>/i;
const REQUIRED_SECTIONS = ['## Scope Completed', '## Artifacts', '## Evidence', '## Deviations', '## Known Gaps', '## Follow-Ups'];

/**
 * Pick the one allowed evidence source the scaffold may render. A
 * status-check-only command check is satisfied by the canonical substitution
 * rule (no body entry); it is never scaffolded with a disallowed `pr_body`
 * source.
 */
function scaffoldSource(check) {
  const allowed = check.allowedSources ?? [];
  const kind = check.kind ?? (check.command ? 'command' : 'manual');
  if (kind === 'command') {
    if (allowed.includes('pr_body')) return 'pr_body';
    if (allowed.includes('status_check')) return 'status_check';
  }
  for (const source of ['manual_observation', 'automated_observation', 'pr_body']) {
    if (allowed.includes(source)) return source;
  }
  return allowed[0] ?? null;
}

export function renderPrBodyScaffold(input) {
  const pr = input.prData ?? {};
  const issue = input.issueData ?? {};
  const checks = input.requiredChecks ?? [];
  const events = input.reviewHistory?.events ?? [];
  const prior = [...events].reverse().find(event => event.type === 'outcome' && event.status === 'needs_revision');
  const lifecycle = input.reviewHistory?.findingLifecycle ?? {};
  const changed = (pr.files ?? []).map(file => typeof file === 'string' ? file : file?.path).filter(Boolean);
  const head = String(pr.headRefOid ?? '').toLowerCase();
  const taskId = resolveGitHubTaskIdentity(issue)?.taskId ?? null;
  const scope = parseScopePatterns(issue.body);
  const generated = parseTaskReadinessDeclaration(issue.body).declaration?.generated ?? new Map();
  const deviationSuggestions = scope?.patterns
    ? changed.filter(path => !generated.has(path) && !isFileInScope(path, scope.patterns))
    : [];
  const lines = [
    '## Scope Completed',
    'REPLACE: concise final-state implementation summary.', '',
    '## Artifacts',
    `Current implementation artifact: commit:${head}`, '',
    '## Evidence',
    `Current PR head: ${head}`, '',
  ];
  for (const check of checks) {
    const source = scaffoldSource(check);
    if (source === 'status_check') {
      // Canonical substitution: an exact matching successful status check
      // satisfies this command check without a PR-body evidence entry.
      continue;
    }
    lines.push(`- Required check: ${check.text}`);
    lines.push(`  Kind: ${check.kind ?? (check.command ? 'command' : 'manual')}`);
    lines.push(`  Source: ${source ?? 'pr_body'}`);
    if ((check.kind === 'manual' || check.kind === 'contract_proof') && check.kindDeclared) lines.push(`  Implementation head: ${head}`);
    lines.push('  Verdict: not run');
    lines.push('  Evidence: REPLACE: final-state result, excerpt, or complete observation record.');
    for (const observation of check.observations ?? []) {
      lines.push(`  Observation: ${observation}`);
      lines.push(`  Level: ${check.observationLevels?.[observation] ?? 'running_path'}`);
      lines.push(`  Result: REPLACE: concrete result or bounded excerpt for '${observation}'.`);
      lines.push(`  Artifact: ${head}`);
      lines.push(`  Source: ${source ?? 'pr_body'}`);
    }
  }
  lines.push('', '## Changed Paths');
  lines.push(...(changed.length ? changed.map(path => `- \`${path}\``) : ['- None reported by the PR file inventory.']));
  if (deviationSuggestions.length) {
    lines.push('', '## Deviations');
    for (const path of deviationSuggestions) {
      lines.push(`- \`${path}\`: REPLACE: reason this changed path is outside the declared allowed_paths.`);
    }
  } else {
    lines.push('', '## Deviations', 'None.');
  }
  lines.push('', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.');
  if (generated.size) {
    lines.push('', '## Generated Outputs');
    for (const [path, meta] of generated) {
      lines.push(`- \`${path}\`: generator ${meta.generator}; source ${meta.source}; verification ${meta.verification}`);
    }
  }
  if (prior?.findingIds?.length) {
    const entries = prior.findingIds.map(findingId => ({
      findingId,
      disposition: 'resolved',
      evidence: 'REPLACE: substantive description of the current-artifact repair.',
      reference: `commit:${head}`,
      backend: 'github',
    }));
    lines.push('', formatResolutionMatrix(entries).trim());
    // Preserve a blank line before the Prior Review History section.
    lines.push('', '## Prior Review History', `- Active finding IDs: ${prior.findingIds.join(', ')}`, `- Retired finding IDs: ${(lifecycle.retiredFindingIds ?? []).join(', ') || 'none'}`, `- Next finding ID: ${lifecycle.nextFindingId ?? 'F-1'}`);
  }
  if (input.projectFacts?.length) {
    lines.push('', '## Verification Operating Facts', ...input.projectFacts.map(fact => `- ${fact.id}: ${fact.command}`));
  }
  if (taskId) {
    lines.push('', '## Commit Attribution', `- Expected head commit trailers: \`Task: ${taskId}\` and \`Agent: engineer\`.`);
  }
  if (issue.number) lines.push('', `Closes #${issue.number}`);
  lines.push('', '[[agent: engineer]]', '');
  return lines.join('\n');
}

function diagnostic(message, code = 'pr_body.structural', repairHint = null) {
  return createDiagnostic({ code, message, ...(repairHint ? { repairHint } : {}) });
}

/**
 * Structural lint of a scaffolded (or hand-edited) PR body. This is not a
 * placeholder grep: it validates every required section, the exact current-head
 * marker and implementation artifact, a nonempty scope summary, every required
 * check with an allowed kind/source and a final verdict, substantive and
 * structured observation evidence, current resolution entries, the
 * deviations/gaps/follow-ups shape, and the final Engineer attribution. It
 * never edits GitHub and performs no network access.
 *
 * @param {string} body
 * @param {{ requiredChecks?: object[], currentHead?: string, statusChecks?: object[],
 *           priorFindingIds?: string[] }} [context] Optional evaluation context
 *   so required checks, the current head, and prior findings are checked
 *   mechanically rather than by prose.
 * `scaffolded` records canonical scaffold shape/provenance and is independent
 * of readiness. `lintReady` is the structural readiness verdict; command
 * callers combine it with their semantic gate result to derive publication
 * readiness.
 *
 * @returns {{ schemaVersion: number, ok: boolean, scaffolded: boolean, lintReady: boolean, errors: string[], warnings: string[], diagnostics: Array<object> }}
 */
export function lintPrBody(body, context = {}) {
  const errors = [];
  const warnings = [];
  const text = String(body ?? '');
  const liveLines = markdownLines(text);
  let hasPlaceholder = false;
  for (const line of liveLines) {
    if (!line.live) continue;
    if (PLACEHOLDER_RE.test(line.raw)) {
      hasPlaceholder = true;
      const section = [...liveLines.slice(0, liveLines.indexOf(line))].reverse().find(candidate => candidate.raw.match(/^##\s+/));
      const where = section ? ` in section '${section.raw.replace(/^##\s+/, '').trim().toLowerCase()}'` : '';
      errors.push(diagnostic(`canonical placeholder remains${where}: ${line.raw.trim()}`));
    }
  }
  if (text.trim().length === 0) {
    errors.push(diagnostic('PR body is empty; scaffold required fields are absent'));
  }

  for (const heading of REQUIRED_SECTIONS) {
    if (!markdownSection(text, heading)) {
      errors.push(diagnostic(`PR body is missing the '${heading}' section`));
    }
  }
  const scopeBody = markdownSection(text, '## Scope Completed')?.body ?? null;
  if (scopeBody !== null && !scopeBody.trim()) {
    errors.push(diagnostic("PR body '## Scope Completed' section must contain a nonempty scope summary"));
  }

  const currentHead = String(context.currentHead ?? '').toLowerCase() || null;
  const marker = extractHeadMarker(text);
  if (currentHead) {
    if (!marker || !headMatches(marker, currentHead)) {
      errors.push(diagnostic(`PR body must carry the exact current-head marker 'Current PR head: ${currentHead}'`, 'pr_body.structural', 're-scaffold against the current head before publication'));
    }
    if (!text.includes(`Current implementation artifact: commit:${currentHead}`)) {
      errors.push(diagnostic(`PR body must record the exact implementation artifact 'Current implementation artifact: commit:${currentHead}'`));
    }
  } else if (!marker) {
    errors.push(diagnostic("PR body is missing a 'Current PR head: <sha>' marker"));
  }

  const evidence = parsePrEvidence(text);
  for (const parseError of evidence.errors) {
    errors.push(diagnostic(parseError));
  }
  for (const entry of evidence.entries) {
    const finality = validateEvidenceEntryFinality(entry);
    const label = String(entry.check ?? '').trim() || '<unnamed evidence entry>';
    for (const error of finality.errors) {
      errors.push(diagnostic(`evidence entry '${label}' is incomplete: ${error}`));
    }
    warnings.push(...finality.warnings);
  }
  const requiredChecks = context.requiredChecks ?? [];
  if (requiredChecks.length > 0) {
    const comparison = compareRequiredChecksToEvidence(
      requiredChecks,
      evidence.entries,
      context.statusChecks ?? [],
      { currentArtifact: currentHead, finalityValidated: true },
    );
    for (const item of comparison.missing) {
      const taskContractFailure = item.category === 'task_policy';
      errors.push(diagnostic(
        taskContractFailure
          ? `required-check contract '${item.check}' is invalid: ${item.reason}`
          : `required check '${item.check}' has no acceptable evidence: ${item.reason}`,
        taskContractFailure ? 'preflight.task_policy' : 'pr_body.structural',
      ));
    }
  }

  for (const deviationError of parseDeviations(text).errors) {
    errors.push(diagnostic(deviationError));
  }

  const priorFindingIds = context.priorFindingIds ?? [];
  if (priorFindingIds.length > 0) {
    const matrix = parseResolutionMatrix(text);
    if (matrix.status !== 'parsed') {
      errors.push(diagnostic(`re-review requires a resolution matrix for finding IDs: ${priorFindingIds.join(', ')}`));
    } else {
      const validation = validateResolutionMatrix({
        requiredFindingIds: priorFindingIds,
        entries: matrix.entries,
        currentArtifact: currentHead ?? '',
      });
      for (const error of validation.errors) errors.push(diagnostic(error));
      warnings.push(...validation.warnings);
    }
  }

  const finalLine = liveLines.filter(line => line.live && line.raw.trim()).at(-1)?.raw.trim() ?? '';
  if (finalLine !== '[[agent: engineer]]') {
    errors.push(diagnostic("PR body must end with the final Engineer attribution '[[agent: engineer]]'"));
  }

  // `scaffolded` records canonical scaffold shape/provenance, not
  // incompleteness or publication readiness. It is derived from a canonical
  // placeholder or the scaffold's distinctive `## Changed Paths` section;
  // callers use `lintReady` plus the semantic gate for readiness.
  const scaffolded = hasPlaceholder || Boolean(markdownSection(text, '## Changed Paths'));
  const lintReady = errors.length === 0;
  return {
    schemaVersion: 1,
    ok: lintReady,
    scaffolded,
    lintReady,
    errors: errors.map(item => item.message),
    warnings,
    diagnostics: errors,
  };
}
