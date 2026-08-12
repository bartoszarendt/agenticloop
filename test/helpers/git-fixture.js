import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
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

export function git(cwd, args) {
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
