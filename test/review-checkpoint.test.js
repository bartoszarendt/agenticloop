/**
 * Tests for src/review-checkpoint.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function documentedCheckpoint(relativePath, carrier) {
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const marker = `<!-- agenticloop:canonical-checkpoint ${carrier} -->`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `${relativePath} must name its canonical checkpoint block`);
  const fenceStart = text.indexOf('```text', start);
  const contentStart = text.indexOf('\n', fenceStart) + 1;
  const fenceEnd = text.indexOf('\n```', contentStart);
  assert.notEqual(fenceEnd, -1, `${relativePath} canonical checkpoint block must close its fence`);
  return text.slice(contentStart, fenceEnd).trim();
}

function checkpointText({
  direction = 'targeted_revision',
  cause = 'implementation_defect',
  reviewCount = DEFAULT_REVIEW_BUDGET,
  artifact = HEAD,
  target = 'fix failing test evidence',
  reference = null,
   orchestrator = 'orchestrator',
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
    assert.ok(result.errors.some(e => /complete Git object identity/i.test(e)));
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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

  it('counts legacy needs_revision outcomes against the review budget', () => {
    const result = evaluateReviewCheckpoint({
      reviewOutcomes: [
        { status: 'needs_revision', artifact: HEAD, legacyMissingFindingIds: true },
        { status: 'needs_revision', artifact: HEAD, legacyMissingFindingIds: true },
      ],
      budget: 2,
      requireRevision: true,
    });
    assert.equal(result.authorized, false);
    assert.match(result.errors.join('\n'), /budget.*exhausted|checkpoint.*required/i);
  });

  it('treats a legacy outcome after a checkpoint as checkpoint consumption', () => {
    const checkpoint = {
      type: 'checkpoint', sourceOrder: 1,
      direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 1,
      artifact: HEAD, target: 'repair F-1', orchestratorAttribution: 'orchestrator-bot',
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
    };
    const result = evaluateReviewCheckpoint({
      reviewHistory: [
        { type: 'outcome', status: 'needs_revision', artifact: HEAD, sourceOrder: 0 },
        checkpoint,
        { type: 'outcome', status: 'needs_revision', artifact: 'b'.repeat(40), sourceOrder: 2, legacyMissingFindingIds: true },
      ],
      budget: 1,
      requireRevision: true,
    });
    assert.equal(result.authorized, false);
    assert.match(result.errors.join('\n'), /checkpoint has been consumed/i);
  });

  it('keeps mixed canonical and legacy outcomes in chronological checkpoint accounting', () => {
    const legacyArtifact = 'b'.repeat(40);
    const result = evaluateReviewCheckpoint({
      reviewHistory: [
        { type: 'outcome', status: 'needs_revision', artifact: HEAD, sourceOrder: 0 },
        { type: 'outcome', status: 'needs_revision', artifact: legacyArtifact, sourceOrder: 1, legacyMissingFindingIds: true },
        {
          type: 'checkpoint', sourceOrder: 2,
          direction: 'targeted_revision', cause: 'implementation_defect', reviewCount: 2,
          artifact: legacyArtifact, target: 'repair the reviewed artifact', orchestratorAttribution: 'orchestrator-bot',
          roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
        },
      ],
      budget: 2,
      requireRevision: true,
    });
    assert.equal(result.authorized, true, result.errors.join('\n'));
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects null checkpoint', () => {
    const result = validateCheckpointSchema(null);
    assert.equal(result.valid, false);
  });

  it('applies role-ID and carrier-version checks to hand-built checkpoints without a carrier discriminator', () => {
    const result = validateCheckpointSchema({
      direction: 'targeted_revision',
      cause: 'implementation_defect',
      reviewCount: 3,
      artifact: HEAD,
      target: 'fix tests',
      orchestratorAttribution: 'orchestrator-bot',
      roleId: 'maintainer',
      roleCarrierSchemaVersion: 9,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /role ID must be immutable 'orchestrator'/.test(e)));
    assert.ok(result.errors.some(e => /review role carrier version is invalid/.test(e)));
  });

  it('never coerces a declared-but-unresolved carrier version into legacy schema version 0', () => {
    const text = [
      '<!-- AGENTIC_LOOP_REVIEW_ROUND_CHECKPOINT -->',
      '',
      '## Review Round Checkpoint',
      '',
      '- Direction: targeted_revision',
      '- Cause: implementation_defect',
      '- Review count: 1',
      `- Artifact: ${HEAD}`,
      '- Target: fix tests',
      '- Review role carrier: agenticloop.review-role-carrier/v9',
      '- Role ID: orchestrator',
      '- Actor account: orchestrator-bot',
      '',
    ].join('\n');
    const parsed = parseReviewCheckpoint(text);
    assert.equal(parsed.found, true);
    assert.equal(parsed.checkpoint.roleCarrierSchemaVersion, null);
    const schema = validateCheckpointSchema(parsed.checkpoint);
    assert.equal(schema.valid, false);
    assert.ok(schema.errors.some(e => /review role carrier version is invalid/.test(e)));
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
    assert.ok(result.errors.some(e => /complete Git object identity/i.test(e)));
  });

  it('lists canonical direction and cause values at both validation entry points', () => {
    const parsed = parseReviewCheckpoint(checkpointText({ direction: 'continue', cause: 'unknown' }));
    const schema = validateCheckpointSchema({
      direction: 'continue', cause: 'unknown', reviewCount: 1, artifact: HEAD, orchestratorAttribution: 'orchestrator-bot',
    });
    for (const result of [parsed, schema]) {
      const text = result.errors.join('\n');
      for (const direction of VALID_DIRECTIONS) assert.match(text, new RegExp(direction));
      assert.match(text, /implementation_defect/);
      assert.match(text, /external_blocker/);
    }
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
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
      roleId: 'orchestrator', roleCarrierSchemaVersion: 1,
    });
    assert.ok(formatted.includes('Role ID: orchestrator'));
    assert.ok(formatted.includes('Actor account: orchestrator-bot'));
  });
});

describe('published checkpoint contracts', () => {
  const checkpoint = {
    direction: 'targeted_revision',
    cause: 'implementation_defect',
    reviewCount: 5,
    artifact: HEAD,
    target: 'F-2: refresh the current-head verification evidence',
    orchestratorAttribution: 'orchestrator-bot',
  };

  for (const relativePath of [
    '../AGENTIC_LOOP.md',
    '../skills/role-delegation/SKILL.md',
    '../backends/github.md',
  ]) {
    it(`${relativePath} extracts and round-trips the canonical GitHub checkpoint`, () => {
      const documented = documentedCheckpoint(relativePath, 'github');
      assert.equal(documented, formatCheckpoint(checkpoint).trim());
      assert.deepEqual(parseReviewCheckpoint(documented).errors, []);
    });
  }

  it('backends/files.md extracts and round-trips the canonical files checkpoint', () => {
    const documented = documentedCheckpoint('../backends/files.md', 'files');
    const filesCheckpoint = {
      ...checkpoint,
      artifact: 'commit:abc123',
      target: 'F-2: refresh the local verification evidence',
      // New files carriers keep the durable role ID distinct from local actor
      // attribution; legacy `Orchestrator:` entries remain parseable.
      orchestratorAttribution: 'orchestrator',
    };
    assert.equal(documented, formatCheckpoint(filesCheckpoint, { carrier: 'files' }).trim());
    assert.deepEqual(parseReviewCheckpoint(documented, { carrier: 'files' }).errors, []);
  });
});
