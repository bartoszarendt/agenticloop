/** Closeout event integrity tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCloseoutWorkflowDeltaFixture } from './helpers/closeout-workflow-delta-fixture.js';

const fixture = createCloseoutWorkflowDeltaFixture();
const { makeGitTarget, commitAll, certify, recordCompleteMarker, statusState, closeoutEvent } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('append-only closeout event deltas', () => {
  it('fails closed when an event log is rewritten or carries disallowed events', async () => {
    const target = await makeGitTarget('event-rewrite');
    mkdirSync(join(target, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target, '.agenticloop', 'logs', 'T-001.jsonl'), `${closeoutEvent('T-001')}\n`, 'utf-8');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // Rewriting history is never append-only: the original record's bytes
    // change even though a new record is appended behind it.
    const rewritten = { ...JSON.parse(closeoutEvent('T-001')), summary: 'Tampered history.' };
    writeFileSync(
      join(target, '.agenticloop', 'logs', 'T-001.jsonl'),
      `${JSON.stringify(rewritten)}\n${closeoutEvent('T-001')}\n`,
      'utf-8'
    );
    commitAll(target, 'rewrite event log');
    let state = await statusState(target);
    assert.notEqual(state.state, 'complete');

    // A disallowed event type fails closed.
    const target2 = await makeGitTarget('event-type');
    const artifact2 = await certify(target2);
    await recordCompleteMarker(target2, artifact2);
    mkdirSync(join(target2, '.agenticloop', 'logs'), { recursive: true });
    const bad = { ...JSON.parse(closeoutEvent('T-001')), event_type: 'summary.published' };
    writeFileSync(join(target2, '.agenticloop', 'logs', 'T-001.jsonl'), `${JSON.stringify(bad)}\n`, 'utf-8');
    commitAll(target2, 'disallowed event');
    state = await statusState(target2);
    assert.notEqual(state.state, 'complete');

    // Malformed JSON fails closed.
    const target3 = await makeGitTarget('event-malformed');
    const artifact3 = await certify(target3);
    await recordCompleteMarker(target3, artifact3);
    mkdirSync(join(target3, '.agenticloop', 'logs'), { recursive: true });
    writeFileSync(join(target3, '.agenticloop', 'logs', 'T-001.jsonl'), '{not json}\n', 'utf-8');
    commitAll(target3, 'malformed event');
    state = await statusState(target3);
    assert.notEqual(state.state, 'complete');
  });
});
