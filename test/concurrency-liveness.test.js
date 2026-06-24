/**
 * Tests for the Phase U concurrency + subagent-liveness guardrails.
 *
 * Covers:
 *   - generated adapter role surfaces carry the serial-default / concurrency-plan
 *     / lease wording (orchestrator) and the lease + status-return obligation
 *     (maintainer, engineer) for every implemented host;
 *   - the engineer surface guards branch/worktree before continuing;
 *   - the GitHub merge-barrier wording stays consistent across the three
 *     canonical docs that repeat it;
 *   - the durable `## Concurrency Plan` task-record section stays registered;
 *   - the migrated lease terminology does not regress to "progress interval".
 *
 * This is the mechanical guard tracked as Phase U / U-07: the concurrency and
 * liveness contract lives in several places at once, so a snapshot-style check
 * keeps them from silently drifting apart.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { TASK_OPTIONAL_SECTION_HEADINGS } from '../src/layout.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Each host generates a role surface for the three logical roles. The path
// shapes match the per-adapter tests, which already pin these as the contract.
const HOSTS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, agentPath: role => `.opencode/agents/${role}.md` },
  { name: 'codex', generate: generateCodexArtifacts, agentPath: role => `.codex/agents/${role}.toml` },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, agentPath: role => `.claude/agents/${role}.md` },
  { name: 'copilot', generate: generateCopilotArtifacts, agentPath: role => `.github/agents/${role}.agent.md` },
  { name: 'cursor', generate: generateCursorArtifacts, agentPath: role => `.cursor/agents/${role}.md` },
];

const ROLES = ['orchestrator', 'maintainer', 'engineer'];

let tmpDir;
// key: `${host}:${role}` -> generated surface text
const surfaces = new Map();

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-concurrency-'));
  const fx = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });

  const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
  // The shared fixture config only seeds role settings for some hosts; Copilot
  // needs explicit models like its own adapter test supplies.
  cfg.adapters.copilot.roleSettings = {
    orchestrator: { model: 'gpt-5.4' },
    maintainer: { model: 'gpt-5.5' },
    engineer: { model: 'gpt-5.4-mini' },
  };

  for (const host of HOSTS) {
    const out = mkdtempSync(join(tmpDir, `out-${host.name}-`));
    const { files } = host.generate(cfg, fx, out);
    for (const role of ROLES) {
      const rel = host.agentPath(role);
      assert.ok(files.includes(rel), `${host.name} did not generate ${rel}`);
      surfaces.set(`${host.name}:${role}`, readFileSync(join(out, rel), 'utf-8'));
    }
  }
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('generated orchestrator surfaces default to serial with a concurrency plan and lease', () => {
  for (const host of HOSTS) {
    it(`${host.name} orchestrator states serial default, concurrency plan, and lease`, () => {
      const text = surfaces.get(`${host.name}:orchestrator`);
      assert.match(text, /serial(ly)? by default/i, `${host.name} orchestrator missing serial-default wording`);
      assert.match(text, /concurrency plan/i, `${host.name} orchestrator missing concurrency-plan wording`);
      assert.match(text, /lease/i, `${host.name} orchestrator missing lease wording`);
    });
  }
});

describe('generated worker surfaces honor leases and return status', () => {
  for (const host of HOSTS) {
    for (const role of ['maintainer', 'engineer']) {
      it(`${host.name} ${role} honors the lease and returns status`, () => {
        const text = surfaces.get(`${host.name}:${role}`);
        assert.match(text, /lease/i, `${host.name} ${role} missing lease obligation`);
        assert.match(text, /status/i, `${host.name} ${role} missing status-return obligation`);
        assert.match(text, /no-progress|stop condition/i, `${host.name} ${role} missing stop/no-progress wording`);
      });
    }
  }
});

describe('generated engineer surfaces guard branch/worktree before continuing', () => {
  for (const host of HOSTS) {
    it(`${host.name} engineer returns on a wrong branch or worktree`, () => {
      const text = surfaces.get(`${host.name}:engineer`);
      assert.match(text, /branch|worktree/i, `${host.name} engineer missing branch/worktree guard`);
    });
  }
});

describe('GitHub merge-barrier wording is consistent across canonical docs', () => {
  const DOCS = [
    'AGENTIC_LOOP.md',
    'skills/role-delegation/SKILL.md',
    'backends/github.md',
  ];
  // Invariants every merge-barrier statement must keep, regardless of phrasing.
  const REQUIRED = [
    /every (parallel )?lane has returned/i,
    /maintainer review is complete/i,
    /cross-branch/i,
    /approves (the )?merge order/i,
  ];

  for (const doc of DOCS) {
    it(`${doc} states every merge-barrier invariant`, () => {
      // Collapse whitespace so hard-wrapped prose still matches single-line patterns.
      const text = readFileSync(join(REPO_ROOT, doc), 'utf-8').replace(/\s+/g, ' ');
      for (const pattern of REQUIRED) {
        assert.match(text, pattern, `${doc} missing merge-barrier invariant ${pattern}`);
      }
    });
  }
});

describe('durable concurrency-plan section stays registered', () => {
  it('layout registers "## Concurrency Plan" as an optional task section', () => {
    assert.ok(
      TASK_OPTIONAL_SECTION_HEADINGS.includes('## Concurrency Plan'),
      'TASK_OPTIONAL_SECTION_HEADINGS must include "## Concurrency Plan"'
    );
  });

  it('the canonical task-record template contains the Concurrency Plan section', () => {
    const text = readFileSync(join(REPO_ROOT, 'memory', 'task-record.md'), 'utf-8');
    assert.match(text, /## Concurrency Plan/);
  });

  it('the task-record-contract skill documents the Concurrency Plan section', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'task-record-contract', 'SKILL.md'), 'utf-8');
    assert.match(text, /Concurrency Plan/);
  });
});

describe('lease terminology does not regress', () => {
  it('AGENTIC_LOOP.md uses "progress checkpoint cadence", not "progress interval"', () => {
    const text = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf-8');
    assert.match(text, /progress checkpoint cadence/i);
    assert.doesNotMatch(text, /progress interval/i);
  });
});
