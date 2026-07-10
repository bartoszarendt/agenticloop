/**
 * Claude Code host adapter.
 *
 * Status: supported.
 *
 * Claude Code supports:
 *   - Project commands under .claude/commands/*.md.
 *   - Project agents under .claude/agents/*.md.
 *   - Project skills under .claude/skills/<name>/SKILL.md.
 *
 * Repo-local activation exposes one public Agentic Loop skill. Internal
 * Agentic Loop procedures are packaged as non-discoverable `reference.md`
 * copies under the public skill's references directory so the Claude skill
 * picker stays clean and does not show every canonical procedure as a skill.
 *
 * Generated artifacts (relative to the chosen output directory):
 *   .claude/commands/agenticloop.md
 *   .claude/agents/orchestrator.md
 *   .claude/agents/maintainer.md
 *   .claude/agents/engineer.md
 *   .claude/skills/agenticloop/SKILL.md                         (one public skill)
 *   .claude/skills/agenticloop/references/skills/<skill>/reference.md
 *   .claude/settings.local.json or .claude/settings.json
 *
 * Agent files are rendered from canonical role files; they are not hand
 * rewritten. The model alias comes from
 *   adapters.claude-code.roleSettings.<role>.model
 * with a legacy fallback to roles.<role>. Model identifiers are
 * host/provider specific and do not live in agents/*.md.
 *
 * Claude Code subagent frontmatter supports name/description/tools/model/
 * permissionMode. Reasoning effort is intentionally not rendered because
 * Claude Code ignores it there; reasoningEffort stays meaningful for the
 * opencode and codex adapters only.
 */

import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { PROCESS_DOC_RELATIVE_PATH, bundledToolkitPath } from '../layout.js';
import {
  AGENTIC_LOOP_OPERATION_DESCRIPTION,
  buildRoleRecord,
  resolveRoleModel,
  readCanonicalSkillEntries,
} from './shared.js';

const CLAUDE_CODE_START_COMMAND = bundledToolkitPath('agenticloop/commands/start.md');

const CLAUDE_PUBLIC_SKILL_NAME = 'agenticloop';

// Internal procedures surfaced in the public skill's reference index. These are
// the procedures a coordinating Claude Code session most often needs; every
// canonical skill is still copied as a reference under references/skills/.
const CLAUDE_REQUIRED_PUBLIC_REFERENCES = [
  'role-delegation',
  'task-record-contract',
  'setup-agenticloop',
  'blocked-state',
];

const VALID_CLAUDE_CODE_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]);

const VALID_CLAUDE_CODE_PERMISSION_SCOPES = new Set(['project', 'local']);

const DEFAULT_CLAUDE_CODE_PERMISSION_MODE_BY_ROLE = {
  maintainer: 'acceptEdits',
  engineer: 'acceptEdits',
};

const DEFAULT_CLAUDE_CODE_PERMISSIONS = {
  scope: 'project',
  allow: [
    'Bash(npx agenticloop *)',
    'Bash(npm test *)',
    'Bash(npm run test *)',
    'Bash(npm run build *)',
    'Bash(git status *)',
    'Bash(git diff *)',
    'Bash(git add *)',
    'Bash(git commit *)',
    'Bash(git log *)',
    'PowerShell(npx agenticloop *)',
    'PowerShell(npm test *)',
    'PowerShell(npm run test *)',
    'PowerShell(npm run build *)',
    'PowerShell(git status *)',
    'PowerShell(git diff *)',
    'PowerShell(git add *)',
    'PowerShell(git commit *)',
    'PowerShell(git log *)',
  ],
  deny: [],
};

const CLAUDE_CODE_PERMISSION_PROFILES = {
  agenticloop: [
    'Bash(git *)',
    'Bash(gh *)',
    'Bash(npm *)',
    'Bash(npx *)',
    'Bash(pytest *)',
    'Bash(python -m pytest *)',
    'Bash(python -m ruff *)',
    'Bash(ruff *)',
    'Bash(python -m alembic *)',
    'Bash(alembic *)',
    'PowerShell(git *)',
    'PowerShell(gh *)',
    'PowerShell(npm *)',
    'PowerShell(npx *)',
    'PowerShell(pytest *)',
    'PowerShell(python -m pytest *)',
    'PowerShell(python -m ruff *)',
    'PowerShell(ruff *)',
    'PowerShell(python -m alembic *)',
    'PowerShell(alembic *)',
    'Bash(npx agenticloop *)',
    'Bash(npm test *)',
    'Bash(npm run test *)',
    'Bash(npm run build *)',
    'Bash(git status *)',
    'Bash(git diff *)',
    'Bash(git add *)',
    'Bash(git commit *)',
    'Bash(git log *)',
    'PowerShell(npx agenticloop *)',
    'PowerShell(npm test *)',
    'PowerShell(npm run test *)',
    'PowerShell(npm run build *)',
    'PowerShell(git status *)',
    'PowerShell(git diff *)',
    'PowerShell(git add *)',
    'PowerShell(git commit *)',
    'PowerShell(git log *)',
  ],
};

function dedupe(values) {
  return [...new Set((values ?? []).filter(value => typeof value === 'string'))];
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatClaudeCodePermissionModes() {
  return [...VALID_CLAUDE_CODE_PERMISSION_MODES].join(', ');
}

function formatClaudeCodePermissionProfiles() {
  return Object.keys(CLAUDE_CODE_PERMISSION_PROFILES).join(', ');
}

function formatClaudeCodePermissionScopes() {
  return [...VALID_CLAUDE_CODE_PERMISSION_SCOPES].join(', ');
}

function validateClaudeCodePermissionMode(value, configPath) {
  if (!VALID_CLAUDE_CODE_PERMISSION_MODES.has(value)) {
    throw new Error(
      `${configPath} must be one of: ${formatClaudeCodePermissionModes()}; ` +
      `got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function optionalPermissionArray(value, configPath) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${configPath} must be an array when provided`);
  }
  return value;
}

function resolveClaudeCodePermissionProfile(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('adapters.claude-code.permissions.profile must be a string when provided');
  }
  const profilePermissions = CLAUDE_CODE_PERMISSION_PROFILES[value];
  if (!profilePermissions) {
    throw new Error(
      `adapters.claude-code.permissions.profile must be one of: ` +
      `${formatClaudeCodePermissionProfiles()}; got ${JSON.stringify(value)}`
    );
  }
  return profilePermissions;
}

function resolveClaudeCodePermissionScope(value) {
  if (value === undefined || value === null) {
    return DEFAULT_CLAUDE_CODE_PERMISSIONS.scope;
  }
  if (!VALID_CLAUDE_CODE_PERMISSION_SCOPES.has(value)) {
    throw new Error(
      `adapters.claude-code.permissions.scope must be one of: ` +
      `${formatClaudeCodePermissionScopes()}; got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function claudeCodeSettingsRelativePath(scope) {
  return scope === 'local' ? '.claude/settings.local.json' : '.claude/settings.json';
}

function readExistingClaudeCodePermissions(existingSettings, settingsRelativePath) {
  if (existingSettings.permissions === undefined) {
    return {};
  }
  if (!isPlainObject(existingSettings.permissions)) {
    throw new Error(`Invalid ${settingsRelativePath}: permissions must be an object when provided`);
  }
  if (
    existingSettings.permissions.allow !== undefined &&
    !Array.isArray(existingSettings.permissions.allow)
  ) {
    throw new Error(`Invalid ${settingsRelativePath}: permissions.allow must be an array when provided`);
  }
  if (
    existingSettings.permissions.deny !== undefined &&
    !Array.isArray(existingSettings.permissions.deny)
  ) {
    throw new Error(`Invalid ${settingsRelativePath}: permissions.deny must be an array when provided`);
  }
  return existingSettings.permissions;
}

function resolveClaudeCodePermissions(ccAdapter) {
  const configured = ccAdapter.permissions;
  if (configured === false || configured === null) {
    return null;
  }

  if (configured !== undefined && !isPlainObject(configured)) {
    throw new Error('adapters.claude-code.permissions must be an object, false, or null');
  }

  const profileAllow = resolveClaudeCodePermissionProfile(configured?.profile);
  const resolved = {
    scope: resolveClaudeCodePermissionScope(configured?.scope),
    allow: dedupe(profileAllow ?? DEFAULT_CLAUDE_CODE_PERMISSIONS.allow),
    deny: [...DEFAULT_CLAUDE_CODE_PERMISSIONS.deny],
  };

  if (!configured) {
    return resolved;
  }

  resolved.allow = dedupe([
    ...(profileAllow ?? DEFAULT_CLAUDE_CODE_PERMISSIONS.allow),
    ...optionalPermissionArray(configured.allow, 'adapters.claude-code.permissions.allow'),
  ]);
  resolved.deny = dedupe([
    ...DEFAULT_CLAUDE_CODE_PERMISSIONS.deny,
    ...optionalPermissionArray(configured.deny, 'adapters.claude-code.permissions.deny'),
  ]);
  if (configured.defaultMode !== undefined) {
    resolved.defaultMode = validateClaudeCodePermissionMode(
      configured.defaultMode,
      'adapters.claude-code.permissions.defaultMode'
    );
  }
  return resolved;
}

function resolveRolePermissionMode(ccAdapter, roleName) {
  let permissionMode = ccAdapter.roleSettings?.[roleName]?.permissionMode;
  if (permissionMode === undefined) {
    permissionMode = DEFAULT_CLAUDE_CODE_PERMISSION_MODE_BY_ROLE[roleName];
  }
  if (!permissionMode) {
    return null;
  }
  return validateClaudeCodePermissionMode(
    permissionMode,
    `adapters.claude-code.roleSettings.${roleName}.permissionMode`
  );
}

function ensureLocalClaudeCodeSettingsGitignored(outputDir) {
  const gitignorePath = join(outputDir, '.gitignore');
  const ignoreEntry = '.claude/settings.local.json';
  const acceptedEntries = new Set([ignoreEntry, `/${ignoreEntry}`]);

  if (existsSync(gitignorePath)) {
    const existingContent = readFileSync(gitignorePath, 'utf-8');
    const hasEntry = existingContent
      .split('\n')
      .map(line => line.trim().replace(/\\/g, '/'))
      .some(line => acceptedEntries.has(line));
    if (hasEntry) {
      return null;
    }
    const suffix = existingContent.endsWith('\n')
      ? `${ignoreEntry}\n`
      : `\n${ignoreEntry}\n`;
    writeFileSync(gitignorePath, existingContent + suffix, 'utf-8');
    return '.gitignore';
  }

  writeFileSync(gitignorePath, `${ignoreEntry}\n`, 'utf-8');
  return '.gitignore';
}

function writeClaudeCodeSettings(outputDir, resolvedPermissions) {
  if (resolvedPermissions === null) {
    return [];
  }

  const claudeDir = join(outputDir, '.claude');
  const settingsRelativePath = claudeCodeSettingsRelativePath(resolvedPermissions.scope);
  const settingsPath = join(
    claudeDir,
    resolvedPermissions.scope === 'local' ? 'settings.local.json' : 'settings.json'
  );
  mkdirSync(claudeDir, { recursive: true });

  let existingSettings = {};
  if (existsSync(settingsPath)) {
    const settingsText = readFileSync(settingsPath, 'utf-8');
    try {
      existingSettings = JSON.parse(settingsText);
    } catch (error) {
      throw new Error(`Invalid JSON in ${settingsRelativePath}: ${error.message}`);
    }
    if (!isPlainObject(existingSettings)) {
      throw new Error(`Invalid ${settingsRelativePath}: expected a top-level JSON object`);
    }
  }

  const existingPermissions = readExistingClaudeCodePermissions(existingSettings, settingsRelativePath);
  const mergedPermissions = {
    ...existingPermissions,
    allow: dedupe([
      ...(Array.isArray(existingPermissions.allow) ? existingPermissions.allow : []),
      ...resolvedPermissions.allow,
    ]),
    deny: dedupe([
      ...(Array.isArray(existingPermissions.deny) ? existingPermissions.deny : []),
      ...resolvedPermissions.deny,
    ]),
  };

  if (existingPermissions.defaultMode !== undefined) {
    mergedPermissions.defaultMode = existingPermissions.defaultMode;
  } else if (resolvedPermissions.defaultMode !== undefined) {
    mergedPermissions.defaultMode = resolvedPermissions.defaultMode;
  }

  const mergedSettings = {
    ...existingSettings,
    permissions: mergedPermissions,
  };
  writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2) + '\n', 'utf-8');

  const files = [settingsRelativePath];
  if (resolvedPermissions.scope === 'local') {
    const gitignoreFile = ensureLocalClaudeCodeSettingsGitignored(outputDir);
    if (gitignoreFile) {
      files.push(gitignoreFile);
    }
  }
  return files;
}

function formatClaudeRequiredSkillLines(requiredSkills, skillReferenceMap) {
  return (requiredSkills ?? []).map(skillName => {
    const referencePath = skillReferenceMap.get(skillName) ?? claudeSkillReferenceAbsolutePath(skillName);
    return `- \`${skillName}\`: \`${referencePath}\``;
  });
}

function roleToAgentMarkdown(roleName, roleRecord, modelSettings, permissionMode, skillReferenceMap) {
  const lines = [];
  lines.push('---');
  lines.push(`name: ${quoteYamlScalar(roleName)}`);
  if (roleRecord.description) {
    lines.push(`description: ${quoteYamlScalar(roleRecord.description.replace(/\n+/g, ' '))}`);
  }
  if (modelSettings.model) {
    lines.push(`model: ${quoteYamlScalar(modelSettings.model)}`);
  }
  if (permissionMode) {
    lines.push(`permissionMode: ${quoteYamlScalar(permissionMode)}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('<!-- Generated by: agenticloop generate claude-code -->');
  lines.push('<!-- Regenerate from canonical role file under agenticloop/agents/. -->');
  lines.push('');
  const referenceMap = skillReferenceMap ?? new Map();
  const referenceLines = formatClaudeRequiredSkillLines(roleRecord.requiredSkills, referenceMap);
  if (referenceLines.length > 0) {
    lines.push('Agentic Loop internal references to use when their trigger applies (read the file before acting):');
    lines.push(...referenceLines);
    lines.push('');
  }
  if (roleRecord.promptBody) {
    // Canonical role bodies reference procedures by `[[name]]` / bare skill name.
    // In Mode B those are not discoverable skills, so rewrite them to the
    // generated reference.md paths the public skill packages.
    lines.push(rewriteClaudeSkillReferences(roleRecord.promptBody, referenceMap));
    lines.push('');
  }
  lines.push(
    `<!-- adapter: model=${modelSettings.model || '(unset)'} -->`
  );
  return lines.join('\n');
}

function quoteYamlScalar(value) {
  return JSON.stringify(String(value));
}

function replaceAll(value, search, replacement) {
  return value.split(search).join(replacement);
}

// Reference path relative to the public skill directory (used inside
// .claude/skills/agenticloop/SKILL.md and the reference.md copies).
function claudeSkillReferenceRelativePath(canonicalName) {
  return `references/skills/${canonicalName}/reference.md`;
}

// Reference path from the target repo root (used inside .claude/agents/<role>.md,
// which live outside the public skill directory).
function claudeSkillReferenceAbsolutePath(canonicalName) {
  return `.claude/skills/${CLAUDE_PUBLIC_SKILL_NAME}/references/skills/${canonicalName}/reference.md`;
}

function buildClaudeSkillReferenceMap(skillEntries, pathBuilder) {
  const map = new Map();
  for (const entry of skillEntries) {
    map.set(entry.canonicalName, pathBuilder(entry.canonicalName));
  }
  return map;
}

// Rewrite canonical skill cross-links (`[[name]]` and bare `` `name` ``) to the
// generated internal reference path so the public skill and its reference copies
// never point at discoverable skill names that no longer exist in Claude Code.
function rewriteClaudeSkillReferences(text, skillReferenceMap) {
  let rewritten = text.replace(/\[\[([A-Za-z0-9_.-]+)\]\]/g, (full, name) => {
    const mapped = skillReferenceMap.get(name);
    return mapped ? `\`${mapped}\`` : full;
  });

  for (const [canonicalName, mappedPath] of skillReferenceMap.entries()) {
    rewritten = replaceAll(rewritten, `\`${canonicalName}\``, `\`${mappedPath}\``);
    rewritten = replaceAll(
      rewritten,
      `\`skills/${canonicalName}/SKILL.md\``,
      `\`${mappedPath}\``
    );
    rewritten = replaceAll(
      rewritten,
      `\`agenticloop/skills/${canonicalName}/SKILL.md\``,
      `\`${mappedPath}\``
    );
  }

  return rewritten;
}

function buildClaudeCoordinationLines(maintainerAgent, engineerAgent) {
  return [
    'Coordination in Claude Code:',
    `- Route task authoring, review, acceptance, and closeout through the Claude Code subagent \`${maintainerAgent}\`.`,
    `- Route scoped implementation and revision work through the Claude Code subagent \`${engineerAgent}\`.`,
    '- Agentic Loop is serial by default. For authorized multi-task units with 2+ ready task records, load parallel-delegation before choosing serial or parallel execution.',
    '- Start parallel role work only when the parallel-delegation skill plan, lease, backend ownership, and join condition requirements are satisfied; otherwise record the concrete serial reason.',
    '- Long-running or parallel role work must include a lease; parallel-specific liveness details live in parallel-delegation.',
    '- Keep this session as the coordinator and do not directly edit implementation files unless the human explicitly asks.',
  ];
}

function buildClaudeInternalReferenceIndexLines(skillReferenceMap) {
  const lines = ['Internal Agentic Loop procedures (read the matching reference before acting):'];
  for (const skillName of CLAUDE_REQUIRED_PUBLIC_REFERENCES) {
    const referencePath = skillReferenceMap.get(skillName) ?? claudeSkillReferenceRelativePath(skillName);
    lines.push(`- ${skillName}: \`${referencePath}\``);
  }
  return lines;
}

function renderClaudePublicSkill(skillReferenceMap, agentNames) {
  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  const source = readFileSync(CLAUDE_CODE_START_COMMAND, 'utf-8');
  const [frontmatter, rawBody] = parseFrontmatter(source);

  let body = rawBody.trim();
  body = replaceAll(
    body,
    'Requested task or context: `$ARGUMENTS`',
    'Requested task or context: use the current user request or selected task id as the work unit to coordinate.'
  );
  body = rewriteClaudeSkillReferences(body, skillReferenceMap);

  const lines = ['---'];
  lines.push(`name: ${quoteYamlScalar(CLAUDE_PUBLIC_SKILL_NAME)}`);
  lines.push(`description: ${quoteYamlScalar(AGENTIC_LOOP_OPERATION_DESCRIPTION)}`);
  const argumentHint = frontmatter?.['argument-hint'];
  if (argumentHint) {
    lines.push(`argument-hint: ${quoteYamlScalar(argumentHint)}`);
  }
  lines.push('disable-model-invocation: true');
  lines.push('---');
  lines.push('');
  lines.push('<!-- Generated by: agenticloop generate claude-code. Do not edit by hand. -->');
  lines.push('');
  lines.push(body);
  lines.push('');
  lines.push(...buildClaudeCoordinationLines(maintainerAgent, engineerAgent));
  lines.push('');
  lines.push(...buildClaudeInternalReferenceIndexLines(skillReferenceMap));
  lines.push('');
  return lines.join('\n');
}

// Copy a canonical skill tree into the public skill's references directory,
// renaming each SKILL.md to reference.md so the copies are not discoverable as
// separate Claude Code skills. Supporting files are copied recursively as-is.
function copyClaudeReferenceTree(
  sourceDir,
  destDir,
  copied,
  outputDir,
  skillReferenceMap,
  currentSrc = sourceDir,
  currentDest = destDir
) {
  mkdirSync(currentDest, { recursive: true });

  for (const entry of readdirSync(currentSrc)) {
    const srcEntry = join(currentSrc, entry);
    if (statSync(srcEntry).isDirectory()) {
      copyClaudeReferenceTree(
        sourceDir,
        destDir,
        copied,
        outputDir,
        skillReferenceMap,
        srcEntry,
        join(currentDest, entry)
      );
      continue;
    }

    const destName = entry === 'SKILL.md' ? 'reference.md' : entry;
    const destEntry = join(currentDest, destName);

    if (entry === 'SKILL.md') {
      const rewritten = rewriteClaudeSkillReferences(
        readFileSync(srcEntry, 'utf-8'),
        skillReferenceMap
      );
      writeFileSync(destEntry, rewritten, 'utf-8');
    } else {
      copyFileSync(srcEntry, destEntry);
    }

    copied.push(relative(outputDir, destEntry).replace(/\\/g, '/'));
  }
}

// Write one public agenticloop skill (SKILL.md) plus internal reference.md
// procedure copies into skillDir. The agenticloop skill directory is fully
// generated and owned by Agentic Loop, so it is cleared first to drop stale
// legacy output (the old nested agenticloop/<name>/SKILL.md copies). Reported
// file paths are relative to relRoot.
function writeClaudeSkillSurface(skillDir, relRoot, skillEntries, skillReferenceMap, agentNames) {
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }
  mkdirSync(skillDir, { recursive: true });

  const files = [];
  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, renderClaudePublicSkill(skillReferenceMap, agentNames), 'utf-8');
  files.push(relative(relRoot, skillPath).replace(/\\/g, '/'));

  const referencesRoot = join(skillDir, 'references', 'skills');
  mkdirSync(referencesRoot, { recursive: true });
  for (const entry of skillEntries) {
    copyClaudeReferenceTree(
      entry.sourceDir,
      join(referencesRoot, entry.canonicalName),
      files,
      relRoot,
      skillReferenceMap
    );
  }

  return files;
}

function writeClaudePublicSkill(skillEntries, skillReferenceMap, agentNames, outputDir) {
  // Target-owned skills live in sibling directories under .claude/skills/ and
  // are never touched here.
  const skillDir = join(outputDir, '.claude', 'skills', CLAUDE_PUBLIC_SKILL_NAME);
  return writeClaudeSkillSurface(skillDir, outputDir, skillEntries, skillReferenceMap, agentNames);
}

function copyClaudeCodeCommand(destDir, outputDir) {
  if (!existsSync(CLAUDE_CODE_START_COMMAND)) {
    throw new Error(`Claude Code command source not found: ${CLAUDE_CODE_START_COMMAND}`);
  }
  mkdirSync(destDir, { recursive: true });
  const destPath = join(destDir, 'agenticloop.md');
  const source = readFileSync(CLAUDE_CODE_START_COMMAND, 'utf-8');
  const marker = '<!-- Generated by: agenticloop generate claude-code. Do not edit by hand. -->';
  const [frontmatter, body] = splitFrontmatterForMarker(source);
  const output = frontmatter
    ? `${frontmatter}\n${marker}\n${body}`
    : `${marker}\n${source}`;
  writeFileSync(destPath, output, 'utf-8');
  return relative(outputDir, destPath).replace(/\\/g, '/');
}

function splitFrontmatterForMarker(source) {
  if (!source.startsWith('---')) return [null, source];
  const end = source.indexOf('\n---', 3);
  if (end === -1) return [null, source];
  const closingNewline = source.indexOf('\n', end + 4);
  const splitAt = closingNewline === -1 ? end + 4 : closingNewline + 1;
  return [source.slice(0, splitAt), source.slice(splitAt)];
}

/**
 * Generate Claude Code adapter artifacts.
 *
 * @param {object} alConfig
 * @param {string} repoRoot
 * @param {string} outputDir
 * @returns {{ files: string[] }}
 */
export function generateClaudeCodeArtifacts(alConfig, repoRoot, outputDir) {
  const ccAdapter = alConfig.adapters?.['claude-code'] ?? {};
  const roles = alConfig.roles ?? {};
  const roleBindings = ccAdapter.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(roles).map(roleName => [roleName, roleBindings[roleName]?.agent ?? roleName])
  );
  const resolvedPermissions = resolveClaudeCodePermissions(ccAdapter);

  const skillEntries = readCanonicalSkillEntries(repoRoot, alConfig);
  const relativeSkillReferenceMap = buildClaudeSkillReferenceMap(
    skillEntries,
    claudeSkillReferenceRelativePath
  );
  const absoluteSkillReferenceMap = buildClaudeSkillReferenceMap(
    skillEntries,
    claudeSkillReferenceAbsolutePath
  );

  mkdirSync(outputDir, { recursive: true });
  const files = [];

  const commandsDir = join(outputDir, '.claude', 'commands');
  files.push(copyClaudeCodeCommand(commandsDir, outputDir));

  const agentsDir = join(outputDir, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const [roleName] of Object.entries(roles)) {
    const agentName = roleBindings[roleName]?.agent ?? roleName;
    const { description, promptBody, requiredSkills } = buildRoleRecord(alConfig, repoRoot, roleName);
    const modelSettings = resolveRoleModel(alConfig, 'claude-code', roleName, ccAdapter);
    const permissionMode = resolveRolePermissionMode(ccAdapter, roleName);
    const md = roleToAgentMarkdown(
      agentName,
      { description, promptBody, requiredSkills },
      modelSettings,
      permissionMode,
      absoluteSkillReferenceMap
    );
    const mdPath = join(agentsDir, `${agentName}.md`);
    writeFileSync(mdPath, md, 'utf-8');
    files.push(relative(outputDir, mdPath).replace(/\\/g, '/'));
  }

  files.push(...writeClaudePublicSkill(skillEntries, relativeSkillReferenceMap, agentNames, outputDir));
  files.push(...writeClaudeCodeSettings(outputDir, resolvedPermissions));

  return { files };
}

/**
 * Plan Claude Code settings mutations as a json-merge action.
 *
 * @param {string} outputDir
 * @param {object} resolvedPermissions
 * @returns {Array} Plan actions for settings + gitignore.
 */
function planClaudeCodeSettings(outputDir, resolvedPermissions) {
  const actions = [];
  if (resolvedPermissions === null) {
    return actions;
  }

  const settingsRelPath = claudeCodeSettingsRelativePath(resolvedPermissions.scope);
  const mutations = [];

  // Compute array-add mutations for each permission entry.
  for (const entry of resolvedPermissions.allow) {
    mutations.push({ op: 'array-add', pointer: 'permissions/allow', value: entry });
  }
  for (const entry of resolvedPermissions.deny) {
    mutations.push({ op: 'array-add', pointer: 'permissions/deny', value: entry });
  }

  actions.push({
    type: 'json-merge',
    adapter: 'claude-code',
    relPath: settingsRelPath,
    mutations,
  });

  // .gitignore line for local settings.
  if (resolvedPermissions.scope === 'local') {
    actions.push({
      type: 'gitignore-append',
      adapter: 'claude-code',
      relPath: '.gitignore',
      line: '.claude/settings.local.json',
    });
  }

  return actions;
}

/**
 * Plan the Claude Code skill reference tree as write-file actions.
 *
 * @param {string} sourceDir
 * @param {string} destRelPath  Relative path prefix for destination
 * @param {Map} skillReferenceMap
 * @returns {Array} Write-file actions.
 */
function planClaudeReferenceTree(sourceDir, destRelPath, skillReferenceMap) {
  const actions = [];

  for (const entry of readdirSync(sourceDir)) {
    const srcEntry = join(sourceDir, entry);
    const entryStat = statSync(srcEntry);

    if (entryStat.isDirectory()) {
      actions.push(...planClaudeReferenceTree(
        srcEntry,
        `${destRelPath}/${entry}`,
        skillReferenceMap
      ));
      continue;
    }

    const destName = entry === 'SKILL.md' ? 'reference.md' : entry;
    const destRel = `${destRelPath}/${destName}`;

    if (entry === 'SKILL.md') {
      const rewritten = rewriteClaudeSkillReferences(
        readFileSync(srcEntry, 'utf-8'),
        skillReferenceMap
      );
      actions.push({
        type: 'write-file',
        adapter: 'claude-code',
        relPath: destRel,
        content: rewritten,
      });
    } else {
      actions.push({
        type: 'write-file',
        adapter: 'claude-code',
        relPath: destRel,
        content: readFileSync(srcEntry, 'utf-8'),
      });
    }
  }

  return actions;
}

/**
 * Plan Claude Code adapter artifacts without writing to the filesystem.
 *
 * @param {object} alConfig
 * @param {string} repoRoot
 * @param {string} outputDir
 * @returns {{ actions: Array, files: string[], adapter: string }}
 */
export function planClaudeCodeArtifacts(alConfig, repoRoot, outputDir) {
  const ccAdapter = alConfig.adapters?.['claude-code'] ?? {};
  const roles = alConfig.roles ?? {};
  const roleBindings = ccAdapter.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(roles).map(roleName => [roleName, roleBindings[roleName]?.agent ?? roleName])
  );
  const resolvedPermissions = resolveClaudeCodePermissions(ccAdapter);

  const skillEntries = readCanonicalSkillEntries(repoRoot, alConfig);
  const relativeSkillReferenceMap = buildClaudeSkillReferenceMap(
    skillEntries,
    claudeSkillReferenceRelativePath
  );
  const absoluteSkillReferenceMap = buildClaudeSkillReferenceMap(
    skillEntries,
    claudeSkillReferenceAbsolutePath
  );

  const actions = [];
  const files = [];

  actions.push({ type: 'clear-owned-directory', adapter: 'claude-code', relPath: '.claude/commands' });
  actions.push({ type: 'clear-owned-directory', adapter: 'claude-code', relPath: '.claude/agents' });

  // .claude/commands/agenticloop.md
  const commandContent = renderClaudeCommandContent();
  actions.push({
    type: 'write-file',
    adapter: 'claude-code',
    relPath: '.claude/commands/agenticloop.md',
    content: commandContent,
    marker: '<!-- Generated by: agenticloop generate claude-code. Do not edit by hand. -->',
  });
  files.push('.claude/commands/agenticloop.md');

  // .claude/agents/<role>.md
  for (const [roleName] of Object.entries(roles)) {
    const agentName = roleBindings[roleName]?.agent ?? roleName;
    const { description, promptBody, requiredSkills } = buildRoleRecord(alConfig, repoRoot, roleName);
    const modelSettings = resolveRoleModel(alConfig, 'claude-code', roleName, ccAdapter);
    const permissionMode = resolveRolePermissionMode(ccAdapter, roleName);
    const md = roleToAgentMarkdown(
      agentName,
      { description, promptBody, requiredSkills },
      modelSettings,
      permissionMode,
      absoluteSkillReferenceMap
    );
    const relPath = `.claude/agents/${agentName}.md`;
    actions.push({
      type: 'write-file',
      adapter: 'claude-code',
      relPath,
      content: md,
      marker: 'Generated by: agenticloop generate claude-code',
    });
    files.push(relPath);
  }

  // Clear the skill directory of previously-owned children, then write new content.
  const skillDirRelPath = `.claude/skills/${CLAUDE_PUBLIC_SKILL_NAME}`;
  actions.push({
    type: 'clear-owned-directory',
    adapter: 'claude-code',
    relPath: skillDirRelPath,
  });

  // .claude/skills/agenticloop/SKILL.md
  const skillContent = renderClaudePublicSkill(relativeSkillReferenceMap, agentNames);
  actions.push({
    type: 'write-file',
    adapter: 'claude-code',
    relPath: `${skillDirRelPath}/SKILL.md`,
    content: skillContent,
    marker: '<!-- Generated by: agenticloop generate claude-code. Do not edit by hand. -->',
  });
  files.push(`${skillDirRelPath}/SKILL.md`);

  // Reference trees.
  const referencesRoot = `${skillDirRelPath}/references/skills`;
  for (const entry of skillEntries) {
    const refActions = planClaudeReferenceTree(
      entry.sourceDir,
      `${referencesRoot}/${entry.canonicalName}`,
      relativeSkillReferenceMap
    );
    actions.push(...refActions);
    files.push(...refActions.map(a => a.relPath));
  }

  // Settings + gitignore.
  const settingsActions = planClaudeCodeSettings(outputDir, resolvedPermissions);
  actions.push(...settingsActions);
  files.push(...settingsActions.map(a => a.relPath));

  return { actions, files, adapter: 'claude-code' };
}

function renderClaudeCommandContent() {
  const source = readFileSync(CLAUDE_CODE_START_COMMAND, 'utf-8');
  const marker = '<!-- Generated by: agenticloop generate claude-code. Do not edit by hand. -->';
  const [frontmatter, body] = splitFrontmatterForMarker(source);
  return frontmatter
    ? `${frontmatter}\n${marker}\n${body}`
    : `${marker}\n${source}`;
}
