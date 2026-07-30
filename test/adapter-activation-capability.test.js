import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  generateClaudeCodeArtifacts,
  CLAUDE_CODE_ACTIVATION_ADAPTER_ID,
  CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID,
} from '../src/adapters/claude-code.js';
import { generateCodexArtifacts, CODEX_ACTIVATION_ADAPTER_ID } from '../src/adapters/codex.js';
import {
  generateCopilotArtifacts,
  COPILOT_ACTIVATION_ADAPTER_ID,
  COPILOT_PROMPT_RELATIVE_PATH,
  COPILOT_SKILL_RELATIVE_PATH,
} from '../src/adapters/copilot.js';
import { generateCursorArtifacts, CURSOR_ACTIVATION_ADAPTER_ID } from '../src/adapters/cursor.js';
import { generateOpencodeArtifacts, OPENCODE_ACTIVATION_ADAPTER_ID } from '../src/adapters/opencode.js';
import { planAdapterArtifacts } from '../src/adapter-generation.js';
import {
  ADAPTER_SLOT_IDS,
  emptyAdapterSlot,
  fillUnsupportedActivationSlots,
  locateAdapterSlot,
  validateFilledAdapterSlots,
  validateStaticPluginCommandSlots,
} from '../src/adapter-slots.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';

/**
 * Every activation surface Agentic Loop ships, as an exact set.
 *
 * A count threshold ("at least five") cannot fail when a surface is dropped or
 * silently added, which is exactly how the Copilot IDE prompt shipped as a live
 * activation surface carrying no typed declaration. These are compared as exact
 * sets so both directions of drift break the build.
 */
const PLANNER_ACTIVATION_SURFACES = Object.freeze([
  '.agents/skills/agenticloop/SKILL.md',
  '.claude/commands/agenticloop.md',
  '.claude/skills/agenticloop/SKILL.md',
  '.cursor/skills/agenticloop/SKILL.md',
  '.github/prompts/agenticloop.prompt.md',
  '.github/skills/agenticloop/SKILL.md',
  '.opencode/commands/agenticloop.md',
]);

/**
 * Claude Code Mode A. `.claude-plugin/plugin.json` registers `commands/start.md`
 * directly as `/agenticloop:start`, so it is a live command the host substitutes
 * - not a template the planner renders. It is inventoried separately because no
 * planner action produces it.
 */
const CLAUDE_PLUGIN_REGISTERED_COMMAND = 'commands/start.md';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-adapter-activation-')); });
after(() => rmSync(temp, { recursive: true, force: true }));

function files(root, result = []) {
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files(path, result);
    else result.push(path);
  }
  return result;
}

describe('shipped adapter activation projection', () => {
  const adapters = [
    ['opencode', generateOpencodeArtifacts, OPENCODE_ACTIVATION_ADAPTER_ID],
    ['claude-code', generateClaudeCodeArtifacts, CLAUDE_CODE_ACTIVATION_ADAPTER_ID],
    ['codex', generateCodexArtifacts, CODEX_ACTIVATION_ADAPTER_ID],
    ['copilot', generateCopilotArtifacts, COPILOT_ACTIVATION_ADAPTER_ID],
    ['cursor', generateCursorArtifacts, CURSOR_ACTIVATION_ADAPTER_ID],
  ];
  for (const [name, generate, adapterId] of adapters) {
    it(`${name} fills both shared slots with its typed unsupported capability`, () => {
      const target = mkdtempSync(join(temp, `${name}-target-`));
      const output = mkdtempSync(join(temp, `${name}-output-`));
      seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
      generate(loadAgenticLoopConfig(join(target, 'agenticloop.json')), target, output);
      const activationArtifacts = files(output)
        .filter(path => /\.(md|toml)$/i.test(path))
        .map(path => readFileSync(path, 'utf8'))
        .filter(text => text.includes('AGENTICLOOP_ADAPTER_SLOT:activation_capability'));
      assert.ok(activationArtifacts.length > 0);
      for (const text of activationArtifacts) {
        assert.match(text, new RegExp(adapterId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(text, /Activation capture capability: `unsupported`/);
        assert.doesNotMatch(text, /AGENTICLOOP_ADAPTER_SLOT:activation_capability -->\s*<!--/);
        assert.doesNotMatch(text, /AGENTICLOOP_ADAPTER_SLOT:requested_input -->\s*<!--/);
        assert.doesNotMatch(text, /\$ARGUMENTS|\$1|\$2/);
        assert.match(text, /advisory/i);
      }
    });
  }
});

describe('production planner activation surfaces', () => {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  it('all five adapters fill both slots through the shared production planner', () => {
    const target = mkdtempSync(join(temp, 'planner-target-'));
    seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
    const alConfig = loadAgenticLoopConfig(join(target, 'agenticloop.json'));
    const planned = planAdapterArtifacts({ target, alConfig, adapter: 'all' });
    assert.equal(planned.ok, true, planned.errors.join('\n'));
    const activationActions = planned.plan.actions.filter(action =>
      action.type === 'write-file' &&
      typeof action.content === 'string' &&
      action.content.includes('AGENTICLOOP_ADAPTER_SLOT:activation_capability'));
    // Exact inventory, not a count threshold: adding or omitting an activation
    // surface must fail here rather than pass silently.
    assert.deepEqual(
      [...activationActions.map(action => action.relPath)].sort(),
      [...PLANNER_ACTIVATION_SURFACES],
      'the planner activation-surface inventory changed'
    );
    for (const action of activationActions) {
      for (const slotId of ADAPTER_SLOT_IDS) {
        assert.ok(
          locateAdapterSlot(action.content, slotId).inner.trim(),
          `${action.relPath} must carry non-empty '${slotId}' slot content`
        );
      }
      assert.match(action.content, /Activation capture capability: `unsupported`/, action.relPath);
      assert.match(action.content, /advisory/i, action.relPath);
      assert.doesNotMatch(action.content, /\$ARGUMENTS|\$1|\$2/, action.relPath);
    }
    // The Claude Code planner path is the exact production command surface;
    // it must carry the same fail-closed declaration as direct generation.
    const claudeCommand = activationActions.find(action => action.relPath === '.claude/commands/agenticloop.md');
    assert.ok(claudeCommand, 'planner must render the Claude Code activation command');
    assert.match(claudeCommand.content, new RegExp(escape(CLAUDE_CODE_ACTIVATION_ADAPTER_ID)));
  });

  it('init --adapter claude-code writes the filled unsupported declaration to a clean fixture', async () => {
    const target = mkdtempSync(join(temp, 'claude-init-'));
    const run = await runCliInProcess(['init', '--adapter', 'claude-code', '--target', target]);
    assert.equal(run.status, 0, run.stderr);
    const commandPath = join(target, '.claude', 'commands', 'agenticloop.md');
    assert.ok(existsSync(commandPath), 'init must write .claude/commands/agenticloop.md');
    const text = readFileSync(commandPath, 'utf8');
    assert.match(text, new RegExp(escape(CLAUDE_CODE_ACTIVATION_ADAPTER_ID)));
    assert.match(text, /Activation capture capability: `unsupported`/);
    assert.match(text, /advisory only/i);
    for (const slotId of ADAPTER_SLOT_IDS) {
      assert.ok(locateAdapterSlot(text, slotId).inner.trim(), `slot '${slotId}' must exist once with content`);
    }
    assert.match(text, /Requested task or context: use the current user request or selected task id as advisory context\./);
    assert.doesNotMatch(text, /\$ARGUMENTS|\$1|\$2/);
  });

  it('init for every adapter renders every one of its activation surfaces', async () => {
    // Per-adapter expectations are the exact subset of the shared inventory that
    // adapter owns, so an adapter that stops emitting one of its own surfaces
    // fails here even while the others still pass.
    const expectations = {
      'opencode': ['.opencode/commands/agenticloop.md'],
      'claude-code': ['.claude/commands/agenticloop.md', '.claude/skills/agenticloop/SKILL.md'],
      'codex': ['.agents/skills/agenticloop/SKILL.md'],
      'copilot': ['.github/skills/agenticloop/SKILL.md', '.github/prompts/agenticloop.prompt.md'],
      'cursor': ['.cursor/skills/agenticloop/SKILL.md'],
    };
    assert.deepEqual(
      [...new Set(Object.values(expectations).flat())].sort(),
      [...PLANNER_ACTIVATION_SURFACES],
      'per-adapter init expectations must cover the exact planner inventory'
    );
    for (const [adapter, relPaths] of Object.entries(expectations)) {
      const target = mkdtempSync(join(temp, `init-${adapter}-`));
      const init = await runCliInProcess(['init', '--adapter', adapter, '--target', target]);
      assert.equal(init.status, 0, `${adapter}: ${init.stderr}`);
      for (const relPath of relPaths) {
        const surfacePath = join(target, ...relPath.split('/'));
        assert.ok(existsSync(surfacePath), `${adapter} must render ${relPath}`);
        const text = readFileSync(surfacePath, 'utf8');
        for (const slotId of ADAPTER_SLOT_IDS) {
          assert.ok(locateAdapterSlot(text, slotId).inner.trim(), `${relPath} slot '${slotId}' must exist once with content`);
        }
        assert.match(text, /Activation capture capability: `unsupported`/, relPath);
        assert.match(text, /advisory/i, relPath);
        assert.doesNotMatch(text, /\$ARGUMENTS|\$1|\$2/, relPath);
        assert.deepEqual(validateFilledAdapterSlots(text, relPath), [], relPath);
      }
    }
  });
});

describe('Claude Code Mode A registered plugin command', () => {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const canonicalStartPath = join(REPO_ROOT, ...CLAUDE_PLUGIN_REGISTERED_COMMAND.split('/'));

  it('is registered by the plugin manifest as a live command, not an inert template', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.ok(
      manifest.commands.includes(`./${CLAUDE_PLUGIN_REGISTERED_COMMAND}`),
      `.claude-plugin/plugin.json must register ./${CLAUDE_PLUGIN_REGISTERED_COMMAND}`
    );
    assert.ok(existsSync(canonicalStartPath), `${CLAUDE_PLUGIN_REGISTERED_COMMAND} must exist`);
  });

  it('declares its own unsupported capture capability with advisory-only arguments', () => {
    const [, body] = parseFrontmatter(readFileSync(canonicalStartPath, 'utf8'));
    const capability = locateAdapterSlot(body, 'activation_capability').inner;
    assert.ok(capability.trim(), 'the default activation slot must not ship empty');
    // A distinct identity: Mode A is registered by the host, Mode B is rendered
    // by the adapter, and conflating them would misreport which surface ran.
    assert.match(capability, new RegExp(escape(`Activation adapter: \`${CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID}\`.`)));
    assert.notEqual(CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID, CLAUDE_CODE_ACTIVATION_ADAPTER_ID);
    assert.doesNotMatch(capability, new RegExp(escape(CLAUDE_CODE_ACTIVATION_ADAPTER_ID)));
    assert.match(capability, /Activation capture capability: `unsupported`\./);
    assert.match(capability, /advisory/i);
    assert.match(capability, /never activation proof/i);
    assert.deepEqual(
      validateStaticPluginCommandSlots(body, CLAUDE_PLUGIN_REGISTERED_COMMAND, CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID),
      []
    );
  });

  it('retains exactly one $ARGUMENTS and only inside the requested-input slot', () => {
    const [, body] = parseFrontmatter(readFileSync(canonicalStartPath, 'utf8'));
    assert.equal((body.match(/\$ARGUMENTS/g) ?? []).length, 1, 'Claude substitution needs exactly one token');
    assert.equal((body.match(/\$\d+/g) ?? []).length, 0, 'no raw positional placeholders');
    assert.match(locateAdapterSlot(body, 'requested_input').inner, /\$ARGUMENTS/);
    assert.doesNotMatch(locateAdapterSlot(body, 'activation_capability').inner, /\$ARGUMENTS/);
  });

  it('rejects a static command that moves, duplicates, or drops its declaration', () => {
    const [, body] = parseFrontmatter(readFileSync(canonicalStartPath, 'utf8'));
    const label = CLAUDE_PLUGIN_REGISTERED_COMMAND;
    const id = CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID;

    // A second token, even a legal-looking one, reintroduces ambiguity.
    const duplicated = `${body}\n\nRequested again: \`$ARGUMENTS\`\n`;
    assert.match(validateStaticPluginCommandSlots(duplicated, label, id).join('\n'), /exactly one '\$ARGUMENTS'/);

    // The registered command must retain the host substitution point; a
    // declaration with no token is complete-looking but cannot receive the
    // requested task or context.
    const omitted = body.replace('`$ARGUMENTS`', '`current request`');
    assert.match(validateStaticPluginCommandSlots(omitted, label, id).join('\n'), /exactly one '\$ARGUMENTS'/);

    // Substituted text must never build the capability declaration itself.
    const moved = body.replace(
      'Activation capture capability: `unsupported`.',
      'Activation capture capability: `unsupported`. $ARGUMENTS'
    ).replace('Requested task or context: `$ARGUMENTS`', 'Requested task or context: the current request');
    assert.match(
      validateStaticPluginCommandSlots(moved, label, id).join('\n'),
      /must appear only inside the 'requested_input' slot/
    );

    const positional = body.replace('`$ARGUMENTS`', '`$1`');
    assert.match(validateStaticPluginCommandSlots(positional, label, id).join('\n'), /raw positional placeholders/);

    const supported = body.replace('Activation capture capability: `unsupported`.', 'Activation capture capability: `supported`.');
    assert.match(validateStaticPluginCommandSlots(supported, label, id).join('\n'), /must declare capture capability `unsupported`/);

    const wrongId = body.replace(id, 'attacker.adapter.v1');
    assert.match(validateStaticPluginCommandSlots(wrongId, label, id).join('\n'), /must declare adapter/);

    const emptied = body
      .replace(locateAdapterSlot(body, 'activation_capability').inner, '\n')
      .replace('Requested task or context: `$ARGUMENTS`', '');
    assert.match(validateStaticPluginCommandSlots(emptied, label, id).join('\n'), /must not be empty/);
  });

  it('keeps the shared generated-artifact rule strict about the same placeholder', () => {
    // The static-command rule must not become a global relaxation: a generated
    // surface carrying `$ARGUMENTS` still fails the shared validator.
    const [, body] = parseFrontmatter(readFileSync(canonicalStartPath, 'utf8'));
    assert.match(
      validateFilledAdapterSlots(body, 'generated surface').join('\n'),
      /must not contain raw '\$ARGUMENTS'/
    );
  });

  it('installs a filled, unambiguous canonical mirror into a fresh target', async () => {
    const target = mkdtempSync(join(temp, 'mode-a-mirror-'));
    const init = await runCliInProcess(['init', '--adapter', 'claude-code', '--target', target]);
    assert.equal(init.status, 0, init.stderr);
    const mirrorPath = join(target, 'agenticloop', 'commands', 'start.md');
    assert.ok(existsSync(mirrorPath), 'init must install agenticloop/commands/start.md');
    const [, mirrorBody] = parseFrontmatter(readFileSync(mirrorPath, 'utf8'));
    assert.deepEqual(
      validateStaticPluginCommandSlots(mirrorBody, 'agenticloop/commands/start.md', CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID),
      [],
      'the installed canonical mirror must carry the complete filled declaration'
    );
    const validated = await runCliInProcess(['validate', '--target', target]);
    assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
  });

  it('lets every generated Claude Code surface overwrite both slots with Mode B identity', () => {
    const target = mkdtempSync(join(temp, 'mode-b-target-'));
    seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
    const planned = planAdapterArtifacts({
      target,
      alConfig: loadAgenticLoopConfig(join(target, 'agenticloop.json')),
      adapter: 'claude-code',
    });
    assert.equal(planned.ok, true, planned.errors.join('\n'));
    const surfaces = planned.plan.actions.filter(action =>
      action.type === 'write-file' &&
      typeof action.content === 'string' &&
      action.content.includes('AGENTICLOOP_ADAPTER_SLOT:activation_capability'));
    assert.deepEqual(
      [...surfaces.map(action => action.relPath)].sort(),
      ['.claude/commands/agenticloop.md', '.claude/skills/agenticloop/SKILL.md']
    );
    for (const action of surfaces) {
      assert.match(action.content, new RegExp(escape(CLAUDE_CODE_ACTIVATION_ADAPTER_ID)), action.relPath);
      // Mode A's default declaration must be fully replaced, not appended to.
      assert.doesNotMatch(action.content, new RegExp(escape(CLAUDE_CODE_PLUGIN_ACTIVATION_ADAPTER_ID)), action.relPath);
      assert.doesNotMatch(action.content, /\$ARGUMENTS|\$1|\$2/, action.relPath);
      assert.deepEqual(validateFilledAdapterSlots(action.content, action.relPath), [], action.relPath);
    }
  });
});

describe('Copilot IDE prompt activation fallback', () => {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function assertTypedCopilotActivation(text, label) {
    for (const slotId of ADAPTER_SLOT_IDS) {
      const open = (text.match(new RegExp(escape(`<!-- AGENTICLOOP_ADAPTER_SLOT:${slotId} -->`)), 'g') ?? []).length;
      assert.equal(open, 1, `${label} must open slot '${slotId}' exactly once`);
      assert.ok(locateAdapterSlot(text, slotId).inner.trim(), `${label} slot '${slotId}' must be non-empty`);
    }
    assert.match(text, new RegExp(escape(`Activation adapter: \`${COPILOT_ACTIVATION_ADAPTER_ID}\`.`)), label);
    assert.match(text, /Activation capture capability: `unsupported`\./, label);
    assert.match(text, /advisory only/i, label);
    assert.match(text, /never be serialized as activation proof/i, label);
    assert.doesNotMatch(text, /\$ARGUMENTS|\$1|\$2/, label);
    assert.deepEqual(validateFilledAdapterSlots(text, label), [], label);
  }

  it('carries the typed declaration through the production planner', () => {
    const target = mkdtempSync(join(temp, 'copilot-prompt-plan-'));
    seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
    const planned = planAdapterArtifacts({
      target,
      alConfig: loadAgenticLoopConfig(join(target, 'agenticloop.json')),
      adapter: 'copilot',
    });
    assert.equal(planned.ok, true, planned.errors.join('\n'));
    const prompt = planned.plan.actions.find(action => action.relPath === COPILOT_PROMPT_RELATIVE_PATH);
    assert.ok(prompt, 'the planner must render the Copilot IDE prompt');
    assertTypedCopilotActivation(prompt.content, COPILOT_PROMPT_RELATIVE_PATH);
  });

  it('cannot drift from the Copilot public skill declaration', () => {
    const target = mkdtempSync(join(temp, 'copilot-drift-'));
    seedTargetLayout(REPO_ROOT, target, { includeDocs: false, includeScratch: false });
    const planned = planAdapterArtifacts({
      target,
      alConfig: loadAgenticLoopConfig(join(target, 'agenticloop.json')),
      adapter: 'copilot',
    });
    assert.equal(planned.ok, true, planned.errors.join('\n'));
    const find = relPath => planned.plan.actions.find(action => action.relPath === relPath);
    const prompt = find(COPILOT_PROMPT_RELATIVE_PATH);
    const skill = find(COPILOT_SKILL_RELATIVE_PATH);
    assert.ok(prompt && skill);
    // Both surfaces render the identical capability block from one shared
    // declaration, so a change to either has to change both.
    assert.equal(
      locateAdapterSlot(prompt.content, 'activation_capability').inner,
      locateAdapterSlot(skill.content, 'activation_capability').inner
    );
    assert.equal(
      locateAdapterSlot(prompt.content, 'requested_input').inner,
      locateAdapterSlot(skill.content, 'requested_input').inner
    );
  });

  it('carries the typed declaration after init into a clean fixture', async () => {
    const target = mkdtempSync(join(temp, 'copilot-prompt-init-'));
    const init = await runCliInProcess(['init', '--adapter', 'copilot', '--target', target]);
    assert.equal(init.status, 0, init.stderr);
    const promptPath = join(target, ...COPILOT_PROMPT_RELATIVE_PATH.split('/'));
    assert.ok(existsSync(promptPath), `init must write ${COPILOT_PROMPT_RELATIVE_PATH}`);
    assertTypedCopilotActivation(readFileSync(promptPath, 'utf8'), COPILOT_PROMPT_RELATIVE_PATH);
    const validated = await runCliInProcess(['validate', '--target', target]);
    assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
  });

  it('fails installed validation when the prompt loses its typed declaration', async () => {
    const target = mkdtempSync(join(temp, 'copilot-prompt-strip-'));
    const init = await runCliInProcess(['init', '--adapter', 'copilot', '--target', target]);
    assert.equal(init.status, 0, init.stderr);
    const promptPath = join(target, ...COPILOT_PROMPT_RELATIVE_PATH.split('/'));
    const text = readFileSync(promptPath, 'utf8');
    writeFileSync(
      promptPath,
      text.replace(locateAdapterSlot(text, 'activation_capability').inner, '\n'),
      'utf8'
    );
    const validated = await runCliInProcess(['validate', '--target', target]);
    assert.equal(validated.status, 1, 'an untyped prompt surface must fail validation');
    assert.match(`${validated.stdout}\n${validated.stderr}`, /agenticloop\.prompt\.md/);
  });

  it('builds its slots through the shared helpers rather than hand-written markers', () => {
    // The prompt composes its own short body, so the helper contract it depends
    // on is asserted directly.
    const composed = fillUnsupportedActivationSlots(
      [emptyAdapterSlot('activation_capability'), 'body', emptyAdapterSlot('requested_input')].join('\n'),
      { adapterId: 'test.adapter.v1', limitation: 'Test limitation.', requestedInput: 'Requested: advisory context.' }
    );
    assert.match(composed, /Activation adapter: `test\.adapter\.v1`\./);
    assert.match(composed, /Activation capture capability: `unsupported`\./);
    assert.deepEqual(validateFilledAdapterSlots(composed, 'composed'), []);
    assert.throws(() => emptyAdapterSlot('not_a_slot'), /unknown adapter slot/);
  });
});
