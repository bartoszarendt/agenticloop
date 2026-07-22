/**
 * Explicit, reviewed test-group manifest.
 *
 * The semantic tier of a test is an architectural decision, not something that
 * can be inferred reliably from source-text regexes. `assertPartition()` keeps
 * this manifest honest: every discovered *.test.js file must appear exactly
 * once, every manifest entry must exist, and the deliberate fast selection may
 * contain only unit/integration tests.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_DIR = join(REPO_ROOT, 'test');
export const GROUPS = ['unit', 'integration', 'e2e'];

const MANIFEST = {
  unit: [
    'test/github-backend.test.js',
    'test/github-preflight.test.js',
    'test/github-review-audit.test.js',
    'test/markdown.test.js',
    'test/model-catalog.test.js',
    'test/model-picker.test.js',
    'test/schema-validation.test.js',
    'test/supervision.test.js',
  ],
  integration: [
    'test/activation-scorer.test.js',
    'test/adapter-claude-code.test.js',
    'test/adapter-codex.test.js',
    'test/adapter-copilot.test.js',
    'test/adapter-cursor.test.js',
    'test/adapter-opencode.test.js',
    'test/adapter-payload-size.test.js',
    'test/adapter-support-contract.test.js',
    'test/adapters-shared.test.js',
    'test/canonical-event-examples.test.js',
    'test/concurrency-liveness.test.js',
    'test/configure-models.test.js',
    'test/context-discipline.test.js',
    'test/contract-ownership.test.js',
    'test/event-cli.test.js',
    'test/event-logging-skill.test.js',
    'test/event-logging.test.js',
    'test/generated-artifacts.test.js',
    'test/generation-transaction.test.js',
    'test/guidance.test.js',
    'test/host-skill-surface.test.js',
    'test/init.test.js',
    'test/maintainer-fixup.test.js',
    'test/plugin-packaging.test.js',
    'test/project-detection.test.js',
    'test/project-map.test.js',
    'test/remove-lifecycle.test.js',
    'test/role-key-validation.test.js',
    'test/setup-state.test.js',
    'test/stop-contract.test.js',
    'test/supervision-permission-routing.test.js',
    'test/task-backend.test.js',
    'test/task-cli.test.js',
    'test/template-contract.test.js',
    'test/validate-config.test.js',
    'test/validate-skills.test.js',
    'test/verification-learning.test.js',
  ],
  e2e: [
    'test/bootstrap-labels.test.js',
    'test/cli-main.test.js',
    'test/cli-smoke.test.js',
    'test/event-validate-cli.test.js',
    'test/github-ready.test.js',
    'test/guidance-lifecycle.test.js',
    'test/lifecycle-cli.test.js',
    'test/lifecycle-regression.test.js',
    'test/review-provenance.test.js',
    'test/setup-cli.test.js',
    'test/status-cli.test.js',
    'test/update-cli.test.js',
    'test/worktree-add-guard-list.test.js',
    'test/worktree-cleanup-bare.test.js',
    'test/worktree-cleanup-pr-state.test.js',
    'test/worktree-preservation-blocking.test.js',
    'test/worktree-removal-cleanup.test.js',
    'test/worktree-resolve-cleanup.test.js',
    'test/worktree-resolve-guards-json.test.js',
    'test/worktree-resolve-strategies.test.js',
  ],
};

// Quick developer feedback includes pure logic plus the most relevant cheap
// filesystem/command integration tests. Heavy init/generation/validation and
// every real subprocess/Git scenario remain in the full or e2e suites.
const FAST_INTEGRATION = [
  'test/activation-scorer.test.js',
  'test/adapter-support-contract.test.js',
  'test/canonical-event-examples.test.js',
  'test/context-discipline.test.js',
  'test/contract-ownership.test.js',
  'test/event-cli.test.js',
  'test/event-logging.test.js',
  'test/plugin-packaging.test.js',
  'test/project-map.test.js',
  'test/task-backend.test.js',
  'test/task-cli.test.js',
  'test/template-contract.test.js',
  'test/verification-learning.test.js',
];

export function discoverTestFiles(rootDir = TEST_DIR) {
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.test.js')) found.push(full);
    }
  }
  walk(rootDir);
  return found.sort();
}

function absolute(relativePath) {
  return join(REPO_ROOT, ...relativePath.split('/'));
}

function duplicates(entries) {
  return [...new Set(entries.filter((entry, index) => entries.indexOf(entry) !== index))];
}

export function groupFiles() {
  return Object.fromEntries(
    GROUPS.map(group => [group, MANIFEST[group].map(absolute)])
  );
}

export function fastFiles() {
  return [...MANIFEST.unit, ...FAST_INTEGRATION].map(absolute);
}

export function assertPartition(rootDir = TEST_DIR) {
  if (rootDir !== TEST_DIR) {
    throw new Error('explicit test manifest validation only supports the repository test directory');
  }

  const all = discoverTestFiles(rootDir);
  const discovered = all.map(rel);
  const entries = GROUPS.flatMap(group => MANIFEST[group]);
  const duplicateEntries = duplicates(entries);
  const missing = discovered.filter(file => !entries.includes(file));
  const extra = entries.filter(file => !discovered.includes(file));
  const fast = [...MANIFEST.unit, ...FAST_INTEGRATION];
  const duplicateFast = duplicates(fast);
  const e2eFast = fast.filter(file => MANIFEST.e2e.includes(file));

  if (duplicateEntries.length || missing.length || extra.length || duplicateFast.length || e2eFast.length) {
    const details = [
      duplicateEntries.length && `duplicate manifest entries: ${duplicateEntries.join(', ')}`,
      missing.length && `unclassified files: ${missing.join(', ')}`,
      extra.length && `missing files referenced by manifest: ${extra.join(', ')}`,
      duplicateFast.length && `duplicate fast entries: ${duplicateFast.join(', ')}`,
      e2eFast.length && `e2e files cannot be fast: ${e2eFast.join(', ')}`,
    ].filter(Boolean);
    throw new Error(`test group manifest mismatch: ${details.join('; ')}`);
  }

  return {
    all,
    ...groupFiles(),
    fast: fastFiles(),
  };
}

export function rel(file) {
  return relative(REPO_ROOT, file).split(sep).join('/');
}
