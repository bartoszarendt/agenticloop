import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filePathIdentity, isAbsoluteOrDriveQualifiedPath, isPathOutside, isPathWithin, pathIdentity, samePathAuthority } from '../src/path-identity.js';

describe('portable path identity', () => {
  it('recognizes POSIX, Windows, and UNC absolute forms on every host', () => {
    for (const path of ['/repo/file', 'C:/repo/file', 'C:\\repo\\file', 'C:relative', '\\\\server\\share\\file', '\\rooted']) {
      assert.equal(isAbsoluteOrDriveQualifiedPath(path), true, path);
    }
    for (const path of ['evidence/file.json', 'nested/path', 'C']) {
      assert.equal(isAbsoluteOrDriveQualifiedPath(path), false, path);
    }
  });

  it('keeps POSIX authority case-sensitive and uses realpath only when a path exists', () => {
    const calls = [];
    const options = {
      platform: 'posix',
      exists: path => path === '/repo/link',
      realpath: path => { calls.push(path); return '/repo/real'; },
    };
    assert.deepEqual(pathIdentity('link', { ...options, base: '/repo' }), {
      displayPath: '/repo/link', authorityPath: '/repo/real',
    });
    assert.equal(pathIdentity('/repo/Mixed', options).authorityPath, '/repo/Mixed');
    assert.equal(samePathAuthority('/repo/Mixed', '/repo/mixed', options), false);
    assert.deepEqual(calls, ['/repo/link']);
  });

  it('normalizes Windows drives, separators, and case while preserving display spelling', () => {
    const options = { platform: 'win32', exists: () => false };
    const identity = pathIdentity('PROJECT\\Sub', { ...options, base: 'C:\\Repo' });
    assert.deepEqual(identity, {
      displayPath: 'C:\\Repo\\PROJECT\\Sub',
      authorityPath: 'c:/repo/project/sub',
    });
    assert.equal(samePathAuthority('C:\\Repo\\PROJECT', 'c:/repo/project', options), true);
    assert.equal(filePathIdentity('C:\\Repo\\PROJECT', options), 'file:c:/repo/project');
  });

  it('uses canonical authority identity for external-root confinement', () => {
    const options = {
      platform: 'posix',
      exists: path => path === '/operator-link',
      realpath: path => path === '/operator-link' ? '/target/private' : path,
    };
    assert.equal(isPathOutside('/operator-link', '/target', options), false);
    assert.equal(isPathOutside('/operator-missing', '/target', options), true, 'nonexistent roots use their resolved lexical identity until materialized');
  });

  for (const { name, root, options } of [
    { name: 'POSIX', root: '/repo', options: { platform: 'posix', exists: () => false } },
    { name: 'injected Windows', root: 'C:\\repo', options: { platform: 'win32', exists: () => false } },
  ]) {
    it(`treats ${name} ..safe paths as inside without weakening parent-traversal rejection`, () => {
      const identityOptions = { ...options, base: root };
      assert.equal(isPathWithin('..safe/file', root, identityOptions), true);
      assert.equal(isPathOutside('..safe/file', root, identityOptions), false);
      assert.equal(isPathWithin('../outside', root, identityOptions), false);
      assert.equal(isPathOutside('../outside', root, identityOptions), true);
    });
  }
});
