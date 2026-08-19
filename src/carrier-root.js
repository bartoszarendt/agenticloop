/**
 * The carrier root of one target.
 *
 * A Git worktree is a second checkout of one repository, not a second
 * repository. Agentic Loop uses worktrees as execution lanes, and the second
 * field cohort showed what happens when only half the toolkit knows that: the
 * lane resolved committed state relative to `--target` and operator state
 * relative to wherever the command happened to look, so a worktree saw an
 * activation grant as `missing` while it sat in the carrier root, and saw an
 * empty attempt list for a task with six live attempts outstanding.
 *
 * Both facts belong to the work unit, not to the checkout. This module answers
 * the one question that distinguishes them: given a target, which directory is
 * the repository's carrier root, and is the target a linked worktree of it?
 *
 * It deliberately does not decide what callers do with the answer. Operator
 * state - grants, trust, policy, keys - is addressed by the carrier root, so
 * one grant covers every lane. Committed workflow evidence stays addressed by
 * the target and is *also* read from the carrier root, because an attempt
 * recorded on another branch is still an attempt against the same task.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { GIT_MAX_BUFFER } from './git-runner.js';

/**
 * Resolved carrier roots, keyed by resolved target path.
 *
 * The mapping from a path to the repository that owns it does not change over
 * one process lifetime, and the resolution costs two `git rev-parse` calls that
 * would otherwise be repeated once per classified path.
 */
const resolved = new Map();

function git(target, args) {
  const result = spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

/**
 * @param {string} target
 * @returns {{ target: string, carrierRoot: string, isLinkedWorktree: boolean, evaluated: boolean }}
 */
export function resolveCarrierRoot(target) {
  const key = resolve(String(target ?? '.'));
  const cached = resolved.get(key);
  if (cached) return cached;

  const answer = deriveCarrierRoot(key);
  resolved.set(key, answer);
  return answer;
}

function deriveCarrierRoot(key) {
  const unevaluated = { target: key, carrierRoot: key, isLinkedWorktree: false, evaluated: false };
  const toplevel = git(key, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return Object.freeze(unevaluated);
  const commonDir = git(key, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return Object.freeze(unevaluated);

  const common = resolve(commonDir);
  const carrierRoot = basename(common) === '.git' ? dirname(common) : common;
  // Only a target that *is* a linked worktree root redirects. A subdirectory of
  // an ordinary checkout keeps the target it was given: rewriting it to the
  // repository root would silently relocate state a caller addressed
  // deliberately, which is a different defect from the one this closes.
  const isLinkedWorktree = resolve(toplevel) === key && carrierRoot !== key;
  return Object.freeze({
    target: key,
    carrierRoot: isLinkedWorktree ? carrierRoot : key,
    isLinkedWorktree,
    evaluated: true,
  });
}

/**
 * The directory that owns one target's repository-level operator state.
 *
 * Activation grants, the host trust store, the operator confirmation key, and
 * effective policy are all properties of the repository. Resolving them here
 * means one grant, one trust store, and one policy are visible from the carrier
 * root and from every lane cut out of it.
 */
export function carrierRootOf(target) {
  return resolveCarrierRoot(target).carrierRoot;
}

/** Is this target a linked worktree rather than the repository's carrier root? */
export function isLinkedWorktreeTarget(target) {
  return resolveCarrierRoot(target).isLinkedWorktree;
}

/**
 * Every checkout root whose committed workflow evidence describes this target's
 * task, carrier root first.
 *
 * A lane's branch is usually cut before the records an earlier attempt
 * committed, so the lane's own checkout genuinely does not contain them. Reading
 * both roots is what makes "this task has a live attempt" a property of the task
 * rather than of whichever checkout asked.
 */
export function workflowEvidenceRoots(target) {
  const context = resolveCarrierRoot(target);
  return context.isLinkedWorktree
    ? Object.freeze([context.carrierRoot, context.target])
    : Object.freeze([context.target]);
}

/**
 * Enumerate one workflow-evidence directory across every checkout that can hold
 * it, as `{ name, path }` pairs sorted by filename.
 *
 * Records are addressed by an identity-derived filename, so the same record
 * committed in two checkouts appears once: the carrier root's copy wins. The
 * result is ordered exactly as a single-directory listing would be, so callers
 * that depended on that order keep it.
 *
 * @param {string} target
 * @param {string[]} segments  Directory path segments below each checkout root.
 * @param {(name: string) => boolean} [accept]
 */
export function listWorkflowEvidenceFiles(target, segments, accept = name => name.endsWith('.json')) {
  const byName = new Map();
  for (const root of workflowEvidenceRoots(target)) {
    const directory = join(root, ...segments);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (!accept(name) || byName.has(name)) continue;
      byName.set(name, join(directory, name));
    }
  }
  return [...byName.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, path]) => ({ name, path }));
}
