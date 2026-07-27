/**
 * Closeout contract tests: canonical digest, marker model, and deny-by-default
 * path classification.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, canonicalSha256 } from '../src/canonical-json.js';
import {
  classifyCloseoutPath,
  closeoutPacketDigest,
  closeoutProvenanceProjection,
  isTerminalTaskTransition,
  parseCloseoutMarkers,
  renderCloseoutMarker,
  resolveCurrentCloseoutMarkers,
  stripCloseoutMarkers,
  validateCloseoutPacket,
  validateWorkflowDeltaContent,
  workflowRecordSubstance,
} from '../src/closeout-contract.js';
import { validateEvent } from '../src/event-logging.js';

function basePacket(overrides = {}) {
  return {
    packet_schema: 1,
    work_unit: 'milestone:M00',
    covered_tasks: ['T-002', 'T-001'],
    candidate_artifact: 'commit:' + 'a'.repeat(40),
    audit: {
      audit_id: 'AUD-001',
      audit_schema_version: 2,
      run: 3,
      verdict: 'certified',
      report_format: 'auditor_report_v1',
    },
    audit_opt_out: false,
    backend: 'files',
    carrier: { kind: 'files_task_record', reference: '.agenticloop/tasks/T-002.md', revision: 'sha256:abc' },
    plan_sync: 'none',
    gates: [
      { id: 'audit_gate', passed: true },
      { id: 'covered_tasks', passed: true },
    ],
    finding_dispositions: [{ run: 2, finding_id: 'A-01', disposition: 'follow_up' }],
    improvement_refs: [],
    predecessor_marker: 'none',
    publishable: true,
    completion_eligible: true,
    recommended_status: 'complete',
    reasons: [],
    ...overrides,
  };
}

function closeoutEvent(taskId, overrides = {}) {
  return {
    schema_version: 1,
    event_id: '11111111-1111-4111-8111-111111111111',
    occurred_at: '2026-07-27T12:00:00Z',
    trace_id: '22222222-2222-4222-8222-222222222222',
    parent_event_id: null,
    task_id: taskId,
    backend: 'files',
    host: 'test',
    role: 'maintainer',
    event_type: 'task.closed',
    summary: 'Task closed after certification.',
    outcome: 'success',
    refs: [],
    data: {},
    ...overrides,
  };
}

describe('content-aware workflow deltas', () => {
  it('only recognizes an accepted-to-closed transition in YAML frontmatter', () => {
    const accepted = '---\ntask_id: T-001\nstatus: accepted\n---\n\n# Task';
    const closed = accepted.replace('status: accepted', 'status: closed');
    assert.equal(isTerminalTaskTransition(accepted, closed), true);

    const bodyAccepted = '---\ntask_id: T-001\nstatus: closed\n---\n\nstatus: accepted';
    const bodyClosed = bodyAccepted.replace(/status: accepted$/, 'status: closed');
    assert.equal(isTerminalTaskTransition(bodyAccepted, bodyClosed), false);
    assert.notEqual(workflowRecordSubstance(bodyAccepted), workflowRecordSubstance(bodyClosed));
  });

  it('binds appended closeout events to the path task, files backend, and unique event id', () => {
    const mismatch = validateWorkflowDeltaContent('event_log', {
      path: '.agenticloop/logs/T-001.jsonl',
      oldContent: '',
      newContent: `${JSON.stringify(closeoutEvent('T-999'))}\n`,
    }, { validateEvent });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /path-bound task 'T-001'/);

    const wrongBackend = validateWorkflowDeltaContent('event_log', {
      path: '.agenticloop/logs/T-001.jsonl',
      oldContent: '',
      newContent: `${JSON.stringify(closeoutEvent('T-001', { backend: 'github' }))}\n`,
    }, { validateEvent });
    assert.equal(wrongBackend.ok, false);
    assert.match(wrongBackend.error, /rather than 'files'/);

    const event = JSON.stringify(closeoutEvent('T-001'));
    const duplicate = validateWorkflowDeltaContent('event_log', {
      path: '.agenticloop/logs/T-001.jsonl',
      oldContent: `${event}\n`,
      newContent: `${event}\n${event}\n`,
    }, { validateEvent });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error, /duplicate event_id/);
  });
});

describe('canonical JSON', () => {
  it('orders object keys recursively and ignores insertion order', () => {
    const left = { b: 1, a: { z: 2, y: [3, { q: 1, p: 2 }] } };
    const right = { a: { y: [3, { p: 2, q: 1 }], z: 2 }, b: 1 };
    assert.equal(canonicalJson(left), canonicalJson(right));
    assert.equal(canonicalSha256(left), canonicalSha256(right));
  });

  it('produces stable bytes independent of line endings and path separators', () => {
    const win = { path: '.agenticloop\\tasks\\T-001.md', note: 'a\r\nb' };
    const posix = { path: '.agenticloop\\tasks\\T-001.md', note: 'a\r\nb' };
    assert.equal(canonicalJson(win), canonicalJson(posix));
    assert.equal(canonicalJson({ v: 'x' }), '{"v":"x"}');
  });

  it('rejects non-representable values', () => {
    assert.throws(() => canonicalJson({ v: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ v: undefined }), /undefined/);
    assert.throws(() => canonicalJson(() => {}), /function/);
  });
});

describe('closeout packet digest', () => {
  it('is identical across key insertion order and covered-task ordering', () => {
    const first = basePacket();
    const second = basePacket({
      covered_tasks: ['T-001', 'T-002'],
      gates: [
        { id: 'covered_tasks', passed: true },
        { id: 'audit_gate', passed: true },
      ],
    });
    assert.equal(closeoutPacketDigest(first), closeoutPacketDigest(second));
  });

  it('changes when any substantive fact changes', () => {
    const digest = closeoutPacketDigest(basePacket());
    assert.notEqual(closeoutPacketDigest(basePacket({ candidate_artifact: 'commit:' + 'b'.repeat(40) })), digest);
    assert.notEqual(closeoutPacketDigest(basePacket({ predecessor_marker: 'marker:0' })), digest);
    assert.notEqual(closeoutPacketDigest(basePacket({
      finding_dispositions: [{ run: 2, finding_id: 'A-01', disposition: 'no_action' }],
    })), digest);
  });

  it('excludes volatile presentation fields and the marker being produced', () => {
    const first = basePacket({ reasons: [{ gate: 'x', message: 'display text' }] });
    const second = basePacket({ reasons: [] });
    assert.equal(closeoutPacketDigest(first), closeoutPacketDigest(second));
    const projection = closeoutProvenanceProjection(basePacket());
    assert.ok(!('reasons' in projection));
    assert.ok(!('digest' in projection));
  });

  it('validates publishable/completion_eligible/recommended_status coherence', () => {
    assert.deepEqual(validateCloseoutPacket(basePacket()), []);
    assert.ok(validateCloseoutPacket(basePacket({ recommended_status: 'blocked' })).length > 0);
    assert.ok(validateCloseoutPacket(basePacket({ completion_eligible: false })).length > 0);
    const followUp = basePacket({
      completion_eligible: false,
      recommended_status: 'follow_up_required',
      marker_action: 'correct',
      reasons: [{ gate: 'audit_gate', category: 'audit_missing', message: 'missing', owner: 'maintainer', repair: null }],
    });
    assert.deepEqual(validateCloseoutPacket(followUp), []);
    // A truthful non-complete packet is publishable but never consumable as completion.
    assert.equal(followUp.completion_eligible, false);
  });
});

describe('closeout markers', () => {
  const digest = 'sha256:' + 'c'.repeat(64);

  it('renders the compatibility line first and parses every state', () => {
    for (const status of ['complete', 'follow_up_required', 'needs_context', 'blocked']) {
      const marker = renderCloseoutMarker({
        status,
        workUnit: 'milestone:M00',
        artifact: 'commit:' + 'a'.repeat(40),
        auditRef: 'AUD-001/run:3',
        predecessor: 'none',
        gateDigest: digest,
      });
      assert.ok(marker.startsWith(`AGENT_CLOSEOUT_STATUS: ${status}\n`));
      const parsed = parseCloseoutMarkers(marker);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].status, status);
      assert.equal(parsed[0].provenanced, true);
    }
  });

  it('recognizes legacy unprovenanced markers as history, not current completion', () => {
    const parsed = parseCloseoutMarkers('AGENT_CLOSEOUT_STATUS: complete\n\nsome note\n');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].status, 'complete');
    assert.equal(parsed[0].provenanced, false);
    const resolution = resolveCurrentCloseoutMarkers(parsed);
    assert.equal(resolution.legacy.length, 1);
  });

  it('fails closed on multiple unsuperseded current markers', () => {
    const text = [
      renderCloseoutMarker({ status: 'complete', workUnit: 'milestone:M00', artifact: 'a', gateDigest: 'sha256:1' }),
      '',
      renderCloseoutMarker({ status: 'blocked', workUnit: 'milestone:M00', artifact: 'a', gateDigest: 'sha256:2' }),
    ].join('\n');
    const resolution = resolveCurrentCloseoutMarkers(parseCloseoutMarkers(text));
    assert.equal(resolution.current.length, 2);
    assert.match(resolution.error, /multiple unsuperseded/);
  });

  it('supersedes deterministically by digest reference', () => {
    const firstDigest = `sha256:${'1'.repeat(64)}`;
    const secondDigest = `sha256:${'2'.repeat(64)}`;
    const first = renderCloseoutMarker({ status: 'complete', workUnit: 'milestone:M00', artifact: 'a', gateDigest: firstDigest });
    const second = renderCloseoutMarker({
      status: 'follow_up_required',
      workUnit: 'milestone:M00',
      artifact: 'a',
      gateDigest: secondDigest,
      supersedes: firstDigest,
    });
    const resolution = resolveCurrentCloseoutMarkers(parseCloseoutMarkers(`${first}\n\n${second}`));
    assert.equal(resolution.error, null);
    assert.equal(resolution.superseded.length, 1);
    assert.equal(resolution.current.length, 1);
    assert.equal(resolution.current[0].status, 'follow_up_required');
  });

  it('strips marker blocks and correction notes without touching other content', () => {
    const marker = renderCloseoutMarker({ status: 'complete', workUnit: 'milestone:M00', artifact: 'a', gateDigest: digest });
    const text = `- 2026-07-27: human note\n\n${marker}\n\n- 2026-07-27: closeout marker corrected; the superseded marker above is retained as history.\n\n- real comment\n`;
    const stripped = stripCloseoutMarkers(text);
    assert.ok(!stripped.includes('AGENT_CLOSEOUT'));
    assert.ok(!stripped.includes('closeout marker corrected'));
    assert.ok(stripped.includes('human note'));
    assert.ok(stripped.includes('real comment'));
  });
});

describe('path classification', () => {
  it('allows only bound or exact enumerated workflow metadata', () => {
    const options = {
      auditRecordRelPath: '.agenticloop/audits/AUD-001.md',
      allowedWorkflowPaths: ['.agenticloop/tmp/packet.json', '.agenticloop/improvements/I-2026-07-27-001.md'],
    };
    assert.equal(classifyCloseoutPath('.agenticloop/audits/AUD-001.md', options), 'audit_metadata');
    assert.equal(classifyCloseoutPath('.agenticloop/tmp/packet.json', options), 'workflow_metadata');
    assert.equal(classifyCloseoutPath('.agenticloop/improvements/I-2026-07-27-001.md', options), 'workflow_metadata');
  });

  it('is deny-by-default for product, unknown, and untracked paths', () => {
    const options = { auditRecordRelPath: '.agenticloop/audits/AUD-001.md' };
    assert.equal(classifyCloseoutPath('src/app.js', options), 'product');
    assert.equal(classifyCloseoutPath('package.json', options), 'product');
    assert.equal(classifyCloseoutPath('.agenticloop/audits/AUD-002.md', options), 'product');
    assert.equal(classifyCloseoutPath('brand-new-untracked.txt', options), 'product');
    assert.equal(classifyCloseoutPath('docs\\windows\\style.md', options), 'product');
    assert.equal(classifyCloseoutPath('', options), 'product');
  });
});
