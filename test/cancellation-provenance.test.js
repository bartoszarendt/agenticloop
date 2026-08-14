import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createCancellationProvenance,
  validateAuthoritativeCancellationProvenance,
  validateCancellationProvenance,
} from '../src/cancellation-provenance.js';

const INVOCATION = 'invocation:123e4567-e89b-12d3-a456-426614174000';
const REQUEST = 'cancellation-request:123e4567-e89b-12d3-a456-426614174001';

function provenance(patch = {}) {
  return createCancellationProvenance({
    invocation: { controller: 'agenticloop', invocationId: INVOCATION, command: 'node', args: ['task.js'] },
    request: { authority: 'agenticloop', requestId: REQUEST, invocationId: INVOCATION, requestedAt: '2026-08-12T10:00:00.000Z' },
    observation: { observer: 'agenticloop', requestId: REQUEST, invocationId: INVOCATION, observedAt: '2026-08-12T10:00:01.000Z', state: 'observed' },
    ...patch,
  });
}

describe('cancellation provenance', () => {
  it('accepts structurally valid but unauthenticated cancellation claims', () => {
    assert.equal(validateCancellationProvenance(provenance()).ok, true);
  });

  it('never promotes a caller-created structural lookalike into cancellation authority', () => {
    const checked = validateAuthoritativeCancellationProvenance(provenance());
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('; '), /positive cancellation authority is unavailable/);
  });

  for (const [name, hostState] of [
    ['natural end-turn', { thread: 'end_turn', session: 'natural' }],
    ['interrupted end-turn', { thread: 'end_turn', session: 'interrupted' }],
    ['thread end-turn plus session budget pause', { thread: 'end_turn', session: 'budget_reached' }],
    ['accepted-but-ignored interrupt', { interrupt: 'accepted', effect: 'ignored_during_pause' }],
  ]) {
    it(`does not produce protected cancellation authority from ${name} host state`, () => {
      const structural = validateCancellationProvenance(hostState);
      const authoritative = validateAuthoritativeCancellationProvenance(hostState);
      assert.equal(structural.ok, false, 'host state is outside the closed cancellation-claim schema');
      assert.equal(authoritative.ok, false);
      assert.equal(Object.hasOwn(authoritative, 'authority'), false);

      const lookalike = validateAuthoritativeCancellationProvenance(provenance());
      assert.equal(lookalike.ok, false, 'even a closed structural claim lacks a protected receipt');
      assert.equal(Object.hasOwn(lookalike, 'authority'), false, 'no blocked-return cancellation authority is produced');
    });
  }

  it('rejects a host status change without an AL cancellation observation', () => {
    const record = structuredClone(provenance());
    record.observation.observer = 'host';
    assert.equal(validateCancellationProvenance(record).ok, false);
  });

  it('rejects a request observed for another logical invocation', () => {
    const record = structuredClone(provenance());
    record.observation.invocationId = 'invocation:123e4567-e89b-12d3-a456-426614174099';
    assert.equal(validateCancellationProvenance(record).ok, false);
  });
});
