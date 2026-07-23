/**
 * Codex host adapter.
 *
 * Status: supported.
 *
 * Codex MVP support focuses on repo-local TUI activation:
 *   - One public repo-local skill discovered from .agents/skills/agenticloop/SKILL.md.
 *   - Internal procedure references under .agents/skills/agenticloop/references/.
 *   - Project custom agents under .codex/agents/<name>.toml.
 *   - Optional plugin distribution under plugins/agenticloop/ plus
 *     .agents/plugins/marketplace.json when adapters.codex.plugin.enabled is true.
 *
 * Generated artifacts (relative to the chosen output directory):
 *   .codex/agents/orchestrator.toml
 *   .codex/agents/maintainer.toml
 *   .codex/agents/engineer.toml
 *   .agents/skills/agenticloop/SKILL.md
 *   .agents/skills/agenticloop/agents/openai.yaml
 *   .agents/skills/agenticloop/references/skills/<skill>/reference.md
 *   .agents/skills/agenticloop/references/backends/<backend>.md
 *   plugins/agenticloop/.codex-plugin/plugin.json                    (optional)
 *   plugins/agenticloop/skills/agenticloop/SKILL.md                  (optional)
 *   plugins/agenticloop/skills/agenticloop/agents/openai.yaml        (optional)
 *   plugins/agenticloop/skills/agenticloop/references/skills/...     (optional)
 *   plugins/agenticloop/skills/agenticloop/references/backends/...  (optional)
 *   .agents/plugins/marketplace.json                                 (optional)
 *
 * Model slugs and reasoning effort are read from
 *   adapters.codex.roleSettings.<role>
 * with a legacy fallback to roles.<role>. Model identifiers are
 * host/provider specific and are not duplicated into agents/*.md.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../frontmatter.js';
import { assertSharedAgenticLoopPluginCompatibility } from '../adapter-plugin-compatibility.js';
import {
  BACKENDS_SOURCE_DIRECTORY,
  PROCESS_DOC_RELATIVE_PATH,
  bundledToolkitPath,
} from '../layout.js';
import {
  AGENTIC_LOOP_OPERATION_DESCRIPTION,
  STANDALONE_ENGINEER_PREAMBLE_LINES,
  buildRoleRecord,
  resolveRoleModel,
  readCanonicalSkillEntries,
  planReferenceTree,
} from './shared.js';
import {
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
} from '../codex-models.js';

const CODEX_PUBLIC_SKILL_NAME = 'agenticloop';
const CODEX_PUBLIC_SKILL_DESCRIPTION = AGENTIC_LOOP_OPERATION_DESCRIPTION;
const CODEX_PUBLIC_SKILL_DISPLAY_NAME = 'Agentic Loop';
const CODEX_PUBLIC_SKILL_SHORT_DESCRIPTION = AGENTIC_LOOP_OPERATION_DESCRIPTION;
const CODEX_PUBLIC_SKILL_DEFAULT_PROMPT = AGENTIC_LOOP_OPERATION_DESCRIPTION;
const CODEX_REQUIRED_PUBLIC_REFERENCES = [
  'role-delegation',
  'task-record-contract',
  'setup-agenticloop',
  'blocked-state',
];
const CODEX_START_COMMAND = bundledToolkitPath('agenticloop/commands/start.md');
const PACKAGE_JSON_PATH = fileURLToPath(
  new URL('../../package.json', import.meta.url)
);

function quoteTomlString(value) {
  if (value == null) return '""';
  return JSON.stringify(String(value));
}

function quoteYamlScalar(value) {
  return JSON.stringify(String(value));
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

function replaceAll(value, search, replacement) {
  return value.split(search).join(replacement);
}

function codexSkillReferenceRelativePath(canonicalName) {
  return `references/skills/${canonicalName}/reference.md`;
}

function codexSkillReferenceAbsolutePath(canonicalName) {
  return `.agents/skills/${CODEX_PUBLIC_SKILL_NAME}/references/skills/${canonicalName}/reference.md`;
}

function codexBackendReferenceRelativePath(filename) {
  return `references/backends/${filename}`;
}

function codexBackendReferenceAbsolutePath(filename) {
  return `.agents/skills/${CODEX_PUBLIC_SKILL_NAME}/references/backends/${filename}`;
}

function buildSkillReferenceMap(skillEntries, pathBuilder) {
  const map = new Map();
  for (const entry of skillEntries) {
    map.set(entry.canonicalName, pathBuilder(entry.canonicalName));
  }
  return map;
}

function addBackendReferencesToMap(map, backendEntries, pathBuilder) {
  for (const entry of backendEntries) {
    map.set(`backends/${entry.filename}`, pathBuilder(entry.filename));
    map.set(`agenticloop/backends/${entry.filename}`, pathBuilder(entry.filename));
  }
}

function skillReferencePath(skillReferenceMap, canonicalName, pathBuilder) {
  return skillReferenceMap.get(canonicalName) ?? pathBuilder(canonicalName);
}

function internalReferencePhrase(referencePath) {
  return `the Agentic Loop internal reference \`${referencePath}\``;
}

function rewriteSkillReferences(text, skillReferenceMap) {
  let rewritten = text.replace(/\[\[([A-Za-z0-9_.-]+)\]\]/g, (full, name) => {
    const mapped = skillReferenceMap.get(name);
    return mapped ? internalReferencePhrase(mapped) : full;
  });

  for (const [canonicalName, mappedPath] of skillReferenceMap.entries()) {
    rewritten = replaceAll(
      rewritten,
      `\`${canonicalName}\``,
      internalReferencePhrase(mappedPath)
    );
    rewritten = replaceAll(
      rewritten,
      `\`agenticloop/skills/${canonicalName}/SKILL.md\``,
      internalReferencePhrase(mappedPath)
    );
  }

  return rewritten;
}

function rewriteCodexEventLoggingFallbacks(text) {
  return text.replace(
    /configured\s+`event_logging_command`\s+\(or\s+`npx agenticloop`\s+when no command is\s+configured\)/g,
    'resolved event logging command: the configured `event_logging_command`, or `npx agenticloop` only after a one-time `npx agenticloop --help` check succeeds when no command is configured'
  );
}

function renderCodexGeneratedText(text, skillReferenceMap) {
  return rewriteCodexEventLoggingFallbacks(rewriteSkillReferences(text, skillReferenceMap));
}

function usesEventLogging(text) {
  return /\bevent[_ -]logging\b|\bevent log\b|\bevent-logging\b/i.test(text);
}

function renderReferenceMarkdown(sourceText, skillReferenceMap) {
  const [frontmatter, body] = parseFrontmatter(sourceText);
  if (frontmatter === null) {
    return renderCodexGeneratedText(sourceText, skillReferenceMap);
  }

  const renderedBody = renderCodexGeneratedText(body.trim(), skillReferenceMap);
  const lines = ['---'];
  if (frontmatter.name) {
    lines.push(`name: ${quoteYamlScalar(frontmatter.name)}`);
  }
  if (frontmatter.description) {
    lines.push(`description: ${quoteYamlScalar(String(frontmatter.description).replace(/\s+/g, ' ').trim())}`);
  }
  if (frontmatter.metadata && typeof frontmatter.metadata === 'object') {
    lines.push('metadata:');
    for (const [key, value] of Object.entries(frontmatter.metadata)) {
      lines.push(`  ${key}: ${quoteYamlScalar(value)}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(renderedBody);
  if (usesEventLogging(renderedBody)) {
    lines.push('');
    lines.push(...buildCodexEventLoggingOverrideLines());
  }
  lines.push('');
  return lines.join('\n');
}

function readCanonicalBackendEntries(repoRoot, alConfig) {
  const backendsSrc = alConfig.backends?.sourceDirectory ?? BACKENDS_SOURCE_DIRECTORY;
  const srcDir = join(repoRoot, backendsSrc);
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

function copyCodexSkillTree(
  sourceDir,
  destDir,
  outputDir,
  skillReferenceMap,
  copied,
  currentSrc = sourceDir,
  currentDest = destDir
) {
  mkdirSync(currentDest, { recursive: true });

  for (const entry of readdirSync(currentSrc)) {
    const sourceEntry = join(currentSrc, entry);
    const entryStat = statSync(sourceEntry);

    if (entryStat.isDirectory()) {
      copyCodexSkillTree(
        sourceDir,
        destDir,
        outputDir,
        skillReferenceMap,
        copied,
        sourceEntry,
        join(currentDest, entry)
      );
      continue;
    }

    const destName = entry === 'SKILL.md' ? 'reference.md' : entry;
    const destEntry = join(currentDest, destName);

    if (entry === 'SKILL.md') {
      const rendered = renderReferenceMarkdown(
        readFileSync(sourceEntry, 'utf-8'),
        skillReferenceMap
      );
      writeFileSync(destEntry, rendered, 'utf-8');
    } else {
      copyFileSync(sourceEntry, destEntry);
    }

    copied.push(relative(outputDir, destEntry).replace(/\\/g, '/'));
  }
}

function writeCodexSkillReferences(skillEntries, skillReferenceMap, destRoot, outputDir) {
  mkdirSync(destRoot, { recursive: true });
  const copied = [];

  for (const entry of skillEntries) {
    const destDir = join(destRoot, entry.canonicalName);
    copyCodexSkillTree(entry.sourceDir, destDir, outputDir, skillReferenceMap, copied);
  }

  return copied;
}

function writeCodexBackendReferences(backendEntries, destRoot, outputDir, skillReferenceMap) {
  mkdirSync(destRoot, { recursive: true });
  const copied = [];
  for (const entry of backendEntries) {
    const destFile = join(destRoot, entry.filename);
    const rendered = renderCodexGeneratedText(
      readFileSync(entry.sourceFile, 'utf-8'),
      skillReferenceMap
    );
    writeFileSync(destFile, rendered, 'utf-8');
    copied.push(relative(outputDir, destFile).replace(/\\/g, '/'));
  }
  return copied;
}

function loadCodexStartCommandBody() {
  const source = readFileSync(CODEX_START_COMMAND, 'utf-8');
  const [, body] = parseFrontmatter(source);
  return body.trim();
}

function replaceRequiredTemplateText(text, search, replacement, label) {
  if (!text.includes(search)) {
    throw new Error(
      `Codex start command template drift: expected ${label} text in commands/start.md`
    );
  }
  return text.replace(search, replacement);
}

function buildCodexEventLoggingOverrideLines() {
  return [
    'Codex event logging override:',
    '- If `.agenticloop/project.md` has `event_logging: disabled`, do not log.',
    '- If `event_logging: enabled`, resolve the command once before writing events: use non-empty `event_logging_command`; otherwise run `npx agenticloop --help` once and use `npx agenticloop` only if it succeeds.',
    '- Do not assume `npx agenticloop` exists before that check succeeds.',
    '- If no working event logging command is available, do not block the workflow. Record a truthful process gap in the task record or closeout marker note, then continue.',
    '- If an event logging command fails because the executable is missing, do not retry repeatedly and do not block delegation.',
  ];
}

function buildCodexInternalReferenceIndexLines(skillReferenceMap, backendEntries, backendPathBuilder) {
  const lines = ['Internal Agentic Loop references:'];
  for (const skillName of CODEX_REQUIRED_PUBLIC_REFERENCES) {
    lines.push(`- ${skillName}: \`${skillReferencePath(skillReferenceMap, skillName, codexSkillReferenceRelativePath)}\``);
  }
  for (const entry of backendEntries) {
    const name = entry.filename.replace(/\.md$/, '');
    lines.push(`- backend/${name}: \`${backendPathBuilder(entry.filename)}\``);
  }
  return lines;
}

function renderCodexPublicSkill(skillReferenceMap, agentNames, backendEntries) {
  const setupReferencePath = skillReferencePath(
    skillReferenceMap,
    'setup-agenticloop',
    codexSkillReferenceRelativePath
  );
  const roleDelegationReferencePath = skillReferencePath(
    skillReferenceMap,
    'role-delegation',
    codexSkillReferenceRelativePath
  );
  const blockedStateReferencePath = skillReferencePath(
    skillReferenceMap,
    'blocked-state',
    codexSkillReferenceRelativePath
  );
  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  let body = loadCodexStartCommandBody();

  body = replaceRequiredTemplateText(
    body,
    'confirmed map lacks a valid human-confirmed `development_stage`, route\n`agenticloop/skills/setup-agenticloop/SKILL.md` or confirm the profile before\nselecting or creating the first task.',
    `confirmed map lacks a valid human-confirmed \`development_stage\`, route ${internalReferencePhrase(setupReferencePath)} or confirm the profile before\nselecting or creating the first task.`,
    'setup routing'
  );

  body = replaceRequiredTemplateText(
    body,
    'Keep the main session as the coordinator: it reads the selected project config\nand process docs, routes task authoring, review, acceptance, and closeout\nthrough the maintainer role, routes scoped implementation and revision work\nthrough the engineer role, and should not directly edit implementation files\nunless the human explicitly asks. Respect the Advance Authorization Boundary,\nblocked-state handling, decision records, event logging rules, and configured\ngroup approval gates.',
    `Keep the main session as the coordinator/orchestrator. It reads the selected project config
and process docs, routes task authoring, review, acceptance, and closeout
through the Codex custom agent \`${maintainerAgent}\`, routes scoped implementation and revision work
through the Codex custom agent \`${engineerAgent}\`, and should not directly edit implementation files from the coordinator unless the human explicitly asks.

Use real Codex custom-agent delegation when role work is needed. Spawn those agents with a single plain-message prompt payload. Do not mix a plain message and structured items in one spawn request. If the first spawn attempt fails with a schema error about message/items, retry once using plain-message-only. If custom-agent delegation is still unavailable after that retry, record a bounded fallback reason and continue according to ${internalReferencePhrase(roleDelegationReferencePath)}.

Follow ${internalReferencePhrase(roleDelegationReferencePath)} for delegation capability checks, backend enforcement, bounded fallback, and \`role.invoked\` event logging. Respect the Advance Authorization Boundary, ${internalReferencePhrase(blockedStateReferencePath)}, decision records, event logging rules, and configured group approval gates.`,
    'coordinator delegation'
  );

  body = replaceRequiredTemplateText(
    body,
    'Requested task or context: `$ARGUMENTS`',
    'Requested task or context: use the current user request or selected task id as the work unit to coordinate.',
    'argument placeholder'
  );

  body = renderCodexGeneratedText(body, skillReferenceMap);

  return [
    '---',
    `name: ${quoteYamlScalar(CODEX_PUBLIC_SKILL_NAME)}`,
    `description: ${quoteYamlScalar(CODEX_PUBLIC_SKILL_DESCRIPTION)}`,
    '---',
    '',
    '<!-- Generated by: agenticloop generate codex. Do not edit by hand. -->',
    '',
    'Use this skill only when the user explicitly asks to activate Agentic Loop. Installing, discovering, or reading Agentic Loop does not activate it, and mentioning a task ID for discussion or status is not activation. For ordinary questions, fixes, and one-off changes, follow the repository rules document directly instead.',
    '',
    body,
    '',
    ...buildCodexEventLoggingOverrideLines(),
    '',
    ...buildCodexInternalReferenceIndexLines(skillReferenceMap, backendEntries, codexBackendReferenceRelativePath),
    '',
  ].join('\n');
}

function renderCodexOpenAiYaml() {
  return [
    'interface:',
    `  display_name: ${quoteYamlScalar(CODEX_PUBLIC_SKILL_DISPLAY_NAME)}`,
    `  short_description: ${quoteYamlScalar(CODEX_PUBLIC_SKILL_SHORT_DESCRIPTION)}`,
    `  default_prompt: ${quoteYamlScalar(CODEX_PUBLIC_SKILL_DEFAULT_PROMPT)}`,
    '',
  ].join('\n');
}

function writeCodexPublicSkill(destRoot, outputDir, skillEntries, skillReferenceMap, agentNames, backendEntries) {
  const files = [];
  const skillDir = join(destRoot, CODEX_PUBLIC_SKILL_NAME);
  mkdirSync(skillDir, { recursive: true });

  const skillPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, renderCodexPublicSkill(skillReferenceMap, agentNames, backendEntries), 'utf-8');
  files.push(relative(outputDir, skillPath).replace(/\\/g, '/'));

  const openAiPath = join(skillDir, 'agents', 'openai.yaml');
  mkdirSync(join(skillDir, 'agents'), { recursive: true });
  writeFileSync(openAiPath, renderCodexOpenAiYaml(), 'utf-8');
  files.push(relative(outputDir, openAiPath).replace(/\\/g, '/'));

  files.push(...writeCodexSkillReferences(
    skillEntries,
    skillReferenceMap,
    join(skillDir, 'references', 'skills'),
    outputDir
  ));

  files.push(...writeCodexBackendReferences(
    backendEntries,
    join(skillDir, 'references', 'backends'),
    outputDir,
    skillReferenceMap
  ));

  return files;
}

function formatRequiredSkillLines(requiredSkills, skillReferenceMap) {
  return (requiredSkills ?? []).map(skillName => {
    const referencePath = skillReferencePath(
      skillReferenceMap,
      skillName,
      codexSkillReferenceAbsolutePath
    );
    return `- \`${skillName}\`: \`${referencePath}\``;
  });
}

function buildCodexDeveloperInstructions(
  roleName,
  roleSourceFile,
  requiredSkills,
  roleBody,
  skillReferenceMap,
  agentNames,
  backendEntries
) {
  const maintainerAgent = agentNames.maintainer ?? 'maintainer';
  const engineerAgent = agentNames.engineer ?? 'engineer';
  const roleDelegationReferencePath = skillReferencePath(
    skillReferenceMap,
    'role-delegation',
    codexSkillReferenceAbsolutePath
  );
  const lines = [];
  lines.push(`You are the Agentic Loop ${capitalize(roleName)} custom agent for the target project in Codex TUI.`);
  lines.push(`Canonical role source: \`${roleSourceFile}\`.`);
  lines.push('Read `.agenticloop/project.md` before acting for setup status, task backend, document selections, naming, grouping, and event logging.');
  lines.push(`Follow \`${PROCESS_DOC_RELATIVE_PATH}\` as the workflow methodology.`);
  lines.push('Path convention: toolkit source (agents/, skills/, backends/) lives under agenticloop/ (no leading dot); target project state (project.md, tasks/, decisions/, improvements/) lives under .agenticloop/ (leading dot). .agenticloop/agents, .agenticloop/skills, and .agenticloop/backends are invalid paths.');

  const skillLines = formatRequiredSkillLines(requiredSkills, skillReferenceMap);
  if (skillLines.length > 0) {
    lines.push('Agentic Loop internal references to use when their trigger applies:');
    lines.push(...skillLines);
  }

  if (backendEntries.length > 0) {
    lines.push('Backend projection references:');
    for (const entry of backendEntries) {
      lines.push(`- \`${codexBackendReferenceAbsolutePath(entry.filename)}\``);
    }
  }

  if (roleName === 'orchestrator') {
    lines.push(`When maintainer-owned work is needed, explicitly spawn the Codex custom agent \`${maintainerAgent}\`. When engineer-owned work is needed, explicitly spawn the Codex custom agent \`${engineerAgent}\` instead of doing that work inline.`);
    lines.push('Agentic Loop is serial by default. For every authorized multi-task unit, complete a current Parallel Opportunity Scan after decomposition and include its durable result or not-currently-eligible rescan trigger in implementation delegation. Load parallel-delegation before choosing serial or parallel execution.');
    lines.push('Start parallel role work only when the parallel-delegation skill plan, lease, backend ownership, and join condition requirements are satisfied; otherwise record the concrete serial reason.');
    lines.push('Codex delegation contract:');
    lines.push('- Spawn maintainer and engineer custom agents using a single plain-message prompt payload only.');
    lines.push('- Do not mix a plain message payload with structured items in the same spawn request.');
    lines.push('- If the first spawn attempt fails with a schema error about message/items, retry once using plain-message-only.');
    lines.push('- For long-running or parallel delegated work, include the lease with an observable-step checkpoint cadence and require a status return at the progress checkpoint, stop condition, wrong branch/worktree, or no-progress budget.');
    lines.push(`- If custom-agent delegation is unavailable after that retry, record a bounded fallback reason and continue according to ${internalReferencePhrase(roleDelegationReferencePath)}.`);
    lines.push('When event logging is enabled, resolve the command using the Codex event logging override. If a working command exists, emit `role.invoked` after a real role invocation or explicit fallback role assumption. If no working event logging command is available, record a truthful process gap and continue.');
    lines.push('Do not directly edit implementation files unless the human explicitly asks.');
  } else if (roleName === 'maintainer') {
    lines.push('Stay within maintainer boundaries: own setup confirmation, task records, review, acceptance, follow-up triage, and closeout.');
    lines.push('Honor any delegation lease from the orchestrator, including any observable-step checkpoint cadence, and return status when the lease, stop condition, collision, or no-progress budget requires it.');
    lines.push('Do not implement code changes. Stop and hand control back after producing maintainer-owned output for the orchestrator or human.');
  } else if (roleName === 'engineer') {
    lines.push(...STANDALONE_ENGINEER_PREAMBLE_LINES);
    lines.push('In Agentic Loop mode, honor any delegation lease from the orchestrator, including any observable-step checkpoint cadence, and return status when the lease, stop condition, wrong branch/worktree, collision, or no-progress budget requires it. Stop and hand control back once implementation evidence is ready for maintainer review.');
  }

  lines.push('');
  lines.push('Canonical role contract follows with Codex event logging command-resolution guidance:');
  lines.push('');
  if (roleBody) {
    lines.push(renderCodexGeneratedText(roleBody, skillReferenceMap));
  }
  lines.push('');
  lines.push(...buildCodexEventLoggingOverrideLines());

  return lines.join('\n');
}

function roleToToml(roleName, roleRecord, modelSettings) {
  const lines = [];
  lines.push('# Generated by: agenticloop generate codex');
  lines.push('# Do not edit by hand; regenerate from canonical role file.');
  lines.push(`name = ${quoteTomlString(roleName)}`);
  lines.push(`description = ${quoteTomlString(roleRecord.description)}`);
  const model = normalizeCodexModel(modelSettings.model);
  if (model) {
    lines.push(`model = ${quoteTomlString(model)}`);
  }
  const reasoningEffort = normalizeCodexReasoningEffort(modelSettings.variant);
  if (reasoningEffort) {
    lines.push(`model_reasoning_effort = ${quoteTomlString(reasoningEffort)}`);
  }
  lines.push(`developer_instructions = ${quoteTomlString(roleRecord.developerInstructions)}`);
  return lines.join('\n') + '\n';
}

function loadPackageVersion() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
  return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
}

function buildPluginManifest(version) {
  return {
    name: 'agenticloop',
    version,
    description: 'Agentic Loop workflow toolkit (Codex plugin distribution)',
    skills: './skills/',
  };
}

function buildMarketplaceData(version) {
  return {
    name: 'agenticloop-local',
    interface: {
      displayName: 'Agentic Loop Local',
    },
    plugins: [
      {
        name: 'agenticloop',
        source: {
          source: 'local',
          path: './plugins/agenticloop',
        },
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
        category: 'Productivity',
      },
    ],
  };
}

function writeMarketplaceFile(outputDir, version) {
  const marketplacePath = join(outputDir, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(join(outputDir, '.agents', 'plugins'), { recursive: true });

  let marketplace = { plugins: [] };
  if (existsSync(marketplacePath)) {
    const text = readFileSync(marketplacePath, 'utf-8');
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        marketplace = parsed;
      } else {
        // Not a JSON object — fail closed rather than silently replacing.
        throw new Error(
          'Existing .agents/plugins/marketplace.json is not a JSON object; refusing to overwrite'
        );
      }
    } catch (error) {
      if (error.message.includes('refusing to overwrite')) throw error;
      // Malformed JSON — fail closed rather than silently replacing.
      throw new Error(
        `Existing .agents/plugins/marketplace.json contains malformed JSON: ${error.message}; refusing to overwrite`
      );
    }
  }

  const generated = buildMarketplaceData(version);
  const existingPlugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const otherPlugins = existingPlugins.filter(plugin => plugin?.name !== 'agenticloop');
  marketplace.name = typeof marketplace.name === 'string' && marketplace.name.trim()
    ? marketplace.name
    : generated.name;
  marketplace.interface =
    marketplace.interface && typeof marketplace.interface === 'object' && !Array.isArray(marketplace.interface)
      ? marketplace.interface
      : generated.interface;
  if (!marketplace.interface.displayName) {
    marketplace.interface.displayName = generated.interface.displayName;
  }
  marketplace.plugins = [...otherPlugins, generated.plugins[0]];

  writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n', 'utf-8');
  return relative(outputDir, marketplacePath).replace(/\\/g, '/');
}

function writeOptionalPluginDistribution(outputDir, skillEntries, skillReferenceMap, agentNames, version, backendEntries) {
  const files = [];
  const pluginRoot = join(outputDir, 'plugins', 'agenticloop');
  mkdirSync(pluginRoot, { recursive: true });

  const pluginManifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  mkdirSync(join(pluginRoot, '.codex-plugin'), { recursive: true });
  writeFileSync(
    pluginManifestPath,
    JSON.stringify(buildPluginManifest(version), null, 2) + '\n',
    'utf-8'
  );
  files.push(relative(outputDir, pluginManifestPath).replace(/\\/g, '/'));

  const pluginSkillsRoot = join(pluginRoot, 'skills');
  files.push(...writeCodexPublicSkill(
    pluginSkillsRoot,
    outputDir,
    skillEntries,
    skillReferenceMap,
    agentNames,
    backendEntries
  ));
  files.push(writeMarketplaceFile(outputDir, version));
  return files;
}

/**
 * Generate Codex adapter artifacts.
 *
 * @param {object} alConfig       Parsed agenticloop.json.
 * @param {string} repoRoot       Absolute path to the repository root.
 * @param {string} outputDir      Absolute path to write generated files to.
 * @returns {{ files: string[] }}
 */
export function generateCodexArtifacts(alConfig, repoRoot, outputDir) {
  assertSharedAgenticLoopPluginCompatibility(alConfig);

  const codexAdapter = alConfig.adapters?.codex ?? {};
  const roles = alConfig.roles ?? {};
  const roleBindings = codexAdapter.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(roles).map(roleName => [roleName, roleBindings[roleName]?.agent ?? roleName])
  );
  const skillEntries = readCanonicalSkillEntries(repoRoot, alConfig);
  const backendEntries = readCanonicalBackendEntries(repoRoot, alConfig);
  const relativeSkillReferenceMap = buildSkillReferenceMap(
    skillEntries,
    codexSkillReferenceRelativePath
  );
  addBackendReferencesToMap(relativeSkillReferenceMap, backendEntries, codexBackendReferenceRelativePath);
  const absoluteSkillReferenceMap = buildSkillReferenceMap(
    skillEntries,
    codexSkillReferenceAbsolutePath
  );
  addBackendReferencesToMap(absoluteSkillReferenceMap, backendEntries, codexBackendReferenceAbsolutePath);
  const version = loadPackageVersion();

  mkdirSync(outputDir, { recursive: true });
  const files = [];

  const agentsDir = join(outputDir, '.codex', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const [roleName] of Object.entries(roles)) {
    const agentName = roleBindings[roleName]?.agent ?? roleName;
    const { description, sourceFile, promptBody, requiredSkills } = buildRoleRecord(
      alConfig,
      repoRoot,
      roleName
    );
    const developerInstructions = buildCodexDeveloperInstructions(
      roleName,
      sourceFile,
      requiredSkills,
      promptBody,
      absoluteSkillReferenceMap,
      agentNames,
      backendEntries
    );
    const modelSettings = resolveRoleModel(alConfig, 'codex', roleName, codexAdapter);
    const toml = roleToToml(
      agentName,
      { description, developerInstructions },
      modelSettings
    );
    const tomlPath = join(agentsDir, `${agentName}.toml`);
    writeFileSync(tomlPath, toml, 'utf-8');
    files.push(relative(outputDir, tomlPath).replace(/\\/g, '/'));
  }

  const repoSkillsRoot = join(outputDir, '.agents', 'skills');
  files.push(...writeCodexPublicSkill(
    repoSkillsRoot,
    outputDir,
    skillEntries,
    relativeSkillReferenceMap,
    agentNames,
    backendEntries
  ));

  if (codexAdapter.plugin?.enabled === true) {
    files.push(...writeOptionalPluginDistribution(
      outputDir,
      skillEntries,
      relativeSkillReferenceMap,
      agentNames,
      version,
      backendEntries
    ));
  }

  return { files };
}

/**
 * Plan Codex adapter artifacts without writing to the filesystem.
 *
 * @param {object} alConfig
 * @param {string} repoRoot
 * @param {string} outputDir
 * @returns {{ actions: Array, files: string[], adapter: string }}
 */
export function planCodexArtifacts(alConfig, repoRoot, outputDir) {
  const codexAdapter = alConfig.adapters?.codex ?? {};
  const roles = alConfig.roles ?? {};
  const roleBindings = codexAdapter.roleBindings ?? {};
  const agentNames = Object.fromEntries(
    Object.keys(roles).map(roleName => [roleName, roleBindings[roleName]?.agent ?? roleName])
  );
  const skillEntries = readCanonicalSkillEntries(repoRoot, alConfig);
  const backendEntries = readCanonicalBackendEntries(repoRoot, alConfig);
  const relativeSkillReferenceMap = buildSkillReferenceMap(
    skillEntries,
    codexSkillReferenceRelativePath
  );
  addBackendReferencesToMap(relativeSkillReferenceMap, backendEntries, codexBackendReferenceRelativePath);
  const absoluteSkillReferenceMap = buildSkillReferenceMap(
    skillEntries,
    codexSkillReferenceAbsolutePath
  );
  addBackendReferencesToMap(absoluteSkillReferenceMap, backendEntries, codexBackendReferenceAbsolutePath);
  const version = loadPackageVersion();

  const actions = [];
  const files = [];

  actions.push({ type: 'clear-owned-directory', adapter: 'codex', relPath: '.codex/agents' });
  // Reconcile plugin files even when the optional plugin is disabled.
  actions.push({ type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' });

  // .codex/agents/<name>.toml
  for (const [roleName] of Object.entries(roles)) {
    const agentName = roleBindings[roleName]?.agent ?? roleName;
    const { description, sourceFile, promptBody, requiredSkills } = buildRoleRecord(
      alConfig, repoRoot, roleName
    );
    const developerInstructions = buildCodexDeveloperInstructions(
      roleName, sourceFile, requiredSkills, promptBody,
      absoluteSkillReferenceMap, agentNames, backendEntries
    );
    const modelSettings = resolveRoleModel(alConfig, 'codex', roleName, codexAdapter);
    const toml = roleToToml(agentName, { description, developerInstructions }, modelSettings);
    const relPath = `.codex/agents/${agentName}.toml`;
    actions.push({
      type: 'write-file',
      adapter: 'codex',
      relPath,
      content: toml,
      marker: '# Generated by: agenticloop generate codex',
    });
    files.push(relPath);
  }

  // Public skill directory.
  const skillDirRelPath = `.agents/skills/${CODEX_PUBLIC_SKILL_NAME}`;
  actions.push({
    type: 'clear-owned-directory',
    adapter: 'codex',
    relPath: skillDirRelPath,
  });

  // SKILL.md
  const skillContent = renderCodexPublicSkill(relativeSkillReferenceMap, agentNames, backendEntries);
  actions.push({
    type: 'write-file',
    adapter: 'codex',
    relPath: `${skillDirRelPath}/SKILL.md`,
    content: skillContent,
    marker: '<!-- Generated by: agenticloop generate codex. Do not edit by hand. -->',
  });
  files.push(`${skillDirRelPath}/SKILL.md`);

  // agents/openai.yaml
  actions.push({
    type: 'write-file',
    adapter: 'codex',
    relPath: `${skillDirRelPath}/agents/openai.yaml`,
    content: renderCodexOpenAiYaml(),
  });
  files.push(`${skillDirRelPath}/agents/openai.yaml`);

  // Skill reference trees.
  for (const entry of skillEntries) {
    const refActions = planReferenceTree(
      entry.sourceDir,
      `${skillDirRelPath}/references/skills/${entry.canonicalName}`,
      'codex',
      (content) => renderReferenceMarkdown(content, relativeSkillReferenceMap),
      '# Generated by: agenticloop generate codex'
    );
    actions.push(...refActions);
    files.push(...refActions.map(a => a.relPath));
  }

  // Backend references.
  for (const entry of backendEntries) {
    const relPath = `${skillDirRelPath}/references/backends/${entry.filename}`;
    const content = renderCodexGeneratedText(
      readFileSync(entry.sourceFile, 'utf-8'),
      relativeSkillReferenceMap
    );
    actions.push({
      type: 'write-file',
      adapter: 'codex',
      relPath,
      content,
    });
    files.push(relPath);
  }

  // Optional plugin distribution.
  if (codexAdapter.plugin?.enabled === true) {
    const pluginRoot = 'plugins/agenticloop';

    // plugin.json
    actions.push({
      type: 'write-file',
      adapter: 'codex',
      relPath: `${pluginRoot}/.codex-plugin/plugin.json`,
      content: JSON.stringify(buildPluginManifest(version), null, 2) + '\n',
    });
    files.push(`${pluginRoot}/.codex-plugin/plugin.json`);

    // Plugin skill tree (mirror of the public skill under plugins/).
    const pluginSkillDir = `${pluginRoot}/skills/${CODEX_PUBLIC_SKILL_NAME}`;
    actions.push({
      type: 'clear-owned-directory',
      adapter: 'codex',
      relPath: pluginSkillDir,
    });

    actions.push({
      type: 'write-file',
      adapter: 'codex',
      relPath: `${pluginSkillDir}/SKILL.md`,
      content: skillContent,
      marker: '<!-- Generated by: agenticloop generate codex. Do not edit by hand. -->',
    });
    files.push(`${pluginSkillDir}/SKILL.md`);

    actions.push({
      type: 'write-file',
      adapter: 'codex',
      relPath: `${pluginSkillDir}/agents/openai.yaml`,
      content: renderCodexOpenAiYaml(),
    });
    files.push(`${pluginSkillDir}/agents/openai.yaml`);

    for (const entry of skillEntries) {
      const refActions = planReferenceTree(
        entry.sourceDir,
        `${pluginSkillDir}/references/skills/${entry.canonicalName}`,
        'codex',
        (content) => renderReferenceMarkdown(content, relativeSkillReferenceMap),
        '# Generated by: agenticloop generate codex'
      );
      actions.push(...refActions);
      files.push(...refActions.map(a => a.relPath));
    }

    for (const entry of backendEntries) {
      const relPath = `${pluginSkillDir}/references/backends/${entry.filename}`;
      const content = renderCodexGeneratedText(
        readFileSync(entry.sourceFile, 'utf-8'),
        relativeSkillReferenceMap
      );
      actions.push({ type: 'write-file', adapter: 'codex', relPath, content });
      files.push(relPath);
    }

    // marketplace.json merge.
    const generated = buildMarketplaceData(version);
    actions.push({
      type: 'json-merge',
      adapter: 'codex',
      relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: generated.name },
        { op: 'set-if-absent', pointer: '/interface', value: generated.interface },
        {
          op: 'replace-array-element',
          pointer: '/plugins',
          matchKey: 'name',
          matchValue: 'agenticloop',
          value: generated.plugins[0],
        },
      ],
    });
    files.push('.agents/plugins/marketplace.json');
  }

  return { actions, files, adapter: 'codex' };
}
