/**
 * Work-unit audit certificate contract tests.
 *
 * Covers the durable record shape, the exact-baseline certification rule, fresh
 * invocation provenance, the separate audit budget, verdict/limitation rules,
 * and the closeout gate. All fixtures are deterministic: no model invocation,
 * no credentials, no network, no external repository.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendAuditReport,
  applyAuditHumanResolution,
  applyAuditBudgetOverride,
  auditBudgetState,
  certificationStatus,
  completedAuditRuns,
  coveredTaskSetsEqual,
  createAuditRecordContent,
  evaluateAuditCloseoutGate,
  findAuditRecord,
  nextAuditId,
  normalizeCoveredTasks,
  openBlockingFindings,
  parseAuditRecord,
  parseWorkUnitIdentity,
  updateAuditBaseline,
  validateAuditRecord,
  validateAuditRecords,
  workUnitIdentityForGroup,
} from '../src/audit-record.js';
import { DEFAULT_AUDIT_BUDGET } from '../src/layout.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-audit-record-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  mkdirSync(join(target, '.agenticloop', 'audits'), { recursive: true });
  return target;
}

function writeAudit(target, auditId, content) {
  writeFileSync(join(target, '.agenticloop', 'audits', `${auditId}.md`), content, 'utf-8');
}

function baseRecord(overrides = {}) {
  return createAuditRecordContent({
    auditId: 'AUD-001',
    workUnit: 'phase:4',
    coveredTasks: ['T-041', 'T-042'],
    candidateArtifact: 'commit:abc123',
    goal: 'Deliver Phase 4 with its accepted task outcomes integrated.',
    completionOracle: 'All covered task outcomes are present and final checks pass.',
    evidence: 'Integrated verification results for commit:abc123.',
    ...overrides,
  });
}

function report(overrides = {}) {
  return {
    verdict: 'needs_remediation',
    invocationMode: 'host_subagent',
    invocationReference: `ref-${Math.random().toString(36).slice(2)}`,
    auditedArtifact: 'commit:abc123',
    assessment: 'Consolidated assessment across all six perspectives.',
    evidenceChecked: 'npm test (pass)',
    findings: [],
    ...overrides,
  };
}

function blockingFinding(id = 'A-01') {
  return {
    id,
    severity: 'high',
    blocking: true,
    claim: 'Two configuration sources disagree.',
    evidenceRefs: 'src/a.js:10, src/b.js:22',
    consequence: 'Runtime picks the wrong value.',
    requiredOutcome: 'One source of truth for the setting.',
    verificationRequired: 'npm test plus a new integration test.',
  };
}

// Append `count` non-certifying reports, asserting each one is accepted.
function appendRuns(content, count) {
  let current = content;
  for (let index = 0; index < count; index++) {
    const result = appendAuditReport(current, report({ invocationReference: `ref-${index + 1}` }));
    assert.ok(result.ok, `run ${index + 1} should be accepted: ${result.errors.join('; ')}`);
    current = result.content;
  }
  return current;
}

describe('work-unit identity', () => {
  it('accepts canonical grouped and explicit flat identities', () => {
    for (const value of ['phase:4', 'milestone:M2', 'epic:payments', 'custom:squad-a', 'work-unit:login']) {
      const parsed = parseWorkUnitIdentity(value);
      assert.ok(parsed.ok, `${value} should parse: ${parsed.error}`);
      assert.equal(parsed.canonical, value);
    }
  });

  it('rejects an unqualified or unknown-kind identity', () => {
    assert.equal(parseWorkUnitIdentity('phase-4').ok, false);
    assert.equal(parseWorkUnitIdentity('sprint:3').ok, false);
    assert.equal(parseWorkUnitIdentity('').ok, false);
  });

  it('derives grouped identities from the configured grouping profile only', () => {
    assert.equal(workUnitIdentityForGroup('phase', '4'), 'phase:4');
    assert.equal(workUnitIdentityForGroup('milestone', 'M2'), 'milestone:M2');
    assert.equal(workUnitIdentityForGroup('custom', 'squad-a'), 'custom:squad-a');
    // Flat projects have nothing durable to derive from; the human names the unit.
    assert.equal(workUnitIdentityForGroup('flat', 'anything'), null);
  });

  it('never uses a work-unit identity as a filename', () => {
    const target = makeTarget('identity-filenames');
    writeAudit(target, 'AUD-001', baseRecord());
    const found = findAuditRecord(target, 'phase:4');
    assert.ok(found);
    assert.match(found.relPath, /AUD-001\.md$/);
    assert.ok(!found.relPath.includes(':'), 'audit filenames must stay Windows-safe');
  });
});

describe('audit record validation', () => {
  it('accepts a canonical record', () => {
    assert.deepEqual(validateAuditRecord(baseRecord(), '.agenticloop/audits/AUD-001.md'), []);
  });

  it('rejects a missing required heading', () => {
    const content = baseRecord().replace('## Accepted Decisions\n\nnone\n', '');
    const errors = validateAuditRecord(content, '.agenticloop/audits/AUD-001.md');
    assert.ok(errors.some(e => e.includes("missing required section '## Accepted Decisions'")), errors.join('\n'));
  });

  it('rejects model, reasoning effort, provider, and mutable round fields by contract', () => {
    for (const key of ['model', 'reasoning_effort', 'provider', 'audit_round', 'completed_audits']) {
      const content = baseRecord().replace('audit_budget: 5', `${key}: something\naudit_budget: 5`);
      const errors = validateAuditRecord(content, '.agenticloop/audits/AUD-001.md');
      assert.ok(errors.some(e => e.includes(`must not set '${key}'`)), `${key}: ${errors.join('\n')}`);
    }
  });

  it('requires audit_id to match its filename', () => {
    const errors = validateAuditRecord(baseRecord(), '.agenticloop/audits/AUD-009.md');
    assert.ok(errors.some(e => e.includes("must match its filename 'AUD-009.md'")), errors.join('\n'));
  });

  it('rejects an unknown audit_state and an unknown verdict', () => {
    const badState = baseRecord().replace('audit_state: active', 'audit_state: pending');
    assert.ok(validateAuditRecord(badState, 'AUD-001.md').some(e => e.includes('audit_state')));

    const badVerdict = baseRecord().replace('latest_verdict:', 'latest_verdict: approved');
    assert.ok(validateAuditRecord(badVerdict, 'AUD-001.md').some(e => e.includes('latest_verdict')));
  });

  it('rejects a certified state that no longer matches the candidate baseline', () => {
    const certified = baseRecord()
      .replace('audit_state: active', 'audit_state: certified')
      .replace('certified_artifact:', 'certified_artifact: commit:stale')
      .replace('latest_verdict:', 'latest_verdict: certified');
    const errors = validateAuditRecord(certified, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes('does not match candidate_artifact')), errors.join('\n'));
  });

  it('rejects a latest_verdict that disagrees with the last recorded run', () => {
    const content = appendRuns(baseRecord(), 1)
      .replace('latest_verdict: needs_remediation', 'latest_verdict: certified');
    const errors = validateAuditRecord(content, 'AUD-001.md');
    assert.ok(
      errors.some(e => e.includes('latest_verdict must equal the last recorded Auditor verdict')),
      errors.join('\n')
    );
  });

  it('rejects a latest_verdict with no recorded run', () => {
    const content = baseRecord().replace('latest_verdict:', 'latest_verdict: certified');
    const errors = validateAuditRecord(content, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes('records no completed audit run')), errors.join('\n'));
  });

  it('rejects placeholder audit packets before any report can be recorded', () => {
    const placeholder = createAuditRecordContent({
      auditId: 'AUD-001',
      workUnit: 'phase:4',
      coveredTasks: ['T-041'],
      candidateArtifact: 'commit:abc123',
    });
    const errors = validateAuditRecord(placeholder, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes("concrete '## Work Unit Goal'")), errors.join('\n'));
    const append = appendAuditReport(placeholder, report({ verdict: 'certified' }));
    assert.equal(append.ok, false);
    assert.ok(append.errors.some(e => e.includes('existing audit record is invalid')));
  });

  it('requires packet evidence to name the exact candidate artifact', () => {
    const staleEvidence = baseRecord({
      evidence: 'Integrated verification results for commit:older.',
    });
    const errors = validateAuditRecord(staleEvidence, 'AUD-001.md');
    assert.ok(errors.some(error => error.includes("'## Evidence Available'")));
  });

  it('derives the run count from history rather than a stored counter', () => {
    const content = appendRuns(baseRecord(), 3);
    const record = parseAuditRecord(content);
    assert.equal(completedAuditRuns(record), 3);
    assert.deepEqual(record.history.map(entry => entry.runNumber), [1, 2, 3]);
    assert.ok(!Object.hasOwn(record.frontmatter, 'audit_round'));
    assert.ok(!Object.hasOwn(record.frontmatter, 'completed_audits'));
  });

  it('rejects duplicate audit ids and duplicate work units across records', () => {
    const target = makeTarget('duplicates');
    writeAudit(target, 'AUD-001', baseRecord());
    writeAudit(target, 'AUD-002', baseRecord({ auditId: 'AUD-002' }));
    const { errors } = validateAuditRecords(target);
    assert.ok(errors.some(e => e.includes("duplicates work unit 'phase:4'")), errors.join('\n'));
  });

  it('rejects a covered task that does not match the project task id pattern', () => {
    const content = baseRecord({ coveredTasks: ['nope'] });
    const errors = validateAuditRecord(content, 'AUD-001.md', { taskIdRegex: '^T-\\d{3,}$' });
    assert.ok(errors.some(e => e.includes("covered task 'nope'")), errors.join('\n'));
  });
});

describe('exact-baseline certification', () => {
  it('certifies when the artifact and covered-task set both match', () => {
    const result = appendAuditReport(baseRecord(), report({ verdict: 'certified' }));
    assert.ok(result.ok, result.errors.join('; '));
    const record = parseAuditRecord(result.content);
    assert.equal(record.auditState, 'certified');
    assert.equal(record.certifiedArtifact, 'commit:abc123');
    assert.deepEqual(record.certifiedCoveredTasks, ['T-041', 'T-042']);
    assert.equal(certificationStatus(record).current, true);
    assert.deepEqual(validateAuditRecord(result.content, 'AUD-001.md'), []);
  });

  it('never treats frontmatter-only certification as current', () => {
    const forged = baseRecord()
      .replace('audit_state: active', 'audit_state: certified')
      .replace('certified_artifact:', 'certified_artifact: commit:abc123')
      .replace('certified_covered_tasks: []', 'certified_covered_tasks:\n  - T-041\n  - T-042')
      .replace('latest_verdict:', 'latest_verdict: certified');
    const record = parseAuditRecord(forged);
    assert.equal(certificationStatus(record).current, false);
    assert.ok(
      certificationStatus(record).reasons.some(reason => reason.includes('no completed Auditor run'))
    );
  });

  it('binds certification to the exact artifact and task set in the last run', () => {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    const tamperedArtifact = certified.replace(
      'Audited artifact: commit:abc123',
      'Audited artifact: commit:other'
    );
    assert.equal(certificationStatus(parseAuditRecord(tamperedArtifact)).current, false);
    assert.ok(
      validateAuditRecord(tamperedArtifact, 'AUD-001.md')
        .some(error => error.includes('last audited artifact')),
      validateAuditRecord(tamperedArtifact, 'AUD-001.md').join('\n')
    );

    const tamperedTasks = certified.replace(
      'Covered tasks: T-041, T-042',
      'Covered tasks: T-041'
    );
    assert.equal(certificationStatus(parseAuditRecord(tamperedTasks)).current, false);
    assert.ok(
      validateAuditRecord(tamperedTasks, 'AUD-001.md')
        .some(error => error.includes('last audited covered-task set'))
    );
  });

  it('makes certification stale when the candidate artifact changes', () => {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    const refreshed = updateAuditBaseline(certified, {
      candidateArtifact: 'commit:def456',
      evidence: 'Integrated verification results for commit:def456.',
    });
    const record = parseAuditRecord(refreshed);
    assert.equal(record.certifiedArtifact, '');
    assert.equal(record.auditState, 'active');
    assert.equal(certificationStatus(record).current, false);
    assert.deepEqual(validateAuditRecord(refreshed, 'AUD-001.md'), []);
  });

  it('makes certification stale when a covered task is added or removed', () => {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;

    const added = parseAuditRecord(updateAuditBaseline(certified, { coveredTasks: ['T-041', 'T-042', 'T-055'] }));
    assert.equal(certificationStatus(added).current, false);

    const removed = parseAuditRecord(updateAuditBaseline(certified, { coveredTasks: ['T-041'] }));
    assert.equal(certificationStatus(removed).current, false);
  });

  it('treats a reordered but identical covered-task set as equivalent', () => {
    assert.ok(coveredTaskSetsEqual(['T-042', 'T-041'], ['T-041', 'T-042']));
    assert.deepEqual(normalizeCoveredTasks(['T-042', 'T-041', 'T-042']), ['T-041', 'T-042']);

    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    const reordered = parseAuditRecord(updateAuditBaseline(certified, { coveredTasks: ['T-042', 'T-041'] }));
    assert.equal(certificationStatus(reordered).current, true, 'reordering is not a boundary change');
  });

  it('keeps an unresolved blocking finding out of a current certification', () => {
    const withFinding = appendAuditReport(
      baseRecord(),
      report({ findings: [blockingFinding()] })
    ).content;
    const record = parseAuditRecord(withFinding);
    assert.deepEqual(openBlockingFindings(record).map(f => f.id), ['A-01']);
    assert.equal(certificationStatus(record).current, false);
  });
});

describe('fresh invocation provenance', () => {
  it('accepts host_subagent and explicit_agent_invocation', () => {
    for (const mode of ['host_subagent', 'explicit_agent_invocation']) {
      const result = appendAuditReport(baseRecord(), report({ invocationMode: mode }));
      assert.ok(result.ok, `${mode}: ${result.errors.join('; ')}`);
    }
  });

  it('rejects single_agent_fallback', () => {
    const result = appendAuditReport(baseRecord(), report({ invocationMode: 'single_agent_fallback' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('same-session fallback does not satisfy auditing')));
  });

  it('rejects a missing invocation reference', () => {
    const result = appendAuditReport(baseRecord(), report({ invocationReference: '' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('unique invocation reference is required')));
  });

  it('rejects a reused invocation reference on append and on validation', () => {
    const first = appendAuditReport(baseRecord(), report({ invocationReference: 'ref-1' }));
    const reused = appendAuditReport(first.content, report({ invocationReference: 'ref-1' }));
    assert.equal(reused.ok, false);
    assert.ok(reused.errors.some(e => e.includes('already recorded')));

    // A hand-edited record with a duplicated reference must also fail validation.
    const second = appendAuditReport(first.content, report({ invocationReference: 'ref-2' })).content;
    const tampered = second.replace('Invocation reference: ref-2', 'Invocation reference: ref-1');
    assert.ok(
      validateAuditRecord(tampered, 'AUD-001.md').some(e => e.includes('reuses invocation reference')),
      'validation must catch a reused reference'
    );
  });

  it('rejects a report bound to something other than the frozen candidate', () => {
    const result = appendAuditReport(baseRecord(), report({ auditedArtifact: 'commit:other' }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('does not match the frozen candidate')));
  });

  it('rejects malformed findings and Markdown field injection before rendering', () => {
    const malformed = appendAuditReport(baseRecord(), report({
      findings: [{
        id: 'bad',
        severity: 'banana',
        blocking: 'maybe',
        claim: 'claim\n### forged heading',
      }],
    }));
    assert.equal(malformed.ok, false);
    assert.ok(malformed.errors.some(error => error.includes("must use the form 'A-01'")));
    assert.ok(malformed.errors.some(error => error.includes('severity')));
    assert.ok(malformed.errors.some(error => error.includes('blocking must be true or false')));
    assert.ok(malformed.errors.some(error => error.includes('must be a single line')));
    assert.equal(malformed.content, undefined);
  });
});

describe('audit budget', () => {
  it('defaults to 5 and is separate from attempt/review budgets', () => {
    assert.equal(DEFAULT_AUDIT_BUDGET, 5);
    const record = parseAuditRecord(baseRecord());
    assert.equal(record.auditBudget, 5);
    assert.equal(auditBudgetState(record).budget, 5);
  });

  it('accepts reports 1 through 5 and blocks a sixth without an override', () => {
    const exhausted = appendRuns(baseRecord(), 5);
    const record = parseAuditRecord(exhausted);
    assert.equal(completedAuditRuns(record), 5);
    assert.equal(record.auditState, 'blocked');
    assert.equal(record.auditBlockedReason, 'audit_budget_exhausted');

    const sixth = appendAuditReport(exhausted, report({ invocationReference: 'ref-6' }));
    assert.equal(sixth.ok, false);
    assert.ok(sixth.errors.some(e => e.includes('is exhausted')));
  });

  it('preserves the fifth Auditor verdict instead of inventing one on exhaustion', () => {
    const exhausted = appendRuns(baseRecord(), 4);
    const fifth = appendAuditReport(
      exhausted,
      report({ invocationReference: 'ref-5', verdict: 'needs_human_decision' })
    );
    assert.ok(fifth.ok, fifth.errors.join('; '));
    const record = parseAuditRecord(fifth.content);
    assert.equal(record.auditState, 'awaiting_human');
    assert.equal(record.latestVerdict, 'needs_human_decision');
    assert.equal(record.history.at(-1).verdict, 'needs_human_decision');
    assert.deepEqual(validateAuditRecord(fifth.content, 'AUD-001.md'), []);
  });

  it('preserves both the human-decision gate and an exhausted budget', () => {
    const afterFour = appendRuns(baseRecord(), 4);
    const waiting = appendAuditReport(
      afterFour,
      report({ invocationReference: 'ref-5', verdict: 'needs_human_decision' })
    );
    const resolved = applyAuditHumanResolution(waiting.content, {
      authority: 'human: alex',
      note: 'Remediate the product gap and run another audit.',
    });
    assert.ok(resolved.ok, resolved.errors.join('; '));
    const record = parseAuditRecord(resolved.content);
    assert.equal(record.auditState, 'blocked');
    assert.equal(record.auditBlockedReason, 'audit_budget_exhausted');
    assert.equal(record.humanResolutionRef, 'human: alex');

    const stillBlocked = appendAuditReport(
      resolved.content,
      report({ invocationReference: 'ref-6', verdict: 'certified' })
    );
    assert.equal(stillBlocked.ok, false);
    assert.ok(stillBlocked.errors.some(error => error.includes('is exhausted')));
  });

  it('keeps a failed invocation that produced no report off the budget', () => {
    const afterOne = appendRuns(baseRecord(), 1);
    // A rejected append writes nothing, so history and budget are unchanged.
    const rejected = appendAuditReport(afterOne, report({ invocationMode: 'single_agent_fallback' }));
    assert.equal(rejected.ok, false);
    assert.equal(completedAuditRuns(parseAuditRecord(afterOne)), 1);
  });

  it('does not consume the budget for remediation or reset it on a new baseline', () => {
    const afterTwo = appendRuns(baseRecord(), 2);
    const rebaselined = updateAuditBaseline(afterTwo, {
      candidateArtifact: 'commit:def456',
      coveredTasks: ['T-041', 'T-042', 'T-055'],
      evidence: 'Integrated verification results for commit:def456.',
    });
    const record = parseAuditRecord(rebaselined);
    assert.equal(completedAuditRuns(record), 2, 'baseline replacement must not reset history');
    assert.equal(auditBudgetState(record).remaining, 3);
  });

  it('permits another report only after a recorded human-approved override', () => {
    const exhausted = appendRuns(baseRecord(), 5);

    const noAuthority = applyAuditBudgetOverride(exhausted, { budget: 7, authority: '' });
    assert.equal(noAuthority.ok, false);
    assert.ok(noAuthority.errors.some(e => e.includes('human authority reference')));

    const notHigher = applyAuditBudgetOverride(exhausted, { budget: 5, authority: 'human: alex' });
    assert.equal(notHigher.ok, false);

    const override = applyAuditBudgetOverride(exhausted, { budget: 7, authority: 'human: alex' });
    assert.ok(override.ok, override.errors.join('; '));
    const overridden = parseAuditRecord(override.content);
    assert.equal(overridden.auditBudget, 7);
    assert.equal(overridden.auditState, 'active');
    assert.match(override.content, /audit_budget raised to 7 by human: alex/);

    const sixth = appendAuditReport(override.content, report({ invocationReference: 'ref-6' }));
    assert.ok(sixth.ok, sixth.errors.join('; '));
    assert.equal(sixth.runNumber, 6);
  });

  it('flags a hand-edited record whose history exceeds its budget', () => {
    const exhausted = appendRuns(baseRecord(), 5).replace('audit_budget: 5', 'audit_budget: 3');
    const errors = validateAuditRecord(exhausted, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes('above audit_budget 3')), errors.join('\n'));
  });
});

describe('verdicts and accepted limitations', () => {
  it('refuses certified while a blocking finding is open', () => {
    const result = appendAuditReport(
      baseRecord(),
      report({ verdict: 'certified', findings: [blockingFinding()] })
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('requires no open blocking findings')));
  });

  it('allows certified alongside a non-blocking finding', () => {
    const result = appendAuditReport(
      baseRecord(),
      report({ verdict: 'certified', findings: [{ ...blockingFinding('A-02'), blocking: false, severity: 'low' }] })
    );
    assert.ok(result.ok, result.errors.join('; '));
    assert.equal(parseAuditRecord(result.content).auditState, 'certified');
  });

  it('requires an authority reference for every retained limitation', () => {
    const withoutAuthority = baseRecord({
      knownLimitations: '- Legacy import path stays unmigrated for one release.',
    });
    const rejected = appendAuditReport(
      withoutAuthority,
      report({ verdict: 'certified_with_accepted_limitations' })
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(e => e.includes('cannot accept it')));

    const withAuthority = baseRecord({
      knownLimitations: '- Legacy import path stays unmigrated for one release. Authority: D-2026-07-01-002',
    });
    const accepted = appendAuditReport(
      withAuthority,
      report({ verdict: 'certified_with_accepted_limitations' })
    );
    assert.ok(accepted.ok, accepted.errors.join('; '));
    assert.deepEqual(validateAuditRecord(accepted.content, 'AUD-001.md'), []);
  });

  it('rejects Auditor self-authorization and missing decision records', () => {
    const selfAuthorized = baseRecord({
      knownLimitations: '- Keep the gap. Authority: auditor:self',
    });
    const rejected = appendAuditReport(
      selfAuthorized,
      report({ verdict: 'certified_with_accepted_limitations' })
    );
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some(error => error.includes("human: <identity>")));

    const missingDecision = baseRecord({
      knownLimitations: '- Keep the gap. Authority: D-2026-07-24-001',
    });
    const decisionRejected = appendAuditReport(
      missingDecision,
      report({ verdict: 'certified_with_accepted_limitations' }),
      { decisionExists: () => false }
    );
    assert.equal(decisionRejected.ok, false);
    assert.ok(decisionRejected.errors.some(error => error.includes('non-accepted decision')));
  });

  it('routes an unaccepted new limitation through a human-decision verdict', () => {
    const result = appendAuditReport(
      baseRecord(),
      report({ verdict: 'needs_human_decision' })
    );
    assert.ok(result.ok, result.errors.join('; '));
    const record = parseAuditRecord(result.content);
    assert.equal(record.latestVerdict, 'needs_human_decision');
    assert.equal(record.auditState, 'awaiting_human');
    assert.equal(record.certifiedArtifact, '', 'a human-decision verdict certifies nothing');
  });

  it('requires a durable human resolution before another Auditor report', () => {
    const waiting = appendAuditReport(
      baseRecord(),
      report({ verdict: 'needs_human_decision', invocationReference: 'ref-human-1' })
    );
    assert.ok(waiting.ok, waiting.errors.join('; '));
    assert.equal(parseAuditRecord(waiting.content).auditState, 'awaiting_human');

    const premature = appendAuditReport(
      waiting.content,
      report({ verdict: 'certified', invocationReference: 'ref-human-2' })
    );
    assert.equal(premature.ok, false);
    assert.ok(premature.errors.some(error => error.includes('audit resolve')));

    const selfResolution = applyAuditHumanResolution(waiting.content, {
      authority: 'auditor:self',
      note: 'Accept the limitation.',
    });
    assert.equal(selfResolution.ok, false);

    const resolved = applyAuditHumanResolution(waiting.content, {
      authority: 'human: alex',
      note: 'Do not accept the limitation; remediate it and re-audit.',
    });
    assert.ok(resolved.ok, resolved.errors.join('; '));
    const resolvedRecord = parseAuditRecord(resolved.content);
    assert.equal(resolvedRecord.auditState, 'active');
    assert.equal(resolvedRecord.humanResolutionRef, 'human: alex');

    const fresh = appendAuditReport(
      resolved.content,
      report({ verdict: 'certified', invocationReference: 'ref-human-2' })
    );
    assert.ok(fresh.ok, fresh.errors.join('; '));
    assert.equal(parseAuditRecord(fresh.content).humanResolutionRef, '');
  });

  it('keeps a finding open until a fresh Auditor drops it', () => {
    const withFinding = appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content;
    assert.deepEqual(openBlockingFindings(parseAuditRecord(withFinding)).map(f => f.id), ['A-01']);

    // Maintainer counter-evidence recorded in the record body does not clear it.
    const counterEvidence = withFinding.replace(
      '## Remediation Tasks\n\nnone',
      '## Remediation Tasks\n\n- A-01 rejected with counter-evidence: src/a.js:10 is dead code.'
    );
    assert.deepEqual(openBlockingFindings(parseAuditRecord(counterEvidence)).map(f => f.id), ['A-01']);

    // Only a fresh Auditor report without the finding closes it.
    const cleared = appendAuditReport(
      counterEvidence,
      report({ invocationReference: 'ref-fresh', verdict: 'certified', findings: [] })
    );
    assert.ok(cleared.ok, cleared.errors.join('; '));
    assert.deepEqual(openBlockingFindings(parseAuditRecord(cleared.content)), []);
  });

  it('validates the required finding fields', () => {
    const content = appendAuditReport(
      baseRecord(),
      report({ findings: [blockingFinding()] })
    ).content.replace('- Required outcome: One source of truth for the setting.\n', '');
    const errors = validateAuditRecord(content, 'AUD-001.md');
    assert.ok(errors.some(e => e.includes("is missing 'Required outcome'")), errors.join('\n'));
  });
});

describe('closeout gate', () => {
  function seedCertified(target) {
    const certified = appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content;
    writeAudit(target, 'AUD-001', certified);
    return certified;
  }

  it('blocks completion when audit is enabled and no record exists', () => {
    const target = makeTarget('gate-missing');
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled' });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_missing');
    assert.equal(gate.optOut, false);
  });

  it('blocks completion when the key is omitted, because the default is enabled', () => {
    const target = makeTarget('gate-default');
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4' });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_missing');
  });

  it('permits completion with a current certificate', () => {
    const target = makeTarget('gate-certified');
    seedCertified(target);
    const gate = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      taskStatus: () => 'accepted',
    });
    assert.equal(gate.allowed, true, gate.reasons.join('; '));
    assert.equal(gate.state, 'certified');
    assert.equal(gate.auditId, 'AUD-001');
  });

  it('fails closed when a structurally invalid record claims certification', () => {
    const target = makeTarget('invalid-claimed-certificate');
    const forged = baseRecord()
      .replace('audit_state: active', 'audit_state: certified')
      .replace('certified_artifact:', 'certified_artifact: commit:abc123')
      .replace('certified_covered_tasks: []', 'certified_covered_tasks:\n  - T-041\n  - T-042')
      .replace('latest_verdict:', 'latest_verdict: certified');
    writeAudit(target, 'AUD-001', forged);
    const result = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      taskStatus: () => 'accepted',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.state, 'audit_invalid');
    assert.ok(result.reasons.some(reason => reason.includes('no completed audit run')));
  });

  it('fails closed when more than one record claims the same work unit', () => {
    const target = makeTarget('duplicate-gate-records');
    writeAudit(
      target,
      'AUD-001',
      appendAuditReport(baseRecord(), report({ verdict: 'certified' })).content
    );
    writeAudit(
      target,
      'AUD-002',
      appendAuditReport(
        baseRecord({ auditId: 'AUD-002' }),
        report({ verdict: 'certified', invocationReference: 'ref-duplicate' })
      ).content
    );
    const result = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      taskStatus: () => 'accepted',
    });
    assert.equal(result.allowed, false);
    assert.equal(result.state, 'audit_invalid');
    assert.ok(result.reasons.some(reason => reason.includes('exactly one is required')));
  });

  it('blocks completion when the certificate went stale', () => {
    const target = makeTarget('gate-stale');
    const certified = seedCertified(target);
    writeAudit(target, 'AUD-001', updateAuditBaseline(certified, {
      candidateArtifact: 'commit:def456',
      evidence: 'Integrated verification results for commit:def456.',
    }));

    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled' });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_not_current');
  });

  it('blocks completion while a blocking finding is unresolved', () => {
    const target = makeTarget('gate-finding');
    writeAudit(target, 'AUD-001', appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content);
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled' });
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some(r => r.includes('unresolved blocking findings')), gate.reasons.join('; '));
  });

  it('blocks completion when a covered task was reopened', () => {
    const target = makeTarget('gate-reopened');
    seedCertified(target);
    const gate = evaluateAuditCloseoutGate(target, {
      workUnit: 'phase:4',
      workUnitAudit: 'enabled',
      taskStatus: taskId => (taskId === 'T-042' ? 'in-progress' : 'accepted'),
    });
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some(r => r.includes("covered task T-042 is 'in-progress'")), gate.reasons.join('; '));
  });

  it('reports a blocked audit rather than allowing completion', () => {
    const target = makeTarget('gate-blocked');
    writeAudit(target, 'AUD-001', appendRuns(baseRecord(), 5));
    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled' });
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, 'audit_blocked');
  });

  it('bypasses the gate when explicitly disabled without claiming certification', () => {
    const target = makeTarget('gate-disabled');
    writeAudit(target, 'AUD-001', appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content);

    const gate = evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'disabled' });
    assert.equal(gate.allowed, true);
    assert.equal(gate.state, 'audit_disabled');
    assert.equal(gate.optOut, true, 'the opt-out must stay visible in closeout evidence');
    assert.notEqual(gate.state, 'certified', 'opting out never certifies the work unit');

    // History is preserved for a later re-enable.
    assert.equal(completedAuditRuns(findAuditRecord(target, 'phase:4').record), 1);
  });

  it('restores the gate when audit is re-enabled', () => {
    const target = makeTarget('gate-reenabled');
    writeAudit(target, 'AUD-001', appendAuditReport(baseRecord(), report({ findings: [blockingFinding()] })).content);
    assert.equal(evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'disabled' }).allowed, true);
    assert.equal(evaluateAuditCloseoutGate(target, { workUnit: 'phase:4', workUnitAudit: 'enabled' }).allowed, false);
  });
});

describe('audit id allocation', () => {
  it('allocates stable zero-padded ids', () => {
    assert.equal(nextAuditId([]), 'AUD-001');
    assert.equal(nextAuditId(['AUD-001']), 'AUD-002');
    assert.equal(nextAuditId(['AUD-001', 'AUD-010']), 'AUD-011');
    assert.equal(nextAuditId(['not-an-audit']), 'AUD-001');
  });
});
