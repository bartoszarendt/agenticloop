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

describe("worktree CLI: cleanup, prune, and bare coordinator", () => {
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

    it('cleanup keeps open PR worktrees', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-014', 'task/T-014');
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));
    // Diverge so ancestry alone would not report merged.
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-014 feature']));

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run'], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_GH_PR_STATE: JSON.stringify({ state: 'OPEN', number: 14 }),
      },
    });
    assertOk(result);
    assert.match(result.stdout, /kept/);
    assert.match(result.stdout, /open PR #14/);
  });


    it('cleanup treats squash-merged PR state as removable even when ancestry is not merged', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-015', 'task/T-015');
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-015 feature']));

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run'], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_GH_PR_STATE: JSON.stringify({ state: 'MERGED', number: 15 }),
      },
    });
    assertOk(result);
    assert.match(result.stdout, /would remove/);
    assert.match(result.stdout, /merged PR #15/);
  });


    it('cleanup is conservative when GitHub lookup fails', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-016', 'task/T-016');
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-016 feature']));

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run'], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_GH_PR_STATE: 'fail',
      },
    });
    assertOk(result);
    assert.match(result.stdout, /needs review/);
  });


    it('prune dry-run reports prunable entries without mutation', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-017', 'task/T-017');
    assertGitOk(git(repo, ['worktree', 'remove', worktree]));

    const worktreesDir = join(repo, '.git', 'worktrees');
    const before = existsSync(worktreesDir) ? readdirSync(worktreesDir).length : 0;

    const result = run(['worktree', 'prune', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.match(result.stdout, /prune|prunable|would prune/i);

    const after = existsSync(worktreesDir) ? readdirSync(worktreesDir).length : 0;
    assert.equal(after, before);
  });


    it('resolves project-root bare coordinator repos correctly', () => {
    const root = makeBareCoordinatorRepo();
    const context = resolveGitRepositoryContext(root);
    assert.equal(context.repoRoot, root);
    assert.equal(context.isBare, true);
    assert.equal(context.commonGitDir, join(root, '.git'));
    assert.equal(context.gitCwd, root);
  });


    it('classifies .agenticloop/worktrees lanes as standard in a bare coordinator repo', () => {
    const root = makeBareCoordinatorRepo();
    const lane = join(root, '.agenticloop', 'worktrees', 'T-BARE');
    assertGitOk(git(root, ['worktree', 'add', '-q', '-b', 'task/T-BARE', lane, 'HEAD']));

    const result = run(['worktree', 'list', '--target', root, '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    const standard = parsed.find(entry => entry.path === lane);
    assert.ok(standard, 'lane should be listed');
    assert.equal(standard.location, 'standard');

    const guardResult = run(['worktree', 'guard', '--target', root, '--all', '--fix']);
    assert.match(guardResult.stdout, /T-BARE/);

    const cleanupResult = run(['worktree', 'cleanup', '--target', root, '--dry-run']);
    assertOk(cleanupResult);
    assert.match(cleanupResult.stdout, /needs review:.*T-BARE|would remove:.*T-BARE/);
  });


    it('supports worktree add from a bare coordinator repo', () => {
    const root = makeBareCoordinatorRepo();
    const result = run(['worktree', 'add', 'T-BARE-ADD', 'task/T-BARE-ADD', '--target', root]);
    assertOk(result);
    const lane = join(root, '.agenticloop', 'worktrees', 'T-BARE-ADD');
    assert.ok(existsSync(lane), 'lane directory should exist');
  });


    it('lists worktrees from inside a lane relative to the coordinator root', () => {
    const repo = makeGitRepo();
    const lane = addStandardWorktree(repo, 'T-LANE', 'task/T-LANE');

    const result = run(['worktree', 'list', '--target', lane, '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    const mainRec = parsed.find(entry => entry.location === 'main');
    const laneRec = parsed.find(entry => entry.path === lane);
    assert.ok(mainRec, 'coordinator root should be main');
    assert.equal(mainRec.path, repo);
    assert.ok(laneRec, 'lane should be listed');
    assert.equal(laneRec.location, 'standard');
  });

});
