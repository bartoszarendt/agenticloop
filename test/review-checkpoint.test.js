/**
 * Tests for src/review-checkpoint.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewCheckpoint,
  countNeedsRevisionRounds,
  evaluateReviewCheckpoint,
  validateCheckpointSchema,
  formatCheckpoint,
  DEFAULT_REVIEW_BUDGET,
  VALID_DIRECTIONS,
} from '../src/review-checkpoint.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

function checkpointText({
  direction = 'targeted_revision',
  cause = 'implementation_defect',
  reviewCount = DEFAULT_REVIEW_BUDGET,
  artifact = HEAD,
  target = 'fix failing test evidence',
  reference = null,
  orchestrator = 'orchestrator-bot',
} = {}) {
  const lines = [
    '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
    '',
    '## Review Round Checkpoint',
    '',
    `- Direction: ${direction}`,
    `- Cause: ${cause}`,
    `- Review count: ${reviewCount}`,
    `- Artifact: ${artifact}`,
  ];
  if (target) lines.push(`- Target: ${target}`);
  if (reference) lines.push(`- Reference: ${reference}`);
  if (orchestrator) lines.push(`- Orchestrator: ${orchestrator}`);
  lines.push('');
  return lines.join('\n');
}

describe('parseReviewCheckpoint', () => {
  it('returns found=false when no checkpoint marker present', () => {
    const result = parseReviewCheckpoint('some text without a checkpoint');
    assert.equal(result.found, false);
    assert.equal(result.checkpoint, null);
    assert.deepEqual(result.errors, []);
  });

  it('parses a valid targeted_revision checkpoint', () => {
    const result = parseReviewCheckpoint(checkpointText());
    assert.equal(result.found, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.checkpoint.direction, 'targeted_revision');
    assert.equal(result.checkpoint.cause, 'implementation_defect');
    assert.equal(result.checkpoint.reviewCount, DEFAULT_REVIEW_BUDGET);
    assert.equal(result.checkpoint.artifact, HEAD);
    assert.equal(result.checkpoint.target, 'fix failing test evidence');
  });

  it('parses a valid needs_context checkpoint', () => {
    const text = checkpointText({
      direction: 'needs_context',
      cause: 'task_contract_ambiguity',
      target: null,
      reference: 'maintainer review comment 5',
    });
    const result = parseReviewCheckpoint(text);
    assert.equal(result.found, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.checkpoint.direction, 'needs_context');
    assert.equal(result.checkpoint.reference, 'maintainer review comment 5');
  });

  it('parses a valid blocked checkpoint', () => {
    const text = checkpointText({
      direction: 'blocked',
      cause: 'external_blocker',
      target: null,
      reference: 'issue #42',
    });
    const result = parseReviewCheckpoint(text);
    assert.equal(result.found, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.checkpoint.direction, 'blocked');
  });

  it('rejects checkpoint with missing direction', () => {
    const text = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Cause: evidence gaps',
      `- Review count: 3`,
      `- Artifact: ${HEAD}`,
    ].join('\n');
    const result = parseReviewCheckpoint(text);
    assert.equal(result.found, true);
    assert.ok(result.errors.some(e => /missing.*direction/i.test(e)));
  });

  it('rejects checkpoint with invalid direction', () => {
    const text = checkpointText({ direction: 'continue' });
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /not valid|invalid direction/i.test(e)),
      `Expected direction error, got: ${result.errors.join('; ')}`);
  });

  it('rejects checkpoint with missing cause', () => {
    const text = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Direction: targeted_revision',
      `- Review count: 3`,
      `- Artifact: ${HEAD}`,
    ].join('\n');
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /missing.*cause/i.test(e)));
  });

  it('rejects checkpoint with missing review_count', () => {
    const text = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Direction: targeted_revision',
      '- Cause: evidence gaps',
      `- Artifact: ${HEAD}`,
    ].join('\n');
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /missing.*review_count/i.test(e)));
  });

  it('rejects checkpoint with non-integer review_count', () => {
    const text = checkpointText({ reviewCount: 'abc' });
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /not a positive integer/i.test(e)));
  });

  it('rejects checkpoint with short artifact SHA', () => {
    const text = checkpointText({ artifact: 'a1b2c3d' });
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /not a full 40-character/i.test(e)));
  });

  it('rejects targeted_revision without target', () => {
    const text = checkpointText({ direction: 'targeted_revision', target: null });
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /requires.*target/i.test(e)));
  });

  it('rejects blocked without reference', () => {
    const text = checkpointText({ direction: 'blocked', target: null, reference: null });
    const result = parseReviewCheckpoint(text);
    assert.ok(result.errors.some(e => /requires.*reference/i.test(e)));
  });
});

describe('countNeedsRevisionRounds', () => {
  it('returns 0 for empty outcomes', () => {
    assert.equal(countNeedsRevisionRounds([]), 0);
  });

  it('returns 0 for null/undefined', () => {
    assert.equal(countNeedsRevisionRounds(null), 0);
    assert.equal(countNeedsRevisionRounds(undefined), 0);
  });

  it('counts only needs_revision outcomes', () => {
    const outcomes = [
      { status: 'accepted' },
      { status: 'needs_revision' },
      { status: 'needs_revision' },
      { status: 'accepted' },
    ];
    assert.equal(countNeedsRevisionRounds(outcomes), 2);
  });
});

describe('evaluateReviewCheckpoint', () => {
  it('uses the canonical default threshold of five counted needs_revision outcomes', () => {
    assert.equal(DEFAULT_REVIEW_BUDGET, 5);
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: Array.from({ length: 5 }, () => ({ status: 'needs_revision', artifact: HEAD })),
    });
    assert.equal(result.authorized, false);
    assert.ok(result.errors.some(error => /checkpoint.*required|budget.*exhausted/i.test(error)));
  });

  it('authorizes rounds within budget without checkpoint', () => {
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
      ],
      budget: 3,
    });
    assert.equal(result.authorized, true);
    assert.deepEqual(result.errors, []);
  });

  it('blocks over-budget revision without checkpoint', () => {
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
      ],
      budget: 3,
    });
    assert.equal(result.authorized, false);
    assert.ok(result.errors.some(e => /checkpoint.*required|budget.*exhausted/i.test(e)));
  });

  it('blocks when direction is not targeted_revision', () => {
    const checkpoint = {
      direction: 'needs_context',
      cause: 'task_contract_ambiguity',
      reviewCount: 3,
      artifact: HEAD,
      reference: 'decision D-1',
      orchestratorAttribution: 'orchestrator-bot',
    };
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
      ],
      checkpoint,
      budget: 3,
    });
    assert.equal(result.authorized, false);
    assert.ok(result.errors.some(e => /only.*targeted_revision/i.test(e)));
  });

  it('authorizes with valid targeted checkpoint at budget boundary', () => {
    const checkpoint = {
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 3,
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    };
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
      ],
      checkpoint,
      budget: 3,
      currentArtifact: HEAD,
    });
    assert.equal(result.authorized, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects checkpoint with wrong review count', () => {
    const checkpoint = {
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 2, // wrong - should be 3
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    };
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
      ],
      checkpoint,
      budget: 3,
    });
    assert.equal(result.authorized, false);
    assert.ok(result.errors.some(e => /review_count.*does not match|consumed/i.test(e)));
  });

  it('rejects checkpoint with wrong artifact', () => {
    const wrongArtifact = 'b'.repeat(40);
    const checkpoint = {
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 3,
      artifact: wrongArtifact,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    };
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
      ],
      checkpoint,
      budget: 3,
    });
    assert.equal(result.authorized, false);
    assert.ok(result.errors.some(e => /artifact.*does not match/i.test(e)));
  });

  it('rejects consumed checkpoint (replay)', () => {
    const checkpoint = {
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 3,
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    };
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD },
        { status: 'needs_revision', artifact: HEAD }, // 4th revision consumed the checkpoint
      ],
      checkpoint,
      budget: 3,
    });
    assert.equal(result.authorized, false);
    assert.ok(result.errors.some(e => /consumed|replay|review_count.*does not match/i.test(e)));
  });

  it('warns when checkpoint present but within budget', () => {
    const checkpoint = {
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 2,
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    };
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD },
      ],
      checkpoint,
      budget: 3,
    });
    assert.equal(result.authorized, true);
    assert.ok(result.warnings.some(w => /within budget|not required/i.test(w)));
  });
});

describe('validateCheckpointSchema', () => {
  it('validates a complete checkpoint', () => {
    const result = validateCheckpointSchema({
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 3,
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects null checkpoint', () => {
    const result = validateCheckpointSchema(null);
    assert.equal(result.valid, false);
  });

  it('rejects missing direction', () => {
    const result = validateCheckpointSchema({ cause: 'test', reviewCount: 1, artifact: HEAD });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /direction/i.test(e)));
  });

  it('rejects short artifact', () => {
    const result = validateCheckpointSchema({
      direction: 'targeted_revision',
      cause: 'test',
      reviewCount: 1,
      artifact: 'a1b2c3d',
      target: 'test',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /40-character/i.test(e)));
  });
});

describe('formatCheckpoint', () => {
  it('produces a valid checkpoint text', () => {
    const formatted = formatCheckpoint({
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 3,
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
    });
    assert.ok(formatted.includes('AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT'));
    assert.ok(formatted.includes('Direction: targeted_revision'));
    assert.ok(formatted.includes('Cause: implementation_defect'));
    assert.ok(formatted.includes('Review count: 3'));
    assert.ok(formatted.includes(`Artifact: ${HEAD}`));
    assert.ok(formatted.includes('Target: fix tests'));

    // Should be parseable
    const parsed = parseReviewCheckpoint(formatted);
    assert.equal(parsed.found, true);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.checkpoint.direction, 'targeted_revision');
  });

  it('includes orchestrator attribution when provided', () => {
    const formatted = formatCheckpoint({
      direction: 'targeted_revision',
      cause: 'test',
      reviewCount: 1,
      artifact: HEAD,
      target: 'test',
      orchestratorAttribution: 'orchestrator-bot',
    });
    assert.ok(formatted.includes('Orchestrator: orchestrator-bot'));
  });
});
