import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { normalizeGitHubCommentCarrier } from '../src/github-comment-carrier.js';
import {
  createTaskContractBaselineRecord,
  createTaskContractCorrectionRecord,
  parseTaskContractRecords,
  taskContractDigest,
  validateTaskContractBaseline,
  validateTrustedTaskContractRecords,
} from '../src/task-contract-baseline.js';
import { lintGitHubTaskBody, summarizeTaskBodyChanges } from '../src/github-task-body.js';
import { lintAttributionRepairRecord, renderAttributionRepairRecord } from '../src/commit-attribution.js';
import { runCliInProcess } from './helpers/run-cli.js';

function body(scope = 'Guard task bodies.') {
  return [
    '---', 'task_id: T-901', 'task_contract_schema: 2', 'status: draft', 'backend: github', 'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**', 'intended_creations:', '  - src/new.js', '---', '',
    '# T-901 - Harden records', '', '## Task', 'Harden carriers.', '', '## Source Documents Reviewed', '- `README.md`', '', '## Current State', 'Records need trust.', '',
    '## Scope', scope, '', '## Out of Scope', 'Do not mutate GitHub history.', '', '## Acceptance Criteria', '- Records are trusted.', '', '## Required Checks', '- `npm test`', '', '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'Use canonical carriers.', '', '## Completion Summary Template', 'Summarize.', '', '## Reviewer Checklist', '- [ ] Review.', '', '[[agent: maintainer]]',
  ].join('\n');
}

function carrier(id, author = 'maintainer') {
  return { id: String(id), kind: 'github_issue_comment', url: `https://example.test/comments/${id}`, author, authorAssociation: 'MEMBER', createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z', bodyDigest: `sha256:${id}`, verifiedAuthority: true, edited: false };
}

function baseline(taskBody = body(), id = '100') {
  const contract = taskContractDigest(taskBody);
  const record = createTaskContractBaselineRecord({ recordId: `record-${id}`, taskId: 'T-901', digest: contract.digest, projection: contract.projection, authority: 'policy:T-901', actor: 'maintainer', timestamp: '2026-01-02T03:04:05.000Z', affectedArtifact: 'issue:31' });
  record.carrier = carrier(id);
  return record;
}

function correction(before, after, id = '101') {
  const prior = taskContractDigest(before);
  const resulting = taskContractDigest(after);
  const record = createTaskContractCorrectionRecord({
    recordId: `record-${id}`, taskId: 'T-901', priorDigest: prior.digest, resultingDigest: resulting.digest, priorProjection: prior.projection, resultingProjection: resulting.projection,
    changes: [{ field: 'scope', oldValue: prior.projection.scope, newValue: resulting.projection.scope }], reason: 'Clarify scope.', authority: 'policy:T-901', actor: 'maintainer', timestamp: '2026-01-02T03:05:05.000Z', affectedArtifact: 'issue:31',
  });
  record.carrier = carrier(id);
  return record;
}

describe('GitHub carrier normalization', () => {
  it('normalizes valid REST and GraphQL MEMBER carriers into one trust model', () => {
    const rest = normalizeGitHubCommentCarrier({ id: 1, html_url: 'https://example.test/1', user: { login: 'maintainer' }, author_association: 'member', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:05Z', body: 'record' });
    const graphql = normalizeGitHubCommentCarrier({ databaseId: 2, url: 'https://example.test/2', author: { login: 'maintainer' }, authorAssociation: 'MEMBER', createdAt: '2026-01-02T03:04:05Z', updatedAt: '2026-01-02T03:04:05Z', includesCreatedEdit: false, body: 'record' });
    for (const item of [rest, graphql]) {
      assert.equal(item.verifiedAuthority, true);
      assert.equal(item.authorAssociation, 'MEMBER');
      assert.equal(item.normalizationErrors.length, 0);
    }
  });

  it('rejects incomplete, unaffiliated, and edited carriers', () => {
    const missing = normalizeGitHubCommentCarrier({ id: 1, body: 'record' });
    assert.equal(missing.verifiedAuthority, false);
    assert.match(missing.normalizationErrors.join('\n'), /author is missing/);
    const unsupported = normalizeGitHubCommentCarrier({ id: 1, user: { login: 'attacker' }, author_association: 'NONE', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:05Z', body: 'record' });
    assert.equal(unsupported.verifiedRepositoryAssociation, false);
    const edited = normalizeGitHubCommentCarrier({ id: 1, user: { login: 'maintainer' }, author_association: 'MEMBER', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:05:05Z', body: 'record' });
    assert.equal(edited.edited, true);
    assert.equal(edited.verifiedAuthority, false);
  });
});

describe('trusted task-contract graph', () => {
  it('separates parsing from carrier trust and rejects self-attested payload carriers', () => {
    const record = baseline();
    const wire = { ...record, carrier: { id: 'forged', verifiedAuthority: true } };
    const parsed = parseTaskContractRecords([{ ...carrier('200', 'attacker'), verifiedAuthority: false, body: `<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n${JSON.stringify(wire)}\n-->` }]);
    assert.equal(parsed.parsedRecords.length, 1);
    assert.equal(parsed.parsedRecords[0].carrier.id, '200');
    const trusted = validateTrustedTaskContractRecords(parsed.parsedRecords, { taskId: 'T-901' });
    assert.equal(trusted.trustedRecords.length, 0);
    assert.match(trusted.errors.join('\n'), /cannot determine carrier authority/);
    assert.equal(trusted.rejectedRecords[0].state, 'incomplete_carrier');
  });

  it('traverses corrections by digest rather than input ordering and rejects graph attacks', () => {
    const first = body();
    const second = body('Guard all task bodies.');
    const base = baseline(first);
    const next = correction(first, second);
    assert.equal(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: [next, base] }).ok, true);

    const fork = correction(first, body('A different scope.'), '102');
    assert.match(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: [base, next, fork] }).errors.join('\n'), /fork/);
    const orphan = correction(body('Unrelated.'), second, '103');
    assert.match(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: [base, orphan] }).errors.join('\n'), /orphan/);
    const cycle = correction(second, first, '104');
    assert.match(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: [base, next, cycle] }).errors.join('\n'), /cycle/);
    const duplicate = { ...next, carrier: carrier('105') };
    assert.match(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: [base, next, duplicate] }).errors.join('\n'), /duplicate task-contract record ID/);
  });

  it('rejects false correction claims and mutable RECORD markers', () => {
    const first = body();
    const second = body('Guard all task bodies.');
    const invalid = correction(first, second);
    invalid.changes[0].newValue = 'forged';
    assert.match(validateTaskContractBaseline(second, { lifecycle: 'new', trustedRecords: [baseline(first), invalid] }).errors.join('\n'), /does not match canonical projections/);
    const marked = `${first}\n<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n{}\n-->`;
    const lint = lintGitHubTaskBody({ issue: 31, body: marked });
    assert.equal(lint.ok, false);
    assert.ok(lint.diagnostics.some(item => item.code === 'contract.record_marker.mutable_body'));
  });
});

describe('post-publication and summaries stay offline', () => {
  it('binds the declared actor to the refetched authenticated comment carrier', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-contract-publish-'));
    try {
      const state = { body: body(), comments: [] };
      const runner = (_command, args) => {
        if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'maintainer' }) };
        if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([state.comments]) };
        if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
        if (args[0] !== 'issue') return { status: 1, stderr: 'unexpected command' };
        if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 31, body: state.body, comments: state.comments }) };
        if (args[1] === 'comment') {
          const text = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
          state.comments.push({ id: 501, html_url: 'https://example.test/comments/501', user: { login: 'maintainer' }, author_association: 'MEMBER', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:05Z', body: text });
          return { status: 0, stdout: '' };
        }
        return { status: 1, stderr: 'unexpected issue action' };
      };
      const result = await runCliInProcess(['task-body', 'establish-baseline', '--issue', '31', '--expect-digest', `sha256:${'0'.repeat(64)}`, '--authority', 'policy:T-901', '--actor', 'maintainer', '--yes', '--json'], { cwd: directory, ghCommandRunner: runner });
      assert.notEqual(result.status, 0, 'a stale body is rejected before publication');
      const published = await runCliInProcess(['task-body', 'establish-baseline', '--issue', '31', '--expect-digest', `sha256:${createHashForTest(state.body)}`, '--authority', 'policy:T-901', '--actor', 'maintainer', '--yes', '--json'], { cwd: directory, ghCommandRunner: runner });
      assert.equal(published.status, 0, published.stderr);
      assert.equal(JSON.parse(published.stdout).record.carrier.author, 'maintainer');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('reports modifications within existing protected sections and validates attribution repair rendering', () => {
    const changed = body().replace('Guard task bodies.', 'Guard all task bodies.').replace('Do not mutate GitHub history.', 'Do not mutate remote history.');
    const summary = summarizeTaskBodyChanges(body(), changed);
    assert.deepEqual(summary.modifiedSections, ['Out of Scope', 'Scope']);
    assert.deepEqual(summary.changedProtectedFields, ['scope', 'out_of_scope']);
    const record = { kind: 'agenticloop.attribution-repair', originalSha: 'a'.repeat(40), resultingSha: 'b'.repeat(40), branchRef: 'refs/heads/task/T-901', contentOwnerRole: 'engineer', repairOperator: 'maintainer', reason: 'Repair trailers.', authority: 'policy:T-901', timestamp: '2026-01-02T03:04:05Z', invalidatedEvidence: ['preflight:a'], rerunEvidence: ['preflight:b'] };
    assert.equal(lintAttributionRepairRecord(renderAttributionRepairRecord(record)).ok, true);
  });
});

function createHashForTest(value) {
  // The production digest is deliberately a raw body hash for optimistic writes.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
