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

describe("worktree CLI: add, guard, doctor, and list", () => {
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


    it('lists standard and external worktrees', () => {
    const repo = makeGitRepo();
    addWorktreeViaGit(repo, 'T-003', 'task/T-003');
    const external = mkdtempSync(join(tmpDir, 'external-worktree-'));
    assertGitOk(git(repo, ['worktree', 'add', '-q', external, 'HEAD']));

    const result = run(['worktree', 'list', '--target', repo]);
    assertOk(result);
    assert.match(result.stdout, /T-003/);
    assert.match(result.stdout, /standard/);
    assert.match(result.stdout, /external/);
  });


    it('emits valid JSON from worktree list --json', () => {
    const repo = makeGitRepo();
    addWorktreeViaGit(repo, 'T-004', 'task/T-004');

    const result = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    const standard = parsed.find(entry => entry.location === 'standard');
    assert.ok(standard, 'should include a standard worktree');
    assert.equal(typeof standard.dirtyCount, 'number');
    assert.ok(standard.guard);
  });


    it('supports bare coordinator repos for list, guard --all, and cleanup dry-run', () => {
    const bare = makeBareGitRepo();
    const worktree = mkdtempSync(join(tmpDir, 'bare-worktree-'));
    assertGitOk(git(bare, ['worktree', 'add', '-q', worktree, 'HEAD']));

    const listResult = run(['worktree', 'list', '--target', bare]);
    assertOk(listResult);
    assert.match(listResult.stdout, /bare-main/);

    const guardResult = run(['worktree', 'guard', '--target', bare, '--all', '--fix']);
    assertOk(guardResult);

    const cleanupResult = run(['worktree', 'cleanup', '--target', bare, '--dry-run']);
    assertOk(cleanupResult);
  });


    it('removes a standard worktree with --yes and preserves the branch', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-005', 'task/T-005');
    makeFilesBackendProjectMap(repo);

    const before = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(before);
    assert.ok(JSON.parse(before.stdout).some(entry => entry.path === worktree));

    const branchBefore = git(repo, ['show-ref', '--verify', 'refs/heads/task/T-005']);
    assertGitOk(branchBefore);

    const result = run(['worktree', 'remove', 'T-005', '--target', repo, '--yes']);
    assertOk(result);

    const after = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(after);
    assert.ok(!JSON.parse(after.stdout).some(entry => entry.path === worktree));

    const branchAfter = git(repo, ['show-ref', '--verify', 'refs/heads/task/T-005']);
    assertGitOk(branchAfter);
    assert.equal(branchAfter.stdout.trim(), branchBefore.stdout.trim());
  });

});
