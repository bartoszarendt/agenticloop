/**
 * GitHub task identity inventory and closeout publication tests: duplicate and
 * contradictory identities, truncated inventory, reopened covered tasks, and
 * digest-idempotent recovery after an ambiguous remote response.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGitHubTaskIdentityInventory,
  resolveCoveredGitHubTask,
} from '../src/github-task-identity.js';
import {
  evaluatePullRequestLifecycle,
  fetchGitHubTaskInventory,
  findMarkerByDigest,
  publishGitHubCloseoutMarker,
} from '../src/closeout-github.js';
import { renderCloseoutMarker } from '../src/closeout-contract.js';
import { runCliInProcess } from './helpers/run-cli.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-closeout-gh-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function legacyOptions(ghCommandRunner) {
  return {
    ghCommandRunner,
    operatorActivationRoot: join(tmpDir, 'operator-activation'),
    stdinIsTTY: true, isTTY: true, ci: false,
    promptFactory: () => ({ ask: async () => 'waive', close() {} }),
  };
}

function legacyPrepareArgs(args) {
  return [...args, '--legacy-unactivated', '--legacy-reason', 'historical unactivated GitHub closeout fixture'];
}

function issue(number, { state = 'OPEN', title = '', body = '', labels = [] } = {}) {
  return { number, state, title, body, labels: labels.map(name => ({ name })) };
}

/**
 * A complete, valid GitHub task-record body. The closeout-owned terminal
 * transition validates the carrier before and after mutation, so a covered
 * task fixture must be a real record rather than a frontmatter stub.
 */
function coveredTaskBody(status = 'accepted') {
  return [
    '---', 'task_id: T-001', 'task_contract_schema: 2', `status: ${status}`, 'backend: github',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**', '---', '',
    '# T-001 - Covered task', '',
    '## Task', 'Ship the covered work.', '',
    '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Accepted.', '',
    '## Scope', 'One work unit.', '',
    '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- accepted', '',
    '## Required Checks', '- [RC-1] command: `npm test`', '',
    '## Expected Files or Areas', '- src/', '',
    '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'Use the template.', '',
    '## Reviewer Checklist', '- [x] reviewed', '',
    '[[agent: maintainer]]',
  ].join('\n');
}

describe('task identity inventory', () => {
  it('fails with both carriers when two closed issues share one task id', () => {
    const inventory = buildGitHubTaskIdentityInventory([
      issue(7, { state: 'CLOSED', body: '---\ntask_id: T-007\n---\n' }),
      issue(12, { state: 'CLOSED', body: '---\ntask_id: T-007\n---\n' }),
    ]);
    assert.equal(inventory.state, 'identity_conflict');
    assert.ok(inventory.errors.some(error => error.includes('#7') && error.includes('#12')));
    assert.ok(inventory.errors.some(error => error.includes('T-007')));
  });

  it('detects duplicates across open and closed issues', () => {
    const inventory = buildGitHubTaskIdentityInventory([
      issue(7, { state: 'OPEN', body: '---\ntask_id: T-007\n---\n' }),
      issue(9, { state: 'CLOSED', title: 'T-007 implement the thing' }),
    ]);
    assert.equal(inventory.state, 'identity_conflict');
  });

  it('fails on frontmatter/title/label contradiction instead of choosing silently', () => {
    const inventory = buildGitHubTaskIdentityInventory([
      issue(5, {
        body: '---\ntask_id: T-005\n---\n',
        title: 'T-009 something else',
      }),
    ]);
    assert.equal(inventory.state, 'identity_conflict');
    assert.match(inventory.errors.join('\n'), /contradictory task identities/);
  });

  it('keeps #12 and T-012 in distinct namespaces', () => {
    const inventory = buildGitHubTaskIdentityInventory([
      issue(12, { body: '' }),
      issue(21, { body: '---\ntask_id: T-012\n---\n' }),
    ]);
    assert.equal(inventory.state, 'ok');
    const legacy = resolveCoveredGitHubTask(inventory, '#12');
    const materialized = resolveCoveredGitHubTask(inventory, 'T-012');
    assert.equal(legacy.found, true);
    assert.equal(legacy.issue.number, 12);
    assert.equal(materialized.found, true);
    assert.equal(materialized.issue.number, 21);
  });

  it('marks truncated inventory as inventory_incomplete, never a false pass', () => {
    const inventory = buildGitHubTaskIdentityInventory([
      issue(1, { body: '---\ntask_id: T-001\n---\n' }),
    ], { complete: false });
    assert.equal(inventory.state, 'inventory_incomplete');
    const resolved = resolveCoveredGitHubTask(inventory, 'T-001');
    assert.equal(resolved.found, false);
    assert.equal(resolved.error, 'inventory_incomplete');
  });

  it('paginates beyond 200 issues and marks the true limit as incomplete', () => {
    const issues = Array.from({ length: 201 }, (_, index) => issue(index + 1, { body: `---\ntask_id: T-${String(index + 1).padStart(3, '0')}\n---\n` }));
    const runner = () => ({ status: 0, stdout: JSON.stringify(issues), stderr: '' });
    const inventory = fetchGitHubTaskInventory(runner);
    assert.equal(inventory.state, 'ok');
    const oversized = Array.from({ length: 1001 }, (_, index) => issue(index + 1, { body: `---\ntask_id: T-${String(index + 1).padStart(3, '0')}\n---\n` }));
    assert.equal(fetchGitHubTaskInventory(() => ({ status: 0, stdout: JSON.stringify(oversized), stderr: '' })).state, 'inventory_incomplete');
  });
});

describe('terminal PR lifecycle', () => {
  function makeLifecycleTarget(name) {
    const target = mkdtempSync(join(tmpDir, `${name}-`));
    mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: confirmed',
      'development_stage: expansion',
      'task_backend: github',
      'work_unit_audit: disabled',
      'grouping_profile: milestone',
      '---',
      '',
      '# Project',
      '',
    ].join('\n'), 'utf-8');
    return target;
  }

  const full = 'a'.repeat(40);

  function lifecycleRunner({ closingRefs = [{ number: 5 }], pr = null, issues = null } = {}) {
    const issueList = issues ?? [issue(1, { state: 'CLOSED', body: coveredTaskBody('closed') })];
    const prData = pr ?? {
      number: 5,
      state: 'MERGED',
      mergedAt: '2026-07-27T12:00:00Z',
      mergeCommit: { oid: full },
      headRefOid: full,
      reviewDecision: 'APPROVED',
      reviews: [],
      closingIssuesReferences: [{ number: 1 }],
    };
    return (command, args) => {
      if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(issueList), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop' }), stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return { status: 0, stdout: JSON.stringify({ closedByPullRequestsReferences: closingRefs }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view' && String(args[args.indexOf('--json') + 1] ?? '').includes('body')) {
        return { status: 0, stdout: JSON.stringify({ number: 1, body: issueList[0].body }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: [], updatedAt: 'now' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
  }

  async function prepare(name, runner) {
    const target = makeLifecycleTarget(name);
    const result = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${full}`, '--json', '--legacy-unactivated',
      '--legacy-reason', 'historical unactivated GitHub lifecycle fixture', '--target', target,
    ], legacyOptions(runner));
    return result;
  }

  it('a closed issue with no closing PR cannot complete', async () => {
    const result = await prepare('no-pr', lifecycleRunner({ closingRefs: [] }));
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.ok(packet.reasons.some(item => item.gate === 'pr_lifecycle' && /closing relationship/.test(item.message)));
  });

  it('a merged PR closing the wrong issue cannot complete', async () => {
    const result = await prepare('wrong-issue', lifecycleRunner({
      pr: {
        number: 5,
        state: 'MERGED',
        mergedAt: '2026-07-27T12:00:00Z',
        mergeCommit: { oid: full },
        reviewDecision: 'APPROVED',
        reviews: [],
        closingIssuesReferences: [{ number: 99 }],
      },
    }));
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.gate === 'pr_lifecycle' && /closing relationship/.test(item.message)),
      JSON.stringify(packet.reasons));
  });

  it('an unmerged or unreviewed closing PR cannot complete', async () => {
    const open = await prepare('open-pr', lifecycleRunner({
      pr: { number: 5, state: 'OPEN', reviewDecision: 'APPROVED', reviews: [], closingIssuesReferences: [{ number: 1 }] },
    }));
    assert.equal(open.status, 1);
    assert.ok(JSON.parse(open.stdout).reasons.some(item => /not merged/.test(item.message)));

    const unreviewed = await prepare('unreviewed-pr', lifecycleRunner({
      pr: {
        number: 5, state: 'MERGED', mergedAt: '2026-07-27T12:00:00Z',
        mergeCommit: { oid: full }, reviewDecision: 'CHANGES_REQUESTED', reviews: [],
        closingIssuesReferences: [{ number: 1 }],
      },
    }));
    assert.equal(unreviewed.status, 1);
    assert.ok(JSON.parse(unreviewed.stdout).reasons.some(item => /accepted review/.test(item.message)));
  });

  it('rejects a stale historical approval when the current aggregate decision requests changes', () => {
    const candidate = 'a'.repeat(40);
    const result = evaluatePullRequestLifecycle([{
      number: 5,
      state: 'MERGED',
      mergedAt: '2026-07-27T12:00:00Z',
      mergeCommit: { oid: candidate },
      reviewDecision: 'CHANGES_REQUESTED',
      reviews: [{ state: 'APPROVED' }],
      closingIssuesReferences: [{ number: 1 }],
    }], 1, candidate);

    assert.equal(result.ok, false);
    assert.match(result.error, /no accepted review/);
  });

  it('a merge commit that does not match the certified candidate cannot complete', async () => {
    const result = await prepare('merge-mismatch', lifecycleRunner({
      pr: {
        number: 5, state: 'MERGED', mergedAt: '2026-07-27T12:00:00Z',
        mergeCommit: { oid: 'b'.repeat(40) }, reviewDecision: 'APPROVED', reviews: [],
        closingIssuesReferences: [{ number: 1 }],
      },
    }));
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).reasons.some(item => /certified candidate/.test(item.message)));
  });

  it('a valid reviewed, merged, candidate-bound closing PR completes', async () => {
    const result = await prepare('valid-pr', lifecycleRunner());
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, true);
    assert.ok(packet.gates.some(gate => gate.id === 'pr_lifecycle' && gate.passed === true));
  });
});

describe('digest-idempotent marker publication', () => {
  const digest = 'sha256:' + 'd'.repeat(64);
  const markerBody = [
    'AGENT_CLOSEOUT_STATUS: complete',
    'AGENT_CLOSEOUT_SCHEMA: 2',
    'AGENT_CLOSEOUT_WORK_UNIT: milestone:M00',
    'AGENT_CLOSEOUT_ARTIFACT: commit:' + 'a'.repeat(40),
    'AGENT_CLOSEOUT_AUDIT: AUD-001/run:1',
    'AGENT_CLOSEOUT_AUDIT_ASSURANCE: session_reported',
    'AGENT_CLOSEOUT_AUDIT_PRODUCER_AUTHENTICATED: false',
    'AGENT_CLOSEOUT_PREDECESSOR: none',
    'AGENT_CLOSEOUT_PLAN_SYNC: none',
    'AGENT_CLOSEOUT_IMPROVEMENTS: none',
    `AGENT_CLOSEOUT_GATE: ${digest}`,
  ].join('\n');

  it('recovers an ambiguous post by locating the exact digest and never duplicates', () => {
    const calls = [];
    let comments = [];
    const runner = (command, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'issue' && args[1] === 'comment') {
        // Simulate a remote success with an ambiguous client-side failure.
        comments = [{ id: 42, body: markerBody }];
        return { status: 1, stdout: '', stderr: 'connection reset after post' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ comments, updatedAt: 'now' }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    const result = publishGitHubCloseoutMarker(runner, {
      issueNumber: 7,
      markerBody,
      digest,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ambiguousRecovered, true);
    assert.equal(result.commentId, 42);
    // Exactly one mutation call was attempted; recovery is read-only.
    assert.equal(calls.filter(call => call.startsWith('issue comment')).length, 1);
  });

  it('reports a genuine publication failure when no digest appears remotely', () => {
    const runner = (command, args) => {
      if (args[0] === 'issue' && args[1] === 'comment') {
        return { status: 1, stdout: '', stderr: 'permission denied' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ comments: [], updatedAt: 'now' }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    const result = publishGitHubCloseoutMarker(runner, { issueNumber: 7, markerBody, digest });
    assert.equal(result.ok, false);
    assert.match(result.error, /permission denied/);
  });

  it('finds an existing marker by digest for idempotent retries', () => {
    const found = findMarkerByDigest([{ id: 9, body: `note\n\n${markerBody}\n` }], digest);
    assert.equal(found.found, true);
    assert.equal(found.commentId, 9);
    assert.equal(findMarkerByDigest([{ id: 9, body: 'unrelated' }], digest).found, false);
  });

  it('ignores superseded, untrusted, and fenced example marker digests', () => {
    const old = markerBody;
    const current = markerBody
      .replace(`AGENT_CLOSEOUT_GATE: ${digest}`, `AGENT_CLOSEOUT_GATE: sha256:${'e'.repeat(64)}`)
      .replace('AGENT_CLOSEOUT_PREDECESSOR: none', `AGENT_CLOSEOUT_PREDECESSOR: ${digest}`)
      .concat(`\nAGENT_CLOSEOUT_SUPERSEDES: ${digest}`);
    const comments = [
      { id: 1, author: { login: 'loop' }, body: old },
      { id: 2, author: { login: 'loop' }, body: current },
      { id: 3, author: { login: 'human' }, body: markerBody },
      { id: 4, author: { login: 'loop' }, body: `\`\`\`text\n${markerBody}\n\`\`\`` },
    ];
    assert.equal(findMarkerByDigest(comments, digest, 'loop').found, false);
    assert.equal(findMarkerByDigest(comments, `sha256:${'e'.repeat(64)}`, 'loop').found, true);
  });
});

describe('github closeout evaluation', () => {
  function makeTarget(name, config = {}) {
    const target = mkdtempSync(join(tmpDir, `${name}-`));
    mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
    mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'project.md'), [
      '---',
      'setup_status: confirmed',
      'development_stage: expansion',
      'task_backend: github',
      'work_unit_audit: enabled',
      'grouping_profile: milestone',
      ...Object.entries(config).map(([key, value]) => `${key}: ${value}`),
      '---',
      '',
      '# Project',
      '',
    ].join('\n'), 'utf-8');
    return target;
  }

  function closeoutHarness({ publishVisible = true, conflictOnFinalRead = false } = {}) {
    const full = 'a'.repeat(40);
    const carrier = { body: coveredTaskBody('accepted') };
    const issues = [issue(1, { state: 'CLOSED', body: carrier.body })];
    const comments = [];
    const state = { recording: false, commentReads: 0, postAttempts: 0 };
    const mergedPr = {
      number: 5,
      state: 'MERGED',
      mergedAt: '2026-07-27T12:00:00Z',
      mergeCommit: { oid: full },
      headRefOid: full,
      reviewDecision: 'APPROVED',
      reviews: [],
      closingIssuesReferences: [{ number: 1 }],
    };
    const conflictingMarker = renderCloseoutMarker({
      status: 'blocked',
      workUnit: 'milestone:M00',
      artifact: `commit:${full}`,
      auditRef: 'none',
      predecessor: 'none',
      planSync: 'none',
      improvementRefs: [],
      gateDigest: `sha256:${'f'.repeat(64)}`,
    });
    const runner = (_command, args) => {
      if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return { status: 0, stdout: JSON.stringify({ closedByPullRequestsReferences: [{ number: 5 }] }), stderr: '' };
      }
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && String(args[args.indexOf('--json') + 1] ?? '').includes('body')) {
        return { status: 0, stdout: JSON.stringify({ number: 1, body: carrier.body }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        if (state.recording) {
          state.commentReads += 1;
          if (conflictOnFinalRead && state.commentReads === 3 && comments.length === 0) {
            comments.push({ id: 99, author: { login: 'loop' }, body: conflictingMarker });
          }
        }
        return { status: 0, stdout: JSON.stringify({ comments, updatedAt: 'now' }), stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify(mergedPr), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'comment') {
        state.postAttempts += 1;
        if (publishVisible) {
          comments.push({ id: comments.length + 1, author: { login: 'loop' }, body: args[args.indexOf('--body') + 1] });
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        carrier.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        issues[0].body = carrier.body;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    return { full, carrier, comments, state, runner };
  }

  it('blocks completion when a covered GitHub task was reopened after certification', async () => {
    const target = makeTarget('reopened');
    const issues = [
      issue(1, { state: 'CLOSED', body: '---\ntask_id: T-001\n---\n' }),
      issue(2, { state: 'OPEN', body: '---\ntask_id: T-002\n---\n' }),
    ];
    const ghCommandRunner = () => ({ status: 0, stdout: JSON.stringify(issues), stderr: '' });
    const result = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00',
      '--covered-tasks', 'T-001,T-002',
      '--artifact', 'commit:' + 'a'.repeat(40),
      '--json', '--target', target,
    ], { ghCommandRunner });
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.ok(packet.reasons.some(item => /T-002/.test(item.message) && /closed/.test(item.message)));
  });

  it('fails closed on duplicate carriers naming both issues', async () => {
    const target = makeTarget('duplicates');
    const issues = [
      issue(7, { state: 'CLOSED', body: '---\ntask_id: T-007\n---\n' }),
      issue(12, { state: 'CLOSED', body: '---\ntask_id: T-007\n---\n' }),
    ];
    const ghCommandRunner = () => ({ status: 0, stdout: JSON.stringify(issues), stderr: '' });
    const result = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00',
      '--covered-tasks', 'T-007',
      '--artifact', 'commit:' + 'a'.repeat(40),
      '--json', '--target', target,
    ], { ghCommandRunner });
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.reasons.some(item => item.category === 'identity_conflict' && /#7/.test(item.message) && /#12/.test(item.message)));
  });

  it('never passes on a truncated inventory', async () => {
    const target = makeTarget('truncated');
    const issues = Array.from({ length: 1001 }, (_, index) =>
      issue(index + 1, { state: 'CLOSED', body: `---\ntask_id: T-${String(index + 1).padStart(3, '0')}\n---\n` }));
    const ghCommandRunner = () => ({ status: 0, stdout: JSON.stringify(issues), stderr: '' });
    const result = await runCliInProcess([
      'closeout', 'prepare', '--work-unit', 'milestone:M00',
      '--covered-tasks', 'T-001',
      '--artifact', 'commit:' + 'a'.repeat(40),
      '--json', '--target', target,
    ], { ghCommandRunner });
    assert.equal(result.status, 1);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.completion_eligible, false);
    assert.ok(packet.reasons.some(item => item.category === 'inventory_incomplete'));
  });

  it('records a trusted GitHub marker and reconstructs status after the packet is deleted', async () => {
    const target = makeTarget('lifecycle', { work_unit_audit: 'disabled' });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    const full = 'a'.repeat(40);
    // The closeout-owned terminal transition reads and rewrites the covered
    // carrier body, so this fake transport serves and stores it.
    const carrier = { body: coveredTaskBody('accepted') };
    const issues = [issue(1, { state: 'CLOSED', body: carrier.body })];
    const comments = [];
    const mergedPr = {
      number: 5,
      state: 'MERGED',
      mergedAt: '2026-07-27T12:00:00Z',
      mergeCommit: { oid: full },
      headRefOid: full,
      reviewDecision: 'APPROVED',
      reviews: [],
      closingIssuesReferences: [{ number: 1 }],
    };
    const runner = (command, args) => {
      if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return { status: 0, stdout: JSON.stringify({ closedByPullRequestsReferences: [{ number: 5 }] }), stderr: '' };
      }
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && String(args[args.indexOf('--json') + 1] ?? '').includes('body')) {
        return { status: 0, stdout: JSON.stringify({ number: 1, body: carrier.body }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments, updatedAt: 'now' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify(mergedPr), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'comment') {
        comments.push({ id: comments.length + 1, author: { login: 'loop' }, body: args[args.indexOf('--body') + 1] });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
        carrier.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
        issues[0].body = carrier.body;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const packetPath = join(target, '.agenticloop', 'tmp', 'github-packet.json');
    const prepared = await runCliInProcess(legacyPrepareArgs([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${full}`, '--output', packetPath, '--target', target,
    ]), legacyOptions(runner));
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    const recorded = await runCliInProcess([
      'closeout', 'record', '--packet', packetPath, '--yes', '--target', target,
    ], legacyOptions(runner));
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    assert.equal(comments.length, 1);
    // The canonical closeout-owned terminal transition reaches `closed`.
    assert.match(recorded.stdout, /closeout_owned_accepted_to_closed/);
    assert.match(carrier.body, /status: "?closed"?/);
    (await import('node:fs')).unlinkSync(packetPath);
    const status = await runCliInProcess([
      'closeout', 'status', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001', '--target', target,
    ], legacyOptions(runner));
    assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
    assert.match(status.stdout, /complete \(current\)/);
  });

  it('does not close covered tasks when a successful post is not remotely visible', async () => {
    const target = makeTarget('post-not-visible', { work_unit_audit: 'disabled' });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    const harness = closeoutHarness({ publishVisible: false });
    const packetPath = join(target, '.agenticloop', 'tmp', 'github-packet.json');
    const prepared = await runCliInProcess(legacyPrepareArgs([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${harness.full}`, '--output', packetPath, '--target', target,
    ]), legacyOptions(harness.runner));
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    harness.state.recording = true;
    const recorded = await runCliInProcess([
      'closeout', 'record', '--packet', packetPath, '--yes', '--target', target,
    ], legacyOptions(harness.runner));
    assert.equal(recorded.status, 1);
    assert.match(recorded.stderr, /not the unique current packet/);
    assert.equal(harness.state.postAttempts, 1);
    assert.deepEqual(harness.comments, []);
    assert.match(harness.carrier.body, /status: accepted/);
  });

  it('refuses publication when the trusted marker carrier changes after final evaluation', async () => {
    const target = makeTarget('marker-race', { work_unit_audit: 'disabled' });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    const harness = closeoutHarness({ conflictOnFinalRead: true });
    const packetPath = join(target, '.agenticloop', 'tmp', 'github-packet.json');
    const prepared = await runCliInProcess(legacyPrepareArgs([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${harness.full}`, '--output', packetPath, '--target', target,
    ]), legacyOptions(harness.runner));
    assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
    harness.state.recording = true;
    const recorded = await runCliInProcess([
      'closeout', 'record', '--packet', packetPath, '--yes', '--target', target,
    ], legacyOptions(harness.runner));
    assert.equal(recorded.status, 1);
    assert.match(recorded.stderr, /marker carrier changed after final evaluation/);
    assert.equal(harness.state.postAttempts, 0);
    assert.equal(harness.comments.length, 1);
    assert.match(harness.carrier.body, /status: accepted/);
  });

  it('refuses GitHub publication when a covered task reopens in the final snapshot', async () => {
    const target = makeTarget('final-reopen', { work_unit_audit: 'disabled' });
    mkdirSync(join(target, '.agenticloop', 'tmp'), { recursive: true });
    const full = 'a'.repeat(40);
    const comments = [];
    const mergedPr = {
      number: 5,
      state: 'MERGED',
      mergedAt: '2026-07-27T12:00:00Z',
      mergeCommit: { oid: full },
      headRefOid: full,
      reviewDecision: 'APPROVED',
      reviews: [],
      closingIssuesReferences: [{ number: 1 }],
    };
    let inventoryReads = 0;
    const runner = (command, args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        inventoryReads += 1;
        return { status: 0, stdout: JSON.stringify([issue(1, {
          state: inventoryReads >= 3 ? 'OPEN' : 'CLOSED', body: coveredTaskBody('accepted'),
        })]), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop' }), stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
        return { status: 0, stdout: JSON.stringify({ closedByPullRequestsReferences: [{ number: 5 }] }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view' && String(args[args.indexOf('--json') + 1] ?? '').includes('body')) {
        return { status: 0, stdout: JSON.stringify({ number: 1, body: coveredTaskBody('accepted') }), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments, updatedAt: 'now' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify(mergedPr), stderr: '' };
      if (args[0] === 'issue' && args[1] === 'comment') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const packetPath = join(target, '.agenticloop', 'tmp', 'github-packet.json');
    assert.equal((await runCliInProcess(legacyPrepareArgs([
      'closeout', 'prepare', '--work-unit', 'milestone:M00', '--covered-tasks', 'T-001',
      '--artifact', `commit:${full}`, '--output', packetPath, '--target', target,
    ]), legacyOptions(runner))).status, 0);
    const recorded = await runCliInProcess([
      'closeout', 'record', '--packet', packetPath, '--yes', '--target', target,
    ], legacyOptions(runner));
    assert.equal(recorded.status, 1);
    assert.match(recorded.stderr, /GitHub state changed/);
    assert.deepEqual(comments, []);
  });
});
