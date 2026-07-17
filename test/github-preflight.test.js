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
  runPreflight,
  PreflightError,
} from '../src/github-preflight.js';

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
  const lines = ['## Scope Completed', 'Did the thing.', '', '## Evidence', `Current PR head: ${head}`, ''];
  for (const e of entries) {
    lines.push(`- Required check: ${e.check}`);
    if (e.verdict !== undefined) lines.push(`  Verdict: ${e.verdict}`);
    if (e.evidence !== undefined) lines.push(`  Evidence: ${e.evidence}`);
  }
  lines.push(...evidenceExtra);
  lines.push('', '## Deviations', 'None.');
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
  it('matches a short prefix sha', () => {
    assert.equal(headMatches('a1b2c3d', HEAD), true);
  });
  it('rejects a different sha', () => {
    assert.equal(headMatches('deadbeef', HEAD), false);
  });
});

describe('evaluatePreflight', () => {
  it('allows an issue with no verification-attempt comments', () => {
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
      body: prBody({ entries: [{ check: '[RC-1] test suite', verdict: 'passed', evidence: '128 passing' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['[RC-1] `npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(result.warnings.some(warning => warning.includes('displayed check text differs')));
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
      body: `## Scope Completed\nDid it.\nCurrent PR head: ${HEAD}`,
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
      body: '## Evidence\n- Required check: `npm test`\n  Verdict: passed\n  Evidence: ok',
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
    const check = 'Phase 20 manual checks';
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

  it('warns but matches when a verdict is failed', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'failed', evidence: '1 failing, exit 1' }] }),
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']) };
    const result = evaluatePreflight({ prData, issueData });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(result.warnings.some(w => /failed/.test(w)));
  });
});

describe('runPreflight (injected gh runner)', () => {
  function makeRunner(prData, issueData) {
    return (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') {
        return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
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
      body: prBody({ entries: [{ check: '`npm test`', verdict: 'passed', evidence: 'ok' }] }),
      closingIssuesReferences: [{ number: 7 }],
      statusCheckRollup: [],
    };
    const issueData = { number: 7, body: issueBody(['`npm test`']), comments: [] };
    let issueArgs = [];
    let commentApiArgs = [];
    const runner = (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') {
        issueArgs = args;
        return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      }
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify(LOOP_ACCOUNT), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        commentApiArgs = args;
        return { status: 0, stdout: JSON.stringify([issueData.comments ?? []]), stderr: '' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const result = runPreflight({ pr: 42, commandRunner: runner });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.doesNotMatch(issueArgs[issueArgs.indexOf('--json') + 1], /comments/);
    assert.ok(commentApiArgs.includes('--paginate') && commentApiArgs.includes('--slurp'));
    assert.ok(commentApiArgs.some(arg => /issues\/7\/comments\?per_page=100$/.test(arg)));
  });

  it('validates marked comments returned on later paginated API pages', () => {
    const prData = {
      number: 42,
      headRefOid: HEAD,
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
});
