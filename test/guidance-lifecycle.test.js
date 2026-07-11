/**
 * Guidance lifecycle (init / setup / update / remove), guidance CLI, and
 * activation-semantics content guards.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  generateOpencodeArtifacts,
} from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');
const GUIDANCE_MARKER = '<!-- AGENTICLOOP_START -->';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-guidance-life-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function target() { return mkdtempSync(join(tmpDir, 'target-')); }
function run(args, options = {}) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', ...options }); }
function agents(dir) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
function hasBlock(dir, name = 'AGENTS.md') {
  const p = join(dir, name);
  return existsSync(p) && readFileSync(p, 'utf8').includes(GUIDANCE_MARKER);
}

function configuredRules(dir, rulesPath = 'RULES.md') {
  writeFileSync(join(dir, 'agenticloop.json'), JSON.stringify({
    version: 1,
    documents: { rules: rulesPath },
  }, null, 2));
}

describe('guidance lifecycle', () => {
  it('new init installs guidance by default and creates AGENTS.md', () => {
    const dir = target();
    const r = run(['init', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(hasBlock(dir), 'AGENTS.md should contain the guidance block');
  });

  it('new init with --no-agents-guidance does not install guidance', () => {
    const dir = target();
    const r = run(['init', '--target', dir, '--no-agents-guidance']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });

  it('init preserves an existing rules document and appends the block', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), '# Project Rules\n\nProtected user content.\n');
    run(['init', '--target', dir]);
    const body = agents(dir);
    assert.ok(body.startsWith('# Project Rules\n\nProtected user content.\n'));
    assert.ok(body.includes(GUIDANCE_MARKER));
  });

  it('init is idempotent and does not duplicate the block', () => {
    const dir = target();
    run(['init', '--target', dir]);
    run(['init', '--target', dir]);
    const count = agents(dir).split(GUIDANCE_MARKER).length - 1;
    assert.equal(count, 1);
  });

  it('init honors configured RULES.md and does not create AGENTS.md', () => {
    const dir = target();
    writeFileSync(join(dir, 'RULES.md'), '# Rules\n');
    configuredRules(dir);
    const r = run(['init', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(hasBlock(dir, 'RULES.md'));
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });

  it('update refreshes an already-owned block', () => {
    const dir = target();
    run(['init', '--target', dir, '--adapter', 'claude-code']);
    assert.ok(hasBlock(dir));
    const r = run(['update', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(hasBlock(dir), 'owned block preserved/refreshed on update');
  });

  it('update does not enroll an existing installation with no owned block', () => {
    const dir = target();
    run(['init', '--target', dir, '--adapter', 'claude-code']);
    // Remove the guidance block (releases ownership) but keep the installation.
    run(['guidance', 'remove', '--target', dir]);
    assert.equal(hasBlock(dir), false);
    const r = run(['update', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hasBlock(dir), false, 'update must not re-enroll');
  });

  it('remove strips owned guidance and preserves protected content', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n\nProtected.\n');
    run(['init', '--target', dir, '--adapter', 'claude-code']);
    assert.ok(hasBlock(dir));
    const r = run(['remove', '--target', dir, '--yes']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'AGENTS.md')));
    assert.equal(hasBlock(dir), false);
    assert.ok(agents(dir).includes('Protected.'));
  });

  it('fresh setup enrolls by default while repeat setup does not re-enroll after removal', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n');
    let r = run(['setup', '--target', dir], { input: 'yes\n4\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(hasBlock(dir));
    run(['guidance', 'remove', '--target', dir]);
    r = run(['setup', '--target', dir], { input: '4\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hasBlock(dir), false);
  });

  it('fresh setup honors --no-agents-guidance', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n');
    const r = run(['setup', '--target', dir, '--no-agents-guidance'], { input: 'yes\n4\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hasBlock(dir), false);
  });

  it('setup applies fresh guidance to configured RULES.md', () => {
    const dir = target();
    writeFileSync(join(dir, 'RULES.md'), '# Rules\n');
    configuredRules(dir);
    const r = run(['setup', '--target', dir], { input: 'yes\n4\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(hasBlock(dir, 'RULES.md'));
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });
});

describe('guidance CLI subcommands', () => {
  it('check reports absent then current', () => {
    const dir = target();
    let r = run(['guidance', 'check', '--target', dir]);
    assert.match(r.stdout, /absent/);
    run(['guidance', 'apply', '--target', dir]);
    r = run(['guidance', 'check', '--target', dir]);
    assert.match(r.stdout, /current and owned/);
  });

  it('apply is idempotent and remove is idempotent', () => {
    const dir = target();
    run(['guidance', 'apply', '--target', dir]);
    const second = run(['guidance', 'apply', '--target', dir]);
    assert.equal(second.status, 0);
    run(['guidance', 'remove', '--target', dir]);
    const r = run(['guidance', 'remove', '--target', dir]);
    assert.equal(r.status, 0);
  });

  it('apply, check, and remove all use the configured rules document', () => {
    const dir = target();
    writeFileSync(join(dir, 'RULES.md'), '# Local rules\n');
    configuredRules(dir);
    let r = run(['guidance', 'apply', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RULES\.md/);
    assert.ok(hasBlock(dir, 'RULES.md'));
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
    r = run(['guidance', 'check', '--target', dir]);
    assert.match(r.stdout, /RULES\.md/);
    r = run(['guidance', 'remove', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hasBlock(dir, 'RULES.md'), false);
  });

  it('does not silently fall back to AGENTS.md when target config is malformed', () => {
    const dir = target();
    writeFileSync(join(dir, 'RULES.md'), '# Local rules\n');
    writeFileSync(join(dir, 'agenticloop.json'), '{ invalid');
    const r = run(['guidance', 'apply', '--target', dir]);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
    assert.equal(hasBlock(dir, 'RULES.md'), false);
  });

  it('init reports a malformed target config instead of failing silently', () => {
    const dir = target();
    writeFileSync(join(dir, 'agenticloop.json'), '{ invalid');
    const r = run(['init', '--target', dir]);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}\n${r.stderr}`, /ERROR: agenticloop\.json is malformed/i);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  });

  it('reports path drift and removes the recorded block at its old path', () => {
    const dir = target();
    writeFileSync(join(dir, 'RULES.md'), '# Old rules\n');
    configuredRules(dir);
    run(['guidance', 'apply', '--target', dir]);
    writeFileSync(join(dir, 'NEW_RULES.md'), '# New rules\n');
    configuredRules(dir, 'NEW_RULES.md');
    const update = run(['update', '--target', dir]);
    assert.equal(update.status, 0, update.stderr);
    assert.match(`${update.stdout}\n${update.stderr}`, /owned guidance remains at RULES\.md/i);
    assert.equal(hasBlock(dir, 'NEW_RULES.md'), false);
    const check = run(['guidance', 'check', '--target', dir]);
    assert.notEqual(check.status, 0);
    assert.match(check.stdout, /previous rules path/);
    const removed = run(['guidance', 'remove', '--target', dir]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(hasBlock(dir, 'RULES.md'), false);
    assert.equal(hasBlock(dir, 'NEW_RULES.md'), false);
  });
});

describe('activation semantics content guards', () => {
  it('AGENTIC_LOOP.md carries a discovery-is-not-activation guard', () => {
    const text = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf8');
    assert.match(text, /## Activation Boundary/);
    assert.match(text, /Discovering the\s+installed toolkit or reading this document does not activate/);
    assert.match(text, /Standalone engineer delegation is not activation/i);
    assert.match(text, /mentioning a task ID without operational intent/i);
  });

  it('canonical engineer role documents both modes and forbids standalone bookkeeping', () => {
    const raw = readFileSync(join(REPO_ROOT, 'agents', 'engineer.md'), 'utf8');
    const text = raw.replace(/\s+/g, ' ');
    assert.match(raw, /## Mode Selection/);
    assert.match(raw, /## Standalone Mode/);
    assert.match(raw, /## Agentic Loop Mode/);
    assert.match(text, /bare task ID by itself does not force Agentic Loop mode/i);
    assert.match(text, /must never cause the engineer to stop or fail/i);
    assert.match(text, /creates no Agentic Loop state|no Agentic Loop workflow state is created/i);
    assert.match(text, /outside the engineer role in both modes/i);
    // Old unconditional wording must be gone.
    assert.ok(!raw.includes('The engineer changes files for one task record at a time'));
  });
});

describe('generated engineer surfaces are dual-mode across adapters', () => {
  const HOSTS = [
    { name: 'opencode', generate: generateOpencodeArtifacts, path: '.opencode/agents/engineer.md' },
    { name: 'codex', generate: generateCodexArtifacts, path: '.codex/agents/engineer.toml' },
    { name: 'claude-code', generate: generateClaudeCodeArtifacts, path: '.claude/agents/engineer.md' },
    { name: 'copilot', generate: generateCopilotArtifacts, path: '.github/agents/engineer.agent.md' },
    { name: 'cursor', generate: generateCursorArtifacts, path: '.cursor/agents/engineer.md' },
  ];

  let fx;
  const surfaces = new Map();
  before(() => {
    fx = mkdtempSync(join(tmpDir, 'fx-'));
    seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    cfg.adapters.copilot.roleSettings = {
      orchestrator: { model: 'gpt-5.4' }, maintainer: { model: 'gpt-5.5' }, engineer: { model: 'gpt-5.4-mini' },
    };
    for (const host of HOSTS) {
      const out = mkdtempSync(join(tmpDir, `out-${host.name}-`));
      host.generate(cfg, fx, out);
      surfaces.set(host.name, readFileSync(join(out, host.path), 'utf8'));
    }
  });

  for (const host of HOSTS) {
    it(`${host.name} engineer offers standalone mode with no task-record requirement`, () => {
      const text = surfaces.get(host.name);
      assert.match(text, /standalone/i, `${host.name} missing standalone mode`);
      assert.match(text, /no task ID or task record|requires no task ID/i, `${host.name} missing no-task-id wording`);
      assert.match(text, /explicitly activates Agentic Loop|explicitly asks|explicit activation/i, `${host.name} missing explicit-activation selection`);
    });

    it(`${host.name} engineer cannot perform final maintainer acceptance and drops old scoped-only wording`, () => {
      const text = surfaces.get(host.name);
      assert.match(text, /final maintainer (acceptance|review)/i);
      assert.ok(!text.includes('implement only the scoped task-record work'),
        `${host.name} still carries old scoped-only engineer wording`);
    });
  }

  it('Codex generated public skill body guards against discovery-driven activation', () => {
    const out = mkdtempSync(join(tmpDir, 'out-codex-skill-'));
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    generateCodexArtifacts(cfg, fx, out);
    const skill = readFileSync(join(out, '.agents', 'skills', 'agenticloop', 'SKILL.md'), 'utf8');
    assert.match(skill, /only when the user explicitly asks to activate Agentic Loop/i);
    assert.match(skill, /does not activate it/i);
  });
});
