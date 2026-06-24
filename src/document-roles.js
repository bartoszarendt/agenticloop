import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadJsonFile } from './json.js';
import { BUNDLED_BASE_CONFIG_PATH } from './layout.js';

let cachedBundledRegistry = null;

function loadBundledRegistry() {
  if (cachedBundledRegistry === null) {
    const bundled = loadJsonFile(BUNDLED_BASE_CONFIG_PATH);
    cachedBundledRegistry = bundled.documentRoles ?? {};
  }
  return cachedBundledRegistry;
}

function normalizeRoleEntry(roleName, entry) {
  return {
    roleName,
    purpose: typeof entry?.purpose === 'string' ? entry.purpose : 'reference',
    candidates: Array.isArray(entry?.candidates)
      ? entry.candidates.map(candidate => String(candidate))
      : [],
  };
}

export function getDocumentRoleRegistry(config = null) {
  const source = config?.documentRoles ?? loadBundledRegistry();
  const registry = {};

  for (const [roleName, entry] of Object.entries(source)) {
    registry[roleName] = normalizeRoleEntry(roleName, entry);
  }

  return registry;
}

export function getDocumentRoleNames(config = null) {
  return Object.keys(getDocumentRoleRegistry(config));
}

export function getDefaultDocumentSelections(config = null) {
  const registry = getDocumentRoleRegistry(config);
  const defaults = {};

  for (const [roleName, entry] of Object.entries(registry)) {
    if (entry.purpose !== 'primary') continue;

    const preferredCandidate = entry.candidates.find(
      candidate => typeof candidate === 'string' && candidate && !candidate.endsWith('/')
    );
    if (preferredCandidate) {
      defaults[roleName] = preferredCandidate;
    }
  }

  return defaults;
}

export function findFirstExistingDocumentCandidate(repoRoot, roleEntry) {
  for (const candidate of roleEntry.candidates ?? []) {
    if (candidate && existsSync(join(repoRoot, candidate))) {
      return candidate;
    }
  }
  return null;
}

export function resolveDocumentSelections(repoRoot, config = null, projectDocuments = null) {
  const registry = getDocumentRoleRegistry(config);
  const defaults = getDefaultDocumentSelections(config);
  const explicitDocuments = projectDocuments ?? {};
  const selections = {};

  for (const roleName of Object.keys(registry)) {
    const explicitPath = explicitDocuments[roleName] ?? config?.documents?.[roleName];
    if (typeof explicitPath === 'string' && explicitPath.trim()) {
      selections[roleName] = explicitPath.trim();
      continue;
    }

    const detected = findFirstExistingDocumentCandidate(repoRoot, registry[roleName]);
    if (detected) {
      selections[roleName] = detected;
      continue;
    }

    if (defaults[roleName]) {
      selections[roleName] = defaults[roleName];
    }
  }

  return selections;
}
