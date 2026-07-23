/**
 * Setup-state detection for agenticloop init, setup, status/doctor, and tests.
 *
 * Returns a checklist-style object describing onboarding completeness.
 * Never mutates files.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import {
  hasConfirmedDevelopmentStage,
  loadProjectMap,
  PROJECT_MAP_DEFAULTS,
} from './project-map.js';
import {
  INSTALLED_TOOLKIT_ROOT_DIRECTORY,
  MANIFEST_RELATIVE_PATH,
  PROJECT_MAP_RELATIVE_PATH,
  PROCESS_DOC_RELATIVE_PATH,
  SKILLS_SOURCE_DIRECTORY,
  CONFIG_RELATIVE_PATH,
  TARGET_STATE_DIRECTORY,
  TASKS_DIRECTORY_RELATIVE_PATH,
  DECISIONS_DIRECTORY_RELATIVE_PATH,
  SCRATCH_DIRECTORY_RELATIVE_PATH,
  hasCurrentLayout,
} from './layout.js';
import {
  OPENCODE_AGENT_RELATIVE_PATHS,
  OPENCODE_COMMAND_RELATIVE_PATH,
} from './adapters/opencode.js';
import { generatedCopilotArtifactsPresent } from './adapters/copilot.js';
import { generatedCursorArtifactsPresent } from './adapters/cursor.js';

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

function detectGeneratedArtifacts(target, host) {
  const present = [];
  if (host === 'opencode') {
    for (const relPath of Object.values(OPENCODE_AGENT_RELATIVE_PATHS)) {
      if (existsSync(join(target, relPath))) present.push(relPath);
    }
    if (existsSync(join(target, OPENCODE_COMMAND_RELATIVE_PATH))) {
      present.push(OPENCODE_COMMAND_RELATIVE_PATH);
    }
  }
  if (host === 'codex') {
    if (existsSync(join(target, '.codex', 'agents'))) present.push('.codex/agents/');
    if (existsSync(join(target, '.agents', 'skills', 'agenticloop', 'SKILL.md'))) {
      present.push('.agents/skills/agenticloop/SKILL.md');
    }
    if (existsSync(join(target, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json'))) {
      present.push('plugins/agenticloop/.codex-plugin/plugin.json');
    }
  }
  if (host === 'claude-code') {
    if (existsSync(join(target, '.claude', 'agents'))) present.push('.claude/agents/');
    if (existsSync(join(target, '.claude', 'skills'))) present.push('.claude/skills/');
  }
  if (host === 'copilot') {
    return generatedCopilotArtifactsPresent(target);
  }
  if (host === 'cursor') {
    return generatedCursorArtifactsPresent(target);
  }
  return present;
}

function detectMissingModelRoles(adapterCfg, roles) {
  const rs = adapterCfg?.roleSettings ?? {};
  const configured = new Set(Object.keys(rs).filter(r => rs[r]?.model));
  return roles.filter(role => !configured.has(role));
}

/**
 * Detect the full onboarding state of a target directory.
 *
 * @param {string} target  Absolute path to the target directory.
 * @param {object} [options]
 * @param {boolean} [options.includeValidation=false]  Run lightweight validation checks.
 * @returns {object} Setup state checklist.
 */
export function detectSetupState(target, options = {}) {
  const { includeValidation = false } = options;

  const toolkitInstalled = hasCurrentLayout(target);
  const processDocExists = existsSync(join(target, PROCESS_DOC_RELATIVE_PATH));
  const skillsDirExists = existsSync(join(target, SKILLS_SOURCE_DIRECTORY));
  const configJsonExists = existsSync(join(target, CONFIG_RELATIVE_PATH));
  const manifestExists = existsSync(join(target, MANIFEST_RELATIVE_PATH));

  const projectMapPath = join(target, PROJECT_MAP_RELATIVE_PATH);
  const projectMapExists = existsSync(projectMapPath);

  let projectMap = null;
  let projectMapRaw = null;
  let setupStatus = 'absent';
  let taskBackend = null;
  let groupingProfile = null;
  let developmentStage = null;
  let maxParallelImplementationLanes = null;
  let developmentStageConfirmed = false;

  if (projectMapExists) {
    const loaded = loadProjectMap(target);
    if (loaded) {
      projectMap = loaded.config;
      projectMapRaw = loaded.raw;
      setupStatus = projectMap.setup_status ?? 'unconfirmed';
      taskBackend = projectMap.task_backend ?? 'files';
      groupingProfile = projectMap.grouping_profile ?? 'flat';
      developmentStage = projectMap.development_stage ?? 'unconfirmed';
      maxParallelImplementationLanes = projectMap.max_parallel_implementation_lanes ??
        PROJECT_MAP_DEFAULTS.max_parallel_implementation_lanes;
      developmentStageConfirmed = hasConfirmedDevelopmentStage(projectMap);
    } else {
      setupStatus = 'unconfirmed';
    }
  }

  const stateDirectoryExists = existsSync(join(target, TARGET_STATE_DIRECTORY));
  const tasksDirectoryExists = existsSync(join(target, TASKS_DIRECTORY_RELATIVE_PATH));
  const decisionsDirectoryExists = existsSync(join(target, DECISIONS_DIRECTORY_RELATIVE_PATH));
  const scratchDirectoryExists = existsSync(join(target, SCRATCH_DIRECTORY_RELATIVE_PATH));

  const agenticloopJsonPath = join(target, 'agenticloop.json');
  const agenticloopJsonExists = existsSync(agenticloopJsonPath);

  let alConfig = null;
  let alConfigError = null;
  let roles = [];
  let targetAdapterHosts = new Set();

  if (agenticloopJsonExists) {
    try {
      alConfig = loadAgenticLoopConfig(agenticloopJsonPath);
      roles = Object.keys(alConfig.roles ?? {});
    } catch (e) {
      alConfigError = e.message;
    }

    try {
      const rawConfig = loadJsonFile(agenticloopJsonPath);
      for (const host of Object.keys(rawConfig.adapters ?? {})) {
        targetAdapterHosts.add(host);
      }
    } catch { /* alConfigError already captured above */ }
  }

  const adapters = {};

  // Include adapters explicitly configured in target agenticloop.json
  for (const host of targetAdapterHosts) {
    const adapterCfg = alConfig?.adapters?.[host] ?? {};
    const artifacts = detectGeneratedArtifacts(target, host);
    const missingModelRoles = detectMissingModelRoles(adapterCfg, roles);
    adapters[host] = {
      configured: true,
      artifacts,
      hasArtifacts: artifacts.length > 0,
      missingModelRoles,
      modelsComplete: missingModelRoles.length === 0,
      enabled: adapterCfg?.enabled === true,
      required: adapterCfg?.enabled === true || adapterCfg?.required === true,
    };
  }

  // Include adapters with generated artifacts even if not in target config
  for (const host of IMPLEMENTED_ADAPTERS) {
    if (adapters[host]) continue;
    const artifacts = detectGeneratedArtifacts(target, host);
    if (artifacts.length > 0) {
      const adapterCfg = alConfig?.adapters?.[host] ?? {};
      adapters[host] = {
        configured: false,
        artifacts,
        hasArtifacts: true,
        missingModelRoles: detectMissingModelRoles(adapterCfg, roles),
        modelsComplete: false,
        enabled: false,
        required: false,
      };
    }
  }

  const setupComplete =
    toolkitInstalled &&
    projectMapExists &&
    setupStatus === 'confirmed' &&
    developmentStageConfirmed;

  const checklist = {
    toolkitInstalled,
    processDocExists,
    skillsDirExists,
    configJsonExists,
    manifestExists,
    projectMapExists,
    setupStatus,
    taskBackend,
    groupingProfile,
    developmentStage,
    developmentStageConfirmed,
    maxParallelImplementationLanes,
    stateDirectoryExists,
    tasksDirectoryExists,
    decisionsDirectoryExists,
    scratchDirectoryExists,
    agenticloopJsonExists,
    alConfigError,
    roles,
    adapters,
    setupComplete,
    projectMap,
    projectMapRaw,
  };

  if (includeValidation && alConfig) {
    const validationIssues = [];
    for (const [host, state] of Object.entries(adapters)) {
      if (state.required && !state.hasArtifacts) {
        validationIssues.push(`Required adapter ${host} has no generated artifacts`);
      }
      if ((state.hasArtifacts || state.required) && !state.modelsComplete) {
        validationIssues.push(`Adapter ${host} is missing model settings for: ${state.missingModelRoles.join(', ')}`);
      }
    }
    if (alConfigError) {
      validationIssues.push(`agenticloop.json parse error: ${alConfigError}`);
    }
    checklist.validationIssues = validationIssues;
  }

  return checklist;
}

/**
 * Generate next-step commands based on setup state.
 *
 * @param {object} state  Result from detectSetupState().
 * @returns {string[]} Ordered list of recommended next commands.
 */
export function nextStepsFromState(state) {
  const steps = [];

  if (!state.toolkitInstalled) {
    steps.push('npx agenticloop init');
    return steps;
  }

  if (!state.projectMapExists) {
    steps.push('npx agenticloop init');
    return steps;
  }

  if (state.setupStatus !== 'confirmed' || state.developmentStageConfirmed === false) {
    steps.push('npx agenticloop setup');
    return steps;
  }

  if (!state.agenticloopJsonExists) {
    const adapterHosts = Object.keys(state.adapters);
    if (adapterHosts.length === 0) {
      steps.push('npx agenticloop validate');
      return steps;
    }
  }

  for (const [host, adapterState] of Object.entries(state.adapters)) {
    if (adapterState.required && !adapterState.hasArtifacts) {
      steps.push(`npx agenticloop generate ${host}`);
    }
    if ((adapterState.hasArtifacts || adapterState.required) && !adapterState.modelsComplete) {
      steps.push(`npx agenticloop configure models --adapter ${host}`);
    }
  }

  if (steps.length === 0) {
    steps.push('npx agenticloop validate');
  }

  return steps;
}

/**
 * Format the setup state as a human-readable checklist.
 *
 * @param {object} state  Result from detectSetupState().
 * @returns {string} Formatted checklist text.
 */
export function formatSetupChecklist(state) {
  const lines = [];
  const check = (ok) => ok ? '[x]' : '[ ]';

  lines.push('Setup checklist:');
  lines.push(`  ${check(state.toolkitInstalled)} Toolkit installed (agenticloop/)`);
  lines.push(`  ${check(state.projectMapExists)} Project map (.agenticloop/project.md)`);
  lines.push(`  ${check(state.setupStatus === 'confirmed')} Setup confirmed`);
  if (state.developmentStage) {
    lines.push(`  ${check(state.developmentStageConfirmed)} Development stage: ${state.developmentStage}`);
  }
  if (state.maxParallelImplementationLanes) {
    lines.push(`  ${check(true)} Maximum implementation lanes: ${state.maxParallelImplementationLanes}`);
  }

  if (state.taskBackend) {
    lines.push(`  ${check(true)} Task backend: ${state.taskBackend}`);
  }
  if (state.groupingProfile) {
    lines.push(`  ${check(true)} Grouping: ${state.groupingProfile}`);
  }

  const adapterEntries = Object.entries(state.adapters);
  if (adapterEntries.length > 0) {
    for (const [host, adapterState] of adapterEntries) {
      const flag = adapterState.required ? ' [required]' : '';
      lines.push(`  ${check(adapterState.hasArtifacts)} Adapter ${host}${flag}: ${adapterState.hasArtifacts ? 'artifacts present' : 'no artifacts'}`);
      lines.push(`  ${check(adapterState.modelsComplete)} Adapter ${host} models: ${adapterState.modelsComplete ? 'configured' : `missing ${adapterState.missingModelRoles.join(', ')}`}`);
    }
  } else if (state.agenticloopJsonExists) {
    lines.push('  [ ] No adapters configured');
  }

  return lines.join('\n');
}
