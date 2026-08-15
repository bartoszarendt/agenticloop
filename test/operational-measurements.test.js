import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareOperationalMeasurements,
  createOperationalMeasurement,
  validateOperationalMeasurement,
} from '../src/operational-measurements.js';

function measurement(overrides = {}) {
  return createOperationalMeasurement({
    hostIdentity: 'host-fixture',
    hostRoleCapabilityDigest: `sha256:${'a'.repeat(64)}`,
    enforcementStates: { dispatch: 'enforced', return: 'advisory' },
    activationAssurance: 'operator_confirmed',
    returnAssurance: 'session_reported',
    hostAdmissionEvidenceGrade: 'missing',
    executionState: 'new',
    counters: { dispatchAttempts: 1, typedRefusals: 1 },
    milestones: { authorizationToPreflight: 12 },
    sizes: { actingContextBytes: 1000, dispatchPacketBytes: 100, returnPacketBytes: 120, orientationBytes: 300 },
    disposition: { maxRegressionPercent: 25, result: 'bounded' },
    ...overrides,
  });
}

describe('privacy-clean operational measurements', () => {
  it('uses explicit missing-data states and closed validation', () => {
    const value = measurement();
    assert.equal(validateOperationalMeasurement(value).ok, true);
    assert.equal(value.milestones.packetToHostAdmission.state, 'missing');
    assert.equal(value.run.executionState, 'new');
  });

  it('compares constant enforcement strata and rejects profile changes', () => {
    const before = measurement();
    const after = measurement({ sizes: { actingContextBytes: 1100, dispatchPacketBytes: 100, returnPacketBytes: 120, orientationBytes: 300 } });
    assert.equal(compareOperationalMeasurements(before, after).ok, true);
    const different = measurement({ returnAssurance: 'host_signed' });
    assert.equal(compareOperationalMeasurements(before, different).state, 'unmatched_stratum');
  });

  it('rejects an unexplained unbounded context regression', () => {
    const before = measurement();
    const after = measurement({ sizes: { actingContextBytes: 2000, dispatchPacketBytes: 100, returnPacketBytes: 120, orientationBytes: 300 } });
    const result = compareOperationalMeasurements(before, after);
    assert.equal(result.ok, false);
    assert.equal(result.state, 'unexplained_regression');
  });

  it('bounds observed milestone-duration regressions', () => {
    const before = measurement({ milestones: { authorizationToPreflight: 10 } });
    const after = measurement({ milestones: { authorizationToPreflight: 30 } });
    const result = compareOperationalMeasurements(before, after);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('authorizationToPreflight')));
  });
});
