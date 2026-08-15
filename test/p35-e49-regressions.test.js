import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCommitAttribution } from '../src/commit-attribution.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { createExecutionReuseDecision, validateExecutionReuseDecision } from '../src/execution-reuse.js';
import { createOperationalMeasurement } from '../src/operational-measurements.js';
import { validateTaskStatusTransition } from '../src/task-transition.js';
import { pathIdentity } from '../src/path-identity.js';

const currentReuse = {
  taskId: 'T-001', backend: 'files', roleId: 'engineer', host: 'synthetic-host',
  hostCapability: true, dispatchLive: true, dispatchUnconsumed: true,
  cancellationBoundary: 'return_on_cancellation', protectedContractUnchanged: true,
  carrierLineageValid: true, roleIdentityMatches: true,
  hostExecutionReferenceCurrent: true, durableRefetchSucceeded: true,
};

describe('P35-E49 privacy-clean synthetic regressions', () => {
  it('raw dispatch and return bypass cannot create an authenticated role start', () => {
    const result = recognizeHandoff({ transition: 'role_start', expectation: { taskId: 'T-001', roleId: 'engineer' } });
    assert.equal(result.authenticated, false);
    assert.equal(result.recognized, false);
  });

  it('Engineer start from draft and missing trusted baseline remain blocked', () => {
    assert.match(validateTaskStatusTransition('draft', 'in-progress'), /Cannot transition/);
    assert.match(validateTaskStatusTransition(undefined, 'agent-ready'), /current task status is missing/);
  });

  it('activation scope is not operator authorization', () => {
    const decision = createExecutionReuseDecision({ ...currentReuse, protectedContractUnchanged: false });
    assert.equal(decision.execution.state, 'new');
    assert.equal(decision.execution.authority, 'none');
  });

  it('transient invalid lifecycle mutation and ambiguous attribution fail closed', () => {
    assert.match(validateTaskStatusTransition('accepted', 'in-progress'), /Cannot transition/);
    const attribution = evaluateCommitAttribution({ taskId: 'T-001', role: 'engineer', message: 'work\n\nTask: T-001\nAgent: maintainer' });
    assert.equal(attribution.ok, false);
  });

  it('cross-shell, UTC, and duration observations use bounded structured evidence', () => {
    const measurement = createOperationalMeasurement({
      hostIdentity: 'synthetic-host',
      hostRoleCapabilityDigest: `sha256:${'a'.repeat(64)}`,
      enforcementStates: { process: 'enforced' },
      activationAssurance: 'operator_confirmed',
      returnAssurance: 'session_reported',
      hostAdmissionEvidenceGrade: 'missing',
      milestones: { roleStartToCanonicalReturn: 42 },
    });
    assert.equal(measurement.milestones.roleStartToCanonicalReturn.state, 'observed');
    assert.equal(measurement.milestones.acceptanceToAuditCloseout.state, 'missing');
    assert.doesNotMatch(JSON.stringify(measurement), /transcript|session store|credential|stdout/i);
  });

  it('scratch, carrier, and product roots remain explicit identities', () => {
    const carrier = pathIdentity('C:/fixture/.agenticloop/tasks/T-001.md');
    const product = pathIdentity('C:/fixture/src/product.js');
    assert.notEqual(carrier.authorityPath, product.authorityPath);
    assert.ok(carrier.authorityPath);
    assert.ok(product.authorityPath);
  });

  it('repeated orientation/context cost has a bounded measurement disposition', () => {
    const decision = createExecutionReuseDecision(currentReuse);
    assert.equal(validateExecutionReuseDecision(decision).ok, true);
    const measurement = createOperationalMeasurement({
      hostIdentity: 'synthetic-host', hostRoleCapabilityDigest: `sha256:${'b'.repeat(64)}`,
      enforcementStates: { orientation: 'enforced' }, sizes: { orientationBytes: 200, repeatedOrientationCount: 1 },
      disposition: { result: 'bounded', maxRegressionPercent: 25 },
    });
    assert.equal(measurement.disposition.result, 'bounded');
  });

  it('preserves positive operator activation, role separation, exact review authority, and stop boundaries', () => {
    const decision = createExecutionReuseDecision(currentReuse);
    assert.equal(decision.roleId, 'engineer');
    assert.equal(decision.execution.authority, 'none');
    assert.equal(decision.independence.required, false);
  });
});
