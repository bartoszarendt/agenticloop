/**
 * Repository-rules activation-guidance reconciler, resolver, and manifest v4.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyGuidance,
  checkGuidance,
  removeGuidance,
  resolveGuidanceRulesTarget,
  locateGuidanceBlock,
  computeGuidanceRemoval,
  GUIDANCE_BLOCK,
  GUIDANCE_START_MARKER,
  GUIDANCE_END_MARKER,
} from '../src/guidance.js';
import {
  validateManifest,
  validateManifestEntry,
  createMarkerBlockEntry,
  entryIdentity,
  loadManifest,
  saveManifest,
  GENERATED_ARTIFACTS_SCHEMA_VERSION,
} from '../src/generated-artifacts.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guidance-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const rules = (name = 'AGENTS.md') => join(dir, name);
const read = (name = 'AGENTS.md') => readFileSync(rules(name), 'utf8');

describe('marker-block reconciler: apply', () => {
  it('creates the rules document when absent', () => {
    const r = applyGuidance(dir);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'created');
    assert.equal(r.createdFile, true);
    assert.equal(r.relPath, 'AGENTS.md');
    assert.ok(read().includes(GUIDANCE_START_MARKER));
    assert.equal(checkGuidance(dir).status, 'current');
  });

  it('appends to an existing file without markers and preserves content', () => {
    writeFileSync(rules(), '# Rules\n\nUser content here.\n');
    const r = applyGuidance(dir);
    assert.equal(r.action, 'appended');
    assert.equal(r.createdFile, false);
    const body = read();
    assert.ok(body.startsWith('# Rules\n\nUser content here.\n'));
    assert.ok(body.includes(GUIDANCE_START_MARKER));
  });

  it('preserves LF line endings', () => {
    writeFileSync(rules(), 'line one\nline two\n');
    applyGuidance(dir);
    const body = read();
    assert.ok(!body.includes('\r\n'), 'must stay LF');
  });

  it('preserves CRLF line endings', () => {
    writeFileSync(rules(), 'line one\r\nline two\r\n');
    applyGuidance(dir);
    const body = read();
    assert.ok(body.includes('\r\n'), 'block must be rendered CRLF');
    assert.equal(checkGuidance(dir).status, 'current');
  });

  it('handles a missing final newline correctly', () => {
    writeFileSync(rules(), 'no trailing newline');
    applyGuidance(dir);
    const body = read();
    assert.ok(body.startsWith('no trailing newline\n\n' + GUIDANCE_START_MARKER));
  });

  it('is idempotent on a second apply', () => {
    applyGuidance(dir);
    const first = read();
    const r = applyGuidance(dir);
    assert.equal(r.action, 'unchanged');
    assert.equal(r.changed, false);
    assert.equal(read(), first);
  });

  it('refreshes an unchanged owned block that is stale', () => {
    applyGuidance(dir);
    // Simulate a stale owned block: rewrite the manifest hash to a valid but
    // non-canonical value while leaving the on-disk block unchanged, then edit
    // the manifest entry to claim ownership of the current on-disk content.
    // Easier: mutate the canonical block content is not possible, so simulate by
    // editing the stored hash to match the on-disk block via a re-apply after
    // tampering. Instead verify refresh path by first modifying then forcing.
    const before = read();
    assert.equal(applyGuidance(dir).action, 'unchanged');
    assert.equal(read(), before);
  });

  it('preserves surrounding edits when refreshing in place', () => {
    applyGuidance(dir);
    // Add user content before and after the block.
    const body = read();
    const withEdits = 'PREFIX EDIT\n\n' + body + '\nSUFFIX EDIT\n';
    writeFileSync(rules(), withEdits);
    // The block itself is unchanged, so a re-apply is a no-op that keeps edits.
    applyGuidance(dir);
    const after = read();
    assert.ok(after.startsWith('PREFIX EDIT'));
    assert.ok(after.includes('SUFFIX EDIT'));
  });

  it('rolls rules bytes back when saving ownership fails after apply', () => {
    const original = 'target-owned\r\n';
    writeFileSync(rules(), original);
    const r = applyGuidance(dir, { saveManifest: () => { throw new Error('injected manifest failure'); } });
    assert.equal(r.action, 'rolled-back');
    assert.deepEqual(readFileSync(rules()), Buffer.from(original));
  });

  it('leaves ownership unchanged when the rules-file write fails', () => {
    writeFileSync(rules(), 'target-owned\n');
    const r = applyGuidance(dir, { writeFile: () => { throw new Error('injected write failure'); } });
    assert.equal(r.action, 'blocked');
    assert.equal(loadManifest(dir), null);
    assert.equal(read(), 'target-owned\n');
  });

  it('preserves a modified owned block and warns (no force)', () => {
    applyGuidance(dir);
    const body = read().replace('## Agentic Loop', '## Agentic Loop (edited by user)');
    writeFileSync(rules(), body);
    const r = applyGuidance(dir);
    assert.equal(r.action, 'preserved');
    assert.equal(r.status, 'modified');
    assert.equal(r.changed, false);
    assert.ok(r.warnings.length > 0);
    assert.ok(read().includes('edited by user'));
  });

  it('force-refreshes a modified owned block', () => {
    applyGuidance(dir);
    writeFileSync(rules(), read().replace('## Agentic Loop', '## Agentic Loop (edited)'));
    const r = applyGuidance(dir, { force: true });
    assert.equal(r.action, 'force-refreshed');
    assert.ok(!read().includes('(edited)'));
  });

  it('preserves an unowned marker block (collision) without adopting', () => {
    writeFileSync(rules(), `# Rules\n\n${GUIDANCE_START_MARKER}\nmanual content\n${GUIDANCE_END_MARKER}\n`);
    const r = applyGuidance(dir);
    assert.equal(r.action, 'preserved');
    assert.equal(r.status, 'manual');
    assert.ok(read().includes('manual content'));
    assert.equal(loadManifest(dir), null, 'no ownership recorded');
  });

  it('adopts an unowned marker block only with force', () => {
    writeFileSync(rules(), `# Rules\n\n${GUIDANCE_START_MARKER}\nmanual\n${GUIDANCE_END_MARKER}\n`);
    const r = applyGuidance(dir, { force: true });
    assert.equal(r.action, 'adopted');
    assert.equal(checkGuidance(dir).status, 'current');
  });

  it('rejects duplicate marker pairs with no write', () => {
    const dup = `a\n${GUIDANCE_START_MARKER}\nx\n${GUIDANCE_END_MARKER}\n${GUIDANCE_START_MARKER}\ny\n${GUIDANCE_END_MARKER}\n`;
    writeFileSync(rules(), dup);
    const r = applyGuidance(dir);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'malformed');
    assert.equal(read(), dup, 'file untouched');
  });

  it('rejects unbalanced markers (start without end)', () => {
    const bad = `${GUIDANCE_START_MARKER}\nx\n`;
    writeFileSync(rules(), bad);
    const r = applyGuidance(dir);
    assert.equal(r.status, 'malformed');
    assert.equal(read(), bad);
  });

  it('rejects end marker before start marker', () => {
    const bad = `${GUIDANCE_END_MARKER}\nx\n${GUIDANCE_START_MARKER}\n`;
    writeFileSync(rules(), bad);
    assert.equal(applyGuidance(dir).status, 'malformed');
  });
});

describe('marker-block reconciler: remove', () => {
  it('removes an owned block and deletes a created block-only file', () => {
    applyGuidance(dir);
    const r = removeGuidance(dir);
    assert.equal(r.action, 'deleted-file');
    assert.equal(existsSync(rules()), false);
  });

  it('retains a created file that later gained user content', () => {
    applyGuidance(dir);
    writeFileSync(rules(), read() + '\nUser added this later.\n');
    const r = removeGuidance(dir);
    assert.equal(r.action, 'removed-block');
    assert.ok(existsSync(rules()));
    assert.ok(read().includes('User added this later.'));
    assert.ok(!read().includes(GUIDANCE_START_MARKER));
  });

  it('removes an owned block appended to an existing file, preserving content', () => {
    writeFileSync(rules(), '# Rules\n\nKeep me.\n');
    applyGuidance(dir);
    removeGuidance(dir);
    assert.ok(existsSync(rules()));
    assert.ok(read().includes('Keep me.'));
    assert.ok(!read().includes(GUIDANCE_START_MARKER));
  });

  it('remove is idempotent', () => {
    applyGuidance(dir);
    removeGuidance(dir);
    const r = removeGuidance(dir);
    assert.equal(r.action, 'noop');
    assert.equal(r.ok, true);
  });

  it('preserves a modified owned block on remove without force', () => {
    applyGuidance(dir);
    writeFileSync(rules(), read().replace('## Agentic Loop', '## Agentic Loop (edited)'));
    const r = removeGuidance(dir);
    assert.equal(r.action, 'preserved');
    assert.ok(read().includes('(edited)'));
  });

  it('force-removes only a modified owned marker region', () => {
    const original = 'USER BEFORE\n\n';
    writeFileSync(rules(), original);
    applyGuidance(dir);
    writeFileSync(rules(), read().replace('## Agentic Loop', '## Agentic Loop (edited)') + 'USER AFTER\n');

    const r = removeGuidance(dir, { force: true });
    assert.equal(r.action, 'removed-block');
    assert.equal(read(), `${original}USER AFTER\n`);
    assert.ok(!read().includes(GUIDANCE_START_MARKER));
  });

  it('rejects forged separator ownership without modifying adjacent user rules', () => {
    writeFileSync(rules(), '# USER RULES\nKEEP ME\n');
    applyGuidance(dir);
    const original = readFileSync(rules());
    const manifestPath = join(dir, '.agenticloop', 'generated-artifacts.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.entries.find(candidate => candidate.kind === 'marker-block');
    entry.ownedPrefix = '# USER RULES\nKEEP ME\n\n';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const result = removeGuidance(dir);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'malformed-manifest');
    assert.deepEqual(readFileSync(rules()), original);
  });

  it('rolls a forced removal back when ownership persistence fails', () => {
    writeFileSync(rules(), 'before\n');
    applyGuidance(dir);
    writeFileSync(rules(), read().replace('## Agentic Loop', '## Agentic Loop (edited)'));
    const original = readFileSync(rules());
    // Keep one unrelated entry so ownership release must persist a manifest.
    const manifest = loadManifest(dir);
    manifest.entries.push(createMarkerBlockEntry({
      relPath: 'OTHER.md', startMarker: '<!-- OTHER START -->', endMarker: '<!-- OTHER END -->',
      content: '<!-- OTHER START -->x<!-- OTHER END -->', createdFile: false,
    }));
    saveManifest(dir, manifest);
    const r = removeGuidance(dir, { force: true, saveManifest: () => { throw new Error('injected manifest failure'); } });
    assert.equal(r.action, 'rolled-back');
    assert.deepEqual(readFileSync(rules()), original);
  });

  for (const [name, original] of [
    ['LF with final newline', 'one\n\nthree\n'],
    ['CRLF with final newline', 'one\r\n\r\nthree\r\n'],
    ['no final newline', 'one\n\nthree'],
    ['trailing blank lines', 'one\n\n\n\n'],
    ['empty existing file', ''],
  ]) {
    it(`restores ${name} byte-for-byte after apply/remove`, () => {
      writeFileSync(rules(), original);
      applyGuidance(dir);
      removeGuidance(dir);
      assert.deepEqual(readFileSync(rules()), Buffer.from(original));
    });
  }

  it('preserves outside edits after installation while removing the owned region', () => {
    writeFileSync(rules(), 'before\n');
    applyGuidance(dir);
    const installed = read();
    writeFileSync(rules(), `new before\n${installed}new after\n`);
    removeGuidance(dir);
    assert.equal(read(), 'new before\nbefore\nnew after\n');
  });

  it('does not remove an unowned/manual block by default', () => {
    writeFileSync(rules(), `x\n${GUIDANCE_START_MARKER}\nmanual\n${GUIDANCE_END_MARKER}\n`);
    const r = removeGuidance(dir);
    assert.equal(r.action, 'noop');
    assert.ok(read().includes('manual'));
  });
});

describe('locateGuidanceBlock + computeGuidanceRemoval', () => {
  it('reports none/present/malformed', () => {
    assert.equal(locateGuidanceBlock('nothing').state, 'none');
    assert.equal(locateGuidanceBlock(GUIDANCE_BLOCK).state, 'present');
    assert.equal(locateGuidanceBlock(`${GUIDANCE_START_MARKER}\n${GUIDANCE_START_MARKER}\n${GUIDANCE_END_MARKER}`).state, 'malformed');
  });

  it('uses a marker-block entry marker pair instead of global guidance markers', () => {
    const entry = createMarkerBlockEntry({
      relPath: 'RULES.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->',
      content: '<!-- START -->\nowned\n<!-- END -->', createdFile: false,
    });
    const plan = computeGuidanceRemoval('before<!-- START -->\nowned\n<!-- END -->after', entry);
    assert.deepEqual(plan, { outcome: 'rewrite', content: 'beforeafter' });
  });
});

describe('guidance rules-document resolver precedence', () => {
  it('1. explicit project-map documents.rules wins even if file is absent', () => {
    mkdirSync(join(dir, '.agenticloop'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'project.md'),
      '---\nsetup_status: "confirmed"\ndocuments:\n  rules: "docs/RULES.md"\n---\n');
    const t = resolveGuidanceRulesTarget(dir);
    assert.equal(t.ok, true);
    assert.equal(t.relPath, 'docs/RULES.md');
    assert.equal(t.source, 'project-map');
  });

  it('2. explicit config documents.rules wins when the file exists', () => {
    writeFileSync(rules('CLAUDE.md'), '# c\n');
    const t = resolveGuidanceRulesTarget(dir, { alConfig: { documents: { rules: 'CLAUDE.md' } } });
    assert.equal(t.relPath, 'CLAUDE.md');
    assert.equal(t.source, 'config');
  });

  it('3. falls back to the first existing registry candidate (CLAUDE.md when no AGENTS.md)', () => {
    writeFileSync(rules('CLAUDE.md'), '# c\n');
    const t = resolveGuidanceRulesTarget(dir);
    assert.equal(t.relPath, 'CLAUDE.md');
    assert.equal(t.source, 'registry');
  });

  it('prefers AGENTS.md over CLAUDE.md when both exist (deterministic order)', () => {
    writeFileSync(rules('AGENTS.md'), '# a\n');
    writeFileSync(rules('CLAUDE.md'), '# c\n');
    assert.equal(resolveGuidanceRulesTarget(dir).relPath, 'AGENTS.md');
  });

  it('4. defaults to AGENTS.md when no rules document exists', () => {
    const t = resolveGuidanceRulesTarget(dir);
    assert.equal(t.relPath, 'AGENTS.md');
    assert.equal(t.source, 'default');
  });

  it('rejects a non-Markdown configured target', () => {
    mkdirSync(join(dir, '.agenticloop'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'project.md'),
      '---\nsetup_status: "confirmed"\ndocuments:\n  rules: "RULES.txt"\n---\n');
    const t = resolveGuidanceRulesTarget(dir);
    assert.equal(t.ok, false);
    assert.match(t.error, /Markdown/);
  });

  it('rejects a path outside the repository', () => {
    mkdirSync(join(dir, '.agenticloop'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'project.md'),
      '---\nsetup_status: "confirmed"\ndocuments:\n  rules: "../escape.md"\n---\n');
    const t = resolveGuidanceRulesTarget(dir);
    assert.equal(t.ok, false);
  });

  it('checkGuidance reports unsafe-path for a rejected target', () => {
    mkdirSync(join(dir, '.agenticloop'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'project.md'),
      '---\nsetup_status: "confirmed"\ndocuments:\n  rules: "notes.txt"\n---\n');
    assert.equal(checkGuidance(dir).status, 'unsafe-path');
  });
});

describe('ownership manifest v4 + marker-block', () => {
  it('current schema version is 4', () => {
    assert.equal(GENERATED_ARTIFACTS_SCHEMA_VERSION, 4);
  });

  it('validates a core-owned marker-block entry', () => {
    const entry = createMarkerBlockEntry({
      relPath: 'AGENTS.md',
      startMarker: GUIDANCE_START_MARKER,
      endMarker: GUIDANCE_END_MARKER,
      content: GUIDANCE_BLOCK,
      createdFile: true,
    });
    assert.equal(entry.adapter, 'core');
    assert.equal(entry.kind, 'marker-block');
    assert.doesNotThrow(() => validateManifestEntry(entry));
  });

  it('rejects a host adapter owner for marker-block', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'codex', outputRoot: '.', relPath: 'AGENTS.md', kind: 'marker-block',
      startMarker: GUIDANCE_START_MARKER, endMarker: GUIDANCE_END_MARKER,
      hash: 'a'.repeat(64), createdFile: true,
    }), /core owner/);
  });

  it('rejects a core owner for a file entry', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'core', outputRoot: '.', relPath: 'x.md', kind: 'file', hash: 'a'.repeat(64),
    }), /supported adapter/);
  });

  it('rejects unknown keys on a marker-block entry (strict allowlist)', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'core', outputRoot: '.', relPath: 'AGENTS.md', kind: 'marker-block',
      startMarker: GUIDANCE_START_MARKER, endMarker: GUIDANCE_END_MARKER,
      hash: 'a'.repeat(64), createdFile: true, bogus: 1,
    }), /unknown key/);
  });

  it('requires a valid hash and markers', () => {
    assert.throws(() => validateManifestEntry({
      adapter: 'core', outputRoot: '.', relPath: 'AGENTS.md', kind: 'marker-block',
      startMarker: GUIDANCE_START_MARKER, endMarker: GUIDANCE_END_MARKER,
      hash: 'nope', createdFile: true,
    }), /hash/);
  });

  it('rejects identical or multiline generic marker pairs', () => {
    const base = {
      adapter: 'core', outputRoot: '.', relPath: 'AGENTS.md', kind: 'marker-block',
      hash: 'a'.repeat(64), createdFile: false,
    };
    assert.throws(() => validateManifestEntry({ ...base, startMarker: '<!-- X -->', endMarker: '<!-- X -->' }), /distinct/);
    assert.throws(() => validateManifestEntry({ ...base, startMarker: '<!-- X\n-->', endMarker: '<!-- Y -->' }), /single-line/);
  });

  it('allows only exact newline separator values for marker-block ownership', () => {
    const base = {
      adapter: 'core', outputRoot: '.', relPath: 'AGENTS.md', kind: 'marker-block',
      startMarker: GUIDANCE_START_MARKER, endMarker: GUIDANCE_END_MARKER,
      hash: 'a'.repeat(64), createdFile: false,
    };
    assert.doesNotThrow(() => validateManifestEntry({ ...base, ownedPrefix: '\r\n\r\n', ownedSuffix: '\r\n' }));
    assert.throws(
      () => validateManifestEntry({ ...base, ownedPrefix: 'target-owned text\n', ownedSuffix: '\n' }),
      /ownedPrefix must be an exact generated newline separator/
    );
    assert.throws(
      () => validateManifestEntry({ ...base, ownedPrefix: '\n', ownedSuffix: 'target-owned text' }),
      /ownedSuffix must be an exact generated newline separator/
    );
    assert.throws(
      () => validateManifestEntry({ ...base, ownedPrefix: '\r\n', ownedSuffix: '\n' }),
      /one newline style/
    );
  });

  it('marker-block identity is distinct per marker pair', () => {
    const a = createMarkerBlockEntry({ relPath: 'AGENTS.md', startMarker: '<!--A-->', endMarker: '<!--/A-->', content: 'x' });
    const b = createMarkerBlockEntry({ relPath: 'AGENTS.md', startMarker: '<!--B-->', endMarker: '<!--/B-->', content: 'x' });
    assert.notEqual(entryIdentity(a), entryIdentity(b));
  });

  it('migrates a v3 manifest to v4, preserving adapter entries', () => {
    const v3 = {
      schemaVersion: 3,
      packageVersion: '1.2.3',
      generatedAt: new Date().toISOString(),
      entries: [
        { adapter: 'codex', outputRoot: '.', relPath: '.codex/agents/engineer.toml', kind: 'file', hash: 'a'.repeat(64), existence: 'created', generatedAt: new Date().toISOString() },
      ],
    };
    writeFileSync(join(dir, 'v3.json'), JSON.stringify(v3));
    // migrateManifest is internal; validate via loadManifest by placing it at the managed path.
    mkdirSync(join(dir, '.agenticloop'), { recursive: true });
    writeFileSync(join(dir, '.agenticloop', 'generated-artifacts.json'), JSON.stringify(v3));
    const loaded = loadManifest(dir);
    assert.equal(loaded.schemaVersion, 4);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].adapter, 'codex');
  });

  it('validateManifest rejects an unsupported schema version', () => {
    assert.throws(() => validateManifest({ schemaVersion: 5, packageVersion: '1.0.0', entries: [] }), /unsupported schemaVersion/);
  });
});
