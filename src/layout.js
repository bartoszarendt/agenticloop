import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJsonFile } from './json.js';

export const CURRENT_LAYOUT_VERSION = 3;

export const INSTALLED_TOOLKIT_ROOT_DIRECTORY = 'agenticloop';
export const TARGET_STATE_DIRECTORY = '.agenticloop';

export const PROCESS_DOC_RELATIVE_PATH = 'agenticloop/AGENTIC_LOOP.md';
export const AGENTS_SOURCE_DIRECTORY = 'agenticloop/agents';
export const SKILLS_SOURCE_DIRECTORY = 'agenticloop/skills';
export const BACKENDS_SOURCE_DIRECTORY = 'agenticloop/backends';
export const COMMANDS_SOURCE_DIRECTORY = 'agenticloop/commands';
export const MEMORY_SOURCE_DIRECTORY = 'agenticloop/memory';
export const CONFIG_RELATIVE_PATH = 'agenticloop/config.json';
export const MANIFEST_RELATIVE_PATH = 'agenticloop/manifest.json';
export const TARGET_CONFIG_TEMPLATE_RELATIVE_PATH = 'agenticloop/agenticloop.template.json';

export const MEMORY_SCAFFOLD_RELATIVE_PATH = 'agenticloop/memory/scaffold';
export const PROJECT_SCAFFOLD_RELATIVE_PATH = 'agenticloop/memory/scaffold/project.md';
export const DECISION_RECORD_TEMPLATE_RELATIVE_PATH = 'agenticloop/memory/decision-record.md';
export const TASK_RECORD_TEMPLATE_RELATIVE_PATH = 'agenticloop/memory/task-record.md';
export const WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH = 'agenticloop/memory/work-unit-summary.md';
export const IMPROVEMENT_PROPOSAL_TEMPLATE_RELATIVE_PATH = 'agenticloop/memory/improvement-proposal.md';

export const IMPROVEMENT_PROPOSAL_STATUSES = Object.freeze(['proposed', 'accepted', 'rejected', 'superseded', 'implemented']);
export const IMPROVEMENT_PROPOSAL_RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const IMPROVEMENT_PROPOSAL_TARGET_SURFACES = Object.freeze([
  'skill-trigger',
  'skill-procedure',
  'reviewer-checklist',
  'task-template',
  'event-logging-guidance',
  'adapter-guidance',
  'role-definition',
  'core-methodology',
  'permission-policy',
  'decision-record',
]);
export const IMPROVEMENT_PROPOSAL_SECTION_HEADINGS = Object.freeze([
  '## Failure pattern',
  '## Evidence',
  '## Inferred mechanism',
  '## Proposed change',
  '## Expected behavioral effect',
  '## Regression risks',
  '## Candidate patch',
  '## Validation plan',
  '## Rollback',
]);

// Legacy aliases for migration and compatibility tests
export const IMPLEMENTATION_SUMMARY_TEMPLATE_RELATIVE_PATH = WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH;
export const TRACE_SUMMARY_TEMPLATE_RELATIVE_PATH = WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH;
export const CLOSEOUT_SUMMARY_TEMPLATE_RELATIVE_PATH = WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH;

// Legacy v2 aliases for migration
export const BASE_CONFIG_RELATIVE_PATH = CONFIG_RELATIVE_PATH;
export const V2_BASE_CONFIG_RELATIVE_PATH = 'agenticloop/base.json';
export const V2_TEMPLATES_SOURCE_DIRECTORY = 'agenticloop/templates';

export const PROJECT_MAP_RELATIVE_PATH = '.agenticloop/project.md';
export const TASKS_DIRECTORY_RELATIVE_PATH = '.agenticloop/tasks';
export const DECISIONS_DIRECTORY_RELATIVE_PATH = '.agenticloop/decisions';
export const LOGS_DIRECTORY_RELATIVE_PATH = '.agenticloop/logs';
export const SCRATCH_DIRECTORY_RELATIVE_PATH = '.agenticloop/tmp';
export const LEGACY_SCRATCH_DIRECTORY_RELATIVE_PATH = 'tmp';

export const TOOLKIT_SOURCE_RELATIVE_PATHS = Object.freeze([
  PROCESS_DOC_RELATIVE_PATH,
  AGENTS_SOURCE_DIRECTORY,
  BACKENDS_SOURCE_DIRECTORY,
  SKILLS_SOURCE_DIRECTORY,
  COMMANDS_SOURCE_DIRECTORY,
  MEMORY_SOURCE_DIRECTORY,
  CONFIG_RELATIVE_PATH,
  TARGET_CONFIG_TEMPLATE_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
]);

function normalizeRelativePath(relPath) {
  return String(relPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function toPackageSourcePath(installedRelPath) {
  const normalized = normalizeRelativePath(installedRelPath);
  if (!normalized) {
    return normalized;
  }
  if (normalized === INSTALLED_TOOLKIT_ROOT_DIRECTORY) {
    return '';
  }
  if (normalized.startsWith(`${INSTALLED_TOOLKIT_ROOT_DIRECTORY}/`)) {
    return normalized.slice(INSTALLED_TOOLKIT_ROOT_DIRECTORY.length + 1);
  }
  return normalized;
}

export function toInstalledToolkitPath(packageRelPath) {
  const normalized = normalizeRelativePath(packageRelPath);
  if (!normalized) {
    return INSTALLED_TOOLKIT_ROOT_DIRECTORY;
  }
  if (
    normalized === INSTALLED_TOOLKIT_ROOT_DIRECTORY ||
    normalized.startsWith(`${INSTALLED_TOOLKIT_ROOT_DIRECTORY}/`)
  ) {
    return normalized;
  }
  return `${INSTALLED_TOOLKIT_ROOT_DIRECTORY}/${normalized}`;
}

export const PACKAGE_SOURCE_RELATIVE_PATHS = Object.freeze(
  TOOLKIT_SOURCE_RELATIVE_PATHS.map(toPackageSourcePath)
);

export const TARGET_STATE_RELATIVE_PATHS = Object.freeze([
  PROJECT_MAP_RELATIVE_PATH,
  TASKS_DIRECTORY_RELATIVE_PATH,
  DECISIONS_DIRECTORY_RELATIVE_PATH,
  LOGS_DIRECTORY_RELATIVE_PATH,
  SCRATCH_DIRECTORY_RELATIVE_PATH,
]);

export const GENERATED_SHIM_RELATIVE_PATHS = Object.freeze([
  '.opencode',
  '.codex',
  '.agents',
  '.claude',
  '.github',
  '.cursor',
  'plugins/agenticloop',
]);

export const LEGACY_ROOT_CANONICAL_RELATIVE_PATHS = Object.freeze([
  'AGENTIC_LOOP.md',
  'agents',
  'backends',
  'skills',
  'commands',
  'agenticloop.base.json',
]);

export const LEGACY_CANONICAL_ASSET_MAPPINGS = Object.freeze([
  { legacyPath: 'AGENTIC_LOOP.md', currentPath: PROCESS_DOC_RELATIVE_PATH, kind: 'file' },
  { legacyPath: 'agents', currentPath: AGENTS_SOURCE_DIRECTORY, kind: 'directory' },
  { legacyPath: 'backends', currentPath: BACKENDS_SOURCE_DIRECTORY, kind: 'directory' },
  { legacyPath: 'skills', currentPath: SKILLS_SOURCE_DIRECTORY, kind: 'directory' },
  { legacyPath: 'commands', currentPath: COMMANDS_SOURCE_DIRECTORY, kind: 'directory' },
  { legacyPath: 'agenticloop.base.json', currentPath: CONFIG_RELATIVE_PATH, kind: 'file' },
]);

export const SCRATCH_GITIGNORE_PATTERNS = Object.freeze([
  '.agenticloop/tmp',
  '.agenticloop/tmp/',
  '/.agenticloop/tmp',
  '/.agenticloop/tmp/',
]);

export const LEGACY_SCRATCH_GITIGNORE_PATTERNS = Object.freeze([
  'tmp',
  'tmp/',
  '/tmp',
  '/tmp/',
]);

// Per-lane parallel worktrees live inside the repo root so they stay within the
// host's workspace sandbox and never trigger an external-directory prompt.
export const WORKTREES_DIRECTORY_RELATIVE_PATH = '.agenticloop/worktrees';

export const WORKTREES_GITIGNORE_PATTERNS = Object.freeze([
  '.agenticloop/worktrees',
  '.agenticloop/worktrees/',
  '/.agenticloop/worktrees',
  '/.agenticloop/worktrees/',
]);

export const TASK_REQUIRED_SECTION_HEADINGS = Object.freeze([
  '## Task',
  '## Source Documents Reviewed',
  '## Current State',
  '## Scope',
  '## Out of Scope',
  '## Acceptance Criteria',
  '## Required Checks',
  '## Expected Files or Areas',
  '## Implementation Notes',
  '## Completion Summary Template',
  '## Reviewer Checklist',
]);

export const TASK_OPTIONAL_SECTION_HEADINGS = Object.freeze([
  '## Verification Attempts',
  '## Proof Pressure',
  '## Concurrency Plan',
  '## Parallel Safety',
  '## Grouping',
  '## Source Reference',
  '## Applicable Project Skills',
  '## Outcome',
]);

export const WORK_UNIT_SUMMARY_SECTION_HEADINGS = Object.freeze([
  '## Scope Completed',
  '## Artifacts',
  '## Evidence',
  '## Deviations',
  '## Process Observations',
  '## Known Gaps',
  '## Follow-Ups',
]);

// Task summaries are recorded inline in the task record; `task` is the only
// summary altitude. There is no separate summaries store.
export const WORK_UNIT_SUMMARY_UNITS = Object.freeze([
  'task',
]);

export const WORK_UNIT_SUMMARY_STATUSES = Object.freeze([
  'complete',
  'follow_up_required',
]);

// Legacy aliases for migration and compatibility tests
export const IMPLEMENTATION_SUMMARY_SECTION_HEADINGS = WORK_UNIT_SUMMARY_SECTION_HEADINGS;
export const CLOSEOUT_SUMMARY_SECTION_HEADINGS = WORK_UNIT_SUMMARY_SECTION_HEADINGS;

export const TRACE_SUMMARY_BULLET_LABELS = Object.freeze([
  'Task Record',
  'Backend',
  'Roles Invoked',
  'Artifacts',
  'Checks Run',
  'Decisions',
  'Blockers',
  'Deviations',
  'Follow-Ups',
  'Privacy Notes',
]);

const BUNDLED_MANIFEST_PATH = fileURLToPath(
  new URL(`../${toPackageSourcePath(MANIFEST_RELATIVE_PATH)}`, import.meta.url)
);

export const BUNDLED_CONFIG_PATH = fileURLToPath(
  new URL(`../${toPackageSourcePath(CONFIG_RELATIVE_PATH)}`, import.meta.url)
);
export const BUNDLED_BASE_CONFIG_PATH = BUNDLED_CONFIG_PATH;

export function bundledToolkitPath(relPath) {
  return fileURLToPath(new URL(`../${toPackageSourcePath(relPath)}`, import.meta.url));
}

export function resolveRelativePath(root, relPath) {
  return join(root, relPath);
}

export function loadLayoutManifest(repoRoot) {
  const manifestPath = join(repoRoot, MANIFEST_RELATIVE_PATH);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return loadJsonFile(manifestPath);
}

export function loadBundledLayoutManifest() {
  return loadJsonFile(BUNDLED_MANIFEST_PATH);
}

export function isCurrentLayoutManifest(manifest) {
  return !!manifest && Number(manifest.layoutVersion) === CURRENT_LAYOUT_VERSION;
}

export function hasCurrentLayout(repoRoot) {
  return isCurrentLayoutManifest(loadLayoutManifest(repoRoot));
}

function pathExistsWithType(fullPath, expectedType) {
  if (!existsSync(fullPath)) {
    return false;
  }
  if (!expectedType) {
    return true;
  }
  const stats = statSync(fullPath);
  return expectedType === 'directory' ? stats.isDirectory() : stats.isFile();
}

export function isPackageSourceRepositoryRoot(repoRoot) {
  const packageJsonPath = join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  let packageJson;
  try {
    packageJson = loadJsonFile(packageJsonPath);
  } catch {
    return false;
  }

  if (packageJson?.name !== 'agenticloop') {
    return false;
  }

  const requiredPaths = [
    { relPath: 'bin/agenticloop.js', type: 'file' },
    { relPath: 'src', type: 'directory' },
    { relPath: 'AGENTIC_LOOP.md', type: 'file' },
    { relPath: 'agents', type: 'directory' },
    { relPath: 'backends', type: 'directory' },
    { relPath: 'skills', type: 'directory' },
    { relPath: 'commands', type: 'directory' },
    { relPath: 'memory', type: 'directory' },
    { relPath: 'config.json', type: 'file' },
    { relPath: 'agenticloop.template.json', type: 'file' },
    { relPath: 'manifest.json', type: 'file' },
  ];

  return requiredPaths.every(({ relPath, type }) => pathExistsWithType(join(repoRoot, relPath), type));
}

export function resolveToolkitAssetLayout(repoRoot) {
  let installedManifest = null;
  try {
    installedManifest = loadLayoutManifest(repoRoot);
  } catch {
    installedManifest = null;
  }

  if (isCurrentLayoutManifest(installedManifest)) {
    return {
      kind: 'installed',
      repoRoot,
      assetRoot: join(repoRoot, INSTALLED_TOOLKIT_ROOT_DIRECTORY),
    };
  }

  if (isPackageSourceRepositoryRoot(repoRoot)) {
    return {
      kind: 'package-source',
      repoRoot,
      assetRoot: repoRoot,
    };
  }

  return {
    kind: 'absent',
    repoRoot,
    assetRoot: null,
  };
}

export function resolveToolkitAssetPath(repoRoot, installedRelPath, layout = resolveToolkitAssetLayout(repoRoot)) {
  const relativePath = layout.kind === 'package-source'
    ? toPackageSourcePath(installedRelPath)
    : installedRelPath;
  return join(repoRoot, relativePath);
}

export function describeToolkitAssetPath(installedRelPath, layout) {
  if (layout?.kind === 'package-source') {
    return toPackageSourcePath(installedRelPath);
  }
  return installedRelPath;
}
