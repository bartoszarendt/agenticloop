/**
 * CLI-level tests for `agenticloop update` adapter model preservation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../src/frontmatter.js';
import { loadJsonFile } from '../src/json.js';
import { configureModels } from '../src/configure-models.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-update-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTarget(adapter) {
  const d = mkdtempSync(join(tmpDir, 'target-'));
  execFileSync(process.execPath, [BIN, 'init', '--target', d, '--adapter', adapter], {
    encoding: 'utf-8',
  });
  return d;
}

function runAgenticLoop(args) {
  const result = runAgenticLoopResult(args);
  assert.equal(
    result.status,
    0,
    `expected command to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout;
}

function runAgenticLoopResult(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

function readFrontmatter(filePath) {
  const [frontmatter] = parseFrontmatter(readFileSync(filePath, 'utf-8'));
  return frontmatter;
}

function writeAgent(filePath, lines) {
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

describe('update preserves adapter artifact model settings', () => {
  it('backfills OpenCode agent model settings before upgrade regenerates markdown agents', () => {
    const d = makeTarget('opencode');
    const orchestratorPath = join(d, '.opencode', 'agents', 'orchestrator.md');
    const maintainerPath = join(d, '.opencode', 'agents', 'maintainer.md');

    writeAgent(orchestratorPath, [
      '---',
      'description: "Orchestrator"',
      'mode: "primary"',
      'model: "target/open-code-orchestrator"',
      'variant: "high"',
      'permission:',
      '  edit: deny',
      '  task:',
      '    "*": deny',
      '    maintainer: allow',
      '    engineer: allow',
      '---',
      '',
      'body',
    ]);
    writeAgent(maintainerPath, [
      '---',
      'description: "Maintainer"',
      'mode: "subagent"',
      'model: "target/open-code-maintainer"',
      'variant: "max"',
      '---',
      '',
      'body',
    ]);

    const out = runAgenticLoop(['upgrade', '--target', d, '--force-generated']);

    assert.match(out, /preserved: adapters\.opencode\.roleSettings\.orchestrator\.model/);
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.opencode.roleSettings.orchestrator.model, 'target/open-code-orchestrator');
    assert.equal(cfg.adapters.opencode.roleSettings.orchestrator.reasoningEffort, 'high');
    assert.equal(cfg.adapters.opencode.roleSettings.maintainer.model, 'target/open-code-maintainer');
    assert.equal(cfg.adapters.opencode.roleSettings.maintainer.reasoningEffort, 'max');

    const regenerated = readFrontmatter(orchestratorPath);
    assert.equal(regenerated.model, 'target/open-code-orchestrator');
    assert.equal(regenerated.variant, 'high');
  });

  it('updates managed OpenCode variant when configure models changes reasoningEffort', () => {
    const d = makeTarget('opencode');

    runAgenticLoop([
      'configure', 'models',
      '--target', d,
      '--adapter', 'opencode',
      '--role', 'engineer',
      '--model', 'configured/engineer',
      '--reasoning-effort', 'xhigh',
    ]);
    runAgenticLoop(['generate', 'opencode', '--target', d]);

    const regenerated = readFrontmatter(join(d, '.opencode', 'agents', 'engineer.md'));
    assert.equal(regenerated.model, 'configured/engineer');
    assert.equal(regenerated.variant, 'xhigh');
  });

  it('ignores user-owned opencode.jsonc during update', () => {
    const d = makeTarget('opencode');
    const ocPath = join(d, 'opencode.jsonc');
    writeFileSync(ocPath, '{"userOwned": true}\n', 'utf-8');

    runAgenticLoop(['update', '--target', d]);

    assert.equal(readFileSync(ocPath, 'utf-8'), '{"userOwned": true}\n');
    assert.ok(existsSync(join(d, '.opencode', 'agents', 'orchestrator.md')));
  });

  it('generate opencode writes the repo-local OpenCode command and no opencode.jsonc', () => {
    const d = makeTarget('opencode');
    const commandPath = join(d, '.opencode', 'commands', 'agenticloop.md');

    rmSync(commandPath, { force: true });

    runAgenticLoop(['generate', 'opencode', '--target', d]);

    const commandText = readFileSync(commandPath, 'utf-8');
    assert.match(commandText, /^agent: orchestrator$/m);
    assert.doesNotMatch(commandText, /^model:/m);
    assert.equal(existsSync(join(d, 'opencode.jsonc')), false);
  });

  it('generate opencode --output-dir writes markdown agents under the same output root', () => {
    const d = makeTarget('opencode');
    const scratchDir = join(d, 'tmp', 'generated-opencode');
    const cfgPath = join(d, 'agenticloop.json');
    writeAgent(join(d, '.opencode', 'agents', 'orchestrator.md'), [
      '---',
      'description: "Orchestrator"',
      'mode: "primary"',
      'model: "target/open-code-orchestrator"',
      'variant: "high"',
      'permission:',
      '  edit: deny',
      '  task:',
      '    "*": deny',
      '    maintainer: allow',
      '    engineer: allow',
      '---',
      '',
      'body',
    ]);
    const configBefore = readFileSync(cfgPath, 'utf-8');

    const out = runAgenticLoop(['generate', 'opencode', '--target', d, '--output-dir', scratchDir]);

    assert.doesNotMatch(out, /preserved:/);
    assert.equal(readFileSync(cfgPath, 'utf-8'), configBefore);
    assert.equal(existsSync(join(scratchDir, '.opencode', 'agents', 'orchestrator.md')), true);
    assert.equal(existsSync(join(scratchDir, '.opencode', 'commands', 'agenticloop.md')), true);
    assert.equal(existsSync(join(scratchDir, 'opencode.jsonc')), false);
  });

  it('rejects an output directory under .github/workflows', () => {
    const d = makeTarget('opencode');
    const workflowOutput = join(d, '.github', 'workflows');

    const result = runAgenticLoopResult([
      'generate', 'opencode', '--target', d, '--output-dir', workflowOutput,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\.github\/workflows.*always user-owned/i);
    assert.equal(existsSync(workflowOutput), false);
  });

  it('generate all --output-dir does not backfill target model settings', () => {
    const d = makeTarget('all');
    const scratchDir = join(d, 'tmp', 'generated-all');
    const cfgPath = join(d, 'agenticloop.json');
    writeAgent(join(d, '.opencode', 'agents', 'orchestrator.md'), [
      '---',
      'description: "Orchestrator"',
      'mode: "primary"',
      'model: "target/open-code-orchestrator"',
      'variant: "high"',
      'permission:',
      '  edit: deny',
      '  task:',
      '    "*": deny',
      '    maintainer: allow',
      '    engineer: allow',
      '---',
      '',
      'body',
    ]);
    const configBefore = readFileSync(cfgPath, 'utf-8');

    const out = runAgenticLoop(['generate', 'all', '--target', d, '--output-dir', scratchDir]);

    assert.doesNotMatch(out, /preserved:/);
    assert.equal(readFileSync(cfgPath, 'utf-8'), configBefore);
    assert.equal(existsSync(join(scratchDir, '.opencode', 'agents', 'orchestrator.md')), true);
    assert.equal(existsSync(join(scratchDir, '.codex', 'agents', 'orchestrator.toml')), true);
    assert.equal(existsSync(join(scratchDir, '.claude', 'agents', 'orchestrator.md')), true);
    assert.equal(existsSync(join(scratchDir, '.github', 'agents', 'orchestrator.agent.md')), true);
    assert.equal(existsSync(join(scratchDir, '.github', 'prompts', 'agenticloop.prompt.md')), true);
    assert.equal(existsSync(join(scratchDir, '.cursor', 'agents', 'orchestrator.md')), true);
    assert.equal(existsSync(join(scratchDir, '.cursor', 'skills', 'agenticloop', 'SKILL.md')), true);
  });

  it('update --adapter copilot generates Copilot artifacts on demand', () => {
    const d = makeTarget('opencode');

    runAgenticLoop(['update', '--target', d, '--adapter', 'copilot']);

    assert.equal(existsSync(join(d, '.github', 'agents', 'orchestrator.agent.md')), true);
    assert.equal(existsSync(join(d, '.github', 'skills', 'agenticloop', 'SKILL.md')), true);
    assert.equal(existsSync(join(d, '.github', 'prompts', 'agenticloop.prompt.md')), true);
    assert.equal(existsSync(join(d, '.github', 'copilot-instructions.md')), false);
  });

  it('generate copilot writes Copilot artifacts directly', () => {
    const d = makeTarget('opencode');

    runAgenticLoop(['generate', 'copilot', '--target', d]);

    assert.equal(existsSync(join(d, '.github', 'agents', 'orchestrator.agent.md')), true);
    assert.equal(existsSync(join(d, '.github', 'skills', 'agenticloop', 'SKILL.md')), true);
    assert.equal(existsSync(join(d, '.github', 'prompts', 'agenticloop.prompt.md')), true);
  });

  it('update --adapter cursor generates Cursor artifacts on demand', () => {
    const d = makeTarget('opencode');

    runAgenticLoop(['update', '--target', d, '--adapter', 'cursor']);

    assert.equal(existsSync(join(d, '.cursor', 'agents', 'orchestrator.md')), true);
    assert.equal(existsSync(join(d, '.cursor', 'skills', 'agenticloop', 'SKILL.md')), true);
    assert.equal(existsSync(join(d, '.cursor', 'rules')), false);
  });

  it('generate cursor writes Cursor artifacts directly', () => {
    const d = makeTarget('opencode');

    runAgenticLoop(['generate', 'cursor', '--target', d]);

    assert.equal(existsSync(join(d, '.cursor', 'agents', 'orchestrator.md')), true);
    assert.equal(existsSync(join(d, '.cursor', 'skills', 'agenticloop', 'SKILL.md')), true);
    assert.equal(existsSync(join(d, '.cursor', 'rules')), false);
  });

  it('rejects shared Codex and Cursor plugin output before generate all writes artifacts', () => {
    const d = makeTarget('all');
    const cfgPath = join(d, 'agenticloop.json');
    const cfg = loadJsonFile(cfgPath);
    cfg.adapters.codex.plugin = { enabled: true };
    cfg.adapters.cursor.plugin = { enabled: true };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');

    for (const relPath of [
      '.opencode',
      '.codex',
      '.agents',
      '.claude',
      '.github',
      '.cursor',
      'plugins',
    ]) {
      rmSync(join(d, relPath), { recursive: true, force: true });
    }

    const result = runAgenticLoopResult(['generate', 'all', '--target', d]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /adapters\.cursor\.plugin\.enabled cannot be combined with adapters\.codex\.plugin\.enabled/);
    assert.doesNotMatch(result.stderr, /at generateCursorArtifacts|Node\.js/);
    assert.equal(existsSync(join(d, '.opencode')), false);
    assert.equal(existsSync(join(d, '.codex')), false);
    assert.equal(existsSync(join(d, '.cursor')), false);
    assert.equal(existsSync(join(d, 'plugins', 'agenticloop')), false);
  });

  it('backfills Codex TOML model settings before update regenerates Codex artifacts and preserves supported reasoning effort', () => {
    const d = makeTarget('codex');
    const tomlPath = join(d, '.codex', 'agents', 'engineer.toml');
    const cfgPath = join(d, 'agenticloop.json');
    const cfgBeforeUpdate = loadJsonFile(cfgPath);
    delete cfgBeforeUpdate.adapters.codex.roleSettings.engineer;
    writeFileSync(cfgPath, JSON.stringify(cfgBeforeUpdate, null, 2) + '\n', 'utf-8');
    writeFileSync(tomlPath, [
      '# local target edit',
      'name = "engineer"',
      'description = "Engineer"',
      'model = "target/codex-engineer"',
      'model_reasoning_effort = "xhigh"',
      'developer_instructions = "body"',
      '',
    ].join('\n'), 'utf-8');

    runAgenticLoop(['update', '--target', d, '--force-generated']);

    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.codex.roleSettings.engineer.model, 'target/codex-engineer');
    assert.equal(cfg.adapters.codex.roleSettings.engineer.reasoningEffort, 'xhigh');
    const regenerated = readFileSync(tomlPath, 'utf-8');
    assert.match(regenerated, /model = "target\/codex-engineer"/);
    assert.match(regenerated, /model_reasoning_effort = "xhigh"/);
  });

  it('normalizes legacy Codex TOML model prefixes during update preservation', () => {
    const d = makeTarget('codex');
    const tomlPath = join(d, '.codex', 'agents', 'engineer.toml');
    const cfgPath = join(d, 'agenticloop.json');
    const cfgBeforeUpdate = loadJsonFile(cfgPath);
    delete cfgBeforeUpdate.adapters.codex.roleSettings.engineer;
    writeFileSync(cfgPath, JSON.stringify(cfgBeforeUpdate, null, 2) + '\n', 'utf-8');
    writeFileSync(tomlPath, [
      '# local target edit',
      'name = "engineer"',
      'description = "Engineer"',
      'model = "codex-cli/gpt-5.4"',
      'model_reasoning_effort = "high"',
      'developer_instructions = "body"',
      '',
    ].join('\n'), 'utf-8');

    runAgenticLoop(['update', '--target', d, '--force-generated']);

    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.codex.roleSettings.engineer.model, 'gpt-5.4');
    const regenerated = readFileSync(tomlPath, 'utf-8');
    assert.match(regenerated, /model = "gpt-5\.4"/);
    assert.doesNotMatch(regenerated, /codex-cli\/gpt-5\.4/);
  });

  it('backfills Claude Code frontmatter model before update regenerates agents and never carries effort', () => {
    const d = makeTarget('claude-code');
    const agentPath = join(d, '.claude', 'agents', 'maintainer.md');
    writeFileSync(agentPath, [
      '---',
      'name: "maintainer"',
      'description: "Maintainer"',
      'model: "target-claude-maintainer"',
      'effort: "max"',
      '---',
      '',
      'body',
      '',
    ].join('\n'), 'utf-8');

    runAgenticLoop(['update', '--target', d, '--force-generated']);

    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters['claude-code'].roleSettings.maintainer.model, 'target-claude-maintainer');
    assert.equal(cfg.adapters['claude-code'].roleSettings.maintainer.reasoningEffort, undefined);
    const regenerated = readFileSync(agentPath, 'utf-8');
    assert.match(regenerated, /model: "target-claude-maintainer"/);
    assert.ok(!/^effort:/m.test(regenerated), 'regenerated agent should not carry an effort field');
  });

  it('backfills Copilot frontmatter model before update regenerates agents and never carries effort', () => {
    const d = makeTarget('copilot');
    const agentPath = join(d, '.github', 'agents', 'maintainer.agent.md');
    writeFileSync(agentPath, [
      '---',
      'name: "maintainer"',
      'description: "Maintainer"',
      'model: "target-copilot-maintainer"',
      'reasoningEffort: "high"',
      '---',
      '',
      '<!-- Generated by: agenticloop generate copilot. Do not edit by hand. -->',
      '',
      'body',
      '',
    ].join('\n'), 'utf-8');

    runAgenticLoop(['update', '--target', d, '--force-generated']);

    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.copilot.roleSettings.maintainer.model, 'target-copilot-maintainer');
    assert.equal(cfg.adapters.copilot.roleSettings.maintainer.reasoningEffort, undefined);
    const regenerated = readFileSync(agentPath, 'utf-8');
    assert.match(regenerated, /model: "target-copilot-maintainer"/);
    assert.ok(!/^reasoningEffort:/m.test(regenerated), 'regenerated Copilot agent should not carry a reasoningEffort field');
    assert.ok(!/^variant:/m.test(regenerated), 'regenerated Copilot agent should not carry a variant field');
  });

  it('backfills Cursor frontmatter model before update regenerates agents and defaults other roles to inherit', () => {
    const d = makeTarget('cursor');
    const agentPath = join(d, '.cursor', 'agents', 'maintainer.md');
    writeFileSync(agentPath, [
      '---',
      'name: "maintainer"',
      'description: "Maintainer"',
      'model: "target-cursor-maintainer"',
      'readonly: false',
      'reasoningEffort: "high"',
      '---',
      '',
      '<!-- Generated by: agenticloop generate cursor. Do not edit by hand. -->',
      '',
      'body',
      '',
    ].join('\n'), 'utf-8');

    runAgenticLoop(['update', '--target', d, '--force-generated']);

    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.cursor.roleSettings.maintainer.model, 'target-cursor-maintainer');
    assert.equal(cfg.adapters.cursor.roleSettings.maintainer.reasoningEffort, undefined);
    const regenerated = readFileSync(agentPath, 'utf-8');
    assert.match(regenerated, /model: "target-cursor-maintainer"/);
    assert.ok(!/^reasoningEffort:/m.test(regenerated), 'regenerated Cursor agent should not carry a reasoningEffort field');
    assert.ok(!/^variant:/m.test(regenerated), 'regenerated Cursor agent should not carry a variant field');
    assert.match(readFileSync(join(d, '.cursor', 'agents', 'orchestrator.md'), 'utf-8'), /^model: "inherit"$/m);
  });
});

// ---------------------------------------------------------------------------
// Legacy three-role OpenCode installation: auditor migration during update
// ---------------------------------------------------------------------------

describe('legacy OpenCode auditor migration', () => {
  it('adds the auditor slot and artifact in one update, preserving settings and workflows', () => {
    const d = makeTarget('opencode');

    // Downgrade to a legacy three-role installation: no canonical auditor in
    // the installed old base configuration, no auditor role slot, no auditor
    // artifact.
    const canonicalCfgPath = join(d, 'agenticloop', 'config.json');
    const canonical = loadJsonFile(canonicalCfgPath);
    delete canonical.roles.auditor;
    writeFileSync(canonicalCfgPath, JSON.stringify(canonical, null, 2) + '\n', 'utf-8');
    rmSync(join(d, 'agenticloop', 'agents', 'auditor.md'), { force: true });
    rmSync(join(d, '.opencode', 'agents', 'auditor.md'), { force: true });

    const cfgPath = join(d, 'agenticloop.json');
    const legacyTargetCfg = loadJsonFile(cfgPath);
    legacyTargetCfg.adapters.opencode.roleSettings = {
      orchestrator: { model: 'custom/orchestrator', reasoningEffort: 'xhigh' },
      maintainer: { model: 'custom/maintainer', reasoningEffort: 'max' },
      engineer: { model: 'custom/engineer' },
    };
    writeFileSync(cfgPath, JSON.stringify(legacyTargetCfg, null, 2) + '\n', 'utf-8');

    const userWorkflowPath = join(d, '.github', 'workflows', 'ci.yml');
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    const userWorkflowBytes = 'name: user-ci\non: [push]\njobs: {}\n';
    writeFileSync(userWorkflowPath, userWorkflowBytes, 'utf-8');

    const firstUpdate = runAgenticLoop(['update', '--target', d]);
    assert.match(firstUpdate, /reconciled: adapters\.opencode\.roleSettings\.auditor/);

    // The canonical auditor definition is refreshed into the installed base.
    assert.ok(loadJsonFile(canonicalCfgPath).roles?.auditor,
      'update must refresh the canonical auditor role definition');

    // The target-owned config gains an explicit auditor slot without
    // duplicating the canonical role definition, and keeps every setting.
    const cfgAfter = loadJsonFile(cfgPath);
    assert.deepEqual(cfgAfter.adapters.opencode.roleSettings.auditor, {});
    assert.equal(cfgAfter.roles, undefined,
      'target-owned agenticloop.json must not duplicate the canonical roles block');
    assert.equal(cfgAfter.adapters.opencode.roleSettings.orchestrator.model, 'custom/orchestrator');
    assert.equal(cfgAfter.adapters.opencode.roleSettings.orchestrator.reasoningEffort, 'xhigh');
    assert.equal(cfgAfter.adapters.opencode.roleSettings.maintainer.model, 'custom/maintainer');
    assert.equal(cfgAfter.adapters.opencode.roleSettings.maintainer.reasoningEffort, 'max');
    assert.equal(cfgAfter.adapters.opencode.roleSettings.engineer.model, 'custom/engineer');

    // The auditor artifact is generated from the refreshed canonical role.
    const auditorPath = join(d, '.opencode', 'agents', 'auditor.md');
    assert.ok(existsSync(auditorPath), 'update must generate .opencode/agents/auditor.md');
    const auditorText = readFileSync(auditorPath, 'utf-8');
    assert.match(auditorText, /You are the Auditor for the target project\./);
    assert.match(auditorText, /work-unit-audit\/SKILL\.md/);

    // User-owned GitHub workflows are byte-for-byte untouched.
    assert.equal(readFileSync(userWorkflowPath, 'utf-8'), userWorkflowBytes);

    // The migrated installation validates cleanly.
    runAgenticLoop(['validate', '--target', d]);

    // A second update performs no further migration changes.
    const cfgBytesAfterFirst = readFileSync(cfgPath, 'utf-8');
    const auditorBytesAfterFirst = readFileSync(auditorPath, 'utf-8');
    const secondUpdate = runAgenticLoopResult(['update', '--target', d]);
    assert.equal(secondUpdate.status, 0,
      `second update must succeed\nstdout:\n${secondUpdate.stdout}\nstderr:\n${secondUpdate.stderr}`);
    assert.doesNotMatch(secondUpdate.stdout, /reconciled:/);
    assert.doesNotMatch(secondUpdate.stdout, /preserved:/);
    assert.equal(readFileSync(cfgPath, 'utf-8'), cfgBytesAfterFirst);
    assert.equal(readFileSync(auditorPath, 'utf-8'), auditorBytesAfterFirst);
    assert.equal(readFileSync(userWorkflowPath, 'utf-8'), userWorkflowBytes);
  });
});

// ---------------------------------------------------------------------------
// GitHub Actions workflows are never generated or modified
// ---------------------------------------------------------------------------

describe('update never touches downstream .github/workflows', () => {
  it('leaves existing user workflows byte-for-byte unchanged on update', () => {
    const d = makeTarget('opencode');
    const workflowPath = join(d, '.github', 'workflows', 'ci.yml');
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    const bytes = 'name: user-ci\non: [push]\n';
    writeFileSync(workflowPath, bytes, 'utf-8');

    runAgenticLoop(['update', '--target', d]);

    assert.equal(readFileSync(workflowPath, 'utf-8'), bytes);
  });

  it('does not create .github/workflows when absent on update', () => {
    const d = makeTarget('opencode');
    assert.equal(existsSync(join(d, '.github')), false);

    runAgenticLoop(['update', '--target', d]);

    assert.equal(existsSync(join(d, '.github', 'workflows')), false);
  });

  it('copilot generation stays inside .github/agents, .github/skills, and .github/prompts', () => {
    const d = makeTarget('opencode');
    const workflowPath = join(d, '.github', 'workflows', 'ci.yml');
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    const bytes = 'name: user-ci\non: [push]\n';
    writeFileSync(workflowPath, bytes, 'utf-8');

    runAgenticLoop(['generate', 'copilot', '--target', d]);

    assert.equal(readFileSync(workflowPath, 'utf-8'), bytes);
    assert.equal(existsSync(join(d, '.github', 'agents', 'orchestrator.agent.md')), true);
  });
});

// ---------------------------------------------------------------------------
// OpenCode reasoning default/unset lifecycle
// ---------------------------------------------------------------------------

describe('opencode reasoning default lifecycle', () => {
  it('regeneration after deleting reasoningEffort omits the variant', () => {
    const d = makeTarget('opencode');

    runAgenticLoop([
      'configure', 'models', '--target', d, '--adapter', 'opencode',
      '--role', 'engineer', '--model', 'configured/engineer', '--reasoning-effort', 'high',
    ]);
    runAgenticLoop(['generate', 'opencode', '--target', d]);
    const engineerPath = join(d, '.opencode', 'agents', 'engineer.md');
    assert.equal(readFrontmatter(engineerPath).variant, 'high');

    const deletion = configureModels(d, {
      adapter: 'opencode',
      mutations: [{ role: 'engineer', clearReasoningEffort: true }],
    });
    assert.deepEqual(deletion.errors, []);
    runAgenticLoop(['generate', 'opencode', '--target', d]);

    const regenerated = readFileSync(engineerPath, 'utf-8');
    assert.ok(!/^variant:/m.test(regenerated), 'generated OpenCode agent must omit variant after default/unset');
    assert.equal(readFrontmatter(engineerPath).model, 'configured/engineer');
  });

  it('does not resurrect a deliberately defaulted effort from a stale artifact during update', () => {
    const d = makeTarget('opencode');
    const engineerPath = join(d, '.opencode', 'agents', 'engineer.md');

    runAgenticLoop([
      'configure', 'models', '--target', d, '--adapter', 'opencode',
      '--role', 'engineer', '--model', 'configured/engineer', '--reasoning-effort', 'high',
    ]);
    runAgenticLoop(['generate', 'opencode', '--target', d]);
    assert.equal(readFrontmatter(engineerPath).variant, 'high');

    const deletion = configureModels(d, {
      adapter: 'opencode',
      mutations: [{ role: 'engineer', clearReasoningEffort: true }],
    });
    assert.deepEqual(deletion.errors, []);

    const update = runAgenticLoopResult(['update', '--target', d]);
    assert.equal(update.status, 0, `stdout:\n${update.stdout}\nstderr:\n${update.stderr}`);
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.opencode.roleSettings.engineer.reasoningEffort, undefined);
    assert.equal(cfg.adapters.opencode.roleSettings.engineer.reasoningEffortDefault, true);
    assert.equal(readFrontmatter(engineerPath).variant, undefined);
  });

  it('still backfills artifact-only reasoning for a legacy existing model slot', () => {
    const d = makeTarget('opencode');
    const cfgPath = join(d, 'agenticloop.json');
    const cfg = loadJsonFile(cfgPath);
    cfg.adapters.opencode.roleSettings.engineer = { model: 'legacy/engineer' };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    writeAgent(join(d, '.opencode', 'agents', 'engineer.md'), [
      '---',
      'description: "Engineer"',
      'mode: "subagent"',
      'model: "legacy/engineer"',
      'variant: "max"',
      '---',
      '',
      'body',
    ]);

    const update = runAgenticLoopResult(['update', '--target', d, '--force-generated']);
    assert.equal(update.status, 0, `stdout:\n${update.stdout}\nstderr:\n${update.stderr}`);
    const after = loadJsonFile(cfgPath);
    assert.equal(after.adapters.opencode.roleSettings.engineer.reasoningEffort, 'max');
    assert.equal(after.adapters.opencode.roleSettings.engineer.reasoningEffortDefault, undefined);
  });

  it('roles without a configured reasoning effort generate no variant', () => {
    const d = makeTarget('opencode');

    runAgenticLoop(['generate', 'opencode', '--target', d]);

    for (const role of ['orchestrator', 'maintainer', 'engineer', 'auditor']) {
      const text = readFileSync(join(d, '.opencode', 'agents', `${role}.md`), 'utf-8');
      assert.ok(!/^variant:/m.test(text), `${role} must omit variant when no reasoning effort is configured`);
    }
  });

  it('xhigh and max survive configuration, update, and regeneration', () => {
    const d = makeTarget('opencode');

    runAgenticLoop([
      'configure', 'models', '--target', d, '--adapter', 'opencode',
      '--role', 'orchestrator', '--model', 'configured/orchestrator', '--reasoning-effort', 'xhigh',
      '--role', 'maintainer', '--model', 'configured/maintainer', '--reasoning-effort', 'max',
    ]);
    runAgenticLoop(['update', '--target', d]);

    assert.equal(readFrontmatter(join(d, '.opencode', 'agents', 'orchestrator.md')).variant, 'xhigh');
    assert.equal(readFrontmatter(join(d, '.opencode', 'agents', 'maintainer.md')).variant, 'max');
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.adapters.opencode.roleSettings.orchestrator.reasoningEffort, 'xhigh');
    assert.equal(cfg.adapters.opencode.roleSettings.maintainer.reasoningEffort, 'max');
  });
});
