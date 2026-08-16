/**
 * Initial repository state for a role dispatch.
 *
 * A dispatch packet that binds only HEAD, branch, and base tree still permits
 * pre-existing staged, unstaged, or untracked work to be committed and returned
 * as role-produced implementation. This module evaluates the exact state
 * mechanically, names the explicitly permitted exceptions, and produces one
 * canonical identity that can be bound into the packet digest and revalidated
 * immediately before receiver mutation.
 *
 * It also consumes the P35-03 task-mutation receipt contract for prior-gate and
 * setup mutations rather than defining a second receipt system.
 */

import { relative, resolve } from 'node:path';
import { canonicalSha256 } from './canonical-json.js';
import { fileMatchesScopePattern } from './scope-matcher.js';
import { validateTaskMutationReceipt } from './task-evidence-contract.js';
import { listAgenticLoopWorktrees } from './worktree.js';

export const CLEAN_STATE_KIND = 'agenticloop.dispatch-clean-state';
/** v2 adds the operator-owned activation state class. */
export const CLEAN_STATE_SCHEMA_VERSION = 3;

/**
 * Bounded scratch state a dispatch may carry. `.agenticloop/tmp/` is the
 * repository's declared scratch location, so its contents are evidence about a
 * working session rather than unowned repository work. Everything else -
 * including all other `.agenticloop/` shared workflow state - is relevant.
 *
 * Ignored files are not a blanket exception: the untracked query
 * (`ls-files --others --exclude-standard`) omits them, so a bounded ignored
 * query runs against task scope, intended creations, and shared workflow
 * state. A pre-existing ignored path in any of those classes could be
 * force-added later and presented as role-produced work, so it fails the
 * gate instead of passing invisibly. Ignored content under the permitted
 * scratch prefixes stays permitted at dispatch, and the return boundary
 * separately refuses scratch paths as implementation work.
 */
export const PERMITTED_SCRATCH_PREFIXES = Object.freeze(['.agenticloop/tmp/']);

/**
 * Operator-owned activation state a dispatch may carry untracked.
 *
 * Activation grants and task bindings are durable evidence, not scratch, but
 * they are *operator* state rather than project history: they are short-lived,
 * machine-local, and authenticated at use time against a key held outside the
 * repository. Requiring them to be committed would put expiring signed records
 * into project history and force a commit after every activation, without
 * adding any authority - a committed grant is no more trustworthy than an
 * untracked one, because the signature is what proves it.
 *
 * They are therefore permitted at the dispatch clean gate and, like scratch,
 * separately refused as implementation work at the return boundary.
 */
export const PERMITTED_OPERATOR_STATE_PREFIXES = Object.freeze([
  '.agenticloop/activations/',
  '.agenticloop/returns/verifications/',
  '.agenticloop/closeout-waivers/',
]);

/** Shared workflow state whose untracked additions are always relevant. */
export const SHARED_STATE_PREFIXES = Object.freeze(['.agenticloop/']);

/** Every prefix whose untracked or ignored content the clean gate tolerates. */
export const PERMITTED_UNTRACKED_PREFIXES = Object.freeze([
  ...PERMITTED_SCRATCH_PREFIXES,
  ...PERMITTED_OPERATOR_STATE_PREFIXES,
]);

/** Prior-gate dispositions that leave no unproven carrier mutation behind. */
export const RESOLVED_MUTATION_DISPOSITIONS = Object.freeze([
  'committed', 'already_current', 'dry_run', 'rolled_back',
]);

/** The exact state of a checkout with nothing staged, unstaged, or in scope. */
function cleanStateProjection() {
  return {
    kind: CLEAN_STATE_KIND,
    schemaVersion: CLEAN_STATE_SCHEMA_VERSION,
    stagedPaths: [],
    unstagedPaths: [],
    untrackedRelevantPaths: [],
    ignoredRelevantPaths: [],
    permittedScratchPrefixes: [...PERMITTED_SCRATCH_PREFIXES],
    permittedOperatorStatePrefixes: [...PERMITTED_OPERATOR_STATE_PREFIXES],
    ignoredFilesPermitted: true,
  };
}

/**
 * Canonical identity of a fully clean dispatch checkout. A packet may only ever
 * bind this identity: any other evaluated state fails the gate before emission.
 */
export const CLEAN_DISPATCH_STATE_IDENTITY =
  `sha256:${CLEAN_STATE_KIND}.v${CLEAN_STATE_SCHEMA_VERSION}:${canonicalSha256(cleanStateProjection())}`;

function permitted(path) {
  return PERMITTED_UNTRACKED_PREFIXES.some(prefix => path === prefix.replace(/\/$/, '') || path.startsWith(prefix));
}

function shared(path) {
  return SHARED_STATE_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * Derive repo-relative forward-slash prefixes for sibling worktree roots.
 * Returns an array of prefixes like `.agenticloop/worktrees/T-002` (no trailing slash).
 * Siblings whose resolved path equals the active checkout root are excluded.
 * Siblings whose relative prefix starts with `..` are skipped (registered elsewhere).
 */
function deriveSiblingExclusionPrefixes(runGit) {
  const toplevelResult = runGit(['rev-parse', '--show-toplevel']);
  if (!toplevelResult || toplevelResult.status !== 0) return [];
  const toplevel = toplevelResult.stdout.trim();
  if (!toplevel) return [];

  let siblings;
  try {
    siblings = listAgenticLoopWorktrees(toplevel, { skipDirtyEnumeration: true });
  } catch {
    return [];
  }

  const prefixes = [];
  for (const wt of siblings) {
    try {
      const siblingResolved = resolve(wt.path);
      const activeResolved = resolve(toplevel);
      if (siblingResolved === activeResolved) continue;
      const rel = relative(activeResolved, siblingResolved).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue;
      prefixes.push(rel);
    } catch {
      // fail open: skip this sibling
    }
  }
  return prefixes;
}

function lines(result) {
  return String(result?.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map(path => path.replace(/\\/g, '/'));
}

function finding(evidenceState, disposition, code, message) {
  return { code, evidenceState, disposition, message };
}

/**
 * Evaluate staged, unstaged, relevant untracked, and relevant ignored
 * repository state.
 *
 * The ignored query is bounded to the exact path classes that could later
 * appear in a valid role return - task scope, intended creations, and shared
 * workflow state - so unrelated ignored host-local caches are neither scanned
 * nor able to fail the gate.
 *
 * @param {{
 *   runGit: (args: string[]) => { status: number, stdout?: string, stderr?: string },
 *   scopePatterns?: string[],
 *   intendedCreations?: string[],
 *   excludedSiblingRoots?: string[],
 * }} input
 * @returns {{ ok: boolean, state: object|null, identity: string|null, findings: object[] }}
 */
export function evaluateDispatchCleanState(input = {}) {
  const { runGit, scopePatterns = [], intendedCreations = [], excludedSiblingRoots } = input;
  if (typeof runGit !== 'function') throw new TypeError('evaluateDispatchCleanState requires a runGit function');
  const patterns = Array.isArray(scopePatterns) ? scopePatterns.filter(pattern => typeof pattern === 'string' && pattern) : [];
  const creations = Array.isArray(intendedCreations) ? intendedCreations.filter(path => typeof path === 'string' && path) : [];

  /** @type {object[]} */
  const findings = [];
  const read = (args, label) => {
    const result = runGit(args);
    if (!result || result.status !== 0) {
      // An ENOBUFS after callers raise the buffer (see git-runner.js) is a real
      // operational fault - output larger than the ceiling - not a Git failure,
      // and it must still fail closed but say what actually happened rather than
      // claiming the query could not be read.
      const detail = result?.error?.code === 'ENOBUFS'
        ? `${label} exceeded the Git output buffer`
        : `${label} could not be read from Git`;
      findings.push(finding('missing', 'blocked', 'worktree.clean_gate.failed', detail));
      return null;
    }
    return lines(result);
  };

  const staged = (read(['diff', '--cached', '--name-only'], 'staged tracked changes') ?? []).filter(path => !permitted(path));
  const unstaged = (read(['diff', '--name-only'], 'unstaged tracked changes') ?? []).filter(path => !permitted(path));
  let untracked = read(['ls-files', '--others', '--exclude-standard'], 'untracked paths') ?? [];

  // Ignored files are invisible to the untracked query above. Query them only
  // inside the bounded path classes a valid role return could later claim;
  // candidates are reclassified with the canonical scope matcher so Git glob
  // differences cannot widen the failure set.
  const ignoredPathspecs = [
    ...SHARED_STATE_PREFIXES.map(prefix => prefix.replace(/\/$/, '')),
    ...patterns.map(pattern => `:(glob)${pattern}`),
    ...creations,
  ];
  let ignoredCandidates = ignoredPathspecs.length
    ? read(['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...ignoredPathspecs], 'ignored in-scope paths') ?? []
    : [];
  if (findings.length) return { ok: false, state: null, identity: null, findings };

  // Exclude registered Agentic Loop sibling worktree roots from the untracked
  // and ignored scans of the active checkout.  Self-derive lazily only when
  // there are candidate paths to filter (so clean repos and mock-runGit tests
  // pay nothing).
  let siblingPrefixes = null;
  if (excludedSiblingRoots !== undefined) {
    siblingPrefixes = excludedSiblingRoots;
  }

  function isExcludedBySibling(path) {
    if (!siblingPrefixes) {
      if (untracked.length === 0 && ignoredCandidates.length === 0) return false;
      siblingPrefixes = Array.isArray(excludedSiblingRoots)
        ? excludedSiblingRoots
        : deriveSiblingExclusionPrefixes(runGit);
    }
    return siblingPrefixes.some(prefix => path === prefix || path === `${prefix}/` || path.startsWith(`${prefix}/`));
  }

  if (untracked.length > 0) {
    untracked = untracked.filter(path => !isExcludedBySibling(path));
  }
  if (ignoredCandidates.length > 0) {
    ignoredCandidates = ignoredCandidates.filter(path => !isExcludedBySibling(path));
  }

  const relevantUntracked = untracked.filter(path => {
    if (permitted(path)) return false;
    if (shared(path)) return true;
    return patterns.some(pattern => fileMatchesScopePattern(path, pattern));
  }).sort();

  const relevantIgnored = ignoredCandidates.filter(path => {
    if (permitted(path)) return false;
    if (shared(path)) return true;
    if (creations.includes(path)) return true;
    return patterns.some(pattern => fileMatchesScopePattern(path, pattern));
  }).sort();

  const state = {
    kind: CLEAN_STATE_KIND,
    schemaVersion: CLEAN_STATE_SCHEMA_VERSION,
    stagedPaths: [...staged].sort(),
    unstagedPaths: [...unstaged].sort(),
    untrackedRelevantPaths: relevantUntracked,
    ignoredRelevantPaths: relevantIgnored,
    permittedScratchPrefixes: [...PERMITTED_SCRATCH_PREFIXES],
    permittedOperatorStatePrefixes: [...PERMITTED_OPERATOR_STATE_PREFIXES],
    ignoredFilesPermitted: true,
  };
  const identity = `sha256:${CLEAN_STATE_KIND}.v${CLEAN_STATE_SCHEMA_VERSION}:${canonicalSha256(state)}`;

  if (state.stagedPaths.length) {
    findings.push(finding('negative', 'blocked', 'worktree.clean_gate.failed',
      `dispatch requires a clean checkout: staged tracked changes are present (${state.stagedPaths.join(', ')})`));
  }
  if (state.unstagedPaths.length) {
    findings.push(finding('negative', 'blocked', 'worktree.clean_gate.failed',
      `dispatch requires a clean checkout: unstaged tracked changes are present (${state.unstagedPaths.join(', ')})`));
  }
  if (state.untrackedRelevantPaths.length) {
    findings.push(finding('negative', 'blocked', 'worktree.clean_gate.failed',
      'dispatch requires a clean checkout: untracked task-scope or shared workflow paths are present ' +
      `(${state.untrackedRelevantPaths.join(', ')})`));
  }
  if (state.ignoredRelevantPaths.length) {
    findings.push(finding('negative', 'blocked', 'worktree.clean_gate.failed',
      'dispatch requires a clean checkout: pre-existing ignored task-scope, intended-creation, or shared workflow paths are present ' +
      `(${state.ignoredRelevantPaths.join(', ')}) and could be force-added as role-produced work`));
  }

  return { ok: findings.length === 0, state, identity, findings };
}

/**
 * Evaluate prior-gate and setup mutation receipts against the current carrier.
 *
 * Receipts are the P35-03 task-mutation receipt shape. A receipt that never
 * proved its final carrier state is unresolved; a receipt whose proven digest no
 * longer matches the carrier has drifted and cannot authorize a new dispatch.
 *
 * @param {{
 *   receipts?: unknown,
 *   readCarrierDigest?: (carrier: string) => string|null,
 * }} input
 * @returns {{ ok: boolean, gates: object[], findings: object[] }}
 */
export function evaluatePriorGateReceipts(input = {}) {
  const { receipts = [], readCarrierDigest = null } = input;
  /** @type {object[]} */
  const findings = [];
  if (receipts === null || receipts === undefined) return { ok: true, gates: [], findings };
  if (!Array.isArray(receipts)) {
    findings.push(finding('malformed', 'rejected', 'evidence.malformed', 'prior-gate receipts must be supplied as an array'));
    return { ok: false, gates: [], findings };
  }

  /** @type {object[]} */
  const gates = [];
  for (const receipt of receipts) {
    const checked = validateTaskMutationReceipt(receipt);
    if (!checked.ok) {
      findings.push(finding('malformed', 'rejected', 'evidence.malformed',
        `prior-gate mutation receipt is malformed: ${checked.errors.join('; ')}`));
      continue;
    }
    const carrier = receipt.task.carrier;
    if (!RESOLVED_MUTATION_DISPOSITIONS.includes(receipt.mutationDisposition)) {
      findings.push(finding('negative', 'blocked', 'task.mutation.unresolved',
        `prior-gate mutation for '${carrier}' is unresolved (${receipt.mutationDisposition}) and must be resolved before dispatch`));
      continue;
    }
    let currentDigest = null;
    if (receipt.resultingDigest !== null) {
      if (typeof readCarrierDigest !== 'function') {
        findings.push(finding('missing', 'needs_context', 'evidence.missing',
          `prior-gate carrier '${carrier}' must be reread before its receipt can authorize dispatch`));
        continue;
      }
      try {
        currentDigest = readCarrierDigest(carrier);
      } catch (error) {
        findings.push(finding('missing', 'needs_context', 'evidence.missing',
          `prior-gate carrier '${carrier}' could not be reread: ${error.message}`));
        continue;
      }
      if (currentDigest === null || currentDigest === undefined) {
        findings.push(finding('missing', 'needs_context', 'evidence.missing',
          `prior-gate carrier '${carrier}' is no longer readable`));
        continue;
      }
      if (currentDigest !== receipt.resultingDigest) {
        findings.push(finding('changed', 'superseded', 'evidence.changed',
          `prior-gate receipt for '${carrier}' proved ${receipt.resultingDigest} but the carrier now reads ${currentDigest ?? '(absent)'}`));
        continue;
      }
    }
    gates.push({
      taskId: receipt.task.id,
      carrier,
      mutationDisposition: receipt.mutationDisposition,
      resultingDigest: receipt.resultingDigest,
    });
  }

  gates.sort((left, right) => (left.carrier < right.carrier ? -1 : left.carrier > right.carrier ? 1 : 0));
  return { ok: findings.length === 0, gates, findings };
}
