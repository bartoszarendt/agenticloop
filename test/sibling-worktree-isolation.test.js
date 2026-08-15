/**
 * Sibling-worktree isolation tests for P35-C12.4.
 *
 * Ensures that registered Agentic Loop sibling worktree roots are excluded
 * from the recursive untracked and ignored scanning of the active checkout,
 * so the mere existence of a sibling does not block serial root dispatch.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { evaluateDispatchCleanState } from '../src/repository-state.js';
import { createAgenticLoopWorktree, WORKTREE_PARENT } from '../src/worktree.js';
import { createDispatchFixture, git, gitRunner } from './helpers/dispatch-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';

const GIT_TEST_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
});

function gitConfigValue(value) {
  return JSON.stringify(String(value).replaceAll('\\', '/'));
}

function configureTestGitRepository(cwd) {
  const disabledHooks = join(cwd, '.git', 'hooks-disabled');
  mkdirSync(disabledHooks, { recursive: true });
  const existing = readFileSync(join(cwd, '.git', 'config'), 'utf8');
  writeFileSync(join(cwd, '.git', 'config'), existing + [
    '',
    '[user]',
    '\tname = Agentic Loop Test',
    '\temail = loop@example.test',
    '[gc]',
    '\tauto = 0',
    '[commit]',
    '\tgpgSign = false',
    '[tag]',
    '\tgpgSign = false',
    '[core]',
    `\thooksPath = ${gitConfigValue(disabledHooks)}`,
    '\tautocrlf = false',
    '\teol = lf',
    '',
  ].join('\n'), 'utf8');
}

function spawnGit(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_TEST_ENV },
  });
}

function initRepo(cwd) {
  const result = spawnSync('git', ['init', cwd], { encoding: 'utf8', env: { ...process.env, ...GIT_TEST_ENV } });
  assert.equal(result.status, 0, result.stderr);
  configureTestGitRepository(cwd);
  return cwd;
}

describe('sibling-worktree isolation (P35-C12.4)', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'al-sibling-isolation-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('4.1 unit reproducer regression', () => {
    it('clean sibling worktree does not block dispatch', () => {
      const root = join(tmpDir, 'clean-sibling');
      initRepo(root);

      // Commit .gitignore with worktree parent ignored
      writeFileSync(join(root, '.gitignore'), `${WORKTREE_PARENT}/\n`, 'utf8');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'existing.js'), 'export const x = 1;\n', 'utf8');
      spawnGit(root, ['add', '.']);
      spawnGit(root, ['commit', '-m', 'init']);

      // Add a sibling worktree
      spawnGit(root, ['worktree', 'add', join(root, WORKTREE_PARENT, 'T-002'), '-b', 'task/T-002']);

      const runGit = (args) => spawnGit(root, args);
      const result = evaluateDispatchCleanState({ runGit, scopePatterns: ['src/**'] });
      assert.equal(result.ok, true, `expected ok=true, got findings: ${JSON.stringify(result.findings)}`);
      assert.deepEqual(result.state.ignoredRelevantPaths, []);
    });

    it('dirty sibling worktree does not block dispatch', () => {
      const root = join(tmpDir, 'dirty-sibling');
      initRepo(root);

      writeFileSync(join(root, '.gitignore'), `${WORKTREE_PARENT}/\n`, 'utf8');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'existing.js'), 'export const x = 1;\n', 'utf8');
      spawnGit(root, ['add', '.']);
      spawnGit(root, ['commit', '-m', 'init']);

      // Add a sibling worktree and dirty it
      const siblingPath = join(root, WORKTREE_PARENT, 'T-002');
      spawnGit(root, ['worktree', 'add', siblingPath, '-b', 'task/T-002']);
      writeFileSync(join(siblingPath, 'dirty.txt'), 'uncommitted content\n', 'utf8');
      writeFileSync(join(siblingPath, 'src', 'changed.js'), 'export const dirty = true;\n', 'utf8');

      const runGit = (args) => spawnGit(root, args);
      const result = evaluateDispatchCleanState({ runGit, scopePatterns: ['src/**'] });
      assert.equal(result.ok, true, `expected ok=true, got findings: ${JSON.stringify(result.findings)}`);
      assert.deepEqual(result.state.ignoredRelevantPaths, []);
    });
  });

  describe('4.5 byte-preservation', () => {
    it('sibling worktree file bytes are identical before and after clean-state evaluation', () => {
      const root = join(tmpDir, 'byte-preservation');
      initRepo(root);

      writeFileSync(join(root, '.gitignore'), `${WORKTREE_PARENT}/\n`, 'utf8');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'existing.js'), 'export const x = 1;\n', 'utf8');
      spawnGit(root, ['add', '.']);
      spawnGit(root, ['commit', '-m', 'init']);

      // Add a sibling worktree with dirty files
      const siblingPath = join(root, WORKTREE_PARENT, 'T-002');
      spawnGit(root, ['worktree', 'add', siblingPath, '-b', 'task/T-002']);

      const dirtyContent = 'this is uncommitted content that must be preserved\n';
      const trackedChange = 'export const modified = true;\n';
      writeFileSync(join(siblingPath, 'dirty.txt'), dirtyContent, 'utf8');
      mkdirSync(join(siblingPath, 'src'), { recursive: true });
      writeFileSync(join(siblingPath, 'src', 'modified.js'), trackedChange, 'utf8');

      // Snapshot bytes before
      const beforeDirty = readFileSync(join(siblingPath, 'dirty.txt'));
      const beforeTracked = readFileSync(join(siblingPath, 'src', 'modified.js'));

      // Run clean-state evaluation
      const runGit = (args) => spawnGit(root, args);
      const result = evaluateDispatchCleanState({ runGit, scopePatterns: ['src/**'] });
      assert.equal(result.ok, true);

      // Assert bytes identical after
      const afterDirty = readFileSync(join(siblingPath, 'dirty.txt'));
      const afterTracked = readFileSync(join(siblingPath, 'src', 'modified.js'));
      assert.deepEqual(beforeDirty, afterDirty, 'sibling untracked file bytes must be preserved');
      assert.deepEqual(beforeTracked, afterTracked, 'sibling tracked file bytes must be preserved');
    });
  });

  describe('4.6 decisive dispatch test', () => {
    it('prepare-dispatch succeeds with a dirty sibling worktree present', async () => {
      const fixture = await createDispatchFixture(tmpDir, 'dispatch-with-sibling');

      // Create .gitignore with worktree parent entry and commit it
      writeFileSync(join(fixture.root, '.gitignore'), `${WORKTREE_PARENT}/\n`, 'utf8');
      git(fixture.root, ['add', '.gitignore']);
      git(fixture.root, ['commit', '-m', 'ignore worktrees\n\nTask: T-001\nAgent: maintainer']);

      // Add a sibling worktree with a dirty file
      const siblingPath = join(fixture.root, WORKTREE_PARENT, 'T-002');
      mkdirSync(join(fixture.root, WORKTREE_PARENT), { recursive: true });
      spawnGit(fixture.root, ['worktree', 'add', siblingPath, '-b', 'task/T-002']);
      const dirtyContent = 'sibling dirty content that must survive dispatch\n';
      writeFileSync(join(siblingPath, 'unrelated.txt'), dirtyContent, 'utf8');

      // Snapshot sibling bytes before
      const beforeBytes = readFileSync(join(siblingPath, 'unrelated.txt'));

      // Run prepare-dispatch via CLI
      const result = await runCliInProcess([
        'task', 'prepare-dispatch', 'T-001',
        '--host', 'opencode', '--role', 'engineer', '--json', '--target', fixture.root,
      ], {
        operatorTrustRoot: fixture.operatorTrustRoot,
        hostAuthority: protectedHostBoundary(fixture.trust),
      });

      assert.equal(result.status, 0, `prepare-dispatch failed: ${result.stderr}`);

      // Parse the JSON packet from stdout (may have non-JSON prefix lines)
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      assert.ok(jsonMatch, 'expected JSON packet in stdout');
      const packet = JSON.parse(jsonMatch[0]);
      assert.equal(packet.task.id, 'T-001');

      // Assert sibling bytes preserved after dispatch
      const afterBytes = readFileSync(join(siblingPath, 'unrelated.txt'));
      assert.deepEqual(beforeBytes, afterBytes, 'sibling dirty file bytes must be preserved after prepare-dispatch');
    });
  });
});
