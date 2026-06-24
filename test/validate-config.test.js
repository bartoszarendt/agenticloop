/**
 * Tests for src/validate-config.js.
 *
 * Covers:
 *   - OpenCode adapter validation (mode: subagent, permission.edit, permission.task)
 *   - Role model validation
 *   - Task-record placeholder rejection (TBD, as needed, etc., similar to previous task, to be filled, empty sections)
 *   - Passes on the toolkit source repo without requiring downstream target config
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../src/validate-config.js';
import { loadAgenticLoopConfig, loadJsonFile } from '../src/json.js';
import {
  generateOpencodeArtifacts,
} from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { AGENTIC_LOOP_OPERATION_DESCRIPTION } from '../src/adapters/shared.js';
import { seedScratch, seedTargetLayout, seedToolkitSource } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-cfg-test-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Create a minimal but valid target directory for config tests
function makeTarget(subName, overrides = {}) {
  const d = mkdtempSync(join(tmpDir, `${subName}-`));
  const deferredOverrides = {};

  seedTargetLayout(REPO_ROOT, d);

  // Apply non-OpenCode overrides first so generated agent files reflect any
  // agenticloop.json changes in the fixture.
  for (const [filename, content] of Object.entries(overrides)) {
    if (filename === 'opencode.jsonc' || filename.startsWith('.opencode/')) {
      deferredOverrides[filename] = content;
      continue;
    }
    const fullPath = join(d, filename);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  const cfg = loadAgenticLoopConfig(join(d, 'agenticloop.json'));
  generateOpencodeArtifacts(cfg, d, d);

  for (const [filename, content] of Object.entries(deferredOverrides)) {
    const fullPath = join(d, filename);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  return d;
}

function renderOpencodeAgentFixture({
  description = 'Role',
  mode = 'subagent',
  model = 'model/id',
  variant = 'high',
  permissionLines = [],
  body = [
    'You are the Role for the target project.',
    'Follow agenticloop/agents/role.md as the canonical role contract.',
    'Follow the selected project documents from .agenticloop/project.md and the Agentic Loop methodology.',
  ].join('\n\n'),
} = {}) {
  return [
    '---',
    `description: ${JSON.stringify(description)}`,
    `mode: ${JSON.stringify(mode)}`,
    `model: ${JSON.stringify(model)}`,
    `variant: ${JSON.stringify(variant)}`,
    ...permissionLines,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function taskRecord({
  taskId = 'T-001',
  status = 'agent-ready',
  backend = 'files',
  implementationArtifact = '',
  reviewStatus = '',
  task = 'Implement the feature.',
  sourceDocs = 'AGENTS.md, IMPLEMENTATION_PLAN.md',
  currentState = 'Current behavior is documented.',
  scope = 'Add X to Y.',
  outOfScope = 'Do not change unrelated behavior.',
  acceptance = 'X works when Y.',
  requiredChecks = 'npm test',
  expectedFiles = 'src/example.js, test/example.test.js',
  notes = 'Keep the change scoped.',
  completion = 'Engineer must list files, checks, results, limitations, deviations, and follow-ups.',
  checklist = '- [ ] Scope matches task record\n- [ ] Evidence is fresh',
  scopeCompleted = '',
  includeFrontmatter = true,
} = {}) {
  const frontmatter = includeFrontmatter ? `---
task_id: ${taskId}
status: ${status}
backend: ${backend}
implementation_artifact: ${implementationArtifact}
review_status: ${reviewStatus}
---

` : '';

  const summarySection = scopeCompleted ? `

## Scope Completed
${scopeCompleted}

## Artifacts
Implementation artifact recorded in task frontmatter.

## Evidence
Fresh required-check output is recorded here.

## Deviations
No deviations.

## Process Observations

## Known Gaps
No known gaps.

## Follow-Ups
No follow-ups.` : '';

  return `
${frontmatter}# ${taskId} - Sample Task

## Task
${task}
## Source Documents Reviewed
${sourceDocs}
## Current State
${currentState}
## Scope
${scope}
## Out of Scope
${outOfScope}
## Acceptance Criteria
${acceptance}
## Required Checks
${requiredChecks}
## Expected Files or Areas
${expectedFiles}
## Implementation Notes
${notes}
## Completion Summary Template
${completion}
## Reviewer Checklist
${checklist}${summarySection}
  `.trim();
}

function writeProjectMap(dir, frontmatterLines) {
  mkdirSync(join(dir, '.agenticloop'), { recursive: true });
  writeFileSync(
    join(dir, '.agenticloop', 'project.md'),
    ['---', ...frontmatterLines, '---', '# Project Map'].join('\n')
  );
}

function writeBackendProjection(dir, backend) {
  if (!existsSync(join(dir, 'agenticloop', 'manifest.json'))) {
    seedToolkitSource(REPO_ROOT, dir);
  }
  mkdirSync(join(dir, 'agenticloop', 'backends'), { recursive: true });
  writeFileSync(join(dir, 'agenticloop', 'backends', `${backend}.md`), `# ${backend}\n`);
}

function writeCodexAdapterOutput(dir, options = {}) {
  const cfg = loadAgenticLoopConfig(join(dir, 'agenticloop.json'));
  if (options.pluginEnabled) {
    cfg.adapters.codex.plugin = { enabled: true };
  }
  generateCodexArtifacts(cfg, dir, dir);
}

function writeCopilotAdapterOutput(dir) {
  const cfg = loadAgenticLoopConfig(join(dir, 'agenticloop.json'));
  generateCopilotArtifacts(cfg, dir, dir);
}

function writeCursorAdapterOutput(dir) {
  const cfg = loadAgenticLoopConfig(join(dir, 'agenticloop.json'));
  generateCursorArtifacts(cfg, dir, dir);
}

function githubEvidenceRunner({
  remote = 'https://github.com/acme/widget.git',
  ghAvailable = true,
  ghAuthenticated = true,
  labelNames = [],
  issueTitles = [],
} = {}) {
  return (command, args) => {
    if (command === 'git' && args.join(' ') === 'config --get remote.origin.url') {
      return remote
        ? { status: 0, stdout: `${remote}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'no remote configured' };
    }

    if (command === 'gh' && args.join(' ') === '--version') {
      if (!ghAvailable) {
        const error = new Error('spawn gh ENOENT');
        error.code = 'ENOENT';
        return { status: null, stdout: '', stderr: '', error };
      }
      return { status: 0, stdout: 'gh version 2.55.0\n', stderr: '' };
    }

    if (command === 'gh' && args.join(' ') === 'auth status') {
      return ghAuthenticated
        ? { status: 0, stdout: 'github.com\n  Logged in\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'not logged into any hosts' };
    }

    if (command === 'gh' && args[0] === 'label' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify(labelNames.map(name => ({ name }))),
        stderr: '',
      };
    }

    if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify(issueTitles.map(title => ({ title }))),
        stderr: '',
      };
    }

    return {
      status: 1,
      stdout: '',
      stderr: `unexpected command: ${command} ${args.join(' ')}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Toolkit source repo passes
// ---------------------------------------------------------------------------

describe('Toolkit source repo validation', () => {
  it('validates the real repo without downstream target warnings', () => {
    const { errors, warnings } = validateConfig(REPO_ROOT);
    assert.deepEqual(errors, [], `Expected no errors, got: ${errors.join('; ')}`);
    assert.deepEqual(warnings, [], `Expected no warnings, got: ${warnings.join('; ')}`);
  });
});

describe('Layout validation', () => {
  it('reports stale v2 layout with migration guidance only, not v3 missing-path noise', () => {
    const d = mkdtempSync(join(tmpDir, 'layout-v2-'));
    mkdirSync(join(d, 'agenticloop'), { recursive: true });
    writeFileSync(
      join(d, 'agenticloop', 'manifest.json'),
      JSON.stringify({ layoutVersion: 2, sourcePaths: ['AGENTIC_LOOP.md', 'base.json', 'templates'] }, null, 2) + '\n',
      'utf-8'
    );
    copyFileSync(join(REPO_ROOT, 'config.json'), join(d, 'agenticloop', 'base.json'));
    writeFileSync(
      join(d, 'agenticloop.json'),
      JSON.stringify({ extends: './agenticloop/base.json' }, null, 2) + '\n',
      'utf-8'
    );
    seedScratch(d);

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(error => error.includes("Run 'agenticloop update'") && error.includes('layoutVersion')),
      `expected v2 migration guidance, got: ${JSON.stringify(errors)}`
    );
    assert.equal(
      errors.some(error => error.startsWith('Current-layout source path missing:')),
      false,
      `v2 validation should not report current-layout path noise: ${JSON.stringify(errors)}`
    );
  });
});

// ---------------------------------------------------------------------------
// OpenCode adapter validation
// ---------------------------------------------------------------------------

describe('OpenCode subagent mode validation', () => {
  it('errors when maintainer uses mode: "all" instead of "subagent"', () => {
    const d = makeTarget('subagent-mode', {
      '.opencode/agents/maintainer.md': renderOpencodeAgentFixture({
        description: 'Maintainer',
        mode: 'all',
        body: [
          'You are the Maintainer for the target project.',
          'Follow agenticloop/agents/maintainer.md as the canonical role contract.',
          'Follow the selected project documents from .agenticloop/project.md and the Agentic Loop methodology.',
          '- task-record-contract: agenticloop/skills/task-record-contract/SKILL.md',
          'maintainer body',
        ].join('\n\n'),
      }),
    });
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes("maintainer") && e.includes("subagent")));
  });

  it('errors when orchestrator permission.task is missing', () => {
    const d = makeTarget('missing-perm', {
      '.opencode/agents/orchestrator.md': renderOpencodeAgentFixture({
        description: 'Orchestrator',
        mode: 'primary',
        permissionLines: ['permission:', '  edit: deny'],
        body: [
          'You are the Orchestrator for the target project.',
          'Follow agenticloop/agents/orchestrator.md as the canonical role contract.',
          'Follow the selected project documents from .agenticloop/project.md and the Agentic Loop methodology.',
          '- role-delegation: agenticloop/skills/role-delegation/SKILL.md',
          '- blocked-state: agenticloop/skills/blocked-state/SKILL.md',
          'orchestrator body',
        ].join('\n\n'),
      }),
    });
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('permission.task')));
  });

  it('errors when orchestrator permission.edit is not deny', () => {
    const d = makeTarget('missing-edit-deny', {
      '.opencode/agents/orchestrator.md': renderOpencodeAgentFixture({
        description: 'Orchestrator',
        mode: 'primary',
        permissionLines: [
          'permission:',
          '  edit: allow',
          '  task:',
          '    "*": deny',
          '    maintainer: allow',
          '    engineer: allow',
        ],
        body: [
          'You are the Orchestrator for the target project.',
          'Follow agenticloop/agents/orchestrator.md as the canonical role contract.',
          'Follow the selected project documents from .agenticloop/project.md and the Agentic Loop methodology.',
          '- role-delegation: agenticloop/skills/role-delegation/SKILL.md',
          '- blocked-state: agenticloop/skills/blocked-state/SKILL.md',
          'orchestrator body',
        ].join('\n\n'),
      }),
    });
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('permission.edit') && e.includes('deny')));
  });

  it('errors when permission.task does not allow engineer', () => {
    const d = makeTarget('no-eng-perm', {
      '.opencode/agents/orchestrator.md': renderOpencodeAgentFixture({
        description: 'Orchestrator',
        mode: 'primary',
        permissionLines: [
          'permission:',
          '  edit: deny',
          '  task:',
          '    "*": deny',
          '    maintainer: allow',
        ],
        body: [
          'You are the Orchestrator for the target project.',
          'Follow agenticloop/agents/orchestrator.md as the canonical role contract.',
          'Follow the selected project documents from .agenticloop/project.md and the Agentic Loop methodology.',
          '- role-delegation: agenticloop/skills/role-delegation/SKILL.md',
          '- blocked-state: agenticloop/skills/blocked-state/SKILL.md',
          'orchestrator body',
        ].join('\n\n'),
      }),
    });
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes("engineer")));
  });

  it('errors when a generated OpenCode agent file is missing', () => {
    const d = makeTarget('missing-opencode-agent');
    rmSync(join(d, '.opencode', 'agents', 'engineer.md'), { force: true });

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('OpenCode agent not found') && e.includes('engineer.md')));
  });

  it('errors when the generated prompt omits a required canonical skill path', () => {
    const d = makeTarget('missing-opencode-skill-path', {
      '.opencode/agents/orchestrator.md': renderOpencodeAgentFixture({
        description: 'Orchestrator',
        mode: 'primary',
        permissionLines: [
          'permission:',
          '  edit: deny',
          '  task:',
          '    "*": deny',
          '    maintainer: allow',
          '    engineer: allow',
        ],
        body: [
          'You are the Orchestrator for the target project.',
          'Follow agenticloop/agents/orchestrator.md as the canonical role contract.',
          'Follow the selected project documents from .agenticloop/project.md and the Agentic Loop methodology.',
          '- blocked-state: agenticloop/skills/blocked-state/SKILL.md',
          'orchestrator body',
        ].join('\n\n'),
      }),
    });

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('role-delegation/SKILL.md')));
  });

  it('errors when the generated OpenCode command is missing', () => {
    const d = makeTarget('missing-opencode-command');
    rmSync(join(d, '.opencode', 'commands', 'agenticloop.md'), { force: true });

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('OpenCode command not found')));
  });

  it('errors when the OpenCode command frontmatter does not use agent: orchestrator', () => {
    const d = makeTarget('bad-opencode-command-agent', {
      '.opencode/commands/agenticloop.md': [
        '---',
        `description: ${AGENTIC_LOOP_OPERATION_DESCRIPTION}`,
        'agent: maintainer',
        '---',
        '',
        'Read `.agenticloop/project.md` first.',
        'Then follow `agenticloop/AGENTIC_LOOP.md` and the canonical role contracts in `agenticloop/agents/`.',
        'Create or refine the durable task record before any implementation.',
        'Requested task or context: `$ARGUMENTS`',
        '',
      ].join('\n'),
    });

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('agent: orchestrator')));
  });

  it('errors when the OpenCode command hard-codes a model', () => {
    const d = makeTarget('bad-opencode-command-model', {
      '.opencode/commands/agenticloop.md': [
        '---',
        `description: ${AGENTIC_LOOP_OPERATION_DESCRIPTION}`,
        'agent: orchestrator',
        'model: fixed/model',
        '---',
        '',
        'Read `.agenticloop/project.md` first.',
        'Then follow `agenticloop/AGENTIC_LOOP.md` and the canonical role contracts in `agenticloop/agents/`.',
        'Create or refine the durable task record before any implementation.',
        'Requested task or context: `$ARGUMENTS`',
        '',
      ].join('\n'),
    });

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('must not hard-code model')));
  });

  it('errors when the OpenCode command body omits core activation instructions', () => {
    const d = makeTarget('bad-opencode-command-body', {
      '.opencode/commands/agenticloop.md': [
        '---',
        `description: ${AGENTIC_LOOP_OPERATION_DESCRIPTION}`,
        'agent: orchestrator',
        '---',
        '',
        'Requested task or context: `$ARGUMENTS`',
        '',
      ].join('\n'),
    });

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('`.agenticloop/project.md`')));
    assert.ok(errors.some(e => e.includes('`agenticloop/AGENTIC_LOOP.md`')));
    assert.ok(errors.some(e => e.includes('Create or refine the durable task record')));
  });

  it('warns when both OpenCode and Codex outputs are present', () => {
    const d = makeTarget('opencode-codex-visible');
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop', 'SKILL.md'), '# skill\n');

    const { warnings } = validateConfig(d);
    assert.ok(warnings.some(w => w.includes('/agenticloop') && w.includes('.agents/skills/agenticloop/SKILL.md')));
  });
});

// ---------------------------------------------------------------------------
// Role model validation
// ---------------------------------------------------------------------------

describe('Role model validation', () => {
  it('accepts model-less OpenCode output when no role model settings are configured', () => {
    const alConfig = JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: {
          roleSettings: {},
        },
      },
    }, null, 2);
    const d = makeTarget('model-less-opencode', { 'agenticloop.json': alConfig });
    // Fresh adapter init is allowed to be model-less. Validation only checks
    // model equality once a model is configured.
    const { errors } = validateConfig(d);
    assert.deepEqual(errors, [], `Expected no errors, got: ${errors.join('; ')}`);
  });

  it('accepts adapter roleSettings as the model source', () => {
    const alConfig = JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: {
          roleSettings: {
            orchestrator: { model: 'some/model', reasoningEffort: 'high' },
            maintainer: { model: 'maintainer/model', reasoningEffort: 'high' },
            engineer: { model: 'engineer/model', reasoningEffort: 'high' },
          },
        },
      },
    }, null, 2);
    const d = makeTarget('adapter-role-settings', { 'agenticloop.json': alConfig });
    const { errors } = validateConfig(d);
    assert.deepEqual(errors, [], `Expected no errors, got: ${errors.join('; ')}`);
  });

  it('errors when reasoningEffort is not a string', () => {
    const alConfig = JSON.stringify({
      extends: './agenticloop/config.json',
      roles: {
        orchestrator: {
          model: 'some/model',
          reasoningEffort: 3,
        },
      },
      adapters: {
        opencode: {
          roleSettings: {
            maintainer: { model: 'maintainer/model', reasoningEffort: 'high' },
            engineer: { model: 'engineer/model', reasoningEffort: 'high' },
          },
        },
      },
    }, null, 2);
    const d = makeTarget('bad-reasoning-effort', { 'agenticloop.json': alConfig });
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes("reasoningEffort")));
  });

  it('errors when Codex reasoningEffort uses unsupported explicit values', () => {
    for (const effort of ['auto', 'max']) {
      const alConfig = JSON.stringify({
        extends: './agenticloop/config.json',
        adapters: {
          codex: {
            roleSettings: {
              engineer: {
                model: 'gpt-5.4',
                reasoningEffort: effort,
              },
            },
          },
        },
      }, null, 2);
      const d = makeTarget(`codex-invalid-effort-${effort}`, { 'agenticloop.json': alConfig });
      const { errors } = validateConfig(d);
      assert.ok(
        errors.some(e => e.includes(`adapters.codex.roleSettings.engineer.reasoningEffort/variant must be one of: minimal, low, medium, high, xhigh`)),
        `expected unsupported Codex reasoning effort error for ${effort}, got: ${JSON.stringify(errors)}`
      );
    }
  });

  it('accepts Codex minimal and xhigh reasoningEffort values', () => {
    for (const effort of ['minimal', 'xhigh']) {
      const alConfig = JSON.stringify({
        extends: './agenticloop/config.json',
        adapters: {
          codex: {
            roleSettings: {
              engineer: {
                model: 'gpt-5.4',
                reasoningEffort: effort,
              },
            },
          },
        },
      }, null, 2);
      const d = makeTarget(`codex-valid-effort-${effort}`, { 'agenticloop.json': alConfig });
      const { errors } = validateConfig(d);
      assert.ok(
        !errors.some(e => e.includes('adapters.codex.roleSettings.engineer.reasoningEffort/variant')),
        `expected Codex reasoning effort ${effort} to be valid, got: ${JSON.stringify(errors)}`
      );
    }
  });

  it('keeps legacy roles.<role>.model settings valid', () => {
    const alConfig = JSON.stringify({
      extends: './agenticloop/config.json',
      roles: {
        orchestrator: {
          model: 'some/model',
          reasoningEffort: 'high',
        },
      },
      adapters: {
        opencode: {
          roleSettings: {
            maintainer: { model: 'maintainer/model', reasoningEffort: 'high' },
            engineer: { model: 'engineer/model', reasoningEffort: 'high' },
          },
        },
      },
    }, null, 2);
    const d = makeTarget('legacy-roles-model', { 'agenticloop.json': alConfig });
    const { errors } = validateConfig(d);
    assert.deepEqual(errors, [], `Expected no errors, got: ${errors.join('; ')}`);
  });
});

// ---------------------------------------------------------------------------
// Task-record placeholder rejection
// ---------------------------------------------------------------------------

describe('Task-record placeholder rejection', () => {
  it('errors on TBD in task record', () => {
    const d = makeTarget('task-tbd');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-001.md'), taskRecord({ taskId: 'T-001', scope: 'TBD' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('TBD') && e.includes('T-001.md')));
  });

  it('errors on "to be filled" in task record', () => {
    const d = makeTarget('task-tobefilled');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-002.md'), taskRecord({ taskId: 'T-002', scope: 'to be filled' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('to be filled')));
  });

  it('errors on "as needed" in task record', () => {
    const d = makeTarget('task-as-needed');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-020.md'), taskRecord({ taskId: 'T-020', scope: 'as needed' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('as needed')));
  });

  it('errors on "etc." in task record', () => {
    const d = makeTarget('task-etc');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-021.md'), taskRecord({ taskId: 'T-021', scope: 'Update docs, tests, etc.' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('placeholder text matching') && e.includes('etc')));
  });

  it('errors on "similar to previous task" in task record', () => {
    const d = makeTarget('task-similar-previous');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-022.md'), taskRecord({ taskId: 'T-022', scope: 'similar to previous task' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('similar to previous task')));
  });

  it('errors on empty Completion Summary Template', () => {
    const d = makeTarget('task-empty-summary');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-003.md'), taskRecord({ taskId: 'T-003', completion: '' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('Completion Summary Template') && e.includes('empty')));
  });

  it('errors on empty Reviewer Checklist', () => {
    const d = makeTarget('task-empty-checklist');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-004.md'), taskRecord({ taskId: 'T-004', checklist: '' }));
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('Reviewer Checklist') && e.includes('empty')));
  });

  it('passes when task record is valid', () => {
    const d = makeTarget('task-valid');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-005.md'), taskRecord({ taskId: 'T-005' }));
    const { errors } = validateConfig(d);
    const taskErrors = errors.filter(e => e.includes('T-005.md'));
    assert.deepEqual(taskErrors, []);
  });

  it('errors when a required task-record section is missing', () => {
    const d = makeTarget('task-missing-section');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    const missingOutOfScope = taskRecord().replace('## Out of Scope\nDo not change unrelated behavior.\n', '');
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-006.md'), missingOutOfScope);
    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes('T-006.md') && e.includes('Out of Scope')));
  });
});

// ---------------------------------------------------------------------------
// Files-backed task-record frontmatter validation
// ---------------------------------------------------------------------------

describe('Files-backed task-record frontmatter validation', () => {
  it('errors when a files-backed task record is missing frontmatter', () => {
    const d = makeTarget('task-no-frontmatter');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-007.md'), taskRecord({ includeFrontmatter: false }));

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes('T-007.md') && e.includes('missing YAML frontmatter')),
      `expected frontmatter error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when task_id does not match project.md task_id_regex', () => {
    const d = makeTarget('task-id-regex-mismatch');
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'P1-01.md'), taskRecord({ taskId: 'P1-01' }));

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes("task_id 'P1-01'") && e.includes('task_id_regex')),
      `expected task_id_regex error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when filename does not match task_id under the default task_file_template', () => {
    const d = makeTarget('task-filename-mismatch');
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-099.md'), taskRecord({ taskId: 'T-010' }));

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes('T-099.md') && e.includes('filename must match task_id')),
      `expected filename mismatch error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors on invalid status and invalid review_status for files-backed task records', () => {
    const d = makeTarget('task-bad-status');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-008.md'), taskRecord({
      taskId: 'T-008',
      status: 'pending-review',
      reviewStatus: 'open',
    }));

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes("invalid status 'pending-review'")));
    assert.ok(errors.some(e => e.includes("invalid review_status 'open'")));
  });

  it('requires implementation summary and implementation_artifact for accepted task files', () => {
    const d = makeTarget('task-accepted-missing-artifact');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-009.md'), taskRecord({
      taskId: 'T-009',
      status: 'accepted',
    }));

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => e.includes("status is 'accepted'") && e.includes('Scope Completed')));
    assert.ok(errors.some(e => e.includes("status is 'accepted'") && e.includes('implementation_artifact')));
  });

  it('requires the full work-unit summary skeleton for accepted task files using the new summary shape', () => {
    const d = makeTarget('task-accepted-partial-work-unit-summary');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    const partialSummary = taskRecord({
      taskId: 'T-012',
      status: 'accepted',
      implementationArtifact: 'commit:abc123',
      reviewStatus: 'accepted',
      scopeCompleted: 'Implemented the requested behavior.',
    }).replace(/\n\n## Artifacts[\s\S]*$/, '');
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-012.md'), partialSummary);

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes('T-012.md') && e.includes("missing work-unit summary section '## Artifacts'")),
      `expected missing work-unit summary section error, got: ${JSON.stringify(errors)}`
    );
  });

  it('does not reject a GitHub mirror task file when the active backend is github', () => {
    const d = makeTarget('github-mirror-task-file');
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: github',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    writeBackendProjection(d, 'github');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-011.md'), taskRecord({
      taskId: 'T-011',
      backend: 'github',
    }));

    const { errors } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });
    const taskErrors = errors.filter(e => e.includes('T-011.md'));
    assert.deepEqual(taskErrors, [], `expected GitHub mirror task file to pass, got: ${JSON.stringify(taskErrors)}`);
  });

  it('rejects a task file that claims backend files when the active backend is github', () => {
    const d = makeTarget('github-active-files-claim');
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: github',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    writeBackendProjection(d, 'github');
    mkdirSync(join(d, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'tasks', 'T-012.md'), taskRecord({
      taskId: 'T-012',
      backend: 'files',
    }));

    const { errors } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });
    assert.ok(
      errors.some(e => e.includes('T-012.md') && e.includes("declares backend 'files' but active task_backend is 'github'")),
      `expected backend mismatch error, got: ${JSON.stringify(errors)}`
    );
  });
});

// ---------------------------------------------------------------------------
// .agenticloop/tmp/ and .gitignore checks
// ---------------------------------------------------------------------------

describe('.agenticloop/tmp/ and .gitignore checks', () => {
  it('warns when .agenticloop/tmp/ does not exist', () => {
    const d = makeTarget('no-tmp');
    rmSync(join(d, '.agenticloop', 'tmp'), { recursive: true, force: true });
    const { warnings } = validateConfig(d);
    assert.ok(warnings.some(w => w.includes('.agenticloop/tmp/')));
  });

  it('warns when .agenticloop/tmp/ is not in .gitignore', () => {
    const d = makeTarget('tmp-not-gitignored');
    writeFileSync(join(d, '.gitignore'), '# nothing\n');
    const { warnings } = validateConfig(d);
    assert.ok(warnings.some(w => w.includes('.agenticloop/tmp/')));
  });

  it('warns when root-level scratch lookalike directories exist', () => {
    const d = makeTarget('scratch-lookalike');
    mkdirSync(join(d, '.agenticlooptmp'), { recursive: true });
    const { warnings } = validateConfig(d);
    assert.ok(warnings.some(w =>
      w.includes('.agenticlooptmp') && w.includes('.agenticloop/tmp/')
    ));
  });

  it('warns when a backslash-collapsed absolute scratch path leaks into the repo root', () => {
    const d = makeTarget('scratch-collapsed-absolute');
    // A '<repo>/.agenticloop/tmp/pr-body.md' path with separators stripped by a
    // POSIX shell collapses to a single prefixed root entry (colon omitted so the
    // fixture name is valid on every platform).
    const collapsed = 'appsexport-print-sales-copilot.agenticlooptmppr-body.md';
    writeFileSync(join(d, collapsed), 'leaked body\n');
    const { warnings } = validateConfig(d);
    assert.ok(warnings.some(w =>
      w.includes(collapsed) && w.includes('.agenticloop/tmp/')
    ));
  });

  it('does not flag the canonical .agenticloop state directory as a scratch lookalike', () => {
    const d = makeTarget('scratch-canonical-ok');
    const { warnings } = validateConfig(d);
    assert.ok(!warnings.some(w => w.includes('backslash-collapsed')));
    assert.ok(!warnings.some(w =>
      w.includes("Root-level '.agenticloop'")
    ));
  });
});

// ---------------------------------------------------------------------------
// Layered config (extends) tests
// ---------------------------------------------------------------------------

describe('Layered config extends', () => {
  it('merges base plus override correctly', () => {
    const d = mkdtempSync(join(tmpDir, 'extends-merge-'));
    writeFileSync(join(d, 'base.json'), JSON.stringify({
      taskBackend: 'github',
      documents: { rules: 'AGENTS.md', process: 'agenticloop/AGENTIC_LOOP.md' },
      roles: { orchestrator: { sourceFile: 'agenticloop/agents/orchestrator.md', requiredSkills: ['role-delegation'] } },
    }));
    writeFileSync(join(d, 'override.json'), JSON.stringify({
      extends: './base.json',
      taskBackend: 'files',
      documents: { context: 'CONTEXT.md' },
      roles: { orchestrator: { model: 'some/model' } },
    }));

    const config = loadAgenticLoopConfig(join(d, 'override.json'));
    assert.equal(config.taskBackend, 'files');
    assert.equal(config.documents.rules, 'AGENTS.md');
    assert.equal(config.documents.context, 'CONTEXT.md');
    assert.equal(config.documents.process, 'agenticloop/AGENTIC_LOOP.md');
    assert.equal(config.roles.orchestrator.sourceFile, 'agenticloop/agents/orchestrator.md');
    assert.deepEqual(config.roles.orchestrator.requiredSkills, ['role-delegation']);
    assert.equal(config.roles.orchestrator.model, 'some/model');
    assert.equal(config.extends, undefined);
  });

  it('arrays replace instead of concatenate', () => {
    const d = mkdtempSync(join(tmpDir, 'extends-arrays-'));
    writeFileSync(join(d, 'base.json'), JSON.stringify({
      list: [1, 2, 3],
      roles: { orchestrator: { requiredSkills: ['a', 'b'] } },
    }));
    writeFileSync(join(d, 'override.json'), JSON.stringify({
      extends: './base.json',
      list: [4, 5],
      roles: { orchestrator: { requiredSkills: ['c'] } },
    }));

    const config = loadAgenticLoopConfig(join(d, 'override.json'));
    assert.deepEqual(config.list, [4, 5]);
    assert.deepEqual(config.roles.orchestrator.requiredSkills, ['c']);
  });

  it('nested objects merge', () => {
    const d = mkdtempSync(join(tmpDir, 'extends-nested-'));
    writeFileSync(join(d, 'base.json'), JSON.stringify({
      backends: { github: { labels: { agentReady: 'agent-ready' } } },
    }));
    writeFileSync(join(d, 'override.json'), JSON.stringify({
      extends: './base.json',
      backends: { github: { labels: { blocked: 'on-hold' } } },
    }));

    const config = loadAgenticLoopConfig(join(d, 'override.json'));
    assert.equal(config.backends.github.labels.agentReady, 'agent-ready');
    assert.equal(config.backends.github.labels.blocked, 'on-hold');
  });

  it('legacy role model and reasoning overrides survive config layering', () => {
    const d = mkdtempSync(join(tmpDir, 'extends-role-'));
    writeFileSync(join(d, 'base.json'), JSON.stringify({
      roles: {
        orchestrator: { sourceFile: 'agenticloop/agents/orchestrator.md', model: 'base/model', reasoningEffort: 'low' },
      },
    }));
    writeFileSync(join(d, 'override.json'), JSON.stringify({
      extends: './base.json',
      roles: {
        orchestrator: { model: 'target/model', reasoningEffort: 'high' },
      },
    }));

    const config = loadAgenticLoopConfig(join(d, 'override.json'));
    assert.equal(config.roles.orchestrator.sourceFile, 'agenticloop/agents/orchestrator.md');
    assert.equal(config.roles.orchestrator.model, 'target/model');
    assert.equal(config.roles.orchestrator.reasoningEffort, 'high');
  });

  it('missing extends file gives a clear validation error', () => {
    const d = mkdtempSync(join(tmpDir, 'extends-missing-'));
    writeFileSync(join(d, 'override.json'), JSON.stringify({
      extends: './missing-base.json',
    }));

    assert.throws(
      () => loadAgenticLoopConfig(join(d, 'override.json')),
      /missing-base\.json/
    );
  });

  it('detects circular extends chains', () => {
    const d = mkdtempSync(join(tmpDir, 'extends-cycle-'));
    writeFileSync(join(d, 'a.json'), JSON.stringify({ extends: './b.json', value: 1 }));
    writeFileSync(join(d, 'b.json'), JSON.stringify({ extends: './a.json', value: 2 }));

    assert.throws(
      () => loadAgenticLoopConfig(join(d, 'a.json')),
      /Circular extends chain/
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter-aware validation (Phase E)
// ---------------------------------------------------------------------------

describe('Adapter-aware validation', () => {
  it('does not require a root opencode.jsonc just because adapters.opencode is configured', () => {
    // Fresh target with no .opencode output and no root opencode.jsonc. The
    // base config still has the OpenCode adapter entry, but validate must not
    // require legacy config output.
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-no-oc-'));
    seedTargetLayout(REPO_ROOT, d);

    const { errors } = validateConfig(d);
    const opencodeErrors = errors.filter(e => /opencode\.jsonc|OpenCode config file/.test(e));
    assert.deepEqual(opencodeErrors, [],
      `expected no opencode.jsonc errors when the file is absent, got: ${JSON.stringify(opencodeErrors)}`);
  });

  it('validates Codex output when .codex/agents/ is present', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-codex-'));
    seedTargetLayout(REPO_ROOT, d);

    writeCodexAdapterOutput(d);

    const { errors } = validateConfig(d);
    const codexErrors = errors.filter(e => /Codex|\.codex|\.agents\/skills\/agenticloop/.test(e));
    assert.deepEqual(codexErrors, [],
      `expected no codex adapter errors with a complete output, got: ${JSON.stringify(codexErrors)}`);
  });

  it('errors when Codex generated TOML keeps a legacy model prefix', () => {
    const d = makeTarget('adapter-aware-codex-legacy-model');
    writeCodexAdapterOutput(d);

    const tomlPath = join(d, '.codex', 'agents', 'engineer.toml');
    const toml = readFileSync(tomlPath, 'utf-8')
      .replace('model = "gpt-5.4"', 'model = "codex-cli/gpt-5.4"')
      .replace('model_reasoning_effort = "xhigh"', 'model_reasoning_effort = "high"');
    writeFileSync(tomlPath, toml, 'utf-8');

    const { errors } = validateConfig(d, { adapters: ['codex'] });
    assert.ok(
      errors.some(e => /model must use a Codex model id/.test(e) && e.includes('codex-cli/gpt-5.4')),
      `expected legacy Codex model prefix error, got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      errors.some(e => /model must match adapters\.codex\.roleSettings\.engineer\.model/.test(e) && e.includes('gpt-5.4')),
      `expected Codex model drift error, got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      errors.some(e => /model_reasoning_effort must match adapters\.codex\.roleSettings\.engineer\.reasoningEffort/.test(e) && e.includes('xhigh')),
      `expected Codex reasoning-effort drift error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex artifacts contain legacy unverified npx event logging fallback wording', () => {
    const d = makeTarget('adapter-aware-codex-legacy-event-logging');
    writeCodexAdapterOutput(d);

    const tomlPath = join(d, '.codex', 'agents', 'orchestrator.toml');
    writeFileSync(
      tomlPath,
      readFileSync(tomlPath, 'utf-8') +
        '\n# stale\nlegacy = "use `npx agenticloop` when no command is configured"\n',
      'utf-8'
    );

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes('orchestrator.toml') && e.includes('legacy npx event logging fallback')),
      `expected legacy TOML fallback error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex backend reference files are missing', () => {
    const d = makeTarget('adapter-aware-codex-missing-backends');
    writeCodexAdapterOutput(d);
    rmSync(
      join(d, '.agents', 'skills', 'agenticloop', 'references', 'backends', 'github.md'),
      { force: true }
    );

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /required backend reference missing/.test(e) && e.includes('references/backends/github.md')),
      `expected missing Codex backend reference error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex artifacts contain dangling bare backend paths', () => {
    const d = makeTarget('adapter-aware-codex-dangling-backends');
    writeCodexAdapterOutput(d);

    const tomlPath = join(d, '.codex', 'agents', 'orchestrator.toml');
    writeFileSync(
      tomlPath,
      `${readFileSync(tomlPath, 'utf-8')}\nlegacy_backend = "backends/github.md"\n`,
      'utf-8'
    );

    const backendReadmePath = join(
      d,
      '.agents',
      'skills',
      'agenticloop',
      'references',
      'backends',
      'README.md'
    );
    writeFileSync(
      backendReadmePath,
      `${readFileSync(backendReadmePath, 'utf-8')}\nSee \`agenticloop/backends/files.md\`.\n`,
      'utf-8'
    );

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes('orchestrator.toml') && /dangling bare backend path/.test(e)),
      `expected dangling backend path error in TOML, got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      errors.some(e => e.includes('references/backends/README.md') && /dangling bare backend path/.test(e)),
      `expected dangling backend path error in generated backend docs, got: ${JSON.stringify(errors)}`
    );
  });

  it('does not warn when Codex event logging is enabled without a command', () => {
    const d = makeTarget('adapter-aware-codex-event-command-warning');
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'event_logging: enabled',
      'event_logging_command: ""',
    ]);
    writeCodexAdapterOutput(d);

    const { warnings } = validateConfig(d, { adapters: ['codex'] });
    assert.ok(
      !warnings.some(w => /Codex event logging: project\.md has event_logging: enabled/.test(w)),
      `unexpected Codex blank event_logging_command warning: ${JSON.stringify(warnings)}`
    );
  });

  it('errors when the repo-local Codex public skill is missing', () => {
    const d = makeTarget('adapter-aware-codex-missing-start');
    writeCodexAdapterOutput(d);
    rmSync(join(d, '.agents', 'skills', 'agenticloop'), { recursive: true, force: true });

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /agenticloop\/SKILL\.md/.test(e)),
      `expected missing start skill error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when legacy discoverable Codex skills are still present', () => {
    const d = makeTarget('adapter-aware-codex-legacy-skills');
    writeCodexAdapterOutput(d);

    mkdirSync(join(d, '.agents', 'skills', 'agenticloop-start'), { recursive: true });
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop-role-delegation'), { recursive: true });
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop-start', 'SKILL.md'), '# legacy\n', 'utf-8');
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop-role-delegation', 'SKILL.md'), '# legacy\n', 'utf-8');

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /legacy discoverable Codex skill output is not allowed/.test(e) && e.includes('agenticloop-start')),
      `expected legacy start skill error, got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      errors.some(e => /legacy discoverable Codex skill output is not allowed/.test(e) && e.includes('agenticloop-role-delegation')),
      `expected legacy copied skill error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex agent TOML lacks methodology wiring', () => {
    const d = makeTarget('adapter-aware-codex-missing-methodology');
    writeCodexAdapterOutput(d);
    writeFileSync(join(d, '.codex', 'agents', 'engineer.toml'), [
      'name = "engineer"',
      'description = "Engineer"',
      'developer_instructions = "raw role body only"',
      '',
    ].join('\n'), 'utf-8');

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /developer_instructions is missing required methodology text/.test(e) && e.includes('engineer.toml')),
      `expected methodology wiring error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex TOML uses unsupported model_reasoning_effort', () => {
    const d = makeTarget('adapter-aware-codex-auto-effort');
    writeCodexAdapterOutput(d);
    const engineerTomlPath = join(d, '.codex', 'agents', 'engineer.toml');
    const engineerToml = readFileSync(engineerTomlPath, 'utf-8').replace(
      'model_reasoning_effort = "xhigh"',
      'model_reasoning_effort = "auto"'
    );
    writeFileSync(engineerTomlPath, engineerToml, 'utf-8');

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /model_reasoning_effort must be omitted or one of: minimal, low, medium, high, xhigh/.test(e)),
      `expected unsupported TOML reasoning effort error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex plugin skills pointer is not ./skills/', () => {
    const d = makeTarget('adapter-aware-codex-plugin-skill-path');
    writeCodexAdapterOutput(d, { pluginEnabled: true });
    writeFileSync(
      join(d, 'plugins', 'agenticloop', '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'agenticloop', version: '0.1.0', description: 'bad', skills: './bad/' }, null, 2) + '\n',
      'utf-8'
    );

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /Codex plugin: 'skills' must point to '\.\/skills\/'/.test(e)),
      `expected plugin skills pointer error, got: ${JSON.stringify(errors)}`
    );
  });

  it('validates generated Codex plugin mode output', () => {
    const d = makeTarget('adapter-aware-codex-plugin-valid');
    writeCodexAdapterOutput(d, { pluginEnabled: true });

    const { errors } = validateConfig(d, { adapters: ['codex'] });
    const codexErrors = errors.filter(e => /Codex/.test(e) || /\.codex|\.agents\/skills|plugins\/agenticloop/.test(e));
    assert.deepEqual(codexErrors, [],
      `expected no Codex plugin mode validation errors, got: ${JSON.stringify(codexErrors)}`);
  });

  it('errors when Codex plugin mode is enabled without a marketplace entry', () => {
    const d = makeTarget('adapter-aware-codex-plugin-marketplace');
    writeCodexAdapterOutput(d, { pluginEnabled: true });
    rmSync(join(d, '.agents', 'plugins', 'marketplace.json'), { force: true });

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /marketplace entry '.agents\/plugins\/marketplace\.json' not found/.test(e)),
      `expected missing marketplace error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Codex plugin marketplace uses the legacy flat entry shape', () => {
    const d = makeTarget('adapter-aware-codex-plugin-legacy-marketplace');
    writeCodexAdapterOutput(d, { pluginEnabled: true });
    writeFileSync(
      join(d, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'agenticloop-local',
        plugins: [
          {
            name: 'agenticloop',
            source: './plugins/agenticloop',
            category: 'workflow',
            installation_policy: 'optional',
            authentication_policy: 'none',
          },
        ],
      }, null, 2) + '\n',
      'utf-8'
    );

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /marketplace entry source must be an object/.test(e)),
      `expected marketplace source object error, got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      errors.some(e => /marketplace entry must include a policy object/.test(e)),
      `expected marketplace policy object error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors on missing Codex agent files when .codex/agents/ exists', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-codex-missing-'));
    seedTargetLayout(REPO_ROOT, d);
    mkdirSync(join(d, '.codex', 'agents'), { recursive: true });
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop', 'agents'), { recursive: true });
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop', 'references', 'skills', 'role-delegation'), { recursive: true });
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop', 'references', 'skills', 'task-record-contract'), { recursive: true });
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop', 'references', 'skills', 'setup-agenticloop'), { recursive: true });
    mkdirSync(join(d, '.agents', 'skills', 'agenticloop', 'references', 'skills', 'blocked-state'), { recursive: true });
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop', 'SKILL.md'), [
      '---',
      'name: "agenticloop"',
      `description: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`,
      '---',
      '',
      'Read `.agenticloop/project.md` first.',
      'Create or refine the durable task record before any implementation.',
      'Codex custom agent `maintainer`',
      'Codex custom agent `engineer`',
      '`role.invoked`',
      '',
    ].join('\n'));
    writeFileSync(join(d, '.agents', 'skills', 'agenticloop', 'agents', 'openai.yaml'), [
      'interface:',
      '  display_name: "Agentic Loop"',
      `  short_description: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`,
      `  default_prompt: "${AGENTIC_LOOP_OPERATION_DESCRIPTION}"`,
      '',
    ].join('\n'));
    for (const skillName of ['role-delegation', 'task-record-contract', 'setup-agenticloop', 'blocked-state']) {
      writeFileSync(
        join(d, '.agents', 'skills', 'agenticloop', 'references', 'skills', skillName, 'reference.md'),
        `${skillName}\n`,
        'utf-8'
      );
    }
    // only orchestrator; missing maintainer/engineer

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => /expected agent file missing/.test(e) && e.includes('maintainer')),
      `expected missing maintainer error, got: ${JSON.stringify(errors)}`);
    assert.ok(errors.some(e => /expected agent file missing/.test(e) && e.includes('engineer')),
      `expected missing engineer error, got: ${JSON.stringify(errors)}`);
  });

  it('does not require Codex output when it is absent and adapter is experimental', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-codex-absent-'));
    seedTargetLayout(REPO_ROOT, d);
    // No .codex/agents/ present. Codex adapter is experimental in the base.

    const { errors } = validateConfig(d);
    const codexErrors = errors.filter(e => /Codex adapter/.test(e));
    assert.deepEqual(codexErrors, [],
      `expected no codex errors when output is absent and adapter is experimental, got: ${JSON.stringify(codexErrors)}`);
  });

  it('forces Codex validation when --adapter codex is passed', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-codex-forced-'));
    seedTargetLayout(REPO_ROOT, d);
    // No Codex output. Forcing the adapter should report a missing output error.

    const { errors } = validateConfig(d, { adapters: ['codex'] });
    assert.ok(errors.some(e => /Codex adapter: \.codex\/agents\//.test(e)),
      `expected forced codex validation to fail, got: ${JSON.stringify(errors)}`);
  });

  it('validates generated Claude Code output without adapter errors', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-cc-'));
    seedTargetLayout(REPO_ROOT, d);

    const cfg = loadAgenticLoopConfig(join(d, 'agenticloop.json'));
    generateClaudeCodeArtifacts(cfg, d, d);

    const { errors } = validateConfig(d);
    const ccErrors = errors.filter(e => /Claude Code adapter/.test(e) || /\.claude\/skills\/agenticloop/.test(e));
    assert.deepEqual(ccErrors, [],
      `expected no claude code adapter errors with a complete output, got: ${JSON.stringify(ccErrors)}`);
  });

  it('errors when the repo-local Claude Code activation command is missing', () => {
    const d = makeTarget('adapter-aware-cc-command-path');
    const cfg = loadAgenticLoopConfig(join(d, 'agenticloop.json'));
    generateClaudeCodeArtifacts(cfg, d, d);
    rmSync(join(d, '.claude', 'commands', 'agenticloop.md'), { force: true });

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /\.claude\/commands\/agenticloop\.md/.test(e)),
      `expected repo-local Claude Code command error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when internal references keep a discoverable nested SKILL.md', () => {
    const d = makeTarget('adapter-aware-cc-nested-skill');
    const cfg = loadAgenticLoopConfig(join(d, 'agenticloop.json'));
    generateClaudeCodeArtifacts(cfg, d, d);
    // Simulate a stale/legacy discoverable nested skill copy.
    const nestedDir = join(d, '.claude', 'skills', 'agenticloop', 'role-delegation');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'SKILL.md'), '---\nname: role-delegation\n---\n\nstale\n');

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /internal references must not contain discoverable SKILL\.md/.test(e)),
      `expected nested SKILL.md error, got: ${JSON.stringify(errors)}`
    );
  });

  it('forces Claude Code command validation when --adapter claude-code is passed', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-cc-forced-'));
    seedTargetLayout(REPO_ROOT, d);

    const { errors } = validateConfig(d, { adapters: ['claude-code'] });
    assert.ok(
      errors.some(e => /\.claude\/commands\/agenticloop\.md/.test(e)),
      `expected forced claude-code validation to require the repo-local command, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Claude Code skill copies are missing the agenticloop namespace', () => {
    const d = makeTarget('adapter-aware-cc-skill-path');
    const ccAgents = join(d, '.claude', 'agents');
    mkdirSync(ccAgents, { recursive: true });
    for (const role of ['orchestrator', 'maintainer', 'engineer']) {
      writeFileSync(join(ccAgents, `${role}.md`), `---\nname: ${role}\n---\n\n# ${role}\n`);
    }
    mkdirSync(join(d, '.claude', 'skills', 'project-owned'), { recursive: true });

    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => /\.claude\/skills\/agenticloop\//.test(e)),
      `expected namespaced Claude Code skills directory error, got: ${JSON.stringify(errors)}`
    );
  });

  it('validates generated Copilot output without adapter errors', () => {
    const d = makeTarget('adapter-aware-copilot-valid');
    writeCopilotAdapterOutput(d);

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    const copilotErrors = errors.filter(e => /Copilot adapter|\.github\/(agents|skills|prompts)\//.test(e));
    assert.deepEqual(copilotErrors, [],
      `expected no copilot adapter errors with a complete output, got: ${JSON.stringify(copilotErrors)}`);
    assert.ok(
      !errors.some(e => /copilot-instructions\.md/.test(e)),
      `did not expect .github/copilot-instructions.md to be required, got: ${JSON.stringify(errors)}`
    );
  });

  it('does not require Copilot output when it is absent and adapter is experimental', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-copilot-absent-'));
    seedTargetLayout(REPO_ROOT, d);

    const { errors } = validateConfig(d);
    const copilotErrors = errors.filter(e => /Copilot adapter/.test(e));
    assert.deepEqual(copilotErrors, [],
      `expected no copilot errors when output is absent and adapter is experimental, got: ${JSON.stringify(copilotErrors)}`);
  });

  it('forces Copilot validation when --adapter copilot is passed', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-copilot-forced-'));
    seedTargetLayout(REPO_ROOT, d);

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /Copilot adapter: \.github\/agents\//.test(e)),
      `expected forced copilot validation to fail, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when the generated Copilot prompt file is missing', () => {
    const d = makeTarget('adapter-aware-copilot-missing-prompt');
    writeCopilotAdapterOutput(d);
    rmSync(join(d, '.github', 'prompts', 'agenticloop.prompt.md'), { force: true });

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /\.github\/prompts\/agenticloop\.prompt\.md/.test(e)),
      `expected missing Copilot prompt error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when the generated Copilot public skill can auto-trigger', () => {
    const d = makeTarget('adapter-aware-copilot-public-skill-auto');
    writeCopilotAdapterOutput(d);
    const skillPath = join(d, '.github', 'skills', 'agenticloop', 'SKILL.md');
    writeFileSync(
      skillPath,
      readFileSync(skillPath, 'utf-8').replace(
        'disable-model-invocation: true',
        'disable-model-invocation: false'
      ),
      'utf-8'
    );

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /\.github\/skills\/agenticloop\/SKILL\.md/.test(e) && /disable-model-invocation must be true/.test(e)),
      `expected public skill manual-activation error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Copilot worker agents are hidden from subagent invocation', () => {
    const d = makeTarget('adapter-aware-copilot-worker-invoke');
    writeCopilotAdapterOutput(d);
    const maintainerPath = join(d, '.github', 'agents', 'maintainer.agent.md');
    writeFileSync(
      maintainerPath,
      readFileSync(maintainerPath, 'utf-8').replace(
        'disable-model-invocation: false',
        'disable-model-invocation: true'
      ),
      'utf-8'
    );

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /maintainer\.agent\.md/.test(e) && /disable-model-invocation: false/.test(e)),
      `expected worker invocation-frontmatter error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Copilot worker agents are left user-selectable', () => {
    const d = makeTarget('adapter-aware-copilot-worker-picker');
    writeCopilotAdapterOutput(d);
    const engineerPath = join(d, '.github', 'agents', 'engineer.agent.md');
    writeFileSync(
      engineerPath,
      readFileSync(engineerPath, 'utf-8').replace(
        'user-invocable: false',
        'user-invocable: true'
      ),
      'utf-8'
    );

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /engineer\.agent\.md/.test(e) && /user-invocable: false/.test(e)),
      `expected worker picker-visibility error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when the Copilot orchestrator omits the worker-agent allow-list', () => {
    const d = makeTarget('adapter-aware-copilot-agents-allowlist');
    writeCopilotAdapterOutput(d);
    const orchestratorPath = join(d, '.github', 'agents', 'orchestrator.agent.md');
    writeFileSync(
      orchestratorPath,
      readFileSync(orchestratorPath, 'utf-8').replace(
        'agents:\n  - "maintainer"\n  - "engineer"\n',
        ''
      ),
      'utf-8'
    );

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /orchestrator\.agent\.md/.test(e) && /agents must explicitly allow the Copilot worker agents/.test(e)),
      `expected orchestrator allow-list error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when the Copilot orchestrator loses the agent tool required for subagent routing', () => {
    const d = makeTarget('adapter-aware-copilot-agent-tool');
    writeCopilotAdapterOutput(d);
    const orchestratorPath = join(d, '.github', 'agents', 'orchestrator.agent.md');
    writeFileSync(
      orchestratorPath,
      readFileSync(orchestratorPath, 'utf-8').replace(
        'tools:\n  - "agent"\n  - "execute"\n  - "read"\n  - "search"',
        'tools:\n  - "execute"\n  - "read"\n  - "search"'
      ),
      'utf-8'
    );

    const { errors } = validateConfig(d, { adapters: ['copilot'] });
    assert.ok(
      errors.some(e => /orchestrator\.agent\.md/.test(e) && /tools must match the generated Copilot orchestrator tool list/.test(e)),
      `expected orchestrator tools error, got: ${JSON.stringify(errors)}`
    );
  });

  it('validates generated Cursor output without adapter errors', () => {
    const d = makeTarget('adapter-aware-cursor-valid');
    writeCursorAdapterOutput(d);

    const { errors } = validateConfig(d, { adapters: ['cursor'] });
    const cursorErrors = errors.filter(e => /Cursor adapter|\.cursor\/(agents|skills)\//.test(e));
    assert.deepEqual(cursorErrors, [],
      `expected no cursor adapter errors with a complete output, got: ${JSON.stringify(cursorErrors)}`);
  });

  it('does not require Cursor output when it is absent and adapter is experimental', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-cursor-absent-'));
    seedTargetLayout(REPO_ROOT, d);

    const { errors } = validateConfig(d);
    const cursorErrors = errors.filter(e => /Cursor adapter/.test(e));
    assert.deepEqual(cursorErrors, [],
      `expected no cursor errors when output is absent and adapter is experimental, got: ${JSON.stringify(cursorErrors)}`);
  });

  it('forces Cursor validation when --adapter cursor is passed', () => {
    const d = mkdtempSync(join(tmpDir, 'adapter-aware-cursor-forced-'));
    seedTargetLayout(REPO_ROOT, d);

    const { errors } = validateConfig(d, { adapters: ['cursor'] });
    assert.ok(
      errors.some(e => /Cursor adapter: \.cursor\/agents\//.test(e)),
      `expected forced cursor validation to fail, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when the Cursor public skill is missing', () => {
    const d = makeTarget('adapter-aware-cursor-missing-skill');
    writeCursorAdapterOutput(d);
    rmSync(join(d, '.cursor', 'skills', 'agenticloop'), { recursive: true, force: true });

    const { errors } = validateConfig(d, { adapters: ['cursor'] });
    assert.ok(
      errors.some(e => /\.cursor\/skills\/agenticloop\/SKILL\.md/.test(e)),
      `expected missing Cursor public skill error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when Cursor internal references keep a discoverable nested SKILL.md', () => {
    const d = makeTarget('adapter-aware-cursor-nested-skill');
    writeCursorAdapterOutput(d);
    const nestedDir = join(d, '.cursor', 'skills', 'agenticloop', 'references', 'skills', 'role-delegation', 'nested');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'SKILL.md'), '---\nname: role-delegation\n---\n\nstale\n');

    const { errors } = validateConfig(d, { adapters: ['cursor'] });
    assert.ok(
      errors.some(e => /internal references must not contain discoverable SKILL\.md/.test(e) && e.includes('.cursor/skills/agenticloop')),
      `expected nested Cursor SKILL.md error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when a generated Cursor role agent is missing', () => {
    const d = makeTarget('adapter-aware-cursor-missing-agent');
    writeCursorAdapterOutput(d);
    rmSync(join(d, '.cursor', 'agents', 'engineer.md'), { force: true });

    const { errors } = validateConfig(d, { adapters: ['cursor'] });
    assert.ok(
      errors.some(e => /expected agent file missing/.test(e) && e.includes('.cursor/agents/engineer.md')),
      `expected missing Cursor agent error, got: ${JSON.stringify(errors)}`
    );
  });

  it('errors when a generated Cursor agent model drifts from adapters.cursor.roleSettings', () => {
    const d = makeTarget('adapter-aware-cursor-model-drift');
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    cfg.adapters.cursor = {
      roleSettings: {
        engineer: { model: 'gpt-5.5' },
      },
    };
    writeFileSync(join(d, 'agenticloop.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    writeCursorAdapterOutput(d);

    const engineerPath = join(d, '.cursor', 'agents', 'engineer.md');
    writeFileSync(
      engineerPath,
      readFileSync(engineerPath, 'utf-8').replace('model: "gpt-5.5"', 'model: "gpt-5.5-mini"'),
      'utf-8'
    );

    const { errors } = validateConfig(d, { adapters: ['cursor'] });
    assert.ok(
      errors.some(e => e.includes('.cursor/agents/engineer.md') && e.includes('adapters.cursor.roleSettings.engineer.model')),
      `expected Cursor model drift error, got: ${JSON.stringify(errors)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Files-first validation (project.md only, no agenticloop.json)
// ---------------------------------------------------------------------------

describe('Files-first validation with project.md only', () => {
  it('missing agenticloop.json is not an error when project.md exists', () => {
    const d = mkdtempSync(join(tmpDir, 'files-first-'));
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
      '---',
      '# Project Map',
    ].join('\n'));
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { errors } = validateConfig(d);
    const jsonErrors = errors.filter(e => /agenticloop\.json not found/.test(e));
    assert.deepEqual(jsonErrors, [],
      `missing agenticloop.json must not be an error when project.md exists, got: ${JSON.stringify(jsonErrors)}`);
  });

  it('files-first target with no GitHub evidence remains valid', () => {
    const d = mkdtempSync(join(tmpDir, 'files-first-no-github-'));
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { errors, warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it('warns when project.md keeps files despite strong GitHub workflow evidence', () => {
    const d = mkdtempSync(join(tmpDir, 'files-first-github-evidence-'));
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({
        labelNames: [
          'agent-ready',
          'blocked',
          'approved',
          'type:impl',
          'type:change-request',
          'task:P6-FU-1',
        ],
        issueTitles: ['P3-10-FU-1 Implement checkout flow'],
      }),
    });

    assert.ok(
      warnings.some(w => /bounded GitHub backend evidence/.test(w) && w.includes('task labels already exist') && w.includes('issue title prefixes already exist')),
      `expected GitHub evidence warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('warns when project.md task_id_regex rejects observed GitHub task ids', () => {
    const d = mkdtempSync(join(tmpDir, 'files-first-task-id-warning-'));
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({
        labelNames: ['agent-ready', 'blocked', 'approved', 'task:P6-FU-1'],
      }),
    });

    assert.ok(
      warnings.some(w => /task_id_regex/.test(w) && w.includes('P6-FU-1')),
      `expected task_id_regex warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('warns with exact missing labels when github backend labels are incomplete', () => {
    const d = mkdtempSync(join(tmpDir, 'files-first-github-missing-labels-'));
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: github',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    writeBackendProjection(d, 'github');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({
        labelNames: ['agent-ready', 'blocked'],
      }),
    });

    assert.ok(
      warnings.some(w => /required GitHub labels are missing/.test(w) && w.includes('approved') && w.includes('type:impl') && w.includes('type:change-request')),
      `expected missing-label warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('warns when neither project.md nor agenticloop.json exists', () => {
    const d = mkdtempSync(join(tmpDir, 'no-config-'));
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { warnings } = validateConfig(d);
    assert.ok(
      warnings.some(w => /agenticloop init/.test(w)),
      `expected setup warning when neither config exists, got: ${JSON.stringify(warnings)}`
    );
  });

  it('validates project.md frontmatter and reports errors', () => {
    const d = mkdtempSync(join(tmpDir, 'bad-project-map-'));
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: invalid',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
      '---',
    ].join('\n'));
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => /task_backend/.test(e)),
      `expected task_backend error, got: ${JSON.stringify(errors)}`);
  });

  it('reports project.md setup_status errors when the field is missing', () => {
    const d = mkdtempSync(join(tmpDir, 'missing-setup-status-'));
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), [
      '---',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
      '---',
    ].join('\n'));
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => /setup_status is required/.test(e)),
      `expected setup_status missing error, got: ${JSON.stringify(errors)}`);
  });

  it('reports project.md setup_status errors when the value is invalid', () => {
    const d = mkdtempSync(join(tmpDir, 'invalid-setup-status-'));
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: pending',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
      '---',
    ].join('\n'));
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => /setup_status must be 'unconfirmed' or 'confirmed'/.test(e)),
      `expected setup_status invalid error, got: ${JSON.stringify(errors)}`);
  });

  it('validates task_file_template must include {taskId}', () => {
    const d = mkdtempSync(join(tmpDir, 'missing-taskid-'));
    mkdirSync(join(d, '.agenticloop'), { recursive: true });
    writeFileSync(join(d, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/task.md"',
      'grouping_profile: flat',
      '---',
    ].join('\n'));
    writeBackendProjection(d, 'files');
    mkdirSync(join(d, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(d, '.gitignore'), '.agenticloop/tmp/\n');

    const { errors } = validateConfig(d);
    assert.ok(errors.some(e => /task_file_template/.test(e) && /taskId/.test(e)),
      `expected task_file_template error, got: ${JSON.stringify(errors)}`);
  });

  it('errors when confirmed project.md backend disagrees with agenticloop.json', () => {
    const d = makeTarget('confirmed-backend-mismatch', {
      'agenticloop.json': [
        '{',
        '  "extends": "./agenticloop/config.json",',
        '  "taskBackend": "files"',
        '}',
      ].join('\n'),
    });
    rmSync(join(d, '.opencode'), { recursive: true, force: true });
    writeProjectMap(d, [
      'setup_status: confirmed',
      'setup_confirmed_at: "2026-06-16"',
      'setup_confirmed_by: "maintainer"',
      'task_backend: github',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);

    const { errors, warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });

    assert.ok(
      errors.some(e => /project\.md task_backend/.test(e) && e.includes("legacy agenticloop.json taskBackend ('files')") && e.includes('backend source of truth')),
      `expected confirmed-backend mismatch error, got: ${JSON.stringify(errors)}`
    );
    assert.ok(
      !warnings.some(w => /project\.md task_backend/.test(w)),
      `confirmed-backend mismatch should be an error, got warnings: ${JSON.stringify(warnings)}`
    );
  });

  it('warns when unconfirmed project.md backend disagrees with legacy agenticloop.json', () => {
    const d = makeTarget('unconfirmed-backend-mismatch', {
      'agenticloop.json': [
        '{',
        '  "extends": "./agenticloop/config.json",',
        '  "taskBackend": "files"',
        '}',
      ].join('\n'),
    });
    rmSync(join(d, '.opencode'), { recursive: true, force: true });
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: github',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);

    const { errors, warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });

    assert.ok(
      warnings.some(w => /project\.md task_backend/.test(w) && w.includes("legacy agenticloop.json taskBackend ('files')") && w.includes('backend source of truth')),
      `expected unconfirmed-backend mismatch warning, got: ${JSON.stringify(warnings)}`
    );
    assert.ok(
      !errors.some(e => /project\.md task_backend/.test(e)),
      `unconfirmed-backend mismatch should not be an error, got: ${JSON.stringify(errors)}`
    );
  });

  it('warns when project.md exists and matching taskBackend remains in agenticloop.json', () => {
    const d = makeTarget('matching-legacy-selector', {
      'agenticloop.json': [
        '{',
        '  "extends": "./agenticloop/config.json",',
        '  "taskBackend": "files"',
        '}',
      ].join('\n'),
    });
    rmSync(join(d, '.opencode'), { recursive: true, force: true });
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);

    const { errors, warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });

    assert.deepEqual(errors, []);
    assert.ok(
      warnings.some(w => /taskBackend is legacy/.test(w) && w.includes('backend source of truth')),
      `expected legacy-selector warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('warns when project.md is missing and legacy agenticloop.json taskBackend is used', () => {
    const d = makeTarget('legacy-json-fallback', {
      'agenticloop.json': [
        '{',
        '  "extends": "./agenticloop/config.json",',
        '  "taskBackend": "github"',
        '}',
      ].join('\n'),
    });
    rmSync(join(d, '.opencode'), { recursive: true, force: true });

    const { errors, warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });

    assert.deepEqual(errors, []);
    assert.ok(
      warnings.some(w => /legacy fallback/.test(w) && w.includes('.agenticloop/project.md')),
      `expected legacy-fallback warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('legacy JSON-only github selector still runs GitHub label checks', () => {
    const d = makeTarget('legacy-json-github-label-check', {
      'agenticloop.json': [
        '{',
        '  "extends": "./agenticloop/config.json",',
        '  "taskBackend": "github"',
        '}',
      ].join('\n'),
    });

    const { warnings } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({
        labelNames: ['agent-ready', 'blocked'],
      }),
    });

    assert.ok(
      warnings.some(w => /required GitHub labels are missing/.test(w)),
      `expected GitHub label checks to run for legacy selector, got: ${JSON.stringify(warnings)}`
    );
  });

  it('validates backend projection against the resolved backend', () => {
    const d = makeTarget('resolved-backend-projection', {
      'agenticloop.json': [
        '{',
        '  "extends": "./agenticloop/config.json",',
        '  "taskBackend": "files"',
        '}',
      ].join('\n'),
    });
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: github',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    rmSync(join(d, 'agenticloop', 'backends', 'github.md'), { force: true });

    const { errors } = validateConfig(d, {
      commandRunner: githubEvidenceRunner({ remote: null }),
    });

    assert.ok(
      errors.some(e => /active task backend 'github'/.test(e) && e.includes('agenticloop/backends/github.md')),
      `expected resolved-backend projection error, got: ${JSON.stringify(errors)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Task ID regex validation
// ---------------------------------------------------------------------------

describe('Task ID regex validation', () => {
  it('task ID T-001 is accepted by default regex', () => {
    const regex = '^T-\\d{3,}$';
    assert.ok(new RegExp(regex).test('T-001'), 'T-001 should be valid');
    assert.ok(new RegExp(regex).test('T-120'), 'T-120 should be valid');
  });

  it('task ID P1-01 is rejected by default regex', () => {
    const regex = '^T-\\d{3,}$';
    assert.ok(!new RegExp(regex).test('P1-01'), 'P1-01 should be invalid by default');
    assert.ok(!new RegExp(regex).test('T-01'), 'T-01 should be invalid (not three digits)');
  });

  it('phase-style task IDs remain valid when a phase regex is configured', () => {
    const regex = '^P\\d+-\\d{2,}$';
    assert.ok(new RegExp(regex).test('P1-01'), 'P1-01 should be valid when configured');
    assert.ok(!new RegExp(regex).test('P1-1'), 'P1-1 should still be invalid');
  });
});

// ---------------------------------------------------------------------------
// Field-finding fixes: dotted toolkit path warnings
// ---------------------------------------------------------------------------

describe('dotted toolkit path warnings', () => {
  it('warns when .agenticloop/tasks/ file references .agenticloop/agents/', () => {
    const d = mkdtempSync(join(tmpDir, 'dotpath-'));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), [
      '---',
      'task_id: T-001',
      'status: draft',
      'backend: files',
      '---',
      '## Task',
      '## Source Documents Reviewed',
      '## Current State',
      '## Scope',
      'Read .agenticloop/agents/engineer.md for the role.',
      '## Out of Scope',
      '## Acceptance Criteria',
      '## Required Checks',
      '## Expected Files or Areas',
      '## Implementation Notes',
      '## Completion Summary Template',
      'Summary here.',
      '## Reviewer Checklist',
      '- [ ] Scope verified.',
    ].join('\n'));
    const { warnings } = validateConfig(d);
    assert.ok(
      warnings.some(w => w.includes('dotted toolkit path') && w.includes('T-001.md')),
      `expected dotted toolkit path warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('does not warn when paths use correct agenticloop/ prefix', () => {
    const d = mkdtempSync(join(tmpDir, 'goodpath-'));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), [
      '---',
      'task_id: T-001',
      'status: draft',
      'backend: files',
      '---',
      '## Task',
      '## Source Documents Reviewed',
      '## Current State',
      '## Scope',
      'Read agenticloop/agents/engineer.md for the role.',
      '## Out of Scope',
      '## Acceptance Criteria',
      '## Required Checks',
      '## Expected Files or Areas',
      '## Implementation Notes',
      '## Completion Summary Template',
      'Summary here.',
      '## Reviewer Checklist',
      '- [ ] Scope verified.',
    ].join('\n'));
    const { warnings } = validateConfig(d);
    assert.ok(
      !warnings.some(w => w.includes('dotted toolkit path') && w.includes('T-001.md')),
      `should not warn about correct paths, got: ${JSON.stringify(warnings)}`
    );
  });

  it('warns when a task file references a Windows-style .agenticloop\\agents path', () => {
    const d = mkdtempSync(join(tmpDir, 'dotpath-backslash-'));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), [
      '---',
      'task_id: T-001',
      'status: draft',
      'backend: files',
      '---',
      '## Task',
      '## Source Documents Reviewed',
      '## Current State',
      '## Scope',
      'Read .agenticloop\\agents\\engineer.md for the role.',
      '## Out of Scope',
      '## Acceptance Criteria',
      '## Required Checks',
      '## Expected Files or Areas',
      '## Implementation Notes',
      '## Completion Summary Template',
      'Summary here.',
      '## Reviewer Checklist',
      '- [ ] Scope verified.',
    ].join('\n'));
    const { warnings } = validateConfig(d);
    assert.ok(
      warnings.some(w => w.includes('dotted toolkit path') && w.includes('T-001.md')),
      `expected backslash dotted toolkit path warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('warns when project.md references a Windows-style .agenticloop\\skills path', () => {
    const d = mkdtempSync(join(tmpDir, 'dotpath-project-backslash-'));
    seedTargetLayout(REPO_ROOT, d);
    writeProjectMap(d, [
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
    ]);
    const projectPath = join(d, '.agenticloop', 'project.md');
    writeFileSync(
      projectPath,
      readFileSync(projectPath, 'utf-8') + '\nSee .agenticloop\\skills\\role-delegation for rules.\n'
    );
    const { warnings } = validateConfig(d);
    assert.ok(
      warnings.some(w => w.includes('dotted toolkit path') && w.includes('project.md')),
      `expected backslash project.md dotted toolkit path warning, got: ${JSON.stringify(warnings)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Field-finding fixes: files-backend PR/merge guard
// ---------------------------------------------------------------------------

describe('files-backend PR/merge guard', () => {
  it('errors when a files-backend task claims agent opened a PR', () => {
    const d = mkdtempSync(join(tmpDir, 'prguard-'));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), [
      '---',
      'task_id: T-001',
      'status: accepted',
      'backend: files',
      'implementation_artifact: branch:main',
      '---',
      '## Task',
      '## Source Documents Reviewed',
      '## Current State',
      '## Scope',
      'The engineer opened a pull request for the changes.',
      '## Out of Scope',
      '## Acceptance Criteria',
      '## Required Checks',
      '## Expected Files or Areas',
      '## Implementation Notes',
      '## Completion Summary Template',
      'Summary here.',
      '## Reviewer Checklist',
      '- [ ] Scope verified.',
      '## Scope Completed',
      'Done.',
      '## Artifacts',
      'branch:main',
      '## Evidence',
      'Tests pass.',
      '## Deviations',
      'None.',
      '## Process Observations',
      'None.',
      '## Known Gaps',
      'None.',
      '## Follow-Ups',
      'None.',
    ].join('\n'));
    const { errors } = validateConfig(d);
    assert.ok(
      errors.some(e => e.includes('PR/merge behavior requires task_backend: github') && e.includes('T-001.md')),
      `expected PR guard error, got: ${JSON.stringify(errors)}`
    );
  });

  it('allows files-backend task that records human-initiated PR', () => {
    const d = mkdtempSync(join(tmpDir, 'prguard-ok-'));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), [
      '---',
      'task_id: T-001',
      'status: accepted',
      'backend: files',
      'implementation_artifact: branch:fix-stuff',
      '---',
      '## Task',
      '## Source Documents Reviewed',
      '## Current State',
      '## Scope',
      'The human opened a pull request outside Agentic Loop.',
      '## Out of Scope',
      '## Acceptance Criteria',
      '## Required Checks',
      '## Expected Files or Areas',
      '## Implementation Notes',
      '## Completion Summary Template',
      'Summary here.',
      '## Reviewer Checklist',
      '- [ ] Scope verified.',
      '## Scope Completed',
      'Done.',
      '## Artifacts',
      'branch:fix-stuff',
      '## Evidence',
      'Tests pass.',
      '## Deviations',
      'None.',
      '## Process Observations',
      'None.',
      '## Known Gaps',
      'None.',
      '## Follow-Ups',
      'None.',
    ].join('\n'));
    const { errors } = validateConfig(d);
    assert.ok(
      !errors.some(e => e.includes('PR/merge behavior requires task_backend: github') && e.includes('T-001.md')),
      `should not error on human-initiated PR, got: ${JSON.stringify(errors)}`
    );
  });

  function seedAcceptedFilesTask(name, scope) {
    const d = mkdtempSync(join(tmpDir, name));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), taskRecord({
      taskId: 'T-001',
      status: 'accepted',
      backend: 'files',
      implementationArtifact: 'branch:work',
      reviewStatus: 'accepted',
      scope,
      scopeCompleted: 'Implemented the scoped change.',
    }));
    return d;
  }

  const GUARD_MESSAGE = 'PR/merge behavior requires task_backend: github';

  for (const scope of [
    'Agent created PR #12.',
    'Agent opened a pull request after implementation.',
    'A human decision was recorded. Agent opened a PR #12.',
    'Agent opened a PR without human approval.',
    'Engineer opened a PR for human review.',
    'Agent opened a PR; no human-approved exception exists.',
    'The agent merged a branch into main.',
    'The engineer submitted a pull request and pushed the PR.',
  ]) {
    it(`errors when a files-backend task claims an agent PR/merge action: "${scope}"`, () => {
      const d = seedAcceptedFilesTask('prguard-err-', scope);
      const { errors } = validateConfig(d);
      assert.ok(
        errors.some(e => e.includes(GUARD_MESSAGE) && e.includes('T-001.md')),
        `expected guard error for "${scope}", got: ${JSON.stringify(errors)}`
      );
    });
  }

  for (const scope of [
    'The human opened a pull request outside Agentic Loop.',
    'The pull request was opened by a human outside Agentic Loop.',
    'Manual human decision outside normal files-backend automation: PR #12.',
  ]) {
    it(`allows a files-backend task with a localized human/manual exception: "${scope}"`, () => {
      const d = seedAcceptedFilesTask('prguard-ok-', scope);
      const { errors } = validateConfig(d);
      assert.ok(
        !errors.some(e => e.includes(GUARD_MESSAGE) && e.includes('T-001.md')),
        `did not expect guard error for "${scope}", got: ${JSON.stringify(errors)}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Inline task summary requirement (no separate summaries store)
// ---------------------------------------------------------------------------

describe('inline task summary requirement', () => {
  it('does not warn about a missing separate work-unit summary for accepted tasks', () => {
    const d = mkdtempSync(join(tmpDir, 'summary-inline-'));
    seedTargetLayout(REPO_ROOT, d);
    const tasksDir = join(d, '.agenticloop', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'T-001.md'), taskRecord({
      taskId: 'T-001',
      status: 'accepted',
      backend: 'files',
      implementationArtifact: 'branch:work',
      reviewStatus: 'accepted',
      scopeCompleted: 'Implemented the scoped change.',
    }));
    const { errors, warnings } = validateConfig(d);
    assert.deepEqual(errors, []);
    assert.ok(
      !warnings.some(w => w.includes('work-unit summary') || w.includes('.agenticloop/summaries')),
      `did not expect any separate-summary warning, got: ${JSON.stringify(warnings)}`
    );
  });
});
