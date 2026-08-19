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
export const FILES_TASK_CONTRACT_HISTORY_DIRECTORY = '.agenticloop/task-contract-history';
export const AUDIT_RECORD_TEMPLATE_RELATIVE_PATH = 'agenticloop/memory/audit-record.md';
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
// Work-unit audit certificates. A separate, backend-neutral, target-owned store
// that holds certification state and append-only Auditor report history. It is
// not a task-record projection and does not reintroduce the removed summaries
// store: per-task completion summaries stay inline in the task record.
export const AUDITS_DIRECTORY_RELATIVE_PATH = '.agenticloop/audits';
// Improvement proposals. Target-owned durable state created on first proposal;
// a serious required-gate incident may create one proposal without waiting for
// repeated friction. Proposals never mutate their target surface.
export const IMPROVEMENTS_DIRECTORY_RELATIVE_PATH = '.agenticloop/improvements';
export const LOGS_DIRECTORY_RELATIVE_PATH = '.agenticloop/logs';
/**
 * Committed execution evidence for required checks.
 *
 * Proof that a required check actually ran belongs to the repository, not to
 * the machine that ran it. The field cohort wrote every execution artifact into
 * `.agenticloop/tmp/`, which the target gitignores, so the artifact a reviewer
 * was pointed at existed on exactly one laptop and on no other checkout - and
 * every later attempt rebuilt identical proof it could not see. This root is
 * tracked, so a check's evidence survives the checkout that produced it.
 */
export const CHECK_EVIDENCE_DIRECTORY_RELATIVE_PATH = '.agenticloop/checks';
/**
 * Durable prior-gate receipt for the last lifecycle mutation (init, setup,
 * update). It lives in the existing target-owned workflow-state directory so
 * the next authoritative readiness edge can verify prior-gate state without a
 * parallel setup-state system.
 */
export const LIFECYCLE_RECEIPT_RELATIVE_PATH = '.agenticloop/lifecycle-receipt.json';
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
  AUDITS_DIRECTORY_RELATIVE_PATH,
  IMPROVEMENTS_DIRECTORY_RELATIVE_PATH,
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

/**
 * Durable activation grants and task bindings.
 *
 * These are evidence dispatch consumes later, so they are not scratch and never
 * live under `.agenticloop/tmp/`. They are still *operator* state rather than
 * project history: short-lived, machine-local, and authenticated at use time
 * against a key held outside the repository. Committing expiring signed records
 * would add noise and no authority, so the directory is ignored by default and
 * the dispatch clean gate permits it untracked.
 */
export const ACTIVATIONS_DIRECTORY_RELATIVE_PATH = '.agenticloop/activations';

export const ACTIVATIONS_GITIGNORE_PATTERNS = Object.freeze([
  '.agenticloop/activations',
  '.agenticloop/activations/',
  '/.agenticloop/activations',
  '/.agenticloop/activations/',
]);

export const RETURN_VERIFICATIONS_DIRECTORY_RELATIVE_PATH = '.agenticloop/returns/verifications';
export const RETURN_VERIFICATIONS_GITIGNORE_PATTERNS = Object.freeze([
  '.agenticloop/returns/verifications',
  '.agenticloop/returns/verifications/',
  '/.agenticloop/returns/verifications',
  '/.agenticloop/returns/verifications/',
]);
export const CLOSEOUT_WAIVERS_DIRECTORY_RELATIVE_PATH = '.agenticloop/closeout-waivers';
export const CLOSEOUT_WAIVERS_GITIGNORE_PATTERNS = Object.freeze([
  '.agenticloop/closeout-waivers', '.agenticloop/closeout-waivers/',
  '/.agenticloop/closeout-waivers', '/.agenticloop/closeout-waivers/',
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

// ---------------------------------------------------------------------------
// Work-unit audit certificates (.agenticloop/audits/)
// ---------------------------------------------------------------------------

export const AUDIT_RECORD_ID_PATTERN = /^AUD-\d{3,}$/;

export const AUDIT_REQUIRED_SECTION_HEADINGS = Object.freeze([
  '## Work Unit Goal',
  '## Completion Oracle',
  '## Covered Tasks',
  '## Frozen Baseline',
  '## Evidence Available',
  '## Accepted Decisions',
  '## Known Limitations',
  '## Audit History',
  '## Consolidated Findings',
  '## Finding Dispositions',
  '## Remediation Tasks',
  '## Final Certification',
  '## Comments',
]);

// Legacy (audit_schema_version absent or 1) records predate typed finding
// dispositions; the section is required only for current-schema records.
export const LEGACY_AUDIT_REQUIRED_SECTION_HEADINGS = Object.freeze(
  AUDIT_REQUIRED_SECTION_HEADINGS.filter(heading => heading !== '## Finding Dispositions')
);

// The lifecycle state of the certificate itself. Distinct from the Auditor's
// verdict: `blocked` is a workflow state the budget rule sets, never a verdict
// the Auditor produced.
export const AUDIT_STATES = Object.freeze([
  'active',
  'awaiting_human',
  'certified',
  'blocked',
]);

// Actual Auditor verdicts. Nothing else may be written to `latest_verdict`.
export const AUDIT_VERDICTS = Object.freeze([
  'certified',
  'certified_with_accepted_limitations',
  'needs_remediation',
  'needs_human_decision',
]);

export const CERTIFYING_AUDIT_VERDICTS = Object.freeze([
  'certified',
  'certified_with_accepted_limitations',
]);

export const AUDIT_FINDING_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

// Reuses the delegation vocabulary minus the same-session fallback. An Auditor
// that never left the calling session is not an independent audit.
export const AUDIT_INVOCATION_MODES = Object.freeze([
  'host_subagent',
  'explicit_agent_invocation',
]);

export const AUDIT_BLOCKED_REASON_BUDGET_EXHAUSTED = 'audit_budget_exhausted';

// Current audit-record shape. Version 3 adds the observed Auditor-return
// assurance and the explicit producer-authentication boolean to every run.
// Prior records remain parseable but require the explicit canonicalization
// route before they can satisfy current closeout.
export const AUDIT_SCHEMA_VERSION = 3;
export const LEGACY_AUDIT_SCHEMA_VERSION = 1;
export const PRIOR_AUDIT_SCHEMA_VERSIONS = Object.freeze([1, 2]);

// Versioned Auditor report wire format (auditor -> CLI). One schema is emitted
// by the Auditor role and consumed by `audit report --file|--stdin` without
// substantive rewriting.
export const AUDIT_REPORT_SCHEMA_VERSION = 'auditor_report_v1';
// Legacy inline `--finding-json` ingestion remains accepted during the
// compatibility period and is recorded under this explicit version label. It
// never fabricates six perspective bodies and never claims lossless provenance.
export const LEGACY_INLINE_REPORT_VERSION = 'legacy_inline_v1';

// The six audit perspectives. One Auditor covers all six in one execution; the
// wire format and durable history keep every perspective body.
export const AUDIT_PERSPECTIVES = Object.freeze([
  'outcome',
  'completeness',
  'integration_coherence',
  'engineering_quality',
  'verification',
  'risk',
]);

// Typed finding dispositions. A disposition never changes blocking status,
// never certifies the work unit, and never consumes audit_budget.
export const AUDIT_DISPOSITION_TYPES = Object.freeze([
  'remediation_task',
  'change_request',
  'human_decision',
  'accepted_limitation',
  'follow_up',
  'rejected_with_counter_evidence',
  'no_action',
]);

// Terminal closeout marker model. The first compatibility line stays
// `AGENT_CLOSEOUT_STATUS: <status>`; current markers add schema and
// provenance lines and are the only markers treated as valid completion.
export const CLOSEOUT_MARKER_STATUSES = Object.freeze([
  'complete',
  'follow_up_required',
  'needs_context',
  'blocked',
]);
export const CLOSEOUT_MARKER_SCHEMA_VERSION = 2;
export const CLOSEOUT_PACKET_SCHEMA_VERSION = 2;

// Workflow defaults are centralized here so task validation, GitHub preflight,
// telemetry, and record creation cannot drift from one another.
export const DEFAULT_ATTEMPT_BUDGET = 5;
export const DEFAULT_REVIEW_BUDGET = 5;
export const DEFAULT_AUDIT_BUDGET = 3;

export const WORK_UNIT_AUDIT_MODES = Object.freeze(['enabled', 'disabled']);
export const DEFAULT_WORK_UNIT_AUDIT_MODE = 'enabled';

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
