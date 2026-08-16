import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCommitAttribution } from '../src/commit-attribution.js';
import { recognizeHandoff } from '../src/handoff-recognition.js';
import { validateTaskStatusTransition } from '../src/task-transition.js';
import { pathIdentity } from '../src/path-identity.js';

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

  it('transient invalid lifecycle mutation and ambiguous attribution fail closed', () => {
    assert.match(validateTaskStatusTransition('accepted', 'in-progress'), /Cannot transition/);
    const attribution = evaluateCommitAttribution({ taskId: 'T-001', role: 'engineer', message: 'work\n\nTask: T-001\nAgent: maintainer' });
    assert.equal(attribution.ok, false);
  });

  it('scratch, carrier, and product roots remain explicit identities', () => {
    const carrier = pathIdentity('C:/fixture/.agenticloop/tasks/T-001.md');
    const product = pathIdentity('C:/fixture/src/product.js');
    assert.notEqual(carrier.authorityPath, product.authorityPath);
    assert.ok(carrier.authorityPath);
    assert.ok(product.authorityPath);
  });

  it('terminal states (accepted, closed) reject transition to in-progress', () => {
    assert.match(validateTaskStatusTransition('accepted', 'in-progress'), /Cannot transition/);
    assert.match(validateTaskStatusTransition('closed', 'in-progress'), /Cannot transition/);
    assert.match(validateTaskStatusTransition('closed', 'agent-ready'), /Cannot transition/);
  });

  it('blocked to in-progress requires dispatch packet context', () => {
    // blocked → in-progress is a valid transition path but requires a dispatch packet
    // The transition contract itself allows it; the dispatch handler enforces the packet
    const result = validateTaskStatusTransition('blocked', 'in-progress');
    assert.equal(result, null, 'blocked → in-progress should be a valid transition path');
  });

  it('handoff recognition with mismatched role fails closed', () => {
    const result = recognizeHandoff({
      transition: 'role_start',
      expectation: { taskId: 'T-001', roleId: 'maintainer' },
      preparedDispatch: { taskId: 'T-001', assignment: { roleId: 'engineer' } },
    });
    assert.equal(result.recognized, false);
  });

  it('commit attribution rejects mismatched task id in trailer', () => {
    const attribution = evaluateCommitAttribution({
      taskId: 'T-001',
      role: 'engineer',
      message: 'implement feature\n\nTask: T-002\nAgent: engineer',
    });
    assert.equal(attribution.ok, false, 'mismatched task id should fail attribution');
  });

  it('commit attribution rejects mismatched role in trailer', () => {
    const attribution = evaluateCommitAttribution({
      taskId: 'T-001',
      role: 'engineer',
      message: 'implement feature\n\nTask: T-001\nAgent: maintainer',
    });
    assert.equal(attribution.ok, false, 'mismatched role should fail attribution');
  });

  it('path identity distinguishes handoff evidence from task carriers', () => {
    const handoff = pathIdentity('C:/project/.agenticloop/handoffs/dispatch/T-001/consumption.json');
    const carrier = pathIdentity('C:/project/.agenticloop/tasks/T-001.md');
    const verification = pathIdentity('C:/project/.agenticloop/returns/verifications/abc123.json');
    assert.notEqual(handoff.authorityPath, carrier.authorityPath);
    assert.notEqual(carrier.authorityPath, verification.authorityPath);
    assert.notEqual(handoff.authorityPath, verification.authorityPath);
  });

  it('handoff recognition without expectation fields fails closed', () => {
    const result = recognizeHandoff({ transition: 'role_start' });
    assert.equal(result.recognized, false);
    assert.equal(result.authenticated, false);
  });

  it('valid forward transitions succeed in the contract', () => {
    // draft → agent-ready is the canonical first-dispatch path
    const draftToReady = validateTaskStatusTransition('draft', 'agent-ready');
    assert.equal(draftToReady, null, 'draft → agent-ready should succeed');
    // agent-ready → in-progress is the canonical role-start path
    const readyToProgress = validateTaskStatusTransition('agent-ready', 'in-progress');
    assert.equal(readyToProgress, null, 'agent-ready → in-progress should succeed');
    // in-progress → blocked is the canonical blocked path
    const progressToBlocked = validateTaskStatusTransition('in-progress', 'blocked', 'blocking reason');
    assert.equal(progressToBlocked, null, 'in-progress → blocked should succeed');
    // blocked → in-progress is the canonical resume path
    const blockedToProgress = validateTaskStatusTransition('blocked', 'in-progress');
    assert.equal(blockedToProgress, null, 'blocked → in-progress should succeed');
  });

  it('in-progress → agent-ready rejects re-dispatch without closeout', () => {
    const result = validateTaskStatusTransition('in-progress', 'agent-ready');
    assert.equal(typeof result, 'string', 'in-progress → agent-ready should be blocked');
    assert.match(result, /Cannot transition/);
  });
});
