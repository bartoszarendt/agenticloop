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

describe("worktree CLI: resolve-state guards and JSON output", () => {
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

    it('resolve-state refuses locked worktrees', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-RES-LOCKED', 'task/T-RES-LOCKED');
    makeFilesBackendProjectMap(repo);
    assertGitOk(git(repo, ['worktree', 'lock', worktree]));

    const result = run(['worktree', 'resolve-state', 'T-RES-LOCKED', '--target', repo, '--yes', '--strategy', 'prefer-root']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /locked/);
  });


    it('resolve-state refuses external worktrees', () => {
    const repo = makeGitRepo();
    const external = mkdtempSync(join(tmpDir, 'external-resolve-'));
    assertGitOk(git(repo, ['worktree', 'add', '-q', '--detach', external, 'HEAD']));

    const result = run(['worktree', 'resolve-state', external, '--target', repo, '--yes', '--strategy', 'prefer-root']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /external|detached/);
  });


    it('resolve-state union-jsonl duplicate boundary bug: root A,A + lane A,A,A = 3 total', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-DUP', 'task/T-DUP');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-DUP.jsonl'), '{"a":1}\n{"a":1}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-DUP.jsonl'), '{"a":1}\n{"a":1}\n{"a":1}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-DUP', '--target', repo, '--yes', '--strategy', 'union-jsonl']);
    assertOk(result);
    assert.match(result.stdout, /union-synced 1 line/);
    const expected = '{"a":1}\n{"a":1}\n{"a":1}\n';
    assert.equal(readFileSync(join(repo, '.agenticloop', 'logs', 'T-DUP.jsonl'), 'utf-8'), expected);
    assert.equal(readFileSync(join(worktree, '.agenticloop', 'logs', 'T-DUP.jsonl'), 'utf-8'), expected);
  });


    it('resolve-state union-jsonl mixed duplicate plus new line', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-DUP-NEW', 'task/T-DUP-NEW');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-DUP-NEW.jsonl'), '{"a":1}\n{"a":1}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-DUP-NEW.jsonl'), '{"a":1}\n{"a":1}\n{"a":1}\n{"b":2}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-DUP-NEW', '--target', repo, '--yes', '--strategy', 'union-jsonl']);
    assertOk(result);
    assert.match(result.stdout, /union-synced 2 line/);
    const expected = '{"a":1}\n{"a":1}\n{"a":1}\n{"b":2}\n';
    assert.equal(readFileSync(join(repo, '.agenticloop', 'logs', 'T-DUP-NEW.jsonl'), 'utf-8'), expected);
    assert.equal(readFileSync(join(worktree, '.agenticloop', 'logs', 'T-DUP-NEW.jsonl'), 'utf-8'), expected);
  });


    it('resolve-state --dry-run --json omits remainingConflicts', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-DRY-NULL', 'task/T-DRY-NULL');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-DRY-NULL.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-DRY-NULL.jsonl'), '{"lane":true}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-DRY-NULL', '--target', repo, '--dry-run', '--strategy', 'union-jsonl', '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.remainingConflicts, null);
  });


    it('resolve-state --yes --json reports remainingConflicts after verification', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-YES-VERIFY', 'task/T-YES-VERIFY');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(repo, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.agenticloop', 'logs', 'T-YES-VERIFY.jsonl'), '{"root":true}\n', 'utf-8');
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-YES-VERIFY.jsonl'), '{"lane":true}\n', 'utf-8');

    const result = run(['worktree', 'resolve-state', 'T-YES-VERIFY', '--target', repo, '--yes', '--strategy', 'union-jsonl', '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, false);
    assert.deepEqual(parsed.remainingConflicts, []);
  });


    it('cleanup --dry-run --json includes dryRun true and wouldRemove', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-CLEANUP-JSON', 'task/T-CLEANUP-JSON');
    makeFilesBackendProjectMap(repo);

    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-CLEANUP-JSON feature']));
    mergeTaskBranch(repo, 'task/T-CLEANUP-JSON');

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run', '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, true);
    assert.ok(Array.isArray(parsed.wouldRemove), 'should include wouldRemove');
    assert.ok(parsed.wouldRemove.length > 0, 'should have at least one would-remove candidate');
    assert.deepEqual(parsed.wouldRemove, parsed.removed, 'should match removed');
  });


    it('cleanup --yes --json does not include wouldRemove', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-CLEANUP-YES', 'task/T-CLEANUP-YES');
    makeFilesBackendProjectMap(repo);

    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-CLEANUP-YES feature']));
    mergeTaskBranch(repo, 'task/T-CLEANUP-YES');

    const result = run(['worktree', 'cleanup', '--target', repo, '--yes', '--json']);
    assertOk(result);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.wouldRemove, undefined);
    assert.ok(Array.isArray(parsed.removed));
  });
});
