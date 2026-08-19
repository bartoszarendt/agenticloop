import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRECTORIES = new Set([
  '.agenticloop',
  '.codegraph',
  '.dev',
  '.git',
  'node_modules',
  // Host runtime output (browser session snapshots), not repository source.
  '.playwright-mcp',
  'tmp',
]);
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

function repositoryFiles(directory = REPO_ROOT) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...repositoryFiles(join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile()) files.push(join(directory, entry.name));
  }

  return files;
}

function repoRelative(file) {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

describe('internal planning boundary', () => {
  it('keeps numbered development-phase identifiers inside .dev', () => {
    const violations = [];

    for (const file of repositoryFiles()) {
      const relativePath = repoRelative(file);
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
      `internal development identifiers must stay under .dev:\n${violations.join('\n')}`
    );
  });
});
