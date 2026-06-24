/**
 * Cross-adapter invariant tests for the unified host-skill surface.
 *
 * The Codex, Claude Code, and Copilot adapters must expose exactly one public,
 * discoverable Agentic Loop skill (agenticloop/SKILL.md) and package every
 * canonical procedure as a non-discoverable reference.md copy. No host may
 * surface all internal Agentic Loop procedures as separate public skills.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-surface-test-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeFixture() {
  const d = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, d, { includeDocs: false, includeScratch: false });
  return d;
}

// Recursively collect files named `filename` under rootDir.
function collectNested(rootDir, filename, matches = []) {
  if (!existsSync(rootDir)) return matches;
  for (const entry of readdirSync(rootDir)) {
    const full = join(rootDir, entry);
    if (statSync(full).isDirectory()) collectNested(full, filename, matches);
    else if (entry === filename) matches.push(full.replace(/\\/g, '/'));
  }
  return matches;
}

// A "discoverable" host skill is a SKILL.md directly inside a skill directory
// under the skills root (skillsRoot/<name>/SKILL.md).
function discoverablePublicSkills(skillsRoot) {
  if (!existsSync(skillsRoot)) return [];
  const found = [];
  for (const entry of readdirSync(skillsRoot)) {
    const skillFile = join(skillsRoot, entry, 'SKILL.md');
    if (existsSync(skillFile)) found.push(entry);
  }
  return found.sort();
}

describe('unified host-skill surface', () => {
  it('Codex exposes exactly one public agenticloop/SKILL.md with reference-only procedures', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'codex-out-'));
    generateCodexArtifacts(cfg, fx, out);

    const skillsRoot = join(out, '.agents', 'skills');
    assert.deepEqual(discoverablePublicSkills(skillsRoot), ['agenticloop'],
      'Codex skill root must contain exactly one public agenticloop skill');

    const referencesRoot = join(skillsRoot, 'agenticloop', 'references', 'skills');
    assert.ok(existsSync(referencesRoot), 'expected internal references directory');
    assert.deepEqual(
      collectNested(referencesRoot, 'SKILL.md'), [],
      'internal procedures must be reference.md, never SKILL.md'
    );
    assert.ok(
      collectNested(referencesRoot, 'reference.md').length > 0,
      'expected internal reference.md procedure copies'
    );
  });

  it('Claude Code exposes exactly one public agenticloop/SKILL.md with reference-only procedures', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'claude-out-'));
    generateClaudeCodeArtifacts(cfg, fx, out);

    const skillsRoot = join(out, '.claude', 'skills');
    assert.deepEqual(discoverablePublicSkills(skillsRoot), ['agenticloop'],
      'Claude skill root must contain exactly one public agenticloop skill');

    const skillDir = join(skillsRoot, 'agenticloop');
    // The only SKILL.md anywhere under the public skill dir is the public one.
    assert.deepEqual(
      collectNested(skillDir, 'SKILL.md'),
      [join(skillDir, 'SKILL.md').replace(/\\/g, '/')],
      'the only discoverable SKILL.md must be the public one'
    );
    assert.ok(
      collectNested(join(skillDir, 'references', 'skills'), 'reference.md').length > 0,
      'expected internal reference.md procedure copies'
    );
  });

  it('Copilot exposes exactly one public agenticloop/SKILL.md with reference-only procedures', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'copilot-out-'));
    generateCopilotArtifacts(cfg, fx, out);

    const skillsRoot = join(out, '.github', 'skills');
    assert.deepEqual(discoverablePublicSkills(skillsRoot), ['agenticloop'],
      'Copilot skill root must contain exactly one public agenticloop skill');

    const skillDir = join(skillsRoot, 'agenticloop');
    assert.deepEqual(
      collectNested(skillDir, 'SKILL.md'),
      [join(skillDir, 'SKILL.md').replace(/\\/g, '/')],
      'the only discoverable SKILL.md must be the public Copilot skill'
    );
    assert.ok(
      collectNested(join(skillDir, 'references', 'skills'), 'reference.md').length > 0,
      'expected Copilot internal reference.md procedure copies'
    );
  });

  it('Cursor exposes exactly one public agenticloop/SKILL.md with reference-only procedures', () => {
    const fx = makeFixture();
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const out = mkdtempSync(join(tmpDir, 'cursor-out-'));
    generateCursorArtifacts(cfg, fx, out);

    const skillsRoot = join(out, '.cursor', 'skills');
    assert.deepEqual(discoverablePublicSkills(skillsRoot), ['agenticloop'],
      'Cursor skill root must contain exactly one public agenticloop skill');

    const skillDir = join(skillsRoot, 'agenticloop');
    assert.deepEqual(
      collectNested(skillDir, 'SKILL.md'),
      [join(skillDir, 'SKILL.md').replace(/\\/g, '/')],
      'the only discoverable SKILL.md must be the public Cursor skill'
    );
    assert.ok(
      collectNested(join(skillDir, 'references', 'skills'), 'reference.md').length > 0,
      'expected Cursor internal reference.md procedure copies'
    );
  });
});
