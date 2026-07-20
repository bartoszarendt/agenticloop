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

describe("worktree CLI: lane-local preservation and blocking state", () => {
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

    it('cleanup --yes preserves lane-local logs and removes the worktree', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-CLEANUP', 'task/T-CLEANUP');
    makeFilesBackendProjectMap(repo);

    writeFileSync(join(worktree, 'feature.txt'), 'feature\n', 'utf-8');
    assertGitOk(git(worktree, ['add', 'feature.txt']));
    assertGitOk(git(worktree, ['commit', '-q', '-m', 'T-CLEANUP feature']));
    mergeTaskBranch(repo, 'task/T-CLEANUP');

    const logContent = '{"event_type":"task.closed","outcome":"success"}\n';
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-CLEANUP.jsonl'), logContent, 'utf-8');

    const result = run(['worktree', 'cleanup', '--target', repo, '--yes']);
    assertOk(result);

    const preservedPath = join(repo, '.agenticloop', 'logs', 'T-CLEANUP.jsonl');
    assert.ok(existsSync(preservedPath), 'lane-local log should be preserved');
    assert.equal(readFileSync(preservedPath, 'utf-8'), logContent);

    const after = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(after);
    assert.ok(!JSON.parse(after.stdout).some(entry => entry.path === worktree), 'worktree should be removed');
  });


    it('remove --yes preserves untracked lane-local logs and removes the worktree', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-REMOVE', 'task/T-REMOVE');
    makeFilesBackendProjectMap(repo);

    const logContent = '{"event_type":"task.started"}\n';
    mkdirSync(join(worktree, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'T-REMOVE.jsonl'), logContent, 'utf-8');

    const result = run(['worktree', 'remove', 'T-REMOVE', '--target', repo, '--yes']);
    assertOk(result);

    const preservedPath = join(repo, '.agenticloop', 'logs', 'T-REMOVE.jsonl');
    assert.ok(existsSync(preservedPath), 'lane-local log should be preserved');
    assert.equal(readFileSync(preservedPath, 'utf-8'), logContent);

    const after = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(after);
    assert.ok(!JSON.parse(after.stdout).some(entry => entry.path === worktree), 'worktree should be removed');
  });


    it('cleanup keeps worktree with dirty shared .agenticloop state', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-SHARED', 'task/T-SHARED');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(worktree, '.agenticloop', 'summaries'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'summaries', 'README.md'), '# shared\n', 'utf-8');

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.match(result.stdout, /kept:.*T-SHARED/, 'should be kept');
    assert.match(result.stdout, /blocking dirty files/, 'should report blocking dirty files');
    assert.doesNotMatch(result.stdout, /would remove:.*T-SHARED/, 'should not remove');
  });


    it('remove --yes refuses dirty shared .agenticloop state without --force', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-SHARED-R', 'task/T-SHARED-R');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(worktree, '.agenticloop', 'summaries'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'summaries', 'README.md'), '# shared\n', 'utf-8');

    const result = run(['worktree', 'remove', 'T-SHARED-R', '--target', repo, '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dirty/);
    assert.ok(existsSync(worktree), 'worktree should remain');
  });


    it('remove --yes refuses nested lane-local state and leaves the worktree', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-NEST', 'task/T-NEST');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(worktree, '.agenticloop', 'logs', 'sub'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'sub', 'T-NEST.jsonl'), '{}\n', 'utf-8');

    const result = run(['worktree', 'remove', 'T-NEST', '--target', repo, '--yes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /dirty/);
    assert.ok(existsSync(worktree), 'worktree should remain');
  });


    it('cleanup dry-run keeps nested lane-local state as blocking dirty', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-NEST2', 'task/T-NEST2');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(worktree, '.agenticloop', 'logs', 'sub'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'logs', 'sub', 'T-NEST2.jsonl'), '{}\n', 'utf-8');

    const result = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(result);
    assert.match(result.stdout, /kept:.*T-NEST2/);
    assert.match(result.stdout, /blocking dirty files/);
    assert.doesNotMatch(result.stdout, /would remove:.*T-NEST2/);
    assert.ok(existsSync(worktree));
  });


    it('treats decision files with overlapping task-id prefixes as blocking shared state', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'P21-01', 'task/P21-01');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(worktree, '.agenticloop', 'decisions'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'decisions', 'P21-010-note.md'), '# note\n', 'utf-8');

    const listResult = run(['worktree', 'list', '--target', repo, '--json']);
    assertOk(listResult);
    const parsed = JSON.parse(listResult.stdout);
    const record = parsed.find(entry => entry.path === worktree);
    assert.ok(record, 'worktree should be listed');
    assert.deepEqual(record.laneLocalDirtyFiles, []);
    assert.ok(record.sharedStateDirtyFiles.includes('.agenticloop/decisions/P21-010-note.md'));

    const removeResult = run(['worktree', 'remove', 'P21-01', '--target', repo, '--yes']);
    assert.notEqual(removeResult.status, 0);
    assert.match(removeResult.stdout + removeResult.stderr, /dirty/);
    assert.ok(existsSync(worktree), 'worktree should remain');

    const cleanupResult = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(cleanupResult);
    assert.match(cleanupResult.stdout, /kept:.*P21-01/);
    assert.match(cleanupResult.stdout, /blocking dirty files/);
  });


    it('includes dirty shared .agenticloop state in blockingDirtyFiles JSON and text', () => {
    const repo = makeGitRepo();
    const worktree = addStandardWorktree(repo, 'T-SHARED-JSON', 'task/T-SHARED-JSON');
    makeFilesBackendProjectMap(repo);

    mkdirSync(join(worktree, '.agenticloop', 'summaries'), { recursive: true });
    writeFileSync(join(worktree, '.agenticloop', 'summaries', 'README.md'), '# shared\n', 'utf-8');

    const jsonResult = run(['worktree', 'cleanup', '--target', repo, '--dry-run', '--json']);
    assertOk(jsonResult);
    const parsed = JSON.parse(jsonResult.stdout);
    const kept = parsed.kept.find(item => item.path === worktree);
    assert.ok(kept, 'worktree should be kept');
    assert.ok(
      kept.blockingDirtyFiles.includes('.agenticloop/summaries/README.md'),
      'blockingDirtyFiles should include shared state'
    );

    const textResult = run(['worktree', 'cleanup', '--target', repo, '--dry-run']);
    assertOk(textResult);
    assert.match(textResult.stdout, /\.agenticloop\/summaries\/README\.md/);
  });

});
