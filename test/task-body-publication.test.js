/**
 * Post-publication adversarial coverage for task-contract comment records and
 * the explicitly non-authoritative offline lint envelope. All GitHub
 * interactions use injected runners; nothing contacts GitHub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { runCliInProcess } from './helpers/run-cli.js';

function body() {
  return [
    '---', 'task_id: T-901', 'task_contract_schema: 2', 'status: draft', 'backend: github', 'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**', 'intended_creations:', '  - src/new.js', '---', '',
    '# T-901 - Harden records', '', '## Task', 'Harden carriers.', '', '## Source Documents Reviewed', '- `README.md`', '', '## Current State', 'Records need trust.', '',
    '## Scope', 'Guard task bodies.', '', '## Out of Scope', 'Do not mutate GitHub history.', '', '## Acceptance Criteria', '- Records are trusted.', '', '## Required Checks', '- `npm test`', '', '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'Use canonical carriers.', '', '## Completion Summary Template', 'Summarize.', '', '## Reviewer Checklist', '- [ ] Review.', '', '[[agent: maintainer]]',
  ].join('\n');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function commentFor(id, text, { login = 'maintainer', association = 'MEMBER', edited = false, url = true } = {}) {
  return {
    id,
    ...(url ? { html_url: `https://example.test/comments/${id}` } : {}),
    user: { login },
    author_association: association,
    created_at: '2026-01-02T03:04:05Z',
    updated_at: edited ? '2026-01-02T03:05:05Z' : '2026-01-02T03:04:05Z',
    body: text,
  };
}

/**
 * Scriptable publish harness. `hooks` can mutate state mid-flight (for
 * example after the comment POST) and shape the refetched comment pages.
 */
function publishRunner(state, hooks = {}) {
  return (_command, args) => {
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: state.publisher ?? 'maintainer' }) };
    if (args[0] === 'api' && args.includes('--paginate')) {
      const pages = hooks.pages ? hooks.pages(state) : [state.comments];
      return { status: 0, stdout: JSON.stringify(pages) };
    }
    if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] !== 'issue') return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 31, body: state.body }) };
    if (args[1] === 'comment') {
      const text = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      state.comments.push(hooks.shapeComment ? hooks.shapeComment(text, state) : commentFor(501, text));
      hooks.afterComment?.(state);
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: `unexpected issue action: ${args.join(' ')}` };
  };
}

async function establishBaseline(state, hooks = {}, { projectMap = null, json = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agenticloop-publish-'));
  try {
    if (projectMap) {
      mkdirSync(join(directory, '.agenticloop'), { recursive: true });
      writeFileSync(join(directory, '.agenticloop', 'project.md'), projectMap, 'utf8');
    }
    return await runCliInProcess(
      ['task-body', 'establish-baseline', '--issue', '31', '--expect-digest', `sha256:${sha256(state.body)}`, '--authority', 'policy:T-901', '--actor', state.actor ?? 'maintainer', '--yes', ...(json ? ['--json'] : [])],
      { cwd: directory, ghCommandRunner: publishRunner(state, hooks) },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('post-publication adversarial carriers', () => {
  it('rejects an authenticated publisher that does not match the declared actor', async () => {
    const result = await establishBaseline({ body: body(), comments: [], publisher: 'other-user' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match authenticated GitHub publisher/);
  });

  it('rejects a refetched carrier whose author does not match the declared actor', async () => {
    const result = await establishBaseline(
      { body: body(), comments: [] },
      { shapeComment: text => commentFor(501, text, { login: 'someone-else' }) },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not trusted|does not match/);
  });

  it('rejects an edited refetched comment', async () => {
    const result = await establishBaseline(
      { body: body(), comments: [] },
      { shapeComment: text => commentFor(501, text, { edited: true }) },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not trusted|edited/);
  });

  it('rejects duplicate matching record IDs on refetch', async () => {
    const result = await establishBaseline(
      { body: body(), comments: [] },
      {
        shapeComment: text => commentFor(501, text),
        pages: state => [state.comments, state.comments.map(item => ({ ...item, id: item.id + 1000, html_url: `${item.html_url}-dup` }))],
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refetched 2 matching carrier/);
  });

  it('rejects a refetched carrier without a stable URL', async () => {
    const result = await establishBaseline(
      { body: body(), comments: [] },
      { shapeComment: text => commentFor(501, text, { url: false }) },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not trusted|url|authority/);
  });

  it('rejects an issue body whose digest changes during publication', async () => {
    const result = await establishBaseline(
      { body: body(), comments: [] },
      { afterComment: state => { state.body = `${state.body}\nconcurrent edit`; } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /issue body changed during comment publication/);
  });

  it('follows multi-page REST comment pagination to find the published record', async () => {
    const noise = [commentFor(41, 'ordinary discussion'), commentFor(42, 'more discussion')];
    const result = await establishBaseline(
      { body: body(), comments: [] },
      { pages: state => [[noise[0]], [noise[1], ...state.comments]] },
      { json: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).record.carrier.author, 'maintainer');
  });

  it('rejects when the configured allowlist excludes the publisher after refetch', async () => {
    const projectMap = [
      '---', 'development_stage: expansion', 'default_attempt_budget: 5', 'default_review_budget: 5', 'default_audit_budget: 3',
      'max_parallel_implementation_lanes: 5', 'task_backend: github', 'event_logging: disabled', 'work_unit_audit: enabled',
      'task_id_pattern: "T-<number>"', 'task_id_regex: "^T-\\d{3,}$"', 'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat', 'group_closeout: false', 'setup_status: unconfirmed', 'setup_confirmed_at: ""', 'setup_confirmed_by: ""',
      'trusted_task_contract_actors:', '  - "someone-else"', '---', '', '# Project', '',
    ].join('\n');
    const result = await establishBaseline({ body: body(), comments: [] }, {}, { projectMap });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not trusted|allowlist/);
  });
});

describe('offline lint is explicitly non-authoritative', () => {
  it('never claims provenance verification or publication readiness for fabricated verifiedAuthority snapshots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agenticloop-offline-lint-'));
    try {
      const candidate = body();
      const { createTaskContractBaselineRecord, taskContractDigest } = await import('../src/task-contract-baseline.js');
      const contract = taskContractDigest(candidate);
      const record = createTaskContractBaselineRecord({
        recordId: 'record-fabricated', taskId: 'T-901', digest: contract.digest, projection: contract.projection,
        authority: 'policy:T-901', actor: 'maintainer', timestamp: '2026-01-02T03:04:05.000Z', affectedArtifact: 'issue:31',
      });
      // Fabricated self-asserted authority: the snapshot claims a verified,
      // immutable carrier without any live GitHub evidence.
      const snapshot = {
        carriers: [{
          id: '999', kind: 'github_issue_comment', url: 'https://example.test/comments/999', author: 'maintainer',
          createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z',
          bodyDigest: `sha256:${sha256('x')}`, verifiedAuthority: true, edited: false,
          body: `<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n${JSON.stringify(record)}\n-->`,
        }],
      };
      writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(snapshot), 'utf8');
      writeFileSync(join(directory, 'candidate.md'), candidate, 'utf8');
      const result = await runCliInProcess(
        ['task-body', 'lint', '--issue', '31', '--body-file', 'candidate.md', '--offline', '--trusted-records', 'snapshot.json', '--json'],
        { cwd: directory },
      );
      assert.equal(result.status, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.contextMode, 'offline');
      assert.equal(envelope.lintValid, true);
      assert.equal(envelope.graphConsistent, true);
      assert.equal(envelope.provenanceVerified, false);
      assert.equal(envelope.publicationReady, false);
      assert.match(envelope.warnings.join('\n'), /non-authoritative|does not verify live carrier provenance|cannot verify live carrier authority/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
