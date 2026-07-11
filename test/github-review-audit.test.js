import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGitHubReviewAudit, runGitHubReviewAudit, GitHubReviewAuditError, normalizeRestReview, taskRequiresIndependentReview } from '../src/github-review-audit.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OLD_HEAD = 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const LOOP_ACCOUNT = { login: 'loop-bot', type: 'User' };

function marker({ status = 'accepted', mode = 'host_subagent', artifact = HEAD, humanRef = '', author = LOOP_ACCOUNT, includeTrailer = true } = {}) {
  const body = [
    `AGENT_REVIEW_STATUS: ${status}`,
    `AGENT_REVIEW_MODE: ${mode}`,
    `AGENT_REVIEW_ARTIFACT: ${artifact}`,
    ...(humanRef ? [`AGENT_HUMAN_REVIEW_REF: ${humanRef}`] : []),
    ...(includeTrailer ? ['[[agent: maintainer]]'] : []),
  ].join('\n');
  return { body, author };
}

function markerString(markerObj) {
  return typeof markerObj === 'string' ? markerObj : markerObj.body;
}

function data({ comments = [marker()], reviews = [], humanReviews = [], independent = false } = {}) {
  return {
    prData: { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments, reviews },
    issueData: { number: 7, body: independent ? 'AGENT_INDEPENDENT_REVIEW_REQUIRED: true' : '' },
    expectedAccount: LOOP_ACCOUNT,
    humanReviews,
  };
}

describe('GitHub review provenance audit', () => {
  it('passes a current-head accepted marker and returns stable JSON data', () => {
    const result = evaluateGitHubReviewAudit(data());
    assert.equal(result.ok, true);
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, true);
    assert.equal(result.expectedStatus, 'accepted');
    assert.deepEqual(result.errors, []);
    assert.equal(result.pr, 42);
    assert.equal(result.issue, 7);
    assert.equal(result.headRefOid, HEAD);
    assert.equal(result.independentReviewRequired, false);
    assert.deepEqual(result.outcome, { status: 'accepted', mode: 'host_subagent', artifact: HEAD, humanReviewRef: '', author: 'loop-bot' });
  });

  it('rejects older-head, missing-mode, missing-artifact, and unsupported markers', () => {
    assert.match(evaluateGitHubReviewAudit(data({ comments: [marker({ artifact: OLD_HEAD })] })).errors.join('\n'), /stale/);
    assert.match(evaluateGitHubReviewAudit(data({ comments: [{ body: `AGENT_REVIEW_STATUS: accepted\nAGENT_REVIEW_ARTIFACT: ${HEAD}`, author: LOOP_ACCOUNT }] })).errors.join('\n'), /exactly one mode/);
    assert.match(evaluateGitHubReviewAudit(data({ comments: [{ body: 'AGENT_REVIEW_STATUS: accepted\nAGENT_REVIEW_MODE: host_subagent\n[[agent: maintainer]]', author: LOOP_ACCOUNT }] })).errors.join('\n'), /exactly one artifact/);
    assert.match(evaluateGitHubReviewAudit(data({ comments: [marker({ mode: 'unknown' })] })).errors.join('\n'), /unsupported review mode/);
  });

  it('enforces independent review from the linked task issue', () => {
    assert.match(evaluateGitHubReviewAudit(data({ independent: true, comments: [marker({ mode: 'single_agent_fallback' })] })).errors.join('\n'), /cannot accept/);
    assert.equal(evaluateGitHubReviewAudit(data({ independent: true, comments: [marker({ mode: 'host_subagent' })] })).ok, true);
  });

  it('requires and resolves an independent-human reference', () => {
    assert.match(evaluateGitHubReviewAudit(data({ comments: [marker({ mode: 'independent_human' })] })).errors.join('\n'), /HUMAN_REVIEW_REF/);
    const ref = 'https://github.com/o/r/pull/42#pullrequestreview-1';
    const result = evaluateGitHubReviewAudit(data({
      comments: [marker({ mode: 'independent_human', humanRef: ref })],
      humanReviews: [{ url: ref, id: 'pullrequestreview-1', state: 'APPROVED', commitOid: HEAD, author: { login: 'human', type: 'User' } }],
    }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects duplicate current-head outcomes', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [marker(), marker({ status: 'needs_revision' })] }));
    assert.match(result.errors.join('\n'), /duplicate/);
  });

  it('fails default audit for needs_revision outcome', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [marker({ status: 'needs_revision' })] }));
    assert.equal(result.ok, false);
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, false);
    assert.equal(result.expectedStatus, 'accepted');
    assert.match(result.errors.join('\n'), /needs_revision.*expected.*accepted/);
  });

  it('passes --expect-status needs_revision for needs_revision outcome', () => {
    const result = evaluateGitHubReviewAudit({ ...data({ comments: [marker({ status: 'needs_revision' })] }), expectedStatus: 'needs_revision' });
    assert.equal(result.ok, true);
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, false);
    assert.equal(result.expectedStatus, 'needs_revision');
    assert.deepEqual(result.errors, []);
  });

  it('fails --expect-status needs_revision for accepted outcome', () => {
    const result = evaluateGitHubReviewAudit({ ...data(), expectedStatus: 'needs_revision' });
    assert.equal(result.ok, false);
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, true);
    assert.match(result.errors.join('\n'), /accepted.*expected.*needs_revision/);
  });

  it('fails on invalid expected status', () => {
    const result = evaluateGitHubReviewAudit({ ...data(), expectedStatus: 'bogus' });
    assert.equal(result.ok, false);
    assert.equal(result.provenanceValid, false);
    assert.equal(result.acceptanceReady, false);
    assert.match(result.errors.join('\n'), /invalid --expect-status/);
  });

  it('fails when expected account cannot be resolved', () => {
    const result = evaluateGitHubReviewAudit({ ...data(), expectedAccount: null });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /expected loop account could not be resolved/);
  });

  it('fails when marker author is missing', () => {
    const d = data();
    d.prData.comments = [{ body: markerString(marker()), author: null }];
    const result = evaluateGitHubReviewAudit(d);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /marker author identity is missing/);
  });

  it('fails when marker author differs from expected account', () => {
    const result = evaluateGitHubReviewAudit(data({
      comments: [{ body: markerString(marker()), author: { login: 'other-bot', type: 'User' } }],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /does not match expected loop account/);
  });

  it('compares logins case-insensitively', () => {
    const result = evaluateGitHubReviewAudit(data({
      comments: [{ body: markerString(marker()), author: { login: 'LOOP-BOT', type: 'User' } }],
    }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects missing maintainer trailer even with correct author', () => {
    const d = data();
    d.prData.comments = [{ body: `AGENT_REVIEW_STATUS: accepted\nAGENT_REVIEW_MODE: host_subagent\nAGENT_REVIEW_ARTIFACT: ${HEAD}`, author: LOOP_ACCOUNT }];
    const result = evaluateGitHubReviewAudit(d);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing the maintainer attribution trailer/);
  });

  it('includes marker author in outcome JSON', () => {
    const result = evaluateGitHubReviewAudit(data());
    assert.equal(result.outcome.author, 'loop-bot');
  });

  it('uses the injected gh runner and fails conservatively on command errors', () => {
    const fixture = data();
    const runner = (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify(args[0] === 'pr' ? fixture.prData : fixture.issueData),
        stderr: '',
      };
    };
    assert.equal(runGitHubReviewAudit({ pr: 42, commandRunner: runner }).ok, true);
    assert.throws(() => runGitHubReviewAudit({ pr: 42, commandRunner: () => ({ status: 1, stderr: 'network failed' }) }), GitHubReviewAuditError);
  });

  it('fails when gh api user returns no login', () => {
    const fixture = data();
    const runner = (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify({ login: '', type: 'User' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? fixture.prData : fixture.issueData), stderr: '' };
    };
    assert.throws(() => runGitHubReviewAudit({ pr: 42, commandRunner: runner }), /no login/);
  });
});

describe('Independent human review verification', () => {
  const HUMAN_REVIEW_URL = 'https://github.com/o/r/pull/42#pullrequestreview-99';
  const HUMAN_REVIEW_ID = 'pullrequestreview-99';

  function humanReview(overrides = {}) {
    return {
      url: HUMAN_REVIEW_URL,
      id: HUMAN_REVIEW_ID,
      state: 'APPROVED',
      commitOid: HEAD,
      author: { login: 'human-reviewer', type: 'User' },
      ...overrides,
    };
  }

  function humanData(reviews, { mode = 'independent_human', humanRef = HUMAN_REVIEW_URL } = {}) {
    return data({
      comments: [marker({ mode, humanRef })],
      humanReviews: reviews,
    });
  }

  it('approved current-head human review by different user passes', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview()]));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, true);
  });

  it('review ID reference form also works', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview()], { humanRef: HUMAN_REVIEW_ID }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('missing human review author fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: null })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no login/);
  });

  it('empty login fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: '', type: 'User' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no login/);
  });

  it('explicit User type passes', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'human', type: 'User' } })]));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('User type is compared case-insensitively', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'human', type: 'user' } })]));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('missing author type fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'someone' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no explicit type/);
  });

  it('Bot author fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'dependabot[bot]', type: 'Bot' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /type 'Bot'/);
  });

  it('App/service identity fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'github-actions', type: 'App' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /type 'App'/);
  });

  it('Organization author fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'my-org', type: 'Organization' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /type 'Organization'/);
  });

  it('Mannequin author fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'legacy', type: 'Mannequin' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /type 'Mannequin'/);
  });

  it('arbitrary unknown author type fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'visitor', type: 'Alien' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /type 'Alien'/);
  });

  it('[bot] suffix fails even if the declared type is User', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'fake-human[bot]', type: 'User' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /ends with \[bot\]/);
  });

  it('same login as loop account fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ author: { login: 'loop-bot', type: 'User' } })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /must differ from the loop account/);
  });

  it('COMMENTED review fails for an accepted audit', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ state: 'COMMENTED' })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state is 'COMMENTED'/);
  });

  it('DISMISSED review fails for an accepted audit', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ state: 'DISMISSED' })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state is 'DISMISSED'/);
  });

  it('approved review for an old head fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ commitOid: OLD_HEAD })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /does not match current PR head/);
  });

  it('unknown/missing commit ID fails conservatively', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview({ commitOid: '' })]));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no commit binding/);
  });

  it('reference to a nonexistent review fails', () => {
    const result = evaluateGitHubReviewAudit(humanData([humanReview()], { humanRef: 'https://github.com/o/r/pull/42#pullrequestreview-999' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /does not match any review/);
  });

  it('missing human_review_ref fails', () => {
    const result = evaluateGitHubReviewAudit(data({
      comments: [marker({ mode: 'independent_human' })],
      humanReviews: [humanReview()],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /AGENT_HUMAN_REVIEW_REF/);
  });
});

describe('Review marker sources from PR review bodies', () => {
  const HUMAN_REVIEW_URL = 'https://github.com/o/r/pull/42#pullrequestreview-99';

  it('valid marker in comments still works', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [marker()], reviews: [] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('valid marker in GraphQL reviews works when comments is empty', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [], reviews: [marker()] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('review marker carries author identity from GraphQL review author', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [], reviews: [marker()] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.outcome.author, 'loop-bot');
  });

  it('GraphQL review marker with wrong author fails attribution', () => {
    const result = evaluateGitHubReviewAudit(data({
      comments: [],
      reviews: [marker({ author: { login: 'other-bot', type: 'User' } })],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /does not match expected loop account/);
  });

  it('stale GraphQL review marker fails', () => {
    const result = evaluateGitHubReviewAudit(data({
      comments: [],
      reviews: [marker({ artifact: OLD_HEAD })],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /stale/);
  });

  it('duplicate current markers split across comments and reviews fail', () => {
    const result = evaluateGitHubReviewAudit(data({
      comments: [marker()],
      reviews: [marker({ status: 'needs_revision' })],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /duplicate/);
  });

  it('current independent_human marker in GraphQL reviews triggers exactly one REST review fetch', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [],
      reviews: [marker({ mode: 'independent_human', humanRef: HUMAN_REVIEW_URL })],
    };
    const issueData = { number: 7, body: '' };
    let restCallCount = 0;
    const REST_REVIEW = {
      id: 99,
      html_url: HUMAN_REVIEW_URL,
      state: 'APPROVED',
      commit_id: HEAD,
      user: { login: 'human-reviewer', type: 'User' },
    };
    const runner = (_command, args) => {
      if (args[0] === 'api') {
        if (args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
        if (args.includes('--slurp')) {
          restCallCount += 1;
          return { status: 0, stdout: JSON.stringify([[REST_REVIEW]]), stderr: '' };
        }
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(restCallCount, 1);
  });

  it('non-human marker in GraphQL reviews does not trigger REST review fetch', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [],
      reviews: [marker({ mode: 'host_subagent' })],
    };
    const issueData = { number: 7, body: '' };
    const runner = (_command, args) => {
      if (args[0] === 'api') {
        if (args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
        if (args.includes('--slurp')) return { status: 1, stderr: 'unexpected REST review call' };
      }
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('normalized REST approval satisfies independent-human marker from GraphQL reviews', () => {
    const ref = 'https://github.com/o/r/pull/42#pullrequestreview-99';
    const result = evaluateGitHubReviewAudit(data({
      comments: [],
      reviews: [marker({ mode: 'independent_human', humanRef: ref })],
      humanReviews: [{ url: ref, id: 'pullrequestreview-99', state: 'APPROVED', commitOid: HEAD, author: { login: 'human-reviewer', type: 'User' } }],
    }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('GraphQL review objects are not used as normalized REST human-review evidence', () => {
    const ref = 'https://github.com/o/r/pull/42#pullrequestreview-99';
    const result = evaluateGitHubReviewAudit(data({
      comments: [],
      reviews: [{ body: markerString(marker({ mode: 'independent_human', humanRef: ref })), author: LOOP_ACCOUNT }],
      humanReviews: [],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /does not match any review/);
  });

  it('REST human reviews are not scanned as loop marker sources', () => {
    const restReview = { id: 99, html_url: 'https://github.com/o/r/pull/42#pullrequestreview-99', state: 'APPROVED', commit_id: HEAD, user: { login: 'human-reviewer', type: 'User' } };
    const result = evaluateGitHubReviewAudit(data({
      comments: [],
      reviews: [restReview],
    }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('mocked gh pr view result resembles actual CLI JSON with distinct comments and reviews arrays', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [{ body: 'comment body', author: LOOP_ACCOUNT }],
      reviews: [{ body: 'review body', author: LOOP_ACCOUNT }],
    };
    const issueData = { number: 7, body: '' };
    const runner = (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
    assert.equal(result.pr, 42);
  });

  it('gh pr view command requests the reviews JSON field', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments: [marker()], reviews: [] };
    const issueData = { number: 7, body: '' };
    let requestedFields = '';
    const runner = (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') {
        const idx = args.indexOf('--json');
        requestedFields = args[idx + 1];
      }
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
    runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(requestedFields.split(',').includes('reviews'), true);
  });
});

describe('Issue binding enforcement', () => {
  function issueRunner(prData, issueData = { number: 7, body: '' }) {
    return (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
  }

  it('one closing issue, no explicit issue: passes using the linked issue', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments: [marker()], reviews: [] };
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: issueRunner(prData) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.closingIssues, [7]);
    assert.equal(result.issue, 7);
  });

  it('one closing issue, same explicit issue: passes', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments: [marker()], reviews: [] };
    const result = runGitHubReviewAudit({ pr: 42, issue: 7, commandRunner: issueRunner(prData) });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('one closing issue, different explicit issue: fails', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments: [marker()], reviews: [] };
    assert.throws(() => runGitHubReviewAudit({ pr: 42, issue: 99, commandRunner: issueRunner(prData) }), /not one of the PR's closing issues/);
  });

  it('multiple closing issues, no explicit issue: fails', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }, { number: 8 }], comments: [marker()], reviews: [] };
    assert.throws(() => runGitHubReviewAudit({ pr: 42, commandRunner: issueRunner(prData) }), /closes multiple issues/);
  });

  it('multiple closing issues, selected member: passes', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }, { number: 8 }], comments: [marker()], reviews: [] };
    const result = runGitHubReviewAudit({ pr: 42, issue: 8, commandRunner: issueRunner(prData) });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.closingIssues, [7, 8]);
  });

  it('multiple closing issues, unrelated selection: fails', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }, { number: 8 }], comments: [marker()], reviews: [] };
    assert.throws(() => runGitHubReviewAudit({ pr: 42, issue: 99, commandRunner: issueRunner(prData) }), /not one of the PR's closing issues/);
  });

  it('no closing issues, explicit issue: fails', () => {
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [], comments: [marker()], reviews: [] };
    assert.throws(() => runGitHubReviewAudit({ pr: 42, issue: 7, commandRunner: issueRunner(prData) }), /no closing issue reference/);
  });

  it('independent-review marker is read only from the validated issue', () => {
    // Issue 7 has independent_review_required, issue 8 does not
    const prData = { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }, { number: 8 }], comments: [marker({ mode: 'host_subagent' })], reviews: [] };
    const issue7 = { number: 7, body: 'AGENT_INDEPENDENT_REVIEW_REQUIRED: true' };
    const issue8 = { number: 8, body: '' };

    const runner7 = (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issue7), stderr: '' };
    };
    const runner8 = (_command, args) => {
      if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issue8), stderr: '' };
    };

    const result7 = runGitHubReviewAudit({ pr: 42, issue: 7, commandRunner: runner7 });
    assert.equal(result7.independentReviewRequired, true);

    const result8 = runGitHubReviewAudit({ pr: 42, issue: 8, commandRunner: runner8 });
    assert.equal(result8.independentReviewRequired, false);
  });
});

describe('Quoted and example marker filtering', () => {
  function bodyWithMarker(bodyString) {
    return { body: bodyString, author: LOOP_ACCOUNT };
  }

  it('valid top-level marker passes', () => {
    const m = markerString(marker());
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(m)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('marker inside triple-backtick fence is ignored', () => {
    const body = `Example:\n\`\`\`\n${markerString(marker())}\n\`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('marker inside tilde fence is ignored', () => {
    const body = `Example:\n~~~\n${markerString(marker())}\n~~~\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('marker inside blockquote is ignored', () => {
    const body = `> ${markerString(marker()).split('\n').join('\n> ')}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('marker inside indented code is ignored', () => {
    const body = `Example:\n${markerString(marker()).split('\n').map(l => '    ' + l).join('\n')}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('example marker plus one live marker produces one current marker', () => {
    const example = `\`\`\`\n${markerString(marker({ status: 'needs_revision' }))}\n\`\`\``;
    const live = markerString(marker());
    const body = `${example}\n${live}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.outcome.status, 'accepted');
  });

  it('body containing only example markers fails with no live review marker', () => {
    const body = `\`\`\`\n${markerString(marker())}\n\`\`\`\n\n> ${markerString(marker({ status: 'needs_revision' })).split('\n').join('\n> ')}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('mixed line endings continue to work', () => {
    const body = markerString(marker()).replace(/\n/g, '\r\n');
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

describe('Outcome-sensitive human review state', () => {
  const HUMAN_REVIEW_URL = 'https://github.com/o/r/pull/42#pullrequestreview-99';

  function humanReview(state) {
    return {
      url: HUMAN_REVIEW_URL,
      id: 'pullrequestreview-99',
      state,
      commitOid: HEAD,
      author: { login: 'human-reviewer', type: 'User' },
    };
  }

  function humanData({ status, state, expectedStatus = status }) {
    return {
      ...data({
        comments: [marker({ mode: 'independent_human', status, humanRef: HUMAN_REVIEW_URL })],
        humanReviews: [humanReview(state)],
      }),
      expectedStatus,
    };
  }

  it('accepted plus APPROVED passes', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'accepted', state: 'APPROVED' }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, true);
  });

  it('accepted plus CHANGES_REQUESTED fails', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'accepted', state: 'CHANGES_REQUESTED' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state is 'CHANGES_REQUESTED'.*expected 'APPROVED'/);
    assert.equal(result.provenanceValid, false);
  });

  it('accepted plus COMMENTED fails', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'accepted', state: 'COMMENTED' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state is 'COMMENTED'.*expected 'APPROVED'/);
  });

  it('needs_revision plus CHANGES_REQUESTED passes', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'needs_revision', state: 'CHANGES_REQUESTED', expectedStatus: 'needs_revision' }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, false);
  });

  it('needs_revision plus APPROVED fails', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'needs_revision', state: 'APPROVED', expectedStatus: 'needs_revision' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state is 'APPROVED'.*expected 'CHANGES_REQUESTED'/);
  });

  it('needs_revision plus COMMENTED fails', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'needs_revision', state: 'COMMENTED', expectedStatus: 'needs_revision' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /state is 'COMMENTED'.*expected 'CHANGES_REQUESTED'/);
  });

  it('both statuses still require exact current-head binding', () => {
    const accepted = evaluateGitHubReviewAudit(humanData({ status: 'accepted', state: 'APPROVED' }));
    assert.equal(accepted.ok, true, accepted.errors.join('\n'));

    const base = humanData({ status: 'accepted', state: 'APPROVED' });
    const staleReview = humanReview('APPROVED');
    staleReview.commitOid = OLD_HEAD;
    const acceptedStale = evaluateGitHubReviewAudit({
      ...base,
      humanReviews: [staleReview],
    });
    assert.equal(acceptedStale.ok, false);
    assert.match(acceptedStale.errors.join('\n'), /does not match current PR head/);
  });

  it('both statuses still require a different explicit User account', () => {
    const baseAccepted = humanData({ status: 'accepted', state: 'APPROVED' });
    const acceptedLoop = evaluateGitHubReviewAudit({
      ...baseAccepted,
      humanReviews: [{ url: HUMAN_REVIEW_URL, id: '99', state: 'APPROVED', commitOid: HEAD, author: { login: 'loop-bot', type: 'User' } }],
    });
    assert.equal(acceptedLoop.ok, false);
    assert.match(acceptedLoop.errors.join('\n'), /must differ from the loop account/);

    const baseRevision = humanData({ status: 'needs_revision', state: 'CHANGES_REQUESTED', expectedStatus: 'needs_revision' });
    const revisionLoop = evaluateGitHubReviewAudit({
      ...baseRevision,
      humanReviews: [{ url: HUMAN_REVIEW_URL, id: '99', state: 'CHANGES_REQUESTED', commitOid: HEAD, author: { login: 'loop-bot', type: 'User' } }],
    });
    assert.equal(revisionLoop.ok, false);
    assert.match(revisionLoop.errors.join('\n'), /must differ from the loop account/);
  });

  it('default audit with human CHANGES_REQUESTED fails', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'accepted', state: 'CHANGES_REQUESTED' }));
    assert.equal(result.ok, false);
    assert.equal(result.expectedStatus, 'accepted');
    assert.match(result.errors.join('\n'), /expected 'APPROVED'/);
  });

  it('--expect-status needs_revision with human CHANGES_REQUESTED passes', () => {
    const result = evaluateGitHubReviewAudit(humanData({ status: 'needs_revision', state: 'CHANGES_REQUESTED', expectedStatus: 'needs_revision' }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, false);
    assert.equal(result.expectedStatus, 'needs_revision');
  });
});

describe('normalizeRestReview', () => {
  it('normalizes REST URL, id, state, commit_id, and user fields', () => {
    const normalized = normalizeRestReview({
      id: 80,
      html_url: 'https://github.com/o/r/pull/42#pullrequestreview-80',
      state: 'APPROVED',
      commit_id: HEAD,
      user: { login: 'reviewer', type: 'User' },
    });
    assert.equal(normalized.id, '80');
    assert.equal(normalized.url, 'https://github.com/o/r/pull/42#pullrequestreview-80');
    assert.equal(normalized.state, 'APPROVED');
    assert.equal(normalized.commitOid, HEAD);
    assert.deepEqual(normalized.author, { login: 'reviewer', type: 'User' });
  });

  it('coerces state and commit_id to canonical casing', () => {
    const normalized = normalizeRestReview({
      id: '99',
      html_url: 'url',
      state: 'changes_requested',
      commit_id: 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0',
      user: { login: 'x', type: 'user' },
    });
    assert.equal(normalized.state, 'CHANGES_REQUESTED');
    assert.equal(normalized.commitOid, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
  });

  it('fails when required fields are missing', () => {
    assert.throws(() => normalizeRestReview({}), GitHubReviewAuditError);
    assert.throws(() => normalizeRestReview({ id: 1, html_url: 'u', state: 'APPROVED', commit_id: 'sha', user: null }), GitHubReviewAuditError);
  });
});

describe('runGitHubReviewAudit REST review fetching', () => {
  const HUMAN_REVIEW_URL = 'https://github.com/o/r/pull/42#pullrequestreview-99';
  const REST_REVIEW = {
    id: 99,
    html_url: HUMAN_REVIEW_URL,
    state: 'APPROVED',
    commit_id: HEAD,
    user: { login: 'human-reviewer', type: 'User' },
  };

  function humanMarker({ status = 'accepted' } = {}) {
    return marker({ mode: 'independent_human', humanRef: HUMAN_REVIEW_URL, status });
  }

  function makeRunner({ prData, issueData, repoName, restResponse, restError, forbidRestCall = false }) {
    return (_command, args) => {
      if (args[0] === 'api') {
        if (args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
        if (args.includes('--slurp')) {
          if (forbidRestCall) return { status: 1, stderr: 'unexpected REST review call' };
          if (restError) return { status: 1, stderr: restError };
          return { status: 0, stdout: JSON.stringify(restResponse), stderr: '' };
        }
        return { status: 1, stderr: 'unexpected api call' };
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: repoName ?? 'o/r' }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
  }

  it('independent-human path performs the REST review request', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [humanMarker()],
    };
    const issueData = { number: 7, body: '' };
    const runner = makeRunner({ prData, issueData, restResponse: [[REST_REVIEW]] });
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, true);
  });

  it('non-human modes do not perform the REST review request', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [marker({ mode: 'host_subagent' })],
    };
    const issueData = { number: 7, body: '' };
    const runner = makeRunner({ prData, issueData, forbidRestCall: true });
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('REST failure for independent-human returns provenanceValid false without throwing', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [humanMarker()],
    };
    const issueData = { number: 7, body: '' };
    const runner = makeRunner({ prData, issueData, restError: 'network failed' });
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, false);
    assert.equal(result.provenanceValid, false);
    assert.equal(result.acceptanceReady, false);
    assert.match(result.errors.join('\n'), /network failed/);
  });

  it('malformed REST data fails conservatively for independent-human', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [humanMarker()],
    };
    const issueData = { number: 7, body: '' };
    const runner = makeRunner({ prData, issueData, restResponse: [[{ id: 99, state: 'APPROVED' }]] });
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, false);
    assert.equal(result.provenanceValid, false);
    assert.match(result.errors.join('\n'), /missing html_url|missing commit_id|missing user/);
  });

  it('paginated pages are flattened', () => {
    const page1 = [{ ...REST_REVIEW, id: 1, html_url: 'https://github.com/o/r/pull/42#pullrequestreview-1' }];
    const page2 = [REST_REVIEW];
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [humanMarker({ status: 'needs_revision' })],
    };
    const issueData = { number: 7, body: '' };
    const runner = makeRunner({ prData, issueData, restResponse: [page1, page2] });
    const result = runGitHubReviewAudit({ pr: 42, expectedStatus: 'needs_revision', commandRunner: runner });
    // The human marker status is needs_revision, but the REST review is APPROVED, so it should fail
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /expected 'CHANGES_REQUESTED'/);
  });

  it('--repo is used for the REST review endpoint', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [humanMarker()],
    };
    const issueData = { number: 7, body: '' };
    let requestedPath = '';
    const runner = (_command, args) => {
      if (args[0] === 'api') {
        if (args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
        if (args.includes('--slurp')) {
          requestedPath = args[args.length - 1];
          return { status: 0, stdout: JSON.stringify([[REST_REVIEW]]), stderr: '' };
        }
      }
      return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? prData : issueData), stderr: '' };
    };
    const result = runGitHubReviewAudit({ pr: 42, repo: 'explicit/repo', commandRunner: runner });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(requestedPath, 'repos/explicit/repo/pulls/42/reviews');
  });

  it('default repository resolution works through the injected runner', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      closingIssuesReferences: [{ number: 7 }],
      comments: [humanMarker()],
    };
    const issueData = { number: 7, body: '' };
    const runner = makeRunner({ prData, issueData, repoName: 'resolved/repo', restResponse: [[REST_REVIEW]] });
    const result = runGitHubReviewAudit({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

describe('Attribution trailer filtering', () => {
  function bodyWithMarker(bodyString) {
    return { body: bodyString, author: LOOP_ACCOUNT };
  }

  const liveMarker = markerString(marker());
  const fencedTrailer = '```\n[[agent: maintainer]]\n```';
  const quotedTrailer = '> [[agent: maintainer]]';
  const indentedTrailer = '    [[agent: maintainer]]';

  it('live markers plus live trailer pass', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(`${liveMarker}`)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('live markers plus fenced-only trailer fail', () => {
    const body = `${markerString(marker({ includeTrailer: false }))}\n${fencedTrailer}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing the maintainer attribution trailer/);
  });

  it('live markers plus blockquoted-only trailer fail', () => {
    const body = `${markerString(marker({ includeTrailer: false }))}\n${quotedTrailer}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing the maintainer attribution trailer/);
  });

  it('live markers plus indented-code-only trailer fail', () => {
    const body = `${markerString(marker({ includeTrailer: false }))}\n${indentedTrailer}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing the maintainer attribution trailer/);
  });

  it('live markers plus example trailer and live trailer produce one valid marker', () => {
    const body = `${fencedTrailer}\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.outcome.status, 'accepted');
  });
});

describe('Fence parsing', () => {
  function bodyWithMarker(bodyString) {
    return { body: bodyString, author: LOOP_ACCOUNT };
  }

  const liveMarker = markerString(marker());

  it('three-backtick fence closes with three backticks', () => {
    const body = `Example:\n\`\`\`\n${liveMarker}\n\`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('four-backtick fence ignores an internal three-backtick line', () => {
    const body = `Example:\n\`\`\`\`\n\`\`\`\n${liveMarker}\n\`\`\`\n\`\`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('four-backtick fence closes with four or more backticks', () => {
    const body = `\`\`\`\`\n${liveMarker}\n\`\`\`\`\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('four-tilde fence ignores an internal three-tilde line', () => {
    const body = `Example:\n~~~~\n~~~\n${liveMarker}\n~~~\n~~~~\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('mixed fence characters do not close each other', () => {
    const body = `\`\`\`\n${liveMarker}\n~~~\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('closing fence with non-whitespace suffix does not close', () => {
    const body = `\`\`\`\n${liveMarker}\n\`\`\`not-a-close\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('fence with up to three leading spaces works', () => {
    const body = `   \`\`\`\n${liveMarker}\n   \`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('four-space-indented fence is treated as indented code', () => {
    const body = `    \`\`\`\n${liveMarker}\n    \`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('markers after a genuine close become live', () => {
    const body = `\`\`\`\n${liveMarker}\n\`\`\`\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('markers after an invalid shorter close remain ignored', () => {
    const body = `\`\`\`\`\n${liveMarker}\n\`\`\`\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });
});

describe('Language-tagged and adversarial fence parsing', () => {
  function bodyWithMarker(bodyString) {
    return { body: bodyString, author: LOOP_ACCOUNT };
  }

  const liveMarker = markerString(marker());

  it('ignores marker inside \`\`\`text fence', () => {
    const body = `\`\`\`text\n${markerString(marker())}\n\`\`\``;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('ignores marker inside \`\`\`json fence', () => {
    const body = `\`\`\`json\n${markerString(marker())}\n\`\`\``;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('ignores marker inside ~~~text fence', () => {
    const body = `~~~text\n${markerString(marker())}\n~~~`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('fails attribution when maintainer trailer only appears inside a language-tagged fence', () => {
    const fenced = `\`\`\`text\n[[agent: maintainer]]\n\`\`\``;
    const body = `${markerString(marker({ includeTrailer: false }))}\n${fenced}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing the maintainer attribution trailer/);
  });

  it('fenced example plus live marker yields exactly one current marker', () => {
    const fenced = `\`\`\`text\n${markerString(marker({ status: 'needs_revision' }))}\n\`\`\``;
    const body = `${fenced}\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.outcome.status, 'accepted');
  });

  it('recognizes fence with one, two, or three leading spaces', () => {
    for (const spaces of [1, 2, 3]) {
      const indent = ' '.repeat(spaces);
      const body = `${indent}\`\`\`text\n${liveMarker}\n${indent}\`\`\`\nEnd.`;
      const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
      assert.equal(result.ok, false, `expected marker to be ignored with ${spaces} leading spaces`);
      assert.match(result.errors.join('\n'), /no valid review marker/);
    }
  });

  it('four leading spaces are treated as indented code, not a fence', () => {
    const body = `    \`\`\`text\n${liveMarker}\n    \`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('four-backtick outer fence is not closed by an internal three-backtick line', () => {
    const body = `\`\`\`\`\n\`\`\`\n${liveMarker}\n\`\`\`\n\`\`\`\`\nEnd.`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('tilde line cannot close a backtick fence', () => {
    const body = `\`\`\`text\n${liveMarker}\n~~~\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('backtick line cannot close a tilde fence', () => {
    const body = `~~~text\n${liveMarker}\n\`\`\`\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('closing fence with non-whitespace suffix does not close', () => {
    const body = `\`\`\`text\n${liveMarker}\n\`\`\`not-a-close\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('backtick opening info string containing a backtick is not accepted as a fence', () => {
    const body = `\`\`\`te\`xt\n${liveMarker}\n\`\`\`te\`xt`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('mixed LF/CRLF input behaves consistently', () => {
    const body = `\`\`\`text\n${liveMarker}\n\`\`\`\r\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.outcome.status, 'accepted');
  });

  it('unterminated language-tagged fence does not expose its contained marker', () => {
    const body = `\`\`\`text\n${markerString(marker())}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('does not treat a tab-indented delimiter as a fence opening', () => {
    const body = `\t\`\`\`text\nexample\n\`\`\`\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('does not treat a tab-indented delimiter as a fence closing', () => {
    const body = `\`\`\`text\nexample\n\t\`\`\`\n${liveMarker}`;
    const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /no valid review marker/);
  });

  it('does not allow spaces followed by a tab as fence indentation', () => {
    for (const spaces of [1, 2, 3]) {
      const body = `${' '.repeat(spaces)}\t\`\`\`text\nexample\n\`\`\`\n${liveMarker}`;
      const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
      assert.equal(result.ok, false, `expected ${spaces} spaces plus a tab not to open a fence`);
      assert.match(result.errors.join('\n'), /no valid review marker/);
    }
  });

  it('does not treat Unicode whitespace as fence indentation', () => {
    for (const whitespace of ['\u00a0', '\u2003']) {
      const body = `${whitespace}\`\`\`text\nexample\n\`\`\`\n${liveMarker}`;
      const result = evaluateGitHubReviewAudit(data({ comments: [bodyWithMarker(body)] }));
      assert.equal(result.ok, false, 'expected Unicode-whitespace delimiter not to open a fence');
      assert.match(result.errors.join('\n'), /no valid review marker/);
    }
  });
});

describe('Review audit result semantics', () => {
  it('status mismatch does not retroactively make structural provenance invalid', () => {
    const result = evaluateGitHubReviewAudit(data({ comments: [marker({ status: 'needs_revision' })] }));
    assert.equal(result.ok, false);
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, false);
    assert.match(result.errors.join('\n'), /needs_revision.*expected.*accepted/);
  });

  it('needs_revision audit may return ok true while acceptanceReady false', () => {
    const result = evaluateGitHubReviewAudit({ ...data({ comments: [marker({ status: 'needs_revision' })] }), expectedStatus: 'needs_revision' });
    assert.equal(result.ok, true);
    assert.equal(result.provenanceValid, true);
    assert.equal(result.acceptanceReady, false);
  });
});
