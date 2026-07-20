/**
 * CLI-level tests for Agentic Loop worktree provisioning.
 *
 * Split from the original monolithic worktree-cli.test.js into behavior groups
 * so Node's per-file test isolation can run these scenarios concurrently. Shared
 * setup lives in test/helpers/worktree-cli.js. Every scenario body is preserved
 * verbatim from the original file.
 */

import {
  classifyWorktreesForCleanup,
  createAgenticLoopWorktree,
  lookupPullRequestState,
  resolveGitRepositoryContext,
} from '../src/worktree.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createWorktreeHarness, REPO_ROOT, BIN } from './helpers/worktree-cli.js';

let harness;
let tmpDir;
let run, git, assertOk, assertGitOk, makeGitRepo, gitConfig, makeBareGitRepo;
let makeFilesBackendProjectMap, makeGithubBackendProjectMap, addWorktreeViaGit;
let makeBareCoordinatorRepo, addStandardWorktree, mergeTaskBranch;

describe("worktree CLI: removal and cleanup preservation", () => {
  before(() => {
    harness = createWorktreeHarness();
    ({
      tmpDir,
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
    } = harness);
  });

  after(() => {
    harness.cleanup();
  });

    it('dry-run remove mutates nothing', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-006', 'task/T-006');
    makeFilesBackendProjectMap(repo);
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-006.jsonl'), '{}\n', 'utf-8');
    assertGitOk(git(worktree, ['add', '.']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'state']));

    const before = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(before);
    assert.ok(JSON.parse(before.stdout).some(entry => entry.path === worktree));

    const result = run(['worktree', 'remove', 'T-006', '--target', repo, '--dry-run']);
    assertOk(result);

    const after = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(after);
    assert.ok(JSON.parse(after.stdout).some(entry => entry.path === worktree));
    assert.ok(existsSync(worktree));
  });


    it('refuses to remove a dirty worktree without --force', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-007', 'task/T-007');
    writeFileSync(join(worktree, 'dirty.txt'), 'dirty', 'utf-8');

    const result = run(['worktree', 'remove', 'T-007', '--target', repo, '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dirty/);
    assert.ok(existsSync(worktree));
  });


    it('allows removing a dirty worktree with targeted --force', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-008', 'task/T-008');
    makeFilesBackendProjectMap(repo);
    writeFileSync(join(worktree, 'dirty.txt'), 'dirty', 'utf-8');

    const result = run(['worktree', 'remove', 'T-008', '--target', repo, '--yes', '--force']);
    assertOk(result);

    const after = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(after);
    assert.ok(!JSON.parse(after.stdout).some(entry => entry.path === worktree));
  });


    it('refuses to remove a locked worktree', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-009', 'task/T-009');
    assertGitOk(git(repo, ['worktree', 'lock', worktree]));

    const result = run(['worktree', 'remove', 'T-009', '--target', repo, '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /locked/);
    assert.ok(existsSync(worktree));
  });


    it('bulk cleanup leaves external and detached worktrees for review', () => {
    const repo = makeGitRepo();
    const standard = addWorktreeViaGit(repo, 'T-010', 'task/T-010');
    // Make the standard branch diverge so ancestry does not report merged.
    writeFileSync(join(standard, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(standard, ['add', 'feature.txt']));
    assertGitOk(git(standard, ['commit', '-q', '-m', 'T-010 feature']));

    const external = mkdtempSync(join(tmpDir, 'external-cleanup-'));
    assertGitOk(git(repo, ['worktree', 'add', '-q', '--detach', external, 'HEAD']));

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.match(result.stdout, /needs review/);
    assert.doesNotMatch(result.stdout, /would remove.*external/);
  });


    it('copies lane-local state before removal', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-011', 'task/T-011');
    makeFilesBackendProjectMap(repo);
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    const logContent = '{"event_type":"task.started"}\n';
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-011.jsonl'), logContent, 'utf-8');
    assertGitOk(git(worktree, ['add', '.']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'state']));

    const result = run(['worktree', 'remove', 'T-011', '--target', repo, '--yes']);
    assertOk(result);
    assert.match(result.stdout, /preserved/);

    const preservedPath = join(repo, '.agenticloop', 'logs', 'T-011.jsonl');
    assert.ok(existsSync(preservedPath));
    assert.equal(readFileSync(preservedPath, 'utf-8'), logContent);
  });


    it('accepts identical existing state file during preservation', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-012', 'task/T-012');
    makeFilesBackendProjectMap(repo);
    const logContent = '{"event_type":"task.started"}\n';
    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-012.jsonl'), logContent, 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-012.jsonl'), logContent, 'utf-8');
    assertGitOk(git(worktree, ['add', '.']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'state']));

    const result = run(['worktree', 'remove', 'T-012', '--target', repo, '--yes']);
    assertOk(result);

    const after = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(after);
    assert.ok(!JSON.parse(after.stdout).some(entry => entry.path === worktree));
  });


    it('blocks removal when existing state file conflicts', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-013', 'task/T-013');
    makeFilesBackendProjectMap(repo);
    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-013.jsonl'), '{"event_type":"task.closed"}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-013.jsonl'), '{"event_type":"task.started"}\n', 'utf-8');
    assertGitOk(git(worktree, ['add', '.']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'state']));

    const result = run(['worktree', 'remove', 'T-013', '--target', repo, '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /conflict|different content/);
    assert.ok(existsSync(worktree));
  });

});
