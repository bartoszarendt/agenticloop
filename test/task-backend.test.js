import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveTaskBackend } from '../src/task-backend.js';

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-task-backend-test-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function makeTarget(name) {
  return mkdtempSync(join(tmpBase, `${name}-`));
}

function writeProjectMap(dir, frontmatterLines) {
  mkdirSync(join(dir, '.agenticloop'), { recursive: true });
  writeFileSync(
    join(dir, '.agenticloop', 'project.md'),
    ['---', ...frontmatterLines, '---', '# Project Map'].join('\n')
  );
}

describe('resolveTaskBackend', () => {
  it('prefers project.md github over legacy JSON files', () => {
    const d = makeTarget('project-github-wins');
    writeProjectMap(d, ['task_backend: github']);
    writeFileSync(join(d, 'agenticloop.json'), '{\n  "taskBackend": "files"\n}\n');

    const result = resolveTaskBackend(d);

    assert.equal(result.backend, 'github');
    assert.equal(result.source, 'project.md');
    assert.equal(result.projectTaskBackend, 'github');
    assert.equal(result.legacyJsonTaskBackend, 'files');
  });

  it('prefers project.md files over legacy JSON github', () => {
    const d = makeTarget('project-files-wins');
    writeProjectMap(d, ['task_backend: files']);
    writeFileSync(join(d, 'agenticloop.json'), '{\n  "taskBackend": "github"\n}\n');

    const result = resolveTaskBackend(d);

    assert.equal(result.backend, 'files');
    assert.equal(result.source, 'project.md');
    assert.equal(result.projectTaskBackend, 'files');
    assert.equal(result.legacyJsonTaskBackend, 'github');
  });

  it('uses legacy JSON taskBackend when project.md is absent', () => {
    const d = makeTarget('legacy-json-only');
    writeFileSync(join(d, 'agenticloop.json'), '{\n  "taskBackend": "github"\n}\n');

    const result = resolveTaskBackend(d);

    assert.equal(result.backend, 'github');
    assert.equal(result.source, 'agenticloop.json');
    assert.equal(result.projectTaskBackend, null);
    assert.equal(result.legacyJsonTaskBackend, 'github');
  });

  it('defaults to files when no project.md and no explicit JSON selector exist', () => {
    const d = makeTarget('default-files');
    writeFileSync(join(d, 'agenticloop.json'), '{\n  "documents": {\n    "overview": "README.md"\n  }\n}\n');

    const result = resolveTaskBackend(d);

    assert.equal(result.backend, 'files');
    assert.equal(result.source, 'default');
    assert.equal(result.projectTaskBackend, null);
    assert.equal(result.legacyJsonTaskBackend, null);
  });

  it('does not treat inherited base taskBackend as an explicit target selector', () => {
    const d = makeTarget('ignore-inherited-selector');
    mkdirSync(join(d, 'agenticloop'), { recursive: true });
    writeFileSync(join(d, 'agenticloop', 'config.json'), '{\n  "taskBackend": "github"\n}\n');
    writeFileSync(join(d, 'agenticloop.json'), '{\n  "extends": "./agenticloop/config.json"\n}\n');

    const result = resolveTaskBackend(d);

    assert.equal(result.backend, 'files');
    assert.equal(result.source, 'default');
    assert.equal(result.legacyJsonTaskBackend, null);
  });

  it('warns when the resolved backend is unsupported', () => {
    const d = makeTarget('unsupported-backend');
    writeProjectMap(d, ['task_backend: jira']);

    const result = resolveTaskBackend(d);

    assert.equal(result.backend, 'jira');
    assert.equal(result.source, 'project.md');
    assert.ok(
      result.warnings.some(warning => warning.includes("Unsupported task backend 'jira'")),
      `expected unsupported backend warning, got: ${JSON.stringify(result.warnings)}`
    );
  });
});
