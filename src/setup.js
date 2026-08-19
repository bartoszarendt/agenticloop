/**
 * agenticloop setup - guided onboarding for new target projects.
 *
 * Flow: Detect -> Review -> Choose -> Plan -> Apply -> Verify.
 *
 * Detection and model discovery are read-only. No file is created or changed
 * before the final apply confirmation. Setup always composes the idempotent
 * init plan (repair-aware for empty, current, legacy, partial, and
 * inverse-partial targets), renders one complete plan, asks once, applies
 * through the generic lifecycle transaction, and offers validation.
 * Resumable and safe to rerun: a second run produces zero mutations.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIo } from './cli-io.js';
import {
  applyLifecyclePlan,
  formatPartialApplyDiagnostics,
  lifecyclePlanBlockers,
  lifecyclePlanCounts,
  lifecycleMutationReceipt,
  lifecyclePlanToJson,
  renderLifecyclePlan,
} from './lifecycle-plan.js';
import { atomicWriteFile } from './fs-mutation-kernel.js';
import { planSetup } from './setup-plan.js';
import { initExecHandler } from './init.js';
import { detectSetupState, formatSetupChecklist, nextStepsFromState } from './setup-state.js';
import { detectProjectState } from './project-detection.js';
import { DEVELOPMENT_STAGES, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { loadAgenticLoopConfig } from './json.js';
import {
  promptModelSettingsInteractive,
  validateHost,
} from './configure-models.js';
import { parseFrontmatter } from './frontmatter.js';
import { checkGuidance, executeGuidanceLifecycleAction, loadGuidanceAlConfig } from './guidance.js';
import {
  PROJECT_MAP_RELATIVE_PATH,
  CONFIG_RELATIVE_PATH,
  bundledToolkitPath,
  hasCurrentLayout,
} from './layout.js';
import { runValidation } from './validate-runner.js';
import {
  isValidTaskId,
  taskIdRegexError,
} from './task-id.js';
import { WORKFLOW_ROLE_IDS } from './workflow-roles.js';

const VALID_ADAPTER_HOSTS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
const DEVELOPMENT_STAGE_DESCRIPTIONS = {
  greenfield: 'establish a coherent foundation',
  expansion: 'grow capability without fragmentation',
  stabilization: 'converge and harden behavior',
  maintenance: 'preserve compatibility and operational safety',
};

function formatHostChoices(detectedHosts) {
  const lines = [];
  for (let i = 0; i < VALID_ADAPTER_HOSTS.length; i++) {
    const host = VALID_ADAPTER_HOSTS[i];
    const detected = detectedHosts.includes(host) ? ' (detected)' : '';
    lines.push(`  ${i + 1}. ${host}${detected}`);
  }
  return lines.join('\n');
}

function formatDocumentDetection(documents) {
  const lines = [];
  for (const [role, info] of Object.entries(documents)) {
    if (!info.detected) continue;
    const note = info.isConventional ? '(conventional)' : '(selection recommended)';
    lines.push(`  ${role}: ${info.detected}  ${note}`);
  }
  return lines;
}

function buildProjectMapFrontmatter(values) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(values)) {
    if (key === 'documents' && typeof val === 'object') {
      lines.push('documents:');
      for (const [docRole, docPath] of Object.entries(val)) {
        lines.push(`  ${docRole}: "${docPath}"`);
      }
    } else if (typeof val === 'boolean' || typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function printProjectMapValues(write, heading, values) {
  write(`\n${heading}`);
  for (const [key, val] of Object.entries(values)) {
    if (key === 'documents' && typeof val === 'object') {
      for (const [docRole, docPath] of Object.entries(val)) {
        write(`  documents.${docRole}: "${docPath}"`);
      }
    } else {
      write(`  ${key}: ${JSON.stringify(val)}`);
    }
  }
}

function isValidStage(value) {
  return DEVELOPMENT_STAGES.includes(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function formatDevelopmentStageChoices() {
  return DEVELOPMENT_STAGES.map((stage, index) =>
    `    ${index + 1}. ${stage} - ${DEVELOPMENT_STAGE_DESCRIPTIONS[stage]}`
  ).join('\n');
}

function resolveDevelopmentStageChoice(answer) {
  if (isValidStage(answer)) return answer;
  if (!/^\d+$/.test(answer)) return null;
  return DEVELOPMENT_STAGES[Number(answer) - 1] ?? null;
}

const TASK_BACKEND_CHOICES = [
  { index: 1, label: 'Files - local task records (default)', value: 'files' },
  { index: 2, label: 'GitHub - issues, labels, comments, and PR coordination', value: 'github' },
];
const EVENT_LOGGING_CHOICES = [
  { index: 1, label: 'Disabled - do not record workflow events (default)', value: 'disabled' },
  { index: 2, label: 'Enabled - write local task-scoped JSONL logs under .agenticloop/logs/', value: 'enabled' },
];
const TASK_ID_PRESETS = [
  {
    key: 'neutral',
    example: 'T-001',
    label: 'T-001 - neutral sequential IDs (recommended; automatic allocation)',
    pattern: 'T-<number>',
    regex: '^T-\\d{3,}$',
  },
  {
    key: 'readable',
    example: 'TASK-001',
    label: 'TASK-001 - explicit neutral sequential IDs (manual --id)',
    pattern: 'TASK-<number>',
    regex: '^TASK-\\d{3,}$',
  },
  {
    key: 'phase',
    example: 'P1-01',
    label: 'P1-01 - phase-scoped sequential IDs (manual --id)',
    pattern: 'P<phase>-<number>',
    regex: '^P\\d+-\\d{2,}$',
    groupingProfile: 'phase',
  },
];

function isValidBackend(value) {
  return value === 'files' || value === 'github';
}

function formatTaskBackendChoices() {
  return TASK_BACKEND_CHOICES.map(choice => `    ${choice.index}. ${choice.label}`).join('\n');
}

function resolveTaskBackendChoice(answer) {
  const normalized = answer.trim().toLowerCase();
  if (normalized === '1' || normalized === 'files') return 'files';
  if (normalized === '2' || normalized === 'github') return 'github';
  return null;
}

async function promptTaskBackend(prompts, write, currentValue) {
  const hasCurrent = isValidBackend(currentValue);
  const defaultChoice = hasCurrent
    ? TASK_BACKEND_CHOICES.find(choice => choice.value === currentValue).index
    : 1;
  while (true) {
    const answer = (await prompts.ask(
      `  Task backend:\n${formatTaskBackendChoices()}\n  Choice [${defaultChoice}]: `
    )).trim();
    if (!answer) {
      return { value: hasCurrent ? currentValue : 'files', cancelled: false };
    }
    const selected = resolveTaskBackendChoice(answer);
    if (selected) {
      return { value: selected, cancelled: false };
    }
    write(`  Invalid task backend '${answer}'. Enter 1 (files) or 2 (github).`);
  }
}

function taskIdChoices(currentPattern, currentRegex, groupingProfile) {
  const presets = TASK_ID_PRESETS.filter(
    preset => !preset.groupingProfile || preset.groupingProfile === groupingProfile
  );
  const currentPresetIndex = presets.findIndex(
    preset => preset.pattern === currentPattern && preset.regex === currentRegex
  );
  const choices = presets.map(preset => ({ ...preset, kind: 'preset' }));
  let defaultChoice = currentPresetIndex + 1;

  if (
    currentPresetIndex === -1 &&
    currentPattern &&
    currentRegex &&
    !customTaskIdPatternError(currentPattern) &&
    !taskIdRegexError(currentRegex)
  ) {
    choices.unshift({
      kind: 'current',
      key: 'current',
      label: `${currentPattern} - keep existing custom convention`,
      pattern: currentPattern,
      regex: currentRegex,
      example: null,
    });
    defaultChoice = 1;
  }

  choices.push({
    kind: 'custom',
    key: 'custom',
    label: 'Custom - advanced anchored regular expression (manual --id)',
  });
  if (defaultChoice < 1) defaultChoice = 1;
  return { choices, defaultChoice };
}

function resolveTaskIdChoice(answer, choices) {
  const normalized = answer.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    return choices[Number(normalized) - 1] ?? null;
  }
  return choices.find(choice =>
    choice.key === normalized ||
    String(choice.example ?? '').toLowerCase() === normalized
  ) ?? null;
}

function customTaskIdPatternError(pattern) {
  if (!pattern) return 'Custom task ID pattern is required.';
  if (pattern.length > 80) return 'Custom task ID pattern must be at most 80 characters.';
  if (/[\r\n"'`]/.test(pattern)) {
    return 'Custom task ID pattern must not contain quote, backtick, or newline characters.';
  }
  return null;
}

async function promptCustomTaskIdConvention(prompts, write) {
  let pattern;
  while (true) {
    pattern = (await prompts.ask(
      '  Custom task ID display pattern (for example PROJ-<number>): '
    )).trim();
    if (!pattern) {
      write('  Custom task ID configuration cancelled; a display pattern is required.');
      return { cancelled: true };
    }
    const patternError = customTaskIdPatternError(pattern);
    if (!patternError) break;
    write(`  ${patternError}`);
  }

  let regex;
  while (true) {
    regex = (await prompts.ask(
      '  Custom task ID regex (anchored with ^ and $, for example ^PROJ-\\d{3,}$): '
    )).trim();
    if (!regex) {
      write('  Custom task ID configuration cancelled; a regex is required.');
      return { cancelled: true };
    }
    const regexError = taskIdRegexError(regex);
    if (!regexError) break;
    write(`  Invalid custom task ID regex: ${regexError}.`);
  }

  while (true) {
    const example = (await prompts.ask('  Example task ID that must match the custom regex: ')).trim();
    if (!example) {
      write('  Custom task ID configuration cancelled; a matching example is required.');
      return { cancelled: true };
    }
    if (isValidTaskId(example, regex)) {
      return {
        cancelled: false,
        value: {
          task_id_pattern: pattern,
          task_id_regex: regex,
        },
      };
    }
    write(`  Example task ID '${example}' is unsafe or does not match '${regex}'.`);
  }
}

async function promptTaskIdConvention(
  prompts,
  write,
  currentPattern,
  currentRegex,
  groupingProfile
) {
  const { choices, defaultChoice } = taskIdChoices(
    currentPattern,
    currentRegex,
    groupingProfile
  );
  const menu = choices.map((choice, index) => `    ${index + 1}. ${choice.label}`).join('\n');

  while (true) {
    const answer = (await prompts.ask(
      `  Task ID convention:\n${menu}\n  Choice [${defaultChoice}]: `
    )).trim();
    const selected = answer
      ? resolveTaskIdChoice(answer, choices)
      : choices[defaultChoice - 1];
    if (!selected) {
      write(`  Invalid task ID convention '${answer}'. Enter 1-${choices.length}.`);
      continue;
    }
    if (selected.kind === 'custom') {
      return promptCustomTaskIdConvention(prompts, write);
    }
    return {
      cancelled: false,
      value: {
        task_id_pattern: selected.pattern,
        task_id_regex: selected.regex,
      },
    };
  }
}

function isValidEventLogging(value) {
  return value === 'disabled' || value === 'enabled';
}

function formatEventLoggingChoices() {
  return EVENT_LOGGING_CHOICES.map(choice => `    ${choice.index}. ${choice.label}`).join('\n');
}

function resolveEventLoggingChoice(answer) {
  const normalized = answer.trim().toLowerCase();
  if (normalized === '1' || normalized === 'disabled') return 'disabled';
  if (normalized === '2' || normalized === 'enabled') return 'enabled';
  return null;
}

async function promptEventLogging(prompts, write, currentValue) {
  const hasCurrent = isValidEventLogging(currentValue);
  const defaultChoice = hasCurrent
    ? EVENT_LOGGING_CHOICES.find(choice => choice.value === currentValue).index
    : 1;
  while (true) {
    const answer = (await prompts.ask(
      `  Event logging:\n${formatEventLoggingChoices()}\n  Choice [${defaultChoice}]: `
    )).trim();
    if (!answer) {
      return hasCurrent ? currentValue : 'disabled';
    }
    const selected = resolveEventLoggingChoice(answer);
    if (selected) return selected;
    write(`  Invalid event logging choice '${answer}'. Enter 1 (disabled) or 2 (enabled).`);
  }
}

async function promptValidStage(prompts, write, currentValue) {
  let rejectedInput = false;
  while (true) {
    const hasDefault = isValidStage(currentValue);
    const promptLabel = hasDefault
      ? `  Choice (default: ${currentValue}; Enter to keep): `
      : '  Choice (required): ';
    const answer = (await prompts.ask(
      `  Select development stage:\n${formatDevelopmentStageChoices()}\n${promptLabel}`
    )).trim();
    if (!answer) {
      if (!rejectedInput && hasDefault) {
        return { value: currentValue, cancelled: false };
      }
      write('  Development-stage selection cancelled; enter a choice number or exact stage name to continue.');
      return { value: currentValue, cancelled: true };
    }
    const selectedStage = resolveDevelopmentStageChoice(answer);
    if (selectedStage) {
      return { value: selectedStage, cancelled: false };
    }
    rejectedInput = true;
    write(`  Invalid development stage. Enter 1-${DEVELOPMENT_STAGES.length} or one of: ${DEVELOPMENT_STAGES.join(', ')}.`);
  }
}

async function promptPositiveInteger(prompts, write, label, currentValue) {
  let rejectedInput = false;
  while (true) {
    const answer = (await prompts.ask(`  ${label} (${currentValue}): `)).trim();
    if (!answer) {
      if (!rejectedInput && isPositiveInteger(currentValue)) {
        return { value: currentValue, cancelled: false };
      }
      if (!rejectedInput) {
        rejectedInput = true;
        write(`  ${label} must be a positive integer.`);
        continue;
      }
      write(`  ${label} update cancelled; enter a positive integer to continue.`);
      return { value: currentValue, cancelled: true };
    }
    const value = Number(answer);
    if (isPositiveInteger(value)) return { value, cancelled: false };
    rejectedInput = true;
    write(`  ${label} must be a positive integer.`);
  }
}

/**
 * Host integration choice. "Files only" and "Skip adapter setup" are merged
 * into one explicit "No host integration" choice; invalid input explains the
 * valid choices and reprompts; blank input takes the displayed default.
 */
async function promptAdapterMode(prompts, write, detectedHosts) {
  const choices = [];
  if (detectedHosts.length > 0) {
    choices.push({ value: detectedHosts.length === 1 ? detectedHosts[0] : 'all', label: `${detectedHosts.join(', ')} (detected)` });
  }
  choices.push({ value: 'select', label: 'Another host' });
  if (detectedHosts.length === 0) {
    choices.push({ value: 'all', label: 'All supported hosts' });
  }
  choices.push({ value: null, label: 'No host integration' });
  // Explicit displayed default: the detected host when one exists, otherwise
  // the safe no-integration choice (never a silent adapter branch).
  const defaultChoice = detectedHosts.length > 0 ? 1 : choices.length;

  const menu = choices.map((choice, index) => `  ${index + 1}. ${choice.label}`).join('\n');
  while (true) {
    const answer = (await prompts.ask(`  Host integration:\n${menu}\n  Choice [${defaultChoice}]: `)).trim();
    if (!answer) {
      return choices[defaultChoice - 1].value;
    }
    const num = parseInt(answer, 10);
    if (Number.isInteger(num) && num >= 1 && num <= choices.length) {
      const selected = choices[num - 1].value;
      if (selected !== 'select') return selected;
      write('\nSelect host adapter:');
      write(formatHostChoices(detectedHosts));
      while (true) {
        const hostAnswer = (await prompts.ask('  Choice: ')).trim();
        const hostNum = parseInt(hostAnswer, 10);
        if (Number.isInteger(hostNum) && hostNum >= 1 && hostNum <= VALID_ADAPTER_HOSTS.length) {
          return VALID_ADAPTER_HOSTS[hostNum - 1];
        }
        if (VALID_ADAPTER_HOSTS.includes(hostAnswer)) {
          return hostAnswer;
        }
        write(`  Invalid host '${hostAnswer}'. Enter 1-${VALID_ADAPTER_HOSTS.length} or one of: ${VALID_ADAPTER_HOSTS.join(', ')}.`);
      }
    }
    write(`  Invalid choice '${answer}'. Enter 1-${choices.length} (default: ${defaultChoice}).`);
  }
}

function mergeProjectMapFrontmatter(existingContent, newValues) {
  const [existingFm, body] = parseFrontmatter(existingContent);
  const merged = { ...(existingFm ?? {}), ...newValues };

  if (newValues.documents && existingFm?.documents) {
    merged.documents = { ...existingFm.documents, ...newValues.documents };
  }

  return buildProjectMapFrontmatter(merged) + '\n' + body;
}

/** Execute lifecycle exec descriptors owned by setup. */
function setupExecHandler(action, target) {
  if (action.exec?.type === 'rename') {
    return initExecHandler(action, target);
  }
  if (action.exec?.type === 'project-map') {
    const projectMapPath = join(target, PROJECT_MAP_RELATIVE_PATH);
    if (!existsSync(projectMapPath)) {
      return {
        ok: false,
        rolledBack: true,
        errors: ['.agenticloop/project.md not found. Run agenticloop init first.'],
      };
    }
    try {
      const existing = readFileSync(projectMapPath, 'utf-8');
      atomicWriteFile(projectMapPath, mergeProjectMapFrontmatter(existing, action.exec.values));
      return { ok: true, changed: true, display: action.display };
    } catch (error) {
      return {
        ok: false,
        rolledBack: true,
        errors: [`${PROJECT_MAP_RELATIVE_PATH}: ${error.message}`],
      };
    }
  }
  if (action.exec?.type === 'guidance') {
    return executeGuidanceLifecycleAction(action, target);
  }
  return {
    ok: false,
    rolledBack: true,
    errors: [`setup cannot execute '${action.exec?.type}' for ${action.path}`],
  };
}

function loadBundledCanonicalConfig() {
  try {
    return loadAgenticLoopConfig(bundledToolkitPath(CONFIG_RELATIVE_PATH));
  } catch {
    return null;
  }
}

function stepHeader(write, step, label) {
  write('');
  write(`  ${step}/6 ${label}`);
}

/**
 * Run guided setup.
 *
 * @param {object} options
 * @param {string} options.target  Target directory.
 * @param {string} [options.adapter]  Preselected adapter host.
 * @param {boolean} [options.nonInteractive=false]  Fail if interaction needed.
 * @param {'disabled'|'enabled'} [options.eventLogging]  Explicit event-logging choice.
 * @param {object} [options.io]  Injected I/O context (prompts, capabilities, signal).
 * @param {NodeJS.ReadableStream} [options.input]  Legacy alias folded into io.
 * @param {NodeJS.WritableStream} [options.output]  Legacy alias folded into io.
 * @param {boolean} [options.dryRun=false]  Render the plan; perform zero writes.
 * @param {boolean} [options.json=false]  Non-interactive versioned JSON plan on stdout.
 * @param {boolean} [options.verbose=false]  Show individual paths and evidence.
 * @returns {Promise<{errors: string[], warnings: string[], plan?: object}>}
 */
export async function setup(options) {
  const {
    target,
    adapter: preselectedAdapter,
    nonInteractive = false,
    eventLogging: preselectedEventLogging,
    agentsGuidance = true,
    io: injectedIo = null,
    input = null,
    output = null,
    dryRun = false,
    json = false,
    verbose = false,
  } = options;

  const io = injectedIo ?? createIo({
    stdin: input ?? undefined,
    stdout: output ?? undefined,
  });
  const errors = [];
  const warnings = [];

  // --json is a machine-readable plan contract: non-interactive, zero writes,
  // and stdout carries exactly one versioned document. All human-readable
  // progress and diagnostics route to stderr in JSON mode.
  const jsonMode = Boolean(json);
  const effectiveDryRun = dryRun || jsonMode;
  const effectiveNonInteractive = nonInteractive || jsonMode;
  const write = jsonMode ? (msg) => io.err(msg) : (msg) => io.out(msg);

  if (preselectedEventLogging !== undefined && !isValidEventLogging(preselectedEventLogging)) {
    errors.push(
      `Invalid --event-logging value '${preselectedEventLogging}'. Use enabled or disabled.`
    );
    return { errors, warnings };
  }

  // Capture this before setup scaffolds anything. A repeat setup must not turn
  // an installed target that opted out into a guidance-enrolled target.
  const installationExisted = hasCurrentLayout(target) ||
    existsSync(join(target, PROJECT_MAP_RELATIVE_PATH)) ||
    existsSync(join(target, '.agenticloop', 'generated-artifacts.json'));

  if (effectiveNonInteractive && !preselectedAdapter) {
    errors.push('Non-interactive setup requires --adapter <host>.');
    return { errors, warnings };
  }

  const prompts = effectiveNonInteractive ? null : io.createPrompts();

  try {
    io.throwIfAborted();

    // Step 1: Detect (read-only).
    stepHeader(write, 1, 'Detect');
    const detection = detectProjectState(target);
    const detectedDocuments = formatDocumentDetection(detection.documents)
      .map(line => line.trim().replace(/^(\w+): /, '$1: '));
    const stageLabel = detection.stage.developmentStage ?? 'selection required';
    write(`  Stage       ${stageLabel} (${detection.stage.confidence} confidence)`);
    write(`  Backend     ${detection.backend.backend}`);
    if (detectedDocuments.length > 0) {
      write(`  Documents   ${detectedDocuments.map(line => line.split(':').slice(1).join(':').trim().replace(/  .*$/, '')).join(', ')}`);
    }
    if (verbose) {
      const docLines = formatDocumentDetection(detection.documents);
      for (const line of docLines) write(line);
      write(`  Grouping: ${detection.grouping.groupingProfile} (${detection.grouping.evidence})`);
      write(`  Task ID: ${detection.taskId.taskIdPattern} (${detection.taskId.evidence})`);
      for (const ev of detection.backend.evidence) write(`  - ${ev}`);
      write(`  ${detection.stage.rationale}`);
      for (const evidence of detection.stage.evidence) write(`  - ${evidence}`);
      if (detection.stage.conflicts.length > 0) {
        write(`  Conflicting stage evidence: ${detection.stage.conflicts.join(', ')}`);
      }
    }

    // Step 2: Review (collect human-confirmed profile values; no writes).
    stepHeader(write, 2, 'Review');
    let profileValues = null;
    let profileReason = 'human-confirmed profile values';

    if (detection.isConfirmed && detection.hasConfirmedDevelopmentStage) {
      write('  Project map is already confirmed.');
      if (!effectiveNonInteractive) {
        const updateProfile = (await prompts.ask(
          '  Update project profile (including development stage)? [y/N]: '
        )).trim().toLowerCase();
        if (updateProfile === 'yes' || updateProfile === 'y') {
          const updateValues = {};
          const currentStage = detection.existingConfig.development_stage;
          const stageResult = await promptValidStage(prompts, write, currentStage);
          const lanesResult = stageResult.cancelled
            ? { cancelled: true }
            : await promptPositiveInteger(
                prompts,
                write,
                'Maximum implementation lanes',
                detection.existingConfig.max_parallel_implementation_lanes ??
                  PROJECT_MAP_DEFAULTS.max_parallel_implementation_lanes
              );
          const attemptBudgetResult = lanesResult.cancelled
            ? { cancelled: true }
            : await promptPositiveInteger(
                prompts,
                write,
                'Default equivalent-attempt budget',
                detection.existingConfig.default_attempt_budget ?? PROJECT_MAP_DEFAULTS.default_attempt_budget
              );
          const reviewCheckpointBudgetResult = attemptBudgetResult.cancelled
            ? { cancelled: true }
            : await promptPositiveInteger(
                prompts,
                write,
                'Default review checkpoint budget',
                detection.existingConfig.default_review_budget ?? PROJECT_MAP_DEFAULTS.default_review_budget
              );
          const auditBudgetResult = reviewCheckpointBudgetResult.cancelled
            ? { cancelled: true }
            : await promptPositiveInteger(
                prompts,
                write,
                'Default audit budget',
                detection.existingConfig.default_audit_budget ?? PROJECT_MAP_DEFAULTS.default_audit_budget
              );

          if (stageResult.cancelled || lanesResult.cancelled || attemptBudgetResult.cancelled || reviewCheckpointBudgetResult.cancelled || auditBudgetResult.cancelled) {
            write('  Profile update cancelled; continuing setup without profile changes.');
          } else {
            updateValues.development_stage = stageResult.value;
            updateValues.max_parallel_implementation_lanes = lanesResult.value;
            updateValues.default_attempt_budget = attemptBudgetResult.value;
            updateValues.default_review_budget = reviewCheckpointBudgetResult.value;
            updateValues.default_audit_budget = auditBudgetResult.value;

            const backendResult = await promptTaskBackend(
              prompts,
              write,
              detection.existingConfig.task_backend ?? 'files'
            );
            updateValues.task_backend = backendResult.value;

            const currentRationale = detection.existingRaw?.development_stage_rationale ?? '';
            const rationaleAnswer = (await prompts.ask(`  Development stage rationale (${currentRationale || 'optional'}): `)).trim();
            if (rationaleAnswer) updateValues.development_stage_rationale = rationaleAnswer;
            const currentRevisit = detection.existingRaw?.development_stage_revisit_when ?? '';
            const revisitAnswer = (await prompts.ask(`  Development stage revisit trigger (${currentRevisit || 'optional'}): `)).trim();
            if (revisitAnswer) updateValues.development_stage_revisit_when = revisitAnswer;

            printProjectMapValues(write, 'Proposed profile update values:', updateValues);
            const confirmUpdate = (await prompts.ask('\nConfirm project profile update? (yes/no): ')).trim().toLowerCase();
            if (confirmUpdate !== 'yes' && confirmUpdate !== 'y') {
              write('  Profile update cancelled; continuing setup without profile changes.');
            } else {
              profileValues = updateValues;
              profileReason = 'updated profile values';
            }
          }
        }
      }
    } else if (effectiveNonInteractive) {
      errors.push('Non-interactive setup cannot proceed without a human-confirmed development stage. Run agenticloop setup interactively first.');
      if (!jsonMode) {
        write('\nProject map is unconfirmed or has no human-confirmed development stage. Interactive confirmation required.');
      }
      if (!jsonMode) return { errors, warnings };
      // In JSON mode the blocker rides in the plan document below.
    } else {
      const stageMigration = detection.isConfirmed;
      const confirmValues = stageMigration
        ? {
            development_stage: detection.stage.developmentStage,
            default_attempt_budget: detection.existingConfig?.default_attempt_budget ?? PROJECT_MAP_DEFAULTS.default_attempt_budget,
            default_review_budget: detection.existingConfig?.default_review_budget ?? PROJECT_MAP_DEFAULTS.default_review_budget,
            default_audit_budget: detection.existingConfig?.default_audit_budget ?? PROJECT_MAP_DEFAULTS.default_audit_budget,
            max_parallel_implementation_lanes: detection.existingConfig?.max_parallel_implementation_lanes ??
              PROJECT_MAP_DEFAULTS.max_parallel_implementation_lanes,
          }
        : {
            setup_status: 'confirmed',
            setup_confirmed_at: new Date().toISOString().slice(0, 10),
            setup_confirmed_by: 'human',
            development_stage: detection.stage.developmentStage,
            default_attempt_budget: PROJECT_MAP_DEFAULTS.default_attempt_budget,
            default_review_budget: PROJECT_MAP_DEFAULTS.default_review_budget,
            default_audit_budget: PROJECT_MAP_DEFAULTS.default_audit_budget,
            max_parallel_implementation_lanes: PROJECT_MAP_DEFAULTS.max_parallel_implementation_lanes,
            task_backend: detection.backend.backend,
            task_id_pattern: detection.taskId.taskIdPattern,
            task_id_regex: detection.taskId.taskIdRegex,
            grouping_profile: detection.grouping.groupingProfile,
          };

      if (!stageMigration && Object.keys(detection.proposedDocumentOverrides).length > 0) {
        confirmValues.documents = detection.proposedDocumentOverrides;
      }

      printProjectMapValues(write, stageMigration
        ? 'Proposed development-stage migration values:'
        : 'Proposed project map values:', confirmValues);

      const answer = (await prompts.ask(stageMigration
        ? '\nConfirm development-stage migration? (yes/no/edit): '
        : '\nConfirm project setup? (yes/no/edit): ')).trim().toLowerCase();

      const mustSelectStage = detection.stage.requiresSelection === true ||
        !isValidStage(confirmValues.development_stage);
      const editRequested = answer === 'edit' || answer === 'e' ||
        ((answer === 'yes' || answer === 'y') && mustSelectStage);

      if ((answer === 'yes' || answer === 'y') && mustSelectStage) {
        write('  Conflicting lifecycle evidence requires an explicit development-stage selection.');
      }

      if (answer === 'yes' || answer === 'y') {
        // Confirmed unless conflict handling below requires an explicit selection.
      } else if (!editRequested) {
        write('Setup cancelled. Explicit "yes" or "edit" required to confirm the human-controlled project profile.');
        return { errors, warnings };
      }

      if (editRequested) {
        const stageResult = await promptValidStage(prompts, write, confirmValues.development_stage);
        if (stageResult.cancelled) {
          write('Setup cancelled. Edited project map values were not written.');
          return { errors, warnings };
        }
        confirmValues.development_stage = stageResult.value;

        const lanesResult = await promptPositiveInteger(
          prompts,
          write,
          'Maximum implementation lanes',
          confirmValues.max_parallel_implementation_lanes
        );
        if (lanesResult.cancelled) {
          write('Setup cancelled. Edited project map values were not written.');
          return { errors, warnings };
        }
        confirmValues.max_parallel_implementation_lanes = lanesResult.value;

        const attemptBudgetResult = await promptPositiveInteger(
          prompts,
          write,
          'Default equivalent-attempt budget',
          confirmValues.default_attempt_budget
        );
        if (attemptBudgetResult.cancelled) {
          write('Setup cancelled. Edited project map values were not written.');
          return { errors, warnings };
        }
        confirmValues.default_attempt_budget = attemptBudgetResult.value;

        const reviewBudgetResult = await promptPositiveInteger(
          prompts,
          write,
          'Default review checkpoint budget',
          confirmValues.default_review_budget
        );
        if (reviewBudgetResult.cancelled) {
          write('Setup cancelled. Edited project map values were not written.');
          return { errors, warnings };
        }
        confirmValues.default_review_budget = reviewBudgetResult.value;

        const auditBudgetResult = await promptPositiveInteger(
          prompts,
          write,
          'Default audit budget',
          confirmValues.default_audit_budget
        );
        if (auditBudgetResult.cancelled) {
          write('Setup cancelled. Edited project map values were not written.');
          return { errors, warnings };
        }
        confirmValues.default_audit_budget = auditBudgetResult.value;

        const currentRationale = detection.existingRaw?.development_stage_rationale ?? '';
        const rationaleAnswer = (await prompts.ask(`  Development stage rationale (${currentRationale || 'optional'}): `)).trim();
        if (rationaleAnswer) confirmValues.development_stage_rationale = rationaleAnswer;

        const currentRevisit = detection.existingRaw?.development_stage_revisit_when ?? '';
        const revisitAnswer = (await prompts.ask(`  Development stage revisit trigger (${currentRevisit || 'optional'}): `)).trim();
        if (revisitAnswer) confirmValues.development_stage_revisit_when = revisitAnswer;

        if (!stageMigration) {
          const backendResult = await promptTaskBackend(prompts, write, confirmValues.task_backend);
          confirmValues.task_backend = backendResult.value;

          const groupingAnswer = (await prompts.ask(`  Grouping profile (${detection.grouping.groupingProfile}): `)).trim();
          if (groupingAnswer && ['flat', 'phase', 'milestone', 'epic', 'custom'].includes(groupingAnswer)) {
            confirmValues.grouping_profile = groupingAnswer;
          }

          const taskIdResult = await promptTaskIdConvention(
            prompts,
            write,
            confirmValues.task_id_pattern,
            confirmValues.task_id_regex,
            confirmValues.grouping_profile
          );
          if (taskIdResult.cancelled) {
            write('Setup cancelled. Edited project map values were not written.');
            return { errors, warnings };
          }
          Object.assign(confirmValues, taskIdResult.value);
        }

        printProjectMapValues(write, '\nEdited project map values:', confirmValues);

        const applyEdited = (await prompts.ask(stageMigration
          ? '\nApply edited development-stage migration? (yes/no): '
          : '\nApply edited project setup? (yes/no): ')).trim().toLowerCase();
        if (applyEdited !== 'yes' && applyEdited !== 'y') {
          write('Setup cancelled. Edited project map values were not written.');
          return { errors, warnings };
        }
      }

      profileValues = confirmValues;
      profileReason = stageMigration ? 'development-stage migration values' : 'human-confirmed profile values';
    }

    io.throwIfAborted();

    // Step 3: Choose (event logging, host integration, models; no writes).
    stepHeader(write, 3, 'Choose');
    const currentEventLogging = isValidEventLogging(detection.existingConfig?.event_logging)
      ? detection.existingConfig.event_logging
      : PROJECT_MAP_DEFAULTS.event_logging;
    const selectedEventLogging = preselectedEventLogging ?? (
      effectiveNonInteractive
        ? currentEventLogging
        : await promptEventLogging(prompts, write, currentEventLogging)
    );

    let selectedAdapter = preselectedAdapter ?? null;
    if (!selectedAdapter && !effectiveNonInteractive) {
      const state = detectSetupState(target);
      const detectedHosts = Object.entries(state.adapters)
        .filter(([, s]) => s.hasArtifacts)
        .map(([host]) => host);
      selectedAdapter = await promptAdapterMode(prompts, write, detectedHosts);
    }

    const modelMutationsByHost = {};
    if (selectedAdapter) {
      const hosts = selectedAdapter === 'all' ? VALID_ADAPTER_HOSTS : [selectedAdapter];
      for (const host of hosts) {
        const hostError = validateHost(host);
        if (hostError) {
          errors.push(hostError);
          continue;
        }
        if (effectiveNonInteractive) {
          write(`  Skipping model configuration for ${host} in non-interactive mode.`);
          write(`  Use: agenticloop configure models --adapter ${host} --role <role> --model <id>`);
          continue;
        }
        const rolesSource = loadGuidanceAlConfig(target).config ?? loadBundledCanonicalConfig();
        const roles = WORKFLOW_ROLE_IDS;
        const currentSettings = rolesSource?.adapters?.[host]?.roleSettings ?? {};
        write(`\nConfiguring models for ${host}:`);
        const { mutations, cancelled } = await promptModelSettingsInteractive(
          roles,
          host, prompts, currentSettings, { discoverModels: true }
        );
        if (cancelled) {
          write('  Model configuration cancelled.');
          continue;
        }
        if (mutations.length === 0) {
          write('  No model settings provided.');
          continue;
        }
        modelMutationsByHost[host] = mutations;
      }
    }

    io.throwIfAborted();

    // Step 4: Plan (compose the repair-aware plan; preflight before any write).
    stepHeader(write, 4, 'Plan');
    const guidanceConfig = loadGuidanceAlConfig(target);
    const guidanceEnrollable = agentsGuidance && !guidanceConfig.error &&
      checkGuidance(target, { alConfig: guidanceConfig.config }).owned === true;
    const plan = planSetup({
      target,
      adapter: selectedAdapter,
      profileValues,
      profileReason,
      eventLogging: selectedEventLogging,
      modelMutationsByHost,
      agentsGuidance,
      installationExisted,
      guidanceEnrollable,
    });
    const planBlockers = lifecyclePlanBlockers(plan);
    if (errors.length > 0 && jsonMode) {
      plan.blockers.unshift(...errors);
    }

    if (effectiveDryRun) {
      if (jsonMode) {
        io.out(lifecyclePlanToJson(plan));
      } else {
        for (const line of renderLifecyclePlan(plan, { verbose, dryRun: true })) write(line);
        for (const warning of plan.warnings) io.warn(`  WARN: ${warning}`);
      }
      return {
        errors: planBlockers.length > 0 || errors.length > 0 ? [...errors, ...planBlockers] : [],
        warnings,
        plan,
      };
    }

    for (const line of renderLifecyclePlan(plan, { verbose })) write(line);
    for (const warning of plan.warnings) io.warn(`  WARN: ${warning}`);

    if (errors.length > 0) {
      for (const error of errors) io.err(`  ERROR: ${error}`);
      return { errors, warnings, plan };
    }
    if (planBlockers.length > 0) {
      for (const blocker of planBlockers) io.err(`  ${blocker}`);
      errors.push(...planBlockers);
      return { errors, warnings, plan };
    }

    // Step 5: Apply (one confirmation before the first mutation).
    stepHeader(write, 5, 'Apply');
    if (!effectiveNonInteractive) {
      const applyAnswer = (await prompts.ask('  Apply this plan? [y/N]: ')).trim().toLowerCase();
      if (applyAnswer !== 'y' && applyAnswer !== 'yes') {
        write('  Setup cancelled before apply; no files were changed.');
        return { errors, warnings, plan };
      }
    }

    io.throwIfAborted();
    const applied = applyLifecyclePlan(target, plan, { execHandler: setupExecHandler });
    const mutationReceipt = lifecycleMutationReceipt(target, plan, applied);
    warnings.push(...applied.warnings);
    const counts = lifecyclePlanCounts(plan);
    if (verbose) {
      for (const entry of applied.merged) write(`  merged:   ${entry}`);
      for (const entry of applied.removed) write(`  removed:  ${entry}`);
      for (const entry of applied.created) write(`  created:  ${entry}`);
      for (const entry of applied.adapterFiles) write(`  generated: ${entry}`);
      for (const entry of applied.skipped) write(`  skipped (exists): ${entry}`);
    } else {
      write(`  Created  ${counts.create + counts.adapter}`);
      write(`  Updated  ${counts.update + counts.merge}`);
      write(`  Kept     ${counts.skip}`);
    }
    for (const warning of applied.warnings) io.warn(`  WARN: ${warning}`);
    for (const rollbackError of applied.rollbackErrors) io.err(`  ROLLBACK ERROR: ${rollbackError}`);

    if (!applied.ok) {
      for (const error of applied.errors) io.err(`  ERROR: ${error}`);
      for (const line of formatPartialApplyDiagnostics(applied)) io.err(line);
      errors.push(...applied.errors);
      return { errors, warnings, plan, mutationReceipt };
    }

    // Step 6: Verify.
    stepHeader(write, 6, 'Verify');
    const finalState = detectSetupState(target, { includeValidation: true });
    write(formatSetupChecklist(finalState));

    const steps = nextStepsFromState(finalState);

    if (finalState.setupComplete && errors.length === 0) {
      write('\nSetup complete.');

      const shouldPromptValidation = !effectiveNonInteractive &&
        steps.length > 0 &&
        steps.some(s => s.includes('validate'));

      if (shouldPromptValidation) {
        const runNow = (await prompts.ask('Run validation now? [y/N]: ')).trim().toLowerCase();
        if (runNow === 'y' || runNow === 'yes') {
          write('');
          const valResult = runValidation(target, { output: io.stdout });
          if (valResult.totalErrors === 0) {
            write('Validation passed.');
            if (valResult.totalWarnings > 0) {
              write(`Validation reported ${valResult.totalWarnings} warning(s).`);
            }
          } else {
            const message = `Validation found ${valResult.totalErrors} error(s).`;
            write(message);
            errors.push(message);
          }
        } else {
          write('\nNext: npx agenticloop validate');
        }
      } else if (steps.length > 0) {
        write('\nNext steps:');
        for (const step of steps) write(`  - ${step}`);
      }
    } else {
      if (steps.length > 0) {
        write('\nNext steps:');
        for (const step of steps) write(`  - ${step}`);
      }
    }

    write('');
    return { errors, warnings, plan, mutationReceipt };
  } finally {
    prompts?.close();
  }
}

export { planSetup };
