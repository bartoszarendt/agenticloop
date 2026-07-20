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

describe("worktree CLI: resolve-state cleanup and preservation", () => {
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

    it('resolve-state prefer-root allows later cleanup to remove the lane', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-ROOT-CLEAN', 'task/T-RES-ROOT-CLEAN');
    makeGithubBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-ROOT-CLEAN.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-ROOT-CLEAN.jsonl'), '{"lane":true}\n', 'utf-8');

    const resolveResult = run(['worktree', 'resolve-state', 'T-RES-ROOT-CLEAN', '--target', repo, '--yes', '--strategy', 'prefer-root']);
    assertOk(resolveResult);

    const cleanupResult = run(['worktree', 'cleanup', '--target', repo, '--dry-run'], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_GH_PR_STATE: JSON.stringify({ state: 'MERGED', number: 42 }),
      },
    });
    assertOk(cleanupResult);
    assert.match(cleanupResult.stdout, /would remove:.*T-RES-ROOT-CLEAN/);
    assert.doesNotMatch(cleanupResult.stdout, /state file conflict/);
  });


    it('resolve-state union-jsonl allows later cleanup to remove the lane', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-UNION-CLEAN', 'task/T-RES-UNION-CLEAN');
    makeGithubBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-UNION-CLEAN.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-UNION-CLEAN.jsonl'), '{"lane":true}\n', 'utf-8');

    const resolveResult = run(['worktree', 'resolve-state', 'T-RES-UNION-CLEAN', '--target', repo, '--yes', '--strategy', 'union-jsonl']);
    assertOk(resolveResult);

    const cleanupResult = run(['worktree', 'cleanup', '--target', repo, '--dry-run'], {
      env: {
        ...process.env,
        AGENTICLOOP_TEST_GH_PR_STATE: JSON.stringify({ state: 'MERGED', number: 42 }),
      },
    });
    assertOk(cleanupResult);
    assert.match(cleanupResult.stdout, /would remove:.*T-RES-UNION-CLEAN/);
    assert.doesNotMatch(cleanupResult.stdout, /state file conflict/);
  });


    it('resolve-state --yes without --strategy fails', () => {
    const repo = makeGitRepo();
    addStandardWorktree(repo, 'T-RES-NO-STRAT', 'task/T-RES-NO-STRAT');
    makeFilesBackendProjectMap(repo);

    const result = run(['worktree', 'resolve-state', 'T-RES-NO-STRAT', '--target', repo, '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--yes requires --strategy|requires --strategy/);
  });


    it('resolve-state reports no remaining conflicts after a successful resolution', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-VERIFY', 'task/T-RES-VERIFY');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-RES-VERIFY.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-RES-VERIFY.jsonl'), '{"lane":true}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-RES-VERIFY', '--target', repo, '--yes', '--strategy', 'prefer-worktree', '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.remainingConflicts.length, 0);
    assert.equal(parsed.errors.length, 0);
  });


    it('preservation treats root jsonl superset of lane as already preserved', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-SUPERSET', 'task/T-SUPERSET');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-SUPERSET.jsonl'), '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-SUPERSET.jsonl'), '{"a":1}\n{"b":2}\n', 'utf-8');

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run', '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.alreadyPreserved, 'should include alreadyPreserved');
    assert.ok(parsed.alreadyPreserved.some(item => item.includes('T-SUPERSET.jsonl') && item.includes('jsonl superset')));
    assert.equal(parsed.errors.length, 0);
  });


    it('preservation still reports conflict when root jsonl is missing lane lines', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-MISSING', 'task/T-MISSING');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-MISSING.jsonl'), '{"a":1}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-MISSING.jsonl'), '{"a":1}\n{"b":2}\n', 'utf-8');

    const result = run(['worktree', 'remove', 'T-MISSING', '--target', repo, '--dry-run', '--json']);
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.errors.some(e => e.includes('missing 1 lane line')));
  });


    it('preservation still reports conflict for non-jsonl root/lane differences', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-MD-CONFLICT', 'task/T-MD-CONFLICT');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'decisions'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'decisions', 'T-MD-CONFLICT.md'), '# root\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'decisions'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'decisions', 'T-MD-CONFLICT.md'), '# lane\n', 'utf-8');

    const result = run(['worktree', 'remove', 'T-MD-CONFLICT', '--target', repo, '--dry-run', '--json']);
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.errors.some(e => e.includes('state file conflict')));
  });


    it('resolve-state refuses main worktree', () => {
    const repo = makeGitRepo();
    const result = run(['worktree', 'resolve-state', repo, '--target', repo, '--yes', '--strategy', 'prefer-root']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /main worktree/);
  });

});
