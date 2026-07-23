import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  FIXUP_FIELDS,
  detectFixupEpisodes,
  validateFixupEpisode,
  validateFilesFixup,
  commitHasMaintainerFixupTrailers,
  commitTaskTrailerValues,
  crossCheckMaintainerFixup,
  MAINTAINER_FIXUP_HEADING,
} from '../src/maintainer-fixup.js';
import { validateConfig, validateFilesTaskRecord } from '../src/validate-config.js';
import { evaluateGitHubReviewAudit, runGitHubReviewAudit, normalizeGitHubFixupArtifact } from '../src/github-review-audit.js';
import { appendEventLog, buildEvent } from '../src/event-logging.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-maintainer-fixup-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function fixupSubsection({
  finding = 'Duplicated guard clause in the parser',
  eligibility = 'eligible -- Lens 1 clean, within allowed paths, no test change',
  base = 'commit:aaa111',
  correction = 'Extracted the shared guard into one helper',
  affected = 'src/parser.js',
  plannedVerification = 'npm test',
  verificationResult = 'npm test: 128 passing (exit 0)',
  resulting = 'commit:bbb222',
} = {}) {
  return [
    MAINTAINER_FIXUP_HEADING,
    '',
    `- Finding: ${finding}`,
    `- Eligibility decision: ${eligibility}`,
    `- Base artifact: ${base}`,
    `- Correction: ${correction}`,
    `- Affected files: ${affected}`,
    `- Planned verification: ${plannedVerification}`,
    `- Verification result: ${verificationResult}`,
    `- Resulting artifact: ${resulting}`,
  ].join('\n');
}

// Blank exactly one standardized field by label.
function fixupSubsectionWithout(label) {
  const overrides = {
    'Finding': { finding: '' },
    'Eligibility decision': { eligibility: '' },
    'Base artifact': { base: '' },
    'Correction': { correction: '' },
    'Affected files': { affected: '' },
    'Planned verification': { plannedVerification: '' },
    'Verification result': { verificationResult: '' },
    'Resulting artifact': { resulting: '' },
  };
  assert.ok(overrides[label], `unknown field label '${label}'`);
  return fixupSubsection(overrides[label]);
}

// ---------------------------------------------------------------------------
// detectFixupEpisodes
// ---------------------------------------------------------------------------

describe('detectFixupEpisodes', () => {
  it('parses the standardized fields of one episode', () => {
    const episodes = detectFixupEpisodes(`# Task\n\n${fixupSubsection()}\n`);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].fields.finding, 'Duplicated guard clause in the parser');
    assert.equal(episodes[0].fields.base_artifact, 'commit:aaa111');
    assert.equal(episodes[0].fields.resulting_artifact, 'commit:bbb222');
    assert.equal(episodes[0].fields.affected_files, 'src/parser.js');
    assert.equal(episodes[0].occurrences.length, 8);
    assert.deepEqual(episodes[0].duplicateFields, []);
  });

  it('detects more than one episode (multiple live headings)', () => {
    const episodes = detectFixupEpisodes(`${fixupSubsection()}\n\n${fixupSubsection({ finding: 'second' })}\n`);
    assert.equal(episodes.length, 2);
  });

  it('records duplicate recognized labels with their line instead of silently overwriting', () => {
    const body = [fixupSubsection(), '- Finding: a second finding value'].join('\n');
    const episodes = detectFixupEpisodes(body);
    assert.equal(episodes.length, 1);
    // First occurrence wins in fields; the duplicate is tracked separately.
    assert.equal(episodes[0].fields.finding, 'Duplicated guard clause in the parser');
    assert.equal(episodes[0].duplicateFields.length, 1);
    assert.equal(episodes[0].duplicateFields[0].label, 'Finding');
    assert.ok(Number.isInteger(episodes[0].duplicateFields[0].line));
  });

  it('recognizes labels case-insensitively and with extra whitespace', () => {
    const body = [
      MAINTAINER_FIXUP_HEADING,
      '-   finding:   spaced finding',
      '- ELIGIBILITY DECISION: caps label',
    ].join('\n');
    const episodes = detectFixupEpisodes(body);
    assert.equal(episodes[0].fields.finding, 'spaced finding');
    assert.equal(episodes[0].fields.eligibility_decision, 'caps label');
  });

  it('ignores a fenced example subsection (marker parsing stays safe)', () => {
    const body = [
      '# Task',
      '',
      'Here is an example that must not register as live:',
      '',
      '```md',
      MAINTAINER_FIXUP_HEADING,
      '- Finding: example only',
      '- Base artifact: commit:zzz',
      '- Resulting artifact: commit:yyy',
      '```',
      '',
      'End.',
    ].join('\n');
    assert.deepEqual(detectFixupEpisodes(body), []);
  });

  it('ignores a blockquoted example subsection', () => {
    const body = ['# Task', '', `> ${MAINTAINER_FIXUP_HEADING}`, '> - Finding: quoted'].join('\n');
    assert.deepEqual(detectFixupEpisodes(body), []);
  });

  it('ignores an indented-code example subsection', () => {
    const body = ['# Task', '', `    ${MAINTAINER_FIXUP_HEADING}`, '    - Finding: indented'].join('\n');
    assert.deepEqual(detectFixupEpisodes(body), []);
  });
});

// ---------------------------------------------------------------------------
// validateFixupEpisode (shared field rules)
// ---------------------------------------------------------------------------

describe('validateFixupEpisode', () => {
  const subject = "Task record 'T-001.md'";

  function firstEpisode(content) {
    const episodes = detectFixupEpisodes(content);
    assert.equal(episodes.length, 1);
    return episodes[0];
  }

  it('accepts a complete valid subsection', () => {
    const errors = validateFixupEpisode(firstEpisode(fixupSubsection()), { subject });
    assert.deepEqual(errors, []);
  });

  for (const field of FIXUP_FIELDS) {
    it(`rejects a subsection missing '${field.label}'`, () => {
      const errors = validateFixupEpisode(firstEpisode(fixupSubsectionWithout(field.label)), { subject });
      assert.ok(
        errors.some(e => e.includes(`missing required field '${field.label}'`)),
        errors.join('\n')
      );
    });
  }

  it('rejects an episode where a field bullet is absent entirely', () => {
    const body = [MAINTAINER_FIXUP_HEADING, '- Finding: x'].join('\n');
    const errors = validateFixupEpisode(firstEpisode(body), { subject });
    // 7 of 8 fields are missing.
    assert.equal(errors.filter(e => e.includes('missing required field')).length, 7);
  });

  it('rejects duplicate recognized labels deterministically', () => {
    const body = [fixupSubsection(), '- Correction: another correction'].join('\n');
    const errors = validateFixupEpisode(firstEpisode(body), { subject });
    assert.ok(errors.some(e => /duplicate field 'Correction' \(line \d+\)/.test(e)), errors.join('\n'));
  });

  it('rejects identical base and resulting artifacts, including across supported spellings', () => {
    const same = validateFixupEpisode(
      firstEpisode(fixupSubsection({ base: 'commit:same', resulting: 'commit:same' })),
      { subject }
    );
    assert.ok(same.some(e => /identical/.test(e)));

    const prefixed = validateFixupEpisode(
      firstEpisode(fixupSubsection({ base: 'commit:abc999', resulting: 'ABC999' })),
      { subject }
    );
    assert.ok(prefixed.some(e => /identical/.test(e)), prefixed.join('\n'));
  });

  it('applies the backend artifact callback to base and resulting artifacts', () => {
    const errors = validateFixupEpisode(firstEpisode(fixupSubsection()), {
      subject,
      validateArtifact: (label, value) => `'${label}' rejected value '${value}'`,
    });
    assert.ok(errors.some(e => e.includes("'Base artifact' rejected value 'commit:aaa111'")));
    assert.ok(errors.some(e => e.includes("'Resulting artifact' rejected value 'commit:bbb222'")));
  });

  it('identifies the subject and heading line in every message', () => {
    const errors = validateFixupEpisode(firstEpisode(fixupSubsectionWithout('Finding')), { subject });
    assert.ok(errors.every(e => e.includes(subject) && /heading line \d+/.test(e)), errors.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// validateFilesFixup (pure)
// ---------------------------------------------------------------------------

describe('validateFilesFixup', () => {
  const baseParams = {
    label: 'T-001.md',
    reviewMode: 'single_agent_fallback',
    implementationArtifact: 'commit:bbb222',
    reviewedArtifact: 'commit:bbb222',
    independentRequired: false,
    evidenceBody: 'npm test: 128 passing (exit 0) on commit:bbb222',
  };

  it('accepts a complete, eligible single-episode fixup (happy path)', () => {
    const errors = validateFilesFixup({ ...baseParams, content: fixupSubsection() });
    assert.deepEqual(errors, []);
  });

  it('produces no errors when there is no fixup subsection (backward compatible)', () => {
    const errors = validateFilesFixup({ ...baseParams, content: '# Task\nNo fixup here.\n' });
    assert.deepEqual(errors, []);
  });

  it('rejects a second fixup episode', () => {
    const content = `${fixupSubsection()}\n\n${fixupSubsection({ finding: 'second' })}`;
    const errors = validateFilesFixup({ ...baseParams, content });
    assert.ok(errors.some(e => /at most one is allowed/.test(e)));
  });

  it('rejects a fixup on an independent-review task', () => {
    const errors = validateFilesFixup({ ...baseParams, content: fixupSubsection(), independentRequired: true });
    assert.ok(errors.some(e => /independent_review_required is true/.test(e)));
  });

  it('requires final review_mode single_agent_fallback', () => {
    const errors = validateFilesFixup({ ...baseParams, content: fixupSubsection(), reviewMode: 'host_subagent' });
    assert.ok(errors.some(e => /review_mode 'single_agent_fallback'/.test(e)));
  });

  for (const field of FIXUP_FIELDS) {
    it(`requires the '${field.label}' field`, () => {
      const errors = validateFilesFixup({ ...baseParams, content: fixupSubsectionWithout(field.label) });
      assert.ok(
        errors.some(e => e.includes(`missing required field '${field.label}'`)),
        errors.join('\n')
      );
    });
  }

  it('requires BOTH planned verification and verification result (one is not enough)', () => {
    const onlyPlanned = validateFilesFixup({ ...baseParams, content: fixupSubsectionWithout('Verification result') });
    assert.ok(onlyPlanned.some(e => e.includes("missing required field 'Verification result'")));

    const onlyResult = validateFilesFixup({ ...baseParams, content: fixupSubsectionWithout('Planned verification') });
    assert.ok(onlyResult.some(e => e.includes("missing required field 'Planned verification'")));
  });

  it('rejects duplicate recognized fields', () => {
    const content = [fixupSubsection(), '- Resulting artifact: commit:ccc333'].join('\n');
    const errors = validateFilesFixup({ ...baseParams, content });
    assert.ok(errors.some(e => /duplicate field 'Resulting artifact'/.test(e)));
    // The duplicate must not silently replace the recorded resulting artifact.
    const episode = detectFixupEpisodes(content)[0];
    assert.equal(episode.fields.resulting_artifact, 'commit:bbb222');
  });

  it('requires base and resulting artifacts to differ', () => {
    const same = validateFilesFixup({
      ...baseParams,
      content: fixupSubsection({ base: 'commit:same', resulting: 'commit:same' }),
      implementationArtifact: 'commit:same',
      reviewedArtifact: 'commit:same',
      evidenceBody: 'npm test passed on commit:same',
    });
    assert.ok(same.some(e => /identical/.test(e)));
  });

  it('requires the final reviewed artifact to match the resulting artifact', () => {
    const errors = validateFilesFixup({ ...baseParams, content: fixupSubsection(), reviewedArtifact: 'commit:other' });
    assert.ok(errors.some(e => /does not match the final reviewed artifact/.test(e)));
  });

  it('rejects a fixup record with no final evidence body', () => {
    const errors = validateFilesFixup({ ...baseParams, content: fixupSubsection(), evidenceBody: '' });
    assert.ok(errors.some(e => /no non-empty final '## Evidence' section/.test(e)), errors.join('\n'));
  });

  it('rejects evidence that references only the base artifact', () => {
    const errors = validateFilesFixup({
      ...baseParams,
      content: fixupSubsection(),
      evidenceBody: 'npm test: 128 passing (exit 0) on commit:aaa111',
    });
    assert.ok(errors.some(e => /does not reference the resulting artifact/.test(e)), errors.join('\n'));
  });

  it('accepts evidence that references the resulting artifact by bare token', () => {
    const errors = validateFilesFixup({
      ...baseParams,
      content: fixupSubsection(),
      evidenceBody: 'npm test: 128 passing (exit 0)\nFinal state bbb222 verified.',
    });
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------
// validateFilesTaskRecord integration
// ---------------------------------------------------------------------------

function filesTaskRecordWithFixup({
  reviewMode = 'single_agent_fallback',
  extraFront = [],
  fixup = fixupSubsection(),
  evidence = 'npm test: 128 passing (exit 0) on commit:bbb222',
  includeEvidenceSection = true,
} = {}) {
  return [
    '---',
    'task_id: T-001',
    'status: accepted',
    'backend: files',
    'implementation_artifact: commit:bbb222',
    'review_status: accepted',
    'reviewed_artifact: commit:bbb222',
    `review_mode: ${reviewMode}`,
    ...extraFront,
    '---',
    '## Scope Completed',
    'Done.',
    '## Artifacts',
    '- commit:bbb222',
    ...(includeEvidenceSection ? ['## Evidence', evidence] : []),
    '## Deviations',
    'None.',
    '## Process Observations',
    'None.',
    '## Known Gaps',
    'None.',
    '## Follow-Ups',
    'None.',
    '',
    fixup,
  ].join('\n');
}

describe('validateFilesTaskRecord with a durable fixup subsection', () => {
  it('accepts an eligible single-episode fixup record', () => {
    const errors = validateFilesTaskRecord(filesTaskRecordWithFixup(), 'T-001.md', { activeTaskBackend: 'files' });
    assert.deepEqual(errors, []);
  });

  it('rejects a fixup record that requires independent review', () => {
    const content = filesTaskRecordWithFixup({ extraFront: ['independent_review_required: true'] });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.ok(errors.some(e => /independent_review_required is true/.test(e)));
  });

  it('rejects a duplicate fixup subsection', () => {
    const content = filesTaskRecordWithFixup({ fixup: `${fixupSubsection()}\n\n${fixupSubsection({ finding: 'second' })}` });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.ok(errors.some(e => /at most one is allowed/.test(e)));
  });

  it("rejects a fixup record whose only completion signal is '## Scope Completed' (no evidence)", () => {
    const content = filesTaskRecordWithFixup({ includeEvidenceSection: false });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.ok(errors.some(e => /no non-empty final '## Evidence' section/.test(e)), errors.join('\n'));
  });

  it('rejects a fixup record whose evidence cites only the base artifact', () => {
    const content = filesTaskRecordWithFixup({ evidence: 'npm test: 128 passing (exit 0) on commit:aaa111' });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.ok(errors.some(e => /does not reference the resulting artifact/.test(e)), errors.join('\n'));
  });

  it('accepts a fixup record whose evidence is associated with the resulting artifact', () => {
    const content = filesTaskRecordWithFixup({ evidence: 'npm test: 128 passing (exit 0)\nVerified at commit:bbb222.' });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.deepEqual(errors, []);
  });

  it('rejects an incomplete fixup subsection through the real files entry point', () => {
    const content = filesTaskRecordWithFixup({
      fixup: [MAINTAINER_FIXUP_HEADING, '', '- Finding: x'].join('\n'),
    });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.ok(errors.some(e => /missing required field 'Eligibility decision'/.test(e)));
    assert.ok(errors.some(e => /missing required field 'Verification result'/.test(e)));
  });
});

// ---------------------------------------------------------------------------
// commit trailers + cross-check
// ---------------------------------------------------------------------------

describe('commitHasMaintainerFixupTrailers', () => {
  it('requires both Task: and Agent: maintainer trailers', () => {
    assert.equal(commitHasMaintainerFixupTrailers('Fix guard\n\nTask: T-001\nAgent: maintainer'), true);
    assert.equal(commitHasMaintainerFixupTrailers('Fix guard\n\nTask: T-001'), false);
    assert.equal(commitHasMaintainerFixupTrailers('Fix guard\n\nAgent: maintainer'), false);
    assert.equal(commitHasMaintainerFixupTrailers('Fix guard\n\nAgent: engineer\nTask: T-001'), false);
  });

  it('normalizes surrounding whitespace but requires the exact maintainer value', () => {
    assert.equal(commitHasMaintainerFixupTrailers('x\n\nTask: T-001\n  Agent:   maintainer  '), true);
    assert.equal(commitHasMaintainerFixupTrailers('x\n\nTask: T-001\nAgent: maintainer bot'), false);
    assert.equal(commitHasMaintainerFixupTrailers('x\n\nTask: T-001\nAgent: Maintainer'), false);
  });

  it('extracts Task: trailer values', () => {
    assert.deepEqual(commitTaskTrailerValues('x\n\nTask: T-001\nAgent: maintainer'), ['T-001']);
    assert.deepEqual(commitTaskTrailerValues('no trailers here'), []);
  });
});

describe('crossCheckMaintainerFixup (event/subsection mismatch, where cross-checking is available)', () => {
  it('agrees when both are present or both absent', () => {
    assert.deepEqual(crossCheckMaintainerFixup({ subsectionCount: 1, maintainerFixupEventCount: 1 }), { errors: [], warnings: [] });
    assert.deepEqual(crossCheckMaintainerFixup({ subsectionCount: 0, maintainerFixupEventCount: 0 }), { errors: [], warnings: [] });
  });

  it('warns for historical mismatch, errors for newly produced', () => {
    const historical = crossCheckMaintainerFixup({ subsectionCount: 1, maintainerFixupEventCount: 0 });
    assert.equal(historical.warnings.length, 1);
    assert.equal(historical.errors.length, 0);

    const produced = crossCheckMaintainerFixup({ subsectionCount: 0, maintainerFixupEventCount: 1, newlyProduced: true });
    assert.equal(produced.errors.length, 1);
    assert.equal(produced.warnings.length, 0);
  });

  it('reports more than one maintainer_fixup: true event as a multiple-episode anomaly', () => {
    const result = crossCheckMaintainerFixup({ subsectionCount: 1, maintainerFixupEventCount: 2 });
    assert.ok(result.warnings.some(w => /at most one fixup episode/.test(w)), result.warnings.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Cross-check through the production `agenticloop validate` surface
// ---------------------------------------------------------------------------

function writeValidateTarget(name, { eventLogging = 'enabled', taskContent = null } = {}) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'tasks'), { recursive: true });
  writeFileSync(
    join(target, '.agenticloop', 'project.md'),
    [
      '---',
      'setup_status: unconfirmed',
      'setup_confirmed_at: ""',
      'setup_confirmed_by: ""',
      'task_backend: files',
      `event_logging: ${eventLogging}`,
      'event_logging_command: ""',
      'task_id_pattern: "T-<number>"',
      'task_id_regex: "^T-\\d{3,}$"',
      'task_file_template: ".agenticloop/tasks/{taskId}.md"',
      'grouping_profile: flat',
      '---',
      '# Project Map',
    ].join('\n'),
    'utf-8'
  );
  if (taskContent !== null) {
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), taskContent, 'utf-8');
  }
  return target;
}

function appendFixupEvent(target, {
  maintainerFixup = true,
  task = 'T-001',
  logTask = task,
  role = 'maintainer',
  reviewMode = 'single_agent_fallback',
} = {}) {
  appendEventLog({
    target,
    historical: true,
    path: join(target, '.agenticloop', 'logs', `${logTask}.jsonl`),
    event: buildEvent({
      target,
      task,
      eventType: 'review.result',
      role,
      summary: 'Accepted after fixup',
      outcome: 'accepted',
      data: { review_round: 1, review_mode: reviewMode, ...(maintainerFixup ? { maintainer_fixup: true } : {}) },
    }),
  });
}

describe('agenticloop validate cross-checks fixup subsections against events', () => {
  it('warns when a durable subsection has no maintainer_fixup event and logging is enabled', () => {
    const target = writeValidateTarget('xcheck-missing-event', { taskContent: filesTaskRecordWithFixup() });
    const { warnings } = validateConfig(target);
    assert.ok(
      warnings.some(w => w.includes("Task record 'T-001.md'") && w.includes('no corresponding maintainer_fixup: true event')),
      warnings.join('\n')
    );
  });

  it('does not warn when the subsection and one maintainer_fixup event agree', () => {
    const target = writeValidateTarget('xcheck-agree', { taskContent: filesTaskRecordWithFixup() });
    appendFixupEvent(target);
    const { warnings } = validateConfig(target);
    assert.ok(!warnings.some(w => w.includes('maintainer_fixup')), warnings.join('\n'));
  });

  it('warns when a maintainer_fixup event exists without a durable subsection', () => {
    const target = writeValidateTarget('xcheck-missing-subsection', {
      taskContent: filesTaskRecordWithFixup({ fixup: '' }),
    });
    appendFixupEvent(target);
    const { warnings } = validateConfig(target);
    assert.ok(
      warnings.some(w => w.includes("Task record 'T-001.md'") && w.includes('no durable Maintainer Review Fixup subsection')),
      warnings.join('\n')
    );
  });

  it('reports more than one maintainer_fixup event as a multiple-episode anomaly', () => {
    const target = writeValidateTarget('xcheck-multiple', { taskContent: filesTaskRecordWithFixup() });
    appendFixupEvent(target);
    appendFixupEvent(target);
    const { warnings } = validateConfig(target);
    assert.ok(warnings.some(w => /at most one fixup episode/.test(w)), warnings.join('\n'));
  });

  it('does not let a wrong-role fixup event satisfy the durable subsection cross-check', () => {
    const target = writeValidateTarget('xcheck-wrong-role', { taskContent: filesTaskRecordWithFixup() });
    appendFixupEvent(target, { role: 'engineer' });
    const { warnings } = validateConfig(target);
    assert.ok(warnings.some(w => /malformed historical events do not satisfy durable fixup evidence/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some(w => /no corresponding maintainer_fixup: true event/.test(w)), warnings.join('\n'));
  });

  it('does not let a wrong-mode fixup event satisfy the durable subsection cross-check', () => {
    const target = writeValidateTarget('xcheck-wrong-mode', { taskContent: filesTaskRecordWithFixup() });
    appendFixupEvent(target, { reviewMode: 'host_subagent' });
    const { warnings } = validateConfig(target);
    assert.ok(warnings.some(w => /malformed historical events do not satisfy durable fixup evidence/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some(w => /no corresponding maintainer_fixup: true event/.test(w)), warnings.join('\n'));
  });

  it('does not let a mismatched task_id event in the task log satisfy the cross-check', () => {
    const target = writeValidateTarget('xcheck-wrong-task', { taskContent: filesTaskRecordWithFixup() });
    appendFixupEvent(target, { task: 'T-999', logTask: 'T-001' });
    const { warnings } = validateConfig(target);
    assert.ok(warnings.some(w => /malformed historical events do not satisfy durable fixup evidence/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some(w => /no corresponding maintainer_fixup: true event/.test(w)), warnings.join('\n'));
  });

  it('makes no mismatch claim when event logging is disabled', () => {
    const target = writeValidateTarget('xcheck-disabled', {
      eventLogging: 'disabled',
      taskContent: filesTaskRecordWithFixup(),
    });
    const { warnings } = validateConfig(target);
    assert.ok(!warnings.some(w => w.includes('maintainer_fixup')), warnings.join('\n'));
  });

  it('an ordinary fallback review (no subsection, no event) is never called a fixup', () => {
    const target = writeValidateTarget('xcheck-ordinary-fallback', {
      taskContent: filesTaskRecordWithFixup({ fixup: '' }),
    });
    const { warnings } = validateConfig(target);
    assert.ok(!warnings.some(w => w.includes('maintainer_fixup') || w.includes('Maintainer Review Fixup')), warnings.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// GitHub review audit fixup extension
// ---------------------------------------------------------------------------

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const BASE = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1';
const OLD_HEAD = 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';
const OLD_BASE = 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3';
const LOOP_ACCOUNT = { login: 'loop-bot', type: 'User' };

function ghFixup(overrides = {}) {
  return fixupSubsection({ base: BASE, resulting: HEAD, ...overrides });
}

function reviewMarker({ mode = 'single_agent_fallback', status = 'accepted', artifact = HEAD, fixup = null } = {}) {
  const lines = [
    `AGENT_REVIEW_STATUS: ${status}`,
    `AGENT_REVIEW_MODE: ${mode}`,
    `AGENT_REVIEW_ARTIFACT: ${artifact}`,
    '[[agent: maintainer]]',
  ];
  if (fixup) {
    lines.push('', fixup);
  }
  return { body: lines.join('\n'), author: LOOP_ACCOUNT };
}

function baseCommit() {
  return { oid: BASE, messageHeadline: 'Engineer implementation', messageBody: '' };
}

function fixupCommit({ oid = HEAD, task = 'T-001', agent = 'maintainer' } = {}) {
  return { oid, messageHeadline: 'Fix duplicated guard', messageBody: `Task: ${task}\nAgent: ${agent}` };
}

function auditData({ comments, commits = [baseCommit(), fixupCommit()], issueBody = '', taskPrData = [] } = {}) {
  return {
    prData: { number: 42, headRefOid: HEAD, closingIssuesReferences: [{ number: 7 }], comments, reviews: [], commits },
    issueData: { number: 7, body: issueBody },
    taskPrData,
    expectedAccount: LOOP_ACCOUNT,
  };
}

describe('GitHub review audit: Maintainer Review Fixup', () => {
  it('normalizes supported artifact spellings to a bare lowercase SHA', () => {
    assert.equal(normalizeGitHubFixupArtifact(`commit:${HEAD.toUpperCase()}`), HEAD);
    assert.equal(normalizeGitHubFixupArtifact(` sha:${HEAD} `), HEAD);
    assert.equal(normalizeGitHubFixupArtifact(HEAD), HEAD);
  });

  it('accepts a current-head fixup with single_agent_fallback and maintainer-attributed commit (case 8, 12)', () => {
    const result = evaluateGitHubReviewAudit(auditData({ comments: [reviewMarker({ fixup: ghFixup() })] }));
    assert.equal(result.maintainerFixup, true);
    assert.equal(result.maintainerFixupCurrent, true);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('accepts a current-head fixup recorded with the commit: artifact spelling', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup({ base: `commit:${BASE}`, resulting: `commit:${HEAD}` }) })],
    }));
    assert.equal(result.maintainerFixupCurrent, true);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects an incomplete fixup subsection (case 1)', () => {
    const body = [reviewMarker().body, '', MAINTAINER_FIXUP_HEADING, '', '- Finding: x'].join('\n');
    const result = evaluateGitHubReviewAudit(auditData({ comments: [{ body, author: LOOP_ACCOUNT }] }));
    assert.match(result.errors.join('\n'), /missing required field 'Eligibility decision'/);
    assert.match(result.errors.join('\n'), /missing required field 'Resulting artifact'/);
  });

  for (const field of FIXUP_FIELDS) {
    it(`rejects a fixup subsection missing '${field.label}' (case 2)`, () => {
      const overrides = {
        finding: 'Finding', eligibility_decision: 'Eligibility decision', base_artifact: 'Base artifact',
        correction: 'Correction', affected_files: 'Affected files', planned_verification: 'Planned verification',
        verification_result: 'Verification result', resulting_artifact: 'Resulting artifact',
      };
      const blanked = {
        'Finding': { finding: '' },
        'Eligibility decision': { eligibility: '' },
        'Base artifact': { base: '' },
        'Correction': { correction: '' },
        'Affected files': { affected: '' },
        'Planned verification': { plannedVerification: '' },
        'Verification result': { verificationResult: '' },
        'Resulting artifact': { resulting: '' },
      }[overrides[field.key]];
      const result = evaluateGitHubReviewAudit(auditData({
        comments: [reviewMarker({ fixup: ghFixup(blanked) })],
      }));
      assert.match(result.errors.join('\n'), new RegExp(`missing required field '${field.label}'`));
    });
  }

  it('rejects a duplicate field in the fixup subsection (case 3)', () => {
    const body = [reviewMarker({ fixup: ghFixup() }).body, '- Correction: second correction'].join('\n');
    const result = evaluateGitHubReviewAudit(auditData({ comments: [{ body, author: LOOP_ACCOUNT }] }));
    assert.match(result.errors.join('\n'), /duplicate field 'Correction'/);
  });

  it('rejects base equal to resulting artifact (case 4)', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup({ base: HEAD, resulting: `commit:${HEAD}` }) })],
    }));
    assert.match(result.errors.join('\n'), /identical/);
  });

  it('rejects artifacts that do not normalize to a full 40-character SHA', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup({ base: 'commit:aaa111' }) })],
    }));
    assert.match(result.errors.join('\n'), /'Base artifact' must be a full 40-character commit SHA/);
  });

  it('a historical fixup does not force the current review mode (case 5a)', () => {
    // Fixup episode superseded by an engineer revision; current head reviewed
    // through a genuinely delegated host_subagent maintainer.
    const historicalFixup = ghFixup({ base: OLD_BASE, resulting: OLD_HEAD });
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [
        { body: [reviewMarker({ artifact: OLD_HEAD, fixup: historicalFixup }).body].join('\n'), author: LOOP_ACCOUNT },
        reviewMarker({ mode: 'host_subagent' }),
      ],
    }));
    assert.equal(result.maintainerFixup, true);
    assert.equal(result.maintainerFixupCurrent, false);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('a historical fixup still counts toward the one-episode limit (case 5b, 13)', () => {
    const historicalFixup = ghFixup({ base: OLD_BASE, resulting: OLD_HEAD });
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [
        { body: historicalFixup, author: LOOP_ACCOUNT },
        reviewMarker({ fixup: ghFixup() }),
      ],
    }));
    assert.match(result.errors.join('\n'), /more than one Maintainer Review Fixup/);
  });

  it('enforces the one-fixup limit across replacement PRs linked to the same task', () => {
    const relatedPr = {
      number: 41,
      comments: [{ body: ghFixup({ base: OLD_BASE, resulting: OLD_HEAD }), author: LOOP_ACCOUNT }],
      reviews: [],
    };
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      taskPrData: [relatedPr],
    }));
    assert.match(result.errors.join('\n'), /more than one Maintainer Review Fixup/);
    assert.equal(result.maintainerFixupEpisodeCount, 2);
  });

  it('runGitHubReviewAudit loads cross-referenced task PR history before accepting a fixup', () => {
    const currentPr = auditData({ comments: [reviewMarker({ fixup: ghFixup() })] }).prData;
    const issueData = { number: 7, body: ['---', 'task_id: T-001', '---'].join('\n') };
    const relatedPr = {
      number: 41,
      comments: [{ body: ghFixup({ base: OLD_BASE, resulting: OLD_HEAD }), author: LOOP_ACCOUNT }],
      reviews: [],
    };
    const calls = [];
    const runner = (_command, args) => {
      calls.push(args);
      let payload;
      if (args[0] === 'api' && args[1] === 'user') {
        payload = LOOP_ACCOUNT;
      } else if (args[0] === 'api' && args.at(-1)?.endsWith('/issues/7/timeline')) {
        payload = [[{
          event: 'cross-referenced',
          source: { issue: { number: 41, pull_request: {}, repository: { full_name: 'owner/repo' } } },
        }]];
      } else if (args[0] === 'pr' && args[2] === '42') {
        payload = currentPr;
      } else if (args[0] === 'pr' && args[2] === '41') {
        payload = relatedPr;
      } else if (args[0] === 'issue') {
        payload = issueData;
      } else {
        return { status: 1, stdout: '', stderr: `unexpected gh args: ${args.join(' ')}` };
      }
      return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
    };

    const result = runGitHubReviewAudit({ pr: 42, repo: 'owner/repo', commandRunner: runner });
    assert.match(result.errors.join('\n'), /more than one Maintainer Review Fixup/);
    assert.ok(calls.some(args => args.at(-1)?.endsWith('/issues/7/timeline')));
    assert.ok(calls.some(args => args[0] === 'pr' && args[2] === '41'));
  });

  it('historical fixup followed by current host_subagent engineer re-review is accepted (case 6)', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [
        { body: ghFixup({ base: OLD_BASE, resulting: OLD_HEAD }), author: LOOP_ACCOUNT },
        reviewMarker({ mode: 'host_subagent' }),
      ],
      // The superseded fixup commit may no longer be reachable in PR history.
      commits: [baseCommit(), { oid: HEAD, messageHeadline: 'Engineer revision', messageBody: '' }],
    }));
    assert.equal(result.maintainerFixup, true);
    assert.equal(result.maintainerFixupCurrent, false);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects a current-head fixup reviewed with host_subagent (case 7)', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ mode: 'host_subagent', fixup: ghFixup() })],
    }));
    assert.match(result.errors.join('\n'), /must record AGENT_REVIEW_MODE: single_agent_fallback/);
  });

  it('fails closed when commit data is missing for a current fixup (case 9)', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      commits: null,
    }));
    assert.match(result.errors.join('\n'), /commit data is unavailable/);
  });

  it('fails closed when a PR commit has no resolvable full oid', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      commits: [{ messageHeadline: 'no oid', messageBody: 'Task: T-001\nAgent: maintainer' }],
    }));
    assert.match(result.errors.join('\n'), /commit data is malformed/);
  });

  it('a trailer on an unrelated commit does not satisfy attribution (case 10)', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      commits: [
        fixupCommit({ oid: OLD_HEAD }), // unrelated earlier commit carrying trailers
        baseCommit(),
        { oid: HEAD, messageHeadline: 'Fix guard', messageBody: '' }, // fixup range commit without trailers
      ],
    }));
    assert.match(result.errors.join('\n'), /no commit in the fixup range carries the Task: and Agent: maintainer/);
  });

  it('rejects a wrong Task: trailer when the issue declares a canonical task identity (case 11)', () => {
    const issueBody = ['---', 'task_id: T-001', '---', 'Task body'].join('\n');
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      commits: [baseCommit(), fixupCommit({ task: 'T-999' })],
      issueBody,
    }));
    assert.match(result.errors.join('\n'), /does not identify the task: no fixup-range commit carries a 'Task: T-001' trailer/);
  });

  it('accepts correct attribution against the canonical task identity (case 12)', () => {
    const issueBody = ['---', 'task_id: T-001', '---', 'Task body'].join('\n');
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      issueBody,
    }));
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects a fixup whose resulting artifact is the head but not a PR commit', () => {
    const result = evaluateGitHubReviewAudit(auditData({
      comments: [reviewMarker({ fixup: ghFixup() })],
      commits: [baseCommit()],
    }));
    assert.match(result.errors.join('\n'), /is not a commit on this pull request/);
  });

  it('ignores a fenced example fixup subsection in the PR body (case 14)', () => {
    const body = [
      reviewMarker({ mode: 'host_subagent' }).body,
      '',
      '```md',
      MAINTAINER_FIXUP_HEADING,
      '- Finding: example',
      '```',
    ].join('\n');
    const result = evaluateGitHubReviewAudit(auditData({ comments: [{ body, author: LOOP_ACCOUNT }] }));
    assert.equal(result.maintainerFixup, false);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('a fallback review mode without a subsection does not count as a fixup (case 15)', () => {
    const result = evaluateGitHubReviewAudit(auditData({ comments: [reviewMarker()] }));
    assert.equal(result.maintainerFixup, false);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('does not require a fixup on ordinary host_subagent reviews (no subsection)', () => {
    const result = evaluateGitHubReviewAudit(auditData({ comments: [reviewMarker({ mode: 'host_subagent' })] }));
    assert.equal(result.maintainerFixup, false);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Docs and generated-adapter contract
// ---------------------------------------------------------------------------

describe('fixup eligibility verdict line is documented', () => {
  const skill = readFileSync(join(REPO_ROOT, 'skills', 'review-and-accept', 'SKILL.md'), 'utf-8');

  it('review-and-accept documents the ineligible/applied verdict line and reasons', () => {
    assert.match(skill, /Maintainer Review Fixup: ineligible — Lens 1 not clean/);
    assert.match(skill, /Maintainer Review Fixup: ineligible — requires changed tests/);
    assert.match(skill, /Maintainer Review Fixup: ineligible — independent review required/);
    assert.match(skill, /Maintainer Review Fixup: ineligible — outside allowed paths/);
    assert.match(skill, /Maintainer Review Fixup: ineligible — earlier fixup episode already exists/);
    assert.match(skill, /Maintainer Review Fixup: applied — <short concrete finding>/);
  });

  it('review-and-accept documents the standardized durable subsection shape', () => {
    for (const label of ['Finding:', 'Eligibility decision:', 'Base artifact:', 'Correction:', 'Affected files:', 'Planned verification:', 'Verification result:', 'Resulting artifact:']) {
      assert.ok(skill.includes(`- ${label}`), `expected durable field '${label}'`);
    }
  });

  it('review-and-accept states that all eight fields are mandatory', () => {
    assert.match(skill, /[Aa]ll eight fields are mandatory/);
  });
});

describe('role-delegation delegation-mode prompt contract', () => {
  const roleDelegation = readFileSync(join(REPO_ROOT, 'skills', 'role-delegation', 'SKILL.md'), 'utf-8');

  it('canonical skill carries the explicit Delegation mode / Fallback cause / Fallback reason lines', () => {
    assert.match(roleDelegation, /Delegation mode:\s+host_subagent \| explicit_agent_invocation \| single_agent_fallback/);
    assert.match(roleDelegation, /Fallback cause:\s+mechanism_absent \| invocation_failed/);
    assert.match(roleDelegation, /Fallback reason:/);
  });

  it('every packaging adapter preserves the Delegation mode prompt line', () => {
    const adapters = [
      { name: 'codex', generate: generateCodexArtifacts, dirs: ['.codex', '.agents'] },
      { name: 'claude-code', generate: generateClaudeCodeArtifacts, dirs: ['.claude'] },
      { name: 'copilot', generate: generateCopilotArtifacts, dirs: ['.github'] },
      { name: 'cursor', generate: generateCursorArtifacts, dirs: ['.cursor'] },
    ];
    for (const adapter of adapters) {
      const fx = mkdtempSync(join(tmpDir, `${adapter.name}-fx-`));
      seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });
      const out = mkdtempSync(join(tmpDir, `${adapter.name}-out-`));
      const { files } = adapter.generate(loadAgenticLoopConfig(join(fx, 'agenticloop.json')), fx, out);
      const roleDelegationRef = files.find(f => /role-delegation\/reference\.md$/.test(f));
      assert.ok(roleDelegationRef, `${adapter.name} did not generate a role-delegation reference`);
      const content = readFileSync(join(out, roleDelegationRef), 'utf-8');
      assert.match(content, /Delegation mode:/, `${adapter.name} reference missing Delegation mode line`);
      assert.match(content, /Fallback cause:/, `${adapter.name} reference missing Fallback cause line`);
    }
  });
});
