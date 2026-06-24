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
import { loadAgenticLoopConfig } from './json.js';
import {
  configureModels,
  createPrompts,
  promptModelSettingsInteractive,
  validateHost,
} from './configure-models.js';
import { parseFrontmatter } from './frontmatter.js';
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
    } else if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
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
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<{errors: string[], warnings: string[]}>}
 */
export async function setup(options) {
  const {
    target,
    adapter: preselectedAdapter,
    nonInteractive = false,
    input = process.stdin,
    output = process.stdout,
  } = options;

  const errors = [];
  const warnings = [];
  const write = (msg) => output.write(msg + '\n');

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

  if (detection.isConfirmed) {
    write('\nProject map is already confirmed.');
  }

  // Step 4: Confirm project map
  const prompts = createPrompts(input, output);

  try {
    if (!detection.isConfirmed && !nonInteractive) {
      const confirmValues = {
        setup_status: 'confirmed',
        setup_confirmed_at: new Date().toISOString().slice(0, 10),
        setup_confirmed_by: 'human',
        task_backend: detection.backend.backend,
        task_id_pattern: detection.taskId.taskIdPattern,
        task_id_regex: detection.taskId.taskIdRegex,
        grouping_profile: detection.grouping.groupingProfile,
      };

      if (Object.keys(detection.proposedDocumentOverrides).length > 0) {
        confirmValues.documents = detection.proposedDocumentOverrides;
      }

      write('\nProposed project map values:');
      for (const [key, val] of Object.entries(confirmValues)) {
        if (key === 'documents' && typeof val === 'object') {
          for (const [docRole, docPath] of Object.entries(val)) {
            write(`  documents.${docRole}: "${docPath}"`);
          }
        } else {
          write(`  ${key}: ${JSON.stringify(val)}`);
        }
      }

      const answer = (await prompts.ask('\nConfirm project setup? (yes/no/edit): ')).trim().toLowerCase();

      if (answer === 'yes' || answer === 'y') {
        // confirmed - fall through to write
      } else if (answer === 'edit' || answer === 'e') {
        const backendAnswer = (await prompts.ask(`  Task backend (${detection.backend.backend}): `)).trim();
        if (backendAnswer && (backendAnswer === 'files' || backendAnswer === 'github')) {
          confirmValues.task_backend = backendAnswer;
        }

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
      } else {
        write('Setup cancelled. Explicit "yes" or "edit" required to confirm project setup.');
        return { errors, warnings };
      }

      // Write project map
      const projectMapPath = join(target, PROJECT_MAP_RELATIVE_PATH);
      if (existsSync(projectMapPath)) {
        const existing = readFileSync(projectMapPath, 'utf-8');
        const updated = mergeProjectMapFrontmatter(existing, confirmValues);
        writeFileSync(projectMapPath, updated, 'utf-8');
        write('\nUpdated .agenticloop/project.md with confirmed values.');
      } else {
        errors.push('.agenticloop/project.md not found. Run agenticloop init first.');
        return { errors, warnings };
      }
    } else if (!detection.isConfirmed && nonInteractive) {
      write('\nProject map is unconfirmed. Interactive confirmation required.');
      errors.push('Non-interactive setup cannot proceed with unconfirmed project map. Run agenticloop setup interactively first, or manually confirm .agenticloop/project.md.');
      return { errors, warnings };
    }

    // Step 5: Adapter selection
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

    // Step 6: Ensure agenticloop.json exists for adapter setup (no artifacts yet)
    if (selectedAdapter) {
      const agenticloopJsonPath = join(target, 'agenticloop.json');
      if (!existsSync(agenticloopJsonPath)) {
        write(`\nCreating agenticloop.json for adapter: ${selectedAdapter}`);
        const { ensureAdapterConfig } = await import('./setup-generate.js');
        const cfgError = ensureAdapterConfig(target, selectedAdapter);
        if (cfgError) {
          errors.push(cfgError);
          return { errors, warnings };
        }
      }

      // Step 7: Model configuration
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

        // Step 8: Generate adapter artifacts
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

    // Step 9: Final status
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

function loadAlConfig(target) {
  const cfgPath = join(target, 'agenticloop.json');
  if (!existsSync(cfgPath)) return null;
  try {
    return loadAgenticLoopConfig(cfgPath);
  } catch {
    return null;
  }
}
