import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyGitHubTaskBody, taskBodyDigest } from '../src/github-task-body.js';
import { validateTaskMutationReceipt } from '../src/task-evidence-contract.js';
import { appendAuditReport, createAuditRecordContent, parseAuditRecord, updateAuditBaseline } from '../src/audit-record.js';
import { deriveAuditDueWorkUnits } from '../src/closeout.js';
import { resolveCanonicalTerminalScope } from '../src/terminal-scope.js';
import { init } from '../src/init.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'agenticloop-task-mutation-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

function target(name) {
  const root = mkdtempSync(join(temp, `${name}-`));
  mkdirSync(join(root, '.agenticloop', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.agenticloop', 'audits'), { recursive: true });
  return root;
}

function writeTask(root, id, grouping, status = 'accepted', directory = join(root, '.agenticloop', 'tasks')) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.md`), [
    '---', `task_id: ${id}`, `status: ${status}`, 'backend: files', '---', '',
    '# task', '', '## Grouping', grouping, '', '## Comments', '',
  ].join('\n'), 'utf8');
}

function githubBody(title = 'Draft') {
  return [
    '---', 'task_id: T-701', 'task_contract_schema: 2', 'status: draft', 'backend: github',
    'attempt_budget: 5', 'review_budget: 5', 'allowed_paths:', '  - src/**',
    'intended_creations:', '  - src/new.js', '---', '', `# ${title}`, '',
    '## Task', 'Guarded publication.', '', '## Source Documents Reviewed', '- README.md', '',
    '## Current State', 'Draft.', '', '## Scope', 'One field.', '', '## Out of Scope', 'Everything else.', '',
    '## Acceptance Criteria', '- valid', '', '## Required Checks', '- npm test', '',
    '## Expected Files or Areas', '- src/', '', '## Implementation Notes', 'none', '',
    '## Completion Summary Template', 'none', '', '## Reviewer Checklist', '- [ ] review', '',
    '[[agent: maintainer]]',
  ].join('\n');
}

function runner(state) {
  return (_command, args) => {
    if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
    if (args[0] === 'api') return { status: 0, stdout: JSON.stringify([[]]) };
    if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 71, body: state.body }) };
    if (args[0] === 'issue' && args[1] === 'edit') {
      state.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      state.writes += 1;
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: `unexpected ${args.join(' ')}` };
  };
}

describe('guarded task mutation foundations', () => {
  it('uses the terminal contract for configured, explicit, indeterminate, and no scope evidence', () => {
    const root = target('scope');
    writeTask(root, 'T-701', 'phase:35');
    writeTask(root, 'T-702', 'phase:35');

    const grouped = resolveCanonicalTerminalScope({
      target: root,
      taskId: 'T-701',
      config: { grouping_profile: 'phase', group_closeout: true, work_unit_audit: 'disabled' },
    });
    assert.equal(grouped.scopeKind, 'configured_group');
    assert.equal(grouped.decision.genericTerminalAllowed, false);
    assert.deepEqual(grouped.tasks, ['T-701', 'T-702']);

    const unknownMembership = resolveCanonicalTerminalScope({
      target: root,
      taskId: 'T-701',
      config: { grouping_profile: 'phase', group_closeout: true, work_unit_audit: 'enabled' },
      inventoryComplete: false,
    });
    assert.equal(unknownMembership.scopeKind, 'indeterminate');
    assert.equal(unknownMembership.decision.disposition, 'blocked');

    const none = resolveCanonicalTerminalScope({
      target: root,
      taskId: 'T-701',
      config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: 'enabled' },
    });
    assert.equal(none.scopeKind, 'none');
    assert.equal(none.decision.genericTerminalAllowed, true);

    const record = createAuditRecordContent({
      auditId: 'AUD-701', workUnit: 'work-unit:manual', coveredTasks: ['T-701'],
      candidateArtifact: 'commit:abc123', goal: 'one task', completionOracle: 'one outcome', evidence: 'current evidence',
    });
    writeFileSync(join(root, '.agenticloop', 'audits', 'AUD-701.md'), record, 'utf8');
    const explicit = resolveCanonicalTerminalScope({
      target: root,
      taskId: 'T-701',
      config: { grouping_profile: 'phase', group_closeout: false, work_unit_audit: 'disabled' },
    });
    assert.equal(explicit.scopeKind, 'explicit_task_set');
    assert.equal(explicit.decision.genericTerminalAllowed, false);
  });

  it('derives audit-due work only from configured group-closeout scope', () => {
    const root = target('audit-due');
    writeTask(root, 'T-701', 'phase:35');
    const disabledOwnership = deriveAuditDueWorkUnits(root, {
      task_backend: 'files', grouping_profile: 'phase', group_closeout: false, work_unit_audit: 'enabled',
    });
    assert.deepEqual(disabledOwnership, []);
    const configured = deriveAuditDueWorkUnits(root, {
      task_backend: 'files', grouping_profile: 'phase', group_closeout: true, work_unit_audit: 'enabled',
    });
    assert.deepEqual(configured, [{ workUnit: 'phase:35', tasks: ['T-701'], state: 'audit_due' }]);
  });

  it('uses the configured files task template for terminal scope and audit-due evidence', () => {
    const root = target('custom-template');
    const records = join(root, 'workflow', 'records');
    const config = {
      task_backend: 'files', task_file_template: 'workflow/records/{taskId}.md',
      grouping_profile: 'phase', group_closeout: true, work_unit_audit: 'enabled',
    };
    writeTask(root, 'T-701', 'phase:35', 'accepted', records);
    writeTask(root, 'T-702', 'phase:35', 'accepted', records);

    const scope = resolveCanonicalTerminalScope({ target: root, taskId: 'T-701', config });
    assert.equal(scope.scopeKind, 'configured_group');
    assert.deepEqual(scope.tasks, ['T-701', 'T-702']);
    assert.deepEqual(deriveAuditDueWorkUnits(root, config), [
      { workUnit: 'phase:35', tasks: ['T-701', 'T-702'], state: 'audit_due' },
    ]);
  });

  it('keeps unknown audit sections byte-for-byte by refusing a semantic rewrite', () => {
    const original = createAuditRecordContent({
      auditId: 'AUD-702', workUnit: 'work-unit:manual', coveredTasks: ['T-701'],
      candidateArtifact: 'commit:abc123', goal: 'one task', completionOracle: 'one outcome', evidence: 'current evidence',
    }).replace('## Comments', '## Field Notes\n\nDo not rewrite this.\n\n## Comments');
    assert.throws(
      () => updateAuditBaseline(original, { candidateArtifact: 'commit:def456', evidence: 'new evidence' }),
      /unrecognized live section/,
    );
    assert.match(original, /Do not rewrite this\./);
  });

  it('records audit-budget consumption cause and refuses unavailable product-invalidation recovery', () => {
    const record = createAuditRecordContent({
      auditId: 'AUD-703', workUnit: 'work-unit:manual', coveredTasks: ['T-701'],
      candidateArtifact: 'commit:abc123', goal: 'one task', completionOracle: 'one outcome', evidence: 'current evidence',
    });
    const common = {
      verdict: 'needs_remediation', invocationMode: 'host_subagent', invocationReference: 'guarded-mutation-audit-run',
      auditedArtifact: 'commit:abc123', coveredTasks: ['T-701'], assessment: 'assessment', evidenceChecked: 'npm test', findings: [],
    };
    const accepted = appendAuditReport(record, common);
    assert.equal(accepted.ok, true, accepted.errors.join('\n'));
    assert.equal(parseAuditRecord(accepted.content).history[0].consumptionCause, 'substantive_audit');
    const unsupported = appendAuditReport(record, { ...common, consumptionCause: 'product_invalidation_recovery' });
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.errors.join('\n'), /not operational/);
  });

  it('emits a receipt and resumes a receipt-proven prior write without another write', () => {
    const root = target('github-receipt');
    const recoveryDir = join(root, '.agenticloop', 'tmp');
    const state = { body: githubBody(), writes: 0 };
    const candidate = githubBody('Published');
    const first = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(state.body), yes: true,
      commandRunner: runner(state), recoveryDir,
    });
    assert.equal(first.ok, true);
    assert.equal(first.receipt.mutationDisposition, 'committed');
    assert.equal(first.publicationProvenance, 'published');
    assert.equal(first.receipt.expectedDigest, taskBodyDigest(githubBody()));
    assert.equal(first.receipt.resultingDigest, taskBodyDigest(candidate));
    assert.equal(validateTaskMutationReceipt(first.receipt).ok, true);

    // The retained recovery artifact attributes the current body to our own
    // operation from the exact expected predecessor, so this is a proven resume.
    const resumed = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(githubBody()), yes: true,
      commandRunner: runner(state), recoveryDir,
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.publicationProvenance, 'receipt_proven_prior_write');
    assert.equal(resumed.receipt.mutationDisposition, 'already_current');
    assert.equal(state.writes, 1);
  });

  it('refuses to present an unattributed matching body as proven publication', () => {
    const root = target('github-unattributed');
    const candidate = githubBody('Published');
    // The remote already equals the candidate, but no retained receipt links
    // that write to us and the expected predecessor does not match it.
    const state = { body: candidate, writes: 0 };
    const result = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(githubBody()), yes: true,
      commandRunner: runner(state), recoveryDir: join(root, '.agenticloop', 'tmp'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.nonAuthoritative, true);
    assert.equal(result.publicationProvenance, 'unattributed_matching_write');
    assert.equal(result.receipt, undefined);
    assert.equal(state.writes, 0);
    assert.match(result.errors.join('\n'), /no retained operation receipt attributes that write/);
  });

  it('reports a genuinely current no-op when expected, candidate, and current agree', () => {
    const root = target('github-noop');
    const candidate = githubBody();
    const state = { body: candidate, writes: 0 };
    const result = applyGitHubTaskBody({
      issue: 71, body: candidate, expectDigest: taskBodyDigest(candidate), yes: true,
      commandRunner: runner(state), recoveryDir: join(root, '.agenticloop', 'tmp'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.publicationProvenance, 'current_no_op');
    assert.equal(result.receipt.mutationDisposition, 'already_current');
    assert.equal(state.writes, 0);
  });

  it('separates filesystem transaction completion from Git commit status', async () => {
    const root = target('init-receipt');
    const result = await init({ target: root, agentsGuidance: false });
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
    const receipt = result.mutationReceipt;
    // The transaction applied, but this fixture is not a Git work tree, so the
    // receipt must report the commit state as unverifiable, not committed.
    assert.equal(receipt.transactionDisposition, 'applied');
    assert.equal(receipt.commitDisposition, 'unverifiable');
    assert.equal(receipt.gitAvailable, false);
    assert.equal(receipt.unresolved, true);
    assert.ok(receipt.changedPaths.length > 0);
    assert.ok(receipt.changedPaths.every(item => item.path && ['unverifiable', 'directory'].includes(item.git)));
    assert.match(receipt.nextAction, /Resolve the reported prior-gate state/);
  });
});
