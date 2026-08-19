/**
 * Where the product work of one task actually lives.
 *
 * Two rules that are individually reasonable became jointly unsatisfiable in
 * the field. `task evidence --class implementation_artifact_evidence` required
 * `--product-head` to be exactly the current repository HEAD, and an
 * implementation-ready role return required a non-empty `productChangedPaths`
 * derived from Git. The protocol itself puts workflow commits between the two:
 * an expired attempt can only be exited by `task abandon-attempt`, whose
 * receipt must be committed to pass the clean gate, and role start commits the
 * carrier mutation. HEAD is then past the product commits, the implementation
 * artifact is rebound to a workflow commit, and the derived product range
 * contains nothing but `.agenticloop/` paths. Every recovery step widened the
 * gap; there was no exit.
 *
 * This module supplies the two derivations that close it:
 *
 * - **The product head is derived, not pinned to HEAD.** It is the newest
 *   commit in a range that carries a non-workflow path. Workflow commits made
 *   after it - abandon receipts, refreshes, role starts - do not move it.
 * - **The product base is carried across an abandoned attempt.** When the
 *   attempts on record show that this task's product work was committed under a
 *   previous attempt that was then explicitly abandoned, the return binds that
 *   earlier attempt's base as its own, and names the attempts it carries. The
 *   lineage is an explicit, re-derivable claim rather than a silent widening:
 *   the verifier rebuilds it from the same durable records and refuses a return
 *   whose claim does not match.
 *
 * Nothing here trusts an authored field. Attempts come from dispatch
 * consumption records and abandonment records; ancestry comes from Git.
 */

import {
  groupExecutionAttempts,
  listExecutionAttemptAbandonments,
} from './execution-attempt.js';
import { listDispatchConsumptions } from './handoff-consumption.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import { hasCurrentLayout, loadBundledLayoutManifest } from './layout.js';

/**
 * The target-owned workflow state root. It is one of several roots Agentic Loop
 * writes into, and it is named separately from the rest because the exact-record
 * rules that classify a return's changed paths apply only inside it.
 */
export const WORKFLOW_PATH_ROOT = '.agenticloop';

/**
 * How one repository-relative path relates to Agentic Loop.
 *
 * - `product` - the target project's own work. Only this counts as product
 *   lineage.
 * - `target_state` - target-owned workflow state under `.agenticloop/`, where a
 *   changed path must match an exact validated record to be trusted.
 * - `toolkit_generated` - output Agentic Loop writes into the target: installed
 *   toolkit source, generated host shims, provisioned shared files, and the
 *   canonical asset locations of older layouts.
 */
export const REPOSITORY_PATH_KINDS = Object.freeze(['product', 'target_state', 'toolkit_generated']);

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function underRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The declared path ownership, read from the manifest that generates it.
 *
 * `manifest.json` is the one place that says which files Agentic Loop writes
 * into a target: `toolkitOwned.sourceRoot` for the installed toolkit,
 * `generatedShims` for host adapter output, `provisionedSharedPaths` for files
 * the toolkit provisions but does not exclusively own, and `legacyRootPaths` /
 * `v2ToolkitOwnedPaths` for the canonical asset locations of older layouts. It
 * is loaded from the bundled copy rather than from the target, because the
 * question being answered is which paths *this* toolkit writes.
 *
 * `.gitattributes` is a deliberate entry in `provisionedSharedPaths` rather
 * than an implicit one. The toolkit provisions it to keep committed identity
 * portable across checkouts, and the field cohort showed that treating that
 * provisioning as product work is enough on its own to make artifact binding
 * unsatisfiable. It is a shared file: a target may also author entries in it,
 * and the cost of this decision is that a commit changing only `.gitattributes`
 * can never be an implementation artifact. That is the right trade - a
 * line-ending declaration is not a task's implementation - and it is recorded
 * here rather than inferred, because the alternative reading is defensible.
 */
function declaredOwnership() {
  if (ownership) return ownership;
  const manifest = loadBundledLayoutManifest();
  const list = value => (Array.isArray(value) ? value.map(normalizePath).filter(Boolean) : []);
  ownership = Object.freeze({
    stateRoot: normalizePath(manifest?.targetOwned?.stateRoot) || WORKFLOW_PATH_ROOT,
    toolkitRoots: Object.freeze([
      normalizePath(manifest?.toolkitOwned?.sourceRoot),
      ...list(manifest?.toolkitOwned?.sourcePaths),
      ...list(manifest?.generatedShims),
      ...list(manifest?.v2ToolkitOwnedPaths),
    ].filter(Boolean)),
    provisionedSharedPaths: Object.freeze(list(manifest?.provisionedSharedPaths)),
    legacyRoots: Object.freeze(list(manifest?.legacyRootPaths)),
  });
  return ownership;
}

let ownership = null;

/**
 * Classify one repository-relative path.
 *
 * `legacyLayout` widens the toolkit region to the canonical asset locations of
 * layouts before `agenticloop/`. It is off by default and never guessed: a
 * current-layout target may legitimately own a product directory named
 * `agents/` or `commands/`, and misclassifying those would drop real product
 * work from lineage - a worse defect than the one this replaces.
 */
export function classifyRepositoryPath(path, { legacyLayout = false } = {}) {
  const value = normalizePath(path);
  if (!value) return 'product';
  const declared = declaredOwnership();
  if (underRoot(value, declared.stateRoot)) return 'target_state';
  if (declared.toolkitRoots.some(root => underRoot(value, root))) return 'toolkit_generated';
  if (declared.provisionedSharedPaths.includes(value)) return 'toolkit_generated';
  if (legacyLayout && declared.legacyRoots.some(root => underRoot(value, root))) return 'toolkit_generated';
  return 'product';
}

/**
 * One classifier bound to one target, so the layout question is asked once per
 * operation rather than once per path.
 */
export function createPathClassifier(target = null) {
  const legacyLayout = typeof target === 'string' && target ? !hasCurrentLayout(target) : false;
  const classify = path => classifyRepositoryPath(path, { legacyLayout });
  return Object.freeze({
    legacyLayout,
    classify,
    isWorkflowPath: path => classify(path) !== 'product',
  });
}

/**
 * Is this path Agentic Loop's own output rather than product work?
 *
 * Derived from the manifest declaration, so a path the toolkit writes can never
 * be counted as the product's work by a rule the generator does not share.
 * Pass a classifier when the target's layout matters.
 */
export function isWorkflowPath(path, classifier = null) {
  return classifier ? classifier.isWorkflowPath(path) : classifyRepositoryPath(path) !== 'product';
}

function text(result) {
  return String(result?.stdout ?? '').trim();
}

function lines(result) {
  return text(result).split(/\r?\n/).filter(Boolean);
}

function isAncestor(runGit, ancestor, descendant) {
  if (ancestor === descendant) return true;
  return runGit(['merge-base', '--is-ancestor', ancestor, descendant])?.status === 0;
}

/**
 * Derive the product head of a range: the newest commit that carries a
 * non-workflow path.
 *
 * Returns `baseHead` when the range contains no product commit at all, which is
 * the truthful answer - a range of pure workflow commits produced no product
 * work - and lets the return refusal stay the one it already was.
 *
 * @param {{ runGit: (args: string[]) => { status: number, stdout?: string },
 *           baseHead: string, head: string }} input
 * @returns {{ ok: boolean, productHead: string|null, reason: string|null }}
 */
export function deriveProductHead({ runGit, baseHead, head, classifier = null } = {}) {
  if (typeof runGit !== 'function') throw new TypeError('deriveProductHead requires a runGit function');
  if (!isGitObjectId(baseHead) || !isGitObjectId(head) || !sameGitObjectFormat([baseHead, head])) {
    return { ok: false, productHead: null, reason: 'product head derivation requires two full Git identities of one object format' };
  }
  if (baseHead === head) return { ok: true, productHead: baseHead, reason: null };
  if (!isAncestor(runGit, baseHead, head)) {
    return { ok: false, productHead: null, reason: `${baseHead} is not an ancestor of ${head}` };
  }
  const listed = runGit(['rev-list', `${baseHead}..${head}`]);
  if (!listed || listed.status !== 0) {
    return { ok: false, productHead: null, reason: `unable to list the commit range ${baseHead}..${head}` };
  }
  // `rev-list` is newest-first, so the first commit carrying a product path is
  // the product head: everything after it is workflow-only by construction.
  for (const commit of lines(listed)) {
    const changed = commitChangedPaths(runGit, commit);
    if (!changed.ok) return { ok: false, productHead: null, reason: changed.reason };
    if (changed.paths.some(path => !isWorkflowPath(path, classifier))) {
      return { ok: true, productHead: commit, reason: null };
    }
  }
  return { ok: true, productHead: baseHead, reason: null };
}

/**
 * The paths one commit introduced relative to its first parent.
 *
 * A root commit has no parent, so its own tree is the change.
 */
export function commitChangedPaths(runGit, commit) {
  const parents = runGit(['rev-list', '--parents', '-n', '1', commit]);
  if (!parents || parents.status !== 0) {
    return { ok: false, paths: [], reason: `unable to read commit ${commit}` };
  }
  const hasParent = text(parents).split(/\s+/).filter(Boolean).length > 1;
  const diff = hasParent
    ? runGit(['diff', '--name-only', '--no-renames', `${commit}^`, commit])
    : runGit(['show', '--pretty=', '--name-only', '--no-renames', commit]);
  if (!diff || diff.status !== 0) {
    return { ok: false, paths: [], reason: `unable to derive changed paths for commit ${commit}` };
  }
  return { ok: true, paths: [...new Set(lines(diff))].sort(), reason: null };
}

/**
 * Does this commit introduce product work at all?
 *
 * The check that makes an `implementation_artifact` field mean what it says.
 * The field record shows the alternative: `implementation_artifact` pinned to a
 * role-start workflow commit, with the implementation two commits earlier and
 * every later audit trusting the wrong object.
 */
export function commitCarriesProductPaths(runGit, commit, classifier = null) {
  const changed = commitChangedPaths(runGit, commit);
  if (!changed.ok) return { ok: false, carries: false, reason: changed.reason };
  return { ok: true, carries: changed.paths.some(path => !isWorkflowPath(path, classifier)), reason: null };
}

/**
 * Resolve the product lineage this attempt carries from previous attempts.
 *
 * Returns `{ ok: true, lineage: null }` for the ordinary case - a first attempt,
 * or one that follows no abandoned attempt - so the ordinary route keeps binding
 * exactly the packet's own base.
 *
 * @param {string} target
 * @param {string} taskId
 * @param {{ backend?: string, packetBaseHead: string,
 *           runGit: (args: string[]) => { status: number, stdout?: string } }} options
 * @returns {{ ok: boolean, lineage: object|null, errors: string[] }}
 */
export function resolveCarriedProductLineage(target, taskId, {
  backend = 'files', packetBaseHead, runGit,
} = {}) {
  if (typeof runGit !== 'function') throw new TypeError('resolveCarriedProductLineage requires a runGit function');
  if (!isGitObjectId(packetBaseHead)) {
    return { ok: false, lineage: null, errors: ['carried product lineage requires a full packet base identity'] };
  }
  const consumed = listDispatchConsumptions(target, taskId, { backend });
  if (!consumed.ok) return { ok: false, lineage: null, errors: consumed.errors };
  const abandoned = listExecutionAttemptAbandonments(target, taskId);
  if (!abandoned.ok) return { ok: false, lineage: null, errors: abandoned.errors };

  const attempts = groupExecutionAttempts({
    consumptions: consumed.records,
    abandonments: abandoned.records,
  });
  // The current attempt is the newest one that started from this packet's base.
  // Identifying it by base rather than by liveness keeps the derivation stable
  // whether it is asked before or after this attempt's own records land.
  let index = -1;
  for (let position = attempts.length - 1; position >= 0; position--) {
    if (attempts[position].productBaseHead === packetBaseHead) { index = position; break; }
  }
  if (index <= 0) return { ok: true, lineage: null, errors: [] };

  // Only an unbroken run of *explicitly abandoned* attempts is carried. A live
  // attempt in between means some other attempt still owns that work, and a gap
  // means the record does not explain what happened; both keep the ordinary
  // packet base rather than reaching further back on a guess.
  const carried = [];
  for (let position = index - 1; position >= 0; position--) {
    if (attempts[position].state !== 'abandoned') break;
    carried.unshift(attempts[position]);
  }
  if (carried.length === 0) return { ok: true, lineage: null, errors: [] };

  const carriedBaseHead = carried[0].productBaseHead;
  if (carriedBaseHead === packetBaseHead) return { ok: true, lineage: null, errors: [] };
  if (!isGitObjectId(carriedBaseHead) || !sameGitObjectFormat([carriedBaseHead, packetBaseHead])) {
    return { ok: false, lineage: null, errors: ['carried attempt base is not a full Git identity of the packet base object format'] };
  }
  if (!isAncestor(runGit, carriedBaseHead, packetBaseHead)) {
    // A carried base that is not behind the current base does not describe
    // history this attempt was minted on top of; the claim is dropped rather
    // than repaired, and the ordinary base still applies.
    return { ok: true, lineage: null, errors: [] };
  }
  return {
    ok: true,
    errors: [],
    lineage: {
      carriedBaseHead,
      attempts: carried.map(attempt => ({
        attemptId: attempt.attemptId,
        packetId: attempt.packetId,
        productBaseHead: attempt.productBaseHead,
      })),
    },
  };
}
