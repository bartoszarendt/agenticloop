/**
 * Validate agenticloop configuration in a target directory.
 *
 * Files-first: .agenticloop/project.md is validated when present.
 * agenticloop.json is validated only when present.
 * Missing agenticloop.json is not an error for a files-first project.
 * The toolkit source repository itself is valid without downstream target
 * config and should not emit target-setup warnings in that mode.
 *
 * Core checks (run when agenticloop.json is present):
 *   - agenticloop.json parses as valid JSON
 *   - configured source directories exist (agents, skills, backends)
 *   - required mapped documents exist
 *   - roles.*.sourceFile exists and is under agents/
 *   - roles.*.requiredSkills exist in skills/
 *   - backend projection files exist for the resolved active backend
 *   - tmp/ exists (warning if missing); tmp/ is in .gitignore (warning if not)
 *   - .agenticloop/tasks/*.md task records reject placeholder text
 *   - files-backed task files validate frontmatter, status, review_status,
 *     and accepted/closed implementation evidence
 *
 * Project map checks (run when .agenticloop/project.md is present):
 *   - task_backend, task_id_regex, task_file_template valid
 *   - override doc paths exist if configured
 *
 * Adapter checks (run only when the adapter output is present, or when
 *   the adapter is marked enabled/required via adapters.<host>.enabled,
 *   or when the user passes the corresponding --adapter flag at the CLI):
 *   - OpenCode: .opencode/agents/*.md frontmatter/prompt shape and
 *               .opencode/commands/agenticloop.md activation binding
 *   - Codex:    .codex/agents/*.toml shape, repo-local .agents/skills/
 *               activation, and optional plugins/agenticloop/.codex-plugin/
 *   - Claude Code: .claude/commands/agenticloop.md, .claude/agents/*.md shape,
 *                  .claude/skills/agenticloop/ shape
 *   - Copilot: .github/agents/*.agent.md, .github/skills/agenticloop/, and
 *              .github/prompts/agenticloop.prompt.md shape
 *   - Cursor: .cursor/agents/*.md, .cursor/skills/agenticloop/, and optional
 *             generated plugins/agenticloop/.cursor-plugin/ packaging
 *
 * Validation must NOT require a root opencode.jsonc just because
 * adapters.opencode is configured. Host presence is decided by .opencode/
 * file existence or an explicit enabled flag.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import {
  generateOpencodeAgentRecords,
  OPENCODE_COMMAND_RELATIVE_PATH,
  OPENCODE_ROLE_NAMES,
  normalizeSkillsSourceDir,
  resolveOpencodeAgentPath,
  resolveOpencodeCommandPath,
  rewriteOpencodeSkillReferences,
} from './adapters/opencode.js';
import {
  COPILOT_PUBLIC_SKILL_NAME,
  COPILOT_REQUIRED_PUBLIC_REFERENCES,
  generatedCopilotArtifactsPresent,
  resolveCopilotAgentPath,
  resolveCopilotPromptPath,
} from './adapters/copilot.js';
import {
  CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH,
  CURSOR_PUBLIC_SKILL_NAME,
  CURSOR_REQUIRED_PUBLIC_REFERENCES,
  generatedCursorArtifactsPresent,
  resolveCursorAgentPath,
} from './adapters/cursor.js';
import {
  AGENTIC_LOOP_OPERATION_DESCRIPTION,
  buildRoleRecord,
  resolveRoleModel,
} from './adapters/shared.js';
import { getDocumentRoleRegistry } from './document-roles.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  AGENTS_SOURCE_DIRECTORY,
  BACKENDS_SOURCE_DIRECTORY,
  LEGACY_SCRATCH_GITIGNORE_PATTERNS,
  PROCESS_DOC_RELATIVE_PATH,
  SCRATCH_DIRECTORY_RELATIVE_PATH,
  SCRATCH_GITIGNORE_PATTERNS,
  SKILLS_SOURCE_DIRECTORY,
  TASK_REQUIRED_SECTION_HEADINGS,
  WORK_UNIT_SUMMARY_SECTION_HEADINGS,
  isPackageSourceRepositoryRoot,
  resolveToolkitAssetLayout,
} from './layout.js';
import { validateLayoutState } from './layout-migration.js';
import { validateCanonicalTemplates } from './template-contract.js';
import {
  isValidTaskId,
  loadProjectMap,
  PROJECT_MAP_DEFAULTS,
  validateProjectMap,
} from './project-map.js';
import {
  DEFAULT_TASK_LABEL_TEMPLATE,
  DEFAULT_TITLE_PREFIX_REGEX,
  extractTaskIdFromLabel,
  extractTaskIdFromTitle,
  resolveGithubLabelNames,
} from './github-backend.js';
import {
  getTaskBackendProjection,
  isValidTaskBackend,
  resolveTaskBackend,
} from './task-backend.js';
import {
  CODEX_SUPPORTED_REASONING_EFFORTS,
  CODEX_SUPPORTED_REASONING_EFFORTS_DISPLAY,
  isLegacyCodexCliModel,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
} from './codex-models.js';
import { validateReviewProvenance } from './review-provenance.js';

const PLACEHOLDER_PATTERNS = [
  /\bTBD\b/i,
  /\bas needed\b/i,
  /\betc\./i,
  /\bsimilar to previous task\b/i,
  /\bto be filled\b/i,
  /\bto be filled during review\b/i,
];

export const FILES_TASK_STATUSES = new Set([
  'draft',
  'agent-ready',
  'in-progress',
  'needs_context',
  'blocked',
  'needs_revision',
  'accepted',
  'closed',
]);

const REVIEW_STATUSES = new Set(['accepted', 'needs_revision']);

// Known configuration keys under roles.<role>. Unknown keys are warn-only for
// now (loading stays permissive) and may become errors in a future major
// version. Legacy model/reasoning fields (model, reasoningEffort, variant) and
// the compatibility settings stay supported. The removed fields
// (responsibilities, canEditDocs, canEditImplementationFiles) are intentionally
// absent, so reintroducing them surfaces an unknown-key warning.
const KNOWN_ROLE_KEYS = new Set([
  'sourceFile',
  'description',
  'requiredSkills',
  'model',
  'reasoningEffort',
  'variant',
]);

const CODEX_PUBLIC_SKILL_NAME = 'agenticloop';
const CODEX_LEGACY_SKILL_PREFIX = 'agenticloop-';
const CODEX_LEGACY_START_SKILL_NAME = 'agenticloop-start';
const CODEX_REQUIRED_REFERENCE_SKILLS = [
  'role-delegation',
  'task-record-contract',
  'setup-agenticloop',
  'blocked-state',
];
const CODEX_REQUIRED_BACKEND_REFERENCES = ['files.md', 'github.md'];
const CLAUDE_PUBLIC_SKILL_NAME = 'agenticloop';
const CLAUDE_REQUIRED_REFERENCE_SKILLS = [
  'role-delegation',
  'task-record-contract',
  'setup-agenticloop',
  'blocked-state',
];
const COPILOT_REQUIRED_BACKEND_REFERENCES = ['README.md', 'files.md', 'github.md'];
const CURSOR_REQUIRED_BACKEND_REFERENCES = ['README.md', 'files.md', 'github.md'];
const CODEX_DANGLING_BACKEND_PATTERN = /(?<!references\/)backends\/(files|github)\.md/;
const CODEX_FORBIDDEN_EVENT_LOGGING_PATTERNS = [
  {
    pattern: /`npx agenticloop`\s+when no command is\s+configured/,
    description: 'legacy npx event logging fallback',
  },
];

export function sectionBody(content, heading) {
  const headingLevel = (heading.trim().match(/^(#{1,6})/) ?? [])[1]?.length ?? 2;
  const breakRe = new RegExp(`^#{1,${headingLevel}}\\s`);
  const lines = content.split('\n');
  let inSection = false;
  const bodyLines = [];
  for (const line of lines) {
    if (line.trim() === heading.trim()) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (breakRe.test(line)) break;
      bodyLines.push(line);
    }
  }
  return bodyLines.join('\n').trim();
}

function normalizePath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').trim() : '';
}

function frontmatterString(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return '';
  }
  return '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseYamlScalarString(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function rawFrontmatterBlock(content) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

function splitInlineArray(text) {
  const values = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const c of text) {
    if (escape) {
      current += c;
      escape = false;
      continue;
    }
    if (c === '\\') {
      current += c;
      escape = true;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      current += c;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
      continue;
    }
    if (c === ',' && !inSingle && !inDouble) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }

  const trimmed = current.trim();
  if (trimmed) values.push(trimmed);
  return values.map(parseYamlScalarString);
}

function readYamlField(frontmatterText, fieldName) {
  const lines = frontmatterText.split(/\r?\n/);
  const fieldHeader = new RegExp(`^${escapeRegExp(fieldName)}:\\s*(.*)$`);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(fieldHeader);
    if (!match) continue;

    const rest = match[1].trim();

    if (rest.startsWith('[')) {
      let buffer = rest;
      let j = i;
      while (!buffer.includes(']') && j < lines.length - 1) {
        j++;
        buffer += '\n' + lines[j];
      }
      const closeIdx = buffer.indexOf(']');
      if (closeIdx === -1) {
        return { found: true, value: buffer.trim() };
      }
      return { found: true, value: splitInlineArray(buffer.slice(1, closeIdx)) };
    }

    if (rest !== '') {
      return { found: true, value: parseYamlScalarString(rest) };
    }

    const values = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (/^\S/.test(line)) break;
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
      if (!itemMatch) break;
      values.push(parseYamlScalarString(itemMatch[1]));
    }
    return { found: true, value: values };
  }

  return { found: false, value: null };
}

function readYamlListField(frontmatterText, fieldName) {
  const { found, value } = readYamlField(frontmatterText, fieldName);
  if (!found) return null;
  if (Array.isArray(value)) return value;
  return null;
}

// Broad detection of an agent-claimed PR or merge action inside a files-backed
// task record. Verb stems cover opened/created/raised/submitted/published/pushed
// a PR or pull request, and merged a PR/pull request/branch.
const PR_MERGE_ACTION_PATTERNS = [
  /\b(?:open|creat|rais|submit|publish|push)\w*\b[^.!?\n]*\b(?:pull requests?|prs?)\b/i,
  /\bmerg\w*\b[^.!?\n]*\b(?:pull requests?|prs?|branch\w*)\b/i,
];

const HUMAN_PR_MERGE_ACTION_PATTERNS = [
  /\b(?:human|user|maintainer|owner)\b[^.!?\n]*(?:open|creat|rais|submit|publish|push)\w*\b[^.!?\n]*\b(?:pull requests?|prs?)\b/i,
  /\b(?:human|user|maintainer|owner)\b[^.!?\n]*\bmerg\w*\b[^.!?\n]*\b(?:pull requests?|prs?|branch\w*)\b/i,
  /\bmanual(?:ly)?\b[^.!?\n]*(?:open|creat|rais|submit|publish|push)\w*\b[^.!?\n]*\b(?:pull requests?|prs?)\b/i,
  /\bmanual(?:ly)?\b[^.!?\n]*\bmerg\w*\b[^.!?\n]*\b(?:pull requests?|prs?|branch\w*)\b/i,
  /\b(?:pull requests?|prs?|branch\w*)\b[^.!?\n]*(?:open|creat|rais|submit|publish|push|merg)\w*\b[^.!?\n]*\bby (?:a )?(?:human|user|maintainer|owner)\b/i,
];

function sentenceClaimsPrOrMerge(sentence) {
  return PR_MERGE_ACTION_PATTERNS.some(pattern => pattern.test(sentence));
}

// A human/manual exception only licenses the PR/merge claim in its own sentence,
// so a stray 'human decision' elsewhere in the file cannot suppress the guard.
function sentenceHasHumanOrManualException(sentence) {
  return HUMAN_PR_MERGE_ACTION_PATTERNS.some(pattern => pattern.test(sentence)) &&
    /\b(?:outside (?:Agentic Loop|the loop|normal[^.!?\n]*automation)|human|user|maintainer|owner|manual(?:ly)?)\b/i.test(sentence);
}

function claimsUnauthorizedPrOrMerge(content) {
  // Split on sentence terminators and line breaks so the human/manual exception
  // check is localized to the same sentence as the PR/merge claim.
  const sentences = content.split(/(?<=[.!?])\s+|\r?\n+/);
  return sentences.some(
    sentence => sentenceClaimsPrOrMerge(sentence) && !sentenceHasHumanOrManualException(sentence)
  );
}

function hasRecordedImplementationArtifact(content, implementationArtifact) {
  if (implementationArtifact) return true;
  return /^implementation[ _-]artifact[^\S\r\n]*:[^\S\r\n]*\S.*$/im.test(content);
}

function validateWorkUnitSummarySkeleton(content, filename) {
  const errors = [];
  for (const heading of WORK_UNIT_SUMMARY_SECTION_HEADINGS) {
    if (!content.includes(heading)) {
      errors.push(`Task record '${filename}' missing work-unit summary section '${heading}'`);
    }
  }
  if (content.includes('## Scope Completed') && !sectionBody(content, '## Scope Completed')) {
    errors.push(`Task record '${filename}' has empty work-unit summary section '## Scope Completed'`);
  }
  return errors;
}

export function validateTaskRecord(content, filename) {
  const errors = [];

  for (const section of TASK_REQUIRED_SECTION_HEADINGS) {
    if (!content.includes(section)) {
      errors.push(`Task record '${filename}' missing required section '${section}'`);
    }
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(
        `Task record '${filename}' contains placeholder text matching '${pattern.source}'`
      );
    }
  }

  const summaryBody = sectionBody(content, '## Completion Summary Template');
  if (!summaryBody) {
    errors.push(`Task record '${filename}' has empty '## Completion Summary Template' section`);
  }

  const checklistBody = sectionBody(content, '## Reviewer Checklist');
  if (!checklistBody) {
    errors.push(`Task record '${filename}' has empty '## Reviewer Checklist' section`);
  }

  if (content.includes('## Proof Pressure') && !sectionBody(content, '## Proof Pressure')) {
    errors.push(`Task record '${filename}' has empty '## Proof Pressure' section`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Structured scope-map / changed-file validation
// ---------------------------------------------------------------------------

const SCOPE_MAP_FIELD_NAMES = ['allowed_paths', 'expected_files'];

function isSafeScopePattern(pattern) {
  if (typeof pattern !== 'string') return false;
  const normalized = normalizePath(pattern);
  if (!normalized) return false;
  if (normalized.startsWith('/')) return false;
  if (normalized.includes('..')) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  return true;
}

function readStructuredScopePatterns(frontmatterText, filename, errors) {
  let fieldName = SCOPE_MAP_FIELD_NAMES[0];
  let result = readYamlField(frontmatterText, fieldName);
  if (!result.found) {
    fieldName = SCOPE_MAP_FIELD_NAMES[1];
    result = readYamlField(frontmatterText, fieldName);
  }
  if (!result.found) {
    return null;
  }

  if (!Array.isArray(result.value)) {
    errors.push(
      `Task record '${filename}' structured scope field '${fieldName}' must be a YAML list`
    );
    return null;
  }

  const patterns = [];
  for (const rawPattern of result.value) {
    if (!isSafeScopePattern(rawPattern)) {
      errors.push(
        `Task record '${filename}' structured scope field '${fieldName}' contains unsafe or malformed pattern: ${JSON.stringify(rawPattern)}`
      );
      continue;
    }
    patterns.push(normalizePath(rawPattern));
  }

  return { fieldName, patterns };
}

function globPatternToRegExp(pattern) {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const next = pattern[i + 1];
    if (c === '*' && next === '*') {
      regex += '.*';
      i++;
    } else if (c === '*') {
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

function fileMatchesScopePattern(file, pattern) {
  if (pattern.endsWith('/')) {
    return file.startsWith(pattern) || file === pattern.slice(0, -1);
  }
  return globPatternToRegExp(pattern).test(file);
}

function isFileInScope(file, patterns) {
  return patterns.some(pattern => fileMatchesScopePattern(file, pattern));
}

function collectChangedFiles(repoRoot, commandRunner) {
  const result = runCommand(commandRunner, repoRoot, 'git', [
    'status',
    '--short',
    '--untracked-files=all',
  ]);

  if (result.status !== 0) {
    return {
      files: [],
      error: commandMessage(result) || 'git status failed',
    };
  }

  const files = [];
  const seen = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Short format: XY path or XY origin -> destination (renamed/copied)
    const match = line.match(/^.. (.+?)(?: -> (.+))?$/);
    if (!match) continue;
    const left = normalizePath(match[1]);
    const right = match[2] ? normalizePath(match[2]) : null;

    for (const file of [left, right].filter(Boolean)) {
      if (seen.has(file)) continue;
      seen.add(file);
      // Do not scan .agenticloop/tmp/ contents as changed-file evidence.
      if (file.startsWith('.agenticloop/tmp/')) continue;
      files.push(file);
    }
  }

  return { files, error: null };
}

function validateChangedFilesAgainstScope(repoRoot, commandRunner, filename, scope, warnings) {
  const { files, error } = collectChangedFiles(repoRoot, commandRunner);
  if (error) {
    warnings.push(
      `Task record '${filename}' has structured scope field '${scope.fieldName}' but changed-file validation was skipped because git status could not be read: ${error}`
    );
    return;
  }

  const outOfScope = files.filter(file => !isFileInScope(file, scope.patterns));
  if (outOfScope.length > 0) {
    const examples = uniqueExamples(outOfScope, 3).join(', ');
    warnings.push(
      `Task record '${filename}' structured scope field '${scope.fieldName}' does not cover changed file(s): ${examples}. ` +
      `Reviewers still enforce unexpected files via '## Deviations'.`
    );
  }
}

export function validateFilesTaskRecord(content, filename, options = {}) {
  const errors = [];
  const warnings = options.warnings ?? [];
  const [frontmatter] = parseFrontmatter(content);
  const activeTaskBackend = options.activeTaskBackend ?? 'files';
  const projectMapConfig = options.projectMapConfig ?? PROJECT_MAP_DEFAULTS;
  const declaredBackend = frontmatterString(frontmatter?.backend);
  const authoritative = activeTaskBackend === 'files' || declaredBackend === 'files';

  if (!authoritative) {
    return errors;
  }

  if (frontmatter === null) {
    errors.push(`Task record '${filename}' missing YAML frontmatter required for files-backed task records`);
    return errors;
  }

  const taskId = frontmatterString(frontmatter.task_id);
  const status = frontmatterString(frontmatter.status);
  const implementationArtifact = frontmatterString(frontmatter.implementation_artifact);
  const reviewStatus = frontmatterString(frontmatter.review_status);
  const reviewMode = frontmatterString(frontmatter.review_mode);
  const reviewedArtifact = frontmatterString(frontmatter.reviewed_artifact);
  const independentRaw = frontmatterString(frontmatter.independent_review_required);
  const humanReviewRef = frontmatterString(frontmatter.human_review_ref);
  const blockCategory = frontmatterString(frontmatter.block_category);
  const expectedBackend = 'files';

  if (!taskId) {
    errors.push(`Task record '${filename}' missing required frontmatter field 'task_id'`);
  }

  if (!status) {
    errors.push(`Task record '${filename}' missing required frontmatter field 'status'`);
  }

  if (!declaredBackend) {
    errors.push(`Task record '${filename}' missing required frontmatter field 'backend'`);
  } else if (declaredBackend !== expectedBackend) {
    errors.push(
      `Task record '${filename}' backend must be '${expectedBackend}' when the local task file is authoritative, got: ${JSON.stringify(declaredBackend)}`
    );
  }

  if (taskId && !isValidTaskId(taskId, projectMapConfig.task_id_regex ?? PROJECT_MAP_DEFAULTS.task_id_regex)) {
    errors.push(
      `Task record '${filename}' task_id '${taskId}' does not match project.md task_id_regex '${projectMapConfig.task_id_regex ?? PROJECT_MAP_DEFAULTS.task_id_regex}'`
    );
  }

  const activeTemplate = normalizePath(projectMapConfig.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template);
  const defaultTemplate = normalizePath(PROJECT_MAP_DEFAULTS.task_file_template);
  if (taskId && activeTemplate === defaultTemplate) {
    const expectedFilename = `${taskId}.md`;
    if (basename(filename) !== expectedFilename) {
      errors.push(
        `Task record '${filename}' filename must match task_id '${taskId}' when using default task_file_template '${PROJECT_MAP_DEFAULTS.task_file_template}'`
      );
    }
  }

  if (activeTaskBackend !== expectedBackend && declaredBackend === expectedBackend) {
    errors.push(
      `Task record '${filename}' declares backend 'files' but active task_backend is '${activeTaskBackend}'`
    );
  }

  if (status && !FILES_TASK_STATUSES.has(status)) {
    errors.push(
      `Task record '${filename}' has invalid status '${status}' (expected one of: ${[...FILES_TASK_STATUSES].join(', ')})`
    );
  }

  if (reviewStatus && !REVIEW_STATUSES.has(reviewStatus)) {
    errors.push(
      `Task record '${filename}' has invalid review_status '${reviewStatus}' (expected one of: ${[...REVIEW_STATUSES].join(', ')})`
    );
  }

  errors.push(
    ...validateReviewProvenance({
      label: filename,
      status,
      reviewStatus,
      reviewModeRaw: reviewMode,
      implementationArtifact,
      reviewedArtifact,
      independentRaw,
      humanReviewRef,
    })
  );

  if (status === 'blocked' && !blockCategory) {
    errors.push(`Task record '${filename}' has status 'blocked' but is missing required frontmatter field 'block_category'`);
  }

  if (status === 'accepted' || status === 'closed') {
    const hasWorkUnitSummary = content.includes('## Scope Completed');
    const hasLegacyImplSummary = !!sectionBody(content, '## Implementation Summary');
    if (!hasWorkUnitSummary && !hasLegacyImplSummary) {
      errors.push(`Task record '${filename}' must include a non-empty '## Scope Completed' section (or legacy '## Implementation Summary') when status is '${status}'`);
    }
    if (hasWorkUnitSummary) {
      errors.push(...validateWorkUnitSummarySkeleton(content, filename));
    }
    if (!hasRecordedImplementationArtifact(content, implementationArtifact)) {
      errors.push(`Task record '${filename}' must record implementation_artifact in frontmatter or clearly in the task file when status is '${status}'`);
    }

    const hasChurnSignals =
      reviewStatus === 'needs_revision' ||
      !!sectionBody(content, '## Revision Log') ||
      !!blockCategory;
    if (hasChurnSignals && !sectionBody(content, '## Outcome')) {
      warnings.push(
        `Task record '${filename}' has status '${status}' with visible churn signals but an empty '## Outcome' section; verify whether Outcome is required at closeout`
      );
    }
  }

  if (activeTaskBackend === 'files' && claimsUnauthorizedPrOrMerge(content)) {
    errors.push(
      `Task record '${filename}' claims an agent opened, created, or merged a pull request or branch ` +
      `while active backend is 'files'; PR/merge behavior requires task_backend: github`
    );
  }

  const scope = readStructuredScopePatterns(rawFrontmatterBlock(content), filename, errors);
  if (scope && scope.patterns.length > 0 && options.repoRoot && options.commandRunner) {
    validateChangedFilesAgainstScope(
      options.repoRoot,
      options.commandRunner,
      filename,
      scope,
      warnings
    );
  }

  return errors;
}

function legacyCodexSkillDirectories(skillsRoot) {
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) return [];
  return readdirSync(skillsRoot).filter(entry => {
    if (!entry.startsWith(CODEX_LEGACY_SKILL_PREFIX)) return false;
    const skillPath = join(skillsRoot, entry, 'SKILL.md');
    return existsSync(skillPath);
  });
}

function parseTomlString(rawValue) {
  const raw = rawValue.trim();
  if (!raw) return '';
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
    }
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, raw.endsWith("'") ? -1 : undefined);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

function readTomlField(text, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = text.match(pattern);
  return match ? parseTomlString(match[1]) : '';
}

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

function runCommand(commandRunner, repoRoot, command, args) {
  const result = commandRunner(command, args, { cwd: repoRoot, encoding: 'utf-8' }) ?? {};
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function commandMessage(result) {
  return [result.stderr, result.stdout, result.error?.message]
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

function parseGitHubRepoSlug(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const patterns = [
    /^(?:https?:\/\/|ssh:\/\/git@)(?<host>[^/:]+)(?::\d+)?\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/i,
    /^git@(?<host>[^:]+):(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const host = match?.groups?.host?.toLowerCase() ?? '';
    const slug = match?.groups?.slug?.trim();
    if (host.includes('github') && slug) {
      return slug;
    }
  }

  return null;
}

function parseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueExamples(values, limit = 3) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function collectGithubBackendEvidence(repoRoot, config, commandRunner) {
  const githubConfig = config?.backends?.github ?? {};
  const requiredLabelNames = Object.values(resolveGithubLabelNames(config));
  const taskLabelTemplate = githubConfig.taskLabelTemplate ?? DEFAULT_TASK_LABEL_TEMPLATE;
  const titlePrefixRegex = githubConfig.titlePrefixRegex ?? DEFAULT_TITLE_PREFIX_REGEX;
  const originResult = runCommand(commandRunner, repoRoot, 'git', ['config', '--get', 'remote.origin.url']);
  const originUrl = originResult.status === 0 ? originResult.stdout.trim() : '';
  const repoSlug = parseGitHubRepoSlug(originUrl);
  const evidence = {
    originUrl,
    repoSlug,
    ghState: 'not-needed',
    authMessage: '',
    labelListError: '',
    issueListError: '',
    labelNames: [],
    presentRequiredLabels: [],
    missingRequiredLabels: [],
    taskLabelIds: [],
    issueTitleIds: [],
  };

  if (!repoSlug) {
    return evidence;
  }

  const ghVersion = runCommand(commandRunner, repoRoot, 'gh', ['--version']);
  if (ghVersion.error?.code === 'ENOENT') {
    evidence.ghState = 'missing';
    return evidence;
  }
  if (ghVersion.status !== 0) {
    evidence.ghState = 'unavailable';
    evidence.authMessage = commandMessage(ghVersion);
    return evidence;
  }

  const authStatus = runCommand(commandRunner, repoRoot, 'gh', ['auth', 'status']);
  if (authStatus.status !== 0) {
    evidence.ghState = 'unauthenticated';
    evidence.authMessage = commandMessage(authStatus);
    return evidence;
  }

  evidence.ghState = 'ready';

  const labelResult = runCommand(commandRunner, repoRoot, 'gh', [
    'label',
    'list',
    '--limit',
    '200',
    '--json',
    'name',
    '--repo',
    repoSlug,
  ]);
  if (labelResult.status === 0) {
    const parsed = parseJsonArray(labelResult.stdout);
    if (parsed) {
      evidence.labelNames = parsed
        .map(entry => typeof entry?.name === 'string' ? entry.name.trim() : '')
        .filter(Boolean);
      evidence.presentRequiredLabels = requiredLabelNames.filter(name => evidence.labelNames.includes(name));
      evidence.missingRequiredLabels = requiredLabelNames.filter(name => !evidence.labelNames.includes(name));
      evidence.taskLabelIds = uniqueExamples(
        evidence.labelNames
          .map(name => extractTaskIdFromLabel(name, taskLabelTemplate))
          .filter(Boolean),
        5
      );
    } else {
      evidence.labelListError = 'gh label list returned non-JSON output';
    }
  } else {
    evidence.labelListError = commandMessage(labelResult) || 'gh label list failed';
  }

  const issueResult = runCommand(commandRunner, repoRoot, 'gh', [
    'issue',
    'list',
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'title',
    '--repo',
    repoSlug,
  ]);
  if (issueResult.status === 0) {
    const parsed = parseJsonArray(issueResult.stdout);
    if (parsed) {
      evidence.issueTitleIds = uniqueExamples(
        parsed
          .map(entry => typeof entry?.title === 'string' ? extractTaskIdFromTitle(entry.title, titlePrefixRegex) : null)
          .filter(Boolean),
        5
      );
    } else {
      evidence.issueListError = 'gh issue list returned non-JSON output';
    }
  } else {
    evidence.issueListError = commandMessage(issueResult) || 'gh issue list failed';
  }

  return evidence;
}

function validateBackendEvidence(repoRoot, taskBackendResolution, projectMap, jsonConfig, commandRunner, errors, warnings) {
  const projectTaskBackend = taskBackendResolution.projectTaskBackend;
  const legacyJsonTaskBackend = taskBackendResolution.legacyJsonTaskBackend;
  const effectiveTaskBackend = taskBackendResolution.backend;
  const setupStatus = projectMap?.setup_status ?? 'unconfirmed';

  if (projectMap && legacyJsonTaskBackend !== null) {
    if (projectTaskBackend !== legacyJsonTaskBackend) {
      const mismatchMessage =
        `project.md task_backend ('${projectTaskBackend}') disagrees with legacy agenticloop.json ` +
        `taskBackend ('${legacyJsonTaskBackend}'). .agenticloop/project.md is the backend source ` +
        'of truth; remove or reconcile the legacy JSON key.';

      if (setupStatus === 'confirmed') errors.push(mismatchMessage);
      else warnings.push(mismatchMessage);
    } else {
      warnings.push(
        'agenticloop.json taskBackend is legacy; .agenticloop/project.md task_backend is the ' +
        'backend source of truth. Remove taskBackend from agenticloop.json.'
      );
    }
  } else if (!projectMap && legacyJsonTaskBackend !== null) {
    warnings.push(
      'agenticloop.json taskBackend is a legacy fallback because .agenticloop/project.md is ' +
      'missing. Create .agenticloop/project.md and move the backend choice to task_backend.'
    );
  }

  // GitHub label and issue evidence is gathered only for the GitHub backend. A
  // files-backed project must never invoke `gh` during validation, even when a
  // GitHub remote is configured and the CLI is authenticated. The legacy
  // taskBackend mismatch checks above are offline and are the only backend
  // evidence a files-backed project needs.
  if (effectiveTaskBackend !== 'github') {
    return;
  }

  const evidence = collectGithubBackendEvidence(repoRoot, jsonConfig, commandRunner);

  if (evidence.repoSlug) {
    if (evidence.ghState === 'missing' || evidence.ghState === 'unavailable') {
      warnings.push("Active task backend is 'github' but gh is unavailable, so required label checks were skipped.");
    } else if (evidence.ghState === 'unauthenticated') {
      const detail = evidence.authMessage ? ` ${evidence.authMessage}` : '';
      warnings.push(`Active task backend is 'github' but gh is not authenticated, so required label checks were skipped.${detail}`);
    } else if (evidence.labelListError) {
      warnings.push(`Active task backend is 'github' but GitHub labels could not be checked: ${evidence.labelListError}`);
    } else if (evidence.missingRequiredLabels.length > 0) {
      warnings.push(
        `Active task backend is 'github' but required GitHub labels are missing: ${evidence.missingRequiredLabels.join(', ')}. Run 'agenticloop bootstrap-labels'.`
      );
    }
  }

  if (projectMap?.task_id_regex) {
    try {
      new RegExp(projectMap.task_id_regex);
    } catch {
      return;
    }

    const observedTaskIds = uniqueExamples([
      ...evidence.taskLabelIds,
      ...evidence.issueTitleIds,
    ], 5);
    const rejectedTaskIds = observedTaskIds.filter(taskId => !isValidTaskId(taskId, projectMap.task_id_regex));
    if (rejectedTaskIds.length > 0) {
      warnings.push(
        `project.md task_id_regex ('${projectMap.task_id_regex}') rejects existing GitHub task identifiers: ${rejectedTaskIds.join(', ')}.`
      );
    }
  }
}

/**
 * Validate the Agentic Loop configuration in repoRoot.
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {string[]} [options.adapters]  Force validation of these adapters
 *                                        even when their output is absent.
 * @param {Function} [options.commandRunner] Optional command runner for git/gh checks.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateConfig(repoRoot, options = {}) {
  const errors = [];
  const warnings = [];
  const forced = new Set(options.adapters ?? []);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const assetLayout = resolveToolkitAssetLayout(repoRoot);
  const hasToolkitSource = assetLayout.kind !== 'absent';
  const toolkitSourceRepo = isPackageSourceRepositoryRoot(repoRoot);

  const layoutValidation = validateLayoutState(repoRoot);
  errors.push(...layoutValidation.errors);
  warnings.push(...layoutValidation.warnings);

  if (hasToolkitSource) {
    const templateValidation = validateCanonicalTemplates(repoRoot, assetLayout);
    errors.push(...templateValidation.errors);
    warnings.push(...templateValidation.warnings);
  }

  const cfgPath = join(repoRoot, 'agenticloop.json');
  const projectMapPath = join(repoRoot, '.agenticloop', 'project.md');
  const hasJsonc = existsSync(cfgPath);
  const hasProjectMap = existsSync(projectMapPath);
  let projectMapResult = null;
  let rawJsonConfig = null;
  let jsonConfig = null;

  // When neither config exists, produce a setup warning and run only
  // the backend-independent checks (tmp/, gitignore, task records).
  if (!hasJsonc && !hasProjectMap) {
    if (toolkitSourceRepo) {
      return { errors, warnings };
    }
    warnings.push(
      'No configuration found. Run agenticloop init to create .agenticloop/project.md.'
    );
    validateTmpAndGitignore(repoRoot, errors, warnings);
    validateNoDottedToolkitPaths(repoRoot, warnings);
    validateTaskRecords(repoRoot, '.agenticloop/tasks', errors, warnings, {
      activeTaskBackend: 'files',
      projectMapConfig: PROJECT_MAP_DEFAULTS,
      commandRunner,
    });
    return { errors, warnings };
  }

  // Validate project map when present.
  if (hasProjectMap) {
    projectMapResult = loadProjectMap(repoRoot);
    if (projectMapResult) {
      const pmResult = validateProjectMap(projectMapResult.config, projectMapResult.raw, repoRoot);
      errors.push(...pmResult.errors);
      warnings.push(...pmResult.warnings);
    }
  }

  // JSON-based validation (runs when agenticloop.json is present).
  if (hasJsonc) {
    try {
      rawJsonConfig = loadJsonFile(cfgPath);
      jsonConfig = loadAgenticLoopConfig(cfgPath);
    } catch (e) {
      return { errors: [`agenticloop.json parse error: ${e.message}`], warnings };
    }
    validateJsoncConfig(jsonConfig, rawJsonConfig, cfgPath, repoRoot, forced, errors, warnings);
  }

  const taskBackendResolution = resolveTaskBackend(repoRoot, {
    projectMapResult,
    rawJsonConfig,
  });
  warnings.push(...taskBackendResolution.warnings);
  validateResolvedTaskBackend(repoRoot, taskBackendResolution, jsonConfig, errors);
  validateBackendEvidence(
    repoRoot,
    taskBackendResolution,
    projectMapResult?.config ?? null,
    jsonConfig,
    commandRunner,
    errors,
    warnings
  );

  // Common checks that run regardless of config presence.
  validateTmpAndGitignore(repoRoot, errors, warnings);
  validateNoDottedToolkitPaths(repoRoot, warnings);

  // Task records: use project.md override when present, else fall back to
  // agenticloop.json, then default.
  let taskDir = '.agenticloop/tasks';
  if (projectMapResult) {
    const pm = projectMapResult;
    // Extract directory part from task_file_template
    const tpl = pm?.config?.task_file_template ?? '.agenticloop/tasks/{taskId}.md';
    taskDir = tpl.replace(/\{taskId\}.*$/, '').replace(/\/$/, '') || '.agenticloop/tasks';
  } else if (jsonConfig) {
    taskDir = jsonConfig.backends?.files?.taskDirectory ?? '.agenticloop/tasks';
  }
  validateTaskRecords(repoRoot, taskDir, errors, warnings, {
    activeTaskBackend: taskBackendResolution.backend,
    projectMapConfig: projectMapResult?.config ?? PROJECT_MAP_DEFAULTS,
    commandRunner,
  });

  return { errors, warnings };
}

// Tokens that appear when a scratch path loses its separators. A Windows path
// such as 'C:\repo\.agenticloop\tmp\body.md' passed through a POSIX shell (where
// '\' is consumed as an escape) collapses into a single root-level entry like
// 'C:repo.agenticlooptmpbody.md'; the simpler '.agenticloop/tmp' typo collapses
// to '.agenticlooptmp'. Both contain one of these tokens.
const SCRATCH_COLLAPSED_TOKENS = ['agenticlooptmp', 'agenticloop-tmp'];

function validateTmpAndGitignore(repoRoot, errors, warnings) {
  let rootEntries = [];
  try {
    rootEntries = readdirSync(repoRoot);
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    const normalized = entry.toLowerCase();
    // The canonical state directory must never be flagged; it has no 'tmp' run-on.
    if (normalized === '.agenticloop') {
      continue;
    }
    if (SCRATCH_COLLAPSED_TOKENS.some(token => normalized.includes(token))) {
      warnings.push(
        `Root-level '${entry}' looks like a misnamed or backslash-collapsed scratch path; ` +
          `the canonical path is '${SCRATCH_DIRECTORY_RELATIVE_PATH}/'. Use relative, ` +
          `forward-slash scratch paths and never pass absolute Windows backslash paths through the shell.`
      );
    }
  }

  const scratchDir = join(repoRoot, SCRATCH_DIRECTORY_RELATIVE_PATH);
  const legacyScratchDir = join(repoRoot, 'tmp');
  if (!existsSync(scratchDir)) {
    if (existsSync(legacyScratchDir)) {
      warnings.push(
        `Legacy scratch directory 'tmp/' still exists without '${SCRATCH_DIRECTORY_RELATIVE_PATH}/'; migrate to the new layout scratch path.`
      );
    } else {
      warnings.push(`${SCRATCH_DIRECTORY_RELATIVE_PATH}/ does not exist; run 'agenticloop init' to create it`);
    }
  }

  const gitignorePath = join(repoRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const giContent = readFileSync(gitignorePath, 'utf-8');
    const giLines = giContent.split('\n').map(l => l.trim());
    const scratchGitignored = giLines.some(line => SCRATCH_GITIGNORE_PATTERNS.includes(line));
    const legacyScratchGitignored = giLines.some(line => LEGACY_SCRATCH_GITIGNORE_PATTERNS.includes(line));
    if (!scratchGitignored) {
      if (legacyScratchGitignored) {
        warnings.push(
          `${SCRATCH_DIRECTORY_RELATIVE_PATH}/ is not listed in .gitignore; add it even if legacy tmp/ is still ignored.`
        );
      } else {
        warnings.push(`${SCRATCH_DIRECTORY_RELATIVE_PATH}/ is not listed in .gitignore; run 'agenticloop init' to add it`);
      }
    }
  } else {
    warnings.push(`.gitignore not found; cannot verify ${SCRATCH_DIRECTORY_RELATIVE_PATH}/ is gitignored`);
  }
}

function validateTaskRecords(repoRoot, taskDirRel, errors, warnings, options = {}) {
  const taskDir = join(repoRoot, taskDirRel);
  if (existsSync(taskDir) && statSync(taskDir).isDirectory()) {
    for (const f of readdirSync(taskDir).filter(n => n.endsWith('.md'))) {
      const content = readFileSync(join(taskDir, f), 'utf-8');
      for (const err of validateTaskRecord(content, f)) {
        errors.push(err);
      }
      for (const err of validateFilesTaskRecord(content, f, {
        ...options,
        repoRoot,
        commandRunner: options.commandRunner,
        warnings,
      })) {
        errors.push(err);
      }
    }
  }
}

// Matches a dotted toolkit path with either a forward slash or a Windows-style
// backslash separator (e.g. '.agenticloop/agents' or '.agenticloop\\agents').
const DOTTED_TOOLKIT_PATH_PATTERN =
  /\.agenticloop[/\\](agents|skills|backends|AGENTIC_LOOP\.md)\b/;

function validateNoDottedToolkitPaths(repoRoot, warnings) {
  const stateDir = join(repoRoot, '.agenticloop');
  if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) return;

  const scanDirs = ['tasks'];
  const scanFiles = ['project.md'];

  for (const file of scanFiles) {
    const filePath = join(stateDir, file);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (DOTTED_TOOLKIT_PATH_PATTERN.test(content)) {
        warnings.push(
          `.agenticloop/${file} references a dotted toolkit path ` +
          `(e.g. .agenticloop/agents/ or .agenticloop/skills/); ` +
          `canonical toolkit assets live under agenticloop/ (no leading dot).`
        );
      }
    } catch { /* skip unreadable files */ }
  }

  for (const subDir of scanDirs) {
    const dirPath = join(stateDir, subDir);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue;
    for (const f of readdirSync(dirPath).filter(n => n.endsWith('.md'))) {
      try {
        const content = readFileSync(join(dirPath, f), 'utf-8');
        if (DOTTED_TOOLKIT_PATH_PATTERN.test(content)) {
          warnings.push(
            `.agenticloop/${subDir}/${f} references a dotted toolkit path ` +
            `(e.g. .agenticloop/agents/ or .agenticloop/skills/); ` +
            `canonical toolkit assets live under agenticloop/ (no leading dot).`
          );
        }
      } catch { /* skip unreadable files */ }
    }
  }
}

function validateResolvedTaskBackend(repoRoot, taskBackendResolution, config, errors) {
  const taskBackend = taskBackendResolution.backend;

  if (!isValidTaskBackend(taskBackend)) {
    if (taskBackendResolution.source === 'agenticloop.json') {
      errors.push(
        `Legacy agenticloop.json taskBackend must be 'github' or 'files', got: ${JSON.stringify(taskBackend)}`
      );
    }
    return;
  }

  const projection = getTaskBackendProjection(config, taskBackend);
  if (projection && !existsSync(join(repoRoot, projection))) {
    errors.push(`Backend projection not found for active task backend '${taskBackend}': ${projection}`);
  }
}

function validateJsoncConfig(config, rawConfig, cfgPath, repoRoot, forced, errors, warnings) {
  const rawAdapters = rawConfig?.adapters ?? {};
  // --- Source directories --------------------------------------------------
  const agentsSrcDir = config.agents?.sourceDirectory ?? AGENTS_SOURCE_DIRECTORY;
  const skillsSrcDir = config.skills?.sourceDirectory ?? SKILLS_SOURCE_DIRECTORY;
  const backendsSrcDir = config.backends?.sourceDirectory ?? BACKENDS_SOURCE_DIRECTORY;
  const agentsDir = join(repoRoot, agentsSrcDir);
  const skillsDir = join(repoRoot, skillsSrcDir);
  const backendsDir = join(repoRoot, backendsSrcDir);

  for (const [label, dir] of [['agents', agentsDir], ['skills', skillsDir], ['backends', backendsDir]]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      errors.push(`Source directory not found: ${label} -> ${dir}`);
    }
  }

  // --- Required documents --------------------------------------------------
  validateDocumentRoleRegistry(config, errors);

  const knownDocumentRoles = new Set(Object.keys(getDocumentRoleRegistry(config)));
  const selectedDocs = config.documents ?? {};
  for (const [key, docPath] of Object.entries(selectedDocs)) {
    if (!knownDocumentRoles.has(key)) {
      errors.push(`documents.${key} is not a known document role`);
      continue;
    }
    if (typeof docPath !== 'string') {
      errors.push(`documents.${key} must be a string path`);
      continue;
    }
    if (!docPath) continue; // intentionally omitted/remapped
    if (!existsSync(join(repoRoot, docPath))) {
      warnings.push(`Document role '${key}' not found at ${docPath}`);
    }
  }

  // --- Roles ---------------------------------------------------------------
  const roles = config.roles ?? {};
  for (const [roleName, roleCfg] of Object.entries(roles)) {
    const sourceFile = roleCfg.sourceFile;
    if (!sourceFile) {
      errors.push(`Role '${roleName}' missing sourceFile`);
    } else {
      const full = join(repoRoot, sourceFile);
      if (!existsSync(full)) {
        errors.push(`Role '${roleName}' sourceFile not found: ${sourceFile}`);
      }
      const normalised = sourceFile.replace(/\\/g, '/');
      if (!normalised.startsWith(`${agentsSrcDir.replace(/\\/g, '/')}/`)) {
        errors.push(`Role '${roleName}' sourceFile must be under ${agentsSrcDir}/: ${sourceFile}`);
      }
    }

    const requiredSkills = roleCfg.requiredSkills ?? [];
    for (const skill of requiredSkills) {
      if (!existsSync(join(skillsDir, skill))) {
        errors.push(`Role '${roleName}' requiredSkill '${skill}' not found in ${skillsSrcDir}/`);
      }
    }

    // Warn-only unknown-key check. Loading stays permissive.
    if (roleCfg && typeof roleCfg === 'object' && !Array.isArray(roleCfg)) {
      for (const key of Object.keys(roleCfg)) {
        if (!KNOWN_ROLE_KEYS.has(key)) {
          warnings.push(
            `roles.${roleName}.${key} is not a recognized role configuration key and is ignored. ` +
            `Unknown role keys are warn-only for now and may become errors in a future major version.`
          );
        }
      }
    }
  }

  const titlePrefixRegex = config.backends?.github?.titlePrefixRegex;
  if (titlePrefixRegex !== undefined) {
    if (typeof titlePrefixRegex !== 'string') {
      errors.push('backends.github.titlePrefixRegex must be a string when provided');
    } else {
      try {
        new RegExp(titlePrefixRegex);
      } catch {
        errors.push(`backends.github.titlePrefixRegex is not a valid regular expression: ${titlePrefixRegex}`);
      }
    }
  }

  // --- Host adapters -------------------------------------------------------
  const ocAdapter = config.adapters?.opencode ?? null;
  const ocExplicit = Object.prototype.hasOwnProperty.call(rawAdapters, 'opencode');
  const ocAgentsDir = join(repoRoot, '.opencode', 'agents');
  const ocCommandPath = join(repoRoot, OPENCODE_COMMAND_RELATIVE_PATH);
  const ocRequired = ocAdapter?.enabled === true || ocAdapter?.required === true;
  const ocPresent = existsSync(ocAgentsDir) || existsSync(ocCommandPath);
  if (ocPresent || ocRequired || forced.has('opencode')) {
    validateOpencodeAdapter(ocAdapter ?? {}, config, repoRoot, errors, warnings);
  } else if (ocExplicit && ocAdapter?.status === 'supported') {
    warnings.push(
      "adapters.opencode is configured but no .opencode/agents/ or .opencode/commands/agenticloop.md is present. Run 'agenticloop generate opencode' to produce the repo-local OpenCode adapter artifacts."
    );
  }

  const codexAdapter = config.adapters?.codex;
  if (codexAdapter) {
    const codexExplicit = Object.prototype.hasOwnProperty.call(rawAdapters, 'codex');
    const codexAgentsDir = join(repoRoot, '.codex', 'agents');
    const codexPublicSkill = join(repoRoot, '.agents', 'skills', CODEX_PUBLIC_SKILL_NAME, 'SKILL.md');
    const legacyCodexStartSkill = join(repoRoot, '.agents', 'skills', CODEX_LEGACY_START_SKILL_NAME, 'SKILL.md');
    const legacyCodexSkills = legacyCodexSkillDirectories(join(repoRoot, '.agents', 'skills'));
    const codexPlugin = join(repoRoot, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json');
    const legacyCodexPlugin = join(repoRoot, '.codex-plugin', 'plugin.json');
    const codexPresent =
      existsSync(codexAgentsDir) ||
      existsSync(codexPublicSkill) ||
      existsSync(legacyCodexStartSkill) ||
      legacyCodexSkills.length > 0 ||
      existsSync(codexPlugin) ||
      existsSync(legacyCodexPlugin);
    const codexRequired = codexAdapter.enabled === true || codexAdapter.required === true;
    if (codexPresent || codexRequired || forced.has('codex')) {
      validateCodexAdapter(config, repoRoot, errors, warnings);
    } else if (codexExplicit && codexAdapter.status === 'supported') {
      warnings.push(
        "adapters.codex is configured but no .codex/agents/ or .agents/skills/agenticloop/SKILL.md is present. Run 'agenticloop generate codex' to produce the repo-local Codex adapter artifacts."
      );
    }
  }

  const ccAdapter = config.adapters?.['claude-code'];
  if (ccAdapter) {
    const ccExplicit = Object.prototype.hasOwnProperty.call(rawAdapters, 'claude-code');
    const ccAgentsDir = join(repoRoot, '.claude', 'agents');
    const ccPresent = existsSync(ccAgentsDir);
    const ccRequired = ccAdapter.enabled === true || ccAdapter.required === true;
    if (ccPresent || ccRequired || forced.has('claude-code')) {
      validateClaudeCodeAdapter(config, repoRoot, errors, warnings);
    } else if (ccExplicit && ccAdapter.status === 'supported') {
      warnings.push(
        "adapters.claude-code is configured but no .claude/agents/ is present. Run 'agenticloop generate claude-code' to produce the repo-local Claude Code adapter output."
      );
    }
  }

  const copilotAdapter = config.adapters?.copilot;
  if (copilotAdapter) {
    const copilotExplicit = Object.prototype.hasOwnProperty.call(rawAdapters, 'copilot');
    const copilotPresent = generatedCopilotArtifactsPresent(repoRoot).length > 0;
    const copilotRequired = copilotAdapter.enabled === true || copilotAdapter.required === true;
    if (copilotPresent || copilotRequired || forced.has('copilot')) {
      validateCopilotAdapter(config, repoRoot, errors, warnings);
    } else if (copilotExplicit && copilotAdapter.status === 'supported') {
      warnings.push(
        "adapters.copilot is configured but no generated .github/agents/, .github/skills/agenticloop/SKILL.md, or .github/prompts/agenticloop.prompt.md is present. Run 'agenticloop generate copilot' to produce the repo-local Copilot adapter output."
      );
    }
  }

  const cursorAdapter = config.adapters?.cursor;
  if (cursorAdapter) {
    const cursorExplicit = Object.prototype.hasOwnProperty.call(rawAdapters, 'cursor');
    const cursorPresent = generatedCursorArtifactsPresent(repoRoot).length > 0;
    const cursorRequired = cursorAdapter.enabled === true || cursorAdapter.required === true;
    if (cursorPresent || cursorRequired || forced.has('cursor')) {
      validateCursorAdapter(config, repoRoot, errors, warnings);
    } else if (cursorExplicit && cursorAdapter.status === 'supported') {
      warnings.push(
        "adapters.cursor is configured but no generated .cursor/agents/ or .cursor/skills/agenticloop/SKILL.md is present. Run 'agenticloop generate cursor' to produce the repo-local Cursor adapter output."
      );
    }
  }

  // --- Role model resolution across all adapters ---------------------------
  validateRoleModelResolution(config, errors, warnings);
}

// ---------------------------------------------------------------------------
// OpenCode adapter validation
// ---------------------------------------------------------------------------

function validateRequiredSnippets(label, text, snippets, errors, description) {
  for (const snippet of snippets) {
    if (!text.includes(snippet)) {
      errors.push(`${label}: ${description}: ${snippet}`);
    }
  }
}

function validateOpencodeAdapter(_ocAdapter, config, repoRoot, errors, warnings) {
  const expectedAgents = generateOpencodeAgentRecords(config, repoRoot);

  for (const roleName of OPENCODE_ROLE_NAMES) {
    const expectedAgent = expectedAgents[roleName];
    validateOpencodeAgent(roleName, expectedAgent, config, repoRoot, errors, warnings);
  }

  validateOpencodeCommand(repoRoot, errors, warnings);

  const opencodePresent = existsSync(join(repoRoot, '.opencode', 'agents')) || existsSync(resolveOpencodeCommandPath(repoRoot));
  const codexSkillVisible = existsSync(join(repoRoot, '.agents', 'skills', CODEX_PUBLIC_SKILL_NAME, 'SKILL.md'));
  if (opencodePresent && codexSkillVisible) {
    warnings.push(
      "OpenCode and Codex adapter outputs are both present. OpenCode can discover '.agents/skills/agenticloop/SKILL.md'; prefer '/agenticloop' for Agentic Loop activation in OpenCode."
    );
  }
}

function validateOpencodeCommand(repoRoot, errors, warnings) {
  const commandPath = resolveOpencodeCommandPath(repoRoot);
  const displayPath = commandPath.replace(/\\/g, '/');

  if (!existsSync(commandPath)) {
    errors.push(
      `OpenCode command not found: ${displayPath}; run 'agenticloop generate opencode'`
    );
    return;
  }

  let commandText = '';
  try {
    commandText = readFileSync(commandPath, 'utf-8');
  } catch (e) {
    errors.push(`${displayPath} read error: ${e.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(commandText);
  if (frontmatter === null) {
    errors.push(`${displayPath}: command frontmatter is required`);
    return;
  }

  if (frontmatterString(frontmatter.agent) !== 'orchestrator') {
    errors.push(`${displayPath}: command frontmatter must set agent: orchestrator`);
  }

  if (frontmatterString(frontmatter.description) !== AGENTIC_LOOP_OPERATION_DESCRIPTION) {
    errors.push(`${displayPath}: command frontmatter description must match the canonical Agentic Loop operation description`);
  }

  if (frontmatterString(frontmatter.model)) {
    errors.push(`${displayPath}: command frontmatter must not hard-code model`);
  }

  const requiredSnippets = [
    '`.agenticloop/project.md`',
    `\`${PROCESS_DOC_RELATIVE_PATH}\``,
    'Create or refine the durable task record before any implementation.',
    '`$ARGUMENTS`',
  ];

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${displayPath}: command body is missing required activation text: ${snippet}`);
    }
  }

  if (!body.includes('Generated by Agentic Loop')) {
    warnings.push(`${displayPath}: missing generated-file banner; regenerate with 'agenticloop update --adapter opencode'`);
  }
}

function validateOpencodeAgent(roleName, expectedAgent, config, repoRoot, errors, warnings) {
  const agentPath = resolveOpencodeAgentPath(repoRoot, roleName);
  const displayPath = agentPath.replace(/\\/g, '/');

  if (!existsSync(agentPath)) {
    errors.push(`OpenCode agent not found: ${displayPath}; run 'agenticloop generate opencode'`);
    return;
  }

  let agentText = '';
  try {
    agentText = readFileSync(agentPath, 'utf-8');
  } catch (error) {
    errors.push(`${displayPath} read error: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(agentText);
  if (frontmatter === null) {
    errors.push(`${displayPath}: agent frontmatter is required`);
    return;
  }

  const expectedMode = roleName === 'orchestrator' ? 'primary' : 'subagent';
  if (frontmatterString(frontmatter.description) !== (expectedAgent?.description ?? '')) {
    errors.push(`${displayPath}: frontmatter description must match the canonical role description`);
  }
  if (frontmatterString(frontmatter.mode) !== expectedMode) {
    errors.push(`${displayPath}: role '${roleName}' must set mode: ${expectedMode}`);
  }

  const renderedModel = frontmatterString(frontmatter.model);
  if (expectedAgent?.model && renderedModel !== expectedAgent.model) {
    errors.push(`${displayPath}: model must match adapters.opencode.roleSettings.${roleName}.model`);
  }

  const renderedVariant = frontmatterString(frontmatter.variant);
  if (expectedAgent?.variant !== undefined && renderedVariant !== expectedAgent.variant) {
    errors.push(`${displayPath}: variant must match the resolved OpenCode reasoning effort`);
  }

  validateRequiredSnippets(
    displayPath,
    body,
    [
      `You are the ${roleName[0].toUpperCase()}${roleName.slice(1)} for the target project.`,
      `Follow ${expectedAgent?.sourceFile ?? `${AGENTS_SOURCE_DIRECTORY}/${roleName}.md`} as the canonical role contract.`,
      '.agenticloop/project.md',
      'Agentic Loop methodology.',
    ],
    errors,
    'prompt body is missing required methodology text'
  );

  for (const skillName of expectedAgent?.requiredSkills ?? []) {
      const skillPath = `${config.skills?.sourceDirectory ?? SKILLS_SOURCE_DIRECTORY}/${skillName}/SKILL.md`;
    if (!body.includes(skillPath)) {
      errors.push(`${displayPath}: prompt body is missing required skill reference: ${skillPath}`);
    }
  }

  const skillsSrc = normalizeSkillsSourceDir(config.skills?.sourceDirectory);
  if (expectedAgent?.promptBody && !body.includes(rewriteOpencodeSkillReferences(expectedAgent.promptBody, skillsSrc))) {
    errors.push(`${displayPath}: prompt body must append the canonical role body from ${expectedAgent.sourceFile}`);
  }

  if (roleName === 'orchestrator') {
    const permission = frontmatter.permission;
    const taskPermission = permission?.task;
    if (!permission || typeof permission !== 'object') {
      errors.push(`${displayPath}: orchestrator frontmatter is missing permission`);
      return;
    }
    if (frontmatterString(permission.edit) !== 'deny') {
      errors.push(`${displayPath}: orchestrator must set permission.edit to deny`);
    }
    if (!taskPermission || typeof taskPermission !== 'object') {
      errors.push(`${displayPath}: orchestrator is missing permission.task`);
      return;
    }
    if (frontmatterString(taskPermission['*']) !== 'deny') {
      errors.push(`${displayPath}: orchestrator permission.task must deny '*' by default`);
    }
    if (frontmatterString(taskPermission.maintainer) !== 'allow') {
      errors.push(`${displayPath}: orchestrator permission.task must allow 'maintainer'`);
    }
    if (frontmatterString(taskPermission.engineer) !== 'allow') {
      errors.push(`${displayPath}: orchestrator permission.task must allow 'engineer'`);
    }
  }

  if (!body.includes('Generated by Agentic Loop')) {
    warnings.push(`${displayPath}: missing generated-file banner; regenerate with 'agenticloop update --adapter opencode'`);
  }
}

// ---------------------------------------------------------------------------
// Codex adapter validation
// ---------------------------------------------------------------------------

function collectNestedFiles(rootDir, filename, matches = [], currentDir = rootDir) {
  if (!existsSync(currentDir) || !statSync(currentDir).isDirectory()) return matches;

  for (const entry of readdirSync(currentDir)) {
    const fullPath = join(currentDir, entry);
    const entryStat = statSync(fullPath);
    if (entryStat.isDirectory()) {
      collectNestedFiles(rootDir, filename, matches, fullPath);
      continue;
    }
    if (entry === filename) {
      matches.push(fullPath);
    }
  }

  return matches;
}

function validateCodexOpenAiMetadata(skillDir, label, errors) {
  const metadataPath = join(skillDir, 'agents', 'openai.yaml');
  if (!existsSync(metadataPath)) {
    errors.push(
      `${label}: Codex public skill metadata not found at ${metadataPath.replace(/\\/g, '/')}; run 'agenticloop generate codex'`
    );
    return;
  }

  let text = '';
  try {
    text = readFileSync(metadataPath, 'utf-8');
  } catch (error) {
    errors.push(`${metadataPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const requiredSnippets = [
    'interface:',
    'display_name: "Agentic Loop"',
    `short_description: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`,
    `default_prompt: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`,
  ];

  for (const snippet of requiredSnippets) {
    if (!text.includes(snippet)) {
      errors.push(`${metadataPath.replace(/\\/g, '/')}: metadata is missing required text: ${snippet}`);
    }
  }
}

function validateCodexInternalReferences(skillDir, label, errors) {
  const referencesRoot = join(skillDir, 'references', 'skills');
  for (const skillName of CODEX_REQUIRED_REFERENCE_SKILLS) {
    const referencePath = join(referencesRoot, skillName, 'reference.md');
    if (!existsSync(referencePath)) {
      errors.push(
        `${label}: required internal reference missing: ${referencePath.replace(/\\/g, '/')}`
      );
    }
  }

  const backendsRoot = join(skillDir, 'references', 'backends');
  for (const backendFile of CODEX_REQUIRED_BACKEND_REFERENCES) {
    const backendPath = join(backendsRoot, backendFile);
    if (!existsSync(backendPath)) {
      errors.push(
        `${label}: required backend reference missing: ${backendPath.replace(/\\/g, '/')}`
      );
    }
  }

  if (existsSync(backendsRoot) && statSync(backendsRoot).isDirectory()) {
    for (const entry of readdirSync(backendsRoot)) {
      const backendPath = join(backendsRoot, entry);
      if (!entry.endsWith('.md') || !statSync(backendPath).isFile()) continue;
      try {
        validateNoDanglingBackendPaths(
          readFileSync(backendPath, 'utf-8'),
          backendPath.replace(/\\/g, '/'),
          errors
        );
      } catch (error) {
        errors.push(`${backendPath.replace(/\\/g, '/')}: ${error.message}`);
      }
    }
  }

  for (const referenceFile of collectNestedFiles(referencesRoot, 'reference.md')) {
    try {
      const referenceText = readFileSync(referenceFile, 'utf-8');
      validateNoCodexLegacyEventLoggingFallback(referenceText, referenceFile.replace(/\\/g, '/'), errors);
      validateNoDanglingBackendPaths(referenceText, referenceFile.replace(/\\/g, '/'), errors);
    } catch (error) {
      errors.push(`${referenceFile.replace(/\\/g, '/')}: ${error.message}`);
    }
  }

  for (const nestedSkillFile of collectNestedFiles(referencesRoot, 'SKILL.md')) {
    errors.push(
      `${label}: internal references must not contain discoverable SKILL.md files: ${nestedSkillFile.replace(/\\/g, '/')}`
    );
  }
}

function validateNoDanglingBackendPaths(text, label, errors) {
  if (CODEX_DANGLING_BACKEND_PATTERN.test(text)) {
    errors.push(
      `${label}: contains dangling bare backend path (${BACKENDS_SOURCE_DIRECTORY}/files.md or ${BACKENDS_SOURCE_DIRECTORY}/github.md); generated Codex artifacts must use rewritten references (references/backends/... or .agents/skills/agenticloop/references/backends/...)`
    );
  }
}

function validateNoCodexLegacyEventLoggingFallback(text, label, errors) {
  for (const { pattern, description } of CODEX_FORBIDDEN_EVENT_LOGGING_PATTERNS) {
    if (pattern.test(text)) {
      errors.push(`${label}: contains ${description}; Codex generated artifacts must resolve the event logging command first and treat missing commands as non-blocking`);
    }
  }
}

function validateNoLegacyCodexDiscoverableSkills(skillsRoot, label, errors) {
  for (const entry of legacyCodexSkillDirectories(skillsRoot)) {
    const skillPath = join(skillsRoot, entry, 'SKILL.md').replace(/\\/g, '/');
    errors.push(`${label}: legacy discoverable Codex skill output is not allowed: ${skillPath}`);
  }
}

function validateCodexPublicSkill(skillDir, errors, label = 'Codex adapter', agentNames = {}) {
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    errors.push(
      `${label}: public skill not found at ${skillPath.replace(/\\/g, '/')}; run 'agenticloop generate codex'`
    );
    return;
  }

  let skillText = '';
  try {
    skillText = readFileSync(skillPath, 'utf-8');
  } catch (error) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(skillText);
  if (frontmatter === null) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: skill frontmatter is required`);
    return;
  }

  if (frontmatterString(frontmatter.name) !== CODEX_PUBLIC_SKILL_NAME) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter name must be '${CODEX_PUBLIC_SKILL_NAME}'`);
  }

  const description = frontmatterString(frontmatter.description);
  if (!description || !description.includes('Operate in Agentic Loop mode')) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter description must clearly describe Agentic Loop mode`);
  }

  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  const requiredSnippets = [
    'Read `.agenticloop/project.md` first.',
    '`setup_status`',
    `\`${PROCESS_DOC_RELATIVE_PATH}\``,
    `\`${AGENTS_SOURCE_DIRECTORY}/\``,
    `Codex custom agent \`${maintainerAgent}\``,
    `Codex custom agent \`${engineerAgent}\``,
    'Create or refine the durable task record before any implementation.',
    '`role.invoked`',
    'should not directly edit implementation files from the coordinator',
    'references/skills/role-delegation/reference.md',
    'references/skills/task-record-contract/reference.md',
    'references/skills/setup-agenticloop/reference.md',
    'references/skills/blocked-state/reference.md',
    'references/backends/files.md',
    'references/backends/github.md',
    'npx agenticloop --help',
    'Do not assume `npx agenticloop` exists before that check succeeds.',
    'do not block the workflow',
  ];

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${skillPath.replace(/\\/g, '/')}: skill body is missing required activation text: ${snippet}`);
    }
  }
  validateNoCodexLegacyEventLoggingFallback(skillText, skillPath.replace(/\\/g, '/'), errors);
  validateNoDanglingBackendPaths(skillText, skillPath.replace(/\\/g, '/'), errors);

  validateCodexOpenAiMetadata(skillDir, label, errors);
  validateCodexInternalReferences(skillDir, label, errors);
}

function validateCodexAgentToml(config, roleName, agentName, tomlPath, errors, agentNames = {}) {
  if (!existsSync(tomlPath)) {
    errors.push(`Codex adapter: expected agent file missing: ${tomlPath.replace(/\\/g, '/')}`);
    return;
  }

  const roleSourceFile = config.roles?.[roleName]?.sourceFile ?? `${AGENTS_SOURCE_DIRECTORY}/${roleName}.md`;
  const requiredSkills = config.roles?.[roleName]?.requiredSkills ?? [];
  let text = '';
  try {
    text = readFileSync(tomlPath, 'utf-8');
  } catch (error) {
    errors.push(`${tomlPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }
  validateNoCodexLegacyEventLoggingFallback(text, tomlPath.replace(/\\/g, '/'), errors);
  validateNoDanglingBackendPaths(text, tomlPath.replace(/\\/g, '/'), errors);

  const name = readTomlField(text, 'name');
  const description = readTomlField(text, 'description');
  const model = readTomlField(text, 'model');
  const reasoningEffort = readTomlField(text, 'model_reasoning_effort');
  const developerInstructions = readTomlField(text, 'developer_instructions');
  const expectedSettings = resolveRoleModel(config, 'codex', roleName, config.adapters?.codex ?? {});
  const expectedModel = normalizeCodexModel(expectedSettings.model);
  const expectedReasoningEffort = normalizeCodexReasoningEffort(expectedSettings.variant);

  if (!name) {
    errors.push(`${tomlPath.replace(/\\/g, '/')}: missing required TOML field 'name'`);
  } else if (name !== agentName) {
    errors.push(`${tomlPath.replace(/\\/g, '/')}: TOML field 'name' must be '${agentName}'`);
  }
  if (!description) {
    errors.push(`${tomlPath.replace(/\\/g, '/')}: missing required TOML field 'description'`);
  }
  if (isLegacyCodexCliModel(model)) {
    errors.push(
      `${tomlPath.replace(/\\/g, '/')}: model must use a Codex model id such as '${normalizeCodexModel(model)}', not legacy '${model}'`
    );
  }
  if (expectedModel && model !== expectedModel) {
    errors.push(
      `${tomlPath.replace(/\\/g, '/')}: model must match adapters.codex.roleSettings.${roleName}.model after Codex normalization: '${expectedModel}'`
    );
  }
  if (!developerInstructions) {
    errors.push(`${tomlPath.replace(/\\/g, '/')}: missing required TOML field 'developer_instructions'`);
    return;
  }

  const requiredSnippets = [
    `Canonical role source: \`${roleSourceFile}\`.`,
    'Read `.agenticloop/project.md` before acting',
    `Follow \`${PROCESS_DOC_RELATIVE_PATH}\` as the workflow methodology.`,
    'npx agenticloop --help',
    'Do not assume `npx agenticloop` exists before that check succeeds.',
    'If no working event logging command is available, do not block the workflow.',
  ];

  if (requiredSkills.length > 0) {
    requiredSnippets.push('Agentic Loop internal references to use when their trigger applies:');
    for (const skillName of requiredSkills) {
      requiredSnippets.push(`.agents/skills/${CODEX_PUBLIC_SKILL_NAME}/references/skills/${skillName}/reference.md`);
    }
  }

  for (const backendFile of CODEX_REQUIRED_BACKEND_REFERENCES) {
    requiredSnippets.push(`.agents/skills/${CODEX_PUBLIC_SKILL_NAME}/references/backends/${backendFile}`);
  }

  if (roleName === 'orchestrator') {
    requiredSnippets.push(`Codex custom agent \`${agentNames.maintainer ?? 'maintainer'}\``);
    requiredSnippets.push(`Codex custom agent \`${agentNames.engineer ?? 'engineer'}\``);
    requiredSnippets.push('single plain-message prompt payload only');
    requiredSnippets.push('Do not mix a plain message payload with structured items in the same spawn request.');
    requiredSnippets.push('schema error about message/items');
    requiredSnippets.push('role.invoked');
  } else if (roleName === 'maintainer') {
    requiredSnippets.push('Stay within maintainer boundaries');
    requiredSnippets.push('Do not implement code changes');
  } else if (roleName === 'engineer') {
    requiredSnippets.push('Stay within engineer boundaries');
    requiredSnippets.push('Do not accept tasks or perform final maintainer review');
  }

  for (const snippet of requiredSnippets) {
    if (!developerInstructions.includes(snippet)) {
      errors.push(`${tomlPath.replace(/\\/g, '/')}: developer_instructions is missing required methodology text: ${snippet}`);
    }
  }

  if (reasoningEffort && !CODEX_SUPPORTED_REASONING_EFFORTS.has(reasoningEffort)) {
    errors.push(
      `${tomlPath.replace(/\\/g, '/')}: model_reasoning_effort must be omitted or one of: ${CODEX_SUPPORTED_REASONING_EFFORTS_DISPLAY}`
    );
  }
  if (expectedReasoningEffort && reasoningEffort !== expectedReasoningEffort) {
    errors.push(
      `${tomlPath.replace(/\\/g, '/')}: model_reasoning_effort must match adapters.codex.roleSettings.${roleName}.reasoningEffort after Codex normalization: '${expectedReasoningEffort}'`
    );
  }
}

function validateCodexPluginDistribution(config, repoRoot, errors, agentNames) {
  const pluginRoot = join(repoRoot, 'plugins', 'agenticloop');
  const pluginPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const skillsRoot = join(pluginRoot, 'skills');
  const publicSkillDir = join(skillsRoot, CODEX_PUBLIC_SKILL_NAME);
  const marketplacePath = join(repoRoot, '.agents', 'plugins', 'marketplace.json');

  if (!existsSync(pluginPath)) {
    errors.push(
      "Codex plugin: expected plugin root manifest at 'plugins/agenticloop/.codex-plugin/plugin.json' when adapters.codex.plugin.enabled is true"
    );
  } else {
    try {
      const manifest = loadJsonFile(pluginPath);
      if (manifest.name !== 'agenticloop') {
        errors.push(`Codex plugin: 'name' must be 'agenticloop' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
        errors.push(`Codex plugin: missing non-empty 'version' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
        errors.push(`Codex plugin: missing non-empty 'description' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (manifest.skills !== './skills/') {
        errors.push(`Codex plugin: 'skills' must point to './skills/' in ${pluginPath.replace(/\\/g, '/')}`);
      }
    } catch (error) {
      errors.push(`Codex plugin parse error: ${error.message}`);
    }
  }

  validateCodexPublicSkill(publicSkillDir, errors, 'Codex plugin', agentNames);
  validateNoLegacyCodexDiscoverableSkills(skillsRoot, 'Codex plugin', errors);

  if (!existsSync(marketplacePath)) {
    errors.push(
      "Codex plugin: marketplace entry '.agents/plugins/marketplace.json' not found when adapters.codex.plugin.enabled is true"
    );
    return;
  }

  try {
    const marketplace = loadJsonFile(marketplacePath);
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    const entry = plugins.find(plugin => plugin?.name === 'agenticloop');
    if (!entry) {
      errors.push(`Codex plugin: marketplace entry for 'agenticloop' not found in ${marketplacePath.replace(/\\/g, '/')}`);
      return;
    }
    if (!entry.source || typeof entry.source !== 'object' || Array.isArray(entry.source)) {
      errors.push(`Codex plugin: marketplace entry source must be an object in ${marketplacePath.replace(/\\/g, '/')}`);
    } else {
      if (entry.source.source !== 'local') {
        errors.push(`Codex plugin: marketplace entry source.source must be 'local' in ${marketplacePath.replace(/\\/g, '/')}`);
      }
      if (entry.source.path !== './plugins/agenticloop') {
        errors.push(`Codex plugin: marketplace entry source.path must be './plugins/agenticloop' in ${marketplacePath.replace(/\\/g, '/')}`);
      }
    }
    if (typeof entry.category !== 'string' || entry.category.trim() === '') {
      errors.push(`Codex plugin: marketplace entry must include non-empty 'category' in ${marketplacePath.replace(/\\/g, '/')}`);
    }
    if (!entry.policy || typeof entry.policy !== 'object' || Array.isArray(entry.policy)) {
      errors.push(`Codex plugin: marketplace entry must include a policy object in ${marketplacePath.replace(/\\/g, '/')}`);
    } else {
      if (typeof entry.policy.installation !== 'string' || entry.policy.installation.trim() === '') {
        errors.push(`Codex plugin: marketplace entry must include non-empty policy.installation in ${marketplacePath.replace(/\\/g, '/')}`);
      }
      if (typeof entry.policy.authentication !== 'string' || entry.policy.authentication.trim() === '') {
        errors.push(`Codex plugin: marketplace entry must include non-empty policy.authentication in ${marketplacePath.replace(/\\/g, '/')}`);
      }
    }
  } catch (error) {
    errors.push(`Codex plugin marketplace parse error: ${error.message}`);
  }
}

function validateCodexAdapter(config, repoRoot, errors, warnings) {
  const agentsDir = join(repoRoot, '.codex', 'agents');
  const repoSkillsRoot = join(repoRoot, '.agents', 'skills');
  const publicSkillDir = join(repoSkillsRoot, CODEX_PUBLIC_SKILL_NAME);
  const pluginPath = join(repoRoot, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json');
  const legacyPluginPath = join(repoRoot, '.codex-plugin', 'plugin.json');
  const pluginEnabled = config.adapters?.codex?.plugin?.enabled === true;

  if (!existsSync(agentsDir)) {
    errors.push(`Codex adapter: .codex/agents/ not found; run 'agenticloop generate codex'`);
  }

  const roleBindings = config.adapters?.codex?.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(config.roles ?? {}).map(roleName => [
      roleName,
      roleBindings[roleName]?.agent ?? roleName,
    ])
  );

  validateCodexPublicSkill(publicSkillDir, errors, 'Codex adapter', agentNames);
  validateNoLegacyCodexDiscoverableSkills(repoSkillsRoot, 'Codex adapter', errors);

  for (const roleName of Object.keys(config.roles ?? {})) {
    const agentName = roleBindings[roleName]?.agent ?? roleName;
    const tomlPath = join(agentsDir, `${agentName}.toml`);
    validateCodexAgentToml(config, roleName, agentName, tomlPath, errors, agentNames);
  }

  if (pluginEnabled || existsSync(pluginPath)) {
    validateCodexPluginDistribution(config, repoRoot, errors, agentNames);
  }

  if (existsSync(legacyPluginPath)) {
    try {
      const legacyManifest = loadJsonFile(legacyPluginPath);
      const looksLikeAgenticLoopLegacy =
        legacyManifest?.name === 'agenticloop' ||
        legacyManifest?.skills === './.agents/skills/agenticloop';
      if (looksLikeAgenticLoopLegacy) {
        errors.push(
          "Codex adapter: legacy repo-root '.codex-plugin/plugin.json' is no longer the supported Agentic Loop plugin shape; use repo-local .agents/skills/agenticloop/ plus .codex/agents/, or enable adapters.codex.plugin.enabled for plugins/agenticloop/.codex-plugin/plugin.json"
        );
      }
    } catch (error) {
      errors.push(`Codex plugin parse error: ${error.message}`);
    }
  }

}

// ---------------------------------------------------------------------------
// Claude Code adapter validation
// ---------------------------------------------------------------------------

function validateClaudeCodePublicSkill(skillDir, errors, agentNames = {}) {
  const label = 'Claude Code adapter';
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    errors.push(
      "Claude Code adapter: generated public skill '.claude/skills/agenticloop/SKILL.md' not found; run 'agenticloop generate claude-code'"
    );
    return;
  }

  let skillText = '';
  try {
    skillText = readFileSync(skillPath, 'utf-8');
  } catch (error) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(skillText);
  if (frontmatter === null) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: skill frontmatter is required`);
    return;
  }

  if (frontmatterString(frontmatter.name) !== CLAUDE_PUBLIC_SKILL_NAME) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter name must be '${CLAUDE_PUBLIC_SKILL_NAME}'`);
  }

  const description = frontmatterString(frontmatter.description);
  if (!description || !description.includes('Operate in Agentic Loop mode')) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter description must clearly describe Agentic Loop mode`);
  }

  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  const requiredSnippets = [
    'Read `.agenticloop/project.md` first.',
    `\`${PROCESS_DOC_RELATIVE_PATH}\``,
    `\`${AGENTS_SOURCE_DIRECTORY}/\``,
    `Claude Code subagent \`${maintainerAgent}\``,
    `Claude Code subagent \`${engineerAgent}\``,
    'Create or refine the durable task record before any implementation.',
  ];
  for (const skillName of CLAUDE_REQUIRED_REFERENCE_SKILLS) {
    requiredSnippets.push(`references/skills/${skillName}/reference.md`);
  }

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${skillPath.replace(/\\/g, '/')}: skill body is missing required activation text: ${snippet}`);
    }
  }

  const referencesRoot = join(skillDir, 'references', 'skills');
  for (const skillName of CLAUDE_REQUIRED_REFERENCE_SKILLS) {
    const referencePath = join(referencesRoot, skillName, 'reference.md');
    if (!existsSync(referencePath)) {
      errors.push(
        `${label}: required internal reference missing: ${referencePath.replace(/\\/g, '/')}`
      );
    }
  }

  // Only the top-level agenticloop/SKILL.md is a discoverable Claude skill.
  // Any deeper SKILL.md is either a stale legacy agenticloop/<name>/SKILL.md
  // copy or a discoverable reference; both are forbidden.
  const publicSkillPath = join(skillDir, 'SKILL.md');
  for (const nestedSkillFile of collectNestedFiles(skillDir, 'SKILL.md')) {
    if (nestedSkillFile === publicSkillPath) continue;
    errors.push(
      `${label}: internal references must not contain discoverable SKILL.md files: ${nestedSkillFile.replace(/\\/g, '/')}; regenerate with 'agenticloop generate claude-code'`
    );
  }
}

function claudeAgentReferenceAbsolutePath(skillName) {
  return `.claude/skills/${CLAUDE_PUBLIC_SKILL_NAME}/references/skills/${skillName}/reference.md`;
}

function validateClaudeCodeAgentReferences(config, roleName, mdPath, errors) {
  const requiredSkills = config.roles?.[roleName]?.requiredSkills ?? [];
  if (requiredSkills.length === 0) return;

  let text = '';
  try {
    text = readFileSync(mdPath, 'utf-8');
  } catch (error) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  for (const skillName of requiredSkills) {
    if (!text.includes(claudeAgentReferenceAbsolutePath(skillName))) {
      errors.push(
        `${mdPath.replace(/\\/g, '/')}: generated agent must reference required skill '${skillName}' by its internal path '${claudeAgentReferenceAbsolutePath(skillName)}'`
      );
    }
    if (text.includes(`[[${skillName}]]`)) {
      errors.push(
        `${mdPath.replace(/\\/g, '/')}: generated agent contains an unresolved '[[${skillName}]]' marker; Mode B agents must point at the generated reference.md path`
      );
    }
  }
}

function validateClaudeCodeAdapter(config, repoRoot, errors, warnings) {
  const agentsDir = join(repoRoot, '.claude', 'agents');
  const commandPath = join(repoRoot, '.claude', 'commands', 'agenticloop.md');
  const generatedSkillDir = join(repoRoot, '.claude', 'skills', CLAUDE_PUBLIC_SKILL_NAME);

  if (!existsSync(agentsDir)) {
    errors.push(`Claude Code adapter: .claude/agents/ not found; run 'agenticloop generate claude-code'`);
  }

  const roleBindings = config.adapters?.['claude-code']?.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(config.roles ?? {}).map(roleName => [
      roleName,
      roleBindings[roleName]?.agent ?? roleName,
    ])
  );
  if (existsSync(agentsDir)) {
    for (const roleName of Object.keys(config.roles ?? {})) {
      const agentName = roleBindings[roleName]?.agent ?? roleName;
      const mdPath = join(agentsDir, `${agentName}.md`);
      if (!existsSync(mdPath)) {
        errors.push(`Claude Code adapter: expected agent file missing: ${mdPath}`);
        continue;
      }
      validateClaudeCodeAgentReferences(config, roleName, mdPath, errors);
    }
  }

  if (!existsSync(commandPath)) {
    errors.push(
      "Claude Code adapter: generated command '.claude/commands/agenticloop.md' not found; run 'agenticloop generate claude-code'"
    );
  }

  validateClaudeCodePublicSkill(generatedSkillDir, errors, agentNames);
}

// ---------------------------------------------------------------------------
// Copilot adapter validation
// ---------------------------------------------------------------------------

function firstSubstantiveLine(text) {
  for (const line of (text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

function copilotAgentReferenceAbsolutePath(skillName) {
  return `.github/skills/${COPILOT_PUBLIC_SKILL_NAME}/references/skills/${skillName}/reference.md`;
}

function validateCopilotPublicSkill(skillDir, errors, agentNames = {}) {
  const label = 'Copilot adapter';
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    errors.push(
      "Copilot adapter: generated public skill '.github/skills/agenticloop/SKILL.md' not found; run 'agenticloop generate copilot'"
    );
    return;
  }

  let skillText = '';
  try {
    skillText = readFileSync(skillPath, 'utf-8');
  } catch (error) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(skillText);
  if (frontmatter === null) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: skill frontmatter is required`);
    return;
  }

  if (frontmatterString(frontmatter.name) !== COPILOT_PUBLIC_SKILL_NAME) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter name must be '${COPILOT_PUBLIC_SKILL_NAME}'`);
  }

  const description = frontmatterString(frontmatter.description);
  if (!description || !description.includes('/agenticloop') || !/explicit/i.test(description)) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter description must mention explicit /agenticloop activation`);
  }
  if (frontmatterString(frontmatter['user-invocable']) !== 'true') {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter user-invocable must be true so Copilot CLI can expose /agenticloop`);
  }
  if (frontmatterString(frontmatter['disable-model-invocation']) !== 'true') {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter disable-model-invocation must be true so Agentic Loop remains explicitly activated`);
  }

  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  const requiredSnippets = [
    'Read `.agenticloop/project.md` first.',
    `\`${PROCESS_DOC_RELATIVE_PATH}\``,
    `\`${AGENTS_SOURCE_DIRECTORY}/\``,
    `Copilot custom agent \`${maintainerAgent}\``,
    `Copilot custom agent \`${engineerAgent}\``,
    'real Copilot custom-agent, subagent, or handoff delegation',
    'Create or refine the durable task record before any implementation.',
    'references/skills/role-delegation/reference.md',
    'references/skills/task-record-contract/reference.md',
    'references/skills/setup-agenticloop/reference.md',
    'references/skills/blocked-state/reference.md',
    'references/backends/README.md',
    'references/backends/files.md',
    'references/backends/github.md',
  ];

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${skillPath.replace(/\\/g, '/')}: skill body is missing required activation text: ${snippet}`);
    }
  }

  const referencesRoot = join(skillDir, 'references', 'skills');
  for (const skillName of COPILOT_REQUIRED_PUBLIC_REFERENCES) {
    const referencePath = join(referencesRoot, skillName, 'reference.md');
    if (!existsSync(referencePath)) {
      errors.push(
        `${label}: required internal reference missing: ${referencePath.replace(/\\/g, '/')}`
      );
    }
  }

  const backendsRoot = join(skillDir, 'references', 'backends');
  for (const backendFile of COPILOT_REQUIRED_BACKEND_REFERENCES) {
    const backendPath = join(backendsRoot, backendFile);
    if (!existsSync(backendPath)) {
      errors.push(
        `${label}: required backend reference missing: ${backendPath.replace(/\\/g, '/')}`
      );
    }
  }

  for (const nestedSkillFile of collectNestedFiles(join(skillDir, 'references'), 'SKILL.md')) {
    errors.push(
      `${label}: internal references must not contain discoverable SKILL.md files: ${nestedSkillFile.replace(/\\/g, '/')}`
    );
  }
}

function validateCopilotPromptFile(promptPath, orchestratorAgent, errors) {
  if (!existsSync(promptPath)) {
    errors.push(
      `Copilot adapter: generated prompt '${promptPath.replace(/\\/g, '/')}' not found; run 'agenticloop generate copilot'`
    );
    return;
  }

  let promptText = '';
  try {
    promptText = readFileSync(promptPath, 'utf-8');
  } catch (error) {
    errors.push(`${promptPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(promptText);
  if (frontmatter === null) {
    errors.push(`${promptPath.replace(/\\/g, '/')}: prompt frontmatter is required`);
    return;
  }

  if (frontmatterString(frontmatter.agent) !== orchestratorAgent) {
    errors.push(`${promptPath.replace(/\\/g, '/')}: prompt frontmatter must set agent: ${orchestratorAgent}`);
  }

  if (frontmatterString(frontmatter.description) !== AGENTIC_LOOP_OPERATION_DESCRIPTION) {
    errors.push(`${promptPath.replace(/\\/g, '/')}: prompt frontmatter description must match the canonical Agentic Loop operation description`);
  }

  const requiredSnippets = [
    'Activate Agentic Loop for this repository',
    '`.agenticloop/project.md`',
    '`.github/skills/agenticloop/SKILL.md`',
    'Agentic Loop',
    `Copilot custom agent \`${orchestratorAgent}\``,
  ];

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${promptPath.replace(/\\/g, '/')}: prompt body is missing required activation text: ${snippet}`);
    }
  }
}

function validateCopilotAgent(config, repoRoot, roleName, agentName, mdPath, errors, agentNames = {}) {
  if (!existsSync(mdPath)) {
    errors.push(`Copilot adapter: expected agent file missing: ${mdPath.replace(/\\/g, '/')}`);
    return;
  }

  let text = '';
  try {
    text = readFileSync(mdPath, 'utf-8');
  } catch (error) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(text);
  if (frontmatter === null) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: agent frontmatter is required`);
    return;
  }

  const roleRecord = buildRoleRecord(config, repoRoot, roleName);
  const expectedSettings = resolveRoleModel(config, 'copilot', roleName, config.adapters?.copilot ?? {});
  const frontmatterText = rawFrontmatterBlock(text);
  const name = frontmatterString(frontmatter.name);
  const description = frontmatterString(frontmatter.description);
  const model = frontmatterString(frontmatter.model);
  const tools = readYamlListField(frontmatterText, 'tools') ?? [];
  const agents = readYamlListField(frontmatterText, 'agents');
  const userInvocable = frontmatterString(frontmatter['user-invocable']);
  const disableModelInvocation = frontmatterString(frontmatter['disable-model-invocation']);
  const expectedTools = roleName === 'orchestrator'
    ? ['agent', 'execute', 'read', 'search']
    : ['execute', 'read', 'search', 'edit'];

  if (name !== agentName) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: frontmatter name must be '${agentName}'`);
  }
  if (description !== (roleRecord.description ?? '')) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: frontmatter description must match the canonical role description`);
  }

  if (expectedSettings.model) {
    if (model !== expectedSettings.model) {
      errors.push(`${mdPath.replace(/\\/g, '/')}: model must match adapters.copilot.roleSettings.${roleName}.model`);
    }
  } else if (model) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: model must be omitted when no Copilot model is configured`);
  }

  if (frontmatterString(frontmatter.reasoningEffort) || frontmatterString(frontmatter.variant)) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: Copilot agents must not render reasoningEffort or variant frontmatter`);
  }
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    errors.push(
      `${mdPath.replace(/\\/g, '/')}: tools must match the generated Copilot ${roleName} tool list (${expectedTools.join(', ')})`
    );
  }

  const requiredSnippets = [
    `Canonical role source: \`${roleRecord.sourceFile}\`.`,
    'Read `.agenticloop/project.md` before acting',
    `Follow \`${PROCESS_DOC_RELATIVE_PATH}\` as the workflow methodology.`,
  ];

  for (const skillName of roleRecord.requiredSkills ?? []) {
    requiredSnippets.push(copilotAgentReferenceAbsolutePath(skillName));
    if (body.includes(`[[${skillName}]]`)) {
      errors.push(
        `${mdPath.replace(/\\/g, '/')}: generated agent contains an unresolved '[[${skillName}]]' marker; Copilot agents must point at the generated reference.md path`
      );
    }
  }

  const canonicalLine = firstSubstantiveLine(roleRecord.promptBody);
  if (canonicalLine) {
    requiredSnippets.push(canonicalLine);
  }

  if (roleName === 'orchestrator') {
    const expectedAgents = [
      agentNames.maintainer ?? 'maintainer',
      agentNames.engineer ?? 'engineer',
    ];
    if (JSON.stringify(agents) !== JSON.stringify(expectedAgents)) {
      errors.push(
        `${mdPath.replace(/\\/g, '/')}: agents must explicitly allow the Copilot worker agents (${expectedAgents.join(', ')})`
      );
    }
    if (userInvocable !== 'true') {
      errors.push(`${mdPath.replace(/\\/g, '/')}: orchestrator must set user-invocable: true`);
    }
    if (disableModelInvocation !== 'true') {
      errors.push(`${mdPath.replace(/\\/g, '/')}: orchestrator must set disable-model-invocation: true`);
    }
    requiredSnippets.push(`Copilot custom agent \`${agentNames.maintainer ?? 'maintainer'}\``);
    requiredSnippets.push(`Copilot custom agent \`${agentNames.engineer ?? 'engineer'}\``);
    requiredSnippets.push('real Copilot custom-agent, subagent, or handoff delegation');
    requiredSnippets.push('bounded fallback reason');
    requiredSnippets.push('role.invoked');
  } else if (roleName === 'maintainer') {
    if (agents !== null) {
      errors.push(`${mdPath.replace(/\\/g, '/')}: worker agents must not declare an agents allow-list`);
    }
    if (userInvocable !== 'false') {
      errors.push(`${mdPath.replace(/\\/g, '/')}: maintainer must set user-invocable: false so it stays callable as a worker agent without appearing in the picker`);
    }
    if (disableModelInvocation !== 'false') {
      errors.push(`${mdPath.replace(/\\/g, '/')}: maintainer must set disable-model-invocation: false so the orchestrator can invoke it as a subagent`);
    }
    requiredSnippets.push('Stay within maintainer boundaries');
    requiredSnippets.push('Do not implement code changes');
  } else if (roleName === 'engineer') {
    if (agents !== null) {
      errors.push(`${mdPath.replace(/\\/g, '/')}: worker agents must not declare an agents allow-list`);
    }
    if (userInvocable !== 'false') {
      errors.push(`${mdPath.replace(/\\/g, '/')}: engineer must set user-invocable: false so it stays callable as a worker agent without appearing in the picker`);
    }
    if (disableModelInvocation !== 'false') {
      errors.push(`${mdPath.replace(/\\/g, '/')}: engineer must set disable-model-invocation: false so the orchestrator can invoke it as a subagent`);
    }
    requiredSnippets.push('Stay within engineer boundaries');
    requiredSnippets.push('Do not accept tasks or perform final maintainer review');
  }

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${mdPath.replace(/\\/g, '/')}: agent body is missing required methodology text: ${snippet}`);
    }
  }
}

function validateCopilotAdapter(config, repoRoot, errors, warnings) {
  const roleBindings = config.adapters?.copilot?.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(config.roles ?? {}).map(roleName => [
      roleName,
      roleBindings[roleName]?.agent ?? roleName,
    ])
  );
  const agentsDir = join(repoRoot, '.github', 'agents');
  const skillDir = join(repoRoot, '.github', 'skills', COPILOT_PUBLIC_SKILL_NAME);
  const promptPath = resolveCopilotPromptPath(repoRoot);

  if (!existsSync(agentsDir)) {
    errors.push(`Copilot adapter: .github/agents/ not found; run 'agenticloop generate copilot'`);
  }

  for (const roleName of Object.keys(config.roles ?? {})) {
    const agentName = agentNames[roleName] ?? roleName;
    validateCopilotAgent(
      config,
      repoRoot,
      roleName,
      agentName,
      resolveCopilotAgentPath(repoRoot, agentName),
      errors,
      agentNames
    );
  }

  validateCopilotPublicSkill(skillDir, errors, agentNames);
  validateCopilotPromptFile(promptPath, agentNames.orchestrator ?? 'orchestrator', errors);
}

// ---------------------------------------------------------------------------
// Cursor adapter validation
// ---------------------------------------------------------------------------

function cursorAgentReferenceAbsolutePath(skillName, rootPrefix = '.cursor') {
  return `${rootPrefix}/skills/${CURSOR_PUBLIC_SKILL_NAME}/references/skills/${skillName}/reference.md`;
}

function cursorBackendReferenceAbsolutePath(filename, rootPrefix = '.cursor') {
  return `${rootPrefix}/skills/${CURSOR_PUBLIC_SKILL_NAME}/references/backends/${filename}`;
}

function validateCursorPublicSkill(skillDir, errors, agentNames = {}, options = {}) {
  const label = options.label ?? 'Cursor adapter';
  const agentRootDisplay = options.agentRootDisplay ?? '.cursor/agents';
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    errors.push(
      `${label}: generated public skill '${skillPath.replace(/\\/g, '/')}' not found; run 'agenticloop generate cursor'`
    );
    return;
  }

  let skillText = '';
  try {
    skillText = readFileSync(skillPath, 'utf-8');
  } catch (error) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(skillText);
  if (frontmatter === null) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: skill frontmatter is required`);
    return;
  }

  if (frontmatterString(frontmatter.name) !== CURSOR_PUBLIC_SKILL_NAME) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter name must be '${CURSOR_PUBLIC_SKILL_NAME}'`);
  }

  const description = frontmatterString(frontmatter.description);
  if (!description || !description.includes('/agenticloop') || !/explicit/i.test(description)) {
    errors.push(`${skillPath.replace(/\\/g, '/')}: frontmatter description must mention explicit /agenticloop activation`);
  }
  if (frontmatterString(frontmatter['disable-model-invocation']) !== 'true') {
    errors.push(`${skillPath.replace(/\\/g, '/')}: skill frontmatter must set disable-model-invocation: true`);
  }

  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  const requiredSnippets = [
    'Read `.agenticloop/project.md` first.',
    '`setup_status`',
    `\`${PROCESS_DOC_RELATIVE_PATH}\``,
    `\`${AGENTS_SOURCE_DIRECTORY}/\``,
    `Cursor subagent \`${maintainerAgent}\``,
    `Cursor subagent \`${engineerAgent}\``,
    `\`${agentRootDisplay}/${maintainerAgent}.md\``,
    `\`${agentRootDisplay}/${engineerAgent}.md\``,
    'Create or refine the durable task record before any implementation.',
    'keep coordinator edits bounded',
    'real Cursor subagent delegation',
    'bounded fallback reason',
    'role.invoked',
    'references/skills/role-delegation/reference.md',
    'references/skills/task-record-contract/reference.md',
    'references/skills/setup-agenticloop/reference.md',
    'references/skills/blocked-state/reference.md',
    'references/backends/README.md',
    'references/backends/files.md',
    'references/backends/github.md',
  ];

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${skillPath.replace(/\\/g, '/')}: skill body is missing required activation text: ${snippet}`);
    }
  }

  const referencesRoot = join(skillDir, 'references', 'skills');
  for (const skillName of CURSOR_REQUIRED_PUBLIC_REFERENCES) {
    const referencePath = join(referencesRoot, skillName, 'reference.md');
    if (!existsSync(referencePath)) {
      errors.push(
        `${label}: required internal reference missing: ${referencePath.replace(/\\/g, '/')}`
      );
    }
  }

  const backendsRoot = join(skillDir, 'references', 'backends');
  for (const backendFile of CURSOR_REQUIRED_BACKEND_REFERENCES) {
    const backendPath = join(backendsRoot, backendFile);
    if (!existsSync(backendPath)) {
      errors.push(
        `${label}: required backend reference missing: ${backendPath.replace(/\\/g, '/')}`
      );
    }
  }

  for (const nestedSkillFile of collectNestedFiles(join(skillDir, 'references'), 'SKILL.md')) {
    errors.push(
      `${label}: internal references must not contain discoverable SKILL.md files: ${nestedSkillFile.replace(/\\/g, '/')}`
    );
  }
}

function validateCursorAgent(config, repoRoot, roleName, agentName, mdPath, errors, agentNames = {}, options = {}) {
  const rootPrefix = options.rootPrefix ?? '.cursor';
  if (!existsSync(mdPath)) {
    errors.push(`Cursor adapter: expected agent file missing: ${mdPath.replace(/\\/g, '/')}`);
    return;
  }

  let text = '';
  try {
    text = readFileSync(mdPath, 'utf-8');
  } catch (error) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: ${error.message}`);
    return;
  }

  const [frontmatter, body] = parseFrontmatter(text);
  if (frontmatter === null) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: agent frontmatter is required`);
    return;
  }

  const roleRecord = buildRoleRecord(config, repoRoot, roleName);
  const expectedSettings = resolveRoleModel(config, 'cursor', roleName, config.adapters?.cursor ?? {});
  const name = frontmatterString(frontmatter.name);
  const description = frontmatterString(frontmatter.description);
  const model = frontmatterString(frontmatter.model);
  const readonly = frontmatterString(frontmatter.readonly);
  const expectedModel = expectedSettings.model?.trim() ? expectedSettings.model.trim() : 'inherit';

  if (name !== agentName) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: frontmatter name must be '${agentName}'`);
  }
  if (description !== (roleRecord.description ?? '')) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: frontmatter description must match the canonical role description`);
  }
  if (model !== expectedModel) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: model must match adapters.cursor.roleSettings.${roleName}.model or default to 'inherit'`);
  }
  if (readonly !== (roleName === 'orchestrator' ? 'true' : 'false')) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: readonly must be ${roleName === 'orchestrator' ? 'true' : 'false'} for the ${roleName} role`);
  }

  if (frontmatterString(frontmatter.reasoningEffort) || frontmatterString(frontmatter.variant)) {
    errors.push(`${mdPath.replace(/\\/g, '/')}: Cursor agents must not render reasoningEffort or variant frontmatter`);
  }

  const requiredSnippets = [
    `Canonical role source: \`${roleRecord.sourceFile}\`.`,
    'Read `.agenticloop/project.md` before acting',
    `Follow \`${PROCESS_DOC_RELATIVE_PATH}\` as the workflow methodology.`,
  ];

  for (const backendFile of CURSOR_REQUIRED_BACKEND_REFERENCES) {
    requiredSnippets.push(cursorBackendReferenceAbsolutePath(backendFile, rootPrefix));
  }

  for (const skillName of roleRecord.requiredSkills ?? []) {
    requiredSnippets.push(cursorAgentReferenceAbsolutePath(skillName, rootPrefix));
    if (body.includes(`[[${skillName}]]`)) {
      errors.push(
        `${mdPath.replace(/\\/g, '/')}: generated agent contains an unresolved '[[${skillName}]]' marker; Cursor agents must point at the generated reference.md path`
      );
    }
  }

  const canonicalLine = firstSubstantiveLine(roleRecord.promptBody);
  if (canonicalLine) {
    requiredSnippets.push(canonicalLine);
  }

  if (roleName === 'orchestrator') {
    requiredSnippets.push(`Cursor subagent \`${agentNames.maintainer ?? 'maintainer'}\``);
    requiredSnippets.push(`Cursor subagent \`${agentNames.engineer ?? 'engineer'}\``);
    requiredSnippets.push('real Cursor subagent delegation');
    requiredSnippets.push('bounded fallback reason');
    requiredSnippets.push('role.invoked');
    requiredSnippets.push('keep any coordinator-side edits bounded');
  } else if (roleName === 'maintainer') {
    requiredSnippets.push('Stay within maintainer boundaries');
    requiredSnippets.push('Do not implement code changes');
  } else if (roleName === 'engineer') {
    requiredSnippets.push('Stay within engineer boundaries');
    requiredSnippets.push('Do not accept tasks or perform final maintainer review');
  }

  for (const snippet of requiredSnippets) {
    if (!body.includes(snippet)) {
      errors.push(`${mdPath.replace(/\\/g, '/')}: agent body is missing required methodology text: ${snippet}`);
    }
  }
}

function validateCursorPluginDistribution(config, repoRoot, errors, agentNames) {
  const pluginRoot = join(repoRoot, 'plugins', 'agenticloop');
  const pluginPath = join(pluginRoot, '.cursor-plugin', 'plugin.json');
  const pluginCodexPath = join(pluginRoot, '.codex-plugin', 'plugin.json');

  if (config.adapters?.codex?.plugin?.enabled === true && existsSync(pluginCodexPath)) {
    errors.push(
      `Cursor plugin: ${CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH} cannot share plugins/agenticloop/ with generated Codex plugin packaging`
    );
    return;
  }

  if (!existsSync(pluginPath)) {
    errors.push(
      `Cursor plugin: expected plugin root manifest at '${CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH}' when adapters.cursor.plugin.enabled is true`
    );
  } else {
    try {
      const manifest = loadJsonFile(pluginPath);
      if (manifest.name !== 'agenticloop') {
        errors.push(`Cursor plugin: 'name' must be 'agenticloop' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
        errors.push(`Cursor plugin: missing non-empty 'version' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
        errors.push(`Cursor plugin: missing non-empty 'description' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (manifest.skills !== './skills/') {
        errors.push(`Cursor plugin: 'skills' must point to './skills/' in ${pluginPath.replace(/\\/g, '/')}`);
      }
      if (manifest.agents !== './agents/') {
        errors.push(`Cursor plugin: 'agents' must point to './agents/' in ${pluginPath.replace(/\\/g, '/')}`);
      }
    } catch (error) {
      errors.push(`Cursor plugin parse error: ${error.message}`);
    }
  }

  validateCursorPublicSkill(
    join(pluginRoot, 'skills', CURSOR_PUBLIC_SKILL_NAME),
    errors,
    agentNames,
    { label: 'Cursor plugin', agentRootDisplay: 'plugins/agenticloop/agents' }
  );

  for (const roleName of Object.keys(config.roles ?? {})) {
    const agentName = agentNames[roleName] ?? roleName;
    validateCursorAgent(
      config,
      repoRoot,
      roleName,
      agentName,
      join(pluginRoot, 'agents', `${agentName}.md`),
      errors,
      agentNames,
      { rootPrefix: 'plugins/agenticloop' }
    );
  }
}

function validateCursorAdapter(config, repoRoot, errors, warnings) {
  const roleBindings = config.adapters?.cursor?.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(config.roles ?? {}).map(roleName => [
      roleName,
      roleBindings[roleName]?.agent ?? roleName,
    ])
  );
  const agentsDir = join(repoRoot, '.cursor', 'agents');
  const skillDir = join(repoRoot, '.cursor', 'skills', CURSOR_PUBLIC_SKILL_NAME);
  const pluginPath = join(repoRoot, CURSOR_PLUGIN_MANIFEST_RELATIVE_PATH);
  const pluginEnabled = config.adapters?.cursor?.plugin?.enabled === true;

  if (!existsSync(agentsDir)) {
    errors.push(`Cursor adapter: .cursor/agents/ not found; run 'agenticloop generate cursor'`);
  }

  for (const roleName of Object.keys(config.roles ?? {})) {
    const agentName = agentNames[roleName] ?? roleName;
    validateCursorAgent(
      config,
      repoRoot,
      roleName,
      agentName,
      resolveCursorAgentPath(repoRoot, agentName),
      errors,
      agentNames
    );
  }

  validateCursorPublicSkill(skillDir, errors, agentNames);

  if (pluginEnabled || existsSync(pluginPath)) {
    validateCursorPluginDistribution(config, repoRoot, errors, agentNames);
  }
}

// ---------------------------------------------------------------------------
// Role model resolution (adapter-aware + legacy)
// ---------------------------------------------------------------------------

function validateRoleModelResolution(config, errors, warnings = []) {
  const roles = config.roles ?? {};

  for (const [roleName, roleCfg] of Object.entries(roles)) {
    const effort = roleCfg.reasoningEffort ?? roleCfg.variant;
    if (effort !== undefined && typeof effort !== 'string') {
      errors.push(`Role '${roleName}' reasoningEffort/variant must be a string when provided`);
    }
  }

  for (const [host, adapterCfg] of Object.entries(config.adapters ?? {})) {
    const roleSettings = adapterCfg?.roleSettings ?? {};
    for (const [roleName, settings] of Object.entries(roleSettings)) {
      if (!roles[roleName]) {
        errors.push(`adapters.${host}.roleSettings.${roleName} does not match a configured role`);
        continue;
      }
      if (settings?.model !== undefined && typeof settings.model !== 'string') {
        errors.push(`adapters.${host}.roleSettings.${roleName}.model must be a string`);
      } else if (host === 'codex' && isLegacyCodexCliModel(settings?.model)) {
        warnings.push(
          `adapters.codex.roleSettings.${roleName}.model uses legacy 'codex-cli/' prefix; generated Codex TOML will emit '${normalizeCodexModel(settings.model)}'. Update the setting to the bare Codex model id.`
        );
      }
      const effort = settings?.reasoningEffort ?? settings?.variant;
      if (effort !== undefined && typeof effort !== 'string') {
        errors.push(
          `adapters.${host}.roleSettings.${roleName}.reasoningEffort/variant must be a string`
        );
        continue;
      }
      const normalizedEffort = typeof effort === 'string' ? effort.trim() : '';
      if (
        host === 'codex' &&
        normalizedEffort &&
        !CODEX_SUPPORTED_REASONING_EFFORTS.has(normalizedEffort)
      ) {
        errors.push(
          `adapters.codex.roleSettings.${roleName}.reasoningEffort/variant must be one of: ${CODEX_SUPPORTED_REASONING_EFFORTS_DISPLAY}`
        );
      }
    }
  }
}

function validateDocumentRoleRegistry(config, errors) {
  const registry = config.documentRoles;
  const allowedPurposes = new Set(['primary', 'task-source', 'reference']);

  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    errors.push('documentRoles must be a mapping of role names to discovery settings');
    return;
  }

  for (const [roleName, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`documentRoles.${roleName} must be an object`);
      continue;
    }

    if (!allowedPurposes.has(entry.purpose)) {
      errors.push(`documentRoles.${roleName}.purpose must be one of: primary, task-source, reference`);
    }

    if (!Array.isArray(entry.candidates) || entry.candidates.length === 0) {
      errors.push(`documentRoles.${roleName}.candidates must be a non-empty array`);
      continue;
    }

    if (entry.candidates.some(candidate => typeof candidate !== 'string' || candidate.length === 0)) {
      errors.push(`documentRoles.${roleName}.candidates must contain only non-empty strings`);
    }
  }
}
