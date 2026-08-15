import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createExecutionReuseDecision, validateExecutionReuseDecision } from '../src/execution-reuse.js';

const current = {
  taskId: 'T-001', backend: 'files', roleId: 'engineer', host: 'opencode',
  hostCapability: true, dispatchLive: true, dispatchUnconsumed: true,
  cancellationBoundary: 'return_on_cancellation', protectedContractUnchanged: true,
  carrierLineageValid: true, roleIdentityMatches: true,
  hostExecutionReferenceCurrent: true, durableRefetchSucceeded: true,
};

describe('bounded same-task execution reuse', () => {
  it('records resumed execution only when every condition is current', () => {
    const decision = createExecutionReuseDecision(current);
    assert.equal(decision.execution.state, 'resumed');
    assert.equal(decision.execution.authority, 'none');
    assert.equal(decision.independence.required, false);
    assert.equal(validateExecutionReuseDecision(decision, { taskId: 'T-001' }).ok, true);
  });

  it('falls back to new execution when a durable condition is missing', () => {
    const decision = createExecutionReuseDecision({ ...current, carrierLineageValid: false });
    assert.equal(decision.execution.state, 'new');
    assert.match(decision.execution.reason, /carrierLineageValid/);
  });

  it('requires fresh independent execution for Auditor work', () => {
    const decision = createExecutionReuseDecision({ ...current, roleId: 'auditor' });
    assert.equal(decision.execution.state, 'new');
    assert.equal(decision.independence.required, true);
    assert.equal(validateExecutionReuseDecision(decision).ok, true);
  });
});
