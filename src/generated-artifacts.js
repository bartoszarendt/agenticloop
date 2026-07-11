/**
 * Ownership manifest and containment primitives for generated adapter output.
 * Manifest data is untrusted input: validate it before it controls any I/O.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_STATE_DIRECTORY } from './layout.js';

export const GENERATED_ARTIFACTS_FILENAME = 'generated-artifacts.json';
export const GENERATED_ARTIFACTS_SCHEMA_VERSION = 4;
const SUPPORTED_ADAPTERS = new Set(['opencode', 'claude-code', 'codex', 'copilot', 'cursor']);
// Host-neutral owners for core installation artifacts that are not one of the
// five host adapters (for example the shared repository-rules guidance block).
const CORE_OWNERS = new Set(['core']);
// Owners allowed for a given entry kind. marker-block is a core installation
// artifact and must never be attributed to a host adapter.
const KIND_OWNERS = {
  'file': SUPPORTED_ADAPTERS,
  'shared-config': SUPPORTED_ADAPTERS,
  'gitignore-line': SUPPORTED_ADAPTERS,
  'marker-block': CORE_OWNERS,
};
const KINDS = new Set(['file', 'shared-config', 'gitignore-line', 'marker-block']);
const MANIFEST_PATH = `${TARGET_STATE_DIRECTORY}/${GENERATED_ARTIFACTS_FILENAME}`;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

export function loadPackageVersion() {
  try {
    const value = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
    return typeof value === 'string' && value ? value : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fail(message) {
  throw new Error(`Ownership manifest: ${message}`);
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value) {
    fail(`${label} must be a non-empty forward-slash relative path`);
  }
  if (value.includes(String.fromCharCode(92))) {
    fail(`${label} must use forward slashes`);
  }
  if (value.includes('\x00')) {
    fail(`${label} contains NUL`);
  }
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('/')) {
    fail(`Absolute path not allowed in manifest: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail(`Path traversal not allowed in manifest: ${value}`);
  }
  return value;
}

export function normalizeOutputRoot(outputRoot = '.') {
  if (outputRoot === '.') return '.';
  return safeRelative(outputRoot, 'outputRoot');
}

/**
 * Resolve a managed destination and reject lexical escapes and symlink/junction
 * traversal. Existing symlinks are never followed for generated artifacts.
 */
export function resolveManagedPath(targetRoot, outputRoot = '.', relPath = '.') {
  const target = resolve(targetRoot);
  const root = normalizeOutputRoot(outputRoot);
  const path = relPath === '.' ? '.' : safeRelative(relPath, 'relPath');
  const destination = resolve(target, root === '.' ? '.' : root, path === '.' ? '.' : path);
  if (destination !== target && !destination.startsWith(target + sep)) {
    fail(`path escapes target: ${outputRoot}/${relPath}`);
  }
  const targetReal = existsSync(target) ? realpathSync.native(target) : target;
  let current = target;
  const segments = relative(target, destination).split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      fail(`path crosses a symlink or junction: ${relative(target, current)}`);
    }
  }
  if (existsSync(destination)) {
    const actual = realpathSync.native(destination);
    if (actual !== targetReal && !actual.startsWith(targetReal + sep)) fail(`path resolves outside target: ${relPath}`);
  }
  return destination;
}

// Kind-specific allowed entry keys (Defect 16).
const FILE_ENTRY_KEYS = new Set(['adapter', 'outputRoot', 'relPath', 'kind', 'hash', 'marker', 'existence', 'generatedAt']);
const SHARED_CONFIG_ENTRY_KEYS = new Set(['adapter', 'outputRoot', 'relPath', 'kind', 'existence', 'generatedAt', 'mutations', 'createdFile', 'nonReversible', 'sharedConfigKey']);
const GITIGNORE_ENTRY_KEYS = new Set(['adapter', 'outputRoot', 'relPath', 'kind', 'existence', 'generatedAt', 'line', 'occurrence', 'createdFile', 'ambiguous']);
// marker-block manages a single owned region inside a shared Markdown file
// (currently the repository-rules activation-guidance block). The startMarker
// and endMarker define the reversible region. Optional separators record the
// exact bytes inserted around an appended block so removal restores the target
// document rather than normalizing its whitespace.
const MARKER_BLOCK_ENTRY_KEYS = new Set(['adapter', 'outputRoot', 'relPath', 'kind', 'existence', 'generatedAt', 'startMarker', 'endMarker', 'hash', 'createdFile', 'ownedPrefix', 'ownedSuffix']);
// Separator metadata is read from an untrusted manifest and later expands the
// range removed around a managed block. Restrict it to the exact newline-only
// values the guidance renderer can generate so forged metadata cannot claim
// adjacent target-owned rules text.
const MARKER_BLOCK_OWNED_PREFIXES = new Set(['', '\n', '\n\n', '\r\n', '\r\n\r\n']);
const MARKER_BLOCK_OWNED_SUFFIXES = new Set(['', '\n', '\r\n']);

// Operation-specific mutation keys (Defect 16).
const ARRAY_ADD_KEYS = new Set(['op', 'pointer', 'value', 'added', 'createdContainers']);
const SET_IF_ABSENT_KEYS = new Set(['op', 'pointer', 'value', 'added', 'createdContainers']);
const REPLACE_ARRAY_ELEMENT_KEYS = new Set(['op', 'pointer', 'value', 'added', 'previous', 'createdContainers', 'matchKey', 'matchValue']);

function validateMutation(mutation, index) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) fail(`mutations[${index}] must be an object`);
  if (!['array-add', 'set-if-absent', 'replace-array-element'].includes(mutation.op)) fail(`mutations[${index}].op is invalid`);
  if (typeof mutation.pointer !== 'string' || !mutation.pointer.startsWith('/') || mutation.pointer.includes('~')) fail(`mutations[${index}].pointer is invalid`);
  if (!Object.hasOwn(mutation, 'value')) fail(`mutations[${index}].value is required`);
  if (typeof mutation.added !== 'boolean') fail(`mutations[${index}].added is required`);
  if (mutation.op === 'replace-array-element') {
    if (typeof mutation.matchKey !== 'string' || !mutation.matchKey.trim()) fail(`mutations[${index}].matchKey must be a non-empty string`);
    if (!Object.hasOwn(mutation, 'matchValue')) fail(`mutations[${index}].matchValue is required`);
  }
  // Reject matchKey/matchValue/previous on operations that don't use them.
  if (mutation.op === 'array-add') {
    if (Object.hasOwn(mutation, 'matchKey')) fail(`mutations[${index}].matchKey is not valid for ${mutation.op}`);
    if (Object.hasOwn(mutation, 'matchValue')) fail(`mutations[${index}].matchValue is not valid for ${mutation.op}`);
    if (Object.hasOwn(mutation, 'previous')) fail(`mutations[${index}].previous is not valid for ${mutation.op}`);
  }
  if (mutation.op === 'set-if-absent') {
    if (Object.hasOwn(mutation, 'matchKey')) fail(`mutations[${index}].matchKey is not valid for ${mutation.op}`);
    if (Object.hasOwn(mutation, 'matchValue')) fail(`mutations[${index}].matchValue is not valid for ${mutation.op}`);
    if (Object.hasOwn(mutation, 'previous')) fail(`mutations[${index}].previous is not valid for ${mutation.op}`);
  }
  if (mutation.createdContainers !== undefined) {
    if (!Array.isArray(mutation.createdContainers)) fail(`mutations[${index}].createdContainers must be an array`);
    for (const [ci, container] of mutation.createdContainers.entries()) {
      if (typeof container !== 'string' || !container.startsWith('/')) fail(`mutations[${index}].createdContainers[${ci}] must be a valid JSON pointer`);
    }
  }
  // Use operation-specific key allowlist.
  const allowedKeys = mutation.op === 'array-add' ? ARRAY_ADD_KEYS
    : mutation.op === 'set-if-absent' ? SET_IF_ABSENT_KEYS
    : REPLACE_ARRAY_ELEMENT_KEYS;
  for (const key of Object.keys(mutation)) {
    if (!allowedKeys.has(key)) fail(`mutations[${index}] has unknown key for ${mutation.op}: ${key}`);
  }
  return { ...mutation };
}

// Legacy global key set removed; kind-specific sets are used below.

export function validateManifestEntry(raw, { migrate = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('entry must be an object');
  const kind = raw.kind;
  if (!KINDS.has(kind)) fail(`entry kind is invalid: ${kind}`);
  const allowedOwners = KIND_OWNERS[kind];
  if (!allowedOwners.has(raw.adapter)) {
    fail(kind === 'marker-block'
      ? `Manifest ${kind} entry requires a core owner: ${raw.adapter}`
      : `Manifest entry requires a non-empty supported adapter: ${raw.adapter}`);
  }
  const outputRoot = normalizeOutputRoot(raw.outputRoot ?? '.');
  const relPath = safeRelative(raw.relPath, 'relPath');
  if (!['created', 'refreshed', 'merged'].includes(raw.existence ?? 'created')) fail(`entry existence is invalid: ${raw.existence}`);
  if (raw.hash !== undefined && (typeof raw.hash !== 'string' || !SHA256.test(raw.hash))) fail(`entry hash is invalid for ${relPath}`);
  if (raw.marker !== undefined && typeof raw.marker !== 'string') fail(`entry marker is invalid for ${relPath}`);
  if (raw.generatedAt !== undefined && (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt)))) fail(`entry generatedAt is invalid for ${relPath}`);
  if (kind === 'file' && !raw.hash && !migrate) fail(`file entry requires a hash: ${relPath}`);
  if (kind === 'shared-config') {
    if (!Array.isArray(raw.mutations)) {
      if (!migrate) fail(`shared-config entry requires mutations: ${relPath}`);
    } else {
      raw.mutations.forEach(validateMutation);
    }
    if (raw.createdFile !== undefined && typeof raw.createdFile !== 'boolean') fail(`createdFile is invalid for ${relPath}`);
  }
  if (kind === 'gitignore-line') {
    if (typeof raw.line !== 'string' || !raw.line.trim()) fail(`gitignore line is invalid for ${relPath}`);
    if (!Number.isInteger(raw.occurrence) || raw.occurrence < 0) fail(`gitignore occurrence is invalid for ${relPath}`);
    if (typeof raw.createdFile !== 'boolean') fail(`gitignore createdFile is invalid for ${relPath}`);
    if (raw.ambiguous !== undefined && typeof raw.ambiguous !== 'boolean') fail(`gitignore ambiguous is invalid for ${relPath}`);
  }
  if (kind === 'marker-block') {
    if (typeof raw.startMarker !== 'string' || !raw.startMarker.trim()) fail(`marker-block startMarker is invalid for ${relPath}`);
    if (typeof raw.endMarker !== 'string' || !raw.endMarker.trim()) fail(`marker-block endMarker is invalid for ${relPath}`);
    if (raw.startMarker === raw.endMarker) fail(`marker-block markers must be distinct for ${relPath}`);
    if (raw.startMarker.includes('\n') || raw.startMarker.includes('\r') || raw.endMarker.includes('\n') || raw.endMarker.includes('\r')) fail(`marker-block markers must be single-line for ${relPath}`);
    if (typeof raw.hash !== 'string' || !SHA256.test(raw.hash)) fail(`marker-block requires a valid hash for ${relPath}`);
    if (typeof raw.createdFile !== 'boolean') fail(`marker-block createdFile is invalid for ${relPath}`);
    if (raw.ownedPrefix !== undefined && !MARKER_BLOCK_OWNED_PREFIXES.has(raw.ownedPrefix)) {
      fail(`marker-block ownedPrefix must be an exact generated newline separator for ${relPath}`);
    }
    if (raw.ownedSuffix !== undefined && !MARKER_BLOCK_OWNED_SUFFIXES.has(raw.ownedSuffix)) {
      fail(`marker-block ownedSuffix must be an exact generated newline separator for ${relPath}`);
    }
    if (
      raw.ownedPrefix && raw.ownedSuffix &&
      raw.ownedPrefix.includes('\r\n') !== raw.ownedSuffix.includes('\r\n')
    ) {
      fail(`marker-block owned separators must use one newline style for ${relPath}`);
    }
  }
  // Kind-specific field validation (Defect 16).
  const allowedKeys = kind === 'file' ? FILE_ENTRY_KEYS
    : kind === 'shared-config' ? SHARED_CONFIG_ENTRY_KEYS
    : kind === 'marker-block' ? MARKER_BLOCK_ENTRY_KEYS
    : GITIGNORE_ENTRY_KEYS;
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`entry has unknown key for ${kind} kind: ${key}`);
  }
  return {
    ...raw,
    outputRoot,
    relPath,
    existence: raw.existence ?? 'created',
    generatedAt: raw.generatedAt ?? new Date().toISOString(),
    ...(kind === 'shared-config' && !raw.mutations ? { nonReversible: true, mutations: [] } : {}),
  };
}

function migrateManifest(data) {
  if (data.schemaVersion === 4) return data;
  if (typeof data.schemaVersion !== 'number') fail('invalid or missing schemaVersion');
  if (![1, 2, 3].includes(data.schemaVersion)) fail(`unsupported schemaVersion ${data.schemaVersion}`);
  if (!Array.isArray(data.entries)) fail('entries must be an array');
  // v3 -> v4 adds the marker-block kind and the `core` owner without changing
  // any existing adapter entries; bump the version and keep entries verbatim.
  if (data.schemaVersion === 3) {
    return { ...data, schemaVersion: 4 };
  }
  // v1/v2 -> v4: normalize legacy entries, then land on the current version.
  return {
    schemaVersion: 4,
    packageVersion: typeof data.packageVersion === 'string' && data.packageVersion ? data.packageVersion : '0.0.0',
    generatedAt: data.generatedAt,
    entries: data.entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (entry.kind === 'directory') return null;
      if (entry.kind === 'shared-config') return { ...entry, mutations: [], nonReversible: true };
      if (entry.kind === 'gitignore-line') return { ...entry, occurrence: 0, createdFile: Boolean(entry.createdFile) };
      return entry.hash ? entry : null;
    }).filter(Boolean),
  };
}

const MANIFEST_KNOWN_KEYS = new Set(['schemaVersion', 'packageVersion', 'generatedAt', 'entries']);

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('document must be an object');
  if (manifest.schemaVersion !== 4) fail(`unsupported schemaVersion ${manifest.schemaVersion}`);
  if (typeof manifest.packageVersion !== 'string' || !manifest.packageVersion) fail('packageVersion must be a non-empty string');
  if (manifest.generatedAt !== undefined && (typeof manifest.generatedAt !== 'string' || Number.isNaN(Date.parse(manifest.generatedAt)))) fail('generatedAt is invalid');
  if (!Array.isArray(manifest.entries)) fail('entries must be an array');
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KNOWN_KEYS.has(key)) fail(`manifest has unknown key: ${key}`);
  }
  const identities = new Set();
  const entries = manifest.entries.map((entry, index) => {
    try {
      const validated = validateManifestEntry(entry);
      const identity = entryIdentity(validated);
      if (identities.has(identity)) fail(`duplicate entry identity at index ${index}`);
      identities.add(identity);
      return validated;
    } catch (error) {
      throw new Error(`Ownership manifest entry ${index}: ${error.message}`);
    }
  });
  return { schemaVersion: 4, packageVersion: manifest.packageVersion, generatedAt: manifest.generatedAt, entries };
}

export function loadManifest(targetRoot) {
  const manifestPath = resolveManagedPath(targetRoot, '.', MANIFEST_PATH);
  if (!existsSync(manifestPath)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Ownership manifest at ${MANIFEST_PATH} is malformed JSON: ${error.message}`);
  }
  return validateManifest(migrateManifest(data));
}

export function createManifest(packageVersion = loadPackageVersion()) {
  return { schemaVersion: 4, packageVersion, generatedAt: new Date().toISOString(), entries: [] };
}

export function getOrCreateManifest(targetRoot, packageVersion) {
  return loadManifest(targetRoot) ?? createManifest(packageVersion);
}

export function entryIdentity(entry) {
  let mutation;
  if (entry.kind === 'gitignore-line') mutation = `${entry.line}:${entry.occurrence}`;
  else if (entry.kind === 'marker-block') mutation = `${entry.startMarker} ${entry.endMarker}`;
  else mutation = entry.sharedConfigKey ?? '';
  return [entry.adapter, entry.outputRoot, entry.relPath, entry.kind, mutation].join('\u0000');
}

export function saveManifest(targetRoot, manifest) {
  const valid = validateManifest(manifest);
  const manifestPath = resolveManagedPath(targetRoot, '.', MANIFEST_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...valid, generatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  try {
    renameSync(temporary, manifestPath);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function removeManifestIfEmpty(targetRoot) {
  const manifest = loadManifest(targetRoot);
  if (manifest && manifest.entries.length === 0) rmSync(resolveManagedPath(targetRoot, '.', MANIFEST_PATH), { force: true });
}

export function createFileEntry(params) {
  return validateManifestEntry({
    adapter: params.adapter, outputRoot: params.outputRoot ?? '.', relPath: params.relPath,
    kind: 'file', hash: params.hash ?? hashContent(params.content ?? ''), marker: params.marker,
    existence: params.existence ?? 'created', generatedAt: params.generatedAt,
  });
}

export function createSharedConfigEntry(params) {
  return validateManifestEntry({
    adapter: params.adapter, outputRoot: params.outputRoot ?? '.', relPath: params.relPath,
    kind: 'shared-config', mutations: params.mutations ?? [], createdFile: Boolean(params.createdFile),
    existence: 'merged', generatedAt: params.generatedAt,
  });
}

export function createMarkerBlockEntry(params) {
  return validateManifestEntry({
    adapter: params.owner ?? 'core', outputRoot: params.outputRoot ?? '.', relPath: params.relPath,
    kind: 'marker-block', startMarker: params.startMarker, endMarker: params.endMarker,
    hash: params.hash ?? hashContent(params.content ?? ''), createdFile: Boolean(params.createdFile),
    ...(params.ownedPrefix !== undefined ? { ownedPrefix: params.ownedPrefix } : {}),
    ...(params.ownedSuffix !== undefined ? { ownedSuffix: params.ownedSuffix } : {}),
    existence: params.existence ?? 'created', generatedAt: params.generatedAt,
  });
}

export function createGitignoreEntry(params) {
  return validateManifestEntry({
    adapter: params.adapter, outputRoot: params.outputRoot ?? '.', relPath: params.relPath,
    kind: 'gitignore-line', line: params.line.trim(), occurrence: params.occurrence,
    createdFile: Boolean(params.createdFile), ...(params.ambiguous ? { ambiguous: true } : {}), existence: params.createdFile ? 'created' : 'merged', generatedAt: params.generatedAt,
  });
}

// Compatibility writers remain for external consumers; transaction code builds
// entries in memory and calls saveManifest exactly once.
export function recordFileArtifact(targetRoot, params) {
  const manifest = getOrCreateManifest(targetRoot, params.packageVersion);
  const path = resolveManagedPath(targetRoot, params.outputRoot ?? '.', params.relPath);
  const existed = existsSync(path);
  const entry = createFileEntry({ ...params, hash: params.hash ?? (params.content === undefined && existed ? hashFile(path) : undefined), existence: params.existence ?? (existed ? 'merged' : 'created') });
  manifest.entries = manifest.entries.filter(value => entryIdentity(value) !== entryIdentity(entry));
  manifest.entries.push(entry); saveManifest(targetRoot, manifest); return { entry, manifest };
}

export function recordSharedConfigArtifact(targetRoot, params) {
  const manifest = getOrCreateManifest(targetRoot, params.packageVersion);
  const entry = createSharedConfigEntry({ ...params, mutations: params.mutations ?? [] });
  if (params.sharedConfigKey) entry.sharedConfigKey = params.sharedConfigKey;
  manifest.entries = manifest.entries.filter(value => entryIdentity(value) !== entryIdentity(entry));
  manifest.entries.push(entry); saveManifest(targetRoot, manifest); return { entry, manifest };
}

export function recordGitignoreLineArtifact(targetRoot, params) {
  const manifest = getOrCreateManifest(targetRoot, params.packageVersion);
  const entry = createGitignoreEntry({ ...params, occurrence: params.occurrence ?? 0 });
  manifest.entries = manifest.entries.filter(value => entryIdentity(value) !== entryIdentity(entry));
  manifest.entries.push(entry); saveManifest(targetRoot, manifest); return { entry, manifest };
}

export function recordEntry(targetRoot, rawEntry, packageVersion) {
  const manifest = getOrCreateManifest(targetRoot, packageVersion);
  const entry = validateManifestEntry(rawEntry);
  manifest.entries = manifest.entries.filter(value => entryIdentity(value) !== entryIdentity(entry));
  manifest.entries.push(entry); saveManifest(targetRoot, manifest); return { entry, manifest };
}

/** @deprecated Directory scans are unsafe. Ownership is file-granular. */
export function recordDirectoryArtifact() {
  throw new Error('Directory ownership is no longer recorded; record planned file entries instead');
}

export function getEntriesForAdapter(manifest, adapter, outputRoot) {
  return (manifest?.entries ?? []).filter(entry => entry.adapter === adapter && (outputRoot === undefined || entry.outputRoot === outputRoot));
}
export function getEntryForPath(manifest, relPath, outputRoot = '.', adapter) {
  return (manifest?.entries ?? []).find(entry => entry.relPath === relPath && entry.outputRoot === outputRoot && (adapter === undefined || entry.adapter === adapter));
}
export function getEntriesForPath(manifest, relPath, outputRoot = '.') {
  return (manifest?.entries ?? []).filter(entry => entry.relPath === relPath && entry.outputRoot === outputRoot);
}
export function removeEntry(targetRoot, relPath, outputRoot = '.', adapter) {
  const manifest = loadManifest(targetRoot); if (!manifest) return [];
  const removed = manifest.entries.filter(entry => entry.relPath === relPath && entry.outputRoot === outputRoot && (adapter === undefined || entry.adapter === adapter));
  manifest.entries = manifest.entries.filter(entry => !removed.includes(entry));
  if (manifest.entries.length) saveManifest(targetRoot, manifest);
  else {
    const path = resolveManagedPath(targetRoot, '.', MANIFEST_PATH);
    if (existsSync(path)) rmSync(path, { force: true });
  }
  return removed;
}
export function removeEntriesForAdapter(targetRoot, adapter, outputRoot) {
  const manifest = loadManifest(targetRoot); if (!manifest) return [];
  const removed = manifest.entries.filter(entry => entry.adapter === adapter && (outputRoot === undefined || entry.outputRoot === outputRoot));
  manifest.entries = manifest.entries.filter(entry => !removed.includes(entry));
  if (manifest.entries.length) saveManifest(targetRoot, manifest); else removeManifestIfEmpty(targetRoot); return removed;
}

export function classifyFile(targetRoot, relPath, outputRoot = '.', adapter) {
  const manifest = loadManifest(targetRoot);
  if (!manifest) return { status: 'manifest-missing' };
  const entry = getEntryForPath(manifest, relPath, outputRoot, adapter);
  if (!entry || entry.kind !== 'file') return { status: 'unrecognized' };
  const path = resolveManagedPath(targetRoot, outputRoot, relPath);
  if (!existsSync(path)) return { status: 'exact-owned', entry, message: 'File missing from disk but recorded in manifest' };
  const currentHash = hashFile(path);
  return currentHash === entry.hash ? { status: 'exact-owned', entry, currentHash } : { status: 'owned-modified', entry, currentHash, expectedHash: entry.hash, message: 'File has been modified since generation' };
}

/** Compatibility classification: directories are intentionally never removed as units. */
export function classifyDirectory(targetRoot, relPath, outputRoot = '.', adapter) {
  const manifest = loadManifest(targetRoot);
  if (!manifest) return { status: 'manifest-missing' };
  const prefix = `${relPath.replace(/\/$/, '')}/`;
  const children = manifest.entries.filter(entry => entry.outputRoot === outputRoot && (!adapter || entry.adapter === adapter) && entry.kind === 'file' && entry.relPath.startsWith(prefix));
  return children.length ? { status: 'owned-modified', unknownChildren: [], modifiedChildren: [] } : { status: 'unrecognized' };
}
