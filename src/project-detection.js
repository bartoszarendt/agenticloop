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
import {
  DEVELOPMENT_STAGES,
  hasConfirmedDevelopmentStage,
  loadProjectMap,
  PROJECT_MAP_DEFAULTS,
} from './project-map.js';

const STAGE_DOCUMENT_ROLES = ['rules', 'overview', 'plan', 'spec', 'design', 'context', 'history'];
const STAGE_DOCUMENT_LIMIT = 8;

const EXPLICIT_STAGE_PATTERNS = [
  {
    stage: 'maintenance',
    pattern: /\b(?:maintenance(?:\s+mode)?|long[- ]term support|LTS|support policy|compatibility policy)\b/i,
    description: 'explicit maintenance, support, or compatibility statement',
  },
  {
    stage: 'stabilization',
    pattern: /\b(?:stabili[sz]ation|feature freeze|release freeze|release candidate|hardening|convergence)\b/i,
    description: 'explicit stabilization or release-freeze statement',
  },
  {
    stage: 'greenfield',
    pattern: /\b(?:greenfield|from scratch|initial (?:implementation|scaffold)|newly created project)\b/i,
    description: 'explicit greenfield or initial-foundation statement',
  },
  {
    stage: 'expansion',
    pattern: /\b(?:capability growth|feature development|expanding (?:the )?(?:product|platform|capability)|roadmap(?:\s+for)?\s+new)\b/i,
    description: 'explicit capability-growth statement',
  },
];

const NEGATED_MAINTENANCE_COMMITMENT = /\b(?:no|without|lacks?|not yet(?:\s+(?:have|having|established))?|does not have|do not have|did not have|has no|have no|had no)\b[^.\n]{0,80}\b(?:maintenance(?:\s+mode)?|long[- ]term support|LTS|support policy|compatibility policy)\b/i;

function signalIsNegated(signal, content) {
  return signal.stage === 'maintenance' && NEGATED_MAINTENANCE_COMMITMENT.test(content);
}

function classifyStageSignal(signal, content) {
  let negated = false;
  const segments = content.split(/(?:\r?\n)+|(?<=[.!?])\s+/);
  for (const segment of segments) {
    if (!signal.pattern.test(segment)) continue;
    if (signalIsNegated(signal, segment)) {
      negated = true;
    } else {
      return { matched: true, negated };
    }
  }
  return { matched: false, negated };
}

function existingStageProposal(existingConfig, existingRaw) {
  const stage = existingRaw?.development_stage;
  if (hasConfirmedDevelopmentStage({
    setup_status: existingConfig?.setup_status,
    development_stage: stage,
  })) {
    return {
      developmentStage: stage.trim(),
      confidence: 'confirmed',
      evidence: ['existing human-confirmed project map'],
      conflicts: [],
      requiresSelection: false,
      rationale: 'Existing human-confirmed development stage is retained until a human changes it.',
    };
  }
  return null;
}

function selectedStageDocuments(target, existingConfig) {
  const registry = getDocumentRoleRegistry();
  const paths = [];
  for (const role of STAGE_DOCUMENT_ROLES) {
    const selected = existingConfig?.documents?.[role];
    const detected = findFirstExistingDocumentCandidate(target, registry[role]);
    const path = typeof selected === 'string' && selected.trim()
      ? selected.trim()
      : detected;
    if (path && !paths.includes(path)) paths.push(path);
    if (paths.length >= STAGE_DOCUMENT_LIMIT) break;
  }
  return paths;
}

function gitTagEvidence(target) {
  try {
    const tags = execSync('git tag --list "v[0-9]*"', {
      cwd: target,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/).filter(Boolean);
    return tags.length > 0 ? `stable release tags detected (${tags.slice(-3).join(', ')})` : null;
  } catch {
    return null;
  }
}

/**
 * Infer a development-stage proposal from a bounded document set. The result
 * is advisory only: setup presents it to a human and never persists it first.
 *
 * @param {string} target
 * @param {object} [existingConfig]
 * @param {object} [existingRaw]
 * @returns {{ developmentStage: string|null, confidence: string, evidence: string[], conflicts: string[], requiresSelection: boolean, rationale: string }}
 */
export function inferDevelopmentStage(target, existingConfig = null, existingRaw = null) {
  const confirmed = existingStageProposal(existingConfig, existingRaw);
  if (confirmed) return confirmed;

  const evidence = [];
  const proposedStages = [];
  const documentText = [];

  for (const relPath of selectedStageDocuments(target, existingConfig)) {
    try {
      const content = readFileSync(join(target, relPath), 'utf-8').slice(0, 12000);
      documentText.push({ relPath, content });
      for (const signal of EXPLICIT_STAGE_PATTERNS) {
        const classification = classifyStageSignal(signal, content);
        if (classification.matched) {
          proposedStages.push(signal.stage);
          evidence.push(`${relPath}: ${signal.description}`);
        } else if (classification.negated) {
          evidence.push(`${relPath}: explicit absence of a maintenance or compatibility commitment`);
        }
      }
    } catch { /* Ignore unreadable bounded candidates. */ }
  }

  const combinedText = documentText.map(entry => entry.content).join('\n');
  const hasCompatibilityCommitment = /\b(?:public API|backward compatibility|compatibility commitment|migration guide|supported format)\b/i.test(combinedText);
  const tagEvidence = gitTagEvidence(target);
  if (tagEvidence) evidence.push(tagEvidence);
  if (hasCompatibilityCommitment) evidence.push('documented public API, format, migration, or compatibility commitment');
  if (tagEvidence && hasCompatibilityCommitment) proposedStages.push('maintenance');

  const hasRoadmapActivity = documentText.some(({ relPath, content }) =>
    /(?:roadmap|changelog|release)/i.test(relPath) && /\b(?:planned|next|upcoming|milestone)\b/i.test(content)
  );
  if (hasRoadmapActivity) {
    evidence.push('bounded roadmap, release, or changelog activity');
    proposedStages.push('expansion');
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf-8'));
    if (typeof packageJson.version === 'string') {
      evidence.push(`supporting metadata: package version ${packageJson.version} (not decisive alone)`);
    }
  } catch { /* Package metadata is optional supporting evidence. */ }

  const distinctStages = [...new Set(proposedStages)];
  if (distinctStages.length > 1) {
    return {
      developmentStage: null,
      confidence: 'low',
      evidence,
      conflicts: distinctStages,
      requiresSelection: true,
      rationale: `Conflicting bounded evidence suggests ${distinctStages.join(', ')}; human selection is required.`,
    };
  }

  if (distinctStages.length === 1) {
    return {
      developmentStage: distinctStages[0],
      confidence: proposedStages.length > 1 ? 'high' : 'medium',
      evidence,
      conflicts: [],
      requiresSelection: false,
      rationale: `Proposal is based on bounded lifecycle evidence for ${distinctStages[0]}.`,
    };
  }

  return {
    developmentStage: 'greenfield',
    confidence: 'low',
    evidence: evidence.length > 0 ? evidence : ['no bounded lifecycle evidence found'],
    conflicts: [],
    requiresSelection: false,
    rationale: 'No decisive lifecycle evidence was found; this is a low-confidence starting proposal for human review.',
  };
}

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

  // GitHub remote, CI workflows, and issue templates are informational
  // evidence only. They never select the GitHub task backend on their own;
  // the GitHub backend requires an explicit human selection during setup.
  if (githubEvidence) {
    evidence.push('GitHub hosting evidence is informational only; the files backend remains the default until a human explicitly selects GitHub');
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
  const stage = inferDevelopmentStage(target, existingConfig, existingRaw);

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
    stage,
    proposedDocumentOverrides: proposedOverrides,
    existingConfig,
    existingRaw,
    hasExistingProjectMap: projectMapResult !== null,
    isConfirmed: existingConfig?.setup_status === 'confirmed',
    hasConfirmedDevelopmentStage: hasConfirmedDevelopmentStage({
      setup_status: existingConfig?.setup_status,
      development_stage: existingRaw?.development_stage,
    }),
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
