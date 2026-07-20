/**
 * Shared harness for worktree CLI integration tests.
 *
 * These tests exercise real Git worktree behavior through the packaged binary,
 * so the harness spawns the real CLI and real `git`. Each harness owns a unique
 * temporary directory root; every scenario creates its own isolated repository
 * beneath it, so separate test files never share mutable state and can run
 * concurrently under Node's per-file test isolation.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

/**
 * Create an isolated worktree-CLI test harness. Call `cleanup()` in `after()`.
 * Returns bound helper functions whose names match the original in-file
 * helpers, so scenario bodies can be used verbatim.
 */
export function createWorktreeHarness(label = 'al-worktree-cli-') {
  const tmpDir = mkdtempSync(join(tmpdir(), label));

  function cleanup() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  function run(args, options = {}) {
    const env = { ...process.env, NODE_ENV: 'test', ...(options.env ?? {}) };
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
    assertGitOk(git(repo, ['init', '-q', '-b', 'main']));
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

  function makeBareGitRepo() {
    const bare = mkdtempSync(join(tmpDir, 'bare-repo-'));
    assertGitOk(git(bare, ['init', '-q', '--bare']));
    assertGitOk(git(bare, ['config', 'user.email', 'agenticloop@example.invalid']));
    assertGitOk(git(bare, ['config', 'user.name', 'Agentic Loop Test']));

    const seed = mkdtempSync(join(tmpDir, 'bare-seed-'));
    assertGitOk(git(seed, ['init', '-q']));
    assertGitOk(git(seed, ['remote', 'add', 'origin', bare]));
    writeFileSync(join(seed, 'README.md'), '# Test\n', 'utf-8');
    assertGitOk(git(seed, ['add', 'README.md']));
    assertGitOk(git(seed, ['commit', '-q', '-m', 'Initial commit']));
    assertGitOk(git(seed, ['push', '-q', 'origin', 'master:main']));
    assertGitOk(git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']));
    rmSync(seed, { recursive: true, force: true });
    return bare;
  }

  function makeFilesBackendProjectMap(repo) {
    const projectDir = join(repo, '.agenticloop');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.md'),
      '---\nsetup_status: confirmed\nsetup_confirmed_at: 2026-01-01\nsetup_confirmed_by: test\ntask_backend: files\nevent_logging: disabled\n---\n',
      'utf-8'
    );
  }

  function makeGithubBackendProjectMap(repo) {
    const projectDir = join(repo, '.agenticloop');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.md'),
      '---\nsetup_status: confirmed\nsetup_confirmed_at: 2026-01-01\nsetup_confirmed_by: test\ntask_backend: github\nevent_logging: disabled\n---\n',
      'utf-8'
    );
  }

  function addWorktreeViaGit(repo, taskId, branch) {
    const parent = join(repo, '.agenticloop', 'worktrees');
    const worktree = join(parent, taskId);
    mkdirSync(parent, { recursive: true });
    assertGitOk(git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']));
    return worktree;
  }

  function makeBareCoordinatorRepo() {
    const root = mkdtempSync(join(tmpDir, 'bare-coordinator-'));
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    assertGitOk(git(gitDir, ['init', '-q', '--bare']));
    assertGitOk(git(gitDir, ['config', 'core.bare', 'true']));
    assertGitOk(git(gitDir, ['config', 'user.email', 'agenticloop@example.invalid']));
    assertGitOk(git(gitDir, ['config', 'user.name', 'Agentic Loop Test']));

    const seed = mkdtempSync(join(tmpDir, 'bare-coord-seed-'));
    assertGitOk(git(seed, ['init', '-q']));
    assertGitOk(git(seed, ['remote', 'add', 'origin', gitDir]));
    writeFileSync(join(seed, 'README.md'), '# Test\n', 'utf-8');
    assertGitOk(git(seed, ['add', 'README.md']));
    assertGitOk(git(seed, ['commit', '-q', '-m', 'Initial commit']));
    assertGitOk(git(seed, ['push', '-q', 'origin', 'master:main']));
    assertGitOk(git(gitDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']));
    mkdirSync(join(root, '.agenticloop'), { recursive: true });
    rmSync(seed, { recursive: true, force: true });
    return root;
  }

  function addStandardWorktree(repo, taskId, branch) {
    const parent = join(repo, '.agenticloop', 'worktrees');
    const worktree = join(parent, taskId);
    mkdirSync(parent, { recursive: true });
    assertGitOk(git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']));
    return worktree;
  }

  function mergeTaskBranch(repo, branch) {
    const current = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    assertGitOk(git(repo, ['checkout', 'main']));
    assertGitOk(git(repo, ['merge', '--no-ff', '-q', branch, '-m', `Merge ${branch}`]));
    if (current && current !== 'HEAD') {
      assertGitOk(git(repo, ['checkout', current]));
    }
  }

  return {
    tmpDir,
    cleanup,
    run,
    git,
    assertOk,
    assertGitOk,
    makeGitRepo,
    gitConfig,
    makeBareGitRepo,
    makeFilesBackendProjectMap,
    makeGithubBackendProjectMap,
    addWorktreeViaGit,
    makeBareCoordinatorRepo,
    addStandardWorktree,
    mergeTaskBranch,
  };
}
