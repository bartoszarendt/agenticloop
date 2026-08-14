import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { classifyLifecycleCompatibility } from '../src/lifecycle-compatibility.js';
import { DISPATCH_CONSUMPTION_SCHEMA_VERSION } from '../src/handoff-consumption.js';
import { TASK_CARRIER_MUTATION_RECEIPT_SCHEMA_VERSION } from '../src/task-evidence-contract.js';
import { RETURN_VERIFICATION_SCHEMA_VERSION } from '../src/return-verification.js';
import { DISPATCH_PREPARATION_SCHEMA_VERSION } from '../src/dispatch-envelope.js';
import {
  RETURN_USE_DEFAULT_MAX_AGE_SECONDS,
  RETURN_USE_FRESHNESS_POLICY,
  validateReturnUseFreshnessPolicy,
  resolveReturnUseFreshnessPolicy,
} from '../src/return-use-freshness.js';

test('lifecycle compatibility makes legacy records resumable rather than falsely migratable', () => {
  const result = classifyLifecycleCompatibility({ kind: 'agenticloop.dispatch-consumption', schemaVersion: 2 });
  assert.deepEqual(result.state, 'incompatible');
  assert.equal(result.route, 'resume_with_current_evidence');
  assert.equal(result.reason, 'unsupported_legacy_version');
});

test('lifecycle compatibility recognizes every canonical current record version', () => {
  for (const [kind, schemaVersion] of [
    ['agenticloop.dispatch-consumption', DISPATCH_CONSUMPTION_SCHEMA_VERSION],
    ['agenticloop.task-mutation-receipt', TASK_CARRIER_MUTATION_RECEIPT_SCHEMA_VERSION],
    ['agenticloop.return-verification', RETURN_VERIFICATION_SCHEMA_VERSION],
    ['agenticloop.dispatch-preparation', DISPATCH_PREPARATION_SCHEMA_VERSION],
  ]) {
    assert.equal(classifyLifecycleCompatibility({ kind, schemaVersion }).state, 'current');
  }
});

test('return-use configuration fails closed when declared missing, malformed, or unsupported', () => {
  assert.equal(resolveReturnUseFreshnessPolicy({}).ok, true);
  for (const policy of [null, {}, { ...RETURN_USE_FRESHNESS_POLICY, schemaVersion: 2 }]) {
    const resolved = resolveReturnUseFreshnessPolicy({ return_use_freshness: policy });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.policy, null);
  }
});

test('init and update refuse persisted incompatible lifecycle state without mutation', () => {
  const target = mkdtempSync(join(tmpdir(), 'al-lifecycle-compat-'));
  try {
    const path = join(target, '.agenticloop', 'handoffs', 'dispatch', 'T-001');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'legacy.json'), JSON.stringify({ kind: 'agenticloop.dispatch-consumption', schemaVersion: 2 }));
    for (const command of ['init', 'update']) {
      const result = spawnSync(process.execPath, ['bin/agenticloop.js', command, '--target', target], { cwd: process.cwd(), encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsupported_legacy_version/);
    }
    assert.equal(existsSync(join(target, 'agenticloop.json')), false);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('lifecycle compatibility fails closed for absent, malformed, and future versions', () => {
  for (const version of [undefined, '3', 5]) {
    const result = classifyLifecycleCompatibility({ kind: 'agenticloop.return-verification', schemaVersion: version });
    assert.equal(result.state, 'incompatible');
    assert.equal(result.route, 'resume_with_current_evidence');
  }
});

test('return-use freshness policy is versioned and fixed at 24 hours', () => {
  assert.equal(RETURN_USE_DEFAULT_MAX_AGE_SECONDS, 86_400);
  assert.deepEqual(validateReturnUseFreshnessPolicy(RETURN_USE_FRESHNESS_POLICY), { ok: true, errors: [] });
  assert.equal(validateReturnUseFreshnessPolicy({ ...RETURN_USE_FRESHNESS_POLICY, schemaVersion: 2 }).ok, false);
  assert.equal(validateReturnUseFreshnessPolicy({ ...RETURN_USE_FRESHNESS_POLICY, maxAgeSeconds: 86_401 }).ok, false);
});

test('return-verification compatibility docs name released v2 and interim v3', () => {
  for (const path of ['AGENTIC_LOOP.md', join('docs', 'cli-reference.md')]) {
    const body = readFileSync(join(process.cwd(), path), 'utf8').replace(/\s+/g, ' ');
    assert.match(body, /released\s+(?:schema\s+)?v2/i, `${path} must name released schema v2`);
    assert.match(body, /interim\s+(?:schema\s+)?v3/i, `${path} must name interim schema v3`);
    assert.match(body, /cannot be relabelled, migrated, or consumed as current/i);
  }
});
