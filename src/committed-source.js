/** Verify one repository-relative file as exact, committed, attributed evidence. */

import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { evaluateCommitAttribution } from './commit-attribution.js';
import { GIT_OBJECT_ID_RE } from './git-oid.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { isAbsoluteOrDriveQualifiedPath } from './path-identity.js';

function git(target, args, encoding = 'utf8') {
  return spawnSync('git', args, { cwd: target, encoding, maxBuffer: GIT_MAX_BUFFER });
}

/** Require the canonical forward-slash repository-relative wire form. */
export function validateCommittedSourcePath(value) {
  const path = typeof value === 'string' ? value : '';
  if (!path || isAbsoluteOrDriveQualifiedPath(path) || path.includes('\\') || path.endsWith('/')) {
    return { ok: false, error: 'source path must be a non-empty canonical repository-relative path using forward slashes' };
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return { ok: false, error: 'source path must not contain empty, dot, or parent-traversal segments' };
  }
  return { ok: true, path };
}

function assertNoSymlinkSubstitution(target, sourceRef) {
  let current = resolve(target);
  for (const segment of sourceRef.split('/')) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`committed source '${sourceRef}' must not traverse a symbolic link`);
    }
  }
  const targetPrefix = `${resolve(target)}${sep}`;
  if (!current.startsWith(targetPrefix)) {
    throw new Error(`committed source '${sourceRef}' resolves outside the repository`);
  }
}

/**
 * Ask Git whether the worktree path differs from HEAD.
 *
 * Git applies the path's `.gitattributes` eol rules and any clean filter before
 * comparing, so an ordinary Windows CRLF checkout and a smudged working copy
 * both report "unmodified" while a genuine content change - staged or not -
 * reports the path. An unusable `git diff` is treated as a difference so the
 * caller fails closed rather than inheriting an unproven worktree.
 */
function worktreeMatchesHead(target, path) {
  const diff = git(target, ['diff', '--name-only', 'HEAD', '--', path]);
  if (diff.status !== 0) return { ok: false, reason: 'could not be compared with HEAD' };
  if (String(diff.stdout ?? '').trim() !== '') return { ok: false, reason: 'differs from HEAD' };
  return { ok: true, reason: null };
}

/**
 * Bind the committed blob to HEAD and the last source commit after Git proves
 * the worktree path is unmodified. The returned `source` is the committed
 * content, never the host's checked-out spelling, so line-ending conversion and
 * clean/smudge filters cannot change what a verifier consumes. The source
 * commit must carry canonical Task:/Agent: Maintainer attribution.
 */
export function verifyCommittedAttributedSource(target, sourceRef, { taskId } = {}) {
  const checkedPath = validateCommittedSourcePath(sourceRef);
  if (!checkedPath.ok) return { ok: false, evidenceState: 'malformed', error: checkedPath.error };
  try {
    assertNoSymlinkSubstitution(target, checkedPath.path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return {
        ok: false,
        evidenceState: 'missing',
        error: `committed source '${checkedPath.path}' is unavailable: ${error.message}`,
      };
    }
    return { ok: false, evidenceState: 'malformed', error: error.message };
  }

  // The worktree copy must exist: a path deleted after commit is missing
  // evidence even though HEAD still carries the blob.
  try {
    readFileSync(resolve(target, ...checkedPath.path.split('/')));
  } catch (error) {
    return { ok: false, evidenceState: 'missing', error: `committed source '${checkedPath.path}' is unavailable: ${error.message}` };
  }

  const headBytes = git(target, ['show', `HEAD:${checkedPath.path}`], null);
  if (headBytes.status !== 0) {
    return { ok: false, evidenceState: 'missing', error: `committed source '${checkedPath.path}' is absent from HEAD` };
  }
  const unmodified = worktreeMatchesHead(target, checkedPath.path);
  if (!unmodified.ok) {
    return { ok: false, evidenceState: 'changed', error: `committed source '${checkedPath.path}' ${unmodified.reason}` };
  }
  const bytes = Buffer.from(headBytes.stdout ?? []);

  const blobResult = git(target, ['rev-parse', `HEAD:${checkedPath.path}`]);
  const blob = String(blobResult.stdout ?? '').trim();
  if (blobResult.status !== 0 || !GIT_OBJECT_ID_RE.test(blob)) {
    return { ok: false, evidenceState: 'malformed', error: `committed source '${checkedPath.path}' lacks an exact Git blob identity` };
  }
  const commitResult = git(target, ['log', '-1', '--format=%H', '--', checkedPath.path]);
  const commit = String(commitResult.stdout ?? '').trim();
  if (commitResult.status !== 0 || !GIT_OBJECT_ID_RE.test(commit)) {
    return { ok: false, evidenceState: 'missing', error: `committed source '${checkedPath.path}' lacks a durable source commit` };
  }
  const messageResult = git(target, ['show', '-s', '--format=%B', commit]);
  const attribution = evaluateCommitAttribution({
    message: String(messageResult.stdout ?? ''),
    taskId,
    role: 'maintainer',
  });
  if (messageResult.status !== 0 || !attribution.ok) {
    return {
      ok: false,
      evidenceState: 'malformed',
      error: `committed source '${checkedPath.path}' lacks canonical Maintainer attribution: ${attribution.errors.join('; ')}`,
    };
  }
  return {
    ok: true,
    source: bytes.toString('utf8'),
    provenance: Object.freeze({
      path: checkedPath.path,
      blob,
      commit,
      role: 'maintainer',
    }),
  };
}
