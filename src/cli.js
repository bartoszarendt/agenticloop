/**
 * agenticloop CLI router.
 *
 * Commands:
 *   agenticloop init [--target <dir>] [--adapter <host>]
 *   agenticloop update [--target <dir>] [--adapter <host>]
 *   agenticloop upgrade [--target <dir>] [--adapter <host>]
 *   agenticloop remove [--target <dir>] [--dry-run|--yes]
 *   agenticloop validate [--target <dir>]
 *   agenticloop github-preflight --pr <number> [--issue <number>] [--repo <owner/name>] [--json]
 *   agenticloop event-logging <event_type> [--target <dir>] [--summary <text>] [--task <id>]
 *   agenticloop event-logging validate [--target <dir>] [--output <file>]
 *   agenticloop event-logging audit --task <id> [--target <dir>] [--require a,b,c]
 *   agenticloop event-logging report --task <id> [--target <dir>]
 *   agenticloop bootstrap-labels [--repo <r>] [--dry-run] [--group <g>] [--task-id <id>]
 *   agenticloop generate opencode     [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate codex        [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate claude-code  [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate copilot      [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate cursor       [--target <dir>] [--output-dir <dir>]
 *   agenticloop generate all          [--target <dir>] [--output-dir <dir>]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { init } from './init.js';
import { bootstrapLabels } from './bootstrap-labels.js';
import {
  generateOpencodeArtifacts,
  OPENCODE_AGENT_RELATIVE_PATHS,
  OPENCODE_COMMAND_RELATIVE_PATH,
} from './adapters/opencode.js';
import { generateCodexArtifacts } from './adapters/codex.js';
import { generateClaudeCodeArtifacts } from './adapters/claude-code.js';
import {
  generateCopilotArtifacts,
  generatedCopilotArtifactsPresent,
} from './adapters/copilot.js';
import {
  generateCursorArtifacts,
  generatedCursorArtifactsPresent,
} from './adapters/cursor.js';
import { validateSharedAgenticLoopPluginCompatibility } from './adapter-plugin-compatibility.js';
import { loadAgenticLoopConfig } from './json.js';
import { loadProjectMap } from './project-map.js';
import { resolveTaskBackend } from './task-backend.js';
import {
  configureModels,
  parseModelMutations,
  detectHost,
  validateHost,
  createPrompts,
  promptModelSettings,
  promptModelSettingsInteractive,
} from './configure-models.js';
import { printAdapterDiscovery, printDoctor } from './adapter-discovery.js';
import { setup } from './setup.js';
import { removeAgenticLoop } from './remove.js';
import { preserveExistingAdapterModelSettings } from './adapter-model-preservation.js';
import {
  appendEventLog,
  auditTaskEventLog,
  buildEvent,
  DEFAULT_LOG_DIR,
  reportTaskEventLog,
  STRICT_AUDIT_EVENT_TYPES,
  VALID_EVENT_TYPES,
  resolveEventLogPath,
  resolveLogDirectory,
  validateEvent,
  validateEventLogFile,
  validateEventLogs,
} from './event-logging.js';
import { runValidation } from './validate-runner.js';
import { runPreflight, PreflightError } from './github-preflight.js';

function toCamelCase(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

const REPEATABLE_OPTIONS = new Set(['adapter', 'ref']);
const DEFAULT_LOG_DIR_DISPLAY = DEFAULT_LOG_DIR.replaceAll('\\', '/');
const TASK_EVENT_LOG_PATH_DISPLAY = `${DEFAULT_LOG_DIR_DISPLAY}/<task-id>.jsonl`;
const DEFAULT_EVENT_LOG_GLOB_DISPLAY = `${DEFAULT_LOG_DIR_DISPLAY}/*.jsonl`;

function parseArgs(rawArgs) {
  const opts = {};
  const positional = [];
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = toCamelCase(arg.slice(2));
      const next = rawArgs[i + 1];
      if (REPEATABLE_OPTIONS.has(key) && next !== undefined && !next.startsWith('--')) {
        if (!Array.isArray(opts[key])) opts[key] = [];
        opts[key].push(next);
        i += 2;
      } else if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 2;
      } else {
        opts[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { opts, positional };
}

function parseRequiredEventTypesOption(value) {
  if (value === undefined) {
    return {
      requiredEventTypes: STRICT_AUDIT_EVENT_TYPES,
      explicitRequire: false,
      errors: [],
    };
  }

  const requiredEventTypes = [...new Set(String(value).split(',').map(entry => entry.trim()).filter(Boolean))];
  if (requiredEventTypes.length === 0) {
    return {
      requiredEventTypes: [],
      explicitRequire: true,
      errors: ['--require must include at least one event type'],
    };
  }

  const invalid = requiredEventTypes.filter(eventType => !VALID_EVENT_TYPES.has(eventType));
  if (invalid.length > 0) {
    return {
      requiredEventTypes,
      explicitRequire: true,
      errors: [`--require contains unknown event type(s): ${invalid.join(', ')}`],
    };
  }

  return {
    requiredEventTypes,
    explicitRequire: true,
    errors: [],
  };
}

function formatSummaryList(values) {
  return values.length > 0 ? values.join(', ') : 'none';
}

function formatCountSummary(entries) {
  return entries.length > 0 ? entries.map(entry => `${entry.value}=${entry.count}`).join(', ') : 'none';
}

function formatRefSummary(entries) {
  return entries.length > 0 ? entries.map(entry => `${entry.ref}=${entry.count}`).join(', ') : 'none';
}

function inferCheckRunOutcome(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  if (data.blocked === true || data.status === 'blocked') return 'blocked';

  const exitCode = typeof data.exit_code === 'number' ? data.exit_code : null;
  if (exitCode !== null) return exitCode === 0 ? 'success' : 'failure';

  const failed = typeof data.failed === 'number' ? data.failed : null;
  if (failed !== null && failed > 0) return 'failure';
  if (failed === 0 && typeof data.passed === 'number' && data.passed > 0) return 'success';

  return null;
}

function normalizeEventOutcomeOption(eventType, outcome) {
  if (eventType === 'task.started' && outcome === 'required') {
    return {
      outcome: undefined,
      warnings: [
        "`--outcome required` is not a task.started outcome; recording the default outcome 'unknown'",
      ],
    };
  }

  return { outcome, warnings: [] };
}

function usage() {
  console.log(`
agenticloop <command> [options]

Commands:
  init                  Scaffold Agentic Loop overlay in a target directory.
  setup                 Guided onboarding: project setup, adapter selection, model config.
  update                Refresh Agentic Loop-owned assets and existing adapter output.
  upgrade               Compatibility alias for update.
  remove                Remove Agentic Loop assets from a target directory.
  validate              Validate skills, config, links, and host setup.
  github-preflight      Pre-review gate: verify a GitHub PR body carries final-state
                        evidence for every required check, tied to the current head.
  doctor                Show setup checklist, adapter state, and next commands.
  event-logging         Write events (bare event type), validate, audit, or report optional durable workflow event logs.
  event                 Compatibility alias for event-logging.
  configure models      Set per-host role model settings in agenticloop.json.
  status                Show configured adapters, generated artifacts, and next steps.
  bootstrap-labels      Create required GitHub labels in a target repo.
  generate opencode     Generate Agentic Loop OpenCode agents and command.
  generate codex        Generate Codex adapter artifacts.
  generate claude-code  Generate Claude Code adapter artifacts.
  generate copilot      Generate GitHub Copilot adapter artifacts.
  generate cursor       Generate Cursor adapter artifacts.
  generate all          Generate every implemented adapter artifact.

Options (init):
  --target <dir>        Target directory (default: current directory).
  --adapter <host>      Scaffold and generate output for one host: opencode, codex, claude-code, copilot, cursor, all.
  --opencode            Compatibility alias for --adapter opencode.
  --setup               Prompt for model settings after scaffolding (requires one concrete --adapter).

Options (setup):
  --target <dir>        Target directory (default: current directory).
  --adapter <host>      Preselect adapter: opencode, codex, claude-code, copilot, cursor, all.
  --yes                 Non-interactive mode: skip interactive prompts (requires --adapter).

Options (github-preflight):
  --pr <number>         Pull request number to check. Required.
  --issue <number>      Linked task issue number (default: inferred from PR closing references).
  --repo <owner/name>   Target repository (default: gh-resolved current repo).
  --json                Emit machine-readable JSON instead of human-readable output.

Options (doctor):
  --target <dir>        Directory to inspect (default: current directory).

Options (update):
  --target <dir>        Target directory (default: current directory).
  --adapter <host>      Generate or refresh one adapter. 'all' means every implemented adapter.
                        Without this, existing generated artifacts are refreshed.
                        Existing adapter model settings are backfilled into
                        agenticloop.json when missing before regeneration.

Options (remove):
  --target <dir>        Target directory (default: current directory).
  --dry-run             Print files/directories that would be removed.
  --yes                 Actually remove files/directories.
  --include-state       Also remove target-owned .agenticloop/ state.

Options (validate):
  --target <dir>        Directory containing agenticloop.json (default: current).
  --adapter <host>      Force validation of a specific adapter (opencode, codex, claude-code, copilot, cursor).
                        May be passed multiple times.

Options (event-logging <event_type>):
  --target <dir>        Target directory (default: current directory).
  --output <file>       Event log path override (default: <target>/${TASK_EVENT_LOG_PATH_DISPLAY};
                         --task <id> is required unless --output <file> is supplied).
  --task <id>           Task id associated with the event. Required for default output.
  --role <role>         Role: orchestrator, maintainer, engineer, human, unknown.
  --summary <text>      Required short event summary.
  --outcome <value>     Outcome: success, failure, blocked, needs_context, accepted, needs_revision, unknown.
  --backend <name>      Backend: files, github, unknown.
  --host <name>         Host label (default: unknown).
  --trace-id <uuid>     Trace id used to correlate related events.
  --parent-event-id <uuid>  Parent event id when this event extends an earlier gate.
  --ref <value>         Reference string; may be passed multiple times.
  --data-json <json>    Small JSON object with structured metadata.

Options (event-logging validate):
  --target <dir>        Target directory (default: current directory).
  --output <file>       Event log path override (default: validate every <target>/${DEFAULT_EVENT_LOG_GLOB_DISPLAY}).

Options (event-logging audit):
  --target <dir>        Target directory (default: current directory).
  --task <id>           Task id to audit. Required.
  --require <a,b,c>     Override the strict-audit required event types.

Options (event-logging report):
  --target <dir>        Target directory (default: current directory).
  --task <id>           Task id to summarize from <target>/${TASK_EVENT_LOG_PATH_DISPLAY}.

Options (configure models):
  --target <dir>        Directory containing agenticloop.json (default: current).
  --adapter <host>      Host adapter to configure (opencode, codex, claude-code, copilot, cursor).
  --role <role>         Logical role to configure (orchestrator, maintainer, engineer).
  --model <id>          Host-specific model identifier or alias.
  --reasoning-effort <value>  Reasoning effort for hosts that support it (opencode, codex).

Options (status):
  --target <dir>        Directory containing agenticloop.json (default: current).

Options (bootstrap-labels):
  --repo <owner/repo>   Target GitHub repository.
  --dry-run             Print gh commands without running them.
  --group <id>          Also create a grouping label.
  --task-id <id>        Also create a task:<id> label.

Options (generate opencode):
  --target <dir>        Directory containing agenticloop.json (default: current).
  --output-dir <dir>    Output directory (default: <target>).

Options (generate codex | generate claude-code | generate copilot | generate cursor | generate all):
  --target <dir>        Directory containing agenticloop.json (default: current).
  --output-dir <dir>    Output directory (default: <target>).
  `.trim());
}

const VALID_ADAPTER_TARGETS = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all']);

function normalizeAdapterTargets(adapterOpt) {
  if (!adapterOpt) return { adapters: [], errors: [] };
  const raw = Array.isArray(adapterOpt) ? adapterOpt : [adapterOpt];
  const errors = [];
  for (const adapter of raw) {
    if (!VALID_ADAPTER_TARGETS.has(adapter)) {
      errors.push(`Unknown adapter '${adapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`);
    }
  }
  if (errors.length > 0) return { adapters: [], errors };
  if (raw.includes('all')) return { adapters: ['all'], errors: [] };
  return { adapters: raw, errors: [] };
}

function detectGeneratedAdapterTargets(target, alConfig = null) {
  const adapters = [];
  const opencodePresent = Object.values(OPENCODE_AGENT_RELATIVE_PATHS)
    .some(relPath => existsSync(join(target, relPath))) || existsSync(join(target, OPENCODE_COMMAND_RELATIVE_PATH));
  if (opencodePresent) adapters.push('opencode');
  if (
    existsSync(join(target, '.codex', 'agents')) ||
    existsSync(join(target, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json')) ||
    existsSync(join(target, '.codex-plugin', 'plugin.json'))
  ) {
    adapters.push('codex');
  }
  if (existsSync(join(target, '.claude', 'agents'))) {
    adapters.push('claude-code');
  }
  if (generatedCopilotArtifactsPresent(target).length > 0) {
    adapters.push('copilot');
  }
  if (generatedCursorArtifactsPresent(target).length > 0) {
    adapters.push('cursor');
  }
  return adapters;
}

function validateAdapterGenerationPreflight(sub, alConfig) {
  return validateAdapterListGenerationPreflight([sub], alConfig);
}

function validateAdapterListGenerationPreflight(adapters, alConfig) {
  if (adapters.some(adapter => ['codex', 'cursor', 'all'].includes(adapter))) {
    return validateSharedAgenticLoopPluginCompatibility(alConfig);
  }
  return [];
}

function printPreservationResult(preservation) {
  for (const w of preservation.warnings) console.warn(`  WARN: ${w}`);
  for (const e of preservation.errors) console.error(`  ERROR: ${e}`);
  for (const u of preservation.updated) console.log(`  preserved: ${u}`);
}

function shouldPreserveExistingModels(preserveExistingModels, outputDir, target) {
  return preserveExistingModels && resolve(outputDir) === resolve(target);
}

async function generateAdapterTarget(sub, { opts, target, alConfig, preserveExistingModels = true }) {
  const preflightErrors = validateAdapterGenerationPreflight(sub, alConfig);
  if (preflightErrors.length > 0) {
    for (const error of preflightErrors) console.error(error);
    process.exitCode = 1;
    return;
  }

  if (sub === 'opencode') {
    if (opts.output) {
      console.error("OpenCode generation no longer accepts --output <file>; use '--output-dir <dir>' instead.");
      process.exitCode = 1;
      return;
    }
    const outputDir = resolveOutputDir(opts, target);
    let effectiveConfig = alConfig;
    if (shouldPreserveExistingModels(preserveExistingModels, outputDir, target)) {
      const preservation = preserveExistingAdapterModelSettings(target, ['opencode']);
      printPreservationResult(preservation);
      if (preservation.errors.length > 0) {
        process.exitCode = 1;
        return;
      }
      if (preservation.updated.length > 0) {
        effectiveConfig = loadAgenticLoopConfig(join(target, 'agenticloop.json'));
      }
    }

    const { files } = generateOpencodeArtifacts(effectiveConfig, target, outputDir);
    console.log(`Generated ${files.length} OpenCode artifact(s) under ${outputDir}:`);
    for (const file of files) console.log(`  ${file}`);
    return;
  }

  if (sub === 'codex') {
    const outputDir = resolveOutputDir(opts, target);
    const { files } = generateCodexArtifacts(alConfig, target, outputDir);
    console.log(`Generated ${files.length} Codex artifact(s) under ${outputDir}:`);
    for (const f of files) console.log(`  ${f}`);
    return;
  }

  if (sub === 'claude-code') {
    const outputDir = resolveOutputDir(opts, target);
    const { files } = generateClaudeCodeArtifacts(alConfig, target, outputDir);
    console.log(`Generated ${files.length} Claude Code artifact(s) under ${outputDir}:`);
    for (const f of files) console.log(`  ${f}`);
    return;
  }

  if (sub === 'copilot') {
    const outputDir = resolveOutputDir(opts, target);
    const { files } = generateCopilotArtifacts(alConfig, target, outputDir);
    console.log(`Generated ${files.length} GitHub Copilot artifact(s) under ${outputDir}:`);
    for (const f of files) console.log(`  ${f}`);
    return;
  }

  if (sub === 'cursor') {
    const outputDir = resolveOutputDir(opts, target);
    const { files } = generateCursorArtifacts(alConfig, target, outputDir);
    console.log(`Generated ${files.length} Cursor artifact(s) under ${outputDir}:`);
    for (const f of files) console.log(`  ${f}`);
    return;
  }

  if (sub === 'all') {
    const outputDir = resolveOutputDir(opts, target);
    mkdirSync(outputDir, { recursive: true });
    let total = 0;
    let effectiveConfig = alConfig;
    if (shouldPreserveExistingModels(preserveExistingModels, outputDir, target)) {
      const preservation = preserveExistingAdapterModelSettings(target, ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']);
      printPreservationResult(preservation);
      if (preservation.errors.length > 0) {
        process.exitCode = 1;
        return;
      }
      if (preservation.updated.length > 0) {
        effectiveConfig = loadAgenticLoopConfig(join(target, 'agenticloop.json'));
      }
    }

    const opencode = generateOpencodeArtifacts(effectiveConfig, target, outputDir);
    total += opencode.files.length;
    const codex = generateCodexArtifacts(effectiveConfig, target, outputDir);
    total += codex.files.length;
    const cc = generateClaudeCodeArtifacts(effectiveConfig, target, outputDir);
    total += cc.files.length;
    const copilot = generateCopilotArtifacts(effectiveConfig, target, outputDir);
    total += copilot.files.length;
    const cursor = generateCursorArtifacts(effectiveConfig, target, outputDir);
    total += cursor.files.length;
    console.log(`Total artifacts: ${total}`);
    return;
  }

  console.error(`Unknown generate target: ${sub}`);
  console.error('Available: opencode | codex | claude-code | copilot | cursor | all');
  process.exitCode = 1;
}

async function cmdInit(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const setup = Boolean(opts.setup);

  if (opts.updateAssets) {
    console.error("init --update-assets has been removed. Use 'agenticloop update' instead.");
    process.exitCode = 1;
    return;
  }

  if (setup) {
    console.log('  Hint: agenticloop setup provides a guided onboarding experience.');
    console.log(`  Try: npx agenticloop setup${adapter ? ` --adapter ${adapter}` : ''}`);
    console.log();
  }

  if (setup && !adapter) {
    console.error('--setup requires --adapter <host>');
    usage();
    process.exitCode = 1;
    return;
  }
  if (setup && adapter === 'all') {
    console.error('--setup requires one concrete adapter: opencode, codex, claude-code, copilot, or cursor');
    process.exitCode = 1;
    return;
  }

  const { errors: initErrors } = await init({
    target,
    opencode: Boolean(opts.opencode),
    adapter,
  });

  const errors = [...initErrors];

  if (setup && errors.length === 0 && adapter && adapter !== 'all') {
    const alConfig = loadAlConfigOrExit(target);
    if (alConfig) {
      const roles = Object.keys(alConfig.roles ?? {});
      const prompts = createPrompts();
      try {
        const mutations = await promptModelSettings(roles, adapter, prompts);
        const cfgResult = configureModels(target, { adapter, mutations });
        for (const w of cfgResult.warnings) console.warn(`  WARN: ${w}`);
        for (const e of cfgResult.errors) console.error(`  ERROR: ${e}`);
        for (const u of cfgResult.updated) console.log(`  updated: ${u}`);
        if (cfgResult.errors.length === 0 && cfgResult.updated.length > 0) {
          await cmdGenerate([adapter, '--target', target]);
        } else if (cfgResult.updated.length === 0) {
          console.log('  No model settings provided; skipping adapter generation.');
        }
        errors.push(...cfgResult.errors);
      } finally {
        prompts.close();
      }
    }
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdUpdate(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const { adapters: requestedAdapters, errors: adapterErrors } = normalizeAdapterTargets(opts.adapter);

  for (const e of adapterErrors) console.error(e);
  if (adapterErrors.length > 0) {
    process.exitCode = 1;
    return;
  }

  const { errors: initErrors } = await init({
    target,
    refreshAssets: true,
  });

  if (initErrors.length > 0) {
    process.exitCode = 1;
    return;
  }

  let detectedConfig = null;
  const detectedConfigPath = join(target, 'agenticloop.json');
  if (requestedAdapters.length === 0 && existsSync(detectedConfigPath)) {
    try {
      detectedConfig = loadAgenticLoopConfig(detectedConfigPath);
    } catch { /* loadAlConfigOrExit will report later if needed */ }
  }

  const adapters = requestedAdapters.length > 0
    ? requestedAdapters
    : detectGeneratedAdapterTargets(target, detectedConfig);

  if (adapters.length === 0) {
    console.log('  No existing generated adapter artifacts found.');
    console.log("  Use 'agenticloop update --adapter <host>' to generate a specific adapter.");
    process.exitCode = 0;
    return;
  }

  if (adapters.includes('all')) {
    console.log('  --adapter all selected: generating every implemented adapter artifact, including experimental hosts.');
  }

  const preservation = preserveExistingAdapterModelSettings(target, adapters);
  for (const w of preservation.warnings) console.warn(`  WARN: ${w}`);
  for (const e of preservation.errors) console.error(`  ERROR: ${e}`);
  for (const u of preservation.updated) console.log(`  preserved: ${u}`);
  if (preservation.errors.length > 0) {
    process.exitCode = 1;
    return;
  }

  const alConfig = loadAlConfigOrExit(target);
  if (!alConfig) return;

  const preflightErrors = validateAdapterListGenerationPreflight(adapters, alConfig);
  if (preflightErrors.length > 0) {
    for (const error of preflightErrors) console.error(error);
    process.exitCode = 1;
    return;
  }

  for (const adapter of adapters) {
    await generateAdapterTarget(adapter, {
      opts: {},
      target,
      alConfig,
      preserveExistingModels: false,
    });
    if (process.exitCode && process.exitCode !== 0) return;
  }
}

async function cmdRemove(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const dryRun = Boolean(opts.dryRun);
  const yes = Boolean(opts.yes);
  const includeState = Boolean(opts.includeState);

  if (!dryRun && !yes) {
    console.error("Refusing to remove without confirmation. Run 'agenticloop remove --dry-run' first, then 'agenticloop remove --yes'.");
    process.exitCode = 1;
    return;
  }

  const { removed, skipped, errors } = removeAgenticLoop({ target, dryRun, includeState });

  console.log();
  console.log('agenticloop remove');
  console.log('='.repeat(50));
  if (dryRun) console.log('  (dry run - no changes will be made)');

  if (removed.length === 0 && skipped.length === 0 && errors.length === 0) {
    console.log('  No Agentic Loop assets found.');
  }

  const prefix = dryRun ? 'would remove' : 'removed';
  for (const f of removed) console.log(`  ${prefix}: ${f}`);
  for (const f of skipped) console.log(`  skipped: ${f}`);
  for (const e of errors) console.error(`  ERROR: ${e}`);
  console.log();

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdValidate(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const forcedAdapters = Array.isArray(opts.adapter) ? opts.adapter : (opts.adapter ? [opts.adapter] : []);
  const result = runValidation(target, { adapters: forcedAdapters });
  if (result.totalErrors > 0) {
    process.exitCode = 1;
  }
}

async function cmdGithubPreflight(args) {
  const { opts } = parseArgs(args);
  const asJson = Boolean(opts.json);

  if (!opts.pr) {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, errors: ['--pr <number> is required'] }));
    } else {
      console.error('github-preflight requires --pr <number>');
    }
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = runPreflight({ pr: opts.pr, issue: opts.issue, repo: opts.repo });
  } catch (error) {
    if (error instanceof PreflightError) {
      if (asJson) {
        console.log(JSON.stringify({ ok: false, errors: [error.message] }));
      } else {
        console.error(`github-preflight failed: ${error.message}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (asJson) {
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  console.log();
  console.log('agenticloop github-preflight');
  console.log('='.repeat(50));
  console.log(`  PR: #${result.pr}`);
  console.log(`  issue: ${result.issue !== null ? `#${result.issue}` : 'none'}`);
  console.log(`  current head: ${result.headRefOid || 'unknown'}`);
  console.log(`  required checks: ${result.requiredChecks.length}`);
  console.log(`  matched evidence: ${result.evidenceMatches.length}`);

  if (result.statusSubstitutions.length > 0) {
    console.log('  status-check substitutions:');
    for (const sub of result.statusSubstitutions) {
      console.log(`    - '${sub.check}' satisfied by status check '${sub.statusCheck}'`);
    }
  } else {
    console.log('  status-check substitutions: none');
  }

  for (const warning of result.warnings) console.warn(`  WARN: ${warning}`);

  if (result.ok) {
    console.log('  preflight passed');
    console.log();
    process.exitCode = 0;
    return;
  }

  console.log('  preflight FAILED:');
  for (const error of result.errors) console.error(`    ERROR: ${error}`);
  console.log();
  process.exitCode = 1;
}

async function cmdEvent(args, commandLabel = 'event-logging') {
  const sub = args[0];

  if (!sub) {
    console.error(`${commandLabel} requires an event type, 'validate', 'audit', or 'report'`);
    usage();
    process.exitCode = 1;
    return;
  }

  if (sub === '--help' || sub === '-h') {
    console.log(`${commandLabel} [event_type|validate|audit|report] [options]`);
    console.log();
    console.log('Subcommands:');
    console.log('  validate              Validate event log files.');
    console.log('  audit                 Audit task event logs for required events.');
    console.log('  report                Generate a report from task event logs.');
    console.log();
    console.log('Write path (bare event type):');
    console.log(`  ${commandLabel} <event_type> --summary "..." [options]`);
    console.log();
    console.log('  event_type is a positional — one of:');
    for (const t of VALID_EVENT_TYPES) console.log(`    ${t}`);
    console.log();
    console.log('Write options:');
    console.log('  --summary <text>      Required. Event description.');
    console.log('  --outcome <outcome>   Event outcome.');
    console.log('  --role <role>         Role associated with the event.');
    console.log('  --backend <backend>   Storage backend (files, github).');
    console.log('  --task <id>           Task identifier.');
    console.log('  --trace-id <id>       Trace identifier.');
    console.log('  --parent-event-id <id> Parent event identifier.');
    console.log('  --refs <a,b,...>      Comma-separated list of references.');
    console.log('  --data-json <json>    JSON event data payload.');
    console.log();
    process.exitCode = 0;
    return;
  }

  const { opts } = parseArgs(args.slice(1));
  const target = opts.target ? resolve(opts.target) : process.cwd();

  if (sub === 'validate') {
    const eventLogDirectory = resolveLogDirectory(target);
    const pathResult = opts.output ? resolveEventLogPath(target, opts.output) : null;
    const eventLogPath = pathResult?.path ?? null;
    const pathWarnings = pathResult?.warnings ?? [];
    const result = opts.output
      ? validateEventLogFile(eventLogPath, { target })
      : validateEventLogs(target);

    console.log();
    console.log(`agenticloop ${commandLabel} validate`);
    console.log('='.repeat(50));
    if (opts.output) console.log(`  event log: ${eventLogPath}`);
    else console.log(`  directory: ${eventLogDirectory}`);
    for (const warning of pathWarnings) console.warn(`  WARN: ${warning}`);
    if (!result.exists) {
      console.log('  No event logs found.');
      console.log();
      process.exitCode = 0;
      return;
    }
    for (const error of result.errors) console.error(`  ERROR: ${error}`);
    for (const warning of result.warnings) console.warn(`  WARN: ${warning}`);
    if (result.errors.length === 0 && result.warnings.length === 0 && pathWarnings.length === 0) {
      if (opts.output) {
        console.log(`  OK: ${result.eventCount} event(s) validated`);
      } else {
        console.log(`  OK: ${result.fileCount} file(s), ${result.eventCount} event(s) validated`);
      }
    } else {
      if (!opts.output) console.log(`  files: ${result.fileCount}`);
      console.log(`  events: ${result.eventCount}`);
    }
    console.log();
    process.exitCode = result.errors.length > 0 ? 1 : 0;
    return;
  }

  if (sub === 'audit') {
    if (!opts.task) {
      console.error('--task is required for event log audit');
      process.exitCode = 1;
      return;
    }

    const requireResult = parseRequiredEventTypesOption(opts.require);
    for (const error of requireResult.errors) console.error(error);
    if (requireResult.errors.length > 0) {
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = auditTaskEventLog({
        target,
        taskId: opts.task,
        requiredEventTypes: requireResult.requiredEventTypes,
        explicitRequire: requireResult.explicitRequire,
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    console.log();
    console.log(`agenticloop ${commandLabel} audit`);
    console.log('='.repeat(50));
    console.log(`  task: ${result.taskId}`);
    console.log(`  event log: ${result.path}`);
    console.log(`  event_logging: ${result.eventLogging}`);
    console.log(`  required events: ${result.requiredEventTypes.join(', ')}`);

    if (result.skipped) {
      console.log('  Event logging is disabled in .agenticloop/project.md; skipping strict audit.');
      console.log();
      process.exitCode = 0;
      return;
    }

    if (result.durableClosure) {
      const status = result.durableClosure.satisfied
        ? 'yes'
        : `no (${result.durableClosure.reason})`;
      console.log(`  durable task.closed: ${status}`);
    }

    if (!result.enabled && result.explicitRequire) {
      console.log('  Event logging is disabled in .agenticloop/project.md, but explicit --require requested an audit.');
    }

    for (const error of result.errors) console.error(`  ERROR: ${error}`);
    for (const warning of result.warnings) console.warn(`  WARN: ${warning}`);

    if (result.errors.length === 0) {
      console.log(`  OK: ${result.eventCount} event(s) validated for strict audit`);
    } else {
      console.log(`  events: ${result.eventCount}`);
    }

    console.log();
    process.exitCode = result.errors.length > 0 ? 1 : 0;
    return;
  }

  if (sub === 'report') {
    if (!opts.task) {
      console.error('--task is required for event log report');
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = reportTaskEventLog({ target, taskId: opts.task });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    console.log();
    console.log(`agenticloop ${commandLabel} report`);
    console.log('='.repeat(50));
    console.log(`  task: ${result.taskId}`);
    console.log(`  event log: ${result.path}`);
    console.log(`  events: ${result.eventCount}`);
    console.log(`  first event: ${result.firstEventTimestamp ?? 'none'}`);
    console.log(`  last event: ${result.lastEventTimestamp ?? 'none'}`);
    console.log(`  trace duration: ${result.traceDuration}`);
    console.log(`  strict audit present: ${formatSummaryList(result.strictAudit.presentEventTypes)}`);
    console.log(`  strict audit missing: ${formatSummaryList(result.strictAudit.missingEventTypes)}`);
    const durableClosureStatus = result.strictAudit.durableClosure.satisfied
      ? 'yes'
      : `no (${result.strictAudit.durableClosure.reason})`;
    console.log(`  durable task.closed: ${durableClosureStatus}`);
    console.log(
      `  check.run counts: success=${result.checkRunCounts.success}, failure=${result.checkRunCounts.failure}, blocked=${result.checkRunCounts.blocked}`
    );
    console.log(
      `  review.result counts: accepted=${result.reviewResultCounts.accepted}, needs_revision=${result.reviewResultCounts.needs_revision}`
    );
    console.log(`  review rounds: ${formatSummaryList(result.reviewRounds)}`);
    console.log(`  role.invoked targets: ${formatCountSummary(result.roleInvoked.targetRoleCounts)}`);
    console.log(`  delegation modes: ${formatCountSummary(result.roleInvoked.delegationModeCounts)}`);
    console.log(`  fallback count: ${result.roleInvoked.fallbackCount}`);
    console.log(`  refs summary: ${formatRefSummary(result.refsSummary)}`);

    console.log('  accepted imperfect checks (not clean success):');
    if (result.acceptedImperfectChecks.length === 0) {
      console.log('    none');
    } else {
      for (const check of result.acceptedImperfectChecks) {
        const details = [];
        if (check.command) details.push(`command=${check.command}`);
        const triage = [];
        if (check.triaged_unrelated) triage.push('triaged_unrelated');
        if (check.accepted_known_failure) triage.push('accepted_known_failure');
        if (triage.length > 0) details.push(`triage=${triage.join(',')}`);
        details.push(`refs=${check.refs.length > 0 ? check.refs.join(', ') : 'none'}`);
        console.log(`    - ${check.outcome}: ${check.summary} (${details.join('; ')})`);
      }
    }

    console.log('  failed/blocked checks:');
    if (result.failedOrBlockedChecks.length === 0) {
      console.log('    none');
    } else {
      for (const check of result.failedOrBlockedChecks) {
        const details = [];
        if (check.command) details.push(`command=${check.command}`);
        details.push(`refs=${check.refs.length > 0 ? check.refs.join(', ') : 'none'}`);
        console.log(`    - ${check.outcome}: ${check.summary} (${details.join('; ')})`);
      }
    }

    for (const warning of result.warnings) console.warn(`  WARN: ${warning}`);
    console.log();
    process.exitCode = 0;
    return;
  }

  if (!opts.summary) {
    console.error('--summary is required for event writes');
    process.exitCode = 1;
    return;
  }

  let data = {};
  if (opts.dataJson !== undefined) {
    try {
      data = JSON.parse(opts.dataJson);
    } catch (error) {
      console.error(`--data-json must be valid JSON: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.error('--data-json must decode to a JSON object');
      process.exitCode = 1;
      return;
    }
  }

  const backendResolution = resolveTaskBackend(target);
  const defaultBackend = backendResolution.backend === 'files' || backendResolution.backend === 'github'
    ? backendResolution.backend
    : 'unknown';
  const outcomeOption = normalizeEventOutcomeOption(sub, opts.outcome);
  for (const warning of outcomeOption.warnings) console.warn(`  WARN: ${warning}`);

  const event = buildEvent({
    target,
    eventType: sub,
    task: opts.task,
    role: opts.role,
    summary: opts.summary,
    outcome: outcomeOption.outcome ?? (sub === 'check.run' ? inferCheckRunOutcome(data) : undefined),
    backend: opts.backend ?? defaultBackend,
    host: opts.host,
    traceId: opts.traceId,
    parentEventId: opts.parentEventId,
    refs: opts.ref,
    data,
  });

  const validation = validateEvent(event, { target });
  for (const error of validation.errors) console.error(`  ERROR: ${error}`);
  for (const warning of validation.warnings) console.warn(`  WARN: ${warning}`);

  if (validation.errors.length > 0) {
    process.exitCode = 1;
    return;
  }

  let pathResult;
  try {
    pathResult = resolveEventLogPath(target, opts.output, event.task_id);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const { path: eventLogPath, warnings: pathWarnings } = pathResult;
  for (const warning of pathWarnings) console.warn(`  WARN: ${warning}`);

  appendEventLog({ target, output: opts.output, event, path: eventLogPath });
  console.log(`Appended event '${event.event_type}' to ${eventLogPath}`);
  console.log(`  event_id: ${event.event_id}`);
  console.log(`  trace_id: ${event.trace_id}`);
}

async function cmdConfigureModels(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  let adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;

  if (!adapter) {
    const detected = detectHost(target);
    if (detected.length === 1) {
      adapter = detected[0];
      console.log(`Detected host: ${adapter}`);
    } else if (detected.length > 1) {
        console.error(`Multiple hosts detected (${detected.join(', ')}). Use --adapter <host> with one of: opencode, codex, claude-code, copilot, cursor.`);
        process.exitCode = 1;
        return;
      } else {
        console.error('No host detected. Use --adapter <host> with one of: opencode, codex, claude-code, copilot, cursor.');
        process.exitCode = 1;
        return;
      }
  }

  const hostError = validateHost(adapter);
  if (hostError) {
    console.error(hostError);
    process.exitCode = 1;
    return;
  }

  let mutations = parseModelMutations(args);

  if (mutations.length === 0) {
    const alConfig = loadAlConfigOrExit(
      target,
      `agenticloop.json not found. Run agenticloop init --adapter <host> first to enable adapter model configuration.`
    );
    if (!alConfig) {
      process.exitCode = 1;
      return;
    }
    const roles = Object.keys(alConfig.roles ?? {});
    const currentSettings = alConfig.adapters?.[adapter]?.roleSettings ?? {};
    const prompts = createPrompts();
    try {
      const { mutations: picked, cancelled } = await promptModelSettingsInteractive(
        roles, adapter, prompts, currentSettings, { discoverModels: true }
      );
      if (cancelled) {
        console.log('Model configuration cancelled.');
        process.exitCode = 0;
        return;
      }
      mutations = picked;
    } finally {
      prompts.close();
    }
  }

  if (mutations.length === 0) {
    console.log('No model settings provided; nothing to write.');
    process.exitCode = 0;
    return;
  }

  const { errors, warnings, updated } = configureModels(target, { adapter, mutations });

  for (const w of warnings) console.warn(`  WARN: ${w}`);
  for (const e of errors) console.error(`  ERROR: ${e}`);
  for (const u of updated) console.log(`  updated: ${u}`);

  if (errors.length === 0 && updated.length > 0) {
    console.log();
    console.log(`Run 'agenticloop generate ${adapter}' to refresh adapter artifacts.`);
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdSetup(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const adapter = Array.isArray(opts.adapter) ? opts.adapter[0] : opts.adapter;
  const nonInteractive = Boolean(opts.yes) || Boolean(opts.nonInteractive);

  if (adapter) {
    const validAdapters = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all']);
    if (!validAdapters.has(adapter)) {
      console.error(`Unknown adapter '${adapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`);
      process.exitCode = 1;
      return;
    }
  }

  const { errors } = await setup({
    target,
    adapter,
    nonInteractive,
  });

  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdDoctor(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  printDoctor(target);
}

async function cmdStatus(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  printAdapterDiscovery(target);
}

async function cmdBootstrapLabels(args) {
  const { opts } = parseArgs(args);
  const target = opts.target ? resolve(opts.target) : process.cwd();
  const projectMap = loadProjectMap(target)?.config ?? null;

  let alConfig = null;
  const alCfgPath = join(target, 'agenticloop.json');
  if (existsSync(alCfgPath)) {
    try {
      alConfig = loadAgenticLoopConfig(alCfgPath);
    } catch (e) {
      console.error(`Failed to load agenticloop.json: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log();
  console.log('agenticloop bootstrap-labels');
  console.log('='.repeat(50));
  if (opts.dryRun) console.log('  (dry run - no changes will be made)');

  const results = bootstrapLabels(alConfig, {
    repo: opts.repo,
    dryRun: Boolean(opts.dryRun),
    group: opts.group,
    taskId: opts.taskId,
    projectMap,
  });
  if (results.some(result => result.action === 'error')) {
    process.exitCode = 1;
  }
  console.log();
}

function loadAlConfigOrExit(target, hint = '') {
  const alCfgPath = join(target, 'agenticloop.json');
  if (!existsSync(alCfgPath)) {
    const msg = hint
      ? hint
      : `agenticloop.json not found. Run agenticloop init --adapter <host> first to create advanced adapter config.`;
    console.error(msg);
    process.exitCode = 1;
    return null;
  }
  try {
    return loadAgenticLoopConfig(alCfgPath);
  } catch (e) {
    console.error(`Failed to parse agenticloop.json: ${e.message}`);
    process.exitCode = 1;
    return null;
  }
}

function resolveOutputPath(opts, target, defaultFile) {
  if (opts.output) {
    return isAbsolute(opts.output) ? opts.output : resolve(opts.output);
  }
  return join(target, defaultFile);
}

function resolveOutputDir(opts, target) {
  if (opts.outputDir) {
    return isAbsolute(opts.outputDir) ? opts.outputDir : resolve(opts.outputDir);
  }
  return target;
}

async function cmdGenerate(subArgs) {
  const sub = subArgs[0];
  if (!sub) {
    console.error('generate requires a host target: opencode | codex | claude-code | copilot | cursor | all');
    process.exitCode = 1;
    return;
  }
  const { opts } = parseArgs(subArgs.slice(1));
  const target = opts.target ? resolve(opts.target) : process.cwd();

  const alConfig = loadAlConfigOrExit(target);
  if (!alConfig) return;
  await generateAdapterTarget(sub, { opts, target, alConfig, preserveExistingModels: true });
}

// --- entry ------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

switch (command) {
  case 'init':
    await cmdInit(rest);
    break;
  case 'setup':
    await cmdSetup(rest);
    break;
  case 'update':
    await cmdUpdate(rest);
    break;
  case 'upgrade':
    await cmdUpdate(rest);
    break;
  case 'remove':
    await cmdRemove(rest);
    break;
  case 'validate':
    await cmdValidate(rest);
    break;
  case 'github-preflight':
    await cmdGithubPreflight(rest);
    break;
  case 'doctor':
    await cmdDoctor(rest);
    break;
  case 'event-logging':
    await cmdEvent(rest, 'event-logging');
    break;
  case 'event':
    await cmdEvent(rest, 'event');
    break;
  case 'configure':
    if (rest[0] === 'models') {
      await cmdConfigureModels(rest.slice(1));
    } else {
      console.error(`Unknown configure subcommand: ${rest[0]}`);
      usage();
      process.exitCode = 1;
    }
    break;
  case 'status':
    await cmdStatus(rest);
    break;
  case 'bootstrap-labels':
    await cmdBootstrapLabels(rest);
    break;
  case 'generate':
    await cmdGenerate(rest);
    break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exitCode = 1;
}
