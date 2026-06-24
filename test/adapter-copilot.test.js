/**
 * Tests for src/adapters/copilot.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
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

import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-copilot-test-')); });
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

describe('generateCopilotArtifacts', () => {
  it('produces the required Copilot agents, public skill, backend references, and prompt file', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.copilot.roleSettings = {
      orchestrator: { model: 'gpt-5.4' },
      maintainer: { model: 'gpt-5.5' },
      engineer: { model: 'gpt-5.4-mini' },
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateCopilotArtifacts(cfg, fx, out);

    assert.ok(files.includes('.github/agents/orchestrator.agent.md'));
    assert.ok(files.includes('.github/agents/maintainer.agent.md'));
    assert.ok(files.includes('.github/agents/engineer.agent.md'));
    assert.ok(files.includes('.github/skills/agenticloop/SKILL.md'));
    assert.ok(files.includes('.github/prompts/agenticloop.prompt.md'));
    assert.ok(files.includes('.github/skills/agenticloop/references/backends/README.md'));
    assert.ok(files.includes('.github/skills/agenticloop/references/backends/files.md'));
    assert.ok(files.includes('.github/skills/agenticloop/references/backends/github.md'));
    assert.ok(!existsSync(join(out, '.github', 'copilot-instructions.md')));

    for (const filePath of files.filter(filePath => filePath.startsWith('.github/agents/'))) {
      assert.match(filePath, /\.agent\.md$/);
    }

    const orchestratorAgent = readFileSync(join(out, '.github', 'agents', 'orchestrator.agent.md'), 'utf-8');
    const maintainerAgent = readFileSync(join(out, '.github', 'agents', 'maintainer.agent.md'), 'utf-8');
    const engineerAgent = readFileSync(join(out, '.github', 'agents', 'engineer.agent.md'), 'utf-8');
    const publicSkill = readFileSync(join(out, '.github', 'skills', 'agenticloop', 'SKILL.md'), 'utf-8');
    const [publicSkillFrontmatter] = parseFrontmatter(publicSkill);

    assert.equal(publicSkillFrontmatter?.name, 'agenticloop');
    assert.match(publicSkillFrontmatter?.description, /Explicit \/agenticloop activation for Copilot/);
    assert.equal(publicSkillFrontmatter?.['user-invocable'], 'true');
    assert.equal(publicSkillFrontmatter?.['disable-model-invocation'], 'true');

    assert.match(orchestratorAgent, /^tools:\n  - "agent"\n  - "execute"\n  - "read"\n  - "search"$/m);
    assert.match(orchestratorAgent, /^agents:\n  - "maintainer"\n  - "engineer"$/m);
    assert.match(orchestratorAgent, /^user-invocable: true$/m);
    assert.match(orchestratorAgent, /^disable-model-invocation: true$/m);
    assert.match(maintainerAgent, /^user-invocable: false$/m);
    assert.match(maintainerAgent, /^disable-model-invocation: false$/m);
    assert.doesNotMatch(maintainerAgent, /^agents:$/m);
    assert.match(engineerAgent, /^user-invocable: false$/m);
    assert.match(engineerAgent, /^disable-model-invocation: false$/m);
    assert.doesNotMatch(engineerAgent, /^agents:$/m);
  });

  it('uses one public skill with reference-only internal procedures and copied backend docs', () => {
    const fx = makeFixture();
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'nested'), { recursive: true });
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references'), { recursive: true });
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'SKILL.md'), [
      '---',
      'name: example-extra',
      'description: Use when testing Copilot internal reference copies.',
      '---',
      '',
      'See [[role-delegation]].',
      '',
    ].join('\n'));
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'nested', 'SKILL.md'), 'Nested support reference\n');
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references', 'note.md'), 'supporting file\n');

    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCopilotArtifacts(cfg, fx, out);

    const skillsRoot = join(out, '.github', 'skills');
    const discoverableSkills = readdirSync(skillsRoot)
      .filter(entry => existsSync(join(skillsRoot, entry, 'SKILL.md')))
      .sort();
    assert.deepEqual(discoverableSkills, ['agenticloop']);

    const publicSkillDir = join(skillsRoot, 'agenticloop');
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'reference.md')));
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'nested', 'reference.md')));
    assert.ok(existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'references', 'note.md')));
    assert.equal(
      existsSync(join(publicSkillDir, 'references', 'skills', 'example-extra', 'nested', 'SKILL.md')),
      false
    );
    assert.deepEqual(
      collectNested(join(publicSkillDir, 'references'), 'SKILL.md'),
      [],
      'internal Copilot references must not contain discoverable SKILL.md files'
    );

    const skillText = readFileSync(join(publicSkillDir, 'SKILL.md'), 'utf-8');
    assert.match(skillText, /references\/skills\/role-delegation\/reference\.md/);
    assert.match(skillText, /references\/backends\/README\.md/);
    assert.match(skillText, /references\/backends\/files\.md/);
    assert.match(skillText, /references\/backends\/github\.md/);

    const referenceText = readFileSync(
      join(publicSkillDir, 'references', 'skills', 'example-extra', 'reference.md'),
      'utf-8'
    );
    assert.match(referenceText, /references\/skills\/role-delegation\/reference\.md/);
  });

  it('uses Copilot roleBindings in filenames, prompt binding, and public skill wording', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.copilot.roleBindings = {
      orchestrator: { agent: 'al-orchestrator' },
      maintainer: { agent: 'al-maintainer' },
      engineer: { agent: 'al-engineer' },
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateCopilotArtifacts(cfg, fx, out);

    assert.ok(files.includes('.github/agents/al-orchestrator.agent.md'));
    assert.ok(files.includes('.github/agents/al-maintainer.agent.md'));
    assert.ok(files.includes('.github/agents/al-engineer.agent.md'));
    assert.ok(!existsSync(join(out, '.github', 'agents', 'orchestrator.agent.md')));

    const skillText = readFileSync(join(out, '.github', 'skills', 'agenticloop', 'SKILL.md'), 'utf-8');
    assert.match(skillText, /Copilot custom agent `al-maintainer`/);
    assert.match(skillText, /Copilot custom agent `al-engineer`/);

    const promptText = readFileSync(join(out, '.github', 'prompts', 'agenticloop.prompt.md'), 'utf-8');
    const [promptFrontmatter] = parseFrontmatter(promptText);
    assert.equal(promptFrontmatter?.agent, 'al-orchestrator');
    assert.match(promptText, /Copilot custom agent `al-orchestrator`/);

    const orchestratorText = readFileSync(join(out, '.github', 'agents', 'al-orchestrator.agent.md'), 'utf-8');
    assert.match(orchestratorText, /^agents:\n  - "al-maintainer"\n  - "al-engineer"$/m);
  });

  it('renders model frontmatter for Copilot agents and omits reasoningEffort fields', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.copilot.roleSettings.engineer = {
      model: 'gpt-5.4',
      reasoningEffort: 'high',
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateCopilotArtifacts(cfg, fx, out);

    const engineerAgent = readFileSync(join(out, '.github', 'agents', 'engineer.agent.md'), 'utf-8');
    assert.match(engineerAgent, /^model: "gpt-5\.4"$/m);
    assert.doesNotMatch(engineerAgent, /^reasoningEffort:/m);
    assert.doesNotMatch(engineerAgent, /^variant:/m);
  });

  it('preserves target-owned sibling .github skills outside agenticloop/', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));

    const siblingSkillPath = join(out, '.github', 'skills', 'project-owned', 'SKILL.md');
    mkdirSync(join(out, '.github', 'skills', 'project-owned'), { recursive: true });
    writeFileSync(siblingSkillPath, '# Project-owned skill\n', 'utf-8');

    generateCopilotArtifacts(cfg, fx, out);

    assert.equal(readFileSync(siblingSkillPath, 'utf-8'), '# Project-owned skill\n');
    assert.ok(existsSync(join(out, '.github', 'skills', 'agenticloop', 'SKILL.md')));
  });
});
