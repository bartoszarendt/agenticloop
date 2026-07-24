/**
 * Phase 27 event-logging compatibility.
 *
 * Auditor is a valid event role and a valid orchestrator delegation target, but
 * the audit verdict is never a task review result and the event schema version
 * does not change. Historical three-role logs must stay readable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_SCHEMA_VERSION,
  VALID_EVENT_ROLES,
  buildEvent,
  validateEvent,
  validateNewEvent,
} from '../src/event-logging.js';

function roleInvoked(targetRole) {
  return buildEvent({
    eventType: 'role.invoked',
    role: 'orchestrator',
    summary: `Delegated ${targetRole}`,
    data: {
      target_role: targetRole,
      delegation_mode: 'host_subagent',
      fallback: false,
    },
  });
}

describe('audit event compatibility', () => {
  it('keeps the event schema at version 1', () => {
    assert.equal(EVENT_SCHEMA_VERSION, 1);
    assert.equal(buildEvent({ eventType: 'task.started', summary: 'x' }).schema_version, 1);
  });

  it('accepts auditor as an event role', () => {
    assert.ok(VALID_EVENT_ROLES.has('auditor'));
    const event = buildEvent({ eventType: 'check.run', role: 'auditor', summary: 'Ran bounded audit check', outcome: 'success' });
    assert.deepEqual(validateEvent(event).errors, []);
  });

  it('accepts an orchestrator role.invoked delegation to auditor', () => {
    const result = validateNewEvent(roleInvoked('auditor'), {});
    assert.deepEqual(result.errors, [], result.errors.join('\n'));
  });

  it('still accepts delegation to maintainer and engineer', () => {
    for (const role of ['maintainer', 'engineer']) {
      assert.deepEqual(validateNewEvent(roleInvoked(role), {}).errors, []);
    }
  });

  it('rejects delegation to an unknown target role', () => {
    const result = validateNewEvent(roleInvoked('reviewer'), {});
    assert.ok(result.errors.some(e => e.includes('data.target_role must be one of')));
  });

  it('rejects a same-session fallback audit delegation like any other', () => {
    const event = buildEvent({
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated auditor',
      data: { target_role: 'auditor', delegation_mode: 'single_agent_fallback', fallback: false },
    });
    const result = validateNewEvent(event, {});
    assert.ok(result.errors.length > 0, 'a single_agent_fallback audit must not validate as a clean delegation');
  });

  it('does not represent an audit verdict as a task review result', () => {
    // review.result stays maintainer-owned with task review outcomes. An
    // auditor-emitted review.result carrying an audit verdict is not valid.
    const event = buildEvent({
      eventType: 'review.result',
      role: 'auditor',
      summary: 'certified',
      outcome: 'accepted',
      data: { review_mode: 'host_subagent', reviewed_artifact: 'commit:abc' },
    });
    const result = validateNewEvent(event, {});
    assert.ok(
      result.errors.some(e => e.includes('review.result must be emitted by the maintainer')),
      result.errors.join('\n')
    );
  });

  it('keeps historical three-role logs readable', () => {
    for (const role of ['orchestrator', 'maintainer', 'engineer', 'human', 'unknown']) {
      const event = buildEvent({ eventType: 'task.started', role, summary: 'historical entry' });
      assert.deepEqual(validateEvent(event).errors, [], `role ${role} must still validate`);
    }
    const historicalRoleInvoked = buildEvent({
      eventType: 'role.invoked',
      role: 'orchestrator',
      summary: 'Delegated engineer',
      data: { target_role: 'engineer', delegation_mode: 'explicit_agent_invocation', fallback: false },
    });
    assert.deepEqual(validateEvent(historicalRoleInvoked).errors, []);
  });
});
