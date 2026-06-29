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
