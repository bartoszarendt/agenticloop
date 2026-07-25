/**
 * Direct filesystem mutation kernel tests (Phase 28 reopen).
 *
 * The kernel owns target-bound validation and rollback. These tests reproduce
 * every independently-confirmed defect and assert restored bytes and on-disk
 * structure — not just that rollbackErrors is an array.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import {
  assertSafeRelativePath,
  executeMutationBatch,
  executeRenameMutation,
  fingerprintTargetPath,
  resolveTargetPath,
} from '../src/fs-mutation-kernel.js';

const IS_WINDOWS = platform() === 'win32';

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-fs-kernel-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function target() {
  return mkdtempSync(join(tmpBase, 't-'));
}

describe('kernel path validation', () => {
  it('rejects drive-qualified paths', () => {
    assert.throws(() => assertSafeRelativePath('C:/escape'), /drive-qualified/);
    assert.throws(() => assertSafeRelativePath('c:\\escape'), /backslash/);
  });

  it('rejects absolute paths', () => {
    assert.throws(() => assertSafeRelativePath('/etc/passwd'), /absolute/);
    assert.throws(() => assertSafeRelativePath('/x'), /absolute/);
  });

  it('rejects dot segments', () => {
    assert.throws(() => assertSafeRelativePath('./x'), /dot\/empty\/traversal/);
    assert.throws(() => assertSafeRelativePath('x/./y'), /dot\/empty\/traversal/);
  });

  it('rejects traversal segments', () => {
    assert.throws(() => assertSafeRelativePath('../escape'), /dot\/empty\/traversal/);
    assert.throws(() => assertSafeRelativePath('a/../../b'), /dot\/empty\/traversal/);
    assert.throws(() => assertSafeRelativePath('a/..'), /dot\/empty\/traversal/);
  });

  it('rejects empty segments', () => {
    assert.throws(() => assertSafeRelativePath('a//b'), /dot\/empty\/traversal/);
    assert.throws(() => assertSafeRelativePath(''), /non-empty/);
  });

  it('rejects backslash paths', () => {
    assert.throws(() => assertSafeRelativePath('a\\b'), /backslash/);
  });

  it('rejects NUL bytes', () => {
    assert.throws(() => assertSafeRelativePath('a\0b'), /NUL/);
  });

  it('accepts safe relative paths', () => {
    assert.equal(assertSafeRelativePath('a/b/c.txt'), 'a/b/c.txt');
    assert.equal(assertSafeRelativePath('file.txt'), 'file.txt');
  });

  it('executeMutationBatch cannot write outside targetRoot', () => {
    const t = target();
    const outsideSentinel = join(tmpBase, 'outside-sentinel.txt');
    writeFileSync(outsideSentinel, 'sentinel', 'utf-8');
    // Even if a caller tries an absolute escape, the kernel rejects it.
    const result = executeMutationBatch(t, [
      { type: 'write', path: outsideSentinel, content: 'overwritten' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /unsafe planned path|escapes target|absolute/);
    assert.equal(readFileSync(outsideSentinel, 'utf-8'), 'sentinel');
    assert.equal(result.rollbackErrors.length, 0, 'validation failure must not attempt rollback');
  });

  it('executeMutationBatch rejects traversal to outside the target', () => {
    const t = target();
    const outsideSentinel = join(tmpBase, 'traversal-sentinel.txt');
    writeFileSync(outsideSentinel, 'sentinel', 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'write', path: '../traversal-sentinel.txt', content: 'overwritten' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /dot\/empty\/traversal/);
    assert.equal(readFileSync(outsideSentinel, 'utf-8'), 'sentinel');
  });
});

describe('symlink / junction escape rejection', () => {
  it('rejects a mutation whose path crosses a symlinked ancestor outside the target', () => {
    const t = target();
    const outside = mkdtempSync(join(tmpBase, 'escape-'));
    const linkTarget = join(t, 'link');
    symlinkSync(outside, linkTarget, IS_WINDOWS ? 'junction' : undefined);
    const result = executeMutationBatch(t, [
      { type: 'write', path: 'link/escaped.txt', content: 'escaped' },
    ]);
    assert.equal(result.ok, false, 'must reject symlink escape');
    assert.match(result.errors[0], /symlink|junction|escapes target/);
    assert.equal(existsSync(join(outside, 'escaped.txt')), false, 'must not write through the symlink');
  });

  it('resolveTargetPath rejects a symlinked ancestor', () => {
    const t = target();
    const outside = mkdtempSync(join(tmpBase, 'escape-resolve-'));
    const linkTarget = join(t, 'evil');
    symlinkSync(outside, linkTarget, IS_WINDOWS ? 'junction' : undefined);
    assert.throws(() => resolveTargetPath(t, 'evil/file.txt'), /symlink|junction/);
  });
});

describe('created-file rollback', () => {
  it('removes a created file on rollback with no residue', () => {
    const t = target();
    const result = executeMutationBatch(t, [
      { type: 'write', path: 'created.txt', content: 'new' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(t, 'created.txt')), false, 'created file must be removed on rollback');
    assert.deepEqual(readdirSync(t), [], 'no residue after successful rollback');
  });
});

describe('overwritten-file byte-for-byte restoration', () => {
  it('restores exact prior bytes after a failed overwrite', () => {
    const t = target();
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x0a, 0x0d, 0xe2, 0x9c, 0x93]);
    writeFileSync(join(t, 'binary.bin'), original);
    const result = executeMutationBatch(t, [
      { type: 'write', path: 'binary.bin', content: 'overwritten' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    const restored = readFileSync(join(t, 'binary.bin'));
    assert.deepEqual(restored, original, 'exact bytes must be restored');
  });

  it('restores text byte-for-byte including unicode and CRLF', () => {
    const t = target();
    const original = 'line1\r\nline2 — unicode ✓\r\n';
    writeFileSync(join(t, 'text.txt'), original, 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'write', path: 'text.txt', content: 'changed' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(t, 'text.txt'), 'utf-8'), original);
  });
});

describe('removed-file restoration', () => {
  it('restores a removed file on rollback', () => {
    const t = target();
    writeFileSync(join(t, 'preexisting.txt'), 'keep me', 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'remove', path: 'preexisting.txt' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(t, 'preexisting.txt')), true, 'removed file must be restored');
    assert.equal(readFileSync(join(t, 'preexisting.txt'), 'utf-8'), 'keep me');
  });
});

describe('created-directory cleanup', () => {
  it('removes a transaction-created directory on rollback (no false error)', () => {
    const t = target();
    const result = executeMutationBatch(t, [
      { type: 'mkdir', path: 'freshdir' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(t, 'freshdir')), false, 'created dir must be cleaned up');
    // A created-directory cleanup must not produce a spurious rollback error.
    assert.equal(result.rollbackErrors.length, 0, () => `unexpected rollback errors: ${result.rollbackErrors.join('; ')}`);
  });

  it('removes nested transaction-created directories on rollback', () => {
    const t = target();
    const result = executeMutationBatch(t, [
      { type: 'mkdir', path: 'a/b/c' },
      { type: 'write', path: 'a/b/c/file.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(t, 'a')), false, 'nested created dirs must be cleaned up recursively');
    assert.deepEqual(readdirSync(t), [], 'no residue');
  });

  it('never removes a pre-existing directory during mkdir rollback (defect 5)', () => {
    const t = target();
    mkdirSync(join(t, 'preexisting-dir'));
    // A planned mkdir over a pre-existing directory followed by an unrelated
    // failure must NOT report a rollback error and must leave the directory.
    const result = executeMutationBatch(t, [
      { type: 'mkdir', path: 'preexisting-dir' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(t, 'preexisting-dir')), true, 'pre-existing dir must remain');
    // The snapshot state for the pre-existing directory is 'directory'; rollback
    // leaves it alone and produces no spurious rollback error.
    assert.equal(result.rollbackErrors.filter(e => e.includes('preexisting-dir')).length, 0,
      'pre-existing mkdir target must not produce a rollback error');
  });
});

describe('directory-removal rejection', () => {
  it('rejects a direct directory-removal mutation so a tree cannot be lost (defect 4)', () => {
    const t = target();
    mkdirSync(join(t, 'tree', 'nested'), { recursive: true });
    writeFileSync(join(t, 'tree', 'nested', 'file.txt'), 'important', 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'remove', path: 'tree' },
    ]);
    assert.equal(result.ok, false, 'directory removal must be rejected');
    assert.match(result.errors[0], /directory-removal/);
    // The tree must be entirely intact.
    assert.equal(existsSync(join(t, 'tree', 'nested', 'file.txt')), true);
    assert.equal(readFileSync(join(t, 'tree', 'nested', 'file.txt'), 'utf-8'), 'important');
    assert.equal(result.rollbackErrors.length, 0, 'rejected mutation must not roll back');
  });

  it('removes an explicitly planned empty directory without recursive deletion', () => {
    const t = target();
    mkdirSync(join(t, 'stale-empty'), { recursive: true });
    const result = executeMutationBatch(t, [
      { type: 'rmdir-empty', path: 'stale-empty' },
    ]);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(existsSync(join(t, 'stale-empty')), false);
  });

  it('restores an empty directory when a later mutation in the batch fails', () => {
    const t = target();
    mkdirSync(join(t, 'stale-empty'), { recursive: true });
    const result = executeMutationBatch(t, [
      { type: 'rmdir-empty', path: 'stale-empty' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(t, 'stale-empty')), true, 'removed directory must be recreated');
    assert.deepEqual(readdirSync(join(t, 'stale-empty')), []);
    assert.deepEqual(result.rollbackErrors, []);
  });

  it('refuses an explicit empty-directory removal when the directory is non-empty', () => {
    const t = target();
    mkdirSync(join(t, 'not-empty'), { recursive: true });
    writeFileSync(join(t, 'not-empty', 'owned.txt'), 'preserve', 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'rmdir-empty', path: 'not-empty' },
    ]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /non-empty directory/);
    assert.equal(readFileSync(join(t, 'not-empty', 'owned.txt'), 'utf-8'), 'preserve');
  });
});

describe('transactional rename segments', () => {
  it('removes destination parents created before an injected rename failure', () => {
    const t = target();
    writeFileSync(join(t, 'legacy.txt'), 'legacy', 'utf-8');
    const result = executeRenameMutation(t, {
      from: 'legacy.txt',
      to: 'fresh/nested/current.txt',
      fromBaseHash: fingerprintTargetPath(t, 'legacy.txt'),
      toBaseHash: null,
    }, {
      rename: () => {
        const error = new Error('injected rename failure');
        error.code = 'EBUSY';
        throw error;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.errors[0], /EBUSY|injected rename failure/);
    assert.deepEqual(result.rollbackErrors, []);
    assert.equal(readFileSync(join(t, 'legacy.txt'), 'utf-8'), 'legacy');
    assert.equal(existsSync(join(t, 'fresh')), false, 'created destination parents must roll back');
  });
});

describe('primary errors versus rollback errors', () => {
  it('returns the primary failure separately from rollback failures', () => {
    const t = target();
    writeFileSync(join(t, 'victim.txt'), 'original', 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'write', path: 'victim.txt', content: 'changed' },
      { type: 'write', path: 'boom.txt', content: {} },
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, 'primary error must be present');
    // victim.txt was restorable, so rollbackErrors is clean here.
    assert.deepEqual(result.rollbackErrors, []);
    assert.equal(readFileSync(join(t, 'victim.txt'), 'utf-8'), 'original');
  });
});

describe('Windows EPERM behavior', { skip: !IS_WINDOWS }, () => {
  it('rolls back and reports EPERM on a read-only rename target', () => {
    const t = target();
    const protectedPath = join(t, 'protected.txt');
    writeFileSync(protectedPath, 'original', 'utf-8');
    chmodSync(protectedPath, 0o444);
    try {
      const result = executeMutationBatch(t, [
        { type: 'write', path: 'other.txt', content: 'other' },
        { type: 'write', path: 'protected.txt', content: 'updated' },
      ]);
      assert.equal(result.ok, false);
      assert.match(result.errors[0], /EPERM|operation not permitted/i);
      assert.equal(existsSync(join(t, 'other.txt')), false);
      assert.equal(readFileSync(protectedPath, 'utf-8'), 'original');
    } finally {
      chmodSync(protectedPath, 0o666);
    }
  });
});

describe('successful batch commits and cleans empty parents', () => {
  it('writes files and returns committed relative paths', () => {
    const t = target();
    const result = executeMutationBatch(t, [
      { type: 'write', path: 'a/b/file.txt', content: 'hello' },
      { type: 'mkdir', path: 'newdir' },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.writtenFiles, ['a/b/file.txt']);
    assert.ok(result.committedPaths.includes('a/b/file.txt'));
    assert.ok(result.committedPaths.includes('newdir'));
    assert.equal(readFileSync(join(t, 'a/b/file.txt'), 'utf-8'), 'hello');
    assert.equal(statSync(join(t, 'newdir')).isDirectory(), true);
  });

  it('removes a file and cleans up the resulting empty directory', () => {
    const t = target();
    mkdirSync(join(t, 'lonely'), { recursive: true });
    writeFileSync(join(t, 'lonely', 'file.txt'), 'x', 'utf-8');
    const result = executeMutationBatch(t, [
      { type: 'remove', path: 'lonely/file.txt' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(t, 'lonely')), false, 'empty parent must be cleaned');
  });
});
