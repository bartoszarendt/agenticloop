/**
 * Tests for src/adapters/opencode.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  generateOpencodeAgentRecords,
  generateOpencodeArtifacts,
  renderOpencodeAgentMarkdown,
  renderOpencodeCommandMarkdown,
} from '../src/adapters/opencode.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-opencode-adapter-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

describe('generateOpencodeAgentRecords', () => {
  it('produces fixed OpenCode agents with per-role model settings', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const agents = generateOpencodeAgentRecords(alConfig, fx);

    assert.deepEqual(Object.keys(agents), ['orchestrator', 'maintainer', 'engineer', 'auditor']);
    assert.equal(agents.orchestrator.mode, 'primary');
    assert.equal(agents.maintainer.mode, 'subagent');
    assert.equal(agents.engineer.mode, 'subagent');
    assert.equal(agents.auditor.mode, 'subagent');
    assert.equal(agents.orchestrator.model, alConfig.adapters.opencode.roleSettings.orchestrator.model);
    assert.equal(agents.maintainer.variant, alConfig.adapters.opencode.roleSettings.maintainer.reasoningEffort);
    assert.equal(agents.engineer.model, alConfig.adapters.opencode.roleSettings.engineer.model);
  });

  it('uses the configured skills source directory in prompt references', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    alConfig.skills = { sourceDirectory: 'process/skills' };

    const agents = generateOpencodeAgentRecords(alConfig, fx);

    assert.match(agents.orchestrator.prompt, /process\/skills\/role-delegation\/SKILL\.md/);
    assert.match(agents.orchestrator.prompt, /process\/skills\/blocked-state\/SKILL\.md/);
  });

  it('tells agents internal procedures are file paths, not host Skill tool invocations', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));

    const agents = generateOpencodeAgentRecords(alConfig, fx);

    assert.match(agents.engineer.prompt, /do not call the host Skill tool for them/);
  });

  it('includes the improvements/ target state in the path convention', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));

    const agents = generateOpencodeAgentRecords(alConfig, fx);

    assert.match(agents.orchestrator.prompt, /target project state \(project\.md, tasks\/, decisions\/, improvements\/\)/);
  });

  it('rewrites inline skill markers to canonical SKILL.md paths in the role body', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));

    const agents = generateOpencodeAgentRecords(alConfig, fx);

    assert.doesNotMatch(agents.engineer.prompt, /\[\[[a-z0-9-]+\]\]/);
    assert.match(agents.engineer.prompt, /agenticloop\/skills\/tdd-implementation\/SKILL\.md/);
  });

  it('uses the configured skills source directory when rewriting inline skill markers', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    alConfig.skills = { sourceDirectory: 'process/skills' };

    const agents = generateOpencodeAgentRecords(alConfig, fx);

    assert.match(agents.engineer.prompt, /process\/skills\/blocked-state\/SKILL\.md/);
    assert.doesNotMatch(agents.engineer.prompt, /\[\[blocked-state\]\]/);
  });
});

describe('renderOpencodeAgentMarkdown', () => {
  it('renders orchestrator frontmatter with permissions and prompt references', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const agent = generateOpencodeAgentRecords(alConfig, fx).orchestrator;
    const markdown = renderOpencodeAgentMarkdown(agent, 'orchestrator');
    const [frontmatter, body] = parseFrontmatter(markdown);

    assert.equal(frontmatter?.description, agent.description);
    assert.equal(frontmatter?.mode, 'primary');
    assert.equal(frontmatter?.model, agent.model);
    assert.equal(frontmatter?.variant, agent.variant);
    assert.equal(frontmatter?.permission?.edit, 'deny');
    assert.equal(frontmatter?.permission?.task?.['*'], 'deny');
    assert.equal(frontmatter?.permission?.task?.maintainer, 'allow');
    assert.equal(frontmatter?.permission?.task?.engineer, 'allow');
    assert.equal(frontmatter?.permission?.task?.auditor, 'allow');
    assert.match(body, /Generated by Agentic Loop/);
    assert.match(body, /You are the Orchestrator for the target project\./);
    assert.match(body, /Follow agenticloop\/agents\/orchestrator\.md as the canonical role contract\./);
    assert.match(body, /\.agenticloop\/project\.md/);
    assert.match(body, /agenticloop\/skills\/role-delegation\/SKILL\.md/);
    assert.match(body, /agenticloop\/skills\/blocked-state\/SKILL\.md/);
    assert.match(body, /In OpenCode, use the Task tool or explicit @maintainer \/ @engineer \/ @auditor invocation when available/);
  });

  it('renders the auditor subagent with edit denied', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const agent = generateOpencodeAgentRecords(alConfig, fx).auditor;
    const markdown = renderOpencodeAgentMarkdown(agent, 'auditor');
    const [frontmatter, body] = parseFrontmatter(markdown);

    assert.equal(frontmatter?.mode, 'subagent');
    assert.equal(frontmatter?.permission?.edit, 'deny');
    assert.equal(frontmatter?.permission?.task, undefined);
    assert.match(body, /You are the Auditor for the target project\./);
    assert.match(body, /read-only with respect to implementation/);
    assert.match(body, /agenticloop\/skills\/work-unit-audit\/SKILL\.md/);
  });

  it('renders subagent frontmatter without orchestrator permissions', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const agent = generateOpencodeAgentRecords(alConfig, fx).engineer;
    const markdown = renderOpencodeAgentMarkdown(agent, 'engineer');
    const [frontmatter, body] = parseFrontmatter(markdown);

    assert.equal(frontmatter?.mode, 'subagent');
    assert.equal(frontmatter?.model, agent.model);
    assert.equal(frontmatter?.variant, agent.variant);
    assert.equal(frontmatter?.permission, undefined);
    assert.match(body, /agenticloop\/skills\/task-record-contract\/SKILL\.md/);
    assert.match(body, /agenticloop\/skills\/verification-evidence\/SKILL\.md/);
  });

  it('renders a backend-neutral engineer description without unconditional pull-request wording', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const agent = generateOpencodeAgentRecords(alConfig, fx).engineer;
    const markdown = renderOpencodeAgentMarkdown(agent, 'engineer');
    const [frontmatter] = parseFrontmatter(markdown);

    assert.equal(frontmatter?.description, agent.description);
    assert.doesNotMatch(frontmatter?.description ?? '', /opens pull requests/i);
    assert.match(frontmatter?.description ?? '', /records implementation artifacts/i);
  });
});

describe('renderOpencodeCommandMarkdown', () => {
  it('binds the command to orchestrator without a model field', () => {
    const command = renderOpencodeCommandMarkdown();
    const [frontmatter, body] = parseFrontmatter(command);

    assert.equal(frontmatter?.agent, 'orchestrator');
    assert.equal(frontmatter?.model, undefined);
    assert.match(body, /\.agenticloop\/project\.md/);
    assert.match(body, /Create or refine the durable task record before any implementation\./);
    assert.match(body, /\$ARGUMENTS/);
  });
});

describe('generateOpencodeArtifacts', () => {
  it('each role artifact inherits a distinctive Project Operating Facts responsibility', () => {
    const outputDir = join(tmpDir, 'pof-generated');
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    generateOpencodeArtifacts(alConfig, fx, outputDir);

    const read = (role) => readFileSync(join(outputDir, '.opencode', 'agents', `${role}.md`), 'utf-8');
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

  it('writes only markdown agents and the OpenCode command', () => {
    const outputDir = join(tmpDir, 'generated');
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));

    const { files } = generateOpencodeArtifacts(alConfig, fx, outputDir);

    assert.deepEqual(files.sort(), [
      '.opencode/agents/auditor.md',
      '.opencode/agents/engineer.md',
      '.opencode/agents/maintainer.md',
      '.opencode/agents/orchestrator.md',
      '.opencode/commands/agenticloop.md',
    ]);
    assert.equal(readFileSync(join(outputDir, '.opencode', 'agents', 'orchestrator.md'), 'utf-8').includes('mode: "primary"'), true);
    assert.equal(existsSync(join(outputDir, 'opencode.jsonc')), false);
  });
});
