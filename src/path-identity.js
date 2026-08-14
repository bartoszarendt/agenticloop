/**
 * Canonical path identities for portable, signed, and cross-host data.
 *
 * Relative inputs are resolved against `base` (the caller's explicit base, or
 * the process working directory). `displayPath` preserves the host's resolved
 * spelling for diagnostics and filesystem calls. `authorityPath` is the wire
 * identity: an existing path is realpathed, separators are `/`, and Windows
 * paths are case-folded (including the drive) while POSIX paths remain
 * case-sensitive. Tests may inject `platform`, `pathApi`, `exists`, and
 * `realpath` to exercise either host rule on any machine.
 */

import { existsSync, realpathSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';

function platformPathApi(platform, injected) {
  if (injected) return injected;
  if (platform === 'win32') return win32;
  if (platform === 'posix') return posix;
  return { resolve, relative: posix.relative, isAbsolute: posix.isAbsolute };
}

function wirePath(value, platform) {
  const normalized = String(value).replace(/\\/g, '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isParentTraversal(relative) {
  const normalized = String(relative).replace(/\\/g, '/');
  return normalized === '..' || normalized.startsWith('../');
}

/** Recognize absolute or drive-qualified input independently of the host OS. */
export function isAbsoluteOrDriveQualifiedPath(value) {
  const path = String(value);
  return posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path);
}

/** Resolve one path into a human-facing display path and authority wire path. */
export function pathIdentity(path, {
  base = process.cwd(),
  platform = process.platform,
  pathApi = null,
  exists = existsSync,
  realpath = realpathSync.native ?? realpathSync,
} = {}) {
  const api = platformPathApi(platform, pathApi);
  const displayPath = api.resolve(String(base), String(path));
  const nativeAuthorityPath = exists(displayPath) ? realpath(displayPath) : displayPath;
  return Object.freeze({
    displayPath,
    authorityPath: wirePath(nativeAuthorityPath, platform),
  });
}

/** Resolve to the host-facing spelling for filesystem operations and diagnostics. */
export function displayPath(path, options = {}) {
  return pathIdentity(path, options).displayPath;
}

/** Compare only the authority identities, never host-specific display spelling. */
export function samePathAuthority(left, right, options = {}) {
  return pathIdentity(left, options).authorityPath === pathIdentity(right, options).authorityPath;
}

/** Whether a candidate is strictly inside its root under the injected host rule. */
export function isPathWithin(candidate, root, options = {}) {
  const platform = options.platform ?? process.platform;
  const api = platformPathApi(platform, options.pathApi ?? null);
  const candidateIdentity = pathIdentity(candidate, options);
  const rootIdentity = pathIdentity(root, options);
  const relative = api.relative(rootIdentity.authorityPath, candidateIdentity.authorityPath);
  return Boolean(relative) && !isParentTraversal(relative) && !api.isAbsolute(relative);
}

/**
 * Whether an operator-owned root is provably outside a target repository.
 *
 * Existing paths use realpath authority, so a junction or symlink outside the
 * target cannot point back into it. A nonexistent root has no link target to
 * inspect; its resolved lexical identity is used until it is created. Callers
 * must recheck before reading or writing a newly materialized path.
 */
export function isPathOutside(candidate, target, options = {}) {
  const platform = options.platform ?? process.platform;
  const api = platformPathApi(platform, options.pathApi ?? null);
  const candidateIdentity = pathIdentity(candidate, options);
  const targetIdentity = pathIdentity(target, options);
  const relative = api.relative(targetIdentity.authorityPath, candidateIdentity.authorityPath);
  return Boolean(relative) && (isParentTraversal(relative) || api.isAbsolute(relative));
}

/** The stable file URI-like identity used by target, dispatch, and handoff data. */
export function filePathIdentity(path, options = {}) {
  return `file:${pathIdentity(path, options).authorityPath}`;
}
