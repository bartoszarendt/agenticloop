import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerificationOperatingFacts,
  validateVerificationAttempts,
  validateGitHubVerificationAttempts,
} from '../src/verification-learning.js';
import { validateFilesTaskRecord } from '../src/validate-config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOOP_ACCOUNT = { login: 'loop-bot', type: 'User' };

const FACT = `## Verification Operating Facts

### VF-full-suite

- Command: \`npm test\`
- Last outcome: timed_out
- Observed duration ms: 180000
- Timeout ms: 180000
- Host timeout ceiling ms: 180000
- Strategy: background
- Updated: 2026-07-17
- Source: T-017
- Revisit when: the suite layout, expected runtime, CI behavior, or host ceiling changes
- Decision: none`;

function factWithSource(source) {
  return FACT.replace('- Source: T-017', `- Source: ${source}`);
}

function attempt({
  number = 1,
  command = '`npm test`',
  artifact = 'commit:abc123',
  strategy = 'foreground',
  timeout = 180000,
  outcome = 'timed_out',
  candidate = 'project_fact',
} = {}) {
  return `#### Attempt ${number}

- Artifact: ${artifact}
- Command: ${command}
- Strategy: ${strategy}
- Timeout ms: ${timeout}
- Outcome: ${outcome}
- Duration ms: ${timeout}
- Required: true
- Partial evidence: test process exceeded the foreground host ceiling
- Proposed next strategy: background
- Candidate classification: ${candidate}
- Recorded by: engineer
- Recorded at: 2026-07-17T12:00:00Z`;
}

function triage({ number = 1, classification = 'project_fact', reference = 'VF-full-suite', reason = '' } = {}) {
  return `#### Triage for attempt ${number}

- Classification: ${classification}
- Reference: ${reference}
${reason ? `- Reason: ${reason}\n` : ''}- Triaged by: maintainer
- Triaged at: 2026-07-17T12:30:00Z`;
}

function prediction({ number = 2, based = 1, evidence = 'comparable successful runs normally finish between 220000 and 260000 ms', window = '220000-260000', timeout = 300000 } = {}) {
  return `#### Foreground escalation prediction for attempt ${number}

- Based on attempt: ${based}
- Evidence: ${evidence}
- Predicted completion window ms: ${window}
- Chosen timeout ms: ${timeout}
- Recorded by: engineer
- Recorded at: 2026-07-17T12:05:00Z`;
}

function history(entries) {
  return `## Verification Attempts

### RC-1

${entries.join('\n\n')}`;
}

describe('project verification operating facts', () => {
  it('accepts the canonical empty section', () => {
    const result = parseVerificationOperatingFacts('## Verification Operating Facts\n\nNo project-wide verification operating facts are currently recorded.');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.facts, []);
  });

  it('parses a valid fact', () => {
    const result = parseVerificationOperatingFacts(FACT);
    assert.deepEqual(result.errors, []);
    assert.equal(result.facts[0].id, 'VF-full-suite');
    assert.equal(result.facts[0].strategy, 'background');
  });

  it('accepts every supported durable source form', () => {
    const cases = [
      ['P25-17', { taskIdRegex: '^P\\d+-\\d+$' }],
      ['task:P25-17', { taskIdRegex: '^P\\d+-\\d+$' }],
      ['event:550e8400-e29b-41d4-a716-446655440000', {}],
      ['issue:#17', {}],
      ['pr:17', {}],
      ['github:issue:17', {}],
      ['github:pr:17', {}],
      ['commit:abcdef1', {}],
      ['https://github.com/example/project/issues/17', {}],
      ['docs/testing.md#fast-unit-tests', {}],
    ];

    for (const [source, options] of cases) {
      const result = parseVerificationOperatingFacts(factWithSource(source), options);
      assert.deepEqual(result.errors, [], `expected durable source to pass: ${source}`);
    }
  });

  it('rejects empty source prefixes, prose, and task ids outside the configured pattern', () => {
    const sources = [
      'task:',
      'event:',
      'commit:',
      'https://',
      'fast unit selection timed out during verification',
      'P25-17',
    ];

    for (const source of sources) {
      const result = parseVerificationOperatingFacts(factWithSource(source));
      assert.ok(
        result.errors.some(error => error.includes("field 'Source'")),
        `expected non-durable source to fail: ${source}`
      );
    }
  });

  it('rejects duplicate ids, invalid enums and invalid numeric fields', () => {
    const bad = `${FACT}\n\n### VF-full-suite\n\n${FACT.split('### VF-full-suite')[1]}`
      .replace('Last outcome: timed_out', 'Last outcome: unknown')
      .replace('Timeout ms: 180000', 'Timeout ms: forever');
    const result = parseVerificationOperatingFacts(bad);
    assert.ok(result.errors.some(error => error.includes('duplicated')));
    assert.ok(result.errors.some(error => error.includes('Last outcome')));
    assert.ok(result.errors.some(error => error.includes('Timeout ms')));
  });

  it('rejects missing source, revisit trigger, malformed decision, and contradictory command facts', () => {
    const bad = `${FACT.replace('Source: T-017', 'Source: ').replace('Revisit when: the suite layout, expected runtime, CI behavior, or host ceiling changes', 'Revisit when: ').replace('Decision: none', 'Decision: a note')}\n\n### VF-copy\n\n${FACT.split('### VF-full-suite')[1]}`;
    const result = parseVerificationOperatingFacts(bad);
    assert.ok(result.errors.some(error => error.includes("'Source'")));
    assert.ok(result.errors.some(error => error.includes("'Revisit when'")));
    assert.ok(result.errors.some(error => error.includes("'Decision'")));
    assert.ok(result.errors.some(error => error.includes('contradictory active entries')));
  });
});

describe('task verification attempts', () => {
  it('accepts a valid timed-out attempt with final project-fact triage', () => {
    const result = validateVerificationAttempts(history([attempt(), triage()]), {
      status: 'accepted',
      projectFacts: [{ id: 'VF-full-suite' }],
    });
    assert.deepEqual(result.errors, []);
  });

  it('keeps historical task records without attempts compatible', () => {
    const result = validateVerificationAttempts('## Required Checks\n- [RC-1] `npm test`', { status: 'closed' });
    assert.deepEqual(result.errors, []);
  });

  it('warns while active but rejects accepted work with missing final timeout triage', () => {
    const active = validateVerificationAttempts(history([attempt({ candidate: '' })]), { status: 'in-progress' });
    assert.equal(active.errors.length, 0);
    assert.ok(active.warnings.some(warning => warning.includes('Candidate classification')));
    const accepted = validateVerificationAttempts(history([attempt()]), { status: 'accepted' });
    assert.ok(accepted.errors.some(error => error.includes('lacks final maintainer triage')));
  });

  it('enforces classification-specific references', () => {
    const oneOff = validateVerificationAttempts(history([attempt(), triage({ classification: 'one_off', reference: 'none' })]), { status: 'accepted' });
    assert.ok(oneOff.errors.some(error => error.includes("'one_off' requires")));
    const decision = validateVerificationAttempts(history([attempt(), triage({ classification: 'decision', reference: 'not-a-decision' })]), { status: 'accepted' });
    assert.ok(decision.errors.some(error => error.includes("'decision' requires")));
    const followUp = validateVerificationAttempts(history([attempt(), triage({ classification: 'follow_up', reference: 'later' })]), { status: 'accepted' });
    assert.ok(followUp.errors.some(error => error.includes("'follow_up' requires")));
    const blocker = validateVerificationAttempts(history([attempt(), triage({ classification: 'blocker', reference: 'later' })]), { status: 'accepted' });
    assert.ok(blocker.errors.some(error => error.includes("'blocker' requires")));
  });

  it('accepts every final triage classification with its required reference', () => {
    const oneOff = validateVerificationAttempts(history([
      attempt(),
      triage({ classification: 'one_off', reference: 'none', reason: 'the local runner was interrupted once' }),
    ]), { status: 'accepted' });
    assert.deepEqual(oneOff.errors, []);
    const decision = validateVerificationAttempts(history([
      attempt(), triage({ classification: 'decision', reference: 'D-2026-07-17-001' }),
    ]), { status: 'accepted', decisionExists: id => id === 'D-2026-07-17-001' });
    assert.deepEqual(decision.errors, []);
    const followUp = validateVerificationAttempts(history([
      attempt(), triage({ classification: 'follow_up', reference: 'T-099' }),
    ]), { status: 'accepted', taskExists: id => id === 'T-099' });
    assert.deepEqual(followUp.errors, []);
    const blocker = validateVerificationAttempts(history([
      attempt(), triage({ classification: 'blocker', reference: 'blocker:host-ceiling' }),
    ]), { status: 'accepted' });
    assert.deepEqual(blocker.errors, []);
  });

  it('reports malformed attempt fields through files lifecycle validation', () => {
    const content = `---\ntask_id: T-001\nstatus: in-progress\nbackend: files\n---\n\n${history([attempt().replace('- Command: `npm test`\n', '')])}`;
    const warnings = [];
    const errors = validateFilesTaskRecord(content, 'T-001.md', { warnings });
    assert.ok(errors.some(error => error.includes("field 'Command'")));
  });

  it('rejects accepted files-backed work with an untriaged timeout', () => {
    const content = `---\ntask_id: T-001\nstatus: accepted\nbackend: files\nimplementation_artifact: commit:abc123\nreview_status: accepted\nreviewed_artifact: commit:abc123\nreview_mode: single_agent_fallback\n---\n\n${history([attempt()])}`;
    const errors = validateFilesTaskRecord(content, 'T-001.md', { warnings: [] });
    assert.ok(errors.some(error => error.includes('lacks final maintainer triage')));
  });

  it('accepts one credible bounded foreground escalation', () => {
    const result = validateVerificationAttempts(history([
      attempt(),
      prediction(),
      attempt({ number: 2, timeout: 300000, outcome: 'passed', candidate: 'one_off' }),
    ]));
    assert.deepEqual(result.errors, []);
  });

  it('rejects a missing, generic, unbounded, or repeated foreground escalation', () => {
    const missing = validateVerificationAttempts(history([attempt(), attempt({ number: 2, timeout: 300000, outcome: 'passed' })]));
    assert.ok(missing.errors.some(error => error.includes('no preceding prediction')));
    const generic = validateVerificationAttempts(history([attempt(), prediction({ evidence: 'it may need longer.' }), attempt({ number: 2, timeout: 300000, outcome: 'passed' })]));
    assert.ok(generic.errors.some(error => error.includes('concrete evidence')));
    const unbounded = validateVerificationAttempts(history([attempt(), prediction({ window: 'around 250000' }), attempt({ number: 2, timeout: 300000, outcome: 'passed' })]));
    assert.ok(unbounded.errors.some(error => error.includes('bounded')));
    const repeated = validateVerificationAttempts(history([
      attempt(), prediction(), attempt({ number: 2, timeout: 300000 }), prediction({ number: 3, based: 2, timeout: 360000 }), attempt({ number: 3, timeout: 360000, outcome: 'passed' }),
    ]));
    assert.ok(repeated.errors.some(error => error.includes('more than one foreground timeout escalation')));
    assert.ok(repeated.errors.some(error => error.includes('failed its foreground escalation prediction')));
  });

  it('reports one focused diagnostic for a malformed chosen escalation timeout', () => {
    const result = validateVerificationAttempts(history([
      attempt(),
      prediction({ timeout: 'unknown' }),
      attempt({ number: 2, timeout: 300000, outcome: 'passed' }),
    ]));
    assert.equal(result.errors.filter(error => error.includes("field 'Chosen timeout ms'")).length, 1);
  });
});

describe('GitHub verification-attempt comments', () => {
  it('ignores unrelated comments and validates one matching marked comment', () => {
    const body = `<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\n\n${history([attempt()])}`;
    const result = validateGitHubVerificationAttempts([{ body: 'ordinary summary' }, { body }], {
      requiredChecks: [{ id: 'RC-1' }],
    });
    assert.deepEqual(result.errors, []);
  });

  it('rejects malformed and duplicate marked comments', () => {
    const malformed = validateGitHubVerificationAttempts([{ body: '<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\nno history' }]);
    assert.ok(malformed.errors.some(error => error.includes('canonical')));
    const body = `<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\n\n${history([attempt()])}`;
    const duplicate = validateGitHubVerificationAttempts([{ body }, { body }]);
    assert.ok(duplicate.errors.some(error => error.includes('duplicate')));
  });

  it('ignores quoted, fenced, indented, and differently-authored markers', () => {
    const examples = [
      { body: '```md\n<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\n```', author: LOOP_ACCOUNT },
      { body: '> <!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->', author: LOOP_ACCOUNT },
      { body: '    <!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->', author: LOOP_ACCOUNT },
      {
        body: `<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\n\n${history([attempt()])}\n\n[[agent: engineer]]`,
        author: { login: 'another-user', type: 'User' },
      },
    ];
    const result = validateGitHubVerificationAttempts(examples, { expectedAccount: LOOP_ACCOUNT });
    assert.deepEqual(result.errors, []);
    assert.equal(result.records.length, 0);
  });

  it('requires a trusted marked comment to carry the final role trailer', () => {
    const body = `<!-- AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1 -->\n\n${history([attempt()])}`;
    const missing = validateGitHubVerificationAttempts([{ body, author: LOOP_ACCOUNT }], {
      expectedAccount: LOOP_ACCOUNT,
    });
    assert.ok(missing.errors.some(error => error.includes('attribution trailer')));

    const trusted = validateGitHubVerificationAttempts([{
      body: `${body}\n\n[[agent: engineer]]`,
      author: LOOP_ACCOUNT,
    }], { expectedAccount: LOOP_ACCOUNT });
    assert.deepEqual(trusted.errors, []);
    assert.equal(trusted.records.length, 1);
  });
});

describe('verification contract ownership', () => {
  const read = relative => readFileSync(join(REPO_ROOT, relative), 'utf-8');

  it('keeps retry, relay, and triage ownership with their canonical roles', () => {
    assert.match(read('agents/engineer.md'), /After a foreground timeout, do not rerun the same command/);
    assert.match(read('skills/verification-evidence/SKILL.md'), /Foreground escalation prediction for attempt 2/);
    assert.match(read('agents/orchestrator.md'), /do not approve, select, or imply approval of an execution strategy/);
    assert.match(read('agents/maintainer.md'), /append final\s+maintainer triage before accepting or closing/);
  });

  it('keeps one canonical task format and marked GitHub carrier', () => {
    assert.match(read('memory/task-record.md'), /## Verification Attempts/);
    assert.match(read('backends/github.md'), /AGENTIC_LOOP_VERIFICATION_ATTEMPTS:RC-1/);
    assert.doesNotMatch(read('memory/work-unit-summary.md'), /^## Verification Attempts$/m);
  });

  it('declares backend-writing trust metadata for verification evidence', () => {
    const skill = read('skills/verification-evidence/SKILL.md');
    assert.match(skill, /side_effects: writes-backend/);
    assert.match(skill, /credentials: backend-dependent/);
  });
});
