import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../src/validate-config.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-rolekey-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// Inject extra keys onto roles.orchestrator in the seeded base config, which the
// target's agenticloop.json extends.
function seedWithRoleKeys(name, extraKeys) {
  const d = mkdtempSync(join(tmpDir, `${name}-`));
  seedTargetLayout(REPO_ROOT, d);
  const baseCfgPath = join(d, 'agenticloop', 'config.json');
  const base = JSON.parse(readFileSync(baseCfgPath, 'utf-8'));
  Object.assign(base.roles.orchestrator, extraKeys);
  writeFileSync(baseCfgPath, JSON.stringify(base, null, 2) + '\n', 'utf-8');
  return d;
}

function roleKeyWarnings(warnings) {
  return warnings.filter(w => /is not a recognized role configuration key/.test(w));
}

describe('unknown role-key validation', () => {
  it('produces no unknown-key warning for the default known keys', () => {
    const d = mkdtempSync(join(tmpDir, 'known-'));
    seedTargetLayout(REPO_ROOT, d);
    const { errors, warnings } = validateConfig(d);
    assert.deepEqual(roleKeyWarnings(warnings), []);
    assert.deepEqual(errors, []);
  });

  it('warns for each removed legacy field if reintroduced, with the full path', () => {
    const d = seedWithRoleKeys('legacy', {
      responsibilities: ['plan'],
      canEditDocs: true,
      canEditImplementationFiles: false,
    });
    const { errors, warnings } = validateConfig(d);
    const roleWarns = roleKeyWarnings(warnings);
    for (const key of ['responsibilities', 'canEditDocs', 'canEditImplementationFiles']) {
      assert.ok(
        roleWarns.some(w => w.includes(`roles.orchestrator.${key}`)),
        `expected warning for roles.orchestrator.${key}, got: ${roleWarns.join(' | ')}`
      );
    }
    // Loading stays permissive: unknown keys are not errors.
    assert.deepEqual(errors, []);
    // Warning language flags the future-major escalation.
    assert.ok(roleWarns.every(w => /may become errors in a future major version/.test(w)));
  });

  it('warns for an arbitrary unknown role key', () => {
    const d = seedWithRoleKeys('arbitrary', { bogusKey: 'nope' });
    const { warnings } = validateConfig(d);
    assert.ok(
      roleKeyWarnings(warnings).some(w => w.includes('roles.orchestrator.bogusKey')),
      `expected bogusKey warning, got: ${roleKeyWarnings(warnings).join(' | ')}`
    );
  });

  it('does not warn for supported model/reasoning compatibility keys', () => {
    const d = seedWithRoleKeys('model-keys', {
      model: 'anthropic/claude-opus-4-8',
      reasoningEffort: 'high',
      variant: 'auto',
    });
    const { warnings } = validateConfig(d);
    assert.deepEqual(roleKeyWarnings(warnings), []);
  });
});
