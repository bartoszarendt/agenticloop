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
import { validateConfig } from '../src/validate-config.js';
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
    assert.equal(result.config.development_stage, 'unconfirmed');
    assert.equal(result.config.max_parallel_implementation_lanes, 5);
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

  it('uses the configured task id pattern for verification fact sources', () => {
    const dir = makeProjectMap([
      'task_id_pattern: "P<phase>-<number>"',
      'task_id_regex: "^P\\d+-\\d+$"',
    ]);
    const projectPath = join(dir, '.agenticloop', 'project.md');
    writeFileSync(projectPath, readFileSync(projectPath, 'utf-8') + `

## Verification Operating Facts

### VF-fast-unit-selection-timeout

- Command: \`npm run test:fast\`
- Last outcome: timed_out
- Observed duration ms: 120000
- Timeout ms: 120000
- Host timeout ceiling ms: 120000
- Strategy: focused
- Updated: 2026-07-23
- Source: P25-17
- Revisit when: the fast-test selection or host timeout changes
- Decision: none
`);

    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);

    assert.deepEqual(validation.errors, []);
    assert.equal(result.verificationFacts[0].source, 'P25-17');
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
      'development_stage: expansion',
    ], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.deepEqual(validation.errors, []);
  });

  for (const stage of ['greenfield', 'expansion', 'stabilization', 'maintenance']) {
    it(`accepts confirmed development_stage: ${stage}`, () => {
      const dir = makeProjectMap([
        'setup_status: confirmed',
        'setup_confirmed_at: "2026-06-16"',
        'setup_confirmed_by: "maintainer"',
        `development_stage: ${stage}`,
      ], { includeDefaultSetupState: false });
      const result = loadProjectMap(dir);
      assert.deepEqual(validateProjectMap(result.config, result.raw, dir).errors, []);
    });
  }

  it('rejects missing, unconfirmed, and unknown development stages on confirmed setup', () => {
    for (const stage of [null, 'unconfirmed', 'prototype']) {
      const lines = [
        'setup_status: confirmed',
        'setup_confirmed_at: "2026-06-16"',
        'setup_confirmed_by: "maintainer"',
      ];
      if (stage) lines.push(`development_stage: ${stage}`);
      const dir = makeProjectMap(lines, { includeDefaultSetupState: false });
      const result = loadProjectMap(dir);
      const validation = validateProjectMap(result.config, result.raw, dir);
      assert.ok(validation.errors.some(error => error.includes('confirmed setup requires development_stage')));
    }
  });

  it('allows an unconfirmed scaffold stage but rejects an unconfirmed real stage', () => {
    const validDir = makeProjectMap(['development_stage: unconfirmed']);
    const valid = loadProjectMap(validDir);
    assert.deepEqual(validateProjectMap(valid.config, valid.raw, validDir).errors, []);

    const invalidDir = makeProjectMap(['development_stage: expansion']);
    const invalid = loadProjectMap(invalidDir);
    assert.ok(validateProjectMap(invalid.config, invalid.raw, invalidDir).errors
      .some(error => error.includes('unconfirmed setup may only use development_stage')));
  });

  it('validates optional development-stage notes as strings', () => {
    const dir = makeProjectMap([
      'development_stage_rationale:',
      '  reason: not-a-string',
      'development_stage_revisit_when:',
      '  reason: not-a-string',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    assert.ok(validation.errors.some(error => error.includes('development_stage_rationale must be a string')));
    assert.ok(validation.errors.some(error => error.includes('development_stage_revisit_when must be a string')));
  });

  it('round-trips optional development-stage rationale and revisit strings', () => {
    const dir = makeProjectMap([
      'setup_status: confirmed',
      'setup_confirmed_at: "2026-06-16"',
      'setup_confirmed_by: "maintainer"',
      'development_stage: maintenance',
      'development_stage_rationale: "Public compatibility is documented."',
      'development_stage_revisit_when: "A supported major migration is approved."',
    ], { includeDefaultSetupState: false });
    const result = loadProjectMap(dir);

    assert.equal(result.config.development_stage_rationale, 'Public compatibility is documented.');
    assert.equal(result.config.development_stage_revisit_when, 'A supported major migration is approved.');
    assert.deepEqual(validateProjectMap(result.config, result.raw, dir).errors, []);
  });

  it('accepts the default and a configured positive implementation-lane maximum', () => {
    const defaultDir = makeProjectMap([]);
    const defaults = loadProjectMap(defaultDir);
    assert.equal(defaults.config.max_parallel_implementation_lanes, 5);

    const configuredDir = makeProjectMap(['max_parallel_implementation_lanes: 7']);
    const configured = loadProjectMap(configuredDir);
    assert.equal(configured.config.max_parallel_implementation_lanes, 7);
    assert.deepEqual(validateProjectMap(configured.config, configured.raw, configuredDir).errors, []);
  });

  for (const value of ['0', '-1', '1.5', '"five"']) {
    it(`rejects invalid implementation-lane maximum ${value}`, () => {
      const dir = makeProjectMap([`max_parallel_implementation_lanes: ${value}`]);
      const result = loadProjectMap(dir);
      assert.ok(validateProjectMap(result.config, result.raw, dir).errors
        .some(error => error.includes('max_parallel_implementation_lanes must be a positive integer')));
    });
  }

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

  it('rejects summary_template as a removed legacy key with actionable guidance', () => {
    const dir = makeProjectMap([
      'summary_template: ".agenticloop/summaries/{summarySlug}.md"',
    ]);
    const result = loadProjectMap(dir);
    const validation = validateProjectMap(result.config, result.raw, dir);
    const summaryError = validation.errors.find(error => error.includes('summary_template'));
    assert.ok(summaryError, 'expected an error naming summary_template');
    // The diagnostic must be actionable: say to remove the field and that
    // summaries now live inline in the task record.
    assert.match(summaryError, /should be removed/);
    assert.match(summaryError, /inline in the task record/);
  });

  it('surfaces the summary_template diagnostic through validateConfig', () => {
    const dir = makeProjectMap([
      'summary_template: ".agenticloop/summaries/{summarySlug}.md"',
    ]);
    const { errors } = validateConfig(dir);
    const summaryError = errors.find(error => error.includes('summary_template'));
    assert.ok(summaryError, `expected validateConfig to surface the summary_template error, got: ${errors.join('; ')}`);
    assert.match(summaryError, /should be removed/);
    assert.match(summaryError, /inline in the task record/);
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
