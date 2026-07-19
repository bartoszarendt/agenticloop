/**
 * Tests for src/adapters/shared.js.
 *
 * Covers:
 *   - collectInstructionPaths dedupes and respects role/agent/backend layout
 *   - resolveRoleModel applies adapter-local roleSettings first
 *   - resolveRoleModel falls back to legacy roles.<role>.model / reasoningEffort
 *   - buildRoleRecord reads role source files and returns description/prompt body
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  collectInstructionPaths,
  resolveRoleModel,
  buildRoleRecord,
} from '../src/adapters/shared.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function minimalConfig(overrides = {}) {
  return {
    agents: { sourceDirectory: 'agenticloop/agents' },
    skills: { sourceDirectory: 'agenticloop/skills' },
    backends: {
      sourceDirectory: 'agenticloop/backends',
      github: { projection: 'agenticloop/backends/github.md' },
      files: { projection: 'agenticloop/backends/files.md' },
    },
    documents: {
      rules: 'AGENTS.md',
      plan: 'IMPLEMENTATION_PLAN.md',
      overview: 'README.md',
      process: 'agenticloop/AGENTIC_LOOP.md',
    },
    roles: {
      orchestrator: { sourceFile: 'agenticloop/agents/orchestrator.md', requiredSkills: ['role-delegation'] },
      maintainer:   { sourceFile: 'agenticloop/agents/maintainer.md' },
      engineer:     { sourceFile: 'agenticloop/agents/engineer.md' },
    },
    ...overrides,
  };
}

describe('collectInstructionPaths', () => {
  // Seed a self-contained installed layout so the test does not depend on the
  // toolkit's local-only internal planning docs.
  function seededRoot() {
    const root = mkdtempSync(join(tmpdir(), 'al-shared-test-'));
    seedTargetLayout(REPO_ROOT, root);
    return root;
  }

  it('returns canonical documents, agents, backend references, and role-delegation skill', () => {
    const root = seededRoot();
    try {
      const cfg = minimalConfig();
      const paths = collectInstructionPaths(cfg, root);
      for (const required of [
        'AGENTS.md',
        'IMPLEMENTATION_PLAN.md',
        'README.md',
        'agenticloop/AGENTIC_LOOP.md',
        'agenticloop/agents/orchestrator.md',
        'agenticloop/agents/maintainer.md',
        'agenticloop/agents/engineer.md',
        'agenticloop/backends/README.md',
        'agenticloop/backends/files.md',
        'agenticloop/backends/github.md',
        'agenticloop/skills/role-delegation/SKILL.md',
      ]) {
        assert.ok(paths.includes(required), `expected ${required} in ${JSON.stringify(paths)}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated entries', () => {
    const root = seededRoot();
    try {
      const cfg = minimalConfig();
      const paths = collectInstructionPaths(cfg, root);
      const seen = new Set();
      for (const p of paths) {
        assert.ok(!seen.has(p), `path ${p} should appear only once`);
        seen.add(p);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses .agenticloop/project.md document selections when present', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'al-shared-test-'));
    try {
      mkdirSync(join(tmpRoot, '.agenticloop'), { recursive: true });
      mkdirSync(join(tmpRoot, 'agenticloop', 'agents'), { recursive: true });
      mkdirSync(join(tmpRoot, 'agenticloop', 'backends'), { recursive: true });
      mkdirSync(join(tmpRoot, 'agenticloop', 'skills', 'role-delegation'), { recursive: true });
      writeFileSync(join(tmpRoot, 'agenticloop', 'AGENTIC_LOOP.md'), '# Process\n');
      writeFileSync(join(tmpRoot, 'AGENTS.md'), '# Rules\n');
      writeFileSync(join(tmpRoot, 'README.md'), '# Overview\n');
      writeFileSync(join(tmpRoot, 'ROADMAP.md'), '# Plan\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'agents', 'orchestrator.md'), '---\nname: orchestrator\n---\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'agents', 'maintainer.md'), '---\nname: maintainer\n---\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'agents', 'engineer.md'), '---\nname: engineer\n---\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'backends', 'README.md'), '# Backends\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'backends', 'github.md'), '# GitHub\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'backends', 'files.md'), '# Files\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'skills', 'role-delegation', 'SKILL.md'), '---\nname: role-delegation\ndescription: Use when delegating\nmetadata:\n  area: orchestration\n  side_effects: none\n  credentials: none\n  runs_scripts: none\n---\nrole delegation body\n');
      writeFileSync(join(tmpRoot, '.agenticloop', 'project.md'), [
        '---',
        'setup_status: unconfirmed',
        'setup_confirmed_at: ""',
        'setup_confirmed_by: ""',
        'documents:',
        '  plan: "ROADMAP.md"',
        '---',
        '# Project Map',
      ].join('\n'));

      const cfg = minimalConfig();
      const paths = collectInstructionPaths(cfg, tmpRoot);
      assert.ok(paths.includes('ROADMAP.md'), `expected ROADMAP.md in ${JSON.stringify(paths)}`);
      assert.ok(!paths.includes('IMPLEMENTATION_PLAN.md'), `did not expect IMPLEMENTATION_PLAN.md in ${JSON.stringify(paths)}`);
      assert.ok(paths.includes('agenticloop/backends/files.md'), `expected agenticloop/backends/files.md in ${JSON.stringify(paths)}`);
      assert.ok(!paths.includes('agenticloop/backends/github.md'), `did not expect agenticloop/backends/github.md in ${JSON.stringify(paths)}`);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('includes both backend projections when no project map exists', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'al-shared-test-no-map-'));
    try {
      mkdirSync(join(tmpRoot, 'agenticloop', 'agents'), { recursive: true });
      mkdirSync(join(tmpRoot, 'agenticloop', 'backends'), { recursive: true });
      mkdirSync(join(tmpRoot, 'agenticloop', 'skills', 'role-delegation'), { recursive: true });
      writeFileSync(join(tmpRoot, 'agenticloop', 'AGENTIC_LOOP.md'), '# Process\n');
      writeFileSync(join(tmpRoot, 'AGENTS.md'), '# Rules\n');
      writeFileSync(join(tmpRoot, 'README.md'), '# Overview\n');
      writeFileSync(join(tmpRoot, 'IMPLEMENTATION_PLAN.md'), '# Plan\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'agents', 'orchestrator.md'), '---\nname: orchestrator\n---\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'agents', 'maintainer.md'), '---\nname: maintainer\n---\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'agents', 'engineer.md'), '---\nname: engineer\n---\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'backends', 'README.md'), '# Backends\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'backends', 'github.md'), '# GitHub\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'backends', 'files.md'), '# Files\n');
      writeFileSync(join(tmpRoot, 'agenticloop', 'skills', 'role-delegation', 'SKILL.md'), '---\nname: role-delegation\ndescription: Use when delegating\nmetadata:\n  area: orchestration\n  side_effects: none\n  credentials: none\n  runs_scripts: none\n---\nrole delegation body\n');

      const cfg = minimalConfig();
      const paths = collectInstructionPaths(cfg, tmpRoot);
      assert.ok(paths.includes('agenticloop/backends/files.md'), `expected agenticloop/backends/files.md in ${JSON.stringify(paths)}`);
      assert.ok(paths.includes('agenticloop/backends/github.md'), `expected agenticloop/backends/github.md in ${JSON.stringify(paths)}`);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveRoleModel', () => {
  it('uses adapters.<host>.roleSettings first', () => {
    const cfg = minimalConfig({
      roles: {
        orchestrator: { sourceFile: 'agenticloop/agents/orchestrator.md', model: 'roles/model', reasoningEffort: 'low' },
      },
    });
    const adapterCfg = {
      roleSettings: { orchestrator: { model: 'adapters/model', reasoningEffort: 'high' } },
    };
    const { model, variant, source } = resolveRoleModel(cfg, 'opencode', 'orchestrator', adapterCfg);
    assert.equal(model, 'adapters/model');
    assert.equal(variant, 'high');
    assert.equal(source, 'adapters.opencode.roleSettings.orchestrator');
  });

  it('falls back to roles.<role>.model when adapter roleSettings absent', () => {
    const cfg = minimalConfig({
      roles: { orchestrator: { sourceFile: 'agenticloop/agents/orchestrator.md', model: 'roles/model', reasoningEffort: 'low' } },
    });
    const { model, variant, source } = resolveRoleModel(cfg, 'opencode', 'orchestrator', {});
    assert.equal(model, 'roles/model');
    assert.equal(variant, 'low');
    assert.equal(source, 'roles.orchestrator');
  });

  it('returns empty model and default variant when no source provides one', () => {
    const cfg = minimalConfig({
      roles: { orchestrator: { sourceFile: 'agenticloop/agents/orchestrator.md' } },
    });
    const { model, variant } = resolveRoleModel(cfg, 'opencode', 'orchestrator', {});
    assert.equal(model, '');
    assert.equal(variant, 'auto');
  });
});

describe('buildRoleRecord', () => {
  it('reads the role source file body and frontmatter description', () => {
    const cfg = minimalConfig();
    const { description, promptBody, sourceFile, requiredSkills } =
      buildRoleRecord(cfg, REPO_ROOT, 'orchestrator');
    assert.equal(sourceFile, 'agenticloop/agents/orchestrator.md');
    assert.ok(typeof description === 'string' && description.length > 0,
      'description should be non-empty');
    assert.ok(typeof promptBody === 'string' && promptBody.length > 0,
      'promptBody should be non-empty');
    assert.ok(Array.isArray(requiredSkills));
    assert.ok(requiredSkills.includes('role-delegation'));
  });
});
