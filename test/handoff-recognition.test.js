/**
 * Canonical handoff recognition coverage.
 *
 * Every case here answers one question: can this evidence authorize a protected
 * lifecycle transition? The adversarial cases are derived failure classes - a
 * raw role prompt, a stale or replayed packet, a return someone rebuilt by hand,
 * assurance below the required minimum - not a reproduction of any host session.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  HANDOFF_OBSERVATION_GRADE,
  HANDOFF_RECOGNITION_CODES,
  HANDOFF_RECOGNITION_KIND,
  HANDOFF_RECOGNITION_SCHEMA_VERSION,
  PROTECTED_HANDOFF_TRANSITIONS,
  PROTECTED_HANDOFF_TRANSITION_IDS,
  createHandoffExpectation,
  createPreparedDispatchValidation,
  gradeObservedHandoffEvidence,
  handoffRecognitionDigest,
  recognizeHandoff,
  recognizeStoredReturnHandoff,
  validateHandoffRecognition,
} from '../src/handoff-recognition.js';
import { canonicalDispatchValidator } from '../src/handoff-binding.js';
import { createReturnVerification, returnVerificationPath } from '../src/return-verification.js';
import {
  DISPATCH_PREPARATION_SCHEMA_VERSION,
  dispatchPreparationDigest,
  prepareRoleDispatch,
  validateDispatchPreparation,
} from '../src/dispatch-envelope.js';
import { deriveLifecycleClaims } from '../src/lifecycle-claims.js';
import { summarizeCloseoutAssurance } from '../src/closeout.js';
import { createDispatchFixture, git } from './helpers/dispatch-fixture.js';
import {
  HANDOFF_RETURN_ID,
  fixtureDispatchValidator,
  handoffExpectation,
  recognizedVerdict,
  verifiedReturnFixture,
} from './helpers/handoff-fixture.js';
import { runCliInProcess } from './helpers/run-cli.js';
import { protectedHostBoundary } from './helpers/host-trust-fixture.js';
import { taskBodyDigest } from '../src/github-task-body.js';
import { taskContractDigest } from '../src/task-contract-baseline.js';
import { createReviewEntryReceipt } from '../src/review-entry-receipt.js';
import {
  createDispatchConsumption,
  currentDispatchConsumption,
  dispatchConsumptionDigest,
  dispatchConsumptionRelativePath,
  listDispatchConsumptions,
  validateDispatchConsumption,
} from '../src/handoff-consumption.js';

let temp;
let dispatch;
let packet;

before(async () => {
  temp = mkdtempSync(join(tmpdir(), 'al-handoff-recognition-'));
  dispatch = await createDispatchFixture(temp, 'handoff');
  mkdirSync(join(dispatch.root, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(dispatch.root, '.agenticloop', 'tmp', 'dispatch-input.json'), JSON.stringify({
    activation: dispatch.activation,
    assignment: dispatch.assignment,
    readiness: dispatch.readiness,
    decomposition: dispatch.decomposition,
    priorGateReceipts: dispatch.priorGateReceipts,
  }, null, 2), 'utf8');
  const prepared = await runCliInProcess([
    'task', 'prepare-dispatch', 'T-001',
    '--input', '.agenticloop/tmp/dispatch-input.json',
    '--return-adapter', dispatch.trust.adapterId,
    '--target', dispatch.root,
  ], cliOptions());
  assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
  packet = JSON.parse(prepared.stdout);
});
after(() => { rmSync(temp, { recursive: true, force: true }); });

function roleStartExpectation(overrides = {}) {
  return {
    backend: 'files',
    taskId: packet.task.id,
    roleId: 'engineer',
    taskContractDigest: packet.task.contractDigest,
    dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
    packetId: packet.packetId,
    packetDigest: packet.digest,
    workUnitIdentity: packet.decomposition.workUnitId,
    productBaseHead: packet.repository.head,
    worktreeRoot: packet.repository.worktree,
    minimumActivationAssurance: 'operator_confirmed',
    ...overrides,
  };
}

function codes(verdict) {
  return verdict.diagnostics.map(item => item.code);
}

function currentTaskDigest(content) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** The canonical dispatch validator both halves of the seam require. */
function validator() {
  return fixtureDispatchValidator(dispatch);
}

/**
 * One exact-head review-entry material set, matching the canonical fixture in
 * `review-entry-receipt.test.js`. Only the receipt matters here; the point of
 * these cases is what the claim requires beside a correct receipt.
 */
function reviewEntryMaterial() {
  const head = 'a'.repeat(40);
  const body = [
    '---', 'task_id: T-035', 'independent_review_required: false', '---',
    '# T-035', '', '## Scope', 'Receipt coverage.', '', '## Out of Scope', 'None.', '',
    '## Acceptance Criteria', 'Receipt is current.', '', '## Required Checks', '- [RC-1] `npm test`',
  ].join('\n');
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
  const result = {
    ok: true, errors: [], warnings: [],
    requiredChecks: [{ id: 'RC-1', text: '[RC-1] `npm test`', matchKey: 'npm test' }],
    evidenceMatches: [{ id: 'RC-1', check: '[RC-1] `npm test`', verdict: 'passed', evidence: 'tests passed' }],
    contractBaseline: { digest: taskContractDigest(body).digest, baseline: null },
  };
  const receipt = createReviewEntryReceipt(loaded, result, { observedAt: '2026-08-07T00:00:00.000Z' });
  return { loaded, result, receipt };
}

/** The operator-owned roots the real command reads activation policy from. */
function cliOptions() {
  return {
    operatorTrustRoot: dispatch.operatorTrustRoot,
    operatorActivationRoot: dispatch.operatorActivationRoot,
    hostAuthority: protectedHostBoundary(dispatch.trust),
  };
}

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

describe('protected handoff contract', () => {
  it('declares a closed transition inventory and a closed diagnostic vocabulary', () => {
    assert.deepEqual(PROTECTED_HANDOFF_TRANSITION_IDS,
      ['role_start', 'review_entry', 'acceptance', 'integration', 'closeout']);
    assert.equal(PROTECTED_HANDOFF_TRANSITIONS.role_start.requirement, 'prepared_dispatch');
    for (const id of ['review_entry', 'acceptance', 'integration', 'closeout']) {
      assert.equal(PROTECTED_HANDOFF_TRANSITIONS[id].requirement, 'verified_return');
    }
    assert.equal(new Set(HANDOFF_RECOGNITION_CODES).size, HANDOFF_RECOGNITION_CODES.length);
    assert.equal(Object.isFrozen(PROTECTED_HANDOFF_TRANSITIONS), true);
  });

  it('rejects an unknown transition instead of defaulting to a permissive one', () => {
    const verdict = recognizeHandoff({ transition: 'merge', expectation: roleStartExpectation() });
    assert.equal(verdict.recognized, false);
    assert.deepEqual(codes(verdict), ['handoff.transition.unsupported']);
    assert.equal(verdict.disposition, 'rejected');
    assert.equal(verdict.transition, null);
    assert.equal(validateHandoffRecognition(verdict).ok, true);
  });

  it('reports a malformed expectation as its own typed root cause', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: { backend: 'gitlab', taskId: '', roleId: 'engineer' },
      preparedDispatch: packet,
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual([...new Set(codes(verdict))], ['handoff.expectation.malformed']);
    // The evidence was never evaluated, so nothing about it is reported.
    assert.equal(verdict.boundIdentity.packetId, null);
  });

  it('closes the expectation schema against unknown fields', () => {
    const checked = createHandoffExpectation({
      backend: 'files', taskId: 'T-001', roleId: 'engineer', trustMe: true,
    });
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /unknown field\(s\): trustMe/);
  });

  it('detects a tampered verdict through its own digest', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
    });
    assert.equal(validateHandoffRecognition(verdict).ok, true);
    const forged = { ...verdict, recognized: true, diagnostics: [], evidenceState: 'current' };
    const rewritten = { ...forged, transition: 'closeout' };
    assert.equal(validateHandoffRecognition(rewritten).ok, false);
    assert.notEqual(handoffRecognitionDigest(rewritten), rewritten.digest);
  });

  it('refuses a verdict that recognizes a handoff while reporting why it could not', () => {
    const refused = recognizeHandoff({ transition: 'role_start', expectation: roleStartExpectation() });
    const contradictory = { ...refused, recognized: true, evidenceState: 'current', disposition: 'proceed' };
    const resealed = { ...contradictory, digest: handoffRecognitionDigest(contradictory) };
    const checked = validateHandoffRecognition(resealed);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /cannot carry recognition diagnostics/);
  });
});

// ---------------------------------------------------------------------------
// Role start: a raw invocation is observation, never authority
// ---------------------------------------------------------------------------

describe('role start recognition', () => {
  it('documents digest-bound integrity without validator-authentication claims', () => {
    for (const path of [
      join(process.cwd(), 'AGENTIC_LOOP.md'),
      join(process.cwd(), 'docs', 'cli-reference.md'),
      join(process.cwd(), 'skills', 'role-delegation', 'SKILL.md'),
    ]) {
      const text = readFileSync(path, 'utf8');
      assert.match(text, /unkeyed|integrity only/i, path);
      assert.match(text, /does not authenticate|not validator\s+identity|not validator authentication/i, path);
      assert.doesNotMatch(text, /validation (?:receipt|record|result) (?:authenticates|proves) (?:the )?validator/i, path);
    }
  });

  it('recognizes a fresh canonical prepared dispatch and binds its identity', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
      validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.recognized, true, JSON.stringify(verdict.diagnostics));
    assert.equal(verdict.evidenceState, 'current');
    assert.equal(verdict.disposition, 'proceed');
    assert.equal(verdict.requirement, 'prepared_dispatch');
    assert.equal(verdict.boundIdentity.packetId, packet.packetId);
    assert.equal(verdict.boundIdentity.productBaseHead, packet.repository.head);
    assert.equal(verdict.boundIdentity.worktreeRoot, packet.repository.worktree);
    assert.equal(verdict.observedGrade, 'host_signed');
    assert.equal(verdict.authenticated, true);
    assert.equal(validateHandoffRecognition(verdict).ok, true);
    assert.equal(verdict.kind, HANDOFF_RECOGNITION_KIND);
    assert.equal(verdict.schemaVersion, HANDOFF_RECOGNITION_SCHEMA_VERSION);
  });

  it('refuses role-start recognition when canonical validation is omitted', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual(codes(verdict), ['handoff.expectation.malformed']);
    assert.match(verdict.diagnostics[0].message, /canonical dispatch validator/);
  });

  it('refuses malformed and caller-authored validator output', () => {
    for (const validatePreparedDispatch of [
      () => true,
      () => ({ ok: true }),
      () => ({ ok: true, errors: [] }),
      () => ({ kind: 'agenticloop.prepared-dispatch-validation', schemaVersion: 1, ok: true, errors: [] }),
    ]) {
      const verdict = recognizeHandoff({
        transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
        validatePreparedDispatch,
      });
      assert.equal(verdict.recognized, false);
      assert.ok(codes(verdict).includes('handoff.evidence.malformed'));
    }
  });

  it('refuses an exact validation result when it is substituted onto another packet', () => {
    const receipt = createPreparedDispatchValidation(packet, { ok: true, errors: [] });
    const substituted = structuredClone(packet);
    substituted.packetId = 'dispatch:00000000-0000-4000-8000-000000000099';
    substituted.digest = dispatchPreparationDigest(substituted);
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: roleStartExpectation({ packetId: substituted.packetId, packetDigest: substituted.digest }),
      preparedDispatch: substituted,
      validatePreparedDispatch: () => receipt,
    });
    assert.equal(verdict.recognized, false);
    assert.ok(codes(verdict).includes('handoff.evidence.malformed'));
    assert.match(verdict.diagnostics[0].message, /does not bind the exact packet/);
  });

  it('refuses a resealed packet with destroyed activation through the direct API', () => {
    const forged = structuredClone(packet);
    forged.activation = { ...forged.activation, signature: 'a'.repeat(86) };
    forged.digest = dispatchPreparationDigest(forged);
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation({
        packetDigest: forged.digest,
      }), preparedDispatch: forged, validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.recognized, false);
    assert.ok(codes(verdict).includes('handoff.evidence.malformed'));
  });

  it('agrees with the canonical dispatch validator rather than replacing it', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: roleStartExpectation(),
      preparedDispatch: packet,
      validatePreparedDispatch: candidate => {
        const checked = validateDispatchPreparation(candidate, {
          capabilities: dispatch.options.capabilities,
          resolveActivationBinding: () => ({ ok: true, errors: [] }),
        });
        return createPreparedDispatchValidation(candidate, { ok: checked.ok, errors: checked.errors });
      },
    });
    assert.equal(verdict.recognized, true, JSON.stringify(verdict.diagnostics));
  });

  it('refuses a raw role prompt and grades the observation session_reported', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: roleStartExpectation(),
      observations: [
        { label: 'host subagent invoked directly with a pasted task brief', grade: 'host_receipt' },
        { label: 'model narration: "Engineer role started"' },
      ],
    });
    assert.equal(verdict.recognized, false);
    assert.ok(codes(verdict).includes('handoff.evidence.missing'));
    assert.ok(codes(verdict).includes('handoff.evidence.unauthenticated'));
    assert.equal(verdict.observations.length, 2);
    for (const observation of verdict.observations) {
      assert.equal(observation.grade, HANDOFF_OBSERVATION_GRADE);
      assert.equal(observation.authoritative, false);
    }
    // A claimed higher grade is recorded as a claim, never honored.
    assert.equal(verdict.observations[0].claimedGrade, 'host_receipt');
    assert.equal(verdict.authenticated, false);
    assert.equal(validateHandoffRecognition(verdict).ok, true);
  });

  it('separates missing evidence from malformed evidence', () => {
    const missing = recognizeHandoff({ transition: 'role_start', expectation: roleStartExpectation() });
    assert.deepEqual(codes(missing), ['handoff.evidence.missing']);
    assert.equal(missing.evidenceState, 'missing');

    const malformed = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(),
      preparedDispatch: { kind: 'agenticloop.role-return', schemaVersion: 2 },
    });
    assert.deepEqual(codes(malformed), ['handoff.evidence.malformed']);
    assert.equal(malformed.evidenceState, 'malformed');
  });

  it('refuses a packet whose digest no longer matches its own projection', () => {
    const tampered = structuredClone(packet);
    tampered.assignment.roleId = 'auditor';
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: tampered,
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual(codes(verdict), ['handoff.evidence.malformed']);
    assert.match(verdict.diagnostics[0].message, /digest does not match its own canonical projection/);
  });

  it('types an unsupported packet schema apart from a stale one', () => {
    const unsupported = { ...structuredClone(packet), schemaVersion: DISPATCH_PREPARATION_SCHEMA_VERSION + 40 };
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: unsupported,
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.unsupported']);
    assert.equal(verdict.evidenceState, 'malformed');
  });

  it('refuses a stale packet by its own declared freshness policy', () => {
    const maxAge = packet.decomposition.freshnessPolicy.maxAgeSeconds;
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
      validatePreparedDispatch: validator(),
      now: Date.parse(packet.decomposition.observedAt) + (maxAge + 1) * 1000,
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.stale']);
    assert.equal(verdict.disposition, 'superseded');
  });

  it('refuses a packet observed in the future rather than treating it as fresh', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
      validatePreparedDispatch: validator(),
      now: Date.parse(packet.decomposition.observedAt) - 60 * 60 * 1000,
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.malformed']);
    assert.match(verdict.diagnostics[0].message, /observed in the future/);
  });

  it('refuses a replayed packet that was already consumed', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
      validatePreparedDispatch: validator(),
      consumedPacketIds: ['dispatch:unrelated', packet.packetId],
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.replayed']);
    assert.equal(verdict.disposition, 'superseded');
  });

  it('names every mismatched binding separately instead of collapsing them', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: roleStartExpectation({
        taskId: 'T-999',
        roleId: 'auditor',
        productBaseHead: 'f'.repeat(40),
        worktreeRoot: '/somewhere/else',
        dispatchCarrierDigest: `sha256:${'0'.repeat(64)}`,
      }),
      preparedDispatch: packet,
      validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual([...new Set(codes(verdict))], ['handoff.evidence.mismatched']);
    const fields = verdict.diagnostics.map(item => item.evidence.field).sort();
    assert.deepEqual(fields, ['dispatchCarrierDigest', 'productBaseHead', 'roleId', 'taskId', 'worktreeRoot']);
  });

  it('refuses a packet whose task-contract generation is not the expected one', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: roleStartExpectation({ taskContractDigest: `sha256:v1:${'e'.repeat(64)}` }),
      preparedDispatch: packet,
      validatePreparedDispatch: validator(),
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.mismatched']);
    assert.equal(verdict.diagnostics[0].evidence.field, 'taskContractDigest');
  });

  it('refuses activation assurance below the required minimum', () => {
    const verdict = recognizeHandoff({
      transition: 'role_start',
      expectation: roleStartExpectation({ minimumReturnAssurance: 'host_receipt' }),
      preparedDispatch: packet,
      validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual(codes(verdict), ['handoff.evidence.unauthenticated']);
    assert.match(verdict.diagnostics[0].message, /below the required minimum 'host_receipt'/);
  });
});

describe('durable dispatch consumption', () => {
  function recognizedStart() {
    const recognition = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
      validatePreparedDispatch: validator(),
    });
    assert.equal(recognition.recognized, true, JSON.stringify(recognition.diagnostics));
    return recognition;
  }

  function consumption(overrides = {}) {
    return createDispatchConsumption({
      backend: 'files', taskId: packet.task.id, recognition: recognizedStart(),
      currentCarrierDigest: packet.task.dispatchCarrierDigest,
      consumedAt: '2026-08-01T12:00:00.000Z', ...overrides,
    });
  }

  it('binds the complete validated role-start verdict', () => {
    const record = consumption();
    assert.deepEqual(record.recognition, recognizedStart());
    assert.equal(validateDispatchConsumption(record, {
      taskId: packet.task.id, backend: 'files', now: Date.parse('2026-08-01T12:00:01.000Z'),
    }).ok, true);
  });

  it('refuses caller-authored records, forged recognition, and false duplicated identity', () => {
    const genuine = consumption();
    const authored = {
      kind: 'agenticloop.dispatch-consumption', schemaVersion: 2, backend: 'files',
      taskId: 'T-001', packetId: 'anything', recognition: { recognized: true },
      consumedAt: '2026-08-10T12:00:00.000Z', digest: 'anything',
    };
    assert.equal(validateDispatchConsumption(authored).ok, false);

    const forgedRecognition = structuredClone(genuine);
    forgedRecognition.recognition.digest = `sha256:agenticloop.handoff-recognition.v1:${'0'.repeat(64)}`;
    forgedRecognition.digest = dispatchConsumptionDigest(forgedRecognition);
    assert.equal(validateDispatchConsumption(forgedRecognition).ok, false);

    const falseIdentity = structuredClone(genuine);
    falseIdentity.taskId = 'T-999';
    falseIdentity.digest = dispatchConsumptionDigest(falseIdentity);
    const checked = validateDispatchConsumption(falseIdentity);
    assert.equal(checked.ok, false);
    assert.match(checked.errors.join('\n'), /taskId.*recognition|task identity/i);
  });

  it('refuses invalid and future timestamps instead of ordering them lexically', () => {
    for (const consumedAt of ['zzzz', '2026-08-01', '2026-08-01T12:00:00+00:00', '2026-08-01T12:00:02.001Z']) {
      const record = structuredClone(consumption());
      record.consumedAt = consumedAt;
      record.digest = dispatchConsumptionDigest(record);
      assert.equal(validateDispatchConsumption(record, {
        now: Date.parse('2026-08-01T12:00:01.000Z'),
      }).ok, false, consumedAt);
    }
  });

  it('rejects cross-task, cross-backend, and noncanonical filename placement', () => {
    const root = mkdtempSync(join(temp, 'consumption-placement-'));
    const record = consumption();
    const directory = join(root, '.agenticloop', 'handoffs', 'dispatch', packet.task.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'wrong-name.json'), `${JSON.stringify(record)}\n`, 'utf8');
    const listed = listDispatchConsumptions(root, packet.task.id, {
      backend: 'github', now: Date.parse('2026-08-01T12:00:01.000Z'),
    });
    assert.equal(listed.ok, false);
    assert.equal(listed.records.length, 0);
    assert.match(listed.errors.join('\n'), /filename|backend/);
  });

  it('selects genuine records by parsed instant and reports malformed lexical attacks', () => {
    const root = mkdtempSync(join(temp, 'consumption-current-'));
    const first = consumption({ consumedAt: '2026-08-01T11:59:59.000Z' });
    const second = consumption({ consumedAt: '2026-08-01T12:00:00.000Z' });
    for (const record of [first, second]) {
      const path = join(root, dispatchConsumptionRelativePath(record));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    }
    const current = currentDispatchConsumption(root, packet.task.id, {
      backend: 'files', now: Date.parse('2026-08-01T12:00:01.000Z'),
    });
    assert.equal(current.ok, true, current.errors.join('\n'));
    assert.equal(current.record.consumedAt, second.consumedAt);
  });
});

// ---------------------------------------------------------------------------
// Verified return: the later protected transitions
// ---------------------------------------------------------------------------

describe('verified return recognition', () => {
  it('refuses a wrapper around an incomplete caller-authored role return', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const incomplete = {
      returnId: HANDOFF_RETURN_ID,
      producerRole: 'engineer',
      packet: { packetId: packet.packetId, digest: packet.digest },
      task: { backend: packet.backend, id: packet.task.id, digest: packet.task.digest },
      head: packet.repository.head,
      worktree: packet.repository.worktree,
      digest: `sha256:agenticloop.role-return.v2:${'b'.repeat(64)}`,
    };
    assert.throws(() => createReturnVerification({
      target: dispatch.root,
      packet,
      roleReturn: incomplete,
      repositoryEvidence: fixture.repositoryEvidence,
      received: { ok: true, returnAssurance: 'session_reported' },
    }), /canonical JSON cannot represent undefined|return verification/);
  });

  const laterTransitions = ['review_entry', 'acceptance', 'integration', 'closeout'];

  it('recognizes a canonical verified return for every later protected transition', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    for (const transition of laterTransitions) {
      const verdict = recognizeHandoff({
        transition, expectation: handoffExpectation(fixture), verifiedReturn: fixture.record,
        validatePreparedDispatch: validator(),
      });
      assert.equal(verdict.recognized, true, `${transition}: ${JSON.stringify(verdict.diagnostics)}`);
      assert.equal(verdict.requirement, 'verified_return');
      assert.equal(verdict.observedGrade, 'session_reported');
      // Canonical is not the same as authenticated, and the verdict says so.
      assert.equal(verdict.authenticated, false);
      assert.equal(verdict.boundIdentity.returnId, fixture.roleReturn.returnId);
      assert.equal(validateHandoffRecognition(verdict).ok, true);
    }
  });

  it('reports an authenticated producer only for a host receipt', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet, { returnAssurance: 'session_reported' });
    const verdict = recognizeHandoff({
      transition: 'acceptance', expectation: handoffExpectation(fixture), verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.authenticated, false);
    const forged = { ...verdict, authenticated: true };
    assert.equal(validateHandoffRecognition({ ...forged, digest: handoffRecognitionDigest(forged) }).ok, false);
  });

  it('refuses a raw role return handed in as its own verification', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    for (const transition of laterTransitions) {
      const verdict = recognizeHandoff({
        transition, expectation: handoffExpectation(fixture), verifiedReturn: fixture.roleReturn,
        validatePreparedDispatch: validator(),
      });
      assert.equal(verdict.recognized, false);
      assert.deepEqual(codes(verdict), ['handoff.evidence.malformed']);
      assert.match(verdict.diagnostics[0].message, /a role return is not its own verification/);
    }
  });

  it('refuses a manually reconstructed verification whose digest was rewritten', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const rebuilt = { ...structuredClone(fixture.record), observedReturnGrade: 'host_receipt' };
    const verdict = recognizeHandoff({
      transition: 'closeout', expectation: handoffExpectation(fixture, { minimumReturnAssurance: 'host_receipt' }),
      verifiedReturn: rebuilt,
      validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual([...new Set(codes(verdict))], ['handoff.evidence.malformed']);
  });

  it('refuses model prose and other non-record shapes', () => {
    for (const candidate of ['the engineer says it is done', 42, [], { ok: true }, null]) {
      const verdict = recognizeHandoff({
        transition: 'acceptance',
        expectation: {
          backend: 'files', taskId: 'T-001', roleId: 'engineer',
          minimumReturnAssurance: 'session_reported',
        },
        verifiedReturn: candidate,
        validatePreparedDispatch: validator(),
      });
      assert.equal(verdict.recognized, false);
      assert.ok(['handoff.evidence.missing', 'handoff.evidence.malformed'].includes(codes(verdict)[0]));
    }
  });

  it('refuses a verification that belongs to another task or work unit', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet, { workUnit: 'wu-alpha' });
    const wrongTask = recognizeHandoff({
      transition: 'closeout', expectation: handoffExpectation(fixture, { taskId: 'T-002' }),
      verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    assert.deepEqual([...new Set(codes(wrongTask))], ['handoff.evidence.mismatched']);

    const wrongWorkUnit = recognizeHandoff({
      transition: 'closeout', expectation: handoffExpectation(fixture, { workUnitIdentity: 'wu-beta' }),
      verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    assert.deepEqual([...new Set(codes(wrongWorkUnit))], ['handoff.evidence.mismatched']);
    assert.equal(wrongWorkUnit.diagnostics[0].evidence.field, 'workUnitIdentity');
  });

  it('refuses a verification bound to another packet, head, or worktree', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const verdict = recognizeHandoff({
      transition: 'review_entry',
      expectation: handoffExpectation(fixture, {
        packetId: 'dispatch:00000000-0000-4000-8000-0000000000ff',
        productBaseHead: 'b'.repeat(40),
        worktreeRoot: '/another/worktree',
      }),
      verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    const fields = verdict.diagnostics.map(item => item.evidence.field).sort();
    assert.deepEqual(fields, ['packetId', 'productBaseHead', 'worktreeRoot']);
  });

  it('refuses session_reported evidence when the policy minimum is a host receipt', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    for (const transition of laterTransitions) {
      const verdict = recognizeHandoff({
        transition,
        expectation: handoffExpectation(fixture, { minimumReturnAssurance: 'host_receipt' }),
        verifiedReturn: fixture.record,
        validatePreparedDispatch: validator(),
      });
      assert.equal(verdict.recognized, false, transition);
      assert.deepEqual(codes(verdict), ['handoff.evidence.unauthenticated']);
      assert.match(verdict.diagnostics[0].message, /not host-authenticated/);
    }
  });

  it('carries a caller revalidation failure as stale rather than intact', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const verdict = recognizeHandoff({
      transition: 'closeout', expectation: handoffExpectation(fixture), verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
      validateVerifiedReturn: () => ({ ok: false, errors: ['repository evidence changed since verification'] }),
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.stale']);
    assert.equal(verdict.disposition, 'superseded');
  });

  it('applies an explicit freshness bound to the verification instant', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet, { verifiedAt: '2026-08-01T00:00:00.000Z' });
    const verdict = recognizeHandoff({
      transition: 'closeout', expectation: handoffExpectation(fixture), verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
      maxEvidenceAgeSeconds: 3600,
      now: Date.parse('2026-08-02T00:00:00.000Z'),
    });
    assert.deepEqual(codes(verdict), ['handoff.evidence.stale']);
  });
});

// ---------------------------------------------------------------------------
// Backend differential and host neutrality
// ---------------------------------------------------------------------------

describe('backend and adapter neutrality', () => {
  it('binds the backend rather than branching on it', () => {
    // The seam has no per-backend rule, so the backend is just another bound
    // identity: judging files evidence under a GitHub expectation mismatches
    // exactly the way any other wrong identity does, with the same code and the
    // same disposition. The end-to-end files/GitHub differential runs through
    // both public commands in 'role start differential across carriers' below.
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const bound = recognizeHandoff({
      transition: 'closeout',
      expectation: handoffExpectation(fixture),
      verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    assert.equal(bound.recognized, true, JSON.stringify(bound.diagnostics));
    assert.equal(bound.boundIdentity.backend, 'files');

    const crossBackend = recognizeHandoff({
      transition: 'closeout',
      expectation: handoffExpectation(fixture, { backend: 'github' }),
      verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    const wrongTask = recognizeHandoff({
      transition: 'closeout',
      expectation: handoffExpectation(fixture, { taskId: 'T-404' }),
      verifiedReturn: fixture.record,
      validatePreparedDispatch: validator(),
    });
    assert.equal(crossBackend.recognized, false);
    assert.deepEqual(codes(crossBackend), ['handoff.evidence.mismatched']);
    assert.equal(crossBackend.diagnostics[0].evidence.field, 'backend');
    // Same class of refusal, same disposition: nothing about the backend is special.
    assert.deepEqual(codes(crossBackend), codes(wrongTask));
    assert.equal(crossBackend.evidenceState, wrongTask.evidenceState);
    assert.equal(crossBackend.disposition, wrongTask.disposition);
  });

  it('contains no host-specific branch that could widen authority', () => {
    const source = readFileSync(new URL('../src/handoff-recognition.js', import.meta.url), 'utf8');
    for (const host of ['opencode', 'claude-code', 'codex', 'copilot', 'cursor']) {
      assert.equal(source.toLowerCase().includes(host), false, `handoff recognition must not branch on ${host}`);
    }
  });

  it('treats a substituted dispatch host as tampering, identically for every host', () => {
    // The declared host is inside the packet's own digest domain, so swapping it
    // is tampering rather than configuration. What matters for host neutrality
    // is that the refusal is the same one for every host: no host is privileged
    // into recognition, and none is singled out for a harsher verdict.
    const substituted = ['opencode', 'claude-code', 'codex', 'copilot', 'cursor']
      .filter(host => host !== packet.assignment.host)
      .map(host => {
        const candidate = structuredClone(packet);
        candidate.assignment.host = host;
        return recognizeHandoff({
          transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: candidate,
        });
      });
    assert.ok(substituted.length >= 4);
    for (const verdict of substituted) {
      assert.equal(verdict.recognized, false);
      assert.deepEqual(codes(verdict), ['handoff.evidence.malformed']);
      assert.equal(verdict.digest, substituted[0].digest);
    }
    // The packet as prepared, with its real host, is still recognized.
    const asPrepared = recognizeHandoff({
      transition: 'role_start', expectation: roleStartExpectation(), preparedDispatch: packet,
      validatePreparedDispatch: validator(),
    });
    assert.equal(asPrepared.recognized, true, JSON.stringify(asPrepared.diagnostics));
  });
});

// ---------------------------------------------------------------------------
// Consumption: claims and closeout
// ---------------------------------------------------------------------------

describe('lifecycle claim consumption', () => {
  it('refuses a closeout completion claim without recognized handoff evidence', () => {
    const { verdict } = recognizedVerdict(dispatch, packet, 'closeout');
    const refused = recognizeHandoff({ transition: 'closeout', expectation: handoffExpectation(verifiedReturnFixture(dispatch.root, packet)) });
    assert.equal(verdict.recognized, true, JSON.stringify(verdict.diagnostics));
    assert.equal(refused.recognized, false);
    // A refusal verdict is present evidence, and it still authorizes nothing.
    assert.deepEqual(deriveLifecycleClaims({ handoff: { closeout: refused } }), []);
    assert.deepEqual(deriveLifecycleClaims({ handoff: { closeout: [verdict, refused] } }), []);
  });

  it('cannot be satisfied by a verdict issued for another transition', () => {
    const { verdict } = recognizedVerdict(dispatch, packet, 'review_entry');
    assert.deepEqual(deriveLifecycleClaims({ handoff: { closeout: verdict } }), []);
  });

  it('blocks closeout when a covered task return is not recognized', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default',
      backend: 'files', expectedProducerRole: 'engineer',
      validatePreparedDispatch: validator(),
      workUnitIdentity: 'another-work-unit',
      resolveTask: () => ({
        taskId: 'T-001', usable: true, activation: 'operator_confirmed',
        source: 'activation_grant', producer: 'agenticloop.cli.operator-confirmation.v1',
        channel: 'cli_interactive_confirmation', derivation: 'direct_operator_confirmation', reasons: [],
      }),
      resolveReturns: () => ({ usable: true, records: [fixture.record], reasons: [] }),
    }, ['T-001']);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some(item => /canonical handoff seam does not recognize/.test(item.message)));
    assert.equal(result.report.returns[0].handoff_recognized, false);
    assert.equal(result.recognition.length, 1);
    assert.equal(result.recognition[0].recognized, false);
  });

  it('recognizes a covered task return bound to this closeout', () => {
    // The record's work-unit identity is whatever `verify-return` stored for the
    // packet it consumed; the closeout binds its own, and the two must agree.
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default',
      backend: 'files', expectedProducerRole: 'engineer',
      validatePreparedDispatch: validator(),
      workUnitIdentity: fixture.record.workUnitIdentity,
      resolveTask: () => ({
        taskId: 'T-001', usable: true, activation: 'operator_confirmed',
        source: 'activation_grant', producer: 'agenticloop.cli.operator-confirmation.v1',
        channel: 'cli_interactive_confirmation', derivation: 'direct_operator_confirmation', reasons: [],
      }),
      resolveReturns: () => ({
        usable: true, records: [fixture.record], reasons: [],
        productBaseHead: fixture.roleReturn.productBaseHead,
      }),
    }, ['T-001']);
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.equal(result.report.returns[0].handoff_recognized, true);
    assert.equal(result.recognition.every(verdict => verdict.recognized), true);
  });

  it('refuses closeout return evidence from another artifact head', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default', backend: 'files',
      expectedProducerRole: 'engineer', validatePreparedDispatch: validator(),
      workUnitIdentity: fixture.record.workUnitIdentity,
      resolveTask: () => ({
        taskId: 'T-001', usable: true, activation: 'operator_confirmed',
        source: 'activation_grant', producer: 'operator', channel: 'cli', derivation: 'direct', reasons: [],
      }),
      resolveReturns: () => ({
        usable: true, records: [fixture.record], reasons: [], productBaseHead: 'f'.repeat(40),
      }),
    }, ['T-001']);
    assert.equal(result.ok, false);
    assert.ok(result.recognition[0].diagnostics.some(item => item.evidence.field === 'productBaseHead'));
  });

  it('does not let a legacy activation waiver replace dispatch consumption or a verified return', () => {
    const result = summarizeCloseoutAssurance({
      mode: 'standard', policySource: 'default', backend: 'files',
      legacyWaiver: { waivedDimensions: ['activation_evidence_absent', 'return_evidence_absent'] },
      resolveTask: () => ({ taskId: 'T-001', usable: false, reasons: [] }),
      resolveReturns: () => ({ usable: false, records: [], reasons: [] }),
      resolveDispatchConsumption: () => ({ ok: true, record: null }),
    }, ['T-001']);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some(item => /dispatch consumption/.test(item.message)));
    assert.ok(result.reasons.some(item => /no current successful role-return verification/.test(item.message)));
  });
});

// ---------------------------------------------------------------------------
// Role start through the public command family
// ---------------------------------------------------------------------------

describe('task status role start', () => {
  it('exposes no caller-authored validation-receipt option', async () => {
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentTaskDigest(before),
      '--validation-receipt', '.agenticloop/tmp/caller.json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option.*validation-receipt/i);
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });

  it('refuses a start with no prepared dispatch and leaves the carrier unchanged', async () => {
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(before, 'utf8').digest('hex')}`;
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest, '--json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.handoff_recognition.recognized, false);
    assert.equal(payload.handoff_recognition.transition, 'role_start');
    assert.deepEqual(payload.handoff_recognition.observations.map(item => item.grade), [HANDOFF_OBSERVATION_GRADE]);
    assert.ok(payload.handoff_recognition.diagnostics.some(item => item.code === 'handoff.evidence.missing'));
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });

  it('refuses a supplied packet that does not bind, and writes nothing', async () => {
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(before, 'utf8').digest('hex')}`;
    const wrongPacket = structuredClone(packet);
    wrongPacket.task = { ...wrongPacket.task, contractDigest: `sha256:v1:${'9'.repeat(64)}` };
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    const packetPath = join(root, '.agenticloop', 'tmp', 'wrong-packet.json');
    writeFileSync(packetPath, JSON.stringify(wrongPacket, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest,
      '--dispatch-packet', '.agenticloop/tmp/wrong-packet.json', '--json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.diagnostics.some(item => item.code.startsWith('handoff.')));
    // The refusal is fail-closed: the durable record is byte-identical.
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });

  it('refuses a fabricated packet whose digest was recomputed after the fact', async () => {
    // The exact attack the digest alone cannot stop: take a real packet, strip
    // its activation authority, invent a producer, lower the assurance floor it
    // declares for itself, and reseal it with the exported digest helper. Only
    // the canonical validator and the operator's own policy minimum refuse it.
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(before, 'utf8').digest('hex')}`;
    const fabricated = structuredClone(packet);
    fabricated.activation = null;
    fabricated.activationBinding = { grant: { repositoryIdentity: 'file:/somewhere', digest: 'nope' }, binding: { digest: 'nope' } };
    fabricated.assurance = {
      ...fabricated.assurance,
      activation: 'session_reported',
      minimumActivation: 'session_reported',
      activationSource: 'model_assertion',
      activationProducer: 'the model said so',
    };
    fabricated.digest = dispatchPreparationDigest(fabricated);
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.agenticloop', 'tmp', 'fabricated.json'), JSON.stringify(fabricated, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest,
      '--dispatch-packet', '.agenticloop/tmp/fabricated.json', '--json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.ok(payload.diagnostics.every(item => item.code.startsWith('handoff.')));
    assert.equal(payload.handoff_recognition.recognized, false);
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });

  it('refuses a packet whose assurance still meets policy but whose capture is destroyed', async () => {
    // This case is refused by the canonical dispatch validator alone: the
    // declared assurance clears the operator's minimum, so the policy floor
    // cannot be what catches it.
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(before, 'utf8').digest('hex')}`;
    const forged = structuredClone(packet);
    assert.equal(forged.assurance.activation, 'host_signed');
    forged.activation = { ...forged.activation, signature: 'a'.repeat(86) };
    forged.digest = dispatchPreparationDigest(forged);
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.agenticloop', 'tmp', 'forged-capture.json'), JSON.stringify(forged, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest,
      '--dispatch-packet', '.agenticloop/tmp/forged-capture.json', '--json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.handoff_recognition.recognized, false);
    assert.ok(payload.diagnostics.some(item => item.code === 'handoff.evidence.malformed'));
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });

  it('recognizes a start backed by the canonical packet', async () => {
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(before, 'utf8').digest('hex')}`;
    mkdirSync(join(root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.agenticloop', 'tmp', 'packet.json'), JSON.stringify(packet, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest,
      '--dispatch-packet', '.agenticloop/tmp/packet.json', '--json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.handoff_recognition.recognized, true, JSON.stringify(payload.handoff_recognition.diagnostics));
    assert.equal(payload.handoff_recognition.boundIdentity.packetId, packet.packetId);
    assert.match(readFileSync(taskFile, 'utf8'), /^status: in-progress$/m);
    writeFileSync(taskFile, before, 'utf8');
  });

  it('refuses replay of a packet already consumed by a role start', async () => {
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentTaskDigest(before),
      '--dispatch-packet', '.agenticloop/tmp/packet.json', '--json', '--target', root,
    ], cliOptions());
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.handoff_recognition.diagnostics.some(item => item.code === 'handoff.evidence.replayed'));
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });

  it('refuses a previously valid packet after the repository head moves', async () => {
    const fresh = await createDispatchFixture(temp, 'stale-head');
    const localOptions = {
      operatorTrustRoot: fresh.operatorTrustRoot,
      operatorActivationRoot: fresh.operatorActivationRoot,
      hostAuthority: protectedHostBoundary(fresh.trust),
    };
    mkdirSync(join(fresh.root, '.agenticloop', 'tmp'), { recursive: true });
    writeFileSync(join(fresh.root, '.agenticloop', 'tmp', 'dispatch-input.json'), JSON.stringify({
      activation: fresh.activation,
      assignment: fresh.assignment,
      readiness: fresh.readiness,
      decomposition: fresh.decomposition,
      priorGateReceipts: fresh.priorGateReceipts,
    }, null, 2), 'utf8');
    const prepared = await runCliInProcess([
      'task', 'prepare-dispatch', 'T-001', '--input', '.agenticloop/tmp/dispatch-input.json',
      '--return-adapter', fresh.trust.adapterId, '--target', fresh.root,
    ], localOptions);
    assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
    writeFileSync(join(fresh.root, '.agenticloop', 'tmp', 'packet.json'), prepared.stdout, 'utf8');
    writeFileSync(join(fresh.root, 'src', 'after-dispatch.js'), 'export const moved = true;\n', 'utf8');
    git(fresh.root, ['add', 'src/after-dispatch.js']);
    git(fresh.root, ['commit', '-m', 'move head after dispatch\n\nTask: T-001\nAgent: maintainer']);
    const taskFile = join(fresh.root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const result = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', currentTaskDigest(before),
      '--dispatch-packet', '.agenticloop/tmp/packet.json', '--json', '--target', fresh.root,
    ], localOptions);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /dispatch packet bindings changed|repository/);
    assert.equal(readFileSync(taskFile, 'utf8'), before);
  });
});

// ---------------------------------------------------------------------------
// Public-path differential: both carriers decide the role start the same way
// ---------------------------------------------------------------------------

describe('role start differential across carriers', () => {
  const TASK_BODY = [
    '---', 'task_id: T-071', 'status: agent-ready', 'independent_review_required: false', '---',
    '# T-071', '', '## Scope', 'Differential role start.', '', '## Out of Scope', 'None.', '',
    '## Acceptance Criteria', 'The role start is decided identically on both carriers.', '',
    '## Required Checks', '- [RC-1] command: `npm test`',
  ].join('\n');

  function githubRunner(state) {
    return (_command, args) => {
      if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ nameWithOwner: 'example/repo' }) };
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'maintainer' }) };
      if (args[0] === 'api' && args.includes('--paginate')) return { status: 0, stdout: JSON.stringify([[]]) };
      if (args[0] !== 'issue') return { status: 1, stderr: 'unexpected command' };
      if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 71, body: state.body }) };
      if (args[1] === 'edit') { state.edits += 1; return { status: 0, stdout: '' }; }
      return { status: 1, stderr: 'unexpected issue action' };
    };
  }

  it('refuses a raw start identically on files and on GitHub', async () => {
    const root = dispatch.root;
    const taskFile = join(root, '.agenticloop', 'tasks', 'T-001.md');
    const before = readFileSync(taskFile, 'utf8');
    const digest = `sha256:${(await import('node:crypto')).createHash('sha256').update(before, 'utf8').digest('hex')}`;
    const files = await runCliInProcess([
      'task', 'status', 'T-001', 'in-progress', '--expect-digest', digest, '--json', '--target', root,
    ], cliOptions());
    assert.equal(files.status, 1, `${files.stdout} ${files.stderr}`);
    assert.equal(readFileSync(taskFile, 'utf8'), before);

    const directory = mkdtempSync(join(temp, 'github-differential-'));
    const state = { body: TASK_BODY, edits: 0 };
    const github = await runCliInProcess([
      'task-body', 'transition', '--issue', '71', '--status', 'in-progress',
      '--expect-digest', taskBodyDigest(state.body), '--dry-run', '--json',
    ], { cwd: directory, ghCommandRunner: githubRunner(state) });
    assert.equal(github.status, 1, `${github.stdout} ${github.stderr}`);

    const filesVerdict = JSON.parse(files.stdout).handoff_recognition;
    const githubVerdict = JSON.parse(github.stdout).handoff_recognition;
    assert.equal(filesVerdict.recognized, false);
    assert.equal(githubVerdict.recognized, false);
    // Only the bound backend differs; the semantic verdict is one verdict.
    assert.equal(filesVerdict.transition, githubVerdict.transition);
    assert.equal(filesVerdict.requirement, githubVerdict.requirement);
    assert.equal(filesVerdict.evidenceState, githubVerdict.evidenceState);
    assert.equal(filesVerdict.disposition, githubVerdict.disposition);
    assert.deepEqual(
      filesVerdict.diagnostics.map(item => item.code),
      githubVerdict.diagnostics.map(item => item.code)
    );
    // Nothing was supplied, so nothing is bound on either carrier: the verdict
    // reports what the evidence bound, never what the caller hoped for.
    assert.deepEqual(filesVerdict.boundIdentity, githubVerdict.boundIdentity);
    assert.equal(Object.values(filesVerdict.boundIdentity).every(value => value === null), true);
    assert.deepEqual(filesVerdict.observations.map(item => item.grade), [HANDOFF_OBSERVATION_GRADE]);
    assert.deepEqual(githubVerdict.observations.map(item => item.grade), [HANDOFF_OBSERVATION_GRADE]);
    assert.equal(state.edits, 0);
  });

  it('refuses an already-in-progress GitHub start without a fresh packet and performs no edit', async () => {
    const directory = mkdtempSync(join(temp, 'github-current-refusal-'));
    const state = { body: TASK_BODY.replace('status: agent-ready', 'status: in-progress'), edits: 0 };
    const result = await runCliInProcess([
      'task-body', 'transition', '--issue', '71', '--status', 'in-progress',
      '--expect-digest', taskBodyDigest(state.body), '--yes', '--json',
    ], { cwd: directory, ghCommandRunner: githubRunner(state) });
    assert.equal(result.status, 1, `${result.stdout} ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.handoff_recognition.transition, 'role_start');
    assert.ok(envelope.diagnostics.some(item => item.code === 'handoff.evidence.missing'));
    assert.equal(state.edits, 0);
  });

  it('refuses a non-binding packet on the GitHub carrier without editing the issue', async () => {
    const directory = mkdtempSync(join(temp, 'github-refusal-'));
    const state = { body: TASK_BODY, edits: 0 };
    writeFileSync(join(directory, 'packet.json'), JSON.stringify(packet, null, 2), 'utf8');
    const result = await runCliInProcess([
      'task-body', 'transition', '--issue', '71', '--status', 'in-progress',
      '--expect-digest', taskBodyDigest(state.body), '--dispatch-packet', 'packet.json',
      '--yes', '--json',
    ], { cwd: directory, ghCommandRunner: githubRunner(state) });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.ok(envelope.diagnostics.every(item => item.code.startsWith('handoff.')));
    assert.equal(envelope.handoff_recognition.recognized, false);
    // Fail closed: the remote carrier was never edited.
    assert.equal(state.edits, 0);
  });
});

// ---------------------------------------------------------------------------
// Review entry: the claim is only made when the chain is recognized
// ---------------------------------------------------------------------------

describe('review entry claim gate', () => {
  it('refuses a hand-authored return verification whose packet was never prepared', () => {
    // The record is internally consistent - its own validator passes - but the
    // packet inside it never went through preparation. This is the return-side
    // twin of a fabricated dispatch packet, and it must fail the same way.
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const forgedPacket = structuredClone(packet);
    forgedPacket.activation = null;
    forgedPacket.activationBinding = { grant: { repositoryIdentity: 'file:/elsewhere', digest: 'grant' }, binding: { digest: 'binding' } };
    const rebuilt = structuredClone(fixture.record);
    rebuilt.evidence.packet = forgedPacket;
    const verdict = recognizeHandoff({
      transition: 'review_entry',
      expectation: handoffExpectation(fixture),
      verifiedReturn: rebuilt,
      validatePreparedDispatch: validator(),
    });
    assert.equal(verdict.recognized, false);
    assert.ok(codes(verdict).includes('handoff.evidence.malformed'));
  });

  it('refuses a verified return when no canonical dispatch validator is supplied', () => {
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const verdict = recognizeHandoff({
      transition: 'review_entry',
      expectation: handoffExpectation(fixture),
      verifiedReturn: fixture.record,
    });
    assert.equal(verdict.recognized, false);
    assert.deepEqual(codes(verdict), ['handoff.expectation.malformed']);
  });

  it('opens for a genuine stored return and stays shut without one', () => {
    // The gate has to be able to say yes. A gate that is permanently closed -
    // because the validator it runs can never see the operator's capabilities,
    // for instance - is indistinguishable from no gate at all for a reader, and
    // strictly worse for an operator.
    const fixture = verifiedReturnFixture(dispatch.root, packet);
    const expectation = handoffExpectation(fixture);
    const opened = recognizeStoredReturnHandoff({
      target: dispatch.root,
      transition: 'review_entry',
      expectation,
      validatePreparedDispatch: canonicalDispatchValidator({ target: dispatch.root, io: cliOptions() }),
    });
    // Nothing is stored yet, so the store resolves nothing.
    assert.equal(opened.recognized, false);
    assert.deepEqual(codes(opened), ['handoff.evidence.missing']);

    mkdirSync(join(dispatch.root, '.agenticloop', 'returns', 'verifications'), { recursive: true });
    writeFileSync(
      join(dispatch.root, returnVerificationPath(fixture.record)),
      `${JSON.stringify(fixture.record, null, 2)}
`,
      'utf8'
    );
    const recognized = recognizeStoredReturnHandoff({
      target: dispatch.root,
      transition: 'review_entry',
      expectation,
      validatePreparedDispatch: canonicalDispatchValidator({ target: dispatch.root, io: cliOptions() }),
    });
    assert.equal(recognized.recognized, true, JSON.stringify(recognized.diagnostics));
    assert.equal(recognized.boundIdentity.returnId, fixture.roleReturn.returnId);

    // The same store, judged for another task, still resolves nothing.
    const otherTask = recognizeStoredReturnHandoff({
      target: dispatch.root,
      transition: 'review_entry',
      expectation: { ...expectation, taskId: 'T-404' },
      validatePreparedDispatch: canonicalDispatchValidator({ target: dispatch.root, io: cliOptions() }),
    });
    assert.equal(otherTask.recognized, false);
    rmSync(join(dispatch.root, '.agenticloop', 'returns'), { recursive: true, force: true });
  });

  it('withholds the review-entry claim until a recognized return exists', () => {
    const { verdict } = recognizedVerdict(dispatch, packet, 'review_entry');
    assert.equal(verdict.recognized, true, JSON.stringify(verdict.diagnostics));
    const material = reviewEntryMaterial();
    const withChain = deriveLifecycleClaims({
      reviewEntry: material, currentArtifact: material.receipt.artifact.head,
      handoff: { review_entry: verdict },
    });
    assert.deepEqual(withChain.map(item => item.claim), ['implementation_ready_for_review']);
    assert.deepEqual(withChain[0].handoffBindings, [verdict.boundIdentity]);
    assert.equal(withChain[0].handoffBindings[0].taskId, packet.task.id);
    assert.equal(withChain[0].handoffBindings[0].packetId, packet.packetId);
    assert.equal(withChain[0].handoffBindings[0].dispatchCarrierDigest, packet.task.dispatchCarrierDigest);
    assert.equal(withChain[0].handoffBindings[0].workUnitIdentity, packet.decomposition.workUnitId);
    assert.equal(withChain[0].handoffBindings[0].repositoryIdentity, verdict.boundIdentity.repositoryIdentity);
    assert.equal(withChain[0].handoffBindings[0].worktreeRoot, packet.repository.worktree);
    assert.equal(withChain[0].handoffBindings[0].productBaseHead, verdict.boundIdentity.productBaseHead);
    assert.equal(withChain[0].handoffBindings[0].roleId, 'engineer');
    assert.equal(withChain[0].handoffBindings[0].returnGrade, verdict.observedGrade);
    const withoutChain = deriveLifecycleClaims({
      reviewEntry: material, currentArtifact: material.receipt.artifact.head,
    });
    assert.deepEqual(withoutChain, []);
  });
});

describe('observation grading', () => {
  it('normalizes every observation to a non-authoritative session_reported fact', () => {
    for (const candidate of [null, undefined, 'prose', { grade: 'host_receipt' }, { label: '  ' }]) {
      const graded = gradeObservedHandoffEvidence(candidate);
      assert.equal(graded.grade, HANDOFF_OBSERVATION_GRADE);
      assert.equal(graded.authoritative, false);
      assert.equal(typeof graded.label, 'string');
      assert.ok(graded.label.length > 0);
      assert.equal(Object.isFrozen(graded), true);
    }
  });
});
