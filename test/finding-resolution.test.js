import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFindingResolutionMatrix,
  metadataOnlyReviewDecision,
  validateFindingResolutionMatrix,
} from '../src/maintainer-fixup.js';

describe('metadata-only finding resolution', () => {
  it('routes record-only findings to the Maintainer without an Engineer round', () => {
    const matrix = createFindingResolutionMatrix({
      taskId: 'T-001',
      productArtifact: 'commit:product-head',
      workflowHead: 'commit:workflow-head',
      carrierHead: 'carrier:7',
      findings: [{ findingId: 'F-1', classification: 'record-only', disposition: 'resolved', evidence: 'corrected the review record only' }],
    });
    assert.equal(validateFindingResolutionMatrix(matrix, { taskId: 'T-001', currentProductArtifact: 'commit:product-head' }).ok, true);
    assert.deepEqual(metadataOnlyReviewDecision(matrix), {
      eligible: true,
      ownerRole: 'maintainer',
      engineerRevisionConsumed: false,
      reason: 'all findings are record-only and the exact product artifact and protected contract remain unchanged',
    });
  });

  it('requires Engineer re-review for product or contract changes and stale artifacts', () => {
    const matrix = createFindingResolutionMatrix({
      taskId: 'T-001',
      productArtifact: 'commit:product-head',
      workflowHead: 'commit:workflow-head',
      carrierHead: 'carrier:7',
      findings: [{ findingId: 'F-1', classification: 'implementation-changing', disposition: 'blocked', evidence: 'product change required' }],
    });
    assert.equal(metadataOnlyReviewDecision(matrix).engineerRevisionConsumed, true);
    assert.equal(validateFindingResolutionMatrix(matrix, { taskId: 'T-001', currentProductArtifact: 'commit:other-head' }).ok, false);
  });

  it('rejects advisory-only acceptance claims', () => {
    const matrix = createFindingResolutionMatrix({
      taskId: 'T-001',
      productArtifact: 'commit:product-head',
      workflowHead: 'commit:workflow-head',
      carrierHead: 'carrier:7',
      findings: [{ findingId: 'F-1', classification: 'record-only', disposition: 'resolved', evidence: 'score: 100' }],
    });
    const forged = structuredClone(matrix);
    forged.entries[0].evidence = 'host satisfied; accepted';
    assert.equal(validateFindingResolutionMatrix(forged).ok, false);
  });
});
