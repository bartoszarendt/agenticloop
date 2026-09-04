import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);
const PHASE_NUMBER_IN_FILENAME = /(?:phase[ _-]?\d+|p\d{2}-(?:d)?\d+)/i;
const INTERNAL_PHASE_REFERENCE = /\b(?:phase[ _-]?\d{2}|p\d{2}-d\d+)\b/i;
const TEST_NAME_INTERNAL_REFERENCE = /\b(?:p\d{2}-\d+|[rs]\d+:)\b/i;
// This one synthetic characterization fixture may retain its source-plan
// identifier so frozen measurements remain traceable without exempting future
// numbered phase tests from the tracked-file planning boundary.
const SYNTHETIC_BASELINE_TEST = `test/phase${36}-baseline.test.js`;

function repositoryFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map(file => join(REPO_ROOT, file));
}

function repoRelative(file) {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

describe('internal planning boundary', () => {
  it('keeps numbered development-phase identifiers out of tracked files', () => {
    const violations = [];

    for (const file of repositoryFiles()) {
      const relativePath = repoRelative(file);
      if (relativePath === SYNTHETIC_BASELINE_TEST) continue;
      if (PHASE_NUMBER_IN_FILENAME.test(basename(file))) {
        violations.push(`${relativePath}: numbered phase in filename`);
      }

      if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (INTERNAL_PHASE_REFERENCE.test(line)) {
          violations.push(`${relativePath}:${index + 1}: numbered internal phase reference`);
        }
        if (
          relativePath.startsWith('test/')
          && /\b(?:describe|it)\s*\(/.test(line)
          && TEST_NAME_INTERNAL_REFERENCE.test(line)
        ) {
          violations.push(`${relativePath}:${index + 1}: planning identifier in test name`);
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `internal development identifiers must not appear in tracked files:\n${violations.join('\n')}`
    );
  });
});
