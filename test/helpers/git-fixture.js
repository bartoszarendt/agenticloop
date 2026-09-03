import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_TEST_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
});

function gitConfigValue(value) {
  return JSON.stringify(String(value).replaceAll('\\', '/'));
}

export function spawnGit(cwd, args, options = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...GIT_TEST_ENV, ...options.env },
  });
}

/**
 * Resolve `HEAD` to a commit id by reading the ref files directly.
 *
 * A `git rev-parse HEAD` spawn is ~95% process-creation cost and ~5% work, so
 * the suite pays a full process for a two-file read. This returns the identical
 * bytes Git would print, or `null` for anything it cannot resolve with
 * certainty - an unborn branch, a `.git` file rather than a directory, a ref
 * format it does not recognise - so the caller falls back to real Git and the
 * observable behavior, including failure, is unchanged.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
function readHeadCommit(cwd) {
  const gitDir = join(cwd, '.git');
  const readTrimmed = path => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const head = readTrimmed(join(gitDir, 'HEAD'));
  if (head === null) return null;
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(head)) return head;
  if (!head.startsWith('ref: ')) return null;

  const ref = head.slice(5).trim();
  const loose = join(gitDir, ref);
  const value = readTrimmed(loose);
  if (value !== null) {
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value) ? value : null;
  }

  const packed = join(gitDir, 'packed-refs');
  const packedRefs = readTrimmed(packed);
  if (packedRefs === null) return null;
  for (const line of packedRefs.split('\n')) {
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\s+(.+)$/);
    if (match && match[2].trim() === ref) return match[1];
  }
  return null;
}

export function git(cwd, args) {
  // Serve only the exact, unambiguous form from the filesystem. Every other
  // shape - `HEAD^{tree}`, `--abbrev-ref`, multiple revisions - keeps spawning
  // Git, because those need real revision parsing.
  if (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD') {
    const head = readHeadCommit(cwd);
    if (head !== null) return head;
  }
  const result = spawnGit(cwd, ['-C', cwd, ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function gitRunner(cwd) {
  return args => spawnGit(cwd, args);
}

export function configureTestGitRepository(cwd, {
  userName = 'Agentic Loop Test',
  userEmail = 'loop@example.test',
} = {}) {
  const disabledHooks = join(cwd, '.git', 'hooks-disabled');
  mkdirSync(disabledHooks, { recursive: true });
  appendFileSync(join(cwd, '.git', 'config'), [
    '',
    '[user]',
    `\tname = ${gitConfigValue(userName)}`,
    `\temail = ${gitConfigValue(userEmail)}`,
    '[gc]',
    '\tauto = 0',
    '[commit]',
    '\tgpgSign = false',
    '[tag]',
    '\tgpgSign = false',
    '[core]',
    `\thooksPath = ${gitConfigValue(disabledHooks)}`,
    '\tautocrlf = false',
    '\teol = lf',
    '',
  ].join('\n'), 'utf8');
}

export function initTestGitRepository(cwd, {
  initialBranch,
  quiet = false,
  ...config
} = {}) {
  const args = ['init'];
  if (quiet) args.push('-q');
  if (initialBranch) args.push('-b', initialBranch);
  const result = spawnGit(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  configureTestGitRepository(cwd, config);
  return cwd;
}
