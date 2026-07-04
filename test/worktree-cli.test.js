/**
 * CLI-level tests for Agentic Loop worktree provisioning.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-worktree-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of [
    'GIT_EDITOR',
    'GIT_SEQUENCE_EDITOR',
    'GIT_PAGER',
    'GIT_TERMINAL_PROMPT',
    'GH_EDITOR',
    'GH_PAGER',
    'GH_PROMPT_DISABLED',
  ]) {
    if (!options.env || !(key in options.env)) {
      delete env[key];
    }
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    ...options,
    env,
  });
}

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
  });
}

function assertOk(result) {
  assert.equal(
    result.status,
    0,
    `expected command to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function assertGitOk(result) {
  assert.equal(
    result.status,
    0,
    `expected git command to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpDir, 'repo-'));
  assertGitOk(git(repo, ['init', '-q']));
  assertGitOk(git(repo, ['config', 'user.email', 'agenticloop@example.invalid']));
  assertGitOk(git(repo, ['config', 'user.name', 'Agentic Loop Test']));
  writeFileSync(join(repo, 'README.md'), '# Test\n', 'utf-8');
  assertGitOk(git(repo, ['add', 'README.md']));
  assertGitOk(git(repo, ['commit', '-q', '-m', 'Initial commit']));
  return repo;
}

function gitConfig(cwd, key) {
  const result = git(cwd, ['config', '--get', key]);
  assertGitOk(result);
  return result.stdout.trim();
}

describe('worktree CLI', () => {
  it('creates a repo-internal worktree with non-interactive Git config', () => {
    const repo = makeGitRepo();
    const result = run(['worktree', 'add', 'T-001', 'task/T-001', '--target', repo]);
    assertOk(result);

    const worktree = join(repo, '.agenticloop', 'worktrees', 'T-001');
    assert.ok(existsSync(worktree), 'worktree directory should exist');
    assert.equal(gitConfig(worktree, 'core.editor'), 'true');
    assert.equal(gitConfig(worktree, 'sequence.editor'), 'true');
    assert.equal(gitConfig(worktree, 'core.pager'), 'cat');
    assert.equal(gitConfig(worktree, 'credential.interactive'), 'false');

    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    assert.match(exclude, /\.agenticloop\/worktrees\//);

    const localEditor = git(repo, ['config', '--local', '--get', 'core.editor']);
    assert.notEqual(localEditor.stdout.trim(), 'true', 'main checkout should not get local core.editor=true');
  });

  it('rejects unsafe task ids before creating a worktree path', () => {
    const repo = makeGitRepo();
    const result = run(['worktree', 'add', '..\\bad', 'task/bad', '--target', repo]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /task id must be a safe path segment/);
    assert.equal(existsSync(join(repo, '.agenticloop', 'worktrees', 'bad')), false);
  });

  it('repairs existing Agentic Loop worktrees with guard --fix --all', () => {
    const repo = makeGitRepo();
    const parent = join(repo, '.agenticloop', 'worktrees');
    const worktree = join(parent, 'T-002');
    mkdirSync(parent, { recursive: true });
    assertGitOk(git(repo, ['worktree', 'add', '-q', '-b', 'task/T-002', worktree, 'HEAD']));

    const before = run(['worktree', 'guard', '--target', repo, '--all']);
    assert.notEqual(before.status, 0);
    assert.match(before.stdout, /missing core\.editor/);

    const fix = run(['worktree', 'guard', '--target', repo, '--all', '--fix']);
    assertOk(fix);
    assert.equal(gitConfig(worktree, 'core.editor'), 'true');
    assert.equal(gitConfig(worktree, 'sequence.editor'), 'true');
    assert.equal(gitConfig(worktree, 'core.pager'), 'cat');
    assert.equal(gitConfig(worktree, 'credential.interactive'), 'false');
  });

  it('reports guard state from doctor without mutating the repository', () => {
    const repo = makeGitRepo();
    const beforeExclude = existsSync(join(repo, '.git', 'info', 'exclude'))
      ? readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')
      : '';

    const result = run(['doctor', '--target', repo]);
    assertOk(result);
    assert.match(result.stdout, /Git non-interactive guard:/);
    assert.match(result.stdout, /Session environment:/);
    assert.match(result.stdout, /Coordinator checkout: unguarded/);
    assert.match(result.stdout, /current checkout config is not repaired by worktree guard/);
    assert.match(result.stdout, /Warning: coordinator Git or gh commands can still block/);
    assert.doesNotMatch(result.stdout, /Current checkout config: missing/);

    const afterExclude = existsSync(join(repo, '.git', 'info', 'exclude'))
      ? readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')
      : '';
    assert.equal(afterExclude, beforeExclude);
  });
});
