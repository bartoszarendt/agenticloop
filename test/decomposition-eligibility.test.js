import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDecompositionEligibilityProjection,
  validateDecompositionEligibilityProjection,
} from '../src/decomposition-eligibility.js';

const CONTRACT = `sha256:v1:${'a'.repeat(64)}`;

function scan() {
  return {
    workUnit: { id: 'work-unit:T-001', backend: 'files' },
    inventory: {
      complete: true,
      members: [{ taskId: 'T-001', state: 'ready', carrier: '.agenticloop/tasks/T-001.md', digest: `sha256:${'b'.repeat(64)}` }],
    },
    readyTaskIds: ['T-001'],
    excluded: [],
    eligibility: [{ taskId: 'T-001', eligibility: 'eligible' }],
    knowledgeCoupling: [{ taskId: 'T-001', classification: 'independent' }],
    couplingBlockers: [],
    candidatePairs: [],
    conclusion: 'not_currently_eligible',
    decomposition: { state: 'complete' },
    readinessContext: { digest: `sha256:readiness:${'c'.repeat(64)}`, dependencies: { 'T-002': 'complete' } },
  };
}

describe('stable decomposition eligibility projection', () => {
  it('is closed and ignores carrier-only digest observation churn', () => {
    const first = createDecompositionEligibilityProjection({
      taskId: 'T-001', backend: 'files', contractDigest: CONTRACT, scan: scan(),
      taskFacts: { requiredChecks: 'npm test', scope: ['src/**'] },
    });
    const changedCarrier = scan();
    changedCarrier.inventory.members[0].digest = `sha256:${'d'.repeat(64)}`;
    const second = createDecompositionEligibilityProjection({
      taskId: 'T-001', backend: 'files', contractDigest: CONTRACT, scan: changedCarrier,
      taskFacts: { requiredChecks: 'npm test', scope: ['src/**'] },
    });
    assert.equal(first.digest, second.digest);
    assert.equal(validateDecompositionEligibilityProjection(first, { taskId: 'T-001', backend: 'files' }).ok, true);
  });

  it('changes when membership or dependency evidence changes', () => {
    const first = createDecompositionEligibilityProjection({ taskId: 'T-001', backend: 'files', contractDigest: CONTRACT, scan: scan() });
    const changed = scan();
    changed.readyTaskIds = [];
    changed.readinessContext.dependencies = { 'T-002': 'blocked' };
    const second = createDecompositionEligibilityProjection({ taskId: 'T-001', backend: 'files', contractDigest: CONTRACT, scan: changed });
    assert.notEqual(first.digest, second.digest);
  });
});
