import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  REVIEW_MODES,
  INDEPENDENT_REVIEW_MODES,
  isValidReviewMode,
  satisfiesIndependentReview,
  validateReviewProvenance,
} from '../src/review-provenance.js';
import { validateFilesTaskRecord } from '../src/validate-config.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(REPO_ROOT, 'bin', 'agenticloop.js');

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-review-prov-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });
}

// ---------------------------------------------------------------------------
// Unit: vocabulary + shared validator
// ---------------------------------------------------------------------------

describe('review-provenance vocabulary', () => {
  it('reuses the delegation vocabulary plus independent_human', () => {
    assert.deepEqual(REVIEW_MODES, [
      'host_subagent',
      'explicit_agent_invocation',
      'single_agent_fallback',
      'independent_human',
    ]);
    assert.deepEqual(INDEPENDENT_REVIEW_MODES, [
      'host_subagent',
      'explicit_agent_invocation',
      'independent_human',
    ]);
  });

  it('single_agent_fallback does not satisfy independent review', () => {
    assert.equal(satisfiesIndependentReview('single_agent_fallback'), false);
    for (const mode of INDEPENDENT_REVIEW_MODES) {
      assert.equal(satisfiesIndependentReview(mode), true, mode);
    }
  });
});

describe('validateReviewProvenance', () => {
  // Scenario 1: valid review modes.
  it('accepts each valid review_mode with an artifact-bound review_status', () => {
    for (const mode of REVIEW_MODES) {
      const errors = validateReviewProvenance({
        label: 'T-001.md',
        status: 'needs_revision',
        reviewStatus: 'needs_revision',
        reviewModeRaw: mode,
        implementationArtifact: 'commit:artifact-a',
        reviewedArtifact: 'commit:artifact-a',
        humanReviewRef: mode === 'independent_human' ? 'https://example/review/1' : '',
      });
      assert.deepEqual(errors, [], `mode ${mode} should be valid: ${errors.join(', ')}`);
      assert.equal(isValidReviewMode(mode), true);
    }
  });

  // Scenario 2: invalid mode rejection.
  it('rejects an unknown review_mode', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      reviewStatus: 'accepted',
      reviewModeRaw: 'bot_review',
    });
    assert.ok(errors.some(e => e.includes("invalid review_mode 'bot_review'")));
  });

  // Scenario 3: review status without mode.
  it('rejects a non-empty review_status without a review_mode', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      reviewStatus: 'accepted',
      reviewModeRaw: '',
      implementationArtifact: 'commit:artifact-a',
    });
    assert.ok(errors.some(e => e.includes("missing required frontmatter field 'review_mode'")));
  });

  // Scenario 4: accepted task without mode.
  it('rejects accepted/closed status without a valid mode and accepted review', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      status: 'accepted',
      reviewStatus: '',
      reviewModeRaw: '',
      implementationArtifact: 'commit:artifact-a',
    });
    assert.ok(errors.some(e => e.includes("review_status is not 'accepted'")));
    assert.ok(errors.some(e => e.includes("missing required frontmatter field 'review_mode'")));
  });

  // Scenario 5: same-session fallback accepted when independent review not required.
  it('accepts single_agent_fallback when independent review is not required', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      status: 'accepted',
      reviewStatus: 'accepted',
      reviewModeRaw: 'single_agent_fallback',
      implementationArtifact: 'commit:artifact-a',
      reviewedArtifact: 'commit:artifact-a',
    });
    assert.deepEqual(errors, []);
  });

  // Scenario 6: same-session fallback rejected when independent review required.
  it('rejects single_agent_fallback when independent review is required', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      status: 'accepted',
      reviewStatus: 'accepted',
      reviewModeRaw: 'single_agent_fallback',
      implementationArtifact: 'commit:artifact-a',
      reviewedArtifact: 'commit:artifact-a',
      independentRaw: 'true',
    });
    assert.ok(errors.some(e => e.includes('requires independent review but review_mode is')));
  });

  // Scenarios 7 + 8: host_subagent and explicit_agent_invocation acceptance.
  for (const mode of ['host_subagent', 'explicit_agent_invocation']) {
    it(`accepts ${mode} when independent review is required`, () => {
      const errors = validateReviewProvenance({
        label: 'T-001.md',
        status: 'accepted',
        reviewStatus: 'accepted',
        reviewModeRaw: mode,
        implementationArtifact: 'commit:artifact-a',
        reviewedArtifact: 'commit:artifact-a',
        independentRaw: 'true',
      });
      assert.deepEqual(errors, []);
    });
  }

  // Scenario 9: files validation requires a present reference, not external verification.
  it('accepts independent_human only with a present human_review_ref', () => {
    const withRef = validateReviewProvenance({
      label: 'T-001.md',
      status: 'accepted',
      reviewStatus: 'accepted',
      reviewModeRaw: 'independent_human',
      implementationArtifact: 'commit:artifact-a',
      reviewedArtifact: 'commit:artifact-a',
      independentRaw: 'true',
      humanReviewRef: 'https://github.com/o/r/pull/1#review',
    });
    assert.deepEqual(withRef, []);

    const withoutRef = validateReviewProvenance({
      label: 'T-001.md',
      status: 'accepted',
      reviewStatus: 'accepted',
      reviewModeRaw: 'independent_human',
      implementationArtifact: 'commit:artifact-a',
      reviewedArtifact: 'commit:artifact-a',
      independentRaw: 'true',
      humanReviewRef: '',
    });
    assert.ok(withoutRef.some(e => e.includes("missing required recorded 'human_review_ref'")));
  });

  it('rejects a malformed independent_review_required', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      reviewStatus: 'accepted',
      reviewModeRaw: 'host_subagent',
      implementationArtifact: 'commit:artifact-a',
      reviewedArtifact: 'commit:artifact-a',
      independentRaw: 'yes',
    });
    assert.ok(errors.some(e => e.includes('malformed independent_review_required')));
  });

  it('rejects missing, orphaned, and stale reviewed_artifact values', () => {
    const base = { label: 'T-001.md', reviewStatus: 'needs_revision', reviewModeRaw: 'host_subagent', implementationArtifact: 'commit:b' };
    assert.ok(validateReviewProvenance(base).some(e => /reviewed_artifact/.test(e)));
    assert.ok(validateReviewProvenance({ ...base, reviewedArtifact: 'commit:a' }).some(e => /stale/.test(e)));
    assert.ok(validateReviewProvenance({ label: 'T-001.md', reviewedArtifact: 'commit:a' }).some(e => /no review_status/.test(e)));
  });

  it('rejects review_mode without review_status', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      reviewModeRaw: 'host_subagent',
    });
    assert.ok(errors.some(e => e.includes('sets review_mode') && e.includes('no review_status')));
  });

  it('rejects human_review_ref without review_status', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      humanReviewRef: 'https://example/review/1',
    });
    assert.ok(errors.some(e => e.includes('sets human_review_ref') && e.includes('no review_status')));
  });

  it('rejects human_review_ref with non-independent_human mode', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      reviewStatus: 'accepted',
      reviewModeRaw: 'host_subagent',
      implementationArtifact: 'commit:a',
      reviewedArtifact: 'commit:a',
      humanReviewRef: 'https://example/review/1',
    });
    assert.ok(errors.some(e => e.includes("sets human_review_ref but review_mode is 'host_subagent'")));
  });

  it('allows empty review state with only independent_review_required set', () => {
    const errors = validateReviewProvenance({
      label: 'T-001.md',
      independentRaw: 'true',
    });
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------
// Files backend validation surface (validateFilesTaskRecord)
// ---------------------------------------------------------------------------

function filesTaskRecord({ status = 'agent-ready', implementationArtifact = 'commit:abc123', reviewedArtifact = '', reviewStatus = '', reviewMode = '', extra = [] }) {
  return [
    '---',
    'task_id: T-001',
    `status: ${status}`,
    'backend: files',
    `implementation_artifact: ${implementationArtifact}`,
    `review_status: ${reviewStatus}`,
    `reviewed_artifact: ${reviewedArtifact}`,
    `review_mode: ${reviewMode}`,
    ...extra,
    '---',
    '## Scope Completed',
    'Done.',
    '## Artifacts',
    'commit:abc123',
    '## Evidence',
    'Tests pass.',
    '## Deviations',
    'None.',
    '## Process Observations',
    'None.',
    '## Known Gaps',
    'None.',
    '## Follow-Ups',
    'None.',
  ].join('\n');
}

describe('validateFilesTaskRecord review provenance', () => {
  it('flags accepted records that use single_agent_fallback when independent review is required', () => {
    const content = filesTaskRecord({
      status: 'accepted',
      reviewStatus: 'accepted',
      reviewedArtifact: 'commit:abc123',
      reviewMode: 'single_agent_fallback',
      extra: ['independent_review_required: true'],
    });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.ok(errors.some(e => e.includes('requires independent review')));
  });

  it('accepts a host_subagent accepted record that requires independent review', () => {
    const content = filesTaskRecord({
      status: 'accepted',
      reviewStatus: 'accepted',
      reviewedArtifact: 'commit:abc123',
      reviewMode: 'host_subagent',
      extra: ['independent_review_required: true'],
    });
    const errors = validateFilesTaskRecord(content, 'T-001.md', { activeTaskBackend: 'files' });
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------
// CLI acceptance gate integration
// ---------------------------------------------------------------------------

function initTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  const res = run(['init', '--target', target]);
  assert.equal(res.status, 0, res.stderr);
  return target;
}

function seedInProgressTask(target, { artifact = 'commit:abc123', reviewedArtifact = artifact, reviewMode, independent = false, humanRef = '' }) {
  const tasksDir = join(target, '.agenticloop', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const fm = [
    '---',
    'task_id: T-001',
    'status: in-progress',
    'backend: files',
    `implementation_artifact: ${artifact}`,
    'review_status: accepted',
    `reviewed_artifact: ${reviewedArtifact}`,
    `review_mode: ${reviewMode}`,
  ];
  if (independent) fm.push('independent_review_required: true');
  if (humanRef) fm.push(`human_review_ref: ${humanRef}`);
  fm.push('---');
  const body = [
    '',
    '# T-001 - Task',
    '## Task',
    'Ship it.',
    '## Source Documents Reviewed',
    '- README.md',
    '## Current State',
    'Ready.',
    '## Scope',
    'Do the thing.',
    '## Out of Scope',
    'Nothing else.',
    '## Acceptance Criteria',
    '- It works.',
    '## Required Checks',
    '- npm test',
    '## Expected Files or Areas',
    '- src/',
    '## Implementation Notes',
    'Notes.',
    '## Completion Summary Template',
    'Fill in.',
    '## Reviewer Checklist',
    '- [x] Reviewed.',
    '## Scope Completed',
    'Implemented.',
    '## Artifacts',
    '- commit:abc123',
    '## Evidence',
    '- npm test passed.',
  ];
  writeFileSync(join(tasksDir, 'T-001.md'), fm.join('\n') + body.join('\n') + '\n', 'utf-8');
}

describe('task status acceptance gate: review provenance', () => {
  it('accepts single_agent_fallback for an ordinary task', () => {
    const target = initTarget('cli-fallback-ok');
    seedInProgressTask(target, { reviewMode: 'single_agent_fallback' });
    const res = run(['task', 'status', 'T-001', 'accepted', '--target', target]);
    assert.equal(res.status, 0, res.stderr);
  });

  it('rejects single_agent_fallback when independent review is required', () => {
    const target = initTarget('cli-fallback-blocked');
    seedInProgressTask(target, { reviewMode: 'single_agent_fallback', independent: true });
    const res = run(['task', 'status', 'T-001', 'accepted', '--target', target]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /requires independent review/);
  });

  it('accepts host_subagent when independent review is required', () => {
    const target = initTarget('cli-hostsub-ok');
    seedInProgressTask(target, { reviewMode: 'host_subagent', independent: true });
    const res = run(['task', 'status', 'T-001', 'accepted', '--target', target]);
    assert.equal(res.status, 0, res.stderr);
  });

  it('accepts explicit_agent_invocation when independent review is required', () => {
    const target = initTarget('cli-explicit-ok');
    seedInProgressTask(target, { reviewMode: 'explicit_agent_invocation', independent: true });
    const res = run(['task', 'status', 'T-001', 'accepted', '--target', target]);
    assert.equal(res.status, 0, res.stderr);
  });

  it('accepts independent_human with a present reference; rejects without one', () => {
    const withRef = initTarget('cli-human-ok');
    seedInProgressTask(withRef, { reviewMode: 'independent_human', independent: true, humanRef: 'https://x/review/1' });
    assert.equal(run(['task', 'status', 'T-001', 'accepted', '--target', withRef]).status, 0);

    const withoutRef = initTarget('cli-human-noref');
    seedInProgressTask(withoutRef, { reviewMode: 'independent_human', independent: true });
    const res = run(['task', 'status', 'T-001', 'accepted', '--target', withoutRef]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /human_review_ref/);
  });

  it('rejects acceptance when review_mode is missing', () => {
    const target = initTarget('cli-nomode');
    seedInProgressTask(target, { reviewMode: '' });
    const res = run(['task', 'status', 'T-001', 'accepted', '--target', target]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /missing required frontmatter field 'review_mode'/);
  });

  it('rejects stale provenance and rechecks it when closing', () => {
    const target = initTarget('cli-stale');
    seedInProgressTask(target, { artifact: 'commit:b', reviewedArtifact: 'commit:a', reviewMode: 'host_subagent' });
    const accepted = run(['task', 'status', 'T-001', 'accepted', '--target', target]);
    assert.notEqual(accepted.status, 0);
    assert.match(accepted.stderr, /stale/);

    seedInProgressTask(target, { artifact: 'commit:b', reviewedArtifact: 'commit:b', reviewMode: 'host_subagent' });
    assert.equal(run(['task', 'status', 'T-001', 'accepted', '--target', target]).status, 0);
    const stale = readFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), 'utf-8').replace('reviewed_artifact: commit:b', 'reviewed_artifact: commit:a');
    writeFileSync(join(target, '.agenticloop', 'tasks', 'T-001.md'), stale, 'utf-8');
    const closed = run(['task', 'status', 'T-001', 'closed', '--target', target]);
    assert.notEqual(closed.status, 0);
    assert.match(closed.stderr, /stale/);
  });

  it('exposes review_mode in task list --json', () => {
    const target = initTarget('cli-list');
    seedInProgressTask(target, { reviewMode: 'host_subagent' });
    const res = run(['task', 'list', '--target', target, '--json']);
    assert.equal(res.status, 0, res.stderr);
    const rows = JSON.parse(res.stdout);
    assert.equal(rows[0].review_mode, 'host_subagent');
    assert.equal(rows[0].reviewed_artifact, 'commit:abc123');
  });
});

// ---------------------------------------------------------------------------
// Backend docs + stale provenance rule
// ---------------------------------------------------------------------------

describe('backend review-marker docs', () => {
  it('GitHub markers include both status and mode', () => {
    const github = readFileSync(join(REPO_ROOT, 'backends', 'github.md'), 'utf-8');
    assert.match(github, /AGENT_REVIEW_STATUS: accepted\nAGENT_REVIEW_MODE: host_subagent/);
    assert.match(github, /AGENT_REVIEW_STATUS: needs_revision\nAGENT_REVIEW_MODE: host_subagent/);
  });

  it('files backend documents review_mode and independent-review enforcement', () => {
    const files = readFileSync(join(REPO_ROOT, 'backends', 'files.md'), 'utf-8');
    assert.match(files, /review_mode/);
    assert.match(files, /independent_review_required/);
    assert.match(files, /human_review_ref/);
  });

  it('review-and-accept declares reviewed_artifact', () => {
    const skill = readFileSync(join(REPO_ROOT, 'skills', 'review-and-accept', 'SKILL.md'), 'utf-8');
    assert.match(skill, /reviewed_artifact/);
  });
});

// ---------------------------------------------------------------------------
// Adapter packaging preserves the contract
// ---------------------------------------------------------------------------

describe('adapter-generated instructions preserve the review contract', () => {
  it('packages artifact-bound GitHub markers into a generated Claude Code reference', () => {
    const fx = mkdtempSync(join(tmpDir, 'adapter-fx-'));
    seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });
    const out = mkdtempSync(join(tmpDir, 'adapter-out-'));
    const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
    const { files } = generateClaudeCodeArtifacts(cfg, fx, out);
    const reviewRef = files.find(f => /review-and-accept\/reference\.md$/.test(f));
    assert.ok(reviewRef, 'expected a generated review-and-accept reference');
    const content = readFileSync(join(out, reviewRef), 'utf-8');
    assert.match(content, /AGENT_REVIEW_MODE/);
    assert.match(content, /AGENT_REVIEW_ARTIFACT/);
  });
});
