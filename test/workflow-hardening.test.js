import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter, parseFrontmatterStrict } from '../src/frontmatter.js';
import { buildGitHubTaskIdentityInventory, resolveCoveredGitHubTask, resolveGitHubTaskIdentityStrict } from '../src/github-task-identity.js';
import { evaluateTaskReadiness } from '../src/task-readiness.js';
import { evaluateCommitAttribution, validateAttributionRepairRecord } from '../src/commit-attribution.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { REPAIR_POLICY, repairPolicyFor } from '../src/repair-policy.js';
import { presentDiagnostic } from '../src/diagnostic-presentation.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';
import { DIAGNOSTIC_OWNERS, EVENT_ROLES, eventRoleToDiagnosticOwner } from '../src/workflow-vocabulary.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const VALID_BODY = [
  '---',
  'task_id: T-101',
  'allowed_paths:',
  '  - src/**',
  'intended_creations:',
  '  - src/new.js',
  '---',
  '',
  '# T-101 - Hardening',
  '',
  '## Scope',
  'Keep task records structurally valid.',
  '',
  '## Out of Scope',
  'Do not change unrelated behavior.',
  '',
  '## Acceptance Criteria',
  '- Strict parsing works.',
  '',
  '## Required Checks',
  '- `npm test`',
].join('\n');

describe('strict frontmatter regression coverage', () => {
  it('accepts valid LF and CRLF frontmatter', () => {
    const lf = parseFrontmatterStrict(VALID_BODY);
    const crlf = parseFrontmatterStrict(VALID_BODY.replaceAll('\n', '\r\n'));

    assert.equal(lf.state, 'valid');
    assert.equal(crlf.state, 'valid');
    assert.equal(lf.data.task_id, 'T-101');
    assert.equal(crlf.data.task_id, 'T-101');
  });

  it('normalizes exactly one leading UTF-8 BOM without silently dropping frontmatter', () => {
    const result = parseFrontmatterStrict(`\uFEFF${VALID_BODY}`);
    assert.equal(result.state, 'valid');
    assert.equal(result.data.task_id, 'T-101');
    assert.match(result.body, /^# T-101/m);
  });

  it('fails closed for an opener without a multiline closing delimiter', () => {
    const result = parseFrontmatterStrict('---\ntask_id: T-101\n# body without delimiter');
    assert.equal(result.state, 'malformed');
    assert.equal(result.reason, 'missing_closing_delimiter');
  });

  it('fails closed when formerly multiline frontmatter and headings collapse onto one line', () => {
    const result = parseFrontmatterStrict('--- task_id: T-101 --- # T-101 ## Scope');
    assert.equal(result.state, 'malformed');
    assert.equal(result.reason, 'invalid_opening_delimiter');
  });

  it('keeps the legacy parser permissive while strict parsing rejects malformed contract input', () => {
    const legacyInput = '---\ntask_id: T-101\nthis is tolerated by legacy callers\n---\n# body';
    const [legacy] = parseFrontmatter(legacyInput);
    const strict = parseFrontmatterStrict(legacyInput);
    assert.equal(legacy.task_id, 'T-101');
    assert.equal(strict.state, 'malformed');
    assert.match(strict.reason, /invalid_yaml_line/);
  });
});

describe('GitHub identity is strict about frontmatter state', () => {
  it('uses non-empty materialized task_id', () => {
    const result = resolveGitHubTaskIdentityStrict({ number: 31, body: VALID_BODY });
    assert.deepEqual(result, { ok: true, identity: { taskId: 'T-101', source: 'frontmatter' }, diagnostic: null });
  });

  it('permits the legacy issue-number identity only with genuinely absent frontmatter', () => {
    const result = resolveGitHubTaskIdentityStrict({ number: 31, body: '# Legacy task' });
    assert.deepEqual(result, { ok: true, identity: { taskId: '#31', source: 'issue-number' }, diagnostic: null });
  });

  it('does not hide malformed or BOM-corrupted frontmatter behind issue-number fallback', () => {
    for (const body of ['---\ntask_id: T-101', '﻿--- task_id: T-101 ---']) {
      const result = resolveGitHubTaskIdentityStrict({ number: 31, body });
      assert.equal(result.ok, false);
      assert.equal(result.identity, null);
      assert.equal(result.diagnostic.category, 'task_contract');
      assert.equal(result.diagnostic.repairKind, 'repair_task_identity');
      assert.equal('owner' in result.diagnostic, false, 'evaluator facts never carry role routing');
    }
  });

  it('keeps malformed issue bodies out of the legacy inventory namespace', () => {
    const inventory = buildGitHubTaskIdentityInventory([{ number: 31, state: 'OPEN', body: '---\ntask_id: T-101' }]);
    assert.equal(inventory.state, 'identity_conflict');
    assert.ok(inventory.diagnostics.some(diagnostic => diagnostic.category === 'task_contract'));
    assert.equal(resolveCoveredGitHubTask(inventory, '#31').found, false);
  });
});

describe('path intent and prospective commit attribution', () => {
  it('rejects duplicate allowed_paths and creations not covered by allowed_paths', () => {
    const duplicate = evaluateTaskReadiness({
      taskBody: VALID_BODY.replace('  - src/new.js', '  - src/new.js\n  - src/new.js').replace('  - src/**', '  - src/**\n  - src/**'),
      basePaths: ['src/existing.js'],
      mode: 'authoring',
    });
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.diagnostics.every(item => item.code === 'scope.declaration.duplicate'));
    assert.deepEqual(duplicate.diagnostics.map(item => item.evidence.field).sort(), ['allowed_paths', 'intended_creations']);

    const uncovered = evaluateTaskReadiness({
      taskBody: VALID_BODY.replace('  - src/new.js', '  - docs/new.md'),
      basePaths: ['src/existing.js'],
      mode: 'authoring',
    });
    assert.equal(uncovered.ok, false);
    assert.ok(uncovered.diagnostics.some(item => item.code === 'scope.intended_creation.uncovered' && item.evidence.paths.includes('docs/new.md')));
  });

  it('emits stable scope-deviation facts without a protocol-state directive', () => {
    const result = evaluateTaskReadiness({
      taskBody: VALID_BODY,
      basePaths: ['src/existing.js'],
      changedPaths: ['docs/incident.md'],
      mode: 'review',
    });
    const diagnostic = result.diagnostics.find(item => item.category === 'scope_deviations');
    assert.equal(diagnostic.code, 'scope.deviation.missing');
    assert.equal(diagnostic.repairKind, 'declare_exact_deviation');
    assert.equal(diagnostic.escalationKind, 'contract_reconciliation');
    assert.deepEqual(diagnostic.evidence.paths, ['docs/incident.md']);
    assert.equal('owner' in diagnostic, false, 'evaluator facts never carry role routing');
    // The presentation layer derives routing from capability bindings.
    const presented = presentDiagnostic(diagnostic, getProjectRoleCapabilities(REPO_ROOT));
    assert.equal(presented.owner, 'engineer');
    assert.equal(presented.escalationOwner, 'maintainer');
    assert.doesNotMatch(presented.nextAction, /needs_context|delegate|dispatch/i);
  });

  it('gives every emitted diagnostic a policy and renderable description', () => {
    const result = evaluateTaskReadiness({
      taskBody: VALID_BODY.replace('  - src/new.js', '  - docs/new.md'),
      basePaths: ['src/existing.js'],
      changedPaths: ['docs/incident.md'],
      mode: 'review',
      dependencies: { 'T-999': 'blocked' },
    });
    for (const diagnostic of result.diagnostics) {
      const policy = repairPolicyFor(diagnostic.code);
      assert.equal(diagnostic.repairKind, policy.repairKind);
      assert.ok(policy.description);
    }
    assert.ok(Object.keys(REPAIR_POLICY).length > 0);
  });

  it('accepts a message-file candidate with one final contiguous Task/Agent block', () => {
    const result = evaluateCommitAttribution({
      taskId: 'T-101',
      message: 'feat: harden contract parsing\n\nTask: T-101\nAgent: engineer\n',
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects Task and Agent trailers separated into paragraphs before a commit exists', () => {
    const result = evaluateCommitAttribution({
      taskId: 'T-101',
      message: 'feat: harden contract parsing\n\nTask: T-101\n\nAgent: engineer\n',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /misplaced Task\/Agent trailer|missing Task trailer/);
  });
});

describe('github-preflight human diagnostics', () => {
  it('renders category, owner, next action, and first safe repair from structured diagnostics', async () => {
    const head = 'a'.repeat(40);
    const issueBody = [
      '---', 'task_id: T-101', 'allowed_paths:', '  - src/**', '---', '',
      '## Scope', 'Keep the change scoped.', '',
      '## Out of Scope', 'Do not change documentation.', '',
      '## Acceptance Criteria', '- Scope is checked.', '',
      '## Required Checks', '- `npm test`',
    ].join('\n');
    const prBody = [
      '## Scope Completed', 'Implemented.', '',
      '## Artifacts', `commit:${head}`, '',
      '## Evidence', `Current PR head: ${head}`, '- Required check: `npm test`', '  Verdict: passed', '  Evidence: passed.', '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
    ].join('\n');
    const runner = (_command, args) => {
      if (args[0] === 'pr' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 42, body: prBody, headRefOid: head, baseRefOid: 'b'.repeat(40), files: [{ path: 'docs/incident.md' }], closingIssuesReferences: [{ number: 31 }], statusCheckRollup: [], commits: [] }) };
      if (args[0] === 'issue' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 31, body: issueBody }) };
      if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop-bot', type: 'User' }) };
      if (args[0] === 'api' && String(args[1]).includes('/git/trees/')) return { status: 0, stdout: JSON.stringify({ truncated: false, tree: [{ type: 'blob', path: 'src/existing.js' }] }) };
      if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[]]) };
      return { status: 1, stderr: `unexpected gh call: ${args.join(' ')}` };
    };
    const result = await runCliInProcess(['github-preflight', '--pr', '42'], { ghCommandRunner: runner });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ERROR \[scope_deviations\]/);
    assert.match(result.stderr, /owner: engineer/);
    assert.match(result.stderr, /next action: Repair: declare_exact_deviation/);
    assert.match(result.stdout, /first safe repair: Repair: declare_exact_deviation/);
  });
});

describe('already-pushed attribution repair record', () => {
  it('requires durable rewrite provenance without confusing content ownership and operator', () => {
    const result = validateAttributionRepairRecord({
      kind: 'agenticloop.attribution-repair',
      originalSha: 'a'.repeat(40),
      resultingSha: 'b'.repeat(40),
      branchRef: 'refs/heads/task/T-101',
      contentOwnerRole: 'engineer',
      repairOperator: 'release-maintainer',
      reason: 'Repair malformed final trailer.',
      authority: 'maintainer: T-101 repair authorization',
      timestamp: '2026-01-02T03:04:05.000Z',
      invalidatedEvidence: ['preflight:a'],
      rerunEvidence: ['preflight:b'],
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

describe('workflow vocabulary', () => {
  it('keeps diagnostic owners and event roles distinct', () => {
    assert.ok(DIAGNOSTIC_OWNERS.includes('human_authority'));
    assert.equal(EVENT_ROLES.includes('human_authority'), false);
    assert.ok(EVENT_ROLES.includes('human'));
    assert.equal(eventRoleToDiagnosticOwner('human'), 'human_authority');
    assert.equal(eventRoleToDiagnosticOwner('unknown'), null);
  });
});
