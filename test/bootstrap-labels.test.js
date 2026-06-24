/**
 * Tests for src/bootstrap-labels.js.
 *
 * Covers:
 *   - dry-run produces expected command descriptions without running gh
 *   - standard labels are present in dry-run output
 *   - group and task-id labels are included when specified
 *   - custom label names from agenticloop.json are used
 *   - configured group/task label templates are used
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapLabels } from '../src/bootstrap-labels.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const EXPECTED_STANDARD_NAMES = [
  'agent-ready',
  'blocked',
  'approved',
  'type:impl',
  'type:change-request',
];

describe('bootstrap-labels dry-run', () => {
  it('returns dry-run results for all standard labels', () => {
    const results = bootstrapLabels(null, { dryRun: true });
    const names = results.map(r => r.label);
    for (const expected of EXPECTED_STANDARD_NAMES) {
      assert.ok(names.includes(expected), `expected label '${expected}' in results: ${JSON.stringify(names)}`);
    }
    assert.ok(results.every(r => r.action === 'dry-run'), 'all actions should be dry-run');
  });

  it('includes group label when --group is specified', () => {
    const results = bootstrapLabels(null, { dryRun: true, group: 'D' });
    assert.ok(results.some(r => r.label === 'group:D'));
  });

  it('includes task label when --task-id is specified', () => {
    const results = bootstrapLabels(null, { dryRun: true, taskId: 'D-01' });
    assert.ok(results.some(r => r.label === 'task:D-01'));
  });

  it('uses custom label names from config', () => {
    const config = {
      backends: {
        github: {
          labels: { agentReady: 'ready-for-agent', blocked: 'on-hold' },
        },
      },
    };
    const results = bootstrapLabels(config, { dryRun: true });
    const names = results.map(r => r.label);
    assert.ok(names.includes('ready-for-agent'), 'should use custom agentReady name');
    assert.ok(names.includes('on-hold'), 'should use custom blocked name');
    assert.ok(!names.includes('agent-ready'), 'should not use default name when overridden');
    assert.ok(!names.includes('blocked'), 'should not use default blocked name when overridden');
  });

  it('uses phase-profile default grouping template when project map selects phase grouping', () => {
    const results = bootstrapLabels(null, {
      dryRun: true,
      group: 'D',
      projectMap: { grouping_profile: 'phase', grouping_term: 'Phase' },
    });
    const names = results.map(r => r.label);
    assert.ok(names.includes('phase:D'), 'should use phase label template for phase grouping');
    assert.ok(!names.includes('group:D'), 'phase grouping should not fall back to generic group label');
  });

  it('uses configured group and task label templates', () => {
    const config = {
      backends: {
        github: {
          groupLabelTemplate: 'p/{groupId}',
          taskLabelTemplate: 'work/{taskId}',
        },
      },
    };
    const results = bootstrapLabels(config, { dryRun: true, group: 'D', taskId: 'D-01' });
    const names = results.map(r => r.label);
    assert.ok(names.includes('p/D'), 'should use configured group label template');
    assert.ok(names.includes('work/D-01'), 'should use configured task label template');
    assert.ok(!names.includes('group:D'), 'should not create default group label when overridden');
    assert.ok(!names.includes('task:D-01'), 'should not create default task label when overridden');
  });

  it('uses default names when config has no label overrides', () => {
    const config = { backends: { github: {} } };
    const results = bootstrapLabels(config, { dryRun: true });
    const names = results.map(r => r.label);
    for (const expected of EXPECTED_STANDARD_NAMES) {
      assert.ok(names.includes(expected), `expected default label '${expected}'`);
    }
  });

  it('returns exactly 5 results for standard labels with no extras', () => {
    const results = bootstrapLabels(null, { dryRun: true });
    assert.equal(results.length, 5);
  });

  it('returns 7 results when both group and taskId are specified', () => {
    const results = bootstrapLabels(null, { dryRun: true, group: '1', taskId: 'D-01' });
    assert.equal(results.length, 7);
  });
});

describe('bootstrap-labels CLI config loading', () => {
  it('fails instead of falling back to defaults when an existing config cannot load', () => {
    const d = mkdtempSync(join(tmpdir(), 'al-bootstrap-bad-config-'));
    try {
      writeFileSync(join(d, 'agenticloop.json'), '{"extends":"./missing-base.json"}\n');
      const result = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'bin', 'agenticloop.js'), 'bootstrap-labels', '--target', d, '--dry-run'],
        { cwd: REPO_ROOT, encoding: 'utf-8' }
      );

      assert.notEqual(result.status, 0, 'CLI should fail when target config cannot load');
      assert.match(result.stderr, /Failed to load agenticloop\.json/);
      assert.match(result.stderr, /missing-base\.json/);
      assert.ok(
        !result.stdout.includes('gh label create agent-ready'),
        'CLI should not emit default-label dry-run commands after config load failure'
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('bootstrap-labels existing labels', () => {
  it('treats already-existing labels as ok', () => {
    const calls = [];
    const commandRunner = (command, args) => {
      calls.push({ command, args });
      return {
        status: 1,
        stdout: '',
        stderr: 'HTTP 422: Validation Failed - already exists',
      };
    };

    const results = bootstrapLabels(null, { commandRunner });
    assert.equal(calls.length, 5, 'should attempt the five standard labels');
    assert.ok(results.every(result => result.action === 'existing'));
  });

  it('does not treat unrelated 422 validation failures as existing labels', () => {
    const commandRunner = () => ({
      status: 1,
      stdout: '',
      stderr: 'HTTP 422: Validation Failed - invalid label name',
    });

    const results = bootstrapLabels(null, { commandRunner });
    assert.ok(results.every(result => result.action === 'error'));
    assert.ok(results.every(result => /invalid label name/.test(result.error)));
  });

  it('reports real gh failures as errors', () => {
    const commandRunner = () => ({
      status: 1,
      stdout: '',
      stderr: 'HTTP 404: Not Found',
    });

    const results = bootstrapLabels(null, { commandRunner });
    assert.ok(results.every(result => result.action === 'error'));
    assert.ok(results.every(result => /HTTP 404/.test(result.error)));
  });
});
