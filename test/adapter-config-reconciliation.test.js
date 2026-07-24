/**
 * Tests for generic, non-destructive adapter-config reconciliation.
 *
 * Covers:
 *   - reconcileAdapterRoleSettings slot creation, preservation, idempotency
 *   - reconcileTargetAdapterConfig file IO against the canonical role set
 *   - ensureAdapterConfig reconciliation for existing OpenCode installations
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { reconcileAdapterRoleSettings } from '../src/adapter-role-defaults.js';
import { ensureAdapterConfig, reconcileTargetAdapterConfig } from '../src/setup-generate.js';
import { loadJsonFile } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CANONICAL_ROLES = ['orchestrator', 'maintainer', 'engineer', 'auditor'];

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-reconcile-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTarget() {
  const d = mkdtempSync(join(tmpDir, 'target-'));
  seedTargetLayout(REPO_ROOT, d);
  return d;
}

describe('reconcileAdapterRoleSettings', () => {
  it('adds missing adapter blocks, roleSettings, and role slots', () => {
    const config = {};
    const { added, preserved } = reconcileAdapterRoleSettings(config, ['opencode'], CANONICAL_ROLES);

    assert.ok(added.includes('adapters'));
    assert.ok(added.includes('adapters.opencode'));
    assert.ok(added.includes('adapters.opencode.roleSettings'));
    for (const role of CANONICAL_ROLES) {
      assert.ok(added.includes(`adapters.opencode.roleSettings.${role}`));
      assert.deepEqual(config.adapters.opencode.roleSettings[role], {});
    }
    assert.equal(preserved.length, 0);
  });

  it('preserves existing settings and unknown target-owned fields', () => {
    const config = {
      extends: './agenticloop/config.json',
      taskBackend: 'files',
      adapters: {
        opencode: {
          status: 'supported',
          unknownAdapterField: { keep: true },
          roleSettings: {
            orchestrator: { model: 'custom/model', reasoningEffort: 'max', extra: 'kept' },
          },
        },
      },
    };
    const { added, preserved } = reconcileAdapterRoleSettings(config, ['opencode'], CANONICAL_ROLES);

    assert.deepEqual(added, [
      'adapters.opencode.roleSettings.maintainer',
      'adapters.opencode.roleSettings.engineer',
      'adapters.opencode.roleSettings.auditor',
    ]);
    assert.ok(preserved.includes('adapters'));
    assert.ok(preserved.includes('adapters.opencode'));
    assert.ok(preserved.includes('adapters.opencode.roleSettings'));
    assert.ok(preserved.includes('adapters.opencode.roleSettings.orchestrator'));
    assert.equal(config.taskBackend, 'files');
    assert.deepEqual(config.adapters.opencode.unknownAdapterField, { keep: true });
    assert.deepEqual(config.adapters.opencode.roleSettings.orchestrator, {
      model: 'custom/model',
      reasoningEffort: 'max',
      extra: 'kept',
    });
  });

  it('is idempotent', () => {
    const config = {};
    reconcileAdapterRoleSettings(config, ['opencode'], CANONICAL_ROLES);
    const second = reconcileAdapterRoleSettings(config, ['opencode'], CANONICAL_ROLES);
    assert.deepEqual(second.added, []);
  });

  it('rejects a non-object config', () => {
    assert.throws(() => reconcileAdapterRoleSettings([], ['opencode'], CANONICAL_ROLES), /JSON object/);
    assert.throws(() => reconcileAdapterRoleSettings(null, ['opencode'], CANONICAL_ROLES), /JSON object/);
  });

  it('rejects non-object adapters containers instead of silently losing role slots', () => {
    for (const adapters of [[], null, 'oops']) {
      assert.throws(
        () => reconcileAdapterRoleSettings({ adapters }, ['opencode'], CANONICAL_ROLES),
        /adapters must be an object/
      );
    }
  });

  it('rejects non-object adapter blocks instead of destroying them', () => {
    assert.throws(
      () => reconcileAdapterRoleSettings({ adapters: { opencode: 'oops' } }, ['opencode'], CANONICAL_ROLES),
      /adapters\.opencode must be an object/
    );
  });

  it('only reconciles the selected hosts', () => {
    const config = {};
    reconcileAdapterRoleSettings(config, ['opencode'], CANONICAL_ROLES);
    assert.equal(config.adapters.codex, undefined);
    assert.equal(config.adapters.copilot, undefined);
  });
});

describe('reconcileTargetAdapterConfig', () => {
  it('adds the auditor slot to a legacy three-role OpenCode config without duplicating roles', () => {
    const d = makeTarget();
    const cfgPath = join(d, 'agenticloop.json');
    writeFileSync(cfgPath, JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: {
          roleSettings: {
            orchestrator: { model: 'custom/orchestrator', reasoningEffort: 'xhigh' },
            maintainer: { model: 'custom/maintainer' },
            engineer: { model: 'custom/engineer', reasoningEffort: 'high' },
          },
        },
      },
    }, null, 2) + '\n');

    const result = reconcileTargetAdapterConfig(d, ['opencode']);

    assert.equal(result.error, null);
    assert.equal(result.wrote, true);
    assert.deepEqual(result.added, ['adapters.opencode.roleSettings.auditor']);
    const cfg = loadJsonFile(cfgPath);
    assert.deepEqual(cfg.adapters.opencode.roleSettings.auditor, {});
    assert.equal(cfg.roles, undefined);
    assert.equal(cfg.adapters.opencode.roleSettings.orchestrator.model, 'custom/orchestrator');
    assert.equal(cfg.adapters.opencode.roleSettings.orchestrator.reasoningEffort, 'xhigh');
    assert.equal(cfg.adapters.opencode.roleSettings.engineer.reasoningEffort, 'high');

    const second = reconcileTargetAdapterConfig(d, ['opencode']);
    assert.equal(second.error, null);
    assert.equal(second.wrote, false);
    assert.deepEqual(second.added, []);
  });

  it('reports an error for a non-object agenticloop.json', () => {
    const d = makeTarget();
    writeFileSync(join(d, 'agenticloop.json'), '[]\n');

    const result = reconcileTargetAdapterConfig(d, ['opencode']);
    assert.ok(result.error);
    assert.equal(result.wrote, false);
  });

  it('reports an error when agenticloop.json is missing', () => {
    const d = mkdtempSync(join(tmpDir, 'empty-'));
    const result = reconcileTargetAdapterConfig(d, ['opencode']);
    assert.ok(result.error?.includes('agenticloop.json not found'));
  });
});

describe('ensureAdapterConfig reconciliation', () => {
  it('reconciles an existing OpenCode installation against the canonical roles', () => {
    const d = makeTarget();
    const cfgPath = join(d, 'agenticloop.json');
    writeFileSync(cfgPath, JSON.stringify({
      extends: './agenticloop/config.json',
      adapters: {
        opencode: {
          roleSettings: {
            orchestrator: { model: 'custom/orchestrator' },
          },
        },
      },
    }, null, 2) + '\n');

    const error = ensureAdapterConfig(d, 'opencode');

    assert.equal(error, null);
    const cfg = loadJsonFile(cfgPath);
    for (const role of CANONICAL_ROLES) {
      assert.ok(cfg.adapters.opencode.roleSettings[role], `missing slot for ${role}`);
    }
    assert.equal(cfg.adapters.opencode.roleSettings.orchestrator.model, 'custom/orchestrator');
    assert.equal(cfg.adapters.opencode.roleSettings.auditor.model, undefined);

    // Idempotent: a second pass leaves the file byte-for-byte unchanged.
    const bytes = readFileSync(cfgPath, 'utf-8');
    assert.equal(ensureAdapterConfig(d, 'opencode'), null);
    assert.equal(readFileSync(cfgPath, 'utf-8'), bytes);
  });

  it('still creates agenticloop.json from the template when absent', () => {
    const d = mkdtempSync(join(tmpDir, 'scaffold-'));
    seedTargetLayout(REPO_ROOT, d, { includeConfig: false });

    const error = ensureAdapterConfig(d, 'opencode');

    assert.equal(error, null);
    const cfg = loadJsonFile(join(d, 'agenticloop.json'));
    assert.equal(cfg.extends, './agenticloop/config.json');
    assert.deepEqual(cfg.adapters.opencode.roleSettings, {});
  });
});
