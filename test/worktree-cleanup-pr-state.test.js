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

describe("worktree CLI: cleanup shared state and PR classification", () => {
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

    it('cleanup treats untracked lane-local logs as removable, not dirty', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-LOG', 'task/T-LOG');
    makeFilesBackendProjectMap(repo);

    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-LOG feature']));
    mergeTaskBranch(repo, 'task/T-LOG');

    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-LOG.jsonl'), '{}\n', 'utf-8');

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.match(result.stdout, /would remove:.*T-LOG/);
    assert.match(result.stdout, /would preserve: \.agenticloop\/logs\/T-LOG\.jsonl/);
    assert.doesNotMatch(result.stdout, /kept:.*T-LOG.*dirty/);
  });


    it('cleanup ignores clean shared README state and does not conflict-block', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-README', 'task/T-README');
    makeFilesBackendProjectMap(repo);

    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-README feature']));

    mkdirSync(join(worktree, '.agenticloop', 'summaries'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'summaries', 'README.md'), '# lane\n', 'utf-8');
    assertGitOk(git(worktree, ['add', '.agenticloop/summaries/README.md']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'shared readme']));
    mergeTaskBranch(repo, 'task/T-README');

    mkdirSync(join(repo, '.agenticloop', 'summaries'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'summaries', 'README.md'), '# root\n', 'utf-8');

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.match(result.stdout, /would remove:.*T-README/);
    assert.doesNotMatch(result.stdout, /state file conflict/);
  });


    it('cleanup still blocks when task-specific state conflicts with root', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-CONF', 'task/T-CONF');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-CONF.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-CONF.jsonl'), '{"lane":true}\n', 'utf-8');

    const result = run(['worktree', 'remove', 'T-CONF', '--target', repo, '--dry-run']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /conflict|different content/);
  });


    it('reports prunable worktrees in list JSON and prune dry-run', () => {
    const repo = makeGitRepo();
    const worktree = addWorktreeViaGit(repo, 'T-PRUNE', 'task/T-PRUNE');
    rmSync(worktree, { recursive: true, force: true });

    const listResult = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(listResult);
    const parsed = JSON.parse(listResult.stdout);
    const record = parsed.find(entry => entry.path === worktree);
    assert.ok(record, 'deleted worktree should still be registered');
    assert.equal(record.prunable, true);

    const pruneResult = run(['worktree', 'prune', '--target', repo, '--dry-run']);
    assertOk(pruneResult);
    assert.match(pruneResult.stdout, /prune|prunable|would prune/i);
  });


    it('does not classify ancestry against the current feature branch', () => {
    const repo = makeGitRepo();
    assertGitOk(git(repo, ['checkout', '-b', 'feature']));
    const worktree = addStandardWorktree(repo, 'T-ANC', 'task/T-ANC');
    makeFilesBackendProjectMap(repo);

    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-ANC feature']));

    assertGitOk(git(repo, ['merge', '--no-ff', '-q', 'task/T-ANC', '-m', 'Merge into feature']));

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.doesNotMatch(result.stdout, /would remove:.*T-ANC/);
    assert.match(result.stdout, /needs review:.*T-ANC/);
  });


    it('batches GitHub PR lookups during cleanup', () => {
    const repo = makeGitRepo();
    addStandardWorktree(repo, 'T-021', 'task/T-021');
    addStandardWorktree(repo, 'T-022', 'task/T-022');
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));

    let callCount = 0;
    const lookupPrStates = (repoRoot, branches) => {
      callCount += 1;
      const map = new Map();
      for (const branch of branches) {
        if (branch === 'refs/heads/task/T-021') {
          map.set(branch, { state: 'MERGED', number: 21, warning: null, source: 'mock' });
        } else if (branch === 'refs/heads/task/T-022') {
          map.set(branch, { state: 'OPEN', number: 22, warning: null, source: 'mock' });
        }
      }
      return map;
    };

    const result = classifyWorktreesForCleanup(repo, { lookupPrStates });
    assert.equal(callCount, 1);
    assert.ok(result.wouldRemove.some(item => item.path.includes('T-021')), 'T-021 should be removable');
    assert.ok(result.kept.some(item => item.path.includes('T-022')), 'T-022 should be kept open');
  });


    it('classifies merged PRs via batched --state all lookup by default', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-BATCH', 'task/T-BATCH');
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-BATCH feature']));

    let capturedArgs = [];
    const commandRunner = (command, args) => {
      if (command === 'gh') {
        capturedArgs = args;
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 42, state: 'MERGED', headRefName: 'task/T-BATCH' }]),
        stderr: '',
      };
    };

    const result = classifyWorktreesForCleanup(repo, { commandRunner });
    assert.ok(capturedArgs.includes('--state'), 'should pass --state');
    assert.ok(capturedArgs.includes('all'), 'should pass all');
    assert.ok(result.wouldRemove.some(item => item.path.includes('T-BATCH')), 'T-BATCH should be removable');
    const item = result.wouldRemove.find(item => item.path.includes('T-BATCH'));
    assert.match(item.reason, /merged PR #42/);
  });


    it('lookupPullRequestState requests --state all', () => {
    const repo = makeGitRepo();
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));

    let capturedArgs = [];
    const commandRunner = (command, args) => {
      capturedArgs = args;
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 7, state: 'MERGED' }]),
        stderr: '',
      };
    };

    const result = lookupPullRequestState(repo, 'task/T-STATE', { commandRunner, repo: 'example/repo' });
    assert.ok(capturedArgs.includes('--state'), 'should pass --state');
    assert.ok(capturedArgs.includes('all'), 'should pass all');
    assert.equal(result.state, 'MERGED');
    assert.equal(result.number, 7);
  });

});
