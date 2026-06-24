/**
 * Tests for src/project-detection.js.
 *
 * Covers:
 *   - detectDocumentCandidates with conventional and non-conventional docs
 *   - inferGroupingProfile defaults and overrides
 *   - inferTaskIdConventions defaults and existing patterns
 *   - detectBackendEvidence defaults and existing project map
 *   - detectProjectState full integration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import {
  detectDocumentCandidates,
  inferGroupingProfile,
  inferTaskIdConventions,
  detectBackendEvidence,
  detectProjectState,
} from '../src/project-detection.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-proj-detect-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTarget(options = {}) {
  const d = mkdtempSync(join(tmpDir, 'target-'));
  seedTargetLayout(REPO_ROOT, d, options);
  return d;
}

function writeProjectMap(target, frontmatter) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(frontmatter)) {
    if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push('---');
  lines.push('# Agentic Loop Project Map');
  mkdirSync(join(target, '.agenticloop'), { recursive: true });
  writeFileSync(join(target, '.agenticloop', 'project.md'), lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// detectDocumentCandidates
// ---------------------------------------------------------------------------

describe('detectDocumentCandidates', () => {
  it('detects conventional docs', () => {
    const d = makeTarget();
    const docs = detectDocumentCandidates(d);

    assert.ok(docs.rules);
    assert.equal(docs.rules.detected, 'AGENTS.md');
    assert.equal(docs.rules.isConventional, true);
    assert.equal(docs.rules.needsSelection, false);
  });

  it('detects non-conventional doc with needsSelection', () => {
    const d = makeTarget();
    writeFileSync(join(d, 'ROADMAP.md'), '# Roadmap\n');

    const docs = detectDocumentCandidates(d);

    assert.equal(docs.plan.detected, 'IMPLEMENTATION_PLAN.md');
    assert.equal(docs.plan.isConventional, true);
  });

  it('returns null for missing docs', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const docs = detectDocumentCandidates(d);

    assert.equal(docs.rules.detected, null);
    assert.equal(docs.rules.isConventional, null);
  });
});

// ---------------------------------------------------------------------------
// inferGroupingProfile
// ---------------------------------------------------------------------------

describe('inferGroupingProfile', () => {
  it('defaults to flat', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = inferGroupingProfile(d);
    assert.equal(result.groupingProfile, 'flat');
  });

  it('uses existing config when present', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = inferGroupingProfile(d, { grouping_profile: 'phase' });
    assert.equal(result.groupingProfile, 'phase');
    assert.equal(result.evidence, 'existing project map');
  });

  it('detects phase headings in IMPLEMENTATION_PLAN.md', () => {
    const d = mkdtempSync(join(tmpDir, 'phase-'));
    writeFileSync(join(d, 'IMPLEMENTATION_PLAN.md'),
      '# Plan\n\n## Phase A - Setup\n\nTasks here.\n\n## Phase B - Build\n');

    const result = inferGroupingProfile(d);
    assert.equal(result.groupingProfile, 'phase');
    assert.ok(result.evidence.includes('phase headings'));
  });

  it('detects third-level phase headings in PLAN.md', () => {
    const d = mkdtempSync(join(tmpDir, 'phase-plan-'));
    writeFileSync(join(d, 'PLAN.md'),
      '# Plan\n\n### Phase 9 - Assist image grounding\n\nWork items.\n');

    const result = inferGroupingProfile(d);
    assert.equal(result.groupingProfile, 'phase');
    assert.ok(result.evidence.includes('PLAN.md'));
  });

  it('uses selected plan document when inferring grouping', () => {
    const d = mkdtempSync(join(tmpDir, 'selected-plan-'));
    writeFileSync(join(d, 'CUSTOM_PLAN.md'),
      '# Plan\n\n### Epic Search\n\nWork items.\n');

    const result = inferGroupingProfile(d, {
      documents: {
        plan: 'CUSTOM_PLAN.md',
      },
    });
    assert.equal(result.groupingProfile, 'epic');
    assert.ok(result.evidence.includes('CUSTOM_PLAN.md'));
  });

  it('detects milestone headings in ROADMAP.md', () => {
    const d = mkdtempSync(join(tmpDir, 'ms-'));
    writeFileSync(join(d, 'ROADMAP.md'),
      '# Roadmap\n\n## Milestone 1 - Alpha\n\nWork items.\n');

    const result = inferGroupingProfile(d);
    assert.equal(result.groupingProfile, 'milestone');
    assert.ok(result.evidence.includes('milestone headings'));
  });

  it('detects phase-prefixed task files', () => {
    const d = mkdtempSync(join(tmpDir, 'phase-tasks-'));
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'P1-01.md'), '---\nstatus: open\n---\n');

    const result = inferGroupingProfile(d);
    assert.equal(result.groupingProfile, 'phase');
    assert.ok(result.evidence.includes('phase-prefixed'));
  });
});

// ---------------------------------------------------------------------------
// inferTaskIdConventions
// ---------------------------------------------------------------------------

describe('inferTaskIdConventions', () => {
  it('defaults to T-<number>', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = inferTaskIdConventions(d);
    assert.equal(result.taskIdPattern, 'T-<number>');
    assert.equal(result.evidence, 'default');
  });

  it('uses existing config', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = inferTaskIdConventions(d, {
      task_id_pattern: 'P<phase>-<number>',
      task_id_regex: '^P\\d+-\\d{2,}$',
    });
    assert.equal(result.taskIdPattern, 'P<phase>-<number>');
    assert.equal(result.evidence, 'existing project map');
  });

  it('detects existing task files', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-001.md'), '---\nstatus: open\n---\n');

    const result = inferTaskIdConventions(d);
    assert.equal(result.taskIdPattern, 'T-<number>');
    assert.ok(result.evidence.includes('existing task files'));
  });
});

// ---------------------------------------------------------------------------
// detectBackendEvidence
// ---------------------------------------------------------------------------

describe('detectBackendEvidence', () => {
  it('defaults to files', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = detectBackendEvidence(d);
    assert.equal(result.backend, 'files');
  });

  it('uses existing config backend', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = detectBackendEvidence(d, { task_backend: 'github' });
    assert.equal(result.backend, 'github');
    assert.equal(result.confidence, 'high');
  });

  it('detects GitHub workflows as evidence', () => {
    const d = mkdtempSync(join(tmpDir, 'gh-'));
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), 'name: CI\n');

    const result = detectBackendEvidence(d);
    assert.ok(result.evidence.some(e => e.includes('.github/workflows/')),
      'should detect GitHub workflows');
  });

  it('detects GitHub issue templates as evidence', () => {
    const d = mkdtempSync(join(tmpDir, 'gh-'));
    mkdirSync(join(d, '.github', 'ISSUE_TEMPLATE'), { recursive: true });

    const result = detectBackendEvidence(d);
    assert.ok(result.evidence.some(e => e.includes('ISSUE_TEMPLATE')),
      'should detect issue templates');
  });

  it('proposes github backend when GitHub evidence is strong and no local tasks', () => {
    const d = mkdtempSync(join(tmpDir, 'gh-'));
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), 'name: CI\n');

    const result = detectBackendEvidence(d);
    assert.equal(result.backend, 'github');
    assert.equal(result.confidence, 'medium');
  });

  it('prefers files when local tasks exist even with GitHub evidence', () => {
    const d = mkdtempSync(join(tmpDir, 'gh-'));
    mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });

    const result = detectBackendEvidence(d);
    assert.equal(result.backend, 'files');
    assert.equal(result.confidence, 'high');
  });

  it('detects legacy taskBackend from agenticloop.json and uses it for proposal', () => {
    const d = mkdtempSync(join(tmpDir, 'legacy-'));
    writeFileSync(join(d, 'agenticloop.json'),
      JSON.stringify({ taskBackend: 'github' }));

    const result = detectBackendEvidence(d);
    assert.ok(result.evidence.some(e => e.includes('legacy')),
      'should detect legacy taskBackend');
    assert.equal(result.backend, 'github',
      'legacy taskBackend should be used for backend proposal');
    assert.equal(result.confidence, 'high');
  });
});

// ---------------------------------------------------------------------------
// detectProjectState
// ---------------------------------------------------------------------------

describe('detectProjectState', () => {
  it('returns full detection for scaffolded target', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'unconfirmed',
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const result = detectProjectState(d);

    assert.ok(result.documents);
    assert.ok(result.grouping);
    assert.ok(result.taskId);
    assert.ok(result.backend);
    assert.equal(result.hasExistingProjectMap, true);
    assert.equal(result.isConfirmed, false);
  });

  it('detects confirmed state', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      task_backend: 'files',
      grouping_profile: 'flat',
    });

    const result = detectProjectState(d);
    assert.equal(result.isConfirmed, true);
  });

  it('detects project name from package.json', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'test-project' }));

    const result = detectProjectState(d);
    assert.equal(result.projectName, 'test-project');
  });
});
