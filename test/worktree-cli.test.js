/**
 * CLI-level tests for Agentic Loop worktree provisioning.
 */

import {
  classifyWorktreesForCleanup,
  createAgenticLoopWorktree,
  lookupPullRequestState,
  resolveGitRepositoryContext,
} from '../src/worktree.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
