import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import {
  VerificationContextMalformedError,
  VerificationContextStaleError,
} from './public-error.js';

/**
 * Re-observe the GitHub transport facts carried by repository evidence.
 * Commit-range and changed-path facts are independently rederived by
 * receiveRoleReturn through its Git reader; this boundary proves that the PR
 * still names the same live head, branch, number, URL, and open state.
 * Terminal closeout is the sole exception: it proves that this exact formerly
 * open PR is now merged, while retaining the original evidence projection for
 * the authenticated return comparison.
 */
export function refetchGitHubReturnEvidence(suppliedEvidence, {
  commandRunner = defaultGhCommandRunner,
  repo,
  historicalCloseout = false,
} = {}) {
  const identities = ['productBaseHead', 'productHead', 'workflowHead']
    .map(field => [field, String(suppliedEvidence?.[field] ?? '').trim()]);
  if (identities.some(([, identity]) => !isGitObjectId(identity)) ||
      !sameGitObjectFormat(identities.map(([, identity]) => identity))) {
    throw new VerificationContextMalformedError(
      'GitHub return evidence requires productBaseHead, productHead, and workflowHead as full identities of one Git object format'
    );
  }
  const number = Number(suppliedEvidence?.pr?.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new VerificationContextMalformedError('GitHub return evidence requires a positive PR number');
  }
  if (suppliedEvidence?.pr?.state !== 'open') {
    throw new VerificationContextMalformedError('GitHub return evidence must record the open PR state observed for the role return');
  }
  const args = [
    'pr', 'view', String(number),
    '--json', 'number,state,url,headRefOid,headRefName,mergedAt,mergeCommit',
  ];
  if (repo) args.push('--repo', repo);
  let live;
  try {
    live = runGhJson(commandRunner, args);
  } catch (error) {
    throw new VerificationContextStaleError(`GitHub return evidence could not be refetched: ${error.message}`);
  }
  const liveNumber = Number(live?.number);
  const liveHead = String(live?.headRefOid ?? '').toLowerCase();
  const liveBranch = String(live?.headRefName ?? '');
  const liveUrl = String(live?.url ?? '');
  if (liveNumber !== number || !isGitObjectId(liveHead)) {
    throw new VerificationContextMalformedError('GitHub returned an invalid PR identity or head');
  }
  const liveState = String(live?.state ?? '').toUpperCase();
  if (historicalCloseout) {
    if (liveState !== 'MERGED' || !String(live?.mergedAt ?? '').trim() || !isGitObjectId(String(live?.mergeCommit?.oid ?? ''))) {
      throw new VerificationContextStaleError(`GitHub PR #${number} is not a merged terminal PR for historical closeout evidence`);
    }
  } else if (liveState !== 'OPEN') {
    throw new VerificationContextStaleError(`GitHub PR #${number} is no longer open`);
  }
  if (liveHead !== suppliedEvidence.workflowHead ||
      liveBranch !== suppliedEvidence?.branch ||
      liveUrl !== suppliedEvidence?.pr?.url) {
    throw new VerificationContextStaleError(`GitHub PR #${number} changed after return evidence was collected`);
  }
  // Transport facts are observed here. Product topology and path evidence stay
  // bound to their producing verification boundary; this function never accepts
  // the retired ambiguous `head` field as a substitute for workflowHead.
  return {
    ...structuredClone(suppliedEvidence),
    branch: liveBranch,
    workflowHead: liveHead,
    // A return is authenticated over its original open-state observation. The
    // terminal proof above is an additional closeout-only condition, not a
    // rewrite of that signed observation.
    pr: structuredClone(suppliedEvidence.pr),
  };
}
