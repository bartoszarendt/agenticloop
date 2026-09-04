/**
 * Tests for src/github-preflight.js.
 *
 * Covers the pure parsing and comparison helpers plus the injectable
 * gh-backed runPreflight orchestration:
 *   - exact required-check match passes
 *   - missing required check fails
 *   - stale PR head fails
 *   - empty statusCheckRollup does not satisfy missing evidence
 *   - a successful status check satisfies a matching required command
 *   - manual checks require explicit PR-body evidence
 *   - missing `## Required Checks` fails
 *   - missing `## Evidence` fails
 *   - generic "npm test passed" does not satisfy multiple distinct required checks
 *   - runPreflight wires gh fetches and fails clearly on gh errors
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSectionBody,
  normalizeCheckText,
  extractCommand,
  parseRequiredChecks,
  parsePrEvidence,
  extractHeadMarker,
  isSuccessfulStatusCheck,
  statusCheckName,
  headMatches,
  evaluatePreflight,
  parseAttemptBudget,
  parseReviewBudget,
  validateRequiredCheckContracts,
  PREFLIGHT_DIAGNOSTIC_CATEGORIES,
  runPreflight,
  PreflightError,
} from '../src/github-preflight.js';
import { evaluateGitHubReviewAudit } from '../src/github-review-audit.js';
import { preflightDiagnosticCode, repairPolicyFor } from '../src/repair-policy.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const LOOP_ACCOUNT = { login: 'loop-bot', type: 'User' };

function issueBody(checks) {
  return [
    '# T-001 Sample',
    '',
    '## Required Checks',
    ...checks.map(c => `- ${c}`),
    '',
    '## Acceptance Criteria',
    '- done',
  ].join('\n');
}

function prBody({ head = HEAD, entries = [], evidenceExtra = [] } = {}) {
  const lines = ['## Scope Completed', 'Did the thing.', '', '## Artifacts', `PR at ${head}.`, '', '## Evidence', `Current PR head: ${head}`, ''];
  for (const e of entries) {
    lines.push(`- Required check: ${e.check}`);
    if (e.verdict !== undefined) lines.push(`  Verdict: ${e.verdict}`);
    if (e.evidence !== undefined) lines.push(`  Evidence: ${e.evidence}`);
  }
  lines.push(...evidenceExtra);
  lines.push('', '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.');
  return lines.join('\n');
}

function verificationAttempt({
  number = 1,
  strategy = 'foreground',
  timeout = 180000,
  outcome = 'timed_out',
  candidate = 'one_off',
} = {}) {
  return [
    `#### Attempt ${number}`,
    '',
    '- Artifact: commit:abc123',
    '- Command: `npm test`',
    `- Strategy: ${strategy}`,
    `- Timeout ms: ${timeout}`,
    `- Outcome: ${outcome}`,
    `- Duration ms: ${timeout}`,
    '- Required: true',
    '- Partial evidence: test process exceeded the foreground host ceiling',
    '- Proposed next strategy: background',
    ...(candidate ? [`- Candidate classification: ${candidate}`] : []),
    '- Recorded by: engineer',
    '- Recorded at: 2026-07-17T12:00:00Z',
  ].join('\n');
}

function verificationPrediction({ number = 2, based = 1, timeout = 300000 } = {}) {
  return [
    `#### Foreground escalation prediction for attempt ${number}`,
    '',
    `- Based on attempt: ${based}`,
    '- Evidence: comparable successful runs normally finish between 220000 and 260000 ms',
    '- Predicted completion window ms: 220000-260000',
    `- Chosen timeout ms: ${timeout}`,
    '- Recorded by: engineer',
    '- Recorded at: 2026-07-17T12:05:00Z',
  ].join('\n');
}

function verificationTriage({ number = 1, classification = 'pending', reference = 'none', reason = '' } = {}) {
  return [
    `#### Triage for attempt ${number}`,
    '',
    `- Classification: ${classification}`,
    `- Reference: ${reference}`,
    ...(reason ? [`- Reason: ${reason}`] : []),
    '- Triaged by: maintainer',
    '- Triaged at: 2026-07-17T12:30:00Z',
  ].join('\n');
}

function verificationComment(entries, checkId = 'RC-1') {
  return [
    `<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:${checkId} -->`,
    '',
    '## Verification Attempts',
    '',
    `### ${checkId}`,
    '',
    entries.join('\n\n'),
  ].join('\n');
}

function trustedVerificationComment(entries, checkId = 'RC-1') {
  return {
    body: `${verificationComment(entries, checkId)}\n\n[[agent: maintainer]]`,
    author: LOOP_ACCOUNT,
  };
}

function needsRevisionComment({ artifact = HEAD, findings = ['F-1'], author = LOOP_ACCOUNT } = {}) {
  return {
    id: 100 + findings.length,
    html_url: `https://example.invalid/comments/${100 + findings.length}`,
    created_at: '2026-07-25T10:00:00Z',
    body: [
      'AGENT_REVIEW_STATUS: needs_revision',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${artifact}`,
      `AGENT_REVIEW_FINDINGS: ${findings.join(', ')}`,
      '',
      '[[agent: maintainer]]',
    ].join('\n'),
    user: author,
  };
}

function checkpointComment({ artifact = HEAD, reviewCount = 3, author = LOOP_ACCOUNT, cause = 'implementation_defect' } = {}) {
  return {
    id: 200 + reviewCount,
    html_url: `https://example.invalid/comments/${200 + reviewCount}`,
    created_at: '2026-07-25T10:01:00Z',
    body: [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Direction: targeted_revision',
      `- Cause: ${cause}`,
      `- Review count: ${reviewCount}`,
      `- Artifact: ${artifact}`,
      '- Target: repair F-1',
      '- Reference: maintainer finding F-1',
      `- Orchestrator: ${LOOP_ACCOUNT.login}`,
      '',
      '[[agent: orchestrator]]',
    ].join('\n'),
    user: author,
  };
}

function noProgressComment({ author = LOOP_ACCOUNT } = {}) {
  return {
    id: 299,
    html_url: 'https://example.invalid/comments/299',
    created_at: '2026-07-25T10:02:00Z',
    body: [
      '<!-- AGENTIC_LOOP_NO_PROGRESS -->', '',
      '## No Progress Disposition', '',
      '- No progress disposition: targeted_revision',
      '- Sustained finding ids: F-1',
      '- Target: replace the proof path with an exact final-head observation',
      `- Orchestrator: ${LOOP_ACCOUNT.login}`, '',
      '[[agent: orchestrator]]',
    ].join('\n'),
    user: author,
  };
}

describe('extractSectionBody', () => {
  it('extracts a section body and stops at the next same-level heading', () => {
    const md = '## A\nalpha\nbeta\n## B\ngamma';
    assert.equal(extractSectionBody(md, '## A'), 'alpha\nbeta');
  });

  it('returns null when the heading is absent', () => {
    assert.equal(extractSectionBody('## A\nx', '## Evidence'), null);
  });

  it('does not break on a deeper heading inside the section', () => {
    const md = '## Evidence\nintro\n### Sub\ndetail\n## Next\nx';
    assert.equal(extractSectionBody(md, '## Evidence'), 'intro\n### Sub\ndetail');
  });
});

describe('normalizeCheckText', () => {
  it('strips backticks, collapses whitespace, normalizes slashes, lowercases', () => {
    assert.equal(normalizeCheckText('`npm  test`'), 'npm test');
    assert.equal(normalizeCheckText('Run path\\to\\thing'), 'run path/to/thing');
  });
});

describe('parseRequiredChecks', () => {
  it('parses non-empty list items and preserves original text', () => {
    const checks = parseRequiredChecks(issueBody(['`npm test`', '`npm run lint`']));
    assert.equal(checks.length, 2);
    assert.equal(checks[0].text, '`npm test`');
    assert.equal(checks[0].normalized, 'npm test');
  });

  it('returns empty when the section is absent', () => {
    assert.deepEqual(parseRequiredChecks('# T\n## Scope\n- x'), []);
  });

  it('ignores empty bullets', () => {
    const checks = parseRequiredChecks('## Required Checks\n- \n- `npm test`');
    assert.equal(checks.length, 1);
  });

  it('captures the backtick command and leaves prose checks command-less', () => {
    const checks = parseRequiredChecks(
      issueBody(['`npm test -- focused`', 'Manually verify the dashboard renders'])
    );
    assert.equal(checks[0].command, 'npm test -- focused');
    assert.equal(checks[1].command, null);
  });

  it('joins wrapped check text and does not promote nested bullets', () => {
    const checks = parseRequiredChecks([
      '## Required Checks',
      '- Manual check: compare the final design',
      '  against the role matrix.',
      '  - supporting detail',
      '- `npm test`',
    ].join('\n'));
    assert.equal(checks.length, 2);
    assert.equal(checks[0].text, 'Manual check: compare the final design against the role matrix. - supporting detail');
  });

  it('extracts optional stable check ids', () => {
    const checks = parseRequiredChecks(issueBody(['[RC-1] `npm test`', '`npm run lint`']));
    assert.equal(checks[0].id, 'RC-1');
    assert.equal(checks[1].id, null);
  });

  it('keeps typed metadata for reporting but excludes it from the semantic match key', () => {
    const [check] = parseRequiredChecks(issueBody([
      '`npm test` [Kind: command] [Sources: pr_body] [Observations: output@running_path]',
    ]));
    assert.equal(check.normalized, 'npm test [kind: command] [sources: pr_body] [observations: output@running_path]');
    assert.equal(check.matchKey, 'npm test');
    assert.equal(check.text, '`npm test` [Kind: command] [Sources: pr_body] [Observations: output@running_path]');
  });

  it('does not strip unrecognized bracketed text from the semantic match key', () => {
    const [check] = parseRequiredChecks(issueBody([
      '`npm test` [Owner: release] [Kind: command]',
    ]));
    assert.equal(check.matchKey, 'npm test [owner: release]');
  });
});

describe('required-check declaration policy', () => {
  it('rejects task explain declarations before matching status-check evidence', () => {
    const [requiredCheck] = parseRequiredChecks(issueBody([
      '[RC-1] [kind: command] [sources: status_check] `npx agenticloop task explain T-001 --json`',
    ]));
    const failures = validateRequiredCheckContracts([requiredCheck]);
    assert.deepEqual(failures, [{
      index: 0,
      check: requiredCheck.text,
      reason: 'command required check must not invoke task explain: read-only diagnostic output cannot serve as required-check evidence',
      category: 'task_policy',
      code: 'required_check.explain_forbidden',
    }]);

    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody(),
        statusCheckRollup: [{ name: 'npx agenticloop task explain T-001 --json', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
      issueData: { number: 7, body: issueBody([requiredCheck.text]), comments: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceMatches.length, 0);
    assert.ok(result.diagnostics.some(item => item.code === 'required_check.explain_forbidden'));
  });
});

describe('extractCommand', () => {
  it('returns the normalized command for a backtick span', () => {
    assert.equal(extractCommand('`npm  run lint`'), 'npm run lint');
  });
  it('returns null for prose without a code span', () => {
    assert.equal(extractCommand('Manually verify the export'), null);
  });
});

describe('extractHeadMarker', () => {
  it('detects the Current PR head marker', () => {
    assert.equal(extractHeadMarker(`Current PR head: ${HEAD}`), HEAD);
  });

  it('accepts a backtick-wrapped sha', () => {
    assert.equal(extractHeadMarker('Current PR head: `abc1234`'), 'abc1234');
  });

  it('preserves uppercase input so the strict identity matcher can reject it', () => {
    assert.equal(extractHeadMarker(`Current PR head: ${HEAD.toUpperCase()}`), HEAD.toUpperCase());
    assert.equal(headMatches(extractHeadMarker(`Current PR head: ${HEAD.toUpperCase()}`), HEAD), false);
  });

  it('does not truncate an overlong identity into a valid 64-character marker', () => {
    assert.equal(extractHeadMarker(`Current PR head: ${'a'.repeat(65)}`), null);
  });

  it('returns null when absent', () => {
    assert.equal(extractHeadMarker('no marker here'), null);
  });
});

describe('parsePrEvidence', () => {
  it('parses entries and the head marker', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: '128 passing' }] });
    const parsed = parsePrEvidence(body);
    assert.equal(parsed.headSha, HEAD);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].check, '`npm test`');
    assert.equal(parsed.entries[0].verdict, 'passed');
    assert.equal(parsed.entries[0].evidence, '128 passing');
  });

  it('returns null section when Evidence is absent', () => {
    const parsed = parsePrEvidence('## Scope Completed\nx');
    assert.equal(parsed.section, null);
    assert.equal(parsed.entries.length, 0);
  });

  it('joins wrapped check and evidence fields', () => {
    const body = [
      '## Evidence',
      `Current PR head: ${HEAD}`,
      '- Required check: Manual check: compare the final design',
      '  against the role matrix.',
      '  Verdict: passed',
      '  Evidence: roles and capabilities were compared;',
      '    no inconsistencies remain.',
    ].join('\n');
    const parsed = parsePrEvidence(body);
    assert.deepEqual(parsed.entries[0], {
      check: 'Manual check: compare the final design against the role matrix.',
      verdict: 'passed',
      evidence: 'roles and capabilities were compared; no inconsistencies remain.',
    });
  });

  it('accepts an immediate four-space evidence continuation', () => {
    const parsed = parsePrEvidence([
      '## Evidence', `Current PR head: ${HEAD}`,
      '- Required check: `npm test`',
      '  Verdict: passed',
      '  Evidence: 128 passing;',
      '    exit status 0 on the current head.',
    ].join('\n'));
    assert.equal(parsed.entries[0].evidence, '128 passing; exit status 0 on the current head.');
  });

  it('does not append indented code after a blank evidence boundary', () => {
    const parsed = parsePrEvidence([
      '## Evidence', `Current PR head: ${HEAD}`,
      '- Required check: `npm test`',
      '  Verdict: passed',
      '  Evidence: 128 passing.',
      '',
      '    standalone code must stay inert',
    ].join('\n'));
    assert.equal(parsed.entries[0].evidence, '128 passing.');
  });

  it('does not append fenced code or a following list item to evidence', () => {
    const parsed = parsePrEvidence([
      '## Evidence', `Current PR head: ${HEAD}`,
      '- Required check: `npm test`',
      '  Verdict: passed',
      '  Evidence: 128 passing.',
      '```text',
      'fenced detail must stay inert',
      '```',
      '- Additional notes: not an evidence continuation',
    ].join('\n'));
    assert.equal(parsed.entries[0].evidence, '128 passing.');
  });

  it('reports a repair shape for a table-like evidence entry and keeps fenced entries inert', () => {
    const table = parsePrEvidence([
      '## Evidence',
      `Current PR head: ${HEAD}`,
      '| Required check: `npm test` | Verdict: passed | Evidence: pass |',
    ].join('\n'));
    assert.match(table.errors.join('\n'), /live bullet entry/i);

    const fenced = parsePrEvidence([
      '## Evidence',
      `Current PR head: ${HEAD}`,
      '```md',
      '- Required check: `npm test`',
      '  Verdict: passed',
      '  Evidence: pass',
      '```',
    ].join('\n'));
    assert.deepEqual(fenced.entries, []);
    assert.deepEqual(fenced.errors, []);
  });
});

describe('status check helpers', () => {
  it('treats a completed successful CheckRun as successful', () => {
    assert.equal(isSuccessfulStatusCheck({ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'ci' }), true);
  });

  it('treats a failed CheckRun as not successful', () => {
    assert.equal(isSuccessfulStatusCheck({ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }), false);
  });

  it('treats an in-progress CheckRun as not successful', () => {
    assert.equal(isSuccessfulStatusCheck({ status: 'IN_PROGRESS', name: 'ci' }), false);
  });

  it('treats a SUCCESS StatusContext as successful', () => {
    assert.equal(isSuccessfulStatusCheck({ state: 'SUCCESS', context: 'build' }), true);
  });

  it('treats a NEUTRAL conclusion as not successful', () => {
    assert.equal(isSuccessfulStatusCheck({ status: 'COMPLETED', conclusion: 'NEUTRAL', name: 'ci' }), false);
  });

  it('treats a SKIPPED conclusion as not successful', () => {
    assert.equal(isSuccessfulStatusCheck({ status: 'COMPLETED', conclusion: 'SKIPPED', name: 'ci' }), false);
  });

  it('reads a name from either name or context', () => {
    assert.equal(statusCheckName({ name: 'ci' }), 'ci');
    assert.equal(statusCheckName({ context: 'build' }), 'build');
  });
});

describe('headMatches', () => {
  it('matches identical shas', () => {
    assert.equal(headMatches(HEAD, HEAD), true);
  });
  it('matches identical 64-character SHA-256 identities', () => {
    const sha256 = 'c'.repeat(64);
    assert.equal(headMatches(sha256, sha256), true);
  });
  it('rejects uppercase identities even when they match after case folding', () => {
    assert.equal(headMatches(HEAD.toUpperCase(), HEAD), false);
    assert.equal(headMatches(HEAD, HEAD.toUpperCase()), false);
  });
  it('rejects mixed-format claims across one repository-bound comparison', () => {
    const sha256 = HEAD + 'f'.repeat(24);
    assert.equal(headMatches(HEAD, sha256), false);
    assert.equal(headMatches(sha256, HEAD), false);
  });
  it('rejects a short prefix sha', () => {
    assert.equal(headMatches('a1b2c3d', HEAD), false);
  });
  it('rejects a 41-character non-identity', () => {
    assert.equal(headMatches(HEAD + 'f', HEAD + 'f'), false);
  });
  it('rejects a different sha', () => {
    assert.equal(headMatches('deadbeef', HEAD), false);
  });
});

describe('evaluatePreflight', () => {
  it('accepts complete current-head PR evidence with no routine verification-attempt comments', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['[RC-1] `npm test`']), comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.headRefOid, HEAD);
  });

  it('accepts a valid marked verification attempt and ignores unrelated comments', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: {
        number: 7,
        body: issueBody(['[RC-1] `npm test`']),
        comments: [
          { body: '## Verification Attempts\n\nthis unrelated comment is deliberately not canonical' },
          { body: verificationComment([verificationAttempt({ outcome: 'passed' })]) },
        ],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('rejects malformed and duplicate marked verification-attempt comments', () => {
    const base = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const malformed = evaluatePreflight({
      prData: base,
      issueData: {
        number: 7,
        body: issueBody(['[RC-1] `npm test`']),
        comments: [{ body: '<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\nno history' }],
      },
    });
    assert.equal(malformed.ok, false);
    assert.match(malformed.errors.join('\n'), /canonical/);

    const comment = verificationComment([verificationAttempt({ outcome: 'passed' })]);
    const duplicate = evaluatePreflight({
      prData: base,
      issueData: {
        number: 7,
        body: issueBody(['[RC-1] `npm test`']),
        comments: [{ body: comment }, { body: comment }],
      },
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.errors.join('\n'), /duplicate/);
  });

  it('allows a timed-out attempt with candidate classification pending final maintainer triage', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: {
        number: 7,
        body: issueBody(['[RC-1] `npm test`']),
        comments: [{ body: verificationComment([verificationAttempt(), verificationTriage()]) }],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('validates project-fact and decision triage against supplied project context', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const evaluate = (triage, context = {}) => evaluatePreflight({
      prData,
      issueData: {
        number: 7,
        body: issueBody(['[RC-1] `npm test`']),
        comments: [trustedVerificationComment([verificationAttempt(), triage])],
      },
      verificationStatus: 'accepted',
      expectedAccount: LOOP_ACCOUNT,
      ...context,
    });

    const projectFact = verificationTriage({ classification: 'project_fact', reference: 'VF-full-suite' });
    assert.equal(evaluate(projectFact, { projectFacts: [{ id: 'VF-full-suite' }] }).ok, true);
    assert.match(evaluate(projectFact, { projectFacts: [] }).errors.join('\n'), /missing project verification fact/);

    const decision = verificationTriage({ classification: 'decision', reference: 'D-2026-07-17-001' });
    assert.equal(evaluate(decision, { decisionExists: id => id === 'D-2026-07-17-001' }).ok, true);
    assert.match(evaluate(decision, { decisionExists: () => false }).errors.join('\n'), /missing decision/);
  });

  it('rejects missing timeout candidates and unsupported foreground retries', () => {
    const base = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issue = comments => ({ number: 7, body: issueBody(['[RC-1] `npm test`']), comments });

    const missingCandidate = evaluatePreflight({
      prData: base,
      issueData: issue([{ body: verificationComment([verificationAttempt({ candidate: '' })]) }]),
    });
    assert.match(missingCandidate.errors.join('\n'), /Candidate classification/);

    const missingPrediction = evaluatePreflight({
      prData: base,
      issueData: issue([{
        body: verificationComment([
          verificationAttempt(),
          verificationAttempt({ number: 2, timeout: 300000, outcome: 'passed' }),
        ]),
      }]),
    });
    assert.match(missingPrediction.errors.join('\n'), /no preceding prediction/);

    const prohibitedRetry = evaluatePreflight({
      prData: base,
      issueData: issue([{
        body: verificationComment([
          verificationAttempt(),
          verificationPrediction(),
          verificationAttempt({ number: 2, timeout: 300000 }),
          verificationPrediction({ number: 3, based: 2, timeout: 360000 }),
          verificationAttempt({ number: 3, timeout: 360000, outcome: 'passed' }),
        ]),
      }]),
    });
    assert.match(prohibitedRetry.errors.join('\n'), /more than one foreground timeout escalation/);
  });

  it('matches a reworded evidence label by stable check id', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '[RC-1] Run `npm test` quietly', verdict: 'passed', evidence: '128 passing' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['[RC-1] `npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(result.warnings.some(warning => warning.includes('displayed check text differs')));
  });

  it('does not let a stable id survive dropping or changing the command identity', () => {
    // A stable ID survives wording edits only when kind,
    // source, command identity, and observation contract all match. Dropping
    // the backtick command is a kind change and an error, not a warning.
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '[RC-1] test suite', verdict: 'passed', evidence: '128 passing' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['[RC-1] `npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /proof kind 'manual' does not match declared 'command'/.test(error)), result.errors.join('\n'));
  });

  it('rejects duplicate stable check ids', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '[RC-1] first', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['[RC-1] first', '[RC-1] second']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('duplicate required-check id')));
  });

  it('passes when every required check has exact matching PR-body evidence', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({
        entries: [
          { check: '`npm test`', verdict: 'passed', evidence: '128 passing, exit 0' },
          { check: '`npm run lint`', verdict: 'passed', evidence: 'no errors' },
        ],
      }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`', '`npm run lint`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.evidenceMatches.length, 2);
    assert.equal(result.requiredChecks.length, 2);
  });

  it('fails when a required check has no evidence', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: '128 passing' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`', '`npm run lint`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some(m => m.check === '`npm run lint`'));
  });

  it('reports a parsed prefix candidate for mismatched wrapped evidence', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: 'Manual check: compare design', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['Manual check: compare design against policy']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.missing[0].reason.includes("closest parsed PR-body entry is 'Manual check: compare design'"));
  });

  it('fails when the PR body cites a stale head', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ head: 'deadbeefdeadbeef', entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /stale/.test(e)));
  });

  it('does not let an empty statusCheckRollup satisfy missing evidence', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some(m => m.check === '`npm test`'));
    assert.equal(result.statusSubstitutions.length, 0);
  });

  it('lets a successful matching status check satisfy a required command', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'npm test' }],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.statusSubstitutions.length, 1);
    assert.equal(result.statusSubstitutions[0].statusCheck, 'npm test');
  });

  it('does not substitute a failed status check', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'npm test' }],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
  });

  it('requires explicit PR-body evidence for a manual check', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'npm test' }],
    };
    const issueData = {
      number: 7,
      body: issueBody(['Manually verify the dashboard renders the new column']),
    };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some(m => /Manually verify/.test(m.check)));
  });

  it('accepts a manual check when explicit PR-body evidence is present', () => {
    const check = 'Manually verify the dashboard renders the new column';
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check, verdict: 'passed', evidence: 'screenshot attached, column visible' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody([check]) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('fails when the issue has no Required Checks section', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: '# T-001\n## Scope\n- do it' };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /Required Checks/.test(e)));
  });

  it('fails when the PR body has no Evidence section', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: `## Scope Completed\nDid it.\n## Artifacts\nPR at ${HEAD}.\nCurrent PR head: ${HEAD}`,
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /no '## Evidence'/.test(e)));
  });

  it('fails when the PR body lacks a Current PR head marker', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: '## Scope Completed\nDone.\n## Artifacts\nPR.\n## Evidence\n- Required check: `npm test`\n  Verdict: passed\n  Evidence: ok',
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /Current PR head/.test(e)));
  });

  it('does not let one generic entry satisfy multiple distinct required checks', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({
        entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'npm test passed' }],
      }),
      statusCheckRollup: [],
    };
    const issueData = {
      number: 7,
      body: issueBody(['`npm test`', '`npm run lint`', '`npm run typecheck`']),
    };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.equal(result.evidenceMatches.length, 1);
    assert.equal(result.missing.length, 2);
  });

  it('treats a "not run" verdict as missing evidence', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'not run', evidence: 'skipped' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some(m => /not run/.test(m.reason)));
  });

  it('does not let a same-named status check satisfy a manual (prose) check', () => {
    const check = 'Legacy manual checks';
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: check }],
    };
    const issueData = { number: 7, body: issueBody([check]) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.equal(result.statusSubstitutions.length, 0);
    assert.ok(result.missing.some(m => m.check === check && /manual check requires explicit/.test(m.reason)));
  });

  it('does not let a partial status-check name satisfy a focused command', () => {
    const check = '`npm test -- display-labels lead-card`';
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'test' }],
    };
    const issueData = { number: 7, body: issueBody([check]) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.equal(result.statusSubstitutions.length, 0);
  });

  it('does not let a status check named "test" satisfy `npm test`', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'test' }],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
  });

  it('does not let a NEUTRAL status check satisfy a required command', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'NEUTRAL', name: 'npm test' }],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
  });

  it('requires matching exceptional history when current evidence is failed or blocked', () => {
    for (const verdict of ['failed', 'blocked']) {
      const prData = {
        number: 42,
        headRefOid: HEAD,
        body: prBody({
          entries: [{
            check: '[RC-1] `npm test`',
            verdict,
            evidence: `${verdict} on the current head`,
          }],
        }),
        statusCheckRollup: [],
      };
      const issue = { number: 7, body: issueBody(['[RC-1] `npm test`']), comments: [] };
      const missing = evaluatePreflight({ prData, issueData: issue });
      assert.equal(missing.ok, false);
      assert.ok(
        missing.errors.some(error => error.includes('has no marked exceptional attempt carrier')),
        missing.errors.join('\n')
      );

      const recorded = evaluatePreflight({
        prData,
        issueData: {
          ...issue,
          comments: [{
            body: verificationComment([
              verificationAttempt({ outcome: verdict, candidate: '' }),
            ]),
          }],
        },
      });
      assert.equal(recorded.ok, true, JSON.stringify(recorded.errors));
      assert.ok(recorded.warnings.some(warning => warning.includes(`'${verdict}'`)));
    }
  });

  it('requires a stable check id for exceptional current evidence', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({
          entries: [{ check: '`npm test`', verdict: 'failed', evidence: '1 failing, exit 1' }],
        }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(error => error.includes('needs a stable [RC-N] id')),
      result.errors.join('\n')
    );
  });
});

describe('runPreflight (injected gh runner)', () => {
  function makeRunner(prData, issueData) {
    // `gh pr view --json` always returns every requested field; the mock serves
    // the same complete shape.
    const servedPrData = { baseRefOid: 'a'.repeat(40), files: [], commits: [], ...prData };
    return (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') {
        return { status: 0, stdout: JSON.stringify(servedPrData), stderr: '' };
      }
      if (args[0] === 'issue') {
        return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      }
      if (args[0] === 'repo') {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'user') {
        return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      }
      if (args[0] === 'api' && /\/git\/trees\//.test(args[1] ?? '')) {
        return { status: 0, stdout: JSON.stringify({ tree: [{ path: 'package.json', type: 'blob' }], truncated: false }), stderr: '' };
      }
      if (args[0] === 'api' && args.includes('--paginate')) {
        return { status: 0, stdout: JSON.stringify([issueData.comments ?? []]), stderr: '' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  it('infers the issue from closingIssuesReferences and passes', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = runPreflight({ pr: 42, commandRunner: makeRunner(prData, issueData) });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.issue, 7);
  });

  it('requests issue comments along with the task record', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      baseRefOid: 'a'.repeat(40),
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    let issueArgs = [];
    const commentApiArgs = [];
    const runner = (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') {
        issueArgs = args;
        return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      }
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'api' && /\/git\/trees\//.test(args[1] ?? '')) return { status: 0, stdout: JSON.stringify({ tree: [], truncated: false }), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        commentApiArgs.push(args);
        return { status: 0, stdout: JSON.stringify([issueData.comments ?? []]), stderr: '' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const result = runPreflight({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.doesNotMatch(issueArgs[issueArgs.indexOf('--json') + 1], /comments/);
    assert.ok(commentApiArgs.some(args => args.includes('--paginate') && args.includes('--slurp')));
    assert.ok(commentApiArgs.some(args => args.some(arg => /issues\/7\/comments\?per_page=100$/.test(arg))));
    assert.ok(commentApiArgs.some(args => args.some(arg => /issues\/42\/comments\?per_page=100$/.test(arg))));
  });

  it('hydrates shared-operation proof from immutable PR base/head blobs', () => {
    const baseRefOid = 'a'.repeat(40);
    const issueData = {
      number: 7,
      body: [
        '---',
        'task_id: T-001',
        'allowed_paths:',
        '  - package.json',
        'owned_paths: []',
        'shared_mutations:',
        '  package.json:',
        '    operation: add_json_key',
        '    target: scripts.safe',
        '---',
        '# T-001',
        '## Task',
        'Hydrate shared-operation proof.',
        '## Source Documents Reviewed',
        '- package.json',
        '## Current State',
        'The shared mutation needs immutable proof.',
        '## Scope',
        'Validate the declared package.json operation.',
        '## Out of Scope',
        'No unrelated paths.',
        '## Required Checks',
        '- `npm test`',
        '## Acceptance Criteria',
        '- done',
        '## Expected Files or Areas',
        '- package.json',
        '## Implementation Notes',
        'Compare the immutable base and head blobs.',
        '## Completion Summary Template',
        'Summarize the shared-operation proof.',
        '## Reviewer Checklist',
        '- [ ] Confirm the exact JSON operation.',
        '## Parallel Safety',
        '- **Parallel eligibility**: eligible',
        '- **Knowledge coupling**: independent',
      ].join('\n'),
    };
    const prData = {
      number: 42,
      baseRefOid,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      files: [{ path: 'package.json' }],
      statusCheckRollup: [],
    };
    const base = JSON.stringify({ scripts: { test: 'node --test' } });
    const head = JSON.stringify({ scripts: { test: 'node --test', safe: 'node safe.js' } });
    const contentRefs = [];
    const runner = (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'api' && /\/git\/trees\//.test(args[1] ?? '')) return { status: 0, stdout: JSON.stringify({ tree: [{ path: 'package.json', type: 'blob' }], truncated: false }), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      }
      if (args[0] === 'api' && /contents\/package\.json\?ref=/.test(args[1])) {
        const ref = new URL(`https://example.invalid/${args[1]}`).searchParams.get('ref');
        contentRefs.push(ref);
        const content = ref === baseRefOid ? base : head;
        return {
          status: 0,
          stdout: JSON.stringify({ encoding: 'base64', content: Buffer.from(content).toString('base64') }),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const result = runPreflight({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(contentRefs.sort(), [baseRefOid, HEAD].sort());
  });

  it('validates marked comments returned on later paginated API pages', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      baseRefOid: 'a'.repeat(40),
      body: prBody({ entries: [{ check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['[RC-1] `npm test`']) };
    const runner = (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        return {
          status: 0,
          stdout: JSON.stringify([[], [{
            body: '<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\nmalformed\n\n[[agent: engineer]]',
            user: LOOP_ACCOUNT,
          }]]),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const result = runPreflight({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing the canonical/);
  });

  it('throws PreflightError when the PR has no closing issue reference and no --issue', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [] }),
      closingIssuesReferences: [],
      statusCheckRollup: [],
    };
    assert.throws(
      () => runPreflight({ pr: 42, commandRunner: makeRunner(prData, {}) }),
      PreflightError
    );
  });

  it('throws PreflightError with an auth hint when gh is unauthenticated', () => {
    const runner = () => ({ status: 1, stdout: '', stderr: 'gh auth: not logged in to any GitHub hosts' });
    assert.throws(
      () => runPreflight({ pr: 42, commandRunner: runner }),
      /gh auth login/
    );
  });

  it('throws PreflightError on a non-positive --pr', () => {
    assert.throws(() => runPreflight({ pr: '0' }), PreflightError);
  });

  function productionHistoryRunner(prData, issueData, { comments = [], reviews = [] } = {}) {
    const servedPrData = { baseRefOid: 'a'.repeat(40), files: [], commits: [], ...prData };
    return (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(servedPrData), stderr: '' };
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        const endpoint = args.find(arg => /^repos\/o\/r\//.test(arg));
        if (/issues\/7\/comments/.test(endpoint)) return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
        if (/issues\/42\/comments/.test(endpoint)) return { status: 0, stdout: JSON.stringify([[], comments]), stderr: '' };
        if (/pulls\/42\/reviews/.test(endpoint)) return { status: 0, stdout: JSON.stringify([reviews]), stderr: '' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  it('enforces the default review budget from paginated PR conversation comments', () => {
    const prData = {
      number: 42,
      headRefOid: 'b'.repeat(40),
      body: prBody({ head: 'b'.repeat(40), entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const comments = Array.from({ length: 5 }, () => needsRevisionComment());
    const result = runPreflight({
      pr: 42,
      commandRunner: productionHistoryRunner(prData, issueData, { comments }),
    });
    assert.equal(result.ok, false, result.errors.join('\n'));
    assert.ok(result.errors.some(error => /checkpoint.*required|budget.*exhausted/i.test(error)));
  });

  it('resolves a project review default only when the linked task omits its own budget', () => {
    const projectPolicy = { default_review_budget: 2 };
    assert.deepEqual(parseReviewBudget('---\n---\n# Task', projectPolicy), {
      budget: 2,
      source: 'project',
      error: null,
    });
    assert.deepEqual(parseReviewBudget('---\nreview_budget: 7\n---\n# Task', projectPolicy), {
      budget: 7,
      error: null,
    });
    const duplicate = parseReviewBudget('---\nreview_budget: 7\nreview_budget: 8\n---\n# Task', projectPolicy);
    assert.equal(duplicate.budget, 2);
    assert.match(duplicate.error, /duplicate/);
  });

  it('resolves, preserves, and validates attempt budgets from GitHub task metadata', () => {
    const projectPolicy = { default_attempt_budget: 2 };
    assert.deepEqual(parseAttemptBudget('---\n---\n# Task', projectPolicy), {
      budget: 2,
      source: 'project',
      error: null,
    });
    assert.deepEqual(parseAttemptBudget('---\nattempt_budget: 7\n---\n# Task', projectPolicy), {
      budget: 7,
      error: null,
    });
    assert.deepEqual(parseAttemptBudget('---\n---\n# Legacy task'), {
      budget: 5,
      source: 'built_in',
      error: null,
    });
    const duplicate = parseAttemptBudget('---\nattempt_budget: 7\nattempt_budget: 8\n---\n# Task', projectPolicy);
    assert.equal(duplicate.budget, 2);
    assert.match(duplicate.error, /duplicate/);
    const invalid = parseAttemptBudget('---\nattempt_budget: 1.5\n---\n# Task', projectPolicy);
    assert.equal(invalid.budget, 5);
    assert.match(invalid.error, /positive integer/);
    const invalidProjectFallback = parseAttemptBudget(
      '---\n---\n# Legacy task',
      { default_attempt_budget: '' }
    );
    assert.equal(invalidProjectFallback.budget, 5);
    assert.match(invalidProjectFallback.error, /default_attempt_budget must be a positive safe integer/);

    const preflight = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: {
        number: 7,
        body: `---\nattempt_budget: 0\n---\n${issueBody(['`npm test`'])}`,
        comments: [],
      },
      projectMapConfig: projectPolicy,
    });
    assert.ok(preflight.errors.some(error => error.includes("attempt_budget '0' must be a positive integer")));
    assert.ok(preflight.failureCategories.some(category => category.category === 'task_policy'));
  });

  it('derives a non-default review_budget from linked task frontmatter', () => {
    const artifact = 'b'.repeat(40);
    const prData = {
      number: 42,
      headRefOid: artifact,
      body: prBody({ head: artifact, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = {
      number: 7,
      body: `---\nreview_budget: 1\n---\n\n${issueBody(['\`npm test\`'])}`,
    };
    const result = runPreflight({
      pr: 42,
      commandRunner: productionHistoryRunner(prData, issueData, {
        comments: [needsRevisionComment()],
      }),
    });
    assert.equal(result.ok, false, result.errors.join('\n'));
    assert.ok(result.errors.some(error => /budget.*1|review round budget/i.test(error)));
  });

  it('uses a trusted checkpoint from the PR conversation to authorize revision A to B', () => {
    const artifactB = 'b'.repeat(40);
    const prData = {
      number: 42,
      headRefOid: artifactB,
      body: prBody({ head: artifactB, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + `\n\n## Revision Resolution\n\n- [F-1] resolved: repaired the evidence on ${artifactB}`,
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const comments = [
      needsRevisionComment(),
      needsRevisionComment(),
      needsRevisionComment(),
      checkpointComment(),
      noProgressComment(),
    ];
    const result = runPreflight({
      pr: 42,
      commandRunner: productionHistoryRunner(prData, issueData, { comments }),
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.checkpointValidation?.authorized, true);
  });

  it('fails closed when a checkpoint and outcome share a cross-endpoint timestamp', () => {
    const artifactB = 'b'.repeat(40);
    const prData = {
      number: 42,
      headRefOid: artifactB,
      body: prBody({ head: artifactB, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
        `\n\n## Revision Resolution\n\n- [F-1] resolved: repaired the evidence on ${artifactB}`,
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = {
      number: 7,
      body: `---\nreview_budget: 1\n---\n\n${issueBody(['\`npm test\`'])}`,
    };
    const timestamp = '2026-07-25T10:00:00Z';
    const outcome = { ...needsRevisionComment(), id: 301, created_at: timestamp };
    const checkpoint = {
      ...checkpointComment({ reviewCount: 1 }),
      id: 302,
      created_at: timestamp,
    };

    for (const carriers of [
      { comments: [checkpoint], reviews: [outcome] },
      { comments: [outcome], reviews: [checkpoint] },
    ]) {
      const result = runPreflight({
        pr: 42,
        commandRunner: productionHistoryRunner(prData, issueData, carriers),
      });
      assert.equal(result.ok, false, result.errors.join('\n'));
      assert.ok(
        result.errors.some(error => /ambiguous GitHub timestamp|treated as consumed/i.test(error)),
        result.errors.join('\n')
      );
    }
  });

  it('allows a fresh checkpoint after an ambiguous same-timestamp checkpoint was consumed', () => {
    const artifactB = 'b'.repeat(40);
    const prData = {
      number: 42,
      headRefOid: artifactB,
      body: prBody({ head: artifactB, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
        `\n\n## Revision Resolution\n\n- [F-1] resolved: repaired the evidence on ${artifactB}`,
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = {
      number: 7,
      body: `---\nreview_budget: 1\n---\n\n${issueBody(['\`npm test\`'])}`,
    };
    const outcome = { ...needsRevisionComment(), id: 311, created_at: '2026-07-25T10:00:00Z' };
    const ambiguousCheckpoint = {
      ...checkpointComment({ reviewCount: 1 }),
      id: 312,
      created_at: '2026-07-25T10:00:00Z',
    };
    const freshCheckpoint = {
      ...checkpointComment({ reviewCount: 1 }),
      id: 313,
      created_at: '2026-07-25T10:01:00Z',
    };
    const result = runPreflight({
      pr: 42,
      commandRunner: productionHistoryRunner(prData, issueData, {
        comments: [ambiguousCheckpoint, freshCheckpoint],
        reviews: [outcome],
      }),
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.checkpointValidation?.authorized, true);
  });

  it('rejects a trusted carrier that combines an outcome and checkpoint', () => {
    const prData = {
      number: 42,
      headRefOid: 'b'.repeat(40),
      body: prBody({ head: 'b'.repeat(40), entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const outcome = needsRevisionComment();
    const checkpoint = checkpointComment({ reviewCount: 1 });
    const combined = {
      ...outcome,
      body: `${outcome.body}\n\n${checkpoint.body}`,
    };
    const result = runPreflight({
      pr: 42,
      commandRunner: productionHistoryRunner(prData, issueData, { comments: [combined] }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /cannot contain both/i.test(error)), result.errors.join('\n'));
  });

  it('does not accept an untrusted or malformed latest checkpoint carrier', () => {
    const artifactB = 'b'.repeat(40);
    const prData = {
      number: 42,
      headRefOid: artifactB,
      body: prBody({ head: artifactB, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const comments = [
      needsRevisionComment(),
      needsRevisionComment(),
      needsRevisionComment(),
      checkpointComment(),
      {
        ...checkpointComment(),
        body: '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->\n\n## Review Round Checkpoint\n\n- Direction: targeted_revision',
      },
    ];
    const result = runPreflight({
      pr: 42,
      commandRunner: productionHistoryRunner(prData, issueData, { comments }),
    });
    assert.equal(result.ok, false, result.errors.join('\n'));
    assert.ok(result.errors.some(error => /checkpoint/i.test(error)));
  });

  it('counts legacy outcomes for authorization without requiring them to supply finding IDs', () => {
    const artifact = 'b'.repeat(40);
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: artifact,
        body: prBody({ head: artifact, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']) },
      reviewHistory: {
        events: [
          { type: 'outcome', status: 'needs_revision', artifact: HEAD, findingIds: [], legacyMissingFindingIds: true, sourceOrder: 0 },
        ],
        errors: [],
      },
      reviewBudget: 2,
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.ok(!result.errors.some(error => /resolution matrix|bullet entry/i.test(error)), result.errors.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Exact-head, path/deviation, summary, and attribution tests
// ---------------------------------------------------------------------------

describe('exact head identity', () => {
  it('rejects a seven-character SHA prefix in the PR body marker', () => {
    const shortHead = HEAD.slice(0, 7);
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ head: shortHead, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /stale/.test(e)), result.errors.join('\n'));
  });

  it('rejects a missing head marker', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: '## Scope Completed\nDone.\n## Artifacts\nPR.\n## Evidence\n- Required check: `npm test`\n  Verdict: passed\n  Evidence: ok',
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /Current PR head/.test(e)));
  });

  it('accepts an exact full 40-character SHA', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

describe('path/deviation validation', () => {
  const devIssueBody = [
    '---',
    'allowed_paths:',
    '  - src/**',
    '  - test/**',
    '---',
    '',
    '# T-001 Sample',
    '',
    '## Required Checks',
    '- `npm test`',
    '',
    '## Acceptance Criteria',
    '- done',
  ].join('\n');

  it('accepts when all PR files match allowed_paths', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }, { path: 'test/foo.test.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody, comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('rejects unexpected file without deviation declaration', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody, comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /unexpected file.*package\.json/.test(e)), result.errors.join('\n'));
  });

  it('accepts exact path plus rationale deviation', () => {
    const body = prBody({
      entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }],
    });
    const bodyWithDeviation = body.replace('## Deviations\nNone.', '## Deviations\n- `package.json`: added new dependency for feature X');
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: bodyWithDeviation,
        files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody, comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('rejects deviation without a reason', () => {
    const body = prBody({
      entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }],
    });
    const bodyWithBadDeviation = body.replace('## Deviations\nNone.', '## Deviations\n- `package.json`:');
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: bodyWithBadDeviation,
        files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody, comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /empty reason/.test(e)), result.errors.join('\n'));
  });

  it('handles rename destinations in PR files', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/old.js' }, { path: 'src/new.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody, comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('fails closed when exact PR files exceed structured owned/shared declarations', () => {
    const ownershipIssue = [
      '---',
      'allowed_paths:',
      '  - src/**',
      '  - package.json',
      'owned_paths:',
      '  - src/foo.js',
      '---',
      '# T-001 Ownership',
      '## Required Checks',
      '- `npm test`',
      '## Acceptance Criteria',
      '- done',
      '## Parallel Safety',
      '- **Parallel eligibility**: eligible',
      '- **Knowledge coupling**: independent',
    ].join('\n');
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: ownershipIssue, comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /undeclared path 'package\.json'/.test(error)), result.errors.join('\n'));
  });

  it('requires exact base/head content proof for declared shared operations', () => {
    const ownershipIssue = [
      '---',
      'allowed_paths:',
      '  - package.json',
      'owned_paths: []',
      'shared_mutations:',
      '  package.json:',
      '    operation: add_json_key',
      '    target: scripts.safe',
      '---',
      '# T-001 Ownership',
      '## Required Checks',
      '- `npm test`',
      '## Acceptance Criteria',
      '- done',
      '## Parallel Safety',
      '- **Parallel eligibility**: eligible',
      '- **Knowledge coupling**: independent',
    ].join('\n');
    const base = JSON.stringify({ scripts: { test: 'node --test' }, private: true });
    const validHead = JSON.stringify({ scripts: { test: 'node --test', safe: 'node safe.js' }, private: true });
    const rewrittenHead = JSON.stringify({ scripts: { safe: 'node safe.js' }, private: false });
    const evaluate = headContent => evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'package.json' }],
        sharedMutationContents: { 'package.json': { baseContent: base, headContent } },
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: ownershipIssue, comments: [] },
    });
    assert.equal(evaluate(validHead).ok, true);
    const invalid = evaluate(rewrittenHead);
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join('\n'), /outside declared JSON key/);

    const missing = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: ownershipIssue, comments: [] },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.join('\n'), /lacks exact base\/head content proof/);
  });
});

describe('completion summary validation', () => {
  it('rejects missing Artifacts section', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: '## Scope Completed\nDone.\n## Evidence\nCurrent PR head: ' + HEAD + '\n- Required check: `npm test`\n  Verdict: passed\n  Evidence: ok\n## Deviations\nNone.',
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /Artifacts/.test(e)));
  });

  it('accepts valid summary with None sections', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('rejects artifact reference contradicting current head', () => {
    const wrongSha = 'f'.repeat(40);
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] });
    const bodyWithWrongRef = body.replace(`PR at ${HEAD}.`, `PR at ${wrongSha}.`);
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: bodyWithWrongRef,
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /contradicts/.test(e)), result.errors.join('\n'));
  });
});

describe('attribution validation', () => {
  it('does not reject a human-authored commit without trailers', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'fix: bug', messageBody: '', message: 'fix: bug' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.attributionValidation.established, false);
  });

  it('rejects mechanically inconsistent agent attribution', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]';
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'fix: bug', messageBody: 'Task: #7\nAgent: maintainer', message: 'fix: bug\nTask: #7\nAgent: maintainer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /Agent:.*does not match/.test(e)), result.errors.join('\n'));
  });

  it('accepts consistent agent attribution', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]';
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: #7\nAgent: engineer', message: 'feat: impl\nTask: #7\nAgent: engineer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.attributionValidation.established, true);
  });
});

describe('structured failure categories', () => {
  it('has a resolvable repair kind and primary owner for every canonical category', () => {
    const capabilities = getProjectRoleCapabilities(REPO_ROOT);
    const owners = Object.fromEntries(
      PREFLIGHT_DIAGNOSTIC_CATEGORIES.map(category => [
        category,
        capabilities.primaryOwnerByRepairKind[repairPolicyFor(preflightDiagnosticCode(category)).repairKind],
      ])
    );
    assert.deepEqual(
      [...Object.keys(owners)].sort(),
      [...PREFLIGHT_DIAGNOSTIC_CATEGORIES].sort(),
    );
    for (const owner of Object.values(owners)) assert.ok(owner, 'every category resolves to a primary owner');
  });

  it('returns categorized errors on failure', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.failureCategories));
    assert.ok(result.failureCategories.length > 0);
    assert.ok(result.failureCategories.every(c => c.category && Array.isArray(c.errors)));
  });

  it('returns empty categories on success', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.failureCategories, []);
  });
});

// ============================================================================
// Characterization tests for confirmed defects (should fail before fixes)
// ============================================================================

describe('Defect: canonical Task: T-001 rejected in favor of #7', () => {
  function issueBodyWithTaskId(taskId) {
    return [
      '---',
      `task_id: ${taskId}`,
      '---',
      '',
      '# T-001 Sample',
      '',
      '## Required Checks',
      '- `npm test`',
      '',
      '## Acceptance Criteria',
      '- done',
    ].join('\n');
  }

  it('FAILS: canonical Task: T-001 trailer is rejected when issue has task_id T-001', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]',
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nAgent: engineer', message: 'feat: impl\nTask: T-001\nAgent: engineer' }],
      },
      issueData: { number: 7, body: issueBodyWithTaskId('T-001'), comments: [] },
    });
    // Currently fails because linkedTaskId is `#7` not `T-001`
    // After fix: should pass with attributionEstablished = true
    assert.equal(result.ok, true, `Expected ok=true, got errors: ${result.errors.join('; ')}`);
    assert.equal(result.attributionValidation.established, true);
  });
});

describe('Defect: malformed allowed_paths disables scope validation', () => {
  function issueBodyWithAllowedPaths(value) {
    return [
      '---',
      `allowed_paths: ${value}`,
      '---',
      '',
      '# T-001 Sample',
      '',
      '## Required Checks',
      '- `npm test`',
      '',
      '## Acceptance Criteria',
      '- done',
    ].join('\n');
  }

  it('FAILS: non-list allowed_paths is a hard error, not silently ignored', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBodyWithAllowedPaths('"not-a-list"'), comments: [] },
    });
    // Currently: silently ignores non-list and passes
    // After fix: should fail with hard error
    assert.equal(result.ok, false, 'Expected failure for non-list allowed_paths');
    assert.ok(result.errors.some(e => /must be a YAML list/.test(e)), `Expected 'must be a YAML list' error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: allowed_paths as scalar string is a hard error', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBodyWithAllowedPaths('src/**'), comments: [] },
    });
    assert.equal(result.ok, false, 'Expected failure for scalar allowed_paths');
    assert.ok(result.errors.some(e => /must be a YAML list/.test(e)), `Expected 'must be a YAML list' error, got: ${result.errors.join('; ')}`);
  });
});

describe('Defect: unsafe path patterns silently discarded', () => {
  function issueBodyWithUnsafePatterns(patterns) {
    const patternLines = patterns.map(p => `  - ${p}`).join('\n');
    return [
      '---',
      `allowed_paths:\n${patternLines}`,
      '---',
      '',
      '# T-001 Sample',
      '',
      '## Required Checks',
      '- `npm test`',
      '',
      '## Acceptance Criteria',
      '- done',
    ].join('\n');
  }

  it('FAILS: absolute path pattern is a hard error, not silently discarded', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBodyWithUnsafePatterns(['/absolute/path']), comments: [] },
    });
    // Currently: silently discards unsafe pattern, scope becomes empty, validation may pass incorrectly
    // After fix: should fail with hard error
    assert.equal(result.ok, false, 'Expected failure for absolute path pattern');
    assert.ok(result.errors.some(e => /unsafe or malformed/.test(e) || /malformed/.test(e)), `Expected unsafe pattern error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: path traversal pattern is a hard error', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBodyWithUnsafePatterns(['../outside']), comments: [] },
    });
    assert.equal(result.ok, false, 'Expected failure for path traversal pattern');
    assert.ok(result.errors.some(e => /unsafe or malformed/.test(e) || /malformed/.test(e)), `Expected unsafe pattern error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: Windows drive letter pattern is a hard error', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBodyWithUnsafePatterns(['C:/windows-pattern']), comments: [] },
    });
    assert.equal(result.ok, false, 'Expected failure for Windows drive letter pattern');
    assert.ok(result.errors.some(e => /unsafe or malformed/.test(e) || /malformed/.test(e)), `Expected unsafe pattern error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: mixed valid/invalid list fails rather than partially applying', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBodyWithUnsafePatterns(['src/**', '../outside']), comments: [] },
    });
    assert.equal(result.ok, false, 'Expected failure for mixed valid/invalid list');
    assert.ok(result.errors.some(e => /unsafe or malformed/.test(e) || /malformed/.test(e)), `Expected unsafe pattern error, got: ${result.errors.join('; ')}`);
  });
});

describe('Defect: fenced/quoted/indented attribution treated as live', () => {
  it('FAILS: fenced code block with [[agent: engineer]] is ignored (not treated as live)', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
      '\n```\n[[agent: engineer]]\n```\n';
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nAgent: engineer', message: 'feat: impl\nTask: T-001\nAgent: engineer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    // Currently: treats fenced trailer as live, establishes attribution
    // After fix: should NOT establish attribution from fenced code
    assert.equal(result.attributionValidation.established, false, 'Fenced trailer should not establish attribution');
  });

  it('FAILS: blockquoted [[agent: engineer]] is ignored', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
      '\n> [[agent: engineer]]\n';
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nAgent: engineer', message: 'feat: impl\nTask: T-001\nAgent: engineer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.attributionValidation.established, false, 'Blockquoted trailer should not establish attribution');
  });

  it('FAILS: indented code block [[agent: engineer]] is ignored', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
      '\n    [[agent: engineer]]\n';
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nAgent: engineer', message: 'feat: impl\nTask: T-001\nAgent: engineer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.attributionValidation.established, false, 'Indented code trailer should not establish attribution');
  });

  it('FAILS: example trailer before real final trailer - only final live trailer counts', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
      '\n```\n[[agent: engineer]]\n```\n\n[[agent: maintainer]]\n';
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nAgent: maintainer', message: 'feat: impl\nTask: T-001\nAgent: maintainer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    // After fix: should use the final live trailer (maintainer), not the fenced example (engineer)
    assert.equal(result.attributionValidation.established, true);
    // The body role should be maintainer, commit agent should be maintainer
  });
});

describe('Defect: commit trailer regexes match mid-prose', () => {
  it('mid-prose "Task: T-001" is not treated as a valid trailer', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]',
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'This commit implements Task: T-001 as requested', message: 'feat: impl\nThis commit implements Task: T-001 as requested' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    // A final agent handoff establishes attribution, so prose cannot satisfy
    // either required commit trailer.
    assert.equal(result.attributionValidation.established, true);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /missing required Task:|missing required Agent:/.test(error)));
  });

  it('mid-prose "Agent: engineer" is not treated as a valid trailer', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]',
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Implemented by Agent: engineer per spec', message: 'feat: impl\nImplemented by Agent: engineer per spec' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.attributionValidation.established, true);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /missing required Task:|missing required Agent:/.test(error)));
  });

  it('duplicate trailers fail', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]',
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nTask: T-002\nAgent: engineer', message: 'feat: impl\nTask: T-001\nTask: T-002\nAgent: engineer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    // Duplicate Task: trailers should fail
    assert.ok(result.errors.some(e => /duplicate/i.test(e)), 'Duplicate Task trailers should fail');
  });

  it('conflicting trailers fail', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]',
        statusCheckRollup: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat: impl', messageBody: 'Task: T-001\nAgent: engineer\nAgent: maintainer', message: 'feat: impl\nTask: T-001\nAgent: engineer\nAgent: maintainer' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.ok(result.errors.some(e => /conflict/i.test(e) || /duplicate/i.test(e)), 'Conflicting Agent trailers should fail');
  });
});

describe('Defect: summary validation allows placeholders and rejects historical SHAs', () => {
  it('FAILS: placeholder "TBD" in Artifacts section is rejected', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('PR at ' + HEAD + '.', 'PR at TBD.');
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false, 'Placeholder TBD in Artifacts should fail');
    assert.ok(result.errors.some(e => /placeholder|TBD|substantive/.test(e)), `Expected placeholder error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: placeholder "None" in Artifacts section is rejected', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('PR at ' + HEAD + '.', 'PR at None.');
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false, 'Placeholder None in Artifacts should fail');
  });

  it('FAILS: empty bullet in Artifacts section is rejected', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('PR at ' + HEAD + '.\n', 'PR at ' + HEAD + '.\n- \n');
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false, 'Empty bullet in Artifacts should fail');
  });

  it('FAILS: legitimate base SHA in Artifacts (for context) is rejected', () => {
    const baseSha = 'b'.repeat(40);
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
      '\nBase: ' + baseSha + '\n';
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    // Currently: rejects any 40-char SHA that doesn't match head
    // After fix: should allow base SHAs when clearly labeled
    assert.equal(result.ok, true, 'Legitimate base SHA reference should be allowed');
  });

  it('FAILS: commit range (base..head) in Artifacts is rejected', () => {
    const baseSha = 'b'.repeat(40);
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
      '\nRange: ' + baseSha + '..' + HEAD + '\n';
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, true, 'Commit range reference should be allowed');
  });

  it('FAILS: short current head SHA (7 chars) in Artifacts is rejected', () => {
    const shortHead = HEAD.slice(0, 7);
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('PR at ' + HEAD + '.', 'PR at ' + shortHead + '.');
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
    });
    assert.equal(result.ok, false, 'Short SHA for current artifact should fail');
  });
});

describe('Defect: structured error routing uses ambiguous substring matching', () => {
  it('FAILS: missing Artifacts error categorized as summary_shape not head_identity', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: '## Scope Completed\nDone.\n## Evidence\nCurrent PR head: ' + HEAD + '\n- Required check: `npm test`\n  Verdict: passed\n  Evidence: ok',
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    const result = evaluatePreflight({ prData, issueData });
    const cats = result.failureCategories;
    const summaryCat = cats.find(c => c.category === 'summary_shape');
    const headCat = cats.find(c => c.category === 'head_identity');
    assert.ok(summaryCat, 'Should have summary_shape category');
    assert.ok(summaryCat.errors.some(e => /Artifacts/.test(e)), 'Missing Artifacts should be in summary_shape');
    assert.ok(!headCat || !headCat.errors.some(e => /Artifacts/.test(e)), 'Missing Artifacts should NOT be in head_identity');
  });

  it('FAILS: empty Evidence error categorized as summary_shape', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: '## Scope Completed\nDone.\n## Artifacts\nPR at ' + HEAD + '.\n## Evidence\n',
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    const result = evaluatePreflight({ prData, issueData });
    const cats = result.failureCategories;
    const summaryCat = cats.find(c => c.category === 'summary_shape');
    assert.ok(summaryCat, 'Should have summary_shape category');
    assert.ok(summaryCat.errors.some(e => /Evidence/.test(e)), 'Empty Evidence should be in summary_shape');
  });

  it('FAILS: wrong Task trailer error categorized as attribution', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n[[agent: engineer]]',
      statusCheckRollup: [],
      commits: [{ oid: HEAD, messageHeadline: 'feat', messageBody: 'Task: WRONG-TASK\nAgent: engineer', message: 'feat\nTask: WRONG-TASK\nAgent: engineer' }],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    const result = evaluatePreflight({ prData, issueData });
    const cats = result.failureCategories;
    const attrCat = cats.find(c => c.category === 'attribution');
    assert.ok(attrCat, 'Should have attribution category');
    assert.ok(attrCat.errors.some(e => /Task:.*does not match/.test(e)), 'Wrong Task trailer should be in attribution');
  });

  it('FAILS: missing deviation error categorized as scope_deviations', () => {
    const devIssueBody = [
      '---',
      'allowed_paths:',
      '  - src/**',
      '---',
      '',
      '# T-001 Sample',
      '',
      '## Required Checks',
      '- `npm test`',
      '',
      '## Acceptance Criteria',
      '- done',
    ].join('\n');
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: devIssueBody, comments: [] };
    const result = evaluatePreflight({ prData, issueData });
    const cats = result.failureCategories;
    const scopeCat = cats.find(c => c.category === 'scope_deviations');
    assert.ok(scopeCat, 'Should have scope_deviations category');
    assert.ok(scopeCat.errors.some(e => /unexpected file.*package\.json/.test(e)), 'Missing deviation should be in scope_deviations');
  });

  it('FAILS: stale head error categorized as head_identity', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ head: 'deadbeefdeadbeef', entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    const result = evaluatePreflight({ prData, issueData });
    const cats = result.failureCategories;
    const headCat = cats.find(c => c.category === 'head_identity');
    assert.ok(headCat, 'Should have head_identity category');
    assert.ok(headCat.errors.some(e => /stale|head/.test(e)), 'Stale head should be in head_identity');
  });

  it('FAILS: missing checkpoint error categorized as review_checkpoint', () => {
    const revisedHead = 'b'.repeat(40);
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
    ];
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: revisedHead,
        body: prBody({ head: revisedHead, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
      reviewBudget: 3,
    });
    const cats = result.failureCategories;
    const checkpointCat = cats.find(c => c.category === 'review_checkpoint');
    assert.ok(checkpointCat, 'Should have review_checkpoint category');
    assert.ok(checkpointCat.errors.some(e => /checkpoint.*required|budget.*exhausted/i.test(e)),
      `Expected checkpoint error in category, got: ${checkpointCat.errors.join('; ')}`);
  });
});

describe('Defect: stale deviation declarations not rejected', () => {
  function devIssueBody() {
    return [
      '---',
      'allowed_paths:',
      '  - src/**',
      '---',
      '',
      '# T-001 Sample',
      '',
      '## Required Checks',
      '- `npm test`',
      '',
      '## Acceptance Criteria',
      '- done',
    ].join('\n');
  }

  it('FAILS: deviation for file not in current PR is rejected', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('## Deviations\nNone.', '## Deviations\n- `old-file.js`: removed in previous revision');
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody(), comments: [] },
    });
    assert.equal(result.ok, false, 'Stale deviation should fail');
    assert.ok(result.errors.some(e => /deviation declared.*not in the current PR/.test(e)), `Expected stale deviation error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: deviation for file that IS in allowed_paths is rejected as unnecessary', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('## Deviations\nNone.', '## Deviations\n- `src/foo.js`: this is actually in scope');
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        files: [{ path: 'src/foo.js' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody(), comments: [] },
    });
    assert.equal(result.ok, false, 'Deviation for in-scope file should fail');
    assert.ok(result.errors.some(e => /already covered|in scope|unnecessary/.test(e)), `Expected in-scope deviation error, got: ${result.errors.join('; ')}`);
  });

  it('FAILS: duplicate deviation paths are rejected', () => {
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] })
      .replace('## Deviations\nNone.', '## Deviations\n- `package.json`: reason one\n- `package.json`: reason two');
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body,
        files: [{ path: 'src/foo.js' }, { path: 'package.json' }],
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: devIssueBody(), comments: [] },
    });
    assert.equal(result.ok, false, 'Duplicate deviation paths should fail');
    assert.ok(result.errors.some(e => /duplicate/i.test(e)), `Expected duplicate deviation error, got: ${result.errors.join('; ')}`);
  });
});

describe('Defect: over-budget review without checkpoint passes', () => {
  it('a revision after an explicit budget-3 checkpoint boundary should fail preflight', () => {
    const revisedHead = 'b'.repeat(40);
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
    ];
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: revisedHead, body: prBody({ head: revisedHead, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }), statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
      reviewBudget: 3,
    });
    assert.equal(result.ok, false, 'Over-budget revision without checkpoint should fail');
    assert.ok(result.checkpointValidation, 'Should have checkpoint validation result');
    assert.equal(result.checkpointValidation.authorized, false, 'Should not be authorized');
    assert.ok(result.checkpointValidation.errors.some(e => /checkpoint.*required|budget.*exhausted/i.test(e)),
      `Expected checkpoint error, got: ${result.checkpointValidation.errors.join('; ')}`);
  });

  it('a revision within an explicit budget-3 threshold should pass without checkpoint', () => {
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
    ];
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }), statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
      reviewBudget: 3,
    });
    assert.equal(result.ok, true, 'Third revision within budget should pass');
  });
});

describe('Defect: checkpoint replay passes', () => {
  it('replayed checkpoint after another needs_revision should fail', () => {
    const artifactB = 'b'.repeat(40);
    const artifactC = 'c'.repeat(40);
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: artifactB },
    ];
    const checkpointBody = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Direction: targeted_revision',
      '- Cause: implementation_defect',
      '- Review count: 3',
      `- Artifact: ${HEAD}`,
      '- Target: fix failing test evidence',
      '- Reference: maintainer finding F-1',
      '- Review role carrier: agenticloop.review-role-carrier/v1',
      '- Role ID: orchestrator',
      '- Actor account: loop-bot',
      '',
      '[[agent: orchestrator]]',
    ].join('\n');
    const comments = [{ body: checkpointBody }];
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: artifactC, body: prBody({ head: artifactC, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }), statusCheckRollup: [], comments },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
      reviewBudget: 3,
    });
    assert.equal(result.ok, false, 'Checkpoint replay should fail');
    assert.ok(result.checkpointValidation, 'Should have checkpoint validation result');
    assert.equal(result.checkpointValidation.authorized, false, 'Should not be authorized');
    assert.ok(result.checkpointValidation.errors.some(e => /consumed|replay|stale|review_count.*does not match/i.test(e)),
      `Expected replay/count mismatch error, got: ${result.checkpointValidation.errors.join('; ')}`);
  });

  it('fresh targeted checkpoint at budget boundary should authorize one revision', () => {
    const artifactB = 'b'.repeat(40);
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
      { status: 'needs_revision', artifact: HEAD },
    ];
    const checkpointBody = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Direction: targeted_revision',
      '- Cause: implementation_defect',
      '- Review count: 3',
      `- Artifact: ${HEAD}`,
      '- Target: fix failing test evidence',
      '- Reference: maintainer finding F-1',
      '- Review role carrier: agenticloop.review-role-carrier/v1',
      '- Role ID: orchestrator',
      '- Actor account: loop-bot',
      '',
      '[[agent: orchestrator]]',
    ].join('\n');
    const comments = [{ body: checkpointBody }];
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: artifactB, body: prBody({ head: artifactB, entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }), statusCheckRollup: [], comments },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
      reviewBudget: 3,
    });
    assert.equal(result.ok, true, 'Targeted checkpoint should authorize one revision');
  });
});

describe('Defect: missing resolution-matrix bullet entry passes', () => {
  it('re-review without resolution matrix should fail', () => {
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD, findingIds: ['F-1', 'F-2', 'F-3'] },
    ];
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }), statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
    });
    assert.equal(result.ok, false, 'Re-review without resolution matrix should fail');
    assert.ok(result.resolutionMatrixValidation === null, 'Should have no matrix validation because matrix is missing');
    assert.ok(result.errors.some(e => /resolution matrix/i.test(e)),
      `Expected resolution matrix error, got: ${result.errors.join('; ')}`);
    const diagnostic = result.diagnostics.find(item => item.category === 'revision_resolution');
    assert.deepEqual(diagnostic.requiredFindingIds, ['F-1', 'F-2', 'F-3']);
    assert.deepEqual(diagnostic.expectedValues, ['resolved', 'disputed', 'blocked']);
    assert.match(diagnostic.expectedShape, /^- \[F-1\] resolved\|disputed\|blocked:/);
  });

  it('first review without prior findings should pass without matrix', () => {
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }), statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes: [],
    });
    assert.equal(result.ok, true, 'First review should pass without matrix');
  });

  it('complete resolution matrix should allow re-review', () => {
    const reviewOutcomes = [
      { status: 'needs_revision', artifact: HEAD, findingIds: ['F-1', 'F-2'] },
    ];
    const matrixBody = [
      '## Revision Resolution',
      '',
      '- [F-1] resolved: Fixed missing test evidence on commit ' + HEAD,
      '- [F-2] disputed: Scope deviation was declared [ref: maintainer review comment 5]',
    ].join('\n');
    const body = prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) + '\n\n' + matrixBody;
    const result = evaluatePreflight({
      prData: { number: 42, headRefOid: HEAD, body, statusCheckRollup: [] },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes,
    });
    assert.equal(result.ok, true, 'Complete resolution matrix should allow re-review');
  });

  it('reports one parser-level repair shape for a malformed live resolution section', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
          '\n\n## Revision Resolution\n\n| Finding | Disposition |\n| --- | --- |\n| F-1 | resolved |',
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes: [{ status: 'needs_revision', artifact: HEAD, findingIds: ['F-1', 'F-2'] }],
    });
    const resolutionErrors = result.failureCategories
      .find(category => category.category === 'revision_resolution')?.errors ?? [];
    assert.equal(resolutionErrors.length, 1);
    assert.match(resolutionErrors[0], /live top-level bullet entries/i);
    assert.doesNotMatch(resolutionErrors.join('\n'), /no bullet entry/i);
  });

  it('does not activate a fenced canonical-looking resolution bullet', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: HEAD,
        body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }) +
          `\n\n## Revision Resolution\n\n\`\`\`md\n- [F-1] resolved: repaired the evidence on ${HEAD}\n\`\`\``,
        statusCheckRollup: [],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']), comments: [] },
      reviewOutcomes: [{ status: 'needs_revision', artifact: HEAD, findingIds: ['F-1'] }],
    });
    assert.equal(result.resolutionMatrixValidation, null);
    const resolutionErrors = result.failureCategories
      .find(category => category.category === 'revision_resolution')?.errors ?? [];
    assert.equal(resolutionErrors.length, 1);
    assert.match(resolutionErrors[0], /outside fenced code/i);
  });
});

describe('Defect: dispatched artifact A, current head B not rejected', () => {
  it('push from A to B during review lease should fail audit', () => {
    const result = evaluateGitHubReviewAudit({
      prData: {
        number: 42,
        headRefOid: HEAD,
        closingIssuesReferences: [{ number: 7 }],
        comments: [{
          body: `AGENT_REVIEW_STATUS: accepted\nAGENT_REVIEW_MODE: single_agent_fallback\nAGENT_REVIEW_ARTIFACT: ${HEAD}\n\n[[agent: maintainer]]`,
          author: { login: 'loop-bot', type: 'User' },
        }],
        reviews: [],
        commits: [{ oid: HEAD, messageHeadline: 'feat', messageBody: '', message: 'feat' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']) },
      expectedAccount: LOOP_ACCOUNT,
      expectedArtifact: HEAD,
    });
    assert.equal(result.ok, true, 'Same artifact should pass');
    assert.equal(result.expectedArtifact, HEAD, 'Should include expected artifact in result');

    // Now test with mismatched artifact
    const differentHead = 'b'.repeat(40);
    const resultMismatch = evaluateGitHubReviewAudit({
      prData: {
        number: 42,
        headRefOid: differentHead,
        closingIssuesReferences: [{ number: 7 }],
        comments: [{
          body: `AGENT_REVIEW_STATUS: accepted\nAGENT_REVIEW_MODE: single_agent_fallback\nAGENT_REVIEW_ARTIFACT: ${differentHead}\n\n[[agent: maintainer]]`,
          author: { login: 'loop-bot', type: 'User' },
        }],
        reviews: [],
        commits: [{ oid: differentHead, messageHeadline: 'feat', messageBody: '', message: 'feat' }],
      },
      issueData: { number: 7, body: issueBody(['`npm test`']) },
      expectedAccount: LOOP_ACCOUNT,
      expectedArtifact: HEAD,
    });
    assert.equal(resultMismatch.ok, false, 'Mismatched artifact should fail');
    assert.ok(resultMismatch.errors.some(e => /dispatched artifact|expected.*artifact/i.test(e)),
      `Expected artifact mismatch error, got: ${resultMismatch.errors.join('; ')}`);
  });
});
