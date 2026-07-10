/**
 * Schema-v3 validation strictness tests.
 *
 * Covers:
 *   - Unknown keys rejected at manifest and entry level
 *   - Kind-specific entry field validation
 *   - replace-array-element requires matchKey/matchValue
 *   - createdContainers validated as JSON pointer array
 *   - generatedAt validated
 *   - packageVersion must be non-empty string
 *   - entries must be array before migration
 *   - Hostile relPath/outputRoot values rejected
 *   - Malformed legacy documents handled
 *   - Kind-inappropriate fields rejected
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  validateManifestEntry,
  createManifest,
  createFileEntry,
  createSharedConfigEntry,
  createGitignoreEntry,
} from '../src/generated-artifacts.js';

describe('schema-v3 validation strictness', () => {
  it('rejects unknown top-level manifest keys', () => {
    const manifest = createManifest('test');
    manifest.unknownField = 'bad';
    assert.throws(() => validateManifest(manifest), /unknown key/);
  });

  it('rejects unknown entry keys', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: new Date().toISOString(), bogus: true,
    }), /unknown key/);
  });

  it('rejects replace-array-element without matchKey', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'replace-array-element', pointer: '/permissions/allow', value: 'test', added: true, matchValue: 'x' }],
    }), /matchKey/);
  });

  it('rejects replace-array-element without matchValue', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'replace-array-element', pointer: '/permissions/allow', value: 'test', added: true, matchKey: 'name' }],
    }), /matchValue/);
  });

  it('rejects createdContainers that are not an array', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test', added: true, createdContainers: 'bad' }],
    }), /createdContainers/);
  });

  it('rejects createdContainers with invalid JSON pointers', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test', added: true, createdContainers: ['not-a-pointer'] }],
    }), /createdContainers/);
  });

  it('rejects invalid generatedAt', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: 'not-a-date',
    }), /generatedAt/);
  });

  it('rejects empty packageVersion', () => {
    const manifest = createManifest('test');
    manifest.packageVersion = '';
    assert.throws(() => validateManifest(manifest), /packageVersion/);
  });

  it('rejects hostile relPath with path traversal', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '../../../etc/passwd',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: new Date().toISOString(),
    }), /traversal/);
  });

  it('rejects hostile outputRoot with absolute path', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '/etc', relPath: 'test.md',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: new Date().toISOString(),
    }), /Absolute/);
  });

  it('accepts valid entries', () => {
    const entry = validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: new Date().toISOString(),
    });
    assert.equal(entry.adapter, 'opencode');
    assert.equal(entry.kind, 'file');
  });

  it('accepts valid shared-config entry with mutations', () => {
    const entry = validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test', added: true }],
      createdFile: false,
    });
    assert.equal(entry.kind, 'shared-config');
    assert.equal(entry.mutations.length, 1);
  });

  it('accepts valid gitignore-line entry', () => {
    const entry = validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.gitignore',
      kind: 'gitignore-line', existence: 'merged',
      generatedAt: new Date().toISOString(),
      line: '.agenticloop/tmp/', occurrence: 0, createdFile: false,
    });
    assert.equal(entry.kind, 'gitignore-line');
  });

  it('accepts ambiguity only on gitignore ownership', () => {
    const entry = validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.gitignore', kind: 'gitignore-line',
      existence: 'merged', generatedAt: new Date().toISOString(), line: '.agenticloop/tmp/',
      occurrence: 0, createdFile: true, ambiguous: true,
    });
    assert.equal(entry.ambiguous, true);
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md', kind: 'file',
      hash: 'a'.repeat(64), existence: 'created', generatedAt: new Date().toISOString(), ambiguous: true,
    }), /unknown key/);
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.gitignore', kind: 'gitignore-line',
      existence: 'merged', generatedAt: new Date().toISOString(), line: '.agenticloop/tmp/',
      occurrence: 0, createdFile: true, ambiguous: 'yes',
    }), /ambiguous/);
  });

  it('rejects duplicate entry identities', () => {
    const manifest = createManifest('test');
    manifest.entries = [
      { adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md', kind: 'file', hash: 'a'.repeat(64), existence: 'created', generatedAt: new Date().toISOString() },
      { adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md', kind: 'file', hash: 'b'.repeat(64), existence: 'created', generatedAt: new Date().toISOString() },
    ];
    assert.throws(() => validateManifest(manifest), /duplicate/);
  });

  // Kind-specific schema validation (Defect 16)

  it('rejects file entry with mutation fields', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: '/test', value: 'x', added: true }],
    }), /unknown key|mutations/);
  });

  it('rejects file entry with gitignore fields', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md',
      kind: 'file', hash: 'a'.repeat(64), existence: 'created',
      generatedAt: new Date().toISOString(),
      line: '.agenticloop/tmp/', occurrence: 0,
    }), /unknown key/);
  });

  it('rejects shared-config entry with file-only hash field', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: '/test', value: 'x', added: true }],
      hash: 'a'.repeat(64),
    }), /unknown key/);
  });

  it('rejects shared-config entry with gitignore fields', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [],
      line: '.agenticloop/tmp/',
    }), /unknown key/);
  });

  it('rejects gitignore-line entry with mutation fields', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.gitignore',
      kind: 'gitignore-line', existence: 'merged',
      generatedAt: new Date().toISOString(),
      line: '.agenticloop/tmp/', occurrence: 0, createdFile: false,
      mutations: [{ op: 'array-add', pointer: '/test', value: 'x', added: true }],
    }), /unknown key/);
  });

  it('rejects gitignore-line entry with hash field', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.gitignore',
      kind: 'gitignore-line', existence: 'merged',
      generatedAt: new Date().toISOString(),
      line: '.agenticloop/tmp/', occurrence: 0, createdFile: false,
      hash: 'a'.repeat(64),
    }), /unknown key/);
  });

  it('rejects array-add mutation with matchKey field', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test', added: true, matchKey: 'name' }],
    }), /matchKey is not valid for array-add/);
  });

  it('rejects set-if-absent mutation with matchKey field', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'set-if-absent', pointer: '/name', value: 'test', added: true, matchKey: 'name' }],
    }), /matchKey is not valid for set-if-absent/);
  });

  it('rejects replace-array-element mutation with invalid matchKey', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'replace-array-element', pointer: '/plugins', value: {}, added: true, matchKey: '', matchValue: 'x' }],
    }), /matchKey/);
  });

  it('requires createdFile for gitignore-line entries', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.gitignore',
      kind: 'gitignore-line', existence: 'merged',
      generatedAt: new Date().toISOString(),
      line: '.agenticloop/tmp/', occurrence: 0,
    }), /createdFile/);
  });

  it('requires createdFile to be boolean for shared-config entries', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [],
      createdFile: 'yes',
    }), /createdFile/);
  });

  it('validates JSON pointer format in mutation.pointer', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json',
      kind: 'shared-config', existence: 'merged',
      generatedAt: new Date().toISOString(),
      mutations: [{ op: 'array-add', pointer: 'no-leading-slash', value: 'test', added: true }],
    }), /pointer/);
  });
});
