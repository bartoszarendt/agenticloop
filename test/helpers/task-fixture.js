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

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Canonical sources that `init` itself installs.
const SCAFFOLD_PROJECT_MAP = join(REPO_ROOT, 'memory', 'scaffold', 'project.md');
const TASK_RECORD_TEMPLATE = join(REPO_ROOT, 'memory', 'task-record.md');

/**
 * Populate `target` with the minimum files the `task` command requires.
 * @param {string} target  An existing, empty directory owned by the caller.
 * @returns {string} target
 */
export function createTaskProjectFixture(target) {
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  copyFileSync(SCAFFOLD_PROJECT_MAP, join(target, '.agenticloop', 'project.md'));
  mkdirSync(join(target, 'agenticloop', 'memory'), { recursive: true });
  copyFileSync(
    TASK_RECORD_TEMPLATE,
    join(target, 'agenticloop', 'memory', 'task-record.md')
  );
  return target;
}
