/**
 * Workflow capability bindings: the single place role ownership of diagnostic
 * repair is resolved.
 *
 * Canonical role Markdown (`agents/*.md` or an installed
 * `agenticloop/agents/*.md`) declares `primary_repair_capabilities` and
 * `escalation_capabilities` in frontmatter. Bindings are resolved once and
 * memoized per directory; diagnostic evaluation never reads role Markdown.
 *
 * `human_authority` is an authority boundary, not an agent role: escalation
 * kinds with the `human_authority` prefix resolve to that boundary and no
 * role may claim them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.js';
import { ESCALATION_KINDS, HUMAN_AUTHORITY_ESCALATION_PREFIX, REPAIR_KINDS } from './repair-policy.js';
import { WORKFLOW_ROLES } from './workflow-vocabulary.js';

export const HUMAN_AUTHORITY_BOUNDARY = 'human_authority';

const TOOLKIT_AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));
const REPAIR_KIND_SET = new Set(REPAIR_KINDS);
const ESCALATION_KIND_SET = new Set(ESCALATION_KINDS);

function capabilityList(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => String(item ?? '').trim()).filter(Boolean);
}

/**
 * Load and validate role capability bindings from a directory of role
 * Markdown files. Returns `{ ok, errors, primaryOwnerByRepairKind,
 * escalationOwnerByKind, roles }` without throwing so callers (and tests)
 * can report every violation at once.
 */
export function loadRoleCapabilities(agentsDir, { roles = WORKFLOW_ROLES } = {}) {
  const errors = [];
  const primaryClaims = new Map();
  const escalationClaims = new Map();
  const claim = (map, kind, role) => {
    if (!map.has(kind)) map.set(kind, []);
    map.get(kind).push(role);
  };
  const presentRoles = [];
  for (const role of roles) {
    const path = join(agentsDir, `${role}.md`);
    if (!existsSync(path)) {
      errors.push(`role capability source is missing: ${path}`);
      continue;
    }
    presentRoles.push(role);
    const [frontmatter] = parseFrontmatter(readFileSync(path, 'utf8'));
    for (const kind of capabilityList(frontmatter?.primary_repair_capabilities)) {
      if (!REPAIR_KIND_SET.has(kind)) {
        errors.push(`role '${role}' declares unknown primary repair capability '${kind}'`);
        continue;
      }
      claim(primaryClaims, kind, role);
    }
    for (const kind of capabilityList(frontmatter?.escalation_capabilities)) {
      if (kind === 'none' || kind.startsWith(HUMAN_AUTHORITY_ESCALATION_PREFIX) || !ESCALATION_KIND_SET.has(kind)) {
        errors.push(`role '${role}' declares unknown escalation capability '${kind}'`);
        continue;
      }
      claim(escalationClaims, kind, role);
    }
  }
  const primaryOwnerByRepairKind = {};
  for (const kind of REPAIR_KINDS) {
    const claimants = primaryClaims.get(kind) ?? [];
    if (claimants.length === 0) errors.push(`repair kind '${kind}' has no primary owner`);
    if (claimants.length > 1) errors.push(`repair kind '${kind}' has multiple primary owners: ${claimants.join(', ')}`);
    if (claimants.length === 1) primaryOwnerByRepairKind[kind] = claimants[0];
  }
  const escalationOwnerByKind = {};
  for (const kind of ESCALATION_KINDS) {
    if (kind === 'none') {
      escalationOwnerByKind[kind] = null;
      continue;
    }
    if (kind.startsWith(HUMAN_AUTHORITY_ESCALATION_PREFIX)) {
      escalationOwnerByKind[kind] = HUMAN_AUTHORITY_BOUNDARY;
      continue;
    }
    const claimants = escalationClaims.get(kind) ?? [];
    if (claimants.length === 0) {
      errors.push(`escalation kind '${kind}' cannot be resolved to a role or the human authority boundary`);
      continue;
    }
    // Escalation/fallback capabilities may overlap; resolution is the first
    // claimant in canonical role order.
    escalationOwnerByKind[kind] = roles.find(role => claimants.includes(role)) ?? claimants[0];
  }
  return {
    ok: errors.length === 0,
    errors,
    primaryOwnerByRepairKind,
    escalationOwnerByKind,
    roles: presentRoles,
  };
}

const capabilityCache = new Map();
const legacyProjectCapabilityCache = new Map();

function capabilityDeclarationState(agentsDir, roles = WORKFLOW_ROLES) {
  let declarations = 0;
  let missing = 0;
  for (const role of roles) {
    const path = join(agentsDir, `${role}.md`);
    if (!existsSync(path)) {
      missing += 1;
      continue;
    }
    const [frontmatter] = parseFrontmatter(readFileSync(path, 'utf8'));
    if (Object.hasOwn(frontmatter ?? {}, 'primary_repair_capabilities') ||
        Object.hasOwn(frontmatter ?? {}, 'escalation_capabilities')) {
      declarations += 1;
    }
  }
  return {
    legacy: missing === 0 && declarations === 0,
    declarations,
    missing,
  };
}

function legacyCapabilityWarning(agentsDir) {
  return `role files in '${agentsDir}' predate capability bindings; bundled role capabilities are in use until the installed toolkit is refreshed`;
}

/**
 * Memoized bindings for a role directory. Throws with the full validation
 * error list when bindings are invalid; diagnostic evaluation itself never
 * calls this — only CLI startup/presentation does.
 */
export function getRoleCapabilities(agentsDir) {
  const key = resolve(agentsDir);
  if (!capabilityCache.has(key)) {
    const bindings = loadRoleCapabilities(key);
    if (!bindings.ok) throw new Error(`invalid role capability bindings:\n${bindings.errors.join('\n')}`);
    capabilityCache.set(key, bindings);
  }
  return capabilityCache.get(key);
}

/**
 * Resolve the canonical role directory for a target project: an installed
 * `agenticloop/agents/`, a repo-root `agents/`, or the toolkit's own roles.
 */
export function resolveAgentsDir(target) {
  for (const candidate of [
    join(target, 'agenticloop', 'agents'),
    join(target, 'agents'),
    TOOLKIT_AGENTS_DIR,
  ]) {
    if (existsSync(join(candidate, 'maintainer.md'))) return candidate;
  }
  return TOOLKIT_AGENTS_DIR;
}

/** Memoized capability bindings for a target project root. */
export function getProjectRoleCapabilities(target) {
  const agentsDir = resolveAgentsDir(target ?? dirname(TOOLKIT_AGENTS_DIR));
  if (resolve(agentsDir) !== resolve(TOOLKIT_AGENTS_DIR) && capabilityDeclarationState(agentsDir).legacy) {
    const key = resolve(agentsDir);
    if (!legacyProjectCapabilityCache.has(key)) {
      legacyProjectCapabilityCache.set(key, {
        ...getRoleCapabilities(TOOLKIT_AGENTS_DIR),
        warnings: [legacyCapabilityWarning(agentsDir)],
        sourceAgentsDir: TOOLKIT_AGENTS_DIR,
        legacyAgentsDir: agentsDir,
      });
    }
    return legacyProjectCapabilityCache.get(key);
  }
  return getRoleCapabilities(agentsDir);
}

/**
 * Validate the role capabilities selected for a target without throwing.
 * Fully legacy installed role sets receive a bounded migration warning and
 * bundled bindings; partial declarations are validated strictly.
 */
export function validateProjectRoleCapabilities(target) {
  const agentsDir = resolveAgentsDir(target ?? dirname(TOOLKIT_AGENTS_DIR));
  const declaration = capabilityDeclarationState(agentsDir);
  if (resolve(agentsDir) !== resolve(TOOLKIT_AGENTS_DIR) && declaration.legacy) {
    return { errors: [], warnings: [legacyCapabilityWarning(agentsDir)], agentsDir, usingBundledFallback: true };
  }
  const bindings = loadRoleCapabilities(agentsDir);
  return { errors: bindings.errors, warnings: [], agentsDir, usingBundledFallback: false };
}
