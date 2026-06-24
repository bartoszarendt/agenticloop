/**
 * Bounded project detection for guided setup.
 *
 * Mirrors the detection behavior described in skills/setup-agenticloop/SKILL.md
 * using the canonical document-role registry from config.json.
 *
 * Never mutates files.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  getDocumentRoleRegistry,
  findFirstExistingDocumentCandidate,
  getDefaultDocumentSelections,
} from './document-roles.js';
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';

/**
 * Detect candidate documents by role for a target directory.
 *
 * @param {string} target  Absolute path to the target directory.
 * @param {object} [config]  Optional config override for document roles.
 * @returns {object} Map of roleName -> { detected, conventional, needsSelection }
 */
export function detectDocumentCandidates(target, config = null) {
  const registry = getDocumentRoleRegistry(config);
  const defaults = getDefaultDocumentSelections(config);
  const results = {};

  for (const [roleName, entry] of Object.entries(registry)) {
    const detected = findFirstExistingDocumentCandidate(target, entry);
    const conventional = defaults[roleName] ?? entry.candidates[0] ?? null;
    const isConventional = detected === conventional;

    results[roleName] = {
      detected,
      conventional,
      isConventional: detected ? isConventional : null,
      needsSelection: detected !== null && !isConventional,
      purpose: entry.purpose,
      candidates: entry.candidates,
    };
  }

  return results;
}

/**
 * Infer grouping profile from detected plan or existing project state.
 *
 * @param {string} target
 * @param {object} [existingConfig]  Existing project map config if available.
 * @returns {{ groupingProfile: string, evidence: string }}
 */
export function inferGroupingProfile(target, existingConfig = null) {
  if (existingConfig?.grouping_profile && existingConfig.grouping_profile !== 'flat') {
    return {
      groupingProfile: existingConfig.grouping_profile,
      evidence: 'existing project map',
    };
  }

  const planFiles = [];
  if (typeof existingConfig?.documents?.plan === 'string' && existingConfig.documents.plan.trim()) {
    planFiles.push(existingConfig.documents.plan.trim());
  }
  const planCandidates = getDocumentRoleRegistry().plan?.candidates ?? [
    'IMPLEMENTATION_PLAN.md',
    'PLAN.md',
    'ROADMAP.md',
    'docs/roadmap.md',
  ];
  planFiles.push(...planCandidates);

  // Check bounded plan candidates for phase/milestone/epic evidence.
  for (const planFile of [...new Set(planFiles)]) {
    const planPath = join(target, planFile);
    if (!existsSync(planPath)) continue;
    try {
      const content = readFileSync(planPath, 'utf-8').slice(0, 8000);
      if (/^#{2,4}\s+Phase\b/im.test(content)) {
        return { groupingProfile: 'phase', evidence: `phase headings in ${planFile}` };
      }
      if (/^#{2,4}\s+Milestone\b/im.test(content)) {
        return { groupingProfile: 'milestone', evidence: `milestone headings in ${planFile}` };
      }
      if (/^#{2,4}\s+Epic\b/im.test(content)) {
        return { groupingProfile: 'epic', evidence: `epic headings in ${planFile}` };
      }
    } catch { /* ignore read errors */ }
  }

  // Check for task files with phase-style IDs
  const tasksDir = join(target, '.agenticloop', 'tasks');
  if (existsSync(tasksDir)) {
    try {
      const entries = readdirSync(tasksDir).filter(e => e.endsWith('.md'));
      if (entries.some(e => /^P\d+-/.test(e.replace('.md', '')))) {
        return { groupingProfile: 'phase', evidence: 'phase-prefixed task files' };
      }
    } catch { /* ignore */ }
  }

  return {
    groupingProfile: 'flat',
    evidence: 'default (no grouping evidence detected)',
  };
}

/**
 * Infer task ID conventions from existing state.
 *
 * @param {string} target
 * @param {object} [existingConfig]  Existing project map config if available.
 * @returns {{ taskIdPattern: string, taskIdRegex: string, evidence: string }}
 */
export function inferTaskIdConventions(target, existingConfig = null) {
  if (existingConfig?.task_id_pattern && existingConfig?.task_id_regex) {
    return {
      taskIdPattern: existingConfig.task_id_pattern,
      taskIdRegex: existingConfig.task_id_regex,
      evidence: 'existing project map',
    };
  }

  const tasksDir = join(target, '.agenticloop', 'tasks');
  if (existsSync(tasksDir)) {
    try {
      const entries = readdirSync(tasksDir).filter(e => e.endsWith('.md'));
      if (entries.length > 0) {
        const name = entries[0].replace('.md', '');
        if (/^T-\d{3,}$/.test(name)) {
          return {
            taskIdPattern: PROJECT_MAP_DEFAULTS.task_id_pattern,
            taskIdRegex: PROJECT_MAP_DEFAULTS.task_id_regex,
            evidence: `existing task files (e.g. ${entries[0]})`,
          };
        }
      }
    } catch { /* ignore */ }
  }

  return {
    taskIdPattern: PROJECT_MAP_DEFAULTS.task_id_pattern,
    taskIdRegex: PROJECT_MAP_DEFAULTS.task_id_regex,
    evidence: 'default',
  };
}

/**
 * Read git remote origin URL cheaply, returning null on failure.
 *
 * @param {string} target
 * @returns {string|null}
 */
function readGitRemoteOrigin(target) {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: target,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Detect bounded backend evidence.
 *
 * @param {string} target
 * @param {object} [existingConfig]  Existing project map config if available.
 * @returns {{ backend: string, confidence: string, evidence: string[] }}
 */
export function detectBackendEvidence(target, existingConfig = null) {
  const evidence = [];

  if (existingConfig?.task_backend) {
    evidence.push(`existing project map: task_backend=${existingConfig.task_backend}`);
    return {
      backend: existingConfig.task_backend,
      confidence: 'high',
      evidence,
    };
  }

  // Legacy agenticloop.json taskBackend
  let legacyBackend = null;
  try {
    const alJsonPath = join(target, 'agenticloop.json');
    if (existsSync(alJsonPath)) {
      const raw = JSON.parse(readFileSync(alJsonPath, 'utf-8'));
      if (raw.taskBackend && (raw.taskBackend === 'files' || raw.taskBackend === 'github')) {
        evidence.push(`legacy agenticloop.json: taskBackend=${raw.taskBackend}`);
        legacyBackend = raw.taskBackend;
      }
    }
  } catch { /* ignore parse errors */ }

  if (legacyBackend) {
    return {
      backend: legacyBackend,
      confidence: 'high',
      evidence,
    };
  }

  const hasLocalTasks = existsSync(join(target, '.agenticloop', 'tasks'));
  if (hasLocalTasks) {
    evidence.push('local .agenticloop/tasks/ present');
  }

  const hasGitDir = existsSync(join(target, '.git'));
  if (hasGitDir) evidence.push('.git directory present');

  // GitHub remote origin
  let githubEvidence = false;
  if (hasGitDir) {
    const remoteUrl = readGitRemoteOrigin(target);
    if (remoteUrl && /github\.com/i.test(remoteUrl)) {
      evidence.push(`git remote origin points to GitHub: ${remoteUrl}`);
      githubEvidence = true;
    }
  }

  // GitHub workflows directory
  if (existsSync(join(target, '.github', 'workflows'))) {
    evidence.push('.github/workflows/ present');
    githubEvidence = true;
  }

  // GitHub issue/PR templates
  if (existsSync(join(target, '.github', 'ISSUE_TEMPLATE'))) {
    evidence.push('.github/ISSUE_TEMPLATE/ present');
    githubEvidence = true;
  }

  // If durable GitHub evidence is strong, propose github but don't force it
  if (githubEvidence && !hasLocalTasks) {
    return {
      backend: 'github',
      confidence: 'medium',
      evidence: evidence.length > 0 ? evidence : ['GitHub evidence detected'],
    };
  }

  return {
    backend: 'files',
    confidence: hasLocalTasks ? 'high' : 'medium',
    evidence: evidence.length > 0 ? evidence : ['no backend evidence found; defaulting to files'],
  };
}

/**
 * Run full bounded project detection.
 *
 * @param {string} target
 * @returns {object} Detection result with documents, grouping, taskId, backend.
 */
export function detectProjectState(target) {
  const projectMapResult = loadProjectMap(target);
  const existingConfig = projectMapResult?.config ?? null;
  const existingRaw = projectMapResult?.raw ?? null;

  const documents = detectDocumentCandidates(target);
  const grouping = inferGroupingProfile(target, existingConfig);
  const taskId = inferTaskIdConventions(target, existingConfig);
  const backend = detectBackendEvidence(target, existingConfig);

  const proposedOverrides = {};
  for (const [roleName, info] of Object.entries(documents)) {
    if (info.needsSelection && info.detected) {
      proposedOverrides[roleName] = info.detected;
    }
  }

  const projectName = detectProjectName(target);

  return {
    projectName,
    documents,
    grouping,
    taskId,
    backend,
    proposedDocumentOverrides: proposedOverrides,
    existingConfig,
    existingRaw,
    hasExistingProjectMap: projectMapResult !== null,
    isConfirmed: existingConfig?.setup_status === 'confirmed',
  };
}

/**
 * Detect a project display name from common sources.
 *
 * @param {string} target
 * @returns {string|null}
 */
function detectProjectName(target) {
  try {
    const pkgPath = join(target, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) return pkg.name;
    }
  } catch { /* ignore */ }

  return null;
}
