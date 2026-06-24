/**
 * Tests for src/setup-state.js.
 *
 * Covers:
 *   - detectSetupState with empty target
 *   - detectSetupState with toolkit-only target
 *   - detectSetupState with confirmed project map
 *   - detectSetupState with adapters and model settings
 *   - nextStepsFromState progression
 *   - formatSetupChecklist output
 *   - Validation issue detection
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedTargetLayout } from './helpers/layout-fixture.js';
import {
  detectSetupState,
  nextStepsFromState,
  formatSetupChecklist,
} from '../src/setup-state.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-setup-state-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEmptyTarget() {
  return mkdtempSync(join(tmpDir, 'target-'));
}

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
// detectSetupState
// ---------------------------------------------------------------------------

describe('detectSetupState', () => {
  it('reports absent state for empty directory', () => {
    const d = makeEmptyTarget();
    const state = detectSetupState(d);

    assert.equal(state.toolkitInstalled, false);
    assert.equal(state.projectMapExists, false);
    assert.equal(state.setupStatus, 'absent');
    assert.equal(state.setupComplete, false);
    assert.equal(state.agenticloopJsonExists, false);
    assert.deepEqual(state.adapters, {});
  });

  it('reports toolkit installed for scaffolded target', () => {
    const d = makeTarget();
    const state = detectSetupState(d);

    assert.equal(state.toolkitInstalled, true);
    assert.equal(state.processDocExists, true);
    assert.equal(state.skillsDirExists, true);
    assert.equal(state.agenticloopJsonExists, true);
  });

  it('detects unconfirmed project map', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'unconfirmed',
      task_backend: 'files',
      grouping_profile: 'flat',
    });
    const state = detectSetupState(d);

    assert.equal(state.projectMapExists, true);
    assert.equal(state.setupStatus, 'unconfirmed');
    assert.equal(state.taskBackend, 'files');
    assert.equal(state.groupingProfile, 'flat');
    assert.equal(state.setupComplete, false);
  });

  it('detects confirmed project map', () => {
    const d = makeTarget();
    writeProjectMap(d, {
      setup_status: 'confirmed',
      setup_confirmed_at: '2026-06-22',
      setup_confirmed_by: 'human',
      task_backend: 'files',
      grouping_profile: 'flat',
    });
    const state = detectSetupState(d);

    assert.equal(state.setupStatus, 'confirmed');
    assert.equal(state.setupComplete, true);
  });

  it('detects configured adapters with model settings', () => {
    const d = makeTarget();
    const state = detectSetupState(d);

    assert.ok(state.adapters.opencode);
    assert.equal(state.adapters.opencode.configured, true);
    assert.equal(state.adapters.opencode.modelsComplete, true);
    assert.deepEqual(state.adapters.opencode.missingModelRoles, []);
  });

  it('detects missing model roles', () => {
    const d = makeTarget({ includeConfig: false });
    writeFileSync(join(d, 'agenticloop.json'), JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: { roleSettings: {} },
      },
    }, null, 2) + '\n');

    const state = detectSetupState(d);

    assert.ok(state.adapters.opencode);
    assert.equal(state.adapters.opencode.modelsComplete, false);
    assert.ok(state.adapters.opencode.missingModelRoles.length > 0);
  });

  it('includes validation issues when requested', () => {
    const d = makeTarget({ includeConfig: false });
    writeFileSync(join(d, 'agenticloop.json'), JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: { roleSettings: {}, enabled: true },
      },
    }, null, 2) + '\n');

    const state = detectSetupState(d, { includeValidation: true });

    assert.ok(Array.isArray(state.validationIssues));
    assert.ok(state.validationIssues.some(i => i.includes('missing model settings')));
  });

  it('does not report inherited base adapters as configured', () => {
    const d = makeTarget({ includeConfig: false });
    // Target config only has opencode, but base config has all adapters
    writeFileSync(join(d, 'agenticloop.json'), JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: {
          roleSettings: {
            orchestrator: { model: 'test/model' },
            maintainer: { model: 'test/model' },
            engineer: { model: 'test/model' },
          },
        },
      },
    }, null, 2) + '\n');

    const state = detectSetupState(d);
    const adapterHosts = Object.keys(state.adapters);

    // Should only contain opencode (explicitly in target config)
    // plus any adapters that have actual generated artifacts
    assert.ok(adapterHosts.includes('opencode'), 'target-selected opencode should be present');

    // Adapters that are only in base config with no artifacts should NOT appear
    for (const host of adapterHosts) {
      if (host === 'opencode') continue;
      const adapter = state.adapters[host];
      assert.ok(adapter.hasArtifacts,
        `adapter ${host} has no artifacts and is not in target config - should not be listed`);
    }
  });

  it('files-only target with no agenticloop.json has no adapters', () => {
    const d = makeTarget({ includeConfig: false });
    const state = detectSetupState(d);
    assert.deepEqual(state.adapters, {});
    assert.equal(state.agenticloopJsonExists, false);
  });

  it('target with only opencode override shows only opencode adapter', () => {
    const d = makeTarget({ includeConfig: false });
    writeFileSync(join(d, 'agenticloop.json'), JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: { roleSettings: {} },
      },
    }, null, 2) + '\n');

    const state = detectSetupState(d);
    const adapterHosts = Object.keys(state.adapters);
    assert.ok(adapterHosts.includes('opencode'));
    // No other adapters should appear unless they have actual artifacts
    for (const host of adapterHosts) {
      if (host === 'opencode') continue;
      assert.ok(state.adapters[host].hasArtifacts,
        `${host} should only appear if it has artifacts`);
    }
  });
});

// ---------------------------------------------------------------------------
// nextStepsFromState
// ---------------------------------------------------------------------------

describe('nextStepsFromState', () => {
  it('recommends init for empty target', () => {
    const state = { toolkitInstalled: false, projectMapExists: false, adapters: {} };
    const steps = nextStepsFromState(state);
    assert.ok(steps[0].includes('init'));
  });

  it('recommends setup for unconfirmed project map', () => {
    const state = {
      toolkitInstalled: true,
      projectMapExists: true,
      setupStatus: 'unconfirmed',
      adapters: {},
      agenticloopJsonExists: false,
    };
    const steps = nextStepsFromState(state);
    assert.ok(steps[0].includes('setup'));
  });

  it('recommends validate (not setup) when setup is confirmed files-only with no adapters', () => {
    const state = {
      toolkitInstalled: true,
      projectMapExists: true,
      setupStatus: 'confirmed',
      adapters: {},
      agenticloopJsonExists: false,
    };
    const steps = nextStepsFromState(state);
    assert.ok(steps.length > 0);
    assert.ok(steps.some(s => s.includes('validate')));
    assert.ok(!steps.some(s => s.includes('setup')));
  });

  it('recommends configure models when adapter has missing models', () => {
    const state = {
      toolkitInstalled: true,
      projectMapExists: true,
      setupStatus: 'confirmed',
      agenticloopJsonExists: true,
      adapters: {
        opencode: {
          required: true,
          hasArtifacts: true,
          modelsComplete: false,
          missingModelRoles: ['engineer'],
        },
      },
    };
    const steps = nextStepsFromState(state);
    assert.ok(steps.some(s => s.includes('configure models')));
  });
});

// ---------------------------------------------------------------------------
// formatSetupChecklist
// ---------------------------------------------------------------------------

describe('formatSetupChecklist', () => {
  it('returns formatted text with check marks', () => {
    const state = {
      toolkitInstalled: true,
      projectMapExists: true,
      setupStatus: 'confirmed',
      taskBackend: 'files',
      groupingProfile: 'flat',
      agenticloopJsonExists: true,
      adapters: {
        opencode: {
          required: false,
          hasArtifacts: true,
          modelsComplete: true,
          missingModelRoles: [],
        },
      },
    };
    const text = formatSetupChecklist(state);

    assert.ok(text.includes('[x] Toolkit installed'));
    assert.ok(text.includes('[x] Project map'));
    assert.ok(text.includes('[x] Setup confirmed'));
    assert.ok(text.includes('[x] Adapter opencode'));
  });

  it('shows unchecked items', () => {
    const state = {
      toolkitInstalled: false,
      projectMapExists: false,
      setupStatus: 'absent',
      taskBackend: null,
      groupingProfile: null,
      agenticloopJsonExists: false,
      adapters: {},
    };
    const text = formatSetupChecklist(state);

    assert.ok(text.includes('[ ] Toolkit installed'));
    assert.ok(text.includes('[ ] Project map'));
    assert.ok(text.includes('[ ] Setup confirmed'));
  });
});
