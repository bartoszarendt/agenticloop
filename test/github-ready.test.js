/**
 * Tests for src/github-ready.js - the composite, read-only pre-merge gate.
 *
 * Covers:
 *   - both component checks pass
 *   - preflight fails while review passes
 *   - review fails while preflight passes
 *   - both fail and errors are combined
 *   - missing PR argument
 *   - explicit issue and repository options are propagated
 *   - JSON-shaped result has the documented shape
 *   - human-readable output contains the final ready verdict
 *   - mismatched linked issue or PR head fails closed
 *   - no mutation-oriented GitHub commands are invoked
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitHubReady, formatGitHubReadyReport, GitHubReadyError } from '../src/github-ready.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OTHER_HEAD = 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const LOOP_ACCOUNT = { login: 'loop-bot', type: 'User' };

function reviewMarker(head = HEAD) {
  return {
    body: [
      'AGENT_REVIEW_STATUS: accepted',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${head}`,
      '[[agent: maintainer]]',
    ].join('\n'),
    author: LOOP_ACCOUNT,
  };
}

function evidenceBody(head = HEAD) {
  return [
    '## Scope Completed',
    'Did the thing.',
    '',
    '## Evidence',
    `Current PR head: ${head}`,
    '',
    '- Required check: [RC-1] `npm test`',
    '  Verdict: passed',
    '  Evidence: 10 passing (exit 0)',
    '',
    'Closes #7',
  ].join('\n');
}

function issueBody() {
  return ['## Required Checks', '- [RC-1] `npm test`', '', '## Acceptance Criteria', '- done'].join('\n');
}

function makePr(overrides = {}) {
  return {
    number: 42,
    headRefOid: HEAD,
    body: evidenceBody(HEAD),
    files: [{ path: 'src/x.js' }],
    closingIssuesReferences: [{ number: 7 }],
    statusCheckRollup: [],
    comments: [reviewMarker(HEAD)],
    reviews: [],
    ...overrides,
  };
}

function makeIssue(overrides = {}) {
  return { number: 7, body: issueBody(), title: 'T-001', ...overrides };
}

/**
 * Build an injectable gh runner that serves account/PR/issue/repo reads. Every
 * call's args are pushed onto `record` so tests can assert propagation and the
 * absence of mutation commands. `prFor` may return a different PR object based
 * on the requested JSON fields, to model head/issue disagreement.
 */
function makeRunner({ prData, issueData, prFor, record } = {}) {
  return (_command, args) => {
    if (record) record.push(args);
    if (args[0] === 'api' && args[1] === 'user') {
      return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const fields = args[args.indexOf('--json') + 1] ?? '';
      const data = prFor ? prFor(fields) : prData;
      return { status: 0, stdout: JSON.stringify(data), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
    }
    if (args[0] === 'repo' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
    }
    return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
  };
}

describe('github-ready composite gate', () => {
  it('passes when both component checks pass and returns the documented JSON shape', () => {
    const runner = makeRunner({ prData: makePr(), issueData: makeIssue() });
    const result = runGitHubReady({ pr: 42, commandRunner: runner });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.readyForMerge, true);
    assert.equal(result.pr, 42);
    assert.equal(result.issue, 7);
    assert.equal(result.headRefOid, HEAD);
    assert.deepEqual(result.preflight, { ok: true, errors: [] });
    assert.deepEqual(result.reviewAudit, {
      ok: true,
      acceptanceReady: true,
      independentReviewRequired: false,
      errors: [],
    });
    assert.deepEqual(result.errors, []);
    // Documented top-level keys only.
    assert.deepEqual(
      Object.keys(result).sort(),
      ['errors', 'headRefOid', 'issue', 'ok', 'pr', 'preflight', 'readyForMerge', 'reviewAudit'].sort()
    );
  });

  it('surfaces independent-review-required from the linked issue', () => {
    const issue = makeIssue({ body: `---\nindependent_review_required: true\n---\n\n${issueBody()}` });
    const runner = makeRunner({ prData: makePr(), issueData: issue });
    const result = runGitHubReady({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.reviewAudit.independentReviewRequired, true);
  });

  it('fails when the preflight fails while the review passes', () => {
    // A PR body with no `## Evidence` section fails preflight; the review marker
    // lives in comments, so the review audit still passes.
    const prData = makePr({ body: '## Scope Completed\nNo evidence section here.\n\nCloses #7' });
    const runner = makeRunner({ prData, issueData: makeIssue() });
    const result = runGitHubReady({ pr: 42, commandRunner: runner });

    assert.equal(result.ok, false);
    assert.equal(result.readyForMerge, false);
    assert.equal(result.preflight.ok, false);
    assert.equal(result.reviewAudit.ok, true);
    assert.match(result.preflight.errors.join('\n'), /Evidence/);
  });

  it('fails when the review fails while the preflight passes', () => {
    // A stale review marker (old head) fails the audit; evidence still cites HEAD.
    const prData = makePr({ comments: [reviewMarker(OTHER_HEAD)] });
    const runner = makeRunner({ prData, issueData: makeIssue() });
    const result = runGitHubReady({ pr: 42, commandRunner: runner });

    assert.equal(result.ok, false);
    assert.equal(result.preflight.ok, true);
    assert.equal(result.reviewAudit.ok, false);
    assert.match(result.reviewAudit.errors.join('\n'), /stale/);
  });

  it('combines errors when both checks fail', () => {
    const prData = makePr({
      body: '## Scope Completed\nNo evidence section here.\n\nCloses #7',
      comments: [reviewMarker(OTHER_HEAD)],
    });
    const runner = makeRunner({ prData, issueData: makeIssue() });
    const result = runGitHubReady({ pr: 42, commandRunner: runner });

    assert.equal(result.ok, false);
    assert.equal(result.preflight.ok, false);
    assert.equal(result.reviewAudit.ok, false);
    assert.ok(result.preflight.errors.length > 0);
    assert.ok(result.reviewAudit.errors.length > 0);
  });

  it('throws GitHubReadyError when the PR argument is missing', () => {
    assert.throws(() => runGitHubReady({}), GitHubReadyError);
    assert.throws(() => runGitHubReady({ pr: 'abc' }), /positive integer/);
  });

  it('propagates explicit issue and repository options to gh reads', () => {
    const record = [];
    const runner = makeRunner({ prData: makePr(), issueData: makeIssue(), record });
    const result = runGitHubReady({ pr: 42, issue: 7, repo: 'explicit/repo', commandRunner: runner });

    assert.equal(result.ok, true, JSON.stringify(result));
    // --repo forwarded to every pr view, and the resolved issue 7 was viewed.
    const prViews = record.filter(args => args[0] === 'pr' && args[1] === 'view');
    assert.ok(prViews.length > 0);
    for (const args of prViews) {
      assert.ok(args.includes('--repo') && args.includes('explicit/repo'), args.join(' '));
    }
    const issueViews = record.filter(args => args[0] === 'issue' && args[1] === 'view');
    assert.ok(issueViews.length > 0);
    for (const args of issueViews) assert.ok(args.includes('7'), args.join(' '));
  });

  it('rejects an explicit issue that is not a closing reference (issue option reaches the audit)', () => {
    const runner = makeRunner({ prData: makePr(), issueData: makeIssue() });
    // Issue 99 is not in closingIssuesReferences; the audit throws, captured as an error.
    const result = runGitHubReady({ pr: 42, issue: 99, commandRunner: runner });
    assert.equal(result.ok, false);
    assert.match(result.reviewAudit.errors.join('\n'), /not one of the PR's closing issues/);
  });

  it('fails closed when the two checks resolve different PR heads', () => {
    // The preflight requests statusCheckRollup; the review audit requests reviews.
    // Return a different head to each so the cross-check trips.
    const prFor = fields => {
      const isPreflight = fields.includes('statusCheckRollup');
      return makePr({ headRefOid: isPreflight ? HEAD : OTHER_HEAD });
    };
    const runner = makeRunner({ prFor, issueData: makeIssue() });
    const result = runGitHubReady({ pr: 42, commandRunner: runner });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /different PR heads/);
  });

  it('fails closed when the two checks resolve different linked issues', () => {
    // The preflight requests statusCheckRollup; the review audit requests reviews.
    // Give the preflight one closing issue and the review audit another so both
    // resolve a single (but different) issue.
    const prFor = fields => {
      const isPreflight = fields.includes('statusCheckRollup');
      return makePr({ closingIssuesReferences: [{ number: isPreflight ? 7 : 8 }] });
    };
    // The issue view must satisfy whichever number is asked for; return by title.
    const runner = (_command, args) => {
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') {
        const fields = args[args.indexOf('--json') + 1] ?? '';
        return { status: 0, stdout: JSON.stringify(prFor(fields)), stderr: '' };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        const number = Number(args[2]);
        return { status: 0, stdout: JSON.stringify(makeIssue({ number })), stderr: '' };
      }
      return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
    };
    const result = runGitHubReady({ pr: 42, commandRunner: runner });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /different linked issues/);
  });

  it('invokes only read-only gh commands (no merge/comment/review/edit)', () => {
    const record = [];
    const runner = makeRunner({ prData: makePr(), issueData: makeIssue(), record });
    runGitHubReady({ pr: 42, commandRunner: runner });

    const mutationVerbs = new Set(['merge', 'comment', 'review', 'edit', 'close', 'create', 'delete', 'lock', 'reopen']);
    assert.ok(record.length > 0);
    for (const args of record) {
      assert.ok(!mutationVerbs.has(args[1]), `unexpected mutation command: ${args.join(' ')}`);
      if (args[0] === 'api') {
        // No write method flags on any REST call.
        assert.ok(!args.includes('-X') && !args.includes('--method'), `unexpected api method: ${args.join(' ')}`);
      }
    }
  });

  it('human-readable report contains the final ready-for-merge verdict', () => {
    const runner = makeRunner({ prData: makePr(), issueData: makeIssue() });
    const passResult = runGitHubReady({ pr: 42, commandRunner: runner });
    const passReport = formatGitHubReadyReport(passResult).summary.join('\n');
    assert.match(passReport, /ready for merge: yes/);
    assert.match(passReport, /PR: #42/);

    const failRunner = makeRunner({ prData: makePr({ comments: [reviewMarker(OTHER_HEAD)] }), issueData: makeIssue() });
    const failResult = runGitHubReady({ pr: 42, commandRunner: failRunner });
    const failReport = formatGitHubReadyReport(failResult);
    assert.match(failReport.summary.join('\n'), /ready for merge: no/);
    assert.ok(failReport.errors.length > 0);
  });
});

describe('github-ready CLI', () => {
  it('help lists github-ready alongside the existing GitHub gates', () => {
    const result = runCli(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /github-ready/);
    // Existing commands remain documented.
    assert.match(result.stdout, /github-preflight/);
    assert.match(result.stdout, /github-review-audit/);
  });

  it('exits 1 with a clear message when --pr is missing', () => {
    const result = runCli(['github-ready']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--pr/);
  });

  it('emits an error JSON envelope when --pr is missing and --json is set', () => {
    const result = runCli(['github-ready', '--json']);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.readyForMerge, false);
    assert.ok(Array.isArray(parsed.errors) && parsed.errors.length > 0);
  });
});
