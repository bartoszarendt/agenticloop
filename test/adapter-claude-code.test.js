/**
 * Tests for src/adapters/claude-code.js.
 *
 * Covers:
 *   - copies the repo-local /agenticloop activation command
 *   - generates .claude/agents/<role>.md for each canonical role
 *   - does not generate .claude-plugin/ for repo-local Claude Code output
 *   - generates Claude Code settings with local/project scope support
 *   - generates one public .claude/skills/agenticloop/SKILL.md plus internal
 *     references/skills/<name>/reference.md procedure copies (no nested SKILL.md)
 *   - uses adapter-local roleSettings for model and permissionMode frontmatter
 *   - role bodies are rendered from canonical role files, not hand-rewritten
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

import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-cc-test-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readClaudeAgent(outDir, roleName) {
  return readFileSync(join(outDir, '.claude', 'agents', `${roleName}.md`), 'utf-8');
}

function claudeSettingsPath(outDir, scope = 'local') {
  return join(outDir, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
}

function readClaudeSettings(outDir, scope = 'local') {
  return readJson(claudeSettingsPath(outDir, scope));
}

describe('generateClaudeCodeArtifacts', () => {
  it('produces the repo-local command and one Markdown agent per role without creating plugin packaging', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);
    assert.ok(files.some(f => f.endsWith('.claude/commands/agenticloop.md')));
    assert.ok(files.some(f => f.endsWith('.claude/agents/orchestrator.md')));
    assert.ok(files.some(f => f.endsWith('.claude/agents/maintainer.md')));
    assert.ok(files.some(f => f.endsWith('.claude/agents/engineer.md')));
    assert.ok(
      files.every(f => !f.startsWith('.claude-plugin/')),
      `expected no repo-local .claude-plugin output, got: ${files.join(', ')}`
    );
    const commandPath = join(out, '.claude', 'commands', 'agenticloop.md');
    assert.ok(existsSync(commandPath), 'expected repo-local Claude Code command to exist');
    const command = readFileSync(commandPath, 'utf-8');
    assert.ok(command.includes('disable-model-invocation: true'));
    assert.ok(command.includes('.agenticloop/project.md'));
    assert.ok(command.includes('agenticloop/AGENTIC_LOOP.md'));
    assert.equal(existsSync(join(out, '.claude-plugin')), false);
  });

  it('writes .claude/settings.local.json by default with the broad agenticloop profile', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);

    assert.ok(
      files.includes('.claude/settings.local.json'),
      `expected generated files to include .claude/settings.local.json, got: ${files.join(', ')}`
    );
    assert.ok(files.includes('.gitignore'));
    assert.equal(existsSync(claudeSettingsPath(out, 'project')), false);

    const settings = readClaudeSettings(out, 'local');
    assert.ok(settings.permissions);
    assert.ok(settings.permissions.allow.includes('Bash(gh *)'));
    assert.ok(settings.permissions.allow.includes('Bash(git *)'));
    assert.ok(settings.permissions.allow.includes('PowerShell(gh *)'));
    assert.ok(settings.permissions.allow.includes('PowerShell(npm *)'));
    assert.deepEqual(settings.permissions.deny, []);
    assert.equal(Object.hasOwn(settings.permissions, 'defaultMode'), false);

    const gitignore = readFileSync(join(out, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('.claude/settings.local.json'));
  });

  it('does not duplicate the local settings gitignore entry on repeated generation', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));

    const first = generateClaudeCodeArtifacts(cfg, fx, out);
    const second = generateClaudeCodeArtifacts(cfg, fx, out);

    assert.ok(first.files.includes('.gitignore'));
    assert.ok(!second.files.includes('.gitignore'));

    const gitignore = readFileSync(join(out, '.gitignore'), 'utf-8');
    assert.equal(
      gitignore.split('\n').filter(line => line.trim() === '.claude/settings.local.json').length,
      1
    );
  });

  it('renders default acceptEdits permissionMode for maintainer and engineer but not orchestrator', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateClaudeCodeArtifacts(cfg, fx, out);

    const maintainer = readClaudeAgent(out, 'maintainer');
    const engineer = readClaudeAgent(out, 'engineer');
    const orchestrator = readClaudeAgent(out, 'orchestrator');

    assert.ok(maintainer.includes('permissionMode: "acceptEdits"'));
    assert.ok(engineer.includes('permissionMode: "acceptEdits"'));
    assert.ok(!orchestrator.includes('permissionMode:'), orchestrator);
  });

  it('agent Markdown frontmatter uses adapter roleSettings model and omits effort', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const engineerSettings = cfg.adapters['claude-code'].roleSettings.engineer;
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateClaudeCodeArtifacts(cfg, fx, out);
    const md = readClaudeAgent(out, 'engineer');
    assert.ok(md.startsWith('---\n'), 'agent file should start with YAML frontmatter');
    assert.ok(md.includes(`model: "${engineerSettings.model}"`),
      `expected claude model in frontmatter: ${md.slice(0, 400)}`);
    // Claude Code ignores effort, so the adapter must not render it.
    assert.ok(!/^effort:/m.test(md),
      `did not expect an effort field in claude frontmatter: ${md.slice(0, 400)}`);
    assert.ok(!md.includes('effort='),
      `did not expect effort in adapter trailer: ${md.slice(-200)}`);
  });

  it('quotes YAML frontmatter scalars that may contain special characters', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.roles.engineer.description = 'Implements: scoped task records';
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateClaudeCodeArtifacts(cfg, fx, out);
    const md = readClaudeAgent(out, 'engineer');
    assert.ok(md.includes('name: "engineer"'));
    assert.ok(md.includes('description: "Implements: scoped task records"'));
  });

  it('allows per-role permissionMode overrides', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].roleSettings.engineer.permissionMode = 'plan';
    const out = mkdtempSync(join(tmpDir, 'out-'));

    generateClaudeCodeArtifacts(cfg, fx, out);

    const engineer = readClaudeAgent(out, 'engineer');
    assert.ok(engineer.includes('permissionMode: "plan"'), engineer);
  });

  it('throws on an invalid role permissionMode override', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].roleSettings.engineer.permissionMode = 'not-a-mode';
    const out = mkdtempSync(join(tmpDir, 'out-'));

    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /adapters\.claude-code\.roleSettings\.engineer\.permissionMode/
    );
  });

  it('lets permissions.allow add custom entries on top of the agenticloop profile', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = {
      profile: 'agenticloop',
      scope: 'local',
      allow: ['Bash(npm run lint *)'],
      deny: [],
      defaultMode: 'plan',
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    generateClaudeCodeArtifacts(cfg, fx, out);

    const settings = readClaudeSettings(out, 'local');
    assert.ok(settings.permissions.allow.includes('Bash(gh *)'));
    assert.ok(settings.permissions.allow.includes('Bash(npm run lint *)'));
    assert.equal(settings.permissions.defaultMode, 'plan');
  });

  it('writes .claude/settings.json when scope is project', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = {
      profile: 'agenticloop',
      scope: 'project',
      deny: [],
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);

    assert.ok(files.includes('.claude/settings.json'));
    assert.ok(!files.includes('.claude/settings.local.json'));
    assert.ok(!files.includes('.gitignore'));
    assert.equal(existsSync(claudeSettingsPath(out, 'local')), false);
    assert.ok(readClaudeSettings(out, 'project').permissions.allow.includes('PowerShell(gh *)'));
  });

  it('throws on an invalid generated defaultMode override', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = {
      defaultMode: 'not-a-mode',
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /adapters\.claude-code\.permissions\.defaultMode/
    );
  });

  it('throws on non-array generated allow or deny permission overrides', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));

    cfg.adapters['claude-code'].permissions = {
      allow: 'Bash(npm run lint *)',
    };
    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /adapters\.claude-code\.permissions\.allow must be an array/
    );

    cfg.adapters['claude-code'].permissions = {
      deny: 'Bash(git push *)',
    };
    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /adapters\.claude-code\.permissions\.deny must be an array/
    );
  });

  it('throws clearly on an unknown permission profile', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = {
      profile: 'unknown-profile',
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /adapters\.claude-code\.permissions\.profile.*agenticloop/
    );
  });

  it('throws clearly on an unknown permission scope', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = {
      scope: 'workspace',
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));

    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /adapters\.claude-code\.permissions\.scope.*project, local/
    );
  });

  it('merges into an existing valid project-scope settings file non-destructively', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = {
      profile: 'agenticloop',
      scope: 'project',
      deny: [],
    };
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const settingsPath = claudeSettingsPath(out, 'project');
    mkdirSync(join(out, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      permissions: {
        defaultMode: 'default',
        allow: ['Bash(ls *)'],
        deny: ['Bash(git push *)'],
      },
    }, null, 2) + '\n', 'utf-8');

    generateClaudeCodeArtifacts(cfg, fx, out);

    const settings = readJson(settingsPath);
    assert.equal(settings.model, 'opus');
    assert.equal(settings.permissions.defaultMode, 'default');
    assert.ok(settings.permissions.allow.includes('Bash(ls *)'));
    assert.ok(settings.permissions.allow.includes('Bash(gh *)'));
    assert.equal(
      settings.permissions.allow.filter(entry => entry === 'Bash(gh *)').length,
      1
    );
    assert.ok(settings.permissions.deny.includes('Bash(git push *)'));
  });

  it('does not overwrite an invalid existing .claude/settings.local.json', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const settingsPath = claudeSettingsPath(out, 'local');
    const invalid = '{"model": "opus",';
    mkdirSync(join(out, '.claude'), { recursive: true });
    writeFileSync(settingsPath, invalid, 'utf-8');

    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /Invalid JSON in \.claude\/settings\.local\.json/
    );
    assert.equal(readFileSync(settingsPath, 'utf-8'), invalid);
  });

  it('does not overwrite an existing .claude/settings.local.json with malformed permissions', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const settingsPath = claudeSettingsPath(out, 'local');
    const malformed = JSON.stringify({
      model: 'opus',
      permissions: [],
    }, null, 2) + '\n';
    mkdirSync(join(out, '.claude'), { recursive: true });
    writeFileSync(settingsPath, malformed, 'utf-8');

    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /Invalid \.claude\/settings\.local\.json: permissions must be an object/
    );
    assert.equal(readFileSync(settingsPath, 'utf-8'), malformed);
  });

  it('does not overwrite existing .claude/settings.local.json with malformed allow or deny arrays', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const settingsPath = claudeSettingsPath(out, 'local');
    mkdirSync(join(out, '.claude'), { recursive: true });

    const malformedAllow = JSON.stringify({
      model: 'opus',
      permissions: {
        allow: 'Bash(npm test *)',
      },
    }, null, 2) + '\n';
    writeFileSync(settingsPath, malformedAllow, 'utf-8');
    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /Invalid \.claude\/settings\.local\.json: permissions\.allow must be an array/
    );
    assert.equal(readFileSync(settingsPath, 'utf-8'), malformedAllow);

    const malformedDeny = JSON.stringify({
      model: 'opus',
      permissions: {
        deny: 'Bash(git push *)',
      },
    }, null, 2) + '\n';
    writeFileSync(settingsPath, malformedDeny, 'utf-8');
    assert.throws(
      () => generateClaudeCodeArtifacts(cfg, fx, out),
      /Invalid \.claude\/settings\.local\.json: permissions\.deny must be an array/
    );
    assert.equal(readFileSync(settingsPath, 'utf-8'), malformedDeny);
  });

  it('can opt out of settings generation while keeping role permissionMode rendering', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters['claude-code'].permissions = false;
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);

    assert.ok(!files.includes('.claude/settings.json'));
    assert.ok(!files.includes('.claude/settings.local.json'));
    assert.ok(!files.includes('.gitignore'));
    assert.equal(existsSync(claudeSettingsPath(out, 'project')), false);
    assert.equal(existsSync(claudeSettingsPath(out, 'local')), false);
    assert.ok(readClaudeAgent(out, 'engineer').includes('permissionMode: "acceptEdits"'));
  });

  it('agent body is rendered from the canonical role file', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    generateClaudeCodeArtifacts(cfg, fx, out);
    const md = readClaudeAgent(out, 'engineer');
    const canonical = readFileSync(join(fx, 'agenticloop', 'agents', 'engineer.md'), 'utf-8');
    assert.ok(canonical.includes('The engineer changes files for one task record at a time'),
      'precondition: canonical role file still has expected body text');
    assert.ok(md.includes('The engineer changes files for one task record at a time'),
      'expected canonical role body in generated agent body');
    assert.ok(md.includes('<!-- adapter:'),
      'agent file should include an adapter-generated trailer');
  });

  it('generates one public agenticloop skill with internal reference copies', () => {
    const fx = makeFixture();
    mkdirSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references'), { recursive: true });
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'SKILL.md'), [
      '---',
      'name: example-extra',
      'description: Use when testing generated skill directory copies.',
      '---',
      '',
      '# Example Extra',
      '',
    ].join('\n'));
    writeFileSync(join(fx, 'agenticloop', 'skills', 'example-extra', 'references', 'note.md'), 'supporting file\n');
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);

    const skillDir = join(out, '.claude', 'skills', 'agenticloop');
    const publicSkill = join(skillDir, 'SKILL.md');
    assert.ok(existsSync(publicSkill), 'expected one public agenticloop/SKILL.md');

    const skillText = readFileSync(publicSkill, 'utf-8');
    assert.ok(skillText.includes('name: "agenticloop"'));
    assert.ok(skillText.includes('disable-model-invocation: true'));
    assert.ok(skillText.includes('Read `.agenticloop/project.md` first.'));
    assert.ok(skillText.includes('references/skills/role-delegation/reference.md'));
    assert.ok(skillText.includes('Claude Code subagent `maintainer`'));
    assert.ok(skillText.includes('Claude Code subagent `engineer`'));

    // Internal procedures are reference.md copies, never discoverable SKILL.md.
    assert.ok(
      existsSync(join(skillDir, 'references', 'skills', 'example-extra', 'reference.md')),
      'canonical SKILL.md should be copied as reference.md'
    );
    assert.equal(
      existsSync(join(skillDir, 'references', 'skills', 'example-extra', 'SKILL.md')),
      false,
      'internal references must not keep a discoverable SKILL.md'
    );
    assert.equal(
      existsSync(join(skillDir, 'example-extra', 'SKILL.md')),
      false,
      'no legacy nested agenticloop/<name>/SKILL.md should be generated'
    );

    // Supporting files copied recursively under the reference directory.
    assert.ok(
      existsSync(join(skillDir, 'references', 'skills', 'example-extra', 'references', 'note.md')),
      'supporting skill files should be copied recursively under references'
    );

    // Every generated skill file stays under the single public skill dir, and
    // the only generated SKILL.md is the public one.
    const generatedSkillFiles = files.filter(f => f.startsWith('.claude/skills/'));
    assert.ok(
      generatedSkillFiles.every(f => f.startsWith('.claude/skills/agenticloop/')),
      `expected generated skills under agenticloop/: ${generatedSkillFiles.join(', ')}`
    );
    const generatedSkillMdFiles = generatedSkillFiles.filter(f => f.endsWith('/SKILL.md'));
    assert.deepEqual(generatedSkillMdFiles, ['.claude/skills/agenticloop/SKILL.md']);
  });

  it('clears stale legacy nested skill copies on regeneration', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));

    // Simulate the old shape: a nested discoverable skill copy.
    const legacyDir = join(out, '.claude', 'skills', 'agenticloop', 'role-delegation');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'SKILL.md'), '---\nname: role-delegation\n---\n\nstale\n');

    generateClaudeCodeArtifacts(cfg, fx, out);

    assert.equal(
      existsSync(join(legacyDir, 'SKILL.md')),
      false,
      'stale legacy nested skill copy should be removed on regeneration'
    );
    assert.ok(existsSync(join(out, '.claude', 'skills', 'agenticloop', 'SKILL.md')));
  });

  it('keeps target-owned skills outside agenticloop/ untouched', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'out-'));
    const projectSkillPath = join(out, '.claude', 'skills', 'project-owned', 'SKILL.md');
    mkdirSync(join(out, '.claude', 'skills', 'project-owned'), { recursive: true });
    writeFileSync(projectSkillPath, '# Project Skill\n', 'utf-8');

    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);
    const generatedSkillFiles = files.filter(f => f.startsWith('.claude/skills/'));

    assert.ok(generatedSkillFiles.length > 0, 'expected generated claude skill files');
    assert.ok(
      generatedSkillFiles.every(f => f.startsWith('.claude/skills/agenticloop/')),
      `expected generated skills to stay under agenticloop/: ${generatedSkillFiles.join(', ')}`
    );
    assert.equal(readFileSync(projectSkillPath, 'utf-8'), '# Project Skill\n');
  });
});
