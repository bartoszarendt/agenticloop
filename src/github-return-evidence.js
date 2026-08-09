import { defaultGhCommandRunner, runGhJson } from './gh-helpers.js';
import { isGitObjectId } from './git-oid.js';
import {
  VerificationContextMalformedError,
  VerificationContextStaleError,
} from './public-error.js';

/**
 * Re-observe the GitHub transport facts carried by repository evidence.
 * Commit-range and changed-path facts are independently rederived by
 * receiveRoleReturn through its Git reader; this boundary proves that the PR
 * still names the same live head, branch, number, URL, and open state.
 */
export function refetchGitHubReturnEvidence(suppliedEvidence, {
  commandRunner = defaultGhCommandRunner,
  repo,
} = {}) {
  const number = Number(suppliedEvidence?.pr?.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new VerificationContextMalformedError('GitHub return evidence requires a positive PR number');
  }
  const args = [
    'pr', 'view', String(number),
    '--json', 'number,state,url,headRefOid,headRefName',
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
  if (String(live?.state ?? '').toUpperCase() !== 'OPEN') {
    throw new VerificationContextStaleError(`GitHub PR #${number} is no longer open`);
  }
  if (liveHead !== String(suppliedEvidence?.head ?? '').toLowerCase() ||
      liveBranch !== suppliedEvidence?.branch ||
      liveUrl !== suppliedEvidence?.pr?.url) {
    throw new VerificationContextStaleError(`GitHub PR #${number} changed after return evidence was collected`);
  }
  return structuredClone(suppliedEvidence);
}
