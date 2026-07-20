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

describe("worktree CLI: resolve-state strategies", () => {
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

    it('resolve-state dry-run mutates nothing', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES', 'task/T-RES');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES.jsonl'), '{"lane":true}\n', 'utf-8');

    const before = readFileSync(join(repo, '.agenticloop', 'logs', 'T-RES.jsonl'), 'utf-8');
    const result = run(['worktree', 'resolve-state', 'T-RES', '--target', repo]);
    assertOk(result);
    assert.match(result.stdout, /would keep root/);
    const after = readFileSync(join(repo, '.agenticloop', 'logs', 'T-RES.jsonl'), 'utf-8');
    assert.equal(after, before);
  });


    it('resolve-state prefer-root syncs lane from root and leaves root unchanged', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-ROOT', 'task/T-RES-ROOT');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-ROOT.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-ROOT.jsonl'), '{"lane":true}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-RES-ROOT', '--target', repo, '--yes', '--strategy', 'prefer-root']);
    assertOk(result);
    assert.match(result.stdout, /synced lane from root/);
    const rootContent = readFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-ROOT.jsonl'), 'utf-8');
    const laneContent = readFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-ROOT.jsonl'), 'utf-8');
    assert.equal(rootContent, '{"root":true}\n');
    assert.equal(laneContent, '{"root":true}\n');
  });


    it('resolve-state prefer-worktree overwrites coordinator content', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-WTREE', 'task/T-RES-WTREE');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-WTREE.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-WTREE.jsonl'), '{"lane":true}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-RES-WTREE', '--target', repo, '--yes', '--strategy', 'prefer-worktree']);
    assertOk(result);
    assert.match(result.stdout, /overwrote root with lane/);
    const content = readFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-WTREE.jsonl'), 'utf-8');
    assert.equal(content, '{"lane":true}\n');
  });


    it('resolve-state union-jsonl writes the union to root and lane', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-UNION', 'task/T-UNION');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-UNION.jsonl'), '{"a":1}\n{"b":2}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-UNION.jsonl'), '{"b":2}\n{"c":3}\n{"a":1}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-UNION', '--target', repo, '--yes', '--strategy', 'union-jsonl']);
    assertOk(result);
    assert.match(result.stdout, /union-synced 1 line/);
    const expected = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const rootContent = readFileSync(join(repo, '.agenticloop', 'logs', 'T-UNION.jsonl'), 'utf-8');
    const laneContent = readFileSync(join(worktree, '.agenticloop', 'logs', 'T-UNION.jsonl'), 'utf-8');
    assert.equal(rootContent, expected);
    assert.equal(laneContent, expected);
  });


    it('resolve-state union-jsonl rejects non-jsonl conflicts', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-UNION-MD', 'task/T-UNION-MD');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'decisions'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'decisions', 'T-UNION-MD.md'), '# root\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'decisions'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'decisions', 'T-UNION-MD.md'), '# lane\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-UNION-MD', '--target', repo, '--yes', '--strategy', 'union-jsonl']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /union-jsonl only supports \.jsonl files|skipped unsupported/);
    const content = readFileSync(join(repo, '.agenticloop', 'decisions', 'T-UNION-MD.md'), 'utf-8');
    assert.equal(content, '# root\n');
  });


    it('resolve-state prefer-worktree allows later cleanup to remove the lane', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-CLEAN', 'task/T-RES-CLEAN');
    makeGithubBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-CLEAN.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-CLEAN.jsonl'), '{"lane":true}\n', 'utf-8');

    const resolveResult = run(['worktree', 'resolve-state', 'T-RES-CLEAN', '--target', repo, '--yes', '--strategy', 'prefer-worktree']);
    assertOk(resolveResult);

    const cleanupResult = run(['worktree', 'cleanup', '--target', repo, '--dry-run'], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_GH_PR_STATE: JSON.stringify({ state: 'MERGED', number: 42 }),
      },
    });
    assertOk(cleanupResult);
    assert.match(cleanupResult.stdout, /would remove:.*T-RES-CLEAN/);
    assert.doesNotMatch(cleanupResult.stdout, /state file conflict/);
  });


    it('falls back to single-branch PR lookup when batched lookup misses a branch', () => {
    const repo = makeGitRepo();
    const wt1 = addStandardWorktree(repo, 'T-FALLBACK-1', 'task/T-FALLBACK-1');
    const wt2 = addStandardWorktree(repo, 'T-FALLBACK-2', 'task/T-FALLBACK-2');
    makeGithubBackendProjectMap(repo);
    assertGitOk(git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']));

    writeFileSync(join(wt1, 'a.txt'), 'a\n', 'utf-8');
    assertGitOk(git(wt1, ['add', 'a.txt']));
    assertGitOk(git(wt1, ['commit', '-q', '-m', 'wt1']));
    writeFileSync(join(wt2, 'b.txt'), 'b\n', 'utf-8');
    assertGitOk(git(wt2, ['add', 'b.txt']));
    assertGitOk(git(wt2, ['commit', '-q', '-m', 'wt2']));

    const commandRunner = (command, args) => {
      if (command !== 'gh') return { status: 1, stdout: '', stderr: '' };
      if (args.includes('--head')) {
        return {
          status: 0,
          stdout: JSON.stringify([{ number: 99, state: 'MERGED' }]),
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 1, state: 'MERGED', headRefName: 'task/T-FALLBACK-1' }]),
        stderr: '',
      };
    };

    const result = classifyWorktreesForCleanup(repo, { commandRunner });
    assert.ok(result.wouldRemove.some(item => item.path.includes('T-FALLBACK-1')), 'T-FALLBACK-1 should be removable from batch');
    assert.ok(result.wouldRemove.some(item => item.path.includes('T-FALLBACK-2')), 'T-FALLBACK-2 should be removable via fallback');
  });


    it('resolve-state union-jsonl preserves root order and appends lane-only repeated lines', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-UNION-REP', 'task/T-UNION-REP');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-UNION-REP.jsonl'), '{"a":1}\n{"b":2}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-UNION-REP.jsonl'), '{"b":2}\n{"a":1}\n{"a":1}\n{"c":3}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-UNION-REP', '--target', repo, '--yes', '--strategy', 'union-jsonl']);
    assertOk(result);
    assert.match(result.stdout, /union-synced 2 line/);
    const expected = '{"a":1}\n{"b":2}\n{"a":1}\n{"c":3}\n';
    assert.equal(readFileSync(join(repo, '.agenticloop', 'logs', 'T-UNION-REP.jsonl'), 'utf-8'), expected);
    assert.equal(readFileSync(join(worktree, '.agenticloop', 'logs', 'T-UNION-REP.jsonl'), 'utf-8'), expected);
  });

});
