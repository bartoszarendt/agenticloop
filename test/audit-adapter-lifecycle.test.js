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
  readdirSync,
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

describe('generated-adapter auditor contract', () => {
  const HOSTS = [
    { name: 'opencode', generate: generateOpencodeArtifacts, dir: '.opencode' },
    { name: 'codex', generate: generateCodexArtifacts, dir: '.codex' },
    { name: 'claude-code', generate: generateClaudeCodeArtifacts, dir: '.claude' },
    { name: 'copilot', generate: generateCopilotArtifacts, dir: '.github' },
    { name: 'cursor', generate: generateCursorArtifacts, dir: '.cursor' },
  ];

  function hostText(root, dir) {
    const base = join(root, dir);
    const chunks = [];
    const walk = current => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else chunks.push(readFileSync(full, 'utf-8'));
      }
    };
    walk(base);
    return chunks.join('\n');
  }

  it('every generated host requires fresh Auditor delegation, auditor_report_v1 transport, and no same-session fallback', () => {
    for (const host of HOSTS) {
      const fx = makeFixture();
      const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
      const out = mkdtempSync(join(tmpDir, `contract-${host.name}-`));
      host.generate(cfg, fx, out);
      const text = hostText(out, host.dir);
      assert.match(text, /auditor_report_v1/, `${host.name}: generated guidance must name the auditor_report_v1 transport`);
      assert.match(text, /fresh (spawn|invocation|delegation)|fresh Auditor/i,
        `${host.name}: generated guidance must require a fresh Auditor delegation per audit`);
      assert.match(text, /no same-session audit|same-session audit (does not satisfy|is not)/i,
        `${host.name}: generated guidance must forbid a same-session audit fallback`);
    }
  });

  const AUDITOR_FILES = {
    opencode: ['.opencode', 'agents', 'auditor.md'],
    codex: ['.codex', 'agents', 'auditor.toml'],
    'claude-code': ['.claude', 'agents', 'auditor.md'],
    copilot: ['.github', 'agents', 'auditor.agent.md'],
    cursor: ['.cursor', 'agents', 'auditor.md'],
  };

  /**
   * Read a generated auditor surface with host string-escaping undone. Codex
   * embeds the role body in a quoted TOML scalar and OpenCode in a quoted YAML
   * scalar, so the same canonical sentence appears with literal `\n` and `\"`
   * on those hosts; decoding keeps one set of contract assertions for all five.
   */
  function auditorText(host) {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, `auditor-${host.name}-`));
    host.generate(cfg, fx, out);
    const raw = readFileSync(join(out, ...AUDITOR_FILES[host.name]), 'utf-8');
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }

  /**
   * Split a generated auditor surface at the Agentic Loop-mode heading. Both
   * modes ship in one file, so the certification firewall is only meaningful
   * when it is checked against the standalone half specifically.
   */
  function splitModes(text) {
    const marker = text.indexOf('## Agentic Loop Mode');
    assert.notEqual(marker, -1, 'generated auditor must carry the canonical Agentic Loop Mode section');
    const standaloneStart = text.indexOf('## Standalone Mode');
    assert.notEqual(standaloneStart, -1, 'generated auditor must carry the canonical Standalone Mode section');
    assert.ok(standaloneStart < marker, 'standalone mode must appear before Agentic Loop mode');
    return { standalone: text.slice(standaloneStart, marker), agenticLoop: text.slice(marker) };
  }

  it('every generated auditor role emits the Agentic Loop-mode auditor_report_v1 wire format from canonical source', () => {
    for (const host of HOSTS) {
      const content = auditorText(host);
      assert.match(content, /auditor_report_v1/, `${host.name}: generated auditor role must emit auditor_report_v1`);
      // The formal wire format belongs to Agentic Loop mode specifically.
      const { agenticLoop } = splitModes(content);
      assert.match(agenticLoop, /Return exactly one `auditor_report_v1` JSON object/,
        `${host.name}: the Agentic Loop-mode section must keep the exact auditor_report_v1 return contract`);
      assert.match(agenticLoop, /"report_schema": "auditor_report_v1"/,
        `${host.name}: the Agentic Loop-mode section must keep the exact report schema`);
      assert.match(agenticLoop, /Return exactly one verdict: `certified`,\s*`certified_with_accepted_limitations`, `needs_remediation`, or\s*`needs_human_decision`/,
        `${host.name}: the Agentic Loop-mode section must keep all four formal verdicts`);
    }
  });

  it('every generated auditor also exposes a standalone non-certifying mode', () => {
    for (const host of HOSTS) {
      const content = auditorText(host);
      assert.match(content, /## Mode Selection/, `${host.name}: generated auditor must carry mode selection`);
      assert.match(content, /otherwise operate as a standalone auditor/i,
        `${host.name}: standalone must be the default mode`);
      const { standalone } = splitModes(content);
      assert.match(standalone, /requires no task\s*ID, audit ID, audit packet, audit record/i,
        `${host.name}: standalone mode must require no Agentic Loop packet metadata`);
      assert.match(standalone, /non-certifying assessment/i,
        `${host.name}: standalone mode must identify itself as non-certifying`);
      assert.match(standalone, /certifies nothing and\s*cannot satisfy Agentic Loop work-unit auditing, certification, or closeout/i,
        `${host.name}: standalone mode must disclaim work-unit certification`);
      assert.match(standalone, /formal certification requires a fresh, packet-bound Agentic Loop\s*Auditor invocation/i,
        `${host.name}: standalone mode must route certification to a fresh packet-bound invocation`);
    }
  });

  it('the standalone section never offers auditor_report_v1 or a formal verdict as its return format', () => {
    for (const host of HOSTS) {
      const { standalone } = splitModes(auditorText(host));
      assert.match(standalone, /Do not return `auditor_report_v1`, an Agentic Loop `verdict` field/,
        `${host.name}: standalone mode must forbid the formal return shape`);
      assert.ok(!/Return exactly one `auditor_report_v1`/.test(standalone),
        `${host.name}: standalone mode must not present auditor_report_v1 as its return format`);
      assert.ok(!/Return exactly one verdict/.test(standalone),
        `${host.name}: standalone mode must not present a formal verdict as its return format`);
    }
  });

  it('formal certification keeps its fresh, packet-bound, non-substitutable invocation', () => {
    for (const host of HOSTS) {
      const content = auditorText(host);
      assert.match(content, /work-unit certification always requires a\s*fresh, packet-bound Auditor invocation/i,
        `${host.name}: certification must stay packet-bound and fresh`);
      assert.match(content, /Every re-audit is a new invocation with a new invocation reference/i,
        `${host.name}: every re-audit must be a new invocation`);
      assert.match(content, /no\s*same-session audit and no single-agent audit fallback/i,
        `${host.name}: same-session audit must stay forbidden`);
      assert.match(content, /non-substitutable/i,
        `${host.name}: a maintainer invocation must not be able to serve as the Auditor`);
      assert.match(content, /Never silently downgrade\s*(?:an activated or formal|a formal) certification request\s+to standalone mode/i,
        `${host.name}: formal certification intent must never be silently downgraded`);
    }
  });
});

describe('plugin manifests own the auditor role', () => {
  it('the Claude plugin manifest lists the auditor agent', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
    assert.ok(manifest.agents.includes('./agents/auditor.md'), manifest.agents.join(', '));
  });
});
