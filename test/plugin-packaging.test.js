import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function readJson(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf-8'));
}

function readFrontmatterBlock(relPath) {
  const text = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return match?.[1] ?? '';
}

describe('Claude Code plugin packaging', () => {
  it('keeps plugin.json version in sync with package.json', () => {
    const pkg = readJson('package.json');
    const plugin = readJson('.claude-plugin/plugin.json');

    assert.equal(plugin.version, pkg.version);
  });

  it('does not expose canonical skills as public plugin skills', () => {
    // Pointing plugin "skills" at the whole canonical skills/ directory would
    // surface every internal Agentic Loop procedure as a separate plugin skill,
    // which Mode A deliberately avoids. Mode A is command-first and uses
      // canonical agenticloop/skills/<name>/SKILL.md paths from the command and role prompts.
    const plugin = readJson('.claude-plugin/plugin.json');
    assert.equal(plugin.skills, './.claude-plugin/',
      'plugin.json should override plugin skill discovery without pointing at canonical skills/');

    assert.equal(
      existsSync(join(REPO_ROOT, '.claude-plugin', 'skills')),
      false,
      'Mode A must not track generated duplicate skill payloads under .claude-plugin/skills'
    );
  });

  it('keeps Mode A activation wired to canonical procedure paths', () => {
    const command = readFileSync(join(REPO_ROOT, 'commands', 'start.md'), 'utf-8');
    assert.ok(command.includes('agenticloop/skills/setup-agenticloop/SKILL.md'));

    for (const role of ['orchestrator', 'maintainer', 'engineer']) {
      const roleText = readFileSync(join(REPO_ROOT, 'agents', `${role}.md`), 'utf-8');
      assert.ok(
        roleText.includes('Skill markers in the form `[[skill-name]]` refer to canonical Agentic Loop'),
        `${role} should explain how to resolve canonical skill markers`
      );
      assert.ok(roleText.includes('agenticloop/skills/<skill-name>/SKILL.md'));
    }
  });

  it('points plugin agents to existing canonical files', () => {
    const plugin = readJson('.claude-plugin/plugin.json');

    for (const relPath of plugin.agents) {
      assert.ok(existsSync(join(REPO_ROOT, relPath)), `missing plugin agent: ${relPath}`);
    }
  });

  it('points plugin commands to an existing canonical file', () => {
    const plugin = readJson('.claude-plugin/plugin.json');

    assert.deepEqual(plugin.commands, ['./commands/start.md']);
    for (const relPath of plugin.commands) {
      assert.ok(existsSync(join(REPO_ROOT, relPath)), `missing plugin command: ${relPath}`);
    }
  });

  it('keeps the restricted OpenCode-only supervisor out of the Claude public agent list', () => {
    const plugin = readJson('.claude-plugin/plugin.json');
    const listedAgents = new Set(plugin.agents.map(relPath => relPath.replace(/\\/g, '/')));
    const agentFiles = readdirSync(join(REPO_ROOT, 'agents'))
      .filter(name => name.endsWith('.md'))
      .map(name => `./agents/${name}`);

    assert.deepEqual(agentFiles.filter(path => path !== './agents/supervisor.md').sort(), [...listedAgents].sort());
    assert.ok(agentFiles.includes('./agents/supervisor.md'));
  });

  it('uses canonical agent frontmatter with name and description but no model', () => {
    const plugin = readJson('.claude-plugin/plugin.json');

    for (const relPath of plugin.agents) {
      const frontmatter = readFrontmatterBlock(relPath);
      assert.match(frontmatter, /^name:/m, `${relPath} should declare name frontmatter`);
      assert.match(frontmatter, /^description:/m, `${relPath} should declare description frontmatter`);
      assert.doesNotMatch(frontmatter, /^model:/m, `${relPath} should stay model-free for plugin mode`);
    }
  });

  it('keeps the canonical start command as human-invoked only', () => {
    const frontmatter = readFrontmatterBlock('commands/start.md');

    assert.match(frontmatter, /^disable-model-invocation:\s*true$/m);
  });

  it('lists the local development marketplace entry with matching version', () => {
    const pkg = readJson('package.json');
    const marketplace = readJson('.claude-plugin/marketplace.json');

    const entry = marketplace.plugins.find(plugin => plugin.name === 'agenticloop');
    assert.ok(entry, 'expected marketplace entry for agenticloop');
    assert.equal(entry.source, './');
    assert.equal(entry.version, pkg.version);
  });

  it('includes plugin packaging and command sources in the npm package files allowlist', () => {
    const pkg = readJson('package.json');
    assert.ok(pkg.files.includes('.claude-plugin/'));
    assert.ok(pkg.files.includes('agents/'));
    assert.ok(pkg.files.includes('commands/'));
  });
});
