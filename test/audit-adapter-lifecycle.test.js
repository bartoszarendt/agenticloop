/**
 * Cross-adapter Auditor lifecycle.
 *
 * Every supported adapter generates the Auditor role from canonical source with
 * the strongest supported read-only posture; update preserves its model; removal
 * takes it out; and the plugin manifests own it. Deterministic fixtures only.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { parseFrontmatter } from '../src/frontmatter.js';
import { preserveExistingAdapterModelSettings } from '../src/adapter-model-preservation.js';
import { adapterDiscoverySummary } from '../src/adapter-discovery.js';
import { removeAgenticLoop } from '../src/remove.js';
import { validateConfig } from '../src/validate-config.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-adapter-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

describe('auditor adapter generation', () => {
  it('all five adapters generate an auditor agent from canonical source', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));

    const out = mkdtempSync(join(tmpDir, 'gen-'));
    generateOpencodeArtifacts(cfg, fx, out);
    generateCodexArtifacts(cfg, fx, out);
    generateClaudeCodeArtifacts(cfg, fx, out);
    generateCopilotArtifacts(cfg, fx, out);
    generateCursorArtifacts(cfg, fx, out);

    assert.ok(existsSync(join(out, '.opencode', 'agents', 'auditor.md')));
    assert.ok(existsSync(join(out, '.codex', 'agents', 'auditor.toml')));
    assert.ok(existsSync(join(out, '.claude', 'agents', 'auditor.md')));
    assert.ok(existsSync(join(out, '.github', 'agents', 'auditor.agent.md')));
    assert.ok(existsSync(join(out, '.cursor', 'agents', 'auditor.md')));
  });

  it('OpenCode allows the orchestrator to delegate to auditor and denies auditor edits', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'oc-'));
    generateOpencodeArtifacts(cfg, fx, out);

    const [orchestrator] = parseFrontmatter(readFileSync(join(out, '.opencode', 'agents', 'orchestrator.md'), 'utf-8'));
    assert.equal(orchestrator.permission.task.auditor, 'allow');

    const [auditor] = parseFrontmatter(readFileSync(join(out, '.opencode', 'agents', 'auditor.md'), 'utf-8'));
    assert.equal(auditor.permission.edit, 'deny');
    assert.equal(auditor.mode, 'subagent');
  });

  it('Claude Code generates the auditor with permissionMode plan', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'cc-'));
    generateClaudeCodeArtifacts(cfg, fx, out);

    const [frontmatter] = parseFrontmatter(readFileSync(join(out, '.claude', 'agents', 'auditor.md'), 'utf-8'));
    assert.equal(frontmatter.permissionMode, 'plan');
    // Maintainer/engineer stay acceptEdits; the audit posture must not weaken them.
    const [maintainer] = parseFrontmatter(readFileSync(join(out, '.claude', 'agents', 'maintainer.md'), 'utf-8'));
    assert.equal(maintainer.permissionMode, 'acceptEdits');
  });

  it('Copilot withholds the edit tool from the auditor and allows delegation to it', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'cp-'));
    generateCopilotArtifacts(cfg, fx, out);

    const auditor = readFileSync(join(out, '.github', 'agents', 'auditor.agent.md'), 'utf-8');
    assert.ok(!/^\s+-\s+"edit"/m.test(auditor), 'auditor must not be granted the edit tool');
    const orchestrator = readFileSync(join(out, '.github', 'agents', 'orchestrator.agent.md'), 'utf-8');
    assert.match(orchestrator, /-\s+"auditor"/);
  });

  it('Cursor generates the auditor with readonly: true', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'cu-'));
    generateCursorArtifacts(cfg, fx, out);

    const [frontmatter] = parseFrontmatter(readFileSync(join(out, '.cursor', 'agents', 'auditor.md'), 'utf-8'));
    assert.equal(String(frontmatter.readonly), 'true');
  });

  it('generated adapter output validates cleanly with the auditor role present', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    generateOpencodeArtifacts(cfg, fx, fx);
    generateClaudeCodeArtifacts(cfg, fx, fx);
    const { errors } = validateConfig(fx, { adapters: ['opencode', 'claude-code'] });
    assert.deepEqual(errors, [], errors.join('\n'));
  });
});

describe('auditor adapter lifecycle', () => {
  it('discovery reports the auditor among missing model roles when unconfigured', () => {
    const fx = makeFixture();
    // Strip the auditor model but keep the other three configured.
    const cfgPath = join(fx, 'agenticloop.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    delete cfg.adapters.opencode.roleSettings.auditor;
    cfg.adapters.opencode.enabled = true;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');

    const { adapters } = adapterDiscoverySummary(fx);
    const opencode = adapters.find(a => a.host === 'opencode');
    assert.ok(opencode.missingModelRoles.includes('auditor'), 'auditor must appear in missing model roles');
  });

  it('update preserves an auditor model edited into the generated OpenCode agent', () => {
    const fx = makeFixture();
    const cfgPath = join(fx, 'agenticloop.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    delete cfg.adapters.opencode.roleSettings.auditor;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');

    const reloaded = loadAgenticLoopConfig(cfgPath);
    generateOpencodeArtifacts(reloaded, fx, fx);

    // Simulate a target editing the generated auditor model directly.
    const auditorPath = join(fx, '.opencode', 'agents', 'auditor.md');
    const original = readFileSync(auditorPath, 'utf-8');
    writeFileSync(auditorPath, original.replace(/model: "[^"]*"/, 'model: "test/opencode-auditor-edited"'), 'utf-8');

    const result = preserveExistingAdapterModelSettings(fx, ['opencode']);
    assert.ok(result.updated.includes('adapters.opencode.roleSettings.auditor.model'), result.updated.join(', '));
    const after = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(after.adapters.opencode.roleSettings.auditor.model, 'test/opencode-auditor-edited');
  });

  it('remove takes out generated auditor artifacts across hosts', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    generateOpencodeArtifacts(cfg, fx, fx);
    generateCodexArtifacts(cfg, fx, fx);
    generateClaudeCodeArtifacts(cfg, fx, fx);

    assert.ok(existsSync(join(fx, '.opencode', 'agents', 'auditor.md')));
    assert.ok(existsSync(join(fx, '.claude', 'agents', 'auditor.md')));

    removeAgenticLoop({ target: fx, apply: true });

    assert.ok(!existsSync(join(fx, '.opencode', 'agents', 'auditor.md')));
    assert.ok(!existsSync(join(fx, '.codex', 'agents', 'auditor.toml')));
    assert.ok(!existsSync(join(fx, '.claude', 'agents', 'auditor.md')));
  });
});

describe('plugin manifests own the auditor role', () => {
  it('the Claude plugin manifest lists the auditor agent', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
    assert.ok(manifest.agents.includes('./agents/auditor.md'), manifest.agents.join(', '));
  });
});
