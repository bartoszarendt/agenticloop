/**
 * Minimal project fixture for files-backed `task` command tests.
 *
 * `agenticloop task` needs only a small slice of a full init: a project map, a
 * tasks directory, and (for `task new`) the canonical task-record template at
 * the installed toolkit asset path. This fixture copies the canonical repo
 * sources instead of running a full `agenticloop init` per test, and never
 * duplicates the large template bodies inline.
 *
 * Each call produces an independent, mutable target directory tree.
 */

import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, initTestGitRepository } from './git-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Canonical sources that `init` itself installs.
const SCAFFOLD_PROJECT_MAP = join(REPO_ROOT, 'memory', 'scaffold', 'project.md');
const TASK_RECORD_TEMPLATE = join(REPO_ROOT, 'memory', 'task-record.md');

/** Build the fixture tree from scratch, paying the three Git spawns. */
function buildTaskProjectFixture(target, options = {}) {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  copyFileSync(SCAFFOLD_PROJECT_MAP, join(target, '.agenticloop', 'project.md'));
  mkdirSync(join(target, 'agenticloop', 'memory'), { recursive: true });
  copyFileSync(
    TASK_RECORD_TEMPLATE,
    join(target, 'agenticloop', 'memory', 'task-record.md')
  );
  // Repo-local identity remains below deliberate GIT_AUTHOR_* overrides while
  // the shared initializer also disables unsafe ambient test behavior.
  initTestGitRepository(target, { initialBranch: options.initialBranch });
  git(target, ['add', '.']);
  git(target, ['commit', '-m', 'fixture']);
  return target;
}

/**
 * Per-process template cache, keyed by the only input that changes the built
 * tree. Every fixture in a test file is byte-identical, so the three Git
 * spawns are paid once per process instead of once per call.
 */
const templates = new Map();

function templateFor(initialBranch) {
  const key = initialBranch ?? '';
  const cached = templates.get(key);
  if (cached) return cached;
  const template = mkdtempSync(join(tmpdir(), 'al-fixture-template-'));
  buildTaskProjectFixture(template, { initialBranch });
  templates.set(key, template);
  return template;
}

process.on('exit', () => {
  for (const template of templates.values()) {
    try {
      rmSync(template, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * `configureTestGitRepository` writes an absolute `core.hooksPath`, so a copied
 * repository would keep pointing at the template it came from. Rewriting the
 * config is what makes the copy a genuinely independent repository rather than
 * one sharing the template's hook directory.
 */
function retargetGitConfig(fromDir, toDir) {
  const configPath = join(toDir, '.git', 'config');
  const from = resolve(fromDir).replaceAll('\\', '/');
  const to = resolve(toDir).replaceAll('\\', '/');
  if (from === to) return;
  const current = readFileSync(configPath, 'utf8');
  const next = current.replaceAll(from, to);
  if (next !== current) writeFileSync(configPath, next, 'utf8');
}

/**
 * Populate `target` with the minimum files the `task` command requires.
 * @param {string} target  An existing, empty directory owned by the caller.
 * @param {{ initialBranch?: string }} [options]
 * @returns {string} target
 */
export function createTaskProjectFixture(target, options = {}) {
  const template = templateFor(options.initialBranch);
  cpSync(template, target, { recursive: true });
  retargetGitConfig(template, target);
  return target;
}
