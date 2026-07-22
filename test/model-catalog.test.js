/**
 * Tests for src/model-catalog.js.
 *
 * Covers:
 *   - getCatalogEntries filtering by host and role
 *   - getAllCatalogEntries returns all entries
 *   - checkCatalogFreshness metadata
 *   - getReasoningEffortChoices per host
 *   - formatCatalogChoice display
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverModelEntries,
  getCatalogEntries,
  getAllCatalogEntries,
  getCatalogObservedAt,
  checkCatalogFreshness,
  getReasoningEffortChoices,
  formatCatalogChoice,
  parseOpenCodeModelsOutput,
  parseCursorModelsOutput,
  parseCodexModelsOutput,
} from '../src/model-catalog.js';

// ---------------------------------------------------------------------------
// getCatalogEntries
// ---------------------------------------------------------------------------

describe('getCatalogEntries', () => {
  it('returns entries for opencode host', () => {
    const entries = getCatalogEntries('opencode');
    assert.ok(entries.length > 0);
    assert.ok(entries.every(e => e.hosts.includes('opencode')));
  });

  it('returns entries for claude-code host', () => {
    const entries = getCatalogEntries('claude-code');
    assert.ok(entries.length > 0);
    assert.ok(entries.every(e => e.hosts.includes('claude-code')));
  });

  it('filters by role when specified', () => {
    const entries = getCatalogEntries('opencode', 'engineer');
    assert.ok(entries.length > 0);
    assert.ok(entries.every(e => e.roleSuitability.includes('engineer')));
  });

  it('returns empty for unknown host', () => {
    const entries = getCatalogEntries('unknown-host');
    assert.equal(entries.length, 0);
  });

  it('keeps Codex GPT-5.6 IDs bare and OpenCode GPT-5.6 IDs provider-qualified', () => {
    const codex = getCatalogEntries('codex').filter(entry => entry.id.includes('gpt-5.6-'));
    const opencode = getCatalogEntries('opencode').filter(entry => entry.id.includes('gpt-5.6-'));

    assert.deepEqual(codex.map(entry => entry.id).sort(), [
      'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
    ]);
    assert.deepEqual(opencode.map(entry => entry.id).sort(), [
      'openai/gpt-5.6-luna', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra',
    ]);
    assert.ok(codex.every(entry => !entry.id.includes('/')));
    assert.ok(opencode.every(entry => entry.id.startsWith('openai/')));
  });

  it('offers GPT-5.6 Sol for maintainers and engineers, but not orchestrators', () => {
    for (const host of ['codex', 'opencode']) {
      const sol = getCatalogEntries(host).find(entry => entry.id.endsWith('gpt-5.6-sol'));
      assert.deepEqual(sol.roleSuitability, ['maintainer', 'engineer']);
    }

    assert.ok(getCatalogEntries('codex', 'engineer').some(entry => entry.id === 'gpt-5.6-sol'));
    assert.ok(getCatalogEntries('opencode', 'engineer').some(entry => entry.id === 'openai/gpt-5.6-sol'));
    assert.ok(!getCatalogEntries('codex', 'orchestrator').some(entry => entry.id === 'gpt-5.6-sol'));
    assert.ok(!getCatalogEntries('opencode', 'orchestrator').some(entry => entry.id === 'openai/gpt-5.6-sol'));
  });

  it('marks native Claude Code catalog entries as not supporting reasoning effort', () => {
    assert.ok(getCatalogEntries('claude-code').every(entry => entry.supportsReasoningEffort === false));
  });
});

// ---------------------------------------------------------------------------
// getAllCatalogEntries
// ---------------------------------------------------------------------------

describe('getAllCatalogEntries', () => {
  it('returns all entries', () => {
    const entries = getAllCatalogEntries();
    assert.ok(entries.length > 5);
    assert.ok(entries.every(e => e.id && e.label && e.provider));
  });

  it('every entry has required fields', () => {
    const entries = getAllCatalogEntries();
    for (const entry of entries) {
      assert.ok(typeof entry.id === 'string');
      assert.ok(typeof entry.label === 'string');
      assert.ok(typeof entry.provider === 'string');
      assert.ok(Array.isArray(entry.hosts));
      assert.ok(Array.isArray(entry.roleSuitability));
      assert.ok(typeof entry.supportsReasoningEffort === 'boolean');
      assert.ok(typeof entry.source === 'string');
      assert.ok(typeof entry.observedAt === 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCode discovery
// ---------------------------------------------------------------------------

describe('parseOpenCodeModelsOutput', () => {
  it('parses provider/model identifiers from plain and decorated output', () => {
    const entries = parseOpenCodeModelsOutput([
      'anthropic/claude-sonnet-4-6',
      '  - openrouter/anthropic/claude-opus-4-8',
      'text without a model',
      'anthropic/claude-sonnet-4-6',
    ].join('\n'));

    assert.deepEqual(entries.map(entry => entry.id), [
      'anthropic/claude-sonnet-4-6',
      'openrouter/anthropic/claude-opus-4-8',
    ]);
    assert.ok(entries.every(entry => entry.source === 'host-native:opencode'));
    assert.ok(entries.every(entry => entry.hosts.includes('opencode')));
  });
});

// ---------------------------------------------------------------------------
// Cursor discovery
// ---------------------------------------------------------------------------

describe('parseCursorModelsOutput', () => {
  it('parses id - label lines from Cursor CLI output', () => {
    const entries = parseCursorModelsOutput([
      'auto - Auto (current)',
      'gpt-5.3-codex-low - Codex 5.3 Low',
      'claude-sonnet-4-6 - Claude Sonnet 4.6',
    ].join('\n'));

    assert.deepEqual(entries.map(e => e.id), [
      'auto',
      'gpt-5.3-codex-low',
      'claude-sonnet-4-6',
    ]);
    assert.deepEqual(entries.map(e => e.label), [
      'Auto',
      'Codex 5.3 Low',
      'Claude Sonnet 4.6',
    ]);
    assert.ok(entries.every(e => e.source === 'host-native:cursor'));
    assert.ok(entries.every(e => e.hosts.includes('cursor')));
    assert.ok(entries.every(e => e.supportsReasoningEffort === false));
  });

  it('skips blank and non-matching lines', () => {
    const entries = parseCursorModelsOutput([
      '',
      'Available models:',
      'auto - Auto',
      '',
    ].join('\n'));

    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'auto');
  });

  it('deduplicates by id', () => {
    const entries = parseCursorModelsOutput([
      'auto - Auto (current)',
      'auto - Auto',
    ].join('\n'));

    assert.equal(entries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Codex discovery
// ---------------------------------------------------------------------------

describe('parseCodexModelsOutput', () => {
  it('parses JSON with models array containing slug and displayName', () => {
    const entries = parseCodexModelsOutput(JSON.stringify({
      models: [
        { slug: 'o3', displayName: 'o3' },
        { slug: 'o4-mini', displayName: 'o4 Mini' },
      ],
    }));

    assert.deepEqual(entries.map(e => e.id), ['o3', 'o4-mini']);
    assert.deepEqual(entries.map(e => e.label), ['o3', 'o4 Mini']);
    assert.ok(entries.every(e => e.source === 'host-native:codex'));
    assert.ok(entries.every(e => e.hosts.includes('codex')));
    assert.ok(entries.every(e => e.supportsReasoningEffort === true));
  });

  it('accepts alternative field names id, display_name, name', () => {
    const entries = parseCodexModelsOutput(JSON.stringify({
      models: [
        { id: 'model-a', display_name: 'Model A' },
        { model: 'model-b', name: 'Model B' },
      ],
    }));

    assert.deepEqual(entries.map(e => e.id), ['model-a', 'model-b']);
    assert.deepEqual(entries.map(e => e.label), ['Model A', 'Model B']);
  });

  it('accepts a bare array', () => {
    const entries = parseCodexModelsOutput(JSON.stringify([
      { slug: 'bare-model', displayName: 'Bare' },
    ]));

    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'bare-model');
  });

  it('deduplicates by id', () => {
    const entries = parseCodexModelsOutput(JSON.stringify({
      models: [
        { slug: 'o3', displayName: 'o3' },
        { slug: 'o3', displayName: 'o3 duplicate' },
      ],
    }));

    assert.equal(entries.length, 1);
  });

  it('returns empty for invalid JSON', () => {
    const entries = parseCodexModelsOutput('not json');
    assert.deepEqual(entries, []);
  });

  it('returns empty for unexpected shape', () => {
    const entries = parseCodexModelsOutput(JSON.stringify({ something: 'else' }));
    assert.deepEqual(entries, []);
  });
});

// ---------------------------------------------------------------------------
// discoverModelEntries
// ---------------------------------------------------------------------------

describe('discoverModelEntries', () => {
  it('uses injected OpenCode runner output when available', () => {
    const result = discoverModelEntries('opencode', {
      runner: () => ({
        status: 0,
        stdout: 'anthropic/claude-sonnet-4-6\nopenai/gpt-5.4\n',
        stderr: '',
      }),
    });

    assert.deepEqual(result.entries.map(entry => entry.id), [
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5.4',
    ]);
    assert.equal(result.source, 'host-native:opencode');
    assert.deepEqual(result.warnings, []);
  });

  it('discovers Cursor models via injected runner', () => {
    let capturedCommand, capturedArgs;
    const result = discoverModelEntries('cursor', {
      runner: (cmd, args) => {
        capturedCommand = cmd;
        capturedArgs = args;
        return {
          status: 0,
          stdout: 'auto - Auto (current)\ngpt-5.4 - GPT 5.4\n',
          stderr: '',
        };
      },
    });

    assert.equal(capturedCommand, 'agent');
    assert.deepEqual(capturedArgs, ['models']);
    assert.deepEqual(result.entries.map(e => e.id), ['auto', 'gpt-5.4']);
    assert.equal(result.source, 'host-native:cursor');
    assert.deepEqual(result.warnings, []);
  });

  it('discovers Codex models via injected runner', () => {
    let capturedCommand, capturedArgs;
    const result = discoverModelEntries('codex', {
      runner: (cmd, args) => {
        capturedCommand = cmd;
        capturedArgs = args;
        return {
          status: 0,
          stdout: JSON.stringify({ models: [{ slug: 'o3', displayName: 'o3' }] }),
          stderr: '',
        };
      },
    });

    assert.equal(capturedCommand, 'codex');
    assert.deepEqual(capturedArgs, ['debug', 'models']);
    assert.deepEqual(result.entries.map(e => e.id), ['o3']);
    assert.equal(result.source, 'host-native:codex');
    assert.deepEqual(result.warnings, []);
  });

  it('returns non-fatal empty result for unsupported hosts', () => {
    for (const host of ['claude-code', 'copilot']) {
      const result = discoverModelEntries(host, {
        runner: () => { throw new Error('must not be called'); },
      });

      assert.deepEqual(result.entries, [], `${host} should return empty entries`);
      assert.equal(result.source, null, `${host} should return null source`);
      assert.deepEqual(result.warnings, [], `${host} should return no warnings`);
    }
  });

  it('returns warnings on nonzero exit status', () => {
    for (const host of ['opencode', 'cursor', 'codex']) {
      const result = discoverModelEntries(host, {
        runner: () => ({ status: 1, stdout: '', stderr: 'not found' }),
      });

      assert.deepEqual(result.entries, []);
      assert.ok(result.warnings.length > 0, `${host} should have a warning`);
      assert.ok(result.warnings[0].includes('not found'));
    }
  });

  it('returns warnings on thrown runner errors', () => {
    for (const host of ['opencode', 'cursor', 'codex']) {
      const result = discoverModelEntries(host, {
        runner: () => { throw new Error('spawn failed'); },
      });

      assert.deepEqual(result.entries, []);
      assert.ok(result.warnings.length > 0, `${host} should have a warning`);
      assert.ok(result.warnings[0].includes('spawn failed'));
    }
  });
});

// ---------------------------------------------------------------------------
// checkCatalogFreshness
// ---------------------------------------------------------------------------

describe('checkCatalogFreshness', () => {
  it('returns freshness metadata', () => {
    const result = checkCatalogFreshness();
    assert.ok(typeof result.stale === 'boolean');
    assert.ok(typeof result.observedAt === 'string');
    assert.ok(typeof result.ageMonths === 'number');
  });

  it('observedAt matches catalog constant', () => {
    const result = checkCatalogFreshness();
    assert.equal(result.observedAt, getCatalogObservedAt());
  });
});

// ---------------------------------------------------------------------------
// getReasoningEffortChoices
// ---------------------------------------------------------------------------

describe('getReasoningEffortChoices', () => {
  it('returns values for codex', () => {
    const choices = getReasoningEffortChoices('codex');
    assert.ok(choices.length > 0);
    assert.ok(choices.includes('high'));
    assert.ok(choices.includes('xhigh'));
  });

  it('returns values for opencode', () => {
    const choices = getReasoningEffortChoices('opencode');
    assert.ok(choices.length > 0);
    assert.ok(choices.includes('high'));
  });

  it('returns empty for claude-code', () => {
    const choices = getReasoningEffortChoices('claude-code');
    assert.equal(choices.length, 0);
  });

  it('returns empty for copilot', () => {
    const choices = getReasoningEffortChoices('copilot');
    assert.equal(choices.length, 0);
  });

  it('returns empty for cursor', () => {
    const choices = getReasoningEffortChoices('cursor');
    assert.equal(choices.length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatCatalogChoice
// ---------------------------------------------------------------------------

describe('formatCatalogChoice', () => {
  it('formats a catalog entry with index', () => {
    const entry = { label: 'Test Model', id: 'provider/test-model' };
    const result = formatCatalogChoice(entry, 1);
    assert.ok(result.includes('1.'));
    assert.ok(result.includes('Test Model'));
    assert.ok(result.includes('provider/test-model'));
  });
});
