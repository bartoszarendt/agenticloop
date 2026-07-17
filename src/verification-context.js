import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';

function taskPathForReference(repoRoot, projectConfig, taskId) {
  const template = String(projectConfig?.task_file_template ?? PROJECT_MAP_DEFAULTS.task_file_template)
    .replace(/\\/g, '/');
  if (!template.includes('{taskId}')) return null;
  const root = resolve(repoRoot);
  const candidate = resolve(root, template.replaceAll('{taskId}', taskId));
  if (candidate !== root && !candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) return null;
  return candidate;
}

/**
 * Build the local reference context shared by task commands and GitHub gates.
 * Callers may pass an already-loaded project map to avoid re-reading it.
 *
 * @param {string} repoRoot
 * @param {{ projectMap?: object|null }} [options]
 */
export function createLocalVerificationContext(repoRoot, options = {}) {
  const projectMap = options.projectMap === undefined ? loadProjectMap(repoRoot) : options.projectMap;
  const projectConfig = projectMap?.config ?? PROJECT_MAP_DEFAULTS;
  const projectFacts = projectMap?.verificationFacts ?? projectConfig?.verificationFacts ?? [];
  return {
    projectFacts,
    decisionExists: decisionId => existsSync(join(repoRoot, '.agenticloop', 'decisions', `${decisionId}.md`)),
    taskExists: taskId => {
      const taskPath = taskPathForReference(repoRoot, projectConfig, taskId);
      return Boolean(taskPath && existsSync(taskPath));
    },
  };
}
