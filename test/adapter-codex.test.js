/**
 * Tests for src/adapters/codex.js.
 *
 * Covers:
 *   - generates .codex/agents/<role>.toml for each canonical role
 *   - generates one public .agents/skills/agenticloop/SKILL.md skill surface
 *   - copies canonical skills into internal reference.md files
 *   - optionally generates plugins/agenticloop/.codex-plugin/plugin.json
 *   - filters Codex reasoning effort to supported explicit values only
 *   - emits Codex-specific delegation and event-logging guidance
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { AGENTIC_LOOP_OPERATION_DESCRIPTION } from '../src/adapters/shared.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-codex-test-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

function collectFiles(root, predicate, files = []) {
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      collectFiles(fullPath, predicate, files);
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function assertNoLegacyCodexEventLoggingFallback(text, label) {
  assert.doesNotMatch(
    text,
    /`npx agenticloop`\s+when no command is\s+configured/,
    `${label} should not contain the legacy npx fallback`
  );
}

describe('generateCodexArtifacts', () => {
  it('produces one TOML per role plus the repo-local public skill', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateCodexArtifacts(cfg, fx, out);

    assert.ok(files.some(f => f.endsWith('.codex/agents/orchestrator.toml')));
    assert.ok(files.some(f => f.endsWith('.codex/agents/maintainer.toml')));
    assert.ok(files.some(f => f.endsWith('.codex/agents/engineer.toml')));
    assert.ok(files.some(f => f.endsWith('.agents/skills/agenticloop/SKILL.md')));
    assert.ok(files.some(f => f.endsWith('.agents/skills/agenticloop/agents/openai.yaml')));
    assert.ok(!files.some(f => f.endsWith('.agents/skills/agenticloop-start/SKILL.md')));
    assert.ok(!files.some(f => f.endsWith('.agents/skills/agenticloop-role-delegation/SKILL.md')));
    assert.ok(!files.some(f => f.endsWith('.codex-plugin/plugin.json')));

    for (const roleName of ['orchestrator', 'maintainer', 'engineer']) {
      const toml = readFileSync(join(out, '.codex', 'agents', `${roleName}.toml`), 'utf-8');
      assert.ok(!toml.includes('model_reasoning_effort = "auto"'));
    }
  });

  it('each role TOML inherits a distinctive Project Operating Facts responsibility', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const read = (role) => readFileSync(join(out, '.codex', 'agents', `${role}.toml`), 'utf-8');
    const orchestrator = read('orchestrator');
    const maintainer = read('maintainer');
    const engineer = read('engineer');

    assert.match(orchestrator, /Project Operating Fact/);
    assert.match(maintainer, /Own the current mutable `## Project Operating Facts` profile/);
    assert.match(engineer, /Project Operating Fact candidate/);
    assert.match(orchestrator, /capture offer/);

    for (const body of [orchestrator, maintainer, engineer]) {
      assert.ok(!body.includes('not already explicit or cheaply discoverable'),
        'adapter role body must not copy the canonical recognition test');
    }
  });

  it('uses one public skill with the required frontmatter, metadata, and internal index', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const skillText = readFileSync(
      join(out, '.agents', 'skills', 'agenticloop', 'SKILL.md'),
      'utf-8'
    );
    const metadataText = readFileSync(
      join(out, '.agents', 'skills', 'agenticloop', 'agents', 'openai.yaml'),
      'utf-8'
    );

    assert.match(skillText, /name: "agenticloop"/);
    assert.ok(skillText.includes(`description: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`));
    assert.match(skillText, /Generated by: agenticloop generate codex/);
    assert.match(skillText, /references\/skills\/role-delegation\/reference\.md/);
    assert.match(skillText, /references\/skills\/task-record-contract\/reference\.md/);
    assert.match(skillText, /references\/skills\/setup-agenticloop\/reference\.md/);
    assert.match(skillText, /references\/skills\/blocked-state\/reference\.md/);
    assert.match(skillText, /npx agenticloop --help/);
    assert.match(skillText, /Do not assume `npx agenticloop` exists before that check succeeds\./);
    assert.match(skillText, /do not block the workflow/i);

    assert.match(metadataText, /display_name: "Agentic Loop"/);
    assert.ok(metadataText.includes(`short_description: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`));
    assert.ok(metadataText.includes(`default_prompt: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`));
  });

  it('uses Codex roleBindings in the public skill and orchestrator delegation instructions', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.roleBindings = {
      maintainer: { agent: 'al-maintainer' },
      engineer: { agent: 'al-engineer' },
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const skillText = readFileSync(
      join(out, '.agents', 'skills', 'agenticloop', 'SKILL.md'),
      'utf-8'
    );
    const orchestrator = readFileSync(
      join(out, '.codex', 'agents', 'orchestrator.toml'),
      'utf-8'
    );

    assert.ok(skillText.includes('Codex custom agent `al-maintainer`'));
    assert.ok(skillText.includes('Codex custom agent `al-engineer`'));
    assert.ok(orchestrator.includes('Codex custom agent `al-maintainer`'));
    assert.ok(orchestrator.includes('Codex custom agent `al-engineer`'));
    assert.ok(!skillText.includes('Codex custom agent `maintainer`'));
    assert.ok(!orchestrator.includes('Codex custom agent `engineer` instead'));
  });

  it('copies canonical skills into internal reference directories and never writes nested SKILL.md files there', () => {
    const fx = makeFixture();
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references'), { recursive: true });
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'nested'), { recursive: true });
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'SKILL.md'), [
      '---',
      'name: example-extra',
      'description: Use when testing generated reference copies.',
      '---',
      '',
      'See [[role-delegation]].',
      '',
    ].join('\n'));
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references', 'note.md'), 'supporting file\n');
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'nested', 'SKILL.md'), 'Nested support reference\n');

    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const publicSkillDir = join(out, '.agents', 'skills', 'agenticloop');
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'reference.md')));
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'references', 'note.md')));
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'nested', 'reference.md')));
    assert.ok(!existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'nested', 'SKILL.md')));

    const referenceText = readFileSync(
      join(publicSkillDir, 'references', 'skills', 'example-extra', 'reference.md'),
      'utf-8'
    );
    assert.match(referenceText, /references\/skills\/role-delegation\/reference\.md/);
  });

  it('plugin mode writes the same single-skill shape and marketplace entry', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.plugin = { enabled: true };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const pluginPath = join(out, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json');
    assert.ok(existsSync(pluginPath));
    const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    assert.equal(plugin.name, 'agenticloop');
    assert.equal(typeof plugin.version, 'string');
    assert.ok(plugin.version.length > 0);
    assert.equal(plugin.skills, './skills/');

    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'SKILL.md')));
    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'agents', 'openai.yaml')));
    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'references', 'skills', 'role-delegation', 'reference.md')));
    assert.ok(!existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop-start', 'SKILL.md')));
    assert.ok(!existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop-role-delegation', 'SKILL.md')));

    const marketplacePath = join(out, '.agents', 'plugins', 'marketplace.json');
    assert.ok(existsSync(marketplacePath));
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'));
    const entry = marketplace.plugins.find(candidate => candidate.name === 'agenticloop');
    assert.ok(entry, 'expected marketplace entry for agenticloop');
    assert.deepEqual(entry.source, { source: 'local', path: './plugins/agenticloop' });
    assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
    assert.equal(entry.category, 'Productivity');
  });

  it('omits model_reasoning_effort when reasoning effort is missing or auto', () => {
    const fxMissing = makeFixture();
    const cfgMissing = loadAgenticLoopConfig(join(fxMissing, 'agenticloop.json'));
    delete cfgMissing.adapters.codex.roleSettings.engineer.reasoningEffort;
    const outMissing = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfgMissing, fxMissing, outMissing);
    const missingToml = readFileSync(join(outMissing, '.codex', 'agents', 'engineer.toml'), 'utf-8');
    assert.ok(!missingToml.includes('model_reasoning_effort ='));

    const fxAuto = makeFixture();
    const cfgAuto = loadAgenticLoopConfig(join(fxAuto, 'agenticloop.json'));
    cfgAuto.adapters.codex.roleSettings.engineer.reasoningEffort = 'auto';
    const outAuto = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfgAuto, fxAuto, outAuto);
    const autoToml = readFileSync(join(outAuto, '.codex', 'agents', 'engineer.toml'), 'utf-8');
    assert.ok(!autoToml.includes('model_reasoning_effort ='));
  });

  it('emits explicit high model_reasoning_effort for Codex', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.roleSettings.engineer.reasoningEffort = 'high';
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const toml = readFileSync(join(out, '.codex', 'agents', 'engineer.toml'), 'utf-8');
    assert.ok(toml.includes('model_reasoning_effort = "high"'));
  });

  it('normalizes legacy codex-cli model prefixes in generated TOML', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.roleSettings.engineer.model = 'codex-cli/gpt-5.4';
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const toml = readFileSync(join(out, '.codex', 'agents', 'engineer.toml'), 'utf-8');
    assert.ok(toml.includes('model = "gpt-5.4"'));
    assert.ok(!toml.includes('model = "codex-cli/gpt-5.4"'));
  });

  it('emits explicit xhigh model_reasoning_effort for Codex', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.roleSettings.engineer.reasoningEffort = 'xhigh';
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const toml = readFileSync(join(out, '.codex', 'agents', 'engineer.toml'), 'utf-8');
    assert.ok(toml.includes('model_reasoning_effort = "xhigh"'));
  });

  it('orchestrator TOML uses internal references, plain-message delegation guidance, and non-blocking event logging', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const toml = readFileSync(join(out, '.codex', 'agents', 'orchestrator.toml'), 'utf-8');
    const canonical = readFileSync(join(fx, 'agenticloop', 'agents', 'orchestrator.md'), 'utf-8');

    assert.match(toml, /\.agents\/skills\/agenticloop\/references\/skills\/role-delegation\/reference\.md/);
    assert.match(toml, /single plain-message prompt payload only/);
    assert.match(toml, /Do not mix a plain message payload with structured items in the same spawn request\./);
    assert.match(toml, /schema error about message\/items/);
    assert.match(toml, /npx agenticloop --help/);
    assert.match(toml, /If no working event logging command is available, record a truthful process gap and continue\./);
    assert.match(toml, /role\.invoked/);
    assert.match(toml, /target project state \(project\.md, tasks\/, decisions\/, improvements\/\)/);
    assert.equal(
      (toml.match(/Codex event logging override:/g) ?? []).length,
      1,
      'orchestrator TOML should contain one Codex event logging override'
    );
    assert.ok(
      toml.lastIndexOf('Codex event logging override:') > toml.indexOf('Canonical role contract follows'),
      'Codex event logging override should appear after the canonical role contract'
    );
    assertNoLegacyCodexEventLoggingFallback(toml, 'orchestrator TOML');
    assert.ok(canonical.includes('The orchestrator coordinates Agentic Loop for a target project.'), 'precondition: canonical role file should still contain expected text');
    assert.ok(toml.includes('The orchestrator coordinates Agentic Loop for a target project.'));
  });

  it('replaces legacy npx event logging fallbacks with command-resolution guidance', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const generatedFiles = collectFiles(
      out,
      filePath => filePath.endsWith('.toml') || filePath.endsWith('reference.md')
    );
    assert.ok(generatedFiles.length > 0, 'expected generated TOML and reference files');

    for (const filePath of generatedFiles) {
      assertNoLegacyCodexEventLoggingFallback(
        readFileSync(filePath, 'utf-8'),
        filePath.replace(out, '')
      );
    }

    // The canonical event-logging skill reference carries the resolution recipe
    // plus the injected Codex event-logging override.
    const eventLogging = readFileSync(
      join(out, '.agents', 'skills', 'agenticloop', 'references', 'skills', 'event-logging', 'reference.md'),
      'utf-8'
    );
    assert.match(eventLogging, /resolve the event logging command/i);
    assert.match(eventLogging, /npx agenticloop --help/);
    assert.match(eventLogging, /Codex event logging override:/);

    // role-delegation now points at the event-logging skill but still receives
    // the Codex override because it references event logging.
    const roleDelegation = readFileSync(
      join(out, '.agents', 'skills', 'agenticloop', 'references', 'skills', 'role-delegation', 'reference.md'),
      'utf-8'
    );
    assert.match(roleDelegation, /Codex event logging override:/);
    assert.match(roleDelegation, /npx agenticloop --help/);
  });

  it('copies canonical backend docs into repo-local references', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateCodexArtifacts(cfg, fx, out);

    assert.ok(existsSync(join(out, '.agents', 'skills', 'agenticloop', 'references', 'backends', 'files.md')));
    assert.ok(existsSync(join(out, '.agents', 'skills', 'agenticloop', 'references', 'backends', 'github.md')));
    assert.ok(files.some(f => f.includes('references/backends/files.md')));
    assert.ok(files.some(f => f.includes('references/backends/github.md')));
  });

  it('plugin mode copies backend docs into plugin references', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.plugin = { enabled: true };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'references', 'backends', 'files.md')));
    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'references', 'backends', 'github.md')));
  });

  it('rejects shared Codex and Cursor plugin output before writing Codex artifacts', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex = cfg.adapters.codex ?? {};
    cfg.adapters.cursor = cfg.adapters.cursor ?? {};
    cfg.adapters.codex.plugin = { enabled: true };
    cfg.adapters.cursor.plugin = { enabled: true };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    assert.throws(
      () => generateCodexArtifacts(cfg, fx, out),
      /adapters\.cursor\.plugin\.enabled cannot be combined with adapters\.codex\.plugin\.enabled/
    );
    assert.equal(existsSync(join(out, '.codex')), false);
    assert.equal(existsSync(join(out, 'plugins', 'agenticloop')), false);
  });

  it('generated artifacts do not contain dangling bare backend paths', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex.plugin = { enabled: true };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const danglingPattern = /(?<!references\/)backends\/(files|github)\.md/;
    const generatedFiles = collectFiles(
      out,
      filePath => filePath.endsWith('.toml') || filePath.endsWith('.md')
    );
    assert.ok(generatedFiles.length > 0, 'expected generated files to check');

    for (const filePath of generatedFiles) {
      const content = readFileSync(filePath, 'utf-8');
      assert.doesNotMatch(
        content,
        danglingPattern,
        `${filePath.replace(out, '').replace(/\\/g, '/')} contains dangling bare backend path`
      );
    }
  });

  it('public skill and TOML include backend reference index entries', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCodexArtifacts(cfg, fx, out);

    const skillText = readFileSync(
      join(out, '.agents', 'skills', 'agenticloop', 'SKILL.md'),
      'utf-8'
    );
    assert.match(skillText, /references\/backends\/files\.md/);
    assert.match(skillText, /references\/backends\/github\.md/);

    const orchestratorToml = readFileSync(
      join(out, '.codex', 'agents', 'orchestrator.toml'),
      'utf-8'
    );
    assert.match(orchestratorToml, /\.agents\/skills\/agenticloop\/references\/backends\/files\.md/);
    assert.match(orchestratorToml, /\.agents\/skills\/agenticloop\/references\/backends\/github\.md/);
  });
});
