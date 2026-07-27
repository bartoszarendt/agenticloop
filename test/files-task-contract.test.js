/**
 * Files-backend task-contract history: first-parent append-only provenance,
 * per-record commit binding, and the correction lifecycle commands.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  createTaskContractBaselineRecord,
  createTaskContractCorrectionRecord,
  taskContractDigest,
  validateTaskContractBaseline,
} from '../src/task-contract-baseline.js';
import { loadFilesTaskContractRecords } from '../src/files-task-contract.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';

const AUTHOR = 'Loop Author';
let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-files-contract-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function filesBody(scope = 'Guard task bodies.', status = 'draft') {
  return [
    '---', 'task_id: T-900', 'task_contract_schema: 2', `status: ${status}`, 'backend: files', 'allowed_paths:', '  - src/**', '---', '',
    '# T-900 - Files contract', '', '## Scope', scope, '', '## Out of Scope', 'None.', '',
    '## Acceptance Criteria', '- Done.', '', '## Required Checks', '- `npm test`', '',
  ].join('\n');
}

function baselineFor(bodyText, recordId = 'record-baseline') {
  const contract = taskContractDigest(bodyText);
  return createTaskContractBaselineRecord({
    recordId,
    taskId: 'T-900',
    digest: contract.digest,
    projection: contract.projection,
    authority: 'policy:T-900',
    actor: AUTHOR,
    timestamp: '2026-01-02T03:04:05.000Z',
    affectedArtifact: '.agenticloop/tasks/T-900.md',
  });
}

function correctionFor(priorBody, resultingBody, recordId = 'record-correction') {
  const prior = taskContractDigest(priorBody);
  const resulting = taskContractDigest(resultingBody);
  return createTaskContractCorrectionRecord({
    recordId,
    taskId: 'T-900',
    priorDigest: prior.digest,
    resultingDigest: resulting.digest,
    priorProjection: prior.projection,
    resultingProjection: resulting.projection,
    changes: [{ field: 'scope', oldValue: prior.projection.scope, newValue: resulting.projection.scope }],
    reason: 'Clarify scope.',
    authority: 'policy:T-900',
    actor: AUTHOR,
    timestamp: '2026-01-02T03:05:05.000Z',
    affectedArtifact: '.agenticloop/tasks/T-900.md',
  });
}

function makeRepo(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  for (const args of [['init'], ['config', 'user.name', AUTHOR], ['config', 'user.email', 'loop@example.test']]) {
    git(target, args);
  }
  return target;
}

function git(cwd, args, { check = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (check) assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result;
}

function historyPath(target) {
  return join(target, '.agenticloop', 'task-contract-history', 'T-900.jsonl');
}

function writeHistory(target, records) {
  mkdirSync(join(target, '.agenticloop', 'task-contract-history'), { recursive: true });
  writeFileSync(historyPath(target), records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8');
}

function commitHistory(target, message, args = ['add', '.agenticloop']) {
  git(target, args);
  git(target, ['commit', '-m', message]);
  return git(target, ['rev-parse', 'HEAD']).stdout.trim();
}

describe('files history append-only provenance', () => {
  it('accepts an initial baseline append with correct per-record binding', () => {
    const target = makeRepo('initial');
    const record = baselineFor(filesBody());
    writeHistory(target, [record]);
    const sha = commitHistory(target, 'baseline');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.trustedRecords.length, 1);
    const provenance = loaded.trustedRecords[0].carrier.provenance;
    assert.equal(provenance.sha, sha);
    assert.equal(provenance.line, 1);
    assert.equal(provenance.authorName, AUTHOR);
    assert.equal(provenance.path, '.agenticloop/task-contract-history/T-900.jsonl');
    assert.ok(!Number.isNaN(Date.parse(provenance.timestamp)));
  });

  it('binds multiple records appended in one commit to that commit', () => {
    const target = makeRepo('multi-one-commit');
    const first = filesBody();
    const second = filesBody('Guard all task bodies.');
    writeHistory(target, [baselineFor(first), correctionFor(first, second)]);
    const sha = commitHistory(target, 'baseline and correction');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.trustedRecords.length, 2);
    assert.deepEqual(loaded.trustedRecords.map(record => record.carrier.provenance.sha), [sha, sha]);
    assert.deepEqual(loaded.trustedRecords.map(record => record.carrier.provenance.line), [1, 2]);
    assert.equal(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: loaded.trustedRecords }).ok, true);
  });

  it('accepts a valid later correction append and binds each record to its introducing commit', () => {
    const target = makeRepo('later-append');
    const first = filesBody();
    const second = filesBody('Guard all task bodies.');
    writeHistory(target, [baselineFor(first)]);
    const baselineSha = commitHistory(target, 'baseline');
    writeHistory(target, [baselineFor(first), correctionFor(first, second)]);
    const correctionSha = commitHistory(target, 'correction');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.trustedRecords.length, 2);
    assert.equal(loaded.trustedRecords[0].carrier.provenance.sha, baselineSha);
    assert.equal(loaded.trustedRecords[1].carrier.provenance.sha, correctionSha);
  });

  it('rejects committed deletion of the history', () => {
    const target = makeRepo('deletion');
    writeHistory(target, [baselineFor(filesBody())]);
    commitHistory(target, 'baseline');
    git(target, ['rm', '-q', '.agenticloop/task-contract-history/T-900.jsonl']);
    git(target, ['commit', '-m', 'delete history']);
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(loaded.errors.join('\n'), /deleted|deletion/i);
  });

  it('rejects committed truncation of the history', () => {
    const target = makeRepo('truncation');
    const first = filesBody();
    const second = filesBody('Guard all task bodies.');
    const records = [baselineFor(first), correctionFor(first, second)];
    writeHistory(target, records);
    commitHistory(target, 'two records');
    writeHistory(target, [records[0]]);
    commitHistory(target, 'truncate');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(loaded.errors.join('\n'), /append-only|prefix/i);
  });

  it('rejects committed replacement of a history record', () => {
    const target = makeRepo('replacement');
    const record = baselineFor(filesBody());
    writeHistory(target, [record]);
    commitHistory(target, 'baseline');
    writeHistory(target, [{ ...record, reason: undefined, authority: 'policy:other' }]);
    commitHistory(target, 'replace');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(loaded.errors.join('\n'), /append-only|prefix/i);
  });

  it('rejects committed reordering of history records', () => {
    const target = makeRepo('reorder');
    const first = filesBody();
    const second = filesBody('Guard all task bodies.');
    const records = [baselineFor(first), correctionFor(first, second)];
    writeHistory(target, records);
    commitHistory(target, 'two records');
    writeHistory(target, [records[1], records[0]]);
    commitHistory(target, 'reorder');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(loaded.errors.join('\n'), /append-only|prefix/i);
  });

  it('rejects staged and unstaged history changes before trusting HEAD', () => {
    const target = makeRepo('dirty');
    const record = baselineFor(filesBody());
    writeHistory(target, [record]);
    commitHistory(target, 'baseline');

    writeHistory(target, [record, correctionFor(filesBody(), filesBody('Guard all task bodies.'))]);
    const unstaged = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(unstaged.errors.join('\n'), /committed separately/);

    git(target, ['add', '.agenticloop']);
    const staged = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(staged.errors.join('\n'), /committed separately/);
  });

  it('rejects a record whose actor does not match the introducing commit author', () => {
    const target = makeRepo('actor-binding');
    const record = { ...baselineFor(filesBody()), actor: 'Someone Else' };
    writeHistory(target, [record]);
    commitHistory(target, 'baseline');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.match(loaded.errors.join('\n'), /does not match/);
    assert.equal(loaded.trustedRecords.length, 0);
  });

  it('accepts the documented case-folded full Git author identity', () => {
    const target = makeRepo('actor-full-identity');
    const record = { ...baselineFor(filesBody()), actor: 'loop author <LOOP@example.test>' };
    writeHistory(target, [record]);
    commitHistory(target, 'baseline');
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.trustedRecords.length, 1);
  });

  it('treats a first-parent merge commit as the introducing carrier', () => {
    const target = makeRepo('merge');
    const first = filesBody();
    const second = filesBody('Guard all task bodies.');
    writeHistory(target, [baselineFor(first)]);
    commitHistory(target, 'baseline');
    git(target, ['checkout', '-b', 'lane']);
    writeHistory(target, [baselineFor(first), correctionFor(first, second)]);
    commitHistory(target, 'lane correction');
    git(target, ['checkout', 'master'], { check: false });
    git(target, ['checkout', 'main'], { check: false });
    git(target, ['merge', '--no-ff', 'lane', '-m', 'merge lane']);
    const mergeSha = git(target, ['rev-parse', 'HEAD']).stdout.trim();
    const loaded = loadFilesTaskContractRecords(target, 'T-900');
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.trustedRecords.length, 2);
    assert.equal(loaded.trustedRecords[1].carrier.provenance.sha, mergeSha);
    assert.equal(loaded.trustedRecords[1].carrier.provenance.authorName, AUTHOR);
  });
});

describe('files correction lifecycle commands', () => {
  function makeTarget(name) {
    const target = mkdtempSync(join(tmpDir, `${name}-`));
    createTaskProjectFixture(target);
    return target;
  }

  function taskFilePath(target, taskId = 'T-001') {
    return join(target, '.agenticloop', 'tasks', `${taskId}.md`);
  }

  async function newTaskWithBaseline(target) {
    const created = await runCliInProcess(['task', 'new', 'Correction lifecycle', '--target', target]);
    assert.equal(created.status, 0, created.stderr);
    git(target, ['add', '.agenticloop/tasks']);
    git(target, ['commit', '-m', 'task']);
    const baseline = await runCliInProcess(['task', 'establish-baseline', 'T-001', '--actor', 'Agentic Loop Test', '--authority', 'task:T-001', '--target', target, '--json']);
    assert.equal(baseline.status, 0, baseline.stderr);
    const record = JSON.parse(baseline.stdout).record;
    git(target, ['add', '.agenticloop/task-contract-history']);
    git(target, ['commit', '-m', 'baseline']);
    return record;
  }

  it('refuses a second baseline over trusted history', async () => {
    const target = makeTarget('second-baseline');
    await newTaskWithBaseline(target);
    const second = await runCliInProcess(['task', 'establish-baseline', 'T-001', '--actor', 'Agentic Loop Test', '--authority', 'task:T-001', '--target', target]);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /duplicate task-contract baseline/);
  });

  it('appends a correction that becomes trusted only after a separate commit', async () => {
    const target = makeTarget('correction-flow');
    const baseline = await newTaskWithBaseline(target);
    const path = taskFilePath(target);
    writeFileSync(path, readFileSync(path, 'utf8').replace('List the required changes.', 'List the required changes precisely.'), 'utf8');

    const wrongDigest = await runCliInProcess(['task', 'authorize-correction', 'T-001', '--expect-prior-digest', `sha256:v1:${'0'.repeat(64)}`, '--reason', 'Clarify scope.', '--authority', 'task:T-001', '--actor', 'Agentic Loop Test', '--target', target]);
    assert.notEqual(wrongDigest.status, 0);
    assert.match(wrongDigest.stderr, /stale trusted chain/);

    const corrected = await runCliInProcess(['task', 'authorize-correction', 'T-001', '--expect-prior-digest', baseline.digest, '--reason', 'Clarify scope.', '--authority', 'task:T-001', '--actor', 'Agentic Loop Test', '--target', target, '--json']);
    assert.equal(corrected.status, 0, corrected.stderr);
    const correction = JSON.parse(corrected.stdout).record;
    assert.equal(correction.type, 'correction');
    assert.equal(correction.priorDigest, baseline.digest);
    assert.ok(correction.changes.length > 0);
    assert.match(JSON.parse(corrected.stdout).warning, /commit it separately/i);

    // Uncommitted: the agent-ready gate still fails on the uncommitted record.
    const dirty = await runCliInProcess(['task', 'status', 'T-001', 'agent-ready', '--target', target]);
    assert.notEqual(dirty.status, 0);

    git(target, ['add', '.agenticloop']);
    git(target, ['commit', '-m', 'correction and task update']);
    const ready = await runCliInProcess(['task', 'status', 'T-001', 'agent-ready', '--target', target]);
    assert.equal(ready.status, 0, ready.stderr);
  });

  it('rejects a correction that does not change the protected contract', async () => {
    const target = makeTarget('no-op-correction');
    const baseline = await newTaskWithBaseline(target);
    const result = await runCliInProcess(['task', 'authorize-correction', 'T-001', '--expect-prior-digest', baseline.digest, '--reason', 'Nothing changed.', '--authority', 'task:T-001', '--actor', 'Agentic Loop Test', '--target', target]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not change the protected contract/);
  });
});
