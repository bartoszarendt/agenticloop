/**
 * A packet must survive the repairs the toolkit itself demands.
 *
 * Two of six field attempts were abandoned for expiry rather than for any
 * semantic reason. The packet lost its dispatch liveness window while the
 * Orchestrator was performing preflight-mandated repairs; a later attempt
 * expired mid-cycle again forty minutes on, and the run then compressed the
 * remaining work into one pass specifically to beat the clock.
 *
 * The window was a hand-written hour. It was measuring how long a delegation
 * cycle takes, not whether anything the packet binds had changed - and every
 * one of those bindings is revalidated at consumption anyway.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DISPATCH_LIVENESS_WINDOW_SECONDS } from '../src/dispatch-eligibility.js';
import { DEFAULT_GRANT_TTL_SECONDS } from '../src/activation-grant.js';

describe('the dispatch liveness window is derived, not hand-sized', () => {
  it('outlasts a multi-delegation recovery cycle', () => {
    // The field cycle - preflight, abandon, refresh, remint, delegate - ran well
    // past an hour every time it was attempted.
    assert.ok(
      DISPATCH_LIVENESS_WINDOW_SECONDS > 3600,
      'the hand-written hour is what expired mid-cycle'
    );
    assert.ok(
      DISPATCH_LIVENESS_WINDOW_SECONDS >= 4 * 3600,
      'a window that does not cover several hours does not scale to multi-hour autonomy'
    );
  });

  it('never outlives the operator authorization a default grant carries', () => {
    // The bound it genuinely must respect: a packet cannot stay consumable
    // longer than the authorization that permitted it.
    assert.ok(DISPATCH_LIVENESS_WINDOW_SECONDS <= DEFAULT_GRANT_TTL_SECONDS);
  });
});
