/**
 * Tests for enhanced model picker in src/configure-models.js.
 *
 * Covers:
 *   - buildModelChoices with and without current model
 *   - buildReasoningEffortChoices per host
 *   - Cancel, skip, keep, custom, and catalog actions
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import {
  buildModelChoices,
  buildReasoningEffortChoices,
  createPrompts,
  promptModelSettingsInteractive,
} from '../src/configure-models.js';

// ---------------------------------------------------------------------------
// buildModelChoices
// ---------------------------------------------------------------------------

describe('buildModelChoices', () => {
  it('includes catalog entries for opencode orchestrator', () => {
    const { choices, text } = buildModelChoices('opencode', 'orchestrator');
    assert.ok(choices.length > 3);
    assert.ok(choices.some(c => c.action === 'catalog'));
    assert.ok(choices.some(c => c.action === 'custom'));
    assert.ok(choices.some(c => c.action === 'skip'));
    assert.ok(choices.some(c => c.action === 'cancel'));
    assert.ok(text.includes('Custom model ID'));
    assert.ok(text.includes('Skip'));
    assert.ok(text.includes('Cancel'));
  });

  it('offers catalog choices plus a custom path for the auditor role', () => {
    for (const host of ['opencode', 'codex', 'claude-code', 'copilot', 'cursor']) {
      const { choices } = buildModelChoices(host, 'auditor');
      assert.ok(choices.some(c => c.action === 'catalog'), `${host} should offer auditor catalog choices`);
      assert.ok(choices.some(c => c.action === 'custom'), `${host} should keep the custom-model path for auditor`);
    }
  });

  it('includes keep-current when current model is set', () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator', 'existing/model');
    const keepChoice = choices.find(c => c.action === 'keep');
    assert.ok(keepChoice, 'should have a keep choice');
    assert.equal(keepChoice.index, 0);
    assert.ok(keepChoice.label.includes('existing/model'));
    assert.equal(keepChoice.value, 'existing/model');
  });

  it('does not include keep-current without current model', () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator');
    assert.ok(!choices.some(c => c.action === 'keep'));
  });

  it('includes claude-code catalog entries', () => {
    const { choices } = buildModelChoices('claude-code', 'orchestrator');
    assert.ok(choices.some(c => c.action === 'catalog'));
    assert.ok(choices.some(c => c.value && c.value.includes('claude')));
  });

  it('always includes custom and cancel', () => {
    const { choices } = buildModelChoices('copilot', 'engineer');
    assert.ok(choices.some(c => c.action === 'custom'));
    assert.ok(choices.some(c => c.action === 'cancel'));
  });

  it('uses discovered entries instead of the bundled catalog when provided', () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator', null, {
      modelEntries: [
        {
          id: 'live/provider-model',
          label: 'live/provider-model',
          provider: 'live',
          hosts: ['opencode'],
          roleSuitability: ['orchestrator'],
          supportsReasoningEffort: true,
          source: 'host-native:opencode',
          observedAt: '2026-06-23',
        },
      ],
    });

    const catalogChoices = choices.filter(choice => choice.action === 'catalog');
    assert.deepEqual(catalogChoices.map(choice => choice.value), ['live/provider-model']);
  });
});

// ---------------------------------------------------------------------------
// buildReasoningEffortChoices
// ---------------------------------------------------------------------------

describe('buildReasoningEffortChoices', () => {
  it('returns codex effort choices', () => {
    const { choices, text } = buildReasoningEffortChoices('codex');
    assert.ok(choices.length > 0);
    assert.ok(choices.some(c => c.value === 'high'));
    assert.ok(choices.some(c => c.value === 'xhigh'));
    assert.ok(choices.some(c => c.value === 'minimal'));
    assert.ok(text.includes('high'));
  });

  it('codex does not offer max', () => {
    const { choices } = buildReasoningEffortChoices('codex');
    assert.ok(!choices.some(c => c.value === 'max'));
  });

  it('returns the exact opencode effort choices in order', () => {
    const { choices } = buildReasoningEffortChoices('opencode');
    assert.deepEqual(
      choices.map(c => [c.index, c.action, c.value]),
      [
        [0, 'default', null],
        [1, 'select', 'low'],
        [2, 'select', 'medium'],
        [3, 'select', 'high'],
        [4, 'select', 'xhigh'],
        [5, 'select', 'max'],
      ]
    );
  });

  it('opencode labels the default choice as omitting reasoningEffort/variant', () => {
    const { choices, text } = buildReasoningEffortChoices('opencode');
    const defaultChoice = choices.find(c => c.action === 'default');
    assert.equal(defaultChoice.index, 0);
    assert.match(defaultChoice.label, /Default - omit reasoningEffort\/variant/);
    assert.match(text, /0\. Default - omit reasoningEffort\/variant/);
  });

  it('opencode does not offer minimal', () => {
    const { choices, text } = buildReasoningEffortChoices('opencode');
    assert.ok(!choices.some(c => c.value === 'minimal'));
    assert.ok(!text.includes('minimal'));
  });

  it('returns empty for claude-code', () => {
    const { choices, text } = buildReasoningEffortChoices('claude-code');
    assert.equal(choices.length, 0);
    assert.equal(text, '');
  });

  it('returns empty for copilot', () => {
    const { choices } = buildReasoningEffortChoices('copilot');
    assert.equal(choices.length, 0);
  });

  it('keeps keep-current distinct from default when current effort is set', () => {
    const { choices } = buildReasoningEffortChoices('opencode', 'high');
    const defaultChoice = choices.find(c => c.action === 'default');
    const keepChoice = choices.find(c => c.action === 'keep');
    assert.ok(defaultChoice);
    assert.ok(keepChoice);
    assert.notEqual(defaultChoice.index, keepChoice.index);
    assert.equal(keepChoice.value, 'high');
    assert.ok(keepChoice.label.includes('high'));
  });
});

// ---------------------------------------------------------------------------
// createPrompts.write
// ---------------------------------------------------------------------------

describe('createPrompts write method', () => {
  it('write does not consume input', async () => {
    const inputLines = ['1\n'];
    const input = Readable.from(inputLines);
    let written = '';
    const output = new Writable({
      write(chunk, _enc, cb) { written += chunk; cb(); },
    });

    const prompts = createPrompts(input, output);
    prompts.write('Note: stale catalog.\n');
    const answer = await prompts.ask('Choice: ');
    prompts.close();

    assert.ok(written.includes('Note: stale catalog.'));
    assert.equal(answer, '1');
  });
});

// ---------------------------------------------------------------------------
// promptModelSettingsInteractive
// ---------------------------------------------------------------------------

describe('promptModelSettingsInteractive', () => {
  function makePipedPrompts(lines) {
    const input = Readable.from([lines.join('\n') + '\n']);
    let written = '';
    const output = new Writable({
      write(chunk, _enc, cb) { written += chunk; cb(); },
    });
    const prompts = createPrompts(input, output);
    return { prompts, getOutput: () => written };
  }

  it('selects a catalog model by index', async () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator');
    const catalogChoice = choices.find(c => c.action === 'catalog');
    assert.ok(catalogChoice, 'should have a catalog choice');

    const lines = [
      String(catalogChoice.index),  // select catalog model for orchestrator
      '',                            // skip reasoning effort
      'n',                           // do not apply to remaining
      String(catalogChoice.index),  // select same for maintainer
      '',                            // skip reasoning effort
      'n',                           // do not apply to remaining
      String(catalogChoice.index),  // select same for engineer
      '',                            // skip reasoning effort
    ];
    const { prompts } = makePipedPrompts(lines);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator', 'maintainer', 'engineer'], 'opencode', prompts, {}
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.ok(mutations.length > 0);
    assert.equal(mutations[0].model, catalogChoice.value);
  });

  it('cancel returns empty mutations', async () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator');
    const cancelChoice = choices.find(c => c.action === 'cancel');

    const { prompts } = makePipedPrompts([String(cancelChoice.index)]);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator', 'maintainer', 'engineer'], 'opencode', prompts, {}
    );
    prompts.close();

    assert.equal(cancelled, true);
    assert.equal(mutations.length, 0);
  });

  it('skip leaves no mutation for that role', async () => {
    const skipIndex = role => buildModelChoices('opencode', role).choices.find(c => c.action === 'skip').index;

    const lines = [
      String(skipIndex('orchestrator')),  // skip orchestrator
      String(skipIndex('maintainer')),    // skip maintainer
      String(skipIndex('engineer')),      // skip engineer
    ];
    const { prompts } = makePipedPrompts(lines);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator', 'maintainer', 'engineer'], 'opencode', prompts, {}
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.equal(mutations.length, 0);
  });

  it('custom model ID entry works', async () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator');
    const customChoice = choices.find(c => c.action === 'custom');

    const lines = [
      String(customChoice.index),   // select custom
      'my-private/model-v1',        // enter custom ID
      '',                            // skip reasoning effort
      'y',                           // apply to remaining
    ];
    const { prompts } = makePipedPrompts(lines);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator', 'maintainer', 'engineer'], 'opencode', prompts, {}
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.ok(mutations.some(m => m.model === 'my-private/model-v1'));
    // apply-to-remaining should set all roles
    assert.equal(mutations.length, 3);
  });

  it('keep-current with existing setting', async () => {
    const currentSettings = {
      orchestrator: { model: 'existing/model' },
    };
    const { choices } = buildModelChoices('opencode', 'orchestrator', 'existing/model');
    const keepChoice = choices.find(c => c.action === 'keep');
    const skipIndex = role => buildModelChoices('opencode', role).choices.find(c => c.action === 'skip').index;

    const lines = [
      String(keepChoice.index),    // keep current for orchestrator
      '',                          // keep current reasoning/default
      String(skipIndex('maintainer')), // skip maintainer
      String(skipIndex('engineer')),   // skip engineer
    ];
    const { prompts } = makePipedPrompts(lines);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator', 'maintainer', 'engineer'], 'opencode', prompts, currentSettings
    );
    prompts.close();

    assert.equal(cancelled, false);
    // keep-current should not create a mutation
    assert.ok(!mutations.some(m => m.role === 'orchestrator'));
  });

  it('can keep the current model while resetting reasoning to default', async () => {
    const currentSettings = {
      engineer: { model: 'existing/model', reasoningEffort: 'high' },
    };
    const keepModel = buildModelChoices(
      'opencode',
      'engineer',
      currentSettings.engineer.model
    ).choices.find(choice => choice.action === 'keep');
    const { prompts } = makePipedPrompts([
      String(keepModel.index),
      '0',
    ]);

    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['engineer'],
      'opencode',
      prompts,
      currentSettings
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.deepEqual(mutations, [
      { role: 'engineer', clearReasoningEffort: true },
    ]);
  });

  it('can discover OpenCode models during interactive prompting', async () => {
    const { prompts, getOutput } = makePipedPrompts([
      '1', // select discovered model
      '',  // skip reasoning effort
    ]);

    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator'],
      'opencode',
      prompts,
      {},
      {
        discoverModels: true,
        modelDiscoveryRunner: () => ({
          status: 0,
          stdout: 'provider/live-model\n',
          stderr: '',
        }),
      }
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.deepEqual(mutations, [
      { role: 'orchestrator', model: 'provider/live-model' },
    ]);
    assert.ok(getOutput().includes('Discovered 1 opencode model(s)'));
  });

  it('can discover Cursor models during interactive prompting', async () => {
    const { prompts, getOutput } = makePipedPrompts([
      '1', // select first discovered model
    ]);

    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator'],
      'cursor',
      prompts,
      {},
      {
        discoverModels: true,
        modelDiscoveryRunner: () => ({
          status: 0,
          stdout: 'auto - Auto (current)\ngpt-5.4 - GPT 5.4\n',
          stderr: '',
        }),
      }
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.deepEqual(mutations, [
      { role: 'orchestrator', model: 'auto' },
    ]);
    assert.ok(getOutput().includes('Discovered 2 cursor model(s)'));
  });

  it('can discover Codex models during interactive prompting', async () => {
    const { prompts, getOutput } = makePipedPrompts([
      '1', // select first discovered model
      '',  // skip reasoning effort
    ]);

    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator'],
      'codex',
      prompts,
      {},
      {
        discoverModels: true,
        modelDiscoveryRunner: () => ({
          status: 0,
          stdout: JSON.stringify({ models: [{ slug: 'o3', displayName: 'o3' }] }),
          stderr: '',
        }),
      }
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.deepEqual(mutations, [
      { role: 'orchestrator', model: 'o3' },
    ]);
    assert.ok(getOutput().includes('Discovered 1 codex model(s)'));
  });

  it('choosing default produces an explicit clearReasoningEffort mutation', async () => {
    const { choices } = buildModelChoices('opencode', 'engineer');
    const catalogChoice = choices.find(c => c.action === 'catalog');

    const { prompts } = makePipedPrompts([
      String(catalogChoice.index),  // select a catalog model for engineer
      '0',                          // reasoning effort: Default (unset)
    ]);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['engineer'],
      'opencode',
      prompts,
      { engineer: { model: 'old/model', reasoningEffort: 'high' } }
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].role, 'engineer');
    assert.equal(mutations[0].clearReasoningEffort, true);
    assert.equal(mutations[0].reasoningEffort, undefined);
  });

  it('choosing an explicit opencode xhigh or max sets reasoningEffort', async () => {
    for (const [input, expected] of [['4', 'xhigh'], ['5', 'max']]) {
      const { choices } = buildModelChoices('opencode', 'engineer');
      const catalogChoice = choices.find(c => c.action === 'catalog');

      const { prompts } = makePipedPrompts([
        String(catalogChoice.index),
        input,
      ]);
      const { mutations, cancelled } = await promptModelSettingsInteractive(
        ['engineer'],
        'opencode',
        prompts,
        {}
      );
      prompts.close();

      assert.equal(cancelled, false);
      assert.equal(mutations[0].reasoningEffort, expected);
      assert.equal(mutations[0].clearReasoningEffort, undefined);
    }
  });

  it('apply-to-remaining propagates the default/unset choice', async () => {
    const { choices } = buildModelChoices('opencode', 'orchestrator');
    const catalogChoice = choices.find(c => c.action === 'catalog');

    const { prompts } = makePipedPrompts([
      String(catalogChoice.index),  // orchestrator model
      '0',                          // orchestrator reasoning: Default (unset)
      'y',                          // apply same to remaining roles
    ]);
    const { mutations, cancelled } = await promptModelSettingsInteractive(
      ['orchestrator', 'maintainer', 'engineer'],
      'opencode',
      prompts,
      {
        maintainer: { model: 'old/maintainer', reasoningEffort: 'high' },
        engineer: { model: 'old/engineer', reasoningEffort: 'max' },
      }
    );
    prompts.close();

    assert.equal(cancelled, false);
    assert.equal(mutations.length, 3);
    for (const mutation of mutations) {
      assert.equal(mutation.clearReasoningEffort, true);
      assert.equal(mutation.reasoningEffort, undefined);
    }
  });
});
