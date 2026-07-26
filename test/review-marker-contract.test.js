import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreflight } from '../src/github-preflight.js';
import { evaluateGitHubReviewAudit } from '../src/github-review-audit.js';
import { collectGitHubReviewHistory, parseFilesReviewHistory, parseReviewMarker } from '../src/review-history.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const LOOP = { login: 'loop-bot', type: 'User' };

function githubMarker({ findings = 'F-1', author = LOOP, artifact = HEAD } = {}) {
  return {
    id: 1,
    created_at: '2026-07-26T10:00:00Z',
    body: [
      'AGENT_REVIEW_STATUS: needs_revision',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${artifact}`,
      ...(findings ? [`AGENT_REVIEW_FINDINGS: ${findings}`] : []),
      '',
      '[[agent: maintainer]]',
    ].join('\n'),
    user: author,
  };
}

function prBody() {
  return [
    '## Scope Completed', 'Done.', '',
    '## Artifacts', `PR at ${HEAD}.`, '',
    '## Evidence', `Current PR head: ${HEAD}`, '',
    '- Required check: `npm test`', '  Verdict: passed', '  Evidence: tests passed', '',
    '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
  ].join('\n');
}

describe('shared durable review-marker contract', () => {
  it('fails every trusted current consumer on missing findings', () => {
    const carrier = githubMarker({ findings: '' });
    const parsed = parseReviewMarker(carrier.body, carrier);
    const history = collectGitHubReviewHistory({ headRefOid: HEAD, comments: [carrier], reviews: [] }, LOOP);
    const audit = evaluateGitHubReviewAudit({
      prData: { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments: [carrier], reviews: [] },
      issueData: { number: 7, body: '' },
      expectedAccount: LOOP,
      expectedStatus: 'needs_revision',
    });
    const preflight = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body: prBody(), statusCheckRollup: [] },
      issueData: { number: 7, body: '## Required Checks\n- `npm test`', comments: [] },
      expectedAccount: LOOP,
      reviewHistory: history,
    });
    const files = parseFilesReviewHistory([
      '## Review History', '', '### Review 1', '',
      '- Status: needs_revision', '- Mode: host_subagent', '- Artifact: commit:abc123', '- Maintainer: maintainer',
    ].join('\n'));

    for (const errors of [parsed.errors, history.errors, audit.errors, preflight.errors, files.errors]) {
      assert.match(errors.join('\n'), /AGENT_REVIEW_FINDINGS|requires AGENT_REVIEW_FINDINGS/);
    }
  });

  it('keeps an untrusted malformed carrier out of history and audit diagnostics', () => {
    const carrier = githubMarker({ findings: '', author: { login: 'other-account', type: 'User' } });
    const history = collectGitHubReviewHistory({ headRefOid: HEAD, comments: [carrier], reviews: [] }, LOOP);
    const audit = evaluateGitHubReviewAudit({
      prData: { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments: [carrier], reviews: [] },
      issueData: { number: 7, body: '' },
      expectedAccount: LOOP,
      expectedStatus: 'needs_revision',
    });
    assert.deepEqual(history, { events: [], errors: [] });
    assert.doesNotMatch(audit.errors.join('\n'), /AGENT_REVIEW_FINDINGS/);
  });

  it('does not treat a fenced marker example inside a checkpoint as a mixed carrier', () => {
    const checkpoint = {
      id: 2,
      created_at: '2026-07-26T10:00:00Z',
      author: LOOP,
      body: [
        '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->', '',
        '## Review Round Checkpoint', '',
        '- Direction: targeted_revision',
        '- Cause: implementation_defect',
        '- Review count: 1',
        `- Artifact: ${HEAD}`,
        '- Target: repair the current artifact',
        '- Orchestrator: loop-bot', '',
        '```markdown',
        'AGENT_REVIEW_STATUS: accepted',
        'AGENT_REVIEW_MODE: host_subagent',
        `AGENT_REVIEW_ARTIFACT: ${HEAD}`,
        '[[agent: maintainer]]',
        '```', '',
        '[[agent: orchestrator]]',
      ].join('\n'),
    };
    const history = collectGitHubReviewHistory({ headRefOid: HEAD, comments: [checkpoint], reviews: [] }, LOOP);
    assert.deepEqual(history.errors, []);
    assert.equal(history.events.length, 1);
    assert.equal(history.events[0].type, 'checkpoint');
  });

  it('quotes the exact required maintainer attribution trailer', () => {
    const parsed = parseReviewMarker(githubMarker().body.replace('[[agent: maintainer]]', ''));
    assert.match(parsed.errors.join('\n'), /\[\[agent: maintainer\]\]/);
  });

  it('quotes the exact required orchestrator attribution trailer for checkpoints', () => {
    const body = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->', '',
      '## Review Round Checkpoint', '',
      '- Direction: targeted_revision', '- Cause: implementation_defect', '- Review count: 1',
      `- Artifact: ${HEAD}`, '- Target: repair the current artifact', '- Orchestrator: loop-bot',
    ].join('\n');
    const history = collectGitHubReviewHistory({
      headRefOid: HEAD,
      comments: [{ id: 3, body, author: LOOP }],
      reviews: [],
    }, LOOP);
    assert.match(history.errors.join('\n'), /\[\[agent: orchestrator\]\]/);
  });
});
