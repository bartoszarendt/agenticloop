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

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DISPATCH_LIVENESS_WINDOW_SECONDS } from '../src/dispatch-eligibility.js';
import { DEFAULT_GRANT_TTL_SECONDS } from '../src/activation-grant.js';
import { dispatchPreparationDigest, validateDispatchPreparation } from '../src/dispatch-envelope.js';
import { createDispatchFixture, prepare } from './helpers/dispatch-fixture.js';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'al-liveness-')); });
after(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

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
    // The window is derived, not coincidentally equal: the constant must read
    // its value from the grant TTL so the two can never drift silently.
    assert.equal(DISPATCH_LIVENESS_WINDOW_SECONDS, DEFAULT_GRANT_TTL_SECONDS);
  });
});

describe('the window gates consumption, and stops gating once consumed', () => {
  /**
   * Widening the window only postpones the failure it was widened to fix. The
   * clock was also being re-applied every time an *already consumed* packet was
   * revalidated - at return verification, acceptance, and closeout - so an
   * attempt that ran long enough was retired for elapsed time alone while every
   * fact it bound still held.
   *
   * The rule those boundaries already follow for the stronger authority is that
   * expiry is not retroactive: a consumed attempt's activation grant is judged
   * as of the consumption that used it, not the current clock. The packet's own
   * window is the same kind of clock and is now judged the same way.
   */
  async function expiredPacket() {
    const fixture = await createDispatchFixture(temp, 'liveness-window');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation?.errors?.join('\n'));
    const packet = structuredClone(prepared.packet);
    // The packet stands for one whose window elapsed while the attempt it
    // authorized was still being repaired, reviewed, and closed out.
    packet.assignment.liveness.expiry = new Date(Date.now() - 1000).toISOString();
    packet.digest = dispatchPreparationDigest(packet);
    return { fixture, packet, consumedAt: Date.parse(packet.assignment.liveness.expiry) - 60_000 };
  }

  it('refuses an elapsed packet when it would authorize new work', async () => {
    const { fixture, packet } = await expiredPacket();
    const checked = validateDispatchPreparation(packet, fixture.options);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /dispatch liveness window has expired/);
  });

  it('accepts the same packet when judged at the instant it was consumed', async () => {
    const { fixture, packet, consumedAt } = await expiredPacket();
    const checked = validateDispatchPreparation(packet, { ...fixture.options, now: consumedAt });
    assert.doesNotMatch(
      checked.errors.join('\n'),
      /dispatch liveness window has expired/,
      'an attempt already authorized must not be retired for time that passed after it started'
    );
  });
});
