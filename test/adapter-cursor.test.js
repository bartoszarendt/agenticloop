/**
 * Tests for src/adapters/cursor.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-cursor-test-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

function collectNested(rootDir, filename, matches = []) {
  if (!existsSync(rootDir)) return matches;
  for (const entry of readdirSync(rootDir)) {
    const fullPath = join(rootDir, entry);
    if (statSync(fullPath).isDirectory()) collectNested(fullPath, filename, matches);
    else if (entry === filename) matches.push(fullPath.replace(/\\/g, '/'));
  }
  return matches;
}

describe('generateCursorArtifacts', () => {
  it('produces Cursor agents, one public skill, and backend references without rules or root plugin packaging', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateCursorArtifacts(cfg, fx, out);

    assert.ok(files.includes('.cursor/agents/orchestrator.md'));
    assert.ok(files.includes('.cursor/agents/maintainer.md'));
    assert.ok(files.includes('.cursor/agents/engineer.md'));
    assert.ok(files.includes('.cursor/skills/agenticloop/SKILL.md'));
    assert.ok(files.includes('.cursor/skills/agenticloop/references/backends/README.md'));
    assert.ok(files.includes('.cursor/skills/agenticloop/references/backends/files.md'));
    assert.ok(files.includes('.cursor/skills/agenticloop/references/backends/github.md'));
    assert.equal(existsSync(join(out, '.cursor', 'rules')), false);
    assert.equal(existsSync(join(out, '.cursor-plugin')), false);
    assert.equal(existsSync(join(out, 'plugins', 'agenticloop', '.cursor-plugin', 'plugin.json')), false);
  });

  it('uses one public skill with explicit /agenticloop activation and reference-only internal procedures', () => {
    const fx = makeFixture();
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'nested'), { recursive: true });
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references'), { recursive: true });
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'SKILL.md'), [
      '---',
      'name: example-extra',
      'description: Use when testing Cursor internal reference copies.',
      '---',
      '',
      'See [[role-delegation]].',
      '',
    ].join('\n'));
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'nested', 'SKILL.md'), 'Nested support reference\n');
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references', 'note.md'), 'supporting file\n');

    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCursorArtifacts(cfg, fx, out);

    const skillsRoot = join(out, '.cursor', 'skills');
    const discoverableSkills = readdirSync(skillsRoot)
      .filter(entry => existsSync(join(skillsRoot, entry, 'SKILL.md')))
      .sort();
    assert.deepEqual(discoverableSkills, ['agenticloop']);

    const publicSkillDir = join(skillsRoot, 'agenticloop');
    const skillText = readFileSync(join(publicSkillDir, 'SKILL.md'), 'utf-8');
    assert.match(skillText, /name: "agenticloop"/);
    assert.ok(skillText.includes('Explicit /agenticloop activation for Cursor'));
    assert.match(skillText, /disable-model-invocation: true/);
    assert.match(skillText, /\.cursor\/agents\/maintainer\.md/);
    assert.match(skillText, /references\/skills\/role-delegation\/reference\.md/);
    assert.match(skillText, /references\/backends\/README\.md/);
    assert.match(skillText, /references\/backends\/files\.md/);
    assert.match(skillText, /references\/backends\/github\.md/);

    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'reference.md')));
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'nested', 'reference.md')));
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'references', 'note.md')));
    assert.equal(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'nested', 'SKILL.md')), false);
    assert.deepEqual(
      collectNested(join(publicSkillDir, 'references'), 'SKILL.md'),
      [],
      'internal Cursor references must not contain discoverable SKILL.md files'
    );

    const referenceText = readFileSync(
      join(publicSkillDir, 'references', 'skills', 'example-extra', 'reference.md'),
      'utf-8'
    );
    assert.match(referenceText, /references\/skills\/role-delegation\/reference\.md/);
  });

  it('renders inherit by default and configured models when provided', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.cursor.roleSettings = {
      engineer: { model: 'gpt-5.5' },
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCursorArtifacts(cfg, fx, out);

    const orchestrator = readFileSync(join(out, '.cursor', 'agents', 'orchestrator.md'), 'utf-8');
    const maintainer = readFileSync(join(out, '.cursor', 'agents', 'maintainer.md'), 'utf-8');
    const engineer = readFileSync(join(out, '.cursor', 'agents', 'engineer.md'), 'utf-8');

    assert.match(orchestrator, /^model: "inherit"$/m);
    assert.match(maintainer, /^model: "inherit"$/m);
    assert.match(engineer, /^model: "gpt-5\.5"$/m);
    assert.match(orchestrator, /^readonly: true$/m);
    assert.match(maintainer, /^readonly: false$/m);
    assert.match(engineer, /^readonly: false$/m);
    assert.doesNotMatch(engineer, /^reasoningEffort:/m);
    assert.doesNotMatch(engineer, /^variant:/m);
  });

  it('renders agents from canonical role contracts', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCursorArtifacts(cfg, fx, out);

    const orchestratorAgent = readFileSync(join(out, '.cursor', 'agents', 'orchestrator.md'), 'utf-8');
    const canonical = readFileSync(join(fx, 'agenticloop', 'agents', 'orchestrator.md'), 'utf-8');

    assert.ok(canonical.includes('The orchestrator coordinates Agentic Loop for a target project.'));
    assert.ok(orchestratorAgent.includes('The orchestrator coordinates Agentic Loop for a target project.'));
    assert.match(orchestratorAgent, /\.cursor\/skills\/agenticloop\/references\/skills\/role-delegation\/reference\.md/);
    assert.match(orchestratorAgent, /Use real Cursor subagent delegation/);
    assert.match(orchestratorAgent, /target project state \(project\.md, tasks\/, decisions\/, improvements\/\)/);
  });

  it('writes optional plugin packaging behind adapters.cursor.plugin.enabled', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.cursor.plugin = { enabled: true };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCursorArtifacts(cfg, fx, out);

    const pluginPath = join(out, 'plugins', 'agenticloop', '.cursor-plugin', 'plugin.json');
    assert.ok(existsSync(pluginPath));
    const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    assert.equal(plugin.name, 'agenticloop');
    assert.equal(plugin.skills, './skills/');
    assert.equal(plugin.agents, './agents/');
    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'SKILL.md')));
    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'agents', 'orchestrator.md')));
    assert.ok(existsSync(join(out, 'plugins', 'agenticloop', 'skills', 'agenticloop', 'references', 'skills', 'role-delegation', 'reference.md')));
  });

  it('rejects shared Codex and Cursor plugin output before writing Cursor artifacts', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.codex = cfg.adapters.codex ?? {};
    cfg.adapters.cursor = cfg.adapters.cursor ?? {};
    cfg.adapters.codex.plugin = { enabled: true };
    cfg.adapters.cursor.plugin = { enabled: true };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    assert.throws(
      () => generateCursorArtifacts(cfg, fx, out),
      /adapters\.cursor\.plugin\.enabled cannot be combined with adapters\.codex\.plugin\.enabled/
    );
    assert.equal(existsSync(join(out, '.cursor')), false);
    assert.equal(existsSync(join(out, 'plugins', 'agenticloop')), false);
  });
});
