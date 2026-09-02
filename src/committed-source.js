/** Verify one repository-relative file as exact, committed, attributed evidence. */

import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { evaluateCommitAttribution, evaluateWorkUnitCommitAttribution } from './commit-attribution.js';
import { GIT_OBJECT_ID_RE } from './git-oid.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
import { isAbsoluteOrDriveQualifiedPath, samePathAuthority } from './path-identity.js';

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
 * Require `target` to be the repository root the `HEAD:<path>` forms resolve
 * against.
 *
 * `rev:path` is always root-relative, while a pathspec and the filesystem read
 * are relative to `target`. If those bases differ, one leg of this verifier can
 * describe a different file from the other: a subdirectory target with a
 * same-named file at the root would have the root file's blob, provenance, and
 * attribution accepted as evidence for the subdirectory path. Rather than
 * silently picking a basis, refuse the input.
 */
function assertTargetIsRepositoryRoot(target) {
  const toplevel = git(target, ['rev-parse', '--show-toplevel']);
  const root = String(toplevel.stdout ?? '').trim();
  if (toplevel.status !== 0 || !root) {
    throw new Error('committed source verification requires a Git repository');
  }
  if (!samePathAuthority(root, target)) {
    throw new Error(
      'committed source verification requires the repository root; ' +
      `'${resolve(target)}' is inside the repository at '${root}'`
    );
  }
}

/**
 * Ask Git whether the path carries any uncommitted difference from HEAD.
 *
 * Git applies the path's `.gitattributes` eol rules and any clean filter before
 * comparing, so an ordinary Windows CRLF checkout and a smudged working copy
 * both report "unmodified" while a genuine content change reports the path.
 * Three separate questions are asked, because each can be true alone:
 *
 * - the worktree may differ from HEAD;
 * - the index may differ from HEAD even when the worktree does not;
 * - `assume-unchanged` or `skip-worktree` may be set, which tells Git to stop
 *   looking at the worktree at all and would make both diffs report nothing.
 *
 * Every pathspec is `:(top,literal)` so it shares the root-relative basis of
 * `HEAD:<path>` and cannot be reinterpreted as a glob. An unusable Git result
 * is treated as a difference, so the caller fails closed rather than inheriting
 * an unproven worktree.
 */
function worktreeMatchesHead(target, path) {
  const pathspec = `:(top,literal)${path}`;
  for (const [args, reason] of [
    [['diff', '--name-only', 'HEAD', '--', pathspec], 'differs from HEAD'],
    [['diff', '--name-only', '--cached', 'HEAD', '--', pathspec], 'has a staged difference from HEAD'],
  ]) {
    const result = git(target, args);
    if (result.status !== 0) return { ok: false, reason: 'could not be compared with HEAD' };
    if (String(result.stdout ?? '').trim() !== '') return { ok: false, reason };
  }
  const listed = git(target, ['ls-files', '-v', '--', pathspec]);
  if (listed.status !== 0) return { ok: false, reason: 'could not be compared with HEAD' };
  const tags = String(listed.stdout ?? '').split(/\r?\n/).filter(Boolean).map(line => line[0]);
  if (tags.length !== 1 || tags[0] !== 'H') {
    return { ok: false, reason: 'is not an ordinary tracked file whose worktree copy Git checks' };
  }
  return { ok: true, reason: null };
}

/**
 * Bind the committed blob to HEAD and the last source commit after Git proves
 * the worktree path is unmodified. The returned `source` is the committed
 * content, never the host's checked-out spelling, so line-ending conversion and
 * clean/smudge filters cannot change what a verifier consumes. The source
 * commit must carry canonical Task:/Agent: Maintainer attribution.
 */
export function verifyCommittedAttributedSource(target, sourceRef, { taskId, workUnitId = null, taskIds = null } = {}) {
  const checkedPath = validateCommittedSourcePath(sourceRef);
  if (!checkedPath.ok) return { ok: false, evidenceState: 'malformed', error: checkedPath.error };
  try {
    assertTargetIsRepositoryRoot(target);
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
  const attribution = workUnitId && Array.isArray(taskIds)
    ? evaluateWorkUnitCommitAttribution({
      message: String(messageResult.stdout ?? ''), workUnitId, taskIds, role: 'maintainer',
    })
    : evaluateCommitAttribution({
      message: String(messageResult.stdout ?? ''), taskId, role: 'maintainer',
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
