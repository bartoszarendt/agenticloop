/**
 * Generic filesystem mutation kernel.
 *
 * This module owns the target-bound path validation, atomic writes, snapshots,
 * rollback, and transaction-created empty-directory cleanup shared by every
 * mutation flow in the package. Domain layers (adapter generation with its
 * ownership manifest and collision rules in `generation-transaction.js`, and
 * lifecycle plan apply in `lifecycle-plan.js`) build on these primitives; no
 * second transaction service may be created beside this kernel.
 *
 * Every public function is free of adapter identity, manifest, and ownership
 * concepts. The mutating entry point (`executeMutationBatch`) genuinely owns
 * target-bound validation and rollback: it accepts only target-relative
 * mutation paths, resolves each through one canonical validator, and never
 * trusts an absolute caller-resolved path.
 *
 * Snapshot state is explicit: a path is either `absent`, a `file` with exact
 * bytes, or a `directory`. Directory snapshots are never passed to the atomic
 * writer. Recursive directory-removal mutations are rejected so a later batch
 * failure can never lose a directory tree; pruning callers enumerate owned
 * files and use reversible, non-recursive `rmdir-empty` actions. Primary
 * errors are returned separately from genuine rollback failures.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Canonical target-relative path validator. Accepts only forward-slash
 * relative paths without `.`/`..`/empty segments, drive letters, absolute
 * roots, backslashes, or NUL bytes. Throws a descriptive Error on violation;
 * returns the path unchanged on success.
 *
 * This is the single validator reused by `resolveTargetPath`, lifecycle plan
 * validation, and every caller that needs target-relative path safety.
 *
 * @param {string} value
 * @returns {string}
 */
export function assertSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('planned path must be a non-empty string');
  }
  if (value.includes('\\')) {
    throw new Error(`unsafe planned path (backslash): ${value}`);
  }
  if (value.includes('\0')) {
    throw new Error(`unsafe planned path (NUL byte): ${value}`);
  }
  if (value.startsWith('/')) {
    throw new Error(`unsafe planned path (absolute): ${value}`);
  }
  if (/^[a-zA-Z]:/.test(value)) {
    throw new Error(`unsafe planned path (drive-qualified): ${value}`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe planned path (dot/empty/traversal segment): ${value}`);
  }
  return value;
}

/** True when `relPath` equals or sits under the `/`-delimited `root`. */
export function isUnderRoot(relPath, root) {
  return relPath === root || relPath.startsWith(`${root}/`);
}

/**
 * Resolve a validated target-relative path to an absolute path inside
 * targetRoot through one canonical validator. Rejects lexical escapes
 * (absolute, drive-qualified, backslash, NUL, dot/empty/traversal segments)
 * and verifies both lexical and real-path containment so a symlinked or
 * junctioned ancestor cannot carry a mutation outside the target.
 *
 * @param {string} targetRoot
 * @param {string} relPath
 * @returns {string} absolute path inside targetRoot
 */
export function resolveTargetPath(targetRoot, relPath) {
  const safe = assertSafeRelativePath(relPath);
  const root = resolve(targetRoot);
  const candidate = resolve(root, safe);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`planned path escapes target: ${relPath}`);
  }
  // Walk each existing ancestor segment to detect symlink/junction escape.
  const segments = relative(root, candidate).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (!stats) break;
    if (stats.isSymbolicLink()) {
      throw new Error(`planned path crosses a symlink or junction: ${relPath}`);
    }
  }
  return candidate;
}

/**
 * Stable state fingerprint for one validated target-relative path:
 * `null` when absent, `directory` for a directory, and the SHA-256 digest for
 * a regular file. Other filesystem object types are rejected.
 *
 * @param {string} targetRoot
 * @param {string} relPath
 * @returns {string|null}
 */
export function fingerprintTargetPath(targetRoot, relPath) {
  const path = resolveTargetPath(targetRoot, relPath);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    throw new Error(`planned path crosses a symlink or junction: ${relPath}`);
  }
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  throw new Error(`unsupported filesystem object at planned path: ${relPath}`);
}

/**
 * Atomically write `content` to `path` (parent directories are created;
 * a temp file in the same directory is renamed into place). Low-level
 * primitive operating on an already-validated absolute path.
 *
 * @param {string} path  Absolute destination path.
 * @param {string|Buffer} content
 */
export function atomicWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

/**
 * Capture pre-transaction state for one absolute path. The snapshot is an
 * explicit discriminated record so rollback never has to guess:
 *   { state: 'absent',     path }
 *   { state: 'file',       path, bytes: Buffer }
 *   { state: 'directory',  path }
 *
 * Directory snapshots carry no bytes and are never handed to the atomic
 * writer; a pre-existing directory is left in place on rollback.
 *
 * @param {string} path  Absolute path.
 * @returns {{path: string, state: 'absent'|'file'|'directory', bytes: Buffer|null}}
 */
export function snapshotPath(path) {
  if (!existsSync(path)) return { path, state: 'absent', bytes: null };
  const stats = statSync(path);
  if (stats.isDirectory()) return { path, state: 'directory', bytes: null };
  return { path, state: 'file', bytes: readFileSync(path) };
}

/** Capture pre-transaction state for every absolute path. */
export function snapshotPaths(paths) {
  return [...paths].map(path => snapshotPath(path));
}

/** Remove a directory only when it exists, is a directory, and is empty. */
export function removeEmptyDirectory(path) {
  if (!existsSync(path) || !statSync(path).isDirectory() || readdirSync(path).length !== 0) return false;
  rmSync(path, { recursive: true });
  return true;
}

/**
 * Restore snapshots in reverse order. Never throws and never passes a
 * directory snapshot to the atomic writer. Returns per-path error messages
 * (`"<path>: <message>"`), empty when the restore was clean.
 *
 * @param {Array<{path: string, state: string, bytes: Buffer|null}>} snapshots
 * @returns {string[]} rollback error descriptions
 */
export function rollbackSnapshots(snapshots) {
  const errors = [];
  for (const item of [...snapshots].reverse()) {
    try {
      if (item.state === 'file') {
        atomicWriteFile(item.path, item.bytes);
      } else if (item.state === 'absent') {
        if (!existsSync(item.path)) continue;
        // A transaction-created directory is removed by the created-directory
        // cleanup after its contents are restored; removing it here with a
        // file-only rm would produce a spurious EISDIR rollback error.
        if (statSync(item.path).isDirectory()) continue;
        rmSync(item.path, { force: true });
      }
      // state === 'directory': pre-existing directory is left in place; never
      // remove it during rollback (it predates the transaction).
    } catch (error) {
      errors.push(`${item.path}: ${error.message}`);
    }
  }
  return errors;
}

/** Remove empty ancestor directories of `paths`, up to (not including) `target`. */
export function removeEmptyParents(target, paths) {
  const root = resolve(target);
  for (const path of paths) {
    let current = dirname(resolve(path));
    while (current !== root && current.startsWith(root + sep) && removeEmptyDirectory(current)) {
      current = dirname(current);
    }
  }
}

/**
 * Directories under `targetRoot` that a batch would create (deepest first),
 * so rollback can remove only directories the transaction itself created.
 */
export function missingAncestorDirectories(targetRoot, paths) {
  const root = resolve(targetRoot);
  const missing = new Set();
  for (const path of paths) {
    let current = dirname(resolve(path));
    while (current !== root && current.startsWith(root + sep)) {
      if (!existsSync(current)) missing.add(current);
      current = dirname(current);
    }
  }
  return [...missing].sort((left, right) => right.length - left.length);
}

/**
 * Validate the shape of one mutation and resolve its target-relative path to
 * an absolute path inside `targetRoot`. Returns `{ type, absPath, content }`.
 *
 * @private
 */
function prepareMutation(targetRoot, mutation) {
  if (!mutation || typeof mutation !== 'object') {
    throw new Error(`mutation must be an object: ${JSON.stringify(mutation)}`);
  }
  const { type, path, content } = mutation;
  if (type !== 'write' && type !== 'remove' && type !== 'mkdir' && type !== 'rmdir-empty') {
    throw new Error(`unsupported mutation type '${type}' for ${String(path)}`);
  }
  const absPath = resolveTargetPath(targetRoot, path);
  return { type, relPath: path, absPath, content };
}

/**
 * Execute one generic mutation batch with snapshot/rollback semantics.
 *
 * Mutations use **target-relative paths** resolved inside the kernel through
 * one canonical validator:
 *   { type: 'write',  path: 'relative/path', content }   atomic write
 *   { type: 'remove', path: 'relative/path' }            removal of a FILE only
 *   { type: 'mkdir',  path: 'relative/path' }            recursive directory creation
 *   { type: 'rmdir-empty', path: 'relative/path' }        reversible empty-dir removal
 *
 * Recursive directory-removal mutations are rejected: a later batch failure
 * must never lose a directory tree. Pruning callers enumerate owned files as
 * individual remove actions and may use `rmdir-empty` for directories known
 * at plan time. Those removals are non-recursive and recreated on rollback.
 *
 * @param {string} targetRoot
 * @param {Array<{type: string, path: string, content?: string|Buffer}>} mutations
 * @returns {{ ok: boolean, errors: string[], rollbackErrors: string[], writtenFiles: string[], committedPaths: string[] }}
 *   `errors` holds the primary failure; `rollbackErrors` reports genuine
 *   rollback failures separately. `writtenFiles` is empty on failure.
 *   `committedPaths` lists the target-relative paths that were committed
 *   before any failure (empty unless this batch succeeds).
 */
export function executeMutationBatch(targetRoot, mutations) {
  const root = resolve(targetRoot);

  // Phase 1: validate and resolve every mutation through the canonical
  // validator BEFORE any snapshot or write. Unsafe paths fail closed here.
  const prepared = [];
  for (const mutation of mutations ?? []) {
    try {
      prepared.push(prepareMutation(root, mutation));
    } catch (error) {
      return {
        ok: false,
        errors: [error.message],
        rollbackErrors: [],
        writtenFiles: [],
        committedPaths: [],
      };
    }
  }

  // Phase 2: reject directory-removal mutations. A remove whose target is an
  // existing directory would be unrestorable on rollback; pruning callers
  // must enumerate owned files instead.
  for (const item of prepared) {
    if (item.type !== 'remove') continue;
    if (existsSync(item.absPath) && statSync(item.absPath).isDirectory()) {
      return {
        ok: false,
        errors: [`refusing directory-removal mutation '${item.relPath}'; enumerate owned files as individual remove actions`],
        rollbackErrors: [],
        writtenFiles: [],
        committedPaths: [],
      };
    }
  }

  const mkdirs = prepared.filter(item => item.type === 'mkdir');
  const removes = prepared.filter(item => item.type === 'remove');
  const emptyDirRemoves = prepared.filter(item => item.type === 'rmdir-empty');
  const writes = prepared.filter(item => item.type === 'write');

  for (const item of emptyDirRemoves) {
    if (existsSync(item.absPath) && !statSync(item.absPath).isDirectory()) {
      return {
        ok: false,
        errors: [`refusing empty-directory removal '${item.relPath}'; path is not a directory`],
        rollbackErrors: [],
        writtenFiles: [],
        committedPaths: [],
      };
    }
  }

  const affectedPaths = [...new Set(prepared.map(item => item.absPath))];
  const snapshots = snapshotPaths(affectedPaths);
  const snapshotState = new Map(snapshots.map(item => [item.path, item.state]));
  // Directories this transaction would create: mkdir targets that were absent
  // before the batch plus every missing ancestor of an affected path. Rollback
  // removes only these (deepest first); pre-existing directories are kept.
  const createdDirs = new Set(missingAncestorDirectories(root, affectedPaths));
  for (const item of mkdirs) {
    if (snapshotState.get(item.absPath) === 'absent') createdDirs.add(item.absPath);
  }
  const createdDirsOrdered = [...createdDirs].sort((left, right) => right.length - left.length);
  const removedDirs = [];

  try {
    for (const item of mkdirs) {
      mkdirSync(item.absPath, { recursive: true });
    }
    for (const item of removes) {
      if (existsSync(item.absPath)) rmSync(item.absPath, { force: true });
    }
    for (const item of emptyDirRemoves) {
      if (!existsSync(item.absPath)) continue;
      if (!removeEmptyDirectory(item.absPath)) {
        throw new Error(`refusing to remove non-empty directory '${item.relPath}'`);
      }
      removedDirs.push(item.absPath);
    }
    for (const item of writes) {
      atomicWriteFile(item.absPath, item.content);
    }
    removeEmptyParents(root, removes.map(item => item.absPath));
    return {
      ok: true,
      errors: [],
      rollbackErrors: [],
      writtenFiles: writes.map(item => item.relPath),
      committedPaths: prepared.map(item => item.relPath),
    };
  } catch (error) {
    const rollbackErrors = rollbackSnapshots(snapshots);
    // Recreate pre-existing empty directories removed by this batch. File
    // restoration above may already have recreated some parents.
    for (const dir of [...removedDirs].sort((left, right) => left.length - right.length)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (dirError) {
        rollbackErrors.push(`directory restore ${dir}: ${dirError.message}`);
      }
    }
    // Remove only directories the transaction itself created, deepest first.
    // Pre-existing directories are never removed here.
    for (const dir of createdDirsOrdered) {
      try {
        if (existsSync(dir) && !removeEmptyDirectory(dir)) {
          rollbackErrors.push(`dir rollback ${dir}: transaction-created directory is not empty`);
        }
      } catch (dirError) {
        rollbackErrors.push(`dir rollback ${dir}: ${dirError.message}`);
      }
    }
    return {
      ok: false,
      errors: [error.message],
      rollbackErrors,
      writtenFiles: [],
      committedPaths: [],
    };
  }
}

/**
 * Atomically execute one target-relative rename segment. Both path states are
 * rechecked immediately before mutation, destination parents created by this
 * function are removed on failure, and rollback failures are reported
 * separately from the primary error.
 *
 * @param {string} targetRoot
 * @param {{from: string, to: string, fromBaseHash: string|null, toBaseHash: string|null}} descriptor
 * @param {{rename?: (from: string, to: string) => void}} [options]
 * @returns {{ok: boolean, changed: boolean, stale: boolean, rolledBack: boolean, errors: string[], rollbackErrors: string[]}}
 */
export function executeRenameMutation(targetRoot, descriptor, options = {}) {
  const root = resolve(targetRoot);
  let from;
  let to;
  try {
    from = resolveTargetPath(root, descriptor.from);
    to = resolveTargetPath(root, descriptor.to);
    const fromState = fingerprintTargetPath(root, descriptor.from);
    const toState = fingerprintTargetPath(root, descriptor.to);
    if (fromState !== descriptor.fromBaseHash || toState !== descriptor.toBaseHash) {
      return {
        ok: false,
        changed: false,
        stale: true,
        rolledBack: true,
        errors: [
          `rename state changed since the plan was computed: ${descriptor.from} -> ${descriptor.to}`,
        ],
        rollbackErrors: [],
      };
    }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      stale: false,
      rolledBack: true,
      errors: [error instanceof Error ? error.message : String(error)],
      rollbackErrors: [],
    };
  }

  const createdDirs = missingAncestorDirectories(root, [to]);
  try {
    mkdirSync(dirname(to), { recursive: true });
    (options.rename ?? renameSync)(from, to);
    return {
      ok: true,
      changed: true,
      stale: false,
      rolledBack: true,
      errors: [],
      rollbackErrors: [],
    };
  } catch (error) {
    const rollbackErrors = [];
    for (const dir of createdDirs) {
      try {
        if (existsSync(dir) && !removeEmptyDirectory(dir)) {
          rollbackErrors.push(`dir rollback ${dir}: transaction-created directory is not empty`);
        }
      } catch (dirError) {
        rollbackErrors.push(`dir rollback ${dir}: ${dirError.message}`);
      }
    }
    return {
      ok: false,
      changed: false,
      stale: false,
      rolledBack: rollbackErrors.length === 0,
      errors: [`${descriptor.from}: ${error instanceof Error ? error.message : String(error)}`],
      rollbackErrors,
    };
  }
}
