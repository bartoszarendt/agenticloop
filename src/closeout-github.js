/**
 * GitHub closeout projection: one command-local task inventory and bounded,
 * digest-idempotent marker publication.
 *
 * Publication is bounded to one resolved carrier (a task issue or tracking
 * issue). Live state is revalidated immediately before the single mutation
 * call. GitHub cannot offer a cross-resource atomic transaction, so an
 * ambiguous post result is recovered by locating the exact packet digest: a
 * retry that finds the intended marker already current returns idempotent
 * success and never posts a duplicate. The residual remote
 * time-of-check/time-of-use window is documented in the command output.
 */

import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { buildGitHubTaskIdentityInventory } from './github-task-identity.js';
import { canonicalSha256 } from './canonical-json.js';
import { parseCloseoutMarkers, resolveCurrentCloseoutMarkers, stripCloseoutMarkers } from './closeout-contract.js';

const INVENTORY_PAGE_LIMIT = 1000;

/**
 * Resolve the read-only GitHub command runner for one command: the injected
 * test runner when present, otherwise the real `gh` subprocess runner. No
 * production GitHub path may require test-only dependency injection.
 *
 * @param {object} [io]
 * @returns {Function}
 */
export function resolveGhRunner(io) {
  return io?.ghCommandRunner ?? defaultGhCommandRunner;
}

/**
 * Fetch one complete open+closed issue inventory snapshot for a command.
 * `gh issue list` paginates internally for the requested limit, so repositories
 * above the former 200-item boundary are complete. A true limit/error remains
 * `inventory_incomplete`, never a partial false pass.
 *
 * @param {Function} ghRunner  (command, args, options) => spawn-like result.
 * @param {{ repo?: string, taskIdRegex?: string|RegExp }} [options]
 * @returns {{ complete: boolean, state: string, carriers: Map, errors: string[], duplicates: object[], contradictions: object[], issues: object[] }}
 */
export function fetchGitHubTaskInventory(ghRunner, options = {}) {
  const args = [
    'issue', 'list',
    '--state', 'all',
     '--limit', String(INVENTORY_PAGE_LIMIT + 1),
    '--json', 'number,state,title,labels,body',
  ];
  if (options.repo) args.push('--repo', options.repo);
  let issues;
  try {
    issues = runGhJson(ghRunner, args) ?? [];
  } catch (error) {
    return {
      complete: false,
      state: 'inventory_incomplete',
      carriers: new Map(),
      duplicates: [],
      contradictions: [],
      errors: [`GitHub task inventory could not be fetched: ${error.message}`],
      issues: [],
    };
  }
  // Requesting limit+1 proves truncation: one extra row means the bounded
  // page did not cover the repository.
  const truncated = issues.length > INVENTORY_PAGE_LIMIT;
  const inventory = buildGitHubTaskIdentityInventory(
    truncated ? issues.slice(0, INVENTORY_PAGE_LIMIT) : issues,
     { complete: !truncated, taskIdRegex: options.taskIdRegex }
  );
  if (truncated) {
    inventory.errors.push(
      `GitHub task inventory exceeds the ${INVENTORY_PAGE_LIMIT}-issue bound; result is inventory_incomplete`
    );
  }
  return { ...inventory, issues: truncated ? issues.slice(0, INVENTORY_PAGE_LIMIT) : issues };
}

/**
 * Resolve the one closeout marker carrier: a tracking issue when named,
 * otherwise the last covered task issue in canonical id order.
 *
 * @param {object} inventory
 * @param {string[]} coveredTasks
 * @returns {{ kind: string, reference: string, issue: object }|{ kind: string, error: string }}
 */
export function resolveGitHubCloseoutCarrier(inventory, coveredTasks) {
  const ordered = [...(coveredTasks ?? [])].sort();
  if (ordered.length === 0) {
    return { kind: 'error', error: 'no covered tasks are available to resolve a marker carrier' };
  }
  const taskId = ordered[ordered.length - 1];
  const list = inventory?.carriers?.get(taskId) ?? [];
  if (list.length === 0) {
    return { kind: 'error', error: `marker carrier task '${taskId}' does not exist` };
  }
  if (list.length > 1) {
    return { kind: 'error', error: `marker carrier task '${taskId}' is ambiguous across issues ${list.map(item => `#${item.number}`).join(', ')}` };
  }
  return {
    kind: 'github_issue',
    reference: `issue:${list[0].number}`,
    issue: list[0],
  };
}

/**
 * Fetch the marker-relevant comments on one carrier issue.
 *
 * @param {Function} ghRunner
 * @param {number} issueNumber
 * @param {{ repo?: string }} [options]
 * @returns {{ ok: boolean, comments?: object[], error?: string }}
 */
export function fetchCarrierComments(ghRunner, issueNumber, options = {}) {
  const args = ['issue', 'view', String(issueNumber), '--json', 'comments,updatedAt'];
  if (options.repo) args.push('--repo', options.repo);
  try {
    const data = runGhJson(ghRunner, args);
    return {
      ok: true,
      comments: Array.isArray(data?.comments) ? data.comments : [],
      updatedAt: data?.updatedAt ?? '',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Resolve the authenticated account allowed to publish loop markers. */
export function fetchGitHubTrustedAccount(ghRunner, options = {}) {
  const args = ['api', 'user'];
  try {
    const data = runGhJson(ghRunner, args);
    const login = String(data?.login ?? '').trim();
    return login ? { ok: true, login } : { ok: false, error: 'GitHub authenticated account has no login' };
  } catch (error) {
    return { ok: false, error: `GitHub authenticated account could not be resolved: ${error.message}` };
  }
}

function markerText(body) {
  let fenced = false;
  return String(body ?? '').split(/\r?\n/).filter(line => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced && !/^\s*>/.test(line);
  }).join('\n');
}

function isTrustedComment(comment, expectedLogin) {
  if (!expectedLogin) return true;
  return String(comment?.author?.login ?? comment?.user?.login ?? '').toLowerCase() === String(expectedLogin).toLowerCase();
}

/** Marker-only comment text from the authenticated Agentic Loop account. */
export function trustedCarrierMarkerText(comments, expectedLogin) {
  return (comments ?? [])
    .filter(comment => isTrustedComment(comment, expectedLogin))
    .map(comment => markerText(comment?.body))
    .join('\n\n');
}

/** Stable carrier revision that ignores marker envelopes and their comments. */
export function gitHubCarrierRevision(comments) {
  const substantive = (comments ?? []).map(comment => ({
    id: String(comment?.id ?? ''),
    body: stripCloseoutMarkers(markerText(comment?.body)),
  })).filter(comment => comment.body);
  return `sha256:${canonicalSha256(substantive)}`;
}

/** Resolve only trusted, live marker envelopes from carrier comments. */
export function resolveGitHubCurrentMarkers(comments, expectedLogin) {
  const markers = [];
  for (const comment of comments ?? []) {
    if (!isTrustedComment(comment, expectedLogin)) continue;
    for (const marker of parseCloseoutMarkers(markerText(comment?.body))) {
      markers.push({ ...marker, commentId: Number(comment?.id) || null });
    }
  }
  return resolveCurrentCloseoutMarkers(markers);
}

/**
 * True when the carrier already holds a current marker with this digest.
 *
 * @param {object[]} comments
 * @param {string} digest
 * @returns {{ found: boolean, commentId: number|null }}
 */
export function findMarkerByDigest(comments, digest, expectedLogin) {
  const current = resolveGitHubCurrentMarkers(comments, expectedLogin);
  if (current.error) return { found: false, commentId: null };
  for (const marker of current.current) {
    if ((marker.fields?.AGENT_CLOSEOUT_GATE ?? '') === digest) {
      return { found: true, commentId: marker.commentId ?? null };
    }
  }
  return { found: false, commentId: null };
}

/**
 * Publish one marker to the carrier. Exactly one mutation call is attempted;
 * an ambiguous result is recovered by digest lookup so a retry never creates
 * a duplicate live marker.
 *
 * @param {Function} ghRunner
 * @param {object} params
 * @param {number} params.issueNumber
 * @param {string} params.markerBody
 * @param {string} params.digest
 * @param {string} [params.expectedLogin] Authenticated Agentic Loop account.
 * @param {string} [params.repo]
 * @returns {{ ok: boolean, idempotent?: boolean, commentId?: number|null, error?: string, ambiguousRecovered?: boolean }}
 */
export function publishGitHubCloseoutMarker(ghRunner, params) {
  const repoArgs = params.repo ? ['--repo', params.repo] : [];

  const post = ghRunner('gh', [
    'issue', 'comment', String(params.issueNumber),
    '--body', params.markerBody,
    ...repoArgs,
  ], { encoding: 'utf-8' });
  if (post?.status === 0) {
    return { ok: true, commentId: null };
  }

  // Ambiguous remote result: the post may have succeeded remotely while the
  // client saw a failure. Recover by locating the exact packet digest.
  const recovery = fetchCarrierComments(ghRunner, params.issueNumber, { repo: params.repo });
  if (recovery.ok) {
    const found = findMarkerByDigest(recovery.comments, params.digest, params.expectedLogin);
    if (found.found) {
      return { ok: true, idempotent: true, ambiguousRecovered: true, commentId: found.commentId };
    }
  }
  return {
    ok: false,
    error: String(post?.stderr ?? post?.error?.message ?? 'marker publication failed').trim(),
  };
}

/**
 * Idempotent publication check before mutating: when the carrier already
 * holds the exact digest as its current marker, publication is already done.
 *
 * @param {Function} ghRunner
 * @param {object} params
 * @returns {{ alreadyCurrent: boolean, comments: object[], error: string|null }}
 */
export function checkGitHubMarkerCurrent(ghRunner, params) {
  const fetched = fetchCarrierComments(ghRunner, params.issueNumber, { repo: params.repo });
  if (!fetched.ok) {
    return { alreadyCurrent: false, comments: [], error: fetched.error };
  }
  if (!params.expectedLogin) {
    return { alreadyCurrent: false, comments: fetched.comments, error: 'trusted GitHub account identity is unavailable' };
  }
  const found = findMarkerByDigest(fetched.comments, params.digest, params.expectedLogin);
  return { alreadyCurrent: found.found, comments: fetched.comments, error: null };
}

// ---------------------------------------------------------------------------
// Terminal PR lifecycle evidence
// ---------------------------------------------------------------------------

/**
 * Fetch the pull-request lifecycle facts for covered task issues. For each
 * issue, the PRs carrying a closing relationship are enumerated through the
 * issue's `closedByPullRequestsReferences` and each PR is inspected once.
 * Reads are bounded: one issue read plus one PR read per closing reference.
 * Any read failure is an explicit error, never a silent pass.
 *
 * @param {Function} ghRunner
 * @param {number[]} issueNumbers
 * @param {{ repo?: string }} [options]
 * @returns {{ ok: boolean, byIssue?: Map<number, object[]>, error?: string }}
 */
export function fetchPullRequestLifecycle(ghRunner, issueNumbers, options = {}) {
  const repoArgs = options.repo ? ['--repo', options.repo] : [];
  const byIssue = new Map();
  for (const issueNumber of issueNumbers ?? []) {
    let refs;
    try {
      const data = runGhJson(ghRunner, [
        'issue', 'view', String(issueNumber),
        '--json', 'closedByPullRequestsReferences',
        ...repoArgs,
      ]);
      refs = Array.isArray(data?.closedByPullRequestsReferences) ? data.closedByPullRequestsReferences : [];
    } catch (error) {
      return { ok: false, error: `cannot inspect closing pull requests for issue #${issueNumber}: ${error.message}` };
    }
    const prs = [];
    for (const ref of refs) {
      const number = Number(ref?.number);
      if (!Number.isInteger(number) || number <= 0) continue;
      try {
        prs.push(runGhJson(ghRunner, [
          'pr', 'view', String(number),
          '--json', 'number,state,mergedAt,mergeCommit,headRefOid,reviewDecision,reviews,closingIssuesReferences',
          ...repoArgs,
        ]));
      } catch (error) {
        return { ok: false, error: `cannot inspect PR #${number} closing issue #${issueNumber}: ${error.message}` };
      }
    }
    byIssue.set(Number(issueNumber), prs);
  }
  return { ok: true, byIssue };
}

/**
 * Evaluate the terminal PR lifecycle for one covered task issue against the
 * fetched facts. Terminal closeout requires one PR that (a) carries a closing
 * relationship to the correct issue, (b) was accepted by review, (c) is
 * merged, and (d) lands the certified candidate (exact merge-commit identity
 * or proven product-tree equivalence).
 *
 * @param {object[]} prs
 * @param {number} issueNumber
 * @param {string} candidateSha  Full SHA of the certified candidate, or ''.
 * @returns {{ ok: boolean, error?: string }}
 */
export function evaluatePullRequestLifecycle(prs, issueNumber, candidateSha) {
  const closing = (prs ?? []).filter(pr =>
    (Array.isArray(pr?.closingIssuesReferences) ? pr.closingIssuesReferences : [])
      .some(ref => Number(ref?.number) === Number(issueNumber)));
  if (closing.length === 0) {
    return {
      ok: false,
      error: `no pull request carries a closing relationship to issue #${issueNumber}; a closed issue without a valid merged closing PR cannot complete`,
    };
  }
  const merged = closing.filter(pr =>
    String(pr?.state ?? '').toUpperCase() === 'MERGED' || Boolean(pr?.mergedAt));
  if (merged.length === 0) {
    return {
      ok: false,
      error: `pull request(s) closing issue #${issueNumber} are not merged (${closing.map(pr => `#${pr?.number}`).join(', ')})`,
    };
  }
  // `reviewDecision` is GitHub's current aggregate decision. Historical
  // review rows can remain APPROVED after a later change request or dismissal,
  // so they are evidence context, not a terminal acceptance signal.
  const accepted = merged.filter(pr =>
    String(pr?.reviewDecision ?? '').toUpperCase() === 'APPROVED');
  if (accepted.length === 0) {
    return {
      ok: false,
      error: `merged pull request(s) closing issue #${issueNumber} have no accepted review (${merged.map(pr => `#${pr?.number}`).join(', ')})`,
    };
  }
  if (candidateSha) {
    const bound = accepted.filter(pr => String(pr?.mergeCommit?.oid ?? '') === candidateSha);
    if (bound.length === 0) {
      return {
        ok: false,
        error:
          `merged pull request(s) closing issue #${issueNumber} landed ${accepted.map(pr => `#${pr?.number}@${String(pr?.mergeCommit?.oid ?? '?').slice(0, 12)}`).join(', ')}, ` +
          `not the certified candidate ${candidateSha.slice(0, 12)}; the merge artifact must match the certified candidate or prove product-tree equivalence`,
      };
    }
  }
  return { ok: true };
}
