/**
 * agenticloop bootstrap-labels - create required GitHub labels in a target repo.
 *
 * Reads standard label definitions from backends.github in agenticloop.json.
 * Creates missing labels idempotently using the gh CLI.
 * Existing labels are reported as ok, not treated as failures.
 *
 * Options:
 *   --repo <owner/repo>    Target GitHub repository (defaults to current repo).
 *   --dry-run              Print gh commands without running them.
 *   --group <id>           Also create a grouping label.
 *   --task-id <id>         Also create a task:<id> label.
 */

import { spawnSync } from 'node:child_process';
import {
  applyTemplate,
  DEFAULT_GROUP_LABEL_TEMPLATES,
  DEFAULT_TASK_LABEL_TEMPLATE,
  resolveGithubLabelNames,
  STANDARD_GITHUB_LABEL_DEFS,
} from './github-backend.js';

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

function ghLabelCreate(name, description, color, repo, dryRun, commandRunner) {
  const args = ['label', 'create', name, '--description', description, '--color', color];
  if (repo) args.push('--repo', repo);

  if (dryRun) {
    console.log(`  [dry-run] gh ${args.join(' ')}`);
    return { action: 'dry-run' };
  }

  const result = commandRunner('gh', args, { encoding: 'utf-8' });
  if (result.status === 0) {
    console.log(`  created: ${name}`);
    return { action: 'created' };
  }

  const stderr = (result.stderr ?? '').trim();
  const stdout = (result.stdout ?? '').trim();
  const launchError = result.error?.message?.trim() ?? '';
  const combined = `${stderr} ${stdout} ${launchError}`.toLowerCase();
  if (
    combined.includes('already exists') ||
    combined.includes('already_exists') ||
    combined.includes('name has already been taken')
  ) {
    console.log(`  existing: ${name}`);
    return { action: 'existing' };
  }

  console.error(`  ERROR creating '${name}': ${stderr || stdout || launchError || `exit ${result.status}`}`);
  return { action: 'error', error: stderr || stdout || launchError };
}

function resolveGroupingConfig(config, projectMap) {
  const groupingProfile = projectMap?.grouping_profile ?? 'flat';
  const groupingProfiles = config?.groupingProfiles ?? {};
  const groupingCfg = groupingProfiles[groupingProfile] ?? {};
  const groupingTerm = projectMap?.grouping_term ?? groupingCfg.groupingTerm ?? 'Group';
  const groupLabelTemplate = config?.backends?.github?.groupLabelTemplate
    ?? groupingCfg.githubLabelTemplate
    ?? DEFAULT_GROUP_LABEL_TEMPLATES[groupingProfile]
    ?? DEFAULT_GROUP_LABEL_TEMPLATES.custom;

  return { groupingProfile, groupingTerm, groupLabelTemplate };
}

/**
 * Bootstrap GitHub labels.
 *
 * @param {object} config       Parsed agenticloop.json (or null for defaults).
 * @param {object} options
 * @param {string}  [options.repo]     Target repo slug owner/repo.
 * @param {boolean} [options.dryRun]   Print commands without running.
 * @param {string}  [options.group]    Group ID to create a grouping label for.
 * @param {string}  [options.taskId]   Task ID to create a task:<id> label for.
 * @param {object}  [options.projectMap] Resolved .agenticloop/project.md config.
 * @returns {{ label: string, action: string }[]}
 */
export function bootstrapLabels(config, options = {}) {
  const {
    repo,
    dryRun = false,
    group,
    taskId,
    projectMap = null,
    commandRunner = defaultCommandRunner,
  } = options;
  const githubConfig = config?.backends?.github ?? {};
  const labelNames = resolveGithubLabelNames(config);
  const taskTemplate = githubConfig.taskLabelTemplate ?? DEFAULT_TASK_LABEL_TEMPLATE;
  const { groupingTerm, groupLabelTemplate } = resolveGroupingConfig(config, projectMap);

  const labels = STANDARD_GITHUB_LABEL_DEFS.map(def => ({
    name: labelNames[def.key],
    description: def.description,
    color: def.color,
  }));

  if (group) {
    const name = applyTemplate(groupLabelTemplate, { groupId: group, group });
    labels.push({
      name,
      description: `Agentic Loop ${groupingTerm} ${group}`,
      color: 'C2E0C6',
    });
  }
  if (taskId) {
    const name = applyTemplate(taskTemplate, { taskId });
    labels.push({
      name,
      description: `Agentic Loop task ${taskId}`,
      color: 'E4E669',
    });
  }

  const results = [];
  for (const label of labels) {
    const outcome = ghLabelCreate(label.name, label.description, label.color, repo, dryRun, commandRunner);
    results.push({ label: label.name, ...outcome });
  }
  return results;
}
