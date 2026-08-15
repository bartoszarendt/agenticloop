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
});
