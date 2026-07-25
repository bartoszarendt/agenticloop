/**
 * Tests for src/resolution-matrix.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResolutionMatrix,
  validateResolutionMatrix,
  formatResolutionMatrix,
  VALID_DISPOSITIONS,
} from '../src/resolution-matrix.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

function matrixBody(entries) {
  const lines = ['## Revision Resolution', ''];
  for (const entry of entries) {
    let line = `- [${entry.id}] ${entry.disposition}: ${entry.evidence}`;
    if (entry.reference) line += ` [ref: ${entry.reference}]`;
    lines.push(line);
  }
  return lines.join('\n');
}

describe('parseResolutionMatrix', () => {
  it('returns found=false when no matrix section present', () => {
    const result = parseResolutionMatrix('some text without a matrix');
    assert.equal(result.found, false);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.errors, []);
  });

  it('parses a complete matrix with mixed dispositions', () => {
    const text = matrixBody([
      { id: 'F-1', disposition: 'resolved', evidence: 'Fixed on commit ' + HEAD },
      { id: 'F-2', disposition: 'disputed', evidence: 'Scope was declared', reference: 'maintainer comment 5' },
      { id: 'F-3', disposition: 'blocked', evidence: 'External dependency', reference: 'issue #42' },
    ]);
    const result = parseResolutionMatrix(text);
    assert.equal(result.found, true);
    assert.equal(result.entries.length, 3);
    assert.equal(result.errors.length, 0);
    assert.equal(result.entries[0].findingId, 'F-1');
    assert.equal(result.entries[0].disposition, 'resolved');
    assert.equal(result.entries[1].findingId, 'F-2');
    assert.equal(result.entries[1].disposition, 'disputed');
    assert.equal(result.entries[1].reference, 'maintainer comment 5');
    assert.equal(result.entries[2].findingId, 'F-3');
    assert.equal(result.entries[2].disposition, 'blocked');
  });

  it('accepts "None" for no findings', () => {
    const text = '## Revision Resolution\n\nNone.\n';
    const result = parseResolutionMatrix(text);
    assert.equal(result.found, true);
    assert.equal(result.entries.length, 0);
    assert.deepEqual(result.errors, []);
  });

  it('detects duplicate finding IDs', () => {
    const text = matrixBody([
      { id: 'F-1', disposition: 'resolved', evidence: 'Fixed' },
      { id: 'F-1', disposition: 'disputed', evidence: 'Also disputed' },
    ]);
    const result = parseResolutionMatrix(text);
    assert.ok(result.errors.some(e => /duplicate/i.test(e)));
  });

  it('handles entries without references', () => {
    const text = matrixBody([
      { id: 'F-1', disposition: 'resolved', evidence: 'Fixed on commit abc123' },
    ]);
    const result = parseResolutionMatrix(text);
    assert.equal(result.found, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].reference, null);
  });
});

describe('validateResolutionMatrix', () => {
  it('passes when no prior findings exist', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: [],
      entries: [{ findingId: 'F-1', disposition: 'resolved', evidence: 'Fixed' }],
    });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => /no prior findings/i.test(w)));
  });

  it('passes with a complete valid matrix', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1', 'F-2'],
      entries: [
        { findingId: 'F-1', disposition: 'resolved', evidence: 'Fixed on ' + HEAD },
        { findingId: 'F-2', disposition: 'disputed', evidence: 'Scope was declared in the linked task', reference: 'maintainer comment 5' },
      ],
      currentArtifact: HEAD,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('fails when a prior finding is missing from the matrix', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1', 'F-2', 'F-3'],
      entries: [
        { findingId: 'F-1', disposition: 'resolved', evidence: 'Fixed' },
        { findingId: 'F-2', disposition: 'resolved', evidence: 'Fixed' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /F-3.*no row/i.test(e)));
  });

  it('fails when a finding has unknown disposition', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1'],
      entries: [
        { findingId: 'F-1', disposition: 'ignored', evidence: 'Not relevant' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /unknown disposition/i.test(e)));
  });

  it('fails when a finding has empty evidence', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1'],
      entries: [
        { findingId: 'F-1', disposition: 'resolved', evidence: '' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /empty evidence/i.test(e)));
  });

  it('fails when a blocked finding prevents review-ready', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1'],
      entries: [
        { findingId: 'F-1', disposition: 'blocked', evidence: 'External dependency' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /blocked.*cannot proceed/i.test(e)));
  });

  it('rejects extra entries not matching prior findings', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1'],
      entries: [
        { findingId: 'F-1', disposition: 'resolved', evidence: 'Fixed' },
        { findingId: 'F-99', disposition: 'resolved', evidence: 'Extra' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => /F-99.*does not match/i.test(error)));
  });

  it('rejects disputed items without a durable reference', () => {
    const result = validateResolutionMatrix({
      requiredFindingIds: ['F-1'],
      entries: [
        { findingId: 'F-1', disposition: 'disputed', evidence: 'Not my fault' },
      ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => /disputed.*no durable maintainer reference/i.test(error)));
  });
});

describe('formatResolutionMatrix', () => {
  it('produces valid parseable output', () => {
    const entries = [
      { findingId: 'F-1', disposition: 'resolved', evidence: 'Fixed on ' + HEAD },
      { findingId: 'F-2', disposition: 'disputed', evidence: 'Scope declared', reference: 'comment 5' },
    ];
    const formatted = formatResolutionMatrix(entries);
    assert.ok(formatted.includes('## Revision Resolution'));
    assert.ok(formatted.includes('[F-1] resolved:'));
    assert.ok(formatted.includes('[F-2] disputed:'));
    assert.ok(formatted.includes('[ref: comment 5]'));

    const parsed = parseResolutionMatrix(formatted);
    assert.equal(parsed.found, true);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.errors.length, 0);
  });
});

describe('VALID_DISPOSITIONS', () => {
  it('contains exactly resolved, disputed, blocked', () => {
    assert.ok(VALID_DISPOSITIONS.has('resolved'));
    assert.ok(VALID_DISPOSITIONS.has('disputed'));
    assert.ok(VALID_DISPOSITIONS.has('blocked'));
    assert.equal(VALID_DISPOSITIONS.size, 3);
  });
});
