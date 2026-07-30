/** Verify one repository-relative file as exact, committed, attributed evidence. */

import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { evaluateCommitAttribution } from './commit-attribution.js';
import { GIT_OBJECT_ID_RE } from './git-oid.js';

function git(target, args, encoding = 'utf8') {
  return spawnSync('git', args, { cwd: target, encoding });
}

/** Require the canonical forward-slash repository-relative wire form. */
export function validateCommittedSourcePath(value) {
  const path = typeof value === 'string' ? value : '';
  if (!path || isAbsolute(path) || path.includes('\\') || path.startsWith('/') || path.endsWith('/')) {
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
 * Bind working-tree bytes to HEAD, the exact blob, and the last source commit.
 * The source commit must carry canonical Task:/Agent: Maintainer attribution.
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

  let bytes;
  try {
    bytes = readFileSync(resolve(target, ...checkedPath.path.split('/')));
  } catch (error) {
    return { ok: false, evidenceState: 'missing', error: `committed source '${checkedPath.path}' is unavailable: ${error.message}` };
  }

  const headBytes = git(target, ['show', `HEAD:${checkedPath.path}`], null);
  if (headBytes.status !== 0) {
    return { ok: false, evidenceState: 'missing', error: `committed source '${checkedPath.path}' is absent from HEAD` };
  }
  if (!Buffer.from(headBytes.stdout ?? []).equals(bytes)) {
    return { ok: false, evidenceState: 'changed', error: `committed source '${checkedPath.path}' is not byte-identical to HEAD` };
  }

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
