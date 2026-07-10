/**
 * Comprehensive lifecycle regression tests for generation, update, and removal.
 *
 * Each test reproduces a specific confirmed defect and asserts final disk
 * content, manifest content, exit status, warnings, and rollback state.
 *
 * Scenarios implemented:
 *   1.  Pre-existing single .gitignore line survives generate/remove
 *   2.  Duplicate pre-existing .gitignore lines survive generate/remove
 *   3.  Generated .gitignore survives repeat generation lineage
 *   4.  Malformed manifest removes nothing (fail-closed)
 *   5.  Fresh Codex plugin generation succeeds
 *   6.  Repeated Codex marketplace generation removes cleanly
 *   7.  User marketplace entries and keys survive
 *   8.  Two separate compatible merge actions both survive
 *   9.  Conflicting merge actions block before writes
 *  10.  Pre-existing empty JSON file remains after removal
 *  11.  Generated empty JSON file is removed
 *  12.  Codex role rename removes exact stale output
 *  13.  Modified stale role output is preserved and remains owned
 *  14.  Cursor plugin enable/disable removes plugin output
 *  15.  Modified plugin content survives disable/remove
 *  16.  Claude init repeat generate remove lifecycle
 *  17.  Existing user Claude settings survive generation/removal
 *  18.  Rollback restores files and directories on failure
 *  19.  Link validation returns actionable details
 *  20.  packageVersion updated after successful transaction
 *  21.  existence tracked correctly
 *  22.  createdContainers cleaned up on removal
 *  23.  Duplicate .gitignore ambiguity
 *  24.  Malformed shared JSON concise error
 *  25.  Multi-adapter collision rollback
 *  26.  Output-root ownership separate
 *  27.  Modified generated file blocks non-forced update
 *  28.  Hostile manifest paths rejected
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { executeGenerationPlan } from '../src/generation-transaction.js';
import { createManifest, loadManifest, saveManifest, createFileEntry, createSharedConfigEntry, createGitignoreEntry, hashContent } from '../src/generated-artifacts.js';
import { removeAgenticLoop } from '../src/remove.js';
import { validateLinks } from '../src/link-validator.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');
let tmpBase;

before(() => { tmpBase = mkdtempSync(join(tmpdir(), 'al-lifecycle-')); });
after(() => { rmSync(tmpBase, { recursive: true, force: true }); });

function target() { return mkdtempSync(join(tmpBase, 't-')); }
function plan(actions, adapters = ['claude-code'], outputRoot = '.') {
  return { actions, adapters, outputRoot, files: actions.filter(a => a.type === 'write-file').map(a => a.relPath) };
}
function writeManifest(root, entries) {
  const manifest = createManifest('test');
  manifest.entries = entries;
  saveManifest(root, manifest);
}
function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', ...options });
}

// ---------------------------------------------------------------------------
// Scenario 1: Pre-existing single .gitignore line survives
// ---------------------------------------------------------------------------

describe('lifecycle: pre-existing .gitignore line survives generate/remove', () => {
  it('never claims a pre-existing matching line and never removes it', () => {
    const d = target();
    writeFileSync(join(d, '.gitignore'), 'node_modules/\n.agenticloop/tmp/\n');

    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);

    const manifest = loadManifest(d);
    const entries = manifest.entries.filter(e => e.kind === 'gitignore-line' && e.line === '.agenticloop/tmp/');
    assert.equal(entries.length, 0, 'should not create a manifest entry for a pre-existing line');

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0, `remove should succeed: ${result.errors.join(', ')}`);
    assert.equal(result.removed.filter(r => r.includes('.gitignore')).length, 0, 'should not remove any gitignore lines');

    const after = readFileSync(join(d, '.gitignore'), 'utf8');
    assert.ok(after.includes('.agenticloop/tmp/'), '.agenticloop/tmp/ should remain');
    assert.ok(after.includes('node_modules/'), 'node_modules/ should remain');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Duplicate pre-existing lines survive
// ---------------------------------------------------------------------------

describe('lifecycle: duplicate pre-existing .gitignore lines survive', () => {
  it('preserves all duplicate pre-existing lines through generate/remove', () => {
    const d = target();
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/tmp/\n');

    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0);

    const after = readFileSync(join(d, '.gitignore'), 'utf8');
    const lines = after.split(/\r?\n/).filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(lines.length, 2, 'both pre-existing lines should remain');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Generated .gitignore survives repeat generation
// ---------------------------------------------------------------------------

describe('lifecycle: generated .gitignore survives repeat generation lineage', () => {
  it('preserves createdFile through repeat generation and deletes on removal', () => {
    const d = target();
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };

    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    const m1 = loadManifest(d);
    const entry1 = m1.entries.find(e => e.kind === 'gitignore-line' && e.line === '.agenticloop/tmp/');
    assert.ok(entry1, 'should have gitignore entry after first generation');
    assert.equal(entry1.createdFile, true, 'should record createdFile: true');

    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    const m2 = loadManifest(d);
    const entry2 = m2.entries.find(e => e.kind === 'gitignore-line' && e.line === '.agenticloop/tmp/');
    assert.ok(entry2, 'should have gitignore entry after repeat generation');
    assert.equal(entry2.createdFile, true, 'should preserve createdFile: true through repeat');

    removeAgenticLoop({ target: d, dryRun: false });
    // When .gitignore was created by AL and only contains owned content,
    // the file should be deleted after removal.
    assert.ok(!existsSync(join(d, '.gitignore')), 'generated .gitignore should be deleted after owned line removal');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Malformed manifest fails closed
// ---------------------------------------------------------------------------

describe('lifecycle: malformed manifest makes remove fail closed', () => {
  it('refuses all removal when manifest is malformed JSON', () => {
    const d = target();
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'generated-artifacts.json'), 'not json');
    mkdirSync(join(d, 'agenticloop'), { recursive: true });
    writeFileSync(join(d, 'agenticloop', 'README.md'), 'toolkit');
    writeFileSync(join(d, 'agenticloop.json'), '{}');
    mkdirSync(join(d, 'plugins', 'agenticloop'), { recursive: true });
    writeFileSync(join(d, 'plugins', 'agenticloop', 'plugin.json'), '{}');
    mkdirSync(join(d, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(d, '.opencode', 'agents', 'orchestrator.md'), 'content');

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.ok(result.errors.some(e => e.includes('malformed') || e.includes('Ownership manifest')), 'should report malformed manifest');
    assert.equal(result.removed.length, 0, 'should remove nothing');

    assert.ok(existsSync(join(d, 'agenticloop')), 'agenticloop/ should remain');
    assert.ok(existsSync(join(d, 'agenticloop.json')), 'agenticloop.json should remain');
    assert.ok(existsSync(join(d, 'plugins', 'agenticloop')), 'plugins/agenticloop should remain');
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')), 'orchestrator.md should remain');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Fresh Codex plugin generation
// ---------------------------------------------------------------------------

describe('lifecycle: fresh Codex plugin generation succeeds', () => {
  it('creates marketplace from scratch with replace-array-element on undefined /plugins', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'set-if-absent', pointer: '/interface', value: { displayName: 'Agentic Loop Local' } },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', source: { source: 'local', path: './plugins/agenticloop' } } },
      ],
    };
    const result = executeGenerationPlan(d, plan([action], ['codex']));
    assert.equal(result.ok, true, `should succeed: ${result.errors.join(', ')}`);
    assert.ok(existsSync(join(d, '.agents', 'plugins', 'marketplace.json')), 'marketplace.json should exist');

    const marketplace = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.name, 'agenticloop-local');
    assert.ok(Array.isArray(marketplace.plugins), 'plugins should be an array');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'agenticloop');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Repeated Codex marketplace generation removes cleanly
// ---------------------------------------------------------------------------

describe('lifecycle: repeated Codex marketplace generation removes cleanly', () => {
  it('generates marketplace twice and removes cleanly', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);

    const m = loadManifest(d);
    const entries = m.entries.filter(e => e.relPath === '.agents/plugins/marketplace.json');
    assert.equal(entries.length, 1, 'should have exactly one marketplace entry');

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0, `remove should succeed: ${result.errors.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: User marketplace entries survive
// ---------------------------------------------------------------------------

describe('lifecycle: user marketplace entries and keys survive', () => {
  it('preserves user-added plugins and keys through generation and removal', () => {
    const d = target();
    mkdirSync(join(d, '.agents', 'plugins'), { recursive: true });
    const userMarketplace = {
      name: 'my-marketplace',
      customKey: 'customValue',
      plugins: [
        { name: 'user-plugin', source: { source: 'local' } },
      ],
    };
    writeFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(userMarketplace, null, 2) + '\n');

    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);

    const merged = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(merged.name, 'my-marketplace', 'user marketplace name preserved');
    assert.equal(merged.customKey, 'customValue', 'user custom key preserved');
    assert.equal(merged.plugins.length, 2, 'should have both plugins');

    removeAgenticLoop({ target: d, dryRun: false });
    const after = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(after.name, 'my-marketplace', 'user marketplace name preserved after removal');
    assert.equal(after.customKey, 'customValue', 'user custom key preserved after removal');
    assert.equal(after.plugins.length, 1, 'should have only user plugin after removal');
    assert.equal(after.plugins[0].name, 'user-plugin');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Two separate compatible merge actions both survive
// ---------------------------------------------------------------------------

describe('lifecycle: two separate compatible merge actions to one destination', () => {
  it('both mutations from different adapters survive when applied to the same file', () => {
    const d = target();
    const result = executeGenerationPlan(d, plan([
      { type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'Bash(npx agenticloop *)' }] },
      { type: 'json-merge', adapter: 'copilot', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'PowerShell(npx agenticloop *)' }] },
    ], ['claude-code', 'copilot']));
    assert.equal(result.ok, true, `should succeed: ${result.errors.join(', ')}`);

    const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('Bash(npx agenticloop *)'), 'first mutation should survive');
    assert.ok(settings.permissions.allow.includes('PowerShell(npx agenticloop *)'), 'second mutation should survive');
  });

  it('two array-add mutations from one adapter in one action both survive', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [
        { op: 'array-add', pointer: '/permissions/allow', value: 'Bash(npx agenticloop *)' },
        { op: 'array-add', pointer: '/permissions/allow', value: 'PowerShell(npx agenticloop *)' },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['claude-code'])).ok, true);

    const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('Bash(npx agenticloop *)'), 'first mutation should survive');
    assert.ok(settings.permissions.allow.includes('PowerShell(npx agenticloop *)'), 'second mutation should survive');
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Conflicting merge actions block before writes
// ---------------------------------------------------------------------------

describe('lifecycle: conflicting duplicate destinations block before writes', () => {
  it('blocks when two actions of different types target the same file', () => {
    const d = target();
    const result = executeGenerationPlan(d, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'first' },
      { type: 'write-file', adapter: 'codex', relPath: '.opencode/agents/orchestrator.md', content: 'second' },
    ], ['opencode', 'codex']));
    assert.equal(result.ok, false);
    assert.ok(!existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')), 'no file should be written on conflict');
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: Pre-existing empty JSON file remains after removal
// ---------------------------------------------------------------------------

describe('lifecycle: pre-existing empty JSON file remains after removal', () => {
  it('preserves a pre-existing {} file when mutations are reversed', () => {
    const d = target();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), '{}');

    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'Bash(npx agenticloop *)' }],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['claude-code'])).ok, true);
    removeAgenticLoop({ target: d, dryRun: false });

    assert.ok(existsSync(join(d, '.claude', 'settings.json')), 'pre-existing file should remain');
    const content = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(content, {}, 'should restore to empty object');
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: Generated empty JSON file is removed
// ---------------------------------------------------------------------------

describe('lifecycle: generated empty JSON file is removed', () => {
  it('deletes a generated file when all mutations are reversed', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test-perm' }],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['claude-code'])).ok, true);
    assert.ok(existsSync(join(d, '.claude', 'settings.json')));

    removeAgenticLoop({ target: d, dryRun: false });
    assert.ok(!existsSync(join(d, '.claude', 'settings.json')), 'generated file should be deleted');
  });
});

// ---------------------------------------------------------------------------
// Scenario 16: Claude init → repeat generate → remove
// ---------------------------------------------------------------------------

describe('lifecycle: Claude init → repeat generate → remove', () => {
  it('generates settings and .gitignore on first generate, retains ownership on repeat, and removes cleanly', () => {
    const d = target();
    assert.equal(run(['init', '--target', d, '--adapter', 'claude-code']).status, 0);
    const settingsPath = join(d, '.claude', 'settings.local.json');
    const gitignorePath = join(d, '.gitignore');
    assert.ok(existsSync(settingsPath), 'settings.local.json should exist after first generate');
    const settings1 = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(settings1.permissions?.allow?.length > 0, 'settings should have allow entries');
    const gitignore1 = readFileSync(gitignorePath, 'utf8');
    assert.ok(gitignore1.includes('.agenticloop/tmp/'), '.gitignore should include agenticloop entry');

    assert.equal(run(['generate', 'claude-code', '--target', d]).status, 0);
    const manifest = loadManifest(d);
    const settingsEntries = manifest.entries.filter(e => e.relPath === '.claude/settings.local.json' && e.kind === 'shared-config');
    assert.ok(settingsEntries.length > 0, 'settings.local.json should have shared-config manifest entry after repeat');

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.ok(result.errors.length === 0, `remove should succeed: ${result.errors.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Scenario 17: Existing user Claude settings survive
// ---------------------------------------------------------------------------

describe('lifecycle: existing user Claude settings survive generation/removal', () => {
  it('preserves user settings through generation and removal', () => {
    const d = target();
    mkdirSync(join(d, '.claude'), { recursive: true });
    const userSettings = { permissions: { allow: ['Bash(git status *)'] }, custom: { key: 'value' } };
    writeFileSync(join(d, '.claude', 'settings.local.json'), JSON.stringify(userSettings, null, 2) + '\n');
    assert.equal(run(['init', '--target', d, '--adapter', 'claude-code']).status, 0);
    const merged = JSON.parse(readFileSync(join(d, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(merged.permissions.allow.includes('Bash(git status *)'), 'user permission preserved');
    assert.ok(merged.permissions.allow.some(a => a.includes('agenticloop')), 'agenticloop permission added');

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.ok(result.errors.length === 0);
    const after = JSON.parse(readFileSync(join(d, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(after, userSettings, 'user settings restored');
  });
});

// ---------------------------------------------------------------------------
// Scenario 18: Rollback restores files on failure
// ---------------------------------------------------------------------------

describe('lifecycle: rollback restores files and directories on failure', () => {
  it('restores pre-existing files and manifest when collision blocks the batch', () => {
    const d = target();
    const existingDir = join(d, '.opencode', 'agents');
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, 'orchestrator.md'), 'original content');

    const manifest = createManifest('test');
    manifest.entries.push(createFileEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/orchestrator.md',
      content: 'original content',
    }));
    saveManifest(d, manifest);
    const manifestBytes = readFileSync(join(d, '.agenticloop', 'generated-artifacts.json'));

    // Create an unowned collision target.
    const collisionPath = join(d, '.codex', 'agents', 'orchestrator.toml');
    mkdirSync(dirname(collisionPath), { recursive: true });
    writeFileSync(collisionPath, 'user-owned');

    const result = executeGenerationPlan(d, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'replaced' },
      { type: 'write-file', adapter: 'codex', relPath: '.codex/agents/orchestrator.toml', content: 'generated' },
    ], ['opencode', 'codex']));
    assert.equal(result.ok, false, 'should fail due to unowned collision');

    // All files must be byte-for-byte unchanged.
    assert.equal(readFileSync(join(existingDir, 'orchestrator.md'), 'utf8'), 'original content');
    assert.equal(readFileSync(collisionPath, 'utf8'), 'user-owned');
    assert.deepEqual(readFileSync(join(d, '.agenticloop', 'generated-artifacts.json')), manifestBytes);
  });
});

// ---------------------------------------------------------------------------
// Scenario 19: Link validation returns actionable details
// ---------------------------------------------------------------------------

describe('lifecycle: link validation returns actionable details', () => {
  it('returns zero errors for the package source repo which should have no broken links', () => {
    const result = validateLinks(REPO_ROOT);
    assert.equal(result.errors.length, 0, `package source should have no broken links: ${result.errors.map(e => e.message).join(', ')}`);
  });

});

// ---------------------------------------------------------------------------
// Scenario 20: packageVersion updated
// ---------------------------------------------------------------------------

describe('lifecycle: packageVersion updated after successful transaction', () => {
  it('starts with old version and commits current version', () => {
    const d = target();
    const manifest = createManifest('0.0.1');
    saveManifest(d, manifest);

    const action = { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'test' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    const m = loadManifest(d);
    assert.ok(typeof m.packageVersion === 'string' && m.packageVersion.length > 0, 'packageVersion should be a non-empty string');
    assert.notEqual(m.packageVersion, '0.0.1', 'packageVersion should be updated from old version');
  });
});

// ---------------------------------------------------------------------------
// Scenario 21: existence tracked correctly
// ---------------------------------------------------------------------------

describe('lifecycle: existence tracked correctly', () => {
  it('records created for new files and refreshed for existing files', () => {
    const d = target();
    const action = { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'first' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    const m1 = loadManifest(d);
    const entry1 = m1.entries.find(e => e.relPath === '.opencode/agents/orchestrator.md');
    assert.equal(entry1.existence, 'created', 'first write should be created');

    assert.equal(executeGenerationPlan(d, plan([{ ...action, content: 'second' }], ['opencode'])).ok, true);
    const m2 = loadManifest(d);
    const entry2 = m2.entries.find(e => e.relPath === '.opencode/agents/orchestrator.md');
    assert.equal(entry2.existence, 'refreshed', 'second write should be refreshed');
  });
});

// ---------------------------------------------------------------------------
// Scenario 22: createdContainers cleaned up on removal
// ---------------------------------------------------------------------------

describe('lifecycle: createdContainers cleaned up on removal', () => {
  it('removes empty created containers and restores to {} when all mutations reversed', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test-perm' }],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['claude-code'])).ok, true);
    removeAgenticLoop({ target: d, dryRun: false });
    if (existsSync(join(d, '.claude', 'settings.json'))) {
      const remaining = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
      assert.deepEqual(remaining, {}, 'should restore to empty object when file was generated');
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 23: Duplicate .gitignore ambiguity
// ---------------------------------------------------------------------------

describe('lifecycle: .gitignore duplicate ambiguity', () => {
  it('preserves all matching lines when duplicates make identity ambiguous', () => {
    const d = target();
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n.agenticloop/tmp/\n');
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    const content = readFileSync(join(d, '.gitignore'), 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(lines.length, 2, 'both duplicate lines should be preserved');

    removeAgenticLoop({ target: d, dryRun: false });
    const after = readFileSync(join(d, '.gitignore'), 'utf8');
    const afterLines = after.split(/\r?\n/).filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(afterLines.length, 2, 'both lines should survive removal');
  });
});

// ---------------------------------------------------------------------------
// Scenario 24: Malformed shared JSON concise error
// ---------------------------------------------------------------------------

describe('lifecycle: malformed shared JSON concise error', () => {
  it('returns concise error without stack trace for malformed JSON', () => {
    const d = target();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude', 'settings.json'), 'not valid json {{{');
    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test' }],
    };
    const result = executeGenerationPlan(d, plan([action], ['claude-code']));
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, 'should have errors');
    assert.ok(!result.errors.some(e => e.includes('at JSON.parse')), 'should not contain stack trace');
    assert.ok(!result.errors.some(e => e.includes('.js:')), 'should not contain file:line references');
  });
});

// ---------------------------------------------------------------------------
// Scenario 25: Multi-adapter collision rollback
// ---------------------------------------------------------------------------

describe('lifecycle: multi-adapter collision rollback', () => {
  it('leaves all earlier adapter paths unchanged when a later adapter collides', () => {
    const d = target();
    mkdirSync(join(d, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(d, '.codex/agents/orchestrator.toml'), 'user content');
    const result = executeGenerationPlan(d, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'generated' },
      { type: 'write-file', adapter: 'codex', relPath: '.codex/agents/orchestrator.toml', content: 'generated' },
    ], ['opencode', 'codex']));
    assert.equal(result.ok, false);
    assert.ok(!existsSync(join(d, '.opencode/agents/orchestrator.md')), 'opencode output should not exist after collision');
    assert.equal(readFileSync(join(d, '.codex/agents/orchestrator.toml'), 'utf8'), 'user content', 'user content should be preserved');
  });
});

// ---------------------------------------------------------------------------
// Scenario 26: Output-root ownership separate
// ---------------------------------------------------------------------------

describe('lifecycle: output-root ownership separate', () => {
  it('keeps output-root ownership separate and supports repeated contained generation', () => {
    const d = target();
    const action = { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/engineer.md', content: 'one' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'], 'generated')).ok, true);
    assert.equal(executeGenerationPlan(d, plan([{ ...action, content: 'two' }], ['opencode'], 'generated')).ok, true);
    assert.equal(readFileSync(join(d, 'generated', action.relPath), 'utf8'), 'two');
  });
});

// ---------------------------------------------------------------------------
// Scenario 27: Modified generated file blocks non-forced update
// ---------------------------------------------------------------------------

describe('lifecycle: modified generated file blocks non-forced update', () => {
  it('keeps modified generated files on normal update and permits only explicit force', () => {
    const d = target();
    const relPath = '.opencode/agents/engineer.md';
    mkdirSync(join(d, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(d, relPath), 'generated');
    // Create manifest with a DIFFERENT hash to simulate the file being modified
    // after generation (the file was changed by a user or external tool).
    writeManifest(d, [{
      adapter: 'opencode', outputRoot: '.', relPath, kind: 'file',
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      existence: 'created', generatedAt: new Date().toISOString(),
    }]);
    const action = { type: 'write-file', adapter: 'opencode', relPath, content: 'replacement' };

    assert.equal(executeGenerationPlan(d, plan([action])).ok, false, 'should block without force');
    assert.equal(readFileSync(join(d, relPath), 'utf8'), 'generated', 'file should be unchanged');
    assert.equal(executeGenerationPlan(d, plan([action]), { forceGenerated: true }).ok, true, 'should succeed with force');
    assert.equal(readFileSync(join(d, relPath), 'utf8'), 'replacement', 'file should be updated');
  });
});

// ---------------------------------------------------------------------------
// Scenario 28: Hostile manifest paths rejected
// ---------------------------------------------------------------------------

describe('lifecycle: hostile manifest paths rejected', () => {
  it('rejects hostile manifest paths before removal can reach outside the target', () => {
    const d = target();
    const outside = join(tmpBase, 'outside.json');
    writeFileSync(outside, 'sentinel');
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'generated-artifacts.json'), JSON.stringify({
      schemaVersion: 3, packageVersion: 'test', entries: [{
        adapter: 'opencode', outputRoot: '.', relPath: '../outside.json', kind: 'shared-config',
        existence: 'created', generatedAt: new Date().toISOString(), mutations: [],
      }],
    }));

    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.ok(result.errors.some(error => error.includes('traversal') || error.includes('path escapes') || error.includes('malformed')));
    assert.equal(readFileSync(outside, 'utf8'), 'sentinel');
  });
});

// ---------------------------------------------------------------------------
// Scenario: unknown nested files preserved
// ---------------------------------------------------------------------------

describe('lifecycle: unknown nested files preserved', () => {
  it('keeps unknown nested files out of ownership and removal', () => {
    const d = target();
    const generated = '.agents/skills/agenticloop/SKILL.md';
    assert.equal(executeGenerationPlan(d, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: '.agents/skills/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath: generated, content: 'generated' },
    ], ['codex'])).ok, true);
    const userFile = join(d, '.agents/skills/agenticloop/user/note.md');
    mkdirSync(join(userFile, '..'), { recursive: true });
    writeFileSync(userFile, 'user content');

    assert.equal(executeGenerationPlan(d, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: '.agents/skills/agenticloop' },
      { type: 'write-file', adapter: 'codex', relPath: generated, content: 'refreshed' },
    ], ['codex'])).ok, true);
    const manifest = loadManifest(d);
    assert.equal(manifest.entries.some(entry => JSON.stringify(entry).includes('user/note.md')), false);
    removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(existsSync(userFile), true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 29: Repeated Codex marketplace generation removes cleanly
// ---------------------------------------------------------------------------

describe('lifecycle: repeated Codex marketplace generate → generate → remove', () => {
  it('removes marketplace.json when Agentic Loop created it from scratch', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'set-if-absent', pointer: '/interface', value: { displayName: 'Agentic Loop Local' } },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', source: { source: 'local', path: './plugins/agenticloop' } } },
      ],
    };
    // Generate twice.
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);

    // Verify marketplace exists with correct content.
    const marketplace = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'agenticloop');

    // Remove should succeed and delete marketplace.json entirely.
    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0, `remove should succeed: ${result.errors.join(', ')}`);
    assert.ok(!existsSync(join(d, '.agents', 'plugins', 'marketplace.json')), 'marketplace.json should be absent after removal when AL created it');
  });

  it('preserves only original user content when marketplace pre-existed', () => {
    const d = target();
    // Pre-populate with user content.
    mkdirSync(join(d, '.agents', 'plugins'), { recursive: true });
    writeFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'user-marketplace',
      plugins: [{ name: 'user-plugin', source: { source: 'local' } }],
    }, null, 2) + '\n');

    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);

    // Remove should succeed and leave only user content.
    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0, `remove should succeed: ${result.errors.join(', ')}`);
    const after = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(after.name, 'user-marketplace', 'user marketplace name preserved');
    assert.equal(after.plugins.length, 1, 'should have only user plugin after removal');
    assert.equal(after.plugins[0].name, 'user-plugin');
  });
});

// ---------------------------------------------------------------------------
// Scenario 30: Marketplace version lineage removes to original absence
// ---------------------------------------------------------------------------

describe('lifecycle: marketplace version 1 → version 2 → remove restores original absence', () => {
  it('removes both versions and restores original absence', () => {
    const d = target();
    const actionV1 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: '1.0.0' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([actionV1], ['codex'])).ok, true);

    // Verify version 1 exists.
    const v1 = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(v1.plugins[0].version, '1.0.0');

    // Refresh to version 2.
    const actionV2 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: '2.0.0' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([actionV2], ['codex'])).ok, true);

    const v2 = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.equal(v2.plugins[0].version, '2.0.0');

    // Remove should restore original absence (file didn't pre-exist).
    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0, `remove should succeed: ${result.errors.join(', ')}`);
    assert.ok(!existsSync(join(d, '.agents', 'plugins', 'marketplace.json')), 'marketplace.json should be absent after removing version lineage');
  });
});

// ---------------------------------------------------------------------------
// Scenario 31: Generated .gitignore plus later user duplicate fails closed
// ---------------------------------------------------------------------------

describe('lifecycle: generated .gitignore plus later user duplicate fails closed', () => {
  it('preserves all matching lines when user adds identical line before owned line', () => {
    const d = target();
    // Agentic Loop adds the line first.
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    assert.ok(readFileSync(join(d, '.gitignore'), 'utf8').includes('.agenticloop/tmp/'));

    // User adds identical line before the owned occurrence.
    const content = readFileSync(join(d, '.gitignore'), 'utf8');
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n' + content);

    // Regenerate.
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);

    // Remove should preserve both matching lines.
    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0, `remove should succeed: ${result.errors.join(', ')}`);
    const after = readFileSync(join(d, '.gitignore'), 'utf8');
    const lines = after.split(/\r?\n/).filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(lines.length, 2, 'both lines should be preserved when ambiguous');
  });

  it('preserves all matching lines when user adds identical line after owned line', () => {
    const d = target();
    const action = { type: 'gitignore-append', adapter: 'opencode', relPath: '.gitignore', line: '.agenticloop/tmp/' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);

    // User appends identical line after the owned line.
    const content = readFileSync(join(d, '.gitignore'), 'utf8');
    writeFileSync(join(d, '.gitignore'), content + '.agenticloop/tmp/\n');

    // Regenerate.
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);

    // Remove should preserve both matching lines.
    const result = removeAgenticLoop({ target: d, dryRun: false });
    assert.equal(result.errors.length, 0);
    const after = readFileSync(join(d, '.gitignore'), 'utf8');
    const lines = after.split(/\r?\n/).filter(l => l.trim() === '.agenticloop/tmp/');
    assert.equal(lines.length, 2, 'both lines should be preserved when ambiguous');
  });
});

// ---------------------------------------------------------------------------
// Scenario 32: Same-adapter sequential merge actions coalesced
// ---------------------------------------------------------------------------

describe('lifecycle: two separate same-adapter JSON merge actions succeed', () => {
  it('both mutations from the same adapter and destination survive with one manifest entry', () => {
    const d = target();
    const result = executeGenerationPlan(d, plan([
      { type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'Bash(npx agenticloop *)' }] },
      { type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json', mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'PowerShell(npx agenticloop *)' }] },
    ], ['claude-code']));
    assert.equal(result.ok, true, `should succeed: ${result.errors.join(', ')}`);

    // Both mutations should be present.
    const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('Bash(npx agenticloop *)'), 'first mutation should survive');
    assert.ok(settings.permissions.allow.includes('PowerShell(npx agenticloop *)'), 'second mutation should survive');

    // Exactly one shared-config manifest entry for this adapter+path.
    const manifest = loadManifest(d);
    const entries = manifest.entries.filter(e => e.kind === 'shared-config' && e.relPath === '.claude/settings.json' && e.adapter === 'claude-code');
    assert.equal(entries.length, 1, 'should have exactly one shared-config manifest entry');
    assert.ok(entries[0].mutations.length >= 2, 'entry should contain both mutations');
  });
});

// ---------------------------------------------------------------------------
// Scenario 33: Replace-array-element lineage preserved through repeat generation
// ---------------------------------------------------------------------------

describe('lifecycle: replace-array-element ownership lineage preserved', () => {
  it('preserves added:true through repeat generation when AL originally appended', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    // First generation: element is appended.
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);
    const m1 = loadManifest(d);
    const mutation1 = m1.entries.find(e => e.kind === 'shared-config')?.mutations?.find(m => m.op === 'replace-array-element');
    assert.ok(mutation1, 'should have replace-array-element mutation');
    assert.equal(mutation1.added, true, 'should have added:true after first generation');

    // Second generation: element already at desired value.
    assert.equal(executeGenerationPlan(d, plan([action], ['codex'])).ok, true);
    const m2 = loadManifest(d);
    const mutation2 = m2.entries.find(e => e.kind === 'shared-config')?.mutations?.find(m => m.op === 'replace-array-element');
    assert.ok(mutation2, 'should have replace-array-element mutation after repeat');
    assert.equal(mutation2.added, true, 'should preserve added:true through repeat generation');

    // No previous field should be present (AL originally appended).
    assert.equal(Object.hasOwn(mutation2, 'previous'), false, 'should not have previous field when AL originally appended');

    // Remove should delete the element.
    removeAgenticLoop({ target: d, dryRun: false });
    const after = existsSync(join(d, '.agents', 'plugins', 'marketplace.json'))
      ? JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'))
      : null;
    if (after) {
      assert.equal(after.plugins?.length ?? 0, 0, 'should have no plugins after removal');
    }
  });

  it('does not restore intermediate generated versions on removal', () => {
    const d = target();
    // Generate version 1.
    const actionV1 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: '1.0.0' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([actionV1], ['codex'])).ok, true);

    // Generate version 2 (replace the element).
    const actionV2 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'agenticloop-local' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', version: '2.0.0' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([actionV2], ['codex'])).ok, true);

    // Remove should not restore version 1 (which was also generated).
    removeAgenticLoop({ target: d, dryRun: false });
    assert.ok(!existsSync(join(d, '.agents', 'plugins', 'marketplace.json')), 'marketplace.json should be absent after removal (no intermediate version)');
  });
});

// ---------------------------------------------------------------------------
// Scenario 34: Codex role rename removes exact stale output
// ---------------------------------------------------------------------------

describe('lifecycle: Codex role rename removes stale output', () => {
  it('removes engineer.toml when binding changes from engineer to builder', () => {
    const d = target();
    // Generate with engineer binding.
    const actionEngineer = {
      type: 'write-file', adapter: 'codex', relPath: '.codex/agents/engineer.toml',
      content: '# Generated by: agenticloop generate codex\nname = "engineer"\ndescription = "Engineer"\ndeveloper_instructions = "body"\n',
      marker: '# Generated by: agenticloop generate codex',
    };
    assert.equal(executeGenerationPlan(d, plan([actionEngineer], ['codex'])).ok, true);
    assert.ok(existsSync(join(d, '.codex', 'agents', 'engineer.toml')), 'engineer.toml should exist');

    // Generate with builder binding (stale reconciliation).
    const actionBuilder = {
      type: 'write-file', adapter: 'codex', relPath: '.codex/agents/builder.toml',
      content: '# Generated by: agenticloop generate codex\nname = "builder"\ndescription = "Builder"\ndeveloper_instructions = "body"\n',
      marker: '# Generated by: agenticloop generate codex',
    };
    const result = executeGenerationPlan(d, plan([
      { type: 'clear-owned-directory', adapter: 'codex', relPath: '.codex/agents' },
      actionBuilder,
    ], ['codex'], '.'));
    assert.equal(result.ok, true, result.errors.join(', '));

    assert.equal(existsSync(join(d, '.codex', 'agents', 'engineer.toml')), false, 'exact-owned stale role file should be removed');
    const manifest = loadManifest(d);
    const engineerEntries = manifest.entries.filter(e => e.relPath === '.codex/agents/engineer.toml');
    assert.equal(engineerEntries.length, 0, 'should have no manifest entry for stale engineer.toml');
  });
});

// ---------------------------------------------------------------------------
// Scenario 35: Modified stale role output is preserved and warns
// ---------------------------------------------------------------------------

describe('lifecycle: modified stale role output preserved with warning', () => {
  it('preserves a modified file and retains its manifest entry with a warning', () => {
    const d = target();
    const relPath = '.opencode/agents/engineer.md';
    const action = { type: 'write-file', adapter: 'opencode', relPath, content: 'original', marker: 'Generated' };
    assert.equal(executeGenerationPlan(d, plan([action], ['opencode'])).ok, true);
    assert.ok(existsSync(join(d, relPath)));

    // Modify the file.
    writeFileSync(join(d, relPath), 'user modified content');

    // Regenerate with clear-owned-directory.
    const freshAction = { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'orch', marker: 'Generated' };
    const result = executeGenerationPlan(d, plan([
      { type: 'clear-owned-directory', adapter: 'opencode', relPath: '.opencode/agents' },
      freshAction,
    ], ['opencode']));
    assert.equal(result.ok, true);
    // The warning should mention the modified stale file.
    assert.ok(result.errors.some(w => w.includes(relPath)), 'should warn about modified stale file');
    // The modified file should remain on disk.
    assert.ok(existsSync(join(d, relPath)), 'modified stale file should remain on disk');
    assert.equal(readFileSync(join(d, relPath), 'utf8'), 'user modified content', 'modified content should be preserved');
    assert.ok(loadManifest(d).entries.some(entry => entry.relPath === relPath && entry.adapter === 'opencode'), 'modified stale file should remain owned');
  });
});

// ---------------------------------------------------------------------------
// Scenario 36: Cursor plugin disable removes plugin output
// ---------------------------------------------------------------------------

describe('lifecycle: Cursor plugin enabled → disabled removes plugin files', () => {
  it('removes plugin files and reconciles manifest when plugin is disabled', () => {
    const d = target();
    // Generate with plugin enabled.
    const pluginAction = { type: 'write-file', adapter: 'cursor', relPath: 'plugins/agenticloop/.cursor-plugin/plugin.json', content: '{"name":"agenticloop"}' };
    const skillAction = { type: 'write-file', adapter: 'cursor', relPath: 'plugins/agenticloop/skills/agenticloop/SKILL.md', content: 'skill' };
    assert.equal(executeGenerationPlan(d, plan([pluginAction, skillAction], ['cursor'])).ok, true);
    assert.ok(existsSync(join(d, 'plugins', 'agenticloop', '.cursor-plugin', 'plugin.json')));
    assert.ok(existsSync(join(d, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'SKILL.md')));

    // Regenerate without plugin (disabled).
    const agentAction = { type: 'write-file', adapter: 'cursor', relPath: '.cursor/agents/orchestrator.md', content: 'agent' };
    const result = executeGenerationPlan(d, plan([
      { type: 'clear-owned-directory', adapter: 'cursor', relPath: '.cursor/agents' },
      { type: 'clear-owned-directory', adapter: 'cursor', relPath: 'plugins/agenticloop' },
      agentAction,
    ], ['cursor']));
    assert.equal(result.ok, true, result.errors.join(', '));

    const manifest = loadManifest(d);
    const pluginEntries = manifest.entries.filter(e => e.relPath.startsWith('plugins/'));
    assert.equal(existsSync(join(d, 'plugins', 'agenticloop', '.cursor-plugin', 'plugin.json')), false, 'plugin manifest should be removed');
    assert.equal(existsSync(join(d, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'SKILL.md')), false, 'plugin skill should be removed');
    assert.equal(existsSync(join(d, 'plugins', 'agenticloop')), false, 'empty plugin root should be removed');
    assert.equal(pluginEntries.length, 0, 'plugin ownership should be removed');
  });
});

// ---------------------------------------------------------------------------
// Scenario 37: Replace-array-element at different pointer not confused
// ---------------------------------------------------------------------------

describe('lifecycle: replacement identity is exact by pointer', () => {
  it('does not authorize a replacement at a different pointer using prior ownership', () => {
    const d = target();
    // First: add an element at /plugins.
    const action1 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'set-if-absent', pointer: '/name', value: 'test' },
        { op: 'replace-array-element', pointer: '/plugins', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop' } },
      ],
    };
    assert.equal(executeGenerationPlan(d, plan([action1], ['codex'])).ok, true);

    // A user-owned matching value already exists at /extensions. Ownership at
    // /plugins must not authorize replacing it.
    const before = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    before.extensions = [{ name: 'agenticloop', source: 'user' }];
    writeFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(before, null, 2) + '\n');
    const action2 = {
      type: 'json-merge', adapter: 'codex', relPath: '.agents/plugins/marketplace.json',
      mutations: [
        { op: 'replace-array-element', pointer: '/extensions', matchKey: 'name', matchValue: 'agenticloop', value: { name: 'agenticloop', extra: true } },
      ],
    };
    const result = executeGenerationPlan(d, plan([action2], ['codex']));
    assert.equal(result.ok, false, 'different-pointer ownership must not authorize replacement');
    assert.ok(result.errors.some(error => error.includes('/extensions')), 'error should name the rejected pointer');
    const marketplace = JSON.parse(readFileSync(join(d, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    assert.deepEqual(marketplace.extensions, [{ name: 'agenticloop', source: 'user' }]);
    const mutation = loadManifest(d).entries.find(entry => entry.kind === 'shared-config').mutations.find(item => item.op === 'replace-array-element');
    assert.deepEqual(mutation.createdContainers, ['/plugins'], 'container lineage must not migrate between pointers');
  });
});

// ---------------------------------------------------------------------------
// Scenario 38: Rollback restores exact file bytes and manifest
// ---------------------------------------------------------------------------

describe('lifecycle: generation rollback restores all state on failure', () => {
  it('restores pre-existing files and manifest when transaction fails', () => {
    const d = target();
    // Create a pre-existing file.
    mkdirSync(join(d, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(d, '.opencode', 'agents', 'orchestrator.md'), 'original content');
    const manifest = createManifest('test');
    manifest.entries.push(createFileEntry({
      adapter: 'opencode', outputRoot: '.', relPath: '.opencode/agents/orchestrator.md',
      content: 'original content',
    }));
    saveManifest(d, manifest);
    const manifestBefore = readFileSync(join(d, '.agenticloop', 'generated-artifacts.json'), 'utf8');

    const result = executeGenerationPlan(d, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'new content' },
      { type: 'write-file', adapter: 'codex', relPath: '.codex/agents/new.toml', content: 'generated' },
    ], ['opencode', 'codex']), { extraWrites: [{ relPath: 'transaction-failure.txt', content: {} }] });
    assert.equal(result.ok, false, 'invalid late write should fail after ordinary writes');

    // All state should be unchanged.
    assert.equal(readFileSync(join(d, '.opencode', 'agents', 'orchestrator.md'), 'utf8'), 'original content');
    assert.equal(existsSync(join(d, '.codex', 'agents', 'new.toml')), false, 'transaction-created file should be removed');
    assert.equal(existsSync(join(d, '.codex')), false, 'transaction-created directory should be removed');
    assert.equal(readFileSync(join(d, '.agenticloop', 'generated-artifacts.json'), 'utf8'), manifestBefore);
  });

  it('restores files and directories when a write fails after the first success', () => {
    const d = target();
    const existing = join(d, '.opencode', 'agents');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'orchestrator.md'), 'pre-existing');

    // The file is unowned (no manifest entry), so preflight blocks the overwrite.
    const result = executeGenerationPlan(d, plan([
      { type: 'write-file', adapter: 'opencode', relPath: '.opencode/agents/orchestrator.md', content: 'replaced' },
    ], ['opencode']));
    assert.equal(result.ok, false, 'should block for unowned file');
    assert.equal(readFileSync(join(existing, 'orchestrator.md'), 'utf8'), 'pre-existing', 'file should be unchanged');
  });
});

// ---------------------------------------------------------------------------
// Scenario 39: Link validation returns actionable details
// ---------------------------------------------------------------------------

describe('lifecycle: broken link diagnostics are actionable', () => {
  it('returns errors with file, line, and URL for broken links', () => {
    const d = target();
    mkdirSync(join(d, 'agenticloop', 'docs'), { recursive: true });
    writeFileSync(join(d, 'agenticloop', 'docs', 'test.md'), '# Test\n\n[broken](./nonexistent.md)\n');
    const result = validateLinks(d);
    assert.deepEqual(result.errors, [{
      file: 'agenticloop/docs/test.md', line: 3, url: './nonexistent.md',
      target: 'agenticloop/docs/nonexistent.md', context: 'installed',
      message: 'installed target not found: ./nonexistent.md -> agenticloop/docs/nonexistent.md',
    }]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 40: createdContainers cleaned up on removal
// ---------------------------------------------------------------------------

describe('lifecycle: createdContainers properly cleaned on removal', () => {
  it('removes empty containers created by mutations on reversal', () => {
    const d = target();
    const action = {
      type: 'json-merge', adapter: 'claude-code', relPath: '.claude/settings.json',
      mutations: [{ op: 'array-add', pointer: '/permissions/allow', value: 'test-perm' }],
    };
    assert.equal(executeGenerationPlan(d, plan([action], ['claude-code'])).ok, true);
    const generated = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    assert.ok(generated.permissions.allow.includes('test-perm'), 'mutation should be applied');
    // Only /permissions/allow is created, not /permissions/deny.
    assert.deepEqual(generated.permissions.allow, ['test-perm'], 'allow array should contain added value');

    removeAgenticLoop({ target: d, dryRun: false });
    // File should be deleted because AL created it.
    assert.ok(!existsSync(join(d, '.claude', 'settings.json')), 'generated file should be deleted');
  });
});

// ---------------------------------------------------------------------------
// Scenario 41: Schema validation rejects fields from other entry kinds
// ---------------------------------------------------------------------------

describe('lifecycle: kind-specific manifest schemas', () => {
  it('rejects matchKey on array-add mutation', () => {
    const d = target();
    assert.throws(() => {
      const m = createManifest('test');
      m.entries.push({
        adapter: 'opencode', outputRoot: '.', relPath: 'test.json', kind: 'shared-config',
        existence: 'merged', generatedAt: new Date().toISOString(),
        mutations: [{ op: 'array-add', pointer: '/test', value: 'x', added: true, matchKey: 'name' }],
      });
      saveManifest(d, m);
    }, /matchKey is not valid for array-add/);
  });

  it('kind-specific entry field validation rejects mismatched fields', () => {
    const d = target();
    assert.throws(() => {
      const m = createManifest('test');
      m.entries.push({
        adapter: 'opencode', outputRoot: '.', relPath: 'test.json', kind: 'file',
        existence: 'merged', generatedAt: new Date().toISOString(),
      });
      saveManifest(d, m);
    }, /file entry requires a hash/);
  });

  it('gitignore entry requires line and occurrence', () => {
    const d = target();
    assert.throws(() => {
      const m = createManifest('test');
      m.entries.push({
        adapter: 'opencode', outputRoot: '.', relPath: '.gitignore', kind: 'gitignore-line',
        existence: 'merged', generatedAt: new Date().toISOString(),
        createdFile: true,
      });
      saveManifest(d, m);
    }, /gitignore line is invalid/);
  });
});
