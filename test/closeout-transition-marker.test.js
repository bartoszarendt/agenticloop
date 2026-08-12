/** Covered-task terminal transition marker tests. */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { createCloseoutWorkflowDeltaFixture } from './helpers/closeout-workflow-delta-fixture.js';

const fixture = createCloseoutWorkflowDeltaFixture();
const { makeGitTarget, taskPath, commitAll, certify, recordCompleteMarker, statusState } = fixture;
before(() => { fixture.setup(); });
after(() => { fixture.cleanup(); });

describe('covered-task terminal transitions', () => {
  it('recording a marker then closing another covered task does not stale the marker', async () => {
    const target = await makeGitTarget('non-carrier-close');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // The covered carrier task transitions accepted -> closed while retaining its marker.
    writeFileSync(taskPath(target, 'T-001'), readFileSync(taskPath(target, 'T-001'), 'utf8').replace(/^status: accepted$/m, 'status: closed'), 'utf8');
    commitAll(target, 'close T-001');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
    assert.equal(state.exit, 0, JSON.stringify(state));
  });

  it('closing multiple covered tasks including the carrier stays current', async () => {
    const target = await makeGitTarget('all-close');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    const carrierContent = readFileSync(taskPath(target, 'T-001'), 'utf-8');
    writeFileSync(taskPath(target, 'T-001'), carrierContent.replace(/^status: accepted$/m, 'status: closed'), 'utf-8');
    commitAll(target, 'close covered tasks');

    const state = await statusState(target);
    assert.equal(state.state, 'complete', JSON.stringify(state));
    assert.equal(state.exit, 0, JSON.stringify(state));
  });

  it('rejects arbitrary carrier edits while permitting the marker mutation itself', async () => {
    const target = await makeGitTarget('carrier-edit');
    const artifact = await certify(target);
    await recordCompleteMarker(target, artifact);

    // Substantive carrier body change beyond marker + status: drift.
    const carrier = taskPath(target, 'T-001');
    writeFileSync(carrier, readFileSync(carrier, 'utf-8').replace('# T-001', '# T-001 renamed'), 'utf-8');
    commitAll(target, 'edit carrier title');

    const state = await statusState(target);
    assert.notEqual(state.state, 'complete', JSON.stringify(state));
  });
});
