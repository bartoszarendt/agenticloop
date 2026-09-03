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
import { hashContent } from '../src/generated-artifacts.js';
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
    let r = run(['setup', '--target', dir], { input: 'yes\n\n\ny\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(hasBlock(dir));
    run(['guidance', 'remove', '--target', dir]);
    r = run(['setup', '--target', dir], { input: 'no\n\n\ny\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hasBlock(dir), false);
  });

  it('fresh setup honors --no-agents-guidance', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n');
    const r = run(['setup', '--target', dir, '--no-agents-guidance'], { input: 'yes\n\n\ny\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(hasBlock(dir), false);
  });

  it('setup applies fresh guidance to configured RULES.md', () => {
    const dir = target();
    writeFileSync(join(dir, 'RULES.md'), '# Rules\n');
    configuredRules(dir);
    const r = run(['setup', '--target', dir], { input: 'yes\n\n\ny\n' });
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

describe('canonical guidance content changes', () => {
  const OLDER_BLOCK = [
    GUIDANCE_MARKER,
    '## Agentic Loop',
    '',
    'An older owned guidance revision.',
    '<!-- AGENTICLOOP_END -->',
  ].join('\n');

  const PROTECTED = '# Project Rules\n\nProtected user content.\n';
  const manifestPath = dir => join(dir, '.agenticloop', 'generated-artifacts.json');

  /** Rewrite the owned block on disk and, optionally, its recorded hash. */
  function rewriteOwnedBlock(dir, replacement, { syncManifest }) {
    const rulesPath = join(dir, 'AGENTS.md');
    const content = readFileSync(rulesPath, 'utf8');
    const start = content.indexOf(GUIDANCE_MARKER);
    const end = content.indexOf('<!-- AGENTICLOOP_END -->') + '<!-- AGENTICLOOP_END -->'.length;
    writeFileSync(rulesPath, content.slice(0, start) + replacement + content.slice(end));
    if (!syncManifest) return;
    const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8'));
    for (const entry of manifest.entries) {
      if (entry.kind === 'marker-block') entry.hash = hashContent(replacement);
    }
    writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));
  }

  it('an unchanged owned older block reports stale and refreshes in place', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), PROTECTED);
    run(['guidance', 'apply', '--target', dir]);
    assert.ok(hasBlock(dir));

    // Simulate a block installed by an older package version: unchanged by the
    // user (manifest hash matches disk) but no longer the canonical content.
    rewriteOwnedBlock(dir, OLDER_BLOCK, { syncManifest: true });
    let r = run(['guidance', 'check', '--target', dir]);
    assert.match(r.stdout, /owned, unchanged, and refreshable/);

    r = run(['guidance', 'apply', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /refreshed/);
    const body = agents(dir);
    assert.ok(body.startsWith(PROTECTED), 'target-owned content must stay byte-for-byte');
    assert.ok(!body.includes('An older owned guidance revision.'));
    assert.match(body, /generated Maintainer, Engineer, or Auditor as normal bounded subagents/);
    assert.match(body, /Standalone Maintainer planning and review requires no task ID or task record/i);
    assert.equal(body.split(GUIDANCE_MARKER).length - 1, 1, 'refresh must not duplicate the block');

    r = run(['guidance', 'check', '--target', dir]);
    assert.match(r.stdout, /current and owned/);
  });

  it('update refreshes an owned older block without touching unrelated rules', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), PROTECTED);
    run(['init', '--target', dir, '--adapter', 'claude-code']);
    rewriteOwnedBlock(dir, OLDER_BLOCK, { syncManifest: true });

    const r = run(['update', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    const body = agents(dir);
    assert.ok(body.startsWith(PROTECTED));
    assert.ok(!body.includes('An older owned guidance revision.'));
    assert.match(body, /standalone auditor delegation is read-only and non-certifying/i);
  });

  it('a user-modified owned block stays preserved when the canonical content changes', () => {
    const dir = target();
    writeFileSync(join(dir, 'AGENTS.md'), PROTECTED);
    run(['guidance', 'apply', '--target', dir]);

    // User edit: disk no longer matches the recorded hash.
    const edited = [GUIDANCE_MARKER, '## Agentic Loop', '', 'Hand-tuned by the target project.', '<!-- AGENTICLOOP_END -->'].join('\n');
    rewriteOwnedBlock(dir, edited, { syncManifest: false });

    let r = run(['guidance', 'check', '--target', dir]);
    assert.match(r.stdout, /modified since generation/);

    r = run(['guidance', 'apply', '--target', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(`${r.stdout}\n${r.stderr}`, /was modified and was not refreshed/i);
    const body = agents(dir);
    assert.ok(body.includes('Hand-tuned by the target project.'), 'user content must be preserved');
    assert.ok(body.startsWith(PROTECTED));
  });
});

describe('activation semantics content guards', () => {
  it('AGENTIC_LOOP.md carries a discovery-is-not-activation guard', () => {
    const text = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf8');
    assert.match(text, /## Activation Boundary/);
    assert.match(text, /Discovering the\s+installed toolkit or reading this document does not activate/);
    assert.match(text, /Standalone maintainer, engineer, and auditor delegation is not activation/i);
    assert.match(text, /mentioning a task ID without operational intent/i);
    // Formal work-unit certification is an activating operation; standalone
    // auditor delegation is not, and cannot substitute for it.
    assert.match(text.replace(/\s+/g, ' '), /audit, certify, or re-audit a\s*tracked Agentic Loop work unit/i);
    assert.match(text, /\*\*Standalone auditor\*\*/);
    assert.match(text.replace(/\s+/g, ' '), /standalone auditor assessment certifies nothing/i);
  });

  it('canonical maintainer role documents both modes and defaults to standalone', () => {
    const raw = readFileSync(join(REPO_ROOT, 'agents', 'maintainer.md'), 'utf8');
    const text = raw.replace(/\s+/g, ' ');
    assert.match(raw, /## Mode Selection/);
    assert.match(raw, /## Standalone Mode/);
    assert.match(raw, /## Agentic Loop Mode/);
    assert.match(text, /\*\*Standalone mode\*\* \(default\)/);
    assert.match(text, /Otherwise operate as a \*\*standalone Maintainer\*\*/i);
    assert.match(text, /Use \*\*Agentic Loop mode\*\* only when the delegation \*\*explicitly activates Agentic Loop\*\* or \*\*explicitly designates a durable Agentic Loop task record or another appropriate durable Agentic Loop lifecycle artifact/i);
    assert.match(text, /bare task ID, work-unit name, pull request, commit SHA, or contextual reference does not force Agentic Loop mode/i);
    assert.match(text, /Absent Agentic Loop metadata selects standalone mode/i);
    assert.match(text, /must never block ordinary standalone Maintainer work/i);
    assert.match(text, /Do not create or modify `\.agenticloop` workflow state/i);
    assert.match(text, /Do not formally accept, reject, supersede, or close an Agentic Loop task/i);
    assert.match(text, /carries no formal Agentic Loop acceptance or closeout authority/i);
    assert.match(text, /Do not implement code changes/i);
    assert.match(text, /Maintainer Review Fixup is available only in Agentic Loop mode/i);
    assert.match(text, /Do not use the Maintainer Review Fixup; it is an Agentic Loop review procedure/i);
    assert.match(text, /never silently downgrade to standalone mode/i);
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

  it('canonical auditor role documents both modes and defaults to standalone', () => {
    const raw = readFileSync(join(REPO_ROOT, 'agents', 'auditor.md'), 'utf8');
    const text = raw.replace(/\s+/g, ' ');
    assert.match(raw, /## Mode Selection/);
    assert.match(raw, /## Standalone Mode/);
    assert.match(raw, /## Agentic Loop Mode/);
    // Standalone is the default; Agentic Loop mode needs explicit intent.
    assert.match(text, /\*\*Standalone mode\*\* \(default\)/);
    assert.match(text, /Otherwise operate as a standalone auditor/i);
    assert.match(text, /Use \*\*Agentic Loop mode\*\* only when the delegation \*\*explicitly activates/i);
    // Bare identifiers must not force Agentic Loop mode.
    assert.match(text, /bare task ID, audit ID, work-unit name, commit SHA, or other identifier does not force Agentic Loop mode/i);
    // Missing packet metadata is not a standalone blocker.
    assert.match(text, /When neither explicit Agentic Loop activation nor formal certification intent is present, missing Agentic Loop metadata .* must never cause the auditor to stop, fail, or return an Agentic Loop verdict/i);
    assert.match(text, /Missing packet metadata is never a blocker here/i);
    // Standalone creates no Agentic Loop state.
    assert.match(text, /no Agentic Loop workflow state is created|creates no Agentic Loop state/i);
    // Standalone output is unmistakably non-certifying.
    assert.match(text, /standalone, non-certifying assessment/i);
    assert.match(text, /it certifies nothing and cannot satisfy Agentic Loop work-unit auditing, certification, or closeout/i);
    assert.match(text, /Do not return `auditor_report_v1`, an Agentic Loop `verdict` field/i);
    // Formal certification intent is never silently downgraded.
    assert.match(text, /Once explicit Agentic Loop activation or formal certification intent selects Agentic Loop mode, stay in that mode/i);
    assert.match(text, /Never silently downgrade an activated or formal certification request to standalone mode/i);
    // Formal certification keeps its fresh packet-bound invocation.
    assert.match(text, /formal certification requires a fresh, packet-bound Agentic Loop Auditor invocation/i);
    assert.match(text, /work-unit certification always requires a fresh, packet-bound Auditor invocation/i);
    assert.match(text, /Every re-audit is a new invocation with a new invocation reference/i);
  });
});

describe('generated dual-mode role surfaces across adapters', () => {
  const HOSTS = [
    { name: 'opencode', generate: generateOpencodeArtifacts, path: '.opencode/agents/engineer.md', maintainerPath: '.opencode/agents/maintainer.md', auditorPath: '.opencode/agents/auditor.md' },
    { name: 'codex', generate: generateCodexArtifacts, path: '.codex/agents/engineer.toml', maintainerPath: '.codex/agents/maintainer.toml', auditorPath: '.codex/agents/auditor.toml' },
    { name: 'claude-code', generate: generateClaudeCodeArtifacts, path: '.claude/agents/engineer.md', maintainerPath: '.claude/agents/maintainer.md', auditorPath: '.claude/agents/auditor.md' },
    { name: 'copilot', generate: generateCopilotArtifacts, path: '.github/agents/engineer.agent.md', maintainerPath: '.github/agents/maintainer.agent.md', auditorPath: '.github/agents/auditor.agent.md' },
    { name: 'cursor', generate: generateCursorArtifacts, path: '.cursor/agents/engineer.md', maintainerPath: '.cursor/agents/maintainer.md', auditorPath: '.cursor/agents/auditor.md' },
  ];

  let fx;
  const surfaces = new Map();
  const maintainerSurfaces = new Map();
  const auditorSurfaces = new Map();
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
      // Codex quotes the role body into a TOML scalar and OpenCode into a YAML
      // scalar, so decode host escaping and collapse wrapping before matching
      // canonical sentences.
      const auditor = readFileSync(join(out, host.auditorPath), 'utf8')
        .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\s+/g, ' ');
      const maintainer = readFileSync(join(out, host.maintainerPath), 'utf8')
        .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\s+/g, ' ');
      maintainerSurfaces.set(host.name, maintainer);
      auditorSurfaces.set(host.name, auditor);
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

    it(`${host.name} maintainer defaults to bounded standalone advisory work`, () => {
      const text = maintainerSurfaces.get(host.name);
      assert.match(text, /otherwise operate as a (?:\*\*)?standalone Maintainer|\*\*Standalone mode\*\* \(default\)/i,
        `${host.name} missing standalone Maintainer default`);
      assert.match(text, /explicitly activates Agentic Loop/i,
        `${host.name} missing explicit-activation selection`);
      assert.match(text, /requires no task ID or task record|Require no task ID, task record/i,
        `${host.name} missing no-task-metadata rule`);
      assert.match(text, /creates no Agentic Loop workflow state|Do not create or modify `\.agenticloop` workflow state/i,
        `${host.name} standalone Maintainer must create no Agentic Loop state`);
      assert.match(text, /advisory.{0,100}(?:cannot perform|rather than) formal Agentic Loop acceptance or closeout|carries no formal Agentic Loop acceptance or closeout authority/i,
        `${host.name} standalone Maintainer must remain advisory`);
      assert.match(text, /Do not implement code changes/i,
        `${host.name} missing the no-implementation boundary`);
    });

    it(`${host.name} auditor defaults to a standalone non-certifying assessment`, () => {
      const text = auditorSurfaces.get(host.name);
      assert.match(text, /otherwise operate as a standalone auditor/i, `${host.name} missing standalone auditor default`);
      assert.match(text, /explicitly activates Agentic Loop/i, `${host.name} missing explicit-activation selection`);
      assert.match(text, /bare task ID, audit ID, work-unit name,? (or )?commit SHA/i,
        `${host.name} missing the bare-identifier carve-out`);
      assert.match(text, /requires no audit packet or audit record|no .{0,40}audit packet, audit record/i,
        `${host.name} missing the no-packet standalone rule`);
      assert.match(text, /non-certifying/i, `${host.name} missing the non-certifying contract`);
      assert.match(text, /missing packet metadata is not a blocker|Missing packet metadata is never a blocker/i,
        `${host.name} must not treat missing packet metadata as a standalone blocker`);
      assert.match(text, /creates no Agentic Loop workflow state|creates no Agentic Loop state/i,
        `${host.name} standalone auditor must create no Agentic Loop state`);
    });

    it(`${host.name} auditor keeps formal certification packet-bound and read-only`, () => {
      const text = auditorSurfaces.get(host.name);
      assert.match(text, /formal certification requires a fresh packet-bound Agentic Loop Auditor invocation|fresh, packet-bound Agentic Loop Auditor invocation/i,
        `${host.name} missing the fresh packet-bound certification requirement`);
      assert.match(text, /rather than downgrading to standalone|Never silently downgrade (?:an activated or formal|a formal) certification request/i,
        `${host.name} must not allow a silent downgrade of formal certification intent`);
      assert.match(text, /read-only/i, `${host.name} missing the read-only boundary`);
      assert.match(text, /implement no remediation|Do not implement remediation|implement remediation for its own findings/i,
        `${host.name} missing the no-remediation boundary`);
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
