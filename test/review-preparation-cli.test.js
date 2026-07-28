/**
 * Review-preparation CLI handler tests: success and failure envelopes, exit statuses,
 * JSON shape, owner routing, and no-write behavior for the new commands.
 * GitHub paths are exercised only up to their pre-network usage failures;
 * full GitHub behavior is covered by direct function tests with mocked
 * read-only command runners (review-preparation-contract.test.js).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCliInProcess } from './helpers/run-cli.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const BASE = 'b'.repeat(40);

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-review-preparation-cli-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(name, content) {
  const path = join(tmpDir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function completeBody() {
  return [
    '## Scope Completed', 'Completed the scoped change.', '',
    '## Artifacts', `Current implementation artifact: commit:${HEAD}`, '',
    '## Evidence', `Current PR head: ${HEAD}`, '',
    '- Required check: [RC-1] `npm test`', '  Verdict: passed', '  Evidence: 47 tests passed (exit 0)', '',
    '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.', '',
    '[[agent: engineer]]',
  ].join('\n');
}

function completeInput(body = completeBody()) {
  return {
    schemaVersion: 1,
    prData: { number: 42, body, headRefOid: HEAD, baseRefOid: BASE, files: [], statusCheckRollup: [], commits: [{ oid: HEAD, message: 'impl\n\nTask: T-007\nAgent: engineer' }], comments: [], reviews: [] },
    issueData: { number: 7, body: '---\ntask_id: T-007\n---\n# T\n\n## Required Checks\n- [RC-1] `npm test`\n', comments: [] },
    expectedAccount: { login: 'loop-bot', type: 'User' },
    reviewHistory: { events: [], errors: [] },
    basePaths: [], mode: 'review', pathInventoryRequired: false,
    projectFacts: [], references: { decisionIds: [], taskIds: [] },
    verificationStatus: null,
    configuration: { reviewBudget: 5, reviewBudgetError: null, projectMapConfig: null },
  };
}

describe('review preparation CLI - pr-body lint', () => {
  it('returns a success envelope with separated lint and gate results', async () => {
    const input = write('lint-ok.json', JSON.stringify(completeInput()));
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.lintReady, true);
    assert.equal(parsed.gatePassed, true);
    assert.equal(parsed.publicationReady, true);
  });

  it('returns a failure envelope for a placeholder scaffold body', async () => {
    const input = write('lint-bad.json', JSON.stringify(completeInput(completeBody().replace('Completed the scoped change.', 'REPLACE: x'))));
    const result = await runCliInProcess(['pr-body', 'lint', '--input', input, '--json'], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.lintReady, false);
    assert.equal(parsed.publicationReady, false);
    assert.match(parsed.errors.join('\n'), /placeholder/i);
    assert.ok(Array.isArray(parsed.diagnostics));
  });

  it('fails safely with a usage envelope when --input is missing', async () => {
    const result = await runCliInProcess(['pr-body', 'lint', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.failureCategories, ['usage']);
  });
});

describe('review preparation CLI - task-readiness', () => {
  it('executes with --task-body and --base-paths and returns a success envelope', async () => {
    const task = write('task.md', '---\nallowed_paths: ["src/**"]\n---\n# Task\n');
    const base = write('base.json', JSON.stringify(['src/app.js']));
    const result = await runCliInProcess(['task-readiness', '--task-body', task, '--base-paths', base, '--mode', 'review', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.paths));
  });

  it('returns a failure envelope for an unmatched literal in review mode', async () => {
    const task = write('task-typo.md', '---\nallowed_paths: ["src/app/App.tsx"]\n---\n# Task\n');
    const base = write('base-typo.json', JSON.stringify(['src/App.tsx']));
    const result = await runCliInProcess(['task-readiness', '--task-body', task, '--base-paths', base, '--mode', 'review', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('\n'), /App\.tsx/);
  });

  it('types a missing base inventory as unavailable verification context', async () => {
    const task = write('task-no-base.md', '---\nallowed_paths: ["src/**"]\n---\n# Task\n');
    const result = await runCliInProcess(['task-readiness', '--task-body', task, '--mode', 'review', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.evidenceState, 'missing');
    assert.equal(parsed.disposition, 'needs_context');
    assert.equal(parsed.diagnostics[0].code, 'verification.context.missing');
    assert.equal(parsed.diagnostics[0].evidence.state, 'missing');
    assert.equal(Object.hasOwn(parsed.diagnostics[0].evidence, 'evidenceState'), false);
    assert.equal(parsed.diagnostics[0].evidence.committedStateEvaluated, false);
    assert.equal(parsed.rollbackAuthorized, false);
  });

  it('fails closed with a gate error when --mode is missing', async () => {
    const task = write('task-nomode.md', '---\nallowed_paths: ["src/**"]\n---\n# Task\n');
    const base = write('base-nomode.json', JSON.stringify(['src/a.js']));
    const result = await runCliInProcess(['task-readiness', '--task-body', task, '--base-paths', base, '--json'], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join('\n'), /mode must be explicitly/);
  });
});

describe('review preparation CLI - commit-attribution check', () => {
  it('returns a success envelope for a valid final trailer pair', async () => {
    const message = write('message-ok.txt', 'subject\n\nTask: T-1\nAgent: engineer\n');
    const result = await runCliInProcess(['commit-attribution', 'check', '--task', 'T-1', '--message-file', message, '--json', '--target', tmpDir], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.repairPlan, null);
  });

  it('returns a failure envelope with an Engineer-owned repair plan and never writes', async () => {
    const content = 'subject\n\nTask: OLD\nAgent: maintainer\nTask: OLD\n';
    const message = write('message-bad.txt', content);
    const result = await runCliInProcess(['commit-attribution', 'check', '--task', 'T-1', '--message-file', message, '--json', '--target', tmpDir], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.repairPlan, /Task: T-1/);
    assert.ok(parsed.diagnostics.every(item => item.owner === 'engineer'));
    assert.equal(readFileSync(message, 'utf-8'), content, 'the message file must be unchanged');
  });

  it('fails safely with a usage envelope when --task is missing', async () => {
    const result = await runCliInProcess(['commit-attribution', 'check', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.failureCategories, ['usage']);
  });
});

describe('review preparation CLI - GitHub handlers fail safely before network access', () => {
  it('pr-body scaffold requires --pr with a usage envelope', async () => {
    const result = await runCliInProcess(['pr-body', 'scaffold', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.failureCategories, ['usage']);
  });

  it('github-checkpoint render and repair-plan require --pr with a usage envelope', async () => {
    for (const sub of ['render', 'repair-plan']) {
      const result = await runCliInProcess(['github-checkpoint', sub, '--json'], { cwd: tmpDir });
      assert.equal(result.status, 2, `${sub}: ${result.stdout}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.failureCategories, ['usage']);
    }
  });

  it('github-review-prepare requires --pr with a usage envelope', async () => {
    const result = await runCliInProcess(['github-review-prepare', '--json'], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.failureCategories, ['usage']);
  });
});

describe('review preparation CLI - help', () => {
  it('renders help for every review-preparation command', async () => {
    for (const [command, sub] of [['pr-body', 'scaffold'], ['pr-body', 'lint'], ['task-readiness', null], ['commit-attribution', 'check'], ['github-checkpoint', 'render'], ['github-checkpoint', 'repair-plan'], ['github-review-prepare', null]]) {
      const args = sub ? [command, sub, '--help'] : [command, '--help'];
      const result = await runCliInProcess(args, { cwd: tmpDir });
      assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.length > 0, `${args.join(' ')} must render help text`);
    }
  });
});
