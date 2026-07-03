import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  loadProjectMap,
  validateProjectMap,
  isValidTaskId,
} from '../src/project-map.js';
import { getDocumentRoleRegistry } from '../src/document-roles.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpBase;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'al-project-map-test-'));
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function makeProjectMap(frontmatterLines, options = {}) {
  const { includeDefaultSetupState = true } = options;
  const dir = mkdtempSync(join(tmpBase, 'fixture-'));
  mkdirSync(join(dir, '.agenticloop'), { recursive: true });
  const setupLines = includeDefaultSetupState
    ? [
        'setup_status: unconfirmed',
        'setup_confirmed_at: ""',
        'setup_confirmed_by: ""',
      ]
    : [];
  writeFileSync(
    join(dir, '.agenticloop', 'project.md'),
    ['---', ...setupLines, ...frontmatterLines, '---', '# Project Map'].join('\n')
  );
  return dir;
}

describe('loadProjectMap', () => {
  it('applies task-first defaults', () => {
    const dir = makeProjectMap([]);
    const result = loadProjectMap(dir);
    assert.ok(result);
    assert.equal(result.config.task_backend, 'files');
    assert.equal(result.config.event_logging, 'disabled');
    assert.equal(result.config.event_logging_command, '');
    assert.equal(result.config.task_id_pattern, 'T-<number>');
    assert.equal(result.config.task_id_regex, '^T-\\d{3,}$');
    assert.equal(result.config.grouping_profile, 'flat');
    assert.equal(result.config.group_closeout, false);
    assert.equal(result.config.documents.rules, 'AGENTS.md');
    // plan is a task-source role, not a forced default; absent unless detected/selected.
    assert.equal(result.config.documents.plan, undefined);
    assert.equal(result.config.documents.overview, 'README.md');
    assert.equal(result.config.documents.process, 'agenticloop/AGENTIC_LOOP.md');
  });

  it('fills in phase grouping defaults when grouping_profile is phase', () => {
    const dir = makeProjectMap([
      'grouping_profile: phase',
    ]);
    const result = loadProjectMap(dir);
    assert.ok(result);
    assert.equal(result.config.grouping_term, 'Phase');
    assert.equal(result.config.group_closeout, true);
    assert.ok(result.config.group_heading_regex.includes('Phase'));
  });
});

describe('validateProjectMap', () => {
  it('accepts a template-style project map with unconfirmed setup state', () => {
    const dir = makeProjectMap([
      'task_backend: files',
      'event_logging: disabled',
      'event_logging_command: ""',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.deepEqual(validation.errors, []);
  });

  it('accepts event_logging: enabled', () => {
    const dir = makeProjectMap([
      'event_logging: enabled',
      'event_logging_command: "npx agenticloop"',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);

    assert.deepEqual(validation.errors, []);
  });

  it('accepts engineer_context_window_tokens as a positive integer', () => {
    const dir = makeProjectMap([
      'engineer_context_window_tokens: 256000',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);

    assert.equal(result.config.engineer_context_window_tokens, 256000);
    assert.deepEqual(validation.errors, []);
  });

  it('rejects invalid engineer_context_window_tokens values', () => {
    const dir = makeProjectMap([
      'engineer_context_window_tokens: "256k"',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);

    assert.ok(validation.errors.some(error => error.includes('engineer_context_window_tokens must be a positive integer')));
  });

  it('rejects invalid event_logging values', () => {
    const dir = makeProjectMap([
      'event_logging: maybe',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);

    assert.ok(validation.errors.some(error => error.includes("event_logging must be 'disabled' or 'enabled'")));
  });

  it('rejects non-string event_logging_command values when present', () => {
    const dir = makeProjectMap([
      'event_logging_command:',
      '  shell: npx',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);

    assert.ok(validation.errors.some(error => error.includes('event_logging_command must be a string')));
  });

  it('fails when setup_status is missing', () => {
    const dir = makeProjectMap([], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('setup_status is required')));
  });

  it('fails when setup_status is invalid', () => {
    const dir = makeProjectMap([
      'setup_status: pending',
    ], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes("setup_status must be 'unconfirmed' or 'confirmed'")));
  });

  it('fails when confirmed setup is missing date and confirmer', () => {
    const dir = makeProjectMap([
      'setup_status: confirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
    ], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('setup_confirmed_at is required')));
    assert.ok(validation.errors.some(error => error.includes('setup_confirmed_by is required')));
  });

  it('accepts confirmed setup with YYYY-MM-DD date and confirmer', () => {
    const dir = makeProjectMap([
      'setup_status: confirmed',
      'setup_confirmed_at: "2026-06-16"',
      'setup_confirmed_by: "maintainer"',
    ], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.deepEqual(validation.errors, []);
  });

  it('fails when confirmed setup date is malformed', () => {
    const dir = makeProjectMap([
      'setup_status: confirmed',
      'setup_confirmed_at: "2026/06/16"',
      'setup_confirmed_by: "maintainer"',
    ], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('setup_confirmed_at must be YYYY-MM-DD')));
  });

  it('rejects phase_summary_template', () => {
    const dir = makeProjectMap([
      'phase_summary_template: ".agenticloop/phase-summaries/phase_{phaseSlug}_summary.md"',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('phase_summary_template')));
  });

  it('rejects summary_template as a removed legacy key', () => {
    const dir = makeProjectMap([
      'summary_template: ".agenticloop/summaries/{summarySlug}.md"',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('summary_template')));
  });

  it('requires custom grouping fields', () => {
    const dir = makeProjectMap([
      'grouping_profile: custom',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('grouping_term')));
    assert.ok(validation.errors.some(error => error.includes('group_heading_regex')));
    assert.ok(validation.errors.some(error => error.includes('group_closeout')));
  });
});

describe('task id validation', () => {
  it('accepts neutral task ids by default', () => {
    assert.equal(isValidTaskId('T-001', '^T-\\d{3,}$'), true);
    assert.equal(isValidTaskId('T-120', '^T-\\d{3,}$'), true);
  });

  it('supports phase-style task ids when the project config chooses them', () => {
    assert.equal(isValidTaskId('P1-01', '^P\\d+-\\d{2,}$'), true);
    assert.equal(isValidTaskId('P1-1', '^P\\d+-\\d{2,}$'), false);
  });
});

describe('document role registry', () => {
  it('contains the expected typed roles', () => {
    const registry = getDocumentRoleRegistry();
    assert.deepEqual(Object.keys(registry), [
      'rules',
      'plan',
      'overview',
      'process',
      'spec',
      'design',
      'context',
      'history',
    ]);
  });

  it('keeps setup-agenticloop candidate names aligned with the registry', () => {
    const registry = getDocumentRoleRegistry();
    const skillText = readFileSync(join(REPO_ROOT, 'skills', 'setup-agenticloop', 'SKILL.md'), 'utf-8');

    for (const entry of Object.values(registry)) {
      for (const candidate of entry.candidates) {
        assert.ok(
          skillText.includes(candidate),
          `expected setup-agenticloop to mention candidate ${candidate}`
        );
      }
    }
  });

  it('removes active phase-specific base config keys', () => {
    const baseText = readFileSync(join(REPO_ROOT, 'config.json'), 'utf-8');
    for (const legacyKey of [
      'phaseHeadingRegex',
      'phaseSlugRules',
      'phaseSummaryDirectory',
      'phaseLabelTemplate',
      'phase-closeout',
      'summaryPathTemplate',
      'phaseSlug',
      'phase-summaries',
      'summaryTemplate',
      'summaryDirectory',
      'summaryBranchTemplate',
      'summarySlug',
    ]) {
      assert.ok(!baseText.includes(legacyKey), `did not expect ${legacyKey} in config.json`);
    }
  });
});
