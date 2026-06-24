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

export const AGENTIC_LOOP_OPERATION_DESCRIPTION =
  'Operate in Agentic Loop mode: create or refine the durable task record, route maintainer and engineer roles, verify evidence, and close out according to the project backend.';

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
  const roles = alConfig.roles ?? {};
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

  for (const roleName of Object.keys(roles)) {
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
  const variant = adapterSettings.reasoningEffort
    ?? adapterSettings.variant
    ?? roleCfg.reasoningEffort
    ?? roleCfg.variant
    ?? 'auto';

  let source;
  if (adapterSettings.model || adapterSettings.reasoningEffort || adapterSettings.variant) {
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
 * Compute a target-relative file path for an instruction entry. Adapters
 * that copy skills into host skill directories (Claude Code, Codex)
 * need to translate canonical `skills/<name>/SKILL.md` paths to their
 * host-specific equivalent.
 */
export function relPath(p) {
  return relative('.', p).replace(/\\/g, '/');
}
