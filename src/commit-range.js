/**
 * One canonical derivation of a durable commit range.
 *
 * Every caller that needs commits, changed paths, or attribution between a
 * dispatched base and a returned head consumes this module. Reconstruction
 * proves contiguous ancestry first: `base..head` silently produces an empty or
 * partial range after a reset, rebase, or unrelated-history replacement, so an
 * ancestry proof is a precondition rather than an optional extra check.
 */

import { evaluateCommitAttribution } from './commit-attribution.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';

/**
 * A typed commit-range failure. `evidenceState` is classified at the origin of
 * the failure and is never re-derived from this error's prose.
 */
export class CommitRangeError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, evidenceState: string, disposition: string }} classification
   */
  constructor(message, { code, evidenceState, disposition }) {
    super(message);
    this.name = 'CommitRangeError';
    this.code = code;
    this.evidenceState = evidenceState;
    this.disposition = disposition;
  }
}

function malformed(message) {
  return { ok: false, code: 'role_return.invalid', evidenceState: 'malformed', disposition: 'rejected', message };
}

function stale(message) {
  return { ok: false, code: 'role_return.stale', evidenceState: 'stale', disposition: 'superseded', message };
}

function changed(message) {
  return { ok: false, code: 'role_return.stale', evidenceState: 'changed', disposition: 'superseded', message };
}

function text(result) {
  return String(result?.stdout ?? '').trim();
}

function lines(result) {
  return text(result).split(/\r?\n/).filter(Boolean);
}

/**
 * Derive the exact commit identities, changed paths, and canonical attribution
 * between two full Git identities.
 *
 * @param {{
 *   runGit: (args: string[]) => { status: number, stdout?: string, stderr?: string },
 *   baseHead: string,
 *   head: string,
 *   taskId?: string|null,
 *   roleId?: string|null,
 *   requireAttribution?: boolean,
 * }} input
 * @returns {{ ok: true, range: { base: string, head: string }, commits: string[], changedPaths: string[] }
 *   | { ok: false, code: string, evidenceState: string, disposition: string, message: string }}
 */
export function deriveCommitRange(input = {}) {
  const { runGit, baseHead, head, taskId = null, roleId = null, requireAttribution = true } = input;
  if (typeof runGit !== 'function') {
    throw new TypeError('deriveCommitRange requires a runGit function');
  }
  if (!isGitObjectId(baseHead) || !isGitObjectId(head)) {
    return malformed('commit range requires full lowercase 40- or 64-character Git identities for both endpoints');
  }
  // One repository has exactly one object format: a mixed-length range cannot
  // describe contiguous durable history and is rejected rather than resolved.
  if (!sameGitObjectFormat([baseHead, head])) {
    return malformed('commit range endpoints must share one Git object format');
  }

  // Missing objects are a repository-state fact, not a schema fault: a rewritten
  // or garbage-collected base is stale evidence about a range that once existed.
  for (const [label, identity] of [['base', baseHead], ['head', head]]) {
    const present = runGit(['cat-file', '-e', `${identity}^{commit}`]);
    if (!present || present.status !== 0) {
      return stale(`commit range ${label} ${identity} is not a reachable commit object in this repository`);
    }
  }

  // Contiguity proof. Without it a reset, rebase, force-rewrite, or unrelated
  // history yields a range that does not describe the work being returned.
  const ancestor = runGit(['merge-base', '--is-ancestor', baseHead, head]);
  if (!ancestor || ancestor.status !== 0) {
    return changed(
      `commit range base ${baseHead} is not an ancestor of head ${head}; the branch was reset, rebased, ` +
      'force-rewritten, or replaced with unrelated history'
    );
  }

  const listed = runGit(['rev-list', '--reverse', `${baseHead}..${head}`]);
  if (!listed || listed.status !== 0) {
    return stale(`unable to list the durable commit range ${baseHead}..${head}`);
  }
  const commits = lines(listed);
  if (commits.some(commit => !isGitObjectId(commit))) {
    return malformed('durable commit range contains an abbreviated or non-full commit identity');
  }
  if (!sameGitObjectFormat([baseHead, head, ...commits])) {
    return malformed('durable commit range mixes Git object formats');
  }

  if (requireAttribution) {
    for (const commit of commits) {
      const shown = runGit(['show', '-s', '--format=%B', commit]);
      if (!shown || shown.status !== 0) {
        return stale(`unable to read durable commit message ${commit}`);
      }
      const attribution = evaluateCommitAttribution({ message: String(shown.stdout ?? ''), taskId, role: roleId });
      if (!attribution.ok) {
        return malformed(`commit ${commit} has invalid canonical Task:/Agent: trailers: ${attribution.errors.join('; ')}`);
      }
    }
  }

  const diff = runGit(['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${baseHead}..${head}`]);
  if (!diff || diff.status !== 0) {
    return stale(`unable to derive changed paths for ${baseHead}..${head}`);
  }

  return {
    ok: true,
    range: { base: baseHead, head },
    commits,
    changedPaths: lines(diff).sort(),
  };
}

/**
 * Throwing wrapper for callers that treat an underivable range as a hard stop.
 * The thrown error carries the same origin classification as the typed result.
 */
export function requireCommitRange(input = {}) {
  const derived = deriveCommitRange(input);
  if (derived.ok) return derived;
  throw new CommitRangeError(derived.message, {
    code: derived.code,
    evidenceState: derived.evidenceState,
    disposition: derived.disposition,
  });
}
