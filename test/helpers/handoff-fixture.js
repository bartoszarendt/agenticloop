/**
 * Shared canonical handoff evidence for recognition coverage.
 *
 * A verified return is only meaningful when the packet it consumed is real, so
 * this helper builds its record around an actual `prepareRoleDispatch` packet
 * and exposes the same canonical validator the product runs. A test that needs
 * "a genuine verified return" gets one; a test that needs "something that only
 * looks like one" mutates the value it is handed.
 */

import { targetRepositoryIdentity } from '../../src/host-trust.js';
import { createReturnVerification } from '../../src/return-verification.js';
import {
  createRoleReturn,
  dispatchPreparationDigest,
  validateDispatchPreparation,
} from '../../src/dispatch-envelope.js';
import { createPreparedDispatchValidation, recognizeHandoff } from '../../src/handoff-recognition.js';

export const HANDOFF_RETURN_ID = 'return:00000000-0000-4000-8000-0000000000a2';

/**
 * The canonical dispatch validator bound to one dispatch fixture's operator
 * trust. Recognition requires this on both halves of the seam, and using the
 * real validator here is what keeps the coverage honest.
 *
 * @param {{options: {capabilities: any}}} dispatch a `createDispatchFixture` result
 */
export function fixtureDispatchValidator(dispatch) {
  return packet => {
    const checked = validateDispatchPreparation(packet, {
      capabilities: dispatch.options.capabilities,
      resolveActivationBinding: () => ({ ok: true, errors: [] }),
    });
    return createPreparedDispatchValidation(packet, { ok: checked.ok, errors: checked.errors });
  };
}

/**
 * One canonical verified return built around a real prepared-dispatch packet.
 *
 * @param {string} target the dispatch fixture root; the packet's activation
 *   authority names it, so the record cannot be built against another path
 * @param {object} packet a real `prepareRoleDispatch` packet
 * @param {{returnAssurance?: string, returnId?: string, head?: string,
 *          worktree?: string|null, verifiedAt?: string}} [options]
 */
export function verifiedReturnFixture(target, packet, options = {}) {
  const {
    returnAssurance = 'session_reported',
    returnId = HANDOFF_RETURN_ID,
    head = packet.repository.head,
    worktree = packet.repository.worktree,
    verifiedAt,
  } = options;
  const changedPaths = ['src/existing.js'];
  const baseHead = packet.repository.head;
  const checks = [
    { id: 'RC-1', kind: 'command', command: 'npm test', outcome: 'passed', exitCode: 0, evidence: 'fixture pass', executionEvidence: null },
    { id: 'RC-2', kind: 'command', command: 'npm run typecheck', outcome: 'passed', exitCode: 0, evidence: 'fixture pass', executionEvidence: null },
  ];
  const roleReturn = createRoleReturn({
    returnId,
    producerRole: 'engineer',
    packet: { packetId: packet.packetId, digest: packet.digest },
    task: {
      backend: packet.backend, id: packet.task.id,
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      currentCarrierDigest: packet.task.dispatchCarrierDigest,
    },
    worktree,
    branch: packet.assignment.branch,
    productBaseHead: baseHead,
    productHead: head,
    workflowHead: head,
    candidateHead: null,
    productChangedPaths: changedPaths,
    workflowChangedPaths: [],
    checks,
    productAttribution: {
      range: { base: baseHead, head },
      commits: head === baseHead ? [] : [head],
    },
    carrierLineage: {
      dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}`,
      evidenceMutationReceiptDigests: [],
    },
    pr: { state: 'not_applicable', number: null, url: null },
    outcome: {
      kind: 'implementation_ready_for_review',
      completion: false,
      authority: 'non_authoritative_role_outcome',
    },
    disposition: 'proceed',
    blocker: null,
    freshness: {
      invalidatedBy: [
        'task_or_contract_changes',
        'packet_or_assignment_changes',
        'branch_or_head_changes',
        'check_or_transport_evidence_changes',
        'initial_repository_state_changes',
      ],
    },
  });
  const repositoryEvidence = {
    backend: packet.backend,
    worktree,
    task: {
      id: packet.task.id,
      taskContractDigest: packet.task.taskContractDigest,
      dispatchCarrierDigest: packet.task.dispatchCarrierDigest,
      currentCarrierDigest: packet.task.dispatchCarrierDigest,
    },
    branch: packet.assignment.branch,
    productBaseHead: baseHead,
    productHead: head,
    workflowHead: head,
    candidateHead: null,
    productChangedPaths: changedPaths,
    workflowChangedPaths: [],
    checks,
    productAttribution: roleReturn.productAttribution,
    carrierLineage: roleReturn.carrierLineage,
    pr: roleReturn.pr,
  };
  const record = createReturnVerification({
    target,
    packet,
    roleReturn,
    repositoryEvidence,
    received: { ok: true, returnAssurance },
    requiredCheckEvidenceAssurance: packet.task.requiredChecks?.some(check => check?.kind === 'command')
      ? 'unverified'
      : 'not_applicable',
    ...(verifiedAt ? { verifiedAt } : {}),
  });
  return {
    packet,
    roleReturn,
    repositoryEvidence,
    record,
    repositoryIdentity: targetRepositoryIdentity(target),
  };
}

/**
 * The expectation a caller binds a verified return to. Fields not proved by the
 * fixture are left out so a test opts in to each identity it wants checked.
 */
export function handoffExpectation(fixture, overrides = {}) {
  return {
    backend: fixture.packet.backend,
    taskId: fixture.packet.task.id,
    roleId: 'engineer',
    taskContractDigest: fixture.packet.task.taskContractDigest,
    packetId: fixture.packet.packetId,
    packetDigest: fixture.packet.digest,
    minimumReturnAssurance: 'session_reported',
    minimumActivationAssurance: 'operator_confirmed',
    ...overrides,
  };
}

/** A recognized verdict for one protected transition, for claim-level tests. */
export function recognizedVerdict(dispatch, packet, transition, options = {}) {
  const fixture = verifiedReturnFixture(dispatch.root, packet, options);
  const verdict = recognizeHandoff({
    transition,
    expectation: handoffExpectation(fixture, options.expectation ?? {}),
    verifiedReturn: fixture.record,
    validatePreparedDispatch: fixtureDispatchValidator(dispatch),
  });
  return { ...fixture, verdict };
}

/**
 * A recognized verdict for claim-level tests that do not exercise recognition.
 *
 * `lifecycle-claims` cases ask what a claim requires beside a correct receipt,
 * not whether a packet is authentic, so this builds a minimal record around a
 * self-consistently digested packet and injects a passing dispatch validator.
 * Never use it to assert recognition behaviour - `handoff-recognition.test.js`
 * covers that against real prepared packets and the real canonical validator.
 */
export function syntheticRecognizedVerdict(target, transition, options = {}) {
  const taskId = options.taskId ?? 'T-001';
  const repositoryIdentity = targetRepositoryIdentity(target);
  const taskDigest = `sha256:${'c'.repeat(64)}`;
  const contractDigest = `sha256:v1:${'d'.repeat(64)}`;
  const packet = {
    kind: 'agenticloop.role-preparation',
    backend: 'files',
    packetId: 'dispatch:00000000-0000-4000-8000-0000000000a1',
    task: {
      id: taskId,
      taskContractDigest: contractDigest,
      dispatchCarrierDigest: taskDigest,
      currentCarrierDigest: taskDigest,
      requiredCheckEvidenceContract: 2,
      requiredChecks: [{ id: 'RC-1', kind: 'command', command: 'npm test' }],
    },
    activation: null,
    activationBinding: { grant: { repositoryIdentity, digest: 'grant' }, binding: { digest: 'binding' } },
    returnAdapter: null,
    assignment: { roleId: 'engineer', invocationId: 'invocation:synthetic' },
    decomposition: null,
  };
  packet.digest = dispatchPreparationDigest(packet);
  const head = '1'.repeat(40);
  const baseHead = '2'.repeat(40);
  const roleReturn = createRoleReturn({
    returnId: HANDOFF_RETURN_ID,
    producerRole: 'engineer',
    packet: { packetId: packet.packetId, digest: packet.digest },
    task: {
      backend: 'files', id: taskId,
      taskContractDigest: contractDigest,
      dispatchCarrierDigest: taskDigest,
      currentCarrierDigest: taskDigest,
    },
    worktree: target,
    branch: 'task/T-001',
    productBaseHead: baseHead,
    productHead: head,
    workflowHead: head,
    candidateHead: null,
    productChangedPaths: ['src/example.js'],
    workflowChangedPaths: [],
    checks: [{
      id: 'RC-1', kind: 'command', command: 'npm test',
      outcome: 'passed', exitCode: 0, evidence: 'synthetic fixture pass',
      executionEvidence: { path: '.agenticloop/tmp/evidence.json', digest: `sha256:agenticloop.execution-evidence.v3:${'a'.repeat(64)}` },
    }],
    productAttribution: { range: { base: baseHead, head }, commits: [head] },
    carrierLineage: {
      dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'a'.repeat(64)}`,
      evidenceMutationReceiptDigests: [],
    },
    pr: { state: 'not_applicable', number: null, url: null },
    outcome: { kind: 'implementation_ready_for_review', completion: false, authority: 'non_authoritative_role_outcome' },
    disposition: 'proceed',
    blocker: null,
    freshness: { invalidatedBy: [
      'task_or_contract_changes', 'packet_or_assignment_changes', 'branch_or_head_changes',
      'check_or_transport_evidence_changes', 'initial_repository_state_changes',
    ] },
  });
  const record = createReturnVerification({
    target,
    packet,
    roleReturn,
    repositoryEvidence: {
      backend: 'files', worktree: target,
      task: {
        id: taskId, taskContractDigest: contractDigest,
        dispatchCarrierDigest: taskDigest, currentCarrierDigest: taskDigest,
      },
      branch: 'task/T-001',
      productBaseHead: baseHead, productHead: head, workflowHead: head, candidateHead: null,
      productChangedPaths: ['src/example.js'], workflowChangedPaths: [],
      checks: roleReturn.checks, productAttribution: roleReturn.productAttribution,
      carrierLineage: roleReturn.carrierLineage,
      pr: roleReturn.pr,
    },
    received: { ok: true, returnAssurance: 'session_reported' },
  });
  const verdict = recognizeHandoff({
    transition,
    expectation: {
      backend: 'files',
      taskId,
      roleId: 'engineer',
      taskContractDigest: contractDigest,
      packetId: packet.packetId,
      packetDigest: packet.digest,
      minimumReturnAssurance: 'session_reported',
    },
    verifiedReturn: record,
    validatePreparedDispatch: candidate => createPreparedDispatchValidation(candidate, { ok: true, errors: [] }),
  });
  return { packet, roleReturn, record, verdict };
}
