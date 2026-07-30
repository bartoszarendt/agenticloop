/**
 * Red-before regressions for the task-contract trust model. These probes pin
 * the required end-state behavior: untrusted carrier noise must not poison a
 * valid trusted chain, committed files history must be genuinely append-only,
 * schema-less readiness transitions must require baseline migration, and an
 * edited carrier must never validate even with self-asserted authority.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  createTaskContractBaselineRecord,
  deriveTaskContractLifecycle,
  renderTaskContractRecord,
  taskContractDigest,
  validateTaskContractRecord,
} from '../src/task-contract-baseline.js';
import { fetchGitHubTaskBody, lintGitHubTaskBody } from '../src/github-task-body.js';
import { loadFilesTaskContractRecords } from '../src/files-task-contract.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';

function githubBody(status = 'draft') {
  return [
    '---', 'task_id: T-901', 'task_contract_schema: 2', `status: ${status}`, 'backend: github', 'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**', 'intended_creations:', '  - src/new.js', '---', '',
    '# T-901 - Harden records', '', '## Task', 'Harden carriers.', '', '## Source Documents Reviewed', '- `README.md`', '', '## Current State', 'Records need trust.', '',
    '## Scope', 'Guard task bodies.', '', '## Out of Scope', 'Do not mutate GitHub history.', '', '## Acceptance Criteria', '- Records are trusted.', '', '## Required Checks', '- `npm test`', '', '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'Use canonical carriers.', '', '## Completion Summary Template', 'Summarize.', '', '## Reviewer Checklist', '- [ ] Review.', '', '[[agent: maintainer]]',
  ].join('\n');
}

function baselineRecordFor(taskBody, { recordId = 'record-100', actor = 'maintainer' } = {}) {
  const contract = taskContractDigest(taskBody);
  return createTaskContractBaselineRecord({
    recordId,
    taskId: 'T-901',
    digest: contract.digest,
    projection: contract.projection,
    authority: 'policy:T-901',
    actor,
    timestamp: '2026-01-02T03:04:05.000Z',
    affectedArtifact: 'issue:31',
  });
}

function comment({ id, login, association, body, created = '2026-01-02T03:04:05Z', updated = created, url = true }) {
  return {
    id,
    ...(url ? { html_url: `https://example.test/comments/${id}` } : {}),
    user: { login },
    author_association: association,
    created_at: created,
    updated_at: updated,
    body,
  };
}

function ghRunnerFor(state) {
  return (_command, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([state.comments]) };
    if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 31, body: state.body }) };
    return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
  };
}

describe('carrier authority classification', () => {
  function fetchWith(comments) {
    return fetchGitHubTaskBody({ issue: 31, commandRunner: ghRunnerFor({ body: githubBody(), comments }) });
  }

  it('classifies each carrier state explicitly', () => {
    const trusted = comment({ id: 1, login: 'maintainer', association: 'MEMBER', body: 'note' });
    const edited = comment({ id: 2, login: 'maintainer', association: 'MEMBER', body: 'note', updated: '2026-01-02T03:06:05Z' });
    const unaffiliated = comment({ id: 3, login: 'attacker', association: 'NONE', body: 'note' });
    const incomplete = comment({ id: 4, login: 'maintainer', association: 'MEMBER', body: 'note', url: false });
    const fetched = fetchWith([trusted, edited, unaffiliated, incomplete]);
    const states = Object.fromEntries(fetched.carriers.map(item => [item.id, item.authorityState]));
    assert.deepEqual(states, { 1: 'trusted_immutable', 2: 'edited_authority', 3: 'untrusted_association', 4: 'incomplete_carrier' });
    const excluded = fetchGitHubTaskBody({
      issue: 31,
      commandRunner: ghRunnerFor({ body: githubBody(), comments: [trusted] }),
      projectMapConfig: { trusted_task_contract_actors: ['someone-else'] },
    });
    assert.equal(excluded.carriers[0].authorityState, 'not_allowlisted');
  });

  it('keeps a valid trusted chain intact when surrounded by untrusted noise', () => {
    const body = githubBody();
    const baseline = baselineRecordFor(body);
    const state = {
      body,
      comments: [
        comment({ id: 10, login: 'attacker', association: 'NONE', body: '<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n{invalid json\n-->' }),
        comment({ id: 11, login: 'maintainer', association: 'MEMBER', body: renderTaskContractRecord(baseline) }),
        comment({ id: 12, login: 'maintainer', association: 'MEMBER', body: renderTaskContractRecord(baselineRecordFor(body, { recordId: 'record-edited' })), updated: '2026-01-02T03:06:05Z' }),
        comment({ id: 13, login: 'attacker', association: 'CONTRIBUTOR', body: 'plain noise without a marker' }),
      ],
    };
    const fetched = fetchGitHubTaskBody({ issue: 31, commandRunner: ghRunnerFor(state) });
    assert.deepEqual(fetched.trustedRecordErrors, []);
    assert.equal(fetched.trustedRecords.length, 1);
    assert.equal(fetched.rejectedRecords.find(entry => entry.carrier.id === '12')?.state, 'edited_authority');
    assert.ok(fetched.parseDiagnostics.some(entry => entry.carrierId === '10' && entry.authorityState === 'untrusted_association' && !entry.fatal));
    const lint = lintGitHubTaskBody({ issue: 31, body, trustedRecords: fetched.trustedRecords, trustedRecordErrors: fetched.trustedRecordErrors });
    assert.equal(lint.ok, true, lint.errors.join('\n'));
  });

  it('treats a malformed record on a trusted immutable carrier as fatal', () => {
    const fetched = fetchWith([comment({ id: 20, login: 'maintainer', association: 'MEMBER', body: '<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n{invalid json\n-->' })]);
    assert.match(fetched.trustedRecordErrors.join('\n'), /invalid JSON/);
    assert.ok(fetched.parseDiagnostics.every(entry => entry.fatal));
  });

  it('fails safely when backend metadata prevents an authority determination', () => {
    const body = githubBody();
    const fetched = fetchWith([comment({ id: 21, login: 'maintainer', association: 'MEMBER', body: renderTaskContractRecord(baselineRecordFor(body)), url: false })]);
    assert.match(fetched.trustedRecordErrors.join('\n'), /cannot determine carrier authority/);
    assert.equal(fetched.rejectedRecords[0].state, 'incomplete_carrier');
  });

  it('lets a chain fail naturally when the only baseline carrier is an edited authority', () => {
    const body = githubBody();
    const fetched = fetchWith([comment({ id: 22, login: 'maintainer', association: 'MEMBER', body: renderTaskContractRecord(baselineRecordFor(body)), updated: '2026-01-02T03:06:05Z' })]);
    assert.deepEqual(fetched.trustedRecordErrors, []);
    assert.equal(fetched.trustedRecords.length, 0);
    const lint = lintGitHubTaskBody({ issue: 31, body, lifecycle: 'transition', trustedRecords: fetched.trustedRecords, trustedRecordErrors: fetched.trustedRecordErrors });
    assert.equal(lint.ok, false);
    assert.match(lint.errors.join('\n'), /baseline/);
  });
});

describe('untrusted carrier noise cannot poison a valid trusted chain', () => {
  it('keeps a valid MEMBER baseline trusted when an unaffiliated NONE comment carries a valid record marker', () => {
    const body = githubBody();
    const baseline = baselineRecordFor(body);
    // A payload-valid record (even duplicating the trusted record ID) authored
    // by an unaffiliated account is noise, never a chain invalidation.
    const hostile = baselineRecordFor(body, { recordId: baseline.recordId, actor: 'attacker' });
    const state = {
      body,
      comments: [
        comment({ id: 100, login: 'maintainer', association: 'MEMBER', body: renderTaskContractRecord(baseline) }),
        comment({ id: 666, login: 'attacker', association: 'NONE', body: renderTaskContractRecord(hostile) }),
      ],
    };
    const fetched = fetchGitHubTaskBody({ issue: 31, commandRunner: ghRunnerFor(state) });
    assert.deepEqual(fetched.trustedRecordErrors, []);
    assert.equal(fetched.trustedRecords.length, 1);
    assert.equal(fetched.trustedRecords[0].recordId, baseline.recordId);
    assert.ok(
      fetched.rejectedRecords.some(entry => entry.state === 'untrusted_association' && entry.carrier.author === 'attacker'),
      'rejected carriers retain identity and authority classification',
    );
    const lint = lintGitHubTaskBody({
      issue: 31,
      body,
      trustedRecords: fetched.trustedRecords,
      trustedRecordErrors: fetched.trustedRecordErrors,
    });
    assert.equal(lint.ok, true, lint.errors.join('\n'));
  });
});

describe('files history is genuinely append-only', () => {
  function gitRepositoryWithHistory() {
    const target = mkdtempSync(join(tmpdir(), 'al-history-rewrite-'));
    for (const args of [['init'], ['config', 'user.name', 'Loop Author'], ['config', 'user.email', 'loop@example.test']]) {
      const result = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    return target;
  }

  function commitAll(target, message) {
    for (const args of [['add', '.agenticloop'], ['commit', '-m', message]]) {
      const result = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }

  it('rejects a committed history line rewritten in a later commit', () => {
    const target = gitRepositoryWithHistory();
    try {
      const record = baselineRecordFor(githubBody(), { actor: 'Loop Author' });
      const historyPath = join(target, '.agenticloop', 'task-contract-history', 'T-901.jsonl');
      mkdirSync(join(target, '.agenticloop', 'task-contract-history'), { recursive: true });
      writeFileSync(historyPath, `${JSON.stringify(record)}\n`, 'utf8');
      commitAll(target, 'baseline');
      writeFileSync(historyPath, `${JSON.stringify({ ...record, timestamp: '2026-01-03T00:00:00.000Z' })}\n`, 'utf8');
      commitAll(target, 'rewrite the committed baseline line');
      const loaded = loadFilesTaskContractRecords(target, 'T-901');
      assert.ok(
        loaded.errors.some(error => /append-only|prefix|rewrit|truncate|reorder/i.test(error)),
        `expected an append-only provenance error, got: ${loaded.errors.join('; ') || '(none)'}`,
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('schema-less readiness transitions require baseline migration', () => {
  function schemaLessFilesBody(status) {
    return [
      '---', 'task_id: T-901', `status: ${status}`, 'backend: files', 'allowed_paths:', '  - src/**', '---', '',
      '# T-901 - Legacy task', '', '## Scope', 'Guard task bodies.', '', '## Out of Scope', 'None.', '',
      '## Acceptance Criteria', '- Done.', '', '## Required Checks', '- `npm test`', '',
    ].join('\n');
  }

  it('classifies a schema-less draft -> agent-ready transition as a migration transition', () => {
    const lifecycle = deriveTaskContractLifecycle(schemaLessFilesBody('agent-ready'), { currentBody: schemaLessFilesBody('draft') });
    assert.equal(lifecycle, 'transition');
  });

  it('fails the files CLI agent-ready gate for a schema-less task without a baseline', async () => {
    const target = mkdtempSync(join(tmpdir(), 'al-schemaless-ready-'));
    try {
      createTaskProjectFixture(target);
      const created = await runCliInProcess(['task', 'new', 'Schema-less readiness', '--scaffold', '--target', target]);
      assert.equal(created.status, 0, created.stderr);
      const path = join(target, '.agenticloop', 'tasks', 'T-001.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace(/^task_contract_schema: 2\n/m, ''), 'utf8');
      // Complete readiness evidence is supplied explicitly so the refusal is
      // proven to come from the missing trusted baseline, not from a missing
      // argument.
      const dependencies = '.agenticloop/tmp/dependencies.json';
      mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
      writeFileSync(join(target, dependencies), `${JSON.stringify({
        kind: 'agenticloop.dependency-snapshot',
        schemaVersion: 1,
        source: 'files:.agenticloop/tasks',
        observedAt: new Date().toISOString(),
        freshnessPolicy: { maxAgeSeconds: 86400 },
        statuses: {},
      })}\n`, 'utf8');
      let gitResult = spawnSync('git', ['-C', target, 'add', dependencies], { encoding: 'utf8' });
      assert.equal(gitResult.status, 0, gitResult.stderr);
      gitResult = spawnSync('git', [
        '-C', target, 'commit', '-m',
        'record dependency evidence\n\nTask: T-001\nAgent: maintainer',
      ], { encoding: 'utf8' });
      assert.equal(gitResult.status, 0, gitResult.stderr);
      const digest = `sha256:${createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex')}`;
      const result = await runCliInProcess([
        'task', 'status', 'T-001', 'agent-ready', '--expect-digest', digest,
        '--base', 'HEAD', '--dependencies', dependencies, '--target', target,
      ]);
      assert.notEqual(result.status, 0, 'schema-less task must not enter agent-ready without a trusted baseline');
      assert.match(result.stdout + result.stderr, /baseline/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('edited carriers stay rejected even with self-asserted authority', () => {
  it('rejects a record whose carrier asserts both verifiedAuthority: true and edited: true', () => {
    const body = githubBody();
    const record = baselineRecordFor(body);
    record.carrier = {
      id: '100',
      kind: 'github_issue_comment',
      url: 'https://example.test/comments/100',
      author: 'maintainer',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:05:05.000Z',
      bodyDigest: 'sha256:100',
      verifiedAuthority: true,
      edited: true,
    };
    const validation = validateTaskContractRecord(record, { taskId: 'T-901' });
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join('\n'), /edited/);
  });
});
