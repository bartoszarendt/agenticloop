import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCommitAttribution, parseFinalTrailerBlock } from '../src/commit-attribution.js';

describe('role-aware commit attribution', () => {
  it('accepts a Maintainer decomposition trailer through the shared parser', () => {
    const result = evaluateCommitAttribution({
      taskId: 'T-001',
      role: 'maintainer',
      message: 'decompose work\n\nTask: T-001\nAgent: maintainer\n',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(parseFinalTrailerBlock('decompose work\n\nTask: T-001\nAgent: maintainer').named.map(item => item.value), ['T-001', 'maintainer']);
  });

  it('rejects the wrong role and uppercase role identity', () => {
    const wrong = evaluateCommitAttribution({
      taskId: 'T-001', role: 'maintainer',
      message: 'work\n\nTask: T-001\nAgent: engineer',
    });
    assert.equal(wrong.ok, false);
    assert.ok(wrong.errors.some(error => error.includes("wrong Agent trailer 'engineer'")));

    const uppercase = evaluateCommitAttribution({
      taskId: 'T-001', role: 'maintainer',
      message: 'work\n\nTask: T-001\nAgent: Maintainer',
    });
    assert.equal(uppercase.ok, false);
    assert.ok(uppercase.errors.some(error => error.includes("wrong Agent trailer 'Maintainer'")));
  });

  it('rejects invalid roles and non-contiguous trailer blocks', () => {
    const invalidRole = evaluateCommitAttribution({
      taskId: 'T-001', role: 'reviewer',
      message: 'work\n\nTask: T-001\nAgent: reviewer',
    });
    assert.equal(invalidRole.ok, false);
    assert.ok(invalidRole.diagnostics.some(item => item.code === 'attribution.role'));

    const separated = evaluateCommitAttribution({
      taskId: 'T-001', role: 'maintainer',
      message: 'work\n\nTask: T-001\n\nAgent: maintainer',
    });
    assert.equal(separated.ok, false);
    assert.ok(separated.errors.some(error => error.includes('missing Task trailer')));
  });
});
