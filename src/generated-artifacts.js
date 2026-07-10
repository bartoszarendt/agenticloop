/**
 * Generated-artifact ownership manifest.
 *
 * Tracks every file, directory, and shared-config mutation that an adapter
 * generator creates, so removal can be precise, reversible, and safe.
 *
 * The manifest lives at .agenticloop/generated-artifacts.json and is
 * versioned. Only non-sensitive ownership metadata is stored; no file
 * contents, credentials, or unrelated user configuration.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { TARGET_STATE_DIRECTORY } from './layout.js';

export const GENERATED_ARTIFACTS_FILENAME = 'generated-artifacts.json';
export const GENERATED_ARTIFACTS_SCHEMA_VERSION = 1;

const GENERATED_ARTIFACTS_PATH = join(TARGET_STATE_DIRECTORY, GENERATED_ARTIFACTS_FILENAME);

// ---------------------------------------------------------------------------
// Path validation helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a repo-relative path to forward-slash form.
 * @param {string} relPath
 * @returns {string}
 */
function normalizeRelPath(relPath) {
  return normalize(relPath).replace(/\\/g, '/');
}

/**
 * Ensure a path does not escape its declared output root.
 * @param {string} outputRoot  Normalized output root (e.g. ".")
 * @param {string} relPath     Normalized relative path
 */
function assertInsideRoot(outputRoot, relPath) {
  const resolved = resolve(outputRoot, relPath);
  const rootResolved = resolve(outputRoot);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${sep}`)) {
    throw new Error(`Path escapes declared output root: ${relPath}`);
  }
}

/**
 * Assert a path is not absolute and has no traversal sequences.
 * @param {string} relPath
 */
function assertSafeRelativePath(relPath) {
  // Check raw input before normalization so backslash paths are rejected.
  if (relPath.includes('\\')) {
    throw new Error(`Path must use forward slashes: ${relPath}`);
  }
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`Absolute path not allowed in manifest: ${relPath}`);
  }
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Path traversal not allowed in manifest: ${relPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// SHA-256 hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a file.
 * @param {string} filePath
 * @returns {string} hex digest
 */
export function hashFile(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-256 hash of a string.
 * @param {string} content
 * @returns {string} hex digest
 */
export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

/**
 * Load the ownership manifest from a target directory.
 * Returns null if the file does not exist.
 * @param {string} targetRoot
 * @returns {{ schemaVersion: number, packageVersion: string, entries: ManifestEntry[] } | null}
 */
export function loadManifest(targetRoot) {
  const manifestPath = join(targetRoot, GENERATED_ARTIFACTS_PATH);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (typeof data.schemaVersion !== 'number') return null;
    if (!Array.isArray(data.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Save the ownership manifest to a target directory.
 * @param {string} targetRoot
 * @param {{ schemaVersion: number, packageVersion: string, entries: ManifestEntry[] }} manifest
 */
export function saveManifest(targetRoot, manifest) {
  const manifestDir = join(targetRoot, TARGET_STATE_DIRECTORY);
  if (!existsSync(manifestDir)) {
    mkdirSync(manifestDir, { recursive: true });
  }
  const manifestPath = join(targetRoot, GENERATED_ARTIFACTS_PATH);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the manifest if it exists and has no entries.
 * @param {string} targetRoot
 */
export function removeManifestIfEmpty(targetRoot) {
  const manifest = loadManifest(targetRoot);
  if (manifest && manifest.entries.length === 0) {
    const manifestPath = join(targetRoot, GENERATED_ARTIFACTS_PATH);
    if (existsSync(manifestPath)) {
      rmSync(manifestPath, { force: true });
    }
  }
}

/**
 * Get or create a blank manifest.
 * @param {string} [packageVersion]
 * @returns {{ schemaVersion: number, packageVersion: string, entries: ManifestEntry[] }}
 */
export function createManifest(packageVersion = '0.0.0') {
  return {
    schemaVersion: GENERATED_ARTIFACTS_SCHEMA_VERSION,
    packageVersion,
    entries: [],
  };
}

/**
 * Get the manifest, creating a blank one if needed.
 * @param {string} targetRoot
 * @param {string} [packageVersion]
 * @returns {{ schemaVersion: number, packageVersion: string, entries: ManifestEntry[] }}
 */
export function getOrCreateManifest(targetRoot, packageVersion) {
  return loadManifest(targetRoot) ?? createManifest(packageVersion);
}

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ManifestEntry
 * @property {string} adapter          Adapter name (opencode, codex, claude-code, copilot, cursor)
 * @property {string} outputRoot       Normalized output root (e.g. ".")
 * @property {string} relPath          Normalized repo-relative path
 * @property {'file'|'directory'|'shared-config'} kind  Artifact kind
 * @property {string} [hash]           SHA-256 hash of file content (files only)
 * @property {string} [marker]         Expected generated marker text
 * @property {'created'|'merged'} existence  Whether file was created new or merged
 * @property {string} [sharedConfigKey] For shared-config entries: the JSON key or path mutated
 * @property {boolean} [createdFile]   For shared-config: whether Agentic Loop created the entire file
 * @property {string[]} [children]     For directories: list of owned child relative paths
 * @property {string} [childHashes]    For directories: JSON map of child path -> hash
 * @property {string} generatedAt      ISO timestamp
 */

// ---------------------------------------------------------------------------
// Entry recording
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a manifest entry.
 * @param {Partial<ManifestEntry>} entry
 * @param {string} [packageVersion]
 * @returns {ManifestEntry}
 */
function validateEntry(entry, packageVersion) {
  if (!entry.adapter || typeof entry.adapter !== 'string') {
    throw new Error('Manifest entry requires a non-empty adapter string');
  }
  if (!entry.relPath || typeof entry.relPath !== 'string') {
    throw new Error('Manifest entry requires a non-empty relPath string');
  }
  if (!entry.kind || !['file', 'directory', 'shared-config'].includes(entry.kind)) {
    throw new Error(`Manifest entry has invalid kind: ${entry.kind}`);
  }

  // Validate raw input before normalization.
  assertSafeRelativePath(entry.relPath || '');
  const outputRoot = normalizeRelPath(entry.outputRoot || '.');
  const relPath = normalizeRelPath(entry.relPath);
  assertInsideRoot(outputRoot, relPath);

  return {
    adapter: entry.adapter,
    outputRoot,
    relPath,
    kind: entry.kind,
    hash: entry.hash || undefined,
    marker: entry.marker || undefined,
    existence: entry.existence || 'created',
    sharedConfigKey: entry.sharedConfigKey || undefined,
    createdFile: typeof entry.createdFile === 'boolean' ? entry.createdFile : undefined,
    children: entry.children || undefined,
    childHashes: entry.childHashes || undefined,
    generatedAt: entry.generatedAt || new Date().toISOString(),
  };
}

/**
 * Record a generated file artifact in the manifest.
 *
 * @param {string} targetRoot
 * @param {object} params
 * @param {string} params.adapter
 * @param {string} params.relPath
 * @param {string} params.outputRoot
 * @param {string} [params.marker]
 * @param {string} [params.packageVersion]
 * @returns {{ entry: ManifestEntry, manifest: object }}
 */
export function recordFileArtifact(targetRoot, params) {
  const manifest = getOrCreateManifest(targetRoot, params.packageVersion);
  const fullPath = join(targetRoot, params.relPath);
  const hash = existsSync(fullPath) ? hashFile(fullPath) : undefined;
  const existedBefore = existsSync(fullPath);

  const entry = validateEntry({
    adapter: params.adapter,
    outputRoot: params.outputRoot || '.',
    relPath: params.relPath,
    kind: 'file',
    hash,
    marker: params.marker,
    existence: existedBefore ? 'merged' : 'created',
  }, params.packageVersion);

  // Replace any existing entry for the same path
  manifest.entries = manifest.entries.filter(e => e.relPath !== entry.relPath);
  manifest.entries.push(entry);
  saveManifest(targetRoot, manifest);
  return { entry, manifest };
}

/**
 * Record a pre-registered entry (for external callers who constructed
 * a manifest entry and want to atomically add it and persist).
 *
 * @param {string} targetRoot
 * @param {Partial<ManifestEntry>} rawEntry
 * @param {string} [packageVersion]
 * @returns {{ entry: ManifestEntry, manifest: object }}
 */
export function recordEntry(targetRoot, rawEntry, packageVersion) {
  const manifest = getOrCreateManifest(targetRoot, packageVersion);
  const entry = validateEntry(rawEntry, packageVersion);
  manifest.entries = manifest.entries.filter(e => e.relPath !== entry.relPath);
  manifest.entries.push(entry);
  saveManifest(targetRoot, manifest);
  return { entry, manifest };
}

/**
 * Record a generated directory artifact in the manifest.
 * Records every child file with its hash.
 *
 * @param {string} targetRoot
 * @param {object} params
 * @param {string} params.adapter
 * @param {string} params.relPath   Relative path to the directory
 * @param {string} params.outputRoot
 * @param {string} [params.marker]
 * @param {string} [params.packageVersion]
 * @returns {{ entry: ManifestEntry, manifest: object }}
 */
export function recordDirectoryArtifact(targetRoot, params) {
  const manifest = getOrCreateManifest(targetRoot, params.packageVersion);
  const fullDir = join(targetRoot, params.relPath);
  const children = [];
  const childHashes = {};

  if (existsSync(fullDir) && statSync(fullDir).isDirectory()) {
    collectChildFiles(fullDir, fullDir, children, childHashes);
  }

  const entry = validateEntry({
    adapter: params.adapter,
    outputRoot: params.outputRoot || '.',
    relPath: params.relPath,
    kind: 'directory',
    marker: params.marker,
    children,
    childHashes: JSON.stringify(childHashes),
    existence: 'created',
  }, params.packageVersion);

  manifest.entries = manifest.entries.filter(e => e.relPath !== entry.relPath);
  manifest.entries.push(entry);
  saveManifest(targetRoot, manifest);
  return { entry, manifest };
}

/**
 * Recursively collect all files under a directory.
 * @param {string} baseDir
 * @param {string} currentDir
 * @param {string[]} children
 * @param {Record<string, string>} childHashes
 */
function collectChildFiles(baseDir, currentDir, children, childHashes) {
  for (const entry of readdirSync(currentDir)) {
    const full = join(currentDir, entry);
    const relFromBase = relative(baseDir, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      collectChildFiles(baseDir, full, children, childHashes);
    } else {
      children.push(relFromBase);
      childHashes[relFromBase] = hashFile(full);
    }
  }
}

/**
 * Record a shared-config mutation in the manifest.
 *
 * @param {string} targetRoot
 * @param {object} params
 * @param {string} params.adapter
 * @param {string} params.relPath      Path to the shared config file
 * @param {string} params.outputRoot
 * @param {string} params.sharedConfigKey  The key or entry path that was added
 * @param {boolean} params.createdFile  Whether Agentic Loop created the entire file
 * @param {string} [params.marker]
 * @param {string} [params.packageVersion]
 * @returns {{ entry: ManifestEntry, manifest: object }}
 */
export function recordSharedConfigArtifact(targetRoot, params) {
  const manifest = getOrCreateManifest(targetRoot, params.packageVersion);
  const fullPath = join(targetRoot, params.relPath);
  const hash = existsSync(fullPath) ? hashFile(fullPath) : undefined;

  const entry = validateEntry({
    adapter: params.adapter,
    outputRoot: params.outputRoot || '.',
    relPath: params.relPath,
    kind: 'shared-config',
    hash,
    marker: params.marker,
    sharedConfigKey: params.sharedConfigKey,
    createdFile: params.createdFile,
    existence: existsSync(fullPath) ? 'merged' : 'created',
  }, params.packageVersion);

  // For shared-config, allow multiple entries for the same file (different keys)
  const existing = manifest.entries.findIndex(
    e => e.relPath === entry.relPath && e.sharedConfigKey === entry.sharedConfigKey
  );
  if (existing >= 0) {
    manifest.entries[existing] = entry;
  } else {
    manifest.entries.push(entry);
  }
  saveManifest(targetRoot, manifest);
  return { entry, manifest };
}

// ---------------------------------------------------------------------------
// Entry queries
// ---------------------------------------------------------------------------

/**
 * Get all manifest entries for a given adapter.
 * @param {object} manifest
 * @param {string} adapter
 * @returns {ManifestEntry[]}
 */
export function getEntriesForAdapter(manifest, adapter) {
  return (manifest?.entries ?? []).filter(e => e.adapter === adapter);
}

/**
 * Get a manifest entry for a specific path.
 * @param {object} manifest
 * @param {string} relPath
 * @returns {ManifestEntry | undefined}
 */
export function getEntryForPath(manifest, relPath) {
  const normalized = normalizeRelPath(relPath);
  return (manifest?.entries ?? []).find(e => e.relPath === normalized);
}

/**
 * Get all manifest entries for a specific path (shared-config may have multiple).
 * @param {object} manifest
 * @param {string} relPath
 * @returns {ManifestEntry[]}
 */
export function getEntriesForPath(manifest, relPath) {
  const normalized = normalizeRelPath(relPath);
  return (manifest?.entries ?? []).filter(e => e.relPath === normalized);
}

// ---------------------------------------------------------------------------
// Entry removal
// ---------------------------------------------------------------------------

/**
 * Remove a manifest entry by path.
 * @param {string} targetRoot
 * @param {string} relPath
 * @returns {ManifestEntry[]} the removed entries
 */
export function removeEntry(targetRoot, relPath) {
  const manifest = loadManifest(targetRoot);
  if (!manifest) return [];
  const normalized = normalizeRelPath(relPath);
  const removed = manifest.entries.filter(e => e.relPath === normalized);
  manifest.entries = manifest.entries.filter(e => e.relPath !== normalized);
  if (manifest.entries.length === 0) {
    // Delete the manifest file directly since there are no remaining entries.
    const manifestPath = join(targetRoot, GENERATED_ARTIFACTS_PATH);
    if (existsSync(manifestPath)) {
      rmSync(manifestPath, { force: true });
    }
  } else {
    saveManifest(targetRoot, manifest);
  }
  return removed;
}

/**
 * Remove all manifest entries for a given adapter.
 * @param {string} targetRoot
 * @param {string} adapter
 * @returns {ManifestEntry[]} the removed entries
 */
export function removeEntriesForAdapter(targetRoot, adapter) {
  const manifest = loadManifest(targetRoot);
  if (!manifest) return [];
  const removed = manifest.entries.filter(e => e.adapter === adapter);
  manifest.entries = manifest.entries.filter(e => e.adapter !== adapter);
  if (manifest.entries.length === 0) {
    removeManifestIfEmpty(targetRoot);
  } else {
    saveManifest(targetRoot, manifest);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Ownership verification
// ---------------------------------------------------------------------------

/**
 * Classification of a file against the ownership manifest.
 * @typedef {Object} OwnershipClassification
 * @property {'exact-owned'|'owned-modified'|'unowned'|'unrecognized'|'manifest-missing'|'malformed-manifest'} status
 * @property {ManifestEntry} [entry]
 * @property {string} [currentHash]
 * @property {string} [expectedHash]
 * @property {string} [message]
 */

/**
 * Classify a file against the manifest to determine if it can be safely removed.
 *
 * @param {string} targetRoot
 * @param {string} relPath
 * @returns {OwnershipClassification}
 */
export function classifyFile(targetRoot, relPath) {
  const manifest = loadManifest(targetRoot);
  if (!manifest) {
    return { status: 'manifest-missing' };
  }
  if (typeof manifest.schemaVersion !== 'number' || !Array.isArray(manifest.entries)) {
    return { status: 'malformed-manifest', message: 'Manifest has invalid structure' };
  }

  const normalized = normalizeRelPath(relPath);
  const entry = manifest.entries.find(e => e.relPath === normalized);
  if (!entry) {
    return { status: 'unrecognized' };
  }

  const fullPath = join(targetRoot, relPath);
  if (!existsSync(fullPath)) {
    return { status: 'exact-owned', entry, message: 'File missing from disk but recorded in manifest' };
  }

  if (entry.kind === 'file' && entry.hash) {
    const currentHash = hashFile(fullPath);
    if (currentHash === entry.hash) {
      return { status: 'exact-owned', entry, currentHash };
    }
    return {
      status: 'owned-modified',
      entry,
      currentHash,
      expectedHash: entry.hash,
      message: 'File has been modified since generation',
    };
  }

  return { status: 'exact-owned', entry };
}

/**
 * Classify a directory against the manifest.
 * For directories, checks if every child file is owned and unmodified.
 *
 * @param {string} targetRoot
 * @param {string} relPath  Relative path to the directory
 * @returns {{ status: 'exact-owned'|'owned-modified'|'unrecognized'|'manifest-missing',
 *             entry?: ManifestEntry,
 *             unknownChildren?: string[],
 *             modifiedChildren?: string[] }}
 */
export function classifyDirectory(targetRoot, relPath) {
  const manifest = loadManifest(targetRoot);
  if (!manifest) {
    return { status: 'manifest-missing' };
  }

  const normalized = normalizeRelPath(relPath);
  const entry = manifest.entries.find(e => e.relPath === normalized && e.kind === 'directory');
  if (!entry) {
    return { status: 'unrecognized' };
  }

  const fullDir = join(targetRoot, relPath);
  if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) {
    return { status: 'exact-owned', entry };
  }

  const ownedChildren = new Set(entry.children ?? []);
  let parsedChildHashes = {};
  try {
    parsedChildHashes = entry.childHashes ? JSON.parse(entry.childHashes) : {};
  } catch {
    return { status: 'owned-modified', entry, unknownChildren: ['(malformed child hashes)'] };
  }

  const unknownChildren = [];
  const modifiedChildren = [];

  // Walk actual children
  const actualChildren = [];
  collectChildFileNames(fullDir, fullDir, actualChildren);

  for (const child of actualChildren) {
    if (!ownedChildren.has(child)) {
      unknownChildren.push(child);
    } else if (parsedChildHashes[child]) {
      const childPath = join(fullDir, child);
      const currentHash = hashFile(childPath);
      if (currentHash !== parsedChildHashes[child]) {
        modifiedChildren.push(child);
      }
    }
  }

  if (unknownChildren.length > 0 || modifiedChildren.length > 0) {
    return { status: 'owned-modified', entry, unknownChildren, modifiedChildren };
  }

  return { status: 'exact-owned', entry };
}

/**
 * Collect child file names relative to baseDir (non-recursive contents).
 * @param {string} baseDir
 * @param {string} currentDir
 * @param {string[]} result
 */
function collectChildFileNames(baseDir, currentDir, result) {
  for (const entry of readdirSync(currentDir)) {
    const full = join(currentDir, entry);
    const relFromBase = relative(baseDir, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      collectChildFileNames(baseDir, full, result);
    } else {
      result.push(relFromBase);
    }
  }
}
