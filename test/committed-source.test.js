import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validateCommittedSourcePath,
  verifyCommittedAttributedSource,
} from '../src/committed-source.js';
import { git, initTestGitRepository } from './helpers/git-fixture.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-committed-source-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function fixture(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  initTestGitRepository(root, {
    userName: 'Agentic Loop Test',
    userEmail: 'loop@example.test',
  });
  writeFileSync(join(root, 'README.md'), 'fixture\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

function commitSource(root, relPath, content, message) {
  mkdirSync(join(root, relPath, '..'), { recursive: true });
  writeFileSync(join(root, relPath), content, 'utf8');
  git(root, ['add', relPath]);
  git(root, ['commit', '-m', message]);
}

describe('committed attributed source verification', () => {
  it('accepts only canonical repository-relative source paths', () => {
    assert.deepEqual(validateCommittedSourcePath('evidence/dependencies.json'), {
      ok: true,
      path: 'evidence/dependencies.json',
    });
    const absolute = isAbsolute('C:/outside.json') ? 'C:/outside.json' : '/outside.json';
    for (const path of [
      '', absolute, '/outside.json', '../outside.json', 'evidence/../outside.json',
      './evidence.json', 'evidence//dependencies.json', 'evidence\\dependencies.json',
      'evidence/',
    ]) {
      assert.equal(validateCommittedSourcePath(path).ok, false, path);
    }
  });

  it('distinguishes missing, untracked, modified, deleted, and misattributed sources', () => {
    const root = fixture('states');
    const missing = verifyCommittedAttributedSource(root, 'evidence/missing.json', { taskId: 'T-001' });
    assert.equal(missing.evidenceState, 'missing');

    mkdirSync(join(root, 'evidence'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'untracked.json'), '{}\n', 'utf8');
    const untracked = verifyCommittedAttributedSource(root, 'evidence/untracked.json', { taskId: 'T-001' });
    assert.equal(untracked.evidenceState, 'missing');

    commitSource(root, 'evidence/wrong.json', '{}\n', 'wrong attribution');
    const wrong = verifyCommittedAttributedSource(root, 'evidence/wrong.json', { taskId: 'T-001' });
    assert.equal(wrong.evidenceState, 'malformed');
    assert.match(wrong.error, /Maintainer attribution/);

    commitSource(
      root,
      'evidence/dependencies.json',
      '{"statuses":{}}\n',
      'record evidence\n\nTask: T-001\nAgent: maintainer'
    );
    const current = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(current.ok, true);
    assert.equal(current.source, '{"statuses":{}}\n');
    assert.equal(current.provenance.path, 'evidence/dependencies.json');
    assert.match(current.provenance.blob, /^[a-f0-9]{40,64}$/);
    assert.match(current.provenance.commit, /^[a-f0-9]{40,64}$/);
    assert.equal(current.provenance.role, 'maintainer');

    writeFileSync(join(root, 'evidence', 'dependencies.json'), '{"statuses":{"T-002":"blocked"}}\n', 'utf8');
    const modified = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(modified.evidenceState, 'changed');

    unlinkSync(join(root, 'evidence', 'dependencies.json'));
    const deleted = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(deleted.evidenceState, 'missing');
  });

  it('detects source replacement after an earlier successful verification', () => {
    const root = fixture('replacement');
    commitSource(
      root,
      'evidence/dependencies.json',
      '{"statuses":{}}\n',
      'record evidence\n\nTask: T-001\nAgent: maintainer'
    );
    const prepared = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(prepared.ok, true);
    writeFileSync(join(root, 'evidence', 'dependencies.json'), '{"statuses":{"T-999":"ready"}}\n', 'utf8');
    const revalidated = verifyCommittedAttributedSource(root, 'evidence/dependencies.json', { taskId: 'T-001' });
    assert.equal(revalidated.ok, false);
    assert.equal(revalidated.evidenceState, 'changed');
  });

  it('rejects symbolic-link substitution when the platform permits creating the fixture', t => {
    const root = fixture('symlink');
    commitSource(
      root,
      'evidence/target.json',
      '{}\n',
      'record target\n\nTask: T-001\nAgent: maintainer'
    );
    try {
      symlinkSync(join(root, 'evidence', 'target.json'), join(root, 'evidence', 'alias.json'), 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`symbolic links unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const checked = verifyCommittedAttributedSource(root, 'evidence/alias.json', { taskId: 'T-001' });
    assert.equal(checked.evidenceState, 'malformed');
    assert.match(checked.error, /symbolic link/);
  });
});
