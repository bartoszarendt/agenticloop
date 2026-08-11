import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreflight, parseRequiredChecks } from '../src/github-preflight.js';
import { createPreparationInput, evaluatePreparationInput, normalizePreparationInput } from '../src/preparation-input.js';
import { validateResolutionMatrix, normalizeResolutionArtifact, renderResolutionArtifact } from '../src/resolution-matrix.js';
import { createPrBodySnapshot, normalizePrBodySnapshot } from '../src/pr-body-context.js';
import { evaluateTaskReadiness } from '../src/task-readiness.js';
import { evaluateCommitAttribution } from '../src/commit-attribution.js';
import { renderPrBodyScaffold, lintPrBody } from '../src/pr-body.js';
import { validateFindingIdLifecycle, parseNoProgressDisposition, formatNoProgressDisposition } from '../src/review-history.js';
import { evaluateNoProgress, applyCheckpointRepairs, parseCheckpointRepair, formatCheckpointRepair, deriveCheckpointState } from '../src/review-checkpoint.js';
import {
  REVIEW_PACKET_LEASE,
  reviewPacketDigest,
  runGitHubReviewPrepare,
  validateReviewPacket,
  verifyReviewPacket,
} from '../src/github-review-prepare.js';
import { taskContractDigest } from '../src/task-contract-baseline.js';
import { createReviewEntryReceipt, reviewEntryReceiptCurrentFindingIds } from '../src/review-entry-receipt.js';
import { presentDiagnostic } from '../src/diagnostic-presentation.js';
import { getProjectRoleCapabilities } from '../src/role-capabilities.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDispatchFixture, git, prepare, producerBinding, readyReturn, repositoryEvidence,
} from './helpers/dispatch-fixture.js';
import { createTaskReadinessEvidence } from '../src/task-evidence-contract.js';
import { receiveRoleReturn } from '../src/dispatch-envelope.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createDispatchConsumption, dispatchConsumptionRelativePath } from '../src/handoff-consumption.js';
import { createReturnVerification, writeReturnVerification } from '../src/return-verification.js';
import { fixtureDispatchValidator } from './helpers/handoff-fixture.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { createTaskContractBaselineRecord, renderTaskContractRecord } from '../src/task-contract-baseline.js';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function presentedOwner(diagnostic) {
  return presentDiagnostic(diagnostic, getProjectRoleCapabilities(REPO_ROOT)).owner ?? null;
}

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const BASE = 'b'.repeat(40);

function baseBody({ check = '[RC-1] `npm test`', head = HEAD } = {}) {
  return [
    '## Scope Completed', 'Completed.', '',
    '## Artifacts', `Current implementation artifact: commit:${head}`, '',
    '## Evidence', `Current PR head: ${head}`, '',
    `- Required check: ${check}`, '  Verdict: passed', '  Evidence: test completed with exit status 0.', '',
    '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
  ].join('\n');
}

function canonicalTask(frontmatter = [], requiredCheck = '[RC-1] `npm test`') {
  const fields = Array.isArray(frontmatter) ? frontmatter : String(frontmatter).split('\n');
  if (!fields.some(line => /^task_id:/.test(line))) fields.unshift('task_id: T-007');
  return [
    '---',
    ...fields,
    '---',
    '',
    '# T-007 - Review preparation',
    '',
    '## Task', 'Prepare the task for review.',
    '',
    '## Source Documents Reviewed', '- README.md',
    '',
    '## Current State', 'The task is ready for contract evaluation.',
    '',
    '## Scope', 'Evaluate the declared paths and evidence.',
    '',
    '## Out of Scope', 'No unrelated implementation.',
    '',
    '## Acceptance Criteria', '- The review contract is enforced.',
    '',
    '## Required Checks', `- ${requiredCheck}`,
    '',
    '## Expected Files or Areas', '- src/',
    '',
    '## Implementation Notes', 'Keep evidence deterministic.',
    '',
    '## Completion Summary Template', 'Summarize the review result.',
    '',
    '## Reviewer Checklist', '- [ ] Confirm the evidence.',
  ].join('\n');
}

function baseInput({ issueCheck = '[RC-1] `npm test`', prBody = baseBody(), comments = [], reviews = [] } = {}) {
  return createPreparationInput({
    prData: { number: 42, body: prBody, headRefOid: HEAD, baseRefOid: BASE, files: [], statusCheckRollup: [], commits: [], comments, reviews },
    issueData: { number: 7, body: canonicalTask([], issueCheck), comments: [] },
    expectedAccount: { login: 'loop-bot', type: 'User' }, reviewHistory: { events: [], errors: [] },
    basePaths: ['src/App.js'], mode: 'review', projectFacts: [], reviewBudget: 5,
  });
}

/**
 * Build a genuine v3 review-entry receipt. Packet validation now proves the
 * embedded receipt's own closed schema and digest, so a fixture cannot fake one
 * with matching projections alone.
 */
function reviewEntryReceipt({ head = HEAD, pr = 42, task = 7, reviewHistory = { events: [], errors: [] } } = {}) {
  const body = canonicalTask();
  const contract = taskContractDigest(body);
  const loaded = {
    input: {
      prData: {
        number: pr, headRefOid: head,
        commits: [{ oid: head, message: 'impl\n\nTask: T-007\nAgent: engineer' }],
      },
      issueData: { number: task, body },
      reviewHistory,
    },
  };
  const result = {
    ok: true, errors: [], warnings: [],
    requiredChecks: [{ id: 'RC-1', text: '[RC-1] `npm test`', matchKey: 'npm test' }],
    evidenceMatches: [{ id: 'RC-1', check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'tests passed' }],
    contractBaseline: { digest: contract.digest, baseline: null },
  };
  return createReviewEntryReceipt(loaded, result, { observedAt: '2026-08-07T00:00:00.000Z' });
}

function reviewPacket(overrides = {}) {
  const receipt = overrides.reviewEntryReceipt ?? reviewEntryReceipt();
  const packet = {
    type: 'agenticloop.github_review_preparation',
    schemaVersion: 3,
    pr: 42,
    task: 7,
    headRefOid: HEAD,
    reviewMode: 'host_subagent',
    independentReviewRequired: false,
    workspace: null,
    currentFindingIds: reviewEntryReceiptCurrentFindingIds(receipt),
    preflight: {
      ok: true,
      digest: {
        requiredChecks: receipt.checks?.required?.length ?? 1,
        evidenceMatches: receipt.checks?.evidence?.length ?? 1,
        headRefOid: HEAD,
      },
    },
    taskContract: { digest: receipt.task?.contractDigest ?? null, baseline: receipt.task?.contractBaseline ?? null },
    reviewEntryReceipt: receipt,
    lease: REVIEW_PACKET_LEASE,
    digest: null,
    ...overrides,
  };
  packet.digest = reviewPacketDigest(packet);
  return packet;
}

// ---------------------------------------------------------------------------
// Step 1: preparation-input parity and fail-closed completeness
// ---------------------------------------------------------------------------

describe('review preparation contract - preparation-input parity', () => {
  it('does not allow an empty supplied reviewHistory to suppress malformed raw PR comments', () => {
    const malformedMarker = [
      'AGENT_REVIEW_STATUS: needs_revision',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${HEAD}`,
      '[[agent: maintainer]]',
      // findings field intentionally missing -> malformed trusted carrier
    ].join('\n');
    const comment = { id: 50, html_url: 'https://example.invalid/c/50', created_at: '2026-07-25T10:00:00Z', body: malformedMarker, user: { login: 'loop-bot', type: 'User' } };
    // Caller supplies an EMPTY reviewHistory while the raw carrier is malformed.
    const serialized = baseInput({ comments: [comment] });
    serialized.reviewHistory = { events: [], errors: [] };
    const result = evaluatePreparationInput(serialized, evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inconsistent with the raw PR comments\/reviews|findings/i);
  });

  it('offline and live-equivalent inputs produce the same semantic result', () => {
    const serialized = baseInput();
    const offline = evaluatePreparationInput(serialized, evaluatePreflight);
    const direct = evaluatePreflight({
      prData: serialized.prData, issueData: serialized.issueData, expectedAccount: serialized.expectedAccount,
      reviewHistory: serialized.reviewHistory, reviewBudget: 5, basePaths: serialized.basePaths, mode: 'review', pathInventoryRequired: true,
    });
    assert.deepEqual(offline.errors, direct.errors);
    assert.deepEqual(offline.warnings, direct.warnings);
    assert.equal(offline.ok, direct.ok);
  });

  it('rejects a malformed preparation input document', () => {
    const broken = baseInput();
    delete broken.prData.commits;
    const result = evaluatePreparationInput(broken, evaluatePreflight);
    assert.equal(result.inputComplete, false);
    assert.equal(result.ok, false);
  });

  it('requires every preparation category under one completeness policy', () => {
    const mutations = [
      doc => { delete doc.prData.body; },
      doc => { delete doc.prData.headRefOid; },
      doc => { delete doc.prData.baseRefOid; },
      doc => { delete doc.prData.files; },
      doc => { delete doc.prData.statusCheckRollup; },
      doc => { delete doc.prData.commits; },
      doc => { delete doc.prData.comments; },
      doc => { delete doc.prData.reviews; },
      doc => { delete doc.issueData.body; },
      doc => { delete doc.issueData.comments; },
      doc => { delete doc.expectedAccount; },
      doc => { delete doc.basePaths; },
      doc => { delete doc.pathInventoryRequired; },
      doc => { delete doc.projectFacts; },
      doc => { delete doc.references; },
      doc => { delete doc.configuration; },
      doc => { delete doc.reviewHistory; },
    ];
    for (const mutate of mutations) {
      const doc = baseInput();
      mutate(doc);
      const result = evaluatePreparationInput(doc, evaluatePreflight);
      assert.equal(result.inputComplete, false, 'expected an incomplete-input rejection');
      assert.equal(result.ok, false);
    }
  });

  it('distinguishes an explicitly null verificationStatus from a silently omitted one', () => {
    const explicitNull = baseInput();
    explicitNull.verificationStatus = null;
    assert.equal(evaluatePreparationInput(explicitNull, evaluatePreflight).inputComplete, true);
    const omitted = baseInput();
    delete omitted.verificationStatus;
    const result = evaluatePreparationInput(omitted, evaluatePreflight);
    assert.equal(result.inputComplete, false);
    assert.match(result.errors.join('\n'), /verificationStatus/);
  });

  it('rejects a fabricated supplied history when raw carriers derive an empty history', () => {
    const serialized = baseInput();
    serialized.reviewHistory = {
      events: [{ type: 'checkpoint', direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1, artifact: HEAD, target: 'x', orchestratorAttribution: 'loop-bot', sourceOrder: 0 }],
      errors: [],
    };
    const result = evaluatePreparationInput(serialized, evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inconsistent with the raw PR comments\/reviews/);
  });

  it('rejects a same-count but different-content supplied history', () => {
    const marker = [
      'AGENT_REVIEW_STATUS: needs_revision',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${BASE}`,
      'AGENT_REVIEW_FINDINGS: F-1',
      '[[agent: maintainer]]',
    ].join('\n');
    const comment = { id: 60, html_url: 'https://example.invalid/c/60', created_at: '2026-07-25T10:00:00Z', body: marker, user: { login: 'loop-bot', type: 'User' } };
    const serialized = baseInput({ comments: [comment] });
    // Same event/error counts as the derived history, different content.
    serialized.reviewHistory = {
      events: [{ type: 'outcome', status: 'needs_revision', artifact: BASE, findingIds: ['F-9'], sourceOrder: 0 }],
      errors: [],
    };
    const result = evaluatePreparationInput(serialized, evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /inconsistent with the raw PR comments\/reviews/);
  });

  it('produces the same semantic result for the same malformed document through live and offline entry points', async () => {
    const { runPreflight } = await import('../src/github-preflight.js');
    const defectiveBody = baseBody().replace('  Evidence: test completed with exit status 0.', '  Evidence:');
    const prData = { number: 42, body: defectiveBody, headRefOid: HEAD, baseRefOid: BASE, files: [], statusCheckRollup: [], commits: [], comments: [], reviews: [], closingIssuesReferences: [{ number: 7 }] };
    const issueData = { number: 7, body: canonicalTask(), comments: [] };
    const offline = evaluatePreparationInput(createPreparationInput({
      prData, issueData, expectedAccount: { login: 'loop-bot', type: 'User' },
      reviewHistory: { events: [], errors: [] }, basePaths: [], mode: 'review', projectFacts: [], reviewBudget: 5,
    }), evaluatePreflight);
    const runner = (command, args) => {
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop-bot', type: 'User' }), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const live = runPreflight({
      pr: 42, commandRunner: runner,
      verificationContext: { projectFacts: [], decisionExists: () => false, taskExists: () => false },
    });
    assert.equal(live.ok, false);
    assert.equal(offline.ok, false);
    assert.deepEqual(live.errors, offline.errors);
  });

  it('applies the same completeness policy to the live preflight path', async () => {
    const { runPreflight } = await import('../src/github-preflight.js');
    const prData = { number: 42, headRefOid: HEAD, baseRefOid: BASE, files: [], statusCheckRollup: [], comments: [], reviews: [], closingIssuesReferences: [{ number: 7 }] };
    // The PR body is silently omitted from the live document.
    const issueData = { number: 7, body: canonicalTask(), comments: [] };
    const runner = (command, args) => {
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop-bot', type: 'User' }), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const live = runPreflight({
      pr: 42, commandRunner: runner,
      verificationContext: { projectFacts: [], decisionExists: () => false, taskExists: () => false },
    });
    assert.equal(live.ok, false);
    assert.match(live.errors.join('\n'), /preparation input/);
  });
});

// ---------------------------------------------------------------------------
// Step 1: live deviation integration through evaluatePreflight
// ---------------------------------------------------------------------------

describe('review preparation contract - live deviation integration', () => {
  const scopedIssue = canonicalTask(['task_id: T-007', 'allowed_paths: ["src/**"]']);
  function scopedInput({ prBody = baseBody(), files = ['src/app.js'], basePaths = ['src/app.js'] } = {}) {
    return {
      prData: { number: 42, body: prBody, headRefOid: HEAD, files, statusCheckRollup: [], commits: [], comments: [], reviews: [] },
      issueData: { number: 7, body: scopedIssue, comments: [] },
      expectedAccount: { login: 'loop-bot', type: 'User' },
      reviewHistory: { events: [], errors: [] },
      reviewBudget: 5, basePaths, mode: 'review', pathInventoryRequired: true,
    };
  }
  function withDeviation(deviationSection) {
    return baseBody().replace('## Deviations\nNone.', `## Deviations\n${deviationSection}`);
  }
  const countOccurrences = (result, pattern) => result.errors.filter(message => pattern.test(message)).length;

  it('does not reject a changed path authorized by a valid ## Deviations entry', () => {
    const result = evaluatePreflight(scopedInput({
      prBody: withDeviation('- `docs/notes.md`: documentation for the scoped feature'),
      files: ['src/app.js', 'docs/notes.md'],
    }));
    assert.ok(!result.errors.some(message => /docs\/notes\.md/.test(message)), result.errors.join('\n'));
  });

  it('reports a missing deviation exactly once', () => {
    const result = evaluatePreflight(scopedInput({ files: ['src/app.js', 'docs/notes.md'] }));
    assert.equal(countOccurrences(result, /docs\/notes\.md/), 1, result.errors.join('\n'));
    assert.equal(result.ok, false);
  });

  it('reports duplicate deviation paths exactly once', () => {
    const result = evaluatePreflight(scopedInput({
      prBody: withDeviation('- `docs/notes.md`: reason one\n- `docs/notes.md`: reason two'),
      files: ['src/app.js', 'docs/notes.md'],
    }));
    assert.equal(countOccurrences(result, /duplicate deviation path/), 1, result.errors.join('\n'));
  });

  it('rejects an unnecessary deviation for a path already covered by allowed_paths', () => {
    const result = evaluatePreflight(scopedInput({
      prBody: withDeviation('- `src/app.js`: this is already in scope'),
      files: ['src/app.js'],
    }));
    assert.equal(countOccurrences(result, /already covered by allowed_paths/), 1, result.errors.join('\n'));
  });

  it('rejects a malformed deviation entry exactly once', () => {
    const result = evaluatePreflight(scopedInput({
      prBody: withDeviation('- `docs/notes.md`:'),
      files: ['src/app.js', 'docs/notes.md'],
    }));
    assert.equal(countOccurrences(result, /empty reason/), 1, result.errors.join('\n'));
    // A malformed entry cannot authorize the path.
    assert.equal(countOccurrences(result, /no declaration in ## Deviations/), 1, result.errors.join('\n'));
  });

  it('preserves exact generated-path authorization without allowing unrelated paths', () => {
    const generatedIssue = scopedIssue.replace('allowed_paths: ["src/**"]', 'allowed_paths: ["src/**"]\ngenerated_paths:\n  "dist/bundle.js":\n    generator: esbuild\n    source: src/app.js\n    verification: parity');
    const authorized = evaluatePreflight({
      ...scopedInput({ files: ['src/app.js', 'dist/bundle.js'] }),
      issueData: { number: 7, body: generatedIssue, comments: [] },
    });
    assert.ok(!authorized.errors.some(message => /dist\/bundle\.js/.test(message)), authorized.errors.join('\n'));
    const unrelated = evaluatePreflight({
      ...scopedInput({ files: ['src/app.js', 'dist/bundle.js', 'lib/rogue.js'] }),
      issueData: { number: 7, body: generatedIssue, comments: [] },
    });
    assert.equal(countOccurrences(unrelated, /lib\/rogue\.js/), 1, unrelated.errors.join('\n'));
    assert.equal(unrelated.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Step 2: task-readiness deviation unification, generated provenance, glob bounding
// ---------------------------------------------------------------------------

describe('review preparation contract - task readiness', () => {
  it('does not re-reject a changed path authorized by the deviations mechanism', () => {
    const task = canonicalTask(['allowed_paths: ["src/app/**"]']);
    const result = evaluateTaskReadiness({
      taskBody: task, basePaths: ['src/app/core.js'], mode: 'review',
      changedPaths: ['src/app/core.js', 'src/generated/out.js'],
      deviationEntries: [{ path: 'src/generated/out.js', reason: 'build output covered by generated declaration' }],
    });
    // src/generated/out.js is not in allowed_paths but is a declared deviation.
    assert.ok(!result.errors.some(error => /src\/generated\/out\.js/.test(error)), result.errors.join('\n'));
  });

  it('rejects a changed path with no deviation or generated declaration', () => {
    const task = canonicalTask(['allowed_paths: ["src/app/**"]']);
    const result = evaluateTaskReadiness({
      taskBody: task, basePaths: ['src/app/core.js'], mode: 'review',
      changedPaths: ['src/app/core.js', 'src/elsewhere/rogue.js'], deviationEntries: [],
    });
    assert.match(result.errors.join('\n'), /src\/elsewhere\/rogue\.js/);
    assert.equal(result.ok, false);
  });

  it('authorizes an exact generated output with valid provenance', () => {
    const task = canonicalTask([
      'allowed_paths: ["src/app/**"]',
      'generated_paths:',
      '  "dist/bundle.js":',
      '    generator: esbuild',
      '    source: src/app/index.js',
      '    verification: parity',
    ]);
    const result = evaluateTaskReadiness({
      taskBody: task, basePaths: ['src/app/index.js'], mode: 'review',
      changedPaths: ['src/app/index.js', 'dist/bundle.js'], deviationEntries: [],
    });
    assert.ok(!result.errors.some(error => /dist\/bundle\.js/.test(error)), result.errors.join('\n'));
  });

  it('rejects malformed generated provenance', () => {
    const task = canonicalTask([
      'allowed_paths: ["src/app/**"]',
      'generated_paths:',
      '  "dist/bundle.js":',
      '    generator: esbuild',
    ]);
    const result = evaluateTaskReadiness({ taskBody: task, basePaths: ['src/app/index.js'], mode: 'review' });
    assert.match(result.errors.join('\n'), /dist\/bundle\.js.*generator.*source.*verification/);
  });

  it('preserves task-readiness diagnostic categories through preflight', () => {
    const input = baseInput();
    input.issueData.body = canonicalTask([
      'task_id: T-007',
      'allowed_paths: ["src/**"]',
      'generated_paths:',
      '  "dist/bundle.js":',
      '    generator: esbuild',
    ]);
    input.basePaths = ['src/App.js'];
    input.pathInventoryRequired = true;
    const result = evaluatePreparationInput(input, evaluatePreflight);
    const generated = result.diagnostics.find(item => /dist\/bundle\.js.*generator.*source.*verification/.test(item.message));
    assert.equal(generated?.category, 'generated_paths');
  });

  it('rejects a glob generated declaration that would bypass exact-path scope', () => {
    const task = canonicalTask([
      'allowed_paths: ["src/app/**"]',
      'generated_paths:',
      '  "dist/**":',
      '    generator: esbuild',
      '    source: src/app/index.js',
      '    verification: parity',
    ]);
    const result = evaluateTaskReadiness({ taskBody: task, basePaths: ['src/app/index.js'], mode: 'review' });
    assert.match(result.errors.join('\n'), /must be an exact repo-relative path/);
  });

  it('distinguishes authoring warnings from review errors and allows declared creation', () => {
    const task = canonicalTask([
      'allowed_paths: ["src/App.tsx", "src/new.ts"]',
      'intended_creations: ["src/new.ts"]',
      'depends_on: ["T-001"]',
    ]);
    const authoring = evaluateTaskReadiness({ taskBody: task, basePaths: ['src/App.js'], mode: 'authoring', dependencies: { 'T-001': 'resolved' } });
    assert.equal(authoring.ok, true);
    assert.match(authoring.warnings.join('\n'), /App.tsx/);
    const review = evaluateTaskReadiness({ taskBody: task, basePaths: ['src/App.js'], mode: 'review', dependencies: { 'T-001': 'resolved' } });
    assert.equal(review.ok, false);
    assert.match(review.errors.join('\n'), /App.tsx/);
  });

  it('bounds glob diagnostics to a count and small deterministic sample', () => {
    const task = canonicalTask(['allowed_paths: ["src/**"]']);
    const basePaths = Array.from({ length: 50 }, (_, i) => `src/file${i}.js`);
    const result = evaluateTaskReadiness({ taskBody: task, basePaths, mode: 'review' });
    const glob = result.paths.find(p => p.classification === 'glob');
    assert.ok(glob, 'expected a glob classification');
    assert.equal(glob.matchCount, 50);
    assert.ok(glob.sample.length <= 5);
    assert.ok(!Array.isArray(glob.matches) || glob.matches === undefined || glob.matches.length <= 5);
  });
});

// ---------------------------------------------------------------------------
// Step 3: files-backend resolution compatibility
// ---------------------------------------------------------------------------

describe('review preparation contract - files-backend resolution', () => {
  it('preserves and compares named files artifacts with exact casing', () => {
    assert.equal(normalizeResolutionArtifact('branch:Feature/X', 'files'), 'branch:Feature/X');
    assert.equal(renderResolutionArtifact('branch:Feature/X', 'files'), 'branch:Feature/X');
    const mismatch = validateResolutionMatrix({
      requiredFindingIds: ['F-1'],
      currentArtifact: 'branch:Feature/X',
      backend: 'files',
      entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'implemented and verified the current change', reference: 'branch:feature/x' }],
    });
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.errors.join('\n'), /does not match current artifact/);
  });

  it('renders only already-canonical lowercase GitHub object identities', () => {
    assert.equal(renderResolutionArtifact('commit:' + HEAD.toUpperCase(), 'github'), null);
    assert.equal(renderResolutionArtifact(HEAD, 'github'), `commit:${HEAD}`);
    assert.equal(normalizeResolutionArtifact('range:' + BASE.toUpperCase() + '..' + HEAD, 'files'), null);
  });

  it('rejects uppercase and mixed-format identities at PR snapshot boundaries', () => {
    const input = {
      mode: 'review',
      prData: { number: 42, headRefOid: HEAD, baseRefOid: BASE },
      issueData: { number: 7 },
    };
    assert.throws(
      () => createPrBodySnapshot({ input: { ...input, prData: { ...input.prData, headRefOid: HEAD.toUpperCase() } }, repository: 'owner/repo' }),
      /lowercase full base\/head Git object identities/
    );
    assert.throws(
      () => createPrBodySnapshot({ input: { ...input, prData: { ...input.prData, baseRefOid: 'c'.repeat(64) } }, repository: 'owner/repo' }),
      /one object format/
    );

    const snapshot = createPrBodySnapshot({ input, repository: 'owner/repo', capturedAt: '2026-08-07T10:00:00Z' });
    const uppercaseNested = structuredClone(snapshot);
    uppercaseNested.input.prData.headRefOid = HEAD.toUpperCase();
    const checked = normalizePrBodySnapshot(uppercaseNested);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.map(item => item.message).join('\n'), /nested input prData\.headRefOid must be a full lowercase/);
  });

  it('accepts the files artifact vocabulary', () => {
    assert.ok(normalizeResolutionArtifact('range:' + BASE + '..' + HEAD, 'files'));
    assert.ok(normalizeResolutionArtifact('patch:diff.patch', 'files'));
    assert.ok(normalizeResolutionArtifact('local-diff:HEAD', 'files'));
    assert.equal(normalizeResolutionArtifact('branch:Feature/X', 'github'), null, 'files artifacts must not be accepted by the GitHub projection');
  });

  it('applies legacy prose migration to both backends', () => {
    const gh = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: HEAD, entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: `repaired on ${HEAD} and reran` }] });
    assert.equal(gh.valid, true);
    assert.match(gh.warnings.join('\n'), /migration/i);
    const files = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: 'branch:Feature/X', backend: 'files', entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired on branch:Feature/X and reran' }] });
    assert.equal(files.valid, true);
    assert.match(files.warnings.join('\n'), /migration/i);
  });

  it('matches files legacy artifact citations as complete tokens, never substrings', () => {
    // branch:feat must not be satisfied by prose containing branch:feature.
    const substring = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: 'branch:feat', backend: 'files', entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired on branch:feature and reran' }] });
    assert.equal(substring.valid, false);
    // Named artifacts are case-sensitive and cannot migrate through a differently
    // cased prose token.
    const caseFold = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: 'branch:Feature/X', backend: 'files', entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired on branch:feature/x and reran' }] });
    assert.equal(caseFold.valid, false);
    // A trailing sentence period is safe; a dotted token continuation is not.
    const period = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: 'branch:feat', backend: 'files', entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired on branch:feat. Reran the suite' }] });
    assert.equal(period.valid, true);
    const dotted = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: 'branch:feat', backend: 'files', entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired on branch:feat.x and reran' }] });
    assert.equal(dotted.valid, false);
  });

  it('rejects a present stale or malformed structured reference and never falls back to prose', () => {
    const stale = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: HEAD, entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: `repaired on ${HEAD}`, reference: `commit:${BASE}` }] });
    assert.equal(stale.valid, false);
    const malformed = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: HEAD, entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired and reran verification', reference: 'commit:abc' }] });
    assert.equal(malformed.valid, false);
  });

  it('rejects cross-backend artifact references', () => {
    const cross = validateResolutionMatrix({ requiredFindingIds: ['F-1'], currentArtifact: HEAD, entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'repaired', reference: 'branch:main' }] });
    assert.equal(cross.valid, false);
  });
});

// ---------------------------------------------------------------------------
// Step 4: PR-body scaffold and lint
// ---------------------------------------------------------------------------

describe('review preparation contract - PR-body scaffold and lint', () => {
  const scaffoldInput = () => ({
    prData: { number: 42, headRefOid: HEAD, files: ['src/a.js'] },
    requiredChecks: [{ text: '[RC-1] `npm test`', kind: 'command', command: 'npm test', allowedSources: ['pr_body'] }],
    reviewHistory: { events: [] },
  });

  it('renders a scaffold with all required sections and current-head marker', () => {
    const body = renderPrBodyScaffold({
      prData: { number: 42, headRefOid: HEAD, files: ['src/a.js'] },
      requiredChecks: [{ text: '[RC-1] `npm test`', kind: 'command', command: 'npm test', allowedSources: ['pr_body'] }],
      reviewHistory: { events: [{ type: 'outcome', status: 'needs_revision', findingIds: ['F-1'] }], findingLifecycle: { retiredFindingIds: [], nextFindingId: 'F-2' } },
    });
    assert.match(body, /## Scope Completed/);
    assert.match(body, /## Artifacts/);
    assert.ok(body.includes(`Current implementation artifact: commit:${HEAD}`));
    assert.match(body, /## Evidence/);
    assert.ok(body.includes(`Current PR head: ${HEAD}`));
    assert.match(body, /## Changed Paths/);
    assert.match(body, /## Deviations/);
    assert.match(body, /## Revision Resolution/);
    assert.match(body, /## Prior Review History/);
    // Blank line must precede ## Prior Review History.
    assert.match(body, /\n\n## Prior Review History/);
    assert.match(body, /\[\[agent: engineer\]\]/);
  });

  it('renders the closing reference, attribution expectations, generated provenance, and deviation suggestions', () => {
    const body = renderPrBodyScaffold({
      prData: { number: 42, headRefOid: HEAD, files: ['src/app.js', 'docs/notes.md', 'dist/bundle.js'] },
      issueData: {
        number: 7,
        body: '---\ntask_id: T-007\nallowed_paths: ["src/**"]\ngenerated_paths:\n  "dist/bundle.js":\n    generator: esbuild\n    source: src/app.js\n    verification: parity\n---\n# T',
      },
      requiredChecks: [{ text: '[RC-1] `npm test`', kind: 'command', command: 'npm test', allowedSources: ['pr_body'] }],
      reviewHistory: { events: [] },
    });
    assert.match(body, /Closes #7/);
    assert.match(body, /## Commit Attribution/);
    assert.ok(body.includes('`Task: T-007`'));
    assert.match(body, /## Generated Outputs/);
    assert.match(body, /generator esbuild/);
    // docs/notes.md is outside allowed_paths and not generated: suggested deviation.
    assert.match(body, /## Deviations\n- `docs\/notes\.md`: REPLACE:/);
    // dist/bundle.js is generated: no deviation suggestion.
    assert.ok(!/## Deviations[\s\S]*dist\/bundle\.js/.test(body.split('## Known Gaps')[0]));
  });

  it('never scaffolds a disallowed pr_body source for a status-check-only command check', () => {
    const body = renderPrBodyScaffold({
      prData: { number: 42, headRefOid: HEAD, files: ['src/a.js'] },
      requiredChecks: [{ text: '[RC-1] [sources: status_check] `npm test`', kind: 'command', command: 'npm test', allowedSources: ['status_check'] }],
      reviewHistory: { events: [] },
    });
    // Canonical substitution: the body evidence entry is omitted, never
    // scaffolded with a disallowed pr_body source.
    assert.ok(!body.includes('- Required check:'), body);
    assert.ok(!body.includes('Source: pr_body'), body);
  });

  it('a scaffold containing REPLACE cannot pass lint', () => {
    const body = renderPrBodyScaffold(scaffoldInput());
    const lint = lintPrBody(body);
    assert.equal(lint.scaffolded, true);
    assert.equal(lint.lintReady, false);
    assert.equal(lint.ok, false);
    assert.match(lint.errors.join('\n'), /placeholder/i);
  });

  it('context-free lint still rejects a non-final evidence verdict', () => {
    const body = renderPrBodyScaffold(scaffoldInput())
      .replace(/REPLACE:[^\n]*/g, 'The implementation is complete and all checks pass.');
    const lint = lintPrBody(body);
    assert.equal(lint.lintReady, false);
    assert.match(lint.errors.join('\n'), /not run/);
  });

  it('context-free lint accepts final, substantive evidence', () => {
    const body = renderPrBodyScaffold(scaffoldInput())
      .replace(/REPLACE:[^\n]*/g, 'The implementation is complete and all checks pass.')
      .replace('  Verdict: not run', '  Verdict: passed');
    const lint = lintPrBody(body);
    assert.equal(lint.lintReady, true);
    assert.equal(lint.ok, true);
    assert.equal(lint.scaffolded, true, 'scaffolded records canonical shape, not incompleteness');
  });

  it('rejects an arbitrary two-line body as malformed, not a lintable scaffold', () => {
    const lint = lintPrBody('done stuff\n\nShip it.');
    assert.equal(lint.scaffolded, false);
    assert.equal(lint.lintReady, false);
    assert.match(lint.errors.join('\n'), /## Scope Completed/);
    assert.match(lint.errors.join('\n'), /Current PR head/);
    assert.match(lint.errors.join('\n'), /\[\[agent: engineer\]\]/);
  });

  it('rejects a partially completed scaffold whose verdict is still not run', () => {
    const checks = [{ text: '[RC-1] `npm test`', kind: 'command', command: 'npm test', allowedSources: ['pr_body'], normalized: '[rc-1] npm test', id: 'RC-1', kindDeclared: false, observations: [], observationLevels: {} }];
    const body = renderPrBodyScaffold(scaffoldInput())
      .replace(/REPLACE:[^\n]*/g, 'The implementation is complete and all checks pass.');
    const lint = lintPrBody(body, { requiredChecks: checks, currentHead: HEAD });
    assert.equal(lint.lintReady, false);
    assert.match(lint.errors.join('\n'), /not run/);
  });

  it('accepts a complete body under the full evaluation context', () => {
    const checks = [{ text: '[RC-1] `npm test`', kind: 'command', command: 'npm test', allowedSources: ['pr_body'], normalized: '[rc-1] npm test', id: 'RC-1', kindDeclared: false, observations: [], observationLevels: {} }];
    const body = renderPrBodyScaffold(scaffoldInput())
      .replace(/REPLACE:[^\n]*/g, 'The implementation is complete and all checks pass.')
      .replace('  Verdict: not run', '  Verdict: passed');
    const lint = lintPrBody(body, { requiredChecks: checks, currentHead: HEAD });
    assert.equal(lint.lintReady, true, lint.errors.join('\n'));
    assert.equal(lint.ok, true);
  });

  it('rejects a stale head marker and a missing Engineer attribution', () => {
    const body = renderPrBodyScaffold(scaffoldInput())
      .replace(/REPLACE:[^\n]*/g, 'The implementation is complete and all checks pass.')
      .replaceAll(HEAD, BASE)
      .replace('[[agent: engineer]]', '[[agent: maintainer]]');
    const lint = lintPrBody(body, { currentHead: HEAD });
    assert.equal(lint.lintReady, false);
    assert.match(lint.errors.join('\n'), /exact current-head marker/);
    assert.match(lint.errors.join('\n'), /exact implementation artifact/);
    assert.match(lint.errors.join('\n'), /final Engineer attribution/);
  });

  it('validates current resolution entries against prior findings', () => {
    const body = renderPrBodyScaffold({
      prData: { number: 42, headRefOid: HEAD, files: ['src/a.js'] },
      requiredChecks: [],
      reviewHistory: { events: [{ type: 'outcome', status: 'needs_revision', findingIds: ['F-1'] }] },
    }).replace('REPLACE: substantive description of the current-artifact repair.', 'Repaired the defect on the current head and reran the full verification suite.')
      .replace('REPLACE: concise final-state implementation summary.', 'Implemented the requested repair.');
    const lint = lintPrBody(body, { currentHead: HEAD, priorFindingIds: ['F-1'] });
    assert.equal(lint.lintReady, true, lint.errors.join('\n'));
    const stale = lintPrBody(body.replace(`[ref: commit:${HEAD}]`, `[ref: commit:${BASE}]`), { currentHead: HEAD, priorFindingIds: ['F-1'] });
    assert.equal(stale.lintReady, false);
    assert.match(stale.errors.join('\n'), /does not match current artifact/);
  });
});

// ---------------------------------------------------------------------------
// Step 5: typed proof semantics
// ---------------------------------------------------------------------------

describe('review preparation contract - typed proof semantics', () => {
  const manualCheck = '[RC-1] [kind: manual] [sources: manual_observation] [observations: visible] confirm the page is visible';
  const manualRecord = source =>
    `  Kind: manual\n  Source: ${source}\n  Implementation head: ${HEAD}\n  Verdict: passed\n  Observation: visible\n  Level: running_path\n  Result: the running page rendered the expected content\n  Artifact: ${HEAD}\n  Source: ${source}`;

  it('parses [source:value] and [source: value] identically (regex whitespace fix)', () => {
    const spaced = parseRequiredChecks('## Required Checks\n- [RC-1] [sources: status_check] `npm test`\n')[0];
    const tight = parseRequiredChecks('## Required Checks\n- [RC-1] [sources:status_check] `npm test`\n')[0];
    assert.deepEqual(spaced.allowedSources, ['status_check']);
    assert.deepEqual(tight.allowedSources, ['status_check']);
  });

  it('matches an annotated ID-less check to a natural exact-command evidence label', () => {
    const issueCheck = '`npm test` [Kind: command] [Sources: pr_body]';
    const body = baseBody({ check: '`npm test`' }).replace(
      '  Verdict: passed',
      '  Kind: command\n  Source: pr_body\n  Verdict: passed',
    );
    const result = evaluatePreparationInput(baseInput({ issueCheck, prBody: body }), evaluatePreflight);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.evidenceMatches[0].check, issueCheck);
  });

  it('rejects ambiguous ID-less semantic identities and requires stable ids', () => {
    const issueCheck = [
      '`npm test` [Kind: command] [Sources: pr_body]',
      '- `npm test` [Kind: command] [Sources: pr_body, status_check]',
    ].join('\n');
    const body = baseBody({ check: '`npm test`' }).replace(
      '  Verdict: passed',
      '  Kind: command\n  Source: pr_body\n  Verdict: passed',
    );
    const result = evaluatePreparationInput(baseInput({ issueCheck, prBody: body }), evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /share semantic identity 'npm test'; assign distinct RC-N ids/);
    assert.ok(result.diagnostics.some(item => item.category === 'task_policy' && presentedOwner(item) === 'maintainer'));
  });

  it('validates malformed task contracts before status or PR-body satisfaction', () => {
    const noEvidenceBody = [
      '## Scope Completed', 'Completed.', '',
      '## Artifacts', `Current implementation artifact: commit:${HEAD}`, '',
      '## Evidence', `Current PR head: ${HEAD}`, '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
    ].join('\n');
    const malformedStatusContracts = [
      {
        check: '`npm test` [Kind: banana] [Source: status_check]',
        expected: /invalid proof kind 'banana'/,
      },
      {
        check: '`npm test` [Kind: command] [Sources: status_check|bogus]',
        expected: /invalid satisfaction source \(bogus\)/,
      },
      {
        check: '`npm test` [Kind: manual] [Source: status_check]',
        expected: /status_check satisfaction is allowed only for proof kind 'command'/,
      },
      {
        check: '`npm test` [Kind: command] [Source: status_check] [Observations: output]',
        expected: /status-check-only contract is unsatisfiable/,
      },
    ];

    for (const { check, expected } of malformedStatusContracts) {
      const input = baseInput({ issueCheck: check, prBody: noEvidenceBody });
      input.prData.statusCheckRollup = [{ name: 'npm test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
      const result = evaluatePreparationInput(input, evaluatePreflight);
      assert.equal(result.ok, false, `malformed contract passed: ${check}`);
      assert.match(result.errors.join('\n'), expected);
      assert.equal(result.evidenceMatches.length, 0);
      assert.ok(result.diagnostics.some(item => item.category === 'task_policy' && presentedOwner(item) === 'maintainer'));
    }

    const proseCommand = 'run the suite [Kind: command] [Source: pr_body]';
    const proseBody = baseBody({ check: proseCommand }).replace(
      '  Verdict: passed',
      '  Kind: command\n  Source: pr_body\n  Verdict: passed',
    );
    const proseResult = evaluatePreparationInput(baseInput({ issueCheck: proseCommand, prBody: proseBody }), evaluatePreflight);
    assert.equal(proseResult.ok, false);
    assert.match(proseResult.errors.join('\n'), /command check must declare its exact command in a backtick code span/);

    const lint = lintPrBody(noEvidenceBody, {
      requiredChecks: parseRequiredChecks(malformedStatusContracts[3].check.replace(/^/, '## Required Checks\n- ')),
      currentHead: HEAD,
      statusChecks: [{ name: 'npm test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    assert.ok(lint.diagnostics.some(item => item.category === 'task_policy' && presentedOwner(item) === 'maintainer'));
  });

  it('a stable id cannot substitute a disallowed satisfaction source', () => {
    const invalidBody = baseBody({ check: manualCheck }).replace('  Verdict: passed', manualRecord('automated_observation'));
    const invalid = evaluatePreparationInput(baseInput({ issueCheck: manualCheck, prBody: invalidBody }), evaluatePreflight);
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join('\n'), /satisfaction source|source|observation/i);
    const validBody = baseBody({ check: manualCheck }).replace('  Verdict: passed', manualRecord('manual_observation'));
    const valid = evaluatePreparationInput(baseInput({ issueCheck: manualCheck, prBody: validBody }), evaluatePreflight);
    assert.equal(valid.ok, true, valid.errors.join('\n'));
  });

  it('a command-shaped evidence entry cannot satisfy a legacy manual check', () => {
    // The evidence kind is inferred from the entry's own shape, never from the
    // required check it attempts to satisfy.
    const body = baseBody({ check: '[RC-1] `npm test`' });
    const result = evaluatePreparationInput(baseInput({ issueCheck: '[RC-1] confirm the page is visible', prBody: body }), evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /proof kind 'command' does not match declared 'manual'/);
  });

  it('a manual evidence entry cannot satisfy a command check', () => {
    const body = baseBody({ check: '[RC-1] confirmed manually' });
    const result = evaluatePreparationInput(baseInput({ issueCheck: '[RC-1] `npm test`', prBody: body }), evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /proof kind 'manual' does not match declared 'command'/);
  });

  it('explicit command kind cannot hide a missing command identity', () => {
    const body = [
      '## Scope Completed', 'Completed.', '',
      '## Artifacts', `Current implementation artifact: commit:${HEAD}`, '',
      '## Evidence', `Current PR head: ${HEAD}`, '',
      '- Required check: [RC-1] test suite completed',
      '  Kind: command',
      '  Source: pr_body',
      '  Verdict: passed',
      '  Evidence: 2356 tests passed with exit status zero.', '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
    ].join('\n');
    const check = '[RC-1] [kind: command] [sources: pr_body] `npm test`';
    const result = evaluatePreparationInput(baseInput({ issueCheck: check, prBody: body }), evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /must record the exact declared command 'npm test'/);
  });

  it('a successful status check cannot substitute declared observation records', () => {
    const check = '`npm test` [Observations: parser rejects stale ref|matrix binds ids]';
    const input = baseInput({ issueCheck: check });
    input.prData.body = [
      '## Scope Completed', 'Completed.', '',
      '## Artifacts', `Current implementation artifact: commit:${HEAD}`, '',
      '## Evidence', `Current PR head: ${HEAD}`, '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
    ].join('\n');
    input.prData.statusCheckRollup = [{ name: 'npm test', conclusion: 'SUCCESS' }];
    const result = evaluatePreparationInput(input, evaluatePreflight);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /declared observations require explicit structured PR-body evidence/);
  });

  it('status-check substitution is permitted only for an allowed command check', () => {
    const commandCheck = '[RC-1] [kind: command] [sources: pr_body, status_check] `npm test`';
    // Command check with no PR-body evidence entry but a passing status check rollup
    // is accepted via status-check substitution.
    const noEvidenceBody = [
      '## Scope Completed', 'Completed.', '',
      '## Artifacts', `Current implementation artifact: commit:${HEAD}`, '',
      '## Evidence', `Current PR head: ${HEAD}`, '',
      '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.',
    ].join('\n');
    const commandInput = baseInput({ issueCheck: commandCheck, prBody: noEvidenceBody });
    commandInput.prData.statusCheckRollup = [{ name: 'npm test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    const commandResult = evaluatePreparationInput(commandInput, evaluatePreflight);
    assert.equal(commandResult.ok, true, commandResult.errors.join('\n'));
    // Manual check cannot be satisfied by a generic status check.
    const manualBody = baseBody({ check: manualCheck }).replace('  Verdict: passed',
      '  Kind: manual\n  Source: status_check\n  Implementation head: ' + HEAD + '\n  Verdict: passed\n  Observation: visible\n  Level: running_path\n  Result: the running page rendered the expected content\n  Artifact: ' + HEAD + '\n  Source: status_check');
    const manualResult = evaluatePreparationInput(baseInput({ issueCheck: manualCheck, prBody: manualBody }), evaluatePreflight);
    assert.equal(manualResult.ok, false);
  });

  const contractCheck = '[RC-1] [kind: contract_proof] [observations: seed-set, failure-set, inspector] exercise the contract';
  const contractRecord = (observations, { result = 'the running contract path produced the declared state transitions' } = {}) =>
    '  Kind: contract_proof\n  Source: automated_observation\n  Implementation head: ' + HEAD + '\n  Verdict: passed' +
    observations.map(name =>
      `\n  Observation: ${name}\n  Level: running_path\n  Result: ${result}\n  Artifact: ${HEAD}\n  Source: automated_observation`
    ).join('');

  it('a declared contract_proof with no source allows automated observation covering every declared observation', () => {
    const body = baseBody({ check: contractCheck }).replace('  Verdict: passed',
      contractRecord(['seed-set', 'failure-set', 'inspector']));
    const result = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: body }), evaluatePreflight);
    assert.equal(result.ok, true, result.errors.join('\n'));
    // Missing one declared observation -> fails.
    const partial = baseBody({ check: contractCheck }).replace('  Verdict: passed',
      contractRecord(['seed-set', 'inspector']));
    const partialResult = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: partial }), evaluatePreflight);
    assert.equal(partialResult.ok, false);
    assert.match(partialResult.errors.join('\n'), /missing a structured record for declared observation 'failure-set'/);
  });

  it('rejects copied observation names and generic pass counts as contract proof', () => {
    // Legacy name list plus a generic pass count: no structured records.
    const namesOnly = baseBody({ check: contractCheck }).replace('  Verdict: passed',
      '  Kind: contract_proof\n  Source: automated_observation\n  Observations: seed-set, failure-set, inspector\n  Implementation head: ' + HEAD + '\n  Verdict: passed\n  Evidence: 1 test passed.');
    const namesResult = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: namesOnly }), evaluatePreflight);
    assert.equal(namesResult.ok, false);
    assert.match(namesResult.errors.join('\n'), /missing a structured record for declared observation/);
    // Generic pass count inside a structured record is still not evidence.
    const generic = baseBody({ check: contractCheck }).replace('  Verdict: passed',
      contractRecord(['seed-set', 'failure-set', 'inspector'], { result: '1 test passed' }));
    const genericResult = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: generic }), evaluatePreflight);
    assert.equal(genericResult.ok, false);
    assert.match(genericResult.errors.join('\n'), /not substantive/);
  });

  it('rejects helper, mock, parser, and unit-only results when running-path evidence is required', () => {
    for (const level of ['helper', 'mock', 'parser', 'unit']) {
      const body = baseBody({ check: contractCheck }).replace('  Verdict: passed',
        '  Kind: contract_proof\n  Source: automated_observation\n  Implementation head: ' + HEAD + '\n  Verdict: passed' +
        ['seed-set', 'failure-set', 'inspector'].map(name =>
          `\n  Observation: ${name}\n  Level: ${level}\n  Result: exercised only the ${level}-bound state without the running path\n  Artifact: ${HEAD}\n  Source: automated_observation`
        ).join(''));
      const result = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: body }), evaluatePreflight);
      assert.equal(result.ok, false, `level ${level} must fail`);
      assert.match(result.errors.join('\n'), new RegExp(`records '${level}' evidence but the task requires 'running_path'`));
    }
  });

  it('honors a task-declared oracle level for a specific observation', () => {
    const unitCheck = '[RC-1] [kind: contract_proof] [observations: seed-set@unit, inspector] exercise the contract';
    const body = baseBody({ check: unitCheck }).replace('  Verdict: passed',
      '  Kind: contract_proof\n  Source: automated_observation\n  Implementation head: ' + HEAD + '\n  Verdict: passed' +
      `\n  Observation: seed-set\n  Level: unit\n  Result: the pinned unit oracle reproduced the seed contract state\n  Artifact: ${HEAD}\n  Source: automated_observation` +
      `\n  Observation: inspector\n  Level: running_path\n  Result: the running inspector rendered every seeded record\n  Artifact: ${HEAD}\n  Source: automated_observation`);
    const result = evaluatePreparationInput(baseInput({ issueCheck: unitCheck, prBody: body }), evaluatePreflight);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects stale artifact evidence and source-mismatched observation records', () => {
    const stale = baseBody({ check: contractCheck }).replace('  Verdict: passed',
      contractRecord(['seed-set', 'failure-set', 'inspector']).replaceAll(`Artifact: ${HEAD}`, `Artifact: ${BASE}`));
    const staleResult = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: stale }), evaluatePreflight);
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.errors.join('\n'), /stale artifact evidence/);
    const mismatched = baseBody({ check: contractCheck }).replace('  Verdict: passed',
      contractRecord(['seed-set', 'failure-set', 'inspector']).replaceAll(`Artifact: ${HEAD}\n  Source: automated_observation`, `Artifact: ${HEAD}\n  Source: manual_observation`));
    const mismatchedResult = evaluatePreparationInput(baseInput({ issueCheck: contractCheck, prBody: mismatched }), evaluatePreflight);
    assert.equal(mismatchedResult.ok, false);
    assert.match(mismatchedResult.errors.join('\n'), /does not match the evidence satisfaction source/);
  });
});

// ---------------------------------------------------------------------------
// Step 6: finding-ID lifecycle and no-progress binding
// ---------------------------------------------------------------------------

describe('review preparation contract - finding lifecycle', () => {
  it('processes finding IDs numerically within an ordered event', () => {
    const result = validateFindingIdLifecycle([
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-2', 'F-1'], sourceOrder: 0 },
    ]);
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(result.activeFindingIds, ['F-1', 'F-2']);
  });

  it('rejects an allocation gap', () => {
    const result = validateFindingIdLifecycle([
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1', 'F-3'], sourceOrder: 0 },
    ]);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /F-3.*F-2/);
  });

  it('retires an omitted id permanently and rejects its reuse', () => {
    const result = validateFindingIdLifecycle([
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1', 'F-2'], sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-2'], sourceOrder: 1 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1', 'F-2'], sourceOrder: 2 },
    ]);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /retired finding id 'F-1'/);
  });

  it('allows a legacy missing-findings outcome to establish the typed baseline', () => {
    const result = validateFindingIdLifecycle([
      { type: 'outcome', status: 'needs_revision', findingIds: [], legacyMissingFindingIds: true, sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 1 },
    ]);
    assert.equal(result.valid, true, result.errors.join('\n'));
  });

  it('requires a no-progress disposition to bind the exact sustained finding ids', () => {
    const history = [
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 1 },
    ];
    // Disposition binds the wrong id -> not authorized.
    const wrong = evaluateNoProgress({ reviewHistory: [...history, { type: 'no_progress', disposition: 'targeted_revision', target: 'x', sustainedFindingIds: ['F-2'], sourceOrder: 2 }] });
    assert.equal(wrong.authorized, false);
    // Disposition binds the exact sustained id -> authorized.
    const right = evaluateNoProgress({ reviewHistory: [...history, { type: 'no_progress', disposition: 'targeted_revision', target: 'x', sustainedFindingIds: ['F-1'], sourceOrder: 2 }] });
    assert.equal(right.authorized, true);
    // No binding -> rejected.
    const unbound = evaluateNoProgress({ reviewHistory: [...history, { type: 'no_progress', disposition: 'targeted_revision', target: 'x', sustainedFindingIds: [], sourceOrder: 2 }] });
    assert.equal(unbound.authorized, false);
  });

  it('round-trips a no-progress carrier that carries sustained finding ids', () => {
    const rendered = formatNoProgressDisposition({ disposition: 'targeted_revision', target: 'replace proof', sustainedFindingIds: ['F-1'], orchestratorAttribution: 'loop-bot' }, { carrier: 'github' });
    const parsed = parseNoProgressDisposition(rendered, { carrier: 'github' });
    assert.deepEqual(parsed.event.sustainedFindingIds, ['F-1']);
  });

  it('triggers no-progress only for consecutive implementation-changing outcomes', () => {
    const outcome = (sourceOrder, extra = {}) => ({ type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder, ...extra });
    // Two record-only corrections sustaining the same ID never trigger.
    const recordOnly = [outcome(0, { classification: 'record_only' }), outcome(1, { classification: 'record_only' })];
    assert.equal(evaluateNoProgress({ reviewHistory: recordOnly }).required, false);
    // Mixed: only one implementation-changing outcome exists.
    const mixed = [outcome(0, { classification: 'record_only' }), outcome(1)];
    assert.equal(evaluateNoProgress({ reviewHistory: mixed }).required, false);
    // Two implementation-changing outcomes sustaining F-1 trigger.
    const sustained = [outcome(0), outcome(1)];
    assert.equal(evaluateNoProgress({ reviewHistory: sustained }).required, true);
    // Legacy unclassified outcomes default to implementation_changing.
    const legacy = [outcome(0, { classification: null }), outcome(1, { classification: null })];
    assert.equal(evaluateNoProgress({ reviewHistory: legacy }).required, true);
  });

  it('excludes stale, withdrawn, retired, and new-only finding sets', () => {
    // Stale (legacy missing-findings) reviews never count.
    const stale = [
      { type: 'outcome', status: 'needs_revision', findingIds: [], legacyMissingFindingIds: true, sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 1 },
    ];
    assert.equal(evaluateNoProgress({ reviewHistory: stale }).required, false);
    // Withdrawn findings are absent from the latest outcome and cannot sustain.
    const withdrawn = [
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1', 'F-2'], sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-2'], sourceOrder: 1 },
    ];
    const withdrawnResult = evaluateNoProgress({ reviewHistory: withdrawn });
    assert.equal(withdrawnResult.required, true);
    assert.deepEqual(withdrawnResult.sustainedFindingIds, ['F-2']);
    // New-only finding sets never trigger.
    const newOnly = [
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-2'], sourceOrder: 1 },
    ];
    assert.equal(evaluateNoProgress({ reviewHistory: newOnly }).required, false);
    // An accepted latest outcome breaks the consecutive needs_revision chain.
    const accepted = [
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 0 },
      { type: 'outcome', status: 'accepted', findingIds: [], sourceOrder: 1 },
    ];
    assert.equal(evaluateNoProgress({ reviewHistory: accepted }).required, false);
  });

  it('parses and preserves revision classification on both backends', async () => {
    const { parseReviewMarker, parseFilesReviewHistory, parseRevisionClassification } = await import('../src/review-history.js');
    const marker = parseReviewMarker([
      'AGENT_REVIEW_STATUS: needs_revision',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${HEAD}`,
      'AGENT_REVIEW_FINDINGS: F-1',
      'AGENT_REVIEW_CLASSIFICATION: record_only',
      '[[agent: maintainer]]',
    ].join('\n'));
    assert.equal(marker.classification, 'record_only');
    assert.deepEqual(marker.errors, []);
    const invalid = parseReviewMarker([
      'AGENT_REVIEW_STATUS: needs_revision',
      'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${HEAD}`,
      'AGENT_REVIEW_FINDINGS: F-1',
      'AGENT_REVIEW_CLASSIFICATION: cosmetic',
      '[[agent: maintainer]]',
    ].join('\n'));
    assert.ok(invalid.errors.some(error => /classification/i.test(error)));
    assert.equal(parseRevisionClassification('').classification, null);
    const files = parseFilesReviewHistory([
      '## Review History', '',
      '### Review 1', '',
      '- Status: needs_revision', '- Mode: host_subagent', '- Artifact: branch:feat/x',
      '- Maintainer: maintainer', '- Findings: F-1', '- Classification: record_only',
    ].join('\n'));
    assert.deepEqual(files.errors, []);
    assert.equal(files.events[0].classification, 'record_only');
  });

  it('documents and tests the first typed-ID migration policy after legacy history', () => {
    // Policy: a legacy needs_revision review whose findings field is missing
    // (accepted only for an old artifact) establishes no IDs. The first typed
    // needs_revision outcome after it allocates IDs from F-1 and forms the
    // typed baseline; legacy reviews never carry or sustain IDs.
    const result = validateFindingIdLifecycle([
      { type: 'outcome', status: 'needs_revision', findingIds: [], legacyMissingFindingIds: true, sourceOrder: 0 },
      { type: 'outcome', status: 'needs_revision', findingIds: ['F-1'], sourceOrder: 1 },
    ]);
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(result.activeFindingIds, ['F-1']);
    assert.equal(result.nextFindingId, 'F-2');
  });
});

// ---------------------------------------------------------------------------
// Step 7: checkpoint repair matrix
// ---------------------------------------------------------------------------

describe('review preparation contract - checkpoint repair matrix', () => {
  const HEAD_LOCAL = HEAD;
  function candidate({ author = 'loop-bot', source = '100', artifact = HEAD_LOCAL } = {}) {
    return {
      type: 'checkpoint_candidate', sourceOrder: 1, sourceReference: source, sourceKind: 'comment', author: { login: author },
      errors: ['checkpoint is missing required field "orchestrator"'],
      checkpoint: {
        direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1,
        artifact, target: 'repair F-1', orchestratorAttribution: null,
        roleId: 'orchestrator', roleCarrierSchemaVersion: 1, carrier: 'github',
      },
    };
  }
  function repair({ author = 'loop-bot', source = '101', originalAuthor = 'loop-bot', ref = '100', checkpoint } = {}) {
    return {
      type: 'checkpoint_repair', sourceOrder: 2, sourceReference: source, source: ref, originalAuthor, correctedFields: ['actor_account'], author: { login: author },
      checkpoint: checkpoint ?? {
        direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1,
        artifact: HEAD_LOCAL, target: 'repair F-1', orchestratorAttribution: 'loop-bot',
        roleId: 'orchestrator', roleCarrierSchemaVersion: 1, carrier: 'github',
      },
    };
  }
  const prior = { type: 'outcome', status: 'needs_revision', artifact: HEAD_LOCAL, sourceOrder: 0 };

  it('applies one same-author repair and excludes the repair from selection', () => {
    const result = applyCheckpointRepairs([prior, candidate(), repair()]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.events.filter(e => e.type === 'checkpoint').length, 1);
    assert.equal(result.events.filter(e => e.type === 'checkpoint_repair').length, 1);
  });

  it('rejects a cross-author repair', () => {
    const result = applyCheckpointRepairs([prior, candidate(), repair({ author: 'other-bot', originalAuthor: 'other-bot' })]);
    assert.ok(result.errors.some(e => /authenticated Orchestrator/i.test(e)), result.errors.join('\n'));
  });

  it('rejects a repair of an already valid carrier', () => {
    const valid = { ...candidate(), errors: [] };
    const result = applyCheckpointRepairs([prior, valid, repair()]);
    assert.ok(result.errors.some(e => /already valid/i.test(e)), result.errors.join('\n'));
  });

  it('rejects a second repair of the same source', () => {
    const result = applyCheckpointRepairs([prior, candidate(), repair({ source: '101' }), repair({ source: '102' })]);
    assert.ok(result.errors.some(e => /second repair/i.test(e)), result.errors.join('\n'));
  });

  it('rejects a repair whose source changes the bound artifact', () => {
    const result = applyCheckpointRepairs([prior, candidate(), repair({ checkpoint: { direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1, artifact: BASE, target: 'repair F-1', orchestratorAttribution: 'loop-bot', carrier: 'github' } })]);
    assert.ok(result.errors.some(e => /artifact|review_count|authority/i.test(e)), result.errors.join('\n'));
  });

  it('rejects a repair after the source was consumed by a review outcome', () => {
    const consumed = { type: 'outcome', status: 'needs_revision', artifact: HEAD_LOCAL, sourceOrder: 3, sourceReference: 'r3' };
    const result = applyCheckpointRepairs([prior, candidate(), consumed, repair({ source: '101' })]);
    assert.ok(result.errors.some(e => /consumed/i.test(e)), result.errors.join('\n'));
  });

  it('rejects a repair naming no malformed checkpoint source', () => {
    const result = applyCheckpointRepairs([prior, repair({ source: '101', ref: 'does-not-exist' })]);
    assert.ok(result.errors.some(e => /names no malformed checkpoint source/i.test(e)), result.errors.join('\n'));
  });

  it('rejects authority-bearing direction, target, and review_count changes', () => {
    const directionChange = applyCheckpointRepairs([prior, candidate(), repair({ checkpoint: { direction: 'needs_context', cause: 'implementation_defect', reviewCount: 1, artifact: HEAD_LOCAL, target: 'repair F-1', reference: 'issue 9', orchestratorAttribution: 'loop-bot', carrier: 'github' } })]);
    assert.ok(directionChange.errors.some(e => /authority-bearing field 'direction'/i.test(e)), directionChange.errors.join('\n'));
    const countChange = applyCheckpointRepairs([prior, candidate({ source: '100' }), repair({ checkpoint: { direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 4, artifact: HEAD_LOCAL, target: 'repair F-1', orchestratorAttribution: 'loop-bot', carrier: 'github' } })]);
    assert.ok(countChange.errors.some(e => /review_count/i.test(e)), countChange.errors.join('\n'));
  });

  it('is pure: repair application never mutates the caller-owned events', () => {
    const sourceCandidate = candidate();
    const repairEvent = repair();
    const input = [prior, sourceCandidate, repairEvent];
    const snapshot = JSON.parse(JSON.stringify(input));
    const result = applyCheckpointRepairs(input);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(input, snapshot, 'caller-owned events must not be mutated');
    assert.ok(!Object.hasOwn(sourceCandidate, 'repaired'), 'no repaired property may be added to the source');
    assert.ok(!result.events.includes(sourceCandidate), 'the returned array replaces the candidate with a clone');
  });

  it('treats wrong authenticated GitHub attribution as a repairable candidate', async () => {
    const { collectGitHubReviewHistory } = await import('../src/review-history.js');
    const outcomeBody = [
      'AGENT_REVIEW_STATUS: needs_revision', 'AGENT_REVIEW_MODE: host_subagent',
      `AGENT_REVIEW_ARTIFACT: ${HEAD_LOCAL}`, 'AGENT_REVIEW_FINDINGS: F-1', '[[agent: maintainer]]',
    ].join('\n');
    const checkpointBody = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->', '', '## Review Round Checkpoint', '',
      '- Direction: targeted_revision', '- Cause: implementation_defect', '- Review count: 1',
      `- Artifact: ${HEAD_LOCAL}`, '- Target: repair F-1', '- Orchestrator: wrong-login', '',
      '[[agent: orchestrator]]',
    ].join('\n');
    const repairBody = formatCheckpointRepair({
      source: '100', originalAuthor: 'loop-bot', reason: 'correct the attribution to the authenticated author',
      correctedFields: ['actor_account', 'review_role_carrier'],
      checkpoint: { direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1, artifact: HEAD_LOCAL, target: 'repair F-1', orchestratorAttribution: 'loop-bot', carrier: 'github' },
    });
    const mk = (id, body, time) => ({ id, html_url: `https://example.invalid/c/${id}`, created_at: time, body, user: { login: 'loop-bot', type: 'User' } });
    const prData = {
      headRefOid: HEAD_LOCAL,
      comments: [mk(1, outcomeBody, '2026-07-25T10:00:00Z'), mk(100, checkpointBody, '2026-07-25T11:00:00Z'), mk(101, repairBody, '2026-07-25T12:00:00Z')],
      reviews: [],
    };
    const repaired = collectGitHubReviewHistory(prData, { login: 'loop-bot', type: 'User' });
    assert.deepEqual(repaired.errors, [], repaired.errors.join('\n'));
    assert.equal(repaired.events.filter(event => event.type === 'checkpoint').length, 1);
    // Without the repair the wrong attribution remains fatal.
    const unrepaired = collectGitHubReviewHistory({ ...prData, comments: prData.comments.slice(0, 2) }, { login: 'loop-bot', type: 'User' });
    assert.ok(unrepaired.errors.some(error => /does not match its authenticated author/i.test(error)), unrepaired.errors.join('\n'));
  });

  it('rejects a legacy files role token mismatch and allows a bounded trusted-role repair', async () => {
    const { parseFilesReviewHistory } = await import('../src/review-history.js');
    const history = (checkpointLines, extra = []) => [
      '## Review History', '',
      '### Review 1', '',
      '- Status: needs_revision', '- Mode: host_subagent', `- Artifact: branch:feat/x`, '- Maintainer: maintainer', '- Findings: F-1', '',
      '### Review Round Checkpoint', '',
      ...checkpointLines, '',
      ...extra,
    ].join('\n');
    const wrongRole = history([
      '- Direction: targeted_revision', '- Cause: implementation_defect', '- Review count: 1',
      '- Artifact: branch:feat/x', '- Target: repair F-1', '- Orchestrator: wrong-role',
    ]);
    const unrepaired = parseFilesReviewHistory(wrongRole);
    assert.ok(unrepaired.errors.some(error => /legacy orchestrator value/i.test(error)), unrepaired.errors.join('\n'));
    const repairedHistory = history([
      '- Direction: targeted_revision', '- Cause: implementation_defect', '- Review count: 1',
      '- Artifact: branch:feat/x', '- Target: repair F-1', '- Orchestrator: wrong-role',
    ], [
      '### Review Round Checkpoint Repair', '',
      '- Source: review-history:2', '- Original author: orchestrator', '- Reason: correct the trusted-role attribution',
      '- Corrected fields: actor_account, role_id',
      '- Direction: targeted_revision', '- Cause: implementation_defect', '- Review count: 1',
      '- Artifact: branch:feat/x', '- Target: repair F-1', '- Orchestrator: orchestrator',
    ]);
    const repaired = parseFilesReviewHistory(repairedHistory);
    assert.deepEqual(repaired.errors, [], repaired.errors.join('\n'));
    assert.equal(repaired.events.filter(event => event.type === 'checkpoint').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Step 8: commit attribution
// ---------------------------------------------------------------------------

describe('review preparation contract - commit attribution', () => {
  it('detects duplicate, missing, stale-task, and wrong-role trailers', () => {
    const dup = evaluateCommitAttribution({ message: 'subject\n\nTask: T-1\nAgent: engineer\nTask: T-1', taskId: 'T-1' });
    assert.ok(dup.errors.some(e => /duplicate/i.test(e)));
    const missing = evaluateCommitAttribution({ message: 'subject', taskId: 'T-1' });
    assert.equal(missing.ok, false);
    const stale = evaluateCommitAttribution({ message: 'subject\n\nTask: T-OLD\nAgent: engineer', taskId: 'T-1' });
    assert.ok(stale.errors.some(e => /stale/i.test(e)));
    const wrongRole = evaluateCommitAttribution({ message: 'subject\n\nTask: T-1\nAgent: orchestrator', taskId: 'T-1' });
    assert.ok(wrongRole.errors.some(e => /wrong Agent/i.test(e)));
  });

  it('never amends a commit; the repair plan is canonical replace/remove guidance', () => {
    const result = evaluateCommitAttribution({ message: 'subject\n\nTask: OLD\nAgent: maintainer\nTask: OLD', taskId: 'T-1' });
    assert.ok(result.repairPlan);
    assert.match(result.repairPlan, /Task: T-1/);
    assert.match(result.repairPlan, /Agent: engineer/);
    assert.ok(!/git commit --amend|git push|--force/i.test(result.repairPlan));
  });

  it('accepts a correct single final trailer pair', () => {
    const result = evaluateCommitAttribution({ message: 'subject\n\nTask: T-1\nAgent: engineer', taskId: 'T-1' });
    assert.equal(result.ok, true);
    assert.equal(result.repairPlan, null);
  });

  it('does not scan arbitrary prose as trailers', () => {
    // A Task: mention inside prose must not be treated as an authoritative trailer.
    const prose = 'subject\n\nExplained why Task: OLD is irrelevant in the body.\n\nFixes the bug.';
    const result = evaluateCommitAttribution({ message: prose, taskId: 'T-1' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => /trailer/i.test(e)));
    assert.ok(!result.errors.some(e => /stale Task 'OLD'/i.test(e)), 'prose must not be parsed as a stale trailer');
  });

  it('local and live attribution share one parser with identical verdicts over the same corpus', async () => {
    const { validateAttribution } = await import('../src/github-preflight.js');
    const prBody = '## Scope Completed\nDone.\n\n[[agent: engineer]]';
    const issueData = { number: 7, body: '---\ntask_id: T-1\n---\n# T' };
    const corpus = [
      ['valid final trailer pair', 'subject\n\nTask: T-1\nAgent: engineer', true],
      ['missing blank separator', 'subject\nTask: T-1\nAgent: engineer', true],
      ['duplicate Task trailer', 'subject\n\nTask: T-1\nAgent: engineer\nTask: T-1', false],
      ['stale task', 'subject\n\nTask: T-OLD\nAgent: engineer', false],
      ['wrong role', 'subject\n\nTask: T-1\nAgent: maintainer', false],
      ['misplaced trailer', 'subject\n\nTask: T-1\n\nAgent: engineer', false],
      ['prose containing Task:/Agent:', 'subject\n\nExplained why Task: OLD is irrelevant.\n\nFixes the bug.', false],
      ['standard Git trailers mixed into the block', 'subject\n\nTask: T-1\nCo-authored-by: A <a@b.c>\nSigned-off-by: B <b@c.d>\nAgent: engineer', true],
      ['fenced trailer example is not live', 'subject\n\n```\nTask: T-1\nAgent: engineer\n```', false],
    ];
    for (const [label, message, expectedOk] of corpus) {
      const local = evaluateCommitAttribution({ message, taskId: 'T-1' });
      const live = validateAttribution(prBody, message, issueData);
      assert.equal(local.ok, expectedOk, `local verdict for ${label}: ${local.errors.join('; ')}`);
      assert.equal(live.errors.length === 0, expectedOk, `live verdict for ${label}: ${live.errors.join('; ')}`);
      assert.equal(local.ok, live.errors.length === 0, `local/live parity for ${label}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 7 & 9: checkpoint state, repair parse/format round-trip, packet validation
// ---------------------------------------------------------------------------

describe('review preparation contract - checkpoint state and packet freshness', () => {
  it('derives absent/rendered/authorizes/consumed/invalid states from ordered history', () => {
    assert.equal(deriveCheckpointState([], []).state, 'absent');
    const proposed = { direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1, artifact: HEAD, target: 'repair F-1', orchestratorAttribution: 'loop-bot' };
    const rendered = deriveCheckpointState([], [], { proposed });
    assert.equal(rendered.state, 'rendered');
    assert.equal(rendered.authorizes, false);
    assert.equal(rendered.candidate, proposed);
    const outcome = { type: 'outcome', status: 'needs_revision', artifact: HEAD, sourceReference: 'r1', sourceOrder: 0 };
    const cp = { type: 'checkpoint', sourceReference: 'c1', sourceOrder: 1, artifact: HEAD, reviewCount: 1, direction: 'targeted_revision', target: 'repair F-1' };
    const authorizing = deriveCheckpointState([outcome, cp], []);
    assert.equal(authorizing.state, 'authorizes_revision');
    assert.equal(authorizing.authorizes, true);
    assert.equal(authorizing.source, 'c1');
    assert.equal(authorizing.fromArtifact, HEAD);
    assert.equal(authorizing.fromReview, 'r1');
    assert.equal(authorizing.direction, 'targeted_revision');
    assert.equal(authorizing.target, 'repair F-1');
    assert.equal(authorizing.reviewCount, 1);
    const consumedOutcome = { type: 'outcome', status: 'needs_revision', sourceReference: 'r2', sourceOrder: 2 };
    const consumed = deriveCheckpointState([outcome, cp, consumedOutcome], []);
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.checkpoint, 'c1');
    assert.equal(consumed.consumedBy, 'r2');
    assert.equal(consumed.consumingOutcome, 'r2');
    assert.equal(deriveCheckpointState([cp], ['history error']).state, 'invalid');
  });

  it('round-trips a checkpoint repair carrier', () => {
    const repair = {
    source: '100', originalAuthor: 'loop-bot', reason: 'fill mechanically derivable fields',
      correctedFields: ['orchestrator'],
      checkpoint: { direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1, artifact: HEAD, target: 'repair F-1', orchestratorAttribution: 'loop-bot', carrier: 'github' },
    };
    const rendered = formatCheckpointRepair(repair, { carrier: 'github' });
    const parsed = parseCheckpointRepair(rendered, { carrier: 'github' });
    assert.equal(parsed.found, true);
    assert.equal(parsed.repair.source, '100');
    assert.equal(parsed.repair.originalAuthor, 'loop-bot');
  });

  it('validateReviewPacket rejects stale, malformed, and mismatched packets', () => {
    const stale = validateReviewPacket(reviewPacket(), BASE, { expectedPr: 42 });
    assert.equal(stale.valid, false);
    assert.equal(stale.stale, true);
    const fresh = validateReviewPacket(reviewPacket(), HEAD, { expectedPr: 42 });
    assert.equal(fresh.valid, true);
    assert.equal(fresh.stale, false);
    assert.equal(validateReviewPacket({ headRefOid: HEAD }, HEAD, { expectedPr: 42 }).valid, false);
    assert.match(validateReviewPacket(reviewPacket({ pr: 99 }), HEAD, { expectedPr: 42 }).reason, /does not match requested PR/);
    assert.match(validateReviewPacket(reviewPacket({ type: 'unrelated' }), HEAD, { expectedPr: 42 }).reason, /packet type/);
    assert.match(
      validateReviewPacket(reviewPacket({ preflight: { ok: true, digest: { requiredChecks: 1, evidenceMatches: 1, headRefOid: BASE } } }), HEAD, { expectedPr: 42 }).reason,
      /digest headRefOid/,
    );
    assert.equal(validateReviewPacket(reviewPacket(), '').valid, false);
  });
});

// ---------------------------------------------------------------------------
// Step 8: runGitHubReviewPrepare and mechanical stale-packet rejection
// ---------------------------------------------------------------------------

describe('review preparation contract - review preparation and packet freshness', () => {
  const OTHER = 'c'.repeat(40);
  const PREP_ISSUE = '---\ntask_id: T-007\n---\n# T\n\n## Required Checks\n- [RC-1] `npm test`\n';
  const prepBody = [
    '## Scope Completed', 'Completed.', '',
    '## Artifacts', `Current implementation artifact: commit:${HEAD}`, '',
    '## Evidence', `Current PR head: ${HEAD}`, '',
    '- Required check: [RC-1] `npm test`', '  Verdict: passed', '  Evidence: tests passed (exit 0)', '',
    '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.', '',
    '[[agent: engineer]]',
  ].join('\n');

  function prepareRunner({ prBody = prepBody, issueBody = PREP_ISSUE, refetchHead = HEAD } = {}) {
    const prData = {
      number: 42, body: prBody, headRefOid: HEAD, baseRefOid: BASE,
      closingIssuesReferences: [{ number: 7 }], statusCheckRollup: [],
      commits: [{ oid: HEAD, message: 'impl\n\nTask: T-007\nAgent: engineer' }],
    };
    const issueData = { number: 7, body: issueBody, title: 'T' };
    return (command, args) => {
      if (args[0] === 'pr') {
        const fields = args[args.indexOf('--json') + 1] ?? '';
        if (fields === 'headRefOid') return { status: 0, stdout: JSON.stringify({ headRefOid: refetchHead }), stderr: '' };
        return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      }
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop-bot', type: 'User' }), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  const verifyContext = { projectFacts: [], decisionExists: () => false, taskExists: () => false };

  it('emits and verifies a review packet through the complete public return chain', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'review-public-chain-'));
    try {
      const fixture = await createDispatchFixture(temporary, 'dispatch', { taskIds: ['T-007'] });
      const taskBody = fixture.snapshot().body;
      const taskDigest = fixture.snapshot().digest;
      const dispatchHead = fixture.repository().head;
      const contract = taskContractDigest(taskBody);
      const baselineText = renderTaskContractRecord(createTaskContractBaselineRecord({
        recordId: 'task-contract-record:00000000-0000-4000-8000-000000000007',
        taskId: 'T-007', digest: contract.digest, projection: contract.projection,
        authority: 'policy:T-007', actor: 'maintainer',
        timestamp: new Date().toISOString(), affectedArtifact: 'issue:7',
      }));
      const baselineComment = {
        id: 7, html_url: 'https://example.test/issues/7#issuecomment-7',
        user: { login: 'maintainer' }, author_association: 'MEMBER',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        body: baselineText,
      };
      const snapshot = () => ({
        ...fixture.snapshot(), backend: 'github', carrier: 'issue:7', body: taskBody,
        digest: taskDigest,
      });
      const readiness = {
        ...fixture.readiness,
        evidence: createTaskReadinessEvidence({
          ...fixture.readiness.evidence,
          backend: 'github', task: { id: 'T-007', carrier: 'issue:7', expectedDigest: taskDigest },
        }),
      };
      const prepared = prepare({
        ...fixture, refetchTask: snapshot, readiness, refetchReadiness: () => readiness,
        assignment: {
          ...fixture.assignment,
          canonicalReferences: ['agents/engineer.md', 'skills/role-delegation/SKILL.md', 'backends/github.md'],
        },
      });
      assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
      const packet = prepared.packet;
      const recognition = recognizeHandoff({
        transition: 'role_start',
        expectation: {
          backend: 'github', taskId: 'T-007', roleId: 'engineer',
          taskContractDigest: packet.task.contractDigest, carrierDigest: packet.task.digest,
          packetId: packet.packetId, packetDigest: packet.digest,
          workUnitIdentity: packet.decomposition.workUnitId, artifactHead: dispatchHead,
          worktreeRoot: packet.repository.worktree, minimumActivationAssurance: 'operator_confirmed',
        },
        preparedDispatch: packet,
        validatePreparedDispatch: fixtureDispatchValidator(fixture),
      });
      assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
      const consumption = createDispatchConsumption({ backend: 'github', taskId: 'T-007', recognition });
      const consumptionPath = join(fixture.root, dispatchConsumptionRelativePath(consumption));
      mkdirSync(join(consumptionPath, '..'), { recursive: true });
      writeFileSync(consumptionPath, `${JSON.stringify(consumption, null, 2)}\n`, 'utf8');

      writeFileSync(join(fixture.root, 'src', 'existing.js'), 'export const current = "review-ready";\n', 'utf8');
      git(fixture.root, ['add', 'src/existing.js']);
      git(fixture.root, ['commit', '-m', 'review-ready implementation\n\nTask: T-007\nAgent: engineer']);
      const head = git(fixture.root, ['rev-parse', 'HEAD']);
      const evidence = repositoryEvidence(packet, {
        head, changedPaths: ['src/existing.js'],
        pr: { state: 'open', number: 42, url: 'https://example.test/pull/42' },
      });
      evidence.productAttribution = { range: { base: dispatchHead, head }, commits: [head] };
      const roleReturn = readyReturn(packet, evidence);
      const producer = producerBinding(fixture.trust, packet, roleReturn, evidence);
      const received = receiveRoleReturn({
        raw: JSON.stringify(roleReturn), packet, refetchTask: snapshot,
        refetchRepositoryEvidence: () => evidence,
        producerReceipt: producer.producerReceipt,
        resolveTrustedAdapter: producer.resolveTrustedAdapter,
      }, fixture.options);
      assert.equal(received.ok, true, received.validation.errors?.join('\n'));
      const verification = createReturnVerification({
        target: fixture.root, packet, roleReturn, repositoryEvidence: evidence,
        producerReceipt: producer.producerReceipt, received,
      });
      assert.equal(writeReturnVerification(fixture.root, verification).ok, true);

      const prBody = [
        '## Scope Completed', 'Completed.', '', '## Artifacts', `Current implementation artifact: commit:${head}`, '',
        '## Evidence', `Current PR head: ${head}`, '',
        '- Required check: [RC-1] command: `npm test`', '  Verdict: passed', '  Evidence: tests passed (exit 0)', '',
        '- Required check: [RC-2] command: `npm run typecheck`', '  Verdict: passed', '  Evidence: typecheck passed (exit 0)', '',
        '## Deviations', 'None.', '', '## Known Gaps', 'None.', '', '## Follow-Ups', 'None.', '', '[[agent: engineer]]',
      ].join('\n');
      const prData = {
        number: 42, state: 'OPEN', url: 'https://example.test/pull/42', body: prBody,
        headRefOid: head, headRefName: packet.assignment.branch, baseRefOid: packet.repository.baseHead,
        closingIssuesReferences: [{ number: 7 }], files: [], statusCheckRollup: [], comments: [], reviews: [],
        commits: [{ oid: head, message: 'implementation\n\nTask: T-007\nAgent: engineer' }],
      };
      const issueData = { number: 7, body: taskBody, title: 'T-007 review preparation', comments: [] };
      const runner = (_command, args) => {
        if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(
          (args[args.indexOf('--json') + 1] ?? '') === 'headRefOid' ? { headRefOid: head } : prData
        ), stderr: '' };
        if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
        if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }), stderr: '' };
        if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop-bot', type: 'User' }), stderr: '' };
        if (args[0] === 'api' && /git\/trees\//.test(args[1] ?? '')) {
          return { status: 0, stdout: JSON.stringify({ tree: [] }), stderr: '' };
        }
        if (args[0] === 'api' && args.includes('--paginate')) {
          const endpoint = args.find(arg => /^repos\//.test(arg)) ?? '';
          return { status: 0, stdout: JSON.stringify(/issues\/7\/comments/.test(endpoint) ? [[baselineComment]] : [[]]), stderr: '' };
        }
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      };
      const io = {
        operatorTrustRoot: fixture.operatorTrustRoot,
        hostAuthority: protectedHostBoundary(fixture.trust),
      };
      const result = runGitHubReviewPrepare({
        pr: 42, commandRunner: runner, verificationContext: verifyContext,
        target: fixture.root, repo: 'example/repo', io,
      });
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.equal(result.handoffRecognition.recognized, true);
      assert.ok(result.packet);
      assert.equal(result.packet.task, 7);
      assert.equal(result.packet.pr, 42);
      assert.equal(result.packet.headRefOid, head);
      assert.equal(result.packet.taskContract.digest, packet.task.taskContractDigest);
      assert.equal(result.lifecycle.handoffRecognitionDigest, result.handoffRecognition.digest);
      assert.deepEqual(result.handoffRecognition.boundIdentity, {
        backend: 'github', taskId: 'T-007', roleId: 'engineer',
        taskContractDigest: packet.task.taskContractDigest,
        dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
        currentCarrierDigest: packet.task.dispatchCarrierDigest,
        invocationId: packet.assignment.invocationId,
        packetId: packet.packetId, packetDigest: packet.digest,
        workUnitIdentity: packet.decomposition.workUnitId,
        productBaseHead: packet.repository.head, productHead: head, workflowHead: head, candidateHead: null,
        worktreeRoot: packet.repository.worktree,
        repositoryIdentity: verification.repositoryIdentity,
        returnId: roleReturn.returnId, returnGrade: 'host_receipt',
      });
      assert.equal(verification.roleReturnDigest, roleReturn.digest);

      const packetPath = join(temporary, 'review-packet.json');
      writeFileSync(packetPath, JSON.stringify(result.packet), 'utf8');
      const checked = verifyReviewPacket({
        pr: 42, packet: packetPath, commandRunner: runner,
        target: fixture.root, repo: 'example/repo', io,
      });
      assert.equal(checked.ok, true, checked.errors.join('\n'));
      assert.equal(checked.handoffRecognition.recognized, true);
      assert.equal(checked.packet.digest, result.packet.digest);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('emits no packet when preflight passes but no canonical verified return exists', async () => {
    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const result = runGitHubReviewPrepare({ pr: 42, commandRunner: prepareRunner(), verificationContext: verifyContext });
    assert.equal(result.ok, false);
    assert.equal(result.packet, null);
    assert.match(result.errors.join('\n'), /canonical verified return/);
    assert.equal(result.handoffRecognition.recognized, false);
  });

  it('emits no packet and routes owners when preflight fails', async () => {
    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const brokenBody = prepBody.replace('  Evidence: tests passed (exit 0)', '  Evidence:');
    const result = runGitHubReviewPrepare({ pr: 42, commandRunner: prepareRunner({ prBody: brokenBody }), verificationContext: verifyContext });
    assert.equal(result.ok, false);
    assert.equal(result.packet, null);
    assert.ok((result.ownerRouting.engineer ?? []).length > 0, JSON.stringify(result.ownerRouting));
  });

  it('routes a workspace failure to the Engineer owner', async () => {
    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const result = runGitHubReviewPrepare({ pr: 42, commandRunner: prepareRunner(), verificationContext: verifyContext, workspace: 'nonexistent-workspace-path-xyz' });
    assert.equal(result.ok, false);
    assert.equal(result.packet, null);
    assert.ok((result.ownerRouting.engineer ?? []).some(item => /workspace/i.test(item.message)), JSON.stringify(result.ownerRouting));
  });

  it('emits no packet when the head changes during preparation', async () => {
    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const result = runGitHubReviewPrepare({ pr: 42, commandRunner: prepareRunner({ refetchHead: OTHER }), verificationContext: verifyContext });
    assert.equal(result.ok, false);
    assert.equal(result.packet, null);
    assert.match(result.errors.join('\n'), /stale/);
    assert.ok((result.ownerRouting.orchestrator ?? []).length > 0, JSON.stringify(result.ownerRouting));
  });

  it('emits no packet when the refetched head is uppercase', async () => {
    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const result = runGitHubReviewPrepare({ pr: 42, commandRunner: prepareRunner({ refetchHead: HEAD.toUpperCase() }), verificationContext: verifyContext });
    assert.equal(result.ok, false);
    assert.equal(result.packet, null);
    assert.match(result.errors.join('\n'), /missing or malformed/);
  });

  it('does not let independent-review policy bypass the verified-return gate', async () => {
    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const independentIssue = PREP_ISSUE.replace('task_id: T-007', 'task_id: T-007\nindependent_review_required: true');
    const result = runGitHubReviewPrepare({ pr: 42, commandRunner: prepareRunner({ issueBody: independentIssue }), verificationContext: verifyContext });
    assert.equal(result.ok, false);
    assert.equal(result.packet, null);
    assert.match(result.errors.join('\n'), /canonical verified return/);
  });

  it('verifies a packet against the refetched head and rejects stale, malformed, or headless packets', async () => {
    const { verifyReviewPacket } = await import('../src/github-review-prepare.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'review-packet-'));
    const write = (name, content) => { const path = join(dir, name); writeFileSync(path, content, 'utf8'); return path; };
    const calls = [];
    const headRunner = head => (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: '' };
    };

    const { runGitHubReviewPrepare } = await import('../src/github-review-prepare.js');
    const fresh = verifyReviewPacket({ pr: 42, packet: write('fresh.json', JSON.stringify(reviewPacket())), commandRunner: prepareRunner() });
    assert.equal(fresh.ok, false);
    assert.equal(fresh.packet, null);
    assert.match(fresh.errors.join('\n'), /canonical verified return/);

    const staleReceipt = reviewEntryReceipt({ head: BASE });
    const stalePacket = reviewPacket({
      headRefOid: BASE,
      preflight: { ok: true, digest: { requiredChecks: 1, evidenceMatches: 1, headRefOid: BASE } },
      reviewEntryReceipt: staleReceipt,
    });
    const stale = verifyReviewPacket({ pr: 42, packet: write('stale.json', JSON.stringify(stalePacket)), commandRunner: headRunner(HEAD) });
    assert.equal(stale.ok, false);
    assert.equal(stale.packetCheck.stale, true);
    assert.equal(stale.packet, null);

    const callsBeforeMalformed = calls.length;
    const malformed = verifyReviewPacket({ pr: 42, packet: write('malformed.json', 'not json{'), commandRunner: headRunner(HEAD) });
    assert.equal(malformed.ok, false);
    assert.match(malformed.errors.join('\n'), /not readable JSON/);
    assert.equal(calls.length, callsBeforeMalformed, 'malformed JSON must fail before network access');

    const callsBeforeHeadless = calls.length;
    const headless = verifyReviewPacket({ pr: 42, packet: write('headless.json', JSON.stringify(reviewPacket({ headRefOid: '' }))), commandRunner: headRunner(HEAD) });
    assert.equal(headless.ok, false);
    assert.match(headless.errors.join('\n'), /headRefOid must be a complete Git object identity/);
    assert.equal(calls.length, callsBeforeHeadless, 'schema-invalid packets must fail before network access');

    const wrongPr = verifyReviewPacket({ pr: 42, packet: write('wrong-pr.json', JSON.stringify(reviewPacket({ pr: 99 }))), commandRunner: headRunner(HEAD) });
    assert.equal(wrongPr.ok, false);
    assert.match(wrongPr.errors.join('\n'), /does not match requested PR/);

    const substitutedWorkspace = structuredClone(reviewPacket());
    substitutedWorkspace.workspace = { path: dir, head: HEAD, verified: true };
    substitutedWorkspace.digest = reviewPacketDigest(substitutedWorkspace);
    const substituted = verifyReviewPacket({
      pr: 42,
      packet: write('substituted-workspace.json', JSON.stringify(substitutedWorkspace)),
      commandRunner: prepareRunner(),
      workspaceCommandRunner: () => ({ status: 0, stdout: `${OTHER}\n`, stderr: '' }),
    });
    assert.equal(substituted.ok, false);
    assert.match(substituted.errors.join('\n'), /workspace verification failed/);
    assert.equal(substituted.packet, null);
  });
});

// ---------------------------------------------------------------------------
// Step 6: GitHub checkpoint render and repair-plan through mocked read-only loaders
// ---------------------------------------------------------------------------

describe('review preparation contract - GitHub checkpoint render and repair plan', () => {
  const OUTCOME_BODY = [
    'AGENT_REVIEW_STATUS: needs_revision', 'AGENT_REVIEW_MODE: host_subagent',
    `AGENT_REVIEW_ARTIFACT: ${HEAD}`, 'AGENT_REVIEW_FINDINGS: F-1', '[[agent: maintainer]]',
  ].join('\n');
  const CHECKPOINT_BODY = orchestrator => [
    '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->', '', '## Review Round Checkpoint', '',
    '- Direction: targeted_revision', '- Cause: implementation_defect', '- Review count: 1',
    `- Artifact: ${HEAD}`, '- Target: repair F-1', ...(orchestrator ? [`- Orchestrator: ${orchestrator}`] : []), '',
    '[[agent: orchestrator]]',
  ].join('\n');
  const mk = (id, body, time) => ({ id, html_url: `https://example.invalid/c/${id}`, created_at: time, body, user: { login: 'loop-bot', type: 'User' } });

  function checkpointRunner(comments) {
    const prData = {
      number: 42, body: 'preparation', headRefOid: HEAD, baseRefOid: BASE,
      closingIssuesReferences: [{ number: 7 }],
    };
    const issueData = { number: 7, body: '---\ntask_id: T-007\n---\n# T\n\n## Required Checks\n- [RC-1] `npm test`\n' };
    return (command, args) => {
      if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify(prData), stderr: '' };
      if (args[0] === 'issue') return { status: 0, stdout: JSON.stringify(issueData), stderr: '' };
      if (args[0] === 'repo') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r' }), stderr: '' };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'loop-bot', type: 'User' }), stderr: '' };
      if (args[0] === 'api' && args.includes('--paginate')) {
        const endpoint = args.find(arg => /^repos\/o\/r\//.test(arg));
        if (/issues\/7\/comments/.test(endpoint)) return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
        if (/issues\/42\/comments/.test(endpoint)) return { status: 0, stdout: JSON.stringify([[], comments]), stderr: '' };
        if (/pulls\/42\/reviews/.test(endpoint)) return { status: 0, stdout: JSON.stringify([[]]), stderr: '' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  const context = { projectFacts: [], decisionExists: () => false, taskExists: () => false };

  it('renders a checkpoint from authenticated ordered history with the proposed-carrier state', async () => {
    const { renderGitHubCheckpoint } = await import('../src/github-checkpoint.js');
    const { parseReviewCheckpoint } = await import('../src/review-checkpoint.js');
    const comments = [mk(1, OUTCOME_BODY, '2026-07-25T10:00:00Z')];
    const result = renderGitHubCheckpoint({
      pr: 42, commandRunner: checkpointRunner(comments), verificationContext: context,
      direction: 'targeted_revision', cause: 'implementation_defect', target: 'repair F-1',
    });
    assert.equal(result.ok, true);
    assert.equal(result.checkpoint.reviewCount, 1);
    assert.equal(result.checkpoint.artifact, HEAD);
    assert.equal(result.checkpoint.orchestratorAttribution, 'loop-bot');
    assert.equal(result.checkpointState.state, 'rendered');
    assert.equal(result.checkpointState.authorizes, false);
    const parsed = parseReviewCheckpoint(result.carrier, { carrier: 'github' });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.checkpoint.orchestratorAttribution, 'loop-bot');
  });

  it('refuses to render a checkpoint when durable history has errors', async () => {
    const { renderGitHubCheckpoint, GitHubCheckpointError } = await import('../src/github-checkpoint.js');
    const malformedOutcome = mk(1, OUTCOME_BODY.replace('AGENT_REVIEW_FINDINGS: F-1\n', ''), '2026-07-25T10:00:00Z');
    assert.throws(
      () => renderGitHubCheckpoint({
        pr: 42, commandRunner: checkpointRunner([malformedOutcome]), verificationContext: context,
        direction: 'targeted_revision', cause: 'implementation_defect', target: 'repair F-1',
      }),
      GitHubCheckpointError,
    );
  });

  it('plans a bounded same-author repair that application accepts', async () => {
    const { planGitHubCheckpointRepair } = await import('../src/github-checkpoint.js');
    const comments = [
      mk(1, OUTCOME_BODY, '2026-07-25T10:00:00Z'),
      mk(100, CHECKPOINT_BODY(null), '2026-07-25T11:00:00Z'),
    ];
    const result = planGitHubCheckpointRepair({ pr: 42, commandRunner: checkpointRunner(comments), verificationContext: context, source: '100' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.repair.correctedFields, ['actor_account', 'role_id', 'review_role_carrier']);
    assert.equal(result.repair.checkpoint.orchestratorAttribution, 'loop-bot');
    const parsed = parseCheckpointRepair(result.carrier, { carrier: 'github' });
    assert.equal(parsed.found, true);
    assert.deepEqual(parsed.errors, []);
  });

  it('plans a repair for wrong-but-repairable authenticated attribution', async () => {
    const { planGitHubCheckpointRepair } = await import('../src/github-checkpoint.js');
    const comments = [
      mk(1, OUTCOME_BODY, '2026-07-25T10:00:00Z'),
      mk(100, CHECKPOINT_BODY('wrong-login'), '2026-07-25T11:00:00Z'),
    ];
    const result = planGitHubCheckpointRepair({ pr: 42, commandRunner: checkpointRunner(comments), verificationContext: context, source: '100' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.repair.correctedFields, ['actor_account', 'role_id', 'review_role_carrier']);
  });

  it('never emits a carrier that application would reject', async () => {
    const { planGitHubCheckpointRepair, GitHubCheckpointError } = await import('../src/github-checkpoint.js');
    // The malformed checkpoint was already consumed by a later review outcome.
    const consumed = [
      mk(1, OUTCOME_BODY, '2026-07-25T10:00:00Z'),
      mk(100, CHECKPOINT_BODY(null), '2026-07-25T11:00:00Z'),
      mk(2, OUTCOME_BODY, '2026-07-25T12:00:00Z'),
    ];
    assert.throws(
      () => planGitHubCheckpointRepair({ pr: 42, commandRunner: checkpointRunner(consumed), verificationContext: context, source: '100' }),
      /cannot be applied|GitHubCheckpointError/,
    );
    // A valid checkpoint is not an eligible malformed candidate.
    const valid = [
      mk(1, OUTCOME_BODY, '2026-07-25T10:00:00Z'),
      mk(100, CHECKPOINT_BODY('loop-bot'), '2026-07-25T11:00:00Z'),
    ];
    assert.throws(
      () => planGitHubCheckpointRepair({ pr: 42, commandRunner: checkpointRunner(valid), verificationContext: context, source: '100' }),
      GitHubCheckpointError,
    );
  });
});

// ---------------------------------------------------------------------------
// P35-06: one SHA-256 fixture through the complete review-preparation path
// ---------------------------------------------------------------------------

describe('review preparation contract - SHA-256 object format end to end', () => {
  const HEAD256 = 'c'.repeat(64);
  const BASE256 = 'd'.repeat(64);

  function sha256Input() {
    return createPreparationInput({
      prData: {
        number: 42, body: baseBody({ head: HEAD256 }), headRefOid: HEAD256, baseRefOid: BASE256,
        files: [], statusCheckRollup: [],
        commits: [{ oid: HEAD256, message: 'impl\n\nTask: T-007\nAgent: engineer' }],
        comments: [], reviews: [],
      },
      issueData: { number: 7, body: canonicalTask(), comments: [] },
      expectedAccount: { login: 'loop-bot', type: 'User' }, reviewHistory: { events: [], errors: [] },
      basePaths: ['src/App.js'], mode: 'review', projectFacts: [], reviewBudget: 5,
    });
  }

  it('preflight -> review-entry receipt -> preparation packet -> authoritative packet verification', () => {
    const input = sha256Input();
    const result = evaluatePreparationInput(input, evaluatePreflight);
    assert.equal(result.ok, true, (result.errors ?? []).join('\n'));

    const receipt = createReviewEntryReceipt({ input }, result, { observedAt: '2026-08-07T00:00:00.000Z' });
    assert.equal(receipt.artifact.head, HEAD256);

    const packet = {
      type: 'agenticloop.github_review_preparation',
      schemaVersion: 3,
      pr: 42, task: 7, headRefOid: HEAD256,
      reviewMode: 'host_subagent', independentReviewRequired: false,
      workspace: null,
      currentFindingIds: reviewEntryReceiptCurrentFindingIds(receipt),
      preflight: {
        ok: true,
        digest: {
          requiredChecks: result.requiredChecks.length,
          evidenceMatches: result.evidenceMatches.length,
          headRefOid: HEAD256,
        },
      },
      taskContract: { digest: result.contractBaseline?.digest ?? null, baseline: result.contractBaseline?.baseline ?? null },
      reviewEntryReceipt: receipt,
      lease: REVIEW_PACKET_LEASE,
      digest: null,
    };
    packet.digest = reviewPacketDigest(packet);

    const verified = validateReviewPacket(packet, HEAD256, { expectedPr: 42 });
    assert.equal(verified.valid, true, (verified.errors ?? []).join?.('\n') ?? String(verified.reason ?? ''));
  });

  it('a SHA-1 current head cannot verify a SHA-256 packet', () => {
    const input = sha256Input();
    const result = evaluatePreparationInput(input, evaluatePreflight);
    assert.equal(result.ok, true, (result.errors ?? []).join('\n'));
    const receipt = createReviewEntryReceipt({ input }, result, { observedAt: '2026-08-07T00:00:00.000Z' });
    const packet = {
      type: 'agenticloop.github_review_preparation',
      schemaVersion: 3,
      pr: 42, task: 7, headRefOid: HEAD256,
      reviewMode: 'host_subagent', independentReviewRequired: false,
      workspace: null,
      currentFindingIds: reviewEntryReceiptCurrentFindingIds(receipt),
      preflight: {
        ok: true,
        digest: {
          requiredChecks: result.requiredChecks.length,
          evidenceMatches: result.evidenceMatches.length,
          headRefOid: HEAD256,
        },
      },
      taskContract: { digest: result.contractBaseline?.digest ?? null, baseline: result.contractBaseline?.baseline ?? null },
      reviewEntryReceipt: receipt,
      lease: REVIEW_PACKET_LEASE,
      digest: null,
    };
    packet.digest = reviewPacketDigest(packet);
    const mixed = validateReviewPacket(packet, HEAD, { expectedPr: 42 });
    assert.equal(mixed.valid, false);
  });

  it('preflight rejects an abbreviated 64-character head identity', () => {
    const abbreviated = evaluatePreparationInput(
      (() => { const input = sha256Input(); input.prData.headRefOid = HEAD256.slice(0, 12); return input; })(),
      evaluatePreflight,
    );
    assert.equal(abbreviated.ok, false);
    assert.match(abbreviated.errors.join('\n'), /not a full Git object identity/);
  });

  it('preflight rejects an uppercase 64-character head identity', () => {
    const uppercase = evaluatePreparationInput(
      (() => { const input = sha256Input(); input.prData.headRefOid = HEAD256.toUpperCase(); return input; })(),
      evaluatePreflight,
    );
    assert.equal(uppercase.ok, false);
    assert.match(uppercase.errors.join('\n'), /not a full Git object identity/);
  });
});
