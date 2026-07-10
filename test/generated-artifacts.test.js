/**
 * Tests for src/generated-artifacts.js — ownership manifest.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyDirectory,
  classifyFile,
  createManifest,
  GENERATED_ARTIFACTS_SCHEMA_VERSION,
  getEntriesForAdapter,
  getEntriesForPath,
  getEntryForPath,
  getOrCreateManifest,
  hashContent,
  hashFile,
  loadManifest,
  recordDirectoryArtifact,
  recordEntry,
  recordFileArtifact,
  recordSharedConfigArtifact,
  removeEntriesForAdapter,
  removeEntry,
  removeManifestIfEmpty,
  saveManifest,
} from '../src/generated-artifacts.js';

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-manifest-test-'));
});
after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});
function makeTarget() {
  return mkdtempSync(join(tmpBase, 'target-'));
}

// ---------------------------------------------------------------------------
// Schema and basic I/O
// ---------------------------------------------------------------------------

describe('generated-artifacts: schema and I/O', () => {
  it('createManifest produces a valid blank manifest with real package version', () => {
    const m = createManifest();
    assert.equal(m.schemaVersion, GENERATED_ARTIFACTS_SCHEMA_VERSION);
    // Default version comes from package.json (0.1.0), not '0.0.0'
    assert.equal(m.packageVersion, '0.1.0');
    assert.deepEqual(m.entries, []);
  });

  it('createManifest accepts explicit version', () => {
    const m = createManifest('1.0.0');
    assert.equal(m.schemaVersion, GENERATED_ARTIFACTS_SCHEMA_VERSION);
    assert.equal(m.packageVersion, '1.0.0');
    assert.deepEqual(m.entries, []);
  });

  it('loadManifest returns null for nonexistent file', () => {
    const t = makeTarget();
    assert.equal(loadManifest(t), null);
  });

  it('saveManifest and loadManifest roundtrip', () => {
    const t = makeTarget();
    const m = createManifest('0.1.0');
    saveManifest(t, m);
    const loaded = loadManifest(t);
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, GENERATED_ARTIFACTS_SCHEMA_VERSION);
    assert.equal(loaded.packageVersion, '0.1.0');
    assert.deepEqual(loaded.entries, []);
  });

  it('loadManifest throws on malformed JSON', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.agenticloop'), { recursive: true });
    writeFileSync(join(t, '.agenticloop', 'generated-artifacts.json'), 'not json');
    assert.throws(() => loadManifest(t), /malformed JSON/);
  });

  it('loadManifest throws on invalid schemaVersion', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.agenticloop'), { recursive: true });
    writeFileSync(
      join(t, '.agenticloop', 'generated-artifacts.json'),
      JSON.stringify({ schemaVersion: 'wrong', entries: [] })
    );
    assert.throws(() => loadManifest(t), /invalid or missing schemaVersion/);
  });

  it('loadManifest throws on unsupported schema version', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.agenticloop'), { recursive: true });
    writeFileSync(
      join(t, '.agenticloop', 'generated-artifacts.json'),
      JSON.stringify({ schemaVersion: 99, entries: [] })
    );
    assert.throws(() => loadManifest(t), /unsupported schemaVersion 99/);
  });

  it('loadManifest migrates schema v1 to v2', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.agenticloop'), { recursive: true });
    writeFileSync(
      join(t, '.agenticloop', 'generated-artifacts.json'),
      JSON.stringify({
        schemaVersion: 1,
        packageVersion: '0.1.0',
        entries: [
          { adapter: 'opencode', outputRoot: '.', relPath: 'a.txt', kind: 'file', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', existence: 'created', generatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      })
    );
    const loaded = loadManifest(t);
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, GENERATED_ARTIFACTS_SCHEMA_VERSION);
    assert.equal(loaded.entries.length, 1);
  });

  it('getOrCreateManifest creates when missing', () => {
    const t = makeTarget();
    const m = getOrCreateManifest(t, '2.0.0');
    assert.equal(m.schemaVersion, GENERATED_ARTIFACTS_SCHEMA_VERSION);
    assert.equal(m.packageVersion, '2.0.0');
  });

  it('removeManifestIfEmpty deletes when entries is empty', () => {
    const t = makeTarget();
    saveManifest(t, createManifest('1.0.0'));
    removeManifestIfEmpty(t);
    assert.equal(loadManifest(t), null);
  });

  it('removeManifestIfEmpty preserves when entries remain', () => {
    const t = makeTarget();
    const m = createManifest('1.0.0');
    m.entries.push({
      adapter: 'opencode',
      outputRoot: '.',
      relPath: 'foo.txt',
      kind: 'file',
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      existence: 'created',
      generatedAt: new Date().toISOString(),
    });
    saveManifest(t, m);
    removeManifestIfEmpty(t);
    assert.ok(loadManifest(t));
  });
});
// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe('generated-artifacts: hashing', () => {
  it('hashFile returns consistent hex digest', () => {
    const t = makeTarget();
    const path = join(t, 'test.txt');
    writeFileSync(path, 'hello world');
    const h1 = hashFile(path);
    const h2 = hashFile(path);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('hashContent returns consistent hex digest', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('hashFile matches hashContent for same text', () => {
    const t = makeTarget();
    const path = join(t, 'test.txt');
    const text = 'hello world';
    writeFileSync(path, text);
    assert.equal(hashFile(path), hashContent(text));
  });
});

// ---------------------------------------------------------------------------
// Record file artifacts
// ---------------------------------------------------------------------------

describe('generated-artifacts: recordFileArtifact', () => {
  it('records a new file with correct hash and existence', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });

    // Record before writing (existence = created)
    const { entry } = recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orchestrator.md',
      outputRoot: '.',
      marker: '<!-- Generated -->',
    });

    assert.equal(entry.adapter, 'opencode');
    assert.equal(entry.relPath, '.opencode/agents/orchestrator.md');
    assert.equal(entry.kind, 'file');
    assert.equal(entry.marker, '<!-- Generated -->');
    // File does not exist yet, so the compatibility recorder uses the intended empty content hash.
    assert.equal(entry.existence, 'created');
    assert.equal(entry.hash, hashContent(''));

    const loaded = loadManifest(t);
    assert.equal(loaded.entries.length, 1);
  });

  it('records merged existence for pre-existing file', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'orchestrator.md'), '# Pre-existing');

    const { entry } = recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orchestrator.md',
      outputRoot: '.',
    });

    assert.equal(entry.existence, 'merged');
  });

  it('replaces existing entry for same path', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'orchestrator.md'), '# V1');

    recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orchestrator.md',
      outputRoot: '.',
    });

    writeFileSync(join(t, '.opencode', 'agents', 'orchestrator.md'), '# V2');
    recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orchestrator.md',
      outputRoot: '.',
    });

    const loaded = loadManifest(t);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].hash, hashContent('# V2'));
  });

  it('rejects absolute paths', () => {
    const t = makeTarget();
    assert.throws(
      () => recordFileArtifact(t, {
        adapter: 'opencode',
        relPath: '/absolute/path.txt',
        outputRoot: '.',
      }),
      /Absolute path not allowed/
    );
  });

  it('rejects path traversal', () => {
    const t = makeTarget();
    assert.throws(
      () => recordFileArtifact(t, {
        adapter: 'opencode',
        relPath: '../outside.txt',
        outputRoot: '.',
      }),
      /Path traversal not allowed/
    );
  });

  it('rejects backslash paths', () => {
    const t = makeTarget();
    assert.throws(
      () => recordFileArtifact(t, {
        adapter: 'opencode',
        relPath: '.opencode\\agents\\test.md',
        outputRoot: '.',
      }),
      /forward slashes/
    );
  });

  it('rejects missing adapter', () => {
    const t = makeTarget();
    assert.throws(
      () => recordFileArtifact(t, {
        relPath: 'test.txt',
        outputRoot: '.',
      }),
      /requires a non-empty supported adapter/
    );
  });

  it('records hash when file exists at record time', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'orchestrator.md'), '# Orchestrator');

    const { entry } = recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orchestrator.md',
      outputRoot: '.',
      marker: '<!-- Generated -->',
    });

    assert.ok(entry.hash);
    assert.equal(entry.existence, 'merged');
  });
});

// ---------------------------------------------------------------------------
// Record shared-config artifacts
// ---------------------------------------------------------------------------

describe('generated-artifacts: recordSharedConfigArtifact', () => {
  it('records a shared-config entry with key', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.claude'), { recursive: true });
    writeFileSync(
      join(t, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npx agenticloop *)'] } }, null, 2)
    );

    const { entry } = recordSharedConfigArtifact(t, {
      adapter: 'claude-code',
      relPath: '.claude/settings.local.json',
      outputRoot: '.',
      sharedConfigKey: 'permissions.allow',
      createdFile: true,
    });

    assert.equal(entry.kind, 'shared-config');
    assert.equal(entry.sharedConfigKey, 'permissions.allow');
    assert.equal(entry.createdFile, true);
  });

  it('allows multiple shared-config entries for same file', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.claude'), { recursive: true });
    writeFileSync(join(t, '.claude', 'settings.json'), '{}');

    recordSharedConfigArtifact(t, {
      adapter: 'claude-code',
      relPath: '.claude/settings.json',
      outputRoot: '.',
      sharedConfigKey: 'permissions.allow',
      createdFile: false,
    });

    recordSharedConfigArtifact(t, {
      adapter: 'claude-code',
      relPath: '.claude/settings.json',
      outputRoot: '.',
      sharedConfigKey: 'defaultMode',
      createdFile: false,
    });

    const loaded = loadManifest(t);
    const entries = getEntriesForPath(loaded, '.claude/settings.json');
    assert.equal(entries.length, 2);
  });

  it('replaces existing entry for same path+key combination', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.claude'), { recursive: true });
    writeFileSync(join(t, '.claude', 'settings.json'), '{}');

    recordSharedConfigArtifact(t, {
      adapter: 'claude-code',
      relPath: '.claude/settings.json',
      outputRoot: '.',
      sharedConfigKey: 'permissions',
      createdFile: true,
    });

    recordSharedConfigArtifact(t, {
      adapter: 'claude-code',
      relPath: '.claude/settings.json',
      outputRoot: '.',
      sharedConfigKey: 'permissions',
      createdFile: false,
    });

    const loaded = loadManifest(t);
    const entries = getEntriesForPath(loaded, '.claude/settings.json');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].createdFile, false);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('generated-artifacts: queries', () => {
  it('getEntriesForAdapter filters by adapter', () => {
    const m = createManifest('1.0.0');
    m.entries.push({
      adapter: 'opencode', outputRoot: '.', relPath: 'a.txt', kind: 'file',
      existence: 'created', generatedAt: new Date().toISOString(),
    });
    m.entries.push({
      adapter: 'codex', outputRoot: '.', relPath: 'b.txt', kind: 'file',
      existence: 'created', generatedAt: new Date().toISOString(),
    });

    assert.equal(getEntriesForAdapter(m, 'opencode').length, 1);
    assert.equal(getEntriesForAdapter(m, 'codex').length, 1);
    assert.equal(getEntriesForAdapter(m, 'cursor').length, 0);
  });

  it('getEntryForPath returns matching entry', () => {
    const m = createManifest('1.0.0');
    m.entries.push({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/test.md', kind: 'file',
      existence: 'created', generatedAt: new Date().toISOString(),
    });

    const entry = getEntryForPath(m, '.opencode/agents/test.md');
    assert.ok(entry);
    assert.equal(entry.adapter, 'opencode');

    assert.equal(getEntryForPath(m, 'nonexistent'), undefined);
  });

  it('getEntriesForPath returns all entries for path', () => {
    const m = createManifest('1.0.0');
    m.entries.push({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json', kind: 'shared-config',
      sharedConfigKey: 'permissions', existence: 'created', generatedAt: new Date().toISOString(),
    });
    m.entries.push({
      adapter: 'claude-code', outputRoot: '.', relPath: '.claude/settings.json', kind: 'shared-config',
      sharedConfigKey: 'defaultMode', existence: 'created', generatedAt: new Date().toISOString(),
    });

    assert.equal(getEntriesForPath(m, '.claude/settings.json').length, 2);
  });
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

describe('generated-artifacts: removal', () => {
  it('removeEntry removes entry and saves', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'test.md'), '# Test');
    recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/test.md',
      outputRoot: '.',
    });

    const removed = removeEntry(t, '.opencode/agents/test.md');
    assert.equal(removed.length, 1);
    assert.equal(loadManifest(t), null); // empty manifest file is deleted
  });

  it('removeEntriesForAdapter removes all adapter entries', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'a.md'), '# A');
    writeFileSync(join(t, '.opencode', 'agents', 'b.md'), '# B');

    recordFileArtifact(t, {
      adapter: 'opencode', relPath: '.opencode/agents/a.md', outputRoot: '.',
    });
    recordFileArtifact(t, {
      adapter: 'opencode', relPath: '.opencode/agents/b.md', outputRoot: '.',
    });
    recordFileArtifact(t, {
      adapter: 'codex', relPath: '.codex/agents/test.toml', outputRoot: '.',
    });

    const removed = removeEntriesForAdapter(t, 'opencode');
    assert.equal(removed.length, 2);

    const remaining = loadManifest(t);
    assert.equal(remaining.entries.length, 1);
    assert.equal(remaining.entries[0].adapter, 'codex');
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('generated-artifacts: classifyFile', () => {
  it('classifies exact-owned file when hash matches', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'orch.md'), '# Orchestrator');

    recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orch.md',
      outputRoot: '.',
    });

    const cls = classifyFile(t, '.opencode/agents/orch.md');
    assert.equal(cls.status, 'exact-owned');
  });

  it('classifies owned-modified when hash differs', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'orch.md'), '# V1');

    recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orch.md',
      outputRoot: '.',
    });

    writeFileSync(join(t, '.opencode', 'agents', 'orch.md'), '# Modified');

    const cls = classifyFile(t, '.opencode/agents/orch.md');
    assert.equal(cls.status, 'owned-modified');
    assert.ok(cls.currentHash !== cls.expectedHash);
  });

  it('classifies unrecognized when no entry exists', () => {
    const t = makeTarget();
    saveManifest(t, createManifest('1.0.0'));
    mkdirSync(join(t, 'user-file'), { recursive: true });
    writeFileSync(join(t, 'user-file', 'readme.md'), '# User');

    const cls = classifyFile(t, 'user-file/readme.md');
    assert.equal(cls.status, 'unrecognized');
  });

  it('classifies manifest-missing when no manifest', () => {
    const t = makeTarget();
    const cls = classifyFile(t, 'nonexistent.txt');
    assert.equal(cls.status, 'manifest-missing');
  });

  it('classifies exact-owned for missing file that is recorded', () => {
    const t = makeTarget();
    mkdirSync(join(t, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(t, '.opencode', 'agents', 'orch.md'), '# Orch');
    recordFileArtifact(t, {
      adapter: 'opencode',
      relPath: '.opencode/agents/orch.md',
      outputRoot: '.',
    });
    rmSync(join(t, '.opencode', 'agents', 'orch.md'));

    const cls = classifyFile(t, '.opencode/agents/orch.md');
    assert.equal(cls.status, 'exact-owned');
    assert.match(cls.message, /missing from disk/);
  });

  it('classifies file without hash as exact-owned', () => {
    const t = makeTarget();
    const m = createManifest('1.0.0');
    m.entries.push({
        adapter: 'opencode', outputRoot: '.', relPath: 'test.txt', kind: 'file',
        hash: hashContent('content'),
      existence: 'created', generatedAt: new Date().toISOString(),
    });
    saveManifest(t, m);
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'test.txt'), 'content');

    const cls = classifyFile(t, 'test.txt');
    assert.equal(cls.status, 'exact-owned');
  });
});
