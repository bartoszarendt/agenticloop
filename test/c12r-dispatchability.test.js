/**
 * P35-C12R.0/.2 characterization: one canonical dispatchability answer.
 *
 * C12-F1 recorded that `task handoff-preflight` and `task prepare-dispatch`
 * both accepted a `draft` task, and the refusal only arrived at role start as
 * an illegal `draft -> in-progress` transition - inside the Engineer session,
 * after delegation, for a Maintainer-owned prerequisite.
 *
 * The invariant these cases pin: preflight, packet preparation, and role start
 * share one lifecycle gate derived from the single legal-transition authority,
 * so a green preflight over unchanged facts cannot be refused later, and a
 * refusal names the owning repair instead of a downstream symptom.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDispatchFixture, git as fixtureGit, prepare, sha256 } from './helpers/dispatch-fixture.js';

import {
  DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE,
  DISPATCHABLE_TASK_STATUSES,
  ROLE_START_STATUS,
  TERMINAL_TASK_STATUSES,
  evaluateDispatchableLifecycle,
  evaluatePacketDispatchableLifecycle,
  taskStatusFromBody,
} from '../src/dispatchability.js';
import {
  KNOWN_TASK_STATUSES,
  LEGAL_TASK_STATUS_TRANSITIONS,
  validateTaskStatusTransition,
} from '../src/task-transition.js';
import { evaluateHandoffPreflight } from '../src/handoff-preflight.js';
import { createTaskProjectFixture } from './helpers/task-fixture.js';
import { git } from './helpers/git-fixture.js';
import { makePreflightTask, makeDecomposition } from './helpers/c12r-preflight-fixture.js';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'al-c12r-dispatchability-')); });
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function makeTarget(name) {
  const target = mkdtempSync(join(tmpDir, `${name}-`));
  createTaskProjectFixture(target);
  return target;
}

function preflight(target, taskId) {
  return evaluateHandoffPreflight({
    target,
    taskId,
    backend: 'files',
    projectConfig: {},
    io: {},
  });
}

describe('P35-C12R lifecycle dispatchability is one derived rule', () => {
  it('accepts exactly the statuses that can legally reach a role start', () => {
    for (const status of KNOWN_TASK_STATUSES) {
      const reachesRoleStart = status === ROLE_START_STATUS ||
        LEGAL_TASK_STATUS_TRANSITIONS[status].has(ROLE_START_STATUS);
      assert.equal(
        evaluateDispatchableLifecycle(status).ok,
        reachesRoleStart,
        `dispatchability for '${status}' must match the legal-transition authority`
      );
    }
    assert.ok(!DISPATCHABLE_TASK_STATUSES.includes('draft'));
    assert.ok(!DISPATCHABLE_TASK_STATUSES.includes('accepted'));
    assert.ok(!DISPATCHABLE_TASK_STATUSES.includes('closed'));
    assert.ok(DISPATCHABLE_TASK_STATUSES.includes('agent-ready'));
  });

  it('never reports dispatchable where role start would refuse', () => {
    // The property C12-F1 violated, checked over the whole status domain.
    for (const status of [...KNOWN_TASK_STATUSES, 'nonsense', '', null]) {
      const dispatchable = evaluateDispatchableLifecycle(status).ok;
      const roleStartRefusal = validateTaskStatusTransition(status, ROLE_START_STATUS, null);
      assert.equal(
        dispatchable,
        roleStartRefusal === null,
        `dispatchability and role start disagree about '${String(status)}'`
      );
    }
  });

  it('classifies unknown state as unevaluable rather than as a negative answer', () => {
    assert.equal(evaluateDispatchableLifecycle(null).evidenceState, 'missing');
    assert.equal(evaluateDispatchableLifecycle('   ').evidenceState, 'missing');
    assert.equal(evaluateDispatchableLifecycle('made-up').evidenceState, 'malformed');
    assert.equal(evaluateDispatchableLifecycle('draft').evidenceState, 'negative');
  });

  it('enforces the pre-execution half of the rule inside the packet constructor', () => {
    // The disclosed narrowing: packet preparation refuses everything that has
    // not yet reached an execution attempt, and leaves terminal statuses to
    // preflight until P35-C12R.5 gives the closeout fixtures a truthful
    // carrier-generation chain.
    for (const status of ['draft', '', null, 'made-up']) {
      assert.equal(evaluatePacketDispatchableLifecycle(status).ok, false, String(status));
    }
    for (const status of DISPATCHABLE_TASK_STATUSES) {
      assert.equal(evaluatePacketDispatchableLifecycle(status).ok, true, status);
    }
    for (const status of TERMINAL_TASK_STATUSES) {
      const packetLevel = evaluatePacketDispatchableLifecycle(status);
      assert.equal(packetLevel.ok, true, `${status} is deferred, not accepted as correct`);
      assert.equal(packetLevel.enforcedAt, 'preflight');
      assert.equal(evaluateDispatchableLifecycle(status).ok, false, `${status} is still non-dispatchable`);
    }
  });

  it('reads the status from a task record body', () => {
    assert.equal(taskStatusFromBody('---\ntask_id: T-1\nstatus: draft\n---\n\n# body\n'), 'draft');
    assert.equal(taskStatusFromBody('no frontmatter at all'), null);
  });
});

describe('P35-C12R the packet constructor applies the same gate', () => {
  it('refuses to mint a packet for a draft task', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'c12r-draft-packet');
    const body = readFileSync(fixture.taskPath, 'utf8');
    const draftBody = body.replace(/^status: .*$/m, 'status: draft');
    writeFileSync(fixture.taskPath, draftBody, 'utf8');
    // Commit it, so the refusal is the lifecycle gate and not the clean gate.
    fixtureGit(fixture.root, ['add', '-A']);
    fixtureGit(fixture.root, ['commit', '-m', 'set draft\n\nTask: T-001\nAgent: maintainer']);
    const snapshot = fixture.snapshot();

    const prepared = prepare(fixture, {
      refetchTask: () => ({ ...snapshot, body: draftBody, digest: sha256(draftBody) }),
    });
    assert.equal(prepared.ok, false, 'a draft task must never receive a dispatch packet');
    const messages = prepared.validation.errors.join(' ');
    assert.match(messages, /cannot begin an execution attempt/);
    assert.match(messages, /draft/);
  });

  it('mints a packet for the same task once it is agent-ready', async () => {
    const fixture = await createDispatchFixture(tmpDir, 'c12r-ready-packet');
    const prepared = prepare(fixture);
    assert.equal(prepared.ok, true, prepared.validation.errors?.join('\n'));
  });

  it('pins the disclosed terminal-status narrowing so its removal is visible', async () => {
    // Today `prepareRoleDispatch` accepts a terminal status and preflight
    // refuses it. That asymmetry is the P35-C12R.5 deferral, not a decision:
    // this case exists so closing the gate is a deliberate change here, never a
    // silent one. Deleting it is part of the reopen gate.
    const fixture = await createDispatchFixture(tmpDir, 'c12r-terminal-packet');
    const body = readFileSync(fixture.taskPath, 'utf8');
    const acceptedBody = body.replace(/^status: .*$/m, 'status: accepted');
    writeFileSync(fixture.taskPath, acceptedBody, 'utf8');
    fixtureGit(fixture.root, ['add', '-A']);
    fixtureGit(fixture.root, ['commit', '-m', 'set accepted\n\nTask: T-001\nAgent: maintainer']);
    const snapshot = fixture.snapshot();

    const prepared = prepare(fixture, {
      refetchTask: () => ({ ...snapshot, body: acceptedBody, digest: sha256(acceptedBody) }),
    });
    // Whatever else this fixture's evidence does or does not satisfy, the one
    // thing the constructor must not currently say is that the lifecycle blocks
    // it. When the narrowing is removed, this assertion fails and has to be
    // deleted deliberately.
    const codes = (prepared.validation.diagnostics ?? []).map(item => item.code);
    assert.equal(
      codes.includes(DISPATCHABLE_LIFECYCLE_DIAGNOSTIC_CODE),
      false,
      'deferred, not refused; see evaluatePacketDispatchableLifecycle'
    );
    assert.equal(evaluateDispatchableLifecycle('accepted').ok, false, 'the canonical rule still refuses it');
    assert.equal(evaluatePacketDispatchableLifecycle('accepted').enforcedAt, 'preflight');
  });
});

describe('P35-C12R preflight refuses what role start would refuse', () => {
  it('blocks a draft task at preflight with the owning repair', () => {
    const target = makeTarget('draft');
    makePreflightTask(target, 'T-018', { status: 'draft' });
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'task\n\nTask: T-018\nAgent: maintainer']);
    makeDecomposition(target, 'T-018');

    const result = preflight(target, 'T-018');
    assert.equal(result.ok, false, 'a draft task must never reach a green preflight');
    assert.equal(result.lifecycle.status, 'draft');
    assert.equal(result.lifecycle.dispatchable, false);
    const lifecycleError = result.diagnostics.find(item => item.code === 'task.lifecycle.not_dispatchable');
    assert.ok(lifecycleError, `expected a lifecycle diagnostic, got: ${result.diagnostics.map(d => d.code).join(', ')}`);
    assert.match(lifecycleError.repairHint, /npx agenticloop task status T-018 agent-ready/);
    // The lifecycle prerequisite is Maintainer-owned authoring work, so the
    // refusal routes there rather than to the role that would have run.
    assert.equal(lifecycleError.category, 'task_contract');
  });

  it('reports an agent-ready task as lifecycle-dispatchable', () => {
    const target = makeTarget('ready');
    makePreflightTask(target, 'T-019', { status: 'agent-ready' });
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'task\n\nTask: T-019\nAgent: maintainer']);
    makeDecomposition(target, 'T-019');

    const result = preflight(target, 'T-019');
    assert.equal(result.lifecycle.status, 'agent-ready');
    assert.equal(result.lifecycle.dispatchable, true);
    assert.equal(
      result.diagnostics.some(item => item.code === 'task.lifecycle.not_dispatchable'),
      false
    );
  });

  it('blocks terminal statuses without inventing a restart repair', () => {
    const target = makeTarget('accepted');
    makePreflightTask(target, 'T-016', { status: 'accepted' });
    git(target, ['add', '-A']);
    git(target, ['commit', '-m', 'task\n\nTask: T-016\nAgent: maintainer']);
    // A terminal task is already excluded from decomposition eligibility, so
    // there is deliberately no decomposition source to build here.

    const result = preflight(target, 'T-016');
    assert.equal(result.ok, false);
    const lifecycleError = result.diagnostics.find(item => item.code === 'task.lifecycle.not_dispatchable');
    assert.ok(lifecycleError);
    assert.match(lifecycleError.repairHint, /already completed its lifecycle/);
    assert.doesNotMatch(lifecycleError.repairHint, /set-status/);
  });
});
