import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrEvidence } from '../src/github-preflight.js';
import { parseReviewMarker } from '../src/review-history.js';
import { parseResolutionMatrix } from '../src/resolution-matrix.js';

function namedFencedBlock(relativePath, name) {
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const marker = `<!-- agenticloop:canonical-${name} -->`;
  const markerIndex = text.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${relativePath} must name its canonical ${name} block`);
  const fenceStart = text.indexOf('```', markerIndex);
  const contentStart = text.indexOf('\n', fenceStart) + 1;
  const fenceEnd = text.indexOf('\n```', contentStart);
  assert.notEqual(fenceEnd, -1, `${relativePath} canonical ${name} block must close its fence`);
  return text.slice(contentStart, fenceEnd).trim();
}

describe('published Markdown contract extraction', () => {
  it('extracts and parses the canonical needs_revision marker from its acting skill', () => {
    const marker = namedFencedBlock('../skills/review-and-accept/SKILL.md', 'review-marker needs_revision');
    const parsed = parseReviewMarker(marker, { author: { login: 'loop-bot', type: 'User' } });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.findingIds, ['F-1']);
  });

  for (const relativePath of [
    '../skills/review-and-accept/SKILL.md',
    '../backends/github.md',
    '../docs/workflow-examples.md',
  ]) {
    for (const [name, status] of [
      ['review-marker accepted', 'accepted'],
      ['review-marker needs_revision', 'needs_revision'],
    ]) {
      it(`extracts the canonical ${status} marker from ${relativePath}`, () => {
        const marker = namedFencedBlock(relativePath, name);
        const parsed = parseReviewMarker(marker, { author: { login: 'loop-bot', type: 'User' } });
        assert.deepEqual(parsed.errors, []);
        assert.equal(parsed.status, status);
        if (status === 'needs_revision') assert.ok(parsed.findingIds.every(id => /^F-[1-9]\d*$/.test(id)) && parsed.findingIds.length > 0);
      });
    }
  }

  it('extracts and parses the canonical resolution bullet entries from its acting skill', () => {
    const matrix = namedFencedBlock('../skills/review-and-accept/SKILL.md', 'resolution');
    const parsed = parseResolutionMatrix(matrix);
    assert.equal(parsed.status, 'parsed');
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.entries.map(entry => entry.findingId), ['F-1', 'F-2', 'F-3']);
  });

  it('extracts the canonical PR evidence entry from its acting skill', () => {
    const evidence = namedFencedBlock('../skills/verification-evidence/SKILL.md', 'pr-evidence');
    const parsed = parsePrEvidence(evidence);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.entries, [{
      check: '[RC-1] `npm test`',
      id: 'RC-1',
      verdict: 'passed',
      evidence: 'final runs 1 and 2 passed: 128 passing, 0 failing (exit 0)',
    }]);
  });
});
