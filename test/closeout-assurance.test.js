import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeCloseoutAssurance } from '../src/closeout.js';

const activation = {
  taskId: 'T-001', usable: true, activation: 'operator_confirmed',
  source: 'activation_grant', producer: 'agenticloop.cli.operator-confirmation.v1',
  channel: 'cli_interactive_confirmation', derivation: 'direct_operator_confirmation', reasons: [],
};

describe('closeout observed assurance', () => {
  it('fails standard mode when activation or observed return evidence is missing', () => {
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default',
      resolveTask: () => null,
      resolveReturns: () => ({ usable: false, records: [], reasons: [] }),
      returnCapabilityLimitation: 'a capable adapter is registered',
    }, ['T-001']);
    assert.equal(result.ok, false);
    assert.equal(result.report.observed_return_assurance, null);
    assert.ok(result.reasons.some(item => item.category === 'activation_evidence_absent'));
  });

  it('does not let a return-capable adapter substitute for an observed hardened receipt', () => {
    const result = summarizeCloseoutAssurance({
      mode: 'hardened', policySource: 'operator_pin',
      resolveTask: () => ({ ...activation, activation: 'host_signed' }),
      resolveReturns: () => ({ usable: false, records: [], reasons: [] }),
      returnCapabilityLimitation: 'returnReceipt supported',
    }, ['T-001']);
    assert.equal(result.ok, false);
    assert.match(result.reasons.map(item => item.message).join('\n'), /observed return assurance 'missing'/);
  });

  it('allows an explicit standard compatibility waiver without inventing either grade', () => {
    const waiver = {
      waiverId: 'legacy-waiver:fixture',
      waivedDimensions: ['activation_evidence_absent', 'return_evidence_absent'],
    };
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default', legacyWaiver: waiver,
      resolveTask: () => null,
      resolveReturns: () => ({ usable: false, records: [], reasons: [] }),
    }, ['T-001']);
    assert.equal(result.ok, true);
    assert.equal(result.report.tasks[0].activation, null);
    assert.equal(result.report.observed_return_assurance, null);
    assert.deepEqual(result.report.compatibility_waiver.waivedDimensions, ['activation_evidence_absent', 'return_evidence_absent']);

    const hardened = summarizeCloseoutAssurance({
      mode: 'hardened', policySource: 'operator_pin', legacyWaiver: waiver,
      resolveTask: () => null,
      resolveReturns: () => ({ usable: false, records: [], reasons: [] }),
    }, ['T-001']);
    assert.equal(hardened.ok, false);
    assert.equal(hardened.report.compatibility_waiver, null);
  });

  it('never lets a missing-evidence waiver suppress revoked or invalid evidence', () => {
    const waiver = { waiverId: 'legacy-waiver:fixture', waivedDimensions: ['activation_evidence_absent', 'return_evidence_absent'] };
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default', legacyWaiver: waiver,
      resolveTask: () => ({ usable: false, activation: null, failureCategory: 'activation_revoked', reasons: ['revoked'] }),
      resolveReturns: () => ({ usable: false, records: [], failureCategory: 'host_receipt_invalid', reasons: ['invalid receipt'] }),
    }, ['T-001']);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some(item => item.category === 'activation_revoked'));
    assert.ok(result.reasons.some(item => item.category === 'host_receipt_invalid'));
  });
});
