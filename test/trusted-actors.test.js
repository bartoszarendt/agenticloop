/** Trusted-actor configuration: canonical field, alias policy, and validation. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTrustedTaskContractActors } from '../src/trusted-actors.js';
import { fetchGitHubTaskBody } from '../src/github-task-body.js';
import { createTaskContractBaselineRecord, renderTaskContractRecord, taskContractDigest } from '../src/task-contract-baseline.js';

function body() {
  return [
    '---', 'task_id: T-901', 'task_contract_schema: 2', 'status: draft', 'backend: github', '---', '',
    '## Scope', 'Guard task bodies.', '', '## Out of Scope', 'None.', '',
    '## Acceptance Criteria', '- Done.', '', '## Required Checks', '- `npm test`', '',
  ].join('\n');
}

function state() {
  const taskBody = body();
  const contract = taskContractDigest(taskBody);
  const record = createTaskContractBaselineRecord({
    recordId: 'record-100', taskId: 'T-901', digest: contract.digest, projection: contract.projection,
    authority: 'policy:T-901', actor: 'maintainer', timestamp: '2026-01-02T03:04:05.000Z', affectedArtifact: 'issue:31',
  });
  return {
    body: taskBody,
    comments: [{
      id: 100, html_url: 'https://example.test/comments/100', user: { login: 'Maintainer' },
      author_association: 'MEMBER', created_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-02T03:04:05Z',
      body: renderTaskContractRecord({ ...record, actor: 'Maintainer' }),
    }],
  };
}

function runnerFor(current) {
  return (_command, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([current.comments]) };
    if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 31, body: current.body }) };
    return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
  };
}

describe('trusted-actor resolver', () => {
  it('returns association-only trust when nothing is configured', () => {
    const resolved = resolveTrustedTaskContractActors({});
    assert.equal(resolved.actors, null);
    assert.deepEqual(resolved.errors, []);
    assert.match(resolved.warnings.join('\n'), /OWNER, MEMBER, and COLLABORATOR associations remain trusted/);
  });

  it('accepts a valid allowlist and preserves canonical display casing', () => {
    const resolved = resolveTrustedTaskContractActors({ trusted_task_contract_actors: ['Maintainer', 'loop-bot'] });
    assert.deepEqual(resolved.actors, ['Maintainer', 'loop-bot']);
    assert.deepEqual(resolved.errors, []);
  });

  it('rejects empty lists, empty entries, duplicates after case normalization, and invalid logins', () => {
    assert.match(resolveTrustedTaskContractActors({ trusted_task_contract_actors: [] }).errors.join('\n'), /non-empty list/);
    assert.match(resolveTrustedTaskContractActors({ trusted_task_contract_actors: 'maintainer' }).errors.join('\n'), /non-empty list/);
    assert.match(resolveTrustedTaskContractActors({ trusted_task_contract_actors: ['maintainer', ''] }).errors.join('\n'), /empty entry/);
    assert.match(resolveTrustedTaskContractActors({ trusted_task_contract_actors: ['Maintainer', 'maintainer'] }).errors.join('\n'), /duplicate login/);
    assert.match(resolveTrustedTaskContractActors({ trusted_task_contract_actors: ['-bad'] }).errors.join('\n'), /invalid GitHub login/);
    assert.match(resolveTrustedTaskContractActors({ trusted_task_contract_actors: ['bad login'] }).errors.join('\n'), /invalid GitHub login/);
  });

  it('honors the deprecated alias with a warning and prefers the canonical field', () => {
    const alias = resolveTrustedTaskContractActors({ github_trusted_actors: ['maintainer'] });
    assert.deepEqual(alias.actors, ['maintainer']);
    assert.match(alias.warnings.join('\n'), /deprecated/);
    const both = resolveTrustedTaskContractActors({ trusted_task_contract_actors: ['canonical'], github_trusted_actors: ['alias'] });
    assert.deepEqual(both.actors, ['canonical']);
    assert.match(both.warnings.join('\n'), /deprecated/);
  });
});

describe('trusted-actor allowlist enforcement in task-body fetch', () => {
  it('accepts an allowlisted author case-insensitively', () => {
    const current = state();
    const fetched = fetchGitHubTaskBody({
      issue: 31,
      commandRunner: runnerFor(current),
      projectMapConfig: { trusted_task_contract_actors: ['maintainer'] },
    });
    assert.equal(fetched.trustedRecords.length, 1);
    assert.deepEqual(fetched.trustedRecordErrors, []);
  });

  it('binds the declared actor to the GitHub carrier author case-insensitively', () => {
    const current = state();
    current.comments[0].user.login = 'maintainer';
    const fetched = fetchGitHubTaskBody({
      issue: 31,
      commandRunner: runnerFor(current),
      projectMapConfig: { trusted_task_contract_actors: ['MAINTAINER'] },
    });
    assert.equal(fetched.trustedRecords.length, 1);
    assert.deepEqual(fetched.trustedRecordErrors, []);
  });

  it('excludes a non-allowlisted author as non-fatal noise', () => {
    const current = state();
    const fetched = fetchGitHubTaskBody({
      issue: 31,
      commandRunner: runnerFor(current),
      projectMapConfig: { trusted_task_contract_actors: ['someone-else'] },
    });
    assert.equal(fetched.trustedRecords.length, 0);
    assert.deepEqual(fetched.trustedRecordErrors, []);
    assert.ok(fetched.rejectedRecords.some(entry => entry.state === 'not_allowlisted'));
  });

  it('fails closed on malformed allowlist configuration', () => {
    const current = state();
    assert.throws(
      () => fetchGitHubTaskBody({ issue: 31, commandRunner: runnerFor(current), projectMapConfig: { trusted_task_contract_actors: [] } }),
      /non-empty list/,
    );
  });
});
