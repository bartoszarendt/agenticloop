import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONFIG_RELATIVE_PATH,
  CURRENT_LAYOUT_VERSION,
  LEGACY_CANONICAL_ASSET_MAPPINGS,
  MANIFEST_RELATIVE_PATH,
  TOOLKIT_SOURCE_RELATIVE_PATHS,
  V2_BASE_CONFIG_RELATIVE_PATH,
  bundledToolkitPath,
  isPackageSourceRepositoryRoot,
  loadLayoutManifest,
} from './layout.js';

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function exactFileMatch(leftPath, rightPath) {
  return readFileSync(leftPath).equals(readFileSync(rightPath));
}

function exactDirectoryMatch(leftPath, rightPath) {
  const leftEntries = readdirSync(leftPath).sort();
  const rightEntries = readdirSync(rightPath).sort();
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (let index = 0; index < leftEntries.length; index += 1) {
    if (leftEntries[index] !== rightEntries[index]) {
      return false;
    }
  }
  for (const entry of leftEntries) {
    const leftEntryPath = join(leftPath, entry);
    const rightEntryPath = join(rightPath, entry);
    if (!exactPathMatch(leftEntryPath, rightEntryPath)) {
      return false;
    }
  }
  return true;
}

export function exactPathMatch(leftPath, rightPath) {
  if (!existsSync(leftPath) || !existsSync(rightPath)) {
    return false;
  }

  const leftStat = statSync(leftPath);
  const rightStat = statSync(rightPath);

  if (leftStat.isFile() !== rightStat.isFile() || leftStat.isDirectory() !== rightStat.isDirectory()) {
    return false;
  }

  if (leftStat.isFile()) {
    return exactFileMatch(leftPath, rightPath);
  }

  if (leftStat.isDirectory()) {
    return exactDirectoryMatch(leftPath, rightPath);
  }

  return false;
}

function ownershipFromMatches(repoRoot, mapping) {
  const legacyFullPath = join(repoRoot, mapping.legacyPath);
  const currentFullPath = join(repoRoot, mapping.currentPath);
  const bundledFullPath = bundledToolkitPath(mapping.currentPath);

  if (existsSync(currentFullPath) && exactPathMatch(legacyFullPath, currentFullPath)) {
    return {
      owned: true,
      reason: `matches ${mapping.currentPath}`,
    };
  }

  if (exactPathMatch(legacyFullPath, bundledFullPath)) {
    return {
      owned: true,
      reason: 'matches bundled Agentic Loop canonical source',
    };
  }

  return {
    owned: false,
    reason: 'ownership could not be confirmed by exact content match',
  };
}

export function inspectLegacyCanonicalAssets(repoRoot) {
  if (isPackageSourceRepositoryRoot(repoRoot)) {
    return [];
  }

  const assets = [];
  for (const mapping of LEGACY_CANONICAL_ASSET_MAPPINGS) {
    const legacyFullPath = join(repoRoot, mapping.legacyPath);
    if (!existsSync(legacyFullPath)) {
      continue;
    }
    assets.push({
      ...mapping,
      ...ownershipFromMatches(repoRoot, mapping),
    });
  }
  return assets;
}

export function migrateLegacyCanonicalAssets(repoRoot) {
  const migrated = [];
  const removed = [];
  const preserved = [];
  const warnings = [];
  const errors = [];

  if (isPackageSourceRepositoryRoot(repoRoot)) {
    return { migrated, removed, preserved, warnings, errors };
  }

  for (const mapping of LEGACY_CANONICAL_ASSET_MAPPINGS) {
    const legacyFullPath = join(repoRoot, mapping.legacyPath);
    if (!existsSync(legacyFullPath)) {
      continue;
    }

    const currentFullPath = join(repoRoot, mapping.currentPath);
    const ownership = ownershipFromMatches(repoRoot, mapping);
    if (!ownership.owned) {
      preserved.push(mapping.legacyPath);
      warnings.push(
        `Preserving legacy root asset '${mapping.legacyPath}' because ${ownership.reason}.`
      );
      continue;
    }

    ensureDir(dirname(currentFullPath));

    if (existsSync(currentFullPath)) {
      if (exactPathMatch(legacyFullPath, currentFullPath)) {
        rmSync(legacyFullPath, { recursive: true, force: true });
        removed.push(mapping.legacyPath);
      } else {
        preserved.push(mapping.legacyPath);
        warnings.push(
          `Preserving legacy root asset '${mapping.legacyPath}' because '${mapping.currentPath}' already exists with different content.`
        );
      }
      continue;
    }

    try {
      renameSync(legacyFullPath, currentFullPath);
      migrated.push(`${mapping.legacyPath} -> ${mapping.currentPath}`);
    } catch (error) {
      errors.push(`${mapping.legacyPath}: ${error.message}`);
    }
  }

  return { migrated, removed, preserved, warnings, errors };
}

export function migrateV2TargetConfig(repoRoot) {
  const migrated = [];
  const warnings = [];

  const configPath = join(repoRoot, 'agenticloop.json');
  if (!existsSync(configPath)) {
    return { migrated, warnings };
  }

  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return { migrated, warnings };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { migrated, warnings };
  }

  if (!parsed || typeof parsed.extends !== 'string') {
    return { migrated, warnings };
  }

  const normalized = parsed.extends.replace(/\\/g, '/').replace(/^\.\//, '');
  const v2Default = V2_BASE_CONFIG_RELATIVE_PATH.replace(/^\.\//, '');
  const v3Default = CONFIG_RELATIVE_PATH.replace(/^\.\//, '');

  if (normalized === v2Default) {
    parsed.extends = `./${v3Default}`;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    migrated.push(`agenticloop.json: extends rewritten from ./agenticloop/base.json to ./${v3Default}`);
  } else if (normalized !== v3Default) {
    const extendsTarget = join(repoRoot, parsed.extends);
    if (!existsSync(extendsTarget)) {
      warnings.push(
        `agenticloop.json extends '${parsed.extends}' which does not exist. If this pointed at the old agenticloop/base.json, update it to ./agenticloop/config.json.`
      );
    }
  }

  return { migrated, warnings };
}

export function validateLayoutState(repoRoot) {
  const errors = [];
  const warnings = [];
  const manifestPath = join(repoRoot, MANIFEST_RELATIVE_PATH);

  if (existsSync(join(repoRoot, 'agenticloop')) && !existsSync(manifestPath)) {
    errors.push(
      `Current-layout source directory exists without manifest ownership: ${MANIFEST_RELATIVE_PATH}`
    );
  }

  if (existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = loadLayoutManifest(repoRoot);
    } catch (error) {
      errors.push(`${MANIFEST_RELATIVE_PATH}: ${error.message}`);
      manifest = null;
    }

    if (manifest) {
      const installedVersion = Number(manifest.layoutVersion);
      let validateCurrentSourcePaths = true;
      if (installedVersion !== CURRENT_LAYOUT_VERSION) {
        validateCurrentSourcePaths = false;
        if (installedVersion === 2) {
          errors.push(
            `Installed layout is version 2. Run 'agenticloop update' to migrate to layoutVersion ${CURRENT_LAYOUT_VERSION}.`
          );
        } else {
          errors.push(
            `${MANIFEST_RELATIVE_PATH} must declare layoutVersion ${CURRENT_LAYOUT_VERSION}`
          );
        }
      }
      if (validateCurrentSourcePaths) {
        for (const relPath of TOOLKIT_SOURCE_RELATIVE_PATHS) {
          if (!existsSync(join(repoRoot, relPath))) {
            errors.push(`Current-layout source path missing: ${relPath}`);
          }
        }
      }
    }
  }

  for (const asset of inspectLegacyCanonicalAssets(repoRoot)) {
    if (asset.owned) {
      warnings.push(
        `Legacy root asset '${asset.legacyPath}' is stale under layout v2 (${asset.reason}); run 'agenticloop update' to migrate or remove it.`
      );
      continue;
    }
    warnings.push(
      `Legacy root path '${asset.legacyPath}' exists but Agentic Loop ownership could not be confirmed; preserving it in place.`
    );
  }

  return { errors, warnings };
}
