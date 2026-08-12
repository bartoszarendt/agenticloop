/**
 * Shared adapter input collection for Agentic Loop host adapters.
 *
 * Adapters render host-native config (OpenCode, Codex, Claude Code) from
 * canonical sources:
 *   - documents from config.documents
 *   - role source files from agents/<role>.md
 *   - skill references from skills/<name>/SKILL.md
 *   - backend projection docs from backends/
 *   - adapter bindings and per-host role model settings
 *
 * No adapter may duplicate role prompts or skill bodies into tracked source.
 * Generated content is produced from these inputs and lives under target-owned
 * generated paths (for example, .agenticloop/tmp/ for toolkit verification, or root
 * .opencode/ / .codex/ / .claude/ for downstream consumers).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { resolveDocumentSelections } from '../document-roles.js';
import {
  AGENTS_SOURCE_DIRECTORY,
  BACKENDS_SOURCE_DIRECTORY,
  SKILLS_SOURCE_DIRECTORY,
  resolveToolkitAssetLayout,
  resolveToolkitAssetPath,
} from '../layout.js';
import { loadProjectMap } from '../project-map.js';
import { WORKFLOW_ROLE_IDS } from '../workflow-roles.js';

export const AGENTIC_LOOP_OPERATION_DESCRIPTION =
  'Use only when the user explicitly asks to activate Agentic Loop: create or refine the durable task record, route maintainer, engineer, and auditor roles, verify evidence, certify the finished work unit, and close out according to the project backend.';

// Dual-mode engineer preamble prepended by host adapters that customize the
// engineer developer instructions (Codex, Copilot, Cursor). Kept compact for
// payload budgets. The canonical role body carries the full contract.
export const STANDALONE_ENGINEER_PREAMBLE_LINES = Object.freeze([
  'Engineer mode selection: use full Agentic Loop mode only when the delegation explicitly activates Agentic Loop or names a durable Agentic Loop task record as the contract; otherwise operate as a standalone engineer.',
  'A bare task ID does not force Agentic Loop mode. Standalone engineer work requires no task ID or task record and creates no Agentic Loop task records, events, worktrees, pull requests, review, or closeout state.',
  'Do not perform final maintainer acceptance in either mode. Stay within engineer boundaries: implement the delegated scope, run checks, and return fresh evidence.',
]);

// Dual-mode auditor preamble prepended by host adapters that customize the
// auditor instructions (Codex, Copilot, Cursor, OpenCode). Kept compact for
// payload budgets. The canonical role body carries the full contract.
export const STANDALONE_AUDITOR_PREAMBLE_LINES = Object.freeze([
  'Auditor mode selection: use full Agentic Loop mode only when the delegation explicitly activates Agentic Loop or explicitly asks to certify or re-audit a tracked Agentic Loop work unit against a designated Agentic Loop audit record or audit packet; otherwise operate as a standalone auditor.',
  'A bare task ID, audit ID, work-unit name, or commit SHA does not force Agentic Loop mode. Standalone assessment requires no audit packet or audit record, creates no Agentic Loop workflow state, and missing packet metadata is not a blocker. If formal certification intent is explicit but its packet is missing or ambiguous, stay in Agentic Loop mode and return `needs_human_decision` rather than downgrading to standalone.',
  'Certification firewall: a standalone assessment is non-certifying. Report scope, findings and evidence, checks run and limitations, and state that it certifies nothing and that formal certification requires a fresh packet-bound Agentic Loop Auditor invocation. Do not return `auditor_report_v1` or an Agentic Loop verdict as the standalone result. You are read-only in both modes: implement no remediation, and edit no implementation, tests, configuration, documentation, task records, audit records, or workflow state.',
]);

// Roles whose generated prompt must select a mode before any Agentic Loop
// workflow-state instruction, so a standalone delegation is never ordered to
// adopt the methodology by prompt ordering alone.
const DUAL_MODE_ROLE_IDS = Object.freeze(['engineer', 'auditor']);

/** @param {string} roleName */
export function isDualModeRole(roleName) {
  return DUAL_MODE_ROLE_IDS.includes(roleName);
}

/**
 * Canonical mode-selection preamble for a dual-mode role, or an empty list for
 * single-mode roles. Adapters share this so mode-selection wording is authored
 * once rather than duplicated per host.
 *
 * @param {string} roleName
 * @returns {string[]}
 */
export function dualModePreambleLines(roleName) {
  if (roleName === 'engineer') return [...STANDALONE_ENGINEER_PREAMBLE_LINES];
  if (roleName === 'auditor') return [...STANDALONE_AUDITOR_PREAMBLE_LINES];
  return [];
}

/**
 * Read a role source file and return its frontmatter description and body.
 * @param {string} repoRoot
 * @param {string} sourceFile
 */
export function readRoleSource(repoRoot, sourceFile) {
  const full = resolveToolkitAssetPath(repoRoot, sourceFile, resolveToolkitAssetLayout(repoRoot));
  if (!existsSync(full)) {
    return { description: '', body: '', exists: false };
  }
  const content = readFileSync(full, 'utf-8');
  const [fm, body] = parseFrontmatter(content);
  return {
    description: fm?.description ?? '',
    body: body.trim(),
    exists: true,
  };
}

/**
 * Collect instruction-style paths for an adapter. This is the union of:
 *   - configured required documents that exist on disk
 *   - the process overlay document
 *   - one role file per configured role that exists
 *   - backends/README.md and the active backend projection from project.md
 *     (or both projections when no project map exists)
 *   - role-delegation skill (always present for the orchestrator workflow)
 *
 * @param {object} alConfig   Parsed agenticloop.json.
 * @param {string} repoRoot   Absolute path to the repository root.
 * @returns {string[]}        Deduplicated, order-preserving list of relative paths.
 */
export function collectInstructionPaths(alConfig, repoRoot) {
  const assetLayout = resolveToolkitAssetLayout(repoRoot);
  const agentsSrc = alConfig.agents?.sourceDirectory ?? AGENTS_SOURCE_DIRECTORY;
  const backendsSrc = alConfig.backends?.sourceDirectory ?? BACKENDS_SOURCE_DIRECTORY;
  const skillsSrc = alConfig.skills?.sourceDirectory ?? SKILLS_SOURCE_DIRECTORY;
  const paths = [];
  const projectMap = loadProjectMap(repoRoot);
  const documentSelections = resolveDocumentSelections(
    repoRoot,
    alConfig,
    projectMap?.raw?.documents
  );

  for (const docPath of Object.values(documentSelections)) {
    if (existsSync(resolveToolkitAssetPath(repoRoot, docPath, assetLayout))) paths.push(docPath);
  }

  for (const roleName of WORKFLOW_ROLE_IDS) {
    const roleFile = `${agentsSrc}/${roleName}.md`;
    if (existsSync(resolveToolkitAssetPath(repoRoot, roleFile, assetLayout))) paths.push(roleFile);
  }

  const backendsReadme = `${backendsSrc}/README.md`;
  if (existsSync(resolveToolkitAssetPath(repoRoot, backendsReadme, assetLayout))) paths.push(backendsReadme);
  const activeBackend = projectMap?.config?.task_backend;
  const backendKeys = activeBackend === 'github' || activeBackend === 'files'
    ? [activeBackend]
    : ['github', 'files'];
  for (const key of backendKeys) {
    const proj = alConfig.backends?.[key]?.projection;
    if (proj && existsSync(resolveToolkitAssetPath(repoRoot, proj, assetLayout))) paths.push(proj);
  }

  const rdSkill = `${skillsSrc}/role-delegation/SKILL.md`;
  if (existsSync(resolveToolkitAssetPath(repoRoot, rdSkill, assetLayout))) paths.push(rdSkill);

  const seen = new Set();
  return paths.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

/**
 * Resolve the model and variant for a given role, applying adapter-local
 * settings first, then legacy role.model / role.reasoningEffort / role.variant
 * from the top-level config. Adapters that need host-specific model tiers
 * should still funnel through this helper so the resolution rules stay
 * consistent across hosts.
 *
 * @param {object} alConfig
 * @param {string} host
 * @param {string} roleName
 * @param {object} [adapterCfg]
 * @returns {{ model: string, variant: string, source: string }}
 */
export function resolveRoleModel(alConfig, host, roleName, adapterCfg) {
  const adapterSettings = adapterCfg?.roleSettings?.[roleName] ?? {};
  const roleCfg = alConfig.roles?.[roleName] ?? {};

  const model = adapterSettings.model
    ?? roleCfg.model
    ?? '';
  const reasoningUsesDefault = adapterSettings.reasoningEffortDefault === true;
  const variant = reasoningUsesDefault
    ? 'auto'
    : adapterSettings.reasoningEffort
      ?? adapterSettings.variant
      ?? roleCfg.reasoningEffort
      ?? roleCfg.variant
      ?? 'auto';

  let source;
  if (
    adapterSettings.model ||
    adapterSettings.reasoningEffort ||
    adapterSettings.variant ||
    reasoningUsesDefault
  ) {
    source = `adapters.${host}.roleSettings.${roleName}`;
  } else if (roleCfg.model || roleCfg.reasoningEffort || roleCfg.variant) {
    source = `roles.${roleName}`;
  } else {
    source = 'default';
  }

  return { model, variant, source };
}

/**
 * Build a role-aware agent record for adapters. Adapters can call this
 * helper to compose the role description, prompt body, and skill list
 * without each adapter re-implementing the same text shaping.
 *
 * @param {object} alConfig
 * @param {string} roleName
 * @returns {{ description: string, sourceFile: string, promptBody: string, requiredSkills: string[] }}
 */
export function buildRoleRecord(alConfig, repoRoot, roleName) {
  const roleCfg = alConfig.roles?.[roleName] ?? {};
  const agentsSrc = alConfig.agents?.sourceDirectory ?? AGENTS_SOURCE_DIRECTORY;
  const sourceFile = roleCfg.sourceFile ?? `${agentsSrc}/${roleName}.md`;
  const { description, body } = readRoleSource(repoRoot, sourceFile);
  return {
    description: roleCfg.description || description,
    sourceFile,
    promptBody: body,
    requiredSkills: roleCfg.requiredSkills ?? [],
  };
}

/**
 * Read the canonical skill directories under the configured skills source.
 * Each entry exposes the canonical skill name (frontmatter `name`, falling back
 * to the directory name), the absolute source directory, and the source
 * `SKILL.md` path. Adapters that render a single public skill plus internal
 * `reference.md` procedure copies (Codex, Claude Code) share this reader so the
 * discovery and ordering rules stay identical across hosts.
 *
 * @param {string} repoRoot
 * @param {object} alConfig
 * @returns {{ canonicalName: string, sourceDir: string, skillFile: string }[]}
 */
export function readCanonicalSkillEntries(repoRoot, alConfig) {
  const assetLayout = resolveToolkitAssetLayout(repoRoot);
  const skillsSrc = alConfig.skills?.sourceDirectory ?? SKILLS_SOURCE_DIRECTORY;
  const srcDir = resolveToolkitAssetPath(repoRoot, skillsSrc, assetLayout);
  if (!existsSync(srcDir)) return [];

  const entries = [];
  for (const entry of readdirSync(srcDir)) {
    const sourceDir = join(srcDir, entry);
    if (!statSync(sourceDir).isDirectory()) continue;
    const skillFile = join(sourceDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const [frontmatter] = parseFrontmatter(readFileSync(skillFile, 'utf-8'));
    entries.push({
      canonicalName: frontmatter?.name ?? entry,
      sourceDir,
      skillFile,
    });
  }

  return entries.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
}

/**
 * Read the canonical backend projection docs under the configured backends
 * source. Each entry exposes the source filename and its absolute path, sorted
 * by filename so generated reference indexes are stable across hosts.
 *
 * Discovery goes through `resolveToolkitAssetPath`, exactly like
 * `readCanonicalSkillEntries`, because `repoRoot` here is whichever root the
 * caller is reading assets from and that root has two shapes: an installed
 * target (assets under `agenticloop/`) or a package source root (assets at the
 * top level). Fresh atomic init reads from the package source root, so joining
 * the target-facing `agenticloop/backends` prefix onto it silently finds
 * nothing - and an adapter that renders zero backend references emits dangling
 * bare backend paths that only fail later, during installed validation.
 *
 * @param {string} repoRoot
 * @param {object} alConfig
 * @returns {{ filename: string, sourceFile: string }[]}
 */
export function readCanonicalBackendEntries(repoRoot, alConfig) {
  const backendsSrc = alConfig.backends?.sourceDirectory ?? BACKENDS_SOURCE_DIRECTORY;
  const srcDir = resolveToolkitAssetPath(repoRoot, backendsSrc, resolveToolkitAssetLayout(repoRoot));
  if (!existsSync(srcDir)) return [];

  const entries = [];
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith('.md')) continue;
    const sourceFile = join(srcDir, entry);
    if (!statSync(sourceFile).isFile()) continue;
    entries.push({ filename: entry, sourceFile });
  }

  return entries.sort((a, b) => a.filename.localeCompare(b.filename));
}

/**
 * Compute a target-relative file path for an instruction entry. Adapters
 * that copy skills into host skill directories (Claude Code, Codex)
 * need to translate canonical `skills/<name>/SKILL.md` paths to their
 * host-specific equivalent.
 */
export function relPath(p) {
  return relative('.', p).replace(/\\/g, '/');
}

/**
 * Walk a source skill tree and produce write-file plan actions.
 * SKILL.md files are transformed via transformFn (renamed to reference.md);
 * all other files are copied as-is.
 *
 * @param {string} sourceDir     Absolute path to the source skill directory.
 * @param {string} destRelPath   Relative path prefix for the destination.
 * @param {string} adapter       Adapter name for the actions.
 * @param {(content: string, srcPath: string) => string} [transformFn]  Transforms SKILL.md content.
 * @param {string} [marker]      Generated marker text.
 * @param {string} [currentSrc]  Current source directory (for recursion).
 * @param {string} [currentDest] Current destination rel path (for recursion).
 * @returns {Array<{ type: 'write-file', adapter: string, relPath: string, content: string, marker?: string }>}
 */
export function planReferenceTree(sourceDir, destRelPath, adapter, transformFn, marker, currentSrc, currentDest) {
  const actions = [];
  const src = currentSrc ?? sourceDir;
  const dest = currentDest ?? destRelPath;

  for (const entry of readdirSync(src)) {
    const srcEntry = join(src, entry);
    const entryStat = statSync(srcEntry);

    if (entryStat.isDirectory()) {
      actions.push(...planReferenceTree(
        sourceDir, destRelPath, adapter, transformFn, marker, srcEntry, `${dest}/${entry}`
      ));
      continue;
    }

    const destName = entry === 'SKILL.md' ? 'reference.md' : entry;
    const destRel = `${dest}/${destName}`;
    const content = readFileSync(srcEntry, 'utf-8');

    if (entry === 'SKILL.md' && transformFn) {
      actions.push({
        type: 'write-file',
        adapter,
        relPath: destRel,
        content: transformFn(content, srcEntry),
        marker,
      });
    } else {
      actions.push({
        type: 'write-file',
        adapter,
        relPath: destRel,
        content,
      });
    }
  }

  return actions;
}
