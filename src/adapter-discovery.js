/**
 * Adapter discovery and status reporting.
 *
 * Provides an advisory summary of:
 *   - configured adapters
 *   - present generated artifacts
 *   - missing model settings for generated/required adapters
 *   - next command to run
 *
 * This is intentionally advisory; optional adapters are not required
 * unless explicitly enabled, required, present, or forced with --adapter.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  OPENCODE_AGENT_RELATIVE_PATHS,
  OPENCODE_COMMAND_RELATIVE_PATH,
} from './adapters/opencode.js';
import { resolveRoleModel } from './adapters/shared.js';
import { generatedCopilotArtifactsPresent } from './adapters/copilot.js';
import { generatedCursorArtifactsPresent } from './adapters/cursor.js';
import { detectSetupState, formatSetupChecklist, nextStepsFromState } from './setup-state.js';
import { createIo } from './cli-io.js';
import { formatGitGuardDoctor } from './worktree.js';
import { deriveAuditDueWorkUnits } from './closeout.js';
import { loadProjectMap } from './project-map.js';
import { WORKFLOW_ROLE_IDS } from './workflow-roles.js';
import { diagnoseLifecycleCompatibility, compatibilityMessage } from './lifecycle-compatibility.js';

function hasModelSettings(adapterCfg, roles) {
  const rs = adapterCfg?.roleSettings ?? {};
  const configured = new Set(Object.keys(rs).filter(r => rs[r]?.model));
  const missing = [];
  for (const role of roles) {
    if (!configured.has(role)) missing.push(role);
  }
  return { configured, missing };
}

function detectStaleOpencodeModels(repoRoot, config) {
  const ocAdapter = config.adapters?.opencode ?? {};
  const staleRoles = [];
  for (const roleName of WORKFLOW_ROLE_IDS) {
    const relPath = OPENCODE_AGENT_RELATIVE_PATHS[roleName];
    const agentPath = join(repoRoot, relPath);
    if (!existsSync(agentPath)) continue;
    try {
      const content = readFileSync(agentPath, 'utf-8');
      const [fm] = parseFrontmatter(content);
      if (!fm) continue;
      const expected = resolveRoleModel(config, 'opencode', roleName, ocAdapter);
      const onDisk = typeof fm.model === 'string' ? fm.model.trim() : '';
      if (expected.model && onDisk !== expected.model) {
        staleRoles.push(roleName);
      }
    } catch { /* skip unreadable files */ }
  }
  return staleRoles;
}

function hasLegacyCodexSkillOutput(repoRoot) {
  const skillsRoot = join(repoRoot, '.agents', 'skills');
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) return false;
  return readdirSync(skillsRoot).some(entry => {
    if (!entry.startsWith('agenticloop-')) return false;
    return existsSync(join(skillsRoot, entry, 'SKILL.md'));
  });
}

function artifactsPresent(repoRoot, host) {
  const present = [];
  if (host === 'opencode') {
    for (const relPath of Object.values(OPENCODE_AGENT_RELATIVE_PATHS)) {
      if (existsSync(join(repoRoot, relPath))) present.push(relPath);
    }
    if (existsSync(join(repoRoot, OPENCODE_COMMAND_RELATIVE_PATH))) present.push(OPENCODE_COMMAND_RELATIVE_PATH);
  }
  if (host === 'codex') {
    const repoLocalAgents = existsSync(join(repoRoot, '.codex', 'agents'));
    const repoLocalPublicSkill = existsSync(
      join(repoRoot, '.agents', 'skills', 'agenticloop', 'SKILL.md')
    );
    const pluginManifest = existsSync(
      join(repoRoot, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json')
    );
    const pluginMarketplace = existsSync(
      join(repoRoot, '.agents', 'plugins', 'marketplace.json')
    );
    const legacyPluginManifest = existsSync(join(repoRoot, '.codex-plugin', 'plugin.json'));
    const hasHostArtifacts =
      repoLocalAgents ||
      repoLocalPublicSkill ||
      pluginManifest;
    if (!hasHostArtifacts) return present;
    if (repoLocalAgents) present.push('.codex/agents/');
    if (repoLocalPublicSkill) present.push('.agents/skills/agenticloop/SKILL.md');
    if (pluginManifest) present.push('plugins/agenticloop/.codex-plugin/plugin.json');
    if (pluginMarketplace) present.push('.agents/plugins/marketplace.json');
    if (legacyPluginManifest) present.push('.codex-plugin/plugin.json (legacy)');
  }
  if (host === 'claude-code') {
    const hasHostArtifacts = existsSync(join(repoRoot, '.claude', 'agents'));
    if (!hasHostArtifacts) return present;
    if (existsSync(join(repoRoot, '.claude', 'agents'))) present.push('.claude/agents/');
    if (existsSync(join(repoRoot, '.claude', 'skills'))) present.push('.claude/skills/');
  }
  if (host === 'copilot') {
    const hasHostArtifacts = generatedCopilotArtifactsPresent(repoRoot);
    if (hasHostArtifacts.length === 0) return present;
    return hasHostArtifacts;
  }
  if (host === 'cursor') {
    const hasHostArtifacts = generatedCursorArtifactsPresent(repoRoot);
    if (hasHostArtifacts.length === 0) return present;
    return hasHostArtifacts;
  }
  return present;
}

/**
 * Build an advisory summary of adapter configuration and generated artifacts.
 *
 * @param {string} repoRoot
 * @returns {{ adapters: object[], nextSteps: string[] }}
 */
export function adapterDiscoverySummary(repoRoot) {
  const cfgPath = join(repoRoot, 'agenticloop.json');
  if (!existsSync(cfgPath)) {
    return {
      adapters: [],
      nextSteps: ['Run "agenticloop setup" to scaffold and configure Agentic Loop in this directory (advanced: "agenticloop init" for a files-only scaffold).'],
    };
  }

  let config;
  try {
    config = loadAgenticLoopConfig(cfgPath);
  } catch (e) {
    return {
      adapters: [],
      nextSteps: [`Fix agenticloop.json parse error: ${e.message}`],
    };
  }

  const roles = WORKFLOW_ROLE_IDS;
  const adapters = [];
  const generateSteps = [];
  const configureSteps = [];
  const requiredMissingModelSteps = [];
  const staleSteps = [];
  const copilotSteps = [];
  const cursorSteps = [];

  // Determine which adapters the target explicitly selected (not inherited)
  let targetAdapterHosts = new Set();
  try {
    const rawConfig = loadJsonFile(cfgPath);
    for (const host of Object.keys(rawConfig.adapters ?? {})) {
      targetAdapterHosts.add(host);
    }
  } catch { /* merged config already loaded above */ }

  // Build the relevant adapter set: target-selected + those with artifacts
  const relevantHosts = new Set(targetAdapterHosts);
  const IMPLEMENTED = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];
  for (const host of IMPLEMENTED) {
    if (relevantHosts.has(host)) continue;
    if (artifactsPresent(repoRoot, host).length > 0) relevantHosts.add(host);
  }

  for (const host of relevantHosts) {
    const adapterCfg = config.adapters?.[host] ?? {};
    const present = artifactsPresent(repoRoot, host);
    const { missing } = hasModelSettings(adapterCfg, roles);
    const required = adapterCfg?.enabled === true || adapterCfg?.required === true;

    adapters.push({
      host,
      status: adapterCfg?.status ?? 'placeholder',
      enabled: adapterCfg?.enabled === true,
      required,
      present,
      missingModelRoles: missing,
    });

    if (required && present.length === 0) {
      generateSteps.push(`Run "agenticloop generate ${host}" to produce required ${host} artifacts.`);
    }
    if ((present.length > 0 || required) && missing.length > 0) {
      configureSteps.push(
        `Configure ${host} models for roles: ${missing.join(', ')} (` +
        `e.g. "agenticloop configure models --adapter ${host} --role <role> --model <id>").`
      );
    }
    if (required && missing.length > 0) {
      requiredMissingModelSteps.push(
        `Required adapter ${host} is missing model settings for: ${missing.join(', ')}.`
      );
    }
    if (host === 'opencode' && present.length > 0) {
      const staleRoles = detectStaleOpencodeModels(repoRoot, config);
      if (staleRoles.length > 0) {
        staleSteps.push(
          `Generated OpenCode artifacts are stale for roles: ${staleRoles.join(', ')}; run 'agenticloop update --adapter opencode'.`
        );
      }
    }
    if (host === 'codex' && hasLegacyCodexSkillOutput(repoRoot)) {
      staleSteps.push(
        'Regenerate Codex to replace stale legacy skill output such as `.agents/skills/agenticloop-start/SKILL.md` with the single public `.agents/skills/agenticloop/` skill.'
      );
    }
    if (host === 'copilot' && present.length > 0) {
      copilotSteps.push('In Copilot CLI, invoke `/agenticloop` to activate Agentic Loop explicitly; use the generated prompt file only in Copilot IDE prompt-file surfaces.');
    }
    if (host === 'cursor' && present.length > 0) {
      cursorSteps.push('In Cursor Agent chat, invoke `/agenticloop` to activate Agentic Loop explicitly.');
    }
  }

  const nextSteps = [
    ...generateSteps,
    ...configureSteps,
    ...requiredMissingModelSteps,
    ...staleSteps,
  ];

  if (adapters.length === 0) {
    nextSteps.push('No adapters configured. Run "agenticloop setup --adapter <host>" for guided host integration, or "agenticloop init --adapter <host>" for the direct scaffold.');
  }

  if (nextSteps.length === 0) {
    const hasRequired = adapters.some(a => a.required);
    const optionalAbsent = adapters.filter(a => !a.required && a.present.length === 0);
    if (!hasRequired && optionalAbsent.length > 0) {
      nextSteps.push('No required adapter work is pending. Optional adapters have no generated artifacts.');
    } else {
      nextSteps.push('All required adapters have generated artifacts and model settings. Run "agenticloop validate" to verify.');
    }
  }

  nextSteps.push(...copilotSteps, ...cursorSteps);

  return { adapters, nextSteps };
}

/**
 * Print the discovery summary to stdout in a human-readable form.
 *
 * @param {string} repoRoot
 */
export function printAdapterDiscovery(repoRoot, io = createIo()) {
  const { adapters, nextSteps } = adapterDiscoverySummary(repoRoot);

  io.out();
  io.out('agenticloop adapter discovery');
  io.out('='.repeat(50));

  if (adapters.length === 0) {
    io.out('  No adapters configured.');
  } else {
    for (const a of adapters) {
      const present = a.present.length > 0 ? a.present.join(', ') : '(none)';
      const missing = a.missingModelRoles.length > 0 ? `missing models: ${a.missingModelRoles.join(', ')}` : 'models configured';
      const flag = a.required ? ' [required]' : '';
      io.out(`  ${a.host}: ${a.status}${flag}`);
      io.out(`    artifacts: ${present}`);
      io.out(`    ${missing}`);
    }
  }

  io.out();
  io.out('Next steps:');
  for (const step of nextSteps) {
    io.out(`  - ${step}`);
  }
  io.out();
}

/**
 * Print the onboarding doctor view: setup checklist + adapter status + next commands.
 * Never writes files.
 *
 * @param {string} repoRoot
 */
export function printDoctor(repoRoot, io = createIo()) {
  const state = detectSetupState(repoRoot, { includeValidation: true });

  io.out();
  io.out('agenticloop doctor');
  io.out('='.repeat(50));
  io.out();
  io.out(formatSetupChecklist(state));

  if (state.validationIssues && state.validationIssues.length > 0) {
    io.out();
    io.out('Issues:');
    for (const issue of state.validationIssues) {
      io.out(`  - ${issue}`);
    }
  }

  const { adapters: adapterSummary, nextSteps: adapterSteps } = adapterDiscoverySummary(repoRoot);
  if (adapterSummary.length > 0) {
    io.out();
    io.out('Adapters:');
    for (const a of adapterSummary) {
      const present = a.present.length > 0 ? a.present.join(', ') : '(none)';
      const missing = a.missingModelRoles.length > 0 ? `missing models: ${a.missingModelRoles.join(', ')}` : 'models configured';
      const flag = a.required ? ' [required]' : '';
      io.out(`  ${a.host}: ${a.status}${flag}`);
      io.out(`    artifacts: ${present}`);
      io.out(`    ${missing}`);
    }
  }

  io.out();
  io.out(formatGitGuardDoctor(repoRoot));

  const compatibility = diagnoseLifecycleCompatibility(repoRoot);
  if (compatibility.length > 0) {
    io.out();
    io.out('Lifecycle compatibility:');
    for (const finding of compatibility) io.out(`  - ${finding.path}: ${compatibilityMessage(finding)}`);
  }

  // Audit-due diagnostics: deterministic only where work-unit membership is
  // derivable (files backend, grouped projects). Reporting a due state is
  // diagnostic output, never a doctor failure.
  const auditDue = deriveAuditDueWorkUnits(repoRoot, loadProjectMap(repoRoot)?.config);
  if (auditDue.length > 0) {
    io.out();
    io.out('Work-unit audit:');
    for (const entry of auditDue) {
      if (entry.state === 'indeterminate') {
        io.out(`  - scope indeterminate: ${entry.reason}`);
      } else {
        io.out(`  - ${entry.workUnit}: audit due (${entry.tasks.length} accepted/closed covered tasks, no audit record)`);
      }
    }
  }

  const steps = nextStepsFromState(state);
  io.out();
  io.out('Next steps:');
  for (const step of steps) {
    io.out(`  - ${step}`);
  }
  io.out();
}
