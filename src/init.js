/**
 * agenticloop init - scaffold Agentic Loop overlay in a target directory.
 *
 * Plain init creates:
 *   agenticloop/, .agenticloop/project.md, .agenticloop/tasks/,
 *   .agenticloop/decisions/, .agenticloop/logs/, .agenticloop/tmp/
 *
 * Plain init does NOT create:
 *   agenticloop.json,
 *   .opencode/, .codex/, plugins/agenticloop/, .claude/, .github/, .cursor/
 *
 * --adapter <host> additionally creates:
 *   agenticloop.json and host adapter artifacts
 *
 * Never overwrites:
 *   AGENTS.md, IMPLEMENTATION_PLAN.md, ARCHITECTURE*.md, README.md,
 *   .agenticloop/project.md (target-owned; never overwritten by refreshes)
 *
 * Skips (and reports) existing Agentic Loop-owned assets unless refreshAssets is true.
 * Appends .agenticloop/tmp/ to .gitignore without disturbing existing content.
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateClaudeCodeArtifacts } from './adapters/claude-code.js';
import { generateCodexArtifacts } from './adapters/codex.js';
import { generateCopilotArtifacts } from './adapters/copilot.js';
import { generateCursorArtifacts } from './adapters/cursor.js';
import { generateOpencodeArtifacts } from './adapters/opencode.js';
import { loadAgenticLoopConfig } from './json.js';
import {
  CONFIG_RELATIVE_PATH,
  INSTALLED_TOOLKIT_ROOT_DIRECTORY,
  MEMORY_SCAFFOLD_RELATIVE_PATH,
  PACKAGE_SOURCE_RELATIVE_PATHS,
  SCRATCH_DIRECTORY_RELATIVE_PATH,
  SCRATCH_GITIGNORE_PATTERNS,
  TARGET_STATE_DIRECTORY,
  TARGET_CONFIG_TEMPLATE_RELATIVE_PATH,
  TOOLKIT_SOURCE_RELATIVE_PATHS,
  bundledToolkitPath,
  isPackageSourceRepositoryRoot,
} from './layout.js';
import { migrateLegacyCanonicalAssets, migrateV2TargetConfig } from './layout-migration.js';
import { detectSetupState, nextStepsFromState } from './setup-state.js';

const TARGET_CFG_TEMPLATE = bundledToolkitPath(TARGET_CONFIG_TEMPLATE_RELATIVE_PATH);
const MEMORY_SCAFFOLD = bundledToolkitPath(MEMORY_SCAFFOLD_RELATIVE_PATH);

const PROTECTED_DOCS = ['AGENTS.md', 'IMPLEMENTATION_PLAN.md', 'README.md'];
const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

function normalizedPath(path) {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isProtectedFilename(name) {
  if (PROTECTED_DOCS.includes(name)) return true;
  if (/^ARCHITECTURE/i.test(name) && name.endsWith('.md')) return true;
  return false;
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return true;
  }
  return false;
}

function copyFileConditional(src, dest, refreshAssets, skipped, created, relPath) {
  if (samePath(src, dest)) {
    return;
  }
  ensureDir(dirname(dest));
  if (existsSync(dest) && !refreshAssets) {
    skipped.push(relPath);
    return;
  }
  copyFileSync(src, dest);
  created.push(relPath);
}

function copyDirConditional(srcDir, destDir, refreshAssets, skipped, created, relBase) {
  ensureDir(destDir);
  for (const entry of readdirSync(srcDir)) {
    const srcEntry = join(srcDir, entry);
    const destEntry = join(destDir, entry);
    const relPath = relBase ? `${relBase}/${entry}` : entry;
    if (statSync(srcEntry).isDirectory()) {
      copyDirConditional(srcEntry, destEntry, refreshAssets, skipped, created, relPath);
    } else {
      copyFileConditional(srcEntry, destEntry, refreshAssets, skipped, created, relPath);
    }
  }
}

function ensureTargetOwnedFile(src, dest, sourceLabel, relPath, skipped, created, errors) {
  if (existsSync(dest)) {
    skipped.push(relPath);
    return;
  }
  if (!existsSync(src)) {
    errors.push(`Source asset missing from package: ${sourceLabel}`);
    return;
  }
  copyFileSync(src, dest);
  created.push(relPath);
}

function targetStatePath(relPath = '') {
  return relPath ? `${TARGET_STATE_DIRECTORY}/${relPath}` : TARGET_STATE_DIRECTORY;
}

function parentScaffoldPath(relPath) {
  const parts = relPath.split('/');
  parts.pop();
  return parts.join('/');
}

function instantiateMemoryScaffoldEntry(srcPath, destPath, relPath, skipped, created, errors) {
  const sourceLabel = relPath
    ? `${MEMORY_SCAFFOLD_RELATIVE_PATH}/${relPath}`
    : MEMORY_SCAFFOLD_RELATIVE_PATH;

  if (!existsSync(srcPath)) {
    errors.push(`Source asset missing from package: ${sourceLabel}`);
    return;
  }

  const stats = statSync(srcPath);
  if (stats.isDirectory()) {
    if (relPath) {
      if (ensureDir(destPath)) {
        created.push(`${targetStatePath(relPath)}/`);
      }
    } else {
      ensureDir(destPath);
    }

    for (const entry of readdirSync(srcPath).sort()) {
      const childRelPath = relPath ? `${relPath}/${entry}` : entry;
      instantiateMemoryScaffoldEntry(
        join(srcPath, entry),
        join(destPath, entry),
        childRelPath,
        skipped,
        created,
        errors
      );
    }
    return;
  }

  if (relPath.endsWith('/.gitkeep') || relPath === '.gitkeep') {
    const parentRelPath = parentScaffoldPath(relPath);
    if (ensureDir(dirname(destPath)) && parentRelPath) {
      created.push(`${targetStatePath(parentRelPath)}/`);
    }
    return;
  }

  ensureTargetOwnedFile(
    srcPath,
    destPath,
    sourceLabel,
    targetStatePath(relPath),
    skipped,
    created,
    errors
  );
}

function instantiateMemoryScaffold(target, skipped, created, errors) {
  instantiateMemoryScaffoldEntry(
    MEMORY_SCAFFOLD,
    join(target, TARGET_STATE_DIRECTORY),
    '',
    skipped,
    created,
    errors
  );
}

function ensureScratchGitignored(targetDir) {
  const gitignorePath = join(targetDir, '.gitignore');

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n').map(line => line.trim());
    if (lines.some(line => SCRATCH_GITIGNORE_PATTERNS.includes(line))) {
      return null;
    }
    const suffix = content.endsWith('\n')
      ? `${SCRATCH_DIRECTORY_RELATIVE_PATH}/\n`
      : `\n${SCRATCH_DIRECTORY_RELATIVE_PATH}/\n`;
    appendFileSync(gitignorePath, suffix, 'utf-8');
    return '.gitignore (.agenticloop/tmp/ appended)';
  }

  writeFileSync(gitignorePath, `${SCRATCH_DIRECTORY_RELATIVE_PATH}/\n`, 'utf-8');
  return '.gitignore (created with .agenticloop/tmp/)';
}

function selectedAdapterHosts(selectedAdapter) {
  if (selectedAdapter === 'all') return IMPLEMENTED_ADAPTERS;
  return [selectedAdapter];
}

function renderAdapterEntry(host, indent = '    ') {
  return [
    `${indent}"${host}": {`,
    `${indent}  "roleSettings": {}`,
    `${indent}}`,
  ].join('\n');
}

function renderTargetConfigForAdapter(selectedAdapter) {
  const template = readFileSync(TARGET_CFG_TEMPLATE, 'utf-8');
  const entries = selectedAdapterHosts(selectedAdapter)
    .map(host => renderAdapterEntry(host))
    .join(',\n');
  const adapterBlockPattern = /  "adapters": \{[\s\S]*?\r?\n  \}\r?\n\}\s*$/;
  if (!adapterBlockPattern.test(template)) {
    throw new Error('Could not render selected adapter into target config template');
  }
  return template.replace(
    adapterBlockPattern,
    `  "adapters": {\n${entries}\n  }\n}\n`
  );
}

function pruneUnknownToolkitEntries(srcDir, destDir, removed, relBase) {
  if (!existsSync(destDir) || samePath(srcDir, destDir)) {
    return;
  }

  for (const entry of readdirSync(destDir)) {
    const srcEntry = join(srcDir, entry);
    const destEntry = join(destDir, entry);
    const relPath = `${relBase}/${entry}`;

    if (!existsSync(srcEntry)) {
      rmSync(destEntry, { recursive: true, force: true });
      removed.push(relPath);
      continue;
    }

    const srcStat = statSync(srcEntry);
    const destStat = statSync(destEntry);
    if (srcStat.isDirectory() && destStat.isDirectory()) {
      pruneUnknownToolkitEntries(srcEntry, destEntry, removed, relPath);
      continue;
    }

    if (srcStat.isDirectory() !== destStat.isDirectory() || srcStat.isFile() !== destStat.isFile()) {
      rmSync(destEntry, { recursive: true, force: true });
      removed.push(relPath);
    }
  }
}

function pruneToolkitPayloadEntries(targetToolkitRoot, removed) {
  if (!existsSync(targetToolkitRoot) || !statSync(targetToolkitRoot).isDirectory()) {
    return;
  }

  const allowedEntries = new Set(
    PACKAGE_SOURCE_RELATIVE_PATHS.map(relPath => relPath.split('/')[0]).filter(Boolean)
  );

  for (const entry of readdirSync(targetToolkitRoot)) {
    if (allowedEntries.has(entry)) {
      continue;
    }
    rmSync(join(targetToolkitRoot, entry), { recursive: true, force: true });
    removed.push(`${INSTALLED_TOOLKIT_ROOT_DIRECTORY}/${entry}`);
  }
}

function copyToolkitSource(target, refreshAssets, skipped, created, removed, errors) {
  const targetToolkitRoot = join(target, INSTALLED_TOOLKIT_ROOT_DIRECTORY);
  if (existsSync(targetToolkitRoot) && !statSync(targetToolkitRoot).isDirectory()) {
    errors.push(`Cannot scaffold toolkit source: ${INSTALLED_TOOLKIT_ROOT_DIRECTORY} exists and is not a directory`);
    return;
  }

  if (refreshAssets) {
    pruneToolkitPayloadEntries(targetToolkitRoot, removed);
  }

  for (const installedRelPath of TOOLKIT_SOURCE_RELATIVE_PATHS) {
    const sourcePath = bundledToolkitPath(installedRelPath);
    if (!existsSync(sourcePath)) {
      errors.push(`Source asset missing from package: ${installedRelPath}`);
      continue;
    }

    const targetPath = join(target, installedRelPath);
    const sourceStats = statSync(sourcePath);

    if (refreshAssets && sourceStats.isDirectory()) {
      pruneUnknownToolkitEntries(sourcePath, targetPath, removed, installedRelPath);
    }

    if (sourceStats.isDirectory()) {
      copyDirConditional(sourcePath, targetPath, refreshAssets, skipped, created, installedRelPath);
    } else {
      copyFileConditional(sourcePath, targetPath, refreshAssets, skipped, created, installedRelPath);
    }
  }
}

/**
 * Run agenticloop init.
 *
 * @param {object} options
 * @param {string} [options.target=process.cwd()] Target directory to scaffold.
 * @param {boolean} [options.refreshAssets=false] Overwrite existing toolkit-owned assets.
 * @param {boolean} [options.opencode=false] Compatibility alias; equivalent to adapter: 'opencode'.
 * @param {string} [options.adapter] Adapter to generate: opencode | codex | claude-code | copilot | cursor | all.
 * @returns {{ created: string[], skipped: string[], warnings: string[], errors: string[], migrated: string[], removed: string[] }}
 */
export async function init(options = {}) {
  const {
    target = process.cwd(),
    refreshAssets = false,
    opencode: opencodeAlias = false,
    adapter: adapterOption,
  } = options;

  let selectedAdapter = adapterOption;
  if (opencodeAlias && !selectedAdapter) {
    selectedAdapter = 'opencode';
  }
  const validAdapters = new Set(['opencode', 'codex', 'claude-code', 'copilot', 'cursor', 'all']);
  if (selectedAdapter && !validAdapters.has(selectedAdapter)) {
    return {
      created: [],
      skipped: [],
      warnings: [],
      errors: [`Unknown adapter '${selectedAdapter}'. Use: opencode, codex, claude-code, copilot, cursor, all`],
      migrated: [],
      removed: [],
    };
  }

  const created = [];
  const skipped = [];
  const warnings = [];
  const errors = [];
  const migrated = [];
  const removed = [];

  if (isPackageSourceRepositoryRoot(target)) {
    const message = `Refusing to mutate the Agentic Loop package source repository at ${target}. Use --target to point at a downstream project directory.`;
    errors.push(message);
    console.error(`  ERROR: ${message}`);
    return { created, skipped, warnings, errors, migrated, removed };
  }

  for (const doc of PROTECTED_DOCS) {
    if (existsSync(join(target, doc))) {
      console.log(`  SKIP (protected): ${doc}`);
    }
  }

  const migration = migrateLegacyCanonicalAssets(target);
  migrated.push(...migration.migrated);
  created.push(...migration.removed.map(relPath => `${relPath} (removed duplicate legacy root asset)`));
  warnings.push(...migration.warnings);
  errors.push(...migration.errors);

  copyToolkitSource(target, refreshAssets, skipped, created, removed, errors);

  if (refreshAssets) {
    const v2Migration = migrateV2TargetConfig(target);
    migrated.push(...v2Migration.migrated);
    warnings.push(...v2Migration.warnings);
  }

  instantiateMemoryScaffold(target, skipped, created, errors);

  if (selectedAdapter) {
    const targetConfigPath = join(target, 'agenticloop.json');
    if (existsSync(targetConfigPath)) {
      skipped.push('agenticloop.json');
    } else {
      if (!existsSync(TARGET_CFG_TEMPLATE)) {
        errors.push(`Source asset missing from package: ${TARGET_CONFIG_TEMPLATE_RELATIVE_PATH}`);
      } else if (!existsSync(join(target, CONFIG_RELATIVE_PATH))) {
        errors.push(`Cannot create agenticloop.json: ${CONFIG_RELATIVE_PATH} was not scaffolded`);
      } else {
        writeFileSync(targetConfigPath, renderTargetConfigForAdapter(selectedAdapter), 'utf-8');
        created.push('agenticloop.json');
      }
    }
  }

  if (selectedAdapter) {
    const configPath = join(target, 'agenticloop.json');
    if (!existsSync(configPath)) {
      errors.push('Cannot generate adapter output: agenticloop.json not found after init');
    } else {
      let alConfig;
      try {
        alConfig = loadAgenticLoopConfig(configPath);
      } catch (error) {
        errors.push(`Cannot generate adapter output: ${error.message}`);
        alConfig = null;
      }

      if (alConfig) {
        if (selectedAdapter === 'opencode' || selectedAdapter === 'all') {
          try {
            const { files } = generateOpencodeArtifacts(alConfig, target, target);
            created.push(...files);
          } catch (error) {
            errors.push(`Failed to generate OpenCode artifacts: ${error.message}`);
          }
        }

        if (selectedAdapter === 'codex' || selectedAdapter === 'all') {
          try {
            const { files } = generateCodexArtifacts(alConfig, target, target);
            created.push(...files);
          } catch (error) {
            errors.push(`Failed to generate Codex artifacts: ${error.message}`);
          }
        }

        if (selectedAdapter === 'claude-code' || selectedAdapter === 'all') {
          try {
            const { files } = generateClaudeCodeArtifacts(alConfig, target, target);
            created.push(...files);
          } catch (error) {
            errors.push(`Failed to generate Claude Code artifacts: ${error.message}`);
          }
        }

        if (selectedAdapter === 'copilot' || selectedAdapter === 'all') {
          try {
            const { files } = generateCopilotArtifacts(alConfig, target, target);
            created.push(...files);
          } catch (error) {
            errors.push(`Failed to generate GitHub Copilot artifacts: ${error.message}`);
          }
        }

        if (selectedAdapter === 'cursor' || selectedAdapter === 'all') {
          try {
            const { files } = generateCursorArtifacts(alConfig, target, target);
            created.push(...files);
          } catch (error) {
            errors.push(`Failed to generate Cursor artifacts: ${error.message}`);
          }
        }
      }
    }
  }

  const gitignoreResult = ensureScratchGitignored(target);
  if (gitignoreResult) {
    created.push(gitignoreResult);
  }

  console.log();
  for (const entry of migrated) console.log(`  migrated: ${entry}`);
  for (const entry of removed) console.log(`  removed:  ${entry}`);
  for (const entry of created) console.log(`  created:  ${entry}`);
  for (const entry of skipped) console.log(`  skipped (exists): ${entry}`);
  for (const warning of warnings) console.warn(`  WARN: ${warning}`);
  for (const error of errors) console.error(`  ERROR: ${error}`);

  const refreshableSkipped = skipped.filter(
    entry =>
      entry !== 'agenticloop.json' &&
      entry !== '.agenticloop/project.md'
  );
  if (refreshableSkipped.length > 0) {
    console.log();
    console.log("  To update existing Agentic Loop-owned assets, run: agenticloop update");
  }

  if (errors.length === 0) {
    const setupState = detectSetupState(target);
    const steps = nextStepsFromState(setupState);

    if (!selectedAdapter && !refreshAssets) {
      console.log();
      console.log('  Files backend is ready.');
      console.log('  Task records go under .agenticloop/tasks/<TASK-ID>.md (e.g. T-001.md).');
      console.log('  Scratch files belong under .agenticloop/tmp/.');
      console.log('  Toolkit source is under agenticloop/.');
    }

    if (selectedAdapter && selectedAdapter !== 'opencode') {
      console.log();
      console.log(`  Adapter output generated for: ${selectedAdapter}`);
    }

    if (setupState.setupStatus !== 'confirmed') {
      console.log();
      console.log('  Project setup: needed.');
      console.log('  Next: npx agenticloop setup');
    } else if (steps.length > 0) {
      console.log();
      console.log('  Next:');
      for (const step of steps) console.log(`    ${step}`);
    }
  }
  console.log();

  return { created, skipped, warnings, errors, migrated, removed };
}
