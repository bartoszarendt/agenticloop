/** Reconstruct files-backed return evidence from current durable Git state. */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deriveCommitRange } from './commit-range.js';
import { isGitObjectId } from './git-oid.js';
import { fileMatchesScopePattern } from './scope-matcher.js';
import { VerificationContextMalformedError, VerificationContextStaleError } from './public-error.js';

export function refetchFilesReturnEvidence(target, packet, signedEvidence, { historicalCloseout = false } = {}) {
  const runGit = args => spawnSync('git', args, { cwd: target, encoding: 'utf8' });
  const readGit = (args, label) => {
    const result = runGit(args);
    if (result.status !== 0) {
      throw new VerificationContextStaleError(`${label} is unavailable: ${String(result.stderr ?? '').trim()}`);
    }
    return String(result.stdout ?? '').trim();
  };
  const branch = readGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'current return branch');
  const head = historicalCloseout
    ? String(signedEvidence?.head ?? '').trim()
    : readGit(['rev-parse', '--verify', 'HEAD'], 'current return head');
  if (!isGitObjectId(head)) throw new VerificationContextMalformedError('current return head is not a full Git identity');
  if (historicalCloseout) {
    readGit(['cat-file', '-e', `${head}^{commit}`], 'historical return head');
  } else {
    for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
      if (runGit(args).status !== 0) throw new VerificationContextStaleError('tracked repository state changed after the role-return evidence was collected');
    }
    const untracked = readGit(['ls-files', '--others', '--exclude-standard'], 'untracked return paths')
      .split(/\r?\n/).filter(Boolean);
    const untrackedInScope = untracked.filter(path =>
      (packet?.task?.allowedPaths ?? []).some(pattern => fileMatchesScopePattern(path, pattern))
    );
    if (untrackedInScope.length > 0) {
      throw new VerificationContextStaleError(`untracked task-scope paths are not represented by durable return evidence: ${untrackedInScope.join(', ')}`);
    }
  }
  const baseHead = packet?.repository?.head;
  if (!isGitObjectId(baseHead)) throw new VerificationContextMalformedError('dispatch packet lacks a full return base identity');
  const derived = deriveCommitRange({
    runGit, baseHead, head, taskId: packet?.task?.id, roleId: packet?.assignment?.roleId,
  });
  if (!derived.ok) {
    throw derived.evidenceState === 'malformed'
      ? new VerificationContextMalformedError(derived.message)
      : new VerificationContextStaleError(derived.message);
  }
  return {
    backend: 'files', task: signedEvidence?.task, worktree: resolve(target), branch,
    baseHead, head, changedPaths: derived.changedPaths,
    attribution: { range: derived.range, commits: derived.commits },
    checks: signedEvidence?.checks,
    pr: { state: 'not_applicable', number: null, url: null },
  };
}
