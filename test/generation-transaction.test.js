import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeGenerationPlan } from '../src/generation-transaction.js';
import { generateAdapterArtifacts } from '../src/adapter-generation.js';
import { createManifest, loadManifest, saveManifest, createFileEntry } from '../src/generated-artifacts.js';
import { executeRemovalPlan, removeAgenticLoop } from '../src/remove.js';

const base = mkdtempSync(join(tmpdir(), 'agenticloop-generation-'));

after(() => rmSync(base, { recursive: true, force: true }));

function target() {
  return mkdtempSync(join(base, 'target-'));
}

function plan(actions, adapters = ['opencode'], outputRoot = '.') {
  return { actions, adapters, outputRoot, files: actions.map(action => action.relPath) };
}

function writeManifest(root, entries) {
  const manifest = createManifest('test');
  manifest.entries = entries;
  saveManifest(root, manifest);
}

describe('generation transaction ownership regressions', () => {
  it('rejects hostile manifest paths before removal can reach outside the target', () => {
    const root = target();
    const outside = join(base, 'outside.json');
    writeFileSync(outside, 'sentinel');
    mkdirSync(join(root, '.agenticloop'), { recursive: true });
    writeFileSync(join(root, '.agenticloop', 'generated-artifacts.json'), JSON.stringify({
      schemaVersion: 3, packageVersion: 'test', entries: [{
        adapter: 'opencode', outputRoot: '.', relPath: '../outside.json', kind: 'shared-config',
        existence: 'created', generatedAt: new Date().toISOString(), mutations: [],
      }],
    }));

    const result = removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(result.errors.some(error => error.includes('traversal') || error.includes('path escapes') || error.includes('malformed')));
    assert.equal(readFileSync(outside, 'utf8'), 'sentinel');
  });

  it('keeps modified generated files on normal update and permits only explicit force', () => {
    const root = target();
    const relPath = '.opencode/agents/engineer.md';
    mkdirSync(join(root, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(root, relPath), 'generated');
    writeManifest(root, [{
      adapter: 'opencode', outputRoot: '.', relPath, kind: 'file',
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      existence: 'created', generatedAt: new Date().toISOString(),
    }]);
    const action = { type: 'write-file', adapter: 'opencode', relPath, content: 'replacement' };

    assert.equal(executeGenerationPlan(root, plan([action])).ok, false, 'should block without force');
    assert.equal(readFileSync(join(root, relPath), 'utf8'), 'generated', 'file unchanged');
    assert.equal(executeGenerationPlan(root, plan([action]), { forceGenerated: true }).ok, true, 'should succeed with force');
    assert.equal(readFileSync(join(root, relPath), 'utf8'), 'replacement', 'file updated');
  });

  it('keeps unknown nested files out of ownership and removal', () => {
    const root = target();
    const generated = '.agents/skills/agenticloop/SKILL.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: '.agents/skills/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath: generated, content: 'generated' },
    ], ['codex'])).ok, true);
    const userFile = join(root, '.agents/skills/agenticloop/user/note.md');
    mkdirSync(join(userFile, '..'), { recursive: true });
    writeFileSync(userFile, 'user content');

    assert.equal(executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: '.agents/skills/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath: generated, content: 'refreshed' },
    ], ['codex'])).ok, true);
    const manifest = loadManifest(root);
    assert.equal(manifest.entries.some(entry => JSON.stringify(entry).includes('user/note.md')), false);
    removeAgenticLoop({ target: root, dryRun: false });
    assert.equal(existsSync(userFile), true);
  });

  it('records and reverses an added gitignore line without claiming an existing one', () => {
    const root = target();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\r\n');
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);
    assert.equal(loadManifest(root).entries.filter(entry => entry.kind === 'gitignore-line').length, 1);
    removeAgenticLoop({ target: root, dryRun: false });
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\r\n');
  });

  it('does not claim a pre-existing matching gitignore line', () => {
    const root = target();
    writeFileSync(join(root, '.gitignore'), '.agenticloop/tmp/\n');
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);
    const entries = loadManifest(root).entries.filter(e => e.kind === 'gitignore-line');
    assert.equal(entries.length, 0, 'should not create entry for pre-existing line');
    removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').includes('.agenticloop/tmp/'));
  });

  it('reverses only the exact owned shared JSON array addition', () => {
    const root = target();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['User(*)'] } }, null, 2) + '\n');
    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'Bash(npx agenticloop *)' }],
    };
    assert.equal(executeGenerationPlan(root, plan([action], ['claude-code'])).ok, true);
    removeAgenticLoop({ target: root, dryRun: false });
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')), { permissions: { allow: ['User(*)'] } });
  });

  it('keeps output-root ownership separate and supports repeated contained generation', () => {
    const root = target();
    const action = { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/engineer.md', content: 'one' };
    assert.equal(executeGenerationPlan(root, plan([action], ['opencode'], 'generated')).ok, true);
    assert.equal(executeGenerationPlan(root, plan([{ ...action, content: 'two' }], ['opencode'], 'generated')).ok, true);
    assert.equal(readFileSync(join(root, 'generated', action.relPath), 'utf8'), 'two');
  });

  it('writes nothing for a batch when a later adapter collision blocks', () => {
    const root = target();
    mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codex/agents/engineer.toml'), 'user');
    const result = executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/engineer.md', content: 'generated' },
      { type: 'write-file', adapter: 'codex', relPath: '.codex/agents/engineer.toml', content: 'generated' },
    ], ['opencode', 'codex']));
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(root, '.opencode/agents/engineer.md')), false);
  });

  it('applies two separate merges to the same file sequentially', () => {
    const root = target();
    const result = executeGenerationPlan(root, plan([
      { type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'A' }] },
      { type: 'json-merge', adapter: 'copilot', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'B' }] },
    ], ['claude-code', 'copilot']));
    assert.equal(result.ok, true);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('A'), 'first merge should be present');
    assert.ok(settings.permissions.allow.includes('B'), 'second merge should be present');
  });

  it('fresh replace-array-element on undefined property initializes array', () => {
    const root = target();
    const result = executeGenerationPlan(root, plan([{
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'test' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    }], ['codex']));
    assert.equal(result.ok, true, `should succeed: ${result.errors.join(', ')}`);
    const marketplace = JSON.parse(readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.ok(Array.isArray(marketplace.plugins), 'plugins should be an array');
    assert.equal(marketplace.plugins[0].name, 'agenticloop');
  });

  it('preserves pre-existing {} file after generate and remove', () => {
    const root = target();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), '{}');
    executeGenerationPlan(root, plan([{
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test' }],
    }], ['claude-code']));
    removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(existsSync(join(root, '.claude/settings.json')), 'pre-existing file should remain');
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')), {});
  });

  it('deletes generated file after generate and remove', () => {
    const root = target();
    executeGenerationPlan(root, plan([{
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test' }],
    }], ['claude-code']));
    assert.ok(existsSync(join(root, '.claude/settings.json')));
    removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(!existsSync(join(root, '.claude/settings.json')), 'generated file should be deleted');
  });

  it('fails closed on malformed manifest', () => {
    const root = target();
    mkdirSync(join(root, '.agenticloop'), { recursive: true });
    writeFileSync(join(root, '.agenticloop', 'generated-artifacts.json'), 'not json');
    mkdirSync(join(root, 'agenticloop'), { recursive: true });
    writeFileSync(join(root, 'agenticloop.json'), '{}');
    const result = removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(result.errors.some(e => e.includes('malformed')));
    assert.equal(result.committed, false, 'a refused malformed-manifest removal must not report a commit');
    assert.ok(existsSync(join(root, 'agenticloop')), 'should not remove agenticloop/');
    assert.ok(existsSync(join(root, 'agenticloop.json')), 'should not remove agenticloop.json');
    assert.equal(readdirSync(root).some(name => name.startsWith('.agenticloop-remove-')), false);
  });

  it('coalesces same-adapter merges into one shared-config entry', () => {
    const root = target();
    const result = executeGenerationPlan(root, plan([
      { type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'A' }] },
      { type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'B' }] },
    ], ['claude-code']));
    assert.equal(result.ok, true);
    const manifest = loadManifest(root);
    const entries = manifest.entries.filter(e => e.kind === 'shared-config' && e.adapter === 'claude-code' && e.relPath === '.claude/settings.json');
    assert.equal(entries.length, 1, 'should have exactly one shared-config entry');
    assert.ok(entries[0].mutations.length >= 2, 'entry should contain both mutations');
  });

  it('preserves added:true lineage through repeated replace-array-element generation', () => {
    const root = target();
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'test' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    assert.equal(executeGenerationPlan(root, plan([action], ['codex'])).ok, true);
    const m1 = loadManifest(root);
    const mut1 = m1.entries.find(e => e.kind === 'shared-config')?.mutations?.find(m => m.op === 'replace-array-element');
    assert.equal(mut1?.added, true, 'first generation: added:true');

    assert.equal(executeGenerationPlan(root, plan([action], ['codex'])).ok, true);
    const m2 = loadManifest(root);
    const mut2 = m2.entries.find(e => e.kind === 'shared-config')?.mutations?.find(m => m.op === 'replace-array-element');
    assert.equal(mut2?.added, true, 'repeat generation: should preserve added:true');
    assert.equal(Object.hasOwn(mut2 ?? {}, 'previous'), false, 'should not have previous field when AL appended');
  });

  it('removes marketplace.json after repeated generate when AL created it', () => {
    const root = target();
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    assert.equal(executeGenerationPlan(root, plan([action], ['codex'])).ok, true);
    assert.equal(executeGenerationPlan(root, plan([action], ['codex'])).ok, true);
    removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(!existsSync(join(root, '.agents', 'plugins', 'marketplace.json')), 'marketplace.json should be absent');
  });

  it('preserves ambiguous gitignore duplicates during generation and removal', () => {
    const root = target();
    // Agentic Loop adds the line.
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);
    // User adds identical line before.
    const content = readFileSync(join(root, '.gitignore'), 'utf8');
    writeFileSync(join(root, '.gitignore'), '.agenticloop/tmp/\n' + content);

    // Regenerate.
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);

    // Remove should preserve both lines.
    removeAgenticLoop({ target: root, dryRun: false });
    const after = readFileSync(join(root, '.gitignore'), 'utf8');
    const lines = after.split(/\r?\n/).filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(lines.length, 2, 'both lines should be preserved when ambiguous');
  });

  it('refuses to replace a user-owned replace-array-element entry', () => {
    const root = target();
    // First, create a marketplace with a user-owned plugin.
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    writeFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'user-marketplace',
      plugins: [{ name: 'agenticloop', source: { source: 'user' } }],
    }, null, 2) + '\n');

    // Try to replace the agenticloop plugin (no prior ownership).
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', source: { source: 'local' } } },
      ],
    };
    const result = executeGenerationPlan(root, plan([action], ['codex']));
    assert.equal(result.ok, false, 'should refuse to replace user-owned entry');
    assert.ok(result.errors.some(e => e.includes('user-owned')), 'should report user-owned error');
    // Original content should be preserved.
    const after = JSON.parse(readFileSync(join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(after.plugins[0].source.source, 'user', 'user content should be preserved');
  });

  it('preserves an exact pre-existing replacement value through removal', () => {
    const root = target();
    const path = join(root, '.agents', 'plugins', 'marketplace.json');
    const original = '{\r\n  "plugins": [\r\n    { "name": "agenticloop", "source": "user" }\r\n  ]\r\n}\r\n';
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    writeFileSync(path, original);
    const action = { type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json', mutations: [{ op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', source: 'user' } }] };
    assert.equal(executeGenerationPlan(root, plan([action], ['codex'])).ok, true);
    const mutation = loadManifest(root).entries.find(entry => entry.kind === 'shared-config').mutations[0];
    assert.equal(mutation.added, false, 'pre-existing exact value is not owned');
    const result = removeAgenticLoop({ target: root, dryRun: false });
    assert.equal(result.errors.length, 0, result.errors.join(', '));
    assert.equal(readFileSync(path, 'utf8'), original, 'pre-existing shared value must survive byte-for-byte');
  });

  it('blocks regeneration when a previously generated replacement value is user-modified', () => {
    const root = target();
    const path = join(root, '.agents', 'plugins', 'marketplace.json');
    const first = { type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json', mutations: [{ op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: 'one' } }] };
    const second = { ...first, mutations: [{ ...first.mutations[0], value: { name: 'agenticloop', version: 'two' } }] };
    assert.equal(executeGenerationPlan(root, plan([first], ['codex'])).ok, true);
    writeFileSync(path, JSON.stringify({ plugins: [{ name: 'agenticloop', version: 'user' }] }, null, 2) + '\n');
    const result = executeGenerationPlan(root, plan([second], ['codex']));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('/plugins') && error.includes('modified')));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { plugins: [{ name: 'agenticloop', version: 'user' }] });
  });

  it('persists gitignore ambiguity after duplicates collapse to one line', () => {
    const root = target();
    const path = join(root, '.gitignore');
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);
    writeFileSync(path, '.agenticloop/tmp/\n.agenticloop/tmp/\n');
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);
    assert.equal(loadManifest(root).entries.find(entry => entry.kind === 'gitignore-line').ambiguous, true);
    writeFileSync(path, '.agenticloop/tmp/\n');
    assert.equal(executeGenerationPlan(root, plan([action])).ok, true);
    const result = removeAgenticLoop({ target: root, dryRun: false });
    assert.equal(readFileSync(path, 'utf8'), '.agenticloop/tmp/\n');
    assert.ok(result.skipped.some(item => item.includes('ambiguous')));
    assert.equal(loadManifest(root).entries.find(entry => entry.kind === 'gitignore-line').ambiguous, true);
  });

  it('rolls back a genuine post-write failure including directories and manifest bytes', () => {
    const root = target();
    const existing = join(root, 'existing.txt');
    writeFileSync(existing, 'before');
    writeManifest(root, [createFileEntry({ adapter: 'opencode', outputRoot: '.', relPath: 'existing.txt', content: 'before' })]);
    const manifestPath = join(root, '.agenticloop', 'generated-artifacts.json');
    const manifestBytes = readFileSync(manifestPath);
    const result = executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: 'existing.txt', content: 'after' },
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/new.md', content: 'new' },
    ]), { extraWrites: [{ relPath: 'late-failure.txt', content: {} }] });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(existing, 'utf8'), 'before');
    assert.deepEqual(readFileSync(manifestPath), manifestBytes);
    assert.equal(existsSync(join(root, '.opencode', 'agents', 'new.md')), false);
    assert.equal(existsSync(join(root, '.opencode')), false);
    assert.equal(existsSync(join(root, 'late-failure.txt')), false);
  });

  it('fails removal atomically without later known-path cleanup', () => {
    const root = target();
    const generated = '.opencode/agents/orchestrator.md';
    assert.equal(executeGenerationPlan(root, plan([{ type: 'write-file', adapter: 'opencode', relPath: generated, content: 'generated' }])).ok, true);
    mkdirSync(join(root, 'agenticloop'), { recursive: true });
    writeFileSync(join(root, 'agenticloop', 'README.md'), 'known path');
    const manifestPath = join(root, '.agenticloop', 'generated-artifacts.json');
    const manifestBytes = readFileSync(manifestPath);
    const result = executeRemovalPlan(root, { dryRun: false }, {
      afterOutputWrites: () => { throw new Error('injected removal transaction failure'); },
    });
    assert.ok(result.errors.some(error => error.includes('Removal transaction failed')));
    assert.equal(result.removed.length, 0, 'rolled-back removals must not be reported as committed');
    assert.equal(readFileSync(join(root, generated), 'utf8'), 'generated');
    assert.equal(existsSync(join(root, 'agenticloop', 'README.md')), true, 'known-path cleanup must not run after rollback');
    assert.deepEqual(readFileSync(manifestPath), manifestBytes);
  });

  it('transfers exact stale plugin ownership between hosts in one transaction', () => {
    const root = target();
    const relPath = 'plugins/agenticloop/skills/agenticloop/SKILL.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath, content: 'codex plugin' },
    ], ['codex'])).ok, true);

    const result = executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' },
      { type: 'clear-owned-directory', adapter: 'cursor', relPath: 'plugins/agenticloop' },
      { type: 'write-file', adapter: 'cursor', relPath, content: 'cursor plugin' },
    ], ['codex', 'cursor']));
    assert.equal(result.ok, true, result.errors.join(', '));
    assert.equal(readFileSync(join(root, relPath), 'utf8'), 'cursor plugin');
    const entries = loadManifest(root).entries.filter(entry => entry.relPath === relPath);
    assert.deepEqual(entries.map(entry => entry.adapter), ['cursor']);
  });

  it('switches real Codex and Cursor plugin planners atomically', () => {
    const root = target();
    const baseConfig = {
      roles: { engineer: { description: 'Engineering role' } },
      agents: { sourceDirectory: 'agents' },
      skills: { sourceDirectory: 'skills' },
      backends: { sourceDirectory: 'backends' },
      adapters: {
        codex: { plugin: { enabled: true } },
        cursor: { plugin: { enabled: false } },
      },
    };
    const initial = generateAdapterArtifacts({ target: root, alConfig: baseConfig, adapter: ['codex', 'cursor'] });
    assert.equal(initial.ok, true, initial.errors.join(', '));
    const relPath = 'plugins/agenticloop/skills/agenticloop/SKILL.md';
    assert.ok(existsSync(join(root, relPath)));

    const switchedConfig = {
      ...baseConfig,
      adapters: {
        codex: { plugin: { enabled: false } },
        cursor: { plugin: { enabled: true } },
      },
    };
    const switched = generateAdapterArtifacts({ target: root, alConfig: switchedConfig, adapter: ['codex', 'cursor'] });
    assert.equal(switched.ok, true, switched.errors.join(', '));
    assert.ok(existsSync(join(root, 'plugins', 'agenticloop', '.cursor-plugin', 'plugin.json')));
    assert.equal(existsSync(join(root, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json')), false);
    const entries = loadManifest(root).entries.filter(entry => entry.relPath.startsWith('plugins/agenticloop/'));
    assert.ok(entries.length > 0);
    assert.ok(entries.every(entry => entry.adapter === 'cursor'));

    const reversed = generateAdapterArtifacts({ target: root, alConfig: baseConfig, adapter: ['codex', 'cursor'] });
    assert.equal(reversed.ok, true, reversed.errors.join(', '));
    assert.ok(existsSync(join(root, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json')));
    assert.equal(existsSync(join(root, 'plugins', 'agenticloop', '.cursor-plugin', 'plugin.json')), false);
    assert.ok(loadManifest(root).entries
      .filter(entry => entry.relPath.startsWith('plugins/agenticloop/'))
      .every(entry => entry.adapter === 'codex'));
  });

  it('blocks plugin ownership transfer when the stale file is modified', () => {
    const root = target();
    const relPath = 'plugins/agenticloop/skills/agenticloop/SKILL.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath, content: 'codex plugin' },
    ], ['codex'])).ok, true);
    writeFileSync(join(root, relPath), 'user modified');
    const before = readFileSync(join(root, '.agenticloop', 'generated-artifacts.json'));

    const result = executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' },
      { type: 'clear-owned-directory', adapter: 'cursor', relPath: 'plugins/agenticloop' },
      { type: 'write-file', adapter: 'cursor', relPath, content: 'cursor plugin' },
    ], ['codex', 'cursor']));
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(root, relPath), 'utf8'), 'user modified');
    assert.deepEqual(readFileSync(join(root, '.agenticloop', 'generated-artifacts.json')), before);
  });

  it('never forces a modified cross-adapter ownership transfer', () => {
    const root = target();
    const relPath = 'plugins/agenticloop/skills/agenticloop/SKILL.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath, content: 'codex plugin' },
    ], ['codex'])).ok, true);
    writeFileSync(join(root, relPath), 'user modified bytes');
    const manifest = readFileSync(join(root, '.agenticloop', 'generated-artifacts.json'));

    const result = executeGenerationPlan(root, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: 'plugins/agenticloop' },
      { type: 'clear-owned-directory', adapter: 'cursor', relPath: 'plugins/agenticloop' },
      { type: 'write-file', adapter: 'cursor', relPath, content: 'cursor plugin' },
    ], ['codex', 'cursor']), { forceGenerated: true });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /Ownership transfer from codex to cursor is unsafe/);
    assert.doesNotMatch(result.errors.join('\n'), /Preserved modified stale generated file/);
    assert.equal(readFileSync(join(root, relPath), 'utf8'), 'user modified bytes');
    assert.deepEqual(readFileSync(join(root, '.agenticloop', 'generated-artifacts.json')), manifest);
    assert.deepEqual(loadManifest(root).entries.filter(entry => entry.relPath === relPath).map(entry => entry.adapter), ['codex']);
  });

  it('never forces modified Codex and Cursor plugin planner transitions', () => {
    const relPath = 'plugins/agenticloop/skills/agenticloop/SKILL.md';
    const baseConfig = {
      roles: { engineer: { description: 'Engineering role' } },
      agents: { sourceDirectory: 'agents' },
      skills: { sourceDirectory: 'skills' },
      backends: { sourceDirectory: 'backends' },
    };
    for (const [from, to] of [['codex', 'cursor'], ['cursor', 'codex']]) {
      const root = target();
      const initialConfig = { ...baseConfig, adapters: {
        codex: { plugin: { enabled: from === 'codex' } },
        cursor: { plugin: { enabled: from === 'cursor' } },
      } };
      const switchedConfig = { ...baseConfig, adapters: {
        codex: { plugin: { enabled: to === 'codex' } },
        cursor: { plugin: { enabled: to === 'cursor' } },
      } };
      assert.equal(generateAdapterArtifacts({ target: root, alConfig: initialConfig, adapter: ['codex', 'cursor'] }).ok, true);
      writeFileSync(join(root, relPath), `user modified ${from}`);
      const manifest = readFileSync(join(root, '.agenticloop', 'generated-artifacts.json'));
      const result = generateAdapterArtifacts({ target: root, alConfig: switchedConfig, adapter: ['codex', 'cursor'], forceGenerated: true });
      assert.equal(result.ok, false, `${from} -> ${to} must remain blocked`);
      assert.equal(readFileSync(join(root, relPath), 'utf8'), `user modified ${from}`);
      assert.deepEqual(readFileSync(join(root, '.agenticloop', 'generated-artifacts.json')), manifest);
    }
  });

  it('reports ownership release when a pre-existing shared value needs no reversal', () => {
    const root = target();
    const path = join(root, '.agents', 'plugins', 'marketplace.json');
    const original = '{\n  "plugins": [{ "name": "agenticloop" }]\n}\n';
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true });
    writeFileSync(path, original);
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [{ op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } }],
    };
    assert.equal(executeGenerationPlan(root, plan([action], ['codex'])).ok, true);
    const dryRun = removeAgenticLoop({ target: root, dryRun: true });
    assert.deepEqual(dryRun.released, ['.agents/plugins/marketplace.json (ownership released; pre-existing shared value preserved)']);
    assert.deepEqual(readFileSync(path, 'utf8'), original, 'dry-run must preserve shared bytes');
    const result = removeAgenticLoop({ target: root, dryRun: false });
    assert.deepEqual(readFileSync(path, 'utf8'), original);
    assert.equal(result.removed.some(item => item.includes('shared mutation removed')), false);
    assert.deepEqual(result.released, ['.agents/plugins/marketplace.json (ownership released; pre-existing shared value preserved)']);
  });

  it('rolls back known paths and target state after they enter quarantine', () => {
    const root = target();
    const generated = '.opencode/agents/orchestrator.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: generated, content: 'generated' },
    ])).ok, true);
    const manifestPath = join(root, '.agenticloop', 'generated-artifacts.json');
    const manifest = readFileSync(manifestPath);
    mkdirSync(join(root, 'agenticloop'), { recursive: true });
    writeFileSync(join(root, 'agenticloop', 'README.md'), 'toolkit');
    writeFileSync(join(root, '.agenticloop', 'state.json'), 'state');

    const result = executeRemovalPlan(root, { includeState: true }, {
      beforeFinalize: () => { throw new Error('fail after state quarantine'); },
    });
    assert.equal(result.removed.length, 0);
    assert.equal(existsSync(join(root, generated)), true);
    assert.equal(readFileSync(join(root, 'agenticloop', 'README.md'), 'utf8'), 'toolkit');
    assert.equal(readFileSync(join(root, '.agenticloop', 'state.json'), 'utf8'), 'state');
    assert.deepEqual(readFileSync(manifestPath), manifest);
    assert.equal(readdirSync(root).some(name => name.startsWith('.agenticloop-remove-')), false);
  });

  it('restores the original retained manifest when state quarantine follows its rewrite', () => {
    const root = target();
    const exact = '.opencode/agents/orchestrator.md';
    const modified = '.opencode/agents/engineer.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: exact, content: 'exact bytes' },
      { type: 'write-file', adapter: 'opencode', relPath: modified, content: 'generated bytes' },
    ])).ok, true);
    writeFileSync(join(root, modified), 'user modified bytes');
    writeFileSync(join(root, '.agenticloop', 'state.json'), 'state bytes');
    const originalManifest = readFileSync(join(root, '.agenticloop', 'generated-artifacts.json'));

    const result = executeRemovalPlan(root, { includeState: true }, {
      beforeFinalize: () => { throw new Error('fail after state quarantine'); },
    });

    assert.equal(result.removed.length, 0);
    assert.equal(result.released.length, 0);
    assert.match(result.errors.join('\n'), /rolled back/);
    assert.equal(readFileSync(join(root, exact), 'utf8'), 'exact bytes');
    assert.equal(readFileSync(join(root, modified), 'utf8'), 'user modified bytes');
    assert.equal(readFileSync(join(root, '.agenticloop', 'state.json'), 'utf8'), 'state bytes');
    assert.deepEqual(readFileSync(join(root, '.agenticloop', 'generated-artifacts.json')), originalManifest);
    assert.equal(readdirSync(root).some(name => name.startsWith('.agenticloop-remove-')), false);
  });

  it('reports complete manifest-backed dry-run removal without mutating the target', () => {
    const root = target();
    const generated = '.opencode/agents/orchestrator.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: generated, content: 'generated bytes' },
    ])).ok, true);
    writeFileSync(join(root, '.agenticloop', 'state.json'), 'state bytes');
    const manifest = readFileSync(join(root, '.agenticloop', 'generated-artifacts.json'));
    const result = executeRemovalPlan(root, { dryRun: true, includeState: true });

    assert.ok(result.removed.includes(generated));
    assert.ok(result.removed.includes('.agenticloop'));
    assert.equal(result.committed, false);
    assert.equal(readFileSync(join(root, generated), 'utf8'), 'generated bytes');
    assert.equal(readFileSync(join(root, '.agenticloop', 'state.json'), 'utf8'), 'state bytes');
    assert.deepEqual(readFileSync(join(root, '.agenticloop', 'generated-artifacts.json')), manifest);
    assert.equal(readdirSync(root).some(name => name.startsWith('.agenticloop-remove-')), false);
  });

  it('keeps committed removals when quarantine cleanup fails', () => {
    const root = target();
    const generated = '.opencode/agents/orchestrator.md';
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: generated, content: 'generated bytes' },
    ])).ok, true);
    const result = executeRemovalPlan(root, {}, {
      cleanupQuarantine: (journal) => {
        const deleted = join(journal, 'deleted');
        if (existsSync(deleted)) rmSync(deleted, { recursive: true, force: true });
        throw new Error('injected partial cleanup failure');
      },
    });

    assert.equal(result.committed, true);
    assert.ok(result.removed.includes(generated));
    assert.equal(existsSync(join(root, generated)), false);
    assert.equal(result.errors.length, 0);
    assert.match(result.cleanupErrors.join('\n'), /cleanup failed after logical commit/i);
    const journal = readdirSync(root).find(name => name.startsWith('.agenticloop-remove-'));
    assert.ok(journal, 'failed cleanup must retain its journal for later cleanup');
    rmSync(join(root, journal), { recursive: true, force: true });
  });

  it('retains recovery data and reports incomplete rollback when an undo operation fails', () => {
    const root = target();
    const generated = '.opencode/agents/orchestrator.md';
    const generatedPath = join(root, generated);
    const parent = join(root, '.opencode', 'agents');
    assert.equal(executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: generated, content: 'recoverable bytes' },
    ])).ok, true);

    let injected = false;
    const result = executeRemovalPlan(root, {}, {
      afterQuarantine: (path) => {
        if (injected || path !== generatedPath) return;
        injected = true;
        rmSync(parent, { recursive: true, force: true });
        writeFileSync(parent, 'blocks rollback parent creation');
        throw new Error('injected rollback obstruction');
      },
    });

    assert.equal(result.committed, false);
    assert.equal(result.rollbackIncomplete, true);
    assert.equal(existsSync(generatedPath), false);
    assert.match(result.errors.join('\n'), /rollback is incomplete/i);
    assert.ok(result.recoveryJournal && existsSync(result.recoveryJournal), 'failed rollback must retain its recovery journal');
    const metadata = JSON.parse(readFileSync(join(result.recoveryJournal, 'transaction.json'), 'utf8'));
    assert.equal(metadata.state, 'rollback-failed');
    assert.ok(metadata.rollbackErrors.length > 0);
    const operation = metadata.operations.find(entry => entry.kind === 'quarantine' && entry.originalPath === generated);
    assert.ok(operation, 'recovery metadata must map the original path to its quarantine backup');
    assert.ok(existsSync(join(result.recoveryJournal, operation.quarantine)), 'quarantined file bytes must remain recoverable');
  });

  it('restores directories during rollback after collision', () => {
    const root = target();
    // Create an unowned file in a nested directory.
    mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(root, '.codex/agents/engineer.toml'), 'user');
    const beforeDir = existsSync(join(root, '.opencode', 'agents'));

    const result = executeGenerationPlan(root, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/engineer.md', content: 'generated' },
      { type: 'write-file', adapter: 'codex', relPath: '.codex/agents/engineer.toml', content: 'generated' },
    ], ['opencode', 'codex']));
    assert.equal(result.ok, false);
    // Transaction-created directories should be cleaned up.
    if (!beforeDir) {
      assert.ok(!existsSync(join(root, '.opencode', 'agents')), 'transaction-created directory should be removed on rollback');
    }
  });

  it('version 1 → version 2 marketplace update removes to original absence', () => {
    const root = target();
    const actionV1 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: '1.0.0' } },
      ],
    };
    assert.equal(executeGenerationPlan(root, plan([actionV1], ['codex'])).ok, true);

    const actionV2 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: '2.0.0' } },
      ],
    };
    assert.equal(executeGenerationPlan(root, plan([actionV2], ['codex'])).ok, true);

    removeAgenticLoop({ target: root, dryRun: false });
    assert.ok(!existsSync(join(root, '.agents', 'plugins', 'marketplace.json')), 'marketplace should be absent after removing version lineage');
  });
});
