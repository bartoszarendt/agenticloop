/**
 * agenticloop setup - guided onboarding for new target projects.
 *
 * Resumable, safe to rerun. Calls init internally when needed.
 * Writes only confirmed values. Prints what will change before writing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from './init.js';
import { detectSetupState, formatSetupChecklist, nextStepsFromState } from './setup-state.js';
import { detectProjectState } from './project-detection.js';
import { DEVELOPMENT_STAGES, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { loadAgenticLoopConfig } from './json.js';
import {
  configureModels,
  createPrompts,
  promptModelSettingsInteractive,
  validateHost,
} from './configure-models.js';
import { parseFrontmatter } from './frontmatter.js';
import { applyGuidance, checkGuidance } from './guidance.js';
import {
  PROJECT_MAP_RELATIVE_PATH,
  hasCurrentLayout,
} from './layout.js';
import { runValidation } from './validate-runner.js';

const VALID_ADAPTER_HOSTS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
const ADAPTER_MODE_CHOICES = [
  { index: 1, label: 'Files only (no host adapter)', value: null, action: 'files-only' },
  { index: 2, label: 'Select a host adapter', value: null, action: 'select' },
  { index: 3, label: 'All supported hosts', value: 'all', action: 'all' },
  { index: 4, label: 'Skip adapter setup', value: null, action: 'skip' },
];
const DEVELOPMENT_STAGE_DESCRIPTIONS = {
  greenfield: 'establish a coherent foundation',
  expansion: 'grow capability without fragmentation',
  stabilization: 'converge and harden behavior',
  maintenance: 'preserve compatibility and operational safety',
};

function formatAdapterModeChoices(detectedHosts) {
  const lines = [];
  for (const choice of ADAPTER_MODE_CHOICES) {
    let label = choice.label;
    if (choice.action === 'select' && detectedHosts.length > 0) {
      label += ` (detected: ${detectedHosts.join(', ')})`;
    }
    lines.push(`  ${choice.index}. ${label}`);
  }
  return lines.join('\n');
}

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
  return Number.isInteger(value) && value > 0;
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
      if (!rejectedInput) return { value: currentValue, cancelled: false };
      write(`  ${label} update cancelled; enter a positive integer to continue.`);
      return { value: currentValue, cancelled: true };
    }
    const value = Number(answer);
    if (isPositiveInteger(value)) return { value, cancelled: false };
    rejectedInput = true;
    write(`  ${label} must be a positive integer.`);
  }
}

function writeProjectMapUpdate(target, values, write, description = 'human-confirmed profile values') {
  const projectMapPath = join(target, PROJECT_MAP_RELATIVE_PATH);
  if (!existsSync(projectMapPath)) return false;
  const existing = readFileSync(projectMapPath, 'utf-8');
  writeFileSync(projectMapPath, mergeProjectMapFrontmatter(existing, values), 'utf-8');
  write(`\nUpdated .agenticloop/project.md with ${description}.`);
  return true;
}

function mergeProjectMapFrontmatter(existingContent, newValues) {
  const [existingFm, body] = parseFrontmatter(existingContent);
  const merged = { ...(existingFm ?? {}), ...newValues };

  if (newValues.documents && existingFm?.documents) {
    merged.documents = { ...existingFm.documents, ...newValues.documents };
  }

  return buildProjectMapFrontmatter(merged) + '\n' + body;
}

/**
 * Run guided setup.
 *
 * @param {object} options
 * @param {string} options.target  Target directory.
 * @param {string} [options.adapter]  Preselected adapter host.
 * @param {boolean} [options.nonInteractive=false]  Fail if interaction needed.
 * @param {'disabled'|'enabled'} [options.eventLogging]  Explicit event-logging choice.
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<{errors: string[], warnings: string[]}>}
 */
export async function setup(options) {
  const {
    target,
    adapter: preselectedAdapter,
    nonInteractive = false,
    eventLogging: preselectedEventLogging,
    agentsGuidance = true,
    input = process.stdin,
    output = process.stdout,
  } = options;

  const errors = [];
  const warnings = [];
  const write = (msg) => output.write(msg + '\n');
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

  if (nonInteractive && !preselectedAdapter) {
    errors.push('Non-interactive setup requires --adapter <host>.');
    return { errors, warnings };
  }

  // No TTY check: piped input is allowed for interactive setup
  // Only warn if stdin is truly disconnected (no pipe and no TTY)

  // Step 1: Ensure toolkit is scaffolded (no adapter artifacts yet)
  if (!hasCurrentLayout(target)) {
    write('\nScaffolding Agentic Loop toolkit...');
    const initResult = await init({ target });
    if (initResult.errors.length > 0) {
      errors.push(...initResult.errors);
      return { errors, warnings };
    }
  }

  // Step 2: Detect project state
  const detection = detectProjectState(target);

  write('\n' + '='.repeat(50));
  write('  agenticloop setup');
  write('='.repeat(50));

  // Step 3: Show detected state
  const docLines = formatDocumentDetection(detection.documents);
  if (docLines.length > 0) {
    write('\nDetected source documents:');
    for (const line of docLines) write(line);
  }

  write(`\nGrouping: ${detection.grouping.groupingProfile} (${detection.grouping.evidence})`);
  write(`Task ID: ${detection.taskId.taskIdPattern} (${detection.taskId.evidence})`);
  write(`Backend: ${detection.backend.backend} (confidence: ${detection.backend.confidence})`);
  if (detection.backend.evidence.length > 0) {
    for (const ev of detection.backend.evidence) write(`  - ${ev}`);
  }

  const stageProposalLabel = detection.stage.developmentStage ?? 'selection required';
  write(`\nDevelopment stage proposal: ${stageProposalLabel} (confidence: ${detection.stage.confidence})`);
  write(`  ${detection.stage.rationale}`);
  for (const evidence of detection.stage.evidence) write(`  - ${evidence}`);
  if (detection.stage.conflicts.length > 0) {
    write(`  Conflicting stage evidence: ${detection.stage.conflicts.join(', ')}`);
  }

  if (detection.isConfirmed && detection.hasConfirmedDevelopmentStage) {
    write('\nProject map is already confirmed.');
  } else if (detection.isConfirmed) {
    write('\nProject map is confirmed but needs a human-confirmed development-stage migration.');
  }

  // Step 4: Confirm project map
  const prompts = createPrompts(input, output);

  try {
    if ((!detection.isConfirmed || !detection.hasConfirmedDevelopmentStage) && !nonInteractive) {
      const stageMigration = detection.isConfirmed;
      const confirmValues = stageMigration
        ? {
            development_stage: detection.stage.developmentStage,
            max_parallel_implementation_lanes: detection.existingConfig?.max_parallel_implementation_lanes ??
              PROJECT_MAP_DEFAULTS.max_parallel_implementation_lanes,
          }
        : {
            setup_status: 'confirmed',
            setup_confirmed_at: new Date().toISOString().slice(0, 10),
            setup_confirmed_by: 'human',
            development_stage: detection.stage.developmentStage,
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

          const taskIdAnswer = (await prompts.ask(`  Task ID pattern (${detection.taskId.taskIdPattern}): `)).trim();
          if (taskIdAnswer) {
            confirmValues.task_id_pattern = taskIdAnswer;
          }

          const taskIdRegexAnswer = (await prompts.ask(`  Task ID regex (${detection.taskId.taskIdRegex}): `)).trim();
          if (taskIdRegexAnswer) {
            confirmValues.task_id_regex = taskIdRegexAnswer;
          }
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

      if (!writeProjectMapUpdate(target, confirmValues, write)) {
        errors.push('.agenticloop/project.md not found. Run agenticloop init first.');
        return { errors, warnings };
      }
    } else if (detection.isConfirmed && !nonInteractive) {
      const updateProfile = (await prompts.ask(
        '\nUpdate project profile (including development stage)? (yes/no): '
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

        if (stageResult.cancelled || lanesResult.cancelled) {
          write('Profile update cancelled; continuing setup without profile changes.');
        } else {
          updateValues.development_stage = stageResult.value;
          updateValues.max_parallel_implementation_lanes = lanesResult.value;

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
            write('Profile update cancelled; continuing setup without profile changes.');
          } else if (!writeProjectMapUpdate(target, updateValues, write)) {
            errors.push('.agenticloop/project.md not found. Run agenticloop init first.');
            return { errors, warnings };
          }
        }
      }
    } else if ((!detection.isConfirmed || !detection.hasConfirmedDevelopmentStage) && nonInteractive) {
      write('\nProject map is unconfirmed or has no human-confirmed development stage. Interactive confirmation required.');
      errors.push('Non-interactive setup cannot proceed without a human-confirmed development stage. Run agenticloop setup interactively first.');
      return { errors, warnings };
    }

    // Step 5: Event logging is a separate local operational choice. It is
    // never inferred from the task backend, repository host, or existing logs.
    const currentEventLogging = isValidEventLogging(detection.existingConfig?.event_logging)
      ? detection.existingConfig.event_logging
      : PROJECT_MAP_DEFAULTS.event_logging;
    const selectedEventLogging = preselectedEventLogging ?? (
      nonInteractive
        ? currentEventLogging
        : await promptEventLogging(prompts, write, currentEventLogging)
    );
    const rawEventLogging = detection.existingRaw?.event_logging;

    if (selectedEventLogging !== rawEventLogging) {
      if (!writeProjectMapUpdate(
        target,
        { event_logging: selectedEventLogging },
        write,
        `event_logging: ${selectedEventLogging}`
      )) {
        errors.push('.agenticloop/project.md not found. Run agenticloop init first.');
        return { errors, warnings };
      }
    } else if (!nonInteractive) {
      write(`  Event logging remains ${selectedEventLogging}.`);
    }

    // Step 6: Adapter selection
    let selectedAdapter = preselectedAdapter ?? null;

    if (!selectedAdapter && !nonInteractive) {
      const state = detectSetupState(target);
      const detectedHosts = Object.entries(state.adapters)
        .filter(([, s]) => s.hasArtifacts)
        .map(([host]) => host);

      write('\nAdapter setup:');
      write(formatAdapterModeChoices(detectedHosts));
      const adapterAnswer = (await prompts.ask('  Choice: ')).trim();
      const adapterNum = parseInt(adapterAnswer, 10);

      if (adapterNum === 1) {
        selectedAdapter = null;
        write('  Files-only mode selected. No adapter artifacts will be generated.');
      } else if (adapterNum === 2) {
        write('\nSelect host adapter:');
        write(formatHostChoices(detectedHosts));
        const hostAnswer = (await prompts.ask('  Choice: ')).trim();
        const hostNum = parseInt(hostAnswer, 10);
        if (hostNum >= 1 && hostNum <= VALID_ADAPTER_HOSTS.length) {
          selectedAdapter = VALID_ADAPTER_HOSTS[hostNum - 1];
        } else if (VALID_ADAPTER_HOSTS.includes(hostAnswer)) {
          selectedAdapter = hostAnswer;
        } else {
          write('  Invalid choice. Skipping adapter setup.');
        }
      } else if (adapterNum === 3) {
        selectedAdapter = 'all';
      } else {
        selectedAdapter = null;
      }
    }

    // Step 7: Ensure agenticloop.json exists for adapter setup (no artifacts yet).
    // An existing agenticloop.json is reconciled non-destructively against the
    // current canonical roles (for example, adding a missing auditor slot).
    if (selectedAdapter) {
      const agenticloopJsonPath = join(target, 'agenticloop.json');
      if (!existsSync(agenticloopJsonPath)) {
        write(`\nCreating agenticloop.json for adapter: ${selectedAdapter}`);
      }
      const { ensureAdapterConfig } = await import('./setup-generate.js');
      const cfgError = ensureAdapterConfig(target, selectedAdapter);
      if (cfgError) {
        errors.push(cfgError);
        return { errors, warnings };
      }

      // Step 8: Model configuration
      const alConfig = loadAlConfig(target);
      if (alConfig) {
        const roles = Object.keys(alConfig.roles ?? {});
        const hosts = selectedAdapter === 'all' ? VALID_ADAPTER_HOSTS : [selectedAdapter];

        for (const host of hosts) {
          const hostError = validateHost(host);
          if (hostError) {
            errors.push(hostError);
            continue;
          }

          const currentSettings = alConfig.adapters?.[host]?.roleSettings ?? {};

          write(`\nConfiguring models for ${host}:`);

          if (nonInteractive) {
            write('  Skipping model configuration in non-interactive mode.');
            write(`  Use: agenticloop configure models --adapter ${host} --role <role> --model <id>`);
            continue;
          }

          const { mutations, cancelled } = await promptModelSettingsInteractive(
            roles, host, prompts, currentSettings, { discoverModels: true }
          );

          if (cancelled) {
            write('  Model configuration cancelled.');
            continue;
          }

          if (mutations.length === 0) {
            write('  No model settings provided.');
            continue;
          }

          const cfgResult = configureModels(target, { adapter: host, mutations });
          for (const w of cfgResult.warnings) {
            write(`  WARN: ${w}`);
            warnings.push(w);
          }
          for (const e of cfgResult.errors) {
            write(`  ERROR: ${e}`);
            errors.push(e);
          }
          for (const u of cfgResult.updated) write(`  updated: ${u}`);
        }

        // Step 9: Generate adapter artifacts
        if (errors.length === 0) {
          write('\nGenerating adapter artifacts...');
          const { generateAdapters } = await import('./setup-generate.js');
          const genResult = await generateAdapters(target, selectedAdapter);
          for (const e of genResult.errors) {
            write(`  ERROR: ${e}`);
            errors.push(e);
          }
          for (const f of genResult.files) write(`  generated: ${f}`);
        }
      }
    }

    // Step 9b: New installations receive guidance by default. Repeated setup
    // only refreshes a block that is already manifest-owned.
    if (agentsGuidance) {
      const configResult = loadGuidanceConfig(target);
      if (configResult.error) {
        write(`\nActivation guidance: ${configResult.error}`);
        errors.push(configResult.error);
      } else {
        const priorGuidance = checkGuidance(target, { alConfig: configResult.config });
        if (!installationExisted || priorGuidance.owned === true) {
          const guidance = applyGuidance(target, {
            alConfig: configResult.config,
            refreshOnly: installationExisted,
          });
          if (guidance.changed) {
            write(`\nActivation guidance: ${guidance.action} in ${guidance.relPath}.`);
          } else if (guidance.status === 'current') {
            write(`\nActivation guidance: current in ${guidance.relPath}.`);
          } else if (!guidance.ok) {
            write(`\nActivation guidance: ${guidance.message}`);
            errors.push(guidance.message);
          }
          for (const warning of guidance.warnings) {
            write(`  WARN: ${warning}`);
            warnings.push(warning);
          }
        }
      }
    }

    // Step 10: Final status
    const finalState = detectSetupState(target, { includeValidation: true });
    write('\n' + formatSetupChecklist(finalState));

    const steps = nextStepsFromState(finalState);

    if (finalState.setupComplete && errors.length === 0) {
      write('\nSetup complete.');

      const shouldPromptValidation = !nonInteractive &&
        steps.length > 0 &&
        steps.some(s => s.includes('validate'));

      if (shouldPromptValidation) {
        const runNow = (await prompts.ask('Run validation now? (yes/no): ')).trim().toLowerCase();
        if (runNow === 'y' || runNow === 'yes') {
          write('');
          const valResult = runValidation(target, { output });
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
  } finally {
    prompts.close();
  }

  return { errors, warnings };
}

function loadGuidanceConfig(target) {
  const cfgPath = join(target, 'agenticloop.json');
  if (!existsSync(cfgPath)) return { config: null, error: null };
  try {
    return { config: loadAgenticLoopConfig(cfgPath), error: null };
  } catch (error) {
    return { config: null, error: `agenticloop.json is malformed: ${error.message}` };
  }
}

function loadAlConfig(target) {
  return loadGuidanceConfig(target).config;
}
