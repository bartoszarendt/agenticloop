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
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { GIT_MAX_BUFFER } from './git-runner.js';

/**
 * Resolved carrier roots, keyed by resolved target path.
 *
 * The mapping from a path to the repository that owns it does not change over
 * one process lifetime, and the resolution would otherwise be repeated once per
 * classified path.
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

/**
 * A linked worktree root always holds `.git` as a *file* pointing at its
 * administrative directory; an ordinary checkout root holds a `.git` directory,
 * and a subdirectory holds neither.
 *
 * Only a target that *is* a linked worktree root redirects, so this one `lstat`
 * answers the question for every other target without running Git at all. That
 * matters: this resolution sits under repository identity, which is asked for
 * on nearly every command, and paying two process spawns per distinct path
 * would be a real cost for a question whose answer is almost always "no".
 */
function mayBeLinkedWorktreeRoot(key) {
  try {
    return lstatSync(join(key, '.git')).isFile();
  } catch {
    return false;
  }
}

function deriveCarrierRoot(key) {
  const unevaluated = { target: key, carrierRoot: key, isLinkedWorktree: false, evaluated: false };
  if (!mayBeLinkedWorktreeRoot(key)) return Object.freeze(unevaluated);

  const toplevel = git(key, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return Object.freeze(unevaluated);
  const commonDir = git(key, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return Object.freeze(unevaluated);

  const common = resolve(commonDir);
  // A submodule working directory also holds a `.git` file, and its common
  // directory is `<super>/.git/modules/<name>` - a repository of its own, not a
  // lane of the superproject. Requiring the common directory to be a plain
  // `.git` keeps the redirect to linked worktrees of an ordinary checkout and
  // of the project-root bare coordinator layout this toolkit supports.
  if (basename(common) !== '.git') return Object.freeze({ ...unevaluated, evaluated: true });
  const carrierRoot = dirname(common);
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
