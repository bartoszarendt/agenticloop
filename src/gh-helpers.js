/**
 * Shared GitHub CLI (`gh`) helpers.
 *
 * Keeps JSON parsing and command-running behavior consistent between
 * github-preflight.js and worktree.js. Callers decide how to surface errors.
 */

import { spawnSync } from 'node:child_process';

export function defaultGhCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf-8', ...options });
}

export function runGhJson(commandRunner, args) {
  const result = commandRunner('gh', args, { encoding: 'utf-8' });
  if (result.error) {
    throw new Error(`failed to run 'gh ${args.join(' ')}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `exit ${result.status}`;
    let hint = '';
    if (/not logged|authentication|gh auth/i.test(detail)) {
      hint = " Run 'gh auth login' first.";
    }
    throw new Error(`'gh ${args.join(' ')}' failed: ${detail}.${hint}`);
  }
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`'gh ${args.join(' ')}' returned invalid JSON`);
  }
}
