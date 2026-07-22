/**
 * Tests for src/adapters/opencode.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  generateOpencodeAgentRecords,
  generateOpencodeArtifacts,
  planOpencodeArtifacts,
  renderOpencodeAgentMarkdown,
  renderOpencodeCommandMarkdown,
  renderOpencodeSupervisorAgentMarkdown,
} from '../src/adapters/opencode.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import {
  buildOpencodeSupervisorPrompt,
  normalizeOpencodePermissionRequest,
  renderOpencodeSupervisionPlugin,
} from '../src/adapters/opencode-supervision-plugin.js';

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

    assert.deepEqual(Object.keys(agents), ['orchestrator', 'maintainer', 'engineer']);
    assert.equal(agents.orchestrator.mode, 'primary');
    assert.equal(agents.maintainer.mode, 'subagent');
    assert.equal(agents.engineer.mode, 'subagent');
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
    assert.match(body, /Generated by Agentic Loop/);
    assert.match(body, /You are the Orchestrator for the target project\./);
    assert.match(body, /Follow agenticloop\/agents\/orchestrator\.md as the canonical role contract\./);
    assert.match(body, /\.agenticloop\/project\.md/);
    assert.match(body, /agenticloop\/skills\/role-delegation\/SKILL\.md/);
    assert.match(body, /agenticloop\/skills\/blocked-state\/SKILL\.md/);
    assert.match(body, /In OpenCode, use the Task tool or explicit @maintainer \/ @engineer invocation when available/);
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

describe('renderOpencodeSupervisorAgentMarkdown', () => {
  it('renders a restricted supervisor that cannot edit, delegate, or ask for approval', () => {
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    alConfig.supervision = { supervisor: { model: 'provider/supervisor' } };
    const [frontmatter, body] = parseFrontmatter(renderOpencodeSupervisorAgentMarkdown(alConfig));

    assert.equal(frontmatter?.mode, 'subagent');
    assert.equal(frontmatter?.model, 'provider/supervisor');
    assert.equal(frontmatter?.permission?.edit, 'deny');
    assert.equal(frontmatter?.permission?.task, 'deny');
    assert.match(body, /must not edit files, accept work, close tasks/);
  });
});

describe('OpenCode supervision bridge helpers', () => {
  it('projects one bounded permission scope into only its own supervisor prompt', () => {
    const scoped = buildOpencodeSupervisorPrompt({
      action_context: { request_id: 'req-1', target: 'lane-a' },
      question: 'Assess the permission',
      state: { controller: { status: 'running' } },
      permission_scope: { request_id: 'req-1', operation: 'bash', command: 'npm test' },
    });
    assert.match(scoped, /Permission scope:/);
    assert.match(scoped, /"request_id":"req-1"/);
    assert.match(scoped, /"command":"npm test"/);

    const unscoped = buildOpencodeSupervisorPrompt({
      action_context: { target: 'root' },
      question: 'Routine health assessment',
      state: { controller: { status: 'running' } },
    });
    assert.doesNotMatch(unscoped, /Permission scope:/);
    assert.doesNotMatch(unscoped, /npm test/);
    assert.match(renderOpencodeSupervisionPlugin(), /buildOpencodeSupervisorPrompt\(params\)/);
  });

  it('normalizes pinned permission event fields without inventing metadata paths', () => {
    assert.deepEqual(
      normalizeOpencodePermissionRequest({ id: 'read-1', sessionID: 'session-1', type: 'read', pattern: ['src/index.js'], metadata: {} }, 'C:/project'),
      { id: 'read-1', session_id: 'session-1', operation: 'read', patterns: ['src/index.js'], metadata: {}, working_directory: 'C:/project' },
    );
    assert.deepEqual(
      normalizeOpencodePermissionRequest({ id: 'edit-1', sessionID: 'session-1', type: 'edit', pattern: 'src/new.js', metadata: { filepath: 'src/new.js' } }, 'C:/project').patterns,
      ['src/new.js'],
    );
  });
});

describe('generateOpencodeArtifacts', () => {
  it('executes the generated plugin module and preserves exact command-token boundaries', async () => {
    const generated = renderOpencodeSupervisionPlugin()
      .replace('import { tool } from "@opencode-ai/plugin"', 'const tool = globalThis.__agenticloopTool');
    const compiled = ts.transpileModule(generated, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const modulePath = join(tmpDir, 'generated-supervision-' + Date.now() + '.mjs');
    writeFileSync(modulePath, compiled, 'utf8');
    const schema = { optional() { return this; } };
    const toolStub = definition => definition;
    toolStub.schema = { string: () => ({ ...schema }) };
    globalThis.__agenticloopTool = toolStub;
    try {
      const module = await import(pathToFileURL(modulePath).href + '?v=' + Date.now());
      let hostCalls = 0;
      const plugin = await module.AgenticLoopSupervision({
        directory: tmpDir,
        client: {
          session: {
            create: async () => { hostCalls += 1; },
            abort: async () => { hostCalls += 1; },
            prompt: async () => { hostCalls += 1; },
            promptAsync: async () => { hostCalls += 1; },
            list: async () => { hostCalls += 1; },
          },
          postSessionIdPermissionsPermissionId: async () => { hostCalls += 1; },
          tui: { showToast: async () => { hostCalls += 1; } },
        },
      });
      await plugin['command.execute.before']({ command: 'agenticloop', arguments: 'supervisor-facing work' }, { parts: [] });
      await plugin['command.execute.before']({ command: 'agenticloop', arguments: '--supervisedX work' }, { parts: [] });
      assert.equal(hostCalls, 0, 'prefix lookalikes remain ordinary commands and never start supervision');
      assert.ok(plugin.tool.agenticloop_delegate);
      assert.ok(plugin.tool.agenticloop_checkpoint);
    } finally {
      delete globalThis.__agenticloopTool;
    }
  });

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

  it('writes the separately enabled supervision bridge artifacts', () => {
    const outputDir = join(tmpDir, 'generated');
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    alConfig.supervision = { enabled: true, supervisor: { model: 'provider/supervisor' } };

    const { files } = generateOpencodeArtifacts(alConfig, fx, outputDir);

    assert.deepEqual(files.sort(), [
      '.opencode/agents/agenticloop-supervisor.md',
      '.opencode/agents/engineer.md',
      '.opencode/agents/maintainer.md',
      '.opencode/agents/orchestrator.md',
      '.opencode/commands/agenticloop.md',
      '.opencode/plugins/agenticloop-supervision.ts',
    ]);
    assert.equal(readFileSync(join(outputDir, '.opencode', 'agents', 'orchestrator.md'), 'utf-8').includes('mode: "primary"'), true);
    const plugin = readFileSync(join(outputDir, '.opencode', 'plugins', 'agenticloop-supervision.ts'), 'utf-8');
    assert.match(plugin, /command\.execute\.before/);
    assert.match(plugin, /agenticloop_delegate/);
    assert.match(plugin, /raw Task delegation is unavailable in supervised mode/);
    assert.match(plugin, /event\.type === "permission\.updated"/);
    assert.doesNotMatch(plugin, /event\.type === "permission\.asked"/);
    assert.doesNotMatch(plugin, /outputFormat:/);
    assert.match(plugin, /payload\.parts/);
    assert.match(plugin, /postSessionIdPermissionsPermissionId/);
    assert.match(plugin, /missingClientMethods/);
    assert.match(plugin, /registeredSessionIDs\.has/);
    assert.match(plugin, /activeSocket\.once\("close"/);
    assert.match(plugin, /reconciliation \}/);
    assert.match(plugin, /host\.lane\.create/);
    assert.match(plugin, /host\.lane\.start/);
    assert.match(plugin, /action_context/);
    assert.match(plugin, /delegation_envelope/);
    assert.match(plugin, /dispose: async/);
    assert.match(plugin, /taskkill\.exe/);
    assert.equal(existsSync(join(outputDir, 'opencode.jsonc')), false);
  });

  it('embeds the shared event contract and keeps the bridge free of synthetic identities', () => {
    const outputDir = join(tmpDir, 'generated-contract');
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    alConfig.supervision = { enabled: true, supervisor: { model: 'provider/supervisor' } };
    generateOpencodeArtifacts(alConfig, fx, outputDir);
    const plugin = readFileSync(join(outputDir, '.opencode', 'plugins', 'agenticloop-supervision.ts'), 'utf-8');

    assert.match(plugin, /function extractOpencodeEventId\(/);
    assert.match(plugin, /function classifyOpencodeOutcome\(/);
    assert.match(plugin, /const eventID = extractOpencodeEventId\(event\)/);
    assert.match(plugin, /classifyOpencodeOutcome\(properties\)/);
    // No synthetic per-event identity may be reintroduced.
    assert.doesNotMatch(plugin, /"session-error-"/);
    assert.doesNotMatch(plugin, /"lane-idle-"/);
    assert.doesNotMatch(plugin, /"root-idle-"/);
    assert.doesNotMatch(plugin, /properties\.eventID \|\| properties\.id/);
    // Reattachment and lifecycle behaviour.
    assert.match(plugin, /bridge\.reattach/);
    assert.match(plugin, /rebuildRegistriesFromController/);
    assert.match(plugin, /laneRegistry\.clear\(\)/);
    assert.match(plugin, /drainControllerStderr/);
    const dispose = plugin.slice(plugin.indexOf('dispose: async'));
    assert.doesNotMatch(dispose, /command: "stop"/);
    assert.doesNotMatch(plugin, /orphaned_process/);
  });

  it('does not install the optional supervision component for ordinary OpenCode generation', () => {
    const outputDir = join(tmpDir, 'generated-ordinary');
    const fx = makeFixture();
    const alConfig = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const { files } = generateOpencodeArtifacts(alConfig, fx, outputDir);
    assert.equal(files.includes('.opencode/agents/agenticloop-supervisor.md'), false);
    assert.equal(files.includes('.opencode/plugins/agenticloop-supervision.ts'), false);
    const plan = planOpencodeArtifacts(alConfig, fx, outputDir);
    assert.ok(plan.actions.some(action => action.type === 'clear-owned-path' && action.relPath === '.opencode/plugins/agenticloop-supervision.ts'));
    assert.equal(plan.actions.some(action => action.type === 'write-file' && action.relPath === '.opencode/plugins/agenticloop-supervision.ts'), false);
  });
});
