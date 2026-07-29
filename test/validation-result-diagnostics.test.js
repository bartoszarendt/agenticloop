import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDiagnostic, REPAIR_POLICY } from '../src/repair-policy.js';
import {
  createValidationResult,
  consolidateDiagnostics,
  serializeValidationResult,
  suppressDependentDiagnostics,
  validateRequiredFieldInventory,
  validateValidationResult,
  validationResultDigest,
  VALIDATION_RESULT_REQUIRED_FIELDS,
} from '../src/result-envelope.js';
import { lintGitHubTaskBody } from '../src/github-task-body.js';
import { evaluateTaskRecordRoot } from '../src/task-record-root.js';
import { evaluatePreflight } from '../src/github-preflight.js';
import { evaluateTaskReadiness } from '../src/task-readiness.js';
import { validationResultForGate } from '../src/public-result.js';
import { presentDiagnostic } from '../src/diagnostic-presentation.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';
import { validateTaskRecord, validateTaskRecordDiagnostics } from '../src/validate-config.js';
import {
  appendAuditReport,
  applyAuditBudgetOverride,
  applyAuditDisposition,
  applyAuditHumanResolution,
  canonicalizeAuditRecord,
  createAuditRecordContent,
  parseAuditRecord,
  updateAuditBaseline,
  validateAuditRecord,
} from '../src/audit-record.js';
import { runCliInProcess } from './helpers/run-cli.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

function validGitHubTaskBody({ prefix = '', prose = '' } = {}) {
  return [
    prefix + '---',
    'task_id: T-101',
    'status: draft',
    'backend: github',
    'attempt_budget: 5',
    'review_budget: 5',
    'allowed_paths:',
    '  - src/**',
    'intended_creations:',
    '  - src/new.js',
    '---',
    '',
    '# T-101 - Draft task',
    '',
    '## Task', `Implement the guarded task body operation. ${prose}`,
    '',
    '## Source Documents Reviewed', '- `README.md`',
    '',
    '## Current State', 'Task body updates were unguarded.',
    '',
    '## Scope', 'Guard task body updates.',
    '',
    '## Out of Scope', 'Do not update pull request bodies.',
    '',
    '## Acceptance Criteria', '- The body is validated before publication.',
    '',
    '## Required Checks', '- `npm test`',
    '',
    '## Expected Files or Areas', '- src/',
    '',
    '## Implementation Notes', 'Keep the operation transactional.',
    '',
    '## Completion Summary Template', 'Summarize the result.',
    '',
    '## Reviewer Checklist', '- [ ] Validate the candidate.',
    '',
    '[[agent: maintainer]]',
  ].join('\n');
}

function auditRecord() {
  return createAuditRecordContent({
    auditId: 'AUD-001', workUnit: 'phase:35', coveredTasks: ['T-001'], candidateArtifact: `commit:${'a'.repeat(40)}`,
    goal: 'Goal.', completionOracle: 'Oracle.', evidence: 'Evidence.',
  });
}

function result(diagnostics) {
  return createValidationResult({
    command: 'task-body lint',
    evidenceState: 'malformed',
    disposition: 'rejected',
    diagnostics,
    firstSafeRepair: 'repair once',
    debugReference: 'debug:sha256:' + 'a'.repeat(64),
  });
}

describe('canonical validation-result envelopes', () => {
  it('serializes and digests equivalent permutations identically', () => {
    const first = result([
      createDiagnostic({ code: 'evidence.malformed', evidence: { b: 2, a: 1 } }),
      createDiagnostic({ code: 'state.host_local', evidence: { paths: ['b', 'a'] } }),
    ]);
    const second = result([
      createDiagnostic({ code: 'state.host_local', evidence: { paths: ['b', 'a'] } }),
      createDiagnostic({ code: 'evidence.malformed', evidence: { a: 1, b: 2 } }),
    ]);
    assert.equal(serializeValidationResult(first), serializeValidationResult(second));
    assert.equal(validationResultDigest(first), validationResultDigest(second));
    assert.equal(validateRequiredFieldInventory([...VALIDATION_RESULT_REQUIRED_FIELDS].reverse()).ok, true);
  });

  it('derives the same public evidence state from every permutation of a diagnostic set', () => {
    const missing = createDiagnostic({ code: 'evidence.missing', evidence: { state: 'missing' } });
    const changed = createDiagnostic({ code: 'evidence.changed', evidence: { state: 'changed' } });
    const first = validationResultForGate('verify', { diagnostics: [missing, changed] });
    const second = validationResultForGate('verify', { diagnostics: [changed, missing] });
    assert.equal(first.evidenceState, 'missing');
    assert.equal(first.disposition, 'needs_context');
    assert.equal(serializeValidationResult(first), serializeValidationResult(second));
    assert.equal(validationResultDigest(first), validationResultDigest(second));
  });

  it('uses exact UTF-16 code-unit ordering when locale collation compares distinct diagnostics equally', () => {
    const a = createDiagnostic({ code: 'evidence.malformed', message: 'a' });
    const zeroWidth = createDiagnostic({ code: 'evidence.malformed', message: 'a\u200B' });
    const first = result([a, zeroWidth]);
    const second = result([zeroWidth, a]);
    assert.equal(serializeValidationResult(first), serializeValidationResult(second));
    assert.equal(validationResultDigest(first), validationResultDigest(second));

    const umlaut = createDiagnostic({ code: 'evidence.malformed', message: 'ä' });
    const z = createDiagnostic({ code: 'evidence.malformed', message: 'z' });
    const serialized = serializeValidationResult(result([umlaut, z]));
    assert.ok(serialized.indexOf('"message":"z"') < serialized.indexOf('"message":"ä"'));
  });

  it('rejects protected and non-canonical constructor inputs rather than minting an authority-bearing result', () => {
    const protectedInputs = [
      { kind: 'evil' },
      { schemaVersion: 99 },
      { rollbackAuthorized: true },
      { ok: 'yes' },
      { errors: [new Error('not text')] },
      { warnings: [42] },
      { diagnostics: [null] },
      { warningDiagnostics: ['not a diagnostic'] },
      { failureCategories: [Symbol('category')] },
      { firstSafeRepair: () => {} },
      { debugReference: Infinity },
      { diagnostics: {} },
      { diagnostics: 'not an array' },
      { warningDiagnostics: {} },
    ];
    for (const input of protectedInputs) {
      assert.throws(() => createValidationResult({ command: 'verify', ...input }));
    }
  });

  it('rejects forged diagnostic policy and routing fields', () => {
    const diagnostic = createDiagnostic({ code: 'evidence.malformed' });
    for (const forged of [
      { ...diagnostic, category: 'usage' },
      { ...diagnostic, repairKind: 'authorize_rollback' },
      { ...diagnostic, escalationKind: 'human_authority_review' },
      {
        ...diagnostic,
        owner: 'orchestrator',
        escalationOwner: null,
        firstSafeRepair: diagnostic.repairKind,
        nextAction: `Repair: ${diagnostic.repairKind}. Owner: orchestrator.`,
      },
    ]) {
      assert.throws(
        () => createValidationResult({
          command: 'verify',
          diagnostics: [forged],
          evidenceState: 'malformed',
          disposition: 'rejected',
        }),
        /diagnostic/
      );
    }
  });

  it('validates routing against the capabilities that presented the diagnostic', () => {
    const fact = createDiagnostic({
      code: 'evidence.malformed',
      repairHint: 'Repair the selected target evidence.',
    });
    const capabilities = {
      primaryOwnerByRepairKind: { [fact.repairKind]: 'maintainer' },
      escalationOwnerByKind: { [fact.escalationKind]: null },
    };
    const diagnostic = presentDiagnostic(fact, capabilities);
    const envelope = createValidationResult({
      command: 'verify',
      diagnostics: [diagnostic],
      evidenceState: 'malformed',
      disposition: 'rejected',
    });
    assert.equal(envelope.diagnostics[0].owner, 'maintainer');
    assert.doesNotThrow(() => serializeValidationResult(envelope));

    const parsed = JSON.parse(JSON.stringify(envelope));
    assert.throws(
      () => serializeValidationResult(parsed),
      /routing capabilities are required/
    );
    assert.doesNotThrow(
      () => serializeValidationResult(parsed, { capabilities })
    );
  });

  it('rejects diagnostics presented for different targets in one envelope', () => {
    const fact = createDiagnostic({ code: 'evidence.malformed' });
    const engineerCapabilities = {
      primaryOwnerByRepairKind: { [fact.repairKind]: 'engineer' },
      escalationOwnerByKind: { [fact.escalationKind]: null },
    };
    const maintainerCapabilities = {
      primaryOwnerByRepairKind: { [fact.repairKind]: 'maintainer' },
      escalationOwnerByKind: { [fact.escalationKind]: null },
    };
    assert.throws(
      () => createValidationResult({
        command: 'verify',
        diagnostics: [
          presentDiagnostic(fact, engineerCapabilities),
          presentDiagnostic(fact, maintainerCapabilities),
        ],
        evidenceState: 'malformed',
        disposition: 'rejected',
      }),
      /share one routing capability context/
    );
    assert.throws(
      () => createValidationResult({
        command: 'verify',
        diagnostics: [presentDiagnostic(fact, engineerCapabilities)],
        warningDiagnostics: [
          presentDiagnostic(
            createDiagnostic({ code: 'evidence.malformed', level: 'warning' }),
            maintainerCapabilities
          ),
        ],
        evidenceState: 'malformed',
        disposition: 'rejected',
      }),
      /share one routing capability context/
    );
  });

  it('rejects missing, duplicate, and unknown required fields', () => {
    const missing = VALIDATION_RESULT_REQUIRED_FIELDS.filter(field => field !== 'command');
    assert.equal(validateRequiredFieldInventory(missing).ok, false);
    assert.equal(validateRequiredFieldInventory([...VALIDATION_RESULT_REQUIRED_FIELDS, 'command']).ok, false);
    assert.equal(validateRequiredFieldInventory([...VALIDATION_RESULT_REQUIRED_FIELDS, 'authorityByArrayOrder']).ok, false);
    const envelope = result([]);
    delete envelope.command;
    assert.match(validateValidationResult(envelope).errors.join('\n'), /missing required field 'command'/);
    assert.throws(() => serializeValidationResult(envelope), /invalid validation result/);
  });

  it('rejects a failing envelope that claims the proceed disposition', () => {
    assert.throws(
      () => createValidationResult({
        command: 'verify',
        ok: false,
        evidenceState: 'current',
        disposition: 'proceed',
      }),
      /failed validation result cannot use disposition 'proceed'/
    );
  });

  it('keeps all five non-current evidence states mechanically distinct', () => {
    const cases = [
      ['missing', 'evidence.missing'],
      ['malformed', 'evidence.malformed'],
      ['stale', 'evidence.stale'],
      ['negative', 'evidence.negative'],
      ['changed', 'evidence.changed'],
    ];
    for (const [state, code] of cases) {
      const envelope = createValidationResult({
        command: 'verify', evidenceState: state, disposition: state === 'missing' ? 'needs_context' : 'blocked',
        diagnostics: [createDiagnostic({ code, evidence: { state } })], debugReference: null,
      });
      assert.equal(envelope.evidenceState, state);
      assert.equal(envelope.diagnostics[0].code, code);
      assert.equal(envelope.rollbackAuthorized, false);
    }
  });

  it('catalogs clean-tree, host-local, UTF-8/BOM, and role-result schema failures', () => {
    for (const code of ['worktree.clean_gate.failed', 'state.host_local', 'task.body.utf8', 'task.body.bom', 'role_result.schema.invalid']) {
      assert.ok(REPAIR_POLICY[code], code);
      assert.equal(createDiagnostic({ code }).code, code);
    }
  });

  it('suppresses only diagnostics that depend on an invalid root', () => {
    const root = createDiagnostic({ code: 'task.record.structure' });
    const dependent = createDiagnostic({ code: 'task.body.identity', diagnosticPrerequisites: ['canonical_task_record'] });
    const independent = createDiagnostic({ code: 'preflight.attribution' });
    assert.deepEqual(suppressDependentDiagnostics([root, dependent, independent], ['canonical_task_record']).map(item => item.code), [
      'task.record.structure', 'preflight.attribution',
    ]);
  });

  it('applies explicit root precedence without suppressing independent findings', () => {
    const diagnostics = [
      createDiagnostic({ code: 'task.body.collapsed_newlines' }),
      createDiagnostic({ code: 'task.body.bom' }),
      createDiagnostic({ code: 'task.body.identity', diagnosticPrerequisites: ['canonical_task_record'] }),
      createDiagnostic({ code: 'preflight.attribution' }),
    ];
    assert.deepEqual(consolidateDiagnostics(diagnostics).map(item => item.code), [
      'task.body.bom', 'preflight.attribution',
    ]);
  });

  it('applies root precedence at the production envelope boundary', () => {
    const envelope = createValidationResult({
      command: 'verify',
      evidenceState: 'malformed',
      disposition: 'rejected',
      errors: ['BOM root', 'dup heading (dependent)', 'independent PR fact'],
      failureCategories: ['stale_compatibility_category'],
      diagnostics: [
        createDiagnostic({ code: 'task.body.collapsed_newlines', message: 'dup heading (dependent)' }),
        createDiagnostic({ code: 'task.body.bom', message: 'BOM root' }),
        createDiagnostic({
          code: 'task.body.identity',
          message: 'dependent identity',
          diagnosticPrerequisites: ['canonical_task_record'],
        }),
        createDiagnostic({ code: 'preflight.attribution', message: 'independent PR fact' }),
      ],
    });
    assert.deepEqual(envelope.diagnostics.map(item => item.code), [
      'task.body.bom', 'preflight.attribution',
    ]);
    assert.deepEqual(envelope.errors, ['BOM root', 'independent PR fact']);
    assert.deepEqual(envelope.failureCategories, ['task_contract', 'attribution']);
  });
});

describe('task-record root-cause diagnostics', () => {
  it('reports one BOM primary even when dependent mutable-marker evidence is present', () => {
    const collapsed = '\uFEFF---task_id: T-101 status: agent-ready backend: github---## Task broken\n<!-- AGENTIC_LOOP_TASK_CONTRACT_RECORD\n{}\n-->';
    const lint = lintGitHubTaskBody({ issue: 31, body: collapsed });
    assert.deepEqual(lint.diagnostics.map(item => item.code), ['task.body.bom']);
    assert.equal(lint.evidenceState, 'malformed');
    assert.equal(lint.rollbackAuthorized, false);
  });

  it('accepts a literal replacement character in ordinary Unicode task prose', () => {
    const lint = lintGitHubTaskBody({ issue: 31, body: validGitHubTaskBody({ prose: 'Literal replacement character: \uFFFD.' }) });
    assert.equal(lint.diagnostics.some(item => item.code === 'task.body.utf8'), false);
  });

  it('reports invalid UTF-8 only when a byte boundary supplies failed fatal-decoding evidence', () => {
    const raw = evaluateTaskRecordRoot('', { bytes: new Uint8Array([0xc3, 0x28]) });
    assert.equal(raw.ok, false);
    assert.equal(raw.diagnostics[0].code, 'task.body.utf8');
    assert.equal(raw.utf8Integrity, 'invalid');
    assert.equal(evaluateTaskRecordRoot(validGitHubTaskBody({ prose: 'Replacement: \uFFFD.' })).utf8Integrity, 'unavailable');
  });

  it('rejects BOM and collapsed-newline roots consistently at readiness', () => {
    for (const [body, code] of [
      [validGitHubTaskBody({ prefix: '\uFEFF' }), 'task.body.bom'],
      ['---task_id: T-101 status: draft---## Task collapsed', 'task.body.collapsed_newlines'],
    ]) {
      const readiness = evaluateTaskReadiness({
        taskBody: body,
        basePaths: ['src/app.js'],
        mode: 'review',
      });
      assert.equal(readiness.ok, false);
      assert.equal(readiness.evidenceState, 'malformed');
      assert.equal(readiness.disposition, 'rejected');
      assert.deepEqual(readiness.diagnostics.map(item => item.code), [code]);
    }
  });

  it('rejects structurally incomplete or duplicated task records before readiness evaluation', () => {
    const incomplete = [
      '---',
      'task_id: T-101',
      'status: draft',
      'backend: github',
      'attempt_budget: 5',
      'review_budget: 5',
      'allowed_paths:',
      '  - src/**',
      'intended_creations: []',
      '---',
      '',
      '# T-101 - Incomplete task',
      '',
      '## Task',
      'One section is not a canonical task record.',
      '',
      '## Scope',
      'First scope.',
      '',
      '## Scope',
      'Duplicate scope.',
    ].join('\n');
    const readiness = evaluateTaskReadiness({
      taskBody: incomplete,
      basePaths: ['src/app.js'],
      mode: 'review',
    });
    assert.equal(readiness.ok, false);
    assert.equal(readiness.evidenceState, 'malformed');
    assert.equal(readiness.disposition, 'rejected');
    assert.ok(readiness.diagnostics.every(item => item.code === 'task.record.structure'));
    assert.match(readiness.errors.join('\n'), /duplicate canonical section '## Scope'/);
  });

  it('keeps files-backed root diagnostics typed alongside legacy strings', () => {
    const content = validGitHubTaskBody({ prefix: '\uFEFF' });
    const diagnostics = validateTaskRecordDiagnostics(content, 'T-101.md');
    assert.deepEqual(diagnostics.map(item => item.code), ['task.body.bom']);
    assert.match(diagnostics[0].repairHint, /Preserve/);
    assert.match(validateTaskRecord(content, 'T-101.md')[0], /malformed canonical structure/);
  });

  it('distinguishes missing standalone verification context from invalid state', () => {
    const check = evaluateTaskReadiness({ taskBody: validGitHubTaskBody(), mode: 'authoring' });
    assert.equal(check.evidenceState, 'missing');
    assert.equal(check.disposition, 'needs_context');
    assert.equal(check.rollbackAuthorized, false);
    assert.equal(check.diagnostics[0].code, 'readiness.base_inventory.missing');
    assert.equal(check.diagnostics[0].evidence.state, 'missing');
    assert.equal(Object.hasOwn(check.diagnostics[0].evidence, 'evidenceState'), false);
  });

  it('keeps repeated audit rewrites at one canonical title', () => {
    let content = createAuditRecordContent({
      auditId: 'AUD-001', workUnit: 'phase:35', coveredTasks: ['T-001'], candidateArtifact: 'commit:' + 'a'.repeat(40),
      goal: 'Goal.', completionOracle: 'Oracle.', evidence: 'Evidence.',
    });
    content = updateAuditBaseline(content, { candidateArtifact: 'commit:' + 'b'.repeat(40), evidence: 'Fresh.' });
    content = updateAuditBaseline(content, { candidateArtifact: 'commit:' + 'c'.repeat(40), evidence: 'Fresh again.' });
    assert.equal(content.match(/^# AUD-001: Work-Unit Audit$/gm)?.length, 1);
    assert.deepEqual(validateAuditRecord(content, 'AUD-001.md'), []);
  });

  it('rejects duplicate canonical headings before parsing or mutation', () => {
    const content = createAuditRecordContent({
      auditId: 'AUD-001', workUnit: 'phase:35', coveredTasks: ['T-001'], candidateArtifact: 'commit:' + 'a'.repeat(40),
      goal: 'Goal.', completionOracle: 'Oracle.', evidence: 'Evidence.',
    });
    const corrupt = content.replace('# AUD-001: Work-Unit Audit', '# AUD-001: Work-Unit Audit\n\n# AUD-001: Work-Unit Audit');
    assert.match(validateAuditRecord(corrupt, 'AUD-001.md')[0], /malformed canonical structure/);
    assert.throws(() => updateAuditBaseline(corrupt, { evidence: 'No mutation.' }), error => error.code === 'task.record.structure');
    const append = appendAuditReport(corrupt, {});
    assert.equal(append.ok, false);
    assert.match(append.errors.join('\n'), /existing audit record is invalid:.*malformed canonical structure/);
    assert.equal(parseAuditRecord(corrupt).auditId, 'AUD-001');
  });

  it('rejects a second live canonical H1 after the first H2 before every semantic rewrite', () => {
    const content = auditRecord();
    const corrupt = content.replace('## Work Unit Goal', '## Work Unit Goal\n\n# AUD-001: Work-Unit Audit');
    assert.match(validateAuditRecord(corrupt, 'AUD-001.md')[0], /malformed canonical structure/);
    const before = corrupt;
    assert.throws(() => updateAuditBaseline(corrupt, { evidence: 'No mutation.' }), error => error.code === 'task.record.structure');
    for (const result of [
      appendAuditReport(corrupt, {}),
      applyAuditBudgetOverride(corrupt, { budget: 4, authority: 'human: reviewer' }),
      applyAuditHumanResolution(corrupt, { authority: 'human: reviewer', note: 'No mutation.' }),
      applyAuditDisposition(corrupt, { run: 1, findingId: 'A-01', type: 'follow_up', ref: 'T-002' }),
      canonicalizeAuditRecord(corrupt, { evidence: 'No mutation.', resolveArtifact: () => ({ ok: true, canonical: `commit:${'b'.repeat(40)}` }) }),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /malformed canonical structure/);
    }
    assert.equal(corrupt, before);
    assert.equal(corrupt.match(/^# AUD-001: Work-Unit Audit$/gm)?.length, 2);
  });

  it('ignores canonical-looking headings in real fenced Markdown while preserving the fenced content', () => {
    const content = auditRecord();
    const fenced = content.replace(
      '# AUD-001: Work-Unit Audit',
      '# AUD-001: Work-Unit Audit\n\n~~~markdown\n# AUD-001: Work-Unit Audit\n~~~'
    );
    assert.deepEqual(validateAuditRecord(fenced, 'AUD-001.md'), []);
    const updated = updateAuditBaseline(fenced, { evidence: 'Fresh evidence.' });
    assert.match(updated, /~~~markdown\n# AUD-001: Work-Unit Audit\n~~~/);
    assert.equal(updated.match(/^# AUD-001: Work-Unit Audit$/gm)?.length, 2);
  });

  it('rejects duplicate canonical audit sections before semantic mutation', () => {
    const content = createAuditRecordContent({
      auditId: 'AUD-001', workUnit: 'phase:35', coveredTasks: ['T-001'], candidateArtifact: 'commit:' + 'a'.repeat(40),
      goal: 'Goal.', completionOracle: 'Oracle.', evidence: 'Evidence.',
    });
    const corrupt = content.replace('## Comments', '## Comments\n\nFirst.\n\n## Comments');
    assert.throws(() => updateAuditBaseline(corrupt, { evidence: 'No mutation.' }), error => error.code === 'task.record.structure');
  });

  it('rejects duplicate task sections instead of first-match parsing', () => {
    const headings = [
      '## Task', '## Source Documents Reviewed', '## Current State', '## Scope', '## Out of Scope',
      '## Acceptance Criteria', '## Required Checks', '## Expected Files or Areas', '## Implementation Notes',
      '## Completion Summary Template', '## Reviewer Checklist',
    ];
    const content = `${headings.map(heading => `${heading}\nConcrete content.`).join('\n\n')}\n\n## Scope\nDuplicate.`;
    assert.match(validateTaskRecord(content, 'T-001.md').join('\n'), /duplicate canonical section '## Scope'/);
  });
});

describe('public CLI failure boundaries', () => {
  it('suppresses preflight derivatives after a malformed canonical task root while retaining a recovery route', () => {
    const result = evaluatePreflight({
      prData: {
        number: 42,
        headRefOid: '',
        baseRefOid: 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        body: ['## Scope Completed', 'Done.', '', '## Artifacts', `PR at ${HEAD}.`, '', '## Evidence', `Current PR head: ${HEAD}`, '', '- Required check: `npm test`', '  Verdict: passed', '  Evidence: passed', '', '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.'].join('\n'),
        files: [], closingIssuesReferences: [{ number: 7 }], statusCheckRollup: [], commits: [], comments: [], reviews: [],
      },
      issueData: { number: 7, body: validGitHubTaskBody({ prefix: '\uFEFF' }), comments: [] },
      expectedAccount: { login: 'loop-bot', type: 'User' },
      reviewHistory: { events: [], errors: [] },
      projectFacts: [], basePaths: [], mode: 'review', pathInventoryRequired: false,
    });
    const codes = result.diagnostics.map(item => item.code);
    assert.deepEqual(codes.filter(code => code === 'task.body.bom'), ['task.body.bom']);
    for (const code of ['preflight.task_policy', 'task.body.identity', 'contract.baseline.invalid', 'preflight.checks.task_contract', 'preflight.scope_deviations']) {
      assert.equal(codes.includes(code), false, code);
    }
    assert.equal(codes.includes('preflight.head_identity'), true);
    assert.ok(result.firstSafeRepair);
  });

  it('emits canonical validation JSON for public command failures and preserves usage guidance', async () => {
    for (const command of ['github-preflight', 'github-review-audit', 'github-ready']) {
      const run = await runCliInProcess([command, '--json']);
      assert.notEqual(run.status, 0);
      const parsed = JSON.parse(run.stdout);
      assert.equal(
        run.stdout.trim(),
        serializeValidationResult(parsed, { capabilities: getProjectRoleCapabilities() })
      );
    }
    const usageCases = [
      [['frobnicate'], /Run "agenticloop help" for all commands\./],
      [['configure', 'not-a-subcommand'], /Run "agenticloop help configure" for usage\./],
      [['github-preflight', '--unknown-option'], /Run "agenticloop help github-preflight" for usage\./],
    ];
    for (const [argv, hint] of usageCases) {
      const unknown = await runCliInProcess(argv);
      assert.equal(unknown.status, 2);
      assert.match(unknown.stderr, hint);
    }
    for (const argv of [['frobnicate', '--json'], ['configure', 'not-a-subcommand', '--json'], ['github-preflight', '--unknown-option', '--json']]) {
      const json = await runCliInProcess(argv);
      const parsed = JSON.parse(json.stdout);
      assert.match(parsed.firstSafeRepair, /agenticloop help/);
    }
  });
});
