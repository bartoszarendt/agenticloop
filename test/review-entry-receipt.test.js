import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { taskContractDigest } from '../src/task-contract-baseline.js';
import { createReviewEntryReceipt, createReviewEntryFailurePacket, validateReviewEntryReceipt } from '../src/review-entry-receipt.js';
import { normalizeReviewRoleCarrier, REVIEW_ROLE_CARRIER_VERSION } from '../src/review-role-carrier.js';
import { createExceptionalVerification, receiveExceptionalVerification } from '../src/exceptional-verification.js';
import { formatReviewMarker, parseReviewMarker } from '../src/review-history.js';
import { deriveLifecycleClaims } from '../src/lifecycle-claims.js';
import { syntheticRecognizedVerdict } from './helpers/handoff-fixture.js';

// The handoff fixture derives a repository identity from this path only; no
// filesystem state is read, so a stable literal keeps the claim digests stable.
const HANDOFF_TARGET = 'review-entry-receipt-handoff-target';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BODY = [
  '---', 'task_id: T-035', 'independent_review_required: false', '---',
  '# T-035', '', '## Scope', 'Receipt coverage.', '', '## Out of Scope', 'None.', '',
  '## Acceptance Criteria', 'Receipt is current.', '', '## Required Checks', '- [RC-1] `npm test`',
].join('\n');

function material(head = HEAD, body = BODY) {
  const contract = taskContractDigest(body);
  const loaded = {
    input: {
      prData: {
        number: 35, headRefOid: head,
        commits: [{ oid: head, message: 'Implement receipt\n\nTask: T-035\nAgent: engineer' }],
      },
      issueData: { number: 35, body },
      reviewHistory: { events: [], errors: [] },
    },
  };
  return {
    loaded,
    result: {
      ok: true, errors: [], warnings: [], requiredChecks: [{ id: 'RC-1', text: '[RC-1] `npm test`', matchKey: 'npm test' }],
      evidenceMatches: [{ id: 'RC-1', check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'tests passed' }],
      contractBaseline: { digest: contract.digest, baseline: null },
    },
  };
}

describe('review-entry receipt authority', () => {
  it('authorizes only the exact current implementation head', () => {
    const { loaded, result } = material();
    const receipt = createReviewEntryReceipt(loaded, result, { observedAt: '2026-08-07T00:00:00.000Z' });
    assert.equal(receipt.lifecycle.claim, 'implementation_ready_for_review');
    assert.equal(receipt.lifecycle.completion, false);
    assert.equal(validateReviewEntryReceipt(receipt, loaded, result).ok, true);
    const changed = material(NEXT);
    assert.equal(validateReviewEntryReceipt(receipt, changed.loaded, changed.result).ok, false);
  });

  it('rejects task/check drift and preserves engineer ownership on a failed entry', () => {
    const { loaded, result } = material();
    const receipt = createReviewEntryReceipt(loaded, result, { observedAt: '2026-08-07T00:00:00.000Z' });
    const taskChanged = material(HEAD, `${BODY}\nChanged.`);
    assert.equal(validateReviewEntryReceipt(receipt, taskChanged.loaded, taskChanged.result).ok, false);
    const checksChanged = material();
    checksChanged.result.evidenceMatches[0].evidence = 'different evidence';
    assert.equal(validateReviewEntryReceipt(receipt, checksChanged.loaded, checksChanged.result).ok, false);
    const resume = createReviewEntryFailurePacket({ loaded, result: { ...result, ok: false, errors: ['missing trailer'] }, diagnostics: [] });
    assert.equal(resume.ownerRole, 'engineer');
    assert.equal(resume.validation.ok, false);
  });

  it('fails closed for a missing receipt, bad final trailers, and mixed object formats', () => {
    const { loaded, result } = material();
    assert.equal(validateReviewEntryReceipt(null, loaded, result).evidenceState, 'missing');
    const badTrailer = material();
    badTrailer.loaded.input.prData.commits[0].message = [
      'Task: T-035', 'Agent: engineer', '', 'Task: wrong', 'Agent: maintainer',
    ].join('\n');
    assert.throws(() => createReviewEntryReceipt(badTrailer.loaded, badTrailer.result), /final contiguous|stale Task|wrong Agent/);
    const mixed = material();
    mixed.loaded.input.prData.commits.push({ oid: 'b'.repeat(64), message: 'Task: T-035\nAgent: engineer' });
    assert.throws(() => createReviewEntryReceipt(mixed.loaded, mixed.result), /one object format/);
  });
});

describe('immutable review carrier roles', () => {
  it('maps legacy tokens and versioned fields to the same role while rejecting ambiguity', () => {
    const legacy = normalizeReviewRoleCarrier({ maintainer: 'maintainer' }, { expectedRoleId: 'maintainer', legacyField: 'maintainer' });
    const current = normalizeReviewRoleCarrier({ review_role_carrier: REVIEW_ROLE_CARRIER_VERSION, role_id: 'maintainer', actor_account: 'maintainer-bot' }, { expectedRoleId: 'maintainer', legacyField: 'maintainer' });
    assert.equal(legacy.roleId, current.roleId);
    const mixed = normalizeReviewRoleCarrier({ maintainer: 'maintainer', review_role_carrier: REVIEW_ROLE_CARRIER_VERSION, role_id: 'maintainer', actor_account: 'maintainer-bot' }, { expectedRoleId: 'maintainer', legacyField: 'maintainer' });
    assert.equal(mixed.ok, false);
  });

  it('keeps an account named after a role byte-exact and does not grant arbitrary legacy authority', () => {
    const current = normalizeReviewRoleCarrier({
      review_role_carrier: REVIEW_ROLE_CARRIER_VERSION, role_id: 'orchestrator', actor_account: 'orchestrator',
    }, { expectedRoleId: 'orchestrator', legacyField: 'orchestrator' });
    assert.equal(current.ok, true);
    assert.equal(current.actorAccount, 'orchestrator');
    const arbitrary = normalizeReviewRoleCarrier({ maintainer: 'engineer' }, {
      expectedRoleId: 'maintainer', legacyField: 'maintainer',
    });
    assert.equal(arbitrary.ok, false);
  });

  it('round-trips the canonical GitHub review marker writer', () => {
    const marker = formatReviewMarker({
      status: 'accepted', mode: 'host_subagent', artifact: HEAD, actorAccount: 'maintainer-bot',
    });
    const parsed = parseReviewMarker(marker);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.roleId, 'maintainer');
    assert.equal(parsed.actorAccount, 'maintainer-bot');
  });
});

describe('exceptional verification routing and lifecycle claims', () => {
  it('keeps exceptional evidence requested and routes only to the capability-derived owner', () => {
    const packet = { packetId: 'packet:1', digest: 'sha256:agenticloop.dispatch.v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    const request = createExceptionalVerification({
      requestId: 'exception:123e4567-e89b-12d3-a456-426614174000', producer: { roleId: 'engineer' },
      transition: { packetId: packet.packetId, digest: packet.digest }, check: { id: 'RC-1', failureOrUnavailability: 'unavailable' },
      evidence: { state: 'missing', detail: 'remote check did not return' }, proposedDisposition: 'exception_rejected',
      dispositionAuthority: { roleId: 'maintainer' }, nextResumableTransition: 'github_review_prepare', freshness: { invalidatedBy: ['check_evidence_changed'] },
    });
    const received = receiveExceptionalVerification({ request, packet, authenticatedProducerRole: 'engineer', allowedDispositionOwner: 'maintainer' });
    assert.equal(received.ok, true);
    assert.equal(received.state, 'exception_requested');
    assert.equal(received.route.ownerRole, 'maintainer');
    assert.equal(received.validation.ok, true);
    assert.deepEqual(received.validation.diagnostics, []);
    const forged = structuredClone(request);
    forged.dispositionAuthority.roleId = 'engineer';
    const rejected = receiveExceptionalVerification({ request: forged, packet, authenticatedProducerRole: 'engineer', allowedDispositionOwner: 'maintainer' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.route.ownerRole, 'engineer');
  });

  it('never derives completion from review readiness or prose-like inputs', () => {
    const { loaded, result } = material();
    const receipt = createReviewEntryReceipt(loaded, result, { observedAt: '2026-08-07T00:00:00.000Z' });
    const { verdict } = syntheticRecognizedVerdict(HANDOFF_TARGET, 'review_entry');
    const handoff = { review_entry: verdict };
    const claims = deriveLifecycleClaims({
      reviewEntry: { loaded, result, receipt },
      currentArtifact: HEAD,
      handoff,
    });
    assert.deepEqual(claims.map(item => item.claim), ['implementation_ready_for_review']);
    assert.equal(claims[0].handoffRecognitionDigest, verdict.digest);
    assert.deepEqual(deriveLifecycleClaims({
      reviewEntry: { validated: true, receipt }, currentArtifact: HEAD, handoff,
    }), []);
    // A correct receipt is still not a consumed handoff: without the canonical
    // chain the claim is not weakened, it is not made.
    assert.deepEqual(deriveLifecycleClaims({
      reviewEntry: { loaded, result, receipt }, currentArtifact: HEAD,
    }), []);
  });
});
